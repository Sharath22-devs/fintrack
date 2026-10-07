import { mapAsync, filterAsync, reduceAsync } from "../api/async-utils.mjs";
import baseTest from 'node:test';
import { databaseFixture } from './harness.mjs';
const live = [];
function test(name, fn) {
  return baseTest(name, async t => {
    try {
      await fn(t);
    } finally {
      for (const db of live.splice(0)) await db.close();
    }
  });
}
import assert from 'node:assert/strict';
import { Ledger, uid, today, now, cents, addDays, nextOccurrence } from '../api/ledger.mjs';
async function fixture() {
  const {
    db
  } = await databaseFixture();
  live.push(db);
  const l = new Ledger(db),
    u = uid(),
    other = uid();
  for (const id of [u, other]) await l.run('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)', id, id + '@test.com', 'Tester', 'x', now());
  const bank = await l.addAccount(u, {
      name: 'Bank',
      type: 'Bank',
      opening: 10000,
      date: addDays(today(), -180)
    }),
    cash = await l.addAccount(u, {
      name: 'Cash',
      type: 'Cash'
    }),
    savings = await l.addAccount(u, {
      name: 'Savings',
      type: 'Savings'
    }),
    person = await l.addPerson(u, {
      name: 'Umar'
    });
  return {
    l,
    u,
    other,
    bank,
    cash,
    savings,
    person
  };
}
const post = async (f, p) => await f.l.post(f.u, {
  date: today(),
  description: 'Test',
  ...p
});
test('Amounts use integer paise with strict validation', () => {
  assert.equal(cents('3839.99'), 383999);
  for (const n of [0, -1, '1.001', 'NaN', '1e3', Infinity, '']) assert.throws(() => cents(n));
});
test('Transfers preserve assets, income, expense and net position', async () => {
  const f = await fixture();
  await post(f, {
    type: 'Transfer',
    amount: 5000,
    account_id: f.bank,
    to_account_id: f.cash
  });
  const s = await f.l.snapshot(f.u);
  assert.equal(s.available, 1000000);
  assert.equal(s.income, 0);
  assert.equal(s.expense, 0);
  assert.equal(s.net, 1000000);
  assert.equal(await f.l.balance(f.u, f.cash), 500000);
});
test('Income and expense are recognized from journal books', async () => {
  const f = await fixture();
  await post(f, {
    type: 'Income',
    amount: '100.10',
    account_id: f.bank
  });
  await post(f, {
    type: 'Expense',
    amount: '25.25',
    account_id: f.cash
  });
  const s = await f.l.snapshot(f.u);
  assert.equal(s.available, 1007485);
  assert.equal(s.income, 10010);
  assert.equal(s.expense, 2525);
});
test('Lending reduces cash and creates asset, not an expense', async () => {
  const f = await fixture();
  await post(f, {
    type: 'Receivable',
    amount: 5000,
    account_id: f.bank,
    person_id: f.person,
    funded: true
  });
  const s = await f.l.snapshot(f.u);
  assert.equal(s.available, 500000);
  assert.equal(s.receivable, 500000);
  assert.equal(s.net, 1000000);
  assert.equal(s.expense, 0);
});
test('Borrowing creates cash and liability, not income', async () => {
  const f = await fixture();
  await post(f, {
    type: 'Loan',
    amount: 10000,
    account_id: f.bank,
    person_id: f.person
  });
  const s = await f.l.snapshot(f.u);
  assert.equal(s.available, 2000000);
  assert.equal(s.payable, 1000000);
  assert.equal(s.net, 1000000);
  assert.equal(s.income, 0);
});
test('Partial receipts retain original amount and immutable history', async () => {
  const f = await fixture(),
    tx = await post(f, {
      type: 'Receivable',
      amount: 5000,
      account_id: f.bank,
      person_id: f.person,
      funded: true
    }),
    o = await f.l.get('SELECT * FROM obligations WHERE origin_tx=?', tx);
  await post(f, {
    type: 'Received Payment',
    amount: 1000,
    account_id: f.bank,
    obligation_id: o.id
  });
  await post(f, {
    type: 'Received Payment',
    amount: 2000,
    account_id: f.cash,
    obligation_id: o.id
  });
  const s = await f.l.snapshot(f.u);
  assert.equal(s.receivable, 200000);
  assert.equal(s.available, 800000);
  assert.equal(s.net, 1000000);
  assert.equal(s.income, 0);
  assert.equal(s.obligations[0].original, 500000);
  assert.equal(s.obligations[0].settled.length, 2);
});
test('Partial repayments retain liability and do not count as expense', async () => {
  const f = await fixture(),
    tx = await post(f, {
      type: 'Loan',
      amount: 5000,
      account_id: f.bank,
      person_id: f.person
    }),
    o = await f.l.get('SELECT * FROM obligations WHERE origin_tx=?', tx);
  await post(f, {
    type: 'Paid Payment',
    amount: 2000,
    account_id: f.bank,
    obligation_id: o.id
  });
  const s = await f.l.snapshot(f.u);
  assert.equal(s.payable, 300000);
  assert.equal(s.available, 1300000);
  assert.equal(s.expense, 0);
  assert.equal(s.net, 1000000);
});
test('Over-settlement rejects atomically', async () => {
  const f = await fixture(),
    tx = await post(f, {
      type: 'Receivable',
      amount: 1000,
      person_id: f.person
    }),
    o = await f.l.get('SELECT * FROM obligations WHERE origin_tx=?', tx);
  await assert.rejects(async () => await post(f, {
    type: 'Received Payment',
    amount: 1001,
    account_id: f.bank,
    obligation_id: o.id
  }), /exceeds/);
  assert.equal(await f.l.remaining(f.u, o.id), 100000);
});
test('Settlement cannot precede original claim', async () => {
  const f = await fixture(),
    tx = await post(f, {
      type: 'Payable',
      amount: 1000,
      person_id: f.person
    }),
    o = await f.l.get('SELECT * FROM obligations WHERE origin_tx=?', tx);
  await assert.rejects(async () => await post(f, {
    type: 'Paid Payment',
    amount: 100,
    account_id: f.bank,
    obligation_id: o.id,
    date: addDays(today(), -1)
  }), /precede/);
});
test('Shared expenses separate personal cost from claims', async () => {
  const f = await fixture();
  await post(f, {
    type: 'Reimbursement',
    amount: 2000,
    account_id: f.bank,
    shares: [{
      person_id: f.person,
      amount: 1300
    }]
  });
  const s = await f.l.snapshot(f.u);
  assert.equal(s.expense, 70000);
  assert.equal(s.available, 800000);
  assert.equal(s.receivable, 130000);
  assert.equal(s.net, 930000);
});
test('Shared claims may not exceed payment', async () => {
  const f = await fixture();
  await assert.rejects(async () => await post(f, {
    type: 'Reimbursement',
    amount: 100,
    account_id: f.bank,
    shares: [{
      person_id: f.person,
      amount: 101
    }]
  }), /exceed/);
  assert.equal((await f.l.snapshot(f.u)).available, 1000000);
});
test('Credit cards are liabilities, not liquid assets', async () => {
  const f = await fixture(),
    card = await f.l.addAccount(f.u, {
      name: 'Card',
      type: 'Credit Card',
      opening: -500
    });
  await post(f, {
    type: 'Expense',
    amount: 100,
    account_id: card
  });
  let s = await f.l.snapshot(f.u);
  assert.equal(s.available, 1000000);
  assert.equal(s.cardLiability, 60000);
  assert.equal(s.net, 940000);
  await post(f, {
    type: 'Transfer',
    amount: 600,
    account_id: f.bank,
    to_account_id: card
  });
  s = await f.l.snapshot(f.u);
  assert.equal(s.cardLiability, 0);
  assert.equal(s.available, 940000);
  assert.equal(s.expense, 10000);
  assert.equal(s.net, 940000);
});
test('Reversal offsets financial totals without removing original', async () => {
  const f = await fixture(),
    tx = await post(f, {
      type: 'Expense',
      amount: 500,
      account_id: f.bank
    });
  await f.l.reverse(f.u, tx, 'Correction');
  assert.equal((await f.l.snapshot(f.u)).expense, 0);
  assert.equal((await f.l.snapshot(f.u)).available, 1000000);
  assert.equal((await f.l.transactions(f.u)).total, 3);
  await assert.rejects(async () => await f.l.reverse(f.u, tx, 'Again'), /Already/);
});
test('Settlement reversal restores outstanding amount', async () => {
  const f = await fixture(),
    origin = await post(f, {
      type: 'Receivable',
      amount: 500,
      person_id: f.person
    }),
    o = await f.l.get('SELECT * FROM obligations WHERE origin_tx=?', origin),
    tx = await post(f, {
      type: 'Received Payment',
      amount: 100,
      account_id: f.bank,
      obligation_id: o.id
    });
  await f.l.reverse(f.u, tx, 'Correction');
  assert.equal(await f.l.remaining(f.u, o.id), 50000);
  assert.equal((await f.l.snapshot(f.u)).obligations[0].settled.length, 0);
  assert.equal((await f.l.snapshot(f.u)).available, 1000000);
});
test('Obligations with settlement history cannot be casually reversed', async () => {
  const f = await fixture(),
    origin = await post(f, {
      type: 'Receivable',
      amount: 500,
      person_id: f.person
    }),
    o = await f.l.get('SELECT * FROM obligations WHERE origin_tx=?', origin);
  await post(f, {
    type: 'Received Payment',
    amount: 100,
    account_id: f.bank,
    obligation_id: o.id
  });
  await assert.rejects(async () => await f.l.reverse(f.u, origin, 'Bad'), /payment history/);
});
test('Cancellation retains payments and zeros only remaining claim', async () => {
  const f = await fixture(),
    origin = await post(f, {
      type: 'Receivable',
      amount: 500,
      person_id: f.person
    }),
    o = await f.l.get('SELECT * FROM obligations WHERE origin_tx=?', origin);
  await post(f, {
    type: 'Received Payment',
    amount: 100,
    account_id: f.bank,
    obligation_id: o.id
  });
  await f.l.cancel(f.u, o.id, 'Written off against equity');
  const out = (await f.l.snapshot(f.u)).obligations[0];
  assert.equal(out.original, 50000);
  assert.equal(out.remaining, 0);
  assert.equal(out.status, 'Cancelled');
  assert.equal(out.settled.length, 1);
});
test('Immutable journal and audit resist updates and deletion', async () => {
  const f = await fixture(),
    tx = await post(f, {
      type: 'Income',
      amount: 500,
      account_id: f.bank
    });
  for (const q of ['UPDATE transactions SET amount=1 WHERE id=?', 'DELETE FROM transactions WHERE id=?', 'UPDATE postings SET amount=0 WHERE transaction_id=?', 'DELETE FROM postings WHERE transaction_id=?']) await assert.rejects(async () => await f.l.run(q, tx), /immutable/);
  await assert.rejects(async () => await f.l.run('DELETE FROM audit'), /immutable/);
});
test('Closed periods reject actual postings and reversals', async () => {
  const f = await fixture(),
    date = addDays(today(), -60),
    tx = await post(f, {
      type: 'Expense',
      amount: 10,
      account_id: f.bank,
      date
    });
  await f.l.run('INSERT INTO closings VALUES(?,?,?,?)', uid(), f.u, date.slice(0, 7), now());
  await assert.rejects(async () => await post(f, {
    type: 'Income',
    amount: 20,
    account_id: f.bank,
    date
  }), /closed/);
  await assert.rejects(async () => await f.l.reverse(f.u, tx, 'Correction'), /closed/);
});
test('Foreign-user accounts, people, obligations and journals are denied', async () => {
  const f = await fixture(),
    their = await f.l.addAccount(f.other, {
      name: 'Other',
      opening: 500
    });
  await assert.rejects(async () => await post(f, {
    type: 'Income',
    amount: 500,
    account_id: their
  }), /not found/);
  await assert.rejects(async () => await f.l.post(f.other, {
    type: 'Receivable',
    amount: 100,
    person_id: f.person,
    description: 'No'
  }), /not found/);
  assert.equal((await f.l.snapshot(f.other)).available, 50000);
  assert.equal((await f.l.transactions(f.other)).rows.length, 1);
});
test('Idempotency keys stop repeated submissions', async () => {
  const f = await fixture(),
    p = {
      type: 'Expense',
      amount: 250,
      account_id: f.bank,
      idempotency_key: 'abc'
    },
    a = await post(f, p),
    b = await post(f, p);
  assert.equal(a, b);
  assert.equal((await f.l.snapshot(f.u)).expense, 25000);
});
test('Forecast includes dated claims and excludes transfers from recurring income/expense', async () => {
  const f = await fixture();
  await post(f, {
    type: 'Receivable',
    amount: 500,
    person_id: f.person,
    due_date: addDays(today(), 2)
  });
  await post(f, {
    type: 'Payable',
    amount: 200,
    person_id: f.person,
    due_date: addDays(today(), 3)
  });
  const out = await f.l.forecast(f.u, 7);
  assert.equal(out.current, 1000000);
  assert.equal(out.incoming, 50000);
  assert.equal(out.outgoing, 20000);
  assert.equal(out.projected, 1030000);
  assert.equal((await f.l.snapshot(f.u)).available, 1000000);
});
test('Historical position includes only entries posted by snapshot date', async () => {
  const f = await fixture();
  await post(f, {
    type: 'Income',
    amount: 1000,
    account_id: f.bank
  });
  const old = await f.l.snapshot(f.u, addDays(today(), -1));
  assert.equal(old.available, 1000000);
  assert.equal(old.income, 0);
});
test('Every transaction cross-foots to zero', async () => {
  const f = await fixture();
  for (const type of ['Income', 'Expense', 'Adjustment']) await post(f, {
    type,
    amount: 100,
    account_id: f.bank,
    notes: 'Reason'
  });
  assert.deepEqual(await f.l.all('SELECT transaction_id FROM postings GROUP BY transaction_id HAVING SUM(amount)!=0'), []);
});
test('Validation denies future and impossible dates and same-account transfers', async () => {
  const f = await fixture();
  for (const date of [addDays(today(), 1), '2026-02-30', 'bad']) await assert.rejects(async () => await post(f, {
    type: 'Income',
    amount: 1,
    account_id: f.bank,
    date
  }));
  await assert.rejects(async () => await post(f, {
    type: 'Transfer',
    amount: 1,
    account_id: f.bank,
    to_account_id: f.bank
  }), /different/);
});
test('Recurrences handle end-of-month and leap years', () => {
  assert.equal(nextOccurrence('2026-01-31', 'Monthly'), '2026-02-28');
  assert.equal(nextOccurrence('2024-02-29', 'Yearly'), '2025-02-28');
  assert.equal(nextOccurrence('2026-10-01', 'Custom', 3), '2026-10-04');
});
test('Mixed currency accounts cannot introduce misleading totals', async () => {
  const f = await fixture();
  await assert.rejects(async () => await f.l.addAccount(f.u, {
    name: 'USD',
    currency: 'USD'
  }), /Only INR/);
});

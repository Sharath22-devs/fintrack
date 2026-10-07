import { mapAsync, filterAsync, reduceAsync } from "./async-utils.mjs";
import { uid, today, addDays } from './ledger.mjs';
export async function seed(l, u) {
  for (const name of ['Food', 'Transport', 'Shopping', 'Bills', 'Education', 'Health', 'Entertainment', 'Travel', 'Rent', 'Family', 'Subscriptions', 'Other', 'Salary']) await l.run('INSERT INTO categories(id,user_id,name) VALUES(?,?,?)', uid(), u, name);
  const d = today(),
    day = Number(d.slice(-2));
  const cash = await l.addAccount(u, {
      name: 'Cash on hand',
      type: 'Cash',
      opening: 2000,
      date: addDays(d, -180)
    }),
    bank = await l.addAccount(u, {
      name: 'HDFC · Personal',
      type: 'Bank',
      opening: 25000,
      date: addDays(d, -180)
    }),
    wallet = await l.addAccount(u, {
      name: 'UPI wallet',
      type: 'Wallet',
      opening: 1000,
      date: addDays(d, -180)
    });
  const ids = {};
  for (const name of ['Umar', 'Rivas', 'Musthafa', 'Asan', 'Marriage / SM', 'Ameer', 'Faisal']) ids[name] = await l.addPerson(u, {
    name,
    notes: name === 'Marriage / SM' ? 'For SM' : ''
  });
  for (let i = 5; i >= 0; i--) {
    const x = new Date(d + 'T12:00Z');
    x.setUTCDate(1);
    x.setUTCMonth(x.getUTCMonth() - i);
    const month = x.toISOString().slice(0, 7);
    await l.post(u, {
      date: month + '-01',
      type: 'Income',
      amount: 18000 + i * 900,
      account_id: bank,
      category: 'Salary',
      description: 'Monthly salary',
      method: 'Bank'
    });
    const expense = [['Food', i ? 2600 + i * 270 : 1800], ['Transport', i ? 1300 + i * 120 : 480], ['Shopping', i ? 1200 + i * 230 : 950], ['Bills', i ? 1900 + i * 80 : 799], ['Entertainment', i ? 640 + i * 50 : 349]];
    await mapAsync(expense, async ([category, amount], j) => await l.post(u, {
      date: month + '-' + String(Math.min(i ? 5 + j : day, 3 + j)).padStart(2, '0'),
      type: 'Expense',
      amount,
      category,
      account_id: bank,
      description: {
        Food: 'Meals & groceries',
        Transport: 'Metro & commute',
        Shopping: 'Personal essentials',
        Bills: 'Internet bill',
        Entertainment: 'Streaming subscription'
      }[category],
      method: j % 2 ? 'UPI' : 'Bank',
      tags: 'personal'
    }));
  }
  const claims = [['Umar', 14000, -42], ['Rivas', 5000, 7], ['Musthafa', 10000, 12], ['Ameer', 18000, 20], ['Faisal', 13633, 25]];
  for (const [name, amount, days] of claims) {
    const tx = await l.post(u, {
      type: 'Receivable',
      amount,
      person_id: ids[name],
      date: addDays(d, -50),
      due_date: addDays(d, days),
      expected_date: addDays(d, Math.max(4, days)),
      description: name === 'Umar' ? 'Personal loan · opening claim' : 'Opening receivable · ' + name
    });
    if (name === 'Umar') {
      const o = await l.get('SELECT id FROM obligations WHERE origin_tx=?', tx);
      await l.post(u, {
        type: 'Received Payment',
        amount: 4000,
        account_id: bank,
        obligation_id: o.id,
        date: addDays(d, -10),
        description: 'Partial payment from Umar'
      });
    }
  }
  for (const [name, amount, days] of [['Marriage / SM', 15000, 14], ['Asan', 10000, 7]]) await l.post(u, {
    type: 'Payable',
    amount,
    person_id: ids[name],
    date: addDays(d, -15),
    due_date: addDays(d, days),
    description: name === 'Asan' ? 'Personal borrowing · opening liability' : 'Marriage contribution · For SM'
  });
  for (const [id, target] of [[cash, 1240], [bank, 2099], [wallet, 500]]) {
    const delta = target * 100 - (await l.balance(u, id));
    if (delta) await l.post(u, {
      type: 'Adjustment',
      amount: Math.abs(delta) / 100,
      account_id: id,
      direction: delta > 0 ? 'increase' : 'decrease',
      date: d,
      description: 'Demo balance alignment',
      notes: 'Explicit sample-data reconciliation. Not income or expense.'
    });
  }
  for (const [name, amount, category] of [['Food & groceries', 2500, 'Food'], ['Getting around', 1500, 'Transport'], ['Personal shopping', 3000, 'Shopping']]) await l.run('INSERT INTO budgets(id,user_id,name,amount,category) VALUES(?,?,?,?,?)', uid(), u, name, amount * 100, category);
  for (const [name, target] of [['New laptop', 60000], ['Emergency cushion', 25000]]) await l.run('INSERT INTO goals(id,user_id,name,target,target_date) VALUES(?,?,?,?,?)', uid(), u, name, target * 100, addDays(d, 180));
  for (const [name, amount, category, days, subscription, type] of [['Salary', 18000, 'Salary', 24, 0, 'Income'], ['Internet', 799, 'Bills', 15, 1, 'Expense'], ['Phone plan', 499, 'Bills', 9, 1, 'Expense'], ['Netflix', 649, 'Subscriptions', 18, 1, 'Expense']]) await l.run('INSERT INTO recurring(id,user_id,name,type,amount,account_id,category,frequency,next_date,is_subscription) VALUES(?,?,?,?,?,?,?,?,?,?)', uid(), u, name, type, amount * 100, bank, category, 'Monthly', addDays(d, days), subscription);
  await l.audit(u, 'Demo workspace seeded', u, {
    notice: 'All sample balances are calculated from journal entries.'
  });
}

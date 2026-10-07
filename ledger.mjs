import { mapAsync, filterAsync, reduceAsync } from "./async-utils.mjs";
import { randomUUID, createHash } from 'node:crypto';
export const uid = () => randomUUID();
export const today = () => new Date().toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata'
});
export const now = () => new Date().toISOString();
export function dateOK(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
}
export function fail(message, status = 400) {
  throw Object.assign(new Error(message), {
    status
  });
}
export function text(v, name, max = 500) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${name} is required (up to ${max} characters).`);
  return v.trim();
}
export function cents(v) {
  if (typeof v !== 'number' && typeof v !== 'string') fail('Enter a valid amount.');
  if (!/^\d+(\.\d{1,2})?$/.test(String(v))) fail('Amount must be positive with at most two decimal places.');
  const n = Math.round(Number(v) * 100);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 1e12) fail('Amount is out of range.');
  return n;
}
export class Ledger {
  constructor(database) {
    this.database = database;
  }
  async all(q, ...p) {
    return await this.database.all(q, p);
  }
  async get(q, ...p) {
    return await this.database.get(q, p);
  }
  async run(q, ...p) {
    return await this.database.run(q, p);
  }
  async columns(table) {
    return await this.database.columns(table);
  }
  async atomic(fn) {
    return await this.database.atomic(fn);
  }
  async own(table, id, u) {
    if (!['accounts', 'people', 'obligations', 'goals', 'transactions', 'recurring', 'budgets'].includes(table)) fail('Invalid entity.');
    const row = await this.get(`SELECT * FROM ${table} WHERE id=? AND user_id=?`, id, u);
    if (!row) fail('Record not found.', 404);
    return row;
  }
  async audit(u, action, id, detail) {
    const prev = (await this.get('SELECT hash FROM audit WHERE user_id=? ORDER BY id DESC LIMIT 1', u))?.hash || 'GENESIS';
    const at = now(),
      d = JSON.stringify(detail),
      h = createHash('sha256').update(JSON.stringify([u, action, id, d, at, prev])).digest('hex');
    await this.run('INSERT INTO audit(user_id,action,entity_id,detail,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?)', u, action, id, d, at, prev, h);
  }
  async assertOpen(u, d) {
    if (await this.get('SELECT id FROM closings WHERE user_id=? AND month=?', u, d.slice(0, 7))) fail('This month is closed. Reopen it before posting.');
  }
  async account(u, id) {
    const a = await this.own('accounts', id, u);
    if (a.archived) fail('Account is archived.');
    if (a.currency !== 'INR') fail('Multi-currency posting needs an FX policy. This release supports INR.');
    return a;
  }
  async addPerson(u, p) {
    const id = uid();
    await this.run('INSERT INTO people VALUES(?,?,?,?,?,?)', id, u, text(p.name, 'Name', 100), p.email || '', p.phone || '', p.notes || '');
    await this.audit(u, 'Person created', id, {
      name: p.name
    });
    return id;
  }
  async addAccount(u, p) {
    return await this.atomic(async () => {
      const id = uid();
      const type = p.type || 'Bank';
      if (!['Cash', 'Bank', 'Savings', 'UPI', 'Credit Card', 'Wallet', 'Custom'].includes(type)) fail('Invalid account type.');
      if (p.currency && p.currency !== 'INR') fail('Only INR accounts are supported; balances are never summed across currencies.');
      await this.run('INSERT INTO accounts(id,user_id,name,type,currency,created_at) VALUES(?,?,?,?,?,?)', id, u, text(p.name, 'Account name', 100), type, 'INR', now());
      const n = Number(p.opening || 0);
      if (n !== 0) {
        if (!Number.isFinite(n)) fail('Invalid opening balance.');
        const amount = cents(Math.abs(n));
        const d = p.date || today();
        if (!dateOK(d) || d > today()) fail('Invalid opening date.');
        await this.assertOpen(u, d);
        await this.insert(u, {
          date: d,
          type: 'Opening',
          amount,
          description: 'Opening balance',
          account_id: id
        }, [{
          account_id: id,
          book: type === 'Credit Card' ? 'liability' : 'asset',
          amount: Math.sign(n) * amount
        }, {
          book: 'equity',
          amount: -Math.sign(n) * amount
        }]);
      }
      await this.audit(u, 'Account created', id, {
        name: p.name
      });
      return id;
    });
  }
  async insert(u, p, legs) {
    const id = uid();
    if (legs.reduce((s, l) => s + l.amount, 0) !== 0) fail('Unbalanced journal.');
    await this.run(`INSERT INTO transactions(id,user_id,date,time,type,amount,category,subcategory,description,notes,method,person_id,tags,recurring_id,obligation_id,reversal_of,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, u, p.date, p.time || '12:00', p.type, p.amount, p.category || 'Other', p.subcategory || '', p.description, p.notes || '', p.method || 'Bank', p.person_id || null, p.tags || '', p.recurring_id || null, p.obligation_id || null, p.reversal_of || null, p.idempotency_key || null, now());
    for (const l of legs) await this.run('INSERT INTO postings(transaction_id,user_id,account_id,book,amount,person_id) VALUES(?,?,?,?,?,?)', id, u, l.account_id || null, l.book, l.amount, l.person_id || p.person_id || null);
    await this.audit(u, 'Transaction posted', id, {
      type: p.type,
      amount: p.amount,
      date: p.date,
      description: p.description
    });
    return id;
  }
  async balance(u, id, date = today()) {
    return (await this.get('SELECT COALESCE(SUM(p.amount),0) AS n FROM postings p JOIN transactions t ON t.id=p.transaction_id WHERE p.user_id=? AND p.account_id=? AND t.date<=?', u, id, date)).n;
  }
  async remaining(u, id, asOf = today()) {
    const o = await this.own('obligations', id, u);
    const origin = await this.own('transactions', o.origin_tx, u);
    if (origin.date > asOf) return 0;
    const cancelled = o.cancel_tx && (await this.own('transactions', o.cancel_tx, u)).date <= asOf;
    if (cancelled) return 0;
    const n = (await this.get(`SELECT COALESCE(SUM(s.amount),0) n FROM settlements s JOIN transactions t ON t.id=s.transaction_id WHERE s.user_id=? AND s.obligation_id=? AND t.date<=? AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.reversal_of=t.id AND r.date<=?)`, u, id, asOf, asOf)).n;
    return o.original - n;
  }
  async post(u, input) {
    return await this.atomic(async () => await this._post(u, input));
  }
  async _post(u, input) {
    const p = {
      ...input,
      amount: cents(input.amount)
    };
    p.date = p.date || today();
    if (!dateOK(p.date) || p.date > today()) fail('Use an actual date up to today. Schedule future entries in Recurring or commitments.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time || '12:00')) fail('Invalid time.');
    await this.assertOpen(u, p.date);
    p.description = text(p.description, 'Description');
    for (const [k, max] of [['notes', 5000], ['tags', 1000], ['category', 100], ['subcategory', 100], ['method', 50]]) if (p[k] !== undefined && (typeof p[k] !== 'string' || p[k].length > max)) fail('Invalid ' + k + '.');
    if (p.idempotency_key) {
      const old = await this.get('SELECT id FROM transactions WHERE user_id=? AND idempotency_key=?', u, p.idempotency_key);
      if (old) return old.id;
    }
    if (p.person_id) await this.own('people', p.person_id, u);
    const allowed = ['Income', 'Expense', 'Transfer', 'Receivable', 'Payable', 'Received Payment', 'Paid Payment', 'Loan', 'Loan Repayment', 'Reimbursement', 'Adjustment'];
    if (!allowed.includes(p.type)) fail('Unknown transaction type.');
    const legs = [];
    const leg = (book, amount, account_id) => legs.push({
      book,
      amount,
      account_id
    });
    const acct = async id => {
      const a = await this.account(u, id);
      return a.type === 'Credit Card' ? 'liability' : 'asset';
    };
    const money = async (id, n) => leg(await acct(id), n, id);
    const n = p.amount;
    if (p.type === 'Income') {
      await money(p.account_id, n);
      leg('income', -n);
    }
    if (p.type === 'Expense') {
      await money(p.account_id, -n);
      leg('expense', n);
    }
    if (p.type === 'Transfer') {
      if (p.account_id === p.to_account_id) fail('Choose two different accounts.');
      await money(p.account_id, -n);
      await money(p.to_account_id, n);
    }
    if (p.type === 'Adjustment') {
      const sign = p.direction === 'decrease' ? -1 : 1;
      await money(p.account_id, sign * n);
      leg('equity', -sign * n);
      if (!p.notes) fail('Provide a reason for the adjustment.');
    }
    if (['Received Payment', 'Paid Payment', 'Loan Repayment'].includes(p.type)) {
      const o = await this.own('obligations', p.obligation_id, u);
      const rec = o.kind === 'receivable';
      if (p.type === 'Received Payment' && !rec || p.type === 'Paid Payment' && rec) fail('Settlement type does not match the obligation.');
      if (p.date < o.created_date) fail('Settlement cannot precede the original record.');
      if (n > (await this.remaining(u, o.id, p.date)) || n > (await this.remaining(u, o.id))) fail('Payment exceeds the outstanding amount.');
      p.person_id = o.person_id;
      await money(p.account_id, rec ? n : -n);
      leg(o.kind, rec ? -n : n);
      const id = await this.insert(u, p, legs);
      await this.run('INSERT INTO settlements VALUES(?,?,?,?,?)', uid(), u, o.id, id, n);
      return id;
    }
    if (['Receivable', 'Payable', 'Loan'].includes(p.type)) {
      if (!p.person_id) fail('Choose a person.');
      const kind = p.type === 'Receivable' ? 'receivable' : 'payable';
      if (p.due_date && !dateOK(p.due_date)) fail('Invalid due date.');
      if (p.expected_date && !dateOK(p.expected_date)) fail('Invalid expected date.');
      const funded = p.type === 'Loan' || p.funded === true;
      if (funded) {
        await money(p.account_id, kind === 'receivable' ? -n : n);
        leg(kind, kind === 'receivable' ? n : -n);
      } else {
        leg(kind, kind === 'receivable' ? n : -n);
        leg(p.recognize_expense && kind === 'payable' ? 'expense' : 'equity', kind === 'receivable' ? -n : n);
      }
      const oid = uid();
      p.obligation_id = oid;
      const id = await this.insert(u, p, legs);
      await this.run('INSERT INTO obligations(id,user_id,kind,person_id,original,reason,due_date,expected_date,created_date,origin_tx,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)', oid, u, kind, p.person_id, n, p.description, p.due_date || null, p.expected_date || null, p.date, id, p.notes || '');
      return id;
    }
    if (p.type === 'Reimbursement') {
      await money(p.account_id, -n);
      const shares = p.shares || [];
      if (!Array.isArray(shares) || !shares.length) fail('Add at least one reimbursement participant.');
      const parts = await mapAsync(shares, async s => {
        await this.own('people', s.person_id, u);
        return {
          ...s,
          amount: cents(s.amount)
        };
      });
      const total = parts.reduce((s, x) => s + x.amount, 0);
      if (total > n) fail('Shared claims exceed the total paid.');
      leg('expense', n - total);
      for (const s of parts) legs.push({
        book: 'receivable',
        amount: s.amount,
        person_id: s.person_id
      });
      const id = await this.insert(u, p, legs);
      for (const s of parts) await this.run('INSERT INTO obligations(id,user_id,kind,person_id,original,reason,due_date,created_date,origin_tx) VALUES(?,?,?,?,?,?,?,?,?)', uid(), u, 'receivable', s.person_id, s.amount, p.description, p.due_date || null, p.date, id);
      return id;
    }
    return await this.insert(u, p, legs);
  }
  async reverse(u, id, reason, date = today()) {
    return await this.atomic(async () => {
      const t = await this.own('transactions', id, u);
      if (['Opening', 'Reversal', 'Cancellation'].includes(t.type) || t.reversal_of) fail('This journal cannot be reversed here.');
      if (await this.get('SELECT id FROM transactions WHERE reversal_of=?', id)) fail('Already reversed.');
      if (!dateOK(date) || date > today() || date < t.date) fail('Invalid reversal date.');
      await this.assertOpen(u, t.date);
      await this.assertOpen(u, date);
      const obs = await this.all('SELECT * FROM obligations WHERE origin_tx=? AND user_id=?', id, u);
      if ((await mapAsync(obs, async o => o.cancel_tx || (await this.get('SELECT id FROM settlements WHERE obligation_id=?', o.id)))).some(Boolean)) fail('An obligation with payment history must be settled or cancelled, not reversed.');
      const legs = (await this.all('SELECT * FROM postings WHERE transaction_id=?', id)).map(x => ({
        ...x,
        amount: -x.amount
      }));
      const rid = await this.insert(u, {
        ...t,
        date,
        type: 'Reversal',
        idempotency_key: null,
        reversal_of: id,
        description: `Reversal: ${t.description}`,
        notes: text(reason, 'Reason'),
        recurring_id: null
      }, legs);
      for (const o of obs) await this.run('UPDATE obligations SET cancel_tx=? WHERE id=?', rid, o.id);
      await this.audit(u, 'Transaction reversed', id, {
        reversal_id: rid,
        reason
      });
      return rid;
    });
  }
  async cancel(u, id, reason) {
    return await this.atomic(async () => {
      const o = await this.own('obligations', id, u),
        n = await this.remaining(u, id);
      if (n <= 0) fail('Nothing remains to cancel.');
      const d = today();
      await this.assertOpen(u, d);
      const sign = o.kind === 'receivable' ? -1 : 1;
      const tx = await this.insert(u, {
        date: d,
        type: 'Cancellation',
        amount: n,
        description: `Cancelled: ${o.reason}`,
        notes: text(reason, 'Reason'),
        person_id: o.person_id,
        obligation_id: id
      }, [{
        book: o.kind,
        amount: sign * n
      }, {
        book: 'equity',
        amount: -sign * n
      }]);
      await this.run('UPDATE obligations SET cancel_tx=? WHERE id=?', tx, id);
      await this.audit(u, 'Obligation cancelled', id, {
        reason
      });
      return tx;
    });
  }
  async obligations(u, asOf = today()) {
    const claims=await this.all(`SELECT o.*,p.name person_name,t.date origin_date,c.date cancel_date FROM obligations o JOIN people p ON p.id=o.person_id JOIN transactions t ON t.id=o.origin_tx LEFT JOIN transactions c ON c.id=o.cancel_tx WHERE o.user_id=? AND o.created_date<=? AND t.date<=? ORDER BY o.due_date IS NULL,o.due_date`,u,asOf,asOf);
    const payments=await this.all(`SELECT s.*,t.date,t.description,a.name account_name FROM settlements s JOIN transactions t ON t.id=s.transaction_id LEFT JOIN postings j ON j.transaction_id=t.id AND j.account_id IS NOT NULL LEFT JOIN accounts a ON a.id=j.account_id WHERE s.user_id=? AND t.date<=? AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id AND r.date<=?) ORDER BY t.date`,u,asOf,asOf);
    const grouped=new Map();for(const payment of payments){if(!grouped.has(payment.obligation_id))grouped.set(payment.obligation_id,[]);grouped.get(payment.obligation_id).push(payment);}
    return claims.map(o=>{const settled=grouped.get(o.id)||[],cancelled=!!(o.cancel_date&&o.cancel_date<=asOf),remaining=cancelled?0:o.original-settled.reduce((n,p)=>n+p.amount,0),overdue=o.due_date?Math.max(0,Math.floor((Date.parse(asOf)-Date.parse(o.due_date))/86400000)):0;return {...o,remaining,settled,status:cancelled?'Cancelled':remaining===0?(o.kind==='receivable'?'Received':'Paid'):overdue?'Overdue':remaining<o.original?(o.kind==='receivable'?'Partially Received':'Partially Paid'):'Pending',overdue_days:overdue,age_bucket:overdue<=7?'0–7 days':overdue<=30?'8–30 days':overdue<=60?'31–60 days':'60+ days'};});
  }
  async transactions(u, filter = {}) {
    const where = ['t.user_id=?'],
      args = [u];
    for (const [key, col] of [['type', 't.type'], ['category', 't.category'], ['person_id', 't.person_id'], ['method', 't.method'], ['subcategory', 't.subcategory']]) if (filter[key]) {
      where.push(`${col}=?`);
      args.push(filter[key]);
    }
    if (filter.from) {
      where.push('t.date>=?');
      args.push(filter.from);
    }
    if (filter.to) {
      where.push('t.date<=?');
      args.push(filter.to);
    }
    if (filter.min) {
      where.push('t.amount>=?');
      args.push(cents(filter.min));
    }
    if (filter.max) {
      where.push('t.amount<=?');
      args.push(cents(filter.max));
    }
    if (filter.q) {
      where.push('(t.description LIKE ? OR t.notes LIKE ? OR t.tags LIKE ?)');
      args.push(...Array(3).fill(`%${filter.q}%`));
    }
    if (filter.tags) {
      where.push('t.tags LIKE ?');
      args.push(`%${filter.tags}%`);
    }
    if (filter.account_id) {
      where.push('EXISTS(SELECT 1 FROM postings a WHERE a.transaction_id=t.id AND a.account_id=?)');
      args.push(filter.account_id);
    }
    if (filter.recurring === 'true') where.push('t.recurring_id IS NOT NULL');
    if (filter.status === 'Reversed') where.push('EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id)');
    if (filter.status === 'Posted') where.push('NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id)');
    const w = where.join(' AND '),
      total = (await this.get(`SELECT COUNT(*) n FROM transactions t WHERE ${w}`, ...args)).n;
    const limit = Math.min(500, Math.max(1, Number(filter.limit) || 25)),
      page = Math.max(1, Number(filter.page) || 1);
    const baseRows = await this.all(`SELECT t.*,p.name person_name,EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id) reversed FROM transactions t LEFT JOIN people p ON p.id=t.person_id WHERE ${w} ORDER BY t.date DESC,t.time DESC,t.created_at DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    const ids=baseRows.map(t=>t.id);const journal=ids.length?await this.all('SELECT j.*,a.name account_name FROM postings j LEFT JOIN accounts a ON a.id=j.account_id WHERE j.user_id=? AND j.transaction_id=ANY(?::text[]) ORDER BY j.id',u,ids):[];
    const files=ids.length?await this.all('SELECT id,name,mime,transaction_id FROM attachments WHERE user_id=? AND transaction_id=ANY(?::text[])',u,ids):[];
    const rowPostings=new Map(),rowFiles=new Map();for(const p of journal){if(!rowPostings.has(p.transaction_id))rowPostings.set(p.transaction_id,[]);rowPostings.get(p.transaction_id).push(p);}for(const f of files){if(!rowFiles.has(f.transaction_id))rowFiles.set(f.transaction_id,[]);rowFiles.get(f.transaction_id).push(f);}
    const rows=baseRows.map(t=>({...t,postings:rowPostings.get(t.id)||[],attachments:rowFiles.get(t.id)||[]}));
    return {
      rows,
      total,
      page,
      limit
    };
  }
  async periodTotals(u, from, to) {
    return await this.get(`SELECT COALESCE(SUM(CASE WHEN p.book='income' THEN -p.amount ELSE 0 END),0) income, COALESCE(SUM(CASE WHEN p.book='expense' THEN p.amount ELSE 0 END),0) expense, COALESCE(SUM(CASE WHEN p.book='asset' THEN p.amount ELSE 0 END),0) cash_flow FROM postings p JOIN transactions t ON t.id=p.transaction_id WHERE p.user_id=? AND t.date BETWEEN ? AND ?`, u, from, to);
  }
  async snapshot(u, asOf = today()) {
    if (!dateOK(asOf)) fail('Invalid snapshot date.');
    const month = asOf.slice(0, 7),
      from = month + '-01';
    const accounts = await mapAsync(await this.all('SELECT * FROM accounts WHERE user_id=? ORDER BY created_at', u), async a => ({
      ...a,
      balance: await this.balance(u, a.id, asOf),
      reconciliation: (await this.get('SELECT * FROM reconciliations WHERE user_id=? AND account_id=? ORDER BY created_at DESC LIMIT 1', u, a.id)) || null,
      totals: await this.get(`SELECT COALESCE(SUM(CASE WHEN j.book='income' THEN -j.amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN j.book='expense' THEN j.amount ELSE 0 END),0) expense,(SELECT COALESCE(SUM(p.amount),0) FROM postings p JOIN transactions x ON x.id=p.transaction_id WHERE p.account_id=? AND x.type='Opening' AND x.date<=?) opening,(SELECT COALESCE(SUM(p.amount),0) FROM postings p JOIN transactions x ON x.id=p.transaction_id WHERE p.account_id=? AND (x.type='Transfer' OR x.type='Reversal' AND EXISTS(SELECT 1 FROM transactions r WHERE r.id=x.reversal_of AND r.type='Transfer')) AND x.date<=?) transfers FROM postings j JOIN transactions t ON t.id=j.transaction_id WHERE j.user_id=? AND t.date<=? AND EXISTS(SELECT 1 FROM postings p WHERE p.transaction_id=t.id AND p.account_id=?)`, a.id, asOf, a.id, asOf, u, asOf, a.id)
    }));
    const available = accounts.filter(a => a.type !== 'Credit Card').reduce((s, a) => s + a.balance, 0),
      cardLiability = 0 - accounts.filter(a => a.type === 'Credit Card').reduce((s, a) => s + a.balance, 0);
    const obligations = await this.obligations(u, asOf),
      receivable = obligations.filter(o => o.kind === 'receivable').reduce((s, o) => s + o.remaining, 0),
      payable = obligations.filter(o => o.kind === 'payable').reduce((s, o) => s + o.remaining, 0);
    const totals = await this.periodTotals(u, from, asOf);
    const categories = await this.all(`SELECT t.category label,SUM(j.amount) amount FROM postings j JOIN transactions t ON t.id=j.transaction_id WHERE j.user_id=? AND j.book='expense' AND t.date BETWEEN ? AND ? GROUP BY t.category HAVING SUM(j.amount)>0 ORDER BY amount DESC`, u, from, asOf);
    const trends = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(asOf + 'T12:00:00Z');
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - i);
      const f = d.toISOString().slice(0, 7) + '-01';
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const t = await this.periodTotals(u, f, end < asOf ? end : asOf);
      const position=await this.get(`SELECT COALESCE(SUM(CASE WHEN p.book='asset' THEN p.amount ELSE 0 END),0) balance,COALESCE(SUM(CASE WHEN p.book IN ('asset','receivable','payable','liability') THEN p.amount ELSE 0 END),0) net FROM postings p JOIN transactions t ON t.id=p.transaction_id WHERE p.user_id=? AND t.date<=?`,u,end<asOf?end:asOf);
      trends.push({
        date: f,
        label: d.toLocaleDateString('en', {
          month: 'short',
          timeZone: 'UTC'
        }),
        ...t,
        balance: position.balance,
        net: position.net
      });
    }
    const budgets = await mapAsync(await this.all('SELECT * FROM budgets WHERE user_id=?', u), async b => {
      const d = new Date(asOf + 'T12:00Z');
      d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
      const start = b.period === 'weekly' ? d.toISOString().slice(0, 10) : from;
      let q = `SELECT COALESCE(SUM(j.amount),0) n FROM postings j JOIN transactions t ON t.id=j.transaction_id WHERE j.user_id=? AND j.book='expense' AND t.date BETWEEN ? AND ?`,
        args = [u, start, asOf];
      if (b.category) {
        q += ' AND t.category=?';
        args.push(b.category);
      }
      if (b.account_id) {
        q += ' AND EXISTS(SELECT 1 FROM postings x WHERE x.transaction_id=t.id AND x.account_id=?)';
        args.push(b.account_id);
      }
      const used = (await this.get(q, ...args)).n;
      return {
        ...b,
        used,
        remaining: b.amount - used,
        percent: Math.round(100 * used / b.amount)
      };
    });
    const goals = await mapAsync(await this.all('SELECT * FROM goals WHERE user_id=?', u), async g => {
      const saved = (await this.get(`SELECT COALESCE(SUM(c.amount),0) n FROM contributions c JOIN transactions t ON t.id=c.transaction_id WHERE c.user_id=? AND c.goal_id=? AND c.date<=? AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id AND r.date<=?)`, u, g.id, asOf, asOf)).n;
      const recent = (await this.get('SELECT COALESCE(SUM(c.amount),0) n FROM contributions c JOIN transactions t ON t.id=c.transaction_id WHERE c.user_id=? AND c.goal_id=? AND c.date>=date(?,\'-90 days\') AND c.date<=? AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id)', u, g.id, asOf, asOf)).n;
      let estimate = null;
      if (recent > 0) {
        const d = new Date(asOf + 'T12:00Z');
        d.setUTCDate(d.getUTCDate() + Math.ceil(Math.max(0, g.target - saved) / (recent / 90)));
        estimate = d.toISOString().slice(0, 10);
      }
      return {
        ...g,
        saved,
        percent: Math.round(100 * saved / g.target),
        estimated_completion: estimate
      };
    });
    const recurring = await this.all('SELECT r.*,a.name account_name FROM recurring r JOIN accounts a ON a.id=r.account_id WHERE r.user_id=?', u);
    const commitments = obligations.filter(o => o.remaining > 0 && o.due_date && o.due_date <= addDays(asOf, 30) && o.kind === 'payable').reduce((s, o) => s + o.remaining, 0);
    const rate = totals.income > 0 ? (totals.income - totals.expense) / totals.income : null;
    const recurringMonthly = recurring.filter(r => r.active && r.type === 'Expense').reduce((s, r) => s + monthlyEquivalent(r), 0);
    const components = [{
      label: 'Savings rate',
      score: rate === null ? 0 : Math.round(Math.min(1, Math.max(0, rate) / .3) * 25),
      max: 25,
      reason: rate === null ? 'No income recorded this month' : `${Math.round(rate * 100)}% retained this month`
    }, {
      label: 'Cash buffer',
      score: Math.round(Math.min(1, Math.max(0, available) / (Math.max(1, totals.expense) * 3)) * 25),
      max: 25,
      reason: 'Available cash compared with three months of current spending'
    }, {
      label: 'Debt coverage',
      score: Math.round(Math.min(1, Math.max(0, available) / Math.max(1, payable + cardLiability)) * 20),
      max: 20,
      reason: `Cash coverage of outstanding liabilities`
    }, {
      label: 'Upcoming commitments',
      score: available >= commitments ? 20 : Math.round(Math.max(0, available) / Math.max(1, commitments) * 20),
      max: 20,
      reason: 'Cash compared with payments due within 30 days'
    }, {
      label: 'Recurring burden',
      score: totals.income > 0 ? Math.round(Math.max(0, 1 - recurringMonthly / totals.income) * 10) : 0,
      max: 10,
      reason: 'Monthly recurring expenses compared with income'
    }];
    const health = components.reduce((s, c) => s + c.score, 0);
    const insights = [];
    if (commitments > available) insights.push({
      tone: 'warning',
      title: 'A cash gap is ahead',
      text: `Payments due within 30 days exceed available funds by ${moneyText(commitments - available)}.`
    });
    const overdue = obligations.filter(o => o.remaining > 0 && o.overdue_days > 0);
    if (overdue.length) insights.push({
      tone: 'warning',
      title: 'Follow up on overdue balances',
      text: `${overdue.length} obligations are past their due dates.`
    });
    const previous = trends[4];
    if (previous.expense > 0 && totals.expense > previous.expense) insights.push({
      tone: 'neutral',
      title: 'Spending is above last month',
      text: `Month-to-date expenses are ${Math.round((totals.expense / previous.expense - 1) * 100)}% above the previous full month. Different coverage periods.`
    });
    if (receivable > available) insights.push({
      tone: 'neutral',
      title: 'Your wealth is not all liquid',
      text: `${moneyText(receivable)} is outstanding in receivables. It is not spendable cash.`
    });
    if (!insights.length) insights.push({
      tone: 'positive',
      title: 'Your ledger is up to date',
      text: 'Add dated commitments for a more complete cash-flow forecast.'
    });
    return {
      asOf,
      accounts,
      available,
      receivable,
      payable,
      cardLiability,
      net: available + receivable - payable - cardLiability,
      ...totals,
      today_spending: (await this.periodTotals(u, asOf, asOf)).expense,
      savings_rate: rate,
      budgets,
      goals,
      obligations,
      recurring,
      trends,
      categories,
      health,
      health_components: components,
      insights,
      people: await this.all('SELECT * FROM people WHERE user_id=? ORDER BY name', u),
      category_options: await this.all('SELECT * FROM categories WHERE user_id=? ORDER BY name', u),
      recent: (await this.transactions(u, {
        to: asOf,
        limit: 6
      })).rows,
      closings: await this.all('SELECT * FROM closings WHERE user_id=? ORDER BY month DESC', u)
    };
  }
  async forecast(u, days = 30) {
    days = Math.max(1, Math.min(730, Number(days) || 30));
    const asOf=today();const liquid=await this.get("SELECT COALESCE(SUM(p.amount),0) n FROM postings p JOIN transactions t ON t.id=p.transaction_id JOIN accounts a ON a.id=p.account_id WHERE p.user_id=? AND a.type<>'Credit Card' AND t.date<=?",u,asOf);const s={available:liquid.n,obligations:await this.obligations(u,asOf),recurring:await this.all('SELECT * FROM recurring WHERE user_id=? AND active=1',u)},
      start = today(),
      end = addDays(start, days),
      events = [];
    for (const o of s.obligations) if (o.remaining > 0) {
      const d = o.kind === 'receivable' ? o.expected_date || o.due_date : o.due_date;
      if (d && d <= end) events.push({
        date: d < start ? start : d,
        original_date: d,
        label: o.person_name + ' · ' + o.reason,
        amount: o.kind === 'receivable' ? o.remaining : -o.remaining,
        type: o.kind,
        id: o.id
      });
    }
    for (const r of s.recurring.filter(r => r.active)) {
      let d = r.next_date;
      let n = 0;
      while (d <= end && (!r.end_date || d <= r.end_date) && n++ < 800) {
        events.push({
          date: d < start ? start : d,
          original_date: d,
          label: r.name,
          amount: r.type === 'Income' ? r.amount : -r.amount,
          type: r.type,
          id: r.id
        });
        d = nextOccurrence(d, r.frequency, r.custom_days);
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    let balance = s.available;
    const points = [{
      date: start,
      balance,
      label: 'Current balance'
    }];
    for (const e of events) {
      balance += e.amount;
      points.push({
        ...e,
        balance
      });
    }
    points.push({
      date: end,
      balance,
      label: 'End of forecast'
    });
    return {
      start,
      end,
      current: s.available,
      projected: balance,
      incoming: events.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0),
      outgoing: -events.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0),
      events,
      points,
      low: points.find(p => p.balance < 200000) || null,
      assumptions: 'Includes outstanding dated obligations and active recurring templates; overdue commitments are assumed today. Receipts are uncertain. Credit-card liabilities without a scheduled payable are excluded; do not duplicate them as payables.'
    };
  }
}
export const moneyText = n => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2
}).format(n / 100);
export function addDays(d, n) {
  const x = new Date(d + 'T12:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
export function nextOccurrence(d, f, custom = 30) {
  const days = {
    Daily: 1,
    Weekly: 7,
    Biweekly: 14,
    Custom: custom
  };
  if (days[f]) return addDays(d, days[f]);
  const m = {
    Monthly: 1,
    Quarterly: 3,
    Yearly: 12
  }[f];
  if (!m) fail('Invalid recurrence frequency.');
  const x = new Date(d + 'T12:00Z'),
    day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + m);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x.toISOString().slice(0, 10);
}
export function monthlyEquivalent(r) {
  const factors = {
    Daily: 30.4375,
    Weekly: 52 / 12,
    Biweekly: 26 / 12,
    Monthly: 1,
    Quarterly: 1 / 3,
    Yearly: 1 / 12,
    Custom: 30.4375 / r.custom_days
  };
  return Math.round(r.amount * (factors[r.frequency] || 1));
}

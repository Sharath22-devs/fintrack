import {AsyncLocalStorage} from 'node:async_hooks';
const currentRequest=new AsyncLocalStorage();
const ledgerForRequest=()=>currentRequest.getStore().ledger;
import { mapAsync, filterAsync, reduceAsync } from "./async-utils.mjs";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { Ledger, uid, today, now, cents, text, fail, dateOK, nextOccurrence, monthlyEquivalent, moneyText } from './ledger.mjs';
import { seed } from './seed.mjs';
import { getDatabase } from './database.mjs';
import { importFile, excelReport, pdfReport } from './exchange.mjs';
const ledger = new Proxy({}, {get(_target,key){const value=ledgerForRequest()[key];return typeof value==='function'?value.bind(ledgerForRequest()):value;}});
const originForRequest = ()=>currentRequest.getStore()?.origin||process.env.APP_ORIGIN||'';
const prod = process.env.NODE_ENV !== 'development';
const port = Number(process.env.PORT) || 3000;
const hashToken = t => createHash('sha256').update(t).digest('hex');
const passwordHash = p => {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(p, salt, 64).toString('hex');
};
const passwordOK = (p, h) => {
  const [s, v] = h.split(':');
  const a = scryptSync(p, s, 64),
    b = Buffer.from(v, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
function validPassword(p) {
  if (typeof p !== 'string' || p.length < 12 || p.length > 256) fail('Use a password between 12 and 256 characters.');
  return p;
}
async function body(req) {
  return req.parsedBody;
}
function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(data));
}
async function session(req, res, u) {
  const token = randomBytes(32).toString('hex'),
    csrf = randomBytes(24).toString('hex');
  await ledger.run('INSERT INTO sessions VALUES(?,?,?,?)', hashToken(token), u, csrf, new Date(Date.now() + 86400000 * 7).toISOString());
  res.setHeader('Set-Cookie', `fintrack_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${prod ? '; Secure' : ''}`);
  return csrf;
}
async function authenticate(req) {
  const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('fintrack_session='))?.slice(17);
  const s = token && (await ledger.get('SELECT * FROM sessions WHERE token=? AND expires_at>?', hashToken(token), now()));
  if (!s) fail('Please sign in.', 401);
  const u = await ledger.get('SELECT id,email,name,preferences FROM users WHERE id=?', s.user_id);
  if (req.method !== 'GET' && req.headers['x-csrf-token'] !== s.csrf) fail('Invalid security token. Reload and try again.', 403);
  return {
    ...u,
    csrf: s.csrf,
    session_token: s.token,
    preferences: JSON.parse(u.preferences)
  };
}
function csv(rows) {
  const keys = Object.keys(rows[0] || {
    date: '',
    description: '',
    type: '',
    amount: ''
  });
  const cell = x => '"' + (typeof x === 'string' && /^[=+@\t\r-]/.test(x) ? "'" + x : String(x ?? '')).replace(/"/g, '""') + '"';
  return [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n');
}
async function exportRows(u, filter) {
  return (await ledger.transactions(u, {
    ...filter,
    limit: 500
  })).rows.filter(t => !filter.report || !/Income|Expense/.test(filter.report) || t.postings.some(p => p.book === (/Income/.test(filter.report) ? 'income' : 'expense') && p.amount !== 0)).map(t => ({
    id: t.id,
    date: t.date,
    time: t.time,
    type: t.type,
    description: t.description,
    amount: t.amount / 100,
    income_effect: t.postings.filter(p => p.book === 'income').reduce((s, p) => s - p.amount, 0) / 100,
    expense_effect: t.postings.filter(p => p.book === 'expense').reduce((s, p) => s + p.amount, 0) / 100,
    cash_effect: t.postings.filter(p => p.book === 'asset').reduce((s, p) => s + p.amount, 0) / 100,
    category: t.category,
    subcategory: t.subcategory,
    accounts: t.postings.filter(p => p.account_id).map(p => p.account_name).join(' → '),
    person: t.person_name || '',
    method: t.method,
    tags: t.tags,
    notes: t.notes,
    status: t.reversed ? 'Reversed' : 'Posted'
  }));
}
const backupTables = ['accounts', 'categories', 'people', 'transactions', 'postings', 'obligations', 'settlements', 'budgets', 'goals', 'contributions', 'recurring', 'recurring_events', 'attachments', 'reconciliations', 'closings', 'audit'];
async function backup(u) {
  return {
    format: 'FINTRACK-1',
    currency: 'INR',
    created_at: now(),
    tables: Object.fromEntries(await mapAsync(backupTables, async t => [t, (await ledger.all(`SELECT * FROM ${t} WHERE user_id=?`, u)).map(r => t === 'attachments' ? {
      ...r,
      content: Buffer.from(r.content).toString('base64')
    } : r)]))
  };
}
async function restore(u, b) {
  if (b?.format !== 'FINTRACK-1' || b.currency !== 'INR' || !b.tables) fail('Invalid backup format.');
  if ((await ledger.get('SELECT id FROM transactions WHERE user_id=? LIMIT 1', u)) || (await ledger.get('SELECT id FROM accounts WHERE user_id=? LIMIT 1', u))) fail('Restore is only allowed into an empty workspace. Create a fresh account to preserve existing history.');
  const map = new Map();
  for (const t of backupTables) {
    if (!Array.isArray(b.tables[t])) fail('Backup is missing ' + t);
    if (b.tables[t].length > 100000) fail('Backup table too large.');
    for (const r of b.tables[t]) if (t !== 'audit' && r.id != null) {
      if (map.has(r.id)) fail('Duplicate backup identity.');
      map.set(r.id, uid());
    }
  }
  return await ledger.atomic(async () => {
    const order = ['accounts', 'people', 'categories', 'transactions', 'postings', 'obligations', 'settlements', 'budgets', 'goals', 'contributions', 'recurring', 'recurring_events', 'attachments', 'reconciliations', 'closings'];
    for (const t of order) {
      if (t === 'categories') await ledger.run('DELETE FROM categories WHERE user_id=?', u);
      const cols = await ledger.columns(t);
      for (const r of b.tables[t]) {
        if (Object.keys(r).some(k => !cols.includes(k))) fail('Unsupported backup field.');
        if (t === 'transactions') {
          if (!dateOK(r.date) || r.date > today() || !Number.isSafeInteger(r.amount) || r.amount <= 0) fail('Invalid backup transaction.');
        }
        const keys = Object.keys(r).filter(k => !(t === 'postings' && k === 'id'));
        const vals = keys.map(k => {
          if (k === 'user_id') return u;
          if (k === 'content' && t === 'attachments') return Buffer.from(r[k], 'base64');
          if (['id', 'account_id', 'transaction_id', 'person_id', 'obligation_id', 'goal_id', 'recurring_id', 'origin_tx', 'cancel_tx', 'reversal_of'].includes(k) && r[k] != null) {
            if (!map.has(r[k])) fail('Broken backup relationship.');
            return map.get(r[k]);
          }
          if (k === 'idempotency_key') return null;
          return r[k];
        });
        await ledger.run(`INSERT INTO ${t}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...vals);
      }
    }
    const unbalanced = await ledger.get('SELECT transaction_id FROM postings WHERE user_id=? GROUP BY transaction_id HAVING SUM(amount)!=0 LIMIT 1', u);
    if (unbalanced) fail('Backup contains an unbalanced transaction.');
    const missing = await ledger.get('SELECT id FROM transactions t WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM postings p WHERE p.transaction_id=t.id)', u);
    if (missing) fail('Backup transaction has no journal.');
    for (const o of await ledger.all('SELECT id,original FROM obligations WHERE user_id=?', u)) if ((await ledger.remaining(u, o.id)) < 0) fail('Backup contains an over-settlement.');
    for (const a of b.tables.audit) await ledger.audit(u, `Restored: ${a.action}`, map.get(a.entity_id) || u, {
      original_event: a,
      source: 'backup'
    });
    await ledger.audit(u, 'Backup restored', u, {
      created_at: b.created_at
    });
    return {
      restored: true
    };
  });
}
async function parseSentence(input, u) {
  const s = text(input, 'Transaction sentence', 1000);
  if (/\b(lent|borrowed|loan|repay|repayment|transfer|owed|settle|settled|returned|reimbursement)\b/i.test(s) || /\breceived\b/i.test(s) && !/\b(salary|income|earned)\b/i.test(s)) fail('This may be a transfer or principal settlement, not income or expense. Choose the correct type in the structured form.');
  const m = s.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (!m) fail('No amount found. Try: Spent ₹250 on lunch using UPI today.');
  const amount = Number(m[1].replaceAll(',', ''));
  cents(amount);
  const date = /yesterday/i.test(s) ? new Date(Date.parse(today()) - 86400000).toISOString().slice(0, 10) : today();
  const type = /\b(earned|salary|income)\b/i.test(s) ? 'Income' : 'Expense';
  const category = /lunch|food|dinner|grocer|breakfast|meal/i.test(s) ? 'Food' : /taxi|metro|bus|fuel|transport/i.test(s) ? 'Transport' : /rent/i.test(s) ? 'Rent' : /salary/i.test(s) ? 'Salary' : /phone|internet|bill/i.test(s) ? 'Bills' : 'Other';
  const method = /upi/i.test(s) ? 'UPI' : /cash/i.test(s) ? 'Cash' : 'Bank';
  const a = (await ledger.all('SELECT * FROM accounts WHERE user_id=? AND archived=0', u)).find(a => a.type === method) || (await ledger.get('SELECT * FROM accounts WHERE user_id=? AND type=\'Bank\' AND archived=0 LIMIT 1', u));
  return {
    amount,
    date,
    type,
    category,
    method,
    description: s.match(/\bon\s+(.+?)(?=\s+(?:using|via|with|today|yesterday)\b|[.!]?$)/i)?.[1]?.trim() || s,
    account_id: a?.id || '',
    notes: 'Parsed locally. Verify before posting.'
  };
}
async function answer(question, u) {
  const s = await ledger.snapshot(u),
    f = await ledger.forecast(u, 7),
    q = question.toLowerCase(),
    money = moneyText;
  const person = s.people.find(p => q.includes(p.name.toLowerCase()));
  if (person) {
    const os = s.obligations.filter(o => o.person_id === person.id);
    return `${person.name}: they owe you ${money(os.filter(o => o.kind === 'receivable').reduce((n, o) => n + o.remaining, 0))}; you owe them ${money(os.filter(o => o.kind === 'payable').reduce((n, o) => n + o.remaining, 0))}. Total receipts recorded: ${money(os.filter(o => o.kind === 'receivable').reduce((n, o) => n + o.settled.reduce((a, p) => a + p.amount, 0), 0))}.`;
  }
  if (/owe.*most|owes.*most/.test(q)) {
    const p = s.people.map(p => ({
      ...p,
      n: s.obligations.filter(o => o.person_id === p.id && o.kind === 'receivable').reduce((n, o) => n + o.remaining, 0)
    })).sort((a, b) => b.n - a.n)[0];
    return p?.n ? `${p.name} owes you the most: ${money(p.n)}.` : 'No outstanding receivables.';
  }
  if (/who.*owe|receivable/.test(q)) return s.obligations.filter(o => o.kind === 'receivable' && o.remaining).map(o => `${o.person_name}: ${money(o.remaining)}${o.overdue_days ? ' · ' + o.overdue_days + ' days overdue' : ''}`).join('\n') || 'No outstanding receivables.';
  if (/biggest|largest/.test(q)) return (await ledger.all("SELECT t.* FROM transactions t WHERE user_id=? AND type='Expense' AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id) ORDER BY amount DESC LIMIT 5", u)).map(t => `${t.description}: ${money(t.amount)} (${t.date})`).join('\n') || 'No expense transactions.';
  if (/afford|after.*payment|upcoming|commitment/.test(q)) {
    const n = q.match(/[₹\s](\d[\d,]*)/),
      cost = n ? Number(n[1].replaceAll(',', '')) * 100 : 0;
    return `Available now: ${money(s.available)}. Scheduled next 7 days: ${money(f.incoming)} incoming, ${money(f.outgoing)} outgoing. Projected balance${cost ? ' after ' + money(cost) + ' additional spending' : ''}: ${money(f.projected - cost)}. ${f.projected - cost < 0 ? 'This would leave a cash shortfall.' : 'Expected receipts are not guaranteed; this is not an affordability guarantee.'}\n${f.events.map(e => e.date + ' · ' + e.label + ': ' + money(e.amount)).join('\n')}`;
  }
  if (/why|increase/.test(q)) return s.insights.map(i => i.title + ': ' + i.text).join('\n');
  if (/income|earn/.test(q)) return `Income recorded from ${s.asOf.slice(0, 7)}-01 to ${s.asOf}: ${money(s.income)}. Transfers, loan proceeds and settlements are excluded.`;
  if (/spend|expense|spent/.test(q)) return `Personal expenses recorded from ${s.asOf.slice(0, 7)}-01 to ${s.asOf}: ${money(s.expense)}.\n${s.categories.map(c => c.label + ': ' + money(c.amount)).join('\n')}\nTransfers and loan principal repayments are excluded.`;
  if (/balance|position|money.*have/.test(q)) return `Available funds: ${money(s.available)}. Receivables: ${money(s.receivable)}. Payables: ${money(s.payable)}. Card liabilities: ${money(s.cardLiability)}. Net financial position: ${money(s.net)}.`;
  return 'I can answer ledger questions about monthly spending, income, outstanding balances, the person who owes the most, upcoming payments, biggest expenses and named people. Try one of those. For open-ended AI reasoning, configure the optional AI provider.';
}
async function notifications(s, u) {
  const rows = [];
  if (s.available < 200000) rows.push({
    id: 'low-' + s.asOf,
    tone: 'warning',
    title: 'Your cash buffer is low',
    text: moneyText(s.available) + ' available across liquid accounts.'
  });
  for (const o of s.obligations.filter(o => o.remaining > 0 && o.due_date && o.due_date <= new Date(Date.parse(s.asOf) + 7 * 86400000).toISOString().slice(0, 10))) rows.push({
    id: 'ob-' + o.id + '-' + o.status,
    title: o.person_name + ' · ' + o.status,
    tone: o.overdue_days ? 'danger' : 'warning',
    text: moneyText(o.remaining) + ' · due ' + o.due_date
  });
  for (const b of s.budgets.filter(b => b.percent >= 75)) rows.push({
    id: 'budget-' + b.id + '-' + s.asOf.slice(0, 7),
    title: b.name + ' budget',
    tone: b.percent >= 100 ? 'danger' : 'warning',
    text: b.percent + '% used.'
  });
  for (const r of s.recurring.filter(r => r.active && r.next_date <= new Date(Date.parse(s.asOf) + 7 * 86400000).toISOString().slice(0, 10))) rows.push({
    id: 'rec-' + r.id + '-' + r.next_date,
    title: r.is_subscription ? 'Subscription renewal' : 'Recurring entry due',
    tone: 'neutral',
    text: r.name + ' · ' + moneyText(r.amount) + ' · ' + r.next_date
  });
  for (const g of s.goals.filter(g => g.percent >= 50)) rows.push({
    id: 'goal-' + g.id + '-' + Math.floor(g.percent / 25),
    title: g.name + ' milestone',
    tone: 'positive',
    text: g.percent + '% of your target allocated.'
  });
  const f = await ledger.forecast(u, 30);
  if (f.low) rows.push({
    id: 'forecast-' + f.low.date,
    title: 'Potential cash shortage',
    tone: 'warning',
    text: moneyText(f.low.balance) + ' projected on ' + f.low.date
  });
  const reads = new Set((await ledger.all('SELECT notification_key FROM notifications_read WHERE user_id=?', u)).map(r => r.notification_key));
  return rows.map(r => ({
    ...r,
    read: reads.has(r.id)
  }));
}
async function api(req, res, url) {
  const p = url.pathname.slice(4),
    b = req.method === 'GET' ? {} : await body(req);
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== originForRequest() && !(!prod && ['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(req.headers.origin))) fail('Untrusted request origin.', 403);
  if (['/auth/login', '/auth/register', '/auth/demo', '/auth/reset-request', '/auth/reset'].includes(p)) {
    if (req.method !== 'POST') fail('Method not allowed.', 405);
    if (p === '/auth/demo') {
      if (prod && process.env.ENABLE_DEMO !== 'true') fail('Demo sign-in is disabled.', 403);
      const u = uid();
      await ledger.run('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)', u, 'demo-' + u + '@fintrack.local', 'Sharath', passwordHash(randomBytes(24).toString('hex')), now());
      await seed(ledger, u);
      return json(res, {
        csrf: await session(req, res, u)
      });
    }
    const email = String(b.email || '').toLowerCase().trim();
    if (p !== '/auth/reset' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email.');
    if (p === '/auth/register') {
      validPassword(b.password);
      if (await ledger.get('SELECT id FROM users WHERE email=?', email)) fail('Unable to register this email.');
      const u = uid();
      await ledger.atomic(async () => {
        await ledger.run('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)', u, email, text(b.name, 'Name', 100), passwordHash(b.password), now());
        for (const name of ['Food', 'Transport', 'Shopping', 'Bills', 'Education', 'Health', 'Entertainment', 'Travel', 'Rent', 'Family', 'Subscriptions', 'Other', 'Salary']) await ledger.run('INSERT INTO categories(id,user_id,name) VALUES(?,?,?)', uid(), u, name);
        await ledger.audit(u, 'Workspace created', u, {});
      });
      return json(res, {
        csrf: await session(req, res, u)
      });
    }
    if (p === '/auth/login') {
      if (typeof b.password !== 'string' || b.password.length > 256) fail('Incorrect email or password.', 401);
      const u = await ledger.get('SELECT * FROM users WHERE email=?', email);
      if (!u || !passwordOK(b.password, u.password)) fail('Incorrect email or password.', 401);
      return json(res, {
        csrf: await session(req, res, u.id)
      });
    }
    if (p === '/auth/reset-request') {
      const u = await ledger.get('SELECT * FROM users WHERE email=?', email);
      let dev_token;
      if (u) {
        const token = randomBytes(32).toString('hex');
        await ledger.run('INSERT INTO resets VALUES(?,?,?)', hashToken(token), u.id, new Date(Date.now() + 1800000).toISOString());
        if (process.env.RESET_DELIVERY_URL) {
          if (!process.env.RESET_DELIVERY_URL.startsWith('https://')) fail('Password delivery requires HTTPS.', 503);
          const r = await fetch(process.env.RESET_DELIVERY_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + (process.env.RESET_DELIVERY_SECRET || '')
            },
            body: JSON.stringify({
              email,
              reset_url: originForRequest() + '/?reset=' + token,
              expires_in_minutes: 30
            }),
            signal: AbortSignal.timeout(10000)
          });
          if (!r.ok) fail('Email delivery is unavailable.', 503);
        } else if (!prod && process.env.DEV_SHOW_RESET === 'true') dev_token = token;else if (prod) fail('Password reset delivery has not been configured.', 503);
      }
      return json(res, {
        message: 'If the email is registered, a reset link has been requested.',
        dev_token
      });
    }
    if (p === '/auth/reset') {
      validPassword(b.password);
      const r = await ledger.get('SELECT * FROM resets WHERE token=? AND expires_at>? FOR UPDATE', hashToken(String(b.token || '')), now());
      if (!r) fail('Reset link is invalid or expired.');
      await ledger.atomic(async () => {
        await ledger.run('UPDATE users SET password=? WHERE id=?', passwordHash(b.password), r.user_id);
        await ledger.run('DELETE FROM resets WHERE user_id=?', r.user_id);
        await ledger.run('DELETE FROM sessions WHERE user_id=?', r.user_id);
        await ledger.audit(r.user_id, 'Password reset', r.user_id, {});
      });
      return json(res, {
        message: 'Password reset. Sign in with your new password.'
      });
    }
  }
  if (p === '/health' && req.method === 'GET') {
    await ledger.get('SELECT 1');
    return json(res, {
      status: 'ok'
    });
  }
  const u = await authenticate(req),
    id = u.id;
  getDatabase().setUser(id);
  if (req.method === 'POST') await getDatabase().lockUser(id);
  if (p === '/me' && req.method === 'GET') return json(res, {
    id,
    email: u.email,
    name: u.name,
    csrf: u.csrf,
    preferences: u.preferences,
    ai_configured: !!process.env.OPENAI_API_KEY,
    demo: u.email.endsWith('@fintrack.local')
  });
  if (p === '/auth/logout' && req.method === 'POST') {
    await ledger.run('DELETE FROM sessions WHERE token=?', u.session_token);
    res.setHeader('Set-Cookie', 'fintrack_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, {
      ok: true
    });
  }
  if (p === '/snapshot' && req.method === 'GET') return json(res, await ledger.snapshot(id, url.searchParams.get('date') || today()));
  if (p === '/transactions' && req.method === 'GET') return json(res, await ledger.transactions(id, Object.fromEntries(url.searchParams)));
  if (p === '/transactions' && req.method === 'POST') {
    const tx = await ledger.post(id, b);
    return json(res, {
      id: tx
    }, 201);
  }
  if (p === '/transactions/reverse' && req.method === 'POST') return json(res, {
    id: await ledger.reverse(id, b.id, b.reason, b.date || today())
  });
  if (p === '/duplicates' && req.method === 'POST') {
    const n = cents(b.amount);
    return json(res, (await ledger.all(`SELECT t.* FROM transactions t WHERE user_id=? AND amount=? AND date=? AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id) AND EXISTS(SELECT 1 FROM postings p WHERE p.transaction_id=t.id AND p.account_id=?)`, id, n, b.date || today(), b.account_id || '')).map(t => ({
      ...t,
      match: t.description === b.description ? 'Exact description match' : 'Similar amount, date and account'
    })));
  }
  if (p === '/parse' && req.method === 'POST') return json(res, await parseSentence(b.sentence, id));
  if (p === '/accounts' && req.method === 'POST') return json(res, {
    id: await ledger.addAccount(id, b)
  }, 201);
  if (p === '/people' && req.method === 'POST') return json(res, {
    id: await ledger.addPerson(id, b)
  }, 201);
  if (p === '/obligations/cancel' && req.method === 'POST') return json(res, {
    id: await ledger.cancel(id, b.id, b.reason)
  });
  if (p === '/budgets' && req.method === 'POST') {
    const n = cents(b.amount),
      bid = uid();
    if (b.account_id) await ledger.account(id, b.account_id);
    if (!['weekly', 'monthly'].includes(b.period || 'monthly')) fail('Invalid budget period.');
    await ledger.run('INSERT INTO budgets VALUES(?,?,?,?,?,?,?)', bid, id, text(b.name, 'Budget name', 100), n, b.category || '', b.account_id || null, b.period || 'monthly');
    await ledger.audit(id, 'Budget created', bid, b);
    return json(res, {
      id: bid
    }, 201);
  }
  if (p === '/goals' && req.method === 'POST') {
    const gid = uid();
    if (b.target_date && !dateOK(b.target_date)) fail('Invalid target date.');
    await ledger.run('INSERT INTO goals VALUES(?,?,?,?,?,?,?)', gid, id, text(b.name, 'Goal name', 100), cents(b.target), b.target_date || null, b.priority || 'Medium', b.notes || '');
    await ledger.audit(id, 'Goal created', gid, b);
    return json(res, {
      id: gid
    }, 201);
  }
  if (p === '/goals/contribute' && req.method === 'POST') return json(res, await ledger.atomic(async () => {
    const g = await ledger.own('goals', b.goal_id, id),
      tx = await ledger.own('transactions', b.transaction_id, id),
      amount = cents(b.amount);
    if (tx.type !== 'Transfer' || tx.date > today() || tx.reversed || (await ledger.get('SELECT id FROM transactions WHERE reversal_of=?', tx.id))) fail('Select a posted transfer into a savings account.');
    const target = await ledger.get('SELECT a.* FROM postings p JOIN accounts a ON a.id=p.account_id WHERE p.transaction_id=? AND p.amount>0 AND a.type=\'Savings\'', tx.id);
    if (!target) fail('The transfer must credit a Savings account.');
    await ledger.assertOpen(id, tx.date);
    const used = (await ledger.get('SELECT COALESCE(SUM(amount),0) n FROM contributions WHERE transaction_id=?', tx.id)).n;
    if (amount + used > tx.amount) fail('Allocation exceeds the unallocated transfer amount.');
    await ledger.run('INSERT INTO contributions VALUES(?,?,?,?,?,?)', uid(), id, g.id, tx.id, amount, tx.date);
    await ledger.audit(id, 'Goal allocation', g.id, {
      amount,
      transaction_id: tx.id
    });
    return {
      ok: true
    };
  }));
  if (p === '/categories' && req.method === 'POST') {
    const c = uid();
    if (b.color && !/^#[0-9a-f]{6}$/i.test(b.color)) fail('Invalid color.');
    await ledger.run('INSERT INTO categories VALUES(?,?,?,?,?)', c, id, text(b.name, 'Category', 50), b.subcategory || '', b.color || '#4574b5');
    await ledger.audit(id, 'Category created', c, b);
    return json(res, {
      id: c
    });
  }
  if (p === '/recurring' && req.method === 'POST') {
    await ledger.account(id, b.account_id);
    if (!dateOK(b.next_date) || b.end_date && !dateOK(b.end_date)) fail('Invalid recurrence dates.');
    if (b.end_date && b.end_date < b.next_date) fail('End date precedes start.');
    if (!['Income', 'Expense'].includes(b.type)) fail('Recurring type must be Income or Expense.');
    const days = Number(b.custom_days || 30);
    if (!Number.isInteger(days) || days < 1 || days > 3650) fail('Invalid custom interval.');
    nextOccurrence(b.next_date, b.frequency, days);
    const rid = uid();
    await ledger.run('INSERT INTO recurring VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', rid, id, text(b.name, 'Name', 100), b.type, cents(b.amount), b.account_id, b.category || 'Other', b.frequency, b.next_date, b.end_date || null, b.is_subscription ? 1 : 0, 1, days);
    await ledger.audit(id, 'Recurring template created', rid, b);
    return json(res, {
      id: rid
    });
  }
  if (p === '/recurring/toggle' && req.method === 'POST') {
    const r = await ledger.own('recurring', b.id, id);
    await ledger.run('UPDATE recurring SET active=? WHERE id=?', r.active ? 0 : 1, r.id);
    await ledger.audit(id, 'Recurring template toggled', r.id, {
      active: !r.active
    });
    return json(res, {
      ok: true
    });
  }
  if (p === '/recurring/post' && req.method === 'POST') return json(res, await ledger.atomic(async () => {
    const r = await ledger.own('recurring', b.id, id);
    if (!r.active || r.next_date > today() || r.end_date && r.next_date > r.end_date) fail('This occurrence is not due.');
    const tx = await ledger._post(id, {
      type: r.type,
      amount: r.amount / 100,
      date: r.next_date,
      description: r.name,
      account_id: r.account_id,
      category: r.category,
      recurring_id: r.id,
      idempotency_key: r.id + ':' + r.next_date
    });
    await ledger.run('INSERT INTO recurring_events VALUES(?,?,?,?,?)', uid(), id, r.id, r.next_date, tx);
    await ledger.run('UPDATE recurring SET next_date=? WHERE id=?', nextOccurrence(r.next_date, r.frequency, r.custom_days), r.id);
    return {
      id: tx
    };
  }));
  if (p === '/reconcile' && req.method === 'POST') return json(res, await ledger.atomic(async () => {
    const a = await ledger.account(id, b.account_id),
      actual = Number(b.actual);
    if (!Number.isFinite(actual) || Math.abs(actual) > 1e10 || !/^[-]?\d+(\.\d{1,2})?$/.test(String(b.actual))) fail('Invalid actual balance.');
    const d = today(),
      system = await ledger.balance(id, a.id),
      delta = Math.round(actual * 100) - system,
      reason = text(b.reason, 'Reason'),
      rid = uid();
    let tx = null;
    if (delta) tx = await ledger._post(id, {
      type: 'Adjustment',
      amount: Math.abs(delta) / 100,
      account_id: a.id,
      date: d,
      direction: delta > 0 ? 'increase' : 'decrease',
      description: 'Reconciliation · ' + a.name,
      notes: reason
    });
    await ledger.run('INSERT INTO reconciliations VALUES(?,?,?,?,?,?,?,?,?)', rid, id, a.id, d, system, Math.round(actual * 100), reason, tx, now());
    await ledger.audit(id, 'Account reconciled', rid, {
      system,
      actual: Math.round(actual * 100),
      reason
    });
    return {
      difference: delta,
      id: rid
    };
  }));
  if (p === '/closing' && req.method === 'POST') {
    if (!/^\d{4}-\d{2}$/.test(b.month) || !dateOK(b.month + '-01') || b.month >= today().slice(0, 7)) fail('Choose a completed calendar month.');
    if (b.reopen) await ledger.run('DELETE FROM closings WHERE user_id=? AND month=?', id, b.month);else await ledger.run('INSERT INTO closings VALUES(?,?,?,?)', uid(), id, b.month, now());
    await ledger.audit(id, b.reopen ? 'Month reopened' : 'Month closed', b.month, {
      reason: text(b.reason, 'Reason')
    });
    return json(res, {
      ok: true
    });
  }
  if (p === '/report-summary' && req.method === 'GET') {
    const from = url.searchParams.get('from') || today().slice(0, 7) + '-01',
      to = url.searchParams.get('to') || today();
    if (!dateOK(from) || !dateOK(to) || from > to || to > today()) fail('Invalid report date range.');
    const before = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10),
      snap = await ledger.snapshot(id, to),
      opening = (await ledger.snapshot(id, before)).available;
    return json(res, {
      ...snap,
      ...(await ledger.periodTotals(id, from, to)),
      opening
    });
  }
  if (p === '/analytics' && req.method === 'GET') {
    const from = url.searchParams.get('from') || today().slice(0, 7) + '-01',
      to = url.searchParams.get('to') || today(),
      grain = url.searchParams.get('grain') || 'monthly';
    if (!dateOK(from) || !dateOK(to) || from > to || to > today()) fail('Invalid analytics date range.');
    const maxDays = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (maxDays > 3660 || grain === 'daily' && maxDays > 366) fail('Use at most 366 daily points or a 10-year range.');
    if (!['daily', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(grain)) fail('Invalid grouping.');
    const bucket = d => {
      const x = new Date(d + 'T12:00Z');
      if (grain === 'daily') return d;
      if (grain === 'weekly') {
        x.setUTCDate(x.getUTCDate() - (x.getUTCDay() + 6) % 7);
        return x.toISOString().slice(0, 10);
      }
      if (grain === 'monthly') return d.slice(0, 7) + '-01';
      if (grain === 'quarterly') return d.slice(0, 4) + '-' + String(Math.floor(x.getUTCMonth() / 3) * 3 + 1).padStart(2, '0') + '-01';
      return d.slice(0, 4) + '-01-01';
    };
    const groups = new Map();
    let current = from;
    while (current <= to) {
      const key = bucket(current);
      if (!groups.has(key)) groups.set(key, {
        date: key,
        label: grain === 'monthly' ? new Date(key + 'T12:00Z').toLocaleDateString('en', {
          month: 'short',
          year: '2-digit'
        }) : key,
        income: 0,
        expense: 0,
        cash_flow: 0,
        savings: 0,
        last: current
      });
      groups.get(key).last = current;
      current = new Date(Date.parse(current) + 86400000).toISOString().slice(0, 10);
    }
    const legs = await ledger.all('SELECT p.book,p.amount,t.date FROM postings p JOIN transactions t ON t.id=p.transaction_id WHERE p.user_id=? AND t.date BETWEEN ? AND ?', id, from, to);
    for (const j of legs) {
      const g = groups.get(bucket(j.date));
      if (j.book === 'income') g.income -= j.amount;
      if (j.book === 'expense') g.expense += j.amount;
      if (j.book === 'asset') g.cash_flow += j.amount;
    }
    for (const c of await ledger.all('SELECT c.date,c.amount FROM contributions c JOIN transactions t ON t.id=c.transaction_id WHERE c.user_id=? AND c.date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id AND r.date<=?)', id, from, to, to)) groups.get(bucket(c.date)).savings += c.amount;
    const series = await mapAsync([...groups.values()], async g => {
      const s = await ledger.get("SELECT COALESCE(SUM(CASE WHEN p.book IN ('asset','receivable','payable','liability') THEN p.amount ELSE 0 END),0) net,COALESCE(SUM(CASE WHEN p.book='receivable' THEN p.amount ELSE 0 END),0) receivable,COALESCE(SUM(CASE WHEN p.book='payable' THEN -p.amount ELSE 0 END),0) payable FROM postings p JOIN transactions t ON t.id=p.transaction_id WHERE p.user_id=? AND t.date<=?", id, g.last);
      return {
        ...g,
        ...s
      };
    });
    const categories = await ledger.all("SELECT t.category label,SUM(p.amount) amount FROM postings p JOIN transactions t ON t.id=p.transaction_id WHERE p.user_id=? AND p.book='expense' AND t.date BETWEEN ? AND ? GROUP BY t.category HAVING SUM(p.amount)>0 ORDER BY amount DESC", id, from, to);
    const accounts = await ledger.all("SELECT a.name label,SUM(e.amount) amount FROM postings e JOIN transactions t ON t.id=e.transaction_id JOIN postings c ON c.transaction_id=t.id AND c.account_id IS NOT NULL JOIN accounts a ON a.id=c.account_id WHERE e.user_id=? AND e.book='expense' AND t.date BETWEEN ? AND ? GROUP BY a.id HAVING SUM(e.amount)>0 ORDER BY amount DESC", id, from, to);
    const people = await ledger.all("SELECT COALESCE(x.name,'Unassigned') label,SUM(p.amount) amount FROM postings p JOIN transactions t ON t.id=p.transaction_id LEFT JOIN people x ON x.id=t.person_id WHERE p.user_id=? AND p.book='expense' AND t.date BETWEEN ? AND ? GROUP BY x.id HAVING SUM(p.amount)>0 ORDER BY amount DESC", id, from, to);
    const nowDate = today(),
      first = nowDate.slice(0, 7) + '-01',
      prevLast = new Date(Date.parse(first) - 86400000).toISOString().slice(0, 10),
      prevFirst = prevLast.slice(0, 7) + '-01';
    const prevYear = String(Number(nowDate.slice(0, 4)) - 1),
      prevDate = prevYear + nowDate.slice(4);
    return json(res, {
      series,
      categories,
      accounts,
      people,
      current_month: await ledger.periodTotals(id, first, nowDate),
      previous_month: await ledger.periodTotals(id, prevFirst, prevLast),
      current_year: await ledger.periodTotals(id, nowDate.slice(0, 4) + '-01-01', nowDate),
      previous_year: await ledger.periodTotals(id, prevYear + '-01-01', dateOK(prevDate) ? prevDate : prevYear + '-02-28')
    });
  }
  if (p === '/forecast' && req.method === 'GET') return json(res, await ledger.forecast(id, url.searchParams.get('days')));
  if (p === '/simulate' && req.method === 'POST') {
    const amount = cents(b.amount),
      s = await ledger.snapshot(id);
    if (!['expense', 'receipt', 'payment', 'income'].includes(b.type)) fail('Invalid scenario.');
    let rec = s.receivable,
      pay = s.payable;
    if (['receipt', 'payment'].includes(b.type)) {
      const o = await ledger.own('obligations', b.obligation_id, id);
      if (b.type === 'receipt' !== (o.kind === 'receivable')) fail('Wrong obligation type.');
      if (amount > (await ledger.remaining(id, o.id))) fail('Scenario exceeds the outstanding obligation.');
      if (b.type === 'receipt') rec -= amount;else pay -= amount;
    }
    const avail = s.available + (['receipt', 'income'].includes(b.type) ? amount : -amount);
    return json(res, {
      available: avail,
      receivable: rec,
      payable: pay,
      net: avail + rec - pay - s.cardLiability,
      change: avail - s.available,
      notice: 'Hypothetical only. No journal entry was created.'
    });
  }
  if (p === '/notifications' && req.method === 'GET') return json(res, await notifications(await ledger.snapshot(id), id));
  if (p === '/notifications/read' && req.method === 'POST') {
    for (const key of Array.isArray(b.ids) ? b.ids : []) await ledger.run('INSERT OR IGNORE INTO notifications_read VALUES(?,?)', id, String(key));
    return json(res, {
      ok: true
    });
  }
  if (p === '/profile' && req.method === 'POST') {
    const name = text(b.name, 'Name', 100);
    let pref = u.preferences;
    if (b.preferences) {
      if (typeof b.preferences !== 'object' || Array.isArray(b.preferences)) fail('Invalid preferences.');
      if (JSON.stringify(b.preferences).length > 10000) fail('Preferences are too large.');
      pref = b.preferences;
    }
    await ledger.run('UPDATE users SET name=?,preferences=? WHERE id=?', name, JSON.stringify(pref), id);
    await ledger.audit(id, 'Profile preferences updated', id, {
      name
    });
    return json(res, {
      ok: true
    });
  }
  if (p === '/profile/password' && req.method === 'POST') {
    const stored = (await ledger.get('SELECT password FROM users WHERE id=?', id)).password;
    if (typeof b.current !== 'string' || b.current.length > 256 || !passwordOK(b.current, stored)) fail('Current password is incorrect.');
    validPassword(b.password);
    await ledger.run('UPDATE users SET password=? WHERE id=?', passwordHash(b.password), id);
    await ledger.run('DELETE FROM sessions WHERE user_id=? AND token!=?', id, u.session_token);
    await ledger.audit(id, 'Password changed', id, {});
    return json(res, {
      ok: true
    });
  }
  if (p === '/audit' && req.method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    return json(res, {
      rows: await ledger.all('SELECT a.*,u.name actor FROM audit a JOIN users u ON u.id=a.user_id WHERE a.user_id=? ORDER BY a.id DESC LIMIT 50 OFFSET ?', id, (page - 1) * 50),
      total: (await ledger.get('SELECT COUNT(*) n FROM audit WHERE user_id=?', id)).n
    });
  }
  if (p === '/assistant' && req.method === 'POST') {
    const q = text(b.question, 'Question', 1500);
    if (b.use_ai) {
      if (!process.env.OPENAI_API_KEY) fail('AI provider is not configured.', 503);
      const s = await ledger.snapshot(id),
        context = {
          asOf: s.asOf,
          available: s.available / 100,
          receivable: s.receivable / 100,
          payable: s.payable / 100,
          net: s.net / 100,
          income: s.income / 100,
          expenses: s.expense / 100,
          categories: s.categories.map(c => ({
            category: c.label,
            amount: c.amount / 100
          })),
          obligations: s.obligations.map(o => ({
            person: o.person_name,
            remaining: o.remaining / 100,
            kind: o.kind,
            due: o.due_date
          })),
          forecast: await ledger.forecast(id, 7)
        };
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
          temperature: 0,
          messages: [{
            role: 'system',
            content: 'You are FINTRACK. Use ONLY the provided ledger facts. Monetary values are INR rupees except the forecast object, which uses integer paise. Do not invent missing data. Explain uncertainty; no guarantees or investment advice. You cannot modify records. Context: ' + JSON.stringify(context)
          }, {
            role: 'user',
            content: q
          }]
        }),
        signal: AbortSignal.timeout(18000)
      });
      if (!r.ok) fail('AI provider could not answer. The local ledger assistant remains available.', 502);
      const out = await r.json();
      return json(res, {
        answer: out.choices?.[0]?.message?.content || 'No response from provider.',
        mode: 'AI analysis · verify against your ledger'
      });
    }
    return json(res, {
      answer: await answer(q, id),
      mode: 'Local ledger query · no generative AI'
    });
  }
  if (p === '/attachments' && req.method === 'POST') {
    await ledger.own('transactions', b.transaction_id, id);
    text(b.name, 'Filename', 200);
    const allow = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'];
    if (!allow.includes(b.mime)) fail('Allowed: PNG, JPEG, WebP, PDF and plain text.');
    const content = Buffer.from(String(b.content || ''), 'base64');
    if (!content.length || content.length > 2 * 1024 * 1024) fail('Attachment must be 1 byte to 2 MB.');
    const aid = uid();
    await ledger.run('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)', aid, id, b.transaction_id, b.name, b.mime, content, now());
    await ledger.audit(id, 'Attachment added', aid, {
      name: b.name,
      transaction_id: b.transaction_id
    });
    return json(res, {
      id: aid
    });
  }
  if (p.startsWith('/attachments/') && req.method === 'GET') {
    const a = await ledger.get('SELECT * FROM attachments WHERE id=? AND user_id=?', p.split('/')[2], id);
    if (!a) fail('Attachment not found.', 404);
    res.writeHead(200, {
      'Content-Type': a.mime,
      'Content-Disposition': `${url.searchParams.get('preview') === 'true' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(Buffer.from(a.content));
  }
  if (p === '/backup' && req.method === 'GET') {
    res.setHeader('Content-Disposition', 'attachment; filename="fintrack-backup.json"');
    return json(res, await backup(id));
  }
  if (p === '/restore' && req.method === 'POST') return json(res, await restore(id, b.backup));
  if (p === '/import/preview' && req.method === 'POST') {
    await ledger.account(id, b.account_id);
    let rows = b.rows;
    if (b.content) {
      try {
        rows = await importFile(Buffer.from(b.content, 'base64'));
      } catch (e) {
        fail(e.message || 'Cannot read this CSV/XLSX file.');
      }
    }
    if (!Array.isArray(rows) || rows.length > 10000) fail('Import up to 10,000 rows per file.');
    const preview = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const r = Object.fromEntries(Object.entries(rows[i]).map(([k, v]) => [k.toLowerCase().trim(), v]));
      let errors = [],
        p;
      try {
        let date = String(r.date || '').slice(0, 10);
        if (!dateOK(date) || date > today()) fail('Date must be YYYY-MM-DD and no later than today.');
        const candidates = [['Income', r.income], ['Expense', r.expense], ['Receivable', r.receivables || r.receivable], ['Payable', r.payables || r.payable]].filter(([t, n]) => Number(n) > 0);
        if (candidates.length !== 1) fail('Exactly one income, expense, receivable or payable amount is required.');
        const [type, n] = candidates[0];
        cents(String(n));
        p = {
          date,
          type,
          amount: Number(n),
          description: String(r.particulars || r.description || ''),
          category: String(r.category || 'Other'),
          notes: String(r.remarks || r.notes || ''),
          person_name: String(r.person || r.particulars || ''),
          account_id: b.account_id
        };
        text(p.description, 'Particulars');
      } catch (e) {
        errors.push(e.message);
      }
      let duplicate = false;
      if (p) {
        const key = [p.date, p.type, p.amount, p.description].join('|');
        duplicate = seen.has(key) || !!(await ledger.get('SELECT id FROM transactions WHERE user_id=? AND date=? AND type=? AND amount=? AND description=?', id, p.date, p.type, Math.round(p.amount * 100), p.description));
        seen.add(key);
      }
      preview.push({
        row: i + 2,
        transaction: p || null,
        errors,
        duplicate,
        reported_balance: r.balance ?? null
      });
    }
    return json(res, {
      rows: preview,
      detected: rows.length,
      valid: preview.filter(r => !r.errors.length && !r.duplicate).length,
      errors: preview.filter(r => r.errors.length).length,
      duplicates: preview.filter(r => r.duplicate).length,
      notice: 'Balance is a reference only, not a transaction. Verify and reconcile imported balances separately. Receivable/payable rows become unfunded opening claims unless posted manually as loans.'
    });
  }
  if (p === '/import/confirm' && req.method === 'POST') return json(res, await ledger.atomic(async () => {
    if (!Array.isArray(b.rows) || b.rows.length > 10000) fail('Invalid import.');
    let count = 0;
    for (const row of b.rows) {
      const p = {
        ...row
      };
      if (['Receivable', 'Payable'].includes(p.type)) {
        let person = await ledger.get('SELECT id FROM people WHERE user_id=? AND name=?', id, p.person_name);
        p.person_id = person?.id || (await ledger.addPerson(id, {
          name: p.person_name
        }));
      }
      p.idempotency_key = 'import:' + hashToken(JSON.stringify([p.date, p.type, p.amount, p.description, p.account_id]));
      await ledger._post(id, p);
      count++;
    }
    await ledger.audit(id, 'File import completed', id, {
      rows: count
    });
    return {
      count
    };
  }));
  if (p === '/export' && req.method === 'GET') {
    const filter = Object.fromEntries(url.searchParams),
      rows = [];
    if(filter.report){filter.from ||= (filter.report==='Annual Report'?today().slice(0,4)+'-01-01':today().slice(0,7)+'-01');filter.to ||=today();}if (/Income|Expense/.test(filter.report || '')) delete filter.type;
    let page = 1;
    while (true) {
      const batch = await exportRows(id, {
        ...filter,
        page: page++,
        limit: 500
      });
      rows.push(...batch);
      if ((page - 1) * 500 >= (await ledger.transactions(id, {
        ...filter,
        limit: 1
      })).total) break;
      if (rows.length > 200000) fail('Export exceeds 200,000 rows. Use a date range.');
    }
    const format = filter.format || 'csv';
    if (!['csv', 'xlsx', 'pdf'].includes(format)) fail('Unsupported export format.');
    const from = filter.from || (rows.length?rows.reduce((d,r)=>r.date<d?r.date:d,today()):today().slice(0,7)+'-01'),
      to = filter.to || today();
    const snapshot = await ledger.snapshot(id, to);
    let reportRows = rows;
    if (/Receivable|Payable/.test(filter.report || '')) reportRows = snapshot.obligations.filter(o => o.kind === (filter.report.startsWith('Receivable') ? 'receivable' : 'payable')).map(o => ({
      person: o.person_name,
      reason: o.reason,
      original: o.original / 100,
      settled: o.settled.reduce((s, x) => s + x.amount, 0) / 100,
      remaining: o.remaining / 100,
      due_date: o.due_date || '',
      status: o.status
    }));
    if (/Budget/.test(filter.report || '')) reportRows = snapshot.budgets.map(b => ({
      name: b.name,
      period: b.period,
      category: b.category || 'All',
      limit: b.amount / 100,
      used: b.used / 100,
      remaining: b.remaining / 100,
      percent: b.percent
    }));
    rows.splice(0, rows.length, ...reportRows);
    const report = {
      title: filter.report || 'Financial Ledger',
      name: u.name,
      from,
      to,
      rows,
      totals: await ledger.periodTotals(id, from, to),
      snapshot
    };
    if (format === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="fintrack-ledger.csv"'
      });
      return res.end('\uFEFF' + csv(rows));
    }
    if (rows.length > 10000) fail('Use a smaller date range: serverless Excel/PDF exports support up to 10,000 rows.', 413);
    const output = format === 'pdf' ? await pdfReport(report) : await excelReport(report);
    res.writeHead(200, {
      'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="fintrack-report.${format}"`
    });
    return res.end(output);
  }
  fail('Route not found.', 404);
}

export async function handleRequest(request,context={}){
 let status=200,headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'},output;
 const res={setHeader(k,v){headers[k]=v;},writeHead(s,h={}){status=s;Object.assign(headers,h);},end(data=''){const bytes=Buffer.isBuffer(data)?data:Buffer.from(String(data));if(bytes.length>4*1024*1024){status=413;headers['Content-Type']='application/json';delete headers['Content-Disposition'];output=Buffer.from(JSON.stringify({error:'Response exceeds the serverless size limit. Use a smaller export date range.'}));}else output=bytes;}};
 try{
 const url=new URL(request.url);if(url.pathname==='/api/config'||url.pathname==='/.netlify/functions/api/config')return new Response(JSON.stringify({demo_enabled:process.env.ENABLE_DEMO==='true',max_attachment_mb:2,database_configured:!!process.env.DATABASE_URL}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});const db=getDatabase();if(url.pathname.startsWith('/.netlify/functions/api'))url.pathname='/api'+url.pathname.slice('/.netlify/functions/api'.length);
 const appOrigin=process.env.APP_ORIGIN||url.origin;
 const req={method:request.method,headers:Object.fromEntries(request.headers),socket:{remoteAddress:context.ip||(process.env.NETLIFY==='true'?request.headers.get('x-nf-client-connection-ip'):null)||'local'},parsedBody:{}};
 const path=url.pathname.slice(4);await db.rateLimit(req.socket.remoteAddress,'api',240);
 if(path.startsWith('/auth/'))await db.rateLimit(req.socket.remoteAddress,'auth',20);
 if(path==='/assistant')await db.rateLimit(req.socket.remoteAddress,'assistant',12);
 if(request.method!=='GET'){const raw=await request.text();if(Buffer.byteLength(raw)>4*1024*1024)fail('Request exceeds the serverless 4 MB safety limit.',413);try{req.parsedBody=JSON.parse(raw||'{}');}catch{fail('Invalid JSON.');}if(!req.parsedBody||typeof req.parsedBody!=='object'||Array.isArray(req.parsedBody))fail('Expected a JSON object.');}
 const readonly=['/assistant','/parse','/duplicates','/import/preview','/simulate'];
 await currentRequest.run({ledger:new Ledger(db),origin:appOrigin},()=>db.withRequest(()=>request.method==='POST'&&!readonly.includes(path)?db.atomic(()=>api(req,res,url)):db.readonly(()=>api(req,res,url))));
 }catch(e){status=e.status||(['23503','23514','22P02','P0001'].includes(e.code)?400:e.code==='23505'?409:500);headers['Content-Type']='application/json';delete headers['Content-Disposition'];output=Buffer.from(JSON.stringify({error:e.status?e.message:e.code==='23505'?'A matching record already exists.':status===400?'Invalid financial data or immutable record operation.':e.code==='42P01'?'Database schema is not initialized. Run npm run db:migrate with DATABASE_URL set.':'The request could not be completed. Check the function log.'}));if(!e.status)console.error('FINTRACK API failure',e.code||'',e.message);}
 return new Response(output||'',{status,headers});
}

// One payment spread over open invoices (oldest first) and the statement's one-line-per-day
// payments, on a real backup's data, against sums worked out here.
//    node tests/pay_spread.mjs erp.db
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const L = await import('../js/localdb.js');
const Q = await import('../js/queries.js');
const KO = await import('../js/ops/stock.js');
const SO = await import('../js/ops/sales.js');
const { TABLES } = await import('../js/schema.js');
await L.openLocal(require('sql.js'), require.resolve('sql.js/dist/sql-wasm.wasm'));
const src = L.openBytes(fs.readFileSync(process.argv[2]));
for (const [name, def] of Object.entries(TABLES)) {
  if (!L.withDb(src, () => L.all(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name])).length) continue;
  const cols = new Set(L.withDb(src, () => L.all(`PRAGMA table_info("${name}")`)).map(r => r.name));
  for (const r of L.withDb(src, () => L.all(`SELECT * FROM "${name}"`))) {
    const row = {}; for (const [c] of def.cols) if (c !== def.key) row[c] = cols.has(c) ? r[c] : null;
    L.upsertRow(name, r[def.key], row);
  }
}
let failed = 0;
const expect = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const near = (a, b) => Math.abs(a - b) < 0.005;
// a change as the app makes it: all of it, or nothing
const change = fn => { L.begin(); try { const r = fn(); L.commitLocal(); return r; } catch (e) { L.rollback(); throw e; } };
const refused = fn => { try { change(fn); return null; } catch (e) { if (!e.user) throw e; return e.message; } };
const snapshot = () => JSON.stringify(['invoice_payments', 'cash_transactions'].map(tb => L.all(`SELECT * FROM ${tb} ORDER BY id`)));

// ---------- the statement: one payment line per day ----------
function checkStatement(cid, tag) {
  const led = Q.customerLedger(cid), st = Q.statementLines(cid);
  const pays = led.filter(e => e.kind === 'payment');
  const days = new Set(pays.map(e => `${String(e.when).slice(0, 10)}|${e.currency_code}|${e.cancelled ? 1 : 0}`));
  const sum = (xs, f) => xs.reduce((s, e) => s + f(e), 0);
  let ok = st.filter(e => e.kind === 'payment').length === days.size
    && st.filter(e => e.kind !== 'payment').length === led.filter(e => e.kind !== 'payment').length
    && near(sum(st, e => e.payment), sum(led, e => e.payment)) && near(sum(st, e => e.charge), sum(led, e => e.charge))
    && (!led.length || near(st[st.length - 1].balance, led[led.length - 1].balance));
  // each line's balance = the previous one + its charge − its payment
  let run = 0;
  for (const e of st) { run += e.charge - e.payment; if (!near(run, e.balance)) ok = false; }
  // each day's line holds exactly that day's payments
  for (const g of st.filter(e => e.kind === 'payment')) {
    const same = pays.filter(e => String(e.when).slice(0, 10) === String(g.when).slice(0, 10) && e.currency_code === g.currency_code && !!e.cancelled === !!g.cancelled);
    if (!near(sum(same, e => e.payment), g.payment) || g.count !== same.length || g.labels.join() !== [...new Set(same.map(e => e.label))].join()) ok = false;
  }
  expect(ok, `${tag}: ${led.length} history lines → ${st.length} statement lines (${pays.length} payments on ${days.size} day(s)), same final balance`);
}
for (const c of L.all(`SELECT id, name FROM customers ORDER BY id`)) checkStatement(c.id, `statement of ${c.name.trim()}`);

const toure = L.val(`SELECT id FROM customers WHERE trim(name) = 'Toure'`);
const st = Q.statementLines(toure).filter(e => e.kind === 'payment');
const want = { '2026-11-02': 139400000, '2026-11-04': 20560000, '2026-11-05': 35400000, '2026-11-12': 24600000 };
expect(Object.entries(want).every(([d, a]) => st.some(e => String(e.when).startsWith(d) && near(e.payment, a))) && st.length === 4,
  `Toure: 4 payment lines — ${st.map(e => String(e.when).slice(0, 10) + ' ' + e.payment).join(', ')}`);

// ---------- one payment spread over the open invoices ----------
const open0 = KO.openInvoices(toure);
const owed0 = open0.reduce((s, i) => s + i.balance, 0);
console.log('     open:', open0.map(i => `${i.invoice_number} ${i.balance}`).join(', '), '— owes', owed0);
expect(open0.length >= 3, 'Toure has at least 3 open invoices');
const usdAcct = L.val(`SELECT id FROM cash_accounts WHERE currency_code = 'USD' ORDER BY id LIMIT 1`);
const gnfAcct = L.val(`SELECT id FROM cash_accounts WHERE currency_code = 'GNF' ORDER BY id LIMIT 1`);
const day = new Date().toISOString().slice(0, 10);

// refusals change nothing
let before = snapshot();
let m = refused(() => SO.customerPayOnAccount(toure, { currency_code: 'GNF', amount: owed0 + 1, paid_on: day, account_id: gnfAcct }));
expect(m && /more than|plus que/.test(m) && snapshot() === before, `more than owed is refused, nothing recorded: “${m}”`);
m = refused(() => SO.customerPayOnAccount(toure, { currency_code: 'GNF', amount: 0, paid_on: day }));
expect(m && snapshot() === before, `zero is refused: “${m}”`);
m = refused(() => SO.customerPayOnAccount(toure, { currency_code: 'GNF', amount: '', paid_on: day }));
expect(m && snapshot() === before, `no amount is refused: “${m}”`);
m = refused(() => SO.customerPayOnAccount(toure, { currency_code: 'USD', amount: 5, paid_on: day }));
expect(m && snapshot() === before, `a currency with nothing owed is refused: “${m}”`);
m = refused(() => SO.customerPayOnAccount(toure, { currency_code: 'GNF', amount: 1000, paid_on: '2026-10-01' }));
expect(m && snapshot() === before, `a date before every invoice is refused: “${m}”`);

// dated before a later order: that invoice is left out (tried, then undone)
const orderDay = i => String(L.val(`SELECT created_at FROM orders WHERE id = ?`, [i.order_id])).slice(0, 10);
const cut = open0.map(orderDay).find((d, k, a) => k > 0 && d > a[0]);
if (cut) {
  const prev = new Date(Date.parse(cut) - 86400000).toISOString().slice(0, 10);
  const inTime = open0.filter(i => orderDay(i) <= prev), owedIn = inTime.reduce((s, i) => s + i.balance, 0);
  L.begin();
  m = SO.customerPayOnAccount(toure, { currency_code: 'GNF', pay_in_full: 1, paid_on: prev });
  const left = KO.openInvoices(toure).map(i => i.invoice_number).join();
  L.rollback();
  expect(left === open0.filter(i => orderDay(i) > prev).map(i => i.invoice_number).join(), `paid in full on ${prev}: only the ${inTime.length} invoice(s) ordered by then are paid (${owedIn}); still open: ${left}`);
  m = refused(() => SO.customerPayOnAccount(toure, { currency_code: 'GNF', amount: owedIn + 1, paid_on: prev }));
  expect(m && /\d{4}-\d{2}-\d{2}/.test(m) && snapshot() === before, `more than owed up to ${prev} is refused: “${m}”`);
}

// first invoice in full, half of the second, nothing on the rest — into the GNF account
const amt = open0[0].balance + Math.round(open0[1].balance / 2);
const nPay = L.val(`SELECT COUNT(*) FROM invoice_payments`), nCash = L.val(`SELECT COUNT(*) FROM cash_transactions`);
m = change(() => SO.customerPayOnAccount(toure, { currency_code: 'GNF', amount: amt, paid_on: day, account_id: gnfAcct, note: 'versement' }));
console.log('     →', m);
const after1 = Object.fromEntries(open0.map(i => [i.invoice_number, Q.invoiceFinancials(i.id)]));
expect(near(after1[open0[0].invoice_number].balance, 0) && after1[open0[0].invoice_number].status === 'paid', `${open0[0].invoice_number} paid in full`);
expect(near(after1[open0[1].invoice_number].balance, open0[1].balance - Math.round(open0[1].balance / 2)), `${open0[1].invoice_number} part paid, ${after1[open0[1].invoice_number].balance} left`);
expect(open0.slice(2).every(i => near(after1[i.invoice_number].balance, i.balance)), 'later invoices untouched');
const newPays = L.all(`SELECT * FROM invoice_payments ORDER BY rowid DESC LIMIT 2`);
expect(L.val(`SELECT COUNT(*) FROM invoice_payments`) === nPay + 2 && newPays.every(p => p.note === 'versement' && p.paid_at === newPays[0].paid_at && p.paid_at.startsWith(day)), '2 payment rows, same note and time');
const cash1 = L.all(`SELECT * FROM cash_transactions WHERE ref_type = 'invoice_payment' AND ref_id IN (${newPays.map(() => '?').join(',')})`, newPays.map(p => p.id));
expect(L.val(`SELECT COUNT(*) FROM cash_transactions`) === nCash + 2 && cash1.length === 2 && near(cash1.reduce((s, c) => s + c.amount, 0), amt) && cash1.every(c => c.account_id === gnfAcct && c.kind === 'customer_payment'),
  `2 cash lines in the GNF account adding up to ${amt}`);
const st1 = Q.statementLines(toure), todays = st1.filter(e => e.kind === 'payment' && String(e.when).startsWith(day));
expect(todays.length === 1 && near(todays[0].payment, amt) && todays[0].labels.length === 2 && todays[0].notes.join() === 'versement', `statement: one line today for ${amt} over ${todays[0] && todays[0].labels.join(', ')}`);
checkStatement(toure, 'Toure after the payment');

// the rest, in a USD account: converted once, the parts add up to it exactly
const owed1 = KO.openInvoices(toure).reduce((s, i) => s + i.balance, 0);
m = change(() => SO.customerPayOnAccount(toure, { currency_code: 'GNF', pay_in_full: 1, paid_on: day, account_id: usdAcct }));
console.log('     →', m);
expect(KO.openInvoices(toure).length === 0, 'paid in full: no open invoice left');
const rows2 = L.all(`SELECT ip.amount, ct.amount AS posted FROM invoice_payments ip JOIN cash_transactions ct ON ct.ref_type = 'invoice_payment' AND ct.ref_id = ip.id WHERE ct.account_id = ? AND ip.paid_at LIKE ?`, [usdAcct, day + '%']);
const g = Q.rateOn('GNF', day), u = Q.rateOn('USD', day);
const { pyRound } = await import('../js/util.js');
const wantUsd = pyRound(owed1 * g / u, 2);
expect(rows2.length === open0.length - 1 && near(rows2.reduce((s, r) => s + r.amount, 0), owed1) && Math.abs(rows2.reduce((s, r) => s + r.posted, 0) - wantUsd) < 1e-6,
  `${rows2.length} parts, ${owed1} GNF → ${wantUsd} USD in all (${rows2.map(r => r.posted).join(' + ')})`);
checkStatement(toure, 'Toure after paying in full');
expect(Q.statementLines(toure).filter(e => e.kind === 'payment' && String(e.when).startsWith(day)).length === 1, 'both payments of today on one statement line');

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

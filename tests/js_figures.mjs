// The same figures from the new app's code, on data loaded the way the app loads it
// (rows → Firestore bucket documents → the device's SQLite copy).
//    node tests/js_figures.mjs erp.db > new.json
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const L = await import('../js/localdb.js');
const Q = await import('../js/queries.js');
const { TABLES } = await import('../js/schema.js');
const initSqlJs = require('sql.js');
await L.openLocal(initSqlJs, require.resolve('sql.js/dist/sql-wasm.wasm'));
const src = L.openBytes(fs.readFileSync(process.argv[2]));
// rows → buckets (as the importer does) → JSON round trip (as Firestore does) → local copy
const docs = {};
for (const [name, def] of Object.entries(TABLES)) {
  const have = L.withDb(src, () => L.all(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name])).length;
  if (!have) continue;
  const cols = new Set(L.withDb(src, () => L.all(`PRAGMA table_info("${name}")`)).map(r => r.name));
  for (const r of L.withDb(src, () => L.all(`SELECT * FROM "${name}"`))) {
    const k = r[def.key];
    const b = L.bucketOf(name, k);
    const row = {};
    for (const [c] of def.cols) if (c !== def.key) row[c] = cols.has(c) ? r[c] : null;
    ((docs[name] ||= {})[b] ||= {})[String(k)] = row;
  }
}
const wire = JSON.parse(JSON.stringify(docs));
for (const [name, buckets] of Object.entries(wire)) for (const [b, rows] of Object.entries(buckets)) L.replaceBucket(name, b, rows);

const out = {};
out.stock_value = Q.stockValueLanded();
out.all_variant_stock = Q.allVariantStock();
out.cash = Q.totalCashOnHand();
out.products = Object.fromEntries(L.all('SELECT id FROM products').map(p => [String(p.id), Q.variantsForProduct(p.id)]));
out.orders = Object.fromEntries(L.all('SELECT id FROM orders').map(o => [String(o.id), Q.orderTotal(o.id)]));
out.box_lines = Object.fromEntries(L.all('SELECT id FROM orders').map(o => [String(o.id), Q.orderBoxLines(o.id)]));
out.invoices = Object.fromEntries(L.all('SELECT id FROM invoices').map(i => [String(i.id), Q.invoiceFinancials(i.id)]));
out.customers = {};
for (const c of L.all('SELECT id FROM customers')) {
  out.customers[String(c.id)] = { summary: Q.customerSummary(c.id),
    ledger: Q.customerLedger(c.id).map(e => ({ when: e.when, kind: e.kind, order_id: e.order_id, charge: e.charge, payment: e.payment, balance: e.balance, currency_code: e.currency_code, fx: e.fx })),
    buying: Q.customerBuying(c.id), uninvoiced: Q.uninvoicedFulfilled(c.id).length };
}
const d = Q.dashboardFigures();
out.outstanding_total = d.outstanding_total;
out.outstanding_count = d.outstanding_count;
console.log(JSON.stringify(out));

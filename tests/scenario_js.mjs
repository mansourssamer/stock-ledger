// Runs a scenario through the NEW app's operations on the device copy, loaded from a
// database the way the app loads it.   node tests/scenario_js.mjs erp.db scenario.json out.db > log.json
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => 'en', setItem: () => {} };
const L = await import('../js/localdb.js');
const { TABLES } = await import('../js/schema.js');
const S = await import('../js/ops/sales.js');
const K = await import('../js/ops/stock.js');
await L.openLocal(require('sql.js'), require.resolve('sql.js/dist/sql-wasm.wasm'));
const [, , dbIn, scenPath, dbOut] = process.argv;
const src = L.openBytes(fs.readFileSync(dbIn));
const docs = {};
for (const [name, def] of Object.entries(TABLES)) {
  if (!L.withDb(src, () => L.all(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name])).length) continue;
  const cols = new Set(L.withDb(src, () => L.all(`PRAGMA table_info("${name}")`)).map(r => r.name));
  for (const r of L.withDb(src, () => L.all(`SELECT * FROM "${name}"`))) {
    const k = r[def.key], b = L.bucketOf(name, k), row = {};
    for (const [c] of def.cols) if (c !== def.key) row[c] = cols.has(c) ? r[c] : null;
    ((docs[name] ||= {})[b] ||= {})[String(k)] = row;
  }
}
L.batch(() => { for (const [n, bs] of Object.entries(JSON.parse(JSON.stringify(docs)))) for (const [b, rows] of Object.entries(bs)) L.replaceBucket(n, b, rows); });

const names = {};
const val = (sql, p = []) => L.val(sql, p);
function res(v) {
  if (typeof v === 'string' && v.startsWith('$')) {
    const [key, sub] = v.slice(1).split('.');
    const base = names[key];
    if (!sub) return base;
    if (sub === 'line0') return val(`SELECT id FROM order_box_lines WHERE order_id = ? ORDER BY id LIMIT 1`, [base]);
    if (sub === 'item0') return val(`SELECT id FROM order_items WHERE order_id = ? AND box_id IS NULL ORDER BY id LIMIT 1`, [base]);
    if (sub === 'inv') return val(`SELECT id FROM invoices WHERE order_id = ? AND status != 'void' ORDER BY id LIMIT 1`, [base]);
    if (sub === 'pay_last') return val(`SELECT ip.id FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.order_id = ? ORDER BY ip.id DESC LIMIT 1`, [base]);
  }
  return v;
}
const R = a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, res(v)]));
const log = [];
for (const step of JSON.parse(fs.readFileSync(scenPath))) {
  if (Object.values(step.args).some(v => typeof v === 'string' && v.startsWith('$') && (res(v) === null || res(v) === undefined))) {
    log.push({ op: step.op, ok: false, skipped: true }); continue;
  }
  const a = R(step.args);
  let ok = true, result, err = null;
  L.begin();
  try {
    switch (step.op) {
      case 'customerNew': result = K.customerNew(a); break;
      case 'customerEdit': result = K.customerEdit(a.customer, a); break;
      case 'productNew': result = K.productNew(a); break;
      case 'productAddSize': K.productAddSize(a.product, a); result = val(`SELECT id FROM variants ORDER BY id DESC LIMIT 1`); break;
      case 'variantAdjust': K.variantAdjust(a.variant, a); break;
      case 'variantRename': K.variantRename(a.variant, a); break;
      case 'boxOpenOne': K.boxOpenOne(a.po_id, a.label); break;
      case 'orderNew': result = S.orderNew(a); break;
      case 'orderEdit': S.orderEdit(a.order, a); break;
      case 'orderAttachBoxes': S.orderAttachBoxes(a.order, a); break;
      case 'orderAddItem': S.orderAddItem(a.order, a); break;
      case 'orderBoxLineEdit': S.orderBoxLineEdit(a.order, a.line, a); break;
      case 'orderBoxLineDelete': S.orderBoxLineDelete(a.order, a.line); break;
      case 'orderItemEdit': S.orderItemEdit(a.order, a.item, a); break;
      case 'orderFulfill': S.orderFulfill(a.order, a); break;
      case 'orderCancel': S.orderCancel(a.order); break;
      case 'orderDelete': S.orderDelete(a.order); break;
      case 'orderCreateInvoice': S.orderCreateInvoice(a.order); break;
      case 'orderItemReturn': S.orderItemReturn(a.order, a.item, a); break;
      case 'orderBoxLineReturn': S.orderBoxLineReturn(a.order, a.line, a); break;
      case 'invoicePay': S.invoicePay(a.invoice, a); break;
      case 'invoicePaymentDelete': S.invoicePaymentDelete(a.payment); break;
      case 'boxCountFirstOpen': {
        const box = val(`SELECT id FROM boxes WHERE status IN ('open','emptied') ORDER BY opened_at, id LIMIT 1`);
        const it = L.one(`SELECT id, qty_left FROM box_items WHERE box_id = ? AND qty_left > 0 ORDER BY id LIMIT 1`, [box]);
        K.boxCount(box, { [it.id]: String(it.qty_left - a.missing) }); break;
      }
      case 'locationMove': K.locationMove(a); break;
      default: throw new Error('unknown op ' + step.op);
    }
    const touched = L.commitLocal();
    ok = touched.length > 0;
  } catch (e) {
    L.rollback();
    if (!e.user) { console.error(step.op, e); process.exit(2); }
    ok = false; err = e.message;
  }
  if (step.save) names[step.save] = result;
  log.push({ op: step.op, ok, ...(err ? { why: err } : {}) });
}
fs.writeFileSync(dbOut, L.exportBytes());
console.log(JSON.stringify(log));

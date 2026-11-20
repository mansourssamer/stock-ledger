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
const P = await import('../js/ops/purchasing.js');
const F = await import('../js/ops/finance.js');
const C = await import('../js/ops/crm.js');
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
    if (sub === 'line0' && key.startsWith('o')) return val(`SELECT id FROM order_box_lines WHERE order_id = ? ORDER BY id LIMIT 1`, [base]);
    if (sub === 'item0' && key.startsWith('o')) return val(`SELECT id FROM order_items WHERE order_id = ? AND box_id IS NULL ORDER BY id LIMIT 1`, [base]);
    if (sub === 'inv') return val(`SELECT id FROM invoices WHERE order_id = ? AND status != 'void' ORDER BY id LIMIT 1`, [base]);
    if (sub === 'pay_last' && key.startsWith('o')) return val(`SELECT ip.id FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.order_id = ? ORDER BY ip.id DESC LIMIT 1`, [base]);
    // purchasing
    if (sub.startsWith('group:')) return val(`SELECT id FROM po_box_groups WHERE po_id = ? AND label = ?`, [base, sub.slice(6)]);
    if (sub.startsWith('item')) return val(`SELECT pi.id FROM po_items pi JOIN po_box_groups g ON g.id = pi.po_box_group_id WHERE g.po_id = ? ORDER BY pi.id LIMIT 1 OFFSET ?`, [base, Number(sub.slice(4))]);
    if (sub === 'cost0') return val(`SELECT id FROM po_costs WHERE po_id = ? ORDER BY id LIMIT 1`, [base]);
    if (sub === 'cost_last') return val(`SELECT id FROM po_costs WHERE po_id = ? ORDER BY id DESC LIMIT 1`, [base]);
    if (sub === 'pay_last') return val(`SELECT id FROM cash_transactions WHERE ref_type = 'purchase_order' AND ref_id = ? ORDER BY id DESC LIMIT 1`, [base]);
    if (sub === 'ppay_last') return val(`SELECT id FROM partner_ledger WHERE ref_type = 'purchase_order' AND ref_id = ? AND method = 'direct' ORDER BY id DESC LIMIT 1`, [base]);
    if (sub.startsWith('tier:')) { const [, label, n] = sub.split(':'); return val(`SELECT id FROM price_tiers WHERE source_po_id IS ? AND source_label = ? AND min_boxes = ?`, [base, label, Number(n)]); }
    if (sub === 'line0') return val(`SELECT id FROM assortment_lines WHERE assortment_id = ? ORDER BY id LIMIT 1`, [base]);
    if (sub === 'tg_last') return val(`SELECT transfer_group FROM cash_transactions WHERE account_id = ? AND transfer_group IS NOT NULL ORDER BY id DESC LIMIT 1`, [base]);
    if (sub === 'entry_last') return val(`SELECT id FROM partner_ledger WHERE partner_id = ? ORDER BY id DESC LIMIT 1`, [base]);
    if (sub === 'customer') return val(`SELECT customer_id FROM crm_contacts WHERE id = ?`, [base]);
    if (sub === 'act_last') return val(`SELECT id FROM crm_activities WHERE contact_id = ? ORDER BY id DESC LIMIT 1`, [base]);
  }
  if (typeof v === 'string' && v.includes('$')) { const i = v.indexOf('$'); const r = res(v.slice(i)); return r === null || r === undefined ? null : v.slice(0, i) + r; }
  return v;
}
const R = a => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, res(v)]));
const log = [];
for (const step of JSON.parse(fs.readFileSync(scenPath))) {
  if (Object.values(step.args).some(v => typeof v === 'string' && v.includes('$') && (res(v) === null || res(v) === undefined))) {
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
      // purchasing
      case 'supplierNew': P.supplierNew(a); break;
      case 'supplierEdit': P.supplierEdit(a.supplier, a); break;
      case 'supplierDelete': P.supplierDelete(a.supplier); break;
      case 'poNew': P.poNew(a); break;
      case 'poEdit': P.poEdit(a.po, a); break;
      case 'poDelete': P.poDelete(a.po); break;
      case 'poAddItem': P.poAddItem(a.po, a); break;
      case 'poItemEdit': P.poItemEdit(a.po, a.item, a); break;
      case 'poItemDelete': P.poItemDelete(a.po, a.item); break;
      case 'poGroupDelete': P.poGroupDelete(a.po, a.group); break;
      case 'poSetBoxCount': P.poSetBoxCount(a.po, a.group, a); break;
      case 'poTypeRun': P.poTypeRun(a.po, a); break;
      case 'poApplyRun': P.poApplyRun(a.po, a); break;
      case 'poSaveRun': P.poSaveRun(a.po, a.group, a); break;
      case 'assortmentNew': P.assortmentNew(a); break;
      case 'assortmentLineAdd': P.assortmentLineAdd(a.assortment, a); break;
      case 'assortmentLineDelete': P.assortmentLineDelete(a.assortment, a.line); break;
      case 'assortmentDelete': P.assortmentDelete(a.assortment); break;
      case 'poCostNew': P.poCostNew(a.po, a); break;
      case 'poCostEdit': P.poCostEdit(a.po, a.cost, a); break;
      case 'poCostDelete': P.poCostDelete(a.po, a.cost); break;
      case 'poPay': P.poPay(a.po, a); break;
      case 'poPaymentDelete': P.poPaymentDelete(a.po, a.kind, a.entry); break;
      case 'poReceive': P.poReceive(a.po, a); break;
      case 'poGroupReceive': P.poGroupReceive(a.po, a.group, a); break;
      case 'poGroupUnreceive': P.poGroupUnreceive(a.po, a.group); break;
      case 'shipmentNew': P.shipmentNew(a); break;
      case 'shipmentEdit': P.shipmentEdit(a.shipment, a); break;
      case 'shipmentStage': P.shipmentStage(a.shipment, a); break;
      case 'shipmentAssign': P.shipmentAssign(a.shipment, a.group); break;
      case 'shipmentUnassign': P.shipmentUnassign(a.shipment, a.group); break;
      case 'shipmentReceive': P.shipmentReceive(a.shipment, a); break;
      case 'locationNew': P.locationNew(a); break;
      case 'locationEdit': P.locationEdit(a.location, a); break;
      case 'locationsPlace': P.locationsPlace(a); break;
      case 'priceTierSet': P.priceTierSet(a); break;
      case 'priceTierDelete': P.priceTierDelete(a.tier); break;
      // money
      case 'currencyNew': F.currencyNew(a); break;
      case 'rateNew': F.rateNew(a); break;
      case 'rateEdit': F.rateEdit(a.rate, { ...a, rate: a.rate_value }); break;
      case 'rateDelete': F.rateDelete(a.rate); break;
      case 'accountNew': F.accountNew(a); break;
      case 'accountEdit': F.accountEdit(a.account, a); break;
      case 'accountAdjust': F.accountAdjust(a.account, a); break;
      case 'accountTransfer': F.accountTransfer(a); break;
      case 'transferDelete': F.transferDelete(a.group); break;
      case 'partnerNew': F.partnerNew(a); break;
      case 'partnerEdit': F.partnerEdit(a.partner, a); break;
      case 'partnerDelete': F.partnerDelete(a.partner); break;
      case 'partnerLoan': F.partnerLoan(a.partner, a); break;
      case 'partnerRepay': F.partnerRepay(a.partner, a); break;
      case 'partnerEntryDelete': F.partnerEntryDelete(a.entry); break;
      case 'distribute': F.distribute(a); break;
      case 'distributionDelete': F.distributionDelete(a.distribution); break;
      case 'expenseNew': F.expenseNew(a); break;
      case 'expenseEdit': F.expenseEdit(a.expense, { ...a, paid_from: a.paid_from ?? '' }); break;
      case 'expenseDelete': F.expenseDelete(a.expense); break;
      case 'costCorrectionsFix': F.costCorrectionsFix(); break;
      // CRM and proformas
      case 'crmVisit': C.crmReady(); break;
      case 'contactNew': C.crmReady(); C.contactNew(a); break;
      case 'contactEdit': C.contactEdit(a.contact, a); break;
      case 'contactStage': C.contactStage(a.contact, a); break;
      case 'activityAdd': C.activityAdd(a.contact, a); break;
      case 'activityDelete': C.activityDelete(a.activity); break;
      case 'followUp': C.followUp(a.contact, a); break;
      case 'whatsappSent': C.whatsappSent(a.contact, a); break;
      case 'makeCustomer': C.makeCustomer(a.contact); break;
      case 'contactArchive': C.contactArchive(a.contact); break;
      case 'contactDelete': C.contactDelete(a.contact); break;
      case 'zoneNew': C.zoneNew(a); break;
      case 'zoneEdit': C.zoneEdit(a.zone, a); break;
      case 'zoneToggle': C.zoneToggle(a.zone); break;
      case 'zoneDelete': C.zoneDelete(a.zone); break;
      case 'proformaCreate': C.proformaCreate(a.order, a); break;
      case 'proformaVoid': C.proformaVoid(a.proforma); break;
      default: throw new Error('unknown op ' + step.op);
    }
    const touched = L.commitLocal();
    ok = touched.length > 0;
  } catch (e) {
    L.rollback();
    if (!e.user) { console.error(step.op, e); process.exit(2); }
    ok = false; err = e.message;
  }
  if (step.save) {
    const table = { c: 'customers', p: 'products', v: 'variants', o: 'orders', sup: 'suppliers', po: 'purchase_orders', as: 'assortments', loc: 'locations', sh: 'shipments', acc: 'cash_accounts', pt: 'partners', rt: 'exchange_rates', ex: 'expenses', dist: 'distributions', k: 'crm_contacts', z: 'crm_zones', pf: 'proformas' }[step.save.match(/^[a-z]+/)[0]];
    names[step.save] = val(`SELECT id FROM "${table}" ORDER BY id DESC LIMIT 1`);
    void result;
  }
  log.push({ op: step.op, ok, ...(err ? { why: err } : {}) });
}
fs.writeFileSync(dbOut, L.exportBytes());
console.log(JSON.stringify(log));

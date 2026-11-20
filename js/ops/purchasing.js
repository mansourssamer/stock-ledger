// Purchasing: suppliers, purchase orders and their mixes, size runs, landed costs, receiving,
// supplier payments, shipments, locations, documents and the price list — the old app's
// handlers with the same SQL and checks (runs inside store.change()).
import { all, one, val, run, ins } from '../localdb.js';
import * as Q from '../queries.js';
import { t } from '../i18n.js';
import { fmtMoney, fmtUsd, pyRound } from '../util.js';
import { refuse, today, int, num, asId } from './common.js';
import { postCashTransaction } from './money.js';
import { recostPoBoxes } from './costs.js';

const money = (v, c) => fmtMoney(v, c);
const slugify = s => (String(s).trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase()) || 'ITEM';
const hex4 = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0').toUpperCase();
const poRef = id => Q.poRef(id);

// ---------- exchange rates of things that have happened (db.lock_receipt_rates) ----------
export function lockReceiptRates(poId = null) {
  let fixed = 0;
  const w = poId !== null ? 'AND g.po_id = ?' : '', a = poId !== null ? [poId] : [];
  for (const g of all(`SELECT g.id, g.received_at, po.currency_code FROM po_box_groups g JOIN purchase_orders po ON po.id = g.po_id
                       WHERE g.received_at IS NOT NULL AND g.fx_rate_to_usd IS NULL ${w}`, a)) {
    const rate = Q.rateOn(g.currency_code, g.received_at);
    if (rate !== null) { run(`UPDATE po_box_groups SET fx_rate_to_usd = ? WHERE id = ?`, [rate, g.id]); fixed++; }
  }
  const w2 = poId !== null ? 'AND pc.po_id = ?' : '';
  for (const c of all(`SELECT pc.id, pc.currency_code, pc.cost_date, pc.is_actual, pc.created_at,
                         (SELECT MIN(received_at) FROM po_box_groups WHERE po_id = pc.po_id AND received_at IS NOT NULL) as received_at
                       FROM po_costs pc WHERE pc.fx_rate_to_usd IS NULL ${w2}`, a)) {
    let day;
    if (c.is_actual) day = c.cost_date || (c.created_at ? String(c.created_at).slice(0, 10) : null);
    else if (c.received_at !== null) day = c.cost_date || String(c.received_at).slice(0, 10);
    else continue;
    const rate = Q.rateOn(c.currency_code, day);
    if (rate !== null) { run(`UPDATE po_costs SET fx_rate_to_usd = ?, fx_day = ? WHERE id = ?`, [rate, day ? String(day).slice(0, 10) : null, c.id]); fixed++; }
  }
  return fixed;
}
function lockCostLine(costId, day) {
  const r = one(`SELECT currency_code FROM po_costs WHERE id = ?`, [costId]);
  const rate = r ? Q.rateOn(r.currency_code, day) : null;
  if (rate !== null) run(`UPDATE po_costs SET fx_rate_to_usd = ?, fx_day = ? WHERE id = ?`, [rate, day, costId]);
}

// ---------- suppliers ----------
export function supplierNew({ name, email, phone, address }) {
  if (!String(name || '').trim()) refuse('Enter the supplier’s name.');
  ins('suppliers', { name, email: email || null, phone: phone || null, address: address || null });
  return t('Supplier “{n}” added.', { n: name });
}
export function supplierEdit(id, { name, email, phone, address }) {
  if (!String(name || '').trim()) refuse('Enter the supplier’s name.');
  run(`UPDATE suppliers SET name = ?, email = ?, phone = ?, address = ? WHERE id = ?`, [name, email || null, phone || null, address || null, id]);
  return t('Supplier updated.');
}
export function supplierDelete(id) {
  if (val(`SELECT 1 FROM purchase_orders WHERE supplier_id = ? LIMIT 1`, [id])) refuse('Can’t delete this supplier — they have purchase orders on record.');
  run(`DELETE FROM suppliers WHERE id = ?`, [id]);
  return t('Supplier deleted.');
}

// ---------- purchase orders ----------
export function poNew({ supplier_id, notes, currency_code }) {
  return ins('purchase_orders', { supplier_id: asId(supplier_id), notes: notes || null, currency_code: currency_code || 'USD' });
}
export function poEdit(poId, { supplier_id, notes, currency_code }) {
  const existing = one(`SELECT currency_code FROM purchase_orders WHERE id = ?`, [poId]);
  const cur = currency_code || (existing ? existing.currency_code : 'USD');
  run(`UPDATE purchase_orders SET supplier_id = ?, notes = ?, currency_code = ? WHERE id = ?`, [asId(supplier_id), notes ?? null, cur, poId]);
  if (existing && existing.currency_code !== cur) {
    run(`UPDATE po_box_groups SET fx_rate_to_usd = NULL WHERE po_id = ?`, [poId]);
    lockReceiptRates(poId);
  }
  recostPoBoxes(poId, 'Purchase order currency changed');
  return t('Purchase order details updated.');
}
export function updatePoStatus(poId) {
  const r = one(`SELECT COUNT(*) as total, COUNT(CASE WHEN received_at IS NOT NULL THEN 1 END) as received FROM po_box_groups WHERE po_id = ?`, [poId]);
  const status = r.total && r.received === r.total ? 'received' : r.received ? 'partial' : 'draft';
  run(`UPDATE purchase_orders SET status = ? WHERE id = ?`, [status, poId]);
  return status;
}
function getOrMakeGroup(poId, label) {
  const g = one(`SELECT * FROM po_box_groups WHERE po_id = ? AND label = ?`, [poId, label]);
  if (g && g.received_at) return null;
  return g ? g.id : ins('po_box_groups', { po_id: poId, label, box_count: 1 });
}
export function poAddItem(poId, { variant_id, qty, box_label, unit_cost }) {
  const variantId = asId(variant_id), q = int(qty);
  const label = String(box_label || 'Box 1').trim() || 'Box 1';
  const gid = getOrMakeGroup(poId, label);
  if (gid === null) refuse('“{l}” has already been received — use a different mix name for new items.', { l: label });
  const variant = one(`SELECT * FROM variants WHERE id = ?`, [variantId]);
  const product = one(`SELECT * FROM products WHERE id = ?`, [variant.product_id]);
  const cost = unit_cost !== '' && unit_cost !== undefined && unit_cost !== null ? num(unit_cost) : product.cost_price;
  ins('po_items', { po_box_group_id: gid, variant_id: variantId, qty: q, unit_cost: cost });
  return t('Line added to “{l}”.', { l: label });
}
export function poItemEdit(poId, itemId, { qty, unit_cost }) {
  const item = one(`SELECT pi.*, bg.received_at FROM po_items pi JOIN po_box_groups bg ON bg.id = pi.po_box_group_id WHERE pi.id = ?`, [itemId]);
  if (item && item.received_at) refuse('This mix has already been received — it can’t be edited.');
  run(`UPDATE po_items SET qty = ?, unit_cost = ? WHERE id = ?`, [int(qty), num(unit_cost), itemId]);
  return t('Line item updated.');
}
export function poItemDelete(poId, itemId) {
  const item = one(`SELECT pi.*, bg.received_at FROM po_items pi JOIN po_box_groups bg ON bg.id = pi.po_box_group_id WHERE pi.id = ?`, [itemId]);
  if (item && item.received_at) refuse('This mix has already been received — its items can’t be removed.');
  run(`DELETE FROM po_items WHERE id = ?`, [itemId]);
  if (item && val(`SELECT COUNT(*) FROM po_items WHERE po_box_group_id = ?`, [item.po_box_group_id]) === 0) run(`DELETE FROM po_box_groups WHERE id = ?`, [item.po_box_group_id]);
  return t('Line item removed.');
}
export function poGroupDelete(poId, groupId) {
  const g = one(`SELECT * FROM po_box_groups WHERE id = ?`, [groupId]);
  if (g && g.received_at) refuse('This mix has already been received — it can’t be removed.');
  run(`DELETE FROM po_items WHERE po_box_group_id = ?`, [groupId]);
  run(`DELETE FROM po_box_groups WHERE id = ?`, [groupId]);
  return t('Mix removed.');
}
export function poSetBoxCount(poId, groupId, { box_count }) {
  const g = one(`SELECT * FROM po_box_groups WHERE id = ?`, [groupId]);
  if (g && g.received_at) refuse('This mix has already been received — its box count can’t be changed.');
  const n = int(box_count);
  if (n < 1) refuse('Number of boxes must be at least 1.');
  run(`UPDATE po_box_groups SET box_count = ? WHERE id = ?`, [n, groupId]);
  return t('Updated to {n} box(es) with this mix.', { n });
}

// ---------- size runs ----------
export function parseSizeRun(text) {
  const pairs = [], errors = [];
  for (let chunk of String(text || '').split(/[,\n;]+/)) {
    chunk = chunk.trim();
    if (!chunk) continue;
    const m = /^\s*([\w.\-/]+)\s*[x×*:]\s*(\d+)\s*$/i.exec(chunk);
    if (!m || Number(m[2]) <= 0) { errors.push(chunk); continue; }
    pairs.push([m[1], Number(m[2])]);
  }
  return [pairs, errors];
}
function addRunLines(poId, label, productId, color, cost, sizeQty) {
  const gid = getOrMakeGroup(poId, label);
  if (gid === null) return [null, null];
  const product = one(`SELECT * FROM products WHERE id = ?`, [productId]);
  let added = 0, created = 0;
  for (const [size, qty] of sizeQty) {
    const v = one(`SELECT * FROM variants WHERE product_id = ? AND color = ? AND size = ?`, [productId, color, size]);
    let vid;
    if (!v) {
      const parts = [product.sku_prefix];
      if (color) parts.push(slugify(color));
      parts.push(slugify(size));
      let sku = parts.join('-');
      if (val(`SELECT 1 FROM variants WHERE sku = ?`, [sku])) sku = `${sku}-${hex4()}`;
      vid = ins('variants', { product_id: productId, color, size, sku });
      created++;
    } else vid = v.id;
    ins('po_items', { po_box_group_id: gid, variant_id: vid, qty, unit_cost: cost });
    added++;
  }
  return [added, created];
}
export function poTypeRun(poId, { product_id, color, box_label, unit_cost, run: runText }) {
  const pid = asId(product_id);
  const col = String(color || '').trim();
  const label = String(box_label || 'Box 1').trim() || 'Box 1';
  const product = one(`SELECT * FROM products WHERE id = ?`, [pid]);
  const cost = unit_cost !== '' && unit_cost !== undefined && unit_cost !== null ? num(unit_cost) : product.cost_price;
  const [sizeQty, errors] = parseSizeRun(runText);
  if (!sizeQty.length) refuse('Couldn’t read that size run. Use the form 40x2, 41x3, 42x5.');
  const [added, created] = addRunLines(poId, label, pid, col, cost, sizeQty);
  if (added === null) refuse('“{l}” has already been received — use a different mix name.', { l: label });
  let msg = t('Added {a} size(s) to “{l}” — {p} pairs per box.', { a: added, l: label, p: sizeQty.reduce((s, x) => s + x[1], 0) });
  if (created) msg += ' ' + t('Created {n} new size(s) for this style/colour.', { n: created });
  if (errors.length) msg += ' ' + t('Couldn’t read: {e}.', { e: errors.join(', ') });
  return msg;
}
export function poApplyRun(poId, { assortment_id, product_id, color, box_label, unit_cost }) {
  const pid = asId(product_id);
  const col = String(color || '').trim();
  const label = String(box_label || 'Box 1').trim() || 'Box 1';
  const product = one(`SELECT * FROM products WHERE id = ?`, [pid]);
  const cost = unit_cost !== '' && unit_cost !== undefined && unit_cost !== null ? num(unit_cost) : product.cost_price;
  const lines = all(`SELECT * FROM assortment_lines WHERE assortment_id = ? ORDER BY size`, [asId(assortment_id)]);
  const [added, created] = addRunLines(poId, label, pid, col, cost, lines.map(l => [l.size, l.qty]));
  if (added === null) refuse('“{l}” has already been received — use a different mix name.', { l: label });
  let msg = t('Added {a} size(s) to “{l}”.', { a: added, l: label });
  if (created) msg += ' ' + t('Created {n} new size(s) for this style/colour.', { n: created });
  return msg;
}
function setRunLine(aid, size, qty) {    // INSERT OR REPLACE on (assortment, size)
  run(`DELETE FROM assortment_lines WHERE assortment_id = ? AND size = ?`, [aid, size]);
  ins('assortment_lines', { assortment_id: aid, size, qty });
}
export function poSaveRun(poId, groupId, { name }) {
  const n = String(name || '').trim();
  if (!n) refuse('Give the size run a name.');
  const lines = all(`SELECT v.size, SUM(pi.qty) as qty FROM po_items pi JOIN variants v ON v.id = pi.variant_id
                     WHERE pi.po_box_group_id = ? GROUP BY v.size ORDER BY v.size`, [groupId]);
  if (!lines.length) refuse('That mix has no sizes to save.');
  const aid = ins('assortments', { name: n, notes: `Saved from PO #${poRef(poId)}` });
  for (const l of lines) setRunLine(aid, l.size, l.qty);
  return t('Saved “{n}” as a reusable size run ({k} sizes).', { n, k: lines.length });
}
export function assortmentNew({ name, notes, run: runText }) {
  if (!String(name || '').trim()) refuse('Give the size run a name.');
  const aid = ins('assortments', { name, notes: notes || null });
  let added = 0;
  for (let chunk of String(runText || '').split(/[,\n;]+/)) {
    chunk = chunk.trim();
    const m = /^\s*([\w.\-/]+)\s*[x×*:]\s*(\d+)\s*$/i.exec(chunk);
    if (!chunk || !m || Number(m[2]) <= 0) continue;
    setRunLine(aid, m[1], Number(m[2]));
    added++;
  }
  return added ? t('Size run “{n}” created with {a} size(s).', { n: name, a: added }) : t('Size run “{n}” created — now add its sizes.', { n: name });
}
export function assortmentLineAdd(aid, { size, qty }) { setRunLine(aid, String(size).trim(), int(qty)); return t('Size run updated.'); }
export function assortmentLineDelete(aid, lineId) { run(`DELETE FROM assortment_lines WHERE id = ?`, [lineId]); return t('Size removed from run.'); }
export function assortmentDelete(aid) {
  run(`DELETE FROM assortment_lines WHERE assortment_id = ?`, [aid]);
  run(`DELETE FROM assortments WHERE id = ?`, [aid]);
  return t('Size run deleted.');
}

// ---------- landed costs ----------
function recostMsg(base, [boxes, sold, adj]) {
  let msg = base;
  if (boxes) msg += ' ' + t('Re-costed {n} box(es) still in stock.', { n: boxes });
  if (adj) msg += ' ' + t('{a} relating to {n} already-sold pair(s) posted as a cost-of-goods adjustment for this period.', { a: fmtUsd(Math.abs(adj)), n: sold });
  return msg;
}
export function poCostNew(poId, { description, amount, currency_code, cost_date, is_actual }) {
  if (amount === '' || amount === null || amount === undefined || !Number.isFinite(Number(amount))) refuse('Enter the cost line’s amount as a number, e.g. 8,600,000.');
  ins('po_costs', { po_id: poId, description: description || '', amount: Number(amount), currency_code: currency_code || 'USD', cost_date: cost_date || null, is_actual: is_actual ? 1 : 0 });
  lockReceiptRates(poId);
  return recostMsg(t('Cost line added.'), recostPoBoxes(poId, 'Cost line added'));
}
export function poCostEdit(poId, costId, { description, amount, currency_code, cost_date, is_actual }) {
  const before = one(`SELECT currency_code, cost_date, is_actual FROM po_costs WHERE id = ? AND po_id = ?`, [costId, poId]);
  const cur = currency_code || 'USD', day = cost_date || null, act = is_actual ? 1 : 0;
  run(`UPDATE po_costs SET description = ?, amount = ?, currency_code = ?, cost_date = ?, is_actual = ? WHERE id = ? AND po_id = ?`,
    [description || '', Number(amount) || 0.0, cur, day, act, costId, poId]);
  if (before && (before.currency_code !== cur || (before.cost_date || null) !== day || !!before.is_actual !== !!act)) {
    run(`UPDATE po_costs SET fx_rate_to_usd = NULL, fx_day = NULL WHERE id = ?`, [costId]);
    if (act) lockCostLine(costId, day || today());
    else lockReceiptRates(poId);
  }
  return recostMsg(t('Cost line updated.'), recostPoBoxes(poId, 'Cost line updated'));
}
export function poCostDelete(poId, costId) {
  run(`DELETE FROM po_costs WHERE id = ? AND po_id = ?`, [costId, poId]);
  const [boxes] = recostPoBoxes(poId, 'Cost line removed');
  return t('Cost line removed.') + (boxes ? ' ' + t('Re-costed {n} box(es).', { n: boxes }) : '');
}

// ---------- receiving ----------
function defaultLocationId(requested) {
  if (requested !== null && requested !== undefined && requested !== '') return asId(requested);
  const r = one(`SELECT id FROM locations WHERE archived = 0 ORDER BY id LIMIT 1`);
  if (r) return r.id;
  return ins('locations', { name: 'Main warehouse', kind: 'warehouse' });
}
const nextBoxCode = () => `BOX-${String((val(`SELECT MAX(CAST(SUBSTR(box_code, 5) AS INTEGER)) FROM boxes WHERE box_code LIKE 'BOX-%'`) || 0) + 1).padStart(4, '0')}`;
function receiveGroup(poId, group, overhead, locationId) {
  const po = one(`SELECT currency_code FROM purchase_orders WHERE id = ?`, [poId]);
  let fx = Q.rateOn(po ? po.currency_code : 'USD');
  if (fx === null) fx = 1.0;
  const items = all(`SELECT * FROM po_items WHERE po_box_group_id = ?`, [group.id]);
  for (let copy = 1; copy <= group.box_count; copy++) {
    const code = nextBoxCode();
    const note = group.box_count > 1 ? `Copy ${copy} of ${group.box_count} from "${group.label}"` : null;
    const boxId = ins('boxes', { box_code: code, source_po_id: poId, source_label: group.label, notes: note });
    for (const it of items) {
      ins('box_items', { box_id: boxId, variant_id: it.variant_id, qty: it.qty, unit_cost: pyRound(it.unit_cost * fx + overhead, 4) });
      ins('stock_moves', { variant_id: it.variant_id, change_qty: it.qty, reason: 'purchase', ref_type: 'purchase_order', ref_id: poId, note: `Received as ${code}` });
    }
    if (locationId !== null && locationId !== undefined) run(`UPDATE boxes SET location_id = ? WHERE id = ?`, [locationId, boxId]);
  }
  run(`UPDATE po_box_groups SET received_at = datetime('now'), fx_rate_to_usd = ? WHERE id = ?`, [fx, group.id]);
  lockReceiptRates(poId);
  return group.box_count;
}
export function poReceive(poId, { location_id } = {}) {
  const [overhead] = Q.poLandedOverheadPerPair(poId);
  const groups = all(`SELECT * FROM po_box_groups WHERE po_id = ? AND received_at IS NULL`, [poId]);
  const loc = defaultLocationId(location_id);
  let total = 0;
  for (const g of groups) total += receiveGroup(poId, g, overhead, loc);
  updatePoStatus(poId);
  return overhead ? t('Purchase order received — {n} box(es) added to inventory (landed cost: +{o}/pair).', { n: total, o: fmtUsd(overhead) })
    : t('Purchase order received — {n} box(es) added to inventory.', { n: total });
}
export function poGroupReceive(poId, groupId, { location_id } = {}) {
  const g = one(`SELECT * FROM po_box_groups WHERE id = ? AND po_id = ?`, [groupId, poId]);
  if (!g) refuse('Couldn’t find that mix on this purchase order.');
  if (g.received_at) refuse('That mix has already been received.');
  const [overhead] = Q.poLandedOverheadPerPair(poId);
  const n = receiveGroup(poId, g, overhead, defaultLocationId(location_id));
  updatePoStatus(poId);
  return overhead ? t('“{l}” received — {n} box(es) added to inventory (landed cost: +{o}/pair).', { l: g.label, n, o: fmtUsd(overhead) })
    : t('“{l}” received — {n} box(es) added to inventory.', { l: g.label, n });
}
function unreceiveGroup(poId, group, forDelete = false) {
  const boxes = all(`SELECT * FROM boxes WHERE source_po_id = ? AND source_label = ?`, [poId, group.label]);
  const sold = boxes.filter(b => b.status === 'sold');
  if (sold.length) {
    const codes = sold.slice(0, 5).map(b => b.box_code).join(', ') + (sold.length > 5 ? ' ' + t('and {n} more', { n: sold.length - 5 }) : '');
    return [false, t(forDelete ? 'Can’t delete this purchase order — mix “{l}” has {n} box(es) already sold ({c}). Correct the landed cost instead, which adjusts cost of goods without rewriting the sale.'
      : 'Can’t un-receive “{l}” — {n} of its boxes have already been sold ({c}). Correct the landed cost instead, which adjusts cost of goods without rewriting the sale.', { l: group.label, n: sold.length, c: codes })];
  }
  if (val(`SELECT COUNT(*) FROM order_items oi JOIN boxes b ON b.id = oi.box_id WHERE b.source_po_id = ? AND b.source_label = ?`, [poId, group.label])) {
    return [false, t(forDelete ? 'Can’t delete this purchase order — some boxes of mix “{l}” are attached to an order. Remove them from that order first.'
      : 'Can’t un-receive “{l}” — some of its boxes are attached to an order. Remove them from that order first.', { l: group.label })];
  }
  for (const b of boxes) {
    run(`DELETE FROM stock_moves WHERE ref_type = 'purchase_order' AND ref_id = ? AND note = ?`, [poId, `Received as ${b.box_code}`]);
    run(`DELETE FROM box_moves WHERE box_id = ?`, [b.id]);
    run(`DELETE FROM box_items WHERE box_id = ?`, [b.id]);
    run(`DELETE FROM boxes WHERE id = ?`, [b.id]);
  }
  run(`UPDATE po_box_groups SET received_at = NULL, fx_rate_to_usd = NULL WHERE id = ?`, [group.id]);
  if (!val(`SELECT 1 FROM po_box_groups WHERE po_id = ? AND received_at IS NOT NULL`, [poId])) {
    run(`UPDATE po_costs SET fx_rate_to_usd = NULL, fx_day = NULL WHERE po_id = ? AND is_actual = 0`, [poId]);
  }
  run(`UPDATE purchase_orders SET status = 'draft' WHERE id = ?`, [poId]);
  return [true, t('Un-received “{l}” — {n} box(es) removed from inventory and their stock reversed. The mix is editable again.', { l: group.label, n: boxes.length })];
}
export function poGroupUnreceive(poId, groupId) {
  const g = one(`SELECT * FROM po_box_groups WHERE id = ? AND po_id = ?`, [groupId, poId]);
  if (!g) refuse('Couldn’t find that mix on this purchase order.');
  if (!g.received_at) refuse('That mix hasn’t been received yet.');
  const [ok, msg] = unreceiveGroup(poId, g);
  if (!ok) refuse(msg);
  return msg;
}
export function poDelete(poId) {
  const po = one(`SELECT * FROM purchase_orders WHERE id = ?`, [poId]);
  if (!po) refuse('That purchase order no longer exists.');
  for (const g of all(`SELECT * FROM po_box_groups WHERE po_id = ? AND received_at IS NOT NULL`, [poId])) {
    const [ok, msg] = unreceiveGroup(poId, g, true);
    if (!ok) refuse(msg);
  }
  for (const r of all(`SELECT id FROM po_box_groups WHERE po_id = ?`, [poId])) run(`DELETE FROM po_items WHERE po_box_group_id = ?`, [r.id]);
  run(`DELETE FROM po_box_groups WHERE po_id = ?`, [poId]);
  run(`DELETE FROM po_costs WHERE po_id = ?`, [poId]);
  run(`DELETE FROM stock_moves WHERE ref_type = 'purchase_order' AND ref_id = ?`, [poId]);
  run(`DELETE FROM cogs_adjustments WHERE po_id = ?`, [poId]);
  run(`UPDATE partner_ledger SET ref_type = NULL, ref_id = NULL WHERE ref_type = 'purchase_order' AND ref_id = ?`, [poId]);
  run(`UPDATE documents SET po_id = NULL WHERE po_id = ?`, [poId]);
  run(`UPDATE cash_transactions SET ref_type = NULL, ref_id = NULL WHERE ref_type = 'purchase_order' AND ref_id = ?`, [poId]);
  run(`DELETE FROM purchase_orders WHERE id = ?`, [poId]);
  return t('Purchase order deleted, along with any boxes it had put into inventory.');
}

// ---------- paying the supplier (an account, or a partner from their own pocket) ----------
export function parsePaidFrom(v) {
  if (!v) return [null, null];
  const s = String(v);
  if (s.includes(':')) { const [k, i] = s.split(/:(.*)/s); return [k === 'partner' ? 'partner' : 'account', asId(i)]; }
  return ['account', asId(s)];
}
export function settlementFrom({ settled_amount, settled_currency }, accountCurrency, day) {
  const raw = String(settled_amount ?? '').trim();
  if (!raw) return [null, null];
  const amt = Number(raw);
  if (!Number.isFinite(amt) || amt <= 0) return [null, t('Enter what they received as a number greater than zero.')];
  const cur = settled_currency || 'USD';
  if (cur === accountCurrency) return [null, null];
  const fx = Q.rateOn(cur, day);
  if (fx === null) return [null, t('Set an exchange rate for {c} first (Currencies page).', { c: cur })];
  return [[amt, cur, fx], null];
}
export const markSettled = (txnId, s) => run(`UPDATE cash_transactions SET settled_amount = ?, settled_currency = ?, settled_fx_rate = ? WHERE id = ?`, [s[0], s[1], s[2], txnId]);
export function settlementResult(txnId) {
  const r = one(`SELECT amount, fx_rate_to_usd, settled_amount, settled_fx_rate FROM cash_transactions WHERE id = ?`, [txnId]);
  if (!r || r.settled_amount === null) return 0.0;
  const cash = r.amount * (r.fx_rate_to_usd || 1), settled = r.settled_amount * (r.settled_fx_rate || 1);
  return r.amount < 0 ? settled + cash : cash - settled;
}
export const exchangePhrase = r => Math.abs(r) < 0.005 ? t('no exchange difference against your rate')
  : t(r > 0 ? 'exchange gain of {a} against your rate' : 'exchange loss of {a} against your rate', { a: fmtUsd(Math.abs(r)) });
export function recordDirectPartnerPayment(partnerId, amount, currency, occurredOn, refType, refId, description) {
  const rate = Q.rateOn(currency, occurredOn);
  ins('partner_ledger', { partner_id: partnerId, kind: 'loan', amount, currency_code: currency, fx_rate_to_usd: rate !== null ? rate : 1.0,
    occurred_on: occurredOn || today(), method: 'direct', ref_type: refType, ref_id: refId, description });
  return rate !== null;
}
export function poPay(poId, f) {
  const [kind, ident] = parsePaidFrom(f.paid_from || f.account_id);
  if (!kind) refuse('Pick who paid — an account, or a partner paying directly.');
  const amount = f.amount === '' || f.amount === null || f.amount === undefined ? null : Number(f.amount);
  if (amount === null || !Number.isFinite(amount) || amount <= 0) refuse('Enter the payment amount, as a number greater than zero. Nothing was recorded.');
  const sup = val(`SELECT s.name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`, [poId]);
  const when = f.occurred_on || null;
  const detail = `PO #${poRef(poId)}${sup ? ' — ' + sup : ''}${f.note ? ' — ' + f.note : ''}`;
  if (kind === 'partner') {
    const partner = one(`SELECT * FROM partners WHERE id = ?`, [ident]);
    const cur = f.direct_currency || 'USD';
    if (Q.rateOn(cur, when) === null) refuse('Set an exchange rate for {c} first.', { c: cur });
    recordDirectPartnerPayment(ident, amount, cur, when, 'purchase_order', poId, `Paid ${detail}`);
    return t('Recorded {a} paid directly by {p} — added to what the business owes them.', { a: money(amount, cur), p: partner.name });
  }
  const acct = one(`SELECT * FROM cash_accounts WHERE id = ?`, [ident]);
  const [settle, err] = settlementFrom(f, acct.currency_code, when);
  if (err) refuse('{e} Nothing was recorded.', { e: err });
  const txn = postCashTransaction(ident, -amount, 'supplier_payment', { occurredOn: when, description: `Payment for ${detail}`, refType: 'purchase_order', refId: poId });
  let msg = t('Recorded supplier payment of {a} from {acc}', { a: money(amount, acct.currency_code), acc: acct.name });
  if (settle) {
    markSettled(txn, settle);
    msg += ' ' + t('— the supplier received {s}, {x}', { s: money(settle[0], settle[1]), x: exchangePhrase(settlementResult(txn)) });
  }
  return msg + '.';
}
export function poPaymentDelete(poId, kind, entryId) {
  if (kind === 'cash') {
    const r = one(`SELECT t.amount, a.name, a.currency_code FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id
                   WHERE t.id = ? AND t.ref_type = 'purchase_order' AND t.ref_id = ?`, [entryId, poId]);
    if (!r) refuse('That payment no longer exists.');
    if (val(`SELECT 1 FROM partner_ledger WHERE cash_transaction_id = ?`, [entryId])) refuse('That entry belongs to a partner loan — remove it from the partner’s page instead.');
    run(`DELETE FROM cash_transactions WHERE id = ?`, [entryId]);
    return t('Payment removed — {a} put back into {acc}.', { a: money(-r.amount, r.currency_code), acc: r.name });
  }
  const r = one(`SELECT l.amount, l.currency_code, p.name FROM partner_ledger l JOIN partners p ON p.id = l.partner_id
                 WHERE l.id = ? AND l.ref_type = 'purchase_order' AND l.ref_id = ? AND l.method = 'direct'`, [entryId, poId]);
  if (!r) refuse('That payment no longer exists.');
  run(`DELETE FROM partner_ledger WHERE id = ?`, [entryId]);
  return t('Payment removed — {a} taken off what the business owes {p}.', { a: money(r.amount, r.currency_code), p: r.name });
}

// ---------- shipments ----------
export const SHIPMENT_STAGES = [['preparing', 'Preparing', null], ['shipped', 'Shipped', 'shipped_at'], ['arrived', 'Arrived at port', 'arrived_at'],
  ['cleared', 'Cleared customs', 'cleared_at'], ['received', 'Received into stock', 'received_at']];
export function shipmentNew(f) {
  if (!String(f.reference || '').trim()) refuse('Enter a reference for the shipment.');
  return ins('shipments', { reference: f.reference, container_no: f.container_no || null, bl_number: f.bl_number || null, vessel: f.vessel || null, eta: f.eta || null, notes: f.notes || null });
}
export function shipmentEdit(id, f) {
  run(`UPDATE shipments SET reference = ?, container_no = ?, bl_number = ?, vessel = ?, eta = ?, notes = ? WHERE id = ?`,
    [f.reference, f.container_no || null, f.bl_number || null, f.vessel || null, f.eta || null, f.notes || null, id]);
  return t('Shipment updated.');
}
export function shipmentStage(id, { status, when }) {
  const st = SHIPMENT_STAGES.find(s => s[0] === status);
  if (!st) refuse('Unknown shipment stage.');
  const day = when || today();
  if (st[2]) run(`UPDATE shipments SET status = ?, ${st[2]} = ? WHERE id = ?`, [status, day, id]);
  else run(`UPDATE shipments SET status = ? WHERE id = ?`, [status, id]);
  return t('Shipment marked “{s}”.', { s: t(st[1]) });
}
export function shipmentAssign(id, groupId) { run(`UPDATE po_box_groups SET shipment_id = ? WHERE id = ?`, [id, groupId]); return t('Mix added to this shipment.'); }
export function shipmentUnassign(id, groupId) { run(`UPDATE po_box_groups SET shipment_id = NULL WHERE id = ?`, [groupId]); return t('Mix removed from this shipment.'); }
export function shipmentReceive(id, { location_id } = {}) {
  let loc = location_id !== undefined && location_id !== null && location_id !== '' ? asId(location_id) : null;
  if (loc === null) loc = defaultLocationId(null);
  const groups = all(`SELECT * FROM po_box_groups WHERE shipment_id = ? AND received_at IS NULL`, [id]);
  if (!groups.length) refuse('Nothing left to receive on this shipment.');
  let total = 0;
  for (const g of groups) {
    const [overhead] = Q.poLandedOverheadPerPair(g.po_id);
    total += receiveGroup(g.po_id, g, overhead, loc);
    updatePoStatus(g.po_id);
  }
  run(`UPDATE shipments SET status = 'received', received_at = COALESCE(received_at, date('now')) WHERE id = ?`, [id]);
  return t('Shipment received — {n} box(es) added to inventory.', { n: total });
}

// ---------- locations ----------
export function locationNew({ name, kind, parent_id, notes }) {
  if (!String(name || '').trim()) refuse('Enter a name for the location.');
  ins('locations', { name, kind: kind || 'warehouse', parent_id: asId(parent_id), notes: notes || null });
  return t('Location “{n}” added.', { n: name });
}
export function locationEdit(id, { name, kind, parent_id, notes, archived }) {
  const p = asId(parent_id);
  run(`UPDATE locations SET name = ?, kind = ?, parent_id = ?, notes = ?, archived = ? WHERE id = ?`,
    [name, kind || 'warehouse', p !== null && p !== id ? p : null, notes || null, archived ? 1 : 0, id]);
  return t('Location updated.');
}
export function locationsPlace({ to_location_id, label, po_id }) {
  const to = asId(to_location_id);
  let where = `b.status = 'in_stock' AND (b.location_id IS NULL OR b.location_id NOT IN (SELECT id FROM locations))`;
  const p = [];
  if (label !== undefined && label !== null && label !== '__all__') { where += ` AND b.source_label = ? AND b.source_po_id IS ?`; p.push(label, asId(po_id)); }
  const boxes = all(`SELECT b.id FROM boxes b WHERE ${where}`, p);
  for (const b of boxes) {
    run(`UPDATE boxes SET location_id = ? WHERE id = ?`, [to, b.id]);
    ins('box_moves', { box_id: b.id, from_location_id: null, to_location_id: to, note: 'Filed from unplaced' });
  }
  return t('Placed {n} box(es) into {l}.', { n: boxes.length, l: val(`SELECT name FROM locations WHERE id = ?`, [to]) });
}

// ---------- documents (the file itself is saved first, in its own document) ----------
export function documentAdd({ po_id, shipment_id, filename, original_name, doc_type, notes }) {
  ins('documents', { po_id: asId(po_id), shipment_id: asId(shipment_id), filename, original_name, doc_type: doc_type || null, notes: notes || null });
  return t('Uploaded “{n}”.', { n: original_name });
}
export function documentDelete(id) { run(`DELETE FROM documents WHERE id = ?`, [id]); return t('Document removed.'); }

// ---------- price list ----------
export function priceTierSet({ po_id, label, price_per_pair, min_boxes, currency_code, notes }) {
  const poId = asId(po_id);
  const price = Number(price_per_pair);
  if (!Number.isFinite(price) || price <= 0) refuse('Enter the price per pair as a number greater than zero. Nothing was changed.');
  const rawMin = String(min_boxes ?? '1').trim() || '1';
  if (!/^\d+$/.test(rawMin) || Number(rawMin) < 1) refuse('Enter the number of boxes as a whole number (2 or more). Nothing was changed.');
  const minB = Number(rawMin);
  const tiers = all(`SELECT * FROM price_tiers WHERE source_po_id IS ? AND source_label = ? ORDER BY min_boxes`, [poId, label]);
  const base = tiers.find(x => x.min_boxes === 1);
  let cur;
  if (minB === 1) {
    cur = currency_code || (base ? base.currency_code : 'GNF');
    const others = tiers.filter(x => x.min_boxes > 1);
    if (others.length && others[0].currency_code !== cur) refuse('This mix’s quantity prices are in {c}. Keep the same currency, or remove them first. Nothing was changed.', { c: others[0].currency_code });
  } else {
    if (!base) refuse('Set the 1-box price first, then add prices for larger quantities. Nothing was changed.');
    cur = base.currency_code;
  }
  const existing = tiers.find(x => x.min_boxes === minB);
  if (existing) run(`UPDATE price_tiers SET price_per_pair = ?, currency_code = ?, notes = ? WHERE id = ?`, [price, cur, notes || existing.notes, existing.id]);
  else ins('price_tiers', { source_po_id: poId, source_label: label, min_boxes: minB, price_per_pair: price, currency_code: cur, notes: notes || null });
  if (minB === 1) return t('1-box price for “{l}” set to {p}/pair.', { l: label, p: money(price, cur) });
  let msg = t('“{l}”: from {n} boxes, {p}/pair.', { l: label, n: minB, p: money(price, cur) });
  const below = all(`SELECT * FROM price_tiers WHERE source_po_id IS ? AND source_label = ? ORDER BY min_boxes`, [poId, label]).filter(x => x.min_boxes < minB);
  if (below.length && price >= below[below.length - 1].price_per_pair) msg += ' ' + t('Note: that isn’t lower than the price from {n} box(es) ({p}).', { n: below[below.length - 1].min_boxes, p: money(below[below.length - 1].price_per_pair, cur) });
  return msg;
}
export function priceTierDelete(id) {
  const tr = one(`SELECT * FROM price_tiers WHERE id = ?`, [id]);
  if (!tr) refuse('That price no longer exists.');
  if (tr.min_boxes === 1 && val(`SELECT 1 FROM price_tiers WHERE source_po_id IS ? AND source_label = ? AND min_boxes > 1`, [tr.source_po_id, tr.source_label])) refuse('Remove the quantity prices first — they’re based on the 1-box price. Nothing was changed.');
  run(`DELETE FROM price_tiers WHERE id = ?`, [id]);
  return tr.min_boxes === 1 ? t('1-box price cleared.') : t('Price from {n} boxes removed.', { n: tr.min_boxes });
}

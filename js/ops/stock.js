// Products, sizes, customers and box actions (open, reseal, count, delete, move) —
// the old app's handlers with the same SQL and checks.
import { all, one, val, run, ins } from '../localdb.js';
import * as Q from '../queries.js';
import { t } from '../i18n.js';
import { fmtUsd } from '../util.js';
import { refuse, int, num, asId } from './common.js';
import { variantName, closeIfEmpty } from './sales.js';

const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const slugify = s => (String(s).trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase()) || 'ITEM';
const hex4 = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0').toUpperCase();

// ---------- products and sizes ----------
export function productNew({ sku_prefix, name, brand, category, cost_price, sale_price, reorder_level, image }) {
  if (!String(name || '').trim()) refuse('Enter the style name.');
  const prefix = String(sku_prefix || '').trim().toUpperCase();
  if (!prefix) refuse('Enter a code for this style (for example AF-WB).');
  if (val(`SELECT 1 FROM products WHERE sku_prefix = ?`, [prefix])) refuse('The code {c} is already used by another style.', { c: prefix });
  return ins('products', { sku_prefix: prefix, name: String(name).trim(), brand: brand || null, category: category || null,
    cost_price: num(cost_price), sale_price: num(sale_price), reorder_level: int(reorder_level || 0, 'reorder level'), image_filename: image || null });
}

export function productEdit(productId, { sku_prefix, name, brand, category, cost_price, sale_price, reorder_level, image, remove_image }) {
  const p = one(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!p) refuse('That style no longer exists.');
  const prefix = String(sku_prefix || '').trim().toUpperCase();
  if (!prefix || !String(name || '').trim()) refuse('Enter the style name and its code.');
  if (val(`SELECT 1 FROM products WHERE sku_prefix = ? AND id != ?`, [prefix, productId])) refuse('The code {c} is already used by another style.', { c: prefix });
  let img = p.image_filename;
  if (remove_image) img = null;
  if (image) img = image;
  run(`UPDATE products SET sku_prefix = ?, name = ?, brand = ?, category = ?, cost_price = ?, sale_price = ?, reorder_level = ?, image_filename = ? WHERE id = ?`,
    [prefix, String(name).trim(), brand || null, category || null, num(cost_price), num(sale_price), int(reorder_level || 0, 'reorder level'), img, productId]);
  return t('Style updated.');
}

export function productAddSize(productId, { size, color, initial_qty }) {
  const p = one(`SELECT * FROM products WHERE id = ?`, [productId]);
  const sz = String(size || '').trim();
  const col = String(color || '').trim();
  if (!sz) refuse('Enter the size.');
  const label = `${col} ${sz}`.trim();
  if (one(`SELECT * FROM variants WHERE product_id = ? AND color = ? AND size = ?`, [productId, col, sz])) refuse('{l} already exists for this style — use “Adjust stock” next to it instead.', { l: label });
  const parts = [p.sku_prefix];
  if (col) parts.push(slugify(col));
  parts.push(slugify(sz));
  let sku = parts.join('-');
  if (val(`SELECT 1 FROM variants WHERE sku = ?`, [sku])) sku = `${sku}-${hex4()}`;
  const vid = ins('variants', { product_id: productId, color: col, size: sz, sku });
  const q = int(initial_qty || 0);
  if (q) ins('stock_moves', { variant_id: vid, change_qty: q, reason: 'initial', note: 'Opening stock' });
  return t('{l} added.', { l: label });
}

export function variantAdjust(variantId, { delta, note }) {
  const d = int(delta);
  if (!d) refuse('Enter how many pairs to add (or a minus number to remove).');
  ins('stock_moves', { variant_id: variantId, change_qty: d, reason: 'adjustment', note: note || 'Manual adjustment' });
  return t('Stock adjusted.');
}

export function variantRename(variantId, { size, color }) {
  const v = one(`SELECT * FROM variants WHERE id = ?`, [variantId]);
  const sz = String(size || '').trim(), col = String(color || '').trim();
  if (!sz) refuse('Enter the size.');
  if (one(`SELECT * FROM variants WHERE product_id = ? AND color = ? AND size = ? AND id != ?`, [v.product_id, col, sz, variantId])) refuse('{l} already exists for this style.', { l: `${col} ${sz}`.trim() });
  run(`UPDATE variants SET color = ?, size = ? WHERE id = ?`, [col, sz, variantId]);
  return t('Updated to {l}. (Its code stays the same.)', { l: `${col} ${sz}`.trim() });
}

export function variantDelete(variantId) {
  const v = one(`SELECT * FROM variants WHERE id = ?`, [variantId]);
  if (!v) refuse('That size no longer exists.');
  if (val(`SELECT 1 FROM order_items WHERE variant_id = ? LIMIT 1`, [variantId]) || val(`SELECT 1 FROM po_items WHERE variant_id = ? LIMIT 1`, [variantId]) || val(`SELECT 1 FROM box_items WHERE variant_id = ? LIMIT 1`, [variantId])) {
    refuse('Can’t delete this size — it’s used by an order, purchase order, or box. Adjust its stock to 0 and leave it in place instead.');
  }
  run(`DELETE FROM stock_moves WHERE variant_id = ?`, [variantId]);
  run(`DELETE FROM variants WHERE id = ?`, [variantId]);
  return t('Size deleted.');
}

// ---------- customers ----------
function creditLimit(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) refuse('Enter the credit limit as a number, e.g. 50 000 000 — or leave it empty for no limit.');
  return n || null;
}
export function customerNew({ name, email, phone, address, discount_percent, credit_limit, credit_currency }) {
  if (!String(name || '').trim()) refuse('Enter the customer’s name.');
  const limit = creditLimit(credit_limit);
  const id = ins('customers', { name: String(name).trim(), email: email || null, phone: phone || null, address: address || null,
    discount_percent: num(discount_percent || 0), credit_limit: limit, credit_currency: limit ? (credit_currency || 'GNF') : null });
  return id;
}
export function customerEdit(customerId, { name, email, phone, address, discount_percent, credit_limit, credit_currency }) {
  if (!String(name || '').trim()) refuse('Enter the customer’s name.');
  const limit = creditLimit(credit_limit);
  run(`UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, discount_percent = ?, credit_limit = ?, credit_currency = ? WHERE id = ?`,
    [String(name).trim(), email || null, phone || null, address || null, num(discount_percent || 0), limit, limit ? (credit_currency || 'GNF') : null, customerId]);
  return t('Customer updated.');
}
export function customerDelete(customerId) {
  if (val(`SELECT 1 FROM orders WHERE customer_id = ? LIMIT 1`, [customerId])) refuse('Can’t delete this customer — they have orders on record.');
  run(`UPDATE crm_contacts SET customer_id = NULL WHERE customer_id = ?`, [customerId]);
  run(`UPDATE missed_sales SET customer_id = NULL WHERE customer_id = ?`, [customerId]);
  run(`DELETE FROM customers WHERE id = ?`, [customerId]);
  return t('Customer deleted.');
}
// app._open_invoices — a customer's invoices still owed, oldest first.
export function openInvoices(customerId) {
  return all(`SELECT i.id, i.invoice_number, i.issued_at, i.order_id FROM invoices i JOIN orders o ON o.id = i.order_id
              WHERE o.customer_id = ? AND i.status != 'void' ORDER BY i.issued_at, i.id`, [customerId])
    .map(i => ({ ...i, ...Q.invoiceFinancials(i.id) })).filter(i => (i.status === 'unpaid' || i.status === 'partial') && i.balance > 0.004);
}

// ---------- boxes ----------
export function boxDelete(boxId) {
  const box = one(`SELECT * FROM boxes WHERE id = ?`, [boxId]);
  if (!box) refuse('That box no longer exists.');
  if (box.status === 'open' || box.status === 'emptied') refuse('This box has been opened to sell pairs — it can’t be deleted. Count it instead if pairs are missing.');
  if (box.status === 'sold') refuse('Can’t delete {c} — it’s already been sold. Cancel or delete the order it went out on first, which releases the box back to stock.', { c: box.box_code });
  if (val(`SELECT COUNT(*) FROM order_items WHERE box_id = ?`, [boxId])) refuse('Can’t delete {c} — it’s attached to an order. Remove it from that order first.', { c: box.box_code });
  run(`DELETE FROM box_items WHERE box_id = ?`, [boxId]);
  run(`DELETE FROM stock_moves WHERE ref_type = 'purchase_order' AND ref_id = ? AND note = ?`, [box.source_po_id, `Received as ${box.box_code}`]);
  run(`DELETE FROM boxes WHERE id = ?`, [boxId]);
  return t('{c} deleted and its stock reversed.', { c: box.box_code });
}

function openBox(boxId) {
  run(`UPDATE boxes SET status = 'open', opened_at = ? WHERE id = ? AND status = 'in_stock'`, [nowStamp(), boxId]);
  run(`UPDATE box_items SET qty_left = qty WHERE box_id = ?`, [boxId]);
}
export function boxOpen(boxId) {
  const box = one(`SELECT * FROM boxes WHERE id = ?`, [boxId]);
  if (!box || box.status !== 'in_stock') refuse('Only a sealed box in stock can be opened.');
  openBox(boxId);
  const pairs = val(`SELECT COALESCE(SUM(qty), 0) FROM box_items WHERE box_id = ?`, [boxId]);
  return t('{c} opened — its {n} pairs can now be sold one by one.', { c: box.box_code, n: pairs });
}
export function boxOpenOne(poId, label) {
  const box = one(`SELECT * FROM boxes WHERE source_po_id = ? AND source_label = ? AND status = 'in_stock' ORDER BY received_at, id LIMIT 1`, [asId(poId), label]);
  if (!box) refuse('No sealed box of “{l}” left to open.', { l: label });
  openBox(box.id);
  return t('{c} ({l}) opened — its pairs can now be sold one by one.', { c: box.box_code, l: label });
}
export function boxReseal(boxId) {
  const box = one(`SELECT * FROM boxes WHERE id = ?`, [boxId]);
  if (!box || box.status !== 'open') refuse('Only an open box can be sealed again.');
  const items = all(`SELECT variant_id, qty, qty_left FROM box_items WHERE box_id = ?`, [boxId]);
  if (items.some(i => (i.qty_left || 0) !== i.qty)) refuse('Pairs have already gone from this box — it can’t be sealed again.');
  const avail = Q.pairsAvailable();
  const held = items.filter(i => ((avail.get(i.variant_id) || {}).available || 0) < i.qty);
  if (held.length) refuse('Orders not yet delivered are counting on pairs from this box ({v}) — deliver or change them first.', { v: held.map(i => variantName(i.variant_id)).join(', ') });
  run(`UPDATE boxes SET status = 'in_stock', opened_at = NULL WHERE id = ?`, [boxId]);
  run(`UPDATE box_items SET qty_left = NULL WHERE box_id = ?`, [boxId]);
  return t('{c} sealed again — it’s a full box for box sales.', { c: box.box_code });
}
// counted: {box_item_id: pairs counted} for the sizes counted.
export function boxCount(boxId, counted) {
  const box = one(`SELECT * FROM boxes WHERE id = ?`, [boxId]);
  if (!box || (box.status !== 'open' && box.status !== 'emptied')) refuse('Only an open box can be counted.');
  const items = all(`SELECT * FROM box_items WHERE box_id = ?`, [boxId]);
  const changes = [], errors = [];
  for (const i of items) {
    const raw = String(counted[i.id] ?? counted[String(i.id)] ?? '').trim();
    if (raw === '') continue;
    const c = Number(raw);
    if (!Number.isInteger(c)) { errors.push(t('{v}: enter a whole number', { v: variantName(i.variant_id) })); continue; }
    const left = i.qty_left || 0;
    if (c < 0 || c > left) { errors.push(t('{v}: count between 0 and {l}', { v: variantName(i.variant_id), l: left })); continue; }
    if (c < left) changes.push([i, left - c]);
  }
  if (errors.length) refuse('Not saved — {e}.', { e: errors.join('; ') });
  const now = nowStamp();
  let loss = 0, missing = 0;
  for (const [i, m] of changes) {
    run(`UPDATE box_items SET qty_left = qty_left - ? WHERE id = ?`, [m, i.id]);
    ins('stock_moves', { variant_id: i.variant_id, change_qty: -m, reason: 'adjustment', ref_type: 'box_count', ref_id: boxId, note: `Counted: ${m} pair(s) missing in ${box.box_code}`, created_at: now });
    ins('pair_picks', { kind: 'count', box_id: boxId, variant_id: i.variant_id, qty: m, unit_cost: i.unit_cost, created_at: now });
    loss += m * i.unit_cost;
    missing += m;
  }
  closeIfEmpty(boxId);
  return changes.length ? t('Count saved: {n} pair(s) missing — {l} of stock booked as a loss.', { n: missing, l: fmtUsd(loss) }) : t('Count saved — everything is there.');
}

export function locationMove({ from_location_id, to_location_id, po_id, label, qty, note }) {
  const from = asId(from_location_id), to = asId(to_location_id), poId = asId(po_id);
  const q = int(qty);
  if (from === to) refuse('Pick two different locations.');
  const boxes = all(`SELECT * FROM boxes WHERE location_id IS ? AND source_po_id IS ? AND source_label = ? AND status = 'in_stock' ORDER BY received_at, id LIMIT ?`, [from, poId, label, q]);
  if (boxes.length < q) refuse('Only {n} box(es) of “{l}” are here — asked to move {q}.', { n: boxes.length, l: label, q });
  for (const b of boxes) {
    run(`UPDATE boxes SET location_id = ? WHERE id = ?`, [to, b.id]);
    ins('box_moves', { box_id: b.id, from_location_id: from, to_location_id: to, note: note || null });
  }
  const toName = val(`SELECT name FROM locations WHERE id = ?`, [to]);
  return t('Moved {q} box(es) of “{l}” to {to}.', { q, l: label, to: toName });
}

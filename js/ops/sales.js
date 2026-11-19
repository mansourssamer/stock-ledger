// Selling: orders, box sales and loose pairs, delivery, cancelling, returns, invoices and
// payments. Each function is one of the old app's form handlers, with the same SQL and the
// same checks; it runs inside store.change(), so a refusal leaves nothing behind.
// Returns the message to show (the old app's flash), in the screen's language.
import { all, one, val, run, ins } from '../localdb.js';
import * as Q from '../queries.js';
import { t } from '../i18n.js';
import { fmtMoney, fmtUsd, pyRound } from '../util.js';
import { refuse, formDay, stamp, today, int, num, asId } from './common.js';
import { postCashTransaction } from './money.js';
import { recostPoBoxes } from './costs.js';

const money = (v, code) => fmtMoney(v, code);

// ---------- orders ----------
export function orderNew({ customer_id, notes, currency_code, order_date }) {
  const [day, err] = formDay(order_date);
  if (err) refuse('Order date: {err} The order wasn’t created.', { err });
  return ins('orders', { customer_id: asId(customer_id), notes: notes || null, currency_code: currency_code || 'USD', created_at: stamp(day) });
}

export function orderEdit(orderId, { customer_id, notes, currency_code, order_date, delivered_on }) {
  const order = one(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) refuse('That order no longer exists.');
  const customerId = asId(customer_id);
  const currency = currency_code || order.currency_code;
  let createdAt = order.created_at;
  let raw = String(order_date || '').trim();
  if (raw && raw !== String(createdAt || '').slice(0, 10)) {
    const [day, err] = formDay(raw);
    if (err) refuse('Order date: {err} Nothing was changed.', { err });
    createdAt = stamp(day, createdAt);
  }
  const fulfilled = order.status === 'fulfilled';
  let fulfilledAt = order.fulfilled_at, moved = false;
  raw = String(delivered_on || '').trim();
  if (fulfilled && raw && raw !== String(fulfilledAt || '').slice(0, 10)) {
    const [day, err] = formDay(raw);
    if (err) refuse('Delivery date: {err} Nothing was changed.', { err });
    fulfilledAt = stamp(day, fulfilledAt);
    moved = true;
  }
  if (fulfilled && fulfilledAt && String(fulfilledAt).slice(0, 10) < String(createdAt).slice(0, 10)) {
    refuse('The delivery date ({d}) can’t be before the order date ({o}). Nothing was changed.', { d: String(fulfilledAt).slice(0, 10), o: String(createdAt).slice(0, 10) });
  }
  let fx = order.fx_rate_to_usd;
  if (fulfilled && (moved || currency !== order.currency_code)) {
    fx = Q.rateOn(currency, fulfilledAt);
    if (fx === null) refuse('Set an exchange rate for {c} first (Currencies page). Nothing was changed.', { c: currency });
  }
  run(`UPDATE orders SET customer_id = ?, notes = ?, currency_code = ?, created_at = ?, fulfilled_at = ?, fx_rate_to_usd = ? WHERE id = ?`,
    [customerId, notes ?? null, currency, createdAt, fulfilledAt, fx, orderId]);
  let msg = t('Order details updated.');
  if (moved) {
    const oldDay = String(order.fulfilled_at || '').slice(0, 10), newDay = String(fulfilledAt).slice(0, 10);
    let movedInv = 0;
    for (const inv of all(`SELECT id, issued_at FROM invoices WHERE order_id = ? AND status != 'void'`, [orderId])) {
      if (String(inv.issued_at || '').slice(0, 10) === oldDay) { run(`UPDATE invoices SET issued_at = ? WHERE id = ?`, [stamp(newDay, inv.issued_at), inv.id]); movedInv++; }
    }
    for (const b of all(`SELECT id, sold_at FROM boxes WHERE sold_order_id = ?`, [orderId])) run(`UPDATE boxes SET sold_at = ? WHERE id = ?`, [stamp(newDay, b.sold_at), b.id]);
    for (const m of all(`SELECT id, created_at FROM stock_moves WHERE ref_type = 'order' AND ref_id = ? AND reason = 'sale'`, [orderId])) run(`UPDATE stock_moves SET created_at = ? WHERE id = ?`, [stamp(newDay, m.created_at), m.id]);
    msg = t('Delivery date moved from {a} to {b} — the sale now counts on {b} in the reports.', { a: oldDay, b: newDay });
  }
  return msg;
}

// ---------- loose pairs ----------
export function orderItemEdit(orderId, itemId, { qty, unit_price }) {
  const item = one(`SELECT * FROM order_items WHERE id = ? AND order_id = ?`, [itemId, orderId]);
  const order = one(`SELECT status FROM orders WHERE id = ?`, [orderId]);
  if (!item || !order || order.status === 'cancelled') refuse('That line can’t be changed.');
  const delivered = order.status === 'fulfilled';
  const q = delivered ? item.qty : int(qty || item.qty);
  const price = num(unit_price);
  if (q < 1 || price <= 0) refuse('Quantity and price per pair must both be greater than zero.');
  if (!delivered && item.box_id === null && q > item.qty) {
    const avail = Q.pairsAvail(item.variant_id);
    if (q - item.qty > avail) refuse('Only {n} more pair(s) of {v} available — open another box first.', { n: avail, v: variantName(item.variant_id) });
  }
  run(`UPDATE order_items SET qty = ?, unit_price = ? WHERE id = ? AND order_id = ?`, [q, price, itemId, orderId]);
  return delivered ? t('Price corrected — the invoice and what the customer owes follow it.') : t('Line item updated.');
}

export function orderItemDelete(orderId, itemId) {
  const item = one(`SELECT * FROM order_items WHERE id = ? AND order_id = ?`, [itemId, orderId]);
  const order = one(`SELECT status FROM orders WHERE id = ?`, [orderId]);
  if (order && order.status === 'fulfilled') refuse('This order was delivered — record a return instead of removing the line.');
  run(`DELETE FROM order_items WHERE id = ?`, [itemId]);
  if (item && item.box_id !== null) {
    if (val(`SELECT COUNT(*) FROM order_items WHERE box_id = ?`, [item.box_id]) === 0) run(`UPDATE boxes SET status = 'in_stock' WHERE id = ?`, [item.box_id]);
  }
  return t('Line item removed.');
}

// app._customer_price — the customer's standing discount on a base price.
export function customerPrice(orderId, base) {
  const r = one(`SELECT c.discount_percent FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [orderId]);
  if (r && r.discount_percent) return pyRound(base * (1 - r.discount_percent / 100), 2);
  return base;
}

export function orderAddItem(orderId, { variant_id, qty, box_label, price_per_pair }) {
  const variantId = asId(variant_id);
  const q = int(qty);
  const label = String(box_label || 'Box 1').trim() || 'Box 1';
  const variant = one(`SELECT * FROM variants WHERE id = ?`, [variantId]);
  if (!variant) refuse('That size no longer exists.');
  const product = one(`SELECT * FROM products WHERE id = ?`, [variant.product_id]);
  const raw = price_per_pair === undefined || price_per_pair === null ? '' : String(price_per_pair).trim();
  const price = raw ? num(raw) : customerPrice(orderId, product.sale_price);
  if (q < 1 || !price || price <= 0) refuse('Enter the price per pair you agreed for these loose pairs.');
  const avail = Q.pairsAvail(variantId);
  if (q > avail) refuse('Only {n} pair(s) of {v} available to sell singly (open boxes and loose pairs, less what other orders hold). Open a box of that model first.', { n: avail, v: variantName(variantId) });
  ins('order_items', { order_id: orderId, variant_id: variantId, box_label: label, qty: q, unit_price: price });
  return t('Added {n} pair(s) of {v}.', { n: q, v: variantName(variantId) });
}

export function variantName(variantId) {
  const v = one(`SELECT p.name, v.color, v.size FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`, [variantId]);
  return v ? `${v.name}${v.color ? ' ' + v.color : ''} ${t('size')} ${v.size}` : t('that pair');
}

function pairsShort(orderId) {
  const avail = Q.pairsAvailable();
  const need = new Map();
  for (const it of all(`SELECT variant_id, qty FROM order_items WHERE order_id = ? AND box_id IS NULL`, [orderId])) need.set(it.variant_id, (need.get(it.variant_id) || 0) + it.qty);
  const out = [];
  for (const [v, q] of need) {
    const a = avail.get(v) || {};
    const have = (a.open || 0) + (a.loose || 0);
    if (q > have) out.push(t('{v}: {q} needed, {h} available', { v: variantName(v), q, h: have }));
  }
  return out;
}

function closeIfEmpty(boxId) {
  const left = val(`SELECT COALESCE(SUM(qty_left), 0) FROM box_items WHERE box_id = ?`, [boxId]);
  const status = val(`SELECT status FROM boxes WHERE id = ?`, [boxId]);
  if (left <= 0 && status === 'open') run(`UPDATE boxes SET status = 'emptied' WHERE id = ?`, [boxId]);
  else if (left > 0 && status === 'emptied') run(`UPDATE boxes SET status = 'open' WHERE id = ?`, [boxId]);
}
export { closeIfEmpty };

// app._pick_pairs — a line's pairs come from open boxes (oldest opened first), then loose.
function pickPairs(item, when) {
  let need = item.qty, cost = 0;
  const touched = new Set();
  for (const bi of all(`SELECT bi.id, bi.box_id, bi.qty_left, bi.unit_cost FROM box_items bi JOIN boxes b ON b.id = bi.box_id
                        WHERE b.status = 'open' AND bi.variant_id = ? AND bi.qty_left > 0 ORDER BY b.opened_at, b.id`, [item.variant_id])) {
    const take = Math.min(need, bi.qty_left);
    run(`UPDATE box_items SET qty_left = qty_left - ? WHERE id = ?`, [take, bi.id]);
    ins('pair_picks', { kind: 'sale', order_item_id: item.id, box_id: bi.box_id, variant_id: item.variant_id, qty: take, unit_cost: bi.unit_cost, created_at: when });
    cost += take * bi.unit_cost;
    touched.add(bi.box_id);
    need -= take;
    if (need === 0) break;
  }
  if (need > 0) {
    const unit = Q.loosePairCost(item.variant_id);
    ins('pair_picks', { kind: 'sale', order_item_id: item.id, box_id: null, variant_id: item.variant_id, qty: need, unit_cost: unit, created_at: when });
    cost += need * unit;
  }
  for (const b of touched) closeIfEmpty(b);
  return cost;
}

// app._pairs_out_by_box — [box_id, unit_cost, pairs still with the customer], newest first.
function pairsOutByBox(orderItemId) {
  return all(`SELECT box_id, MAX(unit_cost) as unit_cost,
                     SUM(CASE WHEN kind = 'sale' THEN qty WHEN kind = 'return' THEN -qty ELSE 0 END) as net, MAX(id) as last_id
              FROM pair_picks WHERE order_item_id = ? AND kind IN ('sale', 'return') GROUP BY box_id ORDER BY last_id DESC`, [orderItemId])
    .filter(r => r.net > 0).map(r => [r.box_id, r.unit_cost, r.net]);
}

// app._put_pairs_back — returned pairs go back into the box they came from.
function putPairsBack(orderItemId, returnItemId, variantId, qty) {
  const out = pairsOutByBox(orderItemId);
  if (!out.length) return null;
  let cost = 0, left = qty;
  for (const [boxId, unitCost, net] of out) {
    const take = Math.min(left, net);
    if (take <= 0) continue;
    if (boxId !== null) {
      run(`UPDATE box_items SET qty_left = COALESCE(qty_left, 0) + ? WHERE box_id = ? AND variant_id = ?`, [take, boxId, variantId]);
      closeIfEmpty(boxId);
    }
    ins('pair_picks', { kind: 'return', order_item_id: orderItemId, return_item_id: returnItemId, box_id: boxId, variant_id: variantId, qty: take, unit_cost: unitCost });
    cost += take * unitCost;
    left -= take;
    if (left === 0) break;
  }
  return cost;
}

// ---------- whole boxes ----------
export function orderAttachBoxes(orderId, { po_id, label, qty, price_per_pair, price_per_box }) {
  const poId = asId(po_id);
  const q = int(qty);
  const ppb = Q.mixPairsPerBox(poId, label);
  let pricePerBox;
  if (price_per_pair !== undefined && price_per_pair !== null && price_per_pair !== '') {
    if (!ppb) refuse('Can’t work out the box price — this mix has no pairs recorded.');
    pricePerBox = num(price_per_pair) * ppb;
  } else pricePerBox = num(price_per_box || 0);
  if (q < 1) refuse('Enter at least 1 box.');
  if (pricePerBox <= 0) refuse('Enter the price you agreed with the customer.');
  const available = Q.boxesAvailable(poId, label, null);
  if (q > available) refuse('Only {n} box(es) of “{l}” are available — asked for {q}.', { n: available, l: label, q });
  ins('order_box_lines', { order_id: orderId, source_po_id: poId, source_label: label, qty_boxes: q, price_per_box: pricePerBox });
  const cur = val(`SELECT currency_code FROM orders WHERE id = ?`, [orderId]);
  return t('Added {q} box(es) of “{l}” at {p} a box, {tot} in all.', { q, l: label, p: money(pricePerBox, cur), tot: money(q * pricePerBox, cur) });
}

export function orderBoxLineEdit(orderId, lineId, { qty_boxes, price_per_pair, price_per_box }) {
  const line = one(`SELECT * FROM order_box_lines WHERE id = ? AND order_id = ?`, [lineId, orderId]);
  if (!line) refuse('That line no longer exists.');
  const order = one(`SELECT status FROM orders WHERE id = ?`, [orderId]);
  if (order.status === 'cancelled') refuse('This order is cancelled — it can’t be changed.');
  const delivered = order.status === 'fulfilled';
  const q = delivered ? line.qty_boxes : int(qty_boxes);
  let price;
  if (price_per_pair !== undefined && price_per_pair !== null && price_per_pair !== '') {
    const pairs = Q.mixPairsPerBox(line.source_po_id, line.source_label);
    price = num(price_per_pair) * (pairs || 1);
  } else price = num(price_per_box || 0);
  if (q < 1 || price <= 0) refuse('Quantity and price per box must both be greater than zero.');
  const available = Q.boxesAvailable(line.source_po_id, line.source_label, null) + line.qty_boxes;
  if (!delivered && q > available) refuse('Only {n} box(es) of “{l}” are available.', { n: available, l: line.source_label });
  run(`UPDATE order_box_lines SET qty_boxes = ?, price_per_box = ? WHERE id = ?`, [q, price, lineId]);
  return delivered ? t('Price corrected — the invoice and what the customer owes follow it.') : t('Box line updated.');
}

export function orderBoxLineDelete(orderId, lineId) {
  const line = one(`SELECT * FROM order_box_lines WHERE id = ? AND order_id = ?`, [lineId, orderId]);
  for (const a of all(`SELECT box_id FROM order_box_allocations WHERE order_box_line_id = ?`, [lineId])) {
    run(`UPDATE boxes SET status = 'in_stock', sold_order_id = NULL, sold_at = NULL WHERE id = ?`, [a.box_id]);
  }
  run(`DELETE FROM order_box_allocations WHERE order_box_line_id = ?`, [lineId]);
  run(`DELETE FROM order_box_lines WHERE id = ?`, [lineId]);
  return t('Removed “{l}” from this order.', { l: line ? line.source_label : t('that line') });
}

// ---------- deleting, delivering, cancelling ----------
export function orderDelete(orderId) {
  const order = one(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) refuse('That order no longer exists.');
  const live = val(`SELECT 1 FROM invoices WHERE order_id = ? AND status != 'void' LIMIT 1`, [orderId]);
  if (order.status === 'fulfilled' || live) refuse('Cancel this order first — that releases its boxes, reverses the stock and voids any invoice. You can delete it afterwards.');
  for (const r of all(`SELECT a.box_id FROM order_box_allocations a JOIN order_box_lines bl ON bl.id = a.order_box_line_id WHERE bl.order_id = ?`, [orderId])) {
    run(`UPDATE boxes SET status = 'in_stock', sold_order_id = NULL, sold_at = NULL WHERE id = ?`, [r.box_id]);
  }
  for (const r of all(`SELECT DISTINCT box_id FROM order_items WHERE order_id = ? AND box_id IS NOT NULL`, [orderId])) {
    run(`UPDATE boxes SET status = 'in_stock', sold_order_id = NULL, sold_at = NULL WHERE id = ?`, [r.box_id]);
  }
  for (const r of all(`SELECT id FROM order_box_lines WHERE order_id = ?`, [orderId])) {
    run(`DELETE FROM order_box_allocations WHERE order_box_line_id = ?`, [r.id]);
    run(`DELETE FROM return_items WHERE order_box_line_id = ?`, [r.id]);
  }
  run(`DELETE FROM order_box_lines WHERE order_id = ?`, [orderId]);
  run(`DELETE FROM return_items WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, [orderId]);
  run(`DELETE FROM returns WHERE order_id = ?`, [orderId]);
  run(`DELETE FROM order_items WHERE order_id = ?`, [orderId]);
  run(`DELETE FROM stock_moves WHERE ref_type = 'order' AND ref_id = ?`, [orderId]);
  run(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE order_id = ?)`, [orderId]);
  run(`DELETE FROM invoices WHERE order_id = ?`, [orderId]);
  run(`UPDATE boxes SET sold_order_id = NULL, sold_at = NULL WHERE sold_order_id = ?`, [orderId]);
  run(`UPDATE proformas SET order_id = NULL, status = 'void' WHERE order_id = ?`, [orderId]);
  run(`DELETE FROM orders WHERE id = ?`, [orderId]);
  return t('Order deleted — any boxes it held are back in stock.');
}

export function orderFulfill(orderId, { delivered_on, credit_ok } = {}) {
  const [totalNow] = Q.orderTotal(orderId);
  if (totalNow <= 0.004) refuse('This order is worth 0 — set a price per pair on its lines before fulfilling it.');
  const order = one(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (order.status !== 'open') refuse('This order is already {s}.', { s: t(order.status) });
  const [day, err] = formDay(delivered_on);
  if (err) refuse('Delivery date: {err} The order was not fulfilled.', { err });
  const orderDay = String(order.created_at || '').slice(0, 10);
  if (orderDay && day < orderDay) refuse('The delivery date ({d}) can’t be before the order date ({o}). The order was not fulfilled.', { d: day, o: orderDay });
  const saleFx = Q.rateOn(order.currency_code, day);
  if (saleFx === null) refuse('Set an exchange rate for {c} first (Currencies page), so this sale can be valued in USD. The order was not fulfilled.', { c: order.currency_code });
  if (order.customer_id !== null && !credit_ok) {
    const cust = one(`SELECT * FROM customers WHERE id = ?`, [order.customer_id]);
    const cs = cust ? Q.creditStatus(cust, Q.orderUsdToday(orderId, order.currency_code)) : null;
    if (cs && cs.over) refuse('This delivery would take {n} over their credit limit: they owe {o}, this order is {x}, limit {l}. Tick “Deliver anyway” to go ahead. The order was not fulfilled.',
      { n: cust.name, o: fmtUsd(cs.exposure_usd), x: fmtUsd(cs.extra_usd), l: fmtUsd(cs.limit_usd) });
  }
  const when = stamp(day);
  const short = pairsShort(orderId);
  if (short.length) refuse('Can’t deliver — not enough single pairs: {s}. Open another box of that model, or lower the quantity.', { s: short.join('; ') });
  for (const line of all(`SELECT * FROM order_box_lines WHERE order_id = ? ORDER BY id`, [orderId])) {
    const already = val(`SELECT COUNT(*) FROM order_box_allocations WHERE order_box_line_id = ?`, [line.id]);
    const need = line.qty_boxes - already;
    if (need <= 0) continue;
    const boxes = all(`SELECT * FROM boxes WHERE source_po_id IS ? AND source_label = ? AND status = 'in_stock' ORDER BY received_at, id LIMIT ?`, [line.source_po_id, line.source_label, need]);
    if (boxes.length < need) refuse('Can’t fulfil — only {n} box(es) of “{l}” are still in stock but this order needs {k}.', { n: boxes.length, l: line.source_label, k: need });
    for (const b of boxes) {
      ins('order_box_allocations', { order_box_line_id: line.id, box_id: b.id });
      run(`UPDATE boxes SET status = 'sold', sold_order_id = ?, sold_at = ? WHERE id = ?`, [orderId, when, b.id]);
      for (const item of all(`SELECT * FROM box_items WHERE box_id = ?`, [b.id])) {
        ins('stock_moves', { variant_id: item.variant_id, change_qty: -item.qty, reason: 'sale', ref_type: 'order', ref_id: orderId, note: `Sold in ${b.box_code}`, created_at: when });
      }
    }
  }
  for (const item of all(`SELECT * FROM order_items WHERE order_id = ? AND box_id IS NULL`, [orderId])) {
    const cost = pickPairs(item, when);
    run(`UPDATE order_items SET unit_cost_usd = ? WHERE id = ?`, [pyRound(cost / item.qty, 6), item.id]);
    ins('stock_moves', { variant_id: item.variant_id, change_qty: -item.qty, reason: 'sale', ref_type: 'order', ref_id: orderId, note: 'Loose pairs sold', created_at: when });
  }
  run(`UPDATE orders SET status = 'fulfilled', fulfilled_at = ?, fx_rate_to_usd = ? WHERE id = ?`, [when, saleFx, orderId]);
  const existing = Q.activeInvoice(orderId);
  const number = existing ? existing.invoice_number : createInvoice(orderId, when);
  const who = val(`SELECT c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [orderId]);
  return t('Order delivered on {d}. Invoice {n}: {w} owes {a}.', { d: day, n: number, w: who || t('the customer'), a: money(totalNow, order.currency_code) });
}

export function orderCancel(orderId) {
  const order = one(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) refuse('That order no longer exists.');
  if (order.status === 'cancelled') refuse('That order is already cancelled.');
  const was = order.status === 'fulfilled';
  for (const r of all(`SELECT a.box_id FROM order_box_allocations a JOIN order_box_lines bl ON bl.id = a.order_box_line_id WHERE bl.order_id = ?`, [orderId])) {
    run(`UPDATE boxes SET status = 'in_stock', sold_order_id = NULL, sold_at = NULL WHERE id = ?`, [r.box_id]);
  }
  run(`DELETE FROM order_box_allocations WHERE order_box_line_id IN (SELECT id FROM order_box_lines WHERE order_id = ?)`, [orderId]);
  for (const r of all(`SELECT DISTINCT box_id FROM order_items WHERE order_id = ? AND box_id IS NOT NULL`, [orderId])) {
    run(`UPDATE boxes SET status = 'in_stock', sold_order_id = NULL, sold_at = NULL WHERE id = ?`, [r.box_id]);
  }
  if (was) {
    run(`DELETE FROM stock_moves WHERE ref_type = 'order' AND ref_id = ?`, [orderId]);
    for (const it of all(`SELECT id, variant_id FROM order_items WHERE order_id = ? AND box_id IS NULL`, [orderId])) {
      for (const [boxId, , net] of pairsOutByBox(it.id)) {
        if (boxId !== null) {
          run(`UPDATE box_items SET qty_left = COALESCE(qty_left, 0) + ? WHERE box_id = ? AND variant_id = ?`, [net, boxId, it.variant_id]);
          closeIfEmpty(boxId);
        }
      }
      run(`DELETE FROM pair_picks WHERE order_item_id = ?`, [it.id]);
    }
  }
  const voided = val(`SELECT COUNT(*) FROM invoices WHERE order_id = ? AND status != 'void'`, [orderId]);
  run(`UPDATE invoices SET status = 'void' WHERE order_id = ?`, [orderId]);
  run(`UPDATE orders SET status = 'cancelled' WHERE id = ?`, [orderId]);
  let msg = t('Order cancelled — boxes released back to stock.');
  if (was) msg += ' ' + t('Stock movements reversed.');
  if (voided) msg += ' ' + t('{n} invoice(s) voided.', { n: voided });
  const paid = val(`SELECT COALESCE(SUM(ip.amount), 0) FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.order_id = ?`, [orderId]);
  if (paid) msg += ' ' + t('Payments already received are left on record — refund them from the customer’s account if needed.');
  return msg;
}

// ---------- returns ----------
export function orderBoxLineReturn(orderId, lineId, { qty, restock, reason }) {
  const order = one(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order || order.status !== 'fulfilled') refuse('Only fulfilled orders can have returns processed against them.');
  const line = one(`SELECT * FROM order_box_lines WHERE id = ? AND order_id = ?`, [lineId, orderId]);
  if (!line) refuse('Couldn’t find that box line.');
  const already = val(`SELECT COALESCE(SUM(qty), 0) FROM return_items WHERE order_box_line_id = ?`, [lineId]);
  const max = line.qty_boxes - already;
  const q = int(qty);
  if (q <= 0 || q > max) refuse('Can’t return {q} — only {m} box(es) from this line are eligible.', { q, m: max });
  const rs = !!restock;
  const why = reason || null;
  const refund = pyRound(q * line.price_per_box, 4);
  const allocs = all(`SELECT * FROM order_box_allocations WHERE order_box_line_id = ? ORDER BY id DESC LIMIT ?`, [lineId, q]);
  let returnedCost = 0;
  for (const a of allocs) returnedCost += val(`SELECT COALESCE(SUM(qty * unit_cost), 0) FROM box_items WHERE box_id = ?`, [a.box_id]);
  if (allocs.length < q) returnedCost += (q - allocs.length) * Q.mixBoxCost(line.source_po_id, line.source_label);
  const returnId = ins('returns', { order_id: orderId, reason: why });
  ins('return_items', { return_id: returnId, order_box_line_id: lineId, variant_id: null, qty: q, restocked: rs ? 1 : 0, refund_amount: refund, cost_usd: pyRound(returnedCost, 6) });
  for (const a of allocs) {
    const box = one(`SELECT * FROM boxes WHERE id = ?`, [a.box_id]);
    if (rs) {
      run(`UPDATE boxes SET status = 'in_stock', sold_order_id = NULL, sold_at = NULL WHERE id = ?`, [a.box_id]);
      for (const item of all(`SELECT * FROM box_items WHERE box_id = ?`, [a.box_id])) {
        ins('stock_moves', { variant_id: item.variant_id, change_qty: item.qty, reason: 'return', ref_type: 'order', ref_id: orderId, note: box ? `Returned in ${box.box_code}` : 'Box returned' });
      }
    }
    run(`DELETE FROM order_box_allocations WHERE id = ?`, [a.id]);
  }
  if (rs && line.source_po_id !== null) recostPoBoxes(line.source_po_id, 'Box returned to stock');
  return t('Returned {q} box(es), {r} credited{x}.', { q, r: money(refund, order.currency_code), x: rs ? t(' and restocked') : t(' (written off, not restocked)') });
}

export function orderItemReturn(orderId, itemId, { qty, restock, reason }) {
  const order = one(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (order.status !== 'fulfilled') refuse('Only fulfilled orders can have returns processed against them.');
  const item = one(`SELECT * FROM order_items WHERE id = ? AND order_id = ?`, [itemId, orderId]);
  if (!item) refuse('Couldn’t find that line item.');
  const already = val(`SELECT COALESCE(SUM(qty), 0) FROM return_items WHERE order_item_id = ?`, [itemId]);
  const max = item.qty - already;
  const q = int(qty);
  if (q <= 0 || q > max) refuse('Can’t return {q} — only {m} pair(s) from this line are eligible.', { q, m: max });
  const rs = !!restock;
  const why = reason || null;
  const refund = pyRound(q * item.unit_price, 2);
  const unitCost = item.unit_cost_usd !== null ? item.unit_cost_usd : Q.loosePairCost(item.variant_id);
  const returnId = ins('returns', { order_id: orderId, reason: why });
  const ri = ins('return_items', { return_id: returnId, order_item_id: itemId, variant_id: item.variant_id, qty: q, restocked: rs ? 1 : 0, refund_amount: refund, cost_usd: pyRound(q * unitCost, 6) });
  if (rs) {
    const back = putPairsBack(itemId, ri, item.variant_id, q);
    if (back !== null) run(`UPDATE return_items SET cost_usd = ? WHERE id = ?`, [pyRound(back, 6), ri]);
    ins('stock_moves', { variant_id: item.variant_id, change_qty: q, reason: 'return', ref_type: 'order', ref_id: orderId, note: why || 'Customer return' });
  }
  return t('Return recorded: {q} pair(s), {r} credited{x}.', { q, r: money(refund, order.currency_code), x: rs ? t(' and restocked') : t(' (written off, not restocked)') });
}

// ---------- invoices ----------
export function createInvoice(orderId, issuedAt = null) {
  const year = issuedAt ? String(issuedAt).slice(0, 4) : null;
  const number = Q.nextInvoiceNumber(year && /^\d+$/.test(year) ? Number(year) : null);
  ins('invoices', { order_id: orderId, invoice_number: number, issued_at: issuedAt || val(`SELECT datetime('now')`) });
  return number;
}

export function orderCreateInvoice(orderId) {
  const existing = Q.activeInvoice(orderId);
  if (existing) refuse('This order already has invoice {n}.', { n: existing.invoice_number });
  const [total] = Q.orderTotal(orderId);
  if (total <= 0.004) refuse('This order is worth 0 — set a price on its lines before invoicing it.');
  const order = one(`SELECT status, fulfilled_at FROM orders WHERE id = ?`, [orderId]);
  const issuedAt = order && order.status === 'fulfilled' ? order.fulfilled_at : null;
  const number = createInvoice(orderId, issuedAt);
  return issuedAt ? t('Invoice {n} created, dated {d} (delivery day).', { n: number, d: String(issuedAt).slice(0, 10) }) : t('Invoice {n} created.', { n: number });
}

export function invoicePay(invoiceId, { amount, pay_in_full, paid_on, account_id, note }) {
  const inv = one(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
  if (!inv) refuse('That invoice no longer exists.');
  if (inv.status === 'void') refuse('This invoice is void — it can’t take payments.');
  const fin = Q.invoiceFinancials(invoiceId);
  const cur = fin.currency_code;
  let amt;
  if (amount !== undefined && amount !== null && String(amount).trim() !== '') amt = num(amount);
  else if (pay_in_full) amt = fin.balance;
  else refuse('Enter the amount you received. Nothing was recorded.');
  if (amt <= 0) refuse(fin.balance <= 0.004 ? 'Nothing is owed on this invoice.' : 'Enter a payment amount greater than zero.');
  if (amt > fin.balance + 0.004) refuse('That’s more than the {b} still owed. Nothing was recorded.', { b: money(fin.balance, cur) });
  const [paidDay, err] = formDay(paid_on);
  if (err) refuse('Payment date: {err} Nothing was recorded.', { err });
  const orderDay = val(`SELECT created_at FROM orders WHERE id = ?`, [inv.order_id]);
  if (orderDay && paidDay < String(orderDay).slice(0, 10)) refuse('The payment date ({p}) is before the order date ({o}). Nothing was recorded.', { p: paidDay, o: String(orderDay).slice(0, 10) });
  let acct = null, posted = amt;
  const acctId = asId(account_id);
  if (acctId !== null) {
    acct = one(`SELECT * FROM cash_accounts WHERE id = ?`, [acctId]);
    if (acct.currency_code !== cur) {
      const invRate = Q.rateOn(cur, paidDay), acctRate = Q.rateOn(acct.currency_code, paidDay);
      if (!invRate || !acctRate) refuse('Set an exchange rate for {c} first. Nothing was recorded.', { c: !invRate ? cur : acct.currency_code });
      const ac = one(`SELECT decimals FROM currencies WHERE code = ?`, [acct.currency_code]);
      posted = pyRound(amt * invRate / acctRate, ac ? ac.decimals : 2);
    }
  }
  const paymentId = ins('invoice_payments', { invoice_id: invoiceId, amount: amt, note: note || null, paid_at: stamp(paidDay) });
  if (acct) {
    const customer = val(`SELECT c.name FROM invoices i JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = o.customer_id WHERE i.id = ?`, [invoiceId]);
    postCashTransaction(acct.id, posted, 'customer_payment', { occurredOn: paidDay, description: `Payment on ${inv.invoice_number}${customer ? ' — ' + customer : ''}`, refType: 'invoice_payment', refId: paymentId });
  }
  const left = fin.balance - amt;
  let msg = t('Recorded a payment of {a} on {n}.', { a: money(amt, cur), n: inv.invoice_number });
  if (acct && posted !== amt) msg += ' ' + t('{p} into {acc}.', { p: money(posted, acct.currency_code), acc: acct.name });
  msg += ' ' + (left > 0.004 ? t('Still owed: {l}.', { l: money(left, cur) }) : t('Paid in full.'));
  if (!acct) msg += ' ' + t('(No account selected — not posted to a cash account.)');
  return msg;
}

export function invoicePaymentDelete(paymentId) {
  const p = one(`SELECT ip.*, i.order_id, i.invoice_number FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE ip.id = ?`, [paymentId]);
  if (!p) refuse('That payment no longer exists.');
  run(`DELETE FROM cash_transactions WHERE ref_type = 'invoice_payment' AND ref_id = ?`, [paymentId]);
  run(`DELETE FROM invoice_payments WHERE id = ?`, [paymentId]);
  const fin = Q.invoiceFinancials(p.invoice_id);
  return t('Payment removed from {n}. Still owed: {b}.', { n: p.invoice_number, b: money(fin.balance, fin.currency_code) });
}

export function invoiceVoid(invoiceId) {
  run(`UPDATE invoices SET status = 'void' WHERE id = ?`, [invoiceId]);
  return t('Invoice voided.');
}

export { today };

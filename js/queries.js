// The calculations of the original app (db.py and app.py), ported with the same SQL so
// that stock, values and balances come out exactly as before. Function names follow the
// Python ones; each says where it came from.
import { all, one, val } from './localdb.js';
import { pyRound } from './util.js';

export const BASE_CURRENCY = 'USD';

// Figures that many rows of one screen ask for again and again; forgotten whenever data changes.
const MEMO = new Map();
export const clearMemo = () => MEMO.clear();
const memo = (k, f) => { if (!MEMO.has(k)) MEMO.set(k, f()); return MEMO.get(k); };

// db.rate_on — USD per unit of a currency on a day (latest rate on or before it; the
// earliest rate for a day before the first one; null if the currency has no rate).
export function rateOn(code, onDate = null) {
  return memo('rate|' + code + '|' + (onDate === null || onDate === undefined ? 'today' : String(onDate).slice(0, 10)), () => rateOnRaw(code, onDate));
}
function rateOnRaw(code, onDate) {
  if (code === BASE_CURRENCY) return 1.0;
  let row;
  if (onDate === null || onDate === undefined) {
    row = one(`SELECT usd_per_unit FROM exchange_rates WHERE currency_code = ? AND effective_from <= date('now')
               ORDER BY effective_from DESC, id DESC LIMIT 1`, [code]);
  } else {
    row = one(`SELECT usd_per_unit FROM exchange_rates WHERE currency_code = ? AND effective_from <= ?
               ORDER BY effective_from DESC, id DESC LIMIT 1`, [code, String(onDate).slice(0, 10)]);
  }
  if (!row) row = one(`SELECT usd_per_unit FROM exchange_rates WHERE currency_code = ? ORDER BY effective_from, id LIMIT 1`, [code]);
  return row ? row.usd_per_unit : null;
}

// app.ORDER_VALUE_SQL — an order's value net of returns, in its own currency.
export const ORDER_VALUE_SQL = `(
    COALESCE((SELECT SUM((bl.qty_boxes - COALESCE(
        (SELECT SUM(ri.qty) FROM return_items ri WHERE ri.order_box_line_id = bl.id), 0))
        * bl.price_per_box)
      FROM order_box_lines bl WHERE bl.order_id = o.id), 0)
  + COALESCE((SELECT SUM((oi.qty - COALESCE(
        (SELECT SUM(ri.qty) FROM return_items ri WHERE ri.order_item_id = oi.id), 0))
        * oi.unit_price)
      FROM order_items oi WHERE oi.order_id = o.id AND oi.box_id IS NULL), 0)
)`;

// db.BOX_PAIRS_SQL — pairs physically in a box.
export const BOX_PAIRS_SQL = `CASE WHEN b.status = 'in_stock' THEN bi.qty WHEN b.status = 'open' THEN COALESCE(bi.qty_left, 0) ELSE 0 END`;

// db.all_variant_stock
export function allVariantStock() {
  return all(`
    SELECT v.id as variant_id, v.color, v.size, v.sku, v.product_id,
           p.name as product_name, p.brand, p.category, p.cost_price, p.sale_price, p.reorder_level,
           COALESCE(SUM(sm.change_qty), 0) as qty_on_hand
    FROM variants v JOIN products p ON p.id = v.product_id
    LEFT JOIN stock_moves sm ON sm.variant_id = v.id
    GROUP BY v.id ORDER BY p.name, v.color, v.size`);
}

// db.variants_for_product
export function variantsForProduct(productId) {
  return all(`
    SELECT v.id as variant_id, v.color, v.size, v.sku, COALESCE(SUM(sm.change_qty), 0) as qty_on_hand
    FROM variants v LEFT JOIN stock_moves sm ON sm.variant_id = v.id
    WHERE v.product_id = ? GROUP BY v.id ORDER BY v.color, v.size`, [productId]);
}

// db.loose_pair_cost
export function loosePairCost(variantId) {
  const r = one(`SELECT SUM(qty * unit_cost) as s, SUM(qty) as q FROM box_items WHERE variant_id = ?`, [variantId]);
  if (r && r.q) return r.s / r.q;
  const p = one(`SELECT p.cost_price FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`, [variantId]);
  return p ? (p.cost_price || 0) : 0;
}

// db.stock_value_landed
export function stockValueLanded() {
  const boxed = val(`SELECT COALESCE(SUM((${BOX_PAIRS_SQL}) * bi.unit_cost), 0) FROM box_items bi
                     JOIN boxes b ON b.id = bi.box_id WHERE b.status IN ('in_stock', 'open')`) || 0;
  const boxedQty = new Map();
  for (const r of all(`SELECT bi.variant_id as v, SUM(${BOX_PAIRS_SQL}) as qty FROM box_items bi
                       JOIN boxes b ON b.id = bi.box_id WHERE b.status IN ('in_stock', 'open') GROUP BY bi.variant_id`)) boxedQty.set(r.v, r.qty);
  let loose = 0;
  for (const r of allVariantStock()) {
    const q = r.qty_on_hand - (boxedQty.get(r.variant_id) || 0);
    if (q > 0) loose += q * loosePairCost(r.variant_id);
  }
  return boxed + loose;
}

// db.account_balances / total_cash_on_hand
export function accountBalances(includeArchived = false) {
  const rows = all(`
    SELECT a.*, a.opening_balance + COALESCE((SELECT SUM(t.amount) FROM cash_transactions t WHERE t.account_id = a.id), 0) as balance,
           c.symbol, c.decimals
    FROM cash_accounts a LEFT JOIN currencies c ON c.code = a.currency_code
    ${includeArchived ? '' : 'WHERE a.archived = 0'}
    ORDER BY a.archived, a.name`);
  return rows.map(r => {
    const rate = rateOn(r.currency_code);
    return { ...r, fx_rate: rate, balance_usd: rate !== null ? r.balance * rate : null };
  });
}
export const totalCashOnHand = () => accountBalances().reduce((s, a) => s + (a.balance_usd ?? 0), 0);

// db.box_contents
export function boxContents(boxId) {
  return all(`SELECT bi.*, p.name as product_name, p.image_filename, v.color, v.size, v.sku
              FROM box_items bi JOIN variants v ON v.id = bi.variant_id JOIN products p ON p.id = v.product_id
              WHERE bi.box_id = ? ORDER BY p.name, v.color, v.size`, [boxId]);
}

// app._mix_pairs_per_box — pairs in one box of a mix (boxes of a mix are identical).
export function mixPairsPerBox(poId, label) {
  return memo('ppb|' + poId + '|' + label, () => mixPairsPerBoxRaw(poId, label));
}
function mixPairsPerBoxRaw(poId, label) {
  const r = one(`SELECT b.id FROM boxes b WHERE b.source_po_id IS ? AND b.source_label = ? LIMIT 1`, [poId, label]);
  if (r) return boxContents(r.id).reduce((s, i) => s + i.qty, 0) || 0;
  return val(`SELECT COALESCE(SUM(pi.qty), 0) FROM po_box_groups g JOIN po_items pi ON pi.po_box_group_id = g.id
              WHERE g.po_id IS ? AND g.label = ?`, [poId, label]) || 0;
}

// app._boxes_available — sealed boxes of a mix less those promised on open orders.
export function boxesAvailable(poId, label, excludeOrderId = null) {
  const inStock = val(`SELECT COUNT(*) FROM boxes WHERE source_po_id IS ? AND source_label = ? AND status = 'in_stock'`, [poId, label]) || 0;
  let sql = `SELECT COALESCE(SUM(bl.qty_boxes), 0) FROM order_box_lines bl JOIN orders o ON o.id = bl.order_id
             WHERE bl.source_po_id IS ? AND bl.source_label = ? AND o.status = 'open'`;
  const p = [poId, label];
  if (excludeOrderId) { sql += ' AND bl.order_id != ?'; p.push(excludeOrderId); }
  return inStock - (val(sql, p) || 0);
}

// app._order_box_lines / _order_total — summed line by line in the same order as the old app.
export function orderBoxLines(orderId) {
  return all(`
    SELECT bl.*, (SELECT COUNT(*) FROM order_box_allocations a WHERE a.order_box_line_id = bl.id) as allocated,
           (SELECT COALESCE(SUM(ri.qty), 0) FROM return_items ri WHERE ri.order_box_line_id = bl.id) as returned_boxes
    FROM order_box_lines bl WHERE bl.order_id = ? ORDER BY bl.id`, [orderId]).map(r => {
    const pairs = mixPairsPerBox(r.source_po_id, r.source_label);
    return { ...r, line_total: (r.qty_boxes - r.returned_boxes) * r.price_per_box, pairs_per_box: pairs,
      price_per_pair: pairs ? r.price_per_box / pairs : null };
  });
}
export function orderTotal(orderId) {
  return memo('ot|' + orderId, () => orderTotalRaw(orderId));
}
function orderTotalRaw(orderId) {
  const lines = orderBoxLines(orderId);
  let bt = 0;
  for (const l of lines) bt += l.line_total;
  const lt = val(`SELECT COALESCE(SUM((oi.qty - COALESCE((SELECT SUM(ri.qty) FROM return_items ri WHERE ri.order_item_id = oi.id), 0)) * oi.unit_price), 0)
                  FROM order_items oi WHERE oi.order_id = ? AND oi.box_id IS NULL`, [orderId]) || 0;
  return [bt + lt, bt, lt];
}

// app._order_return_credit
export const orderReturnCredit = orderId => val(`SELECT COALESCE(SUM(ri.refund_amount), 0) FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE r.order_id = ?`, [orderId]) || 0;

// app._invoice_financials
export function invoiceFinancials(invoiceId) {
  return memo('if|' + invoiceId, () => invoiceFinancialsRaw(invoiceId));
}
function invoiceFinancialsRaw(invoiceId) {
  const inv = one(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
  const o = one(`SELECT currency_code, fx_rate_to_usd FROM orders WHERE id = ?`, [inv.order_id]);
  const currency = o ? o.currency_code : BASE_CURRENCY;
  const fx = (o && o.fx_rate_to_usd ? o.fx_rate_to_usd : rateOn(currency)) || 1.0;
  const [total] = orderTotal(inv.order_id);
  const returnCredit = orderReturnCredit(inv.order_id);
  const due = Math.max(total, 0);
  let paid = val(`SELECT COALESCE(SUM(amount), 0) FROM invoice_payments WHERE invoice_id = ?`, [invoiceId]) || 0;
  if (inv.status !== 'void') {
    paid += val(`SELECT COALESCE(SUM(ip.amount), 0) FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
                 WHERE i.order_id = ? AND i.status = 'void' AND i.id != ?`, [inv.order_id, invoiceId]) || 0;
  }
  const balance = pyRound(due - paid, 2);
  let status;
  if (inv.status === 'void') status = 'void';
  else if (due <= 0.004 && paid <= 0.004 && returnCredit <= 0.004) status = 'unpriced';
  else if (balance <= 0.004) status = 'paid';
  else if (paid > 0) status = 'partial';
  else status = 'unpaid';
  const bal = Math.max(balance, 0), credit = Math.max(-balance, 0);
  return { due, return_credit: returnCredit, paid, balance: bal, credit, status, currency_code: currency, fx_rate: fx,
    due_usd: due * fx, paid_usd: paid * fx, balance_usd: bal * fx, credit_usd: credit * fx };
}

// app._customer_summary
export function customerSummary(customerId) {
  const invoices = all(`SELECT i.id, i.issued_at, o.currency_code, COALESCE(o.fx_rate_to_usd, 1) as fx
                        FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.customer_id = ? AND i.status != 'void'`, [customerId]);
  let outstanding = 0, sold = 0, paidTotal = 0, oldest = null;
  let credit = val(`SELECT COALESCE(SUM(ip.amount * COALESCE(o.fx_rate_to_usd, 1)), 0)
                    FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id JOIN orders o ON o.id = i.order_id
                    WHERE o.customer_id = ? AND NOT EXISTS (SELECT 1 FROM invoices i3 WHERE i3.order_id = o.id AND i3.status != 'void')`, [customerId]) || 0;
  for (const inv of invoices) {
    const f = invoiceFinancials(inv.id);
    outstanding += f.balance * inv.fx;
    credit += f.credit * inv.fx;
    sold += f.due * inv.fx;
    paidTotal += f.paid * inv.fx;
    if (f.balance > 0.004 && (oldest === null || String(inv.issued_at) < String(oldest.issued_at))) {
      oldest = { issued_at: inv.issued_at, balance: f.balance, currency_code: inv.currency_code };
    }
  }
  const days = oldest ? val(`SELECT CAST(julianday('now') - julianday(?) AS INTEGER)`, [oldest.issued_at]) : null;
  const lastPayment = one(`SELECT ip.amount, ip.paid_at, o.currency_code FROM invoice_payments ip
                           JOIN invoices i ON i.id = ip.invoice_id JOIN orders o ON o.id = i.order_id
                           WHERE o.customer_id = ? ORDER BY ip.paid_at DESC LIMIT 1`, [customerId]);
  return { outstanding_usd: outstanding, lifetime_sold_usd: sold, lifetime_paid_usd: paidTotal, oldest_unpaid: oldest,
    days_outstanding: days, last_payment: lastPayment, invoice_count: invoices.length, credit_usd: credit };
}

// app._customer_ledger
export function customerLedger(customerId) {
  const events = [];
  const invoices = all(`SELECT i.id, i.invoice_number, i.issued_at, i.status, o.id as order_id, o.currency_code, COALESCE(o.fx_rate_to_usd, 1) as fx
                        FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.customer_id = ? AND i.status != 'void' ORDER BY i.issued_at`, [customerId]);
  for (const inv of invoices) {
    const gross = val(`SELECT COALESCE((SELECT SUM(bl.qty_boxes * bl.price_per_box) FROM order_box_lines bl WHERE bl.order_id = ?), 0)
                            + COALESCE((SELECT SUM(oi.qty * oi.unit_price) FROM order_items oi WHERE oi.order_id = ? AND oi.box_id IS NULL), 0)`, [inv.order_id, inv.order_id]) || 0;
    const boxes = val(`SELECT COALESCE(SUM(qty_boxes), 0) FROM order_box_lines WHERE order_id = ?`, [inv.order_id]) || 0;
    events.push({ when: inv.issued_at, kind: 'invoice', label: inv.invoice_number, boxes, order_id: inv.order_id, charge: gross, payment: 0, currency_code: inv.currency_code, fx: inv.fx });
    for (const p of all(`SELECT ip.* FROM invoice_payments ip JOIN invoices i2 ON i2.id = ip.invoice_id
                         WHERE ip.invoice_id = ? OR (i2.order_id = ? AND i2.status = 'void') ORDER BY ip.paid_at`, [inv.id, inv.order_id])) {
      events.push({ when: p.paid_at, kind: 'payment', label: inv.invoice_number, note: p.note, order_id: inv.order_id, charge: 0, payment: p.amount, currency_code: inv.currency_code, fx: inv.fx });
    }
  }
  for (const p of all(`SELECT ip.*, i.invoice_number, o.id as order_id, o.currency_code, COALESCE(o.fx_rate_to_usd, 1) as fx
                       FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id JOIN orders o ON o.id = i.order_id
                       WHERE o.customer_id = ? AND NOT EXISTS (SELECT 1 FROM invoices i3 WHERE i3.order_id = o.id AND i3.status != 'void')`, [customerId])) {
    events.push({ when: p.paid_at, kind: 'payment', label: p.invoice_number, cancelled: true, order_id: p.order_id, charge: 0, payment: p.amount, currency_code: p.currency_code, fx: p.fx });
  }
  for (const r of all(`SELECT r.created_at, r.reason, ri.refund_amount, ri.qty, o.id as order_id, o.currency_code, COALESCE(o.fx_rate_to_usd, 1) as fx
                       FROM returns r JOIN return_items ri ON ri.return_id = r.id JOIN orders o ON o.id = r.order_id
                       WHERE o.customer_id = ? AND o.status = 'fulfilled'
                         AND EXISTS (SELECT 1 FROM invoices i4 WHERE i4.order_id = o.id AND i4.status != 'void')`, [customerId])) {
    events.push({ when: r.created_at, kind: 'return', qty: r.qty, note: r.reason, order_id: r.order_id, charge: 0, payment: r.refund_amount, currency_code: r.currency_code, fx: r.fx });
  }
  // Same order as Python's sort: by date text, invoices before other events on the same moment.
  events.sort((a, b) => {
    const wa = String(a.when), wb = String(b.when);
    if (wa !== wb) return wa < wb ? -1 : 1;
    return (a.kind !== 'invoice') - (b.kind !== 'invoice');
  });
  let running = 0;
  for (const e of events) {
    running += e.charge - e.payment;
    e.balance = running;
    e.charge_usd = e.charge * e.fx;
    e.payment_usd = e.payment * e.fx;
  }
  return events;
}

// app._customer_buying
export function customerBuying(customerId) {
  return all(`
    SELECT bl.source_label, bl.source_po_id, SUM(bl.qty_boxes) as boxes, MIN(bl.price_per_box) as min_price,
           MAX(bl.price_per_box) as max_price, SUM(bl.qty_boxes * bl.price_per_box) / SUM(bl.qty_boxes) as avg_price,
           o.currency_code, MAX(o.created_at) as last_bought
    FROM order_box_lines bl JOIN orders o ON o.id = bl.order_id
    WHERE o.customer_id = ? GROUP BY bl.source_label, o.currency_code ORDER BY boxes DESC`, [customerId]);
}

// app._uninvoiced_fulfilled
export function uninvoicedFulfilled(customerId = null) {
  let sql = `SELECT o.id, o.created_at, o.currency_code, o.customer_id, c.name as customer_name, ${ORDER_VALUE_SQL} as order_total
             FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
             WHERE o.status = 'fulfilled' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id AND i.status != 'void')`;
  const p = [];
  if (customerId !== null) { sql += ' AND o.customer_id = ?'; p.push(customerId); }
  return all(sql + ' ORDER BY o.created_at', p);
}

// app.dashboard figures
export function dashboardFigures() {
  const boxStats = one(`SELECT SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) as in_stock,
                               SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) as sold FROM boxes`);
  const outstandingRows = all(`
    SELECT i.id, (${ORDER_VALUE_SQL}) as value,
           COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0) as paid,
           COALESCE(o.fx_rate_to_usd, 1) as fx
    FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.status != 'void'`);
  const outstandingTotal = outstandingRows.reduce((s, r) => s + Math.max(r.value - r.paid, 0) * r.fx, 0);
  const outstandingCount = outstandingRows.filter(r => r.value - r.paid > 0.004).length;
  const variants = allVariantStock();
  return {
    boxes_in_stock: boxStats.in_stock || 0, boxes_sold: boxStats.sold || 0,
    outstanding_total: outstandingTotal, outstanding_count: outstandingCount,
    stock_value: stockValueLanded(), low_stock: variants.filter(r => r.qty_on_hand <= r.reorder_level),
    cash_on_hand: totalCashOnHand(), has_accounts: !!val(`SELECT 1 FROM cash_accounts LIMIT 1`),
    recent_orders: all(`SELECT o.id, o.status, o.created_at, o.currency_code, c.name as customer_name, ${ORDER_VALUE_SQL} as order_total
                        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 8`),
    uninvoiced: uninvoicedFulfilled()
  };
}

// db.pairs_available — per colour/size: pairs sellable one by one (open boxes + loose)
// less pairs promised on orders not yet delivered.
export function pairsAvailable(excludeOrderId = null) {
  const out = new Map();
  const slot = v => { if (!out.has(v)) out.set(v, { open: 0, sealed: 0, on_hand: 0, loose: 0, committed: 0, available: 0 }); return out.get(v); };
  for (const r of all(`SELECT bi.variant_id as v,
        SUM(CASE WHEN b.status = 'open' THEN COALESCE(bi.qty_left, 0) ELSE 0 END) as o,
        SUM(CASE WHEN b.status = 'in_stock' THEN bi.qty ELSE 0 END) as s
      FROM box_items bi JOIN boxes b ON b.id = bi.box_id WHERE b.status IN ('in_stock', 'open') GROUP BY bi.variant_id`)) {
    slot(r.v).open = r.o || 0; slot(r.v).sealed = r.s || 0;
  }
  for (const r of all(`SELECT variant_id as v, COALESCE(SUM(change_qty), 0) as q FROM stock_moves GROUP BY variant_id`)) slot(r.v).on_hand = r.q || 0;
  let sql = `SELECT oi.variant_id as v, SUM(oi.qty) as q FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE oi.box_id IS NULL AND o.status NOT IN ('fulfilled', 'cancelled')`;
  const p = [];
  if (excludeOrderId) { sql += ' AND o.id != ?'; p.push(excludeOrderId); }
  for (const r of all(sql + ' GROUP BY oi.variant_id', p)) slot(r.v).committed = r.q || 0;
  for (const d of out.values()) {
    d.loose = Math.max(d.on_hand - d.sealed - d.open, 0);
    d.available = Math.max(d.open + d.loose - d.committed, 0);
  }
  return out;
}
export const pairsAvail = (variantId, excl = null) => (pairsAvailable(excl).get(variantId) || {}).available || 0;

// db.mix_box_cost — average cost of one box of a mix (sold boxes preferred).
export function mixBoxCost(poId, label) {
  for (const st of [`AND b.status != 'in_stock'`, '']) {
    const r = one(`SELECT SUM(bi.qty * bi.unit_cost) as s, COUNT(DISTINCT b.id) as n FROM boxes b JOIN box_items bi ON bi.box_id = b.id
                   WHERE b.source_po_id IS ? AND b.source_label = ? ${st}`, [poId, label]);
    if (r && r.n) return r.s / r.n;
  }
  return 0;
}

// app._usd_today / _customer_exposure_usd / _credit_status / _order_usd_today
export function usdToday(amount, currency) {
  if (amount === null || amount === undefined) return null;
  if (!currency || currency === BASE_CURRENCY) return Number(amount);
  const rate = rateOn(currency, new Date().toISOString().slice(0, 10));
  return rate ? Number(amount) * rate : null;
}
export function customerExposureUsd(customerId, summary = null) {
  const s = summary || customerSummary(customerId);
  let unbilled = 0;
  for (const o of uninvoicedFulfilled(customerId)) {
    const fx = val(`SELECT COALESCE(fx_rate_to_usd, 1) FROM orders WHERE id = ?`, [o.id]);
    unbilled += (o.order_total || 0) * fx;
  }
  return Math.max(s.outstanding_usd + unbilled - (s.credit_usd || 0), 0);
}
export function creditStatus(customer, extraUsd = 0, summary = null) {
  const limit = customer.credit_limit;
  if (!limit || limit <= 0) return null;
  const cur = customer.credit_currency || BASE_CURRENCY;
  const limitUsd = usdToday(limit, cur);
  const exposure = customerExposureUsd(customer.id, summary);
  const after = exposure + (extraUsd || 0);
  return { limit, currency: cur, limit_usd: limitUsd, exposure_usd: exposure, extra_usd: extraUsd || 0, after_usd: after,
    over_now: limitUsd !== null && exposure > limitUsd + 0.005, over: limitUsd !== null && after > limitUsd + 0.005,
    over_by: limitUsd !== null ? after - limitUsd : null, pct: limitUsd ? pyRound(exposure / limitUsd * 100) : null,
    room_usd: limitUsd !== null ? limitUsd - exposure : null };
}
export const orderUsdToday = (orderId, currency) => usdToday(orderTotal(orderId)[0], currency) || 0;

// app._active_invoice / _next_invoice_number
export const activeInvoice = orderId => one(`SELECT * FROM invoices WHERE order_id = ? AND status != 'void' ORDER BY id LIMIT 1`, [orderId]);
export function nextInvoiceNumber(year = null) {
  const prefix = `INV-${year || new Date().getUTCFullYear()}-`;
  let n = (val(`SELECT MAX(CAST(SUBSTR(invoice_number, ?) AS INTEGER)) FROM invoices WHERE invoice_number LIKE ?`, [prefix.length + 1, prefix + '%']) || 0) + 1;
  while (val(`SELECT 1 FROM invoices WHERE invoice_number = ?`, [`${prefix}${String(n).padStart(4, '0')}`])) n++;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

// ---------- purchase order costs (app._po_*), used for landed costs and recosting ----------
export function poReceivedDay(poId) {
  const r = val(`SELECT MIN(received_at) FROM po_box_groups WHERE po_id = ? AND received_at IS NOT NULL`, [poId]);
  return r ? String(r).slice(0, 10) : null;
}
export function poGroupRates(poId, currency) {
  const out = new Map();
  let todayRate;
  for (const g of all(`SELECT id, received_at, fx_rate_to_usd FROM po_box_groups WHERE po_id = ?`, [poId])) {
    if (g.received_at) out.set(g.id, [g.fx_rate_to_usd || rateOn(currency, g.received_at), true, String(g.received_at).slice(0, 10)]);
    else { if (todayRate === undefined) todayRate = rateOn(currency); out.set(g.id, [todayRate, false, null]); }
  }
  return out;
}
export function poGoodsUsd(poId, currency) {
  const rates = poGroupRates(poId, currency);
  let total = 0, estimate = false;
  for (const g of all(`SELECT bg.id, COALESCE(SUM(pi.qty * pi.unit_cost), 0) * bg.box_count as goods FROM po_box_groups bg
                       LEFT JOIN po_items pi ON pi.po_box_group_id = bg.id WHERE bg.po_id = ? GROUP BY bg.id`, [poId])) {
    if (!g.goods) continue;
    const [rate, fixed] = rates.get(g.id) || [null, false];
    if (rate === null || rate === undefined) return [null, true];
    total += g.goods * rate;
    estimate = estimate || !fixed;
  }
  return [total, estimate];
}
export function poCostLines(poId) {
  const rows = all(`SELECT pc.*, c.symbol, c.decimals FROM po_costs pc LEFT JOIN currencies c ON c.code = pc.currency_code WHERE pc.po_id = ? ORDER BY pc.id`, [poId]);
  const received = rows.length ? poReceivedDay(poId) : null;
  return rows.map(r => {
    const fixed = r.fx_rate_to_usd !== null;
    const rate = fixed ? r.fx_rate_to_usd : rateOn(r.currency_code, r.cost_date || received);
    const rateDay = fixed ? (r.fx_day || r.cost_date || received) : (r.cost_date || received);
    return { ...r, fx_rate: rate, rate_fixed: fixed, rate_day: rateDay, amount_usd: rate !== null ? r.amount * rate : null };
  });
}
export function poLandedOverheadPerPair(poId) {
  const lines = poCostLines(poId);
  let totalUsd = 0;
  for (const l of lines) if (l.amount_usd !== null) totalUsd += l.amount_usd;
  const pairs = val(`SELECT COALESCE(SUM(pi.qty * bg.box_count), 0) FROM po_box_groups bg JOIN po_items pi ON pi.po_box_group_id = bg.id WHERE bg.po_id = ?`, [poId]) || 0;
  if (pairs === 0) return [0, totalUsd, 0];
  return [totalUsd / pairs, totalUsd, pairs];
}
// app._po_cost_plan — what each box of a PO should cost now vs what is recorded.
export function poCostPlan(poId) {
  const [overhead] = poLandedOverheadPerPair(poId);
  const po = one(`SELECT currency_code FROM purchase_orders WHERE id = ?`, [poId]);
  const items = [], groups = new Map();
  for (const box of all(`SELECT * FROM boxes WHERE source_po_id = ?`, [poId])) {
    const label = box.source_label;
    if (!groups.has(label)) {
      const g = one(`SELECT id, received_at, fx_rate_to_usd FROM po_box_groups WHERE po_id = ? AND label = ? LIMIT 1`, [poId, label]);
      if (g) {
        const fx = g.fx_rate_to_usd || rateOn(po.currency_code, g.received_at) || 1.0;
        const lines = new Map(all(`SELECT variant_id, unit_cost FROM po_items WHERE po_box_group_id = ?`, [g.id]).map(r => [r.variant_id, r.unit_cost]));
        groups.set(label, [fx, lines]);
      } else groups.set(label, null);
    }
    const grp = groups.get(label);
    if (!grp) continue;
    const [fx, lines] = grp;
    for (const it of all(`SELECT * FROM box_items WHERE box_id = ?`, [box.id])) {
      const base = lines.get(it.variant_id);
      if (base === undefined || base === null) continue;
      const target = pyRound(base * fx + overhead, 4);
      if (box.status === 'open' || box.status === 'emptied') {
        const left = it.qty_left || 0, gone = it.qty - left;
        if (gone > 0) {
          const outCost = val(`SELECT COALESCE(SUM(CASE WHEN kind = 'return' THEN -qty * unit_cost ELSE qty * unit_cost END), 0)
                               FROM pair_picks WHERE box_id = ? AND variant_id = ?`, [box.id, it.variant_id]);
          items.push({ id: it.id, box_id: box.id, sold: true, qty: gone, recorded: outCost ? outCost / gone : it.unit_cost, target });
        }
        if (left > 0) items.push({ id: it.id, box_id: box.id, sold: false, qty: left, recorded: it.unit_cost, target });
        continue;
      }
      items.push({ id: it.id, box_id: box.id, sold: box.status === 'sold', qty: it.qty, recorded: it.unit_cost, target });
    }
  }
  const sold = items.filter(i => i.sold);
  let shouldBe = 0;
  for (const i of sold) shouldBe += (i.target - i.recorded) * i.qty;
  const posted = val(`SELECT COALESCE(SUM(amount_usd), 0) FROM cogs_adjustments WHERE po_id = ?`, [poId]) || 0;
  const instock = items.filter(i => !i.sold && Math.abs(i.target - i.recorded) >= 0.00005);
  let instockChange = 0;
  for (const i of instock) instockChange += (i.target - i.recorded) * i.qty;
  return { items, sold_pairs: sold.reduce((s, i) => s + i.qty, 0), should_be: shouldBe, posted, fix: shouldBe - posted,
    instock_boxes: new Set(instock.map(i => i.box_id)).size, instock_change_usd: instockChange,
    boxes_in_stock: new Set(items.filter(i => !i.sold).map(i => i.box_id)).size };
}

// The number shown for an order: imported orders keep theirs (#38); orders made in this app
// continue the count in the order they were made (#39, #40…).
export function orderRef(id) {
  if (typeof id === 'number') return id;
  return memo('oref|' + id, () => {
    const base = val(`SELECT COALESCE(MAX(id), 0) FROM orders WHERE typeof(id) = 'integer'`) || 0;
    const rank = val(`SELECT COUNT(*) FROM orders WHERE typeof(id) = 'text' AND id <= ?`, [id]) || 0;
    return base + rank;
  });
}

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

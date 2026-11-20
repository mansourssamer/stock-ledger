// The reports of the old app (app.py: _sales_in_period, reports, report_pnl, report_cash_flow,
// report_costing, _financial_position, report_balance_sheet, _daily_report, _sales_report,
// _monthly_report), with the same SQL and the same rules, so every figure matches.
// Each function returns the data the old page was given; js/reportpages.js draws it.
import { all, one, val } from './localdb.js';
import * as Q from './queries.js';
import { addDays, daysBetween, todayStr } from './buying.js';

const d10 = s => String(s ?? '').slice(0, 10);
const madd = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
const sumv = it => { let s = 0; for (const x of it) s += x; return s; };
export const weekday = d => (new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay() + 6) % 7;   // Monday = 0
export function shiftMonths(d, n) {
  const m = +d.slice(5, 7) - 1 + n, y = +d.slice(0, 4) + Math.floor(m / 12), mm = ((m % 12) + 12) % 12 + 1;
  return `${y}-${String(mm).padStart(2, '0')}-01`;
}
export const wholeMonths = (s, e) => (s.slice(8) !== '01' || addDays(e, 1).slice(8) !== '01' ? 0 : (+e.slice(0, 4) - +s.slice(0, 4)) * 12 + (+e.slice(5, 7)) - (+s.slice(5, 7)) + 1);

// ---------- sales and cost of goods in a window (_sales_in_period) ----------
function mixComposition(poId, label) {
  let rows = all(`SELECT p.name, SUM(pi.qty) as q FROM po_box_groups g JOIN po_items pi ON pi.po_box_group_id = g.id
                  JOIN variants v ON v.id = pi.variant_id JOIN products p ON p.id = v.product_id
                  WHERE g.po_id IS ? AND g.label = ? GROUP BY p.name`, [poId, label]);
  if (!rows.length) rows = all(`SELECT p.name, SUM(bi.qty) as q FROM box_items bi JOIN variants v ON v.id = bi.variant_id JOIN products p ON p.id = v.product_id
                                WHERE bi.box_id = (SELECT id FROM boxes WHERE source_po_id IS ? AND source_label = ? LIMIT 1) GROUP BY p.name`, [poId, label]);
  return new Map(rows.map(r => [r.name, r.q]));
}
function loosePairCostUsd(variantId, fallback) {
  const r = one(`SELECT SUM(qty * unit_cost) as c, SUM(qty) as q FROM box_items WHERE variant_id = ?`, [variantId]);
  return r && r.q ? r.c / r.q : (fallback || 0.0);
}
export function salesInPeriod(start, endIncl, byOrder = null) {
  let revenue = 0.0, cost = 0.0;
  const byBucket = new Map(), byProduct = new Map();
  const add = (name, rev = 0.0, cst = 0.0, qty = 0) => {
    if (!byProduct.has(name)) byProduct.set(name, { revenue: 0.0, cost: 0.0, qty: 0 });
    const d = byProduct.get(name);
    d.revenue += rev; d.cost += cst; d.qty += qty;
  };
  for (const o of all(`SELECT id, fulfilled_at, COALESCE(fx_rate_to_usd, 1) as fx FROM orders
                       WHERE status = 'fulfilled' AND fulfilled_at IS NOT NULL AND fulfilled_at >= ? AND fulfilled_at <= ? ORDER BY id`, [start, endIncl])) {
    const fx = o.fx;
    let revO = 0.0, costO = 0.0;
    const bucket = d10(o.fulfilled_at);
    for (const line of all(`SELECT * FROM order_box_lines WHERE order_id = ? ORDER BY id`, [o.id])) {
      const lineRev = line.qty_boxes * line.price_per_box * fx;
      revO += lineRev;
      let lineCost = 0.0;
      let names = new Map();
      for (const a of all(`SELECT box_id FROM order_box_allocations WHERE order_box_line_id = ? ORDER BY id`, [line.id])) {
        for (const it of all(`SELECT bi.qty, bi.unit_cost, p.name as product_name FROM box_items bi JOIN variants v ON v.id = bi.variant_id
                              JOIN products p ON p.id = v.product_id WHERE bi.box_id = ? ORDER BY bi.id`, [a.box_id])) {
          lineCost += it.qty * it.unit_cost;
          add(it.product_name, 0.0, it.qty * it.unit_cost, it.qty);
          madd(names, it.product_name, it.qty);
        }
      }
      const ret = one(`SELECT COALESCE(SUM(qty), 0) as q, COALESCE(SUM(cost_usd), 0) as c FROM return_items WHERE order_box_line_id = ?`, [line.id]);
      const comp = mixComposition(line.source_po_id, line.source_label);
      const compPairs = sumv(comp.values()) || 1;
      if (ret.q) {
        lineCost += ret.c;
        for (const [nm, q] of comp) { add(nm, 0.0, ret.c * q / compPairs, ret.q * q); madd(names, nm, ret.q * q); }
      }
      costO += lineCost;
      if (!names.size) names = comp;
      const tot = sumv(names.values()) || 1;
      for (const [nm, q] of names) add(nm, lineRev * q / tot);
      madd(byBucket, bucket, lineRev);
    }
    for (const it of all(`SELECT oi.*, p.name as product_name, p.cost_price FROM order_items oi JOIN variants v ON v.id = oi.variant_id
                          JOIN products p ON p.id = v.product_id WHERE oi.order_id = ? AND oi.box_id IS NULL ORDER BY oi.id`, [o.id])) {
      const unit = it.unit_cost_usd !== null ? it.unit_cost_usd : loosePairCostUsd(it.variant_id, it.cost_price);
      const rev = it.qty * it.unit_price * fx, cst = it.qty * unit;
      revO += rev; costO += cst;
      add(it.product_name, rev, cst, it.qty);
      madd(byBucket, bucket, rev);
    }
    revenue += revO; cost += costO;
    if (byOrder) byOrder.set(o.id, { revenue: revO, cost: costO });
  }
  for (const r of all(`SELECT ri.*, r.created_at as returned_at, COALESCE(o.fx_rate_to_usd, 1) as fx, bl.source_po_id, bl.source_label, p.name as product_name
                       FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN orders o ON o.id = r.order_id
                       LEFT JOIN order_box_lines bl ON bl.id = ri.order_box_line_id LEFT JOIN order_items oi ON oi.id = ri.order_item_id
                       LEFT JOIN variants v ON v.id = oi.variant_id LEFT JOIN products p ON p.id = v.product_id
                       WHERE o.status = 'fulfilled' AND r.created_at >= ? AND r.created_at <= ? ORDER BY ri.id`, [start, endIncl])) {
    const refund = r.refund_amount * r.fx;
    const back = r.restocked ? (r.cost_usd || 0.0) : 0.0;
    revenue -= refund; cost -= back;
    madd(byBucket, d10(r.returned_at), -refund);
    if (r.order_box_line_id) {
      const comp = mixComposition(r.source_po_id, r.source_label);
      const cp = sumv(comp.values()) || 1;
      for (const [nm, q] of comp) add(nm, -refund * q / cp, -back * q / cp, -r.qty * q);
    } else if (r.product_name) add(r.product_name, -refund, -back, -r.qty);
  }
  for (const r of all(`SELECT pp.qty, pp.unit_cost, p.name FROM pair_picks pp JOIN variants v ON v.id = pp.variant_id JOIN products p ON p.id = v.product_id
                       WHERE pp.kind = 'count' AND pp.created_at >= ? AND pp.created_at <= ? ORDER BY pp.id`, [start, endIncl])) {
    cost += r.qty * r.unit_cost;
    add(r.name, 0.0, r.qty * r.unit_cost);
  }
  return [revenue, cost, byBucket, byProduct];
}

// ---------- exchange gains and losses (_exchange_results) ----------
export function exchangeResults(start = '2000-01-01', end = '2999-12-31') {
  const rows = [];
  for (const g of all(`SELECT t.transfer_group, MIN(t.occurred_on) as day, SUM(t.amount * COALESCE(t.fx_rate_to_usd, 1)) as result, COUNT(DISTINCT a.currency_code) as currencies
                       FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id
                       WHERE t.kind = 'transfer' AND t.transfer_group IS NOT NULL GROUP BY t.transfer_group
                       HAVING day >= ? AND day <= ? AND currencies > 1`, [start, end])) {
    if (Math.abs(g.result) < 0.005) continue;
    const legs = all(`SELECT t.amount, a.name, a.currency_code FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id
                      WHERE t.transfer_group = ? ORDER BY t.amount`, [g.transfer_group]);
    const out = legs[0], inn = legs[legs.length - 1];
    rows.push({ day: g.day, kind: 'Conversion', what: `${out.name} → ${inn.name}`, paid_amount: -out.amount, paid_currency: out.currency_code,
      received_amount: inn.amount, received_currency: inn.currency_code, result_usd: g.result, transfer_group: g.transfer_group });
  }
  for (const r of all(`SELECT t.*, a.name as account_name, a.currency_code FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id
                       WHERE t.settled_amount IS NOT NULL AND t.occurred_on >= ? AND t.occurred_on <= ? ORDER BY t.id`, [start, end])) {
    const cash = r.amount * (r.fx_rate_to_usd || 1), settled = r.settled_amount * (r.settled_fx_rate || 1);
    const result = r.amount < 0 ? settled + cash : cash - settled;
    if (Math.abs(result) < 0.005) continue;
    const k = String(r.kind).replace(/_/g, ' ');
    const cashPart = [Math.abs(r.amount), r.currency_code], settledPart = [r.settled_amount, r.settled_currency];
    const [paid, received] = r.amount < 0 ? [cashPart, settledPart] : [settledPart, cashPart];
    rows.push({ day: r.occurred_on, kind: k.charAt(0).toUpperCase() + k.slice(1).toLowerCase(), what: r.description || '',
      paid_amount: paid[0], paid_currency: paid[1], received_amount: received[0], received_currency: received[1], result_usd: result, transfer_group: null });
  }
  rows.sort((a, b) => (String(a.day) < String(b.day) ? -1 : String(a.day) > String(b.day) ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return [rows, rows.reduce((s, r) => s + r.result_usd, 0)];
}
export const exchangeTotal = (s, e) => exchangeResults(s, e)[1];
const sumCorrections = (s, e) => val(`SELECT COALESCE(SUM(amount_usd), 0) FROM cogs_adjustments WHERE adjusted_on >= ? AND adjusted_on <= ?`, [s, e]) || 0;
const sumExpenses = (s, e) => val(`SELECT COALESCE(SUM(amount * COALESCE(fx_rate_to_usd, 1)), 0) FROM expenses WHERE expense_date >= ? AND expense_date <= ?`, [s, e]) || 0;
export function netProfitUsd(start = '2000-01-01', end = '2999-12-31') {
  const [rev, cost] = salesInPeriod(start, end + ' 23:59:59');
  return rev - cost - sumCorrections(start, end) - sumExpenses(start, end) + exchangeTotal(start, end);
}
export const distributedToDate = () => val(`SELECT COALESCE(SUM(total_amount * fx_rate_to_usd), 0) FROM distributions`) || 0;
export function partnerPosition(pid) {
  const rows = all(`SELECT kind, amount, fx_rate_to_usd FROM partner_ledger WHERE partner_id = ? ORDER BY id`, [pid]);
  const tot = k => rows.filter(r => r.kind === k).reduce((s, r) => s + r.amount * (r.fx_rate_to_usd || 1), 0);
  const lent = tot('loan'), repaid = tot('repayment');
  return { lent_usd: lent, repaid_usd: repaid, owed_usd: lent - repaid, distributed_usd: tot('distribution') };
}

// ---------- the period of the overview, P&L, cash flow and costing (_resolve_report_range) ----------
export function resolveRange(preset = '90', start = '', end = '') {
  const T = todayStr();
  if (preset === 'custom') return [preset, start || T.slice(0, 8) + '01', end || T];
  if (preset === 'all') return [preset, '2000-01-01', T];
  const days = parseInt(preset, 10);
  if (!Number.isFinite(days)) return ['90', addDays(T, -90), T];
  return [preset, addDays(T, -days), T];
}

export function overview(preset, start, end) {
  const endI = end + ' 23:59:59';
  const [rev, cost, byBucket0, byProduct] = salesInPeriod(start, endI);
  const span = Math.max(daysBetween(end, start), 1);
  const granularity = span <= 31 ? 'day' : 'month';
  let byBucket = byBucket0;
  if (granularity === 'month') { const m = new Map(); for (const [k, v] of byBucket0) madd(m, k.slice(0, 7), v); byBucket = m; }
  const series = [...byBucket.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const maxRev = Math.max(...series.map(s => s[1]), -Infinity);
  const profitRows = [...byProduct.entries()].map(([name, d]) => {
    const profit = d.revenue - d.cost;
    return { name, revenue: d.revenue, cost: d.cost, profit, margin: d.revenue ? profit / d.revenue * 100 : 0, qty: d.qty };
  });
  profitRows.sort((a, b) => b.revenue - a.revenue);
  const gp = rev - cost;
  const expenses = sumExpenses(start, end), fx = exchangeTotal(start, end), corrections = sumCorrections(start, end);
  return { preset, start, end, granularity, revenue_series: series, max_revenue: (series.length ? maxRev : 1) || 1, profit_rows: profitRows,
    best_sellers: [...profitRows].sort((a, b) => b.qty - a.qty).slice(0, 5), worst_sellers: [...profitRows].sort((a, b) => a.qty - b.qty).slice(0, 5),
    total_revenue: rev, total_cost: cost, gross_profit: gp, gross_margin: rev ? gp / rev * 100 : 0, expenses_total: expenses, fx_total: fx,
    corrections_total: corrections, net_profit: gp - corrections - expenses + fx, stock_value: Q.stockValueLanded(),
    slow_boxes: all(`SELECT b.id, b.box_code, b.source_label, b.source_po_id, b.received_at, CAST(julianday('now') - julianday(b.received_at) AS INTEGER) as age_days,
                     (SELECT COALESCE(SUM(bi.qty), 0) FROM box_items bi WHERE bi.box_id = b.id) as pair_count
                     FROM boxes b WHERE b.status = 'in_stock' ORDER BY b.received_at ASC LIMIT 15`) };
}

export function costCorrectionCheck() {
  const out = [];
  for (const { po_id } of all(`SELECT DISTINCT po_id FROM (SELECT source_po_id AS po_id FROM boxes WHERE source_po_id IS NOT NULL
                                 UNION SELECT po_id FROM cogs_adjustments WHERE po_id IS NOT NULL) ORDER BY po_id`)) {
    const plan = Q.poCostPlan(po_id);
    const e = one(`SELECT COUNT(*) as n, SUM(CASE WHEN source IS NULL THEN 1 ELSE 0 END) as old FROM cogs_adjustments WHERE po_id = ?`, [po_id]);
    const old = e.old || 0;
    if (old || Math.abs(plan.fix) >= 0.01 || Math.abs(plan.instock_change_usd) >= 0.01) {
      out.push({ po_id, entries: e.n, old_entries: old, posted: plan.posted, should_be: plan.should_be, fix: plan.fix, sold_pairs: plan.sold_pairs,
        instock_boxes: plan.instock_boxes, instock_change_usd: plan.instock_change_usd });
    }
  }
  return out;
}

export function pnl(preset, start, end) {
  const endI = end + ' 23:59:59';
  const [netSales, cogsAtSale] = salesInPeriod(start, endI);
  const returns = val(`SELECT COALESCE(SUM(ri.refund_amount * COALESCE(o.fx_rate_to_usd, 1)), 0) FROM return_items ri JOIN returns r ON r.id = ri.return_id
                       JOIN orders o ON o.id = r.order_id WHERE o.status = 'fulfilled' AND r.created_at >= ? AND r.created_at <= ?`, [start, endI]) || 0;
  const adj = sumCorrections(start, end);
  const cogs = cogsAtSale + adj;
  const gp = netSales - cogs;
  const expenseRows = all(`SELECT category, SUM(amount * COALESCE(fx_rate_to_usd, 1)) as total FROM expenses WHERE expense_date >= ? AND expense_date <= ?
                           GROUP BY category ORDER BY total DESC`, [start, end]);
  const totalExpenses = expenseRows.reduce((s, r) => s + r.total, 0);
  const [fxRows, fxTotal] = exchangeResults(start, end);
  const net = gp - totalExpenses + fxTotal;
  return { preset, start, end, fx_rows: fxRows, fx_total: fxTotal,
    cogs_rows: all(`SELECT id, adjusted_on, po_id, description, amount_usd FROM cogs_adjustments WHERE adjusted_on >= ? AND adjusted_on <= ? ORDER BY adjusted_on, id`, [start, end]),
    cost_check: costCorrectionCheck(), gross_sales: netSales + returns, returns_allowances: returns, net_sales: netSales, cogs, cogs_adjustment: adj,
    cogs_at_sale: cogsAtSale, gross_profit: gp, gross_margin: netSales ? gp / netSales * 100 : 0, expense_rows: expenseRows, total_expenses: totalExpenses,
    net_profit: net, net_margin: netSales ? net / netSales * 100 : 0 };
}

export function cashFlow(preset, start, end) {
  const txns = all(`SELECT t.*, a.name as account_name, a.currency_code, t.amount * COALESCE(t.fx_rate_to_usd, 1) as amount_usd
                    FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id WHERE t.occurred_on >= ? AND t.occurred_on <= ? ORDER BY t.occurred_on, t.id`, [start, end]);
  const operating = txns.filter(x => x.kind !== 'transfer'), transfers = txns.filter(x => x.kind === 'transfer');
  const inRows = operating.filter(x => x.amount > 0), outRows = operating.filter(x => x.amount < 0);
  const cashIn = inRows.reduce((s, x) => s + x.amount_usd, 0), cashOut = outRows.reduce((s, x) => s - x.amount_usd, 0);
  const net = cashIn - cashOut;
  const byKind = new Map();
  for (const x of operating) madd(byKind, x.kind, x.amount_usd);
  const accountRows = Q.accountBalances();
  const dayBefore = addDays(start, -1);
  let opening = 0, closing = 0, broughtIn = 0;
  for (const a of Q.accountBalances(true)) {
    const created = d10(a.created_at || start);
    const before = val(`SELECT COALESCE(SUM(amount), 0) FROM cash_transactions WHERE account_id = ? AND occurred_on < ?`, [a.id, start]) || 0;
    const upto = val(`SELECT COALESCE(SUM(amount), 0) FROM cash_transactions WHERE account_id = ? AND occurred_on <= ?`, [a.id, end]) || 0;
    const rs = Q.rateOn(a.currency_code, dayBefore) || 1.0, re = Q.rateOn(a.currency_code, end) || 1.0;
    if (created < start) opening += (a.opening_balance + before) * rs;
    else {
      opening += before * rs;
      if (created <= end) broughtIn += a.opening_balance * (Q.rateOn(a.currency_code, created) || 1.0);
    }
    closing += (a.opening_balance * (created <= end ? 1 : 0) + upto) * re;
  }
  const transfersNet = transfers.reduce((s, x) => s + x.amount_usd, 0);
  return { preset, start, end, cash_in_rows: inRows, cash_out_rows: outRows, transfers, cash_in: cashIn, cash_out: cashOut, net_cash_flow: net,
    by_kind: Object.fromEntries(byKind), account_rows: accountRows, total_cash: accountRows.reduce((s, a) => s + (a.balance_usd ?? 0), 0),
    cash_missing_rate: accountRows.filter(a => a.balance_usd === null), has_accounts: !!val(`SELECT 1 FROM cash_accounts LIMIT 1`),
    reconciliation: { opening, cash_in: cashIn, cash_out: cashOut, brought_in: broughtIn, transfers: transfersNet,
      fx_effect: closing - opening - net - transfersNet - broughtIn, closing, day_before: dayBefore } };
}

export function costing(preset, start, end) {
  const rows = all(`SELECT p.id as product_id, p.name as product_name, p.image_filename, SUM(${Q.BOX_PAIRS_SQL}) as qty_in_stock,
                           SUM((${Q.BOX_PAIRS_SQL}) * bi.unit_cost) as total_value
                    FROM box_items bi JOIN boxes b ON b.id = bi.box_id JOIN variants v ON v.id = bi.variant_id JOIN products p ON p.id = v.product_id
                    WHERE b.status IN ('in_stock', 'open') GROUP BY p.id ORDER BY total_value DESC`).map(r => ({ ...r, avg_cost: r.qty_in_stock ? r.total_value / r.qty_in_stock : 0 }));
  const [, , , byProduct] = salesInPeriod(start, end + ' 23:59:59');
  const cogsRows = [...byProduct.entries()].filter(([, d]) => d.cost).map(([name, d]) => ({ name, cogs: d.cost })).sort((a, b) => b.cogs - a.cogs);
  return { preset, start, end, valuation_rows: rows, total_inventory_value: rows.reduce((s, r) => s + r.total_value, 0),
    total_pairs_in_stock: rows.reduce((s, r) => s + r.qty_in_stock, 0), cogs_rows: cogsRows, total_cogs: cogsRows.reduce((s, r) => s + r.cogs, 0),
    cost_trend: all(`SELECT bg.received_at, bg.label, po.id as po_id, s.name as supplier_name,
                       (SELECT COALESCE(SUM(bi.unit_cost * bi.qty), 0) / NULLIF(SUM(bi.qty), 0) FROM box_items bi JOIN boxes b ON b.id = bi.box_id
                        WHERE b.source_po_id = po.id AND b.source_label = bg.label) as landed_cost_per_pair
                     FROM po_box_groups bg JOIN purchase_orders po ON po.id = bg.po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
                     WHERE bg.received_at IS NOT NULL ORDER BY bg.received_at DESC LIMIT 20`) };
}

// ---------- the balance sheet (_financial_position, report_balance_sheet) ----------
export function orderPositionOn(orderId, end) {
  const value = (val(`SELECT COALESCE(SUM(qty_boxes * price_per_box), 0) FROM order_box_lines WHERE order_id = ?`, [orderId]) || 0)
    + (val(`SELECT COALESCE(SUM(qty * unit_price), 0) FROM order_items WHERE order_id = ? AND box_id IS NULL`, [orderId]) || 0);
  const refunds = val(`SELECT COALESCE(SUM(ri.refund_amount), 0) FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE r.order_id = ? AND r.created_at <= ?`, [orderId, end]) || 0;
  const paid = val(`SELECT COALESCE(SUM(ip.amount), 0) FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.order_id = ? AND ip.paid_at <= ?`, [orderId, end]) || 0;
  return [value - refunds, paid];
}
function poPaidUsd(poId) {
  return (val(`SELECT COALESCE(SUM(CASE WHEN settled_amount IS NOT NULL THEN settled_amount * COALESCE(settled_fx_rate, 1) ELSE -amount * COALESCE(fx_rate_to_usd, 1) END), 0)
               FROM cash_transactions WHERE ref_type = 'purchase_order' AND ref_id = ?`, [poId]) || 0)
    + (val(`SELECT COALESCE(SUM(amount * COALESCE(fx_rate_to_usd, 1)), 0) FROM partner_ledger WHERE ref_type = 'purchase_order' AND ref_id = ? AND method = 'direct'`, [poId]) || 0);
}
export const EQUITY_LABELS = ['Money in your accounts when you started (opening balances)', 'Stock entered by hand (opening stock and adjustments)', 'Manual account adjustments',
  'Net profit to date', 'Profit shared out to partners', 'Exchange differences — rate movements on money and debts in GNF/CNY (no money exchanged)',
  'Expenses recorded without an account or partner paying them', 'Customer payments not put in any account', 'Money received linked to a sale that was deleted',
  'Rounding of per-pair landed costs (fractions of a cent)'];
export function financialPosition() {
  const rates = new Map();
  const closing = code => { if (!rates.has(code)) rates.set(code, Q.rateOn(code)); return rates.get(code); };
  const missing = new Set();
  const accounts = Q.accountBalances(true);
  let cashNow = 0, cashBooked = 0, capital = 0;
  for (const a of accounts) {
    const openRate = Q.rateOn(a.currency_code, d10(a.created_at || todayStr())) || 1.0;
    const moved = val(`SELECT COALESCE(SUM(amount * COALESCE(fx_rate_to_usd, 1)), 0) FROM cash_transactions WHERE account_id = ?`, [a.id]) || 0;
    capital += a.opening_balance * openRate;
    cashBooked += a.opening_balance * openRate + moved;
    if (a.balance_usd === null) { missing.add(a.currency_code); cashNow += a.opening_balance * openRate + moved; } else cashNow += a.balance_usd;
  }
  const adjustments = val(`SELECT COALESCE(SUM(amount * COALESCE(fx_rate_to_usd, 1)), 0) FROM cash_transactions WHERE kind = 'adjustment'`) || 0;
  let receivables = 0, unbilled = 0, credits = 0, custNow = 0, custBooked = 0;
  for (const o of all(`SELECT o.id, o.status, o.currency_code, o.fx_rate_to_usd FROM orders o WHERE o.status = 'fulfilled'
                       OR EXISTS (SELECT 1 FROM invoices i JOIN invoice_payments ip ON ip.invoice_id = i.id WHERE i.order_id = o.id) ORDER BY o.id`)) {
    const fulfilled = o.status === 'fulfilled' && o.fx_rate_to_usd !== null;
    const [value, paid] = orderPositionOn(o.id, '9999-12-31');
    const position = fulfilled ? value - paid : -paid;
    let received = 0;
    for (const p of all(`SELECT ip.amount, ip.paid_at FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.order_id = ? ORDER BY ip.id`, [o.id])) {
      received += p.amount * (Q.rateOn(o.currency_code, d10(p.paid_at)) || o.fx_rate_to_usd || 1.0);
    }
    const booked = fulfilled ? value * o.fx_rate_to_usd - received : -received;
    const rate = closing(o.currency_code);
    if (rate === null) missing.add(o.currency_code);
    const now = rate !== null ? position * rate : booked;
    custBooked += booked; custNow += now;
    if (now > 0.004) {
      if (val(`SELECT 1 FROM invoices WHERE order_id = ? AND status != 'void'`, [o.id])) receivables += now; else unbilled += now;
    } else if (now < -0.004) credits += -now;
  }
  let notInAccount = 0;
  for (const p of all(`SELECT ip.amount, ip.paid_at, o.currency_code FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id JOIN orders o ON o.id = i.order_id
                       WHERE NOT EXISTS (SELECT 1 FROM cash_transactions t WHERE t.ref_type = 'invoice_payment' AND t.ref_id = ip.id) ORDER BY ip.id`)) {
    notInAccount += p.amount * (Q.rateOn(p.currency_code, d10(p.paid_at)) || 1.0);
  }
  const unlinkedReceived = val(`SELECT COALESCE(SUM(amount * COALESCE(fx_rate_to_usd, 1)), 0) FROM cash_transactions t WHERE t.ref_type = 'invoice_payment'
                                AND NOT EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.id = t.ref_id)`) || 0;
  let payables = 0, advances = 0, rounding = 0;
  const poRows = [];
  for (const po of all(`SELECT id FROM purchase_orders ORDER BY id`)) {
    const plan = Q.poCostPlan(po.id);
    const received = plan.items.reduce((s, i) => s + i.target * i.qty, 0);
    const paid = poPaidUsd(po.id);
    const position = received - paid;
    if (Math.abs(position) < 0.05 && plan.items.length) { rounding += position; continue; }
    if (Math.abs(position) >= 0.005) poRows.push({ po_id: po.id, received, paid, position });
    if (position > 0) payables += position; else advances += -position;
  }
  const unlinkedPaid = -(val(`SELECT COALESCE(SUM(amount * COALESCE(fx_rate_to_usd, 1)), 0) FROM cash_transactions WHERE kind = 'supplier_payment'
                              AND (ref_type IS NULL OR ref_type != 'purchase_order' OR NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = ref_id))`) || 0)
    + (val(`SELECT COALESCE(SUM(amount * COALESCE(fx_rate_to_usd, 1)), 0) FROM partner_ledger WHERE method = 'direct' AND kind = 'loan'
            AND (ref_type IS NULL OR (ref_type = 'purchase_order' AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = ref_id)))`) || 0);
  const inventory = Q.stockValueLanded();
  const boxed = val(`SELECT COALESCE(SUM((${Q.BOX_PAIRS_SQL}) * bi.unit_cost), 0) FROM box_items bi JOIN boxes b ON b.id = bi.box_id WHERE b.status IN ('in_stock', 'open')`) || 0;
  const looseSold = val(`SELECT COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM pair_picks pp WHERE pp.order_item_id = oi.id AND pp.kind = 'sale')
                                THEN (SELECT COALESCE(SUM(pp.qty * pp.unit_cost), 0) FROM pair_picks pp WHERE pp.order_item_id = oi.id AND pp.kind = 'sale' AND pp.box_id IS NULL)
                                ELSE oi.qty * COALESCE(oi.unit_cost_usd, 0) END), 0)
                         FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.box_id IS NULL AND o.status = 'fulfilled'`) || 0;
  const looseBack = val(`SELECT COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM pair_picks pp WHERE pp.return_item_id = ri.id)
                                THEN (SELECT COALESCE(SUM(pp.qty * pp.unit_cost), 0) FROM pair_picks pp WHERE pp.return_item_id = ri.id AND pp.box_id IS NULL)
                                ELSE COALESCE(ri.cost_usd, 0) END), 0)
                         FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN orders o ON o.id = r.order_id
                         WHERE ri.order_item_id IS NOT NULL AND ri.restocked = 1 AND o.status = 'fulfilled'`) || 0;
  const handStock = (inventory - boxed) + looseSold - looseBack;
  const OWED = `SUM(CASE WHEN kind = 'loan' THEN amount WHEN kind = 'repayment' THEN -amount ELSE 0 END)`;
  const BOOKED = `SUM(CASE WHEN kind = 'loan' THEN amount WHEN kind = 'repayment' THEN -amount ELSE 0 END * COALESCE(fx_rate_to_usd, 1))`;
  const partnerList = [];
  for (const pr of all(`SELECT id, name FROM partners ORDER BY name`)) {
    let now = 0;
    for (const r of all(`SELECT currency_code, ${OWED} as owed, ${BOOKED} as booked FROM partner_ledger WHERE partner_id = ? GROUP BY currency_code`, [pr.id])) {
      const rate = closing(r.currency_code);
      now += rate !== null ? (r.owed || 0) * rate : (r.booked || 0);
    }
    if (Math.abs(now) >= 0.005) partnerList.push({ id: pr.id, name: pr.name, owed: now });
  }
  let loansNow = 0, loansBooked = 0;
  for (const r of all(`SELECT currency_code, ${OWED} as owed, ${BOOKED} as booked FROM partner_ledger GROUP BY currency_code`)) {
    const rate = closing(r.currency_code);
    if (rate === null) missing.add(r.currency_code);
    loansBooked += r.booked || 0;
    loansNow += rate !== null ? (r.owed || 0) * rate : (r.booked || 0);
  }
  const profit = netProfitUsd(), distributed = distributedToDate();
  const unpaidExpenses = val(`SELECT COALESCE(SUM(e.amount * COALESCE(e.fx_rate_to_usd, 1)), 0) FROM expenses e
                              WHERE NOT EXISTS (SELECT 1 FROM cash_transactions t WHERE t.ref_type = 'expense' AND t.ref_id = e.id)
                                AND NOT EXISTS (SELECT 1 FROM partner_ledger pl WHERE pl.ref_type = 'expense' AND pl.ref_id = e.id)`) || 0;
  const revaluation = (cashNow - cashBooked) + (custNow - custBooked) - (loansNow - loansBooked);
  const totalAssets = cashNow + receivables + unbilled + inventory + advances + unlinkedPaid;
  const totalLiabilities = payables + loansNow + credits;
  const vals = [capital, handStock, adjustments, profit, -distributed, revaluation, unpaidExpenses, -notInAccount, unlinkedReceived, rounding];
  const equityItems = EQUITY_LABELS.map((l, i) => [l, vals[i]]);
  const equity = vals.reduce((s, v) => s + v, 0);
  return { accounts, cash: cashNow, capital, adjustments, receivables, unbilled, customer_credits: credits, not_in_account: notInAccount,
    unlinked_received: unlinkedReceived, payables, advances, unlinked_paid: unlinkedPaid, po_rows: poRows, inventory, hand_stock: handStock,
    partner_list: partnerList, partner_loans: loansNow, total_assets: totalAssets, total_liabilities: totalLiabilities, net_assets: totalAssets - totalLiabilities,
    equity_items: equityItems, equity, profit, distributed, difference: totalAssets - totalLiabilities - equity, missing_rates: [...missing].sort() };
}
export function balanceSheet() {
  const inventory = Q.stockValueLanded();
  const ar = all(`SELECT id FROM invoices WHERE status != 'void' ORDER BY id`).reduce((s, i) => s + Q.invoiceFinancials(i.id).balance_usd, 0);
  const accountRows = Q.accountBalances();
  const totalCash = accountRows.reduce((s, a) => s + (a.balance_usd ?? 0), 0);
  const totalAssets = totalCash + inventory + ar;
  const partnerRows = all(`SELECT * FROM partners ORDER BY name`).map(p => ({ ...p, ...partnerPosition(p.id) })).filter(p => Math.abs(p.owed_usd) > 0.004);
  const loans = partnerRows.reduce((s, p) => s + p.owed_usd, 0);
  return { inventory_value: inventory, accounts_receivable: ar, account_rows: accountRows, total_cash: totalCash, cash_missing_rate: accountRows.filter(a => a.balance_usd === null),
    has_accounts: accountRows.length > 0, total_assets: totalAssets, partner_rows: partnerRows, partner_loans: loans, net_worth: totalAssets - loans,
    profit_to_date: netProfitUsd(), distributed_to_date: distributedToDate(), fp: financialPosition() };
}

// ---------- daily report (_daily_report) ----------
function byCurrency(amounts) {
  return [...amounts.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).filter(([, v]) => Math.abs(v) > 0.004).map(([code, amount]) => ({ code, amount }));
}
export function owedAt(end) {
  let owed = 0, niUsd = 0;
  const ni = [];
  for (const o of all(`SELECT o.id, COALESCE(o.fx_rate_to_usd, 1) as fx, EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id AND i.issued_at <= ?) as invoiced
                       FROM orders o WHERE o.status = 'fulfilled' AND o.fulfilled_at <= ? ORDER BY o.id`, [end, end])) {
    const [due, paid] = orderPositionOn(o.id, end);
    const left = Math.max(due - paid, 0) * o.fx;
    if (o.invoiced) owed += left;
    else if (left > 0.004) { ni.push(o); niUsd += left; }
  }
  return [owed, ni, niUsd];
}
export function dailyReport(d) {
  const end = d + ' 23:59:59';
  const byOrder = new Map();
  const [revenue, cost] = salesInPeriod(d, end, byOrder);
  const salesGross = sumv([...byOrder.values()].map(v => v.revenue));
  const corrections = all(`SELECT po_id, SUM(amount_usd) as amount_usd FROM cogs_adjustments WHERE adjusted_on = ? GROUP BY po_id ORDER BY MIN(id)`, [d]);
  const adjustment = corrections.reduce((s, r) => s + r.amount_usd, 0);
  const gp = revenue - cost;
  const orders = [];
  const salesByCur = new Map();
  let boxesSold = 0, pairsSold = 0;
  for (const o of all(`SELECT o.id, o.currency_code, COALESCE(o.fx_rate_to_usd, 1) as fx, o.fulfilled_at, c.name as customer_name FROM orders o
                       LEFT JOIN customers c ON c.id = o.customer_id WHERE o.status = 'fulfilled' AND o.fulfilled_at >= ? AND o.fulfilled_at <= ? ORDER BY o.fulfilled_at, o.id`, [d, end])) {
    const lines = [];
    let ob = 0, op = 0;
    for (const bl of Q.orderBoxLines(o.id)) {
      ob += bl.qty_boxes; op += bl.qty_boxes * (bl.pairs_per_box || 0);
      lines.push({ what: bl.source_label, loose: false, boxes: bl.qty_boxes, pairs: bl.qty_boxes * (bl.pairs_per_box || 0), price_per_pair: bl.price_per_pair, amount: bl.qty_boxes * bl.price_per_box });
    }
    for (const it of all(`SELECT oi.*, p.name as product_name, v.color, v.size FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
                          WHERE oi.order_id = ? AND oi.box_id IS NULL ORDER BY oi.id`, [o.id])) {
      op += it.qty;
      lines.push({ what: `${it.product_name}${it.color ? ' ' + it.color : ''} ${it.size}`, loose: true, boxes: 0, pairs: it.qty, price_per_pair: it.unit_price, amount: it.qty * it.unit_price });
    }
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const inv = Q.activeInvoice(o.id);
    const [dueEod, paid] = orderPositionOn(o.id, end);
    let status = !inv ? 'not invoiced' : paid >= dueEod - 0.004 ? 'paid' : paid > 0.004 ? 'part paid' : 'owed';
    const fig = byOrder.get(o.id) || { revenue: total * o.fx, cost: 0.0 };
    status = dueEod > 0.004 || status === 'not invoiced' ? status : 'returned';
    madd(salesByCur, o.currency_code, total);
    boxesSold += ob; pairsSold += op;
    orders.push({ id: o.id, customer: o.customer_name, currency_code: o.currency_code, lines, boxes: ob, pairs: op, total, total_usd: fig.revenue,
      profit_usd: fig.revenue - fig.cost, paid, owed: Math.max(dueEod - paid, 0), status, invoice_number: inv ? inv.invoice_number : null });
  }
  const payments = all(`SELECT ip.*, i.invoice_number, o.id as order_id, o.currency_code, COALESCE(o.fx_rate_to_usd, 1) as fx, c.name as customer_name,
                          (SELECT a.name FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id WHERE t.ref_type = 'invoice_payment' AND t.ref_id = ip.id LIMIT 1) as account_name
                        FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = o.customer_id
                        WHERE ip.paid_at >= ? AND ip.paid_at <= ? AND i.status != 'void' ORDER BY ip.paid_at, ip.id`, [d, end]);
  const collectedByCur = new Map();
  let collectedUsd = 0;
  for (const p of payments) { madd(collectedByCur, p.currency_code, p.amount); collectedUsd += p.amount * p.fx; }
  const returns = all(`SELECT r.order_id, r.reason, ri.qty, ri.restocked, ri.refund_amount, ri.order_box_line_id, o.currency_code, COALESCE(o.fx_rate_to_usd, 1) as fx, c.name as customer_name
                       FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN orders o ON o.id = r.order_id LEFT JOIN customers c ON c.id = o.customer_id
                       WHERE o.status = 'fulfilled' AND r.created_at >= ? AND r.created_at <= ? ORDER BY ri.id`, [d, end]).map(r => ({ ...r, unit: r.order_box_line_id ? 'box(es)' : 'pair(s)' }));
  const returnsUsd = returns.reduce((s, r) => s + r.refund_amount * r.fx, 0);
  const expenses = all(`SELECT * FROM expenses WHERE expense_date = ? ORDER BY id`, [d]).map(e => ({ ...e, usd: e.amount * (e.fx_rate_to_usd || 1) }));
  const expensesUsd = expenses.reduce((s, e) => s + e.usd, 0);
  const [owed, ni, niUsd] = owedAt(end);
  const monthStart = d.slice(0, 8) + '01';
  const [mtdRev, mtdCost] = salesInPeriod(monthStart, end);
  const mtdAdj = sumCorrections(monthStart, d), mtdExp = sumExpenses(monthStart, d);
  const mtdGp = mtdRev - mtdCost;
  const [fxRows, fxDay] = exchangeResults(d, d);
  const mtdFx = exchangeTotal(monthStart, d);
  const stock = one(`SELECT COUNT(*) as boxes, COALESCE((SELECT SUM(bi.qty) FROM box_items bi JOIN boxes b2 ON b2.id = bi.box_id WHERE b2.status = 'in_stock'), 0) as pairs
                     FROM boxes WHERE status = 'in_stock'`);
  return { day: d, orders, order_count: orders.length, boxes_sold: boxesSold, pairs_sold: pairsSold, sales: byCurrency(salesByCur), revenue_usd: salesGross,
    net_sales_usd: revenue, cost_usd: cost, corrections, corrections_usd: adjustment, gross_profit_usd: gp, margin: revenue > 0.004 ? gp / revenue * 100 : null,
    payments, collected: byCurrency(collectedByCur), collected_usd: collectedUsd, returns, returns_usd: returnsUsd, expenses, expenses_usd: expensesUsd,
    fx_rows: fxRows, fx_usd: fxDay, net_usd: gp - adjustment - expensesUsd + fxDay, owed_usd: owed, not_invoiced_count: ni.length, not_invoiced_usd: niUsd,
    mtd_revenue_usd: mtdRev, mtd_gross_profit_usd: mtdGp, mtd_margin: mtdRev ? mtdGp / mtdRev * 100 : null, mtd_expenses_usd: mtdExp, mtd_fx_usd: mtdFx,
    mtd_corrections_usd: mtdAdj, mtd_net_usd: mtdGp - mtdAdj - mtdExp + mtdFx, stock_boxes: stock.boxes, stock_pairs: stock.pairs,
    stock_value_usd: Q.stockValueLanded(), is_today: d === todayStr() };
}

// ---------- sales report for any dates, and the monthly report ----------
function periodTotals(s, e) {
  const [netSales, cost, , byProduct] = salesInPeriod(s, e + ' 23:59:59');
  const corrections = sumCorrections(s, e), expenses = sumExpenses(s, e), fx = exchangeTotal(s, e);
  const gp = netSales - cost;
  return { net_sales: netSales, cost, gross_profit: gp, corrections, expenses, fx, net: gp - corrections - expenses + fx, by_product: byProduct };
}
export function salesReport(start, end, group = 'day', compare = null) {
  const byDay = (sql) => new Map(all(sql, [start, end]).map(r => { const v = Object.values(r); return [d10(v[0]), v[1] || 0.0]; }));
  const collected = byDay(`SELECT substr(ip.paid_at, 1, 10) as d, SUM(ip.amount * COALESCE(o.fx_rate_to_usd, 1)) as v FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id
                           JOIN orders o ON o.id = i.order_id WHERE i.status != 'void' AND substr(ip.paid_at, 1, 10) >= ? AND substr(ip.paid_at, 1, 10) <= ? GROUP BY d`);
  const refunds = byDay(`SELECT substr(r.created_at, 1, 10) as d, SUM(ri.refund_amount * COALESCE(o.fx_rate_to_usd, 1)) as v FROM return_items ri JOIN returns r ON r.id = ri.return_id
                         JOIN orders o ON o.id = r.order_id WHERE o.status = 'fulfilled' AND substr(r.created_at, 1, 10) >= ? AND substr(r.created_at, 1, 10) <= ? GROUP BY d`);
  const expenses = byDay(`SELECT expense_date, SUM(amount * COALESCE(fx_rate_to_usd, 1)) as v FROM expenses WHERE expense_date >= ? AND expense_date <= ? GROUP BY expense_date`);
  const corrections = byDay(`SELECT adjusted_on, SUM(amount_usd) as v FROM cogs_adjustments WHERE adjusted_on >= ? AND adjusted_on <= ? GROUP BY adjusted_on`);
  const fx = new Map();
  for (const r of exchangeResults(start, end)[0]) madd(fx, d10(r.day), r.result_usd);
  const summed = (m, a, b) => { let s = 0; for (const [k, v] of m) if (a <= k && k <= b) s += v; return s; };
  const periods = [];
  for (let d = start; d <= end;) {
    let pe;
    if (group === 'month') { pe = addDays(shiftMonths(d, 1), -1); if (pe > end) pe = end; }
    else if (group === 'week') { pe = addDays(d, 6 - weekday(d)); if (pe > end) pe = end; }
    else pe = d;
    periods.push([d, pe]);
    d = addDays(pe, 1);
  }
  const rows = [], salesByCur = new Map(), customers = new Map();
  for (const [ps, pe] of periods) {
    const byOrder = new Map();
    const [netSales, cost] = salesInPeriod(ps, pe + ' 23:59:59', byOrder);
    let boxes = 0, pairs = 0;
    for (const [oid, fig] of byOrder) {
      const o = one(`SELECT o.currency_code, c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [oid]);
      let value = 0, ob = 0;
      for (const bl of Q.orderBoxLines(oid)) { ob += bl.qty_boxes; pairs += bl.qty_boxes * (bl.pairs_per_box || 0); value += bl.qty_boxes * bl.price_per_box; }
      const loose = one(`SELECT COALESCE(SUM(qty), 0) as q, COALESCE(SUM(qty * unit_price), 0) as v FROM order_items WHERE order_id = ? AND box_id IS NULL`, [oid]);
      pairs += loose.q; value += loose.v; boxes += ob;
      madd(salesByCur, o.currency_code, value);
      const name = o.name || 'Walk-in';
      if (!customers.has(name)) customers.set(name, { name, orders: 0, boxes: 0, usd: 0.0 });
      const cu = customers.get(name);
      cu.orders += 1; cu.boxes += ob; cu.usd += fig.revenue;
    }
    const gp = netSales - cost;
    const row = { day: ps, end_day: pe, kind: group, orders: byOrder.size, boxes, pairs, sales: sumv([...byOrder.values()].map(v => v.revenue)),
      returns: summed(refunds, ps, pe), net_sales: netSales, cost, gross_profit: gp, margin: netSales > 0.004 ? gp / netSales * 100 : null,
      expenses: summed(expenses, ps, pe), fx: summed(fx, ps, pe), corrections: summed(corrections, ps, pe), collected: summed(collected, ps, pe) };
    row.other = row.fx - row.corrections;
    row.net = gp - row.corrections - row.expenses + row.fx;
    row.quiet = !['sales', 'returns', 'cost', 'expenses', 'fx', 'corrections', 'collected'].some(k => Math.abs(row[k]) > 0.004);
    rows.push(row);
  }
  const keys = ['orders', 'boxes', 'pairs', 'sales', 'returns', 'net_sales', 'cost', 'gross_profit', 'expenses', 'fx', 'corrections', 'other', 'net', 'collected'];
  const total = Object.fromEntries(keys.map(k => [k, rows.reduce((s, r) => s + r[k], 0)]));
  total.margin = total.net_sales > 0.004 ? total.gross_profit / total.net_sales * 100 : null;
  if (!compare) {
    const n = daysBetween(end, start) + 1, months = wholeMonths(start, end);
    compare = months ? [shiftMonths(start, -months), addDays(start, -1)] : [addDays(start, -n), addDays(start, -1)];
  }
  const prev = periodTotals(compare[0], compare[1]);
  const change = (now, before) => (Math.abs(before) > 0.004 ? (now - before) / Math.abs(before) * 100 : null);
  const range = periodTotals(start, end);
  const styles = [...range.by_product.entries()].filter(([, v]) => v.qty).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.qty - a.qty).slice(0, 5);
  const dayRows = group === 'day' ? rows.filter(r => r.sales > 0.004) : [];
  const [owed, , niUsd] = owedAt(end + ' 23:59:59');
  let best = null;
  for (const r of dayRows) if (!best || r.sales > best.sales) best = r;
  return { start, end, group, rows, total, sales: byCurrency(salesByCur), prev: { ...prev, by_product: undefined }, compare,
    change_sales: change(total.net_sales, prev.net_sales), change_gp: change(total.gross_profit, prev.gross_profit), change_net: change(total.net, prev.net),
    best_day: best, selling_days: dayRows.length, customers: [...customers.values()].sort((a, b) => b.usd - a.usd).slice(0, 5), styles,
    owed_usd: owed, not_invoiced_usd: niUsd, pnl_net: range.net };
}
export function monthlyReport(y, m) {
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = addDays(shiftMonths(first, 1), -1);
  const T = todayStr();
  const upto = last < T ? last : T;
  const prevLast = addDays(first, -1);
  const rep = salesReport(first, upto, 'day', [prevLast.slice(0, 8) + '01', prevLast]);
  return { ...rep, year: y, month: m, end: last, upto, complete: upto >= last, prev_name: [+prevLast.slice(0, 4), +prevLast.slice(5, 7)] };
}
// _report_range — the dates of the sales report from a preset or start/end, and the grouping.
export function salesRange(preset = '', start = '', end = '', group = '') {
  const T = todayStr();
  const ws = addDays(T, -weekday(T));
  const P = {
    today: [T, T], yesterday: [addDays(T, -1), addDays(T, -1)], this_week: [ws, T], last_week: [addDays(ws, -7), addDays(ws, -1)],
    last_7: [addDays(T, -6), T], last_30: [addDays(T, -29), T], this_month: [T.slice(0, 8) + '01', T],
    last_month: [shiftMonths(T.slice(0, 8) + '01', -1), addDays(T.slice(0, 8) + '01', -1)],
    this_year: [T.slice(0, 5) + '01-01', T], last_year: [`${+T.slice(0, 4) - 1}-01-01`, addDays(T.slice(0, 5) + '01-01', -1)]
  };
  let s, e;
  const ok = x => /^\d{4}-\d{2}-\d{2}$/.test(x || '');
  if (preset === 'all') {
    const first = val(`SELECT MIN(d) FROM (SELECT MIN(substr(fulfilled_at, 1, 10)) as d FROM orders WHERE fulfilled_at IS NOT NULL
                       UNION ALL SELECT MIN(expense_date) FROM expenses UNION ALL SELECT MIN(occurred_on) FROM cash_transactions
                       UNION ALL SELECT MIN(substr(paid_at, 1, 10)) FROM invoice_payments UNION ALL SELECT MIN(substr(created_at, 1, 10)) FROM returns
                       UNION ALL SELECT MIN(adjusted_on) FROM cogs_adjustments) WHERE d IS NOT NULL`);
    s = first ? d10(first) : T; e = T;
  } else if (P[preset]) [s, e] = P[preset];
  else { preset = ''; s = ok(start) ? start : T.slice(0, 8) + '01'; e = ok(end) ? end : T; }
  if (e > T) e = T;
  if (s > e) s = e;
  if (s < '2000-01-01') s = '2000-01-01';
  const n = daysBetween(e, s) + 1;
  if (!['day', 'week', 'month'].includes(group)) group = n <= 62 ? 'day' : n <= 190 ? 'week' : 'month';
  if (group === 'day' && n > 400) group = 'month';
  return [s, e, group, preset];
}

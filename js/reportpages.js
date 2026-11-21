// Report pages: overview, profit and loss, cash flow, costing, balance sheet, daily report,
// sales report for any dates, monthly report. The figures come from js/reports.js.
import { all } from './localdb.js';
import * as R from './reports.js';
import * as F from './ops/finance.js';
import { t, lang } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtNum, fmtDate, fmtShort, today, pyRound } from './util.js';
import { header, tile, tiles, panel, pill, empty, table } from './ui.js';
import { confirmAction } from './forms.js';
import { registerActions } from './actions.js';
import { go, schedule } from './app.js';
import { poNo, csvCell, downloadText } from './buy.js';
import { orderNo } from './sell.js';
import { addDays } from './buying.js';
import { latestRate } from './queries.js';

const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));
const usd = v => fmtUsd(v || 0);
const net = v => (v <= -0.005 ? '−' + fmtUsd(Math.abs(v)) : fmtUsd(Math.max(v || 0, 0)));
const signed = v => (Math.abs(v || 0) < 0.005 ? fmtUsd(0) : (v > 0 ? '+' : '−') + fmtUsd(Math.abs(v)));
const big = v => esc(Math.abs(v) >= 100000 ? fmtShort(v) : fmtUsd(v));
const pct = v => (v === null || v === undefined ? '—' : `${fmtNum(v, 1)} %`);
const cls = v => (v < -0.004 ? 'neg' : '');
const FR_DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'], EN_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FR_MON = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'], EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fr = () => lang() === 'fr';
const longDate = d => `${(fr() ? FR_DAYS : EN_DAYS)[R.weekday(d)]} ${+d.slice(8)} ${(fr() ? FR_MONTHS : EN_MONTHS)[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const monthName = (y, m) => `${(fr() ? FR_MONTHS : EN_MONTHS)[m - 1]} ${y}`;
const shortDate = (d, year = false) => `${+d.slice(8)} ${(fr() ? FR_MON : EN_MON)[+d.slice(5, 7) - 1]}${year ? ' ' + d.slice(0, 4) : ''}`;
function rangeLabel(s, e) {
  if (s.slice(8) === '01' && addDays(e, 1).slice(8) === '01' && s.slice(0, 7) === e.slice(0, 7)) return monthName(+s.slice(0, 4), +s.slice(5, 7));
  if (s === e) return longDate(s);
  return `${shortDate(s, s.slice(0, 4) !== e.slice(0, 4))} – ${shortDate(e, true)}`;
}
function rowLabel(r, withMonth = false) {
  const d = r.day, e = r.end_day;
  if (r.kind === 'month') return monthName(+d.slice(0, 4), +d.slice(5, 7));
  if (r.kind === 'week') return d.slice(5, 7) === e.slice(5, 7) ? `${+d.slice(8)}–${shortDate(e)}` : `${shortDate(d)} – ${shortDate(e)}`;
  const l = `${(fr() ? FR_DAYS : EN_DAYS)[R.weekday(d)].slice(0, 3)} ${+d.slice(8)}`;
  return withMonth ? `${l} ${(fr() ? FR_MON : EN_MON)[+d.slice(5, 7) - 1]}` : l;
}

export function reportsNav(cur) {
  const items = [['reports', t('Overview')], ['daily', t('Daily report')], ['sales', t('Sales')], ['monthly', t('Monthly')], ['pnl', t('Profit & loss')],
    ['cashflow', t('Cash flow')], ['costing', t('Costing')], ['balance', t('Balance sheet')]];
  return `<nav class="subnav">${items.map(([k, l]) => `<a href="#/${k}"${cur === k ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;
}
// The period chips of the overview, P&L, cash flow and costing pages.
function rangeBar(page, preset, start, end) {
  const chips = [['7', t('7 days')], ['30', t('30 days')], ['90', t('90 days')], ['365', t('1 year')], ['all', t('All')]]
    .map(([k, l]) => `<a class="chip" href="#/${page}/${k}" aria-pressed="${preset === k}">${esc(l)}</a>`).join('');
  return `<div class="inline rbar"><div class="chips">${chips}</div><form class="dates" data-range="${page}"><input class="inp" type="date" name="s" value="${esc(start)}" max="${today()}">
    <span>→</span><input class="inp" type="date" name="e" value="${esc(end)}" max="${today()}"><button class="btn sm">${esc(t('Show'))}</button></form></div>`;
}
const rangeArgs = (a) => (a[0] === 'custom' ? R.resolveRange('custom', a[1], a[2]) : R.resolveRange(a[0] || '90'));
const periodText = (s, e) => `${fmtDate(s)} → ${fmtDate(e)}`;

// ---------- overview ----------
function overview(...a) {
  const [preset, s, e] = rangeArgs(a);
  const r = R.overview(preset, s, e);
  const max = Math.max(...r.revenue_series.map(x => x[1]), 1);
  const bars = r.revenue_series.length ? `<div class="bars">${r.revenue_series.map(([k, v]) => `<div class="bar-row"><span>${esc(k.length === 7 ? monthName(+k.slice(0, 4), +k.slice(5, 7)) : fmtDate(k))}</span><b>${esc(usd(v))}</b>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, v / max * 100)).toFixed(1)}%"></div></div></div>`).join('')}</div>` : empty(t('No sales in this period.'));
  return header(t('Reports'), { sub: esc(periodText(s, e)) }) + reportsNav('reports') + rangeBar('reports', preset, s, e)
    + tiles([tile(t('Sales'), big(r.total_revenue), esc(t('net of returns'))), tile(t('Gross profit'), big(r.gross_profit), esc(pct(r.gross_margin))),
      tile(t('Expenses'), big(r.expenses_total), r.fx_total ? esc(t('exchange {r}', { r: signed(r.fx_total) })) : ''), tile(t('Net profit'), big(r.net_profit), r.corrections_total ? esc(t('after {c} of cost corrections', { c: usd(r.corrections_total) })) : '', '', cls(r.net_profit))])
    + `<div class="grid2">${panel(r.granularity === 'day' ? t('Sales by day') : t('Sales by month'), `<div class="panel-b">${bars}</div>`)}
      ${panel(t('Best sellers'), table([{ h: t('Style') }, { h: t('pairs'), n: true }, { h: t('Sales'), n: true }], r.best_sellers.map(x => ({ cells: [esc(x.name), fmtNum(x.qty), esc(usd(x.revenue))] })), { emptyText: '—' }), { tight: true })}</div>`
    + panel(t('Profit by style'), table([{ h: t('Style') }, { h: t('pairs'), n: true, cls: 'hide-sm' }, { h: t('Sales'), n: true }, { h: t('Cost'), n: true, cls: 'hide-sm' }, { h: t('Profit'), n: true }, { h: t('Margin'), n: true, cls: 'hide-sm' }],
      r.profit_rows.map(x => ({ cells: [esc(x.name), fmtNum(x.qty), esc(usd(x.revenue)), esc(usd(x.cost)), `<span class="${cls(x.profit)}">${esc(net(x.profit))}</span>`, esc(pct(x.margin))] })),
      { emptyText: t('No sales in this period.'), foot: [t('Total'), '', esc(usd(r.total_revenue)), esc(usd(r.total_cost)), esc(net(r.gross_profit)), esc(pct(r.gross_margin))] }), { tight: true })
    + panel(t('Oldest boxes in stock'), table([{ h: t('Box') }, { h: t('Mix') }, { h: t('Days in stock'), n: true }, { h: t('pairs'), n: true, cls: 'hide-sm' }],
      r.slow_boxes.map(b => ({ href: `box/${b.id}`, cls: b.age_days >= 60 ? 'warnrow' : '', cells: [`<span class="mono">${esc(b.box_code)}</span>`, esc(b.source_label), fmtNum(b.age_days), fmtNum(b.pair_count)] })),
      { emptyText: t('No sealed boxes in stock.') }), { tight: true, actions: `<span class="sub">${esc(t('Stock value'))}: <b>${esc(usd(r.stock_value))}</b></span>` });
}

// ---------- profit and loss ----------
function pnl(...a) {
  const [preset, s, e] = rangeArgs(a);
  const r = R.pnl(preset, s, e);
  const line = (label, v, opts = {}) => `<div class="pl${opts.total ? ' tot' : ''}${opts.sub ? ' subl' : ''}"><span>${esc(label)}</span><b class="${cls(v)}">${esc(opts.signed ? signed(v) : net(v))}</b></div>`;
  const body = [line(t('Gross sales'), r.gross_sales), line(t('Returns and allowances'), -r.returns_allowances, { sub: 1 }), line(t('Net sales'), r.net_sales, { total: 1 }),
    line(t('Cost of goods sold'), -r.cogs_at_sale, { sub: 1 }), ...(Math.abs(r.cogs_adjustment) >= 0.005 ? [line(t('Landed cost corrections (earlier sales)'), -r.cogs_adjustment, { sub: 1 })] : []),
    line(t('Gross profit') + ` (${pct(r.gross_margin)})`, r.gross_profit, { total: 1 }),
    ...r.expense_rows.map(x => line(x.category, -x.total, { sub: 1 })), line(t('Total expenses'), -r.total_expenses),
    ...(r.fx_rows.length ? [line(t('Exchange gains / losses'), r.fx_total, { signed: 1 })] : []),
    line(t('Net profit') + ` (${pct(r.net_margin)})`, r.net_profit, { total: 1 })].join('');
  const fix = r.cost_check.length ? `<div class="callout warn">${esc(t('{n} purchase order(s) have landed-cost corrections to clean up (entries from the earlier version, or totals that don’t add up).', { n: r.cost_check.length }))}
    <button class="btn sm" data-act="costFix">${esc(t('Clean up'))}</button></div>` : '';
  return header(t('Profit & loss'), { sub: esc(periodText(s, e)), actions: `<button class="btn" onclick="window.print()">${esc(t('Print'))}</button>` }) + reportsNav('pnl') + rangeBar('pnl', preset, s, e) + fix
    + panel('', `<div class="panel-b plist">${body}</div>`)
    + (r.fx_rows.length ? panel(t('Exchange gains / losses'), table([{ h: t('Date') }, { h: '' }, { h: t('Paid'), n: true, cls: 'hide-sm' }, { h: t('Received'), n: true, cls: 'hide-sm' }, { h: 'USD', n: true }],
      r.fx_rows.map(x => ({ cells: [esc(fmtDate(x.day)), `${esc(t(x.kind))}<span class="sub">${esc(x.what)}</span>`, esc(fmtMoney(x.paid_amount, x.paid_currency)), esc(fmtMoney(x.received_amount, x.received_currency)),
        `<span class="${cls(x.result_usd)}">${esc(signed(x.result_usd))}</span>`] }))), { tight: true }) : '')
    + (r.cogs_rows.length ? panel(t('Landed cost corrections'), table([{ h: t('Date') }, { h: '' }, { h: 'USD', n: true }],
      r.cogs_rows.map(x => ({ cells: [esc(fmtDate(x.adjusted_on)), (x.po_id !== null ? `<a href="#/po/${esc(x.po_id)}">${esc(poNo(x.po_id))}</a> ` : '') + `<span class="sub">${esc(x.description || '')}</span>`, esc(signed(x.amount_usd))] }))), { tight: true }) : '');
}

// ---------- cash flow ----------
function cashflow(...a) {
  const [preset, s, e] = rangeArgs(a);
  const r = R.cashFlow(preset, s, e), rc = r.reconciliation;
  const KIND = { customer_payment: 'Customer payments', supplier_payment: 'Supplier payments', expense: 'Expenses', adjustment: 'Adjustments', partner_loan: 'Partner loans',
    partner_repayment: 'Loan repayments', distribution: 'Profit shares' };
  const pl = (l, v, tot) => `<div class="pl${tot ? ' tot' : ''}"><span>${esc(l)}</span><b class="${cls(v)}">${esc(tot ? net(v) : signed(v))}</b></div>`;
  const txRows = rows => rows.map(x => ({ cells: [esc(fmtDate(x.occurred_on)), `${esc(x.account_name)}<span class="sub">${esc(x.description || '')}</span>`, esc(fmtMoney(x.amount, x.currency_code)), esc(usd(x.amount_usd))] }));
  return header(t('Cash flow'), { sub: esc(periodText(s, e)), actions: `<button class="btn" onclick="window.print()">${esc(t('Print'))}</button>` }) + reportsNav('cashflow') + rangeBar('cashflow', preset, s, e)
    + (!r.has_accounts ? `<div class="callout">${esc(t('No cash accounts yet: cash flow follows the money moving in your accounts.'))}</div>` : '')
    + tiles([tile(t('Money in'), big(r.cash_in), ''), tile(t('Money out'), big(r.cash_out), ''), tile(t('Net'), big(r.net_cash_flow), '', '', cls(r.net_cash_flow)), tile(t('Cash now'), big(r.total_cash), esc(t('at today’s rates')))])
    + panel(t('From the start to the end of the period'), `<div class="panel-b plist">${pl(t('Cash on {d}', { d: fmtDate(rc.day_before) }), rc.opening, 1)}${pl(t('Money in'), rc.cash_in)}${pl(t('Money out'), -rc.cash_out)}
      ${Math.abs(rc.brought_in) >= 0.005 ? pl(t('Opening balances of accounts added'), rc.brought_in) : ''}${Math.abs(rc.transfers) >= 0.005 ? pl(t('Exchanges between your accounts'), rc.transfers) : ''}
      ${pl(t('Effect of exchange rates on money held'), rc.fx_effect)}${pl(t('Cash on {d}', { d: fmtDate(e) }), rc.closing, 1)}</div>`)
    + panel(t('By kind'), table([{ h: '' }, { h: 'USD', n: true }], Object.entries(r.by_kind).map(([k, v]) => ({ cells: [esc(t(KIND[k] || k)), `<span class="${cls(v)}">${esc(signed(v))}</span>`] })), { emptyText: '—' }), { tight: true })
    + `<div class="grid2">${panel(t('Money in'), table([{ h: t('Date') }, { h: '' }, { h: t('Amount'), n: true }, { h: 'USD', n: true }], txRows(r.cash_in_rows), { emptyText: '—' }), { tight: true })}
      ${panel(t('Money out'), table([{ h: t('Date') }, { h: '' }, { h: t('Amount'), n: true }, { h: 'USD', n: true }], txRows(r.cash_out_rows), { emptyText: '—' }), { tight: true })}</div>`
    + (r.transfers.length ? panel(t('Transfers between your accounts'), table([{ h: t('Date') }, { h: '' }, { h: t('Amount'), n: true }, { h: 'USD', n: true }], txRows(r.transfers)), { tight: true }) : '');
}

// ---------- costing ----------
function costing(...a) {
  const [preset, s, e] = rangeArgs(a);
  const r = R.costing(preset, s, e);
  // Landed costs also in Guinean francs, at the latest GNF rate (Money → Currencies).
  const fx = latestRate('GNF');
  const gnf = v => (fx && fx.usd_per_unit ? fmtMoney((Number(v) || 0) / fx.usd_per_unit, 'GNF') : '');
  const both = v => esc(usd(v)) + (fx ? `<span class="sub">${esc(gnf(v))}</span>` : '');
  const rateLine = fx ? ' · ' + t('GNF at the latest rate: 1 $ = {r} ({d})', { r: fmtMoney(1 / fx.usd_per_unit, 'GNF'), d: fmtDate(fx.effective_from) }) : '';
  return header(t('Costing'), { sub: esc(periodText(s, e) + rateLine) }) + reportsNav('costing') + rangeBar('costing', preset, s, e)
    + tiles([tile(t('Stock value'), big(r.total_inventory_value), esc(`${fmtNum(r.total_pairs_in_stock)} ${t('pairs')}` + (fx ? ` · ${gnf(r.total_inventory_value)}` : ''))), tile(t('Cost of goods sold'), big(r.total_cogs), esc(t('in this period')))])
    + panel(t('Stock by style, at landed cost'), table([{ h: t('Style') }, { h: t('pairs'), n: true }, { h: t('Avg cost'), n: true, cls: 'hide-sm' }, { h: t('Value'), n: true }],
      r.valuation_rows.map(x => ({ href: `product/${x.product_id}`, cells: [esc(x.product_name), fmtNum(x.qty_in_stock), both(x.avg_cost), both(x.total_value)] })),
      { emptyText: t('No stock.'), foot: [t('Total'), fmtNum(r.total_pairs_in_stock), '', both(r.total_inventory_value)] }), { tight: true })
    + `<div class="grid2">${panel(t('Cost of goods sold by style'), table([{ h: t('Style') }, { h: 'USD', n: true }], r.cogs_rows.map(x => ({ cells: [esc(x.name), esc(usd(x.cogs))] })), { emptyText: '—' }), { tight: true })}
      ${panel(t('Landed cost per pair, by mix received'), table([{ h: t('Mix') }, { h: t('Received'), cls: 'hide-sm' }, { h: t('per pair'), n: true }],
      r.cost_trend.map(x => ({ cells: [`${esc(x.label)}<span class="sub">${esc(poNo(x.po_id))}${x.supplier_name ? ' · ' + esc(x.supplier_name) : ''}</span>`, esc(fmtDate(x.received_at)), x.landed_cost_per_pair === null ? '—' : both(x.landed_cost_per_pair)] })), { emptyText: '—' }), { tight: true })}</div>`;
}

// ---------- balance sheet ----------
function balance() {
  const r = R.balanceSheet(), fp = r.fp;
  const pl = (l, v, o = {}) => `<div class="pl${o.tot ? ' tot' : ''}${o.sub ? ' subl' : ''}"><span>${esc(l)}</span><b class="${cls(v)}">${esc(net(v))}</b></div>`;
  const assets = [pl(t('Money in your accounts'), fp.cash), pl(t('Customers owe (invoiced)'), fp.receivables), ...(fp.unbilled > 0.004 ? [pl(t('Delivered, not invoiced yet'), fp.unbilled)] : []),
    pl(t('Stock at landed cost'), fp.inventory), ...(fp.advances > 0.004 ? [pl(t('Paid to suppliers ahead of goods'), fp.advances)] : []),
    ...(Math.abs(fp.unlinked_paid) > 0.004 ? [pl(t('Supplier payments not linked to a purchase order'), fp.unlinked_paid)] : []), pl(t('Total assets'), fp.total_assets, { tot: 1 })].join('');
  const liab = [pl(t('Owed to suppliers'), fp.payables), pl(t('Owed to partners (loans)'), fp.partner_loans), ...(fp.customer_credits > 0.004 ? [pl(t('Customers in credit'), fp.customer_credits)] : []),
    pl(t('Total liabilities'), fp.total_liabilities, { tot: 1 }), pl(t('Net worth'), fp.net_assets, { tot: 1 })].join('');
  const eq = fp.equity_items.filter(([, v]) => Math.abs(v) >= 0.005).map(([l, v]) => pl(t(l), v, { sub: 1 })).join('') + pl(t('Equity'), fp.equity, { tot: 1 });
  const ok = Math.abs(fp.difference) < 0.01;
  return header(t('Balance sheet'), { sub: esc(t('Today, at today’s exchange rates')), actions: `<button class="btn" onclick="window.print()">${esc(t('Print'))}</button>` }) + reportsNav('balance')
    + (fp.missing_rates.length ? `<div class="callout bad">${esc(t('No exchange rate for {c}: some amounts are at the rate of their day.', { c: fp.missing_rates.join(', ') }))}</div>` : '')
    + tiles([tile(t('Total assets'), big(fp.total_assets), ''), tile(t('Total liabilities'), big(fp.total_liabilities), ''), tile(t('Net worth'), big(fp.net_assets), '', '', cls(fp.net_assets)),
      tile(t('Check'), ok ? '✓' : esc(net(fp.difference)), esc(ok ? t('both sides agree') : t('difference to look into')), '', ok ? '' : 'neg')])
    + `<div class="grid2">${panel(t('What the business has'), `<div class="panel-b plist">${assets}</div>`)}${panel(t('What it owes'), `<div class="panel-b plist">${liab}</div>`)}</div>`
    + panel(t('How it got there'), `<div class="panel-b plist">${eq}</div>`)
    + (fp.po_rows.length ? panel(t('Purchase orders not settled'), table([{ h: t('Purchase order') }, { h: t('Received'), n: true }, { h: t('Paid'), n: true }, { h: t('Position'), n: true }],
      fp.po_rows.map(x => ({ href: `po/${x.po_id}`, cells: [esc(poNo(x.po_id)), esc(usd(x.received)), esc(usd(x.paid)), `<span class="${cls(-x.position)}">${esc(x.position > 0 ? t('owe {a}', { a: usd(x.position) }) : t('advance {a}', { a: usd(-x.position) }))}</span>`] }))), { tight: true }) : '')
    + (fp.partner_list.length ? panel(t('Owed to partners'), table([{ h: t('Partner') }, { h: 'USD', n: true }], fp.partner_list.map(x => ({ href: `partner/${x.id}`, cells: [esc(x.name), esc(usd(x.owed))] }))), { tight: true }) : '');
}

// ---------- daily report ----------
const STATUS = { paid: 'paid', 'part paid': 'part paid', owed: 'owed', 'not invoiced': 'not invoiced', returned: 'returned' };
function dailyText(rep) {
  const L = [`${t('Daily sales report')} — ${longDate(rep.day)}`, ''];
  if (rep.order_count) {
    L.push(`${t('Sales')}: ${rep.sales.map(s => fmtMoney(s.amount, s.code)).join(' + ')} (= ${usd(rep.revenue_usd)})`);
    L.push(`${rep.order_count} ${t('order(s)')} · ${rep.boxes_sold} ${t('box(es)')} · ${rep.pairs_sold} ${t('pair(s)')}`);
    L.push(`${t('Gross profit')}: ${usd(rep.gross_profit_usd)}${rep.margin !== null ? ` (${fmtNum(rep.margin, 1)} %)` : ''}`);
  } else L.push(t('No sales delivered this day.'));
  if (rep.collected.length) L.push(`${t('Collected')}: ${rep.collected.map(c => fmtMoney(c.amount, c.code)).join(' + ')} (= ${usd(rep.collected_usd)})`);
  if (rep.returns.length) L.push(`${t('Returns')}: ${usd(rep.returns_usd)}`);
  if (rep.expenses.length) L.push(`${t('Expenses')}: ${usd(rep.expenses_usd)}`);
  if (rep.fx_rows.length) L.push(`${t('Exchange gains / losses')}: ${signed(rep.fx_usd)}`);
  if (rep.corrections.length) L.push(`${t('Landed cost corrections (earlier sales)')}: ${signed(-rep.corrections_usd)}`);
  L.push(`${t('Still owed by customers')}: ${usd(rep.owed_usd)}`);
  if (rep.not_invoiced_count) L.push(`  + ${usd(rep.not_invoiced_usd)} ${t('delivered but not invoiced')}`);
  L.push('', `${t('Month to date')}: ${t('sales')} ${usd(rep.mtd_revenue_usd)} · ${t('gross profit')} ${usd(rep.mtd_gross_profit_usd)} · ${t('net')} ${net(rep.mtd_net_usd)}`);
  if (rep.orders.length) {
    L.push('', t('Orders') + ' :');
    for (const o of rep.orders) L.push(`• ${orderNo(o.id)} ${o.customer || t('Walk-in customer')} — ${o.lines.map(l => (l.boxes ? `${l.boxes} × ${l.what}` : `${l.pairs} × ${l.what} (${t('loose')})`)).join(', ')} — ${fmtMoney(o.total, o.currency_code)} (${t(STATUS[o.status] || o.status)})`);
  }
  return L.join('\n');
}
function shareBlock(text, subject) {
  const emails = all(`SELECT email FROM partners WHERE archived = 0 AND email IS NOT NULL AND TRIM(email) != ''`).map(r => r.email);
  const body = text.length < 1800 ? text : text.slice(0, 1750) + '\n…';
  return panel(t('Send to your partners'), `<div class="panel-b"><pre class="copytext">${esc(text)}</pre><div class="actions">
    <a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>
    ${emails.length ? `<a class="btn" href="mailto:${esc(emails.join(','))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}">${esc(t('Email'))}</a>` : ''}
    <button class="btn" data-act="copyText">${esc(t('Copy'))}</button></div></div>`);
}
function daily(dRaw) {
  const T = today();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dRaw || '') && dRaw <= T ? dRaw : T;
  const rep = R.dailyReport(d);
  const nav = `<div class="inline"><a class="btn" href="#/daily/${addDays(d, -1)}">‹ ${esc(t('Previous day'))}</a>${d < T ? `<a class="btn" href="#/daily/${addDays(d, 1)}">${esc(t('Next day'))} ›</a><a class="btn ghost" href="#/daily">${esc(t('Today'))}</a>` : ''}
    <form class="dates" data-day="1"><input class="inp" type="date" name="d" value="${d}" max="${T}"><button class="btn sm">${esc(t('Show'))}</button></form></div>`;
  const orders = rep.orders.map(o => ({ href: `order/${o.id}`, cells: [`<span class="mono">${esc(orderNo(o.id))}</span><span class="sub">${esc(o.customer || t('Walk-in customer'))}</span>`,
    esc(o.lines.map(l => (l.boxes ? `${l.boxes} × ${l.what}` : `${l.pairs} × ${l.what}`)).join(', ')), esc(fmtMoney(o.total, o.currency_code)),
    pill(t(STATUS[o.status] || o.status), { paid: 'good', 'part paid': 'warn', owed: 'bad', 'not invoiced': 'warn', returned: '' }[o.status] || '')] }));
  return header(t('Daily report'), { sub: esc(longDate(d)), actions: `<button class="btn" onclick="window.print()">${esc(t('Print'))}</button>` }) + reportsNav('daily') + nav
    + tiles([tile(t('Sales'), big(rep.revenue_usd), esc(`${rep.order_count} ${t('order(s)')} · ${rep.boxes_sold} ${t('box(es)')}`)), tile(t('Gross profit'), big(rep.gross_profit_usd), esc(pct(rep.margin))),
      tile(t('Collected'), big(rep.collected_usd), esc(rep.collected.map(c => fmtMoney(c.amount, c.code)).join(' + '))), tile(t('Net for the day'), big(rep.net_usd), '', '', cls(rep.net_usd))])
    + panel(t('Orders delivered'), table([{ h: t('Order') }, { h: '', cls: 'hide-sm' }, { h: t('Total'), n: true }, { h: t('Status') }], orders, { emptyText: t('No sales delivered this day.') }), { tight: true })
    + (rep.payments.length ? panel(t('Money received'), table([{ h: t('Invoice') }, { h: t('Customer') }, { h: t('Amount'), n: true }],
      rep.payments.map(p => ({ href: `order/${p.order_id}`, cells: [`<span class="mono">${esc(p.invoice_number)}</span>${p.account_name ? `<span class="sub">${esc(p.account_name)}</span>` : ''}`, esc(p.customer_name || ''), esc(fmtMoney(p.amount, p.currency_code))] }))), { tight: true }) : '')
    + (rep.returns.length ? panel(t('Returns'), table([{ h: t('Order') }, { h: '' }, { h: t('Credited'), n: true }],
      rep.returns.map(x => ({ cells: [esc(orderNo(x.order_id)), `${x.qty} ${esc(t(x.unit))}${x.reason ? ` · ${esc(x.reason)}` : ''}`, esc(fmtMoney(x.refund_amount, x.currency_code))] }))), { tight: true }) : '')
    + (rep.expenses.length ? panel(t('Expenses'), table([{ h: t('Category') }, { h: t('Amount'), n: true }], rep.expenses.map(x => ({ cells: [esc(x.category) + (x.description ? `<span class="sub">${esc(x.description)}</span>` : ''), esc(fmtMoney(x.amount, x.currency_code))] }))), { tight: true }) : '')
    + panel(t('The day in figures'), `<div class="panel-b plist">
      <div class="pl"><span>${esc(t('Sales'))}</span><b>${esc(usd(rep.revenue_usd))}</b></div>${rep.returns_usd ? `<div class="pl subl"><span>${esc(t('Returns'))}</span><b>${esc('−' + usd(rep.returns_usd))}</b></div>` : ''}
      <div class="pl subl"><span>${esc(t('Cost of goods sold'))}</span><b>${esc('−' + usd(rep.cost_usd))}</b></div><div class="pl tot"><span>${esc(t('Gross profit'))}</span><b>${esc(net(rep.gross_profit_usd))}</b></div>
      ${rep.corrections.length ? `<div class="pl subl"><span>${esc(t('Landed cost corrections (earlier sales)'))}</span><b>${esc(signed(-rep.corrections_usd))}</b></div>` : ''}
      <div class="pl subl"><span>${esc(t('Expenses'))}</span><b>${esc('−' + usd(rep.expenses_usd))}</b></div>${rep.fx_rows.length ? `<div class="pl subl"><span>${esc(t('Exchange gains / losses'))}</span><b>${esc(signed(rep.fx_usd))}</b></div>` : ''}
      <div class="pl tot"><span>${esc(t('Net for the day'))}</span><b class="${cls(rep.net_usd)}">${esc(net(rep.net_usd))}</b></div>
      <div class="pl"><span>${esc(t('Still owed by customers'))}</span><b>${esc(usd(rep.owed_usd))}</b></div>${rep.not_invoiced_count ? `<div class="pl subl"><span>${esc(t('Delivered, not invoiced'))}</span><b>${esc(usd(rep.not_invoiced_usd))}</b></div>` : ''}
      <div class="pl"><span>${esc(t('Month to date: sales'))}</span><b>${esc(usd(rep.mtd_revenue_usd))}</b></div><div class="pl"><span>${esc(t('Month to date: net'))}</span><b class="${cls(rep.mtd_net_usd)}">${esc(net(rep.mtd_net_usd))}</b></div>
      <div class="pl"><span>${esc(t('In stock'))}</span><b>${fmtNum(rep.stock_boxes)} ${esc(t('boxes'))} · ${esc(usd(rep.stock_value_usd))}</b></div></div>`)
    + shareBlock(dailyText(rep), `${t('Daily sales report')} — ${d}`);
}

// ---------- sales report and monthly report ----------
function salesText(rep, title) {
  const tt = rep.total, L = [title, ''];
  L.push(`${t('Sales delivered')}: ${rep.sales.map(s => fmtMoney(s.amount, s.code)).join(' + ') || '0'} (= ${net(tt.sales)})`);
  L.push(`${tt.orders} ${t('order(s)')} · ${tt.boxes} ${t('box(es)')} · ${tt.pairs} ${t('pair(s)')}`);
  if (Math.abs(tt.returns) > 0.004) L.push(`${t('Returns')}: −${net(tt.returns)}`);
  L.push(`${t('Gross profit')}: ${net(tt.gross_profit)}${tt.margin !== null ? ` (${fmtNum(tt.margin, 1)} %)` : ''}`);
  L.push(`${t('Expenses')}: ${net(tt.expenses)}`);
  if (Math.abs(tt.fx) > 0.004) L.push(`${t('Exchange gains / losses')}: ${signed(tt.fx)}`);
  if (Math.abs(tt.corrections) > 0.004) L.push(`${t('Landed cost corrections (earlier sales)')}: ${signed(-tt.corrections)}`);
  L.push(`${t('Net')}: ${net(tt.net)}`, `${t('Collected')}: ${net(tt.collected)}`, `${t('Still owed by customers')}: ${net(rep.owed_usd)}`);
  if (rep.change_sales !== null) L.push(`${t('vs')} ${rangeLabel(rep.compare[0], rep.compare[1])}: ${t('sales')} ${rep.change_sales >= 0 ? '+' : ''}${fmtNum(pyRound(rep.change_sales, 0))} % · ${t('gross profit')} ${rep.change_gp !== null ? (rep.change_gp >= 0 ? '+' : '') + fmtNum(pyRound(rep.change_gp, 0)) + ' %' : '—'}`);
  if (rep.best_day) L.push(`${t('Best day')}: ${longDate(rep.best_day.day)} (${net(rep.best_day.sales)})`);
  return L.join('\n');
}
function salesBody(rep, withMonth) {
  const tt = rep.total;
  const chg = v => (v === null ? '' : `<span class="sub ${v < 0 ? 'neg' : 'gain'}">${v >= 0 ? '+' : ''}${fmtNum(pyRound(v, 0))} % ${esc(t('vs before'))}</span>`);
  return tiles([tile(t('Sales'), big(tt.net_sales), chg(rep.change_sales)), tile(t('Gross profit'), big(tt.gross_profit), esc(pct(tt.margin)) + chg(rep.change_gp)),
    tile(t('Net'), big(tt.net), chg(rep.change_net), '', cls(tt.net)), tile(t('Collected'), big(tt.collected), esc(t('owed now: {a}', { a: usd(rep.owed_usd) })))])
    + panel('', table([{ h: rep.group === 'day' ? t('Day') : rep.group === 'week' ? t('Week') : t('Month') }, { h: t('Orders'), n: true, cls: 'hide-sm' }, { h: t('boxes'), n: true, cls: 'hide-sm' },
      { h: t('Sales'), n: true }, { h: t('Gross profit'), n: true }, { h: t('Expenses'), n: true, cls: 'hide-sm' }, { h: t('Net'), n: true }, { h: t('Collected'), n: true, cls: 'hide-sm' }],
    rep.rows.filter(r => rep.group !== 'day' || !r.quiet || rep.rows.length <= 31).map(r => ({ cls: r.quiet ? 'dim' : '', href: rep.group === 'day' ? `daily/${r.day}` : '', cells: [esc(rowLabel(r, withMonth)), fmtNum(r.orders), fmtNum(r.boxes),
      esc(net(r.net_sales)), esc(net(r.gross_profit)), esc(net(r.expenses)), `<span class="${cls(r.net)}">${esc(net(r.net))}</span>`, esc(net(r.collected))] })),
    { foot: [t('Total'), fmtNum(tt.orders), fmtNum(tt.boxes), esc(net(tt.net_sales)), esc(net(tt.gross_profit)), esc(net(tt.expenses)), esc(net(tt.net)), esc(net(tt.collected))] }), { tight: true })
    + `<div class="grid2">${panel(t('Best customers'), table([{ h: t('Customer') }, { h: t('boxes'), n: true }, { h: 'USD', n: true }], rep.customers.map(c => ({ cells: [esc(c.name === 'Walk-in' ? t('Walk-in customer') : c.name), fmtNum(c.boxes), esc(usd(c.usd))] })), { emptyText: '—' }), { tight: true })}
      ${panel(t('Best styles'), table([{ h: t('Style') }, { h: t('pairs'), n: true }, { h: 'USD', n: true }], rep.styles.map(s => ({ cells: [esc(s.name), fmtNum(s.qty), esc(usd(s.revenue))] })), { emptyText: '—' }), { tight: true })}</div>`
    + `<p class="sub">${esc(t('Compared with {p}.', { p: rangeLabel(rep.compare[0], rep.compare[1]) }))}${rep.best_day ? ' ' + esc(t('Best day: {d} ({a}).', { d: longDate(rep.best_day.day), a: usd(rep.best_day.sales) })) : ''}</p>`;
}
function salesCsv(rep, name) {
  const fields = ['day', 'end_day', 'orders', 'boxes', 'pairs', 'sales', 'returns', 'net_sales', 'cost', 'gross_profit', 'expenses', 'fx', 'corrections', 'net', 'collected'].filter(f => rep.group !== 'day' || f !== 'end_day');
  const r2 = v => (typeof v === 'number' && !Number.isInteger(v) ? pyRound(v, 2) : v);
  const rows = rep.rows.map(r => fields.map(f => r2(r[f])));
  rows.push(fields.map(f => (f === 'day' ? 'TOTAL' : f === 'end_day' ? '' : pyRound(rep.total[f], 2))));
  downloadText(name, '﻿' + [fields, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n'));
}
let LAST = null;
function sales(...a) {
  const [preset0, s0, e0, g0] = a[0] === 'custom' ? ['', a[1], a[2], a[3]] : [a[0] || 'this_month', '', '', a[1] || ''];
  const [s, e, group, preset] = R.salesRange(preset0, s0, e0, g0);
  const rep = R.salesReport(s, e, group);
  const title = `${t('Sales report')} — ${rangeLabel(s, e)}`;
  LAST = { rep, name: `ventes-${s}-${e}.csv` };
  const chips = [['today', t('Today')], ['yesterday', t('Yesterday')], ['this_week', t('This week')], ['last_week', t('Last week')], ['this_month', t('This month')], ['last_month', t('Last month')],
    ['last_30', t('30 days')], ['this_year', t('This year')], ['all', t('All')]].map(([k, l]) => `<a class="chip" href="#/sales/${k}" aria-pressed="${preset === k}">${esc(l)}</a>`).join('');
  const groups = ['day', 'week', 'month'].map(g => `<a class="chip" href="#/sales/custom/${s}/${e}/${g}" aria-pressed="${group === g}">${esc(t(g === 'day' ? 'By day' : g === 'week' ? 'By week' : 'By month'))}</a>`).join('');
  return header(t('Sales report'), { sub: esc(rangeLabel(s, e)), actions: `<button class="btn" onclick="window.print()">${esc(t('Print'))}</button><button class="btn" data-act="salesCsv">${esc(t('Download CSV'))}</button>` })
    + reportsNav('sales') + `<div class="inline rbar"><div class="chips">${chips}</div></div><div class="inline rbar"><div class="chips">${groups}</div>
      <form class="dates" data-sales="1"><input class="inp" type="date" name="s" value="${s}" max="${today()}"><span>→</span><input class="inp" type="date" name="e" value="${e}" max="${today()}"><button class="btn sm">${esc(t('Show'))}</button></form></div>`
    + salesBody(rep, s.slice(0, 7) !== e.slice(0, 7)) + shareBlock(salesText(rep, title), title);
}
function monthly(mRaw) {
  const T = today();
  let y = +T.slice(0, 4), m = +T.slice(5, 7);
  const mm = /^(\d{4})-(\d{2})$/.exec(mRaw || '');
  if (mm && +mm[2] >= 1 && +mm[2] <= 12 && `${mm[1]}-${mm[2]}` <= T.slice(0, 7)) { y = +mm[1]; m = +mm[2]; }
  const rep = R.monthlyReport(y, m);
  LAST = { rep, name: `ventes-mois-${y}-${String(m).padStart(2, '0')}.csv` };
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`, next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const title = `${t('Monthly sales report')} — ${monthName(y, m)}${rep.complete ? '' : ` (1–${+rep.upto.slice(8)})`}`;
  return header(t('Monthly report'), { sub: esc(monthName(y, m) + (rep.complete ? '' : ` (1–${+rep.upto.slice(8)})`)),
    actions: `<button class="btn" onclick="window.print()">${esc(t('Print'))}</button><button class="btn" data-act="salesCsv">${esc(t('Download CSV'))}</button>` })
    + reportsNav('monthly') + `<div class="inline"><a class="btn" href="#/monthly/${prev}">‹ ${esc(monthName(+prev.slice(0, 4), +prev.slice(5)))}</a>${next <= T.slice(0, 7) ? `<a class="btn" href="#/monthly/${next}">${esc(monthName(+next.slice(0, 4), +next.slice(5)))} ›</a>` : ''}</div>`
    + salesBody(rep, false) + shareBlock(salesText(rep, title), title);
}
export const REPORT_SCREENS = { reports: { render: overview }, pnl: { render: pnl }, cashflow: { render: cashflow }, costing: { render: costing }, balance: { render: balance },
  daily: { render: daily }, sales: { render: sales }, monthly: { render: monthly } };

registerActions({
  costFix: () => confirmAction({ title: t('Clean up landed-cost corrections?'), danger: false, confirm: t('Clean up'),
    text: t('For each purchase order flagged, the correction entries are replaced by one entry with the true total for pairs already sold, and boxes in stock get their true cost. Sales, payments and stock counts are not touched. Download a backup first if you want a copy of how things were.'),
    run: () => F.costCorrectionsFix(), done: m => { toast(m); schedule(); } }),
  salesCsv: () => { if (LAST) salesCsv(LAST.rep, LAST.name); },
  copyText: async (a) => {
    const pre = a.closest('.panel').querySelector('.copytext');
    try { await navigator.clipboard.writeText(pre.textContent); toast(t('Copied.')); } catch { toast(t('Select the text and copy it.')); }
  }
});
// The date forms of the report pages.
document.addEventListener('submit', e => {
  const f = e.target;
  if (!f.classList || !f.classList.contains('dates')) return;
  e.preventDefault();
  const v = n => (f.elements[n] ? f.elements[n].value : '');
  if (f.dataset.range) go(`${f.dataset.range}/custom/${v('s')}/${v('e')}`);
  else if (f.dataset.day) go(`daily/${v('d')}`);
  else if (f.dataset.sales) go(`sales/custom/${v('s')}/${v('e')}`);
});

// Buying plan (buying.py): which models to order next, how many boxes, and why. Same method,
// same thresholds. A "model" is a style + colour + size run, followed across purchase orders.
// Days are 'YYYY-MM-DD' strings (UTC, like the old app).
import { all, val, run, ins } from './localdb.js';
import { pyRound } from './util.js';
import { t } from './i18n.js';
import { refuse, asId } from './ops/common.js';

export const DEFAULTS = { buy_lead_weeks: 14, buy_cover_weeks: 12, buy_container_boxes: 700, buy_min_boxes: 10, buy_service: 'normal',
  buy_history_weeks: 12, buy_fill: 0, buy_max_cover_weeks: 26 };
export const SERVICE_Z = { low: 0.84, normal: 1.28, high: 1.65 };
const EARLY_DAYS = 21, PRIOR_DAYS = 21, RECENT_DAYS = 28;
export const LABELS = {
  reorder: ['Reorder', 'A good seller running low'],
  watch: ['Reorder small / watch', 'Worth a small order — the signal is weaker'],
  early: ['Too early to judge', 'Less than 3 weeks of sales'],
  enough: ['Enough stock', 'Stock and orders cover what you need'],
  stop: ['Don’t reorder', 'Slow or too little margin'],
  clear: ['Clear out', 'Old stock that is not moving — consider a lower price']
};
export const GUINEA_EVENTS = [
  ['Year-end festivities', '2026-12-15', '2026-12-31'],
  ['Ramadan & Eid al-Fitr (approx. dates — check)', '2027-02-08', '2027-03-10'],
  ['Tabaski / Eid al-Adha (approx. dates — check)', '2027-05-06', '2027-05-17'],
  ['Back to school', '2027-09-15', '2027-10-15'],
  ['Year-end festivities', '2027-12-15', '2027-12-31']
];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- days ----------
const ms = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const addDays = (d, n) => new Date(ms(d) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((ms(a) - ms(b)) / 86400000);
export const todayStr = () => new Date().toISOString().slice(0, 10);
const day = s => (s ? String(s).slice(0, 10) : null);
const inc = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpId = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : typeof a === 'number' ? -1 : typeof b === 'number' ? 1 : cmpStr(a, b));
const pyFloat = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/_/g, '');
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : null;
};

// ---------- settings ----------
export function getSettings() {
  const s = { ...DEFAULTS };
  for (const r of all(`SELECT key, value FROM app_settings WHERE key LIKE 'buy_%'`)) {
    if (!has(DEFAULTS, r.key)) continue;
    if (r.key === 'buy_service') { s[r.key] = r.value; continue; }
    const f = pyFloat(r.value);
    if (f !== null) s[r.key] = f;
  }
  for (const k of ['buy_container_boxes', 'buy_min_boxes', 'buy_history_weeks', 'buy_fill']) s[k] = Math.trunc(s[k]);
  if (!has(SERVICE_Z, s.buy_service)) s.buy_service = 'normal';
  return s;
}
export function saveSettings(values) {
  for (const [k, v0] of Object.entries(values)) {
    if (!has(DEFAULTS, k)) continue;
    const v = String(v0);
    if (val(`SELECT 1 FROM app_settings WHERE key = ?`, [k])) run(`UPDATE app_settings SET value = ? WHERE key = ?`, [v, k]);
    else ins('app_settings', { key: k, value: v });
  }
}

// ---------- models ----------
function sizeRun(sizes) {
  let nums = [];
  for (const z of sizes) {
    const f = pyFloat(String(z).replace(/,/g, '.'));
    if (f === null) { nums = null; break; }
    nums.push(f);
  }
  if (nums && nums.length) {
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const f = x => String(x);
    return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
  }
  const ss = sizes.map(String).sort(cmpStr);
  return ss.length === 1 ? ss[0] : `${ss[0]}–${ss[ss.length - 1]}`;
}
export function models() {
  const out = new Map();
  for (const g of all(`SELECT g.id, g.po_id, g.label, g.box_count, g.received_at, po.created_at as po_created
                       FROM po_box_groups g JOIN purchase_orders po ON po.id = g.po_id ORDER BY g.id`)) {
    const comp = all(`SELECT pi.qty, pi.unit_cost, v.size, v.color, p.id as product_id, p.name FROM po_items pi
                      JOIN variants v ON v.id = pi.variant_id JOIN products p ON p.id = v.product_id WHERE pi.po_box_group_id = ?`, [g.id]);
    if (!comp.length) continue;
    const st = new Map();
    for (const c of comp) { const col = String(c.color || '').trim(); st.set(`${c.product_id}\u0000${col}`, [c.product_id, col]); }
    const styles = [...st.values()].sort((a, b) => cmpId(a[0], b[0]) || cmpStr(a[1].toLowerCase(), b[1].toLowerCase()));
    const sizes = [...new Set(comp.map(c => String(c.size)))].sort(cmpStr);
    const key = styles.map(([pid, col]) => `${pid}:${col.toLowerCase()}`).join('|') + '#' + sizes.join(',');
    const names = new Map(comp.map(c => [c.product_id, c.name]));
    const label = styles.map(([pid, col]) => `${names.get(pid)}${col ? ' ' + col : ''}`).join(' + ');
    if (!out.has(key)) out.set(key, { key, label: `${label} · ${sizeRun(sizes)}`, style: label, size_run: sizeRun(sizes), groups: [], pairs_per_box: 0, product_ids: new Set() });
    const m = out.get(key);
    m.groups.push({ ...g });
    m.pairs_per_box = comp.reduce((s, c) => s + c.qty, 0);
    for (const pid of names.keys()) m.product_ids.add(pid);
  }
  return out;
}
export function modelOfMix(poId, label) {
  for (const [key, m] of models()) if (m.groups.some(g => g.po_id === poId && g.label === label)) return key;
  return null;
}
function eventFactor() {
  const events = all(`SELECT name, start_date, end_date, boost_percent FROM sales_events`);
  const cache = new Map();
  const factor = d => {
    if (cache.has(d)) return cache.get(d);
    let f = 1.0;
    for (const e of events) if (e.start_date <= d && d <= (e.end_date || e.start_date)) f += (e.boost_percent || 0) / 100.0;
    f = Math.max(f, 0.05);
    cache.set(d, f);
    return f;
  };
  return [factor, events];
}
export function measuredLeadWeeks() {
  const out = [];
  for (const r of all(`SELECT po.id, po.created_at, MIN(g.received_at) as first_in FROM purchase_orders po
                       JOIN po_box_groups g ON g.po_id = po.id WHERE g.received_at IS NOT NULL GROUP BY po.id`)) {
    const a = day(r.first_in), b = day(r.created_at);
    if (!a || !b || !/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) continue;
    const d = daysBetween(a, b);
    if (d >= 0) out.push([r.id, d / 7.0]);
  }
  return out;
}

// ---------- the plan ----------
export function plan(today = null, settings = null) {
  const s = settings || getSettings();
  const T = today || todayStr();
  const [factor, events] = eventFactor();
  const L = Number(s.buy_lead_weeks), C = Number(s.buy_cover_weeks);
  const windowDays = Math.trunc(s.buy_history_weeks) * 7;
  const z = SERVICE_Z[s.buy_service];
  const M = models();
  const mixToKey = new Map();
  for (const [k, m] of M) for (const g of m.groups) mixToKey.set(`${g.po_id}\u0000${g.label}`, k);
  const keyOf = (po, label) => mixToKey.get(`${po}\u0000${label}`);
  const data = new Map();
  for (const [k, m] of M) data.set(k, { ...m, receipts: new Map(), sales: new Map(), sales_rev: 0, sold_boxes: 0, returns: new Map(), restocked: new Map(), losses: new Map(),
    refunds: 0, returned_boxes: 0, missed: new Map(), customers: new Map(), box_costs: [], in_stock: 0, on_order: 0, received_boxes: 0, oldest_in_stock: null });

  for (const b of all(`SELECT b.id, b.source_po_id, b.source_label, b.status, b.received_at,
                         (SELECT SUM(qty * unit_cost) FROM box_items WHERE box_id = b.id) as cost,
                         (SELECT SUM(COALESCE(qty_left, 0)) FROM box_items WHERE box_id = b.id) as pairs_left FROM boxes b ORDER BY b.id`)) {
    const k = keyOf(b.source_po_id, b.source_label);
    if (!k) continue;
    const d = data.get(k);
    const dd = day(b.received_at) || T;
    inc(d.receipts, dd, 1);
    d.received_boxes += 1;
    d.box_costs.push(b.cost || 0.0);
    if (b.status === 'in_stock' || b.status === 'open') {
      d.in_stock += b.status === 'in_stock' ? 1 : (b.pairs_left || 0) / (d.pairs_per_box || 1);
      if (!d.oldest_in_stock || dd < d.oldest_in_stock) d.oldest_in_stock = dd;
    }
  }
  for (const [k, m] of M) data.get(k).on_order = m.groups.filter(g => !g.received_at).reduce((a, g) => a + g.box_count, 0);
  for (const r of all(`SELECT bl.source_po_id, bl.source_label, bl.qty_boxes, bl.price_per_box, o.fulfilled_at, o.customer_id, COALESCE(o.fx_rate_to_usd, 1) as fx
                       FROM order_box_lines bl JOIN orders o ON o.id = bl.order_id WHERE o.status = 'fulfilled' AND o.fulfilled_at IS NOT NULL ORDER BY bl.id`)) {
    const k = keyOf(r.source_po_id, r.source_label);
    if (!k) continue;
    const d = data.get(k);
    inc(d.sales, day(r.fulfilled_at), r.qty_boxes);
    d.sold_boxes += r.qty_boxes;
    d.sales_rev += r.qty_boxes * r.price_per_box * r.fx;
    inc(d.customers, r.customer_id, r.qty_boxes);
  }
  for (const r of all(`SELECT bl.source_po_id, bl.source_label, ri.qty, ri.restocked, ri.refund_amount, r.created_at, o.customer_id, COALESCE(o.fx_rate_to_usd, 1) as fx
                       FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN order_box_lines bl ON bl.id = ri.order_box_line_id
                       JOIN orders o ON o.id = r.order_id WHERE o.status = 'fulfilled' ORDER BY ri.id`)) {
    const k = keyOf(r.source_po_id, r.source_label);
    if (!k) continue;
    const d = data.get(k), dd = day(r.created_at);
    inc(d.returns, dd, r.qty);
    if (r.restocked) inc(d.restocked, dd, r.qty);
    d.returned_boxes += r.qty;
    d.refunds += r.refund_amount * r.fx;
    inc(d.customers, r.customer_id, -r.qty);
  }
  for (const r of all(`SELECT pp.kind, pp.qty, pp.created_at, b.source_po_id, b.source_label, oi.unit_price, o.fulfilled_at, o.customer_id,
                         COALESCE(o.fx_rate_to_usd, 1) as fx, r.created_at as returned_at
                       FROM pair_picks pp JOIN boxes b ON b.id = pp.box_id LEFT JOIN order_items oi ON oi.id = pp.order_item_id
                       LEFT JOIN orders o ON o.id = oi.order_id LEFT JOIN return_items ri ON ri.id = pp.return_item_id
                       LEFT JOIN returns r ON r.id = ri.return_id WHERE pp.box_id IS NOT NULL ORDER BY pp.id`)) {
    const k = keyOf(r.source_po_id, r.source_label);
    if (!k) continue;
    const d = data.get(k);
    const share = r.qty / (d.pairs_per_box || 1);
    if (r.kind === 'sale' && r.fulfilled_at) {
      inc(d.sales, day(r.fulfilled_at), share);
      d.sold_boxes += share;
      d.sales_rev += r.qty * (r.unit_price || 0) * r.fx;
      inc(d.customers, r.customer_id, share);
    } else if (r.kind === 'return') {
      const dd = day(r.returned_at || r.created_at);
      inc(d.returns, dd, share);
      inc(d.restocked, dd, share);
      d.returned_boxes += share;
      d.refunds += r.qty * (r.unit_price || 0) * r.fx;
      inc(d.customers, r.customer_id, -share);
    } else if (r.kind === 'count') inc(d.losses, day(r.created_at), share);
  }
  const requestedOnly = new Map();
  for (const r of all(`SELECT happened_on, model_key, model_label, description, boxes FROM missed_sales ORDER BY id`)) {
    if (r.model_key && data.has(r.model_key)) inc(data.get(r.model_key).missed, r.happened_on, r.boxes || 1);
    else {
      const name = String(r.model_label || r.description || 'Unnamed').trim();
      const lk = name.toLowerCase();
      if (!requestedOnly.has(lk)) requestedOnly.set(lk, { name, boxes: 0, times: 0, last: null });
      const q = requestedOnly.get(lk);
      q.boxes += r.boxes || 1; q.times += 1;
      const l = r.happened_on || '';
      q.last = (q.last || '') > l ? (q.last || '') : l;
    }
  }

  const rows = [];
  for (const [k, d] of data) {
    if (!d.received_boxes && !d.on_order) continue;
    const evDays = [...new Set([...d.receipts.keys(), ...d.sales.keys(), ...d.restocked.keys()])].sort(cmpStr);
    const first = evDays.length ? evDays[0] : null;
    const inStockDays = new Set(), stockByDay = new Map();
    if (first) {
      let stock = 0;
      for (let dd = first; dd <= T; dd = addDays(dd, 1)) {
        stock += d.receipts.get(dd) || 0;
        if (stock > 0 || d.sales.get(dd)) inStockDays.add(dd);
        stock -= d.sales.get(dd) || 0;
        stock += d.restocked.get(dd) || 0;
        stock -= d.losses.get(dd) || 0;
        stock = Math.max(stock, 0);
        stockByDay.set(dd, stock);
      }
    }
    const maxS = (a, b) => (a > b ? a : b);
    const winStart = maxS(addDays(T, -(windowDays - 1)), first || T);
    const recStart = maxS(addDays(T, -(RECENT_DAYS - 1)), first || T);
    const soldBetween = (a, b) => {
      let x = 0;
      for (const [dd, v] of d.sales) if (a <= dd && dd <= b) x += v;
      let y = 0;
      for (const [dd, v] of d.returns) if (a <= dd && dd <= b) y += v;
      return x - y;
    };
    const isd = [...inStockDays];
    const exposure = isd.filter(x => x >= winStart).length;
    const exposureRecent = isd.filter(x => x >= recStart).length;
    const spanDays = daysBetween(T, winStart) + 1;
    const netWindow = soldBetween(winStart, T);
    let missedWindow = 0;
    for (const [dd, v] of d.missed) if (winStart <= dd && dd <= T) missedWindow += v;
    const rateWindow = exposure ? netWindow / (exposure / 7.0) : 0.0;
    const rateRecent = exposureRecent ? soldBetween(recStart, T) / (exposureRecent / 7.0) : 0.0;
    const blended = exposure >= 42 && exposureRecent >= 14;
    const rate = blended ? 0.5 * rateRecent + 0.5 * rateWindow : rateWindow;
    const missedRate = spanDays ? missedWindow / (spanDays / 7.0) : 0.0;
    const histDays = isd.filter(x => x >= winStart);
    const histFactor = histDays.length ? histDays.reduce((a, x) => a + factor(x), 0) / histDays.length : 1.0;
    const observed = rate + missedRate;
    const base = observed / histFactor;
    const weeks = [];
    for (let end = T; addDays(end, -6) >= winStart; end = addDays(end, -7)) {
      const a = addDays(end, -6), b = end;
      const n = isd.filter(x => a <= x && x <= b).length;
      if (n >= 4) weeks.push(soldBetween(a, b) * 7.0 / n);
    }
    const costBox = d.box_costs.length ? d.box_costs.reduce((a, x) => a + x, 0) / d.box_costs.length : 0.0;
    const priceBox = d.sold_boxes ? d.sales_rev / d.sold_boxes : null;
    const netSold = d.sold_boxes - d.returned_boxes;
    const gpWindow = priceBox !== null ? netWindow * (priceBox - costBox) : 0.0;
    const gpAll = (d.sales_rev - d.refunds) - netSold * costBox;
    const daysSince = first ? daysBetween(T, first) + 1 : 0;
    const sv = [...stockByDay.values()];
    const avgStock = sv.length ? sv.reduce((a, x) => a + x, 0) / sv.length : 0.0;
    const gmroi = daysSince && avgStock > 0 && costBox > 0 ? (gpAll / daysSince * 365) / (avgStock * costBox) : null;
    const margin = priceBox ? (priceBox - costBox) / priceBox * 100 : null;
    const custVals = [...d.customers.values()];
    const topShare = netSold >= 10 && custVals.length ? Math.max(...custVals) / netSold : null;
    rows.push({ key: k, label: d.label, style: d.style, size_run: d.size_run, pairs_per_box: d.pairs_per_box, groups: d.groups, first_day: first,
      days_since: daysSince, exposure, exposure_recent: exposureRecent, span_days: spanDays, win_start: winStart, blended, net_window: netWindow,
      rate_window: rateWindow, rate_recent: rateRecent, rate, missed_window: missedWindow, missed_rate: missedRate, hist_factor: histFactor,
      observed, base_raw: base, weeks, in_stock: d.in_stock, on_order: d.on_order, received: d.received_boxes, sold: d.sold_boxes,
      returned: d.returned_boxes, net_sold: netSold, sell_through: d.received_boxes ? netSold / d.received_boxes : null,
      cost_box: costBox, price_box: priceBox, margin, gp_window: gpWindow, gp_all: gpAll, gmroi, oldest_in_stock: d.oldest_in_stock,
      top_customer_share: topShare, sold_out: d.in_stock === 0 && d.received_boxes > 0 });
  }

  // a short history leans toward the average model
  const judged = rows.filter(r => r.exposure >= EARLY_DAYS).map(r => r.base_raw);
  const pool = judged.length ? judged : rows.filter(r => r.exposure >= 7).map(r => r.base_raw);
  const prior = pool.length ? [...pool].sort((a, b) => a - b)[Math.floor(pool.length / 2)] : 0.0;
  for (const r of rows) {
    if (r.exposure < EARLY_DAYS) {
      const w = r.exposure / (r.exposure + PRIOR_DAYS);
      r.base = w * r.base_raw + (1 - w) * prior;
      r.shrunk = true;
    } else { r.base = r.base_raw; r.shrunk = false; }
    r.prior = prior;
  }
  // ABC on gross profit over the history window
  const totalGp = rows.reduce((a, r) => a + Math.max(r.gp_window, 0), 0);
  let running = 0.0;
  for (const r of [...rows].sort((a, b) => b.gp_window - a.gp_window)) {
    if (r.gp_window <= 0 || totalGp <= 0) { r.abc = 'C'; continue; }
    const before = running / totalGp;
    running += r.gp_window;
    r.abc = before < 0.80 ? 'A' : before < 0.95 ? 'B' : 'C';
  }

  const leadDays = Math.trunc(pyRound(L * 7)), coverDays = Math.trunc(pyRound(C * 7));
  const leadEnd = addDays(T, leadDays), coverEnd = addDays(leadEnd, coverDays);
  let leadFactorSum = 0, coverFactorSum = 0;
  for (let i = 1; i <= leadDays; i++) leadFactorSum += factor(addDays(T, i));
  for (let i = 1; i <= coverDays; i++) coverFactorSum += factor(addDays(leadEnd, i));
  const moq = Math.trunc(s.buy_min_boxes);
  for (const r of rows) {
    const daily = r.base / 7.0;
    r.demand_lead = daily * leadFactorSum;
    r.demand_cover = daily * coverFactorSum;
    let sigma;
    if (r.weeks.length >= 6) {
      const mean = r.weeks.reduce((a, x) => a + x, 0) / r.weeks.length;
      sigma = Math.sqrt(r.weeks.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.weeks.length - 1));
      r.sigma_from = 'weeks';
    } else { sigma = Math.sqrt(Math.max(r.base, 0)); r.sigma_from = 'normal'; }
    r.sigma = sigma;
    r.safety = r.abc === 'A' || r.abc === 'B' ? z * sigma * Math.sqrt(L) : 0.0;
    const need = r.demand_lead + r.demand_cover + r.safety - r.in_stock - r.on_order;
    r.need = need;
    r.raw = Math.max(0, Math.ceil(need - 1e-9));
    r.weekly_now = r.base * factor(T);
    r.weeks_cover = r.base > 0.0001 ? (r.in_stock + r.on_order) / r.base : null;
    let stock = Number(r.in_stock), out = null;
    if (r.base > 0.0001) {
      for (let i = 1; i < 366; i++) {
        const dd = addDays(T, i);
        stock -= daily * factor(dd);
        if (stock <= 0) { out = dd; break; }
      }
    } else if (r.in_stock === 0) out = T;
    r.stockout = out;
    r.order_by = out ? addDays(out, -leadDays) : null;
    const age = r.oldest_in_stock ? daysBetween(T, r.oldest_in_stock) : 0;
    r.stock_age = age;
    // the supplier minimum
    let rec = r.raw;
    const notes = [];
    if (rec > 0 && rec < moq) {
      if (((r.abc === 'A' || r.abc === 'B') && rec * 2 >= moq) || r.missed_window > 0) {
        notes.push(t('{n} needed, raised to the supplier minimum of {m} boxes', { n: rec, m: moq }));
        rec = moq;
      } else {
        notes.push(t('only {n} box(es) needed, below the supplier minimum of {m} — not worth an order yet', { n: rec, m: moq }));
        rec = 0;
      }
    }
    r.rec = rec; r.notes = notes;
    // the label
    const early = r.exposure < EARLY_DAYS;
    const slowOld = r.sell_through !== null && r.sell_through < 0.30 && age >= 90;
    const overstock = !early && r.weeks_cover !== null && r.weeks_cover >= 2 * (L + C);
    let label;
    if ((slowOld || overstock) && r.in_stock > 0) { label = 'clear'; r.rec = 0; }
    else if (early && r.received) label = 'early';
    else if (r.rec > 0) label = r.abc === 'A' || r.abc === 'B' ? 'reorder' : 'watch';
    else if ((r.margin !== null && r.margin < 10) || (r.abc === 'C' && r.sell_through !== null && r.sell_through < 0.5 && r.days_since >= 60)) label = 'stop';
    else label = 'enough';
    r.label_key = label;
    r.label_text = t(LABELS[label][0]); r.label_hint = t(LABELS[label][1]);
    // warnings
    const w = [];
    if (r.margin !== null && r.margin < 10) w.push(t('thin margin: {m}%', { m: pyRound(r.margin, 0) }));
    if (r.top_customer_share !== null && r.top_customer_share > 0.6) w.push(t('one customer bought {p}% of it', { p: pyRound(r.top_customer_share * 100, 0) }));
    if (r.sold_out && r.days_since && r.days_since <= 45) w.push(t('sold out within {n} days of arriving — probably underbought', { n: r.days_since }));
    if (r.missed_window) w.push(t('{n} box(es) asked for when you didn’t have it', { n: r.missed_window }));
    r.warnings = w;
  }

  // the container
  const cap = Math.trunc(s.buy_container_boxes);
  const orderRank = { reorder: 0, watch: 1, early: 2 };
  for (const r of rows) { r.plan = has(orderRank, r.label_key) ? r.rec : 0; r.trimmed = 0; }
  const total = rows.reduce((a, r) => a + r.plan, 0);
  const far = addDays(T, 999);
  if (total > cap) {
    const keep = rows.filter(r => r.plan).sort((a, b) => (orderRank[a.label_key] - orderRank[b.label_key]) || ('ABC'.indexOf(a.abc) - 'ABC'.indexOf(b.abc))
      || cmpStr(a.order_by || far, b.order_by || far));
    let used = 0;
    for (const r of keep) {
      const room = cap - used;
      const take = r.plan <= room ? r.plan : (room >= moq ? room : 0);
      r.trimmed = r.plan - take;
      r.plan = take;
      used += take;
    }
  }
  let topped = 0;
  if (s.buy_fill && rows.reduce((a, r) => a + r.plan, 0) < cap) {
    const best = rows.filter(r => (r.abc === 'A' || r.abc === 'B') && r.base > 0.0001 && ['reorder', 'watch', 'enough'].includes(r.label_key));
    const maxCover = Number(s.buy_max_cover_weeks);
    let room = cap - rows.reduce((a, r) => a + r.plan, 0), progress = true;
    while (room > 0 && best.length && progress) {
      progress = false;
      for (const r of [...best].sort((a, b) => b.base - a.base)) {
        if (room <= 0) break;
        if ((r.in_stock + r.on_order + r.plan + 1) / r.base <= maxCover) {
          r.plan += 1; r.topped = (r.topped || 0) + 1; room -= 1; topped += 1; progress = true;
        }
      }
    }
  }
  const pace = rows.reduce((a, r) => a + r.base, 0);
  const planned = rows.reduce((a, r) => a + r.plan, 0);
  const orderDates = rows.filter(r => r.order_by && (r.abc === 'A' || r.abc === 'B')).map(r => r.order_by);
  const deadlines = [];
  for (const e of events) {
    if (e.start_date < T) {
      if ((e.end_date || e.start_date) >= T) deadlines.push({ ...e, order_by: null, status: 'now on' });
      continue;
    }
    const ob = addDays(e.start_date, -leadDays);
    deadlines.push({ ...e, order_by: ob, status: ob < T ? 'late' : daysBetween(ob, T) <= 28 ? 'soon' : 'later' });
  }
  deadlines.sort((a, b) => cmpStr(a.start_date, b.start_date));
  const labelOrder = ['reorder', 'watch', 'early', 'enough', 'clear', 'stop'];
  rows.sort((a, b) => (labelOrder.indexOf(a.label_key) - labelOrder.indexOf(b.label_key)) || ('ABC'.indexOf(a.abc) - 'ABC'.indexOf(b.abc)) || (b.base - a.base));
  const counts = {};
  for (const k of labelOrder) counts[k] = rows.filter(r => r.label_key === k).length;
  return { rows, settings: s, today: T, lead_end: leadEnd, cover_end: coverEnd, pace, container_weeks: pace > 0.0001 ? cap / pace : null,
    planned, capacity: cap, topped, trimmed: rows.reduce((a, r) => a + r.trimmed, 0), next_order: orderDates.length ? orderDates.sort(cmpStr)[0] : null,
    deadlines, requested_only: [...requestedOnly.values()].sort((a, b) => b.boxes - a.boxes), prior, lead_measured: measuredLeadWeeks(), counts };
}

// ---------- operations (events, missed sales, settings) ----------
function eventValues(f) {
  const name = String(f.name || '').trim();
  const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '').slice(0, 10)) && !Number.isNaN(ms(String(d).slice(0, 10)));
  if (!ok(f.start_date) || !(ok(f.end_date) || (!f.end_date && ok(f.start_date)))) refuse('Enter the event’s start and end dates.');
  const start = String(f.start_date).slice(0, 10), end = String(f.end_date || f.start_date).slice(0, 10);
  const boost = f.boost_percent === '' || f.boost_percent === undefined || f.boost_percent === null ? 0 : Number(f.boost_percent);
  if (!name) refuse('Give the event a name.');
  if (end < start) refuse('The event ends before it starts.');
  if (!Number.isFinite(boost) || boost < -90 || boost > 500) refuse('The boost is a percentage, e.g. 30 for 30% more sales (or -20 for a quiet period).');
  return { name, start_date: start, end_date: end, boost_percent: boost, notes: String(f.notes || '').trim() };
}
export function eventNew(f) {
  const e = eventValues(f);
  ins('sales_events', e);
  return t('Event added: {n}.', { n: e.name });
}
export function eventEdit(id, f) {
  const e = eventValues(f);
  run(`UPDATE sales_events SET name = ?, start_date = ?, end_date = ?, boost_percent = ?, notes = ? WHERE id = ?`, [e.name, e.start_date, e.end_date, e.boost_percent, e.notes, id]);
  return t('Event updated: {n}.', { n: e.name });
}
export function eventDelete(id) { run(`DELETE FROM sales_events WHERE id = ?`, [id]); return t('Event removed.'); }
export function eventsGuinea() {
  const T = todayStr();
  let added = 0;
  for (const [name, start, end] of GUINEA_EVENTS) {
    if (end < T) continue;
    if (!val(`SELECT 1 FROM sales_events WHERE start_date = ? AND name = ?`, [start, name])) {
      ins('sales_events', { name, start_date: start, end_date: end, boost_percent: 0 });
      added++;
    }
  }
  return added ? t('Added {n} event(s). Check the dates, then set how much more you expect to sell in each (the boost).', { n: added })
    : t('The usual events are already in your calendar.');
}
export function missedNew(f) {
  const raw = String(f.happened_on || '').trim();
  let d = todayStr();
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) refuse('That date isn’t valid.');
    d = raw.slice(0, 10);
    if (d > todayStr()) refuse('That date is in the future.');
  }
  const key = f.model_key || '';
  const desc = String(f.description || '').trim();
  const boxes = f.boxes === '' || f.boxes === undefined || f.boxes === null ? 1 : Number(f.boxes);
  const M = models();
  if (!Number.isFinite(boxes) || boxes < 1 || boxes !== Math.trunc(boxes)) refuse('How many boxes did they ask for? Enter a whole number, e.g. 5.');
  if (key && !M.has(key)) refuse('That model wasn’t found.');
  if (!key && !desc) refuse('Choose the model they asked for, or describe it if you don’t stock it.');
  const label = key ? M.get(key).label : null;
  ins('missed_sales', { happened_on: d, model_key: key || null, model_label: label, description: desc || null, boxes: Math.trunc(boxes),
    customer_id: asId(f.customer_id), note: String(f.note || '').trim() || null });
  return t('Missed sale recorded: {n} box(es) of {m}.', { n: Math.trunc(boxes), m: label || desc });
}
export function missedDelete(id) { run(`DELETE FROM missed_sales WHERE id = ?`, [id]); return t('Missed sale removed.'); }
export function settingsSave(f) {
  const values = {}, errors = [];
  for (const [key, label, lo, hi] of [['buy_lead_weeks', 'Lead time', 1, 60], ['buy_cover_weeks', 'Cover', 1, 52], ['buy_container_boxes', 'Container size', 1, 100000],
    ['buy_min_boxes', 'Supplier minimum', 0, 10000], ['buy_history_weeks', 'History', 2, 104], ['buy_max_cover_weeks', 'Maximum cover', 1, 104]]) {
    const v = f[key] === '' || f[key] === undefined || f[key] === null ? null : Number(f[key]);
    if (v === null || !Number.isFinite(v) || v < lo || v > hi) errors.push(t('{l} must be a number between {lo} and {hi}.', { l: t(label), lo, hi }));
    else values[key] = v;
  }
  if (has(SERVICE_Z, f.buy_service || '')) values.buy_service = f.buy_service;
  values.buy_fill = f.buy_fill ? 1 : 0;
  if (errors.length) refuse(errors.join(' '));
  saveSettings(values);
  return t('Buying plan settings saved.');
}

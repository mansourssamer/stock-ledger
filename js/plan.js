// Buying plan, event calendar and missed sales (buying_plan.html, events.html, missed_sales.html).
import { all, one } from './localdb.js';
import * as B from './buying.js';
import { asId } from './ops/common.js';
import { t, plural } from './i18n.js';
import { esc, fmtNum, fmtUsd, fmtDate, today, pyRound } from './util.js';
import { header, tile, tiles, panel, pill, empty, table } from './ui.js';
import { openForm, confirmAction } from './forms.js';
import { registerActions } from './actions.js';
import { schedule } from './app.js';
import { subnav, csvCell, downloadText, poNo } from './buy.js';

const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));
const after = () => (msg) => { if (typeof msg === 'string') toast(msg); schedule(); };
const LCLS = { reorder: 'good', watch: 'warn', early: 'accent', enough: '', clear: 'bad', stop: 'bad' };
const g = x => (Number.isInteger(x) ? String(x) : String(pyRound(x, 1)).replace('.', ','));   // '%g' of a value rounded to 1 decimal
const f1 = x => fmtNum(x, 1), f2 = x => fmtNum(x, 2), f0 = x => fmtNum(pyRound(x, 0), 0);
const UI = { open: new Set(), keys: [] };

function buying() {
  const p = B.plan();
  UI.keys = p.rows.map(r => r.key);
  const s = p.settings, cap = p.capacity;
  const out = [header(t('Buying plan'), { sub: esc(t('Lead time {l} weeks · cover {c} weeks after arrival', { l: g(s.buy_lead_weeks), c: g(s.buy_cover_weeks) })),
    actions: `<button class="btn" data-act="missedNew">${esc(t('Record a missed sale'))}</button><a class="btn" href="#/events">${esc(t('Event calendar'))}</a>
      <button class="btn" data-act="planCsv">${esc(t('Download CSV'))}</button><button class="btn" data-act="planSettings">${esc(t('Settings'))}</button>` }), subnav('buying')];
  const pct = cap ? p.planned / cap * 100 : 0;
  out.push(tiles([
    tile(t('Market pace'), `${f1(p.pace)} <small>${esc(t('boxes / week'))}</small>`, esc(t('all your models together, at their real speed'))),
    tile(t('A {n}-box container lasts', { n: cap }), p.container_weeks ? `~${f0(p.container_weeks)} ${esc(t('weeks'))}` : '—', esc(p.container_weeks ? t('at today’s pace') : t('no sales yet to measure'))),
    tile(t('Next order by'), p.next_order ? (p.next_order <= p.today ? esc(t('Now')) : esc(fmtDate(p.next_order))) : '—', esc(t('when your best sellers would run out, less the lead time')), '', p.next_order && p.next_order <= p.today ? 'neg' : ''),
    tile(t('This plan'), `${fmtNum(p.planned)} <small>${esc(plural(p.planned, 'box', 'boxes'))}</small>`, esc(t('{p}% of a {n}-box container', { p: f0(pct), n: cap }) + (p.trimmed ? ' · ' + t('{n} didn’t fit', { n: p.trimmed }) : '')))
  ]));
  for (const e of p.deadlines.filter(e => ['late', 'soon', 'now on'].includes(e.status))) {
    const boost = e.boost_percent ? t('+{b}% sales', { b: g(e.boost_percent) }) : `<a href="#/events">${esc(t('boost not set'))}</a>`;
    const msg = e.status === 'now on' ? esc(t('on now.')) : e.status === 'late' ? esc(t('to have stock in time, the order should have gone by {d} — order as soon as possible.', { d: fmtDate(e.order_by) }))
      : esc(t('order by {d} to have the stock in time.', { d: fmtDate(e.order_by) }));
    out.push(`<div class="callout ${e.status === 'now on' ? '' : 'warn'}"><b>${esc(e.name)}</b> (${esc(fmtDate(e.start_date))} → ${esc(fmtDate(e.end_date))}, ${e.boost_percent ? esc(boost) : boost}) : ${msg}</div>`);
  }
  if (p.rows.length && p.rows.every(r => r.label_key === 'early')) out.push(`<div class="callout">${esc(t('Every model has less than 3 weeks of sales, so these numbers are early estimates: each one leans toward the average of your models until it has its own history.'))}</div>`);
  const chips = ['reorder', 'watch', 'early', 'enough', 'clear', 'stop'].filter(k => p.counts[k]).map(k => pill(`${p.counts[k]} ${t(B.LABELS[k][0])}`, LCLS[k])).join(' ');
  if (chips) out.push(`<div class="chips mbot">${chips}</div>`);
  if (!p.rows.length) out.push(panel('', empty(t('No models yet'), t('The plan starts once a purchase order has mixes in it.'))));
  else {
    const rows = [];
    p.rows.forEach((r, i) => {
      rows.push({ cells: [
        `<b>${esc(r.style)}</b> <span class="muted">${esc(r.size_run)}</span>${r.warnings.map(w => `<span class="sub neg">⚠ ${esc(w)}</span>`).join('')}`,
        `${pill(r.label_text, LCLS[r.label_key])} <span class="muted" title="${esc(t('ABC: A = the models making ~80% of your gross profit'))}">${r.abc}</span>`,
        `${g(pyRound(r.in_stock, 1))}${r.on_order ? `<span class="sub">+ ${fmtNum(r.on_order)} ${esc(t('on order'))}</span>` : ''}`,
        `${f1(r.base)}${r.shrunk ? '*' : ''}`,
        r.weeks_cover !== null ? f0(r.weeks_cover) : '—',
        r.order_by ? (r.order_by <= p.today ? `<b class="neg">${esc(t('now'))}</b>` : esc(fmtDate(r.order_by))) : '',
        `<b>${r.plan || '—'}</b>${r.trimmed ? `<span class="sub neg">${esc(t('{n} didn’t fit', { n: r.trimmed }))}</span>` : ''}`,
        `<button class="btn sm ghost" data-act="planWhy" data-i="${i}" aria-expanded="${UI.open.has(r.key)}">${esc(t('Why'))}</button>`] });
      if (UI.open.has(r.key)) rows.push({ cls: 'why', span: true, cells: [`<div class="whylines">${why(r, p)}</div>`] });
    });
    out.push(panel('', table([{ h: t('Model') }, { h: t('Advice') }, { h: t('In stock'), n: true }, { h: t('Boxes / week'), n: true }, { h: t('Weeks of stock'), n: true, cls: 'hide-sm' },
      { h: t('Order by'), cls: 'hide-sm' }, { h: t('Order (boxes)'), n: true }, { h: '' }], rows), { tight: true }));
    out.push(`<p class="sub">${esc(t('* an early estimate (less than 3 weeks of sales). Boxes / week is the speed in a normal week, counting only days in stock. The letter next to the advice is ABC: A = the models that make about 80% of your gross profit, B = the next 15%, C = the rest. “Order” respects the supplier minimum and the container size. Tap “Why” for the calculation.'))}</p>`);
  }
  if (p.requested_only.length) {
    out.push(panel(t('Asked for, but you don’t stock it'), table([{ h: t('What customers asked for') }, { h: t('Times'), n: true }, { h: t('boxes'), n: true }, { h: t('Last'), cls: 'hide-sm' }],
      p.requested_only.map(q => ({ cells: [esc(q.name), fmtNum(q.times), fmtNum(q.boxes), esc(fmtDate(q.last))] }))), { tight: true }));
    out.push(`<p class="sub">${esc(t('Asked for often? A test order of the supplier minimum ({n} boxes) is a cheap way to find out.', { n: s.buy_min_boxes }))}</p>`);
  }
  if (p.lead_measured.length) out.push(`<p class="sub">${esc(t('Measured from your purchase orders: {l} (from the day the purchase order was entered to arrival — if you entered it after ordering, the real lead time is longer).',
    { l: p.lead_measured.map(([pid, w]) => `${poNo(pid)} ${f0(w)} ${t('weeks')}`).join(', ') }))}</p>`);
  out.push(`<p class="sub"><a href="#/missed">${esc(t('Missed sales'))}</a> · <a href="#/events">${esc(t('Event calendar'))}</a></p>`);
  return out.join('');
}
function why(r, p) {
  const s = p.settings;
  const L = [];
  L.push(t('Received {n} box(es){since}; sold {s}{back}.', { n: r.received, since: r.first_day ? ' ' + t('since {d}', { d: fmtDate(r.first_day) }) : '', s: g(pyRound(r.sold, 1)),
    back: r.returned ? ', ' + t('{n} came back', { n: g(pyRound(r.returned, 1)) }) : '' }) + (r.sell_through !== null ? ' ' + t('Sell-through {p}%.', { p: f0(r.sell_through * 100) }) : ''));
  L.push(t('On the shelf {e} of the last {d} day(s) (since {w}): {n} box(es) net → {r} a week while in stock.', { e: r.exposure, d: r.span_days, w: fmtDate(r.win_start), n: g(pyRound(r.net_window, 1)), r: f2(r.rate_window) })
    + (r.blended ? ' ' + t('Last 4 weeks: {a} a week; recent weeks count half → {r}.', { a: f2(r.rate_recent), r: f2(r.rate) }) : ''));
  if (r.missed_window) L.push(t('Missed sales: {n} box(es) asked for when you didn’t have it → +{r} a week.', { n: r.missed_window, r: f2(r.missed_rate) }));
  if (r.hist_factor > 1.001 || r.hist_factor < 0.999) L.push(t('Those weeks had event boosts (×{f} on average), taken out → {b} a week in a normal period.', { f: f2(r.hist_factor), b: f2(r.base_raw) }));
  if (r.shrunk) L.push(t('Only {e} day(s) on the shelf: the estimate leans toward your average model ({a} a week) — {p}% its own figure → {b} a week.', { e: r.exposure, a: f2(r.prior), p: f0(r.exposure / (r.exposure + 21) * 100), b: f2(r.base) }));
  L.push(t('Expected sales: {a} during the {l}-week lead time + {b} for {c} weeks of cover after it arrives (event boosts included).', { a: f1(r.demand_lead), l: g(s.buy_lead_weeks), b: f1(r.demand_cover), c: g(s.buy_cover_weeks) }));
  L.push(r.safety ? t('Safety stock: {s} box(es) of normal weekly ups and downs{e} × √{l} weeks × {z} = {x}.', { s: f2(r.sigma), e: r.sigma_from === 'normal' ? ' ' + t('(estimated — not enough weeks yet)') : '', l: g(s.buy_lead_weeks), z: B.SERVICE_Z[s.buy_service], x: f1(r.safety) })
    : t('Safety stock: none (only for A and B models).'));
  L.push(t('Need = {d} + {s} − {i} in stock − {o} on order = {n} → {r} box(es).', { d: f1(r.demand_lead + r.demand_cover), s: f1(r.safety), i: g(pyRound(r.in_stock, 1)), o: r.on_order, n: f1(r.need), r: r.raw })
    + (r.notes.length ? ' ' + r.notes.join('; ') + '.' : ''));
  L.push((r.in_stock === 0 ? t('Out of stock now → order now.') : r.stockout ? t('Today’s stock runs out around {d}', { d: fmtDate(r.stockout) }) + (r.order_by ? ' → ' + t('order by {d}.', { d: fmtDate(r.order_by) }) : '.') : t('Not selling: today’s stock doesn’t run out.'))
    + (r.price_box ? ' ' + t('Sells at {p} a box, costs {c} landed', { p: fmtUsd(r.price_box), c: fmtUsd(r.cost_box) }) + (r.margin !== null ? ` (${t('{m}% margin', { m: f0(r.margin) })})` : '') + '.' : '')
    + (r.gmroi !== null ? ' ' + t('Each $1 of its stock earns {g} gross profit a year (GMROI).', { g: fmtUsd(r.gmroi) }) : ''));
  return L.map((x, i) => `<div><span class="n">${i + 1}</span>${esc(x)}</div>`).join('');
}

function events() {
  const s = B.getSettings();
  const leadDays = Math.trunc(pyRound(s.buy_lead_weeks * 7));
  const T = today();
  const rows = all(`SELECT * FROM sales_events ORDER BY start_date`).map(e => ({ ...e, order_by: B.addDays(e.start_date, -leadDays), past: e.end_date < T }));
  return header(t('Event calendar'), { back: 'buying', sub: esc(t('Periods when the market buys more (or less) than usual. The buying plan adds the boost to what you will sell, and takes it out of past sales.')),
    actions: `<button class="btn primary" data-act="eventNew">+ ${esc(t('New event'))}</button><button class="btn" data-act="eventsGuinea">${esc(t('Add the usual Guinea events'))}</button>` })
    + panel('', table([{ h: t('Event') }, { h: t('Dates') }, { h: t('Boost'), n: true }, { h: t('Order by'), cls: 'hide-sm' }, { h: '' }],
      rows.map(e => ({ cls: e.past ? 'dim' : '', cells: [`<b>${esc(e.name)}</b>${e.notes ? `<span class="sub">${esc(e.notes)}</span>` : ''}`, `${esc(fmtDate(e.start_date))} → ${esc(fmtDate(e.end_date))}`,
        e.boost_percent ? `${e.boost_percent > 0 ? '+' : ''}${g(e.boost_percent)} %` : `<span class="muted">${esc(t('not set'))}</span>`,
        e.past ? '' : `<span class="${e.order_by < T ? 'neg' : ''}">${esc(fmtDate(e.order_by))}</span>`,
        `<div class="rowacts"><button class="btn sm" data-act="eventEdit" data-id="${esc(e.id)}">${esc(t('Edit'))}</button><button class="btn sm danger" data-act="eventDel" data-id="${esc(e.id)}">✕</button></div>`] })),
      { emptyText: t('No events yet.') }), { tight: true })
    + `<p class="sub">${esc(t('“Order by” = the start of the event less the lead time ({l} weeks).', { l: g(s.buy_lead_weeks) }))}</p>`;
}
function missed() {
  const rows = all(`SELECT m.*, c.name as customer_name FROM missed_sales m LEFT JOIN customers c ON c.id = m.customer_id ORDER BY m.happened_on DESC, m.id DESC LIMIT 300`);
  return header(t('Missed sales'), { back: 'buying', sub: esc(t('A customer asked for a model you didn’t have: demand that never shows up in sales. The buying plan counts it.')),
    actions: `<button class="btn primary" data-act="missedNew">+ ${esc(t('Record a missed sale'))}</button>` })
    + panel('', table([{ h: t('Date') }, { h: t('What they asked for') }, { h: t('boxes'), n: true }, { h: t('Customer'), cls: 'hide-sm' }, { h: '' }],
      rows.map(m => ({ cells: [esc(fmtDate(m.happened_on)), esc(m.model_label || m.description || '') + (m.note ? `<span class="sub">${esc(m.note)}</span>` : ''), fmtNum(m.boxes), esc(m.customer_name || ''),
        `<div class="rowacts"><button class="btn sm danger" data-act="missedDel" data-id="${esc(m.id)}">✕</button></div>`] })),
      { emptyText: t('No missed sales recorded.') }), { tight: true });
}
export const PLAN_SCREENS = { buying: { render: buying }, events: { render: events }, missed: { render: missed } };

const eventFields = e => [
  { name: 'name', label: t('Name'), type: 'text', value: e.name || '' },
  { name: 'start_date', label: t('From'), type: 'date', future: true, value: e.start_date || '' },
  { name: 'end_date', label: t('To'), type: 'date', future: true, value: e.end_date || '' },
  { name: 'boost_percent', label: t('Boost (%)'), type: 'number', value: e.boost_percent ?? 0, hint: t('30 = 30% more sales than usual; -20 for a quiet period') },
  { name: 'notes', label: t('Notes'), type: 'text', value: e.notes || '' }
];
registerActions({
  planWhy: (a) => { const k = UI.keys[Number(a.dataset.i)]; if (!k) return; if (UI.open.has(k)) UI.open.delete(k); else UI.open.add(k); schedule(); },
  planSettings: () => {
    const s = B.getSettings();
    openForm({ title: t('Buying plan settings'), fields: [
      { name: 'buy_lead_weeks', label: t('Lead time (weeks)'), type: 'number', value: s.buy_lead_weeks, hint: t('Order placed in China → boxes on your shelf') },
      { name: 'buy_cover_weeks', label: t('Cover after arrival (weeks)'), type: 'number', value: s.buy_cover_weeks },
      { name: 'buy_container_boxes', label: t('Container (boxes)'), type: 'number', value: s.buy_container_boxes },
      { name: 'buy_min_boxes', label: t('Supplier minimum (boxes)'), type: 'number', value: s.buy_min_boxes },
      { name: 'buy_service', label: t('Safety stock'), type: 'select', value: s.buy_service, options: [['low', t('Low (80%)')], ['normal', t('Normal (90%)')], ['high', t('High (95%)')]] },
      { name: 'buy_history_weeks', label: t('Look back (weeks)'), type: 'number', value: s.buy_history_weeks },
      { name: 'buy_max_cover_weeks', label: t('Max stock per model (weeks)'), type: 'number', value: s.buy_max_cover_weeks },
      { name: 'buy_fill', label: t('Fill the container with the best sellers'), type: 'checkbox', value: s.buy_fill }],
    run: v => B.settingsSave(v), done: after() });
  },
  planCsv: () => {
    const p = B.plan();
    const head = ['model', 'label', 'abc', 'in_stock', 'on_order', 'received', 'net_sold', 'sell_through_pct', 'boxes_per_week', 'weeks_of_cover', 'order_by', 'margin_pct', 'gmroi', 'need', 'recommended', 'in_this_container', 'why'];
    const rows = p.rows.map(r => [r.label, r.label_text, r.abc, r.in_stock, r.on_order, r.received, r.net_sold, r.sell_through !== null ? pyRound(r.sell_through * 100, 1) : '',
      pyRound(r.base, 2), r.weeks_cover !== null ? pyRound(r.weeks_cover, 1) : '', r.order_by || '', r.margin !== null ? pyRound(r.margin, 1) : '', r.gmroi !== null ? pyRound(r.gmroi, 2) : '',
      pyRound(r.need, 1), r.rec, r.plan, [...r.notes, ...r.warnings].join('; ')]);
    downloadText(`plan-achat-${today()}.csv`, '﻿' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n'));
  },
  eventNew: () => openForm({ title: t('New event'), fields: eventFields({}), submit: t('Add'), run: v => B.eventNew(v), done: after() }),
  eventEdit: (a) => { const e = one(`SELECT * FROM sales_events WHERE id = ?`, [asId(a.dataset.id)]); openForm({ title: t('Edit event'), fields: eventFields(e), run: v => B.eventEdit(e.id, v), done: after() }); },
  eventDel: (a) => confirmAction({ title: t('Remove this event?'), text: '', confirm: t('Remove'), run: () => B.eventDelete(asId(a.dataset.id)), done: after() }),
  eventsGuinea: () => confirmAction({ title: t('Add the usual Guinea events?'), text: t('Year-end festivities, Ramadan, Tabaski, back to school — with approximate dates to check (the Islamic holidays follow the moon).'),
    confirm: t('Add'), danger: false, run: () => B.eventsGuinea(), done: after() }),
  missedNew: () => {
    const ms = [...B.models().values()].sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
    openForm({ title: t('Record a missed sale'), submit: t('Record'), intro: esc(t('A customer asked for something you didn’t have. Choose the model, or describe it if you don’t stock it.')),
      fields: [{ name: 'model_key', label: t('Model'), type: 'select', options: [['', t('— not a model I stock —')], ...ms.map(m => [m.key, m.label])] },
        { name: 'description', label: t('Or describe it'), type: 'text', placeholder: t('e.g. Jordan 4 black 40-45') },
        { name: 'boxes', label: t('Boxes asked for'), type: 'number', value: 1 },
        { name: 'customer_id', label: t('Customer'), type: 'select', options: [['', '—'], ...all(`SELECT id, name FROM customers ORDER BY name`).map(c => [c.id, c.name])] },
        { name: 'happened_on', label: t('Date'), type: 'date', value: today() }, { name: 'note', label: t('Notes'), type: 'text' }],
      run: v => B.missedNew(v), done: after() });
  },
  missedDel: (a) => confirmAction({ title: t('Remove this missed sale?'), text: '', confirm: t('Remove'), run: () => B.missedDelete(asId(a.dataset.id)), done: after() })
});

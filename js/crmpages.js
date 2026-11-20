// CRM pages (home, contacts, one contact, customers, announcing new stock, report, zones) and
// proformas (list, the order page's section, the printed proforma in French).
import { all, one } from './localdb.js';
import * as Q from './queries.js';
import * as C from './ops/crm.js';
import * as D from './crmdata.js';
import { asId } from './ops/common.js';
import { t, plural, withLang } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtNum, fmtDate, today } from './util.js';
import { header, tile, tiles, panel, pill, empty, table } from './ui.js';
import { openForm, confirmAction } from './forms.js';
import { registerActions } from './actions.js';
import { go, schedule } from './app.js';
import { change } from './store.js';
import { orderNo } from './sell.js';
import { addDays } from './buying.js';

const id = v => asId(v);
const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));
const after = target => (msg) => { if (typeof msg === 'string') toast(msg); if (target) go(target); else schedule(); };
const lab = (list, k) => t((list.find(x => x[0] === k) || [k, k])[1]);
const STAGE_CLS = { to_contact: '', contacted: 'accent', samples: 'accent', proforma: 'warn', first_order: 'good', regular: 'good', lost: 'bad' };
const GROUP_CLS = { best: 'good', regular: 'good', new: 'accent', at_risk: 'warn', lost: 'bad', none: '' };
const stagePill = s => pill(lab(C.STAGES, s), STAGE_CLS[s] || '');
const groupPill = g => pill(t(C.GROUP_TAG[g] || g), GROUP_CLS[g] || '');
const STATE_CLS = { valid: 'good', expired: 'warn', delivered: 'accent', cancelled: 'bad' };
const STATE = { valid: 'Valid', expired: 'Expired', delivered: 'Delivered', cancelled: 'Cancelled' };
const waBtn = (num, text = '') => (num ? `<a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${esc(num)}${text ? '?text=' + D.pyQuote(text) : ''}">WhatsApp</a>` : '');
const UI = { stage: '', kind: '', zone: '', show: 'active', group: '', ann: { product_id: '', who: ['bought', 'asked'], kind: '', zone: '', msg: D.ANNOUNCE_DEFAULT } };

// Opening a CRM page puts the starting zones in and gives every customer a contact (as the old app did).
let syncing = false;
function ensureCrm() {
  if (syncing || !C.crmNeedsSync()) return;
  syncing = true;
  change(() => C.crmReady()).catch(e => console.warn('crm sync', e)).finally(() => { syncing = false; });
}
export function crmNav(cur) {
  const items = [['crm', t('Follow-ups')], ['crmcontacts', t('Contacts')], ['crmcustomers', t('Customers')], ['announce', t('Announce')], ['crmreport', t('Report')], ['zones', t('Zones')], ['proformas', t('Proformas')]];
  return `<nav class="subnav">${items.map(([k, l]) => `<a href="#/${k}"${cur === k ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;
}

// ---------- home ----------
function crm() {
  const p = D.crmHome();
  const follow = p.follow.map(k => ({ cells: [`<a href="#/crmcontact/${esc(k.id)}"><b>${esc(k.name)}</b></a><span class="sub">${esc(k.follow_up_note || '')}${k.zone_name ? ' · ' + esc(k.zone_name) : ''}</span>`,
    `<span class="${k.next_follow_up < p.today ? 'neg' : ''}">${esc(fmtDate(k.next_follow_up))}</span>`,
    `<div class="rowacts">${waBtn(k.wa)}<button class="btn sm" data-act="crmFollow" data-id="${esc(k.id)}">${esc(t('Later'))}</button><button class="btn sm primary" data-act="crmFollowDone" data-id="${esc(k.id)}">${esc(t('Done'))}</button></div>`] }));
  const call = p.to_call.map(m => ({ cells: [`${m.contact_id !== null ? `<a href="#/crmcontact/${esc(m.contact_id)}"><b>${esc(m.name)}</b></a>` : `<b>${esc(m.name)}</b>`}<span class="sub">${esc(m.styles.join(', '))}</span>`,
    groupPill(m.group) + (m.due ? ` ${pill(t('due to buy'), 'warn')}` : ''), `${esc(t('{n} days', { n: m.days_since }))}<span class="sub">${esc(fmtUsd(m.gp_year))} ${esc(t('profit / 12 months'))}</span>`,
    `<div class="rowacts">${waBtn(m.wa)}</div>`] }));
  return header(t('CRM'), { sub: esc(t('{p} prospects · {c} customers', { p: p.prospects, c: Object.entries(p.group_counts).filter(([g]) => g !== 'none').reduce((s, [, n]) => s + n, 0) })),
    actions: `<button class="btn primary" data-act="crmNew">+ ${esc(t('New contact'))}</button>` }) + crmNav('crm')
    + tiles([tile(t('Follow-ups due'), fmtNum(p.follow.length), ''), tile(t('Customers to call'), fmtNum(p.to_call_total), esc(t('at risk or due to buy'))),
      tile(t('Prospects'), fmtNum(p.prospects), ''), tile(t('Proformas waiting'), fmtNum(p.proformas.length), esc(t('ending soon or just expired')))])
    + panel(t('Follow-ups due'), table([{ h: t('Contact') }, { h: t('Date') }, { h: '' }], follow, { emptyText: t('Nothing to follow up today.') }), { tight: true })
    + panel(t('Customers to call'), table([{ h: t('Customer') }, { h: t('Group') }, { h: t('Last order'), cls: 'hide-sm' }, { h: '' }], call, { emptyText: t('No customer to call right now.') }), { tight: true })
    + (p.proformas.length ? panel(t('Proformas waiting for an answer'), proformaTable(p.proformas), { tight: true }) : '')
    + (p.recent.length ? panel(t('Recent activity'), table([{ h: t('Date') }, { h: t('Contact') }, { h: '' }],
      p.recent.map(a => ({ cells: [esc(fmtDate(a.happened_on)), `<a href="#/crmcontact/${esc(a.contact_id)}">${esc(a.contact_name)}</a>`, `${esc(lab(C.ACTIVITY_KINDS, a.kind))}${a.note ? `<span class="sub">${esc(a.note)}</span>` : ''}`] }))), { tight: true }) : '');
}

// ---------- contacts ----------
function crmcontacts() {
  const rows = D.contactRows({ stage: UI.stage, kind: UI.kind, zone: UI.zone, show: UI.show });
  const zones = all(`SELECT id, name FROM crm_zones WHERE active = 1 ORDER BY sort_order, name`);
  const sel = (name, val, opts) => `<select class="inp" data-crmf="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return header(t('Contacts'), { sub: `${rows.length}`, actions: `<button class="btn primary" data-act="crmNew">+ ${esc(t('New contact'))}</button>` }) + crmNav('crmcontacts')
    + `<div class="inline rbar">${sel('stage', UI.stage, [['', t('Every stage')], ...C.STAGES.map(([k, l]) => [k, t(l)])])}${sel('kind', UI.kind, [['', t('Every kind')], ...C.KINDS.map(([k, l]) => [k, t(l)])])}
      ${sel('zone', UI.zone, [['', t('Every zone')], ...zones.map(z => [z.id, z.name])])}${sel('show', UI.show, [['active', t('Active')], ['archived', t('Archived')], ['all', t('All')]])}</div>`
    + panel('', table([{ h: t('Contact') }, { h: t('Stage') }, { h: t('Last activity'), cls: 'hide-sm' }, { h: t('Follow-up'), cls: 'hide-sm' }],
      rows.map(k => ({ href: `crmcontact/${k.id}`, cls: k.archived ? 'dim' : '', cells: [`<b>${esc(k.name)}</b><span class="sub">${esc([lab(C.KINDS, k.kind), k.zone_name].filter(Boolean).join(' · '))}${k.customer_id !== null ? ' · ' + esc(t('customer')) : ''}</span>`,
        stagePill(k.stage), esc(k.last_activity ? fmtDate(k.last_activity) : '—'), k.next_follow_up ? `<span class="${k.next_follow_up <= today() ? 'neg' : ''}">${esc(fmtDate(k.next_follow_up))}</span>` : ''] })),
      { emptyText: t('No contacts match.') }), { tight: true });
}
function crmcontact(kidRaw) {
  const p = D.contactPage(id(kidRaw));
  if (!p) return header(t('Contacts'), { back: 'crmcontacts' }) + empty('—');
  const k = p.k, K = esc(k.id), m = p.insight;
  const acts = [`<button class="btn primary" data-act="crmActivity" data-id="${K}">+ ${esc(t('Note an exchange'))}</button>`, waBtn(p.wa),
    `<button class="btn" data-act="crmStage" data-id="${K}">${esc(t('Stage'))}</button>`, `<button class="btn" data-act="crmEdit" data-id="${K}">${esc(t('Edit'))}</button>`];
  if (k.customer_id === null) acts.push(`<button class="btn" data-act="crmMakeCustomer" data-id="${K}">${esc(t('First order'))}</button>`);
  else acts.push(`<a class="btn" href="#/customer/${esc(k.customer_id)}">${esc(t('Customer page'))}</a>`);
  const info = [[t('Kind'), lab(C.KINDS, k.kind)], [t('Zone'), k.zone_name], [t('Phone'), k.phone], ['WhatsApp', k.whatsapp], [t('Email'), k.email], [t('Address'), k.address], [t('Sells'), k.sells],
    [t('Potential (boxes / order)'), k.potential_boxes], [t('Buys from'), k.suppliers], [t('Found through'), k.source], [t('Notes'), k.notes], [t('Lost because'), k.stage === 'lost' ? k.lost_reason : null]]
    .filter(([, v]) => v !== null && v !== undefined && v !== '');
  return header(k.name, { back: 'crmcontacts', eyebrow: t('Contact'), sub: `${stagePill(k.stage)}${k.archived ? ' ' + pill(t('archived')) : ''}${m ? ' ' + groupPill(m.group) : ''}`, actions: acts.join('') })
    + (k.next_follow_up ? `<div class="callout ${k.next_follow_up <= today() ? 'warn' : ''}">${esc(t('Follow up on {d}', { d: fmtDate(k.next_follow_up) }))}${k.follow_up_note ? ' — ' + esc(k.follow_up_note) : ''}
      <button class="btn sm" data-act="crmFollow" data-id="${K}">${esc(t('Change'))}</button><button class="btn sm primary" data-act="crmFollowDone" data-id="${K}">${esc(t('Done'))}</button></div>` : '')
    + (m && m.n ? tiles([tile(t('Orders'), fmtNum(m.n), esc(t('{b} boxes', { b: m.boxes }))), tile(t('Sales'), esc(fmtUsd(m.sales_usd)), esc(t('profit {g}', { g: fmtUsd(m.gp_usd) }))),
      tile(t('Last order'), esc(t('{n} days ago', { n: m.days_since })), m.expected_next ? esc(t('next expected {d}', { d: fmtDate(m.expected_next) })) : ''),
      tile(t('Pays in'), m.pay_days === null ? '—' : esc(t('{n} days', { n: Math.round(m.pay_days) })), esc(m.styles.join(', ')))]) : '')
    + (p.credit ? `<div class="callout ${p.credit.over_now ? 'bad' : ''}">${esc(t('Owes {o} of a {l} credit limit.', { o: fmtUsd(p.credit.exposure_usd), l: fmtUsd(p.credit.limit_usd ?? 0) }))}</div>` : '')
    + `<div class="grid2">${panel(t('Details'), `<div class="panel-b"><div class="kv">${info.map(([a, b]) => `<span>${esc(a)}</span><b>${esc(String(b))}</b>`).join('')}</div></div>`)}
      ${panel(t('Exchanges'), table([{ h: t('Date') }, { h: '' }, { h: '' }], p.activities.map(a => ({ cells: [esc(fmtDate(a.happened_on)), `<b>${esc(lab(C.ACTIVITY_KINDS, a.kind))}</b>${a.note ? `<span class="sub">${esc(a.note)}</span>` : ''}`,
        `<div class="rowacts"><button class="btn sm danger" data-act="crmActDel" data-id="${esc(a.id)}">✕</button></div>`] })), { emptyText: t('Nothing noted yet.') }), { tight: true })}</div>`
    + (p.orders.length ? panel(t('Orders'), table([{ h: t('Order') }, { h: t('Status') }, { h: t('Total'), n: true }], p.orders.map(o => ({ href: `order/${o.id}`, cells: [`<span class="mono">${esc(orderNo(o.id))}</span><span class="sub">${esc(fmtDate(o.created_at))}</span>`,
      pill(t(o.status === 'fulfilled' ? 'Delivered' : o.status === 'cancelled' ? 'Cancelled' : 'Open'), { fulfilled: 'good', cancelled: 'bad', open: 'warn' }[o.status]), esc(fmtMoney(o.order_total, o.currency_code))] }))), { tight: true }) : '')
    + (p.proformas.length ? panel(t('Proformas'), proformaTable(p.proformas), { tight: true }) : '')
    + `<div class="actions"><button class="btn" data-act="crmArchive" data-id="${K}">${esc(k.archived ? t('Bring back') : t('Archive'))}</button>${k.customer_id === null ? `<button class="btn danger" data-act="crmDelete" data-id="${K}">${esc(t('Delete'))}</button>` : ''}</div>`;
}

// ---------- customers by group ----------
function crmcustomers() {
  const p = D.crmCustomers(UI.group);
  const chips = [['', t('All')], ...C.GROUPS.map(([g, l]) => [g, t(l)])].map(([g, l]) => `<button type="button" class="chip" data-act="crmGroup" data-v="${g}" aria-pressed="${UI.group === g}">${esc(l)}${g ? ` · ${p.counts[g]}` : ''}</button>`).join('');
  return header(t('Customers'), { sub: esc(t('Grouped by how often and how recently they buy')) }) + crmNav('crmcustomers') + `<div class="chips mbot">${chips}</div>`
    + panel('', table([{ h: t('Customer') }, { h: t('Group') }, { h: t('Last order'), cls: 'hide-sm' }, { h: t('Profit / 12 months'), n: true }, { h: t('Owes'), n: true, cls: 'hide-sm' }, { h: '' }],
      p.rows.map(m => ({ cells: [`${m.contact_id !== null ? `<a href="#/crmcontact/${esc(m.contact_id)}"><b>${esc(m.name)}</b></a>` : `<b>${esc(m.name)}</b>`}<span class="sub">${esc(m.styles.join(', '))}</span>`,
        groupPill(m.group) + (m.due ? ` ${pill(t('due to buy'), 'warn')}` : ''), m.n ? `${esc(fmtDate(m.last))}<span class="sub">${esc(t('{n} orders', { n: m.n }))}${m.interval ? ' · ' + esc(t('every {d} days', { d: Math.round(m.interval) })) : ''}</span>` : '—',
        esc(fmtUsd(m.gp_year)), m.exposure_usd > 0.004 ? `<span class="${m.credit && m.credit.over_now ? 'neg' : ''}">${esc(fmtUsd(m.exposure_usd))}</span>` : '—', `<div class="rowacts">${waBtn(m.wa)}</div>`] })),
      { emptyText: t('No customers in this group.') }), { tight: true });
}

// ---------- announcing new stock ----------
function announce() {
  const a = UI.ann;
  const p = D.announce({ product_id: a.product_id === '' ? null : id(a.product_id), who: a.who, kind: a.kind, zone: a.zone, msg: a.msg });
  const prods = all(`SELECT id, name FROM products ORDER BY name`), zones = all(`SELECT id, name FROM crm_zones WHERE active = 1 ORDER BY sort_order, name`);
  const WHO = [['bought', t('Bought this style')], ['asked', t('Asked for it')], ['customers', t('Every customer')], ['prospects', t('Prospects')]];
  return header(t('Announce new stock'), { sub: esc(t('Who to tell, each with a WhatsApp message ready to send.')) }) + crmNav('announce')
    + panel('', `<div class="panel-b form ann">
      <div class="field"><label>${esc(t('Style'))}</label><select class="inp" data-ann="product_id"><option value="">—</option>${prods.map(x => `<option value="${esc(x.id)}"${String(x.id) === String(a.product_id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('Zone'))}</label><select class="inp" data-ann="zone"><option value="">${esc(t('Every zone'))}</option>${zones.map(z => `<option value="${esc(z.id)}"${String(z.id) === a.zone ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select></div>
      <div class="field full"><label>${esc(t('Who'))}</label><div class="chips">${WHO.map(([k, l]) => `<button type="button" class="chip" data-act="annWho" data-v="${k}" aria-pressed="${a.who.includes(k)}">${esc(l)}</button>`).join('')}</div></div>
      <div class="field full"><label>${esc(t('Message'))}</label><textarea class="inp" rows="3" data-ann="msg">${esc(a.msg)}</textarea><span class="hint">${esc(t('{nom} = the contact’s name, {modele} = the style.'))}</span></div></div>`)
    + panel(`${p.rows.length} ${plural(p.rows.length, 'contact', 'contacts')}`, table([{ h: t('Contact') }, { h: t('Why'), cls: 'hide-sm' }, { h: '' }],
      p.rows.map(r => ({ cells: [`<a href="#/crmcontact/${esc(r.id)}"><b>${esc(r.name)}</b></a><span class="sub">${esc([r.zone, r.last ? fmtDate(r.last) : ''].filter(Boolean).join(' · '))}</span>`,
        esc(r.why.map(w => t(w)).join(', ')), r.link ? `<div class="rowacts"><a class="btn sm primary" target="_blank" rel="noopener" href="${esc(r.link)}" data-act="annSent" data-id="${esc(r.id)}" data-note="${esc(p.log_note)}">WhatsApp</a></div>` : `<span class="muted">${esc(t('no number'))}</span>`] })),
      { emptyText: p.product || a.who.some(w => w === 'customers' || w === 'prospects') ? t('Nobody matches.') : t('Choose a style first.') }), { tight: true });
}

// ---------- report and zones ----------
function crmreport() {
  const p = D.crmReport();
  const max = Math.max(1, ...Object.values(p.funnel));
  return header(t('CRM report'), { sub: esc(t('{t} contacts · {r} reached · {w} customers', { t: p.total, r: p.reached, w: p.won })) }) + crmNav('crmreport')
    + tiles([tile(t('Reached'), p.total ? `${Math.round(p.reached / p.total * 100)} %` : '—', esc(`${p.reached} / ${p.total}`)), tile(t('Became customers'), p.total ? `${Math.round(p.won / p.total * 100)} %` : '—', esc(`${p.won}`)),
      tile(t('Potential'), fmtNum(p.potential), esc(t('boxes per order, prospects and customers'))), tile(t('Sold in 30 days'), fmtNum(p.sold_30), esc(t('boxes · goal {g} (a container)', { g: p.goal })))])
    + panel(t('From prospect to customer'), `<div class="panel-b"><div class="bars">${p.stages.map(s => `<div class="bar-row"><span>${esc(lab(C.STAGES, s))}</span><b>${p.funnel[s]}</b>
      <div class="bar-track"><div class="bar-fill" style="width:${(p.funnel[s] / max * 100).toFixed(1)}%"></div></div></div>`).join('')}</div>
      ${p.avg_wait !== null ? `<p class="sub gap-t">${esc(t('On average {n} days from adding a prospect to their first order.', { n: Math.round(p.avg_wait) }))}</p>` : ''}</div>`)
    + panel(t('By zone'), table([{ h: t('Zone') }, { h: t('Contacts'), n: true }, { h: t('Customers'), n: true }, { h: t('Potential'), n: true, cls: 'hide-sm' }],
      p.by_zone.map(z => ({ cells: [esc(z.name || '—') + (z.area ? `<span class="sub">${esc(z.area)}</span>` : ''), fmtNum(z.total), fmtNum(z.stages.first_order + z.stages.regular), fmtNum(z.potential)] })), { emptyText: '—' }), { tight: true })
    + `<div class="grid2">${panel(t('By kind'), table([{ h: t('Kind') }, { h: t('Contacts'), n: true }, { h: t('Customers'), n: true }],
      Object.entries(p.by_kind).map(([k, d]) => ({ cells: [esc(lab(C.KINDS, k)), fmtNum(d.total), fmtNum(d.customers)] })), { emptyText: '—' }), { tight: true })}
      ${panel(t('Exchanges in 30 days'), table([{ h: '' }, { h: '', n: true }], C.ACTIVITY_KINDS.map(([k, l]) => ({ cells: [esc(t(l)), fmtNum(p.acts[k] || 0)] }))), { tight: true })}</div>`;
}
function zones() {
  const p = D.zonesPage();
  return header(t('Zones'), { sub: esc(t('Where your contacts are: markets, towns, countries.')), actions: `<button class="btn primary" data-act="zoneNew">+ ${esc(t('New zone'))}</button>` }) + crmNav('zones')
    + p.areas.map(a => panel(a.area || t('No area'), table([{ h: t('Zone') }, { h: t('Contacts'), n: true }, { h: '' }],
      a.zones.map(z => ({ cls: z.active ? '' : 'dim', cells: [esc(z.name) + (z.active ? '' : ' ' + pill(t('hidden'))), fmtNum(z.used),
        `<div class="rowacts"><button class="btn sm" data-act="zoneEdit" data-id="${esc(z.id)}">${esc(t('Edit'))}</button><button class="btn sm" data-act="zoneToggle" data-id="${esc(z.id)}">${esc(z.active ? t('Hide') : t('Show'))}</button>${z.used ? '' : `<button class="btn sm danger" data-act="zoneDel" data-id="${esc(z.id)}">✕</button>`}</div>`] }))), { tight: true })).join('');
}

// ---------- proformas ----------
function proformaTable(list) {
  return table([{ h: t('Proforma') }, { h: t('Customer'), cls: 'hide-sm' }, { h: t('Valid until') }, { h: t('Total'), n: true }, { h: '' }],
    list.map(pf => ({ cells: [`<span class="mono">${esc(pf.number)}</span><span class="sub">${esc(fmtDate(pf.issued_on))}${pf.order_id !== null ? ` · <a href="#/order/${esc(pf.order_id)}">${esc(orderNo(pf.order_id))}</a>` : ''}</span>`,
      esc(pf.customer.name || t('Walk-in customer')), `${pill(t(STATE[pf.state]), STATE_CLS[pf.state])} <span class="sub">${esc(fmtDate(pf.valid_until))}</span>${pf.changed ? `<span class="sub neg">${esc(t('the order changed since'))}</span>` : ''}`,
      esc(fmtMoney(pf.total, pf.currency_code)), `<div class="rowacts"><a class="btn sm" href="#/doc/proforma/${esc(pf.id)}">${esc(t('Print'))}</a>${pf.status !== 'void' ? `<button class="btn sm danger" data-act="pfVoid" data-id="${esc(pf.id)}">✕</button>` : ''}</div>`] })),
    { emptyText: t('No proformas yet.') });
}
function proformas() {
  const p = D.proformasPage();
  return header(t('Proformas'), { sub: esc(t('Priced offers sent before delivery. They don’t change stock, sales or the accounts.')) }) + crmNav('proformas')
    + panel('', proformaTable(p.proformas), { tight: true });
}
// The order page's proforma section (order_detail.html #proformas).
export function orderProformas(orderId, open) {
  const list = all(`SELECT * FROM proformas WHERE order_id = ? ORDER BY id DESC`, [orderId]).map(pf => C.proformaView(pf));
  if (!list.length && !open) return '';
  return panel(t('Proformas'), list.length ? proformaTable(list) : `<div class="panel-b">${empty(t('No proforma yet.'), t('A proforma is a priced offer to send the customer before delivery, so they can confirm or pay first.'))}</div>`,
    { tight: true, actions: open ? `<button class="btn sm" data-act="pfNew" data-id="${esc(orderId)}">+ ${esc(t('Proforma'))}</button>` : '' });
}
const day = s => { const d = String(s || '').slice(0, 10).split('-'); return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(s || ''); };
export function proformaDoc(pfId) {
  const raw = one(`SELECT * FROM proformas WHERE id = ?`, [pfId]);
  if (!raw) return '<p>—</p>';
  const pf = C.proformaView(raw);
  return withLang('fr', () => {
    const m = v => esc(fmtMoney(v, pf.currency_code));
    return `<div class="dh"><div><h1>Facture proforma ${esc(pf.number)}</h1><div class="mono">Date ${esc(day(pf.issued_on))}</div><div class="mono">Valable jusqu’au ${esc(day(pf.valid_until))}</div></div>
      ${pf.state === 'expired' || pf.state === 'cancelled' ? `<span class="stamp">${pf.state === 'expired' ? 'Expirée' : 'Annulée'}</span>` : ''}</div>
      <div class="parties"><div><div class="lbl">Client</div><b>${esc(pf.customer.name || 'Client de passage')}</b>${[pf.customer.email, pf.customer.phone, pf.customer.address].filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('')}</div>
        ${pf.order_id !== null ? `<div style="text-align:right"><div class="lbl">Commande</div><div>${esc(orderNo(pf.order_id))}</div></div>` : ''}</div>
      ${pf.box_lines.length ? `<table><thead><tr><th>Description</th><th class="r">Cartons</th><th class="r">Prix / paire</th><th class="r">Prix / carton</th><th class="r">Total</th></tr></thead><tbody>
        ${pf.box_lines.map(b => `<tr><td>${esc(b.description)}<div style="font-size:11px;color:#666">${esc(b.pairs_per_box)} paires par carton · ${esc(b.detail)}</div></td><td class="r">${esc(b.qty)}</td>
          <td class="r">${b.price_per_pair ? m(b.price_per_pair) : '—'}</td><td class="r">${m(b.unit_price)}</td><td class="r">${m(b.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${pf.pair_lines.length ? `<table><thead><tr><th>Réf.</th><th>Description</th><th>Pointure</th><th class="r">Qté</th><th class="r">Prix / paire</th><th class="r">Total</th></tr></thead><tbody>
        ${pf.pair_lines.map(i => `<tr><td class="mono">${esc(i.sku || '')}</td><td>${esc(i.description)}</td><td>${esc(i.size)}</td><td class="r">${esc(i.qty)}</td><td class="r">${m(i.unit_price)}</td><td class="r">${m(i.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
      <div class="tot"><div class="g"><span>Total</span><span>${m(pf.total)}</span></div></div>
      ${pf.terms ? `<div style="margin-top:24px;white-space:pre-line"><div class="lbl">Conditions</div>${esc(pf.terms)}</div>` : ''}
      <p style="margin-top:24px;font-size:12px;color:#555;border-top:1px solid #DCD6C9;padding-top:10px">Cette facture proforma n’est pas une facture définitive. Prix valables jusqu’au ${esc(day(pf.valid_until))}, sous réserve de disponibilité du stock.</p>`;
  });
}

export const CRM_SCREENS = {
  crm: { render: crm, mount: ensureCrm }, crmcontacts: { render: crmcontacts, mount: ensureCrm }, crmcontact: { render: crmcontact, mount: ensureCrm },
  crmcustomers: { render: crmcustomers, mount: ensureCrm }, announce: { render: announce, mount: ensureCrm }, crmreport: { render: crmreport, mount: ensureCrm },
  zones: { render: zones, mount: ensureCrm }, proformas: { render: proformas }
};

// ---------- forms ----------
const zoneOpts = (incl = null) => [['', '—'], ...all(`SELECT id, name FROM crm_zones WHERE active = 1 OR id IS ? ORDER BY sort_order, name`, [incl]).map(z => [z.id, z.name])];
const contactFields = (k, isCustomer = false) => [
  ...(isCustomer ? [] : [{ name: 'name', label: t('Name'), type: 'text', value: k.name || '' }]),
  { name: 'kind', label: t('Kind'), type: 'select', options: C.KINDS.map(([v, l]) => [v, t(l)]), value: k.kind || 'retailer' },
  { name: 'zone_id', label: t('Zone'), type: 'select', options: zoneOpts(k.zone_id ?? null), value: k.zone_id ?? '' },
  ...(isCustomer ? [] : [{ name: 'phone', label: t('Phone'), type: 'text', value: k.phone || '' }]),
  { name: 'whatsapp', label: 'WhatsApp', type: 'text', value: k.whatsapp || '', hint: t('If different from the phone') },
  ...(isCustomer ? [] : [{ name: 'email', label: t('Email'), type: 'text', value: k.email || '' }, { name: 'address', label: t('Address'), type: 'text', value: k.address || '' }]),
  { name: 'sells', label: t('Sells'), type: 'text', value: k.sells || '', placeholder: t('Sneakers, sandals…') },
  { name: 'potential_boxes', label: t('Potential (boxes / order)'), type: 'number', value: k.potential_boxes ?? '' },
  { name: 'suppliers', label: t('Buys from'), type: 'text', value: k.suppliers || '' }, { name: 'source', label: t('Found through'), type: 'text', value: k.source || '' },
  { name: 'notes', label: t('Notes'), type: 'textarea', value: k.notes || '' }
];
registerActions({
  crmNew: () => openForm({ title: t('New contact'), submit: t('Add'), fields: [...contactFields({}), { name: 'stage', label: t('Stage'), type: 'select', options: C.PROSPECT_STAGES.map(s => [s, lab(C.STAGES, s)]) }],
    run: v => { C.crmReady(); return C.contactNew({ ...v, zone_id: v.zone_id === '' ? '' : String(v.zone_id) }); }, done: kid => { toast(t('Contact added.')); go(`crmcontact/${kid}`); } }),
  crmEdit: (a) => { const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Edit contact'), intro: k.customer_id !== null ? esc(t('Name, phone, email and address come from the customer record (they are on invoices).')) : '', fields: contactFields(k, k.customer_id !== null), run: v => C.contactEdit(k.id, v), done: after() }); },
  crmStage: (a) => {
    const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Stage'), fields: [{ name: 'stage', label: t('Stage'), type: 'select', options: C.STAGES.map(([s, l]) => [s, t(l)]), value: k.stage, redraw: true },
      { name: 'lost_reason', label: t('Why lost'), type: 'text', value: k.lost_reason || '', show: v => (v.stage ?? k.stage) === 'lost' }], run: v => C.contactStage(k.id, v), done: after() });
  },
  crmActivity: (a) => openForm({ title: t('Note an exchange'), fields: [{ name: 'kind', label: t('What'), type: 'select', options: C.ACTIVITY_KINDS.map(([k, l]) => [k, t(l)]), value: 'call' },
    { name: 'happened_on', label: t('Date'), type: 'date', value: today() }, { name: 'note', label: t('Notes'), type: 'textarea' },
    { name: 'next_follow_up', label: t('Follow up on'), type: 'date', future: true }, { name: 'follow_up_note', label: t('To do then'), type: 'text' }],
  run: v => C.activityAdd(id(a.dataset.id), v), done: after() }),
  crmActDel: (a) => confirmAction({ title: t('Remove this entry?'), text: '', confirm: t('Remove'), run: () => C.activityDelete(id(a.dataset.id)), done: after() }),
  crmFollow: (a) => { const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Follow up with {n}', { n: k.name }), fields: [{ name: 'next_follow_up', label: t('On'), type: 'date', future: true, value: k.next_follow_up || addDays(today(), 7) },
    { name: 'follow_up_note', label: t('To do then'), type: 'text', value: k.follow_up_note || '' }], run: v => C.followUp(k.id, v), done: after() }); },
  crmFollowDone: async (a) => { try { toast(await change(() => C.followUp(id(a.dataset.id), { done: 1 }))); } catch (e) { toast(e.message); } },
  crmMakeCustomer: (a) => confirmAction({ title: t('First order?'), text: t('The contact becomes a customer and a new order opens for them.'), confirm: t('Open an order'), danger: false,
    run: () => C.makeCustomer(id(a.dataset.id)), done: cid => go(`customer/${cid}`) }),
  crmArchive: (a) => confirmAction({ title: t('Archive or bring back?'), text: t('An archived contact is hidden from the lists; its history is kept.'), confirm: t('Yes'), danger: false, run: () => C.contactArchive(id(a.dataset.id)), done: after() }),
  crmDelete: (a) => confirmAction({ title: t('Delete this contact?'), text: t('Its history goes too.'), confirm: t('Delete'), run: () => C.contactDelete(id(a.dataset.id)), done: after('crmcontacts') }),
  crmGroup: (a) => { UI.group = a.dataset.v; schedule(); },
  annWho: (a) => { const w = UI.ann.who; const i = w.indexOf(a.dataset.v); if (i >= 0) w.splice(i, 1); else w.push(a.dataset.v); schedule(); },
  annSent: (a) => { window.open(a.href, '_blank', 'noopener'); change(() => C.whatsappSent(id(a.dataset.id), { note: a.dataset.note })).catch(() => {}); },
  zoneNew: () => openForm({ title: t('New zone'), submit: t('Add'), fields: [{ name: 'name', label: t('Name'), type: 'text' }, { name: 'area', label: t('Area'), type: 'text', placeholder: 'Conakry, Basse-Guinée…' }], run: v => C.zoneNew(v), done: after() }),
  zoneEdit: (a) => { const z = one(`SELECT * FROM crm_zones WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Edit zone'), fields: [{ name: 'name', label: t('Name'), type: 'text', value: z.name }, { name: 'area', label: t('Area'), type: 'text', value: z.area || '' }], run: v => C.zoneEdit(z.id, v), done: after() }); },
  zoneToggle: async (a) => { try { toast(await change(() => C.zoneToggle(id(a.dataset.id)))); } catch (e) { toast(e.message); } },
  zoneDel: (a) => confirmAction({ title: t('Delete this zone?'), text: '', confirm: t('Delete'), run: () => C.zoneDelete(id(a.dataset.id)), done: after() }),
  pfNew: (a) => {
    const terms = (one(`SELECT value FROM app_settings WHERE key = 'proforma_terms'`) || {}).value || '';
    openForm({ title: t('New proforma'), submit: t('Create'), intro: esc(t('A priced offer for the customer to confirm or pay first. It doesn’t change stock, sales or the accounts.')),
      fields: [{ name: 'issued_on', label: t('Date'), type: 'date', value: today() }, { name: 'valid_until', label: t('Valid until'), type: 'date', future: true, value: addDays(today(), C.PROFORMA_VALID_DAYS) },
        { name: 'terms', label: t('Conditions'), type: 'textarea', value: terms, hint: t('Payment, delivery… remembered for the next one.') }],
      run: v => C.proformaCreate(id(a.dataset.id), v), done: after() });
  },
  pfVoid: (a) => confirmAction({ title: t('Cancel this proforma?'), text: t('Its number stays used.'), confirm: t('Cancel it'), run: () => C.proformaVoid(id(a.dataset.id)), done: after() })
});
// Filters of the contacts list and the announce form.
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.crmf) { UI[el.dataset.crmf] = el.value; schedule(); }
  if (el.dataset && el.dataset.ann) { UI.ann[el.dataset.ann] = el.value; schedule(); }
});
void Q;

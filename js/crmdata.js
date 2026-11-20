// What the CRM and proforma pages show (crm_home, crm_contacts, crm_contact, crm_customers,
// crm_announce, crm_report, crm_zones, proformas_list in the old app), computed the same way.
import { all, one, val } from './localdb.js';
import * as Q from './queries.js';
import { salesInPeriod } from './reports.js';
import { addDays, daysBetween, getSettings } from './buying.js';
import { pyRound } from './util.js';
import * as C from './ops/crm.js';

const today = () => new Date().toISOString().slice(0, 10);
const d10 = s => String(s ?? '').slice(0, 10);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Python's urllib.parse.quote (as the old app built WhatsApp links).
export const pyQuote = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%2F/g, '/');

function mixComposition(poId, label) {
  let rows = all(`SELECT p.name, SUM(pi.qty) as q FROM po_box_groups g JOIN po_items pi ON pi.po_box_group_id = g.id JOIN variants v ON v.id = pi.variant_id
                  JOIN products p ON p.id = v.product_id WHERE g.po_id IS ? AND g.label = ? GROUP BY p.name`, [poId, label]);
  if (!rows.length) rows = all(`SELECT p.name, SUM(bi.qty) as q FROM box_items bi JOIN variants v ON v.id = bi.variant_id JOIN products p ON p.id = v.product_id
                                WHERE bi.box_id = (SELECT id FROM boxes WHERE source_po_id IS ? AND source_label = ? LIMIT 1) GROUP BY p.name`, [poId, label]);
  return rows;
}
// _crm_insights — per customer: how often and how much they buy, what, how fast they pay, which group.
export function insights(T = today()) {
  const byOrder = new Map();
  salesInPeriod('1900-01-01', '9999-12-31 23:59:59', byOrder);
  const rets = new Map(all(`SELECT r.order_id, SUM(ri.refund_amount * COALESCE(o.fx_rate_to_usd, 1)) AS refund, SUM(CASE WHEN ri.restocked THEN COALESCE(ri.cost_usd, 0) ELSE 0 END) AS back
                            FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN orders o ON o.id = r.order_id GROUP BY r.order_id`).map(r => [r.order_id, [r.refund || 0, r.back || 0]]));
  const boxes = new Map(all(`SELECT order_id, SUM(qty_boxes) as n FROM order_box_lines GROUP BY order_id`).map(r => [r.order_id, r.n || 0]));
  const pairs = new Map(all(`SELECT order_id, SUM(qty) as n FROM order_items WHERE box_id IS NULL GROUP BY order_id`).map(r => [r.order_id, r.n || 0]));
  const yearAgo = addDays(T, -365);
  const out = new Map();
  for (const c of all(`SELECT * FROM customers ORDER BY id`)) {
    out.set(c.id, { customer_id: c.id, name: c.name, n: 0, first: null, last: null, days_since: null, interval: null, expected_next: null, due: false, sales_usd: 0, gp_usd: 0,
      gp_year: 0, boxes: 0, pairs: 0, avg_boxes: null, pay_days: null, styles: [], group: 'none' });
  }
  for (const o of all(`SELECT id, customer_id, fulfilled_at FROM orders WHERE status = 'fulfilled' AND customer_id IS NOT NULL AND fulfilled_at IS NOT NULL ORDER BY fulfilled_at, id`)) {
    const m = out.get(o.customer_id);
    if (!m) continue;
    const day = d10(o.fulfilled_at);
    const f = byOrder.get(o.id) || { revenue: 0, cost: 0 };
    const [refund, back] = rets.get(o.id) || [0, 0];
    const gp = (f.revenue - f.cost) - (refund - back);
    m.n += 1; m.first = m.first || day; m.last = day; m.sales_usd += f.revenue - refund; m.gp_usd += gp;
    if (day >= yearAgo) m.gp_year += gp;
    m.boxes += boxes.get(o.id) || 0; m.pairs += pairs.get(o.id) || 0;
  }
  const styles = new Map();
  const addStyle = (cid, name, q) => { if (!styles.has(cid)) styles.set(cid, new Map()); const s = styles.get(cid); s.set(name, (s.get(name) || 0) + q); };
  for (const r of all(`SELECT o.customer_id, bl.source_po_id, bl.source_label, SUM(bl.qty_boxes) AS q FROM order_box_lines bl JOIN orders o ON o.id = bl.order_id
                       WHERE o.status = 'fulfilled' AND o.customer_id IS NOT NULL GROUP BY o.customer_id, bl.source_po_id, bl.source_label`)) {
    for (const c of mixComposition(r.source_po_id, r.source_label)) addStyle(r.customer_id, c.name, c.q * r.q);
  }
  for (const r of all(`SELECT o.customer_id, p.name, SUM(oi.qty) AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN variants v ON v.id = oi.variant_id
                       JOIN products p ON p.id = v.product_id WHERE o.status = 'fulfilled' AND o.customer_id IS NOT NULL AND oi.box_id IS NULL GROUP BY o.customer_id, p.name`)) addStyle(r.customer_id, r.name, r.q);
  const pay = new Map();
  for (const i of all(`SELECT i.id, o.customer_id, i.issued_at, (SELECT MAX(ip.paid_at) FROM invoice_payments ip WHERE ip.invoice_id = i.id) AS last_paid
                       FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.status != 'void' AND o.customer_id IS NOT NULL ORDER BY i.id`)) {
    if (i.last_paid && Q.invoiceFinancials(i.id).status === 'paid') {
      if (!pay.has(i.customer_id)) pay.set(i.customer_id, []);
      pay.get(i.customer_id).push(Math.max(daysBetween(d10(i.last_paid), d10(i.issued_at)), 0));
    }
  }
  for (const [cid, m] of out) {
    if (m.n) {
      m.days_since = daysBetween(T, m.last);
      m.avg_boxes = m.boxes / m.n;
      if (m.n >= 2) {
        m.interval = daysBetween(m.last, m.first) / (m.n - 1);
        m.expected_next = addDays(m.last, pyRound(Math.max(m.interval, 1)));
      }
    }
    m.group = groupFor(m.n, m.days_since, m.interval);
    m.due = !!(m.expected_next && m.expected_next <= T && ['regular', 'at_risk'].includes(m.group));
    m.styles = [...(styles.get(cid) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    if (pay.get(cid)) m.pay_days = pay.get(cid).reduce((s, x) => s + x, 0) / pay.get(cid).length;
  }
  const regulars = [...out.values()].filter(m => m.group === 'regular' && m.gp_year > 0.004).sort((a, b) => b.gp_year - a.gp_year);
  for (const m of regulars.slice(0, Math.max(1, Math.ceil(regulars.length / 5)))) m.group = 'best';
  return out;
}
function groupFor(n, since, interval) {
  if (!n) return 'none';
  if (n === 1) return since <= 30 ? 'new' : since <= 90 ? 'at_risk' : 'lost';
  const usual = Math.max(interval || 0, 7);
  return since <= 1.5 * usual ? 'regular' : since <= 3 * usual ? 'at_risk' : 'lost';
}
const followUps = T => all(`SELECT k.*, z.name AS zone_name FROM crm_contacts k LEFT JOIN crm_zones z ON z.id = k.zone_id
                            WHERE k.archived = 0 AND k.next_follow_up IS NOT NULL AND k.next_follow_up <= ? ORDER BY k.next_follow_up, k.name`, [T]);
export const followUpsToday = () => followUps(today());
export function crmHome(T = today()) {
  const ins = insights(T);
  const follow = followUps(T).map(r => ({ ...r, wa: C.whatsappNumber(r.whatsapp, r.phone) }));
  const contacts = new Map(all(`SELECT * FROM crm_contacts WHERE customer_id IS NOT NULL ORDER BY id`).map(r => [r.customer_id, r]));
  const toCall = [];
  for (const m of ins.values()) {
    if (m.group === 'at_risk' || m.due) {
      const k = contacts.get(m.customer_id);
      toCall.push({ ...m, contact_id: k ? k.id : null, wa: k ? C.whatsappNumber(k.whatsapp, k.phone) : null });
    }
  }
  toCall.sort((a, b) => ((a.group === 'at_risk' ? 0 : 1) - (b.group === 'at_risk' ? 0 : 1)) || (b.gp_year - a.gp_year) || cmp(a.name, b.name));
  const stageCounts = Object.fromEntries(C.STAGES.map(([k]) => [k, 0]));
  for (const r of all(`SELECT stage, COUNT(*) AS n FROM crm_contacts WHERE archived = 0 GROUP BY stage`)) stageCounts[r.stage] = r.n;
  const groupCounts = Object.fromEntries(C.GROUPS.map(([k]) => [k, 0]));
  for (const m of ins.values()) groupCounts[m.group] += 1;
  const proformas = all(`SELECT p.* FROM proformas p JOIN orders o ON o.id = p.order_id WHERE p.status != 'void' AND o.status = 'open' AND p.valid_until <= ? AND p.valid_until >= ? ORDER BY p.valid_until`,
    [addDays(T, 3), addDays(T, -14)]).map(p => C.proformaView(p, T));
  const recent = all(`SELECT a.*, k.name AS contact_name FROM crm_activities a JOIN crm_contacts k ON k.id = a.contact_id ORDER BY a.happened_on DESC, a.id DESC LIMIT 10`);
  return { follow, to_call: toCall.slice(0, 25), to_call_total: toCall.length, stage_counts: stageCounts, group_counts: groupCounts, proformas, recent,
    prospects: C.PROSPECT_STAGES.reduce((s, k) => s + stageCounts[k], 0), today: T };
}
export function contactRows({ stage = '', kind = '', zone = '', show = 'active' } = {}) {
  const w = ['1=1'], p = [];
  if (stage) { w.push('k.stage = ?'); p.push(stage); }
  if (kind) { w.push('k.kind = ?'); p.push(kind); }
  if (zone) { w.push('k.zone_id = ?'); p.push(/^\d+$/.test(zone) ? Number(zone) : zone); }
  if (show === 'active') w.push('k.archived = 0'); else if (show === 'archived') w.push('k.archived = 1');
  return all(`SELECT k.*, z.name AS zone_name, z.area AS zone_area, (SELECT MAX(a.happened_on) FROM crm_activities a WHERE a.contact_id = k.id) AS last_activity,
                (SELECT COUNT(*) FROM crm_activities a WHERE a.contact_id = k.id) AS activities
              FROM crm_contacts k LEFT JOIN crm_zones z ON z.id = k.zone_id WHERE ${w.join(' AND ')} ORDER BY k.name COLLATE NOCASE`, p)
    .map(r => ({ ...r, wa: C.whatsappNumber(r.whatsapp, r.phone) }));
}
export function contactPage(id) {
  const k = one(`SELECT k.*, z.name AS zone_name FROM crm_contacts k LEFT JOIN crm_zones z ON z.id = k.zone_id WHERE k.id = ?`, [id]);
  if (!k) return null;
  const activities = all(`SELECT * FROM crm_activities WHERE contact_id = ? ORDER BY happened_on DESC, id DESC`, [id]);
  let customer = null, insight = null, credit = null, orders = [], proformas = [];
  if (k.customer_id !== null) {
    customer = one(`SELECT * FROM customers WHERE id = ?`, [k.customer_id]);
    insight = insights().get(k.customer_id) || null;
    credit = customer ? Q.creditStatus(customer) : null;
    orders = all(`SELECT o.id, o.status, o.created_at, o.fulfilled_at, o.currency_code, ${Q.ORDER_VALUE_SQL} AS order_total FROM orders o WHERE o.customer_id = ? ORDER BY o.created_at DESC LIMIT 10`, [k.customer_id]);
    proformas = all(`SELECT p.* FROM proformas p JOIN orders o ON o.id = p.order_id WHERE o.customer_id = ? ORDER BY p.id DESC LIMIT 10`, [k.customer_id]).map(p => C.proformaView(p));
  }
  return { k, activities, customer, insight, credit, orders, proformas, wa: C.whatsappNumber(k.whatsapp, k.phone) };
}
export function crmCustomers(group = '', T = today()) {
  const ins = insights(T);
  const contacts = new Map(all(`SELECT * FROM crm_contacts WHERE customer_id IS NOT NULL ORDER BY id`).map(r => [r.customer_id, r]));
  const rows = [];
  for (const m of ins.values()) {
    if (group && m.group !== group) continue;
    const c = one(`SELECT * FROM customers WHERE id = ?`, [m.customer_id]);
    const s = Q.customerSummary(m.customer_id);
    const k = contacts.get(m.customer_id);
    rows.push({ ...m, contact_id: k ? k.id : null, exposure_usd: Q.customerExposureUsd(m.customer_id, s), credit: Q.creditStatus(c, 0, s), wa: k ? C.whatsappNumber(k.whatsapp, k.phone) : null });
  }
  const order = Object.fromEntries(C.GROUPS.map(([g], i) => [g, i]));
  rows.sort((a, b) => (order[a.group] - order[b.group]) || (b.gp_year - a.gp_year) || cmp(a.name, b.name));
  const counts = Object.fromEntries(C.GROUPS.map(([g]) => [g, 0]));
  for (const m of ins.values()) counts[m.group] += 1;
  return { rows, group, counts, today: T };
}
export const ANNOUNCE_DEFAULT = 'Bonjour {nom}, nouvel arrivage : {modele}. Les boîtes sont disponibles dès maintenant. Répondez à ce message ou passez nous voir pour réserver.';
export function announce({ product_id = null, who = ['bought', 'asked'], kind = '', zone = '', msg = ANNOUNCE_DEFAULT } = {}) {
  const product = product_id !== null && product_id !== '' ? one(`SELECT * FROM products WHERE id = ?`, [product_id]) : null;
  const people = new Map();
  const add = (k, why, last = null) => {
    if (!k || k.archived) return;
    if (kind && k.kind !== kind) return;
    if (zone && String(k.zone_id ?? '') !== zone) return;
    if (!people.has(k.id)) people.set(k.id, { k, why: [], last: null });
    const p = people.get(k.id);
    if (!p.why.includes(why)) p.why.push(why);
    if (last && (p.last === null || last > p.last)) p.last = last;
  };
  const contactOf = new Map(all(`SELECT * FROM crm_contacts WHERE customer_id IS NOT NULL ORDER BY id`).map(r => [r.customer_id, r]));
  if (product && who.includes('bought')) {
    for (const r of all(`SELECT o.customer_id, MAX(o.fulfilled_at) AS last FROM orders o WHERE o.status = 'fulfilled' AND o.customer_id IS NOT NULL AND (
                           EXISTS (SELECT 1 FROM order_items oi JOIN variants v ON v.id = oi.variant_id WHERE oi.order_id = o.id AND v.product_id = ?)
                           OR EXISTS (SELECT 1 FROM order_box_lines bl JOIN boxes b ON b.source_po_id IS bl.source_po_id AND b.source_label = bl.source_label
                                      JOIN box_items bi ON bi.box_id = b.id JOIN variants v ON v.id = bi.variant_id WHERE bl.order_id = o.id AND v.product_id = ?))
                         GROUP BY o.customer_id`, [product.id, product.id])) add(contactOf.get(r.customer_id), 'bought it', d10(r.last));
  }
  if (product && who.includes('asked')) {
    for (const r of all(`SELECT customer_id, model_key FROM missed_sales WHERE customer_id IS NOT NULL AND model_key IS NOT NULL ORDER BY id`)) {
      const pids = new Set(String(r.model_key).split('#')[0].split('|').map(part => part.split(':')[0]));
      if (pids.has(String(product.id))) add(contactOf.get(r.customer_id), 'asked for it');
    }
  }
  if (who.includes('customers')) {
    for (const r of all(`SELECT o.customer_id, MAX(o.fulfilled_at) AS last FROM orders o WHERE o.status = 'fulfilled' AND o.customer_id IS NOT NULL GROUP BY o.customer_id`)) add(contactOf.get(r.customer_id), 'customer', d10(r.last));
  }
  if (who.includes('prospects')) for (const k of all(`SELECT * FROM crm_contacts WHERE stage IN ('to_contact', 'contacted', 'samples', 'proforma') ORDER BY id`)) add(k, 'prospect');
  const zones = new Map(all(`SELECT id, name FROM crm_zones`).map(z => [z.id, z.name]));
  const style = product ? product.name : '';
  const rows = [...people.values()].map(p => {
    const k = p.k, number = C.whatsappNumber(k.whatsapp, k.phone);
    const text = msg.split('{nom}').join(k.name).split('{modele}').join(style).split('{modèle}').join(style);
    return { id: k.id, name: k.name, kind: k.kind, zone: zones.get(k.zone_id) ?? null, stage: k.stage, why: p.why, last: p.last, number,
      link: number ? `https://wa.me/${number}` + (text ? `?text=${pyQuote(text)}` : '') : null };
  });
  rows.sort((a, b) => ((a.number === null) - (b.number === null)) || ((a.last === null) - (b.last === null)) || (a.last !== null && b.last !== null ? cmp(b.last, a.last) : 0) || cmp(a.name, b.name));
  return { product, who, kind, zone, msg, rows, log_note: style ? `Annonce : ${style}` : 'Annonce' };
}
export function crmReport(T = today()) {
  const contacts = all(`SELECT k.*, z.name AS zone_name, z.area AS zone_area, z.sort_order FROM crm_contacts k LEFT JOIN crm_zones z ON z.id = k.zone_id WHERE k.archived = 0 ORDER BY k.id`);
  const stages = C.STAGES.map(([s]) => s);
  const funnel = Object.fromEntries(stages.map(s => [s, 0]));
  const byZone = new Map(), byKind = {};
  let potential = 0;
  for (const k of contacts) {
    funnel[k.stage] += 1;
    const zk = JSON.stringify([k.zone_name ? k.sort_order : 1e9, k.zone_name || '—']);
    if (!byZone.has(zk)) byZone.set(zk, { key: [k.zone_name ? k.sort_order : 1e9, k.zone_name || '—'], name: k.zone_name, area: k.zone_area, stages: Object.fromEntries(stages.map(s => [s, 0])), total: 0, potential: 0 });
    const z = byZone.get(zk);
    z.stages[k.stage] += 1; z.total += 1;
    if (!byKind[k.kind]) byKind[k.kind] = { total: 0, customers: 0, potential: 0 };
    const kd = byKind[k.kind];
    kd.total += 1;
    if (['first_order', 'regular'].includes(k.stage)) kd.customers += 1;
    if (k.stage !== 'lost' && k.potential_boxes) { potential += k.potential_boxes; z.potential += k.potential_boxes; kd.potential += k.potential_boxes; }
  }
  const waits = [];
  for (const r of all(`SELECT k.created_at, MIN(o.fulfilled_at) AS first_sale FROM crm_contacts k JOIN orders o ON o.customer_id = k.customer_id AND o.status = 'fulfilled' GROUP BY k.id`)) {
    if (r.first_sale && d10(r.created_at) < d10(r.first_sale)) waits.push(daysBetween(d10(r.first_sale), d10(r.created_at)));
  }
  const monthAgo = addDays(T, -30);
  const acts = Object.fromEntries(C.ACTIVITY_KINDS.map(([k]) => [k, 0]));
  for (const r of all(`SELECT kind, COUNT(*) AS n FROM crm_activities WHERE happened_on >= ? GROUP BY kind`, [monthAgo])) acts[r.kind] = (acts[r.kind] || 0) + r.n;
  const zoneRows = [...byZone.values()].sort((a, b) => (a.key[0] - b.key[0]) || cmp(a.key[1], b.key[1])).map(({ key, ...z }) => z);
  return { funnel, by_zone: zoneRows, by_kind: byKind, potential, reached: contacts.filter(k => k.stage !== 'to_contact').length,
    won: contacts.filter(k => ['first_order', 'regular'].includes(k.stage)).length, total: contacts.length, avg_wait: waits.length ? waits.reduce((s, x) => s + x, 0) / waits.length : null,
    sold_30: val(`SELECT COALESCE(SUM(bl.qty_boxes), 0) FROM order_box_lines bl JOIN orders o ON o.id = bl.order_id WHERE o.status = 'fulfilled' AND o.fulfilled_at >= ?`, [monthAgo]) || 0,
    goal: Math.trunc(getSettings().buy_container_boxes), acts, stages };
}
export function zonesPage() {
  const zones = all(`SELECT z.*, (SELECT COUNT(*) FROM crm_contacts k WHERE k.zone_id = z.id) AS used FROM crm_zones z ORDER BY z.sort_order, z.name`);
  const areas = [];
  for (const z of zones) {
    if (!areas.length || areas[areas.length - 1].area !== (z.area || '')) areas.push({ area: z.area || '', zones: [] });
    areas[areas.length - 1].zones.push(z);
  }
  return { areas, area_names: [...new Set(zones.filter(z => z.area).map(z => z.area))].sort(cmp) };
}
export const proformasPage = (T = today()) => ({ proformas: all(`SELECT * FROM proformas ORDER BY issued_on DESC, id DESC`).map(p => C.proformaView(p, T)) });

// CRM (crm.py and the /crm handlers) and proformas: the old app's rules and SQL. The CRM
// writes only its own tables (and a customer when a prospect places a first order); a
// proforma is a document only — nothing here touches stock, sales or accounts.
import { all, one, val, run, ins } from '../localdb.js';
import { t } from '../i18n.js';
import { fmtMoney } from '../util.js';
import { refuse, today, asId } from './common.js';
import { documentLines } from '../queries.js';
import { addDays } from '../buying.js';

export const KINDS = [['wholesaler', 'Wholesaler'], ['semi_wholesaler', 'Semi-wholesaler'], ['retailer', 'Retailer (shop)'], ['market_stall', 'Market stall'],
  ['importer', 'Importer'], ['intermediary', 'Intermediary'], ['online', 'Online platform'], ['other', 'Other']];
export const STAGES = [['to_contact', 'To contact'], ['contacted', 'Contacted'], ['samples', 'Samples shown'], ['proforma', 'Proforma sent'],
  ['first_order', 'First order'], ['regular', 'Regular customer'], ['lost', 'Lost']];
export const PROSPECT_STAGES = ['to_contact', 'contacted', 'samples', 'proforma'];
export const ACTIVITY_KINDS = [['call', 'Call'], ['visit', 'Visit'], ['whatsapp', 'WhatsApp'], ['samples', 'Samples left'], ['meeting', 'Meeting'], ['note', 'Note']];
export const GROUPS = [['best', 'Best customers'], ['regular', 'Regulars'], ['new', 'New'], ['at_risk', 'At risk'], ['lost', 'Lost'], ['none', 'No purchase yet']];
export const GROUP_TAG = { best: 'Best customer', regular: 'Regular', new: 'New', at_risk: 'At risk', lost: 'Lost', none: 'No purchase yet' };
const label = (list, k) => (list.find(x => x[0] === k) || [k, k])[1];
export const DEFAULT_ZONES = [
  ['Conakry', ['Marché Madina', 'Marché Niger', 'Marché de Taouyah', 'Marché de Matoto', 'Marché de Bonfi', "Marché d'Enta", 'Marché de Sonfonia', 'Marché de Cosa', 'Marché de Lambanyi',
    'Marché de Koloma', "Marché d'Hamdallaye", 'Marché de Bambeto', 'Marché de Kaporo', 'Marché de Dabompa', 'Marché de Yimbaya', 'Marché de Gbessia', 'Marché de Kagbelen',
    'Kaloum', 'Dixinn', 'Matam', 'Ratoma', 'Matoto', 'Conakry — autre quartier']],
  ['Basse-Guinée', ['Coyah', 'Dubréka', 'Forécariah', 'Kindia', 'Télimélé', 'Boké', 'Kamsar', 'Boffa', 'Fria', 'Gaoual', 'Koundara']],
  ['Moyenne-Guinée', ['Mamou', 'Labé', 'Pita', 'Dalaba', 'Lélouma', 'Mali', 'Tougué', 'Koubia']],
  ['Haute-Guinée', ['Kankan', 'Siguiri', 'Kouroussa', 'Kérouané', 'Mandiana', 'Faranah', 'Dabola', 'Dinguiraye']],
  ['Guinée forestière', ["N'Zérékoré", 'Kissidougou', 'Guéckédou', 'Macenta', 'Beyla', 'Lola', 'Yomou']],
  ['Étranger', ['Bamako (Mali)', 'Freetown (Sierra Leone)', 'Monrovia (Libéria)', 'Dakar (Sénégal)', 'Bissau (Guinée-Bissau)', "Abidjan (Côte d'Ivoire)"]],
  ['Autre', ['En ligne', 'Autre']]
];

// ---------- keeping the CRM in step (_crm_ready) ----------
export function seedZones() {
  if (val(`SELECT 1 FROM app_settings WHERE key = 'crm_zones_seeded'`)) return;
  let order = 0;
  for (const [area, names] of DEFAULT_ZONES) for (const name of names) {
    order += 10;
    if (!val(`SELECT 1 FROM crm_zones WHERE name = ?`, [name])) ins('crm_zones', { name, area, sort_order: order });
  }
  run(`DELETE FROM app_settings WHERE key = 'crm_zones_seeded'`);
  ins('app_settings', { key: 'crm_zones_seeded', value: '1' });
}
export function syncCustomers() {
  for (const c of all(`SELECT c.* FROM customers c WHERE NOT EXISTS (SELECT 1 FROM crm_contacts k WHERE k.customer_id = c.id) ORDER BY c.id`)) {
    ins('crm_contacts', { name: c.name, kind: 'other', phone: c.phone, email: c.email, address: c.address, stage: 'to_contact', customer_id: c.id, created_at: c.created_at, stage_changed_at: c.created_at });
  }
  for (const r of all(`SELECT k.id, c.name, c.phone, c.email, c.address FROM crm_contacts k JOIN customers c ON c.id = k.customer_id
                       WHERE k.name IS NOT c.name OR k.phone IS NOT c.phone OR k.email IS NOT c.email OR k.address IS NOT c.address ORDER BY k.id`)) {
    run(`UPDATE crm_contacts SET name = ?, phone = ?, email = ?, address = ? WHERE id = ?`, [r.name, r.phone, r.email, r.address, r.id]);
  }
  for (const r of all(`SELECT k.id, k.stage, k.customer_id,
                         (SELECT COUNT(*) FROM orders o WHERE o.customer_id = k.customer_id AND o.status = 'fulfilled') AS n,
                         (SELECT COUNT(*) FROM proformas p JOIN orders o2 ON o2.id = p.order_id WHERE o2.customer_id = k.customer_id AND p.status != 'void') AS pf
                       FROM crm_contacts k WHERE k.customer_id IS NOT NULL ORDER BY k.id`)) {
    let nw = r.stage;
    if (r.n >= 2 && r.stage !== 'regular') nw = 'regular';
    else if (r.n === 1 && (PROSPECT_STAGES.includes(r.stage) || r.stage === 'lost')) nw = 'first_order';
    else if (r.n === 0 && r.pf && ['to_contact', 'contacted', 'samples'].includes(r.stage)) nw = 'proforma';
    if (nw !== r.stage) run(`UPDATE crm_contacts SET stage = ?, stage_changed_at = datetime('now') WHERE id = ?`, [nw, r.id]);
  }
}
// Whether anything needs doing — so opening a CRM page only writes when it has to.
export function crmNeedsSync() {
  if (!val(`SELECT 1 FROM app_settings WHERE key = 'crm_zones_seeded'`)) return true;
  if (val(`SELECT 1 FROM customers c WHERE NOT EXISTS (SELECT 1 FROM crm_contacts k WHERE k.customer_id = c.id) LIMIT 1`)) return true;
  if (val(`SELECT 1 FROM crm_contacts k JOIN customers c ON c.id = k.customer_id WHERE k.name IS NOT c.name OR k.phone IS NOT c.phone OR k.email IS NOT c.email OR k.address IS NOT c.address LIMIT 1`)) return true;
  return all(`SELECT k.stage, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = k.customer_id AND o.status = 'fulfilled') AS n,
                (SELECT COUNT(*) FROM proformas p JOIN orders o2 ON o2.id = p.order_id WHERE o2.customer_id = k.customer_id AND p.status != 'void') AS pf
              FROM crm_contacts k WHERE k.customer_id IS NOT NULL`).some(r => (r.n >= 2 && r.stage !== 'regular') || (r.n === 1 && (PROSPECT_STAGES.includes(r.stage) || r.stage === 'lost'))
    || (r.n === 0 && r.pf && ['to_contact', 'contacted', 'samples'].includes(r.stage)));
}
export function crmReady() { seedZones(); syncCustomers(); }

export function whatsappNumber(...numbers) {
  for (const raw of numbers) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 9 && d.startsWith('6')) d = '224' + d;
    if (d.length >= 8) return d;
  }
  return null;
}

// ---------- contacts ----------
function contactValues(f) {
  const n = v => { const s = String(v ?? '').replace(/,/g, '').trim(); if (!s) return null; const x = Number(s); return Number.isFinite(x) ? Math.trunc(x) : null; };
  const s = v => String(v || '').trim() || null;
  return { name: String(f.name || '').trim(), kind: KINDS.some(k => k[0] === f.kind) ? f.kind : 'other', zone_id: asId(/^\w+$/.test(String(f.zone_id || '')) ? f.zone_id : null),
    phone: s(f.phone), whatsapp: s(f.whatsapp), email: s(f.email), address: s(f.address), sells: s(f.sells), potential_boxes: n(f.potential_boxes),
    suppliers: s(f.suppliers), source: s(f.source), notes: s(f.notes) };
}
export function contactNew(f) {
  const v = contactValues(f);
  if (!v.name) refuse('Give the contact a name. Nothing was added.');
  const stage = PROSPECT_STAGES.includes(f.stage) ? f.stage : 'to_contact';
  return ins('crm_contacts', { ...v, stage, stage_changed_at: val(`SELECT datetime('now')`) });
}
export function contactEdit(id, f) {
  const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id]);
  if (!k) refuse('That contact no longer exists.');
  const v = contactValues(f);
  if (k.customer_id !== null) Object.assign(v, { name: k.name, phone: k.phone, email: k.email, address: k.address });
  if (!v.name) refuse('Give the contact a name. Nothing was changed.');
  run(`UPDATE crm_contacts SET name = ?, kind = ?, zone_id = ?, phone = ?, whatsapp = ?, email = ?, address = ?, sells = ?, potential_boxes = ?, suppliers = ?, source = ?, notes = ? WHERE id = ?`,
    [v.name, v.kind, v.zone_id, v.phone, v.whatsapp, v.email, v.address, v.sells, v.potential_boxes, v.suppliers, v.source, v.notes, id]);
  return t('Contact updated.');
}
export function contactStage(id, { stage, lost_reason }) {
  if (!one(`SELECT 1 FROM crm_contacts WHERE id = ?`, [id])) refuse('That contact no longer exists.');
  if (!STAGES.some(s => s[0] === stage)) refuse('Unknown stage. Nothing was changed.');
  const reason = String(lost_reason || '').trim() || null;
  run(`UPDATE crm_contacts SET stage = ?, lost_reason = ?, stage_changed_at = datetime('now') WHERE id = ?`, [stage, stage === 'lost' ? reason : null, id]);
  return t('Stage set to “{s}”.', { s: t(label(STAGES, stage)) });
}
const formDayOrRefuse = (raw, suffix) => {
  const r = String(raw || '').trim();
  if (!r) return today();
  const d = r.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) refuse('Date: That date isn’t valid. {s}', { s: t(suffix) });
  if (d > today()) refuse('Date: That date is in the future. {s}', { s: t(suffix) });
  return d;
};
const futureDay = (raw) => {
  const r = String(raw || '').trim();
  if (!r) return null;
  const d = r.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) return undefined;
  return d;
};
export function activityAdd(id, f) {
  const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id]);
  if (!k) refuse('That contact no longer exists.');
  const kind = ACTIVITY_KINDS.some(a => a[0] === f.kind) ? f.kind : 'note';
  const day = formDayOrRefuse(f.happened_on, 'Nothing was recorded.');
  const follow = futureDay(f.next_follow_up);
  if (follow === undefined) refuse('That follow-up date isn’t valid. Nothing was recorded.');
  ins('crm_activities', { contact_id: id, kind, happened_on: day, note: String(f.note || '').trim() || null });
  let msg = t('{k} recorded.', { k: t(label(ACTIVITY_KINDS, kind)) });
  let ns = null;
  if (kind === 'samples' && ['to_contact', 'contacted'].includes(k.stage)) ns = 'samples';
  else if (['call', 'visit', 'whatsapp', 'meeting'].includes(kind) && k.stage === 'to_contact') ns = 'contacted';
  if (ns) { run(`UPDATE crm_contacts SET stage = ?, stage_changed_at = datetime('now') WHERE id = ?`, [ns, id]); msg += ' ' + t('Stage moved to “{s}”.', { s: t(label(STAGES, ns)) }); }
  if (follow) { run(`UPDATE crm_contacts SET next_follow_up = ?, follow_up_note = ? WHERE id = ?`, [follow, String(f.follow_up_note || '').trim() || null, id]); msg += ' ' + t('Follow up on {d}.', { d: follow }); }
  else if (f.clear_follow_up) run(`UPDATE crm_contacts SET next_follow_up = NULL, follow_up_note = NULL WHERE id = ?`, [id]);
  return msg;
}
export function activityDelete(aid) {
  if (!one(`SELECT 1 FROM crm_activities WHERE id = ?`, [aid])) refuse('That entry no longer exists.');
  run(`DELETE FROM crm_activities WHERE id = ?`, [aid]);
  return t('Entry removed.');
}
export function followUp(id, f) {
  const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id]);
  if (!k) refuse('That contact no longer exists.');
  if (f.done) { run(`UPDATE crm_contacts SET next_follow_up = NULL, follow_up_note = NULL WHERE id = ?`, [id]); return t('Follow-up with {n} done.', { n: k.name }); }
  const follow = futureDay(f.next_follow_up);
  if (follow === undefined) refuse('That follow-up date isn’t valid. Nothing was changed.');
  run(`UPDATE crm_contacts SET next_follow_up = ?, follow_up_note = ? WHERE id = ?`, [follow, String(f.follow_up_note || '').trim() || null, id]);
  return follow ? t('Follow-up with {n} set for {d}.', { n: k.name, d: follow }) : t('Follow-up with {n} removed.', { n: k.name });
}
export function whatsappSent(id, { note }) {
  const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id]);
  if (!k) refuse('That contact no longer exists.');
  ins('crm_activities', { contact_id: id, kind: 'whatsapp', happened_on: today(), note: String(note || '').trim().slice(0, 300) || null });
  if (k.stage === 'to_contact') run(`UPDATE crm_contacts SET stage = 'contacted', stage_changed_at = datetime('now') WHERE id = ?`, [id]);
  return null;
}
export function makeCustomer(id) {
  const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id]);
  if (!k) refuse('That contact no longer exists.');
  if (k.customer_id !== null) return k.customer_id;
  const cid = ins('customers', { name: k.name, email: k.email, phone: k.phone || k.whatsapp, address: k.address });
  run(`UPDATE crm_contacts SET customer_id = ? WHERE id = ?`, [cid, id]);
  return cid;
}
export function contactArchive(id) {
  const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id]);
  if (!k) refuse('That contact no longer exists.');
  run(`UPDATE crm_contacts SET archived = ? WHERE id = ?`, [k.archived ? 0 : 1, id]);
  return k.archived ? t('{n} brought back.', { n: k.name }) : t('{n} archived — hidden from the lists, history kept.', { n: k.name });
}
export function contactDelete(id) {
  const k = one(`SELECT * FROM crm_contacts WHERE id = ?`, [id]);
  if (!k) refuse('That contact no longer exists.');
  if (k.customer_id !== null) refuse('This contact is a customer — archive it instead. Nothing was deleted.');
  run(`DELETE FROM crm_activities WHERE contact_id = ?`, [id]);
  run(`DELETE FROM crm_contacts WHERE id = ?`, [id]);
  return t('Contact “{n}” deleted.', { n: k.name });
}

// ---------- zones ----------
const sameName = (name, notId = null) => all(`SELECT id, name FROM crm_zones`).some(z => z.name.toLowerCase() === name.toLowerCase() && (notId === null || z.id !== notId));
export function zoneNew({ name, area }) {
  const n = String(name || '').trim(), a = String(area || '').trim() || null;
  if (!n) refuse('Give the zone a name. Nothing was added.');
  if (sameName(n)) refuse('There’s already a zone called “{n}”. Nothing was added.', { n });
  let last = val(`SELECT MAX(sort_order) FROM crm_zones WHERE area IS ?`, [a]);
  if (last === null) last = (val(`SELECT COALESCE(MAX(sort_order), 0) FROM crm_zones`) || 0) + 100;
  run(`UPDATE crm_zones SET sort_order = sort_order + 1 WHERE sort_order > ?`, [last]);
  ins('crm_zones', { name: n, area: a, sort_order: last + 1 });
  return t('Zone “{n}” added.', { n });
}
export function zoneEdit(id, { name, area }) {
  if (!one(`SELECT 1 FROM crm_zones WHERE id = ?`, [id])) refuse('That zone no longer exists.');
  const n = String(name || '').trim(), a = String(area || '').trim() || null;
  if (!n) refuse('Give the zone a name. Nothing was changed.');
  if (sameName(n, id)) refuse('There’s already a zone called “{n}”. Nothing was changed.', { n });
  run(`UPDATE crm_zones SET name = ?, area = ? WHERE id = ?`, [n, a, id]);
  return t('Zone “{n}” saved.', { n });
}
export function zoneToggle(id) {
  const z = one(`SELECT * FROM crm_zones WHERE id = ?`, [id]);
  if (!z) refuse('That zone no longer exists.');
  run(`UPDATE crm_zones SET active = ? WHERE id = ?`, [z.active ? 0 : 1, id]);
  return z.active ? t('Zone “{n}” hidden from the lists.', { n: z.name }) : t('Zone “{n}” shown in the lists again.', { n: z.name });
}
export function zoneDelete(id) {
  const z = one(`SELECT * FROM crm_zones WHERE id = ?`, [id]);
  if (!z) refuse('That zone no longer exists.');
  const used = val(`SELECT COUNT(*) FROM crm_contacts WHERE zone_id = ?`, [id]);
  if (used) refuse('“{n}” has {u} contact(s) — hide it instead, or move them first. Nothing was deleted.', { n: z.name, u: used });
  run(`DELETE FROM crm_zones WHERE id = ?`, [id]);
  return t('Zone “{n}” deleted.', { n: z.name });
}

// ---------- proformas ----------
export const PROFORMA_VALID_DAYS = 15;
function nextProformaNumber(year) {
  const prefix = `PF-${year}-`;
  let n = (val(`SELECT MAX(CAST(SUBSTR(number, ?) AS INTEGER)) FROM proformas WHERE number LIKE ?`, [prefix.length + 1, prefix + '%']) || 0) + 1;
  while (val(`SELECT 1 FROM proformas WHERE number = ?`, [`${prefix}${String(n).padStart(4, '0')}`])) n++;
  return `${prefix}${String(n).padStart(4, '0')}`;
}
export function proformaLinesNow(orderId) {
  const [boxLines, items] = documentLines(orderId);
  return [...boxLines.map(b => ({ kind: 'box', po_id: b.source_po_id, label: b.source_label, description: b.styles, detail: b.size_run, pairs_per_box: b.pairs_per_box,
    qty: b.qty_boxes, price_per_pair: b.price_per_pair, unit_price: b.price_per_box, amount: b.qty_boxes * b.price_per_box })),
  ...items.map(i => ({ kind: 'pair', variant_id: i.variant_id, sku: i.sku, description: `${i.product_name}${i.color ? ' ' + i.color : ''}`, size: i.size, qty: i.qty,
    unit_price: i.unit_price, amount: i.qty * i.unit_price }))];
}
const pyStr = v => (v === null || v === undefined ? 'None' : String(v));
const signature = lines => lines.map(l => [l.kind, pyStr(l.po_id), pyStr(l.label), pyStr(l.variant_id), Math.trunc(Number(l.qty)), Math.round(Number(l.unit_price) * 1e4) / 1e4])
  .map(x => JSON.stringify(x)).sort().join('|');
export function proformaView(pf, T = today()) {
  const d = { ...pf, lines: JSON.parse(pf.lines_json || '[]'), customer: JSON.parse(pf.customer_json || '{}') };
  const order = pf.order_id !== null ? one(`SELECT id, status FROM orders WHERE id = ?`, [pf.order_id]) : null;
  d.state = pf.status === 'void' || !order || order.status === 'cancelled' ? 'cancelled' : order.status === 'fulfilled' ? 'delivered' : pf.valid_until < T ? 'expired' : 'valid';
  d.changed = !!(order && order.status === 'open' && pf.status !== 'void' && signature(d.lines) !== signature(proformaLinesNow(order.id)));
  d.box_lines = d.lines.filter(l => l.kind === 'box');
  d.pair_lines = d.lines.filter(l => l.kind === 'pair');
  return d;
}
export function proformaCreate(orderId, { issued_on, valid_until, terms }) {
  const o = one(`SELECT o.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone, c.address as customer_address
                 FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [orderId]);
  if (!o) refuse('That order no longer exists.');
  if (o.status !== 'open') refuse(o.status === 'fulfilled' ? 'A proforma is for an order not yet delivered — this one is delivered (use its invoice). No proforma was created.'
    : 'A proforma is for an order not yet delivered — this one is cancelled. No proforma was created.');
  const lines = proformaLinesNow(orderId);
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (!lines.length) refuse('Add boxes or pairs to the order first. No proforma was created.');
  if (total <= 0.004) refuse('This order is worth 0 — set a price on its lines first. No proforma was created.');
  const issued = formDayOrRefuse(issued_on, 'No proforma was created.');
  const raw = String(valid_until || '').trim();
  let until;
  if (raw) {
    until = raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until + 'T00:00:00Z'))) refuse('“Valid until” isn’t a valid date. No proforma was created.');
  } else until = addDays(issued, PROFORMA_VALID_DAYS);
  if (until < issued) refuse('“Valid until” is before the proforma’s date. No proforma was created.');
  const tr = String(terms || '').trim();
  const number = nextProformaNumber(issued.slice(0, 4));
  ins('proformas', { order_id: orderId, number, issued_on: issued, valid_until: until, currency_code: o.currency_code, total, lines_json: JSON.stringify(lines),
    customer_json: JSON.stringify({ name: o.customer_name, email: o.customer_email, phone: o.customer_phone, address: o.customer_address }), terms: tr || null });
  run(`DELETE FROM app_settings WHERE key = 'proforma_terms'`);
  ins('app_settings', { key: 'proforma_terms', value: tr });
  return t('Proforma {n} created: {a}, valid until {d}. Print it to send to the customer — it doesn’t change stock, sales or the accounts.', { n: number, a: fmtMoney(total, o.currency_code), d: until });
}
export function proformaVoid(id) {
  const pf = one(`SELECT * FROM proformas WHERE id = ?`, [id]);
  if (!pf) refuse('That proforma no longer exists.');
  run(`UPDATE proformas SET status = 'void' WHERE id = ?`, [id]);
  return t('Proforma {n} cancelled. Its number stays used, so it’s never given to another one.', { n: pf.number });
}

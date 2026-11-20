// Purchasing screens and their forms: purchase orders (mixes, size runs, landed costs,
// receiving, supplier payments, documents), suppliers, shipments, locations, size runs and
// the price list. Each form calls one operation from ops/purchasing.js.
import { all, one, val } from './localdb.js';
import * as Q from './queries.js';
import * as PO from './ops/purchasing.js';
import { asId } from './ops/common.js';
import { t, plural } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtNum, fmtQty, fmtDate, fmtShort, today, sum, pyRound } from './util.js';
import { header, tile, tiles, panel, pill, empty, table } from './ui.js';
import { openForm, confirmAction } from './forms.js';
import { registerActions } from './actions.js';
import { go, schedule } from './app.js';
import { putBlob, getBlob } from './store.js';

const id = v => asId(v);
const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));
const after = target => (msg) => { if (typeof msg === 'string') toast(msg); if (target) go(typeof target === 'function' ? target() : target); else schedule(); };
export const poNo = pid => `#${Q.poRef(pid)}`;
const curOpts = () => all(`SELECT code, name FROM currencies ORDER BY is_base DESC, code`).map(c => [c.code, `${c.code} — ${c.name}`]);
const supOpts = () => [['', t('No supplier')], ...all(`SELECT id, name FROM suppliers ORDER BY name`).map(s => [s.id, s.name])];
const locRows = () => all(`SELECT id, name, kind FROM locations WHERE archived = 0 ORDER BY parent_id IS NOT NULL, name`);
const locOpts = () => locRows().map(l => [l.id, l.name + (l.kind === 'consignment' ? ` (${t('consignment')})` : '')]);
const prodOpts = () => all(`SELECT id, name, sku_prefix FROM products ORDER BY name`).map(p => [p.id, `${p.name} (${p.sku_prefix})`]);
const variantOpts = () => all(`SELECT v.id, p.name, v.color, v.size FROM variants v JOIN products p ON p.id = v.product_id ORDER BY p.name, v.color, v.size`)
  .map(v => [v.id, [v.name, v.color, v.size].filter(Boolean).join(' · ')]);
const big = (v, cur) => esc(Math.abs(v) >= 100000 ? fmtShort(v, cur) : fmtMoney(v, cur));
const DOC_TYPES = ['Supplier invoice', 'Packing list', 'Customs — China', 'Customs — Guinea', 'Bill of lading', 'Other'];
const FILE_MAX = 700 * 1024;

export function subnav(cur) {
  const items = [['purchasing', t('Purchase orders')], ['shipments', t('Shipments')], ['suppliers', t('Suppliers')], ['locations', t('Locations')],
    ['sizeruns', t('Size runs')], ['pricelist', t('Price list')], ['buying', t('Buying plan')]];
  return `<nav class="subnav">${items.map(([k, l]) => `<a href="#/${k}"${cur === k ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;
}
function poStatus(pid) {
  const r = one(`SELECT COUNT(*) as total, COUNT(CASE WHEN received_at IS NOT NULL THEN 1 END) as received FROM po_box_groups WHERE po_id = ?`, [pid]);
  return r.total && r.received === r.total ? 'received' : r.received ? 'partial' : 'draft';
}
const poPill = s => pill(t(s === 'received' ? 'Received' : s === 'partial' ? 'Partly received' : 'Not received'), { received: 'good', partial: 'warn', draft: '' }[s]);
const nextMixName = pid => {
  const used = new Set(all(`SELECT label FROM po_box_groups WHERE po_id = ?`, [pid]).map(r => r.label));
  let n = 1;
  while (used.has(`${t('Box')} ${n}`)) n++;
  return `${t('Box')} ${n}`;
};

// ---------- purchase orders ----------
function purchasing() {
  const rows = all(`SELECT po.id, po.created_at, po.currency_code, s.name as supplier_name,
                           COALESCE(SUM(pi.qty * pi.unit_cost * bg.box_count), 0) as goods_total,
                           COUNT(DISTINCT bg.id) as group_count,
                           COUNT(DISTINCT CASE WHEN bg.received_at IS NOT NULL THEN bg.id END) as received_group_count
                    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
                    LEFT JOIN po_box_groups bg ON bg.po_id = po.id LEFT JOIN po_items pi ON pi.po_box_group_id = bg.id
                    GROUP BY po.id ORDER BY po.created_at DESC`).map(r => {
    const [, costs] = Q.poLandedOverheadPerPair(r.id);
    const [goodsUsd, estimate] = Q.poGoodsUsd(r.id, r.currency_code);
    const status = r.group_count && r.received_group_count === r.group_count ? 'received' : r.received_group_count ? 'partial' : 'draft';
    return { ...r, status, landed: goodsUsd !== null ? goodsUsd + costs : null, estimate };
  });
  const transit = all(`SELECT * FROM shipments WHERE status != 'received' ORDER BY eta IS NULL, eta`);
  const out = [header(t('Purchasing'), { sub: `${rows.length} ${esc(plural(rows.length, 'purchase order', 'purchase orders'))}`,
    actions: `<button class="btn primary" data-act="newPo">+ ${esc(t('New purchase order'))}</button>` }), subnav('purchasing')];
  if (transit.length) out.push(`<div class="callout">${esc(t('In transit'))}: ${transit.map(s => `<a href="#/shipment/${esc(s.id)}"><b>${esc(s.reference)}</b></a>${s.eta ? ` (${esc(t('ETA'))} ${esc(fmtDate(s.eta))})` : ''}`).join(' · ')}</div>`);
  out.push(panel('', table([{ h: t('Purchase order') }, { h: t('Supplier') }, { h: t('Status'), cls: 'hide-sm' }, { h: t('Goods'), n: true, cls: 'hide-sm' }, { h: t('Landed cost'), n: true }],
    rows.map(r => ({ href: `po/${r.id}`, cells: [`<span class="mono">${esc(poNo(r.id))}</span><span class="sub">${esc(fmtDate(r.created_at))}</span>`,
      esc(r.supplier_name || '—') + `<span class="sub">${esc(t('{r} of {n} mixes received', { r: r.received_group_count, n: r.group_count }))}</span>`,
      poPill(r.status), esc(fmtMoney(r.goods_total, r.currency_code)),
      r.landed === null ? `<span class="muted">${esc(t('rate missing'))}</span>` : esc(fmtUsd(r.landed)) + (r.estimate ? `<span class="sub">${esc(t('estimate'))}</span>` : '')] })),
    { emptyText: t('No purchase orders yet.') }), { tight: true }));
  return out.join('');
}

function poData(pid) {
  const po = one(`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`, [pid]);
  if (!po) return null;
  const cur = po.currency_code;
  const [overhead, extra, pairsOnPo] = Q.poLandedOverheadPerPair(pid);
  const rates = Q.poGroupRates(pid, cur);
  let goodsTotal = 0, goodsUsd = 0, estimate = false;
  const groups = all(`SELECT g.*, sh.reference as shipment_ref FROM po_box_groups g LEFT JOIN shipments sh ON sh.id = g.shipment_id WHERE g.po_id = ? ORDER BY g.id`, [pid]).map(g => {
    const lines = all(`SELECT pi.*, p.name as product_name, v.color, v.size, v.sku FROM po_items pi JOIN variants v ON v.id = pi.variant_id
                       JOIN products p ON p.id = v.product_id WHERE pi.po_box_group_id = ? ORDER BY p.name, v.size`, [g.id]);
    const ppb = sum(lines, l => l.qty), cpb = sum(lines, l => l.qty * l.unit_cost), gt = cpb * g.box_count;
    const [rate, fixed, day] = rates.get(g.id) || [null, false, null];
    let landedBox = null, landedTotal = null;
    if (rate !== null && rate !== undefined) {
      landedBox = cpb * rate + ppb * overhead;
      landedTotal = landedBox * g.box_count;
      if (goodsUsd !== null) goodsUsd += gt * rate;
    } else if (gt) goodsUsd = null;
    if (gt && !fixed) estimate = true;
    goodsTotal += gt;
    return { ...g, lines, ppb, cpb, gt, rate, fixed, day, landedBox, landedTotal };
  });
  const landed = goodsUsd !== null ? goodsUsd + extra : null;
  const perPairGoods = goodsUsd !== null && pairsOnPo ? goodsUsd / pairsOnPo : null;
  const pays = all(`SELECT t.*, a.name as account_name, a.currency_code as account_currency,
                           CASE WHEN t.settled_amount IS NOT NULL THEN t.settled_amount * COALESCE(t.settled_fx_rate, 1)
                                ELSE -t.amount * COALESCE(t.fx_rate_to_usd, 1) END as amount_usd
                    FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id
                    WHERE t.ref_type = 'purchase_order' AND t.ref_id = ? ORDER BY t.occurred_on, t.id`, [pid])
    .map(p => ({ ...p, kind: 'cash', fx: p.settled_amount !== null ? PO.settlementResult(p.id) : null }));
  for (const d of all(`SELECT l.*, p.name as partner_name FROM partner_ledger l JOIN partners p ON p.id = l.partner_id
                       WHERE l.ref_type = 'purchase_order' AND l.ref_id = ? AND l.method = 'direct'`, [pid])) {
    pays.push({ id: d.id, kind: 'partner', occurred_on: d.occurred_on, amount: -d.amount, account_name: t('{p} (paid directly — loan)', { p: d.partner_name }),
      account_currency: d.currency_code, amount_usd: d.amount * (d.fx_rate_to_usd || 1), description: d.description });
  }
  pays.sort((a, b) => (String(a.occurred_on) < String(b.occurred_on) ? -1 : String(a.occurred_on) > String(b.occurred_on) ? 1 : 0));
  const paid = sum(pays, p => p.amount_usd);
  return { po, cur, overhead, extra, pairsOnPo, groups, goodsTotal, goodsUsd, estimate, landed, perPairGoods,
    perPairLanded: perPairGoods !== null ? perPairGoods + overhead : null, pays, paid,
    outstanding: landed !== null ? pyRound(landed - paid, 2) : null, costLines: Q.poCostLines(pid) };
}

function poPage(pidRaw) {
  const pid = id(pidRaw);
  const D = poData(pid);
  if (!D) return header(t('Purchase order'), { back: 'purchasing' }) + empty('—');
  const { po, cur, groups } = D;
  const status = poStatus(pid);
  const open = groups.filter(g => !g.received_at && g.lines.length);
  const P = esc(pid);
  const acts = [`<button class="btn" data-act="editPo" data-id="${P}">${esc(t('Edit'))}</button>`];
  if (open.length) acts.push(`<button class="btn primary" data-act="receivePo" data-id="${P}">${esc(t('Receive everything'))}</button>`);
  const out = [header(`${t('Purchase order')} ${poNo(pid)}`, { back: 'purchasing', eyebrow: fmtDate(po.created_at),
    sub: `${esc(po.supplier_name || t('No supplier'))} · ${poPill(status)} · ${esc(cur)}${po.notes ? ' · ' + esc(po.notes) : ''}`, actions: acts.join('') })];
  const rate = Q.rateOn(cur);
  if (rate === null && cur !== 'USD') out.push(`<div class="callout bad">${esc(t('No exchange rate for {c} yet: costs can’t be worked out in USD until one is set.', { c: cur }))}</div>`);
  out.push(tiles([
    tile(t('Goods'), big(D.goodsTotal, cur), esc(`${fmtNum(D.pairsOnPo)} ${plural(D.pairsOnPo, 'pair', 'pairs')}`)),
    tile(t('Landed cost'), D.landed === null ? '—' : big(D.landed, 'USD'), esc(D.estimate ? t('estimate, at today’s rate') : t('goods + costs, in USD'))),
    tile(t('Per pair, landed'), D.perPairLanded === null ? '—' : esc(fmtUsd(D.perPairLanded)), D.overhead ? esc(t('of which costs {o}', { o: fmtUsd(D.overhead) })) : ''),
    tile(t('Still to pay'), D.outstanding === null ? '—' : big(D.outstanding, 'USD'), esc(t('paid {p}', { p: fmtUsd(D.paid) })), '', D.outstanding > 0.004 ? 'neg' : '')
  ]));
  // the mixes
  for (const g of groups) out.push(mixPanel(pid, cur, g));
  out.push(`<div class="actions left"><button class="btn primary" data-act="typeRun" data-id="${P}">+ ${esc(t('Type a size run'))}</button>
    <button class="btn" data-act="applyRun" data-id="${P}">+ ${esc(t('Use a saved size run'))}</button>
    <button class="btn" data-act="poAddItem" data-id="${P}">+ ${esc(t('Add one size'))}</button></div>`);
  if (!groups.length) out.push(panel('', empty(t('Nothing on this purchase order yet'), t('Add the boxes you are buying: type a size run like 40x2, 41x3, 42x5 for each style and colour.'))));
  // landed costs
  const costRows = D.costLines.map(l => ({ cells: [
    `<b>${esc(l.description)}</b><span class="sub">${l.cost_date ? esc(fmtDate(l.cost_date)) + ' · ' : ''}${esc(l.is_actual ? t('actual') : t('estimate'))}</span>`,
    esc(fmtMoney(l.amount, l.currency_code)),
    l.amount_usd === null ? `<span class="muted">${esc(t('rate missing'))}</span>` : esc(fmtUsd(l.amount_usd)) + `<span class="sub">${esc(l.rate_fixed ? t('rate fixed') : t('estimate'))}</span>`,
    `<div class="rowacts"><button class="btn sm" data-act="editCost" data-po="${P}" data-id="${esc(l.id)}">${esc(t('Edit'))}</button><button class="btn sm danger" data-act="delCost" data-po="${P}" data-id="${esc(l.id)}">✕</button></div>`] }));
  out.push(panel(t('Landed costs (freight, clearing, etc.)'), costRows.length
    ? table([{ h: t('Cost') }, { h: t('Amount'), n: true }, { h: 'USD', n: true }, { h: '' }], costRows,
      { foot: [esc(t('{o} per pair', { o: fmtUsd(D.overhead) })), '', esc(fmtUsd(D.extra)), ''] })
    : `<div class="panel-b">${empty(t('No costs yet.'), t('Freight, customs clearing and transport are spread over every pair of this order.'))}</div>`,
  { tight: true, actions: `<button class="btn sm" data-act="newCost" data-id="${P}">+ ${esc(t('Add a cost'))}</button>` }));
  // payments
  const payRows = D.pays.map(p => ({ cells: [esc(fmtDate(p.occurred_on)),
    esc(p.account_name) + (p.description ? `<span class="sub">${esc(p.description)}</span>` : '')
      + (p.settled_amount !== null && p.settled_amount !== undefined ? `<span class="sub">${esc(t('supplier received {s}', { s: fmtMoney(p.settled_amount, p.settled_currency) }))} · ${esc(PO.exchangePhrase(p.fx))}</span>` : ''),
    esc(fmtMoney(-p.amount, p.account_currency)), esc(fmtUsd(p.amount_usd)),
    `<div class="rowacts"><button class="btn sm danger" data-act="delPoPay" data-po="${P}" data-k="${p.kind}" data-id="${esc(p.id)}">✕</button></div>`] }));
  out.push(panel(t('Payments to the supplier'), (payRows.length ? table([{ h: t('Date') }, { h: t('From') }, { h: t('Amount'), n: true }, { h: 'USD', n: true }, { h: '' }], payRows,
    { foot: [t('Total'), '', '', esc(fmtUsd(D.paid)), ''] }) : `<div class="panel-b">${empty(t('No payments yet.'))}</div>`)
    + `<div class="panel-b"><div class="kv"><span>${esc(t('Landed cost'))}</span><b>${D.landed === null ? '—' : esc(fmtUsd(D.landed))}</b><span>${esc(t('Paid'))}</span><b>${esc(fmtUsd(D.paid))}</b>
      <span>${esc(t('Still to pay'))}</span><b>${D.outstanding === null ? '—' : esc(fmtUsd(D.outstanding))}</b></div></div>`,
  { tight: true, actions: `<button class="btn sm primary" data-act="payPo" data-id="${P}">${esc(t('Pay the supplier'))}</button>` }));
  out.push(docsPanel({ po_id: pid }));
  out.push(`<div class="actions"><button class="btn danger" data-act="delPo" data-id="${P}">${esc(t('Delete the purchase order'))}</button></div>`);
  return out.join('');
}

function mixPanel(pid, cur, g) {
  const P = esc(pid), G = esc(g.id);
  const received = !!g.received_at;
  const lineActs = l => received ? '' : `<div class="rowacts"><button class="btn sm" data-act="editPoItem" data-po="${P}" data-id="${esc(l.id)}">${esc(t('Edit'))}</button><button class="btn sm danger" data-act="delPoItem" data-po="${P}" data-id="${esc(l.id)}">✕</button></div>`;
  const body = g.lines.length ? table([{ h: t('Style') }, { h: t('Size') }, { h: t('pairs'), n: true }, { h: t('Cost'), n: true }, { h: '' }],
    g.lines.map(l => ({ cells: [esc(l.product_name) + (l.color ? `<span class="sub">${esc(l.color)}</span>` : ''), `<b>${esc(l.size)}</b>`, fmtQty(l.qty),
      esc(fmtMoney(l.unit_cost, cur)), lineActs(l)] })),
    { foot: [esc(t('One box')), '', fmtQty(g.ppb), esc(fmtMoney(g.cpb, cur)), ''] }) : `<div class="panel-b">${empty(t('No sizes in this mix.'))}</div>`;
  const rateTxt = g.rate === null || g.rate === undefined ? t('no rate for {c}', { c: cur })
    : cur === 'USD' ? '' : (g.fixed ? t('rate of {d}', { d: fmtDate(g.day) }) : t('today’s rate (estimate)'));
  const kv = `<div class="panel-b"><div class="kv">
    <span>${esc(t('Boxes'))}</span><b>${fmtNum(g.box_count)} × ${fmtNum(g.ppb)} ${esc(t('pairs'))}</b>
    <span>${esc(t('Goods'))}</span><b>${esc(fmtMoney(g.gt, cur))}</b>
    <span>${esc(t('Landed per box'))}</span><b>${g.landedBox === null ? '—' : esc(fmtUsd(g.landedBox))}${rateTxt ? ` <span class="sub">${esc(rateTxt)}</span>` : ''}</b>
    <span>${esc(t('Landed for the mix'))}</span><b>${g.landedTotal === null ? '—' : esc(fmtUsd(g.landedTotal))}</b>
    ${g.shipment_ref ? `<span>${esc(t('Shipment'))}</span><b><a href="#/shipment/${esc(g.shipment_id)}">${esc(g.shipment_ref)}</a></b>` : ''}</div></div>`;
  const acts = [];
  if (received) {
    acts.push(pill(t('Received {d}', { d: fmtDate(g.received_at) }), 'good'));
    acts.push(`<a class="btn sm" href="#/mix/${esc(pid)}/${encodeURIComponent(g.label)}">${esc(t('See the boxes'))}</a>`);
    acts.push(`<button class="btn sm" data-act="saveRun" data-po="${P}" data-id="${G}">${esc(t('Save as size run'))}</button>`);
    acts.push(`<button class="btn sm danger" data-act="unreceive" data-po="${P}" data-id="${G}">${esc(t('Un-receive'))}</button>`);
  } else {
    acts.push(`<button class="btn sm" data-act="boxCount" data-po="${P}" data-id="${G}">${esc(t('Boxes'))}: ${fmtNum(g.box_count)}</button>`);
    acts.push(`<button class="btn sm" data-act="typeRun" data-id="${P}" data-l="${esc(g.label)}">+ ${esc(t('Sizes'))}</button>`);
    if (g.lines.length) {
      acts.push(`<button class="btn sm" data-act="saveRun" data-po="${P}" data-id="${G}">${esc(t('Save as size run'))}</button>`);
      acts.push(`<button class="btn sm primary" data-act="receiveMix" data-po="${P}" data-id="${G}">${esc(t('Receive'))}</button>`);
    }
    acts.push(`<button class="btn sm danger" data-act="delMix" data-po="${P}" data-id="${G}">✕</button>`);
  }
  return panel(g.label, body + kv, { tight: true, actions: `<div class="rowacts">${acts.join('')}</div>` });
}

// ---------- documents (purchase orders and shipments) ----------
function docsPanel(owner) {
  const where = owner.po_id !== undefined ? ['po_id = ?', owner.po_id] : ['shipment_id = ?', owner.shipment_id];
  const docs = all(`SELECT * FROM documents WHERE ${where[0]} ORDER BY uploaded_at DESC`, [where[1]]);
  const data = owner.po_id !== undefined ? `data-po="${esc(owner.po_id)}"` : `data-sh="${esc(owner.shipment_id)}"`;
  return panel(t('Documents'), docs.length ? table([{ h: t('Document') }, { h: t('Date'), cls: 'hide-sm' }, { h: '' }],
    docs.map(d => ({ cells: [`<b>${esc(d.original_name)}</b><span class="sub">${esc(t(d.doc_type || 'Other'))}${d.notes ? ' · ' + esc(d.notes) : ''}</span>`, esc(fmtDate(d.uploaded_at)),
      `<div class="rowacts"><button class="btn sm" data-act="openDoc" data-id="${esc(d.id)}">${esc(t('Open'))}</button><button class="btn sm danger" data-act="delDoc" data-id="${esc(d.id)}">✕</button></div>`] })))
    : `<div class="panel-b">${empty(t('No documents yet.'), t('Supplier invoice, packing list, bill of lading… up to 700 KB each.'))}</div>`,
  { tight: true, actions: `<button class="btn sm" data-act="uploadDoc" ${data}>+ ${esc(t('Add a document'))}</button>` });
}
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const extOf = n => (String(n).includes('.') ? String(n).split('.').pop().toLowerCase() : '');
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function openDocument(docId) {
  const d = one(`SELECT * FROM documents WHERE id = ?`, [docId]);
  if (!d) return;
  const f = await getBlob('files', d.filename);
  if (!f || !f.data) { toast(t('This document isn’t available: it was too big to keep, or hasn’t finished uploading from another device.')); return; }
  const bin = atob(f.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(d.original_name)] || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = d.original_name; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- suppliers ----------
function suppliers() {
  const rows = all(`SELECT s.*, (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) as po_count FROM suppliers s ORDER BY s.name`);
  return header(t('Suppliers'), { sub: `${rows.length}`, actions: `<button class="btn primary" data-act="newSupplier">+ ${esc(t('New supplier'))}</button>` }) + subnav('suppliers')
    + panel('', table([{ h: t('Name') }, { h: t('Phone'), cls: 'hide-sm' }, { h: t('Purchase orders'), n: true }],
      rows.map(s => ({ href: `supplier/${s.id}`, cells: [`<b>${esc(s.name)}</b><span class="sub">${esc(s.address || '')}</span>`, esc(s.phone || ''), fmtNum(s.po_count)] })),
      { emptyText: t('No suppliers yet.') }), { tight: true });
}
function supplier(sidRaw) {
  const sid = id(sidRaw);
  const s = one(`SELECT * FROM suppliers WHERE id = ?`, [sid]);
  if (!s) return header(t('Suppliers'), { back: 'suppliers' }) + empty('—');
  const pos = all(`SELECT po.*, (SELECT COUNT(*) FROM po_box_groups g WHERE g.po_id = po.id) as groups FROM purchase_orders po WHERE po.supplier_id = ? ORDER BY po.created_at DESC`, [sid]);
  return header(s.name, { back: 'suppliers', eyebrow: t('Supplier'), sub: esc([s.phone, s.email, s.address].filter(Boolean).join(' · ')),
    actions: `<button class="btn primary" data-act="newPo" data-s="${esc(sid)}">+ ${esc(t('New purchase order'))}</button><button class="btn" data-act="editSupplier" data-id="${esc(sid)}">${esc(t('Edit'))}</button><button class="btn ghost danger" data-act="delSupplier" data-id="${esc(sid)}">${esc(t('Delete'))}</button>` })
    + panel(t('Purchase orders'), table([{ h: t('Purchase order') }, { h: t('Status') }, { h: t('Mix') + 's', n: true }],
      pos.map(p => ({ href: `po/${p.id}`, cells: [`<span class="mono">${esc(poNo(p.id))}</span><span class="sub">${esc(fmtDate(p.created_at))}</span>`, poPill(poStatus(p.id)), fmtNum(p.groups)] })),
      { emptyText: t('No purchase orders yet.') }), { tight: true });
}

// ---------- shipments ----------
const STAGES = () => PO.SHIPMENT_STAGES.map(([k, label, col]) => ({ k, label: t(label), col }));
const stagePill = s => { const st = STAGES().find(x => x.k === s); return pill(st ? st.label : s, { received: 'good', cleared: 'accent', arrived: 'accent', shipped: 'warn' }[s] || ''); };
function shipments() {
  const rows = all(`SELECT s.*, (SELECT COUNT(*) FROM po_box_groups g WHERE g.shipment_id = s.id) as mix_count,
                           (SELECT COALESCE(SUM(g.box_count), 0) FROM po_box_groups g WHERE g.shipment_id = s.id) as box_count,
                           CAST(julianday(s.eta) - julianday('now') AS INTEGER) as days_to_eta
                    FROM shipments s ORDER BY CASE s.status WHEN 'received' THEN 1 ELSE 0 END, s.eta IS NULL, s.eta`);
  return header(t('Shipments'), { sub: `${rows.filter(r => r.status !== 'received').length} ${esc(t('in transit'))}`, actions: `<button class="btn primary" data-act="newShipment">+ ${esc(t('New shipment'))}</button>` })
    + subnav('shipments')
    + panel('', table([{ h: t('Shipment') }, { h: t('Status') }, { h: t('ETA'), cls: 'hide-sm' }, { h: t('boxes'), n: true }],
      rows.map(s => ({ href: `shipment/${s.id}`, cls: s.status === 'received' ? 'dim' : '', cells: [`<b>${esc(s.reference)}</b><span class="sub">${esc([s.container_no, s.vessel].filter(Boolean).join(' · '))}</span>`,
        stagePill(s.status), s.eta ? esc(fmtDate(s.eta)) + (s.status !== 'received' && s.days_to_eta !== null ? `<span class="sub">${esc(s.days_to_eta >= 0 ? t('in {n} days', { n: s.days_to_eta }) : t('{n} days late', { n: -s.days_to_eta }))}</span>` : '') : '—',
        `${fmtNum(s.box_count)}<span class="sub">${fmtNum(s.mix_count)} ${esc(t('Mix').toLowerCase())}s</span>`] })),
      { emptyText: t('No shipments yet.') }), { tight: true });
}
function shipment(shRaw) {
  const sh = id(shRaw);
  const s = one(`SELECT * FROM shipments WHERE id = ?`, [sh]);
  if (!s) return header(t('Shipments'), { back: 'shipments' }) + empty('—');
  const mixes = all(`SELECT g.*, po.currency_code, sup.name as supplier_name, (SELECT COALESCE(SUM(pi.qty), 0) FROM po_items pi WHERE pi.po_box_group_id = g.id) as pairs_per_box
                     FROM po_box_groups g JOIN purchase_orders po ON po.id = g.po_id LEFT JOIN suppliers sup ON sup.id = po.supplier_id
                     WHERE g.shipment_id = ? ORDER BY g.po_id, g.id`, [sh]);
  const waiting = mixes.filter(m => !m.received_at);
  const S = esc(sh);
  const stages = STAGES();
  const at = stages.findIndex(x => x.k === s.status);
  const steps = `<div class="steps ship">${stages.map((st, i) => `<div class="step${i <= at ? ' done' : ''}${i === at ? ' cur' : ''}"><b>${esc(st.label)}</b><span class="sub">${st.col && s[st.col] ? esc(fmtDate(s[st.col])) : ''}</span></div>`).join('')}</div>`;
  const acts = [`<button class="btn" data-act="editShipment" data-id="${S}">${esc(t('Edit'))}</button>`, `<button class="btn" data-act="stageShipment" data-id="${S}">${esc(t('Change stage'))}</button>`];
  if (waiting.length) acts.push(`<button class="btn primary" data-act="receiveShipment" data-id="${S}">${esc(t('Receive into stock'))}</button>`);
  return header(s.reference, { back: 'shipments', eyebrow: t('Shipment'), sub: `${stagePill(s.status)}${s.eta ? ' · ' + esc(t('ETA')) + ' ' + esc(fmtDate(s.eta)) : ''}`, actions: acts.join('') })
    + panel('', steps + `<div class="kv mtop"><span>${esc(t('Container'))}</span><b>${esc(s.container_no || '—')}</b><span>${esc(t('Bill of lading'))}</span><b>${esc(s.bl_number || '—')}</b>
      <span>${esc(t('Vessel'))}</span><b>${esc(s.vessel || '—')}</b>${s.notes ? `<span>${esc(t('Notes'))}</span><b>${esc(s.notes)}</b>` : ''}</div>`)
    + panel(t('Mixes on this shipment'), table([{ h: t('Mix') }, { h: t('Purchase order'), cls: 'hide-sm' }, { h: t('boxes'), n: true }, { h: '' }],
      mixes.map(m => ({ cells: [`<b>${esc(m.label)}</b><span class="sub">${fmtNum(m.pairs_per_box)} ${esc(t('pairs'))} / ${esc(t('box'))}${m.received_at ? ' · ' + esc(t('Received {d}', { d: fmtDate(m.received_at) })) : ''}</span>`,
        `<a href="#/po/${esc(m.po_id)}">${esc(poNo(m.po_id))}</a>${m.supplier_name ? `<span class="sub">${esc(m.supplier_name)}</span>` : ''}`, fmtNum(m.box_count),
        m.received_at ? '' : `<div class="rowacts"><button class="btn sm danger" data-act="unassignMix" data-sh="${S}" data-id="${esc(m.id)}">${esc(t('Remove'))}</button></div>`] })),
      { emptyText: t('No mixes on this shipment yet.') }), { tight: true, actions: `<button class="btn sm" data-act="assignMix" data-id="${S}">+ ${esc(t('Add a mix'))}</button>` })
    + docsPanel({ shipment_id: sh });
}

// ---------- locations ----------
function locations() {
  const rows = all(`SELECT l.*, p.name as parent_name, (SELECT COUNT(*) FROM boxes b WHERE b.location_id = l.id AND b.status = 'in_stock') as boxes
                    FROM locations l LEFT JOIN locations p ON p.id = l.parent_id ORDER BY COALESCE(l.parent_id, l.id), l.parent_id IS NOT NULL, l.name`);
  const unplaced = val(`SELECT COUNT(*) FROM boxes b WHERE b.status = 'in_stock' AND (b.location_id IS NULL OR b.location_id NOT IN (SELECT id FROM locations))`);
  return header(t('Locations'), { sub: `${rows.length}`, actions: `<button class="btn primary" data-act="newLocation">+ ${esc(t('New location'))}</button>` }) + subnav('locations')
    + (unplaced ? `<div class="callout warn"><a href="#/unplaced"><b>${esc(t('{n} sealed box(es) have no location', { n: unplaced }))}</b></a> — ${esc(t('file them so they show up here.'))}</div>` : '')
    + panel('', table([{ h: t('Location') }, { h: t('Kind'), cls: 'hide-sm' }, { h: t('sealed boxes'), n: true }],
      rows.map(l => ({ href: `location/${l.id}`, cls: l.archived ? 'dim' : '', cells: [`${l.parent_id ? '↳ ' : ''}<b>${esc(l.name)}</b>${l.parent_name ? `<span class="sub">${esc(t('in {p}', { p: l.parent_name }))}</span>` : ''}${l.archived ? ` ${pill(t('archived'))}` : ''}`,
        esc(t(l.kind || 'warehouse')), fmtNum(l.boxes)] })), { emptyText: t('No locations yet.') }), { tight: true });
}
function location(lidRaw) {
  const lid = id(lidRaw);
  const l = one(`SELECT * FROM locations WHERE id = ?`, [lid]);
  if (!l) return header(t('Locations'), { back: 'locations' }) + empty('—');
  const mixes = all(`SELECT b.source_po_id, b.source_label, COUNT(*) as boxes, MIN(b.id) as sample_box_id FROM boxes b
                     WHERE b.location_id = ? AND b.status = 'in_stock' GROUP BY b.source_po_id, b.source_label ORDER BY boxes DESC`, [lid])
    .map(m => ({ ...m, pairs: sum(Q.boxContents(m.sample_box_id), i => i.qty) }));
  const moves = all(`SELECT m.*, b.box_code, f.name as from_name, tl.name as to_name FROM box_moves m JOIN boxes b ON b.id = m.box_id
                     LEFT JOIN locations f ON f.id = m.from_location_id LEFT JOIN locations tl ON tl.id = m.to_location_id
                     WHERE m.from_location_id = ? OR m.to_location_id = ? ORDER BY m.moved_at DESC LIMIT 50`, [lid, lid]);
  const L = esc(lid);
  return header(l.name, { back: 'locations', eyebrow: t('Location'), sub: esc([t(l.kind || 'warehouse'), l.notes].filter(Boolean).join(' · ')) + (l.archived ? ' ' + pill(t('archived')) : ''),
    actions: `<button class="btn" data-act="editLocation" data-id="${L}">${esc(t('Edit'))}</button>` })
    + tiles([tile(t('sealed boxes'), fmtNum(sum(mixes, m => m.boxes)), ''), tile(t('pairs'), fmtNum(sum(mixes, m => m.boxes * m.pairs)), '')])
    + panel(t('What is here'), table([{ h: t('Mix') }, { h: t('boxes'), n: true }, { h: t('pairs'), n: true, cls: 'hide-sm' }, { h: '' }],
      mixes.map(m => ({ cells: [`<a href="#/mix/${esc(m.source_po_id ?? 'none')}/${encodeURIComponent(m.source_label)}"><b>${esc(m.source_label)}</b></a>`, fmtNum(m.boxes), fmtNum(m.boxes * m.pairs),
        `<div class="rowacts"><button class="btn sm" data-act="moveBoxes" data-from="${L}" data-po="${esc(m.source_po_id ?? 'none')}" data-l="${esc(m.source_label)}">${esc(t('Move'))}</button></div>`] })),
      { emptyText: t('No sealed boxes here.') }), { tight: true })
    + (moves.length ? panel(t('Recent moves'), table([{ h: t('Date') }, { h: t('Box') }, { h: t('From') }, { h: t('To') }],
      moves.map(m => ({ cells: [esc(fmtDate(m.moved_at)), `<span class="mono">${esc(m.box_code)}</span>${m.note ? `<span class="sub">${esc(m.note)}</span>` : ''}`, esc(m.from_name || '—'), esc(m.to_name || '—')] }))), { tight: true }) : '');
}
function unplaced() {
  const mixes = all(`SELECT b.source_po_id, b.source_label, COUNT(*) as boxes, MIN(b.id) as sample_box_id FROM boxes b
                     WHERE b.status = 'in_stock' AND (b.location_id IS NULL OR b.location_id NOT IN (SELECT id FROM locations))
                     GROUP BY b.source_po_id, b.source_label ORDER BY boxes DESC`).map(m => ({ ...m, pairs: sum(Q.boxContents(m.sample_box_id), i => i.qty) }));
  const total = sum(mixes, m => m.boxes);
  return header(t('Boxes with no location'), { back: 'locations', sub: `${fmtNum(total)} ${esc(t('sealed boxes'))}`,
    actions: total ? `<button class="btn primary" data-act="placeBoxes" data-l="__all__">${esc(t('File them all'))}</button>` : '' })
    + panel('', table([{ h: t('Mix') }, { h: t('boxes'), n: true }, { h: '' }],
      mixes.map(m => ({ cells: [`<b>${esc(m.source_label)}</b><span class="sub">${fmtNum(m.pairs)} ${esc(t('pairs'))} / ${esc(t('box'))}</span>`, fmtNum(m.boxes),
        `<div class="rowacts"><button class="btn sm" data-act="placeBoxes" data-po="${esc(m.source_po_id ?? '')}" data-l="${esc(m.source_label)}">${esc(t('File'))}</button></div>`] })),
      { emptyText: t('Every sealed box has a location.') }), { tight: true });
}

// ---------- size runs ----------
function sizeruns() {
  const runs = all(`SELECT * FROM assortments ORDER BY name`).map(a => {
    const lines = all(`SELECT * FROM assortment_lines WHERE assortment_id = ? ORDER BY size`, [a.id]);
    return { ...a, lines, total: sum(lines, l => l.qty) };
  });
  const out = [header(t('Size runs'), { sub: esc(t('Your usual spread of sizes in a box, ready to apply to a purchase order.')),
    actions: `<button class="btn primary" data-act="newRun">+ ${esc(t('New size run'))}</button>` }), subnav('sizeruns')];
  if (!runs.length) out.push(panel('', empty(t('No size runs saved yet.'), t('Create one here, or save a mix from a purchase order as a size run.'))));
  for (const a of runs) {
    const A = esc(a.id);
    out.push(panel(`${a.name} · ${a.total} ${plural(a.total, 'pair', 'pairs')}`, `<div class="panel-b">${a.notes ? `<p class="sub">${esc(a.notes)}</p>` : ''}
      <div class="chips">${a.lines.map(l => `<span class="chip">${esc(l.size)} × ${fmtNum(l.qty)} <button type="button" class="linkbtn" data-act="delRunLine" data-a="${A}" data-id="${esc(l.id)}" aria-label="${esc(t('Remove'))}">✕</button></span>`).join('')}</div></div>`,
    { actions: `<div class="rowacts"><button class="btn sm" data-act="addRunLine" data-id="${A}">+ ${esc(t('Size'))}</button><button class="btn sm danger" data-act="delRun" data-id="${A}">✕</button></div>` }));
  }
  return out.join('');
}

// ---------- price list (app._price_list) ----------
export function priceList() {
  return all(`SELECT b.source_po_id, b.source_label, COUNT(*) as available, MIN(b.id) as sample_box_id FROM boxes b WHERE b.status = 'in_stock'
              GROUP BY b.source_po_id, b.source_label ORDER BY b.source_label`).map(m => {
    const contents = Q.boxContents(m.sample_box_id);
    const pairs = sum(contents, i => i.qty), costBox = sum(contents, i => i.qty * i.unit_cost);
    const raw = all(`SELECT * FROM price_tiers WHERE source_po_id IS ? AND source_label = ? ORDER BY min_boxes`, [m.source_po_id, m.source_label]);
    const tiers = raw.map((tr, i) => {
      const rate = Q.rateOn(tr.currency_code);
      const boxPrice = tr.price_per_pair * pairs, boxUsd = rate !== null ? boxPrice * rate : null;
      const nxt = i + 1 < raw.length ? raw[i + 1].min_boxes : null;
      return { ...tr, max_boxes: nxt ? nxt - 1 : null, box_price: boxPrice, box_price_usd: boxUsd,
        profit_usd: boxUsd !== null ? boxUsd - costBox : null, margin: boxUsd ? (boxUsd - costBox) / boxUsd * 100 : null };
    });
    const seen = new Set(), styles = [];
    for (const i of contents) {
      const k = i.product_name + '|' + (i.color || '');
      if (seen.has(k)) continue;
      seen.add(k); styles.push({ name: i.product_name, color: i.color, image: i.image_filename });
    }
    styles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.color || '') < (b.color || '') ? -1 : (a.color || '') > (b.color || '') ? 1 : 0));
    const bySize = new Map();
    for (const i of contents) bySize.set(i.size, (bySize.get(i.size) || 0) + i.qty);
    const sizeRun = [...bySize.entries()].sort((a, b) => (String(a[0]).length - String(b[0]).length) || (String(a[0]) < String(b[0]) ? -1 : 1)).map(([s, q]) => `${s}×${q}`).join(', ');
    return { ...m, pairs_per_box: pairs, size_run: sizeRun, cost_box_usd: costBox, cost_pair_usd: pairs ? costBox / pairs : 0,
      price: tiers.length && tiers[0].min_boxes === 1 ? tiers[0] : null, tiers, styles };
  });
}
function pricelist() {
  const mixes = priceList();
  const priced = mixes.filter(m => m.price).length;
  const out = [header(t('Price list'), { sub: esc(t('{p} of {n} mixes in stock have a price', { p: priced, n: mixes.length })),
    actions: `<a class="btn" href="#/doc/pricelist/all">${esc(t('Print for customers'))}</a><button class="btn" data-act="priceCsv">${esc(t('Download CSV'))}</button>` }), subnav('pricelist')];
  if (!mixes.length) out.push(panel('', empty(t('No sealed boxes in stock.'))));
  for (const m of mixes) {
    const po = esc(m.source_po_id ?? ''), L = esc(m.source_label);
    const rows = m.tiers.map(tr => ({ cells: [tr.min_boxes === 1 && !tr.max_boxes ? esc(t('Any quantity')) : esc(tr.max_boxes ? (tr.max_boxes === tr.min_boxes ? `${tr.min_boxes}` : `${tr.min_boxes} – ${tr.max_boxes}`) : t('{n} and more', { n: tr.min_boxes })),
      esc(fmtMoney(tr.price_per_pair, tr.currency_code)), esc(fmtMoney(tr.box_price, tr.currency_code)),
      tr.margin === null ? '—' : `<span class="${tr.profit_usd < 0 ? 'neg' : ''}">${esc(fmtUsd(tr.profit_usd))}</span><span class="sub">${fmtNum(tr.margin, 0)} %</span>`,
      `<div class="rowacts"><button class="btn sm danger" data-act="delTier" data-id="${esc(tr.id)}">✕</button></div>`] }));
    out.push(panel(m.source_label, `<div class="panel-b"><p class="sub">${esc(m.styles.map(s => s.name + (s.color ? ' — ' + s.color : '')).join(', '))}</p>
      <div class="kv"><span>${esc(t('In stock'))}</span><b>${fmtNum(m.available)} ${esc(plural(m.available, 'box', 'boxes'))}</b><span>${esc(t('Pairs per box'))}</span><b>${fmtNum(m.pairs_per_box)}</b>
      <span>${esc(t('Size run'))}</span><b class="mono">${esc(m.size_run)}</b><span>${esc(t('Cost'))}</span><b>${esc(fmtUsd(m.cost_box_usd))} / ${esc(t('box'))} · ${esc(fmtUsd(m.cost_pair_usd))} / ${esc(t('pair'))}</b></div></div>`
      + (rows.length ? table([{ h: t('Boxes') }, { h: t('Per pair'), n: true }, { h: t('Per box'), n: true }, { h: t('Profit / box'), n: true, cls: 'hide-sm' }, { h: '' }], rows) : `<div class="panel-b">${empty(t('No price yet.'))}</div>`),
    { tight: true, actions: `<div class="rowacts"><button class="btn sm primary" data-act="setPrice" data-po="${po}" data-l="${L}" data-min="1">${esc(m.price ? t('1-box price') : t('Set the price'))}</button>${m.price ? `<button class="btn sm" data-act="setPrice" data-po="${po}" data-l="${L}">+ ${esc(t('Quantity price'))}</button>` : ''}</div>` }));
  }
  return out.join('');
}
function csvCell(v) { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function downloadText(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export { csvCell, downloadText };

export const BUY_SCREENS = {
  purchasing: { render: purchasing },
  po: { render: poPage },
  suppliers: { render: suppliers },
  supplier: { render: supplier },
  shipments: { render: shipments },
  shipment: { render: shipment },
  locations: { render: locations },
  location: { render: location },
  unplaced: { render: unplaced },
  sizeruns: { render: sizeruns },
  pricelist: { render: pricelist }
};

// ---------- forms ----------
const supplierFields = s => [
  { name: 'name', label: t('Name'), type: 'text', value: s.name || '' },
  { name: 'phone', label: t('Phone'), type: 'text', value: s.phone || '' },
  { name: 'email', label: t('Email'), type: 'text', value: s.email || '' },
  { name: 'address', label: t('Address'), type: 'text', value: s.address || '' }
];
const costFields = c => [
  { name: 'description', label: t('What it is'), type: 'text', value: c.description || '', placeholder: t('Freight, customs clearing, transport…') },
  { name: 'amount', label: t('Amount'), type: 'money', value: c.amount ?? '' },
  { name: 'currency_code', label: t('Currency'), type: 'select', options: curOpts(), value: c.currency_code || 'USD' },
  { name: 'cost_date', label: t('Date'), type: 'date', value: c.cost_date || '', hint: t('The day it was paid. Empty = the day the goods are received.') },
  { name: 'is_actual', label: t('Already paid (actual cost, not an estimate)'), type: 'checkbox', value: c.is_actual ? 1 : 0 }
];
const shipmentFields = s => [
  { name: 'reference', label: t('Reference'), type: 'text', value: s.reference || '', placeholder: t('e.g. Container March') },
  { name: 'container_no', label: t('Container'), type: 'text', value: s.container_no || '' },
  { name: 'bl_number', label: t('Bill of lading'), type: 'text', value: s.bl_number || '' },
  { name: 'vessel', label: t('Vessel'), type: 'text', value: s.vessel || '' },
  { name: 'eta', label: t('ETA'), type: 'date', future: true, value: s.eta || '', hint: t('Expected arrival') },
  { name: 'notes', label: t('Notes'), type: 'textarea', value: s.notes || '' }
];
const locationFields = (l, lid = null) => [
  { name: 'name', label: t('Name'), type: 'text', value: l.name || '' },
  { name: 'kind', label: t('Kind'), type: 'select', options: ['warehouse', 'consignment', 'other'].map(k => [k, t(k)]), value: l.kind || 'warehouse' },
  { name: 'parent_id', label: t('Inside'), type: 'select', value: l.parent_id ?? '',
    options: [['', t('(top level)')], ...all(`SELECT id, name FROM locations WHERE parent_id IS NULL AND archived = 0 ORDER BY name`).filter(p => p.id !== lid).map(p => [p.id, p.name])] },
  { name: 'notes', label: t('Notes'), type: 'text', value: l.notes || '' },
  ...(lid !== null ? [{ name: 'archived', label: t('Archived (no longer used)'), type: 'checkbox', value: l.archived ? 1 : 0 }] : [])
];
const knownColors = () => all(`SELECT DISTINCT color FROM variants WHERE color != '' ORDER BY color`).map(r => r.color);
const colorHint = () => { const c = knownColors(); return c.length ? t('Known: {c}', { c: c.slice(0, 12).join(', ') }) : ''; };

registerActions({
  newPo: (a) => openForm({ title: t('New purchase order'), submit: t('Create'),
    fields: [{ name: 'supplier_id', label: t('Supplier'), type: 'select', options: supOpts(), value: a.dataset.s || '' },
      { name: 'currency_code', label: t('Currency of the supplier’s prices'), type: 'select', options: curOpts(), value: 'USD' },
      { name: 'notes', label: t('Notes'), type: 'textarea' }],
    run: v => PO.poNew({ ...v, supplier_id: id(v.supplier_id) }), done: pid => go(`po/${pid}`) }),
  editPo: (a) => {
    const po = one(`SELECT * FROM purchase_orders WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Edit purchase order'), intro: esc(t('Changing the currency re-costs the boxes still in stock.')),
      fields: [{ name: 'supplier_id', label: t('Supplier'), type: 'select', options: supOpts(), value: po.supplier_id ?? '' },
        { name: 'currency_code', label: t('Currency of the supplier’s prices'), type: 'select', options: curOpts(), value: po.currency_code },
        { name: 'notes', label: t('Notes'), type: 'textarea', value: po.notes || '' }],
      run: v => PO.poEdit(po.id, { ...v, supplier_id: id(v.supplier_id) }), done: after() });
  },
  delPo: (a) => confirmAction({ title: t('Delete this purchase order?'), text: t('Its mixes, costs and any boxes it put into stock are removed (only possible if none of its boxes was sold). Payments stay in the accounts.'),
    confirm: t('Delete'), run: () => PO.poDelete(id(a.dataset.id)), done: after('purchasing') }),
  typeRun: (a) => {
    const pid = id(a.dataset.id);
    const prods = prodOpts();
    if (!prods.length) { toast(t('Add a style first (Stock → New style).')); return; }
    const po = one(`SELECT currency_code FROM purchase_orders WHERE id = ?`, [pid]);
    openForm({ title: a.dataset.l ? t('Add sizes to {l}', { l: a.dataset.l }) : t('Type a size run'), submit: t('Add'),
      intro: esc(t('One box of this mix holds these sizes. Sizes that don’t exist yet for this style and colour are created.')),
      fields: [{ name: 'box_label', label: t('Mix name'), type: a.dataset.l ? 'hidden' : 'text', value: a.dataset.l || nextMixName(pid), hint: t('One mix = boxes that all hold the same thing') },
        { name: 'product_id', label: t('Style'), type: 'select', options: prods },
        { name: 'color', label: t('Colour'), type: 'text', hint: colorHint() },
        { name: 'run', label: t('Sizes × pairs'), type: 'text', placeholder: '40x2, 41x3, 42x5, 43x5, 44x4', full: true },
        { name: 'unit_cost', label: t('Cost per pair ({c})', { c: po.currency_code }), type: 'money', hint: t('Empty = the style’s usual cost') }],
      run: v => PO.poTypeRun(pid, { ...v, product_id: id(v.product_id) }), done: after() });
  },
  applyRun: (a) => {
    const pid = id(a.dataset.id);
    const runs = all(`SELECT id, name FROM assortments ORDER BY name`);
    if (!runs.length) { toast(t('No size runs saved yet.')); return; }
    const po = one(`SELECT currency_code FROM purchase_orders WHERE id = ?`, [pid]);
    openForm({ title: t('Use a saved size run'), submit: t('Add'),
      fields: [{ name: 'assortment_id', label: t('Size run'), type: 'select', options: runs.map(r => [r.id, r.name]) },
        { name: 'box_label', label: t('Mix name'), type: 'text', value: nextMixName(pid) },
        { name: 'product_id', label: t('Style'), type: 'select', options: prodOpts() },
        { name: 'color', label: t('Colour'), type: 'text', hint: colorHint() },
        { name: 'unit_cost', label: t('Cost per pair ({c})', { c: po.currency_code }), type: 'money', hint: t('Empty = the style’s usual cost') }],
      run: v => PO.poApplyRun(pid, { ...v, assortment_id: id(v.assortment_id), product_id: id(v.product_id) }), done: after() });
  },
  poAddItem: (a) => {
    const pid = id(a.dataset.id);
    const vs = variantOpts();
    if (!vs.length) { toast(t('Add a style first (Stock → New style).')); return; }
    const po = one(`SELECT currency_code FROM purchase_orders WHERE id = ?`, [pid]);
    openForm({ title: t('Add one size'), submit: t('Add'),
      fields: [{ name: 'box_label', label: t('Mix name'), type: 'text', value: a.dataset.l || nextMixName(pid) },
        { name: 'variant_id', label: t('Size'), type: 'select', options: vs },
        { name: 'qty', label: t('Pairs per box'), type: 'number', value: 1 },
        { name: 'unit_cost', label: t('Cost per pair ({c})', { c: po.currency_code }), type: 'money', hint: t('Empty = the style’s usual cost') }],
      run: v => PO.poAddItem(pid, { ...v, variant_id: id(v.variant_id) }), done: after() });
  },
  editPoItem: (a) => {
    const it = one(`SELECT pi.*, p.name, v.color, v.size FROM po_items pi JOIN variants v ON v.id = pi.variant_id JOIN products p ON p.id = v.product_id WHERE pi.id = ?`, [id(a.dataset.id)]);
    openForm({ title: [it.name, it.color, it.size].filter(Boolean).join(' · '),
      fields: [{ name: 'qty', label: t('Pairs per box'), type: 'number', value: it.qty }, { name: 'unit_cost', label: t('Cost per pair'), type: 'money', value: it.unit_cost }],
      run: v => PO.poItemEdit(id(a.dataset.po), it.id, v), done: after() });
  },
  delPoItem: (a) => confirmAction({ title: t('Remove this size?'), text: '', confirm: t('Remove'), run: () => PO.poItemDelete(id(a.dataset.po), id(a.dataset.id)), done: after() }),
  delMix: (a) => confirmAction({ title: t('Remove this mix?'), text: t('All its sizes are removed from the purchase order.'), confirm: t('Remove'), run: () => PO.poGroupDelete(id(a.dataset.po), id(a.dataset.id)), done: after() }),
  boxCount: (a) => {
    const g = one(`SELECT * FROM po_box_groups WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('How many boxes of {l}?', { l: g.label }), fields: [{ name: 'box_count', label: t('Boxes'), type: 'number', value: g.box_count }],
      run: v => PO.poSetBoxCount(id(a.dataset.po), g.id, v), done: after() });
  },
  saveRun: (a) => {
    const g = one(`SELECT * FROM po_box_groups WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Save as size run'), intro: esc(t('The sizes of one box of “{l}” are saved, to reuse on later purchase orders.', { l: g.label })),
      fields: [{ name: 'name', label: t('Name'), type: 'text', value: g.label }], run: v => PO.poSaveRun(id(a.dataset.po), g.id, v), done: after() });
  },
  receiveMix: (a) => {
    const g = one(`SELECT * FROM po_box_groups WHERE id = ?`, [id(a.dataset.id)]);
    const locs = locOpts();
    openForm({ title: t('Receive “{l}”?', { l: g.label }), submit: t('Receive'), danger: false,
      intro: esc(t('{n} box(es) go into stock with their landed cost. The exchange rate of today is fixed for them.', { n: g.box_count })),
      fields: locs.length ? [{ name: 'location_id', label: t('Into'), type: 'select', options: locs }] : [],
      run: v => PO.poGroupReceive(id(a.dataset.po), g.id, { location_id: id(v.location_id) }), done: after() });
  },
  receivePo: (a) => {
    const pid = id(a.dataset.id);
    const n = val(`SELECT COALESCE(SUM(box_count), 0) FROM po_box_groups WHERE po_id = ? AND received_at IS NULL`, [pid]);
    const locs = locOpts();
    openForm({ title: t('Receive everything?'), submit: t('Receive'), danger: false,
      intro: esc(t('{n} box(es) go into stock with their landed cost. The exchange rate of today is fixed for them.', { n })),
      fields: locs.length ? [{ name: 'location_id', label: t('Into'), type: 'select', options: locs }] : [],
      run: v => PO.poReceive(pid, { location_id: id(v.location_id) }), done: after() });
  },
  unreceive: (a) => confirmAction({ title: t('Un-receive this mix?'), text: t('Its boxes leave the stock and the mix can be edited again. Not possible once a box was sold.'),
    confirm: t('Un-receive'), run: () => PO.poGroupUnreceive(id(a.dataset.po), id(a.dataset.id)), done: after() }),
  newCost: (a) => openForm({ title: t('Add a cost'), intro: esc(t('Spread over every pair of this purchase order; boxes already in stock are re-costed.')),
    fields: costFields({}), run: v => PO.poCostNew(id(a.dataset.id), v), done: after() }),
  editCost: (a) => {
    const c = one(`SELECT * FROM po_costs WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Edit cost'), fields: costFields(c), run: v => PO.poCostEdit(id(a.dataset.po), c.id, v), done: after() });
  },
  delCost: (a) => confirmAction({ title: t('Remove this cost?'), text: t('Boxes still in stock are re-costed.'), confirm: t('Remove'), run: () => PO.poCostDelete(id(a.dataset.po), id(a.dataset.id)), done: after() }),
  payPo: (a) => {
    const pid = id(a.dataset.id);
    const accts = all(`SELECT id, name, currency_code FROM cash_accounts WHERE archived = 0 ORDER BY name`);
    const partners = all(`SELECT id, name FROM partners WHERE archived = 0 ORDER BY name`);
    const from = [...accts.map(x => [`acct:${x.id}`, `${x.name} (${x.currency_code})`]), ...partners.map(p => [`partner:${p.id}`, t('{p} paid from their own pocket', { p: p.name })])];
    if (!from.length) { toast(t('Add a cash account first (Money).')); return; }
    const acctCur = v => { const m = /^acct:(.+)$/.exec(v.paid_from || ''); const x = m && accts.find(z => String(z.id) === m[1]); return x ? x.currency_code : null; };
    const po = one(`SELECT currency_code FROM purchase_orders WHERE id = ?`, [pid]);
    openForm({ title: t('Pay the supplier'), submit: t('Record the payment'),
      fields: [{ name: 'paid_from', label: t('Paid from'), type: 'select', options: from, redraw: true },
        { name: 'amount', label: t('Amount paid'), type: 'money' },
        { name: 'direct_currency', label: t('Currency'), type: 'select', options: curOpts(), value: 'USD', show: v => String(v.paid_from || from[0][0]).startsWith('partner:') },
        { name: 'settled_amount', label: t('What the supplier received (optional)'), type: 'money', show: v => !String(v.paid_from || from[0][0]).startsWith('partner:'),
          hint: t('When you pay in one currency and they receive another (GNF to an agent, they get USD): the difference is an exchange gain or loss.') },
        { name: 'settled_currency', label: t('in'), type: 'select', options: curOpts(), value: po.currency_code, show: v => !String(v.paid_from || from[0][0]).startsWith('partner:') },
        { name: 'occurred_on', label: t('Date'), type: 'date', value: today() },
        { name: 'note', label: t('Notes'), type: 'text' },
        { name: 'cur_hint', type: 'html', html: v => { const c = acctCur({ paid_from: v.paid_from || from[0][0] }); return c ? `<p class="hint">${esc(t('The amount is in {c}, the account’s currency.', { c }))}</p>` : ''; } }],
      run: v => PO.poPay(pid, v), done: after() });
  },
  delPoPay: (a) => confirmAction({ title: t('Remove this payment?'), text: a.dataset.k === 'cash' ? t('The money goes back into the account.') : t('It is taken off what the business owes the partner.'),
    confirm: t('Remove'), run: () => PO.poPaymentDelete(id(a.dataset.po), a.dataset.k, id(a.dataset.id)), done: after() }),
  uploadDoc: (a) => {
    const owner = a.dataset.po !== undefined ? { po_id: id(a.dataset.po) } : { shipment_id: id(a.dataset.sh) };
    openForm({ title: t('Add a document'), submit: t('Upload'),
      fields: [{ name: 'file', label: t('File'), type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx', hint: t('Up to 700 KB. A photo of a paper document is fine.') },
        { name: 'doc_type', label: t('Type'), type: 'select', options: DOC_TYPES.map(d => [d, t(d)]) }, { name: 'notes', label: t('Notes'), type: 'text' }],
      prepare: async v => {
        if (!v.file) throw Object.assign(new Error(t('Choose a file first.')), { user: true });
        const ext = extOf(v.file.name);
        if (!MIME[ext]) throw Object.assign(new Error(t('“{n}” isn’t a supported document type.', { n: v.file.name })), { user: true });
        if (v.file.size > FILE_MAX) throw Object.assign(new Error(t('“{n}” is larger than 700 KB — not saved. Send a smaller scan or photo.', { n: v.file.name })), { user: true });
        const bytes = new Uint8Array(await v.file.arrayBuffer());
        const name = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join('') + '.' + ext;
        await putBlob('files', name, { name: v.file.name, data: toBase64(bytes), bytes: bytes.length });
        v._stored = name;
      },
      run: v => PO.documentAdd({ ...owner, filename: v._stored, original_name: v.file.name, doc_type: v.doc_type, notes: v.notes }), done: after() });
  },
  openDoc: (a) => { openDocument(id(a.dataset.id)); },
  delDoc: (a) => confirmAction({ title: t('Remove this document?'), text: '', confirm: t('Remove'), run: () => PO.documentDelete(id(a.dataset.id)), done: after() }),
  // suppliers
  newSupplier: () => openForm({ title: t('New supplier'), fields: supplierFields({}), submit: t('Add'), run: v => PO.supplierNew(v), done: after() }),
  editSupplier: (a) => { const s = one(`SELECT * FROM suppliers WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Edit supplier'), fields: supplierFields(s), run: v => PO.supplierEdit(s.id, v), done: after() }); },
  delSupplier: (a) => confirmAction({ title: t('Delete this supplier?'), text: t('Only possible if they have no purchase orders.'), confirm: t('Delete'), run: () => PO.supplierDelete(id(a.dataset.id)), done: after('suppliers') }),
  // shipments
  newShipment: () => openForm({ title: t('New shipment'), fields: shipmentFields({}), submit: t('Create'), run: v => PO.shipmentNew(v), done: sid => go(`shipment/${sid}`) }),
  editShipment: (a) => { const s = one(`SELECT * FROM shipments WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Edit shipment'), fields: shipmentFields(s), run: v => PO.shipmentEdit(s.id, v), done: after() }); },
  stageShipment: (a) => {
    const s = one(`SELECT * FROM shipments WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Change stage'), fields: [{ name: 'status', label: t('Stage'), type: 'select', options: STAGES().map(x => [x.k, x.label]), value: s.status },
      { name: 'when', label: t('Date'), type: 'date', value: today() }], run: v => PO.shipmentStage(s.id, v), done: after() });
  },
  assignMix: (a) => {
    const free = all(`SELECT g.*, sup.name as supplier_name FROM po_box_groups g JOIN purchase_orders po ON po.id = g.po_id LEFT JOIN suppliers sup ON sup.id = po.supplier_id
                      WHERE g.shipment_id IS NULL AND g.received_at IS NULL ORDER BY g.po_id, g.id`);
    if (!free.length) { toast(t('Every mix not yet received is already on a shipment.')); return; }
    openForm({ title: t('Add a mix to this shipment'), submit: t('Add'),
      fields: [{ name: 'group_id', label: t('Mix'), type: 'select', options: free.map(g => [g.id, `${g.label} — PO ${poNo(g.po_id)}${g.supplier_name ? ` (${g.supplier_name})` : ''} — ${g.box_count} ${plural(g.box_count, 'box', 'boxes')}`]) }],
      run: v => PO.shipmentAssign(id(a.dataset.id), id(v.group_id)), done: after() });
  },
  unassignMix: (a) => confirmAction({ title: t('Remove this mix from the shipment?'), text: '', confirm: t('Remove'), run: () => PO.shipmentUnassign(id(a.dataset.sh), id(a.dataset.id)), done: after() }),
  receiveShipment: (a) => {
    const sid = id(a.dataset.id);
    const n = val(`SELECT COALESCE(SUM(box_count), 0) FROM po_box_groups WHERE shipment_id = ? AND received_at IS NULL`, [sid]);
    const locs = locOpts();
    openForm({ title: t('Receive the shipment?'), submit: t('Receive'), danger: false,
      intro: esc(t('{n} box(es) go into stock with their landed cost. The exchange rate of today is fixed for them.', { n })),
      fields: locs.length ? [{ name: 'location_id', label: t('Into'), type: 'select', options: locs }] : [],
      run: v => PO.shipmentReceive(sid, { location_id: id(v.location_id) }), done: after() });
  },
  // locations
  newLocation: () => openForm({ title: t('New location'), fields: locationFields({}), submit: t('Add'), run: v => PO.locationNew({ ...v, parent_id: id(v.parent_id) }), done: after() }),
  editLocation: (a) => { const l = one(`SELECT * FROM locations WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Edit location'), fields: locationFields(l, l.id), run: v => PO.locationEdit(l.id, { ...v, parent_id: id(v.parent_id) }), done: after() }); },
  placeBoxes: (a) => {
    const locs = locOpts();
    if (!locs.length) { toast(t('Add a location first.')); return; }
    const label = a.dataset.l;
    openForm({ title: label === '__all__' ? t('File every box') : t('File the boxes of {l}', { l: label }), submit: t('File'), danger: false,
      fields: [{ name: 'to_location_id', label: t('Into'), type: 'select', options: locs }],
      run: v => PO.locationsPlace({ to_location_id: id(v.to_location_id), label, po_id: label === '__all__' ? null : id(a.dataset.po) }), done: after() });
  },
  // size runs
  newRun: () => openForm({ title: t('New size run'), submit: t('Create'),
    fields: [{ name: 'name', label: t('Name'), type: 'text', placeholder: t('e.g. Men 40-46 (24 pairs)') }, { name: 'run', label: t('Sizes × pairs'), type: 'text', placeholder: '40x2, 41x3, 42x5, 43x5, 44x4, 45x3, 46x2', full: true },
      { name: 'notes', label: t('Notes'), type: 'text' }], run: v => PO.assortmentNew(v), done: after() }),
  addRunLine: (a) => openForm({ title: t('Add a size'), intro: esc(t('A size already in the run takes the new number of pairs.')),
    fields: [{ name: 'size', label: t('Size'), type: 'text' }, { name: 'qty', label: t('Pairs per box'), type: 'number', value: 1 }],
    run: v => PO.assortmentLineAdd(id(a.dataset.id), v), done: after() }),
  delRunLine: (a) => confirmAction({ title: t('Remove this size from the run?'), text: '', confirm: t('Remove'), run: () => PO.assortmentLineDelete(id(a.dataset.a), id(a.dataset.id)), done: after() }),
  delRun: (a) => confirmAction({ title: t('Delete this size run?'), text: t('Purchase orders that used it keep their sizes.'), confirm: t('Delete'), run: () => PO.assortmentDelete(id(a.dataset.id)), done: after() }),
  // price list
  setPrice: (a) => {
    const po = a.dataset.po === '' ? null : id(a.dataset.po), label = a.dataset.l;
    const base = one(`SELECT * FROM price_tiers WHERE source_po_id IS ? AND source_label = ? AND min_boxes = 1`, [po, label]);
    const isBase = a.dataset.min === '1';
    openForm({ title: isBase ? t('1-box price — {l}', { l: label }) : t('Quantity price — {l}', { l: label }),
      intro: isBase ? '' : esc(t('From this number of boxes, each pair costs less. Same currency as the 1-box price ({c}).', { c: base ? base.currency_code : '' })),
      fields: [...(isBase ? [] : [{ name: 'min_boxes', label: t('From (boxes)'), type: 'number', value: 2 }]),
        { name: 'price_per_pair', label: t('Price per pair'), type: 'money', value: isBase && base ? base.price_per_pair : '' },
        ...(isBase ? [{ name: 'currency_code', label: t('Currency'), type: 'select', options: curOpts(), value: base ? base.currency_code : 'GNF' }] : []),
        { name: 'notes', label: t('Notes'), type: 'text', value: isBase && base ? base.notes || '' : '' }],
      run: v => PO.priceTierSet({ ...v, po_id: po, label, min_boxes: isBase ? 1 : v.min_boxes }), done: after() });
  },
  delTier: (a) => confirmAction({ title: t('Remove this price?'), text: '', confirm: t('Remove'), run: () => PO.priceTierDelete(id(a.dataset.id)), done: after() }),
  priceCsv: () => {
    const rows = [['mix', 'po', 'styles', 'photos', 'pairs_per_box', 'in_stock', 'from_boxes', 'to_boxes', 'currency', 'price_per_pair', 'price_per_box']];
    for (const m of priceList()) {
      if (!m.price) continue;
      for (const tr of m.tiers) rows.push([m.source_label, m.source_po_id === null ? '' : Q.poRef(m.source_po_id), m.styles.map(s => `${s.name} ${s.color || ''}`.trim()).join('; '),
        m.styles.filter(s => s.image).map(s => s.image).join('; '), m.pairs_per_box, m.available, tr.min_boxes, tr.max_boxes || '', tr.currency_code, tr.price_per_pair, pyRound(tr.box_price, 2)]);
    }
    downloadText(`liste_de_prix_${today()}.csv`, '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
  }
});
void fmtShort;

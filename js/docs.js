// Documents customers receive, always in French: invoices and statements of account.
// Shown inside the app with a Print button (print or save as PDF from the phone's share sheet).
import { all, one } from './localdb.js';
import * as Q from './queries.js';
import { withLang } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtDate, sum } from './util.js';
import { getBlob } from './store.js';
import { priceList } from './buy.js';

const day = s => { const d = String(s || '').slice(0, 10).split('-'); return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(s || ''); };
const STATUS = { paid: 'Payée', partial: 'Partiellement payée', unpaid: 'Impayée', void: 'Annulée', unpriced: 'Sans prix' };

// app._order_document_lines — box lines described with their styles and size run.
function documentLines(orderId) {
  const items = all(`SELECT oi.*, p.name as product_name, v.color, v.size, v.sku FROM order_items oi JOIN variants v ON v.id = oi.variant_id
                     JOIN products p ON p.id = v.product_id WHERE oi.order_id = ? AND oi.box_id IS NULL ORDER BY p.name, v.size`, [orderId]);
  const boxLines = Q.orderBoxLines(orderId).map(l => {
    const sample = one(`SELECT id FROM boxes WHERE source_po_id IS ? AND source_label = ? LIMIT 1`, [l.source_po_id, l.source_label]);
    const contents = sample ? Q.boxContents(sample.id) : [];
    const styles = [], bySize = new Map();
    for (const c of contents) {
      const n = c.product_name + (c.color ? ' ' + c.color : '');
      if (!styles.includes(n)) styles.push(n);
      bySize.set(c.size, (bySize.get(c.size) || 0) + c.qty);
    }
    const run = [...bySize.entries()].sort((a, b) => (String(a[0]).length - String(b[0]).length) || (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))
      .map(([s, q]) => `${s}×${q}`).join(', ');
    return { ...l, styles: styles.join(', ') || l.source_label, size_run: run, gross: l.qty_boxes * l.price_per_box };
  });
  return [boxLines, items];
}

function invoiceDoc(invoiceId) {
  const inv = one(`SELECT i.*, o.id as order_id, c.name as customer_name, c.email as customer_email, c.phone as customer_phone, c.address as customer_address
                   FROM invoices i JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = o.customer_id WHERE i.id = ?`, [invoiceId]);
  if (!inv) return '<p>—</p>';
  const [boxLines, items] = documentLines(inv.order_id);
  const fin = Q.invoiceFinancials(invoiceId);
  const cur = fin.currency_code;
  const m = v => esc(fmtMoney(v, cur));
  const subtotal = sum(items, i => i.qty * i.unit_price) + sum(boxLines, b => b.gross);
  const pays = all(`SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_at`, [invoiceId]);
  return `<div class="dh"><div><h1>Facture ${esc(inv.invoice_number)}</h1><div class="mono">Émise le ${esc(day(inv.issued_at))}</div></div><span class="pill">${esc(STATUS[fin.status] || fin.status)}</span></div>
    <div class="parties"><div><div class="lbl">Facturé à</div><b>${esc(inv.customer_name || 'Client de passage')}</b>
      ${[inv.customer_email, inv.customer_phone, inv.customer_address].filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('')}</div>
      <div style="text-align:right"><div class="lbl">Commande</div><div>#${esc(Q.orderRef(inv.order_id))}</div></div></div>
    ${boxLines.length ? `<table><thead><tr><th>Description</th><th class="r">Cartons</th><th class="r">Prix / paire</th><th class="r">Prix / carton</th><th class="r">Total</th></tr></thead><tbody>
      ${boxLines.map(b => `<tr><td>${esc(b.styles)}<div style="font-size:11px;color:#666">${b.pairs_per_box} paires par carton · ${esc(b.size_run)}</div></td>
        <td class="r">${b.qty_boxes}</td><td class="r">${b.price_per_pair ? m(b.price_per_pair) : '—'}</td><td class="r">${m(b.price_per_box)}</td><td class="r">${m(b.gross)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${items.length ? `<table><thead><tr><th>Réf.</th><th>Description</th><th>Pointure</th><th class="r">Qté</th><th class="r">Prix / paire</th><th class="r">Total</th></tr></thead><tbody>
      ${items.map(i => `<tr><td class="mono">${esc(i.sku)}</td><td>${esc(i.product_name)}${i.color ? ' ' + esc(i.color) : ''}</td><td>${esc(i.size)}</td><td class="r">${i.qty}</td><td class="r">${m(i.unit_price)}</td><td class="r">${m(i.qty * i.unit_price)}</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="tot"><div><span>Sous-total</span><span>${m(subtotal)}</span></div>
      ${fin.return_credit ? `<div><span>Retours crédités</span><span>−${m(fin.return_credit)}</span></div>` : ''}
      <div><span>Montant dû</span><span>${m(fin.due)}</span></div>
      ${fin.paid ? `<div><span>Payé</span><span>−${m(fin.paid)}</span></div>` : ''}
      <div class="g"><span>Solde</span><span>${m(fin.balance)}</span></div></div>
    ${pays.length ? `<div class="lbl" style="margin-top:20px">Historique des paiements</div><table><thead><tr><th>Date</th><th class="r">Montant</th><th>Note</th></tr></thead><tbody>
      ${pays.map(p => `<tr><td>${esc(day(p.paid_at))}</td><td class="r">${m(p.amount)}</td><td>${esc(p.note || '—')}</td></tr>`).join('')}</tbody></table>` : ''}`;
}

function statementDoc(customerId) {
  const c = one(`SELECT * FROM customers WHERE id = ?`, [customerId]);
  if (!c) return '<p>—</p>';
  const s = Q.customerSummary(customerId);
  const led = Q.customerLedger(customerId);
  const ref = e => e.kind === 'invoice' ? `Facture ${esc(e.label)} <span style="color:#666">— ${e.boxes ? `${e.boxes} carton(s)` : 'paires au détail'}</span>`
    : e.kind === 'payment' ? `Paiement <span style="color:#666">— ${esc(e.label)}${e.cancelled ? ' (annulée)' : ''}${e.note ? ' — ' + esc(e.note) : ''}</span>`
      : `Retour <span style="color:#666">— ${e.qty} retourné(s)${e.note ? ' — ' + esc(e.note) : ''}</span>`;
  return `<div class="dh"><div><h1>Relevé de compte</h1><div class="mono">Au ${esc(day(new Date().toISOString()))}</div></div></div>
    <div class="parties"><div><div class="lbl">Pour</div><b>${esc(c.name)}</b>${[c.email, c.phone, c.address].filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('')}</div></div>
    ${led.length ? `<table><thead><tr><th>Date</th><th>Référence</th><th class="r">Débit</th><th class="r">Paiement / avoir</th><th class="r">Solde</th></tr></thead><tbody>
      ${led.map(e => `<tr><td>${esc(day(e.when))}</td><td>${ref(e)}</td><td class="r">${e.charge ? esc(fmtMoney(e.charge, e.currency_code)) : ''}</td>
        <td class="r">${e.payment ? esc(fmtMoney(e.payment, e.currency_code)) : ''}</td><td class="r">${esc(fmtMoney(e.balance, e.currency_code))}</td></tr>`).join('')}</tbody></table>
    <div class="tot"><div><span>Total facturé</span><span>${esc(fmtUsd(s.lifetime_sold_usd))}</span></div><div><span>Total payé</span><span>−${esc(fmtUsd(s.lifetime_paid_usd))}</span></div>
      <div class="g"><span>Solde dû</span><span>${esc(fmtUsd(s.outstanding_usd))}</span></div></div>
    ${s.days_outstanding !== null ? `<p style="color:#666;font-size:12px">La plus ancienne facture impayée date de ${s.days_outstanding} jour(s).</p>` : ''}` : '<p>Aucune opération sur ce compte pour le moment.</p>'}`;
}

// The price list customers receive (price_list_print.html): priced mixes in stock, with photos.
function priceListDoc() {
  const mixes = priceList().filter(m => m.price);
  if (!mixes.length) return '<p>Aucun prix n’est encore fixé.</p>';
  return `<div class="dh"><div><h1>Liste de prix</h1><div class="mono">Au ${esc(day(new Date().toISOString()))} · prix par paire · sous réserve de disponibilité</div></div></div>
    ${mixes.map(m => {
      const photos = m.styles.filter(st => st.image);
      return `<div class="plmix"><h2>${esc(m.source_label)}</h2><div class="meta">${esc(m.styles.map(st => st.name + (st.color ? ' — ' + st.color : '')).join(', '))}</div>
        <table class="facts"><tr><th>Paires par carton</th><th>Pointures</th><th class="r">Cartons disponibles</th></tr>
          <tr><td class="mono">${m.pairs_per_box}</td><td class="mono">${esc(m.size_run)}</td><td class="mono r">${m.available}</td></tr></table>
        ${photos.length ? `<div class="photos">${photos.map(st => `<figure><img data-img="${esc(st.image)}" alt="${esc(st.name)}"><figcaption>${esc(st.name)}${st.color ? ' — ' + esc(st.color) : ''}</figcaption></figure>`).join('')}</div>` : ''}
        <table><thead><tr>${m.tiers.length > 1 ? '<th>Cartons</th>' : ''}<th>Par paire</th><th class="r">Par carton (${m.pairs_per_box} paires)</th></tr></thead><tbody>
          ${m.tiers.map(tr => `<tr>${m.tiers.length > 1 ? `<td class="mono">${tr.max_boxes ? (tr.max_boxes !== tr.min_boxes ? `${tr.min_boxes} – ${tr.max_boxes}` : tr.min_boxes) : `${tr.min_boxes} et plus`}</td>` : ''}
            <td class="mono">${esc(fmtMoney(tr.price_per_pair, tr.currency_code))}</td><td class="mono r">${esc(fmtMoney(tr.box_price, tr.currency_code))}</td></tr>`).join('')}</tbody></table></div>`;
    }).join('')}`;
}
// Photos in a document are fetched from their own documents once it is on screen.
export async function mountDoc() {
  for (const img of document.querySelectorAll('.doc img[data-img]')) {
    const d = await getBlob('images', img.dataset.img);
    if (d && d.data) img.src = d.data; else img.closest('figure')?.remove();
  }
}

export function renderDoc(kind, idRaw) {
  if (kind === 'pricelist') return `<div class="docbar"><a class="backlink" href="#/pricelist">‹ Retour</a><button class="btn primary" onclick="window.print()">Imprimer / PDF</button></div><div class="doc">${withLang('fr', priceListDoc)}</div>`;
  const id = /^\d+$/.test(idRaw) ? Number(idRaw) : idRaw;
  const back = kind === 'invoice' ? `order/${(one(`SELECT order_id FROM invoices WHERE id = ?`, [id]) || {}).order_id}` : `customer/${id}`;
  const body = withLang('fr', () => kind === 'invoice' ? invoiceDoc(id) : statementDoc(id));
  return `<div class="docbar"><a class="backlink" href="#/${esc(back)}">‹ Retour</a><button class="btn primary" onclick="window.print()">Imprimer / PDF</button></div><div class="doc">${body}</div>`;
}

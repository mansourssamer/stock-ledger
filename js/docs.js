// Documents customers receive, always in French: invoices and statements of account.
// Shown inside the app with a Print button (print or save as PDF from the phone's share sheet).
import { all, one } from './localdb.js';
import * as Q from './queries.js';
import { documentLines } from './queries.js';
import { withLang, lang as appLang } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtDate, sum } from './util.js';
import { getBlob } from './store.js';
import { priceList } from './buy.js';
import { proformaDoc } from './crmpages.js';
import { stockDocHtml, stockPdf, stockText, loadPdfLib, pdfReady } from './stockdoc.js';
import { schedule } from './app.js';
import { registerActions } from './actions.js';

const day = s => { const d = String(s || '').slice(0, 10).split('-'); return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(s || ''); };
const STATUS = { paid: 'Payée', partial: 'Partiellement payée', unpaid: 'Impayée', void: 'Annulée', unpriced: 'Sans prix' };


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
  const led = Q.statementLines(customerId);
  // what the customer took on each invoice (and gave back on a return), model by model
  const fr = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const what = i => i.kind === 'box' ? `${fr(i.qty, 'carton', 'cartons')} · ${esc(i.name)}${i.sizes ? ` (${esc(i.sizes)})` : ''}`
    : `${fr(i.qty, 'paire', 'paires')} · ${esc(i.name)}${i.color ? ` ${esc(i.color)}` : ''}, pointure ${esc(i.size)}`;
  const lines = items => items.length ? `<div class="items">${items.map(i => `<div>${what(i)}</div>`).join('')}</div>` : '';
  const back = e => { const w = Q.returnedWhat(e.box_line_id, e.variant_id); return w ? ` · ${esc(w.name)}${w.sizes ? ` (${esc(w.sizes)})` : ''}${w.size ? `, pointure ${esc(w.size)}` : ''}` : ''; };
  const ref = e => e.kind === 'invoice' ? `Facture ${esc(e.label)} <span style="color:#666">— ${e.boxes ? `${e.boxes} carton(s)` : 'paires au détail'}</span>${lines(Q.orderContents(e.order_id))}`
    : e.kind === 'payment' ? (e.labels.length > 1
      ? `Paiement${e.cancelled ? ' <span style="color:#666">(annulée)</span>' : ''}${e.notes.length ? ` <span style="color:#666">— ${esc(e.notes.join(' · '))}</span>` : ''}<div class="items">Réparti sur ${e.labels.length} factures : ${e.labels.slice().sort((a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true })).map(l => `<span style="white-space:nowrap">${esc(l)}</span>`).join(', ')}</div>`
      : `Paiement <span style="color:#666">— ${esc(e.labels[0])}${e.cancelled ? ' (annulée)' : ''}${e.notes.length ? ' — ' + esc(e.notes.join(' · ')) : ''}</span>`)
      : `Retour <span style="color:#666">— ${e.qty} retourné(s)${back(e)}${e.note ? ' — ' + esc(e.note) : ''}</span>`;
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
  if (document.querySelector('[data-act="stockPdfSend"]')) loadPdfLib().catch(e => console.warn(e));   // ready before the tap
  for (const img of document.querySelectorAll('.doc img[data-img]')) {
    const d = await getBlob('images', img.dataset.img);
    if (d && d.data) img.src = d.data; else img.closest('figure')?.remove();
  }
}

export function renderDoc(kind, idRaw) {
  const id = /^\d+$/.test(idRaw) ? Number(idRaw) : idRaw;
  if (kind === 'proforma') {
    const pf = one(`SELECT order_id FROM proformas WHERE id = ?`, [id]);
    return `<div class="docbar"><a class="backlink" href="#/${pf && pf.order_id !== null ? 'order/' + esc(pf.order_id) : 'proformas'}">‹ Retour</a><button class="btn primary" onclick="window.print()">Imprimer / PDF</button></div><div class="doc">${proformaDoc(id)}</div>`;
  }
  if (kind === 'stock') {
    const L = stockLang(), T = stockText(L);
    return `<div class="docbar"><a class="backlink" href="#/stock">${esc(T.back)}</a>
      <div class="chips"><button type="button" class="chip" data-act="stockDocLang" data-v="fr" aria-pressed="${L === 'fr'}">Français</button><button type="button" class="chip" data-act="stockDocLang" data-v="en" aria-pressed="${L === 'en'}">English</button></div>
      <button class="btn primary" data-act="stockPdfSend">${esc(T.send)}</button><button class="btn" data-act="stockPdfSave">${esc(T.save)}</button><button class="btn" onclick="window.print()">${esc(T.print)}</button></div>
      <div class="doc">${stockDocHtml(L)}</div>`;
  }
  if (kind === 'pricelist') return `<div class="docbar"><a class="backlink" href="#/pricelist">‹ Retour</a><button class="btn primary" onclick="window.print()">Imprimer / PDF</button></div><div class="doc">${withLang('fr', priceListDoc)}</div>`;
  const back = kind === 'invoice' ? `order/${(one(`SELECT order_id FROM invoices WHERE id = ?`, [id]) || {}).order_id}` : `customer/${id}`;
  const body = withLang('fr', () => kind === 'invoice' ? invoiceDoc(id) : statementDoc(id));
  return `<div class="docbar"><a class="backlink" href="#/${esc(back)}">‹ Retour</a><button class="btn primary" onclick="window.print()">Imprimer / PDF</button></div><div class="doc">${body}</div>`;
}

// Send the stock document as a PDF: the phone's share sheet (WhatsApp, mail…) where there is one,
// otherwise the file is downloaded.
const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// The stock document's language: French or English, remembered on this device; at first the app's.
let docLang = null;
function stockLang() {
  if (!docLang) { try { docLang = localStorage.getItem('sl-stockdoc-lang'); } catch { /* private mode */ } }
  return docLang === 'en' || docLang === 'fr' ? docLang : (appLang() === 'en' ? 'en' : 'fr');
}
function sendStockPdf(share) {
  if (!pdfReady()) { toast('Préparation du PDF… réessayez dans un instant.'); loadPdfLib().catch(e => toast(e.message)); return; }
  let file;
  try { file = stockPdf(stockLang()); } catch (e) { console.error(e); toast('Le PDF n’a pas pu être créé : ' + (e.message || e)); return; }
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: stockText(stockLang()).share }).catch(e => { if (!e || e.name !== 'AbortError') downloadFile(file); });
    return;
  }
  downloadFile(file);
}
registerActions({
  stockPdfSend: () => sendStockPdf(true), stockPdfSave: () => sendStockPdf(false),
  stockDocLang: a => { docLang = a.dataset.v; try { localStorage.setItem('sl-stockdoc-lang', docLang); } catch { /* private mode */ } schedule(); }
});

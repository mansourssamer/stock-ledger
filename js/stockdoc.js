// "État du stock — vendu et reste": the Stock page's figures as a document to print or send as a
// PDF (always in French, like every document). The PDF is drawn with jsPDF, loaded only when
// the document is opened, so the share sheet can open straight from the tap.
import { all } from './localdb.js';
import { modelSales } from './stockdata.js';
import { esc, fmtNum } from './util.js';

const today = () => new Date().toISOString().slice(0, 10);
const frDate = d => { const [y, m, j] = d.split('-'); return `${j}/${m}/${y}`; };
// French number spacing, with plain spaces: the PDF's built-in font has no narrow spaces.
const n = v => fmtNum(v || 0).replace(/[  ]/g, ' ');

export function stockReport() {
  const ms = modelSales();
  const rows = all(`SELECT id, name, brand FROM products ORDER BY name`).map(p => {
    const m = ms.get(p.id) || {};
    const r = { name: String(p.name).trim(), brand: p.brand || '', received: m.boxes_received || 0, sold: m.boxes_sold || 0, sold_pairs: m.pairs_sold || 0,
      left: m.boxes_left || 0, left_pairs: m.pairs_left || 0, open: m.boxes_open || 0, reserved: m.boxes_reserved || 0 };
    r.pct = r.received ? Math.round(r.sold / r.received * 100) : null;
    r.note = [r.open ? `${r.open} ouvert(s)` : '', r.reserved ? `${r.reserved} sur commandes` : ''].filter(Boolean).join(' · ');
    return r;
  }).filter(r => r.received || r.sold_pairs || r.left_pairs);
  const tot = { received: 0, sold: 0, sold_pairs: 0, left: 0, left_pairs: 0, open: 0, reserved: 0 };
  for (const r of rows) for (const k of Object.keys(tot)) tot[k] += r[k];
  tot.pct = tot.received ? Math.round(tot.sold / tot.received * 100) : null;
  tot.note = [tot.open ? `${tot.open} ouvert(s)` : '', tot.reserved ? `${tot.reserved} sur commandes` : ''].filter(Boolean).join(' · ');
  return { date: today(), rows, tot };
}
const pct = v => (v === null ? '—' : `${v} %`);

export function stockDocHtml() {
  const { date, rows, tot } = stockReport();
  if (!rows.length) return '<p>Aucun stock pour l’instant.</p>';
  const tr = (r, b) => `<tr${b ? ' class="tot"' : ''}><td>${b ? '<b>Total</b>' : `<b>${esc(r.name)}</b>${r.brand ? `<div class="meta">${esc(r.brand)}</div>` : ''}`}</td>
    <td class="r mono">${n(r.received)}</td><td class="r mono">${n(r.sold)}</td><td class="r mono">${n(r.sold_pairs)}</td>
    <td class="r mono">${n(r.left)}</td><td class="r mono">${n(r.left_pairs)}</td><td class="r mono">${pct(r.pct)}</td><td class="meta">${esc(r.note)}</td></tr>`;
  return `<div class="dh"><div><h1>État du stock — vendu et reste</h1><div class="mono">Au ${frDate(date)} · ventes livrées, retours déduits</div></div></div>
    <table><thead><tr><th>Modèle</th><th class="r">Reçu<br>cartons</th><th class="r">Vendu<br>cartons</th><th class="r">Vendu<br>paires</th>
      <th class="r">Reste<br>cartons</th><th class="r">Reste<br>paires</th><th class="r">% vendu</th><th>Note</th></tr></thead>
      <tbody>${rows.map(r => tr(r)).join('')}${tr(tot, true)}</tbody></table>
    <p class="meta">« Reste » : cartons fermés en stock ; les paires comprennent les cartons ouverts. « Sur commandes » : cartons sur des commandes pas encore livrées.</p>`;
}

// ---------- the PDF ----------
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Impossible de charger ' + src));
    document.head.appendChild(s);
  });
}
let loading = null;
export function loadPdfLib() {
  if (!loading) loading = (async () => {
    if (!window.jspdf) await loadScript('vendor/jspdf.umd.min.js');
    if (!window.jspdf.jsPDF.API.autoTable) await loadScript('vendor/jspdf.plugin.autotable.min.js');
    return window.jspdf.jsPDF;
  })().catch(e => { loading = null; throw e; });
  return loading;
}
export const pdfReady = () => !!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable);

// Builds the PDF at once (no waiting), so it can go straight to the share sheet.
export function stockPdf() {
  const { date, rows, tot } = stockReport();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  doc.text('État du stock — vendu et reste', 40, 50);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(100);
  doc.text(`Au ${frDate(date)} · ventes livrées, retours déduits`, 40, 66);
  doc.setDrawColor(28, 37, 48); doc.setLineWidth(1.2); doc.line(40, 76, W - 40, 76);
  const line = r => [r.name, n(r.received), n(r.sold), n(r.sold_pairs), n(r.left), n(r.left_pairs), pct(r.pct), r.note];
  doc.autoTable({
    startY: 88, margin: { left: 40, right: 40, bottom: 46 },
    head: [['Modèle', 'Reçu\ncartons', 'Vendu\ncartons', 'Vendu\npaires', 'Reste\ncartons', 'Reste\npaires', '% vendu', 'Note']],
    body: rows.map(line),
    foot: [['Total', ...line(tot).slice(1)]],
    showFoot: 'lastPage',
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4, textColor: [28, 37, 48], lineColor: [220, 214, 201], lineWidth: 0.4 },
    headStyles: { fillColor: [28, 37, 48], textColor: 255, fontStyle: 'bold', fontSize: 7.5, halign: 'right' },
    footStyles: { fillColor: [238, 234, 225], textColor: [28, 37, 48], fontStyle: 'bold', halign: 'right' },
    alternateRowStyles: { fillColor: [249, 247, 243] },
    columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 150 }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' },
      5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'left', fontSize: 7.5, textColor: [100, 100, 100] } },
    didParseCell: d => {
      if ((d.section === 'head' || d.section === 'foot') && (d.column.index === 0 || d.column.index === 7)) d.cell.styles.halign = 'left';
      if (d.section === 'foot' && d.column.index === 7) d.cell.styles.fontSize = 7.5;
    },
    didDrawPage: () => {
      const H = doc.internal.pageSize.getHeight();
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text(`État du stock au ${frDate(date)}`, 40, H - 26);
      doc.text(`Page ${doc.internal.getNumberOfPages()}`, W - 40, H - 26, { align: 'right' });
    }
  });
  const y = doc.lastAutoTable.finalY + 16;
  doc.setFontSize(8); doc.setTextColor(100);
  doc.text(doc.splitTextToSize('« Reste » : cartons fermés en stock ; les paires comprennent aussi les cartons ouverts. « Sur commandes » : cartons sur des commandes pas encore livrées.', W - 80), 40, y);
  const name = `etat-du-stock-${date}.pdf`;
  return new File([doc.output('blob')], name, { type: 'application/pdf' });
}

// "État du stock — vendu et reste" / "Stock — sold and left": the Stock page's figures as a
// document to print or send as a PDF, in French or English (it's for you and your partners, not
// for customers). The PDF is drawn with jsPDF, loaded only when the document is opened, so the
// share sheet can open straight from the tap.
import { all } from './localdb.js';
import { modelSales, mixBreakdown } from './stockdata.js';
import { esc, fmtNum } from './util.js';

const today = () => new Date().toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TX = {
  fr: {
    title: 'État du stock — vendu et reste', sub: d => `Au ${d} · ventes livrées, retours déduits`,
    date: d => { const [y, m, j] = d.split('-'); return `${j}/${m}/${y}`; },
    // French number spacing, with plain spaces: the PDF's built-in font has no narrow spaces
    num: v => fmtNum(v || 0).replace(/[  ]/g, ' '), pct: v => (v === null ? '—' : `${v} %`),
    cols: ['Modèle', 'Reçu\ncartons', 'Vendu\ncartons', 'Vendu\npaires', 'Reste\ncartons', 'Reste\npaires', '% vendu', 'Note'],
    total: 'Total', open: k => `${k} ouvert(s)`, onOrders: k => `${k} sur commandes`, empty: 'Aucun stock pour l’instant.',
    note: '« Reste » : cartons fermés en stock ; les paires comprennent aussi les cartons ouverts. « Sur commandes » : cartons sur des commandes pas encore livrées.',
    footer: d => `État du stock au ${d}`, page: k => `Page ${k}`, file: d => `etat-du-stock-${d}.pdf`, share: 'État du stock',
    send: 'Envoyer le PDF', save: 'Télécharger le PDF', print: 'Imprimer', back: '‹ Retour'
  },
  en: {
    title: 'Stock — sold and left', sub: d => `As of ${d} · delivered sales, returns deducted`,
    date: d => { const [y, m, j] = d.split('-'); return `${Number(j)} ${MONTHS[Number(m) - 1]} ${y}`; },
    num: v => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v || 0), pct: v => (v === null ? '—' : `${v}%`),
    cols: ['Model', 'Received\nboxes', 'Sold\nboxes', 'Sold\npairs', 'Left\nboxes', 'Left\npairs', '% sold', 'Note'],
    total: 'Total', open: k => `${k} open`, onOrders: k => `${k} on orders`, empty: 'No stock yet.',
    note: '“Left”: sealed boxes in stock; the pairs also include open boxes. “On orders”: boxes on orders not delivered yet.',
    footer: d => `Stock as of ${d}`, page: k => `Page ${k}`, file: d => `stock-sold-left-${d}.pdf`, share: 'Stock — sold and left',
    send: 'Send the PDF', save: 'Download the PDF', print: 'Print', back: '‹ Back'
  }
};
export const stockText = lang => TX[lang] || TX.fr;

export function stockReport(lang = 'fr') {
  const T = stockText(lang);
  const ms = modelSales();
  const mixes = mixBreakdown();
  const noteOf = r => [r.open ? T.open(r.open) : '', r.reserved ? T.onOrders(r.reserved) : ''].filter(Boolean).join(' · ');
  const rows = all(`SELECT id, name, brand FROM products ORDER BY name`).map(p => {
    const m = ms.get(p.id) || {};
    const mx = mixes.get(p.id) || [];
    const r = { name: String(p.name).trim(), brand: p.brand || '', received: m.boxes_received || 0, sold: m.boxes_sold || 0, sold_pairs: m.pairs_sold || 0,
      left: m.boxes_left || 0, left_pairs: m.pairs_left || 0, open: m.boxes_open || 0, reserved: m.boxes_reserved || 0,
      sizes: mx.length === 1 ? mx[0].name : '',
      // two or more mixes of the model (an M and an L…): a line for each
      mixes: mx.length > 1 ? mx.map(x => {
        const y = { name: x.name, received: x.received, sold: x.boxes_sold, sold_pairs: x.pairs_sold, left: x.boxes_left, left_pairs: x.pairs_left, open: x.boxes_open, reserved: x.boxes_reserved };
        y.pct = y.received ? Math.round(y.sold / y.received * 100) : null; y.note = noteOf(y);
        return y;
      }) : [] };
    r.pct = r.received ? Math.round(r.sold / r.received * 100) : null;
    r.note = noteOf(r);
    return r;
  }).filter(r => r.received || r.sold_pairs || r.left_pairs);
  const tot = { received: 0, sold: 0, sold_pairs: 0, left: 0, left_pairs: 0, open: 0, reserved: 0 };
  for (const r of rows) for (const k of Object.keys(tot)) tot[k] += r[k];
  tot.pct = tot.received ? Math.round(tot.sold / tot.received * 100) : null;
  tot.note = [tot.open ? T.open(tot.open) : '', tot.reserved ? T.onOrders(tot.reserved) : ''].filter(Boolean).join(' · ');
  return { date: today(), rows, tot };
}

export function stockDocHtml(lang = 'fr') {
  const T = stockText(lang), n = T.num;
  const { date, rows, tot } = stockReport(lang);
  if (!rows.length) return `<p>${esc(T.empty)}</p>`;
  const nums = r => `<td class="r mono">${n(r.received)}</td><td class="r mono">${n(r.sold)}</td><td class="r mono">${n(r.sold_pairs)}</td>
    <td class="r mono">${n(r.left)}</td><td class="r mono">${n(r.left_pairs)}</td><td class="r mono">${T.pct(r.pct)}</td><td class="meta">${esc(r.note)}</td>`;
  const tr = (r, b) => `<tr${b ? ' class="tot"' : ''}><td>${b ? `<b>${esc(T.total)}</b>` : `<b>${esc(r.name)}</b>${r.brand || r.sizes ? `<div class="meta">${esc([r.brand, r.sizes].filter(Boolean).join(' · '))}</div>` : ''}`}</td>${nums(r)}</tr>`
    + (b ? '' : r.mixes.map(x => `<tr class="mix"><td>↳ ${esc(x.name)}</td>${nums(x)}</tr>`).join(''));
  return `<div class="dh"><div><h1>${esc(T.title)}</h1><div class="mono">${esc(T.sub(T.date(date)))}</div></div></div>
    <table><thead><tr>${T.cols.map((c, i) => `<th${i && i < 7 ? ' class="r"' : ''}>${c.split('\n').map(esc).join('<br>')}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => tr(r)).join('')}${tr(tot, true)}</tbody></table>
    <p class="meta">${esc(T.note)}</p>`;
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
export function stockPdf(lang = 'fr') {
  const T = stockText(lang), n = T.num;
  const { date, rows, tot } = stockReport(lang);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  doc.text(T.title, 40, 50);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(100);
  doc.text(T.sub(T.date(date)), 40, 66);
  doc.setDrawColor(28, 37, 48); doc.setLineWidth(1.2); doc.line(40, 76, W - 40, 76);
  const line = (r, name = r.name) => [name, n(r.received), n(r.sold), n(r.sold_pairs), n(r.left), n(r.left_pairs), T.pct(r.pct), r.note];
  const body = [], mixRows = new Set();
  for (const r of rows) {
    body.push(line(r, r.sizes ? `${r.name} (${r.sizes})` : r.name));
    for (const x of r.mixes) { mixRows.add(body.length); body.push(line(x, `     ${x.name}`)); }
  }
  doc.autoTable({
    startY: 88, margin: { left: 40, right: 40, bottom: 46 },
    head: [T.cols],
    body,
    foot: [[T.total, ...line(tot).slice(1)]],
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
      if (d.section === 'body' && mixRows.has(d.row.index)) { d.cell.styles.fontSize = 7.8; d.cell.styles.textColor = [80, 90, 100]; if (d.column.index === 0) d.cell.styles.fontStyle = 'normal'; }
    },
    didDrawPage: () => {
      const H = doc.internal.pageSize.getHeight();
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text(T.footer(T.date(date)), 40, H - 26);
      doc.text(T.page(doc.internal.getNumberOfPages()), W - 40, H - 26, { align: 'right' });
    }
  });
  const y = doc.lastAutoTable.finalY + 16;
  doc.setFontSize(8); doc.setTextColor(100);
  doc.text(doc.splitTextToSize(T.note, W - 80), 40, y);
  return new File([doc.output('blob')], T.file(date), { type: 'application/pdf' });
}

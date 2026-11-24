// Any customer document on screen (invoice, statement, proforma, price list) as a real PDF file,
// built from what is shown: titles, the two-column headers, tables, totals and photos. Phones'
// home-screen apps often can't print, so this is what "Send" and "Download" use.
// Needs jsPDF + AutoTable loaded (loadPdfLib in stockdoc.js); builds at once, no waiting.

const INK = [28, 37, 48], GREY = [102, 102, 102], SOFT = [74, 85, 96], LINE = [220, 214, 201];
const BLOCK = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'FIGURE', 'UL', 'OL', 'LI', 'SECTION']);
// The PDF's built-in font knows Latin-1 and a few more signs (— – ’ “ ” … • €); the rest is replaced.
const EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const SWAP = { ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '−': '-', '‐': '-', '‑': '-', '↳': '', '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '✓': 'v', '✗': 'x' };
export function pdfText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (ch in SWAP) { out += SWAP[ch]; continue; }
    const c = ch.codePointAt(0);
    if (c < 256 || EXTRA.has(ch)) { out += ch; continue; }
    const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += plain.length && [...plain].every(x => x.codePointAt(0) < 256) ? plain : '?';
  }
  return out;
}
const hidden = el => el.nodeType === 1 && getComputedStyle(el).display === 'none';
const kidsOf = el => [...el.childNodes].filter(n => n.nodeType === 1 ? !hidden(n) && n.tagName !== 'BR' : n.nodeType === 3 && n.textContent.trim());
const hasBlock = el => kidsOf(el).some(n => n.nodeType === 1 && BLOCK.has(n.tagName));
const textOf = el => (el.nodeType === 3 ? el.textContent : el.innerText || el.textContent || '').replace(/[ \t]+/g, ' ').trim();
const px = v => parseFloat(v) || 0;

function styleOf(el) {
  if (el.nodeType !== 1) return { size: 9.5 };
  const cl = el.classList, tag = el.tagName;
  if (tag === 'H1') return { size: 17, bold: true };
  if (tag === 'H2') return { size: 12.5, bold: true };
  if (tag === 'H3') return { size: 11, bold: true };
  if (cl.contains('lbl')) return { size: 7.2, color: GREY, upper: true };
  if (cl.contains('pill') || cl.contains('stamp')) return { size: 9, bold: true, color: cl.contains('stamp') ? [176, 58, 46] : INK };
  if (cl.contains('mono') || cl.contains('meta')) return { size: 8.6, color: GREY };
  const cs = getComputedStyle(el);
  const size = Math.max(7, Math.min(10.5, px(cs.fontSize) * 0.72));
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color);
  const color = m ? [+m[1], +m[2], +m[3]] : INK;
  return { size, bold: tag === 'B' || tag === 'STRONG' || +cs.fontWeight >= 600, color: color.every(c => c > 200) ? INK : color };
}

// The lines of a block (header column, note…), each with its style.
function linesOf(el, out = []) {
  if (el.nodeType === 3) { const s = textOf(el); if (s) out.push({ text: s, st: { size: 9.5 } }); return out; }
  if (hidden(el) || el.tagName === 'IMG') return out;
  if (!hasBlock(el)) {
    const st = styleOf(el);
    for (const part of (el.innerText || el.textContent || '').split('\n')) { const s = part.replace(/[ \t]+/g, ' ').trim(); if (s) out.push({ text: s, st }); }
    return out;
  }
  for (const k of kidsOf(el)) linesOf(k, out);
  return out;
}

export function domPdf(root, fileName, title = '') {
  const { jsPDF } = window.jspdf;
  let doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 40, CW = W - 2 * M, BOTTOM = H - 50;
  let y = M;
  const room = h => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const font = st => {
    doc.setFont('helvetica', st.bold ? 'bold' : 'normal'); doc.setFontSize(st.size); doc.setTextColor(...(st.color || INK));
  };
  const split = (line, width) => { font(line.st); const t = pdfText(line.st.upper ? line.text.toUpperCase() : line.text); return doc.splitTextToSize(t, width); };
  const lh = st => st.size * 1.3;

  // lines one under the other, at x (or right-aligned to x + width)
  function write(lines, x = M, width = CW, align = 'left') {
    for (const line of lines) {
      for (const piece of split(line, width)) {
        room(lh(line.st)); font(line.st);
        doc.text(piece, align === 'right' ? x + width : x, y, { baseline: 'top', align });
        y += lh(line.st);
      }
    }
  }
  // two columns side by side (title + status, billed-to + order…)
  function columns(el, rule) {
    const cols = kidsOf(el).filter(n => n.nodeType === 1);
    const gap = 16, half = cols.length > 1 ? (CW - gap) / 2 : CW;
    const sides = cols.slice(0, 2).map(c => linesOf(c).flatMap(l => split(l, half).map(t => ({ t, st: l.st }))));
    const height = Math.max(0, ...sides.map(s => s.reduce((h, p) => h + lh(p.st), 0)));
    room(Math.min(height, 200));
    const top = y;
    sides.forEach((s, i) => {
      let yy = top;
      const right = i === 1 || (cols[i] && getComputedStyle(cols[i]).textAlign === 'right');
      for (const p of s) { font(p.st); doc.text(p.t, right ? M + CW : M, yy, { baseline: 'top', align: right ? 'right' : 'left' }); yy += lh(p.st); }
    });
    y = top + height;
    if (rule) { y += 8; doc.setDrawColor(...INK); doc.setLineWidth(1.4); doc.line(M, y, W - M, y); y += 4; }
  }
  // the totals block, on the right
  function totals(el) {
    const bw = 250, x = W - M - bw;
    for (const row of kidsOf(el).filter(n => n.nodeType === 1)) {
      const [a, b] = [...row.children].map(textOf);
      const big = row.classList.contains('g');
      const st = { size: big ? 11.5 : 9.5, bold: big };
      room(lh(st) + (big ? 10 : 0));
      if (big) { y += 4; doc.setDrawColor(...INK); doc.setLineWidth(0.8); doc.line(x, y, W - M, y); y += 6; }
      font(st);
      doc.text(pdfText(a || ''), x, y, { baseline: 'top' });
      doc.text(pdfText(b || ''), W - M, y, { baseline: 'top', align: 'right' });
      y += lh(st) + 2;
    }
  }
  // photos in rows, with their captions
  function photos(el) {
    const bw = 112, bh = 84, gap = 12;
    let x = M, rowH = 0;
    for (const fig of el.querySelectorAll('figure')) {
      const img = fig.querySelector('img');
      if (!img || !img.complete || !img.naturalWidth) continue;
      let data;
      try {
        const c = document.createElement('canvas'), k = Math.min(1, 480 / img.naturalWidth);
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        data = c.toDataURL('image/jpeg', 0.85);
      } catch { continue; }
      const cap = split({ text: textOf(fig.querySelector('figcaption') || { nodeType: 3, textContent: '' }), st: { size: 7.5, color: GREY } }, bw);
      const h = bh + 4 + cap.length * 7.5 * 1.3;
      if (x + bw > W - M + 0.5) { x = M; y += rowH + gap; rowH = 0; }
      room(h);
      const r = Math.min(bw / img.naturalWidth, bh / img.naturalHeight), w = img.naturalWidth * r, hh = img.naturalHeight * r;
      doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.rect(x, y, bw, bh);
      doc.addImage(data, 'JPEG', x + (bw - w) / 2, y + (bh - hh) / 2, w, hh);
      font({ size: 7.5, color: GREY });
      cap.forEach((t, i) => doc.text(t, x, y + bh + 4 + i * 7.5 * 1.3, { baseline: 'top' }));
      x += bw + gap; rowH = Math.max(rowH, h);
    }
    if (rowH) y += rowH + 8;
  }
  // a table: header, rows, sub-lines under the main text of a cell in smaller grey
  function table(t) {
    let head = t.tHead ? [...t.tHead.rows] : [];
    const body = [...t.tBodies].flatMap(b => [...b.rows]).filter(r => !hidden(r));
    if (!head.length && body.length && [...body[0].cells].every(c => c.tagName === 'TH')) head = [body.shift()];
    const foot = t.tFoot ? [...t.tFoot.rows] : [];
    const subs = new Map(), rowKind = new Map();
    const right = new Set();
    head.forEach(r => { let i = 0; for (const c of r.cells) { if (c.classList.contains('r')) right.add(i); i += c.colSpan || 1; } });
    const cellOf = (c, key) => {
      const blocks = [...c.children].filter(k => BLOCK.has(k.tagName) && !hidden(k));
      let main = textOf(c), sub = [];
      if (blocks.length) {
        const clone = c.cloneNode(true);
        [...clone.children].filter(k => BLOCK.has(k.tagName)).forEach(k => k.remove());
        main = clone.textContent.replace(/\s+/g, ' ').trim();
        sub = blocks.flatMap(b => (b.innerText || b.textContent || '').split('\n')).map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
        if (!main && sub.length) main = sub.shift();
      }
      if (sub.length) subs.set(key, { main: pdfText(main), sub: sub.map(pdfText) });
      return { content: pdfText([main, ...sub].join('\n')), colSpan: c.colSpan || 1, styles: c.classList.contains('r') ? { halign: 'right' } : {} };
    };
    const rows = (list, sec) => list.map((r, ri) => {
      if (r.classList.contains('tot')) rowKind.set(`${sec}:${ri}`, 'tot');
      if (r.classList.contains('mix')) rowKind.set(`${sec}:${ri}`, 'mix');
      let ci = 0;
      return [...r.cells].map(c => { const cell = cellOf(c, `${sec}:${ri}:${ci}`); ci += c.colSpan || 1; return cell; });
    });
    const columnStyles = {};
    for (const i of right) columnStyles[i] = { halign: 'right', cellWidth: 'wrap' };
    room(40);
    doc.autoTable({
      startY: y, margin: { left: M, right: M, top: M, bottom: H - BOTTOM },
      head: rows(head, 'head'), body: rows(body, 'body'), foot: rows(foot, 'foot'), showFoot: 'lastPage',
      styles: { font: 'helvetica', fontSize: 8.6, cellPadding: 4.5, textColor: INK, lineColor: LINE, lineWidth: 0.4, overflow: 'linebreak' },
      headStyles: { fillColor: INK, textColor: 255, fontStyle: 'bold', fontSize: 7.6 },
      footStyles: { fillColor: [238, 234, 225], textColor: INK, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [249, 247, 243] },
      columnStyles,
      didParseCell: d => {
        const kind = rowKind.get(`${d.section}:${d.row.index}`);
        if (kind === 'tot') { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [238, 234, 225]; }
        if (kind === 'mix') { d.cell.styles.fontSize = 7.8; d.cell.styles.textColor = SOFT; }
      },
      willDrawCell: d => { if (subs.has(`${d.section}:${d.row.index}:${d.column.index}`)) d.cell.text = []; },
      didDrawCell: d => {
        const s = subs.get(`${d.section}:${d.row.index}:${d.column.index}`);
        if (!s) return;
        const c = d.cell, x = c.x + c.padding('left'), w = c.width - c.padding('left') - c.padding('right');
        const size = c.styles.fontSize;
        let yy = c.y + c.padding('top');
        doc.setFont('helvetica', c.styles.fontStyle === 'bold' ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...INK);
        for (const p of doc.splitTextToSize(s.main, w)) { doc.text(p, x, yy, { baseline: 'top' }); yy += size * 1.15; }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(size * 0.88); doc.setTextColor(...SOFT);
        yy += 1.5;
        for (const p of s.sub.flatMap(l => doc.splitTextToSize(l, w))) { doc.text(p, x, yy, { baseline: 'top' }); yy += size * 0.88 * 1.2; }
      }
    });
    y = doc.lastAutoTable.finalY + 12;
  }
  // how tall a block comes out (drawn once on a scratch page); Infinity if it needs more than a page
  let measuring = false;
  function heightOf(el) {
    const keep = [doc, y];
    measuring = true; doc = new jsPDF({ unit: 'pt', format: 'a4' }); y = M;
    try { block(el); return doc.internal.getNumberOfPages() > 1 ? Infinity : y - M; } finally { [doc, y] = keep; measuring = false; }
  }
  // walk the document in order
  function block(el) {
    if (el.nodeType === 3) { const s = textOf(el); if (s) write([{ text: s, st: { size: 9.5 } }]); return; }
    if (el.nodeType !== 1 || hidden(el) || el.tagName === 'IMG' || el.tagName === 'BR') return;
    const cs = getComputedStyle(el), cl = el.classList;
    // kept on one page when it says so (a price-list model with its photos and prices)
    if (!measuring && /avoid/.test(cs.breakInside + ' ' + cs.pageBreakInside)) { const h = heightOf(el); if (h < BOTTOM - M) room(h); }
    y += Math.min(18, px(cs.marginTop) * 0.7);
    if (px(cs.borderTopWidth) >= 1 && el.tagName === 'P') { doc.setDrawColor(...LINE); doc.setLineWidth(0.6); doc.line(M, y, W - M, y); y += 8; }
    if (el.tagName === 'TABLE') table(el);
    else if (cl.contains('dh')) columns(el, true);
    else if (cl.contains('parties')) columns(el, false);
    else if (cl.contains('tot')) totals(el);
    else if (cl.contains('photos')) photos(el);
    else if (!hasBlock(el)) write(linesOf(el));
    else for (const k of kidsOf(el)) block(k);
    y += Math.min(18, px(cs.marginBottom) * 0.7);
  }
  for (const k of kidsOf(root)) block(k);
  // page numbers
  const n = doc.internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
    if (title) doc.text(pdfText(title), M, H - 26);
    doc.text(`Page ${i} / ${n}`, W - M, H - 26, { align: 'right' });
  }
  return new File([doc.output('blob')], fileName, { type: 'application/pdf' });
}

// Data for stock pages that came after stage 1 (ported from app.py with the same SQL).
import { all } from './localdb.js';
import * as Q from './queries.js';

// app.boxes_open — every open box with what's left, pairs available by colour and size, which
// sizes sold as single pairs in the last 90 days, and the mixes that still have sealed boxes.
export function openBoxesPage(now = new Date()) {
  const boxes = all(`SELECT * FROM boxes WHERE status = 'open' ORDER BY opened_at, id`).map(b => {
    const lines = {};
    let total = 0, left = 0;
    for (const i of Q.boxContents(b.id)) {
      const key = `${i.product_name}${i.color ? ' ' + i.color : ''}`;
      (lines[key] = lines[key] || []).push([i.size, i.qty_left || 0, i.qty]);
      total += i.qty; left += i.qty_left || 0;
    }
    return { ...b, lines, total, left, untouched: left === total };
  });
  const avail = Q.pairsAvailable();
  const names = new Map(all(`SELECT v.id, v.size, v.color, p.name FROM variants v JOIN products p ON p.id = v.product_id`).map(r => [r.id, r]));
  const matrix = {}, sizes = new Set();
  for (const [v, d] of avail) {
    if (!(d.open || d.loose || d.committed) || !names.has(v)) continue;
    const n = names.get(v);
    const k = `${n.name}${n.color ? ' ' + n.color : ''}`;
    (matrix[k] = matrix[k] || {})[String(n.size)] = d;
    sizes.add(String(n.size));
  }
  const sizeKey = z => (z.trim() !== '' && !isNaN(Number(z)) ? [0, Number(z), ''] : [1, 0, z]);
  const sorted = [...sizes].sort((a, b) => { const x = sizeKey(a), y = sizeKey(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); });
  const since = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const sold = all(`
    SELECT p.name, v.color, v.size,
           SUM(oi.qty) - COALESCE((SELECT SUM(ri.qty) FROM return_items ri WHERE ri.order_item_id IN
                (SELECT oi2.id FROM order_items oi2 JOIN orders o2 ON o2.id = oi2.order_id
                 WHERE oi2.variant_id = v.id AND oi2.box_id IS NULL AND o2.status = 'fulfilled'
                   AND o2.fulfilled_at >= ?)), 0) as pairs
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
    WHERE oi.box_id IS NULL AND o.status = 'fulfilled' AND o.fulfilled_at >= ?
    GROUP BY v.id ORDER BY pairs DESC LIMIT 40`, [since, since]);
  const mixes = all(`SELECT b.source_po_id, b.source_label, COUNT(*) as sealed FROM boxes b
                     WHERE b.status = 'in_stock' AND b.source_po_id IS NOT NULL
                     GROUP BY b.source_po_id, b.source_label ORDER BY b.source_label`);
  return { boxes, matrix, sizes: sorted, sold, mixes };
}

// For each style: boxes received, sold, still sealed in stock, open, and on orders not yet
// delivered; pairs received, sold (net of returns; a cancelled order's sale is undone) and left.
// A box counts under the style it holds.
const blank = () => ({ boxes_received: 0, boxes_sold: 0, boxes_left: 0, boxes_open: 0, boxes_reserved: 0, pairs_received: 0, pairs_sold: 0, pairs_left: 0 });
export function modelSales() {
  const out = new Map();
  const get = pid => { if (!out.has(pid)) out.set(pid, blank()); return out.get(pid); };
  for (const r of all(`SELECT v.product_id AS pid, b.status, COUNT(DISTINCT b.id) AS n FROM boxes b JOIN box_items bi ON bi.box_id = b.id
                       JOIN variants v ON v.id = bi.variant_id GROUP BY v.product_id, b.status`)) {
    const m = get(r.pid);
    m.boxes_received += r.n;
    if (r.status === 'sold') m.boxes_sold += r.n;
    else if (r.status === 'in_stock') m.boxes_left += r.n;
    else if (r.status === 'open') m.boxes_open += r.n;
  }
  for (const r of all(`SELECT v.product_id AS pid,
                         COALESCE(SUM(CASE WHEN m.reason IN ('purchase', 'initial') THEN m.change_qty END), 0) AS received,
                         -COALESCE(SUM(CASE WHEN m.reason IN ('sale', 'return') THEN m.change_qty END), 0) AS sold,
                         COALESCE(SUM(m.change_qty), 0) AS left_
                       FROM stock_moves m JOIN variants v ON v.id = m.variant_id GROUP BY v.product_id`)) {
    const m = get(r.pid);
    m.pairs_received = r.received; m.pairs_sold = r.sold; m.pairs_left = r.left_;
  }
  // boxes on orders not delivered yet, by mix → the style in that mix's boxes
  for (const r of all(`SELECT (SELECT v.product_id FROM boxes b JOIN box_items bi ON bi.box_id = b.id JOIN variants v ON v.id = bi.variant_id
                                WHERE b.source_po_id IS obl.source_po_id AND b.source_label = obl.source_label LIMIT 1) AS pid,
                              SUM(obl.qty_boxes) AS n
                       FROM order_box_lines obl JOIN orders o ON o.id = obl.order_id WHERE o.status = 'open' GROUP BY obl.source_po_id, obl.source_label`)) {
    if (r.pid !== null && r.pid !== undefined) get(r.pid).boxes_reserved += r.n || 0;
  }
  return out;
}
export const modelSalesOf = pid => modelSales().get(pid) || blank();

// One style's mixes: boxes received, sold, sealed in stock, open, and on orders not delivered yet.
export function modelMixes(pid) {
  return all(`SELECT b.source_po_id, b.source_label, COUNT(DISTINCT b.id) AS received,
                     COUNT(DISTINCT CASE WHEN b.status = 'sold' THEN b.id END) AS sold,
                     COUNT(DISTINCT CASE WHEN b.status = 'in_stock' THEN b.id END) AS in_stock,
                     COUNT(DISTINCT CASE WHEN b.status = 'open' THEN b.id END) AS opened,
                     MIN(b.received_at) AS received_at,
                     (SELECT COALESCE(SUM(obl.qty_boxes), 0) FROM order_box_lines obl JOIN orders o ON o.id = obl.order_id
                      WHERE o.status = 'open' AND obl.source_po_id IS b.source_po_id AND obl.source_label = b.source_label) AS reserved
              FROM boxes b JOIN box_items bi ON bi.box_id = b.id JOIN variants v ON v.id = bi.variant_id
              WHERE v.product_id = ? GROUP BY b.source_po_id, b.source_label ORDER BY received_at DESC, b.source_label`, [pid]);
}

// Each style's mixes (for example the M in 37–41 and the L in 41–45 of the same model), with
// boxes and pairs sold and left: pairs sold = the pairs of boxes sold + pairs taken out of open
// boxes; pairs left = sealed boxes + what's left in open boxes. Map: style id → mixes, small sizes first.
const LETTER = /\s(XXS|XS|S|M|L|XL|XXL)$/i;
export function mixBreakdown() {
  const reserved = new Map(all(`SELECT obl.source_po_id AS po, obl.source_label AS label, SUM(obl.qty_boxes) AS n FROM order_box_lines obl
                                JOIN orders o ON o.id = obl.order_id WHERE o.status = 'open' GROUP BY obl.source_po_id, obl.source_label`).map(r => [`${r.po}|${r.label}`, r.n || 0]));
  const out = new Map();
  for (const r of all(`SELECT v.product_id AS pid, b.source_po_id AS po, b.source_label AS label,
                         COUNT(DISTINCT b.id) AS received,
                         COUNT(DISTINCT CASE WHEN b.status = 'sold' THEN b.id END) AS sold,
                         COUNT(DISTINCT CASE WHEN b.status = 'in_stock' THEN b.id END) AS sealed,
                         COUNT(DISTINCT CASE WHEN b.status = 'open' THEN b.id END) AS opened,
                         COALESCE(SUM(CASE WHEN b.status = 'sold' THEN bi.qty END), 0) AS pairs_in_sold,
                         COALESCE(SUM(CASE WHEN b.status = 'in_stock' THEN bi.qty END), 0) AS pairs_sealed,
                         COALESCE(SUM(CASE WHEN b.status = 'open' THEN COALESCE(bi.qty_left, 0) END), 0) AS pairs_open_left,
                         COALESCE(SUM(CASE WHEN b.status = 'open' THEN bi.qty - COALESCE(bi.qty_left, 0) END), 0) AS pairs_taken,
                         MIN(CASE WHEN CAST(v.size AS REAL) > 0 THEN CAST(v.size AS REAL) END) AS smin,
                         MAX(CASE WHEN CAST(v.size AS REAL) > 0 THEN CAST(v.size AS REAL) END) AS smax,
                         MIN(b.received_at) AS received_at
                       FROM boxes b JOIN box_items bi ON bi.box_id = b.id JOIN variants v ON v.id = bi.variant_id
                       GROUP BY v.product_id, b.source_po_id, b.source_label`)) {
    const m = (String(r.label || '').trim().match(LETTER) || [])[1];
    const range = r.smin ? (r.smin === r.smax ? `${r.smin}` : `${r.smin}–${r.smax}`) : '';
    const mix = { po: r.po, label: r.label, letter: m ? m.toUpperCase() : '', range, smin: r.smin || 0, received: r.received,
      boxes_sold: r.sold, pairs_sold: r.pairs_in_sold + r.pairs_taken, boxes_left: r.sealed, boxes_open: r.opened,
      pairs_left: r.pairs_sealed + r.pairs_open_left, boxes_reserved: reserved.get(`${r.po}|${r.label}`) || 0, received_at: r.received_at };
    mix.name = [mix.letter, mix.range].filter(Boolean).join(' · ') || String(r.label || '');
    if (!out.has(r.pid)) out.set(r.pid, []);
    out.get(r.pid).push(mix);
  }
  for (const list of out.values()) list.sort((a, b) => a.smin - b.smin || String(a.label).localeCompare(String(b.label)));
  return out;
}

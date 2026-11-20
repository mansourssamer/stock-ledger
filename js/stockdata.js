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

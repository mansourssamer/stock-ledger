// Backups (the database part): everything in one .zip — the data as an erp.db in the old app's own format (records
// made here get numbers after the old ones), plus product photos and documents. The old app's
// Backup page can restore it, and this app's Import page reads it back.
import * as L from './localdb.js';
import { TABLES } from './schema.js';
import { OLD_SCHEMA } from './oldschema.js';

// Which table each reference column points to (ref_id depends on ref_type).
const REF = { customer_id: 'customers', order_id: 'orders', sold_order_id: 'orders', variant_id: 'variants', product_id: 'products', box_id: 'boxes', invoice_id: 'invoices',
  order_item_id: 'order_items', order_box_line_id: 'order_box_lines', return_id: 'returns', return_item_id: 'return_items', account_id: 'cash_accounts', po_id: 'purchase_orders',
  source_po_id: 'purchase_orders', po_box_group_id: 'po_box_groups', shipment_id: 'shipments', location_id: 'locations', from_location_id: 'locations', to_location_id: 'locations',
  parent_id: 'locations', supplier_id: 'suppliers', partner_id: 'partners', cash_transaction_id: 'cash_transactions', distribution_id: 'distributions', contact_id: 'crm_contacts',
  zone_id: 'crm_zones', assortment_id: 'assortments' };
const REFTYPE = { order: 'orders', purchase_order: 'purchase_orders', invoice_payment: 'invoice_payments', box_count: 'boxes', expense: 'expenses', partner: 'partners',
  distribution: 'distributions', po_cost: 'po_costs', partner_ledger: 'partner_ledger' };

// The data as the old app's database: returns {bytes, rows, renumbered, conflicts}.
export function buildBackupDb() {
  const out = L.newDatabase();
  for (const ddl of OLD_SCHEMA) out.run(ddl);
  // New records (text ids) get the numbers after the highest old one, in the order they were made.
  const maps = {};
  let renumbered = 0;
  for (const [name, def] of Object.entries(TABLES)) {
    if (def.key !== 'id' || name === 'ref_numbers') continue;
    const used = new Set(L.all(`SELECT id FROM "${name}" WHERE typeof(id) = 'integer'`).map(r => r.id));
    const m = new Map();
    // orders and purchase orders keep the number shown in this app (unless two phones gave the same one)
    if (L.NUMBERED.has(name)) {
      for (const r of L.all(`SELECT t.id, n.number FROM "${name}" t JOIN ref_numbers n ON n.id = t.id AND n.tbl = ?
                             WHERE typeof(t.id) = 'text' ORDER BY t.id`, [name])) {
        if (r.number && !used.has(r.number)) { m.set(r.id, r.number); used.add(r.number); }
      }
    }
    let next = Math.max(L.val(`SELECT COALESCE(MAX(id), 0) FROM "${name}" WHERE typeof(id) = 'integer'`) || 0,
      L.NUMBERED.has(name) ? L.val(`SELECT COALESCE(MAX(number), 0) FROM ref_numbers WHERE tbl = ?`, [name]) || 0 : 0);
    for (const r of L.all(`SELECT id FROM "${name}" WHERE typeof(id) = 'text' ORDER BY id`)) {
      if (m.has(r.id)) continue;
      while (used.has(++next));
      m.set(r.id, next); used.add(next);
    }
    maps[name] = m;
    renumbered += m.size;
  }
  const map = (table, v) => (typeof v === 'string' && maps[table] && maps[table].has(v) ? maps[table].get(v) : v);
  const oldCols = name => new Set(L.withDb(out, () => L.all(`PRAGMA table_info("${name}")`)).map(r => r.name));
  let rows = 0;
  const conflicts = [];
  out.run('BEGIN');
  for (const [name, def] of Object.entries(TABLES)) {
    const have = oldCols(name);
    if (!have.size) continue;
    const cols = def.cols.map(c => c[0]).filter(c => have.has(c));
    const stmt = out.prepare(`INSERT INTO "${name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const r of L.all(`SELECT * FROM "${name}"`)) {
      const vals = cols.map(c => {
        let v = r[c];
        if (v === undefined) v = null;
        if (c === 'id' && def.key === 'id') return map(name, v);
        if (REF[c]) return map(REF[c], v);
        if (c === 'ref_id' && REFTYPE[r.ref_type]) return map(REFTYPE[r.ref_type], v);
        if (c === 'model_key' && typeof v === 'string') {   // "product:colour|product:colour#sizes"
          const [styles, sizes] = v.split('#');
          return styles.split('|').map(p => { const i = p.indexOf(':'); return i < 0 ? p : `${map('products', p.slice(0, i))}${p.slice(i)}`; }).join('|') + (sizes !== undefined ? '#' + sizes : '');
        }
        if (c === 'lines_json' && typeof v === 'string') {
          try { return JSON.stringify(JSON.parse(v).map(l => ({ ...l, ...(l.po_id !== undefined ? { po_id: map('purchase_orders', l.po_id) } : {}), ...(l.variant_id !== undefined ? { variant_id: map('variants', l.variant_id) } : {}) }))); } catch { return v; }
        }
        return v;
      });
      try { stmt.run(vals); rows++; } catch (e) { conflicts.push({ table: name, row: Object.fromEntries(cols.map((c, i) => [c, vals[i]])), error: String(e.message || e) }); }
    }
    stmt.free();
  }
  // Nothing is ever left out: a row the old format refused (two invoices with one number, say) is kept here.
  if (conflicts.length) {
    out.run(`CREATE TABLE _not_restored (tbl TEXT, row_json TEXT, error TEXT)`);
    for (const c of conflicts) out.run(`INSERT INTO _not_restored VALUES (?, ?, ?)`, [c.table, JSON.stringify(c.row), c.error]);
  }
  out.run('COMMIT');
  const bytes = out.export();
  out.close();
  return { bytes, rows, renumbered, conflicts };
}


"""Compares the database the old app produced with the one the new app produced after the
same scenario. New rows are matched by creation order (old app: number ids; new app: text
ids that sort by time), and references between tables are translated through that match.
Times are compared by day (the two runs happen seconds apart).
    python3 tests/compare_db.py start.db old_out.db new_out.db
"""
import re, sqlite3, sys
start, a_path, b_path = sys.argv[1:4]
S, A, B = (sqlite3.connect(p) for p in (start, a_path, b_path))
for c in (S, A, B): c.row_factory = sqlite3.Row
tables = [t for (t,) in A.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") if t not in ('users', 'login_failures')]
REF = {'customer_id': 'customers', 'order_id': 'orders', 'sold_order_id': 'orders', 'variant_id': 'variants', 'product_id': 'products',
       'box_id': 'boxes', 'invoice_id': 'invoices', 'order_item_id': 'order_items', 'order_box_line_id': 'order_box_lines', 'return_id': 'returns',
       'return_item_id': 'return_items', 'account_id': 'cash_accounts', 'po_id': 'purchase_orders', 'source_po_id': 'purchase_orders',
       'po_box_group_id': 'po_box_groups', 'shipment_id': 'shipments', 'location_id': 'locations', 'from_location_id': 'locations',
       'to_location_id': 'locations', 'parent_id': 'locations', 'supplier_id': 'suppliers', 'partner_id': 'partners',
       'cash_transaction_id': 'cash_transactions', 'distribution_id': 'distributions', 'contact_id': 'crm_contacts', 'zone_id': 'crm_zones',
       'assortment_id': 'assortments'}
REFTYPE = {'order': 'orders', 'purchase_order': 'purchase_orders', 'invoice_payment': 'invoice_payments', 'box_count': 'boxes', 'expense': 'expenses',
           'po_cost': 'po_costs', 'partner_ledger': 'partner_ledger', 'distribution': 'distributions'}
ts = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$')
maxid = {}
for t in tables:
    cols = [r[1] for r in A.execute(f'PRAGMA table_info("{t}")')]
    if 'id' in cols:
        try: maxid[t] = S.execute(f'SELECT COALESCE(MAX(id), 0) FROM "{t}"').fetchone()[0]
        except sqlite3.OperationalError: maxid[t] = 0
idmap = {}  # (table, new-app id) -> old-app id
problems = []
for t in maxid:
    a_new = [r[0] for r in A.execute(f'SELECT id FROM "{t}" WHERE id > ? ORDER BY id', (maxid[t],))]
    b_new = [r[0] for r in B.execute(f'SELECT id FROM "{t}" WHERE typeof(id) = \'text\' ORDER BY id')]
    if len(a_new) != len(b_new): problems.append(f'{t}: {len(a_new)} new rows in old app, {len(b_new)} in new app')
    for x, y in zip(a_new, b_new): idmap[(t, y)] = x
def tr(table, col, v, row):
    if v is None: return None
    ref = REF.get(col)
    if col == 'ref_id': ref = REFTYPE.get(row['ref_type'])
    if col == 'id': ref = table
    if ref and isinstance(v, str): return idmap.get((ref, v), ('UNMAPPED', ref, v))
    return v
def norm(v):
    if isinstance(v, str) and ts.match(v): return v[:10]
    if isinstance(v, float) and v.is_integer(): return int(v)
    if isinstance(v, float): return round(v, 9)
    return v
checked = 0
for t in tables:
    cols = [r[1] for r in A.execute(f'PRAGMA table_info("{t}")')]
    key = 'id' if 'id' in cols else cols[0]
    arows = {r[key]: r for r in A.execute(f'SELECT * FROM "{t}"')}
    brows = {}
    for r in B.execute(f'SELECT * FROM "{t}"'):
        brows[tr(t, key, r[key], r) if key == 'id' else r[key]] = r
    if set(arows) != set(brows):
        problems.append(f'{t}: rows differ — only old app {sorted(set(arows) - set(brows))[:5]}, only new app {sorted(set(brows) - set(arows), key=str)[:5]}')
    for k in set(arows) & set(brows):
        ra, rb = arows[k], brows[k]
        for c in cols:
            va, vb = norm(ra[c]), norm(tr(t, c, rb[c], rb))
            checked += 1
            if isinstance(vb, tuple) and vb[0] == 'UNMAPPED' and isinstance(va, int) and va > maxid.get(vb[1], 0) \
                    and not A.execute(f'SELECT 1 FROM "{vb[1]}" WHERE id = ?', (va,)).fetchone() \
                    and not B.execute(f'SELECT 1 FROM "{vb[1]}" WHERE id = ?', (vb[2],)).fetchone():
                continue   # both point at a row made during the run and deleted since (the old app leaves such references too)
            if va != vb and not (isinstance(va, (int, float)) and isinstance(vb, (int, float)) and abs(va - vb) <= 1e-6 * max(1, abs(va))):
                problems.append(f'{t} #{k}.{c}: old app {ra[c]!r} vs new app {rb[c]!r}')
print(f'{checked} values compared across {len(tables)} tables, {len(problems)} differences')
for p in problems[:50]: print('  ', p)
sys.exit(1 if problems else 0)

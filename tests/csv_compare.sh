#!/bin/sh
# The CSV exports of both apps on the same database, compared cell by cell.
#    tests/csv_compare.sh OLD_APP_DIR erp.db workdir [new_app.db — after the same scenario through each app]
set -e
APP=$1; DB=$2; W=$3; DBNEW=${4:-$2}; mkdir -p "$W"
python3 - "$APP" "$DB" "$W/old.json" <<'PY'
import json, os, shutil, sqlite3, sys, tempfile, csv, io
app_dir, db_in, out = sys.argv[1:4]
work = tempfile.mkdtemp()
shutil.copytree(app_dir, os.path.join(work, 'erp'), ignore=shutil.ignore_patterns('erp.db', 'backups', '__pycache__', 'static'))
os.makedirs(os.path.join(work, 'erp', 'static', 'uploads', 'products'), exist_ok=True)
shutil.copy(db_in, os.path.join(work, 'erp', 'erp.db'))
c = sqlite3.connect(os.path.join(work, 'erp', 'erp.db')); c.execute('DELETE FROM users'); c.commit()
custs = [r[0] for r in c.execute('SELECT id FROM customers ORDER BY id')]
c.close()
os.environ.pop('ERP_REQUIRE_LOGIN', None)
sys.path.insert(0, os.path.join(work, 'erp')); os.chdir(os.path.join(work, 'erp'))
import app as A
A.app.config['TESTING'] = True
cl = A.app.test_client()
urls = {'products': '/products/export.csv', 'customers': '/customers/export.csv', 'suppliers': '/suppliers/export.csv',
        'orders': '/orders/export.csv', 'invoices': '/invoices/export.csv', 'pos': '/purchase-orders/export.csv'}
urls.update({f'ledger:{k}': f'/customers/{k}/ledger.csv' for k in custs})
res = {}
for k, u in urls.items():
    r = cl.get(u); assert r.status_code == 200, (u, r.status_code)
    res[k] = list(csv.reader(io.StringIO(r.get_data(as_text=True))))
json.dump(res, open(out, 'w'), ensure_ascii=False)
PY
node tests/csv_js.mjs "$DBNEW" > "$W/new.json"
python3 - "$W/old.json" "$W/new.json" <<'PY'
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
def num(s):
    try: return float(s)
    except ValueError: return None
cells = bad = 0
for k in a:
    x, y = a[k], b.get(k)
    if y is None: print(f'  {k}: missing in the new app'); bad += 1; continue
    if len(x) != len(y): print(f'  {k}: {len(x)} rows in the old app, {len(y)} in the new'); bad += 1
    for i, (rx, ry) in enumerate(zip(x, y)):
        if len(rx) != len(ry): print(f'  {k} row {i}: {len(rx)} vs {len(ry)} columns'); bad += 1; continue
        for j, (cx, cy) in enumerate(zip(rx, ry)):
            cells += 1
            if cx == cy: continue
            nx, ny = num(cx), num(cy)
            if nx is not None and ny is not None and abs(nx - ny) <= 1e-6 * max(1, abs(nx)): continue
            bad += 1
            if bad <= 15: print(f'  {k} row {i} col {x[0][j] if i else j}: old {cx!r} new {cy!r}')
print(f'{len(a)} exports, {cells} cells compared, {bad} differences')
PY

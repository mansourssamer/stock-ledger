"""Runs a scenario through the OLD app (Flask, its real form handlers) on a copy of a database.
    python3 tests/scenario_py.py OLD_APP_DIR erp.db scenario.json out.db > log.json
"""
import json, os, shutil, sys, tempfile, hashlib, sqlite3

app_dir, db_in, scen_path, db_out = sys.argv[1:5]
work = tempfile.mkdtemp()
shutil.copytree(app_dir, os.path.join(work, 'erp'), ignore=shutil.ignore_patterns('erp.db', 'backups', '__pycache__', 'static'))
os.makedirs(os.path.join(work, 'erp', 'static', 'uploads', 'products'), exist_ok=True)
shutil.copy(db_in, os.path.join(work, 'erp', 'erp.db'))
# The copy is opened without a sign-in (sign-in tables are not compared).
_c = sqlite3.connect(os.path.join(work, 'erp', 'erp.db'))
_c.execute('DELETE FROM users'); _c.commit(); _c.close()
os.environ.pop('ERP_REQUIRE_LOGIN', None)
sys.path.insert(0, os.path.join(work, 'erp'))
os.chdir(os.path.join(work, 'erp'))
import app as A  # noqa: E402
A.app.config['TESTING'] = True
client = A.app.test_client()
DB = os.path.join(work, 'erp', 'erp.db')

def conn():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c
def val(sql, *a):
    with conn() as c:
        r = c.execute(sql, a).fetchone()
        return r[0] if r else None
def checksum():
    h = hashlib.sha256()
    with conn() as c:
        for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
            for r in c.execute(f'SELECT * FROM "{t}" ORDER BY rowid'):
                h.update(repr(tuple(r)).encode())
    return h.hexdigest()

names = {}
def res(v):
    if isinstance(v, str) and v.startswith('$'):
        key, _, sub = v[1:].partition('.')
        base = names[key]
        if not sub: return base
        if sub == 'line0': return val("SELECT id FROM order_box_lines WHERE order_id = ? ORDER BY id LIMIT 1", base)
        if sub == 'item0': return val("SELECT id FROM order_items WHERE order_id = ? AND box_id IS NULL ORDER BY id LIMIT 1", base)
        if sub == 'inv': return val("SELECT id FROM invoices WHERE order_id = ? AND status != 'void' ORDER BY id LIMIT 1", base)
        if sub == 'pay_last': return val("SELECT ip.id FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.order_id = ? ORDER BY ip.id DESC LIMIT 1", base)
    return v

CHECKBOXES = {'restock', 'credit_ok', 'pay_in_full', 'remove_image', 'confirm'}
def form(args, *keys):
    out = {}
    for k in keys:
        if k in CHECKBOXES and not args.get(k):
            continue   # an unticked box sends nothing, as in a browser
        if k in args and args[k] is not None and args[k] != '':
            out[k] = str(res(args[k]))
    return out

def post(url, data):
    r = client.post(url, data=data)
    assert r.status_code in (200, 302), (url, r.status_code, r.get_data(as_text=True)[:500])

log = []
for step in json.load(open(scen_path)):
    op, a = step['op'], step['args']
    if any(isinstance(v, str) and v.startswith('$') and res(v) is None for v in a.values()):
        log.append({'op': op, 'ok': False, 'skipped': True}); continue   # it refers to something an earlier step didn't make
    before = checksum()
    if op == 'customerNew': post('/customers/new', form(a, 'name', 'email', 'phone', 'address', 'discount_percent', 'credit_limit', 'credit_currency'))
    elif op == 'customerEdit': post(f"/customers/{res(a['customer'])}/edit", form(a, 'name', 'email', 'phone', 'address', 'discount_percent', 'credit_limit', 'credit_currency'))
    elif op == 'productNew': post('/products/new', form(a, 'sku_prefix', 'name', 'brand', 'category', 'cost_price', 'sale_price', 'reorder_level'))
    elif op == 'productAddSize': post(f"/products/{res(a['product'])}/add_size", form(a, 'size', 'color', 'initial_qty'))
    elif op == 'variantAdjust': post(f"/variants/{res(a['variant'])}/adjust", form(a, 'delta', 'note'))
    elif op == 'variantRename': post(f"/variants/{res(a['variant'])}/rename", form(a, 'size', 'color'))
    elif op == 'boxOpenOne': post('/boxes/open-one', form(a, 'po_id', 'label'))
    elif op == 'orderNew': post('/orders/new', form(a, 'customer_id', 'currency_code', 'notes', 'order_date'))
    elif op == 'orderEdit': post(f"/orders/{res(a['order'])}/edit", form(a, 'customer_id', 'currency_code', 'notes', 'order_date', 'delivered_on'))
    elif op == 'orderAttachBoxes': post(f"/orders/{res(a['order'])}/attach_boxes", form(a, 'po_id', 'label', 'qty', 'price_per_pair', 'price_per_box'))
    elif op == 'orderAddItem': post(f"/orders/{res(a['order'])}/add_item", form(a, 'variant_id', 'qty', 'price_per_pair'))
    elif op == 'orderBoxLineEdit': post(f"/orders/{res(a['order'])}/box-lines/{res(a['line'])}/edit", form(a, 'qty_boxes', 'price_per_pair', 'price_per_box'))
    elif op == 'orderBoxLineDelete': post(f"/orders/{res(a['order'])}/box-lines/{res(a['line'])}/delete", {})
    elif op == 'orderItemEdit': post(f"/orders/{res(a['order'])}/items/{res(a['item'])}/edit", form(a, 'qty', 'unit_price'))
    elif op == 'orderFulfill': post(f"/orders/{res(a['order'])}/fulfill", form(a, 'delivered_on', 'credit_ok'))
    elif op == 'orderCancel': post(f"/orders/{res(a['order'])}/cancel", {})
    elif op == 'orderDelete': post(f"/orders/{res(a['order'])}/delete", {})
    elif op == 'orderCreateInvoice': post(f"/orders/{res(a['order'])}/invoice", {})
    elif op == 'orderItemReturn': post(f"/orders/{res(a['order'])}/items/{res(a['item'])}/return", form(a, 'qty', 'restock', 'reason'))
    elif op == 'orderBoxLineReturn': post(f"/orders/{res(a['order'])}/box-lines/{res(a['line'])}/return", form(a, 'qty', 'restock', 'reason'))
    elif op == 'invoicePay': post(f"/invoices/{res(a['invoice'])}/pay", form(a, 'amount', 'pay_in_full', 'paid_on', 'account_id', 'note'))
    elif op == 'invoicePaymentDelete': post(f"/invoices/payments/{res(a['payment'])}/delete", {})
    elif op == 'boxCountFirstOpen':
        box = val("SELECT id FROM boxes WHERE status IN ('open','emptied') ORDER BY opened_at, id LIMIT 1")
        with conn() as c:
            it = c.execute("SELECT id, qty_left FROM box_items WHERE box_id = ? AND qty_left > 0 ORDER BY id LIMIT 1", (box,)).fetchone()
        post(f"/boxes/{box}/count", {f"counted_{it['id']}": str(it['qty_left'] - a['missing'])})
    elif op == 'locationMove': post('/locations/move', form(a, 'from_location_id', 'to_location_id', 'po_id', 'label', 'qty', 'note'))
    else: raise SystemExit('unknown op ' + op)
    changed = checksum() != before
    if step.get('save'):
        table = {'c': 'customers', 'p': 'products', 'v': 'variants', 'o': 'orders'}[step['save'][0]]
        names[step['save']] = val(f'SELECT MAX(id) FROM "{table}"')
    log.append({'op': op, 'ok': changed})
# The app keeps recent changes in a WAL file: copy through SQLite so they're included.
with conn() as _src:
    _dst = sqlite3.connect(db_out)
    _src.backup(_dst)
    _dst.close()
print(json.dumps(log))

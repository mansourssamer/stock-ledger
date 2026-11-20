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
        if sub == 'line0' and key.startswith('o'): return val("SELECT id FROM order_box_lines WHERE order_id = ? ORDER BY id LIMIT 1", base)
        if sub == 'item0' and key.startswith('o'): return val("SELECT id FROM order_items WHERE order_id = ? AND box_id IS NULL ORDER BY id LIMIT 1", base)
        if sub == 'inv': return val("SELECT id FROM invoices WHERE order_id = ? AND status != 'void' ORDER BY id LIMIT 1", base)
        if sub == 'pay_last' and key.startswith('o'): return val("SELECT ip.id FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.order_id = ? ORDER BY ip.id DESC LIMIT 1", base)
        # purchasing
        if sub.startswith('group:'): return val("SELECT id FROM po_box_groups WHERE po_id = ? AND label = ?", base, sub[6:])
        if sub.startswith('item'):
            return val("SELECT pi.id FROM po_items pi JOIN po_box_groups g ON g.id = pi.po_box_group_id WHERE g.po_id = ? ORDER BY pi.id LIMIT 1 OFFSET ?", base, int(sub[4:]))
        if sub == 'cost0': return val("SELECT id FROM po_costs WHERE po_id = ? ORDER BY id LIMIT 1", base)
        if sub == 'cost_last': return val("SELECT id FROM po_costs WHERE po_id = ? ORDER BY id DESC LIMIT 1", base)
        if sub == 'pay_last': return val("SELECT id FROM cash_transactions WHERE ref_type = 'purchase_order' AND ref_id = ? ORDER BY id DESC LIMIT 1", base)
        if sub == 'ppay_last': return val("SELECT id FROM partner_ledger WHERE ref_type = 'purchase_order' AND ref_id = ? AND method = 'direct' ORDER BY id DESC LIMIT 1", base)
        if sub.startswith('tier:'):
            _, label, n = sub.split(':')
            return val("SELECT id FROM price_tiers WHERE source_po_id IS ? AND source_label = ? AND min_boxes = ?", base, label, int(n))
        if sub == 'line0': return val("SELECT id FROM assortment_lines WHERE assortment_id = ? ORDER BY id LIMIT 1", base)
        if sub == 'tg_last': return val("SELECT transfer_group FROM cash_transactions WHERE account_id = ? AND transfer_group IS NOT NULL ORDER BY id DESC LIMIT 1", base)
        if sub == 'entry_last': return val("SELECT id FROM partner_ledger WHERE partner_id = ? ORDER BY id DESC LIMIT 1", base)
    if isinstance(v, str) and '$' in v:
        pre, _, ref = v.partition('$')
        r = res('$' + ref)
        return None if r is None else f"{pre}{r}"
    return v

CHECKBOXES = {'restock', 'credit_ok', 'pay_in_full', 'remove_image', 'confirm', 'is_actual', 'archived', 'restamp', 'override'}
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
    if any(isinstance(v, str) and '$' in v and res(v) is None for v in a.values()):
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
    # purchasing
    elif op == 'supplierNew': post('/suppliers/new', form(a, 'name', 'email', 'phone', 'address'))
    elif op == 'supplierEdit': post(f"/suppliers/{res(a['supplier'])}/edit", form(a, 'name', 'email', 'phone', 'address'))
    elif op == 'supplierDelete': post(f"/suppliers/{res(a['supplier'])}/delete", {})
    elif op == 'poNew': post('/purchase-orders/new', form(a, 'supplier_id', 'notes', 'currency_code'))
    elif op == 'poEdit': post(f"/purchase-orders/{res(a['po'])}/edit", form(a, 'supplier_id', 'notes', 'currency_code'))
    elif op == 'poDelete': post(f"/purchase-orders/{res(a['po'])}/delete", {})
    elif op == 'poAddItem': post(f"/purchase-orders/{res(a['po'])}/add_item", form(a, 'variant_id', 'qty', 'box_label', 'unit_cost'))
    elif op == 'poItemEdit': post(f"/purchase-orders/{res(a['po'])}/items/{res(a['item'])}/edit", form(a, 'qty', 'unit_cost'))
    elif op == 'poItemDelete': post(f"/purchase-orders/{res(a['po'])}/items/{res(a['item'])}/delete", {})
    elif op == 'poGroupDelete': post(f"/purchase-orders/{res(a['po'])}/box-groups/{res(a['group'])}/delete", {})
    elif op == 'poSetBoxCount': post(f"/purchase-orders/{res(a['po'])}/box-groups/{res(a['group'])}/set_count", form(a, 'box_count') if a.get('box_count') != 0 else {'box_count': '0'})
    elif op == 'poTypeRun': post(f"/purchase-orders/{res(a['po'])}/type-run", form(a, 'product_id', 'color', 'box_label', 'unit_cost', 'run'))
    elif op == 'poApplyRun': post(f"/purchase-orders/{res(a['po'])}/apply-run", form(a, 'assortment_id', 'product_id', 'color', 'box_label', 'unit_cost'))
    elif op == 'poSaveRun': post(f"/purchase-orders/{res(a['po'])}/box-groups/{res(a['group'])}/save-run", form(a, 'name'))
    elif op == 'assortmentNew': post('/assortments/new', form(a, 'name', 'notes', 'run'))
    elif op == 'assortmentLineAdd': post(f"/assortments/{res(a['assortment'])}/lines/add", form(a, 'size', 'qty'))
    elif op == 'assortmentLineDelete': post(f"/assortments/{res(a['assortment'])}/lines/{res(a['line'])}/delete", {})
    elif op == 'assortmentDelete': post(f"/assortments/{res(a['assortment'])}/delete", {})
    elif op == 'poCostNew': post(f"/purchase-orders/{res(a['po'])}/costs/new", form(a, 'description', 'amount', 'currency_code', 'cost_date', 'is_actual'))
    elif op == 'poCostEdit': post(f"/purchase-orders/{res(a['po'])}/costs/{res(a['cost'])}/edit", form(a, 'description', 'amount', 'currency_code', 'cost_date', 'is_actual'))
    elif op == 'poCostDelete': post(f"/purchase-orders/{res(a['po'])}/costs/{res(a['cost'])}/delete", {})
    elif op == 'poPay': post(f"/purchase-orders/{res(a['po'])}/pay", form(a, 'paid_from', 'amount', 'occurred_on', 'note', 'direct_currency', 'settled_amount', 'settled_currency') if a.get('amount') != 0 else {**form(a, 'paid_from'), 'amount': '0'})
    elif op == 'poPaymentDelete': post(f"/purchase-orders/{res(a['po'])}/payments/{a['kind']}/{res(a['entry'])}/delete", {})
    elif op == 'poReceive': post(f"/purchase-orders/{res(a['po'])}/receive", form(a, 'location_id'))
    elif op == 'poGroupReceive': post(f"/purchase-orders/{res(a['po'])}/box-groups/{res(a['group'])}/receive", form(a, 'location_id'))
    elif op == 'poGroupUnreceive': post(f"/purchase-orders/{res(a['po'])}/box-groups/{res(a['group'])}/unreceive", {})
    elif op == 'shipmentNew': post('/shipments/new', form(a, 'reference', 'container_no', 'bl_number', 'vessel', 'eta', 'notes'))
    elif op == 'shipmentEdit': post(f"/shipments/{res(a['shipment'])}/edit", form(a, 'reference', 'container_no', 'bl_number', 'vessel', 'eta', 'notes'))
    elif op == 'shipmentStage': post(f"/shipments/{res(a['shipment'])}/stage", form(a, 'status', 'when'))
    elif op == 'shipmentAssign': post(f"/shipments/{res(a['shipment'])}/assign", {'group_id': str(res(a['group']))})
    elif op == 'shipmentUnassign': post(f"/shipments/{res(a['shipment'])}/unassign", {'group_id': str(res(a['group']))})
    elif op == 'shipmentReceive': post(f"/shipments/{res(a['shipment'])}/receive", form(a, 'location_id'))
    elif op == 'locationNew': post('/locations/new', form(a, 'name', 'kind', 'parent_id', 'notes'))
    elif op == 'locationEdit': post(f"/locations/{res(a['location'])}/edit", form(a, 'name', 'kind', 'parent_id', 'notes', 'archived'))
    elif op == 'locationsPlace': post('/locations/place', form(a, 'to_location_id', 'label', 'po_id'))
    elif op == 'priceTierSet': post('/price-list/tiers/new', form(a, 'po_id', 'label', 'price_per_pair', 'min_boxes', 'currency_code', 'notes'))
    elif op == 'priceTierDelete': post(f"/price-list/tiers/{res(a['tier'])}/delete", {})
    # money
    elif op == 'currencyNew': post('/currencies/new', form(a, 'code', 'name', 'symbol', 'decimals'))
    elif op == 'rateNew': post('/currencies/rates/new', form(a, 'currency_code', 'effective_from', 'direction', 'rate', 'note'))
    elif op == 'rateEdit': post(f"/currencies/rates/{res(a['rate'])}/edit", {**form(a, 'direction', 'effective_from', 'note', 'restamp'), 'rate': str(a['rate_value'])})
    elif op == 'rateDelete': post(f"/currencies/rates/{res(a['rate'])}/delete", {})
    elif op == 'accountNew': post('/accounts/new', form(a, 'name', 'account_type', 'currency_code', 'opening_balance', 'notes'))
    elif op == 'accountEdit': post(f"/accounts/{res(a['account'])}/edit", form(a, 'name', 'account_type', 'currency_code', 'opening_balance', 'notes', 'archived'))
    elif op == 'accountAdjust': post(f"/accounts/{res(a['account'])}/adjust", {**form(a, 'occurred_on', 'description'), 'amount': str(a['amount'])})
    elif op == 'accountTransfer': post('/accounts/transfer', {**form(a, 'from_account_id', 'to_account_id', 'occurred_on', 'description', 'received_amount'), 'amount': str(a['amount'])})
    elif op == 'transferDelete': post(f"/accounts/transfers/{res(a['group'])}/delete", {})
    elif op == 'partnerNew': post('/partners/new', form(a, 'name', 'ownership_percent', 'email', 'phone', 'notes'))
    elif op == 'partnerEdit': post(f"/partners/{res(a['partner'])}/edit", form(a, 'name', 'ownership_percent', 'email', 'phone', 'notes', 'archived'))
    elif op == 'partnerDelete': post(f"/partners/{res(a['partner'])}/delete", {})
    elif op == 'partnerLoan': post(f"/partners/{res(a['partner'])}/loan", form(a, 'amount', 'account_id', 'occurred_on', 'note', 'settled_amount', 'settled_currency'))
    elif op == 'partnerRepay': post(f"/partners/{res(a['partner'])}/repay", form(a, 'amount', 'account_id', 'occurred_on', 'note', 'settled_amount', 'settled_currency'))
    elif op == 'partnerEntryDelete': post(f"/partners/ledger/{res(a['entry'])}/delete", {})
    elif op == 'distribute': post('/partners/distribute', form(a, 'total_amount', 'account_id', 'occurred_on', 'notes', 'override'))
    elif op == 'distributionDelete': post(f"/partners/distributions/{res(a['distribution'])}/delete", {})
    elif op == 'expenseNew': post('/expenses/new', {**form(a, 'category', 'description', 'currency_code', 'expense_date', 'paid_from'), 'amount': str(a['amount']), 'category': a['category']})
    elif op == 'expenseEdit': post(f"/expenses/{res(a['expense'])}/edit", {**form(a, 'category', 'description', 'amount', 'currency_code', 'expense_date'), 'paid_from': str(res(a.get('paid_from', '')) or '')})
    elif op == 'expenseDelete': post(f"/expenses/{res(a['expense'])}/delete", {})
    elif op == 'costCorrectionsFix': post('/reports/cost-corrections/fix', {})
    else: raise SystemExit('unknown op ' + op)
    changed = checksum() != before
    if step.get('save'):
        import re as _re
        table = {'c': 'customers', 'p': 'products', 'v': 'variants', 'o': 'orders', 'sup': 'suppliers', 'po': 'purchase_orders',
                 'as': 'assortments', 'loc': 'locations', 'sh': 'shipments',
                 'acc': 'cash_accounts', 'pt': 'partners', 'rt': 'exchange_rates', 'ex': 'expenses', 'dist': 'distributions'}[_re.match('[a-z]+', step['save']).group(0)]
        names[step['save']] = val(f'SELECT MAX(id) FROM "{table}"')
    log.append({'op': op, 'ok': changed})
# The app keeps recent changes in a WAL file: copy through SQLite so they're included.
with conn() as _src:
    _dst = sqlite3.connect(db_out)
    _src.backup(_dst)
    _dst.close()
print(json.dumps(log))

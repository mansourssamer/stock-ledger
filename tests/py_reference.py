"""Reference figures from the original Python app, for the differential test.
    python3 tests/py_reference.py /path/to/old-app-folder /path/to/erp.db > ref.json
"""
import json, sys, os, shutil, tempfile
app_dir, db_path = sys.argv[1], sys.argv[2]
work = tempfile.mkdtemp()
shutil.copytree(app_dir, os.path.join(work, 'erp'), ignore=shutil.ignore_patterns('erp.db', 'backups', '__pycache__'))
shutil.copy(db_path, os.path.join(work, 'erp', 'erp.db'))
sys.path.insert(0, os.path.join(work, 'erp'))
os.chdir(os.path.join(work, 'erp'))
import app as A, db as D

def rows(rs): return [dict(r) for r in rs]
out = {}
with A.app.test_request_context('/'):
    c = D.get_conn()
    out['stock_value'] = D.stock_value_landed(c)
    out['all_variant_stock'] = rows(D.all_variant_stock(c))
    out['cash'] = D.total_cash_on_hand(c)
    out['products'] = {str(p['id']): rows(D.variants_for_product(c, p['id'])) for p in c.execute('SELECT id FROM products')}
    out['orders'] = {str(o['id']): list(A._order_total(c, o['id'])) for o in c.execute('SELECT id FROM orders')}
    out['box_lines'] = {str(o['id']): [{k: v for k, v in l.items()} for l in A._order_box_lines(c, o['id'])] for o in c.execute('SELECT id FROM orders')}
    out['invoices'] = {str(i['id']): A._invoice_financials(c, i['id']) for i in c.execute('SELECT id FROM invoices')}
    out['customers'] = {}
    for cu in c.execute('SELECT id FROM customers').fetchall():
        s = A._customer_summary(c, cu['id'])
        s['last_payment'] = dict(s['last_payment']) if s['last_payment'] else None
        led = A._customer_ledger(c, cu['id'])
        out['customers'][str(cu['id'])] = {'summary': s, 'ledger': [{k: e[k] for k in ('when', 'kind', 'order_id', 'charge', 'payment', 'balance', 'currency_code', 'fx')} for e in led],
                                            'buying': rows(A._customer_buying(c, cu['id'])), 'uninvoiced': len(A._uninvoiced_fulfilled(c, cu['id']))}
    # dashboard numbers
    rv = c.execute(f"SELECT i.id, ({A.ORDER_VALUE_SQL}) as value, COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0) as paid, COALESCE(o.fx_rate_to_usd, 1) as fx FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.status != 'void'").fetchall()
    out['outstanding_total'] = sum(max(r['value'] - r['paid'], 0) * r['fx'] for r in rv)
    out['outstanding_count'] = sum(1 for r in rv if r['value'] - r['paid'] > 0.004)
print(json.dumps(out, default=str))

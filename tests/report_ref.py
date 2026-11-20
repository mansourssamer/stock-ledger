"""The data the OLD app's report pages are given (captured from Flask as each page renders),
as JSON, plus a spec of the same pages for tests/report_js.mjs.
    python3 tests/report_ref.py OLD_APP_DIR erp.db out_ref.json out_spec.json"""
import json, os, shutil, sqlite3, sys, tempfile, datetime as dt
app_dir, db_in, out_ref, out_spec = sys.argv[1:5]
work = tempfile.mkdtemp()
shutil.copytree(app_dir, os.path.join(work, 'erp'), ignore=shutil.ignore_patterns('erp.db', 'backups', '__pycache__', 'static'))
os.makedirs(os.path.join(work, 'erp', 'static', 'uploads', 'products'), exist_ok=True)
shutil.copy(db_in, os.path.join(work, 'erp', 'erp.db'))
c = sqlite3.connect(os.path.join(work, 'erp', 'erp.db')); c.execute('DELETE FROM users'); c.commit()
days = [r[0] for r in c.execute("SELECT DISTINCT substr(fulfilled_at,1,10) FROM orders WHERE fulfilled_at IS NOT NULL ORDER BY 1 DESC LIMIT 6")]
days += [r[0] for r in c.execute("SELECT DISTINCT expense_date FROM expenses ORDER BY 1 DESC LIMIT 2")]
days += [r[0] for r in c.execute("SELECT DISTINCT substr(created_at,1,10) FROM returns ORDER BY 1 DESC LIMIT 2")]
months = sorted({d[:7] for d in days})
c.close()
os.environ.pop('ERP_REQUIRE_LOGIN', None)
sys.path.insert(0, os.path.join(work, 'erp')); os.chdir(os.path.join(work, 'erp'))
import app as A  # noqa: E402
from flask import template_rendered  # noqa: E402
A.app.config['TESTING'] = True
client = A.app.test_client()
today = dt.datetime.utcnow().strftime('%Y-%m-%d')
first_day = min(days) if days else today
pages = []
for p in ['all', '90', '30', '7']:
    pages += [dict(name=f'overview-{p}', url=f'/reports?range={p}', js=['overview', p]),
              dict(name=f'pnl-{p}', url=f'/reports/pnl?range={p}', js=['pnl', p]),
              dict(name=f'cash-{p}', url=f'/reports/cash-flow?range={p}', js=['cashFlow', p]),
              dict(name=f'costing-{p}', url=f'/reports/costing?range={p}', js=['costing', p])]
pages.append(dict(name='pnl-custom', url=f'/reports/pnl?range=custom&start={first_day}&end={today}', js=['pnl', 'custom', first_day, today]))
pages.append(dict(name='balance', url='/reports/balance-sheet', js=['balanceSheet']))
for d in sorted(set(days + [today])):
    pages.append(dict(name=f'daily-{d}', url=f'/reports/daily?date={d}', js=['dailyReport', d]))
for pr in ['all', 'this_month', 'last_month', 'last_30', 'last_week', 'this_year']:
    pages.append(dict(name=f'sales-{pr}', url=f'/reports/sales?preset={pr}', js=['sales', pr]))
pages.append(dict(name='sales-all-week', url='/reports/sales?preset=all&group=week', js=['sales', 'all', '', '', 'week']))
pages.append(dict(name='sales-all-month', url='/reports/sales?preset=all&group=month', js=['sales', 'all', '', '', 'month']))
pages.append(dict(name='sales-custom', url=f'/reports/sales?start={first_day}&end={today}&group=day', js=['sales', '', first_day, today, 'day']))
for m in months + [today[:7]]:
    pages.append(dict(name=f'monthly-{m}', url=f'/reports/monthly?month={m}', js=['monthly', m]))
cc = sqlite3.connect(os.path.join(work, 'erp', 'erp.db'))
prod = cc.execute("SELECT v.product_id FROM order_items oi JOIN variants v ON v.id = oi.variant_id GROUP BY v.product_id ORDER BY COUNT(*) DESC LIMIT 1").fetchone()
prod2 = cc.execute("SELECT id FROM products ORDER BY id LIMIT 1").fetchone()
contacts = [r[0] for r in cc.execute("SELECT id FROM crm_contacts ORDER BY id LIMIT 4")]
zones = [r[0] for r in cc.execute("SELECT id FROM crm_zones ORDER BY id LIMIT 1")]
cc.close()
pages += [dict(name='crm-home', url='/crm', js=['crmHome']), dict(name='crm-customers', url='/crm/customers', js=['crmCustomers', '']),
          dict(name='crm-customers-regular', url='/crm/customers?group=regular', js=['crmCustomers', 'regular']),
          dict(name='crm-report', url='/crm/report', js=['crmReport']), dict(name='crm-zones', url='/crm/zones', js=['zonesPage']),
          dict(name='crm-contacts', url='/crm/contacts', js=['contactRows', {}]), dict(name='crm-contacts-all', url='/crm/contacts?show=all', js=['contactRows', {'show': 'all'}]),
          dict(name='proformas', url='/proformas', js=['proformasPage'])]
for p_ in [x for x in (prod, prod2) if x]:
    pages.append(dict(name=f'announce-{p_[0]}', url=f'/crm/announce?product_id={p_[0]}', js=['announce', {'product_id': p_[0]}]))
    pages.append(dict(name=f'announce-all-{p_[0]}', url=f'/crm/announce?product_id={p_[0]}&who=bought&who=asked&who=customers&who=prospects', js=['announce', {'product_id': p_[0], 'who': ['bought', 'asked', 'customers', 'prospects']}]))
if zones:
    pages.append(dict(name='crm-contacts-zone', url=f'/crm/contacts?zone={zones[0]}', js=['contactRows', {'zone': str(zones[0])}]))
for k in contacts:
    pages.append(dict(name=f'crm-contact-{k}', url=f'/crm/contacts/{k}', js=['contactPage', k]))
pages += [dict(name='partners', url='/partners', js=['partnersPage']), dict(name='accounts', url='/accounts', js=['accountsPage']),
          dict(name='expenses', url='/expenses', js=['expensesPage']), dict(name='currencies', url='/currencies', js=['currenciesPage'])]
SKIP = {'crm', 'products', 'zones', 'text', 'mailto', 'whatsapp', 'row_label', 'long_date', 'request', 'session', 'g', 'config', 'get_flashed_messages', 'url_for', 'csv_link', 'print_link',
        'prev_link', 'next_link', 'partner_emails', 'generated', 'as_of', 'month_name', 'range_label', 'prev_label', 'account_types', 'currencies', 'accounts_choices'}
def clean(v):
    if isinstance(v, sqlite3.Row): return {k: clean(v[k]) for k in v.keys()}
    if isinstance(v, dict): return {str(k): clean(x) for k, x in v.items() if k not in SKIP and not callable(x)}
    if isinstance(v, (list, tuple)): return [clean(x) for x in v]
    if isinstance(v, set): return sorted(clean(x) for x in v)
    if isinstance(v, (dt.datetime, dt.date)): return v.strftime('%Y-%m-%d')
    if callable(v): return None
    return v
out = {}
for p in pages:
    got = []
    def rec(sender, template, context, **kw): got.append(context)
    template_rendered.connect(rec, A.app)
    r = client.get(p['url'])
    template_rendered.disconnect(rec, A.app)
    assert r.status_code == 200, (p['url'], r.status_code)
    out[p['name']] = clean({k: v for k, v in got[0].items() if not k.startswith('_')})
json.dump(out, open(out_ref, 'w'), default=str)
json.dump(pages, open(out_spec, 'w'))
print(len(pages), 'pages')

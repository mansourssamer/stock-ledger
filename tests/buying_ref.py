"""The old app's buying plan on a database, as JSON (for comparing with the new app).
    python3 tests/buying_ref.py OLD_APP_DIR erp.db YYYY-MM-DD > old_plan.json"""
import json, sqlite3, sys
from datetime import datetime
sys.path.insert(0, sys.argv[1])
import buying  # noqa: E402
c = sqlite3.connect(sys.argv[2]); c.row_factory = sqlite3.Row
p = buying.plan(c, today=datetime.strptime(sys.argv[3], '%Y-%m-%d'))
d = lambda x: x.strftime('%Y-%m-%d') if x else None
KEYS = ['key', 'label', 'abc', 'label_key', 'in_stock', 'on_order', 'received', 'sold', 'returned', 'net_sold', 'sell_through', 'exposure', 'exposure_recent',
        'rate_window', 'rate_recent', 'rate', 'missed_window', 'hist_factor', 'base_raw', 'base', 'shrunk', 'cost_box', 'price_box', 'margin', 'gp_window',
        'gp_all', 'gmroi', 'demand_lead', 'demand_cover', 'sigma', 'safety', 'need', 'raw', 'rec', 'plan', 'trimmed', 'weeks_cover', 'stock_age', 'first_day', 'win_start']
out = dict(rows=[dict({k: r[k] for k in KEYS}, stockout=d(r['stockout']), order_by=d(r['order_by']), weeks=r['weeks'], notes=len(r['notes']), warnings=len(r['warnings'])) for r in p['rows']],
           pace=p['pace'], planned=p['planned'], container_weeks=p['container_weeks'], topped=p['topped'], trimmed=p['trimmed'], next_order=d(p['next_order']),
           prior=p['prior'], counts=p['counts'], deadlines=[dict(name=e['name'], status=e['status'], order_by=d(e['order_by'])) for e in p['deadlines']],
           requested_only=p['requested_only'], lead_measured=[[i, w] for i, w in p['lead_measured']], models=sorted(buying.models(c).keys()))
print(json.dumps(out, ensure_ascii=False, default=str))

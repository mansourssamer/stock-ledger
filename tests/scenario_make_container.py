"""A full container in one day: a purchase order of 1,000 boxes in five mixes of six sizes,
received, then 60 boxes sold. Run with diff_run.sh like the other scenarios; then
tests/bucket_limits.py checks the new app's Firestore documents for that day stay inside
Firestore's limits.
    python3 tests/scenario_make_container.py erp.db > scenario.json"""
import json, sqlite3, sys

c = sqlite3.connect(sys.argv[1])
c.row_factory = sqlite3.Row
one = lambda s, *a: c.execute(s, a).fetchone()
has_rate = lambda code: code == 'USD' or one("SELECT 1 FROM exchange_rates WHERE currency_code = ?", code) is not None
po_cur = 'CNY' if has_rate('CNY') else 'USD'
prod = one("SELECT id FROM products ORDER BY id")['id']
cust = one("SELECT id FROM customers ORDER BY id")['id']

S = []
add = lambda op, save=None, **args: S.append(dict(op=op, args=args, **({'save': save} if save else {})))
add('supplierNew', 'sup9', name='Fournisseur Conteneur')
add('poNew', 'po9', supplier_id='$sup9', currency_code=po_cur, notes='Conteneur complet')
for i, color in enumerate(['Noir C', 'Blanc C', 'Gris C', 'Bleu C', 'Rouge C']):
    label = f'Mix{i + 1}'
    add('poTypeRun', po='$po9', product_id=prod, color=color, box_label=label, unit_cost=40 + i, run='39x2, 40x2, 41x2, 42x2, 43x2, 44x2')
    add('poSetBoxCount', po='$po9', group=f'$po9.group:{label}', box_count=200)
add('poCostNew', po='$po9', description='Fret maritime', amount=6500, currency_code='USD', is_actual=0)
add('poReceive', po='$po9')
add('orderNew', 'o9', customer_id=cust, currency_code='GNF', notes='Gros client')
for i in range(3):
    add('orderAttachBoxes', order='$o9', po_id='$po9', label=f'Mix{i + 1}', qty=20, price_per_box=2500000)
add('orderFulfill', order='$o9', credit_ok=1)
print(json.dumps(S, ensure_ascii=False, indent=1))

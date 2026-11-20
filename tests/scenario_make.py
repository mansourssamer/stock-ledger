"""Builds a selling scenario from a database (picks real customers, mixes, sizes), so the
same steps can run through the old app and the new one.
    python3 tests/scenario_make.py erp.db > scenario.json
Steps refer to things made earlier by name ("$o1"); "$o1.line0" is that order's first box
line, "$o1.item0" its first loose-pair line, "$o1.inv" its live invoice, "$o1.pay0" the
first payment on it."""
import json, sqlite3, sys, datetime

c = sqlite3.connect(sys.argv[1])
c.row_factory = sqlite3.Row
q = lambda s, *a: c.execute(s, a).fetchall()
one = lambda s, *a: c.execute(s, a).fetchone()

today = datetime.datetime.now(datetime.timezone.utc).date()
d = lambda n: (today - datetime.timedelta(days=n)).isoformat()
mixes = q("""SELECT source_po_id, source_label, COUNT(*) n FROM boxes WHERE status = 'in_stock'
             GROUP BY source_po_id, source_label HAVING n >= 3 ORDER BY n DESC, source_label""")
assert len(mixes) >= 2, 'need two mixes with 3+ sealed boxes'
m1, m2 = mixes[0], mixes[1]
m3 = mixes[2] if len(mixes) > 2 else mixes[0]
cust = q("SELECT id FROM customers ORDER BY id")
c1 = cust[0]['id']
c2 = cust[-1]['id']
acct = one("SELECT id, currency_code FROM cash_accounts WHERE archived = 0 ORDER BY id")
acct_other = one("SELECT id FROM cash_accounts WHERE archived = 0 AND currency_code != ? ORDER BY id", acct['currency_code'] if acct else 'USD')
# a size in mix 2 (opened below, so its pairs can be sold singly)
v2 = one("""SELECT bi.variant_id FROM box_items bi JOIN boxes b ON b.id = bi.box_id
            WHERE b.source_po_id IS ? AND b.source_label = ? ORDER BY bi.qty DESC, bi.variant_id LIMIT 1""",
         m2['source_po_id'], m2['source_label'])['variant_id']
loc = q("SELECT id FROM locations WHERE archived = 0 ORDER BY id")
prod = one("SELECT id FROM products ORDER BY id")['id']
anyvar = one("SELECT id FROM variants ORDER BY id")['id']
po1, l1 = m1['source_po_id'], m1['source_label']
po2, l2 = m2['source_po_id'], m2['source_label']
po3, l3 = m3['source_po_id'], m3['source_label']

S = []
add = lambda op, save=None, **args: S.append(dict(op=op, args=args, **({'save': save} if save else {})))
add('customerNew', 'c9', name='Client Test Diff', phone='+224 600 00 00 00', discount_percent=5, credit_limit='', credit_currency='GNF')
add('customerEdit', customer='$c9', name='Client Test Diff (édité)', phone='+224 611 11 11 11', discount_percent=0, credit_limit=50000000, credit_currency='GNF')
add('productNew', 'p9', sku_prefix='TST-DIFF', name='Modèle test', brand='Test', category='Sneakers', cost_price=8, sale_price=12, reorder_level=2)
add('productAddSize', 'v9', product='$p9', color='Noir', size='42', initial_qty=10)
add('productAddSize', product='$p9', color='Noir', size='43', initial_qty=0)
add('variantAdjust', variant=anyvar, delta=4, note='Comptage')
add('variantRename', variant='$v9', color='Noir', size='42.5')
add('boxOpenOne', po_id=po2, label=l2)
# order 1: two days ago, boxes + loose pairs, delivered yesterday, partly paid, returns
add('orderNew', 'o1', customer_id=c1, currency_code='GNF', notes='Test diff 1', order_date=d(2))
add('orderAttachBoxes', order='$o1', po_id=po1, label=l1, qty=2, price_per_pair=21000)
add('orderAttachBoxes', order='$o1', po_id=po3, label=l3, qty=1, price_per_box=2500000)
add('orderAddItem', order='$o1', variant_id=v2, qty=3, price_per_pair=27500)
add('orderBoxLineEdit', order='$o1', line='$o1.line0', qty_boxes=3, price_per_box=2400000)
add('orderItemEdit', order='$o1', item='$o1.item0', qty=4, unit_price=26000)
add('orderFulfill', order='$o1', delivered_on=d(1), credit_ok=1)
add('invoicePay', invoice='$o1.inv', amount=3000000, paid_on=d(1), account_id=acct['id'] if acct else '', note='Avance')
if acct_other:
    add('invoicePay', invoice='$o1.inv', amount=1000000, paid_on=d(0), account_id=acct_other['id'], note='Autre compte')
add('invoicePay', invoice='$o1.inv', amount=500000, paid_on=d(0), account_id='', note='Sans compte')
add('invoicePaymentDelete', payment='$o1.pay_last')
add('orderItemReturn', order='$o1', item='$o1.item0', qty=1, restock=1, reason='Taille')
add('orderItemReturn', order='$o1', item='$o1.item0', qty=1, restock=0, reason='Abîmée')
add('orderBoxLineReturn', order='$o1', line='$o1.line0', qty=1, restock=1, reason='Retour carton')
add('orderEdit', order='$o1', customer_id=c1, currency_code='GNF', notes='Test diff 1 (modifié)', order_date=d(2), delivered_on=d(0))
# order 2: delivered then cancelled
add('orderNew', 'o2', customer_id=c2, currency_code='USD', notes='Test diff 2')
add('orderAttachBoxes', order='$o2', po_id=po2, label=l2, qty=1, price_per_pair=18.5)
add('orderAddItem', order='$o2', variant_id=v2, qty=2, price_per_pair=22)
add('orderFulfill', order='$o2', credit_ok=1)
add('invoicePay', invoice='$o2.inv', amount=10, account_id='', note='')
add('orderCancel', order='$o2')
# order 3: made then deleted
add('orderNew', 'o3', customer_id=c1, currency_code='GNF', notes='Test diff 3')
add('orderAttachBoxes', order='$o3', po_id=po1, label=l1, qty=1, price_per_box=2000000)
add('orderBoxLineDelete', order='$o3', line='$o3.line0')
add('orderAttachBoxes', order='$o3', po_id=po1, label=l1, qty=1, price_per_box=2100000)
add('orderDelete', order='$o3')
# order 4: a new customer, invoice before delivery, then delivered
add('orderNew', 'o4', customer_id='$c9', currency_code='GNF', notes='')
add('orderAttachBoxes', order='$o4', po_id=po1, label=l1, qty=1, price_per_box=2600000)
add('orderCreateInvoice', order='$o4')
add('orderFulfill', order='$o4', credit_ok=1)
add('invoicePay', invoice='$o4.inv', pay_in_full=1, account_id=acct['id'] if acct else '')
# order 5: invoiced, the invoice voided, invoiced again and paid in part
add('orderNew', 'o5', customer_id=c2, currency_code='GNF', notes='Test diff 5')
add('orderAttachBoxes', order='$o5', po_id=po1, label=l1, qty=1, price_per_box=2400000)
add('orderCreateInvoice', order='$o5')
add('invoicePay', invoice='$o5.inv', amount=400000, account_id='', note='Avant annulation')
add('invoiceVoid', invoice='$o5.inv')
add('orderCreateInvoice', order='$o5')
add('invoicePay', invoice='$o5.inv', amount=600000, account_id=acct['id'] if acct else '', note='Après')
# refusals must change nothing
add('orderAttachBoxes', order='$o4', po_id=po1, label=l1, qty=99999, price_per_box=1, expect_refusal=1)
add('orderFulfill', order='$o4', credit_ok=1, expect_refusal=1)
# boxes
add('boxCountFirstOpen', missing=1)
if len(loc) >= 2:
    add('locationMove', from_location_id=loc[0]['id'], to_location_id=loc[1]['id'], po_id=po1, label=l1, qty=2, note='Rangement')
print(json.dumps(S, ensure_ascii=False, indent=1))

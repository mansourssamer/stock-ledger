"""Builds a purchasing scenario from a database (real suppliers, accounts, partners, styles),
so the same steps can run through the old app and the new one.
    python3 tests/scenario_make_buy.py erp.db > scenario.json
Saved names: sup* suppliers, po* purchase orders, as* size runs, loc* locations, sh* shipments,
o* orders. "$po9.group:MixB" is that PO's mix by name, "$po9.item0" its first line,
"$po9.cost0" / "$po9.cost_last" its cost lines, "$po9.pay_last" its last account payment,
"$po9.ppay_last" its last direct partner payment, "$po9.tier:MixB:3" the "from 3 boxes" price,
"$as9.line0" a size run's first size."""
import json, sqlite3, sys, datetime

c = sqlite3.connect(sys.argv[1])
c.row_factory = sqlite3.Row
q = lambda s, *a: c.execute(s, a).fetchall()
one = lambda s, *a: c.execute(s, a).fetchone()
today = datetime.datetime.now(datetime.timezone.utc).date()
d = lambda n: (today - datetime.timedelta(days=n)).isoformat()

has_rate = lambda code: code == 'USD' or one("SELECT 1 FROM exchange_rates WHERE currency_code = ?", code) is not None
po_cur = 'CNY' if has_rate('CNY') else 'USD'
gnf = 'GNF' if has_rate('GNF') else 'USD'
acct_usd = one("SELECT id FROM cash_accounts WHERE archived = 0 AND currency_code = 'USD' ORDER BY id")
acct_gnf = one("SELECT id FROM cash_accounts WHERE archived = 0 AND currency_code = ? ORDER BY id", gnf)
partner = one("SELECT id FROM partners ORDER BY id")
locs = [r['id'] for r in q("SELECT id FROM locations WHERE archived = 0 ORDER BY id")]
prods = [r['id'] for r in q("SELECT id FROM products ORDER BY id")]
prod, prod2 = prods[0], prods[-1]
vars_ = [r['id'] for r in q("SELECT id FROM variants ORDER BY id LIMIT 2")]
cust = one("SELECT id FROM customers ORDER BY id")['id']

S = []
add = lambda op, save=None, **args: S.append(dict(op=op, args=args, **({'save': save} if save else {})))
add('supplierNew', 'sup9', name='Fournisseur Test Diff', phone='+86 20 0000 0000', email='test@example.com')
add('supplierEdit', supplier='$sup9', name='Fournisseur Test Diff (édité)', phone='+86 20 1111 1111', address='Guangzhou')
add('supplierNew', 'sup8', name='À supprimer')
add('supplierDelete', supplier='$sup8')
# a purchase order with three mixes
add('poNew', 'po9', supplier_id='$sup9', currency_code=po_cur, notes='Test achat')
add('poAddItem', po='$po9', variant_id=vars_[0], qty=6, box_label='MixA', unit_cost=50)
add('poAddItem', po='$po9', variant_id=vars_[-1], qty=4, box_label='MixA', unit_cost='')
add('poTypeRun', po='$po9', product_id=prod, color='Noir Test', box_label='MixB', unit_cost=45, run='40x2, 41x3, 42x5, 43:2, abc')
add('poTypeRun', po='$po9', product_id=prod, color='Noir Test', box_label='MixB', unit_cost=45, run='rien', expect_refusal=1)
add('poSetBoxCount', po='$po9', group='$po9.group:MixB', box_count=3)
add('poSetBoxCount', po='$po9', group='$po9.group:MixB', box_count=0, expect_refusal=1)
add('poItemEdit', po='$po9', item='$po9.item0', qty=8, unit_cost=48)
add('assortmentNew', 'as9', name='Série test diff', notes='', run='39x1, 40x2, 41x2, 42x1')
add('assortmentLineAdd', assortment='$as9', size='43', qty=1)
add('assortmentLineAdd', assortment='$as9', size='40', qty=3)
add('assortmentLineDelete', assortment='$as9', line='$as9.line0')
add('poApplyRun', po='$po9', assortment_id='$as9', product_id=prod2, color='Blanc Test', box_label='MixC', unit_cost=40)
add('poSaveRun', po='$po9', group='$po9.group:MixB', name='Série B diff')
add('assortmentNew', 'as8', name='Série à supprimer', run='')
add('assortmentDelete', assortment='$as8')
add('poItemDelete', po='$po9', item='$po9.item1')
# landed costs and payments
add('poCostNew', po='$po9', description='Fret maritime', amount=1200, currency_code='USD', is_actual=0)
add('poCostNew', po='$po9', description='Dédouanement', amount=8600000, currency_code=gnf, cost_date=d(1), is_actual=1)
add('poCostEdit', po='$po9', cost='$po9.cost0', description='Fret (révisé)', amount=1500, currency_code='USD', is_actual=0)
if acct_usd:
    add('poPay', po='$po9', paid_from=f"acct:{acct_usd['id']}", amount=500, occurred_on=d(2), note='Acompte')
if acct_gnf:
    add('poPay', po='$po9', paid_from=f"acct:{acct_gnf['id']}", amount=4300000, settled_amount=480, settled_currency='USD', occurred_on=d(1))
    add('poPay', po='$po9', paid_from=f"acct:{acct_gnf['id']}", amount=100000, occurred_on=d(0), note='À annuler')
    add('poPaymentDelete', po='$po9', kind='cash', entry='$po9.pay_last')
if partner:
    add('poPay', po='$po9', paid_from=f"partner:{partner['id']}", amount=300, direct_currency='USD', note='Payé par associé')
    add('poPay', po='$po9', paid_from=f"partner:{partner['id']}", amount=50, direct_currency='USD', note='À annuler')
    add('poPaymentDelete', po='$po9', kind='partner', entry='$po9.ppay_last')
add('poPay', po='$po9', paid_from=f"acct:{acct_usd['id'] if acct_usd else 1}", amount=0, expect_refusal=1)
add('poPay', po='$po9', amount=10, expect_refusal=1)
# locations and receiving
add('locationNew', 'loc9', name='Dépôt test diff', kind='warehouse', notes='')
add('locationEdit', location='$loc9', name='Dépôt test diff (édité)', kind='shop', parent_id=locs[0] if locs else '', notes='Étagère 3')
add('poGroupReceive', po='$po9', group='$po9.group:MixA', location_id='$loc9')
add('poGroupReceive', po='$po9', group='$po9.group:MixA', expect_refusal=1)
add('poReceive', po='$po9')
add('poCostNew', po='$po9', description='Transport camion', amount=2000000, currency_code=gnf, cost_date=d(0), is_actual=1)
# sell a box of MixB, then correct a cost: the sold part becomes a cost-of-goods adjustment
add('orderNew', 'o9', customer_id=cust, currency_code='GNF', notes='Vente test achat')
add('orderAttachBoxes', order='$o9', po_id='$po9', label='MixB', qty=1, price_per_box=3000000)
add('orderFulfill', order='$o9', credit_ok=1)
add('poCostEdit', po='$po9', cost='$po9.cost_last', description='Transport camion', amount=2500000, currency_code=gnf, cost_date=d(0), is_actual=1)
add('poCostDelete', po='$po9', cost='$po9.cost0')
add('poGroupUnreceive', po='$po9', group='$po9.group:MixB', expect_refusal=1)
add('poGroupUnreceive', po='$po9', group='$po9.group:MixC')
add('poSetBoxCount', po='$po9', group='$po9.group:MixC', box_count=2)
add('poGroupDelete', po='$po9', group='$po9.group:MixC')
add('poEdit', po='$po9', supplier_id='$sup9', notes='Test achat (modifié)', currency_code='USD')
# price list
add('priceTierSet', po_id='$po9', label='MixB', min_boxes=1, price_per_pair=26000, currency_code='GNF')
add('priceTierSet', po_id='$po9', label='MixB', min_boxes=3, price_per_pair=27000)
add('priceTierSet', po_id='$po9', label='MixB', min_boxes=3, price_per_pair=24000, notes='Prix gros')
add('priceTierSet', po_id='$po9', label='MixB', min_boxes=2, price_per_pair=25000, currency_code='USD')
add('priceTierSet', po_id='$po9', label='MixB', min_boxes=1, price_per_pair=26000, currency_code='USD', expect_refusal=1)
add('priceTierDelete', tier='$po9.tier:MixB:1', expect_refusal=1)
add('priceTierDelete', tier='$po9.tier:MixB:3')
add('priceTierSet', po_id='$po9', label='MixA', min_boxes=2, price_per_pair=1000, expect_refusal=1)
add('priceTierSet', po_id='$po9', label='MixA', min_boxes='x', price_per_pair=1000, expect_refusal=1)
# a shipment carrying a second purchase order
add('shipmentNew', 'sh9', reference='CONT-TEST-1', container_no='MSCU1234567', eta=d(-10))
add('shipmentEdit', shipment='$sh9', reference='CONT-TEST-1', container_no='MSCU1234567', bl_number='BL-998', vessel='MSC Test', eta=d(-12), notes='Arrive bientôt')
add('poNew', 'po10', supplier_id='$sup9', currency_code='USD')
add('poTypeRun', po='$po10', product_id=prod, color='Rouge Test', box_label='MixD', unit_cost=7.5, run='40x6, 41x6')
add('poSetBoxCount', po='$po10', group='$po10.group:MixD', box_count=2)
add('poAddItem', po='$po10', variant_id=vars_[0], qty=12, box_label='MixE', unit_cost=6)
add('shipmentAssign', shipment='$sh9', group='$po10.group:MixD')
add('shipmentAssign', shipment='$sh9', group='$po10.group:MixE')
add('shipmentUnassign', shipment='$sh9', group='$po10.group:MixE')
add('shipmentStage', shipment='$sh9', status='shipped', when=d(5))
add('shipmentStage', shipment='$sh9', status='arrived')
add('shipmentStage', shipment='$sh9', status='bogus', expect_refusal=1)
add('shipmentReceive', shipment='$sh9', location_id=locs[-1] if locs else '')
add('shipmentReceive', shipment='$sh9', expect_refusal=1)
add('locationsPlace', to_location_id='$loc9', label='__all__')
# deleting
add('supplierDelete', supplier='$sup9', expect_refusal=1)
add('poNew', 'po11', supplier_id='$sup9', currency_code='USD')
add('poAddItem', po='$po11', variant_id=vars_[0], qty=2, box_label='MixF', unit_cost=5)
add('poDelete', po='$po11')
add('poDelete', po='$po9', expect_refusal=1)
add('poDelete', po='$po10')
print(json.dumps(S, ensure_ascii=False, indent=1))

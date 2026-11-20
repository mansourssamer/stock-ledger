"""Builds a money scenario from a database: currencies and rates (with correcting a rate and
re-valuing what was booked at it), accounts, transfers and conversions, partners' loans,
repayments and profit shares, and expenses paid from accounts or by partners.
    python3 tests/scenario_make_money.py erp.db > scenario.json
Saved names: acc* accounts, pt* partners, rt* rates, ex* expenses, dist* distributions.
"$acc9.tg_last" = the last transfer on that account; "$pt9.entry_last" = that partner's last entry."""
import json, sqlite3, sys, datetime
c = sqlite3.connect(sys.argv[1]); c.row_factory = sqlite3.Row
one = lambda s, *a: c.execute(s, a).fetchone()
today = datetime.datetime.now(datetime.timezone.utc).date()
d = lambda n: (today - datetime.timedelta(days=n)).isoformat()
has_gnf = one("SELECT 1 FROM currencies WHERE code = 'GNF'") is not None
G = 'GNF' if has_gnf else 'USD'
partner = one("SELECT id FROM partners WHERE archived = 0 ORDER BY id")
S = []
add = lambda op, save=None, **args: S.append(dict(op=op, args=args, **({'save': save} if save else {})))
add('currencyNew', code='aed', name='Dirham', symbol='AED ', decimals=2)
add('currencyNew', code='AED', name='Dirham', expect_refusal=1)
add('rateNew', 'rt8', currency_code='AED', effective_from=d(10), direction='units_per_usd', rate=3.6725, note='Banque')
if has_gnf:
    add('rateNew', 'rt9', currency_code='GNF', effective_from=d(3), direction='units_per_usd', rate=8650)
    add('rateNew', currency_code='GNF', effective_from=d(3), direction='units_per_usd', rate=8640, note='corrigé')
add('rateNew', currency_code='AED', rate=0, expect_refusal=1)
add('accountNew', 'acc9', name='Compte test GNF', account_type='cash', currency_code=G, opening_balance=1000000, notes='Caisse')
add('accountNew', 'acc8', name='Compte test USD', account_type='bank', currency_code='USD', opening_balance=200)
add('accountEdit', account='$acc9', name='Compte test GNF (édité)', account_type='cash', currency_code=G, opening_balance=1500000, notes='Caisse principale')
add('accountAdjust', account='$acc9', amount=50000, occurred_on=d(2), description='Écart de caisse')
add('accountAdjust', account='$acc9', amount=-20000)
add('accountAdjust', account='$acc9', amount=0, expect_refusal=1)
add('accountTransfer', from_account_id='$acc9', to_account_id='$acc8', amount=860000, occurred_on=d(2), description='Change')
add('accountTransfer', from_account_id='$acc9', to_account_id='$acc8', amount=430000, received_amount=48, occurred_on=d(1))
add('accountTransfer', from_account_id='$acc8', to_account_id='$acc9', amount=20, received_amount=180000)
add('transferDelete', group='$acc8.tg_last')
add('accountTransfer', from_account_id='$acc8', to_account_id='$acc8', amount=5, expect_refusal=1)
add('accountTransfer', from_account_id='$acc9', to_account_id='$acc8', amount=0, expect_refusal=1)
add('partnerNew', 'pt9', name='Associé test', ownership_percent=0, phone='+224 620 00 00 00')
add('partnerEdit', partner='$pt9', name='Associé test (édité)', ownership_percent=0, email='a@example.com')
add('partnerNew', name='Associé test', ownership_percent=150, expect_refusal=1)
add('partnerLoan', partner='$pt9', amount=5000000, account_id='$acc9', occurred_on=d(2), note='Apport')
add('partnerLoan', partner='$pt9', amount=5200000, account_id='$acc9', settled_amount=600, settled_currency='USD', occurred_on=d(1))
add('partnerRepay', partner='$pt9', amount=100, account_id='$acc8', note='Remboursement')
add('partnerRepay', partner='$pt9', amount=100000, account_id='$acc8', expect_refusal=1)
add('partnerRepay', partner='$pt9', amount=500000, account_id='$acc9', settled_amount=55, settled_currency='USD')
add('partnerEntryDelete', entry='$pt9.entry_last')
add('partnerDelete', partner='$pt9', expect_refusal=1)
add('partnerNew', 'pt8', name='À supprimer', ownership_percent=0)
add('partnerDelete', partner='$pt8')
add('distribute', 'dist9', total_amount=100, account_id='$acc8', occurred_on=d(0), notes='Test', override=1)
add('distributionDelete', distribution='$dist9')
add('distribute', total_amount=999999999, account_id='$acc8', expect_refusal=1)
add('expenseNew', 'ex9', category='Loyer', description='Magasin', amount=2000000, currency_code=G, expense_date=d(2), paid_from='acct:$acc9')
add('expenseNew', 'ex8', category='Transport', amount=50, currency_code='USD', expense_date=d(1), paid_from='acct:$acc9')
if partner:
    add('expenseNew', category='Douane', amount=300000, currency_code=G, paid_from=f"partner:{partner['id']}")
add('expenseNew', 'ex7', category='Divers', amount=15, currency_code='USD')
add('expenseNew', category='Divers', amount=0, currency_code='USD', expect_refusal=1)
add('expenseNew', category='', amount=10, currency_code='USD', expect_refusal=1)
add('expenseEdit', expense='$ex9', category='Loyer', description='Magasin (novembre)', amount=2000000, currency_code=G, expense_date=d(2), paid_from='acct:$acc9')
add('expenseEdit', expense='$ex8', category='Transport', amount=60, currency_code='USD', expense_date=d(1), paid_from='acct:$acc8')
if partner:
    add('expenseEdit', expense='$ex7', category='Divers', amount=15, currency_code='USD', expense_date=d(0), paid_from=f"partner:{partner['id']}")
add('expenseEdit', expense='$ex9', category='Loyer', amount=2100000, currency_code=G, expense_date=d(2), paid_from='')
add('expenseDelete', expense='$ex8')
if has_gnf:
    add('rateEdit', rate='$rt9', rate_value=8700, direction='units_per_usd', effective_from=d(3), note='Taux corrigé', restamp=1)
    free = next(n for n in range(4, 60) if not one("SELECT 1 FROM exchange_rates WHERE currency_code = 'GNF' AND effective_from = ?", d(n)))
    add('rateEdit', rate='$rt9', rate_value=8720, direction='units_per_usd', effective_from=d(free))
    add('rateEdit', rate='$rt9', rate_value=-1, expect_refusal=1)
add('rateEdit', rate='$rt8', rate_value=3.67, direction='units_per_usd', effective_from=d(10), restamp=1)
add('rateDelete', rate='$rt8')
add('costCorrectionsFix')
print(json.dumps(S, ensure_ascii=False, indent=1))

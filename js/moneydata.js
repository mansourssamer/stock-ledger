// What the money pages show (accounts_list, account_detail, partners_list, partner_detail,
// expenses_list, currencies_list in the old app), computed the same way.
import { all, one } from './localdb.js';
import * as Q from './queries.js';
import { exchangeResults, partnerPosition, netProfitUsd, distributedToDate } from './reports.js';
import { settlementResult } from './ops/purchasing.js';

export function accountsPage() {
  const accounts = Q.accountBalances(true);
  return { accounts, total: accounts.filter(a => !a.archived && a.balance_usd !== null).reduce((s, a) => s + a.balance_usd, 0),
    missing_rates: accounts.filter(a => !a.archived && a.balance_usd === null) };
}
export function accountDetail(id) {
  const a = one(`SELECT a.*, a.opening_balance + COALESCE((SELECT SUM(t.amount) FROM cash_transactions t WHERE t.account_id = a.id), 0) as balance FROM cash_accounts a WHERE a.id = ?`, [id]);
  if (!a) return null;
  const rate = Q.rateOn(a.currency_code);
  const fxByGroup = new Map(exchangeResults()[0].filter(r => r.transfer_group).map(r => [r.transfer_group, r.result_usd]));
  const transactions = all(`SELECT * FROM cash_transactions WHERE account_id = ? ORDER BY occurred_on DESC, id DESC LIMIT 200`, [id]).map(x => ({ ...x,
    fx_result: x.transfer_group ? (fxByGroup.get(x.transfer_group) ?? null) : (x.settled_amount !== null ? settlementResult(x.id) : null) }));
  return { account: { ...a, balance_usd: rate !== null ? a.balance * rate : null }, transactions,
    other_accounts: all(`SELECT * FROM cash_accounts WHERE id != ? AND archived = 0 ORDER BY name`, [id]) };
}
export function partnersPage() {
  const partners = all(`SELECT * FROM partners ORDER BY archived, name`).map(p => ({ ...p, ...partnerPosition(p.id) }));
  const profit = netProfitUsd(), distributed = distributedToDate();
  return { partners, total_percent: partners.filter(p => !p.archived).reduce((s, p) => s + p.ownership_percent, 0),
    owed_total: partners.reduce((s, p) => s + p.owed_usd, 0), profit_to_date: profit, distributed_to_date: distributed, available: profit - distributed,
    distributions: all(`SELECT d.*, a.name as account_name FROM distributions d LEFT JOIN cash_accounts a ON a.id = d.account_id ORDER BY d.occurred_on DESC, d.id DESC`) };
}
export function partnerDetail(id) {
  const partner = one(`SELECT * FROM partners WHERE id = ?`, [id]);
  if (!partner) return null;
  let owed = 0;
  const ledger = all(`SELECT l.*, t.account_id, a.name as account_name FROM partner_ledger l LEFT JOIN cash_transactions t ON t.id = l.cash_transaction_id
                      LEFT JOIN cash_accounts a ON a.id = t.account_id WHERE l.partner_id = ? ORDER BY l.occurred_on, l.id`, [id]).map(e => {
    const usd = e.amount * (e.fx_rate_to_usd || 1);
    if (e.kind === 'loan') owed += usd; else if (e.kind === 'repayment') owed -= usd;
    return { ...e, usd, owed_after: owed };
  });
  return { partner, ledger, position: partnerPosition(id) };
}
export function expensesPage() {
  const expenses = all(`SELECT e.*, (SELECT a.name FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id WHERE t.ref_type = 'expense' AND t.ref_id = e.id LIMIT 1) as account_name,
                          (SELECT p.name FROM partner_ledger pl JOIN partners p ON p.id = pl.partner_id WHERE pl.ref_type = 'expense' AND pl.ref_id = e.id AND pl.method = 'direct' LIMIT 1) as partner_name
                        FROM expenses e ORDER BY e.expense_date DESC, e.id DESC`);
  return { expenses, total: expenses.reduce((s, r) => s + r.amount * (r.fx_rate_to_usd || 1), 0) };
}
export function currenciesPage() {
  const rates = all(`SELECT c.code, c.name, c.symbol, c.decimals, c.is_base,
                       (SELECT r.usd_per_unit FROM exchange_rates r WHERE r.currency_code = c.code AND r.effective_from <= date('now') ORDER BY r.effective_from DESC, r.id DESC LIMIT 1) as usd_per_unit,
                       (SELECT r.effective_from FROM exchange_rates r WHERE r.currency_code = c.code AND r.effective_from <= date('now') ORDER BY r.effective_from DESC, r.id DESC LIMIT 1) as rate_date
                     FROM currencies c ORDER BY c.is_base DESC, c.code`);
  return { rates, history: all(`SELECT r.*, c.name as currency_name, c.symbol FROM exchange_rates r JOIN currencies c ON c.code = r.currency_code ORDER BY r.effective_from DESC, r.id DESC LIMIT 100`),
    missing: rates.filter(r => !r.is_base && r.usd_per_unit === null) };
}

// Money movements shared by several operations (db.post_cash_transaction).
import { one, ins } from '../localdb.js';
import { rateOn } from '../queries.js';

// One movement of money in the account's own currency (+ in, − out), stamped with the
// exchange rate of its day so its USD value never moves. No account = nothing posted.
export function postCashTransaction(accountId, amount, kind, { occurredOn = null, description = null, refType = null, refId = null, transferGroup = null } = {}) {
  if (!accountId) return null;
  const acct = one(`SELECT currency_code FROM cash_accounts WHERE id = ?`, [accountId]);
  let rate = acct ? rateOn(acct.currency_code, occurredOn) : 1.0;
  if (rate === null || rate === undefined) rate = 1.0;
  return ins('cash_transactions', {
    account_id: accountId, amount, fx_rate_to_usd: rate, kind,
    occurred_on: occurredOn || new Date().toISOString().slice(0, 10),
    description, ref_type: refType, ref_id: refId, transfer_group: transferGroup
  });
}

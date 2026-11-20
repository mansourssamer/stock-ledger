// Money: currencies and exchange rates (with re-valuing what was booked at a corrected rate),
// cash accounts and transfers, partners (loans, repayments, profit shares) and expenses —
// the old app's handlers with the same SQL and checks (runs inside store.change()).
import { all, one, val, run, ins } from '../localdb.js';
import * as Q from '../queries.js';
import { t } from '../i18n.js';
import { fmtMoney, fmtUsd, pyRound } from '../util.js';
import { refuse, today, asId } from './common.js';
import { postCashTransaction } from './money.js';
import { recostPoBoxes } from './costs.js';
import { settlementFrom, markSettled, settlementResult, exchangePhrase, recordDirectPartnerPayment, parsePaidFrom } from './purchasing.js';
import { partnerPosition, netProfitUsd, distributedToDate, costCorrectionCheck } from '../reports.js';

const money = (v, c) => fmtMoney(v, c);
const decimalsOf = code => { const c = one(`SELECT decimals FROM currencies WHERE code = ?`, [code]); return c && c.decimals !== null ? c.decimals : 2; };
const numOrNull = v => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const fmtG = x => String(Number(Number(x).toPrecision(6)));   // Python's '%g'
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

// ---------- currencies and rates ----------
export function currencyNew({ code, name, symbol, decimals }) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) refuse('Enter the currency code, e.g. EUR.');
  if (val(`SELECT 1 FROM currencies WHERE code = ?`, [c])) refuse('{c} already exists.', { c });
  ins('currencies', { code: c, name: name || c, symbol: symbol || null, decimals: decimals === '' || decimals === undefined || decimals === null ? 2 : Math.trunc(Number(decimals)), is_base: 0 });
  return t('Currency {c} added — now set its exchange rate.', { c });
}
export function rateNew({ currency_code, effective_from, direction, rate, note }) {
  const code = currency_code;
  const day = effective_from || today();
  const value = numOrNull(rate);
  if (value === null || value <= 0) refuse('Enter the rate as a number greater than zero. Nothing was added.');
  const usd = (direction || 'usd_per_unit') === 'usd_per_unit' ? value : 1.0 / value;
  const existing = one(`SELECT id FROM exchange_rates WHERE currency_code = ? AND effective_from = ?`, [code, day]);
  if (existing) {
    run(`UPDATE exchange_rates SET usd_per_unit = ?, note = ? WHERE id = ?`, [usd, note ?? null, existing.id]);
    return t('Updated the {c} rate effective {d}.', { c: code, d: day });
  }
  ins('exchange_rates', { currency_code: code, usd_per_unit: usd, effective_from: day, note: note ?? null });
  return t('Added a new {c} rate effective {d}.', { c: code, d: day });
}
const rateSnapshot = code => all(`SELECT id, effective_from, usd_per_unit FROM exchange_rates WHERE currency_code = ? ORDER BY effective_from, id`, [code]);
function rateEntryOn(snap, day) {
  if (!snap.length) return [null, null];
  const d = String(day || today()).slice(0, 10);
  let best = null;
  for (const r of snap) if (String(r.effective_from).slice(0, 10) <= d) best = r;
  best = best || snap[0];
  return [best.id, best.usd_per_unit];
}
function rateDependents(code) {
  const out = [];
  const add = (kind, id, day, extra = {}) => out.push({ kind, id, day: String(day || today()).slice(0, 10), ...extra });
  for (const r of all(`SELECT id, fulfilled_at FROM orders WHERE status = 'fulfilled' AND currency_code = ? ORDER BY id`, [code])) add('sale', r.id, r.fulfilled_at);
  for (const r of all(`SELECT id, expense_date FROM expenses WHERE currency_code = ? ORDER BY id`, [code])) add('expense', r.id, r.expense_date);
  for (const r of all(`SELECT e.id, e.expense_date FROM expenses e JOIN cash_transactions t ON t.ref_type = 'expense' AND t.ref_id = e.id
                       JOIN cash_accounts a ON a.id = t.account_id WHERE a.currency_code = ? AND e.currency_code != ? ORDER BY e.id`, [code, code])) add('expense_conversion', r.id, r.expense_date);
  for (const r of all(`SELECT t.id, t.occurred_on FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id WHERE a.currency_code = ? ORDER BY t.id`, [code])) add('cash', r.id, r.occurred_on);
  for (const r of all(`SELECT ip.id, ip.paid_at FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id JOIN orders o ON o.id = i.order_id
                       JOIN cash_transactions t ON t.ref_type = 'invoice_payment' AND t.ref_id = ip.id JOIN cash_accounts a ON a.id = t.account_id
                       WHERE a.currency_code != o.currency_code AND (a.currency_code = ? OR o.currency_code = ?) ORDER BY ip.id`, [code, code])) add('payment_conversion', r.id, r.paid_at);
  for (const r of all(`SELECT id, occurred_on FROM partner_ledger WHERE currency_code = ? ORDER BY id`, [code])) add('partner', r.id, r.occurred_on);
  for (const r of all(`SELECT id, occurred_on FROM cash_transactions WHERE settled_currency = ? ORDER BY id`, [code])) add('settled', r.id, r.occurred_on);
  for (const r of all(`SELECT id, occurred_on FROM distributions WHERE currency_code = ? ORDER BY id`, [code])) add('distribution', r.id, r.occurred_on);
  for (const r of all(`SELECT g.id, g.po_id, g.received_at FROM po_box_groups g JOIN purchase_orders po ON po.id = g.po_id
                       WHERE po.currency_code = ? AND g.received_at IS NOT NULL AND EXISTS (SELECT 1 FROM boxes b WHERE b.source_po_id = g.po_id) ORDER BY g.id`, [code])) add('po_group', r.id, r.received_at, { po_id: r.po_id });
  for (const r of all(`SELECT pc.id, pc.po_id, pc.cost_date, pc.fx_day FROM po_costs pc WHERE pc.currency_code = ?
                       AND (pc.fx_rate_to_usd IS NOT NULL OR EXISTS (SELECT 1 FROM boxes b WHERE b.source_po_id = pc.po_id)) ORDER BY pc.id`, [code])) {
    add('po_cost', r.id, r.fx_day || r.cost_date || Q.poReceivedDay(r.po_id), { po_id: r.po_id });
  }
  return out;
}
const KIND_LABELS = [['sale', 'sale', 'sales'], ['expense', 'expense', 'expenses'], ['cash', 'account entry', 'account entries'],
  ['payment_conversion', 'converted customer payment', 'converted customer payments'], ['partner', 'partner entry', 'partner entries'],
  ['distribution', 'profit share', 'profit shares'], ['po', 'purchase order’s landed cost', 'purchase orders’ landed costs']];
export function describeCounts(counts) {
  return KIND_LABELS.filter(([k]) => counts[k]).map(([k, one1, many]) => `${counts[k]} ${t(counts[k] === 1 ? one1 : many)}`).join(', ');
}
// How many records are valued at this rate entry now, by kind (_rate_usage).
export function rateUsage(rate) {
  const snap = rateSnapshot(rate.currency_code);
  const counts = {}, seen = new Set();
  for (const d of rateDependents(rate.currency_code)) {
    if (rateEntryOn(snap, d.day)[0] !== rate.id) continue;
    const kind = { expense_conversion: 'expense', settled: 'cash', po_group: 'po', po_cost: 'po' }[d.kind] || d.kind;
    if (kind === 'po') { if (seen.has(d.po_id)) continue; seen.add(d.po_id); }
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}
function restampAfterRateEdit(code, rateId, oldSnap) {
  const newSnap = rateSnapshot(code);
  const counts = {}, poIds = new Set();
  const bump = k => { counts[k] = (counts[k] || 0) + 1; };
  for (const d of rateDependents(code)) {
    if (!(rateEntryOn(oldSnap, d.day)[0] === rateId || rateEntryOn(newSnap, d.day)[0] === rateId)) continue;
    const { kind, id, day } = d;
    const nr = Q.rateOn(code, day);
    if (kind === 'sale') {
      const cur = val(`SELECT fx_rate_to_usd FROM orders WHERE id = ?`, [id]);
      if (cur === null || Math.abs(cur - nr) > 1e-12) { run(`UPDATE orders SET fx_rate_to_usd = ? WHERE id = ?`, [nr, id]); bump('sale'); }
    } else if (kind === 'expense' || kind === 'expense_conversion') {
      const e = one(`SELECT * FROM expenses WHERE id = ?`, [id]);
      let changed = false, expFx = e.fx_rate_to_usd;
      if (kind === 'expense' && Math.abs(expFx - nr) > 1e-12) { expFx = nr; run(`UPDATE expenses SET fx_rate_to_usd = ? WHERE id = ?`, [expFx, id]); changed = true; }
      const tx = one(`SELECT t.id, t.amount, a.currency_code FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id WHERE t.ref_type = 'expense' AND t.ref_id = ?`, [id]);
      if (tx && tx.currency_code !== e.currency_code) {
        const out = pyRound(e.amount * expFx / Q.rateOn(tx.currency_code, e.expense_date), 2);
        if (Math.abs(-tx.amount - out) > 0.004) { run(`UPDATE cash_transactions SET amount = ? WHERE id = ?`, [-out, tx.id]); changed = true; }
      }
      if (changed) bump('expense');
    } else if (kind === 'cash') {
      const cur = val(`SELECT fx_rate_to_usd FROM cash_transactions WHERE id = ?`, [id]);
      if (Math.abs(cur - nr) > 1e-12) { run(`UPDATE cash_transactions SET fx_rate_to_usd = ? WHERE id = ?`, [nr, id]); bump('cash'); }
    } else if (kind === 'payment_conversion') {
      const p = one(`SELECT ip.amount, ip.paid_at, o.currency_code as inv_cur, t.id as tid, t.amount as posted, a.currency_code as acct_cur, c.decimals
                     FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id JOIN orders o ON o.id = i.order_id
                     JOIN cash_transactions t ON t.ref_type = 'invoice_payment' AND t.ref_id = ip.id JOIN cash_accounts a ON a.id = t.account_id
                     LEFT JOIN currencies c ON c.code = a.currency_code WHERE ip.id = ?`, [id]);
      const posted = pyRound(p.amount * Q.rateOn(p.inv_cur, p.paid_at) / Q.rateOn(p.acct_cur, p.paid_at), p.decimals !== null ? p.decimals : 2);
      if (Math.abs(posted - p.posted) > 0.004) { run(`UPDATE cash_transactions SET amount = ? WHERE id = ?`, [posted, p.tid]); bump('payment_conversion'); }
    } else if (kind === 'settled') {
      const cur = val(`SELECT settled_fx_rate FROM cash_transactions WHERE id = ?`, [id]);
      if (cur === null || Math.abs(cur - nr) > 1e-12) { run(`UPDATE cash_transactions SET settled_fx_rate = ? WHERE id = ?`, [nr, id]); bump('cash'); }
    } else if (kind === 'partner') {
      const cur = val(`SELECT fx_rate_to_usd FROM partner_ledger WHERE id = ?`, [id]);
      if (Math.abs(cur - nr) > 1e-12) { run(`UPDATE partner_ledger SET fx_rate_to_usd = ? WHERE id = ?`, [nr, id]); bump('partner'); }
    } else if (kind === 'distribution') {
      const cur = val(`SELECT fx_rate_to_usd FROM distributions WHERE id = ?`, [id]);
      if (Math.abs(cur - nr) > 1e-12) { run(`UPDATE distributions SET fx_rate_to_usd = ? WHERE id = ?`, [nr, id]); bump('distribution'); }
    } else if (kind === 'po_group' || kind === 'po_cost') {
      run(`UPDATE ${kind === 'po_group' ? 'po_box_groups' : 'po_costs'} SET fx_rate_to_usd = ? WHERE id = ?`, [nr, id]);
      poIds.add(d.po_id);
    }
  }
  let adjustments = 0;
  const sorted = [...poIds].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : typeof a === 'number' ? -1 : typeof b === 'number' ? 1 : a < b ? -1 : 1));
  for (const po of sorted) {
    const [recosted, , adj] = recostPoBoxes(po, `${code} exchange rate corrected`);
    if (recosted || Math.abs(adj) >= 0.005) bump('po');
    adjustments += adj;
  }
  return [counts, adjustments];
}
export function rateEdit(rateId, { rate, direction, effective_from, note, restamp }) {
  const r = one(`SELECT * FROM exchange_rates WHERE id = ?`, [rateId]);
  if (!r) refuse('That rate no longer exists.');
  const code = r.currency_code;
  const value = numOrNull(rate);
  if (value === null || value <= 0) refuse('Enter the rate as a number greater than zero. Nothing was changed.');
  const usd = (direction || 'units_per_usd') === 'usd_per_unit' ? value : 1.0 / value;
  const day = String(effective_from || '').trim().slice(0, 10) || String(r.effective_from).slice(0, 10);
  if (!validDay(day)) refuse('That date isn’t valid. Nothing was changed.');
  if (val(`SELECT 1 FROM exchange_rates WHERE currency_code = ? AND effective_from = ? AND id != ?`, [code, day, rateId])) {
    refuse('There’s already another {c} rate starting on {d} — edit or remove that one instead. Nothing was changed.', { c: code, d: day });
  }
  const oldSnap = rateSnapshot(code);
  run(`UPDATE exchange_rates SET usd_per_unit = ?, effective_from = ?, note = ? WHERE id = ?`, [usd, day, String(note || '').trim() || null, rateId]);
  let msg = t('{c} rate updated: $1 = {u} {c} from {d}.', { c: code, u: fmtMoney(1 / usd, 'USD').replace('$', ''), d: day });
  if (restamp) {
    const [counts, adj] = restampAfterRateEdit(code, rateId, oldSnap);
    const described = describeCounts(counts);
    msg += ' ' + (described ? t('Corrected {x}.', { x: described }) : t('Nothing booked needed correcting.'));
    if (Math.abs(adj) >= 0.005) msg += ' ' + t('Boxes already sold carry a {a} cost-of-goods correction, dated today.', { a: (adj > 0 ? '+' : '−') + fmtUsd(Math.abs(adj)) });
  } else msg += ' ' + t('Records already booked were left at the old rate.');
  return msg;
}
export function rateDelete(id) {
  run(`DELETE FROM exchange_rates WHERE id = ?`, [id]);
  return t('Rate removed. Transactions already stamped with it keep their recorded value.');
}

// ---------- cash accounts ----------
export function accountNew({ name, account_type, currency_code, opening_balance, notes }) {
  if (!String(name || '').trim()) refuse('Enter a name for the account.');
  ins('cash_accounts', { name, account_type: account_type || 'bank', currency_code: currency_code || 'USD', opening_balance: Number(opening_balance || 0), notes: notes || null });
  return t('Account “{n}” added.', { n: name });
}
export function accountEdit(id, { name, account_type, currency_code, opening_balance, notes, archived }) {
  if (!String(name || '').trim()) refuse('Enter a name for the account.');
  run(`UPDATE cash_accounts SET name = ?, account_type = ?, currency_code = ?, opening_balance = ?, notes = ?, archived = ? WHERE id = ?`,
    [name, account_type || 'bank', currency_code || 'USD', Number(opening_balance || 0), notes || null, archived ? 1 : 0, id]);
  return t('Account updated.');
}
export function accountAdjust(id, { amount, occurred_on, description }) {
  const a = numOrNull(amount);
  if (a === null || Math.abs(a) < 0.000001) refuse('Enter the adjustment as a number, e.g. 50,000 or -50,000.');
  postCashTransaction(id, a, 'adjustment', { occurredOn: occurred_on || null, description: description || 'Manual adjustment' });
  return t('Adjustment recorded.');
}
export function accountTransfer({ from_account_id, to_account_id, amount, occurred_on, description, received_amount }) {
  const fromId = asId(from_account_id), toId = asId(to_account_id);
  const amt = numOrNull(amount) || 0;
  const when = occurred_on || null, note = description || '';
  if (fromId === toId) refuse('Pick two different accounts for a transfer.');
  if (amt <= 0) refuse('Transfer amount must be greater than zero.');
  const from = one(`SELECT name, currency_code FROM cash_accounts WHERE id = ?`, [fromId]), to = one(`SELECT name, currency_code FROM cash_accounts WHERE id = ?`, [toId]);
  if (!from || !to) refuse('One of those accounts no longer exists.');
  const fr = Q.rateOn(from.currency_code, when), tr = Q.rateOn(to.currency_code, when);
  let toAmount, override = String(received_amount ?? '').trim();
  if (from.currency_code !== to.currency_code) {
    if (fr === null || tr === null) refuse('Can’t transfer between different currencies without an exchange rate for {c}. Add one under Currencies first.', { c: fr === null ? from.currency_code : to.currency_code });
    if (override) {
      toAmount = numOrNull(received_amount);
      if (toAmount === null || toAmount <= 0) refuse('Enter what actually arrived as a number greater than zero. Nothing was transferred.');
    } else toAmount = pyRound(amt * fr / tr, decimalsOf(to.currency_code));
  } else { toAmount = amt; override = ''; }
  const group = hex(8);
  postCashTransaction(fromId, -amt, 'transfer', { occurredOn: when, description: `Transfer to ${to.name}${note ? ' — ' + note : ''}`, transferGroup: group });
  postCashTransaction(toId, toAmount, 'transfer', { occurredOn: when, description: `Transfer from ${from.name}${note ? ' — ' + note : ''}`, transferGroup: group });
  const sent = money(amt, from.currency_code), got = money(toAmount, to.currency_code);
  if (from.currency_code !== to.currency_code) {
    let msg = t('Converted {s} from {f} → {g} into {to}', { s: sent, f: from.name, g: got, to: to.name });
    msg += override ? ' — ' + exchangePhrase(toAmount * tr - amt * fr) + '.' : ' ' + t('at your rate for the day.');
    return msg;
  }
  return t('Transferred {s} from {f} to {to}.', { s: sent, f: from.name, to: to.name });
}
export function transferDelete(group) {
  if (!val(`SELECT 1 FROM cash_transactions WHERE transfer_group = ? AND kind = 'transfer'`, [group])) refuse('That transfer no longer exists.');
  run(`DELETE FROM cash_transactions WHERE transfer_group = ? AND kind = 'transfer'`, [group]);
  return t('Transfer removed from both accounts.');
}

// ---------- partners ----------
export function partnerNew({ name, ownership_percent, email, phone, notes }) {
  const n = String(name || '').trim();
  if (!n) refuse('Give the partner a name.');
  const pct = Number(ownership_percent || 0);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) refuse('Ownership must be between 0 and 100%.');
  return ins('partners', { name: n, ownership_percent: pct, email: email || null, phone: phone || null, notes: notes || null });
}
export function partnerEdit(id, { name, ownership_percent, email, phone, notes, archived }) {
  const pct = Number(ownership_percent || 0);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) refuse('Ownership must be between 0 and 100%.');
  if (!String(name || '').trim()) refuse('Give the partner a name.');
  run(`UPDATE partners SET name = ?, ownership_percent = ?, email = ?, phone = ?, notes = ?, archived = ? WHERE id = ?`, [name, pct, email || null, phone || null, notes || null, archived ? 1 : 0, id]);
  return t('Partner updated.');
}
export function partnerDelete(id) {
  if (val(`SELECT COUNT(*) FROM partner_ledger WHERE partner_id = ?`, [id])) refuse('This partner has loans or distributions on record, so they can’t be deleted — archive them instead.');
  run(`DELETE FROM partners WHERE id = ?`, [id]);
  return t('Partner deleted.');
}
export function partnerLoan(pid, f) {
  const amount = numOrNull(f.amount) || 0, acctId = asId(f.account_id);
  if (amount <= 0 || acctId === null) refuse('Enter an amount and pick the account the money went into.');
  const partner = one(`SELECT * FROM partners WHERE id = ?`, [pid]), acct = one(`SELECT * FROM cash_accounts WHERE id = ?`, [acctId]);
  const when = f.occurred_on || null;
  if (Q.rateOn(acct.currency_code, when) === null) refuse('Set an exchange rate for {c} first, so the loan is valued correctly in USD.', { c: acct.currency_code });
  const [settle, err] = settlementFrom(f, acct.currency_code, when);
  if (err) refuse('{e} Nothing was recorded.', { e: err });
  const note = f.note || null;
  const txn = postCashTransaction(acct.id, amount, 'partner_loan', { occurredOn: when, description: `Loan from ${partner.name}${note ? ' — ' + note : ''}`, refType: 'partner', refId: pid });
  const rate = val(`SELECT fx_rate_to_usd FROM cash_transactions WHERE id = ?`, [txn]);
  const owed = settle ? settle : [amount, acct.currency_code, rate];
  if (settle) markSettled(txn, settle);
  ins('partner_ledger', { partner_id: pid, kind: 'loan', amount: owed[0], currency_code: owed[1], fx_rate_to_usd: owed[2], occurred_on: when || today(),
    method: 'account', cash_transaction_id: txn, description: note });
  let msg = t('Recorded a loan of {a} from {p} into {acc}', { a: money(amount, acct.currency_code), p: partner.name, acc: acct.name });
  if (settle) msg += ' ' + t('— {p} gave {s}, which is what the business owes; {x}', { p: partner.name, s: money(settle[0], settle[1]), x: exchangePhrase(settlementResult(txn)) });
  return msg + '.';
}
export function partnerRepay(pid, f) {
  const amount = numOrNull(f.amount) || 0, acctId = asId(f.account_id);
  if (amount <= 0 || acctId === null) refuse('Enter an amount and pick the account the repayment came out of.');
  const partner = one(`SELECT * FROM partners WHERE id = ?`, [pid]), acct = one(`SELECT * FROM cash_accounts WHERE id = ?`, [acctId]);
  const when = f.occurred_on || null;
  const rate = Q.rateOn(acct.currency_code, when);
  if (rate === null) refuse('Set an exchange rate for {c} first, so the repayment can be measured against what’s owed.', { c: acct.currency_code });
  const [settle, err] = settlementFrom(f, acct.currency_code, when);
  if (err) refuse('{e} Nothing was recorded.', { e: err });
  const repaidUsd = settle ? settle[0] * settle[2] : amount * rate;
  const owed = partnerPosition(pid).owed_usd;
  if (repaidUsd > owed + 0.01) refuse('That’s more than {p} is owed ({o}). Repayments can’t exceed the loan balance.', { p: partner.name, o: fmtUsd(owed) });
  const note = f.note || null;
  const txn = postCashTransaction(acct.id, -amount, 'partner_repayment', { occurredOn: when, description: `Loan repayment to ${partner.name}${note ? ' — ' + note : ''}`, refType: 'partner', refId: pid });
  const repaid = settle ? settle : [amount, acct.currency_code, rate];
  if (settle) markSettled(txn, settle);
  ins('partner_ledger', { partner_id: pid, kind: 'repayment', amount: repaid[0], currency_code: repaid[1], fx_rate_to_usd: repaid[2], occurred_on: when || today(),
    method: 'account', cash_transaction_id: txn, description: note });
  let msg = t('Repaid {a} to {p} from {acc}', { a: money(amount, acct.currency_code), p: partner.name, acc: acct.name });
  if (settle) msg += ' ' + t('— {p} received {s}, so the loan goes down by that; {x}', { p: partner.name, s: money(settle[0], settle[1]), x: exchangePhrase(settlementResult(txn)) });
  return msg + '.';
}
export function partnerEntryDelete(entryId) {
  const e = one(`SELECT * FROM partner_ledger WHERE id = ?`, [entryId]);
  if (!e) refuse('That entry no longer exists.');
  if (e.kind === 'distribution') refuse('Profit shares belong to a distribution — remove the whole distribution from the Partners page instead.');
  if (e.kind === 'loan' && partnerPosition(e.partner_id).owed_usd - e.amount * (e.fx_rate_to_usd || 1) < -0.01) refuse('Removing this loan would leave more repaid than was ever lent. Remove the repayment first.');
  run(`DELETE FROM partner_ledger WHERE id = ?`, [entryId]);
  if (e.cash_transaction_id) run(`DELETE FROM cash_transactions WHERE id = ?`, [e.cash_transaction_id]);
  let msg = t('Entry removed.');
  if (e.method === 'direct' && e.ref_type === 'purchase_order') msg += ' ' + t('PO #{n} no longer counts it as paid.', { n: Q.poRef(e.ref_id) });
  return msg;
}
export function distribute({ total_amount, account_id, occurred_on, notes, override }) {
  const total = numOrNull(total_amount) || 0, acctId = asId(account_id);
  if (total <= 0 || acctId === null) refuse('Enter the amount to distribute and the account it’s paid from.');
  const partners = all(`SELECT * FROM partners WHERE archived = 0 ORDER BY name`);
  const pctTotal = partners.reduce((s, p) => s + p.ownership_percent, 0);
  if (!partners.length || Math.abs(pctTotal - 100) > 0.001) refuse('Ownership adds up to {p}%, not 100%. Fix the percentages before distributing, or the shares won’t add up.', { p: fmtG(pctTotal) });
  const acct = one(`SELECT * FROM cash_accounts WHERE id = ?`, [acctId]);
  const when = occurred_on || today();
  const rate = Q.rateOn(acct.currency_code, when);
  if (rate === null) refuse('Set an exchange rate for {c} first.', { c: acct.currency_code });
  const available = netProfitUsd() - distributedToDate();
  if (total * rate > available + 0.01 && !override) refuse('That’s {a}, but only {b} of profit hasn’t been shared out yet. Tick “distribute anyway” if you mean to.', { a: fmtUsd(total * rate), b: fmtUsd(Math.max(available, 0)) });
  const dec = decimalsOf(acct.currency_code);
  const dist = ins('distributions', { total_amount: total, currency_code: acct.currency_code, fx_rate_to_usd: rate, occurred_on: when, account_id: acct.id, notes: notes || null });
  let remaining = total;
  partners.forEach((p, i) => {
    const share = i < partners.length - 1 ? pyRound(total * p.ownership_percent / 100, dec) : pyRound(remaining, dec);
    remaining -= share;
    if (share === 0) return;
    const txn = postCashTransaction(acct.id, -share, 'distribution', { occurredOn: when, description: `Profit share to ${p.name} (${fmtG(p.ownership_percent)}%)`, refType: 'distribution', refId: dist });
    ins('partner_ledger', { partner_id: p.id, kind: 'distribution', amount: share, currency_code: acct.currency_code, fx_rate_to_usd: rate, occurred_on: when,
      method: 'account', cash_transaction_id: txn, distribution_id: dist, description: notes || null });
  });
  return t('Distributed {a} across {n} partner(s) from {acc}.', { a: money(total, acct.currency_code), n: partners.length, acc: acct.name });
}
export function distributionDelete(id) {
  const txns = all(`SELECT cash_transaction_id FROM partner_ledger WHERE distribution_id = ? ORDER BY id`, [id]).map(e => e.cash_transaction_id).filter(x => x !== null);
  run(`DELETE FROM partner_ledger WHERE distribution_id = ?`, [id]);
  for (const tid of txns) run(`DELETE FROM cash_transactions WHERE id = ?`, [tid]);
  run(`DELETE FROM distributions WHERE id = ?`, [id]);
  return t('Distribution removed — each partner’s share and its cash movement are gone.');
}

// ---------- expenses ----------
export function expensePaidFrom(id) {
  const tx = one(`SELECT account_id FROM cash_transactions WHERE ref_type = 'expense' AND ref_id = ? ORDER BY id LIMIT 1`, [id]);
  if (tx) return `acct:${tx.account_id}`;
  const pl = one(`SELECT partner_id FROM partner_ledger WHERE ref_type = 'expense' AND ref_id = ? AND method = 'direct' ORDER BY id LIMIT 1`, [id]);
  return pl ? `partner:${pl.partner_id}` : '';
}
function paymentCheck(paidFrom, currency, day) {
  const [kind, ident] = parsePaidFrom(paidFrom);
  if (kind === 'partner') { if (!val(`SELECT 1 FROM partners WHERE id = ?`, [ident])) return t('That partner no longer exists.'); }
  else if (kind === 'account') {
    const a = one(`SELECT currency_code FROM cash_accounts WHERE id = ?`, [ident]);
    if (!a) return t('That account no longer exists.');
    if (a.currency_code !== currency && !Q.rateOn(a.currency_code, day)) return t('Set an exchange rate for {c} first (Currencies page).', { c: a.currency_code });
  }
  return null;
}
function postExpensePayment(expenseId, paidFrom, amount, currency, fx, day, label) {
  const [kind, ident] = parsePaidFrom(paidFrom);
  if (kind === 'partner') {
    const p = one(`SELECT name FROM partners WHERE id = ?`, [ident]);
    recordDirectPartnerPayment(ident, amount, currency, day, 'expense', expenseId, `Paid expense: ${label}`);
    return ' ' + t('Paid directly by {p} — added to what the business owes them.', { p: p.name });
  }
  if (kind === 'account') {
    const a = one(`SELECT * FROM cash_accounts WHERE id = ?`, [ident]);
    let out = amount;
    if (a.currency_code !== currency) out = pyRound(amount * fx / Q.rateOn(a.currency_code, day), 2);
    postCashTransaction(ident, -out, 'expense', { occurredOn: day, description: label, refType: 'expense', refId: expenseId });
    return ' ' + t('{a} taken out of {acc}.', { a: money(out, a.currency_code), acc: a.name });
  }
  return ' ' + t('(Not posted to a cash account.)');
}
function expenseValues(f, fb = {}) {
  const category = String(f.category || '').trim();
  if (!category) return [null, t('Enter a category.')];
  const amount = numOrNull(f.amount);
  if (amount === null || amount <= 0) return [null, t('Enter the amount, as a number greater than zero.')];
  const day = (String(f.expense_date || '').trim() || fb.expense_date || today()).slice(0, 10);
  if (!validDay(day)) return [null, t('That date isn’t valid.')];
  const currency = f.currency_code || fb.currency_code || 'USD';
  const fx = Q.rateOn(currency, day);
  if (fx === null) return [null, t('Set an exchange rate for {c} first (Currencies page).', { c: currency })];
  const description = String(f.description || '').trim();
  return [{ category, description, amount, day, currency, fx, label: category + (description ? ` — ${description}` : '') }, null];
}
export function expenseNew(f) {
  const [v, err0] = expenseValues(f);
  const paidFrom = f.paid_from || f.account_id || '';
  const err = err0 || paymentCheck(paidFrom, v ? v.currency : 'USD', v ? v.day : null);
  if (err) refuse('{e} The expense wasn’t added.', { e: err });
  const id = ins('expenses', { category: v.category, description: v.description, amount: v.amount, currency_code: v.currency, fx_rate_to_usd: v.fx, expense_date: v.day });
  return t('Expense added.') + postExpensePayment(id, paidFrom, v.amount, v.currency, v.fx, v.day, v.label);
}
function paidFromName(pf) {
  const [kind, ident] = parsePaidFrom(pf);
  if (kind === 'partner') { const r = one(`SELECT name FROM partners WHERE id = ?`, [ident]); return r ? t('{p}’s loan balance', { p: r.name }) : t('the partner'); }
  if (kind === 'account') { const r = one(`SELECT name FROM cash_accounts WHERE id = ?`, [ident]); return r ? r.name : t('the old account'); }
  return t('nowhere');
}
export function expenseEdit(id, f) {
  const e = one(`SELECT * FROM expenses WHERE id = ?`, [id]);
  if (!e) refuse('That expense no longer exists.');
  const current = expensePaidFrom(id);
  const [v, err0] = expenseValues(f, e);
  const paidFrom = f.paid_from !== undefined ? f.paid_from : current;
  const err = err0 || paymentCheck(paidFrom, v ? v.currency : 'USD', v ? v.day : null);
  if (err) refuse('{e} Nothing was changed.', { e: err });
  const dayChanged = v.day !== String(e.expense_date).slice(0, 10);
  const moneyChanged = paidFrom !== current || Math.abs(v.amount - e.amount) > 1e-9 || v.currency !== e.currency_code || dayChanged;
  const fx = v.currency !== e.currency_code || dayChanged ? v.fx : e.fx_rate_to_usd;
  run(`UPDATE expenses SET category = ?, description = ?, amount = ?, currency_code = ?, fx_rate_to_usd = ?, expense_date = ? WHERE id = ?`,
    [v.category, v.description, v.amount, v.currency, fx, v.day, id]);
  let msg = t('Expense updated.');
  if (moneyChanged) {
    run(`DELETE FROM partner_ledger WHERE ref_type = 'expense' AND ref_id = ? AND method = 'direct'`, [id]);
    run(`DELETE FROM cash_transactions WHERE ref_type = 'expense' AND ref_id = ?`, [id]);
    msg += postExpensePayment(id, paidFrom, v.amount, v.currency, fx, v.day, v.label);
    if (current && paidFrom !== current) msg += ' ' + t('Put back into {x}.', { x: paidFromName(current) });
  } else {
    run(`UPDATE cash_transactions SET description = ? WHERE ref_type = 'expense' AND ref_id = ?`, [v.label, id]);
    run(`UPDATE partner_ledger SET description = ? WHERE ref_type = 'expense' AND ref_id = ? AND method = 'direct'`, [`Paid expense: ${v.label}`, id]);
  }
  return msg;
}
export function expenseDelete(id) {
  run(`DELETE FROM cash_transactions WHERE ref_type = 'expense' AND ref_id = ?`, [id]);
  run(`DELETE FROM partner_ledger WHERE ref_type = 'expense' AND ref_id = ? AND method = 'direct'`, [id]);
  run(`DELETE FROM expenses WHERE id = ?`, [id]);
  return t('Expense deleted, along with the payment recorded for it.');
}

// ---------- cleaning up landed-cost corrections (cost_corrections_fix) ----------
export function costCorrectionsFix() {
  const flagged = costCorrectionCheck();
  if (!flagged.length) refuse('Nothing to clean up — every purchase order’s corrections are already right.');
  let removed = 0, kept = 0, boxes = 0;
  for (const row of flagged) {
    const plan = Q.poCostPlan(row.po_id);
    for (const i of plan.items) if (!i.sold && Math.abs(i.target - i.recorded) >= 0.00005) run(`UPDATE box_items SET unit_cost = ? WHERE id = ?`, [i.target, i.id]);
    boxes += plan.instock_boxes;
    removed += val(`SELECT COUNT(*) FROM cogs_adjustments WHERE po_id = ?`, [row.po_id]);
    run(`DELETE FROM cogs_adjustments WHERE po_id = ?`, [row.po_id]);
    if (Math.abs(plan.should_be) >= 0.005) {
      ins('cogs_adjustments', { po_id: row.po_id, amount_usd: pyRound(plan.should_be, 4), source: 'cleanup',
        description: `Landed cost change on PO #${Q.poRef(row.po_id)} — total for ${plan.sold_pairs} pair(s) sold before it (replaces ${row.entries} earlier entr${row.entries === 1 ? 'y' : 'ies'})` });
      kept += plan.should_be;
    }
  }
  let msg = t('Cleaned up {n} purchase order(s): {r} correction entry(ies) removed', { n: flagged.length, r: removed });
  msg += Math.abs(kept) >= 0.005 ? t(', replaced by the true total: {a} on cost of goods sold, dated today', { a: (kept > 0 ? '+' : '−') + fmtUsd(Math.abs(kept)) }) : t(' — no real correction remains');
  if (boxes) msg += t('; {n} box(es) in stock set to their true cost', { n: boxes });
  return msg + '.';
}

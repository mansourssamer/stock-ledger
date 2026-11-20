// Money pages and their forms: accounts and transfers, expenses, partners, currencies and rates.
import { all, one } from './localdb.js';
import * as Q from './queries.js';
import * as F from './ops/finance.js';
import * as D from './moneydata.js';
import { asId } from './ops/common.js';
import { t, plural } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtNum, fmtDate, fmtShort, today } from './util.js';
import { header, tile, tiles, panel, pill, empty, table } from './ui.js';
import { openForm, confirmAction } from './forms.js';
import { registerActions } from './actions.js';
import { go, schedule } from './app.js';
import { poNo, csvCell, downloadText } from './buy.js';

const id = v => asId(v);
const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));
const after = target => (msg) => { if (typeof msg === 'string') toast(msg); if (target) go(target); else schedule(); };
const curOpts = () => all(`SELECT code, name FROM currencies ORDER BY is_base DESC, code`).map(c => [c.code, `${c.code} — ${c.name}`]);
const acctRows = () => all(`SELECT id, name, currency_code FROM cash_accounts WHERE archived = 0 ORDER BY name`);
const acctOpts = () => acctRows().map(a => [a.id, `${a.name} (${a.currency_code})`]);
const big = (v, cur = 'USD') => esc(Math.abs(v) >= 100000 ? fmtShort(v, cur) : fmtMoney(v, cur));
const signed = v => (Math.abs(v) < 0.005 ? fmtUsd(0) : (v > 0 ? '+' : '−') + fmtUsd(Math.abs(v)));
const ACCOUNT_TYPES = [['bank', 'Bank account'], ['cash', 'Cash'], ['mobile_money', 'Mobile money'], ['other', 'Other']];
const KIND = { customer_payment: 'Customer payment', supplier_payment: 'Supplier payment', expense: 'Expense', transfer: 'Transfer', adjustment: 'Adjustment',
  partner_loan: 'Partner loan', partner_repayment: 'Loan repayment', distribution: 'Profit share', opening: 'Opening balance' };
const kindLabel = k => t(KIND[k] || String(k || '').replace(/_/g, ' '));

export function moneyNav(cur) {
  const items = [['money', t('Accounts')], ['expenses', t('Expenses')], ['partners', t('Partners')], ['currencies', t('Currencies')]];
  return `<nav class="subnav">${items.map(([k, l]) => `<a href="#/${k}"${cur === k ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;
}

// ---------- accounts ----------
function money() {
  const p = D.accountsPage();
  const active = p.accounts.filter(a => !a.archived), archived = p.accounts.filter(a => a.archived);
  const row = a => ({ href: `account/${a.id}`, cls: a.archived ? 'dim' : '', cells: [`<b>${esc(a.name)}</b><span class="sub">${esc(t((ACCOUNT_TYPES.find(x => x[0] === a.account_type) || [, a.account_type])[1] || ''))} · ${esc(a.currency_code)}</span>`,
    esc(fmtMoney(a.balance, a.currency_code)), a.balance_usd === null ? `<span class="neg">${esc(t('no rate'))}</span>` : esc(fmtUsd(a.balance_usd))] });
  return header(t('Money'), { sub: esc(t('Cash across your accounts: {a}', { a: fmtUsd(p.total) })),
    actions: `<button class="btn primary" data-act="transfer">${esc(t('Transfer / exchange'))}</button><button class="btn" data-act="newAccount">+ ${esc(t('New account'))}</button><button class="btn" data-act="cashCsv">${esc(t('Download CSV'))}</button>` })
    + moneyNav('money')
    + (p.missing_rates.length ? `<div class="callout bad">${esc(t('No exchange rate for {c}: those accounts aren’t counted in the total.', { c: [...new Set(p.missing_rates.map(a => a.currency_code))].join(', ') }))} <a href="#/currencies">${esc(t('Currencies'))}</a></div>` : '')
    + tiles([tile(t('Cash on hand'), big(p.total), esc(t('across your accounts, at today’s rates'))), ...active.slice(0, 3).map(a => tile(a.name, big(a.balance, a.currency_code), esc(a.currency_code), `account/${a.id}`))])
    + panel('', table([{ h: t('Account') }, { h: t('Balance'), n: true }, { h: 'USD', n: true, cls: 'hide-sm' }], [...active, ...archived].map(row), { emptyText: t('No accounts yet.') }), { tight: true });
}
function account(aidRaw) {
  const p = D.accountDetail(id(aidRaw));
  if (!p) return header(t('Accounts'), { back: 'money' }) + empty('—');
  const a = p.account, A = esc(a.id);
  const rows = p.transactions.map(x => ({ cls: x.amount < 0 ? '' : '', cells: [esc(fmtDate(x.occurred_on)),
    `${esc(kindLabel(x.kind))}<span class="sub">${esc(x.description || '')}</span>`
      + (x.settled_amount !== null ? `<span class="sub">${esc(t('they received {s}', { s: fmtMoney(x.settled_amount, x.settled_currency) }))}</span>` : '')
      + (x.fx_result !== null && Math.abs(x.fx_result) >= 0.005 ? `<span class="sub ${x.fx_result < 0 ? 'neg' : 'gain'}">${esc(t('exchange {r}', { r: signed(x.fx_result) }))}</span>` : ''),
    `<span class="${x.amount < 0 ? 'neg' : 'gain'}">${esc((x.amount > 0 ? '+' : '') + fmtMoney(x.amount, a.currency_code))}</span>`,
    x.kind === 'transfer' && x.transfer_group ? `<div class="rowacts"><button class="btn sm danger" data-act="delTransfer" data-g="${esc(x.transfer_group)}">✕</button></div>` : ''] }));
  return header(a.name, { back: 'money', eyebrow: `${t((ACCOUNT_TYPES.find(x => x[0] === a.account_type) || [, a.account_type])[1] || '')} · ${a.currency_code}`, sub: a.notes ? esc(a.notes) : '',
    actions: `<button class="btn primary" data-act="transfer" data-from="${A}">${esc(t('Transfer / exchange'))}</button><button class="btn" data-act="adjustAccount" data-id="${A}">${esc(t('Adjust'))}</button><button class="btn" data-act="editAccount" data-id="${A}">${esc(t('Edit'))}</button>` })
    + tiles([tile(t('Balance'), big(a.balance, a.currency_code), esc(fmtMoney(a.balance, a.currency_code))), tile('USD', a.balance_usd === null ? '—' : big(a.balance_usd), esc(t('at today’s rate'))),
      tile(t('Opening balance'), big(a.opening_balance, a.currency_code), esc(fmtDate(a.created_at)))])
    + panel(t('Movements'), table([{ h: t('Date') }, { h: '' }, { h: t('Amount'), n: true }, { h: '' }], rows, { emptyText: t('No movements yet.') }), { tight: true });
}

// ---------- expenses ----------
function expenses() {
  const p = D.expensesPage();
  return header(t('Expenses'), { sub: esc(t('{n} expenses · {a} in total', { n: p.expenses.length, a: fmtUsd(p.total) })),
    actions: `<button class="btn primary" data-act="newExpense">+ ${esc(t('New expense'))}</button><button class="btn" data-act="expCsv">${esc(t('Download CSV'))}</button>` }) + moneyNav('expenses')
    + panel('', table([{ h: t('Date') }, { h: t('Category') }, { h: t('Amount'), n: true }, { h: t('Paid from'), cls: 'hide-sm' }, { h: '' }],
      p.expenses.map(e => ({ cells: [esc(fmtDate(e.expense_date)), `<b>${esc(e.category)}</b>${e.description ? `<span class="sub">${esc(e.description)}</span>` : ''}`,
        esc(fmtMoney(e.amount, e.currency_code)) + (e.currency_code !== 'USD' ? `<span class="sub">${esc(fmtUsd(e.amount * (e.fx_rate_to_usd || 1)))}</span>` : ''),
        esc(e.account_name || (e.partner_name ? t('{p} (paid directly)', { p: e.partner_name }) : '—')),
        `<div class="rowacts"><button class="btn sm" data-act="editExpense" data-id="${esc(e.id)}">${esc(t('Edit'))}</button><button class="btn sm danger" data-act="delExpense" data-id="${esc(e.id)}">✕</button></div>`] })),
      { emptyText: t('No expenses yet.') }), { tight: true });
}

// ---------- partners ----------
function partners() {
  const p = D.partnersPage();
  return header(t('Partners'), { sub: esc(t('Ownership adds up to {p}%', { p: fmtNum(p.total_percent, Number.isInteger(p.total_percent) ? 0 : 2) })),
    actions: `<button class="btn primary" data-act="distribute">${esc(t('Share out profit'))}</button><button class="btn" data-act="newPartner">+ ${esc(t('New partner'))}</button>` }) + moneyNav('partners')
    + (Math.abs(p.total_percent - 100) > 0.001 && p.partners.some(x => !x.archived) ? `<div class="callout warn">${esc(t('Ownership should add up to 100% before profit can be shared out.'))}</div>` : '')
    + tiles([tile(t('Net profit to date'), big(p.profit_to_date), ''), tile(t('Already shared out'), big(p.distributed_to_date), ''),
      tile(t('Not shared out yet'), big(p.available), '', '', p.available < 0 ? 'neg' : ''), tile(t('Owed to partners'), big(p.owed_total), esc(t('loans not repaid yet')))])
    + panel('', table([{ h: t('Partner') }, { h: t('Share'), n: true }, { h: t('Owed to them'), n: true }, { h: t('Profit received'), n: true, cls: 'hide-sm' }],
      p.partners.map(x => ({ href: `partner/${x.id}`, cls: x.archived ? 'dim' : '', cells: [`<b>${esc(x.name)}</b>${x.archived ? ' ' + pill(t('archived')) : ''}`, `${fmtNum(x.ownership_percent, Number.isInteger(x.ownership_percent) ? 0 : 2)} %`,
        esc(fmtUsd(x.owed_usd)), esc(fmtUsd(x.distributed_usd))] })), { emptyText: t('No partners yet.') }), { tight: true })
    + (p.distributions.length ? panel(t('Profit shared out'), table([{ h: t('Date') }, { h: t('Amount'), n: true }, { h: t('From'), cls: 'hide-sm' }, { h: '' }],
      p.distributions.map(d => ({ cells: [esc(fmtDate(d.occurred_on)) + (d.notes ? `<span class="sub">${esc(d.notes)}</span>` : ''), esc(fmtMoney(d.total_amount, d.currency_code)), esc(d.account_name || ''),
        `<div class="rowacts"><button class="btn sm danger" data-act="delDistribution" data-id="${esc(d.id)}">✕</button></div>`] }))), { tight: true }) : '');
}
function partner(pidRaw) {
  const p = D.partnerDetail(id(pidRaw));
  if (!p) return header(t('Partners'), { back: 'partners' }) + empty('—');
  const x = p.partner, P = esc(x.id);
  const LABEL = { loan: t('Loan'), repayment: t('Repayment'), distribution: t('Profit share') };
  const rows = p.ledger.map(e => ({ cells: [esc(fmtDate(e.occurred_on)),
    `<b>${esc(LABEL[e.kind] || e.kind)}</b><span class="sub">${esc(e.method === 'direct' ? t('Paid directly') : e.account_name ? (e.kind === 'loan' ? t('Into {a}', { a: e.account_name }) : t('From {a}', { a: e.account_name })) : '—')}${e.description ? ' · ' + esc(e.description) : ''}</span>`
      + (e.ref_type === 'purchase_order' && e.ref_id !== null ? `<span class="sub"><a href="#/po/${esc(e.ref_id)}">${esc(t('Purchase order'))} ${esc(poNo(e.ref_id))}</a></span>` : ''),
    esc(fmtMoney(e.amount, e.currency_code)) + (e.currency_code !== 'USD' ? `<span class="sub">${esc(fmtUsd(e.usd))}</span>` : ''), esc(fmtUsd(e.owed_after)),
    e.kind === 'distribution' ? '' : `<div class="rowacts"><button class="btn sm danger" data-act="delPartnerEntry" data-id="${esc(e.id)}">✕</button></div>`] }));
  return header(x.name, { back: 'partners', eyebrow: t('Partner'), sub: esc([`${fmtNum(x.ownership_percent, Number.isInteger(x.ownership_percent) ? 0 : 2)} %`, x.phone, x.email].filter(Boolean).join(' · ')),
    actions: `<button class="btn primary" data-act="partnerLoan" data-id="${P}">${esc(t('Record a loan'))}</button><button class="btn" data-act="partnerRepay" data-id="${P}">${esc(t('Repay'))}</button><button class="btn" data-act="editPartner" data-id="${P}">${esc(t('Edit'))}</button><button class="btn ghost danger" data-act="delPartner" data-id="${P}">${esc(t('Delete'))}</button>` })
    + tiles([tile(t('Lent'), big(p.position.lent_usd), ''), tile(t('Repaid'), big(p.position.repaid_usd), ''), tile(t('Owed to them'), big(p.position.owed_usd), ''), tile(t('Profit received'), big(p.position.distributed_usd), '')])
    + panel(t('Partner history'), table([{ h: t('Date') }, { h: '' }, { h: t('Amount'), n: true }, { h: t('Owed after'), n: true, cls: 'hide-sm' }, { h: '' }], rows, { emptyText: t('Nothing yet.') }), { tight: true });
}

// ---------- currencies ----------
function currencies() {
  const p = D.currenciesPage();
  const perUsd = r => (r.usd_per_unit ? 1 / r.usd_per_unit : null);
  return header(t('Currencies'), { sub: esc(t('USD is the reference: every amount is also counted in dollars at the rate of its day.')),
    actions: `<button class="btn primary" data-act="newRate">+ ${esc(t('New rate'))}</button><button class="btn" data-act="newCurrency">+ ${esc(t('New currency'))}</button>` }) + moneyNav('currencies')
    + (p.missing.length ? `<div class="callout bad">${esc(t('No rate yet for {c}.', { c: p.missing.map(r => r.code).join(', ') }))}</div>` : '')
    + panel(t('Today’s rates'), table([{ h: t('Currency') }, { h: t('$1 ='), n: true }, { h: t('Since'), cls: 'hide-sm' }],
      p.rates.map(r => ({ cells: [`<b>${esc(r.code)}</b><span class="sub">${esc(r.name)}</span>`, r.is_base ? '1' : perUsd(r) !== null ? esc(`${fmtNum(perUsd(r), perUsd(r) >= 100 ? 0 : 4)} ${r.code}`) : `<span class="neg">${esc(t('not set'))}</span>`,
        esc(r.rate_date ? fmtDate(r.rate_date) : '')] }))), { tight: true })
    + panel(t('Rate history'), table([{ h: t('Since') }, { h: t('Currency') }, { h: t('$1 ='), n: true }, { h: '' }],
      p.history.map(r => ({ cells: [esc(fmtDate(r.effective_from)) + (r.note ? `<span class="sub">${esc(r.note)}</span>` : ''), esc(r.currency_code), esc(`${fmtNum(1 / r.usd_per_unit, 1 / r.usd_per_unit >= 100 ? 0 : 4)}`),
        `<div class="rowacts"><button class="btn sm" data-act="editRate" data-id="${esc(r.id)}">${esc(t('Correct'))}</button><button class="btn sm danger" data-act="delRate" data-id="${esc(r.id)}">✕</button></div>`] })), { emptyText: t('No rates yet.') }), { tight: true });
}
export const MONEY_SCREENS = { money: { render: money }, account: { render: account }, expenses: { render: expenses }, partners: { render: partners }, partner: { render: partner }, currencies: { render: currencies } };

// ---------- forms ----------
const accountFields = a => [
  { name: 'name', label: t('Name'), type: 'text', value: a.name || '' },
  { name: 'account_type', label: t('Kind'), type: 'select', options: ACCOUNT_TYPES.map(([k, l]) => [k, t(l)]), value: a.account_type || 'cash' },
  { name: 'currency_code', label: t('Currency'), type: 'select', options: curOpts(), value: a.currency_code || 'GNF' },
  { name: 'opening_balance', label: t('Opening balance'), type: 'money', value: a.opening_balance ?? 0, hint: t('What was in it when you started using the app') },
  { name: 'notes', label: t('Notes'), type: 'text', value: a.notes || '' },
  ...(a.id !== undefined ? [{ name: 'archived', label: t('Archived (no longer used)'), type: 'checkbox', value: a.archived ? 1 : 0 }] : [])
];
const paidFromOpts = () => [['', t('Not paid from an account')], ...acctRows().map(a => [`acct:${a.id}`, `${a.name} (${a.currency_code})`]),
  ...all(`SELECT id, name FROM partners WHERE archived = 0 ORDER BY name`).map(p => [`partner:${p.id}`, t('{p} paid from their own pocket', { p: p.name })])];
const expenseFields = e => [
  { name: 'category', label: t('Category'), type: 'text', value: e.category || '', placeholder: t('Rent, salaries, transport…'),
    hint: (() => { const c = all(`SELECT category, COUNT(*) n FROM expenses GROUP BY category ORDER BY n DESC LIMIT 8`).map(r => r.category); return c.length ? t('Used before: {c}', { c: c.join(', ') }) : ''; })() },
  { name: 'description', label: t('Description'), type: 'text', value: e.description || '' },
  { name: 'amount', label: t('Amount'), type: 'money', value: e.amount ?? '' },
  { name: 'currency_code', label: t('Currency'), type: 'select', options: curOpts(), value: e.currency_code || 'GNF' },
  { name: 'expense_date', label: t('Date'), type: 'date', value: e.expense_date || today() },
  { name: 'paid_from', label: t('Paid from'), type: 'select', options: paidFromOpts(), value: e._paid_from ?? '', hint: t('An account (converted if it is in another currency), or a partner from their own pocket (the business then owes it to them).') }
];
const settleFields = (v0) => [
  { name: 'settled_amount', label: t('In another currency (optional)'), type: 'money', hint: t('When the money changed currency on the way (they gave dollars, the account got francs): what the other side gave or got.') },
  { name: 'settled_currency', label: t('in'), type: 'select', options: curOpts(), value: v0 || 'USD' }
];
registerActions({
  newAccount: () => openForm({ title: t('New account'), fields: accountFields({}), submit: t('Add'), run: v => F.accountNew(v), done: after() }),
  editAccount: (a) => { const x = one(`SELECT * FROM cash_accounts WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Edit account'), fields: accountFields(x), run: v => F.accountEdit(x.id, v), done: after() }); },
  adjustAccount: (a) => {
    const x = one(`SELECT * FROM cash_accounts WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Adjust {a}', { a: x.name }), intro: esc(t('For a difference found when counting the cash: + adds, − takes out.')),
      fields: [{ name: 'amount', label: t('Amount ({c})', { c: x.currency_code }), type: 'money', placeholder: '-50 000' }, { name: 'occurred_on', label: t('Date'), type: 'date', value: today() },
        { name: 'description', label: t('Reason'), type: 'text', placeholder: t('Manual adjustment') }],
      run: v => F.accountAdjust(x.id, v), done: after() });
  },
  transfer: (a) => {
    const accts = acctRows();
    if (accts.length < 2) { toast(t('Add a second account first.')); return; }
    const cur = v => (accts.find(x => String(x.id) === String(v)) || {}).currency_code;
    const from0 = a.dataset.from ? id(a.dataset.from) : accts[0].id;
    openForm({ title: t('Transfer / exchange'), submit: t('Transfer'),
      fields: [{ name: 'from_account_id', label: t('From'), type: 'select', options: acctOpts(), value: from0, redraw: true },
        { name: 'to_account_id', label: t('To'), type: 'select', options: acctOpts(), value: (accts.find(x => x.id !== from0) || accts[1]).id, redraw: true },
        { name: 'amount', label: t('Amount sent'), type: 'money' },
        { name: 'received_amount', label: t('Amount that arrived (optional)'), type: 'money', show: v => cur(v.from_account_id ?? from0) !== cur(v.to_account_id ?? (accts.find(x => x.id !== from0) || accts[1]).id),
          hint: t('Different currencies: empty = converted at your rate for the day. Enter what really arrived to see the exchange gain or loss.') },
        { name: 'occurred_on', label: t('Date'), type: 'date', value: today() }, { name: 'description', label: t('Notes'), type: 'text' }],
      run: v => F.accountTransfer({ ...v, from_account_id: id(v.from_account_id), to_account_id: id(v.to_account_id) }), done: after() });
  },
  delTransfer: (a) => confirmAction({ title: t('Remove this transfer?'), text: t('Both sides of it are removed.'), confirm: t('Remove'), run: () => F.transferDelete(a.dataset.g), done: after() }),
  cashCsv: () => {
    const rows = all(`SELECT t.occurred_on, a.name as account_name, t.kind, t.amount, t.description FROM cash_transactions t JOIN cash_accounts a ON a.id = t.account_id ORDER BY t.occurred_on DESC, t.id DESC`);
    downloadText(`mouvements-${today()}.csv`, '﻿' + [['occurred_on', 'account_name', 'kind', 'amount', 'description'], ...rows.map(r => [r.occurred_on, r.account_name, r.kind, r.amount, r.description])].map(r => r.map(csvCell).join(',')).join('\r\n'));
  },
  // expenses
  newExpense: () => openForm({ title: t('New expense'), fields: expenseFields({}), submit: t('Add'), run: v => F.expenseNew(v), done: after() }),
  editExpense: (a) => { const e = one(`SELECT * FROM expenses WHERE id = ?`, [id(a.dataset.id)]); openForm({ title: t('Edit expense'), fields: expenseFields({ ...e, _paid_from: F.expensePaidFrom(e.id) }), run: v => F.expenseEdit(e.id, v), done: after() }); },
  delExpense: (a) => confirmAction({ title: t('Delete this expense?'), text: t('The payment recorded for it is removed too.'), confirm: t('Delete'), run: () => F.expenseDelete(id(a.dataset.id)), done: after() }),
  expCsv: () => {
    const rows = all(`SELECT * FROM expenses ORDER BY expense_date DESC`);
    downloadText(`depenses-${today()}.csv`, '﻿' + [['id', 'category', 'description', 'amount', 'currency', 'expense_date', 'created_at'], ...rows.map(r => [r.id, r.category, r.description, r.amount, r.currency_code, r.expense_date, r.created_at])].map(r => r.map(csvCell).join(',')).join('\r\n'));
  },
  // partners
  newPartner: () => openForm({ title: t('New partner'), submit: t('Add'), fields: [{ name: 'name', label: t('Name'), type: 'text' }, { name: 'ownership_percent', label: t('Share of the business (%)'), type: 'number', value: 0 },
    { name: 'phone', label: t('Phone'), type: 'text' }, { name: 'email', label: t('Email'), type: 'text' }, { name: 'notes', label: t('Notes'), type: 'text' }],
  run: v => F.partnerNew(v), done: pid => { toast(t('Partner added.')); go(`partner/${pid}`); } }),
  editPartner: (a) => {
    const x = one(`SELECT * FROM partners WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Edit partner'), fields: [{ name: 'name', label: t('Name'), type: 'text', value: x.name }, { name: 'ownership_percent', label: t('Share of the business (%)'), type: 'number', value: x.ownership_percent },
      { name: 'phone', label: t('Phone'), type: 'text', value: x.phone || '' }, { name: 'email', label: t('Email'), type: 'text', value: x.email || '' }, { name: 'notes', label: t('Notes'), type: 'text', value: x.notes || '' },
      { name: 'archived', label: t('Archived (no longer a partner)'), type: 'checkbox', value: x.archived ? 1 : 0 }], run: v => F.partnerEdit(x.id, v), done: after() });
  },
  delPartner: (a) => confirmAction({ title: t('Delete this partner?'), text: t('Only possible if nothing is recorded for them — otherwise archive them.'), confirm: t('Delete'), run: () => F.partnerDelete(id(a.dataset.id)), done: after('partners') }),
  partnerLoan: (a) => {
    if (!acctRows().length) { toast(t('Add a cash account first (Money).')); return; }
    openForm({ title: t('Record a loan'), intro: esc(t('The partner puts money into one of the business’s accounts; the business owes it back.')),
      fields: [{ name: 'account_id', label: t('Into'), type: 'select', options: acctOpts() }, { name: 'amount', label: t('Amount (in the account’s currency)'), type: 'money' }, ...settleFields('USD'),
        { name: 'occurred_on', label: t('Date'), type: 'date', value: today() }, { name: 'note', label: t('Notes'), type: 'text' }],
      run: v => F.partnerLoan(id(a.dataset.id), { ...v, account_id: id(v.account_id) }), done: after() });
  },
  partnerRepay: (a) => {
    if (!acctRows().length) { toast(t('Add a cash account first (Money).')); return; }
    openForm({ title: t('Repay'), intro: esc(t('The business pays part of the loan back from one of its accounts.')),
      fields: [{ name: 'account_id', label: t('From'), type: 'select', options: acctOpts() }, { name: 'amount', label: t('Amount (in the account’s currency)'), type: 'money' }, ...settleFields('USD'),
        { name: 'occurred_on', label: t('Date'), type: 'date', value: today() }, { name: 'note', label: t('Notes'), type: 'text' }],
      run: v => F.partnerRepay(id(a.dataset.id), { ...v, account_id: id(v.account_id) }), done: after() });
  },
  delPartnerEntry: (a) => confirmAction({ title: t('Remove this entry?'), text: t('The money movement it created is removed too.'), confirm: t('Remove'), run: () => F.partnerEntryDelete(id(a.dataset.id)), done: after() }),
  distribute: () => {
    if (!acctRows().length) { toast(t('Add a cash account first (Money).')); return; }
    const p = D.partnersPage();
    openForm({ title: t('Share out profit'), submit: t('Share out'), danger: false,
      intro: esc(t('Not shared out yet: {a}. Each partner gets their percentage, paid from one account.', { a: fmtUsd(p.available) })),
      fields: [{ name: 'account_id', label: t('Paid from'), type: 'select', options: acctOpts() }, { name: 'total_amount', label: t('Total to share (in the account’s currency)'), type: 'money' },
        { name: 'occurred_on', label: t('Date'), type: 'date', value: today() }, { name: 'notes', label: t('Notes'), type: 'text' },
        { name: 'override', label: t('Distribute anyway, even if it is more than the profit not shared out yet'), type: 'checkbox' }],
      run: v => F.distribute({ ...v, account_id: id(v.account_id) }), done: after() });
  },
  delDistribution: (a) => confirmAction({ title: t('Remove this profit share?'), text: t('Each partner’s share and its money movement are removed.'), confirm: t('Remove'), run: () => F.distributionDelete(id(a.dataset.id)), done: after() }),
  // currencies
  newCurrency: () => openForm({ title: t('New currency'), submit: t('Add'), fields: [{ name: 'code', label: t('Code'), type: 'text', placeholder: 'EUR' }, { name: 'name', label: t('Name'), type: 'text', placeholder: 'Euro' },
    { name: 'symbol', label: t('Symbol'), type: 'text', placeholder: '€' }, { name: 'decimals', label: t('Decimals'), type: 'number', value: 2 }], run: v => F.currencyNew(v), done: after() }),
  newRate: () => {
    const cs = all(`SELECT code, name FROM currencies WHERE is_base = 0 ORDER BY code`);
    if (!cs.length) { toast(t('Add a currency first.')); return; }
    openForm({ title: t('New rate'), submit: t('Add'), fields: [{ name: 'currency_code', label: t('Currency'), type: 'select', options: cs.map(c => [c.code, `${c.code} — ${c.name}`]) },
      { name: 'rate', label: t('$1 ='), type: 'money', hint: t('How many units of the currency one dollar buys, e.g. 8 650 for GNF') },
      { name: 'effective_from', label: t('From'), type: 'date', value: today() }, { name: 'note', label: t('Notes'), type: 'text' }],
    run: v => F.rateNew({ ...v, direction: 'units_per_usd' }), done: after() });
  },
  editRate: (a) => {
    const r = one(`SELECT * FROM exchange_rates WHERE id = ?`, [id(a.dataset.id)]);
    const usage = F.describeCounts(F.rateUsage(r));
    openForm({ title: t('Correct the {c} rate', { c: r.currency_code }), submit: t('Save'),
      intro: esc(usage ? t('Booked at this rate today: {u}.', { u: usage }) : t('Nothing is booked at this rate yet.')),
      fields: [{ name: 'rate', label: t('$1 ='), type: 'money', value: Number((1 / r.usd_per_unit).toPrecision(10)) }, { name: 'effective_from', label: t('From'), type: 'date', value: String(r.effective_from).slice(0, 10) },
        { name: 'note', label: t('Notes'), type: 'text', value: r.note || '' },
        { name: 'restamp', label: t('Also correct what was booked at this rate (when the rate was typed wrong)'), type: 'checkbox', value: 1 }],
      run: v => F.rateEdit(r.id, { ...v, direction: 'units_per_usd' }), done: after() });
  },
  delRate: (a) => confirmAction({ title: t('Remove this rate?'), text: t('What was already booked at it keeps its value.'), confirm: t('Remove'), run: () => F.rateDelete(id(a.dataset.id)), done: after() })
});
void plural;

// Selling screens' buttons and forms: orders, lines, delivery, invoices, payments, returns,
// customers, products, sizes and boxes. Each form calls one operation from ops/.
import { all, one, val } from './localdb.js';
import * as Q from './queries.js';
import * as SO from './ops/sales.js';
import * as KO from './ops/stock.js';
import { asId } from './ops/common.js';
import { t, plural } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtNum, fmtQty, fmtDate, fmtShort, today, sum } from './util.js';
import { header, tile, tiles, panel, pill, empty, table } from './ui.js';
import { openForm, confirmAction } from './forms.js';
import { registerActions } from './actions.js';
import { go, schedule } from './app.js';
import { putBlob } from './store.js';
import { shrinkImage } from './images.js';
import { orderProformas } from './crmpages.js';

const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));
const id = v => asId(v);
const curOpts = () => all(`SELECT code, name FROM currencies ORDER BY is_base DESC, code`).map(c => [c.code, `${c.code} — ${c.name}`]);
const custOpts = (blank = true) => [...(blank ? [['', t('Walk-in customer')]] : []), ...all(`SELECT id, name FROM customers ORDER BY name`).map(c => [c.id, c.name])];
const acctOpts = () => [['', t('No account (not posted)')], ...all(`SELECT id, name, currency_code FROM cash_accounts WHERE archived = 0 ORDER BY name`).map(a => [a.id, `${a.name} (${a.currency_code})`])];
const orderNo = oid => `#${Q.orderRef(oid)}`;
export { orderNo };

// app._variant_choices — sizes for the loose-pair picker, with pairs sellable singly.
function variantChoices() {
  const avail = Q.pairsAvailable();
  return all(`SELECT v.id, v.color, v.size, v.product_id, p.name as product_name,
       (SELECT oi.unit_price FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN variants v2 ON v2.id = oi.variant_id
        WHERE oi.box_id IS NULL AND v2.product_id = v.product_id AND COALESCE(v2.color, '') = COALESCE(v.color, '') AND o.status != 'cancelled'
        ORDER BY oi.id DESC LIMIT 1) as last_price
     FROM variants v JOIN products p ON p.id = v.product_id ORDER BY p.name, v.color, v.size`)
    .map(r => ({ ...r, available: (avail.get(r.id) || {}).available || 0 }));
}
// Mixes with sealed boxes free to sell, with their list price.
function availableMixes() {
  return all(`SELECT b.source_po_id, b.source_label, COUNT(*) as n, MIN(b.received_at) as received_at FROM boxes b
              WHERE b.status = 'in_stock' GROUP BY b.source_po_id, b.source_label ORDER BY received_at DESC`)
    .map(m => {
      const tiers = all(`SELECT * FROM price_tiers WHERE source_po_id IS ? AND source_label = ? ORDER BY min_boxes`, [m.source_po_id, m.source_label]);
      return { ...m, available: Q.boxesAvailable(m.source_po_id, m.source_label), pairs: Q.mixPairsPerBox(m.source_po_id, m.source_label), tiers };
    }).filter(m => m.available > 0);
}
const mixKey = m => `${m.source_po_id ?? ''}|${m.source_label}`;

// ---------- the order page ----------
export function renderOrder(oidRaw) {
  const oid = id(oidRaw);
  const o = one(`SELECT o.*, c.name as customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [oid]);
  if (!o) return header(t('Sales'), { back: 'orders' }) + empty('—');
  const cur = o.currency_code;
  const [total, boxTotal, looseTotal] = Q.orderTotal(oid);
  const lines = Q.orderBoxLines(oid);
  const items = all(`SELECT oi.*, p.name as product_name, v.color, v.size,
                            COALESCE((SELECT SUM(ri.qty) FROM return_items ri WHERE ri.order_item_id = oi.id), 0) as returned_qty
                     FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
                     WHERE oi.order_id = ? AND oi.box_id IS NULL ORDER BY oi.box_label, p.name, v.size`, [oid]);
  const invs = all(`SELECT * FROM invoices WHERE order_id = ? ORDER BY id`, [oid]).map(i => ({ ...i, ...Q.invoiceFinancials(i.id),
    payments: all(`SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_at, id`, [i.id]) }));
  const open = o.status === 'open', done = o.status === 'fulfilled', cancelled = o.status === 'cancelled';
  const live = invs.find(i => i.status !== 'void');
  const statusPill = pill(t(done ? 'Delivered' : cancelled ? 'Cancelled' : 'Open'), done ? 'good' : cancelled ? 'bad' : 'warn');
  const acts = [];
  if (!cancelled) acts.push(`<button class="btn" data-act="editOrder" data-id="${esc(oid)}">${esc(t('Edit'))}</button>`);
  if (open) acts.push(`<button class="btn primary" data-act="deliver" data-id="${esc(oid)}">${esc(t('Deliver'))}</button>`);
  if (live) acts.push(`<a class="btn" href="#/doc/invoice/${esc(live.id)}">${esc(t('Print invoice'))}</a>`);
  const out = [header(`${t('Order')} ${orderNo(oid)}`, { back: 'orders', eyebrow: fmtDate(o.created_at), sub: `${esc(o.customer_name || t('Walk-in customer'))} · ${statusPill}${o.notes ? ' · ' + esc(o.notes) : ''}`, actions: acts.join('') })];
  // credit limit, for an order not delivered yet
  if (open && o.customer_id !== null) {
    const c = one(`SELECT * FROM customers WHERE id = ?`, [o.customer_id]);
    const cs = c ? Q.creditStatus(c, Q.orderUsdToday(oid, cur)) : null;
    if (cs) out.push(`<div class="callout ${cs.over ? 'bad' : 'good'}">${esc(cs.over
      ? t('Over the credit limit: owes {o}, this order {x}, limit {l}.', { o: fmtUsd(cs.exposure_usd), x: fmtUsd(cs.extra_usd), l: fmtUsd(cs.limit_usd) })
      : t('Within the credit limit: owes {o}, this order {x}, limit {l}.', { o: fmtUsd(cs.exposure_usd), x: fmtUsd(cs.extra_usd), l: fmtUsd(cs.limit_usd) }))}</div>`);
  }
  const big = v => esc(Math.abs(v) >= 100000 ? fmtShort(v, cur) : fmtMoney(v, cur));
  out.push(tiles([tile(t('Order total'), big(total), esc(fmtMoney(total, cur))),
    tile(t('Whole boxes'), big(boxTotal), `${fmtNum(sum(lines, l => l.qty_boxes))} ${esc(plural(sum(lines, l => l.qty_boxes), 'box', 'boxes'))}`),
    tile(t('Loose pairs'), big(looseTotal), `${fmtNum(sum(items, i => i.qty))} ${esc(plural(sum(items, i => i.qty), 'pair', 'pairs'))}`),
    tile(t('Invoices'), live ? `<span class="vsm mono">${esc(live.invoice_number)}</span>` : '—', live ? pill(t(live.status), { paid: 'good', partial: 'warn', unpaid: 'bad' }[live.status] || '') : '')]));
  // whole boxes
  const lineActs = l => open
    ? `<div class="rowacts"><button class="btn sm" data-act="editBoxLine" data-o="${esc(oid)}" data-id="${esc(l.id)}">${esc(t('Edit'))}</button><button class="btn sm danger" data-act="delBoxLine" data-o="${esc(oid)}" data-id="${esc(l.id)}">${esc(t('Remove'))}</button></div>`
    : done ? `<div class="rowacts"><button class="btn sm" data-act="editBoxLine" data-o="${esc(oid)}" data-id="${esc(l.id)}">${esc(t('Price'))}</button>${l.qty_boxes - l.returned_boxes > 0 ? `<button class="btn sm" data-act="retBoxes" data-o="${esc(oid)}" data-id="${esc(l.id)}">${esc(t('Return'))}</button>` : ''}</div>` : '';
  const boxBody = lines.length ? table([{ h: t('Mix') }, { h: t('boxes'), n: true }, { h: t('Total'), n: true }, { h: '' }],
    lines.map(l => ({ cells: [`<b>${esc(l.source_label)}</b><span class="sub">${esc(fmtMoney(l.price_per_box, cur))} / ${esc(t('box'))}${l.price_per_pair ? ` · ${esc(fmtMoney(l.price_per_pair, cur))} / ${esc(t('pair'))}` : ''}</span>`
      + (l.returned_boxes ? `<span class="sub">${esc(t('{n} returned', { n: l.returned_boxes }))}</span>` : ''),
      fmtNum(l.qty_boxes), esc(fmtMoney(l.line_total, cur)), lineActs(l)] })),
    { foot: [t('Total'), fmtNum(sum(lines, l => l.qty_boxes)), esc(fmtMoney(boxTotal, cur)), ''] }) : `<div class="panel-b">${empty(t('No whole boxes on this order.'))}</div>`;
  out.push(panel(t('Whole boxes'), boxBody, { tight: true, actions: open ? `<button class="btn sm primary" data-act="addBoxes" data-id="${esc(oid)}">+ ${esc(t('Add boxes'))}</button>` : '' }));
  // loose pairs
  const itemActs = i => open
    ? `<div class="rowacts"><button class="btn sm" data-act="editItem" data-o="${esc(oid)}" data-id="${esc(i.id)}">${esc(t('Edit'))}</button><button class="btn sm danger" data-act="delItem" data-o="${esc(oid)}" data-id="${esc(i.id)}">${esc(t('Remove'))}</button></div>`
    : done ? `<div class="rowacts"><button class="btn sm" data-act="editItem" data-o="${esc(oid)}" data-id="${esc(i.id)}">${esc(t('Price'))}</button>${i.qty - i.returned_qty > 0 ? `<button class="btn sm" data-act="retPairs" data-o="${esc(oid)}" data-id="${esc(i.id)}">${esc(t('Return'))}</button>` : ''}</div>` : '';
  if (items.length || open) {
    const body = items.length ? table([{ h: t('Products') }, { h: t('Size') }, { h: t('pairs'), n: true }, { h: t('Total'), n: true }, { h: '' }],
      items.map(i => ({ cells: [esc(i.product_name) + (i.color ? `<span class="sub">${esc(i.color)}</span>` : '') + `<span class="sub">${esc(fmtMoney(i.unit_price, cur))} / ${esc(t('pair'))}</span>`, esc(i.size),
        fmtQty(i.qty) + (i.returned_qty ? `<span class="sub">−${i.returned_qty}</span>` : ''), esc(fmtMoney((i.qty - i.returned_qty) * i.unit_price, cur)), itemActs(i)] }))) : `<div class="panel-b">${empty(t('No loose pairs on this order.'))}</div>`;
    out.push(panel(t('Loose pairs'), body, { tight: true, actions: open ? `<button class="btn sm" data-act="addPairs" data-id="${esc(oid)}">+ ${esc(t('Add pairs'))}</button>` : '' }));
  }
  // invoices and payments
  for (const i of invs) {
    const pays = i.payments.length ? table([{ h: t('Date') }, { h: t('Notes') }, { h: t('Paid'), n: true }, { h: '' }],
      i.payments.map(p => ({ cells: [esc(fmtDate(p.paid_at)), esc(p.note || ''), esc(fmtMoney(p.amount, cur)),
        `<div class="rowacts"><button class="btn sm danger" data-act="delPayment" data-id="${esc(p.id)}">${esc(t('Remove'))}</button></div>`] }))) : '';
    const payBtn = i.status !== 'void' && i.balance > 0.004 ? `<button class="btn sm primary" data-act="pay" data-id="${esc(i.id)}">${esc(t('Record a payment'))}</button>` : '';
    out.push(panel(`${t('Invoice')} ${i.invoice_number}`, `<div class="panel-b"><div class="kv"><span>${esc(t('Due'))}</span><b>${esc(fmtMoney(i.due, cur))}</b>
      <span>${esc(t('Paid'))}</span><b>${esc(fmtMoney(i.paid, cur))}</b><span>${esc(t('Balance'))}</span><b>${esc(fmtMoney(i.balance, cur))}</b>
      ${i.credit > 0.004 ? `<span>${esc(t('In credit'))}</span><b>${esc(fmtMoney(i.credit, cur))}</b>` : ''}</div></div>${pays}`,
    { tight: true, actions: `<div class="rowacts">${pill(t(i.status), { paid: 'good', partial: 'warn', unpaid: 'bad' }[i.status] || '')}${payBtn}<a class="btn sm" href="#/doc/invoice/${esc(i.id)}">${esc(t('Print'))}</a></div>` }));
  }
  // returns
  const rets = all(`SELECT r.created_at, r.reason, ri.qty, ri.restocked, ri.refund_amount, ri.order_box_line_id, p.name as product_name, v.size, bl.source_label
                    FROM returns r JOIN return_items ri ON ri.return_id = r.id LEFT JOIN variants v ON v.id = ri.variant_id LEFT JOIN products p ON p.id = v.product_id
                    LEFT JOIN order_box_lines bl ON bl.id = ri.order_box_line_id WHERE r.order_id = ? ORDER BY r.created_at DESC`, [oid]);
  if (rets.length) out.push(panel(t('Returns'), table([{ h: t('Date') }, { h: '' }, { h: t('Credited'), n: true }],
    rets.map(r => ({ cells: [esc(fmtDate(r.created_at)), esc(r.order_box_line_id ? `${r.qty} × ${r.source_label}` : `${r.qty} × ${r.product_name} ${r.size}`) + `<span class="sub">${esc(r.restocked ? t('back in stock') : t('written off'))}${r.reason ? ' · ' + esc(r.reason) : ''}</span>`, esc(fmtMoney(r.refund_amount, cur))] }))), { tight: true }));
  // proformas
  out.push(orderProformas(oid, open));
  // the rest
  const more = [];
  if (!live && total > 0.004 && !cancelled) more.push(`<button class="btn" data-act="makeInvoice" data-id="${esc(oid)}">${esc(t('Create the invoice'))}</button>`);
  if (!cancelled) more.push(`<button class="btn danger" data-act="cancelOrder" data-id="${esc(oid)}">${esc(t('Cancel the order'))}</button>`);
  if (!done && !live) more.push(`<button class="btn danger" data-act="deleteOrder" data-id="${esc(oid)}">${esc(t('Delete the order'))}</button>`);
  if (more.length) out.push(`<div class="actions">${more.join('')}</div>`);
  return out.join('');
}

// ---------- actions ----------
const after = target => (msg) => { if (typeof msg === 'string') toast(msg); if (target) go(target); else schedule(); };

registerActions({
  newOrder: (a) => openForm({
    title: t('New order'),
    fields: [
      { name: 'customer_id', label: t('Customer'), type: 'select', options: custOpts(), value: a.dataset.c || '' },
      { name: 'currency_code', label: t('Currency'), type: 'select', options: curOpts(), value: 'GNF' },
      { name: 'order_date', label: t('Date'), type: 'date', value: today() },
      { name: 'notes', label: t('Notes'), type: 'textarea' }
    ],
    submit: t('Create the order'),
    run: v => SO.orderNew(v),
    done: newId => go('order/' + newId)
  }),
  editOrder: (a) => {
    const o = one(`SELECT * FROM orders WHERE id = ?`, [id(a.dataset.id)]);
    openForm({
      title: t('Edit the order'),
      fields: [
        { name: 'customer_id', label: t('Customer'), type: 'select', options: custOpts(), value: o.customer_id ?? '' },
        { name: 'currency_code', label: t('Currency'), type: 'select', options: curOpts(), value: o.currency_code },
        { name: 'order_date', label: t('Order date'), type: 'date', value: String(o.created_at || '').slice(0, 10) },
        ...(o.status === 'fulfilled' ? [{ name: 'delivered_on', label: t('Delivery date'), type: 'date', value: String(o.fulfilled_at || '').slice(0, 10), hint: t('Moving it moves the sale, its invoice and its stock to that day in the reports.') }] : []),
        { name: 'notes', label: t('Notes'), type: 'textarea', value: o.notes || '' }
      ],
      run: v => SO.orderEdit(o.id, v), done: after()
    });
  },
  addBoxes: (a) => {
    const oid = id(a.dataset.id);
    const cur = val(`SELECT currency_code FROM orders WHERE id = ?`, [oid]);
    const mixes = availableMixes();
    if (!mixes.length) { toast(t('No sealed boxes free to sell.')); return; }
    const tierText = m => m.tiers.length ? m.tiers.map(x => `${x.min_boxes}+ : ${fmtMoney(x.price_per_pair, x.currency_code)}/${t('pair')}`).join(' · ') : '';
    openForm({
      title: t('Add whole boxes'),
      fields: [
        { name: 'mix', label: t('Mix'), type: 'select', redraw: true, options: mixes.map(m => [mixKey(m), `${m.source_label} (${m.available})`]) },
        { name: 'info', type: 'html', html: v => {
          const m = mixes.find(x => mixKey(x) === v.mix) || mixes[0];
          const tiers = tierText(m);
          return `<div class="callout"><b>${esc(m.available)}</b> ${esc(plural(m.available, 'box', 'boxes'))} ${esc(t('free to sell'))} · ${esc(m.pairs)} ${esc(t('pairs'))} / ${esc(t('box'))}${tiers ? `<br><span class="sub">${esc(t('Price list'))} : ${esc(tiers)}</span>` : ''}</div>`;
        } },
        { name: 'qty', label: t('Boxes'), type: 'number', value: 1 },
        { name: 'price_per_pair', label: t('Price per pair ({c})', { c: cur }), type: 'money', hint: t('Or fill the price per box instead.') },
        { name: 'price_per_box', label: t('Price per box ({c})', { c: cur }), type: 'money' }
      ],
      submit: t('Add'),
      run: v => {
        const m = mixes.find(x => mixKey(x) === v.mix) || mixes[0];
        return SO.orderAttachBoxes(oid, { po_id: m.source_po_id, label: m.source_label, qty: v.qty, price_per_pair: v.price_per_pair, price_per_box: v.price_per_pair !== '' ? '' : v.price_per_box });
      },
      done: after()
    });
  },
  addPairs: (a) => {
    const oid = id(a.dataset.id);
    const cur = val(`SELECT currency_code FROM orders WHERE id = ?`, [oid]);
    const ch = variantChoices().filter(v => v.available > 0);
    if (!ch.length) { toast(t('No pairs can be sold singly: open a box first (Inventory).')); return; }
    openForm({
      title: t('Add loose pairs'),
      fields: [
        { name: 'variant_id', label: t('Size'), type: 'select', options: ch.map(v => [v.id, `${v.product_name}${v.color ? ' ' + v.color : ''} · ${v.size} — ${v.available} ${t('available')}${v.last_price ? ` · ${t('last')} ${fmtMoney(v.last_price, cur)}` : ''}`]) },
        { name: 'qty', label: t('Pairs'), type: 'number', value: 1 },
        { name: 'price_per_pair', label: t('Price per pair ({c})', { c: cur }), type: 'money' }
      ],
      submit: t('Add'),
      run: v => SO.orderAddItem(oid, { variant_id: id(v.variant_id), qty: v.qty, price_per_pair: v.price_per_pair }),
      done: after()
    });
  },
  editBoxLine: (a) => {
    const l = one(`SELECT * FROM order_box_lines WHERE id = ?`, [id(a.dataset.id)]);
    const o = one(`SELECT status, currency_code FROM orders WHERE id = ?`, [l.order_id]);
    openForm({
      title: l.source_label,
      fields: [
        ...(o.status === 'open' ? [{ name: 'qty_boxes', label: t('Boxes'), type: 'number', value: l.qty_boxes }] : []),
        { name: 'price_per_box', label: t('Price per box ({c})', { c: o.currency_code }), type: 'money', value: l.price_per_box }
      ],
      run: v => SO.orderBoxLineEdit(l.order_id, l.id, { qty_boxes: v.qty_boxes ?? l.qty_boxes, price_per_box: v.price_per_box }), done: after()
    });
  },
  delBoxLine: (a) => confirmAction({ title: t('Remove this line?'), text: t('The boxes go back to being free to sell.'), confirm: t('Remove'),
    run: () => SO.orderBoxLineDelete(id(a.dataset.o), id(a.dataset.id)), done: after() }),
  editItem: (a) => {
    const i = one(`SELECT oi.*, o.status, o.currency_code FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?`, [id(a.dataset.id)]);
    openForm({
      title: SO.variantName(i.variant_id),
      fields: [
        ...(i.status === 'open' ? [{ name: 'qty', label: t('Pairs'), type: 'number', value: i.qty }] : []),
        { name: 'unit_price', label: t('Price per pair ({c})', { c: i.currency_code }), type: 'money', value: i.unit_price }
      ],
      run: v => SO.orderItemEdit(i.order_id, i.id, { qty: v.qty ?? i.qty, unit_price: v.unit_price }), done: after()
    });
  },
  delItem: (a) => confirmAction({ title: t('Remove this line?'), text: '', confirm: t('Remove'), run: () => SO.orderItemDelete(id(a.dataset.o), id(a.dataset.id)), done: after() }),
  deliver: (a) => {
    const oid = id(a.dataset.id);
    const o = one(`SELECT * FROM orders WHERE id = ?`, [oid]);
    const c = o.customer_id !== null ? one(`SELECT * FROM customers WHERE id = ?`, [o.customer_id]) : null;
    const cs = c ? Q.creditStatus(c, Q.orderUsdToday(oid, o.currency_code)) : null;
    openForm({
      title: t('Deliver the order'),
      intro: esc(t('The boxes leave stock, the costs are fixed, and the invoice is raised for {a}.', { a: fmtMoney(Q.orderTotal(oid)[0], o.currency_code) })),
      fields: [
        { name: 'delivered_on', label: t('Delivery date'), type: 'date', value: today() },
        ...(cs && cs.over ? [{ name: 'credit_ok', label: t('Deliver anyway (over the credit limit)'), type: 'checkbox' }] : [])
      ],
      submit: t('Deliver'),
      run: v => SO.orderFulfill(oid, v), done: after()
    });
  },
  cancelOrder: (a) => confirmAction({ title: t('Cancel this order?'), text: t('Boxes go back to stock, stock movements are reversed and its invoice is voided. Payments already received stay on record.'), confirm: t('Cancel the order'),
    run: () => SO.orderCancel(id(a.dataset.id)), done: after() }),
  deleteOrder: (a) => confirmAction({ title: t('Delete this order?'), text: t('It disappears completely. Any boxes it held are back in stock.'), confirm: t('Delete'),
    run: () => SO.orderDelete(id(a.dataset.id)), done: after('orders') }),
  makeInvoice: (a) => confirmAction({ title: t('Create the invoice?'), text: '', confirm: t('Create'), danger: false, run: () => SO.orderCreateInvoice(id(a.dataset.id)), done: after() }),
  pay: (a) => {
    const iid = id(a.dataset.id);
    const fin = Q.invoiceFinancials(iid);
    const inv = one(`SELECT * FROM invoices WHERE id = ?`, [iid]);
    openForm({
      title: t('Payment on {n}', { n: inv.invoice_number }),
      intro: esc(t('Still owed: {b}', { b: fmtMoney(fin.balance, fin.currency_code) })),
      fields: [
        { name: 'amount', label: t('Amount received ({c})', { c: fin.currency_code }), type: 'money' },
        { name: 'pay_in_full', label: t('Paid in full ({b})', { b: fmtMoney(fin.balance, fin.currency_code) }), type: 'checkbox' },
        { name: 'paid_on', label: t('Date'), type: 'date', value: today() },
        { name: 'account_id', label: t('Into account'), type: 'select', options: acctOpts() },
        { name: 'note', label: t('Notes'), type: 'text' }
      ],
      submit: t('Record the payment'),
      run: v => SO.invoicePay(iid, { ...v, amount: v.pay_in_full ? '' : v.amount, account_id: id(v.account_id) }), done: after()
    });
  },
  delPayment: (a) => confirmAction({ title: t('Remove this payment?'), text: t('The money it put into an account comes out again.'), confirm: t('Remove'),
    run: () => SO.invoicePaymentDelete(id(a.dataset.id)), done: after() }),
  retBoxes: (a) => {
    const l = one(`SELECT * FROM order_box_lines WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Return boxes — {l}', { l: l.source_label }),
      fields: [{ name: 'qty', label: t('Boxes'), type: 'number', value: 1 }, { name: 'restock', label: t('Back in stock (not damaged)'), type: 'checkbox', value: 1 }, { name: 'reason', label: t('Reason'), type: 'text' }],
      submit: t('Record the return'), run: v => SO.orderBoxLineReturn(l.order_id, l.id, v), done: after() });
  },
  retPairs: (a) => {
    const i = one(`SELECT * FROM order_items WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Return pairs — {v}', { v: SO.variantName(i.variant_id) }),
      fields: [{ name: 'qty', label: t('Pairs'), type: 'number', value: 1 }, { name: 'restock', label: t('Back in stock (not damaged)'), type: 'checkbox', value: 1 }, { name: 'reason', label: t('Reason'), type: 'text' }],
      submit: t('Record the return'), run: v => SO.orderItemReturn(i.order_id, i.id, v), done: after() });
  },

  // ---------- customers ----------
  newCustomer: () => openForm({ title: t('New customer'), fields: customerFields({}), submit: t('Add the customer'),
    run: v => KO.customerNew(v), done: newId => { toast(t('Customer added.')); go('customer/' + newId); } }),
  editCustomer: (a) => {
    const c = one(`SELECT * FROM customers WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Edit the customer'), fields: customerFields(c), run: v => KO.customerEdit(c.id, v), done: after() });
  },
  delCustomer: (a) => confirmAction({ title: t('Delete this customer?'), text: t('Only possible if they have no orders.'), confirm: t('Delete'), run: () => KO.customerDelete(id(a.dataset.id)), done: after('customers') }),
  payCustomer: (a) => {
    const cid = id(a.dataset.id);
    const open = KO.openInvoices(cid);
    if (!open.length) { toast(t('Nothing is owed.')); return; }
    openForm({ title: t('Record a payment'),
      fields: [
        { name: 'invoice_id', label: t('Invoice'), type: 'select', options: open.map(i => [i.id, `${i.invoice_number} · ${fmtDate(i.issued_at)} — ${t('owes')} ${fmtMoney(i.balance, i.currency_code)}`]) },
        { name: 'amount', label: t('Amount received (in the invoice currency)'), type: 'money' },
        { name: 'pay_in_full', label: t('Paid in full'), type: 'checkbox' },
        { name: 'paid_on', label: t('Date'), type: 'date', value: today() },
        { name: 'account_id', label: t('Into account'), type: 'select', options: acctOpts() },
        { name: 'note', label: t('Notes'), type: 'text' }
      ],
      submit: t('Record the payment'),
      run: v => SO.invoicePay(id(v.invoice_id), { ...v, amount: v.pay_in_full ? '' : v.amount, account_id: id(v.account_id) }), done: after() });
  },

  // ---------- products and sizes ----------
  newProduct: () => openForm({ title: t('New style'), fields: productFields({}), submit: t('Add the style'),
    prepare: preparePhoto, run: v => KO.productNew({ ...v, image: v._image }), done: newId => { toast(t('Style added — now add its sizes.')); go('product/' + newId); } }),
  editProduct: (a) => {
    const p = one(`SELECT * FROM products WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Edit the style'), fields: [...productFields(p), ...(p.image_filename ? [{ name: 'remove_image', label: t('Remove the photo'), type: 'checkbox' }] : [])],
      prepare: preparePhoto, run: v => KO.productEdit(p.id, { ...v, image: v._image }), done: after() });
  },
  addSize: (a) => openForm({ title: t('Add a size'),
    fields: [{ name: 'color', label: t('Color'), type: 'text' }, { name: 'size', label: t('Size'), type: 'text' }, { name: 'initial_qty', label: t('Pairs in stock now'), type: 'number', value: 0 }],
    submit: t('Add'), run: v => KO.productAddSize(id(a.dataset.id), v), done: after() }),
  adjust: (a) => openForm({ title: t('Adjust stock — {v}', { v: SO.variantName(id(a.dataset.id)) }),
    fields: [{ name: 'delta', label: t('Pairs to add (minus to remove)'), type: 'number' }, { name: 'note', label: t('Reason'), type: 'text' }],
    run: v => KO.variantAdjust(id(a.dataset.id), v), done: after() }),
  renameSize: (a) => {
    const v0 = one(`SELECT * FROM variants WHERE id = ?`, [id(a.dataset.id)]);
    openForm({ title: t('Rename the size'), fields: [{ name: 'color', label: t('Color'), type: 'text', value: v0.color }, { name: 'size', label: t('Size'), type: 'text', value: v0.size }],
      run: v => KO.variantRename(v0.id, v), done: after() });
  },
  delSize: (a) => confirmAction({ title: t('Delete this size?'), text: t('Only possible if no order, purchase order or box uses it.'), confirm: t('Delete'), run: () => KO.variantDelete(id(a.dataset.id)), done: after() }),

  // ---------- boxes ----------
  openOne: (a) => confirmAction({ title: t('Open a box of {l}?', { l: a.dataset.l }), text: t('Its pairs can then be sold one by one; it no longer counts as a sealed box.'), confirm: t('Open a box'), danger: false,
    run: () => KO.boxOpenOne(id(a.dataset.po === 'none' ? null : a.dataset.po), a.dataset.l), done: after() }),
  openBox: (a) => confirmAction({ title: t('Open this box?'), text: t('Its pairs can then be sold one by one; it no longer counts as a sealed box.'), confirm: t('Open'), danger: false, run: () => KO.boxOpen(id(a.dataset.id)), done: after() }),
  reseal: (a) => confirmAction({ title: t('Seal this box again?'), text: t('Only possible while every pair is still in it.'), confirm: t('Seal again'), danger: false, run: () => KO.boxReseal(id(a.dataset.id)), done: after() }),
  delBox: (a) => confirmAction({ title: t('Delete this box?'), text: t('For a box received by mistake: its stock is reversed.'), confirm: t('Delete'), run: () => KO.boxDelete(id(a.dataset.id)), done: after('boxes') }),
  countBox: (a) => {
    const bid = id(a.dataset.id);
    const its = Q.boxContents(bid);
    openForm({ title: t('Count what is left'), intro: esc(t('Enter the pairs you find for each size; leave empty what you did not count. Missing pairs come off stock as a loss.')),
      fields: its.filter(i => (i.qty_left || 0) > 0).map(i => ({ name: 'c' + i.id, label: `${i.product_name}${i.color ? ' ' + i.color : ''} · ${i.size} (${i.qty_left})`, type: 'number' })),
      run: v => KO.boxCount(bid, Object.fromEntries(its.map(i => [i.id, v['c' + i.id] ?? '']))), done: after() });
  },
  moveBoxes: (a) => {
    const locs = all(`SELECT id, name FROM locations WHERE archived = 0 ORDER BY name`);
    if (locs.length < 2) { toast(t('Add a second location first.')); return; }
    const po = a.dataset.po === 'none' ? null : id(a.dataset.po), label = a.dataset.l;
    const here = all(`SELECT location_id, COUNT(*) as n FROM boxes WHERE source_po_id IS ? AND source_label = ? AND status = 'in_stock' GROUP BY location_id`, [po, label]);
    openForm({ title: t('Move boxes — {l}', { l: label }),
      intro: esc(here.map(h => `${(locs.find(l => l.id === h.location_id) || {}).name || t('No location')}: ${h.n}`).join(' · ')),
      fields: [
        { name: 'from_location_id', label: t('From'), type: 'select', options: locs.map(l => [l.id, l.name]), value: a.dataset.from ? id(a.dataset.from) : (here[0] ? here[0].location_id : locs[0].id) },
        { name: 'to_location_id', label: t('To'), type: 'select', options: locs.map(l => [l.id, l.name]), value: (locs.find(l => String(l.id) !== String(a.dataset.from ?? (here[0] ? here[0].location_id : locs[0].id))) || locs[1]).id },
        { name: 'qty', label: t('Boxes'), type: 'number', value: 1 }, { name: 'note', label: t('Notes'), type: 'text' }
      ],
      run: v => KO.locationMove({ ...v, po_id: po, label, from_location_id: id(v.from_location_id), to_location_id: id(v.to_location_id) }), done: after() });
  }
});

function customerFields(c) {
  return [
    { name: 'name', label: t('Name'), type: 'text', value: c.name || '' },
    { name: 'phone', label: t('Phone'), type: 'text', value: c.phone || '' },
    { name: 'email', label: t('Email'), type: 'text', value: c.email || '' },
    { name: 'address', label: t('Address'), type: 'text', value: c.address || '' },
    { name: 'discount_percent', label: t('Discount (%)'), type: 'number', value: c.discount_percent || 0 },
    { name: 'credit_limit', label: t('Credit limit'), type: 'money', value: c.credit_limit ?? '', hint: t('Empty = no limit') },
    { name: 'credit_currency', label: t('Currency of the limit'), type: 'select', options: curOpts(), value: c.credit_currency || 'GNF' }
  ];
}
function productFields(p) {
  return [
    { name: 'name', label: t('Style name'), type: 'text', value: p.name || '' },
    { name: 'sku_prefix', label: t('Code'), type: 'text', value: p.sku_prefix || '', hint: t('Short code, e.g. AF-WB') },
    { name: 'brand', label: t('Brand'), type: 'text', value: p.brand || '' },
    { name: 'category', label: t('Category'), type: 'text', value: p.category || '' },
    { name: 'cost_price', label: t('Cost per pair (USD)'), type: 'money', value: p.cost_price ?? 0 },
    { name: 'sale_price', label: t('Price per pair (USD)'), type: 'money', value: p.sale_price ?? 0 },
    { name: 'reorder_level', label: t('Reorder at (pairs per size)'), type: 'number', value: p.reorder_level ?? 0 },
    { name: 'photo', label: t('Photo'), type: 'file', accept: 'image/*' }
  ];
}
// A chosen photo is shrunk and saved in its own document first; the style then points to it.
async function preparePhoto(v) {
  if (!v.photo) return;
  const bytes = new Uint8Array(await v.photo.arrayBuffer());
  const img = await shrinkImage(bytes, v.photo.name || 'photo.jpg');
  const name = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join('') + '.jpg';
  await putBlob('images', name, img);
  v._image = name;
}

// Every screen: render(...args) returns the page's HTML; mount(...args) wires its inputs.
import { all, one, val } from './localdb.js';
import * as Q from './queries.js';
import { t, plural } from './i18n.js';
import { esc, fmtMoney, fmtUsd, fmtShort, fmtQty, fmtDate, fmtNum, sum, $ } from './util.js';
import { header, tile, tiles, panel, pill, empty, table, search } from './ui.js';
import { schedule } from './app.js';
import { importScreen } from './importer.js';
import { getBlob } from './store.js';
import { registerActions } from './actions.js';
import { renderOrder } from './sell.js';
import { renderDoc, mountDoc } from './docs.js';
import { BUY_SCREENS } from './buy.js';
import { PLAN_SCREENS } from './plan.js';
import { MONEY_SCREENS } from './moneypages.js';
import { REPORT_SCREENS } from './reportpages.js';

const UI = { stockQ: '', custQ: '', orderQ: '', orderStatus: '' };
const hasData = () => !!val(`SELECT 1 FROM products LIMIT 1`) || !!val(`SELECT 1 FROM customers LIMIT 1`);
const statusPill = s => pill(t(s === 'in_stock' ? 'sealed' : s), { in_stock: 'good', open: 'accent', sold: '', emptied: '' }[s] || '');
const orderPill = s => pill(t(s === 'fulfilled' ? 'Delivered' : s === 'cancelled' ? 'Cancelled' : 'Open'), { fulfilled: 'good', cancelled: 'bad', open: 'warn' }[s] || '');
const invPill = s => pill(t(s), { paid: 'good', partial: 'warn', unpaid: 'bad', void: '', unpriced: 'warn' }[s] || '');
const mixHref = (po, label) => `mix/${po ?? 'none'}/${encodeURIComponent(label || '')}`;
// Big amounts (millions of francs) in a tile read better short: 5,3 M FG. The exact figure is in the panel below.
const tileMoney = (v, cur) => esc(Math.abs(v) >= 100000 ? fmtShort(v, cur) : fmtMoney(v, cur));
const orderNo = id => `#${Q.orderRef(id)}`;

function bindSearch(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => { UI[key] = el.value; schedule(); });
}

// ---------- home ----------
function home() {
  if (!hasData()) {
    return header(t('Home')) + panel('', empty(t('Your data isn’t here yet'), t('Import the backup from your current app to see your stock, customers and sales here.'),
      `<a class="btn primary" href="#/import">${esc(t('Import data'))}</a>`));
  }
  const d = Q.dashboardFigures();
  const owed = d.outstanding_count === 1 ? t('on 1 invoice') : t('on {n} invoices', { n: d.outstanding_count });
  const out = [header(t('Home'), { sub: esc(fmtDate(new Date().toISOString())), actions: `<button class="btn primary" data-act="newOrder">+ ${esc(t('New order'))}</button>` })];
  out.push(tiles([
    tile(t('Stock value'), fmtShort(d.stock_value), esc(t('at landed cost')), 'stock', 'hl'),
    tile(t('Customers owe'), fmtShort(d.outstanding_total), esc(owed), 'customers', d.outstanding_total > 0 ? 'neg' : ''),
    tile(t('Cash on hand'), fmtShort(d.cash_on_hand), esc(t('across your accounts')), 'money'),
    tile(t('Boxes in stock'), fmtNum(d.boxes_in_stock), esc(t('sealed boxes')), 'boxes')
  ]));
  const recent = table([{ h: t('Order') }, { h: t('Customer') }, { h: t('Status'), cls: 'hide-sm' }, { h: t('Total'), n: true }],
    d.recent_orders.map(o => ({ href: `order/${o.id}`, cells: [`<span class="mono">${orderNo(o.id)}</span><span class="sub">${esc(fmtDate(o.created_at))}</span>`,
      esc(o.customer_name || t('Walk-in customer')), orderPill(o.status), esc(fmtMoney(o.order_total, o.currency_code))] })),
    { emptyText: t('No orders yet.') });
  const low = d.low_stock.slice(0, 12);
  const lowT = low.length ? table([{ h: t('Products') }, { h: t('Size') }, { h: t('On hand'), n: true }],
    low.map(v => ({ href: `product/${v.product_id}`, cells: [esc(v.product_name) + (v.color ? `<span class="sub">${esc(v.color)}</span>` : ''), esc(v.size), fmtQty(v.qty_on_hand)] })))
    : `<div class="panel-b">${empty(t('Nothing is low.'))}</div>`;
  out.push(`<div class="grid2">${panel(t('Recent orders'), recent, { tight: true, actions: `<a class="btn sm ghost" href="#/orders">${esc(t('See all'))}</a>` })}
    ${panel(t('Low stock') + (d.low_stock.length ? ` · ${d.low_stock.length}` : ''), lowT, { tight: true })}</div>`);
  if (d.uninvoiced.length) {
    out.push(panel(t('Delivered, not invoiced'), table([{ h: t('Order') }, { h: t('Customer') }, { h: t('Total'), n: true }],
      d.uninvoiced.map(o => ({ href: `order/${o.id}`, cells: [`<span class="mono">${orderNo(o.id)}</span>`, esc(o.customer_name || ''), esc(fmtMoney(o.order_total, o.currency_code))] }))), { tight: true }));
  }
  return out.join('');
}

// ---------- stock: styles with their sizes ----------
function stock() {
  const q = UI.stockQ.trim().toLowerCase();
  const styles = all(`SELECT * FROM products ORDER BY name`).map(p => {
    const vs = Q.variantsForProduct(p.id);
    return { ...p, variants: vs, total: sum(vs, v => v.qty_on_hand), low: vs.length ? vs.some(v => v.qty_on_hand <= p.reorder_level) : false };
  }).filter(p => !q || [p.name, p.brand, p.category, p.sku_prefix].some(x => String(x || '').toLowerCase().includes(q)));
  const totalPairs = sum(styles, p => p.total);
  const rows = styles.map(p => {
    const colors = [...new Set(p.variants.map(v => v.color).filter(Boolean))];
    return { href: `product/${p.id}`, cells: [
      `<b>${esc(p.name)}</b><span class="sub">${esc([p.brand, p.sku_prefix].filter(Boolean).join(' · '))}</span>`,
      esc(colors.join(', ')) || '<span class="muted">—</span>',
      `${fmtQty(p.total)} ${p.low ? pill(t('low'), 'warn') : ''}`,
      esc(fmtUsd(p.sale_price))] };
  });
  return header(t('Stock'), { sub: `${styles.length} ${esc(t('Styles').toLowerCase())} · ${fmtQty(totalPairs)} ${esc(t('pairs'))}`, actions: `<button class="btn" data-act="newProduct">+ ${esc(t('New style'))}</button>` })
    + `<div class="inline">${search('q-stock', UI.stockQ, t('Search a style, brand or code'))}</div>`
    + panel('', table([{ h: t('Styles') }, { h: t('Color'), cls: 'hide-sm' }, { h: t('On hand'), n: true }, { h: t('Price'), n: true, cls: 'hide-sm' }], rows, { emptyText: t('No products yet.') }), { tight: true });
}

function product(id) {
  const pid = /^\d+$/.test(id) ? Number(id) : id;
  const p = one(`SELECT * FROM products WHERE id = ?`, [pid]);
  if (!p) return header(t('Products'), { back: 'stock' }) + empty('—');
  const vs = Q.variantsForProduct(pid);
  const avail = Q.allVariantStock().filter(v => v.product_id === pid);
  const total = sum(vs, v => v.qty_on_hand);
  const value = sum(vs, v => Math.max(v.qty_on_hand, 0) * Q.loosePairCost(v.variant_id));
  const rows = vs.map(v => ({ cls: v.qty_on_hand <= p.reorder_level ? 'warnrow' : '', cells: [esc(v.color || '—'), `<b>${esc(v.size)}</b>`, `<span class="mono">${esc(v.sku)}</span>`, fmtQty(v.qty_on_hand),
    `<div class="rowacts"><button class="btn sm" data-act="adjust" data-id="${esc(v.variant_id)}">${esc(t('Adjust'))}</button><button class="btn sm ghost" data-act="renameSize" data-id="${esc(v.variant_id)}">${esc(t('Rename'))}</button><button class="btn sm ghost danger" data-act="delSize" data-id="${esc(v.variant_id)}">✕</button></div>`] }));
  void avail;
  return header(p.name, { back: 'stock', eyebrow: [p.brand, p.category].filter(Boolean).join(' · '), sub: `<span class="mono">${esc(p.sku_prefix)}</span>`,
      actions: `<button class="btn" data-act="editProduct" data-id="${esc(pid)}">${esc(t('Edit'))}</button><button class="btn primary" data-act="addSize" data-id="${esc(pid)}">+ ${esc(t('Add a size'))}</button>` })
    + tiles([
      tile(t('On hand'), fmtQty(total), esc(t('pairs'))),
      tile(t('Value'), fmtShort(value), esc(t('at landed cost'))),
      tile(t('Cost'), esc(fmtUsd(p.cost_price)), esc(t('per pair'))),
      tile(t('Price'), esc(fmtUsd(p.sale_price)), esc(t('per pair')))
    ])
    + `<div id="pimg" class="pimg" data-img="${esc(p.image_filename || '')}"></div>`
    + panel(t('Sizes and stock'), table([{ h: t('Color') }, { h: t('Size') }, { h: t('Code'), cls: 'hide-sm' }, { h: t('On hand'), n: true }, { h: '' }], rows,
      { foot: ['', '', '', fmtQty(total), ''], emptyText: t('No sizes yet: add the first one.') }), { tight: true });
}

// ---------- inventory: mixes of boxes ----------
function boxes() {
  const groups = all(`
    SELECT b.source_po_id, b.source_label, COUNT(*) as total_boxes,
           SUM(CASE WHEN b.status = 'in_stock' THEN 1 ELSE 0 END) as in_stock_count,
           SUM(CASE WHEN b.status = 'sold' THEN 1 ELSE 0 END) as sold_count,
           SUM(CASE WHEN b.status = 'open' THEN 1 ELSE 0 END) as open_count,
           MIN(b.received_at) as received_at, s.name as supplier_name,
           (SELECT COALESCE(SUM(bi.qty), 0) FROM box_items bi
            WHERE bi.box_id = (SELECT id FROM boxes b2 WHERE b2.source_po_id IS b.source_po_id AND b2.source_label = b.source_label LIMIT 1)) as pairs_per_box
    FROM boxes b LEFT JOIN purchase_orders po ON po.id = b.source_po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
    GROUP BY b.source_po_id, b.source_label ORDER BY received_at DESC`);
  const inStock = sum(groups, g => g.in_stock_count);
  const rows = groups.map(g => ({ href: mixHref(g.source_po_id, g.source_label), cls: g.in_stock_count ? '' : 'dim', cells: [
    `<b>${esc(g.source_label)}</b><span class="sub">${esc(g.supplier_name || '')}${g.source_po_id ? ` · PO ${esc(g.source_po_id)}` : ''}</span>`,
    `<b>${fmtNum(g.in_stock_count)}</b>${g.open_count ? `<span class="sub">+${g.open_count} ${esc(t('open'))}</span>` : ''}`,
    fmtNum(g.sold_count), fmtNum(g.pairs_per_box), esc(fmtDate(g.received_at))] }));
  return header(t('Inventory'), { sub: `${fmtNum(inStock)} ${esc(t('sealed boxes'))} · ${groups.length} ${esc(t('Mix').toLowerCase())}s` })
    + panel('', table([{ h: t('Mix') }, { h: t('In stock'), n: true }, { h: t('Sold'), n: true, cls: 'hide-sm' }, { h: t('Pairs per box'), n: true, cls: 'hide-sm' }, { h: t('Received'), cls: 'hide-sm' }], rows,
      { emptyText: t('No boxes yet.') }), { tight: true });
}

function mix(po, label) {
  const poId = po === 'none' ? null : (/^\d+$/.test(po) ? Number(po) : po);
  const list = all(`SELECT b.*, c.name as sold_customer_name, l.name as location_name FROM boxes b
                    LEFT JOIN orders o ON o.id = b.sold_order_id LEFT JOIN customers c ON c.id = o.customer_id
                    LEFT JOIN locations l ON l.id = b.location_id
                    WHERE b.source_po_id IS ? AND b.source_label = ? ORDER BY b.box_code`, [poId, label]);
  if (!list.length) return header(t('Inventory'), { back: 'boxes' }) + empty('—');
  const contents = Q.boxContents(list[0].id);
  const ppb = sum(contents, i => i.qty);
  const cost = sum(contents, i => i.qty * i.unit_cost);
  const inStock = list.filter(b => b.status === 'in_stock');
  const sold = list.filter(b => b.status === 'sold');
  const content = table([{ h: t('Products') }, { h: t('Color') }, { h: t('Size') }, { h: t('pairs'), n: true }, { h: t('Cost'), n: true, cls: 'hide-sm' }],
    contents.map(i => ({ cells: [esc(i.product_name), esc(i.color || '—'), `<b>${esc(i.size)}</b>`, fmtQty(i.qty), esc(fmtUsd(i.unit_cost))] })),
    { foot: [t('Total'), '', '', fmtQty(ppb), esc(fmtUsd(cost))] });
  const boxRows = list.map(b => ({ cells: [`<span class="mono">${esc(b.box_code)}</span>`, statusPill(b.status),
    esc(b.status === 'sold' ? (b.sold_customer_name || '') + (b.sold_order_id ? ` · ${orderNo(b.sold_order_id)}` : '') : (b.location_name || '')), esc(fmtDate(b.sold_at || b.received_at))],
    href: `box/${b.id}` }));
  const poA = esc(poId ?? 'none'), lA = esc(label);
  return header(label, { back: 'boxes', eyebrow: t('Mix'), sub: `${esc(fmtDate(list[0].received_at))}`,
      actions: inStock.length ? `<button class="btn" data-act="openOne" data-po="${poA}" data-l="${lA}">${esc(t('Open a box'))}</button><button class="btn" data-act="moveBoxes" data-po="${poA}" data-l="${lA}">${esc(t('Move boxes'))}</button>` : '' })
    + tiles([
      tile(t('In stock'), fmtNum(inStock.length), esc(t('sealed boxes'))),
      tile(t('Sold'), fmtNum(sold.length), esc(t('boxes'))),
      tile(t('Pairs per box'), fmtNum(ppb), ''),
      tile(t('Cost'), esc(fmtUsd(cost)), esc(t('per box')))
    ])
    + panel(t('Contents of one box'), content, { tight: true })
    + panel(t('Boxes of this mix'), table([{ h: t('Box') }, { h: t('Status') }, { h: t('Customer') + ' / ' + t('Location'), cls: 'hide-sm' }, { h: t('Date'), cls: 'hide-sm' }], boxRows), { tight: true });
}

function box(idRaw) {
  const bid = /^\d+$/.test(idRaw) ? Number(idRaw) : idRaw;
  const b = one(`SELECT b.*, s.name as supplier_name, c.name as sold_customer_name, l.name as location_name FROM boxes b
                 LEFT JOIN purchase_orders po ON po.id = b.source_po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
                 LEFT JOIN orders o ON o.id = b.sold_order_id LEFT JOIN customers c ON c.id = o.customer_id
                 LEFT JOIN locations l ON l.id = b.location_id WHERE b.id = ?`, [bid]);
  if (!b) return header(t('Box'), { back: 'boxes' }) + empty('—');
  const contents = Q.boxContents(bid);
  const opened = b.status === 'open' || b.status === 'emptied';
  const totalPairs = sum(contents, i => i.qty), totalCost = sum(contents, i => i.qty * i.unit_cost);
  const left = opened ? sum(contents, i => i.qty_left || 0) : null;
  const sold = val(`SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN qty WHEN kind = 'return' THEN -qty ELSE 0 END), 0) FROM pair_picks WHERE box_id = ?`, [bid]);
  const missing = val(`SELECT COALESCE(SUM(qty), 0) FROM pair_picks WHERE box_id = ? AND kind = 'count'`, [bid]);
  const acts = [];
  if (b.status === 'in_stock') acts.push(`<button class="btn" data-act="openBox" data-id="${esc(bid)}">${esc(t('Open'))}</button>`, `<button class="btn ghost danger" data-act="delBox" data-id="${esc(bid)}">${esc(t('Delete'))}</button>`);
  if (opened) acts.push(`<button class="btn primary" data-act="countBox" data-id="${esc(bid)}">${esc(t('Count'))}</button>`);
  if (b.status === 'open') acts.push(`<button class="btn" data-act="reseal" data-id="${esc(bid)}">${esc(t('Seal again'))}</button>`);
  return header(b.box_code, { back: mixHref(b.source_po_id, b.source_label), eyebrow: `${t('Box')} · ${b.source_label || ''}`, sub: `${statusPill(b.status)} ${esc(b.location_name || '')}${b.sold_customer_name ? ' · ' + esc(b.sold_customer_name) : ''}`, actions: acts.join('') })
    + tiles([tile(t('pairs'), fmtNum(totalPairs), ''), tile(t('Cost'), esc(fmtUsd(totalCost)), esc(t('per box'))),
      tile(t('Pairs left'), left === null ? '—' : fmtNum(left), opened ? esc(t('{n} sold', { n: sold })) : ''), tile(t('Missing'), fmtNum(missing), '')])
    + panel(t('Contents of one box'), table([{ h: t('Products') }, { h: t('Size') }, { h: t('pairs'), n: true }, { h: t('Pairs left'), n: true }, { h: t('Cost'), n: true, cls: 'hide-sm' }],
      contents.map(i => ({ cells: [esc(i.product_name) + (i.color ? `<span class="sub">${esc(i.color)}</span>` : ''), `<b>${esc(i.size)}</b>`, fmtQty(i.qty), opened ? fmtQty(i.qty_left || 0) : '—', esc(fmtUsd(i.unit_cost))] }))), { tight: true });
}

// ---------- customers ----------
function customers() {
  const q = UI.custQ.trim().toLowerCase();
  const list = all(`SELECT * FROM customers ORDER BY name`).map(c => {
    const s = Q.customerSummary(c.id);
    return { ...c, s, uninvoiced: Q.uninvoicedFulfilled(c.id).length };
  }).filter(c => !q || [c.name, c.phone, c.email].some(x => String(x || '').toLowerCase().includes(q)));
  list.sort((a, b) => (b.s.outstanding_usd - a.s.outstanding_usd) || (b.uninvoiced - a.uninvoiced) || String(a.name).localeCompare(String(b.name)));
  const owed = sum(list, c => c.s.outstanding_usd);
  const rows = list.map(c => ({ href: `customer/${c.id}`, cells: [
    `<b>${esc(c.name)}</b><span class="sub">${esc(c.phone || '')}</span>`,
    c.s.outstanding_usd > 0.004 ? `<b class="neg">${esc(fmtUsd(c.s.outstanding_usd))}</b>${c.s.days_outstanding !== null ? `<span class="sub">${esc(t('oldest unpaid: {n} days', { n: c.s.days_outstanding }))}</span>` : ''}` : '<span class="muted">—</span>',
    esc(fmtUsd(c.s.lifetime_sold_usd))] }));
  return header(t('Customers'), { sub: `${list.length} · ${esc(t('Customers owe'))} ${esc(fmtUsd(owed))}`, actions: `<button class="btn" data-act="newCustomer">+ ${esc(t('New customer'))}</button>` })
    + `<div class="inline">${search('q-cust', UI.custQ, t('Search a name or phone'))}</div>`
    + panel('', table([{ h: t('Customer') }, { h: t('Owes'), n: true }, { h: t('Bought'), n: true, cls: 'hide-sm' }], rows, { emptyText: t('No customers yet.') }), { tight: true });
}

function customer(id) {
  const cid = /^\d+$/.test(id) ? Number(id) : id;
  const c = one(`SELECT * FROM customers WHERE id = ?`, [cid]);
  if (!c) return header(t('Customers'), { back: 'customers' }) + empty('—');
  const s = Q.customerSummary(cid);
  const led = Q.customerLedger(cid).slice().reverse();
  const buying = Q.customerBuying(cid);
  const ledRows = led.map(e => ({ href: `order/${e.order_id}`, cells: [esc(fmtDate(e.when)),
    e.kind === 'invoice' ? `${esc(t('Invoice'))} <span class="mono">${esc(e.label)}</span><span class="sub">${e.boxes ? `${fmtNum(e.boxes)} ${esc(plural(e.boxes, 'box', 'boxes'))}` : esc(t('loose pairs'))}</span>`
      : e.kind === 'payment' ? `${esc(t('Payment'))}<span class="sub">${esc(t('on {inv}', { inv: e.label }))}${e.note ? ' — ' + esc(e.note) : ''}</span>`
        : `${esc(t('Return'))}<span class="sub">${esc(t('{n} returned', { n: e.qty }))}${e.note ? ' — ' + esc(e.note) : ''}</span>`,
    e.charge ? esc(fmtMoney(e.charge, e.currency_code)) : '', e.payment ? esc(fmtMoney(e.payment, e.currency_code)) : '', esc(fmtMoney(e.balance, e.currency_code))] }));
  const buyRows = buying.map(b => ({ cells: [esc(b.source_label), fmtNum(b.boxes), esc(fmtMoney(b.avg_price, b.currency_code)), esc(fmtDate(b.last_bought))] }));
  return header(c.name, { back: 'customers', sub: esc([c.phone, c.address].filter(Boolean).join(' · ')),
      actions: `<button class="btn primary" data-act="newOrder" data-c="${esc(cid)}">+ ${esc(t('New order'))}</button>${s.outstanding_usd > 0.004 ? `<button class="btn" data-act="payCustomer" data-id="${esc(cid)}">${esc(t('Record a payment'))}</button>` : ''}<a class="btn" href="#/doc/statement/${esc(cid)}">${esc(t('Statement'))}</a><button class="btn ghost" data-act="editCustomer" data-id="${esc(cid)}">${esc(t('Edit'))}</button><button class="btn ghost danger" data-act="delCustomer" data-id="${esc(cid)}">${esc(t('Delete'))}</button>` })
    + tiles([
      tile(t('Owes'), fmtShort(s.outstanding_usd), s.days_outstanding !== null ? esc(t('oldest unpaid: {n} days', { n: s.days_outstanding })) : '', '', s.outstanding_usd > 0.004 ? 'neg' : ''),
      tile(t('Lifetime sales'), fmtShort(s.lifetime_sold_usd), `${s.invoice_count} ${esc(plural(s.invoice_count, 'invoice', 'invoices'))}`),
      tile(t('Last payment'), s.last_payment ? esc(fmtMoney(s.last_payment.amount, s.last_payment.currency_code)) : '—', s.last_payment ? esc(fmtDate(s.last_payment.paid_at)) : ''),
      tile(t('Credit limit'), c.credit_limit ? esc(fmtMoney(c.credit_limit, c.credit_currency || 'USD')) : '—', s.credit_usd > 0.004 ? `${esc(t('In credit'))} ${esc(fmtUsd(s.credit_usd))}` : '')
    ])
    + (buying.length ? panel(t('What they buy'), table([{ h: t('Mix') }, { h: t('boxes'), n: true }, { h: t('Avg per box'), n: true }, { h: t('Date'), cls: 'hide-sm' }], buyRows), { tight: true }) : '')
    + panel(t('Account history'), table([{ h: t('Date') }, { h: '' }, { h: t('Charge'), n: true }, { h: t('Paid'), n: true }, { h: t('Balance'), n: true, cls: 'hide-sm' }], ledRows, { emptyText: '—' }), { tight: true });
}

// ---------- sales: orders ----------
function orders() {
  const q = UI.orderQ.trim().toLowerCase();
  const st = UI.orderStatus;
  const list = all(`SELECT o.id, o.status, o.created_at, o.fulfilled_at, o.currency_code, c.name as customer_name, ${Q.ORDER_VALUE_SQL} as order_total,
                           (SELECT COUNT(*) FROM invoices i WHERE i.order_id = o.id) as invoice_count,
                           (SELECT COALESCE(SUM(qty_boxes), 0) FROM order_box_lines bl WHERE bl.order_id = o.id) as boxes
                    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id GROUP BY o.id ORDER BY o.created_at DESC`)
    .filter(o => (!st || o.status === st) && (!q || orderNo(o.id).toLowerCase().includes(q) || String(o.customer_name || '').toLowerCase().includes(q)));
  const seg = ['', 'open', 'fulfilled', 'cancelled'].map(s => `<button type="button" data-act="orderStatus" data-v="${s}" aria-pressed="${st === s}">${esc(s ? t(s === 'fulfilled' ? 'Delivered' : s === 'open' ? 'Open' : 'Cancelled') : t('All'))}</button>`).join('');
  const rows = list.map(o => ({ href: `order/${o.id}`, cls: o.status === 'cancelled' ? 'dim' : '', cells: [
    `<span class="mono">${orderNo(o.id)}</span><span class="sub">${esc(fmtDate(o.created_at))}</span>`,
    esc(o.customer_name || t('Walk-in customer')) + (o.boxes ? `<span class="sub">${fmtNum(o.boxes)} ${esc(t('boxes'))}</span>` : ''),
    orderPill(o.status), esc(fmtMoney(o.order_total, o.currency_code))] }));
  return header(t('Sales'), { sub: `${list.length} ${esc(t('Orders').toLowerCase())}`, actions: `<button class="btn primary" data-act="newOrder">+ ${esc(t('New order'))}</button>` })
    + `<div class="inline">${search('q-order', UI.orderQ, t('Search an order or customer'))}<div class="seg">${seg}</div></div>`
    + panel('', table([{ h: t('Order') }, { h: t('Customer') }, { h: t('Status'), cls: 'hide-sm' }, { h: t('Total'), n: true }], rows, { emptyText: t('No orders yet.') }), { tight: true });
}

// ---------- invoices ----------
function invoices() {
  const list = all(`SELECT i.*, c.name as customer_name FROM invoices i JOIN orders o ON o.id = i.order_id
                    LEFT JOIN customers c ON c.id = o.customer_id ORDER BY i.issued_at DESC`).map(i => ({ ...i, ...Q.invoiceFinancials(i.id) }));
  const owed = sum(list, i => i.balance_usd);
  const rows = list.map(i => ({ href: `order/${i.order_id}`, cls: i.status === 'void' ? 'void' : '', cells: [
    `<span class="mono">${esc(i.invoice_number)}</span><span class="sub">${esc(fmtDate(i.issued_at))}</span>`, esc(i.customer_name || ''), invPill(i.status),
    esc(fmtMoney(i.due, i.currency_code)), i.balance > 0.004 ? `<b>${esc(fmtMoney(i.balance, i.currency_code))}</b>` : '<span class="muted">—</span>'] }));
  return header(t('Invoices'), { sub: `${list.length} · ${esc(t('Customers owe'))} ${esc(fmtUsd(owed))}` })
    + panel('', table([{ h: t('Invoice') }, { h: t('Customer') }, { h: t('Status'), cls: 'hide-sm' }, { h: t('Total'), n: true, cls: 'hide-sm' }, { h: t('Balance'), n: true }], rows, { emptyText: t('No invoices yet.') }), { tight: true });
}

// ---------- parts not rebuilt yet ----------
const later = title => () => header(title) + panel('', empty(t('Coming in the next stage'), t('This part of the app is being rebuilt. Until then, use your current app for it.')));

export const SCREENS = {
  home: { render: home },
  stock: { render: stock, mount: () => bindSearch('q-stock', 'stockQ') },
  product: { render: product, mount: () => showImage() },
  boxes: { render: boxes },
  mix: { render: mix },
  customers: { render: customers, mount: () => bindSearch('q-cust', 'custQ') },
  customer: { render: customer },
  orders: { render: orders, mount: () => bindSearch('q-order', 'orderQ') },
  order: { render: renderOrder },
  box: { render: box },
  doc: { render: (...a) => renderDoc(...a), mount: () => mountDoc() },
  invoices: { render: invoices },
  ...BUY_SCREENS,
  ...PLAN_SCREENS,
  ...MONEY_SCREENS,
  ...REPORT_SCREENS,
  import: importScreen
};

// Product photo: fetched from its own document only when shown.
async function showImage() {
  const el = $('#pimg');
  if (!el || !el.dataset.img) return;
  const d = await getBlob('images', el.dataset.img);
  if (d && d.data && document.body.contains(el)) el.innerHTML = `<img src="${d.data}" alt="">`;
}
registerActions({ orderStatus: a => { UI.orderStatus = a.dataset.v; schedule(); } });

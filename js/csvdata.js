// The CSV exports of the old app's list pages, with the same columns and rows (app.py:
// products_export_csv, customers_export_csv, customer_ledger_csv, suppliers_export_csv,
// orders_export_csv, invoices_export_csv, po_export_csv). Records made in this app show the
// numbers a backup gives them (the same numbers the old app would show after a restore).
import { all, one } from './localdb.js';
import * as Q from './queries.js';
import { pyRound } from './util.js';

const ref = Q.refNo;

export function productsCsv() {
  const f = ['product_name', 'brand', 'category', 'color', 'size', 'sku', 'qty_on_hand', 'cost_price', 'sale_price', 'reorder_level'];
  return [f, Q.allVariantStock().map(r => f.map(c => r[c]))];
}
export function customersCsv() {
  const f = ['id', 'name', 'email', 'phone', 'address', 'discount_percent', 'created_at'];
  return [f, all(`SELECT * FROM customers ORDER BY name`).map(r => f.map(c => (c === 'id' ? ref('customers', r.id) : r[c])))];
}
// The customer's account, line by line, as on their statement.
export function customerLedgerCsv(customerId) {
  const f = ['date', 'type', 'reference', 'detail', 'currency', 'charge', 'payment', 'balance'];
  const rows = Q.customerLedger(customerId).map(e => {
    let reference, detail;
    if (e.kind === 'invoice') { reference = e.label; detail = e.boxes ? `${e.boxes} box(es)` : 'loose pairs'; }
    else if (e.kind === 'payment') { reference = 'Payment'; detail = e.cancelled ? `on ${e.label} (cancelled)` : `on ${e.label}` + (e.note ? ` — ${e.note}` : ''); }
    else { reference = 'Return'; detail = `${e.qty} returned` + (e.note ? ` — ${e.note}` : ''); }
    return [e.when, e.kind, reference, detail, e.currency_code, e.charge, e.payment, e.balance];
  });
  return [f, rows];
}
export function suppliersCsv() {
  const f = ['id', 'name', 'email', 'phone', 'address', 'created_at'];
  return [f, all(`SELECT * FROM suppliers ORDER BY name`).map(r => f.map(c => (c === 'id' ? ref('suppliers', r.id) : r[c])))];
}
export function ordersCsv() {
  const rows = all(`SELECT o.id, o.status, o.created_at, o.currency_code, c.name as customer_name, ${Q.ORDER_VALUE_SQL} as order_total
                    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id GROUP BY o.id ORDER BY o.created_at DESC`);
  return [['id', 'customer_name', 'status', 'order_total', 'created_at'], rows.map(r => [Q.orderRef(r.id), r.customer_name, r.status, r.order_total, r.created_at])];
}
export function invoicesCsv() {
  const rows = all(`SELECT i.*, o.id as order_id, c.name as customer_name FROM invoices i JOIN orders o ON o.id = i.order_id
                    LEFT JOIN customers c ON c.id = o.customer_id ORDER BY i.issued_at DESC`);
  return [['invoice_number', 'customer_name', 'order_id', 'due', 'paid', 'balance', 'status', 'issued_at'], rows.map(r => {
    const fin = Q.invoiceFinancials(r.id);
    return [r.invoice_number, r.customer_name, Q.orderRef(r.order_id), fin.due, fin.paid, fin.balance, fin.status, r.issued_at];
  })];
}
export function posCsv() {
  const rows = all(`SELECT po.id, po.status, po.created_at, po.currency_code, s.name as supplier_name,
                           COALESCE(SUM(pi.qty * pi.unit_cost * bg.box_count), 0) as goods_total
                    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
                    LEFT JOIN po_box_groups bg ON bg.po_id = po.id LEFT JOIN po_items pi ON pi.po_box_group_id = bg.id
                    GROUP BY po.id ORDER BY po.created_at DESC`);
  return [['id', 'supplier_name', 'status', 'currency_code', 'goods_total', 'goods_usd', 'landed_costs_usd', 'landed_total_usd', 'created_at'], rows.map(r => {
    const landed = Q.poLandedOverheadPerPair(r.id)[1];
    const goods = Q.poGoodsUsd(r.id, r.currency_code)[0];
    return [Q.poRef(r.id), r.supplier_name, r.status, r.currency_code, r.goods_total,
      goods !== null ? pyRound(goods, 2) : '', pyRound(landed, 2), goods !== null ? pyRound(goods + landed, 2) : '', r.created_at];
  })];
}
export const customerName = cid => (one(`SELECT name FROM customers WHERE id = ?`, [cid]) || {}).name || '';

// One CSV file: quoted where needed, Windows line ends, and a byte-order mark so Excel reads accents.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = ([fields, rows]) => '﻿' + [fields, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

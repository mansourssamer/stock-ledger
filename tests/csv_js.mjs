// The new app's CSV exports for a database, as JSON rows (see tests/csv_compare.sh).
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => 'en', setItem: () => {} };
const L = await import('../js/localdb.js');
const { TABLES } = await import('../js/schema.js');
const C = await import('../js/csvdata.js');
await L.openLocal(require('sql.js'), require.resolve('sql.js/dist/sql-wasm.wasm'));
const src = L.openBytes(fs.readFileSync(process.argv[2]));
for (const name of Object.keys(TABLES)) {
  let rows = [];
  try { rows = L.withDb(src, () => L.all(`SELECT * FROM "${name}"`)); } catch { continue; }
  for (const r of rows) L.upsertRow(name, r[TABLES[name].key], r);
}
const parse = text => {   // back from CSV text, the way Python's csv module reads it
  const out = []; let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* part of \r\n */ }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
};
const res = { products: C.productsCsv(), customers: C.customersCsv(), suppliers: C.suppliersCsv(), orders: C.ordersCsv(), invoices: C.invoicesCsv(), pos: C.posCsv() };
for (const c of L.all(`SELECT id FROM customers ORDER BY id`)) res[`ledger:${c.id}`] = C.customerLedgerCsv(c.id);
const out = {};
for (const [k, v] of Object.entries(res)) out[k] = parse(C.toCsv(v));
console.log(JSON.stringify(out));

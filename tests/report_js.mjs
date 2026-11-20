// The NEW app's report data for the pages listed by tests/report_ref.py.   node tests/report_js.mjs erp.db spec.json > out_new.json
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => 'en', setItem: () => {} };
const L = await import('../js/localdb.js');
const { TABLES } = await import('../js/schema.js');
const R = await import('../js/reports.js');
let M = {};
const CR = await import('../js/crmdata.js');
const CO = await import('../js/ops/crm.js');
try { M = await import('../js/moneydata.js'); } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; }
await L.openLocal(require('sql.js'), require.resolve('sql.js/dist/sql-wasm.wasm'));
const [, , dbIn, specPath] = process.argv;
const src = L.openBytes(fs.readFileSync(dbIn));
L.batch(() => {
  for (const [name, def] of Object.entries(TABLES)) {
    if (!L.withDb(src, () => L.all(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name])).length) continue;
    const cols = new Set(L.withDb(src, () => L.all(`PRAGMA table_info("${name}")`)).map(r => r.name));
    for (const r of L.withDb(src, () => L.all(`SELECT * FROM "${name}"`))) {
      const row = {};
      for (const [c] of def.cols) if (c !== def.key) row[c] = cols.has(c) ? r[c] : null;
      L.upsertRow(name, r[def.key], row);
    }
  }
});
const plain = v => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x)));
const out = {};
for (const p of JSON.parse(fs.readFileSync(specPath))) {
  const [fn, ...a] = p.js;
  let v;
  if (['overview', 'pnl', 'cashFlow', 'costing'].includes(fn)) { const [preset, s, e] = R.resolveRange(...a); v = R[fn](preset, s, e); }
  else if (fn === 'balanceSheet') v = R.balanceSheet();
  else if (fn === 'dailyReport') v = { rep: R.dailyReport(a[0]) };
  else if (fn === 'sales') { const [s, e, g, preset] = R.salesRange(...a); v = { rep: R.salesReport(s, e, g), preset }; }
  else if (fn === 'monthly') { const [y, m] = a[0].split('-').map(Number); v = { rep: R.monthlyReport(y, m) }; }
  else if (CR[fn]) {
    if (fn === 'crmHome' && !globalThis.__synced) { L.begin(); CO.crmReady(); L.commitLocal(); globalThis.__synced = 1; }
    v = CR[fn](...a);
    if (fn === 'crmHome' || fn === 'crmCustomers') v = { ...v, ...(v.to_call ? {} : {}) };
    if (fn === 'contactRows') v = { contacts: v };
    if (fn === 'crmCustomers' && v.rows) v = v;
    if (fn === 'contactPage' && v) v = { ...v, k: v.k };
  }
  else if (M[fn]) v = M[fn]();
  else continue;
  out[p.name] = plain(v);
}
console.log(JSON.stringify(out));

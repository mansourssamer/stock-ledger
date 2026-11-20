// The new app's buying plan on a database, as JSON.   node tests/buying_js.mjs erp.db YYYY-MM-DD > new_plan.json
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => 'en', setItem: () => {} };
const L = await import('../js/localdb.js');
const { TABLES } = await import('../js/schema.js');
const B = await import('../js/buying.js');
await L.openLocal(require('sql.js'), require.resolve('sql.js/dist/sql-wasm.wasm'));
const [, , dbIn, today] = process.argv;
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
const p = B.plan(today);
const KEYS = ['key', 'label', 'abc', 'label_key', 'in_stock', 'on_order', 'received', 'sold', 'returned', 'net_sold', 'sell_through', 'exposure', 'exposure_recent',
  'rate_window', 'rate_recent', 'rate', 'missed_window', 'hist_factor', 'base_raw', 'base', 'shrunk', 'cost_box', 'price_box', 'margin', 'gp_window',
  'gp_all', 'gmroi', 'demand_lead', 'demand_cover', 'sigma', 'safety', 'need', 'raw', 'rec', 'plan', 'trimmed', 'weeks_cover', 'stock_age', 'first_day', 'win_start'];
console.log(JSON.stringify({
  rows: p.rows.map(r => ({ ...Object.fromEntries(KEYS.map(k => [k, r[k]])), stockout: r.stockout, order_by: r.order_by, weeks: r.weeks, notes: r.notes.length, warnings: r.warnings.length })),
  pace: p.pace, planned: p.planned, container_weeks: p.container_weeks, topped: p.topped, trimmed: p.trimmed, next_order: p.next_order, prior: p.prior, counts: p.counts,
  deadlines: p.deadlines.map(e => ({ name: e.name, status: e.status, order_by: e.order_by })), requested_only: p.requested_only, lead_measured: p.lead_measured,
  models: [...B.models().keys()].sort()
}));

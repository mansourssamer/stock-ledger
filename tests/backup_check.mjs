// Builds the backup database from a database the new app made (with its text ids), for checking
// with the old app.   node tests/backup_check.mjs new.db out_backup.db
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.localStorage = { getItem: () => 'en', setItem: () => {} };
const L = await import('../js/localdb.js');
const { TABLES } = await import('../js/schema.js');
const B = await import('../js/backupdb.js');
await L.openLocal(require('sql.js'), require.resolve('sql.js/dist/sql-wasm.wasm'));
const [, , dbIn, dbOut] = process.argv;
const src = L.openBytes(fs.readFileSync(dbIn));
L.batch(() => {
  for (const [name, def] of Object.entries(TABLES)) {
    const cols = new Set(L.withDb(src, () => L.all(`PRAGMA table_info("${name}")`)).map(r => r.name));
    if (!cols.size) continue;
    for (const r of L.withDb(src, () => L.all(`SELECT * FROM "${name}"`))) {
      const row = {};
      for (const [c] of def.cols) if (c !== def.key) row[c] = cols.has(c) ? r[c] : null;
      L.upsertRow(name, r[def.key], row);
    }
  }
});
const r = B.buildBackupDb();
fs.writeFileSync(dbOut, r.bytes);
console.log(JSON.stringify({ rows: r.rows, renumbered: r.renumbered, conflicts: r.conflicts.length }));

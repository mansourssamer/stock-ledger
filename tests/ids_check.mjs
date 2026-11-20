// Ids and buckets: new ids sort after imported ones and by time; each table's rows of a day go
// in pages of 200; every id maps to exactly one bucket, and refreshing a bucket from Firestore
// touches only its own rows (old-style day ids included).
//    node tests/ids_check.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const L = await import('../js/localdb.js');
await L.openLocal(require('sql.js'), require.resolve('sql.js/dist/sql-wasm.wasm'));
let failed = 0;
const expect = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

const ids = [];
for (let i = 0; i < 450; i++) ids.push(L.ins('stock_moves', { variant_id: 1, change_qty: 1, reason: 'test' }));
const pages = [...new Set(ids.map(k => L.bucketOf('stock_moves', k)))];
expect(pages.length === 3 && pages.every(p => /^n\d{8}a[abc]$/.test(p)), `450 rows → pages ${pages.join(', ')}`);
expect(ids.every((k, i) => i === 0 || k > ids[i - 1]), 'ids increase in the order they were made');
expect(new Set(ids).size === ids.length, 'all ids different');
const day = ids[0].slice(1, 9);
// old-style ids (before pages) from the same day, and imported ones
L.upsertRow('stock_moves', `n${day}235959999k0`, { variant_id: 2, change_qty: 1, reason: 'old style' });
L.upsertRow('stock_moves', 5, { variant_id: 3, change_qty: 1, reason: 'imported' });
expect(L.bucketOf('stock_moves', `n${day}235959999k0`) === 'n' + day, 'old-style id → day bucket');
expect(L.bucketOf('stock_moves', 5) === 'i0', 'imported id → i0');
const count = () => L.val(`SELECT COUNT(*) FROM stock_moves`);
const n0 = count();
// refreshing each bucket with exactly its own rows changes nothing
const byBucket = {};
for (const r of L.all(`SELECT * FROM stock_moves`)) { const b = L.bucketOf('stock_moves', r.id); (byBucket[b] = byBucket[b] || {})[String(r.id)] = r; }
for (const [b, rows] of Object.entries(byBucket)) L.replaceBucket('stock_moves', b, rows);
expect(count() === n0, `refreshing every bucket keeps all ${n0} rows`);
// refreshing one page as empty removes only that page's rows
L.replaceBucket('stock_moves', `n${day}ab`, {});
expect(count() === n0 - 200, 'emptying page ab removes exactly its 200 rows');
L.replaceBucket('stock_moves', `n${day}`, {});
expect(count() === n0 - 201, 'emptying the old-style day bucket removes only the old-style row');
expect(L.val(`SELECT COUNT(*) FROM stock_moves WHERE id = 5`) === 1, 'imported row untouched');
// after a refresh from the server, new rows continue on the fullest page of the day
L.replaceBucket('stock_moves', `n${day}ab`, byBucket[`n${day}ab`]);
const next = L.ins('stock_moves', { variant_id: 1, change_qty: 1, reason: 'after refresh' });
expect(L.bucketOf('stock_moves', next) === `n${day}ac`, `next row goes to page ac (${L.bucketOf('stock_moves', next)})`);
// sorting: imported numbers first, then old-style, then paged ids
L.upsertRow('stock_moves', `n${day}235959999k0`, { variant_id: 2, change_qty: 1, reason: 'old style' });
const order = L.all(`SELECT id FROM stock_moves ORDER BY id`).map(r => r.id);
expect(order[0] === 5 && order[1] === `n${day}235959999k0` && order[order.length - 1] === next, 'sort order: imported, old-style, newest last');
// order numbers: fixed when made, never reused, kept by backups
const Q = await import('../js/queries.js');
const B = await import('../js/backupdb.js');
L.upsertRow('orders', 38, { status: 'fulfilled', currency_code: 'GNF' });
const o1 = L.ins('orders', { status: 'open', currency_code: 'GNF' });
const o2 = L.ins('orders', { status: 'open', currency_code: 'GNF' });
const o3 = L.ins('orders', { status: 'open', currency_code: 'GNF' });
expect([o1, o2, o3].map(Q.orderRef).join(',') === '39,40,41', `new orders numbered after the imported #38: ${[o1, o2, o3].map(Q.orderRef).join(', ')}`);
L.deleteRow('orders', o2);
expect(Q.orderRef(o3) === 41, `deleting #40 leaves #41 as #41 (${Q.orderRef(o3)})`);
const o4 = L.ins('orders', { status: 'open', currency_code: 'GNF' });
expect(Q.orderRef(o4) === 42, `the next order is #42, #40 isn't reused (${Q.orderRef(o4)})`);
const po = L.ins('purchase_orders', { currency_code: 'USD' });
expect(Q.poRef(po) === 1, `purchase orders count on their own (#${Q.poRef(po)})`);
const bk = L.openBytes(B.buildBackupDb().bytes);
const nums = L.withDb(bk, () => L.all(`SELECT id FROM orders ORDER BY id`).map(r => r.id));
expect(nums.join(',') === '38,39,41,42', `the backup gives the old app the same numbers: ${nums.join(', ')}`);
// two phones that gave the same number: the backup keeps one and moves the other after the last
L.upsertRow('orders', 'n20261121aa090000000000aa', { status: 'open', currency_code: 'GNF' });
L.upsertRow('ref_numbers', 'n20261121aa090000000000aa', { tbl: 'orders', number: 42 });
const nums2 = L.withDb(L.openBytes(B.buildBackupDb().bytes), () => L.all(`SELECT id FROM orders ORDER BY id`).map(r => r.id));
expect(nums2.join(',') === '38,39,41,42,43', `same number from two phones: no clash in the backup (${nums2.join(', ')})`);
process.exit(failed ? 1 : 0);

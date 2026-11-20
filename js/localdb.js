// The device's working copy of the data: a SQLite database in memory (sql.js).
// Screens and reports query it with the same SQL as the original Stock & Ledger app,
// so figures come out the same. It is rebuilt from Firestore's copy on this device each
// time the app opens, so it is never the only copy of anything.
import { TABLES } from './schema.js';

let DB = null;
let SQLMOD = null;

export const isReady = () => !!DB;

// Opens another database file (the old app's erp.db, for the importer).
export const openBytes = bytes => new SQLMOD.Database(bytes);
export const newDatabase = () => new SQLMOD.Database();
// Runs fn with queries pointed at another database, then switches back.
export function withDb(other, fn) {
  const keep = DB;
  DB = other;
  try { return fn(); } finally { DB = keep; }
}

function defaultSql(d) {
  if (d === undefined || d === null) return '';
  if (typeof d === 'object' && d.now) return d.now === 'date' ? " DEFAULT (date('now'))" : " DEFAULT (datetime('now'))";
  if (typeof d === 'number') return ` DEFAULT ${d}`;
  return ` DEFAULT '${String(d).replace(/'/g, "''")}'`;
}

export async function openLocal(initSqlJs, wasmUrl) {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  SQLMOD = SQL;
  DB = new SQL.Database();
  for (const [name, t] of Object.entries(TABLES)) {
    const cols = t.cols.map(([c, typ, d]) => `"${c}"${typ ? ' ' + typ : ''}${c === t.key ? ' PRIMARY KEY' : ''}${defaultSql(d)}`);
    DB.run(`CREATE TABLE "${name}" (${cols.join(', ')})`);
  }
  // Change tracking: every row a change touches is noted, so only those rows are uploaded.
  DB.run(`CREATE TEMP TABLE _track (on_ INTEGER)`);
  DB.run(`INSERT INTO _track VALUES (0)`);
  DB.run(`CREATE TEMP TABLE _changes (tbl TEXT, k)`);
  for (const [name, t] of Object.entries(TABLES)) {
    const k = `"${t.key}"`;
    DB.run(`CREATE TEMP TRIGGER "tr_i_${name}" AFTER INSERT ON main."${name}" WHEN (SELECT on_ FROM _track) = 1 BEGIN INSERT INTO _changes VALUES ('${name}', NEW.${k}); END`);
    DB.run(`CREATE TEMP TRIGGER "tr_u_${name}" AFTER UPDATE ON main."${name}" WHEN (SELECT on_ FROM _track) = 1 BEGIN INSERT INTO _changes VALUES ('${name}', NEW.${k}); INSERT INTO _changes SELECT '${name}', OLD.${k} WHERE OLD.${k} IS NOT NEW.${k}; END`);
    DB.run(`CREATE TEMP TRIGGER "tr_d_${name}" AFTER DELETE ON main."${name}" WHEN (SELECT on_ FROM _track) = 1 BEGIN INSERT INTO _changes VALUES ('${name}', OLD.${k}); END`);
  }
  // Lookups the screens do all the time.
  const idx = [['variants', 'product_id'], ['box_items', 'box_id'], ['box_items', 'variant_id'], ['stock_moves', 'variant_id'],
    ['order_items', 'order_id'], ['order_box_lines', 'order_id'], ['invoices', 'order_id'], ['invoice_payments', 'invoice_id'],
    ['boxes', 'source_po_id'], ['po_box_groups', 'po_id'], ['po_items', 'po_box_group_id'], ['pair_picks', 'order_item_id'],
    ['cash_transactions', 'account_id'], ['orders', 'customer_id'], ['return_items', 'return_id'], ['po_costs', 'po_id']];
  for (const [t, c] of idx) DB.run(`CREATE INDEX "ix_${t}_${c}" ON "${t}" ("${c}")`);
  return DB;
}

// ---------- keys and buckets ----------
// Records imported from the old app keep their number ids (123). Records made in this app get
// text ids that sort after them and by time: n + day + page + time + sequence + 2 random letters,
// e.g. n20261120aa143055123000k0.
// Firestore stores rows in "bucket" documents, which keeps the number of documents (and so the
// free daily quota) small: imported rows 200 to a bucket (i<id ÷ 200>), and the rows a table gets
// in a day in pages of about 200 (n20261120aa, n20261120ab, …). A document may hold at most
// 1 MiB and 40,000 index entries; a container receipt (thousands of stock movements in a day)
// would pass that in a single day bucket.
export function keyFromDoc(table, k) {
  return TABLES[table].key === 'id' && /^\d+$/.test(k) ? Number(k) : k;
}
export function bucketOf(table, key) {
  if (TABLES[table].key !== 'id') return 'all';
  if (typeof key === 'number') return 'i' + Math.floor(key / 200);
  const s = String(key);
  if (/^\d+$/.test(s)) return 'i' + Math.floor(Number(s) / 200);
  if (/^n\d{8}[a-z]{2}/.test(s)) return s.slice(0, 11);
  if (/^n\d{8}/.test(s)) return s.slice(0, 9);      // ids made before pages (n + day + time)
  return 'x';
}
export const PAGE_ROWS = 200;
const pages = new Map();   // table/day -> {page, n}: the page new rows go to and how many it has
function nextPage(p) {     // aa → ab … az → ba … zz (676 pages, 135,000 rows a day)
  const i = Math.min(675, (p.charCodeAt(0) - 97) * 26 + (p.charCodeAt(1) - 97) + 1);
  return String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26));
}
// The fullest page of the day this device knows of (rows from other phones included).
function lastPage(table, day) {
  const st = DB.prepare(`SELECT substr(id, 10, 2) AS pg, COUNT(*) AS n FROM "${table}" WHERE typeof(id) = 'text'
    AND substr(id, 1, 9) = ? AND substr(id, 10, 1) BETWEEN 'a' AND 'z' GROUP BY pg ORDER BY pg DESC LIMIT 1`);
  try { st.bind(['n' + day]); return st.step() ? st.getAsObject() : null; } finally { st.free(); }
}
function pageFor(table, day) {
  const k = table + '/' + day;
  let s = pages.get(k);
  if (!s || s.n >= PAGE_ROWS) {
    const r = lastPage(table, day);   // look again before moving on: another phone may have filled it
    s = r ? { page: r.pg, n: r.n } : { page: 'aa', n: 0 };
    if (s.n >= PAGE_ROWS) s = { page: nextPage(s.page), n: 0 };
    pages.set(k, s);
  }
  s.n++;
  return s.page;
}
let lastStamp = '', seq = 0;
export function newId(table) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const day = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
  const stamp = day + time;
  seq = stamp === lastStamp ? seq + 1 : 0;
  lastStamp = stamp;
  const page = table && TABLES[table] && TABLES[table].key === 'id' ? pageFor(table, day) : 'aa';
  const rand = Math.random().toString(36).slice(2, 4).padEnd(2, '0');
  return `n${day}${page}${time}${seq.toString(36).padStart(3, '0')}${rand}`;
}

// ---------- reading ----------
function bindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
export function all(sql, params = []) {
  const st = DB.prepare(sql);
  try {
    st.bind(params.map(bindable));
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    return out;
  } finally { st.free(); }
}
export const one = (sql, params = []) => all(sql, params)[0] || null;
export function val(sql, params = []) {
  const r = one(sql, params);
  return r ? Object.values(r)[0] : null;
}
// Anything remembered from the data (queries.js keeps a few figures) is forgotten on every write,
// so an operation always reads what it has just written.
let INVALIDATE = () => {};
export const setInvalidate = f => { INVALIDATE = f; };
export function run(sql, params = []) { INVALIDATE(); DB.run(sql, params.map(bindable)); }
export const getRow = (table, key) => one(`SELECT * FROM "${table}" WHERE "${TABLES[table].key}" = ?`, [key]);

// ---------- writing the local copy ----------
function cleanValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
// Prepared once per table: loading thousands of rows stays fast on a phone.
const STMTS = new Map();
function upsertStmt(table) {
  if (!STMTS.has(table)) {
    const cols = TABLES[table].cols.map(c => c[0]);
    STMTS.set(table, DB.prepare(`INSERT OR REPLACE INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`));
  }
  return STMTS.get(table);
}
export function upsertRow(table, key, row) {
  const t = TABLES[table];
  INVALIDATE();
  upsertStmt(table).run(t.cols.map(([c]) => (c === t.key ? key : cleanValue(row[c]))));
}
// Many changes at once go in one SQLite transaction (much faster).
let depth = 0;
export function batch(fn) {
  if (inTx) return fn();
  if (depth++ === 0) DB.run('BEGIN');
  try { return fn(); } finally { if (--depth === 0) DB.run('COMMIT'); }
}

// ---------- a user's change: all of it, or none of it ----------
// begin() … the operation runs its SQL on the local copy, reading its own writes, like the
// old app did … then commitLocal() returns every row touched (to upload), or rollback()
// puts the local copy back exactly as it was.
let inTx = false;
export function begin() {
  if (inTx) throw new Error('A change is already in progress.');
  DB.run('SAVEPOINT usertx');
  DB.run('DELETE FROM _changes');
  DB.run('UPDATE _track SET on_ = 1');
  inTx = true;
}
export function commitLocal() {
  DB.run('UPDATE _track SET on_ = 0');
  const touched = all('SELECT DISTINCT tbl, k FROM _changes');
  DB.run('DELETE FROM _changes');
  DB.run('RELEASE usertx');
  inTx = false;
  return touched.map(r => ({ table: r.tbl, key: r.k, row: getRow(r.tbl, r.k) }));
}
export function rollback() {
  if (!inTx) return;
  INVALIDATE();
  DB.run('ROLLBACK TO usertx');
  DB.run('RELEASE usertx');
  DB.run('UPDATE _track SET on_ = 0');
  DB.run('DELETE FROM _changes');
  inTx = false;
}
// Orders and purchase orders made here get their number when they are made (ref_numbers): the
// next after every number used so far, deleted ones included, as the old app's AUTOINCREMENT did.
export const NUMBERED = new Set(['orders', 'purchase_orders']);
function giveNumber(table, id) {
  const st = DB.prepare(`SELECT MAX(n) FROM (SELECT MAX(id) AS n FROM "${table}" WHERE typeof(id) = 'integer'
                         UNION ALL SELECT MAX(number) FROM ref_numbers WHERE tbl = ?)`);
  let top = 0;
  try { st.bind([table]); if (st.step()) top = st.get()[0] || 0; } finally { st.free(); }
  DB.run(`INSERT INTO ref_numbers (id, tbl, number) VALUES (?, ?, ?)`, [id, table, top + 1]);
}
// Inserts a row with a new id (unless one is given) and the table's defaults; returns the id.
export function ins(table, obj) {
  const t = TABLES[table];
  const row = { ...obj };
  const fresh = t.key === 'id' && (row.id === undefined || row.id === null);
  if (fresh) row.id = newId(table);
  const cols = Object.keys(row).filter(c => row[c] !== undefined);
  INVALIDATE();
  DB.run(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => cleanValue(row[c])));
  if (fresh && NUMBERED.has(table)) giveNumber(table, row.id);
  return row[t.key];
}
export function deleteRow(table, key) {
  INVALIDATE();
  DB.run(`DELETE FROM "${table}" WHERE "${TABLES[table].key}" = ?`, [key]);
}
function bucketWhere(table, bucket) {
  const k = `"${TABLES[table].key}"`;
  if (bucket === 'all') return ['1=1', []];
  if (bucket[0] === 'i') return [`typeof(${k}) = 'integer' AND ${k} / 200 = ?`, [Number(bucket.slice(1))]];
  if (bucket[0] === 'n' && bucket.length === 11) return [`typeof(${k}) = 'text' AND substr(${k}, 1, 11) = ?`, [bucket]];
  if (bucket[0] === 'n') return [`typeof(${k}) = 'text' AND substr(${k}, 1, 9) = ? AND substr(${k}, 10, 1) BETWEEN '0' AND '9'`, [bucket]];
  return [`typeof(${k}) = 'text' AND substr(${k}, 1, 1) != 'n' AND ${k} NOT GLOB '[0-9]*'`, []];
}
// Makes the local rows of one bucket exactly what its Firestore document holds.
export function replaceBucket(table, bucket, rows) {
  const [w, p] = bucketWhere(table, bucket);
  INVALIDATE();
  pages.clear();
  DB.run(`DELETE FROM "${table}" WHERE ${w}`, p);
  for (const [k, row] of Object.entries(rows || {})) {
    if (!row || row.deleted) continue;
    upsertRow(table, keyFromDoc(table, k), row);
  }
}
export function clearAll() {
  INVALIDATE();
  pages.clear();
  for (const name of Object.keys(TABLES)) DB.run(`DELETE FROM "${name}"`);
}

// Fills defaults the way the old database did (status 'open', created_at = now…).
export function nowStamp(kind = 'datetime') {
  const iso = new Date().toISOString();
  return kind === 'date' ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}
export function withDefaults(table, row) {
  const out = {};
  for (const [c, , d] of TABLES[table].cols) {
    if (row[c] !== undefined) out[c] = row[c];
    else if (d && typeof d === 'object' && d.now) out[c] = nowStamp(d.now);
    else out[c] = d === undefined ? null : d;
  }
  return out;
}

// The whole local copy as an SQLite file (tests; closes prepared statements).
export function exportBytes() { STMTS.clear(); return DB.export(); }

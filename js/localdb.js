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
// Runs fn with queries pointed at another database, then switches back.
export function withDb(other, fn) {
  const keep = DB;
  DB = other;
  try { return fn(); } finally { DB = keep; }
}

export async function openLocal(initSqlJs, wasmUrl) {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  SQLMOD = SQL;
  DB = new SQL.Database();
  for (const [name, t] of Object.entries(TABLES)) {
    const cols = t.cols.map(([c, typ]) => `"${c}"${typ ? ' ' + typ : ''}${c === t.key ? ' PRIMARY KEY' : ''}`);
    DB.run(`CREATE TABLE "${name}" (${cols.join(', ')})`);
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
// Records imported from the old app keep their number ids (123). Records made in this app
// get text ids that sort after them and by time: n + YYYYMMDDHHMMSSmmm + 3 random letters.
// Firestore stores rows in "bucket" documents of up to 200 rows, which keeps the number of
// documents (and so the free daily quota) small.
export function keyFromDoc(table, k) {
  return TABLES[table].key === 'id' && /^\d+$/.test(k) ? Number(k) : k;
}
export function bucketOf(table, key) {
  if (TABLES[table].key !== 'id') return 'all';
  if (typeof key === 'number') return 'i' + Math.floor(key / 200);
  const s = String(key);
  if (/^\d+$/.test(s)) return 'i' + Math.floor(Number(s) / 200);
  if (/^n\d{8}/.test(s)) return s.slice(0, 9);
  return 'x';
}
let lastStamp = '', seq = 0;
export function newId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
  seq = stamp === lastStamp ? seq + 1 : 0;
  lastStamp = stamp;
  const rand = Math.random().toString(36).slice(2, 4).padEnd(2, '0');
  return `n${stamp}${seq.toString(36)}${rand}`;
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
export function run(sql, params = []) { DB.run(sql, params.map(bindable)); }
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
  upsertStmt(table).run(t.cols.map(([c]) => (c === t.key ? key : cleanValue(row[c]))));
}
// Many changes at once go in one SQLite transaction (much faster).
let depth = 0;
export function batch(fn) {
  if (depth++ === 0) DB.run('BEGIN');
  try { return fn(); } finally { if (--depth === 0) DB.run('COMMIT'); }
}
export function deleteRow(table, key) {
  DB.run(`DELETE FROM "${table}" WHERE "${TABLES[table].key}" = ?`, [key]);
}
function bucketWhere(table, bucket) {
  const k = `"${TABLES[table].key}"`;
  if (bucket === 'all') return ['1=1', []];
  if (bucket[0] === 'i') return [`typeof(${k}) = 'integer' AND ${k} / 200 = ?`, [Number(bucket.slice(1))]];
  if (bucket[0] === 'n') return [`typeof(${k}) = 'text' AND substr(${k}, 1, 9) = ?`, [bucket]];
  return [`typeof(${k}) = 'text' AND substr(${k}, 1, 1) != 'n' AND ${k} NOT GLOB '[0-9]*'`, []];
}
// Makes the local rows of one bucket exactly what its Firestore document holds.
export function replaceBucket(table, bucket, rows) {
  const [w, p] = bucketWhere(table, bucket);
  DB.run(`DELETE FROM "${table}" WHERE ${w}`, p);
  for (const [k, row] of Object.entries(rows || {})) {
    if (!row || row.deleted) continue;
    upsertRow(table, keyFromDoc(table, k), row);
  }
}
export function clearAll() {
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

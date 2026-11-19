// Firestore sync. Every table is a Firestore collection; its rows live in "bucket"
// documents ({rows: {id: row}, updatedAt}). On start the app reads this device's copy
// (free, instant, works offline), then asks the server only for buckets changed since
// the last visit. Changes are written to the local copy at once and uploaded in the
// background — Firestore queues them while offline and sends them when the connection
// returns, even if the app was closed in between.
import * as F from './fb.js';
import { TABLES } from './schema.js';
import * as L from './localdb.js';

const NAMES = Object.keys(TABLES);
const S = { fs: null, maxTs: {}, live: {}, started: false, onChange: () => {}, onError: () => {}, pending: 0 };

export const status = () => ({ live: NAMES.every(n => S.live[n]), pending: S.pending > 0 });

export function init(fs, { onChange, onError }) {
  S.fs = fs;
  S.onChange = onChange || S.onChange;
  S.onError = onError || S.onError;
}

const tsMs = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : 0);
function takeDoc(name, d) {
  const data = d.data({ serverTimestamps: 'estimate' }) || {};
  L.replaceBucket(name, d.id, data.rows || {});
  S.maxTs[name] = Math.max(S.maxTs[name] || 0, tsMs(data.updatedAt));
}

let changeTimer = 0;
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => S.onChange(), 30);
}

export async function start() {
  if (S.started) return;
  S.started = true;
  // 1. This device's copy: instant and free.
  const snaps = await Promise.all(NAMES.map(async name => {
    try { return [name, await F.getDocsFromCache(F.collection(S.fs, name))]; } catch { return [name, null]; }
  }));
  L.batch(() => { for (const [name, snap] of snaps) if (snap) snap.forEach(d => takeDoc(name, d)); });
  S.onChange();
  // 2. Only what changed on the server since (stays inside the free daily quota).
  for (const name of NAMES) listen(name);
}

function listen(name) {
  const m = S.maxTs[name] || 0;
  const cutoff = F.Timestamp.fromMillis(m ? Math.max(0, m - 15 * 60 * 1000) : 0);
  F.onSnapshot(F.query(F.collection(S.fs, name), F.where('updatedAt', '>=', cutoff)), { includeMetadataChanges: true }, snap => {
    const changes = snap.docChanges();
    if (changes.length) L.batch(() => applyChanges(name, changes));
    S.live[name] = !snap.metadata.fromCache;
    changed();
  }, err => S.onError(name, err));
}
function applyChanges(name, changes) {
  for (const ch of changes) {
    if (ch.type === 'removed') {
      // A bucket with an edit still waiting to upload drops out of this query locally: keep this device's copy.
      F.getDocFromCache(ch.doc.ref).then(d => { if (d.exists()) takeDoc(name, d); changed(); }).catch(() => {});
    } else takeDoc(name, ch.doc);
  }
}

// ---------- writing ----------
// const t = tx(); t.insert('orders', {...}); t.update('boxes', 12, {status: 'sold'}); await t.commit();
// The local copy changes immediately; the upload happens in the background.
class Tx {
  constructor() { this.ops = []; }
  insert(table, row) {
    const key = row[TABLES[table].key] ?? L.newId();
    const full = L.withDefaults(table, { ...row, [TABLES[table].key]: key });
    this.ops.push({ table, key, type: 'set', fields: full });
    return key;
  }
  update(table, key, fields) {
    this.ops.push({ table, key, type: 'merge', fields });
    return key;
  }
  remove(table, key) {
    this.ops.push({ table, key, type: 'remove' });
  }
  applyLocal() {
    L.batch(() => this.applyOps());
  }
  applyOps() {
    for (const op of this.ops) {
      if (op.type === 'remove') L.deleteRow(op.table, op.key);
      else if (op.type === 'set') L.upsertRow(op.table, op.key, op.fields);
      else {
        const cur = L.getRow(op.table, op.key);
        if (cur) L.upsertRow(op.table, op.key, { ...cur, ...op.fields });
      }
    }
  }
  async commit() {
    if (!this.ops.length) return true;
    this.applyLocal();
    changed();
    // One Firestore write per bucket touched, so a sale of 40 boxes is a handful of writes.
    const groups = new Map();
    for (const op of this.ops) {
      const t = TABLES[op.table];
      const bucket = L.bucketOf(op.table, op.key);
      const gk = op.table + '/' + bucket;
      if (!groups.has(gk)) groups.set(gk, { table: op.table, bucket, rows: {} });
      const rows = groups.get(gk).rows;
      const k = String(op.key);
      if (op.type === 'remove') rows[k] = F.deleteField();
      else {
        const f = {};
        for (const [c, v] of Object.entries(op.fields)) if (c !== t.key) f[c] = v === undefined ? null : v;
        if (op.type === 'set' || !rows[k] || typeof rows[k] !== 'object') rows[k] = f;
        else Object.assign(rows[k], f);
      }
    }
    const list = [...groups.values()];
    const commits = [];
    for (let i = 0; i < list.length; i += 450) {
      const chunk = list.slice(i, i + 450);
      const b = F.writeBatch(S.fs);
      for (const g of chunk) b.set(F.doc(S.fs, g.table, g.bucket), { rows: g.rows, updatedAt: F.serverTimestamp() }, { merge: true });
      S.pending++;
      commits.push(b.commit().finally(() => { S.pending--; changed(); }));
    }
    try {
      // Offline, commit() waits until the upload happens: don't hold the screen for it.
      await Promise.race([Promise.all(commits), new Promise(r => setTimeout(r, 1500))]);
      Promise.all(commits).catch(e => this.fail(list, e));
      return true;
    } catch (e) {
      await this.fail(list, e);
      return false;
    }
  }
  async fail(list, e) {
    // Put back what the server and this device really hold.
    for (const g of list) {
      try {
        const d = await F.getDocFromCache(F.doc(S.fs, g.table, g.bucket));
        L.replaceBucket(g.table, g.bucket, d.exists() ? (d.data().rows || {}) : {});
      } catch { L.replaceBucket(g.table, g.bucket, {}); }
    }
    changed();
    S.onError('write', e);
  }
}
export const tx = () => new Tx();

// ---------- whole-collection operations, used by the importer ----------
export async function serverBuckets(name) {
  const snap = await F.getDocsFromServer(F.collection(S.fs, name));
  const out = {};
  snap.forEach(d => { out[d.id] = (d.data() || {}).rows || {}; });
  return out;
}
// Writes full bucket documents (replacing what was there), in batches.
export async function writeBuckets(items, onProgress) {
  let done = 0;
  for (let i = 0; i < items.length; i += 200) {
    const b = F.writeBatch(S.fs);
    for (const it of items.slice(i, i + 200)) {
      b.set(F.doc(S.fs, it.coll, it.id), { ...it.data, updatedAt: F.serverTimestamp() });
    }
    await b.commit();
    done = Math.min(items.length, i + 200);
    if (onProgress) onProgress(done, items.length);
  }
}

// ---------- photos and documents ----------
// Kept in their own collections (one document each), fetched only when shown.
const imgCache = new Map();
export async function getBlob(coll, id) {
  if (!id) return null;
  const k = coll + '/' + id;
  if (imgCache.has(k)) return imgCache.get(k);
  let d = null;
  try { d = await F.getDocFromCache(F.doc(S.fs, coll, id)); } catch { d = null; }
  if (!d || !d.exists()) {
    try { d = await F.getDoc(F.doc(S.fs, coll, id)); } catch { d = null; }
  }
  const v = d && d.exists() ? d.data() : null;
  if (v) imgCache.set(k, v);
  return v;
}
export function blobDoc(coll, id, data) {
  return { coll, id, data };
}

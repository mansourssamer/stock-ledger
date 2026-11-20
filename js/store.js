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
// Firestore takes at most 500 writes and 10 MiB in one commit: split a long list into commits
// of at most 400 documents and about 4 MB (one operation almost always fits in one, so it
// lands all at once).
const PART_DOCS = 400, PART_BYTES = 4 * 1024 * 1024;
function commitParts(items, dataOf) {
  const parts = [];
  let cur = [], bytes = 0;
  for (const it of items) {
    const n = JSON.stringify(dataOf(it)).length + 200;
    if (cur.length && (cur.length >= PART_DOCS || bytes + n > PART_BYTES)) { parts.push(cur); cur = []; bytes = 0; }
    cur.push(it); bytes += n;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

// await change(() => { ...SQL on the local copy, as the old app did... })
// The operation runs synchronously on the device copy and either completes or leaves no
// trace (an error thrown inside undoes it). Every row it touched is then uploaded in the
// background, one Firestore write per bucket — Firestore queues them while offline.
export async function change(fn) {
  L.begin();
  let result, touched;
  try {
    result = fn();
    touched = L.commitLocal();
  } catch (e) {
    L.rollback();
    throw e;
  }
  changed();
  if (S.fs && touched.length) await upload(touched);
  return result;
}

async function upload(touched) {
  const groups = new Map();
  for (const { table, key, row } of touched) {
    const t = TABLES[table];
    const bucket = L.bucketOf(table, key);
    const gk = table + '/' + bucket;
    if (!groups.has(gk)) groups.set(gk, { table, bucket, rows: {} });
    if (!row) groups.get(gk).rows[String(key)] = F.deleteField();
    else {
      const f = {};
      for (const [c] of t.cols) if (c !== t.key) f[c] = row[c] === undefined ? null : row[c];
      groups.get(gk).rows[String(key)] = f;
    }
  }
  const list = [...groups.values()];
  const commits = [];
  for (const part of commitParts(list, g => g.rows)) {
    const b = F.writeBatch(S.fs);
    for (const g of part) b.set(F.doc(S.fs, g.table, g.bucket), { rows: g.rows, updatedAt: F.serverTimestamp() }, { merge: true });
    S.pending++;
    commits.push(b.commit().finally(() => { S.pending--; changed(); }));
  }
  // Offline, commit() only finishes once the upload happens: don't hold the screen for it.
  const all = Promise.all(commits);
  all.catch(e => fail(list, e));
  await Promise.race([all.catch(() => {}), new Promise(r => setTimeout(r, 1200))]);
}

async function fail(list, e) {
  // Put back what the server and this device really hold.
  for (const g of list) {
    try {
      const d = await F.getDocFromCache(F.doc(S.fs, g.table, g.bucket));
      L.batch(() => L.replaceBucket(g.table, g.bucket, d.exists() ? (d.data().rows || {}) : {}));
    } catch { /* keep what we have */ }
  }
  changed();
  S.onError('write', e);
}

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
  for (const part of commitParts(items, it => it.data)) {
    const b = F.writeBatch(S.fs);
    for (const it of part) b.set(F.doc(S.fs, it.coll, it.id), { ...it.data, updatedAt: F.serverTimestamp() });
    await b.commit();
    done += part.length;
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
// Saves one photo or document (its own document; uploads in the background when offline).
export async function putBlob(coll, id, data) {
  imgCache.set(coll + '/' + id, data);
  if (!S.fs) return;
  const b = F.writeBatch(S.fs);
  b.set(F.doc(S.fs, coll, id), { ...data, updatedAt: F.serverTimestamp() });
  S.pending++;
  const p = b.commit().finally(() => { S.pending--; changed(); });
  p.catch(e => S.onError('write', e));
  await Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, 1200))]);
}

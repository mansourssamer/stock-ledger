// A small in-browser stand-in for Firebase, used only by the tests (served in place of
// js/fb.js). It keeps one "server" copy in localStorage so a reload keeps the data, and
// can simulate being offline: writes then wait in a queue that reads already see.
const KEY = 'fakefs-v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
let SERVER = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(SERVER));
const QUEUE = [];
const listeners = [];
window.__fake = {
  get offline() { return !!window.__fakeOffline; },
  setOffline(v) { window.__fakeOffline = !!v; if (!v) flush(); },
  server: () => SERVER,
  reset() { SERVER = {}; save(); },
  writes: 0
};

export class Timestamp {
  constructor(ms) { this.ms = ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
  static now() { return new Timestamp(Date.now()); }
  toMillis() { return this.ms; }
}
const SENT = { ts: '__serverTimestamp__', del: '__deleteField__' };
export const serverTimestamp = () => SENT.ts;
export const deleteField = () => SENT.del;

function revive(o) {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    if (typeof o.__ts === 'number') return new Timestamp(o.__ts);
    const r = {};
    for (const [k, v] of Object.entries(o)) r[k] = revive(v);
    return r;
  }
  return o;
}
function resolve(v, now) {
  if (v === SENT.ts) return { __ts: now };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const r = {};
    for (const [k, x] of Object.entries(v)) r[k] = resolve(x, now);
    return r;
  }
  return v;
}
function deepMerge(a, b) {
  const o = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v === SENT.del) delete o[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && !('__ts' in v) && o[k] && typeof o[k] === 'object') o[k] = deepMerge(o[k], v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && !('__ts' in v)) o[k] = deepMerge({}, v);
    else o[k] = v;
  }
  return o;
}
function strip(o) {
  if (o && typeof o === 'object' && !Array.isArray(o) && !('__ts' in o)) {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (v !== SENT.del) r[k] = strip(v);
    return r;
  }
  return o;
}

// ---------- app & auth ----------
export const initializeApp = cfg => ({ cfg });
const AUTH = { currentUser: null, cbs: [] };
export const getAuth = () => AUTH;
export function onAuthStateChanged(a, cb) {
  AUTH.cbs.push(cb);
  const u = window.__fakeUser === undefined ? { uid: 'u1', email: 'owner@example.com', emailVerified: true, displayName: 'Owner' } : window.__fakeUser;
  AUTH.currentUser = u;
  setTimeout(() => cb(u), 0);
  return () => {};
}
export class GoogleAuthProvider {}
export async function signInWithPopup() { return { user: AUTH.currentUser }; }
export const signInWithRedirect = signInWithPopup;
export async function getRedirectResult() { return null; }
export async function signInWithEmailAndPassword() { return { user: AUTH.currentUser }; }
export async function createUserWithEmailAndPassword() { return { user: AUTH.currentUser }; }
export async function sendEmailVerification() {}
export async function sendPasswordResetEmail() {}
export async function signOut() { AUTH.currentUser = null; AUTH.cbs.forEach(cb => cb(null)); }

// ---------- firestore ----------
export const persistentLocalCache = o => o;
export const persistentMultipleTabManager = () => ({});
export const initializeFirestore = () => ({ fake: true });
export const terminate = async () => {};
export const clearIndexedDbPersistence = async () => {};
export const collection = (fs, name) => ({ kind: 'col', name });
export const doc = (fs, name, id) => ({ kind: 'doc', name, id, path: name + '/' + id });
export const where = (field, op, value) => ({ field, op, value });
export const query = (col, ...conds) => ({ kind: 'query', name: col.name, conds });

// What this device sees: the server plus writes still queued.
function view() {
  let v = SERVER;
  if (QUEUE.length) {
    v = JSON.parse(JSON.stringify(SERVER));
    for (const w of QUEUE) apply(v, w, Date.now());
  }
  return v;
}
function apply(store, w, now) {
  for (const s of w.sets) {
    const col = store[s.name] || (store[s.name] = {});
    const data = resolve(s.data, now);
    col[s.id] = s.merge ? deepMerge(col[s.id], data) : strip(data);
  }
}
function snapDoc(name, id, data, fromCache) {
  return {
    id, ref: doc(null, name, id),
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : revive(JSON.parse(JSON.stringify(data)))),
    metadata: { fromCache }
  };
}
function matches(data, conds) {
  for (const c of conds || []) {
    const v = data[c.field];
    const ms = v && typeof v.__ts === 'number' ? v.__ts : null;
    if (c.op === '>=' && !(ms !== null && ms >= c.value.toMillis())) return false;
  }
  return true;
}
export async function getDocsFromCache(col) {
  const v = view()[col.name] || {};
  const docs = Object.entries(v).map(([id, d]) => snapDoc(col.name, id, d, true));
  return { forEach: f => docs.forEach(f), docs, size: docs.length };
}
export const getDocsFromServer = async col => {
  if (window.__fakeOffline) throw Object.assign(new Error('offline'), { code: 'unavailable' });
  const v = SERVER[col.name] || {};
  const docs = Object.entries(v).map(([id, d]) => snapDoc(col.name, id, d, false));
  return { forEach: f => docs.forEach(f), docs, size: docs.length };
};
export const getDocs = getDocsFromServer;
export async function getDocFromCache(ref) { return snapDoc(ref.name, ref.id, (view()[ref.name] || {})[ref.id], true); }
export async function getDocFromServer(ref) { return snapDoc(ref.name, ref.id, (SERVER[ref.name] || {})[ref.id], false); }
export async function getDoc(ref) { return window.__fakeOffline ? getDocFromCache(ref) : getDocFromServer(ref); }

export function onSnapshot(q, opts, next, err) {
  if (typeof opts === 'function') { err = next; next = opts; }
  const l = { q, next, seen: {} };
  listeners.push(l);
  setTimeout(() => notify(l, true), 0);
  return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
}
function notify(l, first) {
  const v = view()[l.q.name] || {};
  const changes = [];
  for (const [id, d] of Object.entries(v)) {
    if (!matches(d, l.q.conds)) continue;
    const s = JSON.stringify(d);
    if (l.seen[id] !== s) { changes.push({ type: l.seen[id] ? 'modified' : 'added', doc: snapDoc(l.q.name, id, d, !!window.__fakeOffline) }); l.seen[id] = s; }
  }
  if (changes.length || first) l.next({ docChanges: () => changes, metadata: { fromCache: !!window.__fakeOffline } });
}
function notifyAll() { for (const l of listeners) notify(l, false); }
function flush() {
  while (QUEUE.length) {
    const w = QUEUE.shift();
    apply(SERVER, w, Date.now());
    w.resolve();
  }
  save();
  notifyAll();
}
export function writeBatch() {
  const sets = [];
  return {
    set(ref, data, o) { sets.push({ name: ref.name, id: ref.id, data, merge: !!(o && o.merge) }); },
    commit() {
      window.__fake.writes += sets.length;
      return new Promise(res => {
        QUEUE.push({ sets, resolve: res });
        if (!window.__fakeOffline) flush(); else notifyAll();
      });
    }
  };
}
export async function waitForPendingWrites() {
  while (QUEUE.length) await new Promise(r => setTimeout(r, 50));
}

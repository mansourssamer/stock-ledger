// A small in-browser stand-in for Firebase, used only by the tests (served in place of
// js/fb.js). It keeps one "server" copy in localStorage so a reload keeps the data, and
// can simulate being offline: writes then wait in a queue that reads already see.
const KEY = 'fakefs-v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
let SERVER = load();
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(SERVER)); window.__fakeSaveFailed = false; }
  catch (e) { window.__fakeSaveFailed = true; console.warn('fake Firebase: the test copy is too big for localStorage, so a reload would lose it'); }
};
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
// Tests can set window.__fakeUser before the app starts (null = signed out; emailVerified false
// = a password account whose email isn't confirmed), window.__fakePopupError to make the Google
// popup fail with that code, and call window.__fake.confirmEmail() as if the link was opened.
function makeUser(u) {
  if (!u) return null;
  const user = { uid: 'u1', displayName: 'Owner', providerData: [{ providerId: 'google.com' }], ...u };
  user.reload = async () => { if (window.__fake.emailConfirmed) user.emailVerified = true; };
  user.getIdToken = async () => 'token';
  return user;
}
function setUser(u) {
  AUTH.currentUser = u;
  try { if (u) localStorage.removeItem('fakeauth-out'); else localStorage.setItem('fakeauth-out', '1'); } catch { /* */ }
  AUTH.cbs.forEach(cb => cb(u));
}
export function onAuthStateChanged(a, cb) {
  AUTH.cbs.push(cb);
  let out = false; try { out = localStorage.getItem('fakeauth-out') === '1'; } catch { /* */ }
  const u = makeUser(window.__fakeUser === undefined ? (out ? null : { email: 'owner@example.com', emailVerified: true }) : window.__fakeUser);
  AUTH.currentUser = u;
  setTimeout(() => cb(u), 0);
  return () => {};
}
export class GoogleAuthProvider {}
export async function signInWithPopup() {
  if (window.__fakePopupError) throw Object.assign(new Error('popup'), { code: window.__fakePopupError });
  setUser(makeUser({ email: 'owner@example.com', emailVerified: true }));
  return { user: AUTH.currentUser };
}
export const signInWithRedirect = signInWithPopup;
export const reauthenticateWithPopup = signInWithPopup;
export async function getRedirectResult() { return null; }
export async function signInWithEmailAndPassword(a, email, pw) {
  const acct = (window.__fake.passwords || {})[email];
  if (!acct || acct.pw !== pw) throw Object.assign(new Error('bad'), { code: 'auth/invalid-credential' });
  setUser(makeUser({ email, emailVerified: acct.verified, providerData: acct.providers.map(providerId => ({ providerId })) }));
  return { user: AUTH.currentUser };
}
export async function createUserWithEmailAndPassword() { return { user: AUTH.currentUser }; }
export async function sendEmailVerification() { window.__fake.verificationsSent = (window.__fake.verificationsSent || 0) + 1; }
export async function sendPasswordResetEmail(a, email) { (window.__fake.resetsSent = window.__fake.resetsSent || []).push(email); }
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
export async function linkWithCredential(user, cred) {
  if (user.providerData.some(p => p.providerId === 'password')) throw Object.assign(new Error('linked'), { code: 'auth/provider-already-linked' });
  user.providerData = [...user.providerData, { providerId: 'password' }];
  (window.__fake.passwords = window.__fake.passwords || {})[cred.email] = { pw: cred.password, verified: user.emailVerified, providers: user.providerData.map(p => p.providerId) };
  persistAuth();
}
export async function updatePassword(user, pw) { window.__fake.passwords[user.email].pw = pw; persistAuth(); }
function persistAuth() { try { localStorage.setItem('fakeauth-v1', JSON.stringify(window.__fake.passwords || {})); } catch { /* full */ } }
try { window.__fake.passwords = JSON.parse(localStorage.getItem('fakeauth-v1') || '{}'); } catch { /* none */ }
window.__fake.confirmEmail = () => { window.__fake.emailConfirmed = true; };
export async function signOut() { setUser(null); }

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
// Firestore's limits, which the real server enforces on every commit: at most 1 MiB per
// document and 40,000 index entries per document (every value inside a map gets an ascending
// and a descending entry, and so does each map as a whole); at most 500 writes and 10 MiB per
// commit. Sizes follow Firestore's storage-size rules.
const enc = new TextEncoder();
const strSize = v => enc.encode(String(v)).length + 1;
function valSize(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'string') return strSize(v);
  if (typeof v.__ts === 'number') return 8;
  return mapSize(v);
}
const mapSize = m => 32 + Object.entries(m).reduce((a, [k, v]) => a + strSize(k) + valSize(v), 0);
const indexEntries = m => Object.values(m).reduce((a, v) => a + 2 + (v && typeof v === 'object' && typeof v.__ts !== 'number' ? indexEntries(v) : 0), 0);
function limitProblem(w, store) {
  if (w.sets.length > 500) return `${w.sets.length} writes in one commit (limit 500)`;
  const req = enc.encode(JSON.stringify(w.sets)).length;
  if (req > 10 * 1024 * 1024) return `commit of ${req} bytes (limit 10 MiB)`;
  const trial = {};
  for (const st of w.sets) trial[st.name] = { ...(store[st.name] || {}) };
  apply(trial, w, Date.now());
  for (const st of w.sets) {
    const d = trial[st.name][st.id];
    const size = strSize(st.name) + strSize(st.id) + 16 + mapSize(d);
    if (size > 1048576) return `${st.name}/${st.id} would be ${size} bytes (limit 1 MiB)`;
    const ix = indexEntries(d);
    if (ix > 40000) return `${st.name}/${st.id} would have ${ix} index entries (limit 40,000)`;
    window.__fake.largest = Math.max(window.__fake.largest || 0, size);
    window.__fake.mostEntries = Math.max(window.__fake.mostEntries || 0, ix);
  }
  return '';
}
function flush() {
  while (QUEUE.length) {
    const w = QUEUE.shift();
    const bad = limitProblem(w, SERVER);
    if (bad) {
      console.error('Firestore would refuse this write: ' + bad);
      window.__fake.refused = (window.__fake.refused || 0) + 1;
      w.reject(Object.assign(new Error('INVALID_ARGUMENT: ' + bad), { code: 'invalid-argument' }));
      continue;
    }
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
      return new Promise((res, rej) => {
        QUEUE.push({ sets, resolve: res, reject: rej });
        if (!window.__fakeOffline) flush(); else notifyAll();
      });
    }
  };
}
export async function waitForPendingWrites() {
  while (QUEUE.length) await new Promise(r => setTimeout(r, 50));
}

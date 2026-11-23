// Stock & Ledger — shoe wholesale: stock by the box, sales, customers, purchasing and accounts.
// One page that loads once and works on the phone itself; data lives in the business's own
// Firebase project and keeps working offline.
'use strict';
import * as F from './fb.js';
import { firebaseConfig } from '../config.js';
import * as L from './localdb.js';
import * as store from './store.js';
import { t, lang, setLang } from './i18n.js';
import { $, esc, CUR } from './util.js';
import { SCREENS } from './screens.js';
import { clearMemo } from './queries.js';
import { ACTIONS, registerActions } from './actions.js';

// ---------- icons ----------
const ICONS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8 11h8M8 14h5"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  truck: '<path d="M2 6h12v10H2z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  shoe: '<path d="M3 16h17a1 1 0 0 0 1-1v-.5a3 3 0 0 0-2.4-2.9L14 10.5 11 6H7L5.5 9.5 3 10z"/><path d="M3 19h18"/>',
  wallet: '<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l12-4v4"/><circle cx="16.5" cy="13.5" r="1.3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v3M11 10v8M15 12v6M19 6v12"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 6l-6 6 6 6"/>'
};
export const ic = n => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

// ---------- state ----------
export const S = { auth: 'loading', user: null, email: '', fs: null, authObj: null, ready: false, online: navigator.onLine, err: '' };
export const UI = { menuOpen: false, gate: { email: '', password: '', err: '', note: '', busy: false } };

// ---------- navigation ----------
// Groups shown in the side menu; each item: [route, label, icon]. Not-yet-rebuilt parts
// show a short note pointing back to the current app.
const NAV = () => [
  { group: t('Daily'), items: [['home', t('Home'), 'home'], ['orders', t('Sales'), 'receipt'], ['customers', t('Customers'), 'users'], ['crm', t('CRM'), 'chat']] },
  { group: t('Goods'), items: [['stock', t('Stock'), 'shoe'], ['boxes', t('Inventory'), 'box'], ['purchasing', t('Purchasing'), 'truck']] },
  { group: t('Money'), items: [['invoices', t('Invoices'), 'receipt'], ['money', t('Money'), 'wallet'], ['reports', t('Reports'), 'chart']] },
  { group: t('More'), items: [['settings', t('Settings'), 'sliders'], ['import', t('Import data'), 'upload']] }
];
const TABS = () => [['home', t('Home'), 'home'], ['orders', t('Sales'), 'receipt'], ['stock', t('Stock'), 'shoe'], ['customers', t('Customers'), 'users'], ['more', t('More'), 'dots']];

export function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/').map(decodeURIComponent);
  return { name: parts[0] || 'home', args: parts.slice(1) };
}
export const go = path => { location.hash = '#/' + path; };
const BUY = ['po', 'supplier', 'suppliers', 'shipment', 'shipments', 'location', 'locations', 'unplaced', 'sizeruns', 'pricelist', 'buying', 'events', 'missed'];
const CRM = ['crmcontacts', 'crmcontact', 'crmcustomers', 'announce', 'crmreport', 'zones', 'proformas'];
const MONEY = ['account', 'expenses', 'partners', 'partner', 'currencies'], REPORTS = ['pnl', 'cashflow', 'costing', 'balance', 'daily', 'sales', 'monthly'];
const sectionOf = name => (CRM.includes(name) ? 'crm' : BUY.includes(name) ? 'purchasing' : MONEY.includes(name) ? 'money' : REPORTS.includes(name) ? 'reports' : { order: 'orders', customer: 'customers', product: 'stock', mix: 'boxes', box: 'boxes', invoice: 'invoices' }[name] || name);

// ---------- rendering ----------
let renderQueued = false;
export function schedule() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function syncLine() {
  if (!S.ready) return ['', t('Connecting…')];
  const st = store.status();
  if (!S.online) return ['warn', st.pending ? t('Offline · changes saved on this device') : t('Offline · working from this device')];
  if (st.pending) return ['warn', t('Uploading changes…')];
  return [st.live ? 'live' : '', st.live ? t('Online · all changes saved') : t('Connecting…')];
}

function shell(content) {
  const r = route();
  const cur = sectionOf(r.name);
  const [cls, txt] = syncLine();
  const nav = NAV().map(g => `<div class="navgroup"><div class="navlabel">${esc(g.group)}</div>${g.items.map(([k, label, icon]) =>
    `<a class="navlink" href="#/${k}"${cur === k ? ' aria-current="page"' : ''}>${ic(icon)}<span>${esc(label)}</span></a>`).join('')}</div>`).join('');
  const langBtn = `<button type="button" class="navlink" data-act="lang">${ic('globe')}<span>${lang() === 'fr' ? 'English' : 'Français'}</span></button>`;
  const foot = `<div class="rail-foot"><div class="sync"><span class="dot ${cls}"></span><span>${esc(txt)}</span></div>${langBtn}
    <button type="button" class="navlink" data-act="signOut">${ic('logout')}<span>${esc(t('Sign out'))}</span></button>
    <div class="sub" style="padding:2px 10px">${esc(S.email)}</div></div>`;
  const brand = `<a class="brand" href="#/home"><span class="brand-mark">S&amp;L</span><span><span class="brand-name">Stock &amp; Ledger</span><br><span class="brand-sub">${esc(t('Shoes by the box'))}</span></span></a>`;
  const tabs = TABS().map(([k, label, icon]) => k === 'more'
    ? `<button type="button" class="tab" data-act="menu"${UI.menuOpen ? ' aria-current="page"' : ''}>${ic(icon)}<span>${esc(label)}</span></button>`
    : `<a class="tab" href="#/${k}"${cur === k && !UI.menuOpen ? ' aria-current="page"' : ''}>${ic(icon)}<span>${esc(label)}</span></a>`).join('');
  const sheet = UI.menuOpen ? `<div class="scrim" data-act="menu"></div><div class="sheet" role="dialog" aria-label="${esc(t('Menu'))}">
      <div class="sheet-h"><strong>${esc(t('Menu'))}</strong><button type="button" class="btn ghost iconbtn" data-act="menu" aria-label="${esc(t('Close'))}">${ic('x')}</button></div>
      ${nav}${foot}</div>` : '';
  return `<div class="app"><aside class="rail">${brand}${nav}${foot}</aside>
    <main class="main"><div class="wrap"><div class="mtop">${brand}<span class="dot ${cls}" title="${esc(txt)}"></span></div>${content}</div></main>
    <nav class="tabbar">${tabs}</nav>${sheet}</div>`;
}

function render() {
  const root = $('#root');
  if (S.auth !== 'ready') { root.innerHTML = gate(); return; }
  const r = route();
  const scr = SCREENS[r.name] || SCREENS.home;
  let content;
  try {
    content = S.ready ? scr.render(...r.args) : `<div class="empty"><span>${esc(t('Loading your data…'))}</span></div>`;
  } catch (e) {
    console.error(e);
    content = `<div class="panel"><div class="panel-b"><p class="errline">${esc(e.message || String(e))}</p></div></div>`;
  }
  keepFocus(root, () => { root.innerHTML = shell(content); });
  if (scr.mount && S.ready) scr.mount(...r.args);
  if (S.ready && !window.__firstPaint) { window.__firstPaint = 1; mark('painted'); }
}

// Re-rendering replaces the page; put the cursor back where it was (search boxes).
function keepFocus(el, fn) {
  const a = document.activeElement;
  const id = a && a.id && el.contains(a) ? a.id : null;
  const pos = id && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  fn();
  if (id) {
    const n = document.getElementById(id);
    if (n) { n.focus(); if (pos && n.setSelectionRange) try { n.setSelectionRange(pos[0], pos[1]); } catch { /* not a text field */ } }
  }
}

// ---------- sign-in ----------
const gateBrand = () => `<div class="brand"><span class="brand-mark">S&amp;L</span><span><span class="brand-name">Stock &amp; Ledger</span><br><span class="brand-sub">${esc(t('Shoes by the box'))}</span></span></div>`;
function gate() {
  const g = UI.gate;
  let h;
  if (S.auth === 'setup') {
    h = `<h1>${esc(t('Connect the database'))}</h1><p>${esc(t('This copy of the app doesn’t have its Firebase settings yet.'))}</p>
      <p class="sub">config.js → firebaseConfig</p>`;
  } else if (S.auth === 'loading') {
    h = `<p>${esc(t('Loading your data…'))}</p>`;
  } else if (S.auth === 'verify') {
    h = `<h1>${esc(t('Confirm your email'))}</h1><p>${esc(t('{e} isn’t confirmed yet. Send yourself a link, open it from your inbox, then come back here.', { e: S.email }))}</p>
      ${g.note ? `<p class="callout good">${esc(g.note)}</p>` : ''}${g.err ? `<p class="errline">${esc(g.err)}</p>` : ''}
      <button type="button" class="btn big" data-act="verifySend"${g.busy ? ' disabled' : ''}>${esc(t('Send the link'))}</button>
      <button type="button" class="btn primary big" data-act="verifyDone"${g.busy ? ' disabled' : ''}>${esc(t('I’ve confirmed it'))}</button>
      <button type="button" class="linkbtn" data-act="signOut">${esc(t('Sign in with another account'))}</button>`;
  } else if (S.auth === 'denied') {
    h = `<h1>${esc(t('Not allowed'))}</h1><p><b>${esc(S.email)}</b> — ${esc(t('This account can’t open the data. Check that the security rules are published with your email, then try again.'))}</p>
      <button type="button" class="btn primary big" data-act="reload">${esc(t('Try again'))}</button>
      <button type="button" class="linkbtn" data-act="signOut">${esc(t('Sign in with another account'))}</button>`;
  } else {
    h = `<h1>${esc(t('Sign in'))}</h1>
      <button type="button" class="btn big gbtn" data-act="google"${g.busy ? ' disabled' : ''}>${esc(t('Continue with Google'))}</button>
      <div class="or">${esc(t('or use email'))}</div>
      <form class="stack" id="gate-form" novalidate>
        <div class="field"><label for="g-email">${esc(t('Email'))}</label><input id="g-email" class="inp" type="email" autocomplete="email" value="${esc(g.email)}"></div>
        <div class="field"><label for="g-pass">${esc(t('Password'))}</label><input id="g-pass" class="inp" type="password" autocomplete="current-password"></div>
        ${g.err ? `<p class="errline">${esc(g.err)}</p>` : ''}${g.note ? `<p class="callout good">${esc(g.note)}</p>` : ''}
        <button type="submit" class="btn primary big"${g.busy ? ' disabled' : ''}>${esc(g.busy ? t('Please wait…') : t('Sign in'))}</button>
        <button type="button" class="linkbtn" data-act="forgot">${esc(t('Forgot password? / No password yet?'))}</button>
      </form>`;
  }
  return `<div class="gate"><div class="gate-card">${gateBrand()}${h}
    <button type="button" class="linkbtn" data-act="lang">${lang() === 'fr' ? 'English' : 'Français'}</button></div></div>`;
}
function authErr(e) {
  const c = e && e.code;
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found') return t('Wrong email or password.');
  if (c === 'auth/network-request-failed') return t('No internet connection. Signing in needs the internet once; after that the app works offline.');
  if (c === 'auth/unauthorized-domain') return t('This web address isn’t allowed yet. In Firebase, open Authentication → Settings → Authorized domains and add it.');
  if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'].includes(c))
    return t('Google sign-in didn’t finish. In an app added to a phone’s home screen this often happens: sign in with your email and a password instead (set one in Settings on your computer, or tap “Forgot password?”).');
  if (c === 'auth/operation-not-allowed') return t('Email sign-in isn’t switched on in Firebase yet: Authentication → Sign-in method → Email/Password → Enable.');
  if (c === 'auth/too-many-requests') return t('Too many tries. Wait a few minutes, then try again.');
  if (c === 'auth/invalid-email' || c === 'auth/missing-email') return t('Check the email address.');
  return t('Couldn’t sign in. Try again.');
}

// ---------- toast ----------
let toastTimer = 0;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, Math.min(15000, Math.max(4200, String(msg).length * 55)));   // long messages stay longer
}

// ---------- events ----------
registerActions({
  lang: () => { setLang(lang() === 'fr' ? 'en' : 'fr'); schedule(); },
  menu: () => { UI.menuOpen = !UI.menuOpen; schedule(); },
  reload: () => location.reload(),
  signOut: async () => { try { await F.signOut(S.authObj); } catch { /* already out */ } location.reload(); },
  // A link to choose a password: works for a new password and for a Google account that has none yet.
  forgot: async () => {
    const g = UI.gate;
    g.email = ($('#g-email') || {}).value ? $('#g-email').value.trim() : g.email;
    g.err = ''; g.note = '';
    if (!g.email) { g.err = t('Type your email above first.'); schedule(); return; }
    g.busy = true; schedule();
    try { await F.sendPasswordResetEmail(S.authObj, g.email); g.note = t('If {e} has an account, a link to choose a password is on its way. Check your inbox (and spam), choose the password, then sign in here.', { e: g.email }); }
    catch (e) { g.err = authErr(e); }
    g.busy = false; schedule();
  },
  verifySend: async () => {
    const g = UI.gate; g.err = ''; g.note = ''; g.busy = true; schedule();
    try { await F.sendEmailVerification(S.authObj.currentUser); g.note = t('Link sent to {e}. Open it, then come back and tap “I’ve confirmed it”.', { e: S.email }); }
    catch (e) { g.err = authErr(e); }
    g.busy = false; schedule();
  },
  verifyDone: async () => {
    const g = UI.gate; g.err = ''; g.busy = true; schedule();
    try {
      const u = S.authObj.currentUser;
      await u.reload();
      if (S.authObj.currentUser.emailVerified) {
        await S.authObj.currentUser.getIdToken(true);   // the security rules read the confirmation from a fresh token
        g.note = ''; S.auth = 'ready'; store.start();
      } else g.err = t('Not confirmed yet. Open the link in the email first (check spam too).');
    } catch (e) { g.err = authErr(e); }
    g.busy = false; schedule();
  },
  google: async () => {
    UI.gate.err = ''; UI.gate.note = ''; UI.gate.busy = true; schedule();
    try { await F.signInWithPopup(S.authObj, new F.GoogleAuthProvider()); } catch (e) { UI.gate.err = authErr(e); }
    UI.gate.busy = false; schedule();
  }
});

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a && ACTIONS[a.dataset.act]) { e.preventDefault(); ACTIONS[a.dataset.act](a, e); return; }
  const row = e.target.closest('[data-href]');
  if (row && !e.target.closest('a,button,input,select,textarea,label')) go(row.dataset.href);
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'gate-form') return;
  e.preventDefault();
  const g = UI.gate;
  g.email = $('#g-email').value.trim();
  const pw = $('#g-pass').value;
  if (!g.email || !pw) return;
  g.err = ''; g.note = ''; g.busy = true; schedule();
  try { await F.signInWithEmailAndPassword(S.authObj, g.email, pw); } catch (err) { g.err = authErr(err); }
  g.busy = false; schedule();
});
window.addEventListener('hashchange', () => { UI.menuOpen = false; window.scrollTo(0, 0); schedule(); });
window.addEventListener('online', () => { S.online = true; schedule(); });
window.addEventListener('sl-toast', e => toast(e.detail));
window.addEventListener('offline', () => { S.online = false; schedule(); });

// ---------- start ----------
function loadCurrencies() {
  for (const k of Object.keys(CUR)) delete CUR[k];
  for (const c of L.all('SELECT code, symbol, decimals FROM currencies')) CUR[c.code] = { symbol: c.symbol, decimals: c.decimals };
}

const mark = n => { try { performance.mark('sl-' + n); } catch { /* old browser */ } };
async function boot() {
  mark('boot');
  setLang(lang());
  if (!firebaseConfig || !firebaseConfig.projectId) { S.auth = 'setup'; render(); return; }
  await L.openLocal(window.initSqlJs, new URL('../vendor/sql-wasm.wasm', import.meta.url).href);
  mark('sql');
  const app = F.initializeApp(firebaseConfig);
  S.authObj = F.getAuth(app);
  S.fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  store.init(S.fs, {
    onChange: () => { if (!S.ready) mark('data'); clearMemo(); loadCurrencies(); S.ready = true; schedule(); },
    onError: (where, err) => {
      console.error(where, err);
      if (err && err.code === 'permission-denied') { S.auth = 'denied'; schedule(); return; }
      if (where === 'write') toast(err && err.code === 'resource-exhausted'
        ? 'Firebase: limite gratuite du jour atteinte. Réessayez demain.' : 'Changement non enregistré. Vérifiez la connexion et réessayez.');
    }
  });
  F.onAuthStateChanged(S.authObj, user => {
    S.user = user;
    S.email = user ? String(user.email || '').toLowerCase() : '';
    if (!user) { S.auth = 'signedOut'; schedule(); return; }
    // An email-and-password account opens the data once its email is confirmed: the security
    // rules ask for that, so nobody can use the address without owning it. (Google accounts are.)
    if (!user.emailVerified) { S.auth = 'verify'; schedule(); return; }
    S.auth = 'ready';
    store.start();
    schedule();
  });
  render();
}
boot().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<p class="errline" style="padding:20px">${esc(e.message)}</p>`); });

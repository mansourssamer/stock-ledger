// Settings: language, the account signed in, backups (download everything as a .zip the old
// app can restore too), and putting a backup back (the Import page).
import { val } from './localdb.js';
import { t, lang, setLang } from './i18n.js';
import { esc, fmtNum } from './util.js';
import { header, panel, pill } from './ui.js';
import { registerActions } from './actions.js';
import { schedule, S as APP } from './app.js';
import { makeBackupZip } from './backup.js';
import * as F from './fb.js';
import { openForm } from './forms.js';

const B = { busy: false, progress: [0, 0], last: null, err: '' };
const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));

function settings() {
  let last = null;
  try { last = localStorage.getItem('sl-last-backup'); } catch { /* private mode */ }
  const r = B.last;
  return header(t('Settings'))
    + panel(t('Backup'), `<div class="panel-b"><p>${esc(t('Download everything in one file: your data, product photos and documents. Keep it on your computer or in Google Drive. It opens in this app (Import data) and in your old app (Backup page → Restore).'))}</p>
      ${last ? `<p class="sub">${esc(t('Last backup downloaded on this device: {d}', { d: String(last).replace('T', ' ').slice(0, 16) }))}</p>` : ''}
      ${B.busy ? `<p>${esc(t('Preparing the backup… {d} of {n} files', { d: B.progress[0], n: B.progress[1] }))}</p>` : `<div class="actions gap-t"><button class="btn primary" data-act="backupNow">${esc(t('Download a backup'))}</button>
      <a class="btn" href="#/import">${esc(t('Put a backup back'))}</a></div>`}
      ${B.err ? `<p class="errline">${esc(B.err)}</p>` : ''}
      ${r ? `<div class="callout ${r.conflicts.length || r.missing ? 'warn' : 'good'} gap-t">${esc(t('{f} saved: {r} records, {p} photos, {d} documents.', { f: r.name, r: fmtNum(r.rows), p: r.photos, d: r.documents }))}
        ${r.missing ? ' ' + esc(t('{n} photo(s) or document(s) couldn’t be included (not on this device yet — try again with internet).', { n: r.missing })) : ''}
        ${r.conflicts.length ? ' ' + esc(t('{n} record(s) don’t fit the old app’s format (for example two invoices with the same number); they are kept in the file, in a separate table.', { n: r.conflicts.length })) : ''}</div>` : ''}</div>`)
    + panel(t('Language'), `<div class="panel-b"><div class="chips"><button type="button" class="chip" data-act="setLang" data-v="fr" aria-pressed="${lang() === 'fr'}">Français</button>
      <button type="button" class="chip" data-act="setLang" data-v="en" aria-pressed="${lang() === 'en'}">English</button></div>
      <p class="sub gap-t">${esc(t('Documents for customers (invoices, proformas, statements, price list) are always in French.'))}</p></div>`)
    + panel(t('Account'), `<div class="panel-b"><p>${esc(t('Your data lives in your own Firebase project and is kept on this device too, so the app works without internet.'))}</p>
      <div class="kv gap-t"><span>${esc(t('Signed in as'))}</span><b>${esc(APP.email || '—')}</b>
      <span>${esc(t('Password for your phone'))}</span><b>${hasPassword() ? pill(t('Set'), 'good') : pill(t('Not set yet'))}</b></div>
      <p class="sub gap-t">${esc(t('Google sign-in may not open in an app added to a phone’s home screen. With a password, you sign in there with your email and that password.'))}</p>
      <div class="actions gap-t"><button class="btn" data-act="pwSet">${esc(hasPassword() ? t('Change the password') : t('Set a password'))}</button>
      <button class="btn" data-act="signOut">${esc(t('Sign out'))}</button></div></div>`)
    + panel(t('About'), `<div class="panel-b"><div class="kv"><span>${esc(t('Version'))}</span><b class="mono" id="sl-version">—</b>
      <span>${esc(t('Records on this device'))}</span><b>${fmtNum(val(`SELECT (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM boxes) + (SELECT COUNT(*) FROM customers)`) || 0)} ${pill(t('orders, boxes, customers'))}</b></div></div>`);
}
async function showVersion() {
  try { const s = await (await fetch('sw.js')).text(); const m = /stock-ledger-([0-9a-f]+)/.exec(s); const el = document.getElementById('sl-version'); if (m && el) el.textContent = m[1]; } catch { /* offline */ }
}
const user = () => (APP.authObj && APP.authObj.currentUser) || null;
const hasPassword = () => { const u = user(); return !!(u && (u.providerData || []).some(p => p && p.providerId === 'password')); };
const userErr = m => Object.assign(new Error(m), { user: true });
// Adds a password to the account signed in (or changes it), so the same account opens with
// email and password where Google sign-in can't.
async function savePassword(v) {
  if (!v.pw || v.pw.length < 8) throw userErr(t('Use at least 8 characters.'));
  if (v.pw !== v.pw2) throw userErr(t('The two passwords are different.'));
  const u = user();
  if (!u || !u.email) throw userErr(t('Sign in first.'));
  try {
    if (hasPassword()) await F.updatePassword(u, v.pw);
    else await F.linkWithCredential(u, F.EmailAuthProvider.credential(u.email, v.pw));
  } catch (e) {
    const c = e && e.code;
    if (c === 'auth/requires-recent-login') throw userErr(t('For safety, Firebase wants a fresh sign-in first: sign out, sign in again, then set the password straight away.'));
    if (c === 'auth/weak-password') throw userErr(t('That password is too easy to guess. Choose a longer one.'));
    if (c === 'auth/operation-not-allowed') throw userErr(t('Email sign-in isn’t switched on in Firebase yet: Authentication → Sign-in method → Email/Password → Enable.'));
    if (c === 'auth/email-already-in-use' || c === 'auth/credential-already-in-use') throw userErr(t('Another account already uses this email with a password. On the sign-in screen, use “Forgot password?” instead.'));
    if (c === 'auth/network-request-failed') throw userErr(t('No internet connection. Try again when you’re online.'));
    throw e;
  }
  try { await u.reload(); } catch { /* shows on the next visit */ }
}

export const SETTINGS_SCREENS = { settings: { render: settings, mount: showVersion } };

registerActions({
  pwSet: () => openForm({
    title: t('Password for your phone'),
    intro: esc(t('You’ll sign in on your phone with {e} and this password.', { e: APP.email })),
    fields: [{ name: 'pw', label: t('New password'), type: 'password', hint: t('At least 8 characters.') },
      { name: 'pw2', label: t('Same password again'), type: 'password' }],
    submit: t('Save the password'),
    prepare: savePassword,
    run: () => t('Password saved. On your phone, sign in with your email and this password.'),
    done: msg => { toast(msg); schedule(); }
  }),
  setLang: (a) => { setLang(a.dataset.v); schedule(); },
  backupNow: async () => {
    if (B.busy) return;
    B.busy = true; B.err = ''; B.progress = [0, 0]; schedule();
    try {
      const r = await makeBackupZip((d, n) => { B.progress = [d, n]; schedule(); });
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      B.last = r;
      try { localStorage.setItem('sl-last-backup', new Date().toISOString()); } catch { /* private mode */ }
      toast(t('Backup downloaded.'));
    } catch (e) {
      console.error(e);
      B.err = t('The backup couldn’t be made: {e}', { e: e.message || String(e) });
    }
    B.busy = false; schedule();
  }
});

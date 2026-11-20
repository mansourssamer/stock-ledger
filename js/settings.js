// Settings: language, the account signed in, backups (download everything as a .zip the old
// app can restore too), and putting a backup back (the Import page).
import { val } from './localdb.js';
import { t, lang, setLang } from './i18n.js';
import { esc, fmtNum } from './util.js';
import { header, panel, pill } from './ui.js';
import { registerActions } from './actions.js';
import { schedule } from './app.js';
import { makeBackupZip } from './backup.js';

const B = { busy: false, progress: [0, 0], last: null, err: '' };
const toast = m => window.dispatchEvent(new CustomEvent('sl-toast', { detail: m }));

function settings() {
  let last = null;
  try { last = localStorage.getItem('sl-last-backup'); } catch { /* private mode */ }
  const r = B.last;
  return header(t('Settings'))
    + panel(t('Backup'), `<div class="panel-b"><p>${esc(t('Download everything in one file: your data, product photos and documents. Keep it on your computer or in Google Drive. It opens in this app (Import data) and in your old app (Backup page → Restore).'))}</p>
      ${last ? `<p class="sub">${esc(t('Last backup downloaded on this device: {d}', { d: String(last).replace('T', ' ').slice(0, 16) }))}</p>` : ''}
      ${B.busy ? `<p>${esc(t('Preparing the backup… {d} of {n} files', { d: B.progress[0], n: B.progress[1] }))}</p>` : `<div class="actions"><button class="btn primary" data-act="backupNow">${esc(t('Download a backup'))}</button>
      <a class="btn" href="#/import">${esc(t('Put a backup back'))}</a></div>`}
      ${B.err ? `<p class="errline">${esc(B.err)}</p>` : ''}
      ${r ? `<div class="callout ${r.conflicts.length || r.missing ? 'warn' : 'good'} mtop">${esc(t('{f} saved: {r} records, {p} photos, {d} documents.', { f: r.name, r: fmtNum(r.rows), p: r.photos, d: r.documents }))}
        ${r.missing ? ' ' + esc(t('{n} photo(s) or document(s) couldn’t be included (not on this device yet — try again with internet).', { n: r.missing })) : ''}
        ${r.conflicts.length ? ' ' + esc(t('{n} record(s) don’t fit the old app’s format (for example two invoices with the same number); they are kept in the file, in a separate table.', { n: r.conflicts.length })) : ''}</div>` : ''}</div>`)
    + panel(t('Language'), `<div class="panel-b"><div class="chips"><button type="button" class="chip" data-act="setLang" data-v="fr" aria-pressed="${lang() === 'fr'}">Français</button>
      <button type="button" class="chip" data-act="setLang" data-v="en" aria-pressed="${lang() === 'en'}">English</button></div>
      <p class="sub mtop">${esc(t('Documents for customers (invoices, proformas, statements, price list) are always in French.'))}</p></div>`)
    + panel(t('Account'), `<div class="panel-b"><p>${esc(t('Your data lives in your own Firebase project and is kept on this device too, so the app works without internet.'))}</p>
      <div class="actions"><button class="btn" data-act="signOut">${esc(t('Sign out'))}</button></div></div>`)
    + panel(t('About'), `<div class="panel-b"><div class="kv"><span>${esc(t('Version'))}</span><b class="mono" id="sl-version">—</b>
      <span>${esc(t('Records on this device'))}</span><b>${fmtNum(val(`SELECT (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM boxes) + (SELECT COUNT(*) FROM customers)`) || 0)} ${pill(t('orders, boxes, customers'))}</b></div></div>`);
}
async function showVersion() {
  try { const s = await (await fetch('sw.js')).text(); const m = /stock-ledger-([0-9a-f]+)/.exec(s); const el = document.getElementById('sl-version'); if (m && el) el.textContent = m[1]; } catch { /* offline */ }
}
export const SETTINGS_SCREENS = { settings: { render: settings, mount: showVersion } };

registerActions({
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

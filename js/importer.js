// Brings the data over from the old Stock & Ledger app. It reads the backup .zip (or an
// erp.db) right here in the browser, uploads every table to Firebase, then reads it all
// back from the server and compares it with the backup row by row, and compares the key
// figures (stock value, what customers owe, cash) computed on both.
import { TABLES } from './schema.js';
import * as L from './localdb.js';
import * as store from './store.js';
import * as Q from './queries.js';
import { t } from './i18n.js';
import { esc, fmtNum, fmtUsd, $ } from './util.js';
import { header, panel, table, pill } from './ui.js';
import { schedule } from './app.js';
import { registerActions } from './actions.js';
import { shrinkImage } from './images.js';
import { makeBackupZip } from './backup.js';

const REQUIRED = ['products', 'variants', 'boxes', 'box_items', 'orders', 'customers', 'invoices'];
const FILE_MAX = 700 * 1024;   // a Firestore document holds up to 1 MB; base64 makes files a third bigger
const ST = { phase: 'idle', err: '', plan: null, progress: [0, 0], report: null, replace: false, copy: null, copying: false };

// ---------- reading the backup ----------
async function readBackup(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let dbBytes = null, zip = null;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {           // a .zip
    const whole = await window.JSZip.loadAsync(buf);
    // A Mac often unzips the download into a folder; zipped again (Finder → Compress), everything
    // sits one folder down. So find erp.db wherever it is and read the photos next to it.
    const e = whole.file('erp.db') || whole.file(/(^|\/)erp\.db$/).find(f => !f.name.startsWith('__MACOSX/'));
    if (!e) throw new Error(t('That file isn’t a Stock & Ledger backup.'));
    const base = e.name.slice(0, e.name.length - 'erp.db'.length);
    zip = { file: name => whole.file(base + name) };
    dbBytes = await e.async('uint8array');
  } else dbBytes = buf;
  const head = new TextDecoder().decode(dbBytes.slice(0, 15));
  if (head !== 'SQLite format 3') throw new Error(t('That file isn’t a Stock & Ledger backup.'));
  const src = L.openBytes(dbBytes);
  const have = new Set(L.withDb(src, () => L.all(`SELECT name FROM sqlite_master WHERE type='table'`)).map(r => r.name));
  if (REQUIRED.some(r => !have.has(r))) throw new Error(t('That file isn’t a Stock & Ledger backup.'));
  return { src, zip, have };
}

// Every row of every table, as {table: Map(key -> row)} with the backup's own values.
function sourceRows(src, have) {
  const out = {};
  for (const [name, def] of Object.entries(TABLES)) {
    out[name] = new Map();
    if (!have.has(name)) continue;
    const cols = new Set(L.withDb(src, () => L.all(`PRAGMA table_info("${name}")`)).map(r => r.name));
    for (const r of L.withDb(src, () => L.all(`SELECT * FROM "${name}"`))) {
      const row = {};
      for (const [c] of def.cols) row[c] = cols.has(c) ? r[c] : null;
      out[name].set(r[def.key], row);
    }
  }
  return out;
}

function bucketDocs(rows) {
  const docs = [];
  for (const [name, map] of Object.entries(rows)) {
    const key = TABLES[name].key;
    const buckets = new Map();
    for (const [k, row] of map) {
      const b = L.bucketOf(name, k);
      if (!buckets.has(b)) buckets.set(b, {});
      const r = { ...row };
      delete r[key];
      buckets.get(b)[String(k)] = r;
    }
    for (const [b, r] of buckets) docs.push({ coll: name, id: b, data: { rows: r } });
  }
  return docs;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function plan(file) {
  const { src, zip, have } = await readBackup(file);
  const rows = sourceRows(src, have);
  const docs = bucketDocs(rows);
  const photos = [], files = [], tooBig = [], missing = [];
  if (zip) {
    for (const p of rows.products.values()) {
      if (!p.image_filename) continue;
      if (zip.file('uploads/products/' + p.image_filename)) photos.push(p.image_filename);
      else missing.push(p.image_filename);
    }
    for (const d of rows.documents.values()) {
      const e = zip.file('uploads/documents/' + d.filename);
      if (!e) { missing.push(d.original_name || d.filename); continue; }
      const bytes = await e.async('uint8array');
      if (bytes.length > FILE_MAX) tooBig.push(d.original_name || d.filename);
      else files.push(d.filename);
    }
  }
  const counts = Object.entries(rows).map(([n, m]) => [n, m.size]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const already = (await Promise.all(Object.keys(TABLES).map(n => store.serverBuckets(n).then(b => Object.keys(b).length).catch(() => 0)))).reduce((a, b) => a + b, 0);
  const change = compareWithApp(rows);
  const newest = { backup: L.withDb(src, () => newestEntry(false)), app: newestEntry(true) };
  return { src, zip, rows, docs, photos, files, tooBig, missing, counts, already, change, newest, writes: docs.length + photos.length + files.length };
}

// What importing this backup changes in the app, compared with this device's copy (which mirrors
// the server): records it adds, changes and removes. Records made in this app have text ids
// (imported ones keep the old app's numbers), so those are the ones only this app has.
function compareWithApp(rows) {
  const out = { added: 0, changed: 0, removed: 0, madeHere: [] };
  for (const [name, map] of Object.entries(rows)) {
    const def = TABLES[name], key = def.key;
    let mine;
    try { mine = L.all(`SELECT * FROM "${name}"`); } catch { continue; }
    const seen = new Set();
    let here = 0;
    for (const r of mine) {
      const k = r[key];
      seen.add(k);
      const b = map.get(k);
      if (!b) { out.removed++; if (key === 'id' && typeof k === 'string') here++; continue; }
      if (def.cols.some(([c]) => c !== key && !same(b[c], r[c]))) out.changed++;
    }
    for (const k of map.keys()) if (!seen.has(k)) out.added++;
    if (here) out.madeHere.push([name, here]);
  }
  out.madeHere.sort((a, b) => b[1] - a[1]);
  return out;
}
// The newest record (by when it was entered), to catch an older backup chosen by mistake. For
// this app it only looks at imported records, since records made here are never in a backup
// from the old app.
function newestEntry(importedOnly) {
  let best = '';
  for (const [name, def] of Object.entries(TABLES)) {
    if (!def.cols.some(([c]) => c === 'created_at')) continue;
    const only = importedOnly && def.key === 'id' ? ` WHERE typeof("id") = 'integer'` : '';
    try {
      const v = L.val(`SELECT MAX(replace(substr(created_at, 1, 19), 'T', ' ')) FROM "${name}"${only}`);
      if (v && String(v) > best) best = String(v);
    } catch { /* that table isn't in an older backup */ }
  }
  return best;
}
const madeHereTotal = P => P.change.madeHere.reduce((a, [, n]) => a + n, 0);
const TABLE_LABEL = {
  orders: 'orders', order_items: 'order lines', order_box_lines: 'box lines', payments: 'payments', invoices: 'invoices',
  customers: 'customers', returns: 'returns', return_items: 'returned items', boxes: 'boxes', box_items: 'box contents',
  purchase_orders: 'purchase orders', po_items: 'purchase order lines', po_costs: 'cost lines', po_payments: 'supplier payments',
  suppliers: 'suppliers', products: 'styles', variants: 'colors and sizes', expenses: 'expenses', cash_transactions: 'account entries',
  partner_ledger: 'partner entries', crm_contacts: 'CRM contacts', crm_activities: 'CRM notes', proformas: 'proformas', stock_moves: 'stock movements'
};

// ---------- uploading and checking ----------
const same = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  return a === b;
};

async function runImport() {
  const P = ST.plan;
  ST.phase = 'importing'; schedule();
  // 1. Empty every bucket the app already has (other phones see it emptied, not stale).
  const clears = [];
  for (const name of Object.keys(TABLES)) {
    const existing = await store.serverBuckets(name);
    const keep = new Set(P.docs.filter(d => d.coll === name).map(d => d.id));
    for (const b of Object.keys(existing)) if (!keep.has(b)) clears.push({ coll: name, id: b, data: { rows: {} } });
  }
  // 2. Photos and documents.
  const blobs = [];
  for (const f of P.photos) {
    try {
      const bytes = await P.zip.file('uploads/products/' + f).async('uint8array');
      blobs.push({ coll: 'images', id: f, data: await shrinkImage(bytes, f) });
    } catch (e) { console.warn('photo', f, e); }
  }
  for (const f of P.files) {
    const d = [...P.rows.documents.values()].find(x => x.filename === f);
    const bytes = await P.zip.file('uploads/documents/' + f).async('uint8array');
    blobs.push({ coll: 'files', id: f, data: { name: d.original_name, data: toBase64(bytes), bytes: bytes.length } });
  }
  const all = [...clears, ...P.docs, ...blobs];
  ST.progress = [0, all.length]; schedule();
  await store.writeBuckets(all, (done, total) => { ST.progress = [done, total]; schedule(); });

  // 3. Read everything back from the server and compare with the backup.
  ST.phase = 'checking'; schedule();
  const tables = [];
  let ok = true;
  for (const [name, map] of Object.entries(P.rows)) {
    const server = await store.serverBuckets(name);
    const got = new Map();
    for (const rows of Object.values(server)) for (const [k, r] of Object.entries(rows)) got.set(L.keyFromDoc(name, k), r);
    let diff = 0;
    const key = TABLES[name].key;
    for (const [k, row] of map) {
      const g = got.get(k);
      if (!g) { diff++; continue; }
      for (const [c] of TABLES[name].cols) if (c !== key && !same(row[c], g[c])) { diff++; break; }
    }
    diff += [...got.keys()].filter(k => !map.has(k)).length;
    if (diff) ok = false;
    if (map.size || got.size) tables.push({ name, src: map.size, dst: got.size, diff });
    L.batch(() => {   // refresh this device's copy from what the server holds
      L.replaceBucket(name, 'all', {});
      for (const [b, rows] of Object.entries(server)) L.replaceBucket(name, b, rows);
    });
  }
  // Tables only this app keeps (order numbers) were emptied above: empty this device's copy too.
  for (const name of Object.keys(TABLES)) {
    if (P.rows[name]) continue;
    const server = await store.serverBuckets(name);
    L.batch(() => {
      L.replaceBucket(name, 'all', {});
      for (const [b, rows] of Object.entries(server)) L.replaceBucket(name, b, rows);
    });
  }
  // 4. The headline figures, computed the same way on the backup and on the new copy.
  const fig = () => ({ stock: Q.stockValueLanded(), owed: Q.dashboardFigures().outstanding_total, cash: Q.totalCashOnHand(),
    boxes: L.val(`SELECT COUNT(*) FROM boxes WHERE status = 'in_stock'`) });
  const a = L.withDb(P.src, fig), b = fig();
  const figs = [['Stock value', a.stock, b.stock, true], ['Customers owe', a.owed, b.owed, true], ['Cash on hand', a.cash, b.cash, true], ['Boxes in stock', a.boxes, b.boxes, false]];
  for (const f of figs) if (Math.abs(f[1] - f[2]) > 0.005) ok = false;
  ST.report = { ok, tables, figs, photos: P.photos.length, files: P.files.length, tooBig: P.tooBig };
  ST.phase = 'done';
  schedule();
}

// ---------- the screen ----------
function render() {
  const out = [header(t('Import your data'), { sub: esc(t('Bring everything from your current Stock & Ledger app: stock, boxes, customers, orders, invoices, payments, purchases, accounts and photos.')) })];
  if (ST.phase === 'idle' || ST.phase === 'error') {
    out.push(panel(t('Choose the backup file'), `<p class="sub">${esc(t('In your current app, open Backup and click “Download a backup now”. Then choose that .zip file here.'))}</p>
      <p class="sub">${esc(t('On a Mac, if the download turned into a folder, right-click the folder → Compress, then choose the .zip it makes.'))}</p>
      <div class="inline" style="margin-top:12px"><input id="imp-file" type="file" accept=".zip,.db,application/zip"></div>
      ${ST.err ? `<p class="errline">${esc(ST.err)}</p>` : ''}`));
  } else if (ST.phase === 'reading') {
    out.push(panel('', `<p>${esc(t('Reading the backup…'))}</p>`));
  } else if (ST.phase === 'ready') {
    const P = ST.plan;
    const rows = P.counts.map(([n, c]) => ({ cells: [`<span class="mono">${esc(n)}</span>`, fmtNum(c)] }));
    const holds = panel(t('What this backup holds'), table([{ h: t('Table') }, { h: t('Rows'), n: true }], rows,
      { foot: [`${esc(t('Photos'))} · ${esc(t('Documents'))}`, `${fmtNum(P.photos.length)} · ${fmtNum(P.files.length)}`] }), { tight: true });
    if (!P.already) out.push(holds);   // with data already here, what changes comes first and this goes last
    const warn = [];
    if (P.tooBig.length) warn.push(`<p class="sub">${esc(t('Too large to keep (over 700 KB), so it stays in your old app:'))} ${esc(P.tooBig.join(', '))}</p>`);
    const here = madeHereTotal(P);
    const needCopy = here > 0 && !ST.copy;
    if (P.already) {
      const C = P.change;
      out.push(panel(t('What changes in this app'), `<div class="panel-b"><p class="warnline">${esc(t('This app already has data. Importing replaces all of it with the backup.'))}</p>
        <div class="kv gap-t"><span>${esc(t('Records added'))}</span><b>${fmtNum(C.added)}</b><span>${esc(t('Records changed'))}</span><b>${fmtNum(C.changed)}</b><span>${esc(t('Records removed'))}</span><b>${fmtNum(C.removed)}</b>
        <span>${esc(t('Newest entry in this backup'))}</span><b class="mono">${esc(P.newest.backup.slice(0, 16) || '—')}</b><span>${esc(t('Newest imported entry in this app'))}</span><b class="mono">${esc(P.newest.app.slice(0, 16) || '—')}</b></div>
        ${P.newest.app && P.newest.backup < P.newest.app ? `<p class="errline">${esc(t('This backup is older than the data already in this app. Check that you chose the newest backup from your old app.'))}</p>` : ''}
        ${here ? `<div class="callout warn gap-t">${esc(t('{n} record(s) were entered in this app and are not in this backup:', { n: fmtNum(here) }))} ${esc(P.change.madeHere.map(([n, c]) => `${fmtNum(c)} ${t(TABLE_LABEL[n] || n)}`).join(', '))}. ${esc(t('Importing removes them. Download a copy of this app first, so you can get them back if you need to.'))}</div>` : ''}
        <div class="actions gap-t">${ST.copying ? `<span>${esc(t('Preparing the copy… {d} of {n} files', { d: ST.progress[0], n: ST.progress[1] }))}</span>`
          : `<button type="button" class="btn${here && !ST.copy ? ' primary' : ''}" data-act="impCopy">${esc(t('Download a copy of this app first'))}</button>`}
          ${ST.copy ? `<span class="pill good">${esc(t('Copy saved: {f}', { f: ST.copy }))}</span>` : ''}</div></div>`));
    }
    out.push(panel('', `<div class="kv"><span>${esc(t('Firebase writes needed'))}</span><b>${fmtNum(P.writes)}</b><span>${esc(t('Free limit per day'))}</span><b>20 000</b></div>
      ${warn.join('')}
      <label class="check"><input type="checkbox" id="imp-ok"${ST.replace ? ' checked' : ''}> ${esc(t('Replace all data in this app with this backup'))}</label>
      ${needCopy ? `<p class="sub">${esc(t('Download the copy above first.'))}</p>` : ''}
      <div class="actions" style="margin-top:12px"><button type="button" class="btn primary" data-act="impGo"${ST.replace && !needCopy ? '' : ' disabled'}>${esc(t('Import now'))}</button>
      <button type="button" class="btn ghost" data-act="impReset">${esc(t('Back'))}</button></div>
      ${ST.err ? `<p class="errline">${esc(ST.err)}</p>` : ''}`));
    if (P.already) out.push(holds);
  } else if (ST.phase === 'importing' || ST.phase === 'checking') {
    const [d, n] = ST.progress;
    out.push(panel('', `<p>${esc(ST.phase === 'checking' ? t('Checking…') : t('Uploading… {done} of {total}', { done: fmtNum(d), total: fmtNum(n) }))}</p>
      <div class="bar"><span style="width:${n ? Math.round(100 * d / n) : 5}%"></span></div>`));
  } else if (ST.phase === 'done') {
    const R = ST.report;
    const rows = R.tables.map(x => ({ cells: [`<span class="mono">${esc(x.name)}</span>`, fmtNum(x.src), fmtNum(x.dst), x.diff ? pill(t('Different') + ' · ' + x.diff, 'bad') : pill(t('Match'), 'good')] }));
    const figRows = R.figs.map(([k, a, b, money]) => ({ cells: [esc(t(k)), money ? esc(fmtUsd(a)) : fmtNum(a), money ? esc(fmtUsd(b)) : fmtNum(b),
      Math.abs(a - b) > 0.005 ? pill(t('Different'), 'bad') : pill(t('Match'), 'good')] }));
    out.push(`<div class="banner ${R.ok ? 'good' : 'bad'}"><b>${esc(R.ok ? t('Imported and checked') : t('Import finished, but the check found differences'))}</b>
      ${R.ok ? `<span>${esc(t('Every table matches the backup row for row.'))}</span>` : ''}</div>`);
    out.push(panel(t('Key figures'), table([{ h: '' }, { h: t('Old app'), n: true }, { h: t('New app'), n: true }, { h: '' }], figRows), { tight: true }));
    out.push(panel('', table([{ h: t('Table') }, { h: t('In backup'), n: true }, { h: t('In this app'), n: true }, { h: '' }], rows,
      { foot: [`${esc(t('Photos'))} · ${esc(t('Documents'))}`, '', `${fmtNum(R.photos)} · ${fmtNum(R.files)}`, ''] }), { tight: true }));
    if (R.tooBig.length) out.push(panel('', `<p class="sub">${esc(t('Too large to keep (over 700 KB), so it stays in your old app:'))} ${esc(R.tooBig.join(', '))}</p>`));
    if (R.ok) out.push(panel(t('From now on'), `<div class="panel-b"><p>${esc(t('Enter new sales, payments and purchases only in this app. Keep your old app as it is for a few weeks in case you need to look something up, but don’t enter anything there any more, or the two will no longer agree.'))}</p>
      <div class="actions"><a class="btn primary" href="#/home">${esc(t('Go to the home page'))}</a><a class="btn" href="#/settings">${esc(t('Download a backup'))}</a></div></div>`));
    out.push(`<div class="actions"><button type="button" class="btn ghost" data-act="impReset">${esc(t('Import another backup'))}</button></div>`);
  }
  return out.join('');
}

function mount() {
  const f = $('#imp-file');
  if (f) f.addEventListener('change', async () => {
    if (!f.files || !f.files[0]) return;
    ST.phase = 'reading'; ST.err = ''; schedule();
    try { ST.plan = await plan(f.files[0]); ST.phase = 'ready'; ST.replace = false; ST.copy = null; }
    catch (e) { console.error(e); ST.phase = 'error'; ST.err = e.message || String(e); }
    schedule();
  });
  const ok = $('#imp-ok');
  if (ok) ok.addEventListener('change', () => { ST.replace = ok.checked; schedule(); });
}

registerActions({
  impGo: () => {
    if (!ST.replace || !ST.plan || (madeHereTotal(ST.plan) > 0 && !ST.copy)) return;
    runImport().catch(e => { console.error(e); ST.phase = 'error'; ST.err = e.message || String(e); schedule(); });
  },
  impReset: () => { ST.phase = 'idle'; ST.plan = null; ST.copy = null; ST.report = null; ST.err = ''; schedule(); },
  // A copy of everything in this app as it is now, before the import replaces it. It's an
  // ordinary backup, so it imports back here (or into the old app) if anything was lost.
  impCopy: async () => {
    if (ST.copying) return;
    ST.copying = true; ST.progress = [0, 0]; schedule();
    try {
      const r = await makeBackupZip((d, n) => { ST.progress = [d, n]; schedule(); }, 'stock-ledger-before-import');
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      ST.copy = r.name;
    } catch (e) { console.error(e); ST.err = t('The copy couldn’t be made: {e}', { e: e.message || String(e) }); }
    ST.copying = false; schedule();
  }
});

export const importScreen = { render, mount };

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

const REQUIRED = ['products', 'variants', 'boxes', 'box_items', 'orders', 'customers', 'invoices'];
const FILE_MAX = 700 * 1024;   // a Firestore document holds up to 1 MB; base64 makes files a third bigger
const ST = { phase: 'idle', err: '', plan: null, progress: [0, 0], report: null, replace: false };

// ---------- reading the backup ----------
async function readBackup(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let dbBytes = null, zip = null;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {           // a .zip
    zip = await window.JSZip.loadAsync(buf);
    const e = zip.file('erp.db');
    if (!e) throw new Error(t('That file isn’t a Stock & Ledger backup.'));
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

// Photos are shrunk to phone size so each fits in one free database document.
async function shrinkImage(bytes, name) {
  const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  let max = 1100, q = 0.78, url = '';
  for (let i = 0; i < 5; i++) {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    url = c.toDataURL('image/jpeg', q);
    if (url.length < 900 * 1024) return { data: url, w: c.width, h: c.height, bytes: Math.round(url.length * 0.75) };
    max = Math.round(max * 0.75); q -= 0.08;
  }
  return { data: url, bytes: Math.round(url.length * 0.75) };
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
  return { src, zip, rows, docs, photos, files, tooBig, missing, counts, already, writes: docs.length + photos.length + files.length };
}

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
      <div class="inline" style="margin-top:12px"><input id="imp-file" type="file" accept=".zip,.db,application/zip"></div>
      ${ST.err ? `<p class="errline">${esc(ST.err)}</p>` : ''}`));
  } else if (ST.phase === 'reading') {
    out.push(panel('', `<p>${esc(t('Reading the backup…'))}</p>`));
  } else if (ST.phase === 'ready') {
    const P = ST.plan;
    const rows = P.counts.map(([n, c]) => ({ cells: [`<span class="mono">${esc(n)}</span>`, fmtNum(c)] }));
    out.push(panel(t('What this backup holds'), table([{ h: t('Table') }, { h: t('Rows'), n: true }], rows,
      { foot: [`${esc(t('Photos'))} · ${esc(t('Documents'))}`, `${fmtNum(P.photos.length)} · ${fmtNum(P.files.length)}`] }), { tight: true }));
    const warn = [];
    if (P.tooBig.length) warn.push(`<p class="sub">${esc(t('Too large to keep (over 700 KB), so it stays in your old app:'))} ${esc(P.tooBig.join(', '))}</p>`);
    if (P.already) warn.push(`<p class="warnline">${esc(t('This app already has data. Importing replaces all of it with the backup.'))}</p>`);
    out.push(panel('', `<div class="kv"><span>${esc(t('Firebase writes needed'))}</span><b>${fmtNum(P.writes)}</b><span>${esc(t('Free limit per day'))}</span><b>20 000</b></div>
      ${warn.join('')}
      <label class="check"><input type="checkbox" id="imp-ok"${ST.replace ? ' checked' : ''}> ${esc(t('Replace all data in this app with this backup'))}</label>
      <div class="actions" style="margin-top:12px"><button type="button" class="btn primary" data-act="impGo"${ST.replace ? '' : ' disabled'}>${esc(t('Import now'))}</button>
      <button type="button" class="btn ghost" data-act="impReset">${esc(t('Back'))}</button></div>`));
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
  }
  return out.join('');
}

function mount() {
  const f = $('#imp-file');
  if (f) f.addEventListener('change', async () => {
    if (!f.files || !f.files[0]) return;
    ST.phase = 'reading'; ST.err = ''; schedule();
    try { ST.plan = await plan(f.files[0]); ST.phase = 'ready'; ST.replace = false; }
    catch (e) { console.error(e); ST.phase = 'error'; ST.err = e.message || String(e); }
    schedule();
  });
  const ok = $('#imp-ok');
  if (ok) ok.addEventListener('change', () => { ST.replace = ok.checked; schedule(); });
}

registerActions({
  impGo: () => { if (ST.replace && ST.plan) runImport().catch(e => { console.error(e); ST.phase = 'error'; ST.err = e.message || String(e); schedule(); }); },
  impReset: () => { ST.phase = 'idle'; ST.plan = null; schedule(); }
});

export const importScreen = { render, mount };

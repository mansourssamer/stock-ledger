// Backups: everything in one .zip — the data as an erp.db in the old app's own format (see
// backupdb.js), plus product photos and documents.
import * as L from './localdb.js';
import { getBlob } from './store.js';
import { t } from './i18n.js';
import { buildBackupDb } from './backupdb.js';

function fromBase64(s) {
  const bin = atob(s), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
// The whole backup as a .zip Blob, with a summary for the screen.
export async function makeBackupZip(onProgress = () => {}) {
  const db = buildBackupDb();
  const zip = new window.JSZip();
  zip.file('erp.db', db.bytes);
  const photos = L.all(`SELECT DISTINCT image_filename as f FROM products WHERE image_filename IS NOT NULL AND image_filename != ''`).map(r => r.f);
  const docs = L.all(`SELECT filename, original_name FROM documents ORDER BY id`);
  const total = photos.length + docs.length;
  let done = 0, missing = 0;
  for (const f of photos) {
    const d = await getBlob('images', f).catch(() => null);
    const m = d && d.data ? /^data:[^;]+;base64,(.*)$/.exec(d.data) : null;
    if (m) zip.file('uploads/products/' + f, fromBase64(m[1])); else missing++;
    onProgress(++done, total);
  }
  for (const doc of docs) {
    const d = await getBlob('files', doc.filename).catch(() => null);
    if (d && d.data) zip.file('uploads/documents/' + doc.filename, fromBase64(d.data)); else missing++;
    onProgress(++done, total);
  }
  const now = new Date().toISOString();
  zip.file('README.txt', `Stock & Ledger backup\nMade: ${now.slice(0, 16).replace('T', ' ')} UTC\nerp.db = all your data; uploads/ = product photos and documents.\n`
    + `To put it back: in the new app, Import data; in the old app, Backup page -> Restore.\n`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const name = `erp-backup-${now.slice(0, 10)}_${now.slice(11, 19).replace(/:/g, '')}.zip`;
  return { blob, name, rows: db.rows, renumbered: db.renumbered, conflicts: db.conflicts, photos: photos.length, documents: docs.length, missing };
}
export const backupSummary = r => t('{r} records, {p} photos, {d} documents.', { r: r.rows, p: r.photos - (r.missingPhotos || 0), d: r.documents });

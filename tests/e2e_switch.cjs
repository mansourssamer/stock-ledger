// The switch-over in the browser with a fake Firebase: import the old app's backup, check that
// choosing it again shows nothing would change, enter a record in the new app, then check the
// import refuses to go ahead until a copy of the app is downloaded, that the copy brings the
// record back, and that an older backup is flagged.
//    node tests/e2e_switch.cjs backup.zip older.zip outdir [--phone]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, older, outDir = '/tmp/sl-switch', ...flags] = process.argv;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p === '/js/fb.js') p = '/tests/fake-fb.js';
      if (p === '/config.js') { resp.writeHead(200, { 'content-type': 'text/javascript' }); resp.end('export const firebaseConfig = {projectId: "test"};'); return; }
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { resp.writeHead(404); resp.end(); return; }
      resp.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(resp);
    }).listen(0, () => res(srv));
  });
}
let n = 0, failed = 0;
const expect = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const phone = flags.includes('--phone');
  const ctx = await browser.newContext({ acceptDownloads: true, ...(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } }) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const shot = async name => page.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: true });
  const submit = async () => { await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(400); const err = await page.$('.modal .errline'); if (err) throw new Error('Form refused: ' + await err.textContent()); };
  const kv = async label => page.evaluate(l => { for (const s of document.querySelectorAll('.kv span')) if (s.textContent.trim() === l) return s.nextElementSibling.textContent.trim(); return null; }, label);
  const choose = async file => {
    await page.goto(base + '#/import'); await page.waitForTimeout(300);
    if (!(await page.$('#imp-file'))) await page.click('[data-act="impReset"]');
    await page.waitForSelector('#imp-file');
    await page.setInputFiles('#imp-file', file); await page.waitForSelector('#imp-ok', { timeout: 60000 });
  };
  const importNow = async () => {
    await page.check('#imp-ok'); await page.waitForTimeout(150);
    await page.click('[data-act="impGo"]'); await page.waitForSelector('.banner', { timeout: 180000 });
    return (await page.textContent('.banner')).trim().replace(/\s+/g, ' ');
  };
  await page.goto(base + '#/home'); await page.evaluate(() => { try { localStorage.setItem('sl-lang', 'en'); } catch { /* */ } });
  await page.reload(); await page.waitForTimeout(500);

  // 1. First import into an empty app: no "what changes" panel, and a "from now on" note after.
  await choose(zip);
  expect(!(await page.$('text=What changes in this app')), 'empty app: no "what changes" panel');
  let banner = await importNow();
  expect(/Imported and checked/.test(banner), 'first import: ' + banner.slice(0, 60));
  expect(!!(await page.$('text=From now on')), 'after import: the "from now on" note shows');
  await shot('first-import');

  // 2. The same backup again: nothing would change, no copy needed, no "older" warning.
  await choose(zip);
  const a = await kv('Records added'), c = await kv('Records changed'), r = await kv('Records removed');
  expect(a === '0' && c === '0' && r === '0', `same backup again: added ${a}, changed ${c}, removed ${r}`);
  expect(!(await page.$('text=This backup is older')), 'same backup: no "older" warning');
  expect(!(await page.$('text=were entered in this app')), 'same backup: nothing entered here');
  await page.check('#imp-ok'); await page.waitForTimeout(150);
  expect(!(await page.$eval('[data-act="impGo"]', b => b.disabled)), 'same backup: Import is allowed without a copy');
  await shot('same-again');
  await page.click('[data-act="impReset"]');

  // 3. Enter a CRM contact and a customer here, then choose the backup again.
  await page.goto(base + '#/crm'); await page.waitForTimeout(500);
  await page.click('[data-act="crmNew"]'); await page.waitForTimeout(200);
  await page.fill('#f-name', 'Saisi dans la nouvelle appli'); await page.selectOption('#f-zone_id', { index: 1 }); await submit();
  await choose(zip);
  const here = await page.textContent('.callout.warn').catch(() => '');
  expect(/1 record\(s\) were entered in this app/.test(here) && /CRM contacts/.test(here), 'made here is listed: ' + here.trim().slice(0, 90));
  expect((await kv('Records removed')) === '1', 'records removed: ' + await kv('Records removed'));
  await page.check('#imp-ok'); await page.waitForTimeout(150);
  expect(await page.$eval('[data-act="impGo"]', b => b.disabled), 'Import is blocked until a copy is downloaded');
  await shot('needs-copy');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-act="impCopy"]')]);
  const copy = path.join(outDir, dl.suggestedFilename()); await dl.saveAs(copy); await page.waitForTimeout(400);
  expect(/^stock-ledger-before-import-\d{4}-\d{2}-\d{2}_\d{6}\.zip$/.test(path.basename(copy)), 'copy downloaded: ' + path.basename(copy));
  expect(!(await page.$eval('[data-act="impGo"]', b => b.disabled)), 'Import allowed once the copy is saved');
  await shot('copy-saved');
  banner = await importNow();
  expect(/Imported and checked/.test(banner), 'import over the app: ' + banner.slice(0, 60));
  await page.goto(base + '#/crmcontacts'); await page.waitForTimeout(700);
  expect(!(await page.$('text=Saisi dans la nouvelle appli')), 'the contact entered here is gone after the import');

  // 4. The copy brings it back.
  await choose(copy);
  banner = await importNow();
  expect(/Imported and checked/.test(banner), 'import of the copy: ' + banner.slice(0, 60));
  await page.goto(base + '#/crmcontacts'); await page.waitForTimeout(700);
  expect(!!(await page.$('text=Saisi dans la nouvelle appli')), 'the copy brings the contact back');

  // 5. An older backup is flagged (and nothing is imported).
  await choose(older);
  expect(!!(await page.$('text=This backup is older than the data already in this app')), 'older backup is flagged');
  await shot('older');
  await page.click('[data-act="impReset"]');

  // 6. Same screens in French.
  await page.evaluate(() => { try { localStorage.setItem('sl-lang', 'fr'); } catch { /* */ } });
  await page.reload(); await page.waitForTimeout(500);
  await choose(zip);
  expect(!!(await page.$('text=Ce qui change dans cette application')), 'French: "what changes" panel');
  await shot('fr');

  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close(); srv.close();
  if (errors.length || failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

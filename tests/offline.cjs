// Opens the app once (the service worker keeps its files), then again with no network: every
// file must come from the device and the app must start with no errors.
//    node tests/offline.cjs backup.zip outdir
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-offline', ...flags] = process.argv;
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
      if (p === '/index.html') { resp.end(fs.readFileSync(f, 'utf8').replace("location.protocol === 'https:'", "true")); return; }
      fs.createReadStream(f).pipe(resp);
    }).listen(0, () => res(srv));
  });
}
let n = 0;
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const phone = flags.includes('--phone');
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const shot = async name => page.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: true });
  const toast = async () => { await page.waitForTimeout(250); return (await page.textContent('#toast').catch(() => '')) || ''; };
  const submit = async () => { await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(400); const err = await page.$('.modal .errline'); if (err) throw new Error('Form refused: ' + await err.textContent()); };
  const log = (...a) => console.log(...a);


  await page.goto(base + '#/import');
  await page.waitForSelector('#imp-file');
  await page.setInputFiles('#imp-file', zip);
  await page.waitForSelector('#imp-ok', { timeout: 30000 });
  await page.check('#imp-ok');
  await page.click('[data-act="impGo"]');
  await page.waitForSelector('.banner', { timeout: 120000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const cached = await page.evaluate(async () => { const ks = await caches.keys(); const c = await caches.open(ks[0]); return (await c.keys()).length; });
  log('files kept on the device:', cached);
  await ctx.setOffline(true);
  srv.close();
  for (const h of ['purchasing', 'buying', 'orders', 'po/1']) {
    await page.goto(base + '#/' + h, { waitUntil: 'load' }).catch(e => errors.push('goto ' + h + ': ' + e.message));
    await page.reload({ waitUntil: 'load' }).catch(e => errors.push('reload ' + h + ': ' + e.message));
    await page.waitForTimeout(1500);
    log('offline', h, '→', ((await page.textContent('h1').catch(() => '')) || '').trim() || '(no heading)');
  }
  await shot('offline');
  log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

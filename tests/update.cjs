// A new version reaching an open app: the new files download in the background and the page
// reloads by itself; with a form open it shows a "New version ready" bar instead.
//    node tests/update.cjs outdir
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const [, , outDir = '/tmp/sl-update'] = process.argv;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let VERSION = 'A';
const srv = http.createServer((req, resp) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/js/fb.js') p = '/tests/fake-fb.js';
  if (p === '/config.js') { resp.writeHead(200, { 'content-type': 'text/javascript' }); resp.end('export const firebaseConfig = {projectId: "test"};'); return; }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { resp.writeHead(404); resp.end(); return; }
  resp.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'max-age=600' });   // like GitHub Pages
  if (p === '/index.html') { resp.end(fs.readFileSync(f, 'utf8').replace("location.protocol === 'https:'", 'true')); return; }   // service worker on localhost
  if (p === '/sw.js') { resp.end(fs.readFileSync(f, 'utf8').replace(/const CACHE = '[^']*';/, `const CACHE = 'stock-ledger-test-${VERSION}';`)); return; }
  fs.createReadStream(f).pipe(resp);
});
let failed = 0;
const expect = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
srv.listen(0, async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(base + '#/home');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 });
  const keys = () => page.evaluate(() => caches.keys());
  expect((await keys()).includes('stock-ledger-test-A'), 'version A installed and in charge');

  // 1. New version while nothing is open: the page reloads by itself
  await page.evaluate(() => { window.__before = true; });
  VERSION = 'B';
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  await page.waitForFunction(() => !window.__before, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  expect(!(await page.evaluate(() => window.__before)), 'page reloaded by itself after the update');
  const k = await keys();
  expect(k.includes('stock-ledger-test-B') && !k.includes('stock-ledger-test-A'), `now on version B, old copy removed (${k.join(', ')})`);

  // 2. New version while a form is open: no reload, a bar offers it
  await page.evaluate(() => { location.hash = '#/customers'; }); await page.waitForTimeout(500);
  await page.click('[data-act="newCustomer"]'); await page.waitForSelector('.modal');
  await page.fill('#f-name', 'Client en cours de saisie');
  await page.evaluate(() => { window.__before = true; });
  VERSION = 'C';
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  await page.waitForSelector('#updbar', { timeout: 30000 }).catch(() => {});
  expect(await page.evaluate(() => window.__before === true) && (await page.inputValue('#f-name')) === 'Client en cours de saisie', 'form left untouched: no reload while typing');
  expect(/Nouvelle version prête/.test((await page.textContent('#updbar').catch(() => '')) || ''), 'bar offers the new version');
  await page.screenshot({ path: path.join(outDir, 'update-bar.png') });
  await page.click('#updbar button'); await page.waitForTimeout(1500);
  expect(!(await page.evaluate(() => window.__before)) && (await keys()).includes('stock-ledger-test-C'), 'tapping Recharger opens version C');
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close(); srv.close();
  process.exit(failed || errors.length ? 1 : 0);
});

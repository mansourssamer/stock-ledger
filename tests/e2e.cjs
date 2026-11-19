// End-to-end check with a fake Firebase: imports a backup, verifies the report, visits the
// screens and saves screenshots.   node tests/e2e.cjs backup.zip outdir [--phone]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-shots', ...flags] = process.argv;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

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
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(base + '#/home');
  await page.waitForSelector('h1');
  await page.screenshot({ path: path.join(outDir, '00-empty.png') });

  if (zip) {
    await page.goto(base + '#/import');
    await page.waitForSelector('#imp-file');
    await page.setInputFiles('#imp-file', zip);
    await page.waitForSelector('#imp-ok', { timeout: 30000 });
    await page.screenshot({ path: path.join(outDir, '01-import-plan.png'), fullPage: true });
    await page.check('#imp-ok');
    await page.click('[data-act="impGo"]');
    await page.waitForSelector('.banner', { timeout: 120000 });
    await page.screenshot({ path: path.join(outDir, '02-import-done.png'), fullPage: true });
    const banner = await page.textContent('.banner');
    const diffs = await page.$$eval('.pill.bad', els => els.map(e => e.closest('tr').innerText.replace(/\s+/g, ' ')));
    console.log('IMPORT:', banner.trim().replace(/\s+/g, ' '));
    if (diffs.length) console.log('DIFFS:', diffs);
  }
  if (flags.includes('--perf')) {
    // A mid-range phone is roughly 4x slower than this machine.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(base + '#/home');
    const t0 = Date.now();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.tiles') || document.querySelector('.empty strong'));
    console.log('PERF cold open to dashboard (4x slower CPU):', Date.now() - t0, 'ms');
    console.log('PERF marks:', await page.evaluate(() => performance.getEntriesByType('mark').map(m => m.name + '=' + Math.round(m.startTime)).join('  ')));
    for (const s of ['stock', 'boxes', 'customers', 'orders', 'invoices', 'home']) {
      const ms = await page.evaluate(async h => {
        const a = performance.now();
        location.hash = '#/' + h;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise(r => setTimeout(r, 0));
        return Math.round(performance.now() - a);
      }, s);
      console.log(`PERF tap → ${s}: ${ms} ms`);
    }
    for (const [list] of [['customers'], ['orders'], ['stock']]) {
      await page.goto(base + '#/' + list); await page.waitForTimeout(200);
      const href = await page.$eval('tr[data-href]', el => el.dataset.href).catch(() => null);
      if (!href) continue;
      const ms = await page.evaluate(async h => { const a = performance.now(); location.hash = '#/' + h; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return Math.round(performance.now() - a); }, href);
      console.log(`PERF tap → ${href}: ${ms} ms`);
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  const shots = ['home', 'stock', 'boxes', 'customers', 'orders', 'invoices'];
  for (const s of shots) {
    await page.goto(base + '#/' + s);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(outDir, `10-${s}.png`), fullPage: true });
  }
  // A detail page of each kind (first row of each list).
  for (const [list, name] of [['stock', 'product'], ['boxes', 'mix'], ['customers', 'customer'], ['orders', 'order']]) {
    await page.goto(base + '#/' + list);
    await page.waitForTimeout(200);
    const href = await page.$eval('tr[data-href]', el => el.dataset.href).catch(() => null);
    if (!href) continue;
    await page.goto(base + '#/' + href);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `20-${name}.png`), fullPage: true });
  }
  // Reload: data must come back from the device copy.
  await page.reload();
  await page.waitForTimeout(800);
  const afterReload = await page.textContent('h1');
  console.log('AFTER RELOAD h1:', afterReload);
  console.log('FIRESTORE WRITES (fake):', await page.evaluate(() => window.__fake.writes));
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
  await browser.close();
  srv.close();
})().catch(e => { console.error(e); process.exit(1); });

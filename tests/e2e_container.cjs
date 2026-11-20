// A full container received in the browser, with the fake Firebase refusing anything the real
// one would (1 MiB and 40,000 index entries per document, 500 writes and 10 MiB per commit):
// 1,000 boxes in five mixes of six sizes, received in one go, then the page is reloaded and
// the boxes must all still be there, read back from the "server".
//    node tests/e2e_container.cjs backup.zip outdir [boxes per mix, default 200]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-container', perMix = '200'] = process.argv;
const PER = Number(perMix), TOTAL = PER * 5;
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
let failed = 0;
const expect = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(base + '#/import'); await page.waitForSelector('#imp-file');
  await page.setInputFiles('#imp-file', zip); await page.waitForSelector('#imp-ok', { timeout: 60000 });
  await page.check('#imp-ok'); await page.click('[data-act="impGo"]'); await page.waitForSelector('.banner', { timeout: 180000 });
  expect(/Imported and checked|Importé et vérifié/.test(await page.textContent('.banner')), 'backup imported');

  const r = await page.evaluate(async PER => {
    const store = await import('./js/store.js');
    const PO = await import('./js/ops/purchasing.js');
    const L = await import('./js/localdb.js');
    const before = L.val(`SELECT COUNT(*) FROM boxes`);
    const prod = L.val(`SELECT id FROM products ORDER BY id`);
    await store.change(() => PO.supplierNew({ name: 'Fournisseur Conteneur' }));
    const sup = L.val(`SELECT id FROM suppliers WHERE name = 'Fournisseur Conteneur'`);
    const po = await store.change(() => PO.poNew({ supplier_id: sup, currency_code: 'USD' }));
    for (const [i, color] of ['Noir C', 'Blanc C', 'Gris C', 'Bleu C', 'Rouge C'].entries()) {
      await store.change(() => PO.poTypeRun(po, { product_id: prod, color, box_label: 'Mix' + (i + 1), unit_cost: 40 + i, run: '39x2, 40x2, 41x2, 42x2, 43x2, 44x2' }));
      const g = L.val(`SELECT id FROM po_box_groups WHERE po_id = ? AND label = ?`, [po, 'Mix' + (i + 1)]);
      await store.change(() => PO.poSetBoxCount(po, g, { box_count: PER }));
    }
    const t0 = performance.now();
    await store.change(() => PO.poReceive(po));
    const ms = Math.round(performance.now() - t0);
    for (let i = 0; i < 600 && store.status().pending; i++) await new Promise(res => setTimeout(res, 100));
    const server = window.__fake.server();
    const count = name => Object.values(server[name] || {}).reduce((a, d) => a + Object.keys(d.rows || {}).length, 0);
    return { before, after: L.val(`SELECT COUNT(*) FROM boxes`), items: L.val(`SELECT COUNT(*) FROM box_items`), moves: L.val(`SELECT COUNT(*) FROM stock_moves`),
      serverBoxes: count('boxes'), serverItems: count('box_items'), serverMoves: count('stock_moves'), pending: store.status().pending,
      refused: window.__fake.refused || 0, largest: window.__fake.largest, mostEntries: window.__fake.mostEntries, ms,
      boxPages: Object.keys(server.boxes || {}).filter(k => k[0] === 'n').length, movePages: Object.keys(server.stock_moves || {}).filter(k => k[0] === 'n').length,
      saveFailed: !!window.__fakeSaveFailed };
  }, PER);
  console.log(JSON.stringify(r));
  expect(r.after - r.before === TOTAL, `${TOTAL} boxes received on this device (${r.after - r.before})`);
  expect(r.refused === 0, 'no write refused for Firestore limits');
  expect(r.pending === false, 'everything uploaded');
  expect(r.serverBoxes === r.after && r.serverItems === r.items && r.serverMoves === r.moves, `server holds the same rows: boxes ${r.serverBoxes}/${r.after}, box contents ${r.serverItems}/${r.items}, movements ${r.serverMoves}/${r.moves}`);
  expect(r.largest < 1048576 * 0.5 && r.mostEntries < 20000, `biggest document ${r.largest} bytes, ${r.mostEntries} index entries (half the limits at most)`);

  if (r.saveFailed) console.log('skip reload check: the test stand-in for Firebase keeps its copy in localStorage, which is full (real Firebase keeps it in IndexedDB); run with fewer boxes to check reloading');
  else {
    await page.reload(); await page.waitForTimeout(1500);
    const again = await page.evaluate(async () => { const L = await import('./js/localdb.js'); return [L.val(`SELECT COUNT(*) FROM boxes`), L.val(`SELECT COUNT(*) FROM stock_moves`), L.val(`SELECT COUNT(*) FROM box_items`)]; });
    expect(again[0] === r.after && again[1] === r.moves && again[2] === r.items, `after reloading, every box, movement and box content is back from the saved copy (${again.join(', ')})`);
  }
  await page.goto(base + '#/inventory'); await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'inventory-after-container.png') });

  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close(); srv.close();
  if (errors.length || failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

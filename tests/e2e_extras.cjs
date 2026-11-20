// The pieces added in the final check: the old app's CSV exports on each list page, voiding an
// invoice, and the open boxes (single pairs) page — clicked through in a browser.
//    node tests/e2e_extras.cjs backup.zip outdir [--phone]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-extras', ...flags] = process.argv;
const phone = flags.includes('--phone');
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
let failed = 0, n = 0;
const expect = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, ...(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } }) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const shot = name => page.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: true });
  await page.goto(base + '#/import'); await page.evaluate(() => localStorage.setItem('sl-lang', 'en')); await page.reload();
  await page.waitForSelector('#imp-file'); await page.setInputFiles('#imp-file', zip); await page.waitForSelector('#imp-ok', { timeout: 60000 });
  await page.check('#imp-ok'); await page.click('[data-act="impGo"]'); await page.waitForSelector('.banner', { timeout: 180000 });

  // CSV exports
  const want = {
    stock: ['products', 'product_name,brand,category,color,size,sku,qty_on_hand,cost_price,sale_price,reorder_level'],
    customers: ['customers', 'id,name,email,phone,address,discount_percent,created_at'],
    orders: ['orders', 'id,customer_name,status,order_total,created_at'],
    invoices: ['invoices', 'invoice_number,customer_name,order_id,due,paid,balance,status,issued_at'],
    suppliers: ['suppliers', 'id,name,email,phone,address,created_at'],
    purchasing: ['pos', 'id,supplier_name,status,currency_code,goods_total,goods_usd,landed_costs_usd,landed_total_usd,created_at']
  };
  for (const [screen, [k, head]] of Object.entries(want)) {
    await page.goto(base + '#/' + screen); await page.waitForTimeout(400);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click(`[data-act="csv"][data-k="${k}"]`)]);
    const file = path.join(outDir, dl.suggestedFilename()); await dl.saveAs(file);
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    expect(lines[0] === head && lines.length > 1, `${screen}: CSV ${dl.suggestedFilename()} — ${lines.length - 1} rows, old app's columns`);
  }
  const cid = await page.evaluate(async () => (await import('./js/localdb.js')).val(`SELECT o.customer_id FROM orders o JOIN invoices i ON i.order_id = o.id GROUP BY o.customer_id ORDER BY COUNT(*) DESC LIMIT 1`));
  await page.goto(base + '#/customer/' + cid); await page.waitForTimeout(400);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('[data-act="csv"][data-k="ledger"]')]);
  const led = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split('\r\n');
  expect(led[0] === 'date,type,reference,detail,currency,charge,payment,balance' && led.length > 1 && /^releve-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), `customer statement CSV ${dl.suggestedFilename()} — ${led.length - 1} lines`);

  // Void an invoice from the invoices list (one not paid), then re-check its status
  const inv = await page.evaluate(async () => {
    const Q = await import('./js/queries.js'); const L = await import('./js/localdb.js');
    for (const r of L.all(`SELECT id, order_id, invoice_number FROM invoices WHERE status != 'void' ORDER BY id`)) { const f = Q.invoiceFinancials(r.id); if (!['paid', 'void', 'unpriced'].includes(f.status)) return r; }
    return null;
  });
  if (inv) {
    await page.goto(base + '#/invoices'); await page.waitForTimeout(400);
    await page.click(`[data-act="voidInvoice"][data-id="${inv.id}"]`); await page.waitForSelector('.modal-f button[type=submit]');
    await shot('void-confirm');
    await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(600);
    const st = await page.evaluate(async id => (await import('./js/localdb.js')).val(`SELECT status FROM invoices WHERE id = ?`, [id]), inv.id);
    expect(st === 'void', `invoice ${inv.invoice_number} voided from the invoices list`);
    expect(!(await page.$(`[data-act="voidInvoice"][data-id="${inv.id}"]`)), 'its Void button is gone');
    await page.goto(base + '#/order/' + inv.order_id); await page.waitForTimeout(400);
    expect(!(await page.$(`[data-act="voidInvoice"][data-id="${inv.id}"]`)), 'order page shows no Void button for it');
  } else console.log('skip: no unpaid invoice in this backup');

  // Open boxes page
  await page.goto(base + '#/boxes'); await page.waitForTimeout(400);
  await page.click('a[href="#/openboxes"]'); await page.waitForTimeout(500);
  expect(/Open boxes — single pairs/.test(await page.textContent('main')), 'open boxes page from the inventory');
  await shot('open-boxes');
  const before = await page.evaluate(async () => (await import('./js/localdb.js')).val(`SELECT COUNT(*) FROM boxes WHERE status = 'open'`));
  await page.click('[data-act="openOnePick"]'); await page.waitForSelector('.modal-f button[type=submit]'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(600);
  const after = await page.evaluate(async () => (await import('./js/localdb.js')).val(`SELECT COUNT(*) FROM boxes WHERE status = 'open'`));
  expect(after === before + 1, `“Open one box” opened a box (${before} → ${after} open)`);
  const reseal = await page.$('main [data-act="reseal"]');
  expect(!!reseal, 'the box just opened can be sealed again from this page');
  if (reseal) { await reseal.click(); await page.waitForSelector('.modal-f button[type=submit]'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(600); }
  const after2 = await page.evaluate(async () => (await import('./js/localdb.js')).val(`SELECT COUNT(*) FROM boxes WHERE status = 'open'`));
  expect(after2 === before, `sealed again (${after2} open)`);
  await page.evaluate(() => localStorage.setItem('sl-lang', 'fr')); await page.reload(); await page.waitForTimeout(900);
  expect(/Cartons ouverts — paires au détail/.test(await page.textContent('main')), 'French open boxes page');
  await shot('open-boxes-fr');
  await page.goto(base + '#/invoices'); await page.waitForTimeout(500); await shot('invoices-fr');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(!overflow, 'no sideways scrolling on the invoices page');
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close(); srv.close();
  process.exit(failed || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

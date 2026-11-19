// Clicks through selling in the browser with a fake Firebase: new order, boxes, loose pairs,
// delivery, payment, return, printed invoice, customer and product forms, box actions.
//    node tests/e2e_sell.cjs backup.zip outdir [--phone]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-sell', ...flags] = process.argv;
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
  log('IMPORT:', (await page.textContent('.banner')).trim().replace(/\s+/g, ' ').slice(0, 60));

  // a new customer
  await page.goto(base + '#/customers'); await page.waitForTimeout(300);
  await page.click('[data-act="newCustomer"]');
  await page.fill('#f-name', 'Client Navigateur'); await page.fill('#f-phone', '620 00 00 00'); await page.fill('#f-credit_limit', '40 000 000');
  await shot('customer-form');
  await submit();
  log('customer page:', (await page.textContent('h1')).trim());

  // a new order for this customer
  await page.click('[data-act="newOrder"]');
  await page.selectOption('#f-currency_code', 'GNF');
  await submit();
  log('order page:', (await page.textContent('h1')).trim());
  await page.click('[data-act="addBoxes"]');
  await page.fill('#f-qty', '2'); await page.fill('#f-price_per_pair', '21 500');
  await shot('add-boxes');
  await submit(); log('toast:', await toast());
  // open a box so loose pairs can be sold, then add pairs
  await page.goto(base + '#/boxes'); await page.waitForTimeout(300);
  await page.click('tr[data-href]');
  await page.waitForTimeout(300);
  await page.click('[data-act="openOne"]'); await submit(); log('toast:', await toast());
  await page.goBack(); await page.goBack(); await page.waitForTimeout(300);
  await page.click('[data-act="addPairs"]');
  await page.fill('#f-qty', '2'); await page.fill('#f-price_per_pair', '27000');
  await submit(); log('toast:', await toast());
  await shot('order-open');
  // deliver (it's over nothing: credit limit 40M)
  await page.click('[data-act="deliver"]');
  const over = await page.$('#f-credit_ok'); if (over) await page.check('#f-credit_ok');
  await submit(); log('toast:', await toast());
  await shot('order-delivered');
  // a payment
  await page.click('[data-act="pay"]');
  await page.fill('#f-amount', '1 000 000');
  const opts = await page.$$eval('#f-account_id option', os => os.map(o => o.value));
  if (opts[1]) await page.selectOption('#f-account_id', opts[1]);
  await submit(); log('toast:', await toast());
  // a too-big payment must be refused inside the form
  await page.click('[data-act="pay"]');
  await page.fill('#f-amount', '999 999 999 999');
  await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(300);
  log('refusal shown:', (await page.textContent('.modal .errline').catch(() => 'NONE')).trim());
  await shot('payment-refused');
  await page.click('.modal-f [data-close]');
  // return one loose pair to stock
  await page.click('[data-act="retPairs"]');
  await page.fill('#f-qty', '1');
  await submit(); log('toast:', await toast());
  await shot('order-after-return');
  // printed invoice
  await page.click('a[href^="#/doc/invoice/"]'); await page.waitForTimeout(400);
  await shot('invoice-doc');
  log('invoice doc:', (await page.textContent('.doc h1')).trim());
  // statement
  await page.goBack(); await page.waitForTimeout(300);
  const custHref = await page.evaluate(() => location.hash);
  await page.goto(base + '#/customers'); await page.waitForTimeout(300);
  await page.click('tr[data-href]:has-text("Client Navigateur")'); await page.waitForTimeout(300);
  await page.click('a[href^="#/doc/statement/"]'); await page.waitForTimeout(300);
  await shot('statement-doc');
  void custHref;
  // a new style with a size
  await page.goto(base + '#/stock'); await page.waitForTimeout(300);
  await page.click('[data-act="newProduct"]');
  await page.fill('#f-name', 'Modèle navigateur'); await page.fill('#f-sku_prefix', 'NAV-1'); await page.fill('#f-sale_price', '14');
  await submit();
  await page.click('[data-act="addSize"]'); await page.fill('#f-color', 'Blanc'); await page.fill('#f-size', '41'); await page.fill('#f-initial_qty', '6');
  await submit(); log('toast:', await toast());
  await shot('product-new');
  // count the opened box
  await page.goto(base + '#/boxes'); await page.waitForTimeout(300);
  await page.click('tr[data-href]'); await page.waitForTimeout(300);
  const openRow = await page.$('tr[data-href]:has(.pill.accent)');
  if (openRow) {
    await openRow.click(); await page.waitForTimeout(300);
    await page.click('[data-act="countBox"]');
    const first = await page.$('.modal .form input');
    const lab = await page.textContent('.modal .form label');
    const left = Number((lab.match(/\((\d+)\)\s*$/) || [0, 1])[1]);
    await first.fill(String(Math.max(left - 1, 0)));
    await submit(); log('toast:', await toast());
    await shot('box-counted');
  }
  // everything survives a reload (comes back from the device copy)
  const writes = await page.evaluate(() => window.__fake.writes);
  await page.goto(base + '#/orders'); await page.reload(); await page.waitForTimeout(900);
  const rows = await page.$$eval('tr[data-href]', r => r.length);
  log('fake Firebase writes:', writes, '· orders listed after reload:', rows);
  await shot('orders-after-reload');
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

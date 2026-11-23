// One payment spread over open invoices through the form (customer 3 of the real backup), the
// single-invoice choice, a refusal, and the statement's one line per day — desktop and phone.
//    node tests/e2e_payspread.cjs backup.zip outdir
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(require.resolve('playwright', { paths: [ROOT] }));
const [, , zip, outDir] = process.argv;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png' };
const srv = http.createServer((req, resp) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  if (p === '/js/fb.js') p = '/tests/fake-fb.js';
  if (p === '/config.js') { resp.writeHead(200, { 'content-type': 'text/javascript' }); resp.end('export const firebaseConfig = {projectId: "test"};'); return; }
  const f = path.join(ROOT, p); if (!fs.existsSync(f)) { resp.writeHead(404); resp.end(); return; }
  resp.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(resp);
}).listen(0, async () => {
  const base = `http://localhost:${srv.address().port}/`;
  const b = await chromium.launch(); const out = {};
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'desktop';
    const page = await (await b.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1360, height: 900 } })).newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errs.push(m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.goto(base + '#/import'); await page.waitForSelector('#imp-file');
    await page.setInputFiles('#imp-file', zip); await page.waitForSelector('#imp-ok', { timeout: 60000 });
    await page.check('#imp-ok'); await page.click('[data-act="impGo"]'); await page.waitForSelector('.banner', { timeout: 180000 });
    const o = out[tag] = { errors: errs };
    const stmt = async () => page.evaluate(() => [...document.querySelectorAll('.doc tbody tr')].map(tr => [...tr.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')));
    await page.goto(base + '#/doc/statement/3'); await page.waitForTimeout(400);
    o.before = await stmt();
    await page.screenshot({ path: path.join(outDir, `statement-before-${tag}.png`), fullPage: true });
    await page.goto(base + '#/customer/3'); await page.waitForTimeout(400);
    await page.click('[data-act="payCustomer"]'); await page.waitForSelector('#f-invoice_id');
    o.options = await page.$$eval('#f-invoice_id option', os => os.map(x => `${x.value} = ${x.textContent}`));
    o.selected = await page.$eval('#f-invoice_id', s => s.value);
    o.hint = await page.$eval('.modal .hint', h => h.textContent).catch(() => null);
    await page.fill('#f-amount', '10 000 000');
    await page.selectOption('#f-account_id', { index: 2 }).catch(() => {});
    o.account = await page.$eval('#f-account_id', s => s.options[s.selectedIndex].textContent);
    await page.fill('#f-note', 'versement');
    await page.screenshot({ path: path.join(outDir, `form-${tag}.png`) });
    await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(500);
    o.err = await page.$eval('.errline', e => e.textContent).catch(() => null);
    o.toast = await page.textContent('#toast');
    await page.screenshot({ path: path.join(outDir, `after-${tag}.png`) });
    // too much is refused inside the form
    await page.click('[data-act="payCustomer"]'); await page.waitForSelector('#f-invoice_id');
    await page.fill('#f-amount', '99 000 000'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(400);
    o.refusal = await page.$eval('.errline', e => e.textContent).catch(() => null);
    await page.click('.modal-f [data-close]');
    // one invoice only still works
    await page.click('[data-act="payCustomer"]'); await page.waitForSelector('#f-invoice_id');
    const last = await page.$$eval('#f-invoice_id option', os => os[os.length - 1].value);
    await page.selectOption('#f-invoice_id', last); await page.fill('#f-amount', '1 000 000'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(500);
    o.toast2 = await page.textContent('#toast');
    await page.goto(base + '#/doc/statement/3'); await page.waitForTimeout(400);
    o.after = await stmt();
    await page.screenshot({ path: path.join(outDir, `statement-after-${tag}.png`), fullPage: true });
    o.uploads = await page.evaluate(async () => { const L = await import('./js/localdb.js'); return L.all(`SELECT invoice_id, amount, note, paid_at FROM invoice_payments WHERE typeof(id) = 'text'`); });
  }
  console.log(JSON.stringify(out, null, 1));
  await b.close(); srv.close();
});

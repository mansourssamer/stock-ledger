// Clicks through purchasing in the browser with a fake Firebase: supplier, purchase order,
// size runs, costs, payment, receiving, shipment, locations, size runs, price list, documents.
//    node tests/e2e_buy.cjs backup.zip outdir [--phone]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-buy', ...flags] = process.argv;
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


  const clickAct = async (act, extra = '') => { await page.click(`[data-act="${act}"]${extra}`); await page.waitForTimeout(200); };
  const visit = async (h, name) => { await page.goto(base + '#/' + h); await page.waitForTimeout(350); if (name) await shot(name); };
  // every purchasing screen opens
  for (const h of ['purchasing', 'shipments', 'suppliers', 'locations', 'sizeruns', 'pricelist']) await visit(h, h);
  await visit('purchasing'); await page.click('tr[data-href^="po/"] >> nth=-1'); await page.waitForTimeout(350); await shot('po-existing');
  log('existing PO:', (await page.textContent('h1')).trim());
  await visit('suppliers');
  await clickAct('newSupplier'); await page.fill('#f-name', 'Fournisseur Navigateur'); await page.fill('#f-phone', '+86 20 1234'); await submit(); log('toast:', await toast());
  await page.click('tr[data-href^="supplier/"]:has-text("Fournisseur Navigateur")'); await page.waitForTimeout(300);
  await clickAct('newPo'); await page.selectOption('#f-currency_code', 'CNY'); await page.fill('#f-notes', 'Commande test navigateur'); await submit();
  log('new PO page:', (await page.textContent('h1')).trim());
  await clickAct('typeRun');
  await page.fill('#f-color', 'Noir'); await page.fill('#f-run', '40x2, 41x3, 42x5, 43x2'); await page.fill('#f-unit_cost', '45');
  await shot('type-run'); await submit(); log('toast:', await toast());
  await clickAct('boxCount'); await page.fill('#f-box_count', '4'); await submit(); log('toast:', await toast());
  await clickAct('poAddItem'); await page.fill('#f-qty', '6'); await page.fill('#f-unit_cost', '50'); await submit(); log('toast:', await toast());
  await clickAct('saveRun'); await page.fill('#f-name', 'Série navigateur'); await submit(); log('toast:', await toast());
  await clickAct('applyRun'); await page.fill('#f-color', 'Blanc'); await submit(); log('toast:', await toast());
  await clickAct('newCost'); await page.fill('#f-description', 'Fret'); await page.fill('#f-amount', '1 200'); await submit(); log('toast:', await toast());
  await clickAct('newCost'); await page.fill('#f-description', 'Dédouanement'); await page.fill('#f-amount', '8 600 000'); await page.selectOption('#f-currency_code', 'GNF'); await page.check('#f-is_actual'); await submit(); log('toast:', await toast());
  await clickAct('payPo'); await page.selectOption('#f-paid_from', { index: 1 }); await page.waitForTimeout(150);
  await page.fill('#f-amount', '4 300 000'); await page.fill('#f-settled_amount', '480'); await page.selectOption('#f-settled_currency', 'USD'); await shot('pay-supplier'); await submit(); log('toast:', await toast());
  await shot('po-filled');
  // receive one mix, then everything
  await page.click('[data-act="receiveMix"] >> nth=0'); await page.waitForTimeout(200); await submit(); log('toast:', await toast());
  await clickAct('receivePo'); await submit(); log('toast:', await toast());
  await shot('po-received');
  await page.click('[data-act="unreceive"] >> nth=-1'); await page.waitForTimeout(200); await submit(); log('toast:', await toast());
  await page.click('[data-act="delMix"] >> nth=-1'); await page.waitForTimeout(200); await submit(); log('toast:', await toast());
  const poUrl = page.url();
  // a document (small text file)
  fs.writeFileSync(path.join(outDir, 'facture.txt'), 'Facture fournisseur test');
  await clickAct('uploadDoc'); await page.setInputFiles('#f-file', path.join(outDir, 'facture.txt')); await submit(); log('toast:', await toast());
  log('documents:', await page.$$eval('[data-act="openDoc"]', x => x.length));
  // shipment carrying a new PO's mix
  await visit('shipments'); await clickAct('newShipment'); await page.fill('#f-reference', 'CONT-NAV-1'); await page.fill('#f-container_no', 'MSCU7654321'); await submit();
  log('shipment page:', (await page.textContent('h1')).trim());
  const shipUrl = page.url();
  await visit('purchasing'); await clickAct('newPo'); await submit();
  await clickAct('typeRun'); await page.fill('#f-color', 'Rouge'); await page.fill('#f-run', '40x6, 41x6'); await page.fill('#f-unit_cost', '7.5'); await submit();
  await page.goto(shipUrl); await page.waitForTimeout(300);
  await clickAct('assignMix'); await submit(); log('toast:', await toast());
  await clickAct('stageShipment'); await page.selectOption('#f-status', 'shipped'); await submit(); log('toast:', await toast());
  await shot('shipment');
  await clickAct('receiveShipment'); await submit(); log('toast:', await toast());
  await shot('shipment-received');
  // locations
  await visit('locations'); await clickAct('newLocation'); await page.fill('#f-name', 'Dépôt navigateur'); await submit(); log('toast:', await toast());
  await page.click('tr[data-href^="location/"]'); await page.waitForTimeout(300); await shot('location');
  const mv = await page.$('[data-act="moveBoxes"]');
  if (mv) { await mv.click(); await page.waitForTimeout(200); await page.fill('#f-qty', '1'); await submit(); log('toast:', await toast()); }
  // size runs
  await visit('sizeruns'); await clickAct('newRun'); await page.fill('#f-name', 'Hommes 40-46'); await page.fill('#f-run', '40x2, 41x3, 42x5, 43x5, 44x4, 45x3, 46x2'); await submit(); log('toast:', await toast());
  await page.click('[data-act="addRunLine"] >> nth=-1'); await page.waitForTimeout(200); await page.fill('#f-size', '47'); await submit(); log('toast:', await toast());
  await shot('sizeruns-after');
  // price list
  await visit('pricelist');
  await page.click('[data-act="setPrice"][data-min="1"] >> nth=0'); await page.waitForTimeout(200); await page.fill('#f-price_per_pair', '26 000'); await submit(); log('toast:', await toast());
  await page.click('[data-act="setPrice"]:not([data-min]) >> nth=0'); await page.waitForTimeout(200); await page.fill('#f-min_boxes', '5'); await page.fill('#f-price_per_pair', '24 000'); await submit(); log('toast:', await toast());
  await shot('pricelist-after');
  await visit('doc/pricelist/all', 'pricelist-print');
  // buying plan, events, missed sales
  await visit('buying', 'buying-plan');
  log('plan rows:', await page.$$eval('[data-act="planWhy"]', x => x.length));
  await page.click('[data-act="planWhy"] >> nth=0'); await page.waitForTimeout(250); await shot('buying-why');
  await clickAct('planSettings'); await page.fill('#f-buy_lead_weeks', '12'); await page.check('#f-buy_fill'); await submit(); log('toast:', await toast());
  await clickAct('planSettings'); await page.fill('#f-buy_lead_weeks', '0'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(300);
  log('refused settings:', (await page.textContent('.modal .errline').catch(() => '')).trim()); await page.click('.modal-f [data-close]');
  await clickAct('missedNew'); await page.selectOption('#f-model_key', { index: 1 }); await page.fill('#f-boxes', '3'); await submit(); log('toast:', await toast());
  await clickAct('missedNew'); await page.fill('#f-description', 'Jordan 4 noir'); await page.fill('#f-boxes', '5'); await submit(); log('toast:', await toast());
  await visit('events'); await clickAct('eventsGuinea'); await submit(); log('toast:', await toast());
  await clickAct('eventNew'); await page.fill('#f-name', 'Promo test'); await page.fill('#f-start_date', '2027-03-01'); await page.fill('#f-end_date', '2027-03-10'); await page.fill('#f-boost_percent', '25'); await submit(); log('toast:', await toast());
  await shot('events');
  await visit('missed', 'missed');
  await visit('buying', 'buying-after');
  // a refusal stays in the form
  await page.goto(poUrl); await page.waitForTimeout(300);
  await clickAct('delPo'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(400);
  log('delete PO:', (await page.textContent('.modal .errline').catch(() => '')) || (await toast()));
  // switch to English and back
  log('page errors:', errors.length ? errors : 'none');
  await browser.close(); srv.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

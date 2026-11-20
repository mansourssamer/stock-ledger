// Clicks through the CRM, proformas and settings in the browser with a fake Firebase, then
// downloads a backup and imports it into a fresh app to check nothing is lost.
//    node tests/e2e_crm.cjs backup.zip outdir [--phone]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-crm', ...flags] = process.argv;
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
  const visit = async (h, name) => { await page.goto(base + '#/' + h); await page.waitForTimeout(500); if (name) await shot(name); };
  for (const h of ['crm', 'crmcontacts', 'crmcustomers', 'announce', 'crmreport', 'zones', 'proformas', 'settings']) { await visit(h, h); log(h, '→', (await page.textContent('h1')).trim()); }
  // a prospect, followed to a first order with a proforma
  await visit('crm'); await clickAct('crmNew'); await page.fill('#f-name', 'Prospect navigateur'); await page.selectOption('#f-zone_id', { index: 1 }); await page.fill('#f-phone', '620 12 34 56'); await submit();
  log('contact page:', (await page.textContent('h1')).trim());
  await clickAct('crmActivity'); await page.fill('#f-note', 'Appelé, intéressé'); await page.fill('#f-next_follow_up', '2026-12-01'); await submit(); log('toast:', await toast());
  await clickAct('crmStage'); await page.selectOption('#f-stage', 'samples'); await submit(); log('toast:', await toast());
  await shot('contact');
  await clickAct('crmMakeCustomer'); await submit(); await page.waitForTimeout(600); log('now on:', (await page.textContent('h1')).trim(), page.url().split('#')[1]); await shot('after-make-customer');
  await clickAct('newOrder'); await page.selectOption('#f-currency_code', 'GNF'); await submit();
  await clickAct('addBoxes'); await page.fill('#f-qty', '1'); await page.fill('#f-price_per_pair', '21 500'); await submit(); log('toast:', await toast());
  await clickAct('pfNew'); await page.fill('#f-terms', 'Paiement à la commande'); await submit(); log('toast:', await toast());
  await shot('order-proforma');
  await page.click('a[href^="#/doc/proforma/"]'); await page.waitForTimeout(400); await shot('proforma-print'); log('proforma doc:', (await page.textContent('.doc h1')).trim());
  await page.goBack(); await page.waitForTimeout(300);
  await clickAct('pfVoid'); await submit(); log('toast:', await toast());
  // announce, report, zones
  await visit('announce'); await page.selectOption('select[data-ann="product_id"]', { index: 1 }); await page.waitForTimeout(300); log('announce rows:', await page.$$eval('[data-act="annSent"]', x => x.length)); await shot('announce-filled');
  await visit('zones'); await clickAct('zoneNew'); await page.fill('#f-name', 'Marché navigateur'); await page.fill('#f-area', 'Conakry'); await submit(); log('toast:', await toast());
  await page.click('[data-act="zoneToggle"] >> nth=0'); await page.waitForTimeout(300); log('toast:', await toast());
  await visit('crmcustomers'); await page.click('[data-act="crmGroup"][data-v="regular"]').catch(() => {}); await page.waitForTimeout(200); await shot('customers-regular');
  await visit('home', 'home-followups');
  // backup, then import it into a fresh app
  await visit('settings');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-act="backupNow"]')]);
  const file = path.join(outDir, await dl.suggestedFilename()); await dl.saveAs(file); await page.waitForTimeout(500);
  log('backup:', path.basename(file), fs.statSync(file).size, 'bytes'); await shot('settings-after');
  const ctx2 = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true } : { viewport: { width: 1360, height: 900 } });
  const p2 = await ctx2.newPage(); p2.on('pageerror', e => errors.push('pageerror(2): ' + e.message));
  await p2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await p2.goto(base + '?fresh=1#/import'); await p2.evaluate(() => { try { indexedDB.deleteDatabase('fake-fb'); localStorage.clear(); } catch { /* */ } });
  await p2.goto(base + '?fresh=2#/import'); await p2.waitForSelector('#imp-file');
  await p2.setInputFiles('#imp-file', file); await p2.waitForSelector('#imp-ok', { timeout: 30000 }); await p2.check('#imp-ok'); await p2.click('[data-act="impGo"]');
  await p2.waitForSelector('.banner', { timeout: 120000 }); log('re-import:', (await p2.textContent('.banner')).trim().replace(/\s+/g, ' ').slice(0, 90));
  await p2.goto(base + '?fresh=2#/crmcontacts'); await p2.waitForTimeout(800);
  log('contact found after re-import:', (await p2.$('text=Prospect navigateur')) ? 'yes' : 'NO');
  await p2.goto(base + '?fresh=2#/proformas'); await p2.waitForTimeout(600); log('proformas after re-import:', await p2.$$eval('a[href^="#/doc/proforma/"]', x => x.length));
  log('page errors:', errors.length ? errors : 'none');
  await browser.close(); srv.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

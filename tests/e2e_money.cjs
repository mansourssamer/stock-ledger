// Clicks through money and reports in the browser with a fake Firebase: accounts, transfers,
// expenses, partners, currencies and rates, and every report page.
//    node tests/e2e_money.cjs backup.zip outdir [--phone]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-money', ...flags] = process.argv;
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
  const visit = async (h, name) => { await page.goto(base + '#/' + h); await page.waitForTimeout(400); if (name) await shot(name); };
  for (const h of ['money', 'expenses', 'partners', 'currencies', 'reports', 'daily', 'sales', 'monthly', 'pnl', 'cashflow', 'costing', 'balance']) {
    await visit(h, h); log(h, '→', (await page.textContent('h1')).trim());
  }
  // accounts
  await visit('money'); await clickAct('newAccount'); await page.fill('#f-name', 'Caisse navigateur'); await page.selectOption('#f-currency_code', 'GNF'); await page.fill('#f-opening_balance', '2 000 000'); await submit(); log('toast:', await toast());
  await page.click('tr[data-href^="account/"]:has-text("Caisse navigateur")'); await page.waitForTimeout(300);
  await clickAct('adjustAccount'); await page.fill('#f-amount', '-50 000'); await submit(); log('toast:', await toast());
  await clickAct('transfer'); await page.selectOption('#f-to_account_id', { label: 'Samar USD (USD)' }); await page.waitForTimeout(150);
  await page.fill('#f-amount', '860 000'); await page.fill('#f-received_amount', '95'); await shot('transfer'); await submit(); log('toast:', await toast());
  await shot('account');
  // expenses
  await visit('expenses'); await clickAct('newExpense'); await page.fill('#f-category', 'Transport'); await page.fill('#f-amount', '150 000'); await page.selectOption('#f-currency_code', 'GNF');
  await page.selectOption('#f-paid_from', { label: 'Caisse navigateur (GNF)' }); await submit(); log('toast:', await toast());
  await clickAct('newExpense'); await page.fill('#f-category', 'Divers'); await page.fill('#f-amount', '20'); await page.selectOption('#f-currency_code', 'USD'); await page.selectOption('#f-paid_from', { index: 1 }); await submit(); log('toast:', await toast());
  await page.click('[data-act="editExpense"] >> nth=0'); await page.waitForTimeout(200); await page.fill('#f-amount', '25'); await submit(); log('toast:', await toast());
  await shot('expenses-after');
  // partners
  await visit('partners'); await clickAct('newPartner'); await page.fill('#f-name', 'Associé navigateur'); await submit(); log('partner page:', (await page.textContent('h1')).trim());
  await clickAct('partnerLoan'); await page.selectOption('#f-account_id', { label: 'Caisse navigateur (GNF)' }); await page.fill('#f-amount', '5 000 000'); await submit(); log('toast:', await toast());
  await clickAct('partnerRepay'); await page.selectOption('#f-account_id', { label: 'Caisse navigateur (GNF)' }); await page.fill('#f-amount', '1 000 000'); await page.fill('#f-settled_amount', '110'); await page.selectOption('#f-settled_currency', 'USD'); await submit(); log('toast:', await toast());
  await clickAct('partnerRepay'); await page.selectOption('#f-account_id', { index: 0 }); await page.fill('#f-amount', '999999999'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(300);
  log('refused repay:', (await page.textContent('.modal .errline').catch(() => '')).trim()); await page.click('.modal-f [data-close]');
  await shot('partner');
  await visit('partners'); await clickAct('distribute'); await page.selectOption('#f-account_id', { label: 'Samar USD (USD)' }); await page.fill('#f-total_amount', '100'); await page.check('#f-override'); await submit(); log('toast:', await toast());
  const dist = await page.$('[data-act="delDistribution"]'); if (dist) { await dist.click(); await page.waitForTimeout(200); await submit(); log('toast:', await toast()); }
  // currencies
  await visit('currencies'); await clickAct('newRate'); await page.selectOption('#f-currency_code', 'GNF'); await page.fill('#f-rate', '8 700'); await submit(); log('toast:', await toast());
  await page.click('[data-act="editRate"] >> nth=0'); await page.waitForTimeout(200); await page.fill('#f-rate', '8 680'); await shot('rate-edit'); await submit(); log('toast:', await toast());
  await clickAct('newCurrency'); await page.fill('#f-code', 'aed'); await page.fill('#f-name', 'Dirham'); await submit(); log('toast:', await toast());
  // reports
  await visit('reports/all', 'overview-all'); await visit('reports/7');
  await visit('pnl/all', 'pnl-all');
  await page.fill('form[data-range] input[name=s]', '2026-10-01'); await page.click('form[data-range] button'); await page.waitForTimeout(400); log('pnl custom url:', page.url().split('#')[1]);
  await visit('cashflow/all', 'cashflow-all'); await visit('costing/all', 'costing-all'); await visit('balance', 'balance');
  await visit('daily'); await page.click('a:has-text("‹")'); await page.waitForTimeout(300); await shot('daily-prev');
  await clickAct('copyText').catch(() => {});
  await visit('sales/all'); await page.click('a.chip:has-text("semaine")').catch(() => {}); await page.waitForTimeout(300); await shot('sales-all');
  await visit('sales/last_month', 'sales-last-month'); await visit('monthly'); await page.click('a.btn:has-text("‹")'); await page.waitForTimeout(300); await shot('monthly-prev');
  log('page errors:', errors.length ? errors : 'none');
  await browser.close(); srv.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

// Signing in: setting a password for the phone in Settings, signing in with it, a Google popup
// that fails (as in an app added to an iPhone's home screen), "Forgot password?", and a password
// account whose email isn't confirmed yet.
//    node tests/e2e_auth.cjs outdir
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const [, , outDir = '/tmp/sl-auth'] = process.argv;
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
  for (const phone of [false, true]) {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    const tag = phone ? '[phone] ' : '';
    const shot = name => page.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-${phone ? 'phone-' : ''}${name}.png`), fullPage: true });
    const text = async sel => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    await page.goto(base + '#/settings'); await page.evaluate(() => { localStorage.setItem('sl-lang', 'en'); }); await page.reload(); await page.waitForTimeout(800);

    // 1. Settings: set a password (too short, different, then right)
    expect(/Not set yet/.test(await text('main')), tag + 'settings: password not set yet');
    await page.click('[data-act="pwSet"]'); await page.waitForSelector('#f-pw');
    await page.fill('#f-pw', 'short'); await page.fill('#f-pw2', 'short'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(300);
    expect(/at least 8/.test(await text('.modal .errline')), tag + 'too short refused');
    await page.fill('#f-pw', 'Conakry2026!'); await page.fill('#f-pw2', 'Conakry2026?'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(300);
    expect(/different/.test(await text('.modal .errline')), tag + 'different passwords refused');
    await page.fill('#f-pw2', 'Conakry2026!'); await page.click('.modal-f button[type=submit]'); await page.waitForTimeout(500);
    expect(!(await page.$('.modal #f-pw')), tag + 'form closed after saving');
    expect(/Set/.test(await text('main .kv')) && /Change the password/.test(await text('main')), tag + 'settings now shows the password is set');
    await shot('settings-password-set');

    // 2. Sign out, Google popup fails, sign in with email and password
    await page.click('main [data-act="signOut"]'); await page.waitForSelector('.gate', { timeout: 10000 });
    await page.evaluate(() => { window.__fakePopupError = 'auth/popup-closed-by-user'; });
    await page.click('[data-act="google"]'); await page.waitForTimeout(300);
    expect(/Google sign-in didn’t finish/.test(await text('.gate')), tag + 'failed Google popup explains the email and password way');
    await shot('google-failed');
    await page.fill('#g-email', 'owner@example.com'); await page.fill('#g-pass', 'wrong-password'); await page.click('#gate-form button[type=submit]'); await page.waitForTimeout(300);
    expect(/Wrong email or password/.test(await text('.gate')), tag + 'wrong password refused');
    await page.fill('#g-pass', 'Conakry2026!'); await page.click('#gate-form button[type=submit]');
    await page.waitForSelector('.gate', { state: 'detached', timeout: 10000 }).catch(() => {});
    expect(!(await page.$('.gate')), tag + 'signed in with email and password');

    // 3. Forgot password
    await page.goto(base + '#/settings'); await page.waitForTimeout(400);
    await page.click('main [data-act="signOut"]'); await page.waitForSelector('.gate', { timeout: 10000 });
    await page.fill('#g-email', ''); await page.click('[data-act="forgot"]'); await page.waitForTimeout(200);
    expect(/Type your email/.test(await text('.gate')), tag + 'forgot password without an email asks for it');
    await page.fill('#g-email', 'owner@example.com'); await page.click('[data-act="forgot"]'); await page.waitForTimeout(300);
    const resets = await page.evaluate(() => window.__fake.resetsSent || []);
    expect(/a link to choose a password is on its way/.test(await text('.gate')) && resets.includes('owner@example.com'), tag + 'forgot password sends the link');
    await shot('forgot');

    // 4. A password account whose email isn't confirmed
    await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('fakeauth-v1') || '{}'); p['new@example.com'] = { pw: 'Matam2026!x', verified: false, providers: ['password'] }; localStorage.setItem('fakeauth-v1', JSON.stringify(p)); });
    await page.reload(); await page.waitForSelector('#g-email');
    await page.fill('#g-email', 'new@example.com'); await page.fill('#g-pass', 'Matam2026!x'); await page.click('#gate-form button[type=submit]'); await page.waitForTimeout(400);
    expect(/Confirm your email/.test(await text('.gate')), tag + 'unconfirmed email: asked to confirm it, data not opened');
    await page.click('[data-act="verifyDone"]'); await page.waitForTimeout(300);
    expect(/Not confirmed yet/.test(await text('.gate')), tag + '“I’ve confirmed it” before opening the link says so');
    await page.click('[data-act="verifySend"]'); await page.waitForTimeout(300);
    expect(/Link sent/.test(await text('.gate')) && await page.evaluate(() => window.__fake.verificationsSent) >= 1, tag + 'confirmation link sent');
    await shot('confirm-email');
    await page.evaluate(() => window.__fake.confirmEmail());
    await page.click('[data-act="verifyDone"]');
    await page.waitForSelector('.gate', { state: 'detached', timeout: 10000 }).catch(() => {});
    expect(!(await page.$('.gate')), tag + 'after confirming, the app opens');

    // 5. French
    await page.evaluate(() => { localStorage.setItem('sl-lang', 'fr'); localStorage.setItem('fakeauth-out', '1'); }); await page.reload(); await page.waitForSelector('#g-email');
    expect(/Mot de passe oublié/.test(await text('.gate')), tag + 'French sign-in screen');
    await shot('fr-gate');
    console.log(tag + 'page errors:', errors.length ? errors : 'none');
    if (errors.length) failed++;
    await ctx.close();
  }
  await browser.close(); srv.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

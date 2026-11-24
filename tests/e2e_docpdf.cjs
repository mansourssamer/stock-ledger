// Send / Download PDF on the customer documents (statement, invoice, proforma, price list) on the
// real backup, desktop and phone: each gives a PDF file.   node tests/e2e_docpdf.cjs backup.zip outdir
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
    const page = await (await b.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2, acceptDownloads: true } : { viewport: { width: 1360, height: 900 }, acceptDownloads: true })).newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errs.push(m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.goto(base + '#/import'); await page.waitForSelector('#imp-file');
    await page.setInputFiles('#imp-file', zip); await page.waitForSelector('#imp-ok', { timeout: 60000 });
    await page.check('#imp-ok'); await page.click('[data-act="impGo"]'); await page.waitForSelector('.banner', { timeout: 180000 });
    out[tag] = { errors: errs, files: [] };
    for (const [doc, name] of [['statement/3', 'statement'], ['invoice/27', 'invoice'], ['proforma/1', 'proforma'], ['pricelist/x', 'pricelist'], ['statement/1', 'statement1']]) {
      await page.goto(base + '#/doc/' + doc); await page.waitForTimeout(900);
      if (tag === 'phone') await page.screenshot({ path: path.join(outDir, `bar-${name}-${tag}.png`) });
      for (const act of ['docPdfSave', 'docPdfSend']) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click(`[data-act="${act}"]`)]);
        if (!dl) { out[tag].files.push(`${name} ${act}: NO DOWNLOAD`); continue; }
        const f = path.join(outDir, `${tag}-${name}-${act}-${dl.suggestedFilename()}`);
        await dl.saveAs(f); out[tag].files.push(`${name} ${act}: ${dl.suggestedFilename()} ${fs.statSync(f).size} bytes`);
      }
    }
  }
  console.log(JSON.stringify(out, null, 1));
  await b.close(); srv.close();
});

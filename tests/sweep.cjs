// Opens every screen (lists and a sample of detail pages) in French and English, on a computer
// and a phone, with the real backup imported, and reports: page errors, "undefined"/"NaN" in
// the page, sideways scrolling on the phone, text hidden by the layout, and texts with no French.
//    node tests/sweep.cjs backup.zip outdir [--empty | --new-records]
// --new-records first makes records in the app itself (a purchase order received, a customer, an
// order delivered and paid, a proforma, an expense…), whose ids are text, and checks no raw id shows.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const [, , zip, outDir = '/tmp/sl-sweep', ...flags] = process.argv;
const EMPTY = flags.includes('--empty'), NEWREC = flags.includes('--new-records');
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
const LISTS = ['home', 'stock', 'boxes', 'openboxes', 'customers', 'orders', 'invoices', 'purchasing', 'suppliers', 'shipments', 'locations', 'unplaced', 'sizeruns',
  'pricelist', 'buying', 'events', 'missed', 'money', 'expenses', 'partners', 'currencies', 'reports', 'pnl', 'cashflow', 'costing', 'balance', 'daily', 'sales', 'monthly',
  'crm', 'crmcontacts', 'crmcustomers', 'announce', 'crmreport', 'zones', 'proformas', 'settings', 'import', 'doc/pricelist'];
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch();
  const report = { routes: 0, problems: [], frMissing: new Set() };
  for (const phone of [false, true]) {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    let errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|favicon/.test(m.text())) errors.push('console: ' + m.text()); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.goto(base + '#/import'); await page.waitForTimeout(500);
    if (!EMPTY) {
      await page.waitForSelector('#imp-file'); await page.setInputFiles('#imp-file', zip); await page.waitForSelector('#imp-ok', { timeout: 60000 });
      await page.check('#imp-ok'); await page.click('[data-act="impGo"]'); await page.waitForSelector('.banner', { timeout: 180000 });
    }
    if (EMPTY) await page.evaluate(() => window.__fake.reset());
    if (NEWREC) {
      const made = await page.evaluate(async () => {
        const store = await import('./js/store.js'); const L = await import('./js/localdb.js');
        const P = await import('./js/ops/purchasing.js'); const S = await import('./js/ops/sales.js'); const K = await import('./js/ops/stock.js');
        const F = await import('./js/ops/finance.js'); const C = await import('./js/ops/crm.js');
        const ch = fn => store.change(fn);
        await ch(() => P.supplierNew({ name: 'Fournisseur Nouveau' }));
        const sup = L.val(`SELECT id FROM suppliers WHERE name = 'Fournisseur Nouveau'`);
        const po = await ch(() => P.poNew({ supplier_id: sup, currency_code: 'USD', notes: 'Nouveau' }));
        const prod = L.val(`SELECT id FROM products ORDER BY id`);
        await ch(() => P.poTypeRun(po, { product_id: prod, color: 'Vert N', box_label: 'MixN', unit_cost: 30, run: '40x3, 41x3, 42x3, 43x3' }));
        const g = L.val(`SELECT id FROM po_box_groups WHERE po_id = ? AND label = 'MixN'`, [po]);
        await ch(() => P.poSetBoxCount(po, g, { box_count: 6 }));
        await ch(() => P.poCostNew(po, { description: 'Fret', amount: 300, currency_code: 'USD', is_actual: 0 }));
        await ch(() => P.shipmentNew({ reference: 'CONT-NOUVEAU', container_no: 'MSCU7777777' }));
        const sh = L.val(`SELECT id FROM shipments WHERE reference = 'CONT-NOUVEAU'`);
        await ch(() => P.shipmentAssign(sh, g));
        await ch(() => P.locationNew({ name: 'Dépôt nouveau', kind: 'warehouse', notes: '' }));
        await ch(() => P.poReceive(po));
        const cust = await ch(() => K.customerNew({ name: 'Client Nouveau', phone: '+224 600 00 00 01', discount_percent: 0, credit_limit: '', credit_currency: 'GNF' }));
        const o = await ch(() => S.orderNew({ customer_id: cust, currency_code: 'GNF', notes: 'Commande nouvelle' }));
        await ch(() => S.orderAttachBoxes(o, { po_id: po, label: 'MixN', qty: 2, price_per_box: 2500000 }));
        await ch(() => K.boxOpenOne(po, 'MixN'));
        const v = L.val(`SELECT variant_id FROM box_items bi JOIN boxes b ON b.id = bi.box_id WHERE b.status = 'open' AND b.source_po_id = ? LIMIT 1`, [po]);
        await ch(() => S.orderAddItem(o, { variant_id: v, qty: 2, price_per_pair: 60000 }));
        await ch(() => C.crmReady());
        await ch(() => C.proformaCreate(o, { terms: 'Paiement à la commande' }));
        await ch(() => S.orderFulfill(o, { credit_ok: 1 }));
        const inv = L.val(`SELECT id FROM invoices WHERE order_id = ? AND status != 'void'`, [o]);
        await ch(() => S.invoicePay(inv, { amount: 1000000, account_id: '', note: 'Avance' }));
        await ch(() => F.expenseNew({ category: 'Transport', description: 'Camion', amount: 40, currency_code: 'USD' }));
        await ch(() => F.accountNew({ name: 'Caisse nouvelle', account_type: 'cash', currency_code: 'USD', opening_balance: 100 }));
        await ch(() => F.partnerNew({ name: 'Associé nouveau', ownership_percent: 0 }));
        const z = L.val(`SELECT id FROM crm_zones ORDER BY id`);
        await ch(() => C.contactNew({ name: 'Prospect nouveau', kind: 'retailer', zone_id: z, phone: '620 00 00 00', stage: 'contacted' }));
        return { po, o, cust, texts: L.val(`SELECT COUNT(*) FROM orders WHERE typeof(id) = 'text'`) };
      });
      console.log('records made in the app:', JSON.stringify(made));
    }
    const details = EMPTY ? [] : await page.evaluate(async () => {
      const L = await import('./js/localdb.js');
      const ids = (sql) => L.all(sql).map(r => Object.values(r)[0]);
      const out = [];
      for (const id of ids(`SELECT id FROM products ORDER BY id LIMIT 2`).concat(ids(`SELECT id FROM products ORDER BY id DESC LIMIT 1`))) out.push('product/' + id);
      for (const id of ids(`SELECT id FROM customers ORDER BY id`)) out.push('customer/' + id, 'doc/statement/' + id);
      for (const id of ids(`SELECT id FROM orders ORDER BY id`)) out.push('order/' + id);
      for (const id of ids(`SELECT id FROM invoices ORDER BY id LIMIT 3`).concat(ids(`SELECT id FROM invoices ORDER BY id DESC LIMIT 2`))) out.push('doc/invoice/' + id);
      for (const id of ids(`SELECT id FROM proformas ORDER BY id`)) out.push('doc/proforma/' + id);
      for (const id of ids(`SELECT id FROM boxes WHERE status = 'open' LIMIT 1`).concat(ids(`SELECT id FROM boxes WHERE status = 'sold' LIMIT 1`), ids(`SELECT id FROM boxes WHERE status = 'in_stock' LIMIT 1`))) out.push('box/' + id);
      for (const r of L.all(`SELECT DISTINCT source_po_id as p, source_label as l FROM boxes LIMIT 4`)) out.push(`mix/${r.p ?? 'none'}/${encodeURIComponent(r.l || '')}`);
      for (const id of ids(`SELECT id FROM purchase_orders`)) out.push('po/' + id);
      for (const id of ids(`SELECT id FROM suppliers`)) out.push('supplier/' + id);
      for (const id of ids(`SELECT id FROM shipments`)) out.push('shipment/' + id);
      for (const id of ids(`SELECT id FROM locations`)) out.push('location/' + id);
      for (const id of ids(`SELECT id FROM cash_accounts`)) out.push('account/' + id);
      for (const id of ids(`SELECT id FROM partners`)) out.push('partner/' + id);
      for (const id of ids(`SELECT id FROM crm_contacts ORDER BY id LIMIT 6`)) out.push('crmcontact/' + id);
      return out;
    });
    for (const lang of ['fr', 'en']) {
      await page.evaluate(l => { localStorage.setItem('sl-lang', l); }, lang); await page.reload(); await page.waitForTimeout(900);
      if (lang === 'fr') await page.evaluate(() => { globalThis.__frMissing = new Set(); });
      for (const r of [...LISTS, ...details]) {
        errors = [];
        await page.evaluate(h => { location.hash = '#/' + h; }, r);
        await page.waitForTimeout(r.startsWith('doc/') || r === 'buying' ? 500 : 180);
        const c = await page.evaluate(phone => {
          const main = document.querySelector('main') || document.body;
          const text = main.innerText || '';
          const bad = (text.match(/\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date|\bnull\b|Infinity|\bn20\d{6}[a-z]{2}\d+/g) || []);
          const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
          const hidden = [];
          for (const el of main.querySelectorAll('*')) {
            if (!el.textContent.trim() || el.closest('[hidden],.hide-sm,.noprint,.modal,.print-only,.mtop,option,select,template,script,style')) continue;
            if (getComputedStyle(el).display === 'none') hidden.push((el.className || el.tagName) + ': ' + el.textContent.trim().slice(0, 50));
          }
          const wide = [];
          if (phone) for (const el of main.querySelectorAll('*')) {
            if (el.closest('.scroll,.subnav,.chips,pre')) continue;
            const b = el.getBoundingClientRect();
            if (b.right > window.innerWidth + 2 && b.width > 0) wide.push((el.className || el.tagName) + ' ' + Math.round(b.right));
          }
          return { bad, overflow, hidden: hidden.slice(0, 5), wide: wide.slice(0, 3) };
        }, phone);
        report.routes++; report.byCtx = report.byCtx || {}; report.byCtx[(phone ? 'phone' : 'desktop') + ' ' + lang] = (report.byCtx[(phone ? 'phone' : 'desktop') + ' ' + lang] || 0) + 1;
        const tag = `${phone ? 'phone' : 'desktop'} ${lang} #/${r}`;
        if (errors.length) report.problems.push(`${tag}: ${errors.join(' | ')}`);
        if (c.bad.length) report.problems.push(`${tag}: shows ${[...new Set(c.bad)].join(', ')}`);
        if (c.overflow) report.problems.push(`${tag}: page scrolls sideways ${c.wide.join(', ')}`);
        if (c.hidden.length) report.problems.push(`${tag}: hidden text ${c.hidden.join(' / ')}`);
      }
      if (lang === 'fr') for (const k of await page.evaluate(() => [...globalThis.__frMissing])) report.frMissing.add(k);
    }
    await ctx.close();
  }
  await browser.close(); srv.close();
  console.log(`${report.routes} screen visits ${JSON.stringify(report.byCtx)}; ${report.problems.length} problems`);
  for (const p of report.problems) console.log('  ' + p);
  console.log('texts shown without French:', JSON.stringify([...report.frMissing].sort()));
  process.exit(report.problems.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

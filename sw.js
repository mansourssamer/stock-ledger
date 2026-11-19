// Keeps the app's own files on the device so it opens with no internet. Data never passes
// through here: Firestore keeps its own offline copy. CACHE is set by tools/stamp_sw.py.
const CACHE = 'stock-ledger-ecead8c1ca';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './vendor/firebase.js', './vendor/sql-wasm.js', './vendor/sql-wasm.wasm', './vendor/jszip.min.js', './js/actions.js', './js/app.js', './js/docs.js', './js/fb.js', './js/forms.js', './js/fr.js', './js/i18n.js', './js/images.js', './js/importer.js', './js/localdb.js', './js/queries.js', './js/schema.js', './js/screens.js', './js/sell.js', './js/store.js', './js/ui.js', './js/util.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('stock-ledger-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!same && !font) return;
  if (font) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }
      catch { return Response.error(); }
    }));
    return;
  }
  // App files: always this version's copy, so every file comes from the same version.
  // A new version arrives as a new sw.js (tools/stamp_sw.py changes CACHE), which
  // downloads all the files first and takes over the next time the app opens.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const cached = (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await c.match('./index.html') : undefined);
    return cached || fetch(req).catch(() => Response.error());
  })());
});

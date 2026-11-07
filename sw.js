// Offline support: keep the app shell cached so it opens with no signal.
// Bump CACHE when any app file changes so phones pick up the new version.
const CACHE = 'field-journal-v4';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'utils.js', 'config.js', 'sync.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first when online (so updates arrive immediately), cached copy when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cached ? 4000 : 15000);
      const res = await fetch(e.request, { signal: ctrl.signal, cache: 'no-cache' });
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    } catch (err) {
      return cached || caches.match('index.html');
    }
  })());
});

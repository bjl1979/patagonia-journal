// Offline support: keep the app shell cached so it opens with no signal.
// Bump CACHE when any app file changes so phones pick up the new version.
const CACHE = 'field-journal-v10';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'utils.js', 'config.js', 'sync.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first when online (so updates arrive immediately), cached copy when offline.
// Map tiles: keep every tile you've viewed so those areas work offline (no bulk pre-downloading).
const TILES = 'field-journal-tiles';
const TILE_HOSTS = /(^|\.)tile\.openstreetmap\.org$|(^|\.)tile\.opentopomap\.org$/;
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      if (Math.random() < 0.02) cache.keys().then(k => { if (k.length > 4000) k.slice(0, k.length - 4000).forEach(r => cache.delete(r)); });
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const host = new URL(e.request.url).hostname;
  if (TILE_HOSTS.test(host)) { e.respondWith(tile(e.request)); return; }
  if (new URL(e.request.url).origin !== location.origin) return;
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

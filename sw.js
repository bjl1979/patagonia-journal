// Offline support: keep the app shell cached so it opens with no signal.
// Bump CACHE when any app file changes so phones pick up the new version.
const CACHE = 'field-journal-v13';
const TILES = 'field-journal-tiles';
const CORE = ['index.html', 'styles.css', 'app.js', 'db.js', 'utils.js', 'config.js', 'sync.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css'];
const EXTRA = ['manifest.webmanifest', 'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const MATCH = { ignoreSearch: true, ignoreVary: true };

// Fetch fresh copies (never the browser's HTTP cache) and store them clean. Core files must all
// succeed or the update is abandoned and the previous working version stays in place.
async function store(cache, path) {
  const res = await fetch(new Request(path, { cache: 'reload' }));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  await cache.put(path, await clean(res));
}
// A redirected response can't be used to open the app, so rebuild it as a plain one.
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(CORE.map(p => store(cache, p)));
    await Promise.all(EXTRA.map(p => store(cache, p).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // only drop old versions once this one is complete
    if (await (await caches.open(CACHE)).match('index.html')) {
      await Promise.all(keys.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

// Map tiles: keep every tile you've viewed so those areas work offline (no bulk pre-downloading).
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

// Network with a time limit, so a weak or dead connection falls back to the saved copy quickly.
let netDeadUntil = 0;   // after a failed page load, use saved files straight away for a while
function timed(req, ms) {
  return Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// Saved copy of the app page, from whichever version is stored.
async function savedPage() {
  return (await caches.match('index.html', MATCH)) || (await caches.match('./', MATCH)) ||
    new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <body style="font:17px -apple-system,Roboto,sans-serif;padding:40px 24px;text-align:center;color:#1d2422;background:#f4f1ea">
      <h2>Field Journal isn't saved for offline yet</h2><p>Open it once with signal, then it works with no connection.</p>
      <p style="color:#69716d">Your journal entries are safe on this phone.</p></body>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.test(url.hostname)) { e.respondWith(tile(req)); return; }
  if (url.origin !== location.origin) return;

  // Opening the app: network first (for updates), saved page if offline or slow.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await timed(req, 3000);
        netDeadUntil = 0;
        if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
          const copy = await clean(res.clone());
          caches.open(CACHE).then(c => c.put('index.html', copy));
          return res;
        }
        return res.ok ? res : await savedPage();
      } catch (err) {
        netDeadUntil = Date.now() + 60000;
        return savedPage();
      }
    })());
    return;
  }

  // App files: network first, saved copy if offline or slow.
  e.respondWith((async () => {
    const cached = await caches.match(req, MATCH);
    if (cached && Date.now() < netDeadUntil) return cached;
    try {
      const res = await timed(req, cached ? 3500 : 15000);
      if (res.ok) { const copy = await clean(res.clone()); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res.ok || !cached ? res : cached;
    } catch (err) {
      return cached || new Response('', { status: 504 });
    }
  })());
});

// OpenClaw service worker — offline-friendly without stale “shell” blocking updates.
// Network-first for HTML + JS + CSS so deploys reach users immediately; fall back to cache when offline.

const CACHE = 'openclaw-shell-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isShellAsset(pathname) {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/app.js' ||
    pathname === '/style.css' ||
    pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  // Only handle shell assets; let the browser handle everything else.
  if (!isShellAsset(url.pathname)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && isShellAsset(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (url.pathname !== '/' && url.pathname !== '/index.html' ? undefined : caches.match('/index.html')))
      )
  );
});

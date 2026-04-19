// OpenClaw service worker — offline shell + cached provider/model list for PWA.

const SHELL_CACHE = 'openclaw-shell-v2';
const API_CACHE = 'openclaw-api-v1';

const SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/icons/icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

/** Network-first for GET /api/providers; cache last good JSON for offline "model list". */
async function providersNetworkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      await cache.put(request, res.clone());
      return res;
    }
  } catch {
    /* offline */
  }
  const hit = await cache.match(request);
  if (hit) return hit;
  return new Response(
    JSON.stringify({
      offline: true,
      _note: 'Cached model list unavailable. Connect once online, then reopen.',
    }),
    {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!isSameOrigin(url)) return;

  if (url.pathname === '/api/providers') {
    event.respondWith(providersNetworkFirst(req));
    return;
  }

  // Other API: always network (no respondWith = default browser behavior).
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        fetch(req)
          .then((res) => {
            if (res && res.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone()));
          })
          .catch(() => {});
        return hit;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('/offline.html').then((o) => o || caches.match('/index.html')));
    })
  );
});

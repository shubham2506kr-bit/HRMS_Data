// HumanOS service worker.
//
// SECURITY CONTRACT — read before changing anything here.
//
// This worker must NEVER write a response to an authenticated request, or to
// any request under /api/, into the Cache Storage API. A previous version was
// cache-first for every authenticated `GET /api/*` with no `res.ok` check and
// no purge on logout, which archived payroll, health and audit response bodies
// to disk indefinitely and replayed them to the next person to use the browser
// with no token present.
//
// The cache is therefore restricted to same-origin static build assets and the
// app shell. /api/ is network-only: never read from the cache, never written to
// it. Non-GET requests are not intercepted at all.
const CACHE = 'humanos-shell-v3';
const SHELL = ['/', '/offline.html', '/manifest.webmanifest', '/icon-192.svg', '/icon-512.svg'];

// Only these extensions are ever cached. No extension, no cache entry — which
// keeps data endpoints and extensionless authenticated routes out by default.
const STATIC_RE = /\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|webmanifest|txt)$/i;

/** May this *request* ever produce a cache entry? */
function isCacheableRequest(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  // Personal data lives here. Never cached, in either direction.
  if (url.pathname.startsWith('/api/')) return false;
  // A query string usually means the response varies per caller.
  if (url.search) return false;
  // Anything carrying a bearer token or a cookie is per-user by definition.
  if (request.headers.get('authorization')) return false;
  if (request.headers.has('cookie')) return false;
  return STATIC_RE.test(url.pathname);
}

/** May this *response* be stored? Errors and per-user responses may not. */
function isCacheableResponse(res) {
  if (!res || !res.ok || res.status !== 200) return false;
  // Reject opaque / cross-origin responses: we cannot inspect them.
  if (res.type !== 'basic' && res.type !== 'default') return false;
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  if (res.headers.has('set-cookie')) return false;
  return true;
}

function put(request, res) {
  if (!isCacheableResponse(res)) return;
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => undefined);
}

/** Delete every cache this origin owns. Used on logout and on activate. */
function purgeAllCaches() {
  return caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Bumping CACHE above deletes every older cache, including any poisoned
  // pre-v3 cache that still holds another user's API responses.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The app commands a full purge here on logout and on a hard 401.
self.addEventListener('message', (event) => {
  const data = event.data;
  const type = typeof data === 'string' ? data : data && data.type;

  if (type === 'PURGE_CACHES' || type === 'LOGOUT') {
    const done = purgeAllCaches().then(() => {
      const port = event.ports && event.ports[0];
      if (port) port.postMessage({ purged: true });
    });
    if (event.waitUntil) event.waitUntil(done);
    return;
  }

  if (type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Mutations are never intercepted — they must reach the server untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // /api/* is network-only. Not served from cache (which is how one user's
  // payslips were handed to the next), and not written to it either.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first, cached shell as the offline fallback. The
  // response is stored under a fixed '/index.html' key rather than under the
  // authenticated URL, so no per-route entry is ever created.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          put('/index.html', res);
          return res;
        })
        .catch(() =>
          caches.match('/index.html')
            .then((r) => r || caches.match('/'))
            .then((r) => r || caches.match('/offline.html'))
            .then((r) => r || Response.error())
        )
    );
    return;
  }

  // Everything that is not a static asset goes straight to the network with
  // no cache involvement at all.
  if (!isCacheableRequest(request, url)) return;

  // Static assets: network first (cache-first here poisoned development —
  // unbundled, unhashed modules went stale forever), cache as offline
  // fallback only, and only when the response passes isCacheableResponse.
  event.respondWith(
    fetch(request)
      .then((res) => {
        put(request, res);
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || Response.error()))
  );
});

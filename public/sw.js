const CACHE = 'webtun-v9';
const PRECACHE = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/core.js',
  '/js/ui.js',
  '/js/tabs.js',
  '/js/terminal.js',
  '/js/files.js',
  '/js/transfers.js',
  '/js/editor-panel.js',
  '/js/file-tabs.js',
  '/js/preview.js',
  '/js/viewers.js',
  '/js/launchpad.js',
  '/js/settings.js',
  '/js/security.js',
  '/js/git.js',
  '/js/misc.js',
  '/js/theme-init.js',
  '/docs.html',
  '/manifest.json',
  '/commands.js',
  '/favicon.png',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    // Add individually: addAll() is atomic, so a single missing asset would leave the
    // whole precache empty. One bad entry should degrade gracefully, not disable offline.
    caches.open(CACHE)
      .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
    // Do not skipWaiting automatically — let activate wait for user prompt (F87)
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  // Only our own pages may trigger activation — a same-origin top-level
  // preview page must not be able to swap the worker under the app.
  if (e.data === 'skipWaiting' && e.origin === self.location.origin) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith('http://') && !e.request.url.startsWith('https://')) return;

  const url = new URL(e.request.url);
  // Exact path-segment matches: '/api' must not over-match a future '/apidocs'.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) return;
  if (url.searchParams.has('token')) return;
  // Credentialed non-API GETs must never be cached. The app authenticates
  // with x-pin-token (not Authorization), so guard both explicitly.
  try { if (e.request.headers.has('authorization')) return; } catch {}
  try { if (e.request.headers.has('x-pin-token')) return; } catch {}

  // Network-First for HTML/navigation
  const isNavigation = e.request.mode === 'navigate' || (url.pathname === '/') || (url.pathname.endsWith('.html') && e.request.mode === 'same-origin');
  if (isNavigation) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(c => { try { c.put(e.request, clone); } catch {} });
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(cached =>
          cached || caches.match('/index.html')
        )
      )
    );
    return;
  }

  // Cache-First for static assets with background revalidation. There is no
  // TTL eviction: entries live until the versioned cache name changes.
  // CDN resources are fetched from network (not precached) to avoid opaque response failures
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) {
        // Background revalidate without blocking. extendLifetime keeps the
        // worker alive for the put — respondWith alone does not cover work
        // issued after the cached response is returned.
        e.waitUntil(fetch(e.request).then(res => {
          if (res && res.status === 200 && res.type !== 'opaque') {
            const clone = res.clone();
            return caches.open(CACHE).then(c => c.put(e.request, clone).catch(() => {}));
          }
        }).catch(() => {}));
        return cached;
      }
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          // Use waitUntil equivalent via open+put
          caches.open(CACHE).then(c => { try { c.put(e.request, clone); } catch {} });
        }
        return res;
      }).catch(() => cached || offlineFallback(e.request));
    })
  );
});

function offlineFallback(request) {
  // Serve the right shape for the request: an HTML shell for navigations,
  // plain text otherwise.
  try {
    if (request.destination === 'document' || (request.headers.get('accept') || '').includes('text/html')) {
      return new Response('<p style="font-family:sans-serif;padding:16px">Offline — WebTun needs a connection for this page.</p>', { status: 503, headers: { 'Content-Type': 'text/html' } });
    }
  } catch {}
  return new Response('Offline', { status: 503 });
}

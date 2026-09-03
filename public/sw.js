const CACHE = 'webtun-v4';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE))
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
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith('http://') && !e.request.url.startsWith('https://')) return;

  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api')) return;
  if (url.pathname === '/ws' || url.pathname.startsWith('/ws')) return;
  if (url.searchParams.has('token')) return;

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

  // Cache-First for static assets with stale-while-revalidate (max-age 7d via version bump)
  // CDN resources are fetched from network (not precached) to avoid opaque response failures
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) {
        // Background revalidate without blocking
        fetch(e.request).then(res => {
          if (res && res.status === 200 && res.type !== 'opaque') {
            const clone = res.clone();
            caches.open(CACHE).then(c => { try { c.put(e.request, clone); } catch {} });
          }
        }).catch(()=>{});
        return cached;
      }
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          // Use waitUntil equivalent via open+put
          caches.open(CACHE).then(c => { try { c.put(e.request, clone); } catch {} });
        }
        return res;
      }).catch(() => cached || new Response('Offline', { status: 503 }));
    })
  );
});

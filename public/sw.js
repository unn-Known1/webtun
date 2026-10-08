const CACHE = 'webtun-v42';
const PRECACHE = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/vendor/xterm.css',
  '/vendor/xterm.js',
  '/vendor/addon-fit.js',
  '/vendor/addon-web-links.js',
  '/vendor/addon-unicode11.js',
  '/vendor/addon-webgl.js',
  // Preview libs are vendored, not CDN: markdown/HTML/DOCX previews must work
  // offline and behind a CDN-blocked tunnel.
  '/vendor/marked.min.js',
  '/vendor/purify.min.js',
  '/js/editor-buffers.js',
  '/js/core.js',
  '/js/actions.js',
  '/js/ui.js',
  '/js/tabs.js',
  '/js/terminal-connection.js',
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
  '/js/ssh.js',
  '/js/git.js',
  '/js/misc.js',
  '/js/theme-init.js',
  '/docs.html',
  '/billing-success.html',
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
  // Cross-origin (jsDelivr viewer libs, Google Fonts) stays out of the cache
  // and out of respondWith entirely: the browser applies script-src/style-src
  // itself. The SW's own fetch() of these is connect-src governed, and a
  // blocked one fell through to offlineFallback() — a 503 "Offline" that broke
  // the PDF/EPUB/DOCX/XLSX viewers for every PWA session.
  if (url.origin !== self.location.origin) return;
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
      // Was a bare unstyled <p>, which rendered UA-default black-on-white with
      // no retry affordance on an app whose whole identity is a themed
      // workspace (S-20). Inline so it stays dependency-free and offline-safe.
      return new Response(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — WebTun</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100dvh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    padding: 24px; text-align: center;
    font: 14px/1.5 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #1a1b26; color: #c0caf5;
  }
  @media (prefers-color-scheme: light) {
    body { background: #f9f9fb; color: #1f1f30; }
  }
  .mark {
    width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center;
    background: #7aa2f7; color: #1a1b26;
  }
  h1 { font-size: 17px; font-weight: 700; }
  p { max-width: 40ch; font-size: 13px; color: #9aa0c3; }
  @media (prefers-color-scheme: light) { p { color: #2b2b45; } }
  button {
    height: 38px; padding: 0 20px; border-radius: 6px; cursor: pointer;
    font: 600 13px/1 inherit; letter-spacing: .2px;
    background: #7aa2f7; color: #1a1b26; border: 1px solid transparent;
  }
  button:hover { filter: brightness(1.06); }
</style>
</head><body>
  <div class="mark" aria-hidden="true">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
    </svg>
  </div>
  <h1>You're offline</h1>
  <p>WebTun needs a connection to reach your server. Reconnect and try again.</p>
  <button type="button" onclick="location.reload()">Retry</button>
</body></html>`, { status: 503, headers: { 'Content-Type': 'text/html' } });
    }
  } catch {}
  return new Response('Offline', { status: 503 });
}

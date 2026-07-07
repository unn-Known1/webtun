// CloakBrowser lifecycle manager + reverse proxy with URL rewriting
// Uses dynamic import() because cloakbrowser is ESM-only
const { URL } = require('url');

// ── Configuration ─────────────────────────────────────────────────────
const MAX_BROWSERS = 5;           // max concurrent browser instances
const IDLE_TIMEOUT_MS = 600000; // 10 minutes idle before auto-close
const CACHE_MAX_SIZE = 50;        // max cached resources per browser
const CACHE_TTL_MS = 300000;      // 5 minutes cache TTL
const CLEANUP_INTERVAL_MS = 60000; // run cleanup every minute

// ── State ─────────────────────────────────────────────────────────────
const browsers = new Map(); // tabId -> { browser, context, page, baseUrl, lastAccessed, history }
let cloakbrowser = null;

// ── Lightweight LRU-ish cache for proxied resources ───────────────────
class ResourceCache {
  constructor(maxSize, ttlMs) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.store = new Map(); // key -> { body, contentType, status, createdAt }
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    // promote to most-recently-used by re-setting
    this.store.delete(key);
    this.store.set(key, entry);
    return entry;
  }
  set(key, value) {
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      this.store.delete(firstKey);
    }
    this.store.set(key, { ...value, createdAt: Date.now() });
  }
  clear() { this.store.clear(); }
}

// ── CloakBrowser dynamic import ─────────────────────────────────────
async function ensureCloakBrowser() {
  if (!cloakbrowser) cloakbrowser = await import('cloakbrowser');
  return cloakbrowser;
}

// ── Browser lifecycle ──────────────────────────────────────────────────
async function launchBrowser(tabId, opts = {}) {
  if (browsers.has(tabId)) return browsers.get(tabId);

  // Enforce max browsers limit (close oldest idle)
  if (browsers.size >= MAX_BROWSERS) {
    const oldest = [...browsers.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)[0];
    if (oldest) {
      console.log(`[Browser] Max limit reached. Closing oldest tab: ${oldest[0]}`);
      await closeBrowser(oldest[0]);
    }
  }

  const cb = await ensureCloakBrowser();
  const browser = await cb.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...opts
  });

  const context = await browser.newContext({
    viewport: { width: opts.width || 1280, height: opts.height || 720 },
    bypassCSP: true
  });

  const page = await context.newPage();
  const entry = {
    browser,
    context,
    page,
    baseUrl: '',
    lastAccessed: Date.now(),
    history: { canGoBack: false, canGoForward: false },
    cache: new ResourceCache(CACHE_MAX_SIZE, CACHE_TTL_MS)
  };
  browsers.set(tabId, entry);
  return entry;
}

function getBrowser(tabId) {
  const entry = browsers.get(tabId) || null;
  if (entry) entry.lastAccessed = Date.now();
  return entry;
}

async function navigateBrowser(tabId, url) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();
  entry.cache.clear();
  await entry.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  entry.baseUrl = entry.page.url();
  return { url: entry.page.url(), title: await entry.page.title() };
}

// Server-side history navigation
async function browserGoBack(tabId) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();
  await entry.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
  entry.baseUrl = entry.page.url();
  return { url: entry.page.url(), title: await entry.page.title() };
}

async function browserGoForward(tabId) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();
  await entry.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
  entry.baseUrl = entry.page.url();
  return { url: entry.page.url(), title: await entry.page.title() };
}

async function refreshBrowser(tabId) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();
  entry.cache.clear();
  await entry.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  entry.baseUrl = entry.page.url();
  return { url: entry.page.url(), title: await entry.page.title() };
}

// ── Page content proxy with URL rewriting ─────────────────────────────
async function getPageContent(tabId, proxyBase) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();

  let html = await entry.page.content();
  const pageUrl = entry.page.url();
  const baseUrl = new URL(pageUrl);
  const proxyPrefix = `${proxyBase}/browser/${tabId}/proxy`;

  // Remove existing <base> tags so they don't interfere with attribute rewriting
  html = html.replace(/<base[^>]*>/gi, '');

  // Rewrite src/href/poster/background attributes (NOT action — forms navigate via interceptor)
  html = html.replace(
    /((?:src|href|poster|background)\s*=\s*)["']([^"']*?)["']/gi,
    (match, prefix, url) => {
      if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('blob:') || url.startsWith('mailto:')) return match;
      try {
        const abs = new URL(url, baseUrl).href;
        return `${prefix}"${proxyPrefix}?url=${encodeURIComponent(abs)}"`;
      } catch { return match; }
    }
  );

  // Rewrite CSS url() references
  html = html.replace(
    /url\(\s*["']?([^"')]+?)["']?\s*\)/gi,
    (match, url) => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return match;
      try {
        const abs = new URL(url, baseUrl).href;
        return `url("${proxyPrefix}?url=${encodeURIComponent(abs)}"`;
      } catch { return match; }
    }
  );

  // Rewrite @import statements
  html = html.replace(
    /@import\s+["']([^"']+?)["']/gi,
    (match, url) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return `@import "${proxyPrefix}?url=${encodeURIComponent(url)}"`;
      }
      return match;
    }
  );

  // Inject interceptor script for dynamic loads (fetch, XHR, dynamic DOM) + form interception
  const interceptorScript = `<script>
(function() {
  var PROXY = "${proxyPrefix}";
  var ORIGIN = "${baseUrl.origin}";
  function rewriteUrl(u) {
    try {
      var abs = new URL(u, ORIGIN).href;
      if (abs.startsWith(ORIGIN)) return PROXY + "?url=" + encodeURIComponent(abs);
    } catch(e) {}
    return u;
  }
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = rewriteUrl(input);
    else if (input && input.url) input = new Request(rewriteUrl(input.url), input);
    return origFetch.call(this, input, init);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    return origOpen.call(this, method, rewriteUrl(url));
  };
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        ['src','href'].forEach(function(attr) {
          var val = node.getAttribute(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('blob:')) {
            try {
              var abs = new URL(val, ORIGIN).href;
              if (abs.startsWith(ORIGIN)) node.setAttribute(attr, PROXY + "?url=" + encodeURIComponent(abs));
            } catch(e) {}
          }
        });
      });
    });
  });
  observer.observe(document, { childList: true, subtree: true });

  // Intercept form submissions — route through proxy
  var tabId = window.location.pathname.split('/').filter(Boolean)[1];
  var token = new URLSearchParams(window.location.search).get('token');
  document.addEventListener('submit', function(e) {
    var form = e.target;
    var action = (form.getAttribute('action') || '').trim();
    if (!action || action === '#' || action.startsWith('javascript:') || action.startsWith('data:')) return;
    var method = (form.method || 'GET').toUpperCase();
    if (method !== 'GET') return;
    e.preventDefault();
    var formData = new FormData(form);
    var params = new URLSearchParams(formData).toString();
    try {
      var absUrl = new URL(action, ORIGIN).href;
      if (params) absUrl += (absUrl.includes('?') ? '&' : '?') + params;
      window.location.href = '/browser/' + tabId + '?token=' + encodeURIComponent(token || '') + '&url=' + encodeURIComponent(absUrl);
    } catch(e) {}
  });
})();
</script>`;
  const safeUrl = pageUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  html = html.replace(/<\/head>/i, '<base href="' + safeUrl + '">' + interceptorScript + '</head>');

  return { html, url: pageUrl, title: await entry.page.title() };
}

// ── Resource proxy with caching ──────────────────────────────────────
async function fetchResource(tabId, resourceUrl) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();

  const cacheKey = resourceUrl;
  const cached = entry.cache.get(cacheKey);
  if (cached) {
    return { body: cached.body, contentType: cached.contentType, status: cached.status, cached: true };
  }

  try {
    const response = await entry.page.context().request.get(resourceUrl, { timeout: 15000 });
    const body = await response.body();
    const contentType = response.headers()['content-type'] || 'application/octet-stream';
    const status = response.status();

    entry.cache.set(cacheKey, { body, contentType, status });
    return { body, contentType, status, cached: false };
  } catch (e) {
    throw new Error(`Failed to fetch: ${e.message}`);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────
async function closeBrowser(tabId) {
  const entry = browsers.get(tabId);
  if (!entry) return;
  try { await entry.context.close(); } catch {}
  try { await entry.browser.close(); } catch {}
  browsers.delete(tabId);
}

function closeAll() {
  for (const [tabId] of browsers) closeBrowser(tabId).catch(() => {});
}

// Periodically cleanup idle browsers
function startIdleCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [tabId, entry] of browsers) {
      if (now - entry.lastAccessed > IDLE_TIMEOUT_MS) {
        console.log(`[Browser] Closing idle tab: ${tabId}`);
        closeBrowser(tabId).catch(() => {});
      }
    }
  }, CLEANUP_INTERVAL_MS);
}
startIdleCleanup();

module.exports = { launchBrowser, getBrowser, navigateBrowser, browserGoBack, browserGoForward, refreshBrowser, getPageContent, fetchResource, closeBrowser, closeAll };

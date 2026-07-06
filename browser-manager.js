// CloakBrowser lifecycle manager + reverse proxy with URL rewriting
// Uses dynamic import() because cloakbrowser is ESM-only
const { URL } = require('url');

const browsers = new Map(); // tabId -> { browser, context, page, baseUrl }
let cloakbrowser = null;

async function ensureCloakBrowser() {
  if (!cloakbrowser) cloakbrowser = await import('cloakbrowser');
  return cloakbrowser;
}

async function launchBrowser(tabId, opts = {}) {
  if (browsers.has(tabId)) return browsers.get(tabId);

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
  const entry = { browser, context, page, baseUrl: '' };
  browsers.set(tabId, entry);
  return entry;
}

function getBrowser(tabId) {
  return browsers.get(tabId) || null;
}

async function navigateBrowser(tabId, url) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  await entry.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  entry.baseUrl = entry.page.url();
  return { url: entry.page.url(), title: await entry.page.title() };
}

async function getPageContent(tabId, proxyBase) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');

  let html = await entry.page.content();
  const pageUrl = entry.page.url();
  const baseUrl = new URL(pageUrl);
  const proxyPrefix = `${proxyBase}/browser/${tabId}/proxy`;

  // Remove existing <base> tags
  html = html.replace(/<base[^>]*>/gi, '');

  // Rewrite src/href/action/poster/background attributes
  html = html.replace(
    /((?:src|href|action|poster|background)\s*=\s*)["']([^"']*?)["']/gi,
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
        return `url("${proxyPrefix}?url=${encodeURIComponent(abs)}")`;
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

  // Inject interceptor script for dynamic loads (fetch, XHR, dynamic DOM)
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
        ['src','href','action'].forEach(function(attr) {
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
})();
</script>`;
  html = html.replace(/<\/head>/i, interceptorScript + '</head>');

  return { html, url: pageUrl, title: await entry.page.title() };
}

async function fetchResource(tabId, resourceUrl) {
  const entry = browsers.get(tabId);
  if (!entry) throw new Error('Browser not found');
  try {
    const response = await entry.page.context().request.get(resourceUrl, { timeout: 15000 });
    const body = await response.body();
    const contentType = response.headers()['content-type'] || 'application/octet-stream';
    return { body, contentType, status: response.status() };
  } catch (e) {
    throw new Error(`Failed to fetch: ${e.message}`);
  }
}

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

module.exports = { launchBrowser, getBrowser, navigateBrowser, getPageContent, fetchResource, closeBrowser, closeAll };

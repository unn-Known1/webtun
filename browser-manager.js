// Pure HTTP proxy-based browsing — no headless browser needed
// Fast, lightweight, and uses zero Chromium processes
const { URL } = require('url');

const MAX_TABS = 20;
const IDLE_TIMEOUT_MS = 600000;
const FETCH_TIMEOUT_MS = 20000;
const CLEANUP_INTERVAL_MS = 60000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const tabs = new Map();

// ── HTTP fetching ─────────────────────────────────────────────────────
async function httpFetch(url, opts = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs supported');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': opts.ua || UA,
        'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...(opts.headers || {})
      },
      redirect: 'follow',
    });

    const ct = res.headers.get('content-type') || 'application/octet-stream';
    const body = Buffer.from(await res.arrayBuffer());
    return { body, contentType: ct, status: res.status, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

// ── URL rewriting ────────────────────────────────────────────────────
function rewriteHtml(html, pageUrl, proxyBase, tabId) {
  const proxyPrefix = `${proxyBase}/browser/${tabId}/proxy`;
  const baseUrl = new URL(pageUrl);

  html = html.replace(/<base[^>]*>/gi, '');

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

  html = html.replace(
    /@import\s+["']([^"']+?)["']/gi,
    (match, url) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return `@import "${proxyPrefix}?url=${encodeURIComponent(url)}"`;
      }
      return match;
    }
  );

  const interceptor = buildInterceptor(proxyPrefix, baseUrl.origin);
  const safeUrl = pageUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  html = html.replace(/<\/head>/i, '<base href="' + safeUrl + '">' + interceptor + '</head>');

  return html;
}

function rewriteCss(css, cssUrl) {
  const baseUrl = new URL(cssUrl);
  return css.replace(
    /url\(\s*["']?([^"')]+?)["']?\s*\)/gi,
    (match, url) => {
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http://') || url.startsWith('https://')) return match;
      try {
        const abs = new URL(url, baseUrl).href;
        return `url("${abs}")`;
      } catch { return match; }
    }
  );
}

function buildInterceptor(proxyPrefix, origin) {
  return `<script>
(function(){
  var PROXY="${proxyPrefix}", ORIGIN="${origin}";
  function rw(u){try{var a=new URL(u,ORIGIN).href;if(a.startsWith(ORIGIN))return PROXY+'?url='+encodeURIComponent(a)}catch(){}return u}
  var f=window.fetch;window.fetch=function(i,n){if(typeof i==='string')i=rw(i);else if(i&&i.url)i=new Request(rw(i.url),i);return f.call(this,i,n)}
  var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){return o.call(this,m,rw(u))}
  var tabId=window.location.pathname.split('/').filter(Boolean)[1],token=new URLSearchParams(window.location.search).get('token')
  document.addEventListener('submit',function(e){
    var form=e.target,action=(form.getAttribute('action')||'').trim()
    if(!action||action==='#'||action.startsWith('javascript:')||action.startsWith('data:'))return
    var method=(form.method||'GET').toUpperCase();if(method!=='GET')return
    e.preventDefault()
    var fd=new FormData(form),p=new URLSearchParams(fd).toString()
    try{var abs=new URL(action,ORIGIN).href;if(p)abs+=(abs.includes('?')?'&':'?')+p;window.location.href='/browser/'+tabId+'?token='+encodeURIComponent(token||'')+'&url='+encodeURIComponent(abs)}catch(){}
  })
  new MutationObserver(function(m){m.forEach(function(m){m.addedNodes.forEach(function(n){
    if(n.nodeType!==1)return;['src','href'].forEach(function(a){
      var v=n.getAttribute(a);if(v&&!v.startsWith('data:')&&!v.startsWith('blob:')){try{var ab=new URL(v,ORIGIN).href;if(ab.startsWith(ORIGIN))n.setAttribute(a,PROXY+'?url='+encodeURIComponent(ab))}catch(){}}
    })
  })})}).observe(document,{childList:true,subtree:true})
})();
</script>`;
}

// ── Tab lifecycle ────────────────────────────────────────────────────
async function launchBrowser(tabId, opts = {}) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  const entry = { history: [], historyIndex: -1, currentUrl: '', lastAccessed: Date.now() };
  tabs.set(tabId, entry);
  return entry;
}

function getBrowser(tabId) {
  const entry = tabs.get(tabId) || null;
  if (entry) entry.lastAccessed = Date.now();
  return entry;
}

async function navigateBrowser(tabId, url) {
  const entry = tabs.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();
  entry.history = entry.history.slice(0, entry.historyIndex + 1);
  entry.history.push(url);
  entry.historyIndex = entry.history.length - 1;
  entry.currentUrl = url;
  return { url, title: '' };
}

async function browserGoBack(tabId) {
  const entry = tabs.get(tabId);
  if (!entry || entry.historyIndex <= 0) throw new Error('No back history');
  entry.lastAccessed = Date.now();
  entry.historyIndex--;
  entry.currentUrl = entry.history[entry.historyIndex];
  return { url: entry.currentUrl, title: '' };
}

async function browserGoForward(tabId) {
  const entry = tabs.get(tabId);
  if (!entry || entry.historyIndex >= entry.history.length - 1) throw new Error('No forward history');
  entry.lastAccessed = Date.now();
  entry.historyIndex++;
  entry.currentUrl = entry.history[entry.historyIndex];
  return { url: entry.currentUrl, title: '' };
}

async function refreshBrowser(tabId) {
  const entry = tabs.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();
  return { url: entry.currentUrl, title: '' };
}

// ── Page content fetching ────────────────────────────────────────────
async function getPageContent(tabId, proxyBase, targetUrl) {
  const entry = tabs.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();

  if (!targetUrl) targetUrl = entry.currentUrl;
  if (!targetUrl) throw new Error('No URL to fetch');

  const result = await httpFetch(targetUrl);
  let html = result.body.toString('utf-8');

  if (!html.toLowerCase().includes('<html')) {
    html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>';
  }

  entry.currentUrl = result.finalUrl;
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || targetUrl;

  return {
    html: rewriteHtml(html, result.finalUrl, proxyBase, tabId),
    url: result.finalUrl,
    title
  };
}

async function fetchResource(tabId, resourceUrl) {
  const entry = tabs.get(tabId);
  if (!entry) throw new Error('Browser not found');
  entry.lastAccessed = Date.now();

  const result = await httpFetch(resourceUrl, {
    accept: '*/*'
  });
  let body = result.body;

  // Rewrite relative URLs in CSS
  if (result.contentType.includes('text/css')) {
    const css = body.toString('utf-8');
    body = Buffer.from(rewriteCss(css, resourceUrl), 'utf-8');
  }

  return { body, contentType: result.contentType, status: result.status };
}

// ── Cleanup ──────────────────────────────────────────────────────────
async function closeBrowser(tabId) {
  tabs.delete(tabId);
}

async function closeAll() {
  tabs.clear();
}

async function prewarm() {}

function startIdleCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [tabId, entry] of tabs) {
      if (now - entry.lastAccessed > IDLE_TIMEOUT_MS) {
        tabs.delete(tabId);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}
startIdleCleanup();

module.exports = { launchBrowser, getBrowser, navigateBrowser, browserGoBack, browserGoForward, refreshBrowser, getPageContent, fetchResource, closeBrowser, closeAll, prewarm, httpFetch };

// WebTun frontend - preview.js (app preview tabs (proxy nav, health, ports).)

// ── App preview tabs (loopback reverse-proxy) ──
// Same tab bar as terminals, but the body is a toolbar + sandboxed iframe
// pointed at /api/preview/:port/ instead of xterm + /ws.
function previewBuildUrl(port, pth) {
  let p = String(pth || '/');
  if (!p.startsWith('/')) p = '/' + p;
  // Encode each segment separately: encodeURI leaves ?&# unescaped, which
  // corrupts the ?token= query the token is appended to.
  const enc = p.split('/').map(seg => encodeURIComponent(seg)).join('/');
  return `/api/preview/${port}${enc}?token=${encodeURIComponent(authToken)}`;
}
// Accept a pasted dev URL in either field: "http://localhost:5173/docs?a=1",
// "127.0.0.1:5173/docs", ":5173/docs" or "5173/docs" → { port, path }.
function parsePreviewTarget(portRaw, pathRaw) {
  const combined = `${String(portRaw == null ? '' : portRaw)} ${String(pathRaw == null ? '' : pathRaw)}`.trim();
  if (!combined) return { error: 'Port must be 1–65535' };
  let m = combined.match(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(\/\S*)?/i);
  if (m && m[1]) {
    const port = parseInt(m[1], 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be 1–65535' };
    let pth = (m[2] || '').replace(/["'\),;\]]+$/, '') || '';
    if (!pth || pth === '/') {
      // URL had no path — keep whatever plain path the other field held.
      const other = String(pathRaw == null ? '' : pathRaw).trim();
      if (other && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(other)) pth = other;
    }
    return { port, path: pth || '/' };
  }
  m = String(portRaw == null ? '' : portRaw).trim().match(/^:?(\d{1,5})(\/\S*)?$/);
  if (m) {
    const port = parseInt(m[1], 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be 1–65535' };
    return { port, path: (m[2] || String(pathRaw == null ? '' : pathRaw)).trim() || '/' };
  }
  const n = parseInt(String(portRaw).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'Port must be 1–65535' };
  return { port: n, path: String(pathRaw == null ? '/' : pathRaw).trim() || '/' };
}
// Recent ports + per-port path memory (survives reload, Edge-safe).
function getPreviewRecent() {
  try { const v = JSON.parse(safeStorage.getItem('wt-preview-recent')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function rememberPreviewRecent(port, pth) {
  try {
    const n = Number(port);
    if (!Number.isInteger(n)) return;
    let arr = getPreviewRecent().filter(e => Number(e.port) !== n);
    arr.unshift({ port: n, path: String(pth || '/').slice(0, 512), ts: Date.now() });
    safeStorage.setItem('wt-preview-recent', JSON.stringify(arr.slice(0, 8)));
  } catch {}
}
function recentPreviewPath(port) {
  try { return (getPreviewRecent().find(e => Number(e.port) === Number(port)) || {}).path || null; } catch { return null; }
}
function createPreviewWrapper(tab) {
  const wrapper = document.createElement('div');
  wrapper.className = 'term-wrapper';
  wrapper.dataset.id = tab.id;
  wrapper.style.flexDirection = 'column';
  const bar = document.createElement('div');
  bar.className = 'preview-bar';
  bar.innerHTML = '<button class="btn btn-ghost preview-back" type="button" title="Back" aria-label="Back">←</button>'
    + '<button class="btn btn-ghost preview-fwd" type="button" title="Forward" aria-label="Forward">→</button>'
    + '<span class="preview-status unknown" title="Checking…"></span>'
    + '<input class="preview-port-input" list="preview-ports-list" inputmode="numeric" pattern="[0-9]*" aria-label="Port" title="Local port — you can paste a full localhost URL" placeholder="port">'
    + '<input class="preview-path-input" aria-label="Path" title="Path" placeholder="/  (e.g. /docs) — Enter opens">'
    + '<button class="btn btn-primary preview-go" type="button">Go</button>'
    + '<button class="btn btn-ghost preview-reload" type="button" title="Reload">Reload</button>'
    + '<button class="btn btn-ghost preview-open" type="button" title="Open in new tab">Open</button>'
    + '<button class="btn btn-ghost preview-copy" type="button" title="Copy preview URL">Copy URL</button>'
    + '<label class="preview-auto" title="Reload this preview when you save a file"><input type="checkbox" class="preview-auto-box"> Auto</label>'
    + '<select class="preview-width" aria-label="Preview width" title="Preview width"><option value="full">Full</option><option value="768">768</option><option value="375">375</option></select>';
  const loading = document.createElement('div');
  loading.className = 'preview-loading';
  loading.innerHTML = '<span class="tl-spinner"></span><span>Loading preview…</span>';
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('title', `Preview :${tab.port}`);
  // No allow-same-origin on purpose: previewed pages stay opaque-origin so they
  // can't touch WebTun's localStorage/session token. Downloads + dialogs on.
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-downloads allow-modals');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  wrapper.appendChild(bar);
  wrapper.appendChild(loading);
  wrapper.appendChild(frame);
  document.getElementById('terminals').appendChild(wrapper);
  tab.wrapper = wrapper;
  tab.loadingEl = loading;
  tab.iframe = frame;
  tab.portInput = bar.querySelector('.preview-port-input');
  tab.pathInput = bar.querySelector('.preview-path-input');
  tab.statusEl = bar.querySelector('.preview-status');
  tab.portInput.value = tab.port;
  tab.pathInput.value = tab.previewPath || '/';
  const autoBox = bar.querySelector('.preview-auto-box');
  autoBox.checked = !!tab.previewAutoReload;
  autoBox.addEventListener('change', () => { tab.previewAutoReload = autoBox.checked; saveTabState(); });
  const widthSel = bar.querySelector('.preview-width');
  widthSel.value = tab.previewWidth || 'full';
  widthSel.addEventListener('change', () => { tab.previewWidth = widthSel.value; applyPreviewWidth(tab); saveTabState(); });
  applyPreviewWidth(tab);
  const go = () => previewNavigate(tab, tab.portInput.value, tab.pathInput.value);
  bar.querySelector('.preview-go').addEventListener('click', go);
  bar.querySelector('.preview-reload').addEventListener('click', () => previewReload(tab));
  bar.querySelector('.preview-back').addEventListener('click', () => { try { tab.iframe.contentWindow.history.back(); } catch {} });
  bar.querySelector('.preview-fwd').addEventListener('click', () => { try { tab.iframe.contentWindow.history.forward(); } catch {} });
  bar.querySelector('.preview-open').addEventListener('click', () => {
    try { window.open(location.origin + previewBuildUrl(tab.port, tab.previewPath || '/'), '_blank', 'noopener'); } catch { toast('Open failed', 'error'); }
  });
  bar.querySelector('.preview-copy').addEventListener('click', () => {
    try { copyText(location.origin + previewBuildUrl(tab.port, tab.previewPath || '/')); toast('Preview URL copied — it carries your access token, share carefully', 'warning'); } catch { toast('Copy failed', 'error'); }
  });
  bar.querySelector('.preview-status').addEventListener('click', () => checkPreviewHealth(tab, true));
  const keyGo = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  tab.portInput.addEventListener('keydown', keyGo);
  tab.pathInput.addEventListener('keydown', keyGo);
  tab.portInput.addEventListener('focus', fillPreviewPorts);
  frame.addEventListener('load', () => { try { loading.classList.add('hidden'); } catch {} setPreviewStatus(tab, 'unknown'); });
  frame.addEventListener('error', () => { try { loading.classList.add('hidden'); } catch {} });
  wirePreviewNavMessages();
  startPreviewHealthLoop();
}
function applyPreviewWidth(tab) {
  if (!tab || !tab.iframe) return;
  const w = tab.previewWidth || 'full';
  try {
    tab.iframe.style.maxWidth = (w === 'full') ? '' : w + 'px';
    tab.iframe.style.margin = (w === 'full') ? '' : '0 auto';
  } catch {}
}
// In-iframe nav reporter (injected by the proxy next to <base>): the frame is
// opaque-origin so the parent can't read its URL — the app posts its path out.
function wirePreviewNavMessages() {
  if (window._wtPreviewNavWired) return;
  window._wtPreviewNavWired = true;
  window.addEventListener('message', e => {
    let pth = null;
    try { pth = e && e.data && e.data.wtPreviewNav; } catch {}
    if (typeof pth !== 'string' || !pth.startsWith('/') || pth.length > 2048) return;
    try {
      const tab = tabs.find(t => t.type === 'preview' && !t.closed && t.iframe && e.source === t.iframe.contentWindow);
      if (!tab) return;
      tab.previewPath = pth;
      if (tab.pathInput && document.activeElement !== tab.pathInput) tab.pathInput.value = pth;
      saveTabState();
    } catch {}
  });
}
function setPreviewStatus(tab, st) {
  if (!tab || !tab.statusEl) return;
  try {
    tab.statusEl.className = 'preview-status ' + (st === 'online' ? 'online' : st === 'offline' ? 'offline' : 'unknown');
    tab.statusEl.title = st === 'online' ? `App :${tab.port} answering` : st === 'offline' ? `App :${tab.port} unreachable — click to retry` : 'Checking…';
  } catch {}
}
// 5s health poll on the visible preview tab only (never in background tabs).
// HEAD + synthetic-error header tells "no listener" apart from an app 5xx.
// offline→online flips trigger one auto-reload (dev-server restart case).
let _previewHealthTimer = null;
function startPreviewHealthLoop() {
  if (_previewHealthTimer) return;
  _previewHealthTimer = setInterval(() => {
    try {
      if (document.hidden) return;
      const tab = tabs.find(t => t.id === activeTabId && t.type === 'preview' && !t.closed);
      if (tab) checkPreviewHealth(tab, false);
    } catch {}
  }, 5000);
}
async function checkPreviewHealth(tab, manual) {
  if (!tab || tab.type !== 'preview' || tab.closed) return;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(previewBuildUrl(tab.port, '/') + '&_hk=' + Date.now(), { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
    clearTimeout(to);
    const synthetic = r.headers && r.headers.get && r.headers.get('x-webtun-preview-error');
    if (synthetic) {
      setPreviewStatus(tab, 'offline');
      tab.previewDead = true;
      if (manual) previewReload(tab);
      return;
    }
    setPreviewStatus(tab, 'online');
    if (tab.previewDead) { tab.previewDead = false; previewReload(tab); }
  } catch { setPreviewStatus(tab, 'unknown'); }
}
// Reload every Auto-tagged preview after a file save (debounced for rebuilds).
let _previewSaveReloadTimer = null;
function notifyPreviewFileSaved() {
  try {
    const targets = tabs.filter(t => t.type === 'preview' && t.previewAutoReload && !t.closed);
    if (!targets.length) return;
    clearTimeout(_previewSaveReloadTimer);
    _previewSaveReloadTimer = setTimeout(() => { targets.forEach(t => { try { previewReload(t); } catch {} }); }, 1500);
  } catch {}
}
function previewNavigate(tab, port, pth) {
  const parsed = parsePreviewTarget(port, pth == null ? (tab.previewPath || '/') : pth);
  if (parsed.error) { toast(parsed.error, 'error'); return; }
  const n = parsed.port;
  let p = String(parsed.path == null ? (tab.previewPath || '/') : parsed.path).trim() || '/';
  p = p.replace(/["'\),;\]]+$/, '') || '/';
  if (!p.startsWith('/')) p = '/' + p;
  p = p.slice(0, 2048);
  tab.port = n;
  tab.previewPath = p;
  tab.previewDead = false;
  tab.title = `App:${n}`;
  try { tab.el.querySelector('.tab-title').textContent = tab.title; } catch {}
  try { tab.iframe.setAttribute('title', `Preview :${n}`); } catch {}
  try { tab.loadingEl.classList.remove('hidden'); } catch {}
  setPreviewStatus(tab, 'unknown');
  rememberPreviewRecent(n, p);
  // Cache-bust so Reload/Go always hits the live app, then hide spinner on load.
  // previewBuildUrl always carries ?token=, so the cache-buster joins with &.
  try { tab.iframe.src = previewBuildUrl(n, p) + '&_t=' + Date.now(); } catch {}
  try { if (tab.portInput) tab.portInput.value = n; if (tab.pathInput) tab.pathInput.value = p; } catch {}
  saveTabState();
}
function previewReload(tab) {
  if (!tab || tab.type !== 'preview' || !tab.iframe) return;
  try { tab.loadingEl.classList.remove('hidden'); } catch {}
  try { tab.iframe.src = previewBuildUrl(tab.port, tab.previewPath || '/') + '&_t=' + Date.now(); } catch {}
}
function newPreviewTab(port, pth, opts = {}) {
  const parsed = parsePreviewTarget(port, pth == null ? '/' : pth);
  const initialPort = !parsed.error ? parsed.port : (Number.isInteger(parseInt(port, 10)) ? parseInt(port, 10) : 8000);
  let p = !parsed.error ? parsed.path : String(pth || '/');
  if (!p.startsWith('/')) p = '/' + p;
  // Per-port path memory: a bare "/" reopens where you last were on that port.
  // Tab-restore passes useRecent:false so a saved "/" stays "/".
  if ((pth === '/' || pth == null || pth === '') && opts.useRecent !== false) {
    try { const rp = recentPreviewPath(initialPort); if (rp && rp !== '/') p = rp; } catch {}
  }
  const id = ++tabCounter;
  const tab = { id, type: 'preview', port: initialPort, previewPath: p, previewAutoReload: !!opts.auto, previewWidth: opts.width || 'full', title: `App:${initialPort}`, el: null, wrapper: null, iframe: null, closed: false, cwd: currentPath, color: opts.color || '', pinned: !!opts.pinned };
  tabs.push(tab);
  createTabButton(tab);
  createPreviewWrapper(tab);
  activateTab(id);
  previewNavigate(tab, initialPort, p);
  unpinLaunchpad();
  updateLaunchpad();
  return tab;
}
function newPreviewPrompt() {
  const inp = document.getElementById('preview-port-input');
  if (inp) {
    try {
      const recent = getPreviewRecent();
      inp.value = recent.length ? String(recent[0].port) : '8000';
    } catch { inp.value = '8000'; }
    clearFieldError('preview-error');
  }
  openOverlay('preview-overlay');
  setTimeout(() => { try { inp.focus(); inp.select(); } catch {} }, 100);
}
function confirmNewPreview() {
  const raw = (document.getElementById('preview-port-input').value || '').trim();
  const parsed = parsePreviewTarget(raw, '/');
  if (parsed.error) { showFieldError('preview-error', 'Port must be 1–65535 (or paste a localhost URL)'); return; }
  const n = parsed.port;
  clearFieldError('preview-error');
  closeOverlay('preview-overlay');
  newPreviewTab(n, parsed.path || '/');
}
let _portsCache = null, _portsCacheAt = 0;
async function refreshPortsCache(force) {
  if (!force && _portsCache && Date.now() - _portsCacheAt < 15000) return _portsCache;
  try {
    const r = await api('/api/ports');
    if (r && Array.isArray(r.ports)) { _portsCache = r.ports; _portsCacheAt = Date.now(); return _portsCache; }
  } catch {}
  return _portsCache || [];
}
// Port autocomplete for preview bars (listening loopback ports, 15s cache,
// merged with recent ports so a restarted app's port is still one tap away).
async function fillPreviewPorts() {
  let dl = document.getElementById('preview-ports-list');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'preview-ports-list';
    document.body.appendChild(dl);
  }
  try {
    const ports = await refreshPortsCache(false);
    const seen = new Set();
    dl.textContent = '';
    const addOpt = (n, label) => {
      const o = document.createElement('option');
      o.value = String(n);
      o.label = label;
      dl.appendChild(o);
    };
    for (const p of (ports || [])) {
      const n = Number(p && p.port != null ? p.port : p);
      if (!Number.isInteger(n) || seen.has(n)) continue;
      seen.add(n);
      // Process name is untrusted (other users' processes on shared boxes):
      // assigned via .label, never interpolated into HTML.
      const proc = p && p.proc ? ` — ${String(p.proc).slice(0, 32)}` : '';
      addOpt(n, `${n}${proc}`);
      if (seen.size >= 30) break;
    }
    try {
      for (const r of getPreviewRecent()) {
        const n = Number(r.port);
        if (!Number.isInteger(n) || seen.has(n)) continue;
        seen.add(n);
        addOpt(n, `${n} — recent`);
        if (seen.size >= 30) break;
      }
    } catch {}
  } catch {}
}
// Terminal-output scan: suggest "Open preview" when a loopback URL appears.
// Debounced per tab+port (60s), suggestions only — never auto-opens.
const _previewHintSeen = new Map();
function scanPreviewHint(tab, text) {
  if (!text || tab.type !== 'term') return;
  let m = String(text).match(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{1,5})(\/\S*)?/i);
  if (!m) {
    const b = String(text).match(/(?:listening|running|started|ready|port|local:?)\D{0,20}:(\d{4,5})/i);
    if (!b) return;
    m = [b[0], b[1], '/'];
  }
  const port = parseInt(m[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  let pth = '/';
  try { pth = (m[2] || '/').replace(/["'\),;\]]+$/, '') || '/'; if (!pth.startsWith('/')) pth = '/'; } catch { pth = '/'; }
  const key = `${tab.id}:${port}`;
  if (_previewHintSeen.has(key) && Date.now() - _previewHintSeen.get(key) < 60000) return;
  _previewHintSeen.set(key, Date.now());
  // Bound memory: drop the oldest entries past a few hundred tab:port pairs.
  if (_previewHintSeen.size > 500) {
    for (const k of _previewHintSeen.keys()) {
      if (_previewHintSeen.size <= 400) break;
      _previewHintSeen.delete(k);
    }
  }
  previewSuggestToast(port, pth);
}
function previewSuggestToast(port, pth) {
  try {
    const container = document.getElementById('toast-container');
    if (!container) { toast(`App detected on :${port}`, 'info'); return; }
    while (container.children.length >= 4) {
      const kids = [...container.children];
      (kids.find(k => !k.classList.contains('error')) || kids[0]).remove();
    }
    const el = document.createElement('div');
    el.className = 'toast info';
    const label = document.createElement('span');
    label.textContent = `App detected on :${port} — open preview?`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.style.cssText = 'height:26px;padding:0 12px;font-size:12px;margin-left:8px;flex-shrink:0';
    btn.textContent = 'Open preview';
    btn.addEventListener('click', () => { try { el.remove(); } catch {} newPreviewTab(port, pth || '/'); });
    el.appendChild(label);
    el.appendChild(btn);
    el.style.cursor = 'default';
    container.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch {} }, 8000);
  } catch { toast(`App detected on :${port}`, 'info'); }
}
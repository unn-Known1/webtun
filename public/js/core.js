// WebTun frontend - core.js (1/15: shared state, utils, boot/auth, API).

// ═══════════════════════════════════════════════════════
let authToken = '';
let tabs = [];
let activeTabId = null;
let tilesMode = false;
let tabCounter = 0;
let currentPath = '';
let currentParent = '';
let homeDir = '';
let navHistory = [];
let navForwardHistory = [];
let skipHistoryPush = false;
let ctxTarget = null;
let renamePath = '';
let editorPath = '';
let editorOriginalContent = '';
let hasTmux = false;
  let settings = {
  theme: 'light', fontSize: 14, font: "'JetBrains Mono', 'SF Mono', 'Fira Code', Consolas, monospace",
  cursor: 'block', blink: true, scrollback: 5000, bell: false,
  mobilekeys: false, confirmclose: true, datasaver: false, autostart: false, keepAwake: false, termRightClick: true,
  gitEnabled: true, gitSimple: true
};
let serverPlatform = '';

const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

function uuid() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  } catch(e) {
    console.warn('uuid fallback:', e);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }
}

function preventDoubleTap(el, fn, delay = 1000) {
  if (el.dataset.busy === 'true') return;
  el.dataset.busy = 'true';
  el.style.opacity = '0.6';
  el.style.pointerEvents = 'none';
  const unlock = () => {
    setTimeout(() => {
      el.dataset.busy = 'false';
      el.style.opacity = '';
      el.style.pointerEvents = '';
    }, delay);
  };
  try { Promise.resolve(fn()).then(unlock, unlock); } catch(e) { console.warn('preventDoubleTap error:', e); unlock(); }
}

function saveTabState() {
  const state = tabs.map(t => ({ id: t.id, sessionId: t.sessionId, title: t.title, type: t.type || 'term', port: t.port || null, path: t.type === 'file' ? t.path : (t.previewPath || '/'), auto: t.type === 'preview' && t.previewAutoReload ? 1 : 0, width: t.type === 'preview' ? (t.previewWidth || 'full') : undefined }));
  try { safeStorage.setItem('wt-tabs', JSON.stringify(state)); } catch(e) { console.warn('Failed to save tabs:', e); }
}

function loadTabState() {
  try {
    const val = JSON.parse(safeStorage.getItem('wt-tabs'));
    return Array.isArray(val) ? val : [];
  } catch(e) { console.warn('loadTabState error:', e); return []; }
}

function saveCurrentPath() {
  try { safeStorage.setItem('wt-current-path', currentPath); } catch(e) { console.warn('Failed to save path:', e); }
}

function loadCurrentPath() {
  try {
    const val = safeStorage.getItem('wt-current-path');
    return typeof val === 'string' && val ? val : null;
  } catch(e) { console.warn('loadCurrentPath error:', e); return null; }
}

// ════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
function handlePinKeydown(e) {
  if (e.key === 'Enter') submitPin();
}

// ── Last-known server place ─────────────────────────────
// Remembers where this app last reached a server (origin + path, never the
// ?token= credential) so a saved PWA launched while offline can show what it
// last knew and jump straight back there.
let _lastPlaceSaved = '';
function rememberServerPlace() {
  try {
    const u = new URL(location.href);
    u.searchParams.delete('token');
    const key = u.origin + u.pathname + u.search;
    if (key === _lastPlaceSaved) return;
    _lastPlaceSaved = key;
    safeStorage.setItem('wt-last-server', JSON.stringify({
      origin: u.origin, path: u.pathname + u.search, ts: Date.now()
    }));
  } catch {}
}
function loadLastServer() {
  try {
    const o = JSON.parse(safeStorage.getItem('wt-last-server') || 'null');
    if (!o || typeof o.origin !== 'string' || !/^https?:\/\//.test(o.origin)) return null;
    return o;
  } catch { return null; }
}
function lastSeenAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// ── Offline screen (saved-PWA launch while server is down) ──
let _offlineTimer = null;
let _initAttempts = 0;
function showOfflineScreen() {
  const last = loadLastServer();
  const detail = document.getElementById('offline-detail');
  const lastEl = document.getElementById('offline-last');
  const openBtn = document.getElementById('offline-open-last');
  if (last && last.origin !== location.origin) {
    detail.textContent = "Can't reach this address. The server may have moved (tunnel URLs change on restart).";
    lastEl.textContent = 'Last seen ' + lastSeenAgo(last.ts) + ' at ' + last.origin;
    openBtn.style.display = '';
  } else if (last) {
    detail.textContent = "Can't reach the WebTun server. It may be starting up or stopped.";
    lastEl.textContent = 'Last connected ' + lastSeenAgo(last.ts);
    openBtn.style.display = 'none';
  } else {
    detail.textContent = "Can't reach the WebTun server. It may be starting up or stopped.";
    lastEl.textContent = '';
    openBtn.style.display = 'none';
  }
  document.getElementById('offline-screen').classList.remove('hidden');
  if (!_offlineTimer) {
    _offlineTimer = setInterval(() => {
      if (!window._appUnlocked && !document.hidden) init();
    }, 15000);
  }
}
function hideOfflineScreen() {
  document.getElementById('offline-screen').classList.add('hidden');
  if (_offlineTimer) { clearInterval(_offlineTimer); _offlineTimer = null; }
}
function retryServerNow() {
  document.getElementById('pin-error').textContent = '';
  init();
}
function openLastServer() {
  const last = loadLastServer();
  if (last) location.href = last.origin + (last.path || '/');
}

async function init() {
  loadSettings();
  applyTheme(settings.theme, false);

  const r = await api('/api/auth/required');
  if (r && r.required !== undefined) {
    _initAttempts = 0;
    hideOfflineScreen();
    if (r.required) {
      // Trusted device? A stored session token skips the PIN screen.
      if (await tryResumeSession()) return;
      const pinIn = document.getElementById('pin-input');
      pinIn.removeEventListener('keydown', handlePinKeydown);
      pinIn.addEventListener('keydown', handlePinKeydown);
      pinIn.focus();
    } else {
      authToken = 'open';
      unlockApp();
    }
  } else {
    _initAttempts++;
    if (_initAttempts >= 2) {
      // Saved app launched while the server is down: show the offline
      // screen (keeps retrying in the background) instead of dying quietly.
      showOfflineScreen();
      return;
    }
    document.getElementById('pin-error').textContent = 'Server connection failed. Retrying...';
    setTimeout(() => { if (!window._appUnlocked) init(); }, 3000);
  }
}

function clientDeviceLabel() {
  try {
    const ua = navigator.userAgent || '';
    let os = 'Unknown OS';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
    else if (/Mac OS/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    let br = '';
    if (/Edg\//i.test(ua)) br = 'Edge';
    else if (/Chrome\//i.test(ua)) br = 'Chrome';
    else if (/Firefox/i.test(ua)) br = 'Firefox';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) br = 'Safari';
    return (br ? br + ' · ' : '') + os;
  } catch { return ''; }
}
function isSessionToken(t) {
  return typeof t === 'string' && /^[0-9a-f]{64}$/.test(t);
}
function storeSessionToken(t) {
  try {
    // Persist only well-formed session tokens (or clear): a malformed value
    // in storage must never become a credential attempt.
    if (isSessionToken(t)) safeStorage.setItem('wt-session-token', t);
    else safeStorage.removeItem('wt-session-token');
  } catch {}
}
// Resume a trusted device: validate the stored session token without a PIN.
async function tryResumeSession() {
  let t = null;
  try { t = safeStorage.getItem('wt-session-token'); } catch {}
  if (!isSessionToken(t)) { try { safeStorage.removeItem('wt-session-token'); } catch {} return false; }
  authToken = t;
  try {
    const r = await fetch('/api/auth/me', { headers: { 'x-pin-token': t } }).then(r => r.json());
    if (r && r.ok && !r.pending) { unlockApp(); return true; }
    // Stored session is pending approval (page reloaded mid-wait) — resume the wait
    if (r && r.ok && r.pending) { enterWaitingRoom(t, r.expiresAt || 0); return true; }
  } catch {}
  // Stored session is dead (revoked/expired/rotated) — fall through to PIN
  authToken = '';
  storeSessionToken('');
  return false;
}
// Waiting room: this device is locked until a different active session
// approves it. Polls /api/auth/me; approval unlocks, denial/expiry bounces.
let _pendingPollTimer = null;
function stopPendingPoll() {
  try { if (_pendingPollTimer) clearInterval(_pendingPollTimer); } catch {}
  _pendingPollTimer = null;
}
function enterWaitingRoom(token, expiresAt) {
  stopPendingPoll();
  authToken = token;
  storeSessionToken(token);
  const pinError = document.getElementById('pin-error');
  const pinBtn = document.getElementById('pin-unlock-btn');
  setBtnBusy(pinBtn, false);
  const tick = async () => {
    if (expiresAt && Date.now() > expiresAt + 5000) {
      stopPendingPoll();
      if (pinError) pinError.textContent = 'Approval expired — no active session approved in time. Try again.';
      authToken = '';
      storeSessionToken('');
      return;
    }
    try {
      const r = await fetch('/api/auth/me', { headers: { 'x-pin-token': token } }).then(r => r.json());
      if (r && r.ok && !r.pending) {
        stopPendingPoll();
        if (pinError) pinError.textContent = '';
        unlockApp();
      } else if (!r || !r.ok) {
        // 401 (denied/revoked) — me returns {error}, not ok
        stopPendingPoll();
        if (pinError) pinError.textContent = 'Access denied by another device.';
        authToken = '';
        storeSessionToken('');
      } else {
        if (pinError) pinError.textContent = 'Waiting for approval from another signed-in device…';
      }
    } catch {
      if (pinError) pinError.textContent = 'Waiting for approval from another signed-in device…';
    }
  };
  if (pinError) pinError.textContent = 'Waiting for approval from another signed-in device…';
  tick();
  _pendingPollTimer = setInterval(tick, 3000);
}
async function signOut() {
  const t = authToken;
  stopPendingPoll();
  storeSessionToken('');
  authToken = '';
  // Best-effort: revoke our own session server-side (fires before teardown)
  if (t && t !== 'open' && /^[0-9a-f]{64}$/.test(t)) {
    try { await fetch(`/api/auth/sessions/${t}`, { method: 'DELETE', headers: { 'x-pin-token': t } }); } catch {}
  }
  try { document.getElementById('pin-input').value = ''; } catch {}
  window._appUnlocked = false;
  showPinScreen();
  toast('Signed out on this device', 'info');
}

async function submitPin() {
  const pinInput = document.getElementById('pin-input');
  const pinError = document.getElementById('pin-error');
  const pinBox = document.getElementById('pin-box');
  const pinBtn = document.getElementById('pin-unlock-btn');
  if (pinBtn && pinBtn.disabled) return;
  // Client-side brute-force brake (server also rate-limits auth at 5 req/10s).
  if (Date.now() < _pinLockedUntil) {
    const wait = Math.ceil((_pinLockedUntil - Date.now()) / 1000);
    if (pinError) pinError.textContent = `Too many attempts — try again in ${wait}s`;
    return;
  }
  const pin = pinInput.value;
  pinBox.classList.remove('shake');
  stopPendingPoll();
  setBtnBusy(pinBtn, true);
  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, device: clientDeviceLabel() })
    }).then(r => r.json());
    if (r.success) {
      _pinFails = 0; _pinLockedUntil = 0;
      authToken = r.token;
      // Persist session tokens (trusted device); 'open' needs nothing stored.
      // Fresh logins while others are active come back pending — wait it out.
      if (r.pending) {
        setBtnBusy(pinBtn, false);
        enterWaitingRoom(r.token, r.expiresAt || 0);
        return;
      }
      storeSessionToken(r.token);
      unlockApp();
    } else {
      pinError.textContent = r.error || 'Wrong PIN, try again';
      pinInput.value = '';
      pinInput.focus();
      void pinBox.offsetWidth;
      pinBox.classList.add('shake');
      // Progressive lockout: 3+ failures → 5s brake, doubling to a 30s cap.
      _pinFails++;
      if (_pinFails >= 3) {
        _pinLockedUntil = Date.now() + Math.min(5000 * 2 ** (_pinFails - 3), 30000);
      }
    }
  } catch(e) {
    pinError.textContent = 'Connection failed. Is the server running?';
    pinInput.focus();
    void pinBox.offsetWidth;
    pinBox.classList.add('shake');
  }
  if (pinBtn) { setBtnBusy(pinBtn, false); }
}
// Wrong-PIN counter + lockout deadline for the client-side brake above.
let _pinFails = 0, _pinLockedUntil = 0;

async function unlockApp() {
  if (window._appUnlocked) return;
  window._appUnlocked = true;
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app').style.display = 'flex';
  // Restore a persistent security triangle from unreviewed logins
  try { renderSecurityAlert(); } catch {}
  // Live session count on the coffee cup + slow refresh for stragglers
  try { updateSessionCupCount(); } catch {}
  // Live CPU/MEM gauge on the system-stats icon (10s pulse, skips when hidden/datasaver)
  try { startSysIconPulse(); } catch {}
  try {
    if (!window._sessCupTimer) {
      window._sessCupTimer = setInterval(() => {
        if (!document.hidden && window._appUnlocked) { try { updateSessionCupCount(); } catch {} }
      }, 60000);
    }
  } catch {}

  const info = await api('/api/home');
  homeDir = info.home;
  serverPlatform = info.platform || '';
  document.getElementById('hostname-badge').textContent = info.hostname || '—';

  // Restore last visited path
  const savedPath = loadCurrentPath();
  if (savedPath) {
    try {
      // Validate saved path is within workspace or full fs is allowed
      currentPath = savedPath;
    } catch(e) {
      currentPath = homeDir;
    }
  } else {
    currentPath = homeDir;
  }

  // Check tmux availability
  const sessInfo = await api('/api/sessions');
  hasTmux = sessInfo.tmux === true;

  // About version (authed endpoint — must run after unlock when authToken is set)
  try { refreshVersion(); } catch {}

  loadFiles(currentPath);
  renderBookmarks();
  restoreTunnels();
  setupMobileKeys();

  // ── One-time wiring ────────────────────────────────────────────────────
  // Everything below binds global document/window listeners. unlockApp() runs
  // again after sign-out → re-login, and re-running this block stacked
  // duplicate handlers, so a single Ctrl+T opened N tabs and one Escape
  // toggled overlays repeatedly. `_cleanups` is only flushed on pagehide, so
  // it must not be reset here either — the old callbacks are still live.
  if (!window._wiringDone) {
    window._wiringDone = true;
    window._cleanups = window._cleanups || [];
    startScreensaverWatch();
    setupDragDrop();
    setupTabBarDnD();
    setupKeyboardShortcuts();
    startFileWatcher();
    const onResizeMobileKeys = () => { clearTimeout(window._resizeMkTimer); window._resizeMkTimer = setTimeout(setupMobileKeys, 150); };
    window.addEventListener('resize', onResizeMobileKeys);
    window._cleanups.push(() => window.removeEventListener('resize', onResizeMobileKeys));
    registerSW();
    setupSwipeGestures();
    setupFileListTouch();
    setupFileListClicks();
    setupFileListKeyboard();
    setupFileListContextMenu();
    setupCtxMenuKeyboard();
    setupMoreMenuKeyboard();
    restoreSidebarWidth();
    setupSidebarResize();
    setupEditorResize();
    window.addEventListener('resize', updateSidebarNarrowClass);
    window._cleanups.push(() => window.removeEventListener('resize', updateSidebarNarrowClass));
    document.getElementById('tab-scroll').setAttribute('role', 'tablist');
    document.getElementById('file-list-wrap').setAttribute('role', 'listbox');

    // Arrow-key navigation between tabs when focus is in the tab strip
    document.getElementById('tab-scroll').addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        cycleTab(e.key === 'ArrowRight' ? 1 : -1);
        const t = getActiveTab();
        if (t?.el) t.el.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (tabs.length) { activateTab(tabs[0].id); tabs[0].el.focus(); }
      } else if (e.key === 'End') {
        e.preventDefault();
        if (tabs.length) { activateTab(tabs[tabs.length - 1].id); tabs[tabs.length - 1].el.focus(); }
      }
    });

    // Listen for system theme changes
    const systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => { if (settings.theme === 'system') applyTheme('system'); };
    systemThemeMql.addEventListener('change', onSystemThemeChange);
    window._cleanups.push(() => systemThemeMql.removeEventListener('change', onSystemThemeChange));
  }

  // Restore tabs from last session, or open a fresh one
  const saved = loadTabState();
  if (saved.length > 0) {
    (async () => {
      for (const s of saved) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try {
          if (s.type === 'preview' && s.port) newPreviewTab(s.port, s.path || '/', { useRecent: false, auto: !!s.auto, width: s.width || 'full' });
          // File tabs come back parked: only the last tab is activated below, so a
          // reload does not force the editor panel into a tab.
          else if (s.type === 'file' && s.path) newFileTab(s.path, { mount: false });
          else newTab(s.title, s.sessionId);
        } catch (e) { console.warn('Tab restore failed:', e); }
      }
      // newFileTab({ mount: false }) never activates, so a session that ended on a
      // file tab would otherwise restore to a blank terminals area.
      const lastTab = tabs[tabs.length - 1];
      if (lastTab) activateTab(lastTab.id);
    })();
  } else {
    newTab();
  }

  // App/PWA shortcut (?newTerm=1 from the manifest): it had no handler, so the
  // shortcut was just a duplicate of a normal launch.
  try {
    if (new URLSearchParams(location.search).get('newTerm') === '1') newTab();
  } catch {}

  // Same one-time rule as the wiring block above: this reads the live `tabs`
  // array, so it must only ever be registered once.
  if (!window._visibilityWired) {
    window._visibilityWired = true;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        tabs.forEach(tab => {
          if (tab.closed) return;
          if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) {
            if (!tab.reconnectTimer) {
              tab.reconnectDelay = 1000;
              connectWebSocket(tab, true);
            }
          }
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window._cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

    window.addEventListener('pagehide', () => {
      window._cleanups?.forEach(fn => { try { fn(); } catch(e) { console.warn(e); } });
      window._cleanups = [];
    });
  }
}

// ═══════════════════════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════════════════════
async function api(url, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers['x-pin-token'] = authToken;
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(), 30000);
  const userSignal = opts.signal || null;
  if (userSignal) {
    userSignal.addEventListener('abort', () => timeoutCtrl.abort(), { once: true });
  }
  opts.signal = timeoutCtrl.signal;
  try {
    const r = await fetch(url, opts);
    clearTimeout(timeoutId);
    try { rememberServerPlace(); } catch {}
    // 401 must surface as an error object (never {}) so callers like
    // changePin() can't mistake rejection for success.
    if (!r.ok && r.status === 401) { showPinScreen(); return { error: 'Unauthorized' }; }
    if (!r.ok) { try { return await r.json(); } catch { return { error: 'Request failed (' + r.status + ')' }; } }
    try { return await r.json(); } catch(e) { console.warn('api() JSON parse error:', e); return {}; }
  } catch(e) {
    clearTimeout(timeoutId);
    if (userSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    console.warn('api() fetch error:', e);
    if (e && e.name === 'AbortError') return { error: 'Request timed out (30s)' };
    return { error: 'Network error' };
  }
}

// Send terminal input in ≤60KB frames (server caps input per message).
// Splits on char boundaries, never inside a surrogate pair.
function sendWsInput(ws, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !text) return;
  const CHUNK_CHARS = 15000; // ~45KB worst case, safely under the cap
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) end--;
      if (end <= i) end = i + 1;
    }
    const enc = new TextEncoder().encode(text.slice(i, end));
    const buf = new Uint8Array(1 + enc.length);
    buf[0] = 0x00; buf.set(enc, 1);
    ws.send(buf.buffer);
    i = end;
  }
}

function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

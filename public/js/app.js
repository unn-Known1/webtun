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
function storeSessionToken(t) {
  try {
    if (t && t !== 'open') safeStorage.setItem('wt-session-token', t);
    else safeStorage.removeItem('wt-session-token');
  } catch {}
}
// Resume a trusted device: validate the stored session token without a PIN.
async function tryResumeSession() {
  let t = null;
  try { t = safeStorage.getItem('wt-session-token'); } catch {}
  if (!t || t === 'open') return false;
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
    }
  } catch(e) {
    pinError.textContent = 'Connection failed. Is the server running?';
    pinInput.focus();
    void pinBox.offsetWidth;
    pinBox.classList.add('shake');
  }
  setBtnBusy(pinBtn, false);
}

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
  const combinedSignal = opts.signal = timeoutCtrl.signal;
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

// ═══════════════════════════════════════════════════════
// TERMINAL TABS
// ═══════════════════════════════════════════════════════
function nextTermNumber() {
  const used = new Set(tabs.map(t => {
    const m = t.title.match(/^Term (\d+)$/);
    return m ? parseInt(m[1]) : 0;
  }));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function setupTabDragDrop(tabEl, id) {
  tabEl.addEventListener('dragstart', e => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    tabEl.classList.add('dragging');
  });
  tabEl.addEventListener('dragenter', e => { e.preventDefault(); tabEl.classList.add('drag-over'); });
  tabEl.addEventListener('dragleave', () => { tabEl.classList.remove('drag-over'); });
  tabEl.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  const finishDrop = (fromId) => {
    if (isNaN(fromId) || fromId === id) return;
    const fromIdx = tabs.findIndex(t => t.id === fromId);
    if (fromIdx === -1) return;
    const [moved] = tabs.splice(fromIdx, 1);
    const targetIdx = tabs.findIndex(t => t.id === id);
    tabs.splice(targetIdx, 0, moved);
    const bar = document.getElementById('tab-scroll');
    if (moved.el && moved.el.parentNode === bar) bar.insertBefore(moved.el, tabEl);
    saveTabState();
  };
  tabEl.addEventListener('drop', e => {
    e.preventDefault();
    tabEl.classList.remove('drag-over');
    [...document.querySelectorAll('.tab-drop-placeholder')].forEach(el => el.remove());
    const fromId = parseInt(e.dataTransfer.getData('text/plain'));
    finishDrop(fromId);
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    tabEl.classList.remove('drag-over');
    [...document.querySelectorAll('.tab-drop-placeholder')].forEach(el => el.remove());
  });
}

function setupTabInlineRename(tabTitleSpan, tab) {
  const startRename = (span) => {
    const input = document.createElement('input');
    input.id = 'tab-rename-input';
    input.name = 'tab-rename';
    input.type = 'text';
    input.value = tab.title;
    input.style.cssText = `width:${Math.max(60, tab.title.length * 9)}px;height:22px;font-size:12px;padding:0 6px`;
    span.replaceWith(input);
    input.focus();
    input.select();
    const done = () => {
      const val = input.value.trim() || tab.title;
      tab.title = val;
      const newSpan = document.createElement('span');
      newSpan.className = 'tab-title';
      newSpan.textContent = val;
      input.replaceWith(newSpan);
      saveTabState();
    };
    input.addEventListener('blur', done);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); input.value = tab.title; input.blur(); }
    });
  };
  tabTitleSpan.addEventListener('dblclick', e => {
    e.stopPropagation();
    startRename(e.target);
  });
  let renameTimer = null;
  tabTitleSpan.addEventListener('touchstart', () => {
    renameTimer = setTimeout(() => { renameTimer = null; startRename(tabTitleSpan); }, 400);
  }, { passive: true });
  tabTitleSpan.addEventListener('touchend', () => {
    if (renameTimer) { clearTimeout(renameTimer); renameTimer = null; }
  }, { passive: true });
  tabTitleSpan.addEventListener('touchmove', () => {
    if (renameTimer) { clearTimeout(renameTimer); renameTimer = null; }
  }, { passive: true });
}

function setupTabSwipeGesture(tabEl, id) {
  let swipeStartX = 0, swipeStartY = 0;
  let swipeStartScroll = 0;
  tabEl.addEventListener('touchstart', e => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipeStartScroll = tabEl.parentElement.scrollLeft;
  }, { passive: true });
  tabEl.addEventListener('touchmove', e => {
    if (swipeStartX === 0) return;
    if (tabEl.parentElement.scrollLeft !== swipeStartScroll) { swipeStartX = 0; return; }
    const dx = e.touches[0].clientX - swipeStartX;
    const dy = e.touches[0].clientY - swipeStartY;
    // Require horizontal swipe dominant (dx > dy*1.5) to avoid scroll confusion (U59)
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (Math.abs(dx) > 5) {
      e.preventDefault();
      tabEl.style.transform = `translateX(${dx}px)`;
      tabEl.style.opacity = Math.max(0.3, 1 - Math.abs(dx) / 200);
      tabEl.style.background = `rgba(247,118,142,${Math.min(Math.abs(dx) / 80, 1) * 0.2})`;
    }
  }, { passive: false });
  tabEl.addEventListener('touchend', e => {
    if (swipeStartX === 0) return;
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    tabEl.style.transform = '';
    tabEl.style.opacity = '';
    tabEl.style.background = '';
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5) closeTab({ stopPropagation() {} }, id);
    swipeStartX = 0; swipeStartY = 0;
  }, { passive: true });
}

function createTabButton(tab) {
  const id = tab.id;
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.setAttribute('role', 'tab');
  tabEl.setAttribute('aria-selected', 'false');
  // Roving tabindex: only the active tab is in the tab order, so Tab reaches
  // the strip and the arrow keys move between tabs (activateTab updates this).
  tabEl.tabIndex = -1;
  tabEl.dataset.id = id;
  tabEl.draggable = true;

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '12'); icon.setAttribute('height', '12'); icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2');
  if (tab.type === 'preview') {
    tabEl.classList.add('preview-tab');
    icon.innerHTML = '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
  } else if (tab.type === 'file') {
    tabEl.classList.add('file-tab');
    icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
  } else {
    icon.innerHTML = '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>';
  }
  tabEl.appendChild(icon);

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = tab.title;
  tabEl.appendChild(titleSpan);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.setAttribute('aria-label', 'Close tab');
  closeBtn.onclick = e => closeTab(e, id);
  closeBtn.title = 'Close';
  const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  closeSvg.setAttribute('width', '10'); closeSvg.setAttribute('height', '10'); closeSvg.setAttribute('viewBox', '0 0 24 24');
  closeSvg.setAttribute('fill', 'none'); closeSvg.setAttribute('stroke', 'currentColor'); closeSvg.setAttribute('stroke-width', '2.5');
  closeSvg.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
  closeBtn.appendChild(closeSvg);
  tabEl.appendChild(closeBtn);

  tabEl.addEventListener('click', e => { if (!e.target.closest('.tab-close')) { unpinLaunchpad(); activateTab(id); } });

  setupTabDragDrop(tabEl, id);
  setupTabInlineRename(titleSpan, tab);
  setupTabSwipeGesture(tabEl, id);

  const scroll = document.getElementById('tab-scroll');
  const anchor = document.getElementById('new-tab-btn');
  if (anchor && anchor.parentElement === scroll) scroll.insertBefore(tabEl, anchor);
  else scroll.appendChild(tabEl);
  tab.el = tabEl;
}

function createTerminalWrapper(tab) {
  const wrapper = document.createElement('div');
  wrapper.className = 'term-wrapper';
  wrapper.dataset.id = tab.id;
  const loading = document.createElement('div');
  loading.className = 'term-loading';
  loading.innerHTML = '<span class="tl-spinner"></span><span>Connecting…</span>';
  wrapper.appendChild(loading);
  tab.loadingEl = loading;
  document.getElementById('terminals').appendChild(wrapper);
  tab.wrapper = wrapper;
}

function hideTermLoading(tab) {
  if (tab && tab.loadingEl) tab.loadingEl.classList.add('hidden');
}

function newTab(title, sessionId, dir) {
  const id = ++tabCounter;
  const sid = sessionId || uuid();
  const tab = { id, type: 'term', sessionId: sid, title: title || `Term ${nextTermNumber()}`, term: null, fitAddon: null, searchAddon: null, ws: null, el: null, wrapper: null, closed: false, reconnectDelay: 1000, dataDisposable: null, resizeDisposable: null, resizeObserver: null, cwd: dir || currentPath };
  tabs.push(tab);
  createTabButton(tab);
  createTerminalWrapper(tab);
  activateTab(id);
  setTimeout(() => { initTerminal(tab); if (tilesMode) layoutTiles(); }, 50);
  saveTabState();
  unpinLaunchpad();
  updateLaunchpad();
  return tab;
}

function activateTab(id) {
  activeTabId = id;
  tabs.forEach(t => {
    t.el?.classList.toggle('active', t.id === id);
    if (t.el) {
      t.el.setAttribute('aria-selected', t.id === id ? 'true' : 'false');
      t.el.tabIndex = t.id === id ? 0 : -1;
    }
    if (t.wrapper) {
      t.wrapper.classList.toggle('active', t.id === id);
      // Wire tab ↔ panel for assistive tech (ids are generated once).
      if (!t.wrapper.id) t.wrapper.id = 'tabpanel-' + t.id;
      if (!t.wrapper.getAttribute('role')) t.wrapper.setAttribute('role', 'tabpanel');
      if (t.el) {
        if (!t.el.id) t.el.id = 'tab-' + t.id;
        t.el.setAttribute('aria-controls', t.wrapper.id);
        t.wrapper.setAttribute('aria-labelledby', t.el.id);
      }
    }
  });
  const tab = tabs.find(t => t.id === id);
  if (tab?.fitAddon) setTimeout(() => fitTerm(tab), 60);
  // Mobile key bar is terminal-only — hide it for preview and file tabs.
  try {
    const mk = document.getElementById('mobile-keys');
    const selRow = document.getElementById('mkey-sel-row');
    if (mk) {
      const isPlain = !tab || (tab.type !== 'preview' && tab.type !== 'file');
      mk.style.display = (isPlain && settings.mobilekeys && window.innerWidth <= 768) ? 'flex' : 'none';
      if (!isPlain && selRow) selRow.style.display = 'none';
    }
  } catch {}
  // File tabs share one editor panel: mount it into the tab that just became
  // active, and hand it back to its own split when any other tab takes over.
  if (tab && tab.type === 'file') mountFileTab(tab);
  else if (_dockedFileTabId != null) undockEditor();
}

// ── File tabs: open a file as its own tab ────────────────────────────────
// Design note: a file tab does NOT re-implement the viewers. The single
// #editor-view panel is *relocated* into the active file tab's wrapper, and moved
// back when a terminal/preview tab takes over. Because only one file tab is mounted
// at a time (PDF/EPUB/Office hold whole documents in memory), every opener, id and
// toolbar keeps working untouched, and tiles view works via layoutTiles().
// Image tabs are the exception: they render their own <img> and stay live, since a
// decoded image costs almost nothing.
const MAX_FILE_TABS = 10;
let _editorParkParent = null;    // where #editor-view lives in panel mode
let _editorParkNext = null;      // original next sibling, so order is restored
let _dockedFileTabId = null;     // file tab currently owning the panel
let _undockRestoresPanel = false; // was the panel showing in its own split?

function editorViewEl() { return document.getElementById('editor-view'); }
function fileTabName(path) { return path.split(/[\\/]/).pop() || path; }
function findFileTab(path) { return tabs.find(t => t.type === 'file' && t.path === path && !t.closed); }
function fileTabCount() { return tabs.filter(t => t.type === 'file').length; }
function fileTabViewerKind(path) {
  if (isImageFile(path)) return 'image';
  if (isPdfFile(path)) return 'pdf';
  if (isEpubFile(path)) return 'epub';
  if (isOfficeFile(path)) return 'office';
  return 'text';
}

function rememberEditorPark() {
  if (_editorParkParent) return;
  const ev = editorViewEl();
  if (!ev || !ev.parentElement) return;
  // Never record a tab wrapper as the park — that is the docked position.
  if (ev.parentElement.classList.contains('term-wrapper')) return;
  _editorParkParent = ev.parentElement;
  _editorParkNext = ev.nextElementSibling;
}

function createFileWrapper(tab) {
  const wrapper = document.createElement('div');
  wrapper.className = 'term-wrapper file-wrapper';
  wrapper.dataset.id = tab.id;
  const body = document.createElement('div');
  body.className = 'file-tab-body';
  const card = document.createElement('div');
  card.className = 'file-tab-card';
  const badge = document.createElement('div');
  badge.className = 'ftc-badge';
  badge.textContent = tab.viewer === 'text' ? 'Code file' : 'File tab';
  const name = document.createElement('div');
  name.className = 'ftc-name';
  name.textContent = fileTabName(tab.path);
  const hint = document.createElement('div');
  hint.className = 'ftc-hint';
  // Text tabs are only unmounted until they are first opened; the heavy viewers are
  // parked on purpose (one at a time, so a pile of PDFs can't eat memory).
  hint.textContent = tab.viewer === 'text' ? 'Activate this tab to open the file.'
    : tab.viewer === 'image' ? 'Activate this tab to load the image.'
    : 'WebTun keeps one large document open at a time so PDFs and ebooks stay cheap. Activate this tab to bring it back.';
  const open = document.createElement('button');
  open.className = 'btn btn-primary ftc-open';
  open.type = 'button';
  open.textContent = 'Open';
  open.addEventListener('click', () => activateTab(tab.id));
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', fileTabName(tab.path) + ' — not open');
  card.appendChild(badge); card.appendChild(name); card.appendChild(hint); card.appendChild(open);
  wrapper.appendChild(body);
  wrapper.appendChild(card);
  document.getElementById('terminals').appendChild(wrapper);
  tab.wrapper = wrapper;
  tab.bodyEl = body;
  tab.cardEl = card;
}

function newFileTab(path, opts = {}) {
  if (!path) return null;
  const existing = findFileTab(path);
  if (existing) { activateTab(existing.id); return existing; }
  if (fileTabCount() >= MAX_FILE_TABS) {
    toast('Keep at most ' + MAX_FILE_TABS + ' file tabs open — close one first', 'warning');
    return null;
  }
  const id = ++tabCounter;
  const tab = {
    id, type: 'file', path, viewer: fileTabViewerKind(path), title: fileTabName(path),
    el: null, wrapper: null, bodyEl: null, cardEl: null, closed: false,
    mountedOnce: false, dirty: false, viewState: null, seed: null, imgUrl: null,
    cwd: currentPath,
  };
  tabs.push(tab);
  createTabButton(tab);
  createFileWrapper(tab);
  saveTabState();
  unpinLaunchpad();
  updateLaunchpad();
  if (opts.mount !== false) activateTab(id);
  return tab;
}

// Move the panel into `tab`, after stashing the outgoing owner's state.
function dockEditorToTab(tab) {
  const ev = editorViewEl();
  if (!ev || !tab || !tab.bodyEl) return;
  rememberEditorPark();
  if (_dockedFileTabId && _dockedFileTabId !== tab.id) captureFileTabState(tabs.find(t => t.id === _dockedFileTabId));
  if (_dockedFileTabId !== tab.id) {
    // If the panel was showing in its own split, hand it back on undock.
    _undockRestoresPanel = !tab._cameFromPanel && ev.classList.contains('open') && ev.parentElement === _editorParkParent;
  }
  ev.classList.add('docked');
  tab.bodyEl.appendChild(ev);
  tab.bodyEl.style.display = 'flex';
  if (tab.cardEl) tab.cardEl.hidden = true;
  _dockedFileTabId = tab.id;
  // The toggle would be a no-op now: this file is already its own tab.
  const tabBtn = document.getElementById('editor-tab-toggle');
  if (tabBtn) { tabBtn.title = 'Already open in a tab — click the tab to switch'; tabBtn.setAttribute('aria-label', 'Already open in a tab'); }
  // A docked panel must not also claim the terminal split layout.
  document.body.classList.add('editor-docked');
  const content = document.getElementById('content');
  if (content) content.classList.remove('editor-open');
  requestAnimationFrame(() => { try { editor?.refresh(); } catch (_) {} });
}

// Give the panel back to its park position. `keepCard` false hides the outgoing
// tab's card too (used when that tab is being closed).
function undockEditor(keepCard = true) {
  const tab = tabs.find(t => t.id === _dockedFileTabId);
  if (tab) captureFileTabState(tab);
  const ev = editorViewEl();
  if (ev) {
    ev.classList.remove('docked');
    if (_editorParkParent) {
      if (_editorParkNext && _editorParkNext.parentElement === _editorParkParent) _editorParkParent.insertBefore(ev, _editorParkNext);
      else _editorParkParent.appendChild(ev);
    }
    const content = document.getElementById('content');
    if (!_undockRestoresPanel) {
      ev.classList.remove('open');
      if (content) content.classList.remove('editor-open');
    } else if (content) {
      // Panel goes back to its own split: it needs its resize handle again.
      content.classList.add('editor-open');
    }
  }
  if (tab && keepCard) {
    if (tab.bodyEl && tab.viewer !== 'image') tab.bodyEl.style.display = 'none';
    if (tab.cardEl && tab.viewer !== 'image') tab.cardEl.hidden = false;
  }
  _dockedFileTabId = null;
  const tabBtn = document.getElementById('editor-tab-toggle');
  if (tabBtn) { tabBtn.title = 'Open in a tab — keep it alongside your terminals'; tabBtn.setAttribute('aria-label', 'Open in a tab'); }
  document.body.classList.remove('editor-docked');
}

// Snapshot whatever the live viewer is showing so switching tabs can restore it.
function captureFileTabState(tab) {
  if (!tab || tab.type !== 'file' || !tab.mountedOnce) return;
  try {
    // Text tabs keep their own live CodeMirror, so there is nothing to snapshot here.
    if (tab.viewer === 'pdf') {
      tab.viewState = { page: _pdfCurrentPage, scale: _pdfScale };
    } else if (tab.viewer === 'office') {
      const w = document.getElementById('office-wrap');
      const sel = document.getElementById('office-sheet-sel');
      tab.viewState = { scroll: w ? w.scrollTop : 0, sheet: sel && sel.style.display !== 'none' ? sel.value : null };
    }
  } catch (e) { console.warn('captureFileTabState failed:', e); }
}

// Image tabs render their own <img> (openImageViewer is a lightbox overlay, not a
// panel view) and stay mounted, so they cost nothing when inactive.
async function mountImageIntoTab(tab) {
  const body = tab.bodyEl;
  if (!body) return;
  if (!body.dataset.mounted) {
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'file-tab-imgwrap';
    const img = document.createElement('img');
    img.alt = fileTabName(tab.path);
    wrap.appendChild(img);
    body.appendChild(wrap);
    body.dataset.mounted = '1';
    tab.imgEl = img;
    tab.imgWrap = wrap;
  }
  body.style.display = 'flex';
  if (tab.cardEl) tab.cardEl.hidden = true;
  if (tab.imgUrl) return;
  try {
    const r = await fetch(`/api/files/image?path=${encodeURIComponent(tab.path)}&_t=${Date.now()}`, { headers: { 'x-pin-token': authToken } });
    if (!r.ok) throw new Error('Failed to load image');
    const blob = await r.blob();
    if (tab.closed) return;
    tab.imgUrl = URL.createObjectURL(blob);
    tab.imgEl.src = tab.imgUrl;
  } catch (e) {
    try {
      tab.imgWrap.innerHTML = '';
      const fail = document.createElement('div');
      fail.className = 'ftc-fail';
      fail.textContent = 'Failed to load image — use Download instead.';
      tab.imgWrap.appendChild(fail);
    } catch (_) {}
  }
}

async function mountFileTab(tab) {
  if (!tab || tab.type !== 'file' || tab.closed) return;
  if (tab.viewer === 'image') {
    try { await mountImageIntoTab(tab); } catch (e) { console.warn('Image tab failed:', e); }
    return;
  }
  // Text tabs own a live CodeMirror, so there is nothing to re-mount or restore: just
  // reveal it (and re-measure, in case it was hidden).
  if (tab.viewer === 'text') {
    const ok = await ensureTabEditor(tab, tab.seed);
    tab.seed = null;
    if (!ok || tab.closed) { abandonFileTab(tab); return; }
    showTabEditor(tab);
    tab.mountedOnce = true;
    // Only steal focus for the tab the user actually activated — Tile view mounts the
    // others in the background.
    if (activeTabId === tab.id) { try { tab.cm.focus(); } catch {} }
    return;
  }
  // Heavy viewers (PDF/EPUB/Office) hold whole documents in memory, so only one is
  // live at a time: the shared panel is relocated into the tab that owns it. If this
  // tab already owns the live viewer, just show it again — re-opening would re-fetch
  // the document and lose the scroll position.
  if (tab.mountedOnce && _dockedFileTabId === tab.id && editorPath === tab.path) {
    if (activeTabId === tab.id) { try { editor?.focus(); } catch {} }
    return;
  }
  dockEditorToTab(tab);
  const s = tab.viewState;
  try {
    if (tab.viewer === 'pdf') {
      if (s && s.scale) _pdfScale = s.scale;
      await openPdfViewer(tab.path);
    } else if (tab.viewer === 'epub') {
      await openEpubViewer(tab.path);
    } else if (tab.viewer === 'office') {
      await openOfficeViewer(tab.path);
    }
  } catch (e) { console.warn('File tab open failed:', e); }
  // Every opener sets editorPath before its async work and bails out with a toast for
  // files it cannot render. A refusal would leave this tab labelled with a file the
  // panel is not actually showing, so drop the tab rather than desync it.
  if (editorPath !== tab.path) { abandonFileTab(tab); return; }
  tab.mountedOnce = true;
  if (tab.viewer === 'pdf' && s && s.page > 1) {
    setTimeout(() => { try { document.getElementById('pdf-wrap-' + s.page)?.scrollIntoView(); } catch (_) {} }, 450);
  } else if (tab.viewer === 'office' && s) {
    setTimeout(() => {
      try {
        if (s.sheet != null) officeSheetChanged(s.sheet);
        const w = document.getElementById('office-wrap');
        if (w) w.scrollTop = s.scroll || 0;
      } catch (_) {}
    }, 350);
  }
}

function releaseFileTabResources(tab) {
  if (!tab) return;
  // Destroy heavy viewer docs when this tab owned them.
  if (_dockedFileTabId === tab.id) { tab.mountedOnce = false; try { cleanupDocViewers(); } catch (_) {} }
  try { if (tab.imgUrl) { URL.revokeObjectURL(tab.imgUrl); tab.imgUrl = null; } } catch (_) {}
  clearTimeout(tab.draftTimer);
  clearTimeout(tab.previewTimer);
  try { if (tab.previewDocUrl) { URL.revokeObjectURL(tab.previewDocUrl); tab.previewDocUrl = null; } } catch (_) {}
  // Drop the CodeMirror instance along with the tab; removing the wrapper disposes of
  // its DOM, and this releases our last reference to the view.
  tab.cm = null;
  tab.viewState = null;
}

// ── Per-tab text editors ─────────────────────────────────────────────────
// A text file tab owns a real CodeMirror instance. That is what lets Tile view show
// several files side by side, and it means switching tabs never re-reads or re-renders
// anything. Only the heavy viewers (PDF/EPUB/Office) stay single-live: they hold whole
// documents in memory and keep using the relocated panel.
function buildTabEditorChrome(tab) {
  const body = tab.bodyEl;
  if (!body) return;
  body.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'fte-bar';
  const dot = document.createElement('span');
  dot.className = 'fte-dot';
  dot.setAttribute('role', 'status');
  dot.setAttribute('aria-label', 'No unsaved changes');
  const name = document.createElement('span');
  name.className = 'fte-name';
  name.textContent = fileTabName(tab.path);
  name.title = tab.path;
  const status = document.createElement('span');
  status.className = 'fte-status';
  const spacer = document.createElement('span');
  spacer.className = 'fte-spacer';
  const save = document.createElement('button');
  save.className = 'btn btn-primary fte-btn';
  save.type = 'button';
  save.textContent = 'Save';
  save.title = 'Save this file (Ctrl+S)';
  save.addEventListener('click', () => saveTabFile(tab));
  const panel = document.createElement('button');
  panel.className = 'btn fte-btn';
  panel.type = 'button';
  panel.textContent = 'Panel';
  panel.title = 'Move into the split panel — preview, fullscreen and split layout';
  panel.addEventListener('click', () => moveTabToPanel(tab));
  const reload = document.createElement('button');
  reload.className = 'btn fte-btn';
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.title = 'Discard edits and re-read the file from disk';
  reload.addEventListener('click', () => reloadTabFile(tab));
  bar.append(dot, name, status, spacer, save, panel, reload);
  // Markdown / HTML tabs get a Preview toggle (+ Full for HTML), mirroring
  // the panel. The renderers below reuse the panel's pure helpers
  // (toPreviewApiUrl, rewriteFullHtmlUrls, rewriteHtmlRelativeUrls) but keep
  // their own DOM + blob URLs — the panel globals stay untouched.
  const pvKind = tabPreviewKind(tab);
  if (pvKind) {
    const pv = document.createElement('button');
    pv.className = 'btn fte-btn';
    pv.type = 'button';
    pv.textContent = 'Preview';
    pv.title = pvKind === 'html' ? 'Preview rendered page' : 'Preview rendered markdown';
    pv.addEventListener('click', () => toggleTabPreview(tab));
    bar.append(pv);
    tab.ftePreviewBtn = pv;
    if (pvKind === 'html') {
      const full = document.createElement('button');
      full.className = 'btn btn-ghost fte-btn';
      full.type = 'button';
      full.textContent = 'Full';
      full.title = 'Full preview — run this file\u2019s scripts in an isolated frame (no access to the app)';
      full.setAttribute('aria-pressed', 'false');
      full.style.display = 'none';
      full.addEventListener('click', () => toggleTabFullPreview(tab));
      bar.append(full);
      tab.fteFullBtn = full;
    }
  }
  const host = document.createElement('div');
  host.className = 'fte-host';
  body.append(bar, host);
  if (pvKind) {
    const prev = document.createElement('div');
    prev.className = 'fte-preview';
    prev.hidden = true;
    if (pvKind === 'md') {
      const md = document.createElement('div');
      md.className = 'fte-md';
      prev.appendChild(md);
      tab.fteMd = md;
    } else {
      const frame = document.createElement('iframe');
      frame.className = 'fte-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', 'Preview of ' + fileTabName(tab.path));
      frame.style.display = 'none';
      prev.appendChild(frame);
      tab.fteFrame = frame;
    }
    body.append(prev);
    tab.ftePreview = prev;
  }
  tab.fteDot = dot; tab.fteName = name; tab.fteStatus = status; tab.fteHost = host; tab.fteSaveBtn = save;
}

// `seed` ({content, original, history, cursor}) lets a buffer move from the panel into
// the tab without a disk round-trip and without losing edits or undo history.
async function ensureTabEditor(tab, seed) {
  if (tab.cm) return true;
  const data = seed || await readTextForEditor(tab.path);
  if (!data || tab.closed) return false;
  buildTabEditorChrome(tab);
  if (!tab.fteHost) return false;
  const cm = CodeMirror(tab.fteHost, Object.assign({}, CM_BASE_OPTIONS, {
    value: data.content,
    extraKeys: {
      'Ctrl-S': () => saveTabFile(tab),
      'Cmd-S': () => saveTabFile(tab),
      // Esc is intentionally inert in a tile: there is no panel to close here.
      'Esc': () => {},
    },
  }));
  tab.cm = cm;
  tab.original = data.original != null ? data.original : data.content;
  if (data.history) { try { cm.setHistory(data.history); } catch (e) { console.warn('Undo history restore failed:', e); } }
  if (data.cursor) { try { cm.setCursor(data.cursor); } catch {} }
  cm.on('change', () => { markTabDirty(tab); scheduleTabDraft(tab); scheduleTabPreview(tab); });
  markTabDirty(tab);
  try { cm.setOption('mode', await resolveCMmode(fileTabName(tab.path))); } catch (e) { console.warn('Mode resolve failed:', e); }
  return !tab.closed;
}

function showTabEditor(tab) {
  if (tab.bodyEl) tab.bodyEl.style.display = 'flex';
  if (tab.cardEl) tab.cardEl.hidden = true;
  // A tile that was hidden has a stale viewport, so re-measure.
  requestAnimationFrame(() => { try { tab.cm?.refresh(); } catch {} });
}

function showTabEditor(tab) {
  if (tab.bodyEl) tab.bodyEl.style.display = 'flex';
  if (tab.cardEl) tab.cardEl.hidden = true;
  // A tile that was hidden has a stale viewport, so re-measure.
  requestAnimationFrame(() => { try { tab.cm?.refresh(); } catch {} });
}

// ── Per-tab preview (markdown + HTML) ──────────────────────────────────────
// Same output contract as the panel preview, but tab-local: own toggle state,
// own debounced live render, own blob URL. Supported kinds only — other text
// files keep the code-only tab (Preview button hidden).
function tabPreviewKind(tab) {
  if (!tab || tab.type !== 'file' || tab.viewer !== 'text' || !tab.path) return null;
  if (/\.html?$/i.test(tab.path)) return 'html';
  if (/\.md$|\.markdown$|\.mdown$/i.test(tab.path)) return 'md';
  return null;
}
function tabBaseDir(p) {
  p = p || '';
  if (!p) return '';
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx > 0 ? p.slice(0, idx) : p;
}
function toggleTabPreview(tab) {
  if (!tab || tab.viewer !== 'text' || !tab.cm || !tabPreviewKind(tab)) return;
  tab.previewOn = !tab.previewOn;
  if (tab.previewOn) renderTabPreview(tab);
  paintTabPreview(tab);
}
function toggleTabFullPreview(tab) {
  if (!tab || tabPreviewKind(tab) !== 'html') return;
  tab.htmlFull = !tab.htmlFull;
  if (tab.fteFullBtn) {
    tab.fteFullBtn.classList.toggle('btn-primary', !!tab.htmlFull);
    tab.fteFullBtn.classList.toggle('btn-ghost', !tab.htmlFull);
    tab.fteFullBtn.setAttribute('aria-pressed', String(!!tab.htmlFull));
  }
  if (tab.htmlFull) {
    let warned = false;
    try { warned = safeStorage.getItem('wt-full-preview-warned') === 'true'; } catch {}
    if (!warned) {
      toast('Full preview: this file\u2019s scripts run in an isolated frame — no access to the app, its storage or your files', 'warning');
      try { safeStorage.setItem('wt-full-preview-warned', 'true'); } catch {}
    }
  }
  if (tab.previewOn) renderTabPreview(tab);
}
function paintTabPreview(tab) {
  const on = !!tab.previewOn;
  try {
    if (tab.fteHost) tab.fteHost.style.display = on ? 'none' : '';
    if (tab.ftePreview) tab.ftePreview.hidden = !on;
    if (tab.ftePreviewBtn) {
      tab.ftePreviewBtn.textContent = on ? 'Edit' : 'Preview';
      tab.ftePreviewBtn.classList.toggle('btn-primary', on);
    }
    if (tab.fteFullBtn) tab.fteFullBtn.style.display = (on && tabPreviewKind(tab) === 'html') ? '' : 'none';
    if (!on && tab.fteFrame) { try { tab.fteFrame.style.display = 'none'; } catch {} }
    // Either surface was display:none — re-measure after the flip.
    requestAnimationFrame(() => { try { tab.cm?.refresh(); } catch {} });
  } catch {}
}
function setTabPreviewDoc(tab, iframe, doc) {
  try { if (tab.previewDocUrl) URL.revokeObjectURL(tab.previewDocUrl); } catch {}
  tab.previewDocUrl = null;
  if (!iframe) return;
  try {
    tab.previewDocUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
    iframe.removeAttribute('srcdoc');
    iframe.src = tab.previewDocUrl;
  } catch (e) {
    try { iframe.srcdoc = doc; } catch {}
  }
  iframe.style.display = 'block';
}
function tabMdCss() {
  const s = getComputedStyle(document.documentElement);
  const cssVar = n => (s.getPropertyValue(n) || '').trim();
  const bg = cssVar('--bg'), fg = cssVar('--fg'), accent = cssVar('--accent');
  const bg2 = cssVar('--bg2'), bg3 = cssVar('--bg3'), border = cssVar('--border');
  const fg2 = cssVar('--fg2'), font = cssVar('--font');
  return `<style>
    .md-rendered { max-width: 800px; margin: 0 auto; }
    .md-rendered h1, .md-rendered h2, .md-rendered h3, .md-rendered h4, .md-rendered h5, .md-rendered h6 { color: ${fg}; margin: 1.2em 0 0.5em; font-weight: 700; }
    .md-rendered h1 { font-size: 1.8em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
    .md-rendered h2 { font-size: 1.5em; border-bottom: 1px solid ${border}; padding-bottom: 0.25em; }
    .md-rendered h3 { font-size: 1.25em; }
    .md-rendered h4 { font-size: 1.1em; }
    .md-rendered p { margin: 0.75em 0; line-height: 1.7; }
    .md-rendered ul, .md-rendered ol { margin: 0.5em 0; padding-left: 2em; }
    .md-rendered li { margin: 0.25em 0; }
    .md-rendered blockquote { margin: 0.75em 0; padding: 4px 16px; border-left: 4px solid ${accent}; background: ${bg2}; color: ${fg2}; border-radius: 0 6px 6px 0; }
    .md-rendered code { font-family: ${font}; background: ${bg3}; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    .md-rendered pre { background: ${bg2}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; overflow-x: auto; margin: 0.75em 0; }
    .md-rendered pre code { background: none; padding: 0; border-radius: 0; font-size: 0.85em; }
    .md-rendered table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
    .md-rendered th, .md-rendered td { border: 1px solid ${border}; padding: 8px 12px; text-align: left; }
    .md-rendered th { background: ${bg3}; font-weight: 600; }
    .md-rendered hr { border: none; border-top: 1px solid ${border}; margin: 1.5em 0; }
    .md-rendered a { color: ${accent}; text-decoration: none; }
    .md-rendered a:hover { text-decoration: underline; }
    .md-rendered img { max-width: 100%; border-radius: 6px; }
  </style>`;
}
function tabHtmlShell(content, baseHref, isDark) {
  const s = getComputedStyle(document.documentElement);
  const cssVar = n => (s.getPropertyValue(n) || '').trim();
  const bg = cssVar('--bg'), fg = cssVar('--fg'), accent = cssVar('--accent');
  const bg2 = cssVar('--bg2'), border = cssVar('--border'), font = cssVar('--font');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">
<base href="${escHtml(baseHref)}">
<style>
  :root { color-scheme: ${isDark ? 'dark' : 'light'}; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 24px; font-family: ${font}; font-size: 14px; line-height: 1.6; background: ${bg}; color: ${fg}; }
  a { color: ${accent}; }
  img { max-width: 100%; height: auto; }
  pre { background: ${bg2}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; overflow-x: auto; }
  code { font-family: ${font}; font-size: 0.9em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid ${border}; padding: 8px 12px; text-align: left; }
  th { background: ${bg2}; }
  blockquote { margin: 0.75em 0; padding: 4px 16px; border-left: 4px solid ${accent}; background: ${bg2}; border-radius: 0 6px 6px 0; }
  h1, h2, h3 { margin: 1em 0 0.5em; font-weight: 700; }
  p { margin: 0.75em 0; }
</style>
</head>
<body>${content}</body>
</html>`;
}
function tabIsDark() {
  try {
    const s = getComputedStyle(document.documentElement);
    return !['#f9f9fb', '#ffffff', 'rgb(249, 249, 251)', 'rgb(255, 255, 255)'].includes(s.getPropertyValue('--bg').trim());
  } catch { return true; }
}
function renderTabPreview(tab) {
  if (!tab || !tab.cm || !tab.previewOn) return;
  const kind = tabPreviewKind(tab);
  if (!kind) return;
  const raw = tab.cm.getValue();
  const baseDir = tabBaseDir(tab.path);
  const isDark = tabIsDark();
  if (kind === 'md') {
    const md = tab.fteMd;
    if (!md) return;
    if (typeof DOMPurify === 'undefined' || typeof marked === 'undefined') {
      md.innerHTML = '<p style="padding:16px">Preview unavailable — preview libraries failed to load (CDN blocked?).</p>';
      return;
    }
    try {
      const html = marked.parse(raw, { breaks: true, gfm: true, langPrefix: 'language-' });
      let sanitized = DOMPurify.sanitize(html);
      sanitized = rewriteHtmlRelativeUrls(sanitized, baseDir);
      md.innerHTML = tabMdCss() + `<div class="md-rendered">${sanitized}</div>`;
    } catch (e) {
      console.warn('Tab markdown preview error:', e);
      md.textContent = 'Error rendering markdown preview';
    }
    return;
  }
  const frame = tab.fteFrame;
  if (!frame) return;
  try {
    if (!raw) {
      setTabPreviewDoc(tab, frame, '<p style="font-family:sans-serif;padding:16px">Nothing to preview — the file is empty.</p>');
      return;
    }
    const baseHref = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (authToken ? `&token=${encodeURIComponent(authToken)}` : '');
    const injectHead = (doc, tags) => /<head[^>]*>/i.test(doc)
      ? doc.replace(/<head[^>]*>/i, m => m + tags)
      : doc.replace(/<html[^>]*>/i, m => m + '<head>' + tags + '</head>');
    const isFullDoc = /<!DOCTYPE|<html[\s>]/i.test(raw);
    if (tab.htmlFull) {
      // FULL mode mirrors the panel: author's bytes verbatim inside the same
      // opaque-origin sandbox (allow-scripts only). Needs no sanitizer CDN.
      let doc;
      if (isFullDoc) {
        doc = rewriteFullHtmlUrls(raw, baseDir);
        if (!/<base\b/i.test(doc)) doc = injectHead(doc, `<base href="${escHtml(baseHref)}">`);
        if (!/<meta[^>]*color-scheme/i.test(doc)) doc = injectHead(doc, `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
      } else {
        doc = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">\n<base href="${escHtml(baseHref)}">\n</head>\n<body>${rewriteFullHtmlUrls(raw, baseDir)}</body>\n</html>`;
      }
      setTabPreviewDoc(tab, frame, doc);
      return;
    }
    if (typeof DOMPurify === 'undefined') {
      setTabPreviewDoc(tab, frame, '<p style="font-family:sans-serif;padding:16px">Preview unavailable — sanitizer failed to load (CDN blocked?).</p>');
      toast('Preview unavailable: sanitizer failed to load', 'warning');
      return;
    }
    let doc;
    if (isFullDoc) {
      let sanitized = DOMPurify.sanitize(raw, { WHOLE_DOCUMENT: true, USE_PROFILES: { html: true }, ADD_TAGS: ['base', 'style'], ADD_ATTR: ['target'] });
      sanitized = rewriteHtmlRelativeUrls(sanitized, baseDir);
      if (!/<base\b/i.test(sanitized)) sanitized = injectHead(sanitized, `<base href="${escHtml(baseHref)}">`);
      if (!/<meta[^>]*color-scheme/i.test(sanitized)) sanitized = injectHead(sanitized, `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
      doc = sanitized;
    } else {
      const fragment = rewriteHtmlRelativeUrls(DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] }), baseDir);
      doc = tabHtmlShell(fragment, baseHref, isDark);
    }
    setTabPreviewDoc(tab, frame, doc);
  } catch (e) {
    console.warn('Tab HTML preview failed:', e);
    try { setTabPreviewDoc(tab, frame, '<p style="font-family:sans-serif;padding:16px">Preview failed: ' + escHtml((e && e.message) || 'unknown error') + '</p>'); } catch {}
  }
}
// Debounced live re-render while editing with preview open (mirrors the
// panel's 350ms / 200KB policy).
function scheduleTabPreview(tab) {
  if (!tab || !tab.previewOn || !tab.cm) return;
  try {
    if (tab.cm.getValue().length > PREVIEW_MAX_LIVE_BYTES) return;
  } catch { return; }
  clearTimeout(tab.previewTimer);
  tab.previewTimer = setTimeout(() => {
    tab.previewTimer = null;
    try { renderTabPreview(tab); } catch {}
  }, 350);
}

function markTabDirty(tab) {
  if (!tab) return;
  const dirty = !!tab.cm && tab.cm.getValue() !== tab.original;
  tab.dirty = dirty;
  if (tab.fteDot) {
    tab.fteDot.classList.toggle('on', dirty);
    tab.fteDot.setAttribute('aria-label', dirty ? 'Unsaved changes' : 'No unsaved changes');
  }
  try { tab.el?.classList.toggle('has-dirty', dirty); } catch {}
}

// Same 2s debounce and same `wt-draft:<path>` keys as the panel, so a draft written by
// a tab is offered by the panel too, and vice versa.
function scheduleTabDraft(tab) {
  clearTimeout(tab.draftTimer);
  tab.draftTimer = setTimeout(() => {
    try {
      if (!tab.cm || tab.closed) return;
      const content = tab.cm.getValue();
      if (content !== tab.original) safeStorage.setItem('wt-draft:' + tab.path, content);
      else safeStorage.removeItem('wt-draft:' + tab.path);
    } catch {}
  }, 2000);
}

async function saveTabFile(tab) {
  if (!tab || !tab.cm) return;
  setBtnBusy(tab.fteSaveBtn, true);
  const content = tab.cm.getValue();
  const r = await api('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: tab.path, content }),
  });
  setBtnBusy(tab.fteSaveBtn, false);
  if (r && r.success) {
    tab.original = content;
    clearTimeout(tab.draftTimer);
    removeDraft(tab.path);
    markTabDirty(tab);
    if (tab.fteStatus) {
      tab.fteStatus.textContent = 'Saved';
      setTimeout(() => { if (tab.fteStatus) tab.fteStatus.textContent = ''; }, 2000);
    }
    toast('Saved ' + fileTabName(tab.path), 'success');
    try { notifyPreviewFileSaved(); } catch {}
  } else {
    toast((r && r.error) || 'Save failed', 'error');
  }
}

async function reloadTabFile(tab) {
  if (!tab || !tab.cm) return;
  if (tab.cm.getValue() !== tab.original) {
    const ok = await confirmDialog({ title: 'Discard changes', message: 'Re-read this file from disk and discard your unsaved changes?', okText: 'Discard', cancelText: 'Keep Editing', danger: true });
    if (!ok) return;
  }
  // Deliberately a raw read: Reload means disk, so it must not offer the draft again.
  const r = await api(`/api/files/read?path=${encodeURIComponent(tab.path)}`);
  if (r.error) { toast(r.error, 'error'); return; }
  clearTimeout(tab.draftTimer);
  removeDraft(tab.path);
  tab.cm.setValue(r.content);
  tab.original = r.content;
  markTabDirty(tab);
  if (tab.fteStatus) {
    tab.fteStatus.textContent = 'Reloaded';
    setTimeout(() => { if (tab.fteStatus) tab.fteStatus.textContent = ''; }, 2000);
  }
}

// Hand the file to the split panel, carrying the buffer and undo history so nothing is
// lost and no discard dialog is needed.
async function moveTabToPanel(tab) {
  if (!tab || tab.type !== 'file') return;
  const path = tab.path;
  const content = tab.cm ? tab.cm.getValue() : '';
  const original = tab.original != null ? tab.original : content;
  const history = tab.cm ? tab.cm.getHistory() : null;
  const cursor = tab.cm ? tab.cm.getCursor() : null;
  clearTimeout(tab.draftTimer);
  clearTimeout(tab.previewTimer);
  // Crash-safety net for the handover: if the tab goes away but the panel never opens,
  // the draft still holds the text.
  if (content !== original) safeStorage.setItem('wt-draft:' + path, content);
  await closeTab({ stopPropagation() {} }, tab.id, { force: true });
  await showTextInPanel(path, content, original, history);
  if (cursor) { try { editor?.setCursor(cursor); } catch {} }
}

// The opener refused the file (binary, legacy Office, unsupported type, failed
// fetch): the panel still shows whatever it showed before, so remove this tab
// instead of leaving it labelled with a file it is not displaying.
function abandonFileTab(tab) {
  if (!tab) return;
  tab.closed = true;
  if (_dockedFileTabId === tab.id) undockEditor(false);
  try { if (tab.imgUrl) URL.revokeObjectURL(tab.imgUrl); } catch {}
  tab.el?.remove();
  tab.wrapper?.remove();
  tabs = tabs.filter(t => t.id !== tab.id);
  releaseFileTabResources(tab);
  saveTabState();
  if (activeTabId === tab.id && tabs.length > 0) activateTab(tabs[tabs.length - 1].id);
  else if (tilesMode) layoutTiles();
  updateLaunchpad();
}

// Open `path` in its own tab. When the panel currently holds that exact file, hand the
// live buffer over (unsaved edits and undo history included) instead of re-reading from
// disk, then release the panel — one path must never be editable in two surfaces at
// once, or they diverge and the last save wins.
function openFileAsTab(path) {
  if (!path) return null;
  const existing = findFileTab(path);
  if (existing) { activateTab(existing.id); return existing; }
  const fromPanel = !!editor && editorPath === path;
  const tab = newFileTab(path, { mount: false });
  if (!tab) return null;
  if (fromPanel) tab._cameFromPanel = true;
  if (fromPanel && tab.viewer === 'text') {
    tab.seed = { content: editor.getValue(), original: editorOriginalContent, history: editor.getHistory(), cursor: editor.getCursor() };
  } else if (fromPanel && tab.viewer === 'pdf') {
    tab.viewState = { page: _pdfCurrentPage, scale: _pdfScale };
  }
  activateTab(tab.id);
  if (fromPanel && tab.viewer === 'text') releasePanelSurface();
  return tab;
}

// The header button: move the open file out of the panel and into its own tab.
function openEditorAsTab() {
  if (!editorPath) { toast('No file open', 'error'); return; }
  openFileAsTab(editorPath);
}

// ── App preview tabs (loopback reverse-proxy) ──
// Same tab bar as terminals, but the body is a toolbar + sandboxed iframe
// pointed at /api/preview/:port/ instead of xterm + /ws.
function previewBuildUrl(port, pth) {
  let p = String(pth || '/');
  if (!p.startsWith('/')) p = '/' + p;
  return `/api/preview/${port}${p}?token=${encodeURIComponent(authToken)}`;
}
// Accept a pasted dev URL in either field: "http://localhost:5173/docs?a=1",
// "127.0.0.1:5173/docs", ":5173/docs" or "5173/docs" → { port, path }.
function parsePreviewTarget(portRaw, pathRaw) {
  const combined = `${String(portRaw == null ? '' : portRaw)} ${String(pathRaw == null ? '' : pathRaw)}`.trim();
  if (!combined) return { error: 'Port must be 1–65535' };
  let m = combined.match(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{2,5}))?(\/\S*)?/i);
  if (m && m[1]) {
    const port = parseInt(m[1], 10);
    let pth = (m[2] || '').replace(/["'\),;\]]+$/, '') || '';
    if (!pth || pth === '/') {
      // URL had no path — keep whatever plain path the other field held.
      const other = String(pathRaw == null ? '' : pathRaw).trim();
      if (other && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(other)) pth = other;
    }
    return { port, path: pth || '/' };
  }
  m = String(portRaw == null ? '' : portRaw).trim().match(/^:?(\d{2,5})(\/\S*)?$/);
  if (m) return { port: parseInt(m[1], 10), path: (m[2] || String(pathRaw == null ? '' : pathRaw)).trim() || '/' };
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
  // The proxy refuses WebTun's own port (self-framing loop) — catch it here
  // with words instead of a raw error frame. Covers Go, prompt, suggestion
  // and tab-restore in one choke point.
  try {
    if (n === webtunSelfPort()) {
      try { tab.loadingEl.classList.add('hidden'); } catch {}
      toast("That's WebTun itself — enter your app's port, not " + n, 'warning');
      return;
    }
  } catch {}
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
  try { tab.iframe.src = previewBuildUrl(n, p) + (previewBuildUrl(n, p).includes('?') ? '&' : '?') + '_t=' + Date.now(); } catch {}
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
  const tab = { id, type: 'preview', port: initialPort, previewPath: p, previewAutoReload: !!opts.auto, previewWidth: opts.width || 'full', title: `App:${initialPort}`, el: null, wrapper: null, iframe: null, closed: false, cwd: currentPath };
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
  try {
    if (n === webtunSelfPort()) { showFieldError('preview-error', "That's WebTun itself — enter your app's port"); return; }
  } catch {}
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
    const rows = [];
    for (const p of (ports || [])) {
      const n = Number(p && p.port != null ? p.port : p);
      if (!Number.isInteger(n) || seen.has(n)) continue;
      seen.add(n);
      const proc = p && p.proc ? ` — ${String(p.proc).slice(0, 32)}` : '';
      rows.push(`<option value="${n}" label="${n}${proc}">`);
      if (rows.length >= 30) break;
    }
    try {
      for (const r of getPreviewRecent()) {
        const n = Number(r.port);
        if (!Number.isInteger(n) || seen.has(n)) continue;
        seen.add(n);
        rows.push(`<option value="${n}" label="${n} — recent">`);
        if (rows.length >= 30) break;
      }
    } catch {}
    dl.innerHTML = rows.join('');
  } catch {}
}
// Terminal-output scan: suggest "Open preview" when a loopback URL appears.
// Debounced per tab+port (60s), suggestions only — never auto-opens.
const _previewHintSeen = new Map();
function scanPreviewHint(tab, text) {
  if (!text || tab.type !== 'term') return;
  let m = String(text).match(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{2,5})(\/\S*)?/i);
  if (!m) {
    const b = String(text).match(/(?:listening|running|started|ready|port|local:?)\D{0,20}:(\d{4,5})/i);
    if (!b) return;
    m = [b[0], b[1], '/'];
  }
  const port = parseInt(m[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  // Never suggest WebTun itself as a preview target. location.port is empty
  // behind a tunnel (guesses 443), so the server's real port is authoritative.
  try {
    if (port === webtunSelfPort()) return;
  } catch {}
  let pth = '/';
  try { pth = (m[2] || '/').replace(/["'\),;\]]+$/, '') || '/'; if (!pth.startsWith('/')) pth = '/'; } catch { pth = '/'; }
  const key = `${tab.id}:${port}`;
  if (_previewHintSeen.has(key) && Date.now() - _previewHintSeen.get(key) < 60000) return;
  _previewHintSeen.set(key, Date.now());
  previewSuggestToast(port, pth);
}
function previewSuggestToast(port, pth) {
  try {
    const container = document.getElementById('toast-container');
    if (!container) { toast(`App detected on :${port}`, 'info'); return; }
    while (container.children.length >= 4) container.firstChild.remove();
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

function cleanupWebSocket(tab) {
  if (tab.ws) {
    tab.ws.onopen = null;
    tab.ws.onmessage = null;
    tab.ws.onerror = null;
    tab.ws.onclose = null;
    try { tab.ws.close(); } catch(e) { console.warn(e); }
    tab.ws = null;
  }
  if (tab.pingTimer) {
    clearInterval(tab.pingTimer);
    tab.pingTimer = null;
  }
}

function connectWebSocket(tab, isReconnect = false) {
  if (tab.closed || !tab.term) return;
  clearTimeout(tab.reconnectTimer);
  cleanupWebSocket(tab);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const cols = tab.term.cols, rows = tab.term.rows;
  const sessionParam = tab.sessionId ? `&session=${encodeURIComponent(tab.sessionId)}` : '';
  const wsUrl = `${proto}://${location.host}/ws?token=${encodeURIComponent(authToken)}&cols=${cols}&rows=${rows}&cwd=${encodeURIComponent(tab.cwd || currentPath)}${sessionParam}`;
  const ws = new WebSocket(wsUrl);
  tab.ws = ws;
  ws.binaryType = 'arraybuffer';

  const sendInput = data => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // On Enter, capture the command for history
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      if (ch === 13 || ch === 10) { // Enter
        try {
          // Prefer stored paste text
          let text = tab._lastPasteText;
          tab._lastPasteText = null;
          if (text) {
            // For multi-line pastes, take only the last line (the command)
            const lines = text.split('\n');
            text = lines[lines.length - 1] || lines[lines.length - 2] || text;
            text = text.trim();
          } else {
            // Use the tracked input buffer (more reliable than buffer scanning)
            text = (tab._currentInput || '').trim();
            // Strip any leaked VT/ANSI parameter junk that bypassed the escape parser
            text = text.replace(/^[>;\d\s]+(?=[a-zA-Z/\\~\-.])/, '').replace(/^[>;\d\s]+$/, '').trim();
          }
          if (text) addToCmdHist(text);
          tab._currentInput = ''; // Clear after history save
        } catch {}
      }
    }
    // Chunked send (server caps input per message)
    sendWsInput(ws, data);

    // Update the keystroke buffer — skip all escape sequences and control characters
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      if (ch === 13 || ch === 10) { // Enter (handled above)
        continue;
      } else if (ch === 127 || ch === 8) { // Backspace / Delete
        if (tab._currentInput) tab._currentInput = tab._currentInput.slice(0, -1);
      } else if (ch === 21) { // ^U — clear line
        tab._currentInput = '';
      } else if (ch === 23) { // ^W — delete word
        if (tab._currentInput) tab._currentInput = tab._currentInput.replace(/\S+\s*$/, '');
      } else if (ch === 27) { // ESC — skip entire escape sequence
        i++;
        if (data[i] === ']') { // OSC — skip to BEL or ESC-backslash (title text isn't input)
          i++;
          while (i < data.length) {
            if (data.charCodeAt(i) === 7) { i++; break; }
            if (data[i] === '\x1b' && data[i+1] === '\\') { i += 2; break; }
            i++;
          }
          i--; // compensate for-loop increment (already past terminator)
        } else if (data[i] === 'P') { // DCS — skip to ESC-backslash
          i++;
          while (i < data.length) {
            if (data[i] === '\x1b' && data[i+1] === '\\') { i += 2; break; }
            i++;
          }
          i--;
        } else { // CSI / SS3 / single-ESC — skip to final char (for-loop moves past it)
          while (i < data.length) {
            const c = data.charCodeAt(i);
            if (c >= 0x40 && c <= 0x7E) break;
            i++;
          }
        }
      } else if (ch >= 32 && ch !== 127) { // Printable (incl. unicode), not DEL
        tab._currentInput = (tab._currentInput || '') + data[i];
        // Cap buffer on long-lived tabs (history only needs the tail)
        if (tab._currentInput.length > 4096) tab._currentInput = tab._currentInput.slice(-4096);
      }
      // All other control chars (0x00-0x1F except 0x0D/0x0A) are silently dropped
    }
  };
  const sendResize = (cols, rows) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const dv = new DataView(new ArrayBuffer(5));
    dv.setUint8(0, 0x01); dv.setUint16(1, cols, true); dv.setUint16(3, rows, true);
    ws.send(dv.buffer);
  };

  ws.onopen = () => {
    tab.reconnectDelay = 1000;
    tab.reconnectAttempts = 0;
    hideTermLoading(tab);
    updateConnStatus(true);
    const banner = document.getElementById('reconnect-banner');
    if (banner) {
      banner.innerHTML = '<span class="reconnect-spinner"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></span> Reconnecting…';
      banner.style.display = 'none';
    }
    if (isReconnect) {
      tab.term.writeln('\x1b[32m[Reconnected]\x1b[0m');
    }
    tab.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array([0x02]).buffer);
    }, 20000);
    setupVisualViewport();
  };

  // OSC sequence handler: intercepts OSC 7, 133, 52 before passing to xterm.js
  let oscBuf = '';
  function processTerminalOutput(data) {
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    let out = '';
    let i = 0;
    while (i < str.length) {
      // Look for ESC ] (OSC introducer)
      if (str[i] === '\x1b' && str[i + 1] === ']') {
        const endIdx = str.indexOf('\x07', i + 2);
        const stIdx = str.indexOf('\x1b\\', i + 2);
        let oscEnd = -1;
        if (endIdx !== -1 && (stIdx === -1 || endIdx < stIdx)) oscEnd = endIdx;
        else if (stIdx !== -1) oscEnd = stIdx;

        if (oscEnd !== -1) {
          const oscData = str.substring(i + 2, oscEnd);
          const semi = oscData.indexOf(';');
          if (semi !== -1) {
            const code = oscData.substring(0, semi);
            const value = oscData.substring(semi + 1);
            if (code === '7') {
              // OSC 7: CWD update — file://hostname/path
              try {
                const url = new URL(value);
                tab.cwd = decodeURIComponent(url.pathname);
              } catch (_) {}
            } else if (code === '133') {
              // OSC 133: Shell integration markers (prompt/cmd start/end/done)
              // Handled silently — available for future command tracking
            } else if (code === '52') {
              // OSC 52: Clipboard operations
              const parts = value.split(';');
              const targets = parts[0] || 'c';
              const b64 = parts.slice(1).join(';');
              if (b64) {
                // SET clipboard — always honored (a program can only overwrite,
                // never read). UTF-8 safe, so emoji/CJK are no longer dropped.
                try {
                  const decoded = b64ToUtf8(b64);
                  if (targets.includes('c') || targets.includes('p')) {
                    navigator.clipboard.writeText(decoded).catch(() => {});
                  }
                } catch (_) {}
              } else if (settings.clipboardRead) {
                // GET clipboard — opt-in (Settings → Terminal). Any remote
                // output could otherwise pull the local clipboard into the
                // session with no prompt at all: a stray
                // `printf '\e]52;c;?'`, a malicious script, a pasted payload.
                navigator.clipboard.readText().then(text => {
                  const response = '\x1b]52;c;' + utf8ToB64(text) + '\x07';
                  if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
                    const enc = new TextEncoder().encode(response);
                    const buf = new Uint8Array(1 + enc.length);
                    buf[0] = 0x00; buf.set(enc, 1);
                    tab.ws.send(buf.buffer);
                  }
                }).catch(() => {});
              } else if (!tab._clipReadHintShown) {
                tab._clipReadHintShown = true;
                toast('A program asked to read your clipboard — enable "Allow terminal clipboard read" in Settings', 'warning');
              }
            }
          }
          i = oscEnd + (str[oscEnd] === '\x07' ? 1 : 2);
          continue;
        }
      }
      out += str[i];
      i++;
    }
    if (out) {
      tab.term.write(out);
      try { scanPreviewHint(tab, out.slice(-2000)); } catch {}
    }
  }

  // Defensive: ws.binaryType is set to 'arraybuffer' right after construction,
  // but a Blob frame (or an unexpected string frame) must not throw inside the
  // message handler — that would kill the socket handler mid-session.
  ws.onmessage = async e => {
    let buf;
    if (e.data instanceof ArrayBuffer) {
      buf = new Uint8Array(e.data);
    } else if (typeof Blob !== 'undefined' && e.data instanceof Blob) {
      try { buf = new Uint8Array(await e.data.arrayBuffer()); } catch { return; }
    } else if (typeof e.data === 'string') {
      buf = new TextEncoder().encode(e.data);
    } else {
      return;
    }
    if (!buf.length) return;
    const type = buf[0], payload = buf.slice(1);
    if (type === 0x00) processTerminalOutput(payload);
    else if (type === 0x01) tab.term.writeln('\r\n\x1b[31m[Process exited]\x1b[0m');
    else if (type === 0x02) tab.term.writeln('\r\n\x1b[31m' + new TextDecoder().decode(payload) + '\x1b[0m');
    else if (type === 0x03) handleClientEvent(payload);
  };

// Server-pushed security events (0x03 JSON): new-login alerts, session-revoked kicks.
function handleClientEvent(payload) {
  let ev = null;
  try { ev = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
  if (!ev || !ev.event) return;
  if (ev.event === 'new-login') {
    const when = ev.at ? new Date(ev.at).toLocaleString() : 'just now';
    toast(`New login — ${ev.device || 'unknown device'} · ${ev.ip || 'unknown IP'} · ${when}`, 'warning');
    // Persistent triangle until reviewed (toast alone vanishes)
    try { addSecurityAlert(ev); } catch {}
    try { updateSessionCupCount(); } catch {}
    // Refresh the sessions list if the Security panel is visible
    try {
      const sp = document.getElementById('settings-panel');
      if (sp && sp.classList.contains('open') && typeof refreshSessions === 'function') refreshSessions();
    } catch {}
  } else if (ev.event === 'session-revoked') {
    toast('This session was signed out remotely', 'error');
    storeSessionToken('');
    authToken = '';
    showPinScreen();
  } else if (ev.event === 'session-pending') {
    // A new device passed the PIN but is locked until WE approve it.
    // Instant modal here; the sessions list holds Approve/Deny as backstop.
    try { if (typeof refreshSessions === 'function') refreshSessions(); } catch {}
    try { updateSessionCupCount(); } catch {}
    try { addSecurityAlert({ ip: ev.ip, device: `Login approval requested by ${ev.device || 'unknown device'}`, at: ev.at }); } catch {}
    confirmDialog({
      title: 'Approve this device?',
      message: `${ev.device || 'Unknown device'} (${ev.ip || 'unknown IP'}) entered the correct PIN and is waiting for access. Approve it, or dismiss and Deny it in Security.`,
      okText: 'Approve device', cancelText: 'Dismiss', danger: true,
    }).then(async ok => {
      if (!ok) return;
      await approveSession(ev.id);
    }).catch(() => {});
  } else if (ev.event === 'pin-change-pending') {
    // A fresh session asked to rotate the PIN. Act in this very moment:
    // instant modal here, persistent banner in Security as backstop.
    try { if (typeof refreshSessions === 'function') refreshSessions(); } catch {}
    const mine = ev.requester && ev.requester === authToken;
    if (mine) {
      toast('PIN change pending — approve it from another signed-in tab', 'info');
    } else {
      const when = ev.expiresAt ? new Date(ev.expiresAt).toLocaleTimeString() : '';
      confirmDialog({
        title: 'Approve PIN change?',
        message: `${ev.device || 'Unknown device'} (${ev.ip || 'unknown IP'}) wants to change the PIN${when ? ` — expires ${when}` : ''}. If this wasn't you, dismiss and Revert it in Security.`,
        okText: 'Approve change', cancelText: 'Dismiss', danger: true,
      }).then(async ok => {
        if (!ok) return;
        await approvePinChange();
      }).catch(() => {});
      try { addSecurityAlert({ ip: ev.ip, device: `PIN change requested by ${ev.device || 'unknown device'}`, at: Date.now() }); } catch {}
    }
  } else if (ev.event === 'pin-change-resolved') {
    toast(ev.approved ? 'PIN change approved and applied' : `PIN change stopped${ev.expired ? ' (expired)' : ''}${ev.vetoed ? ' (reverted)' : ''}`, ev.approved ? 'success' : 'info');
    try { if (typeof refreshSessions === 'function') refreshSessions(); } catch {}
    try { updateSessionCupCount(); } catch {}
  } else if (ev.event === 'pin-changed') {
    const what = ev.disabled ? 'PIN protection was REMOVED' : 'PIN was changed';
    toast(`${what} by ${ev.device || 'unknown device'} · ${ev.ip || 'unknown IP'} — re-login required`, 'error');
    // Persistent: survives the kick to the PIN screen, shown on next unlock
    try { addSecurityAlert({ ip: ev.ip, device: `${what} by ${ev.device || 'unknown device'}`, at: ev.at }); } catch {}
  } else if (ev.event === 'sessions-changed') {
    try { updateSessionCupCount(); } catch {}
    try {
      const sp = document.getElementById('settings-panel');
      if (sp && sp.classList.contains('open') && typeof refreshSessions === 'function') refreshSessions();
    } catch {}
  }
}

  ws.onerror = (e) => { console.warn('WS error:', e.type); };

  ws.onclose = () => {
    cleanupWebSocket(tab);
    if (tab.closed) return;
    updateConnStatus(false);
    tab.reconnectAttempts = (tab.reconnectAttempts || 0) + 1;
    const _attempt = tab.reconnectAttempts;
    const _maxAttempts = 10;
    const spinnerHtml = '<span class="reconnect-spinner"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></span>';
    const banner = document.getElementById('reconnect-banner');
    // Honor the cap: after _maxAttempts, stop auto-retry and leave the
    // manual Reconnect button (auto-loop never yielded before).
    if (_attempt > _maxAttempts) {
      if (banner) {
        banner.innerHTML = `Connection lost — auto-retry stopped. <button class="btn btn-primary" onclick="manualReconnect()" style="height:26px;padding:0 12px;font-size:11px;margin-left:8px">Reconnect</button>`;
        banner.style.display = 'block';
      }
      tab.term.writeln('\r\n\x1b[33m[Disconnected — auto-retry stopped. Press Reconnect above.]\x1b[0m');
      return;
    }
    if (banner) {
      if (_attempt >= 3) {
        banner.innerHTML = `Connection lost — retry ${_attempt}/${_maxAttempts}. <button class="btn btn-primary" onclick="manualReconnect()" style="height:26px;padding:0 12px;font-size:11px;margin-left:8px">Reconnect</button>`;
      } else {
        banner.innerHTML = `${spinnerHtml} Reconnecting (${_attempt}/${_maxAttempts})…`;
      }
      banner.style.display = 'block';
    }
    tab.reconnectDelay = Math.min((tab.reconnectDelay || 1000) * 2, 15000);
    const secs = tab.reconnectDelay / 1000;
    tab.term.writeln(`\r\n\x1b[33m[Disconnected — reconnecting in ${secs}s (attempt ${_attempt}/${_maxAttempts})…]\x1b[0m`);
    tab.reconnectTimer = setTimeout(() => {
      if (!tab.closed) connectWebSocket(tab, true);
    }, tab.reconnectDelay);
  };

  tab.dataDisposable?.dispose();
  tab.resizeDisposable?.dispose();
  tab.dataDisposable = tab.term.onData(data => sendInput(data));
  tab.resizeDisposable = tab.term.onResize(({ cols, rows }) => sendResize(cols, rows));
}

function manualReconnect() {
  const banner = document.getElementById('reconnect-banner');
  if (banner) {
    banner.innerHTML = '<span class="reconnect-spinner"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></span> Reconnecting (1/10)…';
    banner.style.display = 'block';
  }
  tabs.forEach(tab => {
    if (tab.closed) return;
    if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) {
      tab.reconnectDelay = 1000;
      tab.reconnectAttempts = 0;
      connectWebSocket(tab, true);
    }
  });
}

async function closeTab(e, id, opts = {}) {
  e.stopPropagation();
  const closing = tabs.find(t => t.id === id);
  // `opts.force` means the caller has already taken ownership of the buffer (see
  // moveTabToPanel), so neither the close prompt nor the discard prompt applies.
  if (settings.confirmclose && !opts.force) {
    const kind = closing?.type === 'preview' ? 'preview' : closing?.type === 'file' ? 'file' : 'terminal';
    const ok = await confirmDialog({ title: 'Close ' + kind, message: tabs.length === 1 ? `Close last ${kind}?` : `Close ${kind}?`, okText: 'Close', cancelText: 'Cancel' });
    if (!ok) return;
  }

  // Unsaved-changes check. Doc previews (PDF/EPUB/Office) hold no CodeMirror
  // document — the buffer is stale, so comparing it raised false prompts.
  const evEl = document.getElementById('editor-view');
  const editorOpen = !!evEl && evEl.classList.contains('open');
  const currentContent = editor ? editor.getValue() : '';
  const isDocPreview = !!(_pdfDoc || _epubBook || _officePath);
  const closingText = !!closing && closing.type === 'file' && closing.viewer === 'text';
  if (closingText) {
    // Text tabs own their buffer, so this is their own editor — not the panel's.
    const dirty = !!(closing.cm && closing.cm.getValue() !== closing.original);
    if (dirty && !opts.force) {
      const ok = await confirmDialog({ title: 'Unsaved changes', message: 'You have unsaved changes. Close anyway?', okText: 'Discard', cancelText: 'Keep Editing', danger: true });
      if (!ok) return;
      // Explicit discard: drop the crash-safety draft so it is not offered again.
      if (closing.path) removeDraft(closing.path);
    }
  } else if (_dockedFileTabId == null && editorOpen && !isDocPreview && currentContent !== editorOriginalContent) {
    // Panel mode (nothing docked): the visible buffer belongs to the panel itself.
    const ok = await confirmDialog({ title: 'Unsaved changes', message: 'You have unsaved changes. Close anyway?', okText: 'Close', cancelText: 'Cancel', danger: true });
    if (!ok) return;
  }

  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  const isPreview = tab.type === 'preview';
  const isFile = tab.type === 'file';
  tab.closed = true;
  clearTimeout(tab.reconnectTimer);
  if (!isPreview && !isFile) cleanupWebSocket(tab);
  // Hand the shared editor panel back before the wrapper is removed, then free
  // this tab's viewer docs / object URL / snapshots.
  if (isFile) {
    if (_dockedFileTabId === id) { undockEditor(false); try { cleanupDocViewers(); tab.mountedOnce = false; } catch {} }
    releaseFileTabResources(tab);
  }
  // Clean up selection/scroll mode state
  if (termSelectMode) {
    const ta = tab.textarea || tab.term?.textarea || tab.term?.element?.querySelector('.xterm-textarea, textarea');
    if (ta) ta.disabled = false;
    cleanupScrollHandlers();
  }
  tab.resizeObserver?.disconnect();
  // Release the GL context explicitly: browsers cap WebGL contexts (~16), and
  // after that new terminals silently lose the GPU renderer.
  try { tab._webglAddon?.dispose(); } catch {}
  tab._webglAddon = null;
  try { tab._searchResultsSub?.dispose?.(); } catch {}
  tab.term?.dispose();
  try { if (tab.iframe) tab.iframe.src = 'about:blank'; } catch {}
  tab.el?.remove();
  tab.wrapper?.remove();
  // Kill the backing session (tmux or in-memory) so it doesn't pile up (terminals only)
  if (!isPreview && !isFile && tab.sessionId) api(`/api/sessions/${tab.sessionId}`, { method: 'DELETE' });
  tabs = tabs.filter(t => t.id !== id);
  saveTabState();
  if (activeTabId === id && tabs.length > 0) activateTab(tabs[tabs.length - 1].id);
  if (tilesMode) layoutTiles();
  const termsEl = document.getElementById('terminals');
  if (termsEl) termsEl.style.marginBottom = '';
  updateLaunchpad();
}

// ── Launchpad: zero-tab home screen ──
function lpOpenExplorer() { if (!sidebarOpen) toggleSidebar(); }
async function launchAndRun(cmd) {
  if (!cmd || !String(cmd).trim()) return;
  const tab = newTab();
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (tab.closed) return;
    if (tab.ws && tab.ws.readyState === WebSocket.OPEN) break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
    activateTab(tab.id);
    runCmdLib(String(cmd).trim());
  } else {
    toast('Terminal is still connecting…', 'warning');
  }
}
function updateLaunchpad() {
  const lp = document.getElementById('launchpad');
  if (!lp) return;
  const show = tabs.length === 0 || lpPinned || lpAuto;
  lp.classList.toggle('show', show);
  lp.setAttribute('aria-hidden', String(!show));
  if (show) {
    renderLaunchpad();
    startLpPulse();
    // Only steal focus on a fresh zero-tab landing — when pinned alongside
    // tabs (e.g. after closeTab) the active terminal keeps keyboard focus.
    if (tabs.length === 0) lp.querySelector('.lp-new')?.focus({ preventScroll: true });
  } else {
    stopLpPulse();
  }
}
// Idle dashboard screensaver: auto-show the launchpad after N idle minutes.
// Visual only (not a lock) — any activity dismisses it. Opt-in via settings.
let lpAuto = false;
let _lastActivity = Date.now();
let _ssTimer = null;
function pokeScreensaver() {
  _lastActivity = Date.now();
  if (lpAuto) unpinLaunchpad();
}
function startScreensaverWatch() {
  if (_ssTimer) return;
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(ev =>
    document.addEventListener(ev, pokeScreensaver, { passive: true }));
  _ssTimer = setInterval(() => {
    if (!settings.screensaver || document.hidden) return;
    if (tabs.length === 0 || lpPinned || lpAuto) return;
    if (document.querySelector('.overlay.open')) return;
    if (Date.now() - _lastActivity >= (settings.screensaverMin || 5) * 60000) {
      lpAuto = true;
      updateLaunchpad();
    }
  }, 5000);
}
// Pinned dashboard: Home button shows the launchpad over live terminals.
// Picking/creating a tab unpins; closing tabs never unpins.
let lpPinned = false;
function toggleLaunchpad() {
  lpPinned = !lpPinned;
  const hb = document.getElementById('home-btn');
  if (hb) { hb.classList.toggle('active', lpPinned); hb.setAttribute('aria-pressed', String(lpPinned)); }
  updateLaunchpad();
}
function unpinLaunchpad() {
  if (!lpPinned && !lpAuto) return;
  lpPinned = false;
  lpAuto = false;
  const hb = document.getElementById('home-btn');
  if (hb) { hb.classList.remove('active'); hb.setAttribute('aria-pressed', 'false'); }
  updateLaunchpad();
}
// Manual preview from Settings → Interface → Preview screensaver.
// Works even when the auto-screensaver toggle is off.
function startScreensaverNow() {
  lpAuto = true;
  updateLaunchpad();
}
let lpPulseTimer = null;
let lpCpuSamples = [];
function drawLpSpark() {
  try {
    const cv = document.getElementById('lp-spark');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (lpCpuSamples.length < 2) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00c853';
    const max = Math.max(10, ...lpCpuSamples);
    ctx.beginPath();
    lpCpuSamples.forEach((v, i) => {
      const x = (i / (lpCpuSamples.length - 1)) * (W - 4) + 2;
      const y = H - 3 - (Math.min(v, max) / max) * (H - 8);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(W - 2, H);
    ctx.lineTo(2, H);
    ctx.closePath();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
  } catch {}
}
function fmtUptime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d > 0) return d + 'd' + h + 'h';
  if (h > 0) return h + 'h' + m + 'm';
  return m + 'm';
}
async function tickLpPulse() {
  const el = document.getElementById('lp-pulse');
  if (!el || !document.getElementById('launchpad')?.classList.contains('show')) return;
  try {
    const s = await fetchSystemStats();
    if (!s || !document.getElementById('launchpad')?.classList.contains('show')) return;
    const load = s.cpu && s.cpu.loadAvg ? Number(s.cpu.loadAvg[0]).toFixed(2) : '–';
    const cpu = s.cpu && s.cpu.usage !== undefined ? s.cpu.usage + '%' : '–';
    const mem = s.memory && s.memory.percent !== undefined ? s.memory.percent + '%' : '–';
    el.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'lp-dot';
    el.appendChild(dot);
    const t = document.createElement('span');
    t.textContent = `load ${load} · cpu ${cpu} · mem ${mem} · up ${fmtUptime(s.uptime)}`;
    el.appendChild(t);
    if (s.cpu && typeof s.cpu.usage === 'number') {
      lpCpuSamples.push(Math.max(0, s.cpu.usage));
      if (lpCpuSamples.length > 28) lpCpuSamples.shift();
      drawLpSpark();
    }
  } catch {}
}
function startLpPulse() {
  stopLpPulse();
  tickLpPulse();
  lpPulseTimer = setInterval(tickLpPulse, 5000);
}
function stopLpPulse() {
  if (lpPulseTimer) { clearInterval(lpPulseTimer); lpPulseTimer = null; }
}
function renderLaunchpad() {
  const host = (document.getElementById('hostname-badge')?.textContent || '').trim();
  document.getElementById('lp-host').textContent = host && host !== '—' ? host : 'local session';
  // Recent commands (freshest first)
  const cmds = document.getElementById('lp-cmds');
  cmds.innerHTML = '';
  const recent = [...(_cmdHistCache || [])].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 6);
  if (!recent.length) {
    const d = document.createElement('div');
    d.className = 'lp-empty';
    d.textContent = 'Run a command to pin it here';
    cmds.appendChild(d);
  }
  for (const h of recent) {
    if (!h.cmd) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lp-row';
    b.title = 'Run: ' + h.cmd;
    const ico = document.createElement('span');
    ico.style.display = 'inline-flex';
    ico.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
    b.appendChild(ico);
    const t = document.createElement('span');
    t.textContent = h.cmd;
    b.appendChild(t);
    b.addEventListener('click', () => launchAndRun(h.cmd));
    cmds.appendChild(b);
  }
  // Places: current dir, recent nav, bookmarks (deduped)
  const places = document.getElementById('lp-places');
  places.innerHTML = '';
  const seen = new Set();
  const dirs = [];
  for (const p of [currentPath, ...[...navHistory].reverse(), ...getBookmarks().map(b => b.path)]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    dirs.push(p);
    if (dirs.length >= 6) break;
  }
  if (!dirs.length) {
    const d = document.createElement('div');
    d.className = 'lp-empty';
    d.textContent = 'No places yet';
    places.appendChild(d);
  }
  for (const p of dirs) {
    const base = p.split(/[\\/]/).filter(Boolean).pop() || p;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lp-row';
    b.title = p;
    const ico = document.createElement('span');
    ico.style.display = 'inline-flex';
    ico.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    b.appendChild(ico);
    const t = document.createElement('span');
    t.textContent = base;
    b.appendChild(t);
    b.addEventListener('click', () => newTab(undefined, undefined, p));
    places.appendChild(b);
  }
  renderLpToday();
  wireLpKeys();
}
function renderLpToday() {
  const el = document.getElementById('lp-today');
  if (!el) return;
  try {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let n = 0, top = null, topCount = 0;
    for (const h of (_cmdHistCache || [])) {
      if (!h.cmd || !(h.time >= dayStart)) continue;
      const c = h.count || 1;
      n += c;
      if (c > topCount) { topCount = c; top = h.cmd; }
    }
    el.innerHTML = '';
    if (!n) { el.textContent = 'A fresh shell awaits its first command'; return; }
    el.appendChild(document.createTextNode('today · ' + n + (n === 1 ? ' command · top: ' : ' commands · top: ')));
    const b = document.createElement('b');
    b.textContent = top;
    el.appendChild(b);
  } catch {}
}
// Number-key runs (1–6): document-level so they work no matter where
// focus sits, gated on launchpad visibility + editable targets.
let _lpKeysWired = false;
function wireLpKeys() {
  if (_lpKeysWired) return;
  _lpKeysWired = true;
  document.addEventListener('keydown', e => {
    const lp = document.getElementById('launchpad');
    if (!lp || !lp.classList.contains('show')) return;
    if (!/^[1-6]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.overlay.open')) return;
    const rows = lp.querySelectorAll('#lp-cmds .lp-row');
    const row = rows[parseInt(e.key, 10) - 1];
    if (row) { e.preventDefault(); row.click(); }
  });
}

function initTerminal(tab) {
  const cfg = {
    fontFamily: settings.font,
    fontSize: settings.fontSize,
    cursorStyle: settings.cursor,
    cursorBlink: settings.blink,
    scrollback: settings.scrollback,
    allowTransparency: false,
    theme: getXtermTheme(),
    windowsMode: serverPlatform === 'win32',
    convertEol: false,
    bellStyle: settings.bell ? 'sound' : 'none',
    smoothScrollDuration: 80,
    selectionTheme: getXtermSelectionTheme()
  };

  const term = new Terminal(cfg);
  const fitAddon = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(webLinksAddon);

  // Real match counts. addon-search has no getDecorations(), so the UI used to
  // print a hardcoded "1/1"; onDidChangeResults is the actual API and fires
  // when a search carries decorations (see SEARCH_DECORATIONS).
  try {
    tab._searchResultsSub = searchAddon.onDidChangeResults(res => {
      try {
        if (getActiveTab() !== tab) return;
        const el = document.getElementById('search-results');
        if (!el) return;
        const q = document.getElementById('search-input')?.value || '';
        if (!q) { el.textContent = ''; return; }
        // resultIndex is -1 when the match limit is exceeded.
        if (!res || res.resultIndex < 0 || !res.resultCount) { el.textContent = q ? 'No results' : ''; return; }
        el.textContent = `${res.resultIndex + 1}/${res.resultCount}`;
      } catch {}
    });
  } catch (_) {}

  try {
    const unicodeAddon = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = '11';
  } catch (_) {}

  // GPU-accelerated renderer — falls back to canvas if WebGL unavailable (skip if >4 tabs to guard memory)
  if (tabs.filter(t => t.term).length < 4) {
    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => { try { webglAddon.dispose(); } catch {} try { term.element?.querySelector('canvas')?.remove(); } catch {} });
      term.loadAddon(webglAddon);
      tab._webglAddon = webglAddon;
    } catch (_) {}
  }

  term.open(tab.wrapper);

  tab.term = term;
  tab.fitAddon = fitAddon;
  tab.searchAddon = searchAddon;
  tab.closed = false;
  tab.textarea = term.textarea || term.element?.querySelector('.xterm-textarea, textarea');
  if (tab.textarea && !tab.textarea.id) {
    tab.textarea.id = 'xterm-helper-' + tab.id;
    tab.textarea.name = 'terminal-input';
  }

  // Intercept paste events to use bracketed paste mode (required for TUI apps like vim, nano, mc).
  // NOTE: xterm.js also listens for 'paste' on the same textarea and re-emits
  // it via onData. Without stopping propagation our bracketed send + xterm's
  // send fire together, pasting everything twice (notably with the native
  // browser context menu when the custom right-click menu is disabled).
  if (tab.textarea) {
    tab.textarea.addEventListener('paste', e => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      const text = (e.clipboardData || window.clipboardData)?.getData('text');
      if (!text || !tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
      tab._lastPasteText = text;
      // sendWsInput() chunks on character boundaries — the old fixed 60KB byte
      // slices cut multibyte characters in half, showing up as � in the shell.
      const bracketed = '\x1b[200~' + text + '\x1b[201~';
      try { sendWsInput(tab.ws, bracketed); } catch {}
    }, true);
  }

  // term.onFocus() was removed from xterm.js — use native DOM event instead
  term.element.addEventListener('focusin', () => {
    if (activeTabId !== tab.id) {
      activateTab(tab.id);
    }
  });

  // Title updates from OSC
  term.onTitleChange(title => {
    tab.title = title || `Term ${tab.id}`;
    tab.el.querySelector('.tab-title').textContent = tab.title;
  });

  // Bell: visual flash + desktop notification for background tabs (also flash parent for WebGL)
  term.onBell(() => {
    // Visual flash on terminal screen and parent (WebGL uses canvas, so also flash parent)
    const screen = term.element?.querySelector('.xterm-screen');
    const parent = term.element;
    [screen, parent].forEach(el => {
      if (!el) return;
      el.classList.remove('term-bell-flash');
      void el.offsetWidth; // reflow to restart animation
      el.classList.add('term-bell-flash');
      setTimeout(() => el.classList.remove('term-bell-flash'), 150);
    });
    // Desktop notification if tab is in the background
    if (document.hidden && settings.bell && Notification.permission === 'granted') {
      try {
        new Notification(tab.title || 'WebTun', { body: 'Terminal bell', tag: 'webtun-bell' });
      } catch (_) {}
    }
  });

  // Resize observer
  tab.resizeObserver = new ResizeObserver(() => {
    // In tile view every wrapper is visible, so background tiles must refit
    // too — they used to stay at their old size forever.
    if (tilesMode) {
      tabs.forEach(t => { if (t.term && t.wrapper) { try { fitTerm(t); } catch {} } });
      return;
    }
    if (activeTabId === tab.id) { try { fitTerm(tab); } catch(e) { console.warn(e); } }
  });
  tab.resizeObserver.observe(tab.wrapper);

  // Copy selection to clipboard using modern API
  term.element.addEventListener('copy', e => {
    const sel = term.getSelection();
    if (sel) {
      e.preventDefault();
      navigator.clipboard.writeText(sel).then(() => {
        toast('Copied to clipboard', 'success');
      }).catch(() => {
        document.execCommand('copy');
      });
    }
  });

  // Terminal right-click context menu
  term.element.addEventListener('contextmenu', e => {
    if (!settings.termRightClick) return;
    e.preventDefault();
    const menu = document.getElementById('term-ctx-menu');
    const sel = term.getSelection();
    document.getElementById('term-ctx-copy').style.opacity = sel ? '' : '0.5';
    // Show first to measure actual dimensions
    menu.style.display = 'block';
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = e.clientX;
    let top = e.clientY;
    // Flip horizontally if overflowing right
    if (left + mw > vw) left = Math.max(0, e.clientX - mw);
    // Flip vertically if overflowing bottom
    if (top + mh > vh) top = Math.max(0, e.clientY - mh);
    // Clamp to viewport
    left = Math.max(0, Math.min(left, vw - mw));
    top = Math.max(0, Math.min(top, vh - mh));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    // Keep typing focus in the terminal for mouse right-clicks so the cursor
    // stays active. Only move focus into the menu for keyboard-invoked
    // context menus (Shift+F10 / Menu key reports 0,0) where keyboard nav is
    // needed. Focus is restored to the terminal on dismiss (see hideTermCtxMenu).
    if (e.clientX === 0 && e.clientY === 0) {
      menu.querySelector('.ctx-item')?.focus();
    } else {
      term.focus();
    }
  });

  // Touch-to-mouse translation for TUI apps (mobile)
  let _tapTimeout = null, _tapPos = null, _longPressTimer = null;
  term.element.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    _tapPos = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    // Long press detection for right-click
    _longPressTimer = setTimeout(() => {
      if (_tapPos) {
        const evt = new MouseEvent('mousedown', { clientX: _tapPos.x, clientY: _tapPos.y, button: 2, bubbles: true });
        term.element.dispatchEvent(evt);
        const upEvt = new MouseEvent('mouseup', { clientX: _tapPos.x, clientY: _tapPos.y, button: 2, bubbles: true });
        term.element.dispatchEvent(upEvt);
        _tapPos = null;
      }
    }, 500);
  }, { passive: true });
  term.element.addEventListener('touchend', e => {
    clearTimeout(_longPressTimer);
    if (!_tapPos || e.changedTouches.length !== 1) return;
    const touch = e.changedTouches[0];
    const dx = Math.abs(touch.clientX - _tapPos.x);
    const dy = Math.abs(touch.clientY - _tapPos.y);
    const dt = Date.now() - _tapPos.time;
    if (dx < 10 && dy < 10 && dt < 300) {
      // Short tap → left click
      const evt = new MouseEvent('mousedown', { clientX: touch.clientX, clientY: touch.clientY, button: 0, bubbles: true });
      term.element.dispatchEvent(evt);
      const upEvt = new MouseEvent('mouseup', { clientX: touch.clientX, clientY: touch.clientY, button: 0, bubbles: true });
      term.element.dispatchEvent(upEvt);
    }
    _tapPos = null;
  }, { passive: true });
  term.element.addEventListener('touchmove', () => {
    clearTimeout(_longPressTimer);
    _tapPos = null;
  }, { passive: true });

  // Fit terminal then connect WebSocket — ensures WS uses correct dimensions
  requestAnimationFrame(() => {
    fitTerm(tab);
    if (!tab.closed) connectWebSocket(tab, false);
  });

  // Scroll terminal on wheel — with try/catch fallback for isMouseTracking
  tab.wrapper.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    // TUI apps with mouse tracking handle scroll themselves — forward the event to xterm.js
    const isTracking = xtermMouseTracking(term);
    if (isTracking) {
      try {
        const vp = tab.wrapper.querySelector('.xterm-viewport');
        if (vp) vp.dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY, deltaMode: e.deltaMode, deltaX: e.deltaX, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, bubbles: true }));
        return;
      } catch (_) { /* fallback to manual scroll */ }
    }
    const atTop = term.buffer.active.baseY === 0;
    const atBottom = term.buffer.active.baseY + term.rows >= term.buffer.active.length;
    if (tilesMode && ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom))) return;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 16 * term.rows;
    const lineHeight = xtermCharHeight(term, tab.wrapper);
    const lines = Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / lineHeight));
    term.scrollLines(lines);
  }, { passive: false });

  // Pinch-to-zoom on mobile
  let lastPinchDist = 0;
  tab.wrapper.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });
  tab.wrapper.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const delta = dist - lastPinchDist;
      if (Math.abs(delta) > 10) {
        const curSize = tab.term.options.fontSize || 14;
        const newSize = Math.max(10, Math.min(28, curSize + (delta > 0 ? 1 : -1)));
        tab.term.options.fontSize = newSize;
        if (tab.fitAddon) tab.fitAddon.fit();
        // Deliberately NOT persisted: a pinch gesture is transient, and writing it into
        // wt-settings silently changed the user's saved default for every future tab.
        // Font size is set deliberately from Settings → Appearance.
        lastPinchDist = dist;
      }
    }
  }, { passive: false });
  tab.wrapper.addEventListener('touchend', e => {
    if (e.touches.length < 2) lastPinchDist = 0;
  }, { passive: true });
}

function getActiveTab() { return tabs.find(t => t.id === activeTabId); }

// ── xterm private-API isolation ─────────────────────────────────────────────
// xterm.js exposes no public API for cell metrics or mouse-tracking state — the
// official fit addon reads the same `_core` internals. All such access lives in
// these three helpers so an upgrade that renames them breaks exactly one place
// (each has a DOM/`term.modes` fallback rather than throwing).
function xtermCellMetrics(term) {
  try {
    const d = term?._core?.viewportRenderer?.dimensions || term?._core?._renderService?.dimensions;
    if (d && d.actualCellWidth && d.actualCellHeight) return d;
  } catch (_) {}
  return null;
}
function xtermMouseTracking(term) {
  try {
    // Public API (xterm ≥5): 'none' | 'x10' | 'vt200' | 'drag' | 'any'
    const mode = term?.modes?.mouseTrackingMode;
    if (typeof mode === 'string') return mode !== 'none';
  } catch (_) {}
  try {
    const svc = term?._core?.coreMouseService;
    if (svc && typeof svc.isMouseTrackingActive === 'function') return !!svc.isMouseTrackingActive();
  } catch (_) {}
  return false;
}
function xtermCharHeight(term, wrapper) {
  const d = xtermCellMetrics(term);
  if (d?.actualCellHeight) return d.actualCellHeight;
  const rowsEl = wrapper?.querySelector ? wrapper.querySelector('.xterm-rows') : null;
  return rowsEl && rowsEl.children[0] ? (rowsEl.children[0].getBoundingClientRect().height || 16) : 16;
}

function fitTerm(tab) {
  try {
    if (!tab?.term?.element || !tab.wrapper) return;
    const d = xtermCellMetrics(tab.term);
    if (!d || !d.actualCellWidth || !d.actualCellHeight) {
      if (tab.fitAddon) { tab.fitAddon.fit(); }
      return;
    }
    const el = tab.term.element;
    const parent = el.parentElement;
    if (!parent) return;
    const ps = getComputedStyle(parent);
    const pt = parseFloat(ps.paddingTop) || 0;
    const pb = parseFloat(ps.paddingBottom) || 0;
    const pl = parseFloat(ps.paddingLeft) || 0;
    const pr = parseFloat(ps.paddingRight) || 0;
    let availW = parent.clientWidth - pl - pr;
    let availH = parent.clientHeight - pt - pb;
    if (tilesMode) {
      const hdr = tab.wrapper.querySelector('.term-tile-header');
      if (hdr) availH -= hdr.offsetHeight;
    }
    const cols = Math.max(1, Math.floor(availW / d.actualCellWidth));
    const rows = Math.max(1, Math.floor(availH / d.actualCellHeight));
    tab.term.resize(cols, rows);
  } catch (e) { console.warn('fitTerm failed:', e); }
}

let shiftLatch = false;
let altLatch = false;

function updateModifierButtons() {
  const sb = document.getElementById('shift-toggle-btn');
  if (sb) sb.classList.toggle('latch-active', shiftLatch);
  const ab = document.getElementById('alt-toggle-btn');
  if (ab) ab.classList.toggle('latch-active', altLatch);
}

function toggleShift() {
  shiftLatch = !shiftLatch;
  updateModifierButtons();
  if (shiftLatch) toast('Shift ON (next key)', 'info');
}

function toggleAlt() {
  altLatch = !altLatch;
  updateModifierButtons();
  if (altLatch) toast('Alt ON (next key)', 'info');
}

function sendKey(key) {
  let modified = key;
  if (key.length === 1) {
    if (shiftLatch && modified >= 'a' && modified <= 'z') {
      modified = modified.toUpperCase();
    }
    shiftLatch = false;
    if (altLatch && modified.charCodeAt(0) >= 0x20) {
      modified = '\x1b' + modified;
      altLatch = false;
    }
    updateModifierButtons();
  } else {
    shiftLatch = false;
    altLatch = false;
    updateModifierButtons();
  }
  const tab = getActiveTab();
  if (tab?.ws?.readyState === WebSocket.OPEN) {
    const enc = new TextEncoder().encode(modified);
    const buf = new Uint8Array(1 + enc.length);
    buf[0] = 0x00; buf.set(enc, 1);
    tab.ws.send(buf.buffer);
  }
  tab?.term?.focus();
}

function sendCtrlP() {
  sendKey('\x10');
  openFinder();
}

// ═══════════════════════════════════════════════════════
// TILES MODE
// ═══════════════════════════════════════════════════════
function toggleTiles() {
  tilesMode = !tilesMode;
  document.getElementById('tilesBtn').classList.toggle('active', tilesMode);
  document.getElementById('terminals').classList.toggle('tiles-mode', tilesMode);
  if (tilesMode) {
    layoutTiles();
  } else {
    const termWrap = document.getElementById('terminals');
    termWrap.querySelectorAll('.term-tile-header').forEach(el => el.remove());
    const t = getActiveTab();
    setTimeout(() => { try { fitTerm(t); } catch(e) { console.warn(e); } }, 60);
  }
}

function layoutTiles() {
  const termWrap = document.getElementById('terminals');
  tabs.forEach(tab => {
    if (!tab.wrapper) return;
    let hdr = tab.wrapper.querySelector('.term-tile-header');
    if (hdr) {
      hdr.querySelector('.tth-name').textContent = tab.title;
      return;
    }
    hdr = document.createElement('div');
    hdr.className = 'term-tile-header';
    hdr.setAttribute('tabindex', '0');
    hdr.setAttribute('role', 'button');
    hdr.setAttribute('aria-label', 'Activate ' + tab.title);
    const tthName = document.createElement('span');
    tthName.className = 'tth-name';
    // Plain span on purpose: `hdr` is already the button (role=button +
    // tabindex). A nested focusable role=button is invalid for screen readers.
    tthName.textContent = tab.title;
    hdr.appendChild(tthName);
    const tthClose = document.createElement('button');
    tthClose.className = 'tth-close';
    tthClose.setAttribute('aria-label', 'Close tab');
    tthClose.setAttribute('tabindex', '0');
    tthClose.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    hdr.appendChild(tthClose);
    hdr.addEventListener('click', e => {
      if (e.target.closest('.tth-close')) return;
      activateTab(tab.id);
    });
    hdr.addEventListener('keydown', e => {
      // Enter/Space on the header both activates and focuses the terminal, which
      // is what the (now removed) nested name button used to do.
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(tab.id); tab.term?.focus(); }
    });
    hdr.querySelector('.tth-close').addEventListener('click', e => {
      e.stopPropagation();
      closeTab(e, tab.id);
    });
    tab.wrapper.prepend(hdr);
  });
  // Tile view shows every tile at once, so mount the text tabs' editors here. Heavy
  // viewers are deliberately excluded: they stay single-live and show their parked
  // card rather than holding several documents in memory.
  if (tilesMode) {
    tabs.forEach(tab => {
      if (tab.type === 'file' && !tab.closed && tab.viewer === 'text' && !tab.cm) {
        mountFileTab(tab).catch(e => console.warn('Tile mount failed:', e));
      }
    });
  }
  setTimeout(() => {
    tabs.forEach(tab => { try { fitTerm(tab); } catch(e) { console.warn(e); } });
    // CodeMirror views have to re-measure: they just became tiles, or changed size.
    try { if (_dockedFileTabId != null) editor?.refresh(); } catch(e) { console.warn(e); }
    tabs.forEach(tab => { try { if (tab.cm) tab.cm.refresh(); } catch(e) { console.warn(e); } });
  }, 60);
}

// UTF-8 safe base64 (OSC 52). atob/btoa are Latin-1 only and throw on
// emoji/CJK — those payloads silently lost the clipboard sync entirely.
function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000; // chunked: avoid blowing the arg limit on big clips
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ═══════════════════════════════════════════════════════
// XTERM THEME
// ═══════════════════════════════════════════════════════
// Read the theme variables off <body>, which is the element that actually
// carries the resolved [data-theme=…]; documentElement only had it after an
// explicit applyTheme(), so the first terminal painted with the wrong palette.
function getXtermTheme() {
  const s = getComputedStyle(document.body || document.documentElement);
  const g = v => s.getPropertyValue(v).trim();
  return {
    background: g('--bg'), foreground: g('--fg'), cursor: g('--accent'),
    cursorAccent: g('--bg'), selectionBackground: g('--accent') + '44',
    black: '#000000', red: g('--red'), green: g('--green'), yellow: g('--yellow'),
    blue: g('--accent'), magenta: g('--accent2'), cyan: g('--cyan'), white: g('--fg'),
    brightBlack: g('--fg2'), brightRed: g('--red'), brightGreen: g('--green'),
    brightYellow: g('--yellow'), brightBlue: g('--accent'), brightMagenta: g('--accent2'),
    brightCyan: g('--cyan'), brightWhite: '#ffffff'
  };
}

function getXtermSelectionTheme() {
  const s = getComputedStyle(document.body || document.documentElement);
  const g = v => s.getPropertyValue(v).trim();
  return {
    extension: true,
    foreground: g('--bg'),
    background: g('--accent') + '44'
  };
}

// ═══════════════════════════════════════════════════════
// FILE EXPLORER
// ═══════════════════════════════════════════════════════
let loadFilesAbortController = null;
let fileListLoadingTimer = null;
function setFileListLoading(on) {
  const wrap = document.getElementById('file-list-wrap');
  if (!wrap) return;
  clearTimeout(fileListLoadingTimer);
  if (on) {
    fileListLoadingTimer = setTimeout(() => {
      wrap.classList.add('loading');
      document.getElementById('refresh-btn')?.classList.add('spinning');
    }, 150);
    // Skeleton shimmer on first paint (empty list only — refresh keeps live rows)
    const list = document.getElementById('file-list');
    if (list && !list.children.length) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 8; i++) {
        const s = document.createElement('div');
        s.className = 'file-skel';
        s.setAttribute('aria-hidden', 'true');
        s.innerHTML = '<span class="sk-ico"></span><span class="sk-lines"><span class="sk-l1"></span><span class="sk-l2"></span></span>';
        frag.appendChild(s);
      }
      list.appendChild(frag);
    }
  } else {
    fileListLoadingTimer = null;
    wrap.classList.remove('loading');
    document.getElementById('refresh-btn')?.classList.remove('spinning');
  }
}

// Watcher ticks must never preempt user navigation (they'd abort the
// folder fetch and re-render the old path). Foreground calls set the flag;
// background ticks back off while one is in flight.
let _fgLoadActive = false;
async function loadFiles(dir, opts = {}) {
  const bg = !!(opts && opts.background);
  if (bg && _fgLoadActive) return;
  _fgLoadActive = !bg;
  try { return await _loadFilesInner(dir); }
  finally { _fgLoadActive = false; }
}
async function _loadFilesInner(dir) {
  if (loadFilesAbortController) loadFilesAbortController.abort();
  loadFilesAbortController = new AbortController();

  const prevPath = currentPath;
  const shouldPushHistory = !skipHistoryPush && currentPath && currentPath !== dir;
  skipHistoryPush = false;

  const list = document.getElementById('file-list');

  setFileListLoading(true);
  let data;
  try {
    data = await api(`/api/files?path=${encodeURIComponent(dir)}`, { signal: loadFilesAbortController.signal });
  } catch (e) {
    if (e.name === 'AbortError') { setFileListLoading(false); return; }
    setFileListLoading(false);
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding:16px;text-align:center;';
    errorDiv.innerHTML = '<div style="color:var(--red);margin-bottom:8px">Failed to load directory</div>' +
      '<div style="color:var(--fg2);font-size:11px;margin-bottom:8px;word-break:break-all">' + escHtml(e.message || 'Unknown error') + '</div>' +
      '<button class="btn btn-primary" style="height:28px;padding:0 12px;font-size:11px">Retry</button>';
    list.innerHTML = '';
    list.appendChild(errorDiv);
    errorDiv.querySelector('button').addEventListener('click', () => loadFiles(dir));
    toast(e.message || 'Failed to load directory', 'error');
    return;
  }

  if (!data.files) {
    setFileListLoading(false);
    const msg = data.error || 'Failed to load directory';
    // Revert optimistic path — don't save failed dir
    // Show error instead of silent bounce
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding:16px;text-align:center;';
    errorDiv.innerHTML = '<div style="color:var(--red);margin-bottom:8px">' + escHtml(msg) + '</div>' +
      '<button class="btn btn-primary" style="height:28px;padding:0 12px;font-size:11px">Retry</button>';
    list.innerHTML = '';
    list.appendChild(errorDiv);
    errorDiv.querySelector('button').addEventListener('click', () => loadFiles(dir));
    toast(msg, 'error');
    // Only bounce to home if dir != home and home is different and we haven't already shown home
    if (dir !== homeDir && prevPath !== homeDir) {
      // keep currentPath as prevPath, don't update breadcrumb to failed dir
      document.getElementById('path-input').value = prevPath;
      renderBreadcrumb(prevPath);
    } else {
      // we are already at home or prevPath is home — update UI to reflect attempted dir for debugging
      document.getElementById('path-input').value = dir;
      renderBreadcrumb(dir);
    }
    return;
  }

  // Success — now update history and UI state
  if (shouldPushHistory) {
    navHistory.push(prevPath);
    navForwardHistory = [];
  }

  currentPath = data.path || dir;
  document.getElementById('path-input').value = currentPath;
  renderBreadcrumb(currentPath);
  saveCurrentPath();
  refreshGitPanel(currentPath);

  currentParent = data.parent || '';

  // Map existing DOM children by dataset.path
  const oldMap = new Map();
  for (const child of Array.from(list.children)) {
    const p = child.dataset.path;
    if (p) oldMap.set(p, child);
  }

  const fragment = document.createDocumentFragment();

  // Build new file list, reusing existing nodes when paths match
  function addItem(key, make) {
    const existing = oldMap.get(key);
    if (existing) {
      fragment.appendChild(existing);
      oldMap.delete(key);
      return existing;
    }
    const item = make();
    item.dataset.path = key;
    fragment.appendChild(item);
    return item;
  }

  // Parent dir entry (+ Folders divider when it leads the group)
  const dirCount = data.files.filter(f => f.isDir).length;
  const fileCount = data.files.length - dirCount;
  _thumbBudget = 48; // fresh thumbnail allowance per render
  // Sort state: dirs always first (groups depend on it), then key+dir.
  // Click a group divider = next key · right-click it = reverse direction.
  const _sortKeyLabel = { name: 'name', modified: 'date', size: 'size' };
  const sortTag = () => ` · ${_sortKeyLabel[fileSort.key]} ${fileSort.dir === 1 ? '↑' : '↓'}`;
  const addGroupDivider = (label, count) => {
    const gd = document.createElement('div');
    gd.className = 'file-group';
    gd.setAttribute('role', 'button');
    gd.setAttribute('tabindex', '0');
    gd.title = 'Change sort (right-click reverses)';
    const s1 = document.createElement('span');
    s1.textContent = label;
    const s2 = document.createElement('span');
    s2.className = 'fg-count';
    s2.textContent = String(count);
    const s3 = document.createElement('span');
    s3.className = 'fg-sort';
    s3.textContent = sortTag();
    gd.appendChild(s1); gd.appendChild(s2); gd.appendChild(s3);
    gd.addEventListener('click', cycleFileSort);
    gd.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleFileSort(); }
    });
    gd.addEventListener('contextmenu', e => {
      e.preventDefault();
      fileSort.dir = -fileSort.dir;
      saveFileSort();
      if (currentPath) loadFiles(currentPath);
    });
    fragment.appendChild(gd);
  };
  let dirsHeaderDone = false;
  if (data.parent && data.parent !== dir) {
    const folderSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
    if (dirCount > 0) { addGroupDivider('Folders', dirCount); dirsHeaderDone = true; }
    const parentRow = addItem(data.parent, () => makeFileItem('..', true, data.parent, { icon: folderSvg, meta: 'Parent directory', kind: 'dir' }));
    // Flag the ".." row so its checkbox stays hidden and it can't be selected
    parentRow.classList.add('is-parent');
    parentRow.dataset.isParent = 'true';
  }

  let filesHeaderDone = false;
  const files = sortFiles(data.files || []);
  files.forEach(f => {
    const key = f.path;
    const icon = f.isDir ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' : getFileIcon(f.ext);
    const sizeStr = f.isDir ? null : formatSize(f.size);
    const dateStr = f.modified ? timeAgo(f.modified) : '';
    const kind = fileKind(f.ext, f.isDir);
    const thumb = thumbUrlFor(f);
    let meta = sizeStr ? sizeStr : '';
    if (dateStr) meta += (meta ? ' · ' + dateStr : dateStr);
    if (!meta && f.isDir) meta = 'Folder';
    if (f.isSymlink) meta += (meta ? ' · link' : 'link');
    if (f.isDir) {
      if (!dirsHeaderDone) { addGroupDivider('Folders', dirCount); dirsHeaderDone = true; }
    } else if (!filesHeaderDone) {
      addGroupDivider('Files', fileCount); filesHeaderDone = true;
    }

    const existing = oldMap.get(key);
    if (existing) {
      // A reused node is a regular entry, never the ".." parent row
      existing.classList.remove('is-parent');
      delete existing.dataset.isParent;
      // Update name/meta/icon if changed (without recreating DOM)
      const nameEl = existing.querySelector('.file-name');
      if (nameEl && nameEl.dataset.raw !== f.name) {
        paintFileName(nameEl, f.name, f.isDir);
        nameEl.title = key;
      }
      const iconEl = existing.querySelector('.file-icon');
      if (iconEl) {
        if (iconEl.innerHTML !== icon) iconEl.innerHTML = icon;
        const tileCls = 'file-icon k-' + kind;
        if (iconEl.className !== tileCls) iconEl.className = tileCls;
      }
      const metaEl = existing.querySelector('.file-meta');
      if (metaEl) {
        if (metaEl.textContent !== meta) metaEl.textContent = meta;
      } else if (meta) {
        const mspan = document.createElement('span');
        mspan.className = 'file-meta';
        mspan.textContent = meta;
        const textWrap = existing.querySelector('.file-text');
        if (textWrap) textWrap.appendChild(mspan);
      }
      // Thumbnail freshness: track expected URL, swap only on change
      const tileEl = existing.querySelector('.file-icon');
      if (thumb) {
        if (existing.dataset.thumb !== thumb) {
          existing.dataset.thumb = thumb;
          let im = existing.querySelector('img.file-thumb');
          if (!im) {
            im = document.createElement('img');
            im.className = 'file-thumb';
            im.alt = '';
            im.onload = () => im.classList.add('ld');
            im.onerror = () => im.remove();
            if (tileEl) tileEl.appendChild(im);
          }
          im.classList.remove('ld');
          im.dataset.src = thumb;
          im.removeAttribute('src');
          if (_thumbObserver) _thumbObserver.observe(im);
          else observeThumbs();
        }
      } else {
        delete existing.dataset.thumb;
        const stale = existing.querySelector('img.file-thumb');
        if (stale) stale.remove();
      }
      existing.dataset.isDir = String(f.isDir);
      existing.dataset.path = key;
      const checkEl = existing.querySelector('.file-select-check');
      if (checkEl) checkEl.setAttribute('data-path', key);
      const ellEl = existing.querySelector('.file-ellipsis');
      if (ellEl) ellEl.setAttribute('aria-label', 'More actions for ' + f.name);
      const nameEl2 = existing.querySelector('.file-name');
      if (nameEl2) nameEl2.title = key;
    }

    addItem(key, () => {
      const el = makeFileItem(f.name, f.isDir, key, { icon, meta, kind, link: f.isSymlink, download: !f.isDir, thumb });
      if (thumb) el.dataset.thumb = thumb;
      return el;
    });
  });

  // Remove any orphaned nodes (not in new data)
  for (const [, orphan] of oldMap) orphan.remove();

  list.replaceChildren(fragment);
  observeThumbs();

  if (list.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'file-list-empty';
    empty.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span class="empty-title">Empty directory</span>' +
      '<div class="empty-actions">' +
      '<button class="btn btn-ghost" onclick="openOverlay(\'newfile-overlay\');document.getElementById(\'newfile-input\').focus()">New file</button>' +
      '<button class="btn btn-ghost" onclick="openOverlay(\'newfolder-overlay\');document.getElementById(\'newfolder-input\').focus()">New folder</button>' +
      '<button class="btn btn-ghost" onclick="uploadFiles()">Upload</button>' +
      '</div>';
    list.appendChild(empty);
  }

  updateBackBtn();
  setFileListLoading(false);
}

let fileItemCounter = 0;

// File list sort: dirs always first (groups depend on it), then key+dir.
// Click a group divider = next key · right-click it = reverse direction.
let fileSort = { key: 'name', dir: 1 };
try {
  const saved = JSON.parse(safeStorage.getItem('wt-file-sort') || 'null');
  if (saved && ['name', 'modified', 'size'].includes(saved.key) && (saved.dir === 1 || saved.dir === -1)) fileSort = saved;
} catch {}
function saveFileSort() { try { safeStorage.setItem('wt-file-sort', JSON.stringify(fileSort)); } catch {} }
function sortFiles(files) {
  const { key, dir } = fileSort;
  const val = (f) => key === 'name' ? (f.name || '').toLowerCase() : key === 'size' ? (f.size || 0) : (f.modified ? new Date(f.modified).getTime() || 0 : 0);
  return [...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const va = val(a), vb = val(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return (a.name || '').localeCompare(b.name || '');
  });
}
const _sortCycle = ['name', 'modified', 'size'];
function cycleFileSort() {
  const i = _sortCycle.indexOf(fileSort.key);
  fileSort.key = _sortCycle[(i + 1) % _sortCycle.length];
  fileSort.dir = fileSort.key === 'name' ? 1 : -1;
  saveFileSort();
  if (currentPath) loadFiles(currentPath);
}

// Single source of truth for extension → kind, shared by fileKind() (tile colour)
// and getFileIcon() (inline SVG). These used to be two hand-maintained lists that
// drifted: `.mjs`/`.cjs`/`.bash`/`.swift` got the *code* icon on a generic tile,
// while `.txt`/`.md`/`.docx` got the generic icon on a *doc* tile. One map, one answer.
const EXT_KIND = (() => {
  const groups = {
    code: ['.js','.jsx','.mjs','.cjs','.ts','.tsx','.json','.py','.c','.h','.cpp','.cc','.hpp','.java','.cs','.sh','.bash','.html','.htm','.css','.xml','.yml','.yaml','.toml','.sql','.go','.rs','.rb','.php','.pl','.swift','.kt','.dart','.lua','.r'],
    // .svg lives here, not under code: it is previewable inline as an image.
    img: ['.png','.jpg','.jpeg','.gif','.webp','.ico','.bmp','.avif','.svg'],
    doc: ['.pdf','.epub','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.md'],
    zip: ['.zip','.tar','.gz','.tgz','.bz2','.xz','.7z','.rar'],
  };
  const m = new Map();
  for (const [kind, exts] of Object.entries(groups)) for (const e of exts) m.set(e, kind);
  return m;
})();

// Icon tile kind (dir/code/img/doc/zip/file) — the values are also CSS class suffixes.
function fileKind(ext, isDir) {
  if (isDir) return 'dir';
  return EXT_KIND.get((ext || '').toLowerCase()) || 'file';
}

function extKind(ext) {
  return EXT_KIND.get((ext || '').toLowerCase()) || 'file';
}

function timeAgo(ts) {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.floor(m) + 'm ago';
  const h = m / 60;
  if (h < 24) return Math.floor(h) + 'h ago';
  const d = h / 24;
  if (d < 30) return Math.floor(d) + 'd ago';
  return new Date(t).toLocaleDateString();
}

// Lazy image thumbnails inside file tiles (IntersectionObserver on the
// scroll wrap; gated by size so huge photos keep the generic tile).
let _thumbObserver = null;
let _thumbBudget = 48;
function ensureThumbObserver() {
  if (_thumbObserver) return;
  if (!('IntersectionObserver' in window)) return;
  const wrap = document.getElementById('file-list-wrap');
  if (!wrap) return;
  _thumbObserver = new IntersectionObserver((es) => {
    for (const en of es) {
      if (!en.isIntersecting) continue;
      const img = en.target;
      _thumbObserver.unobserve(img);
      if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
    }
  }, { root: wrap, rootMargin: '200px 0px' });
}
function observeThumbs() {
  const run = () => {
    ensureThumbObserver();
    const imgs = document.querySelectorAll('#file-list img.file-thumb[data-src]');
    if (!_thumbObserver) {
      imgs.forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
      return;
    }
    imgs.forEach(img => _thumbObserver.observe(img));
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 50);
}
function thumbUrlFor(f) {
  if (!f || f.isDir || !(f.size > 0) || f.size > 600000) return null;
  if (_thumbBudget <= 0) return null;
  _thumbBudget--;
  const v = (f.modified && Date.parse(f.modified)) || 0;
  return `/api/files/image?path=${encodeURIComponent(f.path)}&token=${encodeURIComponent(authToken || '')}&v=${v}`;
}

// Long names truncate in the MIDDLE (head…tail) so the file extension — the
// most identifying part — stays visible. The raw name rides on data-raw:
// never read .file-name textContent for logic (it contains the … marker).
const FIT_HEAD = 22, FIT_TAIL = 18;
function fitFileName(name) {
  const n = String(name == null ? '' : name);
  if (n.length <= FIT_HEAD + FIT_TAIL + 1) return escHtml(n);
  const dot = n.lastIndexOf('.');
  let tail;
  if (dot > 0 && n.length - dot <= 12) {
    const stem = n.slice(0, dot);
    tail = stem.slice(-Math.max(0, FIT_TAIL - (n.length - dot))) + n.slice(dot);
  } else {
    tail = n.slice(-FIT_TAIL);
  }
  return escHtml(n.slice(0, FIT_HEAD)) + '<span class="fn-ellipsis" aria-hidden="true">…</span>' + escHtml(tail);
}
function fileRowName(row, fallbackPath) {
  try {
    const el = row && row.querySelector('.file-name');
    if (el && el.dataset && el.dataset.raw) return el.dataset.raw;
    if (el && el.textContent && el.textContent.indexOf('…') === -1) return el.textContent;
  } catch {}
  const p = fallbackPath || (row && row.dataset && row.dataset.path) || '';
  return (p.split(/[\\/]/).pop() || p);
}
function paintFileName(nameEl, name, isDir) {
  nameEl.innerHTML = fitFileName(name);
  nameEl.dataset.raw = String(name);
  nameEl.className = 'file-name' + (isDir ? ' file-dir' : '');
}
function makeFileItem(name, isDir, fullPath, o) {
  o = o || {};
  const div = document.createElement('div');
  div.className = 'file-item';
  div.id = 'file-item-' + (++fileItemCounter);
  div.setAttribute('role', 'option');
  div.setAttribute('aria-selected', 'false');
  div.dataset.path = fullPath;
  div.dataset.isDir = String(isDir);
  div.innerHTML = `
    <span class="file-select-check" data-path="${escHtml(fullPath)}"></span>
    <span class="file-icon k-${o.kind || 'file'}">${o.icon || ''}${o.thumb ? `<img class="file-thumb" data-src="${escHtml(o.thumb)}" alt="" onload="this.classList.add('ld')" onerror="this.remove()">` : ''}</span>
    <span class="file-text">
      <span class="file-name ${isDir ? 'file-dir' : ''}" data-raw="${escHtml(name)}" title="${escHtml(fullPath)}">${fitFileName(name)}</span>
      ${o.meta ? `<span class="file-meta">${escHtml(o.meta)}</span>` : ''}
    </span>
    ${o.download ? `<button class="file-quick" tabindex="-1" aria-label="Download ${escHtml(name)}" title="Download"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>` : ''}
    <span class="file-ellipsis" role="button" tabindex="0" aria-label="More actions for ${escHtml(name)}" title="More actions"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></span>
  `;
  return div;
}

// Single delegated click + key handler for all rows (perf: no per-row
// listeners, safe for thousand-file directories). Registered before the
// keyboard nav so ellipsis Enter/Space can stop propagation first.
function setupFileListClicks() {
  const list = document.getElementById('file-list');
  if (!list || list.dataset._clickSetup) return;
  list.dataset._clickSetup = '1';
  const rowInfo = (row) => {
    const curPath = row.dataset.path;
    const curIsDir = row.dataset.isDir === 'true';
    const curName = fileRowName(row, curPath);
    const m = curPath.match(/\.([^.]+)$/);
    return { curPath, curIsDir, curName, ext: m ? '.' + m[1].toLowerCase() : '' };
  };
  const openMenuFor = (row, anchorEl) => {
    const { curPath, curIsDir, curName, ext } = rowInfo(row);
    const rect = anchorEl.getBoundingClientRect();
    showCtxMenu({ clientX: rect.left + rect.width / 2, clientY: rect.bottom + 4, preventDefault() {}, stopPropagation() {} }, { path: curPath, name: curName, isDir: curIsDir, ext });
  };
  list.addEventListener('click', e => {
    const row = e.target.closest('.file-item');
    if (!row || !row.dataset.path) return;
    const { curPath, curIsDir } = rowInfo(row);
    const isParentRow = row.classList.contains('is-parent') || curPath === currentParent;
    if (e.target.closest('.file-select-check')) {
      if (isParentRow) return;
      toggleFileSelection(curPath, row);
      if (selectedFiles.length > 0) document.getElementById('select-actions').style.display = 'flex';
      return;
    }
    if (e.target.closest('.file-quick')) { downloadFile(curPath); return; }
    const ell = e.target.closest('.file-ellipsis');
    if (ell) { e.preventDefault(); e.stopPropagation(); openMenuFor(row, ell); return; }
    if (selectMode) {
      if (isParentRow) { loadFiles(curPath); return; }
      toggleFileSelection(curPath, row); return;
    }
    if (curIsDir) loadFiles(curPath);
    else openFileEditor(curPath);
  });
  list.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.file-ellipsis')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      const row = e.target.closest('.file-item');
      if (row) openMenuFor(row, e.target.closest('.file-ellipsis'));
    }
  });
}

function setupFileListKeyboard() {
  const list = document.getElementById('file-list');
  if (!list || list.dataset._kbSetup) return;
  list.dataset._kbSetup = '1';
  list.setAttribute('tabindex', '0');
  list.addEventListener('keydown', e => {
    const items = [...list.querySelectorAll('.file-item')];
    if (!items.length) return;
    let idx = items.findIndex(el => el.classList.contains('focused'));
    const focusIdx = i => {
      if (i < 0 || i >= items.length) return;
      items.forEach(el => el.classList.remove('focused'));
      items[i].classList.add('focused');
      if (items[i].id) list.setAttribute('aria-activedescendant', items[i].id);
      items[i].scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx(idx < 0 ? 0 : Math.min(idx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx(idx < 0 ? items.length - 1 : Math.max(0, idx - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); focusIdx(0); }
    else if (e.key === 'End') { e.preventDefault(); focusIdx(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (idx >= 0) items[idx].click(); }
    else if (e.key === 'Backspace' || e.key === 'ArrowLeft') { e.preventDefault(); navigateUp(); }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (selectMode) selectAllFiles(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const prefix = (list._typeAhead || '') + e.key.toLowerCase();
      list._typeAhead = prefix;
      clearTimeout(list._typeAheadTimer);
      list._typeAheadTimer = setTimeout(() => { list._typeAhead = ''; }, 500);
      const found = items.findIndex(el => {
        const nm = fileRowName(el, '');
        return nm && nm.toLowerCase().startsWith(prefix);
      });
      if (found >= 0) focusIdx(found);
    }
  });
}

function setupFileListContextMenu() {
  const list = document.getElementById('file-list');
  if (!list || list.dataset._ctxSetup) return;
  list.dataset._ctxSetup = '1';
  list.addEventListener('contextmenu', e => {
    const item = e.target.closest('.file-item');
    if (!item || !item.dataset.path) return;
    const curPath = item.dataset.path;
    const curIsDir = item.dataset.isDir === 'true';
    const curName = fileRowName(item, curPath);
    const m = curPath.match(/\.([^.]+)$/);
    const ext = m ? '.' + m[1].toLowerCase() : '';
    showCtxMenu(e, { path: curPath, name: curName, isDir: curIsDir, ext });
  });
}

function refreshFiles() {
  if (currentPath) loadFiles(currentPath);
}
function navigateTo(p) {
  if (!p || !String(p).trim()) return loadFiles(homeDir);
  let target = String(p).trim();
  // If relative path, resolve against currentPath
  const isAbsolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\');
  if (!isAbsolute) target = joinPath(currentPath || homeDir, target);
  loadFiles(target);
}
function navigateUp() {
  if (currentParent && currentParent !== currentPath) {
    loadFiles(currentParent);
  }
}
function navigateBack() {
  if (navHistory.length > 0) {
    skipHistoryPush = true;
    navForwardHistory.push(currentPath);
    loadFiles(navHistory.pop());
  }
}
function navigateForward() {
  if (navForwardHistory.length > 0) {
    skipHistoryPush = true;
    navHistory.push(currentPath);
    loadFiles(navForwardHistory.pop());
  }
}
function goToTerminalDir() {
  const tab = getActiveTab();
  if (tab && tab.cwd) loadFiles(tab.cwd);
}
function updateBackBtn() {
  const back = document.getElementById('back-btn');
  const fwd = document.getElementById('fwd-btn');
  if (back) back.style.opacity = navHistory.length > 0 ? '1' : '0.3';
  if (fwd) fwd.style.opacity = navForwardHistory.length > 0 ? '1' : '0.3';
}

let fileWatchTimer = null;
function startFileWatcher() {
  if (fileWatchTimer) return;
  const watch = () => {
    const sb = document.getElementById('sidebar');
    const sp = document.getElementById('settings-panel');
    if (!sb || sb.classList.contains('hidden') || document.hidden) return;
    if (sp && sp.classList.contains('open')) return;
    if (document.querySelector('.overlay.open')) return;
    const lp = document.getElementById('launchpad');
    if (lp && lp.classList.contains('show')) return;
    if (currentPath) loadFiles(currentPath, { background: true });
  };
  const onVisibility = () => {
    if (document.hidden) {
      clearInterval(fileWatchTimer);
      fileWatchTimer = null;
    } else {
      if (currentPath) loadFiles(currentPath);
      if (!fileWatchTimer) fileWatchTimer = setInterval(watch, 10000);
    }
  };
  document.addEventListener('visibilitychange', onVisibility, { passive: true });
  window.addEventListener('pagehide', () => {
    clearInterval(fileWatchTimer);
    fileWatchTimer = null;
  }, { passive: true });
  fileWatchTimer = setInterval(watch, 10000);
}

// Icon per kind — same EXT_KIND map as fileKind(), so the glyph and the tile colour
// can never disagree for a given extension again.
const FILE_ICONS = {
  code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  img: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  zip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
};

function getFileIcon(ext) {
  return FILE_ICONS[extKind(ext)];
}

function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

function renderBreadcrumb(fullPath) {
  const el = document.getElementById('path-segments');
  if (!el) return;
  const isWin = /\\/.test(fullPath) || /^[A-Za-z]:/.test(fullPath);
  const sep = isWin ? '\\' : '/';
  let html = '';

  if (isWin) {
    // e.g. C:\Users\name or \\server\share\path
    const normalized = fullPath.replace(/\//g, '\\');
    const unc = normalized.startsWith('\\\\');
    let rest = normalized;
    let accumulated = '';
    const segments = [];

    if (unc) {
      const m = normalized.match(/^\\\\[^\\]+\\[^\\]+/);
      if (m) {
        segments.push({ label: m[0], path: m[0] });
        rest = normalized.slice(m[0].length).replace(/^\\+/, '');
        accumulated = m[0];
      }
    } else {
      const driveMatch = normalized.match(/^([A-Za-z]:)(.*)$/);
      if (driveMatch) {
        const root = driveMatch[1] + '\\';
        segments.push({ label: driveMatch[1], path: root });
        rest = (driveMatch[2] || '').replace(/^\\+/, '');
        accumulated = root;
      }
    }

    const parts = rest.split('\\').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      accumulated = accumulated.endsWith('\\') ? accumulated + parts[i] : accumulated + '\\' + parts[i];
      segments.push({ label: parts[i], path: accumulated });
    }

    if (!segments.length) {
      html = `<span style="color:var(--fg2)">\\</span><span style="color:var(--fg2);font-size:11px;margin-left:3px">(root)</span>`;
    } else {
      html = segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        if (isLast) return `<button type="button" class="path-current" data-edit="1" title="${escHtml(seg.label)} — click to edit" aria-current="page">${escHtml(seg.label)}</button>`;
        return `<a href="#" data-path="${escHtml(seg.path)}" style="color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;height:24px;padding:2px 6px;border-radius:var(--radius-sm)">${escHtml(seg.label)}</a>` +
          `<span style="color:var(--fg2);margin:0 2px;display:inline-flex;align-items:center">\\</span>`;
      }).join('');
    }
  } else {
    const parts = fullPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let accumulated = '';
    for (const part of parts) {
      accumulated += '/' + part;
      const isLast = part === parts[parts.length - 1];
      if (isLast) {
        html += `<button type="button" class="path-current" data-edit="1" title="${escHtml(part)} — click to edit" aria-current="page">${escHtml(part)}</button>`;
      } else {
        html += `<a href="#" data-path="${escHtml(accumulated)}" style="color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;height:24px;padding:2px 6px;border-radius:var(--radius-sm)">${escHtml(part)}</a>`;
        html += `<span style="color:var(--fg2);margin:0 2px;display:inline-flex;align-items:center">/</span>`;
      }
    }
    if (!parts.length) {
      html = `<span style="color:var(--fg2)">/</span><span style="color:var(--fg2);font-size:11px;margin-left:6px">(root)</span>`;
    }
  }

  el.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--fg2);flex-shrink:0;vertical-align:middle"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' + html;
  // Deep paths overflow: keep the current (rightmost) end in view.
  try { el.scrollLeft = el.scrollWidth; } catch {}

  if (!el.dataset.delegated) {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-edit]')) { enterPathEdit(); return; }
      const a = e.target.closest('a[data-path]');
      if (a) { e.preventDefault(); navigateTo(a.dataset.path); }
    });
    el.dataset.delegated = '1';
  }
}

// Unified path bar: segments view ↔ editable input (replaces separate breadcrumb div).
// The #path-input keeps its id so existing currentPath sync keeps working.
function enterPathEdit() {
  const bar = document.getElementById('path-bar');
  const input = document.getElementById('path-input');
  if (!bar || !input || bar.classList.contains('editing')) return;
  input.value = currentPath || input.value || '';
  bar.classList.add('editing');
  input.style.display = '';
  input.focus();
  try { input.select(); } catch {}
}
function exitPathEdit(commit) {
  const bar = document.getElementById('path-bar');
  const input = document.getElementById('path-input');
  if (!bar || !input || !bar.classList.contains('editing')) return;
  const val = input.value;
  bar.classList.remove('editing');
  input.style.display = 'none';
  input.value = currentPath || '';
  if (commit) navigateTo(val);
  else document.getElementById('path-edit-btn')?.focus();
}
document.getElementById('path-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); exitPathEdit(true); }
  else if (e.key === 'Escape') { e.preventDefault(); exitPathEdit(false); }
});
// Blur commits a *changed* path instead of silently throwing it away. Tapping
// elsewhere (which dismisses the mobile keyboard) used to look like the field was
// broken — the typed path vanished with no feedback.
document.getElementById('path-input').addEventListener('blur', () => {
  const bar = document.getElementById('path-bar');
  const input = document.getElementById('path-input');
  if (!bar || !input || !bar.classList.contains('editing')) return;
  const typed = (input.value || '').trim();
  if (typed && typed !== currentPath) exitPathEdit(true);
  else exitPathEdit(false);
});

// ═══════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════
let fsClipboard = null;

// Terminal context menu actions (registered once)
function hideTermCtxMenu(restoreFocus = true) {
  const menu = document.getElementById('term-ctx-menu');
  // Only pull focus back when it was inside the menu (keyboard nav or a menu
  // click). Otherwise leave focus alone so dismissing via a click into the
  // file explorer / editor doesn't get stolen back to the terminal.
  const hadFocus = !!(menu && menu.contains(document.activeElement));
  if (menu) menu.style.display = 'none';
  document.querySelectorAll('#term-ctx-menu .ctx-submenu-wrap.open').forEach(el => el.classList.remove('open'));
  if (restoreFocus && hadFocus) {
    try { getActiveTab()?.term?.focus(); } catch {}
  }
}
document.getElementById('term-ctx-copy').addEventListener('click', () => {
  const t = getActiveTab();
  if (t?.term) {
    const sel = t.term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).then(() => {
        toast('Copied to clipboard', 'success');
      }).catch(() => {
        document.execCommand('copy');
        toast('Copied to clipboard', 'success');
      });
    }
  }
  hideTermCtxMenu();
});
document.getElementById('term-ctx-paste').addEventListener('click', () => {
  pasteToTerminal();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-select-all').addEventListener('click', () => {
  const t = getActiveTab();
  if (t?.term) t.term.selectAll();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-select-line').addEventListener('click', () => {
  selectTermLine();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-find').addEventListener('click', () => {
  toggleSearch();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-zoom-in').addEventListener('click', () => {
  applyFontSize((settings.fontSize || 14) + 1);
  hideTermCtxMenu();
});
document.getElementById('term-ctx-zoom-out').addEventListener('click', () => {
  applyFontSize((settings.fontSize || 14) - 1);
  hideTermCtxMenu();
});
document.getElementById('term-ctx-new-tab').addEventListener('click', () => {
  const t = getActiveTab();
  newTab(null, null, t?.cwd || currentPath);
  hideTermCtxMenu();
});
document.getElementById('term-ctx-copy-cwd').addEventListener('click', () => {
  const t = getActiveTab();
  const cwd = t?.cwd || currentPath;
  if (cwd) {
    navigator.clipboard.writeText(cwd).then(() => {
      toast('Path copied', 'success');
    }).catch(() => {
      document.execCommand('copy');
      toast('Path copied', 'success');
    });
  }
  hideTermCtxMenu();
});
document.getElementById('term-ctx-bookmark').addEventListener('click', () => {
  const t = getActiveTab();
  const cwd = t?.cwd || currentPath;
  if (cwd) {
    const bm = getBookmarks();
    if (bm.some(b => b.path === cwd)) { toast('Already bookmarked', 'info'); }
    else {
      const sep = cwd.includes('\\') ? '\\' : '/';
      bm.push({ name: cwd.split(sep).filter(Boolean).pop() || cwd, path: cwd });
      saveBookmarks(bm);
      toast('Bookmarked', 'success');
    }
  }
  hideTermCtxMenu();
});
document.getElementById('term-ctx-interrupt').addEventListener('click', () => {
  sendKey('\x03');
  hideTermCtxMenu();
});
document.getElementById('term-ctx-rename').addEventListener('click', () => {
  const t = getActiveTab();
  if (t?.el) {
    const span = t.el.querySelector('.tab-title');
    if (span) span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }
  hideTermCtxMenu();
});
document.getElementById('term-ctx-scroll-top').addEventListener('click', () => {
  const t = getActiveTab();
  if (t?.term) t.term.scrollToTop();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-scroll-bottom').addEventListener('click', () => {
  const t = getActiveTab();
  if (t?.term) t.term.scrollToBottom();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-clear').addEventListener('click', () => {
  const t = getActiveTab();
  if (t?.term) t.term.clear();
  hideTermCtxMenu();
});
// Submenu toggle on click
document.querySelector('#term-ctx-menu .ctx-submenu-wrap > .ctx-item').addEventListener('click', e => {
  e.stopPropagation();
  const wrap = e.currentTarget.closest('.ctx-submenu-wrap');
  wrap.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', wrap.classList.contains('open'));
});

// ═══════════════════════════════════════════════════════
// CONTEXT MENU KEYBOARD NAVIGATION
// ═══════════════════════════════════════════════════════
function setupCtxMenuKeyboard() {
  ['ctx-menu', 'term-ctx-menu'].forEach(id => {
    const menu = document.getElementById(id);
    if (!menu) return;
    menu.querySelectorAll('.ctx-item').forEach(el => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    });
    const openSubmenu = wrap => {
      wrap.classList.add('open');
      const toggle = wrap.querySelector(':scope > .ctx-item');
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
      const first = wrap.querySelector('.ctx-submenu-items .ctx-item');
      if (first) first.focus();
    };
    const closeSubmenu = wrap => {
      wrap.classList.remove('open');
      const toggle = wrap.querySelector(':scope > .ctx-item');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      if (toggle) toggle.focus();
    };
    const visibleItems = () => [...menu.querySelectorAll('.ctx-item')].filter(el => {
      const subWrap = el.closest('.ctx-submenu-items');
      if (subWrap && !subWrap.parentElement.classList.contains('open')) return false;
      return el.offsetParent !== null;
    });
    menu.addEventListener('keydown', e => {
      const items = visibleItems();
      if (!items.length) return;
      let idx = items.indexOf(document.activeElement);
      const activeItem = document.activeElement;
      switch (e.key) {
        case 'Escape': {
          const wrap = activeItem && activeItem.closest('.ctx-submenu-wrap');
          if (wrap && wrap.classList.contains('open')) { closeSubmenu(wrap); e.preventDefault(); return; }
          if (id === 'ctx-menu') document.getElementById('ctx-menu').classList.remove('open');
          else hideTermCtxMenu();
          e.preventDefault();
          return;
        }
        case 'ArrowDown': idx = (idx + 1) % items.length; break;
        case 'ArrowUp': idx = (idx - 1 + items.length) % items.length; break;
        case 'Home': idx = 0; break;
        case 'End': idx = items.length - 1; break;
        case 'ArrowRight': {
          const wrap = activeItem && activeItem.closest('.ctx-submenu-wrap');
          if (wrap && !wrap.classList.contains('open')) { e.preventDefault(); openSubmenu(wrap); }
          return;
        }
        case 'ArrowLeft': {
          const itemsWrap = activeItem && activeItem.closest('.ctx-submenu-items');
          if (itemsWrap && itemsWrap.parentElement) { e.preventDefault(); closeSubmenu(itemsWrap.parentElement); }
          return;
        }
        case 'Enter':
        case ' ':
          if (activeItem && activeItem.classList.contains('ctx-item')) { e.preventDefault(); activeItem.click(); }
          return;
        default: return;
      }
      e.preventDefault();
      if (idx >= 0 && items[idx]) items[idx].focus();
    });
  });
}

function showCtxMenu(e, file) {
  e.preventDefault();
  ctxTarget = file;
  const menu = document.getElementById('ctx-menu');
  menu.style.display = 'block';
  document.getElementById('ctx-open').style.display = file.isDir || isImageFile(file.path) || isDocFile(file.path) ? '' : 'none';
  document.getElementById('ctx-edit').style.display = file.isDir ? 'none' : (!canOpenInEditor(file.path) ? 'none' : '');
  // "Open in Tab" is offered for every file (the tab subsystem picks the viewer),
  // but not for directories — those have no panel view to dock.
  document.getElementById('ctx-open-tab').style.display = file.isDir ? 'none' : '';
  document.getElementById('ctx-open-term').style.display = file.isDir ? '' : 'none';
  document.getElementById('ctx-paste').style.display = fsClipboard ? '' : 'none';
  document.getElementById('ctx-zip').style.display = '';
  document.getElementById('ctx-folder-size').style.display = file.isDir ? '' : 'none';
  document.getElementById('ctx-extract').style.display = file.isDir ? 'none' : (file.ext === '.zip' ? '' : 'none');
  // Measure after content is set
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = e.clientX, top = e.clientY;
  // Flip horizontally if overflowing right
  if (left + mw > vw) left = Math.max(0, e.clientX - mw);
  // Flip vertically if overflowing bottom
  if (top + mh > vh) top = Math.max(0, e.clientY - mh);
  // Clamp to viewport
  left = Math.max(0, Math.min(left, vw - mw));
  top = Math.max(0, Math.min(top, vh - mh));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.classList.add('open');
  menu.style.display = '';
  const firstItem = menu.querySelector('.ctx-item');
  if (firstItem) firstItem.focus();
}

document.addEventListener('click', () => {
  document.getElementById('ctx-menu').classList.remove('open');
  hideTermCtxMenu();
});

document.getElementById('ctx-open').onclick = () => {
  if (!ctxTarget) return;
  if (ctxTarget.isDir) loadFiles(ctxTarget.path);
  else if (isImageFile(ctxTarget.path) || isDocFile(ctxTarget.path)) openFileEditor(ctxTarget.path);
  else loadFiles(ctxTarget.path);
};
document.getElementById('ctx-edit').onclick = () => ctxTarget && openFileEditor(ctxTarget.path);
// Opens the file as its own tab. Unlike Edit, this can hold several files open at
// once (tab bar + tiles view) while keeping the panel free for something else — and
// if the panel is already showing this very file, the buffer moves rather than being
// re-read, so the two surfaces can't drift apart.
document.getElementById('ctx-open-tab').onclick = () => {
  if (!ctxTarget || ctxTarget.isDir) return;
  const p = ctxTarget.path;
  if (!canOpenInEditor(p) && !isImageFile(p) && !isDocFile(p)) { toast('Preview not supported for this file type — use Download', 'warning'); return; }
  openFileAsTab(p);
};
document.getElementById('ctx-download').onclick = () => {
  if (selectedFiles.length > 0) { downloadSelected(); return; }
  if (ctxTarget) downloadFile(ctxTarget.path);
};
document.getElementById('ctx-zip').onclick = async () => {
  const files = selectedFiles.length > 0 ? selectedFiles : (ctxTarget ? [ctxTarget.path] : []);
  if (!files.length) return;
  const t = toast('Zipping…', 'info');
  for (const p of files) {
    const name = p.split(/[\\/]/).pop();
    await zipFile(p, name);
  }
  t.remove();
  clearSelection();
};
document.getElementById('ctx-extract').onclick = async () => {
  if (!ctxTarget) return;
  const t = toast('Extracting…', 'info');
  await extractZip(ctxTarget.path, ctxTarget.name);
  t.remove();
};
document.getElementById('ctx-folder-size').onclick = async () => {
  if (!ctxTarget) return;
  const toastEl = toast('Calculating folder size…', 'info');
  try {
    const res = await fetch(`/api/files/size?path=${encodeURIComponent(ctxTarget.path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toastEl.remove();
    const size = formatSize(data.size);
    toast(ctxTarget.name + ': ' + size, 'success', 5000);
  } catch (e) {
    toastEl.remove();
    toast('Size calc failed: ' + e.message, 'error');
  }
};
document.getElementById('ctx-rename').onclick = () => ctxTarget && startRename(ctxTarget.path, ctxTarget.name);
document.getElementById('ctx-copy-path').onclick = () => { if (!ctxTarget) return; navigator.clipboard.writeText(ctxTarget.path).then(() => toast('Path copied')).catch(() => toast('Copy failed', 'error')); };
document.getElementById('ctx-delete').onclick = () => {
  if (selectedFiles.length > 0) { deleteSelected(); return; }
  if (ctxTarget) deleteFile(ctxTarget);
};
document.getElementById('ctx-open-term').onclick = () => { if (!ctxTarget) return; newTab(`Term @ ${ctxTarget.name}`, null, ctxTarget.path); };
document.getElementById('ctx-copy').onclick = () => {
  const files = selectedFiles.length > 0
    ? selectedFiles.map(p => ({ path: p, name: p.split(/[\\/]/).pop() }))
    : (ctxTarget ? [{ path: ctxTarget.path, name: ctxTarget.name }] : []);
  if (!files.length) return;
  fsClipboard = { action: 'copy', files };
  updatePasteUI();
  toast(`Copied ${files.length} item(s)`, 'success');
};
document.getElementById('ctx-cut').onclick = () => {
  const files = selectedFiles.length > 0
    ? selectedFiles.map(p => ({ path: p, name: p.split(/[\\/]/).pop() }))
    : (ctxTarget ? [{ path: ctxTarget.path, name: ctxTarget.name }] : []);
  if (!files.length) return;
  fsClipboard = { action: 'cut', files };
  updatePasteUI();
  toast(`Cut ${files.length} item(s)`, 'success');
};
document.getElementById('ctx-paste').onclick = () => { if (fsClipboard) pasteFile(currentPath); };

function updatePasteUI() {
  const el = document.getElementById('footer-paste-btn');
  if (el) el.style.display = fsClipboard ? '' : 'none';
}

let _conflictResolve = null;

let _pasteBusy = false;

async function pasteFile(destDir, conflictMode, resumeFrom) {
  if (!fsClipboard) return;
  const isResume = typeof resumeFrom === 'number';
  if (_pasteBusy && !isResume) return;
  _pasteBusy = true;
  try {
    // Support both old single-file and new multi-file format
    const allFiles = fsClipboard.files || [{ path: fsClipboard.path, name: fsClipboard.name }];
    // Resume from the conflicted file instead of restarting at file 1
    const startIdx = isResume ? resumeFrom : 0;
    const files = allFiles.slice(startIdx);
    const isCopy = fsClipboard.action === 'copy';
    const ep = isCopy ? '/api/files/copy' : '/api/files/move';
    const kind = isCopy ? 'copy' : 'move';
    // Reattach to the paused job after a conflict choice (Phase 2).
    let job = (isResume && _resumeJobId && Transfers.jobs.get(_resumeJobId)) || null;
    _resumeJobId = null;
    if (job && job.status === 'waiting') { job.status = 'active'; job.sub = ''; }
    if (!job) {
      job = txCreate(kind, (isCopy ? 'Copy ' : 'Move ') + (allFiles.length === 1 ? allFiles[0].name : allFiles.length + ' items'), { filesTotal: allFiles.length });
      job.sub = 'Calculating size…';
      // Best-effort byte preflight via quick metadata calls; never blocks the op.
      try {
        let bytes = 0, ok = true;
        for (const f of allFiles) {
          const st = await api(`/api/files/stat?path=${encodeURIComponent(f.path)}`);
          if (st && typeof st.size === 'number' && !st.isDirectory && !st.error) { f._size = st.size; bytes += st.size; }
          else if (st && st.isDirectory && !st.error) {
            const z = await api(`/api/files/size?path=${encodeURIComponent(f.path)}`);
            if (z && typeof z.size === 'number' && !z.error) { f._size = z.size; bytes += z.size; } else ok = false;
          } else ok = false;
        }
        if (ok && bytes > 0) job.total = bytes;
        else job.sub = '';
      } catch { job.sub = ''; }
      txRender(true);
    }
    let succeeded = (isResume && job._ok) || 0;
    let failed = (isResume && job._failed) || 0;
    let bytesDone = (isResume && job._bytesDone) || 0;
    for (let fi = 0; fi < files.length; fi++) {
      if (job.stopAfterCurrent) break;
      const file = files[fi];
      job.sub = file.name;
      txTick(job, bytesDone);
      const dest = joinPath(destDir, file.name);
      const body = { source: file.path, destination: dest };
      // Apply the chosen mode to the conflicted file only (first of a
      // resumed run); later conflicts re-prompt instead of inheriting it.
      if (conflictMode && (fi === 0 || !isResume)) body.conflict = conflictMode;
      // Raw fetch with no client timeout: server-side copies of large trees
      // outlive api()'s 30s cap (G2). Aborting only stops the wait, never the fs.
      let r;
      try {
        const ctrl = new AbortController();
        job.abort = () => { try { ctrl.abort(); } catch {} };
        const resp = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-pin-token': authToken },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
        job.abort = null;
        if (resp.status === 401) { try { showPinScreen(); } catch {} throw new Error('Session expired — sign in again'); }
        try { r = await resp.json(); } catch { r = { error: 'Request failed (' + resp.status + ')' }; }
      } catch (e) {
        job.abort = null;
        if ((e && e.name === 'AbortError') || job.stopAfterCurrent) break;
        r = { error: (e && e.message) || 'Network error' };
      }
      if (job.stopAfterCurrent) break;
      if (r.conflict) {
        job._ok = succeeded; job._failed = failed; job._bytesDone = bytesDone;
        job.status = 'waiting'; // pauses the speed/ETA clock (G4)
        _conflictResolve = { destDir, conflictMode: null, resumeFrom: startIdx + fi, action: fsClipboard.action, jobId: job.id };
        document.getElementById('conflict-name').textContent = r.name;
        document.getElementById('conflict-dir-hint').style.display = r.isDir ? '' : 'none';
        document.getElementById('conflict-merge').style.display = r.isDir ? '' : 'none';
        openOverlay('conflict-overlay');
        txRender(true);
        return;
      }
      if (r.success) { succeeded++; bytesDone += file._size || 0; }
      else failed++;
      job.filesDone = succeeded;
      job._ok = succeeded; job._failed = failed; job._bytesDone = bytesDone;
      job.sub = file.name;
      txTick(job, bytesDone);
    }
    job.abort = null;
    const opLabel = isCopy ? 'Pasted' : 'Moved';
    if (job.stopAfterCurrent) {
      txFinish(job, 'cancelled', succeeded ? succeeded + ' done' : '');
      toast('Stopped after ' + succeeded + ' item(s)', 'warning');
    } else if (failed === 0) {
      txFinish(job, 'done', opLabel + ' ' + succeeded + ' item(s)');
      toast(opLabel + ` (${succeeded} item(s))`, 'success');
    }
    else if (succeeded === 0) { txFinish(job, 'error', opLabel + ' failed'); toast(opLabel + ' failed', 'error'); }
    else { txFinish(job, 'error', `${opLabel} ${succeeded}, ${failed} failed`); toast(`${opLabel} ${succeeded}, ${failed} failed`, 'warning'); }
    if (fsClipboard.action === 'cut' && !job.stopAfterCurrent) { fsClipboard = null; updatePasteUI(); }
    refreshFiles();
  } finally {
    _pasteBusy = false;
  }
}

let _conflictBusy = false;
let _resumeJobId = null; // paused Transfer Center job to reattach after a conflict choice
function resolveConflict(mode) {
  // Guard double-fire (double-click/Enter+click) and stale state
  if (_conflictBusy || !fsClipboard || !_conflictResolve) return;
  const { destDir, resumeFrom, action, jobId } = _conflictResolve;
  // Clipboard changed since the conflict (e.g. new copy) — don't resume stale queue
  if (!destDir || fsClipboard.action !== action) { _conflictResolve = null; return; }
  _conflictBusy = true;
  closeOverlay('conflict-overlay');
  _resumeJobId = jobId || null;
  _conflictResolve = null;
  pasteFile(destDir, mode, resumeFrom).finally(() => { _conflictBusy = false; });
}

async function zipFile(path, name) {
  const r = await api('/api/files/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });
  if (r.success) { toast('Zipped: ' + r.name, 'success'); refreshFiles(); }
  else toast(r.error || 'Zip failed', 'error');
}

async function extractZip(path, name) {
  const r = await api('/api/files/unzip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });
  if (r.success) { toast('Extracted to: ' + r.dir, 'success'); refreshFiles(); }
  else toast(r.error || 'Extract failed', 'error');
}

// ═══════════════════════════════════════════════════════
// FILE OPERATIONS
// ═══════════════════════════════════════════════════════
function startRename(path, name) {
  renamePath = path;
  document.getElementById('rename-input').value = name;
  openOverlay('rename-overlay');
  setTimeout(() => document.getElementById('rename-input').select(), 100);
}

async function confirmRename() {
  const newName = document.getElementById('rename-input').value.trim();
  if (!newName) { showFieldError('rename-error', 'Enter a new name'); return; }
  clearFieldError('rename-error');
  setBtnBusy(document.getElementById('rename-ok-btn'), true);
  const r = await api('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath: renamePath, newName })
  });
  setBtnBusy(document.getElementById('rename-ok-btn'), false);
  if (r.success) { toast('Renamed', 'success'); refreshFiles(); closeOverlay('rename-overlay'); }
  else showFieldError('rename-error', r.error || 'Rename failed');
}

async function deleteFile(file) {
  const ok = await confirmDialog({ title: 'Delete', message: `Delete "${file.name}"?${file.isDir ? '\n\nThis will delete the entire directory.' : ''}`, okText: 'Delete', danger: true });
  if (!ok) return;
  const r = await api(`/api/files?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
  if (r.success) { toast('Deleted', 'success'); refreshFiles(); }
  else toast(r.error, 'error');
}

async function downloadFile(filePath) {
  const name0 = filePath.split(/[\\/]/).pop() || 'download';
  const job = txCreate('download', 'Download ' + name0, {});
  const ctrl = new AbortController();
  job.abort = () => { try { ctrl.abort(); } catch {} };
  try {
    const r = await fetch(`/api/files/download?path=${encodeURIComponent(filePath)}`, {
      headers: { 'x-pin-token': authToken }, signal: ctrl.signal
    });
    if (!r.ok) {
      let msg = 'Download failed';
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
      if (r.status === 401) { try { showPinScreen(); } catch {} msg = 'Session expired — sign in again'; }
      txFinish(job, 'error', msg);
      toast(msg, 'error');
      return;
    }
    const ct = r.headers.get('content-type') || '';
    let len = Number(r.headers.get('content-length') || 0);
    if (!(len > 0)) {
      // Fallback for the total: the header needs the restarted server, and a
      // proxy/tunnel may strip it anyway. stat() reports the same file size,
      // so % / ETA still work. Directory zips stay indeterminate (no total).
      try {
        const st = await api(`/api/files/stat?path=${encodeURIComponent(filePath)}`);
        if (st && !st.error && !st.isDirectory && typeof st.size === 'number' && st.size > 0) len = st.size;
      } catch {}
    }
    // Single files report Content-Length (server.js); directory zips stream
    // length-less and stay indeterminate (bytes + speed only).
    if (len > 0) job.total = len;
    txRender(true);
    // Stream the body so progress + speed are real. Chunks are still assembled
    // into one Blob for the anchor download — same memory profile as before.
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    const chunks = [];
    let loaded = 0;
    if (reader) {
      for (;;) {
        if (job.stopAfterCurrent) { try { await reader.cancel(); } catch {} break; }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); loaded += value.length; txTick(job, loaded); }
      }
    } else {
      const blob = await r.blob();
      loaded = blob.size;
      txTick(job, loaded);
      chunks.push(new Uint8Array(await blob.arrayBuffer()));
    }
    job.abort = null;
    if (job.stopAfterCurrent) {
      txFinish(job, 'cancelled', loaded ? formatSize(loaded) + ' received' : '');
      toast('Download stopped', 'warning');
      return;
    }
    const blob = new Blob(chunks, { type: ct || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    let name = name0;
    // Server returns application/zip for directories — append .zip if missing
    if (ct.includes('zip') && !name.endsWith('.zip')) name += '.zip';
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 10000);
    txFinish(job, 'done', formatSize(blob.size));
  } catch(e) {
    if (e && e.name === 'AbortError') {
      txFinish(job, 'cancelled');
      toast('Download stopped', 'warning');
    } else {
      console.warn('Download failed:', e);
      txFinish(job, 'error', 'Download failed');
      toast('Download failed', 'error');
    }
  }
}

function joinPath(parent, child) {
  const sep = parent.includes('\\') ? '\\' : '/';
  return parent.replace(/[\\/]$/, '') + sep + child;
}

// ═══════════════════════════════════════════════════════
// SELECT MODE
// ═══════════════════════════════════════════════════════
let selectMode = false;
let selectedFiles = [];

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedFiles = [];
  document.getElementById('select-actions').style.display = selectMode ? 'flex' : 'none';
  document.getElementById('sidebar').dataset.selectMode = selectMode ? 'true' : '';
  const flw = document.getElementById('file-list-wrap');
  if (flw) flw.setAttribute('aria-multiselectable', String(selectMode));
  document.getElementById('select-count').textContent = '0 selected';
  document.querySelector('[onclick="toggleSelectMode()"]')?.classList.toggle('active', selectMode);
  refreshFiles();
}

function toggleFileSelection(path, el) {
  // The ".." parent entry is navigational, never selectable
  if (!path || path === currentParent || (el && el.classList && el.classList.contains('is-parent'))) return;
  const idx = selectedFiles.indexOf(path);
  if (idx > -1) {
    selectedFiles.splice(idx, 1);
    el.classList.remove('selected');
    el.setAttribute('aria-selected', 'false');
    el.querySelector('.file-select-check').classList.remove('on');
  } else {
    selectedFiles.push(path);
    el.classList.add('selected');
    el.setAttribute('aria-selected', 'true');
    el.querySelector('.file-select-check').classList.add('on');
  }
  const count = selectedFiles.length;
  document.getElementById('select-count').textContent = count + ' selected';
  document.getElementById('select-actions').style.display = count > 0 ? 'flex' : 'none';
  const totalItems = [...document.querySelectorAll('.file-item')].filter(el => el.dataset.path !== currentParent).length;
  document.getElementById('select-all-btn').textContent = count === totalItems ? 'Deselect All' : 'Select All';
}

function selectAllFiles() {
  const items = document.querySelectorAll('.file-item');
  const totalCount = [...items].filter(el => el.dataset.path !== currentParent).length;
  if (selectedFiles.length >= totalCount) {
    clearSelection();
    return;
  }
  selectedFiles = [];
  items.forEach(el => {
    const path = el.dataset.path;
    if (!path || path === currentParent) return;
    selectedFiles.push(path);
    el.classList.add('selected');
    el.setAttribute('aria-selected', 'true');
    const check = el.querySelector('.file-select-check');
    if (check) check.classList.add('on');
  });
  const count = selectedFiles.length;
  document.getElementById('select-count').textContent = count + ' selected';
  document.getElementById('select-actions').style.display = count > 0 ? 'flex' : 'none';
  document.getElementById('select-all-btn').textContent = 'Deselect All';
}

function clearSelection() {
  selectedFiles = [];
  document.querySelectorAll('.file-item.selected').forEach(el => {
    el.classList.remove('selected');
    const check = el.querySelector('.file-select-check');
    if (check) check.classList.remove('on');
  });
  document.getElementById('select-count').textContent = '0 selected';
  document.getElementById('select-actions').style.display = 'none';
  document.getElementById('select-all-btn').textContent = 'Select All';
}

async function deleteSelected() {
  if (!selectedFiles.length) return;
  const msg = `Delete ${selectedFiles.length} item${selectedFiles.length > 1 ? 's' : ''}?`;
  const ok = await confirmDialog({ title: 'Delete', message: msg, okText: 'Delete', danger: true });
  if (!ok) return;
  const results = await Promise.allSettled(
    [...selectedFiles].map(p =>
      api(`/api/files?path=${encodeURIComponent(p)}`, { method: 'DELETE' })
    )
  );
  let failed = 0;
  results.forEach((res, i) => {
    if (res.status === 'rejected' || !res.value.success) {
      failed++;
      const name = selectedFiles[i].split(/[\\/]/).pop();
      const err = res.status === 'rejected' ? res.reason : res.value.error;
      toast(`Failed to delete ${name}: ${err}`, 'error');
    }
  });
  if (failed === 0) toast('Deleted', 'success');
  else if (failed < selectedFiles.length) toast(`Deleted ${selectedFiles.length - failed} item(s), ${failed} failed`, 'warning');
  clearSelection();
  refreshFiles();
}

async function downloadSelected() {
  const files = [...selectedFiles];
  if (!files.length) return;
  toast(`Downloading ${files.length} item(s)…`, 'info');
  for (let i = 0; i < files.length; i++) {
    await downloadFile(files[i]);
    // Small delay between downloads to avoid browser popup blocking
    if (i < files.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  clearSelection();
}

function newFolder() {
  document.getElementById('newfolder-input').value = '';
  openOverlay('newfolder-overlay');
  setTimeout(() => document.getElementById('newfolder-input').focus(), 100);
}

async function confirmNewFolder() {
  const name = document.getElementById('newfolder-input').value.trim();
  if (!name) { showFieldError('newfolder-error', 'Enter a folder name'); return; }
  clearFieldError('newfolder-error');
  setBtnBusy(document.getElementById('newfolder-ok-btn'), true);
  const r = await api('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: joinPath(currentPath, name) })
  });
  setBtnBusy(document.getElementById('newfolder-ok-btn'), false);
  if (r.success) { toast('Folder created', 'success'); refreshFiles(); closeOverlay('newfolder-overlay'); }
  else showFieldError('newfolder-error', r.error || 'Could not create folder');
}

function newFile() {
  document.getElementById('newfile-input').value = '';
  openOverlay('newfile-overlay');
  setTimeout(() => document.getElementById('newfile-input').focus(), 100);
}

async function confirmNewFile() {
  const name = document.getElementById('newfile-input').value.trim();
  if (!name) { showFieldError('newfile-error', 'Enter a file name'); return; }
  clearFieldError('newfile-error');
  setBtnBusy(document.getElementById('newfile-ok-btn'), true);
  const filePath = joinPath(currentPath, name);
  const r = await api('/api/files/touch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath })
  });
  setBtnBusy(document.getElementById('newfile-ok-btn'), false);
  if (r.success) { refreshFiles(); closeOverlay('newfile-overlay'); openFileEditor(filePath); }
  else showFieldError('newfile-error', r.error || 'Could not create file');
}

// Upload
function uploadFiles() { document.getElementById('upload-input').click(); }

async function handleUploadInput() {
  const input = document.getElementById('upload-input');
  const files = [...input.files];
  if (!files.length) return;
  input.value = '';
  try { await uploadFileList(files); } catch(e) { console.warn('Upload failed:', e); toast('Upload failed', 'error'); }
}

// ═══════════════════════════════════════════════════════
// TRANSFER CENTER (Phase 1: upload/download, Phase 2: copy/move)
// Single owner of all transfer progress. Jobs are in-memory only.
// Honesty tiers: upload/download = real bytes+speed; copy/move =
// bytes-if-size-known else n/m files; zip/unzip + delete stay toasts.
// ═══════════════════════════════════════════════════════
const Transfers = {
  jobs: new Map(), seq: 0, pinned: false, _hoverT: null, _renderT: 0,
};
function txNow() { return Date.now(); }
function txFmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  return formatSize(bps) + '/s';
}
function txFmtETA(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 2) return 'a moment left';
  if (sec < 60) return Math.round(sec) + 's left';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + 'm ' + (s < 10 ? '0' : '') + s + 's left';
}
function txFmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}
function txCreate(type, label, opts = {}) {
  const id = 'tx' + (++Transfers.seq) + '-' + txNow().toString(36);
  const job = {
    id, type, label, sub: opts.sub || '',
    total: opts.total || 0, loaded: 0,
    filesTotal: opts.filesTotal || 0, filesDone: 0,
    status: 'active', speed: 0, _lastT: txNow(), _lastLoaded: 0,
    startedAt: txNow(), stalledSince: 0, error: '',
    abort: null, stopAfterCurrent: false,
  };
  Transfers.jobs.set(id, job);
  // Cap memory: keep at most 10 finished jobs.
  const done = [...Transfers.jobs.values()].filter(j => j.status !== 'active' && j.status !== 'waiting');
  if (done.length > 10) {
    done.sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 0; i < done.length - 10; i++) Transfers.jobs.delete(done[i].id);
  }
  txRender(true);
  return job;
}
function txTick(job, loaded) {
  const now = txNow();
  job.loaded = loaded;
  const dt = (now - job._lastT) / 1000;
  if (dt >= 0.4) {
    const inst = (loaded - job._lastLoaded) / dt;
    if (inst >= 0) job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
    job._lastT = now; job._lastLoaded = loaded;
    if (inst > 512) job.stalledSince = 0;
    else if (!job.stalledSince) job.stalledSince = now;
  }
  txRender();
}
function txFinish(job, status, msg) {
  job.status = status;
  if (status === 'done') { if (job.total) job.loaded = job.total; if (job.filesTotal) job.filesDone = job.filesTotal; }
  if (msg) job.error = msg;
  job.abort = null;
  txRender(true);
}
function txActiveJobs() {
  return [...Transfers.jobs.values()].filter(j => j.status === 'active' || j.status === 'waiting');
}
function txJobLine(job) {
  if (job.status === 'waiting') return 'Waiting for conflict choice…';
  if (job.status === 'done') return job.error || 'Done';
  if (job.status === 'cancelled') return 'Stopped' + (job.error ? ' — ' + job.error : '');
  if (job.status === 'error') return job.error || 'Failed';
  const parts = [];
  if (job.total > 0 && job.loaded > 0) {
    parts.push(formatSize(job.loaded) + ' of ' + formatSize(job.total));
    const sp = txFmtSpeed(job.speed);
    if (sp && job.loaded < job.total) {
      if (job.stalledSince && txNow() - job.stalledSince > 3000) parts.push('Stalled…');
      else { parts.push(sp); parts.push(txFmtETA((job.total - job.loaded) / job.speed)); }
    }
  } else if (job.filesTotal > 1) {
    parts.push(job.filesDone + ' of ' + job.filesTotal + ' files');
    const sp = txFmtSpeed(job.speed);
    if (sp) parts.push(sp);
  } else {
    // Single server-side file (copy/move): one atomic POST carries no
    // intra-file signal, so a 0% bar would sit dead until the jump to done.
    // Show honest activity + size context + elapsed instead of a fake 0%.
    const verb = job.type === 'download' ? 'Downloading' : job.type === 'upload' ? 'Uploading' : job.type === 'copy' ? 'Copying' : job.type === 'move' ? 'Moving' : 'Working';
    parts.push(verb + '…');
    if (job.total > 0) parts.push(formatSize(job.total));
    parts.push(txFmtDur(txNow() - job.startedAt) + ' elapsed');
  }
  if (job.sub) parts.push(job.sub);
  return parts.filter(Boolean).join(' · ');
}
function txRender(force) {
  const now = txNow();
  if (!force && now - Transfers._renderT < 250) return;
  Transfers._renderT = now;
  try { document.body.classList.toggle('datasaver', !!(typeof settings !== 'undefined' && settings.datasaver)); } catch {}
  const btn = document.getElementById('transfers-btn');
  const count = document.getElementById('transfers-count');
  const live = document.querySelector('#transfers-livebar > div');
  const liveWrap = document.getElementById('transfers-livebar');
  const list = document.getElementById('transfers-list');
  const sub = document.getElementById('transfers-sub');
  if (!btn || !list) return;
  const active = txActiveJobs();
  btn.classList.toggle('has-active', active.length > 0);
  // The icon only exists when there is something to show: running jobs or
  // undismissed finished ones. Clearing the last job hides it again.
  btn.style.display = Transfers.jobs.size ? '' : 'none';
  if (!Transfers.jobs.size) {
    Transfers.pinned = false;
    try { document.getElementById('transfers-panel').classList.remove('open'); } catch {}
  }
  btn.setAttribute('aria-expanded', document.getElementById('transfers-panel').classList.contains('open') ? 'true' : 'false');
  if (count) { count.textContent = String(active.length); }
  if (sub) sub.textContent = active.length ? active.length + ' active' : '';
  // Aggregate live bar over active jobs with known totals.
  let tl = 0, tt = 0;
  for (const j of active) { if (j.total > 0) { tl += Math.min(j.loaded, j.total); tt += j.total; } }
  if (live && liveWrap) {
    if (tt > 0) { liveWrap.classList.add('on'); live.style.width = Math.min(100, (tl / tt) * 100) + '%'; }
    else liveWrap.classList.toggle('on', active.length > 0 && active.some(j => j.status === 'active'));
  }
  const jobs = [...Transfers.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  if (!jobs.length) { list.innerHTML = '<div class="tx-empty">No transfers yet.<br>Uploads, downloads and copy/move show here with speed.</div>'; return; }
  const ico = (t) => t === 'download'
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
    : t === 'upload'
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  list.innerHTML = jobs.map(j => {
    // Determinate only with real movement: multi-file n/m, or bytes actually
    // flowing. A single in-flight server file shows the shimmer instead of a
    // dead 0% (there is no intra-file signal to report).
    const measurable = (j.total > 0 && j.loaded > 0) || (j.filesTotal > 1 && j.filesDone > 0);
    const pct = (j.total > 0 && j.loaded > 0) ? Math.min(100, Math.round((j.loaded / j.total) * 100)) : (j.filesTotal > 1 ? Math.round((j.filesDone / j.filesTotal) * 100) : 0);
    const showPct = (j.total > 0 && j.loaded > 0) || j.filesTotal > 1;
    const st = j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : j.status === 'waiting' ? 'waiting' : 'active';
    const canCancel = j.status === 'active';
    const btn2 = canCancel ? `<button class="tx-act danger" onclick="cancelTransfer('${j.id}')">Stop</button>`
      : (j.status !== 'active' && j.status !== 'waiting') ? `<button class="tx-act" onclick="dismissTransfer('${j.id}')">Dismiss</button>` : '';
    return `<div class="tx-job" data-status="${st}"><div class="tx-row1"><span class="tx-ico ${j.type === 'download' ? 'dl' : j.type === 'copy' || j.type === 'move' ? 'mv' : ''}">${ico(j.type)}</span><span class="tx-name" title="${escHtml(j.label)}">${escHtml(j.label)}</span><span class="tx-pct">${showPct ? pct + '%' : ''}</span></div>`
      + `<div class="tx-bar" role="progressbar" aria-label="${escHtml(j.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="tx-fill ${(j.status === 'active' && !measurable && j.filesTotal <= 1) ? 'indet' : ''}" style="${showPct ? 'width:' + pct + '%' : ''}"></div></div>`
      + `<div class="tx-row2"><span class="tx-meta" aria-live="off">${escHtml(txJobLine(j))}</span>${btn2}</div></div>`;
  }).join('');
}
function toggleTransfersPanel(e, forceClose) {
  if (e) { try { e.stopPropagation(); } catch {} }
  const p = document.getElementById('transfers-panel');
  if (!p) return;
  const willOpen = forceClose ? false : !p.classList.contains('open');
  if (willOpen && e && e.type === 'click') Transfers.pinned = true;
  if (!willOpen) Transfers.pinned = false;
  p.classList.toggle('open', willOpen);
  txRender(true);
}
function dismissTransfer(id) { Transfers.jobs.delete(id); txRender(true); }
function clearFinishedTransfers() {
  for (const [id, j] of Transfers.jobs) { if (j.status !== 'active' && j.status !== 'waiting') Transfers.jobs.delete(id); }
  txRender(true);
}
function cancelTransfer(id) {
  const job = Transfers.jobs.get(id);
  if (!job || (job.status !== 'active')) return;
  // Honest cancel: network ops abort now and their handlers finish the job;
  // copy/move loops stop after the current file (the in-flight request cannot
  // be un-done server-side, so "Stop" never claims server work halted).
  job.stopAfterCurrent = true;
  if (job.type === 'copy' || job.type === 'move') job.sub = 'Stopping after current file…';
  try { if (job.abort) job.abort(); } catch {}
  txRender(true);
}
(function initTransfersPanel() {
  const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  const btn = document.getElementById('transfers-btn');
  const panel = document.getElementById('transfers-panel');
  if (!btn || !panel) return;
  if (fine) {
    btn.addEventListener('mouseenter', () => {
      clearTimeout(Transfers._hoverT);
      if (!panel.classList.contains('open')) { Transfers.pinned = false; panel.classList.add('open'); txRender(true); }
    });
    btn.addEventListener('mouseleave', () => {
      clearTimeout(Transfers._hoverT);
      Transfers._hoverT = setTimeout(() => { if (!Transfers.pinned) { panel.classList.remove('open'); txRender(true); } }, 250);
    });
    panel.addEventListener('mouseenter', () => clearTimeout(Transfers._hoverT));
    panel.addEventListener('mouseleave', () => {
      clearTimeout(Transfers._hoverT);
      Transfers._hoverT = setTimeout(() => { if (!Transfers.pinned) { panel.classList.remove('open'); txRender(true); } }, 250);
    });
  }
  document.addEventListener('click', (e) => {
    if (!Transfers.pinned) return;
    if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
      Transfers.pinned = false; panel.classList.remove('open'); txRender(true);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open') && !document.querySelector('.overlay.open')) {
      Transfers.pinned = false; panel.classList.remove('open'); txRender(true);
    }
  });
})();

let _uploadProgressTimeout = null;
let _currentUploadXhr = null;
let _uploadCancelled = false;
// Legacy shims: the old header bar is retired (hidden); progress lives in the
// Transfer Center. Kept so any missed caller degrades to a toast, not a crash.
function setUploadProgress(pct, status, text) {
  if (text) { try { toast(text, status === 'error' ? 'error' : status === 'success' ? 'success' : 'info'); } catch {} }
}
function clearUploadProgress(delay = 1500) { clearTimeout(_uploadProgressTimeout); }
function cancelUpload() {
  _uploadCancelled = true;
  for (const j of Transfers.jobs.values()) {
    if (j.type === 'upload' && j.status === 'active') { cancelTransfer(j.id); break; }
  }
  try { if (_currentUploadXhr) _currentUploadXhr.abort(); } catch {}
  _currentUploadXhr = null;
  toast('Upload cancelled', 'warning');
}

async function uploadFileList(items) {
  const path = encodeURIComponent(currentPath);
  const files = items.map(item => ({ file: item.file || item, name: item.path || item.webkitRelativePath || item.name }));
  const total = files.length;
  if (!total) return;
  const totalBytes = files.reduce((n, f) => n + ((f.file && f.file.size) || 0), 0);
  const job = txCreate('upload', total === 1 ? 'Upload ' + files[0].name : 'Upload ' + total + ' files', { total: totalBytes, filesTotal: total });
  let completed = 0;
  let failedItems = [];
  let baseLoaded = 0;
  _uploadCancelled = false;
  job.abort = () => { _uploadCancelled = true; try { if (_currentUploadXhr) _currentUploadXhr.abort(); } catch {} };
  
  for (const item of files) {
    if (_uploadCancelled || job.stopAfterCurrent) break;
    const file = item.file;
    const fileName = item.name;
    const formData = new FormData();
    formData.append('files', file, fileName);
    
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        _currentUploadXhr = xhr;
        xhr.open('POST', `/api/files/upload?path=${path}`);
        xhr.setRequestHeader('x-pin-token', authToken);
        
        // Progress fires per network chunk (dozens per second). txTick() feeds
        // txRender(), which already throttles DOM writes to ~4 Hz — so paint
        // directly: the old requestAnimationFrame gate froze the % in a
        // background tab (rAF never fires when hidden), exactly when a big
        // upload runs longest.
        xhr.upload.addEventListener('progress', e => {
          if (!e.lengthComputable) return;
          job.sub = fileName;
          txTick(job, baseLoaded + e.loaded);
        });
        
        xhr.onload = () => {
          _currentUploadXhr = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const resp = JSON.parse(xhr.responseText);
              if (resp.success) {
                completed++;
                job.filesDone = completed;
                baseLoaded += (file && file.size) || 0;
                job.sub = fileName;
                txTick(job, baseLoaded);
                resolve();
              } else {
                failedItems.push(fileName);
                reject(new Error(resp.error || 'Upload failed'));
              }
            } catch(e) {
              console.warn('Upload XHR response parse error:', e);
              completed++;
              resolve();
            }
          } else {
            failedItems.push(fileName);
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        
        xhr.onerror = () => {
          _currentUploadXhr = null;
          if (_uploadCancelled) { reject(new Error('Cancelled')); return; }
          failedItems.push(fileName);
          reject(new Error('Network error'));
        };
        xhr.onabort = () => {
          _currentUploadXhr = null;
          reject(new Error('Cancelled'));
        };
        xhr.send(formData);
      });
    } catch (e) {
      if (_uploadCancelled || job.stopAfterCurrent) break;
      console.warn('Upload item failed:', e);
    }
  }
  
  _currentUploadXhr = null;
  job.abort = null;
  if (_uploadCancelled || job.stopAfterCurrent) {
    txFinish(job, 'cancelled', completed ? completed + '/' + total + ' uploaded' : '');
    toast('Upload stopped', 'warning');
    refreshFiles();
    return;
  }
  if (failedItems.length === 0) {
    txFinish(job, 'done', completed + '/' + total + ' uploaded');
    toast('Upload complete (' + completed + '/' + total + ')', 'success');
  } else if (completed > 0) {
    txFinish(job, 'error', completed + ' ok, ' + failedItems.length + ' failed');
    toast(failedItems.length + ' upload(s) failed', 'error');
  } else {
    txFinish(job, 'error', 'All ' + total + ' failed');
    toast('All ' + total + ' uploads failed', 'error');
  }
  
  refreshFiles();
}

// ═══════════════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════════════
const MAX_EDITOR_SIZE = 10 * 1024 * 1024; // 10MB
let editor = null;
let mdPreviewActive = false;
// Full HTML preview: author's bytes verbatim (scripts run) inside the same
// opaque-origin sandbox. Safe mode (default) stays sanitized. Reset per file.
let htmlFullPreview = false;
function setFullBtnVisible(v) {
  const b = document.getElementById('html-full-toggle');
  if (!b) return;
  b.style.display = v ? '' : 'none';
  if (!v) { htmlFullPreview = false; b.classList.remove('btn-primary'); b.classList.add('btn-ghost'); b.setAttribute('aria-pressed', 'false'); }
}

// Shared by the panel editor and every per-tab editor, so options can't drift apart.
const CM_BASE_OPTIONS = {
  theme: 'webtun',
  lineNumbers: true,
  matchBrackets: true,
  indentUnit: 2,
  tabSize: 2,
  indentWithTabs: false,
  lineWrapping: false,
  viewportMargin: 100,
};

function initCodeMirror() {
  if (editor) return editor;
  const ta = document.getElementById('editor-textarea');
  editor = CodeMirror.fromTextArea(ta, Object.assign({}, CM_BASE_OPTIONS, {
    extraKeys: {
      'Ctrl-S': () => saveFile(),
      'Cmd-S': () => saveFile(),
      'Esc': () => {
        if (document.querySelector('.overlay.open')) return;
        closeEditor();
      },
    }
  }));
  editor.on('change', () => { updateEditorDirty(); autoSaveDraft(); schedulePreviewLiveReload(); });
  return editor;
}
let _autoSaveTimer = null;
function autoSaveDraft() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    try {
      if (!editorPath) return;
      const content = editor ? editor.getValue() : '';
      if (content !== editorOriginalContent) {
        safeStorage.setItem('wt-draft:' + editorPath, content);
      } else {
        safeStorage.removeItem('wt-draft:' + editorPath);
      }
    } catch {}
  }, 2000);
}
function loadDraft(p) {
  try { return safeStorage.getItem('wt-draft:' + p); } catch { return null; }
}
function removeDraft(p) {
  try { safeStorage.removeItem('wt-draft:' + p); } catch {}
}

function updateEditorDirty() {
  const el = document.getElementById('editor-view');
  if (!el) return;
  const currentContent = editor ? editor.getValue() : document.getElementById('editor-textarea').value;
  el.classList.toggle('editor-dirty', currentContent !== editorOriginalContent);
}

function getCMmode(fileName) {
  const m = fileName.match(/\.([^.]+)$/);
  if (!m) return null;
  switch (m[1].toLowerCase()) {
    case 'js': return 'javascript';
    case 'jsx': return {name: 'javascript', json: false, jsx: true};
    case 'mjs': case 'cjs': return 'javascript';
    case 'ts': return {name: 'javascript', typescript: true};
    case 'tsx': return {name: 'javascript', typescript: true, jsx: true};
    case 'json': return {name: 'javascript', json: true};
    case 'py': return 'python';
    case 'html': case 'htm': return 'htmlmixed';
    case 'css': return 'css';
    case 'xml': case 'svg': return 'xml';
    case 'c': case 'h': return 'text/x-csrc';
    case 'cpp': case 'cc': case 'hpp': case 'cxx': return 'text/x-c++src';
    case 'java': return 'text/x-java';
    case 'cs': return 'text/x-csharp';
    case 'sh': case 'bash': case 'zsh': case 'fish': return 'shell';
    case 'md': case 'markdown': return 'markdown';
    case 'yaml': case 'yml': return 'yaml';
    case 'sql': return 'sql';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'pl': case 'pm': return 'perl';
    case 'swift': return 'swift';
    // No kotlin mode exists in the pinned codemirror@5.65.18 bundle, and naming
    // a mode that was never loaded only produced a CodeMirror warning plus a
    // silent plain-text fallback. Fall back deliberately instead.
    case 'kt': case 'kts': return null;
    case 'dart': return 'dart';
    case 'lua': return 'lua';
    case 'r': return 'r';
    case 'toml': return 'toml';
    case 'ini': case 'cfg': case 'conf': case 'env': return 'properties';
    case 'ps1': case 'psm1': return 'powershell';
    default: return null;
  }
}

// Language modes that are NOT in the first-paint <script> set: fetched only
// when a file of that type is actually opened (verified present on the CDN for
// the pinned version). Modes loaded eagerly at boot keep their existing tags.
const CM_BASE = 'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/';
const CM_LAZY_MODES = {
  ruby: 'mode/ruby/ruby.min.js',
  php: 'mode/php/php.min.js',
  perl: 'mode/perl/perl.min.js',
  swift: 'mode/swift/swift.min.js',
  dart: 'mode/dart/dart.min.js',
  lua: 'mode/lua/lua.min.js',
  r: 'mode/r/r.min.js',
  toml: 'mode/toml/toml.min.js',
  powershell: 'mode/powershell/powershell.min.js'
};
const _cmModeFailed = new Set();
function cmModeLoaded(name) {
  try {
    return !!((CodeMirror.modes && CodeMirror.modes[name]) || (CodeMirror.mimeModes && CodeMirror.mimeModes[name]));
  } catch { return false; }
}
// Resolves the CM mode spec for a filename, fetching the mode script if needed.
// Never throws: falls back to plain text so the editor always opens.
async function resolveCMmode(fileName) {
  const spec = getCMmode(fileName);
  if (!spec) return 'text/plain';
  const name = typeof spec === 'string' ? spec : spec.name;
  const url = CM_LAZY_MODES[name];
  if (!url) return spec;                       // already in the page / MIME-based mode
  if (cmModeLoaded(name)) return spec;
  if (_cmModeFailed.has(name)) return 'text/plain';
  try {
    await loadScript(CM_BASE + url);
  } catch (e) {
    // Offline, blocked, or the asset moved: plain text beats a broken editor.
    _cmModeFailed.add(name);
    return 'text/plain';
  }
  if (cmModeLoaded(name)) return spec;
  _cmModeFailed.add(name);
  return 'text/plain';
}

// Read a text file for an editor surface: binary and size guards, plus the
// crash-safety draft prompt. Shared by the panel (`openFileEditor`) and the per-tab
// editors, so both offer exactly the same safeguards. Returns null when the file
// cannot be shown or the user backs out.
async function readTextForEditor(path) {
  const r = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
  if (r.error) {
    if (r.isBinary) { toast(r.error || 'Preview not supported for binary files — use Download', 'warning'); return null; }
    toast(r.error, 'error'); return null;
  }
  if (r.length > MAX_EDITOR_SIZE) {
    const ok = await confirmDialog({ title: 'Large file', message: `File is ${(r.length / 1024 / 1024).toFixed(1)}MB. Open anyway?`, okText: 'Open', danger: true });
    if (!ok) return null;
  }
  // Restore an autosaved draft from a previous session (crash safety). Only when it
  // actually differs from what is on disk, and only after the user opts in.
  let content = r.content;
  const draft = loadDraft(path);
  if (draft !== null && draft !== r.content) {
    const restore = await confirmDialog({
      title: 'Unsaved draft found',
      message: 'A newer unsaved version of this file was found from a previous session. Restore it?',
      okText: 'Restore draft',
      cancelText: 'Discard draft',
    });
    if (restore) content = draft;
    else removeDraft(path);
  }
  return { content, original: r.content };
}

// Forget the panel's file without prompting. Used when a text buffer has been handed
// to a file tab: one path must never be editable in two surfaces at once (they would
// diverge, and last save wins). Only reachable while no heavy tab owns the panel.
function releasePanelSurface() {
  editorPath = '';
  editorOriginalContent = '';
  clearTimeout(_autoSaveTimer);
  clearPreviewLiveReload();
  mdPreviewActive = false;
  try { editor?.setValue(''); } catch {}
  const ev = document.getElementById('editor-view');
  if (ev) { ev.classList.remove('open'); ev.classList.remove('fullscreen'); }
  const content = document.getElementById('content');
  if (content) content.classList.remove('editor-open');
  const preview = document.getElementById('editor-preview');
  if (preview) preview.classList.remove('active');
  const toggleBtn = document.getElementById('md-preview-toggle');
  if (toggleBtn) toggleBtn.style.display = 'none';
  const refreshBtn = document.getElementById('preview-refresh-btn');
  if (refreshBtn) refreshBtn.style.display = 'none';
  setFullBtnVisible(false);
  const iframe = document.getElementById('editor-preview-iframe');
  clearPreviewDoc(iframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; mdContent.innerHTML = ''; }
  const nameEl = document.getElementById('editor-filename');
  if (nameEl) nameEl.textContent = '—';
  const statusEl = document.getElementById('editor-status');
  if (statusEl) statusEl.textContent = '';
  updateEditorDirty();
  requestAnimationFrame(() => { tabs.forEach(t => { try { fitTerm(t); } catch {} }); });
}

async function openFileEditor(path) {
  if (isImageFile(path)) { openImageViewer(path); return; }
  // Already open as its own tab? Focus that tab rather than opening a second editor
  // on the same path.
  const openTab = findFileTab(path);
  if (openTab && !openTab.closed) { activateTab(openTab.id); return; }
  // A heavy file tab owns the panel right now, so a *different* file opened from the
  // explorer belongs in its own tab — otherwise a later Save in tab A could write tab
  // B's buffer to tab A's path.
  if (_dockedFileTabId != null) {
    const docked = tabs.find(t => t.id === _dockedFileTabId);
    if (docked && docked.path !== path) { newFileTab(path); return; }
  }
  if (isPdfFile(path)) { openPdfViewer(path); return; }
  if (isEpubFile(path)) { openEpubViewer(path); return; }
  if (isOfficeFile(path)) { openOfficeViewer(path); return; }
  if (isLegacyOfficeFile(path)) { toast('Legacy Office format — re-save as .docx/.xlsx (or .pdf) to preview, or use Download', 'warning'); return; }
  if (!canOpenInEditor(path)) { toast('Preview not supported for this file type — use Download', 'warning'); return; }
  const data = await readTextForEditor(path);
  if (!data) return;
  await showTextInPanel(path, data.content, data.original);
}

// Put a text buffer into the split panel. `original` is the on-disk text the dirty
// check compares against (so a restored draft still reads as modified), and
// `history` carries undo state when a buffer moves from a file tab into the panel.
async function showTextInPanel(path, content, original, history) {
  editorPath = path;
  editorOriginalContent = original != null ? original : content;
  const openContent = content;
  const sep = path.includes('\\') ? '\\' : '/';
  const fileName = path.split(sep).pop() || path;
  const isMd = /\.md$/i.test(fileName);
  const isHtml = /\.html?$/i.test(fileName);
  // hide doc viewers when opening text file
  cleanupDocViewers();
  document.getElementById('editor-save-btn').style.display = '';

  const cm = initCodeMirror();
  cm.setValue(openContent);
  cm.setOption('mode', await resolveCMmode(fileName));
  cm.setOption('readOnly', false);
  document.querySelector('.CodeMirror').style.display = '';
  cm.refresh();
  const ta = document.getElementById('editor-textarea');
  ta.oninput = () => updateEditorDirty();
  updateEditorDirty();

  const preview = document.getElementById('editor-preview');
  const toggleBtn = document.getElementById('md-preview-toggle');
  const refreshBtn = document.getElementById('preview-refresh-btn');
  const previewIframe = document.getElementById('editor-preview-iframe');
  const mdContent = document.getElementById('md-preview-content');
  preview.classList.remove('active');
  if (previewIframe) clearPreviewDoc(previewIframe);
  if (mdContent) { mdContent.style.display = 'none'; mdContent.innerHTML = ''; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  if ((isMd && typeof marked !== 'undefined') || isHtml) {
    toggleBtn.style.display = '';
    toggleBtn.textContent = 'Preview';
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
  } else {
    toggleBtn.style.display = 'none';
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
  }
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';

  // Desktop: split layout; Mobile: overlay (handled by CSS)
  if (window.innerWidth > 768) {
    document.getElementById('content').classList.add('editor-open');

    // Restore split orientation
    const splitArea = document.getElementById('editor-split-area');
    const orientToggle = document.getElementById('editor-split-toggle');
    try {
      const orient = safeStorage.getItem('wt-editor-split-orientation');
      const isHoriz = orient === 'horizontal';
      if (splitArea) splitArea.classList.toggle('horizontal', isHoriz);
      if (orientToggle) {
        orientToggle.classList.toggle('horizontal', isHoriz);
        orientToggle.classList.toggle('active', isHoriz);
        orientToggle.title = isHoriz ? 'Switch to vertical split' : 'Switch to horizontal split';
        const svg = orientToggle.querySelector('svg');
        if (svg) {
          if (isHoriz) {
            svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>';
          } else {
            svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/>';
          }
        }
      }
      const handle = document.getElementById('editor-resize-handle');
      if (handle) handle.style.cursor = isHoriz ? 'col-resize' : 'row-resize';
    } catch(e) { console.warn(e); }

    // Restore saved editor size for current orientation
    try {
      const isHoriz = splitArea && splitArea.classList.contains('horizontal');
      const key = isHoriz ? 'wt-editor-width' : 'wt-editor-height';
      const saved = safeStorage.getItem(key);
      if (saved) {
        document.documentElement.style.setProperty('--editor-size', saved + 'px');
      }
    } catch(e) { console.warn(e); }
  }
  document.getElementById('editor-view').classList.add('open');
  if (history) { try { cm.setHistory(history); } catch (e) { console.warn('Undo history restore failed:', e); } }
  cm.focus();

  // Fit all terminals to new available space
  requestAnimationFrame(() => {
    tabs.forEach(tab => { try { fitTerm(tab); } catch(e) { console.warn(e); } });
  });
}

async function saveFile() {
  if (!editorPath) { toast('No file open', 'error'); return; }
  setBtnBusy(document.getElementById('editor-save-btn'), true);
  const content = editor ? editor.getValue() : document.getElementById('editor-textarea').value;
  const r = await api('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: editorPath, content })
  });
  setBtnBusy(document.getElementById('editor-save-btn'), false);
  if (r.success) {
    editorOriginalContent = content;
    removeDraft(editorPath);
    clearTimeout(_autoSaveTimer);
    updateEditorDirty();
    document.getElementById('editor-status').textContent = 'Saved';
    toast('Saved', 'success');
    if (mdPreviewActive) refreshPreview();
    try { notifyPreviewFileSaved(); } catch {}
    setTimeout(() => document.getElementById('editor-status').textContent = '', 2000);
  } else toast(r.error, 'error');
}

async function closeEditor() {
  // Docked into a file tab: this × means "close this file tab", which runs the
  // tab's own unsaved-changes check and releases the viewer documents.
  if (_dockedFileTabId != null) {
    const t = tabs.find(x => x.id === _dockedFileTabId);
    if (t) { closeTab({ stopPropagation() {} }, t.id); return; }
    undockEditor();
  }
  const isDocPreview = !!(_pdfDoc || _epubBook || _officePath);
  if (!isDocPreview) {
    const currentContent = editor ? editor.getValue() : document.getElementById('editor-textarea').value;
    if (currentContent !== editorOriginalContent) {
      const ok = await confirmDialog({ title: 'Unsaved changes', message: 'You have unsaved changes. Close anyway?', okText: 'Discard', cancelText: 'Keep Editing', danger: true });
      if (!ok) return;
      // Explicit discard: drop the crash-safety draft too, so it is not offered again.
      if (editorPath) removeDraft(editorPath);
    }
    clearTimeout(_autoSaveTimer);
  }
  clearPreviewLiveReload();
  cleanupDocViewers();
  const ev = document.getElementById('editor-view');
  ev.classList.remove('open');
  ev.classList.remove('fullscreen');
  document.removeEventListener('keydown', _fsEscHandler);
  const fsBtn = document.getElementById('editor-fullscreen-toggle');
  if (fsBtn) { fsBtn.setAttribute('aria-label','Fullscreen'); fsBtn.title='Fullscreen (F11)'; fsBtn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'; }
  document.getElementById('content').classList.remove('editor-open');
  document.getElementById('editor-preview').classList.remove('active');
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  const previewIframe = document.getElementById('editor-preview-iframe');
  if (previewIframe) clearPreviewDoc(previewIframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; mdContent.innerHTML = ''; }
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = '';
  mdPreviewActive = false;
  editorPath = '';
  editorOriginalContent = '';
  requestAnimationFrame(() => {
    tabs.forEach(tab => { try { fitTerm(tab); tab?.term?.focus(); } catch(e) { console.warn(e); } });
  });
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);

// Binary extensions from https://github.com/sindresorhus/binary-extensions (v2.3.0)
// Used to block editor preview for non-text files. Images are previewable via image viewer, so they are checked first.
const BINARY_EXTS = new Set([
  '3dm','3ds','3g2','3gp','7z','a','aac','adp','afdesign','afphoto','afpub','ai','aif','aiff','alz','ape','apk','appimage','ar','arj','asf','au','avi','bak','baml','bh','bin','bk','bmp','btif','bz2','bzip2','cab','caf','cgm','class','cmx','cpio','cr2','cr3','cur','dat','dcm','deb','dex','djvu','dll','dmg','dng','doc','docm','docx','dot','dotm','dra','ds_store','dsk','dts','dtshd','dvb','dwg','dxf','ecelp4800','ecelp7470','ecelp9600','egg','eol','eot','epub','exe','f4v','fbs','fh','fla','flac','flatpak','fli','flv','fpx','fst','fvt','g3','gh','gif','graffle','gz','gzip','h261','h263','h264','icns','ico','ief','img','ipa','iso','jar','jpeg','jpg','jpgv','jpm','jxr','key','ktx','lha','lib','lvp','lz','lzh','lzma','lzo','m3u','m4a','m4v','mar','mdi','mht','mid','midi','mj2','mka','mkv','mmr','mng','mobi','mov','movie','mp3','mp4','mp4a','mpeg','mpg','mpga','mxu','nef','npx','numbers','nupkg','o','odp','ods','odt','oga','ogg','ogv','otf','ott','pages','pbm','pcx','pdb','pdf','pea','pgm','pic','png','pnm','pot','potm','potx','ppa','ppam','ppm','pps','ppsm','ppsx','ppt','pptm','pptx','psd','pya','pyc','pyo','pyv','qt','rar','ras','raw','resources','rgb','rip','rlc','rmf','rmvb','rpm','rtf','rz','s3m','s7z','scpt','sgi','shar','snap','sil','sketch','slk','smv','snk','so','stl','suo','sub','swf','tar','tbz','tbz2','tga','tgz','thmx','tif','tiff','tlz','ttc','ttf','txz','udf','uvh','uvi','uvm','uvp','uvs','uvu','viv','vob','war','wav','wax','wbmp','wdp','weba','webm','webp','whl','wim','wm','wma','wmv','wmx','woff','woff2','wrm','wvx','xbm','xif','xla','xlam','xls','xlsb','xlsm','xlsx','xlt','xltm','xltx','xm','xmind','xpi','xpm','xwd','xz','z','zip','zipx'
]);

function isImageFile(path) {
  const m = path.match(/\.([^.]+)$/);
  return m ? IMAGE_EXTS.has('.' + m[1].toLowerCase()) : false;
}

function getFileExt(path) {
  const m = path.match(/\.([^.\\/]+)$/);
  return m ? '.' + m[1].toLowerCase() : '';
}

function isBinaryFile(path) {
  const ext = getFileExt(path);
  return ext ? BINARY_EXTS.has(ext.slice(1).toLowerCase()) : false;
}

function canOpenInEditor(path) {
  if (isImageFile(path)) return false;
  if (isPdfFile(path) || isEpubFile(path)) return false;
  if (isBinaryFile(path)) return false;
  return true;
}

function isPdfFile(path) { return /\.pdf$/i.test(path); }
function isEpubFile(path) { return /\.epub$/i.test(path); }
function isOfficeDocx(path) { return /\.docx$/i.test(path); }
function isOfficeXlsx(path) { return /\.xlsx$/i.test(path); }
function isOfficeFile(path) { return isOfficeDocx(path) || isOfficeXlsx(path); }
function isLegacyOfficeFile(path) { return /\.(doc|dot|docm|dotm|xls|xlt|xlsm|xlsb|xlam|ppt|pot|pps|pptm|potm|ppsm|ppsx|odt|ods|odp|rtf)$/i.test(path); }
function isDocFile(path) { return isPdfFile(path) || isEpubFile(path) || isOfficeFile(path); }

// ── Doc preview dynamic loader ──
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function loadPdfJs() {
  if (window.pdfjsLib) return;
  // pdf.js v2 UMD global is pdfjsLib
  await loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.min.js');
  const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if (!lib) throw new Error('PDF.js not found');
  window.pdfjsLib = lib;
  if (lib.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js';
  }
}
async function loadEpubJs() {
  if (window.ePub) return;
  await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js');
  if (!window.ePub && !window.EPUBJS) throw new Error('EPUB.js not found');
  if (!window.ePub && window.EPUBJS) window.ePub = window.EPUBJS;
}

let _pdfDoc = null;
let _pdfPath = '';
let _pdfScale = 1.4;
let _pdfCurrentPage = 1;
let _pdfPageOrder = null;
let _pdfRenderGen = 0;
let _pdfScrollHandler = null;
let _pdfLazyObserver = null;
let _pdfQueue = [];
let _pdfQueued = new Set();
let _pdfRendering = new Set();
let _pdfQueueRunning = false;
let _pdfLabelMap = {};

async function openPdfViewer(path) {
  // Invalidate any in-flight PDF load/render so reopen/double-click can't duplicate pages
  const myGen = ++_pdfRenderGen;
  // Tear down previous doc render before starting a new one
  if (_pdfObserver) try { _pdfObserver.disconnect(); } catch {} _pdfObserver = null;
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); } catch {} _pdfLazyObserver = null;
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false; _pdfLabelMap = {};
  if (_pdfDoc) try { _pdfDoc.destroy(); } catch {} _pdfDoc = null;
  const _prevWrap = document.getElementById('pdf-canvas-wrap');
  if (_prevWrap && _pdfScrollHandler) try { _prevWrap.removeEventListener('scroll', _pdfScrollHandler); } catch {}
  _pdfScrollHandler = null;
  // Show viewer shell immediately for perceived performance
  editorPath = path;
  editorOriginalContent = '';
  const fileName = path.split(/[\\/]/).pop() || path;
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = 'none';
  document.getElementById('editor-preview').classList.remove('active');
  const iframe = document.getElementById('editor-preview-iframe');
  clearPreviewDoc(iframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('epub-viewer').classList.remove('active');
  document.getElementById('office-viewer').classList.remove('active');
  const pdfViewer = document.getElementById('pdf-viewer');
  pdfViewer.classList.add('active');
  document.getElementById('pdf-title').textContent = fileName;
  document.getElementById('pdf-page-info').textContent = 'Loading…';
  document.getElementById('pdf-canvas-wrap').innerHTML = '<div style="color:var(--fg2);padding:20px">Loading PDF…</div>';
  // open editor split immediately
  if (window.innerWidth > 768) {
    document.getElementById('content').classList.add('editor-open');
    const splitArea = document.getElementById('editor-split-area');
    try {
      const orient = safeStorage.getItem('wt-editor-split-orientation');
      const isHoriz = orient === 'horizontal';
      if (splitArea) splitArea.classList.toggle('horizontal', isHoriz);
    } catch {}
  }
  document.getElementById('editor-view').classList.add('open');
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
  // Load PDF.js immediately without confirmation (cached after first load)
  if (!window.pdfjsLib) {
    const t = toast('Loading PDF viewer…', 'info');
    try { await loadPdfJs(); t.remove(); } catch (e) { t.remove(); toast('Failed to load PDF viewer: ' + e.message, 'error'); return; }
  }
  if (myGen !== _pdfRenderGen) return;
  try {
    const resp = await fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, { headers: { 'x-pin-token': authToken } });
    if (myGen !== _pdfRenderGen) return;
    if (!resp.ok) throw new Error('Failed to fetch PDF');
    // Stream download with progress so big PDFs don't look stuck (fallback to arrayBuffer)
    let buf;
    try {
      const totalLen = parseInt(resp.headers.get('content-length') || '0', 10);
      if (resp.body && resp.body.getReader) {
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (myGen !== _pdfRenderGen) { try { reader.cancel(); } catch {} return; }
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (totalLen > 0) {
            const pct = Math.min(99, Math.round(received / totalLen * 100));
            document.getElementById('pdf-page-info').textContent = 'Downloading… ' + pct + '%';
          } else if (received % (1024*1024) < 65536) {
            document.getElementById('pdf-page-info').textContent = 'Downloading… ' + (received/1024/1024).toFixed(1) + 'MB';
          }
        }
        const merged = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        buf = merged.buffer;
      } else {
        buf = await resp.arrayBuffer();
      }
    } catch (e2) {
      if (myGen !== _pdfRenderGen) return;
      buf = await resp.arrayBuffer().catch(() => { throw e2; });
    }
    if (myGen !== _pdfRenderGen) return;
    const lib = window.pdfjsLib;
    const loadingTask = lib.getDocument({ data: buf });
    const doc = await loadingTask.promise;
    if (myGen !== _pdfRenderGen) { try { doc.destroy(); } catch {} return; }
    _pdfDoc = doc;
    _pdfPath = path;
    _pdfCurrentPage = 1;
    _pdfScale = 1.4;
    await renderPdfDoc(myGen);
  } catch (e) {
    if (myGen !== _pdfRenderGen) return;
    console.warn('PDF load failed', e);
    document.getElementById('pdf-canvas-wrap').innerHTML = '<div style="color:var(--red);padding:20px">Failed to load PDF: ' + escHtml(e.message) + '</div>';
    document.getElementById('pdf-page-info').textContent = 'Error';
    toast('PDF load failed: ' + e.message, 'error');
  }
}
async function renderPdfDoc(gen, opts) {
  const myGen = (gen !== undefined) ? gen : _pdfRenderGen;
  const doc = _pdfDoc;
  if (!doc) return;
  if (myGen !== _pdfRenderGen) return;
  const keepPage = opts && opts.keepPage ? _pdfCurrentPage : null;
  const wrap = document.getElementById('pdf-canvas-wrap');
  // reset lazy state for this generation
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); } catch {} _pdfLazyObserver = null;
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false;
  wrap.innerHTML = '';
  const total = doc.numPages;
  let pageLabels = null;
  try { pageLabels = await doc.getPageLabels(); } catch {}
  if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
  const getLabel = (idx) => pageLabels && pageLabels[idx-1] ? pageLabels[idx-1] : String(idx);
  // Build ordered list of pages sorted by actual page number (label if numeric, else index) to ensure preview matches printed page numbers
  let pageOrder = Array.from({length: total}, (_, k) => k+1);
  if (pageLabels) {
    try {
      pageOrder.sort((a,b) => {
        const la = getLabel(a), lb = getLabel(b);
        const na = parseInt(la, 10), nb = parseInt(lb, 10);
        const aIsNum = !isNaN(na) && String(na) === la.trim();
        const bIsNum = !isNaN(nb) && String(nb) === lb.trim();
        if (aIsNum && bIsNum) return na - nb;
        if (aIsNum && !bIsNum) return -1;
        if (!aIsNum && bIsNum) return 1;
        return la.localeCompare(lb);
      });
    } catch {}
  }
  _pdfPageOrder = pageOrder;
  _pdfLabelMap = {};
  for (const p of pageOrder) _pdfLabelMap[p] = getLabel(p);
  _pdfCurrentPage = (keepPage && pageOrder.includes(keepPage)) ? keepPage : pageOrder[0];
  document.getElementById('pdf-page-info').textContent = getLabel(pageOrder[0]) + ' / ' + getLabel(pageOrder[pageOrder.length-1]) + ' • ' + total + ' pages';
  // Build cheap placeholders for all pages in one DOM pass (fast even for 1000+ pages),
  // then lazily render only visible pages. This is the big-PDF optimization:
  // previously every page was rendered upfront serially (O(N) canvas work).
  try {
    const frag = document.createDocumentFragment();
    for (const i of pageOrder) {
      const pageWrap = document.createElement('div');
      pageWrap.className = 'pdf-page-box';
      pageWrap.id = 'pdf-wrap-' + i;
      pageWrap.dataset.page = i;
      pageWrap.dataset.label = getLabel(i);
      pageWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;width:100%';
      const slot = document.createElement('div');
      slot.className = 'pdf-page-slot';
      slot.dataset.page = i;
      slot.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:400px;min-width:min(100%,480px);background:rgba(127,127,127,0.08);border-radius:4px;color:var(--fg2);font-size:11px;padding:24px';
      slot.textContent = 'Page ' + getLabel(i) + ' — scroll to load…';
      pageWrap.appendChild(slot);
      const label = document.createElement('div');
      label.style.cssText = 'color:var(--fg2);font-size:10px';
      label.textContent = 'Page ' + getLabel(i) + ' • ' + i + '/' + total;
      pageWrap.appendChild(label);
      frag.appendChild(pageWrap);
    }
    wrap.appendChild(frag);
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
    setupPdfScrollTracking();
    setupPdfLazyRender(wrap, doc, myGen);
    // First-page-fast: render the current page immediately so the user sees content
    // without waiting for the observer, then let the queue handle the rest.
    await pdfRenderPageInto(_pdfCurrentPage, myGen, doc);
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
    // Pre-queue neighbours of the current page for instant scroll
    const order = _pdfPageOrder || pageOrder;
    const idx = order.indexOf(_pdfCurrentPage);
    for (let k = 1; k <= 2; k++) {
      if (order[idx+k]) pdfQueuePage(order[idx+k], myGen, doc, true);
      if (order[idx-k]) pdfQueuePage(order[idx-k], myGen, doc, true);
    }
  } catch (e) {
    if (myGen !== _pdfRenderGen) return;
    wrap.innerHTML = '<div style="color:var(--red);padding:20px">Render failed: ' + escHtml(e.message) + '</div>';
  }
}
// Queue a page for background render (deduped). Priority pages go to the front.
function pdfQueuePage(pageNum, myGen, doc, priority) {
  if (myGen !== _pdfRenderGen || !doc || _pdfDoc !== doc) return;
  const slot = document.querySelector('#pdf-wrap-' + pageNum + ' .pdf-page-slot');
  if (!slot || slot.dataset.rendered === '1' || _pdfRendering.has(pageNum) || _pdfQueued.has(pageNum)) return;
  if (priority) _pdfQueue.unshift({ pageNum, myGen });
  else _pdfQueue.push({ pageNum, myGen });
  // cap queue so fast scrolling doesn't pile up hundreds of pending renders
  if (_pdfQueue.length > 30) _pdfQueue.splice(30);
  pumpPdfQueue(doc);
}
async function pumpPdfQueue(doc) {
  if (_pdfQueueRunning) return;
  _pdfQueueRunning = true;
  try {
    while (_pdfQueue.length) {
      const job = _pdfQueue.shift();
      _pdfQueued.delete(job.pageNum);
      if (job.myGen !== _pdfRenderGen || _pdfDoc !== doc) { _pdfQueue.length = 0; break; }
      try { await pdfRenderPageInto(job.pageNum, job.myGen, doc); }
      catch (e) { /* placeholder keeps retry-on-visible */ }
      // breathe between background pages so scrolling stays smooth
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    _pdfQueueRunning = false;
  }
}
async function pdfRenderPageInto(pageNum, myGen, doc) {
  if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
  const box = document.getElementById('pdf-wrap-' + pageNum);
  if (!box) return;
  const slot = box.querySelector('.pdf-page-slot');
  if (!slot || slot.dataset.rendered === '1' || _pdfRendering.has(pageNum)) return;
  _pdfRendering.add(pageNum);
  try {
    const page = await doc.getPage(pageNum);
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
    const viewport = page.getViewport({ scale: _pdfScale });
    // Cap canvas backing store so huge pages don't OOM (~2.5MP max)
    const MAX_PX = 2500000;
    const px = viewport.width * viewport.height;
    let outW = Math.round(viewport.width), outH = Math.round(viewport.height);
    let styleW = viewport.width, styleH = viewport.height;
    if (px > MAX_PX) {
      const s = Math.sqrt(MAX_PX / px);
      outW = Math.round(viewport.width * s); outH = Math.round(viewport.height * s);
    }
    const canvas = document.createElement('canvas');
    canvas.id = 'pdf-page-' + pageNum;
    canvas.dataset.page = pageNum;
    canvas.dataset.label = _pdfLabelMap[pageNum] || String(pageNum);
    canvas.width = outW; canvas.height = outH;
    canvas.style.width = styleW + 'px';
    canvas.style.height = styleH + 'px';
    canvas.style.maxWidth = '100%';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: (outW === Math.round(viewport.width)) ? viewport : page.getViewport({ scale: _pdfScale * Math.sqrt(MAX_PX / px) }) }).promise;
    if (myGen !== _pdfRenderGen || _pdfDoc !== doc || !box.isConnected) return;
    slot.innerHTML = '';
    slot.style.minHeight = '';
    slot.style.background = 'transparent';
    slot.style.padding = '0';
    slot.style.position = 'relative';
    slot.appendChild(canvas);
    // Selectable text layer over the canvas (transparent spans). Sized to
    // the displayed canvas so max-width shrinking stays aligned.
    try {
      const lib = window.pdfjsLib;
      if (lib && typeof lib.renderTextLayer === 'function') {
        const textContent = await page.getTextContent();
        if (myGen !== _pdfRenderGen || _pdfDoc !== doc || !box.isConnected) return;
        if (textContent && textContent.items && textContent.items.length) {
          const dispW = canvas.clientWidth || styleW;
          const k = dispW / styleW;
          const textViewport = page.getViewport({ scale: _pdfScale * k });
          const layer = document.createElement('div');
          layer.className = 'textLayer';
          layer.style.width = dispW + 'px';
          layer.style.height = Math.round(styleH * k) + 'px';
          slot.appendChild(layer);
          const task = lib.renderTextLayer({ textContent, container: layer, viewport: textViewport });
          if (task && task.promise) await task.promise;
        }
      }
    } catch {}
    slot.dataset.rendered = '1';
    try { if (typeof page.cleanup === 'function') page.cleanup(); } catch {}
  } catch (e) {
    if (myGen !== _pdfRenderGen) return;
    if (slot && slot.dataset.rendered !== '1') {
      slot.textContent = 'Failed to render page ' + pageNum + ' — scroll away and back to retry';
    }
    throw e;
  } finally {
    _pdfRendering.delete(pageNum);
  }
}
function setupPdfLazyRender(wrap, doc, myGen) {
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); } catch {}
  try {
    _pdfLazyObserver = new IntersectionObserver((entries) => {
      if (myGen !== _pdfRenderGen || _pdfDoc !== doc) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const slot = e.target.nodeType === 1 && e.target.classList && e.target.classList.contains('pdf-page-slot')
          ? e.target
          : (e.target.querySelector ? e.target.querySelector('.pdf-page-slot') : null);
        const pn = slot ? parseInt(slot.dataset.page, 10) : parseInt(e.target.dataset && e.target.dataset.page, 10);
        if (pn) {
          if (slot && slot.dataset.rendered === '1') { try { _pdfLazyObserver.unobserve(e.target); } catch {} continue; }
          pdfQueuePage(pn, myGen, doc, false);
        }
      }
    }, { root: wrap, rootMargin: '1200px 0px', threshold: 0.01 });
    wrap.querySelectorAll('.pdf-page-box').forEach(b => _pdfLazyObserver.observe(b));
  } catch { _pdfLazyObserver = null; }
}
let _pdfObserver = null;
function setupPdfScrollTracking() {
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (!wrap || !_pdfDoc) return;
  if (_pdfObserver) try { _pdfObserver.disconnect(); } catch {}
  if (_pdfScrollHandler) try { wrap.removeEventListener('scroll', _pdfScrollHandler); } catch {}
  // Track boxes (not just rendered canvases) so tracking works before lazy render
  const boxes = wrap.querySelectorAll('.pdf-page-box');
  if (!boxes.length) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    let best = null;
    let bestTop = Infinity;
    const wrapRect = wrap.getBoundingClientRect();
    for (const c of boxes) {
      const r = c.getBoundingClientRect();
      // visible if within wrap viewport
      if (r.bottom > wrapRect.top && r.top < wrapRect.bottom) {
        const dist = Math.abs(r.top - wrapRect.top);
        if (dist < bestTop) { bestTop = dist; best = c; }
      }
    }
    if (best) {
      const pageNum = parseInt(best.dataset.page, 10);
      const label = best.dataset.label || String(pageNum);
      if (pageNum && pageNum !== _pdfCurrentPage) {
        _pdfCurrentPage = pageNum;
        let pageLabels2 = null;
        try { pageLabels2 = _pdfDoc.getPageLabels && _pdfDoc._pageLabels ? _pdfDoc._pageLabels : null; } catch {}
        // use stored label
        document.getElementById('pdf-page-info').textContent = label + ' • ' + pageNum + '/' + _pdfDoc.numPages + ' • scroll vertically';
      }
    }
  };
  _pdfScrollHandler = () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  };
  // also use IntersectionObserver for more precise
  try {
    _pdfObserver = new IntersectionObserver((entries) => {
      let best = null; let bestRatio = 0;
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio > bestRatio) {
          bestRatio = e.intersectionRatio; best = e.target;
        }
      }
      if (best) {
        const pageNum = parseInt(best.dataset.page, 10);
        const label = best.dataset.label || String(pageNum);
        if (pageNum) {
          _pdfCurrentPage = pageNum;
          document.getElementById('pdf-page-info').textContent = label + ' • ' + pageNum + '/' + _pdfDoc.numPages + ' • scroll vertically';
        }
      }
    }, { root: wrap, threshold: [0.5, 0.75] });
    boxes.forEach(c => _pdfObserver.observe(c));
  } catch { _pdfObserver = null; }
  if (_pdfObserver) {
    // The observer already updates the page indicator on visibility change. Both
    // used to run at once, so every scroll also did a getBoundingClientRect() pass
    // over every page box. The scroll pass is now only a fallback for browsers
    // without IntersectionObserver.
    requestAnimationFrame(update);
  } else {
    wrap.addEventListener('scroll', _pdfScrollHandler, { passive: true });
    setTimeout(update, 100);
  }
}
function pdfNav(dir) {
  if (!_pdfDoc) return;
  const wrap = document.getElementById('pdf-canvas-wrap');
  if (!wrap) return;
  // Scroll to next/prev page in sorted order
  const total = _pdfDoc.numPages;
  const order = _pdfPageOrder || Array.from({length: total}, (_,k)=>k+1);
  const idx = order.indexOf(_pdfCurrentPage);
  let nextIdx = idx + dir;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= order.length) nextIdx = order.length - 1;
  const target = order[nextIdx];
  _pdfCurrentPage = target;
  // Prefer the box (always present) so nav works even before lazy render;
  // ensure the target is queued at priority so it renders immediately.
  const box = document.getElementById('pdf-wrap-' + target);
  const canvasEl = document.getElementById('pdf-page-' + target);
  const label = (box && box.dataset.label) || (canvasEl && canvasEl.dataset.label) || (_pdfLabelMap[target]) || String(target);
  document.getElementById('pdf-page-info').textContent = label + ' • ' + target + '/' + total + ' • scroll vertically';
  if (_pdfDoc) pdfQueuePage(target, _pdfRenderGen, _pdfDoc, true);
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else if (dir < 0) wrap.scrollBy({ top: -wrap.clientHeight * 0.9, behavior: 'smooth' });
  else wrap.scrollBy({ top: wrap.clientHeight * 0.9, behavior: 'smooth' });
}
function pdfZoom(delta) {
  if (!_pdfDoc) return;
  _pdfScale = Math.max(0.6, Math.min(3, _pdfScale + delta));
  // Lazy mode: rebuilding placeholders is cheap; only visible pages re-render.
  // Bump generation so a stale in-flight render can't append duplicates.
  const keepPage = _pdfCurrentPage;
  const myGen = ++_pdfRenderGen;
  const wrap = document.getElementById('pdf-canvas-wrap');
  const scrollTop = wrap ? wrap.scrollTop : 0;
  if (_pdfObserver) try { _pdfObserver.disconnect(); _pdfObserver = null; } catch {}
  if (_pdfLazyObserver) try { _pdfLazyObserver.disconnect(); _pdfLazyObserver = null; } catch {}
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false;
  renderPdfDoc(myGen, { keepPage: true }).then(() => {
    if (myGen !== _pdfRenderGen) return;
    if (wrap) {
      const box = document.getElementById('pdf-wrap-' + keepPage);
      if (box) box.scrollIntoView({ block: 'start' });
      else wrap.scrollTop = scrollTop;
    }
  });
}

let _epubBook = null;
let _epubRendition = null;
let _epubPath = '';
let _epubBlobUrl = null;

// epub.js renders book content into same-origin frames, which would otherwise
// inherit this origin's storage and fetch credentials. `allowScriptedContent:
// false` stops the library enabling scripts; this pins the sandbox ourselves and
// strips active content, so a hostile .epub stays inert even if the library's
// defaults change. `allow-same-origin` is kept because epub.js needs DOM access
// to apply themes and measure the page — without scripts it grants nothing.
function hardenEpubRendition(rendition) {
  try {
    rendition.hooks.content.register(contents => {
      try {
        const doc = contents && contents.document;
        const frame = doc && doc.defaultView && doc.defaultView.frameElement;
        if (frame) {
          frame.setAttribute('sandbox', 'allow-same-origin');
          frame.setAttribute('referrerpolicy', 'no-referrer');
        }
        if (doc) {
          for (const el of doc.querySelectorAll('script,object,embed,iframe,frame,applet,base')) {
            try { el.remove(); } catch {}
          }
        }
      } catch {}
    });
  } catch {}
}

async function openEpubViewer(path) {
  editorPath = path;
  editorOriginalContent = '';
  const fileName = path.split(/[\\/]/).pop() || path;
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = 'none';
  document.getElementById('editor-preview').classList.remove('active');
  const iframe = document.getElementById('editor-preview-iframe');
  clearPreviewDoc(iframe);
  const mdContent2 = document.getElementById('md-preview-content');
  if (mdContent2) { mdContent2.style.display = 'none'; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('pdf-viewer').classList.remove('active');
  document.getElementById('office-viewer').classList.remove('active');
  const epubViewer = document.getElementById('epub-viewer');
  epubViewer.classList.add('active');
  document.getElementById('epub-title').textContent = fileName;
  document.getElementById('epub-loc').textContent = 'Loading…';
  if (!window.ePub) {
    const t = toast('Loading EPUB viewer…', 'info');
    try { await loadEpubJs(); t.remove(); } catch (e) { t.remove(); toast('Failed to load EPUB viewer: ' + e.message, 'error'); return; }
  }
  if (window.innerWidth > 768) {
    document.getElementById('content').classList.add('editor-open');
    const splitArea = document.getElementById('editor-split-area');
    try {
      const orient = safeStorage.getItem('wt-editor-split-orientation');
      const isHoriz = orient === 'horizontal';
      if (splitArea) splitArea.classList.toggle('horizontal', isHoriz);
    } catch {}
  }
  document.getElementById('editor-view').classList.add('open');
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
  // cleanup previous
  try { if (_epubRendition) { _epubRendition.destroy(); _epubRendition = null; } } catch {}
  try { if (_epubBook) { _epubBook.destroy(); _epubBook = null; } } catch {}
  if (_epubBlobUrl) { URL.revokeObjectURL(_epubBlobUrl); _epubBlobUrl = null; }
  document.getElementById('epub-view').innerHTML = '';
  // Show loading immediately
  document.getElementById('epub-loc').textContent = 'Loading EPUB…';
  try {
    const resp = await fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, { headers: { 'x-pin-token': authToken } });
    if (!resp.ok) throw new Error('Failed to fetch EPUB (' + resp.status + ')');
    const arrayBuffer = await resp.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength < 100) throw new Error('Empty or invalid EPUB file (size ' + (arrayBuffer ? arrayBuffer.byteLength : 0) + ')');
    const header = new Uint8Array(arrayBuffer.slice(0, 4));
    const isZip = header[0] === 0x50 && header[1] === 0x4B;
    console.log('EPUB fetch OK', path, 'bytes', arrayBuffer.byteLength, 'isZip', isZip, 'header', Array.from(header));
    if (!isZip) throw new Error('Not a valid EPUB (missing PK header, got ' + Array.from(header).join(',') + ')');
    _epubPath = path;
    const book = window.ePub(arrayBuffer, { openAs: 'binary', encoding: 'binary', store: false });
    _epubBook = book;
    // Listen for openFailed
    book.on('openFailed', (e) => { console.warn('EPUB openFailed', e); throw e; });
    // Ensure container is visible and has layout before renderTo
    await new Promise(r => requestAnimationFrame(r));
    // Try scrolled-doc first (vertical scroll), fallback to paginated if fails
    let rendition;
    try {
      rendition = book.renderTo('epub-view', { flow: 'scrolled-doc', width: '100%', height: '100%', allowScriptedContent: false, store: false });
    } catch (e) {
      console.warn('scrolled-doc failed, fallback to paginated', e);
      try { if (rendition) rendition.destroy(); } catch {}
      document.getElementById('epub-view').innerHTML = '';
      rendition = book.renderTo('epub-view', { flow: 'paginated', width: '100%', height: '100%', manager: 'default', allowScriptedContent: false });
    }
    hardenEpubRendition(rendition);
    _epubRendition = rendition;
    const s = getComputedStyle(document.documentElement);
    const bg = s.getPropertyValue('--bg').trim();
    const fg = s.getPropertyValue('--fg').trim();
    try {
      rendition.themes.default({ body: { background: bg + ' !important', color: fg + ' !important', 'font-size': '16px', 'line-height': '1.6', 'padding': '0 12px' } });
    } catch {}
    const displayTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('EPUB display timeout - try downloading the file')), 15000));
    await Promise.race([rendition.display(), displayTimeout]);
    document.getElementById('epub-loc').textContent = 'Scroll vertically • ' + (rendition.location ? 'ready' : '');
    // keyboard nav still works for scrolled-doc (prev/next section)
    rendition.on('keyup', (e) => {
      if (e.key === 'ArrowLeft') rendition.prev();
      if (e.key === 'ArrowRight') rendition.next();
    });
    // also allow continuous wheel scroll naturally; update location on relocate
    try {
      rendition.on('relocated', (loc) => {
        if (loc && loc.start && loc.start.percentage !== undefined) {
          const pct = Math.round(loc.start.percentage * 100);
          document.getElementById('epub-loc').textContent = pct + '% • scroll';
        }
      });
    } catch {}
  } catch (e) {
    console.warn('EPUB load failed', e);
    document.getElementById('epub-loc').textContent = 'Failed';
    document.getElementById('epub-view').innerHTML = '<div style="color:var(--red);padding:20px">Failed to load EPUB: ' + escHtml(e.message) + '</div>';
    toast('EPUB load failed: ' + e.message, 'error');
  }
}
function epubNav(dir) {
  if (!_epubRendition) return;
  if (dir < 0) _epubRendition.prev();
  else _epubRendition.next();
}
function cleanupDocViewers() {
  // PDF — invalidate any in-flight load/render first
  _pdfRenderGen++;
  if (_pdfObserver) { try { _pdfObserver.disconnect(); } catch {} _pdfObserver = null; }
  if (_pdfLazyObserver) { try { _pdfLazyObserver.disconnect(); } catch {} _pdfLazyObserver = null; }
  _pdfQueue = []; _pdfQueued = new Set(); _pdfRendering = new Set(); _pdfQueueRunning = false; _pdfLabelMap = {};
  if (_pdfDoc) { try { _pdfDoc.destroy(); } catch {} _pdfDoc = null; }
  _pdfPath = '';
  _pdfPageOrder = null;
  _pdfCurrentPage = 1;
  const pdfWrap = document.getElementById('pdf-canvas-wrap');
  if (pdfWrap) {
    // remove scroll listener added in setupPdfScrollTracking
    if (_pdfScrollHandler) try { pdfWrap.removeEventListener('scroll', _pdfScrollHandler); } catch {}
    _pdfScrollHandler = null;
    pdfWrap.innerHTML = '';
  }
  const pdfViewer = document.getElementById('pdf-viewer');
  if (pdfViewer) pdfViewer.classList.remove('active');
  // EPUB
  try { if (_epubRendition) { _epubRendition.destroy(); _epubRendition = null; } } catch {}
  try { if (_epubBook) { _epubBook.destroy(); _epubBook = null; } } catch {}
  if (_epubBlobUrl) { URL.revokeObjectURL(_epubBlobUrl); _epubBlobUrl = null; }
  _epubPath = '';
  const epubViewer = document.getElementById('epub-viewer');
  if (epubViewer) epubViewer.classList.remove('active');
  const epubView = document.getElementById('epub-view');
  if (epubView) epubView.innerHTML = '';
  // Office (DOCX/XLSX, read-only)
  _officeGen++;
  _officePath = '';
  const officeViewer = document.getElementById('office-viewer');
  if (officeViewer) officeViewer.classList.remove('active');
  const officeContent = document.getElementById('office-content');
  if (officeContent) officeContent.innerHTML = '';
  document.getElementById('editor-save-btn').style.display = '';
}
// ── Office doc preview (DOCX/XLSX, read-only) ──
// Client-side only: mammoth (DOCX→HTML) + SheetJS (XLSX→table), lazy-loaded
// from jsDelivr (already in CSP). Legacy .doc/.xls/.ppt have no browser
// renderer — those stay on the Download fallback.
const MAX_OFFICE_SIZE = 10 * 1024 * 1024; // 10MB — larger files: use Download
const OFFICE_SHEET_MAX_ROWS = 500;
const OFFICE_SHEET_MAX_COLS = 50;
let _officePath = '';
let _officeGen = 0;
async function loadMammoth() {
  if (window.mammoth) return;
  await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js');
  if (!window.mammoth) throw new Error('mammoth not found');
}
async function loadSheetJs() {
  if (window.XLSX) return;
  await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0/dist/xlsx.full.min.js');
  if (!window.XLSX) throw new Error('SheetJS not found');
}
async function openOfficeViewer(path) {
  const myGen = ++_officeGen;
  _officePath = '';
  // Viewer shell (mirrors openPdfViewer/openEpubViewer)
  editorPath = path;
  editorOriginalContent = '';
  const fileName = path.split(/[\\/]/).pop() || path;
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = 'none';
  document.getElementById('editor-preview').classList.remove('active');
  const iframe = document.getElementById('editor-preview-iframe');
  clearPreviewDoc(iframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('pdf-viewer').classList.remove('active');
  document.getElementById('epub-viewer').classList.remove('active');
  document.getElementById('office-viewer').classList.add('active');
  _officePath = path;
  document.getElementById('office-title').textContent = fileName;
  document.getElementById('office-info').textContent = 'Loading…';
  document.getElementById('office-content').innerHTML = '<div style="color:var(--fg2);padding:20px">Loading…</div>';
  if (window.innerWidth > 768) {
    document.getElementById('content').classList.add('editor-open');
    const splitArea = document.getElementById('editor-split-area');
    try {
      const orient = safeStorage.getItem('wt-editor-split-orientation');
      const isHoriz = orient === 'horizontal';
      if (splitArea) splitArea.classList.toggle('horizontal', isHoriz);
    } catch {}
  }
  document.getElementById('editor-view').classList.add('open');
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
  const isDocx = isOfficeDocx(path);
  // Libs lazy-load on first use (cached after)
  const needLib = (isDocx && !window.mammoth) || (!isDocx && !window.XLSX);
  let libToast = null;
  try {
    if (isDocx && typeof DOMPurify === 'undefined') throw new Error('sanitizer failed to load (CDN blocked?)');
    if (needLib) libToast = toast('Loading office viewer…', 'info');
    if (isDocx) await loadMammoth();
    else await loadSheetJs();
  } catch (e) {
    if (libToast) libToast.remove();
    if (myGen !== _officeGen) return;
    return officeLoadError(e.message);
  }
  if (libToast) libToast.remove();
  if (myGen !== _officeGen) return;
  try {
    const resp = await fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, { headers: { 'x-pin-token': authToken } });
    if (myGen !== _officeGen) return;
    if (!resp.ok) throw new Error('Failed to fetch file (' + resp.status + ')');
    const buf = await resp.arrayBuffer();
    if (myGen !== _officeGen) return;
    if (!buf || buf.byteLength < 4) throw new Error('Empty file');
    if (buf.byteLength > MAX_OFFICE_SIZE) throw new Error('File too large for preview (max 10MB) — use Download');
    const head = new Uint8Array(buf.slice(0, 4));
    if (!(head[0] === 0x50 && head[1] === 0x4B)) throw new Error('Not a valid Office file (missing ZIP header)');
    if (isDocx) await renderOfficeDocx(buf);
    else renderOfficeXlsx(buf);
  } catch (e) {
    if (myGen !== _officeGen) return;
    officeLoadError(e.message);
  }
}
function officeLoadError(msg) {
  document.getElementById('office-info').textContent = 'Failed';
  document.getElementById('office-content').innerHTML = '<div style="color:var(--red);padding:20px">Failed to load: ' + escHtml(msg) + '</div>';
  toast('Office preview failed: ' + msg, 'error');
}
let _officeWb = null; // cached xlsx workbook for sheet switching
async function renderOfficeDocx(buf) {
  _officeWb = null;
  try { const sel = document.getElementById('office-sheet-sel'); if (sel) sel.style.display = 'none'; } catch {}
  // convertImage keeps embedded pictures (dropped by default) as data: URLs —
  // allowed by CSP img-src and kept by DOMPurify; remote URLs still stripped below.
  const out = await window.mammoth.convertToHtml({ arrayBuffer: buf }, {
    convertImage: window.mammoth.images.imgElement(img => img.readAsDataURL().then(src => ({ src })))
  });
  let html = (out && out.value ? out.value : '').trim();
  if (!html) html = '<p>(Empty document)</p>';
  // Never render unsanitized HTML — office files can carry scripts/links.
  const wrap = document.createElement('div');
  wrap.innerHTML = DOMPurify.sanitize(html);
  // Drop remote images that could leak the session to third parties.
  wrap.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (/^https?:/i.test(src)) img.removeAttribute('src');
  });
  wrap.querySelectorAll('a').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); });
  const content = document.getElementById('office-content');
  content.innerHTML = '';
  content.appendChild(wrap);
  const notes = [];
  if (out && out.messages && out.messages.length) notes.push(out.messages.length + ' element(s) simplified');
  notes.push('Read-only');
  document.getElementById('office-info').textContent = notes.join(' • ');
}
function renderOfficeXlsx(buf) {
  const wb = window.XLSX.read(buf, { type: 'array' });
  const names = (wb && wb.SheetNames) || [];
  if (!names.length) throw new Error('No sheets found');
  _officeWb = wb;
  renderOfficeSheet(0);
}
function buildOfficeSheetSelect(names, idx) {
  const sel = document.getElementById('office-sheet-sel');
  if (!sel) return;
  if (!names || names.length < 2) { sel.style.display = 'none'; sel.innerHTML = ''; return; }
  sel.style.display = '';
  sel.innerHTML = names.map((n, i) => '<option value="' + i + '"' + (i === idx ? ' selected' : '') + '>' + escHtml(n) + '</option>').join('');
  sel.value = String(idx);
}
function officeSheetChanged(v) {
  const i = parseInt(v, 10);
  if (Number.isInteger(i)) { try { renderOfficeSheet(i); } catch (e) { officeLoadError(e.message); } }
}
function officeCellText(cell) {
  if (!cell) return '';
  // Prefer authored formatted text (dates, %, currency); fall back to raw value.
  if (cell.w != null) return String(cell.w);
  return fmtOfficeCell(cell.v);
}
function renderOfficeSheet(idx) {
  const wb = _officeWb;
  const names = (wb && wb.SheetNames) || [];
  const ws = wb && wb.Sheets[names[idx]];
  if (!ws || !ws['!ref']) {
    document.getElementById('office-content').innerHTML = '<p>(Empty sheet)</p>';
    document.getElementById('office-info').textContent = (names[idx] || 'Sheet') + ' • Empty • Read-only';
    buildOfficeSheetSelect(names, idx);
    return;
  }
  const range = window.XLSX.utils.decode_range(ws['!ref']);
  const totalRows = range.e.r - range.s.r + 1;
  const totalCols = range.e.c - range.s.c + 1;
  const endR = Math.min(range.e.r, range.s.r + OFFICE_SHEET_MAX_ROWS - 1);
  const endC = Math.min(range.e.c, range.s.c + OFFICE_SHEET_MAX_COLS - 1);
  // Merged ranges: top-left cell keeps colspan/rowspan, covered cells skipped.
  const skip = new Set(), span = new Map();
  try {
    for (const m of (ws['!merges'] || [])) {
      span.set(m.s.r + ',' + m.s.c, { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 });
      for (let R = m.s.r; R <= m.e.r; R++) for (let C = m.s.c; C <= m.e.c; C++) {
        if (R !== m.s.r || C !== m.s.c) skip.add(R + ',' + C);
      }
    }
  } catch {}
  // Title-row pattern: a single-row merge spanning the full width is a title,
  // not a header — the row below it becomes the header instead.
  let headerR = range.s.r;
  try {
    const t = span.get(range.s.r + ',' + range.s.c);
    if (t && t.rs === 1 && t.cs === totalCols && totalCols > 1) headerR = range.s.r + 1;
  } catch {}
  // Cell-address iteration (not sheet_to_json) so blank rows/cols keep alignment.
  const enc = window.XLSX.utils.encode_cell, encCol = window.XLSX.utils.encode_col;
  let html = '<table class="office-grid"><thead><tr><th class="corner" scope="col"></th>';
  for (let C = range.s.c; C <= endC; C++) html += '<th scope="col">' + encCol(C) + '</th>';
  html += '</tr></thead><tbody>';
  for (let R = range.s.r; R <= endR; R++) {
    html += '<tr><td class="rownum">' + (R + 1) + '</td>';
    for (let C = range.s.c; C <= endC; C++) {
      const k = R + ',' + C;
      if (skip.has(k)) continue;
      const txt = escHtml(officeCellText(ws[enc({ r: R, c: C })]));
      const sp = span.get(k);
      const spanAttr = sp ? ' colspan="' + sp.cs + '" rowspan="' + sp.rs + '"' : '';
      // Header row renders as <th>, like a real spreadsheet.
      html += R === headerR ? '<th scope="col"' + spanAttr + '>' + txt + '</th>' : '<td' + spanAttr + '>' + txt + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  const notes = [];
  notes.push(names[idx] + (names.length > 1 ? ' (' + (idx + 1) + '/' + names.length + ')' : ''));
  if (endR < range.e.r || endC < range.e.c) {
    notes.push('Showing ' + (endR - range.s.r + 1) + '×' + (endC - range.s.c + 1) + ' of ' + totalRows + '×' + totalCols);
  } else {
    notes.push(totalRows + '×' + totalCols);
  }
  notes.push('Read-only');
  buildOfficeSheetSelect(names, idx);
  document.getElementById('office-content').innerHTML = html;
  document.getElementById('office-info').textContent = notes.join(' • ');
}
function fmtOfficeCell(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'number') return String(Math.round(c * 1e10) / 1e10);
  return String(c);
}
// Preload doc viewers in background for instant open (respect datasaver)
function preloadDocViewers() {
  try {
    if (settings && settings.datasaver) return;
    // Honour the browser's own data-saving hint too (Android Chrome, Safari
    // low-data mode): a warm-up we never asked for shouldn't fight it.
    if (navigator.connection && navigator.connection.saveData) return;
    if (!window.pdfjsLib) loadPdfJs().catch(()=>{});
    if (!window.ePub) loadEpubJs().catch(()=>{});
    if (!window.mammoth) loadMammoth().catch(()=>{});
    if (!window.XLSX) loadSheetJs().catch(()=>{});
  } catch {}
}
setTimeout(() => {
  if (document.hidden) {
    const h = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', h); preloadDocViewers(); } };
    document.addEventListener('visibilitychange', h);
  } else {
    if ('requestIdleCallback' in window) requestIdleCallback(preloadDocViewers, { timeout: 3000 });
    else setTimeout(preloadDocViewers, 1500);
  }
}, 1500);

let _ivImageUrl = null;

let _ivGen = 0;
function openImageViewer(path) {
  const myGen = ++_ivGen;
  const name = path.split(/[\\/]/).pop() || path;
  document.getElementById('iv-name').textContent = name;
  document.getElementById('iv-img').style.display = 'none';
  document.getElementById('iv-loading').style.display = 'block';
  document.getElementById('iv-loading').textContent = 'Loading…';
  if (_ivImageUrl) { URL.revokeObjectURL(_ivImageUrl); _ivImageUrl = null; }
  openOverlay('image-viewer');
  fetch(`/api/files/image?path=${encodeURIComponent(path)}&_t=${Date.now()}`, {
    headers: { 'x-pin-token': authToken }
  }).then(r => {
    if (!r.ok) throw new Error('Failed to load');
    return r.blob();
  }).then(blob => {
    if (myGen !== _ivGen) return; // stale — superseded, drop the blob
    _ivImageUrl = URL.createObjectURL(blob);
    const img = document.getElementById('iv-img');
    img.onload = () => {
      document.getElementById('iv-loading').style.display = 'none';
      img.style.display = '';
      img.onload = null;
    };
    img.onerror = () => {
      document.getElementById('iv-loading').textContent = 'Failed to load image';
    };
    img.src = _ivImageUrl;
  }).catch(() => {
    document.getElementById('iv-loading').textContent = 'Failed to load image';
  });
}

function closeImageViewer() {
  document.getElementById('iv-img').src = '';
  if (_ivImageUrl) { URL.revokeObjectURL(_ivImageUrl); _ivImageUrl = null; }
  closeOverlay('image-viewer');
}

function toggleHtmlPreview() {
  const cmWrapper = document.querySelector('.CodeMirror');
  const preview = document.getElementById('editor-preview');
  const iframe = document.getElementById('editor-preview-iframe');
  const btn = document.getElementById('md-preview-toggle');
  const refreshBtn = document.getElementById('preview-refresh-btn');
  const isActive = preview.classList.contains('active');
  if (isActive) {
    if (cmWrapper) cmWrapper.style.display = '';
    preview.classList.remove('active');
    if (iframe) iframe.style.display = 'none';
    btn.textContent = 'Preview';
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
    mdPreviewActive = false;
    editor.focus();
    clearPreviewLiveReload();
  } else {
    // hide doc viewers when entering html preview
    document.getElementById('pdf-viewer').classList.remove('active');
    document.getElementById('epub-viewer').classList.remove('active');
    renderHtmlPreview();
    if (cmWrapper) cmWrapper.style.display = 'none';
    preview.classList.add('active');
    btn.textContent = 'Edit';
    if (refreshBtn) refreshBtn.style.display = '';
    setFullBtnVisible(true);
    mdPreviewActive = true;
    startPreviewLiveReload();
  }
}

function toggleFullHtmlPreview() {
  if (!/\.html?$/i.test(editorPath || '')) return;
  htmlFullPreview = !htmlFullPreview;
  const b = document.getElementById('html-full-toggle');
  if (b) {
    b.classList.toggle('btn-primary', htmlFullPreview);
    b.classList.toggle('btn-ghost', !htmlFullPreview);
    b.setAttribute('aria-pressed', String(htmlFullPreview));
  }
  if (htmlFullPreview) {
    // Warn once ever (persisted): the mode itself is per-file and Safe-default,
    // but the explanation shouldn't nag on every toggle.
    let warned = false;
    try { warned = safeStorage.getItem('wt-full-preview-warned') === 'true'; } catch {}
    if (!warned) {
      toast('Full preview: this file\u2019s scripts run in an isolated frame — no access to the app, its storage or your files', 'warning');
      try { safeStorage.setItem('wt-full-preview-warned', 'true'); } catch {}
    }
  }
  renderHtmlPreview();
}

function getHtmlBaseDir() {
  const p = editorPath || currentPath || '';
  if (!p) return '';
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx > 0 ? p.slice(0, idx) : p;
}
function isAbsoluteUrlForHtml(url) {
  // Truly external/unresolvable: schemes, protocol-relative, data/blob,
  // fragments. A single leading "/" is NOT absolute here — a file preview has
  // no web root (see toPreviewApiUrl), so "/x" resolves against the file dir.
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|data:|blob:|#)/i.test(url.trim());
}
function toPreviewApiUrl(rel, baseDir) {
  if (!rel || isAbsoluteUrlForHtml(rel)) return rel;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return rel;
  let pathPart = rel;
  // No web root exists in a file preview: root-absolute "/x" would resolve
  // against the app itself and 404 (the classic blank page), so resolve it
  // against the previewed file's directory instead.
  if (pathPart.trim().startsWith('/')) pathPart = pathPart.trim().replace(/^\/+/, '');
  // keep query/hash part
  let hash = '';
  let query = '';
  const hIdx = pathPart.indexOf('#');
  if (hIdx !== -1) { hash = pathPart.slice(hIdx); pathPart = pathPart.slice(0, hIdx); }
  const qIdx = pathPart.indexOf('?');
  if (qIdx !== -1) { query = pathPart.slice(qIdx); pathPart = pathPart.slice(0, qIdx); }
  pathPart = pathPart.trim();
  if (!pathPart) return rel;
  const abs = joinPath(baseDir || '', pathPart);
  let api = `/api/files/image?path=${encodeURIComponent(abs)}`;
  if (authToken) api += `&token=${encodeURIComponent(authToken)}`;
  if (query) api += (query.startsWith('?') ? `&${query.slice(1)}` : query);
  if (hash) api += hash;
  return api;
}
// Rewrite attributes everywhere (including <script src=> tags) but never touch
// script BODIES: JS string literals must stay byte-identical or scripted pages
// break in subtle ways (blank or half-dead renders). Only Full mode needs
// this — sanitized output has no scripts left to protect.
function rewriteFullHtmlUrls(raw, baseDir) {
  if (!baseDir) return raw;
  const re = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi;
  let out = '', last = 0, m;
  for (;;) {
    m = re.exec(raw);
    if (!m) break;
    out += rewriteHtmlRelativeUrls(raw.slice(last, m.index), baseDir);
    out += rewriteHtmlRelativeUrls(m[1], baseDir); // opening tag: src rewritten
    out += m[2]; // body: verbatim
    out += m[3];
    last = m.index + m[0].length;
  }
  out += rewriteHtmlRelativeUrls(raw.slice(last), baseDir);
  return out;
}
function rewriteHtmlRelativeUrls(html, baseDir) {
  if (!baseDir) return html;
  // src/href/srcset/poster/data/action/cite/background
  html = html.replace(/\b(src|href|srcset|poster|data|cite|action|background)\s*=\s*(["'])([^"']+)\2/gi, (m, attr, q, val) => {
    if (attr.toLowerCase() === 'srcset') {
      const parts = val.split(',').map(p => {
        const seg = p.trim();
        if (!seg) return seg;
        const sp = seg.split(/\s+/);
        const url = sp[0];
        const desc = sp.slice(1).join(' ');
        const newUrl = toPreviewApiUrl(url, baseDir);
        return desc ? `${newUrl} ${desc}` : newUrl;
      });
      return `${attr}=${q}${parts.join(', ')}${q}`;
    }
    const newVal = toPreviewApiUrl(val, baseDir);
    if (newVal === val) return m;
    return `${attr}=${q}${newVal}${q}`;
  });
  // url(...) in style attributes and <style> tags
  html = html.replace(/url\(\s*(["']?)([^"'\)]+)\1\s*\)/gi, (m, q, url) => {
    const trimmed = url.trim();
    if (!trimmed || isAbsoluteUrlForHtml(trimmed)) return m;
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return m;
    const newUrl = toPreviewApiUrl(trimmed, baseDir);
    return `url(${q}${newUrl}${q})`;
  });
  return html;
}
// Preview frame transport: blob URLs instead of srcdoc. Some browsers refuse
// to paint a sandboxed srcdoc frame (healthy rect, correct document delivered,
// blank pixels), while blob: is explicitly allowed by the CSP frame-src and
// paints everywhere. The sandbox attribute (opaque origin, scripts-only)
// applies identically — only the delivery changes. Previous blob revoked
// on every swap so long sessions don't hoard object URLs.
let _previewDocUrl = null;
function setPreviewDoc(iframe, doc) {
  try { if (_previewDocUrl) URL.revokeObjectURL(_previewDocUrl); } catch {}
  _previewDocUrl = null;
  if (!iframe) return;
  try {
    _previewDocUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
    iframe.removeAttribute('srcdoc');
    iframe.src = _previewDocUrl;
  } catch (e) {
    try { iframe.srcdoc = doc; } catch {} // pre-Blob browsers
  }
  iframe.style.display = 'block';
}
function clearPreviewDoc(iframe) {
  try { if (_previewDocUrl) URL.revokeObjectURL(_previewDocUrl); } catch {}
  _previewDocUrl = null;
  if (!iframe) return;
  try { iframe.removeAttribute('srcdoc'); iframe.src = 'about:blank'; } catch {}
  iframe.style.display = 'none';
}
function renderHtmlPreview() {
  try { renderHtmlPreviewInner(); }
  catch (e) {
    // A preview must never die as a silent blank pane: surface the reason
    // inside the frame (works over tunnel too — no console needed to see it).
    console.warn('HTML preview failed:', e);
    try {
      const iframe = document.getElementById('editor-preview-iframe');
      setPreviewDoc(iframe, '<p style="font-family:sans-serif;padding:16px">Preview failed: ' + escHtml((e && e.message) || 'unknown error') + '</p>');
    } catch {}
    try { toast('Preview failed: ' + ((e && e.message) || 'unknown error'), 'error'); } catch {}
  }
}
function renderHtmlPreviewInner() {
  const iframe = document.getElementById('editor-preview-iframe');
  const mdContent = document.getElementById('md-preview-content');
  const raw = editor ? editor.getValue() : '';
  if (!iframe) return;
  if (!editor || !raw) {
    setPreviewDoc(iframe, '<p style="font-family:sans-serif;padding:16px">' + (!editor ? 'Nothing to preview — open a file first.' : 'Nothing to preview — the file is empty.') + '</p>');
    return;
  }
  if (mdContent) mdContent.style.display = 'none';
  if (iframe) iframe.style.display = 'block';
  const baseDir = getHtmlBaseDir();
  const s = getComputedStyle(document.documentElement);
  const isDark = !['#f9f9fb', '#ffffff', 'rgb(249, 249, 251)', 'rgb(255, 255, 255)'].includes(s.getPropertyValue('--bg').trim());
  const isFullDoc = /<!DOCTYPE|<html[\s>]/i.test(raw);
  const baseHref = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (authToken ? `&token=${encodeURIComponent(authToken)}` : '');
  const injectHead = (doc, tags) => /<head[^>]*>/i.test(doc)
    ? doc.replace(/<head[^>]*>/i, m => m + tags)
    : doc.replace(/<html[^>]*>/i, m => m + '<head>' + tags + '</head>');
  if (htmlFullPreview) {
    // FULL mode: author's bytes verbatim — scripts run. Still confined to the
    // opaque-origin sandbox (allow-scripts only): no parent DOM, no storage,
    // no popups, no top navigation, no form submit. Needs no CDN.
    let doc;
    if (isFullDoc) {
      doc = rewriteFullHtmlUrls(raw, baseDir);
      if (!/<base\b/i.test(doc)) doc = injectHead(doc, `<base href="${escHtml(baseHref)}">`);
      if (!/<meta[^>]*color-scheme/i.test(doc)) doc = injectHead(doc, `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
    } else {
      // Fragment: minimal shell, no theme CSS — the author's own styles rule,
      // like opening the file in a real browser tab.
      const frag = rewriteFullHtmlUrls(raw, baseDir);
      doc = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">\n<base href="${escHtml(baseHref)}">\n</head>\n<body>${frag}</body>\n</html>`;
    }
    setPreviewDoc(iframe, doc);
    return;
  }
  // Never render unsanitized HTML: without the DOMPurify CDN the preview
  // stays off (scripts in the file could otherwise reach the app).
  if (typeof DOMPurify === 'undefined') {
    setPreviewDoc(iframe, '<p style="font-family:sans-serif;padding:16px">Preview unavailable — sanitizer failed to load (CDN blocked?).</p>');
    toast('Preview unavailable: sanitizer failed to load', 'warning');
    return;
  }
  const bg = s.getPropertyValue('--bg').trim();
  const fg = s.getPropertyValue('--fg').trim();
  const accent = s.getPropertyValue('--accent').trim();
  const bg2 = s.getPropertyValue('--bg2').trim();
  const border = s.getPropertyValue('--border').trim();
  const font = s.getPropertyValue('--font').trim();
  let doc;
  if (isFullDoc) {
    let sanitized = DOMPurify.sanitize(raw, { WHOLE_DOCUMENT: true, USE_PROFILES: { html: true }, ADD_TAGS: ['base','style'], ADD_ATTR: ['target'] });
    sanitized = rewriteHtmlRelativeUrls(sanitized, baseDir);
    // Inject base tag if missing for any remaining relative URLs
    if (!/<base\b/i.test(sanitized)) {
      const baseHref = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (authToken ? `&token=${encodeURIComponent(authToken)}` : '');
      sanitized = sanitized.replace(/<head[^>]*>/i, m => m + `<base href="${escHtml(baseHref)}">`);
    }
    // Ensure color-scheme meta
    if (!/<meta[^>]*color-scheme/i.test(sanitized)) {
      sanitized = sanitized.replace(/<head[^>]*>/i, m => m + `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
    }
    doc = sanitized;
  } else {
    let fragment = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] });
    fragment = rewriteHtmlRelativeUrls(fragment, baseDir);
    const baseHrefFrag = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (authToken ? `&token=${encodeURIComponent(authToken)}` : '');
    doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">
<base href="${escHtml(baseHrefFrag)}">
<style>
  :root { color-scheme: ${isDark ? 'dark' : 'light'}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 24px; font-family: ${font};
    font-size: 14px; line-height: 1.6; background: ${bg}; color: ${fg};
    -webkit-font-smoothing: antialiased;
  }
  a { color: ${accent}; }
  img { max-width: 100%; height: auto; }
  pre { background: ${bg2}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; overflow-x: auto; }
  code { font-family: ${font}; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  code:not(pre code) { background: ${bg2}; padding: 2px 6px; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid ${border}; padding: 8px 12px; text-align: left; }
  th { background: ${bg2}; }
  blockquote { margin: 0.75em 0; padding: 4px 16px; border-left: 4px solid ${accent}; background: ${bg2}; border-radius: 0 6px 6px 0; }
  h1, h2, h3, h4, h5, h6 { margin: 1em 0 0.5em; font-weight: 700; }
  h1 { font-size: 1.8em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid ${border}; padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  p { margin: 0.75em 0; }
  ul, ol { margin: 0.5em 0; padding-left: 2em; }
  li { margin: 0.25em 0; }
  hr { border: none; border-top: 1px solid ${border}; margin: 1.5em 0; }
  input[type="text"], input[type="email"], input[type="password"], input[type="number"],
  textarea, select, button {
    font-family: ${font}; font-size: 14px; padding: 6px 10px;
    border: 1px solid ${border}; border-radius: 4px; background: ${bg2}; color: ${fg};
  }
  button { cursor: pointer; }
  input:focus, textarea:focus, select:focus { outline: 2px solid ${accent}; outline-offset: 1px; }
</style>
</head>
<body>${fragment}</body>
</html>`;
  }
  setPreviewDoc(iframe, doc);
}

function renderMdPreview() {
  const preview = document.getElementById('editor-preview');
  const mdContent = document.getElementById('md-preview-content');
  const iframe = document.getElementById('editor-preview-iframe');
  const raw = editor ? editor.getValue() : '';
  if (!preview || !mdContent) return;
  if (iframe) iframe.style.display = 'none';
  mdContent.style.display = 'block';
  try {
    if (typeof DOMPurify === 'undefined') {
      mdContent.innerHTML = '<p style="padding:16px">Preview unavailable — sanitizer failed to load (CDN blocked?).</p>';
      return;
    }
    const html = marked.parse(raw, { breaks: true, gfm: true, langPrefix: 'language-' });
    const sanitized = DOMPurify.sanitize(html);
    const s = getComputedStyle(document.documentElement);
    const bg = s.getPropertyValue('--bg').trim();
    const fg = s.getPropertyValue('--fg').trim();
    const accent = s.getPropertyValue('--accent').trim();
    const bg2 = s.getPropertyValue('--bg2').trim();
    const bg3 = s.getPropertyValue('--bg3').trim();
    const border = s.getPropertyValue('--border').trim();
    const fg2 = s.getPropertyValue('--fg2').trim();
    const font = s.getPropertyValue('--font').trim();
    mdContent.innerHTML = `
      <style>
        .md-rendered { max-width: 800px; margin: 0 auto; }
        .md-rendered h1, .md-rendered h2, .md-rendered h3, .md-rendered h4, .md-rendered h5, .md-rendered h6 { color: ${fg}; margin: 1.2em 0 0.5em; font-weight: 700; }
        .md-rendered h1 { font-size: 1.8em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
        .md-rendered h2 { font-size: 1.5em; border-bottom: 1px solid ${border}; padding-bottom: 0.25em; }
        .md-rendered h3 { font-size: 1.25em; }
        .md-rendered h4 { font-size: 1.1em; }
        .md-rendered p { margin: 0.75em 0; line-height: 1.7; }
        .md-rendered ul, .md-rendered ol { margin: 0.5em 0; padding-left: 2em; }
        .md-rendered li { margin: 0.25em 0; }
        .md-rendered blockquote { margin: 0.75em 0; padding: 4px 16px; border-left: 4px solid ${accent}; background: ${bg2}; color: ${fg2}; border-radius: 0 6px 6px 0; }
        .md-rendered code { font-family: ${font}; background: ${bg3}; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
        .md-rendered pre { background: ${bg2}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; overflow-x: auto; margin: 0.75em 0; }
        .md-rendered pre code { background: none; padding: 0; border-radius: 0; font-size: 0.85em; }
        .md-rendered table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
        .md-rendered th, .md-rendered td { border: 1px solid ${border}; padding: 8px 12px; text-align: left; }
        .md-rendered th { background: ${bg3}; font-weight: 600; }
        .md-rendered hr { border: none; border-top: 1px solid ${border}; margin: 1.5em 0; }
        .md-rendered a { color: ${accent}; text-decoration: none; }
        .md-rendered a:hover { text-decoration: underline; }
        .md-rendered img { max-width: 100%; border-radius: 6px; }
      </style>
      <div class="md-rendered">${sanitized}</div>`;
  } catch (e) {
    console.warn('Markdown preview error:', e);
    mdContent.textContent = 'Error rendering markdown preview';
  }
}

let _previewLiveReloadTimer = null;
// Live preview is driven by CodeMirror's `change` event (see initCodeMirror) with a
// debounce, instead of a 1 s interval that called editor.getValue() and compared the
// whole document text every tick. Same result, no polling, and it fires per edit.
const PREVIEW_MAX_LIVE_BYTES = 200000;
function schedulePreviewLiveReload() {
  if (!mdPreviewActive || !editor) return;
  if (editor.getValue().length > PREVIEW_MAX_LIVE_BYTES) return;
  clearTimeout(_previewLiveReloadTimer);
  _previewLiveReloadTimer = setTimeout(() => {
    _previewLiveReloadTimer = null;
    if (!mdPreviewActive || !editor) return;
    if (editor.getValue().length > PREVIEW_MAX_LIVE_BYTES) return;
    if (/\.html?$/i.test(editorPath)) renderHtmlPreview();
    else renderMdPreview();
  }, 350);
}
function startPreviewLiveReload() {
  // Nothing to start: the change handler is always wired. Kept as the entry point
  // the preview toggles call, and used to drop any pending render.
  clearPreviewLiveReload();
}
function clearPreviewLiveReload() {
  if (_previewLiveReloadTimer) { clearTimeout(_previewLiveReloadTimer); _previewLiveReloadTimer = null; }
}

function refreshPreview() {
  if (!editor) return;
  if (/\.html?$/i.test(editorPath)) renderHtmlPreview();
  else renderMdPreview();
  toast('Preview refreshed', 'success');
}

function toggleMdPreview() {
  if (/\.html?$/i.test(editorPath)) {
    toggleHtmlPreview();
    return;
  }
  const cmWrapper = document.querySelector('.CodeMirror');
  const preview = document.getElementById('editor-preview');
  const btn = document.getElementById('md-preview-toggle');
  const refreshBtn = document.getElementById('preview-refresh-btn');
  mdPreviewActive = !mdPreviewActive;
  if (mdPreviewActive) {
    document.getElementById('pdf-viewer').classList.remove('active');
    document.getElementById('epub-viewer').classList.remove('active');
    renderMdPreview();
    if (cmWrapper) cmWrapper.style.display = 'none';
    preview.classList.add('active');
    btn.textContent = 'Edit';
    if (refreshBtn) refreshBtn.style.display = '';
    startPreviewLiveReload();
  } else {
    if (cmWrapper) cmWrapper.style.display = '';
    preview.classList.remove('active');
    btn.textContent = 'Preview';
    if (refreshBtn) refreshBtn.style.display = 'none';
    editor.focus();
    clearPreviewLiveReload();
  }
}

// ═══════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════
function toggleSearch() {
  const bar = document.getElementById('search-bar');
  bar.classList.toggle('open');
  if (bar.classList.contains('open')) {
    document.getElementById('search-input').focus();
    document.getElementById('search-input').select();
  } else closeSearch();
}

function closeSearch() {
  document.getElementById('search-bar').classList.remove('open');
  const tab = getActiveTab();
  tab?.searchAddon?.clearDecorations();
  tab?.term?.focus();
}

let searchCaseSensitive = false;
function toggleSearchCase() {
  searchCaseSensitive = !searchCaseSensitive;
  const btn = document.getElementById('search-case-btn');
  btn.classList.toggle('active', searchCaseSensitive);
  btn.setAttribute('aria-pressed', String(searchCaseSensitive));
  doSearch();
}

// Decoration colors for search highlighting; enabling decorations is also what
// makes the addon emit onDidChangeResults (the count in #search-results).
const SEARCH_DECORATIONS = {
  matchBackground: '#3d59a1', matchBorder: '#7aa2f7', matchOverviewRuler: '#7aa2f7',
  activeMatchBackground: '#e0af68', activeMatchBorder: '#ffc777', activeMatchColorOverviewRuler: '#e0af68'
};

// Typing used to scan the entire scrollback (up to 50k lines) synchronously on
// every keystroke, which janked the terminal in long buffers.
let _searchDebounce = null;
function queueSearch() {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(doSearch, 150);
}

function doSearch() {
  const q = document.getElementById('search-input').value;
  const tab = getActiveTab();
  const el = document.getElementById('search-results');
  if (!tab?.searchAddon || !q) { el.textContent = ''; return; }
  // Count is rendered by the addon's onDidChangeResults event (wired per tab).
  tab.searchAddon.findNext(q, { caseSensitive: searchCaseSensitive, decorations: SEARCH_DECORATIONS });
}

function searchNext() { const q=document.getElementById('search-input').value; if (!q) return; const t=getActiveTab(); t?.searchAddon?.findNext(q, {caseSensitive: searchCaseSensitive, decorations: SEARCH_DECORATIONS}); }
function searchPrev() { const q=document.getElementById('search-input').value; if (!q) return; const t=getActiveTab(); t?.searchAddon?.findPrevious(q, {caseSensitive: searchCaseSensitive, decorations: SEARCH_DECORATIONS}); }

function searchKeydown(e) {
  if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext(); }
  if (e.key === 'Escape') closeSearch();
}

// ═══════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════
function loadSettings() {
  try {
    const s = JSON.parse(safeStorage.getItem('wt-settings'));
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      if (typeof s.theme === 'string' && ['system','tokyonight','light','solarized','gruvbox','dracula','monokai'].includes(s.theme)) settings.theme = s.theme;
      if (typeof s.fontSize === 'number' && s.fontSize >= 8 && s.fontSize <= 32) settings.fontSize = s.fontSize;
      if (typeof s.scrollback === 'number' && s.scrollback >= 100 && s.scrollback <= 50000) settings.scrollback = s.scrollback;
      if (typeof s.font === 'string') settings.font = s.font;
      if (typeof s.cursor === 'string' && ['block','underline','bar'].includes(s.cursor)) settings.cursor = s.cursor;
      if (typeof s.blink === 'boolean') settings.blink = s.blink;
      if (typeof s.bell === 'boolean') settings.bell = s.bell;
      if (typeof s.mobilekeys === 'boolean') settings.mobilekeys = s.mobilekeys;
      if (typeof s.confirmclose === 'boolean') settings.confirmclose = s.confirmclose;
      if (typeof s.datasaver === 'boolean') settings.datasaver = s.datasaver;
      if (typeof s.keepAwake === 'boolean') settings.keepAwake = s.keepAwake;
      if (typeof s.screensaver === 'boolean') settings.screensaver = s.screensaver;
      if (typeof s.screensaverMin === 'number' && s.screensaverMin >= 1 && s.screensaverMin <= 120) settings.screensaverMin = s.screensaverMin;
      if (typeof s.gitEnabled === 'boolean') settings.gitEnabled = s.gitEnabled;
      if (typeof s.gitSimple === 'boolean') settings.gitSimple = s.gitSimple;
      if (typeof s.clipboardRead === 'boolean') settings.clipboardRead = s.clipboardRead;
    }
  } catch(e) { console.warn(e); }
  document.getElementById('s-theme').value = settings.theme;
  document.getElementById('s-fontsize').value = settings.fontSize;
  document.getElementById('s-scrollback').value = settings.scrollback;
  document.getElementById('s-font').value = settings.font;
  document.getElementById('s-cursor').value = settings.cursor;
  syncToggle('blink'); syncToggle('bell'); syncToggle('clipboardRead'); syncToggle('mobilekeys'); syncToggle('confirmclose'); syncToggle('datasaver'); syncToggle('termRightClick'); syncToggle('screensaver'); syncToggle('gitEnabled'); syncToggle('gitSimple');
  try { if (typeof applyGitEnabled === 'function') applyGitEnabled(); } catch {}
  try { if (typeof applyGitSimple === 'function') applyGitSimple(); } catch {}
  syncKeepAwakeUI();
  if (settings.keepAwake && hasWakeLock) { requestWakeLock(); }
  if (isElectron) {
    document.querySelectorAll('.electron-only').forEach(el => el.style.display = '');
    window.electronAPI.getAutostart().then(enabled => {
      settings.autostart = enabled;
      syncToggle('autostart');
    }).catch(() => {});
  }
}

function saveSettings() { safeStorage.setItem('wt-settings', JSON.stringify(settings)); }

const DEFAULT_SETTINGS = {
  theme: 'light', fontSize: 14, font: "'JetBrains Mono', 'SF Mono', 'Fira Code', Consolas, monospace",
  cursor: 'block', blink: true, scrollback: 5000, bell: false,
  mobilekeys: false, confirmclose: true, datasaver: false, autostart: false, keepAwake: false, termRightClick: true,
  screensaver: false, screensaverMin: 5, gitEnabled: true, gitSimple: true,
  clipboardRead: false // off: OSC 52 GET (program reads your clipboard) needs consent
};

async function resetSettings() {
  const ok = await confirmDialog({ title: 'Reset settings', message: 'Reset all settings to defaults?', okText: 'Reset', danger: true });
  if (!ok) return;
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  document.getElementById('s-theme').value = settings.theme;
  document.getElementById('s-fontsize').value = settings.fontSize;
  document.getElementById('s-scrollback').value = settings.scrollback;
  document.getElementById('s-font').value = settings.font;
  document.getElementById('s-cursor').value = settings.cursor;
  document.getElementById('s-screensaver-min').value = settings.screensaverMin;
  syncToggle('blink'); syncToggle('bell'); syncToggle('clipboardRead'); syncToggle('mobilekeys'); syncToggle('confirmclose'); syncToggle('datasaver'); syncToggle('termRightClick'); syncToggle('screensaver'); syncToggle('gitEnabled'); syncToggle('gitSimple'); syncToggle('autostart');
  // keepAwake is a header checkbox, not a settings toggle — resync it
  try { if (typeof syncKeepAwakeUI === 'function') syncKeepAwakeUI(); } catch {}
  // Clear an active auto-screensaver and the search filter (sections stay hidden otherwise)
  try { if (typeof pokeScreensaver === 'function') pokeScreensaver(); } catch {}
  try {
    const si = document.getElementById('settings-search');
    if (si && si.value) { si.value = ''; if (typeof filterSettings === 'function') filterSettings(''); }
  } catch {}
  applyTheme(settings.theme);
  applyFontSize(settings.fontSize);
  applyScrollback(settings.scrollback);
  if (settings.font) applyFont(settings.font);
  applyCursor(settings.cursor);
  const mk = document.getElementById('mobile-keys');
  if (mk) mk.style.display = settings.mobilekeys && window.innerWidth <= 768 ? 'flex' : 'none';
  try { if (typeof applyGitEnabled === 'function') applyGitEnabled(); } catch {}
  try { if (typeof applyGitSimple === 'function') applyGitSimple(); } catch {}
  toast('Settings reset', 'success');
}

function saveSetting(k, v) { settings[k] = v; saveSettings(); }

function applyScreensaverMin(v) {
  v = Math.max(1, Math.min(120, Math.round(+v) || 5));
  settings.screensaverMin = v;
  saveSettings();
  document.getElementById('s-screensaver-min').value = v;
  pokeScreensaver();
}

function syncToggle(k) {
  const el = document.getElementById('s-' + k);
  if (el) {
    el.classList.toggle('on', !!settings[k]);
    el.setAttribute('aria-checked', String(!!settings[k]));
  }
}

function toggleSetting(k) {
  settings[k] = !settings[k];
  syncToggle(k);
  if (k === 'autostart') {
    if (isElectron) {
      window.electronAPI.setAutostart(settings.autostart).then(ok => {
        if (!ok) { settings.autostart = false; syncToggle('autostart'); }
      }).catch(() => { settings.autostart = false; syncToggle('autostart'); });
    }
    return;
  }
  saveSettings();
  if (k === 'mobilekeys') {
    const mk = document.getElementById('mobile-keys');
    mk.style.display = settings.mobilekeys && window.innerWidth <= 768 ? 'flex' : 'none';
    const ctrlRow = document.getElementById('mkey-ctrl-row');
    if (ctrlRow) ctrlRow.style.display = 'none';
    const ctrlBtn = document.getElementById('ctrl-toggle-btn');
    if (ctrlBtn) ctrlBtn.style.background = '';
  }
  if (k === 'bell' && settings.bell && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  if (k === 'datasaver') {
    if (settings.datasaver) {
      if (sysStatsTimer) { clearInterval(sysStatsTimer); sysStatsTimer = null; }
      try { stopSysIconPulse(); resetSysIcon(); } catch {}
    } else {
      try { startSysIconPulse(); } catch {}
      if (document.getElementById('sys-overlay').classList.contains('open')) {
        refreshSystemStats(true);
      }
    }
  }
  if (k === 'gitEnabled') {
    try { applyGitEnabled(); } catch {}
  }
  if (k === 'gitSimple') {
    try { applyGitSimple(); } catch {}
  }
}

function applyGitSimple() {
  const panel = document.getElementById('git-panel');
  if (!panel) return;
  panel.classList.toggle('git-simple', settings.gitSimple === true);
  try { updateGitAdvToggle(); } catch {}
}
function toggleGitAdvanced() {
  const panel = document.getElementById('git-panel');
  if (!panel) return;
  panel.classList.toggle('show-rare');
  try { updateGitAdvToggle(); } catch {}
}
function updateGitAdvToggle() {
  const btn = document.getElementById('git-adv-toggle');
  const panel = document.getElementById('git-panel');
  if (!btn || !panel) return;
  const show = panel.classList.contains('show-rare');
  btn.textContent = show ? 'Show fewer' : 'Show advanced…';
  btn.setAttribute('aria-expanded', String(show));
  try { updateGitFootRow(); } catch {}
}
function updateGitFootRow() {
  const foot = document.getElementById('git-foot-row');
  const adv = document.getElementById('git-adv-toggle');
  if (!foot) return;
  let advShown = false;
  try { advShown = !!adv && getComputedStyle(adv).display !== 'none'; } catch {}
  const moreShown = !!foot.querySelector('#git-log-more');
  foot.style.display = (advShown || moreShown) ? '' : 'none';
}

function applyGitEnabled() {
  const section = document.getElementById('git-section');
  if (!section) return;
  if (settings.gitEnabled === false) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  try { if (typeof currentPath !== 'undefined' && currentPath) refreshGitPanel(currentPath, true); } catch {}
}

// Every element a modal sidebar/panel must block while it is open. #main is
// excluded because these panels are its children.
const BACKDROP_INERT_IDS = ['header', 'sidebar', 'content'];
function setBackdropInert(on) {
  for (const id of BACKDROP_INERT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    try { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } catch {}
  }
}

function openSettings() {
  const panel = document.getElementById('settings-panel');
  const isOpen = panel.classList.contains('open');
  // Don't inert #main because the panel lives inside it — inert would disable
  // the panel itself. Inert the panel's visible siblings instead, so the
  // sidebar/header/tab strip can't be clicked or tabbed behind the dialog.
  if (!isOpen) {
    panel.classList.add('open');
    setupSettingsSections();
    updateSecurityUI();
    try { refreshSessions(); } catch {}
    // Tunnel ids change on auto-restart and dead rows otherwise linger until
    // reload — resync every time the panel opens, like sessions above.
    try { restoreTunnels(); } catch {}
    // Replay staggered card entrance on every open
    panel.classList.remove('sec-anim');
    void panel.offsetWidth;
    panel.classList.add('sec-anim');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('role', 'dialog');
    // Defer inert + focus to next frame so panel transform can composite on GPU without reflowing sidebar/file-list
    requestAnimationFrame(() => {
      setBackdropInert(true);
      installFocusTrap(panel);
      const firstFocusable = panel.querySelector('select, button, input');
      if (firstFocusable) firstFocusable.focus({ preventScroll: true });
    });
    setTimeout(() => document.addEventListener('click', closeSettingsOnClickOutside, true), 50);
  } else {
    panel.classList.remove('open');
    panel.removeAttribute('aria-modal');
    setBackdropInert(false);
    removeFocusTrap();
    document.removeEventListener('click', closeSettingsOnClickOutside, true);
  }
}
function closeSettings() {
  const panel = document.getElementById('settings-panel');
  panel.classList.remove('open');
  panel.removeAttribute('aria-modal');
  setBackdropInert(false);
  removeFocusTrap();
  document.removeEventListener('click', closeSettingsOnClickOutside, true);
}
function closeSettingsOnClickOutside(e) {
  const panel = document.getElementById('settings-panel');
  const btn = document.querySelector('[onclick="openSettings()"]');
  if (!panel.classList.contains('open')) { document.removeEventListener('click', closeSettingsOnClickOutside, true); return; }
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeSettings();
}

// Collapsible settings groups — all closed by default, choice persisted per group.
let _settingsSecsSetup = false;
// Per-section SVG icons (12px, stroke) for the control-deck headers
const _secIcons = {
  security: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  appearance: '<path d="M12 2s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  interface: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><circle cx="9" cy="6" r="2.2"/><circle cx="15" cy="12" r="2.2"/><circle cx="7" cy="18" r="2.2"/>',
  tunnel: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  features: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  reset: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  about: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
};
function setupSettingsSections() {
  if (_settingsSecsSetup) return;
  _settingsSecsSetup = true;
  document.querySelectorAll('#settings-panel .settings-section').forEach(sec => {
    // Static sections (e.g. About) stay open and untouched
    if (sec.hasAttribute('data-static')) return;
    const h3 = sec.querySelector('h3');
    if (!h3 || sec.dataset.secSetup) return;
    sec.dataset.secSetup = '1';
    const slug = sec.dataset.sec || h3.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    // Wrap body rows (everything after h3) in grid-animated body > inner
    const body = document.createElement('div');
    body.className = 'settings-section-body';
    const inner = document.createElement('div');
    inner.className = 'settings-section-inner';
    [...sec.childNodes].forEach(n => { if (n !== h3) inner.appendChild(n); });
    body.appendChild(inner);
    sec.appendChild(body);
    // Section icon (inserted before title text / status pill)
    if (_secIcons[slug]) {
      const ico = document.createElement('span');
      ico.className = 'sec-ico';
      ico.setAttribute('aria-hidden', 'true');
      ico.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + _secIcons[slug] + '</svg>';
      h3.insertBefore(ico, h3.firstChild);
    }
    // Chevron + toggle affordance on the header
    const chev = document.createElement('span');
    chev.className = 'sec-chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
    h3.appendChild(chev);
    h3.setAttribute('role', 'button');
    h3.setAttribute('tabindex', '0');
    let open = false;
    try { open = safeStorage.getItem('wt-settings-sec-' + slug) === 'true'; } catch {}
    const paint = (v) => {
      sec.classList.toggle('open', v);
      h3.setAttribute('aria-expanded', String(v));
    };
    const apply = () => paint(open);
    sec._secApply = apply;
    const toggle = () => {
      if (sec._secPeeked) {
        // Click while peeked: pin it open instead of closing
        sec._secPeeked = false;
        open = true;
      } else {
        open = !open;
      }
      try { safeStorage.setItem('wt-settings-sec-' + slug, String(open)); } catch {}
      apply();
    };
    h3.addEventListener('click', toggle);
    h3.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    // Hover-peek (mirrors bookmarks): auto-open on hover intent, auto-close
    // on leave. Click/Enter/Space while peeked pins the section open.
    let _secHoverTimer = null;
    sec.addEventListener('mouseenter', () => {
      clearTimeout(_secHoverTimer);
      if (sec.classList.contains('open')) return;
      if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
      const si = document.getElementById('settings-search');
      if (si && si.value.trim()) return; // search owns visibility while filtering
      _secHoverTimer = setTimeout(() => {
        if (!sec.classList.contains('open')) { sec._secPeeked = true; paint(true); }
      }, 110);
    });
    sec.addEventListener('mouseleave', () => {
      clearTimeout(_secHoverTimer);
      if (!sec._secPeeked) return;
      sec._secPeeked = false;
      apply(); // restore persisted open/closed state
    });
    apply();
  });
  // Live search filter (wired once)
  const si = document.getElementById('settings-search');
  if (si && !si.dataset.wired) {
    si.dataset.wired = '1';
    si.addEventListener('input', () => filterSettings(si.value));
    si.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); si.value = ''; filterSettings(''); si.blur(); }
    });
  }
}
function filterSettings(q) {
  q = (q || '').trim().toLowerCase();
  const secs = [...document.querySelectorAll('#settings-panel .settings-section')];
  let anyVisible = false;
  secs.forEach(sec => {
    const h3 = sec.querySelector('h3');
    if (!q) {
      sec.style.display = '';
      const inner = sec.querySelector('.settings-section-inner');
      const kids = inner ? [...inner.children] : [...sec.children].filter(el => el.tagName !== 'H3');
      kids.forEach(ch => ch.style.display = '');
      if (sec._secApply) sec._secApply();
      anyVisible = true;
      return;
    }
    const titleHit = h3 && h3.textContent.toLowerCase().includes(q);
    const inner = sec.querySelector('.settings-section-inner');
    const kids = inner ? [...inner.children] : [...sec.querySelectorAll(':scope > div:not(.settings-section-body)')];
    let show = !!titleHit;
    kids.forEach(ch => {
      const hit = !!titleHit || ((ch.textContent || '').toLowerCase().includes(q));
      ch.style.display = hit ? '' : 'none';
      if (hit) show = true;
    });
    if (show) { sec.style.display = ''; sec.classList.add('open'); anyVisible = true; }
    else sec.style.display = 'none';
  });
  document.getElementById('settings-no-match').style.display = anyVisible ? 'none' : '';
}

// ── Security: set / change / disable PIN ──
async function updateSecurityUI() {
  let prot = null;
  try {
    const r = await api('/api/auth/required');
    if (r && r.required !== undefined) prot = !!r.required;
  } catch {}
  const label = document.getElementById('pin-state-label');
  const pill = document.getElementById('sec-pin-status');
  const cur = document.getElementById('pin-current');
  if (prot === null) {
    if (label) label.textContent = 'Unknown';
    if (pill) { pill.textContent = '?'; pill.classList.remove('on'); }
    return prot;
  }
  if (label) {
    label.textContent = prot ? 'ON — PIN required' : 'OFF — open access';
    label.style.color = prot ? 'var(--green)' : 'var(--fg2)';
  }
  if (pill) {
    pill.textContent = prot ? 'Protected' : 'Open';
    pill.classList.toggle('on', prot);
  }
  if (cur) cur.disabled = !prot;
  return prot;
}
async function changePin() {
  clearFieldError('pin-field-error');
  const curEl = document.getElementById('pin-current');
  const newEl = document.getElementById('pin-new');
  const cur = (curEl.value || '').trim();
  const next = (newEl.value || '').trim();
  if (/[\r\n\0]/.test(next)) { showFieldError('pin-field-error', 'PIN contains invalid characters'); return; }
  if (next.length > 64) { showFieldError('pin-field-error', 'PIN must be 64 characters or less'); return; }
  const prot = await updateSecurityUI();
  if (prot && !cur) { showFieldError('pin-field-error', 'Enter the current PIN'); curEl.focus(); return; }
  if (!next) {
    const ok = await confirmDialog({ title: 'Remove protection?', message: 'Anyone with access to WebTun will be able to open it. Continue?', okText: 'Remove PIN', danger: true });
    if (!ok) return;
  }
  const btn = document.getElementById('pin-save-btn');
  setBtnBusy(btn, true);
  const r = await api('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPin: cur, newPin: next }) });
  setBtnBusy(btn, false);
  if (!r || !r.success) { showFieldError('pin-field-error', (r && r.error) || 'Failed to update PIN'); return; }
  // Fresh sessions need a second session's approval while others exist —
  // the change pends instead of applying. Nothing rotated yet.
  if (r.pending) {
    toast('Approval needed — approve from another signed-in tab within 60s', 'warning');
    try { refreshSessions(); } catch {}
    return;
  }
  // PIN rotation revokes all session tokens server-side — log back in to
  // mint a fresh one so subsequent calls keep working.
  if (!next) {
    authToken = 'open';
    storeSessionToken('');
  } else {
    try {
      const lr = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: next, device: clientDeviceLabel() })
      }).then(r => r.json());
      if (lr && lr.success && lr.token) {
        authToken = lr.token;
        storeSessionToken(lr.token);
      } else {
        showPinScreen();
        toast('PIN updated — sign in again', 'info');
        return;
      }
    } catch {
      showPinScreen();
      toast('PIN updated — sign in again', 'info');
      return;
    }
  }
  curEl.value = ''; newEl.value = '';
  updateSecurityUI();
  toast(!next ? 'PIN removed — open access' : 'PIN updated', 'success');
  if (!r.persisted) toast('Active now, but .env is not writable — restart will revert (' + (r.persistError || 'write failed') + ')', 'warning');
  try { refreshSessions(); } catch {}
}

// ── Security: active login sessions ──
// Live session count drawn on the coffee cup itself (hidden when 0/unknown/open mode)
async function updateSessionCupCount() {
  const num = document.getElementById('sess-cup-num');
  if (!num) return;
  if (!window._appUnlocked || !authToken || authToken === 'open') { num.style.display = 'none'; return; }
  try {
    const r = await api('/api/auth/sessions');
    const n = r && Array.isArray(r.sessions) ? r.sessions.length : 0;
    if (n > 0) {
      num.textContent = n > 9 ? '9+' : String(n);
      num.style.display = '';
      num.parentElement?.closest('label')?.setAttribute('title',
        n === 1 ? 'Keep Screen Awake — 1 active login session (open Security to review)' : `Keep Screen Awake — ${n} active login sessions (open Security to review)`);
    } else {
      num.style.display = 'none';
    }
  } catch { /* leave last state on failure */ }
}
async function refreshSessions() {
  try { updateSessionCupCount(); } catch {}
  const list = document.getElementById('sessions-list');
  const count = document.getElementById('sess-count');
  if (!list) return;
  const r = await api('/api/auth/sessions');
  if (!r || !Array.isArray(r.sessions)) {
    list.innerHTML = '<div style="font-size:11px;color:var(--fg3)">Sign in to view sessions.</div>';
    if (count) count.textContent = '';
    return;
  }
  if (count) count.textContent = r.sessions.length ? `(${r.sessions.length})` : '';
  list.innerHTML = '';
  // Pending PIN rotation banner (approve here if the modal was dismissed)
  if (r.pending) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:8px;border:1px solid var(--amber, #e5a50a);border-radius:var(--radius);font-size:11px;margin-bottom:6px';
    const t = document.createElement('div');
    t.style.cssText = 'margin-bottom:6px';
    t.textContent = r.pending.mine
      ? 'Your PIN change is awaiting approval from another signed-in tab.'
      : `PIN change requested by ${r.pending.device || 'unknown device'} (${r.pending.ip || 'unknown IP'}).`;
    banner.appendChild(t);
    if (!r.pending.mine) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px';
      const ap = document.createElement('button');
      ap.className = 'btn btn-primary';
      ap.style.cssText = 'height:26px;padding:0 10px;font-size:11px;flex:1';
      ap.textContent = 'Approve';
      ap.onclick = () => approvePinChange();
      const ve = document.createElement('button');
      ve.className = 'btn btn-ghost';
      ve.style.cssText = 'height:26px;padding:0 10px;font-size:11px;flex:1';
      ve.textContent = 'Revert & kick';
      ve.onclick = () => vetoPinChange();
      row.appendChild(ap); row.appendChild(ve);
      banner.appendChild(row);
    }
    list.appendChild(banner);
  }
  if (!r.sessions.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--fg3)">No other sessions. This device only.</div>';
    return;
  }
  for (const s of r.sessions) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:11px';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    const title = document.createElement('div');
    title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    title.textContent = (s.device || 'Unknown device') + (s.current ? ' · this device' : '') + (s.status === 'pending' ? ' · awaiting approval' : '');
    const sub = document.createElement('div');
    sub.style.cssText = 'color:var(--fg3)';
    sub.textContent = `${s.ip || 'unknown IP'} · ${s.status === 'pending' ? 'requested ' + timeAgo(s.createdAt) : 'active ' + timeAgo(s.lastSeen || s.createdAt)}`;
    info.appendChild(title); info.appendChild(sub);
    row.appendChild(info);
    if (s.status === 'pending' && !s.current) {
      const ap = document.createElement('button');
      ap.className = 'btn btn-primary';
      ap.style.cssText = 'height:24px;padding:0 10px;font-size:11px;flex-shrink:0';
      ap.textContent = 'Approve';
      ap.setAttribute('aria-label', 'Approve session ' + (s.device || s.ip || ''));
      ap.onclick = () => approveSession(s.id);
      row.appendChild(ap);
      const dn = document.createElement('button');
      dn.className = 'btn btn-ghost';
      dn.style.cssText = 'height:24px;padding:0 10px;font-size:11px;flex-shrink:0';
      dn.textContent = 'Deny';
      dn.setAttribute('aria-label', 'Deny session ' + (s.device || s.ip || ''));
      dn.onclick = () => revokeSession(s.id);
      row.appendChild(dn);
    } else if (!s.current) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.style.cssText = 'height:24px;padding:0 10px;font-size:11px;flex-shrink:0';
      btn.textContent = 'Revoke';
      btn.setAttribute('aria-label', 'Revoke session ' + (s.device || s.ip || ''));
      btn.onclick = () => revokeSession(s.id);
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}
async function approveSession(id) {
  if (!id) return;
  const r = await api(`/api/auth/sessions/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  if (r && r.success) { toast('Device approved', 'success'); refreshSessions(); }
  else toast((r && r.error) || 'Approve failed', 'error');
}
async function revokeSession(id) {
  if (!id) return;
  const ok = await confirmDialog({ title: 'Revoke session?', message: 'That device will be signed out immediately.', okText: 'Revoke', danger: true });
  if (!ok) return;
  const r = await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (r && r.success) { toast('Session revoked', 'success'); refreshSessions(); }
  else toast((r && r.error) || 'Revoke failed', 'error');
}
async function revokeOtherSessions() {
  const r = await api('/api/auth/sessions');
  if (!r || !Array.isArray(r.sessions)) { toast('Could not list sessions', 'error'); return; }
  const others = r.sessions.filter(s => !s.current);
  if (!others.length) { toast('No other sessions', 'info'); return; }
  const ok = await confirmDialog({ title: 'Sign out others?', message: `End ${others.length} other session(s)? This device stays signed in.`, okText: 'Sign out others', danger: true });
  if (!ok) return;
  let done = 0;
  for (const s of others) {
    try { const dr = await api(`/api/auth/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); if (dr && dr.success) done++; } catch {}
  }
  toast(`Signed out ${done} session(s)`, 'success');
  refreshSessions();
}
async function approvePinChange() {
  setBtnBusy(document.getElementById('pin-save-btn'), true);
  try {
    const r = await api('/api/pin/approve', { method: 'POST' });
    if (r && r.success && r.token) {
      authToken = r.token;
      storeSessionToken(r.token);
      toast('PIN change approved and applied', 'success');
    } else {
      toast((r && r.error) || 'Approve failed', 'error');
    }
  } catch {
    toast('Approve failed', 'error');
  }
  setBtnBusy(document.getElementById('pin-save-btn'), false);
  try { refreshSessions(); } catch {}
}
async function vetoPinChange() {
  const ok = await confirmDialog({ title: 'Revert PIN change?', message: 'The requester will be signed out immediately.', okText: 'Revert & kick', danger: true });
  if (!ok) return;
  const r = await api('/api/pin/veto', { method: 'POST' });
  if (r && r.success) toast('PIN change reverted, requester kicked', 'success');
  else toast((r && r.error) || 'Revert failed', 'error');
  try { refreshSessions(); } catch {}
}

// ── Persistent security alerts (unreviewed logins) ──
// A toast vanishes; the header triangle stays until the logins are reviewed.
function getPendingAlerts() {
  try {
    const v = JSON.parse(safeStorage.getItem('wt-security-alerts'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function setPendingAlerts(a) {
  try { safeStorage.setItem('wt-security-alerts', JSON.stringify(a.slice(-20))); } catch {}
}
function renderSecurityAlert() {
  const btn = document.getElementById('security-alert-btn');
  const count = document.getElementById('security-alert-count');
  if (!btn) return;
  const n = getPendingAlerts().length;
  btn.style.display = n ? '' : 'none';
  if (count) {
    count.textContent = n > 1 ? String(n) : '';
    count.style.display = n > 1 ? '' : 'none';
  }
  btn.setAttribute('aria-label', n === 1 ? 'Security alert: 1 unreviewed login' : `Security alert: ${n} unreviewed logins`);
}
function addSecurityAlert(ev) {
  const list = getPendingAlerts();
  list.push({ ip: ev.ip || '', device: ev.device || '', at: ev.at || Date.now() });
  setPendingAlerts(list);
  renderSecurityAlert();
}
// The review step: open Security, refresh the list, clear the triangle.
function openSecurityReview() {
  setPendingAlerts([]);
  renderSecurityAlert();
  const panel = document.getElementById('settings-panel');
  if (!panel || !panel.classList.contains('open')) {
    if (typeof openSettings === 'function') openSettings();
    else return;
  }
  try { refreshSessions(); } catch {}
  // Expand the Security section even when collapsed, then scroll to it
  try {
    const sec = panel.querySelector('[data-sec="security"]');
    if (sec) {
      sec.classList.add('open');
      const h3 = sec.querySelector('h3');
      if (h3) h3.setAttribute('aria-expanded', 'true');
      try { safeStorage.setItem('wt-settings-sec-security', 'true'); } catch {}
      if (sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
    }
  } catch {}
}

let tunnelList = [];

async function restoreTunnels() {
  // The app may auto-pick a free port (3001+ when 3000 is taken), so default
  // the target input to the actual origin instead of the baked-in :3000.
  try {
    const tu = document.getElementById('tunnel-url');
    if (tu && (!tu.value || /localhost:3000\b/.test(tu.value))) tu.value = location.origin;
  } catch {}
  const r = await api('/api/tunnel');
  tunnelList = r.tunnels || [];
  renderTunnels();
}

function mkSvg(w, h, view, inner) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', w); s.setAttribute('height', h); s.setAttribute('viewBox', view);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.5');
  s.innerHTML = inner;
  return s;
}
function renderTunnels() {
  const list = document.getElementById('tunnel-list');
  list.innerHTML = '';
  if (tunnelList.length === 0) { list.style.display = 'none'; return; }
  list.style.display = 'block';
  tunnelList.forEach(t => {
    const row = document.createElement('div');
    row.className = 'tunnel-row';
    const label = document.createElement('div');
    label.className = 'tunnel-label';
    label.textContent = t.localUrl;
    row.appendChild(label);
    const inner = document.createElement('div');
    inner.className = 'tunnel-inner';
    const urlSpan = document.createElement('span');
    urlSpan.className = 'tunnel-url';
    urlSpan.textContent = t.tunnelUrl;
    urlSpan.title = t.tunnelUrl;
    inner.appendChild(urlSpan);
    const status = document.createElement('span');
    status.className = 'tunnel-status';
    // `dead` = the watchdog gave up after its retries, so the tunnel will not
    // come back on its own — distinct from a transient "Orphan".
    const isDead = t.dead === true;
    status.style.background = isDead ? 'var(--red)' : (t.alive ? 'var(--green)' : 'var(--yellow)');
    status.style.color = 'var(--bg)';
    status.textContent = isDead ? 'Dead' : (t.alive ? 'Live' : 'Orphan');
    status.title = isDead
      ? `cloudflared stopped and did not come back after ${t.restartAttempts || 0} restart attempts — recreate the tunnel`
      : (t.alive ? 'cloudflared is running' : 'cloudflared process not found');
    inner.appendChild(status);
    if (t.alive && t.targetAlive !== undefined) {
      const targetStatus = document.createElement('span');
      const ok = t.targetAlive;
      targetStatus.className = 'tunnel-target';
      targetStatus.style.background = ok ? 'var(--green)' : 'var(--red)';
      targetStatus.style.color = 'var(--bg)';
      targetStatus.style.opacity = '0.8';
      targetStatus.appendChild(mkSvg('9','9','0 0 24 24', ok
        ? '<polyline points="20 6 9 17 4 12"/>'
        : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'));
      targetStatus.title = ok ? `Target ${t.localUrl} is responding` : `Target ${t.localUrl} is not responding`;
      inner.appendChild(targetStatus);
    }
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn tunnel-btn';
    copyBtn.title = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy tunnel URL');
    copyBtn.appendChild(mkSvg('12','12','0 0 24 24','<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'));
    copyBtn.addEventListener('click', () => copyText(t.tunnelUrl));
    inner.appendChild(copyBtn);
    const openBtn = document.createElement('button');
    openBtn.className = 'icon-btn tunnel-btn';
    openBtn.title = 'Open in new tab';
    openBtn.setAttribute('aria-label', 'Open tunnel in new tab');
    openBtn.appendChild(mkSvg('12','12','0 0 24 24','<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'));
    openBtn.addEventListener('click', () => window.open(t.tunnelUrl, '_blank', 'noopener,noreferrer'));
    inner.appendChild(openBtn);
    const stopBtn = document.createElement('button');
    stopBtn.className = 'icon-btn tunnel-btn stop';
    stopBtn.title = 'Stop';
    stopBtn.setAttribute('aria-label', 'Stop tunnel');
    stopBtn.appendChild(mkSvg('12','12','0 0 24 24','<rect x="6" y="6" width="12" height="12" rx="1"/>'));
    stopBtn.addEventListener('click', () => stopTunnelById(t.id));
    inner.appendChild(stopBtn);
    row.appendChild(inner);
    list.appendChild(row);
  });
}

async function createTunnel() {
  const btn = document.getElementById('tunnel-create-btn');
  if (btn && btn.dataset.busy === 'true') return;
  const url = document.getElementById('tunnel-url').value.trim();
  if (!url) { showFieldError('tunnel-field-error', 'Enter a local URL'); return; }
  clearFieldError('tunnel-field-error');
  setBtnBusy(btn, true);
  document.getElementById('tunnel-status').textContent = 'Creating tunnel…';
  // First tunnel use may trigger a one-time cloudflared download on the
  // server (503 + downloading:true). Poll within the 30s api() cap.
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await api('/api/tunnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!r.downloading || attempt >= 23) break;
    document.getElementById('tunnel-status').textContent =
      'Downloading cloudflared (one-time setup)… retrying (' + (attempt + 1) + '/24)';
    await new Promise(res => setTimeout(res, 5000));
  }
  setBtnBusy(btn, false);
  if (r.success) {
    tunnelList.push({ id: r.id, tunnelUrl: r.url, localUrl: url, alive: true, createdAt: Date.now() });
    renderTunnels();
    if (r.warning) {
      document.getElementById('tunnel-status').textContent = r.warning;
      toast(r.warning, 'warning');
    } else {
      document.getElementById('tunnel-status').textContent = '';
      toast('Tunnel ready: ' + r.url, 'success');
    }
  } else {
    document.getElementById('tunnel-status').textContent = '';
    showFieldError('tunnel-field-error', r.error || 'Failed to create tunnel');
  }
}

async function stopTunnelById(id) {
  document.getElementById('tunnel-status').textContent = 'Stopping tunnel…';
  const r = await api('/api/tunnel', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  if (r.success) {
    tunnelList = tunnelList.filter(t => t.id !== id);
    renderTunnels();
    // Re-sync from the server: an auto-restart renames the id (new public
    // URL), so the list may hold rows the server no longer knows and vice
    // versa. The failed-stop 404 path is gone (DELETE is idempotent now),
    // this just clears anything else stale.
    try { await restoreTunnels(); } catch {}
    document.getElementById('tunnel-status').textContent = '';
    toast(r.alreadyGone ? 'Tunnel entry removed' : 'Tunnel stopped', 'info');
  } else {
    document.getElementById('tunnel-status').textContent = '';
    toast(r.error || 'Failed to stop tunnel', 'error');
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    toast('Copied', 'success');
  }).catch(() => {
    toast('Copy failed', 'error');
  });
}

function applyTheme(theme, save = true) {
  let resolved = theme;
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dracula' : 'light';
  }
  document.body.dataset.theme = resolved;
  document.documentElement.dataset.theme = resolved;
  settings.theme = theme;
  document.getElementById('s-theme').value = theme;
  tabs.forEach(t => { if (t.term) { t.term.options.theme = getXtermTheme(); t.term.options.selectionTheme = getXtermSelectionTheme(); } });
  const themeColor = getComputedStyle(document.body).getPropertyValue('--bg2').trim();
  document.querySelector('meta[name="theme-color"]').content = themeColor;
  if (save) saveSettings();
}

function applyFontSize(size) {
  size = Math.max(8, Math.min(32, Number(size) || 14));
  settings.fontSize = size;
  tabs.forEach(t => { if (t.term) { t.term.options.fontSize = size; fitTerm(t); } });
  saveSettings();
}

function applyScrollback(lines) {
  lines = Math.max(100, Math.min(50000, Number(lines) || 1000));
  settings.scrollback = lines;
  tabs.forEach(t => { if (t.term) t.term.options.scrollback = lines; });
  saveSettings();
}

function applyFont(font) {
  settings.font = font;
  tabs.forEach(t => { if (t.term) { t.term.options.fontFamily = font; fitTerm(t); } });
  saveSettings();
}

function applyCursor(style) {
  settings.cursor = style;
  tabs.forEach(t => { if (t.term) t.term.options.cursorStyle = style; });
  saveSettings();
}

// ═══════════════════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════════════════
let sidebarOpen = true;
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (window.innerWidth <= 768) {
    sb.classList.toggle('mobile-open');
    sb.classList.remove('hidden');
  } else {
    sidebarOpen = !sidebarOpen;
    if (!sidebarOpen) {
      sb._savedWidth = sb.style.width || '';
      sb.style.width = '';
    } else {
      sb.style.width = sb._savedWidth || '';
    }
    sb.classList.toggle('hidden', !sidebarOpen);
    sb.classList.remove('mobile-open');
    setTimeout(() => { const t = getActiveTab(); try { fitTerm(t); } catch(e) { console.warn(e); } }, 220);
  }
}

let moreMenuOpen = false;
function closeMoreMenu() {
  const menu = document.getElementById('more-menu');
  const btn = document.getElementById('more-btn');
  if (menu) menu.classList.remove('open');
  if (btn) btn.classList.remove('active');
  document.removeEventListener('click', closeMoreMenuOnClickOutside, true);
  moreMenuOpen = false;
}
function closeMoreMenuOnClickOutside(e) {
  const menu = document.getElementById('more-menu');
  const btn = document.getElementById('more-btn');
  if (menu && menu.contains(e.target)) return;
  if (btn && btn.contains(e.target)) return;
  closeMoreMenu();
}
function toggleMoreMenu() {
  if (moreMenuOpen) { closeMoreMenu(); return; }
  moreMenuOpen = true;
  const menu = document.getElementById('more-menu');
  const btn = document.getElementById('more-btn');
  if (menu) menu.classList.add('open');
  if (btn) btn.classList.add('active');
  setTimeout(() => {
    document.addEventListener('click', closeMoreMenuOnClickOutside, true);
    const first = menu && menu.querySelector('.mm-item');
    if (first) first.focus();
  }, 0);
}

function setupMoreMenuKeyboard() {
  const menu = document.getElementById('more-menu');
  if (!menu || menu.dataset._kbSetup) return;
  menu.dataset._kbSetup = '1';
  menu.querySelectorAll('.mm-item').forEach(el => { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1'); });
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('.mm-item')].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    let idx = items.indexOf(document.activeElement);
    switch (e.key) {
      case 'Escape': e.preventDefault(); closeMoreMenu(); return;
      case 'ArrowDown': idx = (idx + 1) % items.length; break;
      case 'ArrowUp': idx = (idx - 1 + items.length) % items.length; break;
      case 'Home': idx = 0; break;
      case 'End': idx = items.length - 1; break;
      case 'Tab': {
        const last = document.activeElement === items[items.length - 1];
        if (last && !e.shiftKey) { e.preventDefault(); closeMoreMenu(); return; }
        if (document.activeElement === items[0] && e.shiftKey) { e.preventDefault(); closeMoreMenu(); return; }
        return;
      }
      default: return;
    }
    e.preventDefault();
    if (idx >= 0 && items[idx]) items[idx].focus();
  });
}

function updateSidebarNarrowClass() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  sb.classList.toggle('narrow', sb.clientWidth < 220);
}

function setupSidebarResize() {
  const handle = document.querySelector('.sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;
  let isResizing = false;
  function startResize(e) {
    if (window.innerWidth <= 768) return;
    e.preventDefault();
    isResizing = true;
    sidebar.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('touchmove', doResize, { passive: false });
    document.addEventListener('touchend', stopResize);
  }
  function doResize(e) {
    if (!isResizing) return;
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    if (!clientX) return;
    const width = Math.max(150, Math.min(600, clientX));
    sidebar.style.width = width + 'px';
    document.documentElement.style.setProperty('--sidebar-w', width + 'px');
    updateSidebarNarrowClass();
    setTimeout(() => { const t = getActiveTab(); try { fitTerm(t); } catch(e) { console.warn(e); } }, 50);
  }
  function stopResize() {
    if (!isResizing) return;
    isResizing = false;
    sidebar.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', doResize);
    document.removeEventListener('mouseup', stopResize);
    document.removeEventListener('touchmove', doResize);
    document.removeEventListener('touchend', stopResize);
    try { safeStorage.setItem('wt-sidebar-width', String(sidebar.offsetWidth)); } catch(e) { console.warn(e); }
  }
  handle.addEventListener('mousedown', startResize);
  handle.addEventListener('touchstart', startResize, { passive: false });
}

function restoreSidebarWidth() {
  if (window.innerWidth <= 768) return;
  try {
    const savedW = safeStorage.getItem('wt-sidebar-width');
    if (savedW) {
      const w = Math.max(150, Math.min(600, parseInt(savedW)));
      if (w) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) {
          sidebar.style.width = w + 'px';
          document.documentElement.style.setProperty('--sidebar-w', w + 'px');
          updateSidebarNarrowClass();
        }
      }
    }
  } catch(e) { console.warn(e); }
}

// ═══════════════════════════════════════════════════════
// EDITOR RESIZE
// ═══════════════════════════════════════════════════════
function setupEditorResize() {
  const handle = document.getElementById('editor-resize-handle');
  if (!handle) return;
  let isResizing = false;
  let startPos = 0;
  let startSize = 0;

  function isHorizontal() {
    const area = document.getElementById('editor-split-area');
    return area && area.classList.contains('horizontal');
  }

  function startResize(e) {
    if (window.innerWidth <= 768) return;
    e.preventDefault();
    isResizing = true;
    const horiz = isHorizontal();
    startPos = horiz
      ? (e.clientX || (e.touches && e.touches[0].clientX))
      : (e.clientY || (e.touches && e.touches[0].clientY));
    startSize = parseInt(document.documentElement.style.getPropertyValue('--editor-size')) || (horiz ? 400 : 300);
    document.body.style.cursor = horiz ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('touchmove', doResize, { passive: false });
    document.addEventListener('touchend', stopResize);
  }

  function doResize(e) {
    if (!isResizing) return;
    const horiz = isHorizontal();
    const clientPos = horiz
      ? (e.clientX || (e.touches && e.touches[0].clientX))
      : (e.clientY || (e.touches && e.touches[0].clientY));
    if (!clientPos) return;
    const splitArea = document.getElementById('editor-split-area');
    if (!splitArea) return;
    const rect = splitArea.getBoundingClientRect();
    const available = horiz ? rect.width : rect.height;
    const newSize = Math.max(80, Math.min(available - 160, startSize + (startPos - clientPos)));
    document.documentElement.style.setProperty('--editor-size', newSize + 'px');
    requestAnimationFrame(() => {
      tabs.forEach(tab => { try { fitTerm(tab); } catch(e) { console.warn(e); } });
    });
  }

  function stopResize() {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', doResize);
    document.removeEventListener('mouseup', stopResize);
    document.removeEventListener('touchmove', doResize);
    document.removeEventListener('touchend', stopResize);
    try {
      const v = document.documentElement.style.getPropertyValue('--editor-size');
      if (v) {
        const key = isHorizontal() ? 'wt-editor-width' : 'wt-editor-height';
        safeStorage.setItem(key, v.replace('px', ''));
      }
    } catch(e) { console.warn(e); }
  }

  handle.addEventListener('mousedown', startResize);
  handle.addEventListener('touchstart', startResize, { passive: false });
}

function toggleEditorSplit() {
  const area = document.getElementById('editor-split-area');
  if (!area) return;
  const wasHorizontal = area.classList.contains('horizontal');
  area.classList.toggle('horizontal');
  const isHoriz = !wasHorizontal;

  // Update toggle button appearance
  const btn = document.getElementById('editor-split-toggle');
  if (btn) {
    btn.classList.toggle('horizontal', isHoriz);
    btn.classList.toggle('active', isHoriz);
    btn.title = isHoriz ? 'Switch to vertical split' : 'Switch to horizontal split';
    const svg = btn.querySelector('svg');
    if (svg) {
      if (isHoriz) {
        svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>';
      } else {
        svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/>';
      }
    }
  }

  // Update cursor on handle
  const handle = document.getElementById('editor-resize-handle');
  if (handle) handle.style.cursor = isHoriz ? 'col-resize' : 'row-resize';

  // Restore saved size for this orientation
  try {
    const key = isHoriz ? 'wt-editor-width' : 'wt-editor-height';
    const saved = safeStorage.getItem(key);
    if (saved) {
      document.documentElement.style.setProperty('--editor-size', saved + 'px');
    }
  } catch(e) { console.warn(e); }

  // Re-fit all terminals
  requestAnimationFrame(() => {
    tabs.forEach(tab => { try { fitTerm(tab); } catch(e) { console.warn(e); } });
  });

  // Persist orientation
  try { safeStorage.setItem('wt-editor-split-orientation', isHoriz ? 'horizontal' : 'vertical'); } catch(e) { console.warn(e); }
}

function toggleEditorFullscreen() {
  const view = document.getElementById('editor-view');
  if (!view || !view.classList.contains('open')) return;
  const isFS = view.classList.toggle('fullscreen');
  const btn = document.getElementById('editor-fullscreen-toggle');
  if (btn) {
    btn.setAttribute('aria-label', isFS ? 'Exit fullscreen' : 'Fullscreen');
    btn.title = isFS ? 'Exit fullscreen (Esc/F11)' : 'Fullscreen (F11)';
    btn.innerHTML = isFS
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 4"/><polyline points="20 10 14 10 14 20"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="10" y1="14" x2="3" y2="21"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  }
  if (isFS) {
    document.addEventListener('keydown', _fsEscHandler);
  } else {
    document.removeEventListener('keydown', _fsEscHandler);
    requestAnimationFrame(() => { tabs.forEach(t=>{try{fitTerm(t);}catch(e){console.warn(e);}}); if(editor) editor.refresh(); });
  }
  if (editor) setTimeout(()=>editor.refresh(), 80);
  // Keep sidebar visible — editor fullscreen now only covers terminal area (absolute inside #editor-split-area)
  requestAnimationFrame(() => { tabs.forEach(t=>{try{fitTerm(t);}catch(e){console.warn(e);}}); });
}
function _fsEscHandler(e) {
  if (e.key === 'Escape' || e.key === 'F11') {
    const v = document.getElementById('editor-view');
    if (v && v.classList.contains('fullscreen')) { e.preventDefault(); toggleEditorFullscreen(); }
  }
}

// Terminal fullscreen removed — per request, terminal fullscreen should not cover sidebar
// toggleTerminalFullscreen and _termFsEscHandler intentionally removed
const hasWakeLock = 'wakeLock' in navigator;

async function requestWakeLock() {
  if (!hasWakeLock) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch (err) {
    console.warn('Wake Lock error:', err);
    return false;
  }
}

async function toggleKeepAwake(enabled) {
  settings.keepAwake = enabled;
  saveSettings();
  if (enabled) {
    const ok = await requestWakeLock();
    if (!ok && !isElectron) {
      toast('Screen wake lock not supported or denied', 'error');
    } else if (!ok && isElectron) {
      toast('Wake lock not available in Electron', 'info');
    }
  } else {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
  }
  syncKeepAwakeUI();
}

function syncKeepAwakeUI() {
  const cb = document.getElementById('keep-awake-cb');
  if (cb) cb.checked = !!settings.keepAwake;
  const label = document.getElementById('keep-awake-toggle');
  if (label) label.title = settings.keepAwake ? 'Keep Screen Awake — ON (screen stays on)' : 'Keep Screen Awake';
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && settings.keepAwake && !wakeLock) {
    await requestWakeLock();
  }
});

function moveTabToEnd(fromId) {
  if (isNaN(fromId)) return;
  const fromIdx = tabs.findIndex(t => t.id === fromId);
  if (fromIdx === -1) return;
  const [moved] = tabs.splice(fromIdx, 1);
  tabs.push(moved);
  const bar = document.getElementById('tab-scroll');
  const anchor = document.getElementById('new-tab-btn');
  if (moved.el && moved.el.parentNode === bar) {
    if (anchor && anchor.parentElement === bar) bar.insertBefore(moved.el, anchor);
    else bar.appendChild(moved.el);
  }
  saveTabState();
}

function setupTabBarDnD() {
  const bar = document.getElementById('tab-bar');
  const btn = document.getElementById('new-tab-btn');
  if (!bar || !btn) return;
  let dragEnterCount = 0;
  function setOver(el, v) { if (v) el.classList.add('drag-over'); else el.classList.remove('drag-over'); }
  bar.addEventListener('dragenter', e => { e.preventDefault(); dragEnterCount++; setOver(bar, true); });
  bar.addEventListener('dragleave', e => { dragEnterCount--; if (dragEnterCount <= 0) { dragEnterCount = 0; setOver(bar, false); } });
  bar.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  bar.addEventListener('drop', e => {
    e.preventDefault(); dragEnterCount = 0; setOver(bar, false);
    const fromId = parseInt(e.dataTransfer.getData('text/plain'));
    moveTabToEnd(fromId);
  });
  btn.addEventListener('dragenter', () => setOver(btn, true));
  btn.addEventListener('dragleave', () => setOver(btn, false));
  btn.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  btn.addEventListener('drop', e => {
    e.preventDefault(); setOver(btn, false);
    const fromId = parseInt(e.dataTransfer.getData('text/plain'));
    moveTabToEnd(fromId);
  });
}

// ═══════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'p') { e.preventDefault(); openFinder(); }
    if (ctrl && e.key === 't') { e.preventDefault(); newTab(); }
    if (ctrl && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    if (ctrl && e.key === 'f') { e.preventDefault(); toggleSearch(); }
    if (ctrl && e.key === 'w') { e.preventDefault(); if (activeTabId) closeTab(e, activeTabId); }
    if (ctrl && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); cycleTab(1); }
    if (ctrl && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); cycleTab(-1); }
    if (ctrl && e.shiftKey && e.key === 'r') { e.preventDefault(); refreshPreview(); }
    if (e.key === 'F11' && document.getElementById('editor-view').classList.contains('open')) { e.preventDefault(); toggleEditorFullscreen(); }
    if (e.key === 'Escape') {
      const termMenu = document.getElementById('term-ctx-menu');
      if (termMenu && termMenu.style.display !== 'none') {
        hideTermCtxMenu();
        return;
      }
      if (document.getElementById('ctx-menu').classList.contains('open')) {
        document.getElementById('ctx-menu').classList.remove('open');
        return;
      }
      if (document.getElementById('search-bar').classList.contains('open')) closeSearch();
      if (document.getElementById('cmd-lib-panel').classList.contains('open')) toggleCmdLib();
      if (document.getElementById('settings-panel').classList.contains('open')) closeSettings();
      document.querySelectorAll('.overlay.open').forEach(el => {
        const id = el.id;
        if (id === 'sys-overlay') closeSystemStats();
        else if (id === 'finder-overlay') { clearTimeout(finderTimer); closeOverlay(id); }
        else if (id === 'newfolder-overlay' || id === 'newfile-overlay' || id === 'rename-overlay') closeOverlay(id);
        else if (id === 'image-viewer') closeImageViewer();
        else if (id === 'conflict-overlay') closeOverlay(id);
        else closeOverlay(id);
      });
    }
  });
}

function cycleTab(dir) {
  if (!tabs.length) return;
  const idx = tabs.findIndex(t => t.id === activeTabId);
  const next = tabs[(idx + dir + tabs.length) % tabs.length];
  activateTab(next.id);
}

// ═══════════════════════════════════════════════════════
// MOBILE KEYS
// ═══════════════════════════════════════════════════════
let termSelectMode = false;
let scrollMode = false;
let _scrollHandlers = [];

function toggleTermSelect() {
  termSelectMode = !termSelectMode;
  const btn = document.getElementById('sel-toggle-btn');
  if (btn) btn.classList.toggle('sel-mode', termSelectMode);
  document.getElementById('mkey-sel-row').style.display = termSelectMode ? 'flex' : 'none';
  const mk = document.getElementById('mobile-keys');
  if (mk) {
    if (termSelectMode) {
      mk.dataset.prevDisplay = mk.style.display;
      mk.style.display = 'none';
    } else {
      mk.style.display = mk.dataset.prevDisplay || '';
    }
  }

  const activeTab = getActiveTab();
  if (termSelectMode) {
    if (activeTab?.term) {
      activeTab.term.options.disableStdin = true;
      const ta = activeTab.textarea || activeTab.term.textarea || activeTab.term.element?.querySelector('.xterm-textarea, textarea');
      if (ta) ta.disabled = true;
    }
  } else {
    scrollMode = false;
    cleanupScrollHandlers();
    const scrollBtn = document.getElementById('sel-scroll-btn');
    if (scrollBtn) scrollBtn.classList.remove('active-mode');
    shiftLatch = false; altLatch = false; updateModifierButtons();
    if (activeTab?.term) {
      activeTab.term.options.disableStdin = false;
      const ta = activeTab.textarea || activeTab.term.textarea || activeTab.term.element?.querySelector('.xterm-textarea, textarea');
      if (ta) ta.disabled = false;
      activeTab.term.clearSelection();
    }
  }
}

function toggleScrollMode() {
  scrollMode = !scrollMode;
  const btn = document.getElementById('sel-scroll-btn');
  if (btn) btn.classList.toggle('active-mode', scrollMode);
  cleanupScrollHandlers();
  if (scrollMode) {
    tabs.forEach(t => {
      if (!t.term) return;
      const h = attachScrollHandler(t);
      if (h) _scrollHandlers.push(h);
    });
  }
}

function attachScrollHandler(tab) {
  const el = tab.wrapper;
  const term = tab.term;
  if (!el || !term) return null;
  let startY = 0, startX = 0;
  function onTouchStart(e) {
    if (e.touches.length > 1) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    const screen = term.element?.querySelector('.xterm-screen');
    if (screen) screen.style.pointerEvents = 'none';
  }
  function onTouchMove(e) {
    if (e.touches.length > 1) return;
    const dy = startY - e.touches[0].clientY;
    const dx = startX - e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 3) {
      e.preventDefault();
      const lines = Math.sign(dy) * Math.max(1, Math.ceil(Math.abs(dy) / 15));
      term.scrollLines(lines);
    }
  }
  function onTouchEnd() {
    const screen = term.element?.querySelector('.xterm-screen');
    if (screen) screen.style.pointerEvents = '';
  }
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  return { el, start: onTouchStart, move: onTouchMove, end: onTouchEnd };
}

function cleanupScrollHandlers() {
  _scrollHandlers.forEach(h => {
    h.el.removeEventListener('touchstart', h.start);
    h.el.removeEventListener('touchmove', h.move);
    h.el.removeEventListener('touchend', h.end);
    const screens = h.el.querySelectorAll('.xterm-screen');
    screens.forEach(s => s.style.pointerEvents = '');
  });
  _scrollHandlers = [];
}

function copyTermSelection() {
  const tab = getActiveTab();
  if (!tab?.term) return;
  const sel = tab.term.getSelection();
  if (sel) {
    navigator.clipboard.writeText(sel).then(() => {
      toast('Copied to clipboard', 'success');
    }).catch(() => {
      toast('Copy failed', 'error');
    });
    tab.term.clearSelection();
  } else {
    toast('No text selected', 'info');
  }
}

let _pasteInput = null;

function pasteToTerminal() {
  const doPaste = text => {
    if (!text) return;
    const tab = getActiveTab();
    if (tab?.ws && tab.ws.readyState === WebSocket.OPEN) {
      // Bracketed paste: wrap in escape sequences so the shell buffers the input.
      // sendWsInput() chunks on character boundaries, so multibyte UTF-8 is never split.
      const bracketed = '\x1b[200~' + text + '\x1b[201~';
      try { sendWsInput(tab.ws, bracketed); } catch {}
      tab.term?.focus();
      toast('Pasted to terminal', 'success');
    }
  };

  if (navigator.clipboard?.readText) {
    navigator.clipboard.readText().then(doPaste).catch(() => fallbackPaste(doPaste));
  } else {
    fallbackPaste(doPaste);
  }
}

function fallbackPaste(callback) {
  if (!_pasteInput) {
    _pasteInput = document.createElement('textarea');
    _pasteInput.id = 'fallback-paste-area';
    _pasteInput.name = 'paste-input';
    _pasteInput.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1';
    document.body.appendChild(_pasteInput);
    _pasteInput.addEventListener('paste', () => {
      setTimeout(() => {
        if (_pasteInput.value) {
          callback(_pasteInput.value);
          toast('Pasted to terminal', 'success');
        } else {
          toast('Paste failed — please use Ctrl+V', 'warning');
        }
        _pasteInput.value = '';
      }, 0);
    });
  }
  _pasteInput.value = '';
  _pasteInput.focus();
  try {
    const ok = document.execCommand('paste');
    if (!ok) toast('Paste failed — please use Ctrl+V', 'warning');
  } catch {
    toast('Paste not supported — use Ctrl+V', 'warning');
  }
}

function selectAllTerm() {
  const tab = getActiveTab();
  if (tab?.term) {
    let ta = tab.textarea || tab.term.textarea || tab.term.element?.querySelector('.xterm-textarea, textarea');
    let restore = null;
    if (ta?.disabled) { ta.disabled = false; restore = true; }
    tab.term.focus();
    tab.term.selectAll();
    if (restore && ta) ta.disabled = true;
    toast('All text selected', 'success');
  }
}

function selectTermLine() {
  const tab = getActiveTab();
  if (!tab?.term) return;
  const buf = tab.term.buffer.active;
  const cursorY = buf.baseY + buf.cursorY;
  tab.term.selectLines(cursorY, cursorY);
  toast('Line selected', 'success');
}

function termScrollUp() {
  const tab = getActiveTab();
  if (tab?.term) tab.term.scrollLines(-Math.floor((tab.term.rows || 10) / 2));
}

function termScrollDn() {
  const tab = getActiveTab();
  if (tab?.term) tab.term.scrollLines(Math.floor((tab.term.rows || 10) / 2));
}

function toggleCtrlRow() {
  const row = document.getElementById('mkey-ctrl-row');
  if (!row) return;
  const isOpen = row.style.display !== 'none';
  row.style.display = isOpen ? 'none' : 'flex';
  const btn = document.getElementById('ctrl-toggle-btn');
  if (btn) btn.style.background = isOpen ? '' : 'var(--accent)';
  shiftLatch = false; altLatch = false; updateModifierButtons();
}

let _viewportHandlerInstalled = false;
let _viewportDebounce = null;
function setupVisualViewport() {
  if (_viewportHandlerInstalled) return;
  _viewportHandlerInstalled = true;
  if (window.visualViewport) {
    const handler = () => {
      clearTimeout(_viewportDebounce);
      _viewportDebounce = setTimeout(() => {
        const vvH = window.visualViewport.height;
        const vvScale = window.visualViewport.scale || 1;
        // Samsung Internet: innerHeight resizes, not visualViewport. Use layout viewport height via window.innerHeight vs vvH
        // On iOS, keyboard shows as vvH < innerHeight. On Samsung, opposite. Take max diff and ignore when scaled (pinch zoom).
        if (vvScale !== 1) return; // ignore pinch-zoom (U61, U65)
        const diff = vvH - window.innerHeight;
        const absDiff = Math.abs(diff);
        // Fallback: visualViewport offsetTop > 10 means the visual viewport panned
        // up, which is how some Android builds report the keyboard.
        const offsetTop = window.visualViewport.offsetTop || 0;
        // Height the keyboard actually covers.
        //  iOS keeps the layout viewport and shrinks the visual one → innerHeight - vvH.
        //  Android/Samsung shrink innerHeight too → ≈0, and nothing needs compensating.
        // Using absDiff alone was wrong on the offsetTop path: it added a handful of
        // pixels of margin where hundreds of pixels were covered.
        const covered = Math.max(0, window.innerHeight - vvH - offsetTop);
        const isKeyboard = absDiff > 50 && diff < 0;
        const keyboardOpen = isKeyboard || offsetTop > 10 || covered > 50;
        // Never reserve more than 60% of the viewport — a bogus metric must not
        // collapse the terminal to nothing.
        const keyboardMargin = Math.min(covered, Math.round(window.innerHeight * 0.6));
        const mobileKeys = document.getElementById('mobile-keys');
        const selRow = document.getElementById('mkey-sel-row');
        const terminals = document.getElementById('terminals');
        if (!terminals) return;
        if (keyboardOpen) {
          terminals.style.marginBottom = keyboardMargin + 'px';
          if (mobileKeys) mobileKeys.style.display = 'none';
          const ctrlRow = document.getElementById('mkey-ctrl-row');
          if (ctrlRow && ctrlRow.style.display === 'flex') ctrlRow.dataset.wasOpen = '1';
          if (ctrlRow) ctrlRow.style.display = 'none';
          if (selRow && selRow.style.display === 'flex') selRow.dataset.wasOpen = '1';
          if (selRow) selRow.style.display = 'none';
        } else {
          terminals.style.marginBottom = '0';
          if (mobileKeys && window.innerWidth <= 768 && settings.mobilekeys !== false) {
            mobileKeys.style.display = 'flex';
          }
          if (window.innerWidth <= 768 && settings.mobilekeys !== false) {
            const ctrlRow = document.getElementById('mkey-ctrl-row');
            if (ctrlRow && ctrlRow.dataset.wasOpen === '1') {
              ctrlRow.style.display = 'flex';
              delete ctrlRow.dataset.wasOpen;
            }
          }
          if (selRow && window.innerWidth <= 768) {
            if (selRow.dataset.wasOpen === '1') {
              selRow.style.display = 'flex';
              delete selRow.dataset.wasOpen;
            } else {
              selRow.style.display = termSelectMode ? 'flex' : 'none';
            }
          }
        }
      }, 100);
    };
    window.visualViewport.addEventListener('resize', handler);
    window.visualViewport.addEventListener('scroll', handler);
    window._cleanups?.push(() => {
      window.visualViewport.removeEventListener('resize', handler);
      window.visualViewport.removeEventListener('scroll', handler);
    });
  }
}

function setupMobileKeys() {
  const mk = document.getElementById('mobile-keys');
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (settings.mobilekeys === undefined && isTouch) {
    settings.mobilekeys = true;
  }
  const show = window.innerWidth <= 768 && settings.mobilekeys;
  if (mk) mk.style.display = show ? 'flex' : 'none';
  const tc = document.getElementById('toast-container');
  if (tc) tc.classList.toggle('keys-hidden', !show);
  const ctrlRow = document.getElementById('mkey-ctrl-row');
  if (ctrlRow) ctrlRow.style.display = 'none';
  const ctrlBtn = document.getElementById('ctrl-toggle-btn');
  if (ctrlBtn) ctrlBtn.style.background = '';
  shiftLatch = false; altLatch = false; updateModifierButtons();
}

// ═══════════════════════════════════════════════════════
// DRAG & DROP
// ═══════════════════════════════════════════════════════
async function traverseDirectoryEntry(entry, pathPrefix = '', depth = 0) {
  if (depth > 20) return [];
  const files = [];
  if (entry.isFile) {
    try {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push({ file, path: pathPrefix + entry.name });
    } catch (e) { console.warn('Skipping file:', entry.name, e); }
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const entries = await new Promise((resolve, reject) => {
      const allEntries = [];
      function readAll() {
        dirReader.readEntries(results => {
          if (results.length) {
            allEntries.push(...results);
            readAll();
          } else {
            resolve(allEntries);
          }
        }, reject);
      }
      readAll();
    });
    for (const child of entries) {
      const childFiles = await traverseDirectoryEntry(child, pathPrefix + entry.name + '/', depth + 1);
      files.push(...childFiles);
    }
  }
  return files;
}

function setupDragDrop() {
  const overlay = document.getElementById('drop-overlay');
  let dragCnt = 0;

  function isFileDrag(e) {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  document.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragCnt++;
    overlay.classList.add('active');
  });
  document.addEventListener('dragleave', e => {
    if (!isFileDrag(e)) return;
    // Only hide when leaving the viewport (relatedTarget null) or overlay itself
    // Prevents nested dragenter/leave from child elements desyncing counter
    if (!e.relatedTarget || e.relatedTarget === document.documentElement || e.target === overlay) {
      dragCnt = 0;
      overlay.classList.remove('active');
    } else {
      dragCnt--;
      if (dragCnt <= 0) { dragCnt = 0; overlay.classList.remove('active'); }
    }
  });
  document.addEventListener('dragend', () => {
    dragCnt = 0;
    overlay.classList.remove('active');
  });
  window.addEventListener('blur', () => {
    dragCnt = 0;
    overlay.classList.remove('active');
  });
  document.addEventListener('dragover', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  });
  document.addEventListener('drop', async e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragCnt = 0;
    overlay.classList.remove('active');

    try {
      const items = Array.from(e.dataTransfer.items || []);
      if (items.length) {
        const filesToUpload = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry();
            if (entry) {
              try {
                const traversed = await traverseDirectoryEntry(entry);
                filesToUpload.push(...traversed);
              } catch(e) { console.warn(e); }
            } else {
              const file = item.getAsFile();
              if (file) filesToUpload.push({ file, path: file.name });
            }
          }
        }
        if (filesToUpload.length) {
          await uploadFileList(filesToUpload);
        }
      } else if (e.dataTransfer.files.length) {
        await uploadFileList(e.dataTransfer.files);
      }
    } catch (err) { toast('Upload failed', 'error'); }
  });
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
let lastFocusedElement = null;
let _focusTrapHandler = null;
function openShortcuts() {
  openOverlay('shortcuts-overlay');
  document.getElementById('shortcuts-overlay').querySelector('.btn').focus();
}
function openOverlay(id) {
  lastFocusedElement = document.activeElement;
  const overlay = document.getElementById(id);
  overlay.classList.add('open');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const titleEl = overlay.querySelector('h2');
  if (titleEl) {
    if (!titleEl.id) titleEl.id = id + '-title';
    overlay.setAttribute('aria-labelledby', titleEl.id);
  } else if (overlay.getAttribute('aria-label')) {
    overlay.removeAttribute('aria-labelledby');
  }
  const modal = overlay.querySelector('.modal, input, button');
  if (modal) setTimeout(() => modal.focus(), 50);
  installFocusTrap(overlay);
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel && settingsPanel.classList.contains('open')) closeSettings();
}
function closeOverlay(id) {
  const overlay = document.getElementById(id);
  overlay.classList.remove('open');
  removeFocusTrap();
  if (lastFocusedElement) {
    setTimeout(() => lastFocusedElement?.focus(), 50);
    lastFocusedElement = null;
  }
}
let _focusTrapContainer = null;
function installFocusTrap(container) {
  removeFocusTrap();
  _focusTrapContainer = container;
  _focusTrapHandler = e => {
    if (e.key !== 'Tab') return;
    const focusable = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  container.addEventListener('keydown', _focusTrapHandler);
}
function removeFocusTrap() {
  if (_focusTrapHandler && _focusTrapContainer) {
    _focusTrapContainer.removeEventListener('keydown', _focusTrapHandler);
    _focusTrapHandler = null;
    _focusTrapContainer = null;
  } else if (_focusTrapHandler) {
    document.removeEventListener('keydown', _focusTrapHandler);
    _focusTrapHandler = null;
  }
}

let _confirmState = null;
let _confirmQueue = [];
function confirmDialog({ title = 'Confirm', message = '', okText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    if (_confirmState) {
      // Queue second dialog until first settles (fixes race U51)
      _confirmQueue.push({ title, message, okText, cancelText, danger, resolve });
      return;
    }
    const ov = document.getElementById('confirm-overlay');
    if (!ov || !ov.parentNode) { resolve(false); return; }
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-msg');
  titleEl.textContent = title;
  msgEl.textContent = message;
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-labelledby', 'confirm-title');
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    okBtn.classList.toggle('btn-danger', !!danger);
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      _confirmState = null;
      ov.classList.remove('open');
      ov.removeEventListener('keydown', onKey);
      removeFocusTrap();
      if (lastFocusedElement) { setTimeout(() => lastFocusedElement?.focus(), 50); lastFocusedElement = null; }
      // Dequeue next pending dialog
      if (_confirmQueue.length) {
        const next = _confirmQueue.shift();
        setTimeout(() => confirmDialog(next).then(next.resolve), 80);
      }
    };
    const finish = val => { const cb = _confirmState && _confirmState.resolve; cleanup(); if (cb) cb(val); };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); finish(true); }
    };
    _confirmState = { resolve, cleanup };
    lastFocusedElement = document.activeElement;
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    ov.addEventListener('keydown', onKey);
    ov.classList.add('open');
    installFocusTrap(ov);
    setTimeout(() => okBtn.focus(), 50);
  });
}

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => {
    if (e.target !== o) return;
    if (o.id === 'sys-overlay') { closeSystemStats(); return; }
    if (o.id === 'finder-overlay') { clearTimeout(finderTimer); }
    if (o.id === 'confirm-overlay') return; // dismiss handled by confirmDialog only
    closeOverlay(o.id);
  });
});

function setBtnBusy(btn, busy) {
  if (!btn) return;
  if (busy) { btn.dataset.busy = 'true'; btn.classList.add('loading'); btn.disabled = true; btn.setAttribute('aria-busy','true'); }
  else { btn.dataset.busy = 'false'; btn.classList.remove('loading'); btn.disabled = false; btn.removeAttribute('aria-busy'); }
}

function showFieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg || ''; el.classList.toggle('show', !!msg); }
}
function clearFieldError(id) { showFieldError(id, ''); }

const TOAST_ICONS = {
  success: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  warning: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = (TOAST_ICONS[type] || '') + '<span></span>';
  el.querySelector('span').textContent = msg;
  const mk = document.getElementById('mobile-keys');
  if (mk && mk.style.display !== 'none' && window.getComputedStyle(mk).display !== 'none') {
    el.style.marginBottom = 'var(--mobilekey-h)';
  }
  const container = document.getElementById('toast-container');
  container.appendChild(el);
  while (container.children.length > 4) container.firstChild.remove();
  setTimeout(() => el.remove(), 3000);
  return el;
}

function updateConnStatus(connected) {
  const dot = document.getElementById('conn-status');
  if (dot) {
    dot.style.background = connected ? 'var(--green)' : 'var(--red)';
    dot.title = connected ? 'Connected' : 'Disconnected';
    dot.setAttribute('aria-label', connected ? 'Connected' : 'Disconnected');
  }
}

function setupSwipeGestures() {
  let touchStartX = 0, touchStartY = 0;
  document.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    if (touchStartX < 30 && dx > 50 && Math.abs(dy) < 100) {
      if (sidebar.classList.contains('hidden') || sidebar.style.transform) {
        toggleSidebar();
        touchStartX = 0;
      }
    }

    if (dx < -50 && Math.abs(dy) < 100) {
      const sRect = sidebar.getBoundingClientRect();
      if (sRect.left >= 0 && sRect.width > 100) {
        toggleSidebar();
        touchStartX = 0;
      }
    }
  }, { passive: true });
}

// Pull-to-refresh for file list
(function() {
  let pullStartY = 0;
  let pullOffset = 0;
  const fileListWrap = document.getElementById('file-list-wrap');
  const ptr = document.getElementById('ptr-indicator');
  if (fileListWrap && ptr) {
    fileListWrap.addEventListener('touchstart', e => {
      if (fileListWrap.scrollTop <= 0) {
        pullStartY = e.touches[0].clientY;
        pullOffset = 0;
        ptr.style.opacity = '0';
        ptr.classList.remove('release');
      }
    }, { passive: true });
    fileListWrap.addEventListener('touchmove', e => {
      if (pullStartY === 0) return;
      const dy = e.touches[0].clientY - pullStartY;
      if (dy > 0 && fileListWrap.scrollTop <= 0) {
        pullOffset = dy;
        const t = Math.min(dy * 0.4, 60);
        fileListWrap.style.transform = `translateY(${t}px)`;
        fileListWrap.style.transition = 'none';
        ptr.style.opacity = Math.min(1, dy / 40).toFixed(2);
        ptr.classList.toggle('release', pullOffset > 60);
      }
    }, { passive: true });
    fileListWrap.addEventListener('touchend', () => {
      if (pullOffset > 60) {
        ptr.classList.remove('release');
        refreshFiles();
      }
      fileListWrap.style.transition = 'transform 0.3s ease';
      fileListWrap.style.transform = '';
      ptr.style.opacity = '0';
      pullStartY = 0;
      pullOffset = 0;
      setTimeout(() => { fileListWrap.style.transition = ''; }, 300);
    }, { passive: true });
  }
})();

// Touch long-press → context menu via event delegation (avoids conflict with text selection)
function setupFileListTouch() {
  const list = document.getElementById('file-list');
  if (!list || list.dataset._touchSetup) return;
  list.dataset._touchSetup = '1';

  let longPressTimer = null;

  list.addEventListener('touchstart', e => {
    const item = e.target.closest('.file-item');
    if (!item || e.target.closest('.file-name, .file-meta')) return;

    const touch = e.touches[0];
    const file = {
      path: item.dataset.path,
      name: fileRowName(item, item.dataset.path),
      isDir: item.dataset.isDir === 'true' || !!item.querySelector('.file-dir'),
      ext: (() => { const m = item.dataset.path.match(/\.([^.]+)$/); return m ? '.' + m[1].toLowerCase() : ''; })()
    };
    if (!file.path) return;

    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      showCtxMenu({
        clientX: touch.clientX,
        clientY: touch.clientY,
        preventDefault() {}
      }, file);
    }, 500);
  }, { passive: false });

  list.addEventListener('touchmove', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { passive: true });

  list.addEventListener('touchend', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { passive: true });
}

function showPinScreen() {
  document.getElementById('app').style.display = 'none';
  document.getElementById('pin-screen').classList.remove('hidden');
  document.getElementById('pin-input').value = '';
  document.getElementById('pin-error').textContent = '';
  window._appUnlocked = false;
  // A docked file tab owns #editor-view: hand the panel back before the wrappers
  // are removed, or the panel (and every opener that finds it by id) is destroyed.
  if (_dockedFileTabId != null) { try { undockEditor(false); } catch {} }
  try { cleanupDocViewers(); } catch {}
  // Close all active WebSocket connections + tear down tab DOM/xterm and
  // backing server sessions, or re-login stacks duplicates on leaked nodes.
  tabs.forEach(t => {
    try { if (t.imgUrl) URL.revokeObjectURL(t.imgUrl); } catch {}
    try { clearTimeout(t.reconnectTimer); } catch {}
    try { cleanupWebSocket(t); } catch {}
    try { t.resizeObserver?.disconnect(); } catch {}
    try { t._webglAddon?.dispose(); } catch {}
    try { t._searchResultsSub?.dispose?.(); } catch {}
    try { t.term?.dispose(); } catch {}
    try { t.el?.remove(); } catch {}
    try { t.wrapper?.remove(); } catch {}
    if (t.sessionId) api(`/api/sessions/${t.sessionId}`, { method: 'DELETE' });
  });
  tabs = [];
  activeTabId = null;
}

// ═══════════════════════════════════════════════════════
// BOOKMARKS
// ═══════════════════════════════════════════════════════
function getBookmarks() {
  try { return JSON.parse(safeStorage.getItem('wt-bookmarks')) || []; } catch(e) { console.warn('Failed to parse bookmarks:', e); return []; }
}
function saveBookmarks(bm) { safeStorage.setItem('wt-bookmarks', JSON.stringify(bm)); renderBookmarks(); }

function renderBookmarks() {
  const list = document.getElementById('bookmarks-list');
  const inner = document.getElementById('bookmarks-inner');
  const header = document.getElementById('bookmarks-header');
  const bm = getBookmarks();
  document.getElementById('bm-count').textContent = bm.length ? String(bm.length) : '';
  inner.innerHTML = '';
  if (bm.length === 0) {
    list.classList.remove('open');
    bmHoverOpened = false;
    if (header) header.setAttribute('aria-expanded', 'false');
    return;
  }
  list.classList.toggle('open', bookmarksOpen);
  if (header) header.setAttribute('aria-expanded', String(bookmarksOpen));
  bm.forEach((b) => {
    const div = document.createElement('div');
    div.className = 'bookmark-item';
    div.setAttribute('tabindex', '0');
    div.setAttribute('role', 'button');
    div.setAttribute('aria-label', 'Open bookmark ' + b.name);
    const go = () => loadFiles(b.path);
    div.addEventListener('click', e => {
      if (e.target.closest('.bm-remove')) return;
      go();
    });
    div.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.bm-remove')) { e.preventDefault(); go(); }
    });
    const ico = document.createElement('span');
    ico.className = 'bm-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
    div.appendChild(ico);
    const tx = document.createElement('span');
    tx.className = 'bm-text';
    const bmName = document.createElement('span');
    bmName.className = 'bm-name';
    bmName.textContent = b.name;
    tx.appendChild(bmName);
    const bmPath = document.createElement('span');
    bmPath.className = 'bm-path';
    bmPath.textContent = b.path;
    tx.appendChild(bmPath);
    div.appendChild(tx);
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'bm-remove';
    rmBtn.setAttribute('aria-label', 'Remove bookmark ' + b.name);
    rmBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    rmBtn.title = 'Remove';
    rmBtn.addEventListener('click', e => {
      e.stopPropagation();
      const bm2 = getBookmarks();
      const idx = bm2.findIndex(x => x.path === b.path);
      if (idx !== -1) bm2.splice(idx, 1);
      saveBookmarks(bm2);
    });
    div.appendChild(rmBtn);
    inner.appendChild(div);
  });
}

function bookmarkCurrentDir() {
  const bm = getBookmarks();
  if (bm.some(b => b.path === currentPath)) { toast('Already bookmarked', 'info'); return; }
  const sep = currentPath.includes('\\') ? '\\' : '/';
  bm.push({ name: currentPath.split(sep).filter(Boolean).pop() || currentPath, path: currentPath });
  saveBookmarks(bm);
  toast('Bookmarked', 'success');
}

let bookmarksOpen = (() => { try { const v = safeStorage.getItem('wt-bm-open'); return v !== null ? v === 'true' : true; } catch(e) { console.warn('Failed to read bookmarksOpen:', e); return true; } })();
let bmHoverOpened = false; // true while the list is open via hover-peek (not pinned)
function applyBookmarksOpen() {
  document.getElementById('bookmarks-list').classList.toggle('open', bookmarksOpen);
  const header = document.getElementById('bookmarks-header');
  if (header) header.setAttribute('aria-expanded', String(bookmarksOpen));
  try { safeStorage.setItem('wt-bm-open', bookmarksOpen); } catch(e) { console.warn(e); }
}
function toggleBookmarks() {
  if (bmHoverOpened) {
    // Click while peeked: pin it open instead of closing
    bmHoverOpened = false;
    bookmarksOpen = true;
  } else {
    bookmarksOpen = !bookmarksOpen;
  }
  applyBookmarksOpen();
}
// Hover-peek: auto-open on hover intent, auto-close on leave.
// Click (or Enter/Space) while peeked pins it open.
let _bmHoverTimer = null;
(() => {
  const bmHeader = document.getElementById('bookmarks-header');
  const bmList = document.getElementById('bookmarks-list');
  if (!bmHeader || !bmList) return;
  const inBmRegion = (t) => !!(t && t.closest && t.closest('#bookmarks-header, #bookmarks-list'));
  bmHeader.addEventListener('mouseenter', () => {
    clearTimeout(_bmHoverTimer);
    if (bookmarksOpen) return;
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
    if (!getBookmarks().length) return;
    _bmHoverTimer = setTimeout(() => {
      if (!bookmarksOpen && getBookmarks().length) { toggleBookmarks(); bmHoverOpened = true; }
    }, 110);
  });
  bmHeader.addEventListener('mouseleave', () => clearTimeout(_bmHoverTimer));
  const maybePeekClose = (e) => {
    if (!bmHoverOpened) return;
    if (inBmRegion(e.relatedTarget)) return;
    bmHoverOpened = false;
    bookmarksOpen = false;
    applyBookmarksOpen();
  };
  bmHeader.addEventListener('mouseleave', maybePeekClose);
  bmList.addEventListener('mouseleave', maybePeekClose);
})();

// ═══════════════════════════════════════════════════════
// GIT MINI-PANEL
// ═══════════════════════════════════════════════════════
let gitRoot = null;
let gitRepo = false;
let gitUnsupported = false; // git binary missing on server — stop probing
let _gitReq = 0;
let _gitFetching = false;
let _gitPendingDir = null; // newest dir requested while a probe was in flight
let gitOpen = (() => { try { const v = safeStorage.getItem('wt-git-open'); return v !== null ? v === 'true' : true; } catch(e) { console.warn(e); return true; } })();
function toggleGitPanel() {
  gitOpen = !gitOpen;
  document.getElementById('git-panel').classList.toggle('open', gitOpen);
  try { safeStorage.setItem('wt-git-open', gitOpen); } catch(e) { console.warn(e); }
  if (gitOpen && gitRepo && gitRoot) refreshGitPanel(currentPath, true);
}
async function refreshGitPanel(dir, manual) {
  const section = document.getElementById('git-section');
  if (!section) return;
  if (typeof settings !== 'undefined' && settings.gitEnabled === false) { section.style.display = 'none'; return; }
  if (gitUnsupported || !dir) { if (gitUnsupported) section.style.display = 'none'; return; }
  // Skip background probes when the explorer is hidden; collapse overlaps
  const _sb = document.getElementById('sidebar');
  if (!manual && _sb && _sb.classList.contains('hidden')) return;
  if (_gitFetching && !manual) { _gitPendingDir = dir; return; }
  _gitFetching = true;
  try {
    await _refreshGitPanelInner(section, dir, manual);
    // Catch up on the newest dir requested while we were busy
    if (_gitPendingDir && _gitPendingDir !== dir) {
      const next = _gitPendingDir; _gitPendingDir = null;
      await _refreshGitPanelInner(section, next, false);
    } else {
      _gitPendingDir = null;
    }
  } finally {
    _gitFetching = false;
  }
}
async function _refreshGitPanelInner(section, dir, manual) {
  const myReq = ++_gitReq;
  let st;
  try {
    st = await api(`/api/git/status?path=${encodeURIComponent(dir)}`);
  } catch { return; }
  if (myReq !== _gitReq) return;
  if (!st || st.git === false) {
    gitUnsupported = true; section.style.display = 'none';
    if (manual) toast('git is not installed on the server', 'warning');
    return;
  }
  // Transient failure (rate limit, timeout, 500) — keep previous state.
  // Only an explicit isRepo:false means "not a repository".
  if (st.error) {
    if (manual) toast(st.error, 'warning');
    return;
  }
  if (!st.isRepo) {
    // Slim init affordance instead of hiding the section entirely
    gitRepo = false; gitRoot = null;
    section.style.display = '';
    document.getElementById('git-panel').style.display = 'none';
    document.getElementById('git-init-row').style.display = '';
    document.getElementById('git-count').textContent = '';
    document.getElementById('git-sync').textContent = '';
    return;
  }
  gitRepo = true; gitRoot = st.root;
  section.style.display = '';
  document.getElementById('git-panel').style.display = '';
  document.getElementById('git-init-row').style.display = 'none';
  document.getElementById('git-panel').classList.toggle('open', gitOpen);
  const sync = [];
  if (st.ahead > 0) sync.push('↑' + st.ahead);
  if (st.behind > 0) sync.push('↓' + st.behind);
  if (st.stashCount > 0) sync.push('stash ' + st.stashCount);
  document.getElementById('git-sync').textContent = sync.join(' ');
  if (st.upstream) document.getElementById('git-sync').title = 'upstream ' + st.upstream;
  else document.getElementById('git-sync').removeAttribute('title');
  const total = st.staged.length + st.unstaged.length + st.untracked.length + st.unmerged.length;
  renderGitCount(total, st.totalAdded, st.totalDeleted);
  if (!gitOpen) return; // collapsed: header numbers set, skip detail fetches
  renderGitFiles(st);
  try {
    const b = await api(`/api/git/branches?path=${encodeURIComponent(st.root)}`);
    if (myReq !== _gitReq) return;
    renderGitBranches((b && b.branches) || [], st);
  } catch {}
  refreshGitStash(myReq);
  refreshGitLog(myReq);
  refreshGitIdentity();
  refreshGitTags();
}
function renderGitBranches(branches, st) {
  const sel = document.getElementById('git-branch-sel');
  if (!sel) return;
  sel.innerHTML = '';
  const mk = (val, label, disabled) => {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    if (disabled) o.disabled = true;
    sel.appendChild(o);
  };
  if (st.detached) mk(st.branch.split(' ')[0] || 'HEAD', '⚠ ' + st.branch, true);
  for (const b of (branches || [])) mk(b.name, b.name + (b.upstream ? '' : ' (local)'));
  const cur = (branches || []).find(b => b.current);
  const want = cur ? cur.name : (st.detached ? sel.options[0].value : st.branch);
  sel.value = want;
  if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
  sel.title = 'Switch branch' + (st.upstream ? ' · upstream ' + st.upstream : '');
}
async function gitSwitchBranch(name) {
  if (!gitRoot || !name) return;
  const sel = document.getElementById('git-branch-sel');
  if (sel) sel.disabled = true;
  const r = await api('/api/git/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, branch: name }) });
  if (sel) sel.disabled = false;
  if (!r || r.error) { toast((r && r.error) || 'Switch failed', 'error'); refreshGitPanel(currentPath); return; }
  toast('On ' + r.branch, 'success');
  refreshGitPanel(currentPath);
}
function gitBranchNew() {
  document.getElementById('git-newbranch-row').style.display = 'flex';
  document.getElementById('git-branch-error').textContent = '';
  const inp = document.getElementById('git-newbranch-input');
  inp.value = '';
  setTimeout(() => inp.focus(), 50);
}
function gitBranchNewCancel() {
  document.getElementById('git-newbranch-row').style.display = 'none';
  document.getElementById('git-newbranch-input').value = '';
  document.getElementById('git-branch-error').textContent = '';
}
async function gitBranchCreate() {
  if (!gitRoot) return;
  const inp = document.getElementById('git-newbranch-input');
  const name = (inp.value || '').trim();
  if (!name) { showFieldError('git-branch-error', 'Enter a branch name'); inp.focus(); return; }
  clearFieldError('git-branch-error');
  const r = await api('/api/git/branch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name }) });
  if (!r || r.error) { showFieldError('git-branch-error', (r && r.error) || 'Create failed'); return; }
  gitBranchNewCancel();
  toast('Created + switched to ' + r.branch, 'success');
  refreshGitPanel(currentPath);
}
async function gitInit() {
  const r = await api('/api/git/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: currentPath }) });
  if (!r || r.error) { toast((r && r.error) || 'Init failed', 'error'); return; }
  toast(r.already ? 'Already a repository' : 'Repository created', 'success');
  gitUnsupported = false;
  refreshGitPanel(currentPath, true);
}
async function gitStash() {
  if (!gitRoot) return;
  const btn = document.getElementById('git-stash-btn');
  setBtnBusy(btn, true);
  const msg = (document.getElementById('git-msg').value || '').trim();
  const r = await api('/api/git/stash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, message: msg }) });
  setBtnBusy(btn, false);
  if (!r || r.error) { toast((r && r.error) || 'Stash failed', 'error'); return; }
  toast('Stashed', 'success');
  refreshGitPanel(currentPath);
}
async function gitStashPop(ref) {
  if (!gitRoot) return;
  const body = { path: gitRoot };
  if (ref) body.ref = ref;
  const r = await api('/api/git/stash/pop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r || r.error) { toast((r && r.error) || 'Pop failed', 'error'); return; }
  toast('Stash restored', 'success');
  refreshGitPanel(currentPath);
}
async function refreshGitStash(myReq) {
  const box = document.getElementById('git-stash-list');
  const cnt = document.getElementById('git-stash-count');
  if (!box || !gitRoot) return;
  const r = await api(`/api/git/stash?path=${encodeURIComponent(gitRoot)}`);
  if (myReq !== undefined && myReq !== _gitReq) return;
  const list = ((r && r.stashes) || []).slice(0, 10);
  box.innerHTML = '';
  cnt.textContent = list.length ? list.length + (list.length === 1 ? ' stash' : ' stashes') : '';
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'git-stash-item';
    d.title = s.ref || '';
    const m = document.createElement('span');
    m.className = 'git-stash-msg';
    m.textContent = s.message || s.ref || 'stash';
    d.appendChild(m);
    const b = document.createElement('button');
    b.textContent = 'Pop';
    b.title = 'Restore ' + (s.ref || 'stash');
    b.addEventListener('click', () => gitStashPop(s.ref));
    d.appendChild(b);
    box.appendChild(d);
  }
}
const gitAbs = (rel) => {
  const sep = gitRoot.includes('\\') ? '\\' : '/';
  return gitRoot.replace(/[\\/]+$/, '') + sep + String(rel || '').replace(/^[/\\]+/, '');
};
async function gitDiscardFile(rel) {
  if (!gitRoot) return;
  const ok = await confirmDialog({ title: 'Discard changes?', message: 'Revert "' + rel + '" to HEAD? Staged changes are kept.', okText: 'Discard', danger: true });
  if (!ok) return;
  const r = await api('/api/git/discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, files: [rel] }) });
  if (!r || r.error) { toast((r && r.error) || 'Discard failed', 'error'); return; }
  toast('Discarded ' + rel, 'success');
  refreshGitPanel(currentPath);
}
async function gitDeleteUntracked(rel) {
  if (!gitRoot) return;
  const ok = await confirmDialog({ title: 'Delete untracked?', message: '"' + rel + '" will be permanently deleted.', okText: 'Delete', danger: true });
  if (!ok) return;
  const r = await api(`/api/files?path=${encodeURIComponent(gitAbs(rel))}`, { method: 'DELETE' });
  if (!r || r.error) { toast((r && r.error) || 'Delete failed', 'error'); return; }
  toast('Deleted ' + rel, 'success');
  loadFiles(currentPath);
  refreshGitPanel(currentPath);
}
function gitViewUntracked(rel) {
  if (!gitRoot) return;
  const abs = gitAbs(rel);
  if (/[/\\]$/.test(rel)) loadFiles(abs);
  else openFileEditor(abs);
}
function gitStatsText(e) {
  if (e && e.binary) return null;
  if (e && typeof e.added === 'number' && typeof e.deleted === 'number') return { added: e.added, deleted: e.deleted };
  if (e && typeof e.added === 'number') return { added: e.added, deleted: 0 };
  return null;
}
function gitStatsEl(e, cls) {
  if (e && e.binary) {
    const b = document.createElement('span');
    b.className = 'git-stats-binary';
    b.textContent = 'binary';
    b.title = 'Binary file — line count unavailable';
    return b;
  }
  const s = gitStatsText(e);
  if (!s) {
    if (cls === 'untracked') {
      const n = document.createElement('span');
      n.className = 'git-stats-new';
      n.textContent = 'new';
      return n;
    }
    return null;
  }
  const w = document.createElement('span');
  w.className = 'git-stats';
  w.title = s.added + ' additions, ' + s.deleted + ' deletions';
  const a = document.createElement('span');
  a.className = 'git-add';
  a.textContent = '+' + s.added;
  w.appendChild(a);
  w.appendChild(document.createTextNode(' '));
  const d = document.createElement('span');
  d.className = 'git-del';
  d.textContent = '−' + s.deleted;
  w.appendChild(d);
  return w;
}
function gitGroupStats(list) {
  let a = 0, d = 0, known = false;
  for (const e of (list || [])) {
    if (e && e.binary) { known = true; continue; }
    if (e && typeof e.added === 'number') { a += e.added; known = true; }
    if (e && typeof e.deleted === 'number') { d += e.deleted; known = true; }
  }
  return known ? { added: a, deleted: d } : null;
}
function renderGitCount(total, added, deleted) {
  const el = document.getElementById('git-count');
  if (!el) return;
  el.innerHTML = '';
  if (!total) return;
  const n = document.createElement('span');
  n.textContent = total + (total === 1 ? ' file' : ' files');
  el.appendChild(n);
  if (typeof added === 'number' && typeof deleted === 'number' && (added > 0 || deleted > 0)) {
    const w = document.createElement('span');
    w.className = 'git-stats';
    w.title = added + ' additions, ' + deleted + ' deletions';
    const a = document.createElement('span');
    a.className = 'git-add';
    a.textContent = '+' + added;
    w.appendChild(a);
    w.appendChild(document.createTextNode(' '));
    const d = document.createElement('span');
    d.className = 'git-del';
    d.textContent = '−' + deleted;
    w.appendChild(d);
    el.appendChild(w);
    el.title = added + ' additions, ' + deleted + ' deletions';
  } else {
    el.removeAttribute('title');
  }
}
function gitFileRow(e, cls) {
  const row = document.createElement('div');
  row.className = 'git-file ' + cls;
  const xy = document.createElement('span');
  xy.className = 'git-xy';
  xy.textContent = cls === 'untracked' ? '?' : (((e.x || '') + (e.y || '')).trim() || '•');
  row.appendChild(xy);
  const nm = document.createElement('span');
  nm.className = 'git-name';
  nm.textContent = e.path;
  nm.title = e.path;
  row.appendChild(nm);
  const stats = gitStatsEl(e, cls);
  if (stats) row.appendChild(stats);
  const addBtn = (label, title, fn, danger) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    if (danger) b.classList.add('danger');
    b.addEventListener('click', ev => { ev.stopPropagation(); fn(b); });
    row.appendChild(b);
  };
  if (cls === 'staged') {
    addBtn('Unstage', 'git restore --staged', () => gitStageOp('unstage', [e.path]));
    addBtn('Diff', 'staged diff', () => openGitDiff(e.path, true));
    addBtn('Hunks', 'per-hunk unstage', b => toggleHunks(b, e.path, true));
  } else if (cls === 'unstaged') {
    addBtn('Stage', 'git add', () => gitStageOp('stage', [e.path]));
    addBtn('Diff', 'unstaged diff', () => openGitDiff(e.path, false));
    addBtn('Hunks', 'per-hunk stage', b => toggleHunks(b, e.path, false));
    addBtn('Discard', 'revert worktree to HEAD', () => gitDiscardFile(e.path), true);
  } else if (cls === 'untracked') {
    addBtn('Stage', 'git add', () => gitStageOp('stage', [e.path]));
    addBtn('View', 'open file', () => gitViewUntracked(e.path));
    addBtn('Delete', 'permanently delete', () => gitDeleteUntracked(e.path), true);
  } else if (cls === 'unmerged') {
    // Plain `git diff` is empty for unmerged paths — diff against HEAD instead
    addBtn('Diff', 'conflict diff vs HEAD', () => openGitDiff(e.path, false, true));
  }
  return row;
}
function renderGitFiles(st) {
  const box = document.getElementById('git-files');
  box.innerHTML = '';
  const groups = [
    ['Unmerged', st.unmerged, 'unmerged'],
    ['Staged', st.staged, 'staged'],
    ['Unstaged', st.unstaged, 'unstaged'],
    ['Untracked', st.untracked, 'untracked'],
  ];
  let any = false;
  for (const [label, list, cls] of groups) {
    if (!list || !list.length) continue;
    any = true;
    const h = document.createElement('div');
    h.className = 'git-group-label';
    h.textContent = label + ' (' + list.length + ')';
    const gs = gitGroupStats(list);
    if (gs && (gs.added > 0 || gs.deleted > 0)) {
      const w = document.createElement('span');
      w.className = 'git-stats';
      w.style.marginLeft = '6px';
      w.title = gs.added + ' additions, ' + gs.deleted + ' deletions';
      const a = document.createElement('span');
      a.className = 'git-add';
      a.textContent = '+' + gs.added;
      w.appendChild(a);
      w.appendChild(document.createTextNode(' '));
      const d = document.createElement('span');
      d.className = 'git-del';
      d.textContent = '−' + gs.deleted;
      w.appendChild(d);
      h.appendChild(w);
    }
    box.appendChild(h);
    for (const e of list) box.appendChild(gitFileRow(e, cls));
  }
  if (!any) {
    const d = document.createElement('div');
    d.className = 'git-empty';
    d.textContent = 'Working tree clean';
    box.appendChild(d);
  }
  const commitBtn = document.getElementById('git-commit-btn');
  const blocked = st.unmerged.length > 0;
  commitBtn.disabled = blocked;
  commitBtn.title = blocked ? 'Resolve conflicts first' : 'Commit staged changes';
}
async function gitStageOp(op, files) {
  if (!gitRoot) return;
  const r = await api(`/api/git/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, files }) });
  if (r && r.error) toast(r.error, 'error');
  refreshGitPanel(currentPath);
}
async function gitCommit() {
  if (!gitRoot) return;
  clearFieldError('git-msg-error');
  const input = document.getElementById('git-msg');
  const msg = (input.value || '').trim();
  if (!msg) { showFieldError('git-msg-error', 'Message required'); input.focus(); return; }
  const btn = document.getElementById('git-commit-btn');
  setBtnBusy(btn, true);
  const r = await api('/api/git/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, message: msg, all: document.getElementById('git-all-cb').checked }) });
  setBtnBusy(btn, false);
  if (!r || r.error) {
    const msg_ = (r && r.error) || 'Commit failed';
    if (gitIdentityError(msg_)) { refreshGitIdentity(true); toast('Set your author identity first', 'warning'); }
    else showFieldError('git-msg-error', msg_);
    return;
  }
  input.value = '';
  document.getElementById('git-all-cb').checked = false;
  toast('Committed' + (r.hash ? ' ' + r.hash : ''), 'success');
  refreshGitPanel(currentPath);
}
async function gitPushPull(op, extraBody) {
  if (!gitRoot) return;
  // Raw fetch with 90s timeout — api() caps at 30s, too short for big push/pull/fetch
  const btnId = op === 'push' ? 'git-push-btn' : op === 'pull' ? 'git-pull-btn' : 'git-fetch-btn';
  const btn = document.getElementById(btnId);
  setBtnBusy(btn, true);
  try {
    const body = { path: gitRoot, ...(extraBody || {}) };
    if (op === 'pull' && !body.mode) {
      const sel = document.getElementById('git-pull-mode');
      if (sel && ['merge', 'rebase', 'ff-only'].includes(sel.value)) body.mode = sel.value;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    const resp = await fetch(`/api/git/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pin-token': authToken }, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(t);
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j.error) {
      const msg = (j && j.error) || (op + ' failed');
      // First push on a branch without upstream: offer to set it (explicit consent)
      if (op === 'push' && !(extraBody && extraBody.upstream) && /upstream|set-upstream|no upstream/i.test(msg)) {
        const ok = await confirmDialog({ title: 'No upstream branch', message: 'This branch has no upstream. Push and set upstream to origin?', okText: 'Push + set upstream' });
        if (ok) { setBtnBusy(btn, false); gitPushPull('push', { upstream: true }); return; }
      }
      toast(msg, 'error');
    } else {
      const tail = (j.output || '').trim().split('\n').pop() || '';
      const label = op === 'push' ? 'Pushed' : op === 'pull' ? 'Pulled' : 'Fetched';
      toast(label + (tail ? ': ' + tail : ''), 'success');
    }
  } catch (e) {
    toast(op + ' failed: ' + e.message, 'error');
  }
  setBtnBusy(btn, false);
  refreshGitPanel(currentPath);
}
function gitPush() { gitPushPull('push'); }
function gitPull() { gitPushPull('pull'); }
function gitFetch() { gitPushPull('fetch'); }
function gitIdentityError(msg) {
  return /identity|user\.name|user\.email|Author identity|empty ident/i.test(msg || '');
}
async function refreshGitIdentity(force) {
  const row = document.getElementById('git-identity-row');
  if (!row || !gitRoot) return;
  const r = await api(`/api/git/identity?path=${encodeURIComponent(gitRoot)}`);
  const missing = !r || r.error || !r.name || !r.email;
  if (missing || force) {
    row.style.display = 'flex';
    if (r && !r.error) {
      const n = document.getElementById('git-id-name');
      const e = document.getElementById('git-id-email');
      if (n && !n.value && r.name) n.value = r.name;
      if (e && !e.value && r.email) e.value = r.email;
    }
  } else {
    row.style.display = 'none';
  }
}
async function gitSaveIdentity() {
  if (!gitRoot) return;
  clearFieldError('git-identity-error');
  const name = (document.getElementById('git-id-name').value || '').trim();
  const email = (document.getElementById('git-id-email').value || '').trim();
  if (!name || !email) { showFieldError('git-identity-error', 'Name and email are required'); return; }
  const r = await api('/api/git/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name, email }) });
  if (!r || r.error) { showFieldError('git-identity-error', (r && r.error) || 'Save failed'); return; }
  document.getElementById('git-identity-row').style.display = 'none';
  toast('Author identity saved', 'success');
}
async function gitAmend() {
  if (!gitRoot) return;
  clearFieldError('git-msg-error');
  const input = document.getElementById('git-msg');
  const msg = (input.value || '').trim();
  const ok = await confirmDialog({ title: 'Amend last commit?', message: msg ? 'Fold staged changes into HEAD with a new message?' : 'Fold staged changes into HEAD (keep the message)?', okText: 'Amend' });
  if (!ok) return;
  const btn = document.getElementById('git-amend-btn');
  setBtnBusy(btn, true);
  const r = await api('/api/git/amend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, message: msg }) });
  setBtnBusy(btn, false);
  if (!r || r.error) {
    const msg_ = (r && r.error) || 'Amend failed';
    if (gitIdentityError(msg_)) { refreshGitIdentity(true); toast('Set your author identity first', 'warning'); }
    else showFieldError('git-msg-error', msg_);
    return;
  }
  input.value = '';
  toast('Amended' + (r.hash ? ' ' + r.hash : ''), 'success');
  refreshGitPanel(currentPath);
}
async function gitReset() {
  if (!gitRoot) return;
  clearFieldError('git-reset-error');
  const mode = document.getElementById('git-reset-mode').value || 'mixed';
  const ref = (document.getElementById('git-reset-ref').value || '').trim() || 'HEAD';
  if (mode === 'hard') {
    const ok = await confirmDialog({ title: 'Hard reset?', message: 'Reset to "' + ref + '" and DISCARD all worktree + staged changes. This cannot be undone.', okText: 'Reset (hard)', danger: true });
    if (!ok) return;
  }
  const r = await api('/api/git/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, mode, ref }) });
  if (!r || r.error) { showFieldError('git-reset-error', (r && r.error) || 'Reset failed'); return; }
  toast('Reset (' + r.mode + ') to ' + r.hash, 'success');
  refreshGitPanel(currentPath);
}
async function refreshGitTags() {
  const box = document.getElementById('git-tags-list');
  if (!box || !gitRoot) return;
  const r = await api(`/api/git/tags?path=${encodeURIComponent(gitRoot)}`);
  box.innerHTML = '';
  const tags = ((r && r.tags) || []).slice(0, 10);
  for (const name of tags) {
    const d = document.createElement('div');
    d.className = 'git-tag-item';
    d.title = name;
    const n = document.createElement('span');
    n.className = 'git-tag-name';
    n.textContent = name;
    d.appendChild(n);
    const b = document.createElement('button');
    b.textContent = 'Delete';
    b.className = 'danger';
    b.title = 'Delete tag ' + name;
    b.addEventListener('click', () => gitUntag(name));
    d.appendChild(b);
    box.appendChild(d);
  }
}
async function gitTagCreate() {
  if (!gitRoot) return;
  clearFieldError('git-tag-error');
  const name = (document.getElementById('git-tag-input').value || '').trim();
  const msg = (document.getElementById('git-tag-msg').value || '').trim();
  if (!name) { showFieldError('git-tag-error', 'Enter a tag name'); return; }
  const r = await api('/api/git/tag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name, message: msg }) });
  if (!r || r.error) { showFieldError('git-tag-error', (r && r.error) || 'Tag failed'); return; }
  document.getElementById('git-tag-input').value = '';
  document.getElementById('git-tag-msg').value = '';
  toast('Tagged ' + r.name, 'success');
  refreshGitPanel(currentPath);
}
async function gitUntag(name) {
  if (!gitRoot || !name) return;
  const ok = await confirmDialog({ title: 'Delete tag?', message: 'Delete tag "' + name + '"? (The commits stay.)', okText: 'Delete', danger: true });
  if (!ok) return;
  const r = await api('/api/git/untag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name }) });
  if (!r || r.error) { toast((r && r.error) || 'Delete tag failed', 'error'); return; }
  toast('Deleted tag ' + name, 'success');
  refreshGitPanel(currentPath);
}
async function toggleHunks(btn, file, cached) {
  const row = btn.closest('.git-file');
  if (!row) return;
  const old = row.querySelector('.git-hunks');
  if (old) { old.remove(); btn.textContent = 'Hunks'; return; }
  btn.textContent = '…';
  const r = await api(`/api/git/hunks?path=${encodeURIComponent(gitRoot)}&file=${encodeURIComponent(file)}${cached ? '&cached=1' : ''}`);
  btn.textContent = 'Hunks';
  if (!r || r.error) { toast((r && r.error) || 'Hunks failed', 'error'); return; }
  if (!r.hunks || !r.hunks.length) { toast('No hunks', 'info'); return; }
  const wrap = document.createElement('div');
  wrap.className = 'git-hunks';
  r.hunks.forEach((h, i) => {
    const hd = document.createElement('div');
    hd.className = 'git-hunk';
    const hh = document.createElement('div');
    hh.className = 'git-hunk-head';
    hh.textContent = 'hunk ' + (i + 1) + ' · +' + (h.added || 0) + ' −' + (h.deleted || 0) + (h.truncated ? ' · (preview truncated)' : '');
    hd.appendChild(hh);
    const pre = document.createElement('pre');
    pre.className = 'git-hunk-body';
    for (const line of (h.lines || [])) {
      const s = document.createElement('span');
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) s.className = 'hh';
      else if (line[0] === '+') s.className = 'ha';
      else if (line[0] === '-') s.className = 'hd';
      s.textContent = line + '\n';
      pre.appendChild(s);
    }
    hd.appendChild(pre);
    const b = document.createElement('button');
    b.className = 'sidebar-action-btn';
    b.style.marginTop = '2px';
    b.textContent = cached ? 'Unstage hunk' : 'Stage hunk';
    // Send the header we rendered: indices shift as the tree changes, and an
    // index alone could stage a different hunk than the one clicked.
    b.addEventListener('click', () => hunkOp(file, h.index, cached, h.header));
    hd.appendChild(b);
    wrap.appendChild(hd);
  });
  row.appendChild(wrap);
}
async function hunkOp(file, index, cached, expected) {
  if (!gitRoot) return;
  const r = await api(cached ? '/api/git/unstage-hunk' : '/api/git/stage-hunk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, file, index, expected }) });
  if (!r || r.error) {
    toast((r && r.error) || 'Hunk failed', 'error');
    // The hunk moved or vanished — re-render the list so the buttons match disk.
    if (/refresh and retry/i.test((r && r.error) || '')) refreshGitPanel(currentPath);
    return;
  }
  toast(cached ? 'Hunk unstaged' : 'Hunk staged', 'success');
  refreshGitPanel(currentPath);
}
let gitLogFull = false;
async function refreshGitLog(myReq) {
  const box = document.getElementById('git-log');
  if (!box || !gitRoot) return;
  const n = gitLogFull ? 20 : 5;
  const r = await api(`/api/git/log?path=${encodeURIComponent(gitRoot)}&n=${n}`);
  if (myReq !== undefined && myReq !== _gitReq) return;
  box.innerHTML = '';
  const foot = document.getElementById('git-foot-row');
  if (foot) foot.querySelector('#git-log-more')?.remove();
  if (!r || !r.commits || !r.commits.length) { updateGitFootRow(); return; }
  for (const c of r.commits) {
    const d = document.createElement('div');
    d.className = 'git-log-item';
    d.title = (c.hash || '') + '\n' + (c.author || '') + ' • ' + (c.date || '') + '\nClick for details';
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    const open = () => openGitShow(c.hash);
    d.addEventListener('click', open);
    d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    const subj = document.createElement('span');
    subj.className = 'git-subject';
    const h = document.createElement('span');
    h.className = 'git-hash';
    h.textContent = c.short || '';
    subj.appendChild(h);
    subj.appendChild(document.createTextNode(c.subject || ''));
    d.appendChild(subj);
    const meta = document.createElement('span');
    meta.className = 'git-meta';
    meta.textContent = (c.author || '') + ' • ' + (c.date || '');
    d.appendChild(meta);
    box.appendChild(d);
  }
  if (!gitLogFull && r.commits.length >= 5) {
    const more = document.createElement('button');
    more.className = 'sidebar-action-btn';
    more.id = 'git-log-more';
    more.textContent = 'Show more';
    more.addEventListener('click', () => { gitLogFull = true; refreshGitLog(); });
    (document.getElementById('git-foot-row') || box).appendChild(more);
  }
  updateGitFootRow();
}
async function openGitShow(hash) {
  if (!gitRoot || !hash) return;
  const r = await api(`/api/git/show?path=${encodeURIComponent(gitRoot)}&ref=${encodeURIComponent(hash)}`);
  if (!r || r.error) { toast((r && r.error) || 'Show failed', 'error'); return; }
  const name = String(hash).slice(0, 7);
  const content = r.diff ? (r.truncated ? r.diff + '\n…(truncated at 200KB)' : r.diff) : '(empty commit)';
  openGitReadonly(name + ' (commit)  /  ' + gitRoot, content, r.binary ? 'binary commit' : 'read-only • git show');
}
async function openGitDiff(file, cached, head) {
  if (!gitRoot) return;
  const r = await api(`/api/git/diff?path=${encodeURIComponent(gitRoot)}&file=${encodeURIComponent(file)}${cached ? '&cached=1' : ''}${head ? '&head=1' : ''}`);
  if (!r || r.error) { toast((r && r.error) || 'Diff failed', 'error'); return; }
  const name = (String(file).split(/[\\/]/).pop() || file);
  const content = r.diff ? (r.truncated ? r.diff + '\n…(truncated at 200KB)' : r.diff) : '(no changes)';
  // Read-only diff in the editor tab (editorPath stays empty so Save is a no-op)
  openGitReadonly(name + (cached ? ' (staged diff)' : head ? ' (conflict diff)' : ' (diff)') + '  /  ' + gitRoot, content, r.binary ? 'binary file' : 'read-only • git diff');
}
function openGitReadonly(title, content, status) {
  cleanupDocViewers();
  editorPath = '';
  editorOriginalContent = content;
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  const cm = initCodeMirror();
  cm.setValue(content);
  cm.setOption('mode', 'text/plain');
  cm.setOption('readOnly', true);
  document.querySelector('.CodeMirror').style.display = '';
  cm.refresh();
  // Colorize diff lines (additions green, deletions red, hunks accent)
  try {
    const n = Math.min(cm.lineCount(), 10000);
    for (let i = 0; i < n; i++) {
      const t = cm.getLine(i) || '';
      if (t.startsWith('+++') || t.startsWith('---')) cm.addLineClass(i, 'background', 'diff-hunk');
      else if (t[0] === '+') cm.addLineClass(i, 'background', 'diff-add');
      else if (t[0] === '-') cm.addLineClass(i, 'background', 'diff-del');
      else if (t.startsWith('@@') || t.startsWith('diff --git')) cm.addLineClass(i, 'background', 'diff-hunk');
    }
  } catch {}
  updateEditorDirty();
  const preview = document.getElementById('editor-preview');
  preview.classList.remove('active');
  const previewIframe = document.getElementById('editor-preview-iframe');
  if (previewIframe) clearPreviewDoc(previewIframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; mdContent.innerHTML = ''; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('editor-filename').textContent = title;
  document.getElementById('editor-status').textContent = status;
  if (window.innerWidth > 768) document.getElementById('content').classList.add('editor-open');
  document.getElementById('editor-view').classList.add('open');
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
}
document.getElementById('git-msg').addEventListener('keydown', e => { if (e.key === 'Enter') gitCommit(); });
document.getElementById('git-newbranch-input').addEventListener('keydown', e => { if (e.key === 'Enter') gitBranchCreate(); });
document.getElementById('git-tag-input').addEventListener('keydown', e => { if (e.key === 'Enter') gitTagCreate(); });
document.getElementById('git-tag-msg').addEventListener('keydown', e => { if (e.key === 'Enter') gitTagCreate(); });
document.getElementById('git-id-email').addEventListener('keydown', e => { if (e.key === 'Enter') gitSaveIdentity(); });
document.getElementById('git-id-name').addEventListener('keydown', e => { if (e.key === 'Enter') gitSaveIdentity(); });
document.getElementById('git-reset-ref').addEventListener('keydown', e => { if (e.key === 'Enter') gitReset(); });

// ═══════════════════════════════════════════════════════
// FUZZY FINDER (Ctrl+P)
// ═══════════════════════════════════════════════════════
let finderTimer = null;
let finderIdx = -1;
let finderAbort = null;

function openFinder() {
  document.getElementById('finder-input').value = '';
  document.getElementById('finder-results').innerHTML = '';
  document.getElementById('finder-empty').textContent = 'Start typing to search files';
  finderIdx = -1;
  openOverlay('finder-overlay');
  setTimeout(() => document.getElementById('finder-input').focus(), 100);
}

function doFinderSearch() {
  clearTimeout(finderTimer);
  if (finderAbort) { finderAbort.abort(); finderAbort = null; }
  const q = document.getElementById('finder-input').value.trim();
  const results = document.getElementById('finder-results');
  const empty = document.getElementById('finder-empty');
  if (q.length < 2) { results.innerHTML = ''; empty.textContent = 'Type at least 2 characters'; return; }
  empty.textContent = 'Searching…';
  finderTimer = setTimeout(async () => {
    finderAbort = new AbortController();
    let data;
    try {
      data = await api(`/api/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(currentPath)}`, { signal: finderAbort.signal });
    } catch (err) {
      // api() rethrows DOMException('AbortError') for a superseded search
      // (normal while typing). Without this the rejection was unhandled and
      // finderAbort was never cleared.
      if (err && (err.name === 'AbortError' || err.aborted)) { finderAbort = null; return; }
      empty.textContent = 'Search failed';
      return;
    }
    if (finderAbort?.signal.aborted) return;
    finderAbort = null;
    results.innerHTML = '';
    if (!data.results || data.results.length === 0) { empty.textContent = 'No results found'; return; }
    empty.textContent = '';
    finderIdx = -1;
    data.results.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'finder-item';
      div.dataset.idx = i;
      const fiIcon = document.createElement('span');
      fiIcon.className = 'fi-icon';
      fiIcon.innerHTML = r.isDir ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      div.appendChild(fiIcon);
      const fiName = document.createElement('span');
      fiName.className = 'fi-name';
      fiName.textContent = r.name;
      div.appendChild(fiName);
      const fiDir = document.createElement('span');
      fiDir.className = 'fi-dir';
      fiDir.textContent = r.dir;
      div.appendChild(fiDir);
      div.addEventListener('click', () => {
        closeOverlay('finder-overlay');
        if (r.isDir) loadFiles(r.path);
        else openFileEditor(r.path);
      });
      div.addEventListener('mouseenter', () => { document.querySelectorAll('.finder-item.selected').forEach(el => el.classList.remove('selected')); div.classList.add('selected'); finderIdx = i; });
      results.appendChild(div);
    });
  }, 200);
}

function finderKeydown(e) {
  const items = document.querySelectorAll('.finder-item');
  if (e.key === 'ArrowDown') { e.preventDefault(); if (finderIdx < items.length - 1) { finderIdx++; items.forEach((el,i) => el.classList.toggle('selected', i === finderIdx)); if (items[finderIdx]) items[finderIdx].scrollIntoView({ block: 'nearest' }); } }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (finderIdx > 0) { finderIdx--; items.forEach((el,i) => el.classList.toggle('selected', i === finderIdx)); if (items[finderIdx]) items[finderIdx].scrollIntoView({ block: 'nearest' }); } }
  if (e.key === 'Enter' && finderIdx >= 0 && items[finderIdx]) { e.preventDefault(); items[finderIdx].click(); }
  if (e.key === 'Escape') closeOverlay('finder-overlay');
}

// ═══════════════════════════════════════════════════════
// COMMAND LIBRARY
// ═══════════════════════════════════════════════════════
// public/commands.js is deferred, so this global only exists after parsing.
// Read it lazily instead of snapshotting it at parse time (the snapshot would
// silently become an empty library).
const defaultCmds = () => (Array.isArray(window.DEFAULT_CMDS) ? window.DEFAULT_CMDS : []);

function getCmdLib() {
  try { return JSON.parse(safeStorage.getItem('wt-cmdlib')) || []; } catch(e) { return []; }
}
function saveCmdLib(cmds) {
  safeStorage.setItem('wt-cmdlib', JSON.stringify(cmds));
}

function toggleCmdLib() {
  const panel = document.getElementById('cmd-lib-panel');
  const isOpen = panel.classList.contains('open');
  // Only inert the terminals area (content), not sidebar (panel is on right side)
  const terms = document.getElementById('terminals');
  panel.classList.toggle('open');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', String(!isOpen));
  document.getElementById('cmd-lib-toggle').classList.toggle('active', !isOpen);
  document.getElementById('cmd-lib-toggle').setAttribute('aria-expanded', String(!isOpen));
  if (!isOpen) {
    loadHistMax();
    switchCmdTab('library');
    if (terms) terms.setAttribute('inert', '');
    installFocusTrap(panel);
    setTimeout(() => {
      document.addEventListener('click', closeCmdLibOnClickOutside, true);
      panel.querySelector('input, button')?.focus();
    }, 50);
  } else {
    if (terms) terms.removeAttribute('inert');
    removeFocusTrap();
    document.removeEventListener('click', closeCmdLibOnClickOutside, true);
  }
}

function closeCmdLibOnClickOutside(e) {
  const panel = document.getElementById('cmd-lib-panel');
  const btn = document.getElementById('cmd-lib-toggle');
  if (!panel.classList.contains('open')) {
    document.removeEventListener('click', closeCmdLibOnClickOutside, true);
    return;
  }
  if (panel.contains(e.target) || btn.contains(e.target)) return;
  toggleCmdLib();
  const terms = document.getElementById('terminals');
  if (terms) terms.removeAttribute('inert');
  removeFocusTrap();
}

function renderCmdLib(filter) {
  const list = document.getElementById('cmd-lib-list');
  const custom = getCmdLib();
  const q = (filter || document.getElementById('cmd-lib-search').value || '').toLowerCase();
  const all = defaultCmds().concat(custom.map(c => ({ ...c, custom: true })));
  const filtered = q ? all.filter(c => c.name.toLowerCase().includes(q) || c.cmd.toLowerCase().includes(q) || (c.cat || '').toLowerCase().includes(q)) : all;

  if (filtered.length === 0) {
    list.innerHTML = '<div id="cmd-lib-empty">No commands found</div>';
    return;
  }

  list.innerHTML = '';
  const cats = {};
  filtered.forEach(c => {
    const cat = c.cat || (c.custom ? 'My Commands' : 'Other');
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(c);
  });

  Object.keys(cats).forEach(cat => {
    const section = document.createElement('div');
    section.className = 'cmd-lib-section';
    const title = document.createElement('div');
    title.className = 'cmd-lib-section-title';
    title.textContent = cat;
    section.appendChild(title);

    cats[cat].forEach(c => {
      const item = document.createElement('div');
      item.className = 'cmd-lib-item';
      item.title = c.cmd;
      const name = document.createElement('span');
      name.className = 'cmd-lib-name';
      name.textContent = c.name;
      const cmd = document.createElement('span');
      cmd.className = 'cmd-lib-cmd';
      cmd.textContent = c.cmd;
      const runBtn = document.createElement('button');
      runBtn.className = 'cmd-lib-run';
    runBtn.title = 'Run in terminal';
    runBtn.setAttribute('aria-label', 'Run in terminal');
      runBtn.setAttribute('aria-label', 'Run in terminal');
      runBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>';
      runBtn.addEventListener('click', e => {
        e.stopPropagation();
        runCmdLib(c.cmd);
      });
      item.appendChild(name);
      item.appendChild(cmd);
      item.appendChild(runBtn);

      if (c.custom) {
        const delBtn = document.createElement('button');
        delBtn.className = 'cmd-lib-del';
        delBtn.title = 'Delete';
        delBtn.setAttribute('aria-label', 'Delete command');
        delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          deleteCustomCmd(c.name, c.cmd);
        });
        item.appendChild(delBtn);
      }

      item.addEventListener('click', () => {
        const tab = getActiveTab();
        if (!tab?.term) return;
        tab.term.focus();
        tab.term.paste(c.cmd);
        toggleCmdLib();
      });
      section.appendChild(item);
    });
    list.appendChild(section);
  });
}

function filterCmdLib() {
  renderCmdLib();
}

async function runCmdLib(cmd) {
  const tab = getActiveTab();
  if (!tab || !tab.ws || tab.ws.readyState !== WebSocket.OPEN) {
    toast('No active terminal', 'error');
    return;
  }
  // RCE guard: curl | bash requires confirmation (U91)
  const needsConfirm = defaultCmds().some(c => c.cmd === cmd && c.requiresConfirm) || /\bcurl\b.*\|\s*bash/.test(cmd);
  if (needsConfirm) {
    const ok = await confirmDialog({ title: 'Confirm run', message: `Run sensitive command?\n\n${cmd}`, okText: 'Run', cancelText: 'Cancel', danger: true });
    if (!ok) return;
  }
  const text = cmd + '\n';
  sendWsInput(tab.ws, text);
  tab.term?.focus();
  addToCmdHist(cmd);
  toast('Running: ' + cmd, 'info');
}

function addCustomCmd() {
  const nameInput = document.getElementById('cmd-lib-name-input');
  const cmdInput = document.getElementById('cmd-lib-cmd-input');
  const name = nameInput.value.trim();
  const cmd = cmdInput.value.trim();
  if (!cmd) { toast('Enter a command', 'error'); return; }
  const custom = getCmdLib();
  if (custom.some(c => c.name === name && c.cmd === cmd)) {
    toast('Command already exists', 'info');
    return;
  }
  custom.push({ name: name || cmd, cmd, cat: 'My Commands' });
  saveCmdLib(custom);
  nameInput.value = '';
  cmdInput.value = '';
  renderCmdLib();
  toast('Command added', 'success');
}

function deleteCustomCmd(name, cmd) {
  let custom = getCmdLib();
  custom = custom.filter(c => !(c.name === name && c.cmd === cmd));
  saveCmdLib(custom);
  renderCmdLib();
  toast('Command removed', 'info');
}

// ═══════════════════════════════════════════════════════
// COMMAND HISTORY (server-side storage)
// ═══════════════════════════════════════════════════════
let cmdHistMax = 50;
let _cmdHistCache = [];

function histHeaders() {
  return { 'Content-Type': 'application/json', 'x-pin-token': authToken || '' };
}
function histHeadersDelete() {
  return { 'x-pin-token': authToken || '' };
}
async function getCmdHist() {
  try {
    const r = await fetch('/api/history', { headers: histHeadersDelete() });
    if (!r.ok) return _cmdHistCache;
    const data = await r.json();
    _cmdHistCache = data.history || [];
    if (data.max) cmdHistMax = data.max;
    return _cmdHistCache;
  } catch { return _cmdHistCache; }
}
function loadHistMax() {
  getCmdHist().then(() => {
    const el = document.getElementById('cmd-hist-max');
    if (el) el.value = cmdHistMax;
  });
}
async function addToCmdHist(cmd) {
  if (!cmd || !cmd.trim()) return;
  // Strip all ANSI/VT escape sequences and control characters
  const clean = cmd
    .replace(/\x1b[^a-zA-Z0-9]*[a-zA-Z0-9~]/g, '')       // CSI: ESC [ ... final
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')    // OSC: ESC ] ... BEL/ST
    .replace(/\x1b[OPP][^\x40-\x7e]*[\x40-\x7e]/g, '')    // SS3/DCS: ESC O/P ... final
    .replace(/\x1b./g, '')                                   // Any other ESC sequence
    .replace(/[\x00-\x1f\x7f]/g, '')                        // All remaining control chars
    .replace(/^[>;\d\s]+(?=[a-zA-Z/\\~\-.])/, '')          // VT params before a real command char
    .replace(/^[>;\d\s]+$/, '')                              // Pure VT params, no command at all
    .trim();
  if (!clean) return;
  try {
    await fetch('/api/history', { method: 'POST', headers: histHeaders(), body: JSON.stringify({ cmd: clean, max: cmdHistMax }) });
    await getCmdHist();
  } catch {}
}
async function removeCmdHistItem(idx) {
  try {
    await fetch('/api/history/' + idx, { method: 'DELETE', headers: histHeadersDelete() });
    await getCmdHist();
    renderCmdHist();
  } catch {}
}
async function clearCmdHist() {
  try {
    await fetch('/api/history', { method: 'DELETE', headers: histHeadersDelete() });
    _cmdHistCache = [];
    renderCmdHist();
    toast('History cleared', 'info');
  } catch {}
}
async function updateHistMax(val) {
  cmdHistMax = Math.max(10, Math.min(500, val || 50));
  try {
    await fetch('/api/history', { method: 'POST', headers: histHeaders(), body: JSON.stringify({ cmd: '', max: cmdHistMax }) });
  } catch {}
}
function switchCmdTab(tab) {
  const libBtn = document.getElementById('cmd-tab-lib');
  const histBtn = document.getElementById('cmd-tab-hist');
  const libList = document.getElementById('cmd-lib-list');
  const histList = document.getElementById('cmd-hist-list');
  const histHeader = document.getElementById('cmd-hist-header');
  const footer = document.getElementById('cmd-lib-footer');
  const search = document.getElementById('cmd-lib-search');
  if (tab === 'library') {
    libBtn.classList.add('active'); libBtn.setAttribute('aria-selected','true');
    histBtn.classList.remove('active'); histBtn.setAttribute('aria-selected','false');
    libList.style.display = '';
    histList.style.display = 'none';
    histHeader.style.display = 'none';
    footer.style.display = '';
    search.placeholder = 'Filter commands…';
    search.oninput = () => filterCmdLib();
    filterCmdLib();
  } else {
    histBtn.classList.add('active'); histBtn.setAttribute('aria-selected','true');
    libBtn.classList.remove('active'); libBtn.setAttribute('aria-selected','false');
    histList.style.display = 'flex';
    histList.setAttribute('aria-live','polite');
    libList.style.display = 'none';
    histHeader.style.display = '';
    footer.style.display = 'none';
    search.placeholder = 'Filter history…';
    search.oninput = () => renderCmdHist();
    renderCmdHist();
  }
  search.value = '';
  search.focus();
}
async function renderCmdHist() {
  const list = document.getElementById('cmd-hist-list');
  const hist = await getCmdHist();
  const q = (document.getElementById('cmd-lib-search').value || '').toLowerCase();
  const filtered = q ? hist.filter(h => h.cmd.toLowerCase().includes(q)) : hist;

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = '<div id="cmd-hist-empty">No commands run yet</div>';
    return;
  }

  filtered.forEach((h, i) => {
    const realIdx = q ? hist.indexOf(h) : i;
    const item = document.createElement('div');
    item.className = 'cmd-hist-item';

    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'cmd-hist-cmd';
    cmdSpan.textContent = h.cmd;
    cmdSpan.title = h.cmd;
    item.appendChild(cmdSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'cmd-hist-time';
    const ago = Date.now() - h.time;
    timeSpan.textContent = ago < 60000 ? 'just now' : ago < 3600000 ? Math.floor(ago / 60000) + 'm ago' : ago < 86400000 ? Math.floor(ago / 3600000) + 'h ago' : new Date(h.time).toLocaleDateString();
    if (h.count > 1) timeSpan.textContent = '×' + h.count + ' ' + timeSpan.textContent;
    item.appendChild(timeSpan);

    const runBtn = document.createElement('button');
    runBtn.className = 'cmd-hist-run';
    runBtn.title = 'Run in terminal';
    runBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>';
    runBtn.addEventListener('click', e => { e.stopPropagation(); runCmdLib(h.cmd); });
    item.appendChild(runBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'cmd-hist-del';
    delBtn.title = 'Remove';
    delBtn.setAttribute('aria-label', 'Remove from history');
    delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    delBtn.addEventListener('click', e => { e.stopPropagation(); removeCmdHistItem(realIdx); });
    item.appendChild(delBtn);

    item.addEventListener('click', () => {
      const tab = getActiveTab();
      if (!tab?.term) return;
      tab.term.focus();
      tab.term.paste(h.cmd);
      toggleCmdLib();
    });
    list.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════
// SYSTEM STATS
// ═══════════════════════════════════════════════════════
let sysStatsTimer = null;

// ── Live header icon: twin CPU/MEM gauge (same idea as the coffee-cup count) ──
// Paints actual usage into #sys-ico-cpu / #sys-ico-mem: width = %, color =
// base (accent/cyan) ≤50%, yellow ≤80%, red above. Tooltip carries the numbers.
function paintSysIcon(cpuPct, memPct) {
  const cpu = document.getElementById('sys-ico-cpu');
  const mem = document.getElementById('sys-ico-mem');
  const btn = document.getElementById('system-stats-btn');
  if (!cpu || !mem || !btn) return;
  const W = 14.8; // max inner fill width of the gauge tracks
  const c = Math.max(0, Math.min(100, Number(cpuPct) || 0));
  const m = Math.max(0, Math.min(100, Number(memPct) || 0));
  cpu.setAttribute('width', (c / 100 * W).toFixed(1));
  mem.setAttribute('width', (m / 100 * W).toFixed(1));
  const col = (v, base) => v > 80 ? 'var(--red)' : v > 50 ? 'var(--yellow)' : base;
  cpu.style.fill = col(c, 'var(--accent)');
  mem.style.fill = col(m, 'var(--cyan)');
  btn.classList.toggle('sys-warn', (c > 50 && c <= 80) || (m > 50 && m <= 80));
  btn.classList.toggle('sys-hot', c > 80 || m > 80);
  const label = `System Stats — CPU ${Math.round(c)}% · MEM ${Math.round(m)}%`;
  btn.setAttribute('title', label);
  btn.setAttribute('aria-label', label);
}
function resetSysIcon() {
  const cpu = document.getElementById('sys-ico-cpu');
  const mem = document.getElementById('sys-ico-mem');
  const btn = document.getElementById('system-stats-btn');
  if (!cpu || !mem || !btn) return;
  cpu.setAttribute('width', 0);
  mem.setAttribute('width', 0);
  cpu.style.fill = 'var(--accent)';
  mem.style.fill = 'var(--cyan)';
  btn.classList.remove('sys-warn', 'sys-hot');
  btn.setAttribute('title', 'System Stats');
  btn.setAttribute('aria-label', 'System Stats');
}
// One shared /api/system memo. Three independent pollers (launchpad pulse, header
// sys icon, stats panel) each fired their own request on their own schedule, which
// is what made the backend shell out to df/ps/nvidia-smi repeatedly. The TTL matches
// the server-side cache window so both sides agree on what "fresh" means.
const SYS_STATS_TTL_MS = 2000;
let _sysStatsFetch = { at: 0, promise: null };
function fetchSystemStats(force) {
  const now = Date.now();
  if (!force && _sysStatsFetch.promise && now - _sysStatsFetch.at < SYS_STATS_TTL_MS) {
    return _sysStatsFetch.promise;
  }
  const p = api('/api/system').catch(() => null);
  _sysStatsFetch = { at: now, promise: p };
  return p;
}

async function updateSysIcon() {
  if (!window._appUnlocked || !authToken) return;
  if (typeof settings !== 'undefined' && settings.datasaver) return;
  if (document.hidden) return;
  try {
    const s = await fetchSystemStats();
    if (!s || !s.cpu || !s.memory) return;
    paintSysIcon(s.cpu.usage, s.memory.percent);
  } catch {}
}
let _sysIconTimer = null;
function startSysIconPulse() {
  stopSysIconPulse();
  try { updateSysIcon(); } catch {}
  _sysIconTimer = setInterval(() => { try { updateSysIcon(); } catch {} }, 10000);
}
function stopSysIconPulse() {
  if (_sysIconTimer) { clearInterval(_sysIconTimer); _sysIconTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && window._appUnlocked && !settings.datasaver) { try { updateSysIcon(); } catch {} }
});

function openSystemStats() {
  openOverlay('sys-overlay');
  document.getElementById('sys-loading').style.display = 'block';
  document.getElementById('sys-content').style.display = 'none';
  refreshSystemStats(true);
  clearInterval(sysStatsTimer);
  if (!settings.datasaver) {
    sysStatsTimer = setInterval(() => {
      if (document.hidden) return;
      refreshSystemStats(false);
    }, 5000);
    document.addEventListener('visibilitychange', _sysVisibilityHandler);
  }
}
function _sysVisibilityHandler() {
  if (document.hidden && sysStatsTimer) {
    // pause polling when hidden to save tunnel bandwidth (U93)
  }
}

function closeSystemStats() {
  clearInterval(sysStatsTimer);
  sysStatsTimer = null;
  document.removeEventListener('visibilitychange', _sysVisibilityHandler);
  closeOverlay('sys-overlay');
}

async function refreshSystemStats(showLoading) {
  if (settings.datasaver) return;
  if (showLoading) {
    document.getElementById('sys-loading').style.display = 'block';
    document.getElementById('sys-content').style.display = 'none';
  }
  // A manual open should not wait on the shared memo.
  const data = await fetchSystemStats(!!showLoading);
  if (showLoading) {
    document.getElementById('sys-loading').style.display = 'none';
    document.getElementById('sys-content').style.display = '';
  }
  if (!data || !data.cpu) { toast('Failed to load system stats', 'error'); return; }

  const fmtUptime = (s) => { const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return `${d}d ${h}h ${m}m`; };

  document.getElementById('sys-cpu-val').textContent = `${data.cpu.usage}%`;
  document.getElementById('sys-cpu-sub').textContent = `${data.cpu.count} cores · ${data.cpu.loadAvg[0].toFixed(2)} avg`;
  document.getElementById('sys-cpu-bar').style.width = Math.min(data.cpu.usage, 100) + '%';
  document.getElementById('sys-cpu-bar').className = 'sys-bar-fill' + (data.cpu.usage > 80 ? ' danger' : data.cpu.usage > 50 ? ' warn' : '');

  document.getElementById('sys-mem-val').textContent = `${data.memory.percent}%`;
  document.getElementById('sys-mem-sub').textContent = `${formatSize(data.memory.used)} / ${formatSize(data.memory.total)}`;
  document.getElementById('sys-mem-bar').style.width = Math.min(data.memory.percent, 100) + '%';
  document.getElementById('sys-mem-bar').className = 'sys-bar-fill' + (data.memory.percent > 80 ? ' danger' : data.memory.percent > 50 ? ' warn' : '');

  // Overlay already paid for this payload — mirror it onto the header gauge for free
  try { paintSysIcon(data.cpu.usage, data.memory.percent); } catch {}

  if (data.disk && data.disk.length > 0) {
    const d = data.disk[0];
    const pct = parseInt(d.usePercent) || 0;
    document.getElementById('sys-disk-val').textContent = d.usePercent;
    document.getElementById('sys-disk-sub').textContent = `${d.used} / ${d.size}`;
    document.getElementById('sys-disk-bar').style.width = Math.min(pct, 100) + '%';
    document.getElementById('sys-disk-bar').className = 'sys-bar-fill' + (pct > 80 ? ' danger' : pct > 50 ? ' warn' : '');
  }

  document.getElementById('sys-uptime-val').textContent = fmtUptime(data.uptime);
  document.getElementById('sys-uptime-sub').textContent = data.hostname + ' · ' + data.platform;

  const gpuContainer = document.getElementById('sys-gpu-container');
  gpuContainer.innerHTML = '';
  const gpuList = data.gpus || (data.gpu ? [data.gpu] : []);
  if (gpuList.length) {
    gpuList.forEach((g, i) => {
      const card = document.createElement('div');
      card.className = 'sys-card';
      const label = gpuList.length > 1 ? `GPU ${i + 1}` : 'GPU';
      let sub = '';
      if (g.memTotal > 0) sub += formatSize(g.memTotal * 1024 * 1024) + ' VRAM';
      else if (g.memTotal === 0 && g.driver !== 'lspci') sub += 'Shared memory';
      if (g.utilization != null) sub += (sub ? ' · ' : '') + g.utilization + '% util';
      if (g.temp) sub += (sub ? ' · ' : '') + g.temp + '°C';
      if (g.driver && g.driver !== 'nvidia' && g.driver !== 'macos' && g.driver !== 'lspci') sub += (sub ? ' · ' : '') + 'Driver: ' + g.driver;
      let barHtml = '';
      if (g.memTotal > 0 && g.memUsed) {
        const pct = Math.round((g.memUsed / g.memTotal) * 100);
        const cls = pct > 80 ? ' danger' : pct > 50 ? ' warn' : '';
        barHtml = `<div class="sys-bar"><div class="sys-bar-fill${cls}" style="width:${Math.min(pct, 100)}%"></div></div>`;
      }
      card.innerHTML = `<h3>${label}</h3><div class="sys-val">${escHtml(String(g.name || ''))}</div><div class="sys-sub">${escHtml(sub || 'No details available')}</div>${barHtml}`;
      gpuContainer.appendChild(card);
    });
  }

  const tbody = document.getElementById('sys-proc-body');
  tbody.innerHTML = '';
  if (data.processes) {
    data.processes.forEach(p => {
      const tr = document.createElement('tr');
      const addTd = (txt, extra) => { const td = document.createElement('td'); if (extra) td.style.cssText = extra; td.textContent = txt; tr.appendChild(td); };
      addTd(p.pid); addTd(p.user); addTd(p.cpu); addTd(p.mem);
      addTd(p.cmd, 'max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      const killTd = document.createElement('td');
      killTd.style.textAlign = 'center';
      const killBtn = document.createElement('button');
      killBtn.className = 'btn btn-danger';
      killBtn.style.cssText = 'height:22px;padding:0 8px;font-size:11px;min-width:36px';
      killBtn.textContent = 'Kill';
      killBtn.setAttribute('aria-label', 'Kill process ' + p.pid);
      killBtn.title = 'Kill PID ' + p.pid;
      killBtn.onclick = () => killProcess(p.pid, p.cmd);
      killTd.appendChild(killBtn);
      tr.appendChild(killTd);
      tbody.appendChild(tr);
    });
  }
}

async function killProcess(pid, cmd) {
  const display = cmd ? `${pid} (${cmd.split('/').pop().slice(0,30)})` : String(pid);
  const ok = await confirmDialog({ title: 'Kill process', message: `Kill process ${display}?\n\nThis will send SIGTERM (then SIGKILL).`, okText: 'Kill', cancelText: 'Cancel', danger: true });
  if (!ok) return;
  const r = await api('/api/system/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: Number(pid) }) });
  if (r && r.success) { toast('Killed ' + pid, 'success'); refreshSystemStats(false); }
  else toast(r && r.error ? r.error : 'Kill failed', 'error');
}

async function exitApp() {
  const ok = await confirmDialog({ title: 'Exit app?', message: 'This will stop the server and disconnect all sessions.', okText: 'Exit app', cancelText: 'Cancel', danger: true });
  if (!ok) return;
  // Electron: quit the whole app (window + server child process).
  if (isElectron && window.electronAPI && typeof window.electronAPI.exitApp === 'function') {
    try { await window.electronAPI.exitApp(); } catch { toast('Exit failed', 'error'); }
    return;
  }
  const btn = document.getElementById('exit-app-btn');
  setBtnBusy(btn, true);
  try {
    const r = await api('/api/system/shutdown', { method: 'POST' });
    if (r && r.success) toast('Shutting down…', 'success');
    else { toast((r && r.error) || 'Exit failed', 'error'); setBtnBusy(btn, false); }
  } catch {
    toast('Exit failed', 'error');
    setBtnBusy(btn, false);
  }
}

// ═══════════════════════════════════════════════════════
// PWA / SERVICE WORKER
// ═══════════════════════════════════════════════════════
let deferredPrompt = null;
let installBannerDismissed = false;
try { installBannerDismissed = safeStorage.getItem('wt-install-dismissed') === 'true'; } catch(e) { console.warn(e); }

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  setTimeout(() => {
    if (!installBannerDismissed) showInstallBanner(false);
  }, 3000);
});

if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  setTimeout(() => {
    if (!deferredPrompt && !installBannerDismissed) showInstallBanner(true);
  }, 5000);
}

function showInstallBanner(isIOS) {
  const el = document.getElementById('install-banner');
  if (!el || el.style.display === 'flex') return;
  if (isIOS) {
    el.querySelector('.install-msg').textContent = 'Tap Share → Add to Home Screen';
    el.querySelector('.btn-primary').style.display = 'none';
    el.querySelector('.btn-ghost').textContent = 'Dismiss';
  }
  const mk = document.getElementById('mobile-keys');
  if (mk && window.getComputedStyle(mk).display !== 'none') {
    el.style.bottom = 'calc(var(--mobilekey-h) + env(safe-area-inset-bottom, 0px))';
  } else {
    el.style.bottom = 'env(safe-area-inset-bottom, 0px)';
  }
  el.style.display = 'flex';
  document.getElementById('toast-container').classList.add('banner-visible');
}

function installPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
  document.getElementById('install-banner').style.display = 'none';
  document.getElementById('toast-container').classList.remove('banner-visible');
}

function dismissInstall() {
  document.getElementById('install-banner').style.display = 'none';
  document.getElementById('toast-container').classList.remove('banner-visible');
  try { safeStorage.setItem('wt-install-dismissed', 'true'); } catch(e) { console.warn(e); }
  installBannerDismissed = true;
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        if (reg.active && !navigator.serviceWorker.controller) {
          toast('Offline support ready', 'success');
        }
        // New worker found (e.g. after an app update): activate it in the
        // background and tell the user a reload applies it. No auto-reload —
        // this is a live terminal, a surprise refresh would interrupt work.
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Update downloaded — reload the page to apply it', 'info');
              try { reg.waiting?.postMessage('skipWaiting'); } catch {}
            }
          });
        });
      })
      .catch(err => console.warn('SW registration failed:', err));
  }
}

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════
// Wait for DOMContentLoaded: deferred scripts (public/commands.js, the CDN
// bundles) run before it, and waiting lets the whole document finish parsing
// and paint before the heavy init work starts.
function startApp() {
  init().catch(e => console.error('Init failed:', e));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp, { once: true });
else startApp();

// Set version in About section (authed — call only after unlock; api() injects the token)
let serverPort = 0; // real WebTun port — location.port lies behind a tunnel (empty → 443)
function webtunSelfPort() {
  return serverPort || Number(location.port) || (location.protocol === 'https:' ? 443 : 80);
}
function refreshVersion() {
  api('/api/version').then(d => {
    const el = document.getElementById('about-version');
    if (el && d && d.version) el.textContent = 'v' + d.version;
    if (d && Number.isInteger(d.port)) serverPort = d.port;
  }).catch(() => {});
}

// Warn before closing if there are unsaved changes or active terminals
window.addEventListener('beforeunload', e => {
  const editorOpen = document.getElementById('editor-view').classList.contains('open');
  const currentContent = editor ? editor.getValue() : '';
  const editorDirty = editorOpen && currentContent !== editorOriginalContent;
  const hasActiveSessions = tabs.some(t => t.ws && t.ws.readyState === WebSocket.OPEN);
  if (editorDirty || hasActiveSessions) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// WebTun frontend - settings.js (settings UI, theme, sidebar, splits, wake.)

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


function saveSetting(k, v) { settings[k] = v; saveSettings(); }

function applyScreensaverMin(v) {
  v = Math.max(1, Math.min(120, Math.round(+v) || 5));
  settings.screensaverMin = v;
  saveSettings();
  document.getElementById('s-screensaver-min').value = v;
  // Only arm the idle countdown when the master screensaver toggle is on —
  // editing the duration with it off must not start the timer.
  if (settings.screensaver) {
    pokeScreensaver();
  }
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
        if (!ok) { settings.autostart = false; syncToggle('autostart'); saveSettings(); }
      }).catch(() => { settings.autostart = false; syncToggle('autostart'); saveSettings(); });
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
// excluded because these panels are its children. #header stays interactive
// so the Settings toggle remains clickable while the panel is open (inert
// subtrees swallow event targets and corrupt the outside-click dismiss).
const BACKDROP_INERT_IDS = ['sidebar', 'content'];
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
  // One right-side drawer at a time — the notification center yields to settings.
  try { closeNotifPanel(); } catch {}
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
  const btn = document.getElementById('settings-btn') || document.querySelector('[onclick="openSettings()"]');
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
  system: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
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
// Pre-search expansion snapshot: filterSettings adds .open while matching,
// so clearing must restore the exact prior states (not just persisted ones,
// which miss hover-peeks).
let _preSearchSectionStates = new Map();
function filterSettings(q) {
  q = (q || '').trim().toLowerCase();
  const secs = [...document.querySelectorAll('#settings-panel .settings-section')];
  if (q && _preSearchSectionStates.size === 0) {
    secs.forEach(s => _preSearchSectionStates.set(s, s.classList.contains('open')));
  }
  let anyVisible = false;
  secs.forEach(sec => {
    const h3 = sec.querySelector('h3');
    if (!q) {
      sec.style.display = '';
      const inner = sec.querySelector('.settings-section-inner');
      const kids = inner ? [...inner.children] : [...sec.children].filter(el => el.tagName !== 'H3');
      kids.forEach(ch => ch.style.display = '');
      if (_preSearchSectionStates.has(sec)) {
        sec.classList.toggle('open', _preSearchSectionStates.get(sec));
        if (h3) h3.setAttribute('aria-expanded', String(_preSearchSectionStates.get(sec)));
      } else if (sec._secApply) sec._secApply();
      anyVisible = true;
      return;
    }
    const titleHit = h3 && h3.textContent.toLowerCase().includes(q);
    const inner = sec.querySelector('.settings-section-inner');
    const kids = inner ? [...inner.children] : [...sec.querySelectorAll(':scope > div:not(.settings-section-body)')];
    let show = !!titleHit;
    kids.forEach(ch => {
      const text = (ch.textContent || '').toLowerCase();
      const kw = ((ch.dataset && ch.dataset.keywords) || '').toLowerCase();
      const hit = !!titleHit || text.includes(q) || (!!kw && kw.split(/\s+/).some(w => w && q.includes(w) || w.includes(q)));
      ch.style.display = hit ? '' : 'none';
      if (hit) show = true;
    });
    if (show) { sec.style.display = ''; sec.classList.add('open'); if (h3) h3.setAttribute('aria-expanded', 'true'); anyVisible = true; }
    else sec.style.display = 'none';
  });
  if (!q) _preSearchSectionStates.clear();
  document.getElementById('settings-no-match').style.display = anyVisible ? 'none' : '';
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
  // Clamped value written back so the input never shows an unvalidated number.
  try {
    const el = document.getElementById('s-fontsize');
    if (el && document.activeElement !== el) el.value = String(size);
  } catch {}
  tabs.forEach(t => { if (t.term) { t.term.options.fontSize = size; fitTerm(t); } });
  saveSettings();
}

function applyScrollback(lines) {
  lines = Math.max(100, Math.min(50000, Number(lines) || 1000));
  settings.scrollback = lines;
  try {
    const el = document.getElementById('s-scrollback');
    if (el && document.activeElement !== el) el.value = String(lines);
  } catch {}
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
// Single source of truth for collapsed state across mobile/desktop, persisted
// so a resize between breakpoints can't desync the toggle.
let sidebarOpen = (() => { try { const v = safeStorage.getItem('wt-sidebar-collapsed'); if (v !== null) return v !== 'true'; } catch {} try { return window.innerWidth > 768; } catch { return true; } })();
function applySidebarState() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    sb.classList.remove('hidden');
    sb.classList.toggle('mobile-open', sidebarOpen);
  } else {
    sb.classList.remove('mobile-open');
    sb.classList.toggle('hidden', !sidebarOpen);
  }
  try { safeStorage.setItem('wt-sidebar-collapsed', String(!sidebarOpen)); } catch {}
}
let _sidebarResizeWired = false;
function wireSidebarResizeSync() {
  if (_sidebarResizeWired) return;
  _sidebarResizeWired = true;
  let _sbResizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(_sbResizeT);
    _sbResizeT = setTimeout(() => { try { applySidebarState(); } catch {} }, 120);
  });
}
wireSidebarResizeSync();
// Honor a persisted collapsed state on boot without forcing mobile open.
try { if (safeStorage.getItem('wt-sidebar-collapsed') === 'true') applySidebarState(); } catch {}
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  sidebarOpen = !sidebarOpen;
  if (!sb) { try { safeStorage.setItem('wt-sidebar-collapsed', String(!sidebarOpen)); } catch {} return; }
  if (window.innerWidth <= 768) {
    applySidebarState();
  } else {
    if (!sidebarOpen) {
      sb._savedWidth = sb.style.width || '';
      sb.style.width = '';
    } else {
      sb.style.width = sb._savedWidth || '';
    }
    applySidebarState();
    setTimeout(() => { const t = typeof getActiveTab === 'function' ? getActiveTab() : null; try { fitTerm(t); } catch(e) { console.warn(e); } }, 220);
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
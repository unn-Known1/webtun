// WebTun frontend - ui.js (2/15: toasts, overlays, dialogs, shared UI helpers).

function hideTermLoading(tab) {
  if (tab && tab.loadingEl) tab.loadingEl.classList.add('hidden');
}
function updateEditorDirty() {
  const el = document.getElementById('editor-view');
  if (!el) return;
  const currentContent = editor ? editor.getValue() : document.getElementById('editor-textarea').value;
  el.classList.toggle('editor-dirty', currentContent !== editorOriginalContent);
}
async function resetSettings() {
  const ok = await confirmDialog({ title: 'Reset settings', message: 'Reset all settings to defaults?', okText: 'Reset', danger: true });
  if (!ok) return;
  const wasDatasaver = !!settings.datasaver;
  const wasAwake = !!settings.keepAwake;
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  // Side-effects the plain assignment skips: stop/start the stats pulse and
  // release the wake lock, or they leak in their pre-reset state.
  try {
    if (wasDatasaver !== !!settings.datasaver) {
      // toggleSetting() flips the flag, so run the two branches directly.
      if (settings.datasaver) {
        if (typeof sysStatsTimer !== 'undefined' && sysStatsTimer) { clearInterval(sysStatsTimer); sysStatsTimer = null; }
        try { stopSysIconPulse(); resetSysIcon(); } catch {}
      } else {
        try { startSysIconPulse(); } catch {}
      }
    }
    if (wasAwake && !settings.keepAwake) {
      try { if (typeof releaseWakeLock === 'function') releaseWakeLock(); } catch {}
    }
  } catch {}
  document.getElementById('s-theme').value = settings.theme;
  document.getElementById('s-fontsize').value = settings.fontSize;
  document.getElementById('s-scrollback').value = settings.scrollback;
  document.getElementById('s-font').value = settings.font;
  document.getElementById('s-cursor').value = settings.cursor;
  document.getElementById('s-screensaver-min').value = settings.screensaverMin;
  syncToggle('blink'); syncToggle('bell'); syncToggle('clipboardRead'); syncToggle('passCtrlK'); syncToggle('mobilekeys'); syncToggle('confirmclose'); syncToggle('datasaver'); syncToggle('termRightClick'); syncToggle('screensaver'); syncToggle('gitEnabled'); syncToggle('gitSimple'); syncToggle('sshEnabled'); syncToggle('autostart');
  try { if (typeof applySshEnabled === 'function') applySshEnabled(); } catch {}
  try { if (typeof syncSshEnabledToServer === 'function') syncSshEnabledToServer(); } catch {}
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
  if (typeof applyMobileKeyBarState === 'function') applyMobileKeyBarState();
  try { if (typeof applyGitEnabled === 'function') applyGitEnabled(); } catch {}
  try { if (typeof applyGitSimple === 'function') applyGitSimple(); } catch {}
  toast('Settings reset', 'success');
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
  if (!overlay) return;
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
  // Confirm + shortcuts dialogs stack over the Settings panel (e.g. PIN
  // removal) — closing it underneath loses the updated PIN status/fields.
  if (id !== 'confirm-overlay' && id !== 'shortcuts-overlay') {
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel && settingsPanel.classList.contains('open')) closeSettings();
  }
}
function closeOverlay(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove('open');
  if (id === 'ssh-overlay' && typeof dismissSshOnce === 'function') {
    try { dismissSshOnce(); } catch {}
  }
  removeFocusTrap();
  // Capture before nulling: the timeout fires after this function returns.
  const lf = lastFocusedElement;
  lastFocusedElement = null;
  if (lf) setTimeout(() => { try { lf.focus(); } catch {} }, 50);
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
      const lf = lastFocusedElement;
      lastFocusedElement = null;
      if (lf) setTimeout(() => { try { lf.focus(); } catch {} }, 50);
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
  success: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  warning: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};

// Notification Preferences (wt-notif-prefs)
function getNotifPref(key, fallback) {
  try {
    const prefs = JSON.parse(safeStorage.getItem('wt-notif-prefs') || '{}');
    return prefs[key] !== undefined ? prefs[key] : fallback;
  } catch { return fallback; }
}

function setNotifPref(key, val) {
  try {
    const prefs = JSON.parse(safeStorage.getItem('wt-notif-prefs') || '{}');
    prefs[key] = val;
    safeStorage.setItem('wt-notif-prefs', JSON.stringify(prefs));
  } catch {}
}

function toggleNotifPrefs() {
  const tray = document.getElementById('notif-prefs-tray');
  if (!tray) return;
  const isHidden = tray.style.display === 'none';
  tray.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) {
    const snd = document.getElementById('notif-pref-sound');
    const bnr = document.getElementById('notif-pref-banners');
    if (snd) snd.checked = !!getNotifPref('sound', false);
    if (bnr) bnr.checked = getNotifPref('banners', true) !== false;
    updateDesktopNotifBtn();
  }
}

function updateDesktopNotifBtn() {
  const btn = document.getElementById('notif-desktop-btn');
  if (!btn) return;
  if (!('Notification' in window)) {
    btn.textContent = 'Unsupported';
    btn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    const enabled = getNotifPref('desktop', false);
    btn.textContent = enabled ? 'Enabled' : 'Disabled';
    btn.className = 'btn btn-sm ' + (enabled ? 'btn-primary' : '');
  } else if (Notification.permission === 'denied') {
    btn.textContent = 'Blocked in Browser';
    btn.disabled = true;
  } else {
    btn.textContent = 'Request Permission';
  }
}

async function toggleDesktopNotifPerm() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setNotifPref('desktop', true);
      toast('Desktop notifications enabled', 'success', { log: false });
    }
  } else if (Notification.permission === 'granted') {
    const cur = getNotifPref('desktop', false);
    setNotifPref('desktop', !cur);
    toast(!cur ? 'Desktop notifications enabled' : 'Desktop notifications disabled', 'info', { log: false });
  }
  updateDesktopNotifBtn();
}

function playNotifSound(type) {
  if (!getNotifPref('sound', false)) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } else if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime);
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.08);
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.16);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(554.37, ctx.currentTime + 0.07);
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    }
  } catch {}
}

function sendDesktopNotification(msg, type) {
  if (!getNotifPref('desktop', false)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    const title = 'WebTun: ' + (type ? type.toUpperCase() : 'Alert');
    const n = new Notification(title, {
      body: String(msg),
      icon: '/icon-192.png',
      badge: '/icon.svg',
      silent: true
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

function toast(msg, type = 'info', opts = {}) {
  // Option to skip logging into Notification Center drawer for internal status popups
  if (opts.log !== false) {
    try { logNotification(msg, type); } catch {}
  }
  if (opts.sound !== false) playNotifSound(type);
  if (opts.desktop !== false) sendDesktopNotification(msg, type);

  // Check if visual banners are disabled
  if (getNotifPref('banners', true) === false) return null;

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'status');

  const contentWrap = document.createElement('div');
  contentWrap.className = 'toast-content';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-ico';
  iconSpan.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
  contentWrap.appendChild(iconSpan);

  const textSpan = document.createElement('span');
  textSpan.className = 'toast-text';
  textSpan.textContent = msg;
  contentWrap.appendChild(textSpan);
  el.appendChild(contentWrap);

  // Quick Action Buttons
  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'toast-actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'toast-btn toast-copy';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.title = 'Copy';
  copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(msg);
      copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
      copyBtn.style.color = 'var(--green)';
      setTimeout(() => {
        copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        copyBtn.style.color = '';
      }, 1200);
    } catch {}
  });
  actionsWrap.appendChild(copyBtn);

  // Dismiss button
  const x = document.createElement('button');
  x.className = 'toast-btn toast-x';
  x.setAttribute('aria-label', 'Dismiss notification');
  x.title = 'Dismiss';
  x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  x.addEventListener('click', (e) => { e.stopPropagation(); try { el.remove(); } catch {} });
  actionsWrap.appendChild(x);
  el.appendChild(actionsWrap);

  // Animated Progress Countdown Bar
  const duration = type === 'error' ? 6500 : 3500;
  const progress = document.createElement('div');
  progress.className = 'toast-progress';
  progress.style.animationDuration = `${duration}ms`;
  el.appendChild(progress);

  // No per-toast key-bar margin: #toast-container already lifts clear of the
  // bar, so this stacked a second --mobilekey-h on top and pushed toasts over
  // both the bar and the bottom nav (M-08).
  const container = document.getElementById('toast-container');
  if (!container) return el;
  container.appendChild(el);

  // Cap at 4 toasts
  while (container.children.length > 4) {
    const kids = [...container.children];
    const victim = kids.find(k => !k.classList.contains('error') && k !== el) || kids.find(k => k !== el);
    if (!victim) break;
    victim.remove();
  }

  // Hover *or keyboard focus* pauses the countdown. Mouse-only pausing failed
  // WCAG 2.2.1: a keyboard user tabbing to Copy/Dismiss could not extend the
  // message they were reading, and .toast-progress was the only time cue (S-17).
  let startTime = Date.now();
  let remaining = duration;
  let paused = false;
  let ttl = setTimeout(() => el.remove(), remaining);

  const pause = () => {
    if (paused) return;
    paused = true;
    clearTimeout(ttl);
    remaining -= (Date.now() - startTime);
    progress.style.animationPlayState = 'paused';
  };
  const resume = () => {
    if (!paused) return;
    paused = false;
    startTime = Date.now();
    progress.style.animationPlayState = 'running';
    ttl = setTimeout(() => el.remove(), Math.max(remaining, 1000));
  };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('mouseleave', resume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', resume);

  return el;
}

// ── Notification Center (bell drawer, mirrors the settings panel) ─────────
const NOTIF_MAX = 100;
let notifLog = [];
let notifSeq = 0;
let notifUnread = 0;
let _notifFilterType = 'all';
let _notifFilterQuery = '';

try {
  const saved = JSON.parse(safeStorage.getItem('wt-notifs') || 'null');
  if (Array.isArray(saved)) {
    notifLog = saved.filter(n => n && typeof n.msg === 'string' && n.msg !== 'All notifications cleared').slice(-NOTIF_MAX);
    notifSeq = notifLog.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);
    notifUnread = notifLog.length;
  }
} catch {}

function persistNotifs() {
  try { safeStorage.setItem('wt-notifs', JSON.stringify(notifLog.slice(-NOTIF_MAX))); } catch {}
  try { safeStorage.setItem('wt-notifs-unread', String(notifUnread)); } catch {}
}

try {
  const u = parseInt(safeStorage.getItem('wt-notifs-unread') || '', 10);
  if (Number.isInteger(u) && u >= 0) notifUnread = Math.min(u, notifLog.length);
} catch {}

function logNotification(msg, type) {
  if (msg === 'All notifications cleared') return;
  const t = (type === 'success' || type === 'error' || type === 'warning') ? type : 'info';
  notifLog.push({ id: ++notifSeq, msg: String(msg == null ? '' : msg), type: t, time: Date.now() });
  if (notifLog.length > NOTIF_MAX) notifLog.splice(0, notifLog.length - NOTIF_MAX);
  persistNotifs();
  const panel = document.getElementById('notif-panel');
  if (panel && panel.classList.contains('open')) renderNotifPanel();
  else { notifUnread++; updateNotifBadge(); persistNotifs(); }
}

function updateNotifBadge() {
  const btn = document.getElementById('notif-btn');
  const count = document.getElementById('notif-count');
  const head = document.getElementById('notif-head-count');
  if (count) count.textContent = notifUnread > 99 ? '99+' : String(notifUnread);
  if (btn) btn.classList.toggle('has-unread', notifUnread > 0);
  if (head) head.textContent = notifLog.length ? `(${notifLog.length})` : '';

  // Update chip count counters in drawer
  const counts = { all: notifLog.length, error: 0, warning: 0, success: 0 };
  notifLog.forEach(n => {
    if (counts[n.type] !== undefined) counts[n.type]++;
  });
  const allEl = document.getElementById('notif-chip-all-count');
  const errEl = document.getElementById('notif-chip-error-count');
  const warnEl = document.getElementById('notif-chip-warning-count');
  const succEl = document.getElementById('notif-chip-success-count');
  if (allEl) allEl.textContent = counts.all;
  if (errEl) errEl.textContent = counts.error;
  if (warnEl) warnEl.textContent = counts.warning;
  if (succEl) succEl.textContent = counts.success;
}

function setNotifFilterType(type) {
  _notifFilterType = type;
  document.querySelectorAll('.notif-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  renderNotifPanel();
}

function filterNotifs() {
  const input = document.getElementById('notif-search-input');
  _notifFilterQuery = (input?.value || '').toLowerCase().trim();
  const clearBtn = document.getElementById('notif-search-clear');
  if (clearBtn) clearBtn.style.display = _notifFilterQuery ? 'inline-flex' : 'none';
  renderNotifPanel();
}

function clearNotifSearch() {
  const input = document.getElementById('notif-search-input');
  if (input) input.value = '';
  _notifFilterQuery = '';
  const clearBtn = document.getElementById('notif-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderNotifPanel();
}

function renderNotifPanel() {
  const box = document.getElementById('notif-list');
  if (!box) return;
  box.innerHTML = '';

  const clearBtn = document.getElementById('notif-clear-all');
  if (clearBtn) clearBtn.disabled = !notifLog.length;

  // Filter list by type and query
  const filtered = notifLog.filter(n => {
    if (_notifFilterType !== 'all' && n.type !== _notifFilterType) return false;
    if (_notifFilterQuery && !n.msg.toLowerCase().includes(_notifFilterQuery)) return false;
    return true;
  });

  const empty = document.getElementById('notif-empty');
  if (empty) {
    empty.style.display = filtered.length ? 'none' : 'flex';
    const emptySpan = empty.querySelector('span');
    if (emptySpan) {
      if (_notifFilterQuery || _notifFilterType !== 'all') {
        emptySpan.textContent = 'No matching notifications found.';
      } else {
        emptySpan.textContent = 'All caught up — notifications stay here until you clear them.';
      }
    }
  }

  // Newest first
  for (let i = filtered.length - 1; i >= 0; i--) {
    const n = filtered[i];
    const row = document.createElement('div');
    row.className = 'notif-item ' + n.type;
    row.dataset.nid = String(n.id);

    const ico = document.createElement('span');
    ico.className = 'notif-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = TOAST_ICONS[n.type] || TOAST_ICONS.info;

    const mainWrap = document.createElement('div');
    mainWrap.className = 'notif-item-main';

    const topRow = document.createElement('div');
    topRow.className = 'notif-item-top';

    const typeBadge = document.createElement('span');
    typeBadge.className = 'notif-tag notif-tag-' + n.type;
    typeBadge.textContent = n.type.toUpperCase();
    topRow.appendChild(typeBadge);

    const d = new Date(n.time);
    const when = document.createElement('span');
    when.className = 'notif-time';
    const ago = Date.now() - n.time;
    when.textContent = ago < 60000 ? 'just now' : ago < 3600000 ? Math.floor(ago / 60000) + 'm ago' : ago < 86400000 ? Math.floor(ago / 3600000) + 'h ago' : d.toLocaleDateString();
    when.title = d.toLocaleString();
    topRow.appendChild(when);
    mainWrap.appendChild(topRow);

    const txt = document.createElement('div');
    txt.className = 'notif-msg';
    txt.textContent = n.msg;
    mainWrap.appendChild(txt);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'notif-item-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'notif-btn notif-copy';
    copyBtn.title = 'Copy message';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        navigator.clipboard.writeText(n.msg);
        toast('Copied notification text', 'info', { log: false });
      } catch {}
    });
    actions.appendChild(copyBtn);

    const x = document.createElement('button');
    x.className = 'notif-btn notif-x';
    x.setAttribute('aria-label', 'Dismiss notification');
    x.title = 'Dismiss';
    x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      clearNotifItem(n.id);
    });
    actions.appendChild(x);

    row.append(ico, mainWrap, actions);
    box.appendChild(row);
  }

  updateNotifBadge();
  setupNotifSwipe();
}

// Swipe a row sideways to dismiss it (same gesture as tab swipe-to-close:
// horizontal-dominant drag past ~90px; anything else snaps back).
function setupNotifSwipe() {
  const box = document.getElementById('notif-list');
  if (!box || box._swipeWired) return;
  box._swipeWired = true;
  let startX = 0, startY = 0, row = null;
  box.addEventListener('touchstart', e => {
    if (!e.touches || e.touches.length !== 1) return;
    const r = e.target && e.target.closest ? e.target.closest('.notif-item') : null;
    if (!r) return;
    row = r;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  box.addEventListener('touchmove', e => {
    if (!row || !row.isConnected) { row = null; return; }
    if (!e.touches || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // Require horizontal-dominant motion so vertical scrolling never dismisses.
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (Math.abs(dx) > 5) {
      e.preventDefault();
      row.style.transform = `translateX(${dx}px)`;
      row.style.opacity = Math.max(0.3, 1 - Math.abs(dx) / 200);
      row.style.background = `rgba(247,118,142,${Math.min(Math.abs(dx) / 80, 1) * 0.2})`;
    }
  }, { passive: false });
  const endSwipe = e => {
    if (!row) return;
    const el = row;
    row = null;
    let dx = 0, dy = 0;
    try {
      const t = (e.changedTouches || [])[0] || {};
      dx = (t.clientX || 0) - startX;
      dy = (t.clientY || 0) - startY;
    } catch {}
    el.style.transform = '';
    el.style.opacity = '';
    el.style.background = '';
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const id = parseInt(el.dataset ? el.dataset.nid : '', 10);
      if (!isNaN(id)) clearNotifItem(id);
    }
  };
  box.addEventListener('touchend', endSwipe, { passive: true });
  box.addEventListener('touchcancel', () => { row = null; }, { passive: true });
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  if (panel.classList.contains('open')) { closeNotifPanel(); return; }
  try { closeSettings(); } catch {}
  // Closed drawers are inert so their controls stay out of the tab order (S-10).
  if (typeof setPanelInert === 'function') setPanelInert('notif-panel', false);
  panel.classList.add('open');
  // Same modal treatment as Settings: scrim at every width (D-15).
  const scrim = document.getElementById('drawer-backdrop');
  if (scrim) { scrim.classList.add('active'); scrim.classList.toggle('desktop-modal', window.innerWidth > 768); }
  notifUnread = 0;
  persistNotifs();
  renderNotifPanel();
  document.getElementById('notif-btn')?.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('click', closeNotifOnClickOutside, true), 50);
}
function closeNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (panel) panel.classList.remove('open');
  if (panel && typeof setPanelInert === 'function') setPanelInert('notif-panel', true);
  document.getElementById('notif-btn')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', closeNotifOnClickOutside, true);
}
function closeNotifOnClickOutside(e) {
  const panel = document.getElementById('notif-panel');
  const btn = document.getElementById('notif-btn');
  if (!panel || !panel.classList.contains('open')) { document.removeEventListener('click', closeNotifOnClickOutside, true); return; }
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeNotifPanel();
}
function clearNotifItem(id) {
  notifLog = notifLog.filter(n => n.id !== id);
  persistNotifs();
  renderNotifPanel();
}
function clearAllNotifs() {
  notifLog = [];
  notifUnread = 0;
  persistNotifs();
  renderNotifPanel();
}

// ── Context menus: one at a time, auto-close on outside activity ───────────
// Every opener calls hideAllCtxMenus() first, and setupCtxAutoDismiss()
// (idempotent, wired once below) closes whatever is open on right-click
// elsewhere, scroll, resize, or window blur. Outside LEFT-click dismissal for
// #ctx-menu/#term-ctx-menu lives in files.js (document click handler) —
// left-clicks are excluded here so they can reach the explorer/editor
// without this handler racing them.
const _CTX_MENU_SELS = '#ctx-menu,#term-ctx-menu,#tab-ctx-menu,#new-tab-menu,#tab-list-menu,#more-menu';
function hideAllCtxMenus() {
  try { if (typeof hideTabMenus === 'function') hideTabMenus(); } catch {}
  try { if (typeof closeMoreMenu === 'function') closeMoreMenu(); } catch {}
  try { document.getElementById('ctx-menu')?.classList.remove('open'); } catch {}
  // No focus steal: an outside click into the explorer/editor keeps its focus.
  try { if (typeof hideTermCtxMenu === 'function') hideTermCtxMenu(false); } catch {}
  try { if (typeof hideTermSelectionBar === 'function') hideTermSelectionBar(); } catch {}
  if (window.innerWidth <= 768) {
    const sb = document.getElementById('sidebar');
    const sp = document.getElementById('settings-panel');
    if (!sb?.classList.contains('mobile-open') && !sp?.classList.contains('open') && !document.getElementById('tab-list-menu')?.offsetParent && !document.getElementById('more-menu')?.classList.contains('open')) {
      document.getElementById('drawer-backdrop')?.classList.remove('active', 'desktop-modal');
    }
  }
}

function closeAllDrawers() {
  const sb = document.getElementById('sidebar');
  if (sb && sb.classList.contains('mobile-open')) {
    if (typeof toggleSidebar === 'function') toggleSidebar();
  }
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel && settingsPanel.classList.contains('open')) {
    if (typeof closeSettings === 'function') closeSettings();
  }
  const notifPanel = document.getElementById('notif-panel');
  if (notifPanel && notifPanel.classList.contains('open')) {
    if (typeof closeNotifPanel === 'function') closeNotifPanel();
  }
  hideAllCtxMenus();
  try { if (typeof closeMoreMenu === 'function') closeMoreMenu(); } catch {}
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) backdrop.classList.remove('active', 'desktop-modal');
  document.getElementById('mnav-explorer')?.classList.remove('active');
  document.getElementById('mnav-tabs')?.classList.remove('active');
  document.getElementById('mnav-more')?.classList.remove('active');
}
let _ctxAutoDismissWired = false;
function setupCtxAutoDismiss() {
  if (_ctxAutoDismissWired) return;
  _ctxAutoDismissWired = true;
  const insideMenu = (t) => {
    try { return !!(t && t.closest && t.closest(_CTX_MENU_SELS)); } catch { return false; }
  };
  // Right-click anywhere else. Menu openers preventDefault their own event,
  // so it never reaches here; anything arriving unprevented is outside.
  document.addEventListener('contextmenu', e => {
    if (e.defaultPrevented || insideMenu(e.target)) return;
    hideAllCtxMenus();
  });
  // A position:fixed menu is orphaned by any scroll outside itself.
  document.addEventListener('scroll', e => {
    if (insideMenu(e.target)) return;
    hideAllCtxMenus();
  }, { capture: true, passive: true });
  window.addEventListener('resize', () => hideAllCtxMenus());
  window.addEventListener('blur', () => hideAllCtxMenus());
}
try { setupCtxAutoDismiss(); } catch {}

function updateConnStatus(connected) {
  const dot = document.getElementById('conn-status');
  if (dot) {
    dot.style.background = connected ? 'var(--green)' : 'var(--red)';
    dot.title = connected ? 'Connected' : 'Disconnected';
    dot.setAttribute('aria-label', connected ? 'Connected' : 'Disconnected');
  }
}

// Aggregated status: a background tab's socket closing must not flip the
// title-bar dot red while the active tab is still connected.
function refreshConnStatus() {
  try {
    const list = (typeof tabs !== 'undefined' && Array.isArray(tabs)) ? tabs : [];
    const active = (typeof getActiveTab === 'function') ? getActiveTab() : null;
    let isConnected = false;
    if (active && active.type === 'term') {
      isConnected = !!(active.ws && active.ws.readyState === WebSocket.OPEN);
      if (!isConnected) {
        isConnected = list.some(t => t && t.type === 'term' && t.ws && t.ws.readyState === WebSocket.OPEN);
      }
    } else {
      isConnected = list.some(t => t && t.type === 'term' && t.ws && t.ws.readyState === WebSocket.OPEN);
      // No terminal tabs at all (files/previews only): nothing to be
      // disconnected from — keep the last known dot rather than crying wolf.
      if (!list.some(t => t && t.type === 'term')) return;
    }
    updateConnStatus(isConnected);
  } catch {}
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

    // Disambiguate against OS system back gestures: ignore swipes starting right at screen edge (<20px)
    if (touchStartX >= 20 && touchStartX <= 65 && dx > 60 && Math.abs(dy) < 60) {
      if (!sidebar.classList.contains('mobile-open') || sidebar.classList.contains('hidden')) {
        if (typeof triggerHaptic === 'function') triggerHaptic('light');
        toggleSidebar();
        touchStartX = 0;
      }
    }

    // Swipe left to dismiss open sidebar
    if (dx < -60 && Math.abs(dy) < 60) {
      if (sidebar.classList.contains('mobile-open')) {
        if (typeof triggerHaptic === 'function') triggerHaptic('light');
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
  let touchStartX = 0;
  let touchStartY = 0;

  list.addEventListener('touchstart', e => {
    const item = e.target.closest('.file-item');
    if (!item) return;

    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;

    const file = {
      path: item.dataset.path,
      name: fileRowName(item, item.dataset.path),
      isDir: item.dataset.isDir === 'true' || !!item.querySelector('.file-dir'),
      ext: (() => { const m = item.dataset.path.match(/\.([^.]+)$/); return m ? '.' + m[1].toLowerCase() : ''; })()
    };
    if (!file.path) return;

    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      try { if (navigator.vibrate) navigator.vibrate(30); } catch {}
      showCtxMenu({
        clientX: touch.clientX,
        clientY: touch.clientY,
        preventDefault() {}
      }, file);
    }, 450);
  }, { passive: true });

  list.addEventListener('touchmove', e => {
    if (longPressTimer && e.touches[0]) {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > 8 || dy > 8) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
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
    try { t.term?.dispose(); } catch {}
    try { t.el?.remove(); } catch {}
    try { t.wrapper?.remove(); } catch {}
    if (t.sessionId) api(`/api/sessions/${t.sessionId}`, { method: 'DELETE' });
  });
  tabs = [];
  activeTabId = null;
  // Enter-to-unlock must work on EVERY showing of this screen, not just first
  // load: init() wires it only on the fresh-boot PIN path, so sessions that
  // resume via stored token (or get kicked here by a 401/revoke later) ended
  // up with an input where Enter did nothing. Idempotent remove+add.
  try {
    const pinIn = document.getElementById('pin-input');
    if (pinIn && typeof handlePinKeydown === 'function') {
      pinIn.removeEventListener('keydown', handlePinKeydown);
      pinIn.addEventListener('keydown', handlePinKeydown);
      pinIn.focus();
    }
  } catch {}
}
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
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel && settingsPanel.classList.contains('open')) closeSettings();
}
function closeOverlay(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove('open');
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
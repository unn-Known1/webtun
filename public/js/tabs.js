// WebTun frontend - tabs.js (tabs (term tabs, close, tiles, tab-bar DnD).)


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
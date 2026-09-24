// WebTun frontend - tabs.js (tabs (term tabs, close, tiles, tab-bar DnD).)


// ═══════════════════════════════════════════════════════
// TAB ENHANCEMENTS: color, pin, reopen, activity, menus
// ═══════════════════════════════════════════════════════
// tab.color: '' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'cyan'
// tab.pinned: boolean — pinned tabs group left, shrink to icons, survive
// bulk-close (others/right), and ask first on any single close.
const TAB_COLORS = ['', 'blue', 'green', 'amber', 'red', 'purple', 'cyan'];
const CLOSED_STACK_MAX = 15;
let closedTabsHistory = [];
let _tabCtxId = null;
let _tabCtxLongPress = null;

function getTabById(id) { return tabs.find(t => t.id === id); }

function applyTabMeta(tab) {
  const el = tab.el;
  if (!el) return;
  TAB_COLORS.forEach(c => { if (c) el.classList.remove('tab-color-' + c); });
  if (tab.color && TAB_COLORS.includes(tab.color) && tab.color) el.classList.add('tab-color-' + tab.color);
  el.classList.toggle('pinned', !!tab.pinned);
  el.title = tab.title + (tab.pinned ? ' (pinned)' : '');
  try {
    const pinLbl = document.getElementById('tab-ctx-pin-label');
    if (pinLbl && _tabCtxId === tab.id) pinLbl.textContent = tab.pinned ? 'Unpin Tab' : 'Pin Tab';
  } catch {}
}

function setTabColor(id, color) {
  const tab = getTabById(id);
  if (!tab) return;
  tab.color = TAB_COLORS.includes(color) ? color : '';
  if (!tab.color) tab.color = '';
  applyTabMeta(tab);
  try { saveTabState(); } catch {}
}

// Pinned tabs live as a group at the left of the bar, so the persistent set
// stays together. Shared by togglePinTab (pinning) and reopenLastClosedTab
// (restoring a closed pinned tab).
function groupPinnedTab(tab) {
  const idx = tabs.findIndex(t => t.id === tab.id);
  if (idx === -1) return;
  const [moved] = tabs.splice(idx, 1);
  let at = 0;
  while (at < tabs.length && tabs[at].pinned) at++;
  tabs.splice(at, 0, moved);
  const bar = document.getElementById('tab-scroll');
  const anchor = document.getElementById('new-tab-btn');
  try {
    if (moved.el && moved.el.parentNode === bar) {
      const ref = tabs[at + 1] && tabs[at + 1].el && tabs[at + 1].el.parentNode === bar ? tabs[at + 1].el : (anchor && anchor.parentElement === bar ? anchor : null);
      if (ref) bar.insertBefore(moved.el, ref);
      else bar.appendChild(moved.el);
    }
  } catch {}
}

function togglePinTab(id) {
  const tab = getTabById(id);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  // Pin to the left: a newly pinned tab moves ahead of unpinned ones.
  // Unpinning keeps the position.
  if (tab.pinned) groupPinnedTab(tab);
  applyTabMeta(tab);
  try { saveTabState(); } catch {}
  try { toast(tab.pinned ? 'Tab pinned — closing it will ask first' : 'Tab unpinned', 'info'); } catch {}
}

// Snapshot a tab for the reopen stack. Terminal sessions are killed on close
// (DELETE /api/sessions), so a reopen is always a fresh shell in the same cwd —
// scrollback cannot be restored. Preview/file tabs restore port/path.
function snapshotTabForReopen(tab) {
  if (!tab) return null;
  const snap = { type: tab.type || 'term', title: tab.title, color: tab.color || '', pinned: !!tab.pinned, cwd: tab.cwd || null };
  if (tab.type === 'preview') { snap.port = tab.port; snap.path = tab.previewPath || '/'; }
  else if (tab.type === 'file') { snap.path = tab.path; if (!snap.path) return null; }
  return snap;
}

function pushClosedTab(tab) {
  try {
    const snap = snapshotTabForReopen(tab);
    if (!snap) return;
    closedTabsHistory.push(snap);
    if (closedTabsHistory.length > CLOSED_STACK_MAX) closedTabsHistory.splice(0, closedTabsHistory.length - CLOSED_STACK_MAX);
  } catch {}
}

function reopenLastClosedTab() {
  const snap = closedTabsHistory.pop();
  if (!snap) { try { toast('Nothing to reopen', 'info'); } catch {} return null; }
  try {
    let tab = null;
    if (snap.type === 'preview' && snap.port) {
      tab = newPreviewTab(snap.port, snap.path || '/');
    } else if (snap.type === 'file' && snap.path) {
      tab = (typeof openFileAsTab === 'function') ? openFileAsTab(snap.path) : newFileTab(snap.path);
    } else {
      tab = newTab(snap.title, undefined, snap.cwd || undefined);
    }
    if (tab && snap.color) setTabColor(tab.id, snap.color);
    // A reopened pinned tab comes back pinned and regrouped left, so the
    // protection the user asked for survives an accidental close.
    if (tab && snap.pinned) {
      if (!tab.pinned) { tab.pinned = true; try { applyTabMeta(tab); } catch {} }
      groupPinnedTab(tab);
      try { saveTabState(); } catch {}
    }
    return tab;
  } catch (e) { console.warn('reopenLastClosedTab failed:', e); return null; }
}

function duplicateTab(id) {
  const tab = getTabById(id == null ? activeTabId : id);
  if (!tab) { try { toast('No active tab to duplicate', 'error'); } catch {} return null; }
  try {
    if (tab.type === 'preview') {
      const t = newPreviewTab(tab.port, tab.previewPath || '/');
      if (t && tab.color) setTabColor(t.id, tab.color);
      return t;
    }
    if (tab.type === 'file') {
      try { toast('File tabs open one path once — focusing the existing tab instead', 'info'); } catch {}
      activateTab(tab.id);
      return tab;
    }
    const t = newTab(tab.title, undefined, tab.cwd || currentPath);
    if (t && tab.color) setTabColor(t.id, tab.color);
    return t;
  } catch (e) { console.warn('duplicateTab failed:', e); return null; }
}

function triggerTabRename(id) {
  const tab = getTabById(id == null ? activeTabId : id);
  if (!tab?.el) return;
  // Prefer the direct starter when available (no synthetic event bubbling).
  try {
    if (typeof tab._startRename === 'function') { tab._startRename(); return; }
  } catch {}
  const span = tab.el.querySelector('.tab-title');
  if (!span) return;
  try { span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); } catch {}
  // Fallback when the rename wiring is missing: focus the span.
  setTimeout(() => { try { if (!document.getElementById('tab-rename-input')) span.focus?.(); } catch {} }, 50);
}

// TR-07: dedicated rename entry point for the terminal context menu (and
// anywhere else) — scrolls the tab into view first so the inline editor
// never opens on a tab scrolled off-screen or hidden in Tile View, then
// starts editing directly instead of dispatching a synthetic dblclick.
function promptTabRename(tabOrId) {
  const tab = (tabOrId && typeof tabOrId === 'object' && tabOrId.el)
    ? tabOrId
    : getTabById(tabOrId == null ? activeTabId : tabOrId);
  if (!tab?.el) return;
  try { tab.el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch {}
  const start = () => {
    try {
      if (typeof tab._startRename === 'function') tab._startRename();
      else triggerTabRename(tab.id);
    } catch {}
  };
  // Let the smooth scroll bring the tab into view before opening the editor.
  setTimeout(start, 60);
}

// Background activity / bell / exited badges. Activity + bell clear the moment
// the user visits the tab; exited persists until reconnect/restart.
function notifyTabOutput(tab) {
  try {
    if (!tab || tab.closed || tab.id === activeTabId) return;
    if (tab.type !== 'term') return;
    tab.el?.classList.add('has-activity');
  } catch {}
}
function notifyTabBell(tab) {
  try {
    if (!tab || tab.closed) return;
    if (tab.id !== activeTabId) { tab.el?.classList.add('has-bell'); tab.el?.classList.remove('has-activity'); }
  } catch {}
}
function notifyTabExited(tab) {
  try {
    if (!tab || tab.closed) return;
    tab.el?.classList.add('is-exited');
    tab.el?.classList.remove('has-activity');
  } catch {}
}
function clearTabExited(tab) {
  try { tab?.el?.classList.remove('is-exited'); } catch {}
}
function clearTabBadges(tab) {
  try { tab?.el?.classList.remove('has-activity', 'has-bell'); } catch {}
}

function clearTabBuffer(id) {
  const tab = getTabById(id == null ? activeTabId : id);
  if (!tab) return;
  if (tab.type === 'term' && tab.term) { try { tab.term.clear(); toast('Terminal cleared', 'success'); } catch {} return; }
  if (tab.type === 'preview') { try { previewReload(tab); } catch {} return; }
  try { toast('Nothing to clear on this tab', 'info'); } catch {}
}

function restartTabSession(id) {
  const tab = getTabById(id == null ? activeTabId : id);
  if (!tab) return;
  try {
    if (tab.type === 'preview') { previewReload(tab); toast('Preview reloaded', 'success'); return; }
    if (tab.type === 'file') {
      if (tab.viewer === 'text' && tab.cm) { reloadTabFile(tab); return; }
      if (tab.viewer === 'image') {
        try { if (tab.imgUrl) URL.revokeObjectURL(tab.imgUrl); } catch {}
        tab.imgUrl = null;
        if (tab.bodyEl) delete tab.bodyEl.dataset.mounted;
        mountImageIntoTab(tab);
        return;
      }
      mountFileTab(tab);
      return;
    }
    // Terminal: fresh server session in the same cwd, badges reset.
    clearTabExited(tab); clearTabBadges(tab);
    try { cleanupWebSocket(tab); } catch {}
    clearTimeout(tab.reconnectTimer);
    tab.sessionId = (typeof uuid === 'function') ? uuid() : String(Date.now());
    try { tab.term?.clear(); } catch {}
    try { tab.term?.writeln('\x1b[33m[Restarting session…]\x1b[0m'); } catch {}
    tab.reconnectDelay = 1000;
    tab.reconnectAttempts = 0;
    connectWebSocket(tab, false);
    toast('Session restarting…', 'info');
  } catch (e) { console.warn('restartTabSession failed:', e); }
}

async function bulkCloseTabs(targetIds, label) {
  const targets = (targetIds || []).map(getTabById).filter(t => t && !t.closed);
  if (!targets.length) { try { toast('Nothing to close', 'info'); } catch {} return; }
  // Pinned tabs are never bulk-closed.
  const closable = targets.filter(t => !t.pinned);
  const skipped = targets.length - closable.length;
  if (!closable.length) { try { toast('Pinned tabs are protected — unpin first', 'warning'); } catch {} return; }
  // One confirm for the whole batch (per-tab prompts would spam N dialogs).
  const dirtyFile = closable.some(t => t.type === 'file' && t.cm && t.cm.getValue() !== t.original);
  if (dirtyFile) {
    const ok = await confirmDialog({ title: 'Discard changes?', message: `Close ${closable.length} tabs? Unsaved file edits will be lost.`, okText: 'Discard', cancelText: 'Cancel', danger: true });
    if (!ok) return;
  } else if (settings.confirmclose) {
    const ok = await confirmDialog({ title: 'Close ' + (label || 'tabs'), message: `Close ${closable.length} tab${closable.length === 1 ? '' : 's'}?${skipped ? ` (${skipped} pinned skipped)` : ''}`, okText: 'Close', cancelText: 'Cancel' });
    if (!ok) return;
  }
  const fakeEv = { stopPropagation() {} };
  for (const t of closable) {
    try { await closeTab(fakeEv, t.id, { force: true }); } catch (e) { console.warn('bulk close failed:', e); }
  }
  if (skipped) { try { toast(`Skipped ${skipped} pinned tab${skipped === 1 ? '' : 's'}`, 'info'); } catch {} }
}

function closeOtherTabs(id) {
  const keep = id == null ? activeTabId : id;
  bulkCloseTabs(tabs.filter(t => t.id !== keep).map(t => t.id), 'other tabs');
}

function closeTabsToRight(id) {
  const ref = id == null ? activeTabId : id;
  const idx = tabs.findIndex(t => t.id === ref);
  if (idx === -1) return;
  bulkCloseTabs(tabs.slice(idx + 1).map(t => t.id), 'tabs to the right');
}

// ── Tab overflow (scroll arrows + count) ────────────────────────────────
function updateTabOverflow() {
  try {
    const scroll = document.getElementById('tab-scroll');
    const left = document.getElementById('tab-scroll-left');
    const right = document.getElementById('tab-scroll-right');
    const count = document.getElementById('tab-list-count');
    if (!scroll) return;
    const overflow = scroll.scrollWidth > scroll.clientWidth + 2;
    const maxScroll = scroll.scrollWidth - scroll.clientWidth;
    if (left) left.style.display = (overflow && scroll.scrollLeft > 2) ? 'flex' : 'none';
    if (right) right.style.display = (overflow && scroll.scrollLeft < maxScroll - 2) ? 'flex' : 'none';
    if (count) count.textContent = tabs.length > 1 ? String(tabs.length) : '';
  } catch {}
}

function scrollTabBar(dir) {
  try {
    const scroll = document.getElementById('tab-scroll');
    if (!scroll) return;
    scroll.scrollBy({ left: dir * Math.max(160, Math.floor(scroll.clientWidth * 0.6)), behavior: 'smooth' });
    setTimeout(updateTabOverflow, 250);
  } catch {}
}

function scrollActiveTabIntoView() {
  try {
    const tab = getTabById(activeTabId);
    tab?.el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch {}
  setTimeout(updateTabOverflow, 60);
}

// ── Tab quick-switcher (overflow menu) ──────────────────────────────────
function toggleTabListMenu(e) {
  try {
    const menu = document.getElementById('tab-list-menu');
    if (!menu) return;
    if (menu.style.display === 'block') { hideTabMenus(); return; }
    hideTabMenus();
    renderTabListMenu('');
    const btn = document.getElementById('tab-list-btn');
    const r = btn ? btn.getBoundingClientRect() : { left: window.innerWidth - 240, bottom: 40 };
    menu.style.display = 'block';
    const mw = Math.min(300, window.innerWidth - 16);
    menu.style.minWidth = mw + 'px';
    menu.style.maxWidth = mw + 'px';
    let left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    menu.style.left = left + 'px';
    menu.style.top = ((r.bottom || 40) + 6) + 'px';
    btn?.setAttribute('aria-expanded', 'true');
    const search = document.getElementById('tab-list-search');
    if (search) { search.value = ''; setTimeout(() => { try { search.focus(); } catch {} }, 30); }
  } catch (e) { console.warn('toggleTabListMenu failed:', e); }
}

function renderTabListMenu(filter) {
  try {
    const box = document.getElementById('tab-list-items');
    if (!box) return;
    box.innerHTML = '';
    const q = String(filter || '').trim().toLowerCase();
    tabs.forEach((t, i) => {
      if (q && !(t.title || '').toLowerCase().includes(q) && !(t.path || '').toLowerCase().includes(q)) return;
      const row = document.createElement('div');
      row.className = 'tab-list-row' + (t.id === activeTabId ? ' active' : '');
      row.setAttribute('role', 'menuitem');
      row.tabIndex = 0;
      const num = document.createElement('span');
      num.className = 'tab-list-num';
      num.textContent = i < 9 ? String(i + 1) : '•';
      const dot = document.createElement('span');
      dot.className = 'tab-list-dot' + (t.color ? ' sw-' + t.color : '');
      const name = document.createElement('span');
      name.className = 'tab-list-name';
      name.textContent = (t.pinned ? '📌 ' : '') + t.title;
      name.title = t.type === 'file' ? t.path : t.title;
      const kind = document.createElement('span');
      kind.className = 'tab-list-kind';
      kind.textContent = t.type === 'preview' ? 'preview' : t.type === 'file' ? 'file' : 'term';
      const close = document.createElement('button');
      close.className = 'tab-list-close';
      close.setAttribute('aria-label', 'Close ' + t.title);
      close.textContent = '✕';
      close.addEventListener('click', ev => { ev.stopPropagation(); hideTabMenus(); closeTab({ stopPropagation() {} }, t.id); });
      row.append(num, dot, name, kind, close);
      row.addEventListener('click', () => { hideTabMenus(); activateTab(t.id); });
      row.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); hideTabMenus(); activateTab(t.id); }
      });
      box.appendChild(row);
    });
    if (!box.children.length) {
      const empty = document.createElement('div');
      empty.className = 'tab-list-empty';
      empty.textContent = 'No tabs match';
      box.appendChild(empty);
    }
  } catch (e) { console.warn('renderTabListMenu failed:', e); }
}

// ── Context menus ───────────────────────────────────────────────────────
function positionMenu(menu, x, y) {
  menu.style.display = 'block';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (left + mw > vw) left = Math.max(0, x - mw);
  if (top + mh > vh) top = Math.max(0, y - mh);
  menu.style.left = Math.max(0, Math.min(left, vw - mw)) + 'px';
  menu.style.top = Math.max(0, Math.min(top, vh - mh)) + 'px';
}

function hideTabMenus() {
  try { document.getElementById('tab-ctx-menu').style.display = 'none'; } catch {}
  try { document.getElementById('new-tab-menu').style.display = 'none'; } catch {}
  try {
    const m = document.getElementById('tab-list-menu');
    if (m) m.style.display = 'none';
    document.getElementById('tab-list-btn')?.setAttribute('aria-expanded', 'false');
  } catch {}
  try { document.getElementById('tab-ctx-color-wrap')?.classList.remove('open'); } catch {}
  _tabCtxId = null;
}

function openTabContextMenu(e, id) {
  const tab = getTabById(id);
  if (!tab) return;
  e.preventDefault();
  e.stopPropagation();
  try { if (typeof hideAllCtxMenus === 'function') hideAllCtxMenus(); } catch {}
  try { document.getElementById('ctx-menu')?.classList.remove('open'); } catch {}
  try { hideTermCtxMenu(); } catch {}
  hideTabMenus();
  _tabCtxId = id;
  applyTabMeta(tab);
  const menu = document.getElementById('tab-ctx-menu');
  if (!menu) return;
  // Per-type affordances: Clear/Restart always available, Duplicate is a no-op
  // for file tabs (one path = one tab) and says so on click.
  const dup = document.getElementById('tab-ctx-duplicate');
  if (dup) dup.style.opacity = tab.type === 'file' ? '0.55' : '';
  const clear = document.getElementById('tab-ctx-clear');
  if (clear) clear.style.opacity = tab.type === 'file' && !(tab.cm) ? '0.55' : '';
  // Mark the active color.
  try {
    menu.querySelectorAll('#tab-ctx-colors .ctx-item').forEach(el => {
      el.classList.toggle('ctx-current', (el.dataset.tabColor || '') === (tab.color || ''));
    });
  } catch {}
  positionMenu(menu, e.clientX, e.clientY);
  try { menu.querySelector('.ctx-item')?.focus(); } catch {}
}

function openNewTabMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  try { if (typeof hideAllCtxMenus === 'function') hideAllCtxMenus(); } catch {}
  try { document.getElementById('ctx-menu')?.classList.remove('open'); } catch {}
  try { hideTermCtxMenu(); } catch {}
  hideTabMenus();
  const menu = document.getElementById('new-tab-menu');
  if (!menu) return;
  const x = e.clientX || (window.innerWidth - 220);
  const y = e.clientY || 40;
  positionMenu(menu, x, y);
  try { menu.querySelector('.ctx-item')?.focus(); } catch {}
}

function setupTabCtxMenuItems() {
  if (window._tabCtxWired) return;
  window._tabCtxWired = true;
  const on = (id, fn) => { try { document.getElementById(id)?.addEventListener('click', ev => { ev.stopPropagation(); fn(ev); }); } catch {} };
  on('tab-ctx-rename', () => { const id = _tabCtxId; hideTabMenus(); triggerTabRename(id); });
  on('tab-ctx-duplicate', () => { const id = _tabCtxId; hideTabMenus(); duplicateTab(id); });
  on('tab-ctx-pin', () => { const id = _tabCtxId; hideTabMenus(); togglePinTab(id); });
  on('tab-ctx-clear', () => { const id = _tabCtxId; hideTabMenus(); clearTabBuffer(id); });
  on('tab-ctx-restart', () => { const id = _tabCtxId; hideTabMenus(); restartTabSession(id); });
  on('tab-ctx-close', () => { const id = _tabCtxId; hideTabMenus(); if (id != null) closeTab({ stopPropagation() {} }, id); });
  on('tab-ctx-close-others', () => { const id = _tabCtxId; hideTabMenus(); closeOtherTabs(id); });
  on('tab-ctx-close-right', () => { const id = _tabCtxId; hideTabMenus(); closeTabsToRight(id); });
  try {
    document.querySelectorAll('#tab-ctx-colors .ctx-item').forEach(el => {
      el.addEventListener('click', ev => { ev.stopPropagation(); const id = _tabCtxId; const c = el.dataset.tabColor || ''; hideTabMenus(); setTabColor(id, c); });
    });
    document.querySelector('#tab-ctx-color-wrap > .ctx-item')?.addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('tab-ctx-color-wrap')?.classList.toggle('open');
    });
  } catch {}
  on('newtab-term', () => { hideTabMenus(); newTab(); });
  on('newtab-duplicate', () => { hideTabMenus(); duplicateTab(activeTabId); });
  on('newtab-preview', () => { hideTabMenus(); newPreviewPrompt(); });
  on('newtab-tiles', () => { hideTabMenus(); toggleTiles(); });
  // Dismiss on outside click / resize.
  document.addEventListener('click', e => {
    try {
      if (!e.target.closest('#tab-ctx-menu') && !e.target.closest('#new-tab-menu') && !e.target.closest('#tab-list-menu') && !e.target.closest('#tab-list-btn')) hideTabMenus();
    } catch {}
  });
  window.addEventListener('resize', () => { hideTabMenus(); updateTabOverflow(); });
  // Keyboard nav inside the tab menus (mirrors setupCtxMenuKeyboard).
  ['tab-ctx-menu', 'new-tab-menu'].forEach(mid => {
    const menu = document.getElementById(mid);
    if (!menu) return;
    menu.querySelectorAll('.ctx-item').forEach(el => { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1'); });
    menu.addEventListener('keydown', e => {
      const items = [...menu.querySelectorAll('.ctx-item')].filter(el => {
        const sub = el.closest('.ctx-submenu-items');
        if (sub && !sub.parentElement.classList.contains('open')) return false;
        return el.offsetParent !== null;
      });
      if (!items.length) return;
      let idx = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); hideTabMenus(); return; }
      if (e.key === 'ArrowDown') idx = (idx + 1) % items.length;
      else if (e.key === 'ArrowUp') idx = (idx - 1 + items.length) % items.length;
      else if (e.key === 'Home') idx = 0;
      else if (e.key === 'End') idx = items.length - 1;
      else if (e.key === 'Enter' || e.key === ' ') {
        if (document.activeElement?.classList.contains('ctx-item')) { e.preventDefault(); document.activeElement.click(); }
        return;
      } else return;
      e.preventDefault();
      items[idx]?.focus();
    });
  });
  try {
    document.getElementById('tab-list-search')?.addEventListener('input', e => renderTabListMenu(e.target.value));
    document.getElementById('tab-list-search')?.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); hideTabMenus(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = document.querySelector('#tab-list-items .tab-list-row');
        if (first) { hideTabMenus(); first.click(); }
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector('#tab-list-items .tab-list-row')?.focus(); }
    });
  } catch {}
}

function setupTabEnhancements() {
  setupTabCtxMenuItems();
  try {
    const scroll = document.getElementById('tab-scroll');
    scroll?.addEventListener('scroll', () => requestAnimationFrame(updateTabOverflow), { passive: true });
    window.addEventListener('resize', () => requestAnimationFrame(updateTabOverflow));
    // Right-click the + button or empty tab-bar gutter for the new-tab menu.
    document.getElementById('new-tab-btn')?.addEventListener('contextmenu', e => openNewTabMenu(e));
    document.getElementById('tab-bar')?.addEventListener('contextmenu', e => {
      if (e.target.closest('.tab') || e.target.closest('#tab-ctx-menu') || e.target.closest('#new-tab-menu') || e.target.closest('#tab-list-menu')) return;
      openNewTabMenu(e);
    });
    // Long-press a tab on touch opens the menu (title long-press still renames:
    // the rename input existing aborts the menu).
    // (Per-tab touch wiring lives in createTabButton.)
  } catch {}
  updateTabOverflow();
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
    updateTabOverflow();
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
    // Guard against double-invocation (e.g. promptTabRename + dblclick racing):
    // only one rename input may exist at a time.
    try { if (document.getElementById('tab-rename-input')) return; } catch {}
    if (!span || !span.isConnected) {
      span = tab.el?.querySelector('.tab-title');
      if (!span) return;
    }
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
      // The replacement span is a fresh node: re-wire rename onto it, or the
      // renamed tab silently loses dblclick/long-press rename.
      try { setupTabInlineRename(newSpan, tab); } catch {}
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
  tabTitleSpan.addEventListener('touchcancel', () => {
    if (renameTimer) { clearTimeout(renameTimer); renameTimer = null; }
  }, { passive: true });
  tabTitleSpan.addEventListener('touchmove', () => {
    if (renameTimer) { clearTimeout(renameTimer); renameTimer = null; }
  }, { passive: true });
  // Direct entry point for promptTabRename()/triggerTabRename() — always
  // resolves the *current* .tab-title node (the span is replaced on every
  // rename, so a captured reference would go stale).
  try {
    tab._startRename = () => {
      const cur = tab.el?.querySelector('.tab-title');
      if (cur) startRename(cur);
    };
  } catch {}
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

  const pinIco = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pinIco.setAttribute('width', '10'); pinIco.setAttribute('height', '10'); pinIco.setAttribute('viewBox', '0 0 24 24');
  pinIco.setAttribute('fill', 'none'); pinIco.setAttribute('stroke', 'currentColor'); pinIco.setAttribute('stroke-width', '2');
  pinIco.setAttribute('class', 'tab-pin-ico');
  pinIco.setAttribute('aria-hidden', 'true');
  pinIco.innerHTML = '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>';
  tabEl.appendChild(pinIco);

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

  // Right-click → tab menu; middle-click → close (both desktop conventions).
  tabEl.addEventListener('contextmenu', e => openTabContextMenu(e, id));
  tabEl.addEventListener('auxclick', e => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); closeTab({ stopPropagation() {} }, id); }
  });
  // Touch long-press on the tab chrome opens the menu. The title span has its
  // own 400ms rename timer — this 650ms timer aborts when a rename input is
  // already open so both don't fire.
  tabEl.addEventListener('touchstart', e => {
    clearTimeout(_tabCtxLongPress);
    const t = e.touches[0];
    _tabCtxLongPress = setTimeout(() => {
      if (document.getElementById('tab-rename-input')) return;
      try { openTabContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: t.clientX, clientY: t.clientY }, id); } catch {}
    }, 650);
  }, { passive: true });
  ['touchend', 'touchcancel', 'touchmove'].forEach(ev => tabEl.addEventListener(ev, () => clearTimeout(_tabCtxLongPress), { passive: true }));

  setupTabDragDrop(tabEl, id);
  setupTabInlineRename(titleSpan, tab);
  setupTabSwipeGesture(tabEl, id);

  const scroll = document.getElementById('tab-scroll');
  const anchor = document.getElementById('new-tab-btn');
  if (anchor && anchor.parentElement === scroll) scroll.insertBefore(tabEl, anchor);
  else scroll.appendChild(tabEl);
  tab.el = tabEl;
  applyTabMeta(tab);
  scrollActiveTabIntoView();
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


function newTab(title, sessionId, dir, opts = {}) {
  const id = ++tabCounter;
  const sid = sessionId || uuid();
  const tab = { id, type: 'term', sessionId: sid, title: title || `Term ${nextTermNumber()}`, term: null, fitAddon: null, ws: null, el: null, wrapper: null, closed: false, reconnectDelay: 1000, dataDisposable: null, resizeDisposable: null, resizeObserver: null, cwd: dir || currentPath, color: (opts && opts.color) || '', pinned: !!(opts && opts.pinned) };
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
  // Visiting a tab clears its unread/activity + bell badges.
  if (tab) clearTabBadges(tab);
  try { hideTabMenus(); } catch {}
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
  scrollActiveTabIntoView();
  try { if (typeof refreshConnStatus === 'function') refreshConnStatus(); } catch {}
}
async function closeTab(e, id, opts = {}) {
  e.stopPropagation();
  const closing = tabs.find(t => t.id === id);
  // Pinned tabs resist every single-close path (× button, middle-click,
  // Ctrl+W, swipe, context menu, quick-switcher, tiles, panel ×): one
  // explicit confirm, even when the global close-confirm is off. Bulk close
  // never reaches here for pinned tabs — it filters them out first and
  // closes the rest with `opts.force`, which bypasses this guard.
  let pinConfirmed = false;
  if (closing && closing.pinned && !opts.force) {
    pinConfirmed = await confirmDialog({ title: 'Tab is pinned', message: `'${closing.title}' is pinned. Close it anyway?`, okText: 'Close', cancelText: 'Keep', danger: true });
    if (!pinConfirmed) return;
  }
  // `opts.force` means the caller has already taken ownership of the buffer (see
  // moveTabToPanel), so neither the close prompt nor the discard prompt applies.
  // A passed pin confirm already covers the generic close prompt — no double dialog.
  if (settings.confirmclose && !opts.force && !pinConfirmed) {
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
  // Remember for Ctrl+Shift+T — after the confirms above, so a cancelled
  // close never lands in the reopen stack. Handoffs via moveTabToPanel pass
  // noReopen:true (the file moved, it wasn't closed).
  if (!opts.noReopen) pushClosedTab(tab);
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
  tab.term?.dispose();
  try { if (tab.iframe) tab.iframe.src = 'about:blank'; } catch {}
  tab.el?.remove();
  tab.wrapper?.remove();
  // Kill the backing session (tmux or in-memory) so it doesn't pile up (terminals only)
  if (!isPreview && !isFile && tab.sessionId) api(`/api/sessions/${tab.sessionId}`, { method: 'DELETE' });
  tabs = tabs.filter(t => t.id !== id);
  saveTabState();
  try { hideTabMenus(); } catch {}
  if (activeTabId === id && tabs.length > 0) activateTab(tabs[tabs.length - 1].id);
  else updateTabOverflow();
  try { if (typeof refreshConnStatus === 'function') refreshConnStatus(); } catch {}
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
  updateTabOverflow();
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
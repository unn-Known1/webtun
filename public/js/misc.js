// WebTun frontend - misc.js (bookmarks, finder, cmglib/history, sys stats, PWA, boot.)

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

// Backdrop for the Command Library: block the workspace behind the panel
// while its keyboard focus trap is engaged. #content is deliberately NOT
// inerted — the panel lives inside it, so that would disable the panel
// itself. #header stays interactive (same rule as Settings).
function setCmdLibInert(on) {
  ['sidebar', 'terminals'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    try { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } catch {}
  });
}

function toggleCmdLib() {
  const panel = document.getElementById('cmd-lib-panel');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open');
  panel.setAttribute('role', 'dialog');
  // aria-modal only while open: leaving "false" behind mislabels the closed
  // drawer for audits.
  if (!isOpen) panel.setAttribute('aria-modal', 'true');
  else panel.removeAttribute('aria-modal');
  document.getElementById('cmd-lib-toggle').classList.toggle('active', !isOpen);
  document.getElementById('cmd-lib-toggle').setAttribute('aria-expanded', String(!isOpen));
  if (!isOpen) {
    loadHistMax();
    switchCmdTab('library');
    setCmdLibInert(true);
    installFocusTrap(panel);
    setTimeout(() => {
      document.addEventListener('click', closeCmdLibOnClickOutside, true);
      panel.querySelector('input, button')?.focus();
    }, 50);
  } else {
    setCmdLibInert(false);
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
  setCmdLibInert(false);
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
let _histChain = Promise.resolve();
function _histEnqueue(fn) {
  _histChain = _histChain.then(fn, fn);
  return _histChain;
}
async function addToCmdHist(cmd) {
  if (!cmd || !cmd.trim()) return;
  return _histEnqueue(async () => {
  // Strip all ANSI/VT escape sequences and control characters
  const clean = cmd
    .replace(/\x1b[^a-zA-Z0-9]*[a-zA-Z0-9~]/g, '')       // CSI: ESC [ ... final
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')    // OSC: ESC ] ... BEL/ST
    .replace(/\x1b[OPP][^\x40-\x7e]*[\x40-\x7e]/g, '')    // SS3/DCS: ESC O/P ... final
    .replace(/\x1b./g, '')                                   // Any other ESC sequence
    .replace(/[\x00-\x1f\x7f]/g, '')                        // All remaining control chars
    .replace(/^[>][0-9;? ]+c(?=[a-zA-Z/\\~\-.])/, '')        // device-attr reply (e.g. >0;276;0c) before a command char
    .replace(/^[>][0-9;? ]+c$/, '')                            // pure device-attr reply, no command at all
    .trim();
  if (!clean) return;
  try {
    await fetch('/api/history', { method: 'POST', headers: histHeaders(), body: JSON.stringify({ cmd: clean, max: cmdHistMax }) });
    await getCmdHist();
  } catch {}
  });
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
  // Max-only update: no cmd key at all, so a blind-append server can never
  // store a blank row (the old {cmd:''} polluted history).
  return _histEnqueue(async () => {
    try {
      await fetch('/api/history', { method: 'POST', headers: histHeaders(), body: JSON.stringify({ max: cmdHistMax }) });
      await getCmdHist();
    } catch {}
  });
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
  // File tabs own their buffers (tab.cm vs tab.original); parked tabs hold a
  // crash-safety draft. The panel check alone missed all of them.
  let fileDirty = false;
  try {
    fileDirty = tabs.some(t => {
      if (!t || t.type !== 'file' || t.closed) return false;
      if (t.cm) return t.cm.getValue() !== t.original;
      try { return typeof loadDraft === 'function' && loadDraft(t.path) != null; } catch { return false; }
    });
  } catch {}
  const hasActiveSessions = tabs.some(t => t.ws && t.ws.readyState === WebSocket.OPEN);
  if (editorDirty || fileDirty || hasActiveSessions) {
    e.preventDefault();
    e.returnValue = '';
  }
});
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

let _activeCmdCat = 'all';
let _editingCmdOriginal = null;

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
  const toggleBtn = document.getElementById('cmd-lib-toggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', !isOpen);
    toggleBtn.setAttribute('aria-expanded', String(!isOpen));
  }
  if (!isOpen) {
    loadHistMax();
    switchCmdTab('library');
    setCmdLibInert(true);
    installFocusTrap(panel);
    setTimeout(() => {
      document.addEventListener('click', closeCmdLibOnClickOutside, true);
      document.getElementById('cmd-lib-search')?.focus();
    }, 50);
  } else {
    cancelEditCustomCmd();
    setCmdLibInert(false);
    removeFocusTrap();
    document.removeEventListener('click', closeCmdLibOnClickOutside, true);
  }
}

function closeCmdLibOnClickOutside(e) {
  const panel = document.getElementById('cmd-lib-panel');
  const btn = document.getElementById('cmd-lib-toggle');
  if (!panel || !panel.classList.contains('open')) {
    document.removeEventListener('click', closeCmdLibOnClickOutside, true);
    return;
  }
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  toggleCmdLib();
  setCmdLibInert(false);
  removeFocusTrap();
}

function onCmdSearchInput() {
  const q = document.getElementById('cmd-lib-search')?.value || '';
  const clearBtn = document.getElementById('cmd-search-clear-btn');
  if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';
  const isHist = document.getElementById('cmd-tab-hist')?.classList.contains('active');
  if (isHist) {
    renderCmdHist();
  } else {
    renderCmdLib();
  }
}

function clearCmdSearch() {
  const search = document.getElementById('cmd-lib-search');
  if (search) {
    search.value = '';
    search.focus();
  }
  const clearBtn = document.getElementById('cmd-search-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
  const isHist = document.getElementById('cmd-tab-hist')?.classList.contains('active');
  if (isHist) renderCmdHist();
  else renderCmdLib();
}

function selectCmdCategory(cat) {
  _activeCmdCat = cat;
  renderCmdLib();
}

function copyCmdText(text, btn) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      copyFallback(text);
    });
  } else {
    copyFallback(text);
  }
  if (btn) {
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = origHtml;
      btn.classList.remove('copied');
    }, 1500);
  }
  toast('Copied to clipboard', 'info');
}

function copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
}

function pasteCmdToTerminal(cmd) {
  const tab = getActiveTab();
  if (!tab || !tab.term) {
    toast('No active terminal to paste into', 'warning');
    return;
  }
  tab.term.focus();
  tab.term.paste(cmd);
  toggleCmdLib();
  toast('Command pasted into terminal', 'info');
}

function renderCmdLib(filter) {
  const list = document.getElementById('cmd-lib-list');
  if (!list) return;
  const custom = getCmdLib();
  const q = (filter !== undefined ? filter : (document.getElementById('cmd-lib-search')?.value || '')).toLowerCase().trim();
  const all = defaultCmds().concat(custom.map(c => ({ ...c, custom: true })));

  // Update Library Tab badge count
  const countBadge = document.getElementById('cmd-lib-count');
  if (countBadge) countBadge.textContent = all.length;

  // Build category list with item counts
  const catCounts = { 'all': all.length };
  const catList = new Set();
  all.forEach(c => {
    const cat = c.cat || (c.custom ? 'My Commands' : 'Other');
    catList.add(cat);
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  });

  // Populate datalist for category autocomplete
  const datalist = document.getElementById('cmd-cat-datalist');
  if (datalist) {
    datalist.innerHTML = '';
    catList.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      datalist.appendChild(opt);
    });
  }

  // Render category chips
  const chipsContainer = document.getElementById('cmd-lib-cat-chips');
  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    const allChip = document.createElement('button');
    allChip.className = 'cmd-cat-chip' + (_activeCmdCat === 'all' ? ' active' : '');
    allChip.innerHTML = `All <span class="chip-count">${all.length}</span>`;
    allChip.onclick = () => selectCmdCategory('all');
    chipsContainer.appendChild(allChip);

    Array.from(catList).sort().forEach(cat => {
      const chip = document.createElement('button');
      chip.className = 'cmd-cat-chip' + (_activeCmdCat === cat ? ' active' : '');
      chip.innerHTML = `${escapeHtml(cat)} <span class="chip-count">${catCounts[cat] || 0}</span>`;
      chip.onclick = () => selectCmdCategory(cat);
      chipsContainer.appendChild(chip);
    });
  }

  // Filter commands by query and selected category
  const filtered = all.filter(c => {
    const cat = c.cat || (c.custom ? 'My Commands' : 'Other');
    if (_activeCmdCat !== 'all' && cat !== _activeCmdCat) return false;
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.cmd.toLowerCase().includes(q) || cat.toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div id="cmd-lib-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.4;margin-bottom:8px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <div>No matching commands found</div>
        ${q ? `<button class="btn btn-sm" style="margin-top:8px" onclick="clearCmdSearch()">Clear Search</button>` : ''}
      </div>
    `;
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

    const header = document.createElement('div');
    header.className = 'cmd-lib-section-header';
    const title = document.createElement('span');
    title.className = 'cmd-lib-section-title';
    title.textContent = cat;
    const countSpan = document.createElement('span');
    countSpan.className = 'cmd-lib-section-count';
    countSpan.textContent = cats[cat].length;
    header.appendChild(title);
    header.appendChild(countSpan);
    section.appendChild(header);

    cats[cat].forEach(c => {
      const item = document.createElement('div');
      item.className = 'cmd-lib-item' + (c.custom ? ' is-custom' : '');
      item.title = `${c.name} — Click to paste into terminal`;

      const mainWrap = document.createElement('div');
      mainWrap.className = 'cmd-lib-main';

      const topRow = document.createElement('div');
      topRow.className = 'cmd-lib-top-row';

      const name = document.createElement('span');
      name.className = 'cmd-lib-name';
      name.textContent = c.name;
      topRow.appendChild(name);

      if (c.custom) {
        const customBadge = document.createElement('span');
        customBadge.className = 'cmd-badge-custom';
        customBadge.textContent = 'Custom';
        topRow.appendChild(customBadge);
      }

      const catBadge = document.createElement('span');
      catBadge.className = 'cmd-badge-cat';
      catBadge.textContent = cat;
      topRow.appendChild(catBadge);

      mainWrap.appendChild(topRow);

      const codeBox = document.createElement('div');
      codeBox.className = 'cmd-lib-cmd-wrap';
      const cmd = document.createElement('code');
      cmd.className = 'cmd-lib-cmd';
      cmd.textContent = c.cmd;
      codeBox.appendChild(cmd);
      mainWrap.appendChild(codeBox);

      item.appendChild(mainWrap);

      // Actions cluster
      const actions = document.createElement('div');
      actions.className = 'cmd-lib-actions';

      // Run button
      const runBtn = document.createElement('button');
      runBtn.className = 'cmd-action-btn cmd-lib-run';
      runBtn.title = 'Run in terminal';
      runBtn.setAttribute('aria-label', `Run ${c.name}`);
      runBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>';
      runBtn.addEventListener('click', e => {
        e.stopPropagation();
        runCmdLib(c.cmd);
      });
      actions.appendChild(runBtn);

      // Paste button
      const pasteBtn = document.createElement('button');
      pasteBtn.className = 'cmd-action-btn cmd-lib-paste';
      pasteBtn.title = 'Paste into terminal';
      pasteBtn.setAttribute('aria-label', `Paste ${c.name}`);
      pasteBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>';
      pasteBtn.addEventListener('click', e => {
        e.stopPropagation();
        pasteCmdToTerminal(c.cmd);
      });
      actions.appendChild(pasteBtn);

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'cmd-action-btn cmd-lib-copy';
      copyBtn.title = 'Copy command';
      copyBtn.setAttribute('aria-label', `Copy ${c.name}`);
      copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      copyBtn.addEventListener('click', e => {
        e.stopPropagation();
        copyCmdText(c.cmd, copyBtn);
      });
      actions.appendChild(copyBtn);

      if (c.custom) {
        // Edit button
        const editBtn = document.createElement('button');
        editBtn.className = 'cmd-action-btn cmd-lib-edit';
        editBtn.title = 'Edit command';
        editBtn.setAttribute('aria-label', `Edit ${c.name}`);
        editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
        editBtn.addEventListener('click', e => {
          e.stopPropagation();
          editCustomCmd(c);
        });
        actions.appendChild(editBtn);

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'cmd-action-btn cmd-lib-del';
        delBtn.title = 'Delete command';
        delBtn.setAttribute('aria-label', `Delete ${c.name}`);
        delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          deleteCustomCmd(c.name, c.cmd);
        });
        actions.appendChild(delBtn);
      }

      item.appendChild(actions);

      // Clicking whole item pastes to terminal
      item.addEventListener('click', () => {
        pasteCmdToTerminal(c.cmd);
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
  toast('Running: ' + (cmd.length > 30 ? cmd.slice(0, 30) + '…' : cmd), 'info');
}

function saveCustomCmdFromForm() {
  const nameInput = document.getElementById('cmd-lib-name-input');
  const catInput = document.getElementById('cmd-lib-cat-input');
  const cmdInput = document.getElementById('cmd-lib-cmd-input');
  const name = (nameInput?.value || '').trim();
  const cat = (catInput?.value || '').trim() || 'My Commands';
  const cmd = (cmdInput?.value || '').trim();

  if (!cmd) {
    toast('Please enter a command string', 'error');
    cmdInput?.focus();
    return;
  }

  let custom = getCmdLib();

  if (_editingCmdOriginal) {
    // Updating existing command
    custom = custom.filter(c => !(c.name === _editingCmdOriginal.name && c.cmd === _editingCmdOriginal.cmd));
    custom.push({ name: name || cmd, cmd, cat });
    saveCmdLib(custom);
    cancelEditCustomCmd();
    renderCmdLib();
    toast('Command updated', 'success');
  } else {
    // Adding new command
    if (custom.some(c => c.name === name && c.cmd === cmd)) {
      toast('Command already exists in library', 'info');
      return;
    }
    custom.push({ name: name || cmd, cmd, cat });
    saveCmdLib(custom);
    if (nameInput) nameInput.value = '';
    if (catInput) catInput.value = '';
    if (cmdInput) cmdInput.value = '';
    renderCmdLib();
    toast('Command saved to library', 'success');
  }
}

function addCustomCmd() {
  saveCustomCmdFromForm();
}

function editCustomCmd(c) {
  _editingCmdOriginal = { name: c.name, cmd: c.cmd, cat: c.cat || 'My Commands' };
  const nameInput = document.getElementById('cmd-lib-name-input');
  const catInput = document.getElementById('cmd-lib-cat-input');
  const cmdInput = document.getElementById('cmd-lib-cmd-input');
  const saveBtn = document.getElementById('cmd-lib-save-btn');
  const cancelBtn = document.getElementById('cmd-lib-cancel-edit-btn');

  if (nameInput) nameInput.value = c.name;
  if (catInput) catInput.value = c.cat || 'My Commands';
  if (cmdInput) cmdInput.value = c.cmd;
  if (saveBtn) saveBtn.textContent = 'Update';
  if (cancelBtn) cancelBtn.style.display = '';

  cmdInput?.focus();
  cmdInput?.select();
}

function cancelEditCustomCmd() {
  _editingCmdOriginal = null;
  const nameInput = document.getElementById('cmd-lib-name-input');
  const catInput = document.getElementById('cmd-lib-cat-input');
  const cmdInput = document.getElementById('cmd-lib-cmd-input');
  const saveBtn = document.getElementById('cmd-lib-save-btn');
  const cancelBtn = document.getElementById('cmd-lib-cancel-edit-btn');

  if (nameInput) nameInput.value = '';
  if (catInput) catInput.value = '';
  if (cmdInput) cmdInput.value = '';
  if (saveBtn) saveBtn.textContent = 'Add';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

function deleteCustomCmd(name, cmd) {
  let custom = getCmdLib();
  custom = custom.filter(c => !(c.name === name && c.cmd === cmd));
  saveCmdLib(custom);
  if (_editingCmdOriginal && _editingCmdOriginal.name === name && _editingCmdOriginal.cmd === cmd) {
    cancelEditCustomCmd();
  }
  renderCmdLib();
  toast('Command removed', 'info');
}

function exportCmdLibrary() {
  const custom = getCmdLib();
  if (!custom || !custom.length) {
    toast('No custom commands to export. Add some first!', 'info');
    return;
  }
  const data = JSON.stringify(custom, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webtun-commands-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Exported ${custom.length} custom commands`, 'success');
}

function triggerImportCmdLib() {
  const input = document.getElementById('cmd-lib-file-input');
  if (input) {
    input.value = '';
    input.click();
  }
}

function importCmdLibFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed)) {
        toast('Invalid format: JSON must be an array of commands', 'error');
        return;
      }
      let valid = 0;
      const custom = getCmdLib();
      parsed.forEach(item => {
        if (item && item.cmd && typeof item.cmd === 'string') {
          const name = (item.name && typeof item.name === 'string') ? item.name : item.cmd;
          const cat = (item.cat && typeof item.cat === 'string') ? item.cat : 'Imported';
          if (!custom.some(c => c.name === name && c.cmd === item.cmd)) {
            custom.push({ name, cmd: item.cmd, cat });
            valid++;
          }
        }
      });
      if (valid > 0) {
        saveCmdLib(custom);
        renderCmdLib();
        toast(`Imported ${valid} new command${valid === 1 ? '' : 's'}`, 'success');
      } else {
        toast('No new unique commands found in file', 'info');
      }
    } catch (err) {
      toast('Failed to parse JSON file', 'error');
    }
  };
  reader.readAsText(file);
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
    const histCountBadge = document.getElementById('cmd-hist-count');
    if (histCountBadge) histCountBadge.textContent = _cmdHistCache.length;
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
    const isHist = document.getElementById('cmd-tab-hist')?.classList.contains('active');
    if (isHist) renderCmdHist();
  } catch {}
  });
}
async function removeCmdHistItem(idx) {
  try {
    await fetch('/api/history/' + idx, { method: 'DELETE', headers: histHeadersDelete() });
    await getCmdHist();
    renderCmdHist();
    toast('History item removed', 'info');
  } catch {}
}
async function clearCmdHist() {
  try {
    await fetch('/api/history', { method: 'DELETE', headers: histHeadersDelete() });
    _cmdHistCache = [];
    renderCmdHist();
    const histCountBadge = document.getElementById('cmd-hist-count');
    if (histCountBadge) histCountBadge.textContent = '0';
    toast('History cleared', 'info');
  } catch {}
}
async function confirmClearCmdHist() {
  const ok = await confirmDialog({
    title: 'Clear History',
    message: 'Are you sure you want to clear all command history?',
    okText: 'Clear All',
    cancelText: 'Cancel',
    danger: true
  });
  if (ok) clearCmdHist();
}
async function updateHistMax(val) {
  cmdHistMax = Math.max(10, Math.min(500, val || 50));
  // Max-only update: no cmd key at all, so a blind-append server can never
  // store a blank row (the old {cmd:''} polluted history).
  return _histEnqueue(async () => {
    try {
      await fetch('/api/history', { method: 'POST', headers: histHeaders(), body: JSON.stringify({ max: cmdHistMax }) });
      await getCmdHist();
      toast('History limit updated', 'info');
    } catch {}
  });
}
function exportCmdHist() {
  if (!_cmdHistCache || !_cmdHistCache.length) {
    toast('No command history to export', 'info');
    return;
  }
  const lines = _cmdHistCache.map(h => h.cmd).join('\n');
  const blob = new Blob([lines], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webtun-history-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Exported ${_cmdHistCache.length} history commands`, 'success');
}
function saveHistToLibrary(cmd) {
  if (!cmd) return;
  const custom = getCmdLib();
  if (custom.some(c => c.cmd === cmd)) {
    toast('Command already saved in Library', 'info');
    switchCmdTab('library');
    return;
  }
  const defaultName = cmd.length > 28 ? cmd.slice(0, 28) + '…' : cmd;
  custom.push({ name: defaultName, cmd, cat: 'Saved from History' });
  saveCmdLib(custom);
  toast('Saved to Library ("Saved from History")', 'success');
  const countBadge = document.getElementById('cmd-lib-count');
  if (countBadge) countBadge.textContent = defaultCmds().length + custom.length;
}
function switchCmdTab(tab) {
  const libBtn = document.getElementById('cmd-tab-lib');
  const histBtn = document.getElementById('cmd-tab-hist');
  const libList = document.getElementById('cmd-lib-list');
  const histList = document.getElementById('cmd-hist-list');
  const chipsContainer = document.getElementById('cmd-lib-cat-chips');
  const histHeader = document.getElementById('cmd-hist-header');
  const footer = document.getElementById('cmd-lib-footer');
  const search = document.getElementById('cmd-lib-search');
  const clearBtn = document.getElementById('cmd-search-clear-btn');

  if (tab === 'library') {
    libBtn.classList.add('active'); libBtn.setAttribute('aria-selected','true');
    histBtn.classList.remove('active'); histBtn.setAttribute('aria-selected','false');
    libList.style.display = '';
    histList.style.display = 'none';
    if (chipsContainer) chipsContainer.style.display = 'flex';
    histHeader.style.display = 'none';
    footer.style.display = '';
    if (search) search.placeholder = 'Search commands by name, syntax, or category…';
    renderCmdLib();
  } else {
    histBtn.classList.add('active'); histBtn.setAttribute('aria-selected','true');
    libBtn.classList.remove('active'); libBtn.setAttribute('aria-selected','false');
    histList.style.display = 'flex';
    histList.setAttribute('aria-live','polite');
    libList.style.display = 'none';
    if (chipsContainer) chipsContainer.style.display = 'none';
    histHeader.style.display = 'flex';
    footer.style.display = 'none';
    if (search) search.placeholder = 'Search executed command history…';
    renderCmdHist();
  }
  if (search) {
    search.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    search.focus();
  }
}
async function renderCmdHist() {
  const list = document.getElementById('cmd-hist-list');
  if (!list) return;
  const hist = await getCmdHist();
  const q = (document.getElementById('cmd-lib-search')?.value || '').toLowerCase().trim();
  const filtered = q ? hist.filter(h => h.cmd.toLowerCase().includes(q)) : hist;

  const histCountBadge = document.getElementById('cmd-hist-count');
  if (histCountBadge) histCountBadge.textContent = hist.length;

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = `
      <div id="cmd-hist-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.4;margin-bottom:8px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <div>${q ? 'No matching commands in history' : 'No commands run yet'}</div>
        ${q ? `<button class="btn btn-sm" style="margin-top:8px" onclick="clearCmdSearch()">Clear Search</button>` : ''}
      </div>
    `;
    return;
  }

  filtered.forEach((h, i) => {
    const realIdx = q ? hist.indexOf(h) : i;
    const item = document.createElement('div');
    item.className = 'cmd-hist-item';
    item.title = `${h.cmd}\nExecuted ${new Date(h.time).toLocaleString()}`;

    const mainWrap = document.createElement('div');
    mainWrap.className = 'cmd-hist-main';

    const cmdSpan = document.createElement('code');
    cmdSpan.className = 'cmd-hist-cmd';
    cmdSpan.textContent = h.cmd;
    mainWrap.appendChild(cmdSpan);

    const metaRow = document.createElement('div');
    metaRow.className = 'cmd-hist-meta';

    if (h.count > 1) {
      const countPill = document.createElement('span');
      countPill.className = 'cmd-hist-count-pill';
      countPill.textContent = `×${h.count} runs`;
      metaRow.appendChild(countPill);
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'cmd-hist-time';
    const ago = Date.now() - h.time;
    const formattedDate = new Date(h.time).toLocaleString();
    timeSpan.title = formattedDate;
    timeSpan.textContent = ago < 60000 ? 'just now' : ago < 3600000 ? Math.floor(ago / 60000) + 'm ago' : ago < 86400000 ? Math.floor(ago / 3600000) + 'h ago' : new Date(h.time).toLocaleDateString();
    metaRow.appendChild(timeSpan);

    mainWrap.appendChild(metaRow);
    item.appendChild(mainWrap);

    // Actions cluster
    const actions = document.createElement('div');
    actions.className = 'cmd-hist-actions-cluster';

    // Run button
    const runBtn = document.createElement('button');
    runBtn.className = 'cmd-action-btn cmd-hist-run';
    runBtn.title = 'Run in terminal';
    runBtn.setAttribute('aria-label', `Run ${h.cmd}`);
    runBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>';
    runBtn.addEventListener('click', e => {
      e.stopPropagation();
      runCmdLib(h.cmd);
    });
    actions.appendChild(runBtn);

    // Paste button
    const pasteBtn = document.createElement('button');
    pasteBtn.className = 'cmd-action-btn cmd-hist-paste';
    pasteBtn.title = 'Paste into terminal';
    pasteBtn.setAttribute('aria-label', `Paste ${h.cmd}`);
    pasteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>';
    pasteBtn.addEventListener('click', e => {
      e.stopPropagation();
      pasteCmdToTerminal(h.cmd);
    });
    actions.appendChild(pasteBtn);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'cmd-action-btn cmd-hist-copy';
    copyBtn.title = 'Copy command';
    copyBtn.setAttribute('aria-label', `Copy ${h.cmd}`);
    copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      copyCmdText(h.cmd, copyBtn);
    });
    actions.appendChild(copyBtn);

    // Save to Library button
    const starBtn = document.createElement('button');
    starBtn.className = 'cmd-action-btn cmd-hist-star';
    starBtn.title = 'Save to Library';
    starBtn.setAttribute('aria-label', `Save ${h.cmd} to Library`);
    starBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    starBtn.addEventListener('click', e => {
      e.stopPropagation();
      saveHistToLibrary(h.cmd);
    });
    actions.appendChild(starBtn);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'cmd-action-btn cmd-hist-del';
    delBtn.title = 'Remove from history';
    delBtn.setAttribute('aria-label', 'Remove from history');
    delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeCmdHistItem(realIdx);
    });
    actions.appendChild(delBtn);

    item.appendChild(actions);

    item.addEventListener('click', () => {
      pasteCmdToTerminal(h.cmd);
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
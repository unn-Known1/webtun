// WebTun frontend - file-tabs.js (file tabs (dock/undock, per-tab editor + preview).)

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
  // One-shot handoff flag: consumed above, never sticky for later docks.
  try { tab._cameFromPanel = false; } catch (_) {}
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
    } else if (tab.viewer === 'epub') {
      try {
        const loc = _epubRendition && _epubRendition.location;
        const cfi = loc && loc.start && loc.start.cfi ? loc.start.cfi : null;
        tab.viewState = cfi ? { cfi } : null;
      } catch { tab.viewState = null; }
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
      // Restore the reading position captured by captureFileTabState.
      if (s && s.cfi && _epubRendition) {
        try { await _epubRendition.display(s.cfi); } catch (_) {}
      }
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
    const sid = tab.id;
    setTimeout(() => { try { if (tab.closed || _dockedFileTabId !== sid) return; document.getElementById('pdf-wrap-' + s.page)?.scrollIntoView(); } catch (_) {} }, 450);
  } else if (tab.viewer === 'office' && s) {
    const sid = tab.id;
    setTimeout(() => {
      try {
        if (tab.closed || _dockedFileTabId !== sid) return;
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
  // Disk revision this buffer came from — the open-file watcher compares fresh
  // stats against it (null = unknown, adopt silently on first poll).
  tab.diskMtime = data.mtime != null ? String(data.mtime) : null;
  tab.diskSize = typeof data.size === 'number' ? data.size : null;
  tab.extChanged = false;
  if (data.history) { try { cm.setHistory(data.history); } catch (e) { console.warn('Undo history restore failed:', e); } }
  if (data.cursor) { try { cm.setCursor(data.cursor); } catch {} }
  cm.on('change', () => { markTabDirty(tab); scheduleTabDraft(tab); scheduleTabPreview(tab); });
  markTabDirty(tab);
  if (data.extChanged) setTabExtChanged(tab, true);
  try { cm.setOption('mode', await resolveCMmode(fileTabName(tab.path))); } catch (e) { console.warn('Mode resolve failed:', e); }
  return !tab.closed;
}

// Persistent "changed on disk" indicator for a dirty tab whose file moved
// underneath it: cyan ring on the dot, amber note in the toolbar (clickable —
// reloads), cyan marker on the tab strip. Cleared by save/reload/close.
function setTabExtChanged(tab, on, msg) {
  if (!tab) return;
  on = !!on;
  const was = !!tab.extChanged;
  tab.extChanged = on;
  if (tab.fteDot) {
    tab.fteDot.classList.toggle('ext', on);
    tab.fteDot.setAttribute('aria-label', on ? 'File changed on disk'
      : (tab.dirty ? 'Unsaved changes' : 'No unsaved changes'));
  }
  try { tab.el?.classList.toggle('has-ext', on); } catch {}
  if (tab.fteStatus) {
    if (on) {
      const text = msg || EXT_CHANGED_MSG;
      if (!was || tab.fteStatus.textContent !== text) tab.fteStatus.textContent = text;
      tab.fteStatus.classList.add('ext');
      tab.fteStatus.title = 'Re-read the file from disk (asks before discarding edits)';
      tab.fteStatus.setAttribute('role', 'button');
      tab.fteStatus.tabIndex = 0;
      tab.fteStatus.onclick = () => reloadTabFile(tab);
    } else {
      if (was || tab.fteStatus.classList.contains('ext')) tab.fteStatus.textContent = '';
      tab.fteStatus.classList.remove('ext');
      tab.fteStatus.title = '';
      tab.fteStatus.removeAttribute('role');
      tab.fteStatus.tabIndex = -1;
      tab.fteStatus.onclick = null;
    }
  }
}

// Transient toolbar word that never wipes the persistent external-change note.
function flashTabStatus(tab, text) {
  if (!tab?.fteStatus || tab.extChanged) return;
  tab.fteStatus.textContent = text;
  setTimeout(() => { if (!tab.extChanged && tab.fteStatus) tab.fteStatus.textContent = ''; }, 2000);
}

async function refreshTabDiskSnapshot(tab) {
  if (!tab?.path) return;
  try {
    const s = await api(`/api/files/stat?path=${encodeURIComponent(tab.path)}`);
    if (s && !s.error && s.mtime !== undefined) {
      tab.diskMtime = String(s.mtime);
      tab.diskSize = s.size;
    }
  } catch {}
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
async function renderTabPreview(tab) {
  if (!tab || !tab.cm || !tab.previewOn) return;
  const kind = tabPreviewKind(tab);
  if (!kind) return;
  const raw = tab.cm.getValue();
  const baseDir = tabBaseDir(tab.path);
  const isDark = tabIsDark();
  // Like the panel: frame-readable preview DOM carries a scoped preview token,
  // never the session. Fail closed when authed but minting fails.
  let ptok = null;
  try {
    ptok = await mintPreviewFileToken(tab.path);
  } catch (e) {
    try { toast('Preview unavailable: ' + ((e && e.message) || 'unknown error'), 'error'); } catch {}
    if (kind === 'md') {
      try { if (tab.fteMd) tab.fteMd.innerHTML = '<p style="padding:16px">Preview unavailable — could not authorize file assets (' + escHtml((e && e.message) || 'unknown error') + ').</p>'; } catch {}
    } else {
      try { if (tab.fteFrame) setTabPreviewDoc(tab, tab.fteFrame, '<p style="font-family:sans-serif;padding:16px">Preview unavailable — could not authorize file assets (' + escHtml((e && e.message) || 'unknown error') + ').</p>'); } catch {}
    }
    return;
  }
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
      sanitized = rewriteHtmlRelativeUrls(sanitized, baseDir, ptok);
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
    const baseHref = `/api/files/image?path=${encodeURIComponent(baseDir + '/')}` + (ptok ? `&ptoken=${encodeURIComponent(ptok)}` : '');
    const injectHead = (doc, tags) => /<head[^>]*>/i.test(doc)
      ? doc.replace(/<head[^>]*>/i, m => m + tags)
      : doc.replace(/<html[^>]*>/i, m => m + '<head>' + tags + '</head>');
    const isFullDoc = /<!DOCTYPE|<html[\s>]/i.test(raw);
    if (tab.htmlFull) {
      // FULL mode mirrors the panel: author's bytes verbatim inside the same
      // opaque-origin sandbox (allow-scripts only). Needs no sanitizer CDN.
      let doc;
      if (isFullDoc) {
        doc = rewriteFullHtmlUrls(raw, baseDir, ptok);
        if (!/<base\b/i.test(doc)) doc = injectHead(doc, `<base href="${escHtml(baseHref)}">`);
        if (!/<meta[^>]*color-scheme/i.test(doc)) doc = injectHead(doc, `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
      } else {
        doc = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">\n<base href="${escHtml(baseHref)}">\n</head>\n<body>${rewriteFullHtmlUrls(raw, baseDir, ptok)}</body>\n</html>`;
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
      sanitized = rewriteHtmlRelativeUrls(sanitized, baseDir, ptok);
      if (!/<base\b/i.test(sanitized)) sanitized = injectHead(sanitized, `<base href="${escHtml(baseHref)}">`);
      if (!/<meta[^>]*color-scheme/i.test(sanitized)) sanitized = injectHead(sanitized, `<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}">`);
      doc = sanitized;
    } else {
      const fragment = rewriteHtmlRelativeUrls(DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] }), baseDir, ptok);
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
    tab.fteDot.setAttribute('aria-label', tab.extChanged ? 'File changed on disk'
      : (dirty ? 'Unsaved changes' : 'No unsaved changes'));
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
  let r = null, content = '';
  try {
    content = tab.cm.getValue();
    r = await api('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content }),
    });
  } finally {
    // Always release the busy state, even if the request throws.
    setBtnBusy(tab.fteSaveBtn, false);
  }
  if (r && r.success) {
    tab.original = content;
    clearTimeout(tab.draftTimer);
    removeDraft(tab.path);
    await refreshTabDiskSnapshot(tab);
    setTabExtChanged(tab, false);
    markTabDirty(tab);
    flashTabStatus(tab, 'Saved');
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
  if (r.mtime != null) tab.diskMtime = String(r.mtime);
  if (typeof r.length === 'number') tab.diskSize = r.length;
  setTabExtChanged(tab, false);
  markTabDirty(tab);
  flashTabStatus(tab, 'Reloaded');
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
  const diskMtime = tab.diskMtime, diskSize = tab.diskSize, wasExt = tab.extChanged;
  await closeTab({ stopPropagation() {} }, tab.id, { force: true });
  await showTextInPanel(path, content, original, history, diskMtime, diskSize);
  if (wasExt) setPanelExtChanged(true);
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
    tab.seed = { content: editor.getValue(), original: editorOriginalContent, history: editor.getHistory(), cursor: editor.getCursor(), mtime: editorDiskMtime, size: editorDiskSize, extChanged: editorExtChanged };
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
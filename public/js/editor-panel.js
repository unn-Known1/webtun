// WebTun frontend - editor-panel.js (split-panel CodeMirror, drafts, save/close.)

// ═══════════════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════════════
const MAX_EDITOR_SIZE = 10 * 1024 * 1024; // 10MB
let editor = null;
let mdPreviewActive = false;
// On-disk snapshot for external-change detection: the mtime/size the open
// buffer was read from (or last saved to). The open-file watcher compares fresh
// stats against these; null means unknown — adopt silently, never flag.
let _panelStatusTimer = null;
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

async function initCodeMirror() {
  if (editor) return editor;
  const loaded = typeof ensureCodeMirrorLoaded === 'function' ? await ensureCodeMirrorLoaded() : (typeof CodeMirror !== 'undefined');
  if (!loaded || typeof CodeMirror === 'undefined') return null;
  if (editor) return editor;
  const ta = document.getElementById('editor-textarea');
  if (!ta) return null;
  try {
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
  } catch (e) {
    console.warn('initCodeMirror failed:', e);
    return null;
  }
}
function panelContent() {
  return editor ? editor.getValue() : (document.getElementById('editor-textarea')?.value || '');
}
function installPanelContent(content) {
  if (editor) editor.setValue(content);
  else { const ta = document.getElementById('editor-textarea'); if (ta) ta.value = content; }
}
function autoSaveDraft() {
  const buffer = panelState.buffer;
  if (!buffer) return;
  buffer.setContent(panelContent());
  buffer.scheduleDraft();
}
function loadDraft(path) { return editorBuffers.readDraft(path); }
function removeDraft(path) { editorBuffers.removeDraft(path); }


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
  if (typeof CodeMirror === 'undefined') return false;
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
  // Stat first: byte size before the body, so a 500MB log is never fully
  // transferred just to ask "open anyway?". The byte size is also the disk
  // revision the watcher compares (chars-vs-bytes mismatches phantom-flagged).
  let statSize = null, statMtime = null;
  try {
    const st = await api(`/api/files/stat?path=${encodeURIComponent(path)}`);
    if (st && !st.error && typeof st.size === 'number') {
      statSize = st.size;
      statMtime = st.mtime != null ? String(st.mtime) : null;
      if (st.size > MAX_EDITOR_SIZE) {
        const ok = await confirmDialog({ title: 'Large file', message: `File is ${(st.size / 1024 / 1024).toFixed(1)}MB. Open anyway?`, okText: 'Open', danger: true });
        if (!ok) return null;
      }
    }
  } catch {}
  const r = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
  if (r.error) {
    if (r.isBinary) { toast(r.error || 'Preview not supported for binary files — use Download', 'warning'); return null; }
    toast(r.error, 'error'); return null;
  }
  if (statSize == null && r.length > MAX_EDITOR_SIZE) {
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
    if (restore) { content = draft; removeDraft(path); }
    else removeDraft(path);
  }
  return { content, original: r.content, mtime: r.mtime != null ? String(r.mtime) : (statMtime), size: statSize != null ? statSize : (typeof r.length === 'number' ? r.length : null), extChanged: false };
}

// Forget the panel's file without prompting. Used when a text buffer has been handed
// to a file tab: one path must never be editable in two surfaces at once (they would
// diverge, and last save wins). Only reachable while no heavy tab owns the panel.
function releasePanelSurface() {
  ++_panelGen;
  ++_panelOpenRequest;
  panelState.clear();
  panelState.path = '';
  panelState.original = '';
  panelState.diskMtime = null;
  panelState.diskSize = null;
  setPanelExtChanged(false);
  panelState.buffer?.cancelDraft();
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
  const request = ++_panelOpenRequest;
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
  if (panelState.path === path && panelState.buffer) { editor?.focus(); return; }
  if (panelState.buffer?.dirty) {
    const leave = await confirmDialog({ title: 'Unsaved changes', message: 'Open another file? Your current edits will be kept as a recovery draft.', okText: 'Keep draft and open', cancelText: 'Keep Editing' });
    if (!leave || request !== _panelOpenRequest) return;
  }
  if (isPdfFile(path)) { openPdfViewer(path); return; }
  if (isEpubFile(path)) { openEpubViewer(path); return; }
  if (isOfficeFile(path)) { openOfficeViewer(path); return; }
  if (isLegacyOfficeFile(path)) { toast('Legacy Office format — re-save as .docx/.xlsx (or .pdf) to preview, or use Download', 'warning'); return; }
  if (!canOpenInEditor(path)) { toast('Preview not supported for this file type — use Download', 'warning'); return; }
  const data = await readTextForEditor(path);
  if (!data || request !== _panelOpenRequest) return;
  await showTextInPanel(path, data.content, data.original, null, data.mtime, data.size);
}

// Put a text buffer into the split panel. `original` is the on-disk text the dirty
// check compares against (so a restored draft still reads as modified), and
// `history` carries undo state when a buffer moves from a file tab into the panel.
// `mtime`/`size` snapshot the disk revision the buffer came from, for the watcher.
let _panelGen = 0;
let _panelOpenRequest = 0;
async function showTextInPanel(path, content, original, history, mtime, size, incomingBuffer) {
  // Generation guard: two rapid opens interleave across the awaited mode
  // resolve below. Without it the first call resumes after the await and
  // writes buffer A into path B on the next Save.
  const myGen = ++_panelGen;
  const buffer = panelState.open(path, { content, original, mtime, size }, incomingBuffer);
  panelState.onChange = () => {
    paintEditorDirty();
    if (!buffer.extChanged) setPanelExtChanged(false);
  };
  const openContent = content;
  const sep = path.includes('\\') ? '\\' : '/';
  const fileName = path.split(sep).pop() || path;
  const isMd = /\.md$/i.test(fileName);
  const isHtml = /\.html?$/i.test(fileName);
  // hide doc viewers when opening text file
  cleanupDocViewers();
  document.getElementById('editor-save-btn').style.display = '';

  const cm = await initCodeMirror();
  if (myGen !== _panelGen || panelState.buffer !== buffer) return;
  if (cm) {
    const mode = await resolveCMmode(fileName);
    if (myGen !== _panelGen || panelState.buffer !== buffer) return;
    cm.setOption('mode', mode);
    cm.setValue(openContent);
    if (history) {
      try { cm.setHistory(history); } catch (e) { console.warn('Undo history restore failed:', e); }
    } else cm.clearHistory();
    cm.setOption('readOnly', false);
    const cmEl = document.querySelector('#editor-area .CodeMirror');
    if (cmEl) cmEl.style.display = '';
    try { cm.refresh(); } catch {}
  } else {
    const ta = document.getElementById('editor-textarea');
    if (ta) {
      ta.value = openContent;
      ta.readOnly = false;
      ta.style.display = 'block';
      ta.classList.add('editor-fallback');
      ta.oninput = () => { updateEditorDirty(); autoSaveDraft(); schedulePreviewLiveReload(); };
    }
  }
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
  // Markdown preview needs `marked`; resolve it before deciding whether to offer
  // the toggle, so a slow/failed script load can't silently hide the button.
  if (isMd && typeof marked === 'undefined' && typeof ensurePreviewLibs === 'function') {
    try { await ensurePreviewLibs('marked'); } catch {}
  }
  if (myGen !== _panelGen || panelState.buffer !== buffer) return;
  if (isMd || isHtml) {
    toggleBtn.style.display = '';
    setPreviewToggleState(false);
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
  } else {
    toggleBtn.style.display = 'none';
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
  }
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  setPanelExtChanged(false);

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
  if (cm) cm.focus(); else document.getElementById('editor-textarea')?.focus();

  // Fit all terminals to new available space
  requestAnimationFrame(() => {
    tabs.forEach(tab => { try { fitTerm(tab); } catch(e) { console.warn(e); } });
  });
}

async function refreshEditorDiskSnapshot(buffer) {
  if (!buffer || buffer.released) return;
  const path = buffer.path;
  try {
    const stat = await api('/api/files/stat?path=' + encodeURIComponent(path));
    if (!buffer.released && buffer.path === path && stat && !stat.error && stat.mtime !== undefined) {
      buffer.mtime = String(stat.mtime);
      buffer.size = stat.size;
    }
  } catch {}
}
async function saveEditorBuffer(buffer) {
  return buffer.save(async snapshot => {
    const result = await api('/api/files/write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
    });
    if (result && result.success && !buffer.released) {
      // Keep the watcher paused until the post-write disk revision is known.
      await refreshEditorDiskSnapshot(buffer);
      buffer.extChanged = buffer.missing = false;
    }
    return result;
  });
}
async function saveFile() {
  const buffer = panelState.buffer;
  if (!buffer) { toast('No editable file open', 'error'); return; }
  buffer.setContent(panelContent());
  const button = document.getElementById('editor-save-btn');
  setBtnBusy(button, true);
  try {
    const result = await saveEditorBuffer(buffer);
    if (!result || !result.success) { toast(result?.error || 'Save failed', 'error'); return; }
    if (panelState.buffer === buffer) {
      setPanelExtChanged(false);
      updateEditorDirty();
      flashPanelStatus(buffer.dirty ? 'Saved; newer edits are unsaved' : 'Saved');
      if (mdPreviewActive) refreshPreview();
    }
    toast('Saved ' + fileTabName(buffer.path), 'success');
    try { notifyPreviewFileSaved(); } catch {}
  } catch { toast('Save failed — your edits are kept', 'error'); }
  finally { if (panelState.buffer === buffer || !panelState.buffer?.saving) setBtnBusy(button, false); }
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
    const currentContent = panelContent();
    if (panelState.buffer && currentContent !== panelState.original) {
      const ok = await confirmDialog({ title: 'Unsaved changes', message: 'You have unsaved changes. Close anyway?', okText: 'Discard', cancelText: 'Keep Editing', danger: true });
      if (!ok) return;
      // Explicit discard: drop the crash-safety draft too, so it is not offered again.
      panelState.clear({ discard: true });
    }
    panelState.buffer?.cancelDraft();
  }
  ++_panelGen;
  ++_panelOpenRequest;
  panelState.clear();
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
  const cm = document.querySelector('#editor-area .CodeMirror');
  if (cm) cm.style.display = '';
  mdPreviewActive = false;
  panelState.path = '';
  panelState.original = '';
  panelState.diskMtime = null;
  panelState.diskSize = null;
  setPanelExtChanged(false);
  requestAnimationFrame(() => {
    tabs.forEach(tab => { try { fitTerm(tab); tab?.term?.focus(); } catch(e) { console.warn(e); } });
  });
}

// ═══════════════════════════════════════════════════════
// EXTERNAL-CHANGE WATCHER
// ═══════════════════════════════════════════════════════
// Nothing used to notice when a file changed on disk after opening: a clean
// buffer sat stale forever, and Save silently overwrote the other writer.
// Every 10s (plus on refocus) the open text buffers are statted. A clean
// buffer auto-reloads; a dirty one keeps the user's edits and raises a
// persistent "Changed on disk" indicator instead — clicking it reloads.
const EXT_CHANGED_MSG = 'Changed on disk — click to reload, Save to overwrite';
const EXT_MISSING_MSG = 'Deleted on disk — Save to recreate it';

function setPanelExtChanged(on, msg) {
  on = !!on;
  const was = panelState.extChanged;
  panelState.extChanged = on;
  const view = document.getElementById('editor-view');
  if (view) view.classList.toggle('editor-ext', on);
  const dot = document.getElementById('editor-ext-dot');
  if (dot) dot.setAttribute('aria-label', on ? 'File changed on disk' : 'No external changes');
  const st = document.getElementById('editor-status');
  if (!st) return;
  if (on) {
    const text = msg || EXT_CHANGED_MSG;
    if (!was || st.textContent !== text) st.textContent = text;
    st.classList.add('ext');
    st.title = 'Re-read the file from disk (asks before discarding edits)';
    st.setAttribute('role', 'button');
    st.tabIndex = 0;
    st.setAttribute('aria-live', 'polite');
    st.onclick = () => reloadPanelFile();
    st.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reloadPanelFile(); }
    };
  } else {
    if (was || st.classList.contains('ext')) st.textContent = '';
    st.classList.remove('ext');
    st.title = '';
    st.removeAttribute('role');
    st.tabIndex = -1;
    st.onclick = null;
    st.onkeydown = null;
  }
}

// Transient status word that never wipes the persistent external-change note.
function flashPanelStatus(text) {
  if (panelState.extChanged) return;
  const el = document.getElementById('editor-status');
  if (!el) return;
  el.textContent = text;
  clearTimeout(_panelStatusTimer);
  _panelStatusTimer = setTimeout(() => { if (!panelState.extChanged) el.textContent = ''; }, 2000);
}

async function refreshPanelDiskSnapshot() { await refreshEditorDiskSnapshot(panelState.buffer); }

// Raw disk read for refresh flows: Reload means disk, so it must never offer
// the crash draft again (same contract as reloadTabFile).
async function fetchDiskContent(path) {
  const r = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
  if (r.error) return { error: r.error };
  return { content: r.content, mtime: r.mtime != null ? String(r.mtime) : null, size: typeof r.length === 'number' ? r.length : null };
}

// The panel never had a Reload button; the "Changed on disk" status is its
// reload affordance (mirrors reloadTabFile, confirm-for-dirty included).
async function reloadPanelFile() {
  const buffer = panelState.buffer;
  if (!buffer || buffer.saving) return;
  buffer.setContent(panelContent());
  if (buffer.dirty) {
    const ok = await confirmDialog({ title: 'Discard changes', message: 'Re-read this file from disk and discard your unsaved changes?', okText: 'Discard', cancelText: 'Keep Editing', danger: true });
    if (!ok || panelState.buffer !== buffer) return;
  }
  const revision = buffer.revision;
  const result = await fetchDiskContent(buffer.path);
  if (panelState.buffer !== buffer) return;
  if (result.error) { toast(result.error, 'error'); return; }
  buffer.setContent(panelContent());
  if (!buffer.acceptDisk(result, revision)) { toast('Edits made while loading were kept', 'info'); return; }
  installPanelContent(buffer.content);
  await refreshEditorDiskSnapshot(buffer);
  if (panelState.buffer !== buffer) return;
  setPanelExtChanged(false);
  updateEditorDirty();
  flashPanelStatus('Reloaded');
  if (mdPreviewActive) refreshPreview();
}

let openFileWatchTimer = null;
function startOpenFileWatcher() {
  if (openFileWatchTimer) return;
  const tick = () => { try { checkOpenFiles(); } catch (e) { console.warn(e); } };
  openFileWatchTimer = setInterval(tick, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('focus', tick);
}

let _extToastAt = 0;
function extToastThrottled(msg) {
  // Log-like files changing every poll must not spam a toast per interval.
  const now = Date.now();
  if (now - _extToastAt < 30000 && !/Deleted/.test(msg)) return;
  _extToastAt = now;
  try { toast(msg, 'warning'); } catch {}
}
async function checkOpenFiles() {
  if (document.hidden) return;
  const targets = [];
  try {
    const isDocPreview = !!(_pdfDoc || _epubBook || _officePath);
    if (panelState.path && !isDocPreview && document.getElementById('editor-view')?.classList.contains('open')) {
      targets.push({ kind: 'panel', path: panelState.path });
    }
  } catch {}
  try {
    for (const t of tabs) {
      if (!t || t.type !== 'file' || t.closed || !t.path) continue;
      if (t.viewer === 'text' && t.cm) {
        targets.push({ kind: 'tab', tab: t, path: t.path });
      } else if ((t.viewer === 'pdf' || t.viewer === 'epub' || t.viewer === 'office') && t.mountedOnce) {
        // Doc previews never auto-reload (whole-document render); flag only.
        targets.push({ kind: 'doctab', tab: t, path: t.path });
      }
    }
  } catch {}
  if (!targets.length) return;
  await Promise.all(targets.map(checkOneOpenFile));
}

async function checkOneOpenFile(target) {
  let st = null;
  try {
    const r = await api(`/api/files/stat?path=${encodeURIComponent(target.path)}`);
    if (r && !r.error && r.mtime !== undefined) st = r;
    else if (r && r.error && /not found/i.test(r.error)) { markOpenFileMissing(target); return; }
    else return; // transient error — retry next round, never flag
  } catch { return; }
  const watchedBuffer = target.kind === 'panel' ? panelState.buffer : target.tab?.document?.buffer;
  if (watchedBuffer?.saving) return;
  const mtime = String(st.mtime);
  if (target.kind === 'panel') {
    if (panelState.path !== target.path) return; // user moved on mid-flight
    if (panelState.diskMtime == null) { panelState.diskMtime = mtime; panelState.diskSize = st.size; panelState.missing = false; return; }
    // A recreated file heals the "Deleted" note back to "Changed".
    if (panelState.missing) {
      panelState.missing = false;
      panelState.diskMtime = mtime; panelState.diskSize = st.size;
      const cur0 = panelContent();
      if (cur0 === panelState.original) {
        await autoRefreshPanelFile(target.path, mtime, st.size);
      } else {
        setPanelExtChanged(true);
        extToastThrottled('Changed on disk: ' + target.path.split(/[\\/]/).pop());
      }
      return;
    }
    if (mtime === String(panelState.diskMtime) && st.size === panelState.diskSize) return;
    const cur = panelContent();
    // Clean means no user edits to lose — re-read whatever disk says now
    // (this also heals a stale "Deleted on disk" note when the file returns).
    if (cur === panelState.original) {
      await autoRefreshPanelFile(target.path, mtime, st.size);
    } else if (!panelState.extChanged) {
      setPanelExtChanged(true);
      extToastThrottled('Changed on disk: ' + target.path.split(/[\\/]/).pop());
    }
  } else if (target.kind === 'doctab') {
    const tab = target.tab;
    if (!tab || tab.closed || tab.path !== target.path) return;
    if (tab.document.diskMtime == null) { tab.document.diskMtime = mtime; tab.document.diskSize = st.size; tab.document.missing = false; return; }
    // A recreated file heals the "Deleted" note back to "Changed".
    if (tab.document.missing) {
      tab.document.missing = false;
      tab.document.diskMtime = mtime; tab.document.diskSize = st.size;
      setTabExtChanged(tab, true);
      extToastThrottled('Changed on disk: ' + fileTabName(tab.path));
      return;
    }
    if (mtime === String(tab.document.diskMtime) && st.size === tab.document.diskSize) return;
    tab.document.diskMtime = mtime; tab.document.diskSize = st.size;
    if (!tab.document.extChanged) {
      setTabExtChanged(tab, true);
      extToastThrottled('Changed on disk: ' + fileTabName(tab.path));
    }
  } else {
    const tab = target.tab;
    if (!tab || tab.closed || !tab.cm || tab.path !== target.path) return;
    if (tab.document.diskMtime == null) { tab.document.diskMtime = mtime; tab.document.diskSize = st.size; tab.document.missing = false; return; }
    // A recreated file heals the "Deleted" note back to "Changed".
    if (tab.document.missing) {
      tab.document.missing = false;
      tab.document.diskMtime = mtime; tab.document.diskSize = st.size;
      if (tab.cm.getValue() === tab.document.original) {
        await autoRefreshTabFile(tab, mtime, st.size);
      } else {
        setTabExtChanged(tab, true);
        extToastThrottled('Changed on disk: ' + fileTabName(tab.path));
      }
      return;
    }
    if (mtime === String(tab.document.diskMtime) && st.size === tab.document.diskSize) return;
    const cur = tab.cm.getValue();
    if (cur === tab.document.original) {
      await autoRefreshTabFile(tab, mtime, st.size);
    } else if (!tab.document.extChanged) {
      setTabExtChanged(tab, true);
      extToastThrottled('Changed on disk: ' + fileTabName(tab.path));
    }
  }
}

function markOpenFileMissing(target) {
  if (target.kind === 'panel') {
    if (panelState.path !== target.path) return;
    // Dirty buffers keep edits and show Deleted; clean ones adopt it too —
    // either way record _panelMissing so a recreate re-stats to Changed.
    panelState.missing = true;
    if (panelState.extChanged && !/Deleted/.test(document.getElementById('editor-status')?.textContent || '')) return;
    if (panelState.extChanged) return;
    setPanelExtChanged(true, EXT_MISSING_MSG);
    toast('Deleted on disk: ' + target.path.split(/[\\/]/).pop(), 'warning');
  } else if (target.kind === 'doctab') {
    const tab = target.tab;
    if (!tab || tab.closed) return;
    tab.document.missing = true;
    if (tab.document.extChanged) return;
    setTabExtChanged(tab, true, EXT_MISSING_MSG);
    toast('Deleted on disk: ' + fileTabName(tab.path), 'warning');
  } else {
    const tab = target.tab;
    if (!tab || tab.closed || !tab.cm) return;
    tab.document.missing = true;
    if (tab.document.extChanged) return;
    setTabExtChanged(tab, true, EXT_MISSING_MSG);
    toast('Deleted on disk: ' + fileTabName(tab.path), 'warning');
  }
}

async function autoRefreshPanelFile(path, mtime, size) {
  const buffer = panelState.buffer;
  if (!buffer || buffer.path !== path || buffer.saving) return;
  buffer.setContent(panelContent());
  if (buffer.dirty || (typeof size === 'number' && size > MAX_EDITOR_SIZE)) {
    setPanelExtChanged(true); return;
  }
  const revision = buffer.revision;
  const result = await fetchDiskContent(path);
  if (panelState.buffer !== buffer) return;
  if (result.error) { toast(result.error, 'error'); return; }
  buffer.setContent(panelContent());
  if (!buffer.acceptDisk({ ...result, size: result.size ?? size, mtime: result.mtime ?? mtime }, revision)) {
    setPanelExtChanged(true); return;
  }
  const cursor = editor?.getCursor();
  installPanelContent(buffer.content);
  if (cursor) editor.setCursor(cursor);
  setPanelExtChanged(false);
  updateEditorDirty();
  flashPanelStatus('Updated from disk');
  if (mdPreviewActive) refreshPreview();
  toast('Updated from disk: ' + fileTabName(path), 'info');
}

async function autoRefreshTabFile(tab, mtime, size) {
  const buffer = tab?.document.buffer;
  if (!buffer || tab.closed || !tab.cm || buffer.saving) return;
  buffer.setContent(tab.cm.getValue());
  if (buffer.dirty || (typeof size === 'number' && size > MAX_EDITOR_SIZE)) { setTabExtChanged(tab, true); return; }
  const revision = buffer.revision;
  const result = await fetchDiskContent(buffer.path);
  if (tab.closed || tab.document.buffer !== buffer) return;
  if (result.error) { toast(result.error, 'error'); return; }
  buffer.setContent(tab.cm.getValue());
  if (!buffer.acceptDisk({ ...result, size: result.size ?? size, mtime: result.mtime ?? mtime }, revision)) {
    setTabExtChanged(tab, true); return;
  }
  const cursor = tab.cm.getCursor();
  tab.cm.setValue(buffer.content);
  if (cursor) tab.cm.setCursor(cursor);
  setTabExtChanged(tab, false);
  markTabDirty(tab);
  flashTabStatus(tab, 'Updated from disk');
  if (tab.previewOn) scheduleTabPreview(tab);
  toast('Updated from disk: ' + fileTabName(buffer.path), 'info');
}


// Declarative controls owned by this feature.
uiActions.register("click", {
  "close-editor": function (event) { return closeEditor(); },
  "save-file": function (event) { return saveFile(); },
  "close-overlay-rename-overlay": function (event) { return closeOverlay('rename-overlay'); },
  "close-overlay-newfolder-overlay": function (event) { return closeOverlay('newfolder-overlay'); },
  "close-overlay-newfile-overlay": function (event) { return closeOverlay('newfile-overlay'); },
  "close-overlay-content-search-overlay": function (event) { return closeOverlay('content-search-overlay'); },
  "close-overlay-props-overlay": function (event) { return closeOverlay('props-overlay'); },
});

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
      lineWrapping: !!(typeof settings !== 'undefined' && settings.editorWrap),
      tabSize: (typeof settings !== 'undefined' && settings.tabSize) || 2,
      indentUnit: (typeof settings !== 'undefined' && settings.tabSize) || 2,
      extraKeys: {
        'Ctrl-S': () => saveFile(),
        'Cmd-S': () => saveFile(),
        'Ctrl-F': () => toggleEditorFind(),
        'Cmd-F': () => toggleEditorFind(),
        'Ctrl-H': () => toggleEditorFind(true),
        'Ctrl-G': () => toggleEditorFind(false, true),
        'Esc': () => {
          if (document.querySelector('.overlay.open')) return;
          const fb = document.getElementById('editor-find-bar');
          if (fb && fb.style.display !== 'none') { closeEditorFindBar(); return; }
          closeEditor();
        },
      }
    }));
    editor.on('change', () => {
      updateEditorDirty();
      autoSaveDraft();
      schedulePreviewLiveReload();
      checkEditorConflicts(editor);
    });
    editor.on('cursorActivity', () => updateEditorCursorStatus(editor));
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
    const st = await api(`/api/files/stat?path=${encodeURIComponent(path)}&follow=1`);
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

async function openFileEditor(path, opts = {}) {
  const request = ++_panelOpenRequest;
  if (isImageFile(path)) { openImageViewer(path); return; }
  // Already open as its own tab? Focus that tab rather than opening a second editor
  // on the same path.
  const openTab = findFileTab(path);
  if (openTab && !openTab.closed) {
    activateTab(openTab.id);
    if (opts && opts.line && openTab.cm) {
      const ln = Math.max(0, Number(opts.line) - 1);
      openTab.cm.setCursor({ line: ln, ch: opts.ch || 0 });
      if (typeof openTab.cm.scrollIntoView === 'function') openTab.cm.scrollIntoView({ line: ln, ch: 0 }, 80);
    }
    return;
  }
  // A heavy file tab owns the panel right now, so a *different* file opened from the
  // explorer belongs in its own tab — otherwise a later Save in tab A could write tab
  // B's buffer to tab A's path.
  if (_dockedFileTabId != null) {
    const docked = tabs.find(t => t.id === _dockedFileTabId);
    if (docked && docked.path !== path) { newFileTab(path); return; }
  }
  if (panelState.path === path && panelState.buffer) {
    if (opts && opts.line && editor) {
      const ln = Math.max(0, Number(opts.line) - 1);
      editor.setCursor({ line: ln, ch: opts.ch || 0 });
      if (typeof editor.scrollIntoView === 'function') editor.scrollIntoView({ line: ln, ch: 0 }, 80);
    }
    editor?.focus();
    return;
  }
  if (panelState.buffer?.dirty) {
    const leave = await confirmDialog({ title: 'Unsaved changes', message: 'Open another file? Your current edits will be kept as a recovery draft.', okText: 'Keep draft and open', cancelText: 'Keep Editing' });
    if (!leave || request !== _panelOpenRequest) return;
  }
  if (typeof isMediaFile === 'function' && isMediaFile(path)) { openMediaViewer(path); return; }
  if (isPdfFile(path)) { openPdfViewer(path); return; }
  if (isEpubFile(path)) { openEpubViewer(path); return; }
  if (isOfficeFile(path)) { openOfficeViewer(path); return; }
  if (isLegacyOfficeFile(path)) { toast('Legacy Office format — re-save as .docx/.xlsx (or .pdf) to preview, or use Download', 'warning'); return; }
  if (!canOpenInEditor(path)) { toast('Preview not supported for this file type — use Download', 'warning'); return; }
  const data = await readTextForEditor(path);
  if (!data || request !== _panelOpenRequest) return;
  await showTextInPanel(path, data.content, data.original, null, data.mtime, data.size);
  if (opts && opts.line && editor) {
    const ln = Math.max(0, Number(opts.line) - 1);
    editor.setCursor({ line: ln, ch: opts.ch || 0 });
    if (typeof editor.scrollIntoView === 'function') editor.scrollIntoView({ line: ln, ch: 0 }, 80);
  }
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
  stopLogTail();
  const tailBtn = document.getElementById('editor-tail-btn');
  if (tailBtn) tailBtn.style.display = /\.(log|out|err|txt)$/i.test(fileName) ? '' : 'none';
  const csvBtn = document.getElementById('editor-csv-btn');
  if (csvBtn) csvBtn.style.display = /\.(csv|tsv)$/i.test(fileName) ? '' : 'none';
  if (cm) {
    updateEditorCursorStatus(cm);
    checkEditorConflicts(cm);
  }

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
    const stat = await api('/api/files/stat?path=' + encodeURIComponent(path) + '&follow=1');
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
  stopLogTail();
  closeEditorFindBar();
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
    const r = await api(`/api/files/stat?path=${encodeURIComponent(target.path)}&follow=1`);
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


// ═══════════════════════════════════════════════════════
// EDITOR CURSOR, WORD WRAP, TAB SIZE, FIND/REPLACE,
// GIT CONFLICT RESOLUTION & LIVE LOG TAIL
// ═══════════════════════════════════════════════════════
function getActiveEditorInstance() {
  const activeTab = typeof tabs !== 'undefined' ? tabs.find(t => t.id === activeTabId) : null;
  if (activeTab && activeTab.type === 'file' && activeTab.viewer === 'text' && activeTab.cm) {
    return activeTab.cm;
  }
  return editor;
}

function updateEditorCursorStatus(cm) {
  if (!cm || typeof cm.getCursor !== 'function') return;
  const cur = cm.getCursor();
  const text = `Ln ${(cur.line || 0) + 1}, Col ${(cur.ch || 0) + 1}`;
  if (cm === editor) {
    const el = document.getElementById('editor-cursor-pos');
    if (el) el.textContent = text;
  }
}

function applyEditorWrap(wrap) {
  const w = !!wrap;
  CM_BASE_OPTIONS.lineWrapping = w;
  if (editor) { try { editor.setOption('lineWrapping', w); } catch {} }
  if (typeof tabs !== 'undefined') {
    tabs.forEach(t => {
      if (t.type === 'file' && t.cm) { try { t.cm.setOption('lineWrapping', w); } catch {} }
    });
  }
  const btn = document.getElementById('editor-wrap-btn');
  if (btn) {
    btn.classList.toggle('active', w);
    btn.setAttribute('aria-pressed', String(w));
  }
}

function toggleEditorWrap() {
  if (typeof settings !== 'undefined') {
    settings.editorWrap = !settings.editorWrap;
    if (typeof saveSettings === 'function') saveSettings();
    const t = document.getElementById('s-editorWrap');
    if (t) {
      t.classList.toggle('on', settings.editorWrap);
      t.setAttribute('aria-checked', String(settings.editorWrap));
    }
    applyEditorWrap(settings.editorWrap);
  } else {
    applyEditorWrap(!CM_BASE_OPTIONS.lineWrapping);
  }
}

function applyTabSize() {
  const el = document.getElementById('s-tabsize');
  const val = Math.min(8, Math.max(2, parseInt(el?.value || '2', 10) || 2));
  if (typeof settings !== 'undefined') {
    settings.tabSize = val;
    if (typeof saveSettings === 'function') saveSettings();
  }
  CM_BASE_OPTIONS.tabSize = val;
  CM_BASE_OPTIONS.indentUnit = val;
  if (editor) {
    try { editor.setOption('tabSize', val); editor.setOption('indentUnit', val); } catch {}
  }
  if (typeof tabs !== 'undefined') {
    tabs.forEach(t => {
      if (t.type === 'file' && t.cm) {
        try { t.cm.setOption('tabSize', val); t.cm.setOption('indentUnit', val); } catch {}
      }
    });
  }
}

// ── Find / Replace / Go-to-Line Bar ─────────────────────
let _editorFindMatches = [];
let _editorFindIndex = -1;
let _editorFindCase = false;
let _editorFindRegex = false;

function mountFindBarToActiveSurface() {
  const bar = document.getElementById('editor-find-bar');
  if (!bar) return null;
  const activeTab = typeof tabs !== 'undefined' ? tabs.find(t => t.id === activeTabId) : null;
  if (activeTab && activeTab.type === 'file' && activeTab.viewer === 'text' && activeTab.bodyEl && activeTab.fteHost) {
    if (bar.parentElement !== activeTab.bodyEl) {
      activeTab.bodyEl.insertBefore(bar, activeTab.fteHost);
    }
  } else {
    const ev = document.getElementById('editor-view');
    const ea = document.getElementById('editor-area');
    if (ev && ea && bar.parentElement !== ev) {
      ev.insertBefore(bar, ea);
    }
  }
  return bar;
}

function toggleEditorFind(focusReplace = false, focusGoto = false) {
  const bar = mountFindBarToActiveSurface();
  if (!bar) return;
  const isHidden = bar.style.display === 'none' || !bar.style.display;
  bar.style.display = 'flex';
  const cm = getActiveEditorInstance();
  const sel = cm && typeof cm.getSelection === 'function' ? cm.getSelection() : '';
  const findIn = document.getElementById('editor-find-input');
  if (sel && !sel.includes('\n') && findIn) findIn.value = sel;
  if (focusGoto) {
    document.getElementById('editor-goto-input')?.focus();
  } else if (focusReplace) {
    document.getElementById('editor-replace-input')?.focus();
  } else if (findIn) {
    findIn.focus();
    findIn.select();
  }
  computeEditorFindMatches();
}

function closeEditorFindBar() {
  const bar = document.getElementById('editor-find-bar');
  if (bar) bar.style.display = 'none';
  getActiveEditorInstance()?.focus();
}

function toggleEditorFindCase() {
  _editorFindCase = !_editorFindCase;
  const btn = document.getElementById('editor-find-case');
  if (btn) {
    btn.classList.toggle('btn-primary', _editorFindCase);
    btn.setAttribute('aria-pressed', String(_editorFindCase));
  }
  computeEditorFindMatches();
}

function toggleEditorFindRegex() {
  _editorFindRegex = !_editorFindRegex;
  const btn = document.getElementById('editor-find-regex');
  if (btn) {
    btn.classList.toggle('btn-primary', _editorFindRegex);
    btn.setAttribute('aria-pressed', String(_editorFindRegex));
  }
  computeEditorFindMatches();
}

function buildEditorFindRegExp(query) {
  if (!query) return null;
  const flags = _editorFindCase ? 'g' : 'gi';
  try {
    return _editorFindRegex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch {
    return null;
  }
}

function computeEditorFindMatches() {
  const cm = getActiveEditorInstance();
  const query = document.getElementById('editor-find-input')?.value || '';
  const countEl = document.getElementById('editor-find-count');
  _editorFindMatches = [];
  _editorFindIndex = -1;
  if (!cm || !query) {
    if (countEl) countEl.textContent = '0/0';
    return;
  }
  const re = buildEditorFindRegExp(query);
  if (!re) {
    if (countEl) countEl.textContent = 'Invalid';
    return;
  }
  const lines = cm.getValue().split('\n');
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      _editorFindMatches.push({
        from: { line: r, ch: m.index },
        to: { line: r, ch: m.index + m[0].length }
      });
    }
  }
  if (_editorFindMatches.length > 0) {
    _editorFindIndex = 0;
    selectEditorMatch(cm, _editorFindMatches[0]);
    if (countEl) countEl.textContent = `1/${_editorFindMatches.length}`;
  } else {
    if (countEl) countEl.textContent = '0/0';
  }
}

function selectEditorMatch(cm, match) {
  if (!cm || !match) return;
  if (typeof cm.setSelection === 'function') cm.setSelection(match.from, match.to);
  else if (typeof cm.setCursor === 'function') cm.setCursor(match.from);
  if (typeof cm.scrollIntoView === 'function') cm.scrollIntoView(match.from, 80);
}

function editorFindNext() {
  const cm = getActiveEditorInstance();
  if (!_editorFindMatches.length) { computeEditorFindMatches(); return; }
  _editorFindIndex = (_editorFindIndex + 1) % _editorFindMatches.length;
  selectEditorMatch(cm, _editorFindMatches[_editorFindIndex]);
  const countEl = document.getElementById('editor-find-count');
  if (countEl) countEl.textContent = `${_editorFindIndex + 1}/${_editorFindMatches.length}`;
}

function editorFindPrev() {
  const cm = getActiveEditorInstance();
  if (!_editorFindMatches.length) { computeEditorFindMatches(); return; }
  _editorFindIndex = (_editorFindIndex - 1 + _editorFindMatches.length) % _editorFindMatches.length;
  selectEditorMatch(cm, _editorFindMatches[_editorFindIndex]);
  const countEl = document.getElementById('editor-find-count');
  if (countEl) countEl.textContent = `${_editorFindIndex + 1}/${_editorFindMatches.length}`;
}

function editorReplaceOne() {
  const cm = getActiveEditorInstance();
  if (!cm) return;
  if (!_editorFindMatches.length) computeEditorFindMatches();
  if (!_editorFindMatches.length || _editorFindIndex < 0) return;
  const replacement = document.getElementById('editor-replace-input')?.value ?? '';
  const match = _editorFindMatches[_editorFindIndex];
  if (typeof cm.replaceRange === 'function') {
    cm.replaceRange(replacement, match.from, match.to);
  } else {
    const lines = cm.getValue().split('\n');
    const row = lines[match.from.line] || '';
    lines[match.from.line] = row.slice(0, match.from.ch) + replacement + row.slice(match.to.ch);
    cm.setValue(lines.join('\n'));
  }
  computeEditorFindMatches();
}

function editorReplaceAll() {
  const cm = getActiveEditorInstance();
  const query = document.getElementById('editor-find-input')?.value || '';
  if (!cm || !query) return;
  const re = buildEditorFindRegExp(query);
  if (!re) return;
  const replacement = document.getElementById('editor-replace-input')?.value ?? '';
  const cur = cm.getValue();
  const next = cur.replace(re, replacement);
  if (next !== cur) cm.setValue(next);
  computeEditorFindMatches();
}

function editorGotoLine() {
  const cm = getActiveEditorInstance();
  const raw = document.getElementById('editor-goto-input')?.value || '';
  const lineNum = parseInt(raw, 10);
  if (!cm || !Number.isFinite(lineNum) || lineNum < 1) return;
  const target = Math.max(0, lineNum - 1);
  cm.setCursor({ line: target, ch: 0 });
  if (typeof cm.scrollIntoView === 'function') cm.scrollIntoView({ line: target, ch: 0 }, 80);
  cm.focus();
}

// ── Git Conflict Banner & One-Click Resolution ──────────
let _editorConflicts = [];
let _editorConflictIdx = 0;

function parseGitConflicts(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      const start = i;
      let sep = -1;
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('=======') && sep === -1) sep = j;
        else if (lines[j].startsWith('>>>>>>>') && sep !== -1) { end = j; break; }
      }
      if (sep !== -1 && end !== -1) {
        blocks.push({
          startLine: start,
          sepLine: sep,
          endLine: end,
          ours: lines.slice(start + 1, sep),
          theirs: lines.slice(sep + 1, end)
        });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return blocks;
}

function checkEditorConflicts(cm) {
  const inst = cm || getActiveEditorInstance();
  const bar = document.getElementById('editor-conflict-bar');
  if (!inst || !bar) return;
  _editorConflicts = parseGitConflicts(inst.getValue());
  if (!_editorConflicts.length) {
    bar.style.display = 'none';
    return;
  }
  if (_editorConflictIdx >= _editorConflicts.length) _editorConflictIdx = 0;
  bar.style.display = 'flex';
  const countEl = document.getElementById('editor-conflict-count');
  if (countEl) {
    countEl.textContent = `${_editorConflicts.length} merge conflict${_editorConflicts.length > 1 ? 's' : ''} (${_editorConflictIdx + 1}/${_editorConflicts.length})`;
  }
}

function jumpEditorConflict(delta) {
  const cm = getActiveEditorInstance();
  if (!cm || !_editorConflicts.length) return;
  _editorConflictIdx = (_editorConflictIdx + delta + _editorConflicts.length) % _editorConflicts.length;
  const blk = _editorConflicts[_editorConflictIdx];
  cm.setCursor({ line: blk.startLine, ch: 0 });
  if (typeof cm.scrollIntoView === 'function') cm.scrollIntoView({ line: blk.startLine, ch: 0 }, 80);
  checkEditorConflicts(cm);
}

function resolveEditorConflict(choice) {
  const cm = getActiveEditorInstance();
  if (!cm) return;
  _editorConflicts = parseGitConflicts(cm.getValue());
  if (!_editorConflicts.length) return;
  if (_editorConflictIdx >= _editorConflicts.length) _editorConflictIdx = 0;
  const blk = _editorConflicts[_editorConflictIdx];
  const lines = cm.getValue().split('\n');
  let replacement = [];
  if (choice === 'ours') replacement = blk.ours;
  else if (choice === 'theirs') replacement = blk.theirs;
  else if (choice === 'both') replacement = [...blk.ours, ...blk.theirs];
  lines.splice(blk.startLine, blk.endLine - blk.startLine + 1, ...replacement);
  cm.setValue(lines.join('\n'));
  checkEditorConflicts(cm);
}

// ── Live Log Tail (SSE) ─────────────────────────────────
let _logTailEs = null;
let _logTailPaused = false;
let _logTailBuffer = [];

function toggleEditorTail() {
  if (_logTailEs) stopLogTail();
  else startLogTail();
}

function startLogTail() {
  if (!panelState.path) return;
  stopLogTail();
  _logTailPaused = false;
  _logTailBuffer = [];
  const bar = document.getElementById('editor-tail-bar');
  if (bar) bar.style.display = 'flex';
  const btn = document.getElementById('editor-tail-btn');
  if (btn) btn.classList.add('btn-primary');
  const pauseBtn = document.getElementById('editor-tail-pause');
  if (pauseBtn) pauseBtn.textContent = 'Pause';
  const url = `/api/files/tail?path=${encodeURIComponent(panelState.path)}` + (authToken ? `&token=${encodeURIComponent(authToken)}` : '');
  try {
    const es = new EventSource(url);
    _logTailEs = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const st = document.getElementById('editor-tail-status');
        if (st) st.textContent = _logTailPaused ? 'Live tail paused' : 'Streaming live log updates…';
        if (msg.type === 'init' || msg.type === 'reset') {
          const text = Array.isArray(msg.lines) ? msg.lines.join('\n') : String(msg.lines || '');
          if (_logTailPaused) {
            _logTailBuffer = [text];
          } else {
            installPanelContent(text);
            if (panelState.buffer) {
              panelState.buffer.original = text;
              panelState.buffer.content = text;
            }
          }
        } else if (msg.type === 'data' || msg.chunk) {
          const chunk = msg.chunk != null ? String(msg.chunk) : (Array.isArray(msg.lines) ? msg.lines.join('\n') : String(msg.lines || ''));
          if (chunk) {
            if (_logTailPaused) _logTailBuffer.push(chunk);
            else appendLogTailChunk(chunk);
          }
        }
      } catch {}
    };
    es.onerror = () => {
      const st = document.getElementById('editor-tail-status');
      if (st) st.textContent = 'Live tail reconnecting…';
    };
  } catch (e) {
    toast('Failed to start live tail: ' + e.message, 'error');
  }
}

function appendLogTailChunk(chunk) {
  if (!chunk) return;
  const next = panelContent() + chunk;
  installPanelContent(next);
  if (panelState.buffer) {
    panelState.buffer.original = next;
    panelState.buffer.content = next;
  }
  if (editor) {
    const last = editor.lineCount ? editor.lineCount() - 1 : 0;
    editor.setCursor({ line: last, ch: 0 });
    if (typeof editor.scrollIntoView === 'function') editor.scrollIntoView({ line: last, ch: 0 }, 40);
  }
}

function togglePauseLogTail() {
  _logTailPaused = !_logTailPaused;
  const pauseBtn = document.getElementById('editor-tail-pause');
  if (pauseBtn) pauseBtn.textContent = _logTailPaused ? 'Resume' : 'Pause';
  if (!_logTailPaused && _logTailBuffer.length) {
    appendLogTailChunk(_logTailBuffer.join(''));
    _logTailBuffer = [];
  }
}

function clearLogTailView() {
  installPanelContent('');
}

function stopLogTail() {
  if (_logTailEs) {
    try { _logTailEs.close(); } catch {}
    _logTailEs = null;
  }
  _logTailPaused = false;
  _logTailBuffer = [];
  const bar = document.getElementById('editor-tail-bar');
  if (bar) bar.style.display = 'none';
  const btn = document.getElementById('editor-tail-btn');
  if (btn) btn.classList.remove('btn-primary');
}

// Declarative controls owned by this feature.
uiActions.register("click", {
  "close-editor": function (event) { return closeEditor(); },
  "save-file": function (event) { return saveFile(); },
  "toggle-editor-find": function (event) { return toggleEditorFind(); },
  "close-editor-find": function (event) { return closeEditorFindBar(); },
  "editor-find-next": function (event) { return editorFindNext(); },
  "editor-find-prev": function (event) { return editorFindPrev(); },
  "toggle-editor-find-case": function (event) { return toggleEditorFindCase(); },
  "toggle-editor-find-regex": function (event) { return toggleEditorFindRegex(); },
  "editor-replace-one": function (event) { return editorReplaceOne(); },
  "editor-replace-all": function (event) { return editorReplaceAll(); },
  "editor-goto-line": function (event) { return editorGotoLine(); },
  "toggle-editor-wrap": function (event) { return toggleEditorWrap(); },
  "reload-editor-file": function (event) { return reloadPanelFile(); },
  "toggle-editor-tail": function (event) { return toggleEditorTail(); },
  "toggle-pause-log-tail": function (event) { return togglePauseLogTail(); },
  "clear-log-tail-view": function (event) { return clearLogTailView(); },
  "stop-log-tail": function (event) { return stopLogTail(); },
  "conflict-prev": function (event) { return jumpEditorConflict(-1); },
  "conflict-next": function (event) { return jumpEditorConflict(1); },
  "conflict-accept-ours": function (event) { return resolveEditorConflict('ours'); },
  "conflict-accept-theirs": function (event) { return resolveEditorConflict('theirs'); },
  "conflict-accept-both": function (event) { return resolveEditorConflict('both'); },
  "open-csv-grid-view": function (event) { if (panelState.path) return openOfficeViewer(panelState.path); },
  "close-overlay-rename-overlay": function (event) { return closeOverlay('rename-overlay'); },
  "close-overlay-newfolder-overlay": function (event) { return closeOverlay('newfolder-overlay'); },
  "close-overlay-newfile-overlay": function (event) { return closeOverlay('newfile-overlay'); },
  "close-overlay-content-search-overlay": function (event) { return closeOverlay('content-search-overlay'); },
  "close-overlay-props-overlay": function (event) { return closeOverlay('props-overlay'); },
});
uiActions.register("input", {
  "editor-find-query": function (event) { return computeEditorFindMatches(); },
});
uiActions.register("keydown", {
  "editor-find-key": function (event) {
    if (event.key === 'Enter') { event.preventDefault(); return event.shiftKey ? editorFindPrev() : editorFindNext(); }
    if (event.key === 'Escape') { event.preventDefault(); return closeEditorFindBar(); }
  },
  "editor-replace-key": function (event) {
    if (event.key === 'Enter') { event.preventDefault(); return editorReplaceOne(); }
    if (event.key === 'Escape') { event.preventDefault(); return closeEditorFindBar(); }
  },
  "editor-goto-key": function (event) {
    if (event.key === 'Enter') { event.preventDefault(); return editorGotoLine(); }
    if (event.key === 'Escape') { event.preventDefault(); return closeEditorFindBar(); }
  }
});

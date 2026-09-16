// WebTun frontend - editor-panel.js (split-panel CodeMirror, drafts, save/close.)

// ═══════════════════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════════════════
const MAX_EDITOR_SIZE = 10 * 1024 * 1024; // 10MB
let editor = null;
let mdPreviewActive = false;
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

function initCodeMirror() {
  if (editor) return editor;
  const ta = document.getElementById('editor-textarea');
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
}
let _autoSaveTimer = null;
function autoSaveDraft() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    try {
      if (!editorPath) return;
      const content = editor ? editor.getValue() : '';
      if (content !== editorOriginalContent) {
        safeStorage.setItem('wt-draft:' + editorPath, content);
      } else {
        safeStorage.removeItem('wt-draft:' + editorPath);
      }
    } catch {}
  }, 2000);
}
function loadDraft(p) {
  try { return safeStorage.getItem('wt-draft:' + p); } catch { return null; }
}
function removeDraft(p) {
  try { safeStorage.removeItem('wt-draft:' + p); } catch {}
}


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
  const r = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
  if (r.error) {
    if (r.isBinary) { toast(r.error || 'Preview not supported for binary files — use Download', 'warning'); return null; }
    toast(r.error, 'error'); return null;
  }
  if (r.length > MAX_EDITOR_SIZE) {
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
    if (restore) content = draft;
    else removeDraft(path);
  }
  return { content, original: r.content };
}

// Forget the panel's file without prompting. Used when a text buffer has been handed
// to a file tab: one path must never be editable in two surfaces at once (they would
// diverge, and last save wins). Only reachable while no heavy tab owns the panel.
function releasePanelSurface() {
  editorPath = '';
  editorOriginalContent = '';
  clearTimeout(_autoSaveTimer);
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
  if (isPdfFile(path)) { openPdfViewer(path); return; }
  if (isEpubFile(path)) { openEpubViewer(path); return; }
  if (isOfficeFile(path)) { openOfficeViewer(path); return; }
  if (isLegacyOfficeFile(path)) { toast('Legacy Office format — re-save as .docx/.xlsx (or .pdf) to preview, or use Download', 'warning'); return; }
  if (!canOpenInEditor(path)) { toast('Preview not supported for this file type — use Download', 'warning'); return; }
  const data = await readTextForEditor(path);
  if (!data) return;
  await showTextInPanel(path, data.content, data.original);
}

// Put a text buffer into the split panel. `original` is the on-disk text the dirty
// check compares against (so a restored draft still reads as modified), and
// `history` carries undo state when a buffer moves from a file tab into the panel.
async function showTextInPanel(path, content, original, history) {
  editorPath = path;
  editorOriginalContent = original != null ? original : content;
  const openContent = content;
  const sep = path.includes('\\') ? '\\' : '/';
  const fileName = path.split(sep).pop() || path;
  const isMd = /\.md$/i.test(fileName);
  const isHtml = /\.html?$/i.test(fileName);
  // hide doc viewers when opening text file
  cleanupDocViewers();
  document.getElementById('editor-save-btn').style.display = '';

  const cm = initCodeMirror();
  cm.setValue(openContent);
  cm.setOption('mode', await resolveCMmode(fileName));
  cm.setOption('readOnly', false);
  document.querySelector('.CodeMirror').style.display = '';
  cm.refresh();
  const ta = document.getElementById('editor-textarea');
  ta.oninput = () => updateEditorDirty();
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
  if ((isMd && typeof marked !== 'undefined') || isHtml) {
    toggleBtn.style.display = '';
    toggleBtn.textContent = 'Preview';
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
  } else {
    toggleBtn.style.display = 'none';
    if (refreshBtn) refreshBtn.style.display = 'none';
    setFullBtnVisible(false);
  }
  document.getElementById('editor-filename').textContent = fileName + '  /  ' + path;
  document.getElementById('editor-status').textContent = '';

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
  if (history) { try { cm.setHistory(history); } catch (e) { console.warn('Undo history restore failed:', e); } }
  cm.focus();

  // Fit all terminals to new available space
  requestAnimationFrame(() => {
    tabs.forEach(tab => { try { fitTerm(tab); } catch(e) { console.warn(e); } });
  });
}

async function saveFile() {
  if (!editorPath) { toast('No file open', 'error'); return; }
  setBtnBusy(document.getElementById('editor-save-btn'), true);
  const content = editor ? editor.getValue() : document.getElementById('editor-textarea').value;
  const r = await api('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: editorPath, content })
  });
  setBtnBusy(document.getElementById('editor-save-btn'), false);
  if (r.success) {
    editorOriginalContent = content;
    removeDraft(editorPath);
    clearTimeout(_autoSaveTimer);
    updateEditorDirty();
    document.getElementById('editor-status').textContent = 'Saved';
    toast('Saved', 'success');
    if (mdPreviewActive) refreshPreview();
    try { notifyPreviewFileSaved(); } catch {}
    setTimeout(() => document.getElementById('editor-status').textContent = '', 2000);
  } else toast(r.error, 'error');
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
    const currentContent = editor ? editor.getValue() : document.getElementById('editor-textarea').value;
    if (currentContent !== editorOriginalContent) {
      const ok = await confirmDialog({ title: 'Unsaved changes', message: 'You have unsaved changes. Close anyway?', okText: 'Discard', cancelText: 'Keep Editing', danger: true });
      if (!ok) return;
      // Explicit discard: drop the crash-safety draft too, so it is not offered again.
      if (editorPath) removeDraft(editorPath);
    }
    clearTimeout(_autoSaveTimer);
  }
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
  const cm = document.querySelector('.CodeMirror');
  if (cm) cm.style.display = '';
  mdPreviewActive = false;
  editorPath = '';
  editorOriginalContent = '';
  requestAnimationFrame(() => {
    tabs.forEach(tab => { try { fitTerm(tab); tab?.term?.focus(); } catch(e) { console.warn(e); } });
  });
}
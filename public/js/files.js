// WebTun frontend - files.js (file explorer (list, rows, breadcrumb, ops, DnD).)

// ═══════════════════════════════════════════════════════
// FILE EXPLORER
// ═══════════════════════════════════════════════════════
let loadFilesAbortController = null;
let _loadSeq = 0; // spinner/request race guard: only the newest load owns the UI
const NAV_HISTORY_MAX = 50;
let fileListLoadingTimer = null;
function setFileListLoading(on) {
  const wrap = document.getElementById('file-list-wrap');
  if (!wrap) return;
  clearTimeout(fileListLoadingTimer);
  if (on) {
    fileListLoadingTimer = setTimeout(() => {
      wrap.classList.add('loading');
      document.getElementById('refresh-btn')?.classList.add('spinning');
    }, 150);
    // Skeleton shimmer on first paint (empty list only — refresh keeps live rows)
    const list = document.getElementById('file-list');
    if (list && !list.children.length) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 8; i++) {
        const s = document.createElement('div');
        s.className = 'file-skel';
        s.setAttribute('aria-hidden', 'true');
        s.innerHTML = '<span class="sk-ico"></span><span class="sk-lines"><span class="sk-l1"></span><span class="sk-l2"></span></span>';
        frag.appendChild(s);
      }
      list.appendChild(frag);
    }
  } else {
    fileListLoadingTimer = null;
    wrap.classList.remove('loading');
    document.getElementById('refresh-btn')?.classList.remove('spinning');
  }
}

// Watcher ticks must never preempt user navigation (they'd abort the
// folder fetch and re-render the old path). Foreground calls set the flag;
// background ticks back off while one is in flight.
let _fgLoadActive = false;
async function loadFiles(dir, opts = {}) {
  const bg = !!(opts && opts.background);
  if (bg && _fgLoadActive) return;
  _fgLoadActive = !bg;
  try { return await _loadFilesInner(dir); }
  finally { _fgLoadActive = false; }
}
async function _loadFilesInner(dir) {
  if (loadFilesAbortController) loadFilesAbortController.abort();
  loadFilesAbortController = new AbortController();
  const seq = ++_loadSeq;

  // Selection belongs to the directory it was made in: leaving the directory
  // exits select mode entirely (stale toolbar + phantom toggle-clicks), while
  // a same-directory refresh keeps it.
  try {
    if (typeof exitSelectMode === 'function' && currentPath && dir !== currentPath) exitSelectMode();
    else if (typeof clearSelection === 'function') clearSelection();
  } catch {}

  const prevPath = currentPath;
  const shouldPushHistory = !skipHistoryPush && currentPath && currentPath !== dir;
  skipHistoryPush = false;

  const list = document.getElementById('file-list');

  setFileListLoading(true);
  let data;
  try {
    data = await api(`/api/files?path=${encodeURIComponent(dir)}`, { signal: loadFilesAbortController.signal });
  } catch (e) {
    // A superseded request must not touch the UI: the newer load owns the
    // spinner, the list and the breadcrumb now.
    if (seq !== _loadSeq) return false;
    if (e.name === 'AbortError') { setFileListLoading(false); return false; }
    setFileListLoading(false);
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding:16px;text-align:center;';
    errorDiv.innerHTML = '<div style="color:var(--red);margin-bottom:8px">Failed to load directory</div>' +
      '<div style="color:var(--fg2);font-size:11px;margin-bottom:8px;word-break:break-all">' + escHtml(e.message || 'Unknown error') + '</div>' +
      '<button class="btn btn-primary" style="height:28px;padding:0 12px;font-size:11px">Retry</button>';
    list.innerHTML = '';
    list.appendChild(errorDiv);
    errorDiv.querySelector('button').addEventListener('click', () => loadFiles(dir));
    toast(e.message || 'Failed to load directory', 'error');
    return false;
  }

  if (!data.files) {
    if (seq !== _loadSeq) return false;
    setFileListLoading(false);
    const msg = data.error || 'Failed to load directory';
    // Revert optimistic path — don't save failed dir
    // Show error instead of silent bounce
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding:16px;text-align:center;';
    errorDiv.innerHTML = '<div style="color:var(--red);margin-bottom:8px">' + escHtml(msg) + '</div>' +
      '<button class="btn btn-primary" style="height:28px;padding:0 12px;font-size:11px">Retry</button>';
    list.innerHTML = '';
    list.appendChild(errorDiv);
    errorDiv.querySelector('button').addEventListener('click', () => loadFiles(dir));
    toast(msg, 'error');
    // Only bounce to home if dir != home and home is different and we haven't already shown home
    if (dir !== homeDir && prevPath !== homeDir) {
      // keep currentPath as prevPath, don't update breadcrumb to failed dir
      document.getElementById('path-input').value = prevPath;
      renderBreadcrumb(prevPath);
    } else {
      // we are already at home or prevPath is home — update UI to reflect attempted dir for debugging
      document.getElementById('path-input').value = dir;
      renderBreadcrumb(dir);
    }
    return false;
  }

  // A stale success must not overwrite the newer directory now on screen.
  if (seq !== _loadSeq) return false;

  // Success — now update history and UI state
  if (shouldPushHistory) {
    navHistory.push(prevPath);
    if (navHistory.length > NAV_HISTORY_MAX) navHistory.splice(0, navHistory.length - NAV_HISTORY_MAX);
    navForwardHistory = [];
  }

  currentPath = data.path || dir;
  document.getElementById('path-input').value = currentPath;
  renderBreadcrumb(currentPath);
  saveCurrentPath();
  refreshGitPanel(currentPath);

  currentParent = data.parent || '';

  // Map existing DOM children by dataset.path
  const oldMap = new Map();
  for (const child of Array.from(list.children)) {
    const p = child.dataset.path;
    if (p) oldMap.set(p, child);
  }

  const fragment = document.createDocumentFragment();

  // Build new file list, reusing existing nodes when paths match
  function addItem(key, make) {
    const existing = oldMap.get(key);
    if (existing) {
      fragment.appendChild(existing);
      oldMap.delete(key);
      return existing;
    }
    const item = make();
    item.dataset.path = key;
    fragment.appendChild(item);
    return item;
  }

  // Parent dir entry (+ Folders divider when it leads the group)
  const dirCount = data.files.filter(f => f.isDir).length;
  const fileCount = data.files.length - dirCount;
  _thumbBudget = 48; // fresh thumbnail allowance per render
  // Sort state: dirs always first (groups depend on it), then key+dir.
  // Click a group divider = next key · right-click it = reverse direction.
  const _sortKeyLabel = { name: 'name', modified: 'date', size: 'size' };
  const sortTag = () => ` · ${_sortKeyLabel[fileSort.key]} ${fileSort.dir === 1 ? '↑' : '↓'}`;
  const addGroupDivider = (label, count) => {
    const gd = document.createElement('div');
    gd.className = 'file-group';
    gd.setAttribute('role', 'button');
    gd.setAttribute('tabindex', '0');
    gd.title = 'Change sort (right-click reverses)';
    const s1 = document.createElement('span');
    s1.textContent = label;
    const s2 = document.createElement('span');
    s2.className = 'fg-count';
    s2.textContent = String(count);
    const s3 = document.createElement('span');
    s3.className = 'fg-sort';
    s3.textContent = sortTag();
    gd.appendChild(s1); gd.appendChild(s2); gd.appendChild(s3);
    gd.addEventListener('click', cycleFileSort);
    gd.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleFileSort(); }
    });
    gd.addEventListener('contextmenu', e => {
      e.preventDefault();
      fileSort.dir = -fileSort.dir;
      saveFileSort();
      if (currentPath) loadFiles(currentPath);
    });
    fragment.appendChild(gd);
  };
  let dirsHeaderDone = false;
  if (data.parent && data.parent !== dir) {
    const folderSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
    if (dirCount > 0) { addGroupDivider('Folders', dirCount); dirsHeaderDone = true; }
    const parentRow = addItem(data.parent, () => makeFileItem('..', true, data.parent, { icon: folderSvg, meta: 'Parent directory', kind: 'dir' }));
    // Flag the ".." row so its checkbox stays hidden and it can't be selected
    parentRow.classList.add('is-parent');
    parentRow.dataset.isParent = 'true';
  }

  let filesHeaderDone = false;
  const files = sortFiles(data.files || []);
  files.forEach(f => {
    const key = f.path;
    const icon = f.isDir ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' : getFileIcon(f.ext);
    const sizeStr = f.isDir ? null : formatSize(f.size);
    const dateStr = f.modified ? timeAgo(f.modified) : '';
    const kind = fileKind(f.ext, f.isDir);
    const thumb = thumbUrlFor(f);
    let meta = sizeStr ? sizeStr : '';
    if (dateStr) meta += (meta ? ' · ' + dateStr : dateStr);
    if (!meta && f.isDir) meta = 'Folder';
    if (f.isSymlink) meta += (meta ? ' · link' : 'link');
    if (f.isDir) {
      if (!dirsHeaderDone) { addGroupDivider('Folders', dirCount); dirsHeaderDone = true; }
    } else if (!filesHeaderDone) {
      addGroupDivider('Files', fileCount); filesHeaderDone = true;
    }

    const existing = oldMap.get(key);
    if (existing) {
      // A reused node is a regular entry, never the ".." parent row
      existing.classList.remove('is-parent');
      delete existing.dataset.isParent;
      // Update name/meta/icon if changed (without recreating DOM)
      const nameEl = existing.querySelector('.file-name');
      if (nameEl && nameEl.dataset.raw !== f.name) {
        paintFileName(nameEl, f.name, f.isDir);
        nameEl.title = key;
      }
      const iconEl = existing.querySelector('.file-icon');
      if (iconEl) {
        if (iconEl.innerHTML !== icon) iconEl.innerHTML = icon;
        const tileCls = 'file-icon k-' + kind;
        if (iconEl.className !== tileCls) iconEl.className = tileCls;
      }
      const metaEl = existing.querySelector('.file-meta');
      if (metaEl) {
        if (metaEl.textContent !== meta) metaEl.textContent = meta;
      } else if (meta) {
        const mspan = document.createElement('span');
        mspan.className = 'file-meta';
        mspan.textContent = meta;
        const textWrap = existing.querySelector('.file-text');
        if (textWrap) textWrap.appendChild(mspan);
      }
      // Thumbnail freshness: track expected URL, swap only on change
      const tileEl = existing.querySelector('.file-icon');
      if (thumb) {
        if (existing.dataset.thumb !== thumb) {
          existing.dataset.thumb = thumb;
          let im = existing.querySelector('img.file-thumb');
          if (!im) {
            im = document.createElement('img');
            im.className = 'file-thumb';
            im.alt = '';
            im.onload = () => im.classList.add('ld');
            im.onerror = () => im.remove();
            if (tileEl) tileEl.appendChild(im);
          }
          im.classList.remove('ld');
          dropThumbUrl(im);
          im.dataset.src = thumb;
          im.removeAttribute('src');
          if (_thumbObserver) _thumbObserver.observe(im);
          else observeThumbs();
        }
      } else {
        delete existing.dataset.thumb;
        const stale = existing.querySelector('img.file-thumb');
        if (stale) { dropThumbUrl(stale); stale.remove(); }
      }
      existing.dataset.isDir = String(f.isDir);
      existing.dataset.path = key;
      const checkEl = existing.querySelector('.file-select-check');
      if (checkEl) checkEl.setAttribute('data-path', key);
      const ellEl = existing.querySelector('.file-ellipsis');
      if (ellEl) ellEl.setAttribute('aria-label', 'More actions for ' + f.name);
      const nameEl2 = existing.querySelector('.file-name');
      if (nameEl2) nameEl2.title = key;
    }

    addItem(key, () => {
      const el = makeFileItem(f.name, f.isDir, key, { icon, meta, kind, link: f.isSymlink, download: !f.isDir, thumb });
      if (thumb) el.dataset.thumb = thumb;
      return el;
    });
  });

  // Remove any orphaned nodes (not in new data)
  for (const [, orphan] of oldMap) orphan.remove();

  list.replaceChildren(fragment);
  observeThumbs();

  if (list.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'file-list-empty';
    empty.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span class="empty-title">Empty directory</span>' +
      '<div class="empty-actions">' +
      '<button class="btn btn-ghost" onclick="openOverlay(\'newfile-overlay\');document.getElementById(\'newfile-input\').focus()">New file</button>' +
      '<button class="btn btn-ghost" onclick="openOverlay(\'newfolder-overlay\');document.getElementById(\'newfolder-input\').focus()">New folder</button>' +
      '<button class="btn btn-ghost" onclick="uploadFiles()">Upload</button>' +
      '</div>';
    list.appendChild(empty);
  }

  updateBackBtn();
  setFileListLoading(false);
  return true;
}

let fileItemCounter = 0;

// File list sort: dirs always first (groups depend on it), then key+dir.
// Click a group divider = next key · right-click it = reverse direction.
let fileSort = { key: 'name', dir: 1 };
try {
  const saved = JSON.parse(safeStorage.getItem('wt-file-sort') || 'null');
  if (saved && ['name', 'modified', 'size'].includes(saved.key) && (saved.dir === 1 || saved.dir === -1)) fileSort = saved;
} catch {}
function saveFileSort() { try { safeStorage.setItem('wt-file-sort', JSON.stringify(fileSort)); } catch {} }
function sortFiles(files) {
  const { key, dir } = fileSort;
  const val = (f) => key === 'name' ? (f.name || '').toLowerCase() : key === 'size' ? (f.size || 0) : (f.modified ? new Date(f.modified).getTime() || 0 : 0);
  return [...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const va = val(a), vb = val(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return (a.name || '').localeCompare(b.name || '');
  });
}
const _sortCycle = ['name', 'modified', 'size'];
function cycleFileSort() {
  const i = _sortCycle.indexOf(fileSort.key);
  fileSort.key = _sortCycle[(i + 1) % _sortCycle.length];
  fileSort.dir = fileSort.key === 'name' ? 1 : -1;
  saveFileSort();
  if (currentPath) loadFiles(currentPath);
}

// Single source of truth for extension → kind, shared by fileKind() (tile colour)
// and getFileIcon() (inline SVG). These used to be two hand-maintained lists that
// drifted: `.mjs`/`.cjs`/`.bash`/`.swift` got the *code* icon on a generic tile,
// while `.txt`/`.md`/`.docx` got the generic icon on a *doc* tile. One map, one answer.
const EXT_KIND = (() => {
  const groups = {
    code: ['.js','.jsx','.mjs','.cjs','.ts','.tsx','.json','.py','.c','.h','.cpp','.cc','.hpp','.java','.cs','.sh','.bash','.html','.htm','.css','.xml','.yml','.yaml','.toml','.sql','.go','.rs','.rb','.php','.pl','.swift','.kt','.dart','.lua','.r'],
    // .svg lives here, not under code: it is previewable inline as an image.
    img: ['.png','.jpg','.jpeg','.gif','.webp','.ico','.bmp','.avif','.svg'],
    doc: ['.pdf','.epub','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.md'],
    zip: ['.zip','.tar','.gz','.tgz','.bz2','.xz','.7z','.rar'],
  };
  const m = new Map();
  for (const [kind, exts] of Object.entries(groups)) for (const e of exts) m.set(e, kind);
  return m;
})();

// Icon tile kind (dir/code/img/doc/zip/file) — the values are also CSS class suffixes.
function fileKind(ext, isDir) {
  if (isDir) return 'dir';
  return EXT_KIND.get((ext || '').toLowerCase()) || 'file';
}

function extKind(ext) {
  return EXT_KIND.get((ext || '').toLowerCase()) || 'file';
}

function timeAgo(ts) {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.floor(m) + 'm ago';
  const h = m / 60;
  if (h < 24) return Math.floor(h) + 'h ago';
  const d = h / 24;
  if (d < 30) return Math.floor(d) + 'd ago';
  return new Date(t).toLocaleDateString();
}

// Lazy image thumbnails inside file tiles (IntersectionObserver on the
// scroll wrap; gated by size so huge photos keep the generic tile).
let _thumbObserver = null;
let _thumbBudget = 48;
function ensureThumbObserver() {
  if (_thumbObserver) return;
  if (!('IntersectionObserver' in window)) return;
  const wrap = document.getElementById('file-list-wrap');
  if (!wrap) return;
  _thumbObserver = new IntersectionObserver((es) => {
    for (const en of es) {
      if (!en.isIntersecting) continue;
      const img = en.target;
      _thumbObserver.unobserve(img);
      if (img.dataset.src) { const u = img.dataset.src; img.removeAttribute('data-src'); loadThumbImg(img, u); }
    }
  }, { root: wrap, rootMargin: '200px 0px' });
}
function observeThumbs() {
  const run = () => {
    ensureThumbObserver();
    const imgs = document.querySelectorAll('#file-list img.file-thumb[data-src]');
    if (!_thumbObserver) {
      imgs.forEach(img => { const u = img.dataset.src; img.removeAttribute('data-src'); loadThumbImg(img, u); });
      return;
    }
    imgs.forEach(img => _thumbObserver.observe(img));
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 50);
}
function thumbUrlFor(f) {
  if (!f || f.isDir || !(f.size > 0) || f.size > 600000) return null;
  if (_thumbBudget <= 0) return null;
  _thumbBudget--;
  const v = (f.modified && Date.parse(f.modified)) || 0;
  // No token in the URL (history/server-log leak): the loader below sends
  // auth via the x-pin-token header and swaps in a blob URL instead.
  return `/api/files/image?path=${encodeURIComponent(f.path)}&v=${v}`;
}
// Thumbnail loader: <img> can't send headers, so fetch with x-pin-token and
// hand the element a blob URL. Revokes the previous blob to avoid leaks.
function loadThumbImg(img, url) {
  if (!img || !url) return;
  dropThumbUrl(img);
  img.removeAttribute('src');
  fetch(url, { headers: authToken ? { 'x-pin-token': authToken } : {} })
    .then(r => { if (!r.ok) throw new Error('thumb ' + r.status); return r.blob(); })
    .then(b => { img._blobUrl = URL.createObjectURL(b); img.src = img._blobUrl; })
    .catch(() => { img.remove(); });
}
function dropThumbUrl(img) {
  try { if (img && img._blobUrl) URL.revokeObjectURL(img._blobUrl); } catch {}
  if (img) img._blobUrl = null;
}

// Long names truncate in the MIDDLE (head…tail) so the file extension — the
// most identifying part — stays visible. The raw name rides on data-raw:
// never read .file-name textContent for logic (it contains the … marker).
const FIT_HEAD = 22, FIT_TAIL = 18;
function fitFileName(name) {
  const n = String(name == null ? '' : name);
  if (n.length <= FIT_HEAD + FIT_TAIL + 1) return escHtml(n);
  const dot = n.lastIndexOf('.');
  let tail;
  if (dot > 0 && n.length - dot <= 12) {
    const stem = n.slice(0, dot);
    tail = stem.slice(-Math.max(0, FIT_TAIL - (n.length - dot))) + n.slice(dot);
  } else {
    tail = n.slice(-FIT_TAIL);
  }
  return escHtml(n.slice(0, FIT_HEAD)) + '<span class="fn-ellipsis" aria-hidden="true">…</span>' + escHtml(tail);
}
function fileRowName(row, fallbackPath) {
  try {
    const el = row && row.querySelector('.file-name');
    if (el && el.dataset && el.dataset.raw) return el.dataset.raw;
    if (el && el.textContent && el.textContent.indexOf('…') === -1) return el.textContent;
  } catch {}
  const p = fallbackPath || (row && row.dataset && row.dataset.path) || '';
  return (p.split(/[\\/]/).pop() || p);
}
function paintFileName(nameEl, name, isDir) {
  nameEl.innerHTML = fitFileName(name);
  nameEl.dataset.raw = String(name);
  nameEl.className = 'file-name' + (isDir ? ' file-dir' : '');
}
function makeFileItem(name, isDir, fullPath, o) {
  o = o || {};
  const div = document.createElement('div');
  div.className = 'file-item';
  div.id = 'file-item-' + (++fileItemCounter);
  div.setAttribute('role', 'option');
  div.setAttribute('aria-selected', 'false');
  div.dataset.path = fullPath;
  div.dataset.isDir = String(isDir);
  div.innerHTML = `
    <span class="file-select-check" data-path="${escHtml(fullPath)}"></span>
    <span class="file-icon k-${o.kind || 'file'}">${o.icon || ''}${o.thumb ? `<img class="file-thumb" data-src="${escHtml(o.thumb)}" alt="" onload="this.classList.add('ld')" onerror="this.remove()">` : ''}</span>
    <span class="file-text">
      <span class="file-name ${isDir ? 'file-dir' : ''}" data-raw="${escHtml(name)}" title="${escHtml(fullPath)}">${fitFileName(name)}</span>
      ${o.meta ? `<span class="file-meta">${escHtml(o.meta)}</span>` : ''}
    </span>
    ${o.download ? `<button class="file-quick" tabindex="-1" aria-label="Download ${escHtml(name)}" title="Download"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>` : ''}
    <span class="file-ellipsis" role="button" tabindex="0" aria-label="More actions for ${escHtml(name)}" title="More actions"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></span>
  `;
  return div;
}

// Single delegated click + key handler for all rows (perf: no per-row
// listeners, safe for thousand-file directories). Registered before the
// keyboard nav so ellipsis Enter/Space can stop propagation first.
function setupFileListClicks() {
  const list = document.getElementById('file-list');
  if (!list || list.dataset._clickSetup) return;
  list.dataset._clickSetup = '1';
  const rowInfo = (row) => {
    const curPath = row.dataset.path;
    const curIsDir = row.dataset.isDir === 'true';
    const curName = fileRowName(row, curPath);
    const m = curPath.match(/\.([^.]+)$/);
    return { curPath, curIsDir, curName, ext: m ? '.' + m[1].toLowerCase() : '' };
  };
  const openMenuFor = (row, anchorEl) => {
    const { curPath, curIsDir, curName, ext } = rowInfo(row);
    const rect = anchorEl.getBoundingClientRect();
    showCtxMenu({ clientX: rect.left + rect.width / 2, clientY: rect.bottom + 4, preventDefault() {}, stopPropagation() {} }, { path: curPath, name: curName, isDir: curIsDir, ext });
  };
  list.addEventListener('click', e => {
    const row = e.target.closest('.file-item');
    if (!row || !row.dataset.path) return;
    const { curPath, curIsDir } = rowInfo(row);
    const isParentRow = row.classList.contains('is-parent') || curPath === currentParent;
    if (e.target.closest('.file-select-check')) {
      if (isParentRow) return;
      toggleFileSelection(curPath, row);
      if (selectedFiles.length > 0) document.getElementById('select-actions').style.display = 'flex';
      return;
    }
    if (e.target.closest('.file-quick')) { downloadFile(curPath); return; }
    const ell = e.target.closest('.file-ellipsis');
    if (ell) { e.preventDefault(); e.stopPropagation(); openMenuFor(row, ell); return; }
    if (selectMode) {
      // Directories stay navigable in select mode (mouse + keyboard Enter):
      // only files toggle selection, so keyboard users are never trapped.
      if (isParentRow || curIsDir) { loadFiles(curPath); return; }
      toggleFileSelection(curPath, row); return;
    }
    if (curIsDir) loadFiles(curPath);
    else openFileEditor(curPath);
  });
  list.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.file-ellipsis')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      const row = e.target.closest('.file-item');
      if (row) openMenuFor(row, e.target.closest('.file-ellipsis'));
    }
  });
}

function setupFileListKeyboard() {
  const list = document.getElementById('file-list');
  if (!list || list.dataset._kbSetup) return;
  list.dataset._kbSetup = '1';
  list.setAttribute('tabindex', '0');
  list.addEventListener('keydown', e => {
    const items = [...list.querySelectorAll('.file-item')];
    if (!items.length) return;
    let idx = items.findIndex(el => el.classList.contains('focused'));
    const focusIdx = i => {
      if (i < 0 || i >= items.length) return;
      items.forEach(el => el.classList.remove('focused'));
      items[i].classList.add('focused');
      if (items[i].id) list.setAttribute('aria-activedescendant', items[i].id);
      items[i].scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIdx(idx < 0 ? 0 : Math.min(idx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIdx(idx < 0 ? items.length - 1 : Math.max(0, idx - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); focusIdx(0); }
    else if (e.key === 'End') { e.preventDefault(); focusIdx(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (idx >= 0) items[idx].click(); }
    else if (e.key === 'Backspace' || e.key === 'ArrowLeft') { e.preventDefault(); navigateUp(); }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (selectMode) selectAllFiles(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const prefix = (list._typeAhead || '') + e.key.toLowerCase();
      list._typeAhead = prefix;
      clearTimeout(list._typeAheadTimer);
      list._typeAheadTimer = setTimeout(() => { list._typeAhead = ''; }, 500);
      const found = items.findIndex(el => {
        const nm = fileRowName(el, '');
        return nm && nm.toLowerCase().startsWith(prefix);
      });
      if (found >= 0) focusIdx(found);
    }
  });
}

function setupFileListContextMenu() {
  const list = document.getElementById('file-list');
  if (!list || list.dataset._ctxSetup) return;
  list.dataset._ctxSetup = '1';
  list.addEventListener('contextmenu', e => {
    const item = e.target.closest('.file-item');
    if (!item || !item.dataset.path) return;
    const curPath = item.dataset.path;
    const curIsDir = item.dataset.isDir === 'true';
    const curName = fileRowName(item, curPath);
    const m = curPath.match(/\.([^.]+)$/);
    const ext = m ? '.' + m[1].toLowerCase() : '';
    showCtxMenu(e, { path: curPath, name: curName, isDir: curIsDir, ext });
  });
}

function refreshFiles() {
  if (currentPath) loadFiles(currentPath);
}
function navigateTo(p) {
  if (!p || !String(p).trim()) return loadFiles(homeDir);
  let target = String(p).trim();
  // If relative path, resolve against currentPath
  const isAbsolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\');
  if (!isAbsolute) target = joinPath(currentPath || homeDir, target);
  // Same target + history bookkeeping on success: navigateBack/Forward already
  // restore on failure.
  loadFiles(target);
}
function navigateUp() {
  if (currentParent && currentParent !== currentPath) {
    loadFiles(currentParent);
  }
}
async function navigateBack() {
  if (!navHistory.length) return;
  const target = navHistory.pop();
  navForwardHistory.push(currentPath);
  if (navForwardHistory.length > NAV_HISTORY_MAX) navForwardHistory.splice(0, navForwardHistory.length - NAV_HISTORY_MAX);
  skipHistoryPush = true;
  // Only mutate the queue on success: a failed load restores both stacks so
  // back/forward can't desync (deleted dir, lost permissions).
  const ok = await loadFiles(target);
  if (!ok) { navHistory.push(target); navForwardHistory.pop(); }
  updateBackBtn();
}
async function navigateForward() {
  if (!navForwardHistory.length) return;
  const target = navForwardHistory.pop();
  navHistory.push(currentPath);
  if (navHistory.length > NAV_HISTORY_MAX) navHistory.splice(0, navHistory.length - NAV_HISTORY_MAX);
  skipHistoryPush = true;
  const ok = await loadFiles(target);
  if (!ok) { navForwardHistory.push(target); navHistory.pop(); }
  updateBackBtn();
}
async function getLiveTerminalCwd(tab) {
  // tab.cwd is only refreshed by OSC 7, which most shells never emit — so a
  // plain `cd` left it pointing at the launch dir. Ask the server for the
  // session's CURRENT directory; fall back to the cached value on any failure
  // (unknown session, unsupported platform) so the button never goes dead.
  if (!tab || tab.type === 'preview' || tab.type === 'file') return (tab && tab.cwd) || null;
  if (tab.sessionId) {
    try {
      const r = await api(`/api/sessions/${encodeURIComponent(tab.sessionId)}/cwd`);
      if (r && r.cwd) { tab.cwd = r.cwd; return r.cwd; }
    } catch {}
  }
  return tab.cwd || null;
}
async function goToTerminalDir() {
  const tab = getActiveTab();
  if (!tab) return;
  const target = (await getLiveTerminalCwd(tab)) || tab.cwd;
  if (target) loadFiles(target);
  else if (typeof toast === 'function') toast('No terminal directory yet — open a terminal first', 'info');
}
function updateBackBtn() {
  const back = document.getElementById('back-btn');
  const fwd = document.getElementById('fwd-btn');
  if (back) back.style.opacity = navHistory.length > 0 ? '1' : '0.3';
  if (fwd) fwd.style.opacity = navForwardHistory.length > 0 ? '1' : '0.3';
}

let fileWatchTimer = null;
function startFileWatcher() {
  if (fileWatchTimer) return;
  const watch = () => {
    const sb = document.getElementById('sidebar');
    const sp = document.getElementById('settings-panel');
    if (!sb || sb.classList.contains('hidden') || document.hidden) return;
    if (sp && sp.classList.contains('open')) return;
    if (document.querySelector('.overlay.open')) return;
    const lp = document.getElementById('launchpad');
    if (lp && lp.classList.contains('show')) return;
    if (currentPath) loadFiles(currentPath, { background: true });
  };
  const onVisibility = () => {
    if (document.hidden) {
      clearInterval(fileWatchTimer);
      fileWatchTimer = null;
    } else {
      if (currentPath) loadFiles(currentPath);
      if (!fileWatchTimer) fileWatchTimer = setInterval(watch, 10000);
    }
  };
  document.addEventListener('visibilitychange', onVisibility, { passive: true });
  window.addEventListener('pagehide', () => {
    clearInterval(fileWatchTimer);
    fileWatchTimer = null;
  }, { passive: true });
  fileWatchTimer = setInterval(watch, 10000);
}

// Icon per kind — same EXT_KIND map as fileKind(), so the glyph and the tile colour
// can never disagree for a given extension again.
const FILE_ICONS = {
  code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  img: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  zip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
};

function getFileIcon(ext) {
  return FILE_ICONS[extKind(ext)];
}


function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

function renderBreadcrumb(fullPath) {
  const el = document.getElementById('path-segments');
  if (!el) return;
  const isWin = /\\/.test(fullPath) || /^[A-Za-z]:/.test(fullPath);
  const sep = isWin ? '\\' : '/';
  let html = '';

  if (isWin) {
    // e.g. C:\Users\name or \\server\share\path
    const normalized = fullPath.replace(/\//g, '\\');
    const unc = normalized.startsWith('\\\\');
    let rest = normalized;
    let accumulated = '';
    const segments = [];

    if (unc) {
      const m = normalized.match(/^\\\\[^\\]+\\[^\\]+/);
      if (m) {
        segments.push({ label: m[0], path: m[0] });
        rest = normalized.slice(m[0].length).replace(/^\\+/, '');
        accumulated = m[0];
      }
    } else {
      const driveMatch = normalized.match(/^([A-Za-z]:)(.*)$/);
      if (driveMatch) {
        const root = driveMatch[1] + '\\';
        segments.push({ label: driveMatch[1], path: root });
        rest = (driveMatch[2] || '').replace(/^\\+/, '');
        accumulated = root;
      }
    }

    const parts = rest.split('\\').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      accumulated = accumulated.endsWith('\\') ? accumulated + parts[i] : accumulated + '\\' + parts[i];
      segments.push({ label: parts[i], path: accumulated });
    }

    if (!segments.length) {
      html = `<span style="color:var(--fg2)">\\</span><span style="color:var(--fg2);font-size:11px;margin-left:3px">(root)</span>`;
    } else {
      html = segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        if (isLast) return `<button type="button" class="path-current" data-edit="1" title="${escHtml(seg.label)} — click to edit" aria-current="page">${escHtml(seg.label)}</button>`;
        return `<a href="#" data-path="${escHtml(seg.path)}" style="color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;height:24px;padding:2px 6px;border-radius:var(--radius-sm)">${escHtml(seg.label)}</a>` +
          `<span style="color:var(--fg2);margin:0 2px;display:inline-flex;align-items:center">\\</span>`;
      }).join('');
    }
  } else {
    const parts = fullPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let accumulated = '';
    for (const part of parts) {
      accumulated += '/' + part;
      const isLast = part === parts[parts.length - 1];
      if (isLast) {
        html += `<button type="button" class="path-current" data-edit="1" title="${escHtml(part)} — click to edit" aria-current="page">${escHtml(part)}</button>`;
      } else {
        html += `<a href="#" data-path="${escHtml(accumulated)}" style="color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;height:24px;padding:2px 6px;border-radius:var(--radius-sm)">${escHtml(part)}</a>`;
        html += `<span style="color:var(--fg2);margin:0 2px;display:inline-flex;align-items:center">/</span>`;
      }
    }
    if (!parts.length) {
      html = `<span style="color:var(--fg2)">/</span><span style="color:var(--fg2);font-size:11px;margin-left:6px">(root)</span>`;
    }
  }

  el.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--fg2);flex-shrink:0;vertical-align:middle"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' + html;
  // Deep paths overflow: keep the current (rightmost) end in view.
  try { el.scrollLeft = el.scrollWidth; } catch {}

  if (!el.dataset.delegated) {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-edit]')) { enterPathEdit(); return; }
      const a = e.target.closest('a[data-path]');
      if (a) { e.preventDefault(); navigateTo(a.dataset.path); }
    });
    el.dataset.delegated = '1';
  }
}

// Unified path bar: segments view ↔ editable input (replaces separate breadcrumb div).
// The #path-input keeps its id so existing currentPath sync keeps working.
function enterPathEdit() {
  const bar = document.getElementById('path-bar');
  const input = document.getElementById('path-input');
  if (!bar || !input || bar.classList.contains('editing')) return;
  input.value = currentPath || input.value || '';
  bar.classList.add('editing');
  input.style.display = '';
  input.focus();
  try { input.select(); } catch {}
}
function exitPathEdit(commit) {
  const bar = document.getElementById('path-bar');
  const input = document.getElementById('path-input');
  if (!bar || !input || !bar.classList.contains('editing')) return;
  const val = input.value;
  bar.classList.remove('editing');
  input.style.display = 'none';
  input.value = currentPath || '';
  if (commit) navigateTo(val);
  else document.getElementById('path-edit-btn')?.focus();
}
document.getElementById('path-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); exitPathEdit(true); }
  else if (e.key === 'Escape') { e.preventDefault(); exitPathEdit(false); }
});
// Blur commits a *changed* path instead of silently throwing it away. Tapping
// elsewhere (which dismisses the mobile keyboard) used to look like the field was
// broken — the typed path vanished with no feedback.
document.getElementById('path-input').addEventListener('blur', () => {
  const bar = document.getElementById('path-bar');
  const input = document.getElementById('path-input');
  if (!bar || !input || !bar.classList.contains('editing')) return;
  const typed = (input.value || '').trim();
  if (typed && typed !== currentPath) exitPathEdit(true);
  else exitPathEdit(false);
});

// ═══════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════
let fsClipboard = null;

// Terminal context menu actions (registered once)
function hideTermCtxMenu(restoreFocus = true) {
  const menu = document.getElementById('term-ctx-menu');
  // Only pull focus back when it was inside the menu (keyboard nav or a menu
  // click). Otherwise leave focus alone so dismissing via a click into the
  // file explorer / editor doesn't get stolen back to the terminal.
  const hadFocus = !!(menu && menu.contains(document.activeElement));
  // Capture the target before clearing so focus restores to the tile the
  // menu was opened on (TR-02), not whatever became active underneath.
  const target = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (menu) menu.style.display = 'none';
  document.querySelectorAll('#term-ctx-menu .ctx-submenu-wrap.open').forEach(el => {
    el.classList.remove('open');
    el.querySelector(':scope > .ctx-item')?.setAttribute('aria-expanded', 'false');
  });
  try { termCtxTabId = null; } catch {}
  if (restoreFocus && hadFocus) {
    try { target?.term?.focus(); } catch {}
  }
}
document.getElementById('term-ctx-copy').addEventListener('click', () => {
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  // TR-04: guard the disabled state — the item is aria-disabled with no
  // selection, so explain instead of silently closing.
  const sel = t?.term?.getSelection();
  if (!sel) {
    hideTermCtxMenu();
    try { toast('No text selected to copy', 'info'); } catch {}
    return;
  }
  if (t?.term) {
    navigator.clipboard.writeText(sel).then(() => {
      toast('Copied to clipboard', 'success');
    }).catch(() => {
      document.execCommand('copy');
      toast('Copied to clipboard', 'success');
    });
  }
  hideTermCtxMenu();
});
document.getElementById('term-ctx-paste').addEventListener('click', () => {
  // Capture target via pasteToTerminal's own lookup (it prefers the ctx
  // target while the menu is open) before dismissing.
  pasteToTerminal();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-select-all').addEventListener('click', () => {
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (t?.term) t.term.selectAll();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-select-line').addEventListener('click', () => {
  selectTermLine();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-zoom-in').addEventListener('click', () => {
  applyFontSize((settings.fontSize || 14) + 1);
  hideTermCtxMenu();
});
document.getElementById('term-ctx-zoom-out').addEventListener('click', () => {
  applyFontSize((settings.fontSize || 14) - 1);
  hideTermCtxMenu();
});
document.getElementById('term-ctx-new-tab').addEventListener('click', async () => {
  // TR-06: dismiss synchronously — the CWD lookup hits the network and must
  // not freeze the menu on screen. Target is captured first (hide clears it).
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  const fallback = t?.cwd || currentPath;
  hideTermCtxMenu();
  try {
    const cwd = (await getLiveTerminalCwd(t)) || fallback;
    newTab(null, null, cwd);
  } catch {
    newTab(null, null, fallback);
  }
});
document.getElementById('term-ctx-copy-cwd').addEventListener('click', async () => {
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  const fallback = t?.cwd || currentPath;
  hideTermCtxMenu();
  try {
    const cwd = (await getLiveTerminalCwd(t)) || fallback;
    if (cwd) {
      await navigator.clipboard.writeText(cwd);
      toast('Path copied', 'success');
    }
  } catch {
    toast('Failed to copy directory', 'error');
  }
});
document.getElementById('term-ctx-bookmark').addEventListener('click', async () => {
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  const fallback = t?.cwd || currentPath;
  hideTermCtxMenu();
  try {
    const cwd = (await getLiveTerminalCwd(t)) || fallback;
    if (cwd) {
      const bm = getBookmarks();
      if (bm.some(b => b.path === cwd)) { toast('Already bookmarked', 'info'); }
      else {
        const sep = cwd.includes('\\') ? '\\' : '/';
        bm.push({ name: cwd.split(sep).filter(Boolean).pop() || cwd, path: cwd });
        saveBookmarks(bm);
        toast('Bookmarked', 'success');
      }
    }
  } catch {
    toast('Failed to read directory', 'error');
  }
});
document.getElementById('term-ctx-interrupt').addEventListener('click', () => {
  // TR-02: interrupt the right-clicked tile, not just the active tab.
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  hideTermCtxMenu();
  try {
    if (t?.ws && t.ws.readyState === WebSocket.OPEN) {
      try { sendWsInput(t.ws, '\x03'); } catch { sendKey('\x03'); }
    } else {
      sendKey('\x03');
    }
  } catch { try { sendKey('\x03'); } catch {} }
});
document.getElementById('term-ctx-rename').addEventListener('click', () => {
  // TR-07: dedicated rename entry point — no synthetic dblclick bubbling.
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  hideTermCtxMenu();
  if (t && typeof promptTabRename === 'function') promptTabRename(t);
});
document.getElementById('term-ctx-scroll-top').addEventListener('click', () => {
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (t?.term) t.term.scrollToTop();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-scroll-bottom').addEventListener('click', () => {
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (t?.term) t.term.scrollToBottom();
  hideTermCtxMenu();
});
document.getElementById('term-ctx-clear').addEventListener('click', () => {
  const t = (typeof getTermCtxTarget === 'function' ? getTermCtxTarget() : null) || getActiveTab();
  if (t?.term) t.term.clear();
  hideTermCtxMenu();
});
// Submenu toggle on click (TR-01: re-clamp after expansion so the added
// ~280px can't push items off-screen under overflow clipping).
document.querySelector('#term-ctx-menu .ctx-submenu-wrap > .ctx-item').addEventListener('click', e => {
  e.stopPropagation();
  const wrap = e.currentTarget.closest('.ctx-submenu-wrap');
  wrap.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', wrap.classList.contains('open'));
  if (wrap.classList.contains('open')) {
    try {
      const menu = document.getElementById('term-ctx-menu');
      if (typeof adjustTermMenuPosition === 'function') adjustTermMenuPosition(menu);
      else {
        const rect = menu.getBoundingClientRect();
        const vh = window.innerHeight, vw = window.innerWidth;
        if (rect.bottom > vh - 8) menu.style.top = Math.max(8, vh - rect.height - 8) + 'px';
        if (rect.right > vw - 8) menu.style.left = Math.max(8, vw - rect.width - 8) + 'px';
      }
    } catch {}
  }
});

// ═══════════════════════════════════════════════════════
// CONTEXT MENU KEYBOARD NAVIGATION
// ═══════════════════════════════════════════════════════
function setupCtxMenuKeyboard() {
  ['ctx-menu', 'term-ctx-menu'].forEach(id => {
    const menu = document.getElementById(id);
    if (!menu) return;
    menu.querySelectorAll('.ctx-item').forEach(el => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    });
    const openSubmenu = wrap => {
      wrap.classList.add('open');
      const toggle = wrap.querySelector(':scope > .ctx-item');
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
      // TR-01: the submenu adds height — re-clamp so it can't spill off-screen.
      try {
        const m = wrap.closest('#term-ctx-menu, #ctx-menu, #tab-ctx-menu');
        if (m && typeof adjustTermMenuPosition === 'function') adjustTermMenuPosition(m);
      } catch {}
      const first = wrap.querySelector('.ctx-submenu-items .ctx-item');
      if (first) first.focus();
    };
    const closeSubmenu = wrap => {
      wrap.classList.remove('open');
      const toggle = wrap.querySelector(':scope > .ctx-item');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      if (toggle) toggle.focus();
    };
    const visibleItems = () => [...menu.querySelectorAll('.ctx-item')].filter(el => {
      const subWrap = el.closest('.ctx-submenu-items');
      if (subWrap && !subWrap.parentElement.classList.contains('open')) return false;
      return el.offsetParent !== null;
    });
    menu.addEventListener('keydown', e => {
      const items = visibleItems();
      if (!items.length) return;
      let idx = items.indexOf(document.activeElement);
      const activeItem = document.activeElement;
      switch (e.key) {
        case 'Escape': {
          const wrap = activeItem && activeItem.closest('.ctx-submenu-wrap');
          if (wrap && wrap.classList.contains('open')) {
            closeSubmenu(wrap);
            e.preventDefault();
            // TR-09: stop the global document Escape handler from then
            // closing the whole menu as well (dual-listener race).
            if (e.stopPropagation) e.stopPropagation();
            return;
          }
          if (id === 'ctx-menu') document.getElementById('ctx-menu').classList.remove('open');
          else hideTermCtxMenu();
          e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          return;
        }
        case 'ArrowDown': idx = (idx + 1) % items.length; break;
        case 'ArrowUp': idx = (idx - 1 + items.length) % items.length; break;
        case 'Home': idx = 0; break;
        case 'End': idx = items.length - 1; break;
        case 'ArrowRight': {
          const wrap = activeItem && activeItem.closest('.ctx-submenu-wrap');
          if (wrap && !wrap.classList.contains('open')) { e.preventDefault(); openSubmenu(wrap); }
          return;
        }
        case 'ArrowLeft': {
          const itemsWrap = activeItem && activeItem.closest('.ctx-submenu-items');
          if (itemsWrap && itemsWrap.parentElement) { e.preventDefault(); closeSubmenu(itemsWrap.parentElement); }
          return;
        }
        case 'Enter':
        case ' ':
          if (activeItem && activeItem.classList.contains('ctx-item')) { e.preventDefault(); activeItem.click(); }
          return;
        default: return;
      }
      e.preventDefault();
      if (idx >= 0 && items[idx]) {
        items[idx].focus();
        try { items[idx].scrollIntoView({ block: 'nearest' }); } catch {}
      }
    });
  });
}

function showCtxMenu(e, file) {
  e.preventDefault();
  try { if (typeof hideAllCtxMenus === 'function') hideAllCtxMenus(); } catch {}
  ctxTarget = file;
  const menu = document.getElementById('ctx-menu');
  menu.style.display = 'block';
  document.getElementById('ctx-open').style.display = file.isDir || isImageFile(file.path) || isDocFile(file.path) ? '' : 'none';
  document.getElementById('ctx-edit').style.display = file.isDir ? 'none' : (!canOpenInEditor(file.path) ? 'none' : '');
  // "Open in Tab" is offered for every file (the tab subsystem picks the viewer),
  // but not for directories — those have no panel view to dock.
  document.getElementById('ctx-open-tab').style.display = file.isDir ? 'none' : '';
  document.getElementById('ctx-open-term').style.display = file.isDir ? '' : 'none';
  document.getElementById('ctx-paste').style.display = fsClipboard ? '' : 'none';
  document.getElementById('ctx-zip').style.display = '';
  document.getElementById('ctx-props').style.display = '';
  document.getElementById('ctx-folder-size').style.display = file.isDir ? '' : 'none';
  document.getElementById('ctx-extract').style.display = file.isDir ? 'none' : (file.ext === '.zip' ? '' : 'none');
  // Measure after content is set
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = e.clientX, top = e.clientY;
  // Flip horizontally if overflowing right
  if (left + mw > vw) left = Math.max(0, e.clientX - mw);
  // Flip vertically if overflowing bottom
  if (top + mh > vh) top = Math.max(0, e.clientY - mh);
  // Clamp to viewport
  left = Math.max(0, Math.min(left, vw - mw));
  top = Math.max(0, Math.min(top, vh - mh));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.classList.add('open');
  menu.style.display = '';
  const firstItem = menu.querySelector('.ctx-item');
  if (firstItem) firstItem.focus();
}

document.addEventListener('click', e => {
  document.getElementById('ctx-menu').classList.remove('open');
  // TR-05: clicks inside the terminal menu are owned by the item handlers
  // (which restore focus to the terminal on action). An outside click
  // dismisses without stealing focus — otherwise clicking into the explorer
  // or editor would yank focus back to the terminal.
  try {
    if (e && e.target && e.target.closest && e.target.closest('#term-ctx-menu')) return;
  } catch {}
  hideTermCtxMenu(false);
});

document.getElementById('ctx-open').onclick = () => {
  if (!ctxTarget) return;
  if (ctxTarget.isDir) loadFiles(ctxTarget.path);
  else if (isImageFile(ctxTarget.path) || isDocFile(ctxTarget.path)) openFileEditor(ctxTarget.path);
  else loadFiles(ctxTarget.path);
};
document.getElementById('ctx-edit').onclick = () => ctxTarget && openFileEditor(ctxTarget.path);
// Opens the file as its own tab. Unlike Edit, this can hold several files open at
// once (tab bar + tiles view) while keeping the panel free for something else — and
// if the panel is already showing this very file, the buffer moves rather than being
// re-read, so the two surfaces can't drift apart.
document.getElementById('ctx-open-tab').onclick = () => {
  if (!ctxTarget || ctxTarget.isDir) return;
  const p = ctxTarget.path;
  if (!canOpenInEditor(p) && !isImageFile(p) && !isDocFile(p)) { toast('Preview not supported for this file type — use Download', 'warning'); return; }
  openFileAsTab(p);
};
document.getElementById('ctx-download').onclick = () => {
  if (selectedFiles.length > 0) { downloadSelected(); return; }
  if (ctxTarget) downloadFile(ctxTarget.path);
};
document.getElementById('ctx-zip').onclick = async () => {
  const files = selectedFiles.length > 0 ? selectedFiles : (ctxTarget ? [ctxTarget.path] : []);
  if (!files.length) return;
  // Multiple files bundle into ONE archive via batch-zip (which auto-renames
  // on conflict); a lone file keeps the classic single-file zip.
  if (files.length > 1) { await zipSelected(files); clearSelection(); return; }
  const name = files[0].split(/[\\/]/).pop();
  await zipFile(files[0], name);
  clearSelection();
};

async function zipSelected(files) {
  const base = (currentPath.split(/[\\/]/).filter(Boolean).pop() || 'archive');
  const dest = joinPath(currentPath, base + '.zip');
  // One indeterminate Transfer Center job covers the whole batch-zip call:
  // the server returns once the .zip is on disk, so we don't have item totals
  // to show — same honesty tier as a single server-side archive.
  const job = txCreate('zip', `Zip ${files.length} items`, { filesTotal: files.length });
  const ctrl = new AbortController();
  job.abort = () => { try { ctrl.abort(); } catch {} };
  try {
    const r = await api('/api/files/batch-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: files, destination: dest }),
      signal: ctrl.signal,
    });
    job.abort = null;
    if (r && r.success) {
      txFinish(job, 'done', 'Zipped: ' + r.name);
      toast('Zipped: ' + r.name, 'success');
      refreshFiles();
    } else {
      txFinish(job, 'error', (r && r.error) || 'Zip failed');
      toast((r && r.error) || 'Zip failed', 'error');
    }
  } catch (e) {
    job.abort = null;
    if (e && (e.name === 'AbortError' || job.stopAfterCurrent)) {
      txFinish(job, 'cancelled');
      toast('Zip cancelled', 'warning');
      refreshFiles();
    } else {
      txFinish(job, 'error', (e && e.message) || 'Zip failed');
      toast('Zip failed', 'error');
    }
  }
}
document.getElementById('ctx-extract').onclick = async () => {
  if (!ctxTarget) return;
  await extractZip(ctxTarget.path, ctxTarget.name);
};
document.getElementById('ctx-folder-size').onclick = async () => {
  if (!ctxTarget) return;
  const toastEl = toast('Calculating folder size…', 'info');
  try {
    const res = await fetch(`/api/files/size?path=${encodeURIComponent(ctxTarget.path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toastEl.remove();
    const size = formatSize(data.size);
    toast(ctxTarget.name + ': ' + size, 'success', 5000);
  } catch (e) {
    toastEl.remove();
    toast('Size calc failed: ' + e.message, 'error');
  }
};
document.getElementById('ctx-rename').onclick = () => ctxTarget && startRename(ctxTarget.path, ctxTarget.name);
document.getElementById('ctx-copy-path').onclick = () => { if (!ctxTarget) return; navigator.clipboard.writeText(ctxTarget.path).then(() => toast('Path copied')).catch(() => toast('Copy failed', 'error')); };
document.getElementById('ctx-props').onclick = () => { if (ctxTarget) openProperties(ctxTarget.path); };
document.getElementById('ctx-delete').onclick = () => {
  if (selectedFiles.length > 0) { deleteSelected(); return; }
  if (ctxTarget) deleteFile(ctxTarget);
};
document.getElementById('ctx-open-term').onclick = () => { if (!ctxTarget) return; newTab(`Term @ ${ctxTarget.name}`, null, ctxTarget.path); };
document.getElementById('ctx-copy').onclick = () => {
  const files = selectedFiles.length > 0
    ? selectedFiles.map(p => ({ path: p, name: p.split(/[\\/]/).pop() }))
    : (ctxTarget ? [{ path: ctxTarget.path, name: ctxTarget.name }] : []);
  if (!files.length) return;
  fsClipboard = { action: 'copy', files };
  updatePasteUI();
  mirrorClipboard();
  toast(`Copied ${files.length} item(s)`, 'success');
};
document.getElementById('ctx-cut').onclick = () => {
  const files = selectedFiles.length > 0
    ? selectedFiles.map(p => ({ path: p, name: p.split(/[\\/]/).pop() }))
    : (ctxTarget ? [{ path: ctxTarget.path, name: ctxTarget.name }] : []);
  if (!files.length) return;
  fsClipboard = { action: 'cut', files };
  updatePasteUI();
  mirrorClipboard();
  toast(`Cut ${files.length} item(s)`, 'success');
};
document.getElementById('ctx-paste').onclick = () => pasteFromClipboard(currentPath);

// ── Server clipboard mirror ──────────────────────────────────────────
// The server keeps a session-isolated clipboard (15min TTL) that survives
// refresh, re-auth and other tabs. Mirror every local change there, and
// hydrate from it when pasting with an empty local clipboard (fresh tab).
async function mirrorClipboard() {
  try {
    if (!fsClipboard || !fsClipboard.files || !fsClipboard.files.length) {
      try { await api('/api/clipboard', { method: 'DELETE' }); } catch {}
      return;
    }
    await api('/api/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: fsClipboard.files.map(f => f.path), action: fsClipboard.action }),
    });
  } catch {}
}
async function hydrateClipboard() {
  if (fsClipboard && fsClipboard.files && fsClipboard.files.length) return true;
  try {
    const r = await api('/api/clipboard');
    const cb = r && r.clipboard;
    if (cb && Array.isArray(cb.sources) && cb.sources.length) {
      fsClipboard = {
        action: cb.action === 'cut' ? 'cut' : 'copy',
        files: cb.sources.map(s => ({ path: s, name: String(s).split(/[\\/]/).pop() })),
      };
      updatePasteUI();
      return true;
    }
  } catch {}
  return false;
}
async function pasteFromClipboard(destDir) {
  if (!fsClipboard) await hydrateClipboard();
  if (!fsClipboard) { try { toast('Clipboard is empty — copy or cut files first', 'info'); } catch {} return; }
  pasteFile(destDir || currentPath);
}

function updatePasteUI() {
  const el = document.getElementById('footer-paste-btn');
  if (el) el.style.display = fsClipboard ? '' : 'none';
}

let _conflictResolve = null;

let _pasteBusy = false;

async function pasteFile(destDir, conflictMode, resumeFrom) {
  if (!fsClipboard) return;
  const isResume = typeof resumeFrom === 'number';
  if (_pasteBusy && !isResume) return;
  _pasteBusy = true;
  if (!isResume) _conflictApplyAll = false;
  try {
    // Support both old single-file and new multi-file format
    const allFiles = fsClipboard.files || [{ path: fsClipboard.path, name: fsClipboard.name }];
    // Resume from the conflicted file instead of restarting at file 1
    const startIdx = isResume ? resumeFrom : 0;
    const files = allFiles.slice(startIdx);
    const isCopy = fsClipboard.action === 'copy';
    const ep = isCopy ? '/api/files/copy' : '/api/files/move';
    const kind = isCopy ? 'copy' : 'move';
    // Reattach to the paused job after a conflict choice (Phase 2).
    let job = (isResume && _resumeJobId && Transfers.jobs.get(_resumeJobId)) || null;
    _resumeJobId = null;
    if (job && job.status === 'waiting') { job.status = 'active'; job.sub = ''; }
    if (!job) {
      job = txCreate(kind, (isCopy ? 'Copy ' : 'Move ') + (allFiles.length === 1 ? allFiles[0].name : allFiles.length + ' items'), { filesTotal: allFiles.length });
      job.sub = 'Calculating size…';
      // Best-effort byte preflight via quick metadata calls; never blocks the op.
      try {
        let bytes = 0, ok = true;
        for (const f of allFiles) {
          const st = await api(`/api/files/stat?path=${encodeURIComponent(f.path)}`);
          if (st && typeof st.size === 'number' && !st.isDirectory && !st.error) { f._size = st.size; bytes += st.size; }
          else if (st && st.isDirectory && !st.error) {
            const z = await api(`/api/files/size?path=${encodeURIComponent(f.path)}`);
            if (z && typeof z.size === 'number' && !z.error) { f._size = z.size; bytes += z.size; } else ok = false;
          } else ok = false;
        }
        if (ok && bytes > 0) job.total = bytes;
        else job.sub = '';
      } catch { job.sub = ''; }
      txRender(true);
    }
    let succeeded = (isResume && job._ok) || 0;
    let failed = (isResume && job._failed) || 0;
    let bytesDone = (isResume && job._bytesDone) || 0;
    for (let fi = 0; fi < files.length; fi++) {
      if (job.stopAfterCurrent) break;
      const file = files[fi];
      job.sub = file.name;
      txTick(job, bytesDone);
      const dest = joinPath(destDir, file.name);
      const body = { source: file.path, destination: dest };
      // Apply the chosen mode to the conflicted file (first of a resumed run).
      // With "apply to all" checked, later conflicts inherit it instead of
      // re-prompting for every colliding file in the batch.
      if (conflictMode && (fi === 0 || !isResume || _conflictApplyAll)) body.conflict = conflictMode;
      // Raw fetch with no client timeout: server-side copies of large trees
      // outlive api()'s 30s cap (G2). Aborting only stops the wait, never the fs.
      let r;
      try {
        const ctrl = new AbortController();
        job.abort = () => { try { ctrl.abort(); } catch {} };
        const resp = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-pin-token': authToken },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
        job.abort = null;
        if (resp.status === 401) { try { showPinScreen(); } catch {} throw new Error('Session expired — sign in again'); }
        try { r = await resp.json(); } catch { r = { error: 'Request failed (' + resp.status + ')' }; }
      } catch (e) {
        job.abort = null;
        if ((e && e.name === 'AbortError') || job.stopAfterCurrent) break;
        r = { error: (e && e.message) || 'Network error' };
      }
      if (job.stopAfterCurrent) break;
      if (r.conflict) {
        job._ok = succeeded; job._failed = failed; job._bytesDone = bytesDone;
        job.status = 'waiting'; // pauses the speed/ETA clock (G4)
        _conflictResolve = { destDir, conflictMode: null, resumeFrom: startIdx + fi, action: fsClipboard.action, jobId: job.id };
        document.getElementById('conflict-name').textContent = r.name;
        document.getElementById('conflict-dir-hint').style.display = r.isDir ? '' : 'none';
        document.getElementById('conflict-merge').style.display = r.isDir ? '' : 'none';
        openOverlay('conflict-overlay');
        txRender(true);
        return;
      }
      if (r.success) { succeeded++; bytesDone += file._size || 0; }
      else failed++;
      job.filesDone = succeeded;
      job._ok = succeeded; job._failed = failed; job._bytesDone = bytesDone;
      job.sub = file.name;
      txTick(job, bytesDone);
    }
    job.abort = null;
    const opLabel = isCopy ? 'Pasted' : 'Moved';
    if (job.stopAfterCurrent) {
      txFinish(job, 'cancelled', succeeded ? succeeded + ' done' : '');
      toast('Stopped after ' + succeeded + ' item(s)', 'warning');
    } else if (failed === 0) {
      txFinish(job, 'done', opLabel + ' ' + succeeded + ' item(s)');
      toast(opLabel + ` (${succeeded} item(s))`, 'success');
    }
    else if (succeeded === 0) { txFinish(job, 'error', opLabel + ' failed'); toast(opLabel + ' failed', 'error'); }
    else { txFinish(job, 'error', `${opLabel} ${succeeded}, ${failed} failed`); toast(`${opLabel} ${succeeded}, ${failed} failed`, 'warning'); }
    if (fsClipboard.action === 'cut' && !job.stopAfterCurrent) { fsClipboard = null; updatePasteUI(); mirrorClipboard(); }
    _conflictApplyAll = false;
    refreshFiles();
  } finally {
    _pasteBusy = false;
  }
}

let _conflictBusy = false;
let _resumeJobId = null; // paused Transfer Center job to reattach after a conflict choice
let _conflictApplyAll = false; // "apply to all" from the conflict dialog
function resolveConflict(mode) {
  // Guard double-fire (double-click/Enter+click) and stale state
  if (_conflictBusy || !fsClipboard || !_conflictResolve) return;
  const { destDir, resumeFrom, action, jobId } = _conflictResolve;
  // Clipboard changed since the conflict (e.g. new copy) — don't resume stale queue
  if (!destDir || fsClipboard.action !== action) { _conflictResolve = null; return; }
  // Cancel aborts the whole batch (it used to resume and count 'Cancelled' as
  // one failed item while the rest of the queue kept pasting).
  if (mode === 'cancel') {
    const job = (jobId && Transfers.jobs.get(jobId)) || null;
    _conflictResolve = null; _resumeJobId = null; _conflictApplyAll = false;
    closeOverlay('conflict-overlay');
    if (job) txFinish(job, 'cancelled', job._ok ? job._ok + ' done' : '');
    toast('Paste cancelled', 'warning');
    return;
  }
  _conflictBusy = true;
  try {
    const box = document.getElementById('conflict-apply-all');
    _conflictApplyAll = !!(box && box.checked);
    if (box) box.checked = false;
  } catch { _conflictApplyAll = false; }
  closeOverlay('conflict-overlay');
  _resumeJobId = jobId || null;
  _conflictResolve = null;
  pasteFile(destDir, mode, resumeFrom).finally(() => { _conflictBusy = false; });
}

async function zipFile(path, name) {
  // Zip streams on disk on the server: indeterminate progress + Stop, same
  // shape as copy/move jobs in the Transfer Center.
  const job = txCreate('zip', 'Zip ' + (name || path.split(/[\\/]/).pop()), { filesTotal: 1 });
  const ctrl = new AbortController();
  job.abort = () => { try { ctrl.abort(); } catch {} };
  try {
    const r = await api('/api/files/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      signal: ctrl.signal,
    });
    job.abort = null;
    if (r && r.success) {
      txFinish(job, 'done', r.name ? ('Zipped: ' + r.name) : 'Zipped');
      toast('Zipped: ' + (r.name || name || ''), 'success');
      refreshFiles();
    } else {
      txFinish(job, 'error', (r && r.error) || 'Zip failed');
      toast((r && r.error) || 'Zip failed', 'error');
    }
  } catch (e) {
    job.abort = null;
    if (e && (e.name === 'AbortError' || job.stopAfterCurrent)) {
      txFinish(job, 'cancelled');
      toast('Zip cancelled', 'warning');
      refreshFiles();
    } else {
      txFinish(job, 'error', (e && e.message) || 'Zip failed');
      toast('Zip failed', 'error');
    }
  }
}

async function extractZip(path, name) {
  const label = name || path.split(/[\\/]/).pop();
  const job = txCreate('unzip', 'Unzip ' + label, { filesTotal: 1 });
  const doExtract = async (destName) => api('/api/files/unzip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, ...(destName ? { destName } : {}) }),
  });
  try {
    let r = await doExtract();
    // 409: destination folder exists and isn't empty. Try numbered siblings
    // (archive (1)/, archive (2)/, …) so the operation always has an out.
    if (!r.success && r.dir && /already exists/i.test(r.error || '')) {
      const base = String(r.dir).split(/[\\/]/).pop() || 'extracted';
      let n = 1;
      while (n <= 100) {
        const candidate = `${base} (${n})`;
        const r2 = await doExtract(candidate);
        if (r2.success) { r = r2; break; }
        if (!(r2.dir && /already exists/i.test(r2.error || ''))) { r = r2; break; }
        n++;
      }
      if (n > 100) r = { success: false, error: 'Too many numbered folders' };
    }
    job.abort = null;
    if (r.success) {
      txFinish(job, 'done', r.dir ? ('Extracted: ' + r.dir) : 'Extracted');
      toast('Extracted to: ' + r.dir, 'success');
      refreshFiles();
    } else {
      txFinish(job, 'error', r.error || 'Extract failed');
      toast(r.error || 'Extract failed', 'error');
    }
  } catch (e) {
    job.abort = null;
    txFinish(job, 'error', (e && e.message) || 'Extract failed');
    toast('Extract failed', 'error');
  }
}

// ═══════════════════════════════════════════════════════
// PROPERTIES + CHMOD
// ═══════════════════════════════════════════════════════
let _propsPath = '';
async function openProperties(path) {
  _propsPath = path;
  clearFieldError('props-error');
  const body = document.getElementById('props-body');
  body.innerHTML = '<div style="color:var(--fg2);font-size:12px;padding:8px 0">Loading…</div>';
  document.getElementById('props-mode-row').style.display = 'none';
  document.getElementById('props-save-btn').style.display = 'none';
  openOverlay('props-overlay');
  const st = await api(`/api/files/stat?path=${encodeURIComponent(path)}`);
  if (!st || st.error) { body.innerHTML = '<div style="color:var(--red);font-size:12px">' + escHtml((st && st.error) || 'Failed to load properties') + '</div>'; return; }
  const rows = [
    ['Name', st.name],
    ['Path', st.path],
    ['Type', st.isSymlink ? 'Symlink' : st.isDirectory ? 'Folder' : 'File'],
    ['Size', st.isDirectory ? '—' : formatSize(st.size)],
    ['Modified', st.mtime ? new Date(st.mtime).toLocaleString() : '—'],
    ['Owner', [st.owner, st.group].filter(Boolean).join(':') || (st.uid + ':' + st.gid)],
    ['Permissions', st.permissions || st.mode || '—'],
  ];
  body.innerHTML = rows.map(([k, v]) =>
    '<div class="props-row"><span class="props-k">' + escHtml(k) + '</span><span class="props-v">' + escHtml(String(v == null ? '—' : v)) + '</span></div>'
  ).join('');
  // chmod is meaningless for symlinks (it follows to the target) and a no-op
  // on Windows — offer it only for real files/dirs on non-Windows hosts.
  const canChmod = !st.isSymlink && (serverPlatform !== 'win32');
  document.getElementById('props-mode-row').style.display = canChmod ? '' : 'none';
  document.getElementById('props-save-btn').style.display = canChmod ? '' : 'none';
  if (canChmod) {
    const inp = document.getElementById('props-mode');
    inp.value = st.permissions || st.mode || '';
  }
}

async function savePropsMode() {
  const mode = document.getElementById('props-mode').value.trim();
  if (!/^[0-7]{3,4}$/.test(mode)) { showFieldError('props-error', 'Mode must be 3–4 octal digits (e.g. 755, 644)'); return; }
  clearFieldError('props-error');
  setBtnBusy(document.getElementById('props-save-btn'), true);
  const r = await api('/api/files/chmod', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: _propsPath, mode }),
  });
  setBtnBusy(document.getElementById('props-save-btn'), false);
  if (r && r.success) {
    toast('Permissions updated' + (r.warning ? ' — ' + r.warning : ''), r.warning ? 'warning' : 'success');
    openProperties(_propsPath);
    refreshFiles();
  } else showFieldError('props-error', (r && r.error) || 'chmod failed');
}

// ═══════════════════════════════════════════════════════
// CONTENT SEARCH
// ═══════════════════════════════════════════════════════
function openContentSearch() {
  clearFieldError('cs-error');
  document.getElementById('cs-results').innerHTML = '';
  const p = document.getElementById('cs-path');
  if (p && !p.value) p.value = currentPath || '';
  openOverlay('content-search-overlay');
  setTimeout(() => { try { document.getElementById('cs-query').focus(); } catch {} }, 100);
}

async function runContentSearch() {
  const query = document.getElementById('cs-query').value.trim();
  const dir = document.getElementById('cs-path').value.trim() || currentPath;
  if (!query) { showFieldError('cs-error', 'Enter search text'); return; }
  clearFieldError('cs-error');
  const box = document.getElementById('cs-results');
  box.innerHTML = '<div style="color:var(--fg2);font-size:12px;padding:8px 0">Searching…</div>';
  setBtnBusy(document.getElementById('cs-search-btn'), true);
  let r;
  try {
    r = await api('/api/files/search-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, path: dir, pattern: document.getElementById('cs-regex').checked ? 'regex' : 'string', maxResults: 50 }),
    });
  } finally {
    setBtnBusy(document.getElementById('cs-search-btn'), false);
  }
  if (!r || r.error) { showFieldError('cs-error', (r && r.error) || 'Search failed'); box.innerHTML = ''; return; }
  const results = Array.isArray(r.results) ? r.results : [];
  if (!results.length) { box.innerHTML = '<div style="color:var(--fg2);font-size:12px;padding:8px 0">No matches</div>'; return; }
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'cs-count';
  head.textContent = results.length + ' match' + (results.length === 1 ? '' : 'es') + ((r.count || 0) >= 50 ? ' (capped at 50)' : '');
  box.appendChild(head);
  results.slice(0, 50).forEach(m => {
    const row = document.createElement('button');
    row.className = 'cs-row';
    row.type = 'button';
    const name = String(m.path || '').split(/[\\/]/).pop();
    row.innerHTML = '<span class="cs-file">' + escHtml(name) + '</span>' +
      '<span class="cs-line">:' + escHtml(String(m.line)) + '</span>' +
      '<span class="cs-text">' + escHtml(String(m.content || '')) + '</span>';
    row.title = m.path + ':' + m.line;
    row.addEventListener('click', () => { closeOverlay('content-search-overlay'); openFileEditor(m.path); });
    box.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════
// FILE OPERATIONS
// ═══════════════════════════════════════════════════════
function startRename(path, name) {
  renamePath = path;
  document.getElementById('rename-input').value = name;
  openOverlay('rename-overlay');
  setTimeout(() => document.getElementById('rename-input').select(), 100);
}

async function confirmRename() {
  const newName = document.getElementById('rename-input').value.trim();
  if (!newName) { showFieldError('rename-error', 'Enter a new name'); return; }
  clearFieldError('rename-error');
  setBtnBusy(document.getElementById('rename-ok-btn'), true);
  const r = await api('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath: renamePath, newName })
  });
  setBtnBusy(document.getElementById('rename-ok-btn'), false);
  if (r.success) {
    // Keep open surfaces on the renamed path: otherwise the panel/tab still
    // point at oldPath and the next Ctrl+S recreates the old file, while the
    // crash-safety draft is orphaned under wt-draft:<oldPath>.
    try {
      const oldPath = renamePath;
      const newPath = (r.newPath && typeof r.newPath === 'string') ? r.newPath : joinPath(currentPath, newName);
      if (typeof editorPath === 'string' && editorPath && editorPath === oldPath) {
        editorPath = newPath;
        try { document.getElementById('editor-filename').textContent = newName; } catch {}
      }
      try {
        tabs.forEach(t => {
          if (t && t.type === 'file' && t.path === oldPath) {
            t.path = newPath; t.title = newName;
            try { t.el.querySelector('.tab-title').textContent = newName; } catch {}
            try { if (typeof applyTabMeta === 'function') applyTabMeta(t); } catch {}
            try { if (t.fteName) t.fteName.textContent = newName; } catch {}
          }
        });
      } catch {}
      try {
        const draft = safeStorage.getItem('wt-draft:' + oldPath);
        if (draft != null) { safeStorage.setItem('wt-draft:' + newPath, draft); safeStorage.removeItem('wt-draft:' + oldPath); }
      } catch {}
      try { if (typeof saveTabState === 'function') saveTabState(); } catch {}
    } catch (e) { console.warn('rename sync failed:', e); }
    toast('Renamed', 'success'); refreshFiles(); closeOverlay('rename-overlay');
  }
  else showFieldError('rename-error', r.error || 'Rename failed');
}

async function deleteFile(file) {
  const ok = await confirmDialog({ title: 'Delete', message: `Delete "${file.name}"?${file.isDir ? '\n\nThis will delete the entire directory.' : ''}`, okText: 'Delete', danger: true });
  if (!ok) return;
  const r = await api(`/api/files?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
  if (r.success) { toast('Deleted', 'success'); refreshFiles(); }
  else toast(r.error, 'error');
}

async function downloadFile(filePath) {
  const name0 = filePath.split(/[\\/]/).pop() || 'download';
  const job = txCreate('download', 'Download ' + name0, {});
  const ctrl = new AbortController();
  job.abort = () => { try { ctrl.abort(); } catch {} };
  try {
    const r = await fetch(`/api/files/download?path=${encodeURIComponent(filePath)}`, {
      headers: { 'x-pin-token': authToken }, signal: ctrl.signal
    });
    if (!r.ok) {
      let msg = 'Download failed';
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
      if (r.status === 401) { try { showPinScreen(); } catch {} msg = 'Session expired — sign in again'; }
      txFinish(job, 'error', msg);
      toast(msg, 'error');
      return;
    }
    const ct = r.headers.get('content-type') || '';
    let len = Number(r.headers.get('content-length') || 0);
    if (!(len > 0)) {
      // Fallback for the total: the header needs the restarted server, and a
      // proxy/tunnel may strip it anyway. stat() reports the same file size,
      // so % / ETA still work. Directory zips stay indeterminate (no total).
      try {
        const st = await api(`/api/files/stat?path=${encodeURIComponent(filePath)}`);
        if (st && !st.error && !st.isDirectory && typeof st.size === 'number' && st.size > 0) len = st.size;
      } catch {}
    }
    // Single files report Content-Length (server.js); directory zips stream
    // length-less and stay indeterminate (bytes + speed only).
    if (len > 0) job.total = len;
    txRender(true);
    let name = name0;
    // Server returns application/zip for directories — append .zip if missing
    if (ct.includes('zip') && !name.endsWith('.zip')) name += '.zip';
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    // Large (or unknown-size) downloads stream straight to disk via the File
    // System Access API instead of assembling a multi-GB Blob in the tab's
    // heap. Unavailable (Firefox/Safari, insecure origins) → Blob fallback.
    if (typeof window.showSaveFile === 'function' && (!(len > 0) || len > 64 * 1024 * 1024)) {
      try {
        const handle = await window.showSaveFile({ suggestedName: name });
        const writable = await handle.createWritable();
        try {
          if (reader) {
            for (;;) {
              if (job.stopAfterCurrent) { try { await reader.cancel(); } catch {} break; }
              const { done, value } = await reader.read();
              if (done) break;
              if (value) { await writable.write(value); txTick(job, job.loaded + value.length); }
            }
          } else {
            const blob = await r.blob();
            await writable.write(blob);
            txTick(job, blob.size);
          }
          await writable.close();
        } catch (e) {
          try { await writable.abort(); } catch {}
          throw e;
        }
        job.abort = null;
        if (job.stopAfterCurrent) {
          txFinish(job, 'cancelled', job.loaded ? formatSize(job.loaded) + ' received' : '');
          toast('Download stopped', 'warning');
          return;
        }
        txFinish(job, 'done', formatSize(job.loaded));
      } catch (e) {
        if (e && e.name === 'AbortError') {
          txFinish(job, 'cancelled');
          toast('Download stopped', 'warning');
        } else {
          console.warn('Download failed:', e);
          txFinish(job, 'error', 'Download failed');
          toast('Download failed', 'error');
        }
      }
      return;
    }
    // Stream the body so progress + speed are real. Chunks are still assembled
    // into one Blob for the anchor download — same memory profile as before.
    const chunks = [];
    let loaded = 0;
    if (reader) {
      for (;;) {
        if (job.stopAfterCurrent) { try { await reader.cancel(); } catch {} break; }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); loaded += value.length; txTick(job, loaded); }
      }
    } else {
      const blob = await r.blob();
      loaded = blob.size;
      txTick(job, loaded);
      chunks.push(new Uint8Array(await blob.arrayBuffer()));
    }
    job.abort = null;
    if (job.stopAfterCurrent) {
      txFinish(job, 'cancelled', loaded ? formatSize(loaded) + ' received' : '');
      toast('Download stopped', 'warning');
      return;
    }
    const blob = new Blob(chunks, { type: ct || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 10000);
    txFinish(job, 'done', formatSize(blob.size));
  } catch(e) {
    if (e && e.name === 'AbortError') {
      txFinish(job, 'cancelled');
      toast('Download stopped', 'warning');
    } else {
      console.warn('Download failed:', e);
      txFinish(job, 'error', 'Download failed');
      toast('Download failed', 'error');
    }
  }
}

function joinPath(parent, child) {
  const sep = parent.includes('\\') ? '\\' : '/';
  return parent.replace(/[\\/]$/, '') + sep + child;
}

// ═══════════════════════════════════════════════════════
// SELECT MODE
// ═══════════════════════════════════════════════════════
let selectMode = false;
let selectedFiles = [];

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedFiles = [];
  document.getElementById('select-actions').style.display = selectMode ? 'flex' : 'none';
  document.getElementById('sidebar').dataset.selectMode = selectMode ? 'true' : '';
  const flw = document.getElementById('file-list-wrap');
  if (flw) flw.setAttribute('aria-multiselectable', String(selectMode));
  document.getElementById('select-count').textContent = '0 selected';
  document.querySelector('[onclick="toggleSelectMode()"]')?.classList.toggle('active', selectMode);
  refreshFiles();
}

function toggleFileSelection(path, el) {
  // The ".." parent entry is navigational, never selectable
  if (!path || path === currentParent || (el && el.classList && el.classList.contains('is-parent'))) return;
  const idx = selectedFiles.indexOf(path);
  if (idx > -1) {
    selectedFiles.splice(idx, 1);
    el.classList.remove('selected');
    el.setAttribute('aria-selected', 'false');
    el.querySelector('.file-select-check').classList.remove('on');
  } else {
    selectedFiles.push(path);
    el.classList.add('selected');
    el.setAttribute('aria-selected', 'true');
    el.querySelector('.file-select-check').classList.add('on');
  }
  const count = selectedFiles.length;
  document.getElementById('select-count').textContent = count + ' selected';
  document.getElementById('select-actions').style.display = count > 0 ? 'flex' : 'none';
  const totalItems = [...document.querySelectorAll('.file-item')].filter(el => el.dataset.path !== currentParent).length;
  document.getElementById('select-all-btn').textContent = count === totalItems ? 'Deselect All' : 'Select All';
}

function selectAllFiles() {
  const items = document.querySelectorAll('.file-item');
  const totalCount = [...items].filter(el => el.dataset.path !== currentParent).length;
  if (selectedFiles.length >= totalCount) {
    clearSelection();
    return;
  }
  selectedFiles = [];
  items.forEach(el => {
    const path = el.dataset.path;
    if (!path || path === currentParent) return;
    selectedFiles.push(path);
    el.classList.add('selected');
    el.setAttribute('aria-selected', 'true');
    const check = el.querySelector('.file-select-check');
    if (check) check.classList.add('on');
  });
  const count = selectedFiles.length;
  document.getElementById('select-count').textContent = count + ' selected';
  document.getElementById('select-actions').style.display = count > 0 ? 'flex' : 'none';
  document.getElementById('select-all-btn').textContent = 'Deselect All';
}

function clearSelection() {
  selectedFiles = [];
  document.querySelectorAll('.file-item.selected').forEach(el => {
    el.classList.remove('selected');
    const check = el.querySelector('.file-select-check');
    if (check) check.classList.remove('on');
  });
  document.getElementById('select-count').textContent = '0 selected';
  document.getElementById('select-actions').style.display = 'none';
  document.getElementById('select-all-btn').textContent = 'Select All';
}

// Leaving the directory exits select mode outright: selection + toolbar +
// flag + sidebar state all reset together, so the next folder never inherits
// phantom toggle-clicks with a hidden toolbar.
function exitSelectMode() {
  selectMode = false;
  clearSelection();
  try {
    document.getElementById('sidebar').dataset.selectMode = '';
    document.querySelector('[onclick="toggleSelectMode()"]')?.classList.remove('active');
  } catch {}
}

async function deleteSelected() {
  if (!selectedFiles.length) return;
  const targets = [...selectedFiles];
  const msg = `Delete ${targets.length} item${targets.length > 1 ? 's' : ''}?`;
  const ok = await confirmDialog({ title: 'Delete', message: msg, okText: 'Delete', danger: true });
  if (!ok) return;
  // One batch call instead of N concurrent DELETEs (rate-limiter friendly).
  const r = await api('/api/files/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: targets }),
  });
  const results = (r && Array.isArray(r.results)) ? r.results : null;
  if (!results) { toast((r && r.error) || 'Delete failed', 'error'); }
  else {
    let failed = 0;
    results.forEach(res => {
      if (!res.success) {
        failed++;
        const name = String(res.path || '').split(/[\\/]/).pop();
        toast(`Failed to delete ${name}: ${res.error}`, 'error');
      }
    });
    const done = targets.length - failed;
    if (failed === 0) toast('Deleted', 'success');
    else if (done > 0) toast(`Deleted ${done} item(s), ${failed} failed`, 'warning');
  }
  clearSelection();
  refreshFiles();
}

async function downloadSelected() {
  const files = [...selectedFiles];
  if (!files.length) return;
  // Multi-downloads go through ONE combined archive: staggered synthetic
  // anchor clicks lose the user gesture and browsers popup-block every file
  // after the first. The temp zip is deleted right after the download.
  if (files.length > 1) {
    const base = (currentPath.split(/[\\/]/).filter(Boolean).pop() || 'download');
    const t = toast(`Zipping ${files.length} items…`, 'info');
    try {
      const r = await api('/api/files/batch-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: files, destination: joinPath(currentPath, base + '-download.zip') }),
      });
      try { t.remove(); } catch {}
      if (r && r.success) {
        const zipPath = joinPath(currentPath, r.name);
        clearSelection();
        await downloadFile(zipPath);
        try { await api(`/api/files?path=${encodeURIComponent(zipPath)}`, { method: 'DELETE' }); } catch {}
        refreshFiles();
        return;
      }
      toast((r && r.error) || 'Zip failed', 'error');
    } catch (e) { toast('Zip failed', 'error'); }
    clearSelection();
    return;
  }
  toast(`Downloading ${files.length} item(s)…`, 'info');
  for (let i = 0; i < files.length; i++) {
    await downloadFile(files[i]);
    // Small delay between downloads to avoid browser popup blocking
    if (i < files.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  clearSelection();
}

function newFolder() {
  document.getElementById('newfolder-input').value = '';
  openOverlay('newfolder-overlay');
  setTimeout(() => document.getElementById('newfolder-input').focus(), 100);
}

async function confirmNewFolder() {
  const name = document.getElementById('newfolder-input').value.trim();
  if (!name) { showFieldError('newfolder-error', 'Enter a folder name'); return; }
  clearFieldError('newfolder-error');
  setBtnBusy(document.getElementById('newfolder-ok-btn'), true);
  const r = await api('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: joinPath(currentPath, name) })
  });
  setBtnBusy(document.getElementById('newfolder-ok-btn'), false);
  if (r.success) { toast('Folder created', 'success'); refreshFiles(); closeOverlay('newfolder-overlay'); }
  else showFieldError('newfolder-error', r.error || 'Could not create folder');
}

function newFile() {
  document.getElementById('newfile-input').value = '';
  openOverlay('newfile-overlay');
  setTimeout(() => document.getElementById('newfile-input').focus(), 100);
}

async function confirmNewFile() {
  const name = document.getElementById('newfile-input').value.trim();
  if (!name) { showFieldError('newfile-error', 'Enter a file name'); return; }
  clearFieldError('newfile-error');
  setBtnBusy(document.getElementById('newfile-ok-btn'), true);
  const filePath = joinPath(currentPath, name);
  const r = await api('/api/files/touch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath })
  });
  setBtnBusy(document.getElementById('newfile-ok-btn'), false);
  if (r.success) { refreshFiles(); closeOverlay('newfile-overlay'); openFileEditor(filePath); }
  else showFieldError('newfile-error', r.error || 'Could not create file');
}

// Upload
function uploadFiles() { document.getElementById('upload-input').click(); }

async function handleUploadInput() {
  const input = document.getElementById('upload-input');
  const files = [...input.files];
  if (!files.length) return;
  input.value = '';
  try { await uploadFileList(files); } catch(e) { console.warn('Upload failed:', e); toast('Upload failed', 'error'); }
}
// ═══════════════════════════════════════════════════════
// DRAG & DROP
// ═══════════════════════════════════════════════════════
async function traverseDirectoryEntry(entry, pathPrefix = '', depth = 0) {
  if (depth > 20) return [];
  const files = [];
  if (entry.isFile) {
    try {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push({ file, path: pathPrefix + entry.name });
    } catch (e) { console.warn('Skipping file:', entry.name, e); }
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const entries = await new Promise((resolve, reject) => {
      const allEntries = [];
      function readAll() {
        dirReader.readEntries(results => {
          if (results.length) {
            allEntries.push(...results);
            readAll();
          } else {
            resolve(allEntries);
          }
        }, reject);
      }
      readAll();
    });
    for (const child of entries) {
      const childFiles = await traverseDirectoryEntry(child, pathPrefix + entry.name + '/', depth + 1);
      files.push(...childFiles);
    }
  }
  return files;
}

function setupDragDrop() {
  const overlay = document.getElementById('drop-overlay');
  let dragCnt = 0;

  function isFileDrag(e) {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  document.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragCnt++;
    overlay.classList.add('active');
  });
  document.addEventListener('dragleave', e => {
    if (!isFileDrag(e)) return;
    // Only hide when leaving the viewport (relatedTarget null) or overlay itself
    // Prevents nested dragenter/leave from child elements desyncing counter
    if (!e.relatedTarget || e.relatedTarget === document.documentElement || e.target === overlay) {
      dragCnt = 0;
      overlay.classList.remove('active');
    } else {
      dragCnt--;
      if (dragCnt <= 0) { dragCnt = 0; overlay.classList.remove('active'); }
    }
  });
  document.addEventListener('dragend', () => {
    dragCnt = 0;
    overlay.classList.remove('active');
  });
  window.addEventListener('blur', () => {
    dragCnt = 0;
    overlay.classList.remove('active');
  });
  document.addEventListener('dragover', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  });
  document.addEventListener('drop', async e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragCnt = 0;
    overlay.classList.remove('active');

    try {
      const items = Array.from(e.dataTransfer.items || []);
      if (items.length) {
        const filesToUpload = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry();
            if (entry) {
              try {
                const traversed = await traverseDirectoryEntry(entry);
                filesToUpload.push(...traversed);
              } catch(e) { console.warn(e); }
            } else {
              const file = item.getAsFile();
              if (file) filesToUpload.push({ file, path: file.name });
            }
          }
        }
        if (filesToUpload.length) {
          await uploadFileList(filesToUpload);
        }
      } else if (e.dataTransfer.files.length) {
        await uploadFileList(e.dataTransfer.files);
      }
    } catch (err) { toast('Upload failed', 'error'); }
  });
}
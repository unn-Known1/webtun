// WebTun frontend - git.js (mini-panel: status/diff/log/hunks/stash/tags).


// ═══════════════════════════════════════════════════════
// GIT MINI-PANEL
// ═══════════════════════════════════════════════════════
let gitRoot = null;
let gitRepo = false;
let gitUnsupported = false; // git binary missing on server — stop probing
let _gitReq = 0;
let _gitFetching = false;
let _gitPendingDir = null; // newest dir requested while a probe was in flight
let gitOpen = (() => { try { const v = safeStorage.getItem('wt-git-open'); return v !== null ? v === 'true' : true; } catch(e) { console.warn(e); return true; } })();
function toggleGitPanel() {
  gitOpen = !gitOpen;
  document.getElementById('git-panel').classList.toggle('open', gitOpen);
  try { safeStorage.setItem('wt-git-open', gitOpen); } catch(e) { console.warn(e); }
  if (gitOpen && gitRepo && gitRoot) refreshGitPanel(currentPath, true);
}
async function refreshGitPanel(dir, manual) {
  const section = document.getElementById('git-section');
  if (!section) return;
  if (typeof settings !== 'undefined' && settings.gitEnabled === false) { section.style.display = 'none'; return; }
  if (gitUnsupported || !dir) { if (gitUnsupported) section.style.display = 'none'; return; }
  // Skip background probes when the explorer is hidden; collapse overlaps
  const _sb = document.getElementById('sidebar');
  if (!manual && _sb && _sb.classList.contains('hidden')) return;
  if (_gitFetching && !manual) { _gitPendingDir = dir; return; }
  _gitFetching = true;
  try {
    await _refreshGitPanelInner(section, dir, manual);
    // Catch up on the newest dir requested while we were busy
    if (_gitPendingDir && _gitPendingDir !== dir) {
      const next = _gitPendingDir; _gitPendingDir = null;
      await _refreshGitPanelInner(section, next, false);
    } else {
      _gitPendingDir = null;
    }
  } finally {
    _gitFetching = false;
  }
}
async function _refreshGitPanelInner(section, dir, manual) {
  const myReq = ++_gitReq;
  let st;
  try {
    st = await api(`/api/git/status?path=${encodeURIComponent(dir)}`);
  } catch (e) {
    if (manual) toast('Git refresh failed — ' + ((e && e.message) || 'network error'), 'error');
    return;
  }
  if (myReq !== _gitReq) return;
  if (!st || st.git === false) {
    gitUnsupported = true; section.style.display = 'none';
    if (manual) toast('git is not installed on the server', 'warning');
    return;
  }
  // Transient failure (rate limit, timeout, 500) — keep previous state.
  // Only an explicit isRepo:false means "not a repository".
  if (st.error) {
    if (manual) toast(st.error, 'warning');
    return;
  }
  if (!st.isRepo) {
    // Slim init affordance instead of hiding the section entirely
    gitRepo = false; gitRoot = null;
    section.style.display = '';
    document.getElementById('git-panel').style.display = 'none';
    document.getElementById('git-init-row').style.display = '';
    document.getElementById('git-count').textContent = '';
    document.getElementById('git-sync').textContent = '';
    return;
  }
  gitRepo = true; gitRoot = st.root;
  section.style.display = '';
  document.getElementById('git-panel').style.display = '';
  document.getElementById('git-init-row').style.display = 'none';
  document.getElementById('git-panel').classList.toggle('open', gitOpen);
  const sync = [];
  if (st.ahead > 0) sync.push('↑' + st.ahead);
  if (st.behind > 0) sync.push('↓' + st.behind);
  if (st.stashCount > 0) sync.push('stash ' + st.stashCount);
  document.getElementById('git-sync').textContent = sync.join(' ');
  if (st.upstream) document.getElementById('git-sync').title = 'upstream ' + st.upstream;
  else document.getElementById('git-sync').removeAttribute('title');
  const total = st.staged.length + st.unstaged.length + st.untracked.length + st.unmerged.length;
  renderGitCount(total, st.totalAdded, st.totalDeleted);
  if (!gitOpen) return; // collapsed: header numbers set, skip detail fetches
  renderGitFiles(st);
  try {
    const b = await api(`/api/git/branches?path=${encodeURIComponent(st.root)}`);
    if (myReq !== _gitReq) return;
    renderGitBranches((b && b.branches) || [], st);
  } catch (e) { console.warn('Git branches refresh failed:', e); }
  refreshGitStash(myReq);
  refreshGitLog(myReq);
  refreshGitIdentity(false, myReq);
  refreshGitTags(myReq);
}
function renderGitBranches(branches, st) {
  const sel = document.getElementById('git-branch-sel');
  if (!sel) return;
  sel.innerHTML = '';
  const mk = (val, label, disabled) => {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    if (disabled) o.disabled = true;
    sel.appendChild(o);
  };
  if (st.detached) mk(st.branch.split(' ')[0] || 'HEAD', '⚠ ' + st.branch, true);
  for (const b of (branches || [])) mk(b.name, b.name + (b.upstream ? '' : ' (local)'));
  const cur = (branches || []).find(b => b.current);
  const want = cur ? cur.name : (st.detached ? sel.options[0].value : st.branch);
  sel.value = want;
  if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
  sel.title = 'Switch branch' + (st.upstream ? ' · upstream ' + st.upstream : '');
}
async function gitSwitchBranch(name) {
  if (!gitRoot || !name) return;
  const sel = document.getElementById('git-branch-sel');
  if (sel) sel.disabled = true;
  let r = null;
  try {
    r = await api('/api/git/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, branch: name }) });
  } finally {
    if (sel) sel.disabled = false;
  }
  if (!r || r.error) { toast((r && r.error) || 'Switch failed', 'error'); refreshGitPanel(currentPath); return; }
  toast('On ' + r.branch, 'success');
  refreshGitPanel(currentPath);
}
function gitBranchNew() {
  document.getElementById('git-newbranch-row').style.display = 'flex';
  document.getElementById('git-branch-error').textContent = '';
  const inp = document.getElementById('git-newbranch-input');
  inp.value = '';
  setTimeout(() => inp.focus(), 50);
}
function gitBranchNewCancel() {
  document.getElementById('git-newbranch-row').style.display = 'none';
  document.getElementById('git-newbranch-input').value = '';
  document.getElementById('git-branch-error').textContent = '';
}
async function gitBranchCreate() {
  if (!gitRoot) return;
  const inp = document.getElementById('git-newbranch-input');
  const name = (inp.value || '').trim();
  if (!name) { showFieldError('git-branch-error', 'Enter a branch name'); inp.focus(); return; }
  clearFieldError('git-branch-error');
  const r = await api('/api/git/branch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name }) });
  if (!r || r.error) { showFieldError('git-branch-error', (r && r.error) || 'Create failed'); return; }
  gitBranchNewCancel();
  toast('Created + switched to ' + r.branch, 'success');
  refreshGitPanel(currentPath);
}
async function gitInit() {
  const r = await api('/api/git/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: currentPath }) });
  if (!r || r.error) { toast((r && r.error) || 'Init failed', 'error'); return; }
  toast(r.already ? 'Already a repository' : 'Repository created', 'success');
  gitUnsupported = false;
  refreshGitPanel(currentPath, true);
}
async function gitStash() {
  if (!gitRoot) return;
  const btn = document.getElementById('git-stash-btn');
  setBtnBusy(btn, true);
  const msg = (document.getElementById('git-msg').value || '').trim();
  const r = await api('/api/git/stash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, message: msg }) });
  setBtnBusy(btn, false);
  if (!r || r.error) { toast((r && r.error) || 'Stash failed', 'error'); return; }
  toast('Stashed', 'success');
  refreshGitPanel(currentPath);
}
async function gitStashPop(ref) {
  if (!gitRoot) return;
  const body = { path: gitRoot };
  if (ref) body.ref = ref;
  const r = await api('/api/git/stash/pop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r || r.error) { toast((r && r.error) || 'Pop failed', 'error'); return; }
  toast('Stash restored', 'success');
  refreshGitPanel(currentPath);
}
async function refreshGitStash(myReq) {
  const box = document.getElementById('git-stash-list');
  const cnt = document.getElementById('git-stash-count');
  if (!box || !gitRoot) return;
  const r = await api(`/api/git/stash?path=${encodeURIComponent(gitRoot)}`);
  if (myReq !== undefined && myReq !== _gitReq) return;
  const list = ((r && r.stashes) || []).slice(0, 10);
  box.innerHTML = '';
  cnt.textContent = list.length ? list.length + (list.length === 1 ? ' stash' : ' stashes') : '';
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'git-stash-item';
    d.title = s.ref || '';
    const m = document.createElement('span');
    m.className = 'git-stash-msg';
    m.textContent = s.message || s.ref || 'stash';
    d.appendChild(m);
    const b = document.createElement('button');
    b.textContent = 'Pop';
    b.title = 'Restore ' + (s.ref || 'stash');
    b.addEventListener('click', () => gitStashPop(s.ref));
    d.appendChild(b);
    box.appendChild(d);
  }
}
const gitAbs = (rel) => {
  const sep = gitRoot.includes('\\') ? '\\' : '/';
  return gitRoot.replace(/[\\/]+$/, '') + sep + String(rel || '').replace(/^[/\\]+/, '');
};
async function gitDiscardFile(rel) {
  if (!gitRoot) return;
  const ok = await confirmDialog({ title: 'Discard changes?', message: 'Revert "' + rel + '" to HEAD? Staged changes are kept.', okText: 'Discard', danger: true });
  if (!ok) return;
  const r = await api('/api/git/discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, files: [rel] }) });
  if (!r || r.error) { toast((r && r.error) || 'Discard failed', 'error'); return; }
  toast('Discarded ' + rel, 'success');
  refreshGitPanel(currentPath);
}
async function gitDeleteUntracked(rel) {
  if (!gitRoot) return;
  const ok = await confirmDialog({ title: 'Delete untracked?', message: '"' + rel + '" will be permanently deleted.', okText: 'Delete', danger: true });
  if (!ok) return;
  const r = await api(`/api/files?path=${encodeURIComponent(gitAbs(rel))}`, { method: 'DELETE' });
  if (!r || r.error) { toast((r && r.error) || 'Delete failed', 'error'); return; }
  toast('Deleted ' + rel, 'success');
  loadFiles(currentPath);
  refreshGitPanel(currentPath);
}
function gitViewUntracked(rel) {
  if (!gitRoot) return;
  const abs = gitAbs(rel);
  if (/[/\\]$/.test(rel)) loadFiles(abs);
  else openFileEditor(abs);
}
function gitStatsText(e) {
  if (e && e.binary) return null;
  if (e && typeof e.added === 'number' && typeof e.deleted === 'number') return { added: e.added, deleted: e.deleted };
  if (e && typeof e.added === 'number') return { added: e.added, deleted: 0 };
  return null;
}
function gitStatsEl(e, cls) {
  if (e && e.binary) {
    const b = document.createElement('span');
    b.className = 'git-stats-binary';
    b.textContent = 'binary';
    b.title = 'Binary file — line count unavailable';
    return b;
  }
  const s = gitStatsText(e);
  if (!s) {
    if (cls === 'untracked') {
      const n = document.createElement('span');
      n.className = 'git-stats-new';
      n.textContent = 'new';
      return n;
    }
    return null;
  }
  const w = document.createElement('span');
  w.className = 'git-stats';
  w.title = s.added + ' additions, ' + s.deleted + ' deletions';
  const a = document.createElement('span');
  a.className = 'git-add';
  a.textContent = '+' + s.added;
  w.appendChild(a);
  w.appendChild(document.createTextNode(' '));
  const d = document.createElement('span');
  d.className = 'git-del';
  d.textContent = '−' + s.deleted;
  w.appendChild(d);
  return w;
}
function gitGroupStats(list) {
  let a = 0, d = 0, known = false;
  for (const e of (list || [])) {
    if (e && e.binary) { known = true; continue; }
    if (e && typeof e.added === 'number') { a += e.added; known = true; }
    if (e && typeof e.deleted === 'number') { d += e.deleted; known = true; }
  }
  return known ? { added: a, deleted: d } : null;
}
function renderGitCount(total, added, deleted) {
  const el = document.getElementById('git-count');
  if (!el) return;
  el.innerHTML = '';
  if (!total) return;
  const n = document.createElement('span');
  n.textContent = total + (total === 1 ? ' file' : ' files');
  el.appendChild(n);
  if (typeof added === 'number' && typeof deleted === 'number' && (added > 0 || deleted > 0)) {
    const w = document.createElement('span');
    w.className = 'git-stats';
    w.title = added + ' additions, ' + deleted + ' deletions';
    const a = document.createElement('span');
    a.className = 'git-add';
    a.textContent = '+' + added;
    w.appendChild(a);
    w.appendChild(document.createTextNode(' '));
    const d = document.createElement('span');
    d.className = 'git-del';
    d.textContent = '−' + deleted;
    w.appendChild(d);
    el.appendChild(w);
    el.title = added + ' additions, ' + deleted + ' deletions';
  } else {
    el.removeAttribute('title');
  }
}
function gitFileRow(e, cls) {
  const row = document.createElement('div');
  row.className = 'git-file ' + cls;
  const xy = document.createElement('span');
  xy.className = 'git-xy';
  xy.textContent = cls === 'untracked' ? '?' : (((e.x || '') + (e.y || '')).trim() || '•');
  row.appendChild(xy);
  const nm = document.createElement('span');
  nm.className = 'git-name';
  nm.textContent = e.path;
  nm.title = e.path;
  row.appendChild(nm);
  const stats = gitStatsEl(e, cls);
  if (stats) row.appendChild(stats);
  const addBtn = (label, title, fn, danger) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    if (danger) b.classList.add('danger');
    b.addEventListener('click', ev => { ev.stopPropagation(); fn(b); });
    row.appendChild(b);
  };
  if (cls === 'staged') {
    addBtn('Unstage', 'git restore --staged', () => gitStageOp('unstage', [e.path]));
    addBtn('Diff', 'staged diff', () => openGitDiff(e.path, true));
    addBtn('Hunks', 'per-hunk unstage', b => toggleHunks(b, e.path, true));
  } else if (cls === 'unstaged') {
    addBtn('Stage', 'git add', () => gitStageOp('stage', [e.path]));
    addBtn('Diff', 'unstaged diff', () => openGitDiff(e.path, false));
    addBtn('Hunks', 'per-hunk stage', b => toggleHunks(b, e.path, false));
    addBtn('Discard', 'revert worktree to HEAD', () => gitDiscardFile(e.path), true);
  } else if (cls === 'untracked') {
    addBtn('Stage', 'git add', () => gitStageOp('stage', [e.path]));
    addBtn('View', 'open file', () => gitViewUntracked(e.path));
    addBtn('Delete', 'permanently delete', () => gitDeleteUntracked(e.path), true);
  } else if (cls === 'unmerged') {
    // Plain `git diff` is empty for unmerged paths — diff against HEAD instead
    addBtn('Diff', 'conflict diff vs HEAD', () => openGitDiff(e.path, false, true));
    // After resolving markers in the editor there was no way to stage the
    // result (or work per-hunk) without dropping to a terminal.
    addBtn('Stage', 'git add resolved file', () => gitStageOp('stage', [e.path]));
    addBtn('Hunks', 'per-hunk stage', b => toggleHunks(b, e.path, false));
  }
  return row;
}
function renderGitFiles(st) {
  const box = document.getElementById('git-files');
  box.innerHTML = '';
  const groups = [
    ['Unmerged', st.unmerged, 'unmerged'],
    ['Staged', st.staged, 'staged'],
    ['Unstaged', st.unstaged, 'unstaged'],
    ['Untracked', st.untracked, 'untracked'],
  ];
  let any = false;
  for (const [label, list, cls] of groups) {
    if (!list || !list.length) continue;
    any = true;
    const h = document.createElement('div');
    h.className = 'git-group-label';
    h.textContent = label + ' (' + list.length + ')';
    const gs = gitGroupStats(list);
    if (gs && (gs.added > 0 || gs.deleted > 0)) {
      const w = document.createElement('span');
      w.className = 'git-stats';
      w.style.marginLeft = '6px';
      w.title = gs.added + ' additions, ' + gs.deleted + ' deletions';
      const a = document.createElement('span');
      a.className = 'git-add';
      a.textContent = '+' + gs.added;
      w.appendChild(a);
      w.appendChild(document.createTextNode(' '));
      const d = document.createElement('span');
      d.className = 'git-del';
      d.textContent = '−' + gs.deleted;
      w.appendChild(d);
      h.appendChild(w);
    }
    box.appendChild(h);
    for (const e of list) box.appendChild(gitFileRow(e, cls));
  }
  if (!any) {
    const d = document.createElement('div');
    d.className = 'git-empty';
    d.textContent = 'Working tree clean';
    box.appendChild(d);
  }
  const commitBtn = document.getElementById('git-commit-btn');
  const blocked = st.unmerged.length > 0;
  commitBtn.disabled = blocked;
  commitBtn.title = blocked ? 'Resolve conflicts first' : 'Commit staged changes';
}
async function gitStageOp(op, files) {
  if (!gitRoot) return;
  const r = await api(`/api/git/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, files }) });
  if (r && r.error) toast(r.error, 'error');
  refreshGitPanel(currentPath);
}
async function gitCommit() {
  if (!gitRoot) return;
  clearFieldError('git-msg-error');
  const input = document.getElementById('git-msg');
  const msg = (input.value || '').trim();
  if (!msg) { showFieldError('git-msg-error', 'Message required'); input.focus(); return; }
  const btn = document.getElementById('git-commit-btn');
  setBtnBusy(btn, true);
  const r = await api('/api/git/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, message: msg, all: document.getElementById('git-all-cb').checked }) });
  setBtnBusy(btn, false);
  if (!r || r.error) {
    const msg_ = (r && r.error) || 'Commit failed';
    if (gitIdentityError(msg_)) { refreshGitIdentity(true); toast('Set your author identity first', 'warning'); }
    else showFieldError('git-msg-error', msg_);
    return;
  }
  input.value = '';
  document.getElementById('git-all-cb').checked = false;
  toast('Committed' + (r.hash ? ' ' + r.hash : ''), 'success');
  refreshGitPanel(currentPath);
}
async function gitPushPull(op, extraBody) {
  if (!gitRoot) return;
  // Raw fetch with 90s timeout — api() caps at 30s, too short for big push/pull/fetch
  const btnId = op === 'push' ? 'git-push-btn' : op === 'pull' ? 'git-pull-btn' : 'git-fetch-btn';
  const btn = document.getElementById(btnId);
  setBtnBusy(btn, true);
  try {
    const body = { path: gitRoot, ...(extraBody || {}) };
    if (op === 'pull' && !body.mode) {
      const sel = document.getElementById('git-pull-mode');
      if (sel && ['merge', 'rebase', 'ff-only'].includes(sel.value)) body.mode = sel.value;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    const resp = await fetch(`/api/git/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pin-token': authToken }, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(t);
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j.error) {
      const msg = (j && j.error) || (op + ' failed');
      // First push on a branch without upstream: offer to set it (explicit consent)
      if (op === 'push' && !(extraBody && extraBody.upstream) && /upstream|set-upstream|no upstream/i.test(msg)) {
        const ok = await confirmDialog({ title: 'No upstream branch', message: 'This branch has no upstream. Push and set upstream to origin?', okText: 'Push + set upstream' });
        if (ok) { setBtnBusy(btn, false); gitPushPull('push', { upstream: true }); return; }
      }
      toast(msg, 'error');
    } else {
      const tail = (j.output || '').trim().split('\n').pop() || '';
      const label = op === 'push' ? 'Pushed' : op === 'pull' ? 'Pulled' : 'Fetched';
      toast(label + (tail ? ': ' + tail : ''), 'success');
    }
  } catch (e) {
    toast(op + ' failed: ' + e.message, 'error');
  } finally {
    setBtnBusy(btn, false);
  }
  refreshGitPanel(currentPath);
}
function gitPush() { gitPushPull('push'); }
function gitPull() { gitPushPull('pull'); }
function gitFetch() { gitPushPull('fetch'); }
function gitIdentityError(msg) {
  return /identity|user\.name|user\.email|Author identity|empty ident/i.test(msg || '');
}
async function refreshGitIdentity(force, myReq) {
  const row = document.getElementById('git-identity-row');
  if (!row || !gitRoot) return;
  const r = await api(`/api/git/identity?path=${encodeURIComponent(gitRoot)}`);
  if (myReq !== undefined && myReq !== _gitReq) return;
  const missing = !r || r.error || !r.name || !r.email;
  if (missing || force) {
    row.style.display = 'flex';
    if (r && !r.error) {
      const n = document.getElementById('git-id-name');
      const e = document.getElementById('git-id-email');
      if (n && !n.value && r.name) n.value = r.name;
      if (e && !e.value && r.email) e.value = r.email;
    }
  } else {
    row.style.display = 'none';
  }
}
async function gitSaveIdentity() {
  if (!gitRoot) return;
  clearFieldError('git-identity-error');
  const name = (document.getElementById('git-id-name').value || '').trim();
  const email = (document.getElementById('git-id-email').value || '').trim();
  if (!name || !email) { showFieldError('git-identity-error', 'Name and email are required'); return; }
  const r = await api('/api/git/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name, email }) });
  if (!r || r.error) { showFieldError('git-identity-error', (r && r.error) || 'Save failed'); return; }
  document.getElementById('git-identity-row').style.display = 'none';
  toast('Author identity saved', 'success');
}
async function gitAmend() {
  if (!gitRoot) return;
  clearFieldError('git-msg-error');
  const input = document.getElementById('git-msg');
  const msg = (input.value || '').trim();
  const ok = await confirmDialog({ title: 'Amend last commit?', message: msg ? 'Fold staged changes into HEAD with a new message?' : 'Fold staged changes into HEAD (keep the message)?', okText: 'Amend' });
  if (!ok) return;
  const btn = document.getElementById('git-amend-btn');
  setBtnBusy(btn, true);
  const r = await api('/api/git/amend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, message: msg }) });
  setBtnBusy(btn, false);
  if (!r || r.error) {
    const msg_ = (r && r.error) || 'Amend failed';
    if (gitIdentityError(msg_)) { refreshGitIdentity(true); toast('Set your author identity first', 'warning'); }
    else showFieldError('git-msg-error', msg_);
    return;
  }
  input.value = '';
  toast('Amended' + (r.hash ? ' ' + r.hash : ''), 'success');
  refreshGitPanel(currentPath);
}
async function gitReset() {
  if (!gitRoot) return;
  clearFieldError('git-reset-error');
  const mode = document.getElementById('git-reset-mode').value || 'mixed';
  const ref = (document.getElementById('git-reset-ref').value || '').trim() || 'HEAD';
  if (mode === 'hard') {
    const ok = await confirmDialog({ title: 'Hard reset?', message: 'Reset to "' + ref + '" and DISCARD all worktree + staged changes. This cannot be undone.', okText: 'Reset (hard)', danger: true });
    if (!ok) return;
  }
  const r = await api('/api/git/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, mode, ref }) });
  if (!r || r.error) { showFieldError('git-reset-error', (r && r.error) || 'Reset failed'); return; }
  toast('Reset (' + r.mode + ') to ' + r.hash, 'success');
  refreshGitPanel(currentPath);
}
async function refreshGitTags(myReq) {
  const box = document.getElementById('git-tags-list');
  if (!box || !gitRoot) return;
  const r = await api(`/api/git/tags?path=${encodeURIComponent(gitRoot)}`);
  if (myReq !== undefined && myReq !== _gitReq) return;
  box.innerHTML = '';
  const tags = ((r && r.tags) || []).slice(0, 10);
  for (const name of tags) {
    const d = document.createElement('div');
    d.className = 'git-tag-item';
    d.title = name;
    const n = document.createElement('span');
    n.className = 'git-tag-name';
    n.textContent = name;
    d.appendChild(n);
    const b = document.createElement('button');
    b.textContent = 'Delete';
    b.className = 'danger';
    b.title = 'Delete tag ' + name;
    b.addEventListener('click', () => gitUntag(name));
    d.appendChild(b);
    box.appendChild(d);
  }
}
async function gitTagCreate() {
  if (!gitRoot) return;
  clearFieldError('git-tag-error');
  const name = (document.getElementById('git-tag-input').value || '').trim();
  const msg = (document.getElementById('git-tag-msg').value || '').trim();
  if (!name) { showFieldError('git-tag-error', 'Enter a tag name'); return; }
  const r = await api('/api/git/tag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name, message: msg }) });
  if (!r || r.error) { showFieldError('git-tag-error', (r && r.error) || 'Tag failed'); return; }
  document.getElementById('git-tag-input').value = '';
  document.getElementById('git-tag-msg').value = '';
  toast('Tagged ' + r.name, 'success');
  refreshGitPanel(currentPath);
}
async function gitUntag(name) {
  if (!gitRoot || !name) return;
  const ok = await confirmDialog({ title: 'Delete tag?', message: 'Delete tag "' + name + '"? (The commits stay.)', okText: 'Delete', danger: true });
  if (!ok) return;
  const r = await api('/api/git/untag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, name }) });
  if (!r || r.error) { toast((r && r.error) || 'Delete tag failed', 'error'); return; }
  toast('Deleted tag ' + name, 'success');
  refreshGitPanel(currentPath);
}
async function toggleHunks(btn, file, cached) {
  const row = btn.closest('.git-file');
  if (!row) return;
  const old = row.querySelector('.git-hunks');
  if (old) { old.remove(); btn.textContent = 'Hunks'; return; }
  btn.textContent = '…';
  const r = await api(`/api/git/hunks?path=${encodeURIComponent(gitRoot)}&file=${encodeURIComponent(file)}${cached ? '&cached=1' : ''}`);
  btn.textContent = 'Hunks';
  if (!r || r.error) { toast((r && r.error) || 'Hunks failed', 'error'); return; }
  if (!r.hunks || !r.hunks.length) { toast('No hunks', 'info'); return; }
  const wrap = document.createElement('div');
  wrap.className = 'git-hunks';
  r.hunks.forEach((h, i) => {
    const hd = document.createElement('div');
    hd.className = 'git-hunk';
    const hh = document.createElement('div');
    hh.className = 'git-hunk-head';
    hh.textContent = 'hunk ' + (i + 1) + ' · +' + (h.added || 0) + ' −' + (h.deleted || 0) + (h.truncated ? ' · (preview truncated)' : '');
    hd.appendChild(hh);
    const pre = document.createElement('pre');
    pre.className = 'git-hunk-body';
    for (const line of (h.lines || [])) {
      const s = document.createElement('span');
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) s.className = 'hh';
      else if (line[0] === '+') s.className = 'ha';
      else if (line[0] === '-') s.className = 'hd';
      s.textContent = line + '\n';
      pre.appendChild(s);
    }
    hd.appendChild(pre);
    const b = document.createElement('button');
    b.className = 'sidebar-action-btn';
    b.style.marginTop = '2px';
    b.textContent = cached ? 'Unstage hunk' : 'Stage hunk';
    // Send the header we rendered: indices shift as the tree changes, and an
    // index alone could stage a different hunk than the one clicked.
    b.addEventListener('click', () => hunkOp(file, h.index, cached, h.header));
    hd.appendChild(b);
    wrap.appendChild(hd);
  });
  row.appendChild(wrap);
}
async function hunkOp(file, index, cached, expected) {
  if (!gitRoot) return;
  const r = await api(cached ? '/api/git/unstage-hunk' : '/api/git/stage-hunk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: gitRoot, file, index, expected }) });
  if (!r || r.error) {
    toast((r && r.error) || 'Hunk failed', 'error');
    // The hunk moved or vanished — re-render the list so the buttons match disk.
    if (/refresh and retry/i.test((r && r.error) || '')) refreshGitPanel(currentPath);
    return;
  }
  toast(cached ? 'Hunk unstaged' : 'Hunk staged', 'success');
  refreshGitPanel(currentPath);
}
let gitLogFull = false;
async function refreshGitLog(myReq) {
  const box = document.getElementById('git-log');
  if (!box || !gitRoot) return;
  const n = gitLogFull ? 20 : 5;
  const r = await api(`/api/git/log?path=${encodeURIComponent(gitRoot)}&n=${n}`);
  if (myReq !== undefined && myReq !== _gitReq) return;
  box.innerHTML = '';
  const foot = document.getElementById('git-foot-row');
  if (foot) foot.querySelector('#git-log-more')?.remove();
  if (!r || !r.commits || !r.commits.length) { updateGitFootRow(); return; }
  for (const c of r.commits) {
    const d = document.createElement('div');
    d.className = 'git-log-item';
    d.title = (c.hash || '') + '\n' + (c.author || '') + ' • ' + (c.date || '') + '\nClick for details';
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    const open = () => openGitShow(c.hash);
    d.addEventListener('click', open);
    d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    const subj = document.createElement('span');
    subj.className = 'git-subject';
    const h = document.createElement('span');
    h.className = 'git-hash';
    h.textContent = c.short || '';
    subj.appendChild(h);
    subj.appendChild(document.createTextNode(c.subject || ''));
    d.appendChild(subj);
    const meta = document.createElement('span');
    meta.className = 'git-meta';
    meta.textContent = (c.author || '') + ' • ' + (c.date || '');
    d.appendChild(meta);
    box.appendChild(d);
  }
  if (!gitLogFull && r.commits.length >= 5) {
    const more = document.createElement('button');
    more.className = 'sidebar-action-btn';
    more.id = 'git-log-more';
    more.textContent = 'Show more';
    more.addEventListener('click', () => { gitLogFull = true; refreshGitLog(); });
    (document.getElementById('git-foot-row') || box).appendChild(more);
  }
  updateGitFootRow();
}
async function openGitShow(hash) {
  if (!gitRoot || !hash) return;
  const r = await api(`/api/git/show?path=${encodeURIComponent(gitRoot)}&ref=${encodeURIComponent(hash)}`);
  if (!r || r.error) { toast((r && r.error) || 'Show failed', 'error'); return; }
  const name = String(hash).slice(0, 7);
  const content = r.diff ? (r.truncated ? r.diff + '\n…(truncated at 200KB)' : r.diff) : '(empty commit)';
  openGitReadonly(name + ' (commit)  /  ' + gitRoot, content, r.binary ? 'binary commit' : 'read-only • git show');
}
async function openGitDiff(file, cached, head) {
  if (!gitRoot) return;
  const r = await api(`/api/git/diff?path=${encodeURIComponent(gitRoot)}&file=${encodeURIComponent(file)}${cached ? '&cached=1' : ''}${head ? '&head=1' : ''}`);
  if (!r || r.error) { toast((r && r.error) || 'Diff failed', 'error'); return; }
  const name = (String(file).split(/[\\/]/).pop() || file);
  const content = r.diff ? (r.truncated ? r.diff + '\n…(truncated at 200KB)' : r.diff) : '(no changes)';
  // Read-only diff in the editor tab (editorPath stays empty so Save is a no-op)
  openGitReadonly(name + (cached ? ' (staged diff)' : head ? ' (conflict diff)' : ' (diff)') + '  /  ' + gitRoot, content, r.binary ? 'binary file' : 'read-only • git diff');
}
function openGitReadonly(title, content, status) {
  cleanupDocViewers();
  editorPath = '';
  editorOriginalContent = content;
  document.getElementById('editor-save-btn').style.display = 'none';
  document.getElementById('md-preview-toggle').style.display = 'none';
  document.getElementById('preview-refresh-btn').style.display = 'none';
  const cm = initCodeMirror();
  cm.setValue(content);
  cm.setOption('mode', 'text/plain');
  cm.setOption('readOnly', true);
  document.querySelector('.CodeMirror').style.display = '';
  cm.refresh();
  // Colorize diff lines (additions green, deletions red, hunks accent)
  try {
    const n = Math.min(cm.lineCount(), 10000);
    for (let i = 0; i < n; i++) {
      const t = cm.getLine(i) || '';
      if (t.startsWith('+++') || t.startsWith('---')) cm.addLineClass(i, 'background', 'diff-hunk');
      else if (t[0] === '+') cm.addLineClass(i, 'background', 'diff-add');
      else if (t[0] === '-') cm.addLineClass(i, 'background', 'diff-del');
      else if (t.startsWith('@@') || t.startsWith('diff --git')) cm.addLineClass(i, 'background', 'diff-hunk');
    }
  } catch {}
  updateEditorDirty();
  const preview = document.getElementById('editor-preview');
  preview.classList.remove('active');
  const previewIframe = document.getElementById('editor-preview-iframe');
  if (previewIframe) clearPreviewDoc(previewIframe);
  const mdContent = document.getElementById('md-preview-content');
  if (mdContent) { mdContent.style.display = 'none'; mdContent.innerHTML = ''; }
  mdPreviewActive = false;
  clearPreviewLiveReload();
  document.getElementById('editor-filename').textContent = title;
  document.getElementById('editor-status').textContent = status;
  if (window.innerWidth > 768) document.getElementById('content').classList.add('editor-open');
  document.getElementById('editor-view').classList.add('open');
  requestAnimationFrame(() => { tabs.forEach(tab => { try { fitTerm(tab); } catch (e) {} }); });
}
document.getElementById('git-msg').addEventListener('keydown', e => { if (e.key === 'Enter') gitCommit(); });
document.getElementById('git-newbranch-input').addEventListener('keydown', e => { if (e.key === 'Enter') gitBranchCreate(); });
document.getElementById('git-tag-input').addEventListener('keydown', e => { if (e.key === 'Enter') gitTagCreate(); });
document.getElementById('git-tag-msg').addEventListener('keydown', e => { if (e.key === 'Enter') gitTagCreate(); });
document.getElementById('git-id-email').addEventListener('keydown', e => { if (e.key === 'Enter') gitSaveIdentity(); });
document.getElementById('git-id-name').addEventListener('keydown', e => { if (e.key === 'Enter') gitSaveIdentity(); });
document.getElementById('git-reset-ref').addEventListener('keydown', e => { if (e.key === 'Enter') gitReset(); });
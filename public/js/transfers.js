// WebTun frontend - transfers.js (Transfer Center jobs + upload pipeline.)

// ═══════════════════════════════════════════════════════
// TRANSFER CENTER (Phase 1: upload/download, Phase 2: copy/move)
// Single owner of all transfer progress. Jobs are in-memory only.
// Honesty tiers: upload/download = real bytes+speed; copy/move =
// bytes-if-size-known else n/m files; zip/unzip + delete stay toasts.
// ═══════════════════════════════════════════════════════
const Transfers = {
  jobs: new Map(), seq: 0, pinned: false, _hoverT: null, _renderT: 0,
};
function txNow() { return Date.now(); }
function txFmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  return formatSize(bps) + '/s';
}
function txFmtETA(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 2) return 'a moment left';
  if (sec < 60) return Math.round(sec) + 's left';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + 'm ' + (s < 10 ? '0' : '') + s + 's left';
}
function txFmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}
function txCreate(type, label, opts = {}) {
  const id = 'tx' + (++Transfers.seq) + '-' + txNow().toString(36);
  const job = {
    id, type, label, sub: opts.sub || '',
    total: opts.total || 0, loaded: 0,
    filesTotal: opts.filesTotal || 0, filesDone: 0,
    status: 'active', speed: 0, _lastT: txNow(), _lastLoaded: 0,
    startedAt: txNow(), stalledSince: 0, error: '',
    abort: null, stopAfterCurrent: false,
  };
  Transfers.jobs.set(id, job);
  // Cap memory: keep at most 10 finished jobs.
  const done = [...Transfers.jobs.values()].filter(j => j.status !== 'active' && j.status !== 'waiting');
  if (done.length > 10) {
    done.sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 0; i < done.length - 10; i++) Transfers.jobs.delete(done[i].id);
  }
  txRender(true);
  return job;
}
function txTick(job, loaded) {
  const now = txNow();
  job.loaded = loaded;
  const dt = (now - job._lastT) / 1000;
  if (dt >= 0.4) {
    const inst = (loaded - job._lastLoaded) / dt;
    if (inst >= 0) job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
    job._lastT = now; job._lastLoaded = loaded;
    if (inst > 512) job.stalledSince = 0;
    else if (!job.stalledSince) job.stalledSince = now;
  }
  txRender();
}
function txFinish(job, status, msg) {
  job.status = status;
  if (status === 'done') { if (job.total) job.loaded = job.total; if (job.filesTotal) job.filesDone = job.filesTotal; }
  if (msg) job.error = msg;
  job.abort = null;
  txRender(true);
}
function txActiveJobs() {
  return [...Transfers.jobs.values()].filter(j => j.status === 'active' || j.status === 'waiting');
}
function txJobLine(job) {
  if (job.status === 'waiting') return 'Waiting for conflict choice…';
  if (job.status === 'done') return job.error || 'Done';
  if (job.status === 'cancelled') return 'Stopped' + (job.error ? ' — ' + job.error : '');
  if (job.status === 'error') return job.error || 'Failed';
  const parts = [];
  if (job.total > 0 && job.loaded > 0) {
    parts.push(formatSize(job.loaded) + ' of ' + formatSize(job.total));
    const sp = txFmtSpeed(job.speed);
    if (sp && job.loaded < job.total) {
      if (job.stalledSince && txNow() - job.stalledSince > 3000) parts.push('Stalled…');
      else { parts.push(sp); parts.push(txFmtETA((job.total - job.loaded) / job.speed)); }
    }
  } else if (job.filesTotal > 1) {
    parts.push(job.filesDone + ' of ' + job.filesTotal + ' files');
    const sp = txFmtSpeed(job.speed);
    if (sp) parts.push(sp);
  } else {
    // Single server-side file (copy/move): one atomic POST carries no
    // intra-file signal, so a 0% bar would sit dead until the jump to done.
    // Show honest activity + size context + elapsed instead of a fake 0%.
    const verb = job.type === 'download' ? 'Downloading' : job.type === 'upload' ? 'Uploading' : job.type === 'copy' ? 'Copying' : job.type === 'move' ? 'Moving' : 'Working';
    parts.push(verb + '…');
    if (job.total > 0) parts.push(formatSize(job.total));
    parts.push(txFmtDur(txNow() - job.startedAt) + ' elapsed');
  }
  if (job.sub) parts.push(job.sub);
  return parts.filter(Boolean).join(' · ');
}
function txRender(force) {
  const now = txNow();
  if (!force && now - Transfers._renderT < 250) return;
  Transfers._renderT = now;
  try { document.body.classList.toggle('datasaver', !!(typeof settings !== 'undefined' && settings.datasaver)); } catch {}
  const btn = document.getElementById('transfers-btn');
  const count = document.getElementById('transfers-count');
  const live = document.querySelector('#transfers-livebar > div');
  const liveWrap = document.getElementById('transfers-livebar');
  const list = document.getElementById('transfers-list');
  const sub = document.getElementById('transfers-sub');
  if (!btn || !list) return;
  const active = txActiveJobs();
  btn.classList.toggle('has-active', active.length > 0);
  // The icon only exists when there is something to show: running jobs or
  // undismissed finished ones. Clearing the last job hides it again.
  btn.style.display = Transfers.jobs.size ? '' : 'none';
  if (!Transfers.jobs.size) {
    Transfers.pinned = false;
    try { document.getElementById('transfers-panel').classList.remove('open'); } catch {}
  }
  btn.setAttribute('aria-expanded', document.getElementById('transfers-panel').classList.contains('open') ? 'true' : 'false');
  if (count) { count.textContent = String(active.length); }
  if (sub) sub.textContent = active.length ? active.length + ' active' : '';
  // Aggregate live bar over active jobs with known totals.
  let tl = 0, tt = 0;
  for (const j of active) { if (j.total > 0) { tl += Math.min(j.loaded, j.total); tt += j.total; } }
  if (live && liveWrap) {
    if (tt > 0) { liveWrap.classList.add('on'); live.style.width = Math.min(100, (tl / tt) * 100) + '%'; }
    else liveWrap.classList.toggle('on', active.length > 0 && active.some(j => j.status === 'active'));
  }
  const jobs = [...Transfers.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  if (!jobs.length) { list.innerHTML = '<div class="tx-empty">No transfers yet.<br>Uploads, downloads and copy/move show here with speed.</div>'; return; }
  const ico = (t) => t === 'download'
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
    : t === 'upload'
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  list.innerHTML = jobs.map(j => {
    // Determinate only with real movement: multi-file n/m, or bytes actually
    // flowing. A single in-flight server file shows the shimmer instead of a
    // dead 0% (there is no intra-file signal to report).
    const measurable = (j.total > 0 && j.loaded > 0) || (j.filesTotal > 1 && j.filesDone > 0);
    const pct = (j.total > 0 && j.loaded > 0) ? Math.min(100, Math.round((j.loaded / j.total) * 100)) : (j.filesTotal > 1 ? Math.round((j.filesDone / j.filesTotal) * 100) : 0);
    const showPct = (j.total > 0 && j.loaded > 0) || j.filesTotal > 1;
    const st = j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : j.status === 'waiting' ? 'waiting' : 'active';
    const canCancel = j.status === 'active';
    const btn2 = canCancel ? `<button class="tx-act danger" onclick="cancelTransfer('${j.id}')">Stop</button>`
      : (j.status !== 'active' && j.status !== 'waiting') ? `<button class="tx-act" onclick="dismissTransfer('${j.id}')">Dismiss</button>` : '';
    return `<div class="tx-job" data-status="${st}"><div class="tx-row1"><span class="tx-ico ${j.type === 'download' ? 'dl' : j.type === 'copy' || j.type === 'move' ? 'mv' : ''}">${ico(j.type)}</span><span class="tx-name" title="${escHtml(j.label)}">${escHtml(j.label)}</span><span class="tx-pct">${showPct ? pct + '%' : ''}</span></div>`
      + `<div class="tx-bar" role="progressbar" aria-label="${escHtml(j.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="tx-fill ${(j.status === 'active' && !measurable && j.filesTotal <= 1) ? 'indet' : ''}" style="${showPct ? 'width:' + pct + '%' : ''}"></div></div>`
      + `<div class="tx-row2"><span class="tx-meta" aria-live="off">${escHtml(txJobLine(j))}</span>${btn2}</div></div>`;
  }).join('');
}
function toggleTransfersPanel(e, forceClose) {
  if (e) { try { e.stopPropagation(); } catch {} }
  const p = document.getElementById('transfers-panel');
  if (!p) return;
  const willOpen = forceClose ? false : !p.classList.contains('open');
  if (willOpen && e && e.type === 'click') Transfers.pinned = true;
  if (!willOpen) Transfers.pinned = false;
  p.classList.toggle('open', willOpen);
  txRender(true);
}
function dismissTransfer(id) { Transfers.jobs.delete(id); txRender(true); }
function clearFinishedTransfers() {
  for (const [id, j] of Transfers.jobs) { if (j.status !== 'active' && j.status !== 'waiting') Transfers.jobs.delete(id); }
  txRender(true);
}
function cancelTransfer(id) {
  const job = Transfers.jobs.get(id);
  if (!job || (job.status !== 'active')) return;
  // Honest cancel: network ops abort now and their handlers finish the job;
  // copy/move loops stop after the current file (the in-flight request cannot
  // be un-done server-side, so "Stop" never claims server work halted).
  job.stopAfterCurrent = true;
  if (job.type === 'copy' || job.type === 'move') job.sub = 'Stopping after current file…';
  try { if (job.abort) job.abort(); } catch {}
  txRender(true);
}
(function initTransfersPanel() {
  const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  const btn = document.getElementById('transfers-btn');
  const panel = document.getElementById('transfers-panel');
  if (!btn || !panel) return;
  if (fine) {
    btn.addEventListener('mouseenter', () => {
      clearTimeout(Transfers._hoverT);
      if (!panel.classList.contains('open')) { Transfers.pinned = false; panel.classList.add('open'); txRender(true); }
    });
    btn.addEventListener('mouseleave', () => {
      clearTimeout(Transfers._hoverT);
      Transfers._hoverT = setTimeout(() => { if (!Transfers.pinned) { panel.classList.remove('open'); txRender(true); } }, 250);
    });
    panel.addEventListener('mouseenter', () => clearTimeout(Transfers._hoverT));
    panel.addEventListener('mouseleave', () => {
      clearTimeout(Transfers._hoverT);
      Transfers._hoverT = setTimeout(() => { if (!Transfers.pinned) { panel.classList.remove('open'); txRender(true); } }, 250);
    });
  }
  document.addEventListener('click', (e) => {
    if (!Transfers.pinned) return;
    if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
      Transfers.pinned = false; panel.classList.remove('open'); txRender(true);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open') && !document.querySelector('.overlay.open')) {
      Transfers.pinned = false; panel.classList.remove('open'); txRender(true);
    }
  });
})();

let _uploadProgressTimeout = null;
let _currentUploadXhr = null;
let _uploadCancelled = false;
// Legacy shims: the old header bar is retired (hidden); progress lives in the
// Transfer Center. Kept so any missed caller degrades to a toast, not a crash.
function setUploadProgress(pct, status, text) {
  if (text) { try { toast(text, status === 'error' ? 'error' : status === 'success' ? 'success' : 'info'); } catch {} }
}
function clearUploadProgress(delay = 1500) { clearTimeout(_uploadProgressTimeout); }
function cancelUpload() {
  _uploadCancelled = true;
  for (const j of Transfers.jobs.values()) {
    if (j.type === 'upload' && j.status === 'active') { cancelTransfer(j.id); break; }
  }
  try { if (_currentUploadXhr) _currentUploadXhr.abort(); } catch {}
  _currentUploadXhr = null;
  toast('Upload cancelled', 'warning');
}

async function uploadFileList(items) {
  const path = encodeURIComponent(currentPath);
  const files = items.map(item => ({ file: item.file || item, name: item.path || item.webkitRelativePath || item.name }));
  const total = files.length;
  if (!total) return;
  const totalBytes = files.reduce((n, f) => n + ((f.file && f.file.size) || 0), 0);
  const job = txCreate('upload', total === 1 ? 'Upload ' + files[0].name : 'Upload ' + total + ' files', { total: totalBytes, filesTotal: total });
  let completed = 0;
  let failedItems = [];
  let baseLoaded = 0;
  _uploadCancelled = false;
  job.abort = () => { _uploadCancelled = true; try { if (_currentUploadXhr) _currentUploadXhr.abort(); } catch {} };
  
  for (const item of files) {
    if (_uploadCancelled || job.stopAfterCurrent) break;
    const file = item.file;
    const fileName = item.name;
    const formData = new FormData();
    formData.append('files', file, fileName);
    
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        _currentUploadXhr = xhr;
        xhr.open('POST', `/api/files/upload?path=${path}`);
        xhr.setRequestHeader('x-pin-token', authToken);
        
        // Progress fires per network chunk (dozens per second). txTick() feeds
        // txRender(), which already throttles DOM writes to ~4 Hz — so paint
        // directly: the old requestAnimationFrame gate froze the % in a
        // background tab (rAF never fires when hidden), exactly when a big
        // upload runs longest.
        xhr.upload.addEventListener('progress', e => {
          if (!e.lengthComputable) return;
          job.sub = fileName;
          txTick(job, baseLoaded + e.loaded);
        });
        
        xhr.onload = () => {
          _currentUploadXhr = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const resp = JSON.parse(xhr.responseText);
              if (resp.success) {
                completed++;
                job.filesDone = completed;
                baseLoaded += (file && file.size) || 0;
                job.sub = fileName;
                txTick(job, baseLoaded);
                resolve();
              } else {
                failedItems.push(fileName);
                reject(new Error(resp.error || 'Upload failed'));
              }
            } catch(e) {
              // A 2xx with an unparseable body is NOT success: the server
              // did not confirm the write. Count it as failed so the batch
              // summary and retry path see it.
              console.warn('Upload XHR response parse error:', e);
              failedItems.push(fileName);
              reject(new Error('Upload failed (bad server response)'));
            }
          } else {
            failedItems.push(fileName);
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };
        
        xhr.onerror = () => {
          _currentUploadXhr = null;
          if (_uploadCancelled) { reject(new Error('Cancelled')); return; }
          failedItems.push(fileName);
          reject(new Error('Network error'));
        };
        xhr.onabort = () => {
          _currentUploadXhr = null;
          reject(new Error('Cancelled'));
        };
        xhr.send(formData);
      });
    } catch (e) {
      if (_uploadCancelled || job.stopAfterCurrent) break;
      console.warn('Upload item failed:', e);
    }
  }
  
  _currentUploadXhr = null;
  job.abort = null;
  if (_uploadCancelled || job.stopAfterCurrent) {
    txFinish(job, 'cancelled', completed ? completed + '/' + total + ' uploaded' : '');
    toast('Upload stopped', 'warning');
    refreshFiles();
    return;
  }
  if (failedItems.length === 0) {
    txFinish(job, 'done', completed + '/' + total + ' uploaded');
    toast('Upload complete (' + completed + '/' + total + ')', 'success');
  } else if (completed > 0) {
    txFinish(job, 'error', completed + ' ok, ' + failedItems.length + ' failed');
    toast(failedItems.length + ' upload(s) failed', 'error');
  } else {
    txFinish(job, 'error', 'All ' + total + ' failed');
    toast('All ' + total + ' uploads failed', 'error');
  }
  
  refreshFiles();
}
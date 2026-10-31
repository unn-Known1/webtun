// WebTun frontend - security.js (sessions, PIN flow, alerts, tunnels.)

// ── Security: set / change / disable PIN ──
async function updateSecurityUI() {
  let prot = null;
  try {
    const r = await api('/api/auth/required');
    if (r && r.required !== undefined) prot = !!r.required;
  } catch (e) { console.warn('Auth status check failed:', e); }
  const label = document.getElementById('pin-state-label');
  const pill = document.getElementById('sec-pin-status');
  const cur = document.getElementById('pin-current');
  if (prot === null) {
    if (label) label.textContent = 'Unknown';
    if (pill) { pill.textContent = '?'; pill.classList.remove('on'); }
    return prot;
  }
  if (label) {
    label.textContent = prot ? 'ON — PIN required' : 'OFF — open access';
    label.style.color = prot ? 'var(--green)' : 'var(--fg2)';
  }
  if (pill) {
    pill.textContent = prot ? 'Protected' : 'Open';
    pill.classList.toggle('on', prot);
  }
  if (cur) cur.disabled = !prot;
  return prot;
}
async function changePin() {
  clearFieldError('pin-field-error');
  const curEl = document.getElementById('pin-current');
  const newEl = document.getElementById('pin-new');
  const cur = (curEl.value || '').trim();
  const next = (newEl.value || '').trim();
  if (/[\r\n\0]/.test(next)) { showFieldError('pin-field-error', 'PIN contains invalid characters'); return; }
  if (next.length > 64) { showFieldError('pin-field-error', 'PIN must be 64 characters or less'); return; }
  // Short PINs fall to trivial guessing: floor new PINs at 4 characters.
  // (Server accepts any length for back-compat with existing setups.)
  if (next && next.length < 4) { showFieldError('pin-field-error', 'PIN must be at least 4 characters'); newEl.focus(); return; }
  const prot = await updateSecurityUI();
  if (prot && !cur) { showFieldError('pin-field-error', 'Enter the current PIN'); curEl.focus(); return; }
  if (!next) {
    const ok = await confirmDialog({ title: 'Remove protection?', message: 'Anyone with access to WebTun will be able to open it. Continue?', okText: 'Remove PIN', danger: true });
    if (!ok) return;
  }
  const btn = document.getElementById('pin-save-btn');
  setBtnBusy(btn, true);
  const r = await api('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPin: cur, newPin: next }) });
  setBtnBusy(btn, false);
  if (!r || !r.success) { showFieldError('pin-field-error', (r && r.error) || 'Failed to update PIN'); return; }
  // Fresh sessions need a second session's approval while others exist —
  // the change pends instead of applying. Nothing rotated yet.
  if (r.pending) {
    toast('Approval needed — approve from another signed-in tab within 60s', 'warning');
    try { refreshSessions(); } catch {}
    return;
  }
  // PIN rotation revokes all session tokens server-side — log back in to
  // mint a fresh one so subsequent calls keep working.
  if (!next) {
    authToken = 'open';
    storeSessionToken('');
  } else {
    try {
      // Raw fetch on purpose: api() would attach the pre-rotation (now dead)
      // session token and checkPin would 401 before the PIN is even read.
      const lr = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: next, device: clientDeviceLabel() })
      }).then(r => r.json());
      if (lr && lr.success && lr.token) {
        authToken = lr.token;
        storeSessionToken(lr.token);
      } else {
        showPinScreen();
        toast('PIN updated — sign in again', 'info');
        return;
      }
    } catch {
      showPinScreen();
      toast('PIN updated — sign in again', 'info');
      return;
    }
  }
  curEl.value = ''; newEl.value = '';
  updateSecurityUI();
  toast(!next ? 'PIN removed — open access' : 'PIN updated', 'success');
  if (!r.persisted) toast('Active now, but .env is not writable — restart will revert (' + (r.persistError || 'write failed') + ')', 'warning');
  try { refreshSessions(); } catch {}
}

// ── Security: active login sessions ──
// Live session count drawn on the coffee cup itself (hidden when 0/unknown/open mode)
async function updateSessionCupCount() {
  const num = document.getElementById('sess-cup-num');
  if (!num) return;
  if (!window._appUnlocked || !authToken || authToken === 'open') { num.style.display = 'none'; return; }
  try {
    const r = await api('/api/auth/sessions');
    const n = r && Array.isArray(r.sessions) ? r.sessions.length : 0;
    if (n > 0) {
      num.textContent = n > 9 ? '9+' : String(n);
      num.style.display = '';
      // Merged with the wake-lock title in syncKeepAwakeUI (dataset, not a
      // direct title write — last writer used to win and erase the other).
      try {
        const label = num.parentElement?.closest('label');
        if (label) {
          label.dataset.sessSuffix = n === 1 ? ' — 1 active login session (open Security to review)' : ` — ${n} active login sessions (open Security to review)`;
          label.title = (settings.keepAwake ? 'Keep Screen Awake — ON (screen stays on)' : 'Keep Screen Awake') + label.dataset.sessSuffix;
        }
      } catch {}
    } else {
      num.style.display = 'none';
    }
  } catch { /* leave last state on failure */ }
}
// The session count badge lives inside the keep-awake <label>: a plain click
// on it would bubble to the label and toggle the wake-lock checkbox instead
// of reviewing sessions. Intercept it and open Security Review instead.
(function wireSessionBadge() {
  const wire = () => {
    const num = document.getElementById('sess-cup-num');
    if (!num || num.dataset._secWired) return;
    num.dataset._secWired = '1';
    try { num.style.cursor = 'pointer'; } catch {}
    num.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch {}
      try { e.stopPropagation(); } catch {}
      try { if (typeof openSecurityReview === 'function') openSecurityReview(); } catch {}
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();
})();
// Static fallback lines via textContent (never innerHTML), so a future edit
// can't accidentally turn these into an injection sink.
function setListMessage(list, msg) {
  if (!list) return;
  list.textContent = '';
  const d = document.createElement('div');
  d.className = 'settings-list-message';
  d.textContent = msg;
  list.appendChild(d);
}
async function refreshSessions() {
  try { updateSessionCupCount(); } catch {}
  try { refreshTrustedBrowsers(); } catch {}
  const list = document.getElementById('sessions-list');
  const count = document.getElementById('sess-count');
  if (!list) return;
  const r = await api('/api/auth/sessions');
  if (!r || !Array.isArray(r.sessions)) {
    setListMessage(list, 'Sign in to view sessions.');
    if (count) count.textContent = '';
    return;
  }
  if (count) count.textContent = r.sessions.length ? `(${r.sessions.length})` : '';
  list.innerHTML = '';
  // Pending PIN rotation banner (approve here if the modal was dismissed)
  if (r.pending) {
    const banner = document.createElement('div');
    banner.className = 'settings-session-notice';
    const t = document.createElement('div');
    t.style.cssText = 'margin-bottom:6px';
    t.textContent = r.pending.mine
      ? 'Your PIN change is awaiting approval from another signed-in tab.'
      : `PIN change requested by ${r.pending.device || 'unknown device'} (${r.pending.ip || 'unknown IP'}).`;
    banner.appendChild(t);
    if (!r.pending.mine) {
      const row = document.createElement('div');
      row.className = 'settings-actions';
      const ap = document.createElement('button');
      ap.className = 'btn btn-primary';
      ap.textContent = 'Approve';
      ap.onclick = () => approvePinChange();
      const ve = document.createElement('button');
      ve.className = 'btn btn-ghost';
      ve.textContent = 'Revert & kick';
      ve.onclick = () => vetoPinChange();
      row.appendChild(ap); row.appendChild(ve);
      banner.appendChild(row);
    }
    list.appendChild(banner);
  }
  if (!r.sessions.length) {
    setListMessage(list, 'No other sessions. This device only.');
    return;
  }
  for (const s of r.sessions) {
    const row = document.createElement('div');
    row.className = 'settings-session';
    const info = document.createElement('div');
    info.className = 'settings-session-info';
    const title = document.createElement('div');
    title.className = 'settings-session-title';
    title.textContent = (s.device || 'Unknown device') + (s.current ? ' · this device' : '') + (s.status === 'pending' ? ' · awaiting approval' : '');
    const sub = document.createElement('div');
    sub.className = 'settings-session-meta';
    sub.textContent = `${s.ip || 'unknown IP'} · ${s.status === 'pending' ? 'requested ' + timeAgo(s.createdAt) : 'active ' + timeAgo(s.lastSeen || s.createdAt)}`;
    info.appendChild(title); info.appendChild(sub);
    row.appendChild(info);
    if (s.status === 'pending' && !s.current) {
      const ap = document.createElement('button');
      ap.className = 'btn btn-primary';
      ap.textContent = 'Approve';
      ap.setAttribute('aria-label', 'Approve session ' + (s.device || s.ip || ''));
      ap.onclick = () => approveSession(s.id);
      row.appendChild(ap);
      const dn = document.createElement('button');
      dn.className = 'btn btn-ghost';
      dn.textContent = 'Deny';
      dn.setAttribute('aria-label', 'Deny session ' + (s.device || s.ip || ''));
      dn.onclick = () => revokeSession(s.id);
      row.appendChild(dn);
    } else if (!s.current) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Revoke';
      btn.setAttribute('aria-label', 'Revoke session ' + (s.device || s.ip || ''));
      btn.onclick = () => revokeSession(s.id);
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}
async function approveSession(id) {
  if (!id) return;
  const r = await api(`/api/auth/sessions/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  if (r && r.success) { toast('Device approved', 'success'); refreshSessions(); }
  else toast((r && r.error) || 'Approve failed', 'error');
}
async function revokeSession(id) {
  if (!id) return;
  const ok = await confirmDialog({ title: 'Revoke session?', message: 'That device will be signed out immediately.', okText: 'Revoke', danger: true });
  if (!ok) return;
  const r = await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (r && r.success) { toast('Session revoked', 'success'); refreshSessions(); }
  else toast((r && r.error) || 'Revoke failed', 'error');
}
async function revokeOtherSessions() {
  const r = await api('/api/auth/sessions');
  if (!r || !Array.isArray(r.sessions)) { toast('Could not list sessions', 'error'); return; }
  const others = r.sessions.filter(s => !s.current);
  if (!others.length) { toast('No other sessions', 'info'); return; }
  const ok = await confirmDialog({ title: 'Sign out others?', message: `End ${others.length} other session(s)? This device stays signed in.`, okText: 'Sign out others', danger: true });
  if (!ok) return;
  const results = await Promise.allSettled(others.map(s =>
    api(`/api/auth/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
  ));
  const done = results.filter(x => x.status === 'fulfilled' && x.value && x.value.success).length;
  const failed = others.length - done;
  if (failed) console.warn(`Failed to revoke ${failed} session(s)`);
  toast(failed ? `Signed out ${done} session(s), ${failed} failed` : `Signed out ${done} session(s)`, failed ? 'warning' : 'success');
  refreshSessions();
}
async function refreshTrustedBrowsers() {
  const list = document.getElementById('trusted-browsers-list');
  const count = document.getElementById('trusted-browsers-count');
  if (!list) return;
  const r = await api('/api/auth/safe-devices');
  if (!r || !Array.isArray(r.devices)) {
    setListMessage(list, 'Sign in to view trusted browsers.');
    if (count) count.textContent = '';
    return;
  }
  if (count) count.textContent = r.devices.length ? `(${r.devices.length})` : '';
  list.innerHTML = '';
  if (!r.devices.length) {
    setListMessage(list, 'No trusted browsers remembered.');
    return;
  }
  for (const dev of r.devices) {
    const row = document.createElement('div');
    row.className = 'settings-session';
    const info = document.createElement('div');
    info.className = 'settings-session-info';
    const title = document.createElement('div');
    title.className = 'settings-session-title';
    title.textContent = (dev.device || 'Unknown browser') + (dev.current ? ' · this browser' : '');
    const sub = document.createElement('div');
    sub.className = 'settings-session-meta';
    sub.textContent = `${dev.ip || 'unknown IP'} · active ${timeAgo(dev.lastSeen || dev.createdAt)}`;
    info.appendChild(title);
    info.appendChild(sub);
    row.appendChild(info);

    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.textContent = 'Revoke';
    btn.setAttribute('data-action', 'revoke-safe-device');
    btn.dataset.deviceId = dev.id;
    btn.setAttribute('aria-label', 'Revoke safe browser ' + (dev.device || dev.ip || ''));
    row.appendChild(btn);

    list.appendChild(row);
  }
}
async function revokeTrustedBrowser(id) {
  if (!id) return;
  const ok = await confirmDialog({
    title: 'Revoke trusted browser?',
    message: 'This browser will be required to enter the PIN next time.',
    okText: 'Revoke',
    danger: true
  });
  if (!ok) return;
  const r = await api(`/api/auth/safe-devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (r && r.success) {
    toast('Trusted browser revoked', 'success');
    refreshTrustedBrowsers();
    refreshSessions();
  } else {
    toast((r && r.error) || 'Revoke failed', 'error');
  }
}
async function revokeOtherTrustedBrowsers() {
  const r = await api('/api/auth/safe-devices');
  if (!r || !Array.isArray(r.devices)) { toast('Could not list trusted browsers', 'error'); return; }
  const others = r.devices.filter(d => !d.current);
  if (!others.length) { toast('No other trusted browsers', 'info'); return; }
  const ok = await confirmDialog({
    title: 'Revoke other trusted browsers?',
    message: `Remove trust from ${others.length} other browser(s)? They will need to re-enter the PIN.`,
    okText: 'Revoke others',
    danger: true
  });
  if (!ok) return;
  const res = await api('/api/auth/safe-devices', { method: 'DELETE' });
  if (res && res.success) {
    toast(`Revoked ${res.revokedCount || others.length} trusted browser(s)`, 'success');
    refreshTrustedBrowsers();
    refreshSessions();
  } else {
    toast((res && res.error) || 'Revoke failed', 'error');
  }
}
async function approvePinChange() {
  setBtnBusy(document.getElementById('pin-save-btn'), true);
  try {
    const r = await api('/api/pin/approve', { method: 'POST' });
    if (r && r.success && r.token) {
      authToken = r.token;
      storeSessionToken(r.token);
      toast('PIN change approved and applied', 'success');
    } else if (r && r.success) {
      // Rotation applied server-side (all sessions wiped) but no fresh token
      // came back: the pre-rotation token is dead — never keep using it.
      authToken = '';
      storeSessionToken('');
      showPinScreen();
      toast('PIN change applied — sign in again', 'info');
    } else {
      toast((r && r.error) || 'Approve failed', 'error');
    }
  } catch {
    toast('Approve failed', 'error');
  }
  setBtnBusy(document.getElementById('pin-save-btn'), false);
  try { refreshSessions(); } catch {}
}
async function vetoPinChange() {
  const ok = await confirmDialog({ title: 'Revert PIN change?', message: 'The requester will be signed out immediately.', okText: 'Revert & kick', danger: true });
  if (!ok) return;
  const r = await api('/api/pin/veto', { method: 'POST' });
  if (r && r.success) toast('PIN change reverted, requester kicked', 'success');
  else toast((r && r.error) || 'Revert failed', 'error');
  try { refreshSessions(); } catch {}
}

// ── Persistent security alerts (unreviewed logins) ──
// A toast vanishes; the header triangle stays until the logins are reviewed.
function getPendingAlerts() {
  try {
    const v = JSON.parse(safeStorage.getItem('wt-security-alerts'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function setPendingAlerts(a) {
  try { safeStorage.setItem('wt-security-alerts', JSON.stringify(a.slice(-20))); } catch {}
}
function renderSecurityAlert() {
  const btn = document.getElementById('security-alert-btn');
  const count = document.getElementById('security-alert-count');
  if (!btn) return;
  const n = getPendingAlerts().length;
  btn.style.display = n ? '' : 'none';
  // The badge component hides itself when empty, so only the text is set —
  // the previous inline display juggling fought the shared rule (S-23).
  if (count) count.textContent = n > 1 ? String(n) : '';
  if (n) btn.setAttribute('aria-label', n === 1 ? 'Security alert: 1 unreviewed login' : `Security alert: ${n} unreviewed logins`);
  else btn.removeAttribute('aria-label');
}
function addSecurityAlert(ev) {
  const list = getPendingAlerts();
  list.push({ ip: ev.ip || '', device: ev.device || '', at: ev.at || Date.now() });
  setPendingAlerts(list);
  renderSecurityAlert();
}
// The review step: open Security, refresh the list, clear the triangle.
// Cleared AFTER the panel opens: clearing first lost the history when the
// open/refresh threw.
function openSecurityReview() {
  const panel = document.getElementById('settings-panel');
  try {
    if (!panel || !panel.classList.contains('open')) {
      if (typeof openSettings === 'function') openSettings();
      else return;
    }
    try { refreshSessions(); } catch {}
  // Expand the Security section even when collapsed, then scroll to it
    const sec = panel.querySelector('[data-sec="security"]');
    if (sec) {
      sec.classList.add('open');
      const h3 = sec.querySelector('h3');
      if (h3) h3.setAttribute('aria-expanded', 'true');
      try { safeStorage.setItem('wt-settings-sec-security', 'true'); } catch {}
      if (sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
    }
  } catch (e) { console.warn('openSecurityReview failed:', e); return; }
  setPendingAlerts([]);
  renderSecurityAlert();
}

let tunnelList = [];

async function restoreTunnels() {
  // Default the tunnel *target* input to a localhost URL. location.origin is
  // right on loopback (it also keeps auto-picked ports), but when the app
  // itself is reached through a tunnel/proxy URL that origin is NOT a valid
  // target — cloudflared must forward to the local server, not back at the
  // tunnel. Never overwrite a value the user already typed.
  try {
    const tu = document.getElementById('tunnel-url');
    if (tu && (!tu.value || /localhost:3000\b/.test(tu.value))) {
      const host = location.hostname || '';
      const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
      if (loopback) {
        tu.value = location.origin;
      } else {
        try { await refreshVersion(); } catch {}
        const port = (typeof webtunSelfPort === 'function' && webtunSelfPort()) || 3000;
        tu.value = `http://localhost:${port}`;
      }
    }
  } catch {}
  const r = await api('/api/tunnel').catch(() => null);
  if (!r) return;
  tunnelList = r.tunnels || [];
  renderTunnels();
}

function mkSvg(w, h, view, inner) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', w); s.setAttribute('height', h); s.setAttribute('viewBox', view);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.5');
  s.innerHTML = inner;
  return s;
}
function renderTunnels() {
  const list = document.getElementById('tunnel-list');
  if (!list) return;
  list.innerHTML = '';
  list.style.display = 'block';
  if (tunnelList.length === 0) {
    setListMessage(list, 'No tunnels yet. Enter a local URL above to create one.');
    return;
  }
  tunnelList.forEach(t => {
    const row = document.createElement('div');
    row.className = 'tunnel-row';
    const label = document.createElement('div');
    label.className = 'tunnel-label';
    label.textContent = t.localUrl;
    row.appendChild(label);
    const inner = document.createElement('div');
    inner.className = 'tunnel-inner';
    const urlSpan = document.createElement('span');
    urlSpan.className = 'tunnel-url';
    urlSpan.textContent = t.tunnelUrl;
    urlSpan.title = t.tunnelUrl;
    inner.appendChild(urlSpan);
    const status = document.createElement('span');
    status.className = 'tunnel-status';
    // `dead` = the watchdog gave up after its retries, so the tunnel will not
    // come back on its own — distinct from a transient "Orphan".
    const isDead = t.dead === true;
    status.style.background = isDead ? 'var(--red)' : (t.alive ? 'var(--green)' : 'var(--yellow)');
    status.style.color = 'var(--bg)';
    status.textContent = isDead ? 'Dead' : (t.alive ? 'Live' : 'Orphan');
    status.title = isDead
      ? `cloudflared stopped and did not come back after ${t.restartAttempts || 0} restart attempts — recreate the tunnel`
      : (t.alive ? 'cloudflared is running' : 'cloudflared process not found');
    inner.appendChild(status);
    if (t.alive && t.targetAlive !== undefined) {
      const targetStatus = document.createElement('span');
      const ok = t.targetAlive;
      targetStatus.className = 'tunnel-target';
      targetStatus.style.background = ok ? 'var(--green)' : 'var(--red)';
      targetStatus.style.color = 'var(--bg)';
      targetStatus.style.opacity = '0.8';
      targetStatus.appendChild(mkSvg('9','9','0 0 24 24', ok
        ? '<polyline points="20 6 9 17 4 12"/>'
        : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'));
      targetStatus.title = ok ? `Target ${t.localUrl} is responding` : `Target ${t.localUrl} is not responding`;
      inner.appendChild(targetStatus);
    }
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn tunnel-btn';
    copyBtn.title = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy tunnel URL');
    copyBtn.appendChild(mkSvg('12','12','0 0 24 24','<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'));
    copyBtn.addEventListener('click', () => copyText(t.tunnelUrl));
    inner.appendChild(copyBtn);
    const openBtn = document.createElement('button');
    openBtn.className = 'icon-btn tunnel-btn';
    openBtn.title = 'Open in new tab';
    openBtn.setAttribute('aria-label', 'Open tunnel in new tab');
    openBtn.appendChild(mkSvg('12','12','0 0 24 24','<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'));
    openBtn.addEventListener('click', () => window.open(t.tunnelUrl, '_blank', 'noopener,noreferrer'));
    inner.appendChild(openBtn);
    const stopBtn = document.createElement('button');
    stopBtn.className = 'icon-btn tunnel-btn stop';
    stopBtn.title = 'Stop';
    stopBtn.setAttribute('aria-label', 'Stop tunnel');
    stopBtn.appendChild(mkSvg('12','12','0 0 24 24','<rect x="6" y="6" width="12" height="12" rx="1"/>'));
    stopBtn.addEventListener('click', () => stopTunnelById(t.id));
    inner.appendChild(stopBtn);
    row.appendChild(inner);
    list.appendChild(row);
  });
}

async function createTunnel() {
  const btn = document.getElementById('tunnel-create-btn');
  if (btn && btn.dataset.busy === 'true') return;
  const url = document.getElementById('tunnel-url').value.trim();
  if (!url) { showFieldError('tunnel-field-error', 'Enter a local URL'); return; }
  clearFieldError('tunnel-field-error');
  setBtnBusy(btn, true);
  document.getElementById('tunnel-status').textContent = 'Creating tunnel…';
  // First tunnel use may trigger a one-time cloudflared download on the
  // server (503 + downloading:true). Poll within the 30s api() cap.
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await api('/api/tunnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!r.downloading || attempt >= 23) break;
    document.getElementById('tunnel-status').textContent =
      'Downloading cloudflared (one-time setup)… retrying (' + (attempt + 1) + '/24)';
    await new Promise(res => setTimeout(res, 5000));
  }
  setBtnBusy(btn, false);
  if (r.success) {
    tunnelList.push({ id: r.id, tunnelUrl: r.url, localUrl: url, alive: true, createdAt: Date.now() });
    renderTunnels();
    if (r.warning) {
      document.getElementById('tunnel-status').textContent = r.warning;
      toast(r.warning, 'warning');
    } else {
      document.getElementById('tunnel-status').textContent = '';
      toast('Tunnel ready: ' + r.url, 'success');
    }
  } else {
    document.getElementById('tunnel-status').textContent = '';
    showFieldError('tunnel-field-error', r.error || 'Failed to create tunnel');
  }
}

async function stopTunnelById(id) {
  document.getElementById('tunnel-status').textContent = 'Stopping tunnel…';
  const r = await api('/api/tunnel', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  if (r.success) {
    tunnelList = tunnelList.filter(t => t.id !== id);
    renderTunnels();
    // Re-sync from the server: an auto-restart renames the id (new public
    // URL), so the list may hold rows the server no longer knows and vice
    // versa. The failed-stop 404 path is gone (DELETE is idempotent now),
    // this just clears anything else stale.
    try { await restoreTunnels(); } catch {}
    document.getElementById('tunnel-status').textContent = '';
    toast(r.alreadyGone ? 'Tunnel entry removed' : 'Tunnel stopped', 'info');
  } else {
    document.getElementById('tunnel-status').textContent = '';
    toast(r.error || 'Failed to stop tunnel', 'error');
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    toast('Copied', 'success');
  }).catch(() => {
    toast('Copy failed', 'error');
  });
}
// ── License (Pro / Team commercial keys) ──
async function refreshLicense() {
  const planEl = document.getElementById('lic-plan');
  const statusEl = document.getElementById('lic-status');
  if (!planEl || !statusEl) return;
  let r;
  try { r = await api('/api/license/status'); } catch { return; }
  if (!r || r.error) { statusEl.textContent = 'License status unavailable.'; return; }
  const plan = r.plan || 'free';
  const exp = r.expiry ? new Date(r.expiry).toLocaleDateString() : '';
  statusEl.style.color = '';
  planEl.textContent = plan === 'free' ? '— Free' : '— ' + plan.charAt(0).toUpperCase() + plan.slice(1);
  if (!r.enforce) {
    statusEl.textContent = plan === 'free'
      ? 'Free plan — community use.'
      : 'Active (' + plan + (exp ? ', renews ' + exp : '') + ').';
  } else if (plan === 'free') {
    statusEl.textContent = r.expired
      ? 'Expired — Free limits apply (2 tunnels, 3 devices). Renew to lift them.'
      : 'Free plan — 2 tunnels, 3 devices, 200 history. Pro allows unlimited tunnels, 5 devices and 1,000 history.';
  } else if (r.grace) {
    statusEl.textContent = 'Active (' + plan + ') — grace until ' + new Date(r.expiry + 7 * 86400000).toLocaleDateString() + '. Renew soon.';
    try { statusEl.style.color = 'var(--amber, #e5a50a)'; } catch {}
  } else {
    try { statusEl.style.color = ''; } catch {}
    statusEl.textContent = 'Active (' + plan + (exp ? ', renews ' + exp : '') + ').';
  }
  refreshRenewals();
  try { loadRuntimePolicy(); } catch {}
  try { refreshAuditLog(); } catch {}
}
async function saveLicenseKey() {
  const input = document.getElementById('lic-key');
  const btn = document.getElementById('lic-save-btn');
  const key = input ? input.value.trim() : '';
  if (!key) { showFieldError('lic-field-error', 'Paste a license key first'); return; }
  try { if (typeof setBtnBusy === 'function') setBtnBusy(btn, true); } catch {}
  const r = await api('/api/license', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  try { if (typeof setBtnBusy === 'function') setBtnBusy(btn, false); } catch {}
  if (r && !r.error) {
    clearFieldError('lic-field-error');
    if (input) input.value = '';
    toast('License activated (' + (r.plan || 'paid') + ')', 'success');
    refreshLicense();
  } else {
    showFieldError('lic-field-error', (r && r.error) || 'Invalid key');
  }
}
async function removeLicenseKey() {
  let ok = true;
  try {
    if (typeof confirmDialog === 'function') {
      ok = await confirmDialog({ title: 'Remove license?', message: 'This server returns to Free limits (2 tunnels, 3 devices). Continue?', okText: 'Remove license', danger: true });
    }
  } catch { ok = true; }
  if (!ok) return;
  const r = await api('/api/license', { method: 'DELETE' });
  if (r && !r.error) { toast('License removed — Free plan', 'info'); refreshLicense(); }
  else toast((r && r.error) || 'Failed to remove license', 'error');
}
async function startCheckout(plan) {
  plan = plan || document.getElementById('billing-plan').value;
  const annual = document.getElementById('billing-term').value === 'yearly';
  const seats = plan === 'team' ? Number(document.getElementById('billing-seats').value) : 1;
  if (!Number.isInteger(seats) || seats < (plan === 'team' ? 3 : 1) || seats > 10) { showFieldError('billing-error', 'Choose 3–10 Team seats'); return; }
  const button = document.getElementById('billing-checkout-btn');
  if (button.disabled) return;
  clearFieldError('billing-error'); setBtnBusy(button, true);
  const checkoutWindow = window.open('about:blank', '_blank');
  if (checkoutWindow) checkoutWindow.opener = null;
  try {
    const r = await api('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, annual, seats }) });
    if (!r?.url) { checkoutWindow?.close(); showFieldError('billing-error', r?.error || 'Checkout unavailable — try again'); return; }
    if (checkoutWindow && !checkoutWindow.closed) checkoutWindow.location.href = r.url;
    else { const link = document.getElementById('billing-checkout-link'); link.href = r.url; link.hidden = false; }
  } finally { setBtnBusy(button, false); }
}
function syncBillingSeats() { document.getElementById('billing-seats-row').hidden = document.getElementById('billing-plan').value !== 'team'; }
let renewalRequest = 0;
async function refreshRenewals() {
  const request = ++renewalRequest, box = document.getElementById('billing-renewals');
  if (!box || !window._appUnlocked) return;
  const r = await api('/api/billing/renewals');
  if (request !== renewalRequest || !window._appUnlocked) return;
  box.textContent = r?.error || (!r?.renewals?.length ? 'No unclaimed paid renewals.' : '');
  for (const renewal of (r?.renewals || []).slice(0, 50)) {
    const row = document.createElement('div'); row.className = 'billing-renewal';
    const label = document.createElement('span');
    label.textContent = `${renewal.plan} · ${renewal.seats} seat${renewal.seats === 1 ? '' : 's'} · expires ${new Date(renewal.expiry).toLocaleDateString()}`;
    const button = document.createElement('button'); button.className = 'btn btn-ghost'; button.textContent = 'Activate';
    button.dataset.action = 'claim-renewal'; button.dataset.renewalId = renewal.id;
    row.append(label, button); box.appendChild(row);
  }
}
async function claimRenewal(button) {
  setBtnBusy(button, true); clearFieldError('billing-error');
  try {
    const r = await api('/api/billing/renewals/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: button.dataset.renewalId }) });
    if (r?.error) { showFieldError('billing-error', r.error); return; }
    toast('Renewal activated', 'success'); await refreshLicense();
  } finally { setBtnBusy(button, false); }
}

async function openBillingPortal() {
  const btn = document.getElementById('billing-portal-btn');
  if (btn && btn.disabled) return;
  clearFieldError('billing-error');
  if (btn) setBtnBusy(btn, true);
  try {
    const r = await api('/api/billing/portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (!r || !r.url) {
      showFieldError('billing-error', (r && r.error) || 'Billing portal unavailable');
      return;
    }
    const win = window.open(r.url, '_blank', 'noopener,noreferrer');
    if (!win) {
      const link = document.getElementById('billing-checkout-link');
      if (link) { link.href = r.url; link.textContent = 'Open billing portal'; link.hidden = false; }
    }
  } finally {
    if (btn) setBtnBusy(btn, false);
  }
}

// ── Runtime Access Policy ──
async function loadRuntimePolicy() {
  if (!window._appUnlocked) return;
  const originsEl = document.getElementById('policy-allowed-origins');
  const portsEl = document.getElementById('policy-preview-ports');
  if (!originsEl && !portsEl) return;
  try {
    const r = await api('/api/policy');
    if (!r || r.error) return;
    if (originsEl && r.allowedOrigins !== undefined) {
      originsEl.value = Array.isArray(r.allowedOrigins) ? r.allowedOrigins.join(', ') : String(r.allowedOrigins || '');
    }
    if (portsEl && r.previewPorts !== undefined) {
      portsEl.value = Array.isArray(r.previewPorts) ? r.previewPorts.join(', ') : String(r.previewPorts || '');
    }
  } catch {}
}

async function saveRuntimePolicy() {
  const originsEl = document.getElementById('policy-allowed-origins');
  const portsEl = document.getElementById('policy-preview-ports');
  const btn = document.getElementById('policy-save-btn');
  const allowedOrigins = originsEl ? originsEl.value : '';
  const previewPorts = portsEl ? portsEl.value : '';
  if (btn) setBtnBusy(btn, true);
  try {
    const r = await api('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedOrigins, previewPorts })
    });
    if (r && r.success) {
      if (originsEl && r.allowedOrigins !== undefined) {
        originsEl.value = Array.isArray(r.allowedOrigins) ? r.allowedOrigins.join(', ') : String(r.allowedOrigins || '');
      }
      if (portsEl && r.previewPorts !== undefined) {
        portsEl.value = Array.isArray(r.previewPorts) ? r.previewPorts.join(', ') : String(r.previewPorts || '');
      }
      toast('Runtime access policy saved', 'success');
    } else {
      toast((r && r.error) || 'Failed to save policy', 'error');
    }
  } finally {
    if (btn) setBtnBusy(btn, false);
  }
}

// ── Security Audit Log ──
let _auditEntriesCache = [];

async function refreshAuditLog() {
  const list = document.getElementById('audit-log-list');
  if (!list || !window._appUnlocked) return;
  try {
    const r = await api('/api/audit?limit=200');
    if (!r || !Array.isArray(r.entries)) {
      setListMessage(list, (r && r.error) || 'Audit log unavailable.');
      return;
    }
    _auditEntriesCache = r.entries;
    renderAuditLog();
  } catch {
    setListMessage(list, 'Could not load audit log.');
  }
}

function filterAuditLog() {
  renderAuditLog();
}

function renderAuditLog() {
  const list = document.getElementById('audit-log-list');
  if (!list) return;
  const q = (document.getElementById('audit-filter-input')?.value || '').trim().toLowerCase();
  const entries = q
    ? _auditEntriesCache.filter(e =>
        String(e.action || '').toLowerCase().includes(q) ||
        String(e.ip || '').toLowerCase().includes(q) ||
        String(e.device || e.actor || '').toLowerCase().includes(q) ||
        String(e.detail || '').toLowerCase().includes(q)
      )
    : _auditEntriesCache;

  list.innerHTML = '';
  if (!entries.length) {
    setListMessage(list, q ? 'No matching audit events.' : 'No audit events recorded yet.');
    return;
  }
  for (const ev of entries.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'settings-session';
    row.style.cssText = 'padding:5px 8px;font-size:11px';
    const info = document.createElement('div');
    info.className = 'settings-session-info';
    const title = document.createElement('div');
    title.className = 'settings-session-title';
    title.style.fontFamily = 'var(--font)';
    const detailStr = typeof ev.detail === 'object' && ev.detail !== null ? JSON.stringify(ev.detail) : (ev.detail || '');
    title.textContent = `${ev.action || 'event'}${detailStr ? ' — ' + detailStr : ''}`;
    const sub = document.createElement('div');
    sub.className = 'settings-session-meta';
    const ts = ev.at ? new Date(ev.at).toLocaleString() : '';
    const dev = ev.device || ev.actor || '';
    sub.textContent = `${ev.ip || 'local'}${dev ? ' · ' + dev : ''}${ts ? ' · ' + ts : ''}`;
    info.appendChild(title);
    info.appendChild(sub);
    row.appendChild(info);
    list.appendChild(row);
  }
}

function exportAuditLog(format) {
  const fmt = format === 'csv' ? 'csv' : 'json';
  const a = document.createElement('a');
  a.href = `/api/audit/export?format=${fmt}&token=${encodeURIComponent(authToken)}`;
  a.download = `webtun-audit.${fmt}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function clearAuditLog() {
  const ok = await confirmDialog({
    title: 'Clear Audit Log?',
    message: 'Remove all recorded security audit events from disk?',
    okText: 'Clear Log',
    danger: true
  });
  if (!ok) return;
  const r = await api('/api/audit', { method: 'DELETE' });
  if (r && r.success) {
    _auditEntriesCache = [];
    renderAuditLog();
    toast('Audit log cleared', 'info');
  } else {
    toast((r && r.error) || 'Failed to clear audit log', 'error');
  }
}

// Declarative controls owned by this feature.
uiActions.register("click", {
  "open-security-review": function (event) { return openSecurityReview(); },
  "change-pin": function (event) { return changePin(); },
  "refresh-license": function (event) { return refreshLicense(); },
  "save-license-key": function (event) { return saveLicenseKey(); },
  "remove-license-key": function (event) { return removeLicenseKey(); },
  "start-checkout-pro": function (event) { return startCheckout('pro'); },
  "start-checkout": function () { return startCheckout(); },
  "open-billing-portal": function () { return openBillingPortal(); },
  "refresh-renewals": function () { return refreshRenewals(); },
  "claim-renewal": function () { return claimRenewal(this); },
  "save-runtime-policy": function () { return saveRuntimePolicy(); },
  "load-runtime-policy": function () { return loadRuntimePolicy(); },
  "refresh-audit-log": function () { return refreshAuditLog(); },
  "export-audit-json": function () { return exportAuditLog('json'); },
  "export-audit-csv": function () { return exportAuditLog('csv'); },
  "clear-audit-log": function () { return clearAuditLog(); },
  "refresh-sessions": function (event) { return refreshSessions(); },
  "revoke-other-sessions": function (event) { return revokeOtherSessions(); },
  "refresh-trusted-browsers": function () { return refreshTrustedBrowsers(); },
  "revoke-other-safe-devices": function () { return revokeOtherTrustedBrowsers(); },
  "revoke-safe-device": function () { return revokeTrustedBrowser(this.dataset.deviceId); },
  "create-tunnel": function (event) { return createTunnel(); },
  "copy-text-ssh-once-cmd": function (event) { return copyText(document.getElementById('ssh-once-cmd').textContent); },
});
uiActions.register("keydown", {
  "create-tunnel": function (event) { if(event.key==='Enter'){event.preventDefault();return createTunnel();} },
  "copy-text-ssh-once-cmd": function (event) { if(event.key==='Enter'||event.key===' '){event.preventDefault();copyText(document.getElementById('ssh-once-cmd').textContent)}; },
});
uiActions.register("input", {
  "filter-audit-log": function () { return filterAuditLog(); },
});
uiActions.register('change', { 'sync-billing-seats': function () { return syncBillingSeats(); } });


// WebTun frontend - ssh.js (on-demand SSH credentials for external clients.)
//
// Flow: Settings → SSH Access → label + Generate → server creates an ed25519
// pair, installs the public half for the server user, and returns the private
// half ONCE. The UI shows it in #ssh-once until dismissed — it is never
// stored in localStorage and never re-displayed. Termius/mobile recipe below.

let _sshStatus = null;
let _sshKeys = [];

// Feature flag: Settings → Features → SSH Access. The header button is always
// visible, but every control in the popup stays locked until this is on —
// client-side AND server-side (another device may have flipped it).
let _sshServerEnabled = null; // null = unknown yet, honoured once status arrives

function sshClientEnabled() {
  try { return typeof settings !== 'undefined' && settings.sshEnabled === true; } catch { return false; }
}

function sshEnabled() {
  if (!sshClientEnabled()) return false;
  if (_sshServerEnabled === false) return false;
  return true;
}

function applySshGate() {
  const on = sshEnabled();
  const gate = document.getElementById('ssh-gate');
  const body = document.getElementById('ssh-body');
  const refreshBtn = document.getElementById('ssh-refresh-btn');
  if (gate) gate.style.display = on ? 'none' : '';
  if (body) body.style.display = on ? '' : 'none';
  if (refreshBtn) refreshBtn.style.display = on ? '' : 'none';
  return on;
}

function openSshPanel() {
  try { hideTabMenus(); } catch {}
  try { applySshEnabled(); } catch {}
  applySshGate();
  openOverlay('ssh-overlay');
  if (sshClientEnabled()) { try { refreshSshStatus(); } catch {} }
}

// Push the Features toggle to the server so OFF is enforced there too (and
// performs the teardown). Reverts the toggle if the server refuses.
async function syncSshEnabledToServer() {
  const on = sshClientEnabled();
  const r = await api('/api/ssh/enabled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on }),
  }).catch(() => null);
  if (!r || r.error) {
    try {
      settings.sshEnabled = !on;
      saveSettings();
      syncToggle('sshEnabled');
      applySshEnabled();
    } catch {}
    toast('Could not update SSH on the server: ' + ((r && r.error) || 'network error'), 'error');
    return;
  }
  if (Array.isArray(r.notes) && r.notes.length && !on) {
    toast('SSH off — ' + r.notes.join('; '), 'info');
  } else {
    toast(on ? 'SSH enabled' : 'SSH disabled', on ? 'success' : 'info');
  }
  try { await refreshSshStatus(); } catch {}
}

function closeSshPanel() {
  try { dismissSshOnce(); } catch {}
  closeOverlay('ssh-overlay');
}

function openSshSettings() {
  closeOverlay('ssh-overlay');
  setTimeout(() => { try { openSettings(); } catch {} }, 60);
}

function requireSshEnabled() {
  if (sshEnabled()) return true;
  toast('Enable SSH in Settings → Features first', 'warning');
  return false;
}

function sshEffectivePort(s) {
  if (s && Number.isInteger(s.effectivePort)) return s.effectivePort;
  if (s && Number.isInteger(s.port)) return s.port;
  return 2222;
}

function sshAnyListening(s) {
  try { return Object.values(s.listening || {}).some(Boolean); } catch { return false; }
}

async function refreshSshStatus() {
  const statusEl = document.getElementById('ssh-status');
  try {
    const r = await api('/api/ssh/status');
    if (!r || r.error) {
      if (statusEl) statusEl.textContent = (r && r.error) || 'Could not load SSH status';
      return;
    }
    _sshStatus = r;
    // Another device may have flipped the master switch — the gate follows
    // the server value once known (client flag alone is not enough).
    if (typeof r.enabled === 'boolean') _sshServerEnabled = r.enabled;
    applySshGate();
    renderSshStatus(r);
    await refreshSshKeys();
    try { await refreshSshSetup(); } catch {}
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Could not load SSH status';
  }
}

// ── Easy Setup wizard ────────────────────────────────────────────────────
// One tap per row: the app runs the fix itself (non-interactive sudo only —
// it never asks for a password) and reports back. Anything it cannot do is
// shown as a copyable command instead of a dead button.

const SSH_CHECK_LABELS = {
  'sshd-binary': 'SSH server',
  'sshd-listening': 'Listening',
  'pubkey-auth': 'Key auth',
  'firewall': 'Firewall',
  'tailscale': 'Tailscale',
  'managed-sshd': 'Built-in SSH',
  'key': 'Credential',
};

let _sshSetupBusy = false;

async function refreshSshSetup() {
  const list = document.getElementById('ssh-setup-list');
  if (!list) return;
  const r = await api('/api/ssh/setup').catch(() => null);
  if (!r || r.error || !Array.isArray(r.checks)) {
    list.innerHTML = '';
    return;
  }
  renderSshSetupResult(r.lastAction);
  list.innerHTML = '';
  r.checks.forEach(c => list.appendChild(sshSetupRow(c)));
  // The auth-key row belongs to the tailscale step: show it only while that
  // step offers a tailscale-up fix (installed, not logged in).
  const tsRow = document.getElementById('ssh-tskey-row');
  if (tsRow) {
    const ts = r.checks.find(x => x.id === 'tailscale');
    tsRow.style.display = (ts && ts.fix === 'tailscale-up') ? 'flex' : 'none';
  }
}

function sshSetupRow(c) {
  const row = document.createElement('div');
  row.className = 'ssh-check';

  const dot = document.createElement('span');
  const good = c.ok === true && !c.warn;
  dot.className = 'ssh-pill ' + (good ? 'ok' : (c.warn ? 'warn' : 'bad'));
  dot.textContent = good ? 'OK' : (c.warn ? '?' : '!');
  dot.title = c.detail || '';
  row.appendChild(dot);

  const body = document.createElement('div');
  body.className = 'ssh-check-body';

  const label = document.createElement('div');
  label.className = 'ssh-check-name';
  label.textContent = SSH_CHECK_LABELS[c.id] || c.id;
  label.title = c.detail || '';
  body.appendChild(label);

  const meta = document.createElement('div');
  meta.className = 'ssh-check-detail';
  meta.textContent = c.detail || '';
  body.appendChild(meta);

  if (!good && c.manual) {
    const m = document.createElement('span');
    m.className = 'ssh-manual';
    m.textContent = c.manual;
    m.title = 'Run this yourself — click to copy';
    m.setAttribute('role', 'button');
    m.setAttribute('tabindex', '0');
    const copyManual = () => copyText(c.manual);
    m.addEventListener('click', copyManual);
    m.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyManual(); }
    });
    body.appendChild(m);
  }
  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'ssh-check-actions';

  // Per-row actions.
  if (c.id === 'tailscale' && c.canDown) {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost';
    b.textContent = 'Disconnect';
    b.title = 'Leave the Tailnet (only shown because WebTun brought it up)';
    b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Disconnect Tailscale?', message: 'This host leaves your Tailnet — phone access over Tailscale stops until you reconnect.', okText: 'Disconnect', danger: true });
      if (ok) runSshSetupAction('tailscale-down');
    });
    actions.appendChild(b);
  }
  if (c.id === 'managed-sshd' && c.managed) {
    const live = !!(c.managed.listening || c.managed.alive);
    const b = document.createElement('button');
    b.className = live ? 'btn btn-ghost' : 'btn btn-primary';
    b.textContent = live ? 'Stop' : 'Start';
    b.title = live ? 'Stop the built-in SSH server' : 'Start a built-in SSH server (no root needed)';
    b.addEventListener('click', () => runSshSetupAction(live ? 'stop-managed' : 'start-managed', {
      confirm: live ? null : { title: 'Start built-in SSH?', message: 'Runs an SSH server as this user (key-only, no system changes). Reachable wherever this host is reachable.' },
    }));
    actions.appendChild(b);
  } else if (c.fix) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = c.id === 'tailscale' ? 'Connect' : 'Fix it';
    b.title = 'Run the fix automatically';
    b.addEventListener('click', () => runSshSetupAction(c.fix, {
      confirm: {
        title: c.fix === 'install-sshd' ? 'Install OpenSSH server?'
          : c.fix === 'enable-sshd' ? 'Enable the SSH service?'
          : c.fix === 'open-firewall' ? 'Open the SSH port in the firewall?'
          : c.fix === 'install-tailscale' ? 'Install Tailscale?'
          : 'Connect Tailscale?',
        message: c.fix === 'tailscale-up'
          ? 'Brings this host onto your Tailnet. If a browser login is needed, the sign-in link appears below — one tap, once.'
          : 'Runs the system command for you (uses passwordless sudo when available; otherwise it prints the exact command to run).',
      },
    }));
    actions.appendChild(b);
  }
  row.appendChild(actions);
  return row;
}

function renderSshSetupResult(last) {
  const box = document.getElementById('ssh-setup-result');
  if (!box) return;
  if (!last || !last.done) { box.style.display = 'none'; box.textContent = ''; return; }
  box.style.display = '';
  const out = String(last.output || '');
  // A Tailscale device-login URL is the one interactive moment: make it a
  // real tappable link instead of buried text.
  const url = out.match(/https:\/\/login\.tailscale\.com\/\S+/);
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ssh-note-head ' + (last.ok ? 'ok' : 'attn');
  head.textContent = last.ok ? 'Done.' : 'Needs a hand.';
  box.appendChild(head);
  if (url) {
    const a = document.createElement('a');
    a.href = url[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Tap to sign Tailscale in →';
    box.appendChild(a);
  }
  const rest = document.createElement('div');
  rest.textContent = url ? out.replace(url[0], '').trim() : out;
  if (rest.textContent) box.appendChild(rest);
}

async function runSshSetupAction(action, opts = {}) {
  if (!requireSshEnabled()) return;
  if (_sshSetupBusy) return;
  if (opts.confirm) {
    const ok = await confirmDialog({ title: opts.confirm.title, message: opts.confirm.message, okText: 'Run it' });
    if (!ok) return;
  }
  _sshSetupBusy = true;
  try {
    const r = await api('/api/ssh/setup/' + encodeURIComponent(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: sshEffectivePort(_sshStatus) }),
    });
    if (!r || r.error) {
      renderSshSetupResult({ done: true, ok: false, output: (r && r.error) || 'Action failed' });
      return;
    }
    if (r.started) {
      // Slow job (package install / download): poll the checklist until it
      // reports done. Bounded: 3 polls over ~15s, then leave the result box
      // to the next manual refresh.
      toast('Working on it — watch this space…', 'info');
      for (let i = 0; i < 3; i++) {
        await new Promise(res => setTimeout(res, 5000));
        await refreshSshStatus().catch(() => {});
        try {
          const s = await api('/api/ssh/setup').catch(() => null);
          if (s && s.lastAction && s.lastAction.done && s.lastAction.action === action) break;
        } catch {}
      }
    } else {
      renderSshSetupResult({ done: true, ok: r.ok !== false, output: r.output || 'Done.' });
      toast(r.ok === false ? 'Setup step needs attention' : 'Setup step done', r.ok === false ? 'warning' : 'success');
    }
    try { await refreshSshStatus(); } catch {}
  } finally {
    _sshSetupBusy = false;
  }
}

async function tailscaleUpWithKey() {
  if (!requireSshEnabled()) return;
  const input = document.getElementById('ssh-tskey');
  const btn = document.getElementById('ssh-tskey-btn');
  const key = input ? input.value.trim() : '';
  if (!key) {
    // No key pasted = interactive path (login URL appears in the result box).
    return runSshSetupAction('tailscale-up', { confirm: { title: 'Connect Tailscale?', message: 'If a browser login is needed, the sign-in link appears below.' } });
  }
  if (btn && btn.dataset.busy === 'true') return;
  setBtnBusy(btn, true);
  try {
    const r = await api('/api/ssh/setup/tailscale-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: key }),
    });
    // The key is one-time: wipe the field whatever happened.
    if (input) input.value = '';
    if (!r || r.error) {
      renderSshSetupResult({ done: true, ok: false, output: (r && r.error) || 'Connect failed' });
      return;
    }
    if (r.started) { toast('Connecting Tailscale…', 'info'); }
    else {
      renderSshSetupResult({ done: true, ok: r.ok !== false, output: r.output || 'Done.' });
      toast('Tailscale connected', 'success');
    }
    try { await refreshSshStatus(); } catch {}
  } finally {
    setBtnBusy(btn, false);
  }
}

function sshStat(k, v) {
  const cell = document.createElement('div');
  cell.className = 'ssh-stat';
  const kk = document.createElement('div');
  kk.className = 'ssh-stat-k';
  kk.textContent = k;
  const vv = document.createElement('div');
  vv.className = 'ssh-stat-v';
  vv.textContent = v;
  vv.title = v;
  cell.appendChild(kk);
  cell.appendChild(vv);
  return cell;
}

function renderSshStatus(s) {
  const statusEl = document.getElementById('ssh-status');
  const hintEl = document.getElementById('ssh-setup-hint');
  const recipeEl = document.getElementById('ssh-recipe');
  const noteEl = document.getElementById('ssh-unmanaged-note');
  const genBtn = document.getElementById('ssh-generate-btn');
  const labelEl = document.getElementById('ssh-label');
  const portEl = document.getElementById('ssh-port');

  // Key management needs ssh-keygen on a POSIX host. Without it the Generate
  // path only ever ends in a 501 — disable it upfront with the reason inline.
  const managed = s.managed !== false;
  if (genBtn) {
    genBtn.disabled = !managed;
    genBtn.title = managed ? '' : 'Key generation needs ssh-keygen on Linux/macOS — follow the manual steps below';
  }
  if (labelEl) labelEl.disabled = !managed;
  if (noteEl) {
    if (!managed) {
      noteEl.style.display = '';
      noteEl.textContent = 'Automatic key setup is unavailable on this host (Windows or ssh-keygen missing). Add your existing public key to authorized_keys manually, then use the connection details below.';
    } else {
      noteEl.style.display = 'none';
      noteEl.textContent = '';
    }
  }
  if (portEl && document.activeElement !== portEl && Number.isInteger(s.port)) {
    portEl.value = String(s.port);
  }

  if (statusEl) {
    statusEl.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'ssh-stats';
    grid.appendChild(sshStat('User', s.user || '—'));
    grid.appendChild(sshStat('Port', String(sshEffectivePort(s))));
    grid.appendChild(sshStat('Keys', s.keyCount > 0 ? `${s.keyCount}/${s.maxKeys}` : 'none'));
    statusEl.appendChild(grid);
    const listenRow = document.createElement('div');
    listenRow.className = 'ssh-listen-row';
    const entries = Object.entries(s.listening || {});
    const live = entries.filter(([, v]) => v);
    if (live.length) {
      listenRow.appendChild(document.createTextNode('Listening on '));
      entries.forEach(([p, v]) => {
        const pill = document.createElement('span');
        pill.className = 'ssh-pill ' + (v ? 'ok' : 'dim');
        pill.textContent = ':' + p;
        pill.title = v ? `sshd answering on port ${p}` : `nothing on port ${p}`;
        listenRow.appendChild(pill);
      });
    } else {
      listenRow.appendChild(document.createTextNode('Not listening yet — '));
      const pill = document.createElement('span');
      pill.className = 'ssh-pill bad';
      pill.textContent = 'sshd not detected';
      pill.title = 'See the setup steps below';
      listenRow.appendChild(pill);
    }
    statusEl.appendChild(listenRow);
  }
  if (hintEl) {
    const needsSetup = !sshAnyListening(s);
    hintEl.style.display = needsSetup ? '' : 'none';
    const pre = document.getElementById('ssh-setup-cmds');
    if (pre && needsSetup) pre.textContent = s.setupHint || '';
  }
  renderSshOrphans(s);
  if (recipeEl) renderSshRecipe(recipeEl, s);
}

function renderSshOrphans(s) {
  const box = document.getElementById('ssh-orphans');
  const btn = document.getElementById('ssh-cleanup-btn');
  if (!box || !btn) return;
  const n = Number(s.orphaned || 0);
  if (n > 0 && s.managed !== false) {
    box.style.display = '';
    btn.textContent = `Remove ${n} orphaned key ${n === 1 ? 'entry' : 'entries'} (untracked — safe to clean)`;
  } else {
    box.style.display = 'none';
  }
}

async function cleanupSshOrphans() {
  if (!requireSshEnabled()) return;
  const n = _sshStatus ? Number(_sshStatus.orphaned || 0) : 0;
  const ok = await confirmDialog({
    title: 'Remove orphaned keys?',
    message: `${n} authorized_keys ${n === 1 ? 'entry' : 'entries'} created by WebTun ${n === 1 ? 'has' : 'have'} no matching record (state was lost). They will stop working immediately. Your other keys are untouched.`,
    okText: 'Remove',
    danger: true,
  });
  if (!ok) return;
  const r = await api('/api/ssh/cleanup', { method: 'POST' });
  if (r && r.error) { toast(r.error, 'error'); return; }
  toast(`Removed ${r.removedLines || 0} orphaned ${r.removedLines === 1 ? 'line' : 'lines'}`, 'success');
  try { await refreshSshStatus(); } catch {}
}

function sshHostChoices(s) {
  const seen = new Set();
  const hosts = [];
  const push = (label, value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    hosts.push({ label, value });
  };
  if (s.tailscaleIp) push('Tailscale', s.tailscaleIp);
  // lanIps entries are { ip, iface } (new) or plain strings (older server) —
  // the interface name tells same-Wi-Fi users which address is their real LAN.
  (s.lanIps || []).forEach(entry => {
    const ip = typeof entry === 'string' ? entry : (entry && entry.ip);
    const iface = entry && typeof entry === 'object' && entry.iface ? ` (${entry.iface})` : '';
    if (ip) push('LAN' + iface, ip);
  });
  // Last resort, and a classic trap: 127.0.0.1 only ever reaches sshd from
  // the server itself. Label it honestly so nobody pastes it into Termius.
  push('Server itself only — never from your phone', '127.0.0.1');
  return hosts;
}

function sshCommand(user, port, host) {
  return `ssh -i ~/.ssh/webtun-key -p ${port} ${user}@${host}`;
}

function makeCopyRow(text, caption) {
  const cmd = document.createElement('div');
  cmd.className = 'ssh-cmd';
  if (caption) cmd.title = caption + ' — click to copy';
  else cmd.title = 'Click to copy';
  const tag = document.createElement('span');
  tag.className = 'ssh-pill dim';
  tag.textContent = caption || 'ssh';
  const code = document.createElement('code');
  code.textContent = text;
  cmd.appendChild(tag);
  cmd.appendChild(code);
  cmd.setAttribute('role', 'button');
  cmd.setAttribute('tabindex', '0');
  cmd.addEventListener('click', () => copyText(text));
  cmd.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyText(text); }
  });
  return cmd;
}

function renderSshRecipe(el, s) {
  el.innerHTML = '';
  const hosts = sshHostChoices(s);
  const user = s.user || 'user';
  const port = sshEffectivePort(s);

  const title = document.createElement('div');
  title.className = 'ssh-hint';
  title.textContent = 'Connect with any SSH client (key login — no password). Tap a command to copy it:';
  el.appendChild(title);

  // One command per reachable address — the phone on Tailscale and the laptop
  // on LAN need different hostnames, and guessing wrong looks like breakage.
  hosts.forEach(h => {
    const row = makeCopyRow(sshCommand(user, port, h.value), h.label);
    el.appendChild(row);
  });

  // Timeout is the #1 phone failure: LAN rows only work on the same Wi-Fi,
  // and 127.0.0.1 never works remotely. Say so outright when there is no
  // Tailnet address to offer.
  if (!s.tailscaleIp) {
    const reach = document.createElement('div');
    reach.className = 'ssh-warnline';
    reach.textContent = 'Phone on mobile data (not home Wi-Fi)? These addresses will time out. ' +
      'Install Tailscale on this server + your phone (same account) and use the Tailnet IP — ' +
      'or connect to this server\u2019s public IP with the firewall port open.';
    el.appendChild(reach);
  }

  const primary = hosts[0] ? hosts[0].value : 'server-ip';
  const termius = document.createElement('div');
  termius.className = 'ssh-hint';
  termius.innerHTML =
    '<b>Termius (mobile):</b> Hosts → + → New Host → ' +
    `Hostname <b>${escapeHtml(primary)}</b>, Port <b>${port}</b>, Username <b>${escapeHtml(user)}</b> → ` +
    'Keychain → + → New Key → paste the private key shown once after Generate → select it under SSH Key. ' +
    'Never use 127.0.0.1 as the hostname — that address is the server talking to itself. ' +
    'On first connect, verify the host fingerprint shown below.';
  el.appendChild(termius);

  if (s.hostFingerprints && s.hostFingerprints.length) {
    const fp = document.createElement('div');
    fp.className = 'ssh-fp';
    fp.textContent = 'Host fingerprints: ' +
      s.hostFingerprints.map(h => `${h.type} ${h.fingerprint}`).join('   ');
    el.appendChild(fp);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function refreshSshKeys() {
  const r = await api('/api/ssh/keys').catch(() => null);
  _sshKeys = (r && r.keys) || [];
  renderSshKeys();
}

function renderSshKeys() {
  const list = document.getElementById('ssh-keys-list');
  const empty = document.getElementById('ssh-keys-empty');
  if (!list) return;
  list.innerHTML = '';
  const showEmpty = _sshKeys.length === 0 && (!_sshStatus || _sshStatus.managed !== false);
  if (empty) empty.style.display = showEmpty ? '' : 'none';
  if (_sshKeys.length === 0) {
    list.style.display = 'none';
    return;
  }
  list.style.display = '';
  _sshKeys.forEach(k => {
    const row = document.createElement('div');
    row.className = 'ssh-key';

    const body = document.createElement('div');
    body.className = 'ssh-check-body';

    const label = document.createElement('div');
    label.className = 'ssh-check-name';
    label.textContent = k.label || k.id;
    label.title = `${k.type || ''}  ${k.fingerprint || ''}`;
    body.appendChild(label);

    const meta = document.createElement('div');
    meta.className = 'ssh-check-detail';
    let when = '';
    try { when = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : ''; } catch {}
    meta.textContent = [k.fingerprint || '', when].filter(Boolean).join('  •  ');
    meta.title = `Added ${k.createdAt ? new Date(k.createdAt).toLocaleString() : 'unknown'}${k.addedBy ? ' by ' + k.addedBy : ''}`;
    body.appendChild(meta);
    row.appendChild(body);

    const del = document.createElement('button');
    del.className = 'icon-btn ssh-ico danger';
    del.title = 'Revoke this key';
    del.setAttribute('aria-label', `Revoke SSH key ${k.label || k.id}`);
    del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    del.addEventListener('click', () => revokeSshKey(k.id, k.label, k.fingerprint, k.createdAt));
    row.appendChild(del);

    list.appendChild(row);
  });
}

async function generateSshCredential() {
  if (!requireSshEnabled()) return;
  const btn = document.getElementById('ssh-generate-btn');
  if (!btn || btn.dataset.busy === 'true' || btn.disabled) return;
  const labelEl = document.getElementById('ssh-label');
  const label = labelEl ? labelEl.value.trim() : '';
  if (!label) { showFieldError('ssh-field-error', 'Give the key a label (e.g. "Termius on iPhone")'); return; }
  clearFieldError('ssh-field-error');
  // A credential is shell access — make the user confirm, like Exit app.
  const ok = await confirmDialog({
    title: 'Generate SSH credential?',
    message: `This creates an ed25519 key for "${label}" that can open a shell on this host as ${(_sshStatus && _sshStatus.user) || 'the server user'}. Only do this on devices you trust.`,
    okText: 'Generate',
  });
  if (!ok) return;
  setBtnBusy(btn, true);
  const statusEl = document.getElementById('ssh-status');
  if (statusEl) statusEl.textContent = 'Generating key…';
  const r = await api('/api/ssh/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  setBtnBusy(btn, false);
  if (!r || r.error) {
    showFieldError('ssh-field-error', (r && r.error) || 'Generation failed');
    try { await refreshSshStatus(); } catch {}
    return;
  }
  if (labelEl) labelEl.value = '';
  showSshOnce(r);
  toast(`SSH key "${r.label}" created — copy the private key now`, 'success');
  try { await refreshSshStatus(); } catch {}
}

// Show-once private key panel. The key lives only in this DOM node —
// never localStorage, never re-fetchable. Dismiss clears it from memory.
function showSshOnce(cred) {
  const box = document.getElementById('ssh-once');
  if (!box) return;
  box.style.display = '';
  const user = cred.username || ((_sshStatus && _sshStatus.user) || 'user');
  const port = Number.isInteger(cred.port) ? cred.port : sshEffectivePort(_sshStatus);
  document.getElementById('ssh-once-key').value = cred.privateKey || '';
  const warn = document.getElementById('ssh-once-warn');
  if (warn) {
    if (_sshStatus && !sshAnyListening(_sshStatus)) {
      warn.style.display = '';
      warn.textContent = 'sshd is not listening on this host yet — the key is installed and ready, but enable sshd (steps below) before this command can connect.';
    } else {
      warn.style.display = 'none';
      warn.textContent = '';
    }
  }
  const cmdEl = document.getElementById('ssh-once-cmd');
  if (cmdEl) {
    const hosts = _sshStatus ? sshHostChoices(_sshStatus) : [{ value: 'server-ip' }];
    cmdEl.textContent = sshCommand(user, port, hosts[0].value);
  }
  box.scrollIntoView({ block: 'nearest' });
}

function dismissSshOnce() {
  const box = document.getElementById('ssh-once');
  if (!box) return;
  const ta = document.getElementById('ssh-once-key');
  if (ta) ta.value = '';
  box.style.display = 'none';
}

function copySshOnceKey() {
  const ta = document.getElementById('ssh-once-key');
  if (ta && ta.value) copyText(ta.value);
}

function downloadSshOnceKey() {
  const ta = document.getElementById('ssh-once-key');
  if (!ta || !ta.value) { toast('No key to download', 'warning'); return; }
  try {
    const blob = new Blob([ta.value], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'webtun-key';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch {} try { a.remove(); } catch {} }, 1000);
    toast('Key downloaded — set permissions (chmod 600) before use', 'info');
  } catch {
    toast('Download failed — copy the key instead', 'error');
  }
}

function copySshConfigRecipe() {
  const hosts = _sshStatus ? sshHostChoices(_sshStatus) : [{ value: 'server-ip' }];
  const user = (_sshStatus && _sshStatus.user) || 'user';
  const port = sshEffectivePort(_sshStatus);
  const host = hosts[0] ? hosts[0].value : 'server-ip';
  const snippet = `Host webtun\n  HostName ${host}\n  Port ${port}\n  User ${user}\n  IdentityFile ~/.ssh/webtun-key\n  IdentitiesOnly yes\n`;
  copyText(snippet);
  toast('Copied ~/.ssh/config recipe to clipboard', 'success');
}

function openSshUri() {
  const hosts = _sshStatus ? sshHostChoices(_sshStatus) : [{ value: 'server-ip' }];
  const user = (_sshStatus && _sshStatus.user) || 'user';
  const port = sshEffectivePort(_sshStatus);
  const host = hosts[0] ? hosts[0].value : 'server-ip';
  const uri = `ssh://${encodeURIComponent(user)}@${host}:${port}`;
  try {
    window.location.href = uri;
  } catch {
    copyText(uri);
    toast('Copied ' + uri, 'info');
  }
}

async function saveSshPort() {
  if (!requireSshEnabled()) return;
  const btn = document.getElementById('ssh-port-btn');
  if (btn && btn.dataset.busy === 'true') return;
  const input = document.getElementById('ssh-port');
  const port = input ? Number(input.value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showFieldError('ssh-field-error', 'Port must be a number 1-65535');
    return;
  }
  clearFieldError('ssh-field-error');
  setBtnBusy(btn, true);
  const r = await api('/api/ssh/port', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  setBtnBusy(btn, false);
  if (!r || r.error) {
    showFieldError('ssh-field-error', (r && r.error) || 'Could not save port');
    return;
  }
  toast(`SSH port set to ${r.port}`, 'success');
  try { await refreshSshStatus(); } catch {}
}

async function revokeSshKey(id, label, fingerprint, createdAt) {
  if (!requireSshEnabled()) return;
  let when = '';
  try { when = createdAt ? new Date(createdAt).toLocaleString() : ''; } catch {}
  const ok = await confirmDialog({
    title: 'Revoke SSH key?',
    message: `"${label || id}"${fingerprint ? ` (${fingerprint})` : ''}${when ? ` added ${when}` : ''} will stop working immediately. This only removes the WebTun-managed entry — other keys are untouched.`,
    okText: 'Revoke',
    danger: true,
  });
  if (!ok) return;
  const r = await api(`/api/ssh/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (r && r.error) { toast(r.error, 'error'); return; }
  toast(`SSH key "${label || id}" revoked`, 'success');
  try { await refreshSshStatus(); } catch {}
}

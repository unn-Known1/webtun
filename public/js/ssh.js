// WebTun frontend - ssh.js (on-demand SSH credentials for external clients.)
//
// Flow: Settings → SSH Access → label + Generate → server creates an ed25519
// pair, installs the public half for the server user, and returns the private
// half ONCE. The UI shows it in #ssh-once until dismissed — it is never
// stored in localStorage and never re-displayed. Termius/mobile recipe below.

let _sshStatus = null;
let _sshKeys = [];

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
    renderSshStatus(r);
    await refreshSshKeys();
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Could not load SSH status';
  }
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
    const live = Object.entries(s.listening || {}).filter(([, v]) => v).map(([p]) => p);
    const parts = [];
    parts.push(`User: ${(s.user || '(unknown)')}`);
    parts.push(`Port: ${sshEffectivePort(s)}`);
    parts.push(live.length ? `Listening on: ${live.join(', ')}` : 'sshd not detected on this host yet — see setup steps below');
    if (s.keyCount > 0) parts.push(`${s.keyCount}/${s.maxKeys} keys`);
    statusEl.textContent = parts.join('  •  ');
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
  (s.lanIps || []).forEach(ip => push('LAN', ip));
  push('This machine', '127.0.0.1');
  return hosts;
}

function sshCommand(user, port, host) {
  return `ssh -i ~/.ssh/webtun-key -p ${port} ${user}@${host}`;
}

function makeCopyRow(text, caption) {
  const cmd = document.createElement('div');
  cmd.className = 'tunnel-url';
  cmd.style.cssText = 'user-select:all;overflow-x:auto;white-space:nowrap;margin-top:4px';
  if (caption) cmd.title = caption + ' — click to copy';
  else cmd.title = 'Click to copy';
  cmd.textContent = text;
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
  title.style.cssText = 'font-size:11px;color:var(--fg3);margin:8px 0 4px';
  title.textContent = 'Connect with any SSH client (key login — no password):';
  el.appendChild(title);

  // One command per reachable address — the phone on Tailscale and the laptop
  // on LAN need different hostnames, and guessing wrong looks like breakage.
  hosts.forEach(h => {
    const row = makeCopyRow(sshCommand(user, port, h.value), h.label);
    el.appendChild(row);
  });

  const primary = hosts[0] ? hosts[0].value : 'server-ip';
  const termius = document.createElement('div');
  termius.style.cssText = 'font-size:11px;color:var(--fg2);margin-top:6px;line-height:1.6';
  termius.innerHTML =
    '<b>Termius (mobile):</b> Hosts → + → New Host → ' +
    `Hostname <b>${escapeHtml(primary)}</b>, Port <b>${port}</b>, Username <b>${escapeHtml(user)}</b> → ` +
    'Keychain → + → New Key → paste the private key shown once after Generate → select it under SSH Key. ' +
    'On first connect, verify the host fingerprint shown below.';
  el.appendChild(termius);

  if (s.hostFingerprints && s.hostFingerprints.length) {
    const fp = document.createElement('div');
    fp.style.cssText = 'font-size:11px;color:var(--fg2);margin-top:4px;overflow-wrap:anywhere';
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
  list.style.display = 'flex';
  _sshKeys.forEach(k => {
    const row = document.createElement('div');
    row.className = 'tunnel-row';

    const label = document.createElement('div');
    label.className = 'tunnel-label';
    label.textContent = k.label || k.id;
    label.title = `${k.type || ''}  ${k.fingerprint || ''}`;
    row.appendChild(label);

    const inner = document.createElement('div');
    inner.className = 'tunnel-inner';

    const meta = document.createElement('span');
    meta.className = 'tunnel-url';
    meta.style.cursor = 'default';
    let when = '';
    try { when = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : ''; } catch {}
    meta.textContent = [k.fingerprint || '', when].filter(Boolean).join('  •  ');
    meta.title = `Added ${k.createdAt ? new Date(k.createdAt).toLocaleString() : 'unknown'}${k.addedBy ? ' by ' + k.addedBy : ''}`;
    inner.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'icon-btn tunnel-btn stop';
    del.title = 'Revoke this key';
    del.setAttribute('aria-label', `Revoke SSH key ${k.label || k.id}`);
    del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    del.addEventListener('click', () => revokeSshKey(k.id, k.label, k.fingerprint, k.createdAt));
    inner.appendChild(del);

    row.appendChild(inner);
    list.appendChild(row);
  });
}

async function generateSshCredential() {
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

async function saveSshPort() {
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

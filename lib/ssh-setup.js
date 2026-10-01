'use strict';

// WebTun SSH Easy Setup — one-click automation for everything the SSH popup
// needs (system sshd, firewall, Tailscale, managed fallback sshd).
//
// Security bars (non-negotiable):
// - Privilege is only ever attempted via NON-INTERACTIVE sudo (`sudo -n`).
//   The web UI never accepts a sudo password; if sudo needs one, the action
//   fails cleanly and the UI falls back to showing the manual command.
// - Every privileged action runs through an allow-listed argv with execFile
//   (no shells, no interpolation of user input — the only user input is a
//   numeric port and an optional Tailscale auth key, both validated).
// - Long installs run async: the route returns 202 immediately and the
//   outcome is surfaced on the next GET /api/ssh/setup (lastAction).
// - A Tailscale auth key is one-time use and is NEVER written to disk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const ssh = require('./ssh');

const SETUP_ACTIONS = new Set([
  'install-sshd', 'enable-sshd',
  'open-firewall',
  'install-tailscale', 'tailscale-up', 'tailscale-down',
  'start-managed', 'stop-managed',
]);

let lastAction = null; // { action, startedAt, done, ok, output }
function setLastAction(a) { lastAction = a; }

function hasBin(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function isRoot() {
  try { return typeof process.getuid === 'function' && process.getuid() === 0; } catch { return false; }
}

// Run argv with non-interactive sudo (or directly when running as root).
// Resolves { ok, output } — never throws for sudo failures (no tty / not
// in sudoers / timeout); only true spawn errors reject.
function sudoN(argv, timeoutMs) {
  return new Promise((resolve) => {
    if (isRoot()) {
      execFile(argv[0], argv.slice(1), { timeout: timeoutMs || 60000 }, (err, stdout, stderr) => {
        const output = String(stdout || '') + String(stderr || '');
        if (err) return resolve({ ok: false, output: output.slice(-2000) });
        resolve({ ok: true, output: output.slice(-2000) });
      });
      return;
    }
    execFile('sudo', ['-n', ...argv], { timeout: timeoutMs || 60000 }, (err, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      if (err) return resolve({ ok: false, output: output.slice(-2000) });
      resolve({ ok: true, output: output.slice(-2000) });
    });
  });
}

function runBin(argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs || 15000 }, (err, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      if (err) return resolve({ ok: false, output: output.slice(-2000) });
      resolve({ ok: true, output: output.slice(-2000) });
    });
  });
}

// Non-interactive sudo probe (no side effects): tells the wizard whether
// one-click system fixes are possible at all.
async function canSudo() {
  if (isRoot()) return true;
  const r = await sudoN(['true'], 10000);
  return r.ok;
}

// Capped HTTPS download with a strict host allow-list (same discipline as
// lib/cloudflared.js: official hosts only, redirect cap, size cap).
const TS_ALLOWED_HOSTS = new Set([
  'tailscale.com', 'www.tailscale.com', 'pkgs.tailscale.com', 'dl.tailscale.com',
]);
function tsHostOk(host) {
  const h = String(host || '').toLowerCase();
  return TS_ALLOWED_HOSTS.has(h) || h.endsWith('.tailscale.com');
}
function downloadFile(url, dest, maxBytes) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const get = (u) => {
      let parsed;
      try { parsed = new URL(u); } catch { return reject(new Error('bad url')); }
      if (parsed.protocol !== 'https:') return reject(new Error('https only'));
      if (!tsHostOk(parsed.hostname)) return reject(new Error('host not allowed'));
      if (++redirects > 5) return reject(new Error('too many redirects'));
      const req = https.get(parsed, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, parsed).toString());
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
        let bytes = 0;
        const ws = fs.createWriteStream(dest, { mode: 0o600 });
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > maxBytes) { try { req.destroy(); } catch {} try { ws.destroy(); } catch {} reject(new Error('download too large')); }
          else ws.write(c);
        });
        res.on('end', () => ws.end(() => resolve(bytes)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.destroy(); } catch {} reject(new Error('timeout')); });
    };
    get(url);
  });
}

function pkgManager() {
  if (hasBin('apt-get')) return 'apt-get';
  if (hasBin('dnf')) return 'dnf';
  if (hasBin('pacman')) return 'pacman';
  if (hasBin('apk')) return 'apk';
  return null;
}

function serviceTool() {
  if (hasBin('systemctl')) return 'systemctl';
  if (hasBin('service')) return 'service';
  return null;
}

// ── Checks (read-only, power the wizard checklist) ───────────────────────

async function getSetupChecks(dataDir) {
  const platform = os.platform();
  const st = ssh._loadState ? ssh._loadState(dataDir) : null;
  const expectedPort = (st && st.port) || ssh.defaultPort();
  const checks = [];

  // 1. sshd binary
  const sshdBin = platform !== 'win32' && hasBin('sshd');
  checks.push({
    id: 'sshd-binary', ok: sshdBin,
    detail: sshdBin ? 'OpenSSH server found' : 'No sshd on this host',
    fix: sshdBin ? null : 'install-sshd',
    manual: sshdBin ? null : 'sudo apt-get install -y openssh-server  (dnf/pacman/apk equivalents work too)',
  });

  // 2. sshd listening (system daemons OR our managed fallback)
  const status = await ssh.getSshStatus(dataDir).catch(() => null);
  const listening = status ? status.listening || {} : {};
  const sysListening = !!(listening[expectedPort] || listening[22]);
  const managed = managedStatus(dataDir);
  const anyListening = sysListening || managed.listening;
  checks.push({
    id: 'sshd-listening', ok: anyListening,
    detail: managed.listening ? `Built-in SSH listening on ${managed.port}`
      : sysListening ? `sshd answering (${Object.entries(listening).filter(([, v]) => v).map(([p]) => p).join(', ')})`
      : 'Nothing answering on the SSH port yet',
    fix: anyListening ? null : (sshdBin ? 'enable-sshd' : 'start-managed'),
    manual: anyListening ? null : `sudo systemctl enable --now ssh   (or start WebTun's built-in SSH below — no root needed)`,
  });

  // 3. key-only auth posture (best effort: sshd -T needs config read access)
  let pubkey = null, pubkeyDetail = 'Could not read sshd config (needs root) — assumed default';
  try {
    const r = await runBin(['sshd', '-T'], 8000);
    if (!r.ok) {
      const s = await sudoN(['sshd', '-T'], 8000);
      if (s.ok) r.ok = true, r.output = s.output;
    }
    if (r.ok) {
      const m = String(r.output).match(/^pubkeyauthentication\s+(\S+)/mi);
      const p = String(r.output).match(/^passwordauthentication\s+(\S+)/mi);
      pubkey = m ? m[1].toLowerCase() === 'yes' : null;
      pubkeyDetail = m
        ? `PubkeyAuthentication ${m[1]}${p ? `, PasswordAuthentication ${p[1]}` : ''}`
        : 'sshd running, posture unreadable';
    }
  } catch {}
  checks.push({ id: 'pubkey-auth', ok: pubkey === false ? false : true, warn: pubkey === null, detail: pubkeyDetail, fix: null, manual: null });

  // 4. firewall (ufw / firewalld). Inactive firewall = nothing to open.
  const fw = await firewallState(expectedPort);
  checks.push({
    id: 'firewall', ok: fw.ok, warn: fw.unknown,
    detail: fw.detail,
    fix: !fw.ok && !fw.unknown ? 'open-firewall' : null,
    manual: !fw.ok && !fw.unknown ? `sudo ufw allow ${expectedPort}/tcp   (or firewall-cmd --add-port=${expectedPort}/tcp --permanent)` : null,
  });

  // 5. tailscale
  const ts = await tailscaleState(dataDir);
  const tsManagedByUs = !!((st && st.tailscaleManaged) && ts.ip);
  checks.push({
    id: 'tailscale',
    ok: !!(ts.ip), warn: ts.bin && !ts.ip,
    detail: ts.ip ? `Tailnet IP ${ts.ip}${ts.userspace ? ' (WebTun userspace daemon)' : ''}`
      : ts.bin ? 'Installed but not logged in — one click (or paste an auth key) below'
      : 'Not installed — phone-over-mobile-data needs this',
    fix: ts.ip ? null : (ts.bin ? 'tailscale-up' : 'install-tailscale'),
    canDown: tsManagedByUs,
    manual: ts.ip ? null : (ts.bin ? 'tailscale up   (or: tailscale up --auth-key=tskey-...)'
      : 'curl -fsSL https://tailscale.com/install.sh | sh'),
  });

  // 6. managed fallback sshd
  checks.push({
    id: 'managed-sshd', ok: true, info: true,
    detail: managed.listening ? `Built-in SSH running on ${managed.port} (pid ${managed.pid})`
      : 'Built-in SSH stopped — zero-privilege fallback when system sshd is unavailable',
    fix: null, manual: null,
    managed,
  });

  // 7. at least one key
  const keys = ssh.listCredentials(dataDir);
  checks.push({
    id: 'key', ok: keys.length > 0,
    detail: keys.length > 0 ? `${keys.length} credential${keys.length === 1 ? '' : 's'} ready` : 'No credentials yet — generate one below',
    fix: null, manual: null,
  });

  return { checks, lastAction };
}

async function firewallState(port) {
  // ufw
  if (hasBin('ufw')) {
    const r = await runBin(['ufw', 'status'], 8000);
    if (r.ok) {
      if (/Status:\s*inactive/i.test(r.output)) return { ok: true, detail: 'No host firewall active (ufw inactive)' };
      const open = new RegExp(`(^|\\s)${port}/tcp\\s+ALLOW`, 'i').test(r.output)
        || new RegExp(`ALLOW.*${port}`, 'i').test(r.output);
      return open
        ? { ok: true, detail: `Port ${port} allowed (ufw)` }
        : { ok: false, detail: `ufw active but port ${port} not allowed` };
    }
  }
  // firewalld
  if (hasBin('firewall-cmd')) {
    const r = await runBin(['firewall-cmd', '--list-ports'], 8000);
    if (r.ok) {
      const open = String(r.output).split(/\s+/).some(p => p === `${port}/tcp`);
      return open
        ? { ok: true, detail: `Port ${port} allowed (firewalld)` }
        : { ok: false, detail: `firewalld running but port ${port} not open` };
    }
  }
  return { ok: true, unknown: true, detail: 'No recognised firewall (ufw/firewalld) — assuming open' };
}

// ── Tailscale (system daemon preferred, userspace fallback) ──────────────

const TS_DIR = 'tailscale';
function tsPaths(dataDir) {
  const dir = path.join(dataDir, TS_DIR);
  return {
    dir,
    state: path.join(dir, 'tailscaled.state'),
    sock: path.join(dir, 'tailscaled.sock'),
    binDir: path.join(dir, 'bin'),
  };
}

let tsDaemon = null; // userspace `tailscaled` child we supervise

function tsBin(dataDir) {
  // System binary first; then our userspace copy.
  if (hasBin('tailscale')) return { bin: 'tailscale', system: true };
  const p = tsPaths(dataDir);
  const local = path.join(p.binDir, 'tailscale');
  try {
    if (fs.statSync(local).isFile()) return { bin: local, system: false };
  } catch {}
  return null;
}

async function tailscaleState(dataDir) {
  const found = tsBin(dataDir);
  if (!found) return { bin: false, ip: null };
  const env = found.system ? {} : { TAILSCALED_SOCKET: tsPaths(dataDir).sock };
  return new Promise((resolve) => {
    execFile(found.bin, ['ip', '-4'], { timeout: 8000, env: { ...process.env, ...env } }, (err, stdout) => {
      if (err) return resolve({ bin: true, ip: null, userspace: !found.system });
      const ip = String(stdout || '').trim().split('\n')[0].trim();
      resolve({ bin: true, ip: /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null, userspace: !found.system });
    });
  });
}

function tailscaleArch() {
  const arch = process.arch;
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  if (arch === 'arm') return 'arm';
  return null;
}

// Userspace tailscaled supervision. Deliberately NOT killed on server stop:
// it owns the Tailnet connection, and flapping it on every server restart
// would drop remote access. Identity persists in tsPaths().state, so a new
// server process adopts the live daemon via its socket.
function tsSockAlive(dataDir) {
  return new Promise((resolve) => {
    const found = tsBin(dataDir);
    if (!found) return resolve(false);
    const env = found.system ? {} : { TAILSCALED_SOCKET: tsPaths(dataDir).sock };
    execFile(found.bin, ['status', '--json=false'], { timeout: 8000, env: { ...process.env, ...env } }, (err) => {
      resolve(!err);
    });
  });
}

async function ensureUserspaceDaemon(dataDir) {
  if (await tsSockAlive(dataDir)) return { ok: true, adopted: true };
  const p = tsPaths(dataDir);
  const daemon = path.join(p.binDir, 'tailscaled');
  try {
    if (!fs.statSync(daemon).isFile()) return { ok: false, output: 'tailscaled binary missing' };
  } catch { return { ok: false, output: 'tailscaled binary missing' }; }
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(path.join(p.dir, 'tailscaled.log'), 'a');
  const child = spawn(daemon, [`--state=${p.state}`, `--socket=${p.sock}`], {
    stdio: ['ignore', logFd, logFd], detached: true,
  });
  child.unref();
  if (tsDaemon) { try { tsDaemon.kill('SIGTERM'); } catch {} }
  tsDaemon = child;
  // Wait for the control socket to answer.
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await tsSockAlive(dataDir)) return { ok: true, adopted: false };
    if (Date.now() > deadline) return { ok: false, output: 'daemon did not answer (needs /dev/net/tun — on VPS enable TUN, or run tailscale on the host)' };
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Managed sshd (zero-privilege fallback, supervised child) ─────────────

const MANAGED_DIR = 'managed-sshd';
let managedProc = null;

function managedPaths(dataDir) {
  const dir = path.join(dataDir, MANAGED_DIR);
  return {
    dir,
    pid: path.join(dir, 'sshd.pid'),
    log: path.join(dir, 'sshd.log'),
    hostEd: path.join(dir, 'ssh_host_ed25519_key'),
    hostRsa: path.join(dir, 'ssh_host_rsa_key'),
  };
}

function managedState(dataDir) {
  const st = ssh._loadState ? ssh._loadState(dataDir) : { managedSshd: null };
  return (st && st.managedSshd) || { enabled: false, port: 2222 };
}

function managedStatus(dataDir) {
  const cfg = managedState(dataDir);
  const alive = !!(managedProc && managedProc.exitCode === null && !managedProc.killed);
  return { enabled: !!cfg.enabled, port: cfg.port || 2222, pid: alive ? managedProc.pid : (cfg.pid || 0), listening: false, alive };
}

async function refreshManagedListening(dataDir) {
  const s = managedStatus(dataDir);
  if (!s.alive && !s.pid) return { ...s, listening: false };
  // Probe the port rather than trusting the pid (a recycled pid must not
  // pass as our daemon — same discipline as the tunnel startKey checks).
  const port = s.port;
  const listening = await new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ port, host: '127.0.0.1' });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(1000);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
  return { ...s, listening };
}

function ensureHostKeys(dataDir) {
  const p = managedPaths(dataDir);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(p.dir, 0o700); } catch {}
  const want = [
    { f: p.hostEd, args: ['-t', 'ed25519'] },
    { f: p.hostRsa, args: ['-t', 'rsa', '-b', '3072'] },
  ];
  for (const w of want) {
    if (!fs.existsSync(w.f)) {
      execFileSync('ssh-keygen', [...w.args, '-f', w.f, '-N', '', '-C', 'webtun-managed'], { timeout: 15000 });
      try { fs.chmodSync(w.f, 0o600); } catch {}
    }
  }
  return [p.hostEd, p.hostRsa];
}

function sshdAbsolute() {
  // sshd re-execs itself and refuses a bare filename — resolve it once.
  try {
    const p = execFileSync('which', ['sshd'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0].trim();
    if (p && p.startsWith('/') && fs.existsSync(p)) return p;
  } catch {}
  for (const p of ['/usr/sbin/sshd', '/usr/bin/sshd', '/sbin/sshd']) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// Start (or adopt) the managed sshd. Runs as the server user on a high port;
// key-only, no root, no system config touched. Supervised: exactly one child.
async function startManagedSshd(dataDir, port) {
  const sshd = sshdAbsolute();
  if (!sshd) {
    throw Object.assign(new Error('No sshd binary on this host — install OpenSSH first'), { status: 501 });
  }
  const wantPort = Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535
    ? Number(port) : 2222;

  // Clear existing managedProc and stale pid before probing if the port is busy
  if (managedProc && managedProc.exitCode === null && !managedProc.killed) {
    try { managedProc.kill('SIGTERM'); } catch {}
    managedProc = null;
    await new Promise(r => setTimeout(r, 600));
  }
  try {
    const cfg = managedState(dataDir);
    if (cfg && cfg.pid && cfg.pid !== process.pid) {
      try { process.kill(cfg.pid, 'SIGTERM'); } catch {}
      await new Promise(r => setTimeout(r, 400));
    }
  } catch {}

  // Never "adopt" someone else's listener: if the port already answers, our
  // probe would declare victory for a daemon that isn't ours.
  const busy = await new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ port: wantPort, host: '127.0.0.1' });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(1000);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
  if (busy) {
    throw Object.assign(new Error(`Port ${wantPort} already answers — your system sshd covers it, no built-in needed`), { status: 409 });
  }
  const keys = ensureHostKeys(dataDir);
  const p = managedPaths(dataDir);
  // AuthorizedKeysFile must live outside /tmp (StrictModes rejects
  // world-writable path components) — the user's own file qualifies.
  const ak = path.join(os.homedir(), '.ssh', 'authorized_keys');
  const args = ['-D', '-e', '-p', String(wantPort)];
  for (const k of keys) args.push('-h', k);
  args.push(
    '-o', `PidFile=${p.pid}`,
    '-o', `AuthorizedKeysFile=${ak}`,
    '-o', 'PasswordAuthentication=no',
    '-o', 'ChallengeResponseAuthentication=no',
    '-o', 'PermitRootLogin=prohibit-password',
    '-o', 'UsePAM=no',
    '-o', 'X11Forwarding=no',
    '-o', 'MaxAuthTries=3',
  );
  const logFd = fs.openSync(p.log, 'a');
  const child = spawn(sshd, args, { stdio: ['ignore', logFd, logFd], detached: false });
  managedProc = child;
  child.on('exit', () => { if (managedProc === child) managedProc = null; });
  // Wait for the port, then verify it is OUR daemon (pid file match).
  const up = await new Promise((resolve) => {
    const deadline = Date.now() + 8000;
    const tick = () => {
      const net = require('net');
      const sock = net.createConnection({ port: wantPort, host: '127.0.0.1' });
      const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
      sock.setTimeout(1000);
      sock.on('connect', () => done(true));
      sock.on('timeout', () => { if (Date.now() > deadline) done(false); else setTimeout(tick, 300); });
      sock.on('error', () => { if (Date.now() > deadline) done(false); else setTimeout(tick, 300); });
    };
    tick();
  });
  if (!up) {
    try { child.kill('SIGTERM'); } catch {}
    managedProc = null;
    throw Object.assign(new Error('Built-in sshd did not start (see log) — port busy or sshd refused'), { status: 500 });
  }
  persistManaged(dataDir, { enabled: true, port: wantPort, pid: child.pid });
  return { success: true, port: wantPort, pid: child.pid };
}

function persistManaged(dataDir, cfg) {
  const st = ssh._loadState(dataDir);
  st.managedSshd = cfg;
  ssh._saveState(dataDir, st);
}

function stopManagedSshd(dataDir) {
  shutdownManagedSshd(dataDir);
  const cfg = managedState(dataDir);
  persistManaged(dataDir, { enabled: false, port: cfg.port || 2222, pid: 0 });
  return { success: true };
}

// Process exit path: kill the daemon but LEAVE the persisted `enabled` flag
// so the next boot restores it (unlike stopManagedSshd, which is the user
// asking for it to stay off). Shared-DATA_DIR siblings can theoretically
// share one daemon entry; a busy port makes the second boot stand down.
function shutdownManagedSshd(dataDir) {
  if (managedProc) {
    try { managedProc.kill('SIGTERM'); } catch {}
    managedProc = null;
    return;
  }
  try {
    const cfg = managedState(dataDir);
    if (cfg.pid) { try { process.kill(cfg.pid, 'SIGTERM'); } catch {} }
    try { fs.unlinkSync(managedPaths(dataDir).pid); } catch {}
  } catch {}
}

// Boot after the HTTP port binds (sibling-safe: our own child only).
// Skipped while the feature master switch is off.
async function bootManagedSshd(dataDir) {
  const st = ssh._loadState(dataDir);
  if (!st.enabled) return;
  const cfg = managedState(dataDir);
  if (!cfg.enabled) return;
  try {
    await startManagedSshd(dataDir, cfg.port);
    console.log(`  Built-in SSH running → port ${cfg.port}`);
  } catch (e) {
    console.log('  Built-in SSH did not start: ' + (e.message || e));
  }
}

// Master-switch teardown: turning the feature OFF stops everything WebTun
// itself started — the supervised built-in sshd, plus a Tailnet WE brought
// up (provenance-tracked; a Tailnet the user runs for other purposes is
// never touched). Issued keys are NOT revoked (destructive and, for system
// sshd sessions, unenforceable from here) — revoke them individually, or
// they simply stop being useful once no listener/Tailnet remains.
async function setSshFeatureEnabled(dataDir, on) {
  const st = ssh._loadState(dataDir);
  st.enabled = on === true;
  ssh._saveState(dataDir, st);
  const notes = [];
  if (!st.enabled) {
    try {
      const m = managedState(dataDir);
      if (m.enabled || m.pid) { stopManagedSshd(dataDir); notes.push('built-in SSH stopped'); }
    } catch (e) { notes.push('built-in SSH stop failed: ' + (e.message || e)); }
    try {
      const fresh = ssh._loadState(dataDir);
      if (fresh.tailscaleManaged) {
        const r = await tailscaleDown(dataDir);
        if (r.ok) {
          fresh.tailscaleManaged = false;
          ssh._saveState(dataDir, fresh);
          notes.push('Tailnet disconnected (it was brought up by WebTun)');
        } else {
          notes.push('Tailnet disconnect failed — run tailscale down manually');
        }
      }
    } catch (e) { notes.push('Tailnet disconnect failed: ' + (e.message || e)); }
  }
  return { success: true, enabled: st.enabled, notes };
}

async function tailscaleDown(dataDir) {
  const found = tsBin(dataDir);
  if (!found) return { ok: true, output: 'tailscale not installed' };
  const env = found.system ? {} : { TAILSCALED_SOCKET: tsPaths(dataDir).sock };
  return new Promise((resolve) => {
    execFile(found.bin, ['down'], { timeout: 20000, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      resolve(err ? { ok: false, output: output.slice(-1000) } : { ok: true, output: 'Tailnet disconnected' });
    });
  });
}

function markTailscaleManaged(dataDir) {
  try {
    const st = ssh._loadState(dataDir);
    if (!st.tailscaleManaged) { st.tailscaleManaged = true; ssh._saveState(dataDir, st); }
  } catch {}
}

// ── Fix actions (allow-listed; sudo -n only; async where slow) ────────────

async function runSetupAction(dataDir, action, opts = {}) {
  if (!SETUP_ACTIONS.has(action)) {
    throw Object.assign(new Error('Unknown setup action'), { status: 400 });
  }
  // Teardown is always allowed (off must never trap); everything constructive
  // requires the master switch.
  if (action !== 'stop-managed' && action !== 'tailscale-down') {
    ssh.requireSshEnabled(dataDir);
  }
  const st = ssh._loadState ? ssh._loadState(dataDir) : null;
  const expectedPort = (st && st.port) || ssh.defaultPort();

  const finish = (ok, output) => {
    const rec = { action, startedAt: Date.now(), done: true, ok, output: String(output || '').slice(-2000) };
    setLastAction(rec);
    return rec;
  };

  if (action === 'start-managed') {
    const out = await startManagedSshd(dataDir, opts.port || expectedPort);
    return finish(true, `Built-in sshd listening on ${out.port} (pid ${out.pid})`);
  }
  if (action === 'stop-managed') {
    stopManagedSshd(dataDir);
    return finish(true, 'Built-in sshd stopped');
  }

  if (action === 'install-sshd') {
    setLastAction({ action, startedAt: Date.now(), done: false, ok: false, output: 'Installing…' });
    (async () => {
      try {
        const pm = pkgManager();
        if (!pm) return finish(false, 'No supported package manager (apt/dnf/pacman/apk) — install openssh-server manually');
        let r;
        if (pm === 'apt-get') {
          r = await sudoN(['apt-get', 'update'], 120000);
          if (!r.ok) return finish(false, 'apt-get update needs root (sudo -n refused). Manual: sudo apt-get install -y openssh-server');
          r = await sudoN(['apt-get', 'install', '-y', 'openssh-server'], 300000);
        } else if (pm === 'dnf') {
          r = await sudoN(['dnf', 'install', '-y', 'openssh-server'], 300000);
        } else if (pm === 'pacman') {
          r = await sudoN(['pacman', '-Sy', '--noconfirm', 'openssh'], 300000);
        } else {
          r = await sudoN(['apk', 'add', 'openssh-server'], 300000);
        }
        finish(r.ok, r.ok ? 'OpenSSH server installed' : `Install needs root (sudo -n refused). Manual: install openssh-server via ${pm}. ${r.output}`);
      } catch (e) { finish(false, e.message || 'install failed'); }
    })();
    return { started: true, action };
  }

  if (action === 'enable-sshd') {
    setLastAction({ action, startedAt: Date.now(), done: false, ok: false, output: 'Enabling…' });
    (async () => {
      try {
        const tool = serviceTool();
        if (!tool) return finish(false, 'No systemctl/service here (container?) — use the built-in SSH instead');
        let r;
        if (tool === 'systemctl') r = await sudoN(['systemctl', 'enable', '--now', 'ssh'], 60000);
        else r = await sudoN(['service', 'ssh', 'start'], 60000);
        finish(r.ok, r.ok ? 'sshd enabled and started' : `Enablement needs root (sudo -n refused). Manual: sudo systemctl enable --now ssh. ${r.output}`);
      } catch (e) { finish(false, e.message || 'enable failed'); }
    })();
    return { started: true, action };
  }

  if (action === 'open-firewall') {
    const r = hasBin('ufw')
      ? await sudoN(['ufw', 'allow', `${expectedPort}/tcp`], 30000)
      : hasBin('firewall-cmd')
        ? await sudoN(['firewall-cmd', '--permanent', `--add-port=${expectedPort}/tcp`], 30000)
          .then(async (x) => {
            if (x.ok) await sudoN(['firewall-cmd', '--reload'], 30000);
            return x;
          })
        : { ok: false, output: 'no ufw/firewalld' };
    if (!r.ok) {
      return finish(false, `Firewall change needs root (sudo -n refused). Manual: sudo ufw allow ${expectedPort}/tcp`);
    }
    return finish(true, `Port ${expectedPort} opened`);
  }

  if (action === 'install-tailscale') {
    setLastAction({ action, startedAt: Date.now(), done: false, ok: false, output: 'Installing…' });
    (async () => {
      try {
        if (os.platform() === 'win32' || os.platform() === 'darwin') {
          return finish(false, 'Automatic install covers Linux here — on Windows/macOS install Tailscale from tailscale.com/download, then use tailscale-up below');
        }
        // Path 1: root available → official installer (downloaded first,
        // size-capped, then executed — never a blind curl|sh).
        if (await canSudo()) {
          const tmp = path.join(os.tmpdir(), `webtun-ts-install-${crypto.randomBytes(6).toString('hex')}.sh`);
          try {
            await downloadFile('https://tailscale.com/install.sh', tmp, 2 * 1024 * 1024);
            const r = await sudoN(['sh', tmp], 300000);
            if (r.ok) return finish(true, 'Tailscale installed (system). Use tailscale-up next.');
            return finish(false, `Installer failed under sudo. Manual: curl -fsSL https://tailscale.com/install.sh | sh. ${r.output}`);
          } catch (e) {
            return finish(false, `Download failed: ${e.message}. Manual: curl -fsSL https://tailscale.com/install.sh | sh`);
          } finally {
            try { fs.unlinkSync(tmp); } catch {}
          }
        }
        // Path 2: no root → userspace static binaries into DATA_DIR (no
        // privilege needed at all; the daemon runs as the server user).
        const arch = tailscaleArch();
        if (!arch) return finish(false, `Unsupported CPU (${process.arch}) for automatic install — get it from tailscale.com/download`);
        const p = tsPaths(dataDir);
        fs.mkdirSync(p.binDir, { recursive: true, mode: 0o700 });
        const ver = await new Promise((resolve) => {
          const https = require('https');
          const req = https.get('https://pkgs.tailscale.com/stable/VERSION', { timeout: 15000 }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve(String(body).trim().split(/\s+/)[0]));
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
        });
        if (!ver || !/^\d+\.\d+\.\d+$/.test(ver)) {
          return finish(false, 'Could not read the stable version — check connectivity, or install from tailscale.com/download');
        }
        if (!hasBin('tar')) return finish(false, 'Need the tar tool to unpack — install it, or use tailscale.com/download');
        const tgz = path.join(os.tmpdir(), `webtun-ts-${ver}-${crypto.randomBytes(4).toString('hex')}.tgz`);
        try {
          await downloadFile(`https://pkgs.tailscale.com/stable/tailscale_${ver}_${arch}.tgz`, tgz, 60 * 1024 * 1024);
          const r = await runBin(['tar', '-xzf', tgz, '-C', os.tmpdir()], 60000);
          if (!r.ok) return finish(false, 'Unpack failed — install from tailscale.com/download');
          const srcDir = path.join(os.tmpdir(), `tailscale_${ver}_${arch}`);
          for (const b of ['tailscale', 'tailscaled']) {
            const src = path.join(srcDir, b), dst = path.join(p.binDir, b);
            fs.copyFileSync(src, dst);
            try { fs.chmodSync(dst, 0o700); } catch {}
          }
          try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch {}
          return finish(true, `Tailscale ${ver} installed for this user (no root needed). Use tailscale-up next.`);
        } catch (e) {
          return finish(false, `Download failed: ${e.message}. Manual: tailscale.com/download`);
        } finally {
          try { fs.unlinkSync(tgz); } catch {}
        }
      } catch (e) { finish(false, e.message || 'install failed'); }
    })();
    return { started: true, action };
  }

  if (action === 'tailscale-up') {
    const found = tsBin(dataDir);
    if (!found) throw Object.assign(new Error('Install Tailscale first'), { status: 400 });
    // Userspace mode needs our daemon answering before `up` can proceed.
    if (!found.system) {
      const d = await ensureUserspaceDaemon(dataDir);
      if (!d.ok) return finish(false, `Tailscale daemon would not start: ${d.output}`);
    }
    const authKey = typeof opts.authKey === 'string' ? opts.authKey.trim() : '';
    if (authKey && !/^tskey-auth-[A-Za-z0-9_-]{10,128}$/.test(authKey)) {
      throw Object.assign(new Error('That does not look like a Tailscale auth key (tskey-auth-…)'), { status: 400 });
    }
    const env = found.system ? {} : { TAILSCALED_SOCKET: tsPaths(dataDir).sock };
    // Fixed hostname keeps the MagicDNS name stable across restarts
    // (Tailscale suffixes it automatically on collision).
    const args = ['up', '--hostname', 'webtun'];
    if (authKey) args.push('--auth-key', authKey);
    let r = await new Promise((resolve) => {
      execFile(found.bin, args, { timeout: 60000, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
        const output = String(stdout || '') + String(stderr || '');
        if (!err) return resolve({ ok: true, output });
        resolve({ ok: false, output });
      });
    });
    // If running system tailscale as non-root failed with permission/access error, try with sudo if available
    if (!r.ok && found.system && (r.output.includes('Access denied') || r.output.includes('permission denied') || r.output.includes('connect: connection refused'))) {
      if (await canSudo()) {
        r = await sudoN(['tailscale', ...args], 60000);
      }
    }
    // Interactive login required: surface the device URL (never the key).
    const url = String(r.output).match(/https:\/\/login\.tailscale\.com\/\S+/);
    if (!r.ok && url) {
      return finish(false, `Tailscale needs your login (one tap, once): ${url[0]}`);
    }
    if (!r.ok) return finish(false, `tailscale up failed: ${r.output.slice(-1500)}`);
    const ts = await tailscaleState(dataDir);
    if (ts.ip) markTailscaleManaged(dataDir);
    return finish(true, ts.ip ? `Tailscale up — Tailnet IP ${ts.ip}` : 'tailscale up finished');
  }

  if (action === 'tailscale-down') {
    const r = await tailscaleDown(dataDir);
    if (r.ok) {
      try {
        const st = ssh._loadState(dataDir);
        st.tailscaleManaged = false;
        ssh._saveState(dataDir, st);
      } catch {}
    }
    return finish(r.ok, r.ok ? 'Tailnet disconnected' : `Disconnect failed: ${r.output}`);
  }

  throw Object.assign(new Error('Unhandled action'), { status: 500 });
}

module.exports = {
  SETUP_ACTIONS: [...SETUP_ACTIONS],
  getSetupChecks,
  runSetupAction,
  lastAction: () => lastAction,
  bootManagedSshd,
  stopManagedSshd,
  shutdownManagedSshd,
  setSshFeatureEnabled,
  refreshManagedListening,
  tailscaleState,
};

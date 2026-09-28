'use strict';

// WebTun on-demand SSH credentials for external SSH clients
// (Termius on mobile, VS Code Remote-SSH, plain `ssh`, rsync/sftp).
//
// Design (v1, deliberately conservative):
// - Off by default. Nothing here runs at install or boot. Credentials exist
//   only after an explicit, PIN-authed request (POST /api/ssh/credentials).
// - Key-only. ed25519 keypair per credential, no passphrase, no passwords,
//   no new OS users, no sudo, no sshd_config edits. The public half is
//   appended to the server user's own ~/.ssh/authorized_keys (same identity
//   as the PTY shells, so no file-ownership split). The private half is
//   returned ONCE in the creation response and never stored on disk.
// - Managed lines are tagged `webtun:<id>` so revoke/disable only ever
//   touches WebTun-created entries; foreign keys are left alone.
// - State lives in DATA_DIR (passed in by server.js): .ssh-state.json holds
//   public metadata only. Like .tunnels.json / .cmdhist.json, writes are
//   atomic tmp+rename with 0600.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFileSync, execFile } = require('child_process');

const SSH_STATE_FILE = '.ssh-state.json';
const MAX_KEYS = 32;
const KEY_TAG_PREFIX = 'webtun:';

function defaultDataDir() {
  try {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const dir = path.join(base, 'webtun');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch { return __dirname; }
}

function statePath(dataDir) {
  return path.join(dataDir || defaultDataDir(), SSH_STATE_FILE);
}

function defaultPort() {
  const raw = parseInt(process.env.SSH_PORT || '2222', 10);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 65535) return raw;
  return 2222;
}

// An explicitly set SSH_PORT always wins over the stored value, so changing
// the env (or .env) later is not silently ignored after the first run.
function explicitEnvPort() {
  if (process.env.SSH_PORT === undefined || process.env.SSH_PORT === '') return 0;
  const raw = parseInt(process.env.SSH_PORT, 10);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 65535) return raw;
  return 0;
}

function currentUsername() {
  try {
    const u = os.userInfo && os.userInfo().username;
    if (u) return u;
  } catch {}
  return process.env.USER || process.env.USERNAME || process.env.LOGNAME || '';
}

function loadState(dataDir) {
  const st = { version: 1, port: defaultPort(), credentials: [] };
  try {
    const raw = fs.readFileSync(statePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (Number.isFinite(parsed.port)) st.port = parsed.port;
      if (Array.isArray(parsed.credentials)) {
        st.credentials = parsed.credentials.filter(c => c && typeof c.id === 'string');
      }
      // Preserve the managed-sshd block across unrelated saves (key
      // create/revoke re-persist the whole file — dropping this would
      // silently disable the built-in sshd on every key change).
      if (parsed.managedSshd && typeof parsed.managedSshd === 'object') {
        const mp = Number(parsed.managedSshd.port);
        st.managedSshd = {
          enabled: parsed.managedSshd.enabled === true,
          port: Number.isInteger(mp) && mp >= 1024 && mp <= 65535 ? mp : 2222,
          pid: Number.isInteger(parsed.managedSshd.pid) ? parsed.managedSshd.pid : 0,
        };
      }
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  const envPort = explicitEnvPort();
  if (envPort) st.port = envPort;
  if (!Number.isFinite(st.port) || st.port < 1 || st.port > 65535) st.port = defaultPort();
  return st;
}

function setExpectedPort(dataDir, port) {
  const raw = Number(port);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw Object.assign(new Error('Port must be a number 1-65535'), { status: 400 });
  }
  const st = loadState(dataDir);
  st.port = raw;
  saveState(dataDir, st);
  return { success: true, port: raw };
}

function saveState(dataDir, state) {
  const p = statePath(dataDir);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, p);
}

function hasBin(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ── Detection ────────────────────────────────────────────────────────────

function detectSshSupport() {
  const platform = os.platform();
  const sshKeygen = hasBin('ssh-keygen');
  const ssh = hasBin('ssh');
  const sshd = hasBin('sshd');
  // v1 supports managed credentials on POSIX with ssh-keygen present.
  // Windows: detection + manual recipe only (no auto-install).
  const managed = platform !== 'win32' && sshKeygen;
  return { platform, ssh, sshKeygen, sshd, managed };
}

function isPortListening(port, host) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: host || '127.0.0.1' });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(800);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

async function sshListeningPorts(ports) {
  const out = {};
  for (const p of ports) {
    try { out[p] = await isPortListening(p); } catch { out[p] = false; }
  }
  return out;
}

function getLanIps() {
  // Container/bridge interfaces (docker0, br-*, veth pairs, libvirt) hold
  // addresses that are only reachable from inside the host itself — showing
  // them as "LAN" options is how a phone ends up dialling a dead 172.28.x.x.
  // Real VPN tunnels (tun/tap/wg/zt) are kept: peers can reach those.
  const VIRTUAL_IFACE_RE = /^(docker\d*|br-[a-f0-9]+|veth|virbr\d*|lxcbr\d*)/i;
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      if (VIRTUAL_IFACE_RE.test(name)) continue;
      for (const nic of ifs[name] || []) {
        if (nic.family === 'IPv4' && !nic.internal && nic.address) {
          out.push({ ip: nic.address, iface: name });
        }
      }
    }
  } catch {}
  return out;
}

function getTailscaleIp() {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const ip = String(stdout || '').trim().split('\n')[0].trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return resolve(ip);
      resolve(null);
    });
  });
}

function getHostFingerprints() {
  // Read-only: `ssh-keygen -l -f <host pubkey>`. Best effort — missing keys
  // or permissions just yield an empty list, never an error.
  const prints = [];
  if (os.platform() === 'win32') return prints;
  const candidates = [
    '/etc/ssh/ssh_host_ed25519_key.pub',
    '/etc/ssh/ssh_host_ecdsa_key.pub',
    '/etc/ssh/ssh_host_rsa_key.pub',
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const out = execFileSync('ssh-keygen', ['-l', '-f', f], { encoding: 'utf8', timeout: 5000 });
      const m = String(out).match(/^\s*\d+\s+(SHA256:\S+)\s+\S*\s*\((\S+)\)/);
      prints.push({
        file: f,
        fingerprint: m ? m[1] : String(out).trim().slice(0, 80),
        type: m ? m[2] : path.basename(f),
      });
    } catch {}
  }
  return prints;
}

function setupHint(platform, port) {
  // Copy-paste commands shown in the UI when sshd is not listening.
  // Never executed automatically — the user runs them explicitly.
  if (platform === 'darwin') {
    return [
      '# macOS: enable Remote Login (System Settings → General → Sharing → Remote Login),',
      `# then make sure sshd listens on ${port} (default is 22):`,
      `# sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist`,
    ].join('\n');
  }
  if (platform === 'win32') {
    return [
      '# Windows (admin PowerShell): install + start the built-in OpenSSH Server,',
      '# then allow your chosen port through the firewall:',
      '#   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
      '#   Start-Service sshd; Set-Service -Name sshd -StartupType Automatic',
      `#   New-NetFirewallRule -Name sshd-webtun -DisplayName 'WebTun SSH' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort ${port}`,
    ].join('\n');
  }
  return [
    '# Debian/Ubuntu: install + start OpenSSH, then listen on the WebTun port:',
    '#   sudo apt-get install -y openssh-server',
    '#   sudo systemctl enable --now ssh',
    `#   (sshd listens on 22 by default; use '-p ${port}' in clients or add 'Port ${port}' to sshd_config)`,
  ].join('\n');
}

async function getSshStatus(dataDir) {
  const sup = detectSshSupport();
  const st = loadState(dataDir);
  const expected = st.port || defaultPort();
  const ports = [...new Set([expected, 22])];
  // Probes are independent — run them together so one slow listener (or a
  // missing tailscale binary) can't serialize the whole status call.
  const [listening, tailscaleIp] = await Promise.all([
    sshListeningPorts(ports),
    getTailscaleIp(),
  ]);
  // The recipe port is the port the user can actually reach: the expected
  // port when it listens, else 22 when that listens, else the expected port
  // (with the setup hint shown so the user knows sshd still needs enabling).
  const effectivePort = listening[expected] ? expected : (listening[22] ? 22 : expected);
  const orphans = findOrphanedLines(st);
  return {
    supported: true,
    managed: sup.managed,
    platform: sup.platform,
    hasSshKeygen: sup.sshKeygen,
    hasSshd: sup.sshd,
    port: expected,
    effectivePort,
    listening,
    keyCount: st.credentials.length,
    maxKeys: MAX_KEYS,
    orphaned: orphans.length,
    user: currentUsername(),
    lanIps: getLanIps(),
    tailscaleIp,
    hostFingerprints: getHostFingerprints(),
    setupHint: setupHint(sup.platform, expected),
  };
}

// ── authorized_keys management (current user only) ───────────────────────

function userSshDir() {
  return path.join(os.homedir(), '.ssh');
}

function authorizedKeysPath() {
  return path.join(userSshDir(), 'authorized_keys');
}

function ensureSshDirModes() {
  const dir = userSshDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const ak = authorizedKeysPath();
  if (!fs.existsSync(ak)) {
    fs.writeFileSync(ak, '', { mode: 0o600 });
  }
  try { fs.chmodSync(ak, 0o600); } catch {}
  return ak;
}

function readAuthorizedKeys() {
  try {
    return fs.readFileSync(authorizedKeysPath(), 'utf8').split('\n');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

function writeAuthorizedKeys(lines) {
  const ak = ensureSshDirModes();
  const tmp = ak + '.tmp';
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(tmp, body.endsWith('\n') ? body : body + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, ak);
}

// Strict match: the tag must be the line's trailing comment token, not a
// substring anywhere in the line — a foreign key whose comment merely
// mentions a similar string must never count as managed.
function managedLineId(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const last = t.split(/\s+/).pop();
  if (last && last.startsWith(KEY_TAG_PREFIX) && /^[A-Za-z0-9:_-]{1,80}$/.test(last)) {
    return last.slice(KEY_TAG_PREFIX.length);
  }
  return null;
}

function isManagedLine(line, id) {
  const found = managedLineId(line);
  return found !== null && found === String(id);
}

// Managed lines in authorized_keys with no matching state entry — e.g. the
// state file was deleted, or a saveState write failed after install. Surfaced
// via status.orphaned and removable via cleanupOrphanedLines(); never touched
// by normal revoke (which only removes the revoked id).
function findOrphanedLines(state) {
  const known = new Set((state.credentials || []).map(c => String(c.id)));
  const orphans = [];
  for (const line of readAuthorizedKeys()) {
    const id = managedLineId(line);
    if (id && !known.has(id)) orphans.push(id);
  }
  return [...new Set(orphans)];
}

function cleanupOrphanedLines(dataDir) {
  const st = loadState(dataDir);
  const orphans = new Set(findOrphanedLines(st));
  if (orphans.size === 0) return { success: true, removedLines: 0, removed: 0 };
  const before = readAuthorizedKeys();
  const after = before.filter(l => {
    const id = managedLineId(l);
    return !(id && orphans.has(id));
  });
  writeAuthorizedKeys(after);
  return { success: true, removedLines: before.length - after.length, removed: orphans.size };
}

// ── Key lifecycle ────────────────────────────────────────────────────────

function validateLabel(label) {
  const s = String(label || '').trim().slice(0, 64);
  if (!s) throw Object.assign(new Error('Label required (e.g. "Termius on iPhone")'), { status: 400 });
  if (/[\r\n]/.test(s)) throw Object.assign(new Error('Label must be a single line'), { status: 400 });
  return s;
}

const ALLOWED_KEY_TYPES = new Set([
  'ssh-ed25519', 'sk-ssh-ed25519@openssh.com',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa',
]);

function fingerprintPublicKey(pubKeyLine) {
  const tmp = path.join(os.tmpdir(), `webtun-pub-${crypto.randomBytes(6).toString('hex')}.pub`);
  try {
    fs.writeFileSync(tmp, pubKeyLine + '\n', { mode: 0o600 });
    const out = execFileSync('ssh-keygen', ['-l', '-f', tmp], { encoding: 'utf8', timeout: 5000 });
    const m = String(out).match(/^\s*\d+\s+(SHA256:\S+)/);
    return m ? m[1] : String(out).trim().slice(0, 80);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function generateKeypair() {
  // No-shell `ssh-keygen` into a temp dir; private key is read back once and
  // the temp files are removed before returning.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtun-ssh-'));
  const keyPath = path.join(dir, 'id_ed25519');
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'webtun'], {
      timeout: 15000,
    });
    // Keep the trailing newline: OpenSSH's parser rejects a key file that
    // does not end with one ("not a key file" / libcrypto error), and CLI
    // `ssh -i` is the primary consumer of this value.
    const priv = fs.readFileSync(keyPath, 'utf8').trim() + '\n';
    const pubFull = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
    if (!priv.includes('OPENSSH PRIVATE KEY')) throw new Error('ssh-keygen produced an unexpected key format');
    const parts = pubFull.split(/\s+/);
    if (parts.length < 2 || !ALLOWED_KEY_TYPES.has(parts[0])) {
      throw new Error('ssh-keygen produced an unexpected public key type');
    }
    return { privateKey: priv, pubType: parts[0], pubB64: parts[1] };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function listCredentials(dataDir) {
  return loadState(dataDir).credentials.map(c => ({
    id: c.id, label: c.label, type: c.type,
    fingerprint: c.fingerprint, createdAt: c.createdAt, addedBy: c.addedBy || '',
  }));
}

// Creates a credential on demand: generates ed25519, installs the public
// half (tagged), persists public metadata, returns the private half ONCE.
// The caller (server route) must send `privateKey` to the client and never
// log or store it.
function createCredential(dataDir, { label, addedBy } = {}) {
  const sup = detectSshSupport();
  if (!sup.managed) {
    throw Object.assign(new Error('SSH key management is not supported on this platform yet — see the manual setup steps'), { status: 501 });
  }
  const cleanLabel = validateLabel(label);
  const st = loadState(dataDir);
  if (st.credentials.length >= MAX_KEYS) {
    throw Object.assign(new Error(`Key limit reached (${MAX_KEYS}) — revoke an unused key first`), { status: 400 });
  }
  const { privateKey, pubType, pubB64 } = generateKeypair();
  const id = crypto.randomBytes(8).toString('hex');
  const pubLine = `${pubType} ${pubB64} ${KEY_TAG_PREFIX}${id}`;
  const fingerprint = fingerprintPublicKey(pubLine);

  // Install: drop our tag if a stale line for this id somehow exists, then append.
  const lines = readAuthorizedKeys().filter(l => !(l && isManagedLine(l, id)));
  // The trailing-newline split leaves a '' tail; pop blank tails before
  // appending so repeated create/revoke cycles can't stack blank lines.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.some(l => l.trim() === pubLine)) {
    lines.push(pubLine);
  }
  writeAuthorizedKeys(lines);

  st.credentials.push({
    id, label: cleanLabel, type: pubType, publicKey: pubLine,
    fingerprint, createdAt: Date.now(), addedBy: String(addedBy || ''),
  });
  // Persist AFTER install; on failure roll the installed line back so a key
  // is never live-but-untracked (untracked lines are only recoverable via
  // the orphan cleanup, so don't create them in the first place).
  try {
    saveState(dataDir, st);
  } catch (e) {
    try {
      writeAuthorizedKeys(readAuthorizedKeys().filter(l => !(l && isManagedLine(l, id))));
    } catch {}
    throw e;
  }

  const expected = st.port || defaultPort();
  return {
    id, label: cleanLabel, type: pubType, fingerprint,
    privateKey, // ONCE — never persisted
    publicKey: pubLine,
    port: expected,
    username: currentUsername(),
  };
}

function revokeCredential(dataDir, id) {
  const clean = String(id || '').trim();
  if (!/^[0-9a-f]{4,64}$/i.test(clean)) {
    throw Object.assign(new Error('Unknown key id'), { status: 404 });
  }
  const st = loadState(dataDir);
  const idx = st.credentials.findIndex(c => c.id === clean);
  if (idx === -1) throw Object.assign(new Error('Unknown key id'), { status: 404 });
  // Remove managed lines for this id only; foreign entries are untouched.
  const before = readAuthorizedKeys();
  const after = before.filter(l => !(l && isManagedLine(l, clean)));
  const removedLines = before.length - after.length;
  writeAuthorizedKeys(after);
  const [removed] = st.credentials.splice(idx, 1);
  saveState(dataDir, st);
  return { success: true, removedLines, label: removed.label };
}

module.exports = {
  getSshStatus,
  listCredentials,
  createCredential,
  revokeCredential,
  cleanupOrphanedLines,
  setExpectedPort,
  detectSshSupport,
  defaultPort,
  MAX_KEYS,
  // Shared with lib/ssh-setup.js (state lives here; one read/write path).
  _loadState: loadState,
  _saveState: saveState,
};

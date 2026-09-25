'use strict';

// Shared cloudflared discovery + on-demand installer.
//
// Supply-chain hygiene: nothing here runs at `npm install` time. The binary
// used to be fetched by the old postinstall.js on every install; it is now fetched
// only on first tunnel use — an explicit user action ("Create" tunnel button
// or `webtun --tunnel`) — from the official Cloudflare releases host over
// HTTPS only. Callers: server.js (tunnel API), bin/webtun.js (--tunnel),
// scripts/rebuild-pty.js (presence check message only, no download).

const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const CF_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
// Package root (this file lives in <pkg>/lib/).
const PKG_ROOT = path.join(__dirname, '..');

// Where the binary is allowed to come FROM. Cloudflare's release assets are
// served by GitHub, and redirects used to be followed to any host whatsoever —
// a hijacked redirect turned into "download an arbitrary executable, chmod +x
// it, spawn it". Suffix matching requires the dot, so evilcloudflare.com fails.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com', 'objects.githubusercontent.com', 'codeload.github.com',
  'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com',
  'cloudflare.com', 'www.cloudflare.com', 'developers.cloudflare.com',
  'pkg.cloudflare.com', 'update.equinox.io', 'bin.equinox.io'
]);
function isAllowedDownloadHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (ALLOWED_DOWNLOAD_HOSTS.has(h)) return true;
  return h.endsWith('.githubusercontent.com') || h.endsWith('.cloudflare.com') || h.endsWith('.github.com');
}
// Hard ceiling for the download (the real binary is ~35MB).
const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// A candidate is only usable if it is a regular file we can actually execute,
// and (POSIX) not world-writable — a world-writable binary is trivially
// replaceable by any local user, and we spawn it with the user's privileges.
function isUsableBinary(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (os.platform() === 'win32') return true;
    if (!(st.mode & 0o111)) return false;
    if (st.mode & 0o002) return false;
    return true;
  } catch { return false; }
}

function findCloudflared() {
  const isWin = os.platform() === 'win32';
  const name = isWin ? 'cloudflared.exe' : 'cloudflared';
  // Order matters: canonical install locations FIRST, then PATH. The package
  // directory and process.cwd() are deliberately NEVER candidates: with
  // full-FS access the File API can plant ./cloudflared, and warn-then-exec
  // still spawned the hijacked binary (CWD-hijack RCE). Self-installed copies
  // land in the user-local bin / system paths above via downloadCloudflared —
  // if nothing is found there, the caller downloads from the official host.
  const candidates = [];
  if (isWin) {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const pf = process.env.ProgramW6432 || process.env.ProgramFiles;
    if (pf) candidates.push(path.join(pf, 'cloudflared', name));
    candidates.push(path.join(localApp, 'cloudflared', name));
  } else {
    candidates.push('/usr/local/bin/' + name);
    candidates.push('/usr/bin/' + name);
    candidates.push(path.join(os.homedir(), '.local', 'bin', name));
  }
  // Self-installed copies are covered by the user-local bin / system paths
  // above (that is where downloadCloudflared installs them) — never the
  // package dir or cwd.
  for (const c of candidates) {
    if (!isUsableBinary(c)) continue;
    return c;
  }
  try {
    const cmd = isWin ? 'where cloudflared' : 'command -v cloudflared';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim().split(/\r?\n/)[0];
    if (out && isUsableBinary(out)) return out;
  } catch {}
  return null;
}

function downloadFile(downloadUrl, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(downloadUrl); } catch { return reject(new Error('invalid download URL')); }
    // HTTPS only — refuse protocol downgrades on every redirect hop.
    if (u.protocol !== 'https:') return reject(new Error('refusing non-HTTPS download URL'));
    if (!isAllowedDownloadHost(u.hostname)) return reject(new Error('refusing download from untrusted host: ' + u.hostname));
    if (redirects > MAX_REDIRECTS) return reject(new Error('too many redirects'));
    const req = https.get(downloadUrl, { headers: { 'User-Agent': 'webtun' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, downloadUrl).toString(); } catch { return reject(new Error('invalid redirect target')); }
        return downloadFile(next, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      // Size guard before writing anything: an oversized (or lying) response
      // must not fill the disk while we wait for `finish`.
      const declared = Number(res.headers['content-length'] || 0);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        res.resume();
        return reject(new Error('download larger than ' + MAX_DOWNLOAD_BYTES + ' bytes'));
      }
      const out = fs.createWriteStream(dest);
      let received = 0;
      let aborted = false;
      res.on('data', chunk => {        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES && !aborted) {
          aborted = true;
          try { res.destroy(); } catch {}
          try { out.destroy(); } catch {}
          try { fs.unlinkSync(dest); } catch {}
          reject(new Error('download exceeded ' + MAX_DOWNLOAD_BYTES + ' bytes'));
        }
      });
      res.pipe(out);
      // A response-stream error after headers must reject promptly (and clean
      // up the partial file) instead of hanging until the idle timeout.
      res.on('error', e => {
        if (aborted) return;
        aborted = true;
        try { out.destroy(); } catch {}
        try { fs.unlinkSync(dest); } catch {}
        reject(e);
      });
      out.on('finish', () => out.close(err => err ? reject(err) : resolve()));
      out.on('error', e => { if (!aborted) reject(e); });
    });
    req.on('error', reject);
    // Idle (not total) timeout: activity resets it, so a stalled transfer is
    // dropped instead of hanging forever. Retries live in downloadCloudflared.
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('download stalled (60s with no data)'));
    });
  });
}

// Two retries with backoff — a flaky mirror/asset CDN used to fail the whole
// one-time setup on a single hiccup.
async function downloadWithRetries(url, dest, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await downloadFile(url, dest);
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(dest); } catch {}
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr || new Error('download failed');
}

const CF_DOWNLOAD_DOCS = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

// Ordered candidate list: the first asset is tried, and a 404 falls through to
// the next. Windows/arm64 prefers the native build and falls back to the amd64
// binary (which runs under Windows' x64 emulation) when it is not published.
function platformFiles() {
  const platform = os.platform();
  const arch = os.arch();
  const files = {
    linux:   { x64: ['cloudflared-linux-amd64'], arm64: ['cloudflared-linux-arm64'], arm: ['cloudflared-linux-arm'] },
    darwin:  { x64: ['cloudflared-darwin-amd64.tgz'], arm64: ['cloudflared-darwin-arm64.tgz'] },
    win32:   { x64: ['cloudflared-windows-amd64.exe'], arm64: ['cloudflared-windows-arm64.exe', 'cloudflared-windows-amd64.exe'] }
  };
  return { platform, files: (files[platform] || {})[arch] || [] };
}


function preferredDest(platform) {
  const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  if (platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localApp, 'cloudflared', name);
  }
  return path.join(os.homedir(), '.local', 'bin', name);
}

async function downloadCloudflared(onProgress) {
  const { platform, files } = platformFiles();
  if (!files.length) {
    throw new Error(`unsupported platform/arch (${os.platform()}/${os.arch()}) for cloudflared auto-install — install it manually: ${CF_DOWNLOAD_DOCS}`);
  }
  const say = msg => { try { if (onProgress) onProgress(msg); } catch {} };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtun-'));
  const tmp = path.join(tmpDir, 'cloudflared' + (platform === 'win32' ? '.exe' : ''));
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

  try {
    say('downloading cloudflared (one-time setup)…');
    // Walk the candidate list: a platform whose preferred asset is missing gets a
    // clear "tried everything" error instead of an opaque 404.
    let lastDownloadErr = null;
    for (const candidate of files) {
      try {
        await downloadWithRetries(CF_RELEASES + '/' + candidate, tmp);
        lastDownloadErr = null;
        break;
      } catch (e) {
        lastDownloadErr = e;
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    if (lastDownloadErr) {
      throw new Error(`could not download cloudflared for ${os.platform()}/${os.arch()} (tried ${files.join(', ')}) — install it manually: ${CF_DOWNLOAD_DOCS}`);
    }

    // Positive validation instead of "does it start with <html". The old check
    // let a JSON/XML/comment-prefixed error page through, which was then
    // chmod 755'd and spawned.
    const dlSize = fs.statSync(tmp).size;
    if (dlSize < 2 * 1024 * 1024) throw new Error('downloaded file is too small to be cloudflared (' + dlSize + ' bytes)');
    const fd = fs.openSync(tmp, 'r');
    const buf = Buffer.alloc(4);
    let head4 = null, headText = '';
    try {
      const n = fs.readSync(fd, buf, 0, 4, 0);
      if (n >= 4) head4 = buf.slice(0, 4);
      const textBuf = Buffer.alloc(1024);
      const tn = fs.readSync(fd, textBuf, 0, 1024, 0);
      headText = textBuf.slice(0, tn).toString('utf8').trim();
    } finally { try { fs.closeSync(fd); } catch {} }
    if (!head4) throw new Error('downloaded file is empty');
    const isElf = head4[0] === 0x7f && head4[1] === 0x45 && head4[2] === 0x4c && head4[3] === 0x46;
    const isMz = head4[0] === 0x4d && head4[1] === 0x5a;
    const isGzip = head4[0] === 0x1f && head4[1] === 0x8b;                 // darwin ships a .tgz
    const isMachO = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(head4.readUInt32BE(0));
    const looksLikeText = /^[<{[]/.test(headText) || /^<!doctype/i.test(headText);
    const okBinary = platform === 'win32' ? isMz
      : platform === 'darwin' ? (isMachO || isGzip)
      : isElf;
    if (looksLikeText || !okBinary) {
      throw new Error('downloaded file is not a cloudflared binary (bad magic bytes)');
    }

    let src = tmp;
    // Content hash, computed once over the downloaded bytes: logged so an
    // admin can pin it, and enforced when CLOUDFLARED_SHA256 is set.
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
    say('download sha256: ' + digest);
    const pinned = (process.env.CLOUDFLARED_SHA256 || '').trim().toLowerCase();
    if (pinned && pinned !== digest) {
      throw new Error('cloudflared checksum mismatch (CLOUDFLARED_SHA256 pin) — refusing to install');
    }
    if (platform === 'darwin') {
      const list = spawnSync('tar', ['tvzf', tmp], { encoding: 'utf8', timeout: 10000 });
      // An empty listing with status 0 used to skip validation entirely and
      // extract unchecked. Require a non-empty, validated listing.
      if (!list.stdout || !String(list.stdout).trim()) {
        throw new Error('tar list failed: empty archive listing');
      }
      validateTarListing(list.stdout);
      if (list.status !== 0) {
        throw new Error('tar list failed: ' + (list.stderr ? list.stderr.toString().trim() : 'unknown error'));
      }
      const result = spawnSync('tar', ['xzf', tmp, '-C', tmpDir], { stdio: 'pipe', timeout: 30000 });
      if (result.status !== 0) throw new Error('tar extraction failed: ' + (result.stderr ? result.stderr.toString().trim() : 'unknown'));
      try { fs.unlinkSync(tmp); } catch {}
      src = path.join(tmpDir, 'cloudflared');
      // Belt and braces: whatever tar decided to do, the binary we are about to
      // chmod +x and run must really resolve inside the temp directory.
      if (!fs.existsSync(src)) throw new Error('archive did not contain a cloudflared binary');
      const realTmp = fs.realpathSync(tmpDir);
      const realSrc = fs.realpathSync(src);
      if (realSrc !== realTmp && !realSrc.startsWith(realTmp + path.sep)) {
        throw new Error('tar extraction escaped the temp directory');
      }
    }

    const installBin = (from, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Never follow a pre-existing symlink at the destination: an attacker-
      // planted link would redirect the install (and its chmod) elsewhere.
      try {
        if (fs.lstatSync(dest).isSymbolicLink()) {
          throw new Error('refusing to install over symlink: ' + dest);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      try {
        fs.renameSync(from, dest);
      } catch (e) {
        if (e.code === 'EXDEV') {
          fs.copyFileSync(from, dest);
          try { fs.unlinkSync(from); } catch {}
        } else {
          throw e;
        }
      }
      try { fs.chmodSync(dest, 0o755); } catch {}
    };

    // Prefer user-local path (no admin), then package dir, then system.
    // Packaged Electron runs from read-only app.asar: never attempt the
    // package-dir destination there (it can only fail — the user-local path
    // wins first in practice, but don't rely on luck).
    const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const inAsarPkg = String(PKG_ROOT).includes('app.asar');
    const dests = [preferredDest(platform)];
    if (!inAsarPkg) dests.push(path.join(PKG_ROOT, name));
    if (platform !== 'win32') dests.push('/usr/local/bin/cloudflared');
    else {
      const pf = process.env.ProgramW6432 || process.env.ProgramFiles;
      if (pf) dests.push(path.join(pf, 'cloudflared', 'cloudflared.exe'));
    }

    let installed = null;
    let lastErr = null;
    for (const dest of dests) {
      try {
        installBin(src, dest);
        installed = dest;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!installed) throw new Error('install failed: ' + (lastErr && lastErr.message));
    say('cloudflared installed → ' + installed);
    return installed;
  } finally {
    cleanup();
  }
}

// Single-flight: concurrent callers share one download.
let _inflight = null;
function ensureCloudflared(onProgress) {
  const found = findCloudflared();
  if (found) return Promise.resolve(found);
  if (!_inflight) {
    _inflight = downloadCloudflared(onProgress)
      .then(() => findCloudflared() || Promise.reject(new Error('cloudflared install did not produce a binary')))
      .finally(() => { _inflight = null; });
  }
  return _inflight;
}

// Rejects tar listings that could escape the extraction directory. The listing
// must come from `tar tvzf` (verbose, so the first column carries the entry
// mode): `l`/`h` are symlink/hardlink members, and a symlink is exactly how an
// otherwise innocent-looking member name still writes outside the temp dir.
// Also catches the path forms `tar x` would accept but we never want: `\\`,
// `~`, drive-letter and percent-encoded traversal. Exported for tests.
function validateTarListing(listOutput) {
  for (const raw of String(listOutput || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === 'l' || line[0] === 'h') {
      throw new Error('tar slip detected: archive contains a link entry');
    }
    const m = line.match(/\s(\S+)$/);
    const entry = (m ? m[1] : '').replace(/^\.\//, '');
    if (!entry) continue;
    if (entry.includes('..') || path.isAbsolute(entry) || entry.startsWith('/') ||
        entry.includes('\\') || entry.startsWith('~') || /^[a-z]:/i.test(entry) ||
        /%2e%2e/i.test(entry)) {
      throw new Error('tar slip detected: invalid entry ' + entry);
    }
  }
}

module.exports = { findCloudflared, ensureCloudflared, validateTarListing };

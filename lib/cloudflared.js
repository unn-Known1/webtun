'use strict';

// Shared cloudflared discovery + on-demand installer.
//
// Supply-chain hygiene: nothing here runs at `npm install` time. The binary
// used to be fetched by postinstall.js on every install; it is now fetched
// only on first tunnel use — an explicit user action ("Create" tunnel button
// or `webtun --tunnel`) — from the official Cloudflare releases host over
// HTTPS only. Callers: server.js (tunnel API), bin/webtun.js (--tunnel),
// postinstall.js (presence check message only, no download).

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const CF_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
// Package root (this file lives in <pkg>/lib/).
const PKG_ROOT = path.join(__dirname, '..');

function findCloudflared() {
  const isWin = os.platform() === 'win32';
  const name = isWin ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [
    path.join(PKG_ROOT, name),
    path.join(process.cwd(), name),
  ];
  if (isWin) {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localApp, 'cloudflared', name));
    const pf = process.env.ProgramW6432 || process.env.ProgramFiles;
    if (pf) candidates.push(path.join(pf, 'cloudflared', name));
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', name));
    candidates.push('/usr/local/bin/' + name);
    candidates.push('/usr/bin/' + name);
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  try {
    const cmd = isWin ? 'where cloudflared' : 'command -v cloudflared';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return null;
}

function downloadFile(downloadUrl, dest) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(downloadUrl); } catch { return reject(new Error('invalid download URL')); }
    // HTTPS only — refuse protocol downgrades on every redirect hop.
    if (u.protocol !== 'https:') return reject(new Error('refusing non-HTTPS download URL'));
    const req = https.get(downloadUrl, { headers: { 'User-Agent': 'webtun' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(err => err ? reject(err) : resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('download timeout'));
    });
  });
}

function platformFile() {
  const platform = os.platform();
  const arch = os.arch();
  const files = {
    linux:   { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm' },
    darwin:  { x64: 'cloudflared-darwin-amd64.tgz', arm64: 'cloudflared-darwin-arm64.tgz' },
    win32:   { x64: 'cloudflared-windows-amd64.exe', arm64: 'cloudflared-windows-amd64.exe' }
  };
  return { platform, file: (files[platform] || {})[arch] };
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
  const { platform, file } = platformFile();
  if (!file) throw new Error('unsupported platform/arch for cloudflared auto-install');
  const say = msg => { try { if (onProgress) onProgress(msg); } catch {} };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtun-'));
  const tmp = path.join(tmpDir, 'cloudflared' + (platform === 'win32' ? '.exe' : ''));
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

  try {
    say('downloading cloudflared (one-time setup)…');
    await downloadFile(CF_RELEASES + '/' + file, tmp);

    // Validate the download is a binary, not an HTML error page.
    const fd = fs.openSync(tmp, 'r');
    const buf = Buffer.alloc(1024);
    let head = '';
    try {
      const n = fs.readSync(fd, buf, 0, 1024, 0);
      head = buf.slice(0, n).toString('utf8').trim();
    } finally { try { fs.closeSync(fd); } catch {} }
    if (/^<!doctype\s+html/i.test(head) || /^<html/i.test(head)) {
      throw new Error('downloaded file is not a binary');
    }

    let src = tmp;
    if (platform === 'darwin') {
      // Validate tar entries to prevent tar slip (filter .. and absolute paths).
      const list = spawnSync('tar', ['tzf', tmp], { encoding: 'utf8', timeout: 10000 });
      if (list.stdout) {
        const entries = list.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        for (const entry of entries) {
          if (entry.includes('..') || path.isAbsolute(entry) || entry.startsWith('/')) {
            throw new Error('tar slip detected: invalid entry ' + entry);
          }
        }
      } else if (list.status !== 0) {
        throw new Error('tar list failed: ' + (list.stderr ? list.stderr.toString().trim() : 'unknown error'));
      }
      const result = spawnSync('tar', ['xzf', tmp, '-C', tmpDir], { stdio: 'pipe', timeout: 30000 });
      if (result.status !== 0) throw new Error('tar extraction failed: ' + (result.stderr ? result.stderr.toString().trim() : 'unknown'));
      try { fs.unlinkSync(tmp); } catch {}
      src = path.join(tmpDir, 'cloudflared');
    }

    const installBin = (from, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
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
    const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const dests = [preferredDest(platform), path.join(PKG_ROOT, name)];
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

module.exports = { findCloudflared, ensureCloudflared };

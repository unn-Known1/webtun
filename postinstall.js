const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CF_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

try {
  if (os.platform() === 'win32') {
    execSync('where cloudflared', { stdio: 'ignore' });
  } else {
    execSync('command -v cloudflared', { stdio: 'ignore' });
  }
  process.exit(0);
} catch {}

const platform = os.platform();
const arch = os.arch();

const files = {
  linux:   { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm' },
  darwin:  { x64: 'cloudflared-darwin-amd64.tgz', arm64: 'cloudflared-darwin-arm64.tgz' },
  win32:   { x64: 'cloudflared-windows-amd64.exe' }
};

const file = (files[platform] || {})[arch];
if (!file) process.exit(0);

console.log('  installing cloudflared...');

const url = CF_RELEASES + '/' + file;
const tmpDir = os.tmpdir();
const tmp = path.join(tmpDir, 'cloudflared-' + process.pid + (platform === 'win32' ? '.exe' : ''));
const tmpExtracted = path.join(tmpDir, 'cloudflared-' + process.pid + '-bin' + (platform === 'win32' ? '.exe' : ''));

function cleanup() {
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.unlinkSync(tmpExtracted); } catch {}
}

function download() {
  const r = spawnSync('curl', ['-#fL', url, '-o', tmp], { stdio: 'inherit', timeout: 60000 });
  if (r.status === 0) return true;
  const r2 = spawnSync('wget', ['-q', url, '-O', tmp], { stdio: 'inherit', timeout: 60000 });
  return r2.status === 0;
}

if (!download()) {
  console.log('  cloudflared install failed (download error) — skipping');
  cleanup();
  process.exit(0);
}

// Validate downloaded file is not HTML (e.g. 404 page)
try {
  const buf = Buffer.alloc(1024);
  const fd = fs.openSync(tmp, 'r');
  const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
  fs.closeSync(fd);
  const head = buf.slice(0, bytesRead).toString('utf8').trim();
  if (/^<!doctype\s+html/i.test(head) || /^<html/i.test(head)) {
    console.log('  cloudflared install failed (downloaded file is not a binary) — skipping');
    cleanup();
    process.exit(0);
  }
} catch (e) {
  console.log('  cloudflared install failed (cannot validate download): ' + e.message);
  cleanup();
  process.exit(0);
}

function installBin(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      try { fs.unlinkSync(src); } catch {}
    } else {
      throw e;
    }
  }
  // Always set executable bit regardless of rename or copy path
  try { fs.chmodSync(dest, 0o755); } catch {}
}

try {
  if (platform === 'darwin') {
    const result = spawnSync('tar', ['xzf', tmp, '-C', tmpDir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('tar extraction failed');
    installBin(path.join(tmpDir, 'cloudflared'), '/usr/local/bin/cloudflared');
    try { fs.unlinkSync(tmp); } catch {}
  } else if (platform === 'win32') {
    const progFiles = process.env.ProgramW6432 || process.env.ProgramFiles || (process.env.SystemRoot + '\\Program Files');
    const dest = path.join(progFiles, 'cloudflared', 'cloudflared.exe');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    installBin(tmp, dest);
  } else {
    installBin(tmp, '/usr/local/bin/cloudflared');
  }
  console.log('  cloudflared installed');
  cleanup();
} catch (e) {
  // When installed globally via npm, /usr/local/bin may not be writable.
  // In that case, download to a local path and suggest manual install.
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    const localDest = path.join(process.cwd(), 'cloudflared' + (platform === 'win32' ? '.exe' : ''));
    try {
      installBin(tmp, localDest);
      console.log('  cloudflared installed to ' + localDest);
      console.log('  Move it to your PATH: sudo mv ' + localDest + ' /usr/local/bin/');
    } catch (e2) {
      console.log('  cloudflared install failed: ' + e2.message + ' — skipping');
    }
  } else {
    console.log('  cloudflared install failed: ' + e.message + ' — skipping');
  }
  cleanup();
  process.exit(0);
}

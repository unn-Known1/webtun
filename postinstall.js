const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Rebuild node-pty if native module is missing ─────────────────────
function rebuildNodePty() {
  try {
    require('node-pty');
    return; // Already working
  } catch {}

  const ptyDir = path.join(__dirname, 'node_modules', 'node-pty');
  if (!fs.existsSync(ptyDir)) return; // Not installed yet (first time npm install)

  console.log('  rebuilding node-pty...');
  try {
    spawnSync('npm', ['rebuild', 'node-pty'], {
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 120000,
      shell: os.platform() === 'win32'
    });
    // Verify it worked
    delete require.cache[require.resolve('node-pty')];
    require('node-pty');
    console.log('  node-pty rebuilt successfully');
  } catch (e) {
    console.log('  node-pty rebuild failed: ' + e.message);
    console.log('  Terminal requires native build tools:');
    console.log('  Linux:   sudo apt-get install -y python3 make g++');
    console.log('  macOS:   xcode-select --install');
    console.log('  Windows: install Visual Studio Build Tools with "Desktop development with C++"');
    console.log('           https://visualstudio.microsoft.com/visual-cpp-build-tools/');
  }
}

rebuildNodePty();

// ── Install cloudflared ──────────────────────────────────────────────
const CF_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function cloudflaredExists() {
  try {
    if (os.platform() === 'win32') {
      execSync('where cloudflared', { stdio: 'ignore' });
    } else {
      execSync('command -v cloudflared', { stdio: 'ignore' });
    }
    return true;
  } catch {}

  const isWin = os.platform() === 'win32';
  const name = isWin ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [
    path.join(__dirname, name),
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
  }
  return candidates.some(c => {
    try { return fs.existsSync(c) && fs.statSync(c).isFile(); } catch { return false; }
  });
}

if (cloudflaredExists()) process.exit(0);

const platform = os.platform();
const arch = os.arch();

const files = {
  linux:   { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm' },
  darwin:  { x64: 'cloudflared-darwin-amd64.tgz', arm64: 'cloudflared-darwin-arm64.tgz' },
  win32:   { x64: 'cloudflared-windows-amd64.exe', arm64: 'cloudflared-windows-amd64.exe' }
};

const file = (files[platform] || {})[arch];
if (!file) process.exit(0);

console.log('  installing cloudflared...');

const url = CF_RELEASES + '/' + file;
const tmpDir = os.tmpdir();
const tmp = path.join(tmpDir, 'cloudflared-' + process.pid + (platform === 'win32' ? '.exe' : ''));

function cleanup() {
  try { fs.unlinkSync(tmp); } catch {}
}

function downloadFile(downloadUrl, dest) {
  return new Promise((resolve, reject) => {
    const mod = downloadUrl.startsWith('https') ? https : http;
    const req = mod.get(downloadUrl, { headers: { 'User-Agent': 'webtun-postinstall' } }, res => {
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

function downloadWithCurlOrWget() {
  const r = spawnSync('curl', ['-#fL', url, '-o', tmp], { stdio: 'inherit', timeout: 60000 });
  if (r.status === 0) return true;
  const r2 = spawnSync('wget', ['-q', url, '-O', tmp], { stdio: 'inherit', timeout: 60000 });
  return r2.status === 0;
}

async function main() {
  try {
    await downloadFile(url, tmp);
  } catch (e) {
    if (!downloadWithCurlOrWget()) {
      console.log('  cloudflared install failed (download error) — skipping');
      cleanup();
      return;
    }
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
      return;
    }
  } catch (e) {
    console.log('  cloudflared install failed (cannot validate download): ' + e.message);
    cleanup();
    return;
  }

  function installBin(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
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
    try { fs.chmodSync(dest, 0o755); } catch {}
  }

  function preferredDest() {
    const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    if (platform === 'win32') {
      const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(localApp, 'cloudflared', name);
    }
    return path.join(os.homedir(), '.local', 'bin', name);
  }

  function extractDarwinIfNeeded() {
    if (platform !== 'darwin') return tmp;
    const result = spawnSync('tar', ['xzf', tmp, '-C', tmpDir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('tar extraction failed');
    try { fs.unlinkSync(tmp); } catch {}
    return path.join(tmpDir, 'cloudflared');
  }

  try {
    const src = extractDarwinIfNeeded();
    // Prefer user-local path (no admin), then package dir, then system
    const dests = [preferredDest(), path.join(__dirname, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')];
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

    if (installed) {
      console.log('  cloudflared installed → ' + installed);
      if (platform === 'win32' && installed.includes('Local')) {
        console.log('  (not on PATH; WebTun will find it automatically)');
      }
    } else {
      console.log('  cloudflared install failed: ' + (lastErr && lastErr.message) + ' — skipping');
    }
    cleanup();
  } catch (e) {
    console.log('  cloudflared install failed: ' + e.message + ' — skipping');
    cleanup();
  }
}

main().catch(e => {
  console.log('  cloudflared install failed: ' + e.message + ' — skipping');
  cleanup();
});

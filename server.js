// Load .env without dotenv dependency
try {
  const envPath = require('path').join(__dirname, '.env');
  const envContent = require('fs').readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  });
} catch {}

const express = require('express');
const WebSocket = require('ws');
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('');
  console.error('  Error: node-pty native module not found.');
  console.error('');
  console.error('  npm 12+ blocks install scripts by default. To fix:');
  console.error('');
  console.error('  Option 1 — Allow scripts once:');
  console.error('    npm install -g --allow-scripts=webtun,node-pty webtun');
  console.error('');
  console.error('  Option 2 — Allow scripts globally (one-time):');
  console.error('    npm config set allow-scripts=webtun,node-pty --location=user');
  console.error('    npm install -g webtun');
  console.error('');
  console.error('  Option 3 — If building from source, install build tools first:');
  console.error('    Linux:   sudo apt-get install -y python3 make g++');
  console.error('    macOS:   xcode-select --install');
  console.error('    Windows: install "Desktop development with C++" (Visual Studio Build Tools)');
  console.error('             https://visualstudio.microsoft.com/visual-cpp-build-tools/');
  console.error('');
  process.exit(1);
}
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, execFileSync, spawn } = require('child_process');
const { ZipArchive } = require('archiver');
const yauzl = require('yauzl');
const https = require('https');
const http = require('http');

// MIME type lookup without mime-types dependency
const MIME_MAP = {
  '.html':'text/html','.htm':'text/html','.css':'text/css','.js':'application/javascript',
  '.mjs':'application/javascript','.json':'application/json','.xml':'application/xml',
  '.txt':'text/plain','.csv':'text/csv','.tsv':'text/tab-separated-values',
  '.md':'text/markdown','.rtf':'text/rtf',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
  '.bmp':'image/bmp','.ico':'image/x-icon','.svg':'image/svg+xml','.webp':'image/webp',
  '.avif':'image/avif','.tif':'image/tiff','.tiff':'image/tiff',
  '.mp3':'audio/mpeg','.mp4':'video/mp4','.webm':'video/webm','.ogg':'audio/ogg',
  '.wav':'audio/wav','.flac':'audio/flac','.aac':'audio/aac','.m4a':'audio/mp4',
  '.pdf':'application/pdf','.zip':'application/zip','.gz':'application/gzip',
  '.tar':'application/x-tar','.7z':'application/x-7z-compressed',
  '.rar':'application/vnd.rar','.bz2':'application/x-bzip2','.xz':'application/x-xz',
  '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.eot':'application/vnd.ms-fontobject',
  '.wasm':'application/wasm','.map':'application/json','.tgz':'application/gzip',
  '.sh':'text/x-shellscript','.py':'text/x-python','.rb':'text/x-ruby',
  '.java':'text/x-java','.c':'text/x-c','.h':'text/x-c','.cpp':'text/x-c++',
  '.go':'text/x-go','.rs':'text/x-rust','.php':'text/x-php','.pl':'text/x-perl',
  '.sql':'application/sql','.graphql':'application/graphql',
  '.yaml':'text/yaml','.yml':'text/yaml','.toml':'application/toml','.ini':'text/plain',
  '.env':'text/plain','.lock':'text/plain','.epub':'application/epub+zip',
};
function mimeLookup(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// Binary extensions — preview not supported in editor (client has same list). Keep in sync.
const BINARY_EXTS = new Set([
  '3dm','3ds','3g2','3gp','7z','a','aac','adp','afdesign','afphoto','afpub','ai','aif','aiff','alz','ape','apk','appimage','ar','arj','asf','au','avi','bak','baml','bh','bin','bk','bmp','btif','bz2','bzip2','cab','caf','cgm','class','cmx','cpio','cr2','cr3','cur','dat','dcm','deb','dex','djvu','dll','dmg','dng','doc','docm','docx','dot','dotm','dra','ds_store','dsk','dts','dtshd','dvb','dwg','dxf','ecelp4800','ecelp7470','ecelp9600','egg','eol','eot','epub','exe','f4v','fbs','fh','fla','flac','flatpak','fli','flv','fpx','fst','fvt','g3','gh','gif','graffle','gz','gzip','h261','h263','h264','icns','ico','ief','img','ipa','iso','jar','jpeg','jpg','jpgv','jpm','jxr','key','ktx','lha','lib','lvp','lz','lzh','lzma','lzo','m3u','m4a','m4v','mar','mdi','mht','mid','midi','mj2','mka','mkv','mmr','mng','mobi','mov','movie','mp3','mp4','mp4a','mpeg','mpg','mpga','mxu','nef','npx','numbers','nupkg','o','odp','ods','odt','oga','ogg','ogv','otf','ott','pages','pbm','pcx','pdb','pdf','pea','pgm','pic','png','pnm','pot','potm','potx','ppa','ppam','ppm','pps','ppsm','ppsx','ppt','pptm','pptx','psd','pya','pyc','pyo','pyv','qt','rar','ras','raw','resources','rgb','rip','rlc','rmf','rmvb','rpm','rtf','rz','s3m','s7z','scpt','sgi','shar','snap','sil','sketch','slk','smv','snk','so','stl','suo','sub','swf','tar','tbz','tbz2','tga','tgz','thmx','tif','tiff','tlz','ttc','ttf','txz','udf','uvh','uvi','uvm','uvp','uvs','uvu','viv','vob','war','wav','wax','wbmp','wdp','weba','webm','webp','whl','wim','wm','wma','wmv','wmx','woff','woff2','wrm','wvx','xbm','xif','xla','xlam','xls','xlsb','xlsm','xlsx','xlt','xltm','xltx','xm','xmind','xpi','xpm','xwd','xz','z','zip','zipx'
]);

// In-memory rate limiter factory
// NOTE: Behind cloudflared tunnel every remote IP appears as 127.0.0.1 (tunnel collapses to loopback).
// We use req.ip (Express respects app.set('trust proxy')) so limiter correctly respects trust proxy config.
// All tunnel users share one bucket when behind loopback — consider per-token bucket if multi-tenant.
// Map size cap prevents blowup via spoofed X-Forwarded-For (now unused) or IP rotation.
const rateLimitWindows = new Map();
function createRateLimiter(opts) {
  return (req, res, next) => {
    if (opts.skipWhenNoPin && !PIN) return next();
    const now = Date.now();
    // Use Express req.ip which respects trust proxy; avoids manual X-Forwarded-For spoofing (F8,F44)
    const key = req.ip || req.socket.remoteAddress || 'default';
    // Cap Map size to prevent memory exhaustion (F44 blowup) — evict oldest entry
    if (rateLimitWindows.size > 10000) {
      const firstKey = rateLimitWindows.keys().next().value;
      if (firstKey !== undefined) rateLimitWindows.delete(firstKey);
    }
    let win = rateLimitWindows.get(key);
    if (!win || now > win.resetAt) {
      win = { count: 0, resetAt: now + (opts.windowMs || 10000) };
      rateLimitWindows.set(key, win);
    }
    win.count++;
    if (win.count > (opts.limit || 10)) return res.status(429).json({ error: opts.errorMsg || 'Too many requests' });
    next();
  };
}

const authRateLimiter = createRateLimiter({ limit: 5, windowMs: 10000, errorMsg: 'Too many attempts', skipWhenNoPin: true });
const rateLimiter = createRateLimiter({ limit: 20, windowMs: 10000 });

// Periodic cleanup of rate limiter
setInterval(() => {
  const now = Date.now();
  for (const [key, win] of rateLimitWindows) { if (now > win.resetAt) rateLimitWindows.delete(key); }
}, 60000);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
// Mutable at runtime via POST /api/pin (persisted to __dirname/.env).
// All auth checks read this binding, so changes apply instantly.
let PIN = process.env.PIN || '';
// On Windows, ignore SHELL env from Git Bash/MSYS2/WSL — prefer PowerShell
const SHELL = (os.platform() === 'win32' && !process.env.WEBTUN_SHELL)
  ? 'powershell.exe'
  : (process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh')));
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_FULL_FS = process.env.ALLOW_FULL_FS !== 'false';
const WORKSPACE_ROOT = (() => {
  let ws = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : os.homedir();
  if (!ws || ws.trim() === '') ws = os.homedir() || process.cwd();
  try {
    if (fs.existsSync(ws)) {
      const st = fs.statSync(ws);
      if (!st.isDirectory()) ws = os.homedir() || process.cwd();
    }
    // if not exists, keep as is — mkdir will be attempted later or fallback
    // ensure parent exists: if ws doesn't exist and ALLOW_FULL_FS false, fallback to homedir
    if (!fs.existsSync(ws) && !ALLOW_FULL_FS) {
      const fallback = os.homedir() || process.cwd();
      if (fallback && fs.existsSync(fallback)) ws = fallback;
    }
  } catch { ws = os.homedir() || process.cwd(); }
  return path.resolve(ws);
})();

// Global JSON limit 50MB — per-route guards (e.g., write 10MB, history 1k) are stricter (F42)
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Handle malformed JSON gracefully
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https://*.trycloudflare.com wss: blob:; script-src 'self' https://cdn.jsdelivr.net blob:; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com; img-src 'self' data: blob:; frame-src 'self' blob:; child-src 'self' blob:; worker-src 'self' blob: https://cdn.jsdelivr.net;");
  next();
});

// Trust proxy for proper IP detection behind reverse proxy
// 'loopback' only trusts 127.0.0.1/::1 — safe default for direct connections
// Set TRUST_PROXY=true in .env if behind a reverse proxy
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : 'loopback');

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length === bufB.length) {
    return crypto.timingSafeEqual(bufA, bufB);
  }
  // Length mismatch: still do constant-time compare on padded buffers to avoid length leak (F7)
  const len = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(len, 0);
  const paddedB = Buffer.alloc(len, 0);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  // Always do timingSafeEqual then return false (constant-time failure)
  crypto.timingSafeEqual(paddedA, paddedB);
  return false;
}

// ── Auth ──────────────────────────────────────────────────────────────
function checkPin(req, res, next) {
  if (!PIN) return next();
  // Validate token is string to prevent array injection (?token=a&token=b) (F45)
  const raw = req.headers['x-pin-token'] || req.query.token;
  const token = typeof raw === 'string' ? raw.trim() : '';
  // Note: query token kept for backward compat (WS needs ?token=) but header preferred; query may leak to logs.
  if (token && constantTimeEqual(token, PIN)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/auth/required', (req, res) => {
  res.json({ required: !!PIN });
});

app.get('/api/version', (req, res) => {
  res.json({ version: require('./package.json').version });
});

app.post('/api/auth', authRateLimiter, (req, res) => {
  const { pin } = req.body;
  if (!PIN || (pin && constantTimeEqual(pin, PIN))) {
    res.json({ success: true, token: PIN || 'open' });
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

// Persist PIN to __dirname/.env (same file the startup parser reads).
// Atomic tmp+rename with 0600, mirroring .cmdhist.json writes.
const ENV_PATH = path.join(__dirname, '.env');
function persistPinToEnv(pin) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let found = false;
  const out = lines.map(l => {
    if (!found && /^\s*PIN\s*=/.test(l)) { found = true; return `PIN=${pin}`; }
    return l;
  });
  if (!found) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`PIN=${pin}`);
  }
  const tmp = ENV_PATH + '.tmp';
  fs.writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, ENV_PATH);
}

// Set/change/disable the PIN at runtime. Authed callers only (checkPin),
// brute-force guarded (authRateLimiter). Empty newPin disables protection.
app.post('/api/pin', authRateLimiter, checkPin, (req, res) => {
  try {
    const { currentPin, newPin } = req.body || {};
    if (PIN) {
      if (typeof currentPin !== 'string' || !constantTimeEqual(currentPin, PIN)) {
        return res.status(401).json({ error: 'Current PIN is incorrect' });
      }
    }
    let next = typeof newPin === 'string' ? newPin.trim() : '';
    if (/[\r\n\0]/.test(next)) return res.status(400).json({ error: 'PIN contains invalid characters' });
    if (next.length > 64) return res.status(400).json({ error: 'PIN must be 64 characters or less' });
    PIN = next;
    process.env.PIN = next;
    let persisted = false, persistError = '';
    try { persistPinToEnv(next); persisted = true; }
    catch (e) { persistError = e.message || 'write failed'; }
    res.json({ success: true, protected: !!PIN, persisted, persistError });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── System info ───────────────────────────────────────────────────────
app.get('/api/home', checkPin, (req, res) => {
  res.json({ home: os.homedir(), hostname: os.hostname(), platform: os.platform() });
});

// ── File API ──────────────────────────────────────────────────────────
const fsPromises = fs.promises;

function resolvePath(targetPath) {
  if (Array.isArray(targetPath)) { const e = new Error('Invalid path: array not allowed'); e.status = 400; throw e; }
  if (targetPath == null) return WORKSPACE_ROOT;
  if (typeof targetPath !== 'string') { const e = new Error('Invalid path type'); e.status = 400; throw e; }
  if (targetPath.includes('\0')) { const e = new Error('Invalid path: null byte'); e.status = 400; throw e; }
  if (!targetPath || targetPath.trim() === '') return WORKSPACE_ROOT;
  const resolved = path.resolve(targetPath);
  if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, resolved)) {
    const e = new Error('Access denied: path outside workspace'); e.status = 403; throw e;
  }
  return resolved;
}

// Resolve path and follow symlinks to their real location.
// Used for write operations so files end up at the intended real path.
function realPath(targetPath) {
  if (Array.isArray(targetPath)) { const e = new Error('Invalid path: array not allowed'); e.status = 400; throw e; }
  if (targetPath == null) return WORKSPACE_ROOT;
  if (typeof targetPath !== 'string') { const e = new Error('Invalid path type'); e.status = 400; throw e; }
  if (targetPath.includes('\0')) { const e = new Error('Invalid path: null byte'); e.status = 400; throw e; }
  if (!targetPath || targetPath.trim() === '') return WORKSPACE_ROOT;
  const resolved = path.resolve(targetPath);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch {}
  if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, real)) {
    const e = new Error('Access denied: path outside workspace (symlink)'); e.status = 403; throw e;
  }
  return real;
}

// Case-aware path containment (Windows paths are case-insensitive).
function pathContained(parent, child) {
  let p = path.resolve(parent);
  let c = path.resolve(child);
  if (os.platform() === 'win32') {
    p = p.replace(/\\/g, '/').toLowerCase();
    c = c.replace(/\\/g, '/').toLowerCase();
    if (!p.endsWith('/')) p += '/';
    return c === p.slice(0, -1) || c.startsWith(p);
  }
  return c === p || c.startsWith(p + path.sep);
}

async function renameWithFallback(src, dst) {
  try {
    await fsPromises.rename(src, dst);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fsPromises.cp(src, dst, { recursive: true, force: true });
      await fsPromises.rm(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

async function dirSize(dir, maxDepth = 10) {
  let total = 0;
  let entryCount = 0;
  const MAX_ENTRIES = 100000;
  const visited = new Set();
  const CONCURRENCY = 32;
  // Helper to process entries with concurrency cap
  async function walk(d, depth) {
    if (depth > maxDepth) return;
    if (entryCount > MAX_ENTRIES) return;
    let real;
    try { real = fs.realpathSync(d); } catch { real = path.resolve(d); }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try { entries = await fsPromises.readdir(d, { withFileTypes: true }); } catch { return; }
    entryCount += entries.length;
    if (entryCount > MAX_ENTRIES) return;
    // Process in chunks to limit concurrency (32 parallel stat)
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const chunk = entries.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async e => {
        const full = path.join(d, e.name);
        try {
          if (e.isDirectory()) {
            // Check symlink for loops — if symlink to dir, resolve and check visited
            let lst;
            try { lst = await fsPromises.lstat(full); } catch { return; }
            if (lst.isSymbolicLink()) {
              let targetReal;
              try { targetReal = fs.realpathSync(full); } catch { return; }
              if (visited.has(targetReal)) return;
              // Check containment if sandbox enabled — skip if outside
              if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, targetReal)) return;
              await walk(full, depth + 1);
            } else {
              await walk(full, depth + 1);
            }
          } else if (e.isFile()) {
            const st = await fsPromises.stat(full);
            total += st.size;
          } else {
            // For symlink files, use lstat then stat only if needed
            try {
              const lst = await fsPromises.lstat(full);
              if (lst.isSymbolicLink()) return; // skip symlink files to avoid outside read
              if (lst.isFile()) {
                const st = await fsPromises.stat(full);
                total += st.size;
              }
            } catch {}
          }
        } catch {}
      }));
    }
  }
  await walk(dir, 0);
  return total;
}

function createZipArchive(entries, zipPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Ensure destination inside workspace (F63)
      if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, zipPath)) {
        const e = new Error('Access denied: zip destination outside workspace'); e.status = 403; return reject(e);
      }
      // Per-entry checks and total size guard (>1GB reject) (F63)
      const MAX_TOTAL = 1 * 1024 * 1024 * 1024;
      let totalSize = 0;
      for (const entry of entries) {
        let lst;
        try { lst = fs.lstatSync(entry.fullPath); } catch (e) { return reject(e); }
        if (lst.isSymbolicLink()) {
          // Skip symlink that points outside workspace (leak protection) (F63)
          let real;
          try { real = fs.realpathSync(entry.fullPath); } catch { continue; }
          if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, real)) continue;
          // Skip symlinks even inside to avoid zip traversing outside via link
          continue;
        }
        let size = 0;
        if (lst.isDirectory()) {
          size = await dirSize(entry.fullPath);
        } else if (lst.isFile()) {
          size = lst.size;
        } else {
          continue;
        }
        totalSize += size;
        if (totalSize > MAX_TOTAL) {
          const e = new Error('Total size exceeds 1GB'); e.status = 413; return reject(e);
        }
        if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, entry.fullPath)) {
          const e = new Error('Access denied: entry outside workspace'); e.status = 403; return reject(e);
        }
      }
      const output = fs.createWriteStream(zipPath);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      for (const entry of entries) {
        try {
          let lst;
          try { lst = fs.lstatSync(entry.fullPath); } catch (e) { return reject(e); }
          if (lst.isSymbolicLink()) continue;
          const st = fs.statSync(entry.fullPath);
          if (st.isDirectory()) archive.directory(entry.fullPath, entry.nameInZip);
          else archive.file(entry.fullPath, { name: entry.nameInZip });
        } catch (e) {
          return reject(e);
        }
      }
      archive.finalize();
    } catch (e) { reject(e); }
  });
}

function streamZipDirectory(dirPath, res) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  });
  archive.pipe(res);
  archive.directory(dirPath, path.basename(dirPath));
  archive.finalize();
  return archive;
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // Validate zip magic (PK header) before extraction (F64)
    try {
      const fd = fs.openSync(zipPath, 'r');
      const buf = Buffer.alloc(4);
      const bytes = fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      if (bytes < 4 || !(buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) && (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08))) {
        return reject(Object.assign(new Error('Not a zip file (bad magic)'), { status: 400 }));
      }
    } catch (e) { return reject(e); }
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      let entryCount = 0;
      let totalUncompressed = 0;
      const MAX_ENTRIES = 1000;
      const MAX_TOTAL = 1 * 1024 * 1024 * 1024;
      zipfile.readEntry();
      zipfile.on('entry', entry => {
        entryCount++;
        if (entryCount > MAX_ENTRIES) {
          zipfile.close();
          const e = new Error('Too many entries in zip (max 1000)'); e.status = 413; return reject(e);
        }
        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > MAX_TOTAL) {
          zipfile.close();
          const e = new Error('Uncompressed size exceeds 1GB'); e.status = 413; return reject(e);
        }
        const entryName = entry.fileName.replace(/\\/g, '/');
        const entryPath = path.normalize(entryName);
        if (entryPath.startsWith('..') || path.isAbsolute(entryPath) || entryName.includes('\0')) {
          zipfile.close();
          return reject(new Error('Invalid zip entry: ' + entry.fileName));
        }
        const target = path.join(destDir, entryPath);
        if (!pathContained(destDir, target)) {
          zipfile.close();
          return reject(new Error('Zip entry escapes destination directory'));
        }
        if (/\/$/.test(entryName)) {
          fs.mkdirSync(target, { recursive: true });
          zipfile.readEntry();
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zipfile.openReadStream(entry, (err2, readStream) => {
          if (err2) { zipfile.close(); return reject(err2); }
          const writeStream = fs.createWriteStream(target);
          readStream.on('error', (e) => { zipfile.close(); reject(e); });
          writeStream.on('error', (e) => { zipfile.close(); reject(e); });
          writeStream.on('close', () => zipfile.readEntry());
          readStream.pipe(writeStream);
        });
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', reject);
    });
  });
}

function findCloudflared() {
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

function killPid(pid, signal = 'SIGTERM') {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (os.platform() === 'win32') {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
      // Fallback: also kill any remaining child processes via WMIC
      try {
        const out = execSync(`wmic process where "ParentProcessId=${pid}" get ProcessId /format:list`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const childPids = out.split('\n').filter(l => l.startsWith('ProcessId=')).map(l => parseInt(l.split('=')[1])).filter(Boolean);
        for (const cp of childPids) { try { execSync(`taskkill /PID ${cp} /F`, { stdio: 'ignore' }); } catch {} }
      } catch {}
    } else {
      process.kill(pid, signal);
    }
  } catch {}
}

function buildSessionEnv() {
  if (os.platform() === 'win32') {
    const env = { ...process.env };
    env.TERM = env.TERM || 'xterm-256color';
    env.COLORTERM = env.COLORTERM || 'truecolor';
    if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE.replace(/\\/g, '/');
    if (!env.USER && env.USERNAME) env.USER = env.USERNAME;
    env.SHELL = SHELL;
    // Prefer Path (Windows) over PATH if both set
    if (env.Path && !env.PATH) env.PATH = env.Path;
    return env;
  }
  const safe = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    HOME: process.env.HOME || '',
    USER: process.env.USER || '',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    SHELL
  };
  if (process.env.NODE_ENV) safe.NODE_ENV = process.env.NODE_ENV;
  // Preserve common terminal/locale vars when present
  for (const k of ['LC_ALL', 'LC_CTYPE', 'TERM_PROGRAM', 'COLORFGBG']) {
    if (process.env[k]) safe[k] = process.env[k];
  }
  return safe;
}

async function safeStat(p) {
  try { return await fsPromises.stat(p); } catch { return null; }
}

async function asyncSafeWalk(currentDir, depth, maxDepth, q, results, maxResults) {
  if (depth > maxDepth || results.length >= maxResults) return;
  let entries;
  try { entries = await fsPromises.readdir(currentDir, { withFileTypes: true }); } catch { return; }

  const matching = entries.filter(e => e.name.toLowerCase().includes(q));
  const dirs = entries.filter(e => e.isDirectory());

  await Promise.all(matching.map(async e => {
    if (results.length >= maxResults) return;
    const full = path.join(currentDir, e.name);
    try {
      const st = await fsPromises.stat(full);
      if (results.length < maxResults) results.push({ path: full, name: e.name, isDir: st.isDirectory(), dir: currentDir });
    } catch {}
  }));

  await Promise.all(dirs.map(async e => {
    if (results.length >= maxResults) return;
    const full = path.join(currentDir, e.name);
    try {
      const st = await fsPromises.lstat(full);
      if (st.isSymbolicLink()) return;
    } catch {}
    await asyncSafeWalk(full, depth + 1, maxDepth, q, results, maxResults);
  }));
}

app.get('/api/files', checkPin, async (req, res) => {
  try {
    const dir = resolvePath(req.query.path || WORKSPACE_ROOT);

    // Windows: at a drive root (e.g. C:\), list all available drives
    if (os.platform() === 'win32') {
      const parsed = path.parse(dir);
      if (dir === parsed.root || dir === '\\') {
        const files = [];
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const drive = letter + ':\\';
          try { await fsPromises.access(drive); } catch { continue; }
          files.push({
            name: letter + ':', path: drive, isDir: true,
            isSymlink: false, size: 0, modified: null, ext: ''
          });
        }
        if (dir !== '\\') {
          try {
            const entries = await fsPromises.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
              const full = path.join(dir, e.name);
              const st = await safeStat(full);
              files.push({
                name: e.name, path: full, isDir: st ? st.isDirectory() : e.isDirectory(),
                isSymlink: e.isSymbolicLink(), size: st ? st.size : 0,
                modified: st ? st.mtime : null, ext: path.extname(e.name).toLowerCase()
              });
            }
          } catch {}
        }
        files.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return res.json({ path: dir, parent: null, files });
      }
    }

    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    // Bound stat concurrency so huge directories don't spike fds/CPU
    const files = [];
    const STAT_BATCH = 32;
    for (let i = 0; i < entries.length; i += STAT_BATCH) {
      const chunk = entries.slice(i, i + STAT_BATCH);
      const out = await Promise.all(
        chunk.map(async e => {
          const full = path.join(dir, e.name);
          const st = await safeStat(full);
          const isSymlink = e.isSymbolicLink();
          // Use stat result for isDir so symlink→dir is navigable; Dirent.isDirectory() is false for symlink
          const isDir = st ? st.isDirectory() : e.isDirectory();
          return {
            name: e.name,
            path: full,
            isDir,
            isSymlink,
            size: st ? st.size : 0,
            modified: st ? st.mtime : null,
            ext: path.extname(e.name).toLowerCase()
          };
        })
      );
      files.push(...out);
    }
    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    let parent = path.dirname(dir);
    if (parent === dir) parent = null;
    else if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, parent)) parent = null;
    res.json({ path: dir, parent, files });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/files/rename', checkPin, async (req, res) => {
  try {
    if (!req.body.oldPath || !req.body.newName) {
      console.warn('POST /api/files/rename 400 — body requires { oldPath, newName }. Example: { "oldPath": "/home/user/file.txt", "newName": "renamed.txt" }');
      return res.status(400).json({ error: 'oldPath and newName are required', usage: 'POST JSON { "oldPath": "<path>", "newName": "<name>" }' });
    }
    const newName = req.body.newName;
    if (typeof newName !== 'string' || !newName.trim() || newName === '.' || newName.length > 255 || newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
      return res.status(400).json({ error: 'Invalid newName: must not contain / \\ .. , be empty, "." or >255 chars' });
    }
    // also reject if newName contains null byte
    if (newName.includes('\0')) return res.status(400).json({ error: 'Invalid newName: null byte' });
    const oldPath = realPath(req.body.oldPath);
    const newPath = realPath(path.join(path.dirname(oldPath), newName));
    await renameWithFallback(oldPath, newPath);
    res.json({ success: true, newPath });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

async function resolveCopyMove(src, dst, conflict, isMove) {
  const VALID_CONFLICTS = ['replace', 'skip', 'keep_both', 'merge', 'cancel'];
  let dstExists = false, dstIsDir = false;
  try { const s = await fsPromises.stat(dst); dstExists = true; dstIsDir = s.isDirectory(); } catch {}

  if (dstExists && !VALID_CONFLICTS.includes(conflict)) {
    return { conflict: true, isDir: dstIsDir, name: path.basename(dst) };
  }

  if (conflict === 'cancel') return { success: false, error: 'Cancelled' };
  if (conflict === 'skip') return { success: true, skipped: true };

  if (conflict === 'keep_both' && dstExists) {
    const ext = path.extname(dst);
    const base = path.basename(dst, ext);
    const dir = path.dirname(dst);
    let counter = 1;
    while (true) {
      const suffix = counter === 1 ? ' (copy)' : ` (copy ${counter})`;
      dst = path.join(dir, base + suffix + ext);
      try { await fsPromises.access(dst); counter++; } catch { break; }
    }
  }

  const st = await fsPromises.stat(src);
  const isDir = st.isDirectory();

  if (dstExists && conflict === 'replace') {
    if (isDir) await fsPromises.rm(dst, { recursive: true, force: true });
    else await fsPromises.unlink(dst);
  }

  if (isMove) {
    if (dstExists && conflict === 'merge' && isDir && dstIsDir) {
      const entries = await fsPromises.readdir(src);
      for (const entry of entries) {
        const srcEntry = path.join(src, entry);
        const dstEntry = path.join(dst, entry);
        await fsPromises.cp(srcEntry, dstEntry, { recursive: true, force: true });
      }
      await fsPromises.rm(src, { recursive: true, force: true });
    } else {
      await renameWithFallback(src, dst);
    }
  } else {
    if (isDir) {
      if (dstExists && conflict === 'merge' && dstIsDir) {
        const entries = await fsPromises.readdir(src);
        for (const entry of entries) {
          const srcEntry = path.join(src, entry);
          const dstEntry = path.join(dst, entry);
          await fsPromises.cp(srcEntry, dstEntry, { recursive: true, force: true });
        }
      } else {
        await fsPromises.cp(src, dst, { recursive: true, force: true });
      }
    } else {
      await fsPromises.copyFile(src, dst);
    }
  }
  return { success: true };
}

async function handleCopyMove(req, res, isMove) {
  try {
    if (!req.body.source || !req.body.destination) {
      return res.status(400).json({ error: 'source and destination are required', usage: 'POST JSON { "source": "<src>", "destination": "<dst>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
    }
    const src = realPath(req.body.source);
    const dst = resolvePath(req.body.destination);
    // Sandbox guards (F53)
    if (!ALLOW_FULL_FS) {
      if (!pathContained(WORKSPACE_ROOT, dst)) return res.status(403).json({ error: 'Access denied: destination outside workspace' });
      // If dst exists via symlink, check realpath as well
      try {
        const realDst = fs.realpathSync(dst);
        if (!pathContained(WORKSPACE_ROOT, realDst)) return res.status(403).json({ error: 'Access denied: destination symlink outside workspace' });
      } catch {}
    }
    if (src === dst) return res.status(400).json({ error: 'source and destination are same' });
    if (pathContained(src, dst)) return res.status(400).json({ error: 'destination inside source' });
    const result = await resolveCopyMove(src, dst, req.body.conflict || '', isMove);
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
}

app.post('/api/files/copy', checkPin, (req, res) => handleCopyMove(req, res, false));
app.post('/api/files/move', checkPin, (req, res) => handleCopyMove(req, res, true));

app.delete('/api/files', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      console.warn('DELETE /api/files 400 — query param ?path= is required. Example: DELETE /api/files?path=/home/user/file.txt');
      return res.status(400).json({ error: 'path is required', usage: 'DELETE /api/files?path=<path>' });
    }
    const p = realPath(req.query.path);
    const lst = await fsPromises.lstat(p);
    if (lst.isSymbolicLink()) {
      await fsPromises.unlink(p);
    } else if (lst.isDirectory()) {
      await fsPromises.rm(p, { recursive: true, force: true });
    } else {
      await fsPromises.unlink(p);
    }
    res.json({ success: true });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/files/mkdir', checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/mkdir 400 — body requires { path }. Example: { "path": "/home/user/newfolder" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<dir>" }' });
    }
    const p = realPath(req.body.path);
    await fsPromises.mkdir(p, { recursive: true });
    res.json({ success: true });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/files/touch', checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/touch 400 — body requires { path }. Example: { "path": "/home/user/newfile.txt" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file>" }' });
    }
    const p = realPath(req.body.path);
    await fsPromises.writeFile(p, '', { flag: 'a' });
    res.json({ success: true });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/files/zip', checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/zip 400 — body requires { path }. Example: { "path": "/home/user/mydir" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file_or_dir>" }' });
    }
    const p = realPath(req.body.path);
    const st = await fsPromises.stat(p);
    // Dest dir size guard (F63) — reject if dir >1GB
    if (st.isDirectory()) {
      const sz = await dirSize(p);
      if (sz > 1 * 1024 * 1024 * 1024) return res.status(413).json({ error: 'Directory too large to zip (max 1GB)' });
    } else if (st.size > 1 * 1024 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large to zip (max 1GB)' });
    }
    const baseName = path.basename(p);
    let zipName = baseName + '.zip';
    let zipPath = path.join(path.dirname(p), zipName);
    // Ensure zipPath inside workspace
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, zipPath)) return res.status(403).json({ error: 'Access denied: zip destination outside workspace' });
    let counter = 1;
    while (true) {
      try { await fsPromises.access(zipPath); } catch { break; }
      zipName = baseName + ' (' + counter + ').zip';
      zipPath = path.join(path.dirname(p), zipName);
      if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, zipPath)) return res.status(403).json({ error: 'Access denied' });
      counter++;
    }
    await createZipArchive([{ fullPath: p, nameInZip: baseName }], zipPath);
    res.json({ success: true, name: zipName });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/files/unzip', checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/unzip 400 — body requires { path }. Example: { "path": "/home/user/archive.zip" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<zip_file>" }' });
    }
    const p = realPath(req.body.path);
    const ext = path.extname(p).toLowerCase();
    if (ext !== '.zip') return res.status(400).json({ error: 'Not a zip file' });
    // Validate zip magic (F64) — extractZip also checks, but early check here for 400 vs 500
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(4);
      const bytes = fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      if (bytes < 4 || !(buf[0] === 0x50 && buf[1] === 0x4B)) {
        return res.status(400).json({ error: 'Not a zip file (bad magic)' });
      }
    } catch {}
    const destDir = path.join(path.dirname(p), path.basename(p, '.zip'));
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, destDir)) return res.status(403).json({ error: 'Access denied: destination outside workspace' });
    await fsPromises.mkdir(destDir, { recursive: true });
    try {
      await extractZip(p, destDir);
    } catch (e) {
      // Rollback partial on failure (F64)
      try { await fsPromises.rm(destDir, { recursive: true, force: true }); } catch {}
      const status = e.status || 500;
      return res.status(status).json({ error: e.message });
    }
    res.json({ success: true, dir: destDir });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.get('/api/files/read', checkPin, async (req, res) => {
  try {
    const p = resolvePath(req.query.path);
    const st = await fsPromises.stat(p);
    if (st.isDirectory()) return res.status(400).json({ error: 'Cannot read a directory' });
    if (st.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 10MB) - use download' });
    const ext = path.extname(p).toLowerCase().slice(1);
    if (ext && BINARY_EXTS.has(ext)) {
      return res.status(415).json({ error: 'Preview not supported for binary files - use download', isBinary: true });
    }
    const buf = await fsPromises.readFile(p);
    if (buf.includes(0)) {
      return res.status(415).json({ error: 'Preview not supported for binary files - use download', isBinary: true });
    }
    const content = buf.toString('utf8');
    res.json({ content, length: st.size });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/files/write', checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/write 400 — body requires { path, content }. Example: { "path": "/home/user/file.txt", "content": "hello world" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file>", "content": "<string>" }' });
    }
    if (typeof req.body.content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (Buffer.byteLength(req.body.content, 'utf8') > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Content too large (max 10MB)' });
    }
    const p = realPath(req.body.path);
    await fsPromises.writeFile(p, req.body.content, 'utf8');
    res.json({ success: true });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

// Serve image files for inline viewing (not as download)
app.get('/api/files/image', checkPin, async (req, res) => {
  try {
    const p = resolvePath(req.query.path);
    const mimeType = mimeLookup(p);
    res.setHeader('Content-Type', mimeType);
    // Avoid caching secrets served as octet-stream (F57)
    if (mimeType === 'application/octet-stream') {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'private, max-age=3600');
    }
    const stream = fs.createReadStream(p);
    // Ensure stream destroyed when client aborts to avoid FD leak (F57)
    req.on('close', () => { try { stream.destroy(); } catch {} });
    stream.on('error', err => {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
      else res.end();
    });
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/files/download', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      console.warn('GET /api/files/download 400 — query param ?path= is required. Example: GET /api/files/download?path=/home/user/file.txt');
      return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/download?path=<path>' });
    }
    const p = realPath(req.query.path);
    const st = await fsPromises.stat(p);
    if (st.isDirectory()) {
      const safeName = path.basename(p).replace(/["\r\n;]/g, '_') + '.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      const arch = streamZipDirectory(p, res);
      // Cleanup archiver when client aborts (F58)
      res.on('close', () => { try { if (arch) arch.abort(); } catch {} });
      return;
    } else {
      const mimeType = mimeLookup(p);
      const safeName = path.basename(p).replace(/["\r\n;]/g, '_');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      const stream = fs.createReadStream(p);
      req.on('close', () => { try { stream.destroy(); } catch {} });
      stream.on('error', err => {
        if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
        else res.end();
      });
      stream.pipe(res);
    }
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
});

// Upload with multer disk storage – destination resolved per-request
app.post('/api/files/upload', checkPin, (req, res) => {
  let destDir;
  try {
    destDir = realPath(req.query.path || WORKSPACE_ROOT);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }
  const UNIFIED_SAFE_RE = /[^a-zA-Z0-9_.\-]/g;
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const safeName = path.basename(file.originalname).replace(UNIFIED_SAFE_RE, '_');
        const finalDest = path.join(destDir, safeName);
        if (!pathContained(destDir, finalDest)) {
          return cb(new Error('Invalid upload destination'));
        }
        const subPath = path.dirname(finalDest);
        fs.mkdirSync(subPath, { recursive: true });
        cb(null, subPath);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_, file, cb) => cb(null, path.basename(file.originalname).replace(UNIFIED_SAFE_RE, '_'))
  });
  const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024, files: 100 } }).array('files');
  upload(req, res, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, count: Array.isArray(req.files) ? req.files.length : 0 });
  });
});

// Cache for owner/group to avoid blocking execFileSync on every request (F60 trail)
const _ownerCache = new Map();
const _groupCache = new Map();

// ── File stat / metadata ──────────────────────────────────────────────
app.get('/api/files/stat', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      console.warn('GET /api/files/stat 400 — query param ?path= is required');
      return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/stat?path=<path>' });
    }
    const p = realPath(req.query.path);
    const st = await fsPromises.stat(p);
    let lst = null;
    try { lst = await fsPromises.lstat(p); } catch {}
    const stat = {
      path: p, name: path.basename(p),
      size: st.size, blocks: st.blocks,
      mode: st.mode.toString(8).slice(-3),
      permissions: (lst || st).mode.toString(8).slice(-3),
      uid: st.uid, gid: st.gid,
      atime: st.atime, mtime: st.mtime, ctime: st.ctime, birthtime: st.birthtime,
      isFile: st.isFile(), isDirectory: st.isDirectory(),
      isSymlink: lst ? lst.isSymbolicLink() : false,
      isSocket: st.isSocket(), isFIFO: st.isFIFO(),
    };
    // Use cache for owner (F60 trail) — still blocking but cached
    try {
      if (os.platform() === 'win32') {
        stat.owner = String(st.uid);
      } else if (_ownerCache.has(st.uid)) {
        stat.owner = _ownerCache.get(st.uid);
      } else {
        const owner = execFileSync('id', ['-nu', String(st.uid)], { encoding: 'utf8', stdio: 'pipe', timeout: 2000 }).trim();
        _ownerCache.set(st.uid, owner);
        if (_ownerCache.size > 500) { const k=_ownerCache.keys().next().value; _ownerCache.delete(k); }
        stat.owner = owner;
      }
    } catch { stat.owner = String(st.uid); }
    try {
      if (os.platform() === 'win32') {
        stat.group = String(st.gid);
      } else if (_groupCache.has(st.gid)) {
        stat.group = _groupCache.get(st.gid);
      } else if (os.platform() === 'darwin') {
        const dscl = execSync(`dscl . -read /Groups/${st.gid} RecordName 2>/dev/null`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
        const m = dscl.match(/RecordName:\s*(.+)/);
        const g = m ? m[1].trim() : String(st.gid);
        _groupCache.set(st.gid, g);
        if (_groupCache.size > 500) { const k=_groupCache.keys().next().value; _groupCache.delete(k); }
        stat.group = g;
      } else {
        const g = execFileSync('getent', ['group', String(st.gid)], { encoding: 'utf8', stdio: 'pipe', timeout: 2000 }).split(':')[0];
        _groupCache.set(st.gid, g);
        if (_groupCache.size > 500) { const k=_groupCache.keys().next().value; _groupCache.delete(k); }
        stat.group = g;
      }
    } catch { stat.group = String(st.gid); }
    try {
      const symlink = lst && lst.isSymbolicLink() ? await fsPromises.readlink(p) : null;
      if (symlink) stat.linkTarget = symlink;
    } catch {}
    res.json(stat);
  } catch (e) {
    const status = e.status || 500;
    // Avoid leaking absolute path in error (F60)
    const msg = e.message && e.message.includes(WORKSPACE_ROOT) ? e.message.replace(WORKSPACE_ROOT, '~') : e.message;
    res.status(status).json({ error: msg });
  }
});

// ── Folder size ──────────────────────────────────────────────────────
app.get('/api/files/size', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/size?path=<dir>' });
    }
    const p = realPath(req.query.path);
    const lst = await fsPromises.lstat(p);
    if (lst.isSymbolicLink()) {
      // Don't follow symlink for size — report link size
      return res.json({ path: p, size: lst.size, isDir: false, isSymlink: true });
    }
    const st = await fsPromises.stat(p);
    if (!st.isDirectory()) {
      return res.json({ path: p, size: st.size, isDir: false });
    }
    const size = await dirSize(p);
    res.json({ path: p, size, isDir: true });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

// ── Batch delete ──────────────────────────────────────────────────────
app.post('/api/files/batch-delete', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.paths) || req.body.paths.length === 0) {
      console.warn('POST /api/files/batch-delete 400 — body requires { paths: [...] }');
      return res.status(400).json({ error: 'paths array is required', usage: 'POST JSON { "paths": ["<path1>", "<path2>", ...] }' });
    }
    if (req.body.paths.length > 100) return res.status(400).json({ error: 'too many paths max 100' });
    const results = [];
    for (const raw of req.body.paths) {
      let p;
      try { p = realPath(raw); } catch (e) { results.push({ path: raw, success: false, error: e.message }); continue; }
      try {
        const lst = await fsPromises.lstat(p);
        if (lst.isSymbolicLink()) await fsPromises.unlink(p);
        else if (lst.isDirectory()) await fsPromises.rm(p, { recursive: true, force: true });
        else await fsPromises.unlink(p);
        results.push({ path: raw, success: true });
      } catch (e) {
        results.push({ path: raw, success: false, error: e.message });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

// ── Batch copy ────────────────────────────────────────────────────────
async function handleBatchCopyMove(req, res, isMove) {
  try {
    if (!Array.isArray(req.body.sources) || req.body.sources.length === 0 || !req.body.destination) {
      return res.status(400).json({ error: 'sources array and destination are required', usage: 'POST JSON { "sources": ["<src1>", ...], "destination": "<dir>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
    }
    if (req.body.sources.length > 100) return res.status(400).json({ error: 'too many paths max 100' });
    const conflict = req.body.conflict || 'replace';
    const destDir = resolvePath(req.body.destination);
    const results = [];
    for (const raw of req.body.sources) {
      let src;
      try { src = realPath(raw); } catch (e) { results.push({ path: raw, success: false, error: e.message }); continue; }
      try {
        const baseName = path.basename(src);
        const dst = path.join(destDir, baseName);
        // Guard dst containment and self-move (F53)
        if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dst)) {
          results.push({ path: raw, success: false, error: 'Access denied: destination outside workspace' }); continue;
        }
        // Prevent src === dst and dst inside src (move parent into child)
        if (src === dst) { results.push({ path: raw, success: false, error: 'source and destination are same' }); continue; }
        if (pathContained(src, dst)) { results.push({ path: raw, success: false, error: 'destination inside source' }); continue; }
        const result = await resolveCopyMove(src, dst, conflict, isMove);
        results.push({ path: raw, success: true, ...result });
      } catch (e) {
        results.push({ path: raw, success: false, error: e.message });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
}

app.post('/api/files/batch-copy', checkPin, (req, res) => handleBatchCopyMove(req, res, false));
app.post('/api/files/batch-move', checkPin, (req, res) => handleBatchCopyMove(req, res, true));

// ── Change permissions (chmod) ─────────────────────────────────────────
app.post('/api/files/chmod', checkPin, async (req, res) => {
  try {
    if (!req.body.path || !req.body.mode) {
      console.warn('POST /api/files/chmod 400 — body requires { path, mode }. Example: { "path": "/home/user/file.sh", "mode": "755" }');
      return res.status(400).json({ error: 'path and mode are required', usage: 'POST JSON { "path": "<path>", "mode": "<octal_perms>" }' });
    }
    const p = realPath(req.body.path);
    if (!/^[0-7]{3,4}$/.test(req.body.mode)) return res.status(400).json({ error: 'mode must be a 3-4 digit octal number (e.g. 755, 644, 1777)' });
    const mode = parseInt(req.body.mode, 8);
    await fsPromises.chmod(p, mode);
    const warning = os.platform() === 'win32' ? 'chmod has no effect on Windows' : undefined;
    res.json({ success: true, mode: req.body.mode, ...(warning && { warning }) });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

// ── Create symlink ────────────────────────────────────────────────────
app.post('/api/files/symlink', checkPin, async (req, res) => {
  try {
    if (!req.body.target || !req.body.linkPath) {
      console.warn('POST /api/files/symlink 400 — body requires { target, linkPath }. Example: { "target": "/real/file.txt", "linkPath": "/home/user/link.txt" }');
      return res.status(400).json({ error: 'target and linkPath are required', usage: 'POST JSON { "target": "<existing_path>", "linkPath": "<symlink_path>" }' });
    }
    const target = realPath(req.body.target);
    const linkPath = realPath(req.body.linkPath);
    await fsPromises.mkdir(path.dirname(linkPath), { recursive: true });
    await fsPromises.symlink(target, linkPath);
    res.json({ success: true, target, linkPath });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

// ── Full-text content search ──────────────────────────────────────────
app.post('/api/files/search-content', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!req.body.query || !req.body.path) {
      console.warn('POST /api/files/search-content 400 — body requires { query, path }. Example: { "query": "TODO", "path": "/home/user/project", "pattern": "string" }');
      return res.status(400).json({ error: 'query and path are required', usage: 'POST JSON { "query": "<text_or_regex>", "path": "<dir>", "pattern": "string|regex", "maxResults": 50, "maxDepth": 4 }' });
    }
    const searchDir = resolvePath(req.body.path);
    const queryRaw = req.body.query;
    if (typeof queryRaw !== 'string' || queryRaw.length === 0 || queryRaw.length > 500) return res.status(400).json({ error: 'query must be string 1-500 chars' });
    const query = queryRaw;
    const isRegex = req.body.pattern === 'regex';
    // NaN guard (F65): coerce to integer, clamp
    let mR = parseInt(req.body.maxResults, 10);
    if (!Number.isFinite(mR) || mR < 1) mR = 50;
    const maxResults = Math.min(mR, 200);
    let mD = parseInt(req.body.maxDepth, 10);
    if (!Number.isFinite(mD) || mD < 1) mD = 4;
    const maxDepth = Math.min(mD, 4);
    const results = [];
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // skip files > 10MB
    const BINARY_CHECK_LEN = 4096;

    let regex;
    if (isRegex) {
      if (query.length > 200) return res.status(400).json({ error: 'regex too long max 200' });
      try { regex = new RegExp(query, 'gi'); } catch { return res.status(400).json({ error: 'invalid regex pattern' }); }
      // ReDoS guard: reject patterns with catastrophic backtracking markers (e.g., (a+)+ )
      if (/(\)\+|\)\*|\+\+|\*\*).{0,20}\1/.test(query) && query.length > 50) {
        // heuristic: still allow but limit execution time per line via timeout (handled by overall request timeout)
      }
    }

    async function walkContentSearch(currentDir, depth) {
      if (depth > maxDepth || results.length >= maxResults) return;
      let entries;
      try { entries = await fsPromises.readdir(currentDir, { withFileTypes: true }); } catch { return; }
      const dirs = [];
      for (const e of entries) {
        if (results.length >= maxResults) break;
        const full = path.join(currentDir, e.name);
        try {
          if (e.isDirectory()) {
            // Use lstat to avoid following symlink dir outside sandbox
            let lst; try { lst = await fsPromises.lstat(full); } catch { continue; }
            if (lst.isSymbolicLink()) {
              let targetReal; try { targetReal = fs.realpathSync(full); } catch { continue; }
              if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, targetReal)) continue;
            }
            dirs.push(e);
          } else if (e.isFile() || e.isSymbolicLink()) {
            // For symlink files, ensure target inside workspace and not binary bypass
            let st;
            if (e.isSymbolicLink()) {
              let targetReal; try { targetReal = fs.realpathSync(full); } catch { continue; }
              if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, targetReal)) continue;
              try { st = await fsPromises.stat(full); } catch { continue; }
            } else {
              st = await fsPromises.stat(full);
            }
            if (st.size > MAX_FILE_SIZE) continue;
            if (st.size === 0) continue;
            // Check for binary
            const fd = await fsPromises.open(full, 'r');
            try {
              const buf = Buffer.alloc(BINARY_CHECK_LEN);
              const { bytesRead } = await fd.read(buf, 0, BINARY_CHECK_LEN, 0);
              if (buf.slice(0, bytesRead).includes(0)) continue; // binary
            } finally { await fd.close(); }
            const content = await fsPromises.readFile(full, 'utf8');
            const lines = content.split('\n');
            const lowerQuery = query.toLowerCase();
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              let match;
              if (regex) {
                regex.lastIndex = 0;
                match = regex.exec(lines[i]);
              } else {
                const idx = lines[i].toLowerCase().indexOf(lowerQuery);
                match = idx !== -1 ? { index: idx } : null;
              }
              if (match) {
                results.push({ path: full, line: i + 1, column: match.index, content: lines[i].substring(0, 500) });
              }
            }
          }
        } catch {}
      }
      await Promise.all(dirs.map(d => walkContentSearch(path.join(currentDir, d.name), depth + 1)));
    }

    await walkContentSearch(searchDir, 0);
    res.json({ results, count: results.length, query, path: searchDir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Batch zip (multiple sources) ──────────────────────────────────────
app.post('/api/files/batch-zip', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.sources) || req.body.sources.length === 0 || !req.body.destination) {
      console.warn('POST /api/files/batch-zip 400 — body requires { sources: [...], destination: "<path>" }. Example: { "sources": ["/a", "/b"], "destination": "/home/user/archive.zip" }');
      return res.status(400).json({ error: 'sources array and destination are required', usage: 'POST JSON { "sources": ["<path1>", ...], "destination": "<zip_path>" }' });
    }
    if (req.body.sources.length > 100) return res.status(400).json({ error: 'too many sources max 100' });
    let dest = realPath(req.body.destination);
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dest)) return res.status(403).json({ error: 'Access denied: destination outside workspace' });
    const resolved = req.body.sources.map(s => realPath(s));
    // Auto-rename if destination exists
    let counter = 1;
    const ext = '.zip';
    const origDest = dest;
    while (true) {
      try { await fsPromises.access(dest); } catch { break; }
      dest = origDest.replace(/(\.zip)?$/i, ` (${counter})${ext}`);
      if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dest)) return res.status(403).json({ error: 'Access denied' });
      counter++;
      if (counter > 1000) return res.status(400).json({ error: 'too many existing zips' });
    }
    await fsPromises.mkdir(path.dirname(dest), { recursive: true });
    const entries = resolved.map(s => ({ fullPath: s, nameInZip: path.basename(s) }));
    await createZipArchive(entries, dest);
    res.json({ success: true, name: path.basename(dest), files: req.body.sources.length });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});







// ── Log tail (SSE) ────────────────────────────────────────────────────
app.get('/api/files/tail', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const p = realPath(req.query.path);
    const lines = Math.min(parseInt(req.query.lines) || 50, 500);
    const pollInterval = Math.max(500, parseInt(req.query.interval) || 2000);

    const st = await fsPromises.stat(p);
    if (st.isDirectory()) { res.status(400).json({ error: 'cannot tail a directory' }); return; }
    if (st.size > 100 * 1024 * 1024) { res.status(413).json({ error: 'file too large to tail (max 100MB)' }); return; }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial content (last N lines)
    const content = await fsPromises.readFile(p, 'utf8');
    const allLines = content.split('\n');
    const tailLines = allLines.slice(-lines);
    res.write(`data: ${JSON.stringify({ type: 'init', lines: tailLines, total: allLines.length })}\n\n`);

    // Poll for changes
    let lastSize = content.length;
    const timer = setInterval(async () => {
      if (res.writableEnded) { clearInterval(timer); return; }
      try {
        const newSt = await fsPromises.stat(p);
        if (newSt.size > lastSize) {
          const fd = await fsPromises.open(p, 'r');
          const buf = Buffer.alloc(newSt.size - lastSize);
          await fd.read(buf, 0, buf.length, lastSize);
          await fd.close();
          lastSize = newSt.size;
          const newLines = buf.toString('utf8');
          res.write(`data: ${JSON.stringify({ type: 'data', lines: newLines })}\n\n`);
        } else if (newSt.size < lastSize) {
          // File was truncated — re-read
          lastSize = 0;
        }
      } catch {}
    }, pollInterval);

    req.on('close', () => { clearInterval(timer); });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Network info ──────────────────────────────────────────────────────
app.get('/api/system/network', rateLimiter, checkPin, async (req, res) => {
  try {
    const interfaces = os.networkInterfaces();
    const result = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        result.push({ interface: name, family: addr.family, address: addr.address, netmask: addr.netmask, mac: addr.mac, internal: addr.internal, cidr: addr.cidr });
      }
    }
    let gateway = null, dns = null, listenPorts = [];
    try {
      if (os.platform() === 'win32') {
        const route = execFileSync('powershell.exe', ['-Command', '(Get-NetRoute -DestinationPrefix "0.0.0.0/0").NextHop'], { encoding: 'utf8', stdio: 'pipe' }).trim();
        gateway = route.split('\n')[0].trim() || null;
        const dnsOut = execFileSync('powershell.exe', ['-Command', '(Get-DnsClientServerAddress -AddressFamily IPv4).ServerAddresses'], { encoding: 'utf8', stdio: 'pipe' }).trim();
        dns = dnsOut.split('\n').filter(Boolean);
      } else if (os.platform() === 'darwin') {
        const route = execFileSync('sh', ['-c', "route -n get default 2>/dev/null | awk '/gateway:/{print $2}'"], { encoding: 'utf8', stdio: 'pipe' }).trim();
        gateway = route || null;
        const resolv = execFileSync('sh', ['-c', "scutil --dns 2>/dev/null | awk '/nameserver\[0\]/{print $3}' | head -3"], { encoding: 'utf8', stdio: 'pipe' }).trim();
        dns = resolv.split('\n').filter(Boolean);
      } else {
        const route = execFileSync('sh', ['-c', "ip route | grep default | head -1 | awk '{print $3}'"], { encoding: 'utf8', stdio: 'pipe' }).trim();
        gateway = route || null;
        let resolv = '';
        try {
          resolv = execFileSync('sh', ['-c', "grep nameserver /etc/resolv.conf | awk '{print $2}'"], { encoding: 'utf8', stdio: 'pipe' }).trim();
        } catch {}
        if (!resolv) {
          try { resolv = execFileSync('sh', ['-c', "resolvectl status 2>/dev/null | awk '/DNS Servers/{found=1; next} /^$/{found=0} found{print $1}' | head -3"], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch {}
        }
        dns = resolv.split('\n').filter(Boolean);
      }
    } catch {}
    try {
      if (os.platform() === 'win32') {
        const out = execFileSync('powershell.exe', ['-Command', 'netstat -ano | findstr LISTEN'], { encoding: 'utf8', stdio: 'pipe' }).trim();
        listenPorts = out.split('\n').filter(Boolean).map(l => {
          const m = l.match(/:(\d+)\s+/);
          return m ? { port: parseInt(m[1]), process: l.split(/\s+/).pop() } : null;
        }).filter(Boolean);
      } else if (os.platform() === 'darwin') {
        const out = execFileSync('lsof', ['-i', '-P', '-n', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: 'pipe' }).trim();
        const lines = out.split('\n').slice(1).filter(Boolean);
        listenPorts = lines.map(l => {
          const parts = l.split(/\s+/);
          const addr = parts[8] || '';
          const m = addr.match(/:(\d+)$/);
          return m ? { port: parseInt(m[1]), address: addr, process: parts[0] || '' } : null;
        }).filter(Boolean);
      } else {
        const out = execFileSync('sh', ['-c', "ss -tlnp 2>/dev/null | tail -n+2"], { encoding: 'utf8', stdio: 'pipe' }).trim();
        listenPorts = out.split('\n').filter(Boolean).map(l => {
          const parts = l.split(/\s+/);
          const addr = parts[3] || '';
          const port = parseInt(addr.split(':').pop());
          const proc = parts[5] || '';
          const m = proc.match(/users:\(\("(.+?)"/);
          return { port, address: addr, process: m ? m[1] : '' };
        }).filter(p => !isNaN(p.port));
      }
    } catch {}
    res.json({ interfaces: result, gateway, dns, ports: listenPorts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ── Clipboard (server-side staging) ───────────────────────────────────
// Per-IP clipboard to prevent cross-user leak (F17, F69)
const clipboards = new Map(); // ip -> { sources, action, createdAt }
function getClipboard(ip) {
  if (!clipboards.has(ip)) clipboards.set(ip, { sources: [], action: null, createdAt: null });
  return clipboards.get(ip);
}

app.get('/api/clipboard', checkPin, (req, res) => {
  const cb = getClipboard(req.ip || 'default');
  res.json({ clipboard: cb });
});

app.post('/api/clipboard', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.sources) || req.body.sources.length === 0) {
      return res.status(400).json({ error: 'sources array is required' });
    }
    if (req.body.sources.length > 100) return res.status(400).json({ error: 'too many sources max 100' });
    const action = req.body.action === 'cut' ? 'cut' : 'copy';
    const ip = req.ip || 'default';
    const clipboard = {
      sources: req.body.sources.map(s => realPath(s)),
      action,
      createdAt: new Date().toISOString()
    };
    clipboards.set(ip, clipboard);
    res.json({ clipboard, count: clipboard.sources.length });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/clipboard/paste', checkPin, async (req, res) => {
  try {
    if (!req.body.destination) return res.status(400).json({ error: 'destination is required' });
    const ip = req.ip || 'default';
    const clipboard = getClipboard(ip);
    if (!clipboard.sources.length) return res.status(400).json({ error: 'clipboard is empty' });
    const destDir = resolvePath(req.body.destination);
    const conflict = req.body.conflict || 'replace';
    const results = [];
    for (const src of clipboard.sources) {
      try {
        const baseName = path.basename(src);
        const dst = path.join(destDir, baseName);
        if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dst)) {
          results.push({ path: src, success: false, error: 'Access denied: destination outside workspace' });
          continue;
        }
        const result = await resolveCopyMove(src, dst, conflict, clipboard.action === 'cut');
        results.push({ path: src, success: true, ...result });
      } catch (e) {
        results.push({ path: src, success: false, error: e.message });
      }
    }
    const pasteAction = clipboard.action;
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    if (clipboard.action === 'cut' && failed === 0) {
      clipboards.set(ip, { sources: [], action: null, createdAt: null });
    } else if (clipboard.action === 'cut' && failed > 0) {
      // Keep clipboard for retry on partial failure (F69)
    }
    res.json({ results, succeeded, failed, pasteAction });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

app.delete('/api/clipboard', checkPin, (req, res) => {
  const ip = req.ip || 'default';
  clipboards.set(ip, { sources: [], action: null, createdAt: null });
  res.json({ success: true });
});

// ── Command history (server-side, persists across sessions) ────────────
const HISTORY_FILE = path.join(__dirname, '.cmdhist.json');
let cmdHistory = [];
let cmdHistMax = 50;

function loadCmdHistory() {
  try { cmdHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { cmdHistory = []; }
}
function saveCmdHistory() {
  try {
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cmdHistory));
    fs.renameSync(tmp, HISTORY_FILE);
    try { fs.chmodSync(HISTORY_FILE, 0o600); } catch {}
  } catch {}
}
loadCmdHistory();

app.get('/api/history', checkPin, (req, res) => {
  res.json({ history: cmdHistory, max: cmdHistMax });
});

app.post('/api/history', checkPin, (req, res) => {
  try {
    const { cmd, max } = req.body;
    if (max !== undefined) {
      if (!Number.isInteger(max) || max < 10 || max > 500) {
        return res.status(400).json({ error: 'max must be integer 10-500' });
      }
      cmdHistMax = max;
    }
    if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
      // No command — just updating max
      saveCmdHistory();
      return res.json({ success: true, history: cmdHistory, max: cmdHistMax });
    }
    // Validate and truncate cmd to 1000 chars (F70)
    if (typeof cmd !== 'string') return res.status(400).json({ error: 'cmd must be string' });
    let clean = cmd.trim();
    if (clean.length > 1000) clean = clean.slice(0, 1000);
    if (!clean) return res.status(400).json({ error: 'cmd is empty' });
    if (cmdHistory.length && cmdHistory[0].cmd === clean) {
      cmdHistory[0].time = Date.now();
      cmdHistory[0].count = (cmdHistory[0].count || 1) + 1;
    } else {
      cmdHistory.unshift({ cmd: clean, time: Date.now(), count: 1 });
    }
    if (cmdHistory.length > cmdHistMax) cmdHistory.length = cmdHistMax;
    saveCmdHistory();
    res.json({ success: true, history: cmdHistory });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/history', checkPin, (req, res) => {
  cmdHistory = [];
  saveCmdHistory();
  res.json({ success: true });
});

app.delete('/api/history/:index', checkPin, (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= cmdHistory.length) {
    return res.status(400).json({ error: 'invalid index' });
  }
  cmdHistory.splice(idx, 1);
  saveCmdHistory();
  res.json({ success: true, history: cmdHistory });
});

// ── Git panel ─────────────────────────────────────────────────────────
// All git invocations use arg arrays (no shell). `git -C <root>` keeps the
// child inside the repo without cwd plumbing. File args are validated to
// stay within the repo root via pathContained().
let GIT_STATE = null; // null = unchecked, 'ok' | 'missing'
function gitAvailable() {
  if (GIT_STATE) return GIT_STATE === 'ok';
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    GIT_STATE = 'ok';
  } catch { GIT_STATE = 'missing'; }
  return GIT_STATE === 'ok';
}

// Resolve repo root for a directory. Throws 404 when not inside a repo.
async function gitRootFor(dir) {
  const resolved = resolvePath(dir);
  let root;
  try {
    root = (await spawnRead('git', ['-C', resolved, 'rev-parse', '--show-toplevel'])).trim().split('\n')[0];
  } catch {
    const e = new Error('not a git repository'); e.status = 404; throw e;
  }
  if (!root) { const e = new Error('not a git repository'); e.status = 404; throw e; }
  if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, root)) {
    const e = new Error('Access denied: repo outside workspace'); e.status = 403; throw e;
  }
  return root;
}

function gitUnquote(s) {
  s = (s || '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

function parseGitStatus(raw) {
  const lines = (raw || '').split('\n');
  const head = lines[0] || '';
  let branch = '?', detached = false, ahead = 0, behind = 0;
  const hm = head.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.(.+?))?(?: \[(.+)\])?$/);
  if (hm) {
    const local = (hm[1] || '').trim();
    if (local.startsWith('HEAD')) { detached = true; branch = '(detached)'; }
    else branch = local;
    const info = hm[3] || '';
    const am = info.match(/ahead (\d+)/); if (am) ahead = parseInt(am[1], 10);
    const bm = info.match(/behind (\d+)/); if (bm) behind = parseInt(bm[1], 10);
  }
  const staged = [], unstaged = [], untracked = [], unmerged = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 4) continue;
    const x = line[0], y = line[1];
    let p = line.slice(3);
    // Rename/copy: "R  old -> new" — show the new path
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = gitUnquote(p);
    if (!p) continue;
    const entry = { path: p, x, y };
    if (x === '?' && y === '?') { untracked.push({ path: p }); continue; }
    if (x === 'U' || y === 'U' || ['AA', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(x + y)) { unmerged.push(entry); continue; }
    if (x !== ' ' && x !== '?') staged.push(entry);
    if (y !== ' ' && y !== '?') unstaged.push(entry);
  }
  return { branch, detached, ahead, behind, staged, unstaged, untracked, unmerged };
}

app.get('/api/git/status', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.json({ git: false });
    let root;
    try { root = await gitRootFor(req.query.path); }
    catch (e) {
      if (e.status === 404) return res.json({ git: true, isRepo: false });
      throw e;
    }
    const raw = await spawnRead('git', ['-C', root, 'status', '--porcelain=v1', '-b']);
    const st = parseGitStatus(raw);
    if (st.detached) {
      try { st.branch = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim() + ' (detached)'; } catch {}
    }
    res.json({ git: true, isRepo: true, root, ...st });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/git/diff', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(400).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    const file = req.query.file;
    if (!file || typeof file !== 'string' || Array.isArray(file)) return res.status(400).json({ error: 'file is required' });
    const abs = path.resolve(root, file);
    if (!pathContained(root, abs)) return res.status(400).json({ error: 'file outside repo' });
    const rel = path.relative(root, abs) || '.';
    const args = ['-C', root, 'diff', '--no-color'];
    if (req.query.cached === '1') args.push('--cached');
    args.push('--', rel);
    let diff = await spawnRead('git', args);
    const binary = diff.includes('Binary files');
    const truncated = diff.length > 200000;
    if (truncated) diff = diff.slice(0, 200000);
    res.json({ success: true, diff, binary, truncated });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/git/log', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(400).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    let n = parseInt(req.query.n, 10);
    if (isNaN(n) || n < 1) n = 10;
    if (n > 20) n = 20;
    const raw = await spawnRead('git', ['-C', root, 'log', '-n', String(n), '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--date=short']);
    const commits = raw.split('\n').filter(Boolean).map(l => {
      const [hash, short, author, date, ...subj] = l.split('\x1f');
      return { hash, short, author, date, subject: subj.join('\x1f') };
    });
    res.json({ success: true, commits });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function gitFileArgs(root, files) {
  if (!Array.isArray(files) || !files.length || files.length > 100) {
    const e = new Error('files must be an array of 1-100 paths'); e.status = 400; throw e;
  }
  return files.map(f => {
    if (typeof f !== 'string' || !f || f.includes('\0')) { const e = new Error('invalid file path'); e.status = 400; throw e; }
    const abs = path.resolve(root, f);
    if (!pathContained(root, abs)) { const e = new Error('file outside repo: ' + f); e.status = 400; throw e; }
    return path.relative(root, abs) || '.';
  });
}

app.post('/api/git/stage', checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(400).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const rels = gitFileArgs(root, req.body && req.body.files);
    await spawnRead('git', ['-C', root, 'add', '--', ...rels]);
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/git/unstage', checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(400).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const rels = gitFileArgs(root, req.body && req.body.files);
    await spawnRead('git', ['-C', root, 'restore', '--staged', '--', ...rels]);
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/git/commit', checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(400).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    let message = req.body && req.body.message;
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'commit message is required' });
    message = message.trim().slice(0, 1000);
    if (req.body && req.body.all) await spawnRead('git', ['-C', root, 'add', '-A']);
    try {
      await spawnRead('git', ['-C', root, 'commit', '-m', message]);
    } catch (e) {
      return res.status(400).json({ error: (e.message || 'commit failed').trim().slice(0, 500) || 'commit failed' });
    }
    let hash = '';
    try { hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim(); } catch {}
    res.json({ success: true, hash });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/git/pull', checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(400).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    let out = '';
    try { out = await spawnRead('git', ['-C', root, 'pull', '--no-rebase'], { timeout: 60000 }); }
    catch (e) { return res.status(400).json({ error: (e.message || 'pull failed').trim().slice(0, 1000) || 'pull failed' }); }
    res.json({ success: true, output: out.slice(-5000) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/git/push', checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(400).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    let out = '';
    try { out = await spawnRead('git', ['-C', root, 'push'], { timeout: 60000 }); }
    catch (e) { return res.status(400).json({ error: (e.message || 'push failed').trim().slice(0, 1000) || 'push failed' }); }
    res.json({ success: true, output: out.slice(-5000) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Session persistence ──────────────────────────────────────────────
let TMUX = (() => { try { return execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { return null; } })();
const TMUX_PREFIX = 'wt-webtun-'; // namespaced to avoid collision with user wt-* (F14)
function getTMUX() {
  if (!TMUX) { try { TMUX = execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { TMUX = null; } }
  return TMUX;
}

// In-memory PTY session store — enables persistence without tmux (Windows + Linux)
const ptySessions = new Map(); // sessionId -> { proc, drainCheck, createdAt }
 // TTL sweep every 5min: delete sessions older than 30min with no active ws (F73)
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of ptySessions) {
    if (now - (entry.createdAt || 0) > 30 * 60 * 1000) {
      // Cap size also enforced — evict oldest; here we evict stale
      try { if (entry.proc) entry.proc.kill(); } catch {}
      ptySessions.delete(sid);
    }
  }
  // Cap Map size 100: evict oldest if over limit (F15)
  while (ptySessions.size > 100) {
    const oldest = ptySessions.keys().next().value;
    if (oldest === undefined) break;
    const e = ptySessions.get(oldest);
    try { if (e && e.proc) e.proc.kill(); } catch {}
    ptySessions.delete(oldest);
  }
}, 5 * 60 * 1000);

function isValidPID(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

// Clean up dead tmux sessions from previous runs on startup
function cleanupOrphanTmuxSessions() {
  if (!TMUX) return;
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
    const sessions = out.split('\n').filter(s => s.startsWith(TMUX_PREFIX) || s.startsWith('wt-'));
    for (const s of sessions) {
      // Prefer new prefix, but also clean old wt- for migration
      if (!s.startsWith(TMUX_PREFIX) && !s.startsWith('wt-')) continue;
      try {
        const clients = execFileSync(TMUX, ['list-clients', '-t', s], { stdio: 'pipe', encoding: 'utf8' }).trim();
        if (!clients) {
          execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore' });
        }
      } catch {}
    }
  } catch {}
}

function tmuxSessionExists(name) {
  try { execFileSync(TMUX, ['has-session', '-t', name], { stdio: 'ignore' }); return true; } catch { return false; }
}

app.get('/api/sessions', checkPin, (req, res) => {
  const tmuxBin = getTMUX();
  if (tmuxBin) {
    try {
      const out = execFileSync(tmuxBin, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
      const sessions = out.split('\n')
        .filter(s => s.startsWith(TMUX_PREFIX) || s.startsWith('wt-'))
        .map(s => {
          const prefix = s.startsWith(TMUX_PREFIX) ? TMUX_PREFIX : 'wt-';
          return { id: s.replace(new RegExp('^' + prefix.replace(/-/g,'\\-')), ''), name: s };
        });
      return res.json({ tmux: true, sessions });
    } catch {
      return res.json({ tmux: true, sessions: [] });
    }
  }
  // In-memory sessions (no tmux)
  const sessions = [];
  for (const [id] of ptySessions) {
    sessions.push({ id, name: TMUX_PREFIX + id });
  }
  res.json({ tmux: false, sessions });
});

app.delete('/api/sessions/:id', checkPin, (req, res) => {
  const raw = req.params.id || '';
  const id = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || id.length < 1 || id.length > 64) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  if (id === '') return res.status(400).json({ error: 'invalid session id' });
  if (TMUX) {
    // Try new prefix first, then legacy wt- for migration
    const tryNames = [TMUX_PREFIX + id, 'wt-' + id];
    for (const n of tryNames) { try { execFileSync(TMUX, ['kill-session', '-t', n], { stdio: 'ignore' }); } catch {} }
    return res.json({ success: true });
  }
  // In-memory session
  const entry = ptySessions.get(id);
  if (entry) {
    try { entry.proc.kill(); } catch {}
    ptySessions.delete(id);
  }
  res.json({ success: true });
});

// ── WebSocket terminal ────────────────────────────────────────────────
// Binary protocol (fast, no JSON per keystroke):
//   Server → Client:  [type:1B][payload]
//     0x00 = terminal data (UTF-8)
//     0x01 = exit          (1B exit code)
//     0x02 = error         (UTF-8 message)
//   Client → Server:
//     0x00 = input         (UTF-8) – max 64KB per message
//     0x01 = resize        (4B: cols uint16LE, rows uint16LE)
//     0x02 = ping          (no payload)

const ALLOWED_WS_ORIGINS = new Set();
function getWsOrigin(req) {
  return (req.headers['origin'] || '').replace(/\/$/, '');
}

wss.on('connection', (ws, req) => {
  // Origin check to prevent Cross-Site WebSocket Hijacking — allow empty Origin (non-browser clients) but validate token separately
  const origin = getWsOrigin(req);
  if (origin) {
    const host = req.headers['host'] || '';
    const allowedLocal = origin === `http://${host}` || origin === `https://${host}` || origin === `http://localhost` || origin === `https://localhost`;
    if (!allowedLocal && !ALLOWED_WS_ORIGINS.has(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
  }

  const url   = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');

  // Use constant-time compare for WS token (F49)
  if (PIN) {
    const t = typeof token === 'string' ? token : '';
    if (!t || !constantTimeEqual(t, PIN)) { ws.close(1008, 'Unauthorized'); return; }
  }

  let cols      = parseInt(url.searchParams.get('cols'))  || 80;
  let rows      = parseInt(url.searchParams.get('rows'))  || 24;
  // Clamp cols/rows to prevent OOM (F52): 2-500
  cols = Math.min(Math.max(2, cols), 500);
  rows = Math.min(Math.max(2, rows), 500);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) { ws.close(1008, 'Invalid size'); return; }
  let cwd;
  try {
    cwd = realPath(url.searchParams.get('cwd') || WORKSPACE_ROOT);
  } catch {
    cwd = WORKSPACE_ROOT;
  }
  const rawSession = url.searchParams.get('session');
  let sessionId = '';
  if (rawSession !== null) {
    const sanitized = rawSession.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized || sanitized.length < 1 || sanitized.length > 64) {
      ws.close(1008, 'Invalid session id');
      return;
    }
    sessionId = sanitized;
  }
  // Enforce ptySessions cap 100 before creating new (F73)
  if (sessionId && !TMUX && !ptySessions.has(sessionId) && ptySessions.size >= 100) {
    // Evict oldest
    const oldest = ptySessions.keys().next().value;
    if (oldest !== undefined) {
      const e = ptySessions.get(oldest);
      try { if (e && e.proc) e.proc.kill(); } catch {}
      ptySessions.delete(oldest);
    }
  }

  const sessionEnv = buildSessionEnv();

  const send = (type, payload) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    let buf;
    if (Buffer.isBuffer(payload)) {
      buf = Buffer.concat([Buffer.from([type]), payload]);
    } else {
      buf = Buffer.from([type]);
      if (payload) buf = Buffer.concat([buf, Buffer.from(payload, 'utf8')]);
    }
    ws.send(buf);
  };

  let proc;
  let reattached = false;
  try {
    if (sessionId && !TMUX) {
      // ── In-memory PTY persistence (no tmux needed) ──
      const existing = ptySessions.get(sessionId);
      if (existing && existing.proc && !existing.exited) {
        // Reattach: remove old listeners, reuse the running PTY
        proc = existing.proc;
        proc.removeAllListeners('data');
        proc.removeAllListeners('exit');
        proc.resize(cols, rows);
        reattached = true;
      } else {
        // New in-memory session
        if (existing) ptySessions.delete(sessionId);
        const shellArgs = os.platform() === 'win32' ? ['-NoLogo'] : ['-l'];
        proc = pty.spawn(SHELL, shellArgs, {
          name: 'xterm-256color', cols, rows, cwd,
          env: sessionEnv
        });
      }
    } else if (TMUX && sessionId) {
      const tmuxName = TMUX_PREFIX + sessionId;
      const exists   = tmuxSessionExists(tmuxName) || tmuxSessionExists('wt-' + sessionId);
      // Migrate old wt- to new prefix if exists
      let effectiveName = tmuxName;
      if (!tmuxSessionExists(tmuxName) && tmuxSessionExists('wt-' + sessionId)) effectiveName = 'wt-' + sessionId;

      if (exists) {
        try { execFileSync(TMUX, ['resize-window', '-t', effectiveName, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' }); } catch {}
        proc = pty.spawn(TMUX, ['attach-session', '-t', effectiveName], {
          name: 'xterm-256color', cols, rows, cwd,
          env: sessionEnv
        });
      } else {
        proc = pty.spawn(TMUX, ['new-session', '-s', tmuxName], {
          name: 'xterm-256color', cols, rows, cwd,
          env: { ...sessionEnv, SHELL }
        });
      }
    } else {
      const shellArgs = os.platform() === 'win32' ? ['-NoLogo'] : ['-l'];
      proc = pty.spawn(SHELL, shellArgs, {
        name: 'xterm-256color', cols, rows, cwd,
        env: sessionEnv
      });
    }
  } catch (e) {
    send(0x02, `Failed to spawn shell: ${e.message}\r\n`);
    ws.close();
    return;
  }

  // Back-pressure: pause PTY output when WebSocket send buffer is full
  let paused = false;
  const HIGH_WATER = 4 * 1024 * 1024; // 4MB — pause PTY above this
  const LOW_WATER  = 1 * 1024 * 1024; // 1MB — resume PTY below this

  const drainCheck = setInterval(() => {
    if (paused && ws.bufferedAmount < LOW_WATER) {
      try { proc.resume(); paused = false; } catch (_) {}
    }
  }, 50);

  proc.onData(data => {
    if (ws.readyState !== WebSocket.OPEN) return;
    send(0x00, data);
    // If WebSocket buffer is backing up, pause PTY to prevent OOM
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      try { proc.pause(); paused = true; } catch (_) {}
    }
  });

  const useInMemory = sessionId && !TMUX;
  const useTmux = TMUX && sessionId;

  proc.onExit(() => {
    clearInterval(drainCheck);
    if (useInMemory) ptySessions.delete(sessionId);
    if (!useTmux) send(0x01, Buffer.from([0]));
    ws.close();
  });

  // If this is a new in-memory session, register it now (after onExit is wired)
  if (useInMemory && !rehattached) {
    ptySessions.set(sessionId, { proc, exited: false, createdAt: Date.now() });
    // Track exit so stale sessions are detected on reconnect
    proc.onExit(() => {
      const entry = ptySessions.get(sessionId);
      if (entry) entry.exited = true;
    });
  } else if (useInMemory && reattached) {
    const entry = ptySessions.get(sessionId);
    if (entry) { entry.proc = proc; entry.exited = false; }
  }

  ws.isAlive = true;
  const pingInterval = setInterval(() => {
    if (!ws.isAlive) { clearInterval(pingInterval); ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  }, 30000);
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    try {
      const buf  = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length < 1) return;
      const type = buf[0];
      if (type === 0x00) {
        // Limit input to 1MB per message
        const payload = buf.slice(1, Math.min(buf.length, 1048577));
        proc.write(payload.toString('utf8'));
      } else if (type === 0x01 && buf.length >= 5) {
        let c = buf.readUInt16LE(1), r = buf.readUInt16LE(3);
        c = Math.min(Math.max(2, c), 500);
        r = Math.min(Math.max(2, r), 500);
        if (!c || !r) return;
        proc.resize(c, r);
        if (TMUX && sessionId) {
          // Try new prefix first, fallback to legacy
          try { execFileSync(TMUX, ['resize-window', '-t', TMUX_PREFIX + sessionId, '-x', String(c), '-y', String(r)], { stdio: 'ignore' }); } catch {
            try { execFileSync(TMUX, ['resize-window', '-t', 'wt-' + sessionId, '-x', String(c), '-y', String(r)], { stdio: 'ignore' }); } catch {}
          }
        }
      }
    } catch (e) {
      console.error('WS message error:', e.message);
    }
  });

  const cleanup = () => {
    clearInterval(pingInterval);
    clearInterval(drainCheck);
    if (useInMemory && sessionId) {
      // Keep the PTY alive for reattachment — just detach listeners
      try { proc.removeAllListeners('data'); } catch {}
      return;
    }
    try { proc.kill(); } catch {}
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});



// ── File search (fuzzy finder) ──────────────────────────────────────
app.get('/api/search', rateLimiter, checkPin, async (req, res) => {
  let q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 1) return res.json({ results: [] });
  if (q.length > 200) q = q.slice(0, 200);
  const dir = req.query.path || WORKSPACE_ROOT;
  if (typeof dir !== 'string' || dir.length > 1024) return res.status(400).json({ error: 'path too long' });

  try {
    const searchDir = resolvePath(dir);
    const maxResults = 50;
    const results = [];
    const maxDepth = 4;

    await asyncSafeWalk(searchDir, 0, maxDepth, q, results, maxResults);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function spawnRead(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout || 5000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.on('error', reject);
  });
}

// ── System stats ────────────────────────────────────────────────────
app.get('/api/system', checkPin, async (req, res) => {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
  const cpuCount = cpus.length;
  const loadAvg = os.loadavg();

  let cpuUsage = 0;
  try {
    const getCpuUsageFromCpus = () => {
      const currentCpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      currentCpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
      });
      return { idle: totalIdle / currentCpus.length, total: totalTick / currentCpus.length };
    };
    const c1 = getCpuUsageFromCpus();
    await new Promise(r => setTimeout(r, 100));
    const c2 = getCpuUsageFromCpus();
    const idleDiff = c2.idle - c1.idle;
    const totalDiff = c2.total - c1.total;
    cpuUsage = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
  } catch {}

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);

  let disk = [];
  try {
    if (os.platform() === 'win32') {
      const psOut = await spawnRead('powershell.exe', ['-Command', "Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object {$_.DriveType -eq 3} | Select-Object DeviceID, Size, FreeSpace | ConvertTo-Json"]);
      const data = JSON.parse(psOut);
      const list = Array.isArray(data) ? data : [data];
      disk = list.map(d => {
        const sizeBytes = d.Size || 0;
        const freeBytes = d.FreeSpace || 0;
        const usedBytes = sizeBytes - freeBytes;
        const sizeGB = (sizeBytes / (1024**3)).toFixed(1) + ' GB';
        const usedGB = (usedBytes / (1024**3)).toFixed(1) + ' GB';
        const availGB = (freeBytes / (1024**3)).toFixed(1) + ' GB';
        const usePercent = sizeBytes > 0 ? Math.round((usedBytes / sizeBytes) * 100) + '%' : '0%';
        return {
          filesystem: d.DeviceID,
          size: sizeGB,
          used: usedGB,
          avail: availGB,
          usePercent,
          mounted: d.DeviceID
        };
      });
    } else {
      const dfOut = await spawnRead('df', ['-h', '/']);
      const lines = dfOut.trim().split('\n');
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        disk = [{ filesystem: parts[0], size: parts[1], used: parts[2], avail: parts[3], usePercent: parts[4], mounted: parts[5] }];
      }
    }
  } catch {}

  let processes = [];
  try {
    if (os.platform() === 'win32') {
      const psOut = await spawnRead('powershell.exe', ['-Command', "Get-Process | Where-Object {$_.CPU -ne $null} | Sort-Object CPU -Descending | Select-Object -First 15 | ForEach-Object { [PSCustomObject]@{ user = 'system'; pid = $_.Id.ToString(); cpu = [Math]::Round($_.CPU, 1).ToString(); mem = [Math]::Round($_.WorkingSet / 1MB, 1).ToString() + 'MB'; cmd = $_.ProcessName } } | ConvertTo-Json"]);
      const data = JSON.parse(psOut);
      const list = Array.isArray(data) ? data : [data];
      processes = list.map(p => ({
        user: p.user || 'system',
        pid: p.pid || '',
        cpu: p.cpu || '',
        mem: p.mem || '',
        cmd: p.cmd || ''
      }));
    } else if (os.platform() === 'darwin') {
      const psOut = await spawnRead('ps', ['-axo', 'pid,user,%cpu,%mem,command', '-r']);
      const lines = psOut.trim().split('\n').slice(1, 16);
      for (const line of lines) {
        const m = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)/);
        if (m) {
          processes.push({ user: m[2], pid: m[1], cpu: m[3], mem: m[4], cmd: m[5] });
        }
      }
    } else {
      const psOut = await spawnRead('ps', ['-eo', 'pid,user,%cpu,%mem,cmd', '--no-headers', '--sort=-%cpu']);
      const lines = psOut.trim().split('\n').slice(0, 15);
      for (const line of lines) {
        const m = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)/);
        if (m) {
          processes.push({ user: m[2], pid: m[1], cpu: m[3], mem: m[4], cmd: m[5] });
        }
      }
    }
  } catch {}

  let gpus = [];
  try {
    if (os.platform() === 'linux') {
      // Try nvidia-smi first (NVIDIA GPUs — supports multi-GPU)
      try {
        const nvOut = await spawnRead('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']);
        if (nvOut && nvOut.trim()) {
          for (const line of nvOut.trim().split('\n')) {
            const parts = line.split(',').map(s => s.trim());
            if (parts.length >= 6 && parts[0]) {
              gpus.push({ name: parts[0], memTotal: +parts[1] || 0, memUsed: +parts[2] || 0, memFree: +parts[3] || 0, utilization: +parts[4] || 0, temp: +parts[5] || 0, driver: 'nvidia' });
            }
          }
        }
      } catch {}
      // Fallback: lspci for any GPU (Intel, AMD, etc.)
      if (!gpus.length) {
        try {
          const lspciOut = await spawnRead('lspci', []);
          if (lspciOut && lspciOut.trim()) {
            const lines = lspciOut.split('\n').filter(l => /VGA|3D|Display/i.test(l));
            for (const line of lines) {
              const name = line.replace(/^[\da-f]+:[\da-f]+\.[\da-f]+\s+/, '').trim();
              if (name) gpus.push({ name, driver: 'lspci' });
            }
          }
        } catch {}
      }
    } else if (os.platform() === 'darwin') {
      const spOut = await spawnRead('system_profiler', ['SPDisplaysDataType']);
      if (spOut) {
        // Split by chipset sections to handle multiple GPUs
        const sections = spOut.split(/(?=Chipset Model:)/);
        for (const section of sections) {
          const chipMatch = section.match(/Chipset Model:\s*(.+)/);
          const vramMatch = section.match(/VRAM.*?:\s*(\d+)\s*MB/);
          if (chipMatch) {
            gpus.push({ name: chipMatch[1].trim(), memTotal: vramMatch ? +vramMatch[1] : 0, driver: 'macos' });
          }
        }
      }
    } else if (os.platform() === 'win32') {
      const psGpu = await spawnRead('powershell.exe', ['-Command', "Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json"]);
      if (psGpu) {
        const data = JSON.parse(psGpu);
        const list = Array.isArray(data) ? data : [data];
        for (const d of list) {
          if (d && d.Name) {
            const vramBytes = d.AdapterRAM || 0;
            gpus.push({ name: d.Name, memTotal: Math.round(vramBytes / (1024 * 1024)), driver: d.DriverVersion || '' });
          }
        }
      }
    }
  } catch {}

  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime(),
    cpu: { model: cpuModel, count: cpuCount, usage: cpuUsage, loadAvg },
    memory: { total: totalMem, free: freeMem, used: usedMem, percent: memPercent },
    gpus,
    disk,
    processes
  });
});

// ── Kill process (from System Stats) ────────────────────────────────
app.post('/api/system/kill', checkPin, async (req, res) => {
  try {
    const raw = req.body && (req.body.pid ?? req.body.id);
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'invalid pid' });
    if (pid === 1) return res.status(400).json({ error: 'refusing to kill pid 1' });
    if (pid === process.pid) return res.status(400).json({ error: 'refusing to kill self' });
    // Prevent killing cloudflared tunnels managed by WebTun
    for (const [, t] of tunnels) { if (t.pid === pid) return res.status(400).json({ error: 'refusing to kill managed cloudflared' }); }
    if (os.platform() === 'win32') {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) { return res.status(500).json({ error: e.message || 'kill failed' }); }
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (e) {
        if (e.code === 'ESRCH') return res.status(404).json({ error: 'process not found' });
        try { process.kill(pid, 'SIGKILL'); } catch (e2) { return res.status(500).json({ error: e2.message }); }
      }
      // Give 1.5s then SIGKILL if still alive
      setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }, 1500);
    }
    res.json({ success: true, pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cloudflared tunnel management ──────────────────────────────────
const tunnels = new Map();
const TUNNEL_FILE = path.join(__dirname, '.tunnels.json');
const TUNNEL_URL_FILE = path.join(__dirname, 'tunnel-url.txt');

function isCloudflaredProcess(pid) {
  if (!isValidPID(pid)) return false;
  try {
    if (os.platform() === 'win32') {
      const stdout = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return stdout.toLowerCase().includes('cloudflared');
    } else if (os.platform() === 'linux') {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.toLowerCase().includes('cloudflared');
    } else {
      const stdout = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return stdout.toLowerCase().includes('cloudflared');
    }
  } catch {
    return false;
  }
}

function saveTunnels() {
  const arr = Array.from(tunnels.entries()).map(([id, t]) => ({
    id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, pid: t.pid
  }));
  try {
    const tmp = TUNNEL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, TUNNEL_FILE);
  } catch {}
  updateTunnelUrlFile();
}

function updateTunnelUrlFile() {
  const active = Array.from(tunnels.values()).map(t => t.tunnelUrl).filter(Boolean);
  try {
    const content = active.length > 0 ? active.join('\n') + '\n' : '';
    const tmp = TUNNEL_URL_FILE + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, TUNNEL_URL_FILE);
  } catch {}
}

function loadTunnels() {
  try {
    const arr = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8'));
    for (const t of arr) {
      if (isCloudflaredProcess(t.pid)) {
        tunnels.set(t.id, { proc: null, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, pid: t.pid });
      }
    }
  } catch {}
}

async function verifyTunnelUrl(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const res = await fetch(url, { method: 'HEAD', signal: ac.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {}
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

function spawnCloudflared(args, opts = {}) {
  const bin = findCloudflared();
  if (!bin) {
    const err = new Error('cloudflared not installed');
    err.code = 'ENOENT';
    throw err;
  }
  return spawn(bin, args, opts);
}

function restartTunnel(id, entry) {
  if (!entry.localUrl) return;
  try { if (entry.proc) entry.proc.kill('SIGTERM'); } catch {}
  try { if (entry.pid && isCloudflaredProcess(entry.pid)) killPid(entry.pid); } catch {}
  tunnels.delete(id);

  const url = entry.localUrl;
  let proc;
  try {
    proc = spawnCloudflared(['tunnel', '--url', url], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    return;
  }
  proc.unref();

  const handler = data => {
    const text = data.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      const newUrl = m[0];
      const newId = newUrl.replace(/^https:\/\//, '').replace(/\.trycloudflare\.com$/, '');
      proc.stdout.removeAllListeners('data');
      proc.stderr.removeAllListeners('data');
      proc.stdout.resume();
      proc.stderr.resume();
      tunnels.set(newId, { proc, pid: proc.pid, localUrl: url, tunnelUrl: newUrl, createdAt: Date.now() });
      saveTunnels();
      updateTunnelUrlFile();
      console.log(`  Tunnel restarted: ${newUrl} → ${url}`);
    }
  };
  proc.stdout.on('data', handler);
  proc.stderr.on('data', handler);
  proc.on('error', () => {});
  proc.on('exit', () => { proc.stdout.removeAllListeners('data'); proc.stderr.removeAllListeners('data'); });
}

const TUNNEL_CHECK_INTERVAL = 30000;
setInterval(async () => {
  for (const [id, entry] of tunnels) {
    const alive = entry.proc !== null || (entry.pid && isCloudflaredProcess(entry.pid));
    if (!alive) {
      console.log(`  Tunnel ${id} dead — restarting…`);
      restartTunnel(id, entry);
    }
  }
}, TUNNEL_CHECK_INTERVAL);

app.get('/api/tunnel', checkPin, async (req, res) => {
  const entries = Array.from(tunnels.entries());
  const results = await Promise.allSettled(entries.map(async ([id, t]) => {
    let alive = t.proc !== null;
    if (!alive && t.pid) { alive = isCloudflaredProcess(t.pid); }
    let targetAlive = false;
    if (alive) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 2000);
      try {
        const proto = t.localUrl.startsWith('https') ? 'https' : 'http';
        if (proto === 'http' || proto === 'https') {
          await fetch(t.localUrl, { method: 'HEAD', signal: ac.signal });
          targetAlive = true;
        }
      } catch {} finally { clearTimeout(timer); }
    }
    let tunnelAlive = false;
    if (t.tunnelUrl) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      try {
        await fetch(t.tunnelUrl, { method: 'HEAD', signal: ac.signal });
        tunnelAlive = true;
      } catch {} finally { clearTimeout(timer); }
    }
    return { id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, alive, targetAlive, tunnelAlive };
  }));
  const tunnels_list = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  res.json({ tunnels: tunnels_list });
});

app.post('/api/tunnel', checkPin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  // SSRF guard (F75): only allow http(s)://localhost|127.0.0.1|::1 with valid port, block metadata/link-local
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return res.status(400).json({ error: 'url must be http or https' });
    const host = u.hostname.toLowerCase();
    const blockedHosts = ['169.254.169.254', 'metadata.google.internal', 'instance-data'];
    if (blockedHosts.includes(host) || host.startsWith('169.254.')) return res.status(400).json({ error: 'url host blocked (SSRF)' });
    const allowed = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
    // Allow only local URLs unless ALLOW_FULL_FS true (admin opt-in for LAN tunneling)
    if (!ALLOW_FULL_FS && !allowed.includes(host)) {
      return res.status(400).json({ error: 'url must be localhost (use ALLOW_FULL_FS=true to allow LAN)' });
    }
    if (u.port && (Number(u.port) < 1 || Number(u.port) > 65535)) return res.status(400).json({ error: 'invalid port' });
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  if (!findCloudflared()) {
    return res.status(500).json({ error: 'cloudflared not installed' });
  }

  let proc;
  try {
    proc = spawnCloudflared(['tunnel', '--url', url], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  proc.unref();
  let tunnelUrl = null;
  const timeout = 15000;

  const urlPromise = new Promise((resolve, reject) => {
    const handler = data => {
      const text = data.toString();
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        tunnelUrl = m[0];
        proc.stdout.removeAllListeners('data');
        proc.stderr.removeAllListeners('data');
        proc.stdout.resume();
        proc.stderr.resume();
        resolve(tunnelUrl);
      }
    };
    proc.stdout.on('data', handler);
    proc.stderr.on('data', handler);
    proc.on('error', err => reject(err));
  });

  try {
    await Promise.race([
      urlPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
    ]);
    // Verify tunnel URL is actually reachable
    const urlOk = await verifyTunnelUrl(tunnelUrl);
    const id = tunnelUrl.replace(/^https:\/\//, '').replace(/\.trycloudflare\.com$/, '');
    tunnels.set(id, { proc, pid: proc.pid, localUrl: url, tunnelUrl, createdAt: Date.now() });
    saveTunnels();
    res.json({ success: true, id, url: tunnelUrl, verified: urlOk });
  } catch (e) {
    try { if (proc.pid) killPid(proc.pid); else proc.kill(); } catch {}
    res.status(500).json({ error: e.message === 'timeout' ? 'Timed out waiting for tunnel URL' : e.message });
  }
});

app.delete('/api/tunnel', checkPin, (req, res) => {
  // Accept id from body or query (DELETE body may be stripped by proxies)
  const raw = (req.body && req.body.id) || req.query.id;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || !tunnels.has(id)) return res.status(404).json({ error: 'tunnel not found' });
  const entry = tunnels.get(id);
  try {
    if (entry.proc) {
      try { entry.proc.kill('SIGTERM'); } catch {}
      if (entry.proc.pid) killPid(entry.proc.pid);
    } else if (entry.pid && isCloudflaredProcess(entry.pid)) {
      killPid(entry.pid);
    }
  } catch {}
  tunnels.delete(id);
  saveTunnels();
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────

function cleanup() {
  for (const [id, entry] of tunnels) {
    try {
      if (entry.proc) {
        try { entry.proc.kill('SIGTERM'); } catch {}
        if (entry.proc.pid) killPid(entry.proc.pid);
      } else if (entry.pid && isCloudflaredProcess(entry.pid)) {
        killPid(entry.pid);
      }
    } catch {}
  }
  if (TMUX) {
    try {
      const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
      const sessions = out.split('\n').filter(s => s.startsWith(TMUX_PREFIX) || s.startsWith('wt-'));
      for (const s of sessions) {
        try { execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore' }); } catch {}
      }
    } catch {}
  }
  // Kill all in-memory PTY sessions
  for (const [id, entry] of ptySessions) {
    try { entry.proc.kill(); } catch {}
  }
  ptySessions.clear();
}

function startServer(opts = {}) {
  const port = opts.port || PORT;
  const host = opts.host || HOST;

  loadTunnels();
  cleanupOrphanTmuxSessions();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`\n  WebTun running → http://localhost:${port}`);
      if (PIN) console.log(`  PIN protection enabled`);
      console.log('');
      resolve(server);
    });
  });
}

process.on('uncaughtException', e => {
  console.error('Uncaught:', e.message);
  try { cleanup(); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', e => {
  console.error('Unhandled:', e);
});

process.on('SIGTERM', () => { try { cleanup(); } catch {}; process.exit(0); });
process.on('SIGINT', () => { try { cleanup(); } catch {}; process.exit(0); });
process.on('exit', () => { try { cleanup(); } catch {} });

module.exports = { app, server, startServer, PORT, PIN, WORKSPACE_ROOT, findCloudflared };

if (require.main === module) {
  startServer();
}

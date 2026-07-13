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
    const val = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  });
} catch {}

const express = require('express');
const http = require('http');
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
  console.error('    Linux:  sudo apt-get install -y python3 make g++');
  console.error('    macOS:  xcode-select --install');
  console.error('');
  process.exit(1);
}
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, execFileSync, spawn } = require('child_process');

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
  '.env':'text/plain','.lock':'text/plain',
};
function mimeLookup(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// In-memory rate limiter factory
const rateLimitWindows = new Map();
function createRateLimiter(opts) {
  return (req, res, next) => {
    if (opts.skipWhenNoPin && !PIN) return next();
    const now = Date.now();
    const key = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'default';
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
const PIN = process.env.PIN || '';
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh'));
const HOST = process.env.HOST || '0.0.0.0';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : os.homedir();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https://*.trycloudflare.com wss:; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:;");
  next();
});

// Trust proxy for proper IP detection behind reverse proxy
app.set('trust proxy', 1);

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Auth ──────────────────────────────────────────────────────────────
function checkPin(req, res, next) {
  if (!PIN) return next();
  const token = (req.headers['x-pin-token'] || req.query.token || '').trim();
  if (token && constantTimeEqual(token, PIN)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/auth/required', (req, res) => {
  res.json({ required: !!PIN });
});

app.post('/api/auth', authRateLimiter, (req, res) => {
  const { pin } = req.body;
  if (!PIN || (pin && constantTimeEqual(pin, PIN))) {
    res.json({ success: true, token: PIN || 'open' });
  } else {
    res.status(401).json({ error: 'Invalid PIN' });
  }
});

// ── System info ───────────────────────────────────────────────────────
app.get('/api/home', checkPin, (req, res) => {
  res.json({ home: os.homedir(), hostname: os.hostname(), platform: os.platform() });
});

// ── File API ──────────────────────────────────────────────────────────
const fsPromises = fs.promises;

function resolvePath(targetPath) {
  if (!targetPath) return WORKSPACE_ROOT;
  return path.resolve(targetPath);
}

// Resolve path and follow symlinks to their real location.
// Used for write operations so files end up at the intended real path.
function realPath(targetPath) {
  if (!targetPath) return WORKSPACE_ROOT;
  const resolved = path.resolve(targetPath);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
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
                name: e.name, path: full, isDir: e.isDirectory(),
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
    const files = await Promise.all(
      entries.map(async e => {
        const full = path.join(dir, e.name);
        const st = await safeStat(full);
        return {
          name: e.name,
          path: full,
          isDir: e.isDirectory(),
          isSymlink: e.isSymbolicLink(),
          size: st ? st.size : 0,
          modified: st ? st.mtime : null,
          ext: path.extname(e.name).toLowerCase()
        };
      })
    );
    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent !== dir ? parent : null, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/rename', checkPin, async (req, res) => {
  try {
    if (!req.body.oldPath || !req.body.newName) {
      console.warn('POST /api/files/rename 400 — body requires { oldPath, newName }. Example: { "oldPath": "/home/user/file.txt", "newName": "renamed.txt" }');
      return res.status(400).json({ error: 'oldPath and newName are required', usage: 'POST JSON { "oldPath": "<path>", "newName": "<name>" }' });
    }
    const oldPath = realPath(req.body.oldPath);
    const newPath = realPath(path.join(path.dirname(oldPath), req.body.newName));
    await fsPromises.rename(oldPath, newPath);
    res.json({ success: true, newPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      await fsPromises.rename(src, dst);
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
  if (!req.body.source || !req.body.destination) {
    return res.status(400).json({ error: 'source and destination are required', usage: 'POST JSON { "source": "<src>", "destination": "<dst>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
  }
  const src = realPath(req.body.source);
  const dst = resolvePath(req.body.destination);
  const result = await resolveCopyMove(src, dst, req.body.conflict || '', isMove);
  res.json(result);
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
    const st = await fsPromises.stat(p);
    if (st.isDirectory()) {
      await fsPromises.rm(p, { recursive: true, force: true });
    } else {
      await fsPromises.unlink(p);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    const baseName = path.basename(p);
    let zipName = baseName + '.zip';
    let zipPath = path.join(path.dirname(p), zipName);
    let counter = 1;
    while (true) {
      try { await fsPromises.access(zipPath); } catch { break; }
      zipName = baseName + ' (' + counter + ').zip';
      zipPath = path.join(path.dirname(p), zipName);
      counter++;
    }
    const zipDir = path.dirname(zipPath);
    const zipTarget = path.basename(zipPath);
    if (st.isDirectory()) {
      execSync(`zip -r -6 "${zipTarget}" "${baseName}"`, { cwd: zipDir, stdio: 'pipe' });
    } else {
      execSync(`zip -6 "${zipTarget}" "${baseName}"`, { cwd: zipDir, stdio: 'pipe' });
    }
    res.json({ success: true, name: zipName });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    const destDir = path.join(path.dirname(p), path.basename(p, '.zip'));
    await fsPromises.mkdir(destDir, { recursive: true });
    // Security: scan zip entries before extraction
    const unzipList = execSync(`unzip -l "${p}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    for (const line of unzipList.split('\n')) {
      const match = line.match(/^\s*\S+\s+\S+\s+(.+)$/);
      if (match) {
        const entryPath = path.normalize(match[1]);
        if (entryPath.startsWith('..') || path.isAbsolute(entryPath)) {
          return res.status(400).json({ error: 'Invalid zip entry: ' + match[1] });
        }
        const target = path.join(destDir, entryPath);
        if (!target.startsWith(destDir + path.sep) && target !== destDir) {
          return res.status(400).json({ error: 'Zip entry escapes destination directory' });
        }
      }
    }
    try {
      execSync(`unzip -o "${p}" -d "${destDir}"`, { stdio: 'pipe' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    res.json({ success: true, dir: destDir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/read', checkPin, async (req, res) => {
  try {
    const p = resolvePath(req.query.path);
    const [content, st] = await Promise.all([
      fsPromises.readFile(p, 'utf8'),
      fsPromises.stat(p)
    ]);
    res.json({ content, length: st.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/write', checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/write 400 — body requires { path, content }. Example: { "path": "/home/user/file.txt", "content": "hello world" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file>", "content": "<string>" }' });
    }
    const p = realPath(req.body.path);
    await fsPromises.writeFile(p, req.body.content, 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve image files for inline viewing (not as download)
app.get('/api/files/image', checkPin, async (req, res) => {
  try {
    const p = resolvePath(req.query.path);
    const mimeType = mimeLookup(p);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = fs.createReadStream(p);
    stream.on('error', err => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
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
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}.zip"`);
      // Stream zip to response via system zip command
      const zipProc = spawn('zip', ['-r', '-6', '-', path.basename(p)], { cwd: path.dirname(p), stdio: ['ignore', 'pipe', 'pipe'] });
      zipProc.stdout.pipe(res);
      zipProc.on('error', err => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      zipProc.on('close', code => { if (code !== 0 && !res.headersSent) res.status(500).json({ error: 'zip failed' }); });
      return;
    } else {
      const mimeType = mimeLookup(p);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`);
      const stream = fs.createReadStream(p);
      stream.on('error', err => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      stream.pipe(res);
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
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
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9_.\-]/g, '_');
        const finalDest = path.join(destDir, safeName);
        if (!finalDest.startsWith(destDir + path.sep) && finalDest !== destDir) {
          return cb(new Error('Invalid upload destination'));
        }
        const subPath = path.dirname(finalDest);
        fs.mkdirSync(subPath, { recursive: true });
        cb(null, subPath);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_, file, cb) => cb(null, path.basename(file.originalname).replace(/[^a-zA-Z0-9_.\-]/g, '_'))
  });
  const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024, files: 100 } }).array('files');
  upload(req, res, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, count: Array.isArray(req.files) ? req.files.length : 0 });
  });
});

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
    try {
      stat.owner = execFileSync('id', ['-nu', String(st.uid)], { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch { stat.owner = String(st.uid); }
    try {
      stat.group = execFileSync('getent', ['group', String(st.gid)], { encoding: 'utf8', stdio: 'pipe' }).split(':')[0];
    } catch { stat.group = String(st.gid); }
    try {
      const symlink = lst && lst.isSymbolicLink() ? await fsPromises.readlink(p) : null;
      if (symlink) stat.linkTarget = symlink;
    } catch {}
    res.json(stat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Folder size ──────────────────────────────────────────────────────
app.get('/api/files/size', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/size?path=<dir>' });
    }
    const p = realPath(req.query.path);
    const st = await fsPromises.stat(p);
    if (!st.isDirectory()) {
      return res.json({ path: p, size: st.size, isDir: false });
    }
    const out = execFileSync('du', ['-sb', p], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
    const size = parseInt(out.split('\t')[0], 10);
    res.json({ path: p, size, isDir: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Batch delete ──────────────────────────────────────────────────────
app.post('/api/files/batch-delete', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.paths) || req.body.paths.length === 0) {
      console.warn('POST /api/files/batch-delete 400 — body requires { paths: [...] }');
      return res.status(400).json({ error: 'paths array is required', usage: 'POST JSON { "paths": ["<path1>", "<path2>", ...] }' });
    }
    const results = [];
    for (const raw of req.body.paths) {
      const p = realPath(raw);
      try {
        const st = await fsPromises.stat(p);
        if (st.isDirectory()) await fsPromises.rm(p, { recursive: true, force: true });
        else await fsPromises.unlink(p);
        results.push({ path: raw, success: true });
      } catch (e) {
        results.push({ path: raw, success: false, error: e.message });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Batch copy ────────────────────────────────────────────────────────
async function handleBatchCopyMove(req, res, isMove) {
  if (!Array.isArray(req.body.sources) || req.body.sources.length === 0 || !req.body.destination) {
    return res.status(400).json({ error: 'sources array and destination are required', usage: 'POST JSON { "sources": ["<src1>", ...], "destination": "<dir>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
  }
  const conflict = req.body.conflict || 'replace';
  const destDir = resolvePath(req.body.destination);
  const results = [];
  for (const raw of req.body.sources) {
    const src = realPath(raw);
    try {
      const baseName = path.basename(src);
      const dst = path.join(destDir, baseName);
      const result = await resolveCopyMove(src, dst, conflict, isMove);
      results.push({ path: raw, success: true, ...result });
    } catch (e) {
      results.push({ path: raw, success: false, error: e.message });
    }
  }
  res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
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
    res.json({ success: true, mode: req.body.mode });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    const query = req.body.query;
    const isRegex = req.body.pattern === 'regex';
    const maxResults = Math.min(req.body.maxResults || 50, 200);
    const maxDepth = Math.min(req.body.maxDepth || 4, 10);
    const results = [];
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // skip files > 10MB
    const BINARY_CHECK_LEN = 4096;

    let regex;
    if (isRegex) { try { regex = new RegExp(query, 'gi'); } catch { return res.status(400).json({ error: 'invalid regex pattern' }); } }

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
            dirs.push(e);
          } else if (e.isFile() || e.isSymbolicLink()) {
            const st = await fsPromises.stat(full);
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
    let dest = realPath(req.body.destination);
    const resolved = req.body.sources.map(s => realPath(s));
    // Prevent zipping workspace root
    // Auto-rename if destination exists
    let counter = 1;
    const ext = '.zip';
    const origDest = dest;
    while (true) {
      try { await fsPromises.access(dest); } catch { break; }
      dest = origDest.replace(/(\.zip)?$/, ` (${counter})${ext}`);
      counter++;
    }
    const zipDir = path.dirname(dest);
    const zipTarget = path.basename(dest);
    const zipArgs = resolved.map(s => {
      const rel = path.relative(zipDir, s);
      return `"${rel}"`;
    });
    execSync(`zip -r -6 "${zipTarget}" ${zipArgs.join(' ')}`, { cwd: zipDir, stdio: 'pipe' });
    res.json({ success: true, name: path.basename(dest), files: req.body.sources.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
app.get('/api/system/network', checkPin, async (req, res) => {
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
      } else {
        const route = execFileSync('sh', ['-c', "ip route | grep default | head -1 | awk '{print $3}'"], { encoding: 'utf8', stdio: 'pipe' }).trim();
        gateway = route || null;
        const resolv = execFileSync('sh', ['-c', "grep nameserver /etc/resolv.conf | awk '{print $2}'"], { encoding: 'utf8', stdio: 'pipe' }).trim();
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
let clipboard = { sources: [], action: null, createdAt: null };

app.get('/api/clipboard', checkPin, (req, res) => {
  res.json({ clipboard });
});

app.post('/api/clipboard', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.sources) || req.body.sources.length === 0) {
      return res.status(400).json({ error: 'sources array is required' });
    }
    const action = req.body.action === 'cut' ? 'cut' : 'copy';
    clipboard = {
      sources: req.body.sources.map(s => realPath(s)),
      action,
      createdAt: new Date().toISOString()
    };
    res.json({ clipboard, count: clipboard.sources.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clipboard/paste', checkPin, async (req, res) => {
  try {
    if (!req.body.destination) return res.status(400).json({ error: 'destination is required' });
    if (!clipboard.sources.length) return res.status(400).json({ error: 'clipboard is empty' });
    const destDir = resolvePath(req.body.destination);
    const conflict = req.body.conflict || 'replace';
    const results = [];
    for (const src of clipboard.sources) {
      try {
        const baseName = path.basename(src);
        const dst = path.join(destDir, baseName);
        const result = await resolveCopyMove(src, dst, conflict, clipboard.action === 'cut');
        results.push({ path: src, success: true, ...result });
      } catch (e) {
        results.push({ path: src, success: false, error: e.message });
      }
    }
    if (clipboard.action === 'cut') clipboard = { sources: [], action: null, createdAt: null };
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, pasteAction: clipboard.action });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clipboard', checkPin, (req, res) => {
  clipboard = { sources: [], action: null, createdAt: null };
  res.json({ success: true });
});

// ── Session persistence via tmux ──────────────────────────────────────
const TMUX = (() => { try { return execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { return null; } })();

function isValidPID(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

// Clean up dead tmux sessions from previous runs on startup
function cleanupOrphanTmuxSessions() {
  if (!TMUX) return;
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
    const sessions = out.split('\n').filter(s => s.startsWith('wt-'));
    for (const s of sessions) {
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
  if (!TMUX) return res.json({ tmux: false, sessions: [] });
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
    const sessions = out.split('\n')
      .filter(s => s.startsWith('wt-'))
      .map(s => ({ id: s.replace(/^wt-/, ''), name: s }));
    res.json({ tmux: true, sessions });
  } catch {
    res.json({ tmux: true, sessions: [] });
  }
});

app.delete('/api/sessions/:id', checkPin, (req, res) => {
  if (!TMUX) return res.json({ success: false });
  const name = 'wt-' + req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  try { execFileSync(TMUX, ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
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
  // Origin check to prevent Cross-Site WebSocket Hijacking
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

  if (PIN && token !== PIN) { ws.close(1008, 'Unauthorized'); return; }

  const cols      = parseInt(url.searchParams.get('cols'))  || 80;
  const rows      = parseInt(url.searchParams.get('rows'))  || 24;
  let cwd;
  try {
    cwd = realPath(url.searchParams.get('cwd') || WORKSPACE_ROOT);
  } catch {
    cwd = WORKSPACE_ROOT;
  }
  const sessionId = (url.searchParams.get('session') || '').replace(/[^a-zA-Z0-9_-]/g, '');

  const sessionEnv = (() => {
    const safe = { TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: process.env.HOME || '', USER: process.env.USER || '', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8', SHELL: SHELL };
    if (process.env.NODE_ENV) safe.NODE_ENV = process.env.NODE_ENV;
    return safe;
  })();

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
  try {
    if (TMUX && sessionId) {
      const tmuxName = 'wt-' + sessionId;
      const exists   = tmuxSessionExists(tmuxName);

      if (exists) {
        try { execFileSync(TMUX, ['resize-window', '-t', tmuxName, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' }); } catch {}
        proc = pty.spawn(TMUX, ['attach-session', '-t', tmuxName], {
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
      proc = pty.spawn(SHELL, [], {
        name: 'xterm-256color', cols, rows, cwd,
        env: sessionEnv
      });
    }
  } catch (e) {
    send(0x02, `Failed to spawn shell: ${e.message}\r\n`);
    ws.close();
    return;
  }

  proc.onData(data => send(0x00, data));

  proc.onExit(() => {
    if (!TMUX || !sessionId) send(0x01, Buffer.from([0]));
    ws.close();
  });

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
        // Limit input to 64KB per message
        const payload = buf.slice(1, Math.min(buf.length, 65537));
        proc.write(payload.toString('utf8'));
      } else if (type === 0x01 && buf.length >= 5) {
        const c = buf.readUInt16LE(1), r = buf.readUInt16LE(3);
        proc.resize(Math.max(2, c), Math.max(2, r));
        if (TMUX && sessionId) {
          try { execFileSync(TMUX, ['resize-window', '-t', 'wt-' + sessionId, '-x', String(c), '-y', String(r)], { stdio: 'ignore' }); } catch {}
        }
      }
    } catch (e) {
      console.error('WS message error:', e.message);
    }
  });

  const cleanup = () => {
    clearInterval(pingInterval);
    try { proc.kill(); } catch {}
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});



// ── File search (fuzzy finder) ──────────────────────────────────────
app.get('/api/search', rateLimiter, checkPin, async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const dir = req.query.path || WORKSPACE_ROOT;
  if (!q || q.length < 1) return res.json({ results: [] });

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

function spawnRead(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
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

  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime(),
    cpu: { model: cpuModel, count: cpuCount, usage: cpuUsage, loadAvg },
    memory: { total: totalMem, free: freeMem, used: usedMem, percent: memPercent },
    disk,
    processes
  });
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
    } else {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.toLowerCase().includes('cloudflared');
    }
  } catch {
    return false;
  }
}

function saveTunnels() {
  const arr = Array.from(tunnels.entries()).map(([id, t]) => ({
    id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, pid: t.pid
  }));
  try { fs.writeFileSync(TUNNEL_FILE, JSON.stringify(arr, null, 2)); } catch {}
  updateTunnelUrlFile();
}

function updateTunnelUrlFile() {
  const active = Array.from(tunnels.values()).map(t => t.tunnelUrl).filter(Boolean);
  try {
    if (active.length > 0) {
      fs.writeFileSync(TUNNEL_URL_FILE, active.join('\n') + '\n');
    } else {
      fs.writeFileSync(TUNNEL_URL_FILE, '');
    }
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

function restartTunnel(id, entry) {
  if (!entry.localUrl) return;
  try { if (entry.proc) entry.proc.kill('SIGTERM'); } catch {}
  try { if (entry.pid && isCloudflaredProcess(entry.pid)) process.kill(entry.pid, 'SIGTERM'); } catch {}
  tunnels.delete(id);

  const url = entry.localUrl;
  const proc = spawn('cloudflared', ['tunnel', '--url', url], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
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
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 2000);
        const proto = t.localUrl.startsWith('https') ? 'https' : 'http';
        if (proto === 'http' || proto === 'https') {
          await fetch(t.localUrl, { method: 'HEAD', signal: ac.signal });
          clearTimeout(timer);
          targetAlive = true;
        }
      } catch {}
    }
    let tunnelAlive = false;
    if (t.tunnelUrl) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 3000);
        await fetch(t.tunnelUrl, { method: 'HEAD', signal: ac.signal });
        clearTimeout(timer);
        tunnelAlive = true;
      } catch {}
    }
    return { id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, alive, targetAlive, tunnelAlive };
  }));
  const tunnels_list = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  res.json({ tunnels: tunnels_list });
});

app.post('/api/tunnel', checkPin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try { execSync(os.platform() === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' }); }
  catch { return res.status(500).json({ error: 'cloudflared not installed' }); }

  const proc = spawn('cloudflared', ['tunnel', '--url', url], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
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
    const result = await Promise.race([
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
    try { proc.kill(); } catch {}
    res.status(500).json({ error: e.message === 'timeout' ? 'Timed out waiting for tunnel URL' : e.message });
  }
});

app.delete('/api/tunnel', checkPin, (req, res) => {
  const { id } = req.body;
  if (!id || !tunnels.has(id)) return res.status(404).json({ error: 'tunnel not found' });
  const entry = tunnels.get(id);
  try {
    if (entry.proc) {
      entry.proc.kill('SIGTERM');
    } else if (entry.pid && isCloudflaredProcess(entry.pid)) {
      process.kill(entry.pid, 'SIGTERM');
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
      if (entry.proc) entry.proc.kill('SIGTERM');
      else if (entry.pid && isCloudflaredProcess(entry.pid)) process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  if (TMUX) {
    try {
      const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
      const sessions = out.split('\n').filter(s => s.startsWith('wt-'));
      for (const s of sessions) {
        try { execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore' }); } catch {}
      }
    } catch {}
  }
}

function startServer(opts = {}) {
  const port = opts.port || PORT;
  const host = opts.host || HOST;

  loadTunnels();
  cleanupOrphanTmuxSessions();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`\n  WebTun running → http://localhost:${port}\n`);
      if (PIN) console.log(`  PIN protection enabled\n`);
      console.log(`  File API examples:`);
      console.log(`    GET    /api/files?path=<dir>             — list directory`);
      console.log(`    GET    /api/files/read?path=<file>       — read file content`);
      console.log(`    POST   /api/files/write                  — write file  { path, content }`);
      console.log(`    POST   /api/files/upload?path=<dir>      — upload files (multipart)`);
      console.log(`    GET    /api/files/download?path=<path>   — download file/dir`);
      console.log(`    GET    /api/files/image?path=<file>      — view image inline`);
      console.log(`    POST   /api/files/rename                 — rename       { oldPath, newName }`);
      console.log(`    POST   /api/files/copy                   — copy         { source, destination, conflict? }`);
      console.log(`    POST   /api/files/move                   — move         { source, destination, conflict? }`);
      console.log(`    DELETE /api/files?path=<path>            — delete file/dir`);
      console.log(`    POST   /api/files/mkdir                  — create dir   { path }`);
      console.log(`    POST   /api/files/touch                  — create file  { path }`);
      console.log(`    POST   /api/files/zip                    — create zip   { path }`);
      console.log(`    POST   /api/files/unzip                  — extract zip  { path }`);
      console.log(`    GET    /api/search?q=<query>&path=<dir>  — search files`);
      console.log(`    GET    /api/files/stat?path=<path>        — file metadata`);
      console.log(`    POST   /api/files/batch-delete            — bulk delete     { paths: [...] }`);
      console.log(`    POST   /api/files/batch-copy              — bulk copy       { sources: [...], destination, conflict? }`);
      console.log(`    POST   /api/files/batch-move              — bulk move       { sources: [...], destination, conflict? }`);
      console.log(`    POST   /api/files/chmod                   — change perms    { path, mode }`);
      console.log(`    POST   /api/files/symlink                 — create symlink  { target, linkPath }`);
      console.log(`    POST   /api/files/search-content          — full-text search { query, path, pattern?, maxResults? }`);
      console.log(`    POST   /api/files/batch-zip               — multi-source zip { sources: [...], destination }`);
      console.log(`    POST   /api/files/trash                   — trash files     { paths: [...] }`);
      console.log(`    GET    /api/files/trash                   — list trash`);
      console.log(`    POST   /api/files/trash/restore           — restore trash   { path }`);
      console.log(`    DELETE /api/files/trash?path=<path>       — delete trash item permanently`);
      console.log(`    DELETE /api/files/trash/all               — empty entire trash`);
      console.log(`    GET    /api/files/preview?path=<file>      — file preview (md→html, code)`);
      console.log(`    GET    /api/files/tail?path=<file>&lines=N  — tail log file (SSE)`);
      console.log(`  Git API:`);
      console.log(`    GET    /api/git/status?path=<dir>           — git status`);
      console.log(`    POST   /api/git/diff                        — git diff       { path, file? }`);
      console.log(`    POST   /api/git/add                         — git add        { path, files? }`);
      console.log(`    POST   /api/git/commit                      — git commit     { path, message }`);
      console.log(`    GET    /api/git/log?path=<dir>&maxCount=N   — git log`);
      console.log(`    POST   /api/git/push                        — git push       { path, remote?, branch? }`);
      console.log(`    POST   /api/git/pull                        — git pull       { path, remote?, branch? }`);
      console.log(`    GET    /api/git/branches?path=<dir>         — list branches`);
      console.log(`    POST   /api/git/branch                      — create branch  { path, name, switch? }`);
      console.log(`    GET    /api/git/remote?path=<dir>           — list remotes`);
      console.log(`  System:`);
      console.log(`    GET    /api/system/network                  — network interfaces, ports`);
      console.log(`    GET    /api/env                             — environment variables`);
      console.log(`  Clipboard:`);
      console.log(`    GET    /api/clipboard                       — clipboard contents`);
      console.log(`    POST   /api/clipboard                       — set clipboard  { sources, action }`);
      console.log(`    POST   /api/clipboard/paste                 — paste          { destination, conflict? }`);
      console.log(`    DELETE /api/clipboard                       — clear clipboard`);
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

module.exports = { app, server, startServer, PORT, PIN, WORKSPACE_ROOT };

if (require.main === module) {
  startServer();
}

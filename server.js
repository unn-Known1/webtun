require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mime = require('mime-types');
const archiver = require('archiver');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const PIN = process.env.PIN || '';
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh'));
const HOST = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
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
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b.padEnd(a.length, '\0').slice(0, a.length)));
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
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : os.homedir();
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
    if (oldPath === WORKSPACE_ROOT) {
      console.warn('POST /api/files/rename 403 — cannot rename workspace root');
      return res.status(403).json({ error: 'cannot rename workspace root' });
    }
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

app.post('/api/files/copy', checkPin, async (req, res) => {
  try {
    if (!req.body.source || !req.body.destination) {
      console.warn('POST /api/files/copy 400 — body requires { source, destination[, conflict] }. Example: { "source": "/a/file.txt", "destination": "/b/file.txt", "conflict": "replace" }');
      return res.status(400).json({ error: 'source and destination are required', usage: 'POST JSON { "source": "<src>", "destination": "<dst>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
    }
    const src = realPath(req.body.source);
    if (src === WORKSPACE_ROOT) {
      console.warn('POST /api/files/copy 403 — cannot copy workspace root');
      return res.status(403).json({ error: 'cannot copy workspace root' });
    }
    const dst = resolvePath(req.body.destination);
    const result = await resolveCopyMove(src, dst, req.body.conflict || '', false);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/move', checkPin, async (req, res) => {
  try {
    if (!req.body.source || !req.body.destination) {
      console.warn('POST /api/files/move 400 — body requires { source, destination[, conflict] }. Example: { "source": "/a/file.txt", "destination": "/b/file.txt", "conflict": "replace" }');
      return res.status(400).json({ error: 'source and destination are required', usage: 'POST JSON { "source": "<src>", "destination": "<dst>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
    }
    const src = realPath(req.body.source);
    if (src === WORKSPACE_ROOT) {
      console.warn('POST /api/files/move 403 — cannot move workspace root');
      return res.status(403).json({ error: 'cannot move workspace root' });
    }
    const dst = resolvePath(req.body.destination);
    const result = await resolveCopyMove(src, dst, req.body.conflict || '', true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/files', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      console.warn('DELETE /api/files 400 — query param ?path= is required. Example: DELETE /api/files?path=/home/user/file.txt');
      return res.status(400).json({ error: 'path is required', usage: 'DELETE /api/files?path=<path>' });
    }
    const p = realPath(req.query.path);
    if (p === WORKSPACE_ROOT) {
      console.warn('DELETE /api/files 403 — cannot delete workspace root');
      return res.status(403).json({ error: 'cannot delete workspace root' });
    }
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
    if (p === WORKSPACE_ROOT) {
      console.warn('POST /api/files/mkdir 403 — cannot mkdir workspace root');
      return res.status(403).json({ error: 'cannot mkdir workspace root' });
    }
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
    if (p === WORKSPACE_ROOT) {
      console.warn('POST /api/files/touch 403 — cannot touch workspace root');
      return res.status(403).json({ error: 'cannot touch workspace root' });
    }
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
    if (p === WORKSPACE_ROOT) {
      console.warn('POST /api/files/zip 403 — cannot zip workspace root');
      return res.status(403).json({ error: 'cannot zip workspace root' });
    }
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
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    await new Promise((resolve, reject) => {
      archive.on('error', err => reject(err));
      output.on('close', resolve);
      output.on('error', reject);
      archive.pipe(output);
      if (st.isDirectory()) {
        archive.directory(p, baseName, { followSymlinks: false });
      } else {
        archive.file(p, { name: baseName });
      }
      archive.finalize();
    });
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
    if (p === WORKSPACE_ROOT) {
      console.warn('POST /api/files/unzip 403 — cannot unzip workspace root');
      return res.status(403).json({ error: 'cannot unzip workspace root' });
    }
    const ext = path.extname(p).toLowerCase();
    if (ext !== '.zip') return res.status(400).json({ error: 'Not a zip file' });
    const destDir = path.join(path.dirname(p), path.basename(p, '.zip'));
    await fsPromises.mkdir(destDir, { recursive: true });
    const { execFileSync } = require('child_process');
    if (os.platform() === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:ZIP_SRC -DestinationPath $env:ZIP_DST -Force'], {
        stdio: 'ignore',
        env: { ...process.env, ZIP_SRC: p, ZIP_DST: destDir }
      });
    } else {
      execFileSync('unzip', ['-o', p, '-d', destDir], { stdio: 'ignore' });
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
    if (p === WORKSPACE_ROOT) {
      console.warn('POST /api/files/write 403 — cannot write to workspace root');
      return res.status(403).json({ error: 'cannot write to workspace root' });
    }
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
    const mimeType = mime.lookup(p) || 'application/octet-stream';
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
    if (p === WORKSPACE_ROOT) {
      console.warn('GET /api/files/download 403 — cannot download workspace root');
      return res.status(403).json({ error: 'cannot download workspace root' });
    }
    const st = await fsPromises.stat(p);
    if (st.isDirectory()) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}.zip"`);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', err => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      archive.pipe(res);
      // Skip symlinks in directory archives to prevent boundary escape
      archive.directory(p, path.basename(p), { followSymlinks: false });
      await archive.finalize();
    } else {
      const mimeType = mime.lookup(p) || 'application/octet-stream';
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
        const finalDest = realPath(path.join(destDir, file.originalname));
        const subPath = path.dirname(finalDest);
        fs.mkdirSync(subPath, { recursive: true });
        cb(null, subPath);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_, file, cb) => {
      cb(null, path.basename(file.originalname));
    }
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
      const { execFileSync } = require('child_process');
      stat.owner = execFileSync('id', ['-nu', String(st.uid)], { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch { stat.owner = String(st.uid); }
    try {
      const { execFileSync } = require('child_process');
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
    const { execFileSync } = require('child_process');
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
      if (p === WORKSPACE_ROOT) { results.push({ path: raw, success: false, error: 'cannot delete workspace root' }); continue; }
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
app.post('/api/files/batch-copy', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.sources) || req.body.sources.length === 0 || !req.body.destination) {
      console.warn('POST /api/files/batch-copy 400 — body requires { sources: [...], destination: "<dir>" }');
      return res.status(400).json({ error: 'sources array and destination are required', usage: 'POST JSON { "sources": ["<src1>", ...], "destination": "<dir>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
    }
    const conflict = req.body.conflict || 'replace';
    const destDir = resolvePath(req.body.destination);
    const results = [];
    for (const raw of req.body.sources) {
      const src = realPath(raw);
      if (src === WORKSPACE_ROOT) { results.push({ path: raw, success: false, error: 'cannot copy workspace root' }); continue; }
      try {
        const baseName = path.basename(src);
        const dst = path.join(destDir, baseName);
        const result = await resolveCopyMove(src, dst, conflict, false);
        results.push({ path: raw, success: true, ...result });
      } catch (e) {
        results.push({ path: raw, success: false, error: e.message });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Batch move ────────────────────────────────────────────────────────
app.post('/api/files/batch-move', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.sources) || req.body.sources.length === 0 || !req.body.destination) {
      console.warn('POST /api/files/batch-move 400 — body requires { sources: [...], destination: "<dir>" }');
      return res.status(400).json({ error: 'sources array and destination are required', usage: 'POST JSON { "sources": ["<src1>", ...], "destination": "<dir>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
    }
    const conflict = req.body.conflict || 'replace';
    const destDir = resolvePath(req.body.destination);
    const results = [];
    for (const raw of req.body.sources) {
      const src = realPath(raw);
      if (src === WORKSPACE_ROOT) { results.push({ path: raw, success: false, error: 'cannot move workspace root' }); continue; }
      try {
        const baseName = path.basename(src);
        const dst = path.join(destDir, baseName);
        const result = await resolveCopyMove(src, dst, conflict, true);
        results.push({ path: raw, success: true, ...result });
      } catch (e) {
        results.push({ path: raw, success: false, error: e.message });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Change permissions (chmod) ─────────────────────────────────────────
app.post('/api/files/chmod', checkPin, async (req, res) => {
  try {
    if (!req.body.path || !req.body.mode) {
      console.warn('POST /api/files/chmod 400 — body requires { path, mode }. Example: { "path": "/home/user/file.sh", "mode": "755" }');
      return res.status(400).json({ error: 'path and mode are required', usage: 'POST JSON { "path": "<path>", "mode": "<octal_perms>" }' });
    }
    const p = realPath(req.body.path);
    if (p === WORKSPACE_ROOT) { console.warn('POST /api/files/chmod 403 — cannot chmod workspace root'); return res.status(403).json({ error: 'cannot chmod workspace root' }); }
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
    if (linkPath === WORKSPACE_ROOT) { console.warn('POST /api/files/symlink 403 — cannot symlink to workspace root'); return res.status(403).json({ error: 'cannot symlink to workspace root' }); }
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
    if (resolved.some(s => s === WORKSPACE_ROOT)) return res.status(403).json({ error: 'cannot zip workspace root' });
    if (dest === WORKSPACE_ROOT) return res.status(403).json({ error: 'cannot write zip to workspace root' });
    // Auto-rename if destination exists
    let counter = 1;
    const ext = '.zip';
    const origDest = dest;
    while (true) {
      try { await fsPromises.access(dest); } catch { break; }
      dest = origDest.replace(/(\.zip)?$/, ` (${counter})${ext}`);
      counter++;
    }
    const output = fs.createWriteStream(dest);
    const archive = archiver('zip', { zlib: { level: 6 } });
    await new Promise((resolve, reject) => {
      archive.on('error', err => reject(err));
      output.on('close', resolve);
      output.on('error', reject);
      archive.pipe(output);
      for (const s of resolved) {
        try {
          const st = fs.statSync(s);
          if (st.isDirectory()) archive.directory(s, path.basename(s), { followSymlinks: false });
          else archive.file(s, { name: path.basename(s) });
        } catch {}
      }
      archive.finalize();
    });
    res.json({ success: true, name: path.basename(dest), files: req.body.sources.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trash / recycle bin ───────────────────────────────────────────────
const TRASH_DIR = path.join(os.homedir(), '.trash');

async function ensureTrashDir() {
  try { await fsPromises.mkdir(TRASH_DIR, { recursive: true }); } catch {}
}

// Move files/dirs to trash
app.post('/api/files/trash', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.paths) || req.body.paths.length === 0) {
      console.warn('POST /api/files/trash 400 — body requires { paths: [...] }');
      return res.status(400).json({ error: 'paths array is required', usage: 'POST JSON { "paths": ["<path1>", ...] }' });
    }
    await ensureTrashDir();
    const results = [];
    for (const raw of req.body.paths) {
      const p = realPath(raw);
      if (p === WORKSPACE_ROOT) { results.push({ path: raw, success: false, error: 'cannot trash workspace root' }); continue; }
      try {
        const st = await fsPromises.stat(p);
        const timestamp = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        const trashName = path.basename(p) + '.' + timestamp;
        const trashPath = path.join(TRASH_DIR, trashName);
        // Write info first, then move
        const info = { originalPath: p, trashedAt: new Date().toISOString(), isDir: st.isDirectory() };
        await fsPromises.writeFile(trashPath + '.info.json', JSON.stringify(info, null, 2));
        try { await fsPromises.rename(p, trashPath); } catch (e) {
          // Cross-device rename failure — fall back to copy + delete
          if (st.isDirectory()) await fsPromises.cp(p, trashPath, { recursive: true, force: true });
          else await fsPromises.copyFile(p, trashPath);
          if (st.isDirectory()) await fsPromises.rm(p, { recursive: true, force: true });
          else await fsPromises.unlink(p);
        }
        results.push({ path: raw, success: true, trashPath });
      } catch (e) {
        results.push({ path: raw, success: false, error: e.message });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List trash contents
app.get('/api/files/trash', checkPin, async (req, res) => {
  try {
    await ensureTrashDir();
    const entries = await fsPromises.readdir(TRASH_DIR);
    const items = [];
    for (const name of entries) {
      if (name.endsWith('.info.json')) continue;
      const full = path.join(TRASH_DIR, name);
      const infoPath = full + '.info.json';
      let info = null;
      try { info = JSON.parse(await fsPromises.readFile(infoPath, 'utf8')); } catch {}
      try {
        const st = await fsPromises.stat(full);
        items.push({
          trashName: name, path: full, originalPath: info ? info.originalPath : null,
          trashedAt: info ? info.trashedAt : null, isDir: info ? info.isDir : st.isDirectory(),
          size: st.size, modified: st.mtime
        });
      } catch {}
    }
    // Sort by trashedAt descending
    items.sort((a, b) => new Date(b.trashedAt || 0) - new Date(a.trashedAt || 0));
    res.json({ items, count: items.length, trashDir: TRASH_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore from trash
app.post('/api/files/trash/restore', checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/trash/restore 400 — body requires { path }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<trash_item_path>" }' });
    }
    const trashItem = realPath(req.body.path);
    if (!trashItem.startsWith(TRASH_DIR)) return res.status(403).json({ error: 'path is not in trash directory' });
    const infoPath = trashItem + '.info.json';
    let info;
    try { info = JSON.parse(await fsPromises.readFile(infoPath, 'utf8')); } catch { return res.status(400).json({ error: 'trash item info not found' }); }
    // If original path exists, generate unique name
    let restorePath = info.originalPath;
    try {
      await fsPromises.access(restorePath);
      const dir = path.dirname(restorePath);
      const ext = path.extname(restorePath);
      const base = path.basename(restorePath, ext);
      let counter = 1;
      while (true) {
        restorePath = path.join(dir, `${base} (restored ${counter})${ext}`);
        try { await fsPromises.access(restorePath); counter++; } catch { break; }
      }
    } catch {}
    // Ensure parent dir exists
    await fsPromises.mkdir(path.dirname(restorePath), { recursive: true });
    await fsPromises.rename(trashItem, restorePath);
    // Remove info file
    try { await fsPromises.unlink(infoPath); } catch {}
    res.json({ success: true, restoredPath: restorePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Permanently delete from trash
app.delete('/api/files/trash', checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      console.warn('DELETE /api/files/trash 400 — query param ?path= is required');
      return res.status(400).json({ error: 'path is required', usage: 'DELETE /api/files/trash?path=<trash_item_path>' });
    }
    const p = realPath(req.query.path);
    if (!p.startsWith(TRASH_DIR)) return res.status(403).json({ error: 'path is not in trash directory' });
    try { await fsPromises.unlink(p); } catch {}
    try { await fsPromises.unlink(p + '.info.json'); } catch {}
    try { await fsPromises.rm(p, { recursive: true, force: true }); } catch {}
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Empty entire trash
app.delete('/api/files/trash/all', checkPin, async (req, res) => {
  try {
    await ensureTrashDir();
    const entries = await fsPromises.readdir(TRASH_DIR);
    for (const name of entries) {
      const full = path.join(TRASH_DIR, name);
      try {
        const st = await fsPromises.stat(full);
        if (st.isDirectory()) await fsPromises.rm(full, { recursive: true, force: true });
        else await fsPromises.unlink(full);
      } catch {}
    }
    res.json({ success: true, cleared: entries.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Git integration ──────────────────────────────────────────────────
function gitExec(args, cwd) {
  const { execFileSync } = require('child_process');
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function requireGitRepo(path) {
  try { gitExec(['rev-parse', '--show-toplevel'], path); return true; } catch { return false; }
}

app.get('/api/git/status', checkPin, async (req, res) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.query.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const porcelain = gitExec(['status', '--porcelain', '-b'], p);
    const lines = porcelain.split('\n').filter(Boolean);
    const branch = lines[0].replace(/^## /, '');
    const files = lines.slice(1).map(l => ({ xy: l.slice(0, 2), path: l.slice(3) }));
    res.json({ branch, files, repoPath: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/git/diff', checkPin, async (req, res) => {
  try {
    if (!req.body.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.body.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const args = ['diff', '--no-color', '-U5'];
    if (req.body.file) args.push('--', req.body.file);
    const diff = gitExec(args, p);
    res.json({ diff, repoPath: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/git/add', checkPin, async (req, res) => {
  try {
    if (!req.body.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.body.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const files = Array.isArray(req.body.files) ? req.body.files : ['.'];
    gitExec(['add', '--'].concat(files), p);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/git/commit', checkPin, async (req, res) => {
  try {
    if (!req.body.path || !req.body.message) return res.status(400).json({ error: 'path and message are required' });
    const p = realPath(req.body.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    gitExec(['commit', '-m', req.body.message], p);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/git/log', checkPin, async (req, res) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.query.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const maxCount = Math.min(parseInt(req.query.maxCount) || 50, 200);
    const format = '--format=%H|%an|%ai|%s';
    const raw = gitExec(['log', `--max-count=${maxCount}`, format], p);
    const commits = raw.split('\n').filter(Boolean).map(line => {
      const [hash, author, date, ...msgParts] = line.split('|');
      return { hash: hash.slice(0, 7), fullHash: hash, author, date, message: msgParts.join('|') };
    });
    res.json({ commits, count: commits.length, repoPath: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/git/push', checkPin, async (req, res) => {
  try {
    if (!req.body.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.body.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const remote = req.body.remote || 'origin';
    const branch = req.body.branch || '';
    const args = ['push', remote];
    if (branch) args.push(branch);
    const out = gitExec(args, p);
    res.json({ success: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/git/pull', checkPin, async (req, res) => {
  try {
    if (!req.body.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.body.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const remote = req.body.remote || 'origin';
    const branch = req.body.branch || '';
    const args = ['pull', remote];
    if (branch) args.push(branch);
    const out = gitExec(args, p);
    res.json({ success: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/git/branches', checkPin, async (req, res) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.query.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const raw = gitExec(['branch', '--all'], p);
    const branches = raw.split('\n').filter(Boolean).map(b => ({
      name: b.replace(/^\*?\s*/, '').trim(),
      current: b.startsWith('* ')
    }));
    res.json({ branches, repoPath: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/git/branch', checkPin, async (req, res) => {
  try {
    if (!req.body.path || !req.body.name) return res.status(400).json({ error: 'path and name are required' });
    const p = realPath(req.body.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    if (req.body.switch) {
      gitExec(['checkout', '-b', req.body.name], p);
    } else {
      gitExec(['branch', req.body.name], p);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/git/remote', checkPin, async (req, res) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.query.path);
    if (!requireGitRepo(p)) return res.status(400).json({ error: 'not a git repository' });
    const raw = gitExec(['remote', '-v'], p);
    const remotes = raw.split('\n').filter(Boolean).map(line => {
      const [name, url, type] = line.split(/\s+/);
      return { name, url, type: type ? type.replace(/[()]/g, '') : '' };
    });
    res.json({ remotes, repoPath: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── File preview (Markdown → HTML, code detection) ────────────────────
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown']);
const CODE_EXT = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.json', '.yaml', '.yml', '.toml', '.ini',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.r', '.m', '.swift', '.kt', '.scala', '.ex', '.exs', '.erl', '.hs',
  '.php', '.pl', '.pm', '.lua', '.vue', '.svelte', '.astro', '.mdx',
  '.graphql', '.gql', '.proto', '.dockerfile', '.makefile',
]);

function simpleMarkdownToHtml(md) {
  let html = '';
  const lines = md.split('\n');
  let inCodeBlock = false, codeBuf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>\n';
        codeBuf = [];
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) { codeBuf.push(line); continue; }
    if (line.startsWith('# ')) { html += '<h1>' + escapeHtml(line.slice(2)) + '</h1>\n'; continue; }
    if (line.startsWith('## ')) { html += '<h2>' + escapeHtml(line.slice(3)) + '</h2>\n'; continue; }
    if (line.startsWith('### ')) { html += '<h3>' + escapeHtml(line.slice(4)) + '</h3>\n'; continue; }
    if (line.startsWith('- ') || line.startsWith('* ')) { html += '<li>' + escapeHtml(line.slice(2)) + '</li>\n'; continue; }
    if (line.match(/^\d+\.\s/)) { html += '<li>' + escapeHtml(line.replace(/^\d+\.\s/, '')) + '</li>\n'; continue; }
    if (line.trim() === '') { html += '<br>\n'; continue; }
    html += '<p>' + escapeHtml(line) + '</p>\n';
  }
  if (codeBuf.length) html += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>\n';
  return html;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function detectLanguage(ext) {
  const map = {
    '.js': 'javascript', '.ts': 'typescript', '.jsx': 'jsx', '.tsx': 'tsx',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.css': 'css', '.scss': 'scss', '.html': 'html', '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell',
    '.sql': 'sql', '.php': 'php', '.lua': 'lua', '.md': 'markdown',
    '.vue': 'vue', '.svelte': 'svelte', '.graphql': 'graphql',
  };
  return map[ext] || null;
}

app.get('/api/files/preview', checkPin, async (req, res) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    const p = realPath(req.query.path);
    const ext = path.extname(p).toLowerCase();
    const st = await fsPromises.stat(p);
    if (st.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'file too large for preview (max 5MB)' });
    const content = await fsPromises.readFile(p, 'utf8');
    if (MARKDOWN_EXT.has(ext)) {
      res.json({ type: 'markdown', html: simpleMarkdownToHtml(content), path: p, name: path.basename(p) });
    } else if (CODE_EXT.has(ext)) {
      res.json({ type: 'code', content, language: detectLanguage(ext), path: p, name: path.basename(p) });
    } else {
      res.json({ type: 'text', content: content.substring(0, 10000), path: p, name: path.basename(p), truncated: content.length > 10000 });
    }
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
      const { execFileSync } = require('child_process');
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
      const { execFileSync } = require('child_process');
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

// ── Environment viewer ────────────────────────────────────────────────
const SECRET_KEYS = new Set(['token', 'secret', 'password', 'passwd', 'pass', 'key', 'api_key', 'apikey', 'private_key', 'access_key', 'auth', 'credential', 'pwd']);

function isSecretKey(key) {
  const lower = key.toLowerCase();
  return SECRET_KEYS.has(lower) || SECRET_KEYS.has(lower.replace(/_/g, '')) || /secret|token|password|key|auth|credential/i.test(lower);
}

app.get('/api/env', checkPin, (req, res) => {
  const env = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (isSecretKey(key)) {
      env[key] = val ? '••••••••' : '';
    } else {
      env[key] = val;
    }
  }
  res.json({ env, count: Object.keys(env).length });
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
      sources: req.body.sources.map(s => realPath(s)).filter(s => s !== WORKSPACE_ROOT),
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
const { execSync, execFileSync, spawn } = require('child_process');

const TMUX = (() => { try { return execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { return null; } })();

// Auth rate limiter (separate, stricter)
const authReqs = new Map();
function authRateLimiter(req, res, next) {
  if (!PIN) return next();
  const now = Date.now();
  const key = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'default';
  let win = authReqs.get(key);
  if (!win || now > win.resetAt) {
    win = { count: 0, resetAt: now + 10000 };
    authReqs.set(key, win);
  }
  win.count++;
  if (win.count > 5) return res.status(429).json({ error: 'Too many attempts' });
  next();
}

// Periodic cleanup of rate limiter maps (prevents unbounded memory growth)
setInterval(() => {
  const now = Date.now();
  for (const [key, win] of authReqs) { if (now > win.resetAt) authReqs.delete(key); }
  for (const [key, win] of rateLimitWindows) { if (now > win.resetAt) rateLimitWindows.delete(key); }
}, 60000);

// Simple in-memory rate limiter
const rateLimitWindows = new Map();
const rateLimiter = (() => {
  const LIMITS = {
    '/api/exec': { limit: 10, windowMs: 10000 },
    '/api/search': { limit: 20, windowMs: 10000 },
  };
  return (req, res, next) => {
    const path = req.path;
    const cfg = path === '/api/exec' ? LIMITS['/api/exec'] : path === '/api/search' ? LIMITS['/api/search'] : null;
    if (!cfg) return next();
    const now = Date.now();
    const key = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'default';
    let win = rateLimitWindows.get(key);
    if (!win || now > win.resetAt) {
      win = { count: 0, resetAt: now + cfg.windowMs };
      rateLimitWindows.set(key, win);
    }
    win.count++;
    if (win.count > cfg.limit) {
      return res.status(429).json({ error: 'Too many requests, please wait' });
    }
    next();
  };
})();

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

// ── MCP Exec API ──────────────────────────────────────────────────────
function getShellAndArgs(command) {
  if (os.platform() === 'win32') {
    const shell = process.env.SHELL || 'powershell.exe';
    const isPowerShell = shell.toLowerCase().includes('powershell') || shell.toLowerCase().includes('pwsh');
    const isCmd = shell.toLowerCase().includes('cmd');
    const args = isPowerShell ? ['-Command', command] : isCmd ? ['/c', command] : ['-c', command];
    return { shell, args };
  } else {
    const shell = process.env.SHELL || (fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh');
    return { shell, args: ['-c', command] };
  }
}

function killProcessGroup(pid) {
  if (!isValidPID(pid)) return;
  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

const execEnv = (() => {
  const safe = { HOME: process.env.HOME || '', USER: process.env.USER || '', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8', SHELL: SHELL };
  if (process.env.NODE_ENV) safe.NODE_ENV = process.env.NODE_ENV;
  return safe;
})();

app.post('/api/exec', rateLimiter, checkPin, (req, res) => {
  const { command, cwd: reqCwd, timeout = 60000 } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  const execTimeout = Math.min(Math.max(1000, Number(timeout) || 60000), 300000);

  let execCwd;
  try {
    execCwd = realPath(reqCwd || WORKSPACE_ROOT);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  let stdout = '', stderr = '';
  const start = Date.now();
  const maxBufferSize = 10 * 1024 * 1024;

  const { shell, args } = getShellAndArgs(command);
  const proc = spawn(shell, args, {
    cwd: execCwd,
    env: execEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: os.platform() !== 'win32'
  });

  let killed = false;

  proc.stdout.on('data', d => {
    if (killed) return;
    if (stdout.length + d.length > maxBufferSize) {
      killed = true;
      try { killProcessGroup(proc.pid); } catch {}
      return;
    }
    stdout += d.toString();
  });
  proc.stderr.on('data', d => {
    if (killed) return;
    if (stderr.length + d.length > maxBufferSize) {
      killed = true;
      try { killProcessGroup(proc.pid); } catch {}
      return;
    }
    stderr += d.toString();
  });

  const timer = setTimeout(() => {
    if (killed) return;
    killed = true;
    try { killProcessGroup(proc.pid); } catch {}
    if (!res.headersSent)
      res.status(408).json({ error: 'timeout', stdout, stderr, duration: Date.now() - start });
  }, execTimeout);

  proc.on('close', code => {
    clearTimeout(timer);
    if (res.headersSent) return;
    res.json({ exitCode: code, stdout, stderr, duration: Date.now() - start });
  });

  proc.on('error', e => {
    clearTimeout(timer);
    if (res.headersSent) return;
    res.status(500).json({ error: e.message, stdout, stderr });
  });
});

app.get('/api/exec/stream', checkPin, (req, res) => {
  const { command, cwd: reqCwd } = req.query;
  if (!command) { res.status(400).end('command required'); return; }

  let execCwd;
  try {
    execCwd = realPath(reqCwd || WORKSPACE_ROOT);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sendQueue = [];
  let draining = false;

  const send = (type, data) => {
    if (res.writableEnded) return;
    const chunk = `data: ${JSON.stringify({ type, data })}\n\n`;
    if (draining) { sendQueue.push(chunk); return; }
    const canContinue = res.write(chunk);
    if (!canContinue) {
      draining = true;
      res.once('drain', () => {
        draining = false;
        while (sendQueue.length > 0) {
          const q = sendQueue.shift();
          if (res.writableEnded) { sendQueue = []; return; }
          if (!res.write(q)) { draining = true; return; }
        }
      });
    }
  };

  const { shell, args } = getShellAndArgs(command);
  const proc = spawn(shell, args, {
    cwd: execCwd,
    env: execEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: os.platform() !== 'win32'
  });

  proc.stdout.on('data', d => send('stdout', d.toString()));
  proc.stderr.on('data', d => send('stderr', d.toString()));

  proc.on('close', code => { send('exit', code); res.end(); });
  proc.on('error', e => { send('error', e.message); res.end(); });

  req.on('close', () => { try { killProcessGroup(proc.pid); } catch {} });
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

app.get('/api/tunnel', checkPin, async (req, res) => {
  const entries = Array.from(tunnels.entries());
  // Quick health check on each tunnel's target server
  const results = await Promise.allSettled(entries.map(async ([id, t]) => {
    let alive = t.proc !== null;
    if (!alive && t.pid) { alive = isCloudflaredProcess(t.pid); }
    let targetAlive = false;
    if (alive) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 2000);
        const proto = t.localUrl.startsWith('https') ? 'https' : 'http';
        // Only check http/https targets
        if (proto === 'http' || proto === 'https') {
          await fetch(t.localUrl, { method: 'HEAD', signal: ac.signal });
          clearTimeout(timer);
          targetAlive = true;
        }
      } catch {}
    }
    return { id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, alive, targetAlive };
  }));
  const tunnels_list = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  res.json({ tunnels: tunnels_list });
});

app.post('/api/tunnel', checkPin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try { require('child_process').execSync(os.platform() === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' }); }
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
    const id = tunnelUrl.replace(/^https:\/\//, '').replace(/\.trycloudflare\.com$/, '');
    tunnels.set(id, { proc, pid: proc.pid, localUrl: url, tunnelUrl, createdAt: Date.now() });
    saveTunnels();
    res.json({ success: true, id, url: tunnelUrl });
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

loadTunnels();
cleanupOrphanTmuxSessions();

server.listen(PORT, HOST, () => {
  console.log(`\n  WebTun running → http://localhost:${PORT}\n`);
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
});

process.on('uncaughtException', e => {
  console.error('Uncaught:', e.message);
  try { cleanup(); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', e => {
  console.error('Unhandled:', e);
  // Don't exit on unhandled rejection — log and continue
});

process.on('SIGTERM', () => { try { cleanup(); } catch {}; process.exit(0); });
process.on('SIGINT', () => { try { cleanup(); } catch {}; process.exit(0); });
process.on('exit', () => { try { cleanup(); } catch {} });

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

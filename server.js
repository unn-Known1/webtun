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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const PIN = process.env.PIN || '';
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh'));
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Trust proxy for proper IP detection behind reverse proxy
app.set('trust proxy', 1);

// ── Auth ──────────────────────────────────────────────────────────────
function checkPin(req, res, next) {
  if (!PIN) return next();
  const token = req.headers['x-pin-token'] || req.query.token;
  if (token === PIN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/auth/required', (req, res) => {
  res.json({ required: !!PIN });
});

app.post('/api/auth', authRateLimiter, (req, res) => {
  const { pin } = req.body;
  if (!PIN || pin === PIN) {
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

function validatePath(targetPath) {
  if (!targetPath) return WORKSPACE_ROOT;
  const resolved = path.resolve(targetPath);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Access denied: Path lies outside workspace root');
  }
  return resolved;
}

function resolvePath(targetPath) {
  if (!targetPath) return WORKSPACE_ROOT;
  return path.resolve(targetPath);
}

async function safeStat(p) {
  try { return await fsPromises.stat(p); } catch { return null; }
}

async function asyncSafeWalk(currentDir, depth, maxDepth, q, results, maxResults) {
  if (depth > maxDepth || results.length >= maxResults) return;
  let entries;
  try { entries = await fsPromises.readdir(currentDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (results.length >= maxResults) break;
    const full = path.join(currentDir, e.name);
    if (e.name.toLowerCase().includes(q)) {
      try {
        const st = await fsPromises.stat(full);
        results.push({ path: full, name: e.name, isDir: st.isDirectory(), dir: currentDir });
      } catch {}
    }
    if (e.isDirectory()) {
      try {
        const st = await fsPromises.lstat(full);
        if (st.isSymbolicLink()) continue;
      } catch {}
      await asyncSafeWalk(full, depth + 1, maxDepth, q, results, maxResults);
    }
  }
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
    const oldPath = validatePath(req.body.oldPath);
    const newPath = validatePath(path.join(path.dirname(oldPath), req.body.newName));
    await fsPromises.rename(oldPath, newPath);
    res.json({ success: true, newPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/files', checkPin, async (req, res) => {
  try {
    const p = validatePath(req.query.path);
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
    const p = validatePath(req.body.path);
    await fsPromises.mkdir(p, { recursive: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/touch', checkPin, async (req, res) => {
  try {
    const p = validatePath(req.body.path);
    await fsPromises.writeFile(p, '', { flag: 'a' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/read', checkPin, async (req, res) => {
  try {
    const p = resolvePath(req.query.path);
    if (req.query.head) {
      const st = await fsPromises.stat(p);
      return res.json({ length: st.size });
    }
    const content = await fsPromises.readFile(p, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/write', checkPin, async (req, res) => {
  try {
    const p = validatePath(req.body.path);
    await fsPromises.writeFile(p, req.body.content, 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/download', checkPin, async (req, res) => {
  try {
    const p = validatePath(req.query.path);
    const st = await fsPromises.stat(p);
    if (st.isDirectory()) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}.zip"`);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', err => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
      archive.pipe(res);
      archive.directory(p, path.basename(p));
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
    destDir = validatePath(req.query.path || WORKSPACE_ROOT);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const finalDest = validatePath(path.join(destDir, file.originalname));
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

// ── Session persistence via tmux ──────────────────────────────────────
// PATCHED: added `spawn` to child_process imports
const { execSync, execFileSync, spawn } = require('child_process');

const TMUX = (() => { try { return execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { return null; } })();

// Auth rate limiter (separate, stricter)
const authReqs = new Map();
function authRateLimiter(req, res, next) {
  if (!PIN) return next();
  const now = Date.now();
  const key = req.ip || 'default';
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
const rateLimitWindows = new Map(); // key -> { count, resetAt }
const rateLimiter = (() => {
  const LIMITS = {
    '/api/exec': { limit: 10, windowMs: 10000 },
    '/api/search': { limit: 20, windowMs: 10000 },
  };
  return (req, res, next) => {
    // Only rate limit POST /api/exec and GET /api/search
    const path = req.path;
    const cfg = path === '/api/exec' ? LIMITS['/api/exec'] : path === '/api/search' ? LIMITS['/api/search'] : null;
    if (!cfg) return next();
    const now = Date.now();
    const key = req.ip || 'default';
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

// Clean up dead tmux sessions from previous runs on startup
function cleanupOrphanTmuxSessions() {
  if (!TMUX) return;
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim();
    const sessions = out.split('\n').filter(s => s.startsWith('wt-'));
    for (const s of sessions) {
      try {
        // Check if this session has a connected client
        const clients = execFileSync(TMUX, ['list-clients', '-t', s], { stdio: 'pipe', encoding: 'utf8' }).trim();
        if (!clients) {
          // No clients attached, kill orphaned session
          execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore' });
        }
      } catch { /* Session may have no clients or already be gone */ }
    }
  } catch { /* No sessions or tmux error */ }
}

function tmuxSessionExists(name) {
  try { execFileSync(TMUX, ['has-session', '-t', name], { stdio: 'ignore' }); return true; } catch { return false; }
}

// List all webtun-managed tmux sessions: returns [{id, title}]
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
//     0x00 = input         (UTF-8)
//     0x01 = resize        (4B: cols uint16LE, rows uint16LE)
//     0x02 = ping          (no payload)

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');

  if (PIN && token !== PIN) { ws.close(1008, 'Unauthorized'); return; }

  const cols      = parseInt(url.searchParams.get('cols'))  || 80;
  const rows      = parseInt(url.searchParams.get('rows'))  || 24;
  let cwd;
  try {
    cwd = validatePath(url.searchParams.get('cwd') || WORKSPACE_ROOT);
  } catch {
    cwd = WORKSPACE_ROOT;
  }
  const sessionId = (url.searchParams.get('session') || '').replace(/[^a-zA-Z0-9_-]/g, '');

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
      // ── tmux mode: attach or create ──────────────────────────────
      const tmuxName = 'wt-' + sessionId;
      const exists   = tmuxSessionExists(tmuxName);

      if (exists) {
        // Resize existing session first
        try { execFileSync(TMUX, ['resize-window', '-t', tmuxName, '-x', String(cols), '-y', String(rows)], { stdio: 'ignore' }); } catch {}
        proc = pty.spawn(TMUX, ['attach-session', '-t', tmuxName], {
          name: 'xterm-256color', cols, rows, cwd,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
        });
      } else {
        proc = pty.spawn(TMUX, ['new-session', '-s', tmuxName], {
          name: 'xterm-256color', cols, rows, cwd,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL }
        });
      }
    } else {
      // ── plain shell (no tmux / no session id) ───────────────────
      proc = pty.spawn(SHELL, [], {
        name: 'xterm-256color', cols, rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
    }
  } catch (e) {
    send(0x02, `Failed to spawn shell: ${e.message}\r\n`);
    ws.close();
    return;
  }

  proc.onData(data => send(0x00, data));

  proc.onExit(() => {
    // In tmux mode: detaching is an "exit" but the session lives on.
    // Only send exit signal for plain shells.
    if (!TMUX || !sessionId) send(0x01, Buffer.from([0]));
    ws.close();
  });

  // Server-side keepalive ping every 30s
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
      const type = buf[0];
      if (type === 0x00) {
        proc.write(buf.slice(1).toString('utf8'));
      } else if (type === 0x01 && buf.length >= 5) {
        const c = buf.readUInt16LE(1), r = buf.readUInt16LE(3);
        proc.resize(Math.max(2, c), Math.max(2, r));
        // Also resize the tmux window so it matches
        if (TMUX && sessionId) {
          try { execFileSync(TMUX, ['resize-window', '-t', 'wt-' + sessionId, '-x', String(c), '-y', String(r)], { stdio: 'ignore' }); } catch {}
        }
      }
      // 0x02 client ping — no-op
    } catch {}
  });

  const cleanup = () => {
    clearInterval(pingInterval);
    // In tmux mode just kill the pty (the session stays alive in tmux).
    // In plain mode kill the shell process.
    try { proc.kill(); } catch {}
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// ── MCP Exec API ──────────────────────────────────────────────────────
// Added for MCP server integration. Two endpoints:
//   POST /api/exec           – run command, wait, return full output (JSON)
//   GET  /api/exec/stream    – run command, stream output as SSE

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
  if (!pid) return;
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

// POST /api/exec
// Body: { command: string, cwd?: string, timeout?: number (ms, default 60000) }
// Response: { exitCode, stdout, stderr, duration }
app.post('/api/exec', rateLimiter, checkPin, (req, res) => {
  const { command, cwd: reqCwd, timeout = 60000 } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  let execCwd;
  try {
    execCwd = validatePath(reqCwd || WORKSPACE_ROOT);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  let stdout = '', stderr = '';
  const start = Date.now();
  const maxBufferSize = 10 * 1024 * 1024; // 10MB limit

  const { shell, args } = getShellAndArgs(command);
  const proc = spawn(shell, args, {
    cwd: execCwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: os.platform() !== 'win32'
  });

  proc.stdout.on('data', d => {
    if (stdout.length + d.length > maxBufferSize) {
      try { killProcessGroup(proc.pid); } catch {}
      return;
    }
    stdout += d.toString();
  });
  proc.stderr.on('data', d => {
    if (stderr.length + d.length > maxBufferSize) {
      try { killProcessGroup(proc.pid); } catch {}
      return;
    }
    stderr += d.toString();
  });

  const timer = setTimeout(() => {
    try { killProcessGroup(proc.pid); } catch {}
    if (!res.headersSent)
      res.status(408).json({ error: 'timeout', stdout, stderr, duration: Date.now() - start });
  }, timeout);

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

// GET /api/exec/stream?command=<cmd>&cwd=<path>   (Server-Sent Events)
// Each SSE event: data: {"type":"stdout"|"stderr"|"exit"|"error","data":<string|number>}
// type=exit carries the numeric exit code; stream ends after it.
app.get('/api/exec/stream', checkPin, (req, res) => {
  const { command, cwd: reqCwd } = req.query;
  if (!command) { res.status(400).end('command required'); return; }

  let execCwd;
  try {
    execCwd = validatePath(reqCwd || WORKSPACE_ROOT);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  const { shell, args } = getShellAndArgs(command);
  const proc = spawn(shell, args, {
    cwd: execCwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: os.platform() !== 'win32'
  });

  proc.stdout.on('data', d => send('stdout', d.toString()));
  proc.stderr.on('data', d => send('stderr', d.toString()));

  proc.on('close', code => { send('exit', code); res.end(); });
  proc.on('error', e => { send('error', e.message); res.end(); });

  // Kill child if client disconnects
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
      const psOut = execSync('powershell.exe -Command "Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object {$_.DriveType -eq 3} | Select-Object DeviceID, Size, FreeSpace | ConvertTo-Json"', { encoding: 'utf8', timeout: 3000 });
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
      const dfOut = execSync('df -h /', { encoding: 'utf8', timeout: 3000 });
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
      const psOut = execSync('powershell.exe -Command "Get-Process | Where-Object {$_.CPU -ne $null} | Sort-Object CPU -Descending | Select-Object -First 15 | ForEach-Object { [PSCustomObject]@{ user = \'system\'; pid = $_.Id.ToString(); cpu = [Math]::Round($_.CPU, 1).ToString(); mem = [Math]::Round($_.WorkingSet / 1MB, 1).ToString() + \'MB\'; cmd = $_.ProcessName } } | ConvertTo-Json"', { encoding: 'utf8', timeout: 3000 });
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
      const psOut = execSync('ps aux --sort=-%cpu | head -15', { encoding: 'utf8', timeout: 3000 });
      const lines = psOut.trim().split('\n');
      if (lines.length > 0) {
        const header = lines[0].trim().split(/\s+/);
        const uidIdx = header.indexOf('USER');
        const pidIdx = header.indexOf('PID');
        const cpuIdx = header.indexOf('%CPU');
        const memIdx = header.indexOf('%MEM');
        const cmdIdx = header.length - 1;
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length > cmdIdx) {
            processes.push({
              user: parts[uidIdx] || '',
              pid: parts[pidIdx] || '',
              cpu: parts[cpuIdx] || '',
              mem: parts[memIdx] || '',
              cmd: parts.slice(cmdIdx).join(' ')
            });
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
    disk,
    processes
  });
});

// ── Cloudflared tunnel management ──────────────────────────────────
const tunnels = new Map();
const TUNNEL_FILE = path.join(__dirname, '.tunnels.json');

function isCloudflaredProcess(pid) {
  if (!pid) return false;
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

app.get('/api/tunnel', checkPin, (req, res) => {
  const list = Array.from(tunnels.entries()).map(([id, t]) => {
    let alive = t.proc !== null;
    if (!alive && t.pid) { alive = isCloudflaredProcess(t.pid); }
    return { id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, alive };
  });
  res.json({ tunnels: list });
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
});

process.on('uncaughtException', e => {
  console.error('Uncaught:', e.message);
  cleanup();
  process.exit(1);
});
process.on('unhandledRejection', e => {
  console.error('Unhandled:', e);
  cleanup();
  process.exit(1);
});

// Cleanup spawned processes on exit
function cleanup() {
  // Kill cloudflared tunnels
  for (const [id, entry] of tunnels) {
    try {
      if (entry.proc) entry.proc.kill('SIGTERM');
      else if (entry.pid && isCloudflaredProcess(entry.pid)) process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  // Kill tmux sessions managed by this server
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

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('exit', cleanup);

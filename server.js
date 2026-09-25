// Load .env without dotenv dependency.
// Repo-local __dirname/.env first (back-compat), then the user data dir
// (~/.config/webtun/.env — the writable home for global/npx installs).
function loadEnvFile(envPath) {
  try {
    const envContent = require('fs').readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      // Tolerate `export PIN=…`: the persister already rewrites such lines, so
      // without this the key was stored literally as "export PIN" and never
      // read back. The prefix is stripped before splitting on '='.
      const stmt = trimmed.replace(/^export\s+/, '');
      const idx = stmt.indexOf('=');
      if (idx === -1) return;
      const key = stmt.slice(0, idx).trim();
      let val = stmt.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    });
  } catch {}
}
try {
  const _p = require('path');
  loadEnvFile(_p.join(__dirname, '.env'));
  try {
    const _home = require('os').homedir();
    const _base = process.env.XDG_CONFIG_HOME || _p.join(_home, '.config');
    loadEnvFile(_p.join(_base, 'webtun', '.env'));
  } catch {}
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
  console.error('  Recent npm versions block install scripts by default. To fix:');
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
const dns = require('dns');
const { execSync, execFileSync, execFile, spawn } = require('child_process');

function getValidExecutable(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === '/' || trimmed === '\\') return null;
  try {
    if (fs.existsSync(trimmed)) {
      const st = fs.statSync(trimmed);
      if (st.isFile()) {
        return trimmed;
      }
    }
  } catch {}
  return null;
}

function resolveShell() {
  if (os.platform() === 'win32') {
    if (process.env.WEBTUN_SHELL && getValidExecutable(process.env.WEBTUN_SHELL)) {
      return process.env.WEBTUN_SHELL;
    }
    return 'powershell.exe';
  }
  const envShell = getValidExecutable(process.env.SHELL);
  if (envShell) return envShell;

  for (const cand of ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh', '/bin/zsh', '/usr/bin/zsh', '/bin/ash', '/bin/dash']) {
    const valid = getValidExecutable(cand);
    if (valid) return valid;
  }
  return '/bin/sh';
}
// Zip creation is stdlib-only (lib/zip-store.js, STORE/no-compression writer)
// so zipping works identically on Linux, macOS and Windows with no native
// modules, no shell-outs and no extra dependencies.
const { ZipStoreWriter } = require('./lib/zip-store');
const { ZipArchiveReader, safeZipEntryName } = require('./lib/zip-read');
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
// Each limiter owns its OWN window map: the auth (5/10s) and general (20/10s)
// limiters used to share one Map, so a single counter was incremented by both
// and the strict auth budget could be spent (or falsely tripped) by ordinary
// requests from the same IP.
function createRateLimiter(opts) {
  const windows = new Map();
  // Map size cap prevents blowup via spoofed X-Forwarded-For or IP rotation (F44)
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, win] of windows) { if (now > win.resetAt) windows.delete(key); }
  }, 60000);
  if (sweep.unref) sweep.unref();
  return (req, res, next) => {
    if (opts.skipWhenNoPin && !PIN) return next();
    const now = Date.now();
    // Use Express req.ip which respects trust proxy; avoids manual X-Forwarded-For spoofing (F8,F44)
    const key = req.ip || req.socket.remoteAddress || 'default';
    if (windows.size > 10000) {
      const firstKey = windows.keys().next().value;
      if (firstKey !== undefined) windows.delete(firstKey);
    }
    let win = windows.get(key);
    if (!win || now > win.resetAt) {
      win = { count: 0, resetAt: now + (opts.windowMs || 10000) };
      windows.set(key, win);
    }
    win.count++;
    if (win.count > (opts.limit || 10)) {
      try { res.setHeader('Retry-After', String(Math.max(1, Math.ceil((win.resetAt - now) / 1000)))); } catch {}
      return res.status(429).json({ error: opts.errorMsg || 'Too many requests' });
    }
    next();
  };
}

const authRateLimiter = createRateLimiter({ limit: 5, windowMs: 10000, errorMsg: 'Too many attempts', skipWhenNoPin: true });
const rateLimiter = createRateLimiter({ limit: 20, windowMs: 10000 });
// NOTE (documented shared budget): authRateLimiter intentionally guards login,
// PIN change, approve and veto together (5/10s per IP, single-owner box — one
// human, so one shared budget). Traffic on one endpoint consumes the same
// bucket; split into per-route limiters if multi-user operation is ever
// supported. skipWhenNoPin disables throttling only when the instance is open
// (no secret to brute-force).

const app = express();
app.disable('x-powered-by'); // don't advertise the stack
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Validated once, here: this is the single source of truth for the CLI, the
// Electron host and direct `node server.js` runs. An invalid $PORT ("abc",
// 99999) used to be passed straight to listen() and fail with a cryptic error.
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 3000;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(`  Warning: invalid PORT="${raw}" — falling back to 3000`);
    return 3000;
  }
  return n;
})();
// Mutable at runtime via POST /api/pin (persisted to __dirname/.env).
// All auth checks read this binding, so changes apply instantly.
let PIN = process.env.PIN || '';
// Resolved safely — ignores invalid or directory paths (e.g. SHELL="/" in containers)
const SHELL = resolveShell();
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

// Security headers — registered BEFORE express.static on purpose. When this
// middleware ran after it, every static response (index.html at /, /docs,
// icons, manifest, sw.js) was served with no CSP / X-Frame-Options /
// Referrer-Policy / Permissions-Policy at all.
// script-src keeps 'unsafe-inline': the frontend has no inline scripts left,
// but ~100 inline handlers (no bundler — see AGENTS.md) still need it.
// It still restricts script origins to self + jsDelivr + blob:, which
// previously was not enforced for the app shell at all.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https://*.trycloudflare.com wss: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net blob:; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com; img-src 'self' data: blob:; frame-src 'self' blob:; child-src 'self' blob:; worker-src 'self' blob: https://cdn.jsdelivr.net;");
  // HSTS only when the request really arrived over TLS (directly or via a
  // TLS-terminating reverse proxy). Sending it on plain HTTP is ignored by
  // browsers anyway, and a LAN-only install has no TLS to pin.
  // x-forwarded-proto is client-controlled: honor it only behind a trusted
  // proxy (TRUST_PROXY=true); otherwise only direct TLS (req.secure).
  const trustProxyHsts = process.env.TRUST_PROXY === 'true';
  if (req.secure || (trustProxyHsts && req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// JSON body limits: keep the global default small and only let the one route that
// legitimately carries file content buffer more. A flat 50 MB global limit meant a
// 40 MB POST to any endpoint was buffered in full before that route's own 10 MB
// guard could reject it. (F42 / B-L4)
// Overridable via env: JSON_LIMIT (global, default 2mb), JSON_LIMIT_LARGE
// (default 12mb, for LARGE_JSON_ROUTES). Invalid values fall back to defaults.
function parseJsonLimit(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  const m = raw.trim().toLowerCase().match(/^(\d+)(b|kb|mb)$/);
  if (!m) { console.warn(`[webtun] invalid JSON_LIMIT value ${JSON.stringify(raw)}, using ${fallback}`); return fallback; }
  return `${m[1]}${m[2]}`;
}
const JSON_LIMIT_BASE = parseJsonLimit(process.env.JSON_LIMIT, '2mb');
const JSON_LIMIT_LARGE = parseJsonLimit(process.env.JSON_LIMIT_LARGE, '12mb');
const LARGE_JSON_ROUTES = new Set(['/api/files/write']);
app.use((req, res, next) => {
  // Trailing-slash tolerant: /api/files/write/ gets the large budget too.
  const p = typeof req.path === 'string' ? req.path.replace(/\/+$/, '') || '/' : req.path;
  const limit = LARGE_JSON_ROUTES.has(p) ? JSON_LIMIT_LARGE : JSON_LIMIT_BASE;
  return express.json({ limit })(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// In-app user guide — single static page (public/docs.html, also published to GitHub Pages),
// served like index.html, reachable at /docs
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// Handle malformed JSON gracefully. Registered after express.json (the only
// middleware that can raise entity.parse.failed) so parse errors still land
// here, while every other error keeps flowing down the chain normally.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  // Oversized bodies are rejected by the parser, so return JSON (not Express's
  // default HTML error page) — the client turns a JSON {error} into a toast.
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Request body too large' });
  }
  next(err);
});

// Trust proxy for proper IP detection behind reverse proxy
// 'loopback' only trusts 127.0.0.1/::1 — safe default for direct connections
// Set TRUST_PROXY=true in .env if behind a reverse proxy
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : 'loopback');

// Auth secrets are short (PIN ≤64 chars, session tokens 64 hex). Anything
// longer is attacker input (e.g. a 50MB body / huge ?token=), and the padded
// compare below would allocate a buffer of max(lenA,lenB) per request — an
// easy memory-amplification DoS.
const MAX_AUTH_SECRET_LEN = 256;
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length > MAX_AUTH_SECRET_LEN || b.length > MAX_AUTH_SECRET_LEN) return false;
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
// Login sessions: revocable per-device tokens. A new session starts ACTIVE
// only when no other active session exists (bootstrap); otherwise it starts
// PENDING and can do nothing until a different active session approves it —
// even with the correct PIN. The raw PIN is still accepted for back-compat
// (local CLI/curl), but remote raw-PIN callers are gated the same way.
// token (64-hex) -> { ip, device, createdAt, lastSeen, status, expiresAt, timer }
const authSessions = new Map();
const SESSION_IDLE_MS = 30 * 24 * 3600 * 1000; // expire after 30d idle
const SESSION_MAX = 100;
const SESSION_PENDING_MS = 5 * 60 * 1000; // pending approvals lapse after 5min (deny by default)
const SESSION_PENDING_MAX = 5;
const authSessionSweep = setInterval(() => {
  const _now = Date.now();
  for (const [_t, _s] of authSessions) {
    if (_s.status === 'pending' && _now > (_s.expiresAt || 0)) { clearSessionTimer(_s); authSessions.delete(_t); continue; }
    if (_now - (_s.lastSeen || 0) > SESSION_IDLE_MS) { clearSessionTimer(_s); authSessions.delete(_t); }
  }
}, 60000);
// Maintenance timers must not keep the process alive on their own — the HTTP
// listener is what should own the lifecycle.
if (authSessionSweep.unref) authSessionSweep.unref();
// Short-lived single-purpose tokens for file-preview subresources, so the live
// session secret never lands in frame-readable preview DOM (audit run-1 F1).
// token (64-hex) -> { dir (absolute base dir), exp }. Accepted ONLY by
// GET /api/files/image, and ONLY for paths contained in dir. A stolen preview
// token discloses at most that directory's files via the image endpoint —
// never the session, shell, or any other API.
const previewFileTokens = new Map();
const PREVIEW_FILE_TOKEN_TTL_MS = 10 * 60 * 1000;
const PREVIEW_FILE_TOKEN_MAX = 200;
function prunePreviewFileTokens(now) {
  for (const [t, r] of previewFileTokens) {
    if (!r || r.exp <= now) { try { previewFileTokens.delete(t); } catch {} }
  }
}
function mintPreviewFileToken(dir) {
  const now = Date.now();
  prunePreviewFileTokens(now);
  while (previewFileTokens.size >= PREVIEW_FILE_TOKEN_MAX) {
    const oldest = previewFileTokens.keys().next().value;
    if (oldest === undefined) break;
    try { previewFileTokens.delete(oldest); } catch { break; }
  }
  const t = crypto.randomBytes(32).toString('hex');
  previewFileTokens.set(t, { dir, exp: now + PREVIEW_FILE_TOKEN_TTL_MS });
  return t;
}
// Expired tokens lingered until the next mint; sweep periodically instead.
const previewFileTokenSweep = setInterval(() => {
  try { prunePreviewFileTokens(Date.now()); } catch {}
}, 60000);
if (previewFileTokenSweep.unref) previewFileTokenSweep.unref();
function clearSessionTimer(s) { try { if (s && s.timer) clearTimeout(s.timer); } catch {} if (s) s.timer = null; }
// Arm the deny-by-default expiry for a pending session. Shared by first-issue
// and by the bootstrap demotion path (see /api/auth) so both behave identically.
function armPendingTimer(token, s) {
  s.status = 'pending';
  s.expiresAt = Date.now() + SESSION_PENDING_MS;
  clearSessionTimer(s);
  s.timer = setTimeout(() => {
    // Deny by default: lapse the request and tell remaining clients
    if (authSessions.get(token) === s) {
      authSessions.delete(token);
      broadcastClientEvent({ event: 'sessions-changed' });
    }
  }, SESSION_PENDING_MS);
}
function countActiveSessions(exceptToken) {
  let n = 0;
  for (const [t, s] of authSessions) {
    if (s && s.status === 'active' && t !== exceptToken) n++;
  }
  return n;
}
function countPendingSessions() {
  let n = 0;
  for (const [, s] of authSessions) { if (s && s.status === 'pending') n++; }
  return n;
}

function parseDevice(ua, hint) {
  if (hint && typeof hint === 'string' && hint.trim()) return hint.trim().slice(0, 80);
  ua = ua || '';
  let os = 'Unknown OS';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad/i.test(ua)) os = 'iOS';
  else if (/mac os/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';
  let br = '';
  if (/edg\//i.test(ua)) br = 'Edge';
  else if (/chrome\//i.test(ua)) br = 'Chrome';
  else if (/firefox\//i.test(ua)) br = 'Firefox';
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) br = 'Safari';
  return br ? `${br} · ${os}` : os;
}
// Real client IP for DISPLAY (session list, alerts). Behind cloudflared the
// socket is always loopback, so prefer CF-Connecting-IP / XFF-first. Display
// only — never used for auth decisions (spoofable by design).
function clientIp(req) {
  try {
    const h = (req && req.headers) || {};
    const cf = h['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
    const xff = h['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
    return req.ip || (req.socket && req.socket.remoteAddress) || '';
  } catch { return ''; }
}
// Demote an over-granted bootstrap session to pending: it stays alive but
// powerless until an existing active session approves it. Tolerates an unknown
// token (nothing to demote) rather than throwing.
function demoteToPending(token, s) {
  const target = s || authSessions.get(token);
  if (!target) return null;
  armPendingTimer(token, target);
  return authSessions.get(token);
}

function issueSession(req, deviceHint, status) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const s = {
    ip: clientIp(req),
    device: parseDevice(req.headers && req.headers['user-agent'], deviceHint),
    createdAt: now, lastSeen: now,
    status: status || 'active',
    expiresAt: 0, timer: null,
  };
  authSessions.set(token, s);
  if (s.status === 'pending') armPendingTimer(token, s);
  while (authSessions.size > SESSION_MAX) {
    const oldest = authSessions.keys().next().value;
    if (oldest === undefined) break;
    const _o = authSessions.get(oldest);
    clearSessionTimer(_o);
    authSessions.delete(oldest);
  }
  return token;
}
function getSession(token) {
  if (typeof token !== 'string' || !token) return null;
  const s = authSessions.get(token);
  if (!s) return null;
  if (Date.now() - (s.lastSeen || 0) > SESSION_IDLE_MS) { authSessions.delete(token); return null; }
  s.lastSeen = Date.now();
  return s;
}

// Remote callers presenting the raw PIN (no session) are trusted only on
// loopback or when nobody else is signed in — otherwise they must sign in
// through /api/auth and wait for approval like everyone else.
function rawPinAllowed(req) {
  try {
    if (isLoopbackReq(req)) return true;
    return countActiveSessions() === 0;
  } catch { return false; }
}
function checkPin(req, res, next) {
  if (!PIN) return next();
  // Single-purpose preview-file tokens (set by checkPreviewFileToken on the
  // image route only) already proved dir-scoped read authority — no session needed.
  if (req.previewFileToken) return next();
  // Validate token is string to prevent array injection (?token=a&token=b) (F45)
  const raw = req.headers['x-pin-token'] || req.query.token;
  const token = typeof raw === 'string' ? raw.trim() : '';
  // Note: query token kept for backward compat (WS needs ?token=) but header preferred; query may leak to logs.
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (constantTimeEqual(token, PIN)) {
    if (!rawPinAllowed(req)) {
      return res.status(403).json({ error: 'Approval required — sign in from the app so an existing session can approve this device', approvalRequired: true });
    }
    req.authToken = token; req.authSession = null; return next();
  } // legacy raw-PIN
  const s = getSession(token);
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  req.authToken = token; req.authSession = s;
  if (s.status === 'pending') {
    // Pending sessions can do nothing except check their own status (and
    // cancel themselves) until a different active session approves them.
    if (req.path === '/api/auth/me') return next();
    if (req.method === 'DELETE' && req.path === '/api/auth/sessions/' + token) return next();
    return res.status(403).json({ error: 'Session awaiting approval from another device', pending: true });
  }
  return next();
}

// Loopback detection for privileged first-run actions (no XFF involved).
// Critical subtlety: behind cloudflared/a reverse proxy every connection's
// socket is loopback, so proxy headers disqualify "local". An attacker can
// add X-Forwarded-For but can never strip the CF-Ray Cloudflare adds —
// and erring toward "remote" only ever denies, never grants.
// Shared by the HTTP and WebSocket paths so the two can never disagree: the WS
// handshake has a socket and headers but no Express request, and used to fake
// one (which is exactly how the two gates drift apart).
function isLoopbackSocket(socket, headers) {
  const h = headers || {};
  if (h['cf-ray'] || h['cf-connecting-ip'] || h['cf-ipcountry'] || h['cf-visitor'] || h['x-forwarded-for'] || h['forwarded']) return false;
  const ip = String((socket && socket.remoteAddress) || '').toLowerCase();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function isLoopbackReq(req) {
  if (!req) return false;
  // Prefer the socket address (what the kernel says) over a proxy-derived
  // req.ip; forwarded headers are already rejected above.
  const sock = req.socket || { remoteAddress: req.ip };
  return isLoopbackSocket(sock, req.headers);
}
// Destructive endpoints stay disabled until the owner enables PIN protection.
// (With PIN empty, checkPin is a pass-through — this closes that hole.)
function requirePinSet(req, res, next) {
  if (!PIN) return res.status(403).json({ error: 'Enable PIN protection first (Settings → Security)' });
  next();
}

app.get('/api/auth/required', (req, res) => {
  res.json({ required: !!PIN });
});

// Version is authed (no free recon for targeted exploits); /api/auth/required
// stays public for the unlock flow. The About fetch sends the token header.
app.get('/api/version', checkPin, (req, res) => {
  res.json({ version: require('./package.json').version, port: PORT });
});

app.post('/api/auth', authRateLimiter, (req, res) => {
  const { pin, device } = req.body || {};
  if (!PIN) return res.json({ success: true, token: 'open' });
  if (pin && constantTimeEqual(pin, PIN)) {
    // Bootstrap: nobody signed in → active immediately. Otherwise the new
    // session pends until a different active session approves it.
    if (countActiveSessions() === 0) {
      const token = issueSession(req, device, 'active');
      let s = authSessions.get(token);
      // Post-condition, not the gate itself: at most ONE session may hold the
      // bootstrap grant. This handler is synchronous, so Node runs the count
      // above and the issue below without yielding and they cannot interleave
      // (the audit's B-C6 describes a race that needs an `await` in between).
      // The assertion keeps that invariant true even if an await is added here
      // later — a second unrestricted session is demoted, never granted.
      if (s && countActiveSessions(token) !== 0) {
        s = demoteToPending(token, s);
        broadcastClientEvent({ event: 'session-pending', id: token, ip: s.ip, device: s.device, at: s.createdAt, expiresAt: s.expiresAt });
        return res.json({ success: true, pending: true, token, expiresAt: s.expiresAt });
      }
      if (s) broadcastClientEvent({ event: 'new-login', ip: s.ip, device: s.device, at: s.createdAt });
      return res.json({ success: true, token });
    }
    if (countPendingSessions() >= SESSION_PENDING_MAX) {
      return res.status(429).json({ error: 'Too many pending approvals — ask an existing session to review them' });
    }
    const token = issueSession(req, device, 'pending');
    const s = authSessions.get(token);
    if (s) broadcastClientEvent({ event: 'session-pending', id: token, ip: s.ip, device: s.device, at: s.createdAt, expiresAt: s.expiresAt });
    return res.json({ success: true, pending: true, token, expiresAt: s ? s.expiresAt : 0 });
  }
  res.status(401).json({ error: 'Unauthorized' });
});

// Validate the current token (resume trusted devices without re-login).
// Pending sessions may poll here to learn the moment they are approved.
app.get('/api/auth/me', checkPin, (req, res) => {
  if (req.authSession && req.authSession.status === 'pending') {
    return res.json({ ok: true, pending: true, expiresAt: req.authSession.expiresAt || 0 });
  }
  res.json({ ok: true, legacy: !req.authSession, session: req.authSession || undefined });
});

// Active login sessions for the Security panel (current flagged via req.authToken).
app.get('/api/auth/sessions', checkPin, (req, res) => {
  const list = [];
  for (const [token, s] of authSessions) {
    list.push({ id: token, device: s.device, ip: s.ip, createdAt: s.createdAt, lastSeen: s.lastSeen, current: token === req.authToken });
  }
  list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  for (const item of list) {
    const s = authSessions.get(item.id);
    item.status = (s && s.status) || 'active';
    if (item.status === 'pending') item.expiresAt = s.expiresAt || 0;
  }
  // Pending rotation (if any) so the Security panel can show Approve/Revert.
  // Never exposes the proposed PIN — only who asked and when it lapses.
  const pending = pendingPinChange ? {
    device: pendingPinChange.device,
    ip: pendingPinChange.ip,
    expiresAt: pendingPinChange.expiresAt,
    mine: pendingPinChange.requesterToken === req.authToken,
  } : null;
  res.json({ sessions: list, pending });
});

// Approve a pending session. Only a DIFFERENT active session may approve —
// pending sessions approve nothing, and raw-PIN callers approve nothing
// (otherwise the PIN alone would defeat the gate).
app.post('/api/auth/sessions/:id/approve', checkPin, (req, res) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  const t = authSessions.get(id);
  if (!t) return res.status(404).json({ error: 'session not found' });
  if (t.status === 'active') return res.json({ success: true });
  if (!req.authSession || req.authSession.status !== 'active' || req.authToken === id) {
    return res.status(403).json({ error: 'Approval needs a different active session' });
  }
  clearSessionTimer(t);
  t.status = 'active'; t.lastSeen = Date.now(); t.expiresAt = 0;
  broadcastClientEvent({ event: 'sessions-changed' });
  res.json({ success: true });
});

// Revoke one login session. Kicked sockets get a session-revoked push.
// A pending session may cancel itself; anyone else needs an active session.
app.delete('/api/auth/sessions/:id', checkPin, (req, res) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  if (req.authSession && req.authSession.status === 'pending' && req.authToken !== id) {
    return res.status(403).json({ error: 'Session awaiting approval from another device', pending: true });
  }
  const t = authSessions.get(id);
  clearSessionTimer(t);
  const existed = authSessions.delete(id);
  if (existed) {
    pushSessionRevoked(id);
    // Tell remaining clients so header counts refresh
    broadcastClientEvent({ event: 'sessions-changed' });
  }
  res.json({ success: true, revoked: existed });
});

// Writable runtime data dir — always ~/.config/webtun (or
// $XDG_CONFIG_HOME/webtun), for repo checkouts and installs alike. The legacy
// __dirname location is only a migration SOURCE (see migrateLegacyState) and
// the last-resort fallback below. One writable home keeps PIN/history/tunnel
// persistence identical for `node server.js`, global/npx installs, and the
// packaged Electron app (whose __dirname lives inside read-only app.asar).
function resolveDataDir() {
  try {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const dir = path.join(base, 'webtun');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch { return __dirname; }
}
const DATA_DIR = resolveDataDir();
// One-time migration: carry state forward from the legacy __dirname location.
// Deliberately NOT run at import time — requiring this module should not copy files
// into the user's config directory. startServer() calls it, which covers both real
// entry points (this file run directly, and the CLI/Electron fork).
let _migrated = false;
function migrateLegacyState() {
  if (_migrated) return;
  _migrated = true;
  for (const _f of ['.env', '.cmdhist.json', '.tunnels.json', 'tunnel-url.txt']) {
    try {
      const _dst = path.join(DATA_DIR, _f), _src = path.join(__dirname, _f);
      if (DATA_DIR !== __dirname && !fs.existsSync(_dst) && fs.existsSync(_src)) {
        fs.copyFileSync(_src, _dst);
      }
    } catch {}
  }
}
// Persist PIN to the writable .env (same file the startup parser reads).
// Atomic tmp+rename with 0600, mirroring .cmdhist.json writes.
function isPackagedAsar() {
  // Packaged Electron runs from inside app.asar (read-only virtual FS) or its
  // .unpacked sidecar — neither is a valid home for a writable .env.
  try { return String(__dirname).includes('app.asar'); } catch { return false; }
}
function envPathForWrite() {
  if (!isPackagedAsar()) {
    try {
      if (fs.existsSync(path.join(__dirname, '.env'))) return path.join(__dirname, '.env');
      fs.accessSync(__dirname, fs.constants.W_OK);
      return path.join(__dirname, '.env');
    } catch {}
  }
  return path.join(DATA_DIR, '.env');
}
const ENV_PATH = envPathForWrite();
// systemd's EnvironmentFile re-parses this file with its own rules, where an
// unquoted value containing whitespace or '#' is truncated. Quote only when
// needed, and never introduce escapes: the startup loader strips surrounding
// quotes but does not unescape, so escaping would corrupt the round-trip.
function envValue(v) {
  const s = String(v == null ? '' : v);
  if (s === '') return '';
  if (/[\s#]/.test(s) && !/["'\\]/.test(s)) return '"' + s + '"';
  return s;
}
// Values needing both whitespace/# quoting AND containing quotes/backslashes
// cannot round-trip (loader strips quotes but never unescapes; systemd would
// truncate the unquoted form). Callers must reject these PINs upfront.
function envValueUnsafe(v) {
  const s = String(v == null ? '' : v);
  return /[\s#]/.test(s) && /["'\\]/.test(s);
}
function persistPinToEnv(pin) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let found = false;
  const enc = envValue(pin);
  const out = lines.map(l => {
    if (!found && /^\s*(export\s+)?PIN\s*=/.test(l)) { found = true; return `PIN=${enc}`; }
    return l;
  });
  if (!found) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`PIN=${enc}`);
  }
  const tmp = ENV_PATH + '.tmp';
  fs.writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, ENV_PATH);
}

// Two-person rule for PIN rotation: a request from a fresh session (<10min
// old) while other sessions exist does NOT apply instantly — it pends 60s
// for approval from a different session. An attacker's first act with a
// stolen PIN is always a fresh session, so hostile rotations get vetoed in
// the very moment instead of locking the owner out. Trusted callers
// (session ≥10min, sole session, or first setup) rotate instantly.
const PIN_TRUST_MS = 10 * 60 * 1000;
const PIN_PENDING_MS = 60 * 1000;
let pendingPinChange = null; // { newPIN, requesterToken, device, ip, expiresAt, timer }
function clearPendingPinChange() {
  if (pendingPinChange && pendingPinChange.timer) { try { clearTimeout(pendingPinChange.timer); } catch {} }
  pendingPinChange = null;
}
function describeChanger(req) {
  try {
    if (req.authSession && req.authSession.device) return req.authSession.device;
    return parseDevice(req.headers && req.headers['user-agent'], null);
  } catch { return 'unknown device'; }
}
// Performs the rotation: persist first, then wipe sessions. Persist-first so a
// failed .env write never leaves memory on the new PIN while disk still holds
// the old one (which locked the owner out after the next restart with all
// sessions already destroyed). On persist failure the rotation is refused and
// existing sessions are left untouched.
function applyPinRotation(req, next, byDevice) {
  let persisted = false, persistError = '';
  try { persistPinToEnv(next); persisted = true; }
  catch (e) { persistError = e.message || 'write failed'; }
  if (!persisted) {
    const err = new Error('PIN persist failed: ' + persistError);
    err.status = 500;
    throw err;
  }
  PIN = next;
  process.env.PIN = next;
  // Any successful rotation invalidates queued two-person requests.
  clearPendingPinChange();
  // A PIN change invalidates every issued session token (they were minted
  // under the old secret). Clients re-login with the new PIN.
  // Broadcast first (with the changer's identity) so other tabs learn WHO
  // rotated it before their sessions die — hostile rotations stay visible.
  try {
    broadcastClientEvent({ event: 'pin-changed', ip: req.ip || '', device: byDevice, at: Date.now(), disabled: !next });
  } catch {}
  const sessionsRevoked = authSessions.size;
  authSessions.clear();
  // Every token minted under the old PIN is now dead. Closing the sockets is
  // not cosmetic: the handshake is the only other auth check, so a client that
  // ignored the advisory event would otherwise keep a live shell forever.
  try { closeInvalidSockets('PIN changed'); } catch {}
  return { persisted: true, persistError: '', sessionsRevoked };
}

// Set/change/disable the PIN at runtime. Authed callers only (checkPin),
// brute-force guarded (authRateLimiter). Empty newPin disables protection.
// When protection is off (!PIN), only loopback may set the first PIN —
// otherwise any visitor could lock out the owner (and persist it to .env).
app.post('/api/pin', authRateLimiter, checkPin, (req, res) => {
  try {
    if (!PIN && !isLoopbackReq(req)) {
      return res.status(403).json({ error: 'PIN setup is only allowed from this machine' });
    }
    const { currentPin, newPin } = req.body || {};
    if (PIN) {
      if (typeof currentPin !== 'string' || !constantTimeEqual(currentPin, PIN)) {
        return res.status(401).json({ error: 'Current PIN is incorrect' });
      }
    }
    // Missing/non-string newPin must not silently disable protection: only an
    // explicit "" disables. Absent newPin is a 400.
    if (newPin === undefined || typeof newPin !== 'string') {
      return res.status(400).json({ error: 'newPin is required (pass "" to disable protection)' });
    }
    let next = newPin;
    // Set path used to trim while login compares exactly, so space-padded PINs
    // were unsettable-but-silent. Reject padded PINs instead of mangling them.
    if (next !== next.trim()) return res.status(400).json({ error: 'PIN must not have leading or trailing spaces' });
    if (/[\r\n\0]/.test(next)) return res.status(400).json({ error: 'PIN contains invalid characters' });
    if (next.length > 64) return res.status(400).json({ error: 'PIN must be 64 characters or less' });
    if (next && envValueUnsafe(next)) return res.status(400).json({ error: 'PIN cannot combine spaces/#/quotes — it would not survive .env reload' });
    // Two-person rule (only when protection is already on — first setup is instant)
    if (PIN) {
      const requesterToken = req.authToken || null;
      const otherCount = countActiveSessions(requesterToken);
      const age = req.authSession ? Date.now() - (req.authSession.createdAt || 0) : 0;
      const trusted = req.authSession ? age >= PIN_TRUST_MS : otherCount === 0;
      if (!trusted && otherCount > 0) {
        if (pendingPinChange) return res.status(409).json({ error: 'A PIN change is already awaiting approval' });
        const device = describeChanger(req);
        const ip = req.ip || '';
        pendingPinChange = { newPIN: next, requesterToken, device, ip, expiresAt: Date.now() + PIN_PENDING_MS, timer: null };
        pendingPinChange.timer = setTimeout(() => {
          // Deny by default: expiry cancels and kicks the requester
          if (!pendingPinChange) return;
          const p = pendingPinChange;
          clearPendingPinChange();
          if (p.requesterToken) {
            authSessions.delete(p.requesterToken);
            pushSessionRevoked(p.requesterToken);
          }
          broadcastClientEvent({ event: 'pin-change-resolved', approved: false, expired: true, device: p.device, ip: p.ip });
          broadcastClientEvent({ event: 'sessions-changed' });
        }, PIN_PENDING_MS);
        broadcastClientEvent({ event: 'pin-change-pending', device, ip, requester: requesterToken, expiresAt: pendingPinChange.expiresAt });
        return res.json({ success: true, pending: true, expiresAt: pendingPinChange.expiresAt });
      }
    }
    const out = applyPinRotation(req, next, describeChanger(req));
    res.json({ success: true, protected: !!PIN, ...out });
  } catch (e) {
    sendErr(res, e);
  }
});

// Approve a pending rotation (a DIFFERENT session must approve — the
// requester can never approve its own). Approver gets a fresh token since
// rotation wipes all sessions.
app.post('/api/pin/approve', authRateLimiter, checkPin, (req, res) => {
  try {
    if (!pendingPinChange) return res.status(404).json({ error: 'No pending PIN change' });
    if (!req.authSession || !req.authToken || req.authToken === pendingPinChange.requesterToken) {
      return res.status(403).json({ error: 'Approval needs a different signed-in session' });
    }
    const p = pendingPinChange;
    clearPendingPinChange();
    const out = applyPinRotation(req, p.newPIN, describeChanger(req));
    // Fresh session for the approver (rotation wiped theirs too)
    const token = issueSession(req, null);
    broadcastClientEvent({ event: 'pin-change-resolved', approved: true, device: p.device, ip: p.ip });
    res.json({ success: true, protected: !!PIN, token, ...out });
  } catch (e) {
    sendErr(res, e);
  }
});

// Veto a pending rotation: cancel it and kick the requester immediately.
app.post('/api/pin/veto', authRateLimiter, checkPin, (req, res) => {
  try {
    if (!pendingPinChange) return res.status(404).json({ error: 'No pending PIN change' });
    if (!req.authSession || !req.authToken || req.authToken === pendingPinChange.requesterToken) {
      return res.status(403).json({ error: 'Only a different signed-in session can veto' });
    }
    const p = pendingPinChange;
    clearPendingPinChange();
    if (p.requesterToken) {
      authSessions.delete(p.requesterToken);
      pushSessionRevoked(p.requesterToken);
    }
    broadcastClientEvent({ event: 'pin-change-resolved', approved: false, vetoed: true, device: p.device, ip: p.ip });
    broadcastClientEvent({ event: 'sessions-changed' });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
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
  // Case-only rename (sample.txt → Sample.txt) on case-insensitive filesystems
  // can no-op or error when resolved through the same directory entry: bounce
  // through a temporary name so the new casing always lands.
  if (src !== dst && src.toLowerCase() === dst.toLowerCase()) {
    const tmp = dst + '.webtun-case-' + crypto.randomBytes(4).toString('hex');
    await fsPromises.rename(src, tmp);
    try {
      await fsPromises.rename(tmp, dst);
    } catch (e) {
      try { await fsPromises.rename(tmp, src); } catch {}
      throw e;
    }
    return;
  }
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

// Central error → response mapping. Absolute paths used to travel straight to
// the client through e.message ("ENOENT: no such file or directory, open
// '/home/you/secret/notes.md'"), which leaked filesystem layout to any caller.
const FS_ERR_MSG = {
  ENOENT: 'Path not found', EACCES: 'Permission denied', EPERM: 'Permission denied',
  EISDIR: 'Path is a directory', ENOTDIR: 'Not a directory', ELOOP: 'Too many symbolic links',
  ENOSPC: 'No space left on device', EMFILE: 'Too many open files', ENFILE: 'Too many open files',
  ENAMETOOLONG: 'Path too long', EROFS: 'Read-only filesystem', EXDEV: 'Cross-device operation not supported',
  EBUSY: 'Resource busy'
};
function redactPaths(msg) {
  // Windows drive paths plus POSIX absolute paths that begin a word (' /, " /,
  // = /, : /). The (?!\/) guard leaves URLs alone, so a message quoting
  // https://host/a/b survives while '/home/you/secret' becomes '<path>'.
  // Segment class is deliberately broad ([^"'`\n\r()\[\]]): ASCII-only \w cut
  // non-ASCII names (документ) and spaces (C:\Program Files) mid-path and
  // leaked the remainder. Tilde-relative (~/x) and bare relative leaks are
  // redacted too.
  let s = String(msg);
  s = s.replace(/https?:\/\/[^/\s"'`]+/g, m => (/[@]/.test(m) ? m.replace(/^(https?:\/\/)[^@]*@/, '$1<redacted>@') : m));
  s = s.replace(/([A-Za-z]:\\[^"'`\n\r]*)/g, '<path>');
  s = s.replace(/(^|[\s"'(=:,])~\/[^"'`\n\r()\[\]]*/g, '$1<path>');
  s = s.replace(/(^|[\s"'(=:,])\/(?!\/)[^"'`\n\r()\[\]]*/g, (m, pre) => {
    const body = m.slice(pre.length).replace(/[\s.,;:!?]+$/, '');
    if (!body || body === '/') return m;
    return pre + '<path>';
  });
  return s;
}
function safeErr(e, fallbackStatus) {
  const raw = (e && e.message) || '';
  const code = (e && e.code) || '';
  let status = (e && e.status) || fallbackStatus || 500;
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
  const fsError = Object.prototype.hasOwnProperty.call(FS_ERR_MSG, code);
  // Raw filesystem messages embed absolute paths, so they are replaced by a
  // code-derived sentence. Our own thrown errors keep their text (redacted) —
  // validation feedback like "refusing to kill pid 1" must not be swallowed.
  const msg = fsError ? FS_ERR_MSG[code] : (redactPaths(raw) || 'Operation failed');
  if (status >= 500) {
    try { console.warn('[webtun] error:', status, code || '-', raw.slice(0, 300)); } catch {}
  }
  const body = { error: msg };
  if (code) body.code = code;
  return { status, body };
}
// Sanitized one-line text for batch responses ({ results: [{ error }] }).
function errText(e) { return safeErr(e).body.error; }
// Git CLI stderr is bound for the UI (it is genuinely useful), so it keeps its
// wording, but paths are redacted and the length is bounded. Remote URLs and
// embedded tokens (https://<token>@host) are scrubbed to <redacted>.
function gitErrText(e, fallback, max = 500) {
  return redactPaths((e && e.message) || '').trim().slice(0, max) || fallback;
}
// Timeouts/auth failures must not flatten to 400: callers need to tell
// retryable (504/401/403) from bad-request. Non-git routes keep safeErr.
function gitErrStatus(e, fallback = 400) {
  const m = String((e && e.message) || '').toLowerCase();
  if (/timed out|timeout|timed-out/.test(m)) return 504;
  if (/authentication|permission denied \(publickey\)|could not read from remote|invalid username|password/.test(m)) return 401;
  return fallback;
}
function sendErr(res, e, fallbackStatus) {
  const { status, body } = safeErr(e, fallbackStatus);
  if (res.headersSent) { try { res.end(); } catch {} return; }
  try { res.status(status).json(body); } catch {}
}

async function dirSize(dir, maxDepth = 10) {
  // Called on a plain file too: report it directly instead of walking into a
  // readdir() that can only fail (used to answer 0).
  const rootStat = await fsPromises.lstat(dir).catch(() => null);
  if (rootStat && !rootStat.isDirectory()) return rootStat.isFile() ? rootStat.size : 0;
  let total = 0;
  let entryCount = 0;
  const sizeErrors = []; // hard failures are re-thrown once the walk drains
  const MAX_ENTRIES = 50000;
  const visited = new Set();
  const CONCURRENCY = 8; // ONE global budget — was 32 per directory level (×N^depth)
  const stack = [[dir, 0]];
  const pending = new Set();
  while (stack.length || pending.size) {
    while (stack.length && pending.size < CONCURRENCY) {
      const [d, depth] = stack.pop();
      if (depth > maxDepth) continue;
      const task = (async () => {
        let real;
        // realpathSync() blocked the event loop once per directory; this is
        // called by size/zip/download on possibly huge trees.
        try { real = await fsPromises.realpath(d); } catch { real = path.resolve(d); }
        if (visited.has(real)) return;
        visited.add(real);
        let entries;
        try { entries = await fsPromises.readdir(d, { withFileTypes: true }); } catch { return; }
        entryCount += entries.length;
        if (entryCount > MAX_ENTRIES) {
          const e = new Error('Directory has too many entries (max ' + MAX_ENTRIES + ')');
          e.status = 413;
          throw e;
        }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isSymbolicLink() || e.isDirectory()) {
            // Symlinked directories stay navigable when the whole filesystem is
            // exposed (the documented default). Cycles terminate because every
            // directory is resolved to its realpath and recorded in `visited`
            // above. Under the sandbox (ALLOW_FULL_FS=false) links are skipped,
            // and symlinked *files* are never counted in either mode — a link
            // would report someone else's bytes as the user's own.
            if (e.isSymbolicLink()) {
              if (!ALLOW_FULL_FS) continue;
              let tgt; try { tgt = await fsPromises.stat(full); } catch { continue; }
              if (!tgt.isDirectory()) continue;
            }
            stack.push([full, depth + 1]);
            continue;
          }
          if (!e.isFile()) continue;
          try {
            const lst = await fsPromises.lstat(full);
            if (lst.isFile()) total += lst.size;
          } catch {}
        }
      })().catch(err => { sizeErrors.push(err); });
      pending.add(task);
      task.then(() => pending.delete(task));
    }
    if (pending.size) await Promise.race([...pending]);
  }
  if (sizeErrors.length) throw sizeErrors[0];
  return total;
}

const ZIP_MAX_TOTAL = 1 * 1024 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 50000;

// Walk the requested roots ourselves instead of handing directories to a zip
// library's recursive helper: the previous version stat'ed twice (lstatSync
// then statSync) around an async dirSize() — a TOCTOU window where the checked
// size was not the size sent. Here every entry is lstat'ed once, links are
// skipped outright, and the running total is the authoritative cap.
async function collectZipEntries(roots) {
  const items = [];
  let totalBytes = 0;
  const addFile = (full, name, size) => {
    totalBytes += size;
    if (totalBytes > ZIP_MAX_TOTAL) {
      const e = new Error('Total size exceeds 1GB'); e.status = 413; throw e;
    }
    if (items.length >= ZIP_MAX_ENTRIES) {
      const e = new Error('Too many entries (max ' + ZIP_MAX_ENTRIES + ')'); e.status = 413; throw e;
    }
    items.push({ type: 'file', path: full, name });
  };
  for (const root of roots) {
    let lst;
    try { lst = await fsPromises.lstat(root.fullPath); }
    catch (e) { const err = new Error('Cannot read ' + path.basename(root.fullPath)); err.status = e.code === 'ENOENT' ? 404 : 500; err.code = e.code; throw err; }
    if (lst.isSymbolicLink()) continue; // never archive through a link
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, root.fullPath)) {
      const e = new Error('Access denied: entry outside workspace'); e.status = 403; throw e;
    }
    if (lst.isFile()) { addFile(root.fullPath, root.nameInZip, lst.size); continue; }
    if (!lst.isDirectory()) continue;
    items.push({ type: 'dir', name: root.nameInZip });
    const stack = [[root.fullPath, root.nameInZip]];
    while (stack.length) {
      const [d, rel] = stack.pop();
      let entries;
      try { entries = await fsPromises.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const full = path.join(d, ent.name);
        const name = rel ? rel + '/' + ent.name : ent.name;
        if (ent.isDirectory()) {
          if (items.length >= ZIP_MAX_ENTRIES) {
            const e = new Error('Too many entries (max ' + ZIP_MAX_ENTRIES + ')'); e.status = 413; throw e;
          }
          items.push({ type: 'dir', name });
          stack.push([full, name]);
        } else if (ent.isFile()) {
          let st;
          try { st = await fsPromises.lstat(full); } catch { continue; }
          if (st.isFile()) addFile(full, name, st.size);
        }
      }
    }
  }
  return items;
}

// Stream collected entries through the STORE writer (no compression —
// downloads stay universally readable and dependency-free).
async function writeItemsToZip(writer, items) {
  await writer.writeAll(items);
}

async function createZipArchive(entries, zipPath) {
  // Ensure destination inside workspace (F63)
  if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, zipPath)) {
    const e = new Error('Access denied: zip destination outside workspace'); e.status = 403; throw e;
  }
  // Collected before the stream opens, so a rejected archive never leaves a
  // truncated .zip behind.
  const items = await collectZipEntries(entries);
  const output = fs.createWriteStream(zipPath);
  const writer = new ZipStoreWriter(output, { maxTotal: ZIP_MAX_TOTAL });
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      try { output.destroy(); } catch {}
      try { fs.unlinkSync(zipPath); } catch {}
      reject(err);
    };
    output.on('close', () => { if (!settled) { settled = true; resolve(); } });
    output.on('error', fail);
    writeItemsToZip(writer, items).then(() => { try { output.end(); } catch (e) { fail(e); } }, fail);
  });
  return zipPath;
}

function streamZipDirectory(dirPath, res) {
  const writer = new ZipStoreWriter(res, { maxTotal: ZIP_MAX_TOTAL });
  // Returned immediately (not a promise) so the caller can still abort it on
  // client disconnect; the walk itself is async and link-free.
  (async () => {
    try {
      const items = await collectZipEntries([{ fullPath: dirPath, nameInZip: path.basename(dirPath) }]);
      if (res.writableEnded || writer.aborted) return;
      await writeItemsToZip(writer, items);
      if (!res.writableEnded) { try { res.end(); } catch {} }
    } catch (e) {
      if (e && e.aborted) { try { res.end(); } catch {} return; }
      const r = safeErr(e);
      if (res.headersSent) { try { res.end(); } catch {} }
      else { try { res.status(r.status).json(r.body); } catch {} }
    }
  })();
  return writer;
}

function extractZip(zipPath, destDir) {
  return (async () => {
    // Validate zip magic (PK header) before extraction (F64)
    const fd = fs.openSync(zipPath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const bytes = fs.readSync(fd, buf, 0, 4, 0);
      if (bytes < 4 || !(buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) && (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08))) {
        throw Object.assign(new Error('Not a zip file (bad magic)'), { status: 400 });
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    const MAX_ENTRIES = 1000;
    const MAX_TOTAL = 1 * 1024 * 1024 * 1024;
    let reader;
    try {
      reader = await ZipArchiveReader.open(zipPath, { maxEntries: MAX_ENTRIES });
    } catch (e) {
      throw mapZipOpenError(e);
    }
    let totalUncompressed = 0; // from archive metadata (attacker-controlled hint)
    let liveTotal = 0;        // bytes actually decompressed — the authoritative cap
    for (const entry of reader.entries) {
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > MAX_TOTAL) {
        const e = new Error('Uncompressed size exceeds 1GB'); e.status = 413; throw e;
      }
      let entryPath;
      try {
        entryPath = safeZipEntryName(entry.fileName);
      } catch (e) {
        throw mapZipOpenError(e);
      }
      const target = path.join(destDir, entryPath);
      if (!pathContained(destDir, target)) {
        throw new Error('Zip entry escapes destination directory');
      }
      if (/\/$/.test(entryPath)) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let readStream;
      try {
        readStream = await reader.openEntryStream(entry);
      } catch (e) {
        throw mapZipOpenError(e);
      }
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(target);
        let aborted = false;
        readStream.on('data', chunk => {
          // Count REAL decompressed bytes: entry.uncompressedSize comes from
          // the archive header, so a lying header (the classic zip-bomb)
          // sailed past the cap above while the disk filled anyway.
          liveTotal += chunk.length;
          if (liveTotal > MAX_TOTAL) {
            aborted = true;
            try { readStream.destroy(); } catch {}
            try { writeStream.destroy(); } catch {}
            try { fs.unlinkSync(target); } catch {}
            const e = new Error('Uncompressed size exceeds 1GB'); e.status = 413;
            reject(e);
          }
        });
        readStream.on('error', (e) => { if (!aborted) reject(e); });
        writeStream.on('error', (e) => { if (!aborted) reject(e); });
        writeStream.on('close', () => { if (!aborted) resolve(); });
        readStream.pipe(writeStream);
      });
    }
  })();
}

// Reader errors carry short codes; map the user-facing ones to the same
// messages (and HTTP statuses) the yauzl path produced. Anything else keeps
// its message and surfaces as a 500 via safeErr, as before.
function mapZipOpenError(e) {
  if (e && e.code === 'ENTRY_LIMIT') return Object.assign(new Error('Too many entries in zip (max 1000)'), { status: 413 });
  if (e && e.code === 'ENCRYPTED') return Object.assign(new Error('Encrypted zips are not supported'), { status: 400 });
  if (e && e.code === 'BAD_METHOD') return Object.assign(new Error('Unsupported compression method in zip'), { status: 400 });
  if (e && e.code === 'UNSAFE_NAME') return Object.assign(new Error('Invalid zip entry name'), { status: 400 });
  return e;
}

const { findCloudflared, ensureCloudflared } = require('./lib/cloudflared');

// Kill a process we own. There is deliberately no `signal` parameter: it was
// accepted and then ignored on Windows (taskkill /F is unconditionally forceful),
// which made callers believe SIGKILL semantics were available everywhere.
// Escalating termination lives in POST /api/system/kill instead.
function killPid(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (os.platform() === 'win32') {
      // execFile with an argv array, never a shell string: this helper is also
      // called with PIDs read back from .tunnels.json, so interpolation here
      // would be a shell-injection sink.
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      // Fallback: also kill any remaining child processes. wmic is deprecated
      // and removed from current Windows 11 — use CIM instead (same argv-array
      // discipline as above: no shell interpolation of the PID).
      try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
        const childPids = out.split(/\r?\n/).map(l => parseInt(l.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
        for (const cp of childPids) { try { execFileSync('taskkill', ['/PID', String(cp), '/F'], { stdio: 'ignore' }); } catch {} }
      } catch {}
    } else {
      process.kill(pid, 'SIGTERM');
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

async function asyncSafeWalk(currentDir, depth, maxDepth, q, results, maxResults, _seen) {
  if (depth > maxDepth || results.length >= maxResults) return;
  const seen = _seen || new Set();
  // Never descend into kernel/virtual trees even when full-FS is on.
  try {
    const rp = await fsPromises.realpath(currentDir).catch(() => path.resolve(currentDir));
    if (seen.has(rp)) return;
    seen.add(rp);
    const low = String(rp).toLowerCase();
    if (low === '/proc' || low === '/sys' || low === '/dev' ||
        low.startsWith('/proc/') || low.startsWith('/sys/') || low.startsWith('/dev/')) return;
  } catch {}
  let entries;
  try { entries = await fsPromises.readdir(currentDir, { withFileTypes: true }); } catch { return; }

  const matching = entries.filter(e => e.name.toLowerCase().includes(q));

  // Bounded fan-out: sequential batches of 8 instead of unbounded Promise.all
  // over every match and subdir (single-char q over depth 4 fanned thousands
  // of concurrent stats).
  const BATCH = 8;
  for (let i = 0; i < matching.length && results.length < maxResults; i += BATCH) {
    const chunk = matching.slice(i, i + BATCH);
    await Promise.all(chunk.map(async e => {
      if (results.length >= maxResults) return;
      const full = path.join(currentDir, e.name);
      try {
        // lstat (no follow): a symlink pointing outside the root must not leak
        // outside metadata. Containment is enforced on the lexical path.
        const st = await fsPromises.lstat(full);
        if (st.isSymbolicLink()) {
          if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, full)) return;
        } else if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, full)) {
          return;
        }
        if (results.length < maxResults) results.push({ path: full, name: e.name, isDir: st.isDirectory(), dir: currentDir });
      } catch {}
    }));
  }

  const dirs = entries.filter(e => e.isDirectory());
  for (let i = 0; i < dirs.length && results.length < maxResults; i += BATCH) {
    const chunk = dirs.slice(i, i + BATCH);
    for (const e of chunk) {
      if (results.length >= maxResults) return;
      const full = path.join(currentDir, e.name);
      try {
        const st = await fsPromises.lstat(full);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, full)) continue;
      } catch { continue; }
      await asyncSafeWalk(full, depth + 1, maxDepth, q, results, maxResults, seen);
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
    sendErr(res, e);
  }
});

app.post('/api/files/rename', rateLimiter, checkPin, async (req, res) => {
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
    sendErr(res, e);
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
    // Bounded: an absurd number of existing copies must not spin forever. Past
    // 1000 collisions report conflict:true instead of silently overwriting —
    // the old fall-through destroyed the destination without feedback.
    let counter = 1;
    let placed = false;
    while (counter <= 1000) {
      const suffix = counter === 1 ? ' (copy)' : ` (copy ${counter})`;
      dst = path.join(dir, base + suffix + ext);
      try { await fsPromises.access(dst); counter++; } catch { placed = true; break; }
    }
    if (!placed) return { conflict: true, isDir: dstIsDir, name: path.basename(dst), error: 'too many copies (max 1000) — choose another name' };
  }

  const st = await fsPromises.stat(src);
  const isDir = st.isDirectory();

  if (dstExists && conflict === 'replace') {
    // Remove the DESTINATION by its own type: replacing an existing directory
    // with a file (or vice versa) must not unlink()/rm() the wrong kind.
    if (dstIsDir) await fsPromises.rm(dst, { recursive: true, force: true });
    else await fsPromises.unlink(dst);
  }

  if (isMove) {
    if (dstExists && conflict === 'merge' && isDir && dstIsDir) {
      await mergeDirs(src, dst);
      await fsPromises.rm(src, { recursive: true, force: true });
    } else {
      await renameWithFallback(src, dst);
    }
  } else {
    if (isDir) {
      if (dstExists && conflict === 'merge' && dstIsDir) {
        await mergeDirs(src, dst);
      } else {
        await fsPromises.cp(src, dst, { recursive: true, force: true });
      }
    } else {
      await fsPromises.copyFile(src, dst);
    }
  }
  return { success: true };
}

// Merge src/ into dst/ with full rollback: entries this merge created are
// removed if a later entry fails, and pre-existing entries overwritten in
// place are restored from a temp backup, so a failed merge leaves dst
// exactly as it was. Backup itself is best-effort: if a pre-existing entry
// can't be backed up, the merge still proceeds (old behavior for that entry).
async function mergeDirs(src, dst) {
  let before = new Set();
  try { before = new Set(await fsPromises.readdir(dst)); } catch {}
  const created = [];
  const backedUp = new Map(); // entry name -> backup path
  let backupDir = null;
  const makeBackupDir = async () => {
    if (!backupDir) {
      backupDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'webtun-merge-'));
    }
    return backupDir;
  };
  try {
    const entries = await fsPromises.readdir(src);
    for (const entry of entries) {
      if (!before.has(entry)) {
        created.push(entry);
      } else {
        try {
          const dir = await makeBackupDir();
          const bak = path.join(dir, entry);
          await fsPromises.cp(path.join(dst, entry), bak, { recursive: true, force: true });
          backedUp.set(entry, bak);
        } catch {}
      }
      await fsPromises.cp(path.join(src, entry), path.join(dst, entry), { recursive: true, force: true });
    }
  } catch (e) {
    for (const entry of created) {
      try { await fsPromises.rm(path.join(dst, entry), { recursive: true, force: true }); } catch {}
    }
    for (const [entry, bak] of backedUp) {
      try { await fsPromises.cp(bak, path.join(dst, entry), { recursive: true, force: true }); } catch {}
    }
    throw e;
  } finally {
    if (backupDir) {
      try { await fsPromises.rm(backupDir, { recursive: true, force: true }); } catch {}
    }
  }
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
    sendErr(res, e);
  }
}

app.post('/api/files/copy', checkPin, rateLimiter, (req, res) => handleCopyMove(req, res, false));
app.post('/api/files/move', checkPin, rateLimiter, (req, res) => handleCopyMove(req, res, true));

// Never delete filesystem roots or the workspace root itself (one bad call
// must not wipe the host). Shared by single + batch delete.
function isDeletablePath(p) {
  try {
    const abs = path.resolve(p);
    if (path.parse(abs).root === abs) return false;
    if (abs === path.resolve(WORKSPACE_ROOT)) return false;
    return true;
  } catch { return false; }
}

// Delete without following the final path component: lstat (never stat, never
// realpath) so a symlink is unlinked itself. The old code ran realPath() first,
// which resolved a symlink-to-directory into its target and rm -rf'd the
// DESTINATION instead of the link. resolvePath() (no symlink following) +
// lstat is the safe pair; the kernel still resolves parent components.
async function removePathSafe(p) {
  const lst = await fsPromises.lstat(p);
  if (lst.isSymbolicLink() || !lst.isDirectory()) await fsPromises.unlink(p);
  else await fsPromises.rm(p, { recursive: true, force: true });
}
app.delete('/api/files', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      console.warn('DELETE /api/files 400 — query param ?path= is required. Example: DELETE /api/files?path=/home/user/file.txt');
      return res.status(400).json({ error: 'path is required', usage: 'DELETE /api/files?path=<path>' });
    }
    const p = resolvePath(req.query.path);
    if (!isDeletablePath(p)) {
      return res.status(400).json({ error: 'Refusing to delete this path' });
    }
    await removePathSafe(p);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/files/mkdir', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/mkdir 400 — body requires { path }. Example: { "path": "/home/user/newfolder" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<dir>" }' });
    }
    const p = realPath(req.body.path);
    await fsPromises.mkdir(p, { recursive: true });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/files/touch', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!req.body.path) {
      console.warn('POST /api/files/touch 400 — body requires { path }. Example: { "path": "/home/user/newfile.txt" }');
      return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file>" }' });
    }
    const p = realPath(req.body.path);
    await fsPromises.writeFile(p, '', { flag: 'a' });
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/files/zip', rateLimiter, checkPin, async (req, res) => {
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
    sendErr(res, e);
  }
});

app.post('/api/files/unzip', rateLimiter, checkPin, async (req, res) => {
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
    let destDir = path.join(path.dirname(p), path.basename(p, '.zip'));
    // Optional single-segment override so the client can retry a 409 into a
    // numbered folder (archive (1)/) instead of just showing an error toast.
    if (req.body.destName != null && String(req.body.destName) !== '') {
      const segs = String(req.body.destName).split(/[\\/]+/).filter(Boolean);
      if (segs.length !== 1) return res.status(400).json({ error: 'destName must be a single folder name' });
      destDir = path.join(path.dirname(p), sanitizeUploadSegment(segs[0]));
    }
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, destDir)) return res.status(403).json({ error: 'Access denied: destination outside workspace' });
    // Refuse to merge into a non-empty directory; extract to a temp dir and
    // rename into place so a failed extraction can't wipe pre-existing data.
    try {
      const st = await fsPromises.stat(destDir);
      if (!st.isDirectory()) return res.status(400).json({ error: 'Destination exists and is not a directory' });
      const entries = await fsPromises.readdir(destDir);
      if (entries.length > 0) return res.status(409).json({ error: 'Destination already exists', dir: destDir });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const tmpDir = destDir + '.unzip-' + crypto.randomBytes(6).toString('hex');
    await fsPromises.mkdir(tmpDir, { recursive: true });
    try {
      await extractZip(p, tmpDir);
    } catch (e) {
      // Rollback partial on failure (F64) — only the temp dir, never user data
      try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch {}
      return sendErr(res, e);
    }
    try {
      try { await fsPromises.rmdir(destDir); } catch {}
      await fsPromises.rename(tmpDir, destDir);
    } catch (e) {
      try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch {}
      return sendErr(res, e && e.message ? e : new Error('Failed to move extracted files into place'), 500);
    }
    res.json({ success: true, dir: destDir });
  } catch (e) {
    sendErr(res, e);
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
    res.json({ content, length: st.size, mtime: st.mtime });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/files/write', rateLimiter, checkPin, async (req, res) => {
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
    sendErr(res, e);
  }
});

// Mint a dir-scoped preview token for the file-preview frame's subresources.
// The client resolves the previewed file, takes its directory, and embeds
// `ptoken` (never the session) in <base href> and rewritten asset URLs.
app.post('/api/files/preview-token', rateLimiter, checkPin, async (req, res) => {
  try {
    const p = realPath(req.body && req.body.path);
    const lst = await fsPromises.lstat(p).catch(() => null);
    if (!lst) return res.status(404).json({ error: 'Not found' });
    const st = await fsPromises.stat(p).catch(() => null);
    if (!st || !st.isFile()) return res.status(400).json({ error: 'Not a file' });
    res.json({ token: mintPreviewFileToken(path.dirname(p)) });
  } catch (e) {
    sendErr(res, e);
  }
});
// Accept a valid preview-file token on the image route only. The requested
// path must resolve inside the token's directory; anything else falls through
// to checkPin unchanged (so a token can never launder wider access).
function checkPreviewFileToken(req, res, next) {
  try {
    const t = req.query && req.query.ptoken;
    if (typeof t !== 'string' || !t) return next();
    const rec = previewFileTokens.get(t);
    if (!rec) return next();
    if (!rec.dir || rec.exp <= Date.now()) { try { previewFileTokens.delete(t); } catch {} return next(); }
    let p;
    try { p = realPath(req.query.path); } catch { return next(); }
    if (!pathContained(rec.dir, p)) return next();
    req.previewFileToken = true;
  } catch {}
  next();
}

// Serve image files for inline viewing (not as download)
app.get('/api/files/image', checkPreviewFileToken, checkPin, async (req, res) => {
  try {
    const p = resolvePath(req.query.path);
    // Stat before streaming: refuse directories, cap at 100MB
    const lst = await fsPromises.lstat(p).catch(() => null);
    if (!lst) return res.status(404).json({ error: 'Not found' });
    if (!lst.isFile() && !lst.isSymbolicLink()) return res.status(400).json({ error: 'Not a file' });
    const st = await fsPromises.stat(p).catch(() => null);
    if (!st || !st.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (st.size > 100 * 1024 * 1024) return res.status(413).json({ error: 'File too large to preview inline' });
    const mimeType = mimeLookup(p);
    res.setHeader('Content-Type', mimeType);
    // Avoid caching secrets served as octet-stream (F57). Preview-token
    // responses are never cached either: the token is short-lived and the
    // URL must not outlive it in any cache.
    if (mimeType === 'application/octet-stream' || req.previewFileToken) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'private, max-age=3600');
    }
    const stream = fs.createReadStream(p);
    // Ensure stream destroyed when client aborts to avoid FD leak (F57)
    req.on('close', () => { try { stream.destroy(); } catch {} });
    stream.on('error', err => {
      if (!res.headersSent) sendErr(res, err);
      else res.end();
    });
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) sendErr(res, e);
  }
});

app.get('/api/files/download', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!req.query.path) {
      console.warn('GET /api/files/download 400 — query param ?path= is required. Example: GET /api/files/download?path=/home/user/file.txt');
      return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/download?path=<path>' });
    }
    const p = realPath(req.query.path);
    const st = await fsPromises.stat(p);
    if (st.isDirectory()) {
      // Same 1GB guard as /api/files/zip — no unbounded archive streams
      try {
        const size = await dirSize(p);
        if (size > 1024 * 1024 * 1024) return res.status(413).json({ error: 'Directory too large to download as zip (1GB limit)' });
      } catch {}
      const safeName = path.basename(p).replace(/["\r\n;]/g, '_') + '.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      const arch = streamZipDirectory(p, res);
      // Stop the zip writer when the client goes away (F58)
      res.on('close', () => { try { if (arch) arch.abort(); } catch {} });
      return;
    } else {
      const mimeType = mimeLookup(p);
      const safeName = path.basename(p).replace(/["\r\n;]/g, '_');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      // Transfer Center needs a known total for % / ETA: single files report
      // their size up front (directory zips stay length-less → indeterminate).
      try { if (Number.isFinite(st.size)) res.setHeader('Content-Length', String(st.size)); } catch {}
      res.setHeader('Accept-Ranges', 'bytes');
      const stream = fs.createReadStream(p);
      req.on('close', () => { try { stream.destroy(); } catch {} });
      stream.on('error', err => {
        if (!res.headersSent) sendErr(res, err);
        else res.end();
      });
      stream.pipe(res);
    }
  } catch (e) {
    if (!res.headersSent) sendErr(res, e);
  }
});

// Upload filename hygiene: split the client-sent relative path into segments
// and sanitize each one. Unicode letters, digits, spaces and dots are kept;
// control chars, Windows-reserved <>:"|?* and traversal segments are removed.
function sanitizeUploadSegment(seg) {
  let s = String(seg || '').replace(/[\x00-\x1f<>:"|?*]/g, '');
  s = s.replace(/^\s+/, '').replace(/[\s.]+$/, '');
  if (!s || s === '.' || s === '..') return '_';
  return s.slice(0, 255);
}
// Upload path depth cap: the multipart filename carries a drag-and-drop
// relative path — bound its nesting so one request can't fan out thousands of
// directories. Multer's `files: 100` caps the file count.
const UPLOAD_MAX_DEPTH = 10;
function uploadRelPath(originalname) {
  const segs = String(originalname || '').split(/[\\/]+/).filter(Boolean).map(sanitizeUploadSegment);
  const out = segs.length ? segs : ['_'];
  if (out.length > UPLOAD_MAX_DEPTH + 1) {
    const e = new Error('upload path too deep (max ' + UPLOAD_MAX_DEPTH + ' levels)');
    e.status = 400;
    throw e;
  }
  return out;
}
// Same-name uploads used to silently overwrite; uniquify instead.
function uniqueUploadPath(dir, name) {
  let candidate = path.join(dir, name);
  try { fs.accessSync(candidate); } catch { return candidate; }
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 1; i <= 1000; i++) {
    candidate = path.join(dir, base + (i === 1 ? ' (copy)' : ` (copy ${i})`) + ext);
    try { fs.accessSync(candidate); } catch { return candidate; }
  }
  return candidate;
}

// Upload with multer disk storage – destination resolved per-request
app.post('/api/files/upload', rateLimiter, checkPin, (req, res) => {
  let destDir;
  try {
    destDir = realPath(req.query.path || WORKSPACE_ROOT);
  } catch (e) {
    return sendErr(res, e, 403);
  }
  // Segment sanitizer: Unicode + spaces survive; only control characters,
  // Windows-reserved symbols and traversal segments are stripped. The old
  // /[^a-zA-Z0-9_.\-]/g turned every non-ASCII name (документ.pdf, 报告.txt)
  // into underscores that then overwrote each other.
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        // The client sends the drag-and-drop relative path as the multipart
        // filename (folder/sub/file.txt) — preserve the hierarchy instead of
        // flattening everything into the destination root with basename().
        const segs = uploadRelPath(file.originalname);
        const subPath = segs.length > 1 ? path.join(destDir, ...segs.slice(0, -1)) : destDir;
        fs.mkdirSync(subPath, { recursive: true });
        // Real containment (not the old lexical pathContained on sanitized
        // segments, which could never fail): a parent-dir symlink of destDir
        // would redirect the mkdir through the link — verify via realpath.
        let realDest = destDir, realSub = subPath;
        try { realDest = fs.realpathSync(destDir); } catch {}
        try { realSub = fs.realpathSync(subPath); } catch {}
        if (!pathContained(realDest, realSub)) {
          return cb(new Error('Invalid upload destination'));
        }
        cb(null, subPath);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      try {
        const segs = uploadRelPath(file.originalname);
        const subPath = segs.length > 1 ? path.join(destDir, ...segs.slice(0, -1)) : destDir;
        cb(null, path.basename(uniqueUploadPath(subPath, segs.slice(-1)[0])));
      } catch (err) {
        cb(err);
      }
    }
  });
  const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024, files: 100 } }).array('files');
  // Pre-flight the declared size BEFORE multer streams to disk: the old code
  // checked the 2GB batch total only after the write, so chunked (no
  // Content-Length) uploads filled the disk first and were deleted after.
  // Multer's fileSize/files limits abort mid-stream; the post-write total
  // check below is the backstop for chunked batches (cleaned up on exceed).
  // (Content-Length is a client hint; the multer limits stay the hard cap.)
  const MAX_BATCH = 2 * 1024 * 1024 * 1024;
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > MAX_BATCH + (8 * 1024 * 1024)) {
    return res.status(413).json({ error: 'Total upload size exceeds 2GB' });
  }
  upload(req, res, err => {
    if (err) {
      // Don't leave already-written temp files behind on an aborted batch.
      try { (Array.isArray(req.files) ? req.files : []).forEach(f => { try { fs.unlinkSync(f.path); } catch {} }); } catch {}
      // Multer limit errors are 413, not 500 (e.g. LIMIT_FILE_SIZE)
      const status = (err.code && err.code.startsWith('LIMIT_')) ? 413 : 500;
      return sendErr(res, err, status);
    }
    // Total batch cap (2GB) against disk-fill; clean up the batch on exceed
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      const total = files.reduce((n, f) => n + (f.size || 0), 0);
      if (total > 2 * 1024 * 1024 * 1024) {
        for (const f of files) { try { fs.unlinkSync(f.path); } catch {} }
        return res.status(413).json({ error: 'Total upload size exceeds 2GB' });
      }
    } catch {}
    res.json({ success: true, count: Array.isArray(req.files) ? req.files.length : 0 });
  });
});

// Cache for owner/group to avoid re-spawning on every request (F60 trail)
const _ownerCache = new Map();
const _groupCache = new Map();

// Async variant: execFileSync on this hot metadata path blocked the event loop
// for every cache miss (and the cache is per-uid/gid, so cold starts hit it).
function execFileText(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout || '').trim());
    });
  });
}

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
    // Use cache for owner (F60 trail)
    try {
      if (os.platform() === 'win32') {
        stat.owner = String(st.uid);
      } else if (_ownerCache.has(st.uid)) {
        stat.owner = _ownerCache.get(st.uid);
      } else {
        const owner = await execFileText('id', ['-nu', String(st.uid)]);
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
        const dscl = await execFileText('dscl', ['.', '-read', `/Groups/${st.gid}`, 'RecordName']);
        const m = dscl.match(/RecordName:\s*(.+)/);
        const g = m ? m[1].trim() : String(st.gid);
        _groupCache.set(st.gid, g);
        if (_groupCache.size > 500) { const k=_groupCache.keys().next().value; _groupCache.delete(k); }
        stat.group = g;
      } else {
        const g = (await execFileText('getent', ['group', String(st.gid)])).split(':')[0];
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
    sendErr(res, e);
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
    sendErr(res, e);
  }
});

// ── Batch delete ──────────────────────────────────────────────────────
app.post('/api/files/batch-delete', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.paths) || req.body.paths.length === 0) {
      console.warn('POST /api/files/batch-delete 400 — body requires { paths: [...] }');
      return res.status(400).json({ error: 'paths array is required', usage: 'POST JSON { "paths": ["<path1>", "<path2>", ...] }' });
    }
    if (req.body.paths.length > 100) return res.status(400).json({ error: 'too many paths max 100' });
    const results = [];
    for (const raw of req.body.paths) {
      let p;
      try { p = resolvePath(raw); } catch (e) { results.push({ path: raw, success: false, error: errText(e) }); continue; }
      if (!isDeletablePath(p)) { results.push({ path: raw, success: false, error: 'Refusing to delete this path' }); continue; }
      try {
        await removePathSafe(p);
        results.push({ path: raw, success: true });
      } catch (e) {
        results.push({ path: raw, success: false, error: errText(e) });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    sendErr(res, e);
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
      try { src = realPath(raw); } catch (e) { results.push({ path: raw, success: false, error: errText(e) }); continue; }
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
        results.push({ path: raw, success: false, error: errText(e) });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
  } catch (e) {
    sendErr(res, e);
  }
}

app.post('/api/files/batch-copy', rateLimiter, checkPin, (req, res) => handleBatchCopyMove(req, res, false));
app.post('/api/files/batch-move', rateLimiter, checkPin, (req, res) => handleBatchCopyMove(req, res, true));

// ── Change permissions (chmod) ─────────────────────────────────────────
app.post('/api/files/chmod', rateLimiter, checkPin, async (req, res) => {
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
    sendErr(res, e);
  }
});

// ── Create symlink ────────────────────────────────────────────────────
app.post('/api/files/symlink', rateLimiter, checkPin, async (req, res) => {
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
    sendErr(res, e);
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
      // ReDoS guard, enforced (the previous check detected this shape and then
      // did nothing): a quantifier applied to a group that already contains one
      // — (a+)+, (a*)*, (ab+){2,} — backtracks catastrophically and would block
      // the event loop for the entire server. Common safe forms like (foo|bar)+
      // have no inner quantifier and still pass.
      if (/\([^)]*[+*][^)]*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(query)) {
        return res.status(400).json({ error: 'regex rejected: nested quantifiers can hang the server — use a literal search' });
      }
    }
    // Hard deadline: a pathological-but-accepted pattern must not pin the
    // event loop indefinitely across a large tree.
    const SCAN_DEADLINE = Date.now() + 15000;
    const SCAN_CAP = 2 * 1024 * 1024; // bytes scanned per file (was: whole file in RAM)

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
            const lowerQuery = query.toLowerCase();
            const checkLine = (line, lineNo) => {
              let match;
              if (regex) {
                regex.lastIndex = 0;
                match = regex.exec(line);
              } else {
                const idx = line.toLowerCase().indexOf(lowerQuery);
                match = idx !== -1 ? { index: idx } : null;
              }
              if (match) {
                results.push({ path: full, line: lineNo, column: match.index, content: line.substring(0, 500) });
              }
            };
            // Stream the file instead of readFile-ing it whole: the old version
            // held up to 10MB per candidate file in memory and split the entire
            // buffer into lines before looking at any of them.
            const stream = fs.createReadStream(full, { encoding: 'utf8', highWaterMark: 64 * 1024 });
            let carry = '';
            let lineNo = 0;
            let scanned = 0;
            let stopped = false;
            try {
              for await (const chunk of stream) {
                if (results.length >= maxResults || Date.now() > SCAN_DEADLINE) { stopped = true; break; }
                scanned += Buffer.byteLength(chunk);
                if (scanned > SCAN_CAP) { stopped = true; break; }
                carry += chunk;
                let nl;
                while ((nl = carry.indexOf('\n')) !== -1) {
                  const line = carry.slice(0, nl);
                  carry = carry.slice(nl + 1);
                  lineNo++;
                  checkLine(line, lineNo);
                  if (results.length >= maxResults) break;
                }
                // A single pathological line must not grow the buffer forever.
                if (carry.length > 1024 * 1024) { carry = carry.slice(-500); lineNo++; }
              }
              if (!stopped && carry && results.length < maxResults) checkLine(carry, lineNo + 1);
            } catch {}
            finally { try { stream.destroy(); } catch {} }
            if (Date.now() > SCAN_DEADLINE || results.length >= maxResults) break;
          }
        } catch {}
      }
      // Sequential descent: Promise.all over every subdirectory fanned out
      // without any limit (fd/memory exhaustion on wide trees) and ignored the
      // result caps until the recursion unwound.
      for (const d of dirs) {
        if (results.length >= maxResults || Date.now() > SCAN_DEADLINE) break;
        await walkContentSearch(path.join(currentDir, d.name), depth + 1);
      }
    }

    await walkContentSearch(searchDir, 0);
    res.json({ results, count: results.length, query, path: searchDir });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Batch zip (multiple sources) ──────────────────────────────────────
app.post('/api/files/batch-zip', rateLimiter, checkPin, async (req, res) => {
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
    sendErr(res, e);
  }
});







// ── Log tail (SSE) ────────────────────────────────────────────────────
app.get('/api/files/tail', rateLimiter, checkPin, async (req, res) => {
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

    // Read only a bounded tail window. This used to readFile() the ENTIRE file
    // (up to 100MB) for the initial payload, and compared `content.length`
    // (characters) against stat.size (bytes), so multibyte logs resynced at the
    // wrong offset. Everything below is byte-offset based.
    const MAX_TAIL_BYTES = 64 * 1024;
    const readRange = async (start, len) => {
      if (len <= 0) return Buffer.alloc(0);
      const fd = await fsPromises.open(p, 'r');
      try {
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, start);
        return buf;
      } finally { await fd.close(); }
    };

    const initStart = Math.max(0, st.size - MAX_TAIL_BYTES);
    const initBuf = await readRange(initStart, st.size - initStart);
    const tailLines = initBuf.toString('utf8').split('\n').slice(-lines);
    res.write(`data: ${JSON.stringify({ type: 'init', lines: tailLines, total: tailLines.length })}\n\n`);

    // Poll for changes
    let lastSize = st.size;
    const timer = setInterval(async () => {
      if (res.writableEnded) { clearInterval(timer); return; }
      try {
        const newSt = await fsPromises.stat(p);
        if (newSt.size > lastSize) {
          // Cap each poll at MAX_TAIL_BYTES so a burst of writes can't allocate
          // an unbounded buffer; anything older than the window is skipped.
          const start = Math.max(lastSize, newSt.size - MAX_TAIL_BYTES);
          const buf = await readRange(start, newSt.size - start);
          lastSize = newSt.size;
          res.write(`data: ${JSON.stringify({ type: 'data', lines: buf.toString('utf8') })}\n\n`);
        } else if (newSt.size < lastSize) {
          // File was truncated — resync from the new end
          lastSize = newSt.size;
        }
      } catch {}
    }, pollInterval);

    req.on('close', () => { clearInterval(timer); });
  } catch (e) {
    if (!res.headersSent) sendErr(res, e);
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
    sendErr(res, e);
  }
});



// ── Clipboard (server-side staging) ───────────────────────────────────
// Per-IP clipboard to prevent cross-user leak (F17, F69)
// Keyed by the authenticated session, not the socket address: behind a tunnel
// every client's req.ip is 127.0.0.1, so an IP key handed one user's cut/copy
// set to another. Entries also expire — they used to live until a restart.
const clipboards = new Map(); // key -> { sources, action, createdAt, expiresAt }
const CLIPBOARD_TTL_MS = 15 * 60 * 1000;
const CLIPBOARD_MAX = 200;
function clipboardKey(req) {
  const t = (req && req.authToken) || '';
  if (t) return 't:' + crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);
  return 'ip:' + ((req && req.ip) || 'default');
}
function getClipboard(key) {
  const now = Date.now();
  // Expire unconditionally: entries without sources used to linger forever
  // (skipped by the old `!v.sources` guard) and the map had no size cap.
  for (const [k, v] of clipboards) {
    if (!v) { clipboards.delete(k); continue; }
    if (v.expiresAt && now > v.expiresAt) { clipboards.delete(k); continue; }
    if ((!v.sources || !v.sources.length) && k !== key) clipboards.delete(k);
  }
  while (clipboards.size > CLIPBOARD_MAX) {
    const first = clipboards.keys().next().value;
    if (first === undefined) break;
    if (first === key) break;
    clipboards.delete(first);
  }
  if (!clipboards.has(key)) clipboards.set(key, { sources: [], action: null, createdAt: null, expiresAt: 0 });
  return clipboards.get(key);
}

app.get('/api/clipboard', checkPin, (req, res) => {
  const cb = getClipboard(clipboardKey(req));
  res.json({ clipboard: cb });
});

app.post('/api/clipboard', checkPin, async (req, res) => {
  try {
    if (!Array.isArray(req.body.sources) || req.body.sources.length === 0) {
      return res.status(400).json({ error: 'sources array is required' });
    }
    if (req.body.sources.length > 100) return res.status(400).json({ error: 'too many sources max 100' });
    const action = req.body.action === 'cut' ? 'cut' : 'copy';
    const key = clipboardKey(req);
    const clipboard = {
      sources: req.body.sources.map(s => realPath(s)),
      action,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + CLIPBOARD_TTL_MS
    };
    clipboards.set(key, clipboard);
    while (clipboards.size > CLIPBOARD_MAX) {
      const first = clipboards.keys().next().value;
      if (first === undefined || first === key) break;
      clipboards.delete(first);
    }
    res.json({ clipboard, count: clipboard.sources.length });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/clipboard/paste', checkPin, async (req, res) => {
  try {
    if (!req.body.destination) return res.status(400).json({ error: 'destination is required' });
    const key = clipboardKey(req);
    const clipboard = getClipboard(key);
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
        results.push({ path: src, success: false, error: errText(e) });
      }
    }
    const pasteAction = clipboard.action;
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    if (clipboard.action === 'cut' && failed === 0) {
      clipboards.set(key, { sources: [], action: null, createdAt: null, expiresAt: 0 });
    } else if (clipboard.action === 'cut' && failed > 0) {
      // Keep clipboard for retry on partial failure (F69)
    }
    res.json({ results, succeeded, failed, pasteAction });
  } catch (e) {
    sendErr(res, e);
  }
});

app.delete('/api/clipboard', checkPin, (req, res) => {
  clipboards.set(clipboardKey(req), { sources: [], action: null, createdAt: null, expiresAt: 0 });
  res.json({ success: true });
});

// ── Command history (server-side, persists across sessions) ────────────
const HISTORY_FILE = path.join(DATA_DIR, '.cmdhist.json');
let cmdHistory = [];
let cmdHistMax = 50;

// Stored as { max, items }. The max used to live only in memory, so a changed
// cap silently reverted to 50 on the next restart. A bare array (the old
// shape) is still readable.
function loadCmdHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
    cmdHistory = items.filter(it => it && typeof it.cmd === 'string').slice(0, 500);
    if (parsed && !Array.isArray(parsed) && Number.isInteger(parsed.max) && parsed.max >= 10 && parsed.max <= 500) {
      cmdHistMax = parsed.max;
    }
    if (cmdHistory.length > cmdHistMax) cmdHistory.length = cmdHistMax;
  } catch { cmdHistory = []; }
}
function saveCmdHistory() {
  try {
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ max: cmdHistMax, items: cmdHistory }), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, HISTORY_FILE);
  } catch {}
}
// NOTE: loaded in startServer() AFTER migrateLegacyState(), not at import —
// the first boot after upgrade used to read the empty new-location file, then
// migrate the legacy file without reloading, so the next save overwrote the
// migrated history. require('./server.js') must stay side-effect free here.
let _historyLoaded = false;

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
    sendErr(res, e);
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

function parseGitNumstat(raw) {
  // `git diff --numstat` lines: "<added>\t<deleted>\t<path>"
  // Binary files show "-\t-\t<path>". Renames show "old => new".
  const map = new Map();
  for (const line of (raw || '').split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const aRaw = parts[0].trim(), dRaw = parts[1].trim();
    let p = gitUnquote(parts.slice(2).join('\t'));
    // Rename format: "old => new" or "{a/b => c/d}/file" — take new side.
    // Brace form splits as "{a => b}/tail": new part is between ' => ' and '}'.
    const arrow = p.indexOf(' => ');
    if (arrow !== -1) {
      const after = p.slice(arrow + 4);
      if (p[0] === '{') {
        const close = after.indexOf('}');
        p = close !== -1 ? after.slice(0, close) + after.slice(close + 1) : after;
      } else {
        p = after;
      }
    }
    if (!p) continue;
    if (aRaw === '-' || dRaw === '-') { map.set(p, { binary: true }); continue; }
    const added = parseInt(aRaw, 10), deleted = parseInt(dRaw, 10);
    if (isNaN(added) || isNaN(deleted)) continue;
    const prev = map.get(p);
    if (prev && !prev.binary) map.set(p, { added: prev.added + added, deleted: prev.deleted + deleted });
    else map.set(p, { added, deleted });
  }
  return map;
}

// Line-count untracked files so new files show as "+N" like GitHub.
// Capped: max 100 files, skip dirs / files >1MB / unreadable / likely binary.
async function countUntrackedLines(root, files) {
  const out = new Map();
  const capped = (files || []).slice(0, 100);
  await Promise.all(capped.map(async (f) => {
    try {
      if (!f || /[/\\]$/.test(f)) return;
      const abs = path.resolve(root, f);
      if (!pathContained(root, abs)) return;
      const st = await fsPromises.stat(abs);
      if (!st.isFile() || st.size > 1024 * 1024) return;
      const buf = await fsPromises.readFile(abs);
      if (buf.includes(0)) return; // binary
      const text = buf.toString('utf8');
      const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
      out.set(f, lines);
    } catch {}
  }));
  return out;
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
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    let root;
    try { root = await gitRootFor(req.query.path); }
    catch (e) {
      if (e.status === 404) return res.json({ git: true, isRepo: false });
      throw e;
    }
    const raw = await spawnRead('git', ['-C', root, 'status', '--porcelain=v1', '-b'], { timeout: 20000 });
    const st = parseGitStatus(raw);
    // Per-file line stats (GitHub-style +added/-removed) via numstat.
    // Best-effort: never fail the whole status when numstat fails.
    try {
      const [unstagedRaw, stagedRaw] = await Promise.all([
        spawnRead('git', ['-C', root, 'diff', '--numstat'], { timeout: 20000 }).catch(() => ''),
        spawnRead('git', ['-C', root, 'diff', '--cached', '--numstat'], { timeout: 20000 }).catch(() => ''),
      ]);
      const unstagedMap = parseGitNumstat(unstagedRaw);
      const stagedMap = parseGitNumstat(stagedRaw);
      for (const e of st.unstaged) {
        const s = unstagedMap.get(e.path);
        if (s && s.binary) e.binary = true;
        else if (s) { e.added = s.added; e.deleted = s.deleted; }
      }
      for (const e of st.staged) {
        const s = stagedMap.get(e.path);
        if (s && s.binary) e.binary = true;
        else if (s) { e.added = s.added; e.deleted = s.deleted; }
      }
    } catch {}
    try {
      const lineCounts = await countUntrackedLines(root, st.untracked.map(e => e.path));
      for (const e of st.untracked) {
        if (lineCounts.has(e.path)) { e.added = lineCounts.get(e.path); e.deleted = 0; }
      }
    } catch {}
    // Totals across staged + unstaged + untracked (unmerged excluded)
    let totalAdded = 0, totalDeleted = 0;
    for (const e of [...st.staged, ...st.unstaged, ...st.untracked]) {
      if (typeof e.added === 'number') totalAdded += e.added;
      if (typeof e.deleted === 'number') totalDeleted += e.deleted;
    }
    st.totalAdded = totalAdded; st.totalDeleted = totalDeleted;
    if (st.detached) {
      try { st.branch = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim() + ' (detached)'; } catch {}
    }
    try {
      const sl = await spawnRead('git', ['-C', root, 'stash', 'list', '--format=%gd']);
      st.stashCount = sl.split('\n').filter(Boolean).length;
    } catch { st.stashCount = 0; }
    try { st.upstream = (await spawnRead('git', ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim(); }
    catch { st.upstream = ''; }
    res.json({ git: true, isRepo: true, root, ...st });
  } catch (e) {
    sendErr(res, e);
  }
});

app.get('/api/git/diff', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    const file = req.query.file;
    if (!file || typeof file !== 'string' || Array.isArray(file)) return res.status(400).json({ error: 'file is required' });
    const abs = path.resolve(root, file);
    if (!pathContained(root, abs)) return res.status(400).json({ error: 'file outside repo' });
    const rel = path.relative(root, abs) || '.';
    if (rel === '.' || rel === '..' || rel.startsWith('..' + path.sep)) return res.status(400).json({ error: 'invalid file path' });
    const args = ['-C', root, 'diff', '--no-color'];
    if (req.query.cached === '1') args.push('--cached');
    // head=1 diffs against HEAD — the only view that shows unmerged/conflicted files
    if (req.query.head === '1') args.push('HEAD');
    args.push('--', rel);
    // Explicit timeout (not the 5s spawnRead default): large-repo diffs
    // spuriously 500'd before they could finish draining.
    let diff = await spawnRead('git', args, { timeout: 15000, maxBytes: 400000 });
    const binary = diff.includes('Binary files');
    const truncated = diff.length > 200000;
    if (truncated) diff = diff.slice(0, 200000);
    res.json({ success: true, diff, binary, truncated });
  } catch (e) {
    sendErr(res, e);
  }
});

app.get('/api/git/log', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
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
    sendErr(res, e);
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
    const rel = path.relative(root, abs) || '.';
    // Never allow the repo root itself ('sub/..' tricks) — that would stage/discard everything
    if (rel === '.' || rel === '..' || rel.startsWith('..' + path.sep)) { const e = new Error('invalid file path: ' + f); e.status = 400; throw e; }
    return rel;
  });
}

app.post('/api/git/stage', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const rels = gitFileArgs(root, req.body && req.body.files);
    await spawnRead('git', ['-C', root, 'add', '--', ...rels]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/unstage', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const rels = gitFileArgs(root, req.body && req.body.files);
    await spawnRead('git', ['-C', root, 'restore', '--staged', '--', ...rels]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/commit', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    let message = req.body && req.body.message;
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'commit message is required' });
    message = message.trim().slice(0, 1000);
    if (req.body && req.body.all) await spawnRead('git', ['-C', root, 'add', '-A']);
    try {
      await spawnRead('git', ['-C', root, 'commit', '-m', message]);
    } catch (e) {
      return res.status(400).json({ error: gitErrText(e, 'commit failed') });
    }
    let hash = '';
    try { hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim(); } catch {}
    res.json({ success: true, hash });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/pull', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const mode = req.body && req.body.mode;
    const flag = mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--no-rebase';
    let out = '';
    // 60s server timeout vs the 30s api() cap is intentional: a client abort
    // does not kill the child, and pull/push/fetch are safe to finish
    // server-side (the client re-reads state on retry). Timeouts now surface
    // as 504 via gitErrStatus instead of a flat 400.
    try { out = await spawnRead('git', ['-C', root, 'pull', flag], { timeout: 60000 }); }
    catch (e) { return res.status(gitErrStatus(e)).json({ error: gitErrText(e, 'pull failed', 1000) }); }
    res.json({ success: true, output: out.slice(-5000) });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/push', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    // upstream:true runs `git push -u origin HEAD` (explicit user consent —
    // offered by the client when push fails with "no upstream branch").
    const args = ['-C', root, 'push'];
    if (req.body && req.body.upstream) args.push('-u', 'origin', 'HEAD');
    let out = '';
    try { out = await spawnRead('git', args, { timeout: 60000 }); }
    catch (e) { return res.status(gitErrStatus(e)).json({ error: gitErrText(e, 'push failed', 1000) }); }
    res.json({ success: true, output: out.slice(-5000) });
  } catch (e) {
    sendErr(res, e);
  }
});

// Validate a branch name with git itself (rejects `-x`, `..`, spaces, `~^:?*[`).
// Leading-dash names are rejected up front so the name can never be parsed as
// a flag even if validation were bypassed; every switch/branch/tag invocation
// below also passes `--` before the ref.
async function assertSafeBranch(root, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    const e = new Error('invalid branch name'); e.status = 400; throw e;
  }
  if (name.trim().startsWith('-')) {
    const e = new Error('invalid branch name'); e.status = 400; throw e;
  }
  try {
    await spawnRead('git', ['-C', root, 'check-ref-format', '--branch', name.trim()]);
  } catch {
    const e = new Error('invalid branch name'); e.status = 400; throw e;
  }
  return name.trim();
}

app.get('/api/git/branches', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    const raw = await spawnRead('git', ['-C', root, 'branch', '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)']);
    const branches = raw.split('\n').filter(Boolean).map(l => {
      const [name, head, upstream] = l.split('\x1f');
      return { name, current: head === '*', upstream: upstream || '' };
    });
    res.json({ success: true, branches });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/switch', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const branch = await assertSafeBranch(root, req.body && req.body.branch);
    try { await spawnRead('git', ['-C', root, 'switch', '--', branch]); }
    catch (e) { return res.status(400).json({ error: gitErrText(e, 'switch failed') }); }
    res.json({ success: true, branch });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/branch', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const branch = await assertSafeBranch(root, req.body && req.body.name);
    try { await spawnRead('git', ['-C', root, 'switch', '-c', '--', branch]); }
    catch (e) { return res.status(400).json({ error: gitErrText(e, 'create failed') }); }
    res.json({ success: true, branch });
  } catch (e) {
    sendErr(res, e);
  }
});

app.get('/api/git/stash', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    const raw = await spawnRead('git', ['-C', root, 'stash', 'list', '--format=%gd%x1f%gs']);
    const stashes = raw.split('\n').filter(Boolean).map(l => {
      const [ref, ...msg] = l.split('\x1f');
      return { ref, message: msg.join('\x1f') };
    });
    res.json({ success: true, stashes });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/stash', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    let message = req.body && req.body.message;
    message = typeof message === 'string' ? message.trim().slice(0, 200) : '';
    const args = ['-C', root, 'stash', 'push'];
    if (message) args.push('-m', message);
    try { await spawnRead('git', args); }
    catch (e) { return res.status(400).json({ error: gitErrText(e, 'stash failed') }); }
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/stash/pop', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const ref = req.body && req.body.ref;
    const args = ['-C', root, 'stash', 'pop'];
    if (ref !== undefined && ref !== null && ref !== '') {
      if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) {
        return res.status(400).json({ error: 'invalid stash ref' });
      }
      args.push(ref);
    }
    try { await spawnRead('git', args); }
    catch (e) { return res.status(400).json({ error: gitErrText(e, 'pop failed') }); }
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// Discard unstaged worktree changes (VS Code "discard" semantics:
// restores worktree from the index, staged entries untouched).
app.post('/api/git/discard', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const rels = gitFileArgs(root, req.body && req.body.files);
    await spawnRead('git', ['-C', root, 'restore', '--', ...rels]);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/init', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const dir = resolvePath(req.body && req.body.path);
    let st;
    try { st = await fsPromises.stat(dir); } catch { return res.status(400).json({ error: 'directory not found' }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    try { await spawnRead('git', ['-C', dir, 'rev-parse', '--show-toplevel']); }
    catch { await spawnRead('git', ['-C', dir, 'init']); return res.json({ success: true }); }
    res.json({ success: true, already: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Git identity (commit author) ────────────────────────────────────
async function gitIdentityFor(root) {
  let name = '', email = '';
  try { name = (await spawnRead('git', ['-C', root, 'config', 'user.name'])).trim(); } catch {}
  try { email = (await spawnRead('git', ['-C', root, 'config', 'user.email'])).trim(); } catch {}
  return { name, email };
}

app.get('/api/git/identity', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    res.json({ success: true, ...(await gitIdentityFor(root)) });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/identity', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const clean = v => {
      if (typeof v !== 'string') return '';
      const t = v.trim().slice(0, 100);
      if (!t || /[\x00-\x1f\x7f]/.test(t)) { const e = new Error('invalid identity value'); e.status = 400; throw e; }
      return t;
    };
    const name = clean(req.body && req.body.name);
    const email = clean(req.body && req.body.email);
    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'name and a valid email are required' });
    }
    await spawnRead('git', ['-C', root, 'config', 'user.name', name]);
    await spawnRead('git', ['-C', root, 'config', 'user.email', email]);
    res.json({ success: true, name, email });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Git fetch / amend / reset ───────────────────────────────────────
app.post('/api/git/fetch', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    let out = '';
    try { out = await spawnRead('git', ['-C', root, 'fetch', '--all'], { timeout: 60000 }); }
    catch (e) { return res.status(gitErrStatus(e)).json({ error: gitErrText(e, 'fetch failed', 1000) }); }
    res.json({ success: true, output: out.slice(-5000) });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/amend', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    try { await spawnRead('git', ['-C', root, 'rev-parse', '--verify', 'HEAD']); }
    catch { return res.status(400).json({ error: 'nothing to amend (no commits yet)' }); }
    const raw = req.body && req.body.message;
    const args = ['-C', root, 'commit', '--amend'];
    if (typeof raw === 'string' && raw.trim()) args.push('-m', raw.trim().slice(0, 1000));
    else args.push('--no-edit');
    try {
      await spawnRead('git', args);
    } catch (e) { return res.status(400).json({ error: gitErrText(e, 'amend failed') }); }
    let hash = '';
    try { hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim(); } catch {}
    res.json({ success: true, hash });
  } catch (e) {
    sendErr(res, e);
  }
});

// Verify a reset/show target resolves to a commit (returns full hash).
// Accepts HEAD family + full/short hex. Arg-array only — no shell involved.
async function assertCommitRef(root, ref) {
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r || r.length > 100 || (!/^[0-9a-f]{4,40}$/i.test(r) && !/^HEAD([~^]\d*)*$/.test(r))) {
    const e = new Error('invalid ref'); e.status = 400; throw e;
  }
  try {
    const hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--verify', r + '^{commit}'])).trim();
    if (!/^[0-9a-f]{40}$/i.test(hash)) throw new Error('bad ref');
    return hash;
  } catch {
    const e = new Error('ref does not resolve to a commit'); e.status = 400; throw e;
  }
}

app.post('/api/git/reset', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const mode = req.body && req.body.mode;
    if (!['mixed', 'soft', 'hard'].includes(mode)) return res.status(400).json({ error: 'mode must be mixed, soft or hard' });
    const hash = await assertCommitRef(root, (req.body && req.body.ref) || 'HEAD');
    try {
      await spawnRead('git', ['-C', root, 'reset', '--' + mode, hash]);
    } catch (e) { return res.status(400).json({ error: gitErrText(e, 'reset failed') }); }
    res.json({ success: true, mode, hash: hash.slice(0, 7) });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Git tags ────────────────────────────────────────────────────────
async function assertSafeTag(root, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || name.trim().startsWith('-')) {
    const e = new Error('invalid tag name'); e.status = 400; throw e;
  }
  try {
    await spawnRead('git', ['-C', root, 'check-ref-format', 'refs/tags/' + name.trim()]);
  } catch {
    const e = new Error('invalid tag name'); e.status = 400; throw e;
  }
  return name.trim();
}

app.get('/api/git/tags', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    const raw = await spawnRead('git', ['-C', root, 'tag', '--list', '--sort=-creatordate']);
    res.json({ success: true, tags: raw.split('\n').map(t => t.trim()).filter(Boolean).slice(0, 50) });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/tag', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const name = await assertSafeTag(root, req.body && req.body.name);
    const msg = req.body && req.body.message;
    const args = ['-C', root, 'tag'];
    if (typeof msg === 'string' && msg.trim()) args.push('-a', '-m', msg.trim().slice(0, 500));
    args.push('--', name);
    try {
      await spawnRead('git', args);
    } catch (e) { return res.status(400).json({ error: gitErrText(e, 'tag failed') }); }
    res.json({ success: true, name });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/untag', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    const name = await assertSafeTag(root, req.body && req.body.name);
    try {
      await spawnRead('git', ['-C', root, 'tag', '-d', '--', name]);
    } catch (e) { return res.status(400).json({ error: gitErrText(e, 'delete tag failed') }); }
    res.json({ success: true, name });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Git show (commit detail) ────────────────────────────────────────
app.get('/api/git/show', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    const hash = await assertCommitRef(root, req.query.ref);
    let out = await spawnRead('git', ['-C', root, 'show', '--no-color', '--find-renames', '--format=fuller', hash], { timeout: 15000, maxBytes: 400000 });
    const binary = out.includes('Binary files');
    const truncated = out.length > 200000;
    if (truncated) out = out.slice(0, 200000);
    res.json({ success: true, hash, diff: out, binary, truncated });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Git hunks (per-hunk stage / unstage) ────────────────────────────
// The client only ever sends a hunk *index*; the server re-derives the patch
// from a fresh diff, so forged patch content can never be applied.
const HUNK_HEAD_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
function splitDiffHunks(raw) {
  const lines = (raw || '').split('\n');
  const header = [];
  const hunks = [];
  let cur = null;
  for (const line of lines) {
    if (HUNK_HEAD_RE.test(line) && line.startsWith('@@')) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
    } else if (cur) cur.lines.push(line);
    else header.push(line);
  }
  return { header, hunks };
}
function hunkPatchText(headerLines, hunk) {
  return headerLines.join('\n') + '\n' + hunk.header + '\n' + hunk.lines.join('\n');
}
async function gitHunksFor(root, file, cached) {
  const abs = path.resolve(root, file);
  if (!pathContained(root, abs)) { const e = new Error('file outside repo'); e.status = 400; throw e; }
  const rel = path.relative(root, abs) || '.';
  if (rel === '.' || rel === '..' || rel.startsWith('..' + path.sep)) { const e = new Error('invalid file path'); e.status = 400; throw e; }
  const args = ['-C', root, 'diff', '--no-color', '-U3'];
  if (cached) args.push('--cached');
  args.push('--', rel);
  const raw = await spawnRead('git', args, { timeout: 15000 });
  if (!raw.trim()) { const e = new Error(cached ? 'no staged changes for this file' : 'no unstaged changes for this file (untracked files must be staged whole)'); e.status = 400; throw e; }
  if (raw.length > 200000) { const e = new Error('diff too large for hunk view — use the full file diff'); e.status = 400; throw e; }
  const { header, hunks } = splitDiffHunks(raw);
  if (!hunks.length) { const e = new Error('no hunks found (binary file?)'); e.status = 400; throw e; }
  if (hunks.length > 200) { const e = new Error('too many hunks for hunk view — use the full file diff'); e.status = 400; throw e; }
  return { header, hunks };
}

app.get('/api/git/hunks', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.query.path);
    const file = req.query.file;
    if (!file || typeof file !== 'string' || Array.isArray(file)) return res.status(400).json({ error: 'file is required' });
    const { hunks } = await gitHunksFor(root, file, req.query.cached === '1');
    res.json({
      success: true,
      hunks: hunks.map((h, i) => {
        let added = 0, deleted = 0;
        for (const l of h.lines) {
          if (l.startsWith('+') && !l.startsWith('+++')) added++;
          else if (l.startsWith('-') && !l.startsWith('---')) deleted++;
        }
        const preview = h.lines.slice(0, 120);
        return { index: i, header: h.header, added, deleted, lines: preview, truncated: h.lines.length > preview.length };
      })
    });
  } catch (e) {
    sendErr(res, e);
  }
});

// The client sends the hunk header it rendered. Indices shift whenever the
// working tree changes, so an index alone could stage a *different* hunk than
// the one the user clicked; the header pins down which hunk was meant.
async function applyHunk(root, file, index, unstage, expectedHeader) {
  const { header, hunks } = await gitHunksFor(root, file, unstage);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) { const e = new Error('invalid hunk index'); e.status = 400; throw e; }
  const expected = typeof expectedHeader === 'string' ? expectedHeader.trim() : '';
  let target = i;
  if (expected) {
    const matches = [];
    for (let n = 0; n < hunks.length; n++) if (hunks[n].header.trim() === expected) matches.push(n);
    if (!matches.length) {
      const e = new Error('hunk changed on disk — refresh and retry');
      e.status = 409;
      throw e;
    }
    // Prefer the original position when it still holds the same hunk, otherwise
    // apply the hunk the user actually saw at its new index.
    target = matches.includes(i) ? i : matches[0];
  } else if (i >= hunks.length) {
    const e = new Error('invalid hunk index'); e.status = 400; throw e;
  }
  const patch = hunkPatchText(header, hunks[target]);
  const args = ['-C', root, 'apply', '--cached'];
  if (unstage) args.push('--reverse');
  args.push('-');
  try {
    await spawnRead('git', args, { input: patch });
  } catch (e) {
    const msg = gitErrText(e, '', 500);
    throw Object.assign(new Error(msg.includes('patch does not apply') || !msg ? 'hunk no longer applies — refresh and retry' : msg), { status: 400 });
  }
}

app.post('/api/git/stage-hunk', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    if (!req.body || typeof req.body.file !== 'string') return res.status(400).json({ error: 'file is required' });
    await applyHunk(root, req.body.file, req.body.index, false, req.body.expected);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

app.post('/api/git/unstage-hunk', rateLimiter, checkPin, async (req, res) => {
  try {
    if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
    const root = await gitRootFor(req.body && req.body.path);
    if (!req.body || typeof req.body.file !== 'string') return res.status(400).json({ error: 'file is required' });
    await applyHunk(root, req.body.file, req.body.index, true, req.body.expected);
    res.json({ success: true });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Session persistence ──────────────────────────────────────────────
let TMUX = (() => { try { const p = execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); return getValidExecutable(p); } catch { return null; } })();
const TMUX_PREFIX = 'wt-webtun-'; // namespaced to avoid collision with user wt-* (F14)
function getTMUX() {
  if (!TMUX) { try { const p = execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); TMUX = getValidExecutable(p); } catch { TMUX = null; } }
  return TMUX;
}
// Per-instance namespace: two servers on one box (repo checkout + global/npx
// on another port, …) must never adopt or kill each other's sessions, so own
// sessions live under `wt-webtun-<port>-<id>` — PORT is unique per box.
// Legacy `wt-webtun-<id>` / `wt-<id>` sessions (pre-namespacing) are still
// adopted for reconnect, but the sweeps below only kill legacy sessions with
// no attached clients: a live foreign session always has its owner attached
// and is therefore spared. Foreign port-namespaced sessions are never killed.
function tmuxOwnName(id) { return `${TMUX_PREFIX}${Number(PORT)}-${id}`; }
function tmuxLegacyNames(id) { return [TMUX_PREFIX + id, 'wt-' + id]; }
// Names this server may attach to / resize / explicitly kill for an id: its
// own plus legacy fallbacks — never a foreign port-namespace, even when a
// crafted session id spells one out (id `5253-x` on a :5252 server would
// otherwise resolve the legacy fallback to a sibling's live session).
function tmuxAdoptableNames(id) {
  return [tmuxOwnName(id), ...tmuxLegacyNames(id).filter(n => tmuxKind(n) !== 'foreign')];
}
// 'ours' | 'legacy' | 'foreign' | null (not a WebTun session at all)
function tmuxKind(name) {
  if (typeof name !== 'string' || !name.startsWith(TMUX_PREFIX)) return null;
  const m = /^(\d+)-/.exec(name.slice(TMUX_PREFIX.length));
  if (!m) return 'legacy';
  return Number(m[1]) === Number(PORT) ? 'ours' : 'foreign';
}
function tmuxHasClients(name) {
  try {
    const out = execFileSync(getTMUX(), ['list-clients', '-t', name], { stdio: 'pipe', encoding: 'utf8' , timeout: 5000}).trim();
    return out.length > 0;
  } catch { return false; }
}

// ── Instance ownership: tracked, never inferred ─────────────────────────
// The port-namespace alone cannot tell two same-port servers apart (e.g. a
// throwaway test instance and a live one both "own" wt-webtun-3000-* by
// name — and the namespace follows $PORT, not the effective listen port, so
// even different-port CLI instances can collide). Guessing ownership from
// the name let one instance reap another's live sessions. Instead:
//  - every tmux session THIS process creates is recorded in ownTmuxSessions;
//    shutdown kills exactly those, never the whole namespace;
//  - a box-shared claim file (pid + token, in os.tmpdir so repo checkouts
//    and global installs see the same claim) records the live owner of this
//    port-namespace; both sweeps stand down while another live process holds
//    the claim;
//  - the startup sweep runs only after the port binds successfully, so a
//    process that cannot bind does nothing destructive.
const ownTmuxSessions = new Set();
let tmuxSweepsArmed = true; // false while a live sibling owns this namespace
let tmuxClaimToken = null;
function tmuxClaimPath(port = PORT) {
  // Per-UID claim file: os.tmpdir() is world-writable, so a shared name let
  // any local user read/tamper with (or pre-plant) another user's claim.
  let uid = '';
  try { uid = String(process.getuid ? process.getuid() : 'nouid'); } catch { uid = 'nouid'; }
  return path.join(os.tmpdir(), `webtun-tmux-${Number(port)}-u${uid}.json`);
}
function readTmuxClaim(port = PORT) {
  try {
    const c = JSON.parse(fs.readFileSync(tmuxClaimPath(port), 'utf8'));
    if (c && Number.isInteger(c.pid) && c.pid > 0 && typeof c.token === 'string') return c;
  } catch {}
  return null;
}
function tmuxClaimLive(c) {
  if (!c) return false;
  try { process.kill(c.pid, 0); }
  catch (e) {
    // EPERM means a live process owned by another user — never treat it as
    // dead (that let a second user steal the claim via PID-reuse logic).
    if (e && e.code === 'EPERM') return true;
    return false; // no such process (ESRCH)
  }
  // Guard PID reuse: the claimant must still be a WebTun server. Strict match
  // on the server entry (not a broad /webtun/ substring) so unrelated
  // processes don't keep the claim alive forever.
  try {
    const cmd = fs.readFileSync(`/proc/${c.pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    const base = path.basename(cmd.split(' ')[0] || '');
    if (/^server\.js$/.test(base) || /(^|\/)server\.js(\s|$)/.test(cmd)) return true;
    if (/(^|\/)(webtun)(\s|$)/.test(cmd) || /node_modules[\\/]\.bin[\\/]webtun(\s|$)/.test(cmd)) return true;
    return false;
  } catch { return true; } // non-Linux: kill-0 is the best signal available
}
function writeTmuxClaim(port = PORT) {
  tmuxClaimToken = crypto.randomBytes(16).toString('hex');
  const c = { pid: process.pid, token: tmuxClaimToken, startedAt: Date.now() };
  // Atomic tmp+rename with 0600: the old unconditional world-readable write
  // raced parallel starters (both passed the read check, both swept) and was
  // tamperable by local users.
  try {
    const dest = tmuxClaimPath(port);
    const tmp = dest + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, dest);
  } catch {}
  return c;
}
function releaseTmuxClaim(port = PORT) {
  // Release only what we hold: a sibling may have taken over since.
  try {
    const cur = readTmuxClaim(port);
    if (cur && cur.pid === process.pid && cur.token === tmuxClaimToken) fs.unlinkSync(tmuxClaimPath(port));
  } catch {}
}

// In-memory PTY session store — enables persistence without tmux (Windows + Linux)
const ptySessions = new Map(); // sessionId -> { proc, exited, createdAt, lastActive, attached }
 // TTL sweep every 5min: delete sessions with no attached ws idle over 30min (F73).
 // Sessions with a live connection are never swept, however long they run.
const ptySessionSweep = setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of ptySessions) {
    if ((entry.attached || 0) > 0) continue;
    if (now - (entry.lastActive || entry.createdAt || 0) > 30 * 60 * 1000) {
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
if (ptySessionSweep.unref) ptySessionSweep.unref();

// Link-local / cloud-metadata addresses that must never be a tunnel target,
// whether they arrive as a literal or as the resolution of a hostname.
function isBlockedTunnelIp(host) {
  let h = String(host == null ? '' : host).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  // IPv4-mapped IPv6 (::ffff:169.254.169.254): vet the embedded IPv4 too.
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length).replace(/^\[|\]$/g, '');
  if (h === '100.100.100.200' || h === '192.0.0.192' || h === 'fd00:ec2::254') return true;
  if (h.startsWith('169.254.')) return true;          // IPv4 link-local (metadata)
  if (h === '169.254') return true;
  if (h.startsWith('fe80:') || /^fe[89ab][0-9a-f]:/.test(h)) return true; // IPv6 fe80::/10
  return false;
}

function isValidPID(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

// Clean up dead tmux sessions from previous runs on startup
function cleanupOrphanTmuxSessions() {
  if (!TMUX) return;
  if (!tmuxSweepsArmed) return; // a live sibling owns this namespace — hands off
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' , timeout: 5000}).trim();
    // Only our namespaced prefix — never bare 'wt-', which may belong to the user.
    // Within our family: own port-namespace + legacy names, clientless only.
    // Foreign port-namespaced sessions belong to a sibling server — never ours.
    const sessions = out.split('\n').filter(s => { const k = tmuxKind(s); return k === 'ours' || k === 'legacy'; });
    for (const s of sessions) {
      if (tmuxKind(s) === null) continue;
      try {
        const clients = execFileSync(TMUX, ['list-clients', '-t', s], { stdio: 'pipe', encoding: 'utf8' , timeout: 5000}).trim();
        if (!clients) {
          execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore' , timeout: 5000});
        }
      } catch {}
    }
  } catch {}
}

function tmuxSessionExists(name) {
  try { execFileSync(TMUX, ['has-session', '-t', name], { stdio: 'ignore' , timeout: 5000}); return true; } catch { return false; }
}

app.get('/api/sessions', checkPin, (req, res) => {
  const tmuxBin = getTMUX();
  if (tmuxBin) {
    try {
      const out = execFileSync(tmuxBin, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' , timeout: 5000}).trim();
      const sessions = out.split('\n').filter(Boolean)
        .filter(s => { const k = tmuxKind(s); return k === 'ours' || k === 'legacy'; })
        .map(s => {
          // Strip our port segment so ids stay stable reconnect tokens;
          // legacy names slice the family prefix as before.
          const id = tmuxKind(s) === 'ours'
            ? s.slice((TMUX_PREFIX + Number(PORT) + '-').length)
            : s.slice(TMUX_PREFIX.length);
          return { id, name: s };
        });
      // Merged listing: getTMUX() flips null→found mid-run, which used to
      // hide pre-existing in-memory sessions (and re-route the same
      // sessionId to another backend). Include both, tmux first.
      const seen = new Set(sessions.map(s => s.id));
      for (const [id] of ptySessions) {
        if (!seen.has(id)) sessions.push({ id, name: tmuxOwnName(id) });
      }
      return res.json({ tmux: true, sessions });
    } catch {
      return res.json({ tmux: true, sessions: [] });
    }
  }
  // In-memory sessions (no tmux)
  const sessions = [];
  for (const [id] of ptySessions) {
    sessions.push({ id, name: tmuxOwnName(id) });
  }
  res.json({ tmux: false, sessions });
});

app.delete('/api/sessions/:id', checkPin, (req, res) => {
  const raw = req.params.id || '';
  const id = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || id.length > 64) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  if (TMUX) {
    // Own namespace first, then legacy names for migration. An explicit
    // user-requested kill; foreign namespaces are excluded even for crafted
    // ids (see tmuxAdoptableNames).
    const tryNames = tmuxAdoptableNames(id);
    let found = false;
    for (const n of tryNames) {
      if (tmuxSessionExists(n)) {
        found = true;
        try { execFileSync(TMUX, ['kill-session', '-t', n], { stdio: 'ignore' , timeout: 5000}); } catch {}
      }
    }
    return res.json({ success: true, alreadyGone: !found });
  }
  // In-memory session
  const entry = ptySessions.get(id);
  if (entry) {
    try { if (entry.proc) entry.proc.kill(); } catch {}
    ptySessions.delete(id);
    return res.json({ success: true });
  }
  return res.json({ success: true, alreadyGone: true });
});

// ── Live terminal cwd ───────────────────────────────────────────────────
// `tab.cwd` on the client is only refreshed by OSC 7, which most shells never
// emit — so `cd` left "Go to terminal directory" pointing at the stale launch
// dir. This endpoint resolves the session's CURRENT directory on demand, so
// the button always lands where the shell actually is when pressed.
const PTY_SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'fish', 'ksh', 'mksh',
  'lksh', 'tcsh', 'csh', 'yash', 'elvish', 'nu', 'nushell', 'oil', 'osh', 'powershell', 'pwsh']);
function isShellComm(name) {
  if (!name) return false;
  return PTY_SHELL_NAMES.has(String(name).split('/').pop().toLowerCase());
}
// /proc/<pid>/stat: `pid (comm) state ppid … starttime(22)`. comm may hold
// spaces/parens, so split off the trailing `) ` before tokenising.
function procStatInfo(pid) {
  try {
    // trim(): the file ends with '\n', and JS `$` (no /m) matches end-of-input
    // only — without this every parse failed and the scan found nothing.
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const m = /^(\d+) \((.*)\) (.*)$/.exec(s);
    if (!m) return null;
    const parts = m[3].split(' ');
    return { pid, comm: m[2], ppid: parseInt(parts[1], 10), starttime: parseInt(parts[19], 10) || 0 };
  } catch { return null; }
}
function procChildrenMap(info) {
  const children = new Map();
  for (const [p, s] of info) {
    if (!Number.isInteger(s.ppid)) continue;
    if (!children.has(s.ppid)) children.set(s.ppid, []);
    children.get(s.ppid).push(p);
  }
  return children;
}
function bfsDescendants(rootPid, children, cap = 2000) {
  const depth = new Map([[rootPid, 0]]);
  const queue = [rootPid];
  const desc = [];
  while (queue.length && desc.length < cap) {
    const cur = queue.shift();
    for (const k of children.get(cur) || []) {
      if (depth.has(k)) continue;
      depth.set(k, depth.get(cur) + 1);
      queue.push(k);
      desc.push(k);
    }
  }
  return { depth, desc };
}
// A bare `cd` changes the shell itself, but `bash`/`zsh` subshells (and
// `sudo -i`) move only a descendant — so prefer the deepest descendant shell
// (youngest wins ties) and fall back to the session shell itself.
function linuxDescendantShellCwd(rootPid) {
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return null; }
  const pids = entries.filter(e => /^\d+$/.test(e)).map(Number).filter(n => n > 0);
  if (pids.length > 8000) return null; // be kind on huge boxes — caller falls back
  const info = new Map();
  for (const p of pids) { const st = procStatInfo(p); if (st) info.set(p, st); }
  if (!info.has(rootPid)) return null;
  const { depth, desc } = bfsDescendants(rootPid, procChildrenMap(info));
  let best = null;
  for (const d of desc) {
    const s = info.get(d);
    if (!s) continue;
    let exe = '';
    try { exe = path.basename(fs.readlinkSync(`/proc/${d}/exe`)); } catch {}
    if (!isShellComm(s.comm) && !isShellComm(exe)) continue;
    const cand = { pid: d, depth: depth.get(d) || 0, starttime: s.starttime || 0 };
    if (!best || cand.depth > best.depth ||
        (cand.depth === best.depth && (cand.starttime > best.starttime ||
          (cand.starttime === best.starttime && cand.pid > best.pid)))) best = cand;
  }
  if (!best) return null;
  try {
    const cwd = fs.readlinkSync(`/proc/${best.pid}/cwd`);
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return null;
}
function darwinProcCwd(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-F', 'n'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const lines = String(out).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('n') && lines[i].length > 1) return lines[i].slice(1);
    }
  } catch {}
  return null;
}
function darwinDescendantShellCwd(rootPid) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,ppid,comm'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const info = new Map();
    for (const r of String(out).split('\n').slice(1)) {
      const m = r.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      info.set(Number(m[1]), { ppid: Number(m[2]), comm: path.basename(m[3].trim()) });
    }
    if (!info.has(rootPid) && rootPid !== 1) {
      // `ps` snapshot raced the lookup — still try the root pid itself below.
    }
    const { depth, desc } = bfsDescendants(rootPid, procChildrenMap(info));
    const shells = desc
      .filter(d => isShellComm((info.get(d) || {}).comm))
      .sort((a, b) => ((depth.get(b) || 0) - (depth.get(a) || 0)) || (b - a))
      .slice(0, 10); // one lsof spawn each — bound the cost
    for (const p of shells) {
      const cwd = darwinProcCwd(p);
      if (cwd) { try { if (fs.statSync(cwd).isDirectory()) return cwd; } catch {} }
    }
  } catch {}
  return null;
}
function resolvePtyCwd(pid) {
  const plat = os.platform();
  if (plat === 'win32') return null; // no /proc or lsof — client keeps its OSC 7 cache
  if (plat === 'darwin') {
    return darwinDescendantShellCwd(pid) || darwinProcCwd(pid);
  }
  try {
    const nested = linuxDescendantShellCwd(pid);
    if (nested) return nested;
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return null;
}

app.get('/api/sessions/:id/cwd', checkPin, (req, res) => {
  const raw = req.params.id || '';
  const id = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || id.length > 64) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  // tmux sessions report the active pane's directory directly, whatever the
  // shell is (no OSC 7 cooperation needed). Names stay in the adoptable set
  // so a crafted id can never query a foreign port-namespace.
  const tmuxBin = getTMUX();
  if (tmuxBin) {
    for (const n of tmuxAdoptableNames(id)) {
      try {
        const out = execFileSync(tmuxBin, ['display-message', '-p', '-t', n, '-F', '#{pane_current_path}'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        if (out && fs.statSync(out).isDirectory()) return res.json({ cwd: out });
      } catch {}
    }
    // A ptySession under the same id (pre-tmux sibling) still answers below.
    if (!ptySessions.has(id)) return res.status(404).json({ error: 'session not found' });
  }
  const entry = ptySessions.get(id);
  if (!entry || !entry.proc || entry.exited) return res.status(404).json({ error: 'session not found' });
  if (!isValidPID(entry.proc.pid)) return res.status(404).json({ error: 'session not found' });
  if (os.platform() === 'win32') {
    return res.status(501).json({ error: 'live directory lookup not supported on this platform' });
  }
  const cwd = resolvePtyCwd(entry.proc.pid);
  if (!cwd) return res.status(404).json({ error: 'directory unavailable' });
  return res.json({ cwd });
});

// ── WebSocket terminal ────────────────────────────────────────────────
// Binary protocol (fast, no JSON per keystroke):
//   Server → Client:  [type:1B][payload]
//     0x00 = terminal data (UTF-8)
//     0x01 = exit          (1B exit code)
//     0x02 = error         (UTF-8 message)
//     0x03 = event         (JSON: new-login alerts, session-revoked kicks)
//   Client → Server:
//     0x00 = input         (UTF-8) – max 1MB per message (client chunks ~45KB)
//     0x01 = resize        (4B: cols uint16LE, rows uint16LE)
//     0x02 = ping          (no payload)

// Extra allowed WS origins for reverse-proxy / custom hostnames, comma-separated.
// Same-origin requests are always allowed; this used to be a permanently empty
// Set, which made the membership test below dead code.
//   ALLOWED_ORIGINS=https://box.example.com,https://other.example.net
const ALLOWED_WS_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
);
// Failed WS handshakes per IP (brute-force throttle), swept every minute.
const wsAuthFails = new Map();
const WS_AUTH_FAILS_MAX = 10000;
const wsAuthFailsSweep = setInterval(() => {
  const _now = Date.now();
  for (const [_ip, _w] of wsAuthFails) { if (_now > _w.resetAt) wsAuthFails.delete(_ip); }
  while (wsAuthFails.size > WS_AUTH_FAILS_MAX) {
    const first = wsAuthFails.keys().next().value;
    if (first === undefined) break;
    wsAuthFails.delete(first);
  }
}, 60000);
if (wsAuthFailsSweep.unref) wsAuthFailsSweep.unref();

// Push a JSON control event to terminal clients (server→client type 0x03).
// Used for new-login alerts and session-revoked kicks.
function sendClientEvent(ws, obj) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const frame = Buffer.alloc(1 + payload.length);
    frame[0] = 0x03;
    payload.copy(frame, 1);
    ws.send(frame);
  } catch {}
}
function broadcastClientEvent(obj) {
  try {
    for (const ws of wss.clients) sendClientEvent(ws, obj);
  } catch {}
}
// Read-only session lookup: unlike getSession() it does NOT bump lastSeen, so
// the periodic sweep below can't keep an idle session alive indefinitely.
function peekSession(token) {
  const s = authSessions.get(token);
  if (!s) return null;
  if (Date.now() - (s.lastSeen || 0) > SESSION_IDLE_MS) { authSessions.delete(token); return null; }
  return s;
}
// Is this socket's credential still good? Raw-PIN sockets (legacy) are valid
// only while the PIN is unchanged; session sockets must still be active.
function wsTokenValid(token) {
  if (!PIN) return true;
  if (typeof token !== 'string' || !token) return false;
  if (constantTimeEqual(token, PIN)) return true;
  const s = peekSession(token);
  return !!(s && s.status === 'active');
}
// Kick every socket whose credential no longer validates — including sockets
// that handshook while the instance was still open (no token recorded).
// Preview WS clients (previewWSS) authenticated once at upgrade and used to
// outlive PIN rotation/revoke forever; they are reaped here too.
function closeInvalidSockets(reason) {
  for (const ws of wss.clients) {
    try {
      const t = ws._authToken;
      if (t && wsTokenValid(t)) continue;
      sendClientEvent(ws, { event: 'session-revoked' });
      ws.close(1008, reason || 'Session no longer valid');
    } catch {}
  }
  try {
    if (typeof previewWSS !== 'undefined' && previewWSS && previewWSS.clients) {
      for (const ws of previewWSS.clients) {
        try {
          const t = ws._authToken;
          if (t && wsTokenValid(t)) continue;
          try { ws.close(1008, reason || 'Session no longer valid'); } catch {}
        } catch {}
      }
    }
  } catch {}
}
// Revoke one session: notify AND close it. The 0x03 event lets the client show
// the right UI; the close is what actually stops the shell.
function pushSessionRevoked(token) {
  try {
    for (const ws of wss.clients) {
      try {
        if (ws._authToken !== token) continue;
        sendClientEvent(ws, { event: 'session-revoked' });
        ws.close(1008, 'Session revoked');
      } catch {}
    }
    if (typeof previewWSS !== 'undefined' && previewWSS && previewWSS.clients) {
      for (const ws of previewWSS.clients) {
        try {
          if (ws._authToken !== token) continue;
          try { ws.close(1008, 'Session revoked'); } catch {}
        } catch {}
      }
    }
  } catch {}
}
// Sessions also die on their own (idle expiry, pending lapse, eviction).
// Re-validate every terminal socket once a minute so a stale socket can never
// outlive its session.
const wsAuthSweep = setInterval(() => {
  if (!PIN) return;
  try { closeInvalidSockets('Session no longer valid'); } catch {}
}, 60000);
if (wsAuthSweep.unref) wsAuthSweep.unref();
function getWsOrigin(req) {
  return (req.headers['origin'] || '').replace(/\/$/, '');
}

wss.on('connection', (ws, req) => {
  // Origin check to prevent Cross-Site WebSocket Hijacking — allow empty Origin (non-browser clients) but validate token separately
  const origin = getWsOrigin(req);
  if (origin) {
    const host = req.headers['host'] || '';
    // x-forwarded-host is client-controlled: only honor it behind a trusted proxy.
    const trustProxy = process.env.TRUST_PROXY === 'true';
    const fwdHost = trustProxy ? (req.headers['x-forwarded-host'] || '') : '';
    let originHost = '';
    try { originHost = new URL(origin).host; } catch {}
    const allowedLocal = origin === `http://${host}` || origin === `https://${host}` ||
                         (fwdHost && (origin === `http://${fwdHost}` || origin === `https://${fwdHost}`)) ||
                         originHost === host || (fwdHost && originHost === fwdHost) ||
                         origin === `http://localhost` || origin === `https://localhost` ||
                         origin === `http://127.0.0.1` || origin === `https://127.0.0.1`;
    if (!allowedLocal && !ALLOWED_WS_ORIGINS.has(origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
  }

  const url   = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');

  // Use constant-time compare for WS token (F49).
  // Handshake throttle: >20 failed auths/min per IP gets dropped (no limiter otherwise).
  // Accepts active session tokens as well as the raw PIN (back-compat, gated
  // like HTTP when other sessions exist). Pending sessions get no shell.
  if (PIN) {
    const t = typeof token === 'string' ? token : '';
    const _s = t ? getSession(t) : null;
    const _pinOk = t && constantTimeEqual(t, PIN) && rawPinAllowed({ socket: req.socket, headers: req.headers, get ip() { return req.socket.remoteAddress; } });
    if (!t || (!_pinOk && (!_s || _s.status !== 'active'))) {
      try {
        const _ip = req.socket.remoteAddress || 'unknown';
        const _now = Date.now();
        let _w = wsAuthFails.get(_ip);
        if (!_w || _now > _w.resetAt) _w = { count: 0, resetAt: _now + 60000 };
        _w.count++;
        wsAuthFails.set(_ip, _w);
        // Same 10000-key eviction cap as createRateLimiter(): unbounded
        // per-IP entries from IP rotation used to grow the map until expiry.
        if (wsAuthFails.size > WS_AUTH_FAILS_MAX) {
          const first = wsAuthFails.keys().next().value;
          if (first !== undefined && first !== _ip) wsAuthFails.delete(first);
        }
        if (_w.count > 20) { try { req.socket.destroy(); } catch {} }
      } catch {}
      ws.close(1008, 'Unauthorized'); return;
    }
    // Attribute the socket so session-revoke can kick exactly this client
    try { ws._authToken = t; } catch {}
  }

  let cols      = parseInt(url.searchParams.get('cols'))  || 80;
  let rows      = parseInt(url.searchParams.get('rows'))  || 24;
  // Clamp cols/rows to prevent OOM (F52): 2-500. The clamp is also the
  // validation — `parseInt(...) || 80|24` and Math.min/max guarantee two
  // finite integers in range, so there is nothing left to reject here.
  cols = Math.min(Math.max(2, cols), 500);
  rows = Math.min(Math.max(2, rows), 500);
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
    if (!sanitized || sanitized.length > 64) {
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
      const tmuxName = tmuxOwnName(sessionId);
      const candidates = tmuxAdoptableNames(sessionId);
      const exists = candidates.some(tmuxSessionExists);
      // Adopt a legacy session (pre-namespacing) when ours doesn't exist yet.
      // Migration window only: foreign namespaces are excluded above, and ids
      // are per-tab tokens, so a cross-instance collision is negligible.
      let effectiveName = tmuxName;
      if (!tmuxSessionExists(tmuxName)) {
        const found = candidates.slice(1).find(tmuxSessionExists);
        if (found) effectiveName = found;
      }

      if (exists) {
        // Never force the window size here. resize-window flips the session
        // to window-size manual AND over-claims tmux's status-bar row: the
        // pane ends up as tall as the client, so the inner app's last row
        // hides underneath the status bar (e.g. a TUI footer). tmux auto-fits
        // attached clients on its own (window minus status line); just make
        // sure sessions stuck in manual by older builds go back to auto-fit.
        try { execFileSync(TMUX, ['set-option', '-t', effectiveName, 'window-size', 'latest'], { stdio: 'ignore' , timeout: 5000}); } catch {}
        proc = pty.spawn(TMUX, ['attach-session', '-t', effectiveName], {
          name: 'xterm-256color', cols, rows, cwd,
          env: sessionEnv
        });
      } else {
        proc = pty.spawn(TMUX, ['new-session', '-s', tmuxName], {
          name: 'xterm-256color', cols, rows, cwd,
          env: { ...sessionEnv, SHELL }
        });
        ownTmuxSessions.add(tmuxName);
        // Pin auto-fit on our own sessions so a global tmux.conf
        // (window-size largest/manual) can't reintroduce the covered-row
        // bug described above.
        try { execFileSync(TMUX, ['set-option', '-t', tmuxName, 'window-size', 'latest'], { stdio: 'ignore' , timeout: 5000}); } catch {}
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

  proc.onExit(({ exitCode } = {}) => {
    clearInterval(drainCheck);
    // Keep a tombstone so reconnect-after-exit reports exited instead of
    // silently spawning new: the old code deleted the entry first, so the
    // second tracker below always saw undefined.
    const code = Number.isInteger(exitCode) ? exitCode & 0xff : 0;
    if (useInMemory) {
      const prev = ptySessions.get(sessionId);
      ptySessions.set(sessionId, { proc: null, exited: true, createdAt: (prev && prev.createdAt) || Date.now(), lastActive: Date.now(), attached: 0, exitCode: code });
    }
    if (!useTmux) send(0x01, Buffer.from([code]));
    ws.close();
  });

  // If this is a new in-memory session, register it now (after onExit is wired)
  if (useInMemory && !reattached) {
    ptySessions.set(sessionId, { proc, exited: false, createdAt: Date.now(), lastActive: Date.now(), attached: 1 });
    // Track exit so stale sessions are detected on reconnect
    proc.onExit(() => {
      const entry = ptySessions.get(sessionId);
      if (entry) entry.exited = true;
    });
  } else if (useInMemory && reattached) {
    const entry = ptySessions.get(sessionId);
    if (entry) {
      entry.proc = proc; entry.exited = false;
      entry.lastActive = Date.now(); entry.attached = (entry.attached || 0) + 1;
      // Reinstall the exit tracker (reattach strips old listeners)
      proc.onExit(() => {
        const e2 = ptySessions.get(sessionId);
        if (e2) e2.exited = true;
      });
    }
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
      if (useInMemory && sessionId) {
        const _e = ptySessions.get(sessionId);
        if (_e) _e.lastActive = Date.now();
      }
      const buf  = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length < 1) return;
      const type = buf[0];
      if (type === 0x00) {
        // Cap input at 1MB per message (backstop; the client chunks to ~45KB
        // and the protocol doc states the same 1MB cap). Slice on a UTF-8
        // boundary so a trailing multibyte char is never split mid-sequence.
        let end = Math.min(buf.length, 1048577);
        if (end > 1 && buf.length > end) {
          let back = end - 1;
          let cont = 0;
          while (back > 1 && cont < 3 && buf[back] >= 0x80 && buf[back] < 0xC0) { back--; cont++; }
          if (cont > 0 && cont < 4 && back > 1 && buf[back] >= 0xC0) {
            const need = buf[back] >= 0xF0 ? 4 : buf[back] >= 0xE0 ? 3 : 2;
            if (end - back < need) end = back;
          }
        }
        const payload = buf.slice(1, end);
        proc.write(payload.toString('utf8'));
      } else if (type === 0x02) {
        // Client heartbeat (protocol 0x02 ping): mark the socket alive so the
        // server-side ping/pong sweep below doesn't reap it. No reply needed.
        ws.isAlive = true;
        return;
      } else if (type === 0x01 && buf.length >= 5) {
        let c = buf.readUInt16LE(1), r = buf.readUInt16LE(3);
        c = Math.min(Math.max(2, c), 500);
        r = Math.min(Math.max(2, r), 500);
        proc.resize(c, r);
        // NOTE: no resize-window here, deliberately. Forcing the window to
        // the full client size flips the session to window-size manual and
        // hides the inner app's last row under tmux's status bar (the client
        // only shows window rows minus the status line). tmux auto-fits
        // attached clients itself (window-size latest is enforced for our
        // sessions at connect); the pty resize above is all it needs.
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
      const _e = ptySessions.get(sessionId);
      if (_e) { _e.attached = Math.max(0, (_e.attached || 1) - 1); _e.lastActive = Date.now(); }
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
    sendErr(res, e);
  }
});

function spawnRead(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout || 5000;
    const child = spawn(cmd, args, { stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    // Two different caps:
    //  maxBuffer — hard limit; exceeding it aborts the command (runaway output).
    //  maxBytes  — soft limit; output keeps draining but stops being accumulated.
    //              Callers that slice the result to a fixed size anyway pass this so
    //              they don't buffer megabytes of text they are about to throw away.
    const maxBuffer = opts.maxBuffer || 2 * 1024 * 1024;
    const maxBytes = Math.min(opts.maxBytes || maxBuffer, maxBuffer);
    const MAX_STDERR = 64 * 1024;
    let stdout = '', stderr = '', outLen = 0, killed = false;
    const onData = store => d => {
      if (killed) return;
      outLen += d.length;
      if (outLen > maxBuffer) {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('command output exceeded limit'));
        return;
      }
      if (store === 0) {
        if (stdout.length >= maxBytes) return;
        stdout += d.toString();
        if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes);
      } else if (stderr.length < MAX_STDERR) {
        stderr += d.toString();
        if (stderr.length > MAX_STDERR) stderr = stderr.slice(0, MAX_STDERR);
      }
    };
    child.stdout.on('data', onData(0));
    child.stderr.on('data', onData(1));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      try { child.stdin.end(opts.input); } catch {}
    }
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      // Timeout-kill used to reject with empty stderr → generic "Operation
      // failed" via safeErr. Name timeouts so gitErrStatus can map them.
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        const t = stderr.trim();
        const e = new Error(t ? t + ` (command timed out after ${timeoutMs}ms)` : `command timed out after ${timeoutMs}ms`);
        e.code = 'ETIMEDOUT';
        return reject(e);
      }
      reject(new Error(stderr));
    });
    child.on('error', reject);
  });
}

// ── System stats ────────────────────────────────────────────────────
// Stats are polled repeatedly by the UI, and each miss shells out to df/ps/nvidia-smi
// and burns a 100 ms CPU sample. Serve a 2 s-old sample instead. (B-L6)
const SYS_STATS_TTL_MS = 2000;
let _sysStatsCache = { at: 0, data: null };
app.get('/api/system', checkPin, async (req, res) => {
  if (_sysStatsCache.data && Date.now() - _sysStatsCache.at < SYS_STATS_TTL_MS) {
    return res.json(_sysStatsCache.data);
  }
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

  const payload = {
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime(),
    cpu: { model: cpuModel, count: cpuCount, usage: cpuUsage, loadAvg },
    memory: { total: totalMem, free: freeMem, used: usedMem, percent: memPercent },
    gpus,
    disk,
    processes
  };
  _sysStatsCache = { at: Date.now(), data: payload };
  res.json(payload);
});

// ── Kill process (from System Stats) ────────────────────────────────
app.post('/api/system/kill', checkPin, requirePinSet, async (req, res) => {
  try {
    const raw = req.body && (req.body.pid ?? req.body.id);
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'invalid pid' });
    if (pid === 1) return res.status(400).json({ error: 'refusing to kill pid 1' });
    if (pid === process.pid) return res.status(400).json({ error: 'refusing to kill self' });
    // Prevent killing cloudflared tunnels managed by WebTun
    for (const [, t] of tunnels) { if (t.pid === pid) return res.status(400).json({ error: 'refusing to kill managed cloudflared' }); }
    if (os.platform() === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { return sendErr(res, e && e.message ? e : new Error('kill failed'), 500); }
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (e) {
        if (e.code === 'ESRCH') return res.status(404).json({ error: 'process not found' });
        try { process.kill(pid, 'SIGKILL'); } catch (e2) { return sendErr(res, e2, 500); }
      }
      // Give 1.5s then SIGKILL if still alive
      setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }, 1500);
    }
    res.json({ success: true, pid });
  } catch (e) {
    sendErr(res, e);
  }
});

// ── Shutdown server (from Settings → Exit app) ─────────────────────
// Stops tunnels/PTYs via cleanup(), then exits. Authed + PIN-protected
// like /api/system/kill so an open instance can't be killed remotely.
app.post('/api/system/shutdown', checkPin, requirePinSet, (req, res) => {
  res.json({ success: true, message: 'Shutting down' });
  // Let the response flush before tearing down.
  setTimeout(() => {
    try { cleanup(); } catch {}
    try {
      server.close(() => { process.exit(0); });
    } catch {}
    // Fallback: never hang if connections keep the server alive.
    setTimeout(() => { process.exit(0); }, 1500).unref?.();
  }, 100);
});

// ── Cloudflared tunnel management ──────────────────────────────────
const tunnels = new Map();
const TUNNEL_FILE = path.join(DATA_DIR, '.tunnels.json');
const TUNNEL_URL_FILE = path.join(DATA_DIR, 'tunnel-url.txt');
// NOTE (documented tradeoff, single-owner box): DATA_DIR is shared by every
// instance on this box (repo checkout, global/npx, Electron), so .tunnels.json
// / .cmdhist.json / tunnel-url.txt / .env are last-writer-wins across
// different PORTs — two servers writing concurrently can clobber each other's
// tunnels/history. All writes are atomic tmp+rename 0600, so files never
// corrupt, but no cross-instance merge is attempted (single-owner model: one
// live server per box is the supported shape).

// A recycled PID can make a dead tunnel look alive. When the process start
// time was recorded at spawn, require it to still match (Linux: starttime
// ticks since boot; macOS: lstart). Windows has no cheap equivalent, so it
// keeps the command-name check.
function processStartKey(pid) {
  if (!isValidPID(pid)) return null;
  try {
    if (os.platform() === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return rest[19] || null;
    }
    if (os.platform() === 'darwin') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    }
    if (os.platform() === 'win32') {
      // No /proc on Windows: process creation time distinguishes a recycled
      // PID (best-effort; null on failure keeps the command-name check).
      try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        return out || null;
      } catch { return null; }
    }
  } catch {}
  return null;
}

function isCloudflaredProcess(pid) {
  if (!isValidPID(pid)) return false;
  try {
    if (os.platform() === 'win32') {
      const stdout = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return stdout.toLowerCase().includes('cloudflared');
    } else if (os.platform() === 'linux') {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.toLowerCase().includes('cloudflared');
    } else {
      const stdout = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return stdout.toLowerCase().includes('cloudflared');
    }
  } catch {
    return false;
  }
}

// The recorded PID still belongs to the cloudflared process we spawned (not a
// recycled PID of something unrelated).
function sameCloudflaredProcess(entry) {
  if (!isValidPID(entry.pid) || !isCloudflaredProcess(entry.pid)) return false;
  if (entry.startKey) {
    const now = processStartKey(entry.pid);
    if (now && now !== entry.startKey) return false; // PID was recycled
  }
  return true;
}

// An entry is alive if its child process is still running, or (after a restart
// reloaded from disk, where `proc` is gone) if its PID still checks out.
function tunnelProcessAlive(entry) {
  if (entry.proc && !entry.exited) return true;
  return sameCloudflaredProcess(entry);
}

function saveTunnels() {
  const arr = Array.from(tunnels.entries()).map(([id, t]) => ({
    id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, pid: t.pid, startKey: t.startKey || null,
    dead: !!t.dead, restartAttempts: ((tunnelRestarts.get(id) || {}).attempts) || 0
  }));
  try {
    const tmp = TUNNEL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, TUNNEL_FILE);
  } catch {}
  updateTunnelUrlFile();
}

function updateTunnelUrlFile() {
  const active = Array.from(tunnels.values()).map(t => t.tunnelUrl).filter(Boolean);
  try {
    const content = active.length > 0 ? active.join('\n') + '\n' : '';
    const tmp = TUNNEL_URL_FILE + '.tmp';
    // 0600 like its siblings (.tunnels.json/.env/.cmdhist.json) — it used to
    // be written world-readable.
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, TUNNEL_URL_FILE);
  } catch {}
}

function loadTunnels() {
  try {
    const arr = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8'));
    let dropped = 0;
    for (const t of arr) {
      const entry = { proc: null, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, pid: t.pid, startKey: t.startKey || null, dead: !!t.dead };
      if (tunnelProcessAlive(entry)) {
        tunnels.set(t.id, entry);
        if (Number.isInteger(t.restartAttempts) && t.restartAttempts > 0) {
          tunnelRestarts.set(t.id, { attempts: t.restartAttempts, nextAt: Date.now() + tunnelBackoffMs(t.restartAttempts) });
        }
      } else if (t.dead) {
        // Preserve gave-up entries so the give-up isn't retried 5 more times
        // per boot forever; the sweep skips dead entries.
        tunnels.set(t.id, entry);
      } else {
        dropped++;
      }
    }
    // Rewrite after filtering so .tunnels.json stops accumulating corpses.
    if (dropped) { try { saveTunnels(); } catch {} }
  } catch {}
}

async function verifyTunnelUrl(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const res = await fetch(url, { method: 'HEAD', signal: ac.signal, redirect: 'manual' });
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

// In-flight sweep restarts (single-flight per localUrl): the sweep path used
// to spawn a replacement with no timeout and no dedup — a hanging cloudflared
// leaked a process per backoff tick and concurrent ticks stacked multiples.
const restartInFlight = new Map(); // localUrl -> proc
function restartTunnel(id, entry, onSuccess) {
  if (!entry.localUrl) return;
  const url = entry.localUrl;
  if (restartInFlight.has(url)) return; // sweep already starting one for this target
  try { if (entry.proc) entry.proc.kill('SIGTERM'); } catch {}
  try { if (sameCloudflaredProcess(entry)) killPid(entry.pid); } catch {}
  // The old id stays mapped until the replacement URL arrives (or the spawn
  // fails and the sweep retries later). Deleting it up front orphaned the
  // settings row: Stop then 404'd and a dead entry could never be removed.

  let proc;
  try {
    proc = spawnCloudflared(['tunnel', '--url', url], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    return;
  }
  proc.unref();
  restartInFlight.set(url, proc);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    if (restartInFlight.get(url) === proc) restartInFlight.delete(url);
  };
  // Like POST /api/tunnel's 15s race: kill the child if no URL ever arrives.
  const killTimer = setTimeout(() => {
    if (settled) return;
    try { proc.stdout.removeAllListeners('data'); } catch {}
    try { proc.stderr.removeAllListeners('data'); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
    try { if (proc.pid) killPid(proc.pid); } catch {}
    settle();
  }, 20000);
  if (killTimer.unref) killTimer.unref();

  const handler = data => {
    const text = data.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      const newUrl = m[0];
      const newId = newUrl.replace(/^https:\/\//, '').replace(/\.trycloudflare\.com$/, '');
      settle();
      proc.stdout.removeAllListeners('data');
      proc.stderr.removeAllListeners('data');
      proc.stdout.resume();
      proc.stderr.resume();
      // Stopped while the replacement was starting: honor the stop — kill
      // the newcomer instead of resurrecting a tunnel the user just removed.
      // (Also settles double-restart races: only the first URL wins.)
      if (tunnels.get(id) !== entry) {
        try { proc.kill('SIGTERM'); } catch {}
        try { if (proc.pid) killPid(proc.pid); } catch {}
        return;
      }
      const fresh = { proc, pid: proc.pid, localUrl: url, tunnelUrl: newUrl, createdAt: Date.now(), startKey: processStartKey(proc.pid) };
      proc.on('exit', () => { fresh.exited = true; });
      tunnels.delete(id);
      tunnels.set(newId, fresh);
      saveTunnels();
      updateTunnelUrlFile();
      console.log(`  Tunnel restarted: ${newUrl} → ${url}`);
      if (typeof onSuccess === 'function') { try { onSuccess(); } catch {} }
    }
  };
  proc.stdout.on('data', handler);
  proc.stderr.on('data', handler);
  proc.on('error', () => { settle(); });
  proc.on('exit', () => { proc.stdout.removeAllListeners('data'); proc.stderr.removeAllListeners('data'); settle(); });
}

const TUNNEL_CHECK_INTERVAL = 30000;
const TUNNEL_MAX_RESTARTS = 5;
const TUNNEL_MAX_BACKOFF = 5 * 60 * 1000;
// id → { attempts, nextAt }. Without this a dead tunnel retried every 30s
// forever (hot loop against a failing cloudflared / DNS outage).
const tunnelRestarts = new Map();

function tunnelBackoffMs(attempts) {
  return Math.min(TUNNEL_CHECK_INTERVAL * Math.pow(2, Math.max(0, attempts - 1)), TUNNEL_MAX_BACKOFF);
}

const tunnelSweep = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of tunnels) {
    if (tunnelProcessAlive(entry)) {
      if (tunnelRestarts.has(id)) tunnelRestarts.delete(id);
      if (entry.dead) entry.dead = false;
      continue;
    }
    if (entry.dead) continue; // gave up already — no log spam
    const st = tunnelRestarts.get(id) || { attempts: 0, nextAt: 0 };
    if (now < st.nextAt) continue;
    if (st.attempts >= TUNNEL_MAX_RESTARTS) {
      entry.dead = true;
      console.log(`  Tunnel ${id} dead — giving up after ${st.attempts} restart attempts`);
      try { saveTunnels(); } catch {}
      continue;
    }
    st.attempts += 1;
    st.nextAt = now + tunnelBackoffMs(st.attempts);
    tunnelRestarts.set(id, st);
    console.log(`  Tunnel ${id} dead — restart attempt ${st.attempts}/${TUNNEL_MAX_RESTARTS} (next retry in ${Math.round(tunnelBackoffMs(st.attempts) / 1000)}s)…`);
    restartTunnel(id, entry, () => { tunnelRestarts.delete(id); });
  }
}, TUNNEL_CHECK_INTERVAL).unref();

app.get('/api/tunnel', checkPin, async (req, res) => {
  const entries = Array.from(tunnels.entries());
  const results = await Promise.allSettled(entries.map(async ([id, t]) => {
    const alive = tunnelProcessAlive(t);
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
    const rst = tunnelRestarts.get(id);
    return { id, localUrl: t.localUrl, tunnelUrl: t.tunnelUrl, createdAt: t.createdAt, alive, targetAlive, tunnelAlive,
      dead: !!t.dead, restartAttempts: (rst && rst.attempts) || 0 };
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
    if (u.username || u.password) return res.status(400).json({ error: 'url must not contain credentials' });
    const rawHost = u.hostname.toLowerCase();
    // Normalize bracketed IPv6 (new URL keeps '[::1]' incl. brackets, so the
    // allow/block lists below never matched IPv6 literals — normalize once).
    const host = rawHost.replace(/^\[|\]$/g, '');
    // Metadata/link-local endpoints beyond the obvious one (all unbracketed —
    // matching happens against the normalized host).
    const blockedHosts = ['169.254.169.254', 'metadata.google.internal', 'instance-data',
      'metadata.google.internal.', '100.100.100.200', '192.0.0.192', 'fd00:ec2::254'];
    if (blockedHosts.includes(host) || isBlockedTunnelIp(host)) return res.status(400).json({ error: 'url host blocked (SSRF)' });
    // A hostname string can hide a metadata address (evil.com → 169.254.169.254),
    // so resolve it too — EVERY address, not just the first (multi-record
    // hostnames). Non-canonical IP literals (2130706433, 0x7f.0.0.1,
    // ::ffff:169.254.169.254) are canonicalized through the resolver as well.
    // Unresolvable plain names (mDNS/LAN hosts) are still allowed — this is a
    // metadata/link-local block, not a resolver — but an unresolvable
    // IP-looking literal is denied (fail closed: it can't be proven safe).
    const ipLike = /^[0-9a-f.:x]+$/i.test(host) && /[0-9]/.test(host);
    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      for (const a of addrs || []) {
        if (isBlockedTunnelIp(a.address)) return res.status(400).json({ error: 'url host resolves to a blocked address (SSRF)' });
      }
    } catch {
      if (ipLike) return res.status(400).json({ error: 'url host could not be verified (SSRF)' });
    }
    if (host === '0.0.0.0' || host === '::') return res.status(400).json({ error: 'url host is not connectable' });
    const allowed = ['localhost', '127.0.0.1', '::1'];
    // Allow only local URLs unless ALLOW_FULL_FS true (admin opt-in for LAN tunneling)
    if (!ALLOW_FULL_FS && !allowed.includes(host)) {
      return res.status(400).json({ error: 'url must be localhost (use ALLOW_FULL_FS=true to allow LAN)' });
    }
    if (u.port && (Number(u.port) < 1 || Number(u.port) > 65535)) return res.status(400).json({ error: 'invalid port' });
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  // cloudflared is fetched on demand (first explicit tunnel request), never at
  // install time. Kick off a single-flight background download and tell the
  // client to retry — the 30s api() cap can't cover a binary download.
  if (!findCloudflared()) {
    ensureCloudflared(msg => console.log('  ' + msg)).catch(e => {
      console.log('  cloudflared on-demand install failed: ' + e.message);
    });
    return res.status(503).json({ error: 'Downloading cloudflared (one-time setup)… please retry in a few seconds.', downloading: true });
  }

  let proc;
  try {
    proc = spawnCloudflared(['tunnel', '--url', url], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    return sendErr(res, e, 500);
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
    const fresh = { proc, pid: proc.pid, localUrl: url, tunnelUrl, createdAt: Date.now(), startKey: processStartKey(proc.pid) };
    proc.on('exit', () => { fresh.exited = true; });
    tunnels.set(id, fresh);
    tunnelRestarts.delete(id);
    saveTunnels();
    res.json({ success: true, id, url: tunnelUrl, verified: urlOk });
  } catch (e) {
    try { if (proc.pid) killPid(proc.pid); else proc.kill(); } catch {}
    sendErr(res, e && e.message === 'timeout'
      ? Object.assign(new Error('Timed out waiting for tunnel URL'), { status: 500 })
      : e, 500);
  }
});

app.delete('/api/tunnel', checkPin, (req, res) => {
  // Accept id from body or query (DELETE body may be stripped by proxies)
  const raw = (req.body && req.body.id) || req.query.id;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  // Idempotent: the entry may already be gone (failed auto-restart drops the
  // id, a sibling tab stopped it first). Deleting nothing is still success —
  // otherwise the settings row can never be removed.
  if (!tunnels.has(id)) return res.json({ success: true, alreadyGone: true });
  const entry = tunnels.get(id);
  try {
    if (entry.proc) {
      try { entry.proc.kill('SIGTERM'); } catch {}
      if (entry.proc.pid) killPid(entry.proc.pid);
    } else if (sameCloudflaredProcess(entry)) {
      killPid(entry.pid);
    }
  } catch {}
  tunnels.delete(id);
  tunnelRestarts.delete(id);
  saveTunnels();
  res.json({ success: true });
});

// ── App preview (loopback reverse-proxy) ─────────────────────────────
// Renders `localhost:PORT` apps inside a WebTun tab via same-origin iframe:
//   iframe src=/api/preview/5173/?token=… → http.request 127.0.0.1:5173/
// Loopback only (no DNS → no SSRF/rebind). Authed like everything else.
const PREVIEW_COOKIE = 'wt-preview';
const previewAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
function parsePreviewCookie(req) {
  try {
    const h = req.headers && req.headers.cookie;
    if (!h || typeof h !== 'string') return '';
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i === -1) continue;
      if (part.slice(0, i).trim() === PREVIEW_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
  } catch {}
  return '';
}
// Same gates as checkPin (query/header/cookie only differ as transport —
// subresources inside the iframe can't send ?token= on every fetch, hence
// the short-lived preview cookie). In particular the raw PIN is trusted
// remotely only when nobody else is signed in (loopback always trusted);
// the old blanket bypass let a leaked PIN drive the proxy from anywhere.
function checkPreviewAuth(req, res, next) {
  if (!PIN) return next();
  const raw = req.headers['x-pin-token'] || (req.query && req.query.token) || parsePreviewCookie(req);
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (constantTimeEqual(token, PIN)) {
    if (!rawPinAllowed(req)) {
      return res.status(403).json({ error: 'Approval required — sign in from the app so an existing session can approve this device', approvalRequired: true });
    }
    req.authToken = token; req.authSession = null; return next();
  }
  const s = getSession(token);
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  if (s.status !== 'active') return res.status(403).json({ error: 'Session awaiting approval from another device', pending: true });
  req.authToken = token; req.authSession = s; return next();
}
// Ports the preview proxy may dial. By default any port 1–65535, WebTun's own
// included: connecting needs no privilege, the dial is always 127.0.0.1, and the caller
// is already authenticated. Set PREVIEW_PORTS=5173,8080 to restrict it when an
// instance is shared and you don't want the proxy usable as a loopback scanner.
const PREVIEW_PORTS = (() => {
  const raw = String(process.env.PREVIEW_PORTS || '').trim();
  if (!raw) return null;
  const set = new Set();
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535) set.add(n);
  }
  return set.size ? set : null;
})();
function validPreviewPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return false;
  if (PREVIEW_PORTS && !PREVIEW_PORTS.has(n)) return false;
  return true;
}
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
// Why this port was refused before any dial (caller-visible config, not a
// loopback probe signal — no listener state is revealed).
function previewPortRejectReason(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'invalid';
  if (PREVIEW_PORTS && !PREVIEW_PORTS.has(n)) return 'blocked';
  return null;
}
function previewError(res, port, msg, opts = {}) {
  const status = opts.status || 502;
  // :port comes from req.params (attacker-controlled path segment) and is
  // interpolated into HTML below — escape it first (reflected XSS).
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safePort = esc(port);
  const title = opts.title ? esc(opts.title) : `Preview :${safePort} unreachable`;
  const hint = opts.hint ? esc(opts.hint) : esc('Is the app listening on 127.0.0.1:PORT?'.replace('PORT', safePort));
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Synthetic-error marker so the tab health dot can tell "no listener"
  // apart from an upstream app's own 5xx via a body-less HEAD poll.
  res.setHeader('X-WebTun-Preview-Error', '1');
  res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;background:#1a1b26;color:#c0caf5"><h3>${title}</h3><p style="color:#787c99">${esc(msg)}. ${hint}</p><p style="color:#787c99">Check with: <code>curl -v 127.0.0.1:${safePort}/</code> (bind 127.0.0.1, not just localhost).</p><p><button onclick="location.reload()" style="padding:8px 16px;cursor:pointer">Retry</button></p></body></html>`);
}
function handlePreviewProxy(req, res) {
  const port = req.params.port;
  if (!validPreviewPort(port)) {
    const reason = previewPortRejectReason(port);
    if (reason === 'blocked') return previewError(res, port, 'Port not in PREVIEW_PORTS allow-list', { status: 400, title: `Preview :${port} unavailable`, hint: 'Ask the server admin to allow this port.' });
    return previewError(res, port, 'Port must be 1-65535', { status: 400, title: 'Preview unavailable', hint: 'Check the port number.' });
  }
  const targetPort = Number(port);
  // Strip prefix /api/preview/<port>, keep trailing path + query.
  let suffix = '';
  try {
    const u = new URL(req.originalUrl, 'http://x');
    // Plain prefix slice, not `new RegExp(...)` built from request input.
    const prefix = '/api/preview/' + targetPort;
    suffix = (u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname) || '/';
    suffix += u.search || '';
  } catch { suffix = '/'; }
  if (suffix.includes('\0')) return res.status(400).json({ error: 'bad path' });
  // Strip only OUR bearer from the upstream query: a ?token= value that is a
  // live credential (the PIN or a known session token) is ours — it already
  // completed auth above, and the dev app's logs would harvest it. Anything
  // else belongs to the upstream app itself (Jupyter-style ?token= logins)
  // and passes through; deleting it breaks the app, typically as an endless
  // login redirect loop ("too many redirects"). Note the values must be
  // classified individually: Express merges ?token=A&token=B into one array,
  // so "the query token" can't tell ours from foreign.
  try {
    const qm = suffix.indexOf('?');
    if (qm !== -1) {
      const params = new URLSearchParams(suffix.slice(qm + 1));
      const vals = params.getAll('token');
      if (vals.length) {
        const foreign = vals.filter(v => !v || (!constantTimeEqual(v, PIN) && !getSession(v)));
        if (foreign.length !== vals.length) {
          params.delete('token');
          for (const v of foreign) params.append('token', v);
          const rest = params.toString();
          suffix = suffix.slice(0, qm) + (rest ? '?' + rest : '');
        }
      }
    }
  } catch {}
  // Mint preview cookie on first authed hit so subresources pass auth.
  // Port-scoped path (one port's cookie never authenticates another),
  // Secure when the request arrived over TLS, 12h cap on a stolen-URL window.
  try {
    const q = (req.query && req.query.token) || req.headers['x-pin-token'];
    const trustProxyCookie = process.env.TRUST_PROXY === 'true';
    const secure = (req.secure || (trustProxyCookie && req.headers['x-forwarded-proto'] === 'https')) ? '; Secure' : '';
    if (PIN && typeof q === 'string' && q.trim() && !parsePreviewCookie(req)) {
      res.setHeader('Set-Cookie', `${PREVIEW_COOKIE}=${encodeURIComponent(q.trim())}; Path=/api/preview/${targetPort}/; Max-Age=43200; HttpOnly; SameSite=Lax${secure}`);
    } else if (!PIN && !parsePreviewCookie(req)) {
      res.setHeader('Set-Cookie', `${PREVIEW_COOKIE}=open; Path=/api/preview/${targetPort}/; Max-Age=43200; HttpOnly; SameSite=Lax${secure}`);
    }
  } catch {}
  const fwd = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_HEADERS.has(lk) || lk === 'host' || lk === 'x-pin-token' || lk === 'cookie') continue;
    // A loopback dev server is untrusted code: never hand it our credentials.
    if (lk === 'authorization' || lk === 'proxy-authorization') continue;
    if (lk.startsWith('x-') && /token|auth|secret|pin|session/i.test(lk)) continue;
    fwd[k] = v;
  }
  fwd['Host'] = `localhost:${targetPort}`;
  // Only page navigations (Accept: text/html) force identity encoding so the
  // <base> + nav-report injection below sees plain bytes. Every other asset
  // (JS/CSS/img/XHR) keeps the client's gzip/br and streams through untouched.
  try {
    const acc = String((req.headers && req.headers.accept) || '');
    if (req.method === 'GET' && acc.includes('text/html')) fwd['Accept-Encoding'] = 'identity';
  } catch {}
  fwd['Referrer-Policy'] = 'no-referrer';
  // Forward browser cookies except our preview token (never leak it upstream).
  try {
    const h = req.headers.cookie;
    if (h && typeof h === 'string') {
      const kept = h.split(';').filter(p => p.slice(0, p.indexOf('=')).trim() !== PREVIEW_COOKIE).join(';').trim();
      if (kept) fwd['Cookie'] = kept;
    }
  } catch {}
  let upReq;
  let upResponded = false;
  try {
    // Dial 127.0.0.1 (not 'localhost'): dev servers usually bind IPv4-only and
    // 'localhost' often resolves to ::1 first → refused. Loopback either way.
    // 30s first-byte budget: slow Vite/Next cold starts exceed the old 10s.
    upReq = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: suffix, headers: fwd, timeout: 30000, agent: previewAgent }, upRes => {
      upResponded = true;
      // Upstream answered — idle timeout no longer applies. Long-lived SSE /
      // log-tail / token streams must not be killed after 10s of quiet.
      try { upReq.setTimeout(0); } catch {}
      // Same-origin framing: override global DENY, strip upstream framers only.
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.statusCode = upRes.statusCode || 502;
      for (const [k, v] of Object.entries(upRes.headers)) {
        const lk = k.toLowerCase();
        if (HOP_HEADERS.has(lk) || lk === 'x-frame-options' || lk === 'content-security-policy' || lk === 'content-security-policy-report-only') continue;
        if (lk === 'location' && typeof v === 'string') {
          // /x → /api/preview/<port>/x ; absolute loopback-alias → same.
          // Aliases other than localhost/127.0.0.1 (0.0.0.0, [::1], [::]) were
          // left untouched before, and any other absolute URL passed straight
          // through — an upstream 302 to an external host turned the authed
          // proxy into an open redirect. Anything still absolute goes to the
          // preview root instead.
          let nv = v.replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?(\/.*)?$/i, (m, pth) => `/api/preview/${targetPort}${pth || '/'}`);
          if (/^https?:\/\//i.test(nv)) nv = `/api/preview/${targetPort}/`;
          if (nv.startsWith('/') && !nv.startsWith(`/api/preview/${targetPort}`)) nv = `/api/preview/${targetPort}${nv}`;
          try { res.setHeader(k, nv); } catch {}
          continue;
        }
        if (lk === 'set-cookie') {
          const arr = Array.isArray(v) ? v : [v];
          const out = arr.map(c => String(c).replace(/;\s*Path=[^;]*/i, `; Path=/api/preview/${targetPort}/`));
          try { res.setHeader(k, out); } catch {}
          continue;
        }
        try { res.setHeader(k, v); } catch {}
      }
      // Never let upstream JS run in the WebTun origin. `sandbox` without
      // allow-same-origin forces an opaque origin, so a proxied dev app cannot
      // read wt-session-token / localStorage / the files API — including when
      // /api/preview/<port>/ is opened as a top-level page. The upstream CSP is
      // deliberately NOT merged: replaying it could re-permit same-origin
      // scripts and undo the sandbox. Mirrors the in-app iframe sandbox flags
      // (allow-scripts allow-forms allow-popups allow-downloads allow-modals).
      try {
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals; frame-ancestors 'self'");
      } catch {}
      const ctype = (upRes.headers['content-type'] || '').toString().toLowerCase();
      const cenc = (upRes.headers['content-encoding'] || '').toString().toLowerCase();
      const canInject = !/gzip|br|deflate|zstd/.test(cenc);
      if (ctype.includes('text/html') && req.method === 'GET' && canInject) {
        // Bounded <head> scan: inject <base> so relative URLs resolve through
        // the proxy, plus a tiny nav reporter so the tab address bar follows
        // in-iframe navigation (opaque origin — postMessage only, no DOM access).
        // Then stream the body — huge pages no longer buffer fully
        // (or lose the injection past the old 2MB cliff). Byte-level surgery
        // with a latin1 needle (ASCII-safe) so multibyte text is never mangled.
        const HEAD_MAX = 512 * 1024;
        const baseTag = Buffer.from(`<base href="/api/preview/${targetPort}/">`, 'latin1');
        const navTag = Buffer.from(`<script>try{(function(){var s=function(){try{parent.postMessage({wtPreviewNav:location.pathname+location.search},'*')}catch(e){}};try{s()}catch(e){}try{addEventListener('popstate',s)}catch(e){}try{['pushState','replaceState'].forEach(function(k){try{var o=history[k];history[k]=function(){try{return o.apply(this,arguments)}finally{try{s()}catch(e){}}}}catch(e){})}catch(e){}try{setTimeout(s,800)}catch(e){}})()}catch(e){}</script>`, 'latin1');
        let buf = [], bytes = 0, headSent = false;
        const sendHead = (raw) => {
          headSent = true;
          let out = raw;
          try {
            const s = raw.toString('latin1');
            if (!/<base[\s>]/i.test(s)) {
              const m = /<head[^>]*>/i.exec(s);
              if (m) {
                const at = m.index + m[0].length;
                out = Buffer.concat([raw.subarray(0, at), baseTag, navTag, raw.subarray(at)]);
              }
            }
          } catch {}
          try { res.removeHeader('Content-Length'); } catch {}
          try { res.write(out); } catch {}
        };
        upRes.on('data', c => {
          if (headSent) { try { res.write(c); } catch {} return; }
          buf.push(c); bytes += c.length;
          if (bytes > HEAD_MAX) { const all = Buffer.concat(buf); buf = []; sendHead(all); return; }
          const joined = Buffer.concat(buf);
          if (/<\/head\s*>/i.test(joined.toString('latin1'))) { buf = []; sendHead(joined); }
        });
        upRes.on('end', () => {
          try {
            if (!headSent) sendHead(Buffer.concat(buf));
            buf = [];
          } catch {}
          try { res.end(); } catch {}
        });
        upRes.on('error', () => { try { res.end(); } catch {} });
      } else {
        upRes.pipe(res);
      }
    });
  } catch (e) { return previewError(res, targetPort, 'proxy error'); }
  // Timeout before any response = slow app / cold start; socket error =
  // nothing listening. Messages stay generic (no refused-vs-timeout oracle
  // beyond timing), but the timeout hint names the cold-start case.
  upReq.on('timeout', () => { try { upReq.destroy(); } catch {} if (!res.headersSent) previewError(res, targetPort, upResponded ? 'upstream went quiet' : 'no application is answering there (slow cold start?)'); else try { res.end(); } catch {} });
  upReq.on('error', () => { if (!res.headersSent) previewError(res, targetPort, 'no application is answering there'); else try { res.end(); } catch {} });
  req.pipe(upReq);
}
// NOTE: no rateLimiter here on purpose — one app load fans out to dozens of
// asset requests and would 429 constantly. Auth (PIN/session) + loopback-only
// target is the real gate; brute force still throttled at the auth endpoints.
app.all('/api/preview/:port', checkPreviewAuth, handlePreviewProxy);
app.all('/api/preview/:port/{*splat}', checkPreviewAuth, handlePreviewProxy);

// Loopback listeners for the preview address-bar autocomplete (best-effort).
app.get('/api/ports', checkPin, (req, res) => {
  const found = new Map();
  const add = (addr, port, proc) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return;
    if (addr && addr !== '127.0.0.1' && addr !== '::1' && addr !== '0.0.0.0' && addr !== '::') return;
    if (!found.has(p)) found.set(p, { port: p, loopback: true });
    if (proc && !found.get(p).proc) found.get(p).proc = String(proc).slice(0, 64);
  };
  try {
    let out = '';
    if (os.platform() === 'win32') {
      out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 5000 }).toString();
      for (const line of out.split('\n')) {
        const m = line.match(/TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i) || line.match(/TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING/i);
        if (m) add(m[1], m[2], m[3] ? 'pid ' + m[3] : null);
      }
    } else {
      try {
        // -p surfaces users:(("node",pid=123,fd=..)) so the picker can name the owner.
        out = execSync('ss -tlnp', { encoding: 'utf8', timeout: 5000 }).toString();
        for (const line of out.split('\n')) {
          if (!/LISTEN/i.test(line)) continue;
          const m = line.match(/(?:127\.0\.0\.1|::1|0\.0\.0\.0|\*):(\d+)/);
          if (!m) continue;
          const pm = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
          add('127.0.0.1', m[1], pm ? `${pm[1]}:${pm[2]}` : null);
        }
      } catch {
        out = execSync('ss -tln', { encoding: 'utf8', timeout: 5000 }).toString();
        for (const line of out.split('\n')) {
          const m = line.match(/(?:127\.0\.0\.1|::1|0\.0\.0\.0|\*):(\d+)/);
          if (m && /LISTEN/i.test(line)) add('127.0.0.1', m[1]);
        }
      }
      if (found.size === 0) {
        try {
          out = execSync('netstat -an -p tcp', { encoding: 'utf8', timeout: 5000 }).toString();
          for (const line of out.split('\n')) {
            const m = line.match(/(127\.0\.0\.1|0\.0\.0\.0)\.(\d+).*LISTEN/i) || line.match(/tcp\d?\s+\S+\s+(\S+)[.:](\d+).*LISTEN/i);
            if (m) add(m[1] && m[1].includes('.') ? m[1] : '127.0.0.1', m[2]);
          }
        } catch {}
      }
    }
  } catch {}
  res.json({ ports: Array.from(found.values()).sort((a, b) => a.port - b.port).slice(0, 100) });
});

// WS proxy for HMR/live-reload: /api/preview/:port/<path> upgrade → ws://127.0.0.1:port/<path>
const previewWSS = new WebSocket.Server({ noServer: true });
function previewUpgradeAuth(req, params) {
  if (!PIN) return true;
  const t = typeof params.get('token') === 'string' ? params.get('token').trim() : parsePreviewCookie(req);
  if (!t) return false;
  if (constantTimeEqual(t, PIN)) {
    // Same gate as HTTP preview (checkPreviewAuth) and terminal WS: a remote
    // raw PIN is trusted only when nobody else is signed in (loopback always
    // trusted). Session tokens remain the normal path for iframe WS.
    return rawPinAllowed({ socket: req.socket, headers: req.headers, get ip() { return req.socket.remoteAddress; } });
  }
  const s = getSession(t);
  return !!(s && s.status === 'active');
}
// Single upgrade dispatcher (wss is noServer so the terminal /ws handler
// doesn't 400 preview upgrades — ws rejects non-matching paths first).
server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { try { socket.destroy(); } catch {} return; }
  if (u.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    return;
  }
  const m = u.pathname.match(/^\/api\/preview\/(\d+)(\/.*)?$/);
  if (!m) { try { socket.destroy(); } catch {} return; }
  const targetPort = Number(m[1]);
  if (!validPreviewPort(targetPort)) { try { socket.destroy(); } catch {} return; }
  if (!previewUpgradeAuth(req, u.searchParams)) { try { socket.destroy(); } catch {} return; }
  const targetPath = (m[2] || '/') + (u.search || '');
  previewWSS.handleUpgrade(req, socket, head, clientWs => {
    // Attribute the credential so PIN rotation / session revoke (wsAuthSweep,
    // closeInvalidSockets, pushSessionRevoked) can reap preview sockets too.
    try {
      const qt = u.searchParams.get('token');
      clientWs._authToken = (typeof qt === 'string' && qt) ? qt.trim() : parsePreviewCookie(req);
    } catch {}
    let upstream;
    try {
      const proto = req.headers['sec-websocket-protocol'];
      upstream = new WebSocket(`ws://127.0.0.1:${targetPort}${targetPath}`, proto || undefined);
    } catch { try { clientWs.close(1011, 'bad target'); } catch {} return; }
    const closeBoth = (code, reason) => {
      try { clientWs.close(code || 1000, reason || ''); } catch {}
      try { upstream.close(code || 1000, reason || ''); } catch {}
    };
    upstream.on('open', () => {
      clientWs.on('message', d => { try { if (upstream.readyState === WebSocket.OPEN) upstream.send(d); } catch {} });
      upstream.on('message', d => { try { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(d); } catch {} });
    });
    upstream.on('close', (c, r) => { try { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(c, r); } catch {} });
    upstream.on('error', () => { try { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error'); } catch {} });
    clientWs.on('close', () => { try { upstream.close(); } catch {} });
    clientWs.on('error', () => { try { upstream.close(); } catch {} });
    // If upstream never opens, don't hang forever.
    setTimeout(() => {
      try { if (upstream.readyState === WebSocket.CONNECTING) { upstream.terminate(); if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream timeout'); } } catch {}
    }, 10000).unref?.();
  });
});

// ─────────────────────────────────────────────────────────────────────

function cleanup() {
  for (const [id, entry] of tunnels) {
    try {
      if (entry.proc) {
        try { entry.proc.kill('SIGTERM'); } catch {}
        if (entry.proc.pid) killPid(entry.proc.pid);
      } else if (sameCloudflaredProcess(entry)) {
        killPid(entry.pid);
      }
    } catch {}
  }
  if (TMUX) {
    try {
      const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' , timeout: 5000}).trim();
      // Only OUR namespaced sessions: the previous `|| startsWith('wt-')`
      // killed the user's own `wt-*` tmux sessions on every SIGTERM.
      // Same rule one level down: never a sibling server's port-namespace.
      // Sessions this process created die unconditionally; anything else is
      // only reaped when no live sibling owns the namespace (clientless
      // legacy orphans) — a live sibling's sessions, and any session with
      // attached clients that we did not create, are always spared.
      for (const s of out.split('\n')) {
        const k = tmuxKind(s);
        if (k === null || k === 'foreign') continue;
        if (ownTmuxSessions.has(s)) {
          try { execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore' , timeout: 5000}); } catch {}
        } else if (tmuxSweepsArmed && k === 'legacy' && !tmuxHasClients(s)) {
          try { execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore' , timeout: 5000}); } catch {}
        }
      }
    } catch {}
  }
  releaseTmuxClaim();
  // Kill all in-memory PTY sessions
  for (const [id, entry] of ptySessions) {
    try { entry.proc.kill(); } catch {}
  }
  ptySessions.clear();
}

function startServer(opts = {}) {
  const port = opts.port || PORT;
  const host = opts.host || HOST;

  migrateLegacyState();
  if (!_historyLoaded) { _historyLoaded = true; loadCmdHistory(); }
  loadTunnels();
  // NOTE: no orphan sweep here — it runs after the port binds (below), so a
  // process that cannot bind never destroys another instance's sessions.

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`\n  WebTun running → http://localhost:${port}`);
      if (PIN) console.log(`  PIN protection enabled`);
      console.log('');
      const prior = readTmuxClaim();
      if (prior && prior.pid !== process.pid && tmuxClaimLive(prior)) {
        tmuxSweepsArmed = false;
        console.log(`  tmux namespace owned by live PID ${prior.pid} — orphan sweeps disabled`);
      } else {
        writeTmuxClaim();
        cleanupOrphanTmuxSessions();
      }
      resolve(server);
    });
  });
}

process.on('uncaughtException', e => {
  console.error('Uncaught:', e.message);
  try { cleanup(); } catch {}
  process.exit(1);
});
// Symmetric with uncaughtException above: Node's own default for an unhandled
// rejection is to throw (and crash), so swallowing it here silently left the
// process running in an undefined state — the opposite of the uncaught path.
process.on('unhandledRejection', e => {
  console.error('Unhandled rejection:', (e && e.stack) || e);
  try { cleanup(); } catch {}
  process.exit(1);
});

process.on('SIGTERM', () => { try { cleanup(); } catch {}; process.exit(0); });
process.on('SIGINT', () => { try { cleanup(); } catch {}; process.exit(0); });
// Closing the terminal sends SIGHUP, not SIGINT — without this, shut terminals
// skipped cleanup entirely and orphaned tunnels/tmux sessions (which is how
// duplicate cloudflared processes accumulate for the same backend port).
process.on('SIGHUP', () => { try { cleanup(); } catch {}; process.exit(0); });
process.on('exit', () => { try { cleanup(); } catch {} });

module.exports = { app, server, startServer, PORT, WORKSPACE_ROOT, findCloudflared,
  tmuxKind, tmuxClaimPath, readTmuxClaim, writeTmuxClaim, releaseTmuxClaim, tmuxClaimLive };
// PIN is mutable at runtime (POST /api/pin). Exporting it by value handed
// consumers a snapshot, so embedders kept seeing the secret from boot time.
Object.defineProperty(module.exports, 'PIN', { get: () => PIN, enumerable: true });

if (require.main === module) {
  startServer();
}

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
  try {
    pty = require('./lib/pty-fallback');
    console.log('  Using fallback pseudo-terminal (node-pty native module not found)');
  } catch (fallbackErr) {
    console.error('Failed to load pty fallback:', fallbackErr);
    process.exit(1);
  }
}
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');
const { execSync, execFileSync, execFile } = require('child_process');
const { resolveShell, spawnRead } = require('./lib/server/process');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const { mimeLookup } = require('./lib/server/file-types');

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
    if (opts.skipWhenNoPin && !auth.pin) return next();
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
// script-src keeps 'unsafe-inline' for the standalone docs and billing pages.
// App controls use named actions registered by each feature script.
// It still restricts script origins to self + jsDelivr + blob:, which
// previously was not enforced for the app shell at all.
// connect-src carries jsDelivr because the service worker proxies lazy CDN
// viewer loads (pdf.js, JSZip, mammoth, xlsx) through fetch(), which
// connect-src governs — without it the SW fell back to its 503 "Offline"
// response and every document viewer broke. style-src carries
// fonts.googleapis.com for the same reason one level up: the Google Fonts
// stylesheet index.html:24 links is style-src governed, and font-src alone
// (already listing gstatic) never let the sheet through, so the whole app
// silently rendered in fallback fonts.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https://cdn.jsdelivr.net https://*.trycloudflare.com wss: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net blob:; style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com; img-src 'self' data: blob:; frame-src 'self' blob:; child-src 'self' blob:; worker-src 'self' blob: https://cdn.jsdelivr.net; frame-ancestors *;");
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
// Stripe billing webhook needs the raw body for signature checks, so it is
// registered before the JSON parser below (which would consume it).
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  billingWebhookHandler(req, res).catch(e => { try { sendErr(res, e, 500); } catch { try { res.status(500).end(); } catch {} } });
});
const LARGE_JSON_ROUTES = new Set(['/api/files/write']);
app.use((req, res, next) => {
  // Trailing-slash tolerant: /api/files/write/ gets the large budget too.
  const p = typeof req.path === 'string' ? req.path.replace(/\/+$/, '') || '/' : req.path;
  // The proxy must see the original stream, not a globally parsed JSON body.
  if (/^\/api\/preview\/[^/]+(?:\/|$)/.test(p) || (!p.startsWith('/api/') && /\/api\/preview\/\d+\//.test(String(req.headers.referer || '')))) return next();
  const limit = LARGE_JSON_ROUTES.has(p) ? JSON_LIMIT_LARGE : JSON_LIMIT_BASE;
  return express.json({ limit })(req, res, next);
});
// Optional gzip compression for text responses (built-in zlib; no extra deps).
app.use((req, res, next) => {
  const ae = req.headers['accept-encoding'] || '';
  if (!/\\bgzip\\b/.test(ae)) return next();
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let decided = false;
  let compress = false;
  let gzip = null;
  function decide() {
    if (decided) return;
    decided = true;
    const ct = String(res.getHeader('Content-Type') || '');
    compress = /text|json|javascript|css|xml|svg|html|font|csv/.test(ct);
    if (compress) {
      res.setHeader('Content-Encoding', 'gzip');
      try { res.append('Vary', 'Accept-Encoding'); } catch {}
      res.removeHeader('Content-Length');
      gzip = zlib.createGzip();
      gzip.on('data', (c) => { try { origWrite(c); } catch {} });
    }
  }
  res.write = function (chunk, encoding, cb) {
    decide();
    if (!compress) return origWrite(chunk, encoding, cb);
    if (chunk) gzip.write(chunk, encoding);
    if (cb) process.nextTick(cb, true);
    return true;
  };
  res.end = function (chunk, encoding, cb) {
    decide();
    if (!compress) return origEnd(chunk, encoding, cb);
    const finish = () => { try { origEnd(); } catch {} if (cb) try { cb(); } catch {} };
    if (chunk) gzip.write(chunk, encoding);
    gzip.end();
    gzip.on('end', finish);
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// In-app user guide — single static page (public/docs.html, also published to GitHub Pages),
// served like index.html, reachable at /docs.
// `dotfiles: 'allow'` is required: sendFile() rejects (404) any absolute path
// with a dot-prefixed segment, so an install living under a dot-directory
// (a dot-prefixed $XDG_DATA_HOME, a checkout inside a dot-folder) served /docs
// as Not Found while /docs.html still worked. Surfaces the real error instead
// of leaving the response hanging.
app.get('/docs', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'), { dotfiles: 'allow' }, err => {
    if (err) next(err);
  });
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
// License cache loads here (reads DATA_DIR/license.json when present).
// Caps stay dormant until WEBTUN_LICENSE_PUBLIC_KEY is set.
// One-time migration: carry state forward from the legacy __dirname location.
// Deliberately NOT run at import time — requiring this module should not copy files
// into the user's config directory. startServer() calls it, which covers both real
// entry points (this file run directly, and the CLI/Electron fork).
let _migrated = false;
function migrateLegacyState() {
  if (_migrated) return;
  _migrated = true;
  for (const _f of ['.env', '.cmdhist.json', '.tunnels.json', '.ssh-state.json', '.trusted-devices.json', 'license.json', 'pending-licenses.json', 'tunnel-url.txt', 'audit-log.json', 'library.json', 'bookmarks.json', 'policy.json']) {
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
const { createPathAccess } = require('./lib/server/paths');
const { sendErr, errText, safeErr } = require('./lib/server/errors');
const paths = createPathAccess({ workspaceRoot: WORKSPACE_ROOT, allowFullFs: ALLOW_FULL_FS });
const { resolvePath, realPath, pathContained } = paths;
const fsPromises = fs.promises;
const { createAuthService } = require('./lib/server/auth');
const auth = createAuthService({
  app, pin: process.env.PIN || '', port: PORT, envPath: ENV_PATH, dataDir: DATA_DIR, authRateLimiter,
  licenseStatus: () => licenseLib.status(),
  events: {
    broadcast: event => terminal.broadcastClientEvent(event),
    revoke: token => terminal.pushSessionRevoked(token),
    invalidate: reason => terminal.closeInvalidSockets(reason),
    audit: (action, req, details) => { try { logAudit(action, req, details); } catch {} },
  },
});
const { checkPin, requirePinSet, getSession, rawPinAllowed, isLoopbackReq, isLoopbackSocket, constantTimeEqual, describeChanger } = auth;

const { createAuditAndSyncService } = require('./lib/server/audit');
const auditSync = createAuditAndSyncService({
  app, checkPin, rateLimiter, authRateLimiter, dataDir: DATA_DIR, describeChanger,
});
const { logAudit } = auditSync;

// ── Commercial license (Pro / Team) ───────────────────────────────────
// Offline Ed25519 keys (lib/license.js, no new deps). Caps stay dormant
// until WEBTUN_LICENSE_PUBLIC_KEY is set, so current installs keep current
// behavior (6 month grandfathering). Loopback callers can always mint SSH
// keys — they already own the shell — but tunnel/device/history caps apply
// to everyone. The terminal itself is never gated.
const licenseLib = require('./lib/license');
try { licenseLib.initLicense(DATA_DIR); } catch (e) { console.warn('  License init skipped: ' + (e && e.message)); }

// Paid gate for SSH provisioning. Fail-open on internal error (current
// behavior) but fail-closed on Free: loopback keeps working for the owner.
function requirePro(req, res, next) {
  try {
    const st = licenseLib.status();
    if (!st.enforce) return next();
    if (st.plan === 'pro' || st.plan === 'team') return next();
    try { if (isLoopbackReq(req)) return next(); } catch {}
    return res.status(402).json({ error: 'SSH access needs a Pro license — paste a key in Settings → Security', upgrade: true });
  } catch { return next(); }
}

// Per-plan history ceiling. Unconfigured installs keep the legacy 500.
function historyMaxAllowed() {
  try {
    const st = licenseLib.status();
    if (!st.enforce) return 500;
    return st.limits.historyMax;
  } catch { return 500; }
}

function licenseStatusJson() {
  const st = licenseLib.status();
  const lim = st.limits || {};
  return {
    success: true,
    configured: st.configured,
    enforce: st.enforce,
    plan: st.plan,
    seats: st.seats,
    expiry: st.expiry,
    grace: st.grace,
    expired: st.expired,
    limits: {
      tunnels: lim.tunnels === Infinity ? -1 : lim.tunnels,
      devices: lim.devices,
      historyMax: lim.historyMax,
    },
  };
}

app.get('/api/license/status', checkPin, (req, res) => {
  try { res.json(licenseStatusJson()); } catch (e) { sendErr(res, e, 500); }
});

app.post('/api/license', authRateLimiter, checkPin, (req, res) => {
  try {
    const key = req.body && req.body.key;
    if (typeof key !== 'string' || !key.trim()) return res.status(400).json({ error: 'key required' });
    licenseLib.saveLicenseKey(key.trim());
    const st = licenseLib.status();
    try { logAudit('license.activate', req, { plan: st.plan, seats: st.seats }); } catch {}
    try { console.log(`  License activated: plan=${st.plan}`); } catch {}
    res.json(licenseStatusJson());
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

app.delete('/api/license', authRateLimiter, checkPin, (req, res) => {
  try {
    licenseLib.deleteLicense();
    try { logAudit('license.remove', req, {}); } catch {}
    res.json(licenseStatusJson());
  } catch (e) { sendErr(res, e, 500); }
});

// ── Billing (Stripe Checkout + webhook key minting, zero extra deps) ───
// Optional: without STRIPE_SECRET_KEY these routes answer 501 with a hint.
// Checkout Sessions are created via the Stripe REST API with fetch; webhook
// signatures are HMAC-checked with node:crypto. The webhook mints a license
// key and stores a one-time claim token — the success page claims it, so no
// mailer is needed for the MVP. Subscription renewals land in
// GET /api/billing/renewals (authed) for the admin to paste.
const billing = require('./lib/server/billing').createBillingService({ license: licenseLib, statusJson: licenseStatusJson });
app.post('/api/billing/checkout', authRateLimiter, checkPin, billing.checkout);
app.post('/api/billing/portal', authRateLimiter, checkPin, billing.portal);
app.get('/api/billing/claim', rateLimiter, billing.claim);
app.get('/api/billing/renewals', checkPin, billing.renewals);
app.post('/api/billing/renewals/claim', authRateLimiter, checkPin, billing.renewalClaim);
function billingWebhookHandler(req, res) { return billing.webhook(req, res); }

const { createTerminalService } = require('./lib/server/terminal');
const terminal = createTerminalService({
  app, wss, pty, auth, paths, port: PORT, dataDir: DATA_DIR, shell: SHELL, workspaceRoot: WORKSPACE_ROOT,
  getPreviewClients: () => previewWSS.clients,
});
const { getTMUX, tmuxKind, tmuxClaimPath, readTmuxClaim, writeTmuxClaim, releaseTmuxClaim, tmuxClaimLive, broadcastClientEvent } = terminal;

// ── System info ───────────────────────────────────────────────────────
app.get('/api/home', checkPin, (req, res) => {
  res.json({ home: os.homedir(), workspace: WORKSPACE_ROOT, defaultDirectory: WORKSPACE_ROOT, fullFilesystem: ALLOW_FULL_FS, hostname: os.hostname(), platform: os.platform() });
});

const { registerFileRoutes } = require('./lib/server/files');
registerFileRoutes({ app, checkPin, rateLimiter, paths, auth, workspaceRoot: WORKSPACE_ROOT, allowFullFs: ALLOW_FULL_FS });

// ── Network info ──────────────────────────────────────────────────────
const NET_STATS_TTL_MS = 2000;
let _netStatsCache = { at: 0, data: null };
app.get('/api/system/network', rateLimiter, checkPin, async (req, res) => {
  try {
    if (_netStatsCache.data && Date.now() - _netStatsCache.at < NET_STATS_TTL_MS) {
      return res.json(_netStatsCache.data);
    }
    const plat = os.platform();
    const statsMap = new Map();
    try {
      if (plat === 'linux') {
        const devRaw = await fs.promises.readFile('/proc/net/dev', 'utf8');
        for (const line of devRaw.split('\n').slice(2)) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          const ifaceName = line.slice(0, idx).trim();
          const cols = line.slice(idx + 1).trim().split(/\s+/);
          if (ifaceName && cols.length >= 9) {
            statsMap.set(ifaceName, {
              iface: ifaceName,
              rxBytes: Number(cols[0]) || 0,
              txBytes: Number(cols[8]) || 0,
            });
          }
        }
      } else if (plat === 'darwin') {
        const netOut = await spawnRead('netstat', ['-ibn']);
        for (const line of netOut.split('\n').slice(1)) {
          if (!line.includes('<Link#')) continue;
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 10) {
            const ifaceName = cols[0];
            const rxBytes = Number(cols[cols.length - 5]) || Number(cols[6]) || 0;
            const txBytes = Number(cols[cols.length - 2]) || Number(cols[9]) || 0;
            if (ifaceName && !statsMap.has(ifaceName)) {
              statsMap.set(ifaceName, { iface: ifaceName, rxBytes, txBytes });
            }
          }
        }
      } else if (plat === 'win32') {
        const psNet = await spawnRead('powershell.exe', ['-Command', 'Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json']);
        const parsed = JSON.parse(psNet);
        const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        for (const item of list) {
          if (item && item.Name) {
            statsMap.set(item.Name, {
              iface: item.Name,
              rxBytes: Number(item.ReceivedBytes) || 0,
              txBytes: Number(item.SentBytes) || 0,
            });
          }
        }
      }
    } catch {}

    const interfaces = os.networkInterfaces();
    const result = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs || !addrs.length) continue;
      const primary = addrs.find(a => a.family === 'IPv4' || a.family === 4) || addrs[0];
      const macAddr = (addrs.find(a => a.mac && a.mac !== '00:00:00:00:00:00') || primary || {}).mac || '';
      const st = statsMap.get(name);
      result.push({
        name,
        interface: name,
        internal: addrs.every(a => a.internal),
        mac: macAddr,
        family: primary.family,
        address: primary.address,
        netmask: primary.netmask,
        cidr: primary.cidr,
        rxBytes: st ? st.rxBytes : null,
        txBytes: st ? st.txBytes : null,
        addresses: addrs.map(addr => ({
          family: addr.family,
          address: addr.address,
          netmask: addr.netmask,
          mac: addr.mac,
          internal: addr.internal,
          cidr: addr.cidr,
        })),
      });
    }

    let gateway = null;
    const dnsSet = new Set();
    try {
      if (plat === 'win32') {
        try {
          const route = (await spawnRead('powershell.exe', ['-Command', '(Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object -First 1).NextHop'])).trim();
          gateway = route.split(/\r?\n/)[0].trim() || null;
        } catch {}
        try {
          const dnsOut = (await spawnRead('powershell.exe', ['-Command', '(Get-DnsClientServerAddress -AddressFamily IPv4).ServerAddresses'])).trim();
          dnsOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => dnsSet.add(s));
        } catch {}
      } else if (plat === 'darwin') {
        try {
          const route = await spawnRead('route', ['-n', 'get', 'default']);
          const m = route.match(/gateway:\s*(\S+)/);
          if (m) gateway = m[1];
        } catch {}
        try {
          const scOut = await spawnRead('scutil', ['--dns']);
          for (const m of scOut.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)) {
            if (m[1]) dnsSet.add(m[1]);
          }
        } catch {}
      } else {
        try {
          const routeOut = await spawnRead('ip', ['route', 'show', 'default']);
          const m = routeOut.match(/default\s+via\s+(\S+)/);
          if (m) gateway = m[1];
        } catch {}
        if (!gateway) {
          try {
            const procRoute = await fs.promises.readFile('/proc/net/route', 'utf8');
            for (const line of procRoute.split('\n').slice(1)) {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 3 && parts[1] === '00000000' && /^[0-9A-Fa-f]{8}$/.test(parts[2])) {
                const hex = parts[2];
                const b = [
                  parseInt(hex.slice(6, 8), 16),
                  parseInt(hex.slice(4, 6), 16),
                  parseInt(hex.slice(2, 4), 16),
                  parseInt(hex.slice(0, 2), 16),
                ];
                if (b.some(x => x !== 0)) {
                  gateway = b.join('.');
                  break;
                }
              }
            }
          } catch {}
        }
        try {
          const resolv = await fs.promises.readFile('/etc/resolv.conf', 'utf8');
          for (const line of resolv.split('\n')) {
            const m = line.trim().match(/^nameserver\s+(\S+)/);
            if (m && m[1]) dnsSet.add(m[1]);
          }
        } catch {}
        if (dnsSet.size === 0 || (dnsSet.size === 1 && dnsSet.has('127.0.0.53'))) {
          try {
            const rctl = await spawnRead('resolvectl', ['status']);
            for (const m of rctl.matchAll(/DNS Servers:\s*([^\n]+)/g)) {
              m[1].trim().split(/\s+/).filter(Boolean).forEach(s => dnsSet.add(s));
            }
          } catch {}
        }
      }
    } catch {}
    try {
      for (const s of dns.getServers()) {
        if (s) dnsSet.add(s);
      }
    } catch {}
    const dnsServers = Array.from(dnsSet).slice(0, 6);

    let listenPorts = [];
    try {
      const seenPortKey = new Set();
      const pushPort = (port, address, proc) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;
        const key = `${address || ''}:${port}`;
        if (seenPortKey.has(key)) return;
        seenPortKey.add(key);
        listenPorts.push({ port, address: address || '', process: proc || '' });
      };
      if (plat === 'win32') {
        const out = await spawnRead('netstat', ['-ano', '-p', 'tcp']);
        for (const l of out.split(/\r?\n/)) {
          const m = l.match(/TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
          if (m) pushPort(parseInt(m[2], 10), m[1], m[3]);
        }
      } else if (plat === 'darwin') {
        const out = await spawnRead('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']);
        for (const l of out.split('\n').slice(1)) {
          const parts = l.trim().split(/\s+/);
          const addr = parts[8] || '';
          const m = addr.match(/:(\d+)$/);
          if (m) pushPort(parseInt(m[1], 10), addr, parts[0] || '');
        }
      } else {
        let out = '';
        try { out = await spawnRead('ss', ['-tlnp']); } catch {
          try { out = await spawnRead('ss', ['-tln']); } catch {}
        }
        for (const l of out.split('\n').slice(1)) {
          if (!l.trim()) continue;
          const parts = l.trim().split(/\s+/);
          const addr = parts[3] || '';
          const port = parseInt(addr.split(':').pop(), 10);
          const proc = parts.slice(5).join(' ');
          const m = proc.match(/users:\(\("([^"]+)"/);
          pushPort(port, addr, m ? m[1] : '');
        }
      }
    } catch {}

    const payload = {
      interfaces: result,
      stats: Array.from(statsMap.values()),
      gateway,
      dns: dnsServers,
      ports: listenPorts,
      listeningPorts: listenPorts,
    };
    _netStatsCache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    sendErr(res, e);
  }
});




// ── Command history (server-side, persists across sessions) ────────────
const HISTORY_FILE = path.join(DATA_DIR, '.cmdhist.json');
let cmdHistory = [];
let cmdHistMax = 50;
let _cmdHistSaveTimer = null;

// Stored as { max, items }. The max used to live only in memory, so a changed
// cap silently reverted to 50 on the next restart. A bare array (the old
// shape) is still readable.
function loadCmdHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
    const _histCap = historyMaxAllowed();
    cmdHistory = items.filter(it => it && typeof it.cmd === 'string').slice(0, _histCap);
    if (parsed && !Array.isArray(parsed) && Number.isInteger(parsed.max) && parsed.max >= 10 && parsed.max <= _histCap) {
      cmdHistMax = parsed.max;
    }
    if (cmdHistory.length > cmdHistMax) cmdHistory.length = cmdHistMax;
  } catch { cmdHistory = []; }
}
function saveCmdHistory() {
  if (_cmdHistSaveTimer) clearTimeout(_cmdHistSaveTimer);
  _cmdHistSaveTimer = setTimeout(() => {
    _cmdHistSaveTimer = null;
    try {
      const tmp = HISTORY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ max: cmdHistMax, items: cmdHistory }), { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, HISTORY_FILE);
    } catch {}
  }, 300);
  if (_cmdHistSaveTimer && _cmdHistSaveTimer.unref) _cmdHistSaveTimer.unref();
}
// NOTE: loaded in startServer() AFTER migrateLegacyState(), not at import —
// the first boot after upgrade used to read the empty new-location file, then
// migrate the legacy file without reloading, so the next save overwrote the
// migrated history. require('./server.js') must stay side-effect free here.
let _historyLoaded = false;

app.get('/api/history', checkPin, (req, res) => {
  // A downgraded plan shrinks the cap on read (never grows data back).
  try {
    const _cap = historyMaxAllowed();
    if (cmdHistMax > _cap) { cmdHistMax = _cap; }
    if (cmdHistory.length > cmdHistMax) { cmdHistory.length = cmdHistMax; saveCmdHistory(); }
  } catch {}
  res.json({ history: cmdHistory, max: cmdHistMax });
});

app.post('/api/history', checkPin, (req, res) => {
  try {
    const { cmd, max } = req.body;
    if (max !== undefined) {
      const _histCap = historyMaxAllowed();
      if (!Number.isInteger(max) || max < 10 || max > _histCap) {
        return res.status(400).json({ error: `max must be integer 10-${_histCap}` });
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

const { registerGitRoutes } = require('./lib/server/git');
registerGitRoutes({ app, checkPin, rateLimiter, paths, workspaceRoot: WORKSPACE_ROOT, allowFullFs: ALLOW_FULL_FS });

// ── System stats ────────────────────────────────────────────────────
// Stats are polled repeatedly by the UI, and each miss shells out to df/ps/nvidia-smi
// and burns a 100 ms CPU sample. Serve a 2 s-old sample instead. (B-L6)
const SYS_STATS_TTL_MS = 2000;
let _sysStatsCache = { at: 0, data: null };
let _sysStatsCpuPrev = null;
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
    const nowSample = getCpuUsageFromCpus();
    const prev = _sysStatsCpuPrev;
    const nowMs = Date.now();
    if (prev && (nowMs - prev.at) >= 50) {
      const idleDiff = nowSample.idle - prev.sample.idle;
      const totalDiff = nowSample.total - prev.sample.total;
      cpuUsage = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
    }
    _sysStatsCpuPrev = { at: nowMs, sample: nowSample };
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
      const dfOut = await spawnRead('df', ['-hP']);
      const lines = dfOut.trim().split('\n').slice(1);
      const seenFs = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;
        const fsName = parts[0];
        const mounted = parts.slice(5).join(' ');
        if (/^(tmpfs|devtmpfs|udev|none|squashfs|efivarfs|proc|sysfs|cgroup|shm|nsfs)$/i.test(fsName)) continue;
        if (/^\/(proc|sys|dev|run|snap)(\/|$)/.test(mounted)) continue;
        if (seenFs.has(fsName) && mounted !== '/') continue;
        seenFs.add(fsName);
        disk.push({ filesystem: fsName, size: parts[1], used: parts[2], avail: parts[3], usePercent: parts[4], mounted });
      }
      disk.sort((a, b) => (a.mounted === '/' ? -1 : b.mounted === '/' ? 1 : a.mounted.localeCompare(b.mounted)));
      if (!disk.length) {
        const dfRoot = await spawnRead('df', ['-h', '/']);
        const rLines = dfRoot.trim().split('\n');
        if (rLines.length > 1) {
          const parts = rLines[1].split(/\s+/);
          disk = [{ filesystem: parts[0], size: parts[1], used: parts[2], avail: parts[3], usePercent: parts[4], mounted: parts[5] }];
        }
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
    if (tunnelService.hasPid(pid)) return res.status(400).json({ error: 'refusing to kill managed cloudflared' });
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
    try { logAudit('system.kill', req, { pid }); } catch {}
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

const { createTunnelService } = require('./lib/server/tunnels');
const tunnelService = createTunnelService({ app, checkPin, dataDir: DATA_DIR, allowFullFs: ALLOW_FULL_FS, licenseStatus: () => licenseLib.status() });
const findCloudflared = (...args) => require('./lib/cloudflared').findCloudflared(...args);

// ── SSH access (on-demand credentials for external SSH clients) ────────
// Optional, off by default: credentials exist only after an explicit
// PIN-authed POST. Key-only (ed25519), current-user authorized_keys,
// managed lines tagged `webtun:<id>` so revoke never touches foreign keys.
// Creation/deletion require PIN protection (requirePinSet) so an open
// instance can't mint shell access for anyone on the network.
const sshLib = new Proxy({}, { get(_t, prop) { const m = require('./lib/ssh'); return m[prop]; } });

app.get('/api/ssh/status', rateLimiter, checkPin, async (req, res) => {
  try {
    res.json(await sshLib.getSshStatus(DATA_DIR));
  } catch (e) { sendErr(res, e, 500); }
});

app.get('/api/ssh/keys', rateLimiter, checkPin, (req, res) => {
  try {
    res.json({ keys: sshLib.listCredentials(DATA_DIR) });
  } catch (e) { sendErr(res, e, 500); }
});

app.post('/api/ssh/credentials', authRateLimiter, checkPin, requirePinSet, requirePro, (req, res) => {
  try {
    sshLib.requireSshEnabled(DATA_DIR);
    const label = req.body && req.body.label;
    let addedBy = '';
    try { addedBy = describeChanger(req); } catch {}
    const cred = sshLib.createCredential(DATA_DIR, { label, addedBy });
    // The private key is returned ONCE and never stored — don't log it.
    console.log(`  SSH credential created: ${cred.id} (${cred.label})`);
    try {
      terminal.broadcastClientEvent({
        event: 'ssh-key-created',
        id: cred.id,
        label: cred.label,
        fingerprint: cred.fingerprint,
        device: addedBy,
        at: Date.now(),
      });
    } catch {}
    try { logAudit('ssh.key.create', req, { id: cred.id, label: cred.label }); } catch {}
    res.json(cred);
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

app.delete('/api/ssh/keys/:id', authRateLimiter, checkPin, requirePinSet, requirePro, (req, res) => {
  try {
    const out = sshLib.revokeCredential(DATA_DIR, req.params.id);
    try { console.log(`  SSH credential revoked: ${req.params.id} (${out.label || ''})`); } catch {}
    try {
      terminal.broadcastClientEvent({
        event: 'ssh-key-revoked',
        id: req.params.id,
        label: out.label || '',
        at: Date.now(),
      });
    } catch {}
    try { logAudit('ssh.key.revoke', req, { id: req.params.id, label: out.label || '' }); } catch {}
    res.json(out);
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

app.post('/api/ssh/port', authRateLimiter, checkPin, requirePinSet, requirePro, (req, res) => {
  try {
    sshLib.requireSshEnabled(DATA_DIR);
    res.json(sshLib.setExpectedPort(DATA_DIR, req.body && req.body.port));
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

app.post('/api/ssh/cleanup', authRateLimiter, checkPin, requirePinSet, requirePro, (req, res) => {
  try {
    const out = sshLib.cleanupOrphanedLines(DATA_DIR);
    try { console.log(`  SSH orphan cleanup: removed ${out.removedLines} line(s)`); } catch {}
    res.json(out);
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

// ── SSH easy setup (one-click sshd / firewall / Tailscale / built-in SSH)
// Read-only checks are cheap; every fix action is allow-listed server-side,
// sudo -n only (never a password over the wire), and PIN-gated like the rest
// of the SSH surface. Slow installs (apt, downloads) run async: the route
// answers 202 and the outcome lands on the next GET.
const sshSetup = new Proxy({}, { get(_t, prop) { const m = require('./lib/ssh-setup'); return m[prop]; } });

app.get('/api/ssh/setup', rateLimiter, checkPin, async (req, res) => {
  try {
    const out = await sshSetup.getSetupChecks(DATA_DIR);
    try {
      const m = await sshSetup.refreshManagedListening(DATA_DIR);
      const row = out.checks.find(c => c.id === 'managed-sshd');
      if (row) {
        row.managed = { ...row.managed, listening: m.listening, pid: m.pid || (row.managed && row.managed.pid) || 0 };
        if (m.listening) row.detail = `Built-in SSH running on ${m.port} (pid ${m.pid})`;
      }
    } catch {}
    res.json(out);
  } catch (e) { sendErr(res, e, 500); }
});

app.post('/api/ssh/setup/:action', authRateLimiter, checkPin, requirePinSet, requirePro, async (req, res) => {
  try {
    const action = String(req.params.action || '');
    const body = req.body || {};
    const port = Number(body.port);
    const authKey = typeof body.authKey === 'string' ? body.authKey.trim().slice(0, 200) : '';
    const out = await sshSetup.runSetupAction(DATA_DIR, action, {
      port: Number.isInteger(port) ? port : undefined,
      authKey,
    });
    if (out && out.started) return res.status(202).json(out);
    res.json(out);
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

// Master switch backing Settings → Features → SSH Access. Turning it OFF is
// a real teardown: the supervised built-in sshd stops and a WebTun-started
// Tailnet disconnects (revoke/cleanup stay available — off is never a trap).
app.post('/api/ssh/enabled', authRateLimiter, checkPin, requirePinSet, requirePro, async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    const out = await sshSetup.setSshFeatureEnabled(DATA_DIR, on);
    try { logAudit('ssh.enabled', req, { enabled: on }); } catch {}
    res.json(out);
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
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
const previewAuth = require('./lib/server/preview-auth').createPreviewAuth(auth);

function checkPreviewAuth(req, res, next) {
  const url = new URL(req.originalUrl, 'http://x');
  const params = url.searchParams;
  const pathCapability = previewAuth.pathCapability(url.pathname);
  if (pathCapability) params.set('ptoken', pathCapability);
  const granted = previewAuth.authenticate(req, params, req.params.port);
  if (!granted) return res.status(401).json({ error: 'Unauthorized' });
  req.authToken = granted.owner;
  req.previewCapability = granted.capability;
  setPreviewCookie(req, res);
  // A dev app must never see the live bearer in its own location. Bootstrap
  // navigations exchange it for a revocable, single-port capability first.
  if (req.method === 'GET' && granted.capability && params.getAll('token').includes(granted.owner)) {
    const clean = new URL(previewAuth.stripQuery(req.originalUrl), 'http://x');
    const prefix = '/api/preview/' + Number(req.params.port);
    clean.pathname = prefix + '/_wt/' + granted.capability + (clean.pathname.slice(prefix.length) || '/');
    return res.redirect(302, clean.pathname + clean.search);
  }
  return next();
}
function setPreviewCookie(req, res) {
  if (!req.previewCapability) return;
  const secure = req.secure || (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie', `${PREVIEW_COOKIE}=${req.previewCapability}; Path=/api/preview/${Number(req.params.port)}/; Max-Age=3600; HttpOnly${secure ? '; Secure; SameSite=None; Partitioned' : '; SameSite=Lax'}`);
}
// Ports the preview proxy may dial. By default any port 1–65535, WebTun's own
// included: connecting needs no privilege, the dial is always 127.0.0.1, and the caller
// is already authenticated. Set PREVIEW_PORTS=5173,8080 to restrict it when an
// instance is shared and you don't want the proxy usable as a loopback scanner.
function getPreviewPorts() {
  const raw = String(process.env.PREVIEW_PORTS || '').trim();
  if (!raw || raw === '*' || raw.toLowerCase() === 'all') return null;
  const set = new Set();
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535) set.add(n);
  }
  return set.size ? set : null;
}
function validPreviewPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return false;
  const set = getPreviewPorts();
  if (set && !set.has(n)) return false;
  return true;
}
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
// Why this port was refused before any dial (caller-visible config, not a
// loopback probe signal — no listener state is revealed).
function previewPortRejectReason(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'invalid';
  const set = getPreviewPorts();
  if (set && !set.has(n)) return 'blocked';
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
  suffix = previewAuth.stripPath(suffix);
  if (suffix.includes('\0')) return res.status(400).json({ error: 'bad path' });
  // Strip only OUR bearer from the upstream query: a ?token= value that is a
  // live credential (the PIN or a known session token) is ours — it already
  // completed auth above, and the dev app's logs would harvest it. Anything
  // else belongs to the upstream app itself (Jupyter-style ?token= logins)
  // and passes through; deleting it breaks the app, typically as an endless
  // login redirect loop ("too many redirects"). Note the values must be
  // classified individually: Express merges ?token=A&token=B into one array,
  // so "the query token" can't tell ours from foreign.
  suffix = previewAuth.stripQuery(suffix);
  // Mint preview cookie on first authed hit so subresources pass auth.
  // Port-scoped path (one port's cookie never authenticates another),
  // Secure when the request arrived over TLS, 12h cap on a stolen-URL window.
  setPreviewCookie(req, res);
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
      // read wt-session-token / localStorage / the files API.
      // Mirrors the in-app iframe sandbox flags. frame-ancestors * permits embedding inside preview tabs.
      try {
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals; frame-ancestors *");
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
        const previewPrefix = `/api/preview/${targetPort}`;
        const assetPrefix = previewPrefix + (req.previewCapability ? '/_wt/' + req.previewCapability : '');
        const baseTag = Buffer.from(`<base href="${assetPrefix}/">`, 'latin1');
        const navTag = Buffer.from(`<script>(function(){var cap=${JSON.stringify(req.previewCapability || '')},prefix=${JSON.stringify(previewPrefix)},assets=${JSON.stringify(assetPrefix)};var s=function(){parent.postMessage({wtPreviewNav:location.pathname.replace(assets,prefix)+location.search},'*')};addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.wtPreviewHistory===true&&(e.data.delta===-1||e.data.delta===1))history.go(e.data.delta)});function url(v){var u=new URL(v,location.href);if(u.host!==location.host)return v;if(!u.pathname.startsWith(assets+'/'))u.pathname=assets+(u.pathname.startsWith(prefix+'/')?u.pathname.slice(prefix.length):u.pathname);if(cap)u.searchParams.set('ptoken',cap);return u.href}var f=window.fetch;window.fetch=function(v,o){return f.call(this,typeof v==='string'||v instanceof URL?url(v):new Request(url(v.url),v),o)};var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=Array.from(arguments);a[1]=url(u);return x.apply(this,a)};var w=window.WebSocket;window.WebSocket=function(u,p){return new w(url(u),p)};window.WebSocket.prototype=w.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){window.WebSocket[k]=w[k]});addEventListener('popstate',s);['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(){try{return o.apply(this,arguments)}finally{s()}}});s();setTimeout(s,800)})();</script>`, 'utf8');
        let buf = [], bytes = 0, headSent = false;
        const sendHead = (raw) => {
          headSent = true;
          let out = raw;
          try {
            const s = raw.toString('latin1');
            const m = /<head[^>]*>/i.exec(s);
            if (m) {
              const at = m.index + m[0].length;
                out = Buffer.concat([raw.subarray(0, at), ...(!/<base[\s>]/i.test(s) ? [baseTag] : []), navTag, raw.subarray(at)]);
                // HTML resource attributes commonly use root-relative URLs.
                // Prefix them with the port capability; do not edit script bodies.
                out = Buffer.from(out.toString('latin1').replace(/\b(src|href|action)=(['"])\/(?!\/|api\/preview\/)([^'"]*)\2/gi, (_m, attr, quote, p) => `${attr}=${quote}${assetPrefix}/${p}${quote}`), 'latin1');
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

// Fallback proxy for root-relative resources requested by apps in preview frames
// (e.g. Vite or Next.js requesting /@vite/client or /src/main.js directly against host):
app.all('{*splat}', (req, res, next) => {
  const ref = req.headers['referer'];
  if (ref && !req.path.startsWith('/api/') && !req.path.startsWith('/ws')) {
    const m = ref.match(/\/api\/preview\/(\d+)/);
    if (m) {
      const port = Number(m[1]);
      if (validPreviewPort(port)) {
        req.params = req.params || {};
        req.params.port = port;
        return checkPreviewAuth(req, res, () => handlePreviewProxy(req, res));
      }
    }
  }
  next();
});

// Loopback listeners for the preview address-bar autocomplete (best-effort).
app.get('/api/ports', checkPin, async (req, res) => {
  const found = new Map();
  const add = (addr, port, proc) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return;
    const cleanAddr = addr ? String(addr).replace(/^\[|\]$/g, '') : '';
    if (cleanAddr && cleanAddr !== '127.0.0.1' && cleanAddr !== '::1' && cleanAddr !== '0.0.0.0' && cleanAddr !== '::' && cleanAddr !== '*') return;
    if (!found.has(p)) found.set(p, { port: p, loopback: true });
    if (proc && !found.get(p).proc) found.get(p).proc = String(proc).slice(0, 64);
  };
  try {
    if (os.platform() === 'win32') {
      const out = await spawnRead('netstat', ['-ano', '-p', 'tcp'], 3000);
      for (const line of out.split('\n')) {
        const m = line.match(/TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i) || line.match(/TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING/i);
        if (m) add(m[1], m[2], m[3] ? 'pid ' + m[3] : null);
      }
    } else {
      let out = await spawnRead('ss', ['-tlnp'], 2500);
      if (!out) out = await spawnRead('ss', ['-tln'], 2500);
      if (out) {
        for (const line of out.split('\n')) {
          if (!/LISTEN/i.test(line)) continue;
          const m = line.match(/(?:127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|\[?::\]?|\*):(\d+)/);
          if (!m) continue;
          const pm = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
          add('127.0.0.1', m[1], pm ? `${pm[1]}:${pm[2]}` : null);
        }
      }
      if (found.size === 0 && os.platform() === 'darwin') {
        const lsofOut = await spawnRead('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], 2500);
        for (const line of lsofOut.split('\n')) {
          const m = line.match(/^(\S+)\s+(\d+)\s+.*?(127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|\[?::\]?|\*):(\d+)\s+\(LISTEN\)/i);
          if (m) add('127.0.0.1', m[4], `${m[1]}:${m[2]}`);
        }
      }
      if (found.size === 0) {
        const netOut = await spawnRead('netstat', ['-an', '-p', 'tcp'], 2500);
        for (const line of netOut.split('\n')) {
          const m = line.match(/(127\.0\.0\.1|0\.0\.0\.0)\.(\d+).*LISTEN/i) || line.match(/tcp\d?\s+\S+\s+(\S+)[.:](\d+).*LISTEN/i);
          if (m) add(m[1] && m[1].includes('.') ? m[1] : '127.0.0.1', m[2]);
        }
      }
    }
  } catch {}
  res.json({
    ports: Array.from(found.values()).sort((a, b) => a.port - b.port).slice(0, 100),
    allowedPorts: getPreviewPorts() ? Array.from(getPreviewPorts()) : null
  });
});

// WS proxy for HMR/live-reload: /api/preview/:port/<path> upgrade → ws://127.0.0.1:port/<path>
const previewWSS = new WebSocket.Server({ noServer: true });
function previewUpgradeAuth(req, params, port) {
  const pathCapability = previewAuth.pathCapability(new URL(req.url, 'http://x').pathname);
  if (pathCapability) params.set('ptoken', pathCapability);
  const granted = previewAuth.authenticate(req, params, port);
  if (!granted) return false;
  req.authToken = granted.owner;
  return true;
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
  let targetPort = null, targetPath = '/';
  const m = u.pathname.match(/^\/api\/preview\/(\d+)(\/.*)?$/);
  if (m) {
    targetPort = Number(m[1]);
    targetPath = (m[2] || '/') + (u.search || '');
  } else {
    // If the WebSocket upgrade was made without /api/preview prefix (e.g. Vite HMR client
    // connecting to ws://host/ with Referer: .../api/preview/<port>/), detect port from Referer:
    const ref = req.headers['referer'];
    if (ref) {
      const rm = ref.match(/\/api\/preview\/(\d+)/);
      if (rm) {
        targetPort = Number(rm[1]);
        targetPath = u.pathname + (u.search || '');
      }
    }
  }
  if (!targetPort) { try { socket.destroy(); } catch {} return; }
  if (!validPreviewPort(targetPort)) { try { socket.destroy(); } catch {} return; }
  if (!previewUpgradeAuth(req, u.searchParams, targetPort)) { try { socket.destroy(); } catch {} return; }
  targetPath = previewAuth.stripQuery(previewAuth.stripPath(targetPath));
  previewWSS.handleUpgrade(req, socket, head, clientWs => {
    // Attribute the credential so PIN rotation / session revoke (wsAuthSweep,
    // closeInvalidSockets, pushSessionRevoked) can reap preview sockets too.
    try {
      clientWs._authToken = req.authToken;
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
    const earlyQueue = [];
    clientWs.on('message', d => {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        try { upstream.send(d); } catch {}
      } else {
        earlyQueue.push(d);
      }
    });
    upstream.on('open', () => {
      while (earlyQueue.length) {
        const d = earlyQueue.shift();
        try { upstream.send(d); } catch {}
      }
      upstream.on('message', d => {
        try { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(d); } catch {}
      });
    });
    upstream.on('close', (c, r) => closeBoth(c, r));
    upstream.on('error', () => { try { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error'); } catch {} });
    clientWs.on('close', () => closeBoth());
    clientWs.on('error', () => closeBoth());
    // If upstream never opens, don't hang forever.
    setTimeout(() => {
      try { if (upstream.readyState === WebSocket.CONNECTING) { upstream.terminate(); if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream timeout'); } } catch {}
    }, 10000).unref?.();
  });
});

// ─────────────────────────────────────────────────────────────────────

function cleanup() {
  tunnelService.dispose();
  terminal.dispose();
  auth.dispose();
  // Our supervised built-in sshd dies with us (the persisted `enabled` flag
  // survives, so the next boot restores it). The userspace Tailscale daemon
  // is deliberately LEFT running — it owns the Tailnet connection.
  try { require('./lib/ssh-setup').shutdownManagedSshd(DATA_DIR); } catch {}
}

function startServer(opts = {}) {
  const port = opts.port || PORT;
  const host = opts.host || HOST;

  migrateLegacyState();
  try { auditSync.loadPolicy(); } catch {}
  licenseLib.loadLicense();
  if (!_historyLoaded) { _historyLoaded = true; loadCmdHistory(); }
  tunnelService.loadTunnels();
  // NOTE: no orphan sweep here — it runs after the port binds (below), so a
  // process that cannot bind never destroys another instance's sessions.

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`\n  WebTun running → http://localhost:${port}`);
      if (auth.pin) console.log(`  PIN protection enabled`);
      console.log('');
      terminal.startNamespace();
      // Restore the built-in SSH daemon if the user left it enabled (async:
      // a slow sshd start must not delay the ready log).
      try {
        require('./lib/ssh-setup').bootManagedSshd(DATA_DIR).catch(() => {});
      } catch {}
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
Object.defineProperty(module.exports, 'PIN', { get: () => auth.pin, enumerable: true });

if (require.main === module) {
  startServer();
}

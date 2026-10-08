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
      if (!(key in process.env) || key === 'PREVIEW_PORTS') process.env[key] = val;
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
  for (const _f of ['.env', '.cmdhist.json', '.tunnels.json', '.ssh-state.json', 'license.json', 'pending-licenses.json', 'tunnel-url.txt']) {
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
  app, pin: process.env.PIN || '', port: PORT, envPath: ENV_PATH, authRateLimiter,
  licenseStatus: () => licenseLib.status(),
  events: {
    broadcast: event => terminal.broadcastClientEvent(event),
    revoke: token => terminal.pushSessionRevoked(token),
    invalidate: reason => terminal.closeInvalidSockets(reason),
  },
});
const { checkPin, requirePinSet, getSession, rawPinAllowed, isLoopbackReq, isLoopbackSocket, constantTimeEqual, describeChanger } = auth;

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
    try { console.log(`  License activated: plan=${licenseLib.status().plan}`); } catch {}
    res.json(licenseStatusJson());
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

app.delete('/api/license', authRateLimiter, checkPin, (req, res) => {
  try {
    licenseLib.deleteLicense();
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
function billingConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}
function stripePriceId(plan, annual) {
  const key = 'STRIPE_PRICE_' + String(plan || '').toUpperCase() + '_' + (annual ? 'YEARLY' : 'MONTHLY');
  return process.env[key] || '';
}

app.post('/api/billing/checkout', authRateLimiter, checkPin, async (req, res) => {
  try {
    if (!billingConfigured()) return res.status(501).json({ error: 'Billing not configured — set STRIPE_SECRET_KEY plus price ids (see docs)' });
    const body = req.body || {};
    const plan = String(body.plan || '').toLowerCase();
    if (plan !== 'pro' && plan !== 'team') return res.status(400).json({ error: 'plan must be pro or team' });
    let seats = plan === 'pro' ? 1 : 3;
    if (body.seats !== undefined) {
      seats = parseInt(body.seats, 10);
      if (!Number.isInteger(seats) || seats < (plan === 'pro' ? 1 : 3) || seats > 10) {
        return res.status(400).json({ error: 'seats must be 1-10 (team minimum 3)' });
      }
    }
    const annual = !!body.annual;
    const price = stripePriceId(plan, annual);
    if (!price) return res.status(501).json({ error: 'Price id missing for this plan — set STRIPE_PRICE_* (see docs)' });
    const base = (req.protocol + '://' + req.get('host')).replace(/\/+$/, '');
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('success_url', base + '/billing-success.html?session={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', base + '/');
    params.append('line_items[0][price]', price);
    params.append('line_items[0][quantity]', '1');
    params.append('subscription_data[metadata][plan]', plan);
    params.append('subscription_data[metadata][seats]', String(seats));
    params.append('metadata[plan]', plan);
    params.append('metadata[seats]', String(seats));
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) return res.status(502).json({ error: (data && data.error && data.error.message) || 'Stripe checkout failed' });
    res.json({ success: true, url: data.url });
  } catch (e) { sendErr(res, e, 500); }
});

// One-time key claim after checkout. The session id is unguessable, so this
// stays public (the buyer may not have a WebTun session yet); rate-limited.
app.get('/api/billing/claim', rateLimiter, (req, res) => {
  try {
    const sid = typeof req.query.session === 'string' ? req.query.session : '';
    if (!sid || !/^cs_(test|live)_/.test(sid)) return res.status(400).json({ error: 'session required' });
    const all = licenseLib.loadPending();
    const entry = all[sid];
    if (!entry || !entry.key) return res.json({ success: true, pending: true });
    licenseLib.claimPending(sid);
    res.json({ success: true, key: entry.key, plan: entry.plan, seats: entry.seats });
  } catch (e) { sendErr(res, e, 500); }
});

// Renewal keys minted from invoice events, for the admin to paste.
app.get('/api/billing/renewals', checkPin, (req, res) => {
  try {
    const all = licenseLib.loadPending();
    const list = Object.keys(all)
      .filter(k => k.indexOf('renew_') === 0)
      .map(k => ({ id: k, email: all[k].email || '', plan: all[k].plan || '', seats: all[k].seats || 0, createdAt: all[k].createdAt || 0 }));
    res.json({ success: true, renewals: list });
  } catch (e) { sendErr(res, e, 500); }
});

app.post('/api/billing/renewals/claim', authRateLimiter, checkPin, (req, res) => {
  try {
    const id = req.body && req.body.id;
    const entry = licenseLib.claimPending(typeof id === 'string' ? id : '');
    if (!entry) return res.status(404).json({ error: 'renewal not found' });
    licenseLib.saveLicenseKey(entry.key);
    res.json(licenseStatusJson());
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

function stripeSigOk(rawBody, header) {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!secret || !header) return false;
    const parts = {};
    String(header).split(',').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    const t = parseInt(parts.t, 10);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
    const expect = crypto.createHmac('sha256', secret).update(t + '.' + rawBody.toString('utf8')).digest('hex');
    const got = Buffer.from(parts.v1 || '', 'utf8');
    const want = Buffer.from(expect, 'utf8');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

function mintKeyFor(plan, seats, days) {
  const priv = (process.env.LICENSE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!priv) { const e = new Error('LICENSE_PRIVATE_KEY not set — mint keys with scripts/mint-license.js'); e.status = 501; throw e; }
  const now = Date.now();
  return licenseLib.signLicense({ v: 1, plan, seats, exp: now + days * 24 * 3600 * 1000, iat: now }, priv);
}

async function billingWebhookHandler(req, res) {
  const raw = req.body && Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!billingConfigured()) return res.status(501).json({ error: 'Billing not configured' });
  if (!stripeSigOk(raw, req.headers['stripe-signature'])) return res.status(400).json({ error: 'bad signature' });
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad payload' }); }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data && event.data.object ? event.data.object : {};
      const plan = s.metadata && s.metadata.plan === 'team' ? 'team' : 'pro';
      const seats = Math.max(plan === 'team' ? 3 : 1, Math.min(10, parseInt(s.metadata && s.metadata.seats, 10) || (plan === 'team' ? 3 : 1)));
      const days = 35; // monthly-equivalent starter; annual handled below
      const key = mintKeyFor(plan, seats, days);
      licenseLib.storePending(typeof s.id === 'string' ? s.id : crypto.randomBytes(16).toString('hex'), {
        key, plan, seats, email: (s.customer_details && s.customer_details.email) || '', createdAt: Date.now(),
      });
      try { console.log(`  Billing: key minted for ${plan} x${seats}`); } catch {}
    } else if (event.type === 'invoice.payment_succeeded') {
      const inv = event.data && event.data.object ? event.data.object : {};
      // Annual vs monthly is distinguished by the subscription metadata the
      // checkout route set; default to a 35 day extension when unknown.
      const plan = 'pro';
      const key = mintKeyFor(plan, 1, 35);
      const rid = 'renew_' + crypto.randomBytes(8).toString('hex');
      licenseLib.storePending(rid, {
        key, plan, seats: 1, email: (inv.customer_email || ''), createdAt: Date.now(),
      });
      try { console.log(`  Billing: renewal key ready (${rid}) — paste from Settings → Security`); } catch {}
    }
    res.json({ received: true });
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
}

const { createTerminalService } = require('./lib/server/terminal');
const terminal = createTerminalService({
  app, wss, pty, auth, paths, port: PORT, dataDir: DATA_DIR, shell: SHELL, workspaceRoot: WORKSPACE_ROOT,
  getPreviewClients: () => previewWSS.clients,
});
const { getTMUX, tmuxKind, tmuxClaimPath, readTmuxClaim, writeTmuxClaim, releaseTmuxClaim, tmuxClaimLive, broadcastClientEvent } = terminal;

// ── System info ───────────────────────────────────────────────────────
app.get('/api/home', checkPin, (req, res) => {
  res.json({ home: os.homedir(), hostname: os.hostname(), platform: os.platform() });
});

const { registerFileRoutes } = require('./lib/server/files');
registerFileRoutes({ app, checkPin, rateLimiter, paths, auth, workspaceRoot: WORKSPACE_ROOT, allowFullFs: ALLOW_FULL_FS });

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
    const _histCap = historyMaxAllowed();
    cmdHistory = items.filter(it => it && typeof it.cmd === 'string').slice(0, _histCap);
    if (parsed && !Array.isArray(parsed) && Number.isInteger(parsed.max) && parsed.max >= 10 && parsed.max <= _histCap) {
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
const { findCloudflared } = require('./lib/cloudflared');

// ── SSH access (on-demand credentials for external SSH clients) ────────
// Optional, off by default: credentials exist only after an explicit
// PIN-authed POST. Key-only (ed25519), current-user authorized_keys,
// managed lines tagged `webtun:<id>` so revoke never touches foreign keys.
// Creation/deletion require PIN protection (requirePinSet) so an open
// instance can't mint shell access for anyone on the network.
const sshLib = require('./lib/ssh');

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
      broadcastClientEvent({
        event: 'ssh-key-created',
        id: cred.id,
        label: cred.label,
        fingerprint: cred.fingerprint,
        device: addedBy,
        at: Date.now(),
      });
    } catch {}
    res.json(cred);
  } catch (e) { sendErr(res, e, e && e.status ? e.status : 500); }
});

app.delete('/api/ssh/keys/:id', authRateLimiter, checkPin, requirePinSet, requirePro, (req, res) => {
  try {
    const out = sshLib.revokeCredential(DATA_DIR, req.params.id);
    try { console.log(`  SSH credential revoked: ${req.params.id} (${out.label || ''})`); } catch {}
    try {
      broadcastClientEvent({
        event: 'ssh-key-revoked',
        id: req.params.id,
        label: out.label || '',
        at: Date.now(),
      });
    } catch {}
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
const sshSetup = require('./lib/ssh-setup');

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
    res.json(await sshSetup.setSshFeatureEnabled(DATA_DIR, on));
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
const activePreviewSessions = new Map();
function recordActivePreview(ip, port) {
  if (!ip || !port) return;
  activePreviewSessions.set(`${ip}:${port}`, Date.now() + 3600000);
  if (activePreviewSessions.size > 200) {
    const now = Date.now();
    for (const [k, exp] of activePreviewSessions) {
      if (exp <= now) activePreviewSessions.delete(k);
    }
  }
}
function hasActivePreview(ip, port) {
  const exp = activePreviewSessions.get(`${ip}:${port}`);
  return !!(exp && exp > Date.now());
}

function checkPreviewAuth(req, res, next) {
  if (!auth.pin) return next();
  const raw = req.headers['x-pin-token'] || (req.query && req.query.token) || parsePreviewCookie(req);
  const token = typeof raw === 'string' ? raw.trim() : '';
  const port = Number(req.params.port);
  const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';

  if (token) {
    if (constantTimeEqual(token, auth.pin)) {
      if (!rawPinAllowed(req)) {
        return res.status(403).json({ error: 'Approval required — sign in from the app so an existing session can approve this device', approvalRequired: true });
      }
      req.authToken = token; req.authSession = null;
      if (port) recordActivePreview(clientIp, port);
      return next();
    }
    const s = getSession(token);
    if (s && s.status === 'active') {
      req.authToken = token; req.authSession = s;
      if (port) recordActivePreview(clientIp, port);
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Subresource authorization fallback for sandboxed/opaque iframes or partitioned cookies:
  if (port && hasActivePreview(clientIp, port)) {
    const ref = String(req.headers['referer'] || '');
    const isSubresource = req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document';
    if (ref.includes(`/api/preview/${port}`) || isSubresource || req.headers['sec-fetch-mode'] === 'cors') {
      req.authToken = auth.pin; req.authSession = null;
      return next();
    }
  }

  return res.status(401).json({ error: 'Unauthorized' });
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
        const foreign = vals.filter(v => !v || (!constantTimeEqual(v, auth.pin) && !getSession(v)));
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
    const isSecure = (req.secure || (trustProxyCookie && req.headers['x-forwarded-proto'] === 'https') || req.headers['x-forwarded-proto'] === 'https');
    const cookieFlags = isSecure ? '; Secure; SameSite=None; Partitioned' : '; SameSite=Lax';
    if (auth.pin && typeof q === 'string' && q.trim()) {
      res.setHeader('Set-Cookie', `${PREVIEW_COOKIE}=${encodeURIComponent(q.trim())}; Path=/api/preview/; Max-Age=43200; HttpOnly${cookieFlags}`);
    } else if (!auth.pin) {
      res.setHeader('Set-Cookie', `${PREVIEW_COOKIE}=open; Path=/api/preview/; Max-Age=43200; HttpOnly${cookieFlags}`);
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

// Fallback proxy for root-relative resources requested by apps in preview frames
// (e.g. Vite or Next.js requesting /@vite/client or /src/main.js directly against host):
app.all('{*splat}', (req, res, next) => {
  const ref = req.headers['referer'];
  if (ref && !req.path.startsWith('/api/') && !req.path.startsWith('/ws')) {
    const m = ref.match(/\/api\/preview\/(\d+)/);
    if (m) {
      const port = Number(m[1]);
      const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
      if (validPreviewPort(port) && (!auth.pin || hasActivePreview(clientIp, port))) {
        req.params = req.params || {};
        req.params.port = port;
        return handlePreviewProxy(req, res);
      }
    }
  }
  next();
});

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
  res.json({
    ports: Array.from(found.values()).sort((a, b) => a.port - b.port).slice(0, 100),
    allowedPorts: getPreviewPorts() ? Array.from(getPreviewPorts()) : null
  });
});

// WS proxy for HMR/live-reload: /api/preview/:port/<path> upgrade → ws://127.0.0.1:port/<path>
const previewWSS = new WebSocket.Server({ noServer: true });
function previewUpgradeAuth(req, params, port) {
  if (!auth.pin) return true;
  const t = typeof params.get('token') === 'string' ? params.get('token').trim() : parsePreviewCookie(req);
  if (t) {
    if (constantTimeEqual(t, auth.pin)) {
      // Same gate as HTTP preview (checkPreviewAuth) and terminal WS: a remote
      // raw PIN is trusted only when nobody else is signed in (loopback always
      // trusted). Session tokens remain the normal path for iframe WS.
      return rawPinAllowed({ socket: req.socket, headers: req.headers, get ip() { return req.socket.remoteAddress; } });
    }
    const s = getSession(t);
    return !!(s && s.status === 'active');
  }
  const clientIp = req.socket?.remoteAddress;
  if (port && hasActivePreview(clientIp, port)) {
    return true;
  }
  return false;
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

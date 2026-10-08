'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { sendErr } = require('./errors');
function createAuthService(options) {
  const { now: clockNow = Date.now, timers = globalThis } = options;
  const { setTimeout, clearTimeout, setInterval, clearInterval } = timers;
  const { app, pin, port: PORT, envPath: ENV_PATH, authRateLimiter, licenseStatus, events } = options;
  let PIN = pin;
  const broadcastClientEvent = events.broadcast;
  const pushSessionRevoked = events.revoke;
  const closeInvalidSockets = events.invalidate;
  const licenseLib = { status: licenseStatus };

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
    const _now = clockNow();
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
    const now = clockNow();
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
    try { prunePreviewFileTokens(clockNow()); } catch {}
  }, 60000);
  if (previewFileTokenSweep.unref) previewFileTokenSweep.unref();
  function clearSessionTimer(s) { try { if (s && s.timer) clearTimeout(s.timer); } catch {} if (s) s.timer = null; }
  // Arm the deny-by-default expiry for a pending session. Shared by first-issue
  // and by the bootstrap demotion path (see /api/auth) so both behave identically.
  function armPendingTimer(token, s) {
    s.status = 'pending';
    s.expiresAt = clockNow() + SESSION_PENDING_MS;
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
    const now = clockNow();
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
    if (clockNow() - (s.lastSeen || 0) > SESSION_IDLE_MS) { authSessions.delete(token); return null; }
    s.lastSeen = clockNow();
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

  function peekSession(token) {
    const s = authSessions.get(token);
    if (!s) return null;
    if (clockNow() - (s.lastSeen || 0) > SESSION_IDLE_MS) { authSessions.delete(token); return null; }
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
  app.get('/api/auth/required', (req, res) => {
    res.json({ required: !!PIN });
  });

  // Version is authed (no free recon for targeted exploits); /api/auth/required
  // stays public for the unlock flow. The About fetch sends the token header.
  app.get('/api/version', checkPin, (req, res) => {
    res.json({ version: require('../../package.json').version, port: PORT });
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
    // License cap: approving beyond the plan device limit needs an upgrade.
    // Loopback owners can always approve (they can also revoke to get under
    // the cap), so this gate can never lock the owner out.
    try {
      const _lic = licenseLib.status();
      if (_lic.enforce) {
        let _loop = false;
        try { _loop = isLoopbackReq(req); } catch {}
        if (!_loop && countActiveSessions() >= _lic.limits.devices) {
          return res.status(402).json({ error: `Plan allows ${_lic.limits.devices} active devices — upgrade for more`, upgrade: true });
        }
      }
    } catch {}
    clearSessionTimer(t);
    t.status = 'active'; t.lastSeen = clockNow(); t.expiresAt = 0;
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
      broadcastClientEvent({ event: 'pin-changed', ip: req.ip || '', device: byDevice, at: clockNow(), disabled: !next });
    } catch {}
    const sessionsRevoked = authSessions.size;
    for (const session of authSessions.values()) clearSessionTimer(session);
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
        const age = req.authSession ? clockNow() - (req.authSession.createdAt || 0) : 0;
        const trusted = req.authSession ? age >= PIN_TRUST_MS : otherCount === 0;
        if (!trusted && otherCount > 0) {
          if (pendingPinChange) return res.status(409).json({ error: 'A PIN change is already awaiting approval' });
          const device = describeChanger(req);
          const ip = req.ip || '';
          pendingPinChange = { newPIN: next, requesterToken, device, ip, expiresAt: clockNow() + PIN_PENDING_MS, timer: null };
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


  function getPreviewFileToken(token) {
    const record = previewFileTokens.get(token);
    if (!record || !record.dir || record.exp <= clockNow()) { previewFileTokens.delete(token); return null; }
    return record;
  }
  function dispose() {
    clearInterval(authSessionSweep);
    clearInterval(previewFileTokenSweep);
    clearPendingPinChange();
    for (const session of authSessions.values()) clearSessionTimer(session);
    authSessions.clear();
    previewFileTokens.clear();
  }
  return { get pin() { return PIN; }, checkPin, requirePinSet, getSession, peekSession,
    wsTokenValid, rawPinAllowed, isLoopbackReq, isLoopbackSocket, constantTimeEqual,
    mintPreviewFileToken, getPreviewFileToken, describeChanger, dispose };
}

module.exports = { createAuthService };

'use strict';

// Commercial license for paid WebTun (Pro / Team).
//
// Offline-first: the server checks an Ed25519 signature with node:crypto and
// stores DATA_DIR/license.json 0600 atomic (same pattern as .tunnels.json /
// .cmdhist.json). No call home per request, because servers sit behind
// tunnels and NAT. No new npm deps.
//
// Caps stay dormant until the owner sets WEBTUN_LICENSE_PUBLIC_KEY (i.e. the
// billing setup exists) — current installs keep current behavior, matching
// the 6 month grandfathering promise. Once configured, Free is limited and
// Pro/Team keys lift the limits. Loopback callers can always mint SSH keys
// (they already own the shell), but tunnel/device/history caps apply to
// everyone so the paywall is real.
//
// Key format: wt1.<base64url(payloadJSON)>.<base64url(signature)>
// Payload: { v:1, plan:'pro'|'team', seats:int, exp:ms, iat:ms }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LICENSE_FILE = 'license.json';
const PENDING_FILE = 'pending-licenses.json';
const GRACE_MS = 7 * 24 * 3600 * 1000;

const FREE_TUNNELS = 2;
const FREE_DEVICES = 3;
const FREE_HISTORY = 200;
const PRO_DEVICES = 5;
const PRO_HISTORY = 1000;
const TEAM_HISTORY = 5000;
const TEAM_ADMINS_MAX = 10;

let _dir = null;
let _publicKey = '';
let _cache = null; // { key, payload } | null

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64');
}

function readPublicKey() {
  // PEM may arrive with literal \n escapes from env files — normalize once.
  const raw = process.env.WEBTUN_LICENSE_PUBLIC_KEY || '';
  if (!raw) return '';
  return raw.replace(/\\n/g, '\n').trim();
}

function initLicense(dataDir) {
  _dir = dataDir;
  _publicKey = readPublicKey();
  _cache = null;
  loadLicense();
  return status();
}

function licensePath() { return path.join(_dir, LICENSE_FILE); }
function pendingPath() { return path.join(_dir, PENDING_FILE); }

function atomicWrite0600(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}

// Verify a key string. Returns { ok, payload } or { ok:false, error }.
function verifyKey(key) {
  if (typeof key !== 'string' || !key) return { ok: false, error: 'key required' };
  if (!_publicKey) return { ok: false, error: 'licensing not configured' };
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'wt1') return { ok: false, error: 'bad key format' };
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch { return { ok: false, error: 'bad key payload' }; }
  if (!payload || payload.v !== 1) return { ok: false, error: 'unsupported key version' };
  if (payload.plan !== 'pro' && payload.plan !== 'team') return { ok: false, error: 'unknown plan' };
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) return { ok: false, error: 'bad key dates' };
  let sig;
  try { sig = b64urlDecode(parts[2]); } catch { return { ok: false, error: 'bad key signature' }; }
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(parts[1], 'utf8'), _publicKey, sig);
  } catch { ok = false; }
  if (!ok) return { ok: false, error: 'invalid signature' };
  return { ok: true, payload };
}

// Sign a payload with a PEM private key (billing webhook / mint script).
function signLicense(payload, privateKeyPem) {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), privateKeyPem);
  return 'wt1.' + body + '.' + b64urlEncode(sig);
}

function loadLicense() {
  _cache = null;
  if (!_dir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(licensePath(), 'utf8'));
    if (parsed && typeof parsed.key === 'string' && parsed.key) {
      const v = verifyKey(parsed.key);
      if (v.ok) { _cache = { key: parsed.key, payload: v.payload }; return _cache; }
      // Keep the bad/expired key on disk for messaging, but treat as free.
      _cache = { key: parsed.key, payload: null, error: v.error };
      return _cache;
    }
  } catch {}
  return null;
}

function saveLicenseKey(key) {
  const v = verifyKey(key);
  if (!v.ok) { const e = new Error(v.error); e.status = 400; throw e; }
  atomicWrite0600(licensePath(), JSON.stringify({ key: key.trim(), savedAt: Date.now() }));
  _cache = { key: key.trim(), payload: v.payload };
  return status();
}

function deleteLicense() {
  try { fs.unlinkSync(licensePath()); } catch {}
  _cache = null;
  return status();
}

function livePayload() {
  if (!_cache || !_cache.payload) return null;
  return _cache.payload;
}

// Current standing. Expired keys keep their plan through the grace window,
// then fall back to free (caps stay enforced once configured).
function status() {
  const configured = !!_publicKey;
  const p = livePayload();
  const now = Date.now();
  if (!p) {
    return { configured, enforce: configured, plan: 'free', seats: 0, expiry: 0, grace: false, expired: !!(_cache && _cache.key), limits: limitsFor('free', 0) };
  }
  const expired = now > p.exp;
  const inGrace = expired && (now - p.exp) <= GRACE_MS;
  const plan = (expired && !inGrace) ? 'free' : p.plan;
  return { configured, enforce: configured, plan, seats: p.seats || 0, expiry: p.exp, grace: inGrace, expired, limits: limitsFor(plan, p.seats || 0) };
}

function planNow() { return status().plan; }

function limitsFor(plan, seats) {
  if (plan === 'team') {
    const admins = Math.max(1, Math.min(TEAM_ADMINS_MAX, Number.isInteger(seats) && seats > 0 ? seats : 3));
    return { tunnels: Infinity, devices: admins, historyMax: TEAM_HISTORY };
  }
  if (plan === 'pro') return { tunnels: Infinity, devices: PRO_DEVICES, historyMax: PRO_HISTORY };
  return { tunnels: FREE_TUNNELS, devices: FREE_DEVICES, historyMax: FREE_HISTORY };
}

// One-time claim tokens for Stripe checkout: webhook mints { claim, key },
// the success page claims it once. Stored 0600 like everything else.
function loadPending() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}
function storePending(claim, entry) {
  const all = loadPending();
  all[claim] = entry;
  // Bound growth: drop entries older than 7 days.
  const cutoff = Date.now() - GRACE_MS;
  for (const k of Object.keys(all)) {
    if (!all[k] || all[k].createdAt < cutoff) delete all[k];
  }
  atomicWrite0600(pendingPath(), JSON.stringify(all));
}
function claimPending(claim) {
  if (typeof claim !== 'string' || !/^[0-9a-f]{32}$/.test(claim)) return null;
  const all = loadPending();
  const entry = all[claim];
  if (!entry || !entry.key) return null;
  delete all[claim];
  atomicWrite0600(pendingPath(), JSON.stringify(all));
  return entry;
}

module.exports = {
  initLicense,
  loadLicense,
  saveLicenseKey,
  deleteLicense,
  verifyKey,
  signLicense,
  status,
  planNow,
  limitsFor,
  loadPending,
  storePending,
  claimPending,
  FREE_TUNNELS,
  FREE_DEVICES,
  FREE_HISTORY,
  PRO_HISTORY,
  TEAM_HISTORY,
  TEAM_ADMINS_MAX,
  GRACE_MS,
};

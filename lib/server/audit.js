'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendErr } = require('./errors');

const AUDIT_FILE = 'audit-log.json';
const LIBRARY_FILE = 'library.json';
const BOOKMARKS_FILE = 'bookmarks.json';
const POLICY_FILE = 'policy.json';
const AUDIT_MAX_ENTRIES = 2000;

function atomicWrite0600(file, text) {
  const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}

function createAuditAndSyncService({ app, checkPin, rateLimiter, authRateLimiter, dataDir, describeChanger }) {
  const auditPath = () => path.join(dataDir, AUDIT_FILE);
  const libraryPath = () => path.join(dataDir, LIBRARY_FILE);
  const bookmarksPath = () => path.join(dataDir, BOOKMARKS_FILE);
  const policyPath = () => path.join(dataDir, POLICY_FILE);

  let auditEntries = null;

  function ensureAuditLoaded() {
    if (auditEntries !== null) return auditEntries;
    try {
      const raw = JSON.parse(fs.readFileSync(auditPath(), 'utf8'));
      auditEntries = Array.isArray(raw) ? raw.slice(0, AUDIT_MAX_ENTRIES) : [];
    } catch {
      auditEntries = [];
    }
    return auditEntries;
  }

  function saveAudit() {
    try {
      if (!auditEntries) return;
      atomicWrite0600(auditPath(), JSON.stringify(auditEntries));
    } catch {}
  }

  function actorFor(req) {
    try {
      if (typeof describeChanger === 'function' && req) {
        const d = describeChanger(req);
        if (d) return String(d).slice(0, 120);
      }
    } catch {}
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    if (ua) return String(ua).slice(0, 80);
    return 'system';
  }

  function ipFor(req) {
    if (!req) return 'local';
    return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
  }

  function logAudit(action, req, details = {}) {
    try {
      const list = ensureAuditLoaded();
      const cleanDetails = {};
      if (details && typeof details === 'object') {
        for (const [k, v] of Object.entries(details)) {
          if (v === undefined) continue;
          if (/pin|secret|password|private|token|key/i.test(k) && k !== 'keyId') continue;
          cleanDetails[k] = typeof v === 'string' ? v.slice(0, 300) : v;
        }
      }
      const nowTs = Date.now();
      const detailSummary = Object.entries(cleanDetails)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')
        .slice(0, 300);
      const actor = actorFor(req);
      const entry = {
        id: crypto.randomBytes(6).toString('hex'),
        ts: nowTs,
        at: nowTs,
        action: String(action || 'event').slice(0, 80),
        actor,
        device: actor,
        ip: ipFor(req),
        detail: detailSummary,
        details: cleanDetails,
      };
      list.unshift(entry);
      if (list.length > AUDIT_MAX_ENTRIES) list.length = AUDIT_MAX_ENTRIES;
      saveAudit();
      return entry;
    } catch {
      return null;
    }
  }

  // Load persisted runtime policy on boot
  function loadPolicy() {
    try {
      const raw = JSON.parse(fs.readFileSync(policyPath(), 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.previewPorts === 'string') process.env.PREVIEW_PORTS = raw.previewPorts;
        if (typeof raw.allowedOrigins === 'string') process.env.ALLOWED_ORIGINS = raw.allowedOrigins;
      }
    } catch {}
  }

  // ── Audit Log Routes ──────────────────────────────────────────────────
  app.get('/api/audit', checkPin, (req, res) => {
    try {
      const list = ensureAuditLoaded().map(e => ({
        ...e,
        at: e.at || e.ts,
        actor: e.actor || e.device || 'system',
        device: e.device || e.actor || 'system',
        detail: e.detail !== undefined
          ? e.detail
          : Object.entries(e.details || {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' '),
      }));
      const q = String(req.query.q || '').trim().toLowerCase();
      const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 200), AUDIT_MAX_ENTRIES);
      const filtered = q
        ? list.filter(e =>
            String(e.action || '').toLowerCase().includes(q) ||
            String(e.actor || '').toLowerCase().includes(q) ||
            String(e.device || '').toLowerCase().includes(q) ||
            String(e.ip || '').toLowerCase().includes(q) ||
            String(e.detail || '').toLowerCase().includes(q) ||
            JSON.stringify(e.details || {}).toLowerCase().includes(q)
          )
        : list;
      const sliced = filtered.slice(0, limit);
      res.json({ success: true, events: sliced, entries: sliced, total: filtered.length });
    } catch (e) { sendErr(res, e); }
  });

  app.get('/api/audit/export', checkPin, (req, res) => {
    try {
      const list = ensureAuditLoaded();
      const fmt = String(req.query.format || 'json').toLowerCase();
      if (fmt === 'csv') {
        const csvEsc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const rows = ['id,timestamp,iso_date,action,actor,ip,details'];
        for (const e of list) {
          rows.push([
            csvEsc(e.id),
            csvEsc(e.ts),
            csvEsc(e.ts ? new Date(e.ts).toISOString() : ''),
            csvEsc(e.action),
            csvEsc(e.actor),
            csvEsc(e.ip),
            csvEsc(JSON.stringify(e.details || {})),
          ].join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="webtun-audit-log.csv"');
        return res.send(rows.join('\n') + '\n');
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="webtun-audit-log.json"');
      res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: list.length, entries: list }, null, 2));
    } catch (e) { sendErr(res, e); }
  });

  app.delete('/api/audit', authRateLimiter, checkPin, (req, res) => {
    try {
      auditEntries = [];
      saveAudit();
      logAudit('audit.cleared', req, {});
      res.json({ success: true, events: auditEntries, entries: auditEntries });
    } catch (e) { sendErr(res, e); }
  });

  // ── Shared Command Library Sync (Feature 2.1) ─────────────────────────
  function readLibrary() {
    try {
      const raw = JSON.parse(fs.readFileSync(libraryPath(), 'utf8'));
      if (Array.isArray(raw)) return raw;
      if (raw && Array.isArray(raw.commands)) return raw.commands;
      if (raw && Array.isArray(raw.items)) return raw.items;
    } catch {}
    return null; // null means never saved on server yet (client keeps defaults)
  }

  app.get('/api/library', checkPin, (req, res) => {
    try {
      const items = readLibrary();
      res.json({ success: true, commands: items, items });
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/library', rateLimiter, checkPin, (req, res) => {
    try {
      const raw = req.body && (req.body.commands || req.body.items);
      if (!Array.isArray(raw)) return res.status(400).json({ error: 'commands array is required' });
      if (raw.length > 500) return res.status(400).json({ error: 'too many library items (max 500)' });
      const items = [];
      for (const it of raw) {
        if (!it || typeof it.cmd !== 'string' || !it.cmd.trim()) continue;
        const cmd = it.cmd.trim().slice(0, 2000);
        const name = (typeof it.name === 'string' && it.name.trim() ? it.name.trim() : (typeof it.desc === 'string' && it.desc.trim() ? it.desc.trim() : cmd)).slice(0, 120);
        const desc = typeof it.desc === 'string' && it.desc.trim() ? it.desc.trim().slice(0, 300) : name;
        const cat = typeof it.cat === 'string' && it.cat.trim() ? it.cat.trim().slice(0, 60) : 'Custom';
        items.push({ name, desc, cmd, cat });
      }
      atomicWrite0600(libraryPath(), JSON.stringify({ updatedAt: Date.now(), commands: items, items }));
      res.json({ success: true, commands: items, items });
    } catch (e) { sendErr(res, e); }
  });

  // ── Shared Bookmarks Sync (Feature 2.1) ───────────────────────────────
  function readBookmarks() {
    try {
      const raw = JSON.parse(fs.readFileSync(bookmarksPath(), 'utf8'));
      if (Array.isArray(raw)) return raw;
      if (raw && Array.isArray(raw.bookmarks)) return raw.bookmarks;
    } catch {}
    return null;
  }

  app.get('/api/bookmarks', checkPin, (req, res) => {
    try {
      const bookmarks = readBookmarks();
      res.json({ success: true, bookmarks });
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/bookmarks', rateLimiter, checkPin, (req, res) => {
    try {
      const raw = req.body && req.body.bookmarks;
      if (!Array.isArray(raw)) return res.status(400).json({ error: 'bookmarks array is required' });
      if (raw.length > 200) return res.status(400).json({ error: 'too many bookmarks (max 200)' });
      const bookmarks = [];
      for (const bm of raw) {
        if (!bm || typeof bm.path !== 'string' || !bm.path.trim()) continue;
        const p = bm.path.trim().slice(0, 1024);
        const name = (typeof bm.name === 'string' && bm.name.trim() ? bm.name.trim() : path.basename(p) || p).slice(0, 120);
        bookmarks.push({ name, path: p });
      }
      atomicWrite0600(bookmarksPath(), JSON.stringify({ updatedAt: Date.now(), bookmarks }));
      res.json({ success: true, bookmarks });
    } catch (e) { sendErr(res, e); }
  });

  // ── Runtime Network & Origin Policy (Feature 2.3) ─────────────────────
  app.get('/api/policy', checkPin, (req, res) => {
    try {
      res.json({
        success: true,
        previewPorts: String(process.env.PREVIEW_PORTS || '').trim(),
        allowedOrigins: String(process.env.ALLOWED_ORIGINS || '').trim(),
      });
    } catch (e) { sendErr(res, e); }
  });

  app.post('/api/policy', authRateLimiter, checkPin, (req, res) => {
    try {
      const body = req.body || {};
      let previewPorts = String(body.previewPorts ?? process.env.PREVIEW_PORTS ?? '').trim();
      let allowedOrigins = String(body.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '').trim();

      if (previewPorts && previewPorts !== '*' && previewPorts.toLowerCase() !== 'all') {
        const parts = previewPorts.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length > 200) return res.status(400).json({ error: 'too many preview ports (max 200)' });
        const cleanPorts = [];
        for (const p of parts) {
          const n = Number(p);
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            return res.status(400).json({ error: `Invalid port "${p}" — ports must be 1–65535 or *` });
          }
          cleanPorts.push(String(n));
        }
        previewPorts = [...new Set(cleanPorts)].join(',');
      } else {
        previewPorts = '';
      }

      if (allowedOrigins) {
        const parts = allowedOrigins.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
        if (parts.length > 50) return res.status(400).json({ error: 'too many allowed origins (max 50)' });
        const cleanOrigins = [];
        for (const o of parts) {
          let u;
          try { u = new URL(o); } catch {
            return res.status(400).json({ error: `Invalid origin "${o}" — use full URL (e.g. https://box.example.com)` });
          }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return res.status(400).json({ error: `Origin "${o}" must use http:// or https://` });
          }
          cleanOrigins.push(u.origin);
        }
        allowedOrigins = [...new Set(cleanOrigins)].join(',');
      }

      process.env.PREVIEW_PORTS = previewPorts;
      process.env.ALLOWED_ORIGINS = allowedOrigins;
      atomicWrite0600(policyPath(), JSON.stringify({ previewPorts, allowedOrigins, updatedAt: Date.now() }));
      logAudit('policy.updated', req, { previewPorts: previewPorts || '*', allowedOrigins: allowedOrigins || '(same-origin)' });

      res.json({ success: true, previewPorts, allowedOrigins });
    } catch (e) { sendErr(res, e); }
  });

  return {
    logAudit,
    loadPolicy,
    ensureAuditLoaded,
  };
}

module.exports = { createAuditAndSyncService };

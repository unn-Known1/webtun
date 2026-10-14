'use strict';

const crypto = require('crypto');

// Capabilities authorize ONE loopback port and are revalidated against their
// issuing session on every request. IP/Referer/fetch hints never grant access.
function createPreviewAuth(auth, { now = Date.now, ttl = 60 * 60 * 1000 } = {}) {
  const capabilities = new Map();
  function ownerActive(owner, req) {
    if (!auth.pin) return false;
    if (auth.constantTimeEqual(owner, auth.pin)) return auth.rawPinAllowed(req);
    return auth.getSession(owner)?.status === 'active';
  }
  function mint(owner, port) {
    for (const [key, rec] of capabilities) if (rec.expires <= now()) capabilities.delete(key);
    while (capabilities.size >= 200) capabilities.delete(capabilities.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex');
    capabilities.set(token, { owner, port: Number(port), expires: now() + ttl });
    return token;
  }
  function cookie(req) {
    for (const part of String(req.headers?.cookie || '').split(';')) {
      const at = part.indexOf('=');
      if (part.slice(0, at).trim() === 'wt-preview') {
        try { return decodeURIComponent(part.slice(at + 1)); } catch { return ''; }
      }
    }
    return '';
  }
  function authenticate(req, params, port) {
    if (!auth.pin) return { owner: '', capability: '' };
    const candidates = [req.headers?.['x-pin-token'], ...params.getAll('token')];
    for (const owner of candidates) {
      if (typeof owner === 'string' && owner && ownerActive(owner, req)) return { owner, capability: mint(owner, port) };
    }
    for (const key of [params.get('ptoken'), cookie(req)]) {
      const rec = capabilities.get(key);
      if (rec && rec.port === Number(port) && rec.expires > now() && ownerActive(rec.owner, req)) return { owner: rec.owner, capability: key };
    }
    return null;
  }
  function stripQuery(suffix) {
    const at = suffix.indexOf('?');
    if (at < 0) return suffix;
    const params = new URLSearchParams(suffix.slice(at + 1));
    const foreign = params.getAll('token').filter(t => !t || (!auth.constantTimeEqual(t, auth.pin) && !auth.getSession(t)));
    params.delete('token');
    for (const t of foreign) params.append('token', t);
    params.delete('ptoken'); // reserved, port-scoped WebTun transport credential
    const search = params.toString();
    return suffix.slice(0, at) + (search ? '?' + search : '');
  }
  function pathCapability(path) { return /^\/api\/preview\/\d+\/_wt\/([0-9a-f]{64})(?:\/|$)/.exec(path)?.[1] || ''; }
  function stripPath(path) { return path.replace(/^\/_wt\/[0-9a-f]{64}(?=\/|$)/, '') || '/'; }
  return { authenticate, stripQuery, mint, pathCapability, stripPath };
}

module.exports = { createPreviewAuth };

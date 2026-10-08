'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const { execFileSync, spawn } = require('child_process');
const { isBlockedTunnelIp } = require('./network');
const { isValidPID, killPid } = require('./process');
const { sendErr } = require('./errors');
const { findCloudflared, ensureCloudflared } = require('../cloudflared');
function createTunnelService(options) {
  const { app, checkPin, dataDir: DATA_DIR, allowFullFs: ALLOW_FULL_FS, licenseStatus } = options;
  const licenseLib = { status: licenseStatus };

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
      // Explicit local targets are the default tunnel use case. Keep the
      // loopback block for arbitrary LAN hostnames that resolve back to us.
      const isLocalTarget = ['localhost', '127.0.0.1', '::1'].includes(host);
      // Metadata/link-local endpoints beyond the obvious one (all unbracketed —
      // matching happens against the normalized host).
      const blockedHosts = ['169.254.169.254', 'metadata.google.internal', 'instance-data',
        'metadata.google.internal.', '100.100.100.200', '192.0.0.192', 'fd00:ec2::254'];
      if (blockedHosts.includes(host) || isBlockedTunnelIp(host, { allowLoopback: isLocalTarget })) return res.status(400).json({ error: 'url host blocked (SSRF)' });
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
          if (isBlockedTunnelIp(a.address, { allowLoopback: isLocalTarget })) return res.status(400).json({ error: 'url host resolves to a blocked address (SSRF)' });
        }
      } catch {
        if (ipLike) return res.status(400).json({ error: 'url host could not be verified (SSRF)' });
      }
      if (host === '0.0.0.0' || host === '::') return res.status(400).json({ error: 'url host is not connectable' });
      // Allow only local URLs unless ALLOW_FULL_FS true (admin opt-in for LAN tunneling)
      if (!ALLOW_FULL_FS && !isLocalTarget) {
        return res.status(400).json({ error: 'url must be localhost (use ALLOW_FULL_FS=true to allow LAN)' });
      }
      if (u.port && (Number(u.port) < 1 || Number(u.port) > 65535)) return res.status(400).json({ error: 'invalid port' });
    } catch {
      return res.status(400).json({ error: 'invalid url' });
    }

    // License cap: Free allows 2 concurrent tunnels once billing is set up.
    // Counts live entries only, so a recycled PID never consumes a slot.
    try {
      const _lic = licenseLib.status();
      if (_lic.enforce && _lic.limits.tunnels !== Infinity) {
        let _live = 0;
        for (const _t of tunnels.values()) if (!_t.dead) _live++;
        if (_live >= _lic.limits.tunnels) {
          return res.status(402).json({ error: `Free plan allows ${_lic.limits.tunnels} concurrent tunnels — upgrade to Pro for unlimited`, upgrade: true });
        }
      }
    } catch {}

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
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(tunnelSweep);
    for (const entry of tunnels.values()) {
      try {
        if (entry.proc) {
          try { entry.proc.kill('SIGTERM'); } catch {}
          if (entry.proc.pid) killPid(entry.proc.pid);
        } else if (sameCloudflaredProcess(entry)) {
          killPid(entry.pid);
        }
      } catch {}
    }
    tunnels.clear();
    tunnelRestarts.clear();
  }
  function hasPid(pid) {
    return [...tunnels.values()].some(entry => entry.pid === pid);
  }
  return { loadTunnels, hasPid, dispose };
}

module.exports = { createTunnelService };

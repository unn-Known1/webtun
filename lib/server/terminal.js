'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const { execFileSync, execSync } = require('child_process');
const { getValidExecutable, buildSessionEnv, isValidPID } = require('./process');
function createTerminalService(options) {
  const { app, wss, pty, auth, paths, port: PORT, dataDir: DATA_DIR, shell: SHELL, workspaceRoot: WORKSPACE_ROOT, getPreviewClients } = options;
  const { checkPin, getSession, rawPinAllowed, constantTimeEqual, wsTokenValid } = auth;
  const { realPath } = paths;
  const previewWSS = { get clients() { return getPreviewClients(); } };

  // ── Session persistence ──────────────────────────────────────────────
  let TMUX = options.tmux !== undefined ? options.tmux : (() => { try { const p = execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); return getValidExecutable(p); } catch { return null; } })();
  const TMUX_PREFIX = 'wt-webtun-'; // namespaced to avoid collision with user wt-* (F14)
  function getTMUX() {
    if (!TMUX && options.tmux === undefined) { try { const p = execSync('command -v tmux', { stdio: ['ignore','pipe','ignore'] }).toString().trim(); TMUX = getValidExecutable(p); } catch { TMUX = null; } }
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

  let sessionLabels = new Map();
  function loadSessionLabels() {
    try {
      const f = path.join(DATA_DIR, '.session-labels.json');
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (data && typeof data === 'object') sessionLabels = new Map(Object.entries(data));
      }
    } catch {}
  }
  function saveSessionLabels() {
    try {
      const f = path.join(DATA_DIR, '.session-labels.json');
      const obj = {};
      for (const [k, v] of sessionLabels) obj[k] = v;
      fs.writeFileSync(f, JSON.stringify(obj, null, 2), { mode: 0o600 });
    } catch {}
  }
  loadSessionLabels();

  function findExternalShellProcesses() {
    if (os.platform() === 'win32') return [];
    try {
      const ourPids = new Set();
      ourPids.add(process.pid);
      for (const [, entry] of ptySessions) {
        if (entry && entry.proc && entry.proc.pid) ourPids.add(entry.proc.pid);
      }
      const out = execFileSync('ps', ['-eo', 'pid,ppid,tty,stat,comm'], { encoding: 'utf8', timeout: 3000 });
      const lines = out.split('\n').slice(1);
      const shells = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const tty = parts[2];
        const comm = (parts[4] || '').toLowerCase();
        if (!pid || pid === 1 || ourPids.has(pid) || ourPids.has(ppid)) continue;
        if (['bash', 'zsh', 'fish', 'sh'].includes(comm) && tty !== '?' && tty !== '-') {
          const cwd = resolvePtyCwd(pid) || '';
          shells.push({
            id: `proc-${pid}`,
            name: `${comm} (PID ${pid}, ${tty})`,
            cwd,
            command: comm,
            attached: 1,
            label: sessionLabels.get(`proc-${pid}`) || '',
            type: 'process',
            external: true,
            source: 'system'
          });
        }
      }
      return shells;
    } catch {
      return [];
    }
  }

  function tmuxSessionExists(name) {
    try { execFileSync(TMUX, ['has-session', '-t', name], { stdio: 'ignore' , timeout: 5000}); return true; } catch { return false; }
  }

  app.get('/api/sessions', checkPin, (req, res) => {
    const tmuxBin = getTMUX();
    if (tmuxBin) {
      try {
        const out = execFileSync(tmuxBin, ['list-sessions', '-F', '#{session_name}\t#{pane_current_path}\t#{pane_current_command}\t#{session_attached}\t#{pane_pid}'], { encoding: 'utf8' , timeout: 5000}).trim();
        const rawLines = out.split('\n').filter(Boolean);
        const sessions = [];
        for (const line of rawLines) {
          const parts = line.split('\t');
          const s = parts[0] || '';
          let cwd = parts[1] || '';
          const command = parts[2] || '';
          const attached = parseInt(parts[3] || '0', 10);
          const panePid = parseInt(parts[4] || '0', 10);
          if (!cwd && panePid > 0) {
            cwd = resolvePtyCwd(panePid) || '';
          }
          const k = tmuxKind(s);
          let id;
          let isExt = false;
          let source = 'webtun';
          if (k === 'ours') {
            id = s.slice((TMUX_PREFIX + Number(PORT) + '-').length);
          } else if (k === 'legacy') {
            id = s.startsWith(TMUX_PREFIX) ? s.slice(TMUX_PREFIX.length) : s.slice(3);
          } else {
            // External tmux session (user-created, SSH, scripts, or another port)
            id = s;
            isExt = true;
            source = k === 'foreign' ? 'webtun-peer' : 'external';
          }
          sessions.push({
            id,
            name: s,
            cwd,
            command,
            attached,
            label: sessionLabels.get(id) || sessionLabels.get(s) || '',
            type: 'tmux',
            external: isExt,
            source
          });
        }
        // Merged listing: getTMUX() flips null→found mid-run, which used to
        // hide pre-existing in-memory sessions (and re-route the same
        // sessionId to another backend). Include both, tmux first.
        const seen = new Set(sessions.map(s => s.id));
        for (const [id, entry] of ptySessions) {
          if (!seen.has(id) && entry && !entry.exited) {
            const cwd = entry.proc ? resolvePtyCwd(entry.proc.pid) || '' : '';
            sessions.push({ id, name: tmuxOwnName(id), cwd, attached: entry.attached || 0, createdAt: entry.createdAt, label: sessionLabels.get(id) || '', type: 'pty', external: false, source: 'webtun' });
          }
        }
        return res.json({ tmux: true, sessions });
      } catch {
        return res.json({ tmux: true, sessions: [] });
      }
    }
    // In-memory sessions (no tmux)
    const sessions = [];
    for (const [id, entry] of ptySessions) {
      if (entry && !entry.exited) {
        const cwd = entry.proc ? resolvePtyCwd(entry.proc.pid) || '' : '';
        sessions.push({ id, name: tmuxOwnName(id), cwd, attached: entry.attached || 0, createdAt: entry.createdAt, label: sessionLabels.get(id) || '', type: 'pty', external: false, source: 'webtun' });
      }
    }
    const extProcs = findExternalShellProcesses();
    sessions.push(...extProcs);
    res.json({ tmux: false, sessions });
  });

  app.post('/api/sessions/:id/label', checkPin, (req, res) => {
    const raw = req.params.id || '';
    const id = raw.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!id) return res.status(400).json({ error: 'invalid session id' });
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
    if (label) sessionLabels.set(id, label);
    else sessionLabels.delete(id);
    saveSessionLabels();
    broadcastClientEvent({ event: 'sessions-changed' });
    res.json({ success: true, id, label });
  });

  app.delete('/api/sessions/:id', checkPin, (req, res) => {
    const raw = req.params.id || '';
    const id = raw.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!id || id.length > 64) {
      return res.status(400).json({ error: 'invalid session id' });
    }
    if (TMUX) {
      // Own namespace first, then legacy names for migration, and exact name for external sessions.
      const tryNames = [...tmuxAdoptableNames(id)];
      if (tmuxSessionExists(id) && !tryNames.includes(id)) {
        tryNames.push(id);
      }
      let found = false;
      for (const n of tryNames) {
        if (tmuxSessionExists(n)) {
          found = true;
          try { execFileSync(TMUX, ['kill-session', '-t', n], { stdio: 'ignore' , timeout: 5000}); } catch {}
        }
      }
      const entry = ptySessions.get(id);
      if (entry) {
        try { if (entry.proc) entry.proc.kill(); } catch {}
        ptySessions.delete(id);
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
    const id = raw.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!id || id.length > 64) {
      return res.status(400).json({ error: 'invalid session id' });
    }
    // tmux sessions report the active pane's directory directly, whatever the
    // shell is (no OSC 7 cooperation needed).
    const tmuxBin = getTMUX();
    if (tmuxBin) {
      const checkNames = [...tmuxAdoptableNames(id)];
      if (tmuxSessionExists(id) && !checkNames.includes(id)) {
        checkNames.push(id);
      }
      for (const n of checkNames) {
        try {
          let out = execFileSync(tmuxBin, ['display-message', '-p', '-t', n, '-F', '#{pane_current_path}'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
          if (!out) {
            const pid = parseInt(execFileSync(tmuxBin, ['display-message', '-p', '-t', n, '-F', '#{pane_pid}'],
              { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(), 10);
            if (pid > 0) out = resolvePtyCwd(pid) || '';
          }
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
    if (!auth.pin) return;
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
      const rawFwdHost = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      const fwdHost = rawFwdHost.replace(/:\d+$/, '');
      let originHost = '';
      try { originHost = new URL(origin).host; } catch {}
      const cleanHost = host.replace(/:\d+$/, '');
      const cleanOriginHost = originHost.replace(/:\d+$/, '');

      const allowedOrigin =
        cleanOriginHost === cleanHost ||
        (fwdHost && cleanOriginHost === fwdHost) ||
        origin === `http://${host}` || origin === `https://${host}` ||
        (fwdHost && (origin === `http://${fwdHost}` || origin === `https://${fwdHost}`)) ||
        origin === 'http://localhost' || origin === 'https://localhost' ||
        origin === 'http://127.0.0.1' || origin === 'https://127.0.0.1' ||
        cleanOriginHost === 'localhost' || cleanOriginHost === '127.0.0.1' ||
        cleanOriginHost.endsWith('.run.app') ||
        cleanOriginHost.endsWith('.googleusercontent.com') ||
        cleanOriginHost.endsWith('.trycloudflare.com') ||
        ALLOWED_WS_ORIGINS.has(origin);

      if (!allowedOrigin) {
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
    if (auth.pin) {
      const t = typeof token === 'string' ? token : '';
      const _s = t ? getSession(t) : null;
      const _pinOk = t && constantTimeEqual(t, auth.pin) && rawPinAllowed({ socket: req.socket, headers: req.headers, get ip() { return req.socket.remoteAddress; } });
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
      const sanitized = rawSession.replace(/[^a-zA-Z0-9_.-]/g, '');
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

    const sessionEnv = buildSessionEnv(SHELL);

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
        const isExactTmux = tmuxSessionExists(sessionId);
        const exists = candidates.some(tmuxSessionExists) || isExactTmux;
        // Adopt an existing session: own namespace first, then exact external session if specified, then legacy
        let effectiveName = tmuxName;
        if (!tmuxSessionExists(tmuxName)) {
          if (isExactTmux) {
            effectiveName = sessionId;
          } else {
            const found = candidates.slice(1).find(tmuxSessionExists);
            if (found) effectiveName = found;
          }
        }

        if (exists) {
          // Never force the window size here. resize-window flips the session
          // to window-size manual AND over-claims tmux's status-bar row: the
          // pane ends up as tall as the client, so the inner app's last row
          // hides underneath the status bar (e.g. a TUI footer). tmux auto-fits
          // attached clients on its own (window minus status line); just make
          // sure sessions stuck in manual by older builds go back to auto-fit.
          try { execFileSync(TMUX, ['set-option', '-t', effectiveName, 'window-size', 'latest'], { stdio: 'ignore' , timeout: 5000}); } catch {}
          // Let wheel/touch reach tmux (copy-mode history scroll, and mouse
          // events for apps that requested them). Without it the web client is
          // stuck: alternate-screen buffers have no xterm scrollback to scroll.
          try { execFileSync(TMUX, ['set-option', '-t', effectiveName, 'mouse', 'on'], { stdio: 'ignore' , timeout: 5000}); } catch {}
          // attach-session has no -e option. Set the session environment with
          // the standalone command so reconnect also works with older tmux.
          try { execFileSync(TMUX, ['set-environment', '-t', effectiveName, 'DISABLE_SCREEN', '1'], { stdio: 'ignore', timeout: 5000 }); } catch {}
          proc = pty.spawn(TMUX, ['attach-session', '-t', effectiveName], {
            name: 'xterm-256color', cols, rows, cwd,
            env: sessionEnv
          });
        } else {
          proc = pty.spawn(TMUX, ['new-session', '-s', tmuxName, '-e', 'DISABLE_SCREEN=1'], {
            name: 'xterm-256color', cols, rows, cwd,
            env: { ...sessionEnv, SHELL }
          });
          ownTmuxSessions.add(tmuxName);
          // Pin auto-fit on our own sessions so a global tmux.conf
          // (window-size largest/manual) can't reintroduce the covered-row
          // bug described above.
          try { execFileSync(TMUX, ['set-option', '-t', tmuxName, 'window-size', 'latest'], { stdio: 'ignore' , timeout: 5000}); } catch {}
          // Own sessions get mouse on for the same reason as the adopt branch:
          // tmux only forwards wheel/mouse to apps (and copy-mode scrolls) when
          // the option is set.
          try { execFileSync(TMUX, ['set-option', '-t', tmuxName, 'mouse', 'on'], { stdio: 'ignore' , timeout: 5000}); } catch {}
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
    let procExited = false;
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
      if (procExited) return;
      procExited = true;
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
      // Resize/input frames may already be queued when the shell exits.
      if (procExited || ws.readyState !== WebSocket.OPEN) return;
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
        // node-pty can close its native descriptor before its exit event arrives.
        // Retire this PTY once instead of repeatedly issuing ioctl on a dead fd.
        if (e.code === 'EBADF' || /\bEBADF\b/.test(e.message || '')) {
          procExited = true;
          clearInterval(drainCheck);
          if (useInMemory) {
            const prev = ptySessions.get(sessionId);
            ptySessions.set(sessionId, { proc: null, exited: true, createdAt: (prev && prev.createdAt) || Date.now(), lastActive: Date.now(), attached: 0, exitCode: 1 });
          }
          send(0x02, 'Terminal connection lost. Reconnect to resume.\r\n');
          ws.close(1011, 'Terminal unavailable');
          try { proc.kill(); } catch {}
          return;
        }
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
  function startNamespace() {
    const prior = readTmuxClaim();
    if (prior && prior.pid !== process.pid && tmuxClaimLive(prior)) {
      tmuxSweepsArmed = false;
      console.log(`  tmux namespace owned by live PID ${prior.pid} — orphan sweeps disabled`);
    } else {
      writeTmuxClaim();
      cleanupOrphanTmuxSessions();
    }
  }
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(wsAuthSweep);
    clearInterval(wsAuthFailsSweep);
    clearInterval(ptySessionSweep);
    for (const ws of wss.clients) { try { ws.terminate(); } catch {} }
    if (TMUX && (ownTmuxSessions.size || tmuxSweepsArmed)) {
      try {
        const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        // Kill owned sessions and eligible legacy orphans only. Foreign
        // namespaces and unowned sessions with attached clients are spared.
        for (const s of out.split('\n')) {
          const k = tmuxKind(s);
          if (k === null || k === 'foreign') continue;
          if (ownTmuxSessions.has(s)) {
            try { execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore', timeout: 5000 }); } catch {}
          } else if (tmuxSweepsArmed && k === 'legacy' && !tmuxHasClients(s)) {
            try { execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'ignore', timeout: 5000 }); } catch {}
          }
        }
      } catch {}
    }
    releaseTmuxClaim();
    for (const entry of ptySessions.values()) {
      try { entry.proc.kill(); } catch {}
    }
    ptySessions.clear();
  }
  return { getTMUX, tmuxKind, tmuxClaimPath, readTmuxClaim, writeTmuxClaim,
    releaseTmuxClaim, tmuxClaimLive, startNamespace, dispose,
    broadcastClientEvent, pushSessionRevoked, closeInvalidSockets };
}

module.exports = { createTerminalService };

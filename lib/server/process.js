'use strict';

const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

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

function buildSessionEnv(SHELL) {
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
    SHELL,
    // The studio's interactive-shell persistence wrapper (screen/litterm via
    // /settings/.sessionrc) renders its own scrollback, so the pane it would
    // strip leaves no tmux history for WebTun to scroll. WebTun runs its own
    // tmux persistence, so opt the panes out of the platform wrapper.
    DISABLE_SCREEN: '1'
  };
  if (process.env.NODE_ENV) safe.NODE_ENV = process.env.NODE_ENV;
  // Preserve common terminal/locale vars when present
  for (const k of ['LC_ALL', 'LC_CTYPE', 'TERM_PROGRAM', 'COLORFGBG']) {
    if (process.env[k]) safe[k] = process.env[k];
  }
  return safe;
}

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

function isValidPID(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

// Clean up dead tmux sessions from previous runs on startup

module.exports = { getValidExecutable, resolveShell, killPid, buildSessionEnv, spawnRead, isValidPID };

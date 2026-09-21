#!/usr/bin/env node

'use strict';

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
  WebTun — Web Terminal with Cloudflare Tunnel

  Usage:
    webtun [options]

  Options:
    --port, -p <port>     Port to listen on (default: 3000 or $PORT)
    --host, -h <host>     Host to bind to (default: 0.0.0.0 or $HOST)
    --pin <pin>           PIN for authentication (default: $PIN)
    --tunnel, -t          Start a Cloudflare Tunnel for remote access
    --help, -H              Show this help message
    --version, -v           Show version number
    (note: -h means --host, not help)

  Environment Variables:
    PORT                  Server port (default: 3000)
    HOST                  Bind address (default: 0.0.0.0)
    PIN                   Authentication PIN (empty = no auth)
    SHELL                 Shell to use (default: PowerShell on Windows, bash/sh elsewhere)
    WORKSPACE_ROOT        Root directory for file operations (default: ~)
    ALLOW_FULL_FS         set to "false" to confine the File API to WORKSPACE_ROOT
    TRUST_PROXY           set to "true" when behind a reverse proxy (X-Forwarded-For)
    WEBTUN_SHELL          override the shell on Windows (e.g. /usr/bin/bash for Git Bash)
    ALLOWED_ORIGINS       extra WebSocket origins, comma-separated (custom hostnames)
    PREVIEW_PORTS         restrict app-preview targets, comma-separated (default: any)
    XDG_CONFIG_HOME       where runtime state lives (default: ~/.config/webtun)

  Examples:
    webtun                          Start on default port
    webtun --port 8080              Start on port 8080
    webtun --pin secret123          Start with PIN protection
    webtun --tunnel                 Start with Cloudflare Tunnel
    webtun -p 4000 -t               Port 4000 + tunnel
    PORT=4000 webtun               Start on port 4000 via env var
`);
}

function parseArgs(argv) {
  const opts = { tunnel: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-H') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      console.log(require('../package.json').version);
      process.exit(0);
    }
    if (arg === '--port' || arg === '-p') {
      if (!argv[i+1] || argv[i+1].startsWith('-')) {
        console.error('Error: --port requires a value');
        process.exit(1);
      }
      opts.port = parseInt(argv[++i], 10);
      if (isNaN(opts.port) || opts.port < 1 || opts.port > 65535) {
        console.error('Error: --port requires a numeric value 1-65535');
        process.exit(1);
      }
    } else if (arg === '--host' || arg === '-h') {
      if (!argv[i+1] || argv[i+1].startsWith('-')) {
        console.error('Error: --host requires a value');
        process.exit(1);
      }
      opts.host = argv[++i];
    } else if (arg.startsWith('--pin=')) {
      // Explicit form — the only way to pass a PIN that starts with "-".
      process.env.PIN = arg.slice('--pin='.length);
    } else if (arg === '--pin') {
      // Reject -led values outright: `--pin -tunnel` (a typo for --tunnel) used
      // to silently set PIN="-tunnel" and leave the instance open.
      const next = argv[i+1];
      if (next === undefined || next.startsWith('-')) {
        console.error('Error: --pin requires a value');
        console.error('       For a PIN starting with "-", use --pin=<value> or set PIN=<value>.');
        process.exit(1);
      }
      process.env.PIN = next;
      i++;
    } else if (arg === '--tunnel' || arg === '-t') {
      opts.tunnel = true;
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

async function startTunnel(port) {
  const { spawn } = require('child_process');
  const { findCloudflared, ensureCloudflared } = require('../lib/cloudflared');

  let bin = findCloudflared();
  if (!bin) {
    // Explicit --tunnel request = user-initiated: fetch on demand (one-time).
    console.log('  cloudflared not found — downloading (one-time setup)…');
    try {
      bin = await ensureCloudflared(msg => console.log('  ' + msg));
    } catch (e) {
      console.error('\n  Error: cloudflared is not installed (' + e.message + ').');
      console.error('  Install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/');
      process.exitCode = 1; // the tunnel the user asked for did not start
      return;
    }
  }

  console.log('  Starting Cloudflare Tunnel...');

  const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let tunnelUrl = null;

  // Don't wait forever for a URL that will never appear (cloudflared can fail
  // after printing its banner); surface the log tail and a non-zero status.
  const urlTimer = setTimeout(() => {
    if (tunnelUrl) return;
    console.error('  Error: no public URL after 15s — cloudflared did not start a tunnel.');
    process.exitCode = 1;
  }, 15000);
  if (urlTimer.unref) urlTimer.unref();

  const handler = data => {
    const text = data.toString();
    // Also match named-tunnel hostnames (cfargotunnel.com); the old pattern
    // only knew trycloudflare.com, so the URL line was missed entirely.
    const m = text.match(/https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|cfargotunnel\.com)/i);
    if (m && !tunnelUrl) {
      tunnelUrl = m[0];
      try { clearTimeout(urlTimer); } catch {}
      console.log('');
      console.log('  ┌─────────────────────────────────────────────────────┐');
      console.log('  │  Public URL (share this!):                          │');
      console.log(`  │  ${tunnelUrl}`);
      console.log('  └─────────────────────────────────────────────────────┘');
      console.log('');
    }
  };

  proc.stdout.on('data', handler);
  proc.stderr.on('data', handler);

  proc.on('error', (err) => {
    console.error('  Tunnel error:', err.message);
  });

  proc.on('exit', (code) => {
    if (code !== 0 && !tunnelUrl) {
      console.error('  Tunnel exited with code', code);
      process.exitCode = 1;
    }
    try { clearTimeout(urlTimer); } catch {}
  });

  const stop = () => {
    try { proc.kill('SIGTERM'); } catch {}
    // Preserve a failure recorded earlier (tunnel URL timeout, non-zero
    // cloudflared exit) instead of always reporting success.
    process.exit(process.exitCode || 0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Don't orphan cloudflared on normal exit either (untracked by server manager)
  process.on('exit', () => { try { proc.kill('SIGTERM'); } catch {} });
}

function isAddrInUse(err) {
  return /EADDRINUSE|address already in use/i.test(String(err && err.message || ''));
}

// Probe the effective bind host for a free port starting at `startPort`.
// Probing only 127.0.0.1 while the server binds 0.0.0.0 misdiagnosed a
// LAN-held port as free and then failed at listen() with EADDRINUSE.
function findFreePort(startPort, maxTries = 20, host) {
  const net = require('net');
  const probeHost = host || process.env.HOST || '127.0.0.1';
  return new Promise((resolve, reject) => {
    const tryPort = (port, attempt) => {
      if (attempt >= maxTries || port > 65535) {
        return reject(new Error(`No free port found between ${startPort} and ${port}`));
      }
      const tester = net.createServer();
      tester.once('error', () => { tester.close(); tryPort(port + 1, attempt + 1); });
      tester.once('listening', () => tester.close(() => resolve(port)));
      tester.listen(port, probeHost);
    };
    tryPort(startPort, 0);
  });
}

// Wait for the HTTP API to answer before starting a tunnel that points at it —
// a listening socket is not proof the app is ready to serve requests.
function waitForServer(port, timeoutMs = 5000) {
  const http = require('http');
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/auth/required`, res => {
        res.resume();
        // A 5xx means the port answers but the app is broken — that is not
        // "ready". Keep polling until the deadline rather than tunneling at
        // an error page.
        if (res.statusCode >= 500 && res.statusCode <= 599) {
          if (Date.now() > deadline) resolve(false);
          else setTimeout(check, 200);
          return;
        }
        resolve(true);
      });
      req.setTimeout(2000, () => { try { req.destroy(); } catch {} });
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(check, 200);
      });
    };
    check();
  });
}

const opts = parseArgs(args);
const { startServer, PORT } = require('../server');

// PORT is already validated (1-65535) in server.js — an invalid $PORT used to
// reach listen() verbatim from the CLI path and fail with a cryptic error.
let listenPort = opts.port || PORT;

function boot(port, allowPortFallback) {
  return startServer({ ...opts, port }).then(() => {
    if (!opts.tunnel) return;
    return waitForServer(port).then(up => {
      if (!up) {
        console.error('  Error: server did not answer on port ' + port + ' — not starting the tunnel.');
        process.exitCode = 1;
        return;
      }
      startTunnel(port);
    });
  }).catch(err => {
    if (allowPortFallback && isAddrInUse(err)) {
      // An implicit port (default or $PORT) may simply be busy: move up the range
      // the same way the Electron app does. An explicit --port is never overridden.
      return findFreePort(port + 1, 20, opts.host)
        .then(next => {
          console.warn(`  Port ${port} is in use — using ${next} instead.`);
          listenPort = next;
          return boot(next, false);
        })
        .catch(() => {
          console.error(`Failed to start server: port ${port} is in use and no free port was found.`);
          console.error(`  Free it, or pick another: webtun --port 4000`);
          process.exit(1);
        });
    }
    if (isAddrInUse(err)) {
      console.error(`Failed to start server: port ${port} is already in use.`);
      console.error('  Free it, or pick another with --port <n>.');
      process.exit(1);
    }
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

// Only auto-move ports when the port was implicit (default or $PORT) — an
// explicit --port is a request, not a suggestion.
boot(listenPort, !opts.port);

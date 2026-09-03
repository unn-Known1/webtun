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
    } else if (arg === '--pin') {
      // Consume the next argv unconditionally (except other known flags) so
      // dash-led PINs like -s3cret work; use PIN=-s3cret env for anything else.
      const KNOWN_FLAGS = ['--port','-p','--host','-h','--pin','--tunnel','-t','--help','-H','--version','-v'];
      if (argv[i+1] === undefined || KNOWN_FLAGS.includes(argv[i+1])) {
        console.error('Error: --pin requires a value');
        process.exit(1);
      }
      process.env.PIN = argv[++i] || '';
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

function startTunnel(port) {
  const { spawn } = require('child_process');
  const { findCloudflared } = require('../server');

  const bin = findCloudflared();
  if (!bin) {
    console.error('\n  Error: cloudflared is not installed.');
    console.error('  Install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/');
    console.error('  Or re-run: npm install webtun  (postinstall downloads it)');
    return;
  }

  console.log('  Starting Cloudflare Tunnel...');

  const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let tunnelUrl = null;

  const handler = data => {
    const text = data.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnelUrl) {
      tunnelUrl = m[0];
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
    }
  });

  const stop = () => {
    try { proc.kill('SIGTERM'); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Don't orphan cloudflared on normal exit either (untracked by server manager)
  process.on('exit', () => { try { proc.kill('SIGTERM'); } catch {} });
}

const opts = parseArgs(args);
const { startServer, PORT } = require('../server');

const listenPort = opts.port || PORT;

startServer(opts).then(() => {
  if (opts.tunnel) {
    startTunnel(listenPort);
  }
}).catch(err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

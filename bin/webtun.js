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
    --help                Show this help message
    --version             Show version number

  Environment Variables:
    PORT                  Server port (default: 3000)
    HOST                  Bind address (default: 0.0.0.0)
    PIN                   Authentication PIN (empty = no auth)
    SHELL                 Shell to use (default: /bin/bash or system shell)
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
      opts.port = parseInt(argv[++i], 10);
      if (isNaN(opts.port)) {
        console.error('Error: --port requires a numeric value');
        process.exit(1);
      }
    } else if (arg === '--host' || arg === '-h') {
      opts.host = argv[++i];
    } else if (arg === '--pin') {
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
  const { execSync, spawn } = require('child_process');
  const os = require('os');

  // Check if cloudflared is installed
  try {
    if (os.platform() === 'win32') {
      execSync('where cloudflared', { stdio: 'ignore' });
    } else {
      execSync('command -v cloudflared', { stdio: 'ignore' });
    }
  } catch {
    console.error('\n  Error: cloudflared is not installed.');
    console.error('  Install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/');
    return;
  }

  console.log('\n  Starting Cloudflare Tunnel...');

  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
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

  // Cleanup on exit
  process.on('SIGINT', () => {
    try { proc.kill('SIGTERM'); } catch {}
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    try { proc.kill('SIGTERM'); } catch {}
    process.exit(0);
  });
}

const opts = parseArgs(args);
const { startServer } = require('../server');

startServer(opts).then(() => {
  if (opts.tunnel) {
    startTunnel(opts.port || 3000);
  }
}).catch(err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

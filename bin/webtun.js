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
    PORT=4000 webtun               Start on port 4000 via env var
`);
}

function parseArgs(argv) {
  const opts = {};
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
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(args);
const { startServer } = require('../server');

startServer(opts).catch(err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

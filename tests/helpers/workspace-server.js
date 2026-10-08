'use strict';
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const WebSocket = require('ws');
const { createAuthService } = require('../../lib/server/auth');
const { createPathAccess } = require('../../lib/server/paths');
const { registerFileRoutes } = require('../../lib/server/files');
const { registerGitRoutes } = require('../../lib/server/git');
const { createTerminalService } = require('../../lib/server/terminal');
const { createTunnelService } = require('../../lib/server/tunnels');

// The HTTP, file, Git, auth, and WS handlers are the real services. Only the
// operating-system shell is substituted so tests cannot affect real sessions.
async function createWorkspaceServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webtun-test-'));
  const dataDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(dataDir); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'alpha.txt'), 'alpha on disk\n');
  await fs.writeFile(path.join(workspace, 'beta.txt'), 'beta on disk\n');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const events = [];
  const pass = (req,res,next) => next();
  const licenseStatus = () => options.license || { enforce: false };
  let terminal;
  const auth = createAuthService({
    app, pin: options.pin || '', port: options.port || 0, envPath: path.join(dataDir,'.env'),
    authRateLimiter: pass, licenseStatus, now: options.now, timers: options.timers,
    events: {
      broadcast: event => { events.push(event); terminal?.broadcastClientEvent(event); },
      revoke: token => terminal?.pushSessionRevoked(token),
      invalidate: reason => terminal?.closeInvalidSockets(reason),
    },
  });
  const paths = createPathAccess({ workspaceRoot: workspace, allowFullFs: false });
  const shells = [];
  class TestPty extends EventEmitter {
    constructor() { super(); this.pid = 900000 + shells.length; this.killed = false; this.inputs = []; this.sizes = []; }
    onData(fn) { this.on('data',fn); return { dispose: () => this.off('data',fn) }; }
    onExit(fn) { this.on('exit',fn); return { dispose: () => this.off('exit',fn) }; }
    write(text) { this.inputs.push(text); this.emit('data',text); }
    resize(cols,rows) { this.sizes.push([cols,rows]); }
    pause() {}
    resume() {}
    kill() { if (!this.killed) { this.killed=true; this.emit('exit',{ exitCode: 0 }); } }
  }
  terminal = createTerminalService({
    app, wss, auth, paths, port: 65530, dataDir, shell: '/bin/sh', workspaceRoot: workspace,
    getPreviewClients: () => [], tmux: options.tmux !== undefined ? options.tmux : null,
    pty: { spawn: (executable, args, options) => { const shell = new TestPty(); shell.executable = executable; shell.args = args; shell.options = options; shells.push(shell); return shell; } },
  });
  registerFileRoutes({ app, checkPin: auth.checkPin, rateLimiter: pass, auth, paths, workspaceRoot: workspace, allowFullFs: false });
  registerGitRoutes({ app, checkPin: auth.checkPin, rateLimiter: pass, paths, workspaceRoot: workspace, allowFullFs: false });
  const tunnels = createTunnelService({ app, checkPin: auth.checkPin, dataDir, allowFullFs: false, licenseStatus });
  app.get('/api/home',auth.checkPin,(req,res) => res.json({ home: workspace, hostname: 'test-workspace', platform: process.platform }));
  app.get('/api/license/status',auth.checkPin,(req,res) => res.json({ configured: false, enforce: false, plan: 'community', limits: {} }));
  app.get('/api/history',auth.checkPin,(req,res) => res.json({ items: [], max: 50 }));
  app.get('/api/system',auth.checkPin,(req,res) => res.json({
    hostname: 'test-workspace', platform: process.platform, uptime: 100,
    cpu: { model: 'test CPU', count: 4, usage: 8, loadAvg: [0.1,0,0] },
    memory: { total: 8e9, used: 2e9, free: 6e9, percent: 25 },
    gpus: [], disk: [], processes: [],
  }));
  app.get('/docs',(req,res) => res.sendFile(path.resolve('public/docs.html')));
  app.use(express.static(path.resolve('public')));
  await new Promise(resolve => server.listen(options.port || 0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(route, { token, method = 'GET', body, remote = false } = {}) {
    const headers = {};
    if (token) headers['x-pin-token'] = token;
    if (remote) headers['x-forwarded-for'] = '203.0.113.50';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function close() {
    tunnels.dispose(); terminal.dispose(); auth.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => wss.close(resolve));
    await fs.rm(root,{ recursive: true, force: true });
  }
  return { app, server, auth, wss, base, root, workspace, dataDir, shells, events, request, close };
}
module.exports = { createWorkspaceServer };

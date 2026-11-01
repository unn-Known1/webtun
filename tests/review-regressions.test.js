'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function load(file, overrides, globals = {}) {
  const filename = path.resolve(file), nativeRequire = createRequire(filename), module = { exports: {} };
  const context = { module, exports: module.exports, require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name),
    __dirname: path.dirname(filename), __filename: filename, process, console, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, ...globals };
  vm.runInNewContext('(function(){' + fs.readFileSync(filename, 'utf8') + '\n})()', context, { filename });
  return module.exports;
}

test('Electron ready starts the child server and opens a window; a second instance does neither', async () => {
  for (const lock of [true, false]) {
    let ready, forks = 0, loaded = '';
    const app = { requestSingleInstanceLock: () => lock, on() {}, quit() {}, whenReady: () => ({ then(fn) { ready = fn; } }) };
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const electron = { app, ipcMain: { handle() {} }, crashReporter: { start() {} }, dialog: { showErrorBox(_title, text) { throw Error(text); } },
      Menu: { buildFromTemplate: v => v, setApplicationMenu() {} },
      BrowserWindow: class { loadURL(url) { loaded = url; } on() {} } };
    load('electron/main.js', { electron, 'electron-squirrel-startup': false,
      child_process: { fork: () => { forks++; return child; } },
      net: { createServer: () => { const server = new EventEmitter(); server.listen = () => queueMicrotask(() => server.emit('listening')); server.close = cb => cb?.(); return server; } },
      http: { get: (_url, callback) => { queueMicrotask(() => callback({ statusCode: 200, resume() {} })); return { setTimeout() {}, on() {} }; } },
    }, { setTimeout: fn => { queueMicrotask(fn); return { unref() {} }; } });
    if (lock) { await ready(); assert.equal(forks, 1); assert.match(loaded, /^http:\/\/127\.0\.0\.1:\d+$/); }
    else { assert.equal(ready, undefined); assert.equal(forks, 0); assert.equal(loaded, ''); }
  }
});

test('Windows updater runs npm JavaScript with separate arguments for checks and actual installation', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'webtun npm launch '));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'npm-cli.js'), record = path.join(root, 'calls.jsonl');
  await fsp.writeFile(cli, `const fs=require('fs'); fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))+'\\n'); if(process.argv[2]==='view')console.log('2.4.1'); if(process.argv[2]==='list')console.log('webtun@2.4.0');`);
  const updater = load('lib/updater.js', {}, { process: { platform: 'win32', execPath: process.execPath, env: { npm_execpath: cli }, argv: [] } });
  assert.equal(await updater.fetchFromNpmCli('webtun', 'next'), '2.4.1');
  assert.equal(updater.isGlobalInstall('webtun'), true);
  assert.equal(updater.executeUpgrade({ packageName: 'webtun', targetVersion: '2.4.1', isGlobal: true, dryRun: false }), 0);
  const calls = (await fsp.readFile(record, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['view', 'webtun@next', 'version'], ['list', '-g', '--depth=0', 'webtun'], ['install', '-g', '--allow-scripts=webtun,node-pty', 'webtun@2.4.1']]);
});

test('a tunnel exiting while URL verification is pending cannot become a live entry', async () => {
  const routes = new Map(), files = new Map();
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (url, ...handlers) => routes.set(method + url, handlers.at(-1))]));
  const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.stdout.resume = proc.stderr.resume = proc.unref = proc.kill = () => {};
  let verification, entered;
  const verifying = new Promise(resolve => { entered = resolve; });
  const { createTunnelService } = load('lib/server/tunnels.js', {
    fs: { writeFileSync: (file, text) => files.set(file, text), chmodSync() {}, renameSync: (from, to) => files.set(to, files.get(from)) },
    dns: { promises: { lookup: async () => [{ address: '127.0.0.1' }] } },
    child_process: { spawn: () => proc },
    '../cloudflared': { findCloudflared: () => 'fake-cloudflared' },
    './process': { isValidPID: () => false, killPid: () => { throw Error('must not kill a stale PID'); } },
    './errors': { sendErr: (res, error) => res.status(500).json({ error: error.message }) },
  }, { fetch: () => { entered(); return new Promise(resolve => { verification = resolve; }); }, setInterval: () => ({ unref() {} }), clearInterval() {} });
  const service = createTunnelService({ app, checkPin() {}, dataDir: '/test-only', allowFullFs: false, licenseStatus: () => ({ enforce: false }) });
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const request = routes.get('post/api/tunnel')({ body: { url: 'http://127.0.0.1:8000' } }, response);
  // Let DNS validation finish before the fake process emits its URL.
  await new Promise(resolve => setImmediate(resolve));
  proc.stdout.emit('data', Buffer.from('https://example.trycloudflare.com'));
  await verifying;
  proc.exitCode = 1; proc.emit('exit', 1);
  verification({ ok: true }); await request;
  assert.equal(response.code, 500); assert.match(response.body.error, /exited/);
  const listing = { json(body) { this.body = body; } };
  await routes.get('get/api/tunnel')({}, listing); assert.equal(listing.body.tunnels.length, 0);
  assert.equal(files.has('/test-only/.tunnels.json'), false);
  service.dispose();
});

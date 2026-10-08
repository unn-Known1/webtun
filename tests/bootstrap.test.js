'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const net = require('net');

test('the composed server starts, serves the workspace, and shuts down cleanly', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'webtun-boot-'));
  const checkout = path.join(root,'app');
  const workspace = path.join(root,'workspace');
  const emptyPath = path.join(root,'empty-path');
  await fs.mkdir(checkout); await fs.mkdir(workspace); await fs.mkdir(emptyPath);
  // Copy only application files. A real checkout may hold legacy runtime data;
  // the startup migration must never read that data during a regression test.
  const repo = path.resolve(__dirname,'..');
  for (const file of ['server.js','package.json','lib','public']) {
    await fs.cp(path.join(repo,file),path.join(checkout,file),{ recursive: true });
  }
  await fs.symlink(path.join(repo,'node_modules'),path.join(checkout,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(workspace,'boot.txt'),'composed service\n');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let log = '';
  const child = spawn(process.execPath,['-e', "require('./server.js').startServer({host:'127.0.0.1'}).then(server=>process.send({port:server.address().port}))"],{
    cwd: checkout,
    env: { ...process.env, PATH: emptyPath, XDG_CONFIG_HOME: path.join(root,'config'), WORKSPACE_ROOT: workspace,
      ALLOW_FULL_FS: 'false', PIN: '', PORT: String(port), WEBTUN_LICENSE_PUBLIC_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' },
    stdio: ['ignore','pipe','pipe','ipc'],
  });
  child.stdout.on('data',chunk => { log += chunk; });
  child.stderr.on('data',chunk => { log += chunk; });
  const exited = new Promise(resolve => child.once('exit',(code,signal)=>resolve({ code,signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'),3000);
    await exited; clearTimeout(killTimer);
    await fs.rm(root,{ recursive: true,force: true });
  });
  const address = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not become ready: '+log)),10000);
    child.once('message',message => { clearTimeout(timer); resolve(message); });
    child.once('error',error => { clearTimeout(timer); reject(error); });
    child.once('exit',code => { clearTimeout(timer); reject(new Error('Server exited '+code+': '+log)); });
  });
  const base = 'http://127.0.0.1:'+address.port;
  async function json(route) {
    const response = await fetch(base+route);
    assert.equal(response.status,200,route+': '+log);
    return response.json();
  }
  assert.equal((await json('/api/auth/required')).required,false);
  assert.equal((await json('/api/version')).version,require('../package.json').version);
  assert.equal((await json('/api/files/read?path='+encodeURIComponent(path.join(workspace,'boot.txt')))).content,'composed service\n');
  assert.deepEqual((await json('/api/tunnel')).tunnels,[]);
  assert.equal((await fetch(base+'/api/git/status?path='+encodeURIComponent(workspace))).status,501);
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await fetch(base+'/docs')).status,200);
  child.kill('SIGTERM');
  assert.equal((await exited).code,0,log);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');
const { createWorkspaceServer } = require('./helpers/workspace-server');

async function fixture(t, options) {
  const f = await createWorkspaceServer(options);
  t.after(() => f.close());
  return f;
}
async function login(f,device) {
  const r = await f.request('/api/auth',{ method: 'POST', body: { pin: 'owner-pin',device }, remote: true });
  assert.equal(r.status,200); return r.body;
}

test('tunnel input and license checks run before downloading or spawning cloudflared', async t => {
  const f = await fixture(t,{ license: { enforce: true, limits: { tunnels: 0 } } });
  assert.deepEqual((await f.request('/api/tunnel')).body,{ tunnels: [] });
  for (const url of ['invalid','file:///etc/passwd','http://user:pass@localhost:3000','http://169.254.169.254']) {
    assert.equal((await f.request('/api/tunnel',{ method: 'POST', body: { url } })).status,400);
  }
  for (const url of ['http://127.0.0.1:8000','http://localhost:8000','http://[::1]:8000']) {
    assert.equal((await f.request('/api/tunnel',{ method: 'POST', body: { url } })).status,402);
  }
  assert.equal((await f.request('/api/tunnel?id=missing',{ method: 'DELETE' })).body.alreadyGone,true);
});

test('pending devices can poll, but cannot read files, approve themselves, or use raw PIN remotely', async t => {
  const f = await fixture(t,{ pin: 'owner-pin' });
  const first = await login(f,'owner'), second = await login(f,'new device');
  assert.match(first.token,/^[a-f0-9]{64}$/);
  assert.equal(second.pending,true);
  assert.equal((await f.request('/api/auth/me',{ token: second.token })).body.pending,true);
  assert.equal((await f.request('/api/files',{ token: second.token })).status,403);
  assert.equal((await f.request('/api/auth/sessions/'+second.token+'/approve',{ token: second.token,method:'POST' })).status,403);
  assert.equal((await f.request('/api/files',{ token:'owner-pin',remote:true })).status,403);
  assert.equal((await f.request('/api/auth/sessions/'+second.token+'/approve',{ token:first.token,method:'POST' })).status,200);
  assert.equal((await f.request('/api/files',{ token:second.token })).status,200);
  assert.equal((await f.request('/api/auth/sessions/'+second.token,{ token:first.token,method:'DELETE' })).status,200);
  assert.equal((await f.request('/api/auth/me',{ token:second.token })).status,401);
});

test('PIN approval persists first, revokes old devices, and grants the approver a new token', async t => {
  const f = await fixture(t,{ pin:'owner-pin' });
  const owner = await login(f,'owner'), other = await login(f,'other');
  await f.request('/api/auth/sessions/'+other.token+'/approve',{ token:owner.token,method:'POST' });
  const pending = await f.request('/api/pin',{ token:other.token,method:'POST',body:{ currentPin:'owner-pin',newPin:'replacement' } });
  assert.equal(pending.body.pending,true);
  assert.equal(f.auth.pin,'owner-pin');
  assert.equal((await f.request('/api/pin/approve',{ token:other.token,method:'POST' })).status,403);
  const approved = await f.request('/api/pin/approve',{ token:owner.token,method:'POST' });
  assert.equal(approved.status,200);
  assert.equal(f.auth.pin,'replacement');
  assert.equal((await f.request('/api/auth/me',{ token:owner.token })).status,401);
  assert.equal((await f.request('/api/auth/me',{ token:other.token })).status,401);
  assert.equal((await f.request('/api/auth/me',{ token:approved.body.token })).status,200);
  assert.match(await fs.readFile(path.join(f.dataDir,'.env'),'utf8'),/PIN=replacement/);
});

test('veto cancels a PIN change and revokes only its requester', async t => {
  const f = await fixture(t,{ pin:'owner-pin' });
  const a=await login(f,'owner'), b=await login(f,'other');
  await f.request('/api/auth/sessions/'+b.token+'/approve',{ token:a.token,method:'POST' });
  await f.request('/api/pin',{ token:b.token,method:'POST',body:{ currentPin:'owner-pin',newPin:'replacement' } });
  assert.equal((await f.request('/api/pin/veto',{ token:a.token,method:'POST' })).status,200);
  assert.equal(f.auth.pin,'owner-pin');
  assert.equal((await f.request('/api/auth/me',{ token:a.token })).status,200);
  assert.equal((await f.request('/api/auth/me',{ token:b.token })).status,401);
});

test('failed PIN persistence leaves the old PIN and devices usable', async t => {
  const f=await fixture(t,{ pin:'owner-pin' }), a=await login(f,'owner');
  await fs.mkdir(path.join(f.dataDir,'.env'));
  const r=await f.request('/api/pin',{ token:a.token,method:'POST',body:{ currentPin:'owner-pin',newPin:'replacement' } });
  assert.equal(r.status,500);
  assert.equal(f.auth.pin,'owner-pin');
  assert.equal((await f.request('/api/auth/me',{ token:a.token })).status,200);
});

test('pending sessions expire without approval', async t => {
  let time=100000;
  const scheduled=new Set();
  const timers={
    setTimeout: (fn,delay) => { const timer={ fn,at:time+delay,unref(){} }; scheduled.add(timer); return timer; },
    clearTimeout: timer => scheduled.delete(timer),
    setInterval: () => ({ unref(){} }), clearInterval() {},
  };
  const f=await fixture(t,{ pin:'owner-pin',now:()=>time,timers });
  await login(f,'owner'); const b=await login(f,'other');
  time+=5*60*1000+1;
  for (const timer of [...scheduled]) if(timer.at<=time) { scheduled.delete(timer); timer.fn(); }
  assert.equal((await f.request('/api/auth/me',{ token:b.token })).status,401);
});

test('file writes, reads, copy conflicts, rename, and byte snapshots survive extraction', async t => {
  const f=await fixture(t), file=path.join(f.workspace,'unicode.txt');
  const content='hello 🌍\n';
  assert.equal((await f.request('/api/files/write',{ method:'POST',body:{ path:file,content } })).body.success,true);
  const read=await f.request('/api/files/read?path='+encodeURIComponent(file));
  assert.equal(read.body.content,content);
  assert.equal(read.body.length,Buffer.byteLength(content));
  assert.ok(read.body.mtime);
  const copy=path.join(f.workspace,'copy.txt');
  assert.equal((await f.request('/api/files/copy',{ method:'POST',body:{ source:file,destination:copy } })).body.success,true);
  const conflict=await f.request('/api/files/copy',{ method:'POST',body:{ source:file,destination:copy } });
  assert.equal(conflict.body.conflict,true);
  assert.equal((await f.request('/api/files/rename',{ method:'POST',body:{ oldPath:copy,newName:'renamed.txt' } })).body.success,true);
  assert.equal(await fs.readFile(path.join(f.workspace,'renamed.txt'),'utf8'),content);
});

test('file workspace confinement and error responses stay intact', async t => {
  const f=await fixture(t);
  const outside=path.join(f.root,'outside.txt'); await fs.writeFile(outside,'outside');
  const escaped=await f.request('/api/files/read?path='+encodeURIComponent(outside));
  assert.equal(escaped.status,403);
  const missing=await f.request('/api/files/read?path='+encodeURIComponent(path.join(f.workspace,'missing.txt')));
  assert.equal(missing.body.error,'Path not found');
  assert.equal(JSON.stringify(missing.body).includes(f.workspace),false);
});

test('Git stage, commit, diff, and unstage operate on the requested repository', async t => {
  const f=await fixture(t);
  execFileSync('git',['-C',f.workspace,'init','-b','main'],{ stdio:'ignore' });
  execFileSync('git',['-C',f.workspace,'config','user.name','WebTun Test']);
  execFileSync('git',['-C',f.workspace,'config','user.email','test@example.com']);
  const post=(route,body) => f.request('/api/git/'+route,{ method:'POST',body:{ path:f.workspace,...body } });
  assert.equal((await post('stage',{ files:['alpha.txt'] })).body.success,true);
  assert.equal((await post('commit',{ message:'Initial file' })).body.success,true);
  await fs.writeFile(path.join(f.workspace,'alpha.txt'),'changed\n');
  const diff=await f.request('/api/git/diff?path='+encodeURIComponent(f.workspace)+'&file=alpha.txt');
  assert.match(diff.body.diff,/\+changed/);
  assert.equal((await post('stage',{ files:['alpha.txt'] })).body.success,true);
  assert.equal((await post('unstage',{ files:['alpha.txt'] })).body.success,true);
  assert.equal(execFileSync('git',['-C',f.workspace,'diff','--cached'],{ encoding:'utf8' }),'');
});

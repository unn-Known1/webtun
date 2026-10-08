'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const WebSocket = require('ws');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { createRetryPolicy } = require('../public/js/terminal-connection');
const { createWorkspaceServer } = require('./helpers/workspace-server');

test('network retries back off, allow one fresh session, and then stop', () => {
  const policy = createRetryPolicy({ maxAttempts: 3, random: () => 0 });
  assert.equal(policy.next({ sessionId:'a' }).delay,2000);
  assert.equal(policy.next({ sessionId:'a' }).delay,4000);
  assert.equal(policy.next({ sessionId:'a' }).delay,8000);
  assert.equal(policy.next({ sessionId:'a' }).action,'fresh');
  for (let i=0;i<3;i++) assert.equal(policy.next({ sessionId:'b' }).action,'retry');
  assert.equal(policy.next({ sessionId:'b' }).action,'stop');
  assert.equal(policy.stopped,true);
  policy.reset();
  assert.equal(policy.next().attempt,1);
});

test('authorization and policy rejection stop retries immediately', () => {
  for (const reason of ['Unauthorized','Session revoked','PIN changed','Session no longer valid']) {
    const policy=createRetryPolicy();
    assert.equal(policy.next({ code:1008,reason }).action,'auth');
    assert.equal(policy.next().action,'stop');
  }
  assert.equal(createRetryPolicy().next({ code:1008,reason:'Origin not allowed' }).action,'stop');
  assert.equal(createRetryPolicy().next({ closed:true }).action,'stop');
});

test('retries are bounded and jittered independently per terminal', () => {
  const a=createRetryPolicy({ random:()=>0 }), b=createRetryPolicy({ random:()=>0.5 });
  assert.equal(a.next().delay,2000);
  assert.equal(b.next().delay,2375);
  for(let i=0;i<9;i++) assert.ok(a.next().delay<=15749);
  assert.equal(a.next().action,'stop');
});

async function openSocket(f, params) {
  const ws=new WebSocket(f.base.replace('http','ws')+'/ws?'+new URLSearchParams(params));
  await once(ws,'open'); return ws;
}

test('disconnect and reconnect reuse the same PTY and retain binary input/resize behavior', async t => {
  const f=await createWorkspaceServer(); t.after(()=>f.close());
  const first=await openSocket(f,{ session:'persistent',cols:80,rows:24 });
  const response=once(first,'message'); first.send(Buffer.from([0,...Buffer.from('first command')]));
  assert.equal((await response)[0].subarray(1).toString(),'first command');
  const closed=once(first,'close'); first.close(); await closed;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.shells[0].killed,false);
  const second=await openSocket(f,{ session:'persistent',cols:100,rows:30 });
  assert.equal(f.shells.length,1);
  const echoed=once(second,'message'); second.send(Buffer.from([0,...Buffer.from('second command')]));
  await echoed;
  assert.deepEqual(f.shells[0].inputs,['first command','second command']);
  const resize=Buffer.alloc(5); resize[0]=1; resize.writeUInt16LE(120,1); resize.writeUInt16LE(40,3); second.send(resize);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(f.shells[0].sizes.at(-1),[120,40]);
  const end=once(second,'close'); second.close(); await end;
});

test('pending sessions cannot start a PTY; revocation kicks an approved socket', async t => {
  const f=await createWorkspaceServer({ pin:'owner-pin' }); t.after(()=>f.close());
  const login=async device=>(await f.request('/api/auth',{ method:'POST',body:{ pin:'owner-pin',device } })).body;
  const a=await login('owner'), b=await login('other');
  const pending=new WebSocket(f.base.replace('http','ws')+'/ws?token='+b.token+'&session=pending');
  const [code]=await once(pending,'close');
  assert.equal(code,1008); assert.equal(f.shells.length,0);
  await f.request('/api/auth/sessions/'+b.token+'/approve',{ method:'POST',token:a.token });
  const approved=await openSocket(f,{ token:b.token,session:'approved' });
  const kicked=once(approved,'close');
  await f.request('/api/auth/sessions/'+b.token,{ method:'DELETE',token:a.token });
  assert.equal((await kicked)[0],1008);
});

test('an invalid PTY descriptor closes once and reconnect never reuses the broken PTY', async t => {
  const f=await createWorkspaceServer(); t.after(()=>f.close());
  const ws=await openSocket(f,{ session:'broken' });
  let resizeCalls=0;
  f.shells[0].resize=()=>{ resizeCalls++; throw new Error('ioctl(2) failed, EBADF'); };
  const messages=[]; ws.on('message',data=>messages.push(data));
  const closed=once(ws,'close');
  const resize=Buffer.alloc(5); resize[0]=1; resize.writeUInt16LE(100,1); resize.writeUInt16LE(30,3);
  for(let i=0;i<5;i++) ws.send(resize);
  assert.equal((await closed)[0],1011);
  assert.equal(resizeCalls,1);
  assert.equal(f.shells[0].killed,true);
  assert.equal(messages[0][0],2);
  assert.equal(messages.length,1);
  assert.match(messages[0].subarray(1).toString(),/Reconnect/);
  const next=await openSocket(f,{ session:'broken' });
  assert.equal(f.shells.length,2);
  const echoed=once(next,'message'); next.send(Buffer.from([0,...Buffer.from('recovered')]));
  await echoed;
  assert.deepEqual(f.shells[1].inputs,['recovered']);
  const end=once(next,'close'); next.close(); await end;
});

test('tmux reattachment uses compatible flags and sets the session environment', { skip: process.platform === 'win32' }, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'webtun-tmux-test-'));
  t.after(()=>fs.rm(root,{ recursive:true, force:true }));
  const tmux=path.join(root,'tmux');
  const log=path.join(root,'calls.jsonl');
  // A fake executable isolates this regression from the host's real sessions.
  await fs.writeFile(tmux, '#!'+process.execPath+'\n'+
    'require("fs").appendFileSync('+JSON.stringify(log)+',JSON.stringify(process.argv.slice(2))+"\\n");\n'+
    'if(process.argv[2]==="has-session") process.exit(process.argv[4]==="wt-webtun-65530-resume"?0:1);\n', { mode:0o700 });
  const f=await createWorkspaceServer({ tmux });
  t.after(()=>f.close());
  const ws=await openSocket(f,{ session:'resume' });
  assert.deepEqual(f.shells[0].args,['attach-session','-t','wt-webtun-65530-resume']);
  assert.equal(f.shells[0].options.env.DISABLE_SCREEN,'1');
  const calls=(await fs.readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(calls.some(args=>JSON.stringify(args)===JSON.stringify(['set-environment','-t','wt-webtun-65530-resume','DISABLE_SCREEN','1'])));
  const closed=once(ws,'close'); ws.close(); await closed;
});

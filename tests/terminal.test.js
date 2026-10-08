'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const WebSocket = require('ws');
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

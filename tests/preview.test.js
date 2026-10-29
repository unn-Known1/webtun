'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPreviewAuth } = require('../lib/server/preview-auth');

test('preview capabilities are port-scoped, expire and follow session revocation, not IP', () => {
  let time = 100, active = true;
  const auth = { pin: 'dummy-pin', constantTimeEqual: (a, b) => a === b, rawPinAllowed: () => false, getSession: t => t === 'owner' && active ? { status: 'active' } : null };
  const guard = createPreviewAuth(auth, { now: () => time, ttl: 1000 });
  const req = { ip: '203.0.113.1', headers: {} };
  const grant = guard.authenticate(req, new URLSearchParams('token=owner'), 5173);
  assert.ok(grant.capability);
  assert.equal(guard.authenticate(req, new URLSearchParams(), 5173), null);
  const params = new URLSearchParams({ ptoken: grant.capability });
  assert.equal(guard.authenticate(req, params, 5173).owner, 'owner');
  assert.equal(guard.authenticate(req, params, 8080), null);
  active = false; assert.equal(guard.authenticate(req, params, 5173), null);
  active = true; time += 1001; assert.equal(guard.authenticate(req, params, 5173), null);
});
test('HTTP and WebSocket targets scrub only WebTun credentials, preserving upstream tokens', () => {
  const auth = { pin: 'dummy-pin', constantTimeEqual: (a, b) => a === b, getSession: t => t === 'owner' ? { status: 'active' } : null };
  const guard = createPreviewAuth(auth);
  assert.equal(guard.stripQuery('/hmr?token=owner&token=foreign&ptoken=cap&app=fixture'), '/hmr?app=fixture&token=foreign');
  assert.equal(guard.stripQuery('/hmr?token=dummy-pin'), '/hmr');
});
test('the composed preview forwards original JSON, form, binary and multipart bytes', async t => {
  const prevPreviewPorts = process.env.PREVIEW_PORTS;
  delete process.env.PREVIEW_PORTS;
  process.env.PIN = 'preview-test-pin';
  const { app } = require('../server');
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', b => chunks.push(b));
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ body: Buffer.concat(chunks).toString('base64'), token: req.headers['x-pin-token'] || '', url: req.url })); });
  });
  const gateway = http.createServer(app);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]);
    delete process.env.PIN;
    if (prevPreviewPorts === undefined) delete process.env.PREVIEW_PORTS;
    else process.env.PREVIEW_PORTS = prevPreviewPorts;
  });
  const url = 'http://127.0.0.1:' + gateway.address().port + '/api/preview/' + upstream.address().port + '/submit?token=foreign';
  for (const [type, text] of [['application/json', '{"message":"dummy"}'], ['application/x-www-form-urlencoded', 'message=dummy'], ['application/octet-stream', '\0\x01dummy'], ['multipart/form-data; boundary=fixture', '--fixture\r\nContent-Disposition: form-data; name="x"\r\n\r\ndummy\r\n--fixture--\r\n']]) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': type, 'x-pin-token': 'preview-test-pin' }, body: text });
    assert.equal(response.status, 200);
    const received = await response.json();
    assert.equal(Buffer.from(received.body, 'base64').toString(), text); assert.equal(received.token, ''); assert.match(received.url, /token=foreign/);
    assert.match(response.headers.get('set-cookie'), new RegExp('Path=/api/preview/' + upstream.address().port + '/'));
  }
});

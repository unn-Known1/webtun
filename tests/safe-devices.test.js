'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createWorkspaceServer } = require('./helpers/workspace-server');

async function fixture(t, options) {
  const f = await createWorkspaceServer(options);
  t.after(() => f.close());
  return f;
}

test('remembering a browser issues safeToken and persists sha256 hash to .trusted-devices.json', async t => {
  const f = await fixture(t, { pin: 'test-pin' });
  const loginRes = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'test-pin', device: 'Firefox on Linux', deviceId: 'dev-1111222233334444', remember: true },
    remote: false,
  });

  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.success, true);
  assert.match(loginRes.body.token, /^[a-f0-9]{64}$/);
  assert.match(loginRes.body.safeToken, /^[a-f0-9]{64}$/);
  assert.equal(loginRes.body.deviceId, 'dev-1111222233334444');

  // Verify file on disk
  const trustedFilePath = path.join(f.dataDir, '.trusted-devices.json');
  const content = JSON.parse(await fs.readFile(trustedFilePath, 'utf8'));
  assert.ok(content['dev-1111222233334444']);
  const devRecord = content['dev-1111222233334444'];
  assert.equal(devRecord.device, 'Firefox on Linux');
  assert.notEqual(devRecord.tokenHash, loginRes.body.safeToken, 'Must store hash, not raw token');
  assert.match(devRecord.tokenHash, /^[a-f0-9]{64}$/);
});

test('safe browser can resume session without providing PIN', async t => {
  const f = await fixture(t, { pin: 'test-pin' });
  const loginRes = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'test-pin', device: 'Chrome on macOS', deviceId: 'macbook-pro-12345678', remember: true },
    remote: false,
  });
  const { safeToken, deviceId } = loginRes.body;

  // Now resume using safe device credentials
  const resumeRes = await f.request('/api/auth/resume', {
    method: 'POST',
    body: { safeToken, deviceId, device: 'Chrome on macOS' },
    remote: true,
  });

  assert.equal(resumeRes.status, 200);
  assert.equal(resumeRes.body.success, true);
  assert.equal(resumeRes.body.safe, true);
  assert.match(resumeRes.body.token, /^[a-f0-9]{64}$/);

  // Resume token works on authed routes
  const meRes = await f.request('/api/auth/me', { token: resumeRes.body.token });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.ok, true);

  const filesRes = await f.request('/api/files', { token: resumeRes.body.token });
  assert.equal(filesRes.status, 200);
});

test('resume rejects invalid safeToken or unknown deviceId with safeInvalid: true', async t => {
  const f = await fixture(t, { pin: 'test-pin' });
  const loginRes = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'test-pin', device: 'Edge on Windows', deviceId: 'edge-pc-112233445566', remember: true },
    remote: false,
  });

  // Bad safeToken
  const badTokenRes = await f.request('/api/auth/resume', {
    method: 'POST',
    body: { safeToken: 'a'.repeat(64), deviceId: loginRes.body.deviceId },
    remote: true,
  });
  assert.equal(badTokenRes.status, 401);
  assert.equal(badTokenRes.body.safeInvalid, true);

  // Bad deviceId
  const badDevRes = await f.request('/api/auth/resume', {
    method: 'POST',
    body: { safeToken: loginRes.body.safeToken, deviceId: 'unknown-device-id-9999' },
    remote: true,
  });
  assert.equal(badDevRes.status, 401);
  assert.equal(badDevRes.body.safeInvalid, true);
});

test('can list, revoke individual, and revoke other trusted browsers', async t => {
  const f = await fixture(t, { pin: 'test-pin' });
  // Browser 1
  const b1 = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'test-pin', device: 'Browser 1', deviceId: 'device-id-alpha-001', remember: true },
    remote: false,
  });

  // Browser 2
  f.auth.registerSafeDevice({ headers: {} }, 'device-id-beta-002', 'Browser 2');

  // List trusted browsers
  const listRes = await f.request('/api/auth/safe-devices', { token: b1.body.token });
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.devices.length, 2);
  const currentDev = listRes.body.devices.find(d => d.id === 'device-id-alpha-001');
  assert.ok(currentDev);
  assert.equal(currentDev.current, true);

  // Revoke device 2
  const delRes = await f.request('/api/auth/safe-devices/device-id-beta-002', {
    method: 'DELETE',
    token: b1.body.token,
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.revoked, true);

  // Verify only 1 remains
  const listRes2 = await f.request('/api/auth/safe-devices', { token: b1.body.token });
  assert.equal(listRes2.body.devices.length, 1);
  assert.equal(listRes2.body.devices[0].id, 'device-id-alpha-001');

  // Add another and test revoke-others
  f.auth.registerSafeDevice({ headers: {} }, 'device-id-gamma-003', 'Browser 3');
  const revokeOthersRes = await f.request('/api/auth/safe-devices', {
    method: 'DELETE',
    token: b1.body.token,
  });
  assert.equal(revokeOthersRes.status, 200);
  assert.equal(revokeOthersRes.body.revokedCount, 1);

  const listRes3 = await f.request('/api/auth/safe-devices', { token: b1.body.token });
  assert.equal(listRes3.body.devices.length, 1);
  assert.equal(listRes3.body.devices[0].id, 'device-id-alpha-001');
});

test('PIN change invalidates all remembered safe devices', async t => {
  const f = await fixture(t, { pin: 'original-pin' });
  const loginRes = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'original-pin', device: 'Safari on iPhone', deviceId: 'iphone-safe-0001', remember: true },
    remote: false,
  });
  const { safeToken, deviceId, token } = loginRes.body;

  // Change PIN
  const pinChangeRes = await f.request('/api/pin', {
    method: 'POST',
    body: { currentPin: 'original-pin', newPin: 'brand-new-pin' },
    token,
  });
  assert.equal(pinChangeRes.status, 200);

  // Attempting resume with old safeToken must now fail
  const resumeRes = await f.request('/api/auth/resume', {
    method: 'POST',
    body: { safeToken, deviceId },
    remote: true,
  });
  assert.equal(resumeRes.status, 401);
  assert.equal(resumeRes.body.safeInvalid, true);
});

test('secondary device pending login receives safeToken upon approval and can resume', async t => {
  const f = await fixture(t, { pin: 'my-pin' });
  // Primary device
  const d1 = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'my-pin', device: 'Desktop 1', deviceId: 'desktop-safe-1', remember: true },
    remote: false,
  });
  assert.equal(d1.body.pending, undefined);

  // Secondary device logs in with remember: true (becomes pending)
  const d2 = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'my-pin', device: 'Phone 2', deviceId: 'phone-safe-2', remember: true },
    remote: true,
  });
  assert.equal(d2.body.pending, true);
  assert.equal(d2.body.safeToken, undefined);

  // Primary device approves secondary device
  const approveRes = await f.request(`/api/auth/sessions/${d2.body.token}/approve`, {
    method: 'POST',
    token: d1.body.token,
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.success, true);

  // Secondary device polls /api/auth/me and receives safeToken
  const meRes = await f.request('/api/auth/me', { token: d2.body.token });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.ok, true);
  assert.match(meRes.body.safeToken, /^[0-9a-f]{64}$/);
  assert.equal(meRes.body.deviceId, 'phone-safe-2');

  // Verify secondary device can resume later with safeToken
  const resumeRes = await f.request('/api/auth/resume', {
    method: 'POST',
    body: { safeToken: meRes.body.safeToken, deviceId: 'phone-safe-2' },
    remote: true,
  });
  assert.equal(resumeRes.status, 200);
  assert.equal(resumeRes.body.success, true);
  assert.equal(resumeRes.body.safe, true);
});

test('revoking a session removes safe device trust to prevent instant resumption', async t => {
  const f = await fixture(t, { pin: 'my-pin' });
  const loginRes = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'my-pin', device: 'Kicked Device', deviceId: 'kicked-device-01', remember: true },
    remote: false,
  });
  const { safeToken, deviceId, token } = loginRes.body;

  // Revoke session
  const revokeRes = await f.request(`/api/auth/sessions/${token}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(revokeRes.status, 200);

  // Resume must now fail because safe trust was revoked with session
  const resumeRes = await f.request('/api/auth/resume', {
    method: 'POST',
    body: { safeToken, deviceId },
    remote: true,
  });
  assert.equal(resumeRes.status, 401);
  assert.equal(resumeRes.body.safeInvalid, true);
});

test('signing in with remember: false removes any existing safe device trust', async t => {
  const f = await fixture(t, { pin: 'my-pin' });
  // First login with remember
  const login1 = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'my-pin', device: 'Device A', deviceId: 'device-unremember-01', remember: true },
    remote: false,
  });
  assert.ok(login1.body.safeToken);
  assert.ok(f.auth.trustedDevices.has('device-unremember-01'));

  // Close session
  await f.request(`/api/auth/sessions/${login1.body.token}`, { method: 'DELETE', token: login1.body.token });

  // Re-login with remember: false
  const login2 = await f.request('/api/auth', {
    method: 'POST',
    body: { pin: 'my-pin', device: 'Device A', deviceId: 'device-unremember-01', remember: false },
    remote: false,
  });
  assert.equal(login2.body.safeToken, undefined);
  assert.equal(f.auth.trustedDevices.has('device-unremember-01'), false);
});

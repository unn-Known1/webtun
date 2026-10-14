'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateKeypair } = require('../lib/ssh');
const { ZipArchiveReader } = require('../lib/zip-read');
const { updateStatus } = require('../electron/update-status');

test('exported Ed25519 private keys round-trip through the OpenSSH reader', async t => {
  try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); } catch (e) { if (e.code === 'ENOENT') { t.skip('OpenSSH reader not installed'); return; } }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtun-key-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = generateKeypair(), file = path.join(dir, 'dummy-key'); await fs.writeFile(file, key.privateKey, { mode: 0o600 });
  const publicKey = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8', timeout: 5000 }).trim().split(' ');
  assert.equal(publicKey[0], key.pubType); assert.equal(publicKey[1], key.pubB64);
});
test('malformed deflate destroys the returned validation stream and releases handles', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webtun-zip-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bad.zip'), header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50);
  await fs.writeFile(file, Buffer.concat([header, Buffer.from([0xff, 0xff])]));
  const reader = new ZipArchiveReader(file, 32, []);
  const stream = await reader.openEntryStream({ fileName: 'dummy', flags: 0, method: 8, localOffset: 0, compressedSize: 2, uncompressedSize: 1, crc: 0 });
  await assert.rejects(async () => { for await (const _ of stream) {} });
  assert.equal(reader._openStreams, 0);
});
test('desktop update status uses availability, not the feed version alone', () => {
  assert.equal(updateStatus({ isUpdateAvailable: false, updateInfo: { version: '2.3.5' } }), 'up to date');
  assert.equal(updateStatus({ isUpdateAvailable: true, updateInfo: { version: '2.4.0' } }), 'update available: 2.4.0');
  assert.match(updateStatus(null), /unavailable/);
});

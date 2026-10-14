'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createWorkspaceServer } = require('./helpers/workspace-server');
const { mergeDirs, downloadRange } = require('../lib/server/file-operations');
const { matchRegex } = require('../lib/server/regex-search');

async function fixture(t) { const f = await createWorkspaceServer(); t.after(() => f.close()); return f; }
test('clipboard copy and cut cannot replace their own source', async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'alpha.txt');
  for (const action of ['copy', 'cut']) {
    await f.request('/api/clipboard', { method: 'POST', body: { sources: [file], action } });
    const r = await f.request('/api/clipboard/paste', { method: 'POST', body: { destination: f.workspace } });
    assert.equal(r.body.succeeded, 0); assert.equal(r.body.failed, 1);
    assert.equal(await fs.readFile(file, 'utf8'), 'alpha on disk\n');
  }
});
test('all copy callers reject descendants and symlinked destination escapes', async t => {
  const f = await fixture(t), dir = path.join(f.workspace, 'dir'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'keep.txt'), 'keep');
  await f.request('/api/clipboard', { method: 'POST', body: { sources: [dir], action: 'cut' } });
  assert.equal((await f.request('/api/clipboard/paste', { method: 'POST', body: { destination: dir } })).body.failed, 1);
  if (process.platform !== 'win32') {
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
    const link = path.join(f.workspace, 'link'); await fs.symlink(outside, link);
    const r = await f.request('/api/files/copy', { method: 'POST', body: { source: path.join(f.workspace, 'alpha.txt'), destination: path.join(link, 'new.txt') } });
    assert.equal(r.status, 403);
    assert.deepEqual(await fs.readdir(outside), []);
  }
});
test('batch conflicts do not count unfinished work as success', async t => {
  const f = await fixture(t), dir = path.join(f.workspace, 'target'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'alpha.txt'), 'destination');
  const r = await f.request('/api/files/batch-copy', { method: 'POST', body: { sources: [path.join(f.workspace, 'alpha.txt')], destination: dir, conflict: 'ask' } });
  assert.equal(r.body.results[0].conflict, true); assert.equal(r.body.succeeded, 0);
  assert.equal(await fs.readFile(path.join(dir, 'alpha.txt'), 'utf8'), 'destination');
});
test('rename cannot silently overwrite an existing file', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/files/rename', { method: 'POST', body: { oldPath: path.join(f.workspace, 'alpha.txt'), newName: 'beta.txt' } });
  assert.equal(r.status, 409);
  assert.equal(await fs.readFile(path.join(f.workspace, 'alpha.txt'), 'utf8'), 'alpha on disk\n');
  assert.equal(await fs.readFile(path.join(f.workspace, 'beta.txt'), 'utf8'), 'beta on disk\n');
});
test('symlink metadata and size describe the link, including a broken link', async t => {
  if (process.platform === 'win32') { t.skip('creating Windows links needs a host privilege'); return; }
  const f = await fixture(t), link = path.join(f.workspace, 'selected-link');
  await fs.symlink('alpha.txt', link);
  const stat = await f.request('/api/files/stat?path=' + encodeURIComponent(link));
  assert.equal(stat.body.path, link); assert.equal(stat.body.isSymlink, true); assert.equal(stat.body.linkTarget, 'alpha.txt');
  assert.equal((await f.request('/api/files/size?path=' + encodeURIComponent(link))).body.isSymlink, true);
  await fs.unlink(path.join(f.workspace, 'alpha.txt'));
  assert.equal((await f.request('/api/files/stat?path=' + encodeURIComponent(link))).body.isSymlink, true);
});
test('folder multipart uploads preserve different subdirectories and Unicode basenames', async t => {
  const f = await fixture(t), form = new FormData();
  form.append('files', new Blob(['first']), 'folder/a/报告.txt');
  form.append('files', new Blob(['second']), 'folder/b/报告.txt');
  const r = await fetch(f.base + '/api/files/upload?path=' + encodeURIComponent(f.workspace), { method: 'POST', body: form });
  assert.equal((await r.json()).count, 2);
  assert.equal(await fs.readFile(path.join(f.workspace, 'folder/a/报告.txt'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(f.workspace, 'folder/b/报告.txt'), 'utf8'), 'second');
  const deep = new FormData(); deep.append('files', new Blob(['no']), 'a/'.repeat(12) + 'x.txt');
  assert.equal((await fetch(f.base + '/api/files/upload?path=' + encodeURIComponent(f.workspace), { method: 'POST', body: deep })).status, 400);
});
test('ZIP round trip supports the same entry count on creation and extraction', async t => {
  const f = await fixture(t), dir = path.join(f.workspace, 'many'); await fs.mkdir(dir);
  for (let i = 0; i < 1001; i++) await fs.writeFile(path.join(dir, String(i)), '');
  assert.equal((await f.request('/api/files/zip', { method: 'POST', body: { path: dir } })).body.success, true);
  const r = await f.request('/api/files/unzip', { method: 'POST', body: { path: dir + '.zip', destName: 'round-trip' } });
  assert.equal(r.body.success, true);
  assert.equal((await fs.readdir(path.join(r.body.dir, 'many'))).length, 1001);
});
test('single-file range downloads return correct 206/416 responses', async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'range.txt'); await fs.writeFile(file, 'abcdefghij');
  for (const [range, expected] of [['bytes=2-4', 'cde'], ['bytes=-3', 'hij'], ['bytes=8-', 'ij'], ['bytes=8-100', 'ij']]) {
    const r = await fetch(f.base + '/api/files/download?path=' + encodeURIComponent(file), { headers: { Range: range } });
    assert.equal(r.status, 206); assert.equal(await r.text(), expected);
    assert.equal(Number(r.headers.get('content-length')), expected.length);
  }
  const r = await fetch(f.base + '/api/files/download?path=' + encodeURIComponent(file), { headers: { Range: 'bytes=100-200' } });
  assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), 'bytes */10');
  assert.equal(downloadRange('bytes=2-1', 10), false);
  assert.equal(downloadRange('bytes=-0', 10), false);
});
test('merge rollback removes newly introduced descendants and refuses failed backups', async t => {
  const f = await fixture(t), src = path.join(f.workspace, 'src'), dst = path.join(f.workspace, 'dst');
  await fs.mkdir(path.join(src, 'a'), { recursive: true }); await fs.mkdir(path.join(dst, 'a'), { recursive: true });
  await fs.writeFile(path.join(src, 'a/new'), 'new'); await fs.writeFile(path.join(src, 'a/old'), 'changed');
  await fs.writeFile(path.join(dst, 'a/old'), 'original'); await fs.writeFile(path.join(src, 'b'), 'later');
  const io = { ...fs, cp: async (from, to, opts) => { if (from === path.join(src, 'b')) throw new Error('later failure'); return fs.cp(from, to, opts); } };
  await assert.rejects(mergeDirs(src, dst, io), /later failure/);
  assert.deepEqual(await fs.readdir(path.join(dst, 'a')), ['old']);
  assert.equal(await fs.readFile(path.join(dst, 'a/old'), 'utf8'), 'original');
  await assert.rejects(mergeDirs(src, dst, { ...fs, cp: async () => { throw new Error('backup refused'); } }), /backup refused/);
  assert.equal(await fs.readFile(path.join(dst, 'a/old'), 'utf8'), 'original');
});
test('accepted pathological regex runs outside the main loop and has a hard timeout', { timeout: 4000 }, async () => {
  const p = matchRegex('(a|aa)+$', 'a'.repeat(20000) + '!', 10, 150);
  let responsive = false; setTimeout(() => { responsive = true; }, 20);
  await assert.rejects(p, { code: 'REGEX_TIMEOUT' }); assert.equal(responsive, true);
  const matches = await matchRegex('TODO', 'line\nTODO task\n', 10);
  assert.deepEqual(matches, [{ line: 2, column: 0, content: 'TODO task' }]);
});
test('SSE tail emits reset events for rotation and truncation instead of silently skipping content', { timeout: 6000 }, async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'tail.log'); await fs.writeFile(file, 'original\n');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  t.after(() => { clearTimeout(timer); controller.abort(); });
  const response = await fetch(f.base + '/api/files/tail?interval=500&path=' + encodeURIComponent(file), { signal: controller.signal });
  const reader = response.body.getReader(); let carry = '';
  async function event() {
    while (!carry.includes('\n\n')) { const read = await reader.read(); if (read.done) throw new Error('Tail ended early'); carry += Buffer.from(read.value).toString(); }
    const at = carry.indexOf('\n\n'), frame = carry.slice(0, at); carry = carry.slice(at + 2);
    return JSON.parse(frame.slice(6));
  }
  assert.equal((await event()).type, 'init');
  const next = file + '.next'; await fs.writeFile(next, 'rotated!\n'); await fs.rename(next, file);
  const rotated = await event(); assert.equal(rotated.type, 'reset'); assert.equal(rotated.reason, 'rotated'); assert.ok(rotated.lines.includes('rotated!'));
  await fs.writeFile(file, 'short\n'); const truncated = await event(); assert.equal(truncated.type, 'reset'); assert.ok(truncated.lines.includes('short'));
});

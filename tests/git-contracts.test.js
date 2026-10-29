'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorkspaceServer } = require('./helpers/workspace-server');

async function fixture(t) {
  const f = await createWorkspaceServer(); t.after(() => f.close());
  const git = (...args) => execFileSync('git', ['-C', f.workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '--', 'alpha.txt'); git('commit', '-m', 'initial');
  const post = (route, body) => f.request('/api/git/' + route, { method: 'POST', body: { path: f.workspace, ...body } });
  const get = route => f.request('/api/git/' + route + (route.includes('?') ? '&' : '?') + 'path=' + encodeURIComponent(f.workspace));
  return { ...f, git, post, get };
}
test('valid branch creation switches correctly, duplicates and invalid names fail safely', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('branch', { name: 'feature/fixture' })).body.success, true);
  assert.equal(f.git('branch', '--show-current').trim(), 'feature/fixture');
  assert.equal((await f.post('branch', { name: 'feature/fixture' })).status, 400);
  assert.equal((await f.post('branch', { name: '--bad' })).status, 400);
  assert.equal((await f.post('switch', { branch: 'main' })).body.success, true);
  assert.equal((await f.post('branch/delete', { name: 'feature/fixture' })).body.success, true);
  assert.equal((await f.post('branch/delete', { name: 'main', force: true })).status, 400);
});
test('status and numstat keep Unicode, whitespace, arrow strings and rename pairs unquoted', async t => {
  const f = await fixture(t);
  const names = ['报告.txt', 'a -> b.txt', 'a => b.txt'];
  if (process.platform !== 'win32') names.push('a\tb.txt', 'a\nb.txt', '"quoted".txt');
  for (const name of names) await fs.writeFile(path.join(f.workspace, name), 'hello\nworld\n');
  const status = (await f.get('status')).body;
  for (const name of names) assert.ok(status.untracked.some(e => e.path === name), JSON.stringify(name));
  assert.equal((await f.post('stage', { files: names })).body.success, true);
  const staged = (await f.get('status')).body;
  for (const name of names) { const entry = staged.staged.find(e => e.path === name); assert.equal(entry.added, 2); }
  await f.post('commit', { message: 'names' });
  f.git('mv', '--', '报告.txt', 'renamed 报告.txt');
  const rename = (await f.get('status')).body.staged.find(e => e.path === 'renamed 报告.txt');
  assert.equal(rename.originalPath, '报告.txt');
});
test('merge conflicts expose operation state, Abort restores and Continue completes staged resolutions', async t => {
  const f = await fixture(t);
  await f.post('branch', { name: 'feature' }); await fs.writeFile(path.join(f.workspace, 'alpha.txt'), 'feature\n');
  await f.post('stage', { files: ['alpha.txt'] }); await f.post('commit', { message: 'feature edit' });
  await f.post('switch', { branch: 'main' }); await fs.writeFile(path.join(f.workspace, 'alpha.txt'), 'main\n');
  await f.post('stage', { files: ['alpha.txt'] }); await f.post('commit', { message: 'main edit' });
  assert.equal((await f.post('merge', { branch: 'feature' })).status, 400);
  assert.equal((await f.get('status')).body.operation, 'merge');
  assert.equal((await f.post('abort', {})).body.success, true);
  assert.equal(await fs.readFile(path.join(f.workspace, 'alpha.txt'), 'utf8'), 'main\n');
  await f.post('merge', { branch: 'feature' }); await fs.writeFile(path.join(f.workspace, 'alpha.txt'), 'resolved\n');
  await f.post('stage', { files: ['alpha.txt'] });
  assert.equal((await f.post('continue', {})).body.success, true);
  assert.equal((await f.get('status')).body.operation, null);
});
test('history pages and bounded blame return real repository data', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) f.git('commit', '--allow-empty', '-m', 'commit ' + i);
  const a = (await f.get('log?n=3')).body, b = (await f.get('log?n=3&skip=' + a.next)).body;
  assert.equal(a.commits.length, 3); assert.equal(a.hasMore, true); assert.equal(b.commits.length, 3);
  assert.equal(a.commits.some(x => b.commits.some(y => y.hash === x.hash)), false);
  const blame = await f.get('blame?file=alpha.txt&start=1&count=200');
  assert.equal(blame.status, 200); assert.match(blame.body.blame, /alpha on disk/);
  const fileLog = await f.get('file-log?file=alpha.txt');
  assert.equal(fileLog.status, 200); assert.ok(Array.isArray(fileLog.body.commits)); assert.ok(fileLog.body.commits.length >= 1);
  await fs.writeFile(path.join(f.workspace, 'alpha.txt'), 'stash-me\n');
  assert.equal((await f.post('stash', { action: 'push', message: 'wip-stash' })).body.success, true);
  const stashes = (await f.get('stashes')).body.stashes;
  assert.equal(stashes.length, 1);
  assert.equal((await f.post('stash', { action: 'apply', index: 0 })).body.success, true);
  assert.equal((await f.post('stash', { action: 'drop', index: 0 })).body.success, true);
  assert.equal((await f.get('stashes')).body.stashes.length, 0);
});


'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../public/js/editor-buffers');

function fixture() {
  const drafts = new Map();
  const pending = new Map();
  let timer = 0;
  const store = createStore({
    storage: { getItem: k => drafts.get(k) ?? null, setItem: (k,v) => drafts.set(k,v), removeItem: k => drafts.delete(k) },
    schedule: fn => { pending.set(++timer, fn); return timer; },
    cancel: id => pending.delete(id),
  });
  const panel = store.createSurface('panel');
  const tab = store.createSurface('tab:1');
  return { store, panel, tab, drafts, tick: () => { for (const fn of [...pending.values()]) fn(); } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no) => { resolve=yes; reject=no; });
  return { promise, resolve, reject };
}

test('handover preserves one buffer, dirty state, disk revision, and draft', () => {
  const f = fixture();
  const buffer = f.panel.open('/a', { content: 'disk', mtime: '42', size: 4 });
  buffer.setContent('edits');
  buffer.extChanged = true;
  f.tab.open('/a', {}, f.panel.take());
  assert.equal(f.panel.path, '');
  assert.equal(f.tab.buffer, buffer);
  assert.equal(buffer.owner, 'tab:1');
  assert.equal(buffer.dirty, true);
  assert.equal(f.tab.diskMtime, '42');
  assert.equal(f.tab.extChanged, true);
  assert.equal(f.store.readDraft('/a'), 'edits');
  f.panel.open('/a', {}, f.tab.take());
  assert.equal(f.panel.buffer, buffer);
});

test('a path cannot be editable in two surfaces', () => {
  const f = fixture();
  f.panel.open('/a', { content: 'one' });
  assert.throws(() => f.tab.open('/a', { content: 'two' }), /already has an editor/);
  assert.equal(f.panel.buffer.content, 'one');
});

test('typing during save stays dirty and retains a recoverable draft', async () => {
  const f = fixture(), request = deferred();
  const buffer = f.panel.open('/a', { content: 'disk' });
  buffer.setContent('submitted');
  let sent;
  const saving = buffer.save(snapshot => { sent = snapshot; return request.promise; });
  await Promise.resolve();
  buffer.setContent('newer edits');
  request.resolve({ success: true });
  await saving;
  assert.deepEqual(sent, { path: '/a', content: 'submitted' });
  assert.equal(buffer.original, 'submitted');
  assert.equal(buffer.dirty, true);
  assert.equal(f.store.readDraft('/a'), 'newer edits');
});

test('switching files during a save never changes the new file baseline', async () => {
  const f = fixture(), request = deferred();
  const a = f.panel.open('/a', { content: 'a' });
  a.setContent('saved a');
  const saving = a.save(() => request.promise);
  const b = f.panel.open('/b', { content: 'b', mtime: 'b-time' });
  request.resolve({ success: true });
  await saving;
  assert.equal(f.panel.buffer, b);
  assert.equal(b.original, 'b');
  assert.equal(b.mtime, 'b-time');
});

test('a save can complete after transfer and update the same document', async () => {
  const f = fixture(), request = deferred();
  const buffer = f.panel.open('/a', { content: 'disk' });
  buffer.setContent('new');
  const saving = buffer.save(() => request.promise);
  f.tab.open('/a', {}, f.panel.take());
  request.resolve({ success: true });
  await saving;
  assert.equal(f.tab.buffer.dirty, false);
  assert.equal(f.store.readDraft('/a'), null);
});

test('a save finishing after release clears only its own submitted draft', async () => {
  const f = fixture(), request = deferred();
  const buffer = f.panel.open('/a', { content: 'disk' });
  buffer.setContent('submitted');
  const saving = buffer.save(() => request.promise);
  f.panel.clear();
  request.resolve({ success: true }); await saving;
  assert.equal(f.store.readDraft('/a'),null);

  const nextRequest = deferred();
  const reopened = f.panel.open('/a', { content: 'submitted' });
  reopened.setContent('second save');
  const secondSave = reopened.save(() => nextRequest.promise);
  f.panel.clear();
  const newer = f.panel.open('/a', { content: 'second save' });
  newer.setContent('newer draft'); newer.flushDraft();
  nextRequest.resolve({ success: true }); await secondSave;
  assert.equal(f.store.readDraft('/a'),'newer draft');
  assert.equal(newer.dirty,true);
});

test('queued saves cannot complete out of order', async () => {
  const f = fixture(), first = deferred();
  const buffer = f.panel.open('/a', { content: 'disk' });
  buffer.setContent('first');
  const calls = [];
  const a = buffer.save(snapshot => { calls.push(snapshot.content); return first.promise; });
  buffer.setContent('second');
  const b = buffer.save(snapshot => { calls.push(snapshot.content); return { success: true }; });
  await Promise.resolve();
  assert.deepEqual(calls, ['first']);
  first.resolve({ success: true });
  await Promise.all([a,b]);
  assert.deepEqual(calls, ['first','second']);
  assert.equal(buffer.original, 'second');
  assert.equal(buffer.dirty, false);
});

test('failed save preserves edits and does not poison the save queue', async () => {
  const f = fixture();
  const buffer = f.panel.open('/a', { content: 'disk' });
  buffer.setContent('edits');
  buffer.flushDraft();
  await assert.rejects(buffer.save(() => Promise.reject(new Error('offline'))), /offline/);
  assert.equal(buffer.original, 'disk');
  assert.equal(f.store.readDraft('/a'), 'edits');
  await buffer.save(() => ({ success: true }));
  assert.equal(buffer.dirty, false);
});

test('a delayed disk reload cannot overwrite edits made after it started', () => {
  const f = fixture();
  const buffer = f.panel.open('/a', { content: 'disk' });
  const revision = buffer.revision;
  buffer.setContent('typed while loading');
  assert.equal(buffer.acceptDisk({ content: 'external', mtime: 'new' }, revision), false);
  assert.equal(buffer.content, 'typed while loading');
  assert.equal(buffer.acceptDisk({ content: 'external', mtime: 'new' }, buffer.revision), true);
  assert.equal(buffer.original, 'external');
  assert.equal(buffer.dirty, false);
});

test('explicit discard cancels delayed drafts; ordinary release preserves them', () => {
  const f = fixture();
  const a = f.panel.open('/a', { content: 'disk' });
  a.setContent('edits'); a.scheduleDraft();
  f.panel.clear({ discard: true }); f.tick();
  assert.equal(f.store.readDraft('/a'), null);
  const b = f.panel.open('/b', { content: 'disk' });
  b.setContent('recover me'); b.scheduleDraft();
  f.panel.clear();
  assert.equal(f.store.readDraft('/b'), 'recover me');
});

test('renaming a buffer moves the draft and later saves use the new path', async () => {
  const f = fixture();
  const buffer = f.panel.open('/old', { content: 'disk' });
  buffer.setContent('edits'); buffer.flushDraft();
  f.store.renamePath('/old','/new');
  assert.equal(f.panel.path, '/new');
  assert.equal(f.store.readDraft('/old'), null);
  assert.equal(f.store.readDraft('/new'), 'edits');
  let path;
  await buffer.save(snapshot => { path=snapshot.path; return { success: true }; });
  assert.equal(path, '/new');
});

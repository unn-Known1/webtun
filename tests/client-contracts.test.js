'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { clientFunction, sourceFunction } = require('./helpers/client-functions');
const { createStore } = require('../public/js/editor-buffers');

test('overlapping uploads have isolated cancellation and ignore navigation changes', async () => {
  const jobs = [], xhrs = [];
  class Xhr {
    constructor() { this.upload = { addEventListener() {} }; this.status = 200; this.responseText = '{"success":true}'; xhrs.push(this); }
    open(_method, url) { this.url = url; } setRequestHeader() {} send() {}
    abort() { this.aborted = true; this.onabort(); }
  }
  const context = { currentPath: '/first', authToken: 'dummy', XMLHttpRequest: Xhr, FormData: class { append() {} },
    txCreate: () => { const job = {}; jobs.push(job); return job; }, txTick() {}, txFinish: (job, status) => { job.status = status; }, toast() {}, refreshFiles() {}, console, setTimeout, clearTimeout };
  const upload = clientFunction('public/js/transfers.js', 'uploadFileList', context);
  const a = upload([{ name: 'a', size: 1 }]); context.currentPath = '/second'; const b = upload([{ name: 'b', size: 1 }]);
  jobs[0].abort(); assert.equal(xhrs[0].aborted, true); assert.equal(xhrs[1].aborted, undefined);
  assert.match(xhrs[0].url, /%2Ffirst/); assert.match(xhrs[1].url, /%2Fsecond/);
  xhrs[1].onload(); await Promise.all([a, b]);
  assert.equal(jobs[0].status, 'cancelled'); assert.equal(jobs[1].status, 'done');
});
test('upload retries a 429 after Retry-After without double-counting a file', async () => {
  const jobs = [], waits = []; let attempts = 0;
  class Xhr {
    constructor() { this.upload = { addEventListener() {} }; this.status = ++attempts === 1 ? 429 : 200; this.responseText = '{"success":true}'; }
    open() {} setRequestHeader() {} getResponseHeader() { return '2'; } send() { this.onload(); }
  }
  const upload = clientFunction('public/js/transfers.js', 'uploadFileList', { currentPath: '/dummy', authToken: 'dummy', XMLHttpRequest: Xhr, FormData: class { append() {} },
    txCreate: () => { const job = {}; jobs.push(job); return job; }, txTick() {}, txFinish: (job, status) => { job.status = status; }, toast() {}, refreshFiles() {}, console,
    setTimeout: (fn, ms) => { waits.push(ms); queueMicrotask(fn); return 1; }, clearTimeout() {} });
  await upload([{ name: 'tiny', size: 1 }]);
  assert.equal(attempts, 2); assert.deepEqual(waits, [2000]); assert.equal(jobs[0].filesDone, 1); assert.equal(jobs[0].status, 'done');
});
test('old tab preview completions cannot overwrite a newer rendering', async () => {
  const gates = [], md = { innerHTML: '' }, buffer = {};
  const tab = { path: '/dummy/a.md', previewOn: true, document: { buffer }, cm: { getValue: () => tab.text }, text: 'older', fteMd: md };
  const render = clientFunction('public/js/file-tabs.js', 'renderTabPreview', { tabPreviewKind: () => 'md', tabBaseDir: () => '/dummy', tabIsDark: () => false,
    mintPreviewFileToken: () => new Promise(resolve => gates.push(resolve)), ensurePreviewLibs: async () => true,
    marked: { parse: v => v }, DOMPurify: { sanitize: v => v }, rewriteHtmlRelativeUrls: v => v, tabMdCss: () => '', toast() {}, escHtml: v => v, console });
  const a = render(tab); tab.text = 'newer'; const b = render(tab);
  gates[1]('dummy-new'); await b; assert.match(md.innerHTML, /newer/);
  gates[0]('dummy-old'); await a; assert.match(md.innerHTML, /newer/);
});
test('panel Markdown fails closed when scoped asset authorization fails', async () => {
  const md = { style: {}, innerHTML: '', textContent: '' };
  const nodes = { 'editor-preview': {}, 'md-preview-content': md, 'editor-preview-iframe': { style: {} } };
  let rewritten = false;
  const render = clientFunction('public/js/viewers.js', 'renderMdPreview', { capturePanelPreview: () => ({ raw: 'dummy markdown', path: '/dummy/a.md', current: () => true }),
    document: { getElementById: id => nodes[id] }, ensurePreviewLibs: async () => {}, marked: { parse: () => '<img src="a.png">' }, DOMPurify: { sanitize: v => v }, getHtmlBaseDir: () => '/dummy',
    mintPreviewFileToken: async () => { throw new Error('Authorization refused'); }, rewriteHtmlRelativeUrls: () => { rewritten = true; }, console: { warn() {} } });
  await render(); assert.equal(rewritten, false); assert.match(md.textContent, /Preview unavailable/); assert.equal(md.innerHTML, '');
});
test('fallback wake lock release stops paint, stream tracks and removes the video', async () => {
  const source = fs.readFileSync('public/js/settings.js', 'utf8');
  const timers = new Set(); let stopped = 0, removed = 0;
  const video = { style: {}, setAttribute() {}, pause() {}, play: async () => {}, remove() { removed++; } };
  const canvas = { getContext: () => ({ fillRect() {} }), captureStream: () => ({ getTracks: () => [{ stop() { stopped++; } }] }) };
  const context = { navigator: {}, window: {}, console, HTMLCanvasElement: { prototype: { captureStream() {} } },
    document: { body: { appendChild() {} }, createElement: tag => tag === 'video' ? video : canvas },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn) };
  vm.createContext(context); vm.runInContext(source.slice(source.indexOf('let wakeLock ='), source.indexOf('async function toggleKeepAwake')), context);
  await context.requestWakeLock(); assert.equal(timers.size, 1); await context.releaseWakeLock();
  assert.equal(timers.size, 0); assert.equal(stopped, 1); assert.equal(removed, 1);
});
test('locking releases vanished file owners without discarding drafts or erasing a later PIN', () => {
  const drafts = new Map(), store = createStore({ storage: { getItem: k => drafts.get(k), setItem: (k, v) => drafts.set(k, v), removeItem: k => drafts.delete(k) } });
  const doc = store.createSurface('tab:1'); doc.open('/a.txt', { content: 'disk' }); doc.buffer.setContent('draft');
  const el = { style: {}, value: '', textContent: '', classList: { add() {}, remove() {}, contains: () => false }, focus() {} };
  const context = { window: { _appUnlocked: true }, tabs: [{ type: 'file', document: doc, cm: { getValue: () => 'draft' }, path: '/a.txt' }],
    document: { getElementById: () => el, querySelectorAll: () => [] }, _confirmQueue: [], _confirmState: null, lastFocusedElement: null,
    _dockedFileTabId: null, _termSessionsPollTimer: null, _sysStatsFetch: {}, _gitReq: 0, finderTimer: null, finderAbort: null,
    panelState: { buffer: null }, panelContent: () => '', releasePanelSurface() {}, cleanupDocViewers() {}, cleanupWebSocket() {},
    closeSystemStats() {}, stopSysIconPulse() {}, stopLpPulse() {}, closeAllDrawers() {}, toggleCmdLib() {}, removeFocusTrap() {}, releaseWakeLock() {},
    clearInterval() {}, clearTimeout() {}, console,
  };
  context.releaseFileTabResources = clientFunction('public/js/file-tabs.js', 'releaseFileTabResources', context);
  vm.createContext(context); vm.runInContext(sourceFunction('public/js/ui.js', 'showPinScreen'), context); context.showPinScreen();
  assert.equal(store.find('/a.txt'), null); assert.equal(drafts.get('wt-draft:/a.txt'), 'draft');
  el.value = '123'; context.showPinScreen(); assert.equal(el.value, '123');
});

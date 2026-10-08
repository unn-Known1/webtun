'use strict';
const { test, expect } = require('@playwright/test');

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => typeof homeDir === 'string' && homeDir && typeof openFileEditor === 'function');
  await page.waitForFunction(() => document.querySelector('#file-list .file-item'));
}
async function openPanel(page,name) {
  await page.evaluate(name => openFileEditor(homeDir+'/'+name),name);
  await expect(page.locator('#editor-view')).toHaveClass(/open/);
}
async function panelText(page) { return page.evaluate(() => panelContent()); }
async function editPanel(page,content) {
  await page.evaluate(content => { installPanelContent(content); updateEditorDirty(); autoSaveDraft(); },content);
}

test('workspace boots without script errors and fits the viewport', async ({ page }) => {
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await ready(page);
  await page.locator('#home-btn').click();
  await expect(page.locator('#launchpad')).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.lp-new')).toBeVisible();
  await expect(page.locator('.lp-quick button')).toHaveCount(3);
  await expect(page.locator('#lp-pulse')).toContainText('25%');
  const unknown = await page.evaluate(() => {
    const events = { 'data-action':'click', 'data-change-action':'change', 'data-input-action':'input', 'data-keydown-action':'keydown' };
    const missing = [];
    for (const [attr,event] of Object.entries(events)) {
      document.querySelectorAll('['+attr+']').forEach(el => {
        if (!uiActions.has(event,el.getAttribute(attr))) missing.push(el.getAttribute(attr));
      });
    }
    return missing;
  });
  expect(unknown).toEqual([]);
  await page.screenshot({ path:'test-results/current-'+test.info().project.name+'.png',fullPage:true,animations:'disabled' });
});

test('panel to tab and back preserves edits and undo history', async ({ page }) => {
  await ready(page); await openPanel(page,'alpha.txt');
  const original = await panelText(page);
  await editPanel(page,'handover edits');
  const hasUndo = await page.evaluate(() => !!editor);
  await page.evaluate(() => openEditorAsTab());
  await page.waitForFunction(() => tabs.some(t=>t.type==='file' && t.cm));
  expect(await page.evaluate(() => tabs.find(t=>t.type==='file').cm.getValue())).toBe('handover edits');
  expect(await page.evaluate(() => panelState.buffer === null)).toBe(true);
  await page.evaluate(() => moveTabToPanel(tabs.find(t=>t.type==='file')));
  expect(await panelText(page)).toBe('handover edits');
  expect(await page.evaluate(() => panelState.buffer.dirty)).toBe(true);
  if (hasUndo) {
    await page.evaluate(() => editor.undo());
    expect(await panelText(page)).toBe(original);
  }
});

test('a delayed save keeps newer edits and its recovery draft', async ({ page }) => {
  await ready(page); await openPanel(page,'alpha.txt');
  await editPanel(page,'submitted');
  let release; const gate=new Promise(resolve=>{ release=resolve; });
  await page.route('**/api/files/write',async route => { await gate; await route.continue(); });
  const requested=page.waitForRequest('**/api/files/write');
  await page.evaluate(() => { void saveFile(); }); await requested;
  await editPanel(page,'typed during save');
  release();
  await page.waitForFunction(() => panelState.buffer && panelState.buffer.saving===0);
  expect(await panelText(page)).toBe('typed during save');
  expect(await page.evaluate(() => panelState.buffer.dirty)).toBe(true);
  expect(await page.evaluate(() => loadDraft(panelState.path))).toBe('typed during save');
});

test('an external reload keeps edits typed while the read was pending', async ({ page }) => {
  await ready(page); await openPanel(page,'beta.txt');
  let release; const gate=new Promise(resolve=>{ release=resolve; });
  await page.route('**/api/files/read?*',async route => { await gate; await route.continue(); });
  const requested=page.waitForRequest('**/api/files/read?*');
  await page.evaluate(() => { void autoRefreshPanelFile(panelState.path,'new-time',20); }); await requested;
  await editPanel(page,'keep these edits'); release();
  await expect(page.locator('#editor-status')).toContainText('Changed on disk');
  expect(await panelText(page)).toBe('keep these edits');
});

test('native textarea fallback supports editing, handover, and saving', async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**',route=>route.abort());
  await ready(page); await openPanel(page,'beta.txt');
  await page.locator('#editor-textarea').fill('fallback edits');
  await page.evaluate(() => openEditorAsTab());
  await page.waitForFunction(() => tabs.some(t=>t.type==='file' && t.cm));
  expect(await page.evaluate(() => tabs.find(t=>t.type==='file').cm.isFallback)).toBe(true);
  await page.evaluate(() => saveTabFile(tabs.find(t=>t.type==='file')));
  expect(await page.evaluate(() => tabs.find(t=>t.type==='file').document.buffer.dirty)).toBe(false);
});

test('the latest file open wins when an earlier read finishes late', async ({ page }) => {
  await ready(page);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/files/read?*',async route => {
    if (new URL(route.request().url()).searchParams.get('path').endsWith('/alpha.txt')) await gate;
    await route.continue();
  });
  const requested = page.waitForRequest(request => request.url().includes('/api/files/read?') && request.url().includes('alpha.txt'));
  await page.evaluate(() => { void openFileEditor(homeDir+'/alpha.txt'); });
  await requested;
  await openPanel(page,'beta.txt');
  release();
  await page.waitForResponse(response => response.url().includes('/api/files/read?') && response.url().includes('alpha.txt'));
  expect(await page.evaluate(() => panelState.path.endsWith('/beta.txt'))).toBe(true);
  expect(await panelText(page)).toBe(await page.evaluate(() => panelState.buffer.original));
});

test('reopening after reload offers and restores the recovery draft', async ({ page }) => {
  await ready(page); await openPanel(page,'alpha.txt');
  await editPanel(page,'recover this draft');
  await page.evaluate(() => panelState.buffer.flushDraft());
  await page.reload();
  await page.waitForFunction(() => homeDir && document.querySelector('#file-list .file-item'));
  await page.evaluate(() => { void openFileEditor(homeDir+'/alpha.txt'); });
  await expect(page.locator('#confirm-overlay')).toBeVisible();
  await page.locator('#confirm-ok-btn').click();
  await expect(page.locator('#editor-view')).toHaveClass(/open/);
  expect(await panelText(page)).toBe('recover this draft');
  expect(await page.evaluate(() => panelState.buffer.dirty)).toBe(true);
});

test('settings and shortcuts can be opened and dismissed with the keyboard', async ({ page }) => {
  await ready(page);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-panel')).toHaveClass(/open/);
  await page.evaluate(() => openShortcuts());
  await expect(page.locator('#shortcuts-overlay')).toBeVisible();
  await expect(page.locator('#shortcuts-overlay .btn').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#shortcuts-overlay')).toBeHidden();
  await page.locator('#s-blink').focus();
  const previous = await page.locator('#s-blink').getAttribute('aria-checked');
  await page.keyboard.press('Space');
  await expect(page.locator('#s-blink')).toHaveAttribute('aria-checked',previous === 'true' ? 'false' : 'true');
});

test('keyboard actions report async failures without unhandled rejections', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await page.evaluate(() => {
    createTunnel = async () => { throw new Error('Tunnel action fixture'); };
  });
  await page.locator('#settings-btn').click();
  await page.locator('#settings-search').fill('tunnel');
  await page.locator('#tunnel-url').press('Enter');
  const failures = page.locator('#toast-container .toast.error').filter({ hasText: 'Action failed' });
  await expect(failures).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('menu actions report async failures without unhandled rejections', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await page.evaluate(() => {
    openTerminalSessionsModal = async () => { throw new Error('Sessions action fixture'); };
  });
  await page.locator('#more-btn:visible, #mnav-more:visible').first().click();
  await expect(page.locator('#more-menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Terminal Sessions', exact: true }).click();
  await expect(page.locator('#toast-container .toast.error')).toContainText('Action failed');
  await expect(page.locator('#more-menu')).toBeHidden();
  expect(errors).toEqual([]);
});

test('opening a different file starts its own undo history', async ({ page }) => {
  await ready(page); await openPanel(page,'alpha.txt');
  await openPanel(page,'beta.txt');
  const beta = await panelText(page);
  await editPanel(page,'beta edit');
  const hasUndo = await page.evaluate(() => !!editor);
  if (hasUndo) {
    await page.evaluate(() => { editor.undo(); editor.undo(); });
    expect(await panelText(page)).toBe(beta);
    expect(await page.evaluate(() => panelState.path.endsWith('/beta.txt'))).toBe(true);
  }
});

test('a save completing while the tab editor loads keeps the saved baseline', async ({ page }) => {
  await ready(page); await openPanel(page,'alpha.txt');
  await editPanel(page,'saved while transferring');
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/files/write',async route => { await gate; await route.continue(); });
  const requested = page.waitForRequest('**/api/files/write');
  await page.evaluate(() => { void saveFile(); }); await requested;
  await page.evaluate(() => {
    const originalLoad = ensureCodeMirrorLoaded;
    ensureCodeMirrorLoaded = () => new Promise(resolve => { window.releaseEditorLoad = () => originalLoad().then(resolve); });
    openEditorAsTab();
  });
  release();
  await page.waitForFunction(() => tabs.some(t => t.type === 'file' && t.document.buffer?.saving === 0));
  await page.evaluate(() => window.releaseEditorLoad());
  await page.waitForFunction(() => tabs.some(t => t.type === 'file' && t.cm));
  expect(await page.evaluate(() => tabs.find(t => t.type === 'file').document.buffer.dirty)).toBe(false);
  expect(await page.evaluate(() => tabs.find(t => t.type === 'file').cm.getValue())).toBe('saved while transferring');
});

test('closing a loading file tab prompts before discarding and releases its buffer', async ({ page }) => {
  await ready(page); await openPanel(page,'beta.txt');
  await editPanel(page,'pending editor edits');
  await page.evaluate(() => {
    const originalLoad = ensureCodeMirrorLoaded;
    ensureCodeMirrorLoaded = () => new Promise(resolve => { window.releaseEditorLoad = () => originalLoad().then(resolve); });
    openEditorAsTab(); settings.confirmclose = false;
    void closeTab(null,tabs.find(t => t.type === 'file').id);
  });
  await expect(page.locator('#confirm-overlay')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Unsaved changes');
  await page.locator('#confirm-ok-btn').click();
  await page.evaluate(() => window.releaseEditorLoad());
  await page.waitForFunction(() => !tabs.some(t => t.type === 'file'));
  expect(await page.evaluate(() => editorBuffers.find(homeDir+'/beta.txt'))).toBeNull();
  expect(await page.evaluate(() => loadDraft(homeDir+'/beta.txt'))).toBeNull();
});

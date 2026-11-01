'use strict';
const { test, expect } = require('@playwright/test');

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => homeDir && typeof openFileEditor === 'function');
  await page.waitForFunction(() => document.querySelector('#file-list .file-item'));
}

for (const status of ['pro', 'community', 'unavailable']) {
  test('authenticated startup preserves the session and all saved tabs with license status ' + status, async ({ page }) => {
    const token = 'a'.repeat(64), requests = [];
    await page.addInitScript(token => {
      localStorage.setItem('wt-session-token', token);
      localStorage.setItem('wt-tabs', JSON.stringify({ activeTabId: 5, tabs: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, type: 'term', title: 'Saved ' + (i + 1), sessionId: 'saved-' + i })) }));
    }, token);
    await page.route('**/api/auth/required', route => route.fulfill({ json: { required: true } }));
    await page.route('**/api/auth/me', route => { requests.push('resume'); return route.fulfill({ json: { ok: true, pending: false } }); });
    await page.route('**/api/license/status', route => {
      const authed = route.request().headers()['x-pin-token'] === token;
      requests.push(authed ? 'license-authenticated' : 'license-anonymous');
      return route.fulfill({ status: !authed ? 401 : status === 'unavailable' ? 503 : 200,
        json: !authed ? { error: 'Unauthorized' } : status === 'unavailable' ? { error: 'temporarily unavailable' } : { plan: status, enforce: status === 'pro' } });
    });
    await ready(page);
    await page.waitForFunction(() => tabs.filter(t => t.type === 'term').length === 5);
    expect(await page.evaluate(() => safeStorage.getItem('wt-session-token'))).toBe(token);
    expect(await page.evaluate(() => JSON.parse(safeStorage.getItem('wt-tabs')).tabs.length)).toBe(5);
    expect(requests.slice(0, 2)).toEqual(['resume', 'license-authenticated']);
    expect(await page.evaluate(() => terminalCap())).toBe(Infinity);
  });
}

test('Save during editor loading writes the new file and keeps edits typed before loading finishes', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    await openFileEditor(homeDir + '/alpha.txt');
    window._originalInitEditor = initCodeMirror;
    initCodeMirror = () => new Promise(resolve => { window._releaseEditor = () => window._originalInitEditor().then(resolve); });
    window._openingPanel = openFileEditor(homeDir + '/beta.txt');
  });
  await page.waitForFunction(() => typeof window._releaseEditor === 'function');
  const saved = await page.evaluate(async () => {
    const before = (await api('/api/files/read?path=' + encodeURIComponent(homeDir + '/beta.txt'))).content;
    await saveFile();
    const after = (await api('/api/files/read?path=' + encodeURIComponent(homeDir + '/beta.txt'))).content;
    installPanelContent('typed while mode loads'); updateEditorDirty(); autoSaveDraft();
    window._releaseEditor(); await window._openingPanel;
    initCodeMirror = window._originalInitEditor;
    return { before, after, visible: panelContent(), dirty: panelState.buffer.dirty };
  });
  expect(saved.after).toBe(saved.before);
  expect(saved.visible).toBe('typed while mode loads'); expect(saved.dirty).toBe(true);
});

test('a restored file-tab draft survives a second reload without another edit', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    safeStorage.setItem('wt-draft:' + homeDir + '/alpha.txt', 'recovery text');
    newFileTab(homeDir + '/alpha.txt');
  });
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await page.waitForFunction(() => tabs.some(t => t.type === 'file' && t.cm && t.cm.getValue() === 'recovery text'));
  expect(await page.evaluate(() => loadDraft(homeDir + '/alpha.txt'))).toBe('recovery text');
  await page.reload();
  await page.waitForFunction(() => tabs.some(t => t.type === 'file'));
  await page.evaluate(() => { void activateTab(tabs.find(t => t.type === 'file').id); });
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await page.waitForFunction(() => tabs.some(t => t.type === 'file' && t.cm && t.cm.getValue() === 'recovery text'));
  expect(await page.evaluate(() => loadDraft(homeDir + '/alpha.txt'))).toBe('recovery text');
});

test('background drafts survive an ordinary close and activation offers an explicit restore decision', async ({ page }) => {
  await ready(page);
  const pending = await page.evaluate(async () => {
    const file = homeDir + '/alpha.txt';
    safeStorage.setItem('wt-draft:' + file, 'background recovery');
    const tab = newFileTab(file, { mount: false });
    await ensureTabEditor(tab, null, { background: true });
    const readonly = tab.cm.getOption ? tab.cm.getOption('readOnly') : tab.fteHost.querySelector('textarea').readOnly;
    await closeTab({ stopPropagation() {} }, tab.id, { force: true });
    const kept = loadDraft(file);
    const reopened = newFileTab(file, { mount: false });
    await ensureTabEditor(reopened, null, { background: true });
    activateTab(reopened.id);
    return { readonly, kept };
  });
  expect(pending.readonly).toBe(true); expect(pending.kept).toBe('background recovery');
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  await page.waitForFunction(() => tabs.some(t => t.type === 'file' && t.cm && t.cm.getValue() === 'background recovery'));
  expect(await page.evaluate(() => loadDraft(homeDir + '/alpha.txt'))).toBe('background recovery');
});

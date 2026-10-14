'use strict';
const { test, expect } = require('@playwright/test');

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window._appUnlocked && homeDir && tabs[0]?.term);
}
test('PDF, EPUB and Office toolbar downloads dispatch the current viewer path', async ({ page }) => {
  await ready(page);
  const paths = await page.evaluate(async () => {
    const seen = []; downloadFile = path => { seen.push(path); };
    for (const kind of ['pdf', 'epub', 'office']) {
      panelState.path = homeDir + '/dummy.' + kind;
      document.querySelector('#' + kind + '-viewer [data-action="download-file"]').click();
    }
    await Promise.resolve(); return seen;
  });
  expect(paths.map(p => p.split('/').pop())).toEqual(['dummy.pdf', 'dummy.epub', 'dummy.office']);
});
test('lock teardown closes overlays, preserves file drafts and permits reopening after unlock', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => { await openFileAsTab(homeDir + '/alpha.txt'); });
  await page.waitForFunction(() => tabs.some(t => t.type === 'file' && t.cm));
  await page.evaluate(() => {
    const tab = tabs.find(t => t.type === 'file');
    tab.cm.setValue('keep this draft');
    try { tab.document.buffer?.setContent('keep this draft'); tab.document.buffer?.flushDraft(); } catch {}
    openSystemStats(); showPinScreen();
  });
  await expect(page.locator('#pin-screen')).toBeVisible();
  expect(await page.locator('.overlay.open').count()).toBe(0);
  expect(await page.evaluate(() => editorBuffers.find(homeDir + '/alpha.txt'))).toBe(null);
  expect(await page.evaluate(() => safeStorage.getItem('wt-draft:' + homeDir + '/alpha.txt'))).toBe('keep this draft');
  await page.locator('#pin-input').fill('123'); await page.evaluate(() => showPinScreen());
  await expect(page.locator('#pin-input')).toHaveValue('123');
  await page.evaluate(() => { authToken = 'open'; void unlockApp(); });
  await page.evaluate(async () => { await openFileAsTab(homeDir + '/alpha.txt'); });
  await expect(page.locator('#confirm-overlay')).toBeVisible(); await page.locator('#confirm-ok-btn').click();
  await page.waitForFunction(() => tabs.some(t => t.type === 'file' && t.cm?.getValue() === 'keep this draft'));
});
test('cancelling a synthesized tab swipe restores its styles and leaves the tab open', async ({ page }) => {
  await ready(page);
  const state = await page.evaluate(() => {
    const tab = tabs[0], el = tab.el;
    const fire = (name, y, active = true) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      const touch = { clientX: 100, clientY: y };
      Object.defineProperties(event, { touches: { value: active ? [touch] : [] }, changedTouches: { value: [touch] } });
      el.dispatchEvent(event);
    };
    fire('touchstart', 100); fire('touchmove', 80);
    const moved = el.style.transform; fire('touchcancel', 80, false);
    return { moved, transform: el.style.transform, opacity: el.style.opacity, exists: tabs.includes(tab) };
  });
  expect(state.moved).not.toBe(''); expect(state.transform).toBe(''); expect(state.opacity).toBe(''); expect(state.exists).toBe(true);
});
test('billing plan, annual term, seats and renewal controls fit the drawer', async ({ page }) => {
  await ready(page); await page.locator('#settings-btn').click(); await page.locator('#settings-search').fill('security');
  await page.locator('.billing-controls summary').click(); await page.locator('#billing-plan').selectOption('team');
  await expect(page.locator('#billing-seats')).toBeVisible(); await page.locator('#billing-term').selectOption('yearly'); await page.locator('#billing-seats').fill('6');
  let sent;
  await page.route('**/api/billing/checkout', route => { sent = route.request().postDataJSON(); return route.fulfill({ json: { error: 'Fixture billing is not configured' }, status: 501 }); });
  await page.locator('#billing-checkout-btn').click(); await expect(page.locator('#billing-error')).toContainText('not configured');
  expect(sent).toEqual({ plan: 'team', annual: true, seats: 6 });
  expect(await page.locator('.settings-panel-body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  if (process.env.WEBTUN_TEST_EVIDENCE) await page.screenshot({ path:process.env.WEBTUN_TEST_EVIDENCE + '/billing-' + test.info().project.name + '.png', animations:'disabled' });
});
test('Data Saver suppresses automatic Launchpad stats requests', async ({ page }) => {
  await ready(page);
  const count = await page.evaluate(async () => {
    settings.datasaver = true; lpPinned = true; updateLaunchpad();
    const old = fetchSystemStats; let requests = 0; fetchSystemStats = async () => { requests++; return {}; };
    await tickLpPulse(); await tickLpPulse(); fetchSystemStats = old;
    return requests;
  });
  expect(count).toBe(0);
});
test('advanced Git merge, deletion, blame and history controls are wired and fit the sidebar', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const dir = homeDir + '/browser-git-' + Date.now();
    await api('/api/files/mkdir', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({path:dir}) });
    await api('/api/git/init', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({path:dir}) });
    await loadFiles(dir); await refreshGitPanel(dir, true); toggleGitAdvanced();
  });
  await expect(page.locator('#git-manage-branch')).toBeVisible(); await expect(page.locator('[data-action="git-blame"]')).toBeVisible();
  expect(await page.evaluate(() => ['git-merge','git-delete-branch','git-continue','git-abort','git-blame'].every(action => uiActions.has('click', action)))).toBe(true);
  expect(await page.locator('#git-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  if (process.env.WEBTUN_TEST_EVIDENCE) await page.screenshot({ path:process.env.WEBTUN_TEST_EVIDENCE + '/git-' + test.info().project.name + '.png', animations:'disabled' });
});

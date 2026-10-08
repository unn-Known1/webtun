'use strict';
const { test, expect } = require('@playwright/test');

const stats = {
  hostname: 'development-workstation', platform: 'linux', uptime: 183840,
  cpu: { count: 16, usage: 34, loadAvg: [1.42, 1, 1] },
  memory: { total: 32e9, used: 12e9, percent: 38 },
  disk: [{ usePercent: '62%', used: '310G', size: '500G' }],
  gpus: [{ name: 'NVIDIA GeForce RTX 4070', memTotal: 12288, memUsed: 4096, utilization: 24, temp: 48, driver: 'nvidia' }],
  processes: [
    { pid: 1420, user: 'developer', cpu: '24.5', mem: '3.2', cmd: '/usr/bin/node development-server.js --watch' },
    { pid: 820, user: 'root', cpu: '8.0', mem: '1.4', cmd: '/usr/bin/containerd' },
    { pid: 2300, user: 'developer', cpu: '2.1', mem: '0.8', cmd: '/usr/bin/ssh remote-workstation' },
  ],
};

test('system stats preserves metrics, filtering, keyboard sorting and process actions across refresh', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/system', route => route.fulfill({ json: stats }));
  const kills = [];
  await page.route('**/api/system/kill', route => {
    kills.push(route.request().postDataJSON().pid);
    return route.fulfill({ json: { success: true } });
  });
  await page.goto('/');
  await page.waitForFunction(() => window._appUnlocked);
  await page.evaluate(() => openSystemStats());
  await expect(page.locator('#sys-cpu-val')).toHaveText('34%');
  await expect(page.locator('#sys-gpu-container')).toContainText('NVIDIA GeForce RTX 4070');
  await expect(page.locator('#sys-proc-body tr')).toHaveCount(3);
  await expect(page.locator('#sys-update-status')).toContainText('Every 5s');
  expect(await page.locator('#sys-overlay .modal').evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
  })).toBe(true);
  expect(await page.locator('.sys-body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.locator('.sys-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(test.info().project.name === 'mobile' ? 2 : 4);
  await page.screenshot({ path: test.info().outputPath('system-stats.png') });
  await page.locator('#sys-proc-filter').fill('ssh');
  await expect(page.locator('#sys-proc-body tr')).toHaveCount(1);
  await expect(page.locator('#sys-proc-count')).toHaveText('1 / 3');
  await page.locator('#sys-proc-filter').fill('');
  const sort = page.locator('[data-action="sort-sys-processes-pid"]');
  await sort.focus();
  await page.keyboard.press('Enter');
  await expect(sort.locator('..')).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('#sys-proc-body tr').first()).toContainText('2300');
  await page.locator('[data-action="refresh-system-stats"]').click();
  await expect(page.locator('#sys-update-status')).toContainText('Every 5s');
  await expect(page.locator('#sys-proc-body tr').first()).toContainText('2300');
  await page.locator('#sys-proc-filter').fill('does-not-exist');
  await expect(page.locator('#sys-proc-body')).toContainText('No matching processes');
  await page.locator('#sys-proc-filter').fill('ssh');
  const kill = page.getByRole('button', { name: 'Kill process 2300', exact: true });
  await kill.click();
  await expect(kill).toHaveText('Confirm?');
  await page.evaluate(() => refreshSystemStats(false));
  await expect(kill).toHaveText('Confirm?');
  await kill.click();
  await expect.poll(() => kills).toEqual([2300]);
  await page.locator('.sys-header [data-action="close-system-stats"]').click();
  await expect(page.locator('#sys-overlay')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('system stats explains Data Saver and recovers from a failed initial load', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window._appUnlocked);
  await page.evaluate(() => { settings.datasaver = true; openSystemStats(); });
  await expect(page.locator('#sys-loading')).toContainText('Turn off Data Saver');
  await page.route('**/api/system', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.evaluate(() => { settings.datasaver = false; });
  await page.locator('[data-action="refresh-system-stats"]').click();
  await expect(page.locator('#sys-loading')).toContainText('Select Refresh');
  await page.unroute('**/api/system');
  await page.route('**/api/system', route => route.fulfill({ json: stats }));
  await page.locator('[data-action="refresh-system-stats"]').click();
  await expect(page.locator('#sys-cpu-val')).toHaveText('34%');
  await expect(page.locator('#sys-loading')).not.toBeVisible();
});

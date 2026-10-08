'use strict';
const { test, expect } = require('@playwright/test');

async function openSettingsPanel(page) {
  await page.goto('/');
  await page.waitForFunction(() => window._appUnlocked);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-panel')).toHaveClass(/open/);
}

test('every Settings subsection fits the drawer and search remains reachable while scrolling', async ({ page }) => {
  await openSettingsPanel(page);
  for (const name of ['security', 'appearance', 'terminal', 'interface', 'features', 'tunnel', 'system']) {
    await page.locator('#settings-search').fill(name);
    const section = page.locator('.settings-section[data-sec="' + name + '"]');
    await expect(section).toBeVisible();
    await expect(section.locator('h3')).toHaveAttribute('aria-expanded', 'true');
    await expect(section.locator('.settings-section-body')).not.toHaveAttribute('inert');
    await expect.poll(() => section.evaluate(el => {
      const panel = document.getElementById('settings-panel').getBoundingClientRect();
      return [...el.querySelectorAll('input:not([type="checkbox"]), select, .btn, .toggle')].every(control => {
        if (!control.getClientRects().length) return true;
        const r = control.getBoundingClientRect();
        return r.left >= panel.left && r.right <= panel.right;
      });
    })).toBe(true);
  }
  await page.locator('#settings-search').fill('');
  const top = await page.locator('#settings-search').evaluate(el => el.getBoundingClientRect().top);
  await page.locator('.settings-panel-body').evaluate(el => el.scrollTop = el.scrollHeight);
  await expect(page.locator('#settings-search')).toBeVisible();
  expect(await page.locator('#settings-search').evaluate(el => el.getBoundingClientRect().top)).toBe(top);
  expect(await page.locator('.settings-panel-body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('Settings search restores collapsed accessibility and keeps desktop-only controls hidden', async ({ page }) => {
  await openSettingsPanel(page);
  const appearance = page.locator('.settings-section[data-sec="appearance"]');
  await expect(appearance.locator('.settings-section-body')).toHaveAttribute('inert', '');
  await page.locator('#settings-search').fill('appearance');
  await expect(appearance).toBeVisible();
  await expect(page.locator('.settings-section[data-sec="system"]')).not.toBeVisible();
  await expect(appearance.locator('.settings-section-body')).not.toHaveAttribute('inert');
  await page.locator('#settings-search').fill('');
  await expect(appearance.locator('.settings-section-body')).toHaveAttribute('inert', '');
  await page.locator('#settings-search').fill('interface');
  await expect(page.locator('#settings-panel .electron-only')).not.toBeVisible();
  await page.locator('#settings-search').fill('no-such-setting');
  await expect(page.locator('#settings-no-match')).toBeVisible();
  await page.locator('#settings-search').press('Escape');
  await expect(page.locator('#settings-no-match')).not.toBeVisible();
  await appearance.locator('h3').focus();
  await page.keyboard.press('Enter');
  await expect(appearance.locator('h3')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#s-blink').focus();
  const before = await page.locator('#s-blink').getAttribute('aria-checked');
  await page.keyboard.press('Space');
  await expect(page.locator('#s-blink')).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/);
});

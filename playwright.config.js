'use strict';
const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3098', trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block',
    ...(process.env.WEBTUN_BROWSER_SANDBOX_ARGS === '1' && { launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=V8Sandbox', '--js-flags=--max-old-space-size=128 --disable-wasm-trap-handler'] } }),
  },
  webServer: { command: 'node tests/browser/server.js', url: 'http://127.0.0.1:3098/api/auth/required', reuseExistingServer: false, timeout: 15000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport:{ width:1440,height:900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    ...(process.env.WEBTUN_TEST_WEBKIT === '1' ? [{ name: 'webkit-mobile', use: { ...devices['iPhone 13'] } }] : []),
  ],
});

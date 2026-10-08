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
  use: { baseURL: 'http://127.0.0.1:3098', trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block' },
  webServer: { command: 'node tests/browser/server.js', url: 'http://127.0.0.1:3098/api/auth/required', reuseExistingServer: false, timeout: 15000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport:{ width:1440,height:900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});

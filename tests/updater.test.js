'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  compareSemver,
  parseSemver,
  checkUpdate,
  executeUpgrade,
} = require('../lib/updater');

const binWebtun = path.resolve(__dirname, '../bin/webtun.js');

test('parseSemver parses standard and prefixed version strings', () => {
  const p1 = parseSemver('2.3.8');
  assert.deepEqual(p1, { major: 2, minor: 3, patch: 8, prerelease: null });

  const p2 = parseSemver('v1.0.4');
  assert.deepEqual(p2, { major: 1, minor: 0, patch: 4, prerelease: null });

  const p3 = parseSemver('2.4.0-beta.1');
  assert.deepEqual(p3, { major: 2, minor: 4, patch: 0, prerelease: ['beta', '1'] });

  assert.equal(parseSemver('invalid'), null);
  assert.equal(parseSemver(null), null);
});

test('compareSemver accurately compares version numbers and pre-releases', () => {
  assert.equal(compareSemver('2.3.8', '2.3.8'), 0);
  assert.equal(compareSemver('v2.3.8', '2.3.8'), 0);
  assert.equal(compareSemver('2.3.8', 'v2.3.8'), 0);

  assert.equal(compareSemver('2.4.0', '2.3.8'), 1);
  assert.equal(compareSemver('3.0.0', '2.3.8'), 1);
  assert.equal(compareSemver('2.3.9', '2.3.8'), 1);

  assert.equal(compareSemver('2.3.7', '2.3.8'), -1);
  assert.equal(compareSemver('1.9.9', '2.0.0'), -1);

  // Release vs pre-release
  assert.equal(compareSemver('2.4.0', '2.4.0-beta.1'), 1);
  assert.equal(compareSemver('2.4.0-beta.1', '2.4.0'), -1);
  assert.equal(compareSemver('2.4.0-beta.2', '2.4.0-beta.1'), 1);
});

test('checkUpdate identifies available updates', async () => {
  const res = await checkUpdate({
    packageName: 'webtun',
    currentVersion: '0.0.1', // Artificially low version to test hasUpdate
    timeoutMs: 5000,
  });

  if (res.success) {
    assert.equal(typeof res.latestVersion, 'string');
    assert.equal(res.hasUpdate, true);
  }
});

test('executeUpgrade with dry-run returns success without executing npm', () => {
  const code = executeUpgrade({
    packageName: 'webtun',
    targetVersion: '2.3.9',
    isGlobal: true,
    dryRun: true,
  });
  assert.equal(code, 0);
});

test('CLI webtun update --help and upgrade --help print usage and exit 0', () => {
  const r1 = spawnSync(process.execPath, [binWebtun, 'update', '--help'], { encoding: 'utf8' });
  assert.equal(r1.status, 0);
  assert.match(r1.stdout, /WebTun Upgrade/);
  assert.match(r1.stdout, /webtun update \[options\]/);

  const r2 = spawnSync(process.execPath, [binWebtun, 'upgrade', '--help'], { encoding: 'utf8' });
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /WebTun Upgrade/);
  assert.match(r2.stdout, /webtun upgrade \[options\]/);
});

test('CLI webtun update --check runs update check cleanly', () => {
  const res = spawnSync(process.execPath, [binWebtun, 'update', '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /WebTun Upgrade Check/);
});

test('CLI webtun upgrade --dry-run --force prints simulated command', () => {
  const res = spawnSync(process.execPath, [binWebtun, 'upgrade', '--dry-run', '--force'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /\[dry-run\] Would execute:/);
  assert.match(res.stdout, /npm install/);
});

test('CLI webtun --update --check flag alias works identically to subcommand', () => {
  const res = spawnSync(process.execPath, [binWebtun, '--update', '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /WebTun Upgrade Check/);
});

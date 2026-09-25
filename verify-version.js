#!/usr/bin/env node
'use strict';

// Release guard.
//
// The release checklist has always said "bump package.json AND
// package-lock.json" — but nothing verified it. A human bumping only
// package.json (or reusing a stale lockfile) shipped an npm tarball whose
// lockfile disagreed with its manifest, and a tag could point at a version
// that the package did not claim.
//
// Checks:
//   1. package-lock.json top-level `version` matches package.json
//   2. package-lock.json `packages[""].version` matches package.json
//   3. when running on a `v*` tag (CI), the tag matches package.json
//
// Usage:  node verify-version.js [expected-version]
// CI:     GITHUB_REF_NAME is read automatically on tag builds.

const fs = require('fs');
const path = require('path');

const root = __dirname;
const problems = [];

const pkg = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (e) {
    console.error('✗ cannot read package.json: ' + (e.message || e));
    process.exit(1);
  }
})();
if (typeof pkg.version !== 'string' || !pkg.version) {
  console.error('✗ package.json has no usable "version" string');
  process.exit(1);
}
const version = pkg.version;

let lock = null;
try {
  lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
} catch (e) {
  problems.push('package-lock.json is unreadable (' + (e.code || e.message) + ') — run `npm install` to regenerate it');
}

if (lock) {
  if (lock.version !== version) {
    problems.push(`package-lock.json "version" is ${JSON.stringify(lock.version)}, expected ${JSON.stringify(version)}`);
  }
  const rootEntry = lock.packages && lock.packages[''];
  if (!rootEntry) {
    problems.push('package-lock.json has no packages[""] entry — regenerate it with a current npm');
  } else if (rootEntry.version !== version) {
    problems.push(`package-lock.json packages[""].version is ${JSON.stringify(rootEntry.version)}, expected ${JSON.stringify(version)}`);
  }
}

// A `v*` tag build must match the manifest, or CI publishes the wrong version.
// Strict: any GITHUB_REF_NAME on a tag build must carry the `v` prefix — a
// `2.2.3`-style tag used to slip past this check entirely.
const tag = process.env.GITHUB_REF_NAME || '';
if (tag) {
  if (!tag.startsWith('v')) {
    problems.push(`git tag ${tag} is missing the required "v" prefix (want v${version}) — CI only builds v* tags`);
  } else if (tag !== 'v' + version) {
    problems.push(`git tag ${tag} does not match package.json version ${version}`);
  }
}

// README-heading↔tag invariant (AGENTS.md): a `### vX.Y.Z` heading advertises
// a release, so the current version must have one — v2.2.0 shipped a heading
// with no tag, v2.2.3 a tag with no heading. Both directions break installs.
try {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const re = new RegExp('^###\\s+v' + version.replace(/\./g, '\\.') + '\\s*$', 'm');
  if (!re.test(readme)) {
    problems.push(`README.md has no "### v${version}" changelog heading for package.json version ${version}`);
  }
} catch (e) {
  problems.push('README.md is unreadable (' + (e.code || e.message) + ') — cannot check the changelog heading');
}

// Dirty-tree refuse, publish path only: `npm run version:check` / `npm test`
// must stay green on a working tree, but `prepublishOnly` must not ship one.
if (process.env.npm_lifecycle_event === 'prepublishOnly') {
  try {
    const { execFileSync } = require('child_process');
    const dirty = (() => {
      try {
        execFileSync('git', ['diff', '--quiet'], { cwd: root, stdio: 'ignore' });
        execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: root, stdio: 'ignore' });
        return false;
      } catch { return true; }
    })();
    if (dirty) problems.push('working tree has uncommitted changes — commit or stash before publishing');
  } catch {
    // No git available (publishing from a tarball dir): cannot verify, skip.
  }
}

// Optional explicit expectation (e.g. `node verify-version.js 2.1.0`).
const expected = (process.argv[2] || process.env.WEBTUN_EXPECT_VERSION || '').trim();
if (expected) {
  const want = expected.startsWith('v') ? expected.slice(1) : expected;
  if (want !== version) problems.push(`expected version ${want}, but package.json is ${version}`);
}

if (problems.length) {
  console.error('✗ version check failed:');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nFix: run `npm version <patch|minor|major>` — it bumps package.json and');
  console.error('package-lock.json together and creates the v<version> tag.');
  process.exit(1);
}

console.log(`✓ version ${version} — package.json and package-lock.json agree${tag ? ` (tag ${tag})` : ''}`);

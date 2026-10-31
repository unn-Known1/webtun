'use strict';

const path = require('path');
const https = require('https');
const { spawnSync, execFile, execFileSync } = require('child_process');

function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const clean = v.trim().replace(/^[vV]/, '');
  const [main, prerelease] = clean.split('-');
  const parts = main.split('.').map(n => parseInt(n, 10));
  if (parts.some(isNaN)) return null;
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    prerelease: prerelease ? prerelease.split('.') : null,
  };
}

function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (!p1 || !p2) {
    const s1 = String(v1 || '').trim().replace(/^[vV]/, '');
    const s2 = String(v2 || '').trim().replace(/^[vV]/, '');
    return s1.localeCompare(s2, undefined, { numeric: true, sensitivity: 'base' });
  }
  if (p1.major !== p2.major) return p1.major > p2.major ? 1 : -1;
  if (p1.minor !== p2.minor) return p1.minor > p2.minor ? 1 : -1;
  if (p1.patch !== p2.patch) return p1.patch > p2.patch ? 1 : -1;
  if (!p1.prerelease && p2.prerelease) return 1;
  if (p1.prerelease && !p2.prerelease) return -1;
  if (p1.prerelease && p2.prerelease) {
    const len = Math.max(p1.prerelease.length, p2.prerelease.length);
    for (let i = 0; i < len; i++) {
      const a = p1.prerelease[i];
      const b = p2.prerelease[i];
      if (a === undefined) return -1;
      if (b === undefined) return 1;
      const aNum = Number(a);
      const bNum = Number(b);
      const aIsNum = !isNaN(aNum);
      const bIsNum = !isNaN(bNum);
      if (aIsNum && bIsNum) {
        if (aNum !== bNum) return aNum > bNum ? 1 : -1;
      } else if (aIsNum && !bIsNum) {
        return -1;
      } else if (!aIsNum && bIsNum) {
        return 1;
      } else if (a !== b) {
        return a.localeCompare(b);
      }
    }
  }
  return 0;
}

function fetchFromRegistry(packageName, tag = 'latest', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
    const req = https.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'webtun-cli-updater',
      },
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`npm registry returned HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const distTags = data['dist-tags'] || {};
          let targetVersion = distTags[tag];
          if (!targetVersion && data.versions && data.versions[tag]) {
            targetVersion = tag;
          }
          if (!targetVersion && tag === 'latest') {
            const versions = Object.keys(data.versions || {});
            if (versions.length) {
              versions.sort(compareSemver);
              targetVersion = versions[versions.length - 1];
            }
          }
          if (!targetVersion) {
            return reject(new Error(`tag or version "${tag}" not found in npm registry`));
          }
          resolve(targetVersion);
        } catch (e) {
          reject(new Error('Invalid response from npm registry: ' + e.message));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

function fetchFromNpmCli(packageName, tag = 'latest', timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const target = tag === 'latest' ? packageName : `${packageName}@${tag}`;
    execFile(npmCmd, ['view', target, 'version'], {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error((stderr && stderr.trim()) || err.message));
      }
      const ver = stdout.trim();
      if (!ver) {
        return reject(new Error('empty version output from npm view'));
      }
      resolve(ver);
    });
  });
}

async function getLatestVersion(packageName, tag = 'latest', timeoutMs = 8000) {
  try {
    return await fetchFromRegistry(packageName, tag, timeoutMs);
  } catch (regErr) {
    try {
      return await fetchFromNpmCli(packageName, tag, timeoutMs);
    } catch (cliErr) {
      throw new Error(`Failed to check npm registry (${regErr.message}) and npm CLI (${cliErr.message})`);
    }
  }
}

async function checkUpdate(options = {}) {
  const currentVersion = options.currentVersion || require('../package.json').version;
  const packageName = options.packageName || require('../package.json').name || 'webtun';
  const tag = options.tag || 'latest';
  const timeoutMs = options.timeoutMs || 8000;

  try {
    const latestVersion = await getLatestVersion(packageName, tag, timeoutMs);
    const diff = compareSemver(latestVersion, currentVersion);
    return {
      success: true,
      currentVersion,
      latestVersion,
      hasUpdate: diff > 0,
      isDowngrade: diff < 0,
    };
  } catch (err) {
    return {
      success: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      error: err.message,
    };
  }
}

function isGlobalInstall(packageName = 'webtun') {
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const out = execFileSync(npmCmd, ['list', '-g', '--depth=0', packageName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    });
    if (out && out.includes(packageName)) return true;
  } catch {}

  try {
    const binPath = path.resolve(process.argv[1] || '');
    if (/[\/\\](npm|nvm|nodejs|bin)[\/\\]/i.test(binPath)) return true;
  } catch {}

  return false;
}

function printUpdateHelp() {
  console.log(`
  WebTun Upgrade

  Check for and install the latest version of WebTun.

  Usage:
    webtun update [options]
    webtun upgrade [options]

  Options:
    --check, -c           Check if a new version is available without upgrading
    --force, -f           Force upgrade even if already on the latest version
    --global, -g          Install/upgrade globally via npm (default for CLI)
    --local, -l           Install/upgrade in the current local project directory
    --tag <tag>           NPM dist-tag or specific version to install (default: latest)
    --dry-run             Show what commands would run without executing them
    --help, -H            Show this help message

  Examples:
    webtun update                 Check and upgrade to the latest version
    webtun update --check         Check if an update is available without installing
    webtun upgrade --force        Force reinstall the latest version
    webtun update --tag next      Upgrade to the "next" pre-release tag
`);
}

function parseUpdateArgs(argv) {
  const opts = {
    check: false,
    force: false,
    global: null, // null = auto-detect, true = force global, false = force local
    tag: 'latest',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-H' || arg === 'help') {
      printUpdateHelp();
      return null;
    }
    if (arg === '--check' || arg === '-c') {
      opts.check = true;
    } else if (arg === '--force' || arg === '-f') {
      opts.force = true;
    } else if (arg === '--global' || arg === '-g') {
      opts.global = true;
    } else if (arg === '--local' || arg === '-l') {
      opts.global = false;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--tag') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        console.error('Error: --tag requires a value');
        process.exit(1);
      }
      opts.tag = next;
    } else if (arg.startsWith('--tag=')) {
      opts.tag = arg.slice(6);
    } else if (arg.startsWith('-')) {
      console.error(`Unknown update option: ${arg}`);
      printUpdateHelp();
      process.exit(1);
    }
  }

  return opts;
}

function executeUpgrade({ packageName, targetVersion, isGlobal, dryRun }) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const target = targetVersion ? `${packageName}@${targetVersion}` : packageName;

  const baseArgs = ['install'];
  if (isGlobal) baseArgs.push('-g');
  baseArgs.push('--allow-scripts=webtun,node-pty');
  baseArgs.push(target);

  const fallbackArgs = ['install'];
  if (isGlobal) fallbackArgs.push('-g');
  fallbackArgs.push(target);

  if (dryRun) {
    console.log(`  [dry-run] Would execute: ${npmCmd} ${baseArgs.join(' ')}`);
    return 0;
  }

  console.log(`  Running: ${npmCmd} ${baseArgs.join(' ')}`);
  console.log('');

  let res = spawnSync(npmCmd, baseArgs, { stdio: 'inherit', windowsHide: true });

  if (res.error || res.status !== 0) {
    // If --allow-scripts failed (e.g. older npm version doesn't recognize flag), retry without it
    if (res.status !== 0 && !res.error) {
      console.log('  Retrying without --allow-scripts flag…');
      res = spawnSync(npmCmd, fallbackArgs, { stdio: 'inherit', windowsHide: true });
    }
  }

  if (res.error) {
    console.error(`\n  Error executing npm: ${res.error.message}`);
    return 1;
  }

  if (res.status !== 0) {
    console.error(`\n  Error: npm install failed with exit code ${res.status}`);
    if (isGlobal) {
      console.error('  If permission was denied, try running with sudo:');
      console.error('    sudo webtun update');
      console.error(`  Or manually run: npm install -g ${target}`);
    }
    return res.status;
  }

  return 0;
}

async function runUpgradeCommand(argv = []) {
  const opts = parseUpdateArgs(argv);
  if (opts === null) {
    return 0; // Help printed
  }

  const pkg = require('../package.json');
  const packageName = pkg.name || 'webtun';
  const currentVersion = pkg.version || '0.0.0';

  console.log('');
  console.log(`  WebTun Upgrade Check`);
  console.log(`  Current version: v${currentVersion}`);
  console.log(`  Checking npm registry for updates (${opts.tag})…`);

  const result = await checkUpdate({
    packageName,
    currentVersion,
    tag: opts.tag,
  });

  if (!result.success) {
    console.error('');
    console.error(`  Error: ${result.error}`);
    console.error(`  You can try upgrading manually by running:`);
    console.error(`    npm install -g ${packageName}@${opts.tag}`);
    console.log('');
    return 1;
  }

  const latestVersion = result.latestVersion;

  if (!result.hasUpdate && !opts.force) {
    console.log('');
    console.log(`  ✓ WebTun is already up to date (v${currentVersion}).`);
    console.log(`  Use --force to reinstall anyway.`);
    console.log('');
    return 0;
  }

  if (result.hasUpdate) {
    console.log('');
    console.log(`  ★ New version available: v${currentVersion} → v${latestVersion}`);
  } else if (opts.force) {
    console.log('');
    console.log(`  Force reinstalling version v${latestVersion}…`);
  }

  if (opts.check) {
    console.log('');
    console.log(`  To install this update, run:`);
    console.log(`    webtun update`);
    console.log('');
    return 0;
  }

  const isGlobal = opts.global !== null ? opts.global : isGlobalInstall(packageName);

  console.log(`  Upgrading WebTun ${isGlobal ? 'globally' : 'locally'} to v${latestVersion}…`);
  console.log('');

  const exitCode = executeUpgrade({
    packageName,
    targetVersion: latestVersion,
    isGlobal,
    dryRun: opts.dryRun,
  });

  if (exitCode === 0) {
    console.log('');
    console.log(`  ✓ Successfully upgraded WebTun to v${latestVersion}!`);
    console.log(`  Run "webtun --version" or "webtun" to start.`);
    console.log('');
  }

  return exitCode;
}

module.exports = {
  compareSemver,
  parseSemver,
  fetchFromRegistry,
  fetchFromNpmCli,
  getLatestVersion,
  checkUpdate,
  isGlobalInstall,
  executeUpgrade,
  runUpgradeCommand,
  printUpdateHelp,
};

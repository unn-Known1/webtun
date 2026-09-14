const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Rebuild node-pty if native module is missing ─────────────────────
function rebuildNodePty() {
  try {
    require('node-pty');
    return; // Already working
  } catch {}

  const ptyDir = path.join(__dirname, 'node_modules', 'node-pty');
  if (!fs.existsSync(ptyDir)) {
    // Reaching here means require('node-pty') already failed AND the package is
    // absent — i.e. a genuinely broken tree (--ignore-scripts, --omit=optional,
    // or a partially-failed install). Saying nothing left the user with a
    // "Cannot find module 'node-pty'" at first terminal open and no explanation.
    console.log('  WARNING: node-pty is not installed (node_modules/node-pty is missing).');
    console.log('  The terminal will not work. Try:');
    console.log('    npm install            # re-run without --ignore-scripts');
    return;
  }

  console.log('  rebuilding node-pty...');
  try {
    // On Windows npm is npm.cmd — bare 'npm' without shell raises ENOENT
    const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(NPM, ['rebuild', 'node-pty'], {
      cwd: __dirname,
      stdio: 'pipe',
      timeout: 120000
    });
    if (r.status !== 0) {
      const out = (r.stderr ? r.stderr.toString() : '') + (r.stdout ? r.stdout.toString() : '');
      if (out.includes('allow-scripts') || out.toLowerCase().includes('not allowed')) {
        console.log('  npm blocked build scripts (allow-scripts). To fix:');
        console.log('    npm install -g --allow-scripts=webtun,node-pty webtun');
        console.log('  Or: npm config set allow-scripts=webtun,node-pty --location=user');
        console.log('  Then: npm install -g webtun');
      }
      throw new Error(out.trim() || 'rebuild failed with status ' + r.status);
    }
    // Verify it worked
    delete require.cache[require.resolve('node-pty')];
    require('node-pty');
    console.log('  node-pty rebuilt successfully');
  } catch (e) {
    console.log('  node-pty rebuild failed: ' + e.message);
    console.log('  Terminal requires native build tools:');
    console.log('  Linux:   sudo apt-get install -y python3 make g++');
    console.log('  macOS:   xcode-select --install');
    console.log('  Windows: install Visual Studio Build Tools with "Desktop development with C++"');
    console.log('           https://visualstudio.microsoft.com/visual-cpp-build-tools/');
    console.log('  If recent npm blocks scripts, allow them:');
    console.log('    npm config set allow-scripts=webtun,node-pty --location=user');
    console.log('    npm install --allow-scripts=webtun,node-pty webtun');
  }
}

rebuildNodePty();

// NOTE: cloudflared is intentionally NOT downloaded here. Install-time
// fetching of remote binaries is a supply-chain red flag, so the binary is
// fetched on first tunnel use instead (server tunnel API / `webtun --tunnel`,
// see lib/cloudflared.js). Just inform when it's missing.
try {
  const { findCloudflared } = require('./lib/cloudflared');
  if (!findCloudflared()) {
    console.log('  cloudflared not found — it will be downloaded on first tunnel use.');
  }
} catch {}

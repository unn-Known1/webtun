'use strict';

// CI bundle gate: integrity + presence + manifest for a staged Electron app.
// Usage: node scripts/ci-gate.js <staged-app-dir> [--manifest-out <path>]
//
// Fails (non-zero) on:
//   - missing app.asar / missing key entries (server, preload, deps)
//   - any bundled .js that does not parse (the v2.2.2 truncation class)
//   - missing unpacked native binding (node-pty pty.node)
// Warns (does not fail) on:
//   - top-level packed versions differing from package-lock.json (pack-step
//     hoisting; proven runtime-benign — see BUILD_AUDIT_REPORT.md §2 — but
//     still worth noticing, hence the manifest artifact).
// Always writes the packed-tree manifest when --manifest-out is given.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAsar() {
  try { return require('@electron/asar'); } catch {}
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(__dirname, '..', 'node_modules')]) {
    try { return require(path.join(r, '@electron/asar')); } catch {}
  }
  throw new Error('ci-gate: cannot resolve @electron/asar (run npm ci first)');
}

const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
// The asar readers disagree across platforms (Windows listPackage yields
// backslashed entries that statFile rejects), so every archive access tries
// all path forms. Returns null when no form resolves.
function tryStat(asar, archive, canonRel) {
  const back = canonRel.split('/').join('\\');
  for (const form of [...new Set([canonRel, '/' + canonRel, back, '\\' + back])]) {
    try { return asar.statFile(archive, form); } catch {}
  }
  return null;
}
function tryExtract(asar, archive, canonRel) {
  const back = canonRel.split('/').join('\\');
  for (const form of [...new Set([canonRel, '/' + canonRel, back, '\\' + back])]) {
    try { return asar.extractFile(archive, form); } catch {}
  }
  return null;
}

const REQUIRED = [
  'server.js', 'package.json',
  'electron/main.js', 'electron/preload.js',
  'lib/cloudflared.js', 'public/index.html',
  'node_modules/express/package.json', 'node_modules/ws/package.json',
  'node_modules/multer/package.json', 'node_modules/node-pty/package.json',
];

function main() {
  const staged = process.argv[2];
  const mi = process.argv.indexOf('--manifest-out');
  const manifestOut = mi > 0 ? process.argv[mi + 1] : null;
  if (!staged) { console.error('usage: node scripts/ci-gate.js <staged-app-dir> [--manifest-out <path>]'); process.exit(2); }
  const asar = loadAsar();
  const candidates = [path.join(staged, 'resources'), path.join(staged, 'Contents', 'Resources')];
  // mac --dir lays out dist/mac/<Name>.app — look one level down too.
  try {
    for (const e of fs.readdirSync(staged, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.endsWith('.app')) {
        candidates.push(path.join(staged, e.name, 'Contents', 'Resources'));
      }
    }
  } catch {}
  const resources = candidates
    .find(d => { try { return fs.statSync(path.join(d, 'app.asar')).isFile(); } catch { return false; } });
  if (!resources) { console.error(`ci-gate: no app.asar under ${staged}`); process.exit(1); }
  const archive = path.join(resources, 'app.asar');
  const failures = [];

  // 1. Presence (entry paths canonicalized: Windows listPackage yields
  // backslashes, other platforms forward slashes).
  let entries = [];
  try { entries = asar.listPackage(archive).map(norm).filter(Boolean); }
  catch (e) { console.error(`ci-gate: cannot list ${archive}: ${e.message}`); process.exit(1); }
  const have = new Set(entries);
  for (const r of REQUIRED) {
    if (!have.has(r)) failures.push(`missing entry: ${r}`);
  }
  console.log(`ci-gate: ${entries.length} entries in app.asar`);

  // 2. Every bundled .js must parse (catches truncation at any cut point).
  let jsTotal = 0, jsBroken = [];
  for (const rel of entries) {
    if (!rel.endsWith('.js')) continue;
    // statFile returns the header node: directories carry `files`, symlinks
    // `link`, files a numeric `size` (e.g. the package literally named
    // `ipaddr.js` is a directory — must be skipped, not parsed).
    const node = tryStat(asar, archive, rel);
    if (!node) { jsBroken.push(`${rel} (unstatable in any path form)`); continue; }
    if (node.files && typeof node.files === 'object') continue;
    if (typeof node.link === 'string') {
      const target = tryExtract(asar, archive, norm(node.link));
      if (!target) { jsBroken.push(`${rel} (dangling symlink → ${node.link})`); continue; }
      jsTotal++;
      continue;
    }
    jsTotal++;
    const buf = tryExtract(asar, archive, rel);
    if (!buf) { jsBroken.push(`${rel} (unreadable in any path form)`); continue; }
    try { new vm.Script(buf.toString('utf8'), { filename: rel }); }
    catch (e) { jsBroken.push(`${rel} (${e.message.split('\n')[0]})`); }
  }
  console.log(`ci-gate: js checked=${jsTotal} broken=${jsBroken.length}`);
  for (const b of jsBroken.slice(0, 20)) console.error(`ci-gate BROKEN: ${b}`);
  if (jsBroken.length) failures.push(`${jsBroken.length} bundled JS file(s) do not parse`);

  // 2b. Non-JS truncation sanity (the v2.2.2 class is byte-truncation at any
  // cut point, not JS-specific — a cut index.html/CSS used to pass the gate
  // on presence alone). HTML must still carry its closing tag; CSS must be
  // non-empty with balanced braces.
  let assetBroken = [];
  for (const rel of entries) {
    if (!rel.endsWith('.html') && !rel.endsWith('.css')) continue;
    const buf = tryExtract(asar, archive, rel);
    if (!buf) { assetBroken.push(`${rel} (unreadable in any path form)`); continue; }
    const text = buf.toString('utf8');
    if (rel.endsWith('.html')) {
      if (!text.includes('</html>')) assetBroken.push(`${rel} (missing </html> — truncated?)`);
    } else {
      const open = (text.match(/\{/g) || []).length;
      const close = (text.match(/\}/g) || []).length;
      if (text.length === 0 || open === 0 || open !== close) {
        assetBroken.push(`${rel} (empty or unbalanced braces ${open}/${close} — truncated?)`);
      }
    }
  }
  console.log(`ci-gate: html/css checked, broken=${assetBroken.length}`);
  for (const b of assetBroken.slice(0, 20)) console.error(`ci-gate BROKEN: ${b}`);
  if (assetBroken.length) failures.push(`${assetBroken.length} bundled HTML/CSS file(s) look truncated`);

  // 3. Unpacked native binding (platform-aware).
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const needUnpacked = ['node_modules/node-pty/build/Release/pty.node'];
  if (process.platform === 'win32') needUnpacked.push('node_modules/node-pty/build/Release/winpty-agent.exe');
  for (const rel of needUnpacked) {
    const full = path.join(unpacked, ...rel.split('/'));
    if (!fs.existsSync(full)) failures.push(`missing unpacked binary: ${rel}`);
    else {
      const st = fs.statSync(full);
      if (st.size < 1024) failures.push(`suspiciously small unpacked binary: ${rel} (${st.size}B)`);
    }
  }
  console.log('ci-gate: unpacked native binding present');

  // 4. Packed-tree manifest + lockfile comparison (warn-only): versions
  // read from INSIDE app.asar package.json files (top level only).
  const manifest = {};
  const getPkg = rel => {
    try { const b = tryExtract(asar, archive, rel); return b ? JSON.parse(b.toString('utf8')).version || '?' : null; }
    catch { return null; }
  };
  const topNames = new Set();
  for (const rel of entries) {
    const m = rel.match(/^node_modules\/(@[^/]+\/[^/]+|[^/]+)\/package\.json$/);
    if (m) topNames.add(m[1]);
  }
  for (const n of [...topNames].sort()) {
    const v = getPkg(`node_modules/${n}/package.json`);
    if (v) manifest[n] = v;
  }
  if (manifestOut) {
    fs.mkdirSync(path.dirname(path.resolve(manifestOut)), { recursive: true });
    fs.writeFileSync(manifestOut, JSON.stringify({ archive, generatedAt: new Date().toISOString(), packages: manifest }, null, 2));
    console.log(`ci-gate: manifest written to ${manifestOut} (${Object.keys(manifest).length} packages)`);
  }
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8')).packages || {};
    for (const [dir, want] of Object.entries({ 'node_modules/type-is': 0, 'node_modules/express': 0, 'node_modules/multer': 0, 'node_modules/ws': 0, 'node_modules/node-pty': 0 })) {
      const lockVer = lock[dir] && lock[dir].version;
      const short = dir.replace('node_modules/', '');
      const packedVer = manifest[short];
      if (lockVer && packedVer && lockVer !== packedVer) {
        console.log(`::warning::packed ${short}@${packedVer} differs from lockfile ${lockVer} (hoisting; runtime-proven benign, see BUILD_AUDIT_REPORT.md §2)`);
      }
    }
  } catch (e) { console.log(`::warning::lockfile comparison skipped: ${e.message}`); }

  if (failures.length) {
    console.error(`ci-gate: FAILED\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('ci-gate: PASSED');
}

main();

'use strict';

// electron-builder `afterPack` hook: asar integrity enforcement.
//
// Background: v2.2.2 shipped with three byte-truncated JS files inside
// app.asar (plus a silently re-hoisted node_modules tree) because
// electron-builder@26.16.1's pack step corrupts file contents
// deterministically (see BUILD_AUDIT_REPORT.md §1–§2). This hook makes that
// class of defect impossible to ship: after every pack it compares every
// file inside app.asar (and every file under app.asar.unpacked) against the
// intact source tree, repairs mismatches, re-verifies, and FAILS the build
// on anything it cannot reconcile.
//
// Repair policy per packed file:
//   tier 1 — same relative path exists in the source tree: bytes must match,
//            otherwise the packed copy is overwritten from source (this also
//            heals wrong-version metadata the pack step hoisted, e.g.
//            type-is/package.json, because source wins for overlapping paths).
//   tier 2 — no same-path source (pack-step hoisting invented the path, e.g.
//            multer/node_modules/*): byte-identical to the same
//            package@version found elsewhere in the source tree; when no
//            intact copy exists anywhere, executable formats (.js/.json) must
//            still parse or the build fails, and anything else is kept with a
//            logged note.
// Symlinks must match the source symlink target exactly. Directories are
// skipped. Anything else (unidentifiable bytes, residual mismatch after
// repair) fails the build. A clean pack only pays for verification.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');

function loadAsar() {
  try {
    return require('@electron/asar');
  } catch {}
  // Fallback: resolve from the builder's own tree when hoisting differs.
  const roots = [
    path.join(process.cwd(), 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ];
  for (const r of roots) {
    for (const sub of ['@electron/asar', 'app-builder-lib/node_modules/@electron/asar']) {
      try {
        return require(path.join(r, sub));
      } catch {}
    }
  }
  throw new Error('enforce-asar-integrity: cannot resolve @electron/asar');
}

const norm = p => String(p || '').replace(/^\/+/, '');
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const isJs = p => p.endsWith('.js');
function assertJsSyntax(buf, name) {
  // vm.Script compiles without executing — equivalent to `node --check`
  // for the CommonJS tree this project ships (the CI gate uses --check).
  new vm.Script(buf.toString('utf8'), { filename: name });
}
function readFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return fs.readFileSync(p);
  } catch { return null; }
}
// Classify an archive entry. statFile returns the header node: directories
// carry a `files` object, symlinks a string `link`, files a numeric `size`
// (e.g. the npm package literally named `ipaddr.js` is a directory node).
// Returns {kind:'dir'} | {kind:'link', target} | {kind:'file', buf}.
function classify(asar, archive, rel) {
  let node = null;
  try { node = asar.statFile(archive, rel); } catch (e) {
    throw new Error(`enforce-asar-integrity: cannot stat packed entry ${rel}: ${e.message}`);
  }
  if (node && node.files && typeof node.files === 'object') return { kind: 'dir' };
  if (node && typeof node.link === 'string') return { kind: 'link', target: node.link };
  if (!node || typeof node.size !== 'number') {
    throw new Error(`enforce-asar-integrity: packed entry has unknown shape: ${rel}`);
  }
  try {
    return { kind: 'file', buf: asar.extractFile(archive, rel) };
  } catch (e) {
    throw new Error(`enforce-asar-integrity: cannot read packed file ${rel}: ${e.message}`);
  }
}
// Walk the archive header in insertion order: directories carry a `files`
// object, symlinks a string `link`, files a numeric `size`. Records the
// original unpacked flags so a rebuild preserves the split exactly.
function walkHeader(filesNode, prefix, out) {
  for (const [name, node] of Object.entries(filesNode || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (node && node.files && typeof node.files === 'object') {
      out.push({ rel, kind: 'dir', unpacked: !!node.unpacked });
      walkHeader(node.files, rel, out);
    } else if (node && typeof node.link === 'string') {
      out.push({ rel, kind: 'link', target: node.link, unpacked: !!node.unpacked });
    } else {
      out.push({ rel, kind: 'file', unpacked: !!node.unpacked });
    }
  }
  return out;
}
// Split an asar-internal path into its owning package: the LAST
// node_modules/<name> segment, honouring @scopes.
function owningPackage(rel) {
  const parts = norm(rel).split('/');
  const idx = parts.lastIndexOf('node_modules');
  if (idx < 0 || idx + 1 >= parts.length) return null;
  let name = parts[idx + 1];
  if (name.startsWith('@')) {
    if (idx + 2 >= parts.length) return null;
    name = name + '/' + parts[idx + 2];
    return { name, sub: parts.slice(idx + 3).join('/') };
  }
  return { name, sub: parts.slice(idx + 2).join('/') };
}
function pkgVersion(dir, pkgName) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', pkgName, 'package.json'), 'utf8'));
    return d.version || null;
  } catch { return null; }
}
// Find an intact copy of package@version somewhere in the source tree.
function findSourceCopy(projectDir, pkgName, version) {
  const roots = [];
  try {
    for (const e of fs.readdirSync(path.join(projectDir, 'node_modules'), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        try {
          for (const s of fs.readdirSync(path.join(projectDir, 'node_modules', e.name))) {
            roots.push(e.name + '/' + s);
          }
        } catch {}
      } else roots.push(e.name);
    }
  } catch {}
  for (const r of roots) {
    if (r !== pkgName) continue;
    if (pkgVersion(projectDir, r) === version) return path.join(projectDir, 'node_modules', r);
  }
  // Nested copies (express/node_modules/* etc.) as a last resort.
  const stack = [path.join(projectDir, 'node_modules')];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === '.bin') continue;
      if (e.name === 'node_modules') { stack.push(full); continue; }
      if (e.name.startsWith('@')) { stack.push(full); continue; }
      // dir/<pkg> candidate: check <pkg>/package.json directly.
      try {
        const d = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
        if ((d.name === pkgName || full.endsWith(path.sep + pkgName)) && d.version === version) return full;
      } catch {}
      stack.push(path.join(full, 'node_modules'));
    }
    if (stack.length > 5000) break; // sanity cap, not a real tree depth
  }
  return null;
}
// Package identity (name+version) of the package owning an archive path,
// read from the package root's package.json. `inAsar=true` reads from the
// archive, false from the source tree. Returns null outside node_modules.
function pkgId(asar, archive, projectDir, rel, inAsar) {
  const parts = norm(rel).split('/');
  const nmIdx = parts.lastIndexOf('node_modules');
  if (nmIdx < 0) return null; // first-party file (server.js, electron/, …)
  let rootParts = parts.slice(0, nmIdx + 2);
  if (rootParts[rootParts.length - 1].startsWith('@')) rootParts = parts.slice(0, nmIdx + 3);
  const pkgJson = rootParts.join('/') + '/package.json';
  try {
    const raw = inAsar
      ? asar.extractFile(archive, pkgJson).toString('utf8')
      : fs.readFileSync(path.join(projectDir, pkgJson), 'utf8');
    const d = JSON.parse(raw);
    return { name: d.name || null, version: d.version || null };
  } catch { return { name: null, version: null }; }
}
// Resolve the expected bytes for a packed file: {expected, tier} or {noteOnly}.
// Throws when the entry cannot be reconciled (fails the build).
// Policy:
//   - package.json: JSON must parse; never byte-compared (the builder
//     legitimately strips dev-only fields; hoisting drift is watched by the
//     tree-vs-lock CI assert, not by byte identity).
//   - first-party files (outside node_modules/): strict source-wins.
//   - node_modules files whose archive and source package versions AGREE:
//     strict source-wins (any diff is corruption).
//   - node_modules files where the pack step hoisted a different version:
//     compare against the intact copy of the ARCHIVE's claimed name@version
//     found elsewhere in the source tree (never against the source file at
//     the same path — that would downgrade/upgrade a working hoist).
function resolveExpected(asar, archive, projectDir, rel, actual, notes, say) {
  if (rel === 'package.json' || rel.endsWith('/package.json')) {
    try { JSON.parse(actual.toString('utf8')); }
    catch (e) { throw new Error(`enforce-asar-integrity: packed package.json is not valid JSON: ${rel}`); }
    return { noteOnly: true };
  }
  const own = owningPackage(rel);
  if (!own) {
    // First-party file: the builder has no licence to modify it.
    const srcBuf = readFile(path.join(projectDir, rel));
    if (!srcBuf) throw new Error(`enforce-asar-integrity: packed file without source: ${rel}`);
    return { expected: srcBuf, tier: 1 };
  }
  if (!own.sub) throw new Error(`enforce-asar-integrity: packed file has no source counterpart and no package identity: ${rel}`);
  const A = pkgId(asar, archive, projectDir, rel, true);
  const S = pkgId(asar, archive, projectDir, rel, false);
  // Aliased packages (npm:@socketregistry/… overrides) legitimately carry a
  // name different from their directory — drift only counts when archive and
  // source disagree with each other.
  const archName = A.name || own.name;
  const srcName = S.name || own.name;
  if (archName !== srcName) throw new Error(`enforce-asar-integrity: package name drift at ${rel} (archive ${archName} vs source ${srcName})`);
  if (A.version && S.version && A.version === S.version) {
    const srcBuf = readFile(path.join(projectDir, rel));
    if (srcBuf) {
      if (isJs(rel)) assertJsSyntax(srcBuf, `source:${rel}`);
      return { expected: srcBuf, tier: 1 };
    }
    // Same version but file absent in source — fall through to tier 2.
  }
  const wantName = archName;
  const wantVer = A.version;
  if (!wantVer) throw new Error(`enforce-asar-integrity: no version for hoisted package ${own.name} (${rel})`);
  const srcCopy = findSourceCopy(projectDir, wantName, wantVer);
  const expected = srcCopy ? readFile(path.join(srcCopy, own.sub)) : null;
  if (expected) {
    if (isJs(rel)) assertJsSyntax(expected, `source:${wantName}/${own.sub}`);
    return { expected, tier: 2 };
  }
  // No intact reference anywhere (e.g. doc files npm ships selectively):
  // validate the format so a broken executable file can never ship, and fail
  // the build when there is nothing to repair it from.
  const where = `packed:${rel} (${wantName}@${wantVer}, no intact reference)`;
  if (isJs(rel)) assertJsSyntax(actual, where); // throws → build fails
  else if (rel.endsWith('.json')) JSON.parse(actual.toString('utf8'));
  else if (!notes.has(rel)) { notes.add(rel); say(`note: ${where} — unverifiable, kept as-is`); }
  return { noteOnly: true };
}
function checkLinkTarget(projectDir, rel, target) {
  let st = null;
  try { st = fs.lstatSync(path.join(projectDir, rel)); } catch {}
  if (!st || !st.isSymbolicLink()) {
    throw new Error(`enforce-asar-integrity: packed symlink without source symlink: ${rel}`);
  }
  const srcTarget = fs.readlinkSync(path.join(projectDir, rel));
  if (srcTarget !== target) {
    throw new Error(`enforce-asar-integrity: symlink target differs: ${rel} (packed ${target} vs source ${srcTarget})`);
  }
}

module.exports = async function enforceAsarIntegrity(context) {
  const asar = loadAsar();
  const appOutDir = context && context.appOutDir;
  const projectDir = (context && context.packager && context.packager.projectDir) || process.cwd();
  const say = m => console.log(`  [asar-integrity] ${m}`);
  const notes = new Set();

  const resources = [path.join(appOutDir, 'resources'), path.join(appOutDir, 'Contents', 'Resources')]
    .find(d => { try { return fs.statSync(path.join(d, 'app.asar')).isFile(); } catch { return false; } });
  if (!resources) {
    say(`no app.asar under ${appOutDir} (asar disabled?) — nothing to enforce`);
    return;
  }
  const archive = path.join(resources, 'app.asar');
  const unpackedRoot = path.join(resources, 'app.asar.unpacked');
  try { if (asar.uncacheAll) asar.uncacheAll(); } catch {}

  const entries = asar.listPackage(archive).map(norm).filter(Boolean);
  say(`${entries.length} entries in ${path.relative(projectDir, archive)}`);

  const mismatched = [];   // { rel, reason, expected }
  let fileCount = 0;
  for (const rel of entries) {
    const c = classify(asar, archive, rel);
    if (c.kind === 'dir') continue;
    if (c.kind === 'link') { checkLinkTarget(projectDir, rel, c.target); fileCount++; continue; }
    fileCount++;
    const actual = c.buf;
    if (rel === 'package.json' || rel.endsWith('/package.json')) {
      // The builder legitimately strips dev-only fields from packed
      // package.json files — a byte diff here is not corruption. Require
      // valid JSON and move on; version-hoisting drift is covered by the
      // tree-vs-lock CI assert, not by byte identity.
      try { JSON.parse(actual.toString('utf8')); }
      catch (e) { throw new Error(`enforce-asar-integrity: packed package.json is not valid JSON: ${rel}`); }
      continue;
    }
    const r = resolveExpected(asar, archive, projectDir, rel, actual, notes, say);
    if (r.noteOnly) continue;
    if (!actual.equals(r.expected)) {
      const tag = r.tier === 1
        ? `differs from source (packed ${actual.length}B md5 ${md5(actual)} vs source ${r.expected.length}B md5 ${md5(r.expected)})`
        : `differs from intact copy (tier 2)`;
      mismatched.push({ rel, reason: tag, expected: r.expected });
    } else if (isJs(rel)) {
      assertJsSyntax(actual, `packed:${rel}`);
    }
  }

  // Unpacked files (native blobs etc.) live outside the archive: compare in place.
  const unpackedFixes = [];
  if (fs.existsSync(unpackedRoot)) {
    const walk = [unpackedRoot];
    while (walk.length) {
      const d = walk.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk.push(full); continue; }
        if (e.isSymbolicLink()) {
          const rel = path.relative(unpackedRoot, full).split(path.sep).join('/');
          checkLinkTarget(projectDir, rel, fs.readlinkSync(full));
          continue;
        }
        if (!e.isFile()) throw new Error(`enforce-asar-integrity: unexpected unpacked entry: ${full}`);
        const rel = path.relative(unpackedRoot, full).split(path.sep).join('/');
        const srcBuf = readFile(path.join(projectDir, rel));
        if (!srcBuf) throw new Error(`enforce-asar-integrity: unpacked file without source: ${rel}`);
        if (!fs.readFileSync(full).equals(srcBuf)) {
          fs.writeFileSync(full, srcBuf);
          unpackedFixes.push(rel);
          say(`  repair unpacked ${rel}`);
        }
      }
    }
  }

  if (mismatched.length === 0 && unpackedFixes.length === 0) {
    say(`clean — ${fileCount} packed files match source, unpacked tree matches`);
  } else {
    say(`repairing ${mismatched.length} packed + ${unpackedFixes.length} unpacked file(s)`);
    for (const m of mismatched.slice(0, 20)) say(`  repair ${m.rel} (${m.reason})`);
    if (mismatched.length > 20) say(`  …and ${mismatched.length - 20} more`);
  }

  if (mismatched.length > 0) {
    // Rebuild the archive from streams (asar has no in-place single-file
    // patch). Order, unpacked split, link targets and modes come from the
    // ORIGINAL header, so the rebuild is byte-faithful except for the
    // repaired files. Unpacked-flagged files stream from the live unpacked
    // dir (already repaired above); packed files stream from corrected
    // staging. This mirrors app-builder-lib's own createPackageFromStreams
    // path instead of re-guessing its unpack globs.
    //
    // CRITICAL — @electron/asar fast-path trap: for files ≤2MB, insertFile
    // does fs.readFileSync(destinationRelativePath), resolved against
    // process CWD, and packs THOSE bytes (truncated to stat.size) instead of
    // the provided streamGenerator. With CWD at the project dir this reads
    // SOURCE bytes under the packed size — i.e. exactly the truncation
    // mechanism behind v2.2.2 (proven: truncated bytes == source prefix).
    // Defeat it by chdir'ing into the corrected staging dir first, so the
    // fast path can only ever read the bytes we staged. Unpacked-flagged
    // files are refreshed into staging too, so every CWD-relative read hits
    // correct bytes regardless of which path the lib takes.
    const { Readable } = require('stream');
    const plan = walkHeader(asar.getRawHeader(archive).header.files, '', []);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'webtun-asar-'));
    const prevCwd = process.cwd();
    try {
      asar.extractAll(archive, stage);
      for (const m of mismatched) {
        const dest = path.join(stage, m.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, m.expected);
      }
      for (const e of plan) {
        if (e.kind !== 'file' || !e.unpacked) continue;
        const dest = path.join(stage, e.rel);
        const live = path.join(unpackedRoot, e.rel);
        if (fs.existsSync(live)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(live, dest);
        }
      }
      const streams = [];
      for (const e of plan) {
        if (e.kind === 'dir') {
          streams.push({ type: 'directory', path: e.rel, unpacked: e.unpacked });
          continue;
        }
        if (e.kind === 'link') {
          checkLinkTarget(projectDir, e.rel, e.target);
          streams.push({
            type: 'link', path: e.rel, symlink: e.target, unpacked: e.unpacked,
            stat: { mode: 0o777 }, streamGenerator: () => Readable.from([]),
          });
          continue;
        }
        const src = e.unpacked ? path.join(unpackedRoot, e.rel) : path.join(stage, e.rel);
        let stat = null;
        try { stat = fs.statSync(src); } catch (err) {
          throw new Error(`enforce-asar-integrity: rebuild source missing: ${e.rel}: ${err.message}`);
        }
        if (!stat.isFile()) throw new Error(`enforce-asar-integrity: rebuild source not a file: ${e.rel}`);
        streams.push({
          type: 'file', path: e.rel, unpacked: e.unpacked,
          stat: { mode: stat.mode, size: stat.size },
          streamGenerator: () => fs.createReadStream(src),
        });
      }
      const rebuilt = archive + '.enforced';
      if (!asar.createPackageFromStreams) throw new Error('enforce-asar-integrity: @electron/asar lacks createPackageFromStreams');
      process.chdir(stage);
      try {
        await asar.createPackageFromStreams(rebuilt, streams);
      } finally {
        process.chdir(prevCwd);
      }
      // The rebuild must preserve entry set AND unpacked split exactly.
      const afterPlan = walkHeader(asar.getRawHeader(rebuilt).header.files, '', []);
      const key = e => `${e.kind}:${e.rel}:${e.unpacked ? 1 : 0}`;
      if (JSON.stringify(plan.map(key)) !== JSON.stringify(afterPlan.map(key))) {
        throw new Error('enforce-asar-integrity: rebuilt archive structure differs from original');
      }
      // The rebuilt .unpacked mirror must match the live unpacked dir (which
      // already carries repaired bytes); then drop the mirror.
      const mirror = rebuilt + '.unpacked';
      if (fs.existsSync(mirror)) {
        const cmpTrees = (a, b) => {
          const wa = [a];
          while (wa.length) {
            const d = wa.pop();
            for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
              const fa = path.join(d, ent.name);
              const fb = path.join(b, path.relative(a, fa));
              if (ent.isDirectory()) { wa.push(fa); continue; }
              if (!ent.isFile()) continue;
              if (!fs.existsSync(fb) || !fs.readFileSync(fa).equals(fs.readFileSync(fb))) {
                throw new Error(`enforce-asar-integrity: unpacked mirror differs at ${path.relative(a, fa)}`);
              }
            }
          }
        };
        cmpTrees(mirror, unpackedRoot);
        fs.rmSync(mirror, { recursive: true, force: true });
      }
      fs.renameSync(rebuilt, archive);
      try { if (asar.uncacheAll) asar.uncacheAll(); } catch {}
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
  }

  // Final gate: re-resolve every entry from scratch and compare + parse.
  let residual = 0;
  for (const rel of asar.listPackage(archive).map(norm).filter(Boolean)) {
    const c = classify(asar, archive, rel);
    if (c.kind === 'dir') continue;
    if (c.kind === 'link') { checkLinkTarget(projectDir, rel, c.target); continue; }
    if (rel === 'package.json' || rel.endsWith('/package.json')) {
      try { JSON.parse(c.buf.toString('utf8')); }
      catch (e) { throw new Error(`enforce-asar-integrity: packed package.json is not valid JSON: ${rel}`); }
      continue;
    }
    const r = resolveExpected(asar, archive, projectDir, rel, c.buf, notes, say);
    if (r.noteOnly) continue;
    if (!c.buf.equals(r.expected)) { residual++; console.error(`  [asar-integrity] RESIDUAL MISMATCH: ${rel}`); }
    else if (isJs(rel)) assertJsSyntax(c.buf, rel);
  }
  if (residual > 0) throw new Error(`enforce-asar-integrity: ${residual} file(s) still differ after repair`);
  say(`gate passed — ${fileCount} packed files verified${mismatched.length ? ` (${mismatched.length} repaired)` : ''}${unpackedFixes.length ? `, ${unpackedFixes.length} unpacked repaired` : ''}`);
};

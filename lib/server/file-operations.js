'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

// Back up BEFORE mutation. Restoring an entry replaces its entire subtree, not
// an overlay copy which would leave newly introduced descendants behind.
async function mergeDirs(src, dst, io = fs) {
  const before = new Set(await io.readdir(dst));
  const created = [];
  const backups = new Map();
  let backupDir;
  let keepBackup = false;
  try {
    for (const entry of await io.readdir(src)) {
      const target = path.join(dst, entry);
      if (before.has(entry)) {
        if (!backupDir) backupDir = await io.mkdtemp(path.join(os.tmpdir(), 'webtun-merge-'));
        const backup = path.join(backupDir, entry);
        await io.cp(target, backup, { recursive: true, force: true, verbatimSymlinks: true });
        backups.set(entry, backup);
      } else created.push(entry);
      await io.cp(path.join(src, entry), target, { recursive: true, force: true });
    }
  } catch (error) {
    const failures = [];
    for (const entry of created) {
      try { await io.rm(path.join(dst, entry), { recursive: true, force: true }); } catch (e) { failures.push(e); }
    }
    for (const [entry, backup] of backups) {
      try {
        await io.rm(path.join(dst, entry), { recursive: true, force: true });
        await io.cp(backup, path.join(dst, entry), { recursive: true, force: true, verbatimSymlinks: true });
      } catch (e) { failures.push(e); }
    }
    if (failures.length) {
      keepBackup = true;
      // Log recovery location server-side only; centralized errors redact paths.
      console.error('[webtun] merge rollback incomplete; backup retained:', backupDir, failures);
      const e = new Error('Merge failed and rollback was incomplete; check the server log for recovery instructions');
      e.status = 500;
      e.cause = error;
      throw e;
    }
    throw error;
  } finally {
    if (backupDir && !keepBackup) await io.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}

function downloadRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size <= 0) return false;
  let start, end;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

module.exports = { mergeDirs, downloadRange };

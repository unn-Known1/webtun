'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
function createPathAccess(options) {
  const { workspaceRoot: WORKSPACE_ROOT, allowFullFs: ALLOW_FULL_FS } = options;
  function resolvePath(targetPath) {
    if (Array.isArray(targetPath)) { const e = new Error('Invalid path: array not allowed'); e.status = 400; throw e; }
    if (targetPath == null) return WORKSPACE_ROOT;
    if (typeof targetPath !== 'string') { const e = new Error('Invalid path type'); e.status = 400; throw e; }
    if (targetPath.includes('\0')) { const e = new Error('Invalid path: null byte'); e.status = 400; throw e; }
    if (!targetPath || targetPath.trim() === '') return WORKSPACE_ROOT;
    const resolved = path.resolve(targetPath);
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, resolved)) {
      const e = new Error('Access denied: path outside workspace'); e.status = 403; throw e;
    }
    return resolved;
  }

  // Resolve path and follow symlinks to their real location.
  // Used for write operations so files end up at the intended real path.
  function realPath(targetPath) {
    if (Array.isArray(targetPath)) { const e = new Error('Invalid path: array not allowed'); e.status = 400; throw e; }
    if (targetPath == null) return WORKSPACE_ROOT;
    if (typeof targetPath !== 'string') { const e = new Error('Invalid path type'); e.status = 400; throw e; }
    if (targetPath.includes('\0')) { const e = new Error('Invalid path: null byte'); e.status = 400; throw e; }
    if (!targetPath || targetPath.trim() === '') return WORKSPACE_ROOT;
    const resolved = path.resolve(targetPath);
    let real = resolved;
    try { real = fs.realpathSync(resolved); } catch {}
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, real)) {
      const e = new Error('Access denied: path outside workspace (symlink)'); e.status = 403; throw e;
    }
    return real;
  }

  // Case-aware path containment (Windows paths are case-insensitive).
  function pathContained(parent, child) {
    let p = path.resolve(parent);
    let c = path.resolve(child);
    if (os.platform() === 'win32') {
      p = p.replace(/\\/g, '/').toLowerCase();
      c = c.replace(/\\/g, '/').toLowerCase();
      if (!p.endsWith('/')) p += '/';
      return c === p.slice(0, -1) || c.startsWith(p);
    }
    return c === p || c.startsWith(p + path.sep);
  }


  return { resolvePath, realPath, pathContained };
}

module.exports = { createPathAccess };

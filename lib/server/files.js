'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const { execFile, execFileSync } = require('child_process');
const { ZipStoreWriter } = require('../zip-store');
const { ZipArchiveReader, safeZipEntryName } = require('../zip-read');
const { mimeLookup, BINARY_EXTS } = require('./file-types');
const { sendErr, errText, safeErr } = require('./errors');
function registerFileRoutes(options) {
  const { app, checkPin, rateLimiter, paths, auth, workspaceRoot: WORKSPACE_ROOT, allowFullFs: ALLOW_FULL_FS } = options;
  const { resolvePath, realPath, pathContained } = paths;
  const { mintPreviewFileToken, getPreviewFileToken } = auth;

  // ── File API ──────────────────────────────────────────────────────────

  async function renameWithFallback(src, dst) {
    // Case-only rename (sample.txt → Sample.txt) on case-insensitive filesystems
    // can no-op or error when resolved through the same directory entry: bounce
    // through a temporary name so the new casing always lands.
    if (src !== dst && src.toLowerCase() === dst.toLowerCase()) {
      const tmp = dst + '.webtun-case-' + crypto.randomBytes(4).toString('hex');
      await fsPromises.rename(src, tmp);
      try {
        await fsPromises.rename(tmp, dst);
      } catch (e) {
        try { await fsPromises.rename(tmp, src); } catch {}
        throw e;
      }
      return;
    }
    try {
      await fsPromises.rename(src, dst);
    } catch (e) {
      if (e.code === 'EXDEV') {
        await fsPromises.cp(src, dst, { recursive: true, force: true });
        await fsPromises.rm(src, { recursive: true, force: true });
      } else {
        throw e;
      }
    }
  }

  async function dirSize(dir, maxDepth = 10) {
    // Called on a plain file too: report it directly instead of walking into a
    // readdir() that can only fail (used to answer 0).
    const rootStat = await fsPromises.lstat(dir).catch(() => null);
    if (rootStat && !rootStat.isDirectory()) return rootStat.isFile() ? rootStat.size : 0;
    let total = 0;
    let entryCount = 0;
    const sizeErrors = []; // hard failures are re-thrown once the walk drains
    const MAX_ENTRIES = 50000;
    const visited = new Set();
    const CONCURRENCY = 8; // ONE global budget — was 32 per directory level (×N^depth)
    const stack = [[dir, 0]];
    const pending = new Set();
    while (stack.length || pending.size) {
      while (stack.length && pending.size < CONCURRENCY) {
        const [d, depth] = stack.pop();
        if (depth > maxDepth) continue;
        const task = (async () => {
          let real;
          // realpathSync() blocked the event loop once per directory; this is
          // called by size/zip/download on possibly huge trees.
          try { real = await fsPromises.realpath(d); } catch { real = path.resolve(d); }
          if (visited.has(real)) return;
          visited.add(real);
          let entries;
          try { entries = await fsPromises.readdir(d, { withFileTypes: true }); } catch { return; }
          entryCount += entries.length;
          if (entryCount > MAX_ENTRIES) {
            const e = new Error('Directory has too many entries (max ' + MAX_ENTRIES + ')');
            e.status = 413;
            throw e;
          }
          for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isSymbolicLink() || e.isDirectory()) {
              // Symlinked directories stay navigable when the whole filesystem is
              // exposed (the documented default). Cycles terminate because every
              // directory is resolved to its realpath and recorded in `visited`
              // above. Under the sandbox (ALLOW_FULL_FS=false) links are skipped,
              // and symlinked *files* are never counted in either mode — a link
              // would report someone else's bytes as the user's own.
              if (e.isSymbolicLink()) {
                if (!ALLOW_FULL_FS) continue;
                let tgt; try { tgt = await fsPromises.stat(full); } catch { continue; }
                if (!tgt.isDirectory()) continue;
              }
              stack.push([full, depth + 1]);
              continue;
            }
            if (!e.isFile()) continue;
            try {
              const lst = await fsPromises.lstat(full);
              if (lst.isFile()) total += lst.size;
            } catch {}
          }
        })().catch(err => { sizeErrors.push(err); });
        pending.add(task);
        task.then(() => pending.delete(task));
      }
      if (pending.size) await Promise.race([...pending]);
    }
    if (sizeErrors.length) throw sizeErrors[0];
    return total;
  }

  const ZIP_MAX_TOTAL = 1 * 1024 * 1024 * 1024;
  const ZIP_MAX_ENTRIES = 50000;

  // Walk the requested roots ourselves instead of handing directories to a zip
  // library's recursive helper: the previous version stat'ed twice (lstatSync
  // then statSync) around an async dirSize() — a TOCTOU window where the checked
  // size was not the size sent. Here every entry is lstat'ed once, links are
  // skipped outright, and the running total is the authoritative cap.
  async function collectZipEntries(roots) {
    const items = [];
    let totalBytes = 0;
    const addFile = (full, name, size) => {
      totalBytes += size;
      if (totalBytes > ZIP_MAX_TOTAL) {
        const e = new Error('Total size exceeds 1GB'); e.status = 413; throw e;
      }
      if (items.length >= ZIP_MAX_ENTRIES) {
        const e = new Error('Too many entries (max ' + ZIP_MAX_ENTRIES + ')'); e.status = 413; throw e;
      }
      items.push({ type: 'file', path: full, name });
    };
    for (const root of roots) {
      let lst;
      try { lst = await fsPromises.lstat(root.fullPath); }
      catch (e) { const err = new Error('Cannot read ' + path.basename(root.fullPath)); err.status = e.code === 'ENOENT' ? 404 : 500; err.code = e.code; throw err; }
      if (lst.isSymbolicLink()) continue; // never archive through a link
      if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, root.fullPath)) {
        const e = new Error('Access denied: entry outside workspace'); e.status = 403; throw e;
      }
      if (lst.isFile()) { addFile(root.fullPath, root.nameInZip, lst.size); continue; }
      if (!lst.isDirectory()) continue;
      items.push({ type: 'dir', name: root.nameInZip });
      const stack = [[root.fullPath, root.nameInZip]];
      while (stack.length) {
        const [d, rel] = stack.pop();
        let entries;
        try { entries = await fsPromises.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          if (ent.isSymbolicLink()) continue;
          const full = path.join(d, ent.name);
          const name = rel ? rel + '/' + ent.name : ent.name;
          if (ent.isDirectory()) {
            if (items.length >= ZIP_MAX_ENTRIES) {
              const e = new Error('Too many entries (max ' + ZIP_MAX_ENTRIES + ')'); e.status = 413; throw e;
            }
            items.push({ type: 'dir', name });
            stack.push([full, name]);
          } else if (ent.isFile()) {
            let st;
            try { st = await fsPromises.lstat(full); } catch { continue; }
            if (st.isFile()) addFile(full, name, st.size);
          }
        }
      }
    }
    return items;
  }

  // Stream collected entries through the STORE writer (no compression —
  // downloads stay universally readable and dependency-free).
  async function writeItemsToZip(writer, items) {
    await writer.writeAll(items);
  }

  async function createZipArchive(entries, zipPath) {
    // Ensure destination inside workspace (F63)
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, zipPath)) {
      const e = new Error('Access denied: zip destination outside workspace'); e.status = 403; throw e;
    }
    // Collected before the stream opens, so a rejected archive never leaves a
    // truncated .zip behind.
    const items = await collectZipEntries(entries);
    const output = fs.createWriteStream(zipPath);
    const writer = new ZipStoreWriter(output, { maxTotal: ZIP_MAX_TOTAL });
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        try { output.destroy(); } catch {}
        try { fs.unlinkSync(zipPath); } catch {}
        reject(err);
      };
      output.on('close', () => { if (!settled) { settled = true; resolve(); } });
      output.on('error', fail);
      writeItemsToZip(writer, items).then(() => { try { output.end(); } catch (e) { fail(e); } }, fail);
    });
    return zipPath;
  }

  function streamZipDirectory(dirPath, res) {
    const writer = new ZipStoreWriter(res, { maxTotal: ZIP_MAX_TOTAL });
    // Returned immediately (not a promise) so the caller can still abort it on
    // client disconnect; the walk itself is async and link-free.
    (async () => {
      try {
        const items = await collectZipEntries([{ fullPath: dirPath, nameInZip: path.basename(dirPath) }]);
        if (res.writableEnded || writer.aborted) return;
        await writeItemsToZip(writer, items);
        if (!res.writableEnded) { try { res.end(); } catch {} }
      } catch (e) {
        if (e && e.aborted) { try { res.end(); } catch {} return; }
        const r = safeErr(e);
        if (res.headersSent) { try { res.end(); } catch {} }
        else { try { res.status(r.status).json(r.body); } catch {} }
      }
    })();
    return writer;
  }

  function extractZip(zipPath, destDir) {
    return (async () => {
      // Validate zip magic (PK header) before extraction (F64)
      const fd = fs.openSync(zipPath, 'r');
      try {
        const buf = Buffer.alloc(4);
        const bytes = fs.readSync(fd, buf, 0, 4, 0);
        if (bytes < 4 || !(buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) && (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08))) {
          throw Object.assign(new Error('Not a zip file (bad magic)'), { status: 400 });
        }
      } finally {
        try { fs.closeSync(fd); } catch {}
      }
      const MAX_ENTRIES = 1000;
      const MAX_TOTAL = 1 * 1024 * 1024 * 1024;
      let reader;
      try {
        reader = await ZipArchiveReader.open(zipPath, { maxEntries: MAX_ENTRIES });
      } catch (e) {
        throw mapZipOpenError(e);
      }
      let totalUncompressed = 0; // from archive metadata (attacker-controlled hint)
      let liveTotal = 0;        // bytes actually decompressed — the authoritative cap
      for (const entry of reader.entries) {
        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > MAX_TOTAL) {
          const e = new Error('Uncompressed size exceeds 1GB'); e.status = 413; throw e;
        }
        let entryPath;
        try {
          entryPath = safeZipEntryName(entry.fileName);
        } catch (e) {
          throw mapZipOpenError(e);
        }
        const target = path.join(destDir, entryPath);
        if (!pathContained(destDir, target)) {
          throw new Error('Zip entry escapes destination directory');
        }
        if (/\/$/.test(entryPath)) {
          fs.mkdirSync(target, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let readStream;
        try {
          readStream = await reader.openEntryStream(entry);
        } catch (e) {
          throw mapZipOpenError(e);
        }
        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(target);
          let aborted = false;
          readStream.on('data', chunk => {
            // Count REAL decompressed bytes: entry.uncompressedSize comes from
            // the archive header, so a lying header (the classic zip-bomb)
            // sailed past the cap above while the disk filled anyway.
            liveTotal += chunk.length;
            if (liveTotal > MAX_TOTAL) {
              aborted = true;
              try { readStream.destroy(); } catch {}
              try { writeStream.destroy(); } catch {}
              try { fs.unlinkSync(target); } catch {}
              const e = new Error('Uncompressed size exceeds 1GB'); e.status = 413;
              reject(e);
            }
          });
          readStream.on('error', (e) => { if (!aborted) reject(e); });
          writeStream.on('error', (e) => { if (!aborted) reject(e); });
          writeStream.on('close', () => { if (!aborted) resolve(); });
          readStream.pipe(writeStream);
        });
      }
    })();
  }

  // Reader errors carry short codes; map the user-facing ones to the same
  // messages (and HTTP statuses) the yauzl path produced. Anything else keeps
  // its message and surfaces as a 500 via safeErr, as before.
  function mapZipOpenError(e) {
    if (e && e.code === 'ENTRY_LIMIT') return Object.assign(new Error('Too many entries in zip (max 1000)'), { status: 413 });
    if (e && e.code === 'ENCRYPTED') return Object.assign(new Error('Encrypted zips are not supported'), { status: 400 });
    if (e && e.code === 'BAD_METHOD') return Object.assign(new Error('Unsupported compression method in zip'), { status: 400 });
    if (e && e.code === 'UNSAFE_NAME') return Object.assign(new Error('Invalid zip entry name'), { status: 400 });
    return e;
  }

  async function safeStat(p) {
    try { return await fsPromises.stat(p); } catch { return null; }
  }

  async function asyncSafeWalk(currentDir, depth, maxDepth, q, results, maxResults, _seen) {
    if (depth > maxDepth || results.length >= maxResults) return;
    const seen = _seen || new Set();
    // Never descend into kernel/virtual trees even when full-FS is on.
    try {
      const rp = await fsPromises.realpath(currentDir).catch(() => path.resolve(currentDir));
      if (seen.has(rp)) return;
      seen.add(rp);
      const low = String(rp).toLowerCase();
      if (low === '/proc' || low === '/sys' || low === '/dev' ||
          low.startsWith('/proc/') || low.startsWith('/sys/') || low.startsWith('/dev/')) return;
    } catch {}
    let entries;
    try { entries = await fsPromises.readdir(currentDir, { withFileTypes: true }); } catch { return; }

    const matching = entries.filter(e => e.name.toLowerCase().includes(q));

    // Bounded fan-out: sequential batches of 8 instead of unbounded Promise.all
    // over every match and subdir (single-char q over depth 4 fanned thousands
    // of concurrent stats).
    const BATCH = 8;
    for (let i = 0; i < matching.length && results.length < maxResults; i += BATCH) {
      const chunk = matching.slice(i, i + BATCH);
      await Promise.all(chunk.map(async e => {
        if (results.length >= maxResults) return;
        const full = path.join(currentDir, e.name);
        try {
          // lstat (no follow): a symlink pointing outside the root must not leak
          // outside metadata. Containment is enforced on the lexical path.
          const st = await fsPromises.lstat(full);
          if (st.isSymbolicLink()) {
            if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, full)) return;
          } else if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, full)) {
            return;
          }
          if (results.length < maxResults) results.push({ path: full, name: e.name, isDir: st.isDirectory(), dir: currentDir });
        } catch {}
      }));
    }

    const dirs = entries.filter(e => e.isDirectory());
    for (let i = 0; i < dirs.length && results.length < maxResults; i += BATCH) {
      const chunk = dirs.slice(i, i + BATCH);
      for (const e of chunk) {
        if (results.length >= maxResults) return;
        const full = path.join(currentDir, e.name);
        try {
          const st = await fsPromises.lstat(full);
          if (!st.isDirectory() || st.isSymbolicLink()) continue;
          if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, full)) continue;
        } catch { continue; }
        await asyncSafeWalk(full, depth + 1, maxDepth, q, results, maxResults, seen);
      }
    }
  }

  app.get('/api/files', checkPin, async (req, res) => {
    try {
      const dir = resolvePath(req.query.path || WORKSPACE_ROOT);

      // Windows: at a drive root (e.g. C:\), list all available drives
      if (os.platform() === 'win32') {
        const parsed = path.parse(dir);
        if (dir === parsed.root || dir === '\\') {
          const files = [];
          for (let i = 65; i <= 90; i++) {
            const letter = String.fromCharCode(i);
            const drive = letter + ':\\';
            try { await fsPromises.access(drive); } catch { continue; }
            files.push({
              name: letter + ':', path: drive, isDir: true,
              isSymlink: false, size: 0, modified: null, ext: ''
            });
          }
          if (dir !== '\\') {
            try {
              const entries = await fsPromises.readdir(dir, { withFileTypes: true });
              for (const e of entries) {
                const full = path.join(dir, e.name);
                const st = await safeStat(full);
                files.push({
                  name: e.name, path: full, isDir: st ? st.isDirectory() : e.isDirectory(),
                  isSymlink: e.isSymbolicLink(), size: st ? st.size : 0,
                  modified: st ? st.mtime : null, ext: path.extname(e.name).toLowerCase()
                });
              }
            } catch {}
          }
          files.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return res.json({ path: dir, parent: null, files });
        }
      }

      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      // Bound stat concurrency so huge directories don't spike fds/CPU
      const files = [];
      const STAT_BATCH = 32;
      for (let i = 0; i < entries.length; i += STAT_BATCH) {
        const chunk = entries.slice(i, i + STAT_BATCH);
        const out = await Promise.all(
          chunk.map(async e => {
            const full = path.join(dir, e.name);
            const st = await safeStat(full);
            const isSymlink = e.isSymbolicLink();
            // Use stat result for isDir so symlink→dir is navigable; Dirent.isDirectory() is false for symlink
            const isDir = st ? st.isDirectory() : e.isDirectory();
            return {
              name: e.name,
              path: full,
              isDir,
              isSymlink,
              size: st ? st.size : 0,
              modified: st ? st.mtime : null,
              ext: path.extname(e.name).toLowerCase()
            };
          })
        );
        files.push(...out);
      }
      files.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      let parent = path.dirname(dir);
      if (parent === dir) parent = null;
      else if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, parent)) parent = null;
      res.json({ path: dir, parent, files });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/files/rename', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.oldPath || !req.body.newName) {
        console.warn('POST /api/files/rename 400 — body requires { oldPath, newName }. Example: { "oldPath": "/home/user/file.txt", "newName": "renamed.txt" }');
        return res.status(400).json({ error: 'oldPath and newName are required', usage: 'POST JSON { "oldPath": "<path>", "newName": "<name>" }' });
      }
      const newName = req.body.newName;
      if (typeof newName !== 'string' || !newName.trim() || newName === '.' || newName.length > 255 || newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
        return res.status(400).json({ error: 'Invalid newName: must not contain / \\ .. , be empty, "." or >255 chars' });
      }
      // also reject if newName contains null byte
      if (newName.includes('\0')) return res.status(400).json({ error: 'Invalid newName: null byte' });
      const oldPath = realPath(req.body.oldPath);
      const newPath = realPath(path.join(path.dirname(oldPath), newName));
      await renameWithFallback(oldPath, newPath);
      res.json({ success: true, newPath });
    } catch (e) {
      sendErr(res, e);
    }
  });

  async function resolveCopyMove(src, dst, conflict, isMove) {
    const VALID_CONFLICTS = ['replace', 'skip', 'keep_both', 'merge', 'cancel'];
    let dstExists = false, dstIsDir = false;
    try { const s = await fsPromises.stat(dst); dstExists = true; dstIsDir = s.isDirectory(); } catch {}

    if (dstExists && !VALID_CONFLICTS.includes(conflict)) {
      return { conflict: true, isDir: dstIsDir, name: path.basename(dst) };
    }

    if (conflict === 'cancel') return { success: false, error: 'Cancelled' };
    if (conflict === 'skip') return { success: true, skipped: true };

    if (conflict === 'keep_both' && dstExists) {
      const ext = path.extname(dst);
      const base = path.basename(dst, ext);
      const dir = path.dirname(dst);
      // Bounded: an absurd number of existing copies must not spin forever. Past
      // 1000 collisions report conflict:true instead of silently overwriting —
      // the old fall-through destroyed the destination without feedback.
      let counter = 1;
      let placed = false;
      while (counter <= 1000) {
        const suffix = counter === 1 ? ' (copy)' : ` (copy ${counter})`;
        dst = path.join(dir, base + suffix + ext);
        try { await fsPromises.access(dst); counter++; } catch { placed = true; break; }
      }
      if (!placed) return { conflict: true, isDir: dstIsDir, name: path.basename(dst), error: 'too many copies (max 1000) — choose another name' };
    }

    const st = await fsPromises.stat(src);
    const isDir = st.isDirectory();

    if (dstExists && conflict === 'replace') {
      // Remove the DESTINATION by its own type: replacing an existing directory
      // with a file (or vice versa) must not unlink()/rm() the wrong kind.
      if (dstIsDir) await fsPromises.rm(dst, { recursive: true, force: true });
      else await fsPromises.unlink(dst);
    }

    if (isMove) {
      if (dstExists && conflict === 'merge' && isDir && dstIsDir) {
        await mergeDirs(src, dst);
        await fsPromises.rm(src, { recursive: true, force: true });
      } else {
        await renameWithFallback(src, dst);
      }
    } else {
      if (isDir) {
        if (dstExists && conflict === 'merge' && dstIsDir) {
          await mergeDirs(src, dst);
        } else {
          await fsPromises.cp(src, dst, { recursive: true, force: true });
        }
      } else {
        await fsPromises.copyFile(src, dst);
      }
    }
    return { success: true };
  }

  // Merge src/ into dst/ with full rollback: entries this merge created are
  // removed if a later entry fails, and pre-existing entries overwritten in
  // place are restored from a temp backup, so a failed merge leaves dst
  // exactly as it was. Backup itself is best-effort: if a pre-existing entry
  // can't be backed up, the merge still proceeds (old behavior for that entry).
  async function mergeDirs(src, dst) {
    let before = new Set();
    try { before = new Set(await fsPromises.readdir(dst)); } catch {}
    const created = [];
    const backedUp = new Map(); // entry name -> backup path
    let backupDir = null;
    const makeBackupDir = async () => {
      if (!backupDir) {
        backupDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'webtun-merge-'));
      }
      return backupDir;
    };
    try {
      const entries = await fsPromises.readdir(src);
      for (const entry of entries) {
        if (!before.has(entry)) {
          created.push(entry);
        } else {
          try {
            const dir = await makeBackupDir();
            const bak = path.join(dir, entry);
            await fsPromises.cp(path.join(dst, entry), bak, { recursive: true, force: true });
            backedUp.set(entry, bak);
          } catch {}
        }
        await fsPromises.cp(path.join(src, entry), path.join(dst, entry), { recursive: true, force: true });
      }
    } catch (e) {
      for (const entry of created) {
        try { await fsPromises.rm(path.join(dst, entry), { recursive: true, force: true }); } catch {}
      }
      for (const [entry, bak] of backedUp) {
        try { await fsPromises.cp(bak, path.join(dst, entry), { recursive: true, force: true }); } catch {}
      }
      throw e;
    } finally {
      if (backupDir) {
        try { await fsPromises.rm(backupDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  async function handleCopyMove(req, res, isMove) {
    try {
      if (!req.body.source || !req.body.destination) {
        return res.status(400).json({ error: 'source and destination are required', usage: 'POST JSON { "source": "<src>", "destination": "<dst>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
      }
      const src = realPath(req.body.source);
      const dst = resolvePath(req.body.destination);
      // Sandbox guards (F53)
      if (!ALLOW_FULL_FS) {
        if (!pathContained(WORKSPACE_ROOT, dst)) return res.status(403).json({ error: 'Access denied: destination outside workspace' });
        // If dst exists via symlink, check realpath as well
        try {
          const realDst = fs.realpathSync(dst);
          if (!pathContained(WORKSPACE_ROOT, realDst)) return res.status(403).json({ error: 'Access denied: destination symlink outside workspace' });
        } catch {}
      }
      if (src === dst) return res.status(400).json({ error: 'source and destination are same' });
      if (pathContained(src, dst)) return res.status(400).json({ error: 'destination inside source' });
      const result = await resolveCopyMove(src, dst, req.body.conflict || '', isMove);
      res.json(result);
    } catch (e) {
      sendErr(res, e);
    }
  }

  app.post('/api/files/copy', checkPin, rateLimiter, (req, res) => handleCopyMove(req, res, false));
  app.post('/api/files/move', checkPin, rateLimiter, (req, res) => handleCopyMove(req, res, true));

  // Never delete filesystem roots or the workspace root itself (one bad call
  // must not wipe the host). Shared by single + batch delete.
  function isDeletablePath(p) {
    try {
      const abs = path.resolve(p);
      if (path.parse(abs).root === abs) return false;
      if (abs === path.resolve(WORKSPACE_ROOT)) return false;
      return true;
    } catch { return false; }
  }

  // Delete without following the final path component: lstat (never stat, never
  // realpath) so a symlink is unlinked itself. The old code ran realPath() first,
  // which resolved a symlink-to-directory into its target and rm -rf'd the
  // DESTINATION instead of the link. resolvePath() (no symlink following) +
  // lstat is the safe pair; the kernel still resolves parent components.
  async function removePathSafe(p) {
    const lst = await fsPromises.lstat(p);
    if (lst.isSymbolicLink() || !lst.isDirectory()) await fsPromises.unlink(p);
    else await fsPromises.rm(p, { recursive: true, force: true });
  }
  app.delete('/api/files', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.query.path) {
        console.warn('DELETE /api/files 400 — query param ?path= is required. Example: DELETE /api/files?path=/home/user/file.txt');
        return res.status(400).json({ error: 'path is required', usage: 'DELETE /api/files?path=<path>' });
      }
      const p = resolvePath(req.query.path);
      if (!isDeletablePath(p)) {
        return res.status(400).json({ error: 'Refusing to delete this path' });
      }
      await removePathSafe(p);
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/files/mkdir', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.path) {
        console.warn('POST /api/files/mkdir 400 — body requires { path }. Example: { "path": "/home/user/newfolder" }');
        return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<dir>" }' });
      }
      const p = realPath(req.body.path);
      await fsPromises.mkdir(p, { recursive: true });
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/files/touch', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.path) {
        console.warn('POST /api/files/touch 400 — body requires { path }. Example: { "path": "/home/user/newfile.txt" }');
        return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file>" }' });
      }
      const p = realPath(req.body.path);
      await fsPromises.writeFile(p, '', { flag: 'a' });
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/files/zip', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.path) {
        console.warn('POST /api/files/zip 400 — body requires { path }. Example: { "path": "/home/user/mydir" }');
        return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file_or_dir>" }' });
      }
      const p = realPath(req.body.path);
      const st = await fsPromises.stat(p);
      // Dest dir size guard (F63) — reject if dir >1GB
      if (st.isDirectory()) {
        const sz = await dirSize(p);
        if (sz > 1 * 1024 * 1024 * 1024) return res.status(413).json({ error: 'Directory too large to zip (max 1GB)' });
      } else if (st.size > 1 * 1024 * 1024 * 1024) {
        return res.status(413).json({ error: 'File too large to zip (max 1GB)' });
      }
      const baseName = path.basename(p);
      let zipName = baseName + '.zip';
      let zipPath = path.join(path.dirname(p), zipName);
      // Ensure zipPath inside workspace
      if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, zipPath)) return res.status(403).json({ error: 'Access denied: zip destination outside workspace' });
      let counter = 1;
      while (true) {
        try { await fsPromises.access(zipPath); } catch { break; }
        zipName = baseName + ' (' + counter + ').zip';
        zipPath = path.join(path.dirname(p), zipName);
        if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, zipPath)) return res.status(403).json({ error: 'Access denied' });
        counter++;
      }
      await createZipArchive([{ fullPath: p, nameInZip: baseName }], zipPath);
      res.json({ success: true, name: zipName });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/files/unzip', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.path) {
        console.warn('POST /api/files/unzip 400 — body requires { path }. Example: { "path": "/home/user/archive.zip" }');
        return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<zip_file>" }' });
      }
      const p = realPath(req.body.path);
      const ext = path.extname(p).toLowerCase();
      if (ext !== '.zip') return res.status(400).json({ error: 'Not a zip file' });
      // Validate zip magic (F64) — extractZip also checks, but early check here for 400 vs 500
      try {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(4);
        const bytes = fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        if (bytes < 4 || !(buf[0] === 0x50 && buf[1] === 0x4B)) {
          return res.status(400).json({ error: 'Not a zip file (bad magic)' });
        }
      } catch {}
      let destDir = path.join(path.dirname(p), path.basename(p, '.zip'));
      // Optional single-segment override so the client can retry a 409 into a
      // numbered folder (archive (1)/) instead of just showing an error toast.
      if (req.body.destName != null && String(req.body.destName) !== '') {
        const segs = String(req.body.destName).split(/[\\/]+/).filter(Boolean);
        if (segs.length !== 1) return res.status(400).json({ error: 'destName must be a single folder name' });
        destDir = path.join(path.dirname(p), sanitizeUploadSegment(segs[0]));
      }
      if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, destDir)) return res.status(403).json({ error: 'Access denied: destination outside workspace' });
      // Refuse to merge into a non-empty directory; extract to a temp dir and
      // rename into place so a failed extraction can't wipe pre-existing data.
      try {
        const st = await fsPromises.stat(destDir);
        if (!st.isDirectory()) return res.status(400).json({ error: 'Destination exists and is not a directory' });
        const entries = await fsPromises.readdir(destDir);
        if (entries.length > 0) return res.status(409).json({ error: 'Destination already exists', dir: destDir });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const tmpDir = destDir + '.unzip-' + crypto.randomBytes(6).toString('hex');
      await fsPromises.mkdir(tmpDir, { recursive: true });
      try {
        await extractZip(p, tmpDir);
      } catch (e) {
        // Rollback partial on failure (F64) — only the temp dir, never user data
        try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch {}
        return sendErr(res, e);
      }
      try {
        try { await fsPromises.rmdir(destDir); } catch {}
        await fsPromises.rename(tmpDir, destDir);
      } catch (e) {
        try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch {}
        return sendErr(res, e && e.message ? e : new Error('Failed to move extracted files into place'), 500);
      }
      res.json({ success: true, dir: destDir });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.get('/api/files/read', checkPin, async (req, res) => {
    try {
      const p = resolvePath(req.query.path);
      const st = await fsPromises.stat(p);
      if (st.isDirectory()) return res.status(400).json({ error: 'Cannot read a directory' });
      if (st.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 10MB) - use download' });
      const ext = path.extname(p).toLowerCase().slice(1);
      if (ext && BINARY_EXTS.has(ext)) {
        return res.status(415).json({ error: 'Preview not supported for binary files - use download', isBinary: true });
      }
      const buf = await fsPromises.readFile(p);
      if (buf.includes(0)) {
        return res.status(415).json({ error: 'Preview not supported for binary files - use download', isBinary: true });
      }
      const content = buf.toString('utf8');
      res.json({ content, length: st.size, mtime: st.mtime });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/files/write', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.path) {
        console.warn('POST /api/files/write 400 — body requires { path, content }. Example: { "path": "/home/user/file.txt", "content": "hello world" }');
        return res.status(400).json({ error: 'path is required', usage: 'POST JSON { "path": "<file>", "content": "<string>" }' });
      }
      if (typeof req.body.content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      if (Buffer.byteLength(req.body.content, 'utf8') > 10 * 1024 * 1024) {
        return res.status(413).json({ error: 'Content too large (max 10MB)' });
      }
      const p = realPath(req.body.path);
      await fsPromises.writeFile(p, req.body.content, 'utf8');
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // Mint a dir-scoped preview token for the file-preview frame's subresources.
  // The client resolves the previewed file, takes its directory, and embeds
  // `ptoken` (never the session) in <base href> and rewritten asset URLs.
  app.post('/api/files/preview-token', rateLimiter, checkPin, async (req, res) => {
    try {
      const p = realPath(req.body && req.body.path);
      const lst = await fsPromises.lstat(p).catch(() => null);
      if (!lst) return res.status(404).json({ error: 'Not found' });
      const st = await fsPromises.stat(p).catch(() => null);
      if (!st || !st.isFile()) return res.status(400).json({ error: 'Not a file' });
      res.json({ token: mintPreviewFileToken(path.dirname(p)) });
    } catch (e) {
      sendErr(res, e);
    }
  });
  // Accept a valid preview-file token on the image route only. The requested
  // path must resolve inside the token's directory; anything else falls through
  // to checkPin unchanged (so a token can never launder wider access).
  function checkPreviewFileToken(req, res, next) {
    try {
      const t = req.query && req.query.ptoken;
      if (typeof t !== 'string' || !t) return next();
      const rec = getPreviewFileToken(t);
      if (!rec) return next();
      let p;
      try { p = realPath(req.query.path); } catch { return next(); }
      if (!pathContained(rec.dir, p)) return next();
      req.previewFileToken = true;
    } catch {}
    next();
  }

  // Serve image files for inline viewing (not as download)
  app.get('/api/files/image', checkPreviewFileToken, checkPin, async (req, res) => {
    try {
      const p = resolvePath(req.query.path);
      // Stat before streaming: refuse directories, cap at 100MB
      const lst = await fsPromises.lstat(p).catch(() => null);
      if (!lst) return res.status(404).json({ error: 'Not found' });
      if (!lst.isFile() && !lst.isSymbolicLink()) return res.status(400).json({ error: 'Not a file' });
      const st = await fsPromises.stat(p).catch(() => null);
      if (!st || !st.isFile()) return res.status(400).json({ error: 'Not a file' });
      if (st.size > 100 * 1024 * 1024) return res.status(413).json({ error: 'File too large to preview inline' });
      const mimeType = mimeLookup(p);
      res.setHeader('Content-Type', mimeType);
      // Avoid caching secrets served as octet-stream (F57). Preview-token
      // responses are never cached either: the token is short-lived and the
      // URL must not outlive it in any cache.
      if (mimeType === 'application/octet-stream' || req.previewFileToken) {
        res.setHeader('Cache-Control', 'no-store');
      } else {
        res.setHeader('Cache-Control', 'private, max-age=3600');
      }
      const stream = fs.createReadStream(p);
      // Ensure stream destroyed when client aborts to avoid FD leak (F57)
      req.on('close', () => { try { stream.destroy(); } catch {} });
      stream.on('error', err => {
        if (!res.headersSent) sendErr(res, err);
        else res.end();
      });
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) sendErr(res, e);
    }
  });

  app.get('/api/files/download', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.query.path) {
        console.warn('GET /api/files/download 400 — query param ?path= is required. Example: GET /api/files/download?path=/home/user/file.txt');
        return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/download?path=<path>' });
      }
      const p = realPath(req.query.path);
      const st = await fsPromises.stat(p);
      if (st.isDirectory()) {
        // Same 1GB guard as /api/files/zip — no unbounded archive streams
        try {
          const size = await dirSize(p);
          if (size > 1024 * 1024 * 1024) return res.status(413).json({ error: 'Directory too large to download as zip (1GB limit)' });
        } catch {}
        const safeName = path.basename(p).replace(/["\r\n;]/g, '_') + '.zip';
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        const arch = streamZipDirectory(p, res);
        // Stop the zip writer when the client goes away (F58)
        res.on('close', () => { try { if (arch) arch.abort(); } catch {} });
        return;
      } else {
        const mimeType = mimeLookup(p);
        const safeName = path.basename(p).replace(/["\r\n;]/g, '_');
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        // Transfer Center needs a known total for % / ETA: single files report
        // their size up front (directory zips stay length-less → indeterminate).
        try { if (Number.isFinite(st.size)) res.setHeader('Content-Length', String(st.size)); } catch {}
        res.setHeader('Accept-Ranges', 'bytes');
        const stream = fs.createReadStream(p);
        req.on('close', () => { try { stream.destroy(); } catch {} });
        stream.on('error', err => {
          if (!res.headersSent) sendErr(res, err);
          else res.end();
        });
        stream.pipe(res);
      }
    } catch (e) {
      if (!res.headersSent) sendErr(res, e);
    }
  });

  // Upload filename hygiene: split the client-sent relative path into segments
  // and sanitize each one. Unicode letters, digits, spaces and dots are kept;
  // control chars, Windows-reserved <>:"|?* and traversal segments are removed.
  function sanitizeUploadSegment(seg) {
    let s = String(seg || '').replace(/[\x00-\x1f<>:"|?*]/g, '');
    s = s.replace(/^\s+/, '').replace(/[\s.]+$/, '');
    if (!s || s === '.' || s === '..') return '_';
    return s.slice(0, 255);
  }
  // Upload path depth cap: the multipart filename carries a drag-and-drop
  // relative path — bound its nesting so one request can't fan out thousands of
  // directories. Multer's `files: 100` caps the file count.
  const UPLOAD_MAX_DEPTH = 10;
  function uploadRelPath(originalname) {
    const segs = String(originalname || '').split(/[\\/]+/).filter(Boolean).map(sanitizeUploadSegment);
    const out = segs.length ? segs : ['_'];
    if (out.length > UPLOAD_MAX_DEPTH + 1) {
      const e = new Error('upload path too deep (max ' + UPLOAD_MAX_DEPTH + ' levels)');
      e.status = 400;
      throw e;
    }
    return out;
  }
  // Same-name uploads used to silently overwrite; uniquify instead.
  function uniqueUploadPath(dir, name) {
    let candidate = path.join(dir, name);
    try { fs.accessSync(candidate); } catch { return candidate; }
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    for (let i = 1; i <= 1000; i++) {
      candidate = path.join(dir, base + (i === 1 ? ' (copy)' : ` (copy ${i})`) + ext);
      try { fs.accessSync(candidate); } catch { return candidate; }
    }
    return candidate;
  }

  // Upload with multer disk storage – destination resolved per-request
  app.post('/api/files/upload', rateLimiter, checkPin, (req, res) => {
    let destDir;
    try {
      destDir = realPath(req.query.path || WORKSPACE_ROOT);
    } catch (e) {
      return sendErr(res, e, 403);
    }
    // Segment sanitizer: Unicode + spaces survive; only control characters,
    // Windows-reserved symbols and traversal segments are stripped. The old
    // /[^a-zA-Z0-9_.\-]/g turned every non-ASCII name (документ.pdf, 报告.txt)
    // into underscores that then overwrote each other.
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          // The client sends the drag-and-drop relative path as the multipart
          // filename (folder/sub/file.txt) — preserve the hierarchy instead of
          // flattening everything into the destination root with basename().
          const segs = uploadRelPath(file.originalname);
          const subPath = segs.length > 1 ? path.join(destDir, ...segs.slice(0, -1)) : destDir;
          fs.mkdirSync(subPath, { recursive: true });
          // Real containment (not the old lexical pathContained on sanitized
          // segments, which could never fail): a parent-dir symlink of destDir
          // would redirect the mkdir through the link — verify via realpath.
          let realDest = destDir, realSub = subPath;
          try { realDest = fs.realpathSync(destDir); } catch {}
          try { realSub = fs.realpathSync(subPath); } catch {}
          if (!pathContained(realDest, realSub)) {
            return cb(new Error('Invalid upload destination'));
          }
          cb(null, subPath);
        } catch (err) {
          cb(err);
        }
      },
      filename: (req, file, cb) => {
        try {
          const segs = uploadRelPath(file.originalname);
          const subPath = segs.length > 1 ? path.join(destDir, ...segs.slice(0, -1)) : destDir;
          cb(null, path.basename(uniqueUploadPath(subPath, segs.slice(-1)[0])));
        } catch (err) {
          cb(err);
        }
      }
    });
    const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024, files: 100 } }).array('files');
    // Pre-flight the declared size BEFORE multer streams to disk: the old code
    // checked the 2GB batch total only after the write, so chunked (no
    // Content-Length) uploads filled the disk first and were deleted after.
    // Multer's fileSize/files limits abort mid-stream; the post-write total
    // check below is the backstop for chunked batches (cleaned up on exceed).
    // (Content-Length is a client hint; the multer limits stay the hard cap.)
    const MAX_BATCH = 2 * 1024 * 1024 * 1024;
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_BATCH + (8 * 1024 * 1024)) {
      return res.status(413).json({ error: 'Total upload size exceeds 2GB' });
    }
    upload(req, res, err => {
      if (err) {
        // Don't leave already-written temp files behind on an aborted batch.
        try { (Array.isArray(req.files) ? req.files : []).forEach(f => { try { fs.unlinkSync(f.path); } catch {} }); } catch {}
        // Multer limit errors are 413, not 500 (e.g. LIMIT_FILE_SIZE)
        const status = (err.code && err.code.startsWith('LIMIT_')) ? 413 : 500;
        return sendErr(res, err, status);
      }
      // Total batch cap (2GB) against disk-fill; clean up the batch on exceed
      try {
        const files = Array.isArray(req.files) ? req.files : [];
        const total = files.reduce((n, f) => n + (f.size || 0), 0);
        if (total > 2 * 1024 * 1024 * 1024) {
          for (const f of files) { try { fs.unlinkSync(f.path); } catch {} }
          return res.status(413).json({ error: 'Total upload size exceeds 2GB' });
        }
      } catch {}
      res.json({ success: true, count: Array.isArray(req.files) ? req.files.length : 0 });
    });
  });

  // Cache for owner/group to avoid re-spawning on every request (F60 trail)
  const _ownerCache = new Map();
  const _groupCache = new Map();

  // Async variant: execFileSync on this hot metadata path blocked the event loop
  // for every cache miss (and the cache is per-uid/gid, so cold starts hit it).
  function execFileText(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout || '').trim());
      });
    });
  }

  // ── File stat / metadata ──────────────────────────────────────────────
  app.get('/api/files/stat', checkPin, async (req, res) => {
    try {
      if (!req.query.path) {
        console.warn('GET /api/files/stat 400 — query param ?path= is required');
        return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/stat?path=<path>' });
      }
      const p = realPath(req.query.path);
      const st = await fsPromises.stat(p);
      let lst = null;
      try { lst = await fsPromises.lstat(p); } catch {}
      const stat = {
        path: p, name: path.basename(p),
        size: st.size, blocks: st.blocks,
        mode: st.mode.toString(8).slice(-3),
        permissions: (lst || st).mode.toString(8).slice(-3),
        uid: st.uid, gid: st.gid,
        atime: st.atime, mtime: st.mtime, ctime: st.ctime, birthtime: st.birthtime,
        isFile: st.isFile(), isDirectory: st.isDirectory(),
        isSymlink: lst ? lst.isSymbolicLink() : false,
        isSocket: st.isSocket(), isFIFO: st.isFIFO(),
      };
      // Use cache for owner (F60 trail)
      try {
        if (os.platform() === 'win32') {
          stat.owner = String(st.uid);
        } else if (_ownerCache.has(st.uid)) {
          stat.owner = _ownerCache.get(st.uid);
        } else {
          const owner = await execFileText('id', ['-nu', String(st.uid)]);
          _ownerCache.set(st.uid, owner);
          if (_ownerCache.size > 500) { const k=_ownerCache.keys().next().value; _ownerCache.delete(k); }
          stat.owner = owner;
        }
      } catch { stat.owner = String(st.uid); }
      try {
        if (os.platform() === 'win32') {
          stat.group = String(st.gid);
        } else if (_groupCache.has(st.gid)) {
          stat.group = _groupCache.get(st.gid);
        } else if (os.platform() === 'darwin') {
          const dscl = await execFileText('dscl', ['.', '-read', `/Groups/${st.gid}`, 'RecordName']);
          const m = dscl.match(/RecordName:\s*(.+)/);
          const g = m ? m[1].trim() : String(st.gid);
          _groupCache.set(st.gid, g);
          if (_groupCache.size > 500) { const k=_groupCache.keys().next().value; _groupCache.delete(k); }
          stat.group = g;
        } else {
          const g = (await execFileText('getent', ['group', String(st.gid)])).split(':')[0];
          _groupCache.set(st.gid, g);
          if (_groupCache.size > 500) { const k=_groupCache.keys().next().value; _groupCache.delete(k); }
          stat.group = g;
        }
      } catch { stat.group = String(st.gid); }
      try {
        const symlink = lst && lst.isSymbolicLink() ? await fsPromises.readlink(p) : null;
        if (symlink) stat.linkTarget = symlink;
      } catch {}
      res.json(stat);
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Folder size ──────────────────────────────────────────────────────
  app.get('/api/files/size', checkPin, async (req, res) => {
    try {
      if (!req.query.path) {
        return res.status(400).json({ error: 'path is required', usage: 'GET /api/files/size?path=<dir>' });
      }
      const p = realPath(req.query.path);
      const lst = await fsPromises.lstat(p);
      if (lst.isSymbolicLink()) {
        // Don't follow symlink for size — report link size
        return res.json({ path: p, size: lst.size, isDir: false, isSymlink: true });
      }
      const st = await fsPromises.stat(p);
      if (!st.isDirectory()) {
        return res.json({ path: p, size: st.size, isDir: false });
      }
      const size = await dirSize(p);
      res.json({ path: p, size, isDir: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Batch delete ──────────────────────────────────────────────────────
  app.post('/api/files/batch-delete', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!Array.isArray(req.body.paths) || req.body.paths.length === 0) {
        console.warn('POST /api/files/batch-delete 400 — body requires { paths: [...] }');
        return res.status(400).json({ error: 'paths array is required', usage: 'POST JSON { "paths": ["<path1>", "<path2>", ...] }' });
      }
      if (req.body.paths.length > 100) return res.status(400).json({ error: 'too many paths max 100' });
      const results = [];
      for (const raw of req.body.paths) {
        let p;
        try { p = resolvePath(raw); } catch (e) { results.push({ path: raw, success: false, error: errText(e) }); continue; }
        if (!isDeletablePath(p)) { results.push({ path: raw, success: false, error: 'Refusing to delete this path' }); continue; }
        try {
          await removePathSafe(p);
          results.push({ path: raw, success: true });
        } catch (e) {
          results.push({ path: raw, success: false, error: errText(e) });
        }
      }
      res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Batch copy ────────────────────────────────────────────────────────
  async function handleBatchCopyMove(req, res, isMove) {
    try {
      if (!Array.isArray(req.body.sources) || req.body.sources.length === 0 || !req.body.destination) {
        return res.status(400).json({ error: 'sources array and destination are required', usage: 'POST JSON { "sources": ["<src1>", ...], "destination": "<dir>", "conflict": "replace|skip|keep_both|merge|cancel" }' });
      }
      if (req.body.sources.length > 100) return res.status(400).json({ error: 'too many paths max 100' });
      const conflict = req.body.conflict || 'replace';
      const destDir = resolvePath(req.body.destination);
      const results = [];
      for (const raw of req.body.sources) {
        let src;
        try { src = realPath(raw); } catch (e) { results.push({ path: raw, success: false, error: errText(e) }); continue; }
        try {
          const baseName = path.basename(src);
          const dst = path.join(destDir, baseName);
          // Guard dst containment and self-move (F53)
          if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dst)) {
            results.push({ path: raw, success: false, error: 'Access denied: destination outside workspace' }); continue;
          }
          // Prevent src === dst and dst inside src (move parent into child)
          if (src === dst) { results.push({ path: raw, success: false, error: 'source and destination are same' }); continue; }
          if (pathContained(src, dst)) { results.push({ path: raw, success: false, error: 'destination inside source' }); continue; }
          const result = await resolveCopyMove(src, dst, conflict, isMove);
          results.push({ path: raw, success: true, ...result });
        } catch (e) {
          results.push({ path: raw, success: false, error: errText(e) });
        }
      }
      res.json({ results, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length });
    } catch (e) {
      sendErr(res, e);
    }
  }

  app.post('/api/files/batch-copy', rateLimiter, checkPin, (req, res) => handleBatchCopyMove(req, res, false));
  app.post('/api/files/batch-move', rateLimiter, checkPin, (req, res) => handleBatchCopyMove(req, res, true));

  // ── Change permissions (chmod) ─────────────────────────────────────────
  app.post('/api/files/chmod', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.path || !req.body.mode) {
        console.warn('POST /api/files/chmod 400 — body requires { path, mode }. Example: { "path": "/home/user/file.sh", "mode": "755" }');
        return res.status(400).json({ error: 'path and mode are required', usage: 'POST JSON { "path": "<path>", "mode": "<octal_perms>" }' });
      }
      const p = realPath(req.body.path);
      if (!/^[0-7]{3,4}$/.test(req.body.mode)) return res.status(400).json({ error: 'mode must be a 3-4 digit octal number (e.g. 755, 644, 1777)' });
      const mode = parseInt(req.body.mode, 8);
      await fsPromises.chmod(p, mode);
      const warning = os.platform() === 'win32' ? 'chmod has no effect on Windows' : undefined;
      res.json({ success: true, mode: req.body.mode, ...(warning && { warning }) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Create symlink ────────────────────────────────────────────────────
  app.post('/api/files/symlink', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.target || !req.body.linkPath) {
        console.warn('POST /api/files/symlink 400 — body requires { target, linkPath }. Example: { "target": "/real/file.txt", "linkPath": "/home/user/link.txt" }');
        return res.status(400).json({ error: 'target and linkPath are required', usage: 'POST JSON { "target": "<existing_path>", "linkPath": "<symlink_path>" }' });
      }
      const target = realPath(req.body.target);
      const linkPath = realPath(req.body.linkPath);
      await fsPromises.mkdir(path.dirname(linkPath), { recursive: true });
      await fsPromises.symlink(target, linkPath);
      res.json({ success: true, target, linkPath });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Full-text content search ──────────────────────────────────────────
  app.post('/api/files/search-content', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.body.query || !req.body.path) {
        console.warn('POST /api/files/search-content 400 — body requires { query, path }. Example: { "query": "TODO", "path": "/home/user/project", "pattern": "string" }');
        return res.status(400).json({ error: 'query and path are required', usage: 'POST JSON { "query": "<text_or_regex>", "path": "<dir>", "pattern": "string|regex", "maxResults": 50, "maxDepth": 4 }' });
      }
      const searchDir = resolvePath(req.body.path);
      const queryRaw = req.body.query;
      if (typeof queryRaw !== 'string' || queryRaw.length === 0 || queryRaw.length > 500) return res.status(400).json({ error: 'query must be string 1-500 chars' });
      const query = queryRaw;
      const isRegex = req.body.pattern === 'regex';
      // NaN guard (F65): coerce to integer, clamp
      let mR = parseInt(req.body.maxResults, 10);
      if (!Number.isFinite(mR) || mR < 1) mR = 50;
      const maxResults = Math.min(mR, 200);
      let mD = parseInt(req.body.maxDepth, 10);
      if (!Number.isFinite(mD) || mD < 1) mD = 4;
      const maxDepth = Math.min(mD, 4);
      const results = [];
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // skip files > 10MB
      const BINARY_CHECK_LEN = 4096;

      let regex;
      if (isRegex) {
        if (query.length > 200) return res.status(400).json({ error: 'regex too long max 200' });
        try { regex = new RegExp(query, 'gi'); } catch { return res.status(400).json({ error: 'invalid regex pattern' }); }
        // ReDoS guard, enforced (the previous check detected this shape and then
        // did nothing): a quantifier applied to a group that already contains one
        // — (a+)+, (a*)*, (ab+){2,} — backtracks catastrophically and would block
        // the event loop for the entire server. Common safe forms like (foo|bar)+
        // have no inner quantifier and still pass.
        if (/\([^)]*[+*][^)]*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(query)) {
          return res.status(400).json({ error: 'regex rejected: nested quantifiers can hang the server — use a literal search' });
        }
      }
      // Hard deadline: a pathological-but-accepted pattern must not pin the
      // event loop indefinitely across a large tree.
      const SCAN_DEADLINE = Date.now() + 15000;
      const SCAN_CAP = 2 * 1024 * 1024; // bytes scanned per file (was: whole file in RAM)

      async function walkContentSearch(currentDir, depth) {
        if (depth > maxDepth || results.length >= maxResults) return;
        let entries;
        try { entries = await fsPromises.readdir(currentDir, { withFileTypes: true }); } catch { return; }
        const dirs = [];
        for (const e of entries) {
          if (results.length >= maxResults) break;
          const full = path.join(currentDir, e.name);
          try {
            if (e.isDirectory()) {
              // Use lstat to avoid following symlink dir outside sandbox
              let lst; try { lst = await fsPromises.lstat(full); } catch { continue; }
              if (lst.isSymbolicLink()) {
                let targetReal; try { targetReal = fs.realpathSync(full); } catch { continue; }
                if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, targetReal)) continue;
              }
              dirs.push(e);
            } else if (e.isFile() || e.isSymbolicLink()) {
              // For symlink files, ensure target inside workspace and not binary bypass
              let st;
              if (e.isSymbolicLink()) {
                let targetReal; try { targetReal = fs.realpathSync(full); } catch { continue; }
                if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, targetReal)) continue;
                try { st = await fsPromises.stat(full); } catch { continue; }
              } else {
                st = await fsPromises.stat(full);
              }
              if (st.size > MAX_FILE_SIZE) continue;
              if (st.size === 0) continue;
              // Check for binary
              const fd = await fsPromises.open(full, 'r');
              try {
                const buf = Buffer.alloc(BINARY_CHECK_LEN);
                const { bytesRead } = await fd.read(buf, 0, BINARY_CHECK_LEN, 0);
                if (buf.slice(0, bytesRead).includes(0)) continue; // binary
              } finally { await fd.close(); }
              const lowerQuery = query.toLowerCase();
              const checkLine = (line, lineNo) => {
                let match;
                if (regex) {
                  regex.lastIndex = 0;
                  match = regex.exec(line);
                } else {
                  const idx = line.toLowerCase().indexOf(lowerQuery);
                  match = idx !== -1 ? { index: idx } : null;
                }
                if (match) {
                  results.push({ path: full, line: lineNo, column: match.index, content: line.substring(0, 500) });
                }
              };
              // Stream the file instead of readFile-ing it whole: the old version
              // held up to 10MB per candidate file in memory and split the entire
              // buffer into lines before looking at any of them.
              const stream = fs.createReadStream(full, { encoding: 'utf8', highWaterMark: 64 * 1024 });
              let carry = '';
              let lineNo = 0;
              let scanned = 0;
              let stopped = false;
              try {
                for await (const chunk of stream) {
                  if (results.length >= maxResults || Date.now() > SCAN_DEADLINE) { stopped = true; break; }
                  scanned += Buffer.byteLength(chunk);
                  if (scanned > SCAN_CAP) { stopped = true; break; }
                  carry += chunk;
                  let nl;
                  while ((nl = carry.indexOf('\n')) !== -1) {
                    const line = carry.slice(0, nl);
                    carry = carry.slice(nl + 1);
                    lineNo++;
                    checkLine(line, lineNo);
                    if (results.length >= maxResults) break;
                  }
                  // A single pathological line must not grow the buffer forever.
                  if (carry.length > 1024 * 1024) { carry = carry.slice(-500); lineNo++; }
                }
                if (!stopped && carry && results.length < maxResults) checkLine(carry, lineNo + 1);
              } catch {}
              finally { try { stream.destroy(); } catch {} }
              if (Date.now() > SCAN_DEADLINE || results.length >= maxResults) break;
            }
          } catch {}
        }
        // Sequential descent: Promise.all over every subdirectory fanned out
        // without any limit (fd/memory exhaustion on wide trees) and ignored the
        // result caps until the recursion unwound.
        for (const d of dirs) {
          if (results.length >= maxResults || Date.now() > SCAN_DEADLINE) break;
          await walkContentSearch(path.join(currentDir, d.name), depth + 1);
        }
      }

      await walkContentSearch(searchDir, 0);
      res.json({ results, count: results.length, query, path: searchDir });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Batch zip (multiple sources) ──────────────────────────────────────
  app.post('/api/files/batch-zip', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!Array.isArray(req.body.sources) || req.body.sources.length === 0 || !req.body.destination) {
        console.warn('POST /api/files/batch-zip 400 — body requires { sources: [...], destination: "<path>" }. Example: { "sources": ["/a", "/b"], "destination": "/home/user/archive.zip" }');
        return res.status(400).json({ error: 'sources array and destination are required', usage: 'POST JSON { "sources": ["<path1>", ...], "destination": "<zip_path>" }' });
      }
      if (req.body.sources.length > 100) return res.status(400).json({ error: 'too many sources max 100' });
      let dest = realPath(req.body.destination);
      if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dest)) return res.status(403).json({ error: 'Access denied: destination outside workspace' });
      const resolved = req.body.sources.map(s => realPath(s));
      // Auto-rename if destination exists
      let counter = 1;
      const ext = '.zip';
      const origDest = dest;
      while (true) {
        try { await fsPromises.access(dest); } catch { break; }
        dest = origDest.replace(/(\.zip)?$/i, ` (${counter})${ext}`);
        if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dest)) return res.status(403).json({ error: 'Access denied' });
        counter++;
        if (counter > 1000) return res.status(400).json({ error: 'too many existing zips' });
      }
      await fsPromises.mkdir(path.dirname(dest), { recursive: true });
      const entries = resolved.map(s => ({ fullPath: s, nameInZip: path.basename(s) }));
      await createZipArchive(entries, dest);
      res.json({ success: true, name: path.basename(dest), files: req.body.sources.length });
    } catch (e) {
      sendErr(res, e);
    }
  });







  // ── Log tail (SSE) ────────────────────────────────────────────────────
  app.get('/api/files/tail', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!req.query.path) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const p = realPath(req.query.path);
      const lines = Math.min(parseInt(req.query.lines) || 50, 500);
      const pollInterval = Math.max(500, parseInt(req.query.interval) || 2000);

      const st = await fsPromises.stat(p);
      if (st.isDirectory()) { res.status(400).json({ error: 'cannot tail a directory' }); return; }
      if (st.size > 100 * 1024 * 1024) { res.status(413).json({ error: 'file too large to tail (max 100MB)' }); return; }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Read only a bounded tail window. This used to readFile() the ENTIRE file
      // (up to 100MB) for the initial payload, and compared `content.length`
      // (characters) against stat.size (bytes), so multibyte logs resynced at the
      // wrong offset. Everything below is byte-offset based.
      const MAX_TAIL_BYTES = 64 * 1024;
      const readRange = async (start, len) => {
        if (len <= 0) return Buffer.alloc(0);
        const fd = await fsPromises.open(p, 'r');
        try {
          const buf = Buffer.alloc(len);
          await fd.read(buf, 0, len, start);
          return buf;
        } finally { await fd.close(); }
      };

      const initStart = Math.max(0, st.size - MAX_TAIL_BYTES);
      const initBuf = await readRange(initStart, st.size - initStart);
      const tailLines = initBuf.toString('utf8').split('\n').slice(-lines);
      res.write(`data: ${JSON.stringify({ type: 'init', lines: tailLines, total: tailLines.length })}\n\n`);

      // Poll for changes
      let lastSize = st.size;
      const timer = setInterval(async () => {
        if (res.writableEnded) { clearInterval(timer); return; }
        try {
          const newSt = await fsPromises.stat(p);
          if (newSt.size > lastSize) {
            // Cap each poll at MAX_TAIL_BYTES so a burst of writes can't allocate
            // an unbounded buffer; anything older than the window is skipped.
            const start = Math.max(lastSize, newSt.size - MAX_TAIL_BYTES);
            const buf = await readRange(start, newSt.size - start);
            lastSize = newSt.size;
            res.write(`data: ${JSON.stringify({ type: 'data', lines: buf.toString('utf8') })}\n\n`);
          } else if (newSt.size < lastSize) {
            // File was truncated — resync from the new end
            lastSize = newSt.size;
          }
        } catch {}
      }, pollInterval);

      req.on('close', () => { clearInterval(timer); });
    } catch (e) {
      if (!res.headersSent) sendErr(res, e);
    }
  });

  // ── Clipboard (server-side staging) ───────────────────────────────────
  // Per-IP clipboard to prevent cross-user leak (F17, F69)
  // Keyed by the authenticated session, not the socket address: behind a tunnel
  // every client's req.ip is 127.0.0.1, so an IP key handed one user's cut/copy
  // set to another. Entries also expire — they used to live until a restart.
  const clipboards = new Map(); // key -> { sources, action, createdAt, expiresAt }
  const CLIPBOARD_TTL_MS = 15 * 60 * 1000;
  const CLIPBOARD_MAX = 200;
  function clipboardKey(req) {
    const t = (req && req.authToken) || '';
    if (t) return 't:' + crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);
    return 'ip:' + ((req && req.ip) || 'default');
  }
  function getClipboard(key) {
    const now = Date.now();
    // Expire unconditionally: entries without sources used to linger forever
    // (skipped by the old `!v.sources` guard) and the map had no size cap.
    for (const [k, v] of clipboards) {
      if (!v) { clipboards.delete(k); continue; }
      if (v.expiresAt && now > v.expiresAt) { clipboards.delete(k); continue; }
      if ((!v.sources || !v.sources.length) && k !== key) clipboards.delete(k);
    }
    while (clipboards.size > CLIPBOARD_MAX) {
      const first = clipboards.keys().next().value;
      if (first === undefined) break;
      if (first === key) break;
      clipboards.delete(first);
    }
    if (!clipboards.has(key)) clipboards.set(key, { sources: [], action: null, createdAt: null, expiresAt: 0 });
    return clipboards.get(key);
  }

  app.get('/api/clipboard', checkPin, (req, res) => {
    const cb = getClipboard(clipboardKey(req));
    res.json({ clipboard: cb });
  });

  app.post('/api/clipboard', checkPin, async (req, res) => {
    try {
      if (!Array.isArray(req.body.sources) || req.body.sources.length === 0) {
        return res.status(400).json({ error: 'sources array is required' });
      }
      if (req.body.sources.length > 100) return res.status(400).json({ error: 'too many sources max 100' });
      const action = req.body.action === 'cut' ? 'cut' : 'copy';
      const key = clipboardKey(req);
      const clipboard = {
        sources: req.body.sources.map(s => realPath(s)),
        action,
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + CLIPBOARD_TTL_MS
      };
      clipboards.set(key, clipboard);
      while (clipboards.size > CLIPBOARD_MAX) {
        const first = clipboards.keys().next().value;
        if (first === undefined || first === key) break;
        clipboards.delete(first);
      }
      res.json({ clipboard, count: clipboard.sources.length });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/clipboard/paste', checkPin, async (req, res) => {
    try {
      if (!req.body.destination) return res.status(400).json({ error: 'destination is required' });
      const key = clipboardKey(req);
      const clipboard = getClipboard(key);
      if (!clipboard.sources.length) return res.status(400).json({ error: 'clipboard is empty' });
      const destDir = resolvePath(req.body.destination);
      const conflict = req.body.conflict || 'replace';
      const results = [];
      for (const src of clipboard.sources) {
        try {
          const baseName = path.basename(src);
          const dst = path.join(destDir, baseName);
          if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, dst)) {
            results.push({ path: src, success: false, error: 'Access denied: destination outside workspace' });
            continue;
          }
          const result = await resolveCopyMove(src, dst, conflict, clipboard.action === 'cut');
          results.push({ path: src, success: true, ...result });
        } catch (e) {
          results.push({ path: src, success: false, error: errText(e) });
        }
      }
      const pasteAction = clipboard.action;
      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      if (clipboard.action === 'cut' && failed === 0) {
        clipboards.set(key, { sources: [], action: null, createdAt: null, expiresAt: 0 });
      } else if (clipboard.action === 'cut' && failed > 0) {
        // Keep clipboard for retry on partial failure (F69)
      }
      res.json({ results, succeeded, failed, pasteAction });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.delete('/api/clipboard', checkPin, (req, res) => {
    clipboards.set(clipboardKey(req), { sources: [], action: null, createdAt: null, expiresAt: 0 });
    res.json({ success: true });
  });

  // ── File search (fuzzy finder) ──────────────────────────────────────
  app.get('/api/search', rateLimiter, checkPin, async (req, res) => {
    let q = (req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 1) return res.json({ results: [] });
    if (q.length > 200) q = q.slice(0, 200);
    const dir = req.query.path || WORKSPACE_ROOT;
    if (typeof dir !== 'string' || dir.length > 1024) return res.status(400).json({ error: 'path too long' });

    try {
      const searchDir = resolvePath(dir);
      const maxResults = 50;
      const results = [];
      const maxDepth = 4;

      await asyncSafeWalk(searchDir, 0, maxDepth, q, results, maxResults);
      res.json({ results });
    } catch (e) {
      sendErr(res, e);
    }
  });



}

module.exports = { registerFileRoutes };

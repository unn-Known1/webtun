'use strict';

const fsPromises = require('fs').promises;
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnRead } = require('./process');
const { sendErr, gitErrText, gitErrStatus } = require('./errors');
function registerGitRoutes(options) {
  const { app, checkPin, rateLimiter, paths, workspaceRoot: WORKSPACE_ROOT, allowFullFs: ALLOW_FULL_FS } = options;
  const { resolvePath, pathContained } = paths;

  // ── Git panel ─────────────────────────────────────────────────────────
  // All git invocations use arg arrays (no shell). `git -C <root>` keeps the
  // child inside the repo without cwd plumbing. File args are validated to
  // stay within the repo root via pathContained().
  let GIT_STATE = null; // null = unchecked, 'ok' | 'missing'
  function gitAvailable() {
    if (GIT_STATE) return GIT_STATE === 'ok';
    try {
      execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      GIT_STATE = 'ok';
    } catch { GIT_STATE = 'missing'; }
    return GIT_STATE === 'ok';
  }

  // Resolve repo root for a directory. Throws 404 when not inside a repo.
  async function gitRootFor(dir) {
    const resolved = resolvePath(dir);
    let root;
    try {
      root = (await spawnRead('git', ['-C', resolved, 'rev-parse', '--show-toplevel'])).trim().split('\n')[0];
    } catch {
      const e = new Error('not a git repository'); e.status = 404; throw e;
    }
    if (!root) { const e = new Error('not a git repository'); e.status = 404; throw e; }
    if (!ALLOW_FULL_FS && !pathContained(WORKSPACE_ROOT, root)) {
      const e = new Error('Access denied: repo outside workspace'); e.status = 403; throw e;
    }
    return root;
  }

  function parseGitNumstat(raw) {
    // -z leaves filename bytes unquoted, including Unicode, tabs/newlines,
    // and the literal strings " -> " / " => ". Rename records use two paths.
    const map = new Map();
    const records = (raw || '').split('\0');
    for (let i = 0; i < records.length; i++) {
      const line = records[i];
      if (!line) continue;
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(line);
      if (!match) continue;
      const [, aRaw, dRaw] = match;
      let p = match[3];
      if (!p) { i++; p = records[++i]; }
      if (!p) continue;
      if (aRaw === '-' || dRaw === '-') { map.set(p, { binary: true }); continue; }
      const added = parseInt(aRaw, 10), deleted = parseInt(dRaw, 10);
      if (isNaN(added) || isNaN(deleted)) continue;
      const prev = map.get(p);
      if (prev && !prev.binary) map.set(p, { added: prev.added + added, deleted: prev.deleted + deleted });
      else map.set(p, { added, deleted });
    }
    return map;
  }

  // Line-count untracked files so new files show as "+N" like GitHub.
  // Capped: max 100 files, skip dirs / files >1MB / unreadable / likely binary.
  async function countUntrackedLines(root, files) {
    const out = new Map();
    const capped = (files || []).slice(0, 100);
    await Promise.all(capped.map(async (f) => {
      try {
        if (!f || /[/\\]$/.test(f)) return;
        const abs = path.resolve(root, f);
        if (!pathContained(root, abs)) return;
        const st = await fsPromises.stat(abs);
        if (!st.isFile() || st.size > 1024 * 1024) return;
        const buf = await fsPromises.readFile(abs);
        if (buf.includes(0)) return; // binary
        const text = buf.toString('utf8');
        const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
        out.set(f, lines);
      } catch {}
    }));
    return out;
  }
  function parseGitStatus(raw) {
    const lines = (raw || '').split('\0');
    const head = lines[0] || '';
    let branch = '?', detached = false, ahead = 0, behind = 0;
    const hm = head.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.(.+?))?(?: \[(.+)\])?$/);
    if (hm) {
      const local = (hm[1] || '').trim();
      if (local.startsWith('HEAD')) { detached = true; branch = '(detached)'; }
      else branch = local;
      const info = hm[3] || '';
      const am = info.match(/ahead (\d+)/); if (am) ahead = parseInt(am[1], 10);
      const bm = info.match(/behind (\d+)/); if (bm) behind = parseInt(bm[1], 10);
    }
    const staged = [], unstaged = [], untracked = [], unmerged = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length < 4) continue;
      const x = line[0], y = line[1];
      let p = line.slice(3);
      if (!p) continue;
      const entry = { path: p, x, y };
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') entry.originalPath = lines[++i];
      if (x === '?' && y === '?') { untracked.push({ path: p }); continue; }
      if (x === 'U' || y === 'U' || ['AA', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(x + y)) { unmerged.push(entry); continue; }
      if (x !== ' ' && x !== '?') staged.push(entry);
      if (y !== ' ' && y !== '?') unstaged.push(entry);
    }
    return { branch, detached, ahead, behind, staged, unstaged, untracked, unmerged };
  }
  async function gitOperation(root) {
    const gitDir = (await spawnRead('git', ['-C', root, 'rev-parse', '--absolute-git-dir'])).trim();
    const exists = name => fsPromises.stat(path.join(gitDir, name)).then(() => true, () => false);
    if (await exists('rebase-merge') || await exists('rebase-apply')) return 'rebase';
    if (await exists('MERGE_HEAD')) return 'merge';
    return null;
  }

  app.get('/api/git/status', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      let root;
      try { root = await gitRootFor(req.query.path); }
      catch (e) {
        if (e.status === 404) return res.json({ git: true, isRepo: false });
        throw e;
      }
      const raw = await spawnRead('git', ['-C', root, 'status', '--porcelain=v1', '-b', '-z'], { timeout: 60000 });
      const st = parseGitStatus(raw);
      // Per-file line stats (GitHub-style +added/-removed) via numstat.
      // Best-effort: never fail the whole status when numstat fails.
      try {
        const [unstagedRaw, stagedRaw] = await Promise.all([
          spawnRead('git', ['-C', root, 'diff', '--numstat', '-z'], { timeout: 60000 }).catch(() => ''),
          spawnRead('git', ['-C', root, 'diff', '--cached', '--numstat', '-z'], { timeout: 60000 }).catch(() => ''),
        ]);
        const unstagedMap = parseGitNumstat(unstagedRaw);
        const stagedMap = parseGitNumstat(stagedRaw);
        for (const e of st.unstaged) {
          const s = unstagedMap.get(e.path);
          if (s && s.binary) e.binary = true;
          else if (s) { e.added = s.added; e.deleted = s.deleted; }
        }
        for (const e of st.staged) {
          const s = stagedMap.get(e.path);
          if (s && s.binary) e.binary = true;
          else if (s) { e.added = s.added; e.deleted = s.deleted; }
        }
      } catch {}
      try {
        const lineCounts = await countUntrackedLines(root, st.untracked.map(e => e.path));
        for (const e of st.untracked) {
          if (lineCounts.has(e.path)) { e.added = lineCounts.get(e.path); e.deleted = 0; }
        }
      } catch {}
      // Totals across staged + unstaged + untracked (unmerged excluded)
      let totalAdded = 0, totalDeleted = 0;
      for (const e of [...st.staged, ...st.unstaged, ...st.untracked]) {
        if (typeof e.added === 'number') totalAdded += e.added;
        if (typeof e.deleted === 'number') totalDeleted += e.deleted;
      }
      st.totalAdded = totalAdded; st.totalDeleted = totalDeleted;
      if (st.detached) {
        try { st.branch = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim() + ' (detached)'; } catch {}
      }
      try {
        const sl = await spawnRead('git', ['-C', root, 'stash', 'list', '--format=%gd']);
        st.stashCount = sl.split('\n').filter(Boolean).length;
      } catch { st.stashCount = 0; }
      try { st.upstream = (await spawnRead('git', ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim(); }
      catch { st.upstream = ''; }
      st.operation = await gitOperation(root);
      res.json({ git: true, isRepo: true, root, ...st });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.get('/api/git/diff', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const file = req.query.file;
      if (!file || typeof file !== 'string' || Array.isArray(file)) return res.status(400).json({ error: 'file is required' });
      const abs = path.resolve(root, file);
      if (!pathContained(root, abs)) return res.status(400).json({ error: 'file outside repo' });
      const rel = path.relative(root, abs) || '.';
      if (rel === '.' || rel === '..' || rel.startsWith('..' + path.sep)) return res.status(400).json({ error: 'invalid file path' });
      const args = ['-C', root, 'diff', '--no-color'];
      if (req.query.cached === '1') args.push('--cached');
      // head=1 diffs against HEAD — the only view that shows unmerged/conflicted files
      if (req.query.head === '1') args.push('HEAD');
      args.push('--', rel);
      // Explicit timeout (not the 5s spawnRead default): large-repo diffs
      // spuriously 500'd before they could finish draining.
      let diff = await spawnRead('git', args, { timeout: 15000, maxBytes: 400000 });
      const binary = diff.includes('Binary files');
      const truncated = diff.length > 200000;
      if (truncated) diff = diff.slice(0, 200000);
      res.json({ success: true, diff, binary, truncated });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.get('/api/git/log', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      let n = parseInt(req.query.n, 10);
      if (isNaN(n) || n < 1) n = 10;
      if (n > 20) n = 20;
      const skip = Number(req.query.skip || 0);
      if (!Number.isSafeInteger(skip) || skip < 0 || skip > 1000000) return res.status(400).json({ error: 'invalid history offset' });
      const raw = await spawnRead('git', ['-C', root, 'log', '-n', String(n + 1), '--skip=' + skip, '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--date=short']);
      const commits = raw.split('\n').filter(Boolean).map(l => {
        const [hash, short, author, date, ...subj] = l.split('\x1f');
        return { hash, short, author, date, subject: subj.join('\x1f') };
      });
      res.json({ success: true, commits: commits.slice(0, n), hasMore: commits.length > n, next: skip + Math.min(commits.length, n) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  function gitFileArgs(root, files) {
    if (!Array.isArray(files) || !files.length || files.length > 100) {
      const e = new Error('files must be an array of 1-100 paths'); e.status = 400; throw e;
    }
    return files.map(f => {
      if (typeof f !== 'string' || !f || f.includes('\0')) { const e = new Error('invalid file path'); e.status = 400; throw e; }
      const abs = path.resolve(root, f);
      if (!pathContained(root, abs)) { const e = new Error('file outside repo: ' + f); e.status = 400; throw e; }
      const rel = path.relative(root, abs) || '.';
      // Never allow the repo root itself ('sub/..' tricks) — that would stage/discard everything
      if (rel === '.' || rel === '..' || rel.startsWith('..' + path.sep)) { const e = new Error('invalid file path: ' + f); e.status = 400; throw e; }
      return rel;
    });
  }

  app.post('/api/git/stage', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const rels = gitFileArgs(root, req.body && req.body.files);
      await spawnRead('git', ['-C', root, 'add', '--', ...rels]);
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/unstage', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const rels = gitFileArgs(root, req.body && req.body.files);
      await spawnRead('git', ['-C', root, 'restore', '--staged', '--', ...rels]);
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/commit', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      let message = req.body && req.body.message;
      if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'commit message is required' });
      message = message.trim().slice(0, 1000);
      if (req.body && req.body.all) await spawnRead('git', ['-C', root, 'add', '-A']);
      try {
        await spawnRead('git', ['-C', root, 'commit', '-m', message]);
      } catch (e) {
        return res.status(400).json({ error: gitErrText(e, 'commit failed') });
      }
      let hash = '';
      try { hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim(); } catch {}
      res.json({ success: true, hash });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/pull', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const mode = req.body && req.body.mode;
      const flag = mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--no-rebase';
      let out = '';
      // 60s server timeout vs the 30s api() cap is intentional: a client abort
      // does not kill the child, and pull/push/fetch are safe to finish
      // server-side (the client re-reads state on retry). Timeouts now surface
      // as 504 via gitErrStatus instead of a flat 400.
      try { out = await spawnRead('git', ['-C', root, 'pull', flag], { timeout: 60000 }); }
      catch (e) { return res.status(gitErrStatus(e)).json({ error: gitErrText(e, 'pull failed', 1000) }); }
      res.json({ success: true, output: out.slice(-5000) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/push', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      // upstream:true runs `git push -u origin HEAD` (explicit user consent —
      // offered by the client when push fails with "no upstream branch").
      const args = ['-C', root, 'push'];
      if (req.body && req.body.upstream) args.push('-u', 'origin', 'HEAD');
      let out = '';
      try { out = await spawnRead('git', args, { timeout: 60000 }); }
      catch (e) { return res.status(gitErrStatus(e)).json({ error: gitErrText(e, 'push failed', 1000) }); }
      res.json({ success: true, output: out.slice(-5000) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // Validate a branch name with git itself (rejects `-x`, `..`, spaces, `~^:?*[`).
  // Leading-dash names are rejected up front so the name can never be parsed as
  // a flag even if validation were bypassed; every switch/branch/tag invocation
  // below also passes `--` before the ref.
  async function assertSafeBranch(root, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      const e = new Error('invalid branch name'); e.status = 400; throw e;
    }
    if (name.trim().startsWith('-')) {
      const e = new Error('invalid branch name'); e.status = 400; throw e;
    }
    try {
      await spawnRead('git', ['-C', root, 'check-ref-format', '--branch', name.trim()]);
    } catch {
      const e = new Error('invalid branch name'); e.status = 400; throw e;
    }
    return name.trim();
  }

  app.get('/api/git/branches', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const raw = await spawnRead('git', ['-C', root, 'branch', '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)']);
      const branches = raw.split('\n').filter(Boolean).map(l => {
        const [name, head, upstream] = l.split('\x1f');
        return { name, current: head === '*', upstream: upstream || '' };
      });
      res.json({ success: true, branches });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/switch', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const branch = await assertSafeBranch(root, req.body && req.body.branch);
      try { await spawnRead('git', ['-C', root, 'switch', '--', branch]); }
      catch (e) { return res.status(400).json({ error: gitErrText(e, 'switch failed') }); }
      res.json({ success: true, branch });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/branch', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const branch = await assertSafeBranch(root, req.body && req.body.name);
      try { await spawnRead('git', ['-C', root, 'switch', '-c', branch]); }
      catch (e) { return res.status(400).json({ error: gitErrText(e, 'create failed') }); }
      res.json({ success: true, branch });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/branch/delete', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body?.path);
      const name = await assertSafeBranch(root, req.body?.name);
      await spawnRead('git', ['-C', root, 'branch', req.body.force === true ? '-D' : '-d', '--', name]);
      res.json({ success: true, name });
    } catch (e) { sendErr(res, e, 400); }
  });
  app.post('/api/git/merge', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body?.path);
      if (await gitOperation(root)) return res.status(409).json({ error: 'Finish or abort the current operation first' });
      const branch = await assertSafeBranch(root, req.body?.branch);
      const hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--verify', '--end-of-options', 'refs/heads/' + branch + '^{commit}'])).trim();
      const output = await spawnRead('git', ['-C', root, 'merge', '--no-edit', '--', hash], { timeout: 60000, env: { GIT_EDITOR: 'true' } });
      res.json({ success: true, output });
    } catch (e) { sendErr(res, e, 400); }
  });
  for (const action of ['continue', 'abort']) app.post('/api/git/' + action, rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body?.path);
      const operation = await gitOperation(root);
      if (!operation) return res.status(409).json({ error: 'No merge or rebase is in progress' });
      const output = await spawnRead('git', ['-C', root, operation, '--' + action], { timeout: 60000, env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
      res.json({ success: true, operation, action, output });
    } catch (e) { sendErr(res, e, 400); }
  });
  app.get('/api/git/blame', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const [file] = gitFileArgs(root, [req.query.file]);
      const start = Number(req.query.start || 1), count = Number(req.query.count || 200);
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 500) return res.status(400).json({ error: 'Blame needs a positive start and 1–500 lines' });
      const stat = await fsPromises.stat(path.join(root, file));
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Blame supports text files up to 2MB' });
      const content = await fsPromises.readFile(path.join(root, file));
      if (content.includes(0)) return res.status(415).json({ error: 'Cannot blame a binary file' });
      const text = content.toString('utf8'), lineCount = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
      if (start > lineCount) return res.json({ success: true, blame: '', truncated: false, start, next: start, done: true });
      let blame = await spawnRead('git', ['-C', root, 'blame', '--date=short', '-L', `${start},${Math.min(lineCount, start + count - 1)}`, '--', file], { timeout: 15000, maxBytes: 200001 });
      const truncated = blame.length > 200000;
      blame = blame.slice(0, 200000);
      res.json({ success: true, blame, truncated, start, next: start + blame.split('\n').filter(Boolean).length });
    } catch (e) { sendErr(res, e, 400); }
  });

  const handleGetStash = async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const raw = await spawnRead('git', ['-C', root, 'stash', 'list', '--format=%gd%x1f%gs']);
      const stashes = raw.split('\n').filter(Boolean).map((l, idx) => {
        const [ref, ...msg] = l.split('\x1f');
        return { index: idx, ref, message: msg.join('\x1f') };
      });
      res.json({ success: true, stashes });
    } catch (e) {
      sendErr(res, e);
    }
  };
  app.get('/api/git/stash', rateLimiter, checkPin, handleGetStash);
  app.get('/api/git/stashes', rateLimiter, checkPin, handleGetStash);

  app.post('/api/git/stash', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const action = (req.body && req.body.action) || 'push';
      if (action === 'apply' || action === 'pop' || action === 'drop') {
        const refInput = req.body.ref !== undefined ? req.body.ref : (req.body.index !== undefined ? `stash@{${Number(req.body.index) || 0}}` : '');
        const args = ['-C', root, 'stash', action];
        if (refInput !== '') {
          if (typeof refInput !== 'string' || !/^stash@\{\d+\}$/.test(refInput)) {
            return res.status(400).json({ error: 'invalid stash ref' });
          }
          args.push(refInput);
        }
        try { await spawnRead('git', args); }
        catch (e) { return res.status(400).json({ error: gitErrText(e, action + ' failed') }); }
        return res.json({ success: true });
      }
      let message = req.body && req.body.message;
      message = typeof message === 'string' ? message.trim().slice(0, 200) : '';
      const args = ['-C', root, 'stash', 'push'];
      if (message) args.push('-m', message);
      try { await spawnRead('git', args); }
      catch (e) { return res.status(400).json({ error: gitErrText(e, 'stash failed') }); }
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/stash/pop', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const ref = req.body && req.body.ref;
      const args = ['-C', root, 'stash', 'pop'];
      if (ref !== undefined && ref !== null && ref !== '') {
        if (typeof ref !== 'string' || !/^stash@\{\d+\}$/.test(ref)) {
          return res.status(400).json({ error: 'invalid stash ref' });
        }
        args.push(ref);
      }
      try { await spawnRead('git', args); }
      catch (e) { return res.status(400).json({ error: gitErrText(e, 'pop failed') }); }
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // Discard unstaged worktree changes (VS Code "discard" semantics:
  // restores worktree from the index, staged entries untouched).
  app.post('/api/git/discard', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const rels = gitFileArgs(root, req.body && req.body.files);
      await spawnRead('git', ['-C', root, 'restore', '--', ...rels]);
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/init', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const dir = resolvePath(req.body && req.body.path);
      let st;
      try { st = await fsPromises.stat(dir); } catch { return res.status(400).json({ error: 'directory not found' }); }
      if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
      try { await spawnRead('git', ['-C', dir, 'rev-parse', '--show-toplevel']); }
      catch { await spawnRead('git', ['-C', dir, 'init']); return res.json({ success: true }); }
      res.json({ success: true, already: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Git identity (commit author) ────────────────────────────────────
  async function gitIdentityFor(root) {
    let name = '', email = '';
    try { name = (await spawnRead('git', ['-C', root, 'config', 'user.name'])).trim(); } catch {}
    try { email = (await spawnRead('git', ['-C', root, 'config', 'user.email'])).trim(); } catch {}
    return { name, email };
  }

  app.get('/api/git/identity', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      res.json({ success: true, ...(await gitIdentityFor(root)) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/identity', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const clean = v => {
        if (typeof v !== 'string') return '';
        const t = v.trim().slice(0, 100);
        if (!t || /[\x00-\x1f\x7f]/.test(t)) { const e = new Error('invalid identity value'); e.status = 400; throw e; }
        return t;
      };
      const name = clean(req.body && req.body.name);
      const email = clean(req.body && req.body.email);
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'name and a valid email are required' });
      }
      await spawnRead('git', ['-C', root, 'config', 'user.name', name]);
      await spawnRead('git', ['-C', root, 'config', 'user.email', email]);
      res.json({ success: true, name, email });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Git fetch / amend / reset ───────────────────────────────────────
  app.post('/api/git/fetch', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      let out = '';
      try { out = await spawnRead('git', ['-C', root, 'fetch', '--all'], { timeout: 60000 }); }
      catch (e) { return res.status(gitErrStatus(e)).json({ error: gitErrText(e, 'fetch failed', 1000) }); }
      res.json({ success: true, output: out.slice(-5000) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/amend', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      try { await spawnRead('git', ['-C', root, 'rev-parse', '--verify', 'HEAD']); }
      catch { return res.status(400).json({ error: 'nothing to amend (no commits yet)' }); }
      const raw = req.body && req.body.message;
      const args = ['-C', root, 'commit', '--amend'];
      if (typeof raw === 'string' && raw.trim()) args.push('-m', raw.trim().slice(0, 1000));
      else args.push('--no-edit');
      try {
        await spawnRead('git', args);
      } catch (e) { return res.status(400).json({ error: gitErrText(e, 'amend failed') }); }
      let hash = '';
      try { hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).trim(); } catch {}
      res.json({ success: true, hash });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // Verify a reset/show target resolves to a commit (returns full hash).
  // Accepts HEAD family + full/short hex. Arg-array only — no shell involved.
  async function assertCommitRef(root, ref) {
    const r = typeof ref === 'string' ? ref.trim() : '';
    if (!r || r.length > 100 || (!/^[0-9a-f]{4,40}$/i.test(r) && !/^HEAD([~^]\d*)*$/.test(r))) {
      const e = new Error('invalid ref'); e.status = 400; throw e;
    }
    try {
      const hash = (await spawnRead('git', ['-C', root, 'rev-parse', '--verify', r + '^{commit}'])).trim();
      if (!/^[0-9a-f]{40}$/i.test(hash)) throw new Error('bad ref');
      return hash;
    } catch {
      const e = new Error('ref does not resolve to a commit'); e.status = 400; throw e;
    }
  }

  app.post('/api/git/reset', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const mode = req.body && req.body.mode;
      if (!['mixed', 'soft', 'hard'].includes(mode)) return res.status(400).json({ error: 'mode must be mixed, soft or hard' });
      const hash = await assertCommitRef(root, (req.body && req.body.ref) || 'HEAD');
      try {
        await spawnRead('git', ['-C', root, 'reset', '--' + mode, hash]);
      } catch (e) { return res.status(400).json({ error: gitErrText(e, 'reset failed') }); }
      res.json({ success: true, mode, hash: hash.slice(0, 7) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Git tags ────────────────────────────────────────────────────────
  async function assertSafeTag(root, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || name.trim().startsWith('-')) {
      const e = new Error('invalid tag name'); e.status = 400; throw e;
    }
    try {
      await spawnRead('git', ['-C', root, 'check-ref-format', 'refs/tags/' + name.trim()]);
    } catch {
      const e = new Error('invalid tag name'); e.status = 400; throw e;
    }
    return name.trim();
  }

  app.get('/api/git/tags', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const raw = await spawnRead('git', ['-C', root, 'tag', '--list', '--sort=-creatordate']);
      res.json({ success: true, tags: raw.split('\n').map(t => t.trim()).filter(Boolean).slice(0, 50) });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/tag', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const name = await assertSafeTag(root, req.body && req.body.name);
      const msg = req.body && req.body.message;
      const args = ['-C', root, 'tag'];
      if (typeof msg === 'string' && msg.trim()) args.push('-a', '-m', msg.trim().slice(0, 500));
      args.push('--', name);
      try {
        await spawnRead('git', args);
      } catch (e) { return res.status(400).json({ error: gitErrText(e, 'tag failed') }); }
      res.json({ success: true, name });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/untag', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      const name = await assertSafeTag(root, req.body && req.body.name);
      try {
        await spawnRead('git', ['-C', root, 'tag', '-d', '--', name]);
      } catch (e) { return res.status(400).json({ error: gitErrText(e, 'delete tag failed') }); }
      res.json({ success: true, name });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Git show (commit detail) ────────────────────────────────────────
  app.get('/api/git/show', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const hash = await assertCommitRef(root, req.query.ref || req.query.hash);
      const args = ['-C', root, 'show', '--no-color', '--find-renames', '--format=fuller', hash];
      if (req.query.file && typeof req.query.file === 'string') {
        const [rel] = gitFileArgs(root, [req.query.file]);
        args.push('--', rel);
      }
      let out = await spawnRead('git', args, { timeout: 15000, maxBytes: 400000 });
      const binary = out.includes('Binary files');
      const truncated = out.length > 200000;
      if (truncated) out = out.slice(0, 200000);
      res.json({ success: true, hash, diff: out, binary, truncated });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Per-File Commit Log ─────────────────────────────────────────────
  app.get('/api/git/file-log', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const file = req.query.file;
      if (!file || typeof file !== 'string' || Array.isArray(file)) return res.status(400).json({ error: 'file is required' });
      const [rel] = gitFileArgs(root, [file]);
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 40));
      const raw = await spawnRead('git', ['-C', root, 'log', '--follow', '-n', String(limit), '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--date=short', '--', rel]);
      const commits = raw.split('\n').filter(Boolean).map(l => {
        const [hash, short, author, date, ...subj] = l.split('\x1f');
        return { hash, short, author, date, subject: subj.join('\x1f') };
      });
      res.json({ success: true, commits, file: rel, root });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // ── Git hunks (per-hunk stage / unstage) ────────────────────────────
  // The client only ever sends a hunk *index*; the server re-derives the patch
  // from a fresh diff, so forged patch content can never be applied.
  const HUNK_HEAD_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
  function splitDiffHunks(raw) {
    const lines = (raw || '').split('\n');
    const header = [];
    const hunks = [];
    let cur = null;
    for (const line of lines) {
      if (HUNK_HEAD_RE.test(line) && line.startsWith('@@')) {
        cur = { header: line, lines: [] };
        hunks.push(cur);
      } else if (cur) cur.lines.push(line);
      else header.push(line);
    }
    return { header, hunks };
  }
  function hunkPatchText(headerLines, hunk) {
    return headerLines.join('\n') + '\n' + hunk.header + '\n' + hunk.lines.join('\n');
  }
  async function gitHunksFor(root, file, cached) {
    const abs = path.resolve(root, file);
    if (!pathContained(root, abs)) { const e = new Error('file outside repo'); e.status = 400; throw e; }
    const rel = path.relative(root, abs) || '.';
    if (rel === '.' || rel === '..' || rel.startsWith('..' + path.sep)) { const e = new Error('invalid file path'); e.status = 400; throw e; }
    const args = ['-C', root, 'diff', '--no-color', '-U3'];
    if (cached) args.push('--cached');
    args.push('--', rel);
    const raw = await spawnRead('git', args, { timeout: 15000 });
    if (!raw.trim()) { const e = new Error(cached ? 'no staged changes for this file' : 'no unstaged changes for this file (untracked files must be staged whole)'); e.status = 400; throw e; }
    if (raw.length > 200000) { const e = new Error('diff too large for hunk view — use the full file diff'); e.status = 400; throw e; }
    const { header, hunks } = splitDiffHunks(raw);
    if (!hunks.length) { const e = new Error('no hunks found (binary file?)'); e.status = 400; throw e; }
    if (hunks.length > 200) { const e = new Error('too many hunks for hunk view — use the full file diff'); e.status = 400; throw e; }
    return { header, hunks };
  }

  app.get('/api/git/hunks', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.query.path);
      const file = req.query.file;
      if (!file || typeof file !== 'string' || Array.isArray(file)) return res.status(400).json({ error: 'file is required' });
      const { hunks } = await gitHunksFor(root, file, req.query.cached === '1');
      res.json({
        success: true,
        hunks: hunks.map((h, i) => {
          let added = 0, deleted = 0;
          for (const l of h.lines) {
            if (l.startsWith('+') && !l.startsWith('+++')) added++;
            else if (l.startsWith('-') && !l.startsWith('---')) deleted++;
          }
          const preview = h.lines.slice(0, 120);
          return { index: i, header: h.header, added, deleted, lines: preview, truncated: h.lines.length > preview.length };
        })
      });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // The client sends the hunk header it rendered. Indices shift whenever the
  // working tree changes, so an index alone could stage a *different* hunk than
  // the one the user clicked; the header pins down which hunk was meant.
  async function applyHunk(root, file, index, unstage, expectedHeader) {
    const { header, hunks } = await gitHunksFor(root, file, unstage);
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) { const e = new Error('invalid hunk index'); e.status = 400; throw e; }
    const expected = typeof expectedHeader === 'string' ? expectedHeader.trim() : '';
    let target = i;
    if (expected) {
      const matches = [];
      for (let n = 0; n < hunks.length; n++) if (hunks[n].header.trim() === expected) matches.push(n);
      if (!matches.length) {
        const e = new Error('hunk changed on disk — refresh and retry');
        e.status = 409;
        throw e;
      }
      // Prefer the original position when it still holds the same hunk, otherwise
      // apply the hunk the user actually saw at its new index.
      target = matches.includes(i) ? i : matches[0];
    } else if (i >= hunks.length) {
      const e = new Error('invalid hunk index'); e.status = 400; throw e;
    }
    const patch = hunkPatchText(header, hunks[target]);
    const args = ['-C', root, 'apply', '--cached'];
    if (unstage) args.push('--reverse');
    args.push('-');
    try {
      await spawnRead('git', args, { input: patch });
    } catch (e) {
      const msg = gitErrText(e, '', 500);
      throw Object.assign(new Error(msg.includes('patch does not apply') || !msg ? 'hunk no longer applies — refresh and retry' : msg), { status: 400 });
    }
  }

  app.post('/api/git/stage-hunk', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      if (!req.body || typeof req.body.file !== 'string') return res.status(400).json({ error: 'file is required' });
      await applyHunk(root, req.body.file, req.body.index, false, req.body.expected);
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/git/unstage-hunk', rateLimiter, checkPin, async (req, res) => {
    try {
      if (!gitAvailable()) return res.status(501).json({ error: 'git not installed' });
      const root = await gitRootFor(req.body && req.body.path);
      if (!req.body || typeof req.body.file !== 'string') return res.status(400).json({ error: 'file is required' });
      await applyHunk(root, req.body.file, req.body.index, true, req.body.expected);
      res.json({ success: true });
    } catch (e) {
      sendErr(res, e);
    }
  });



}

module.exports = { registerGitRoutes };

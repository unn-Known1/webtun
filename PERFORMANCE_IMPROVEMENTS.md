# WebTun — Performance Improvement Suggestions

**Baseline:** v2.3.7 (commit `2d2ff5d`)  
**Audit date:** 2026-10-30  
**Scope:** Backend (`server.js`, `lib/`), frontend (`public/js/`, `public/sw.js`), Electron host (`electron/main.js`), delivery/build pipeline.  
**Method:** Static review of hot paths, I/O patterns, timers, rendering, memory lifecycle, and asset delivery. No code was changed; this document is a suggestion backlog.

> Severity reflects expected user-visible impact (latency, jank, memory, throughput) on a typical self-hosted instance. Effort is a rough engineering estimate.

---

## 1. Executive summary

WebTun is already reasonably well-optimized in several places: async `spawnRead` for Git, batched directory stats, WebSocket back-pressure for PTY output, memoized system-stats fetches, DOM-node reuse in the file list, and a service worker. The highest-value remaining opportunities are:

1. **No HTTP compression** for static assets or API responses — every JS/CSS payload ships uncompressed.
2. **System stats sampling sleeps 100 ms on every cache miss**, serializing concurrent callers.
3. **Blocking process inspection** (`execFileSync`/`fs.readFileSync('/proc')`) in `/api/sessions` and cwd resolution.
4. **Regex search spawns a fresh Worker thread per request.**
5. **Frontend polling is fragmented** across ~15 independent timers with no central pause/resume on tab visibility.
6. **File list rendering and sorting do repeated per-item work** (`querySelector`, `new Date` in comparators, eager thumbnail fetches).

---

## 2. Findings

### A. Backend — event loop & I/O

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-001 | High | `server.js` `/api/system` | CPU usage is measured by sleeping 100 ms inside the request handler (`await new Promise(r => setTimeout(r, 100))`). Every cache miss (2 s TTL) blocks that request for 100 ms; concurrent misses serialize on the event loop. |
| P-002 | Medium | `lib/server/terminal.js` | `/api/sessions` and `/api/sessions/:id/cwd` call `resolvePtyCwd()`, which shells out to `ps`/`lsof` and reads `/proc/*/stat` **synchronously** per session. With many sessions this blocks the event loop. |
| P-003 | Medium | `lib/server/terminal.js` | `findExternalShellProcesses()` runs `ps` and walks process trees on every sessions list when tmux is unavailable. No caching/TTL. |
| P-004 | Medium | `lib/server/regex-search.js` | A new `Worker` thread (plus 32 MB heap limit) is created and terminated for every regex search. Worker startup cost dominates for small files. |
| P-005 | Medium | `lib/cloudflared.js` | SHA-256 of the downloaded cloudflared binary is computed with `crypto.createHash(...).update(fs.readFileSync(tmp))`, buffering the whole binary (~50 MB) in memory. |
| P-006 | Medium | `lib/server/audit.js` | `saveAudit()` does a full `JSON.stringify` + atomic rename of up to 2000 entries on **every** audit event. |
| P-007 | Low-Med | `server.js` history | `saveCmdHistory()` rewrites the entire `.cmdhist.json` on every command save. |
| P-008 | High | `server.js` | No response compression. `express.static` and JSON responses are sent raw; JS/CSS payloads are large (e.g. `terminal.js` 114 KB). |
| P-009 | Low | `lib/server/auth.js` | `prunePreviewFileTokens` / `mintPreviewFileToken` iterate the whole token map on every mint; fine at current caps (200) but O(n) per request. |
| P-010 | Low | `server.js` rate limiter | Behind a tunnel all clients share IP `127.0.0.1`, so the per-IP bucket is effectively global (documented). Multi-tenant fairness would need per-token buckets. |

**Recommendations**

- **P-001:** Store two consecutive CPU samples in `_sysStatsCache` and compute the delta from the previous sample instead of sleeping. Or compute stats in a background `setInterval` (unref'd) and serve the cached result.
- **P-002/P-003:** Cache `resolvePtyCwd(pid)` results with a short TTL (e.g. 2 s) keyed by pid; invalidate on session delete. Move process inspection to async `spawnRead` where possible.
- **P-004:** Keep a single long-lived worker (or a small pool) and post messages; terminate on process exit.
- **P-005:** Stream the file through `fs.createReadStream` + `hash.update` in chunks.
- **P-006/P-007:** Debounce persistence (e.g. 250–500 ms trailing) or batch writes; flush on process exit.
- **P-008:** Add a lightweight gzip middleware using Node's built-in `zlib` (or `compression` if added). Pre-compress vendored assets at build time and serve `.gz` via `Accept-Encoding`.

### B. Terminal & WebSocket

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-011 | Low | `lib/server/terminal.js` | `drainCheck` runs a 50 ms `setInterval` for the entire session lifetime, even when not paused. |
| P-012 | Medium | `public/js/terminal.js` | `processTerminalOutput()` does per-character OSC/DCS parsing in JavaScript for every chunk. Large bursts (e.g. `cat` of a big file) spend significant main-thread time. |
| P-013 | Low | `public/js/terminal.js` | Each WS message calls `tab.term.write()` separately; batching small chunks into one write per animation frame would reduce xterm reflow cost. |
| P-014 | Low | `public/js/terminal.js` | `ws.onmessage` awaits `e.data.arrayBuffer()` for Blobs, adding an async hop per message. |

**Recommendations**

- Gate `drainCheck` so it only schedules while paused; clear otherwise.
- Fast-path chunks that contain no ESC (`\x1b`): skip the parser and call `term.write` directly.
- Accumulate small writes and flush with `requestAnimationFrame` (or xterm's built-in write callback) when the queue is small.
- Prefer `ArrayBuffer` messages from the server (already used) and avoid Blob handling on the client.

### C. File system & search

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-015 | Low | `lib/server/files.js` | Windows drive-root listing awaits `fsPromises.access` for each of 26 drives **sequentially**. |
| P-016 | Medium | `public/js/files.js` | Up to 48 thumbnails per directory are fetched eagerly (budget `_thumbBudget = 48`), even for off-screen rows. |
| P-017 | Medium | `public/js/files.js`, `editor-panel.js` | Directory/editor change detection polls every 10 s (`setInterval`). No server-side push (`fs.watch`/WebSocket). |
| P-018 | Low | `lib/server/files.js` | `asyncSafeWalk` computes `realpath` for every visited directory; cheap but adds latency on network filesystems. |
| P-019 | Low | `public/js/files.js` | `sortFiles` constructs `new Date(f.modified)` inside the comparator, re-parsing the same dates O(n log n) times. |

**Recommendations**

- Parallelize drive access with `Promise.all`.
- Lazy-load thumbnails with `IntersectionObserver`; revoke blob URLs on unmount.
- Add an optional `fs.watch`-based push channel (or reuse the WS binary protocol with a new event type) and fall back to polling when unavailable.
- Precompute sort keys once per file before sorting.

### D. Git integration

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-020 | Medium | `lib/server/git.js` | `GET /api/git/status` has a 20 s timeout and runs `git status --porcelain` on the whole repo; very large repos stall the panel. |
| P-021 | Low | `lib/server/git.js` | `gitRootFor()` shells out on every request; the repo root for a given directory could be cached briefly. |
| P-022 | Low | frontend `git.js` | Status/diff polling and manual refresh both re-fetch full payloads; no ETag/conditional requests. |

**Recommendations**

- Cap/timeout status queries earlier (e.g. 5 s) and surface "large repo" state.
- Cache repo root per resolved path with a short TTL.
- Consider `If-None-Match`/`ETag` or a monotonic "git state" token to skip unchanged responses.

### E. Frontend rendering & DOM

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-023 | Medium | `public/js/files.js`, `tabs.js`, `misc.js` | Hot render paths call `document.getElementById` repeatedly (1000+ call sites across `public/js`). Each is a DOM lookup. |
| P-024 | Medium | `public/js/files.js` | File rows reuse DOM nodes but still run multiple `querySelector` calls per item to update name/icon/meta. |
| P-025 | Medium | `public/js/file-tabs.js` | Every text file tab owns a full CodeMirror instance (`tab.cm`). With 10 tabs this is significant memory. |
| P-026 | Medium | `public/js/viewers.js` | PDF/EPUB/Office viewers render whole documents; no page-level virtualization. |
| P-027 | Medium | `public/js/files.js` | No virtualization for directories with thousands of entries; full DOM is built. |

**Recommendations**

- Cache element references in module-level variables or pass them through render functions.
- Store per-row sub-element references when creating nodes to avoid repeated `querySelector`.
- Lazily create CodeMirror instances only when a tab becomes active; destroy on close.
- Virtualize long lists (windowed rendering) and paginate document viewers.

### F. Polling & timers

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-028 | Medium | `public/js/*` | ~15 independent `setInterval` timers (sys icon 10 s, sys stats 5 s, launchpad pulse 5 s, file watch 10 s, editor watch 10 s, preview health, terminal sessions 4 s, etc.). They fire even when their feature is inactive. |
| P-029 | Low | `public/js/core.js` | Offline retry polls every 15 s while disconnected. |
| P-030 | Low | `public/js/misc.js` | System icon pulse continues at 10 s even when data saver is on (guarded) but still scheduled. |

**Recommendations**

- Introduce a central scheduler that registers timers with a key and pauses all of them when `document.hidden` is true; resume on visibility.
- Make each timer self-clear when its modal/panel is closed (some already do; standardize).

### G. Memory & resources

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-031 | Low | `public/js/files.js` | Thumbnail blob URLs are revoked after 10 s (`setTimeout`), not on unmount; rapid navigation can accumulate. |
| P-032 | Low | `public/js/terminal.js` | `_termDecoder` and per-tab buffers persist for closed tabs until GC; `closeTab` should explicitly null references. |
| P-033 | Low | `lib/server/audit.js` | Audit entries (up to 2000) held in memory indefinitely; acceptable but grows with usage. |

**Recommendations**

- Revoke blob URLs immediately when the owning row/tab is removed.
- Ensure `closeTab`/`cleanup` nulls large per-tab state (already partially done; audit for completeness).
- Consider capping in-memory audit buffer and paging from disk.

### H. Network & delivery

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-034 | Medium | `public/sw.js` | Service worker precaches **all** JS including large viewers on install, delaying first offline readiness. |
| P-035 | Low | `public/index.html` | CDN scripts (xterm, CodeMirror) are deferred; on slow links terminal init waits for CDN. Self-hosting critical vendor files would improve cold start. |
| P-036 | Low | `electron/main.js` | Log rotation reads the entire log file into memory (`fs.readFileSync(lp)`) before slicing the tail. |

**Recommendations**

- Split precache into critical shell vs. lazy viewer chunks; cache viewers on first use.
- Vendor the critical terminal stack locally (already done for xterm) and keep optional viewers on CDN with lazy loading.
- Read only the tail of the log via `fs.readSync` with an offset.

### I. Persistence & storage

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-037 | Low | `public/js/editor-buffers.js` | Draft autosave writes `localStorage` 2 s after edits; on low-end devices frequent stringification can cause jank for large files. |
| P-038 | Low | `public/js/core.js` | `localStorage` access is wrapped in `safeStorage`, but each call still hits storage; batching settings writes would reduce overhead. |

---

### J. Additional gaps identified on review

| ID | Sev | Area | Finding |
|---|---|---|---|
| P-039 | Medium | `public/css/styles.css` | 30 `backdrop-filter: blur(...)` usages plus 54 animations and 189 transitions. Backdrop blur forces expensive repaints on every scroll/resize, especially on low-end/mobile GPUs. No `content-visibility` is used anywhere. |
| P-040 | Low | `public/js/*` | Only 4 `<img>` elements are created in JS and none set `decoding="async"` or `loading="lazy"`; thumbnail images decode on the main thread and compete with terminal I/O. |
| P-041 | Low | `public/js/files.js` | `timeAgo()` allocates a `Date` per file during render, and `sortFiles` uses `localeCompare` for the tie-break plus `new Date` in the comparator. Both are avoidable per-item overhead. |
| P-042 | Low | `public/css/styles.css` | No `content-visibility: auto` on long lists/panels, so off-screen rows still participate in layout/paint. |
| P-043 | Medium | `server.js`, `lib/` | `server.js` is 1594 lines and eagerly requires every subsystem (cloudflared, SSH, tunnels, license) at startup, even when unused. Lazy `require()` on first use would shorten cold start and reduce memory. |
| P-044 | Low | terminal/tmux | xterm scrollback and tmux `history-limit` are not tuned; long-running sessions accumulate scrollback memory. |
| P-045 | Medium | `lib/server/files.js` image endpoint | `/api/files/image` streams files but sends no `ETag`/`Last-Modified` and no Range support, so re-fetching the same thumbnail (e.g. after navigation) re-transfers bytes. |
| P-046 | Low | `lib/server/files.js` | Directory listing always `stat`s every entry for size/mtime. Where `dirent` already reports type, skip the extra `lstat` for non-symlinks (size/mtime still need one stat, but symlink handling can be tightened). |
| P-047 | Low | `public/js/misc.js`, `ui.js` | Frequent small `localStorage` writes (settings, drafts) are not batched; on quota-limited browsers each write is synchronous. |

## 3. Quick wins (1–2 days)

1. Add gzip/brotli compression for static + API responses (P-008).
2. Remove the 100 ms sleep from `/api/system` (P-001).
3. Cache `resolvePtyCwd` results (P-002).
4. Precompute sort keys in `sortFiles` (P-019).
5. Fast-path terminal chunks with no ESC (P-012).
6. Parallelize Windows drive access (P-015).
7. Gate `drainCheck` interval on paused state (P-011).
8. Add `decoding="async"` (and `loading="lazy"` where appropriate) to thumbnail images (P-040).
9. Replace `localeCompare` tie-break with a cheaper string compare and precompute `timeAgo` results (P-041).
10. Add `content-visibility: auto` to long lists (P-042).

## 4. Medium-term (1–2 weeks)

1. Debounce audit/history persistence (P-006, P-007).
2. Reuse a worker for regex search (P-004).
3. Stream cloudflared checksum (P-005).
4. Lazy thumbnail loading via `IntersectionObserver` (P-016).
5. Central timer scheduler with visibility pause (P-028).
6. Cache Git repo roots and add conditional responses (P-021, P-022).
7. Lazy CodeMirror instantiation for inactive file tabs (P-025).
8. Lazy-require heavy subsystems (cloudflared, SSH) to reduce cold start (P-043).
9. Add ETag/Range support to image endpoint (P-045).
10. Reduce backdrop-filter usage / gate blur on low-end devices (P-039).

## 5. Longer-term

1. Virtualized file list and document viewers (P-027, P-026).
2. `fs.watch`-based file change push instead of polling (P-017).
3. Split service-worker precache into critical/lazy (P-034).
4. Per-token rate limiting for tunneled multi-user instances (P-010).
5. Tune terminal scrollback and tmux history limits (P-044).
6. Batch `localStorage` writes (P-047).

## 6. Measurement plan

Before implementing, capture baselines so improvements can be verified:

- **Backend:** Node `--prof` / `clinic.js` flame graphs on `/api/files`, `/api/system`, `/api/sessions` under load; measure event-loop lag with `perf_hooks.monitorEventLoopDelay`.
- **Frontend:** Chrome Performance panel; record Long Tasks, layout/paint time, and memory snapshots while opening large directories and running `cat` in the terminal.
- **Network:** Lighthouse (Performance, PWA) against `http://localhost:3000`; compare transfer sizes with/without compression.
- **Memory:** Heap snapshots before/after opening 10 file tabs and 48 thumbnails.

## 7. Intentional / out of scope

The following are deliberate product decisions (per `AGENTS.md`) and should **not** be "optimized" away:

- Full-filesystem access by default (`ALLOW_FULL_FS=true`).
- Token in URL for WebSocket/`img`/`iframe` endpoints (required for subresources).
- Empty PIN meaning no auth.
- No bundler/minifier in the dev workflow (zero-build philosophy). Any minification should be an optional production step, not a dev-time requirement.

---

*Generated from static review of the v2.3.7 working tree. Line numbers are approximate; verify against the current source before implementing.*
", "path": "PERFORMANCE_IMPROVEMENTS.md"}
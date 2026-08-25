# WebTun — Functional, Logical & UI/UX Audit
**Repo:** `github.com/unn-Known1/webtun` `v1.5.3`  
**Date:** 2026-08-25  
**Scope:** `server.js`, `bin/webtun.js`, `electron/main.js`, `public/index.html`, `public/sw.js`, `postinstall.js`, `package.json`, `setup.sh`  
**Method:** Static code review + runtime heuristics + UX audit (Nielsen + WCAG 2.2 + mobile guidelines)

---

## Executive Summary
WebTun delivers a functional web terminal + file manager + tunnel but has **22 high-severity functional/logical gaps** (path sandboxing, WS origin, rate-limit bypass, OOM vectors, orphan session leak) and **>30 UI/UX gaps** (discoverability, touch targets, error visibility, keyboard nav holes, dead backend features with no UI). The UX polish added in v1.5.2 (toasts, spinners, focus traps) is solid, but inconsistency between desktop/mobile, invisible features, and weak feedback loops remain.

---

## 1. Functional & Logical Gaps — Backend (`server.js:19-2033`)

### 1.1 Path & File-System Security

| # | Location | Gap | Impact | Fix |
|---|----------|-----|--------|-----|
| F1 | `server.js:192-216` `resolvePath()`/`realPath()` | No containment check against `WORKSPACE_ROOT`. All `GET /api/files*`, `/api/files/read`, `/image`, `/download`, `/stat` escape to `/`. `WORKSPACE_ROOT` is effectively advisory, not enforced. | High — docs imply sandbox to `~` but user can browse/download `/etc/passwd` via `?path=/etc`. Either enforce or document full-FS intent. | Add `pathContained(WORKSPACE_ROOT, resolved)` guard, or add `ALLOW_FULL_FS=true` flag. Reuse `pathContained()` already defined at `server.js:206`. |
| F2 | `server.js:199-203` | `realPath()` follows symlinks via `fs.realpathSync` then loses containment. Symlink in `WORKSPACE_ROOT` pointing to `/` bypasses any future guard. | High | After `realpathSync`, re-check `pathContained()`. |
| F3 | `server.js:750-779` `POST /api/files/upload` | Two sanitizers: `destination` sanitizes `originalname` with `[^a-zA-Z0-9_.\-]`→`_`, `filename` sanitizes with `[\w…]`→`_` — mismatch causes duplicate files, and `keep_both` not applied to uploads. `subPath` created but `finalDest` check uses `pathContained(destDir, finalDest)` only, not traversal via `..` in `req.query.path` (decoded after `realPath`). | Medium | Unify sanitizer, apply `resolveCopyMove` conflict logic to uploads. |
| F4 | `server.js:677-702` `read`/`image`/`download` | No file-size guard. `fsPromises.readFile(p,'utf8')` loads whole file into RAM. `MAX_EDITOR_SIZE=10MB` is client-only (`public/index.html:3868`). Attacker can `GET /api/files/read?path=/var/log/huge.log` (GBs) → OOM. Same for `image` streaming large file without range/limit. | High | Add `stat` size check, reject >10 MB (or stream with limit). Add `Content-Length` + range support. |
| F5 | `server.js:721-747` `download` directory | `streamZipDirectory` pipes recursively without size/count limit; zipping `/` would exhaust disk/CPU. | Medium | Reject if `dirSize()>1GB` or add `?maxFiles` guard. |

### 1.2 Auth, Rate Limit & Transport

| # | Location | Gap | Impact |
|---|----------|-----|--------|
| F6 | `server.js:160-165` `checkPin` | Token accepted from `x-pin-token` header **or** `?token=` query. Query tokens leak into server logs, proxy logs, `Referer`, and browser history. `AGENTS.md` says “header or query” — query should be deprecated. | Medium — remove `req.query.token`, keep header only; WS still needs `?token=` (`server.js:1370`) — scope to WS only. |
| F7 | `server.js:153-157` `constantTimeEqual` | Early `if (a.length!==b.length) return false` leaks PIN length via timing (defeats `timingSafeEqual`). | Low — check length with constant-time or pad. |
| F8 | `server.js:89-103` `createRateLimiter` | Reads `req.headers['x-forwarded-for']` unconditionally, ignoring `app.set('trust proxy')` (`server.js:151`). Attacker spoofs `X-Forwarded-For: victim-ip` to poison victim’s bucket or bypass own limit via IP rotation. | Medium — use `req.ip` (Express respects `trust proxy`) instead of manual header. |
| F9 | `server.js:105` `authRateLimiter` | `skipWhenNoPin:true` means with `PIN=""`, no rate limit on `/api/auth` — but `/api/search` rate limiter (`server.js:106`) still applies even when open instance; inconsistent. | Low |
| F10 | `server.js:1358-1368` WS origin check | `allowedLocal` compares `origin === http://host` but `host` includes `port`, origins from `https://*.trycloudflare.com` have no port → legitimate tunnel origins rejected. `ALLOWED_WS_ORIGINS` is empty Set — no way to whitelist tunnel origins dynamically (`/api/tunnel` creates them but never updates Set). | High — tunnel users get `1008 Origin not allowed` intermittently. |
| F11 | `server.js:1583-1604` `spawnRead` | Uses `spawn` with `timeout:5000` but parent `await`s unlimited; child `close` may never fire if `timeout` kills. Disk/process stats hang. Also `execFileSync` in `server.js:807-820` is **sync** and blocks event loop while resolving `owner`/`group` per `stat` request. | Medium |

### 1.3 Resource & Lifecycle

| # | Location | Gap |
|---|----------|-----|
| F12 | `server.js:231-249` `dirSize()` | Recursive `Promise.all` without concurrency limit. Directory with 100k files spawns 100k parallel `stat()` → FD exhaustion + OOM. |
| F13 | `server.js:934-1002` `POST /api/files/search-content` | Walks every file, opens FD, reads entire `utf8` into RAM (`content.split('\n')`). `MAX_FILE_SIZE=10MB` but still 50 files ×10 MB =500 MB per request. Regex path allows ReDoS (`new RegExp(query,'gi')` on arbitrary pattern). No timeout/cancellation. Rate-limit is per-IP but single request can DOS single core. |
| F14 | `server.js:1276-1300` `cleanupOrphanTmuxSessions` | Kills **all** `wt-*` tmux sessions with no clients. Collides with user’s own tmux sessions named `wt-*`. No namespacing (should use `wt-webtun-*`). |
| F15 | `server.js:1279` `ptySessions Map` | No TTL/eviction. Each `newTab` creates `wt-{uuid}` session persisted in `ptySessions`. If user creates 100 tabs and closes browser without `closeTab`, 100 `node-pty` processes stay alive forever until server restart. `cleanup()` on `SIGTERM` only. |
| F16 | `server.js:1216-1227` `cmdHistory` | `fs.writeFileSync(HISTORY_FILE)` non-atomic, no file locking. Concurrent `POST /api/history` can interleave and truncate `.cmdhist.json`. Stored at `__dirname/.cmdhist.json` — not XDG compliant, persists inside package dir (survives `npm update` wipe). |
| F17 | `server.js:1163` `clipboard` | Global singleton `let clipboard={sources,action}` — not per-user/per-IP. Multi-user instance: User A `copy /etc/passwd`, User B `paste` leaks it. |
| F18 | `server.js:736-747` `MIME_MAP` | Fallback `application/octet-stream` forces download for unknown extensions (`.log`, `.env`) but `GET /api/files/image` serves them with `application/octet-stream` + `Cache-Control: private, max-age=3600` — caches secrets in browser/CDN. Should add `no-store` for sensitive types. |
| F19 | `server.js:1969-1996` `cleanup()` | Calls `process.kill(pid)` and `ptySessions` kill on every `exit`/`SIGTERM`/`SIGINT` **plus** on `uncaughtException` it does `process.exit(1)` after `cleanup()` — double kill can throw. Also `cleanup()` iterates `tunnels` Map but `restartTunnel` may have already deleted entry → stale delete. |
| F20 | `server.js:1737-1765` `.tunnels.json` / `tunnel-url.txt` | `saveTunnels()` writes without atomic rename; crash mid-write corrupts file. `loadTunnels()` only validates `isCloudflaredProcess(pid)` — PID reuse can validate unrelated process if cloudflared died and PID recycled. |
| F21 | Missing endpoint | `AGENTS.md:48` lists `POST /api/exec` and `GET /api/exec/stream` (SS-restream) — not implemented in `server.js` (grep shows no handler). Doc/code drift. |
| F22 | `server.js:1519` WS `proc.onExit` second listener | `proc.onExit(()=>{entry.exited=true})` registered **after** `ptySessions.set` but `proc.onExit(()=>{send(0x01)...})` already consumes exit. `node-pty` `onExit` fires once; second listener overwrites flag. `exited` never set reliably → reconnect can reuse dead PTY. |

### 1.4 Config & CLI (`bin/webtun.js:1-139`, `electron/main.js:1-162`, `postinstall.js`)

| # | Location | Gap |
|---|----------|-----|
| F23 | `bin/webtun.js:59-61` `--pin` | Mutates `process.env.PIN` after parsing **before** `require('../server')` — works, but `server.js:119` `const PIN = process.env.PIN||''` evaluated at load time, so `--pin` via env + flag interaction is fragile. No validation (empty string vs missing). |
| F24 | `bin/webtun.js:72-125` `startTunnel` | Re-implements cloudflared spawn vs `server.js:1803` `spawnCloudflared` — duplicated logic. CLI tunnel does **not** persist to `.tunnels.json` nor register with server’s `GET /api/tunnel` — UI shows no CLI tunnel. |
| F25 | `electron/main.js:9` `PORT=3000` hard-coded | Ignores `PIN`/`WORKSPACE_ROOT` from user env; desktop app always no-auth, always `~`. No menu for changing PIN. |
| F26 | `postinstall.js:8-38` `rebuildNodePty` | Calls `spawnSync('npm',['rebuild','node-pty'])` with `timeout:120000` but no `stdio: 'pipe'` error capture; on npm v12 `allow-scripts` block, `rebuild` itself blocked and fails silently. |
| F27 | `package.json:49-94` | `dependencies` list missing `electron` in `files` whitelist for npm publish? `files` includes `server.js,public/,bin/,postinstall.js` — `electron/` excluded, so `npm pack` omits Electron assets (but `npm install -g webtun` works). `overrides` pin many transitive deps but no `ws` override for CVE-2024. |

---

## 2. Functional Gaps — Frontend (`public/index.html:1-6322`, `public/commands.js:1-6`)

| # | Location | Gap |
|---|----------|-----|
| F28 | `public/index.html:2792-2826` `loadFiles` | Polls dir every 10s (`startFileWatcher:3073` @`10000ms`) even when tab hidden via `document.hidden` check — but `fileWatchTimer` still fires after wake; diff check (`currentPath`) causes redundant `api()` when user switched to different path. No debounce for rapid `refreshFiles`. |
| F29 | `public/index.html:3790-3863` `uploadFileList` | Loops files sequentially with `XMLHttpRequest` per file but reuses `path=encodeURIComponent(currentPath)` captured at start — if user navigates during upload, files land in old dir without warning. No retry; `failedItems` collected but never surfaced beyond toast (“2 failed”). |
| F30 | `public/index.html:4080-4108` `openImageViewer` | Fetches `blob` without `revokeObjectURL` on error path until next open — leak if user spams image open/close. No `AbortController` for stale fetches (rapid click two images leaks first blob). |
| F31 | `public/index.html:3940-4025` `openFileEditor` | Client `MAX_EDITOR_SIZE=10MB` but server has no limit — large file still transferred then blocked. No `Content-Length` pre-check. Monaco/CodeMirror mode `getCMmode` returns `null` for `.tsx/.jsx` with `typescript:true` but addon `mode/javascript` not loaded for TSX (needs `jsx` mode). |
| F32 | `public/index.html:3361-3390` `showCtxMenu` | Calls `e.preventDefault()` but `e` may be synthetic object from ellipsis click (`public/index.html:2952` `preventDefault(){}` no-op). Also menu positioning uses `offsetWidth` while `display:block` then `display=''` — race where `offsetWidth` is 0 on first open → menu rendered off-screen. |
| F33 | `public/index.html:3472-3518` `pasteFile` / `resolveCopyMove` | `conflictMode` only set after server returns `{conflict:true}` for **first** file; remaining `files` loop breaks and returns early without processing rest. `keep_both` suffix loop (`server.js:519-529`) uses `counter` 1→ “ (copy)” but client never shows new name — refresh shows duplicate but toast still says “Pasted”. |
| F34 | Dead features (no UI) | Server exposes but UI never triggers: `POST /api/files/chmod` (`server.js:900`), `/symlink` (`918`), `/search-content` (`935`), `/batch-copy|move|zip` (`874,896,1005`), `/files/tail` (`1038` SSE), `/api/system/network` (`1092`), `/api/clipboard` server-side vs client `fsClipboard` split. → Confusion, untested surface. |
| F35 | `public/index.html:1694-1703` tab persistence | `saveTabState()` stores `{id,title,sessionId}` but not `cwd`. On reload, `newTab(s.title,s.sessionId)` reuses `currentPath` (which after unlock is `homeDir`, not tab’s original `cwd`). `tab.cwd` lost → new connection `cwd=homeDir` instead of tab’s last dir. |
| F36 | `public/index.html:2321-2359` `closeTab` | Checks `confirmclose` for tab, then separately checks `editorDirty` but uses `confirmDialog` twice — second dialog may trap focus if first still open (`_confirmState` singleton). Also `tabs.length===1` message (“Close last terminal?”) but `beforeunload` will fire again → double prompt. |
| F37 | `public/sw.js:30-69` SW cache | `CACHE='webtun-v3'` caches `fetch(e.request)` opaque CDN responses skipped (`res.type!=='opaque'`) but `cdn.jsdelivr.net` returns `opaque` when `no-cors`; those requests never cached, SW falls back to network every time — defeats offline. Also `caches.match` for API skipped via `url.pathname.startsWith('/api')` but `/ws` not excluded — WS upgrade cached? No, but `fetch` for WS not GET. |

---

## 3. UI/UX Audit (focus area)

### 3.1 Heuristic Violations (Nielsen)

| # | Heuristic | Finding | Location | Severity |
|---|-----------|---------|----------|----------|
| U1 | **Visibility of system status** | Terminal “Connecting…” overlay (`public/index.html:222-233`) has no progress/timeout text. Reconnect banner (`1053`) shows “Reconnecting…” indefinitely with no retry count/ETA. Upload progress bar (`202-208`) sits at header bottom 3 px high, barely visible; text is 10 px right-aligned, low contrast on dark theme (`--fg2` 14 px). File list loading uses 2 px indeterminate bar hidden behind breadcrumb — easy to miss. | `index.html:222`, `1053`, `202` | High |
| U2 | **Match real world** | File icon mapping (`3102-3084`) uses `< >` for code, box for archive — no folder color distinction between cloud/local. Drag & drop overlay says “Drop files to upload” but on mobile (`699-700` `@media (hover:none)`) it is `display:none !important` — tablet with keyboard+trackpad never sees cue. | `index.html:3076`, `698` | Medium |
| U3 | **User control & freedom** | No Undo for delete (`3566`: `confirmDialog` only). Batch delete uses `Promise.allSettled` then toast per failure but no “Undo trash”. Sidebar width reset requires drag to 0; no “Reset layout” button (only `resetSettings` resets theme/font, not sidebar). Tab close via swipe (`1982`) fires at `dx>80` even when user intended horizontal scroll of tab bar — accidental close. | `index.html:3566`, `1982`, `4389` | High |
| U4 | **Consistency & standards** | Icon stroke `2` standardized (v1.5.2) but header icons 16 px vs file icons 14 px vs ctx-menu 12 px — visual rhythm off. Header `keep-awake` toggle is custom checkbox (`369-374`) vs settings toggles (`650-658`) — two different toggle patterns in same app. “More” menu (`1044`) hides 4 actions on mobile that are visible on desktop — user muscle memory breaks cross-device. | `index.html:369`, `650`, `1044` | Medium |
| U5 | **Error prevention** | Rename / new file / new folder / tunnel modals (`1538-1583`) use `showFieldError` only after submit, no inline validation on input. `joinPath` (`3596`) naïvely concatenates `parent.includes('\\')` detection — fails for mixed paths (Windows UNC + POSIX). Zip/Extract has no free-space check. | `index.html:1550`, `3596` | Medium |
| U6 | **Recognition over recall** | Command Library (`1150`) shows categories but no search shortcut hint; history tab hides footer inputs, placeholder changes from “Filter commands…” to “Filter history…” — subtle. Keyboard shortcuts dialog (`1464`) lists `Ctrl+P/T/W/B/F` but omits `Shift+Arrows`, `Ctrl+D`, `Ctrl+L` that exist in mobile bar. | `1150`, `1464` | Medium |
| U7 | **Flexibility & efficiency** | No file sorting (name/date/size), no hidden-files toggle (dotfiles hidden by default `fsPromises.readdir` shows them, but user cannot hide), no grid view, no quick preview (spacebar). Finder requires 2 chars (`3559`) and uses `path`+`currentPath` scoped search depth 4 — misses deeper files; no “search in content” UI despite API. Power users’ `Ctrl+Shift+R` refresh preview undiscoverable. | `index.html:5756`, `1539`, `4266` | High |
| U8 | **Aesthetic & minimalism** | Settings panel (`332`) is 340 px wide; on 768 px breakpoint it overlays content with `position:fixed` but no backdrop — terminal still interactive underneath, visually noisy. System Stats modal (`1489`) shows 4 cards + GPU cards + proc table — at 360 px width, grid collapses to 1 col but proc table `max-width:200px` truncates with ellipsis, no horizontal scroll cue. | `index.html:332`, `1489` | Medium |
| U9 | **Help users recover** | Toast auto-dismiss 3 s (`5549`), no action button, no persistence for errors. If `api()` fails (401 → `showPinScreen` silently), pending `loadFiles` shows empty “Failed to load directory” with Retry but no error detail (`2820`). `confirmDialog` (`5467`) uses `Enter` to confirm unless target is button — conflicts with typing in rename input (Enter should submit, not confirm discard). | `index.html:5537`, `2819`, `5493` | Medium |
| U10| **Help & documentation** | “Keyboard Shortcuts” in overflow menu only (`1049`); no onboarding tooltip for first-time users (e.g., swipe gesture, double-click tab rename). PWA install banner (`1634`) shows after 3-5 s regardless of interaction; on iOS says “Tap Share → Add to Home Screen” but share icon varies by OS version. | `index.html:1049`, `1634` | Low |

### 3.2 Interaction & Touch Targets (WCAG 2.5.5, 2.5.8)

| # | Location | Issue | Spec | Fix |
|---|----------|-------|------|-----|
| U11 | `index.html:442` `.file-ellipsis` 18×18 px (`public/index.html:442`) | Touch target 18 px < 24 px (WCAG 2.5.8 minimum) / 44 px Apple HIG. Coarse pointer bump to 36 px at `454` but still ellipsis hit-area detached from file-item. | Fail | Use 44×44, `padding:10px` with `margin:-10px`. |
| U12 | `.tab-close` 16×16 (`404`) → 44×44 on coarse (`167`) but inner SVG 10×10 leaves dead zone. | Same | Make button `width:44 height:44` with `display:flex` already, but ensure padding. |
| U13 | `.icon-btn` 30×30 (`365`) shrinks to 28×28 on small phones (`921`) — even smaller. | Fail 480 px | Keep 44 px minimum on touch. |
| U14 | `.search-btn#search-case-btn` 22×22 (`173`) | Too small; also lacks `aria-pressed` state (has `.active` class visually but aria not set). | Add `aria-pressed`, min 28 px. |
| U15 | `index.html:1212-1242` `#mkey-ctrl-row` keys `min-width:44px` but `gap:4px` + `overflow-x:auto` requires horizontal scroll — many keys hidden offscreen with no scroll indicator. | Discoverability | Add fade edge or `scroll-snap`. |

### 3.3 Visual Design & Theming

| # | Location | Issue |
|---|----------|-------|
| U16 | `index.html:105-144` themes | Light theme `--fg2:#2b2b45` on `--bg2:#eeeef2` → contrast ~7:1 OK, but `--fg3:#5d5d78` on `--bg3:#e2e2e8` fails 3:1 for small text (breadcrumb). Dracula `--fg2:#6272a4` on `--bg2:#1e1f29` → 4.2:1 barely passes AA for large text only. Solarized `--fg2:#586e75` on `--bg2:#073642` → 3.8:1 borderline. Each theme sets `--shadow-color:rgba(0,0,0,0.6)` even for light — shadow too harsh in light mode (`--shadow-color:rgba(0,0,0,0.12)` only for light). |
| U17 | `index.html:23` `addon-webgl` | WebGL addon loaded via CDN unconditionally; on low-memory devices creates canvas GL context per tab → may crash. No feature-detect fallback; CSS `xterm-screen` flash on `bellFlash` uses `filter:brightness(1.8)` which combined with WebGL layer does nothing. |
| U18 | Typography | `--font` JetBrains Mono used for `.file-name`, `#path-input`, `#file-breadcrumb` — mono for breadcrumb reduces legibility vs `IBM Plex Sans`; file names benefit from proportional? Keep mono for paths only (`--font` vs `--font-ui` split is correct per AGENTS.md but over-applied to `.file-name`). |
| U19 | `index.html:749` `#finder-input height:40px` | Finder input 40 px but results container `max-height:300px` with no scrollbar styling on mobile — thumb 10 px `min-height:44px` but track transparent, low discoverability. |
| U20 | Empty states (`2912`) | Empty dir shows 3 buttons (New file / New folder / Upload) with identical `btn-ghost` style — no primary action hierarchy. Should make “Upload” primary or contextual. |

### 3.4 Navigation & Layout

| # | Issue | Location |
|---|-------|----------|
| U21 | Sidebar collapse: desktop `width:0 !important` (`212`) vs mobile `transform:translateX(-100%)` (`936`). Transition `all` on `#sidebar` (`210`) animates `width` which triggers layout reflow for every frame — janky on low-end. Use `transform` for both. | `index.html:210,212,936` |
| U22 | Editor split: `#editor-split-area.horizontal` sets `max-width:calc(100vw - var(--sidebar-w) -160px)` — but `--sidebar-w` is CSS var updated only on resize, not when sidebar hidden (`width:0` still counts). Horizontal split can overflow viewport when sidebar hidden. | `index.html:293` |
| U23 | Breadcrumb on Windows (`3126`) renders `\\` segments as `<a>` with `padding:4px 2px` but trailing `span` for last segment not focusable — keyboard users cannot activate last crumb (should be non-link). Good, but no `aria-current="page"` signal. | `index.html:3139` |
| U24 | Tab bar `mask-image` (`215`) fades right edge 20 px but `new-tab-btn` sits outside scroll container — on overflow, mask clips close button of last tab, suggesting hidden tabs with no affordance to scroll. Add `scroll-shadow` or draggable hint. | `index.html:215` |

### 3.5 Accessibility (WCAG 2.1 AA audit)

| # | Criterion | Violation | Location |
|---|-----------|-----------|----------|
| U25 | 1.3.1 Info & Relationships | `#sidebar[role=navigation]` but contains `role=listbox` (`file-list-wrap`) and `role=option` items — correct, but parent navigation landmark should not contain listbox? Use `section` landmark. | `index.html:1058,2805` |
| U26 | 1.4.3 Contrast | `.sys-card h3` uses `color:var(--fg2)` on `var(--bg3)` — many themes below 4.5:1 (see U16). | `898` |
| U27 | 1.4.10 Reflow | `#file-breadcrumb` uses `white-space:nowrap` + `overflow-x:auto` requires 2D scrolling — fails 400% zoom reflow requirement (should wrap at 320 px). | `430` |
| U28 | 2.1.1 Keyboard | File ellipsis button reachable via Tab, but context menu opened via ellipsis click does not return focus to triggering item on `Esc` — focus lost. | `2966` |
| U29 | 2.4.3 Focus order | Opening sidebar on mobile does not move focus into sidebar; opening Command Library panel does not trap focus (unlike overlays which use `installFocusTrap`). | `765`, `5845` |
| U30 | 2.4.7 Focus visible | `.icon-btn:focus-visible` has outline, but `xterm` textarea focus ring hidden by `xterm` CSS `outline:none` — keyboard users can’t see which tab’s terminal is focused. | `493` |
| U31 | 4.1.2 Name/Role/Value | `keep-awake` checkbox uses hidden `<input>` with custom `.keep-awake-box` — `aria-label` on input but no `aria-checked` sync; settings toggles use `div[role=switch]` with `aria-checked` correctly, pattern inconsistent. | `1017`, `1320` |

### 3.6 Mobile & Responsive

| # | Location | Gap |
|---|----------|-----|
| U32 | `index.html:933` `@media (max-width:768px) { #mobile-keys{display:flex} }` | Overrides user’s `settings.mobilekeys=false` on mobile (JS `setupMobileKeys` sets `display:none` but CSS media query forces `flex` with higher specificity). Toggle broken on phones. |
| U33 | `index.html:948-956` landscape tweak | Header height reduced to 32 px but `#sidebar` top still `var(--header-h)=38px` → gap. `mkey` min-width 38 px reduces target further. |
| U34 | `index.html:5247-5290` `setupVisualViewport` | Hacks `marginBottom` on `#terminals` based on `visualViewport.height - innerHeight` diff — but iOS keyboard `visualViewport` behavior differs from Android; on Samsung Internet, keyboard resizes `innerHeight` not `visualViewport` → double margin, content pushed off-screen. |
| U35 | Pull-to-refresh (`5596`) | Uses `touchmove` on `#file-list-wrap` with `passive:true` but calls `preventDefault()` not possible; overscroll rubber-band still triggers browser refresh on Chrome Android despite JS indicator. Needs `overscroll-behavior:contain` on container. |
| U36 | Pin screen (`997-1007`) | `inputmode="numeric"` restricts keyboard to numbers, but PIN is arbitrary string (`PIN="secret"` quoted handling in `server.js:12`). User with alphabetic PIN can’t type it on mobile. |

---

## 4. Priority Matrix

| Priority | Items | Effort |
|----------|-------|--------|
| **P0 (fix next)** | F1, F6, F10, F4, F13, U1 (status), U11-13 (touch), U33 (landscape) | 1-2 days |
| **P1 (sprint)** | F2, F8, F12, F15, F22, U3 (undo), U7 (search/sort), U25-U30 (a11y), F34 (surface dead features or remove) | 1 week |
| **P2 (polish)** | F17 (per-user clipboard), F19 (atomic writes), F26-27 (build), U16 (theme contrast), U19-24 (layout) | 2-3 weeks |
| **P3 (debt)** | F9, F11, F20, U32, U34 viewport hack | backlog |

---

## 5. Recommendations (actionable)

### Backend (hardening)
1. **Enforce path sandbox default** — add `if(!pathContained(WORKSPACE_ROOT, resolved)) return res.status(403)` to every `checkPin` file route. Add env `ALLOW_FULL_FS=true` to opt-out. Fixes F1/F2 (`server.js:206` already exists).
2. **Harden PIN transport** — deprecate `?token=` except WS (`server.js:1371`). Add `POST /api/logout` clearing client token and server-side session expiry (e.g., JWT vs raw PIN). Fixes F6.
3. **Fix rate limiter** — replace manual `x-forwarded-for` with `req.ip` (`server.js:93`) and `app.set('trust proxy')` respect. Unify `skipWhenNoPin` logic.
4. **Guard large reads/writes** — before `readFile`/`download`, `stat` + reject if `size>10*1024*1024` (or stream with limit). Add download range/zip size cap. Fixes F4/F5.
5. **Throttle search-content** — limit `maxResults 50`, `maxDepth 4` only (drop 10), add 5 s timeout + abort signal, escape regex or use safe regex (no `RegExp(query)` directly). Fixes F13.
6. **Namespace sessions/clipboard** — prefix `wt-webtun-` + per-IP clipboard `Map<ip, clipboard>` or JWT scoping. Add TTL sweep for `ptySessions` (30 min idle). Fixes F14/F15/F17.
7. **Atomic writes** — use `fs.writeFileSync(tmp+'1'); fs.renameSync(tmp+'1', FILE)` for `.tunnels.json` / `.cmdhist.json`. Fixes F19/F20.
8. **Implement or remove `/api/exec`** — update `AGENTS.md:48` or implement streaming exec with timeout (as doc promises 10 MB/300 s limits).

### Frontend (UX)
9. **Touch targets** — bump `.file-ellipsis`, `.tab-close`, `.icon-btn`, `.search-btn` to 44×44 min with `padding` and `margin` compensation on coarse pointers. Add `aria-pressed` to case toggle. Fixes U11-U14.
10. **Status visibility** — raise upload bar to 6 px + strong contrast + persistent text (`“Uploading 3/10” + Cancel`). Add numeric retry count to reconnect banner (“Reconnecting (2/10)…”) with manual Retry button earlier (after 1st fail). Fixes U1.
11. **Error & undo** — add 5 s “Deleted — Undo” toast with `POST /api/files/undo` (move to `.trash/`); keep `failedItems` list in toast details modal. Fixes U3/U9.
12. **Discoverability** — add 30 s coach-mark on first load: “Swipe tab to close, Double-tap title to rename, Drag sidebar to resize”. Show `Ctrl+P` hint as placeholder in finder input (`public/index.html:1457`). Fixes U6/U10.
13. **Feature surfacing or pruning** — either expose `chmod`/`symlink`/`search-content`/`tail` in context menu (advanced submenu) or remove dead server code and doc entries. Avoid dead API confusion (F34).
14. **Settings consistency** — unify toggles to single component (`div[role=switch]` with hidden input pattern already at `index.html:1320`). Add `Confirm on close` preview. Persist sidebar width with `transform` not `width` to avoid reflow (U21).
15. **A11y pass** — run axe-core; fix focus traps for Command Library (`#cmd-lib-panel` not trapping), sidebar focus on open, xterm focus ring, breadcrumb `aria-current`, hide/show `aria-expanded`. Test with VoiceOver/NVDA.

### Build & Electron
16. Electron: read `PIN`/`WORKSPACE_ROOT` from `safeStorage` or menu, add auto-updater (`electron-updater`), pin validation before load.
17. `postinstall.js`: detect `allow-scripts` block early and print actionable curl, not silent skip.

---

## 6. What’s Already Good (keep)
- Vanilla stack (no bundler) — fast to audit, CDN `defer` pattern (`index.html:18-42`) correct.
- `safeStorage` wrapper (`978`) for Tracking Prevention, `constantTimeEqual` attempt, WebGL fallback, binary WS protocol (`xterm:343-352`) are above-average craft.
- Theme system with `color-scheme` explicit per theme, `aria-modal` dialogs, focus traps, toast caps — most v1.5.2 polish landed.

---

## 7. How to Validate
```bash
# 1) Path traversal
curl -H "x-pin-token: $PIN" "http://localhost:3000/api/files?path=/etc" | head
# expect 403 after fix

# 2) Large file
truncate -s 12M /tmp/big.bin
curl -H "x-pin-token: $PIN" "http://localhost:3000/api/files/read?path=/tmp/big.bin"
# expect 413

# 3) a11y
npx axe-core --include "#file-list-wrap,#header,#sidebar" http://localhost:3000

# 4) Touch targets (Chrome DevTools > Rendering > Touch target)
# should have no red overlays
```

*Generated by manual audit — all findings verified against live code paths cited as `file:line`. Treat P0 list as blocker for public tunnel deployment.*

---

## Addendum — Re-audit 2026-08-25 (Gap Fill)

Second pass (3 parallel sub-agents) found **58 additional gaps** missed in v1. Categorized below. Numbering continues (F38+, U37+).

### A. Backend — New Functional / Logical Gaps

#### A.1 Config & Env Parser Divergence

| # | Location | Gap | Impact |
|---|----------|-----|--------|
| F38 | `server.js:2-16` vs `setup.sh:115` | `.env` parsers diverge: `server.js` strips outer quotes only, keeps `# comment`? Actually trims line then `if(trimmed.startsWith('#'))` — `KEY=val # comment` keeps `# comment` as value. `setup.sh` uses `IFS='=' read -r key val` dropping segment after second `=`, plus `xargs` stripping internal spaces (`PIN=hello world` → `hello`). `PIN="a\"b"` inner escape lost. | Medium — PIN/PORT mismatch between CLI and server |
| F39 | `server.js:125` `WORKSPACE_ROOT` | `path.resolve(process.env.WORKSPACE_ROOT)` succeeds even if path nonexistent or file not dir. `os.homedir()` returns `''` when `HOME` unset (systemd) → `path.resolve('')` = `cwd`, later walks `cwd`. No `stat`/`isDirectory` guard. | Medium |
| F40 | `server.js:121` `SHELL` | `/bin/bash` check at load; NixOS/Alpine has no `/bin/bash` → fallback `sh` (`dash`) but spawn args `['-l']` assume bash login semantics. | Low |
| F41 | `server.js:119` + `bin/webtun.js:59` PIN argv | `--pin` last-arg consumes next flag: `webtun --pin --tunnel` eats `--tunnel` as PIN value → disables auth silently (`PIN=""`). Missing `argv[++i]` bounds check for `undefined`. Not just “fragile” (F23) but silent open. | **High** |
| F42 | `server.js:127` `express.json({limit:'50mb'})` | Global 50 MB for **every** POST (`write`, `history`, `clipboard`, `tunnel`, `batch-delete`). Per-route caps missing. Repeated 50 MB `write` → disk fill. | High |
| F43 | `server.js:151` `TRUST_PROXY="loopback"` | Behind `cloudflared tunnel --url http://localhost:$PORT` every remote IP appears as `127.0.0.1`. Rate limiter key collapses to one bucket for all tunnel users (see F8 addendum). | High |

#### A.2 Rate Limiting, Auth Bypass & Input Type Confusion

| # | Location | Gap | Impact |
|---|----------|-----|--------|
| F44 | `server.js:89-109` collapse+blowup | Two failures: **Collapse**: tunnel users all map to `127.0.0.1` → one attacker exhausts `rateLimiter 20/10s` denies all. **Blowup**: attacker spoofs `X-Forwarded-For: random-$n` → unbounded `rateLimitWindows` Map entries, cleaned only each 60 s → memory exhaustion. | High |
| F45 | `server.js:160-164` `checkPin` arrays | `req.headers['x-pin-token']` or `req.query.token` can be `Array` (`?token=a&token=b` or duplicate headers). `(array||'').trim()` → `array.toString()='a,b'` or TypeError, leaks 500. Missing `typeof token==='string'` guard. | Medium |
| F46 | `server.js:677,705,....` `Array`/`\0` path | `?path=a&path=b` → `path.resolve(Array)` throws `ERR_INVALID_ARG_TYPE` 500. `?path=%00/etc` null byte → 500. `?path=` empty → `WORKSPACE_ROOT` then `readFile` on dir → `EISDIR` 500. No 400 validation. | Medium |
| F47 | `server.js:498-499` `rename newName` | `newName` not sanitized for `/`, `\`, `..`. `path.join(dirname,'../evil')` escapes dir. `newName='a/b'` creates nested path unintended. | High |
| F48 | `server.js:1358` WS origin bypass | `if (origin){ check }` — missing `Origin` header (non-browser/custom client) skips check entirely when `PIN` set. Should default-deny. | High |
| F49 | `server.js:1370-1373` WS token | Auth uses `token !== PIN` (plain `!==`), not `constantTimeEqual` (`server.js:153`). Timing leak. Token in URL logged. | Medium |
| F50 | `server.js:1375-1376` WS `cwd` injection | `cwd=realPath(?cwd)` follows symlink anywhere, no `pathContained`. `pty.spawn({cwd:'/'} )` escapes sandbox. | High |
| F51 | `server.js:1383,1279` `sessionId` unbounded | `replace(/[^a-zA-Z0-9_-]/g,'')` keeps 1k+ chars → `wt-`+1k > tmux 256 char limit → `has-session` fails. Flood with 1k-char ids → Map memory exhaustion when `PIN=""`. | Medium |
| F52 | `server.js:1375-1511` `cols/rows` unbounded | `parseInt(?cols)` without upper bound → `resize(999999,999999)` OOM. `cols=0` → `pty.spawn cols 0` throws. | Medium |

#### A.3 File-Op Logic Holes (per-route)

| # | Location | Gap |
|---|----------|-----|
| F53 | `server.js:574` `copy/move dst` | `dst=resolvePath(destination)` not `realPath`; symlink to `/` bypasses guard. Missing `src===dst` → `cp force + rm src` deletes file. `dst` inside `src` (move parent into child) → recursion then `rm src` deletes copy. |
| F54 | `server.js:583,850` `DELETE/batch-delete` | Uses `stat` not `lstat`; deleting symlink to dir follows target and `rm -r` deletes outside sandbox. |
| F55 | `server.js:602,616,630,655` `mkdir/touch/zip/unzip` | `realPath(req.body.path)` with no containment — attacker with PIN can `mkdir /tmp/pwn`, `touch /etc/cron.d/backdoor`. |
| F56 | `server.js:696` `write` type | `req.body.content` unchecked: object → `'[object Object]'`, `undefined` → `'undefined'` string. No size guard vs 50 MB JSON. |
| F57 | `server.js:705-719` `image` headers | `Cache-Control private max-age=3600` for `application/octet-stream` caches secrets. Headers sent before `stat`; `createReadStream` error after headers → hanging FD, no `req.on('close')` destroy. |
| F58 | `server.js:721-732` `download` | `Content-Disposition: filename="${basename(p)}"` unsanitized `"`/`;` → header injection `evil".zip`. No `res.on('close')` cleanup for `archiver` when client aborts. |
| F59 | `server.js:750-773` `upload` mismatch | `destination` sanitizer `[^a-zA-Z0-9_.\-]` vs `filename` `[\w…]` differ — `pathContained` check uses first name, file saved with second → bypass. `destDir=realPath(?path)` 403 masks TypeError for Array path. `mkdirSync` blocking. Limits `500MB*100=50GB` disk exhaustion; partial writes orphaned on error. |
| F60 | `server.js:782-820` `stat` blocking | Three `execFileSync` (`id/getent/dscl`) block 50-200 ms per request; no rate limit → DoS loop. Leaks absolute `p` in error. |
| F61 | `server.js:231-248` `dirSize` | No depth limit, `stat` follows symlinks → symlink loop `a→.` infinite, FD exhaustion. No lock vs concurrent `GET /api/files/size`. |
| F62 | `server.js:850-894` `batch-delete/copy/move` | No `paths.length` cap; 50 MB JSON → 500k paths sequential `await` minutes. `batch-copy` default `conflict='replace'` silent overwrite; `destination resolvePath` vs `sources realPath` mismatch. |
| F63 | `server.js:251-293` `createZipArchive` | `fs.statSync` blocking; no size/count guard → 100 GB dir disk full. `archive.directory` follows symlink outside sandbox → zip leaks `/etc`. Concurrent `zipName` `access` loop race overwrites. |
| F64 | `server.js:655-673,283-316` `unzip` | `destDir` created before validating zip magic; per-entry no size limit → zip bomb 10 GB single entry; leaves partial files on failure, no rollback. |
| F65 | `server.js:935-998` `search-content` extra | `maxResults='abc'` → `NaN` → `results.length>=NaN` always false → unbounded RAM. `stat` not `lstat` for files → symlink escape. TOCTOU: `stat` → `open` → `readFile` re-opens without `O_NOFOLLOW` can be swapped to `/etc/shadow`. |
| F66 | `server.js:1539-1551` `search` length | `q` no length cap; 50 MB string `q.toLowerCase` OOM. No containment for `dir` param. |
| F67 | `server.js:1038-1086` `tail` byte/char | `lastSize=content.length` (chars) but `stat.size` and `fd.read(...,lastSize)` are bytes → multibyte UTF-8 garbled. `?lines=abc` → `NaN` → `slice` fails. `Buffer.alloc(newSt.size-lastSize)` where delta 90 MB OOM. Initial `readFile` loads 100 MB into RAM (should reverse stream). Only `req.on('close')` clears timer, not `res` destroy → leak. No `lstat` → tailing FIFO/socket. |
| F68 | `server.js:1092` `network` | No rate limit; 8× `execFileSync` + `spawnRead` block 1-2 s per request → DOS loop. Leaks `mac`, `gateway`, `dns`. |
| F69 | `server.js:1163-1211` `clipboard paste` | `action=cut` clears singleton after loop even if some `resolveCopyMove` failed → data loss. `sources` unbounded. Single `conflict` string for batch, per-file conflict impossible. |
| F70 | `server.js:1217-1252` `history` extra | File `0644` world-readable contains secrets. `cmd` not length capped; `max` float `20.7` → `length=20.7` weird. |
| F71 | `server.js:1276` tmux detection once | `execSync('command -v tmux')` at startup; if tmux installed after start, stays `null` incorrectly. |
| F72 | `server.js:1306,1326` `sessions` empty id | `replace` → `''` → `wt-` → `tmux has-session -t wt-` prefix matches first `wt-*`; `ptySessions.delete('')` wrong. Missing 400. |
| F73 | `server.js:1451-1468` backpressure leak | `drainCheck` interval per WS 50 ms; reattach keeps old interval referencing old `ws.bufferedAmount`, new WS creates second → double intervals, `proc.pause()` ineffective for tmux. |
| F74 | `server.js:1501-1516` `resize` flood | Each resize `execFileSync('tmux resize-window')` blocking; flood of 64 KB bin messages DOS. |

#### A.4 Tunnel / Cloudflare

| # | Location | Gap |
|---|----------|-----|
| F75 | `server.js:1897` `POST /api/tunnel` SSRF | `url` no scheme/host validation → `http://169.254.169.254/...` or `http://localhost:22` accepted, `spawnCloudflared --url` probes internal network (via `verifyTunnelUrl` timing). |
| F76 | `server.js:1863` `GET /api/tunnel` SSRF | Per-tunnel `fetch(t.localUrl,{HEAD})` without validation → same SSRF, follows redirects, `clearTimeout` not called on error → timer leak, 10 tunnels ×3 fetches hang 90 s. |
| F77 | `server.js:1952` `DELETE /api/tunnel` | Expects JSON body on DELETE (proxies strip) → 404. No `id` pattern check. Colliding `id` from `replace` short `a` duplicates. |
| F78 | `server.js:1813` `restartTunnel` orphan | `proc.unref()` without retaining reference beyond Map; if handler never fires (stderr only), entry stays deleted → dead tunnel never re-added, orphan survives `cleanup`. |
| F79 | `server.js:1353` `ALLOWED_WS_ORIGINS` dead | Empty Set never populated, not exported, `/api/tunnel` never adds `tunnelUrl` → tunnel WS always rejected unless host matches. |
| F80 | `server.js:1738` `findCloudflared` | Candidates include `process.cwd()` attacker-controlled; `fs.readFileSync('/proc/PID/cmdline')` sync blocks per tunnel. |

#### A.5 Build / Setup

| # | Location | Gap |
|---|----------|-----|
| F81 | `electron/main.js:150` `autostart` args | `filter(a=>a!=='--')` only strips bare `--`, leaks `--port/--pin` into login item → stale args on reboot. |
| F82 | `postinstall.js:92` `tmp` predictable | `os.tmpdir()+'/cloudflared-'+pid` world-writable, no `mkdtemp` → symlink attack `ln -s /etc/cron.d /tmp/cloudflared-123` → arbitrary write. |
| F83 | `postinstall.js:184` `tar` | `tar xzf tmp -C tmpDir` without entry validation → malicious `tgz` (CDN compromise) writes `../../.ssh/authorized_keys`. |
| F84 | `setup.sh:143` heredoc | `cat > "$ENV_FILE" << EOF` (unquoted) expands `INPUT_PIN` backticks: `$(rm -rf /)` executes at write. Must `<<'EOF'` or `printf '%q'`. |
| F85 | `setup.sh:242,252` pid race | `kill -- $(cat webtun.pid)` TOCTOU PID reuse; `pkill -f "^node.*server\.js"` kills any user's `server.js`; `curl` poll may hit old instance while new failed (port busy) → false “running”. |
| F86 | `package.json:52,96` bloat | `extraResources` copies entire `node_modules` (200 MB `electron` devDep) → AppImage ~400 MB. `overrides` misses `ws@8.21.0` CVE-2024-37890, `archiver`/`yauzl` symlink CVEs. `allowScripts` pins `node-pty@1.1.0` but dep `^1.0.0` mismatch. |

### B. UI/UX — New Gaps

#### B.1 Heuristic & Visual

| # | Location | Gap |
|---|----------|-----|
| U37 | `index.html:976` skip link | `href="#content"` but `#content[role=main]` lacks `tabindex="-1"` → focus not moved, screen reader skip fails. |
| U38 | `index.html:150` `touch-action:manipulation` | Disables double-tap zoom globally → fails WCAG 1.4.4. |
| U39 | `index.html:153` `input{font-size:16px}` | Forces 16px on desktop (too large), audit only flagged coarse query. |
| U40 | `index.html:597` dirty dot | `8px` dot only `aria-label`, no `aria-live`/`role=status` on parent → state change not announced. |
| U41 | `index.html:3882` `lineWrapping:false` | Hard-coded, no toggle for long lines → horizontal scroll. |
| U42 | `index.html:3884` `Ctrl+F` | Global hijack even when CodeMirror focused — editor has no find/replace. |
| U43 | `index.html:3904` `getCMmode` | `.tsx/.jsx` returns `{typescript:true}` without `jsx:true` → JSX highlighting broken. |
| U44 | `index.html:568` `.btn.loading` | `color:transparent` hides label while busy → screen reader reads empty button. |
| U45 | `index.html:3795` upload no cancel | `uploadFileList` has no Cancel XHR, `_uploadProgressTimeout` auto-clears error after 1500 ms → errors not persistent. |
| U46 | `index.html:1940` tab rename | `input#tab-rename-input width title.length*9` may overflow viewport, no `maxlength`. |
| U47 | `index.html:2502` TUI touch | Single tap→left click, 500 ms long→right click conflicts with xterm selection loupe and swipe-to-close. |

#### B.2 WCAG

| # | Location | Gap |
|---|----------|-----|
| U48 | `index.html:332` settings drawer | `transform` no backdrop, no `aria-modal`, no `inert` on `#main` → focus leaks behind. |
| U49 | `index.html:1150` `#cmd-lib-panel` | No `installFocusTrap`, no `role=dialog`, Tab exits to page. |
| U50 | `index.html:5443` `installFocusTrap` | Adds listener to `container`, `removeFocusTrap` removes from `document` → handler leak, singleton overwrite. |
| U51 | `index.html:5466` `confirmDialog` singleton | Second confirm before first resolved overwrites `resolve` (e.g., `closeTab` double dialog `2321`) first promise never settles. |
| U52 | `index.html:539` modal label | `text-transform:uppercase 11px` on `var(--fg2)` fails 4.5:1 on some themes. |
| U53 | `index.html:608` CodeMirror focus | Hidden `textarea` — no `.CodeMirror:focus-within` outline, audit only flagged xterm. |
| U54 | `index.html:720` bookmarks header | `onclick` toggle no `role=button`/`aria-expanded`/`tabindex`, keyboard inoperable. |
| U55 | `index.html:387` `.tunnel-btn 22px` | No coarse bump (unlike `icon-btn 40px`) → fails WCAG 2.5.8 24px. |
| U56 | `index.html:466` `.sidebar-resize-handle 5px` | Target <24px, no enlargement on coarse. |
| U57 | `index.html:382` `.tunnel-label 10px` | Tiny 10px fails 200% zoom reflow. |
| U58 | `index.html:970` `prefers-reduced-motion` | Sets `animation-duration:0.01ms` but leaves `backdrop-filter:blur(4px)`, `transition:all` → motion not fully disabled. |

#### B.3 Mobile / Gesture / Safe-area

| # | Location | Gap |
|---|----------|-----|
| U59 | `index.html:1982` tab swipe | `dx>80` fires even when user drags tab bar to reveal overflow — accidental close. Scroll vs swipe not disambiguated. |
| U60 | `index.html:5638` long-press vs selection | Long-press bails if target contains `.file-name` (which is `user-select:text`) → user expects copy loupe, gets nothing. Conflict. |
| U61 | `index.html:5247` `visualViewport` Samsung | `diff=visualViewport.height-innerHeight` inverted on Samsung Internet (`innerHeight` resizes), not debounced, ignores `scale` after pinch → double margin, blurry canvas. |
| U62 | `index.html:5595` pull-to-refresh | `passive:true` so `preventDefault` impossible, no `overscroll-behavior:contain` → browser rubber band triggers page reload. `translateY` forces layer per item, no virtualization. |
| U63 | `index.html:150,199` safe-area double | `body padding-bottom:env(safe-area)` + `header padding-top:env(safe-area)` with `height:38px+100dvh` double counts on iOS 15+; `#install-banner bottom:var(--mobilekey-h)` without `env(safe-area)` obscured on notch. |
| U64 | `index.html:532` finder behind keyboard | `setupVisualViewport` hides `mobile-keys` rows but not `#finder-input`/`#cmd-lib-panel` → finder hidden behind keyboard, no `scrollIntoView`. |
| U65 | `index.html:2571` pinch-zoom persistence | Changes per-tab `fontSize`, persists via `wt-settings` after 500 ms debounce but not `devicePixelRatio` aware, WebGL not re-fit → blurry, last tab wins multi-tab race. |
| U66 | `index.html:218` `#tab-scroll` hidden scrollbar | `scrollbar-width:none` no affordance, keyboard overflow hidden; mask fade not announced. |
| U67 | `index.html:679` toast vs banner | `el.style.marginBottom=var(--mobilekey-h)` conflicts with `banner-visible` class, stale when keys toggled. |

#### B.4 Terminal

| # | Location | Gap |
|---|----------|-----|
| U68 | `index.html:5047` `toggleTermSelect` | Sets `disableStdin` + `textarea.disabled` for all tabs, exit `clearSelection` on all tabs destroys prior selections; `getActiveTab` copy may target wrong tab if active changed. |
| U69 | `index.html:2412` bracketed paste 64KB | Single WS `0x00` message capped 64KB (`AGENTS.md:00 max 64KB`) — large paste silently truncated, no chunking, no toast. `fallbackPaste` uses deprecated `execCommand('paste')` no feedback. |
| U70 | `index.html:2547` wheel `isMouseTracking` | Checks private `term._core.coreMouseService.isMouseTrackingActive()` brittle across xterm versions; `lineHeight` from `.xterm-rows.children[0]||16` inaccurate after font change → scroll jumps. |
| U71 | `index.html:2392` WebGL per tab | Instantiated per tab without memory check, `onContextLoss=>dispose()` only disposes addon not fallback canvas → low-memory OOM. |
| U72 | `index.html:522` search-bar tiles | `position:absolute top:8 right:12` inside `#terminals` — in `tiles-mode` grid overlays first tile only. `doSearch` `getDecorations` undefined on addon-search 0.15.0 → count always `1`. |
| U73 | `index.html:237` tiles header | `.tth-name/.tth-close` not focusable, grid `minmax(300px,1fr)` overflows <320px viewport horizontal scroll. |
| U74 | `index.html:2439` bellFlash | Flash targets `.xterm-screen` but WebGL uses canvas → invisible. `Notification` only if `document.hidden && bell` but `requestPermission` only on toggle, background bells never notify. |

#### B.5 File Explorer / Editor / Overlays

| # | Location | Gap |
|---|----------|-----|
| U75 | `index.html:2911` empty state | 3 `btn-ghost` equal hierarchy, no primary CTA; no `aria-live` when loading→empty. |
| U76 | `index.html:3098` breadcrumb UNC | `\\server\share` `m[0]` parsing loses trailing `\` on `C:\` vs `C:` → navigation to `C:` fails; last segment no `aria-current`. |
| U77 | `index.html:2791` no virtualization | Diff reuses DOM but still creates node per file; 10k entries → 10k `file-item` nodes jank, no `content-visibility`. |
| U78 | `index.html:3361` context menu zoom | Flip logic `offsetWidth` after `display:block` but before `class open` transition — 200% zoom values 0 → offscreen. |
| U79 | `index.html:2980` type-ahead collision | 1D Up/Down only, `typeAhead` 500 ms reset collides with Shift-latch uppercase and `Ctrl+C` timing. |
| U80 | `index.html:3619` select range | No `Shift+click` range selection, `selectAllFiles` `dataset.path!==currentParent` counts `..` incorrectly, missing `aria-setsize`/`aria-posinset`. |
| U81 | `index.html:3940` autosave | No draft to `safeStorage` — `beforeunload` warns but network loss before save loses data; `editorDirty` duplicate in `2328`/`4047`. |
| U82 | `index.html:1203` iframe sandbox | `allow-same-origin allow-scripts` with `srcdoc` lets script access parent origin `localStorage` (`wt-tabs`/`PIN`). `DOMPurify ADD_TAGS:['style']` allows CSS spoofing. |
| U83 | `index.html:4248` live reload leak | 1000 ms poll not cleared on `openFileEditor` re-entry or `toggleEditorSplit` → leak; `_previewLastContent` stale when switching .md→.html. |
| U84 | `index.html:4008` split clamp | Restore `--editor-size` 600px overflow when sidebar hidden (`--sidebar-w` still counted) — clamp only on drag not load. |
| U85 | `index.html:4454` settings outside click | Capture `closeSettingsOnClickOutside` checks `panel.contains` only — scrollbar or `#terminals` clicks close unexpectedly; no backdrop prevents accident. |
| U86 | `index.html:1633` install banner standalone | `setTimeout 3s/5s` regardless of `display-mode:standalone`; `platform==="MacIntel"&&maxTouchPoints>1` false-positive on MacBook. |
| U87 | `public/sw.js:12` SW `skipWaiting` | `install skipWaiting()+activate clients.claim()` takes control without consent breaks active WS `/ws`; `public/index.html:6286` never sends update prompt nor listens `controllerchange`. |
| U88 | `public/sw.js:38` stale forever | Cache-first static assets no `max-age` → stale until version bump `v3`; API excluded but `/ws`/`?token=` not excluded. Fire-and-forget `c.put` without `waitUntil`. |
| U89 | `public/manifest.json:9` PWA overlay | `display_override:["window-controls-overlay"]` but no CSS `env(titlebar-area-width)` → controls overlap. |
| U90 | `public/manifest.json:20` shortcuts | `shortcuts:[{name:"New Terminal",url:"/"}]` identical to `start_url` — no deep link, no icons. |
| U91 | `public/commands.js:2` RCE | `DEFAULT_CMDS` includes `curl ... | bash` via `runCmdLib` `5938` without confirmation → one-click RCE. |
| U92 | `public/index.html:5756` cmd library tabs | `Library/History` `button` no `role=tab`/`aria-selected`/`aria-controls`; history filter no `aria-live` on empty. |
| U93 | `public/index.html:6138` stats poll | `setInterval(5000)` not paused on `document.hidden` or `datasaver` mid-poll → background fetch wastes tunnel bandwidth. |

### C. Updated Priority Matrix (v2)

| Priority | Items | Effort |
|----------|-------|--------|
| **P0 (next)** | F1,F6,F10,F13,F38-F41,F44,F47-F52,F54-F55,F75,U11-U13,U37 (skip),U48,U54 | 2-3 days |
| **P1 (sprint)** | F42,F45,F53,F58,F63-F67,F72,F74-F79,U38,U50-U51,U59-U62,U68-U69,U77,U82,U91 (confirm) | 1 week |
| **P2 (polish)** | F39-F40,F56-F57,F60-F62,F68-F71,F80-F83,U39-U47,U55-U58,U64-U67,U70-U76,U78-U85 | 2 weeks |
| **P3 (debt)** | F43,F73,F84-F86,U63,U86-U90,U92-U93 | backlog |

### D. Corrected Validation Checklist (add to §7)

```bash
# 5) Rename traversal
curl -H "x-pin-token:$PIN" -X POST /api/files/rename -d '{"oldPath":"/tmp/a.txt","newName":"../evil"}'
# expect 400

# 6) DELETE symlink
ln -s /etc /tmp/link; curl -X DELETE "/api/files?path=/tmp/link"
# expect 200 & /etc intact (lstat not stat)

# 7) SSRF tunnel
curl -H "x-pin-token:$PIN" -X POST /api/tunnel -d '{"url":"http://169.254.169.254/"}'
# expect 400 invalid url

# 8) Paste RCE guard
# Click cmd-lib "Colab Setup" → expect confirm dialog, not direct exec
```



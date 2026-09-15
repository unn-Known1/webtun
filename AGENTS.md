# WebTun — Agent Instructions

**Repo**: `github.com/unn-Known1/webtun` — maintained by [Gaurang Patel](https://github.com/unn-Known1) (unn-Known1) — ptelgm.yt@gmail.com

**Audit status**: the 2026-09-14 audit (`CODEBASE_AUDIT_REPORT.md`, v2.0.5) is fully remediated — all 113 actionable findings landed. That file is historical input, not a backlog: do not re-file a finding that `git log` shows was already fixed, and do not implement anything in its *Intentional by design* table (those are deliberate product decisions — empty PIN, full-FS default, token in URL for WS/`img`/`iframe`, etc.).

## Entrypoints
- **Server**: `node server.js` (Express + WebSocket + node-pty)
- **CLI**: `bin/webtun.js` — parses flags (`--port`, `--host`, `--pin`, `--tunnel`, `--help`, `--version`), loads `.env`, spawns `server.js`
- **Electron**: `electron/main.js` (forks `server.js` as child process, `HOST=127.0.0.1`)
- **Frontend**: `public/index.html` — vanilla HTML/CSS/JS, no bundler. xterm.js + CodeMirror loaded from CDN (all `<script defer>`).

## Commands
| Action | Command |
|--------|---------|
| Run server | `npm start` |
| Dev (nodemon) | `npm run dev` — honours `nodemon.json`, which ignores runtime state files (`.tunnels.json`/`.cmdhist.json`) so their writes don't restart the server |
| Stop server | `./stop.sh` |
| Setup (first time) | `./setup.sh` (installs Node ≥18, cloudflared, npm deps, optional systemd) |
| Rebuild node-pty | `npm run rebuild:pty` (manual — no install hook runs it) |
| Electron dev | `npm run electron` |
| Build Electron (Linux) | `npm run dist:linux` |
| Build Electron (Windows) | `npm run dist:win` |
| Build Electron (macOS) | `npm run dist:mac` |
| Build all platforms | `npm run dist` |

No test, lint, or typecheck commands exist. Verify changes via `npm start`.

## Config
`.env` controls: `PORT` (default 3000), `HOST`, `PIN`, `SHELL`, `WORKSPACE_ROOT` (defaults to `os.homedir()`).

Optional env vars:
- `TRUST_PROXY=true` — trust `X-Forwarded-For` from first proxy (default: loopback only)
- `WEBTUN_SHELL` — override shell on Windows (default: PowerShell; set to `/usr/bin/bash` for Git Bash)
- `ALLOWED_ORIGINS` — comma-separated extra WebSocket origins for reverse-proxy/custom hostnames (same-origin is always allowed). Without it, `ALLOWED_WS_ORIGINS` stays empty and only same-origin WS upgrades pass.
- `PREVIEW_PORTS` — comma-separated allow-list for app preview targets; unset means any port except WebTun's own.
- `JSON_LIMIT` note: the global JSON body limit is **2 MB**; only `POST /api/files/write` gets 12 MB (`LARGE_JSON_ROUTES` in `server.js`). Add a path there before raising the global limit.

PIN auth via `x-pin-token` header or `?token=` query param. Empty `PIN=` means no auth. Quoted values in `.env` are stripped (e.g., `PIN="secret"` works).

## Key Details
- **`scripts/rebuild-pty.js`** (manual `npm run rebuild:pty`) rebuilds `node-pty` if its native binding is missing. It never downloads anything and is deliberately not a postinstall hook, so the package ships zero install scripts.
- **cloudflared on demand** (`lib/cloudflared.js`): the binary is fetched on first tunnel use only (tunnel API / `webtun --tunnel`), HTTPS-only from official Cloudflare releases, with tar-slip + HTML-page validation. `findCloudflared()` is re-exported by `server.js` for back-compat.
- **Tunnel cleanup** after server restart: `kill $(pgrep -f 'cloudflared tunnel')`
- **System stats** (`GET /api/system`) are cached 2 s server-side (`SYS_STATS_TTL_MS`); the frontend has a matching client-side memo (`fetchSystemStats()`) shared by the launchpad pulse, the header sys icon and the stats panel. Poll them through that helper, never `api('/api/system')` directly.
- **Build output**: `dist/` (AppImage, deb, dmg, exe, zip), `release/`. Git-ignored.
- **CI**: GitHub Actions builds Electron packages on `v*` tag push (Linux, macOS, Windows). A `verify` job gates every build: version/lockfile sync, `npm pack --dry-run`, `require('./server.js')` smoke test, `npm audit --omit=dev`. Release job uploads explicit asset globs (`*.exe`, `*.AppImage`, `*.deb`, `*.dmg`, `*.zip`), fails on missing files.
- **Release checklist**: `npm version <patch|minor|major>` (bumps `package.json` **and** `package-lock.json`, commits, creates the `vX.Y.Z` tag) → `git push --follow-tags` (tag MUST have the `v` prefix or CI ignores it) → `npm publish` (manual).
- **A changelog entry describes a *release*, not a working tree**: a `### vX.Y.Z` heading in `README.md` must correspond to a real tag, or it advertises a version nobody can install. 2.0.5 was bumped and documented but never tagged or published, so its changes had to be folded into 2.1.0. Check `git describe --tags --abbrev=0` before writing a heading; skipping versions entirely is fine (`v2.0.4` → `v2.1.0`).
- **Version guard** (`verify-version.js`, `npm run version:check`): fails when `package.json`, `package-lock.json` and a `v*` tag disagree. It also runs via `prepublishOnly`, so publishing with a stale lockfile is refused rather than silently shipping a mismatched tarball.
- **npm tarball contents**: the `files` whitelist plus npm's always-included set (`package.json`, `README.md`, `LICENSE`, and the `main` entry). LICENSE/README ship **without** being listed in `files` — verify with `npm pack --dry-run` before "fixing" that. `robots.txt`/`sitemap.xml` are GitHub Pages assets for the published docs site (they reference the `github.io` URL), deliberately not part of the tarball.
- **Systemd**: `setup.sh` optionally creates `/etc/systemd/system/webtun.service`.
- **CSP** in `server.js` allows CDN scripts from `cdn.jsdelivr.net`.
- **File API** workspace root: `WORKSPACE_ROOT` env var, falls back to `os.homedir()`.
- `public/sw.js` enables PWA installability. Cache `webtun-v6` (precaches `/`, `/index.html`, `/docs.html`, `/manifest.json`, `/commands.js`, `/favicon.png`, `/icon.svg`, `/icon-192.png`, `/icon-512.png`, added per-entry so one missing asset can't empty the cache); client `registerSW()` toasts on `updatefound` + `skipWaiting` (no auto-reload — live terminal). Bump `CACHE` whenever `PRECACHE` changes, or the new entries never install.
- **Favicon/Icons**: `public/favicon.png` (32px), `public/icon-192.png` (192px), `public/icon-512.png` (512px), `public/icon.svg` — all generated from the same terminal SVG logo.
- **Safe localStorage** (`public/index.html:979`): `safeStorage` wrapper catches errors when Edge Tracking Prevention blocks storage on Cloudflare tunnel domains. All `localStorage` calls go through this wrapper.
- **Editor drafts** (`public/index.html`): autosave writes `wt-draft:<path>` 2 s after an edit; `openFileEditor()` offers to restore it when it differs from disk; `saveFile()` and an explicit discard in `closeEditor()` purge it. Do not remove any of those three without also dropping the auto-draft claim in `/docs`.
- **Crash semantics** (`server.js`): both `uncaughtException` and `unhandledRejection` log, run `cleanup()`, and `exit(1)` — an unhandled rejection deliberately no longer swallows the error and keeps running.
- **User guide** (`public/docs.html`, served at `/docs`, published to GitHub Pages from repo root — root `.nojekyll` required, do not remove): whenever you add, change, or remove a user-facing feature, update `/docs` in the same change (new section/bullet/FAQ + TOC link + `data-title` keywords). Keep it single-file, zero-dependency, offline-safe (no CDN). Keep asset paths relative and app links on `a.app-link` with `href="/"` (auto-rewritten to the repo URL on `github.io`); no other root-absolute `/…` URLs in that file or they break on Pages.

## Frontend Architecture

### UI Conventions
- **Fonts**: `--font-ui` = IBM Plex Sans (chrome: buttons, inputs, labels, panels), `--font` = JetBrains Mono (code/path surfaces: `.file-name`, `#path-input`, `#file-breadcrumb`, `#editor-filename`, `.tunnel-url`, `.cmd-lib-cmd`, `.cmd-hist-cmd`).
- **CDN scripts are deferred** (`<script defer>`). Don't rely on them at parse time; lazy-init (CodeMirror via `initCodeMirror()`, `marked` guarded by `typeof marked !== 'undefined'`). Terminal init happens after async unlock, so xterm is available.
- **Themes**: all 6 themes define explicit `color-scheme`. `:root`/`data-theme="tokyonight"` share the same palette. Keep every theme's `--fg1/2/3` WCAG-AA readable.
- **Shared UI helpers** (all in `public/index.html`):
  - `setBtnBusy(btn, busy)` + `.btn.loading` — spinner state for async buttons
  - `showFieldError(id, msg)` / `clearFieldError(id)` + `.field-error` — inline field errors
  - `updateEditorDirty()` + `.editor-dirty` dot on `#editor-filename-wrap`
  - `openShortcuts()` — Keyboard Shortcuts dialog (`#shortcuts-overlay`)
  - `resetSettings()` — restores `DEFAULT_SETTINGS`
  - `hideTermLoading(tab)` / `tab.loadingEl` — terminal "Connecting…" overlay
  - `setupMoreMenuKeyboard()` — arrow/Home/End/Escape nav in overflow menu
- **Dialogs**: `openOverlay(id)` sets `role="dialog"`, `aria-modal="true"`, `aria-labelledby` from the modal `h2`. Overlays without an `h2` need `aria-label`.
- **Toasts**: `toast(msg, type)` supports `info|success|warning|error` with icons; stack capped at 4.
- **Security header UI** (all in `public/index.html`): `#security-alert-btn` + `#security-alert-count` — persistent triangle for unreviewed logins (`wt-security-alerts` in storage, cleared by `openSecurityReview()`); `#sess-cup-num` — live session count drawn on the keep-awake cup (`updateSessionCupCount()`); `handleClientEvent()` handles `0x03` pushes (approve/deny modals via `confirmDialog`, pending rows in `refreshSessions()`).

### Terminal
- **xterm.js** with addons: fit, search, web-links, unicode11, webgl (canvas fallback)
- **CodeMirror** with modes: javascript, python, htmlmixed, xml, css, clike, shell, markdown, yaml, sql, go, rust, properties. Requires `simple.min.js` addon for rust mode.
- **WebSocket binary protocol** (not JSON):
  - Server→Client: `0x00` data, `0x01` exit (1B code), `0x02` error, `0x03` event (JSON: `new-login` alerts, `session-revoked` kicks — handled by `handleClientEvent()`)
  - Client→Server: `0x00` input (chunked ≤60KB via `sendWsInput()`), `0x01` resize (4B: cols/rows uint16LE), `0x02` ping
- **xterm textarea**: Each terminal gets a unique `id="xterm-helper-{tabId}"` for accessibility.
- **Editor preview iframe**: `sandbox="allow-scripts"` (opaque origin — no `allow-same-origin`). Markdown + Safe-mode HTML previews require DOMPurify (CDN); Safe render is refused when it's missing. Full HTML mode (`htmlFullPreview`, per-file, Safe default) renders raw bytes verbatim — scripts run, but the frame stays opaque-origin with no storage/popups/top-navigation, and asset URLs are still rewritten through the authed image endpoint.

### File tabs
- **Third tab type**: `tabs[]` entries carry `type: 'term' | 'preview' | 'file'`; a file tab adds `path`, `viewer` (`text|image|pdf|epub|office` from `fileTabViewerKind()`), `cm`, `original`, `seed`, `viewState`, `dirty`. `newFileTab(path)` dedupes by path, caps at `MAX_FILE_TABS` (10), and persists via `saveTabState()` (`type:'file'` entries store `path`; restore reopens them parked and re-activates the last tab).
- **Text tabs own a real CodeMirror** (`ensureTabEditor(tab, seed)` → `tab.cm`), which is what lets Tile view show several code files at once; `layoutTiles()` mounts every text tab when tiles mode is on. Switching tabs never re-reads or re-renders. Per-tab chrome is built by `buildTabEditorChrome()`: dirty dot, name, status, **Save** (Ctrl+S → `saveTabFile`), **Reload** (`reloadTabFile`, disk only — never offers the draft again), **Panel** (`moveTabToPanel`, carries buffer+history into the split panel). `markTabDirty()` mirrors the dot on the tab strip (`.tab.has-dirty`); `scheduleTabDraft()` reuses the panel's `wt-draft:<path>` keys and 2s debounce, so drafts are interchangeable between surfaces.
- **The split panel is *relocated*, not re-implemented** — but only for the heavy viewers (PDF/EPUB/Office), which hold whole documents in memory and so stay **single-live**: `dockEditorToTab(tab)` *moves* `#editor-view` into that tab's `.file-tab-body`, `undockEditor()` moves it back to its park position (`_editorParkParent`/`_editorParkNext`). All five openers, ids and toolbars thus keep working. Invariants: `_dockedFileTabId` is the owner; `body.editor-docked` hides the split handle; `mountFileTab()` returns early when the tab already owns the live viewer (re-opening would re-fetch the doc and lose scroll). A parked heavy tab shows an “Open” card; **image tabs render their own `<img>`** (`mountImageIntoTab`, blob URL revoked on close).
- **Shared read path**: `readTextForEditor(path)` owns the binary/size guards and the draft-restore prompt for *both* surfaces; `showTextInPanel(path, content, original, history)` installs a buffer into the panel. **Never write buffer A to path B**: `openFileAsTab(path)` is the single entry point (header button + `#ctx-open-tab`) and carries the panel's live buffer over when the paths match; `openFileEditor()` focuses an existing tab for the same path and redirects a *different* file opened while a tab is docked into its own tab; `mountFileTab()` calls `abandonFileTab()` when an opener refused the file (`editorPath !== tab.path` — every opener sets `editorPath` before its async work). `releasePanelSurface()` blanks the panel after a handover so one path is never editable in two surfaces (they would diverge, last save wins).
- **`closeTab(e, id, opts)`** is type-aware: per-tab dirty check against `tab.cm`, `opts.force` skips both prompts (used by `moveTabToPanel`, which has taken ownership of the buffer), undock + `cleanupDocViewers()` + `releaseFileTabResources()` (nulls `tab.cm`, clears the draft timer), and no WS/session teardown for file tabs. CodeMirror `Esc` and the panel × route through `closeEditor()` into `closeTab()` when a heavy tab is docked.

### Command History
- **Keystroke tracking** (client-side): `sendInput()` maintains `tab._currentInput` buffer tracking typed characters.
- **Escape sequence filtering**: ESC sequences (CSI, SS3, OSC, DCS) are skipped entirely. Control characters (0x00–0x1F, 0x7F) are dropped.
- **VT parameter cleanup**: Patterns like `>0;276;0` (Device Attributes responses) are stripped before saving.
- **Server-side storage**: `POST /api/history` saves to `cmdHistory` array (max configurable). `GET /api/history` returns list.

### Session Persistence
- **tmux sessions**: When tmux is available, WS `session` query param attaches to a `wt-webtun-{id}` tmux session. Cleaned on server exit and startup (`cleanupOrphanTmuxSessions`, namespaced prefix only).
- **In-memory PTY persistence**: When tmux is unavailable (e.g. Windows), the server keeps PTY processes alive in a `ptySessions` Map across WebSocket disconnects and reattaches on reconnect. Same lifecycle as tmux: sessions are lost on server restart.

## Architecture Notables

- **Tunnel persistence** (`server.js`): `.tunnels.json` persists cloudflared tunnel info across restarts. On startup, loads file and validates PIDs are still cloudflared processes.
- **Rate limiting** (`server.js`): in-memory, per-IP. Auth: 5 req/10s (stricter). `/api/search`: 20 req/10s.
- **File API routes** (`server.js`): all under `checkPin` middleware.
  - `GET /api/files?path=` — list directory
  - `GET /api/files/read?path=` — read file content
  - `POST /api/files/write` — write file
  - `POST /api/files/upload?path=` — multer upload (500MB limit, 100 files)
  - `GET /api/files/download?path=` — single file or directory-as-zip download
  - `GET /api/files/image?path=` — stream image for inline viewing
  - `POST /api/files/rename` — rename file/folder
  - `POST /api/files/copy` / `move` — with conflict resolution (`replace`, `skip`, `keep_both`, `merge`, `cancel`)
  - `DELETE /api/files?path=` — delete file or recursive directory
  - `POST /api/files/mkdir` / `touch` — create directory / empty file
  - `POST /api/files/zip` / `unzip` — create or extract zip archives
  - `GET /api/search?q=&path=` — async file search (max depth 4, max 50 results)
- **Auth endpoint**: `POST /api/auth` (`{pin, device}`) issues a revocable 64-hex session token — `active` immediately when nobody else is signed in, else `pending` until a different active session approves it via `POST /api/auth/sessions/:id/approve` (deny = `DELETE`, i.e. revoke; pending lapses after 5min). Pending tokens can only poll `GET /api/auth/me` (and cancel themselves); remote raw-PIN callers are gated the same way (loopback always trusted). Broadcasts `new-login` / `session-pending` to WS clients; raw PIN still accepted everywhere for back-compat. `GET /api/auth/required`; `GET /api/auth/me` (resume trusted devices); `GET /api/auth/sessions` (list with `current` flag + pending rotation); `DELETE /api/auth/sessions/:id` (revoke + `session-revoked` push to that client's sockets). `POST /api/pin` (`{currentPin, newPin}`) sets/changes/disables the PIN at runtime under `checkPin` + auth limiter — instant for trusted callers (session ≥10min, sole session, first setup), else 60s pending approval via `POST /api/pin/approve` / `veto` (a different session must decide; expiry denies + kicks requester). Rotation revokes all sessions and persists to the writable `.env` (repo-local `__dirname/.env`, else `~/.config/webtun/.env`, atomic 0600 write). Session tokens persist in browser `localStorage` (`wt-session-token` = trusted device). First PIN setup on an open instance is loopback-only. `POST /api/system/kill` requires PIN protection to be enabled.
- **Runtime state dir**: `DATA_DIR` = `__dirname` for repo checkouts, else `$XDG_CONFIG_HOME/webtun` / `~/.config/webtun` (global/npx installs). Holds `.env`, `.cmdhist.json` (`{max, items}` — a legacy bare array is still readable, so the history cap survives restarts), `.tunnels.json` (entries carry `startKey`, the process start time, so a recycled PID can't pass as a live tunnel), `tunnel-url.txt`. The legacy-location migration runs from `migrateLegacyState()` inside `startServer()` — not at import — so `require('./server.js')` does not copy files into the user's config dir.
- **Error responses are sanitized centrally** (`server.js`): `redactPaths` → `safeErr(e, fallbackStatus)` → `sendErr` / `errText` / `gitErrText`. Raw filesystem messages become fixed code-derived sentences (`ENOENT` → "Path not found") and absolute paths are redacted; full detail goes to the server log only. Route handlers should call `sendErr(res, e)` rather than hand-building `{ error: e.message }`.
- **Tunnel watchdog backoff**: the 30s liveness sweep retries a dead tunnel with exponential backoff (30s → 60s → 120s → 240s → 300s cap), gives up after 5 attempts, and marks the entry `dead` (surfaced by `GET /api/tunnel`) so it stops churning. The sweep interval is `unref`ed.
- **History endpoint**: `GET /api/history`, `POST /api/history`, `DELETE /api/history`, `DELETE /api/history/:index` — all under `checkPin`.
- **Git endpoints** (`server.js`): all under `checkPin` + rate limiter; a missing `git` binary returns **501** (not 400) so clients can tell "no git" from "not a repo"; no-shell `git -C <root>` via `spawnRead` (supports `opts.input` for stdin, e.g. `git apply`), file args validated inside repo root (repo-root itself rejected).
  - `GET /api/git/status?path=` — repo detect (`rev-parse`), porcelain `-b` parse, 20s timeout for large repos
  - `GET /api/git/diff?path=&file=[&cached=1][&head=1]` — capped 200KB, binary flag (`head=1` diffs vs HEAD so conflicts show)
  - `GET /api/git/log?path=[&n=]` — last 1-20 commits; `GET /api/git/show?path=&ref=` — commit detail, ref verified via `rev-parse --verify <ref>^{commit}`, capped 200KB
  - `GET /api/git/hunks?path=&file=[&cached=1]` — per-hunk split (cap 200 hunks / 200KB); `POST /api/git/stage-hunk` / `unstage-hunk` — `{path, file, index}` (server re-derives the patch; client never sends patch content)
  - `POST /api/git/stage` / `unstage` / `discard` — `{path, files[]}` max 100 files
  - `POST /api/git/commit` — `{path, message≤1000, all}`; `POST /api/git/amend` — `{path, message?}` (`--no-edit` when empty)
  - `GET` + `POST /api/git/identity` — repo-local author name/email (validated, email format-checked)
  - `POST /api/git/pull` — `{path, mode: merge|rebase|ff-only}`; `POST /api/git/push` — `{path, upstream?}` (`push -u origin HEAD` on consent); `POST /api/git/fetch` — 60s timeout (frontend uses 90s raw fetch, `api()` caps at 30s)
  - `GET /api/git/branches`, `POST /api/git/switch` / `branch` (names via `check-ref-format`); `GET /api/git/tags`, `POST /api/git/tag` / `untag` (tags via `check-ref-format refs/tags/…`)
  - `GET /api/git/stash`, `POST /api/git/stash`, `POST /api/git/stash/pop` (`{ref?}` validated `stash@{n}`); `POST /api/git/reset` (`{mode: mixed|soft|hard, ref?}` verified to a commit); `POST /api/git/init`
- **Startup cleanup**: loads persisted tunnels, kills orphan `wt-webtun-*` tmux sessions.
- **Filesystem access**: full filesystem by design (`ALLOW_FULL_FS` defaults to `true`; set `ALLOW_FULL_FS=false` to restrict the File API to `WORKSPACE_ROOT` via `pathContained()`). Terminal shells are always unconfined.
- **Cross-platform**: All file operations, process management, and system commands have Windows (PowerShell), macOS (BSD tools), and Linux (GNU tools) code paths.

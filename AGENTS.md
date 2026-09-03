# WebTun — Agent Instructions

**Repo**: `github.com/unn-Known1/webtun` — maintained by [Gaurang Patel](https://github.com/unn-Known1) (unn-Known1) — ptelgm.yt@gmail.com

## Entrypoints
- **Server**: `node server.js` (Express + WebSocket + node-pty)
- **CLI**: `bin/webtun.js` — parses flags (`--port`, `--host`, `--pin`, `--tunnel`, `--help`, `--version`), loads `.env`, spawns `server.js`
- **Electron**: `electron/main.js` (forks `server.js` as child process, `HOST=127.0.0.1`)
- **Frontend**: `public/index.html` — vanilla HTML/CSS/JS, no bundler. xterm.js + CodeMirror loaded from CDN (all `<script defer>`).

## Commands
| Action | Command |
|--------|---------|
| Run server | `npm start` |
| Dev (nodemon) | `npm run dev` |
| Stop server | `./stop.sh` |
| Setup (first time) | `./setup.sh` (installs Node ≥18, cloudflared, npm deps, optional systemd) |
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

PIN auth via `x-pin-token` header or `?token=` query param. Empty `PIN=` means no auth. Quoted values in `.env` are stripped (e.g., `PIN="secret"` works).

## Key Details
- **`postinstall.js`** auto-downloads `cloudflared` to `/usr/local/bin/cloudflared` if missing.
- **Tunnel cleanup** after server restart: `kill $(pgrep -f 'cloudflared tunnel')`
- **Build output**: `dist/` (AppImage, deb, dmg, exe, zip), `release/`. Git-ignored.
- **CI**: GitHub Actions builds Electron packages on `v*` tag push (Linux, macOS, Windows). All artifacts are uploaded to the release.
- **Systemd**: `setup.sh` optionally creates `/etc/systemd/system/webtun.service`.
- **CSP** in `server.js` allows CDN scripts from `cdn.jsdelivr.net`.
- **File API** workspace root: `WORKSPACE_ROOT` env var, falls back to `os.homedir()`.
- `public/sw.js` enables PWA installability.
- **`cloakbrowser`** and **`playwright-core`** in `dependencies` are unused in the codebase.
- **Favicon/Icons**: `public/favicon.png` (32px), `public/icon-192.png` (192px), `public/icon-512.png` (512px), `public/icon.svg` — all generated from the same terminal SVG logo.
- **Safe localStorage** (`public/index.html:979`): `safeStorage` wrapper catches errors when Edge Tracking Prevention blocks storage on Cloudflare tunnel domains. All `localStorage` calls go through this wrapper.

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

### Terminal
- **xterm.js** with addons: fit, search, web-links, unicode11, webgl (canvas fallback)
- **CodeMirror** with modes: javascript, python, htmlmixed, xml, css, clike, shell, markdown, yaml, sql, go, rust, properties. Requires `simple.min.js` addon for rust mode.
- **WebSocket binary protocol** (not JSON):
  - Server→Client: `0x00` data, `0x01` exit (1B code), `0x02` error
  - Client→Server: `0x00` input (max 64KB), `0x01` resize (4B: cols/rows uint16LE), `0x02` ping
- **xterm textarea**: Each terminal gets a unique `id="xterm-helper-{tabId}"` for accessibility.
- **Editor preview iframe**: `sandbox="allow-same-origin allow-scripts"` — scripts required for CodeMirror rendering.

### Command History
- **Keystroke tracking** (client-side): `sendInput()` maintains `tab._currentInput` buffer tracking typed characters.
- **Escape sequence filtering**: ESC sequences (CSI, SS3, OSC, DCS) are skipped entirely. Control characters (0x00–0x1F, 0x7F) are dropped.
- **VT parameter cleanup**: Patterns like `>0;276;0` (Device Attributes responses) are stripped before saving.
- **Server-side storage**: `POST /api/history` saves to `cmdHistory` array (max configurable). `GET /api/history` returns list.

### Session Persistence
- **tmux sessions**: When tmux is available, WS `session` query param attaches to a `wt-{id}` tmux session. Cleaned on server exit and startup (`cleanupOrphanTmuxSessions`).
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
- **Auth endpoint**: `POST /api/auth` and `GET /api/auth/required` — rate-limited separately. `POST /api/pin` (`{currentPin, newPin}`) sets/changes/disables the PIN at runtime under `checkPin` + auth limiter; persists to `__dirname/.env` (atomic 0600 write).
- **History endpoint**: `GET /api/history`, `POST /api/history`, `DELETE /api/history`, `DELETE /api/history/:index` — all under `checkPin`.
- **Git endpoints** (`server.js`): all under `checkPin`; no-shell `git -C <root>` via `spawnRead`, file args validated inside repo root.
  - `GET /api/git/status?path=` — repo detect (`rev-parse`), porcelain `-b` parse (rate-limited)
  - `GET /api/git/diff?path=&file=[&cached=1]` — capped 200KB, binary flag (rate-limited)
  - `GET /api/git/log?path=[&n=]` — last 1-20 commits (rate-limited)
  - `POST /api/git/stage` / `unstage` — `{path, files[]}` max 100 files
  - `POST /api/git/commit` — `{path, message≤1000, all}`; `POST /api/git/pull` / `push` — 60s timeout (frontend uses 90s raw fetch, `api()` caps at 30s)
- **Startup cleanup**: loads persisted tunnels, kills orphan `wt-webtun-*` (and legacy `wt-*`) tmux sessions.
- **Workspace sandbox**: `ALLOW_FULL_FS` (default `false` restricts to `WORKSPACE_ROOT`), enforced via `pathContained()`.
- **Cross-platform**: All file operations, process management, and system commands have Windows (PowerShell), macOS (BSD tools), and Linux (GNU tools) code paths.

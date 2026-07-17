# WebTun — Agent Instructions

**Repo**: `github.com/unn-Known1/webtun` — maintained by [Gaurang Patel](https://github.com/unn-Known1) (unn-Known1) — ptelgm.yt@gmail.com

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

## Entrypoints
- **Server**: `node server.js` (Express + WebSocket + node-pty)
- **Electron**: `electron/main.js` (forks `server.js` as child process, `HOST=127.0.0.1`)
- **Frontend**: `public/index.html` — vanilla HTML/CSS/JS, no bundler. xterm.js + CodeMirror loaded from CDN.

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
- **CSP** in `server.js:136` allows CDN scripts from `cdn.jsdelivr.net`.
- **File API** workspace root: `WORKSPACE_ROOT` env var, falls back to `os.homedir()`.
- `public/sw.js` enables PWA installability.
- **`cloakbrowser`** and **`playwright-core`** in `dependencies` are unused in the codebase.

## Architecture Notables

- **WebSocket binary protocol** (`server.js:1254-1265`): terminal I/O uses a custom binary protocol, not JSON.
  - Server→Client: `0x00` data, `0x01` exit (1B code), `0x02` error
  - Client→Server: `0x00` input (max 64KB), `0x01` resize (4B: cols/rows uint16LE), `0x02` ping
- **Session persistence via tmux** (`server.js:1315-1335`): when WS `session` query param is set, terminal attaches to a `wt-{id}` tmux session. Sessions survive page reload. Cleaned on server exit and startup (`cleanupOrphanTmuxSessions`).
- **Tunnel persistence** (`server.js:1554-1600`): `.tunnels.json` persists cloudflared tunnel info across restarts. On startup, loads file and validates PIDs are still cloudflared processes.
- **Rate limiting** (`server.js:88-109`): in-memory, per-IP. Auth: 5 req/10s (stricter). `/api/search`: 20 req/10s.
- **File API routes** (`server.js:417-1050`): all under `checkPin` middleware.
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
- **Auth endpoint**: `POST /api/auth` and `GET /api/auth/required` — rate-limited separately.
- **REST command execution**: `POST /api/exec` (with timeout, max 10MB output, 300s max timeout) and `GET /api/exec/stream` (SSE streaming).
- **Startup cleanup** (`server.js:1813-1814`): loads persisted tunnels, kills orphan `wt-*` tmux sessions.
- **Cross-platform**: All file operations, process management, and system commands have Windows (PowerShell), macOS (BSD tools), and Linux (GNU tools) code paths.

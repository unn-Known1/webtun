# WebTun — Agent Instructions

**Repo**: `github.com/unn-Known1/webtun` — maintained by [Gaurang Patel](https://github.com/unn-Known1) (unn-Known1) — ptelgm.yt@gmail.com

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

PIN auth via `x-pin-token` header or `?token=` query param. Empty `PIN=` means no auth.

## Key Details
- **`postinstall.js`** auto-downloads `cloudflared` to `/usr/local/bin/cloudflared` if missing.
- **Tunnel cleanup** after server restart: `kill $(pgrep -f 'cloudflared tunnel')`
- **Build output**: `dist/` (AppImage, deb, dmg, exe, zip), `release/`. Git-ignored.
- **CI**: GitHub Actions builds Electron packages on `v*` tag push (Linux, macOS, Windows). All artifacts are uploaded to the release.
- **Systemd**: `setup.sh` optionally creates `/etc/systemd/system/webtun.service`.
- **CSP** in `server.js:33` allows CDN scripts from `cdn.jsdelivr.net`.
- **File API** workspace root: `WORKSPACE_ROOT` env var, falls back to `os.homedir()`.
- `public/sw.js` enables PWA installability.
- **`cloakbrowser`** and **`playwright-core`** in `dependencies` are unused in the codebase.

## ⚠️ Agent Rules (from user feedback)

1. **NEVER assume git identity or credentials** — always ask the user for their name and email before setting git config or committing. The user's info: `unn-Known1 <ptelgm.yt@gmail.com>`.
2. **"Noted" means write it to AGENTS.md** — don't say "noted" without actually saving the information here.
3. **Don't guess URLs, paths, or config values** — ask first.
4. **Keep the server running** — don't kill or interrupt the port.

## Architecture Notables

- **WebSocket binary protocol** (`server.js`): terminal I/O uses a custom binary protocol, not JSON.
  - Server→Client: `0x00` data, `0x01` exit (1B code), `0x02` error
  - Client→Server: `0x00` input (max 64KB), `0x01` resize (4B: cols/rows uint16LE), `0x02` ping
- **Session persistence via tmux**: when WS `session` query param is set, terminal attaches to a `wt-{id}` tmux session. Sessions survive page reload. Cleaned on server exit and startup.
- **Tunnel persistence**: `.tunnels.json` persists cloudflared tunnel info across restarts. On startup, loads file and validates PIDs are still cloudflared processes.
- **Rate limiting**: in-memory, per-IP. Auth: 5 req/10s (stricter). `/api/exec`: 10 req/10s. `/api/search` + `/api/files/search-content`: 20 req/10s.
- **Auth**: `POST /api/auth`, `GET /api/auth/required` — PIN-based, constant-time comparison. `x-pin-token` header or `?token=` query param.
- **All File API routes** under `checkPin` middleware. Every write endpoint guards against missing path and WORKSPACE_ROOT. Logs usage hints via `console.warn` on bad requests.
  - `GET /api/files?path=` — list directory
  - `GET /api/files/read?path=` — read file content
  - `POST /api/files/write` — write file `{ path, content }`
  - `POST /api/files/upload?path=` — multer upload (500MB limit, 100 files)
  - `GET /api/files/download?path=` — single file or directory-as-zip download
  - `GET /api/files/image?path=` — stream image for inline viewing
  - `GET /api/files/stat?path=` — file metadata (owner, group, permissions, type)
  - `GET /api/files/preview?path=` — smart preview (md→html, code with language, text)
  - `GET /api/files/tail?path=&lines=&interval=` — SSE live log tail
  - `POST /api/files/rename` — rename `{ oldPath, newName }`
  - `POST /api/files/copy` — copy `{ source, destination, conflict? }`
  - `POST /api/files/move` — move `{ source, destination, conflict? }`
  - `DELETE /api/files?path=` — delete file or recursive directory
  - `POST /api/files/mkdir` — create dir `{ path }`
  - `POST /api/files/touch` — create file `{ path }`
  - `POST /api/files/zip` — create zip `{ path }`
  - `POST /api/files/unzip` — extract zip `{ path }`
  - `POST /api/files/batch-delete` — bulk delete `{ paths: [...] }`
  - `POST /api/files/batch-copy` — bulk copy `{ sources: [...], destination, conflict? }`
  - `POST /api/files/batch-move` — bulk move `{ sources: [...], destination, conflict? }`
  - `POST /api/files/chmod` — change perms `{ path, mode }`
  - `POST /api/files/symlink` — create symlink `{ target, linkPath }`
  - `POST /api/files/search-content` — full-text search `{ query, path, pattern?, maxResults?, maxDepth? }`
  - `POST /api/files/batch-zip` — multi-source zip `{ sources: [...], destination }`
  - `POST /api/files/trash` — trash files `{ paths: [...] }`
  - `GET /api/files/trash` — list trash
  - `POST /api/files/trash/restore` — restore trash `{ path }`
  - `DELETE /api/files/trash?path=` — delete trash item permanently
  - `DELETE /api/files/trash/all` — empty entire trash
  - `GET /api/search?q=&path=` — async filename search (max depth 4, max 50 results)
- **Git API** — all under `checkPin`:
  - `GET /api/git/status?path=` — git status (parsed porcelain format)
  - `POST /api/git/diff` — `{ path, file? }`
  - `POST /api/git/add` — `{ path, files? }` (defaults to `.`)
  - `POST /api/git/commit` — `{ path, message }`
  - `GET /api/git/log?path=&maxCount=` — structured log (hash, author, date, message)
  - `POST /api/git/push` — `{ path, remote?, branch? }`
  - `POST /api/git/pull` — `{ path, remote?, branch? }`
  - `GET /api/git/branches?path=` — list branches with current marker
  - `POST /api/git/branch` — `{ path, name, switch? }` (create or checkout -b)
  - `GET /api/git/remote?path=` — list remotes with URLs
- **REST command execution**: `POST /api/exec` (with timeout, max 10MB output, 300s max timeout) and `GET /api/exec/stream` (SSE streaming).
- **System**: `GET /api/system` (CPU, memory, disk, processes), `GET /api/system/network` (interfaces, gateway, DNS, listening ports), `GET /api/home` (home dir, hostname, platform), `GET /api/env` (env vars with secret redaction).
- **Clipboard**: server-side staging for copy/cut/paste.
  - `GET /api/clipboard` — view clipboard
  - `POST /api/clipboard` — set `{ sources: [...], action: "copy"|"cut" }`
  - `POST /api/clipboard/paste` — paste `{ destination, conflict? }`
  - `DELETE /api/clipboard` — clear clipboard
- **Tunnels**: `GET /api/tunnel`, `POST /api/tunnel { url }`, `DELETE /api/tunnel { id }` — cloudflared tunnel management. Persisted to `.tunnels.json`.
- **Startup cleanup**: loads persisted tunnels, kills orphan `wt-*` tmux sessions.

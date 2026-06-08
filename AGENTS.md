# WebTun — Agent Guide

**Repo**: `unn-Known1/webtun` — maintainer `unn-Known1 <ptelgm.yt@gmail.com>`
**What it is**: Self-hosted web file manager + terminal + tunnel, deployable as Node server or Electron app. Single-page vanilla frontend, Express backend, WebSocket shell.

---

## 1. Setup & Running

```bash
npm install          # install deps (also runs postinstall.js)
npm start            # starts on PORT (default 3000) or .env port
npm run dev          # nodemon auto-restart
./setup.sh           # first-time: installs Node 18+, cloudflared, npm deps, optional systemd
./stop.sh            # kill server
```

- **No test/lint/typecheck commands exist.** This means verification is manual: `npm start`, test the API with curl, check browser console.
- `postinstall.js` auto-downloads `cloudflared` to `/usr/local/bin/cloudflared`. If tunnel features fail, check it's there.
- The server requires Node ≥18. `setup.sh` handles installation.

---

## 2. Project Layout

```
/
├── server.js          # Express + WebSocket + node-pty. The entire backend (~2100 lines).
├── public/            # Frontend: vanilla HTML/CSS/JS. No bundler, no framework.
│   └── index.html     # Single-page app. xterm.js + CodeMirror from CDN.
├── electron/
│   └── main.js        # Electron wrapper: forks server.js as child, HOST=127.0.0.1
├── install.sh         # Legacy install (keep for compat)
├── setup.sh           # Full setup script
├── stop.sh            # Kill server
├── postinstall.js     # Auto-downloads cloudflared
├── .env               # Config (gitignored)
└── package.json       # Dependencies
```

**Key npm deps**: `express`, `ws`, `node-pty`, `multer`, `archiver`, `mime-types`, `dotenv`, `crypto` (built-in).
**Unused deps** (`package.json` but never imported): `cloakbrowser`, `playwright-core` — do not rely on them.
**CSP** (`server.js` header) allows `cdn.jsdelivr.net` — safe to add frontend CDN libs.

---

## 3. Architecture & How It Works

### Express Server (`server.js`)

The entire backend is a single file. Routes are organized top-to-bottom:
1. **Auth** (PIN, constant-time comparison) — lines ~46-64
2. **File API** — lines ~72-970 (the biggest section)
3. **Git API** — lines ~972-1130
4. **Session persistence** (tmux) — lines ~1140+
5. **WebSocket terminal** (node-pty) — lines ~1150+
6. **Exec API** (REST + SSE) — lines ~1206+
7. **System stats** — lines ~1391+
8. **Tunnel management** (cloudflared) — lines ~1492+
9. **Clipboard / Env / Network / Preview / Tail** — scattered in between

### Auth System

- No auth when `PIN` env var is empty (common in dev).
- When set: `x-pin-token` header or `?token=` query param.
- Uses `crypto.timingSafeEqual` with manual padding — not `bcrypt` or `jwt`.
- Rate-limited: 5 attempts per 10s per IP.

### WebSocket Terminal — Critical Protocol Detail

**This is NOT JSON.** The terminal uses a custom binary protocol:

| Direction | Byte | Payload | Description |
|-----------|------|---------|-------------|
| Server→Client | `0x00` | UTF-8 | Terminal output |
| Server→Client | `0x01` | 1 byte | Exit code |
| Server→Client | `0x02` | UTF-8 | Error message |
| Client→Server | `0x00` | UTF-8 (max 64KB) | User input |
| Client→Server | `0x01` | 4 bytes (cols/rows uint16LE) | Resize |
| Client→Server | `0x02` | (none) | Ping |

If you ever modify the terminal code, you **must** keep this binary protocol intact. Do not switch to JSON — it was designed this way for keystroke latency.

### tmux Session Persistence

- When WebSocket connects with `?session=<id>`, it creates/attaches a tmux session named `wt-<id>`.
- This means terminal sessions **survive page reload**. The frontend can reconnect to the same session.
- On server startup (`cleanupOrphanTmuxSessions`) and shutdown (`cleanup`), orphan `wt-*` sessions are killed.
- tmux must be installed for this to work. If `TMUX` is null, sessions are ephemeral.

### File API Patterns

All file endpoints go through `checkPin` middleware. Two path resolution functions:

- **`resolvePath(p)`** — returns `path.resolve(p)` or `WORKSPACE_ROOT` if falsy. Used for read-only ops.
- **`realPath(p)`** — same but follows symlinks via `fs.realpathSync`. Used for write ops.

**Critical safety pattern** (applied to every write/delete endpoint):
```js
if (!req.query.path) return res.status(400).json({ error: 'path is required' });
const p = realPath(req.query.path);
if (p === WORKSPACE_ROOT) return res.status(403).json({ error: 'cannot delete workspace root' });
```
Every new write endpoint **must** include these two guards. This was added after a real incident.

`WORKSPACE_ROOT` defaults to `os.homedir()` (usually `/root`). This means all paths are absolute — no relative path traversal possible.

### Rate Limiting

In-memory, per-IP (uses `x-forwarded-for` or socket remote address):
- **Auth**: 5 requests per 10 seconds
- **Exec**: 10 requests per 10 seconds
- **Search** (filename + content): 20 requests per 10 seconds
- Cleanup runs every 60 seconds to prevent memory leaks.

If adding a new endpoint that could be expensive (exec, search, large file ops), add it to the rate limiter.

### Tunnel Management

- Uses `cloudflared tunnel --url <local_url>` to create a public URL.
- `POST /api/tunnel { url }` spawns cloudflared, waits for the `*.trycloudflare.com` URL, returns it.
- Tunnels persist to `.tunnels.json` and are reloaded on server restart.
- On startup, validates the stored PID is still a cloudflared process before restoring.

### Exec API

Two modes:
- **`POST /api/exec`** — blocks until completion (max 300s timeout, max 10MB output). Returns `{ exitCode, stdout, stderr }`.
- **`GET /api/exec/stream`** — SSE endpoint. Streams stdout/stderr as `data: {"type":"stdout","data":"..."}` events.

Both use a sandboxed environment (`execEnv`) that only passes `HOME`, `USER`, `PATH`, `LANG`, `SHELL`. No other env vars leak to child processes.

---

## 4. Frontend (`public/index.html`)

- **Vanilla JS** — no React, no Vue, no bundler. All code is in one HTML file with `<script>` tags.
- **xterm.js** + **CodeMirror** loaded from CDN (via CSP-allowlisted `cdn.jsdelivr.net`).
- **File manager** — directory tree, file list, context menus, drag-and-drop upload.
- **Terminal** — WebSocket connection with the binary protocol.
- **PWA** — `public/sw.js` enables installability.

**If adding frontend features**: add inline `<script>` to `index.html` or create a separate JS file in `public/`. Do not introduce a bundler — the project deliberately avoids one.

---

## 5. Development Workflow for Agents

### Adding a new API endpoint

1. Add the route in `server.js` under the appropriate section.
2. Follow the safety pattern: guard missing params, guard WORKSPACE_ROOT.
3. Log usage hints on bad requests via `console.warn`.
4. Add it to the startup banner (`console.log` block at the bottom).
5. If expensive, add to the rate limiter.
6. Test with `curl` against the running server. Do NOT kill the port.

### Modifying the terminal

- Keep the binary protocol unchanged.
- If adding new message types, assign a new byte type (don't reuse existing ones).
- Test with the frontend terminal open in the browser.

### Git workflow

- `git config user.email` and `user.name` **before** committing. Ask the user for their info — do not guess.
- The user's identity: `unn-Known1 <ptelgm.yt@gmail.com>`.
- Use `gh auth login --with-token` if pushing (token from user).
- `git push --force-with-lease` if rebasing.

### Before committing

```bash
node -c server.js    # syntax check
npm start            # quick smoke test
```

---

## 6. Known Gotchas & Constraints

| Issue | Detail |
|-------|--------|
| **No tests** | No test framework. Manual verification only. |
| **undici TLS** | README mentions a self-signed cert issue with undici on some Node versions. |
| **Cross-device rename** | Trash endpoint falls back to copy+delete if `rename` fails (EXDEV). |
| **Binary detection** | Content search reads 4096 bytes and checks for null byte to skip binaries. |
| **Max file size** | Upload: 500MB. File read: implicit (JSON body 50MB limit). Preview: 5MB. Tail: 100MB. |
| **Rate limiter reset** | In-memory only — reset on server restart. Not suitable for production multi-instance. |
| **Tunnel dependency** | cloudflared must be on PATH. postinstall.js handles this but can fail in air-gapped envs. |
| **Windows support** | File API, terminal, and system stats all have Windows branches (`os.platform() === 'win32'`). |
| **Electron builds** | CI builds on `v*` tag push. Uploads to GitHub Releases. |

---

## 7. Agent Rules (hard constraints from user)

1. **Git identity**: Never assume or guess. Always ask the user for their name and email before committing.
2. **"Noted" is not enough**: If you say "noted", write the information in AGENTS.md immediately.
3. **No guessing**: Don't guess URLs, paths, config values, or user preferences. Ask.
4. **Don't touch the running server**: Never kill, restart, or interrupt the server port the user has running.
5. **The user wants to be asked**: When in doubt, use the `question` tool rather than deciding for them.

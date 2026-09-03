<p align="center">
  <img src="public/icon.svg" width="80" height="80" alt="WebTun">
</p>

<h1 align="center">WebTun</h1>

<p align="center">
  <strong>Self-hosted web terminal with file explorer, Cloudflare Tunnel, and PWA support</strong><br>
  Access your server from any browser — no VPN, no SSH client, no installing anything.
</p>

<p align="center">
  <a href="https://github.com/unn-known1/webtun/releases/latest"><img src="https://img.shields.io/github/v/release/unn-known1/webtun?style=flat-square&logo=github" alt="Release"></a>
  <img src="https://img.shields.io/badge/Terminal-xterm.js-2D5B8E?style=flat-square" alt="Terminal">
  <img src="https://img.shields.io/badge/PWA-Installable-6BA428?style=flat-square" alt="PWA">
  <img src="https://img.shields.io/badge/Tunnel-Cloudflare-F38020?style=flat-square" alt="Tunnel">
  <img src="https://img.shields.io/badge/Desktop-Electron-47848F?style=flat-square" alt="Electron">
  <img src="https://img.shields.io/badge/License-PolyForm_Noncommercial-6BA428?style=flat-square" alt="License">
</p>

---

## Quick Start

```bash
npx webtun
```

That's it. Open `http://localhost:3000` in your browser.

```bash
npx webtun --pin secret123        # With PIN protection
npx webtun --tunnel               # With Cloudflare Tunnel (public URL)
npx webtun -p 8080 -t             # Custom port + tunnel
npx webtun --help                 # Show all options
npx webtun --version              # Show version
```

### Install globally

```bash
npm install -g webtun
webtun
```

> **npm 12+ note:** Install scripts are blocked by default. Allow them for `node-pty`:
> ```bash
> npm install -g --allow-scripts=webtun,node-pty webtun
> ```
> Build tools required for native modules: `sudo apt-get install -y python3 make g++` (Debian/Ubuntu) or `xcode-select --install` (macOS).

### Other install methods

```bash
# One-command install
bash -c "$(curl -fsSL https://raw.githubusercontent.com/unn-Known1/webtun/main/install.sh)"

# Manual setup
git clone https://github.com/unn-Known1/webtun.git && cd webtun && ./setup.sh && npm start
```

---

## Features

### Terminal
- **Real shell sessions** — node-pty backed, full bash/zsh/PowerShell support
- **Multi-tab** — drag to reorder, side-by-side sessions, new-tab button next to last tab
- **Bracketed paste** — Ctrl+V works in TUI apps (vim, nano, htop) — 60KB chunked
- **Command history** — keystroke-based capture, strips ANSI/control sequences
- **Session persistence** — tmux or in-memory PTY; tabs survive page reload (all platforms)
- **Keyboard Shortcuts** — reference dialog in the overflow menu (Ctrl+P/T/W/B/F, etc.)

### File Explorer
- Browse, upload, download, rename, delete files — **full filesystem access** (`ALLOW_FULL_FS=true` by default)
- **Multi-select** — batch delete, download, zip, cut, copy
- **Zip/Extract** — right-click any file or folder
- **Image viewer** — preview inline (png, jpg, gif, svg, webp)
- **Conflict resolution** — replace, merge, keep both, skip
- **Unified path bar** — tappable breadcrumb segments + click current folder (or pencil) to type any path, `Enter` to go, `Esc` to cancel
- **Git mini-panel** — branch + ahead/behind badge, staged/unstaged/untracked/conflict groups with stage/unstage, colorized diffs in a read-only editor tab, commit (inline errors), push/pull, last-5 log; auto-shows inside repos
- **Editor** — CodeMirror with autosave draft, `F11` fullscreen (covers terminal area only, never the file explorer), `horizontal/vertical` split toggle, markdown/HTML preview

### Mobile
- **Touch gestures** — swipe to close tabs, pull-to-refresh
- **Mobile keyboard bar** — ESC, Tab, arrows, Ctrl combos
- **Pinch-to-zoom** — adjust font size with two fingers
- **Virtual keyboard aware** — no overlap when keyboard opens
- **Selection mode** — toggle between interaction and text selection

### Cloudflare Tunnel
- Create tunnels from the UI — zero CLI commands
- Built-in health check before tunnel creation
- Live status indicators, tunnels survive restarts
- Stop/kill tunnels from settings panel

### System Stats
- CPU, Memory, Disk, Uptime — real-time with progress bars
- GPU detection (nvidia-smi, system_profiler, WMI)
- Multi-GPU support with VRAM, utilization, temperature
- Top processes sorted by CPU — **Kill** button per row (`POST /api/system/kill`)

### Desktop (Electron)
- Cross-platform app for Linux, Windows, macOS
- Native window with system tray and file dialogs
- Build: `npm run dist:linux` / `npm run dist:win` / `npm run dist:mac`
- [Download latest release](https://github.com/unn-known1/webtun/releases/latest)

### PWA
- Install to iOS/Android home screen
- Works offline with last session state
- Install banner with iOS instructions fallback

---

## Configuration

### CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--port, -p` | Server port | `3000` |
| `--host, -h` | Bind address | `0.0.0.0` |
| `--pin` | Authentication PIN | none |
| `--tunnel, -t` | Start Cloudflare Tunnel | off |
| `--help` | Show help | — |
| `--version` | Show version | — |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `PIN` | Auth PIN (empty = no auth) | none |
| `SHELL` | Shell to use | platform default |
| `WORKSPACE_ROOT` | File explorer root | `~` |
| `ALLOW_FULL_FS` | Allow browsing outside `WORKSPACE_ROOT` (full FS) | `true` |
| `TRUST_PROXY` | Trust `X-Forwarded-For` from first proxy | `false` |
| `WEBTUN_SHELL` | Override shell on Windows | PowerShell |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla JS, xterm.js, CodeMirror, PWA |
| Backend | Node.js, Express, node-pty |
| Tunnel | Cloudflare Tunnel (cloudflared) |
| Desktop | Electron + electron-builder |
| Archives | archiver v8 + yauzl |

---

## Security

- PIN authentication on all API endpoints (`x-pin-token` header or `?token=` query)
- CSP headers restrict script sources to CDN
- WebSocket origin check prevents cross-site hijacking
- Per-IP rate limiting on auth and search endpoints
- npm audit clean — 0 known vulnerabilities

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Tunnel not loading | Check quota at [dash.cloudflare.com](https://dash.cloudflare.com) |
| Port 3000 in use | `PORT=3001 npm start` |
| Shell permission denied | `chsh -s /bin/bash` |
| Behind reverse proxy | Set `TRUST_PROXY=true` in `.env` |
| Windows shell wrong | Set `WEBTUN_SHELL=/usr/bin/bash` in `.env` |
| Tunnel persists after restart | `kill $(pgrep -f 'cloudflared tunnel')` |

---

## Changelog

### v1.5.7
- Explorer: path input + breadcrumb merged into one unified path bar (segments view, click current folder/pencil to type, `Enter` to go, `Esc`/blur to cancel); sidebar header `38px` to match the tab bar in single-row mode
- Explorer: Git mini-panel — auto-shows inside repos with branch + ahead/behind badge, staged/unstaged/untracked/conflict groups, per-file stage/unstage/diff, commit with inline errors (+ stage-all), push/pull (90s timeout), last-5 log; diffs open colorized (green/red/hunk tint) in a read-only editor tab
- Header: keep-screen-awake toggle is now an animated steaming coffee cup (glow + rising steam while active, dynamic ON/OFF tooltip)
- PDF viewer: fixed each page rendering twice (render-generation guard cancels stale loads/renders on double-click, reopen, and zoom-during-load)
- PDF viewer: lazy rendering for big PDFs — cheap placeholders for all pages in one DOM pass, first-page-fast + ±2 neighbours, `IntersectionObserver` prefetch (`1200px` margin, queue cap 30, serial pump)
- PDF viewer: streamed download progress (`Downloading… %/MB`), canvas backing store capped at ~2.5MP with `page.cleanup()`
- PDF viewer: scroll tracking, prev/next nav, and zoom now work pre-render via `pdf-wrap-*` boxes and preserve current page across zoom
- Security: `express ^4.22.2`, `qs 6.16.0` override — `npm audit` clean (0 vulnerabilities)

### v1.5.6
- Explorer: fixed preview for unsupported file types, fixed HTML preview
- PDF/EPUB preview: PDF/EPUB preview with optional CDN loader, vertical scroll, instant setup, fixed EPUB stuck and PDF page numbers sorted

### v1.5.5
- Explorer: full filesystem access by default (`ALLOW_FULL_FS=true` unless `ALLOW_FULL_FS=false`), symlink dirs now navigable (`stat` `isDirectory`), fixed silent `403` bounce on `..` (now `toast` + error div), `parent` hidden at workspace root, `history`/`breadcrumb` desync fixed (deferred to success), stale closures on reused file items fixed (`dataset` live), drag overlay stuck fixed (`relatedTarget`/`dragend`/`blur`), relative `path-input` now `joinPath(currentPath)`, `rename` dialog no longer closes on error
- Settings: drawer flicker fixed (`#main:isolation`, `#sidebar`/`#settings-panel` `will-change`/`backface-visibility`, `#file-list-wrap` `content-visibility` removed, `inert`/`focusTrap` deferred via `rAF` + `preventScroll`, `fileWatcher` skips when drawer/overlay open)
- Editor: `F11` fullscreen now `absolute` inside terminal area only (`#editor-split-area` `relative`), never covers file explorer/sidebar or header, removed `requestFullscreen` browser overlay, `CodeMirror` height `100%`
- Terminal: removed `Shift+F11` fullscreen button and `#terminals.fullscreen`/`#content.terminal-fullscreen` per request
- UI: `#conn-status` `margin-left:6px` before dot

### v1.5.4
- Security hardening: path sandbox `ALLOW_FULL_FS` (default `~`), symlink containment, null-byte/array guards, `rename` traversal block, `delete` uses `lstat`, batch caps 100, zip 1GB/unzip bomb guards, `download` header sanitization, `image` no-store, `write` 10MB cap, tunnel SSRF (localhost-only) + URL validation
- Auth & transport: `checkPin` array guard, length-leak free `constantTimeEqual`, rate limiter uses `req.ip` with `trust proxy` + Map cap 10k, `--pin` arg consumption fix, WS `cols/rows` clamp 2-500, Origin check + `constantTimeEqual` token, `sessionId` length 1-64, per-IP `clipboard`, `history` max 1k & `cmdhist.json` 0600 atomic writes, `ptySessions` TTL 30m + cap 100, `TMUX_PREFIX=wt-webtun-`
- Build: predictable `tmp` via `mkdtemp`, tar-slip `tzf` validation, heredoc `printf` no-expansion, `.env` parser first-`=` fix, `pkill $SCRIPT_DIR` + `kill -0` race, `electron` `parseInt PORT` + `autostart` filter, `ws ^8.17.1`
- UI/UX: touch 32-36px, `aria-pressed`/`aria-expanded`/`aria-modal`/`inert` (siblings), focus-trap fix, `confirmDialog` queue, `skip-link`, `pan-y` + `contain`, `visualViewport` Samsung+scale, `pull-to-refresh`, `safe-area`, `cmd-lib` trap, `tiles min(300px,100%)`, `upload 6px+cancel`, `paste 60KB`, `WebGL<4`, `iframe allow-scripts`, `autosave draft 2s` + `jsx:true`
- Explorer: `new-tab` next to last tab (sticky), `sidebar-header`/`breadcrumb` unified `30px` `3px 6px gap3`, `file-item 2→1px` `breadcrumb 1px sep`, `sidebar-footer/bookmarks` compact, folder icon + path one line `flex gap2`
- Editor: `F11` fullscreen (`fixed inset0`) + `horizontal/vertical` split toggle stays usable, `Esc` to exit, `requestFullscreen` fallback, `closeEditor` clears
- Terminal: `Shift+F11` fullscreen (`#content.terminal-fullscreen` + `#terminals.fullscreen`), header button, `fitTerm` refit
- System Stats: **Kill** `POST /api/system/kill` per-row button (refuse `1/self/cloudflared`)
- PWA: `sw.js` no immediate `skipWaiting`, `token`/`/ws` bypass, stale-while-revalidate, `manifest` `?newTerm=1` + `titlebar-area` CSS

### v1.5.3
- Terminal session persistence without tmux (in-memory PTY on Windows + Linux)
- Session IDs always generated; tabs now survive page reload on all platforms

### v1.5.2
- UI/UX audit fixes: theme-aware xterm selection color, `--fg3` across all 6 themes
- Replaced native `confirm()` with a theme-aware, focus-trapped dialog
- File explorer keyboard navigation (arrows, type-ahead, select-all) + loading state
- Mobile header overflow (more) menu; compact hostname restored on mobile
- Context menu keyboard navigation and `aria-expanded` on submenus
- SVG-ified remaining text glyphs; aria-labels on JS-generated icon buttons
- Single-line scrollable breadcrumb; tab-bar mask no longer clips new-tab
- Removed infinite keep-awake bounce; light-theme contrast bump
- `term.paste()` replaces deprecated `execCommand('insertText')`
- Pull-to-refresh indicator; tunnel rows use CSS classes
- JetBrains Mono web font + CSP `font-src`; PWA screenshots
- Fixed addon-webgl 404 (0.18.1 → 0.18.0); removed MiMo CLI default command
- Explicit Tokyo Night theme block + `color-scheme` for all 6 themes
- IBM Plex Sans UI font paired with JetBrains Mono (chrome vs code surfaces)
- Keyboard Shortcuts dialog in overflow menu; dialog `role`/`aria-modal` semantics
- Busy-spinner buttons + inline field errors (rename/new file/new folder/tunnel/save)
- Toast type icons and max 4 visible; editor unsaved-changes dot + Discard dialog
- Deferred CDN scripts for faster first paint; icon stroke-width normalized to 2
- Empty-directory quick actions; Reset settings button; skip-link + landmark roles
- Terminal connecting spinner; install banner clears mobile key bar
- Search button touch targets on coarse pointers; subtle hover on plain buttons

### v1.5.1
- Fixed command history saving terminal garbage instead of actual commands
- Fixed history 401 errors on Cloudflare tunnel URLs
- Fixed VT/ANSI parameter sequences leaking into history
- Fixed CodeMirror `defineSimpleMode` error
- Fixed console accessibility warnings (labels, form fields)
- Added safe `localStorage` wrapper for Tracking Prevention compatibility
- New terminal icon matching in-app logo

### v1.5.0
- Initial release

---

## License

- Versions up to and including **v1.5.6**: MIT License.
- **v1.5.7 and later**: [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for noncommercial use (personal, research, education, charities, government). **Commercial use is not allowed** without permission.
- For a commercial license, contact [ptelgm.yt@gmail.com](mailto:ptelgm.yt@gmail.com). See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Built by <a href="https://github.com/unn-known1">Gaurang Patel</a> · PolyForm Noncommercial 1.0.0 (v1.5.7+; ≤v1.5.6 MIT)</sub>
</p>

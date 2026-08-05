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
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
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
- **Multi-tab** — drag to reorder, side-by-side sessions
- **Bracketed paste** — Ctrl+V works in TUI apps (vim, nano, htop)
- **Command history** — keystroke-based capture, strips ANSI/control sequences
- **tmux sessions** — persistent sessions survive page reload
- **Keyboard Shortcuts** — reference dialog in the overflow menu (Ctrl+P/T/W/B/F, etc.)

### File Explorer
- Browse, upload, download, rename, delete files
- **Multi-select** — batch delete, download, zip, cut, copy
- **Zip/Extract** — right-click any file or folder
- **Image viewer** — preview inline (png, jpg, gif, svg, webp)
- **Conflict resolution** — replace, merge, keep both, skip
- **Breadcrumb navigation** — tappable directory segments

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
- Top processes sorted by CPU

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

<p align="center">
  <sub>Built by <a href="https://github.com/unn-known1">Gaurang Patel</a> · MIT License</sub>
</p>

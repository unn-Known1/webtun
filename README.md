# WebTun — Self-Hosted Web Terminal

![Terminal](https://img.shields.io/badge/Terminal-Web--Native-2D5B8E?style=for-the-badge)
![PWA](https://img.shields.io/badge/PWA-Installable-6BA428?style=for-the-badge)
![Cloudflare](https://img.shields.io/badge/Tunnel-Cloudflare-F38020?style=for-the-badge)
![Desktop](https://img.shields.io/badge/Desktop-Electron-47848F?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**Access your server from any browser — no VPN, no SSH client, no installing anything.**

[![Quick Start](https://img.shields.io/badge/Quick_Start-One_Command-2D5B8E?style=for-the-badge&logo=gnu-bash)](install.sh)
[![Download](https://img.shields.io/github/v/release/unn-known1/webtun?style=for-the-badge&logo=github)](https://github.com/unn-known1/webtun/releases/latest)

---

## Why WebTun?

| Traditional SSH | WebTun |
|----------------|--------|
| Need SSH client installed | Open any browser |
| Configure VPN or port forwarding | Cloudflare Tunnel auto-configured |
| Can't access from phone easily | PWA works on iOS/Android |
| Share access requires key exchange | Web-based sharing in 1 click |
| Corporate firewall blocks port 22 | Runs over HTTPS (port 443) |

---

## Features

### Core
- **Real shell sessions** — node-pty backed, full bash/zsh support
- **Multi-tab terminal** — drag tabs to reorder, side-by-side sessions like your desktop
- **File explorer** — browse, upload, download, rename, delete, cut/copy/paste with conflict resolution (replace, merge, keep both, skip)
- **WebSocket + xterm.js** — responsive, low-latency typing
- **Bracketed paste** — Ctrl+V works correctly in TUI apps (vim, nano, htop, mc)
- **Command history** — automatic capture with smart dedup, works with pasted commands

### Mobile-First UX
- **Touch gestures** — swipe to close tabs, swipe from edge to open sidebar, pull-to-refresh file list
- **Mobile keyboard bar** — ESC, Tab, arrow keys, Ctrl combos (Ctrl+C, Ctrl+D, etc.)
- **Virtual keyboard aware** — terminal resizes when keyboard opens, no overlap
- **Pinch-to-zoom** — adjust terminal font size (10–28px) with two fingers
- **Selection mode** — toggle between terminal interaction and text selection
- **Responsive** — optimized for phones (480px), tablets (1024px), and landscape orientation

### Settings
- **Right-click menu toggle** — enable/disable custom terminal context menu (Settings > Terminal)
- **Terminal scroll** — reliable mouse wheel scroll in all apps, including TUI apps with mouse tracking

### File Explorer
- **Multi-select** — select all / deselect all, batch delete, download, zip, cut, and copy files
- **Context menu on selection** — right-click actions (zip, download, delete, cut, copy) operate on all selected files
- **Zip / Extract** — right-click any file or folder to zip; right-click `.zip` files to extract (archiver v8)
- **Folder download** — folders download as `.zip` archives automatically
- **Image viewer** — click images (.png, .jpg, .gif, .svg, .webp, .bmp, .ico) to preview inline
- **Cut, Copy, Paste** — multi-file support with conflict resolution dialog (replace, merge folders, keep both, skip, cancel)
- **Upload with progress** — per-file progress bar via XHR
- **Breadcrumb navigation** — tappable directory segments for quick navigation
- **Long-press context menu** — rename, delete, download, copy on touch devices
- **Text selection** — long-press file names to select and copy text on touch devices

### System Stats
- **CPU, Memory, Disk, Uptime** — real-time usage with progress bars
- **GPU detection** — cross-platform (Linux: nvidia-smi/lspci, macOS: system_profiler, Windows: WMI)
- **Multi-GPU support** — detects and displays all GPUs with VRAM, utilization, and temperature
- **Top processes** — sorted by CPU usage

### Desktop App (Electron)
- Cross-platform app for Linux & Windows
- Runs the server as a child process — no terminal needed
- Native window with system tray, copy/paste, and file dialogs
- Download the latest release from [GitHub Releases](https://github.com/unn-known1/webtun/releases/latest)
- Or build from source: `npm run dist:linux` / `npm run dist:win`

### PWA (Install as App)
- Add to iOS/Android home screen — looks and feels like native app
- Install banner prompts on first visit (Chrome) with iOS instructions fallback
- Works offline (shows last session state)
- Push notifications for tunnel status

### Cloudflare Tunnel (Zero-Config)
- Create tunnel from UI — no CLI commands
- Built-in health check warns if local server is unreachable before creating tunnel
- Live/orphan status + target responsiveness indicator in tunnel list
- Get public HTTPS URL instantly
- Tunnels survive server restarts
- Stop/kill tunnels from settings panel

---

## Quick Start

### npm (Recommended)
```bash
npx webtun
```

Install globally:
```bash
npm install -g webtun
webtun
```

**Options:**
| Flag | Description |
|------|-------------|
| `--port, -p` | Port (default: 3000) |
| `--host, -h` | Host (default: 0.0.0.0) |
| `--pin` | Authentication PIN |
| `--tunnel, -t` | Start Cloudflare Tunnel |
| `--help` | Show help |
| `--version` | Show version |

**Environment Variables:**
| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `HOST` | Bind address (default: 0.0.0.0) |
| `PIN` | Authentication PIN (empty = no auth) |
| `SHELL` | Shell to use (default: PowerShell on Windows, bash/sh elsewhere) |
| `WORKSPACE_ROOT` | Root directory for file operations (default: ~) |
| `TRUST_PROXY` | Set to `true` if behind a reverse proxy (default: loopback only) |
| `WEBTUN_SHELL` | Override shell on Windows (e.g., `/usr/bin/bash` for Git Bash) |

**Examples:**
```bash
npx webtun                        # Start on port 3000
npx webtun --port 8080            # Custom port
npx webtun --pin secret123        # With PIN protection
npx webtun --tunnel               # With Cloudflare Tunnel
npx webtun -p 4000 -t             # Port 4000 + tunnel
```

**Note:** npm 12+ blocks install scripts by default. Allow them for `node-pty` (native module):
```bash
# Allow scripts once during install
npm install -g --allow-scripts=webtun,node-pty webtun

# Or allow globally (one-time setup)
npm config set allow-scripts=webtun,node-pty --location=user
npm install -g webtun
```

Build tools are also required (for compiling native modules):
```bash
# Debian/Ubuntu
sudo apt-get install -y python3 make g++

# macOS
xcode-select --install
```

### One-Command Install
```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/unn-Known1/webtun/main/install.sh)"
```

### Manual Setup
```bash
git clone https://github.com/unn-Known1/webtun.git
cd webtun
chmod +x setup.sh && ./setup.sh
npm start
```

### Google Colab (Instant Terminal)
```python
!rm -rf webtun && git clone https://github.com/unn-Known1/webtun.git && cd webtun && npm install --loglevel=error && node server.js > /tmp/webtun.log 2>&1 & sleep 4 && for i in 1 2 3; do curl -sf http://localhost:3000/api/auth/required >/dev/null && break; sleep 2; done && curl -s -X POST http://localhost:3000/api/tunnel -H 'Content-Type: application/json' -d '{"url":"http://localhost:3000"}' --max-time 20 | python3 -c "import sys,json; d=json.load(sys.stdin); print('🌐 WebTun ready at:', d.get('url','Error: '+d.get('error','')))"
```

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Your Browser                            │
│  ┌──────────┐  ┌───────────┐  ┌─────────────┐  ┌───────────┐   │
│  │ Terminal │  │   File    │  │   Tunnel    │  │  Settings │   │
│  │  (xterm) │  │ Explorer  │  │   Manager   │  │   Panel   │   │
│  └─────┬────┘  └─────┬─────┘  └──────┬──────┘  └─────┬─────┘   │
│        │             │               │               │         │
└────────┼─────────────┼───────────────┼───────────────┼─────────┘
         │  WebSocket  │  REST API     │               │
         ▼             ▼               ▼               │
┌────────────────────────────────────────────────────────────────┐
│                       Node.js Server                           │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  WebSocket  │  │   File API   │  │  Cloudflare Tunnel    │  │
│  │   Handler   │  │ (read/write) │  │      Manager          │  │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                │                      │              │
│         ▼                ▼                      ▼              │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ node-pty │  │ Local Filesystem │  │ cloudflared daemon   │  │
│  │  (shell) │  │ (your server)    │  │ (exposes to internet)│  │
│  └──────────┘  └──────────────────┘  └──────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                      ┌─────────────────┐
                      │  Internet Users │
                      │  (HTTPS URL)    │
                      └─────────────────┘
```

---

## Use Cases

| Scenario | Why WebTun |
|----------|------------|
| **Home server access** | Access from anywhere without opening ports |
| **Emergency debugging** | Phone/laptop without SSH client |
| **Share terminal with friend** | No key exchange, just send URL |
| **Colab power-up** | Persistent terminal alongside Python notebooks |
| **Demo environment** | Spin up temp shell for presentations |
| **Corporate restrictions** | HTTPS works where SSH is blocked |

---

## Tunnel Manager

1. Open **Settings** (gear icon)
2. Go to **Tunnel** section
3. Enter URL (default: `http://localhost:3000`)
4. Click **Create** — a health check pings the target first, warns if unreachable
5. Copy the public URL — share it with anyone
6. View all tunnels with live status indicators (green/orange)

**Note:** Tunnels created before a server restart need manual cleanup:
```bash
kill $(pgrep -f 'cloudflared tunnel')
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML + Vanilla JS (PWA, prefers-color-scheme, visualViewport, Drag & Drop) |
| Backend | Node.js + node-pty + Express |
| Terminal | xterm.js + fit addon |
| Protocol | WebSocket (ws) |
| Tunnel | Cloudflare Tunnel (cloudflared) |
| Desktop | Electron + electron-builder |
| Archives | archiver v8 + yauzl |

---

## Security

- **npm audit clean** — 0 known vulnerabilities
- **PIN authentication** — optional, protects all API endpoints
- **CSP headers** — restricts script sources to CDN
- **WebSocket origin check** — prevents cross-site WebSocket hijacking
- **Rate limiting** — per-IP rate limits on auth and search endpoints

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Tunnel URL not loading | Check Cloudflare account quota at [dash.cloudflare.com](https://dash.cloudflare.com) |
| Permission denied on shell | Ensure user has shell access: `chsh -s /bin/bash` |
| File upload fails | Check `public/uploads/` permissions: `chmod 755 public/uploads/` |
| Port 3000 in use | Change port: `PORT=3001 npm start` |
| Windows terminal opens PowerShell instead of Git Bash | Set `WEBTUN_SHELL=/usr/bin/bash` in `.env` |
| Behind reverse proxy, wrong client IP | Set `TRUST_PROXY=true` in `.env` |
| Tunnel persists after server restart | Tunnels are auto-managed; manual cleanup: `kill $(pgrep -f 'cloudflared tunnel')` |

---

## Contributing

1. Fork → Branch → Commit → PR
2. Follow existing code style (ES6+, no frameworks)
3. Test locally with `npm start`
4. Update this README if adding features

---

## License

MIT — do whatever you want with it.

---

<p align="center">
  <sub>Made with ❤️ by <a href="https://github.com/unn-known1">Gaurang Patel</a></sub>
</p>

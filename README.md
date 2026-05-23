# WebTun — Self-Hosted Web Terminal

![Terminal](https://img.shields.io/badge/Terminal-Web--Native-2D5B8E?style=for-the-badge)
![PWA](https://img.shields.io/badge/PWA-Installable-6BA428?style=for-the-badge)
![Cloudflare](https://img.shields.io/badge/Tunnel-Cloudflare-F38020?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**Access your Linux server from any browser — no VPN, no SSH client, no installing anything.**

[![Deploy to Cloudflare](https://img.shields.io/badge/Quick_Start-One_Command-2D5B8E?style=for-the-badge&logo=gnu-bash)](install.sh)

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
- **Multi-tab terminal** — side-by-side sessions like your desktop
- **File explorer** — browse, upload, download files without leaving the browser
- **WebSocket + xterm.js** — responsive, low-latency typing

### PWA (Install as App)
- Add to iOS home screen → looks and feels like native app
- Works offline (shows last session state)
- Push notifications for tunnel status

### Cloudflare Tunnel (Zero-Config)
- Create tunnel from UI — no CLI commands
- Get public HTTPS URL instantly
- Tunnels survive server restarts
- Stop/kill tunnels from settings panel

---

## Quick Start

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
┌─────────────────────────────────────────────────────────────┐
│                      Your Browser                           │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌────────────┐  │
│  │Terminal │  │  File    │  │   Tunnel   │  │  Settings  │  │
│  │ (xterm) │  │ Explorer │  │   Manager  │  │   Panel    │  │
│  └────┬────┘  └────┬─────┘  └──────┬─────┘  └─────┬──────┘  │
│       │            │               │              │         │
└───────┼────────────┼───────────────┼──────────────┼─────────┘
        │ WebSocket  │               │              │
        ▼            ▼               ▼              │
┌─────────────────────────────────────────────────────────────┐
│                      Node.js Server                         │
│  ┌────────────┐  ┌─────────────┐  ┌────────────────────┐    │
│  │  WebSocket │  │   File API  │  │ Cloudflare Tunnel  │    │
│  │  Handler   │  │ (read/write)│  │     Manager        │    │
│  └─────┬──────┘  └──────┬──────┘  └─────────┬──────────┘    │
│        │                │                   │               │
│        ▼                ▼                   ▼               │
│  ┌─────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ node-pty│  │Local Filesystem│  │ cloudflared daemon   │  │
│  │ (shell) │  │(your server)   │  │ (exposes to internet)│  │
│  └─────────┘  └────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
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
4. Click **Create**
5. Copy the public URL — share it with anyone

**Note:** Tunnels created before a server restart need manual cleanup:
```bash
kill $(pgrep -f 'cloudflared tunnel')
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML + Vanilla JS |
| Backend | Node.js + node-pty |
| Terminal | xterm.js |
| Protocol | WebSocket |
| Tunnel | Cloudflare Tunnel (cloudflared) |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Tunnel URL not loading | Check Cloudflare account quota at [dash.cloudflare.com](https://dash.cloudflare.com) |
| Permission denied on shell | Ensure user has shell access: `chsh -s /bin/bash` |
| File upload fails | Check `public/uploads/` permissions: `chmod 755 public/uploads/` |
| Port 3000 in use | Change port: `PORT=3001 npm start` |

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

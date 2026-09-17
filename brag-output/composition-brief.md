# Hyperframes Composition Brief: WebTun

## Objective
Create a 60-second 4K/60fps product showcase video for WebTun, a self-hosted web terminal.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape 4K (3840×2160) @ 60fps
- Duration: 60 seconds
- Render command: `npx hyperframes render --fps 60 --resolution landscape-4k --quality delivery`

## Source Material
- Project root: `/content/webtun`
- Primary files read: `public/index.html`, `public/css/styles.css`, `public/docs.html`
- Product name: WebTun
- Tagline: Your server, one tab away.
- All 6 theme palettes extracted from real `styles.css` CSS variables

## Creative Direction
- Tone preset: `default` — clean, polished, developer-focused
- Angle: Show the full power of a self-hosted terminal: real shells, code editor, git, files, tunnels — all behind one PIN, in any browser
- Hook: Terminal window with `npx webtun` typing animation
- Outro / punchline: WebTun logo + tagline + GitHub URL → fade to black
- Avoid: Generic SaaS language, abstract filler, showing features that don't exist

## Visual Identity
- All colors from real WebTun `styles.css` CSS variables
- Background: `#1a1b26` (Tokyo Night dark)
- Text: `#c0caf5`
- Accent: `#7aa2f7`
- Fonts: IBM Plex Sans (UI), JetBrains Mono (code/terminal)
- Visual references: macOS-style terminal window, xterm.js terminal, Tokyo Night color scheme

## Storyboard (scene-by-scene)

### Scene 1: Terminal Hook (0–4s)
- macOS-style window (red/yellow/green dots, "Terminal" title)
- Dark background (`#1a1b26`)
- Prompt: `~/Sites/webtun` in blue-green (`#7aa2f7`)
- `npx webtun` types char-by-char (10 chars × ~0.07s = 0.7s total typing)
- Blinking cursor after typing
- `→ localhost:3000` fades in at 2.5s

### Scene 2: Launchpad Tokyo Night (4–10s)
- Full dashboard with:
  - Accent-colored logo tile (60×60px, `#7aa2f7`, terminal SVG icon)
  - "WebTun" title (30px, bold)
  - "Your server, one tab away." tagline
  - Host badge: `localhost:3000` (pill badge, bg3 background)
  - Pulse: green dot + "Server online"
  - Two cards: Recent commands (npm run dev, git status), Places (~/Sites/webtun, /content/webtun)
- Grid dot background pattern
- Radial glow behind logo

### Scene 3: Theme Showcase (10–18s)
- Same launchpad layout
- 6 themes cycle through (1.3s each):
  - Tokyo Night (0s) → Light (1.3s) → Solarized Dark (2.6s) → Gruvbox (3.9s) → Dracula (5.2s) → Monokai (6.5s) → back to Tokyo Night (7.8s hold)
- CSS variables `--bg`, `--accent`, `--fg`, `--green` update per theme
- Background color transitions smoothly
- Elements that use accent color (logo, title, icons) update too

### Scene 4: Multi-Terminal + Tabs (18–25s)
- Header bar: WebTun logo, session badge
- Tab bar with 3 terminal tabs (2 visible + 1 overflow indicator)
- Tile view: 2 terminal panes side-by-side
- Left pane: `~/Sites/webtun` prompt, `npm run dev` command, output "Starting nodemon...", "Server running at http://localhost:3000"
- Right pane: `git status` output showing clean repo
- File explorer sidebar (collapsed, small)

### Scene 5: Editor + Git Panel (25–33s)
- Editor header: filename with dirty dot, "JavaScript" badge, Save button
- Code in editor:
  ```
  const express = require('express');   (purple: const)
  const WebSocket = require('ws');      (purple: const)
  const pty = require('node-pty');      (purple: const)

  const app = express();                (purple: const)
  const PORT = 3000;                   (orange: 3000)

  // WebTun: self-hosted web terminal
  app.listen(PORT, () => {
    console.log(`Ready on :${PORT}`);
  });
  ```
- Git panel sidebar:
  - "main" branch header (red git icon)
  - Staged: server.js (blue dot)
  - Modified: app.js (yellow dot)
  - Untracked: new-file.js (green dot)
- Tunnel row: green live dot + `a1b2c3d4.trycloudflare.com`

### Scene 6: File Manager (33–39s)
- Header: WebTun logo, session badge
- Tab bar: "Files" tab active
- Breadcrumb: `~/Sites/webtun`
- File list:
  - `node_modules/` (folder, blue icon)
  - `public/` (folder, blue icon)
  - `server.js` (file, GIT badge)
  - `package.json` (file, EDIT badge)
  - `README.md` (file, VIEW badge)
- Right-click context menu:
  - Open, Edit, Open in Tab, Download, Zip, Extract, Folder Size, Copy Path, Copy, Cut, Rename, Delete
- Select mode toggle active (checkboxes visible)

### Scene 7: Command Palette + Shortcuts (39–46s)
- Command palette overlay:
  - Dark scrim (55% opacity)
  - White pill dialog with search input
  - Shows: "server.js", "package.json", "public/", "node_modules/", etc.
- Keyboard shortcuts grid (6 shortcuts):
  - Ctrl+P → File finder
  - Ctrl+T → New terminal tab
  - Ctrl+B → Toggle file explorer
  - Ctrl+F → Search in terminal
  - Ctrl+S → Save editor file
  - Esc → Close menus

### Scene 8: System Stats + Settings (46–52s)
- Header: WebTun logo, session badge
- Overflow menu → System Stats panel:
  - CPU gauge (circular, 67%, teal)
  - Memory gauge (circular, 4.2 GB / 16 GB, purple)
  - Disk gauge (circular, 45%, green)
  - Uptime: "3 days 14h"
  - Top Processes table: PID, User, CPU%, Mem%, Command, Kill
- Settings → Appearance panel:
  - Theme selector showing all 6 theme options
  - Tokyo Night selected (current)
  - Font size slider, font family dropdown

### Scene 9: PWA + Tunnel (52–57s)
- Left: Phone mockup (200×380px, rounded corners, notch)
  - Home screen with WebTun icon, Safari icon
  - "Add to Home Screen" banner below phone
- Right: Large tunnel URL display
  - Green live dot
  - `*.trycloudflare.com` in monospace blue
  - "Your server, accessible worldwide"
- Security triangle badge in header

### Scene 10: Outro (57–60s)
- Center: Large logo tile (80×80px, accent blue, terminal SVG)
- "WebTun" in large text below logo
- "Your server, one tab away." tagline
- "github.com/unn-Known1/webtun" in small mono text
- Fade to black over final 3 seconds

## Audio
- Audio role: warm bed — confident, not overpowering
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
- Music treatment: Fade out at 58s as logo appears, zero music under final 3s
- No SFX

## Hyperframes Instructions
- Use GSAP for all animations
- CSS variables for theme switching in Scene 3 — use GSAP to tween between theme colors
- Per-character typing animation via individual `<span>` elements (not tl.call DOM hacks)
- All timed elements need `data-start` and duration
- Register root timeline on `window.__timelines`
- Lint check must pass before render

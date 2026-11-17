# Hyperframes Composition Brief: WebTun

## Objective
Create a short launch-style brag video for WebTun.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20 seconds

## Source Material
- Project root: `/`
- Primary files read: `public/index.html`, `public/css/styles.css`, `README.md`, `package.json`
- Product name: WebTun
- Tagline / strongest claim: "Self-hosted web terminal with Cloudflare Tunnel, file explorer, and PWA support — Access your server from any browser — no VPN, no SSH client, no installing anything."
- Key UI or visual moment to recreate:
  - The Tokyo Night WebTun workspace (`#header`, `#tab-bar` with rectangular rounded-top tabs and `inset 0 2px 0 #7aa2f7`, `#sidebar` File Explorer + Git mini-panel, live `xterm.js` terminal pane + split CodeMirror editor, and the Cloudflare Tunnel live URL card).
- Copy that must appear verbatim:
  - `npx webtun`
  - `Self-hosted web terminal with Cloudflare Tunnel, file explorer, and PWA support`
  - `No VPN, no SSH client, no installing anything.`
  - `http://localhost:3000`

## Creative Direction
- Tone preset: `app-store`
- Creative direction: High-craft developer launch reel — Tokyo Night terminal precision meets instant browser access
- Interpretation: Snappy 0.35s–0.45s entrances paired with long settled holds (2.5s–4.5s) so every command, UI panel, and feature callout is effortlessly readable.
- Angle: Remote server access shouldn't require VPN clients, SSH key juggling, or separate SFTP/Git tools. One command (`npx webtun`) turns any browser into a persistent full-stack terminal, file manager, code editor, and Cloudflare-tunneled workstation.
- Hook: `$ npx webtun --tunnel` typed live in JetBrains Mono, followed by "No VPN. No SSH client. Just your browser."
- Outro / punchline: `WebTun` — `$ npx webtun` — "Open http://localhost:3000. That's it."
- Avoid:
  - Generic SaaS language ("streamline your workflow")
  - Abstract filler visuals
  - Unrelated visual redesign or light-mode corporate cards

## Visual Identity
- Background: `#13141c` (`--bg0`), `#1a1b26` (`--bg`), `#16161e` (`--bg1`), `#24283b` (`--bg3`)
- Text: `#ffffff` (`--fg0`), `#c0caf5` (`--fg1`), `#9aa0c3` (`--fg2`)
- Accent: `#7aa2f7` (`--accent`), `#bb9af7` (`--purple`), `#9ece6a` (`--green`), `#7dcfff` (`--cyan`), `#e0af68` (`--yellow`)
- Border: `#3b3f52` (`--border`)
- Display font: `'IBM Plex Sans', system-ui, sans-serif`
- Body / Code font: `'JetBrains Mono', monospace`
- Visual references from the project:
  - Terminal SVG logo mark (`<rect x="2" y="4" width="20" height="16" rx="2"/>...`)
  - `#header` status dot (`#conn-status` green pulse) + `#tab-bar` desktop-aligned tabs
  - File Explorer rows with folder/file badges + Git mini-panel (`+142 -18`)
  - Cloudflare Tunnel active card (`https://swift-fox.trycloudflare.com`)

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. **Scene 1: The Command Hook** — 3.5s (`0.0s–3.5s`) — `$ npx webtun --tunnel` types out with instant server boot confirmation and the hook headline: "No VPN. No SSH client. Just your browser."
2. **Scene 2: The Live Workspace** — 5.5s (`3.5s–9.0s`) — Full WebTun UI recreation: File Explorer & Git panel on the left, live `xterm.js` terminal in the center, and split CodeMirror editor (`server.js`) on the right.
3. **Scene 3: Tunnels, Tiles & Mobile PWA** — 7.0s (`9.0s–16.0s`) — Three capability cards lock in on the beat (`9.52s`, `10.52s`, `11.52s`): 1-Click Cloudflare Tunnel going `LIVE`, Multi-File CodeMirror Tile View + Git Hunks, and Mobile PWA + tmux session persistence.
4. **Scene 4: Outro & Quick Start CTA** — 4.0s (`16.0s–20.0s`) — WebTun logo, tagline, and `$ npx webtun` command badge locked to the strong cues at `16.02s` and `17.02s`.

## Audio
- Audio role: Upbeat rhythmic developer bed with crisp motion-matched UI and keyboard SFX
- Audio arc: Mechanical typing intro → full 120 BPM groove on workspace reveal → beat-locked card sequence + tunnel chime → resonant bell payoff and clean fade-out
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`
- Music treatment: Start at `0.0s`, duration `20.0s`, volume `0.35`, smooth fade-out over the final 1.5s
- Music cue guidance: Bundled preset `.agents/skills/brag/assets/music/cues/happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.json` (120.19 BPM).
  - Beat-aligned transition into Scene 2 at `3.52s`
  - Beat-grid sequential card reveals at `9.52s`, `10.52s`, `11.52s`
  - Strong cue locks at `16.02s` (Scene 4 Outro reveal) and `17.02s` (`$ npx webtun` CTA badge)
- Audio-reactive treatment: Subtle; modulate background ambient glow and active workspace border glow with the music's 120.19 BPM pulse.
- Audio-coupled moments:
  - `0.3s–1.3s` — Typing `npx webtun --tunnel` (`keyboard/keypress-001..005.wav`)
  - `1.6s` — Headline slam (`impact/impactSoft_medium_001.ogg`)
  - `3.52s` — Workspace reveal (`impact/impactSoft_medium_004.ogg`)
  - `5.03s` — Split CodeMirror editor docks open (`casino/card-slide-1.ogg`)
  - `9.52s, 10.52s, 11.52s` — Feature cards 1, 2, 3 (`interface/click_003.ogg`, `interface/click_002.ogg`, `interface/click_005.ogg`)
  - `12.52s` — Cloudflare Tunnel goes LIVE (`interface/bong_001.ogg`)
  - `16.02s` — Outro reveal (`impact/impactSoft_medium_002.ogg`)
  - `17.02s` — Final `$ npx webtun` CTA (`impact/impactBell_heavy_000.ogg`)
- SFX selection guidance: Low HF risk picks from `.agents/skills/brag/assets/sfx/sfx-analysis.md`.
- Audio files: Copy music and selected SFX into `brag-output/composition/assets/`.

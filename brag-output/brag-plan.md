# Brag Plan: WebTun

## What is this app?
WebTun is a self-hosted web terminal with a full file explorer, multi-tab code editor, Git client, and one-click Cloudflare Tunnels that lets you access your server from any browser with a single command: `npx webtun`.

## The angle
Every developer has fought VPN configs, clunky SSH keys on mobile, or SCP syntax just to edit one config file and restart a process. WebTun reduces the entire remote dev workstation—real node-pty shell, tmux persistence, file manager, CodeMirror tile view, Git staging, and public Cloudflare Tunnel—into `npx webtun`.

## Hook (first 2-3 seconds)
A stark terminal prompt types out `npx webtun` with crisp mechanical keystrokes, followed by the headline:
"No VPN. No SSH client. Just your browser."

## Key moments (the middle)
- **Live Terminal + File Explorer Split**: The authentic Tokyo Night workspace (`#1a1b26`) snaps open showing the `#tab-bar` with active top accent line, breadcrumb path bar, file tree with type-tinted icons, and a live `xterm.js` shell streaming real server stats.
- **Multi-Tab Code Editor & Git Diffs**: Three feature cards / tiles lock in on the beat—CodeMirror Tile View (`server.js` + `styles.css` side by side), Git mini-panel with `+142 -18` numstat badges, and tmux session persistence.
- **One-Click Cloudflare Tunnel**: Simulated cursor clicks `Create Tunnel`—status flips to `LIVE` with a green pulse and an instant `https://webtun-edge.trycloudflare.com` link ready for any phone or laptop.

## Outro / punchline
"Your server, anywhere."
Big terminal command badge: `npx webtun` — "Open http://localhost:3000. That's it."

## User flow worth showing
1. **Entry**: Run `npx webtun` in the terminal → server boots on port 3000 in <1s.
2. **Key Action**: Open the browser workspace → browse files, edit code in split/tile tabs, stage Git hunks, and click **New Tunnel**.
3. **Result**: Instant `https://*.trycloudflare.com` public tunnel URL + full desktop/mobile PWA terminal access from anywhere.

## Tone
- Preset: `app-store`
- Creative direction: Crisp, high-craft developer tool launch film with Tokyo Night aesthetics and tactile terminal motion
- Interpretation: Fast, deliberate entrances with generous settled reading holds, authentic monospace UI chrome, and zero generic corporate filler.

## Format: landscape — 1920x1080
## Duration: 20 seconds

## Visual identity (from the project)
- Background: `#13141c` (`--bg0`) / `#1a1b26` (`--bg`) / `#24283b` (`--bg3`)
- Accent: `#7aa2f7` (`--accent`) and `#bb9af7` (`--purple`)
- Semantic accents: `#9ece6a` (`--green`), `#7dcfff` (`--cyan`), `#e0af68` (`--yellow`), `#f7768e` (`--red`)
- Text: `#ffffff` (`--fg0`), `#c0caf5` (`--fg1`), `#9aa0c3` (`--fg2`)
- Display font: `IBM Plex Sans`
- Body / Code font: `JetBrains Mono`
- Strongest visual element: The Tokyo Night WebTun workspace chrome (`#header` with connected pulse dot, `#tab-bar` with `inset 0 2px 0 #7aa2f7`, `#sidebar` file explorer + Git panel, and `#terminals` xterm + CodeMirror split).

## Share copy (draft)
Your entire server in any browser — real PTY terminal, full file explorer, Git panel, and instant Cloudflare Tunnels in one command: `npx webtun`.

## Audio direction
- Role: Rhythmic, modern developer launch bed with tactile mechanical keystrokes and crisp UI accents
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` (120.19 BPM)
- Music treatment: Starts at 0.0s at volume `0.35`, drives the 20s edit, gentle fade out over the final 1.5s
- Music cue guidance: Bundled preset `happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.md` read (tempo 120.19 BPM). Strong cues at `16.02s` (Scene 4 Outro reveal) and `17.02s` (final `npx webtun` CTA lock). Beat grid (`3.52s`, `9.52s`, `10.52s`, `11.52s`) used for workspace reveal and feature card sequence.
- Audio-reactive treatment: Subtle; background radial glow and active terminal border presence modulate gently with the music's energy.
- SFX posture: Moderate, motion-matched, low high-frequency fatigue (`keypress-001..006.wav`, `impactSoft_medium_001.ogg`, `card-slide-1.ogg`, `click_003.ogg`, `impactBell_heavy_000.ogg`).
- Audio-coupled moments:
  - Scene 1: `npx webtun` typed out with randomized mechanical keypress SFX
  - Scene 2: Workspace reveal on beat `3.52s` with soft impact thud
  - Scene 3: 3 capability cards (`Real PTY + tmux`, `CodeMirror Tile View & Git`, `1-Click Cloudflare Tunnel`) arrive on every other beat (`9.52s`, `10.52s`, `11.52s`) so each headline holds comfortably for reading
  - Scene 4: Final logo + `npx webtun` command badge lock at `16.02s` / `17.02s` with resonant bell
- Restraint rule: Keep SFX crisp and supportive; never drown the beat or clip over rapid text reveals.

## Storyboard

### Scene 1 — The Command Hook — 3.5s (0.0s – 3.5s)
Dark Tokyo Night backdrop (`#13141c`) with subtle grid and glowing `#7aa2f7` aura. A sleek terminal prompt `$ ` types out `npx webtun --tunnel` character-by-character in `JetBrains Mono`. Below it, bold `IBM Plex Sans` headline slams in: **"No VPN. No SSH client. Just your browser."**
Sequential/interaction: Simulated typing of `npx webtun --tunnel` (0.3s–1.4s), then instant server boot output (`✓ WebTun v2.4.2 listening on http://localhost:3000`).
Audio intent: Immediate tactile hook—mechanical keystrokes build anticipation into the beat drop.
Audio-coupled idea: Randomized `keyboard/keypress-001..006.wav` ticks on typing; `impact/impactSoft_medium_001.ogg` when the headline lands.
Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` (120.19 BPM) enters cleanly at 0.0s.
Transition mood: Snappy zoom-wipe into the live browser workspace at `3.52s` (beat-aligned) → Scene 2

### Scene 2 — The Live Workspace — 5.5s (3.5s – 9.0s)
Full-bleed recreation of the real WebTun UI (`#header`, `#tab-bar`, `#sidebar`, `#terminals`, `#editor-view`).
- Left sidebar shows the File Explorer (`/home/dev/webtun`, folders & files with type-tinted icons, plus the Git mini-panel showing `main ↑1` and `+142 -18`).
- Center shows the live `xterm.js` terminal running `htop` / build output alongside a split CodeMirror editor tab (`server.js`) with dirty-dot and breadcrumb bar.
- Callout badge top-right: **"Real node-pty shell · Full File Explorer · Live CodeMirror"**
Sequential/interaction: Sidebar slides in at `3.6s`, terminal pane populates at `4.02s`, split code editor docks open at `5.03s` with simulated cursor click.
Audio intent: Satisfying UI assembly—each pane feels physical and responsive.
Audio-coupled idea: `interface/click_003.ogg` on split editor toggle (`5.0s`), `casino/card-slide-1.ogg` as the editor panel opens.
Transition mood: Clean slide transition at `9.02s` → Scene 3

### Scene 3 — Tunnels, Tiles & Mobile — 7.0s (9.0s – 16.0s)
Three real product workflow cards lock in sequentially on every other beat (`9.52s`, `10.52s`, `11.52s`) and hold together through `16.0s`:
1. **1-Click Cloudflare Tunnel** — Simulated cursor clicks `New Tunnel`, flipping badge to `● ACTIVE` with `https://swift-fox.trycloudflare.com` and QR/copy button.
2. **Multi-File Tile View & Git** — Edit up to 10 files side-by-side with live syntax highlighting, auto-drafts, and inline Git hunk staging.
3. **Installable Mobile PWA** — Touch keyboard bar (`ESC`, `TAB`, `CTRL`, arrows), PIN + device approval security, and tmux persistence across reloads.
Sequential/interaction: 3 cards arrive at `9.52s`, `10.52s`, `11.52s`; at `12.52s` the Cloudflare Tunnel status pill animates from `Starting…` to `● Connected (trycloudflare.com)`.
Audio intent: Rhythmic momentum culminating in the tunnel activation chime.
Audio-coupled idea: Beat-grid card arrivals (`9.52s`, `10.52s`, `11.52s`) with `interface/click_002.ogg` / `casino/card-slide-1.ogg`, and `interface/bong_001.ogg` at `12.52s` when the tunnel goes live.
Transition mood: Dramatic scale-up reveal at strong cue `16.02s` → Scene 4

### Scene 4 — Outro & Quick Start CTA — 4.0s (16.0s – 20.0s)
Centered hero lockup with the WebTun terminal SVG emblem (`#7aa2f7` & `#9ece6a`), large display title **"WebTun"**, subtitle **"Self-hosted web terminal, file explorer & Cloudflare Tunnel"**, and a glowing copy-ready terminal pill:
`$ npx webtun`
Below: `github.com/unn-Known1/webtun · Desktop (Electron) · Linux · macOS · Windows`
Sequential/interaction: Brand emblem + title lock at `16.02s` (strong cue), `$ npx webtun` command pill pops at `17.02s` (strong cue) and holds settled for 3.0s until `20.0s`.
Audio intent: Confident, memorable finish with a clean bell ring and smooth music fade.
Audio-coupled idea: Beat-locked reveal at `16.02s` (`impact/impactSoft_medium_004.ogg`) and `17.02s` (`impact/impactBell_heavy_000.ogg`).
Transition mood: Hold settled frame cleanly to 20.0s end.

**Music mood for this video:** Upbeat, crisp, modern developer-tool groove (`happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`).
**Audio summary:** Tactile keystrokes open into a 120 BPM groove that drives the live workspace reveal, beat-synced capability cards, tunnel activation chime, and a resonant bell on the final `npx webtun` CTA.

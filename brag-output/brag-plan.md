# Brag Plan: WebTun

## What is this app?
WebTun is a self-hosted web terminal — a full xterm.js terminal, file explorer, git panel, and Cloudflare Tunnel manager that runs in your browser. No VPN, no SSH client, no install. One `npx webtun` and you're in.

## The angle
Not a demo. A real server, right there in your browser — with file editing, git ops, session persistence, and a public tunnel link you can share. The joke (if there is one) is that something this capable runs in a browser tab with zero friction.

## Hook (first 2-3 seconds)
A terminal window appears. A shell prompt blinks. A command types itself: `npx webtun`. The cursor sits at `localhost:3000`. Cut to WebTun running in a browser.

## Key moments
- Multi-tab terminal with real PTY backing — multiple shell sessions side-by-side
- File explorer with thumbnails, git panel, and a CodeMirror editor — all inside the browser
- Cloudflare Tunnel: one click, public URL — the server is now globally accessible
- PWA installable: add to home screen, works offline with last session state
- Session persistence: tabs survive page reload via tmux or in-memory PTY

## Outro / punchline
"WebTun. Your server, one tab away."

## User flow worth showing
Open WebTun → new terminal tab → type a command → see output → switch to file explorer → open a file → edit and save → open tunnel → share the URL.

## Tone
- Preset: `polished`
- Creative Direction: "Developer tool launch film — premium, restrained, no gimmicks"
- Interpretation: Wide type, long holds, confident reveals. The product speaks. Nothing screams. Clean crossfades, soft transitions. The capability IS the impressiveness.

## Format: landscape — 1280x720
## Duration: ~20 seconds

## Visual identity (from the project)
- Background: `#1a1b26` (Tokyo Night dark)
- Accent: `#7aa2f7` (soft blue)
- Text: `#c0caf5` (light periwinkle)
- Display font: IBM Plex Sans (800 weight for titles)
- Body font: JetBrains Mono (for terminal/code surfaces)
- Strongest visual element: The launchpad — radial gradient aura, animated terminal logo draw, live system pulse sparkline

## Share copy (draft)
WebTun turns any server into a shareable web terminal. File explorer, git ops, Cloudflare Tunnel, PWA — no VPN, no SSH client, no install required.

## Audio direction
- Role: Warm professional bed — understated, supports the product not the pitch
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` — steady and clean, fits `polished` tone
- Music treatment: Fade in at 2s, stay low (0.25 volume), fade out under final logo
- Music cue guidance: Bundled preset — strong cues at ~5.2s, ~11.8s, ~17.6s for scene transitions
- Audio-reactive treatment: subtle; hero glow breathes with RMS, product card presence on bass
- SFX posture: Minimal. One drop sound on logo arrival. One soft click on tab reveal.
- Audio-coupled moments: Logo drop → `impactSoft_medium_002`; terminal tab reveal → `interface/drop_001`
- Restraint rule: No sound competes with the product. If in doubt, leave it out.

## Storyboard

### Scene 1 — Hook / Terminal Arrives — 3s
Dark background. A terminal window scales in (from 0.9→1.0, 0.4s ease-out). The prompt types character by character: `npx webtun`. Cursor blinks. Text settles. Soft `drop_001` at 0.3s. At 2s the URL `localhost:3000` fades in below. Hold. Hard cut at 3s.
Sequential/interaction: yes — command types character by character with keyboard sounds
Audio intent: Clean arrival. Sets the tone.
Audio-coupled idea: per-character keyboard sounds, random from the keypress set
Music: low bed fades in
Transition mood: hard cut → Scene 2

### Scene 2 — WebTun UI Reveal — 4s
WebTun's launchpad in full glory — the radial blue glow, animated terminal logo draws in, title "WebTun" and tagline "Your server, one tab away." System pulse sparkline animates. The launchpad cards (Recent Commands, Places) slide in one by one. `drop_002` on title. `impactSoft_medium_002` on tagline.
Sequential/interaction: yes — logo draw animation, then cards arrive one by one
Audio intent: Product arriving. Safe landing.
Audio-coupled idea: Cards arrive on beats — ~0.4s apart (120 BPM); logo draw synced to intro swell
Music: bed at 0.25 volume
Transition mood: soft slide → Scene 3

### Scene 3 — Terminal in Action — 4s
A terminal tab with a visible session. Some command output (e.g. `ls -la` with colorized output). A second tab appears. The tab bar shows two terminals side by side. File explorer sidebar visible with a file selected.
Sequential/interaction: yes — second tab slides in from right
Audio intent: Working product. Not a demo — the real thing.
Audio-coupled idea: Tab arrival gets a soft `click_002`
Music: steady bed continues
Transition mood: clean wipe → Scene 4

### Scene 4 — Editor + Git + Tunnel — 5s
File editor open with syntax-highlighted code (JetBrains Mono visible). Git panel in sidebar showing staged/unstaged files. Tunnel row visible in settings with a green "live" dot and a shareable `*.trycloudflare.com` URL. Camera icon pulses.
Sequential/interaction: none (rich static frame showing depth of product)
Audio intent: The feature wall. Depth revealed.
Audio-coupled idea: `switch_001` if tunnel URL appears to animate in
Music: bed holds, slight swell at 5s
Transition mood: soft crossfade → Scene 5

### Scene 5 — PWA + Outro — 4s
Phone mockup with WebTun installed on home screen (PWA). "Add to Home Screen" banner visible. Then the WebTun logo — large, centered, full-screen. Below it: "Your server, one tab away." Logo drops in with `impactBell_heavy_000`. Tagline settles. Hold 1.5s. Fade to black.
Sequential/interaction: none
Audio intent: Final payoff. Product name lands. Tagline holds. Silence.
Audio-coupled idea: `impactBell_heavy_000` on logo slam; final 0.5s silence before fade
Music: fade out under logo
Transition mood: fade to black

**Music mood for this video:** Upbeat but restrained — professional bed, not a celebration
**Audio summary:** One low music bed throughout. Three tasteful SFX: keyboard on type, drop on logo, bell on final slam. Nothing competes with the product.

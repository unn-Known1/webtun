# Hyperframes Composition Brief: WebTun

## Objective
Create a short launch-style brag video for WebTun.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1280x720
- Duration: ~20 seconds

## Source Material
- Project root: `/content/webtun`
- Primary files read: `public/index.html`, `public/css/styles.css`, `README.md`, `package.json`
- Product name: WebTun
- Tagline / strongest claim: "Your server, one tab away."
- Key UI or visual moment to recreate: Launchpad with radial gradient aura and animated terminal logo, terminal tabs, file explorer sidebar, code editor, git panel, tunnel URL row, PWA home screen
- Copy that must appear verbatim:
  - "WebTun"
  - "Your server, one tab away."
  - "npx webtun"
  - "localhost:3000"

## Creative Direction
- Tone preset: `polished`
- Creative direction: "Developer tool launch film — premium, restrained, no gimmicks"
- Interpretation: Wide type, long holds, confident reveals. The product speaks. Clean crossfades, soft transitions.
- Angle: WebTun is a real server terminal in a browser tab. No VPN. No SSH client. No install. The impressiveness is in the capability, not the pitch.
- Hook: Terminal types `npx webtun` character by character, settles on `localhost:3000`, cuts to WebTun running in a browser.
- Outro / punchline: "WebTun. Your server, one tab away." — logo slams, tagline holds, silence.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign

## Visual Identity
- Background: `#1a1b26` (Tokyo Night dark theme)
- Text: `#c0caf5` (light periwinkle)
- Accent: `#7aa2f7` (soft blue)
- Display font: IBM Plex Sans (Google Fonts)
- Body font: JetBrains Mono (Google Fonts)
- Visual references from the project:
  - Launchpad: radial blue gradient aura (`#7aa2f7` at 11% opacity, blur 14px), animated terminal logo draw, sparkline
  - Terminal: xterm.js with dark theme, colored output
  - File explorer: sidebar with file icons, breadcrumb
  - CodeMirror editor with syntax highlighting

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. Hook / Terminal Arrives — 3s — `npx webtun` types character by character, ends on `localhost:3000`
2. WebTun UI Reveal — 4s — Launchpad with logo draw, title, tagline, system sparkline, cards slide in
3. Terminal in Action — 4s — Two terminal tabs side by side, file explorer sidebar visible
4. Editor + Git + Tunnel — 5s — Code editor, git panel, live tunnel URL with green dot
5. PWA + Outro — 4s — PWA home screen mockup → WebTun logo slam + tagline → fade to black

## Audio
- Audio role: warm professional bed — understated, supports the product
- Audio arc: Bed fades in over scene 1, holds at low volume, fades under final logo
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
- Music treatment: Fade in at 2s, volume 0.25, fade out under final logo slam
- Music cue guidance: Bundled preset — strong cues at ~5.2s, ~11.8s, ~17.6s (target scene transitions); beat grid available for sequential reveals
- Audio-reactive treatment: subtle; hero glow breathes with RMS, product card presence on bass
- Audio-coupled moments:
  - Scene 1 — per-character keyboard typing animation — random keypress sounds from `keyboard/` set
  - Scene 2 — logo draw + card reveals — `drop_002` on title, sequential cards on beats
  - Scene 3 — tab reveal — `click_002`
  - Scene 5 — logo slam — `impactBell_heavy_000`
- SFX selection guidance: Sparse. Keyboard typing on entry, one drop on product name, one bell on final logo. Professional restraint.
- SFX analysis guidance: use `skills/brag/assets/sfx/sfx-analysis.md`
- Exact SFX choice: Hyperframes should choose filenames, timestamps, density, and volume based on the implemented animation.
- Audio files: copy the chosen music into `brag-output/composition/assets/music/`

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core`, `hyperframes-animation`, `hyperframes-creative`, `hyperframes-keyframes`, and `hyperframes-cli`. /brag is its own workflow: do not enter the `hyperframes` entry-point intent interview or route into its generic promo / launch-video workflow.

Requirements:
- Show at least one real UI, copy, or visual element from the source project.
- Keep all text readable in the final render.
- Keep the video within 15-25 seconds.
- Include the planned music/SFX layer.
- Treat `/brag` audio notes as guidance, not a fixed cue sheet. Choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints. Hyperframes decides exact animation timing and should ignore cues that hurt readability, scene pacing, or the product story.
- Major reveals may move toward nearby strong cues within about 0.15s. Use 1-3 strong cue locks in a 15-25s video.
- Use SFX to support motion and interaction: keyboard sounds for typing, drop sounds for reveals, bell for logo slam.
- Honor planned music treatment: fade-in over scene 1, hold at low volume, fade under final logo.
- When music is present, consider Hyperframes audio-reactive workflow: extract audio data and use RMS/frequency bands for subtle visual properties (glow, depth, card presence). Avoid waveform/equalizer visuals.
- Use local assets for audio and any required runtime/media dependencies when possible.
- Run `hyperframes check` before render — it is brag's single gate.

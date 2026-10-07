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

> **Recent npm note:** Install scripts are blocked by default. Allow them for `node-pty`:
> ```bash
> npm install -g --allow-scripts=webtun,node-pty webtun
> ```
> Build tools required for native modules: `sudo apt-get install -y python3 make g++` (Debian/Ubuntu) or `xcode-select --install` (macOS).

### Other install methods

```bash
# One-command install
bash -c "$(curl -fsSL https://raw.githubusercontent.com/unn-Known1/webtun/main/install.sh)"

# Manual setup (setup.sh starts the server itself)
git clone https://github.com/unn-Known1/webtun.git && cd webtun && ./setup.sh
```

> **Windows note:** `setup.sh` / `install.sh` / `stop.sh` are bash-only and support Linux and macOS (Git Bash on Windows is not supported — the scripts exit with "Unsupported OS"). On Windows, use the Electron app above, WSL, or `npx webtun` directly (the server itself is cross-platform; only the provisioning scripts are not).

---

## User Guide

New here? Read the visual guide: **[unn-known1.github.io/webtun/public/docs.html](https://unn-known1.github.io/webtun/public/docs.html)** — every feature (terminal, editor, files, git, tunnels, sessions, shortcuts) in one page, ~5 minutes cover to cover.

It's also built into the app: open `/docs` on any running instance, or Settings → About → **User guide & docs**.

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
- **Rich rows** — type-tinted icons, live photo thumbnails, size + modified dates, hover quick-download, sortable sticky folder/file groups
- **Git mini-panel** — branch switching/creation, stash, discard, repo init, staged/unstaged/untracked/conflict groups, colorized diffs, commit, push/pull; auto-shows inside repos; Simple mode hides rarely-used actions
- **Settings control deck** — collapsible groups with live search, runtime PIN set/change/disable (saved to `.env`)
- **Editor** — CodeMirror with autosave draft, `F11` fullscreen (covers terminal area only, never the file explorer), `horizontal/vertical` split toggle, markdown/HTML preview
- **File tabs** — open any file in its own tab beside your terminals (button in the editor header, or **Open in Tab** in the file context menu); up to 10 at once, each code file with its own live editor, cursor, scroll and undo history — so **Tile view shows several files at once**. Per-tab Save/Reload, and **Panel** hands the file (buffer and undo history included) to the split editor

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

### SSH Access
- On-demand key-only credentials for Termius, VS Code Remote-SSH, plain `ssh`/`rsync`/`sftp` — nothing created until you ask (header SSH button → Generate, after enabling SSH once in Settings → Features)
- ed25519 per device, private key shown once and never stored; per-key revoke; requires PIN protection
- Same user as your web terminals, so files and permissions match; host fingerprints + LAN/Tailscale addresses shown for first-connect verification
- SSH provisioning needs a Pro or Team license once billing is configured on the server (Settings → Security → License); the terminal itself is never gated

### System Stats
- CPU, Memory, Disk, Uptime — real-time with progress bars
- GPU detection (nvidia-smi, system_profiler, WMI)
- Multi-GPU support with VRAM, utilization, temperature
- Top processes sorted by CPU — **Kill** button per row (`POST /api/system/kill`)

### Desktop (Electron)
- Cross-platform app for Linux, Windows, macOS
- Native window with system tray and file dialogs
- Self-updating: checks GitHub releases after launch and daily, installs on quit (Windows Setup + portable, Linux deb + AppImage, macOS arm64)
- Portable `.exe` and AppImage builds cannot self-update (no installer to apply the update) — update failures are logged, and a manual update check is exposed to the UI; grab the next release from GitHub for those builds
- Platform support: Windows x64, Linux x64, macOS arm64 (Intel Macs and Windows-on-ARM are currently unserved / emulation-only)
- Build: `npm run dist:linux` / `npm run dist:win` / `npm run dist:mac`
- [Download latest release](https://github.com/unn-known1/webtun/releases/latest)
- **Windows "Unknown publisher" warning**: the exe is unsigned by default. To ship signed builds, get an Authenticode code-signing certificate (OV), export it as `.pfx`, and add two repo secrets (Settings → Secrets → Actions): `WIN_CSC_LINK` = base64 of the `.pfx`, `WIN_CSC_KEY_PASSWORD` = its password. The Windows CI build picks these up automatically (`CSC_LINK`/`CSC_KEY_PASSWORD`); without them it builds unsigned. Note: even signed, SmartScreen reputation takes time/downloads to build.

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
| `ALLOWED_ORIGINS` | Extra WebSocket origins (comma-separated) when served from another hostname | same-origin only |
| `PREVIEW_PORTS` | Allow-list of ports the app preview may proxy (comma-separated) | any port except WebTun's own |
| `SSH_PORT` | Expected SSH port shown in Settings → SSH Access | `2222` |
| `WEBTUN_LICENSE_PUBLIC_KEY` | PEM public key that activates license caps (Free 2 tunnels / 3 devices) and Pro/Team keys | unset (caps dormant) |
| `LICENSE_PRIVATE_KEY` | PEM private key for minting keys via webhook or `scripts/mint-license.js` (signer only, never on the server) | none |
| `STRIPE_SECRET_KEY` | Enables `POST /api/billing/checkout` (Checkout Sessions via Stripe API) | none |
| `STRIPE_WEBHOOK_SECRET` | Verifies `POST /api/billing/webhook` signatures (HMAC, no Stripe SDK) | none |
| `STRIPE_PRICE_PRO_MONTHLY` / `_YEARLY`, `STRIPE_PRICE_TEAM_MONTHLY` / `_YEARLY` | Price ids used by checkout per plan and term | none |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla JS, xterm.js, CodeMirror, PWA |
| Backend | Node.js, Express, node-pty |
| Tunnel | Cloudflare Tunnel (cloudflared) |
| Desktop | Electron + electron-builder |
| Archives | stdlib zip writer + reader (`lib/zip-store.js`, `lib/zip-read.js`) |

---

## Security

- PIN authentication on all API endpoints (`x-pin-token` header or `?token=` query)
- Change the PIN anytime from Settings → Security (applies instantly, saved to `.env`; fresh sessions need another session's approval while others are signed in)
- New devices sign in with the PIN but stay locked until an existing session approves them — see active sessions in Settings → Security
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
| Windows "Unknown publisher" | Unsigned build — see Desktop (Electron) signing setup |
| Tunnel persists after restart | `kill $(pgrep -f 'cloudflared tunnel')` |

---

## Changelog

### v2.3.2
- **Mobile keyboard correctness** — the software-keyboard inset is now applied to a single layout owner instead of both the terminal and its parent, which was collapsing the visible terminal to a few pixels while keystrokes still reached the shell. Detection now measures the app's own rendered bottom against the visible viewport, so nothing is re-reserved on browsers that already resize above the keyboard.
- **Desktop toolbar & stacking** — the editor toolbar no longer clips its **Save** button at the default panel width (progressive disclosure below 420px); the fullscreen editor no longer paints over the Settings/Notification drawers (which had focus-locked you into an invisible panel); Keyboard Shortcuts and Listening Ports are reachable again on desktop (the overflow menu that opens them was permanently hidden).
- **Sidebar & tab-strip integrity** — the file explorer can no longer collapse to zero height under the git panel, the toolbar fits the default sidebar width, the git header no longer clips at tablet width, an inline sidebar width no longer overrides the tablet layout, and the tab-strip create buttons no longer jump position on overflow.
- **Touch targets** — the tab close button keeps its compact appearance but gains a full-size hit area, and eleven inline row actions plus the sidebar resize handle get 44px/30px hit areas without changing how they look.
- **Theming & accessibility** — per-theme `--amber` (was a Tokyo-Night-only literal that measured 1.63–2.07:1 in all three light themes), a real `prefers-reduced-motion` that stops perpetual animations instead of restarting them, focus rings on 19 previously ringless controls including every settings switch, closed drawers removed from the tab order, live regions for connection state, and a `forced-colors` block for Windows High Contrast.
- **Design-system consolidation** — a single type scale (23 font sizes → 10 tokens), an icon scale (13 SVG widths → 6), a unified count-badge component, one key-bar state reconciler, and a consolidated bottom-sheet rule.
- Full findings, evidence, and remaining work: [`docs/UI_DESIGN_AUDIT_REPORT.md`](docs/UI_DESIGN_AUDIT_REPORT.md).

### v2.3.1
- **Background Terminal Session Management** — Dedicated Terminal Sessions manager (`#term-sessions-overlay`, `Alt+S`/`Ctrl+Shift+S`), 1-click attach/connect directly into terminal tabs, persistent custom session labeling (`POST /api/sessions/:id/label`), and real-time WebSocket session state synchronization across windows.
- **Listening Ports Dashboard** — Interactive Listening Ports Modal (`#ports-overlay`) scanning local TCP servers (`/api/ports`), listing process names/PIDs, and offering 1-click in-app preview tab launching.

### v2.3.0
- **Context-Scoped Keyboard Routing Engine** — Focus-bound keyboard shortcut routing distinguishing Terminal, File Explorer, Editor, and Launchpad/Idle scopes; 100% pass-through for TUI applications (`tmux` `Ctrl+B`, `vim` window navigation `Ctrl+W`, `fzf`/history `Ctrl+P`, `bash` `Ctrl+T`, `Escape` to Normal Mode); dedicated non-conflicting chords (`Ctrl+Shift+W` to close tab from within terminal, `Ctrl+K`/`Cmd+K` universal command palette, `Alt+1..9` tab switching); explorer-specific keyboard controls (`↑`/`↓` navigation, `→` expand/enter, `←`/`Backspace` ascend, `F2` rename, `Del` delete, `Ctrl+N` new file).
- **Executive Identity & UI/UX Elevation** — Precision vector mark, interactive hostname badge with network state dot, ambient connection jewel, unboxed Warp-grade Launchpad dashboard with real-time system metrics, sortable & filterable Process Inspector table with two-step kill confirmation, Termius 1-click SSH config generator, and OLED Midnight theme.

### v2.2.8
- **New Light UI Themes** — introduced two modern, clean light themes: **Catppuccin Latte** (`catppuccin-latte`) with soft pastel surfaces and crisp indigo text, and **Nord Light** (`nord-light`) with an arctic slate background and sky blue highlights; full WCAG-AA contrast compliance
- **Theme Engine Reliability & Alignment** — fixed dataset theme initialization and synchronous boot synchronization across `document.documentElement` and `document.body`; added `tokyo-night` alias support; updated xterm.js theme options and WebGL texture atlas refresh to immediately re-render terminals on palette change

### v2.2.7
- **Desktop Engine & Audit Remediation (Desktop Readiness Score 96.8/100 Grade A+)** — implemented single-instance application lock (`app.requestSingleInstanceLock()`) in Electron; attached xterm key event handler (`term.attachCustomKeyEventHandler`) to route global hotkeys (`Ctrl+B`, `Ctrl+P`) directly to application handlers; dynamic submenu flyout edge clamping; empty-space context menu in file explorer; scoped drag overlay to prevent text selection interference; window focus auto-refresh for Git status panel; Solarized Dark theme contrast adjustments for WCAG AA compliance; Ultrawide display Launchpad layout scaling
- **Mobile UI Terminal Tabs & CodeMirror Resilience** — aligned terminal tab bar on mobile UI to match desktop UI tab chrome (rectangular rounded-top tabs, active top accent indicator line `inset 0 2px 0 var(--accent)`, direct `+` new tab creation button); introduced `ensureCodeMirrorLoaded()` guard with native `<textarea>` fallback for offline or CDN script failure resilience; enhanced file explorer path bar (`#path-bar`) segment styling and focus states

### v2.2.6
- **Mobile UX & Ergonomics overhaul (Mobile Readiness Score 94+/100)** — resolved involuntary keyboard popups during terminal scrolling with touch-drag gesture disambiguation; decoupled terminal PTY viewport resize (`SIGWINCH`) during software keyboard animation; docked the mobile key accessory ribbon (`#mobile-keys`) above the virtual keyboard via the Visual Viewport API so essential keys (`ESC`, `TAB`, `Ctrl`, arrows, `Hide KB`) remain accessible while typing; introduced an ergonomic thumb-zone Bottom Navigation Bar (`#mobile-nav-bar`) with large $\ge 48\text{px}$ targets and haptic feedback; transformed mobile context menus into native slide-up Bottom Action Sheets; resolved OS edge-swipe navigation conflicts with backdrop-scrim drawer controls; floating multi-select action capsule

### v2.2.5
- **SSH access (opt-in)** — on-demand key-only ed25519 credentials from a header popup for Termius/mobile/`ssh` clients: status stat-trio with port pill, one-click Easy Setup checks (sshd, firewall, Tailscale userspace serve, built-in managed sshd) with per-check fix buttons, copy-ready Tailscale/LAN recipes (Docker-bridge addresses filtered), session single-use private keys; Features toggle is server-enforced (default off) and kills managed sshd + WebTun-started Tailnet on disable
- **Login** — Enter-to-unlock now works on every showing of the PIN screen (plus input-level fallback), not just fresh boot
- **File properties** — permissions info button with live octal/symbolic decode

### v2.2.4
- **Security hardening (full-codebase grill-review fixes)** — reflected-XSS escape in preview errors, fail-closed raw-PIN path, PIN rotation persist-first with pending-clearance, preview sockets reaped on rotate/revoke, per-UID 0600 tmux claim file
- **Backend** — tunnel/upload SSRF closed (all-address DNS vetting, non-canonical IP deny), CWD `cloudflared` candidates removed, upload depth caps + no silent overwrite, zip running-total cap with fd-based writes, git route guards (`--` separators, root-diff reject, credential scrubbing), search walk capped + sandboxed, `JSON_LIMIT`/`JSON_LIMIT_LARGE` env knobs, merge rollback now restores overwritten files
- **Frontend** — terminal titles forwarded, streaming decode + cross-frame OSC, paste/history tracking, forced re-login on revoke/rotation, tab active-state + viewer-position persistence, panel A→B write race fixed, WCAG-AA theme contrast, folder-size auth, AVIF support, docs corrected and synced
- **CLI/infra** — setup PIN round-trip fix, `npm ci`, systemd double-start guard, `=` flags, host-aware healthcheck, tunnel-fail teardown, SIGKILL escalation, strict version/tag/README gate

### v2.2.3
- **Tab features** — tab-bar overhaul (pin protection, context menus, middle-click / right-click handling, keyboard reachability)
- **File explorer fixes** — audit pass over listing, selection and rows, plus zip/unzip jobs in the Transfer Center
- **Settings & titlebar fixes** — settings audit corrections and terminal context-menu work
- **System stats & docs** — stats panel additions, user-guide updates and launchpad screenshots

### v2.2.2
- **Terminal directory follows `cd`** — the file explorer's "Go to terminal directory" button (and new-tab / copy-path / bookmark from the terminal menu) now resolves the session's live directory on demand via `GET /api/sessions/:id/cwd` (tmux `pane_current_path`, `/proc` on Linux, `lsof` on macOS) instead of the stale launch dir that OSC 7 rarely updated
- **Open files track external changes** — text buffers snapshot `mtime`/`size` from `/api/files/read` and are re-statted every 10s and on refocus: clean buffers auto-reload (`Updated from disk`), dirty buffers keep your edits and raise a persistent cyan `Changed on disk` indicator (click to reload, Save to overwrite); deleted files are flagged the same way
- **Dependency bumps** — `electron-builder` 26.16.1, `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0 (Dependabot #4, #5, #6)

### v2.2.1
- **Express 5** — `express` 4 → 5.2.1; the app-preview wildcard route migrated to the new `{*splat}` syntax (handler unchanged, it slices `originalUrl`); smoke-tested (`/`, `/docs`, file/git/system APIs, preview proxy)
- **Latest dependencies** — `node-pty` 1.1.0, `ws` 8.21.3 (spec + override), `debug` 4.4.3 via the new tree; `npm audit` clean
- **Automation** — weekly Dependabot (npm + GitHub Actions), a PR check workflow running the CI `verify` steps on every pull request, and a CodeRabbit review config with repo-specific instructions for `server.js`, `docs.html` and `app.js`

### v2.2.0
> Never tagged or published — the tree described here first shipped as v2.2.1; section kept for history (same convention as the v2.1.x sections below).

> Everything since v2.0.4 as of this tree (v2.1.0–v2.1.2 were bumped and documented but never tagged or published either; the v2.1.x sections below are kept as-is for history). New since the 2.1.2 tree:

- **Frontend split** — the 10,491-line `public/js/app.js` is now 15 concern-sized scripts (`core`, `ui`, `tabs`, `terminal`, `files`, `transfers`, `editor-panel`, `file-tabs`, `preview`, `viewers`, `launchpad`, `settings`, `security`, `git`, `misc`), moved byte-verbatim with zero behavior change; Service Worker cache bumped to `webtun-v8`
- **tmux ownership tracking** — shutdown kills exactly the sessions this process created (recorded, never inferred from the name); a box-shared claim file arbitrates the orphan sweeps between live same-namespace siblings; the startup sweep runs only after the port binds
- **Long filenames stay readable** — file rows truncate in the middle so the extension is always visible; selecting a row unwraps the full name; the breadcrumb auto-scrolls to the current folder with no width cap
- **Per-tab previews, un-scoped theme** — markdown/HTML preview state is per file tab; the editor theme no longer leaks across tabs
- **Dependency slimming** — `archiver` and `yauzl` replaced with stdlib zip code (4 prod deps left); express/multer/electron bumped; `typedarray` override pruned; `npm audit` clean
- **Fixes** — stuck tunnel rows (id kept across restarts, idempotent stop, panel resync); build config moved to `electron-builder.yml`; ignore files trimmed; stale `hasInstallScript` dropped from the lockfile

### v2.1.2
- **Zero install scripts** — the `postinstall` hook is gone (manual `npm run rebuild:pty`, repo-only, out of the tarball); the dead Yarn-only `resolutions` block is out of `package.json`; 17 files ship with nothing executable at install time
- **App preview hardening** — the `?token=` bearer is stripped (selectively, so apps with their own token logins keep working) before anything reaches your app; preview auth matches the main gate (raw-PIN approval, pending sessions); cookies are port-scoped, `Secure`-aware and shorter-lived; upstream dials die with the client; docs no longer claim proxied WebSocket hot-reload
- **Previewing WebTun itself is refused up front** — the terminal watcher, New Preview prompt and navigation compare against the server's real port (tunnel-safe), instead of serving a raw JSON frame
- **Per-instance tmux sessions** — `wt-webtun-<port>-<id>` so a repo checkout and a global/npx server never adopt or kill each other's sessions (crafted ids can't escape the namespace); closed terminals (SIGHUP) now run exit cleanup instead of orphaning tunnels
- **Fixes** — command library panel was inert (it sits inside `#content`, which it inertted); HTML preview renders through blob URLs with `<script>` bodies exempt from URL rewriting; root-absolute assets resolve against the file's folder; Git panel `Show more` / `Show advanced…` share one row; default command set trimmed to project entries

### v2.1.1
- **Transfer Center** — new up/down icon next to the coffee cup with live uploads, downloads and copy/move jobs: real bytes, speed and ETA, per-job Stop/Dismiss, hover-to-peek / click-to-pin panel with running-stripe bars. Single-file downloads report `Content-Length` for a true percent; copy/move pause while a conflict dialog waits and stop after the current file; zip/unzip and delete stay as toasts
- **Full HTML preview** — the editor HTML preview gains a **Full** mode next to Safe: the file renders verbatim with its own scripts running inside the same isolated opaque-origin frame (no app access, storage, popups or navigation); relative and root-absolute asset URLs resolve against the file's folder; works without the sanitizer CDN; the isolation notice shows once
- **Preview robustness** — URL rewriting no longer touches `<script>` bodies; a failed render explains itself in the pane instead of a silent blank; single-file server ops show activity + elapsed instead of a stuck 0%

### v2.1.0
> **First release since v2.0.4.** The 2.0.5 working tree was never tagged or published, so its changes ship here too — nothing was released under 2.0.5, so this upgrade path skips nothing.

- **Full audit remediation** — every actionable finding from the 2026-09-14 code review landed (113 fixed, 25 deliberately-kept behaviours left alone, including empty-PIN-is-open and full-filesystem-by-default)
- **Security** — concurrent logins can no longer both become active without approval; revoked or PIN-rotated sessions have their WebSocket connections actively closed (not merely asked to go away) with a 60s re-validation sweep; each rate limiter owns its own window; clipboard state is keyed per session with a TTL; tar entries that are links are refused and the extracted binary is containment-checked; error responses no longer leak absolute paths
- **App preview** — served on an opaque origin under a sandbox policy with the upstream CSP never merged, so a previewed app cannot reach your session token or files; proxy errors are normalized so it can no longer be used to probe which local ports are open; new `PREVIEW_PORTS` allow-list narrows which ports are previewable
- **Terminal** — clipboard *reads* (OSC 52 paste) are opt-in via Settings; pasting never splits multi-byte characters; docs hero and search work is unchanged in behaviour but far cheaper; pinch-zoom changes the size for the session only and no longer rewrites your saved font size
- **Editor & docs** — reopening a file offers to restore an unsaved draft (cleared on save or discard); EPUB previews are sandboxed; the tab strip is keyboard-reachable and modal panels make the rest of the page inert
- **File tabs** — open a file in its own tab next to your terminals (editor-header button or right-click → **Open in Tab**); **every code file gets its own live editor**, so **Tile view shows several files side by side** with independent cursors, scroll and undo history, plus a per-tab Save/Reload toolbar and a **Panel** button that hands the buffer to the split editor; PDF/EPUB/Office tabs share one live viewer instead, so several large documents stay open without the memory cost (parked tabs remember page, zoom, sheet and scroll); drafts, unsaved-changes guards and the two surfaces' buffers never diverge, and the tab layout is restored on reload
- **Reliability** — dead tunnels restart with backoff and give up cleanly instead of churning, and a recycled process ID can't pass as a live tunnel; the history cap survives restarts; staging a hunk is pinned to the hunk you clicked (it asks you to refresh rather than stage the wrong lines); the legacy state-file migration no longer runs on `require()`; a dead preview or search request can't hang the server
- **Performance** — system stats are cached and shared between the launchpad pulse, header icon and stats panel instead of each polling separately; live preview renders on edit rather than polling every second; upload progress updates once per frame; PDF scrolling no longer walks every page per frame
- **Packaging & scripts** — a version/lockfile/tag guard now gates CI and refuses a stale `npm publish`; `setup.sh` fetches and sanity-checks the NodeSource script instead of piping it into root bash; `install.sh` pre-checks its tools and refuses a dirty tree; `stop.sh` verifies the pidfile before signalling; `nodemon.json` keeps dev restarts off runtime state files
- **Config** — new `ALLOWED_ORIGINS` and `PREVIEW_PORTS`; JSON bodies are capped at 2 MB (12 MB for file writes) instead of a blanket 50 MB; a missing `git` binary returns 501 instead of 400
- **Docs** — in-app user guide at `/docs` (Settings → About → **User guide & docs**) covering terminal, editor, files, git, tunnels, sessions, shortcuts and troubleshooting, also published to GitHub Pages; keeping it current is now part of the agent workflow, so user-facing changes update `/docs` in the same change

### v2.0.0
- Launchpad home dashboard — zero-tab hero, recent commands with one-click or `1–6` keypress launch-and-run, places, live system pulse with sparkline, Today strip, optional screensaver
- Home button pinned left of the tab bar, always visible; dashboard pauses explorer auto-reload while shown
- Number-key runs work regardless of focus; inline syntax-checked, no new dependencies
- Hardening — first-PIN setup on open instances is loopback-only, process-kill requires PIN protection, WS handshake brute-force throttle, preview iframe is opaque-origin + refused without sanitizer, reconnect auto-retry stops at 10, unzip extracts to temp dir (no rollback wipe), recursive delete refuses roots, upload/download/image/spawn output caps, no `x-powered-by`, `/api/version` requires auth
- Sessions — revocable per-device login tokens with trusted-device resume; new logins start **pending** and can do nothing until a different active session approves them (correct PIN alone opens nothing); active-sessions list with per-device revoke, persistent header warning triangle + live count on the keep-awake cup, instant new-login / approval / PIN-change alerts with remote kick; fresh-session PIN rotations need a second session's approval (60s, deny-by-default)
- PDF viewer — selectable text layer over each page; EPUB/PDF fixes as before
- Packaging — runtime state (`PIN`, history, tunnels) moves to `~/.config/webtun` for global/npx installs, PWA update flow, Electron single-instance + sandbox + no prod DevTools, Windows `npm.cmd` postinstall fix, release assets fail loudly on missing files
- npm jumps `1.5.6` → `2.0.0` (`v1.5.7` was GitHub-only); ships under PolyForm Noncommercial 1.0.0 (≤v1.5.6 stays MIT)

### v1.5.7
- Explorer overhaul — unified path bar, rich rows (type-tinted icons, photo thumbnails, dates), sortable sticky groups, skeleton loading, quick download, hover-peek bookmarks, segmented nav header; large folders load much faster
- Git mini-panel — branch switching/creation, stash, discard, repo init, colorized diffs, commit, push/pull with ahead/behind + stash badges
- Settings control deck — collapsible card groups (closed by default) with live search, staggered entrance, plus runtime PIN set/change/disable saved to `.env`
- Lock screen redesign, animated keep-awake indicator, spinning refresh state
- PDF viewer — duplicate-page fix, lazy rendering for big documents, download progress
- Security — dependency audit clean (0 vulnerabilities); source-available license from this version (PolyForm Noncommercial, ≤v1.5.6 stays MIT)

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
- **v1.5.7 and later**: [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for noncommercial use (personal, research, education, charities, government).
- **Commercial use** needs a Pro or Team key: **Community** (free, noncommercial, 2 tunnels, 3 devices), **Pro** ($12/server/month, unlimited tunnels, SSH keys), **Team** ($19/admin/month, up to 10 admins, audit export). Keys work offline — paste one in Settings → Security → License. See `/docs` → Plans & license. For manual invoicing instead of self-serve checkout, contact [ptelgm.yt@gmail.com](mailto:ptelgm.yt@gmail.com). See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Built by <a href="https://github.com/unn-Known1">Gaurang Patel</a> · PolyForm Noncommercial 1.0.0 (v1.5.7+; ≤v1.5.6 MIT)</sub>
</p>

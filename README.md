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

## Development and verification

The backend services live in `lib/server/`; `server.js` wires them into the existing HTTP and WebSocket entrypoints. The frontend uses classic deferred scripts without a bundler. `editor-buffers.js` owns file content, saves, and drafts across editor surfaces; `actions.js` connects named controls to handlers in each feature script.

Use Node.js 20 or later for browser development checks; the application runtime still supports Node.js 18 or later.

```bash
npm ci
npm test                         # version, source, API, editor, WS, and import checks
npx playwright install chromium # once per machine
npm run test:e2e                  # desktop and mobile browser regressions
npm run test:all                  # both suites
npm start                        # run the app for manual checks
```

Tests use temporary files and substitute the operating-system PTY. Browser checks exercise the real frontend and file/auth/Git/terminal handlers, including slow saves, draft recovery, file handovers, and blocked editor dependencies. PR and release verification run both suites before Electron packaging. Playwright is a development dependency and does not ship in the npm runtime.

See [the architecture guide](docs/SYSTEM_ARCHITECTURE_AND_DESIGN_PRINCIPLES.md) for service boundaries, UI conventions, and verification limits. User-facing changes also belong in the built-in [user guide](public/docs.html).

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

### v2.3.6
- **Billing correctness** — checkout/renewal claim IDs, verified plan/seat/period entitlements, and webhook idempotency, plus plan/term/seat purchase and renewal activation UI.
- **File safety** — shared copy/move guards against self-paste and descendant overwrites, conflict accounting, occupied-rename refusal, complete merge rollback, symlink-accurate metadata, aligned ZIP limits, byte-range downloads, preserved folder uploads, and rate-limit-aware upload retries.
- **Preview isolation and transport** — session-bound port capabilities replacing IP leases, WebTun credential stripping on HTTP and HMR WebSocket targets, and original request-body forwarding.
- **Terminal and editor integrity** — per-connection PTY subscriptions, exit tombstones with explicit restart, cross-chunk history parsing, fallback PTY resize, descendant-aware renames, generation-guarded previews, draft-preserving lock teardown, and working viewer downloads.
- **Git, SSH, and coverage** — branch creation/deletion/merge/continue/abort, NUL-delimited Unicode paths, paginated history and bounded blame; OpenSSH-compatible key export without signaling foreign PIDs; worker-isolated regex search, rotation-aware log tail, native PTY tests, and remediation browser specs.

### v2.3.5
- **Mobile keyboard and viewport** — the ESC/TAB/CTRL bar is no longer clipped when the iPhone keyboard opens, and the workspace fills the screen edge-to-edge in Home Screen mode instead of leaving a dead strip under the bottom navigation.
- **Mobile tab strip and hostname** — tabs snap to whole slots instead of scrolling mid-name, and a long hostname truncates with an ellipsis (full name in the tooltip).
- **Compact mobile chrome** — a shorter bottom navigation row and tighter Settings panel spacing, with touch targets unchanged.

### v2.3.4
- **Fonts and offline previews fixed** — the CSP blocked `fonts.googleapis.com`, so the app silently rendered in fallback fonts; it also blocked the CDN asset loads the service worker proxied, breaking every PDF/EPUB/DOCX/XLSX preview in an installed PWA.
- **About card rebuilt** — aligned rows with the app's own icon, a themed version pill, and a monospace repo URL that wraps instead of overflowing.
- **Clean command history** — terminal escape-sequence introducers were recorded as typed text, so stray device-reply bytes ended up prepended to saved commands.

### v2.3.3
- **Offline file previews** — Markdown and HTML preview libraries bundled; the Preview button targets the right editor when file tabs are open.
- **Accessibility and polish** — dialog focus handling, named controls, better light-theme contrast, larger mobile touch targets.
- **Startup and motion** — deferred editor/preview assets and fewer persistent effects, without losing interaction feedback.

### v2.3.2
- **Mobile keyboard correctness** — the keyboard inset is applied to one layout owner instead of two, which was collapsing the terminal to a few pixels while keystrokes still reached the shell.
- **Desktop toolbar & stacking** — the editor's Save button no longer clips at the default panel width, the fullscreen editor no longer paints over the drawers, and Keyboard Shortcuts / Listening Ports are reachable on desktop again.
- **Layout integrity** — the file explorer no longer collapses under the git panel, the git header no longer clips at tablet width, and tab-strip buttons no longer jump on overflow.
- **Touch targets** — the tab close button and inline row actions gained full-size hit areas without changing their look.
- **Theming & accessibility** — per-theme amber (three light themes measured 1.63–2.07:1), real `prefers-reduced-motion`, focus rings on 19 ringless controls, and Windows High Contrast support.
- **Design system** — one type scale (23 sizes → 10 tokens), one icon scale, a unified count badge, and a single key-bar state reconciler.
- **Reachable OLED theme** — Midnight OLED existed in CSS but not in the picker or the settings allowlist, so a stored value silently reset.

### v2.3.1
- **Terminal Sessions manager** — list, attach and label sessions from one place (`Alt+S`), with live state synced across windows.
- **Listening Ports dashboard** — scan local TCP servers, see process names and PIDs, and launch a preview tab in one click.

### v2.3.0
- **Context-scoped keyboard routing** — shortcuts route by focus (terminal, explorer, editor, launchpad) with full pass-through for TUI apps (`tmux`, `vim`, `fzf`) and explorer-native keys for navigation, rename and delete.
- **Identity and UI polish** — new vector mark, hostname badge with network state, live system metrics on the Launchpad, a filterable process table with two-step kill confirmation, 1-click SSH config, and the OLED Midnight theme.

### v2.2.8
- **Two new light themes** — Catppuccin Latte and Nord Light, both WCAG-AA compliant.
- **Theme engine fixes** — theme state is applied consistently on boot, with a `tokyo-night` alias and immediate terminal re-render on palette change.

### v2.2.7
- **Desktop readiness** — single-instance lock, global hotkeys routed through xterm, submenu edge clamping, focus refresh for the Git panel, and Solarized Dark contrast fixes.
- **Mobile tabs and editor resilience** — mobile tab chrome aligned with desktop, and a native `<textarea>` fallback when CodeMirror cannot load.

### v2.2.6
- **Mobile ergonomics** — stopped the keyboard popping up while scrolling, stopped PTY resize churn during keyboard animation, docked the key ribbon above the keyboard, added a thumb-zone bottom bar with haptics, and turned context menus into bottom sheets.

### v2.2.5
- **SSH access (opt-in)** — one-time ed25519 keys for Termius/mobile/`ssh`, one-click setup checks with per-check fixes, and copy-ready LAN/Tailscale recipes. Server-enforced toggle, off by default.
- **Login and file properties** — Enter-to-unlock works on every PIN screen, and file permissions gained a live octal/symbolic decode.

### v2.2.4
- **Security hardening** — reflected XSS escaped in preview errors, raw-PIN path fails closed, PIN rotation persists before applying, and preview sockets are reaped on rotate/revoke.
- **Backend** — tunnel and upload SSRF closed, upload depth caps, zip bomb caps, git route guards, capped/sandboxed search, and new JSON body limits.
- **Frontend** — terminal title forwarding, streaming decode, paste/history fixes, forced re-login on revoke, tab state persistence, and WCAG-AA theme contrast.
- **CLI/infra** — `npm ci`, a systemd double-start guard, `=`-style flags, host-aware healthcheck, and a strict version/tag/README release gate.

### v2.2.3
- **Tabs** — pin protection, context menus, middle-click and right-click handling, and keyboard reachability.
- **File explorer** — audit pass over listing, selection and rows, plus zip/unzip jobs in the Transfer Center.
- **Settings, stats and docs** — settings audit corrections, terminal context-menu work, stats panel additions, and updated guides/screenshots.

### v2.2.2
- **Terminal directory follows `cd`** — "Go to terminal directory" resolves the session's live path via `/api/sessions/:id/cwd` instead of the stale launch directory.
- **Open files track external changes** — buffers re-stat every 10s: clean files auto-reload, dirty files keep your edits and raise a "Changed on disk" marker.
- **Dependency bumps** — `electron-builder`, `actions/checkout` and `actions/setup-node`.

### v2.2.1
- **Express 5** — upgraded with the new wildcard-route syntax; `/`, `/docs`, file/git/system APIs and the preview proxy smoke-tested.
- **Dependencies and automation** — current `node-pty`/`ws`, a clean `npm audit`, weekly Dependabot, a PR check workflow, and a CodeRabbit review config.

### v2.2.0
> Never tagged or published — this tree first shipped as v2.2.1; kept for history (as with the v2.1.x sections below).

- **Frontend split** — the single 10.5k-line `app.js` became 15 concern-sized scripts, moved verbatim with no behavior change.
- **tmux ownership tracking** — shutdown kills exactly the sessions this process created; a claim file arbitrates orphan sweeps between live siblings.
- **Readable long filenames** — rows truncate in the middle so the extension stays visible; selection reveals the full name.
- **Per-tab previews** — preview state is per file tab and the editor theme no longer leaks across tabs.
- **Dependency slimming and fixes** — stdlib zip code replaced two packages, stuck tunnel rows fixed, and build config moved to `electron-builder.yml`.

### v2.1.2
- **Zero install scripts** — the `postinstall` hook is gone (rebuild `node-pty` manually, repo-only); nothing executes at install time.
- **App preview hardening** — the `?token=` bearer is stripped before reaching your app, preview auth matches the main gate, cookies are port-scoped, and docs no longer claim proxied WebSocket hot-reload.
- **Per-instance tmux sessions** — `wt-webtun-<port>-<id>` so separate installs never adopt or kill each other's sessions.
- **Fixes** — the command library panel was inert, HTML preview renders through blob URLs, and Git panel actions share one row.

### v2.1.1
- **Transfer Center** — live uploads, downloads and copy/move jobs with real bytes, speed, ETA and per-job Stop/Dismiss.
- **Full HTML preview** — a Full mode beside Safe that renders files verbatim in an isolated opaque-origin frame with no app access.
- **Preview robustness** — URL rewriting skips `<script>` bodies, and a failed render explains itself instead of going blank.

### v2.1.0
> **First release since v2.0.4.** The 2.0.5 tree was never tagged or published, so its changes ship here — nothing was ever released under 2.0.5.

- **Full audit remediation** — all 113 actionable findings from the 2026-09-14 code review landed (25 deliberate behaviours, like empty-PIN-is-open, were left alone).
- **Security** — concurrent logins need approval, revoked sessions have their WebSockets actively closed, per-session rate limiters, archive-link refusal, and errors no longer leak absolute paths.
- **App preview** — served on an opaque origin under a sandbox policy, with normalized proxy errors and a new `PREVIEW_PORTS` allow-list.
- **File tabs** — open any file in its own live tab (Tile view shows several side by side); heavy viewers share one viewer; drafts and unsaved guards never diverge.
- **Editor & docs** — unsaved-draft restore on reopen, sandboxed EPUB previews, a keyboard-reachable tab strip, and the in-app guide at `/docs`.
- **Reliability & performance** — dead tunnels back off and give up, the history cap survives restarts, stats are cached and shared, and previews render on edit instead of polling.
- **Packaging, config and gates** — a version/lockfile/tag guard blocks stale publishes, safer setup/install/stop scripts, `ALLOWED_ORIGINS` and `PREVIEW_PORTS`, and JSON bodies capped at 2 MB.

### v2.0.0
- Launchpad home dashboard — zero-tab hero, recent commands launchable by number key, places, live system pulse, optional screensaver.
- Sessions — revocable per-device login tokens where a new login stays pending until an active session approves it, plus device revoke and PIN-rotation approval.
- Hardening — loopback-only first PIN setup, PIN required to kill processes, WebSocket brute-force throttle, opaque-origin previews, bounded retries, and output caps across uploads/downloads.
- Packaging — runtime state moved to `~/.config/webtun`, PWA update flow, Electron single-instance and sandbox, and license change to PolyForm Noncommercial (≤v1.5.6 stays MIT).

### v1.5.7
- Explorer overhaul — unified path bar, rich rows with thumbnails and dates, sortable sticky groups, skeleton loading, quick download and hover-peek bookmarks.
- Git mini-panel — branch, stash, discard, diffs, commit and push/pull with ahead/behind badges.
- Settings control deck — collapsible groups with live search and runtime PIN set/change/disable.
- Lock screen redesign, animated keep-awake indicator, PDF lazy rendering and download progress; dependency audit clean.

### v1.5.6
- Fixed preview for unsupported file types and for HTML; PDF/EPUB preview with vertical scroll, instant setup, and EPUB/PDF paging fixes.

### v1.5.5
- Explorer — full filesystem access by default, navigable symlinks, fixed 403 bounce on `..`, fixed breadcrumb/history desync and stale-closure bugs, rename dialog no longer closes on error.
- Settings — drawer flicker fixed via isolation hints and deferred `inert`/focus traps.
- Editor — `F11` fullscreen contained inside the terminal area instead of covering the sidebar or header.
- Terminal — removed the `Shift+F11` fullscreen mode.

### v1.5.4
- Security — path sandbox, symlink containment, traversal blocks, zip/unzip bomb guards, header sanitization, tunnel SSRF protection, and constant-time PIN comparison with per-IP rate limits.
- UI/UX — touch target sizing, ARIA roles and focus traps, pull-to-refresh, safe-area handling, and autosaved editor drafts.
- Explorer and editor — compact unified headers, middle-truncating file rows, and contained editor fullscreen with split support.
- System stats — per-row process kill with self/cloudflared protection; PWA stale-while-revalidate caching.

### v1.5.3
- Terminal session persistence without tmux (in-memory PTY on Windows and Linux); tabs survive reload on all platforms.

### v1.5.2
- Replaced native `confirm()` with a focus-trapped dialog; added explorer keyboard navigation, context-menu keyboard support, and a pull-to-refresh indicator.
- Typography — JetBrains Mono for code surfaces paired with IBM Plex Sans for chrome, plus an explicit Tokyo Night theme and `color-scheme` for all six.
- Accessibility — dialog semantics, toast icons, busy-spinner buttons, inline field errors, unsaved-changes indicators, skip link and landmark roles.
- Deferred CDN scripts for faster first paint; fixed the CodeMirror mode and addon-webgl load errors.

### v1.5.1
- Fixed command history saving terminal garbage and VT/ANSI reply bytes, and 401s on Cloudflare tunnel URLs.
- Fixed a CodeMirror `defineSimpleMode` error and console accessibility warnings; added a safe `localStorage` wrapper for Tracking Prevention.

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

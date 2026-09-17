# WebTun 60-Second 4K/60fps Video Plan

## Product
- **Name:** WebTun
- **Tagline:** Your server, one tab away.
- **Website:** `github.com/unn-Known1/webtun`
- **Creator:** Gaurang Patel

## Hook
Terminal window zooms in: `npx webtun` types out char-by-char → `→ localhost:3000` fades in. Clean, fast, confident.

## Creative angle
Developer-focused showcase: WebTun is a self-hosted web terminal with real shells, a code editor, file manager, git panel, and Cloudflare tunnels. The video cycles through all 6 themes to show it's a polished product you'd want to use daily.

## Tone
`default` — clean, polished, confident. Not a joke. Not over-produced. Just a really good tool.

---

## Storyboard (60 seconds)

| # | Time | Scene | What must be seen / read |
|---|------|-------|--------------------------|
| 1 | 0–4s | **Terminal Hook** | macOS-style window, dark theme. `npx webtun` types char-by-char → `→ localhost:3000` fades in |
| 2 | 4–10s | **Launchpad — Tokyo Night** | Logo tile, "WebTun" title, tagline, host badge (`localhost:3000`), pulse dot "Server online", Recent commands card, Places card |
| 3 | 10–18s | **Theme Showcase** | Same launchpad layout, themes cycle: Tokyo Night → Light → Solarized Dark → Gruvbox → Dracula → Monokai → back to Tokyo Night. Background crossfades, accent color changes per theme |
| 4 | 18–25s | **Multi-Terminal + Tabs** | 3 terminal tabs visible, tile view showing 2 terminals side-by-side, `git status` output, `npm run dev` output showing server running |
| 5 | 25–33s | **Editor + Git Panel** | Code editor with JS syntax highlighting (purple keywords, green strings, blue functions), dirty dot on filename, Save button. Git panel: staged (blue), modified (yellow), untracked (green) files. Live Cloudflare tunnel URL |
| 6 | 33–39s | **File Manager** | Sidebar with folder hierarchy, breadcrumb, file badges (GIT/EDIT/VIEW), right-click context menu with actions |
| 7 | 39–46s | **Command Palette + Shortcuts** | Ctrl+P fuzzy-finder palette overlay. Keyboard shortcuts grid showing Ctrl+P, Ctrl+T, Ctrl+B, Ctrl+F, Ctrl+S etc. |
| 8 | 46–52s | **System Stats + Settings** | CPU/Memory/Disk gauges with live values, Top Processes table with Kill buttons. Settings panel showing all 6 theme options with current selection |
| 9 | 52–57s | **PWA + Tunnel** | Phone mockup with "Add to Home Screen" banner. Large tunnel URL: `*.trycloudflare.com`. Security triangle badge |
| 10 | 57–60s | **Outro** | WebTun logo (accent blue tile) + "Your server, one tab away." + "github.com/unn-Known1/webtun" → fade to black |

---

## Visual Identity (from real `styles.css` tokens)

### Tokyo Night (primary)
| Variable | Value |
|----------|-------|
| `--bg` | `#1a1b26` |
| `--bg2` | `#16161e` |
| `--bg3` | `#24283b` |
| `--bg4` | `#2a2d3e` |
| `--border` | `#3b3f52` |
| `--fg` | `#c0caf5` |
| `--fg2` | `#787c99` |
| `--fg3` | `#565f89` |
| `--accent` | `#7aa2f7` |
| `--accent2` | `#bb9af7` |
| `--green` | `#9ece6a` |
| `--red` | `#f7768e` |
| `--yellow` | `#e0af68` |
| `--cyan` | `#7dcfff` |

### Theme cycle colors
| Theme | `--bg` | `--accent` | `--fg` | `--green` |
|-------|--------|-----------|--------|-----------|
| Tokyo Night | `#1a1b26` | `#7aa2f7` | `#c0caf5` | `#9ece6a` |
| Light | `#f9f9fb` | `#4060d0` | `#1f1f30` | `#2f7d1f` |
| Solarized Dark | `#002b36` | `#268bd2` | `#93a1a1` | `#859900` |
| Gruvbox | `#282828` | `#83a598` | `#ebdbb2` | `#b8bb26` |
| Dracula | `#282a36` | `#bd93f9` | `#f8f8f2` | `#50fa7b` |
| Monokai | `#272822` | `#a6e22e` | `#f8f8f2` | `#a6e22e` |

### Fonts
- **UI Font:** IBM Plex Sans (400, 600, 700)
- **Code Font:** JetBrains Mono (400, 700)

---

## Audio
- **Track:** `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` (already in `assets/music/`)
- **Treatment:** Fade music out at 58s as logo appears, silence under outro
- **No SFX** (clean product showcase)

---

## Transitions
- Scene changes: 0.25s opacity fade via GSAP
- Theme cycling (Scene 3): 1.3s per theme, background color crossfades via CSS variable animation
- All other transitions: natural GSAP easing

---

## Copy that must appear verbatim
- "WebTun" (title)
- "Your server, one tab away." (tagline)
- "npx webtun" (terminal command)
- "→ localhost:3000" (URL indicator)
- "Server online" (pulse label)
- "localhost:3000" (host badge)
- "*.trycloudflare.com" (tunnel URL — anonymized)
- "github.com/unn-Known1/webtun"
- All keyboard shortcut labels

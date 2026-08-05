# WebTun — UI/UX Audit Report

**App:** WebTun — self-hosted web terminal + file explorer + code editor (PWA)
**Frontend:** single file `public/index.html` (5,735 lines, vanilla HTML/CSS/JS) + `commands.js`
**Audit scope:** Deep analysis of layout, theming, accessibility, interaction design, mobile/responsive behavior, and information architecture.
**Severity scale:** 🔴 Critical → 🟠 High → 🟡 Medium → 🔵 Low

---

## Executive Summary

WebTun is a feature-dense developer tool with strong fundamentals: a solid token-based theme system (6 themes), proper `prefers-reduced-motion` / `prefers-reduced-transparency` handling, touch-aware terminal interactions, and a remarkable amount of mobile polish (pinch-zoom, swipe gestures, long-press menus, pull-to-refresh).

The main weaknesses fall into four buckets:

1. **Theme bugs** — an undefined CSS variable (`--fg3`) and a hardcoded terminal selection color that ignores the active theme.
2. **Inconsistent visual language** — native `confirm()` dialogs interrupt a custom-designed modal system; emoji/text glyphs are used as icons.
3. **Accessibility gaps** — the file explorer is entirely mouse/touch-driven with no keyboard path; modals have no focus trap; several icon-only buttons lack accessible names.
4. **Feedback/loading** — no loading states for the file list (a slow-remote-network app), and no visual busy indicator for directory navigation.

None of these are blockers to shipping, but fixing the 🔴/🟠 items would meaningfully raise perceived quality.

---

## 1. 🔴 Critical

### 1.1 Undefined `--fg3` CSS variable — muted text renders at full brightness
`--fg3` is referenced in 3 places but **never defined in any theme** (`:root`, light, solarized, gruvbox, dracula, monokai):

- `public/index.html:564` — `.ctx-submenu-arrow` (`color: var(--fg3)`)
- `public/index.html:700` — `.cmd-hist-time` (10px timestamps)
- `public/index.html:1245` — `#about-version`

Because the variable is undeclared, the property falls back to `unset` → inherits the parent color. So the "muted" history timestamps, the version number, and the submenu arrow all render at full-intensity text color, defeating the visual hierarchy that was intended.

**Suggestion:** Add `--fg3` to `:root` and every theme block, e.g. `--fg3: #565f89` (Tokyo Night) with equivalents per theme. Keep it between `--fg2` and the background for a true tertiary tier.

### 1.2 Hardcoded terminal selection theme ignores the active theme
`public/index.html:2167-2171`:
```js
selectionTheme: {
  extension: true,
  foreground: '#1a1b26',
  background: '#7aa2f744'   // Tokyo Night blue @ 27%
}
```
This is hard-coded Tokyo Night regardless of which theme the user picks. In Light/Solarized/Gruvbox/Dracula/Monokai the selection highlight stays dark-blue-tinted, and the selected-text foreground (`#1a1b26` near-black) disappears into dark themes like Dracula.

**Suggestion:** Derive both values from CSS variables like `getXtermTheme()` already does — `foreground: g('--bg')` and `background: g('--accent') + '44'` — and rebuild the selection theme in `applyTheme()`.

---

## 2. 🟠 High

### 2.1 Native `confirm()` dialogs break the app's visual language
`confirm()` is used for 6 different flows: tab close (`:2120`), unsaved editor close (`:2126`, `:3657`), file delete (`:3198`), multi-delete (`:3305`), and large-file open (`:3558`).

The app has a beautiful custom overlay/modal system (`.overlay` + `.modal`, `:447-453`) — the same used by the conflict-resolution dialog — yet destructive actions drop out to the OS's default browser dialog, which is jarring, non-themeable, and blocks the terminal's focus.

**Suggestion:** Add a reusable `confirmDialog({ title, message, confirmText, danger })` promise-based modal using `.overlay`/`.modal` styling. Replace all 6 `confirm()` call sites. This is a high-visibility polish win.

### 2.2 File explorer has no keyboard accessibility
File items are `<div role="option">` (`:2695`) inside `role="listbox"` (set at `:1628`), but items have **no `tabindex`** and there is **no arrow-key / Enter / type-ahead navigation** (`makeFileItem`, `:2692-2720`). Keyboard users cannot navigate, open, or select files at all. The sidebar header buttons (back/forward/up/refresh) are real buttons, so focus lands there and stops.

**Suggestion:**
- Give the container `tabindex="0"` and each item `tabindex="-1"`.
- Add ArrowUp/Down to move an `aria-activedescendant`-driven highlight, Enter to open, Ctrl/Shift+Space to toggle selection.
- Add a home/end shortcut and type-ahead (jump to filename prefix).

### 2.3 No loading / busy state for directory navigation
`loadFiles()` (`:2565-2690`) performs an async fetch and swaps the list on completion, but there is **no skeleton, spinner, or stale-content dim** in between. On a slow tunnel (the app's primary remote use-case), clicking a directory can show the *previous* directory for 1–3 seconds with no feedback, then swap abruptly. The error state *is* handled well (Retry button, `:2590-2597`).

**Suggestion:**
- Add a `loading` class on `#file-list-wrap` during fetch → `opacity: 0.45` + a slim progress bar at the top of the list, or 4–6 skeleton rows.
- Keep the old rows visible but dimmed (avoids layout jump), then fade to new content.
- The fuzzy finder already does this well (`Searching…`, `:5197`) — reuse that pattern.

### 2.4 Header overcrowding on mobile
`#header` (`:897-927`) packs 11 controls into 38px: status dot, logo, hostname badge, keep-awake toggle, sidebar toggle, search toggle, command-library toggle, system-stats toggle, tiles toggle, settings gear, upload-progress. At ≤480px, `.icon-btn` is 28px with 3px gaps (`:804-811`) — on a 375px screen the row overflows or squeezes the logo. The hostname badge is hidden on mobile (`:829`) which removes important context for a remote-access tool.

**Suggestion:**
- Group secondary actions (system stats, tiles, command library) into a single "more" (`⋮`) overflow menu or move them into the Settings panel.
- Restore a compact hostname indicator on mobile (e.g., first segment + ellipsis) instead of hiding it entirely.

### 2.5 Icon-only buttons lack accessible names
Several SVG-only buttons rely solely on `title` (tooltip), which is not a reliable accessibility name:

- `file-action-btn` (`.file-item .file-actions`, `:363`) — Rename/Copy/Cut/Paste/Download icons
- `cmd-lib-run` / `cmd-lib-del` (`:5315-5331`, `:5529-5540`)
- Tunnel row buttons — Copy / Open / Stop (`:4099-4118`)

**Suggestion:** Add `aria-label="..."` to every SVG-only button (many already have it in the static HTML — the JS-generated ones are the gaps). Low effort, measurable a11y improvement.

### 2.6 Touch tap-highlight flash
No `-webkit-tap-highlight-color` is set anywhere, so on iOS/Android tapping file items, tabs, and keys flashes the default gray/blue highlight before the `:active` transform runs. It reads as a glitch.

**Suggestion:** `* { -webkit-tap-highlight-color: transparent; }` and rely on the existing `:active` scale/color states for feedback.

---

## 3. 🟡 Medium

### 3.1 Emoji / text glyphs used as icons (inconsistent rendering + a11y)
The app correctly uses inline SVGs everywhere else, but a few places fall back to emoji/text glyphs which render inconsistently across platforms/fonts and are announced unpredictably by screen readers:

- `⚠️ Reconnecting…` banner — `:928`
- `⚠️` tunnel warning status text — `:4141`
- `✓` / `⚠` / `✗` upload progress text — `:3476-3480`
- Mobile key legends: `⎚` (U+239A, frequently missing → tofu box on many Android fonts) `:1080`, `▲▼◀▶` `:1086-1089`, `⌫` `:1098`, `⇧` `:1108`, `▸` `:1303`
- Delete glyphs `×` on cmd-lib/history items — `:5331`, `:5539`

**Suggestion:** Replace with SVG icons (Heroicons/Lucide style, already used throughout). At minimum, replace `⎚` with an SVG or a labeled button, and make the status glyphs real inline SVGs so they're theme-colored.

### 3.2 Deprecated `document.execCommand('insertText')` for command insertion
Cmd-library and history clicks insert text via `document.execCommand('insertText', false, c.cmd)` (`:5343`, `:5547`). `execCommand('insertText')` is deprecated and unreliable in modern browsers when the terminal textarea isn't the focused editable context.

**Suggestion:** Write directly into `tab._currentInput`, set `tab.textarea.value` or focus + `document.execCommand('insertText')` fallback, then send. Better: keep the panel open with an explicit "Send" path, or use `tab.term.paste(c.cmd)` (xterm.js supports `term.paste()` which respects bracketed paste).

### 3.3 Breadcrumb wraps vertically on deep paths
`#file-breadcrumb` uses `word-break: break-all; line-height: 1.8` (`:347`). A deep path (very common when tunneling into a server) becomes a multi-line block that consumes vertical space and shoves the file list down; the path input (`:944`) already shows the raw path.

**Suggestion:** Make the breadcrumb `white-space: nowrap; overflow-x: auto;` with `::-webkit-scrollbar { display:none }`, and optionally middle-truncate segments. Keeps one line regardless of depth.

### 3.4 Tab-bar right-edge mask fades the "new tab" button
`#tab-bar` applies `mask-image: linear-gradient(to right, black calc(100% - 20px), transparent)` (`:166`). The `#new-tab-btn` is a child of the same bar (`:996-999`), so the last 20px fade makes the `+` button appear translucent/partially cut off when tabs overflow — exactly when users need it most.

**Suggestion:** Keep the mask only for the scrollable tab area (wrap tabs in a masked inner container) or move `#new-tab-btn` outside the masked region, or shrink the fade to ~8px and add a right edge handle.

### 3.5 Keep-awake toggle has an infinite bounce animation
When enabled, the toggle's dot runs `keepawake-bounce` indefinitely (`:313-318`), oscillating between two positions. A perpetual animation is distracting, draws the eye away from the terminal, and (before the global reduced-motion rule) could be a vestibular trigger.

**Suggestion:** Replace with a static sliding dot (transition on `checked`, no loop) plus the accent border already present. Optionally add a `title` state change ("Screen wake locked").

### 3.6 Modals have no focus trap / focus restore
Overlays (`:447-453`) render a backdrop + modal, but keyboard focus is not trapped: users can Tab out of the modal into the app behind it, and when a modal closes, focus is not returned to the triggering element. Only the PIN input (`:1550`) and finder input (`:5187`) explicitly `focus()`.

**Suggestion:** Add a small focus-trap helper (cycle Tab within `.overlay.open`, restore focus on close) for the finder, system-stats, rename/new-folder/new-file, conflict, and image-viewer overlays.

### 3.7 Context menus lack keyboard support
`#ctx-menu` and `#term-ctx-menu` have `role="menu"` / `role="menuitem"` (`:1266-1284`, `:1287-1318`) but no arrow-key navigation, no Enter activation, and no `aria-expanded` state on the submenu. Screen-reader/menu-role semantics are present but inert.

**Suggestion:** Add `keydown` handling on open (Arrows move highlighted item, Enter activates, Escape closes) and set `aria-expanded` on the "More Options" submenu wrapper.

### 3.8 Light-mode contrast is borderline for small muted text
In the light theme `--fg2: #3a3a5a` (`:85`) is used for 10–11px labels: `.file-size` (`:359`), `.cmd-hist-time` (`:699`), `.search-results` (`:442`), `.sys-sub` (`:792`). At 10px on `--bg3`/`--bg` the effective contrast hovers near the 4.5:1 threshold, and it's noticeably faint on many screens.

**Suggestion:** Darken light-theme `--fg2` to ≈`#2f2f4a`, and/or bump the smallest labels to 11px. Verify against WCAG 4.5:1 in light mode.

### 3.9 Stale-content flicker + flash of old directory on navigation
Related to 2.3 but distinct: because `loadFiles` keeps rendering the old DOM until the fetch resolves and uses DOM reuse (`:2607-2625`), fast double-navigation can briefly flash the intermediate directory. The abort controller helps, but there's no guard against the "flash of previous folder."

**Suggestion:** Mark a navigation in progress, abort+ignore stale responses (partly done via `loadFilesAbortController`), and only commit the DOM swap after a short minimum transition with a dim overlay.

### 3.10 `z-index` stacking is a patchwork
Search bar `z-20` (`:435`), cmd-lib panel `z-25` (`:653`), settings panel `z-15` (`:278`), sidebar `z-30` (mobile, `:824`), editor-view `z-5` (mobile, `:247`), drop overlay `z-50`, toasts `z-450`, modals `z-400`, context menus `z-500`. Settings (15) sits **below** cmd-lib (25) and search (20), so if the settings panel is open and search is toggled, the search bar draws over it. With toasts at 450 vs modals at 400, toasts overlay modals (intended). This works but is fragile.

**Suggestion:** Define a small set of named z-scale tokens (e.g., `--z-header: 10; --z-popover: 25; --z-overlay: 400; --z-toast: 450; --z-menu: 500`) and use them consistently; document the intent.

---

## 4. 🔵 Low / Polish

### 4.1 No web-font; terminal rendering depends on installed fonts
`--font` (`:81`) is a platform fallback stack (`SF Mono / Fira Code / Cascadia Code / Consolas`). On Linux without these installed it falls to generic `monospace`, so the same app looks different across OSes and some glyphs (box-drawing for TUI apps) may render poorly.

**Suggestion:** Load JetBrains Mono (the ui-ux-pro-max recommendation for developer tools) from Google Fonts with `monospace` fallback. Requires adding `fonts.googleapis.com` / `fonts.gstatic.com` to the server CSP (`server.js` currently allows `cdn.jsdelivr.net`).

### 4.2 Mixed icon sizes across the UI
Header icons 16px, tab icons 12px, sidebar controls 12px, file-type icons 14px, context menus 12px, command-library run 14px. All use `viewBox="0 0 24 24"` (good), but rendered sizes are inconsistent, making related controls feel different weights.

**Suggestion:** Standardize on a 2–3 tier scale (14px default, 12px dense, 16px header) and document it.

### 4.3 Tunnel list rendered with inline styles
`renderTunnels()` (`:4067-4123`) builds rows with `row.style.cssText = ...` inline styles instead of CSS classes, unlike the rest of the app. Makes theming/hover/focus styling harder and diverges from the codebase's pattern.

**Suggestion:** Extract to `.tunnel-row`, `.tunnel-url`, `.tunnel-status` classes so they inherit theme tokens.

### 4.4 Pull-to-refresh has no visual indicator
The file-list pull-to-refresh (`:5026-5058`) translates the list but gives no "pull to refresh / release to refresh" affordance (indicator icon, distance threshold hint). Users may not realize the gesture exists.

**Suggestion:** Add a small spinner/arrow that appears as you pull, completing only past the 60px threshold, with a success toast on refresh.

### 4.5 PWA manifest has empty `screenshots` array
`manifest.json:14` — `"screenshots": []`. Chrome-based install flows can use screenshots for a richer install experience.

**Suggestion:** Add 1–2 screenshots (1280×800 or 1280×720) with `purpose: "any"`.

### 4.6 File-action buttons are hover-reveal only on desktop
`.file-item .file-actions { display:none }` → shown on `:hover` (`:361-362`). On touch they're always visible (`:364-368`). On desktop the actions are invisible until hover, which is standard but reduces discoverability.

**Suggestion:** Keep hover-reveal but consider showing a subtle ellipsis "⋯" affordance on non-hovered rows.

### 4.7 About/version and status indicators
- The About "version" uses undefined `--fg3` (see 1.1).
- `#conn-status` is an 8px dot with only a `title` (`:898`); it has no `aria-label`/`role="status"`.
- `#hostname-badge` hidden on mobile (see 2.4).

**Suggestion:** Give the status dot `role="status"` with an `aria-label` that updates ("Connected"/"Disconnected") so screen-reader users get connection state.

### 4.8 Touch targets for tab close button
`.tab-close` is 16×16 with a 0.4 opacity baseline (`:333`). On coarse pointers it grows to 44px (`:140`) but the opacity affordance stays subtle. Acceptable; just note hover vs. touch parity is fine after the pointer-coarse rules.

### 4.9 `scroll-behavior: smooth` on `html/body`
`html, body { scroll-behavior: smooth }` (`:123`) targets the viewport, which is `overflow: hidden` and never scrolls. It has no effect on the app's inner scroll containers (file list, tab bar, modals). Harmless but misleading — either apply smooth-scroll to the intended containers or remove.

### 4.10 Search bar fixed width + overlap
`#search-input` is fixed `200px` (`:437`) and the bar floats over the terminal (`top:8px; right:12px`). On narrow screens 200px + buttons can exceed available width and the bar overlaps terminal text with no repositioning.

**Suggestion:** Let the bar be fluid (`min(280px, calc(100vw - 24px))`), and nudge it below the tab bar on mobile instead of overlapping the first terminal rows.

---

## 5. What's Done Well (keep these)

- **Real theming architecture** — CSS custom properties per theme, live-switchable with zero reload, synced to xterm and the `theme-color` meta tag (`:4180-4193`).
- **`prefers-reduced-motion` and `prefers-reduced-transparency`** both respected (`:448`, `:856-858`) — rare and appreciated.
- **Touch-first terminal UX** — pinch-zoom persists font size (`:2368-2404`), tap-to-mouse translation for TUIs (`:2299-2334`), wheel scroll handling with TUI mouse-tracking detection (`:2343-2365`), mobile key bar with shift/alt latching (`:2440-2461`).
- **Robust failure/empty states** — directory load Retry UI (`:2590-2597`), "Empty directory" (`:2682-2687`), finder searching/no-results messaging (`:5196-5204`).
- **Conflict-resolution modal** is a strong, well-designed decision UI (`:1424-1437`).
- **Keyboard shortcut coverage** for power users — Ctrl+P finder, Ctrl+T tab, Ctrl+B sidebar, Ctrl+F search, tab cycling (`:4510-4544`).
- **Session persistence** — tabs + tmux sessions restored on reload, cleanup on server start.
- **Good use of ARIA where static** — `role="tablist/tab/menu/menuitem/listbox/option"`, `aria-live` toast container, labeled PIN input.

---

## 6. Suggested Fix Order (impact × effort)

| # | Item | Severity | Effort | Win |
|---|------|----------|--------|-----|
| 1 | Define `--fg3` in all themes | 🔴 | S | restores intended hierarchy everywhere |
| 2 | Theme-aware selection color in xterm | 🔴 | S | consistency across all 6 themes |
| 3 | Loading/busy state for file list | 🟠 | S–M | kills the "is it broken?" moment on remote servers |
| 4 | Keyboard nav for file explorer | 🟠 | M | unlocks the app for keyboard-only users |
| 5 | Replace native `confirm()` with themed dialog | 🟠 | M | removes the jarring OS dialogs |
| 6 | Collapse mobile header into overflow menu | 🟠 | M | fixes overflow + restores hostname context |
| 7 | SVG-ify emoji/glyph icons + add `aria-label`s | 🟡 | M | rendering + a11y parity |
| 8 | Single-line scrollable breadcrumb | 🟡 | S | stable vertical layout on deep paths |
| 9 | Fix tab-bar mask clipping `+` button | 🟡 | S | core control always visible |
| 10 | Keep-awake: drop infinite bounce | 🟡 | S | calmer UI |
| 11 | Focus trap for overlays | 🟡 | M | proper modal behavior |
| 12 | Font + icon-size standardization | 🔵 | M | cross-platform visual consistency |

Legend: S ≤ ½h · M ≤ half-day · L ≥ half-day.

---

*Report generated by automated code analysis of `public/index.html` (`/content/webtun`), cross-referenced with the ui-ux-pro-max accessibility/loading/contrast guidelines.*

# WebTun — Desktop and Mobile UI Design Audit

**Date:** October 7, 2026

**Status:** **76 of 79 findings implemented** (see §0). 3 remain open and are listed in §0.1.

**Scope:** The application interface: the terminal workspace, launcher, navigation, file sidebar, panels, mobile controls, theming, motion, and accessibility.

**Method:** Static review of `public/css/styles.css`, `public/index.html`, `public/docs.html`, `public/sw.js`, `public/manifest.json`, and the frontend JavaScript that owns layout or visibility. Three independent specialist passes covered desktop/tablet layout, mobile keyboard/responsive behavior, and cross-cutting design system/theming/accessibility; every accepted claim was then re-verified against source. The mobile keyboard visibility failure was reported directly by the user. No rendered screenshots or device testing were used.

**Classification key**

| Term | Meaning |
| --- | --- |
| **Reported** | Observed by the user; mechanism still needs device confirmation. |
| **Confirmed defect** | Provable from source alone (cascade, arithmetic, DOM nesting, dead code). |
| **Risk** | Source predicts failure; depends on browser/OS behavior and needs a rendered or device check. |
| **Design judgment** | Evidence-backed opinion about hierarchy, restraint, or consistency. |
| **Measured** | Contrast or size figures computed from the actual token values, shown in the finding. |

**Priority:** P1 = fix first (primary workspace, layout, control behavior, or accessibility blocking). P2 = material polish or usability problem. P3 = lower-impact consistency issue.

This is a design and interaction audit. It is not a security audit or a WCAG conformance certification, though it cites specific WCAG success criteria where they are directly implicated.

---

## 0. Implementation log

**76 of 79 findings implemented.** Changes span `public/css/styles.css`, `public/index.html`, `public/sw.js`, `public/docs.html`, and `public/js/{terminal,core,settings,ui,tabs,preview,files,misc,security,theme-init}.js`. Verification: `node --check` on all 15 JS files plus `sw.js`, CSS brace balance (1419/1419), a full custom-property declared-vs-used audit (**zero** undefined tokens remaining), div-tag balance in `index.html` (423/423), and a live server start serving every changed asset with HTTP 200.

**No device or browser rendering was available in this environment** (no Chrome, no Puppeteer), so nothing here is confirmed visually. Every entry below is marked accordingly.

### Mobile keyboard — the reported failure

| Finding | Change | File |
| --- | --- | --- |
| **M-00** | The inset is now applied to **one** owner. `#editor-split-area` (position:relative, and the containing block of the mobile `#editor-view` overlay) takes `margin-bottom`; `#terminals` is explicitly cleared. Result is `C − T − M`, not `C − T − 2M`. | `js/terminal.js:2064-2086` |
| **M-15** | The `#editor-view.style.marginBottom` write is deleted. With `position:absolute; inset:0`, the margin was subtracting from the panel's own used height and collapsing CodeMirror with the terminal. | `js/terminal.js:2080-2081` |
| **M-16** | Detection replaced. `keyboardOverlap()` compares `#app`'s rendered bottom against `visualViewport.offsetTop + height` — 0 when the browser already resized, so nothing is re-reserved. `diff`/`absDiff`/`isKeyboard`/`covered` are gone. | `js/terminal.js:2005-2011` |
| **M-17** | `setupVisualViewport()` moved out of `ws.onopen` to boot (`core.js`), and the cleanup now resets `_viewportHandlerInstalled = false`, so a bfcache round-trip re-arms instead of leaving keyboard handling dead. | `js/terminal.js:2109-2141`, `js/core.js:491-495` |
| **M-19** | `setupMobileKeys()` no longer slams the Ctrl row shut; it respects a new `_ctrlRowOpen` flag set by `toggleCtrlRow()`. | `js/terminal.js:2143-2173`, `:1994-2004` |
| **M-20** | `toggleMobileKeyboard()` force-show now checks `innerWidth <= 768 && settings.mobilekeys !== false`, matching the docking and clearance predicates. | `js/terminal.js:2200-2205` |
| **M-23** | Crossing the breakpoint upward now clears the nav, all three rows, `keyboard-docked`, `style.bottom`, and the split-area margin. | `js/terminal.js:2163-2172` |
| **M-24** | `hideMobileKeyboard()` no longer zeroes margins synchronously; it defers to `applyViewportState()` after a 350ms settle, so a still-animating keyboard can't leave the workspace hidden. | `js/terminal.js:2211-2237` |
| **M-25** | `applyViewportState()` early-returns above 768px, and the over-broad `closest('.xterm')` focus test is dropped (xterm's helper is a real TEXTAREA, already covered). | `js/terminal.js:2046-2050` |
| **M-26** | The three un-cancelled refit timers collapse into one `_kbFitTimer` and one `refitActiveSurface()` that also handles tiles and CodeMirror. | `js/terminal.js:2035-2043` |
| **M-28** | `orientationchange` now drives the same handler. | `js/terminal.js:2126` |
| **M-02** | The mobile key-row block no longer sets `display:flex` for all three rows. `#mobile-keys` gets it; the optional Ctrl and Selection rows stay hidden unless JS shows them. | `css/styles.css:2643-2661` |
| **M-13** | `#mkey-ctrl-row.keyboard-docked` gets `position:fixed` instead of being nudged by a relative offset that painted it over the terminal. | `css/styles.css:2658-2662` |
| **M-08 / S-15** | `--mobilekey-h: 44px` moved to `:root` inside the mobile query, so toasts and the reconnect banner stop resolving the stale 46px. The per-toast `marginBottom` double-count is deleted. | `css/styles.css:2440-2443`, `js/ui.js:444` |

**Device verification still required:** the M-00 console dump (`appBottom`, `vv.height`, `termH`), then asserting `termH >= 96` across iOS Safari/PWA and Chrome/Samsung Android, portrait and landscape, keys on/off, Ctrl/Sel toggled, docked file tab, Tiles on, and after bfcache.

### Desktop and tablet

| Finding | Change | File |
| --- | --- | --- |
| **D-07** | `#editor-header` becomes horizontally scrollable so nothing is unreachable, and a `ResizeObserver` adds `.compact` below 420px, which drops `#editor-tab-toggle`, `#html-full-toggle`, and `#md-preview-toggle`. Save is given `order:-1` so overflow consumes the spacer rather than the primary action. | `css/styles.css:1596-1616`, `js/settings.js:650-676`, `js/core.js:527` |
| **D-08** | Fullscreen editor drops from hard-coded `z-index:30` to `--z-editor-fs` (20), below `--z-drawer` (25). The resize handle rises to `--z-editor-fs + 1` so it still works over the fullscreen panel. | `css/styles.css:452-457`, `:590-593` |
| **D-09** | `#more-btn` is now `display:inline-flex` on desktop/tablet (still hidden ≤768px by the existing mobile rule), making Keyboard Shortcuts and Listening Ports reachable again. | `css/styles.css:1105-1109` |
| **D-02** | Seven inline `width/height/min-width/min-height` blocks stripped from the sidebar toolbar (they pinned the width regardless of CSS). Toolbar icons drop 32→28px and the gap 4→3px, so seven icons + separators + gaps now fit the 280px sidebar on one line. | `public/index.html`, `css/styles.css:1298-1302` |
| **D-03** | New `setupSidebarNarrowObserver()` watches `#sidebar` with a `ResizeObserver`, so `.narrow` tracks the real width instead of depending on a stored value that `restoreSidebarWidth()` skips. | `js/settings.js:588-601`, `js/core.js:524` |
| **D-06** | `.tab.has-bell { border-color: var(--amber) }` deleted. The bell is already carried by the `::after` dot; the border was overriding `.tab.active`'s border at equal specificity. | `css/styles.css:1161-1163` |
| **D-17** | `sec-anim` is removed on `animationend` and on close, so the Settings entrance stops replaying and the last card no longer slides 0.53s after the panel settles. | `js/settings.js:224-258` |

### Design system, theming, accessibility

| Finding | Change | File |
| --- | --- | --- |
| **S-05** | `--amber` is no longer a Tokyo-Night literal inherited by nine themes. It is aliased to `--yellow`, so it resolves per theme, with darker overrides in the three light themes: light `#8a5200` (4.95:1 on `--bg3`), Latte `#8a4f00` (4.96:1), Nord Light `#94570a` (4.70:1). Previously 1.63–2.07:1. | `css/styles.css:10-14`, `:88`, `:96`, `:104` |
| **S-06** | Consequence of S-05: the dirty dot (`--yellow`) and the tab dirty glyph (`--amber`) now resolve to the same value, so the two-surface colour drift is gone. The shape difference (element dot vs `::after` bullet) is **not** yet unified. | — |
| **S-07** | `prefers-reduced-motion` now also resets `animation-iteration-count: 1`, so perpetual animations stop rather than restarting every 0.01ms. 20 ambient animation classes are explicitly set to `animation: none`. | `css/styles.css:3187-3200` |
| **S-08** | 19 previously ringless classes gained `:focus-visible` rules — every `.toggle` settings switch, `.tab-close`, `.mnav-btn`, the toast/notif/cmd row actions, and the chips. Plus a low-specificity `:where(button, [role="switch"], …)` baseline so new controls can't regress. | `css/styles.css:1500-1535` |
| **S-09** | `.mm-item:focus-visible` gets a real 2px accent outline instead of a 1.21–1.48:1 background swap. | `css/styles.css:1124-1126` |
| **S-10** | Closed drawers are `inert` + `aria-hidden`, set in markup and by `setPanelInert()` on open/close. Cleared **before** focus is moved into the panel. ~200 off-screen Settings controls are out of the tab order. | `index.html:613,630`, `js/settings.js:199-217` |
| **S-11** | `#pin-screen`/`#offline-screen` moved from hard-coded 200/300 onto `--z-blocking` (600), above overlay/toast/menu. | `css/styles.css:47-58`, `:1645-1647` |
| **S-13** | Declared `--accent-subtle`, `--accent-bg`, `--radius-full`, `--z-modal`; all five `var(--fg1)` references replaced with `var(--fg)` (see X-03). The Tokyo-Night blue fallback baked into 5 Command Library call sites is gone. | `css/styles.css:66-72`, `:10-14` |
| **S-14** | `prefers-reduced-transparency` extended from 1 surface to all 16 blur surfaces, including the two that carried `!important`. | `css/styles.css:1868-1877` |
| **S-16** | `role="status" aria-live="polite"` added to the terminal and preview loading overlays and the reconnect banner. | `js/tabs.js:876-880`, `js/preview.js:81-84`, `index.html:156` |
| **S-17** | `aria-atomic` removed from the toast container (was 10 utterances for a 4-toast burst), and `focusin`/`focusout` now pause the countdown alongside mouse hover. | `index.html:1413-1416`, `js/ui.js:459-484` |
| **S-26** | `html, #tab-scroll { scroll-behavior: auto }` added to the reduced-motion block. | `css/styles.css:3199` |
| **X-01** | `.btn-sm` and `.btn-lg` rules now exist; the 4 call sites that were silently rendering at 34px get their intended sizes. | `css/styles.css:1618-1622` |
| **X-07** | Merged the duplicate `#sidebar-header` pair (the second rule's `flex-wrap` was what caused D-02). Also fixed the settings toggle knob: the track was 40px with an 18px travel, clipping the knob by 4px. | `css/styles.css:1298`, `:1801-1809` |
| **S-04** | Partially addressed — the sidebar-toolbar inline styles are gone (the amplifier named in the finding). The tab-bar inline styles and `!important` consolidation remain open. | — |

### Second pass — sidebar, overlays, key-bar reconciler, themes, docs

| Finding | Change | File |
| --- | --- | --- |
| **D-10** | `applySidebarWidthToViewport()` clamps to 200px in the 769–1023px range (writing both `style.width` and `--sidebar-w`, which the horizontal editor split reads) and hands an inline/dragged width back to CSS above 1024px. Wired to boot and to resize. | `js/settings.js:638-666`, `js/core.js:529-534` |
| **D-11** | `#file-list-wrap` gets `flex:1 1 0; min-height:96px` so it cannot collapse to zero, and `#git-panel.open` is capped at `min(320px, 40vh)` instead of a flat 320px. | `css/styles.css:1351`, `:2042` |
| **D-12** | `#git-header` wraps and `#git-branch-sel` becomes `flex:1 1 60px; min-width:0`, so branch status and change count survive the 200px sidebar. | `css/styles.css:2031-2041`, `:2104` |
| **D-14** | `#new-tab-btn`, `#new-preview-btn`, `#ssh-toggle` moved out of `#tab-scroll` to be siblings of the scroll arrows. `position:sticky` removed. The two `new-tab-btn` anchors in `tabs.js` (tab creation, `moveTabToEnd`) and the pinned-group anchor simplified to plain append. Their 28px dimensions now come from CSS, not repeated inline styles. | `index.html:307-320`, `css/styles.css:1270-1284`, `js/tabs.js:862-866`, `:1462-1465`, `:42-52` |
| **D-15** | Desktop drawers get a real elevation (`box-shadow: -16px 0 48px`) and the `#drawer-backdrop` scrim is activated at **every** width via a new `.desktop-modal` class, not only ≤768px. `applySidebarState()` no longer clears the scrim while a drawer is open. | `css/styles.css:641-652`, `:671`, `:2439-2443`, `js/settings.js:232-236`, `:526-532`, `js/ui.js:735-739` |
| **D-16** | `.term-search-bar` offsets by `--tab-h` so it clears the tab strip; `.term-zoom-hud` moves to `position:fixed; inset:0; margin:auto` so 50%/50% is viewport centre. | `css/styles.css:2450-2454`, `:2497-2505`, `:2526-2528` |
| **M-21** | New `applyMobileKeyBarState()` is the **single writer** for all three key rows, deriving `{visible, docked, bottom}` from `(tab type, settings.mobilekeys, width, termSelectMode, _ctrlRowOpen)`. The seven previous blind `style.display` writers in `terminal.js`, `tabs.js`, `settings.js`, and `ui.js` now delegate to it. | `js/terminal.js:2054-2086` + 5 call sites |
| **M-18** | Detection split into `keyboardInputFocused()` (any field → inset only) and `terminalKeyboardFocused()` (xterm helper textarea → additionally dock the bar and hide the nav). The docked bar's `z-index` dropped from 449 to below `--z-overlay`, so an open drawer now covers it instead of the reverse. | `js/terminal.js:2002-2027`, `:2096-2135`, `css/styles.css:2438-2450`, `:2786-2790` |
| **M-27** | `.keyboard-docked` gains `padding-bottom: env(safe-area-inset-bottom, 0px)`. Harmless where the inset is 0. | `css/styles.css:2449-2451` |
| **S-06** | `--dirty` and `--ext-changed` semantic tokens declared; the panel dot, file-tab dot, tab-strip glyph, and the ext-change ring all read from them. The colour drift between surfaces is gone. | `css/styles.css:18-22`, `:359`, `:505-509`, `:1700-1704` |
| **S-19** | `--fg3` lifted in the four failing themes: OLED `#8a8a94` (5.38:1 on `--bg3`), Latte `#5a5e70` (4.85:1), Gruvbox `#a89a85` (4.77:1), Nord Light `#47556b` (6.13:1). | `css/styles.css:79`, `:104`, `:113`, `:130` |
| **S-12** | OLED is reachable: added to the settings whitelist and the theme picker. `theme-init.js` reads `--bg2` from computed style instead of a duplicated map that had two dead keys and omitted three real themes. | `js/settings.js:10`, `index.html:705`, `js/theme-init.js:26-40` |
| **S-20** | The service-worker offline fallback is now a themed, self-contained document with `color-scheme: light dark`, the app's palette, the logo mark, and a working **Retry** button. | `sw.js:127-186` |
| **S-24** | `docs.html --code-dim` raised `#565f89` → `#767fae` (**2.91:1 → 4.64:1** on `--code-bg`). The comment claiming the app's `--fg2`/`--fg3` were weak (4.18/2.76) is corrected — they measure 6.67/5.57. | `docs.html:88`, `:84-88`, `:281-283` |
| **S-25** | "Six palettes plus System — every theme is contrast-checked" → "Nine palettes plus System — each tuned for legibility". The claim could not be stood behind. | `docs.html:786` |
| **X-04** | Breadcrumb ancestors no longer render with an inline accent colour from `files.js`, which overrode the stylesheet and made every parent identical to `.path-current`. Presentation now lives in CSS, and the `!important` qualifiers it needed are gone. | `js/files.js:826-840`, `css/styles.css:1351-1353` |
| **X-05** | `#path-segments` gets a symmetric fade mask, matching `#tab-scroll`. JS still scrolls it to the far right, so deep paths now at least signal that ancestors exist above. | `css/styles.css:1359` |
| **S-21** | Both attribute-substring selectors removed. The `preview-frame` device-width style is now class-driven (`.device-width`), and the `#select-actions` rule was redundant against its inline `display:none`. | `js/preview.js:130-142`, `css/styles.css:357` |
| **S-27** | `@media (forced-colors: active)` block added: active/selected states re-expressed with `outline`, progress bars and status dots given `forced-color-adjust: none`, focus rings forced to `Highlight`, and low-contrast-by-design borders given real edges. | `css/styles.css:3658-3703` |
| **S-01** | Type scale tokens declared (`--fs-micro` … `--fs-display-xl`). **Every** literal `font-size` in the stylesheet is now a token — 23 distinct values reduced to 10 steps, and all 16 declarations at or below 9px raised to 10px. | `css/styles.css:80-89` + 232 declarations rewritten |
| **S-13** | `--border-focus` was undeclared with a `--border` fallback, making two Command Library hovers no-ops; both now point at `--accent`. Combined with the `--fg1` and `--z-modal` work in the first pass, **no consumed token is undefined**. | `css/styles.css:2283`, `:2343` |

### Third pass — touch targets, motion budget, badges, fixed surfaces, dead code

| Finding | Change | File |
| --- | --- | --- |
| **M-03 + X-02** | The width-agnostic `@media (pointer:coarse)` block was reworked. It used to set `.tab-close` to 44px inside a 38px tab inside a 38px bar (clipped), while its `.icon-btn` bump was overridden by every component rule. Now it raises `--tab-h` to 44px so a full-height control fits, and new `.hit`/`.hit-sm` helpers expand **hit areas without changing visual size**. Applied to the mobile tab close (18px visual, 44px hit), the eleven inline row actions (`.notif-btn`, `.cmd-action-btn`, `.tab-list-close`, `.toast-btn`, `.file-quick`, `.bm-remove`, `.tth-close`, `.git-file button`, the two clear buttons, `#git-branch-add`), and the 12px sidebar resize handle — the only way to resize on touch. | `css/styles.css:52-57`, `:242-279`, `:255-267`, `:2756-2780`, `:3228`, `:1518-1527` |
| **M-09** | Landscape now lowers `min-height` alongside `height` (the 44px floor silently cancelled the 32px rule), the no-op `#settings-panel { top:0 }` is gone, and the bottom nav grows to 48px so its 48px-minimum buttons stop overflowing. | `css/styles.css:3313-3326` |
| **M-22** | `applyViewportState()` publishes the measured overlap as `--kb-inset` on the root. Toasts, the reconnect banner, the More/Tabs sheets, all three context-menu sheets, and the sessions list now express their `bottom`/`max-height` in terms of it — previously every one of them rendered *behind* the keyboard. | `js/terminal.js:2117-2123`, `:2131`, `css/styles.css:55`, `:1975-1982`, `:3059`, `:3141`, `:3251`, `:3263`, `:3614`, `js/misc.js:1456-1459` |
| **S-03** | Ambient glow removed from routine states: the launchpad pulse dot (steady "connected" no longer blinks), the logo drop-shadow, keep-awake (a user preference, not an alert — its dead `awakeGlow` keyframe is deleted), the active tab's outer glow (the inset accent stripe is now the single marker), latched modifier keys, and all six tab colour tags. | `css/styles.css:451`, `:926-928`, `:1073`, `:1255`, `:1265-1270`, `:1592-1598` |
| **D-13** | `#hostname-badge` gets `min-width: 64px`; because `overflow:hidden` resolves `min-width:auto` to 0, it previously absorbed *all* header shrinkage and vanished near 1024px with no ellipsis. `.header-palette-btn` gets a fixed `height:24px` + `white-space:nowrap` + `overflow:hidden` so its space-containing label can no longer break onto a second line and overhang the header. | `css/styles.css:1161-1183`, `:930-949` |
| **S-22** | The `stroke-width: 1.9` override on mobile-nav icons is removed so they inherit `2` like every other control — the bottom bar was reading as a different icon family from the header. | `css/styles.css:2849-2854` |
| **S-23** | Four badge implementations collapsed into one `.count-badge` component (`--badge-bg`/`--badge-fg` overrides, `:empty` hides itself, tabular numerals). The security badge had **no CSS rule at all** — only an inline style — which made its position shift as the digit count changed. The dead `#tab-list-count` selector and the `.tab-nav-btn` positioning that existed only to host it are gone. | `css/styles.css:719-745`, `index.html:106,125,144,873`, `js/tabs.js:298-310`, `js/security.js:310-313` |
| **X-06** | `backdrop-filter` removed from `.toast` (it sat on a **fully opaque** background, so the blur contributed nothing) and from both drawer headers, which now use opaque `var(--bg2)` instead of 88% mixes — they sit on an opaque drawer where nothing shows through. | `css/styles.css:844-849`, `:926-931` |
| **X-07** | Duplicate declarations merged: two `#conn-status` rules (the second was silently replacing `transition`) and two `.ssh-toggle.ssh-off` rules. The landscape `#settings-panel { top:0 }` no-op is deleted. | `css/styles.css:1146-1156`, `:998`, `:3313-3326` |

### Fourth pass — D-01 / M-01 design decisions, M-04, S-16, S-17

**Decision rule applied to both D-01 and M-01:** a control earns a permanent slot in the header or bottom nav only if it has **no keyboard shortcut and no More-menu entry**. Everything else lives behind More. Nothing was deleted — every removed button is still reachable, and its state is now reflected on its menu item.

**Desktop header — D-01.** Removed `#cmd-lib-toggle` (Command Library) and `#tilesBtn` (Tiles Mode): both already had More-menu entries. Kept the live System Stats gauge, because it is the only always-visible CPU/memory readout, and kept Explorer/More/Notifications/Settings, which have no shortcut and no menu entry. `toggleTiles()` and the Command Library open/close now write their state to `[data-more-item]` nodes, and `.mm-item.active` / `[aria-pressed=true]` / `[aria-expanded=true]` render an accent tint plus a trailing check so the menu reports state rather than acting as a bare command list.

**Mobile header — M-05/M-06.** Removed `#mobile-cmd-btn` (Snippets) and `#mobile-sessions-btn` (Sessions) — both duplicate More-menu entries and were eating the width that host identity needs. `#mobile-search-btn` (Find in terminal) stays: it has neither a shortcut nor a menu entry.

**M-01 — chrome height.** Since the mobile header now carries fewer controls, it drops 44px → **40px**; the bottom nav drops 54px → **50px**. Combined with the existing 36px tab bar that is **126px of chrome instead of 134px**, and every 4px goes back to the terminal. The floating `+` FAB also stops overlapping the terminal by 10px (`top: -10px` → `0`) and loses its gradient and coloured glow in favour of a flat accent fill — it was the most prominent object on a terminal screen (M-07).

| Finding | Change | File |
| --- | --- | --- |
| **D-01** | Header reduced from 8 persistent icon buttons to 5. Command Library and Tiles Mode removed; More-menu items now carry their state via `data-more-item` + `.mm-item.active`. | `index.html:88-141`, `js/misc.js:283-287`, `:307-315`, `js/tabs.js:1374-1381`, `css/styles.css:1228-1241` |
| **M-01, M-05, M-06** | Mobile header 44→40px, nav 54→50px (134px → 126px total chrome). Two duplicate header buttons removed. FAB flattened and de-raised. | `css/styles.css:2676-2681`, `:2733-2742`, `:2807`, `:2855-2884` |
| **M-04** | Verified resolved: `--z-modal` is declared and consumed by `.term-zoom-hud` and the mobile Command Library, both of which now resolve to 550 instead of falling back to `auto` (tree order). | `css/styles.css:70`, `:2652`, `:3108` |
| **S-16** | `.term-loading` / `.preview-loading` are `pointer-events: none` because they overlay a terminal that must stay interactive during connect. They announce via `role="status"` instead. Residual closed. | `css/styles.css:358-366`, `js/tabs.js:876-881`, `js/preview.js:81-85` |
| **S-17** | `.toast-progress` under reduced motion now runs to `scaleX(0)` rather than snapping to zero in 0.01ms, so hover/focus pause still has a visible duration to hold. Residual closed. | `css/styles.css:3357-3370` |

### Fifth pass — icon scale, sheet consolidation

| Finding | Change | File |
| --- | --- | --- |
| **S-22** | Icon scale tokens declared (`--icon-xs` 11px … `--icon-lg` 16px). The 164 inline SVGs went from **13 distinct widths to 6** (10/11/12/14/16 plus a handful of intentional display sizes at 18–32px). Within one 28px tab-bar button row the glyphs had been 14, 14 and 13px; the sidebar toolbar mixed 12, 12, 13, 13, 13, 13, 13 — both rows are now uniform. The logo mark and keep-awake cup are sized from the token in CSS instead of inline attributes. | `css/styles.css:93-96`, `:932-936`, `:1086`, `index.html` (91, 108-113, 153-176, 305-312, 349-350, 398-401, 528-534, 566-568, 630) |
| **S-04** | The three bottom-sheet blocks each repeated the same 16-line `!important` list, so their geometry could drift apart. Consolidated into one shared rule; the per-sheet blocks now carry only their differences. The `!important` is documented as load-bearing — JS writes inline `top`/`left` when positioning these menus, and only `!important` beats an inline style. | `css/styles.css:3084-3107`, `:3159-3174`, `:3273-3281` |

### 0.1 Remaining open findings (3)

| ID | Pri | Why it is still open |
| --- | --- | --- |
| D-04, D-05 | P2 | Sidebar workflow consolidation (Git/bookmarks/file-list priority) and launchpad simplification. Pure product direction — the treatments describe options, not a decision, and both change what is visible every session. |
| S-27 | P2 | A `forced-colors` block now exists, but High Contrast rendering needs a real Windows test to confirm the state re-expression actually reads. |

**S-02** is closed: the control vocabulary is now token-driven (`--btn-sm/md/lg`, `--hit`, `--hit-sm`, the icon and type scales), and the remaining height differences are contextual rather than accidental — 26px inline buttons in a 28px toolbar row, 34px default buttons in panels, 44px touch targets.

### Verification performed

- `node --check` passes on all 15 files in `public/js/` plus `sw.js`.
- `styles.css` brace balance: 1419/1419. **No literal `font-size` remains** — all are scale tokens.
- Custom-property audit: every consumed token is declared. `--border-focus` (undeclared, no-op hover) removed.
- `index.html` div balance: 423/423. Every id and class targeted by the new selectors exists.
- `PORT=3111 node server.js` starts clean and serves `/`, `styles.css`, all 9 changed JS files, `sw.js`, and `docs.html` with HTTP 200; stopped afterwards.
- **Not verified:** any visual or runtime rendering. No device, no headless browser in this environment.

---

## Executive summary

WebTun has a real design foundation: a token-based palette, a deliberate two-font split (IBM Plex Sans for chrome, JetBrains Mono for code), visible focus rings on many controls, reduced-motion and reduced-transparency blocks, and a wide feature set that mostly works (`public/css/styles.css:4-60`, `:210-218`, `:1467-1484`, `:3091-3095`).

The professional-feel problem is **hierarchy and restraint**, not missing features. But the second-pass review also surfaced a set of **confirmed defects** that damage trust in the product more than any visual choice: a mobile keyboard handler that can hide the terminal you are typing into, a fullscreen editor that paints over the Settings drawer while focus-locking you inside it, a primary Save button that clips out of its toolbar, two documented features that cannot be opened on desktop, and a token system with undefined and unused variables.

- **Mobile (P1):** The keyboard inset is written to three elements at once, the "is the keyboard covering us" metric measures `innerHeight` instead of the app's own box, and the handler is armed only from `ws.onopen` with no `pageshow` recovery. See M-00, M-15, M-16, M-17.
- **Desktop (P1):** The editor toolbar overflows its default panel width and clips Save; the More overflow menu is permanently hidden while being the only entry point to two features; tab bell and active borders conflict deterministically. See D-07, D-09, D-06.
- **Shared (P1):** `--amber` is a Tokyo-Night-only token inherited by every other theme and it fails contrast in all three light themes; reduced-motion makes perpetual animations faster rather than stopping them; 13 interactive classes including every settings switch have no focus ring; the closed Settings and Notification drawers stay in the tab order. See S-05, S-07, S-08, S-10.

**Theme inventory correction:** there are **10 palette blocks** covering **13 theme names**, of which **8 are selectable** (`public/css/styles.css:4`, `:62-133`; `public/index.html:694-702`; `public/js/settings.js:10`). OLED is defined but unreachable — see S-12.

### Highest-impact work

| Order | Finding IDs | Outcome |
| --- | --- | --- |
| 1 | M-00, M-15, M-16, M-17 ✅ | Mobile typing stays visible; one layout owner for the keyboard inset; recovery after bfcache. |
| 2 | D-07, D-09, D-08 ✅ | Save always reachable; two documented features openable; no focus trap behind a fullscreen editor. |
| 3 | D-02, D-03, D-06, S-11 ✅ | Sidebar toolbar fits; tablet sidebar deterministic; one active-tab treatment; blocking screens above all layers. |
| 4 | S-05, S-07, S-08, S-10 ✅ | Theme-complete color tokens; real reduced motion; focus rings on all controls; closed drawers out of the tab order. |
| 5 | M-01, M-21, M-05, M-06 | Recover phone terminal height; finish the key-bar reconciler; thin the mobile header. |
| 6 | D-01, D-13, S-01, S-02, S-03 | Restraint and consistency: fewer competing controls, one type scale, one size vocabulary. |
| 7 | D-10, D-11, D-12, D-14, D-16, X-02 | Sidebar integrity, tab-strip affordance, overlay anchoring, touch targets. |
| 8 | Remaining P2/P3 | Theme contrast sweep, motion budget, docs accuracy, cleanup. |

✅ = implemented (see §0).

---

## 1. Mobile findings

### M-00 · P1 · Reported — Opening the software keyboard hides the working terminal

**Observed:** On mobile, focusing the terminal and opening the software keyboard shifts the terminal-tab workspace so far that terminal output and the cursor are no longer visible. Text still reaches the shell, even though usable screen space remains. The user also observes that the app window **already resizes when the keyboard opens**, so reserving the keyboard's height again inside the terminal is unnecessary on that device.

**Mechanism in code (confirmed).** The viewport handler computes `keyboardMargin` from `window.innerHeight`, `visualViewport.height`, and `offsetTop`, then writes the same `(keyboardMargin + keysOffset)` bottom margin to **three** elements: `#terminals`, `#editor-view`, and their common parent `#editor-split-area` (`public/js/terminal.js:2039-2041`; flex structure `public/css/styles.css:272-283`, `:437-449`, `:515`). Because the bottom nav is hidden (`public/js/terminal.js:2054`) and the key bar is pulled out of flow as `position:fixed` (`public/css/styles.css:2319-2324`), every pixel the browser gave back is re-consumed by margin — the compensation is 100% margin and 0% benefit.

The resulting geometry, with `C` = content height, `T` = tab bar, and `M` = the applied margin applied twice:

```
splitArea  = C − T − M
#terminals = splitArea − M = C − T − 2M
```

On a 390×844 phone with a ~336px keyboard and a 44px key bar (`M` = 380), the terminal resolves to roughly **4px**. `#terminals` and `.term-wrapper` are `overflow:hidden` (`public/css/styles.css:281-282`, `:444-449`), so that 4px clips to nothing. `fitTerm()` clamps to at least one row (`public/js/terminal.js:1246-1248`), which is why keystrokes still reach the shell while no pane is visible. The "free" space the user perceives is not space the terminal lost — it is the **margin band** between `splitArea` and the docked key bar. In Tile view the same double inset does not collapse but overflows, because `#terminals.tiles-mode` is `overflow:auto` with `min-height:150px` wrappers (`public/css/styles.css:401-402`), giving a second reading of "shifts out of view".

**Two browser classes (the reason the fix must be measured, not assumed).**

| class | `innerHeight` | `vv.height` | `covered` | `#app` bottom (`100dvh`) | terminal |
| --- | --- | --- | --- | --- | --- |
| (a) overlay — Chrome/Firefox Android default, iOS Safari | 844 | 508 | 336 | 844 | ~4px → M-00 |
| (b) content resize — OEM WebView / Samsung / ICB-shrinking browsers | 508 | 508 | 0 | 508 *or* 844 | correct, or the stale-`dvh` variant |

Class (b) is the case the user described. Note that `covered` is derived from `innerHeight`, but `#app`'s height comes from CSS only — `position:absolute; inset:0; height:100dvh; height:-webkit-fill-available` (`public/css/styles.css:236-242`), and `100dvh` is not required to track the keyboard. In class (b) with a stale `dvh`, `covered` is 0, the code reserves nothing, and the bottom of the app is still behind the keyboard. This is the case where the metric is structurally blind — see M-16.

**Decisive device measurement (take this before shipping any fix).** With the terminal focused and the keyboard open:

```js
const vv = visualViewport, app = document.getElementById('app').getBoundingClientRect();
({ innerHeight, clientH: document.documentElement.clientHeight,
   vvH: vv?.height, offsetTop: vv?.offsetTop,
   appBottom: app.bottom, appH: app.height,
   termH: document.getElementById('terminals').getBoundingClientRect().height })
```

`appBottom ≈ 844` with `vvH ≈ 508` → class (a), cause is the double margin. `appBottom ≈ 508` → the app really resized; re-diagnose on device before shipping inset logic. `termH < 120` confirms the collapse numerically.

**Treatment.** One layout owner receives the inset; never a parent and a child. Measure the app's own rendered bottom against the visible bottom (M-16's rule), reserve only the uncovered overlap, subtract a usable-height floor instead of the 60% clamp, and let `#editor-split-area` carry the single inset because it is the positioned ancestor of the mobile `#editor-view.open` overlay. See §4 for the concrete fix design.

### M-15 · P1 · Confirmed defect — The inset is written to three elements, collapsing the editor too

**Evidence:** `public/js/terminal.js:2040` sets `#editor-view.style.marginBottom`. On mobile that element is `position:absolute; inset:0` (`public/css/styles.css:563-569`) inside `position:relative` `#editor-split-area` (`:515`), so the margin subtracts from its used height and the CodeMirror panel collapses to the same ~0–4px as the terminal. The same write applies when the panel is docked into a file tab (`#editor-view.docked`, `public/css/styles.css:464`), whose containing block is `.file-tab-body` (`:466`): the panel is then lifted by `M` out of an already-collapsed wrapper and can overdraw the tab strip.

**Effect:** With a file or editor tab open and the keyboard up, the editor is invisible (panel case) or floats over the tab bar (docked case). **This is not fixed by removing only the `#terminals` write.**

**Remedy:** Delete the `#editor-view` margin and let the split area carry the single inset.

### M-16 · P1 · Confirmed defect — The "is the keyboard covering us?" metric measures the wrong box

**Evidence:** `public/js/terminal.js:2024` computes `covered = Math.max(0, window.innerHeight − vv.height − vv.offsetTop)`, consumed at `:2027` and `:2030`. It assumes `#app`'s bottom edge equals `innerHeight`, but `#app`'s height comes only from CSS (`public/css/styles.css:236-242`).

**Effect:** On any browser that shrinks the layout viewport while leaving `#app`'s box tall, the code reserves 0px while the app's bottom is behind the keyboard — the exact reported failure, while the code looks correct. Symmetrically, a panned visual viewport can make `covered` clamp to 0 and skip compensation entirely.

**Remedy:** Measure the app's own box against the visible bottom. Both rects are in layout-viewport coordinates, so they are directly comparable, and the result is 0 by construction when the browser genuinely resized:

```js
const app = document.getElementById('app');
const appBottom = app.getBoundingClientRect().bottom;
const visBottom = vv ? vv.offsetTop + vv.height : document.documentElement.clientHeight;
const overlap = Math.max(0, Math.round(appBottom - visBottom)); // 0 iff the app already resized
```

Use `overlap` wherever `covered` was used. This satisfies "do nothing on browsers that already resize" with no UA sniffing and no `interactive-widget` meta change.

### M-17 · P2 · Confirmed defect — The keyboard handler is armed from `ws.onopen`, disarmed by `pagehide`, never re-armed

**Evidence:** `setupVisualViewport()` is called only from inside `ws.onopen` (`public/js/terminal.js:221`). The guard `_viewportHandlerInstalled` (`:1994-1995`) is a one-way latch. The listeners are removed by the `_cleanups` entry at `:2101-2104`, which `public/js/core.js:612-615` runs on every `pagehide` — including `persisted === true` (bfcache). There is no `pageshow` handler anywhere in `public/` (verified by search). The `if (window.visualViewport)` check at `:1996` has no `else`, so a browser without the API gets neither compensation nor a `resize` fallback.

**Effect:** Before the first WebSocket opens — or for the whole session if it never opens — focusing an input causes zero layout compensation. After a bfcache round-trip (open a bookmarked page in a new tab and press Back; Android task switch) the handler is permanently dead on that page instance, and no reconnect re-arms it. This also makes M-02 indefinite rather than transient: a slow or failed socket leaves the selection row visible for the whole session.

**Remedy:** Move the `setupVisualViewport()` call into the boot path next to `setupMobileKeys()` (`public/js/core.js:491`), reset `_viewportHandlerInstalled = false` inside the cleanup, and add a `window.resize` fallback for browsers without `visualViewport`.

### M-18 · P2 · Confirmed defect — Any focused input triggers terminal compensation, and the docked key bar floats above modals

**Evidence:** `public/js/terminal.js:2008-2014` treats `INPUT | TEXTAREA | contentEditable | .xterm-helper-textarea | anything inside .xterm` as the terminal keyboard, and `:2037-2054` then applies the terminal inset, force-shows the key bar, docks it, and hides the nav. Auto-focusing inputs exist in several non-terminal surfaces: `#cmd-lib-search` (`public/js/misc.js:295`), `#finder-input` (`:143`), `#term-search-input` (`public/js/terminal.js:2214`), the sessions-modal search (`:948`), and a throwaway clipboard textarea (`public/js/misc.js:370-378`). The docked bar's `z-index: calc(var(--z-toast) − 1) !important` resolves to **449** (`public/css/styles.css:2321`, token at `:50`) while `.overlay` is **400** (`:49`, `:1505`).

**Effect:** Opening the Command Library or the in-terminal search pops the mobile key bar **on top of** that drawer, hides the bottom nav, and shrinks a terminal the user is not looking at. Toasts and the bar also sit above modal backdrops.

**Remedy:** Split into `keyboardInset` (any focused text field → apply inset only) and `terminalKeyboard` (xterm helper textarea focused → additionally dock the key bar and hide the nav), and place the docked bar below `--z-overlay`.

### M-19 · P2 · Confirmed defect — Every keyboard step re-runs `setupMobileKeys()`, which slams the Ctrl row shut

**Evidence:** `public/js/core.js:509-511` binds `window.resize → setTimeout(setupMobileKeys, 150)`. `public/js/terminal.js:2123-2124` unconditionally sets `ctrlRow.style.display = 'none'` and `:2126` clears the CTRL button background. On browsers that shrink the layout viewport when the keyboard opens, **every keyboard animation step fires `resize`**.

**Effect:** Tapping `^Row` and then typing closes the Ctrl row ~150ms later. The user cannot use the row they just opened, and it presents as flakiness rather than a bug.

**Remedy:** Make `setupMobileKeys()` idempotent and state-preserving: only hide the optional rows when they are not user-open, gated on a `ctrlRowOpen` flag set by `toggleCtrlRow()` (`:1981-1989`).

### M-20 · P2 · Confirmed defect — The key bar appears even when the setting disables it, undocked and unreserved

**Evidence:** `public/js/terminal.js:2146-2147` (`toggleMobileKeyboard`) does `if (mk) mk.style.display = 'flex'` with no check of `settings.mobilekeys` or viewport width, whereas docking (`:2043`) and clearance (`:2038`) are both gated on `window.innerWidth <= 768 && settings.mobilekeys !== false`. The default is `mobilekeys:false` (`public/js/core.js:24`).

**Effect:** With mobile keys turned off in Settings, the "Input" nav button makes the bar appear **in flow** at the bottom of `#content` — under an overlay keyboard, permanently unreachable — while `keysOffset` stays 0, so it steals 44px the terminal needed.

**Remedy:** Gate that force-show on the same predicate as `:2038`/`:2043`.

### M-21 · P2 · Confirmed defect — Three inline `style.display` writers own the key rows; none reconciles dock state

**Evidence:** Blind assignments at `public/js/terminal.js:2062-2064`, `:2120`, `:2147`, `:2157-2189`; `public/js/tabs.js:1259`; `public/js/settings.js:101`; `public/js/ui.js:58`. CSS alone forces all three rows visible at ≤768px (`public/css/styles.css:2627-2632`), so the inline value is the only control. `toggleTermSelect()` (`public/js/terminal.js:1654-1662`) hides the bar via `mk.dataset.prevDisplay` while leaving `keyboard-docked` and the applied inset untouched.

**Effect:** After entering selection mode with the keyboard open, the terminal keeps reserving 44px for a `display:none` bar; after switching tabs the bar can be re-shown **without** `keyboard-docked`, as an in-flow row under the keyboard; `#mkey-sel-row` is never docked at all — it is the last in-flow child of `#content`, so with the keyboard open it is unreachable and never counted in `keysOffset`.

**Remedy:** One function, `applyMobileKeyBarState()`, deriving `{visible, docked, bottom}` from `(activeTab.type, settings.mobilekeys, width, keyboardOpen, termSelectMode)`, called from all seven sites. This is also the structural prerequisite for fixing M-02.

### M-22 · P2 · Confirmed defect — No keyboard inset reaches any `position:fixed` chrome, and the JS menu clamps are inert on phones

**Evidence:** Fixed surfaces with no keyboard term: toasts (`public/css/styles.css:1760-1767`), More sheet (`:2805`), Tabs sheet (`:3005`), all three context menus forced to `position:fixed; bottom:0 !important` (`:2871-2891`), the sessions list cap `calc(100dvh - 215px)` (`:3354`), and the full-screen command drawer (`:2826-2836`). JS clamps use `window.innerHeight`: `public/js/terminal.js:852-871`, `public/js/core.js:46-62`, `public/js/tabs.js:420-429`, `public/js/files.js:1073-1077`. Only `#term-selection-bar` uses the visual viewport (`public/js/terminal.js:1807-1819`) — the one place that does it right. Because the mobile rules force `top:auto !important; left:0 !important`, the inline `top/left` those clamps compute are discarded on phones.

**Effect:** A long-press terminal menu, the More/Tabs sheets, and any toast opened while the keyboard is up render **behind** the keyboard. The mobile clamp code is dead work.

**Remedy:** Publish the measured inset as a root custom property (`--kb-inset`) and express every fixed surface's bottom/max-height in terms of it. Device check required: confirm a long-press actually opens the terminal menu on the target browser before treating sheet placement as user-visible.

### M-23 · P2 · Confirmed defect — Mobile chrome written as inline styles is never reconciled when the viewport crosses 768px

**Evidence:** `public/js/terminal.js:2054` hides the nav and `:2072`/`:2188` show it, while the base rule is `#mobile-nav-bar { display:none }` (`public/css/styles.css:2310`) and its `position:relative; height:54px` exist **only** inside `@media (max-width:768px)` (`:2537-2553`). Nothing clears these inline values when `innerWidth` grows past 768; the only resize hook, `setupMobileKeys` (`public/js/core.js:509`), writes `mk.style.display` but never touches `mnav` or `keyboard-docked`.

**Effect:** Rotating an iPad past 768px leaves the nav rendered **inside the desktop layout** — an inline `display:flex` beats the base `display:none`, and outside the media query the row has no height, background, or position, so it renders as an unstyled row of Files/Tabs/Input/More buttons consuming height from `#main`. In the opposite rotation the key bar can be left `position:fixed` with a stale `bottom` over the desktop layout. The same happens when a desktop window is dragged across 768px.

**Remedy:** Add width reconciliation to `setupMobileKeys()`: when `innerWidth > 768`, clear `mnav.style.display`, the three rows' display, `keyboard-docked`, `style.bottom`, and the split-area margin.

### M-24 · P2 · Confirmed defect — `hideMobileKeyboard()` clears the inset unconditionally, racing the closing animation

**Evidence:** `public/js/terminal.js:2171-2176` zeroes all three margins and `:2187-2188` re-shows the nav **synchronously**, while the handler that owns real state is debounced 100ms (`:2097`) and may still be in flight.

**Effect:** If the keyboard has not finished closing — or any input is refocused inside the 100ms window, plausible from a `.mkey` tap since `sendKey()` re-focuses the terminal (`:1343`) — the layout resets while the keyboard still covers the bottom, and the terminal is hidden with no compensation until the next viewport event, which on some engines never arrives.

**Remedy:** Set a `keyboardDismissRequested` flag and let the viewport handler perform the reset, or re-evaluate the inset ~350ms after the blur instead of clearing blind.

### M-25 · P3 · Confirmed defect — No width guard, and the focus test is too broad, so desktop can be shrunk too

**Evidence:** The inset writes at `public/js/terminal.js:2037-2041` have **no** `innerWidth <= 768` guard — only the key-bar and nav parts do (`:2043`, `:2053`). `isInputFocused` (`:2008-2014`) is satisfied by `active.closest('.xterm')`, i.e. by simply clicking the terminal.

**Effect:** On a desktop browser with an OS-level on-screen keyboard, Chrome tablet mode, or a partially occluded window, focusing any field — including a plain click in the terminal — applies the same double margin to the desktop workspace.

**Remedy:** Early `if (window.innerWidth > 768) return;` before any layout write, and drop the `closest('.xterm')` clause.

### M-26 · P3 · Confirmed defect — Un-cancelled refit timers with stale captures; only the active tab is refit

**Evidence:** `public/js/terminal.js:2078-2096` schedules up to three `setTimeout(…, 160)` per event without clearing previous timers (only `_viewportDebounce` at `:1998` is cleared), and captures `activeTab` at schedule time. It refits only the active tab, whereas every other refit site iterates (`public/js/editor-panel.js:395`, `public/js/settings.js:759`, `public/js/tabs.js:1386`).

**Effect:** A rapid open/close burst can refit against a stale tab or layout; in Tile view background tiles keep stale geometry.

**Remedy:** One `clearTimeout(_fitTimer)` and one scheduled `refitAll()` that mirrors `public/js/terminal.js:790-792` (all tabs when `tilesMode`, else active) and refreshes CodeMirror once.

### M-27 · P2 · Risk — The inset and the docked bar ignore `env(safe-area-inset-bottom)`

**Evidence:** `public/js/terminal.js:2024-2030` computes the inset from viewport geometry only, and `:2046` sets `mobileKeys.style.bottom = keyboardMargin + 'px'` with no inset term. `#mobile-keys.keyboard-docked` (`public/css/styles.css:2319-2324`) adds no `padding-bottom`, unlike `#mobile-nav-bar` (`:2541-2542`) and `#toast-container` (`:1761`). `#app` spans the full `100dvh` including the unsafe strip (`public/css/styles.css:236-242`), and the meta opts into `viewport-fit=cover` (`public/index.html:5`).

**Effect:** On devices reporting a non-zero bottom inset while the keyboard is up — iPhone landscape (21px), iPad (20–24px), Android gesture navigation (24px) when the keyboard does not cover the full bottom — the docked key bar and the reserved band sit inside the system gesture area, so ESC/TAB/arrows mis-fire or get stolen by the back/home swipe.

**Remedy:** Add `env(safe-area-inset-bottom, 0px)` to the docked bar's `bottom` and as `padding-bottom` on `.keyboard-docked`, but only after a device check confirms a non-zero inset while the keyboard is open.

### M-28 · P3 · Risk — No `orientationchange` handling

**Evidence:** A search across `public/` finds no `orientationchange` or `screen.orientation` usage. Rotation is observed only by `window.resize → setupMobileKeys()` (`public/js/core.js:509-511`) and the wrapper `ResizeObserver` (`public/js/terminal.js:787-796`). The key bar's own height changes across orientations (44px → 36px + inset, `public/css/styles.css:3071`), so `keysOffset` and the stored `bottom` are only correct after the next viewport event. No refit happens for CodeMirror or file tabs on rotation (`public/js/terminal.js:2081-2096` covers the active tab only).

**Effect:** Rotation with the keyboard open can leave a stale key-bar offset, a stale split-area margin, or a terminal fitted to pre-rotation geometry.

**Remedy:** Add an `orientationchange` listener that clears the debounce and timers, recomputes the inset, and refits all terminals plus `editorCM` in a `requestAnimationFrame` after a ~250ms settle.

### M-01 · P1 · Design — Persistent chrome takes substantial terminal height

**Evidence:** The mobile header is 44px, tab bar 36px, bottom nav 54px: **134px before safe-area insets**. With the key bar enabled, **~178px** (`public/css/styles.css:2425-2429`, `:2478-2486`, `:2536-2550`, `:2626-2643`; `public/js/terminal.js:2108-2125`). The nav is hidden by JS while the keyboard is detected (`public/js/terminal.js:2037-2055`), so these totals describe the non-keyboard layout.

**Effect:** The terminal becomes a relatively small pane on shorter phones. **Treatment:** Prioritize terminal height when idle, show terminal keys in the typing context, and avoid multiple simultaneous rows serving the same navigation. Keep the existing desktop-aligned mobile tab chrome.

### M-02 · P1 · Confirmed defect — The selection shortcut row defaults to visible in mobile CSS

**Evidence:** The base `#mkey-sel-row` rule is `display:none`, but the later mobile rule groups it with `#mobile-keys` and sets `display:flex` (`public/css/styles.css:1444-1446`, `:2626-2633`). The row has no inline hidden style (`public/index.html:598-609`). `setupMobileKeys()` hides only the Ctrl row (`public/js/terminal.js:2123-2124`); the selection row is cleared only on a visual-viewport event landing in the else-branch (`:2073-2075`) or on switching to a non-terminal tab (`public/js/tabs.js:1260`). Because of M-17, a slow or failed socket leaves it visible for the whole session.

**Effect:** An unused 44px selection bar can occupy the terminal indefinitely. **Remedy:** Keep both optional rows hidden by default in the mobile CSS, and drive them from the single reconciler proposed in M-21.

### M-03 · P1 · Confirmed defect — Mobile tab-close target is 18px, and the conflicting rule is not width-gated

**Evidence:** `@media (pointer: coarse)` (no width condition) sets `.tab { height:38px }` and `.tab .tab-close { width:44px; height:44px }` (`public/css/styles.css:201-207`). The mobile rule later sets `.tab .tab-close` to 18px (`:2513-2525`), and a later lower-specificity `.tab-close` rule sets 32px (`:2974-2978`). The more specific mobile selector wins; among equal specificity it also beats the earlier coarse-pointer rule.

**Effect:** On phones the close control is hard to hit. Because the coarse-pointer rule is not width-gated, the same conflict also produces a **44px close button inside a 38px tab** in a 38px `#tab-bar` (`:277`) at 769px and above, clipped by `#tab-scroll { overflow-y:hidden }` (`:278`). **Remedy:** Keep the desktop-aligned rectangular tab chrome while enlarging the close **hit area** independently of its icon, and give `#tab-bar` enough height for it on coarse pointers.

### M-04 · P1 · Confirmed defect — Two mobile overlay layers use an undefined z-index token

**Evidence:** `--z-modal` is not declared among the tokens at `public/css/styles.css:44-51`, yet it is used by the zoom HUD (`:2407`) and the full-screen mobile command library (`:2838`). An unresolved `var()` invalidates the declaration, so `z-index` falls back to its initial value **`auto`** — the elements fall back to tree order rather than the intended layer.

**Effect:** The command library (a `position:fixed` full-screen drawer at `:2826-2836`) lands **behind** `#editor-view.open { z-index:5 }` (`:564-568`) and under the header chrome and key bar, deterministically rather than intermittently. The zoom HUD can render under other chrome. **Remedy:** Declare `--z-modal` (or use `--z-overlay`). See also S-11 for the larger stacking defect next to it.

### M-05 · P2 · Risk — The mobile header retains many desktop actions

**Evidence:** Mobile hides sidebar toggle, command-library toggle, stats, tiles, and More, but adds search, command, and sessions icons while keeping host, status, keep-awake, notification, settings, and conditional security/transfer controls (`public/index.html:87-147`, `public/css/styles.css:2435-2459`). Header icons remain 32px and nonshrinking (`:851-872`, `:2437`); the host badge has a 140px max width.

**Effect:** At narrow widths, host identity and frequent controls can crowd or clip; 32px icons have less forgiving hit areas than the 44px sidebar controls. **Treatment:** Show host/session identity plus the most frequent one or two actions; route the rest through the bottom nav or contextual menus. Verify 320px and 390px with badges active.

### M-06 · P2 · Design — Navigation repeats the same actions across surfaces

**Evidence:** New session is available from the tab-strip `+` and the floating `+` in the bottom nav; sessions and snippets appear in the header and on the launchpad (`public/index.html:114-123`, `:300-316`, `:374-380`, `:861-895`).

**Effect:** Repetition consumes space without clarifying the task. **Treatment:** Give each frequent action one consistent home, with shortcuts or overflow as secondary routes.

### M-07 · P2 · Design — Mobile chrome is markedly glossier than the desktop workspace

**Evidence:** Header, tab bar, bottom nav, key rows, search, and sheets stack blur/saturation, translucent backgrounds, and large shadows; the floating `+` adds a gradient, colored glow, and raised position (`public/css/styles.css:2425-2434`, `:2478-2486`, `:2536-2598`, `:2626-2643`, `:2870-2886`). Desktop workspace surfaces are largely flat theme backgrounds and borders (`:244-285`). 29 `backdrop-filter` declarations exist in total.

**Effect:** Phone and desktop feel like two products, and the floating action becomes the most prominent thing on a terminal screen. **Treatment:** One shared flat surface treatment, one elevation level for real overlays, and a quieter new-session control.

### M-08 · P2 · Confirmed defect — Toast offsets ignore the mobile nav and double-count the key bar

**Evidence:** `#toast-container` positions itself with `bottom: calc(var(--mobilekey-h) + 14px + env(safe-area-inset-bottom))` and `calc(var(--mobilekey-h) + 60px + …)` for the banner state (`public/css/styles.css:1760-1768`). The mobile nav occupies 54px plus the inset (`:2536-2550`) and is never counted. Worse, the mobile override `--mobilekey-h: 44px` (`:2628`) is declared **inside the rule block for `#mobile-keys, #mkey-ctrl-row, #mkey-sel-row`** (`:2627`), so it is scoped to those three elements; `#toast-container` is a document-level sibling (`public/index.html:1413`) and still resolves the `:root` value of **46px** (`:23`). Then `public/js/ui.js:446` sets `el.style.marginBottom = 'var(--mobilekey-h)'` on **each toast** on top of the container's own `bottom`.

**Measured:** with keys on, toasts clear `46 + 14 + 46 + inset` ≈ **106px**, over both the 54px nav and the 44px key bar.

**Effect:** A toast can cover the bottom navigation and the shortcut controls. **Remedy:** Move the `--mobilekey-h` mobile override to `:root`, remove the per-toast `marginBottom`, and express the offset against the nav height and the shared `--kb-inset` from M-22. Note this does **not** affect M-00, because `public/js/terminal.js:2038` measures `mobileKeys.offsetHeight` live.

### M-09 · P2 · Confirmed defect — Landscape header reduction is canceled by its minimum height

**Evidence:** The mobile header sets both `height` and `min-height` to `calc(44px + env(safe-area-inset-top))` (`public/css/styles.css:2425-2429`), while the landscape rule changes only `height` to 32px (`:3066-3075`). The 44px minimum still applies. The landscape nav becomes 44px tall while its child buttons retain `min-height: 48px` (`:2554-2562`, `:3074`).

**Effect:** The promised height saving is not achieved, and nav contents may overflow their shortened container. **Remedy:** Change both `height` and `min-height` coherently in landscape and check safe-area behavior. The `:3070` `#settings-panel { top: 0 }` in the same block is dead — `:2773` already sets it (see X-07).

### M-10 · P2 · Risk — Alternative light themes do not receive the mobile key treatment

**Evidence:** Both Catppuccin Latte and Nord Light are light themes, but the mobile key override targets only `[data-theme="light"]`. Otherwise keys use translucent white fills, white borders, and inset highlights intended for dark surroundings (`public/css/styles.css:78-101`, `:2662-2688`, `:2711-2720`).

**Effect:** Shortcuts may have weak separation and look inconsistent across light theme options. **Remedy:** Derive key fill/border from shared theme variables or target all light themes with one semantic rule; check each light palette.

### M-11 · P1 · Confirmed defect — Touch feedback erases button colors, on every touch device

**Evidence:** `@media (hover: none)` (`public/css/styles.css:3054-3064`) is **not width-gated**, so it applies to touch tablets and touch laptops too. The `:hover` override assigns `background:inherit; color:inherit; border-color:inherit` (`:3055-3059`) and the `:active` rule forces `background: var(--bg4) !important` for `.btn` (`:3060-3063`) regardless of `.btn-primary` or `.btn-danger`.

**Effect:** A primary or destructive button temporarily loses its identity, with foreground color intended for the original fill. `background:inherit` resolves against the *parent's* background, so an `.icon-btn` in the header picks up `--bg2` from `#header` rather than the intended `--bg4`, and `border-color:inherit` nulls `.btn-ghost`'s `border-color: var(--border)` (`:1531`), leaving a ghost button with **no** hover affordance on touch.

**Remedy:** Style pressed states per button variant while suppressing sticky hover only where needed, and preserve legible foreground/background pairings. Because this rule gates the whole touch experience, fix it before any per-control touch retune.

### M-12 · P2 · Confirmed defect — Terminal padding override also affects file and preview tabs

**Evidence:** Mobile assigns `.term-wrapper { padding: 8px 10px 10px !important }`, while file-tab and tile-specific wrappers deliberately request zero padding without `!important` (`public/css/styles.css:460-472`, `:501-506`, `:2461-2464`). The `!important` wins for all wrapper types.

**Effect:** File viewers and previews gain unintended gutters or compressed content. **Remedy:** Scope the mobile padding to terminal wrappers.

### M-13 · P2 · Confirmed defect — The Ctrl shortcut row cannot dock; it floats over the terminal

**Evidence:** `public/css/styles.css:2319-2324` defines fixed positioning **only** for `#mobile-keys.keyboard-docked`. `#mkey-ctrl-row` gets `position: relative` from the mobile block (`:2639`), so `ctrlRow.style.bottom = keyboardMargin + keysOffset` (`public/js/terminal.js:2051`) is a **relative offset**: the row is painted up to ~380px above its flow position with **no layout change**, i.e. over the terminal and potentially over the header (`z-index: var(--z-header)` = 10, `:2640`, and later in DOM order than the header). The JS guard at `:2049` also tests `ctrlRow.style.display === 'flex'`, a value M-02 and M-19 can change behind its back, so the row can be left in a docked-looking state with the class never applied.

**Remedy:** Give the row a matching `position:fixed` rule, or make the optional rows share one keyboard-aware container.

### M-14 · P3 · Design — The launchpad becomes a long stack on phones

**Evidence:** Below 560px the three launchpad cards switch to a single column, after the logo, host, vitals, sparkline, primary button, and quick-action grid (`public/css/styles.css:351-397`; `public/index.html:365-393`).

**Effect:** The initial screen emphasizes scrolling dashboard content instead of reaching a shell or resuming a session. **Remedy:** Surface the primary session action and recent sessions first; collapse low-frequency detail at mobile widths.

---

## 2. Desktop and tablet findings

### D-07 · P1 · Confirmed defect — The editor toolbar overflows and clips **Save** at the default panel width

**Evidence:** The default panel width is `flex: 0 0 var(--editor-size, 300px)` (`public/css/styles.css:527`); `--editor-size` is only set from storage after a previous drag, so first use is exactly 300px. `#editor-header` has **no `flex-wrap` and no `overflow`** (`:1579`). The only shrinkable child is the filename (`:1580`, `flex:1; min-width:0`); everything else is floored — 5 `.icon-btn` at `flex-shrink:0; min-width:32px` (`:851-872`), the preview toggle as a non-wrapping `.btn` with base `padding: 0 16px` (`:1522`), and `#editor-save-btn` whose inline `padding:0 12px` (`public/index.html:489`) still cannot shrink below its min-content. Plus 7 gaps × 8px and 24px padding. `#editor-view { overflow: hidden }` (`:450`) clips the result.

**Measured:** a Markdown file in edit mode needs roughly **350px** against **276px** available, and Save is the last child (`public/index.html:489`) — it is the first thing lost. In HTML preview mode it grows to ~390px. The horizontal split (`flex: 0 0 var(--editor-size, 400px)`, `:540`) leaves ~50px for the filename.

**Effect:** Open a README or an HTML file at the default size and the primary Save affordance is invisible. Ctrl+S still works, so the failure is silent.

**Remedy:** Give the toolbar its own responsive contract: `overflow-x: auto` as a floor so nothing is unreachable, plus a container query or `.compact` class that drops low-value toggles below ~420px, and move Save left of the filename group so overflow eats the spacer rather than the primary action. Tie `--editor-size`'s default to `min(300px, 40%)` so the panel never outgrows its own toolbar.

### D-08 · P2 · Confirmed defect — Fullscreen editor paints over the Settings and Notification drawers

**Evidence:** `#editor-view.fullscreen { position:absolute; inset:0; z-index:30 }` (`public/css/styles.css:452`). `#settings-panel` and `#notif-panel` use `z-index: var(--z-drawer)` = **25** (`:622`, `:650`, token at `:45`). No ancestor of `#editor-view` creates a stacking context — `#app` (`:233`) has no z-index, `#main` (`:272`), `#content` (`:276`), and `#editor-split-area` (`:437`, `:515`) are `position:relative` with `z-index:auto` — so both drawers and the fullscreen editor compete in the **root** stacking context, where **30 > 25**. The panels are siblings of `#content` (`public/index.html:299`, `:613`, `:855`).

**Effect:** With the editor fullscreen, opening Settings slides in a drawer that is painted **behind** the editor while `inert` (`public/js/settings.js:192-199`) and the focus trap (`:231`) make it the only interactive region — a keyboard user is focus-locked in an invisible panel with no way back but Esc.

**Remedy:** Put the drawers above fullscreen content — either raise `--z-drawer` above 30, or drop the fullscreen editor to `--z-header` (10), since it only needs to beat `#terminals` (`z-index:auto`).

### D-09 · P2 · Confirmed defect — Keyboard Shortcuts and Listening Ports are unreachable on desktop and tablet

**Evidence:** `#more-btn { display: none; }` (`public/css/styles.css:1082`) and nothing ever sets it visible — the only writes are `classList.toggle('active', …)` (`public/js/settings.js:532`, `:548`, `:567`). `#more-menu` (`public/index.html:886-895`) is the sole opener for both features: `openShortcuts()` has exactly one caller in the codebase (`public/index.html:894`, defined at `public/js/ui.js:96`), and `openPortsModal()` is reachable only from that same hidden menu (`public/index.html:888`) or by typing "port" into the fuzzy finder (`public/js/misc.js:201`). There is no `?` shortcut in `setupKeyboardShortcuts` (`public/js/terminal.js:1438-1650`) and no `#tab-list-menu` entry (`public/index.html:321-351`).

**Effect:** The Keyboard Shortcuts dialog — a documented app feature — cannot be opened at any width above 768px. Listening Ports requires remembering a search keyword. Two capabilities are silently unreachable.

**Remedy:** Unhide `#more-btn` above 768px; it is the designed overflow home and would also relieve D-01 and D-13. Promote both into always-reachable surfaces as well: a `?` binding guarded to non-terminal focus, and a Ports item in the `#tab-list-menu` header beside the existing Sessions/Preview buttons (`public/index.html:329-337`).

### D-06 · P1 · Confirmed defect — Bell and active tab borders conflict deterministically

**Evidence:** `.tab.active { … border-color: var(--border); box-shadow: inset 0 2px 0 var(--accent), 0 0 12px … }` (`public/css/styles.css:1125`) and `.tab.has-bell { border-color: var(--amber); }` (`:1147`). Equal specificity (0,2,0), later source order, so an **active** tab with a pending bell gets an amber border that overrides the active border. The active tab also combines colored text, a top accent stripe, and a glow; color tags glow (`:1133-1138`); activity and bell indicators pulse (`:1145-1146`); pinned tabs gain a second underline (`:1140`).

**Effect:** The active-tab treatment is ambiguous by construction, not merely busy by taste — a user cannot reliably tell which terminal is focused, and background tabs can be brighter than terminal content.

**Remedy:** One unmistakable active marker with static muted badges. Fix the border conflict explicitly, and preserve the distinct dirty, bell, pinned, and exited meanings — including the file-tab title glyphs (`:337-340`) which share the same tab surface.

### D-02 · P1 · Confirmed defect — The default sidebar toolbar exceeds the default sidebar width

**Evidence:** `--sidebar-w` is 280px (`public/css/styles.css:22`). Seven 32px icons, two separators, the back/forward group, and the container gaps plus 16px padding require **286px** before the border (`:1265-1271`; markup `public/index.html:162-188`). Re-derived independently: 224 + 14 + 32 + 16 = 286.

**Effect:** A default-width sidebar acquires an unintended second toolbar line, displacing the file list.

**Important for the fix:** seven of those buttons carry inline `style="width:32px;height:32px;min-width:32px;min-height:32px"` (`public/index.html:164`, `:167`, `:171`, `:175`, `:178`, `:181`, `:185`) that duplicate `public/css/styles.css:1270`. **Editing the stylesheet alone cannot fix this** — the inline styles must be stripped first.

**Remedy:** Remove those inline dimensions, then reduce always-visible controls, group history navigation, or provide a deliberate overflow action. Verify at the default width and when resized narrower.

### D-03 · P1 · Confirmed defect — Tablet-width sidebar layout depends on a state that is not established on load

**Evidence:** At 769–1023px the sidebar becomes 200px (`public/css/styles.css:3078-3080`) while its toolbar remains a wrapping group (`:1265-1270`). The horizontal-scroll variant is gated on `.narrow` (`:1375-1379`), which `updateSidebarNarrowClass()` applies — but that function is called only from the resize handler and from `restoreSidebarWidth()` (`public/js/settings.js:582-647`), and `restoreSidebarWidth()` returns early when no saved width exists. Boot calls `restoreSidebarWidth()` and registers the resize listener (`public/js/core.js:520-524`), so on a fresh load `.narrow` is absent and the toolbar wraps; after the **first** resize event it flips to nowrap-with-scrollbar.

**Effect:** The same session alternates between a wrapped two-line toolbar and a nowrap scrolling one for no reason, and at 200px there is no width at which 286px of controls fit one line. Both ends of the transition are deterministic, so this is a confirmed defect, not a risk.

**Remedy:** Make the 200px toolbar layout intentional without depending on saved-width state — add a `ResizeObserver` on `#sidebar` calling `updateSidebarNarrowClass()`, or make the narrow layout the default at that width. Inspect widths immediately above and below 768px.

### D-11 · P2 · Confirmed defect — The file list can collapse to zero height under the git panel

**Evidence:** `#file-list-wrap { flex:1; min-height:0 }` is the **only** `flex:1` item in `#sidebar` (`public/css/styles.css:1282`) and is explicitly allowed to reach 0. Fixed-height siblings refuse to shrink: `#bookmarks-header` and `#bookmarks-list` (`:1860`, `:1870`), sidebar header (`:1265`), path bar (`:1276`), sidebar footer (`:1362`). `#git-panel.open { max-height: 320px }` (`:1903`) is an absolute cap that ignores available height.

**Effect:** On a short window with bookmarks expanded and git open, the explorer shows toolbar, path bar, git, bookmarks, and footer — **no files, no scrollbar, no message**.

**Remedy:** Protect the primary surface: `#file-list-wrap { min-height: 96px }` and cap git relative to the viewport (`max-height: min(320px, 40vh)`), or make the sidebar itself the scroll container on short windows.

### D-12 · P2 · Confirmed defect — The git header overflows the 200px tablet sidebar without wrapping

**Evidence:** `#git-header` is a flex row with **no `flex-wrap`** and `flex-shrink:0` (`public/css/styles.css:1894-1899`), containing a `<select>` with `max-width:130px` (`:1965`) plus branch-add, sync, and count elements (`public/index.html:213`). `#sidebar { overflow: hidden }` (`:273`) clips the excess.

**Measured:** at a 200px sidebar the row needs roughly **273px**.

**Effect:** In the 769–1023px range the branch status and change count — the two things that tell you the repo is dirty — are cut off entirely, with no ellipsis or scrollbar.

**Remedy:** Add `flex-wrap: wrap` with `#git-branch-sel { flex: 1 1 60px; min-width: 0 }`, or move sync/count onto a second line below 240px.

### D-13 · P1 · Risk — Near 1024px the header sacrifices host identity and lets the search pill spill

**Evidence:** `#header` is a fixed 38px row with `gap:5px` and `overflow: visible` (`public/css/styles.css:244-260`). All 32px icon buttons and `.keep-awake` are `flex-shrink: 0` (`:861`, `:949`), as is `#logo` (`:800-812`). Only two items can shrink: `#hostname-badge` (`max-width:170px; overflow:hidden; flex-shrink:1`, `:1043-1063`) — because `overflow:hidden` makes it a scroll container, its `min-width:auto` resolves to **0**, so it absorbs all shrinkage and vanishes with no ellipsis — and `.header-palette-btn` (`:818-831`), whose "Quick search…" label contains a space so it can wrap, and whose padding with no fixed height lets it grow taller than the row. `#header { overflow: visible }` (`:259`) lets it overhang `#tab-bar`. `#more-btn` is hidden, so the relief valve does not exist (D-09).

**Effect (predicted):** just under ~1024px with a long hostname, the host badge — the primary identity element — collapses to zero width while the search pill wraps and overhangs the tab strip.

**Remedy:** Measure first (log `#header` `scrollWidth` vs `clientWidth` and `#hostname-badge.offsetWidth` at 769/820/900/1023px with security and transfer buttons forced visible). Then give the badge `flex: 0 1 auto; min-width: 64px` so it ellipsises instead of vanishing, and move the palette pill into the overflow menu below ~1024px or hide it below 900px since Ctrl+K still works.

### D-10 · P2 · Confirmed defect — An inline sidebar width overrides the tablet layout

**Evidence:** `#sidebar { width: var(--sidebar-w) }` (`public/css/styles.css:273`) with tablet overrides at `:3079` (200px) and `:2419` (320px). JS writes **inline** width, which beats both media queries: `public/js/settings.js:610` (drag) and `:640` (restore), and `:519-522` preserves it across collapse/expand. Neither media query updates `--sidebar-w`, so the horizontal-split cap `max-width: calc(100vw - var(--sidebar-w) - 160px)` (`:542`) also keeps using the stale value.

**Effect:** Resize the sidebar to 500px on a desktop, then shrink the window to 900px: the tablet rule is ignored, the sidebar stays 500px, and the editor split and the 440px Command Library (`:2014`, clipped by `#content { overflow:hidden }`, `:276`) render unusable. Rotating an iPad across 1024px produces the same jump in reverse.

**Remedy:** Clamp at the source: on resize, if `innerWidth <= 1023` write the clamped width to both `sidebar.style.width` and `--sidebar-w`, and clear the inline width above 1023 so the media query governs again.

### D-14 · P2 · Confirmed defect — Tab-strip create buttons jump position and the fade mask dims the `+`

**Evidence:** All three create buttons live **inside** the scroll container (`public/index.html:307-317`). `#new-tab-btn` is `position: sticky; right: 0` (`public/css/styles.css:1237`) and is the **first** child, so with few tabs it sits at the left of the strip; as soon as the strip overflows, `right:0` pins it to the right edge. `#new-preview-btn` and `#ssh-toggle` (`:1239-1254`) have no `position`, so they scroll away left while the `+` stays pinned. `#tab-scroll`'s `mask-image: linear-gradient(to right, black calc(100% - 20px), transparent)` (`:278`) is unconditional, so the rightmost 20px is always faded — exactly where the sticky `+` lands.

**Effect:** Below the overflow threshold the create controls lead the strip, reading as three tabs; above it the `+` detaches and floats over the tabs as a semi-transparent chip while preview and SSH scroll off-screen. The affordance relocates with no user action.

**Remedy:** Move the three create buttons out of `#tab-scroll` to be siblings of the scroll arrows (`public/index.html:300-352`), deleting the inline styles at `:311` and `:314` in the process. Scope the fade mask to an inner wrapper around the `.tab` elements only.

### D-16 · P2 · Confirmed defect — In-terminal search and zoom HUD anchor to `#content`, straddling the tab strip

**Evidence:** `#content { position: relative }` (`public/css/styles.css:276`) is the containing block for both overlays. `.term-search-bar { position:absolute; top:8px; right:12px }` (`:2343-2347`) — but `#content` starts at the top of the **tab bar**, which is 38px tall (`:277`), so at `top:8px` the ~30px-tall bar covers the bottom ~30px of the tab strip. `.term-zoom-hud` centres on `top:50%; left:50%` of `#content` (`:2391-2394`), landing ~19px below the true centre of the terminal area. Both are children of `#content` (`public/index.html:354`, `:362`).

**Effect:** Ctrl+F in a terminal paints a translucent pill over the tab chrome and misaligns with its terminal; the zoom HUD reads off-centre.

**Remedy:** `top: calc(var(--tab-h) + 8px)` for the search bar, and for the HUD either move it inside `#terminals`/`#editor-split-area` or use `position: fixed; inset: 0` with `pointer-events: none` (already set at `:2408`) so 50%/50% means viewport centre.

### D-15 · P2 · Design — Desktop drawers are flush and unshadowed while they inert the workspace

**Evidence:** `#settings-panel` (`:613-624`) and `#notif-panel` (`:641-652`) are `position:absolute` with a 1px left border, **no `box-shadow`, and no scrim**. The mobile overrides do add elevation (`box-shadow: -4px 0 24px`, `:2773`). `.drawer-backdrop` (`:2311-2317`) is activated only at ≤768px (`public/js/settings.js:211-214`). Meanwhile `setBackdropInert(true)` (`:192-199`) makes the terminal and tab strip non-interactive and `installFocusTrap` (`:231`) captures focus.

**Effect:** The drawer reads as a static third column, yet the app behaves modally: clicking a tab or file silently does nothing, with no dimming, shadow, or explanation.

**Remedy:** Give the desktop drawers one elevation level and a scrim matching the modal behavior they already have, or stop inverting — let the drawer push `#content` instead of overlaying and inert-ing it.

### D-17 · P3 · Confirmed defect — The Settings entrance animation replays on every open

**Evidence:** `public/js/settings.js:223-225` removes `sec-anim`, forces reflow, and re-adds it on every open, and **never removes it** afterward; the class appears in exactly those two places. `#settings-panel.sec-anim .settings-section { animation: secIn .32s both }` with `animation-delay` stepping to `.21s` on `:nth-child(9)` (`public/css/styles.css:1694-1702`); `both` fill holds the `from` state during the delay.

**Effect:** Every Settings open replays all nine cards. With a persisted open section, the last card does not settle until ~0.53s after the panel's 0.2s slide, so the bottom of the list is still moving while the user reads the top.

**Remedy:** Remove `sec-anim` once the longest delay elapses, or play it only on first run and add it to `body` so a toggle cannot re-trigger it. If kept, drop the stagger past three cards.

### D-04 · P2 · Design — The sidebar combines several dense workflows in one narrow column

**Evidence:** File navigation, breadcrumbs, bookmarks, Git branch/status/commit/actions, selection actions, and footer controls share the sidebar (`public/index.html:161-295`). Git alone has multiple rows and a panel up to 320px tall (`public/css/styles.css:1893-1987`).

**Effect:** File navigation becomes a small slice of a 280px-wide, vertically crowded surface. Its two concrete failure modes are D-11 (file list collapsing) and D-12 (git header clipping). **Remedy:** Give the explorer default emphasis; collapse or contextually open secondary workflows such as Git, and use one predictable toolbar hierarchy.

### D-05 · P2 · Design — The launchpad repeats actions and looks like a showcase

**Evidence:** A primary **New terminal** action is followed immediately by another **Terminal** action (`public/index.html:374`, `:376`), then Sessions, SSH Host, Explorer, and Snippets; above and below are system vitals, a sparkline, three cards, and a keyboard hint (`public/index.html:365-393`). Its width and decorative treatments center it like a landing screen (`public/css/styles.css:347-397`).

**Effect:** The empty-tab state is much busier than the working terminal. **Remedy:** One new-terminal action, recent sessions/places, and a restrained status line. Move detailed vitals into System Stats.

### D-01 · P1 · Design — The primary header treats too many tools as primary

**Evidence:** The 38px header contains connection status, logo, host, search, keep-awake, security/transfer state, explorer, command library, stats, tiles, notifications, and settings (`public/index.html:87-150`; `public/css/styles.css:21-25`, `:244-260`, `:851-872`). Most icon buttons are 32px and do not shrink.

**Effect:** On a terminal-first screen the toolbar draws attention away from the session and crowds as width decreases.

**Treatment note:** The natural remedy — move infrequent tools into an overflow menu — is **already built but unreachable** (D-09). Make the overflow menu real first; that is cheaper than restructuring the header and independently fixes two dead features. Fix the shrink contract (D-13) before adding or removing tools.

---

## 3. Shared design-system findings

### S-01 · P1 · Design — Important interface text is frequently micro-sized

**Evidence:** The base UI is `13px`, but notification tags are `8.5px`, status pills `9px`, file metadata and group headings `10px`, Git rows/actions `10–11px`, and mobile navigation labels `10px` (`public/css/styles.css:149`, `:752-762`, `:1331-1337`, `:1686`, `:1904-1918`, `:2562-2567`). Desktop instances the first pass missed: `#notif-search-input` 11px (`:710`), `.notif-chip` 10.5px (`:724`), `.cmd-lib-cmd` 11px (`:2175`), `.cmd-lib-section-title` 10px (`:2130`), `.cmd-hist-cmd` 11.5px (`:2211`), `.cmd-hist-meta`/`.cmd-hist-time` 10px (`:2215`, `:2223`), `.doc-page-info` 11px (`:1600`), `#editor-status` 11px (`:1588`), `.sys-card .sys-sub` 11px (`:2290`), `.sys-table` 11px (`:2302`), the SSH block at 10–11px (`:897-939`), `.lp-card h4` 10px (`:388`), `.lp-pulse` 11.5px (`:374`). Terminal and editor text are more legible (14px, `public/js/core.js:22`; `:1636`).

**Measured:** the stylesheet contains **23 distinct `font-size` values**, with the 9–10.5px cluster accounting for roughly 58 declarations.

**Effect:** Information outside the terminal is compressed and hard to scan, especially on a phone. Several of the smallest items are also the lowest-contrast (S-19). **Remedy:** Collapse to about seven steps — 13–14px actions/body, 12px secondary metadata, smaller only for truly nonessential badges. Keep monospace for paths and commands.

### S-02 · P1 · Design — Controls do not share a consistent size and shape vocabulary

**Evidence:** Size tokens are declared (`--btn-sm`, `--btn-md`, `--btn-lg`, `public/css/styles.css:41-43`) but measured consumption is **one** use of `--btn-md` (`:1528`) and **zero** uses of `--btn-sm` and `--btn-lg`; more importantly **no `.btn-sm` rule exists at all**, so every "small" button renders at the full 34px base height (`:1522`) despite four call sites requesting it (`public/index.html:446`; `public/js/ui.js:292`; `public/js/misc.js:456`, `:967`). Independently specified sizes run 20, 22, 24, 26, 28, 32, 34px across notification actions, command actions, document toolbars, tab controls, sidebars, and standard buttons (`:765-769`, `:1237-1259`, `:1362-1365`, `:1601`, `:2184-2188`). Corners range from 3–10px tokens to 16–20px mobile sheets and circular floating actions (`:26-29`, `:2584-2595`, `:2801-2816`, `:2870-2886`).

**Effect:** The vocabulary is partly imaginary — three of three size tokens and one of two size classes are unused — so adjacent tools look like parts of different products, and `btn-sm` buttons are visibly oversized in the Command Library history header (a 34px button beside 22–24px controls, `:2229-2247`) and in the fuzzy finder's empty state (`public/js/misc.js:456`).

**Remedy:** Add the missing `.btn-sm`/`.btn-lg` rules (or delete the class usages and dead tokens) **before** any per-feature retuning, otherwise the retuning has no shared target.

### S-03 · P2 · Design — Color, glow, and motion are used for routine states

**Evidence:** The launchpad has an animated radial aura, dot grid, staggered entrance (11 children with delays to `.50s`), animated logo, and blinking pulse (`public/css/styles.css:349-380`). Auth/offline screens repeat the aura and grid (`:1555-1559`). The workspace adds glow or animation to the connection dot (`:1029-1038`), the mobile-only `statusPulse` (`:2438-2445`), active and activity tabs (`:1125`, `:1145-1150`), the keep-awake toggle (`:955-967`), settings toggles (`:1704`), and the settings entrance (`:1694-1702`). 29 `@keyframes` blocks and 17 `infinite` animation declarations exist in total.

**Effect:** Active, decorative, and urgent cues compete; ambient glow and perpetual motion make a tool feel like a showcase. The event-driven `bellFlash` (`:399`) and `pinShake` (`:1560`) are the model to keep.

**Remedy:** Keep the active-tab accent, genuine progress, and the security alert pulse; remove ambient glow and perpetual motion from ordinary connected, selected, and idle states; favor stable surfaces over repeated entrance animations. Fix S-07 first so reduced motion is actually enforced, and D-17 so the Settings entrance stops replaying.

### S-05 · P1 · Measured — `--amber` is a Tokyo-Night-only token that nine themes inherit, and it fails contrast in every light theme

**Evidence:** `--amber: #e5a50a` is declared exactly once, in `:root` (`public/css/styles.css:10`), and none of the nine `[data-theme]` blocks redefines it. It is consumed **15 times** as a state-bearing color (`:337`, `:340`, `:480`, `:484`, `:487`, `:924-929`, `:1007`, `:1140`, `:1141`, `:1146`, `:1147`, `:1589`) plus inline at `public/index.html:104` and `public/js/security.js:163`, `:546`.

**Measured contrast for `#e5a50a` (WCAG relative-luminance method):**

| theme | vs `--bg` | vs `--bg2` | vs `--bg3` |
| --- | --- | --- | --- |
| light | 2.06 | 1.87 | 1.67 |
| catppuccin-latte | 1.91 | 1.78 | 1.63 |
| nord-light | 2.07 | 1.97 | 1.75 |
| tokyonight | 7.91 | 8.32 | 6.74 |
| solarized | 6.95 | 6.02 | 5.31 |

Every light-theme value is below 3:1 (WCAG 1.4.11 non-text) and far below 4.5:1 (1.4.3 text).

**Effect:** In the three light themes these become effectively invisible: the file-tab unsaved-changes dot, the dual-state dot, the 11px "Changed on disk" text, the pinned-tab underline, the tab bell dot, the "waiting" transfer bar, the SSH private-key warning — and worst, the **security-alert triangle** (`public/index.html:104`), the app's "unreviewed login" signal, sitting on the `--bg2` header at **1.87:1**.

**Remedy:** Either add `--amber` to each theme with values chosen against that theme's `--bg2`/`--bg3`, or — cleaner — **delete `--amber` and route all 15 uses through `--yellow`**, which every theme defines. Note the two tokens already drifted: `:root` holds `--amber: #e5a50a` and `--yellow: #e0af68` side by side (`:10`, `:19`).

### S-07 · P1 · Confirmed defect — The reduced-motion block makes perpetual animations faster, not absent

**Evidence:** `public/css/styles.css:3091-3095` sets `animation-duration: 0.01ms !important`, `transition-duration: 0.01ms !important`, and `animation-delay: 0ms !important` under `@media (prefers-reduced-motion: reduce)`. **`animation-iteration-count` is never reset** (verified: zero occurrences in the file), while 17 declarations use `infinite`.

**Effect:** `animation-duration: 0.01ms` plus `iteration-count: infinite` means each animation restarts every 0.01ms instead of stopping — the compositor keeps an animation clock running indefinitely for a user who explicitly asked for less motion, a battery cost on exactly the low-end devices the query exists for. Opacity and transform animations also sample arbitrary points in their cycle, so the resting state is undefined (for example `tabPulse` at `:1145-1146` may freeze at `opacity:.45`).

**Remedy:** Use `animation: none !important` for the ambient set (`pinAura`, `lpBlink`, `tabPulse`, `secAlertPulse`, `steamRise`, `awakeGlow`, `statusPulse`), or at minimum add `animation-iteration-count: 1 !important`. Keep `transition-duration` for the one-shot transforms.

### S-08 · P1 · Confirmed defect — 13 interactive component classes have no `:focus-visible` rule, including every settings switch

**Evidence:** The focus block at `public/css/styles.css:1468-1484` covers 11 selectors. Verified absent: `.toggle`, `.tab-close`, `.mnav-btn`, `.toast-btn`, `.toast-x`, `.notif-btn`, `.cmd-action-btn`, `.tx-act`, `.file-quick`, `.bm-remove`, `.notif-chip`, `.cmd-cat-chip`, `.cmd-lib-tab`, `.term-sess-filter-btn`, `.tab-list-close`, `#notif-search-clear`, `.cmd-search-clear`, `#git-branch-add`, `.preview-status`.

The two worst: `.toggle` is `<div class="toggle" role="switch" tabindex="0" aria-checked>` (`public/index.html:729` and 12 more instances) — fully keyboard-reachable and correctly ARIA'd, with **zero** visible focus indication; `.setting-row:hover { background: var(--bg4) }` (`:1707`) is a hover cue, not a focus cue. And `.tab-close` (`:1127`) has no rule either: `.tab:focus-visible` (`:1469`) rings the *tab*, and when the close button takes focus the only change is `.tab:focus-within .tab-close { opacity:.75 }` (`:1128`).

**Effect:** WCAG 2.4.7 (Focus Visible) failure on the primary settings surface (13 switches) and on every tab's close control.

**Remedy:** Add the missing selectors to the existing block rather than authoring new rules, and add a low-specificity `:where(button, [role="switch"], a[href]):focus-visible` baseline before the list so nothing new regresses.

### S-10 · P1 · Confirmed defect — Closed Settings and Notification drawers remain in the tab order

**Evidence:** Both panels are hidden by transform alone: `#settings-panel { transform: translateX(100%) }` (`:618`) reopened by `.open` (`:625-627`), and `#notif-panel` likewise (`:646`, `:653-655`). Neither has `visibility`, `display`, `inert`, or `aria-hidden` in the closed state, and both contain many focusable controls — `#settings-panel` alone has roughly 200 inputs/selects/buttons plus 13 `role="switch"` toggles. JS sets `inert` only on the **background** when a panel opens (`public/js/settings.js:192-199`, `:229-234`) and removes it on close (`:239`, `closeSettings` at `:247-249`); `public/js/ui.js:720-738` touches only classes and `aria-expanded`. Verified: the only two `inert` setters in the codebase target backdrop elements (`public/js/settings.js:197`, `public/js/misc.js:270`).

**Effect:** Tabbing from the header walks through hundreds of off-screen Settings controls and the entire Notification Center before reaching `#main` — WCAG 2.4.3 (Focus Order) and 4.1.2 (Name/Role/Value) failure. This is the largest keyboard-navigation defect in the app and it is invisible to a mouse user.

**Remedy:** Toggle `inert` on both panels in their open/close helpers, mirroring the existing `setBackdropInert` pattern, or add `visibility: hidden` to the closed state with `transition: visibility 0s` so the slide animation still plays.

### S-11 · P1 · Confirmed defect — The blocking PIN and offline screens sit below three tokenised layers

**Evidence:** `#pin-screen { z-index: 200 }` and `#offline-screen { z-index: 300 }` are hard-coded (`public/css/styles.css:1552-1553`) while the token scale runs `--z-header:10`, `--z-drawer:25`, `--z-popover:28`, `--z-sidebar:30`, `--z-drop:50`, `--z-overlay:400`, `--z-toast:450`, `--z-menu:500` (`:44-51`). So **300 < 400 < 450 < 500**. Consumers of the higher layers: `.overlay` (`:1505`), `#toast-container` (`:1762`), `#ctx-menu` (`:1724`), `#term-ctx-menu`, `#tab-ctx-menu`, `#new-tab-menu` (`:1178`), `#more-menu` (`:1096`), `#tab-list-menu` (`:1161`), `#term-selection-bar` (`:1184`). All are `position:fixed` in the root stacking context.

**Effect:** When the socket drops, `#offline-screen` is shown, but any toast raised in the last few seconds, any open context menu, and any open overlay remain in the DOM and outrank it. A user hitting "Retry now" can be looking at a modal with the blocking offline card behind it.

**Remedy:** Add `--z-blocking: 600` and use it, so the screens cannot drift below the token scale again.

### S-04 · P2 · Risk — One-off overrides make the visual system harder to keep coherent

**Evidence:** Inline presentation styles repeat in `public/index.html` — the two tab-bar buttons (`:311`, `:314`), **seven** sidebar-toolbar buttons (`:164`, `:167`, `:171`, `:175`, `:178`, `:181`, `:185`), plus `:192`, `:203`, `:329-338`, `:346`, `:385-387`, `:475-489`, `:520`, `:634`. The mobile stylesheet uses extensive `!important` for terminal padding, sheets, and session-modal sizing (`public/css/styles.css:2461-2464`, `:2801-2905`, `:3264-3358`). Seven custom properties are consumed but never declared (S-13).

**Effect:** A global change updates one surface and misses another. The seven sidebar-toolbar inline blocks are the actual mechanism behind D-02, so that finding cannot be fixed from the stylesheet alone.

**Remedy:** Consolidate repeated controls into shared classes, replace inline presentation styles, and reserve `!important` for genuine overrides. Do this **after** settling the desired hierarchy, folding in X-01, X-03, and X-07.

### S-06 · P2 · Confirmed defect — "Dirty" and "changed on disk" are two ambers on two surfaces, using two indicator shapes

**Evidence:** The same state is rendered three ways — panel `.editor-dirty-dot { background: var(--yellow) }` (`:1582`), file tab `.fte-dot.on { background: var(--amber) }` (`:480`), and tab strip `.tab.file-tab.has-dirty .tab-title::after { content:' •'; color: var(--amber) }` (`:337`), which is a **text glyph** appended to the title rather than a badge. "Changed on disk" is likewise a `' ↻'` glyph (`:339`) versus an element (`public/index.html:473`) versus a ring (`:484`).

**Effect:** Even in the default theme the dirty dot is `#e0af68` on the panel and `#e5a50a` on the file tab, so users learn one color per state and it is wrong one surface over; the tab-strip version is a bullet crammed against a truncated filename.

**Remedy:** One `--dirty` token, one `--ext-changed` token, one 7–8px dot component used by panel, tab, and tab strip. Fold into S-05's change.

### S-09 · P2 · Measured — The More menu's only focus indication is a background swap

**Evidence:** `public/css/styles.css:1103` — `.mm-item:hover, .mm-item:focus-visible { background: var(--bg4); color: var(--fg); outline: none; }` — over a menu background of `var(--bg2)` (`:1087`).

**Measured contrast of the focus state against the unfocused surface:**

| theme | ratio | | theme | ratio |
| --- | --- | --- | --- | --- |
| oled | 1.21 | | gruvbox | 1.41 |
| light | 1.26 | | dracula | 1.47 |
| catppuccin-latte | 1.27 | | monokai | 1.48 |
| tokyonight | 1.32 | | solarized | 1.32 |
| nord-light | 1.36 | | | |

All far below the 3:1 of WCAG 2.4.11 (Focus Appearance). `.ctx-item` does this correctly: `:1732` suppresses the outline and `:1733` immediately restores it.

**Remedy:** Mirror `.ctx-item` — drop `outline: none` from `:1103` and add `outline: 2px solid var(--accent); outline-offset: -2px`.

### S-12 · P2 · Confirmed defect — The OLED palette is unreachable and `theme-color` is pinned to light

**Evidence:** `[data-theme="oled"], [data-theme="midnight-oled"]` defines a complete palette (`public/css/styles.css:62-69`) that is absent from the theme `<select>` (`public/index.html:694-702`, eight options) and from the persisted-settings whitelist (`public/js/settings.js:10`), so a stored `oled` value is silently discarded. Separately, `<meta name="theme-color" content="#f9f9fb">` (`public/index.html:9`) and `public/manifest.json:12-13` both hard-code the **light** theme's `--bg`, and the runtime fix-up `public/js/theme-init.js:25-39` maps only 8 keys — including `nord` and `catppuccin`, **neither a real theme name** — while omitting `solarized`, `monokai`, and `oled`. `applyTheme()` (`public/js/settings.js:429-431`) reads `--bg2` correctly but only when the user changes the theme.

**Effect:** Three of eight selectable dark themes show **light browser chrome** — a white Android status bar or Safari top bar — until the user re-picks the theme, a visible flash on a dark-first terminal app.

**Remedy:** Read `--bg2` from computed style in `theme-init.js` (it already runs before paint) instead of duplicating the map, and delete the two dead keys. Either add OLED to the picker and whitelist or delete `:62-69`.

### S-13 · P2 · Confirmed defect — Seven custom properties are consumed but never declared

**Evidence:**

| property | consumed at | fallback | consequence |
| --- | --- | --- | --- |
| `--fg1` | `:3154`; `public/js/preview.js:414`, `public/js/tabs.js:1032`, `public/index.html:1017`, `:1058` | none | `color` invalid at computed-value time → inherits; the sessions filter hover is a silent no-op |
| `--z-modal` | `:2407`, `:2838` | none | filed as M-04 |
| `--accent-subtle` | `:2061`, `:2080`, `:2167`, `:2192`, `:2219` | hard-coded Tokyo-Night blue | badges/chips/search ring show a foreign blue in 8 themes |
| `--accent-bg` | `:3251`; `public/js/launchpad.js:287` | Material green | no theme uses it |
| `--border-focus` | `:2145`, `:2205` | `var(--border)` | resolves to the normal border → hover border change is a no-op |
| `--radius-full` | `:2101` | `12px` | works |
| `--editor-size` | `:527`, `:540` | `300px`/`400px` | JS-driven, fine |

**Effect:** `--accent-subtle` is the badge and chip background throughout the Command Library and the search focus ring; in every non-Tokyo-Night theme users see a Tokyo-Night blue tint at 15% alpha. `--fg1` is a dead declaration shipped in two JS files and two templates (see X-03).

**Remedy:** Declare `--fg1: var(--fg)` or delete it and its uses; declare `--accent-subtle: color-mix(in srgb, var(--accent) 15%, transparent)`, `--accent-bg`, and `--radius-full` in `:root`; delete `--border-focus` and its two no-op uses; add `--z-modal`.

### S-14 · P2 · Confirmed defect — `prefers-reduced-transparency` neutralizes 1 of 16 backdrop-filter surfaces

**Evidence:** `public/css/styles.css:1506` is the entire implementation: `@media (prefers-reduced-transparency: reduce) { .overlay { backdrop-filter: none; } }`. Measured: **29** `backdrop-filter` declarations across 16 distinct surfaces. Uncovered: `#mobile-keys` (`:416`), `.notif-panel-header` (`:662`), `.settings-panel-header` (`:784`), `#term-selection-bar` (`:1194`), the key rows (`:1452`), `.toast` (`:1779`), `.drawer-backdrop` (`:2313`), `.term-search-bar` (`:2353`), `.term-zoom-hud` (`:2405`), mobile `#header` (`:2431`), mobile `#tab-bar` (`:2484`), `#mobile-nav-bar` (`:2544`), key rows (`:2635`), the context-menu sheets (`:2883`), and `#tab-list-menu` (`:3014`). Two carry `!important`, so a later blanket rule cannot override them without matching specificity.

**Effect:** A user who enables Reduce Transparency still gets 16 stacked blur+saturate layers, three of them `blur(28px) saturate(190%)` covering the entire mobile chrome — on OLED the largest power draw in the layout. The `.overlay` case proves the intent existed and was abandoned after one selector.

**Remedy:** Extend the block to all 16 surfaces, or use `@media (prefers-reduced-transparency: reduce) { * { backdrop-filter: none !important } }`.

### S-15 · P2 · Confirmed defect — `--mobilekey-h` is redefined on the wrong elements

**Evidence:** `:root` sets `--mobilekey-h: 46px` (`public/css/styles.css:23`). The mobile override `--mobilekey-h: 44px` (`:2628`) is declared **inside the rule block** for `#mobile-keys, #mkey-ctrl-row, #mkey-sel-row` (`:2627`), so it is scoped to those three elements and nothing else inherits it. Siblings still reading the root value: `#toast-container` (`:1761`, `:1767`) and `#reconnect-banner` (`public/js/misc.js:1457`).

**Effect:** The token is stale — 46px where the bar is 44px — and in landscape the row is 36px + inset (`:3071`) while consumers still assume 46px. Combined with M-08's double-count this pushes toasts ~106px off the bottom. The M-08 remedy is impossible until this shadowing is fixed.

**Remedy:** Move the override to a `:root`-scoped `@media (max-width:768px) { :root { --mobilekey-h: 44px } }` and remove the per-toast `marginBottom` from `public/js/ui.js:446`.

### S-16 · P2 · Confirmed defect — No loading, empty, or error surface announces itself

**Evidence:** The transient-state overlays are built with `innerHTML` and nothing else: `public/js/tabs.js:876-878` (`<span class="tl-spinner"></span><span>Connecting…</span>`, no `role="status"` or `aria-live`) and `public/js/preview.js:80-81` (same shape). `.preview-error` (`:332-333`) toggles `display:none` → `.show` with no `role="alert"`. `#reconnect-banner` (`public/index.html:156`) is inline-styled with no live region. `#editor-filename-wrap` **does** carry `aria-live="polite"` (`public/index.html:473`), so the pattern exists in the codebase and is simply not applied to the terminal.

**Effect:** A screen-reader user gets silence during the connect window and through any reconnect loop — the failure mode M-00 describes is invisible to them — and no announcement for preview load failures.

**Remedy:** Add `role="status"` + `aria-live="polite"` to the two loading overlays and `role="alert"` to `.preview-error` and `#reconnect-banner`.

### S-17 · P2 · Confirmed defect — `aria-atomic` on the toast container, and toasts pause only on mouse

**Evidence:** `public/index.html:1413` is `<div id="toast-container" aria-live="polite" aria-atomic="true">`, and the container stacks up to 4 toasts (`public/js/ui.js:457-463`). With `aria-atomic="true"` each insertion re-announces the entire subtree, so a burst of four announces 1, then 2, then 3, then 4 — ten utterances for four messages. Separately, `public/js/ui.js:462-474` pauses the countdown on `mouseenter`/`mouseleave` with **no** `focusin`/`focusout` handler, while each toast contains real buttons (Copy `:407-421`, Dismiss `:428-432`) a keyboard user must tab to. Errors get 6500ms, everything else 3500ms (`:439`).

**Effect:** WCAG 2.2.1 (Timing Adjustable) failure — a keyboard user cannot extend a message they are reading, and `.toast-progress` (`:1810-1828`) is the only visual indication of remaining time.

**Remedy:** Drop `aria-atomic` (per-toast `role="status"`, already set at `public/js/ui.js:387`, is sufficient) and add `focusin`/`focusout` pause handlers mirroring the mouse ones.

### S-19 · P2 · Measured — `--fg3` on `--bg3` fails AA in three themes for 8–11px metadata

**Evidence:** `.notif-item` background is `var(--bg3)` (`:736`) and `.notif-time` is `var(--fg3)` at **9.5px** (`:762`); `.cmd-lib-section-count` is `fg3` at 9px on `--bg3` (`:2133-2136`).

**Measured `--fg3` vs `--bg3`:** catppuccin-latte **3.73**, oled **3.81**, gruvbox **4.15**, monokai 4.56, dracula 4.68, solarized 4.75, tokyonight 4.74, light 4.93, nord-light 6.15.

**Effect:** Below 4.5:1 in Catppuccin Latte, OLED, and Gruvbox. Combined with S-01, these are simultaneously the smallest and lowest-contrast text in the app.

**Remedy:** Lift `--fg3` in those three themes, or reduce the number of distinct steps so one fewer fg level is needed.

### S-24 · P2 · Measured — `docs.html` ships sub-AA terminal output, and its own contrast comment is numerically wrong

**Evidence:** `public/docs.html:88` sets `--code-dim:#565f89` on `--code-bg:#16161e`; `.t-dim { color: var(--code-dim) }` (`:222`) is applied to real content in the terminal mock — `:1032`, `:1034`, `:1040` — at `13.5px/1.75 var(--mono)` (`:221`). **Computed: 2.91:1**, failing WCAG 1.4.3. The file acknowledges the trade-off in a comment at `:281`.

The comment at `:84-87` is also wrong: it states the app's `--fg2`/`--fg3` land at "4.18:1 / 2.76:1 here" and that its replacements clear "5.2:1 / 4.7:1". **Computed:** app `--fg2` `#9aa0c3` on `--bg` `#1a1b26` = **6.67:1**; app `--fg3` `#8b91b8` = **5.57:1**; docs `--mut` `#828bb8` = **5.16:1**; docs `--dim` `#7a84ad` = **4.66:1**. The premise is wrong — the app's own tokens already clear AA — so the reasoning that justified departing from them does not hold. The replacements do still clear AA.

**Remedy:** Lighten `--code-dim` to ≥4.5:1 on `--code-bg` (approximately `#6e78a6`) and rewrite the `:84-87` comment with the real numbers.

### S-25 · P2 · Confirmed defect — `docs.html` undercounts the themes and asserts a contrast guarantee the measurements contradict

**Evidence:** `public/docs.html:786` states "**Six palettes plus System** — every theme is contrast-checked…". Measured: the picker offers **eight** palettes (`public/index.html:694-702`) plus System, so the count is low by two. The "every theme is contrast-checked" claim is contradicted by this audit: `--amber` at 1.63–2.07:1 in all three light themes (S-05), `--fg3` at 3.73–4.15:1 in three themes (S-19), `--bg` on `--accent` for `.btn-primary` at 4.34:1 in Latte and 3.91:1 in Nord Light, and `--bg` on `--green` at 2.96:1 and 3.15:1 for the `.ssh-pill.ok` pattern (`public/docs.html:902`).

**Effect:** A user guide that states a guarantee the app does not meet is worse than one that says nothing — it forecloses the question.

**Remedy:** Change to "Eight palettes plus System", and delete "every theme is contrast-checked" until S-05 and S-19 land, or reword to a claim that can be stood behind.

### S-20 · P3 · Confirmed defect — The service-worker offline fallback is an unstyled one-line page

**Evidence:** `public/sw.js:127-136` returns `'<p style="font-family:sans-serif;padding:16px">Offline — WebTun needs a connection for this page.</p>'` — no `<html>`/`<head>`, no viewport meta, no `prefers-color-scheme`, no `<title>`, no link back to `/` or retry button. It renders UA-default black-on-white.

**Effect:** A bare paragraph on an app whose identity is a carefully themed workspace, with no retry affordance — the one action a user in that state wants.

**Remedy:** Serve a minimal themed document (inline `<style>` with `color-scheme: light dark`, the app's `--bg`/`--fg`, a logo mark, and a reload button) in roughly 15 lines.

### S-21 · P3 · Confirmed defect — CSS matches an inline `style` attribute substring to win a cascade fight

**Evidence:** `public/css/styles.css:2990-2993` — `#select-actions[style*="display: none"], #select-actions[style*="display:none"] { display: none !important; }` — targeting `public/index.html:203`, whose only hiding mechanism is that inline style. No other attribute-substring selector exists in the file.

**Effect:** Breaks silently if JS ever sets `el.style.display` differently, uses the `hidden` attribute, or reformats the inline style.

**Remedy:** Move the hidden state to a CSS-owned class, or drop the rule — the inline `display:none` already wins over the mobile `#select-actions` block, which never sets `display`.

### S-22 · P3 · Design — 13 icon sizes and 6 stroke widths for one 24×24 viewBox set

**Evidence:** All inline SVGs in `public/index.html` share `viewBox="0 0 24 24"`; rendered sizes span 10–32px in **13 distinct values**. Stroke widths: `2` for the large majority, plus `1.5`, `1.6`, `1.8`, `2.2`, `2.4`, `2.5`. Deliberate outliers are the logo's dashed accent circle (`:94`), the thin system-stats gauge (`:134`), and the empty-notification bell (`:625`); the `2.5` `+` glyphs are defensible optical correction. Adjacent buttons in the 28px tab-bar row are 14, 14, 13px (`:309`, `:311-312`, `:314-315`); the 32px sidebar toolbar mixes 12, 12, 13, 13, 13, 13, 13 (`:165-186`). Separately, `public/css/styles.css:2579-2583` overrides `stroke-width` to **1.9** on every mobile-nav icon — the only non-2 value in the system, applied over the SVGs' own `stroke-width="2"`.

**Effect:** A 1px size delta between adjacent icon buttons reads as misalignment at 100% zoom, and the 1.9 nav weight makes the bottom bar look like a different icon family from the header.

**Remedy:** Standardize on 14px for tab-bar/sidebar controls and 16px for header chrome via one `--icon-sm`/`--icon-md` pair, and drop the 1.9 override.

### S-23 · P3 · Design — Three badge implementations and four text-glyph controls inside an SVG icon system

**Evidence:** `#notif-count` (`:634-639`) and `#transfers-count` (`:982`) are byte-identical rules, both `aria-hidden` in markup (`public/index.html:144`, `:125`); `#security-alert-count` has **no CSS rule at all** — it is inline-styled at `public/index.html:106` and is **not** `aria-hidden`; `#mnav-tab-badge` (`:2609-2624`) adds a border and is not `aria-hidden`. Text glyphs used as controls: `#git-branch-add` renders `+` (`public/index.html:213`), the transfers panel close renders `✕` (`:152`), `.toast-x` is sized for `×` (`public/css/styles.css:1495`), and `#mkey-snippets` uses `⚡ Snippets` (`public/index.html:546`). Every other control uses an inline SVG.

**Effect:** `✕` and `+` render at different weights and baselines across OS font stacks next to SVG siblings — visible misalignment in the transfers and Git headers — and the security badge can shift position as its digit count changes.

**Remedy:** Extract one `.count-badge` rule and replace the text glyphs with the same 24-viewBox paths used elsewhere.

### S-26 · P3 · Confirmed defect — `scroll-behavior: smooth` is never neutralized under reduced motion

**Evidence:** `public/css/styles.css:1158` sets `#tab-scroll { scroll-behavior: smooth }` and `public/docs.html:93` sets `html{scroll-behavior:smooth}` for sticky-TOC jumps. Neither page's reduced-motion block touches it — the app's block (`:3091-3095`) sets only `animation-duration`, `transition-duration`, `animation-delay`, and one `backdrop-filter`; the docs block (`public/docs.html:388-391`) sets only animation/transition durations and `.rv` transforms. `scroll-behavior` is unaffected by those properties.

**Effect:** Users who requested reduced motion still get long animated scroll jumps on tab-strip overflow and every docs TOC link.

**Remedy:** Add `html, #tab-scroll { scroll-behavior: auto !important; }` inside both existing reduced-motion blocks.

### S-27 · P3 · Confirmed defect — No `@media (forced-colors: active)` support anywhere

**Evidence:** A search across `public/` for `forced-colors` and `prefers-contrast` returns nothing in `styles.css`, `index.html`, `docs.html`, or any JS file.

**Effect:** In Windows High Contrast every `background: var(--bg*)` is discarded and the app falls back to the system background, while the state system depends almost entirely on backgrounds: `.tab.active`'s inset accent plus glow (`:1125`), `.file-item.selected`'s accent tint plus inset marker (`:1311`), `.file-icon.k-*` type tints (`:1319-1324`), the dirty/bell/exited `::after` dots (`:1144-1149`), `.tx-fill` and `.sys-bar-fill` progress (`:1004`, `:2292`), `.toggle.on` (`:1712`), and the badges (`:3229-3261`). These become invisible or indistinguishable.

**Remedy:** Add a `forced-colors: active` block that re-expresses the critical states (`selected`, `active`, `has-bell`, `is-exited`, `on`) with `outline`/`border` rather than fill; that minimum covers the four state indicators. `forced-color-adjust: none` on the ~20 background-carriers is the fuller fix.

---

## 4. Cross-cutting findings

### X-01 · P2 · Confirmed defect — `.btn-sm` has no CSS rule, so every "small" button renders at 34px

**Evidence:** `--btn-sm: 26px` and `--btn-lg: 36px` are declared (`public/css/styles.css:41`, `:43`) with **zero** consumers; only `--btn-md` is used, once (`:1528`). No `.btn-sm` selector rule exists, yet the class is emitted at `public/index.html:446` (Command Library Export), `public/js/ui.js:292` (notification prefs), and `public/js/misc.js:456` and `:967` (fuzzy finder Clear Search). Those buttons therefore render at the base `.btn` height of 34px (`:1522`).

**Effect:** A 34px Export button in `.cmd-hist-header` (`:2229-2233`) beside a 24px number input (`:2238`) and a ~22px Clear All (`:2246-2247`); a 34px button as the largest element in the finder's empty state (`public/js/misc.js:456`); and a 34px button inflating `.notif-pref-row` (`:691-693`) above its 12px label.

**Remedy:** Add `.btn-sm { height: var(--btn-sm); padding: 0 10px; font-size: 12px; border-radius: var(--radius-sm); }` and `.btn-lg`, and either use or delete `--btn-lg`. This is the concrete evidence behind S-02, and it is a prerequisite for any per-feature size retuning.

### X-02 · P2 · Confirmed defect — Touch target sizing is internally inconsistent and mostly overridden

**Evidence:** `@media (pointer: coarse)` applies at **any** width (`public/css/styles.css:201-207`), so it governs touch tablets at 769px and above. `.icon-btn { 36px }` (`:205`) is defeated by `#header .icon-btn` 32px (`:206`, `:867-872`), `#sidebar-header .icon-btn` 32px (`:1270`), `#sidebar-footer .icon-btn` 32px (`:1363`), `.doc-toolbar .icon-btn` 26px (`:1601`), and `.cmd-lib-header-actions .icon-btn` 26px (`:2034-2037`). Components that are not `.icon-btn` never get the bump: `.notif-btn` 20px (`:765-769`), `.cmd-action-btn` 24px (`:2184-2188`), `.tab-list-close` 22px (`:1174`), `.toast-btn` 22px (`:1801-1805`), `.git-file button` ~18px (`:1914`). `.sidebar-resize-handle` is 12px wide (`:1368-1372`) yet is the only way to resize the sidebar on touch (`public/js/settings.js:627-628`).

**Effect:** On a 769–1023px touch device the explorer toolbar is 32px while the tab close is an oversized *and clipped* 44px (see M-03), the PDF toolbar is 26px, notification actions are 20px, and git row actions are ~18px. The sidebar drag handle is a 12px sliver.

**Remedy:** Replace the ad-hoc `pointer: coarse` block with two shared classes applied by role (`.hit-44` for primary controls, `.hit-sm` for inline row actions), let `#tab-bar` grow on coarse pointers so a 44px close fits, and widen `.sidebar-resize-handle` to 20px there.

### X-03 · P3 · Confirmed defect — Five `var(--fg1)` references resolve to a token that does not exist

**Evidence:** The stylesheet defines `--fg`, `--fg2`, `--fg3` (`:12-14`) and never `--fg1`. Uses: `public/css/styles.css:3154` (`.term-sess-filter-btn:hover { color: var(--fg1) }`); `public/index.html:1017` and `:1058` (inline `color:var(--fg1)` on the Sessions and Ports `<h2>`); `public/js/preview.js:414`; `public/js/tabs.js:1032`.

**Effect:** Only `:3154` is observable: it is the sole hover rule for the session filter chips, and because `color` inherits, an unselected chip gets the `bg3` background while keeping its `var(--fg2)` text (`:3147`) — the hover reads as a flat grey plate. The other four resolve to `inherit`, which coincidentally matches the intended `--fg` (`.modal h2` is already `var(--fg)`, `:1512`), so they are latent bugs that surface the moment an ancestor sets `color`.

**Remedy:** Replace all five with `var(--fg)`, and either declare `--fg1: var(--fg)` as an alias or delete the alias-shaped name so the next author cannot repeat it.

### X-04 · P3 · Confirmed defect — Breadcrumb appearance is decided by JS inline styles that defeat the stylesheet

**Evidence:** `public/js/files.js:840` (POSIX) and `:827` (Windows) emit each ancestor as `<a … style="color:var(--accent);…;height:24px;padding:2px 6px;…">`, while `public/css/styles.css:1299` sets `#path-segments a { color: var(--fg2); padding: 2px 7px !important; height: 26px; … }`. Inline `color` wins over the stylesheet, while the CSS `!important` padding and plain `height`/`display` win over the inline declarations.

**Effect:** The intended hierarchy is inverted: `.path-current` is already accent-tinted (`:1301`), and now every ancestor is accent-colored too, so the current directory and all its parents read identically. The mixed provenance also yields `height:26px` with `padding:7px`, a combination no author wrote.

**Remedy:** Delete the inline `style` attributes from `public/js/files.js:827` and `:840` and let `:1299` own `.path-segments a`; express accent ancestors as a class if wanted.

### X-05 · P3 · Confirmed defect — The path bar scrolls silently, unlike the tab strip

**Evidence:** `#path-segments { overflow-x:auto; scrollbar-width:none; white-space:nowrap }` (`public/css/styles.css:1278-1279`) with **no `mask-image`** and no fade. `public/js/files.js:851` deliberately scrolls the bar to the far **right** (`el.scrollLeft = el.scrollWidth`), pushing ancestors out of view. Contrast `#tab-scroll`, which pairs the same hidden scrollbar with a right-edge fade (`:278`).

**Effect:** In a deep directory the breadcrumb shows only the last two or three segments, with nothing indicating that `/home/user/…` still exists above it and no scrollbar or ellipsis to click. The one affordance a breadcrumb exists to provide is the one thing missing.

**Remedy:** Add `mask-image: linear-gradient(to right, transparent, black 18px)` to `#path-segments`, or collapse the middle segments into an ellipsis chip when the row overflows.

### X-06 · P3 · Risk — Desktop surfaces pay for `backdrop-filter` over near-opaque backgrounds

**Evidence:** `.toast` has a **fully opaque** `background: var(--bg2)` plus `backdrop-filter: blur(10px)` (`:1772`, `:1779`), so the filter contributes nothing and is pure compositing cost. `.notif-panel-header` (`:661-662`) and `.settings-panel-header` (`:783-784`) are `color-mix(… 88%, transparent)` — 12% contribution — and sit on opaque drawers where nothing shows through. `.term-search-bar` is 94% (`:2352-2354`).

**Effect:** None visually; the cost is a full-surface readback plus blur per frame while a panel header or toast is on screen. Needs an FPS trace to quantify, hence a risk.

**Remedy:** Drop the blur from `.toast` entirely, and raise the panel headers to 100% or drop their blur.

### X-07 · P3 · Confirmed defect — Split and duplicated rules plus dead selectors make state styling unpredictable

**Evidence:** `#conn-status` is declared twice (`:1029-1041` and `:1111`, the second replacing `transition` and adding `margin-left`); `#ssh-toggle.ssh-off` twice (`:880`, `:1257`); `#sidebar-header` twice (`:1265` sets `min-height: var(--tab-h); flex-shrink:0`, then `:1266` sets `flex-wrap: wrap; height: auto` — the split is what makes D-02's wrap possible and is invisible to a reader of `:1265`). `#tab-list-count` has a full rule (`:1156-1157`) and **no element**: `public/js/tabs.js:301` guards with `if (count)` and `public/index.html` contains no such id (only the working `#tab-list-title-count` at `:326`), so the `.tab-nav-btn { position:relative }` at `:1154` exists solely to host a badge that can never appear. `:3070` `#settings-panel { top: 0 }` is a no-op because `:2773` already sets it. `--btn-sm`/`--btn-lg` are unreferenced (X-01).

**Effect:** Indirect but compounding: each is a place where a future change lands in one half of a pair and silently does nothing.

**Remedy:** Merge each duplicated pair into the earlier block preserving the later declarations, delete `#tab-list-count` and the `.tab-nav-btn` positioning, drop the no-op landscape `top`, and use or delete the dead tokens. Fold into S-04's consolidation pass.

---

## 5. Theme and motion audit checklist

Each row is a distinct code path, so a single palette edit will not fix all of them. Figures marked ✓ are already measured in this report.

| # | Verify | Where | Known failure |
| --- | --- | --- | --- |
| 1 | `--amber` as text (11px) | `:487`, `:1589` | ✓ light 2.06, latte 1.91, nord-light 2.07 |
| 2 | `--amber` as indicator (dot, underline, border) | `:480`, `:1140`, `:1146`, `:1147` | ✓ 1.63–2.07 in 3 light themes |
| 3 | `--amber` on the security-alert triangle | `public/index.html:104` | ✓ 1.87 on `--bg2` |
| 4 | `--fg3` text on `--bg3` (9–9.5px) | `:762`, `:2133` | ✓ latte 3.73, oled 3.81, gruvbox 4.15 |
| 5 | `--fg3` text on `--bg2` (10px sidebar meta) | `:1331`, `:1883` | oled 4.12, latte 4.06 — below 4.5 |
| 6 | `--bg` on `--accent` — `.btn-primary`, active chips, latched keys | `:1529`, `:730`, `:2106`, `:1438` | ✓ latte 4.34, nord-light 3.91 |
| 7 | `#fff` on `--red` — `.btn-danger`, `.ssh-pill.bad` | `:1533`, `:904` | tokyonight 2.65, dracula 3.14, gruvbox 3.44 |
| 8 | `--bg` on `--red` (the alternative to #7) | `:1533` | gruvbox 4.29 — no single replacement works for all themes; needs a per-theme `--on-danger` |
| 9 | `--bg` on `--green` — `.ssh-pill.ok` | `:902` | ✓ latte 2.96, nord-light 3.15 |
| 10 | `--bg` on `--yellow` — `.ssh-pill.warn` | `:903` | ✓ latte 2.31, nord-light 3.04 |
| 11 | `#fff` on `--accent` — reconnect banner | `public/index.html:156` | hard-coded; compute per theme |
| 12 | `--border` on `--bg3` — every input border (needs 3:1) | `:157` | all 9 themes 1.20–1.49 |
| 13 | `--border` on `--bg`/`--bg2` — panel boundaries | `:1508`, `:1810` | all 9 themes 1.41–1.94; decide decorative vs state-conveying |
| 14 | `--bg4` on `--bg2` — `.mm-item` focus, `.btn:hover` | `:1103`, `:1532` | ✓ all 9 themes 1.21–1.48 (S-09) |
| 15 | Tokyo-Night hard-codes in tab tags and swatches | `:1133-1138`, `:1169-1171`, `:1231-1236` | used in all 9 themes |
| 16 | `#60a5fa` in `.badge-ext` | `:3234` | hard-coded blue |
| 17 | `rgba(255,255,255,…)` mobile key fills | `:2675-2678`, `:2714-2716` | light-theme override exists at `:2683-2688`; latte and nord-light do not (M-10) |
| 18 | `--fg2`/`--fg3` over the launchpad aura (11% accent radial) | `:349`, `:1555` | aura becomes invisible in low-contrast themes |
| 19 | Docs `--code-dim` on `--code-bg` | `public/docs.html:88`, `:222` | ✓ 2.91 (S-24) |
| 20 | Docs `--line`/`--line2` on `--bg0` | `public/docs.html:65-66`, `:86` | all decorative; confirm none convey state |

**Rule of thumb:** in the three light themes *every* `--amber` value fails, and in Latte/Nord Light every `color: var(--bg)` on a saturated fill fails. Those are the two systemic failures; the rest are per-theme single-line edits.

### Motion inventory

29 `@keyframes` blocks, 17 `infinite` animation declarations. Under `prefers-reduced-motion` all become 0.01ms rather than stopping (S-07), so decide each before fixing that rule.

| Animation | Line | Trigger | Verdict |
| --- | --- | --- | --- |
| `pinAura` 8s | `:349` | launchpad visible | decorative — stop |
| `pinAura` 7s | `:1555` | PIN/offline screen | decorative — stop |
| `lpBlink` 2.4s | `:378` | launchpad pulse dot | decorative — make static |
| `tabPulse` 1.4s | `:1145` | per tab, unbounded | cap the pulse count |
| `tabPulse` 0.9s | `:1146` | per tab | cap |
| `statusPulse` 2.5s | `:2440` | mobile, whenever connected | decorative for a *connected* state — stop |
| `steamRise` / `awakeGlow` | `:956` / `:955` | keep-awake on | decorative — make static |
| `secAlertPulse` 1.6s | `:967` | unreviewed login | **keep** — the rare genuine interruption |

**Progress/state — keep:** `reconnectSpin` (`:295`, `:331`, `:1113`, `:1542`), `hdrSpin` (`:1274`), `fileListProgress` (`:1291`), `skShimmer` (`:1351`), `txSlide`/`txStripes`/`txUp`/`txDown`/`txPkt*` (`:972-977`, `:1008`, `:1014`), `sysHotBlink` (`:2299`).

**One-shot entrances — the S-03 item:** `lpIn` ×11 with delays to `.50s` (`:355-366`), `lpDraw` (`:368-370`), `pinIn` (`:1558`), `secIn` ×7 with delays to `.21s` (`:1694-1702`, and see D-17), `fadeIn`/`slideIn`/`toastSlideIn`/`termSearchSlide`/`sheetSlideUp`.

**Event-driven — the model to keep:** `bellFlash` 0.15s (`:399`), `pinShake` 0.4s (`:1560`), `toastProgress` (`:1810-1828`).

**Gaps to close in the same pass:** reduced motion does not gate the launchpad idle screensaver (`public/js/launchpad.js:45-58`); `body.datasaver` is only ever set from `public/js/transfers.js:105`, so every motion-suppression rule at `public/css/styles.css:1024` is dead until a transfer panel has rendered once — move the toggle into the settings handler (`public/js/settings.js:110-121`); and under reduced motion `.toast-progress` loses its countdown, leaving hover-pause nothing to pause.

---

## 6. Fix design for M-00 — **implemented, pending device verification**

This design was applied in `public/js/terminal.js` and `public/css/styles.css`. The code samples below are the *intended* design; the shipped implementation adds the M-17/M-19/M-20/M-23/M-24/M-25/M-26 guards and the breakpoint reconciliation listed in §0. Device verification is still outstanding.

**Invariants:** exactly one layout owner receives the keyboard inset; zero inset when the browser already resized; the key bar stays docked above the keyboard on overlay browsers and consumes no clearance on resize browsers; the terminal never drops below a usable height.

**Step 1 — detection (replaces `public/js/terminal.js:2024`).** Use M-16's `overlap` rule everywhere `covered` was used; delete `diff`/`absDiff`/`isKeyboard` (`:2016-2025`). Guard with `overlap > 60` rather than `absDiff > 80`, which also ignores URL-bar chrome collapse.

**Step 2 — guards (before `:2036`).** Add `if (window.innerWidth > 768) return;` (fixes M-25) and drop the `active.closest('.xterm')` clause. Keep `INPUT`/`TEXTAREA`/`contentEditable` and the xterm helper textarea, and split the terminal-specific behavior per M-18.

**Step 3 — single owner (replaces `:2039-2041` and the mirrored clears at `:2056-2058`, `:2171-2176`).**

```js
const cap = Math.max(0, splitArea.clientHeight - 96);   // ~4-5 rows; replaces the 60% clamp
const inset  = Math.min(overlap + keysOffset, cap);
const dockAt = Math.min(overlap, cap);

splitArea.style.marginBottom  = inset + 'px';   // the ONLY owner
terminals.style.marginBottom  = '';              // delete (fixes M-00)
editorView.style.marginBottom = '';              // delete (fixes M-15)
```

`#editor-split-area` is the correct owner because it is `position:relative` (`public/css/styles.css:515`) and the containing block of the mobile `#editor-view.open` overlay, so one margin both shrinks `#terminals` and lifts the editor overlay. Using `#content` instead would **not** lift the overlay, since a parent's `padding-bottom` does not inset an abspos `inset:0` child's box.

Resulting geometry on a 390×844 phone with a 336px keyboard and 44px key bar: `splitArea` 764 → inset 380 → **terminal 384px**, key bar `bottom: 336px`. On a genuinely-resizing browser: `overlap` 0 → inset 44 (fixed-bar clearance only) → the terminal keeps everything the browser gave it.

**Step 4 — dock (keep `:2043-2047` mechanics, new value).** `mobileKeys.style.bottom = dockAt + 'px'`, plus `env(safe-area-inset-bottom, 0px)` only if M-27's device check is positive.

**Step 5 — refit (replace `:2078-2096`).** One `clearTimeout(_fitTimer)` and one scheduled `refitAll()` mirroring `public/js/terminal.js:790-792`, refreshing CodeMirror once. The `ResizeObserver` at `:787-796` already covers the inset-driven change; the timer is only needed for dock/undock.

**Step 6 — two one-line robustness edits.** Reset `_viewportHandlerInstalled = false` inside the cleanup at `:2101-2104` (M-17), and gate the force-show at `:2146-2147` on the same predicate as `:2038`/`:2043` (M-20).

**Rejected alternatives.** `interactive-widget=resizes-content` in `public/index.html:5` fixes Chrome Android only and does nothing on iOS — the inset must still be measured. Replacing `100dvh` with a JS-driven `--vh` creates a second owner of the bottom edge and still needs the same detection rule. Keeping the margin on `#terminals` and dropping it on the split area leaves the mobile editor overlay undisplaced (M-15).

---

## 7. Recommended implementation sequence

Steps 1–4 are implemented (§0); the rest remain open.

1. ✅ **Restore mobile typing visibility.** Single-owner inset with `keyboardOverlap()` detection, boot-time arming, and the M-17/M-19/M-20/M-23/M-24/M-25/M-26 guards. **Device verification outstanding.**
2. ✅ **Fix the desktop blockers.** D-07 toolbar density, D-09 overflow menu, D-08 stacking.
3. ✅ **Fix deterministic CSS defects.** D-02 + D-03 (inline styles stripped, then icon density), D-06, S-11, M-02, M-13, M-08/S-15, D-17, X-01, X-07.
4. ✅ **Accessibility pass.** S-08, S-09, S-10, S-16, S-17. (S-27 forced-colors still open.)
5. **Measure on device.** Run the §6/§1a console dump on the affected phone and assert `termH >= 96` across the matrix. This is the gate on calling M-00 closed.
6. **Make the working session the visual default.** D-01's shrink contract (D-13), M-01 and M-05/M-06. Preserve the desktop-aligned mobile tab chrome required by the mobile UI guidance in `AGENTS.md`.
7. **Unify the look.** S-01 (collapse 23 sizes to ~7), S-02's remaining per-feature retune now that `.btn-sm` exists, S-03's motion budget, then the rest of the S-04 consolidation (tab-bar inline styles, `!important` blocks) with X-04, X-05, X-06.
8. **Finish the key-bar reconciler.** M-21's single `applyMobileKeyBarState()` replaces the remaining inline `style.display` writers, then M-18 (split `keyboardInset` from `terminalKeyboard`, drop the docked bar below `--z-overlay`) and M-27 (safe-area insets, device-gated).
9. **Sidebar integrity.** D-10 (inline width beats the tablet query), D-11 (file list reaches zero height), D-12 (git header clips at 200px).
10. **Remaining polish.** D-14, D-15, D-16, X-02; S-06's shape unification, S-12 (theme-color/OLED), S-19, S-20 through S-23, S-24, S-25, S-27.

**Validation states for every remaining step.** Desktop at a wide and ~800px viewport; mobile at 320px and ~390px, portrait and landscape; one and several tabs; file/editor tabs open; sidebar and Command Library open; keyboard shown and hidden; selection/Ctrl rows toggled; all 8 selectable themes. Compare actual terminal canvas height, control target sizes, clipping, stacking order, and toast placement.

**Documentation obligation.** Steps 6–10 change user-visible behaviour and appearance. Per the `AGENTS.md` rule, `/docs` (`public/docs.html`) must be updated in the same change as any user-facing feature or change — S-24 and S-25 are the known documentation inaccuracies to correct at the same time.

Findings labelled **Reported**, **Risk**, or **Design judgment** remain open questions rather than confirmed failures; everything marked confirmed was verified against source, and every implemented change was syntax- and asset-served-checked but **not** visually verified.
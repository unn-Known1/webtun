# Tiles Mode — Findings Report

Date: 2026-10-31
Scope: WebTun Tiles Mode (tile grid, tile headers, zoom, file/preview tabs in tiles,
resize handling, related CSS). Codebase state: post-v2.0.5-remediation tree.
Status: findings only — no fixes applied yet.

Sources: [public/js/tabs.js](public/js/tabs.js) (toggle/layout/zoom),
[public/js/file-tabs.js](public/js/file-tabs.js) (file tab mounting),
[public/js/preview.js](public/js/preview.js) (preview tabs),
[public/js/terminal.js](public/js/terminal.js) (fit/resize),
[public/js/editor-panel.js](public/js/editor-panel.js) (shared read path),
[public/css/styles.css](public/css/styles.css) (grid + header styles).

## 1. How tiles mode works today

- `#terminals.tiles-mode` switches the terminal area to a CSS grid:
  `repeat(auto-fit, minmax(min(300px, 100%), 1fr))`, `grid-auto-rows: 1fr`,
  all `.term-wrapper` elements shown at once ([styles.css](public/css/styles.css#L498)).
- `layoutTiles()` ([tabs.js](public/js/tabs.js#L1507)) prepends a 24px
  `.term-tile-header` (status dot + name + ⤢ zoom + × close) to every tab wrapper,
  mounts all unmounted **text** file tabs, and refits terminals + CodeMirror views.
- `toggleTileZoom(id)` ([tabs.js](public/js/tabs.js#L1483)) adds `.tile-zoomed` to one
  wrapper and `has-tile-zoom` to the container, which hides every other tile via CSS.
- Text file tabs mount live editors in tiles; heavy viewers (PDF/EPUB/Office) stay
  single-live behind a parked card; image tabs render their own `<img>` once mounted.
- Entry points: More menu → Tiles Mode, tab-bar `+` context menu → Tile View.
  No keyboard shortcut, no persistence across reload.

## 2. Bugs (misbehaves today)

### B1. Closing the zoomed tile blanks the whole grid — High
`closeTab` removes the wrapper and calls `layoutTiles()`, but nothing clears
`has-tile-zoom`. Every remaining tile then matches
`.term-wrapper:not(.tile-zoomed) { display: none }`, so the grid renders empty until
tiles mode is toggled off and on. Same hole via `abandonFileTab`.
Triggers: tile ×, strip ×, Ctrl+W, swipe, context menu, bulk close.
Refs: [tabs.js](public/js/tabs.js#L1413-L1453),
[file-tabs.js](public/js/file-tabs.js#L1009-L1022),
[styles.css](public/css/styles.css#L4165).
Repro: enter tiles → zoom any tile → close that tile → blank grid.
Fix direction: reconcile zoom state on tab add/remove (clear `has-tile-zoom` when the
zoomed wrapper is gone), ideally in one helper used by all close paths.

### B2. Preview/file tabs created in tiles mode get no tile header — High
Only `newTab` calls `layoutTiles()` after creation. `newPreviewTab` and
`newFileTab`/`openFileAsTab` do not, so tiles created while in tiles mode have no
title bar, zoom, or close button until the next close/toggle. Also affects Duplicate,
reopen (`Ctrl+Shift+T`), and Open-in-Tab.
Refs: [tabs.js](public/js/tabs.js#L923) (has it),
[preview.js](public/js/preview.js#L242-L262) (missing),
[file-tabs.js](public/js/file-tabs.js#L81-L104) (missing).
Repro: enter tiles → open a preview or file tab → headerless tile.
Fix direction: call `layoutTiles()` (or a header-ensure helper) from all three
creation paths.

### B3. New/activated tab while zoomed is invisible — Medium-High
New wrappers lack `.tile-zoomed`, so they are hidden by the zoom CSS — the active tab
is invisible. Likewise, activating any other tab via strip/switcher/sessions browser
while zoomed leaves the active tab hidden with no auto-unzoom.
Refs: [tabs.js](public/js/tabs.js#L1483-L1505).
Repro: zoom a tile → `+` new terminal → nothing appears (tab exists in strip).
Fix direction: auto-unzoom on tab creation and on `activateTab` to a non-zoomed tab.

### B4. Status dot is always gray — Medium
JS toggles `disconnected`/`dirty` classes, but CSS only defines `.tth-dot.connected`
— which JS never adds. Both toggled classes have no rules, so the documented "live
connection dot" never changes color.
Refs: [tabs.js](public/js/tabs.js#L1516-L1529),
[styles.css](public/css/styles.css#L4141-L4150).
Fix direction: align class names (add `.disconnected`/`.dirty` rules, or emit
`.connected`), and decide the dot priority (disconnected > dirty > connected).

### B5. Entering tiles prompts for background tabs — with destructive outcomes — Medium-High
`layoutTiles` mounts every unmounted text tab, and the shared `readTextForEditor`
path raises `confirmDialog`s meant for an explicit user open. Three bad outcomes
(`confirmDialog` queues, so N background prompts appear one after another):
- **Draft-restore prompt can destroy a draft.** A parked tab with a differing draft
  pops "Unsaved draft found"; clicking "Discard draft" runs `removeDraft` — the
  crash-safety draft is deleted for a file the user never asked to open.
- **Large-file decline deletes the tab.** Declining the "Large file" prompt returns
  `null` → `abandonFileTab` removes the tab entirely, with no toast and no parked
  card left behind.
- **Read error deletes the tab.** A failed/transient read toasts, then also funnels
  into `abandonFileTab` — the tab vanishes on tile entry instead of showing an error
  card with retry.
Refs: [tabs.js](public/js/tabs.js#L1583-L1590),
[editor-panel.js](public/js/editor-panel.js#L182-L221),
[file-tabs.js](public/js/file-tabs.js#L254-L266), [file-tabs.js](public/js/file-tabs.js#L1009-L1022),
[ui.js](public/js/ui.js#L198-L205) (dialog queue).
Repro: park a text tab with a differing draft (or a huge/unreadable file) without
opening it → enter tiles → unexpected modal(s); dismiss destructively → draft lost
or tab gone.
Fix direction: suppress/defer prompts during background tile mounts (mount with disk
content, flag the tile for review), and never abandon on tile-entry mount failure —
show an error card with retry.

### B6. Tile headers go stale — Medium
Name/dot refresh only happens inside `layoutTiles` (toggle / new *terminal* / close /
abandon). Tab rename, dirty flag, pin/color, WS connect/disconnect/reconnect, and
exit state never refresh headers. Only `.tth-name` text is updated on re-layout, so
header/zoom/close `aria-label`s rot after rename too.
Refs: [tabs.js](public/js/tabs.js#L712-L724) (rename),
[file-tabs.js](public/js/file-tabs.js#L908-L916) (dirty),
[tabs.js](public/js/tabs.js#L18-L28) (pin/color strip-only).
Fix direction: central `refreshTileHeader(tab)` called from rename, dirty paint,
`applyTabMeta`, and WS state transitions.

### B7. Tile order diverges from tab order after reorder — Medium
Bar DnD (before/after + move-to-end) and pin regrouping only move the strip button
(`tab.el`); wrappers never move, and the grid follows wrapper DOM order.
Refs: [tabs.js](public/js/tabs.js#L55), [tabs.js](public/js/tabs.js#L660-L663),
`moveTabToEnd`.
Repro: enter tiles → drag a tab to a new strip position → tile stays put.
Note: the divergence self-heals on reload (wrappers are recreated in saved tab
order), so it only affects the live session.
Fix direction: reorder wrappers in `#terminals` alongside strip buttons.

### B8. File tiles mis-size on resize / exit-tiles / zoom — Medium
- The `ResizeObserver` handler refits terminals only — no `cm.refresh`, no
  docked-editor refresh — so window/sidebar resizes leave CodeMirror tiles
  wrong-sized until the next tab switch.
- The exit-tiles path refits terminals only; the active file tab keeps tile geometry.
- `toggleTileZoom`'s refit skips the shared docked editor that `layoutTiles`' own
  `refitAll` handles, so zooming a heavy-doc tile mis-sizes it.
Refs: [terminal.js](public/js/terminal.js#L849-L857),
[tabs.js](public/js/tabs.js#L1472-L1480), [tabs.js](public/js/tabs.js#L1502-L1504).
Fix direction: one shared `refitTiles()` (terms + per-tab CM + docked editor) used by
all three paths, plus CM refresh on window resize while in tiles.

### B9. Image tabs don't auto-mount in tiles — Low-Medium
The tile-entry filter is `viewer === 'text'` only, so cheap stay-live image tabs each
need a manual Open click while code files mount themselves.
Refs: [file-tabs.js](public/js/file-tabs.js#L204-L234),
[tabs.js](public/js/tabs.js#L1584-L1585).
Fix direction: include `viewer === 'image'` in the tile-entry mount filter.

### B10. Zoom button has no active visual — Low
JS toggles `.active` on `.tth-zoom`, but CSS defines only base + `:hover` — the
zoomed tile's ⤢ looks identical to the rest.
Refs: [tabs.js](public/js/tabs.js#L1489-L1492),
[styles.css](public/css/styles.css#L4151-L4164).
Fix direction: add a `.tth-zoom.active` rule.

## 3. Gaps (missing / weak, not strictly broken)

### G1. Grid squishes with many tabs
`grid-auto-rows: 1fr` + `min-height: 150px` yields tiles of 24px header + ~6 terminal
rows. Needs a usable row minimum (`minmax(220px, 1fr)` or similar) so extra tiles
scroll instead of compressing into unusability.
Ref: [styles.css](public/css/styles.css#L498-L499).

### G2. Preview toolbar eats small tiles
`.preview-bar` wraps its ~10 controls over multiple rows with no tiles-mode compact
override — unlike `.fte-bar`, which has one.
Ref: [styles.css](public/css/styles.css#L392) vs
[styles.css](public/css/styles.css#L599-L600).

### G3. No pin/color/activity/bell/exit in headers
All strip-only; headers carry just the (currently broken, B4) dot. A noisy or exited
background tile is invisible from the grid itself.

### G4. Mouse click doesn't focus
Header click activates only; keyboard Enter activates *and* focuses. Mouse users click
twice to type. Zoom restore also doesn't focus.
Ref: [tabs.js](public/js/tabs.js#L1554-L1562).

### G5. Resize storm
N observers × refit-all = N² `fitTerm` calls (each doing `getComputedStyle` + math)
per layout event, with no debounce. WS traffic is bounded — xterm's `onResize` fires
only on actual dimension change — but every toggle/resize still fans out N² fits,
plus one WS resize per tile whose size really changed.
Refs: [terminal.js](public/js/terminal.js#L849-L857),
[terminal.js](public/js/terminal.js#L593-L596).

### G6. Mount storm + no release
Entering tiles mounts up to 10 CodeMirrors concurrently (jank on slow files/mode
loads); exiting never releases them (P-025 lazy release runs only on switch in
normal mode), so memory stays high after leaving tiles.

### G7. Keyboard/a11y
No toggle shortcut; no arrow-key tile nav; 3 tab stops per tile (30 stops for 10
tiles, duplicating the strip); `.tth-zoom` lacks the `:focus-visible` style that
close/name have; dblclick-zoom works only on the name, not the header.

### G8. Touch targets
24px header, 16px close button — under mobile guidance; no tiled-header sizing in the
mobile breakpoint.

### G9. No empty/single-tab state
Toggling with 0–1 tabs shows a degenerate grid with no hint (a toast + no-op for a
single tab would do).

### G10. `tilesMode` isn't persisted
Reload always exits tiles; zoom target isn't remembered either.

## 4. Improvement suggestions

Beyond fixing the above, the highest-value enhancements, grouped by theme:

**Layout control (biggest UX win; builds on G1)**
- Column picker: `Auto / 1 / 2 / 3 / 4` in the More menu or a small tiles toolbar —
  `auto-fit` is unpredictable with 3–5 tabs.
- Layout presets: Grid (today), Columns (horizontal strip), Rows (vertical stack),
  Main+side (one wide + rest narrow — ideal for log-watch + edit).
- Smart degenerate cases: 1 tab → toast + no-op (G9); 2 tabs → default 50/50.
- Optional, larger: draggable splitters between tiles (column picker covers 80%).

**Navigation and focus (builds on G4, G7, G10)**
- Toggle shortcut (e.g. `Alt+G`, after checking conflicts) shown on the menu item.
- Arrow-key tile navigation + number badges matching the existing `Alt+1..9` jumps.
- Click-to-focus on header click and zoom restore (G4).
- `Esc` un-zooms a maximized tile.
- Persist `tilesMode` (+ zoomed id) in tab state/storage (G10).

**Tile headers (builds on B4, B6, G3)**
- Mirror strip badges: activity (green), bell (amber), exited (red/dim), pin marker,
  color tag.
- Type icon (term / file / preview); preview tiles show path/port + reload (G2).
- Per-tile ⋯ menu: Rename, Restart session, Clear buffer, Close others.

**Tile management (builds on B7)**
- Drag-to-reorder tiles directly, syncing back to the tab bar.
- Per-tile broadcast exclude (Broadcast Input is currently all-or-nothing).
- Dim inactive tiles slightly so the focused shell is obvious at a glance.

**Viewers and performance (builds on G2, G5, G6)**
- Compact parked cards for heavy docs (a full tile per parked PDF wastes space), or
  let the tile's Open button steal the single live viewer without leaving tiles.
- Lazy-mount editors for visible tiles only (`IntersectionObserver`), mount the rest
  on scroll (G6).
- Debounce resize handling; refit only the affected wrapper plus one follow-up pass
  (G5, B8).
- Merge file-tile chrome: tile header (24px) + `fte-bar` (30px) = 54px per tile.

**Mobile / touch (builds on G8)**
- 32–36px header with ≥28px hit targets under the mobile breakpoint.
- Force 1 column with vertical scroll (or snap-scroll carousel) on narrow screens.

## 5. Suggested fix order

1. **B1 + B2 + B3** — zoom lifecycle + header creation (one coherent fix: reconcile
   zoom on tab add/remove/activate; ensure headers from all creation paths).
2. **B4 + B6** — dot CSS + central `refreshTileHeader(tab)` wired into rename, dirty
   paint, `applyTabMeta`, and WS state transitions.
3. **B5** — prompt-free background mounts during tile entry; error card + retry
   instead of abandon.
4. **B7 + B8** — wrapper reorder alongside strip reorder; shared `refitTiles()`.
5. **B9 + B10 + G1 + G2** — image auto-mount, zoom active style, row minimum,
   preview-bar compact mode.
6. **Enhancements** — column picker first, then shortcut + Esc-unzoom +
   click-to-focus, then header badges.

# WebTun — Frontend UI/UX Bug Report

**Date:** 2025-06-11
**File:** `public/index.html` (single-file frontend)

---

## 1. Accessibility (a11y)

### 1.1 Missing `aria-label` on multiple icon buttons (Medium)
Several header icon buttons lack `aria-label`, making them invisible to screen readers.

- `index.html:778` — System Stats button: no `aria-label`
- `index.html:781` — Tiles Mode button: no `aria-label`
- `index.html:893` — Editor split toggle: no `aria-label`
- `index.html:887` — Close editor button: no `aria-label`
- Sidebar back/forward/up/refresh buttons (`index.html:796-811`): none have `aria-label`

### 1.2 Context menu items have no `role="menuitem"` (Low)
`#ctx-menu` (`index.html:1067-1085`) uses `<div class="ctx-item">` instead of proper `role="menu"` / `role="menuitem"` semantics. Screen readers won't announce this as a menu.

### 1.3 Toggle switches not keyboard accessible (Medium)
`.toggle` elements (`index.html:553-561`) are `<div>` with `onclick` — no `tabindex`, no `role="switch"`, no `aria-checked`. Keyboard users cannot operate settings toggles.

### 1.4 Settings panel has no focus trap (High)
When `#settings-panel` opens (`index.html:264-275`), keyboard focus is not trapped inside it. Tab can escape to background elements behind the panel. Modals (`openOverlay`) also lack a focus trap — focus can leave the modal via Tab.

### 1.5 Error messages not announced to screen readers (Medium)
`#pin-error` (`index.html:476`) and toast notifications (`index.html:577-584`) lack `aria-live` or `role="alert"`. Screen readers won't announce errors or status updates. Only `#toast-container` has `aria-live="polite"` but individual toasts don't have `role="status"`.

### 1.6 Form inputs missing labels (Medium)
- PIN input (`index.html:750`): has `placeholder` but no `<label>` or `aria-label`
- Rename, New Folder, New File modal inputs (`index.html:1150, 1165, 1180`): have visual labels but no `for`/`id` association
- Path input (`index.html:805`): no `aria-label`

### 1.7 File list items missing accessible names (Low)
File items (`index.html:2206-2207`) have `role="option"` and `aria-selected` but no `aria-label` — the accessible name comes from text content which is fine, but `role="option"` implies a listbox which `#file-list` isn't set up as (it's `role="listbox"` on the wrapper but items are direct children, which works).

---

## 2. Contrast & Color Issues

### 2.1 Light theme secondary text contrast too low (High)
`--fg2: #4a4a6a` in light theme (`index.html:80`) on `--bg: #f9f9fb` background yields ~3.8:1 contrast ratio — below the WCAG 4.5:1 minimum for normal text. Used extensively for labels, breadcrumbs, file sizes, and status text.

### 2.2 Keep-awake toggle dot low contrast (Medium)
`.keep-awake-dot` uses `background: var(--fg2)` on `background: var(--bg2)` (`index.html:304`). In light mode: `#4a4a6a` on `#eeeef2` — ~3.2:1 ratio. Hard to see.

### 2.3 Tab close button invisible until hover (Low)
`.tab-close` has `opacity: 0.5` (`index.html:326`), making the close icon hard to discover. On mobile (no hover), it stays at 0.5 opacity — users may not realize tabs can be closed.

### 2.4 Reconnect banner text contrast (Medium)
`#reconnect-banner` (`index.html:789`) uses `color: #fff` on `background: var(--accent)` — fine in most themes, but the warning emoji `⚠️` is redundant with color and may be the only indicator for color-blind users.

---

## 3. Touch & Mobile Issues

### 3.1 File action buttons too small on mobile (High)
`.file-action-btn` is 20x20px (`index.html:355`). Even with the `@media (pointer: coarse)` override at 36x36px (`index.html:138`), the icons inside are 11px font-size — still small. Apple recommends 44x44pt minimum.

### 3.2 Tab bar horizontal scroll lacks visual affordance (Medium)
`#tab-bar` (`index.html:161`) has `overflow-x: auto` but no gradient fade or scroll indicator. Users may not realize there are more tabs off-screen. The scrollbar is 3px tall (`index.html:163`) — nearly invisible.

### 3.3 Sidebar swipe gesture conflicts with scrolling (Medium)
`setupSwipeGestures` (`index.html:4030-4061`) listens on the document for touchmove. Swiping left on the sidebar area can accidentally close it, and swiping right from the edge opens it — this can conflict with system gestures and in-app scrolling.

### 3.4 Pull-to-refresh threshold too high (Low)
Pull-to-refresh (`index.html:4084-4087`) requires `pullOffset > 80` to trigger, but the visual transform caps at `Math.min(dy * 0.4, 60)`px. Users see 60px of movement but need 80px of pull distance — feels unresponsive because the visual feedback doesn't match the trigger threshold.

### 3.5 Pinch-to-zoom uses wrong variable (Bug)
`index.html:1901`: `fontSize` is referenced but never declared — should be `settings.fontSize` or `curSize`. This will cause a ReferenceError on pinch-to-zoom on mobile.

```js
const newSize = Math.max(10, Math.min(28, fontSize + (delta > 0 ? 1 : -1)));
//                                      ^^^^^^^^ — undeclared variable
```

### 3.6 Mobile keyboard bar overlap with content (Medium)
When the soft keyboard opens on mobile, `setupVisualViewport` (`index.html:3851-3883`) hides mobile keys by setting `display: none` but doesn't restore the selection row or ctrl row state correctly — it hardcodes `display: none` for them even when they were visible.

---

## 4. Interaction & UX Bugs

### 4.1 `manualReconnect` references undefined `banner` (Bug)
`index.html:1745`: `banner` variable is never declared — should be `document.getElementById('reconnect-banner')`. This will throw a ReferenceError when the user clicks the manual reconnect button.

### 4.2 Overlay click-outside handling inconsistent (Medium)
`index.html:4000-4007`: Clicking overlay background closes the overlay by removing `.open` class, but the `conflict-overlay` is closed via `closeOverlay()` which also restores focus. The background-click path doesn't call `closeOverlay()`, so focus isn't restored for conflict, rename, new folder, and new file modals.

### 4.3 Context menu doesn't close on Escape (Medium)
`setupKeyboardShortcuts` (`index.html:3629-3639`) handles Escape for search, settings, and overlays, but doesn't close `#ctx-menu`. Users must click elsewhere to dismiss it.

### 4.4 Settings panel close-on-outside-click uses capturing phase (Low)
`closeSettingsOnClickOutside` (`index.html:3179-3185`) is registered with `{ capture: true }` (`index.html:3172`). This fires before most click handlers, potentially interfering with other UI interactions when settings is open.

### 4.5 File watcher reloads files every 10s even when idle (Low)
`startFileWatcher` (`index.html:2268-2290`) polls `/api/files` every 10 seconds via `setInterval`. This creates unnecessary network traffic and server load, especially with large directories. No debouncing or diffing is done — the entire file list DOM is rebuilt each time.

### 4.6 Editor split orientation icon doesn't match initial state (Low)
On first open, `toggleEditorSplit` (`index.html:3518`) checks `localStorage` for saved orientation. If no saved value exists, the icon shows horizontal-split (line divider) but the actual layout is vertical — the icon and state are inverted until the user clicks toggle.

---

## 5. Layout & Responsiveness

### 5.1 Sidebar hidden state inconsistent between mobile and desktop (Medium)
`#sidebar.hidden` on desktop sets `width: 0 !important` (`index.html:159`), but on mobile (`max-width: 768px`) it sets `transform: translateX(-100%)` and `width: var(--sidebar-w)` (`index.html:696`). The `.hidden` class semantics differ by breakpoint — confusing for maintainers and can cause layout glitches during resize.

### 5.2 Settings panel z-index below modals but above sidebar (Low)
`#settings-panel` has `z-index: 15` (`index.html:271`), but `.overlay` has `z-index: 400` (`index.html:438`). If settings is open and a modal opens, settings becomes unreachable behind the modal backdrop but isn't closed.

### 5.3 Editor max-height calculation may be wrong (Low)
`index.html:211`: `max-height: calc(100vh - var(--header-h) - var(--tab-h) - 80px - 5px)` uses `100vh` instead of `100dvh`. On mobile browsers with dynamic toolbars, this can cause the editor to overflow.

### 5.4 Toast container bottom position doesn't account for install banner (Low)
`#toast-container` (`index.html:577`) has a fixed bottom position. When `#install-banner` is visible (z-index 500, fixed bottom), toasts can overlap with the banner.

---

## 6. Missing Features / Polish

### 6.1 No loading state for file operations (Low)
Copy, move, zip, extract operations show no loading indicator. The user clicks "Copy" and waits with no feedback until the toast appears.

### 6.2 No undo for destructive actions (Low)
Delete operations (`deleteFile`, `deleteSelected`) have no undo mechanism. Once confirmed, files are permanently removed.

### 6.3 Fuzzy finder has no scroll-into-view for keyboard navigation (Low)
`finderKeydown` (`index.html:4267-4273`) updates `finderIdx` and toggles `.selected` class, but doesn't call `scrollIntoView()` on the selected item. If results overflow `#finder-results` (max-height 300px), the highlighted item may be off-screen.

### 6.4 Tab rename doesn't persist across page reload (Low)
Tab inline rename (`setupTabInlineRename`, `index.html:1503-1541`) saves to `tab.title` and calls `saveTabState()`, which persists to `localStorage`. However, on restore (`loadTabState`), the title is restored but the `term.onTitleChange` handler (`index.html:1840`) will overwrite it when the terminal sends an OSC title. This means renamed tabs revert to the shell's title on reconnect.

### 6.5 Search results count not shown (Low)
Terminal search (`doSearch`, `index.html:3093-3099`) only shows "No results" or empty — it never shows "3 of 17 matches" or similar. Users can't tell how many matches exist.

### 6.6 No keyboard shortcut for new tab on mobile (Low)
`Ctrl+T` creates a new tab (`index.html:3623`) but there's no mobile key equivalent. Mobile users must use the `+` button in the tab bar.

---

## 7. Performance Concerns

### 7.1 All CDN scripts loaded synchronously in `<head>` (Medium)
`index.html:13-34`: 20+ script tags load synchronously from CDN. This blocks rendering until all scripts are downloaded and parsed. Scripts should use `defer` or `async` where possible (xterm addons, CodeMirror modes).

### 7.2 CodeMirror loaded but editor may never be opened (Low)
CodeMirror and all its language modes are loaded on every page visit, even if the user never opens a file. Consider lazy-loading with dynamic `import()`.

### 7.3 File list DOM is rebuilt on every poll (Low)
`loadFiles` (`index.html:2075`) recreates the entire file list every 10 seconds. While it reuses existing DOM nodes when paths match, the `list.replaceChildren(fragment)` call still triggers layout/paint.

---

## 8. Security-Adjacent UX

### 8.1 PIN input type should be `password` with `inputmode="numeric"` (Low)
`#pin-input` (`index.html:750`) has `type="password"` which is correct, but lacks `inputmode="numeric"` — on mobile, users get a full keyboard instead of a number pad for PIN entry.

### 8.2 Auth token sent as query parameter in WebSocket URL (Low)
`index.html:1668`: `ws://...?token=${encodeURIComponent(authToken)}` — tokens in URLs can appear in server logs, browser history, and referrer headers. Should use a cookie or subprotocol header instead. (This is a server-side design choice, but the frontend contributes to it.)

---

## Summary

| Severity | Count |
|----------|-------|
| High (a11y / bugs) | 5 |
| Medium | 14 |
| Low | 17 |
| **Total** | **36** |

### Critical Bugs (will cause JS errors)
1. **Line 1901**: `fontSize` undefined in pinch-to-zoom handler
2. **Line 1745**: `banner` undefined in `manualReconnect()`

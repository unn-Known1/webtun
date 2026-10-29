# WebTun — Comprehensive UI/UX Expert Review & Product Audit Report

**Repository**: `github.com/unn-Known1/webtun`  
**Version Audited**: `v2.1.0`  
**Audit Scope**: End-to-end UI/UX architecture, DOM/JS/Server contract integrity, visual design system, information density, desktop & mobile ergonomics, terminal/editor/Git/file workflows, accessibility (WCAG 2.2 AA), and feature completeness across `public/index.html`, `public/css/styles.css`, `public/js/*.js`, `lib/server/*.js`, `scripts/check-source.js`, and `public/docs.html`.

---

## Executive Summary

WebTun is an impressively capable zero-bundler browser workspace combining a `node-pty`/tmux terminal, multi-tab CodeMirror editor, full file manager, visual Git client, SSH key manager, Cloudflare tunnel controller, and media/document viewers.

However, a line-by-line audit of the HTML (`public/index.html`), stylesheet (`public/css/styles.css`), frontend scripts (`public/js/*.js`), and server endpoints (`lib/server/*.js`) uncovered **10 Critical UI/UX & Wiring Defects (P0)** where shipped UI features fail silently or render broken due to mismatched `data-action` names, mismatched DOM IDs, incompatible Server-Sent Events (SSE) JSON schemas, and undefined CSS custom properties (`--bg1`, `--fg1`, `--purple`), alongside **20 High-Impact UX & Feature Improvements (P1–P3)** that will elevate WebTun to a best-in-class developer workspace.

### Summary Scorecard

| Dimension | Score | Assessment |
| :--- | :---: | :--- |
| **Visual Design & Theming** | **7.8 / 10** | 9 cohesive themes (6 dark, 3 light + system auto-follow) and crisp IBM Plex Sans + JetBrains Mono typography, but late-addition rules (`styles.css:4044–4317`) use undefined `--bg1`/`--fg1`/`--purple` tokens and orphaned class selectors. |
| **DOM / Action / API Wiring** | **5.5 / 10** | Multiple features added in `v2.1.0` (Editor Find/Replace, Merge Conflict bar, Live Log Tail SSE, File Git History, CSV Filter, Audit Log) suffer from action-name, ID, class, or JSON payload mismatches between `index.html`, `public/js/*.js`, and `lib/server/*.js`. |
| **Terminal Experience** | **8.8 / 10** | Fast WebGL/Canvas rendering, smart reconnect backoff, shell integration, and tmux persistence. Needs tile zoom/status chrome, non-destructive broadcast mode indicators, and inline command parameter fill-in. |
| **Code Editor & Viewers** | **6.8 / 10** | Solid shared buffer architecture (`editor-buffers.js`) and external-change watcher, but Find/Replace is trapped inside `#editor-view` (invisible in File Tabs), and conflict resolution / live log tail are non-functional due to wiring bugs. |
| **File Manager & Search** | **8.2 / 10** | Rich context menu, drag-and-drop upload, conflict modal, and archive support. Missing line-number handoff from Content Search (`Ctrl+Shift+F`), keyboard selection ranges, and column sorting headers. |
| **Mobile & Touch Ergonomics** | **8.4 / 10** | Desktop-aligned rectangular tabs (`inset 0 2px 0 var(--accent)`), custom touch-scroll physics, and responsive bottom sheets. Needs collapsible mobile accessory bar, clearer sticky modifier states, and safer pinch-to-zoom boundaries. |
| **Accessibility (a11y)** | **7.5 / 10** | Skip link, ARIA dialog semantics, and reduced-motion support exist, but single-slot focus restoration breaks on stacked modals, icon-only controls lack accessible labels/tooltips, and screen-reader live regions are missing. |

---

## Part 1: Critical UI/UX Defects & Wiring Bugs (P0 — Must Fix)

Every finding below was verified directly against the current source files and represents a user-facing feature that is currently broken, unreachable, or visually degraded.

---

### 1. Undefined CSS Variables (`--bg1`, `--fg1`, `--purple`) Break Contrast & Transparency Across All 9 Themes
- **Evidence**:
  - WebTun's theme engine (`public/css/styles.css:11–193`) defines 9 themes (`tokyonight`, `dracula`, `solarized`, `gruvbox`, `monokai`, `oled`, `light`, `catppuccin-latte`, `nord-light`, plus `system` auto-follow) using `--bg0`, `--bg2`, `--bg3`, `--bg4` and `--fg0`, `--fg2`, `--fg3`. **`--bg1`, `--fg1`, and `--purple` are never defined in `:root` or any `[data-theme]` block.**
  - Yet rules in `public/css/styles.css:4044–4317` and inline styles in `public/js/git.js` reference these non-existent tokens without fallbacks:
    - `--bg1`: `styles.css:4053` (`.find-input`), `4107` (`#media-viewer, .tab-media-viewer`), `4133` (`#csv-preview-content, .tab-csv-preview`), `4283` (`.audit-log-item`).
    - `--fg1`: `styles.css:4056` (`.find-input`), `4095` (`#tail-status-label`), `4150` (`.csv-filter-input`), `4175` (`.csv-table th`), and `public/js/git.js:865` (`.file-history-row` commit subject).
    - `--purple`: `styles.css:4189–4190` (`.file-icon.k-media` uses `var(--purple, #a855f7)` instead of theme token `var(--accent2)`).
- **UX Impact**:
  - `#csv-preview-content`, `.tab-csv-preview`, `#media-viewer`, `.tab-media-viewer`, and `.audit-log-item` evaluate `background: var(--bg1)` to `transparent`, causing underlying views or dark/light mismatches to bleed through.
  - `.csv-table th`, `.csv-filter-input`, `#tail-status-label`, and `.file-history-row` evaluate `color: var(--fg1)` to `inherit`/`initial`, degrading text legibility—especially in light themes (`light`, `catppuccin-latte`, `nord-light`).
- **Fix Recommendation**:
  - Define `--bg1` (aliased to `--bg0` or an intermediate surface step) and `--fg1` (aliased to `--fg0`) in `:root` and all `[data-theme]` blocks in `public/css/styles.css`, and replace `var(--purple, #a855f7)` with `var(--accent2)`.

---

### 2. Unregistered `data-action` / `data-input-action` / `data-change-action` Attributes Leave Editor Controls Dead
- **Evidence**:
  - `public/js/actions.js:18–21` dispatches `data-action`, `data-change-action`, `data-input-action`, and `data-keydown-action` by looking up `handlers[type].get(action)` and logging `console.warn('Unknown UI action:', type, action)` when a name does not match.
  - Cross-checking `public/index.html:494–531` against `public/js/editor-panel.js:1213–1258` reveals **8 action-name mismatches** where the HTML attribute does not match the registered handler name:

| Control (`public/index.html`) | HTML Attribute in `index.html` | Registered Action in `editor-panel.js` | Result |
| :--- | :--- | :--- | :--- |
| `#editor-history-btn` (`line 494`) | `data-action="open-file-git-history"` | `open-editor-file-history` (`line 1228`) | Clicking the **Git History** button in the editor header does nothing. |
| `#editor-find-input` (`line 510`) | `data-input-action="editor-find-on-input"` | `editor-find-input` (`line 1242`, under `input`) | Typing in the Find box never highlights matches live. |
| `#editor-find-case` (`line 511`) | `data-change-action="editor-find-on-input"` | *(Not registered under `change`)* | Toggling Case Sensitivity (`Aa`) does not re-run search. |
| `#editor-find-regex` (`line 512`) | `data-change-action="editor-find-on-input"` | *(Not registered under `change`)* | Toggling Regex (`.*`) does not re-run search. |
| Find Bar `✕` button (`line 521`) | `data-action="close-editor-find"` | *(Not registered; `closeEditorFindBar()` at `line 844` is unwired)* | Clicking `✕` on the Find/Replace bar cannot close it! |
| Conflict `↑ Prev` (`line 526`) | `data-action="editor-conflict-prev"` | `conflict-prev` (`line 1229`) | Clicking `↑ Prev` does nothing. |
| Conflict `↓ Next` (`line 527`) | `data-action="editor-conflict-next"` | `conflict-next` (`line 1230`) | Clicking `↓ Next` does nothing. |
| Conflict `Accept Ours / Theirs / Both` (`lines 528–530`) | `data-action="editor-conflict-ours"` / `"-theirs"` / `"-both"` | `resolve-conflict-block` (`line 1231`, expecting `data-conflict-choice`) | Clicking any conflict resolution button does nothing. |

- **Root-Cause Tooling Gap (`scripts/check-source.js`)**:
  - `scripts/check-source.js:26–34` checks that `public/index.html` has no inline `on*=` attributes and that `getElementById('...')` targets exist, **but never verifies that every `data-action`, `data-change-action`, `data-input-action`, and `data-keydown-action` in `public/index.html` has a matching registration in `uiActions.register(...)`**.
- **Fix Recommendation**:
  - Align all action names between `public/index.html` and `public/js/editor-panel.js`, register `close-editor-find` and `change` handlers for `#editor-find-case` / `#editor-find-regex`, and add a static `data-*-action` verification pass to `scripts/check-source.js`.

---

### 3. Merge Conflict Resolution Bar (`#editor-conflict-bar`) Never Appears due to DOM ID Mismatch
- **Evidence**:
  - In addition to the dead `data-action` names noted in #2, `public/index.html:524–525` defines:
    ```html
    <div id="editor-conflict-bar" class="editor-subbar editor-conflict-bar" style="display:none">
      <span id="editor-conflict-status" class="editor-conflict-badge">Merge conflict</span>
    ```
  - However, `public/js/editor-panel.js:1151–1157` (`detectAndRenderConflicts`) and `1173–1176` (`hideConflictBar`) query:
    - `document.getElementById('conflict-bar')` (returns `null`)
    - `document.getElementById('conflict-count-badge')` (returns `null`)
- **UX Impact**:
  - Opening any file containing `<<<<<<<` / `=======` / `>>>>>>>` conflict markers silently bails out at `if (!bar) return;`. Users never see the conflict resolution bar or conflict count badge.
- **Fix Recommendation**:
  - Unify the IDs (`#editor-conflict-bar` and `#editor-conflict-status`) across `index.html`, `editor-panel.js`, and `scripts/check-source.js`.

---

### 4. Live Log Tail (`SSE`) Never Displays Any Log Output Due to Server/Client Schema Mismatch
- **Evidence**:
  - Even when the user clicks `#editor-tail-btn` (`data-action="toggle-editor-tail"`), `startLogTail()` (`public/js/editor-panel.js:1032–1092`) fails to display a single line of log output and its status UI stays frozen because of **three separate mismatches**:
    1. **Incompatible SSE JSON Schema (`lib/server/files.js:1516–1540` vs. `public/js/editor-panel.js:1061–1074`)**:
       - **Initial snapshot**: Server (`lib/server/files.js:1516`) sends `{ type: 'init', lines: tailLines, total: tailLines.length }` (where `lines` is `string[]`). Client (`editor-panel.js:1062`) checks `if (msg.type === 'init' && typeof msg.content === 'string')` — always `false`!
       - **Appended bytes**: Server (`lib/server/files.js:1540`) sends `{ type: 'data', lines: buf.toString('utf8') }`. Client (`editor-panel.js:1065`) checks `else if (msg.type === 'append' && typeof msg.content === 'string')` — always `false`!
       - **File truncation/rotation**: Server (`lib/server/files.js:1533`) sends `{ type: 'reset', reason: 'File truncated' | 'File rotated', lines: [...] }`. Client (`editor-panel.js:1071`) checks `else if (msg.type === 'truncated')` — always `false`!
    2. **Mismatched Tail Bar DOM IDs (`index.html:533–540` vs. `editor-panel.js:1049–1050, 1085–1086`)**:
       - `index.html:533–534` defines `id="editor-tail-bar"` and `id="editor-tail-status"`.
       - `editor-panel.js:1049–1050` queries `document.getElementById('tail-bar')` and `document.getElementById('tail-status-label')` (both `null`), so the tail status bar (`Streaming live updates…`) never appears.
    3. **Ignored Auto-Scroll Checkbox (`#tail-autoscroll-cb`)**:
       - `index.html:536` renders `<input type="checkbox" id="tail-autoscroll-cb" checked>`, but `editor-panel.js:1064, 1070` calls `cm.scrollIntoView(...)` unconditionally without checking `document.getElementById('tail-autoscroll-cb')?.checked`.
- **Fix Recommendation**:
  - Align `editor-panel.js` with `lib/server/files.js` (`msg.type === 'init'`, `'data'`, `'reset'`, reading `msg.lines`), align `#editor-tail-bar` and `#editor-tail-status` IDs, and gate `cm.scrollIntoView` on `#tail-autoscroll-cb`.

---

### 5. Per-File Git Commit History Modal (`#file-history-overlay`) Cannot Render Diffs or Scope Commits to the Inspected File
- **Evidence**:
  - `public/index.html:1656–1664` defines `#file-history-overlay` with `<span id="file-history-name">` and `<div id="file-history-list"></div>`, **with no diff container element**.
  - Meanwhile, `public/js/git.js:840–896` (`openFileGitHistory`):
    1. Queries `document.getElementById('file-history-path')` (`line 841`, `null` because HTML uses `id="file-history-name"`), so the file path subtitle is never updated.
    2. Queries `document.getElementById('file-history-diff')` (`line 842` and `line 879`). Because `#file-history-diff` does not exist in `public/index.html`, clicking any commit row hits `if (!diffEl) return;` (`line 879`) and silently does nothing!
    3. Calls `/api/git/show?path=${encodeURIComponent(repoRoot)}&ref=${encodeURIComponent(c.hash)}` (`line 883`) **without passing the file path**, and `lib/server/git.js:750–763` (`GET /api/git/show`) runs `git show --stat --patch <ref>` across the entire repository rather than `-- <file>`.
- **UX Impact**:
  - Even when opened from the file tree context menu (`#ctx-git-history`), the File Git History modal never displays the file path header, clicking a commit never renders a diff, and the backend endpoint returns the full repo-wide commit patch instead of the file's changes.
- **Fix Recommendation**:
  - Add `<div id="file-history-diff"></div>` in a two-pane split layout inside `#file-history-overlay`, align `#file-history-name` / `#file-history-path`, and accept an optional `file` query parameter in `GET /api/git/show` (`['show', '--stat', '--patch', ref, '--', relFile]`).

---

### 6. CSV / TSV Table Filter Input Is Completely Unwired & Missing Styling
- **Evidence**:
  - `public/index.html:478` renders `<input type="text" id="csv-filter-input" placeholder="Filter rows..." autocomplete="off">`, and `public/js/editor-panel.js:1244` registers `uiActions.register('filter-csv-preview', filterCsvPreview, 'input')`.
  - However:
    1. `#csv-filter-input` in `public/index.html:478` **has no `data-input-action="filter-csv-preview"` attribute** and no `class="csv-filter-input"` attribute!
    2. `openCsvViewer()` (`public/js/viewers.js:584–656`) renders the `<table>` directly into `#csv-preview-content` without populating `_csvRawRows` (`editor-panel.js:943`) and without ever showing `#csv-preview-toolbar` (`index.html:477`, which stays `display:none`)!
    3. `openCsvInTab()` (`public/js/viewers.js:659–698`) builds an inline `.csv-filter-bar` with a `.csv-filter-input`, which works in File Tabs, leaving the split-panel CSV viewer completely lacking the filter bar that exists in `index.html:477–480`.
- **UX Impact**:
  - Opening a `.csv` or `.tsv` file in the split editor panel shows a bare table with no filter toolbar and no row counter (`#csv-row-count`), while `#csv-preview-toolbar` sits dead in the DOM.
- **Fix Recommendation**:
  - Add `class="csv-filter-input" data-input-action="filter-csv-preview"` to `#csv-filter-input`, and wire `openCsvViewer()` in `public/js/viewers.js` to show `#csv-preview-toolbar` and filter rows consistently across both the split panel and File Tabs.

---

### 7. Orphaned CSS Selectors Leave Editor Sub-bars & Security Audit Log Unstyled
- **Evidence**:
  - `public/css/styles.css:4044–4080` and `4280–4297` were written for class names that do not match the classes emitted by `public/index.html` and `public/js/security.js`:

| Component | CSS Selector in `public/css/styles.css` | Actual DOM Class / ID in `index.html` or `security.js` | Visual Bug |
| :--- | :--- | :--- | :--- |
| Find / Replace / Go-to Inputs | `.find-input` (`line 4050`), `.find-goto-input` (`line 4061`) | `#editor-find-input`, `#editor-replace-input`, `#editor-goto-input` (no class) | Inputs render as default browser text boxes without theme borders, padding, or monospace font. |
| Find Match Count | `.find-count` (`line 4062`) | `#editor-find-count.editor-subbar-meta` (`index.html:513`) | Match counter lacks min-width and monospace styling. |
| Merge Conflict Sub-bar | `.conflict-subbar` (`line 4070`), `.conflict-badge` (`line 4074`) | `.editor-conflict-bar`, `.editor-conflict-badge` (`index.html:524–525`) | Conflict bar lacks its amber border/tint and bold badge styling. |
| Log Tail Sub-bar | `.tail-subbar` (`line 4080`) | `.editor-tail-bar` (`index.html:533`) | Tail bar lacks its emerald status border/tint. |
| Security Audit Log Rows | `.audit-log-item` (`line 4280`), `.audit-log-head` (`line 4289`) | `.audit-log-row`, `.audit-log-row-head` (`security.js:710, 712`) | Audit log entries in Settings → Security render as unstyled raw text blocks without card backgrounds, padding, or flexbox alignment. |

- **Fix Recommendation**:
  - Match the selectors in `public/css/styles.css` to the actual classes in `public/index.html` and `public/js/security.js`.

---

### 8. Editor Find / Replace / Go-to-Line (`Ctrl+F` / `Ctrl+H` / `Ctrl+G`) Is Invisible When Editing in Text File Tabs
- **Evidence**:
  - In `public/js/editor-panel.js:811–819`, `getActiveEditorCM()` properly returns `activeTab.cm` when a text File Tab is focused.
  - **However**, `#editor-find-bar` (`public/index.html:509`) is nested inside `#editor-view` (`public/index.html:465`), which is only visible when the right-hand split editor panel is open (`#editor-view.open`) or when a heavy viewer (PDF/EPUB/Office) docks `#editor-view` into a tab.
  - Because text File Tabs render their own `.file-tab-editor` (`public/js/file-tabs.js:354–418`) without docking `#editor-view`, pressing `Ctrl+F`, `Ctrl+H`, or `Ctrl+G` while editing in a text File Tab sets `bar.style.display = 'flex'` inside the hidden `#editor-view` (`display: none`), and `input.focus()` silently fails!
  - Furthermore, `.fte-bar` (`public/js/file-tabs.js:358–395`) only creates `Save`, `Reload`, and `Panel` buttons—omitting `Find`, `Wrap`, `Tail`, and `History` controls.
- **UX Impact**:
  - Users working in full-window File Tabs (`Open in Tab`) or Tile view have **zero visible Find, Replace, or Go-to-Line UI**, even though `Ctrl+F` intercepts the browser shortcut.
- **Fix Recommendation**:
  - Either dynamically relocate `#editor-find-bar` into the active `.file-tab-editor` (just below `.fte-bar`) when a text File Tab is focused, or mount a per-tab Find/Replace bar inside `buildTabEditorChrome()`.

---

### 9. Content Search (`Ctrl+Shift+F`) Discards Matched Line & Column When Opening File
- **Evidence**:
  - `GET /api/files/search-content` (`lib/server/files.js:1482`) returns `{ path, line, column, content }` for each match.
  - `public/js/files.js:1748–1757` displays `:${m.line}` in the search result row, but its click handler does:
    ```js
    row.addEventListener('click', () => {
      closeOverlay('content-search-overlay');
      openFileEditor(m.path);
    });
    ```
  - Both `m.line` and `m.column` are thrown away! Opening a 2,000-line file from Content Search leaves the cursor at line 1 instead of scrolling to and highlighting `m.line`.
- **Fix Recommendation**:
  - Extend `openFileEditor(path, opts)` (and `openFileAsTab(path, opts)`) to accept `{ line, ch }`, and after CodeMirror mounts, call `cm.setCursor({ line: opts.line - 1, ch: (opts.ch || 1) - 1 })` and `cm.scrollIntoView(null, 120)`.

---

### 10. `resetSettings()` Fails to Reset `editorWrap` and `tabSize`
- **Evidence**:
  - `DEFAULT_SETTINGS` (`public/js/core.js:244–248`) includes `editorWrap: true` and `tabSize: 2`.
  - However, `resetSettings()` (`public/js/ui.js:13–62`) resets `s-theme`, `s-fontsize`, `s-scrollback`, `s-font`, `s-cursor`, `s-screensaver-min`, and 13 toggles, **but omits**:
    - `syncToggle('editorWrap')` and `applyEditorWrap(settings.editorWrap)`
    - `document.getElementById('s-tabsize').value = settings.tabSize` and `applyTabSize(settings.tabSize)`
- **UX Impact**:
  - Clicking "Reset to Defaults" in Settings leaves the Editor Word Wrap toggle and Tab Size select out of sync with `DEFAULT_SETTINGS` and active CodeMirror instances.
- **Fix Recommendation**:
  - Add `syncToggle('editorWrap')`, `applyEditorWrap(settings.editorWrap)`, `#s-tabsize` value sync, and `applyTabSize(settings.tabSize)` to `resetSettings()` in `public/js/ui.js`.

---

## Part 2: High-Impact UX & Workflow Improvements (P1)

### 11. Broadcast Input Mode Needs Unmistakable Visual Guardrails on Terminal Panes
- **Current State**:
  - When `broadcastInput` (`public/js/tabs.js:23, 1528–1536`) is enabled, every keystroke—including `Ctrl+C`, `rm -rf`, or `exit`—is sent to **all connected terminal tabs simultaneously**.
  - Currently, only `#broadcast-btn` in the top header gets `.active` (`public/css/styles.css:4039`, a subtle 1px accent outline), which is invisible when the button is inside `#header-more-menu` or on mobile.
- **UX Risk**:
  - Users can easily forget Broadcast Mode is active and accidentally run destructive commands across production and local shells at once.
- **Improvement**:
  - Render a persistent `inset 0 0 0 2px var(--amber)` border around `#terminal-wrap` and a floating/pinned banner (`⚡ Broadcasting keystrokes to N terminals — Click or press Esc to disable`) whenever `broadcastInput` is `true`, plus allow per-tab opt-out checkboxes in tile headers.

---

### 12. Terminal Tile View (`layoutTiles`) Lacks Per-Tile Status Dots, Maximize/Zoom Toggle, and Layout Presets
- **Current State**:
  - `layoutTiles()` (`public/js/tabs.js:1430–1526`) splits visible terminals/text tabs into an automatic CSS grid (`cols = Math.ceil(Math.sqrt(n))`) and injects a minimal `.term-tile-header` (`tabs.js:1466–1503`) containing only `.tth-name` and `.tth-close`.
- **UX Gaps**:
  - In Tile View, `.term-tile-header` does not show the terminal's **connection status dot** (`connected` / `reconnecting` / `exited`) or **tab color tag**, nor does it provide a **Zoom / Maximize Tile** button (`Ctrl+Shift+Enter`, like tmux `prefix + z`) to temporarily expand one tile to 100% without leaving Tile Mode.
  - Three panes always produce a 2×2 grid with an empty quadrant instead of letting the user pick **2 Columns**, **2 Rows**, **Main Left + Stack Right**, or **2×2 Grid**.
- **Improvement**:
  - Add the tab's live `.tab-dot`, color indicator, and a **Zoom Tile (`⤢`)** toggle button to `.term-tile-header`, and offer a quick layout preset selector next to `#tile-btn`.

---

### 13. Split-View Resizer Handle (`#split-handle`) Has No Visual Affordance or Double-Click Reset
- **Current State**:
  - `#split-handle` (`public/css/styles.css:768–776`) is a flat `4px` strip (`6px` on coarse pointers) with no grip dots and no double-click behavior.
- **UX Gaps**:
  - Users do not realize the boundary between the file tree, terminal, and editor is draggable, and once dragged to an extreme width, there is no one-click way to restore the default 50/50 split.
- **Improvement**:
  - Add a subtle centered 3-dot vertical grip pill (`::after`), expand the invisible pointer hit area to `12px` via a pseudo-element, and bind `dblclick` on `#split-handle` and `#sidebar-resizer` to reset panel widths to their defaults (`50%` editor split, `240px` sidebar).

---

### 14. Command Palette (`Ctrl+K`) Lacks Open Files, Recent Files, and Multi-Mode Prefixes (`>`, `@`, `#`)
- **Current State**:
  - `openCmdPalette()` (`public/js/misc.js:244–340`) searches static `PALETTE_ACTIONS`, open tabs, and command library snippets.
- **UX Gaps**:
  - Developers expect `Ctrl+K` / `Ctrl+P` to fuzzy-jump to **recently opened files** or **workspace files** without first opening the sidebar and clicking `#file-search-btn`.
- **Improvement**:
  - Support mode prefixes in `#cmd-palette-input`:
    - Default / no prefix: Actions + Open Tabs + Recent Files (`wt-recent-files`)
    - `p ` or `/`: Live workspace file fuzzy search (`/api/search?q=`)
    - `>`: Actions & Settings only
    - `#`: Saved Command Snippets & Shell History

---

### 15. Command Snippet Placeholders (`<port>`, `<file>`) Execute Literally Without Prompting
- **Current State**:
  - `public/commands.js` ships dozens of useful templates containing placeholders like `lsof -i :<port>`, `git checkout -b <branch>`, and `tar -czf <archive.tar.gz> <dir>`.
  - Clicking **Run** in `#cmd-overlay` (`public/js/misc.js:116–128`) sends the literal string `<port>\r` to the shell, which immediately fails with a syntax error: `bash: syntax error near unexpected token 'newline'`.
- **Improvement**:
  - Detect `<placeholder>` tokens in `runCmdItem()` before sending `\r`: if placeholders exist, either prompt for each token via a lightweight inline parameter form or paste the command *without* `\r` and select the first `<placeholder>` in the terminal/input box.

---

### 16. Editor Status Bar Is Missing Live Cursor Coordinates (`Ln X, Col Y`), Selection Count, Indentation, and Encoding
- **Current State**:
  - `#editor-status` (`public/index.html:542`) only displays static load metadata (`124 lines · 4.2 KB · UTF-8`) written once when the file opens (`public/js/editor-panel.js:405`), or temporary `Saved` / `Modified` text.
- **UX Gaps**:
  - As soon as the user edits a character, `updateEditorDirty()` (`editor-panel.js:190`) overwrites `#editor-status` with the single word `Modified`, erasing the line count and file size! And there is never a live `Ln X, Col Y` indicator.
- **Improvement**:
  - Split `#editor-status` into structured status segments:
    - Left: Save/Sync state (`Saved`, `Modified`, `Changed on disk`)
    - Right: `Ln 42, Col 18 (34 selected)` (clickable to open Go-to-Line `Ctrl+G`) · `Spaces: 2` · `UTF-8` · `JavaScript`.

---

## Part 3: Medium-Priority Feature & Ergonomic Enhancements (P2)

### 17. Git Panel Needs Side-by-Side Diff Toggle, Line/Hunk Stage Controls, and Visual Stash List
- **Current State**:
  - `public/js/git.js` provides unified inline diffs, commit history graph, branch switcher, worktrees, and stash push/pop buttons.
- **UX Gaps**:
  1. **No Stash List Inspector**: Users can click `Stash` and `Pop`, but cannot see *how many* stashes exist (`stash@{0}`, `stash@{1}`), inspect a stash's diff, or drop a specific stash.
  2. **Unified-Only Diff**: Wide desktop monitors benefit greatly from a **Unified / Split (Side-by-Side)** diff toggle in `#git-diff-modal`.
  3. **Commit Message Box Lacks Character Counter & Amend Toggle**: Adding a `50/72` subject-line character counter and a `Commit --amend` checkbox in `#git-commit-form` speeds up daily Git workflows.

---

### 18. File Explorer Needs Sticky Sort Headers, Range Selection (`Shift+Click`), and Inline Rename
- **Current State**:
  - `renderFileList()` (`public/js/files.js:340–470`) renders `.file-item` rows sorted via a hidden `<select id="file-sort-select">`.
- **UX Gaps**:
  1. Users cannot click `Name ▲`, `Size`, or `Modified` column headers to sort.
  2. Multi-selection requires clicking individual checkboxes (`files.js:385`); `Shift+Click` range selection and `Ctrl/Cmd+Click` row toggling are not supported.
  3. Renaming opens a modal overlay (`#rename-overlay`) instead of allowing inline filename editing (with smart stem-only selection so the file extension isn't accidentally overwritten).

---

### 19. Mobile Virtual Key Bar (`#key-bar`) Needs Collapsible Toggle & Persistent Sticky-Modifier Badges
- **Current State**:
  - `#key-bar` (`public/index.html:439–461`, `public/css/styles.css:1540–1605`) permanently occupies vertical space above the soft keyboard on mobile, even when the user is reading long logs, browsing files, or viewing a PDF/image.
  - Sticky `Ctrl` and `Alt` buttons (`public/js/terminal.js:763–789`) highlight with `.active`, but there is no HUD badge on the terminal itself when `#key-bar` is scrolled horizontally out of view.
- **Improvement**:
  - Auto-hide `#key-bar` when the active tab is a non-editable viewer (`image`, `pdf`, `epub`, `office`, `media`, `csv`), add a compact collapse chevron on the left edge of `#key-bar`, and display a small floating `CTRL` / `ALT` pill badge in the bottom-right corner of the terminal when sticky modifiers are armed.

---

### 20. Replace Native Blocking `window.prompt()` in Session Rename with an In-App `promptDialog()`
- **Evidence**:
  - `editSessionLabel()` (`public/js/tabs.js:931`) calls:
    ```js
    const next = window.prompt('Session label (leave empty to clear):', current);
    ```
  - Note that `public/js/ui.js:193` provides `confirmDialog()`, **but does not yet provide a reusable `promptDialog()`** (file rename and mkdir use dedicated single-purpose overlays).
- **UX Impact**:
  - `window.prompt()` blocks the main thread, violates WebTun's visual theme, and is suppressed or broken in embedded iframes and Electron shells.
- **Improvement**:
  - Add a reusable `promptDialog({ title, message, defaultValue, placeholder, confirmText })` helper in `public/js/ui.js` (reusing `#confirm-overlay` with an optional `<input class="text-input">` or a shared `#prompt-overlay`) and replace `window.prompt` in `public/js/tabs.js:931`.

---

### 21. App Preview Toolbar (`preview.js`) Needs Responsive Viewport Presets & Subpath Navigation Input
- **Current State**:
  - `newPreviewTab()` (`public/js/preview.js:133–215`) renders a toolbar with port badge, Reload, Open in New Tab, and Stop Server.
- **UX Gaps**:
  - Developers previewing a local web app on `:3000` or `:5173` cannot navigate to a subpath (e.g., `/login` or `/api/health`) inside the preview iframe, nor can they test mobile/tablet viewport widths (`375×812`, `768×1024`, `100%`).
- **Improvement**:
  - Replace the static port label with an editable subpath bar (`:5173/ [ /dashboard ]`) and add 3 viewport size toggles (`Mobile 375px`, `Tablet 768px`, `Responsive 100%`).

---

## Part 4: Accessibility (WCAG 2.2 AA) & Polish (P3)

### 22. Single-Slot `lastFocusedElement` Breaks Focus Restoration on Stacked Modals
- **Evidence**:
  - `openOverlay(id)` and `closeOverlay(id)` (`public/js/ui.js:94, 104–148`) store focus in a single global variable `let lastFocusedElement = null;`.
  - Whenever a secondary confirmation dialog (`confirmDialog()` in `ui.js:193–245`, which calls `openOverlay('confirm-overlay')`) opens *on top of* an already-open modal (`#term-sessions-overlay`, `#ssh-overlay`, `#git-diff-modal`), `lastFocusedElement` is overwritten with the button inside the first modal and then set to `null` when `#confirm-overlay` closes (`ui.js:146`). When the parent modal subsequently closes, focus is lost to `<body>`.
- **Fix Recommendation**:
  - Replace `let lastFocusedElement = null` with a focus stack (`const focusStack = []` or per-overlay `overlay._returnFocusEl = document.activeElement`) so nested modals restore focus accurately at every level.

---

### 23. Icon-Only Header & Toolbar Buttons Lack Consistent Tooltips & Shortcut Hints
- **Evidence**:
  - Several icon-only buttons in `public/index.html` and dynamic toolbars have `title="..."` attributes without keyboard shortcut hints or lack `aria-label` when `title` changes dynamically (e.g., `#tile-btn`, `#broadcast-btn`, `#Bell/notif-btn`, `.fte-btn`).
- **Improvement**:
  - Standardize `title` + `aria-label` across all icon buttons to include their shortcut (e.g., `Command Palette (Ctrl+K)`, `Search in Files (Ctrl+Shift+F)`, `Toggle Tile View`).

---

### 24. Screen-Reader Live Regions (`aria-live`) Missing for Asynchronous Transfers & Connection State
- **Evidence**:
  - File uploads/downloads (`#upload-toast` in `public/index.html:668`) and terminal connection overlays (`.term-loading` in `public/js/terminal.js`) update visually without `aria-live="polite"` regions.
- **Improvement**:
  - Add `role="status" aria-live="polite"` to `#toast-container`, `#upload-toast`, and `#editor-status`.

---

## Prioritized Remediation Roadmap

| Priority | ID | Area | Summary of Fix | Target Files |
| :---: | :---: | :--- | :--- | :--- |
| **P0** | **#1** | CSS Tokens | Define `--bg1` and `--fg1` across all 9 themes in `:root` / `[data-theme]`; replace `--purple` with `--accent2`. | `public/css/styles.css`, `public/js/git.js` |
| **P0** | **#2** | UI Actions + CI | Fix 8 mismatched `data-*-action` names in editor header/find/conflict bars & add action-registration check to `npm run check`. | `public/index.html`, `public/js/editor-panel.js`, `scripts/check-source.js` |
| **P0** | **#3** | Conflict Bar | Align `#editor-conflict-bar` and `#editor-conflict-status` DOM IDs so merge conflict bar renders automatically. | `public/index.html`, `public/js/editor-panel.js` |
| **P0** | **#4** | Live Log Tail | Align SSE payload schema (`init`/`data`/`reset` + `msg.lines`), align `#editor-tail-bar`/`#editor-tail-status` IDs, respect `#tail-autoscroll-cb`. | `public/js/editor-panel.js`, `public/index.html` |
| **P0** | **#5** | File Git History | Add `#file-history-diff` pane, fix `#file-history-name` ID, and scope `GET /api/git/show` to `&file=` (`-- <file>`). | `public/index.html`, `public/js/git.js`, `lib/server/git.js`, `public/css/styles.css` |
| **P0** | **#6** | CSV Filter | Add `data-input-action="filter-csv-preview"` + `.csv-filter-input` to `#csv-filter-input` and wire split-panel CSV filter. | `public/index.html`, `public/js/viewers.js`, `public/js/editor-panel.js` |
| **P0** | **#7** | Orphaned CSS | Align `.find-input`, `.conflict-subbar`, `.tail-subbar`, and `.audit-log-row` selectors with actual DOM classes. | `public/css/styles.css`, `public/index.html` |
| **P0** | **#8** | File Tab Find | Mount/relocate `#editor-find-bar` into active `.file-tab-editor` so `Ctrl+F`/`Ctrl+H`/`Ctrl+G` works in File Tabs. | `public/js/editor-panel.js`, `public/js/file-tabs.js` |
| **P0** | **#9** | Content Search | Pass `{ line: m.line, ch: m.column }` from Content Search (`Ctrl+Shift+F`) into `openFileEditor()` and scroll to line. | `public/js/files.js`, `public/js/editor-panel.js`, `public/js/file-tabs.js` |
| **P0** | **#10** | Settings Reset | Reset `editorWrap` and `tabSize` in `resetSettings()`. | `public/js/ui.js` |
| **P1** | **#11–#16** | Core Workflows | Broadcast Mode amber border/banner, Tile View zoom/status/layouts, double-click split reset, `Ctrl+K` file jump, snippet placeholder prompt, live `Ln/Col` status bar. | `public/js/tabs.js`, `public/js/misc.js`, `public/js/editor-panel.js`, `public/css/styles.css` |
| **P2–P3** | **#17–#24** | Polish & a11y | Stash list inspector, side-by-side diff, file tree range select & sort headers, collapsible mobile `#key-bar`, `promptDialog()`, stacked modal focus restoration. | `public/js/git.js`, `public/js/files.js`, `public/js/ui.js`, `public/js/terminal.js`, `public/js/preview.js` |

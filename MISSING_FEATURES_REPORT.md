# WebTun — Missing Features & Capability Gap Report

**Baseline Version:** `v2.3.5`  
**Scope:** Source-grounded analysis of missing features, unwired backend APIs ("dark features"), planned commercial/Team capabilities, and high-value workspace enhancements across the WebTun server (`server.js`, `lib/server/*`) and frontend (`public/*`).  
**Exclusions:** Deliberate product decisions documented in `AGENTS.md` (*Intentional by design*: empty `PIN` default, `ALLOW_FULL_FS=true` default, `?token=` query auth for WebSocket/`<img>`/`<iframe>`, no-bundler CDN architecture) and all items already remediated in `docs/CODEBASE_FEATURE_REVIEW.md` §10 (`B1–B14`, `N01–N26`, `G02–G09`).

---

## Executive Summary

WebTun `v2.3.5` has a mature core across terminal sessions, file management, multi-surface editing, Git workflows, SSH provisioning, and commercial licensing. However, inspecting the backend routes against the frontend UI reveals **four distinct categories of missing features**:

1. **Tier 1 — Unwired Backend Capabilities ("Dark Features"):** Complete server endpoints and protocol hooks (`GET /api/files/tail` SSE streaming, `GET /api/system/network`, `POST /api/files/symlink`, `/api/files/batch-copy`, `/api/files/batch-move`, `/api/files/batch-zip`, HTTP `206` Range media streaming, and OSC 133 shell integration parsing) that already exist in the codebase but have **zero UI wiring** in `public/js/`.
2. **Tier 2 — Commercial & Team Roadmap Gaps:** Features documented in `founder/mvp-scope.md`, `founder/pricing-strategy.md`, and `public/docs.html` as unshipped (`wt-cmdlib` / `wt-bookmarks` server-side sync, security & compliance audit log export, runtime `PREVIEW_PORTS` / `ALLOWED_ORIGINS` policy UI, and Stripe Customer Billing Portal).
3. **Tier 3 — Code Editor, File Explorer & Viewer Enhancements:** Everyday IDE/file-manager capabilities missing from the current UI (in-editor Find/Replace/Go-to-Line for CodeMirror, editor Word Wrap / Tab Size controls, folder upload picker button for non-drag-and-drop/mobile users, `.tar.gz`/`.tgz` archive operations, inline audio/video & CSV previewers).
4. **Tier 4 — Terminal, Git & System Observability Features:** Power-user workflows (OSC 133 prompt navigation & exit-code badges, multi-terminal broadcast input in Tile View, terminal scrollback export, parameterized command snippets, full Git Stash management & file history, and multi-mount disk/network monitoring).

---

## Tier 1: Unwired Backend Capabilities ("Quick Wins")

These features already have working backend routes or client protocol handlers in the repository, requiring **only frontend UI and `actions.js` wiring** to ship.

### 1.1 Live Log Tail Viewer (`GET /api/files/tail` SSE)
- **Current Backend State:** `lib/server/files.js:1409–1481` implements a production-ready Server-Sent Events (SSE) endpoint (`GET /api/files/tail?path=...&bytes=16384`). It streams the trailing bytes of a file, polls every `1000ms`, detects file truncation/log rotation (`type: 'reset'`), and pushes new chunks (`type: 'data'`).
- **Missing Frontend Feature:** `public/js/` never calls `/api/files/tail`. There is no "Tail Log" option in the file context menu (`#ctx-menu`) or editor header (`#editor-header`).
- **Proposed Implementation:**
  - Add a **Tail (Live)** toggle button in `#editor-header` (for `.log`, `.out`, `.txt`, or any text file) and a **Tail File** item in `#ctx-menu`.
  - Stream incoming SSE chunks into a read-only view or bottom-pinned follow mode with **Pause/Resume**, **Auto-scroll lock**, and **Clear** controls.

### 1.2 Network Interfaces, Gateway & DNS Inspector (`GET /api/system/network`)
- **Current Backend State:** `server.js:415–482` implements `GET /api/system/network`, returning:
  - All active network interfaces with IPv4/IPv6 addresses, CIDR netmasks, MAC addresses, and internal/external flags.
  - Default network gateway (`ip route` on Linux, `route -n get default` on macOS).
  - Configured DNS servers (`os.getDnsServers()`).
  - Active listening ports (`getListeningPorts()`).
- **Missing Frontend Feature:** `GET /api/system/network` is never called anywhere in `public/js/`. Meanwhile, `#sys-overlay` (`public/index.html:1009–1034`) only displays CPU, Memory, Disk `/`, Load Average, and Top Processes.
- **Proposed Implementation:**
  - Add a **Network & Interfaces** section inside the System Stats modal (`#sys-overlay`) showing LAN/tailnet IP addresses, MACs, default gateway, and DNS servers with one-click copy buttons (helpful when connecting from another device on the LAN or VPN).

### 1.3 Symbolic Link Creation UI (`POST /api/files/symlink`)
- **Current Backend State:** `lib/server/files.js:1195–1209` implements `POST /api/files/symlink` (`{ target, linkPath }`) with full path-containment and target validation (`N09`), and `GET /api/files` already returns `isSymlink: true` and `symlinkTarget` (`lib/server/files.js:613–649`).
- **Missing Frontend Feature:** While the file list displays a `⇢` badge for existing symlinks (`public/js/files.js:491`), there is no UI action in `#ctx-menu` or `#file-Properties` to create a symlink.
- **Proposed Implementation:**
  - Add **Create Symlink…** (`#ctx-symlink`) to the file context menu (`#ctx-menu`), prompting for the link path/name and calling `POST /api/files/symlink`.

### 1.4 Batch Copy, Move & Archive in Multi-Select Mode
- **Current Backend State:** `lib/server/files.js:1158–1236` implements:
  - `POST /api/files/batch-copy` (`{ paths, destination, conflictResolution }`)
  - `POST /api/files/batch-move` (`{ paths, destination, conflictResolution }`)
  - `POST /api/files/batch-zip` (`{ paths, archivePath }`)
- **Missing Frontend Feature:** The multi-select toolbar (`#select-actions` in `public/index.html:196–202`) only exposes **Select All**, **Delete**, **Download**, and **Cancel**. Users cannot copy, cut, move, or create an in-place `.zip` archive from multiple selected items (`selectedFiles` in `public/js/files.js`).
- **Proposed Implementation:**
  - Add **Copy**, **Cut**, and **Zip** buttons to `#select-actions` so multi-selected files can be staged into `fileClipboard` (for paste into another directory with conflict resolution) or compressed directly into the workspace via `/api/files/batch-zip`.

### 1.5 One-Click Cloudflare Tunnel from Listening Ports Modal
- **Current State:** The Listening Ports modal description (`public/index.html:1127`) reads: *"Active TCP servers detected on this machine. Open an in-app preview tab or generate a public Cloudflare Tunnel URL."*
- **Missing Frontend Feature:** `refreshPortsModal()` in `public/js/preview.js:444–454` only renders a **Preview Tab** button (`preview-open-port`) for each detected port. It omits a button to spin up a public Cloudflare Tunnel for that port.
- **Proposed Implementation:**
  - Add a **Tunnel** button next to **Preview Tab** in each row of `#ports-modal-list` that calls `POST /api/tunnel` with `{ port: p.port, name: p.process }` and copies/displays the resulting `trycloudflare.com` URL.

### 1.6 Inline Audio & Video Media Player (Using Existing HTTP `206` Range Support)
- **Current Backend State:** `GET /api/files/download` (`lib/server/files.js:763–801`) already supports `Accept-Ranges: bytes` and HTTP `206 Partial Content` byte-range streaming (`N18`).
- **Missing Frontend Feature:** Audio (`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`) and video (`.mp4`, `.webm`, `.mov`) files are treated as generic binary files (`EXT_KIND` in `public/js/files.js:363–374`) and rejected by the text editor (`Binary file — cannot display in editor`).
- **Proposed Implementation:**
  - Classify audio/video extensions in `EXT_KIND` and render a lightweight native HTML5 `<audio controls>` or `<video controls>` player inside `#editor-view` (and file tabs) backed by `/api/files/download?path=...&token=...`.

---

## Tier 2: Commercial & Team Tier Features (Roadmap & Docs Gaps)

These features are explicitly referenced in `founder/mvp-scope.md`, `founder/pricing-strategy.md`, and `public/docs.html:809` as planned or unshipped capabilities.

### 2.1 Server-Side Shared Command Library & Bookmarks Sync
- **Evidence:** `public/docs.html:809` states: *"A server-side shared command library and audit export are not shipped yet."* In `public/js/misc.js:6–9, 255–260`, bookmarks (`wt-bookmarks`) and custom command snippets (`wt-cmdlib`) are persisted solely in browser `localStorage`.
- **Impact:** Switching browsers, opening WebTun on a mobile device via tunnel/QR code, or collaborating on a Team instance loses all saved bookmarks and custom command snippets.
- **Proposed Implementation:**
  - Add `GET /api/library` & `POST /api/library` and `GET /api/bookmarks` & `POST /api/bookmarks` persisted atomically in `DATA_DIR` (`library.json`, `bookmarks.json`), merging with local browser storage on load and syncing across all authenticated sessions/seats.

### 2.2 Security & Compliance Audit Log + CSV/JSON Export (`GET /api/audit/export`)
- **Evidence:** Planned in `founder/mvp-scope.md:19` (`G01` in `docs/CODEBASE_FEATURE_REVIEW.md:191`) and noted as unshipped in `public/docs.html:809`.
- **Impact:** Team and enterprise self-hosters have no persistent audit trail of who authenticated, approved/denied a device session, rotated the PIN, provisioned/revoked an SSH key, opened a public tunnel, or executed commands.
- **Proposed Implementation:**
  - Add a structured append-only audit ring-buffer in `DATA_DIR/audit-log.json` recording security-sensitive actions (`auth.login`, `auth.approve`, `auth.revoke`, `auth.pin_change`, `ssh.provision`, `ssh.revoke`, `tunnel.start`, `tunnel.stop`).
  - Expose `GET /api/audit` and `GET /api/audit/export?format=json|csv` (gated by `requirePro` or Team plan when licensing is active) with an **Export Audit Log** button in **Settings → Security**.

### 2.3 Runtime Policy UI for `PREVIEW_PORTS` and `ALLOWED_ORIGINS`
- **Evidence:** Listed in `founder/mvp-scope.md:17` and `founder/pricing-strategy.md:59` (*"Preview port allow-list (`PREVIEW_PORTS`) & origin policy UI"*). Currently, `PREVIEW_PORTS` (`server.js:981`) and `ALLOWED_ORIGINS` (`lib/server/auth.js:65`) can only be configured via environment variables before server startup.
- **Proposed Implementation:**
  - Add a **Network & Origin Policy** subsection in **Settings → Security** allowing the owner to inspect and update allowed preview port ranges and extra WebSocket origins at runtime (persisted to `.env` or `DATA_DIR/policy.json` and hot-reloaded in memory).

### 2.4 Stripe Customer Billing Portal (`POST /api/billing/portal`)
- **Evidence:** Listed in `founder/mvp-scope.md:50` and `founder/pricing-strategy.md:60`. Currently `server.js:304–399` implements `/api/billing/checkout`, `/api/billing/webhook`, `/api/billing/claim`, and `/api/billing/renewals`, but provides no way for an existing Pro/Team subscriber to update their card, download invoices, or cancel/change their subscription.
- **Proposed Implementation:**
  - Store `customer` ID alongside license metadata when minting via Stripe webhook, add `POST /api/billing/portal` (calling `https://api.stripe.com/v1/billing_portal/sessions` via `fetch`), and add a **Manage Billing** button in `#license-box` (`public/index.html:1087`).

---

## Tier 3: Code Editor, File Explorer & Viewer Enhancements

### 3.1 CodeMirror In-Editor Find, Replace & Go-to-Line (`Ctrl+F` / `Ctrl+H` / `Ctrl+G`)
- **Current State:** `public/index.html:33–51` loads CodeMirror 5.65.18 core, modes, and `matchbrackets.min.js`, but **does not load** `addon/search/search.min.js`, `addon/search/searchcursor.min.js`, `addon/dialog/dialog.min.js`, or `addon/search/jump-to-line.min.js`.
- **Impact:** Pressing `Ctrl+F` while editing a file triggers the browser's native page search, which only searches the currently rendered viewport of CodeMirror's virtualized DOM—missing matches further down in large files—and offers no Find & Replace or Go-to-Line (`Ctrl+G`).
- **Proposed Implementation:**
  - Include CodeMirror's `search`, `searchcursor`, `dialog`, and `jump-to-line` addons (or a custom WebTun search bar anchored to the top-right of `#editor-body` / `.file-tab-editor-host`) supporting regex, case-sensitivity, match count, Replace/Replace All, and `Ctrl+G` line jump.

### 3.2 Editor Preferences (Word Wrap, Tab Size) & Split-Panel Reload Button
- **Current State:**
  - `CM_BASE_OPTIONS` (`public/js/editor-panel.js:24–33`) hardcodes `lineWrapping: false` and `tabSize: 2`. There is no toggle for Word Wrap (`Alt+Z`) or Tab Size (`2` vs `4`) in `#editor-header` or Settings.
  - File tabs have an explicit **Reload** button in `buildTabEditorChrome()` (`public/js/editor-panel.js:116`), whereas the split-panel editor header (`#editor-header`, `public/index.html:243–284`) lacks a dedicated Reload button (as noted in `public/js/editor-panel.js:564`, users can only reload the panel when the external-change indicator is visible).
- **Proposed Implementation:**
  - Add a **Word Wrap** toggle button and a permanent **Reload from Disk** button to `#editor-header` (and file tab chrome), plus Editor settings (Word Wrap default, Tab Size) in `#settings-panel`.

### 3.3 Folder Upload Picker Button (`webkitdirectory`)
- **Current State:** Drag-and-drop onto the file explorer supports recursive directory trees via `webkitGetAsEntry()` (`public/js/files.js:2218`) and `preservePath: 'true'` (`lib/server/files.js:686`). However, clicking the **Upload** button in `#file-toolbar` (`public/index.html:168, 224`) triggers `<input type="file" id="upload-input" multiple>`, which only allows selecting individual files.
- **Impact:** Users on mobile/tablet browsers (where OS drag-and-drop of folders is unavailable) or users who prefer the toolbar button cannot upload a folder hierarchy.
- **Proposed Implementation:**
  - Add an **Upload Folder** button (or dropdown option alongside Upload Files) wired to an `<input type="file" webkitdirectory multiple>` that passes each file's `webkitRelativePath` to `POST /api/files/upload` with `preservePath=true`.

### 3.4 `.tar.gz` / `.tgz` / `.tar` Archive Creation & Extraction
- **Current State:** `EXT_KIND` (`public/js/files.js:368`) marks `.zip`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.xz`, `.7z`, and `.rar` with the archive icon, and `public/js/files.js:1451` checks `/\.(zip|tar|gz|tgz)$/i`. However, `POST /api/files/unzip` (`lib/server/files.js:899–946`) only supports `.zip` via `yauzl` and rejects `.tar.gz` / `.tgz` / `.tar` archives.
- **Impact:** On Linux and macOS servers, `.tar.gz` and `.tgz` are the most common archive formats (e.g., `npm pack` tarballs, release bundles, log backups).
- **Proposed Implementation:**
  - Extend archive extraction and creation in `lib/server/files.js` to support `.tar`, `.tar.gz`, and `.tgz` (using system `tar` with path-traversal validation matching `lib/cloudflared.js:84–108`), and enable **Extract Here** in `#ctx-menu` for `.tar.gz`/`.tgz`/`.tar` files.

### 3.5 CSV / TSV / JSONL Interactive Table Preview
- **Current State:** `.xlsx` and `.xls` spreadsheets render as formatted HTML tables (`openXlsxViewer` in `public/js/files.js:1165`), whereas `.csv` and `.tsv` files open only as raw comma/tab-separated text.
- **Proposed Implementation:**
  - Add a **Table Preview** toggle (`#editor-preview-btn`, matching Markdown/HTML preview) for `.csv` and `.tsv` files that renders a sortable, filterable sticky-header table while keeping raw text editing in CodeMirror.

---

## Tier 4: Terminal, Git & System Observability Features

### 4.1 OSC 133 Shell Integration UI (Prompt Jump, Command Duration & Exit Codes)
- **Current State:** `public/js/terminal.js:346–349` already intercepts OSC `133` sequences (`\x1b]133;A/B/C/D...`) with the comment:
  ```js
  if (code === '133') {
    // Handled silently — available for future command tracking
    return;
  }
  ```
- **Missing Feature:** The parsed OSC 133 events (`A` = prompt start, `B` = command start, `C` = execution start, `D;exitCode` = command finished) are discarded.
- **Proposed Implementation:**
  - Record xterm buffer line markers on `133;A` and exit codes/durations on `133;D`.
  - Add **Jump to Previous/Next Command** (`Ctrl+Up` / `Ctrl+Down`), **Copy Last Command Output** in `#term-ctx-menu`, a visual badge or toast when a long-running background command (`>10s`) finishes with its exit code, and optional Desktop Notification when the tab is unfocused.

### 4.2 Broadcast Input to All Terminals in Tile View (Multi-Exec)
- **Current State:** Tile View (`toggleTileMode()` in `public/js/terminal.js:972`) displays up to 4 terminals side-by-side in a 2×2 grid (`layoutTiles()`). However, keystrokes only go to the single focused terminal.
- **Proposed Implementation:**
  - Add a **Broadcast Input** toggle button in the top bar (visible when 2+ terminal tabs exist or Tile View is active). When enabled, keystrokes and pasted snippets in any terminal tab are forwarded to all participating terminal tabs simultaneously—ideal for running updates or tailing across multiple SSH sessions/containers.

### 4.3 Export / Save Terminal Scrollback Buffer
- **Current State:** `#term-ctx-menu` (`public/index.html:727–736`) offers Copy, Paste, Select All, Search, Split, and Clear, but no way to save the full scrollback buffer (up to 10,000 lines) to a file or download it locally.
- **Proposed Implementation:**
  - Add **Export Output (.txt)** and **Save to Workspace…** to `#term-ctx-menu`, extracting lines from `tab.term.buffer.active` and either downloading them as a timestamped `.log` file or writing them via `POST /api/files/write`.

### 4.4 Parameterized Command Library Snippets (`{{variable}}` Placeholders)
- **Current State:** Command Library snippets (`public/js/misc.js:255–380`) execute immediately with `\r` or paste into the terminal verbatim.
- **Proposed Implementation:**
  - Detect `{{placeholder}}` or `{{name=default}}` tokens inside a snippet when clicked. Before sending to the terminal, prompt the user in a lightweight modal to fill in the parameter values (e.g., `docker logs -f {{container_name}}` or `git checkout -b {{branch}}`).

### 4.5 Git Stash Management (List / Preview / Apply / Drop) & File Commit History
- **Current State:**
  - `lib/server/git.js:437–486` (`POST /api/git/stash`) only supports pushing a stash and popping `stash@{0}`, and `GET /api/git/status` only returns the stash count (`stashCount`). Users cannot view the list of stashes, preview what is inside a stash, apply a stash without dropping it, or drop a specific stash entry.
  - While `GET /api/git/blame` (`lib/server/git.js:491`) shows line-by-line blame, there is no per-file commit history (`git log --follow -p -- <file>`).
- **Proposed Implementation:**
  - Add `GET /api/git/stashes` (`git stash list`) and `POST /api/git/stash/action` (`apply`, `pop`, `drop`, `show` for `stash@{N}`) with an expandable **Stashes** section in `#git-panel`.
  - Add a **File History** button next to **Git Blame** in `#editor-header` (`#editor-blame-btn`) showing commits that touched the active file and opening their diffs on click.

### 4.6 Interactive Git Merge Conflict Resolver in Editor
- **Current State:** Conflicted files are listed under `Conflicted` in `#git-panel` (`public/js/git.js`), and clicking one opens it in the editor with raw `<<<<<<< HEAD`, `=======`, `>>>>>>>` markers that must be edited by hand.
- **Proposed Implementation:**
  - Detect conflict markers when opening a file in CodeMirror and render inline action widgets or a conflict navigation bar (**Accept Current**, **Accept Incoming**, **Accept Both**, **Next/Prev Conflict**), followed by a one-click **Stage Resolved File** button.

### 4.7 Multi-Mount Disk Usage & Real-Time Sparklines in System Stats
- **Current State:** `collectSystemStats()` (`server.js:647–656`) runs `df -h /` on Linux/macOS, reporting only the root `/` filesystem and ignoring attached volumes, external drives, or separate `/home` / `/var` / `/mnt` partitions. Additionally, `#sys-overlay` only renders instantaneous bars with no historical trend.
- **Proposed Implementation:**
  - Return all local block filesystems from `df -h -x tmpfs -x devtmpfs` in `/api/system` and render per-mount usage bars in `#sys-overlay`.
  - Maintain a 60-sample rolling ring buffer in `fetchSystemStats()` (`public/js/ui.js`) to draw lightweight SVG sparklines for CPU % and Memory % inside `#sys-overlay`.

---

## Prioritized Implementation Matrix

| ID | Feature | Category | Backend Status | Effort | Impact |
|----|---------|----------|----------------|--------|--------|
| **1.1** | Live Log Tail Viewer (`/api/files/tail` SSE) | Tier 1 (Quick Win) | **Already Built** (`files.js:1409`) | Low | High |
| **1.2** | Network Interfaces, Gateway & DNS UI (`/api/system/network`) | Tier 1 (Quick Win) | **Already Built** (`server.js:415`) | Low | High |
| **1.3** | Create Symlink Dialog (`/api/files/symlink`) | Tier 1 (Quick Win) | **Already Built** (`files.js:1195`) | Low | Medium |
| **1.4** | Batch Copy / Cut / Zip in Multi-Select Toolbar | Tier 1 (Quick Win) | **Already Built** (`files.js:1158`) | Low | High |
| **1.5** | One-Click Cloudflare Tunnel in Listening Ports Modal | Tier 1 (Quick Win) | **Already Built** (`/api/tunnel`) | Trivial | High |
| **1.6** | Inline Audio & Video Player (HTTP 206 Range Streaming) | Tier 1 (Quick Win) | **Already Built** (`files.js:775`) | Low | Medium |
| **2.1** | Server-Side Shared Command Library & Bookmarks Sync | Tier 2 (Commercial/Team) | Needs `/api/library` & `/api/bookmarks` | Medium | High |
| **2.2** | Security Audit Log & CSV/JSON Export (`/api/audit/export`) | Tier 2 (Commercial/Team) | Needs `lib/server/audit.js` | Medium | High |
| **2.3** | Runtime Policy UI (`PREVIEW_PORTS` & `ALLOWED_ORIGINS`) | Tier 2 (Commercial/Team) | Partial (env-only today) | Medium | Medium |
| **2.4** | Stripe Customer Billing Portal (`/api/billing/portal`) | Tier 2 (Commercial/Team) | Partial (`server.js:304`) | Low | Medium |
| **3.1** | CodeMirror Find, Replace & Go-to-Line (`Ctrl+F`/`Ctrl+H`/`Ctrl+G`) | Tier 3 (Editor/Files) | Client-only | Low | High |
| **3.2** | Editor Word Wrap / Tab Size Controls & Split-Panel Reload Button | Tier 3 (Editor/Files) | Client-only | Low | High |
| **3.3** | Upload Folder Picker Button (`webkitdirectory`) | Tier 3 (Editor/Files) | **Already Built** (`preservePath`) | Low | High |
| **3.4** | `.tar.gz` / `.tgz` / `.tar` Archive Extraction & Creation | Tier 3 (Editor/Files) | Partial (`.zip` only today) | Medium | High |
| **3.5** | CSV / TSV Interactive Table Preview | Tier 3 (Editor/Files) | Client-only | Low | Medium |
| **4.1** | OSC 133 Shell Integration UI (Prompt Jump, Duration, Exit Code) | Tier 4 (Terminal/Git/Sys) | Partial (`terminal.js:346`) | Medium | High |
| **4.2** | Multi-Terminal Broadcast Input in Tile Mode | Tier 4 (Terminal/Git/Sys) | Client-only | Low | Medium |
| **4.3** | Export / Save Terminal Scrollback Buffer to File | Tier 4 (Terminal/Git/Sys) | **Already Built** (`/api/files/write`) | Low | Medium |
| **4.4** | Parameterized Command Library Snippets (`{{var}}`) | Tier 4 (Terminal/Git/Sys) | Client-only | Low | Medium |
| **4.5** | Git Stash List/Preview/Apply/Drop & Per-File Commit History | Tier 4 (Terminal/Git/Sys) | Partial (`git.js:437`) | Medium | High |
| **4.6** | Interactive Git Merge Conflict Resolver (`Accept Current/Incoming`) | Tier 4 (Terminal/Git/Sys) | Client-only | Medium | Medium |
| **4.7** | Multi-Mount Disk Usage & CPU/RAM Sparklines in System Stats | Tier 4 (Terminal/Git/Sys) | Partial (`server.js:647`) | Low | Medium |

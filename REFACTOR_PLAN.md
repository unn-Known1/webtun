# app.js Refactor Plan

**Date:** 2026-09-16 · **Status:** IMPLEMENTED 2026-09-16 (commits `20e16fd`, `e89ce6b`, `787585d`)
**Decisions locked:** 15-file split (as below) · shared state as top-level `let` in `core.js` · phased extraction starting with `ui.js` + `core.js`
**Reviewed 2026-09-16:** verified CSP, `sw.js`, script tags, duplicate declarations, top-level side effects, inline-handler inventory — gaps fixed below. Guarantees in §7.
**Post-implementation review:** all checks green, see §8. Two deviations from the table: (a) keyboard-shortcuts + terminal select/scroll/clipboard/mobile-keys section lives in `terminal.js`, not `settings.js` (more coherent — terminal-input behaviors); (b) `escHtml()` moved into `core.js` (universal util).

## 1. Current shape

- `public/js/app.js`: **10,491 lines / 481 top-level functions**, one classic script, everything in shared scope.
- No modules, no bundler (deliberate architecture: vanilla, split by asset type). The refactor must stay classic `<script defer>` files in dependency order — **not** ES modules, **not** a build step.
- Load order today: `theme-init.js` first in `<body>`, then deferred CDN scripts + `app.js`. All calls happen post-load (`startApp()` last), so cross-file references resolve as long as every file loads before boot.

## 2. Proposed split

| # | File | Contents | ~Lines in app.js |
|---|------|----------|------------------|
| 1 | `js/core.js` | Small utils (`escHtml`, `fmt*`, `uuid`), safe storage, `api()`, `sendWsInput`, tab/file state persistence, boot/offline screen, PIN/auth/session, shared mutable state (`tabs`, `settings`, `currentPath`, …) | 1–530 |
| 2 | `js/ui.js` | `toast`, `confirmDialog`, `openOverlay`/`closeOverlay`, focus trap, `setBtnBusy`, field errors, conn status, PLUS the scattered shared helpers moved verbatim: `updateEditorDirty` (~5067), `hideTermLoading` (~742), `resetSettings` (~6898), `setupMoreMenuKeyboard` (~7776), `openShortcuts` (~8570) | 8570–8884 + the 5 scattered helpers |
| 3 | `js/tabs.js` | Tab create/activate/close (`closeTab`), drag-drop, swipe, inline rename, tiles layout | 550–830, 2288–2360, 3020–3095, 8062–8140 |
| 4 | `js/terminal.js` | WS connect/reconnect, `handleClientEvent`, xterm init/fit/themes, modifier keys, scroll handlers, mobile keys | 1932–2288, 2615–3145, 8150–8455 |
| 5 | `js/files.js` | Listing, rows (`makeFileItem`, `fitFileName`, `fileRowName`), sort, breadcrumb, ctx menu, file ops, selection, watcher, drag-drop/uploads | 3146–4675, 8436–8570 |
| 6 | `js/transfers.js` | `tx*` transfer jobs + progress UI | 4675–5010 |
| 7 | `js/editor-panel.js` | Split-panel CodeMirror, drafts (`wt-draft:<path>`), save/close | 5010–5420 |
| 8 | `js/file-tabs.js` | File tabs, dock/undock, per-tab editor, per-tab preview paint | 830–1575 |
| 9 | `js/preview.js` | Preview tabs, proxy nav, health loop, port cache | 1575–1932 |
| 10 | `js/viewers.js` | Image / PDF / EPUB / Office viewers + HTML/MD preview render | 5418–6790 |
| 11 | `js/launchpad.js` | Launchpad, pulse, screensaver | 2362–2615 |
| 12 | `js/settings.js` | Settings store, theme/font/sizes, sidebar, menus, splits, wake-lock, shortcuts | 6847–7226, 7682–8062 |
| 13 | `js/security.js` | Sessions, PIN change flow, security alerts, tunnels | 7227–7680 |
| 14 | `js/git.js` | Whole git panel (status/diff/log/hunks/stash/tags/branches/identity) | 9019–9741 |
| 15 | `js/misc.js` | Bookmarks, finder, cmdlib/history, sys stats, PWA, `startApp()` boot | 8885–9018, 9742–10491 |

## 3. Cross-cutting constraints (do not break)

1. **Shared state:** top-level `let` in `core.js` stays visible to all later classic scripts. No export machinery. `core.js` loads first (after `theme-init.js`).
2. **Inline handlers — 106 names:** `index.html` has 106 distinct `onclick="fn(...)"` handlers (plus more generated at runtime in JS template strings, e.g. ctx menus, git rows). Every one of them must remain a top-level `function` declaration (they become `window` props). Never convert those to `const` arrows. Pre-flight: re-run the inventory (`grep -o 'onclick="…'` on `index.html` + `app.js`) and confirm each resolves after the split.
3. **Loading — `app.js` is NOT deferred:** despite the "all `<script defer>`" claim, `index.html:949` is `<script src="js/app.js"></script>` (no `defer`, end of `<body>`; only `commands.js` has `defer`). Parser-inserted scripts at end of body execute in document order with DOM ready — replicate exactly: N plain `<script src="js/….js">` tags in dependency order at the same position. Do NOT add `defer` (would change execution timing relative to `commands.js`).
4. **`sw.js` (verified 2026-09-16):** `CACHE = 'webtun-v7'`, `PRECACHE` lists `'/', '/index.html', '/css/styles.css', '/js/app.js', '/js/theme-init.js', '/docs.html', '/manifest.json', '/commands.js', '/favicon.png', '/icon.svg', '/icon-192.png', '/icon-512.png'`. Replace `'/js/app.js'` with the 15 new paths **and** bump to `webtun-v8`, or new entries never install. Per-entry caching already isolates single-file failures.
5. **CSP (verified 2026-09-16, no change needed):** `server.js:212` has `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net blob:` — same-origin splits load with no server change. No per-file allowlist exists.
6. **Verbatim moves only:** move code byte-for-byte — no `let`→`const`, no arrow conversion, no renaming, no bug fixes. Improvements get their own commits. Exception: the scattered-helper relocation in §4a, still verbatim.
7. **Single definition:** utils used across files (`escHtml`, `fmt*`, `uuid`, storage wrappers) are defined ONCE in `core.js`. Top-level `const`/`let` redeclared in two classic scripts is a hard `SyntaxError` — never copy a helper into two files.
8. **Duplicate declaration (verified 2026-09-16):** `showTabEditor` is declared TWICE (`app.js:1201` and `:1208`; later wins). Both copies must land in the SAME new file in the SAME relative order. Pre-flight every phase with `grep -oP "^function \K\w+" … | sort | uniq -d` and preserve win-order for any duplicate.
9. **`nodemon.json`** already ignores only runtime state files — new `js/*.js` files restart dev server on save, which is the desired behavior. No change.
10. **`/docs`:** no user-facing change, so no docs update required. If any behavior shifts during the move, document it in the same change.

## 4. Phases

- **Phase 0 (pre-flight, every phase):**
  1. Duplicate-declaration scan (§3.8) — preserve win-order.
  2. Top-level side-effect audit: known load-time statements are `document` click dismiss (`:4145`), preload `setTimeout` (`:6321`), two `visibilitychange` listeners (`:8056`, `:10227`), `beforeinstallprompt` (`:10384`), `beforeunload` (`:10482`), plus load-time `addEventListener` blocks (path-input, term-ctx menu, …). Rule: event/timer *registrations* may live in any file (handlers fire after full load), but any top-level statement that *calls* another file's binding at load time must move into `startApp()` or stay ordered after its dependency.
  3. Inline-handler inventory (§3.2).
- **Phase 1 (prove the pattern):** extract `core.js` + `ui.js` (incl. the 5 scattered helpers). Lowest risk, highest fan-out — validates ordering + state sharing.
- **Phase 2 (biggest wins):** extract `git.js` + `viewers.js`. Largest, most self-contained, fewest cross-refs.
- **Phase 3:** everything else per the table.
- **Phase 4:** delete `app.js`, final full pass.

## 5. Verification (every phase)

1. `node --check` on each new file.
2. **Concatenation-equivalence (the no-change proof):** `cat` the extracted files in load order plus the remaining `app.js` remainder and `diff` against the `git HEAD` version of `app.js` — must be byte-identical. Any diff = accidental edit, fix before proceeding.
3. Duplicate scan + inline-handler inventory resolve clean (§3.8, §3.2).
4. CSS brace balance if touched (958/958 baseline).
5. `npm start` boot + smoke: terminal connect, file list, open/save editor file, git panel, preview tab.
6. Confirm no new console errors; confirm `registerSW()` still precaches (check `sw.js` entry list).
7. Commit per phase (rollback = `git revert` that phase's commit), push at the end (or per user request).

## 6. Risks

- **Load-order bugs:** a function used at parse time (not call time) by an earlier file. Mitigation: keep execution order `core → … → misc`, boot last; Phase 0 audit catches load-time callers.
- **`let` temporal dead zone:** cross-file use before `core.js` executes. Mitigation: nothing runs before `startApp()`.
- **SW staleness:** forgetting the `CACHE` bump serves old `app.js` + new files. Mitigation: checklist item in every phase.
- **Scope creep:** do not fix bugs or rename while moving. Move verbatim; improvements get their own commits.

## 8. Post-implementation review (2026-09-16, static only — no server started)

1. **Byte-equivalence:** every phase proved moved bytes identical to `git HEAD` before writing; `app.js` diffs show pure deletions.
2. **Definition inventory:** all 481 top-level functions + all top-level `const`/`let` present exactly once across the 16 scripts — zero lost, zero duplicated (vs pre-refactor `app.js`).
3. **Load-order smoke (vm harness with browser stubs):** all 16 scripts load in `index.html` order with zero load-time errors; `showTabEditor` duplicate preserved in win-order inside `file-tabs.js`.
4. **Inline handlers:** all 108 handler functions referenced by `onclick` (106 in `index.html`, 7 in JS templates) resolve as globals. The only 2 non-resolving names are `document`/`event`, which are argument references, not callees.
5. **Wiring:** `index.html` has 15 ordered `<script>` tags (no `defer`, same as before); `sw.js` is `webtun-v8` with all 15 precached; zero remaining references to `js/app.js` (checked `public/`, `electron/`, `server.js`, `bin/`).
6. **Testing constraint:** the user forbade starting the app (a second server disturbs their live WebTun instances via shared startup cleanup), so verification is static-only. **Browser smoke test still owed:** terminal connect, file list, open/save editor file, git panel, preview tab — run when the user can afford a restart.

## 7. Why functionality cannot change

1. Classic scripts share one scope — a top-level `function`/`let` in `core.js` is visible to `misc.js` exactly as if it were line 1–530 of the same file.
2. Execution order is preserved (ordered `<script>` tags = original line order), so hoisting, duplicate win-order, and load-time statements behave identically.
3. `§5.2` concatenation-equivalence proves the moved code is byte-identical to HEAD.
4. CSP needs no change (`'self'` covers all new files); SW precache + bump keeps offline identical; smoke test covers every feature area.

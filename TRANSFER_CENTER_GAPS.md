# Transfer Center — Plan Gap Report

Date: 2026-09-15
Plan under review: transfers icon + hover/click panel next to coffee cup, WebTun-native style, download via stream reader.
Agreed scope (2026-09-15): **Phase 1 = upload + download** (real bytes + speed, the quality win); **Phase 2 = copy/move** (per-file `n/m` + best-effort bytes); **Deferred = delete/zip/unzip** (stay as toasts, no progress rows — see Verdict).
Codebase: `server.js`, `public/index.html` (single-file frontend, ~11.8k lines, no test/lint commands), `public/docs.html`.

This report lists only gaps — things the plan assumes, omits, or that contradict current behavior. Each gap has location, impact, and a fix/decision.

---

## G0 — Scope decision not reflected in plan: frontend ignores existing batch endpoints

- Server already has batch endpoints (`server.js:1883` `POST /api/files/batch-delete`, `:1946` `batch-copy`/`batch-move`, `:2124` `batch-zip`, max 100 paths each, returns `{ results, succeeded, failed }`).
- Frontend does NOT use them: `pasteFile()` (`index.html:6039`) loops one `POST /api/files/copy|move` per file; `deleteSelected()` (`:6256`) does `Promise.allSettled(DELETE /api/files)` per file; `ctx-zip` handler (`:5971`) loops `zipFile()` per file.
- Impact: per-file progress forces keeping the N-request loop for copy/move (good for progress + per-file conflict), which leaves batch endpoints as dead code. Batch-zip's multi-source single-zip behavior is never surfaced.
- Decision (agreed): **Phase 1 (upload/download) needs no batch decision. Phase 2 keeps the per-file loop for copy/move; do not adopt batch-copy/move in the same release.** Delete/zip stay on their current paths (toasts only) — no batch migration, no progress rows (see Verdict).

## G1 — Download has no `Content-Length`, so `%` is impossible without a server change

- `GET /api/files/download` (`server.js:1686`): single-file branch sets `Content-Type` + `Content-Disposition` then `stream.pipe(res)` (`:1712-1718`) with **no `Content-Length`**. Directory-zip branch streams archiver output — length unknowable.
- Impact: stream-reader plan yields bytes + speed but **no % / ETA** unless server adds `Content-Length: st.size` (stat already exists at `:1693`). Zip-dir downloads stay indeterminate forever.
- Fix: server sets `Content-Length` for files; client treats missing length as indeterminate (bytes + speed only). Plan must state this explicitly.

## G2 — `api()` 30s timeout kills long server-side ops (Phase 2 only)

- `api()` (`index.html:2794`) aborts at 30s and returns `{ error: 'Request timed out (30s)' }`.
- Phase 1 is unaffected (XHR upload has no `api()` timeout; streaming download uses raw fetch). Phase 2 copy/move of large trees can exceed 30s server-side (recursive `cp`, `dirSize` walk up to 50k entries). The client would show "failed" while the server keeps copying — a lie with destructive consequences.
- Frontend precedent: git fetch uses 90s raw fetch because `api()` caps at 30s (AGENTS.md).
- Fix: Phase 2 TransferManager paths must use **raw `fetch` with `AbortController` + extended/no timeout** for copy/move/size, not `api()`. Delete/zip/unzip need no fix — deferred, toasts stay as-is.

## G3 — Cancel is a lie for server-side ops (Phase 2 only)

- Upload cancel works (`xhr.abort()`, `:6375`). Download cancel works (reader + `AbortController`).
- Copy/move: aborting the fetch only drops the HTTP connection; `fs.cp` / `renameWithFallback` keep running on the server. There is no job-id / cancel endpoint.
- Impact: a panel "Cancel" on a Move row would show "cancelled" while files keep moving.
- Fix: Phase 2 cancel = **"stop after current file"** (don't fire the next request) — honest and useful — but current-file work is uninterruptible. Never claim server work stopped. Delete/zip/unzip need no cancel — deferred.

## G4 — Conflict flow stalls a progress job

- `pasteFile()` on `{ conflict }` response removes the toast, stores `_conflictResolve`, opens `conflict-overlay` (`:6064-6071`), and **returns**. A transfer job would sit at e.g. 40% with no explanation while the modal is open; `resolveConflict()` resumes via `pasteFile(destDir, mode, resumeFrom)` (`:6089`).
- Fix: job states must include `waiting-conflict` (pauses speed/ETA clock), and the conflict modal must carry job id so approve/skip/merge resumes the right job. Stale-clipboard guard (`:6093`) must also fail the job cleanly.

## G5 — Size preflight doubles tree walks and has its own failure modes

- Plan proposes pre-fetching sizes (`GET /api/files/size` → `dirSize()`, `server.js:1860`, max 50k entries, symlink rules) to turn per-file counts into byte progress.
- `dirSize()` itself walks the whole tree and can 413/500 on huge dirs; doing size-then-copy doubles I/O and latency before the bar moves at all. Symlinked files are never counted (`server.js:954-959`), so byte totals can disagree with actual copy bytes.
- Fix: make preflight best-effort with timeout, fall back to per-file `n/m` progress, and show "Calculating size…" as an explicit job phase. Never block the op on size failure.

## G6 — Download streaming still buffers the whole file in RAM

- Even with `getReader()`, assembling `new Blob(chunks)` for `URL.createObjectURL` holds the entire file (up to 500MB single / 1GB zip) in tab memory, plus `a.click()` + `revokeObjectURL` dance (`:6161-6172`).
- Impact: big-file progress looks great then the tab OOMs. True disk streaming needs File System Access (`showSaveFilePicker`, HTTPS/localhost only, permission-gated) with anchor-download fallback.
- Fix: plan must include fallback chain: File System Access when available → blob accumulation with memory warning over ~200MB → direct `<a href>` no-progress for huge files. Also note `downloadSelected()` (`:6281`) fires N sequential anchor clicks with 300ms delay — popup blockers may eat all but the first; multi-job vs single-merged-job model must be decided.

## G7 — Upload folder structure is flattened (progress label vs reality)

- Drag-folder traversal (`:9890-9902`) collects `{ file, path }`, but `uploadFileList()` (`:6386`) posts each file with only `fileName` and the server stores flat in `destDir` (sanitized basename, `server.js:1734-1750`). Subdirectories are lost.
- Impact: "Uploading folder/a/b.txt (45%)" implies structure that won't exist on disk.
- Fix: either document flat behavior in the job label or add relative-path support server+client (out of scope for v1 — recommend label honesty).

## G8 — DEFERRED: `deleteSelected()` parallelism (no change in agreed scope)

- `Promise.allSettled` over all selected paths (`:6261`) fires deletes concurrently; a naive `n/m` bar would jump. `isDeletablePath` (`server.js:1467`) refuses workspace root with a generic 400.
- Decision (agreed): delete stays toast-only. No sequentialization, no progress row. Kept here so a future phase knows the prerequisite (sequential loop under TransferManager) if delete progress is ever revived.

## G9 — DEFERRED: Zip/unzip have no progress signal (no change in agreed scope)

- `POST /api/files/zip` (`:1527`: 1GB guard + auto-rename `name (n).zip`) and `unzip` (`:1562`: magic check, 409 when dest non-empty, temp-dir + rename) are single calls returning only on completion. There is no byte channel — showing "MB/s" would be fabricated.
- Decision (agreed): zip/unzip stay toast-only. If revived later: indeterminate bar + elapsed + file count, never speed/ETA, and surface specific outcomes (auto-renamed to `X (2).zip`, `409 Destination already exists`).

## G10 — Hover-open has no touch equivalent; panel collides with existing chrome

- Plan: "hover opens, click pins". Touch devices have no hover; `#more-menu`, settings panel, and `openOverlay()` focus traps compete for outside-click/Esc handling. Current `#upload-progress` bar (`index.html:202-210`, `:1484`) sits absolute at header bottom — the new ring/bar must define what happens to it (remove vs keep) or both animate at once.
- Fix: hover = open on `mouseenter` (fine pointer only), click = toggle pin, panel closes on outside-click/Esc; on coarse pointers click-only. Define z-index above `#upload-progress` and below overlays. Remove old bar in same change to avoid dual progress. Persist pin-open? No — session-only (see G11).

## G11 — Job lifetime, history, and storage undefined

- Plan doesn't say whether jobs survive reload, whether finished jobs persist, or where. `safeStorage` wrapper (`:1387`) exists because Edge tracking prevention breaks `localStorage` on tunnel domains — any persistence must go through it, but active byte counts must never persist.
- Fix: jobs are **in-memory only**; finished jobs linger max N (e.g. 10) with Clear/Dismiss; no localStorage. Toast cap (4) stays; panel list scrolls.

## G12 — Auth expiry mid-transfer

- All file routes sit under `checkPin`; `api()` 401 triggers `showPinScreen()` (`:2810`). A PIN rotation revokes all sessions and kills sockets (server `applyPinRotation`). A 500MB upload spanning a rotation will 401 midway.
- Fix: transfer errors must map 401 → "Session expired — sign in again" (not "failed"), and cancel remaining queue. `?token=` vs header: XHR uses `x-pin-token` header (`:6407`) — streaming download fetch must do the same (no token in URL).

## G13 — Accessibility + themes + datasaver gaps

- Plan says "WebTun native" but doesn't specify: `role="progressbar"` + `aria-valuenow`, `aria-live="polite"` for speed text (throttled, not per-chunk), focus-visible styles, `prefers-reduced-motion` disabling arrow/steam-style animation, WCAG-AA `--fg` on new surfaces across all 6 themes, `color-scheme` correctness.
- `settings.datasaver` already pauses sys-icon pulse (`:11555`); transfers panel must respect it too (no animated arrows, text-only updates at ≤1Hz).

## G14 — Docs / PWA / CSP checklist missing from plan

- AGENTS.md requires: user-facing feature → update `public/docs.html` in the same change (section + TOC + `data-title` keywords), single-file zero-dependency offline-safe, relative asset paths only. Plan mentions it but doesn't note `sw.js` cache `webtun-v6` precache implications (none needed — panel lives in `index.html`) or CSP (`connect-src 'self' … blob:` already allows blob download URLs; File System Access needs no CSP change).
- Fix: include docs diff + `npm start` manual matrix (Phase 1: small/large upload, single/batch download with/without length; Phase 2: copy with conflict, move stop-after-current, 30s+ op proving no false timeout; both: tunnel + mobile widths).

## G15 — Speed/ETA math unspecified (will jitter without smoothing)

- Raw per-event `loaded/dt` jitters wildly. Plan says "speed" but defines no smoothing window, no ETA freeze when stalled, no indeterminate rules.
- Fix: EMA over ~1s window, update text at ≤4Hz (upload code already rate-limits text to 250ms — reuse that pattern, `:6411-6420`), freeze ETA after 3s stall and show "Stalled…", hide ETA when total unknown or speed ~0.

---

## Recommended plan amendments (agreed scope)

Phase 1 — upload + download (build first, the quality win):
1. Server: add `Content-Length` on single-file download; nothing else server-side.
2. Client: TransferManager with real bytes + smoothed speed/ETA; streaming download via raw fetch + reader (missing length = indeterminate bytes + speed only); replace (not duplicate) `#upload-progress`.
3. Cancel honesty: abort XHR/fetch — true cancel for both.

Phase 2 — copy/move (build second):
4. Per-file loop kept (progress + per-file conflict); raw fetch with long timeout (never `api()`); best-effort size preflight with `n/m` fallback and explicit "Calculating size…" phase; `waiting-conflict` job state wired to existing overlay; cancel = "stop after current file".

Deferred — delete/zip/unzip: toasts stay as-is, no rows, no cancel changes (G8/G9 kept as revival notes).

Cross-cutting (both phases):
5. Hover open on fine pointers only, click toggles pin; in-memory jobs only (max ~10 finished, Clear/Dismiss); datasaver + `prefers-reduced-motion` respected; `role="progressbar"` + throttled `aria-live`.
6. 401 mid-transfer → "Session expired", cancel queue; `x-pin-token` header on streaming fetch, never `?token=`.
7. Docs (`public/docs.html` section + TOC + `data-title`) + `npm start` manual matrix in same change: small/large upload, single/batch download with/without length, copy with conflict, move stop-after-current, 30s+ op proving no false timeout (Phase 2), tunnel + mobile widths.

## Post-test fixes (2026-09-15 — "% stayed blank on large files")

- Upload painted progress inside `requestAnimationFrame`, which never fires in a background/hidden tab — exactly when a big upload runs longest. Now paints directly (`txTick` → throttled `txRender` already rate-limits DOM writes).
- Download `%` depended solely on the `content-length` header (needs restarted server; proxies/tunnels may strip it). Now falls back to best-effort `GET /api/files/stat` size for files; directory zips stay indeterminate.
- Copy/move showed a dead 0% for a single in-flight file (one atomic POST, no intra-file signal). Now: determinate % only with real movement (bytes flowing or files completing); otherwise an honest shimmer + verb + size + elapsed ("Copying… · 2.4 GB · 8s elapsed"). Multi-file `n/m` was already live.

## Verdict — is it a good idea?

Yes, rescoped. Upload + download progress fixes a real hole (today: 6px upload bar, zero download feedback — the app looks frozen on slow tunnels moving large files). Copy/move per-file progress is worth it second. Delete/zip/unzip rows are not: delete is instant-or-toastable, zip/unzip have no byte channel so any "speed" would be fabricated, and each extra op type multiplies edge cases (conflict-pause, timeout, fake cancel) in an 11.8k-line single-file frontend with no test harness. Shipping Phase 1 + 2 delivers the visible improvement with roughly half the code and none of the dishonest progress.

*Sources: `server.js:1686-1723` (download), `:1726-1779` (upload), `:1437-1463` (copy/move), `:1527-1611` (zip/unzip), `:1883-1947` (batch endpoints), `:1467-1497` (delete guards); `public/index.html:202-210` (old bar), `:1449-1454` (coffee cup), `:2794-2820` (api 30s), `:5960-6119` (clipboard/paste/conflict/zip), `:6154-6174` (download), `:6281-6291` (multi-download), `:6337-6489` (upload), `:9890-9908` (drag-drop).*

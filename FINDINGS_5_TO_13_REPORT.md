# Full Audit — Verification & Implementation Report

Verified against tree at `47d1a55` (v2.2.1) on 2026-09-17. Verdicts: ✅ confirmed · 🔶 partial (narrower than claimed) · 🔕 stale (already fixed) · ⏸️ needs decision.

**Heads-up:** several audit claims describe pre-fix code. The tree has moved on (frontend split into 16 files under `public/js/` — there is no `public/js/app.js` anymore; `lib/zip-read.js` now validates CRC+size; `sw.js` uses `e.waitUntil`; `stop.sh` escapes its `pkill` pattern). Stale items are marked so nobody re-implements them.

---

## Part A — Numbered findings 5–13

### 5. Remove unused `memTheme` — ✅ CONFIRMED, safe one-liner

**Evidence:** `public/docs.html:820` declares `var memTheme = null;`, `:833` assigns `memTheme = t;`. Zero reads (`rg memTheme` → 2 hits, both writes).

**Fix:** delete both lines.

**Verify:** `rg -n "memTheme" public/docs.html` → no output; open `/docs`, toggle theme, reload (choice persists via `wt-docs-theme` — untouched).

### 6. Remove `ws` override — ✅ CONFIRMED redundant, safe to delete

**Evidence:** the root package is the **only** `ws` consumer — no transitive `ws` deps (`npm ls ws` → single `ws@8.21.3`). `overrides.ws` only constrains transitive copies, so it is a no-op.

**Fix:** delete the `"ws": "^8.21.3"` override line, run `npm install`.

**Verify:** `npm ls ws` → still single `ws@8.21.3`; `npm audit --omit=dev` clean; boot + open a terminal (WS path exercised).
**Caveat:** if a future dependency pulls an old/vulnerable `ws` range, re-add a pinned override then.

### 7. Add `.env.example` — ✅ CONFIRMED missing

**Evidence:** `ls .env.example` → no such file.

**Fix:** create with all supported vars (from `server.js` + AGENTS.md):
```ini
# WebTun example config — copy to .env and edit. Never commit a real .env.
PORT=3000
HOST=
PIN=
SHELL=
WORKSPACE_ROOT=
TRUST_PROXY=false
WEBTUN_SHELL=
ALLOWED_ORIGINS=
PREVIEW_PORTS=
```
Note `PIN=` empty = no auth; `TRUST_PROXY=true` only behind a reverse proxy; `PREVIEW_PORTS` unset = any port except WebTun's own. Values stay empty/dummy — never real secrets.

**Verify:** `npm start` behavior unchanged (server only reads `.env`, never `.env.example`).

### 8. Add `timeout-minutes` to CI — ✅ CONFIRMED missing everywhere

**Evidence:** `rg timeout-minutes .github/workflows/` → zero hits (5 jobs in `build.yml`, 1 in `pr-check.yml`).

**Fix:**

| job | timeout |
|---|---|
| `pr-check.yml` → `verify` | 10 |
| `build.yml` → `verify` | 10 |
| `build.yml` → `build-windows/linux/mac` | 45 (Electron builds + 5× retry loops) |
| `build.yml` → `release` | 10 |

### 9. Pin third-party actions to SHAs — ✅ CONFIRMED, all mutable tags

**Evidence:** 20 `uses:` lines, all floating major tags. Resolved 2026-09-17 (re-resolve at merge time if stale):

| action | pin |
|---|---|
| `actions/checkout@v5` | `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5` |
| `actions/setup-node@v5` | `actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5` |
| `actions/cache@v6` | `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6` |
| `actions/upload-artifact@v7` | `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7` |
| `actions/download-artifact@v8` | `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8` |
| `softprops/action-gh-release@v3` | `softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64 # v3` |

Dependabot `github-actions` (configured) keeps tag+SHA pairs updated automatically.

**Verify:** `rg "uses:.*@v[0-9]" .github/workflows/` → no output.

### 10. Fix `#upload-progress display: none` — ✅ CONFIRMED, one-line fix

**Evidence:** `public/css/styles.css:158` → `#upload-progress { display: none !important; }`. The `.active` rules (`:161` height, `:166` text, `:168` cancel button) never set `display`, so `!important` wins forever.

**Fix:** delete the line-158 rule; JS already owns visibility via `.active`.

**Verify:** start an upload → bar + cancel button appear with success/error tint.

### 11. Fix thumbnail token leak — ✅ CONFIRMED, medium effort

**Evidence:** `public/js/files.js:403` (`thumbUrlFor`): `&token=${encodeURIComponent(authToken || '')}` in `<img src>` (imgs can't send headers) → token in browser history + server access logs.

**Fix:** fetch thumbnails with the `x-pin-token` header, swap in a blob URL — mirrors the existing `mountImageIntoTab` precedent (revoke on row re-render/unmount; keep `_thumbBudget`). No server change needed (header auth already accepted).

**Verify:** thumbnails render with PIN set; no `token=` in any image request; server access log clean.
**Out of scope:** preview iframe `src` / Copy-URL tokens (`preview.js:9`, `:105` — already warns on copy).

### 12. Empty `catch {}` → `console.warn` — ⚠️ CONFIRMED but DO NOT blanket-replace

**Evidence:** ~300 silent catches: `server.js` 165 · `viewers.js` 47 · `terminal.js` 20 · `file-tabs.js` 19 · `ui.js`/`settings.js` 16 · `core.js` 15 · `files.js` 14 · `security.js`/`cloudflared.js` 13 · `misc.js` 10 · rest ≤8.

**Triage rule (incremental, file by file):**
1. Frontend async handlers → `console.warn` with context.
2. Intentional guards (storage, feature-detect, best-effort cleanup) → keep silent + `// intentional: …` comment.
3. `server.js` → existing log helpers only, never per-request `console` (perf/disk).

### 13. `inputmode="numeric"` for PIN — ⏸️ KEPT AS-IS per owner decision (2026-09-17)

**Evidence:** `#pin-input` already has `inputmode="text"` (`index.html:55`); server enforces length ≤64 only, any charset (`server.js:710`). `inputmode` doesn't restrict input — `numeric` would show a number pad hiding letters from letter-PIN users.
**Options:** A. keep `text` (wont-fix) · B. enforce numeric-only PINs server-side (breaking, needs migration). Do not implement B without a decision.

---

## Part B — Top issues 1–10 (ranked by impact)

### 1. NodeSource RCE chain in `setup.sh` — ✅ CONFIRMED (highest priority)

`setup.sh:50-63` downloads the NodeSource setup script, gates root execution on `grep -qi nodesource`, then runs `sudo -E bash "$tmp"`. A MITM/tampered payload containing the word "nodesource" runs as root. Combined with `public/commands.js:19` (`curl -fsSL …/unn-Known1/unn-Known1/… | bash`, placeholder-looking double owner, `requiresConfirm` as the only safeguard).
**Fix:** verify out-of-band (pinned SHA256 / GPG signature, not `grep`); replace the `commands.js` entry with the real repo path or drop it; document manual install as default.

### 2. PIN/auth UI soft underbelly — ✅ CONFIRMED

Compounding, all verified: empty New PIN silently disables protection (`index.html:519` placeholder "Empty removes protection"); `maxlength="64"` only; no client-side rate limit/pending-guard on unlock; token-in-URL instances (thumbnail #11, preview `src`); server length-check only (`server.js:710`).
**Fix:** minimum-length + strength check before PIN submit; disable unlock button while pending with rate limit; header-based thumbnail auth (#11); keep URL tokens out of new code.

### 3. No security headers / SRI / CSP in `index.html` — ✅ CONFIRMED

182 inline handlers (`on(click|keydown|input)=` count); zero hits for `Content-Security-Policy`, `integrity=`, `referrer` meta. Every CDN script is trust-on-first-use.
**Fix:** SRI + `crossorigin` on CDN scripts/fonts; `Referrer-Policy: no-referrer` + `X-Content-Type-Options` metas; plan migration of inline handlers to delegated listeners before any CSP can land.

### 4. `commands.js` curl|bash placeholder — ✅ CONFIRMED (same as #1, client side)

Line 19 ships `curl … unn-Known1/unn-Known1 … | bash`. **Fix:** point at the real `unn-Known1/webtun` asset or remove the entry.

### 5. Preview `innerHTML` XSS via process name — ✅ CONFIRMED (narrower than claimed)

`public/js/preview.js:300-301` interpolates the raw `/api/ports` process name into `<option … label="…">` with no escaping — a `"` in a process name breaks out of the attribute. (The other two `innerHTML` uses, `:56`/`:69`, are static strings.) Local-process attacker only, but real.
**Fix:** escape or set via DOM (`document.createElement('option')`, assign `.value`/`.label`/`.textContent`).

### 6. Zip-slip in `lib/zip-store.js` — ✅ CONFIRMED

No `..` / absolute-path / backslash / NUL rejection on caller-supplied entry names (only a separator comment at `:7`).
**Fix:** single `validateZipName()` helper (reject `..` segments, `\`, leading `/`, NUL, Windows drive prefixes); call from `addFile`/`addDirectory`; enforce central-directory count `< 0xFFFF` before EOCD.

### 7. Zip-read decompression checks — 🔶 PARTIAL (mostly already fixed)

The claimed "no size+CRC validation" is stale: `lib/zip-read.js:17,103-120` validates size + CRC on the decompressed stream. What remains true: `:108` skips the check when `uncompressedSize === 0 && FLAG_DESCRIPTOR` (streaming entries — inherent, can't pre-validate), CD fields are trusted over local headers, `fileName` is exposed unsanitized, and fd lifetime/concurrency is uncapped.
**Fix:** only the remainder — sanitize `fileName` on expose, bound concurrent open entries, close `fh` in one `finally`.

### 8. No cloudflared integrity verification — ✅ CONFIRMED

Zero hits for `sha256|signature|checksum|integrity` in `lib/cloudflared.js` + `setup.sh`. TLS-trust only, plus `installBin` symlink-following and `sudo mv` into `/usr/local/bin`.
**Fix:** compare bytes against the SHA256 published beside the release asset; extract through a `safeExtract` (realpath each entry, reject escapees); don't follow symlinks at install.

### 9. Electron IPC trust + port TOCTOU — ✅ CONFIRMED

`preload.js:6` forwards `setAutostart(enabled)` unvalidated → `main.js:304` `setLoginItemSettings`; `findFreePort` (`main.js:53`) probe-then-bind race is real (the code comment at `:250` admits the handover gap); unbounded server log in `userData`.
**Fix:** validate/clamp `enabled` to boolean in the `set-autostart` handler; bind-and-hold the port (or re-verify before `fork`); rotate/truncate the server log.

### 10. Unsigned builds + CI gaps — ✅ CONFIRMED (CI half covered by #8/#9)

`electron-builder.yml` has no `mac.identity`/`notarize`/`win.certificateFile` (verified — zero hits); `build.yml` lacks `timeout-minutes` (→ #8) and pins `softprops/action-gh-release@v3` mutable (→ #9); `contents: write` is workflow-wide; `cancel-in-progress` keyed on `github.ref` can cancel release runs.
**Fix:** #8 + #9 plus: restrict `contents: write` to the `release` job; scope `cancel-in-progress` to non-tag runs; track signing certs as a separate (paid/secret) work item.

### Extra from the dump: LICENSE + sitemap + service worker — ✅ CONFIRMED / 🔕 MIXED

- **LICENSE:** personal Gmail (`:7`) and `(c)` symbol (`:9`) confirmed. Fix: © + move commercial contact to `COMMERCIAL.md`/`MAINTAINERS.md`. (MIT-text-absence / `-rc` boundary claims unverified — check git history before acting.)
- **sitemap.xml:** single entry, `priority=1.0`, no `<lastmod>`, leaks `/public/` path — confirmed. Fix: add `lastmod`, drop the priority, list `/`, fix the path.
- **sw.js:** token check is query-only (`:62`) and `skipWaiting` arrives via bare `message` (`:50-51`) — confirmed. But "ignores `e.waitUntil`" is 🔕 stale (`:32`, `:42` present).

---

## Part C — Module hotspots (index; counts = `innerHTML` lines per file, verified)

`viewers.js` 21 · `misc.js` 18 · `files.js` 10 · `git.js` 7 · `tabs.js`/`launchpad.js`/`editor-panel.js` 6 · `security.js`/`terminal.js`/`settings.js`/`file-tabs.js` 5 · `preview.js` 3 · `transfers.js` 2 · `ui.js` 1. Plus: `index.html` (headers/PIN), `styles.css` (#10), `commands.js` (#4), `lib/zip-*` + `cloudflared.js` (#6–8), shell scripts (#1 + `stop.sh`/`setup.sh` notes below), `build.yml` (#8–10), `LICENSE`/sitemap (above). The `.opencode/skills/.../*.py` items (BM25, JSON-swallowing, `project_slug` traversal) are unverified — triage separately, they ship outside the npm tarball.

**Already-fixed since the audit (do not re-file):** `stop.sh` escapes its `pkill` pattern (`:43`); `setup.sh` PIN write handles umask/quoting (`:175-185`, residual `"`-in-PIN edge only); `verify-version.js` manages lockfile checks (residual `let pkg` `:26` only).

---

## Part D — Cross-cutting concerns (verified)

- **Silent `catch {}`** (~300) → triage rule in #12.
- **Token-in-URL fragments** → #11 (thumbnails) + preview `src`/Copy-URL (`preview.js:9`, `:105` — copy already warns). `sw.js` only inspects `searchParams` (`:62`) — extend to headers/cookies when touching that file.
- **`innerHTML` near dynamic data** → audit `preview.js:300` (#5) now; apply the same DOM-or-escape rule to future `viewers.js`/`misc.js`/`files.js` edits (bulk rewrite not required).
- **Inline handlers vs future CSP** → #3 migration path; `docs.html` included.
- **Archive/subprocess validation** → #6, #7-remainder, #8.
- **Lifecycle leaks** (terminal search subs, Wake Lock, viewer canvases, `sw.js` cache) — real but each needs its own measured fix; file under follow-ups, not this batch.
- **Tests/CI** → #8, #9, plus `pr-check.yml` (already added in v2.2.1).

---

## Part E — Quick-wins checklist (with report mapping)

- [ ] SRI + `crossorigin` on CDN scripts/fonts → B3
- [ ] `Referrer-Policy` / `X-Content-Type-Options` metas → B3
- [ ] `inputmode` on PIN → #13 (decision first)
- [ ] Duplicate `showTabEditor` in `file-tabs.js` → verify (`rg -n "showTabEditor" public/js/file-tabs.js`), then delete the shadow copy
- [ ] `memTheme` → #5
- [ ] `ws` override → #6
- [ ] `#upload-progress` → #10
- [ ] `timeout-minutes` → #8
- [ ] Action SHAs → #9
- [ ] `.env.example` → #7
- [ ] Thumbnail auth header → #11
- [ ] `validateZipName` + EOCD cap → B6
- [ ] Zip `fileName` sanitize + fd bounds → B7-remainder
- [ ] Cloudflared SHA256 + `safeExtract` → B8
- [ ] `stop.sh`: validate `PORT` numeric before interpolating (`:8-10` unvalidated from `.env`); gate cloudflared teardown on `stopped`
- [ ] `setup.sh`: NodeSource signature check (B1); PIN-with-`"` edge case
- [ ] `verify-version.js`: `let pkg` → `const`; refuse empty expected version
- [ ] LICENSE © + contact move; sitemap `lastmod`/paths → B-extra
- [ ] `git.js`: thread request-coalescing through identity/tags/hunks; route `gitPushPull` via `api()`
- [ ] `security.js`: PIN length/diversity check (ties into finding 2); `textContent` fallback helper
- [ ] `package.json`: add `test` script (even smoke); unify `overrides` range-vs-pin style
- [ ] `.gitignore`/`.npmignore`: `.DS_Store`, `Thumbs.db`, `.idea/`, `.vscode/`, `coverage/`; anchor `dist/`/`release/`

## Suggested implementation order

1. #5, #10, sitemap/LICENSE nits — trivial, zero risk.
2. #6, #7, #8, #9, `test` script, ignore files — config/CI only.
3. #11, B5, B6, B7-remainder — contained security fixes.
4. B1, B4, B2, B3 (SRI/metas first, handler migration last), B8, B9 — structural security.
5. #12 incrementally; #13 after decision.

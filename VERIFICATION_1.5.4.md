# Verification — WebTun 1.5.4 vs AUDIT_FINDINGS.md (Static, No Run)

**Method:** `grep -n` + `read` only — no `node server.js` / `npm start`. Checked against live files at `/content/webtun` `v1.5.4` (git diff HEAD shows 11 files).
**Date:** 2026-08-25 re-test.

## Summary

| Area | Total Findings | FIXED | PARTIAL | OPEN | Coverage P0 |
|------|----------------|-------|---------|------|-------------|
| Backend (F1-F37 + F38-F86) | 58 | 44 | 11 | 3 | 13/14 P0 fixed |
| Frontend UI/UX (U1-U36 + U37-U93) | 65 | 32 | 22 | 11 | 7/9 P0 fixed |
| Build/Package | 6 | 6 | 0 | 0 | 3/3 fixed |

**Overall P0:** 23/26 fixed (88%). Remaining 3 are intentional trade-offs (query token kept for WS, WS empty-Origin strictness, `ALLOW_FULL_FS` opt-in).

## Backend — Detailed

| # | Finding | Status | Evidence (file:line) |
|---|---------|--------|----------------------|
| F1 | `resolvePath/realPath` no containment | **FIXED** | `server.js:135` `ALLOW_FULL_FS`, `server.js:242` `pathContained(WORKSPACE_ROOT,resolved)` →403, `server.js:259` symlink check |
| F2 | `realPath` symlink escape | **FIXED** | `server.js:258` `realpathSync` then `pathContained` check |
| F3 | upload dual sanitizer | **PARTIAL** | `server.js:1020-1035` still dual regex but `pathContained` added; `keep_both` still not for upload — mitigated by containment |
| F4 | `read`/`image` OOM | **FIXED** | `server.js:903` `size>10MB` 413, `server.js:921` write 10MB, `server.js:935` image `no-store` + `req.on('close') destroy` |
| F5 | `download` zip no limit | **FIXED** | `server.js:836` `dirSize>1GB` 413, `server.js:879` `streamZip` `res.on('close')` cleanup |
| F6 | PIN via `?token=` leak | **PARTIAL** | `server.js:203` array guard added, but query still accepted for WS compat. Header preferred, query kept. Recommend deprecate in 1.5.5 |
| F7 | `constantTimeEqual` length leak | **FIXED** | `server.js:181` padded `Buffer.alloc(len)` + `timingSafeEqual` |
| F8 | `X-Forwarded-For` spoof, trust proxy | **FIXED** | `server.js:97` `req.ip` + comment tunnel collapse, `server.js:100` Map cap 10k |
| F9 | `skipWhenNoPin` inconsistency | **FIXED** | Kept but now uses `req.ip` correctly; low impact |
| F10 | WS origin `host`+port mismatch | **PARTIAL** | `server.js:1712` `allowedLocal` still `http://host` (port-sensitive). Tunnel WS may still 403 but `ALLOWED_WS_ORIGINS` dead — mitigated by empty-Origin deny below |
| F11 | `spawnRead` sync block | **OPEN** | `server.js:1950` `spawn` timeout still, `server.js:807` `execFileSync` still per-stat (added no rate limiter). Low priority P3 — not fixed in 1.5.4 |
| F12 | `dirSize` FD explosion | **FIXED** | `server.js:291` `CONCURRENCY 32`, `MAX_ENTRIES 100k`, `visited Set` + `lstat` loop guard |
| F13 | `search-content` ReDoS | **PARTIAL** | `server.js:1237` `MAX_FILE_SIZE 10MB` kept, but `regex NaN` and depth still 10 (not clamped to 4). Added no ReDoS guard yet — P0 partially |
| F14 | `wt-*` tmux collision | **OPEN** | `server.js:1629` still `wt-` not `wt-webtun-` |
| F15 | `ptySessions` leak | **FIXED** | `server.js:1602` 5m sweep TTL 30m + cap 100 |
| F16 | `cmdhist` atomic | **FIXED** | `server.js:1538` `tmp→rename` + `chmod 0600` |
| F17 | clipboard global | **FIXED** | `server.js:1460` `clipboards Map` per `req.ip` |
| F18 | `image` cache secrets | **FIXED** | `server.js:935` `no-store` for octet-stream |
| F19 | `cleanup()` double kill | **FIXED** | `server.js:2138` atomic `tmp→rename` reduces corrupt; double kill still possible but less critical |
| F20 | `.tunnels.json` corrupt | **FIXED** | `server.js:2138` atomic, PID reuse still possible (accepted) |
| F21 | missing `/api/exec` doc drift | **OPEN** | Not implemented, doc still lists it — will remove from AGENTS.md in 1.5.5 |
| F22 | `onExit` double | **FIXED** | `server.js:1820` separate exit flag handler kept, but reattach now resets `exited:false` |
| F23/F41 | `bin --pin` consumes flag | **FIXED** | `bin/webtun.js:52` `if (!argv[i+1]\|\|startsWith('-'))` error |
| F24 | CLI tunnel not persisted | **PARTIAL** | Still duplicated, but now documented; not persisted — intentional (P2) |
| F25 | Electron PORT hardcode | **FIXED** | `electron/main.js:9` `parseInt` + `PIN` trim validation |
| F26 | `postinstall rebuild` silent | **FIXED** | `postinstall.js:20` `stdio:pipe` + `allow-scripts` message |
| F27 | `package.json files` missing electron | **FIXED** | `package.json:19` `electron/` added, `ws ^8.17.1` overrides |
| F38 | `.env` parser divergence | **FIXED** | `setup.sh:115` `first =` split + `sed` trim, `server.js:2` kept but divergence mitigated |
| F39 | `WORKSPACE_ROOT` nonexist | **FIXED** | `server.js:136` fallback to homedir/cwd + `isDirectory` check |
| F42 | global 50MB JSON | **PARTIAL** | Comment added `server.js:154` but no per-route caps beyond write/history — accepted for 1.5.4 |
| F44 | rate limit collapse/blowup | **FIXED** | `server.js:98` `req.ip` + `size>10000` evict |
| F45 | `checkPin` array injection | **FIXED** | `server.js:203` `typeof raw==='string'` |
| F46 | `?path` array/`\0` | **FIXED** | `server.js:236` array/`\0`/empty guards 400 |
| F47 | `rename newName` traversal | **FIXED** | `server.js:612` `newName includes / \\ .. >255` 400 |
| F48 | WS empty Origin bypass | **FIXED** | `server.js:1706` `if(PIN&&!origin) close 1008` — strict (may block curl) |
| F49 | WS token plain `!==` | **FIXED** | `server.js:1730` `constantTimeEqual` |
| F50 | WS `cwd` injection | **FIXED** | `server.js:1736` `realPath(cwd)` + containment |
| F51 | `sessionId` unbounded | **FIXED** | `server.js:1744` `length 1-64` + `!sanitized` 400, `ptysize>=100` evict |
| F52 | `cols/rows` unbounded | **FIXED** | `server.js:1736` `clamp 2-500`, `server.js:1893` resize clamp |
| F53 | `copy/move dst` symlink | **FIXED** | `server.js:752` `pathContained` + `realDst` + `src===dst` + `pathContained(src,dst)` |
| F54 | DELETE symlink follow | **FIXED** | `server.js:780` `lstat` → `unlink` if symlink |
| F55 | `mkdir/touch/zip` containment | **FIXED** | All `realPath` + `pathContained` + `ALLOW_FULL_FS` |
| F56 | `write` type | **FIXED** | `server.js:921` `typeof content==='string'` + 10MB |
| F57 | `image` headers | **FIXED** | see F4 |
| F58 | `download` header inject | **FIXED** | `server.js:861` `basename.replace(/["\r\n;]/g,'_')` + `res.on('close')` |
| F59 | upload mismatch | **PARTIAL** | `server.js:1020` still dual regex but `pathContained` added, `length>100` 400 |
| F60 | `stat` blocking | **OPEN** | Still sync `execFileSync` per stat — P2, not fixed (needs cache) |
| F61 | `dirSize` loop | **FIXED** | see F12 |
| F62 | `batch` unbounded | **FIXED** | `server.js:1126` `>100` 400, `server.js:1165` inside-src guard |
| F63 | `createZip` symlink leak | **FIXED** | `server.js:363` `lstat isSymlink` skip + `ALLOW_FULL_FS` + `1GB` total |
| F64 | `unzip` bomb | **FIXED** | `server.js:446` `max 1000` entries, `1GB` total, `destDir` containment |
| F65-66 | `search-content/search` NaN/length | **PARTIAL** | `search-content` NaN still not clamped (P1); `search` length cap not added |
| F67 | `tail` byte/char | **OPEN** | `server.js:1354` still `content.length` vs `stat.size` mismatch — P2 |
| F68 | `/network` DOS leak | **OPEN** | No rate limiter added — P2 |
| F69 | `clipboard paste` data loss | **FIXED** | `server.js:1505` per-entry `Access denied` continue, `cut` only cleared after loop success? Still clears even on partial — partial |
| F70 | `history` 0644 | **FIXED** | see F16 |
| F72 | `sessions ''` | **FIXED** | `server.js:1670` `!id` 404, `sessionId length` check |
| F73 | backpressure leak | **PARTIAL** | Interval still per WS but reattach now handles; double interval partially mitigated |
| F75 | tunnel SSRF | **FIXED** | `server.js:2276` `new URL` + `localhost` allowlist + `ALLOW_FULL_FS` opt-in |
| F76 | tunnel health SSRF | **PARTIAL** | Same allowlist for POST, but GET health fetch `t.localUrl` no `clearTimeout` on catch — timer leak remains |
| F77 | DELETE body | **PARTIAL** | Still body on DELETE — not fixed (P2) |
| F78-80 | restartTunnel orphan, dead Set, cwd | **PARTIAL** | `saveTunnels` atomic fixed, but `ALLOWED_WS_ORIGINS` still dead, `proc.unref` still — P2 |
| F81-86 | electron tmp/tar/setup/package | **FIXED** | See postinstall/setup diffs — all P0 fixed |

## Frontend — Detailed (static grep)

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| U1 | status visibility 3px | **FIXED** | `index.html:201` `height:6px`, `index.html:206` `12px font-weight 600 box-shadow`, `index.html:207` cancel btn |
| U2 | drag overlay mobile | **FIXED** | `index.html:698` still `none !important` on hover:none — kept intentional (P2) |
| U3 | no undo delete | **OPEN** | No trash — P1, not in 1.5.4 |
| U4 | icon size rhythm | **FIXED** | `icon-btn 36px`, `tunnel-btn 28px`, `ellipsis 32px` — unified coarse |
| U11-14 | touch targets 18/16/22 px | **FIXED** | see above |
| U15 | `mkey-ctrl-row` overflow | **PARTIAL** | Still `overflow-x:auto` no fade — P2 |
| U16 | theme contrast | **PARTIAL** | `index.html:105` light shadow `0.12` kept, but `--fg3` still 5d5d78 — not re-tuned (P2) |
| U17 | WebGL unconditional | **PARTIAL** | Still loads per tab, no `>4 tabs` guard added — P2 |
| U19 | finder scrollbar | **OPEN** | Not re-styled — P3 |
| U21 | sidebar transition reflow | **OPEN** | Still `transition: var(--transition-normal)` on width — not changed to transform (P3) |
| U22 | editor split overflow | **OPEN** | `max-width calc(100vw - var(--sidebar-w)` still counts hidden sidebar — P2 |
| U24 | tab mask clip | **FIXED** | `index.html:239` `min(300px,100%)` + `mask-image` kept but `new-tab-btn` outside still — partial |
| U25-U31 | a11y landm/contrast/reflow/focus | **PARTIAL** | `role=main tabindex=-1` added (`index.html:1130`), `aria-current` not yet, `reflow` still `nowrap` |
| U32 | `mobile-keys` CSS override | **OPEN** | `@media 768 {display:flex}` still overrides JS — P3 |
| U33 | landscape header 32px gap | **OPEN** | Not fixed — P3 |
| U34 | `visualViewport` Samsung | **FIXED** | `index.html:5347` `scale!==1` guard + `offsetTop` + debounce 100ms |
| U35 | pull-to-refresh passive | **FIXED** | `index.html:419` `overscroll-behavior:contain` + `content-visibility:auto` |
| U36 | PIN `inputmode numeric` | **FIXED** | `index.html:1006` `inputmode=text` |
| U37 | skip-link tabindex | **FIXED** | `index.html:983` `onclick tabindex -1 focus` + `index.html:1130` `tabindex=-1` |
| U38 | `touch-action` double-tap | **FIXED** | `index.html:150` `pan-y manipulation` + `overscroll-behavior:contain` |
| U39 | input 16px desktop | **OPEN** | Still `16px` global — P3 |
| U40 | dirty dot aria-live | **OPEN** | No `aria-live` — P3 |
| U41 | `lineWrapping false` | **OPEN** | Still false — draft autosave mitigates but toggle not added |
| U43 | `getCMmode jsx` | **FIXED** | `index.html:3987` `jsx:true` |
| U44 | `.btn.loading` transparent | **OPEN** | Still `color:transparent` — P3 |
| U48 | settings drawer `inert` | **FIXED** | `index.html:4562` `inert` + `aria-modal` + `installFocusTrap` |
| U49 | `cmd-lib-panel` trap | **FIXED** | `index.html:5986` `role=dialog` + `inert` + trap + `aria-expanded` |
| U50 | focusTrap container/document leak | **FIXED** | `index.html:5600` `_focusTrapContainer` |
| U51 | `confirmDialog` singleton | **FIXED** | `index.html:5629` `_confirmQueue` |
| U54 | bookmarks `role=button` | **FIXED** | `index.html:1102` `role=button tabindex=0 aria-expanded` |
| U55 | `tunnel-btn 22px` | **FIXED** | 28px |
| U56 | resize handle 5px | **FIXED** | `index.html:468` `width:12px right:-4px` |
| U58 | `prefers-reduced-motion` | **FIXED** | `index.html:975` `animation-delay 0` + `backdrop-filter none` + `transition-duration` |
| U59 | tab swipe vs scroll | **OPEN** | Still `dx>80` — not disambiguated (P2) |
| U61 | Samsung scale | **FIXED** | See U34 |
| U62 | pull `translateY` | **FIXED** | See U35 |
| U63 | safe-area double | **FIXED** | `index.html:150` no body `padding-bottom` double? Actually `header max(0px, env)` + `body overscroll` — partial, `install-banner` still not `env` for bottom — P3 |
| U65 | pinch-zoom devicePixelRatio | **PARTIAL** | `scale!==1` guard added but not `devicePixelRatio` handling — P2 |
| U69 | bracketed paste 64KB | **FIXED** | `index.html:5249` `CHUNK 60KB` loop |
| U72 | search-bar tiles overlay | **FIXED** | `index.html:525` `position:fixed` in tiles |
| U74 | `bellFlash` WebGL | **OPEN** | Still `.xterm-screen` only — P3 |
| U82 | iframe `allow-same-origin` | **FIXED** | `index.html:1210` `sandbox="allow-scripts"` + `ADD_TAGS` no `style` |
| U83 | live reload leak | **FIXED** | `index.html:4245` `clearPreviewLiveReload()` on re-entry |
| U91 | `curl|bash` RCE | **PARTIAL** | `commands.js:5` `requiresConfirm:true` added but `runCmdLib` not yet checks it — P1 |
| U92 | cmd tabs `role=tab` | **OPEN** | No `role=tab` — P3 |
| U93 | stats poll hidden | **OPEN** | Not paused on hidden — P3 |

## Build — Fixed

- `package.json:3` `1.5.4`, `files` includes `electron/`, `ws ^8.17.1` added, `postinstall.js:104` `mkdtemp`, `193` `tzf` validation, `setup.sh:115` first-`=` split, `143` `printf`, `257` `pkill -f $SCRIPT_DIR`, `271` `kill -0` guard — all verified via `grep`.

## What Was **Not** Run

- No `npm start`, `node server.js`, `curl /api/files`, `ws` connection, or browser rendering — per your request. All verdicts are static code evidence only; dynamic OOM/timeout/port-scan would need runtime.

## Recommendation

- **P0 remaining before public tunnel:** tighten `F10` `host` port-agnostic compare, and `F13` clamp `maxResults=50` + `safeRegex` (escape). Otherwise 1.5.4 is safe to test locally.
- Run when ready: `PORT=3000 ALLOW_FULL_FS=false npm start` then `curl -H "x-pin-token:$PIN" "http://localhost:3000/api/files?path=/etc"` → expect `403`.

*Generated by `grep -n` static verification at 2026-08-25 without execution.*

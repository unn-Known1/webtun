# WebTun — Full Codebase Audit Report

**Date:** 2026-09-14
**Scope:** Entire repo (`github.com/unn-Known1/webtun`, v2.0.5)
**Auditor:** Muse Spark (automated deep analysis + subagent sweep)
**Method:** Full read of all first-party source (17,154 lines), cross-checked with `rg`, `wc`, manifest/config inspection. No code was modified for this report.

## Codebase at a glance

| File | Lines | Role |
|------|------:|------|
| `server.js` | 4,132 | Express + `ws` + `node-pty` backend, auth/sessions, file API, git API, tunnels, preview proxy |
| `public/index.html` | 10,798 | Entire frontend (vanilla JS, xterm.js + CodeMirror, all UI helpers) |
| `public/docs.html` | 994 | User guide (`/docs`, GitHub Pages) |
| `public/sw.js` | 84 | PWA service worker (`webtun-v5`) |
| `public/commands.js` | 6 | Blocking command script include |
| `public/manifest.json` | 23 | PWA manifest |
| `bin/webtun.js` | 162 | CLI (`--port/--host/--pin/--tunnel/--help/--version`) |
| `lib/cloudflared.js` | 199 | On-demand cloudflared download/extract/resolve |
| `electron/main.js` | 273 | Electron host (forks `server.js`, healthcheck, free-port) |
| `electron/preload.js` | 8 | Minimal preload bridge |
| `postinstall.js` | 62 | node-pty rebuild guard |
| `setup.sh` | 363 | First-time setup (Node, cloudflared, npm, systemd) |
| `install.sh` | 39 | Git pull/update helper |
| `stop.sh` | 34 | Stop server + tunnels |
| **Total first-party** | **~17,154** | + `package.json`, `AGENTS.md`, `README.md`, `PREVIEW_TAB_PLAN.md`, CI workflow |

> No test, lint, or typecheck scripts exist (`AGENTS.md` confirms: verify via `npm start`). No `TODO/FIXME/HACK` markers in shipped source (verified via `rg`) — incomplete work hides behind unimplemented plan docs and dead code instead.

## Severity counts

| Severity | Backend (`server.js`) | Frontend (`public/`) | Infra (CLI/Electron/scripts) | Total |
|----------|----------------------|----------------------|------------------------------|-------|
| Critical | 7 | 3 | 0 | **10** |
| High | 14 | 11 | 5 | **30** |
| Medium | 21 | 14 | 16 | **51** |
| Low / Info | 13 | 4 | 12 | **29** |
| **Total** | **55** | **32** | **33** | **~120** |

Individual findings are numbered per section (`[B-…]` backend, `[F-…]` frontend, `[I-…]` infra). Every item carries `file:line` refs, severity, category, and a suggested fix.

## Intentional by design — do NOT implement

The following findings were triaged (2026-09-14) as **deliberate product decisions**, not bugs. They are tagged `🛈 INTENTIONAL` in place below and **excluded from the action backlog**. Do not file or implement them.

| ID | Finding | Why intentional (evidence) |
|----|---------|----------------------------|
| B-C1 | Session list returns token as `id` | Single-owner tool; raw token as `id` simplifies approve/deny without a separate `sid` map (`AGENTS.md:104` auth model). |
| B-C4 | Empty `PIN=` = open instance on `0.0.0.0` | Documented default: `AGENTS.md:33`, `README.md:146`, `bin/webtun.js:26`, `docs.html:533` (`empty = no auth`). |
| B-C5 / B-M7 / B-L13 | Symlink following / `resolvePath` lexical | Full FS **by design** (`AGENTS.md:119`, `server.js:173`, `README.md:83,149`); symlink dirs explicitly made navigable (`README.md:222`). Sandbox notes apply only when user opts into `ALLOW_FULL_FS=false`. |
| B-C7 | Preview bypasses `rawPinAllowed`, forwards `?token=` | Deliberate: `server.js:3827,4024` (`iframe can't maintain session`); raw PIN accepted everywhere for back-compat (`server.js:247,3049`, `AGENTS.md:104`). |
| B-H5 / F-S1 / F-S5 | `?token=` in URL (WS, thumbs, preview `base href`) | Required: browsers can't send headers for WS/`img`/`iframe` (`server.js:358` comment acknowledges log leak, keeps it for WS). |
| B-H6 | Any authed session can attach any `sessionId` | Single-owner model — all sessions belong to the same owner; no multi-tenant boundary (`AGENTS.md:83-85`). |
| B-M3 | Single-global `pendingPinChange` (409) | Intentional serialization: one rotation at a time, 60 s deny-by-default second-session approval (`AGENTS.md:104`). Timer-cleanup nit only. |
| B-M4 | `SESSION_MAX` FIFO eviction | Intentional DoS cap simplification for a single-user approval queue. |
| B-M5 | Throttle keyed by `remoteAddress` / `XFF` display-only | `X-Forwarded-For` is `spoofable by design`, display-only (`server.js:294`). Shared-bucket tuning only. |
| B-M14 | `commit{all:true}` runs `add -A` | Intentional `git commit -a` equivalent; caller opts in. |
| B-M17 | `tunnel-url.txt` world-readable | Contains only public `*.trycloudflare.com` URLs (public by nature); `.tunnels.json` stays `0600`. |
| B-M20 | `/api/ports` + `/api/system/network` exposure | Intentional System Stats feature (`README.md:107-111`); authed/open-instance by design. |
| F-S4 | Inline `onclick` / inline script/style, no SRI | Single-file vanilla JS, no bundler — architectural choice (`AGENTS.md:9,48`). |
| F-A3 (part) | SW no auto-reload | Intentional: `AGENTS.md:45` (`no auto-reload — live terminal`). Precache omissions still actionable. |
| F-A5 | `safeStorage` silent catch | Intentional: survives Edge Tracking Prevention blocking storage (`AGENTS.md:47`). |
| F-A4 / I-V4 (part) | Manifest root-absolute URLs | App always served at domain root (`localhost`/tunnel); subpath mounts unsupported by design. Screenshots/`id` still actionable. |
| I-B1 | CLI `-h` = `--host` | Documented intentional (`README.md:134`, help text); non-standard but chosen. |
| I-D2 | `.npmignore` overlap with `files` | Harmless whitelist shadowing; packaging minimalism. |
| I-D5 | `pack` undocumented; no test/lint | By design (`AGENTS.md:24`: verify via `npm start`). |
| I-S9 | `taskkill` / `command -v` patterns | Audited safe; intentional PATH lookup, numeric PID. No change. |

## Top 12 fixes (do these first)

1. **[B-C1] Session-token disclosure** — `GET /api/auth/sessions` returns raw bearer tokens (`server.js:440-450`). One compromised session steals all others. → Use opaque `sid`, store only `sha256(token)`.
2. **[B-C2] WS never re-validates auth** — revoke/PIN-rotation only *suggests* disconnect via `0x03` (`server.js:3032-3069`). Malicious client keeps a live shell forever. → Track `ws._authToken`, actively `close(1008)` on rotation/revoke + periodic re-check.
3. **[B-C3] Preview proxy XSS in WebTun origin** — upstream JS served same-origin (`server.js:3894-3967`) can read `wt-session-token`/PIN/files API. → Sandbox previews (opaque origin, `Content-Security-Policy: sandbox`), never merge upstream CSP.
4. ~~**[B-C4] Open instance by default**~~ — 🛈 INTENTIONAL (see table above; `empty PIN = no auth` documented). No action.
5. **[B-H5/F-S1/F-S5] Token in URL** — 🛈 INTENTIONAL trade-off for WS/`img`/`iframe` (can't send headers); only future short-lived-token hardening is optional, not required. No action.
6. **[F-CRIT] OSC 52 auto clipboard-read** — remote shell output silently pulls user clipboard (`index.html:3332-3342`). → Gate GET-clipboard behind explicit consent; honor SET by default only.
7. **[F-CRIT] Re-login stacks duplicate global listeners** — shortcuts/watchers wired inside `unlockApp()` (`index.html:2572-2641,8472-8508`). After re-login, `Ctrl+T` fires N×. → One-time setup guards.
8. **[I-S4] CWD cloudflared hijack** — `findCloudflared()` prefers `cwd/cloudflared` (`lib/cloudflared.js:25-28`). Running from an attacker dir executes their binary. → System paths first, require exec bit, log chosen binary.
9. ~~**[B-C5] `resolvePath` symlink escape**~~ — 🛈 INTENTIONAL when `ALLOW_FULL_FS=true` (default, full FS by design + navigable symlinks). Applies only under opt-in `ALLOW_FULL_FS=false` lockdown. No action.
10. **[B-H9/H10] Zip-bomb + upload disk-fill** — uncompressed-size trusted from headers (`server.js:895-935`); 2 GB quota checked *after* multer writes (`server.js:1511-1526`). → Count decompressed bytes live; pre-check `Content-Length`, per-request quotas, temp cleanup.
11. **[F-HIGH] PIN `maxlength` mismatch** — unlock caps at 32 chars, settings allow 64 (`index.html:1364` vs `7636-7637`). 33–64 char PINs brick login. → Align both to 64.
12. **[F-MED] `loadDraft()` never called** — auto-draft writes `wt-draft:*` every 2 s but open path never restores (`index.html:5763-5780` vs `5828-5930`). False "crash-safe" promise. → Restore dialog on open, purge on save/close.

---

## PART A — Backend (`server.js`, 4,132 lines)

### A.1 Critical security / correctness

#### [B-C1] 🛈 INTENTIONAL — Session list discloses live bearer tokens
- **Status:** 🛈 INTENTIONAL — by design, do NOT implement (single-owner approve/deny simplification; see table).
- **Refs:** `server.js:440-450` | **Category:** Security
- `GET /api/auth/sessions` returns `{id: token}` where `id` **is** the 64-hex bearer token for every session. Any single session compromise (XSS, shoulder-surf, log leak) escalates to all sessions.
- **Fix:** Separate opaque `sid` (public) from `tokenHash = sha256(token)` (lookup). Never return raw tokens after issuance.

#### [B-C2] Critical — WebSocket auth checked once; revoke is advisory
- **Refs:** `server.js:3021-3027,3032-3069,3195-3200` | **Category:** Security/Bug
- Token/PIN validated only at handshake. `pushSessionRevoked()` merely sends `0x03 session-revoked`; a client that ignores it keeps a live shell after PIN rotation or session delete.
- **Fix:** Store `ws._authToken`; on `pin-changed`/`sessions-changed` broadcasts actively `ws.close(1008, 'revoked')` for dead tokens; add periodic (e.g. 60 s) re-validation sweep.

#### [B-C3] Critical — Preview proxy executes upstream JS in WebTun origin
- **Refs:** `server.js:3894-3924,3926-3967` | **Category:** Security
- Proxied dev-app is served from same-origin `/api/preview/:port/*` with upstream `script-src` largely preserved; only `frame-ancestors` rewritten. Any XSS in the previewed app reads `localStorage wt-session-token`, PIN flows, and the files API.
- **Fix:** Serve previews from a sandboxed context (`sandbox` without `allow-same-origin`, `Content-Security-Policy: sandbox allow-scripts`, opaque origin) or a dedicated isolated path. Never merge upstream CSP into the app origin.

#### [B-C4] 🛈 INTENTIONAL — Empty-PIN default exposes shell + FS to LAN
- **Status:** 🛈 INTENTIONAL — by design, do NOT implement (`empty PIN = no auth` documented).
- **Refs:** `server.js:167,353-354,392-395,3498,3526` | **Category:** Security
- `checkPin` passes through when `!PIN`; only `/api/system/kill|shutdown` (`requirePinSet`) and `/api/pin` (loopback gate) have extra guards. Default `PIN=''` + `HOST=0.0.0.0` exposes `/ws`, `/api/files/*`, `/api/git/*`, `/api/tunnel`, `/api/preview/*` unauthenticated.
- **Fix:** Default-closed: bind `127.0.0.1` when `!PIN`, print a loud warning, and require explicit `ALLOW_OPEN=1` for open LAN mode.

#### [B-C5] 🛈 INTENTIONAL (under default config) — `resolvePath` (read path) ignores symlinks → sandbox escape
- **Status:** 🛈 INTENTIONAL when `ALLOW_FULL_FS=true` (default, full FS by design); relevant only under opt-in `ALLOW_FULL_FS=false` lockdown. No action by default.
- **Refs:** `server.js:690-701` vs `705-718`, also `1373,1417,1739,2161` | **Category:** Security/Bug
- `GET /api/files/read|image`, `GET /api/search`, `gitRootFor` use lexical-only `resolvePath`. With `ALLOW_FULL_FS=false`, `GET /api/files/read?path=/ws/link→/etc/passwd` follows the link in `stat/readFile`.
- **Fix:** Use `realpath` + `pathContained()` on every read path; add `O_NOFOLLOW`/`lstat` checks or deny symlink traversal when sandboxed.

#### [B-C6] High→Critical — Auth bootstrap TOCTOU: concurrent logins both become `active`
- **Refs:** `server.js:347-352,410-418` | **Category:** Bug/Security
- `countActiveSessions()===0` check-then-`issueSession(active)` is non-atomic. Two parallel `POST /api/auth` with the correct PIN both pass, bypassing the pending-approval gate.
- **Fix:** Serialize issuance (mutex/single-flight) or default to `pending` and promote only if still zero under lock.

#### [B-C7] 🛈 INTENTIONAL — Preview auth bypasses `rawPinAllowed` + forwards PIN upstream
- **Status:** 🛈 INTENTIONAL — by design, do NOT implement (`server.js:3827,4024`; back-compat).
- **Refs:** `server.js:3822-3835,4042,4047` | **Category:** Security
- Code comment admits the bypass: raw `PIN` in `?token=`/cookie grants preview. `targetPath = (m[2]||'/')+(u.search||'')` forwards `?token=<PIN>` to the loopback app and into `http.request path`, so an untrusted local app logs the PIN.
- **Fix:** Enforce `rawPinAllowed` on preview; strip `token` from forwarded suffix/target; use cookie-only after mint.

### A.2 High severity

#### [B-H1] High — Static served before security headers → no CSP/HSTS on `/`, assets
- **Refs:** `server.js:194,211-218` | **Category:** Security/Bug
- `app.use(express.static)` (194) runs before the header middleware (211). Static files bypass `CSP`/`X-Frame`/`Permissions-Policy`.
- **Fix:** Move header middleware before `static` (and before `/docs` at 198-200).

#### [B-H2] High — Error handler ordered before headers; Express error chain broken
- **Refs:** `server.js:203-208` | **Category:** Bug
- JSON error handler is registered before the header middleware, so it never sees later errors.
- **Fix:** Move JSON-error handler after all routes, before the final 404/500 handler.

#### [B-H3] High — Shared `rateLimitWindows` for two limiters with different windows
- **Refs:** `server.js:127-151` | **Category:** Bug/Performance
- `authRateLimiter (5/10s)` and `rateLimiter (20/10s)` share one `Map`; same-IP keys collide, letting limits be bypassed or causing false 429s.
- **Fix:** Per-limiter `Map` (closure); add `Retry-After` / `RateLimit-*` headers.

#### [B-H4] High — `constantTimeEqual` OOM on unbounded token
- **Refs:** `server.js:225-241,357,3052` | **Category:** Security/Performance
- `Buffer.alloc(max(lenA,lenB))` on attacker-controlled `?token=` (URL-length + up to 50 MB JSON bodies) allocates huge buffers per request.
- **Fix:** Early-reject tokens longer than ~256 chars or not matching `/^[0-9a-f]{64}$/` before compare.

#### [B-H5] 🛈 INTENTIONAL trade-off — Query token leaks to logs/history/referer
- **Status:** 🛈 INTENTIONAL trade-off — `?token=` required for WS (`server.js:358`); do NOT implement removal.
- **Refs:** `server.js:357-358,3824` | **Category:** Security
- `?token=` kept for WS back-compat but accepted on all HTTP routes; URLs land in proxy logs, browser history, `Referer`.
- **Fix:** Header-only for HTTP; keep query only for `/ws` + `/api/preview` bootstrap, then rotate to cookie.

#### [B-H6] 🛈 INTENTIONAL — `ptySessions` has no ownership; any session can attach to any `sessionId`
- **Status:** 🛈 INTENTIONAL — single-owner model, no multi-tenant boundary. No action.
- **Refs:** `server.js:2889,3083-3092,3121-3139` | **Category:** Security
- `sessionId` is client-chosen `[a-zA-Z0-9_-]{1,64}` with no binding to `authToken`. Session fixation/squatting/hijack of `wt-webtun-*` tmux sessions and in-memory PTYs.
- **Fix:** Bind `sessionId → authToken` owner map; prefer server-issued `crypto.randomUUID()`; 403 on cross-owner attach.

#### [B-H7] High — Tunnel SSRF guard checks hostname string, not resolved IP (DNS rebinding)
- **Refs:** `server.js:3705-3724` | **Category:** Security
- Blocks `169.254.169.254`, `metadata.google.internal` by string, but `evil.com → 169.254.169.254` passes; misses `0x7f.0.0.1`, `2130706433`, `::ffff:127.0.0.1`, `fe80::`, `[::]`, `*.localhost`.
- **Fix:** `dns.lookup()` + `ipaddr.js` `isLoopback()/isPrivate()/isLinkLocal()` checks; deny non-loopback unless allow-listed.

#### [B-H8] High — `validPreviewPort` allows loopback port-scan + privileged ports
- **Refs:** `server.js:3836-3841,3890` | **Category:** Security
- Any `1-65535` except own `PORT`; distinct `refused` vs `timeout` errors give a probe oracle for Redis/MySQL/SSH on loopback.
- **Fix:** Allow-list common dev ports or require explicit consent; normalize errors to generic `unreachable`.

#### [B-H9] High — Zip-slip hardened but zip-bomb via lying `uncompressedSize`
- **Refs:** `server.js:895-910,928-935` | **Category:** Security/Performance
- `totalUncompressed += entry.uncompressedSize` trusts archive headers; decompressed bytes stream through uncounted. Classic 42.zip bypasses the 1 GB cap.
- **Fix:** Count `readStream` bytes with a transform counter; abort + roll back past `MAX_TOTAL` or per-file >100 MB.

#### [B-H10] High — Upload disk-fill: 2 GB total checked *after* write
- **Refs:** `server.js:1511-1526` | **Category:** Security/Bug
- Multer (`500 MB × 100`) writes to disk first; the 2 GB cleanup is post-hoc. Attacker fills disk; aborted uploads leave temp files.
- **Fix:** Pre-check `Content-Length`, per-request quotas via `limits`, cleanup on `error/close`, use `fileFilter`.

#### [B-H11] High — `GET /api/files/tail` buffers up to 100 MB + char/byte mismatch
- **Refs:** `server.js:1869-1914` | **Category:** Performance/Bug
- `readFile(p,'utf8')` loads the whole file; concurrent tails OOM. `lastSize=content.length` (chars) vs `stat.size` (bytes) corrupts multibyte logs; `Buffer.alloc(newSize-lastSize)` unbounded.
- **Fix:** `fs.open` + read last N bytes; byte offsets only; cap ~64 KB per poll; prefer `Range`.

#### [B-H12] High — Content search loads whole files + sync ReDoS in event loop
- **Refs:** `server.js:1755-1821` | **Category:** Performance/Security
- Full 10 MB `readFile` per file, `new RegExp(query,'gi')` with an ineffective guard (1759-1762); `(a+)+$` hangs the server. `Promise.all(dirs.map(walk))` fans out unbounded → fd exhaustion.
- **Fix:** Stream line-by-line, per-line timeout / `re2`, concurrency queue (`p-limit 8`), overall 10 s timeout.

#### [B-H13] High — `taskkill`/`dscl` string interpolation (Windows/macOS)
- **Refs:** `server.js:945-949,1576,3501-3508` | **Category:** Security
- `execSync(`taskkill /PID ${pid} /T /F`)`; `pid` validated on the kill route but the `killPid()` helper only checks `isInteger>0` — future-caller risk. `dscl` interpolates `st.gid` similarly.
- **Fix:** Always `execFileSync('taskkill',['/PID',String(pid),...])`; never `execSync(string)` with interpolation.

#### [B-H14] High — `cleanup()` kills user `wt-*` tmux sessions, contradicting its own guard
- **Refs:** `server.js:4081-4088` vs `2882,2917-2933` | **Category:** Bug
- Startup correctly filters `TMUX_PREFIX=wt-webtun-`, but shutdown kills `s.startsWith('wt-')` → destroys user sessions on SIGTERM.
- **Fix:** Kill only `TMUX_PREFIX`.

### A.3 Medium severity

- **[B-M1] Medium — `.env` `export PIN=` unreadable; persist/format mismatch** (`server.js:4-20,531-548`). Loader stores key `export PIN` literally; persister handles `export` but loader never reads it back. Values with `#`/spaces trimmed silently. → Strip `^export\s+`, handle inline `#` only when quoted, round-trip quoting.
- **[B-M2] Medium — Exported `PIN` is a snapshot, not live** (`server.js:4128`). `module.exports={PIN}` copies the string; CLI/Electron see stale PIN after `POST /api/pin` rotation. → Export getter `get PIN(){return PIN}` or `getPin()`.
- **[B-M3] 🛈 INTENTIONAL — `pendingPinChange` single global → DoS + timer leak** (`server.js:558-562,580-581,612-631`). Intentional serialization (one rotation at a time, 60 s second-session approval). No action.
- **[B-M4] 🛈 INTENTIONAL — `SESSION_MAX` eviction deletes oldest active admin** (`server.js:326-333,2895-2910`). Intentional DoS-cap simplification for single-user queue. No action.
- **[B-M5] 🛈 INTENTIONAL (design) — WS handshake throttle keyed by `remoteAddress` collapses behind tunnel** (`server.js:2997-3002,3056-3064`). `XFF` display-only / spoofable by design (`server.js:294`). No action.
- **[B-M6] Medium — WS `rawPinAllowed` built from fake `req`, ignores trust-proxy** (`server.js:3054`). Passes `{ip: socket.remoteAddress,...}` while `isLoopbackReq` reads `req.ip` → inconsistent HTTP vs WS gating behind proxies. → Shared `isLoopbackSocket(socket, headers)` helper; test both paths.
- **[B-M7] 🛈 INTENTIONAL under default config — TOCTOU on all `realPath`-then-use file ops** (`server.js:1115-1117,1193-1194,1233,1405,1452`). Full FS by design; sandbox hardening applies only under `ALLOW_FULL_FS=false`. No action by default.
- **[B-M8] Medium — `dirSize` sync `realpathSync` + unbounded `Promise.all` recursion** (`server.js:746-804,1292,1457,1618`). Called by zip/download/size; blocks loop on big trees; per-level concurrency 32 fans out exponentially. → Async realpath, global work queue, timeout + mtime cache, fast-reject >50k files.
- **[B-M9] Medium — `createZipArchive` `new Promise(async…)` anti-pattern + sync stat** (`server.js:806-866`). Async executor swallows rejections; `lstatSync/statSync/dirSize` block; TOCTOU size→archive race; `archiver` follows symlinks by default. → Plain `async/await`, `follow:false`, re-check sizes during append.
- **[B-M10] Medium — `/api/files/stat` blocks loop with `id/getent/dscl` per request** (`server.js:1564-1587,1935-1985`). No timeouts on a hot metadata path. → Async `execFile`, 5-min TTL cache, `timeout:2000`.
- **[B-M11] Medium — Error messages leak absolute paths** (`server.js:1098,1210,1389,1597-1598` — only `/stat` masks). `ENOENT/EACCES` messages include `/home/…`. → Central `safeErr(e)` → `E_NOT_FOUND/E_DENIED` + code; log full server-side only.
- **[B-M12] Medium — Clipboard per-IP collapses behind tunnel, no TTL** (`server.js:1996-2070`). Key `req.ip` is `127.0.0.1` for all tunnel users → cross-user paste; entries live forever. → Key by `authToken`, 15-min expiry + sweep.
- **[B-M13] Medium — `cmdHistMax` in-memory only; XSS surface** (`server.js:2075,2100-2124`). `max` never persisted; `cmd` truncated to 1000 and stored raw. → Persist `{max,items}` in `.cmdhist.json`; validate/escape client-side.
- **[B-M14] 🛈 INTENTIONAL — Git `commit{all:true}` runs `add -A`, can stage secrets** (`server.js:2418`). Intentional `git commit -a` equivalent; caller opts in. No action.
- **[B-M15] Medium — Hunk index TOCTOU can stage the wrong hunk** (`server.js:2840-2854`). Diff re-derived at POST time; shifted indices apply a *different* hunk. → Send `expectedHeader` + context hash; verify + `git apply --check` first.
- **[B-M16] Medium — Tunnel PID-reuse false-positive + restart hot-loop** (`server.js:3544-3560,3585-3594,3620-3668`). `/proc/pid/cmdline contains cloudflared` suffers PID reuse; dead tunnel retries every 30 s with no backoff. → Verify with `startTime`, exact cmdline; exponential backoff, max ~5 retries then `dead`.
- **[B-M17] 🛈 INTENTIONAL — `tunnel-url.txt` world-readable** (`server.js:3575-3583` vs `3562-3573`). Contains only public tunnel URLs (public by nature). No action.
- **[B-M18] Medium — Preview `Location` rewrite misses `0.0.0.0/[::1]/LAN` → open redirect** (`server.js:3900-3906`). Only `localhost|127.0.0.1` rewritten; upstream `302 → evil.com` passes through. → Allow-list `Location` to `^/api/preview/<port>/`, else error page.
- **[B-M19] Medium — Preview forwards `Authorization` + cookies upstream** (`server.js:3869-3885`). Strips host/token cookies but forwards `authorization:*` to untrusted loopback apps. → Deny-list `authorization,proxy-*,x-*token`; strip `cookie` by default.
- **[B-M20] 🛈 INTENTIONAL — `/api/ports` + `/api/system/network` info disclosure + sync block** (`server.js:1923-1990,3981-4016`). Intentional System Stats feature (`README.md:107-111`). No action.
- **[B-M21] Medium — No HTTPS/HSTS; PIN bearer over plain HTTP on LAN** (`server.js:161,4097-4112`). `http.createServer` only. → Document reverse-proxy TLS; add HSTS when `X-Forwarded-Proto:https`; support `TLS_CERT/KEY`.

### A.4 Low / dead code / perf nits (backend)

- **[B-L1] Low — `ALLOWED_WS_ORIGINS` never populated** (`server.js:2996,3038`). Empty `Set` → dead disjunct; bare `http://localhost` check never matches. → Wire `ALLOWED_ORIGINS` env or remove.
- **[B-L2] Low — Unreachable branches** (`server.js:2112,2968,3076,3248`). E.g. `if(id==='')` after length guard; `!Number.isFinite(cols)` after clamp. → Remove; add validator unit tests.
- **[B-L3] Low — `killPid(pid, signal='SIGTERM')` signal unused; `isValidPID` single-use** (`server.js:945-960,2912-2914`). Windows path ignores signal. → Drop param or support `SIGKILL` fallback.
- **[B-L4] Low — Global `express.json({limit:'50mb'})` buffers before per-route 10 MB caps** (`server.js:193,1402,1752`). 50 MB JSON to `/write` spends memory before the 10 MB check. → Global 2 MB; per-route 12 MB only on write/history.
- **[B-L5] Low — Intervals never `unref`ed; `clipboards` never swept** (`server.js:154-157,255-261,2892-2910,2999-3002,3660-3668`, map at 1996). 5× `setInterval` keep the process alive; clipboard + owner-cache leak. → `.unref()`, 30-min TTL sweep, proper LRU.
- **[B-L6] Low — Per-request 100 ms CPU sampler + `df/ps/nvidia-smi` on `/api/system`** (`server.js:3330-3395`). Frontend polling self-DDoSes. → 2 s cache, background sampler.
- **[B-L7] Low — `spawnRead` 2 MB buffer sliced to 200 KB after** (`server.js:3301-3327,2344-2348,2768-2771`). Wasted buffering; `close` resolves even after `killed` reject (double-settle). → `maxBuffer:256KB`, guard `if(killed) return`.
- **[B-L8] Low — `uncaughtException` kills tunnels; `unhandledRejection` silently continues** (`server.js:4115-4122`). Inconsistent crash semantics. → Log + cleanup + exit in both paths.
- **[B-L9] Low — `loadEnvFile` sync at import + `resolveDataDir` mkdir side-effect** (`server.js:4-29,503-511`). Runs on every `require(server)` including tests. → Lazy-load; `mkdir` only in `startServer()`.
- **[B-L10] Low — Copy/move `keep_both` loop unbounded** (`server.js:1137-1147` vs batch-zip cap at 1850). 10k collisions → long loop. → Cap 1000, return 409.
- **[B-L11] Low — `parsePreviewCookie`/`targetPort` regex built from input (benign today)** (`server.js:3808-3819,3856`). Numeric-validated now but fragile. → String `slice`, not `RegExp`.
- **[B-L12] Low — `GET /api/git/*` returns 400 when git missing (should be 501/412)** (`server.js:2332,2356,2479…`). Client can't distinguish "not a repo" from "no git binary". → `501 {git:false}` consistently.
- **[B-L13] 🛈 INTENTIONAL under default config — `POST /api/files/symlink` can escape sandbox + parent follows links** (`server.js:1715-1730`). Symlink dirs navigable by design (`README.md:222`); sandbox applies only under `ALLOW_FULL_FS=false`. No action by default.

---

## PART B — Frontend (`public/index.html`, `commands.js`, `sw.js`, `docs.html`, `manifest.json`)

### B.1 Bugs

#### [F-B1] Critical — `new Uint8Array(e.data)` crashes if WS delivers `Blob`
- **Refs:** `index.html:3359-3366` | **Severity:** Critical
- Handler assumes `ArrayBuffer` (`binaryType='arraybuffer'`). First frame before the flag applies, reconnects, or back-pressure can deliver `Blob`; `new Uint8Array(blob)` throws and kills the socket handler.
- **Fix:** `const buf = e.data instanceof Blob ? new Uint8Array(await e.data.arrayBuffer()) : new Uint8Array(e.data)` (make handler async).

#### [F-B2] Critical — Re-login stacks duplicate global listeners (shortcuts fire N×)
- **Refs:** `index.html:2572-2641,8472-8508,8852,9103,4819-4845` | **Severity:** Critical
- `unlockApp()` unconditionally calls `setupKeyboardShortcuts()`, `setupDragDrop()`, `setupSwipeGestures()`, `setupFileList*()`, `startFileWatcher()` (interval guarded, listeners not). After PIN rotation/sign-out/in, `Ctrl+T` creates multiple tabs, overlays toggle repeatedly.
- **Fix:** Guard each setup with a `dataset._setup` flag (as file-list handlers already do) or hoist one-time wiring out of `unlockApp()`.

#### [F-B3] High — Paste path splits UTF-8 bytes mid-character
- **Refs:** `index.html:2738-2755` vs `8638-8656,3851-3873` | **Severity:** High
- `sendWsInput()` splits on char boundaries correctly; `pasteToTerminal()`/bracketed-paste slice `TextEncoder` bytes at 60 KiB → multi-byte sequences split across WS messages decode as `�`.
- **Fix:** Reuse `sendWsInput(ws, bracketed)` for paste paths.

#### [F-B4] High — PIN `maxlength` mismatch locks out long PINs
- **Refs:** `index.html:1364` vs `7636-7637,1809,1813` | **Severity:** High
- Unlock input `maxlength="32"`; `changePin()` allows 64. A 33–64 char PIN can be set but never typed back.
- **Fix:** Both to 64 (or cap `changePin` at 32 with a field error).

#### [F-B5] High — Theme bootstrap vs `applyTheme()` disagree; xterm reads wrong node
- **Refs:** `index.html:1346-1355,8050-8063,4239-4251` | **Severity:** High
- Boot sets only `body.dataset.theme`; `applyTheme()` sets body + `documentElement`. `getXtermTheme()` reads `documentElement` → first paint in light mode reads `:root` dark vars. `system→dracula/light` mapped once, never re-evaluated.
- **Fix:** Set `documentElement.dataset.theme` in boot too; make `getXtermTheme()` read `body`.

#### [F-B6] High — `scrollback` clamp disagrees with input limits
- **Refs:** `index.html:1876,7257,8072-8077` | **Severity:** High
- Input `max="100000"`; `loadSettings()` accepts ≤50000, `applyScrollback()` silently clamps. 60000–100000 looks accepted, becomes 50000.
- **Fix:** Input `max="50000"` + toast/field error on clamp.

#### [F-B7] High — `atob()`/`btoa()` break on non-Latin1 clipboard (OSC 52)
- **Refs:** `index.html:3327,3335` | **Severity:** High
- Both throw on emoji/CJK; paths `catch(()=>{})` and drop clipboard sync.
- **Fix:** UTF-8-safe base64 helpers (`TextEncoder`/`TextDecoder` + `Uint8Array.from(atob…)`).

#### [F-B8] High — Finder abort → unhandled rejection
- **Refs:** `index.html:10097-10109,2708-2734` | **Severity:** High
- `doFinderSearch()` aborts prior `finderAbort`; `api()` turns user-abort into `DOMException('Aborted')`; `setTimeout(async…)` has no `try/catch` → unhandled rejections on fast typing; `finderAbort=null` never reached.
- **Fix:** `try/catch` around finder fetch; ignore `AbortError`.

#### [F-B9] High — Terminal search count is fake; prev/next don't update UI
- **Refs:** `index.html:7230-7241` | **Severity:** High
- `doSearch()` calls nonexistent `getDecorations?.()` on `addon-search@0.15.0`; fallback `found?1:0` → always `1/1`. `searchNext()/searchPrev()` never update `#search-results`.
- **Fix:** Central `updateSearchCount()` called by all three; or upgrade addon and use its decoration API.

#### [F-B10] High — `closeTab()` unsaved-check ignores doc previews
- **Refs:** `index.html:3499-3514` vs `5952-5960` | **Severity:** High
- Compares `editor.getValue()` vs `editorOriginalContent` even for PDF/EPUB/Office previews (CodeMirror holds stale text) → false "unsaved changes" prompts or missed drafts.
- **Fix:** Reuse `closeEditor()`'s `isDocPreview` guard in `closeTab`.

#### [F-B11] Medium — `fitTerm()` only fits active tab; tiles stay mis-sized
- **Refs:** `index.html:3910-3913,4089-4115` | **Severity:** Medium
- `ResizeObserver` early-returns unless `activeTabId===tab.id`. In tiles mode all wrappers visible; background tiles never refit.
- **Fix:** In tiles mode fit all tabs.

#### [F-B12] Medium — Private xterm internals (`_core`) freeze upgrade path
- **Refs:** `index.html:4014,4033,4092` | **Severity:** Medium
- Wheel fallback + `fitTerm` reach into `term._core.coreMouseService` / `viewportRenderer.dimensions`. Any minor bump can silently break scroll/fit.
- **Fix:** Feature-detect public API (`term.options`, `fitAddon.proposeDimensions()`); drop `_core` reads.

#### [F-B13] Medium — Pinch-zoom persistence clobbers in-memory settings
- **Refs:** `index.html:4070-4076` | **Severity:** Medium
- Handler round-trips `wt-settings` from storage, discarding unsaved in-memory changes (e.g. just-toggled bell).
- **Fix:** Mutate live `settings` + `saveSettings()`.

#### [F-B14] Medium — Visual-viewport keyboard margin sign suspect (iOS)
- **Refs:** `index.html:8744-8761` | **Severity:** Medium
- Positive `marginBottom` on keyboard-open likely double-offsets iOS (viewport already shrank); `offsetTop` ignored.
- **Fix:** Verify on iOS/Samsung; fit active term after change.

### B.2 Security

#### [F-S1] 🛈 INTENTIONAL trade-off — Preview `base href` embeds session token readable by previewed scripts
- **Status:** 🛈 INTENTIONAL trade-off — token-bearing preview URLs required for `<iframe>`/`<img>` auth (no headers possible); iframe stays `sandbox` without `allow-same-origin`. No action.
- **Refs:** `index.html:6952-6970,7032-7035,7044-7050` | **Severity:** Critical
- `renderHtmlPreview()` injects `<base href="/api/files/image?path=…&token=…">` into `iframe.srcdoc`. Iframe is `sandbox="allow-scripts"` (no `allow-same-origin`, good) but scripts still run and can read `base.href` → token theft. Same pattern in `toPreviewApiUrl()` for every relative `src/href`.
- **Fix:** Never mint token-bearing URLs into preview DOM. `fetch` + header auth → `blob:` (as `openImageViewer()` at `6883` already does), or single-use file tokens, or drop `allow-scripts` for file previews.

#### [F-S2] High — EPUB renderer creates unsandboxed iframe
- **Refs:** `index.html:6554,6559,787,1686` | **Severity:** High
- Relies solely on `allowScriptedContent:false`; generated `#epub-view iframe` has no `sandbox` attribute (unlike editor/app previews). Malicious EPUB script execution depends on epub.js version behavior.
- **Fix:** Set a `sandbox` (without `allow-same-origin`) on generated iframes post-`renderTo`.

#### [F-S3] High — OSC 52 clipboard READ exfiltrates without consent
- **Refs:** `index.html:3332-3342` | **Severity:** High
- On `ESC]52;;?` the terminal auto-reads `navigator.clipboard.readText()` and sends it to the pty. Any remote output (`printf`) silently pulls the clipboard into the server session.
- **Fix:** Gate GET behind `confirmDialog()`/opt-in; honor SET by default only.

#### [F-S4] 🛈 INTENTIONAL — Inline `onclick` + inline script/style block strict CSP; no SRI
- **Status:** 🛈 INTENTIONAL — single-file vanilla JS, no bundler (`AGENTS.md:9,48`). No action.
- **Refs:** `index.html:1339-1356,2238,1423,1981-2032` (~100× `onclick`), `18-42` (no `integrity`) | **Severity:** High
- App depends on inline handlers/boot script/inline `<style>`. A hardened `script-src 'self' https://cdn.jsdelivr.net` (no `unsafe-inline`) kills the UI. No nonces/hashes/SRI on CDN scripts.
- **Fix:** Pin CDN files with SRI hashes; migrate `onclick` → `addEventListener`; add CSP nonces/hashes if hardening.

#### [F-S5] 🛈 INTENTIONAL trade-off — Thumbnail + preview tokens in `src`/`data-src` log sessions
- **Status:** 🛈 INTENTIONAL trade-off — `<img>` cannot send auth headers; token query required. No action.
- **Refs:** `index.html:6643-6649,6966-6968` | **Severity:** High
- `thumbUrlFor()` (`&token=…`) lands in `img[data-src]` for up to ~48 tiles per render; every fetch logs the session token.
- **Fix:** `fetch` + `x-pin-token` → `IntersectionObserver` sets `blob:` URLs; revoke on re-render.

#### [F-S6] Medium — SVG `innerHTML` + `srcdoc` style surface
- **Refs:** `index.html:6743,7029,7042,7913-7918` | **Severity:** Medium
- `mkSvg().innerHTML = inner` safe today (static strings) but future server-data callers become XSS (SVG `innerHTML` can execute `<script>`). HTML preview allow-lists `ADD_TAGS:['base','style']` — `<style>` permits CSS exfiltration (`url()`, `@import`).
- **Fix:** Keep `mkSvg` static-only with guard comment; drop `'style'` from `ADD_TAGS` or strip `url(`/`@import` post-sanitize.

#### [F-S7] Medium — Tunnel `window.open` missing `noopener`
- **Refs:** `index.html:6749,7971` | **Severity:** Medium (low risk — same app)
- Office links use `rel="noopener"`; tunnel `window.open(url,'_blank')` doesn't → `window.opener` retained. Inconsistent.
- **Fix:** `window.open(url,'_blank','noopener')`.

### B.3 Unused / dead code (frontend)

- **[F-D1] Medium — CodeMirror modes mapped but never loaded** (`index.html:5789-5826` vs `29-42`). `getCMmode()` returns ruby/php/perl/swift/kotlin/dart/lua/r/toml/powershell with no `<script>` included → silent plain-text fallback + console warnings. → Load missing modes or map to `text/plain`.
- **[F-D2] Medium — Dead CSS/ID selectors** (`index.html:239-240,576,594-595,701,907`; vars at `1395,7724`). `makeFileItem()` (`4651-4671`) emits `.file-quick`/`.file-ellipsis`, never `.file-actions`; preview inputs use classes so `#preview-port/path-input` never match; `kbd{background:var(--bg1)}` references undefined `--bg1`; `--amber` never defined in any theme. → Delete dead rules; define or replace tokens.
- **[F-D3] Medium — Icon-set vs tile-kind taxonomies diverged** (`index.html:4587-4595` vs `4848-4858`). `getFileIcon()` vs `fileKind()` disagree on `.mjs/.cjs/.bash/.doc/.txt/.md` → mismatched icon-vs-tile colors. → Single shared `EXT_KIND` map.
- **[F-D4] Medium — `loadDraft()` written, never read** (`index.html:5763-5780`; open path `5828-5930`; docs promise at `docs.html:581`). Drafts accumulate forever; false crash-safety. → Restore dialog; purge `wt-draft:*` on save/close.
- **[F-D5] Medium — PWA shortcut `/?newTerm=1` has no handler** (`manifest.json:20-22`). Never parsed; shortcut is a no-op duplicate of launch. → In `unlockApp()`, `if (new URLSearchParams(location.search).get('newTerm')) newTab()`.
- **[F-D6] Low — `docs.html` theme button assumes DOM exists** (`docs.html:810`). No null guard; if topbar renamed, whole IIFE (scroll-spy, search, copy, reveal, typing) dies. → `?.addEventListener`.

### B.4 Performance (frontend)

- **[F-P1] High — ~550 KiB blocking inline script delays first unlock** (`index.html:2237-2238`; `commands.js:1-6` also render-blocking; CDN scripts `defer`red but inline bundle still parses before `init()`). → Split editor/PDF/EPUB/office/git into lazy `import()`/`loadScript` chunks; `defer` `commands.js`.
- **[F-P2] High — `startPreviewLiveReload` diffs full file every second** (`index.html:7149-7160`). `editor.getValue()` up to 10 MiB (`5735`) + string compare per tick, even while typing → GC thrash. → CodeMirror `change` (debounced 500 ms); skip >500 KiB.
- **[F-P3] Medium — Polling storm** (`index.html:2585,3688,4373,4845,10539`). Launchpad 5 s + sys-icon 10 s + cup 60 s + watcher 10 s + git-status-per-nav, no shared cache; 3–4 requests overlap per 10 s. → Single `systemCache` (10 s TTL); skip `refreshGitPanel` when `gitRoot` unchanged.
- **[F-P4] Medium — `doSearch()` scans 50k scrollback per keystroke** (`index.html:1591,3804,7230-7238`). `oninput="doSearch()"` synchronously scans whole buffer → jank. → Debounce 150 ms; viewport-capped incremental search.
- **[F-P5] Medium — Upload progress writes layout per `progress` event** (`index.html:5658-5664`). `style.width` + `textContent` hundreds/sec → style recalc. → `requestAnimationFrame` throttle; text ≤4 Hz.
- **[F-P6] Medium — PDF: all-page placeholder DOM + O(N) scroll scan** (`index.html:6219-6239,6386-6410`). 1000-page PDFs create 1000 nodes upfront; scroll iterates all per frame. → Virtualize (window ±5 pages) or binary-search cached offsets.
- **[F-P7] Medium — WebGL addon never disposed** (`index.html:3529,3830-3837`). `tab._webglAddon` stored but `closeTab()` only `term.dispose()` → GL contexts linger; `<4 tabs` heuristic counts terms not memory. → `tab._webglAddon?.dispose()` in teardown; prefer canvas on low-memory devices.
- **[F-P8] Medium — Doc libs preload despite Data Saver + no abort** (`index.html:6852-6869,7373-7382`). 4 CDN fetches (pdf/epub+jszip/mammoth/xlsx) 1.5 s after load unless datasaver already on; toggling later doesn't evict. → Skip on `Save-Data`/`navigator.connection.saveData`; load on first open.
- **[F-P9] Low — `docs.html` hero re-sets `innerHTML` per typed char** (`docs.html:959,974-982`). Full scene rebuild every 12–34 ms + `esc()` misses `>`/`"`. → Type into a text node; complete `esc()`.

### B.5 Incomplete logic / a11y / PWA

- **[F-A1] Medium — Tabs not keyboard-focusable; nested `role=button`** (`index.html:2646-2659,2883-2931,4199-4206`). `.tab[role=tab]` lacks `tabindex`; arrow handler on `#tab-scroll` unreachable via Tab. Tile header nests `.tth-name[role=button]` — invalid for AT. → Roving `tabindex="0"`, `aria-selected`/`aria-controls`; plain span for name.
- **[F-A2] Medium — Settings `inert` covers `#content` but not `#sidebar`** (`index.html:7427-7452`). Sidebar/header/tab-strip stay interactive behind modal; focus trap catches Tab but not click/virtual cursor. → `inert` both (or move panel out of `#main`).
- **[F-A3] Medium (part 🛈 INTENTIONAL) — SW precache omits `commands.js`; manual version; query variants bloat cache** (`sw.js:1-9,42-58`; `index.html:10747-10770`). No auto-reload is intentional (`AGENTS.md:45` — live terminal). Precache additions still actionable.
- **[F-A4] Medium (part 🛈 INTENTIONAL) — Manifest gaps** (`manifest.json:6,11-12,14`). Root-absolute URLs intentional (app always at domain root). Screenshots/`id`/splash still actionable.
- **[F-A5] 🛈 INTENTIONAL — `safeStorage` swallows quota errors silently** (`index.html:1341-1345`). Intentional survival under Edge Tracking Prevention (`AGENTS.md:47`). No action.
- **[F-A6] Low — Path-bar `blur` discards typed path silently** (`index.html:4973-4977`). Mobile keyboard-dismiss looks like broken nav. → Toast or commit-on-blur.
- **[F-A7] Low — `docs.html` canonical points at `/public/docs.html`** (`docs.html:9,14-15,28`). If Pages serves from root (`.nojekyll`, relative assets per `AGENTS.md`), canonical/OG split SEO equity. → Align to live Pages URL.

---

## PART C — Infra: CLI, Electron, cloudflared, installers

### C.1 Bugs — CLI / lifecycle / scripts

- **[I-B1] 🛈 INTENTIONAL — CLI `-h` means `--host`, not help; `-H` non-standard** (`bin/webtun.js:19,44,62`; `README.md:137-138`). Documented intentional choice. No action.
- **[I-B2] Medium — `--pin` swallows typo'd flags as the PIN** (`bin/webtun.js:53-56,63-66,68-76`). `--port/--host` reject dash-led values; `--pin` only rejects 11 `KNOWN_FLAGS`. `--pin -tunnel` (typo) silently sets `PIN="-tunnel"`. → Reject any `-`-led value for `--pin` except `--pin=…` form.
- **[I-B3] Medium — Env `PORT` never validated on CLI path** (`bin/webtun.js:151-153`; `server.js:164,4097-4099`; `electron/main.js:11-14`). CLI validates `--port` (1–65535) but `listenPort = opts.port || PORT` passes env garbage (`"abc"`) to `listen()`. Electron validates; CLI doesn't. → Same `parseInt` + range check for env `PORT`; fallback 3000 + warning.
- **[I-B4] Medium — `webtun --tunnel` exits 0 when tunnel never starts** (`bin/webtun.js:96-102,134-138`). `ensureCloudflared()` throw → print + `return` (exit 0). Non-zero cloudflared exit before URL → stderr line only. → `process.exitCode = 1` when download fails or child exits non-zero without URL.
- **[I-B5] Medium — CLI has no free-port fallback or healthcheck; Electron does** (`bin/webtun.js:155-162`; `electron/main.js:48-67,136-148`; `setup.sh:268-290`). Occupied port → `Failed to start server` + exit 1. → Reuse `findFreePort` fallback (or suggest `PORT=3001`); poll `/api/auth/required` before `startTunnel()`.
- **[I-B6] Medium — Tunnel URL regex only matches `trycloudflare.com`** (`bin/webtun.js:113-125`; `setup.sh:338`). Misses `*.cfargotunnel.com`, new TLDs, case/format changes; duplicated brittle regex. Tunnel up, no "Public URL" printed; CLI waits forever (no timeout). → Match `(trycloudflare\.com|cfargotunnel\.com)` case-insensitive; 15 s timeout printing log tail + non-zero exit.
- **[I-B7] High — `sleep 0.5` breaks `setup.sh` on macOS (`set -e` abort)** (`setup.sh:1-2,258,270`). macOS `/bin/sleep` rejects fractional seconds → whole setup aborts before server start, despite explicit Darwin support (`75-80,180-192`). → `sleep 1`.
- **[I-B8] High — systemd offered *after* nohup start → double instance** (`setup.sh:203-239,241-265,315-320`). nohup backgrounded at 263, systemd offered at 315 → second `node server.js` on same `$PORT` → EADDRINUSE crash loop. → Offer systemd *before* nohup; skip nohup if systemd installed (or stop nohup PID first).
- **[I-B9] Medium — systemd `User=$USER` is root under sudo; `EnvironmentFile` breaks on PINs with spaces** (`setup.sh:150-154,222,228`). → `User=${SUDO_USER:-$USER}`; quote/escape PIN; `systemd-analyze verify`.
- **[I-B10] Medium — `setup.sh` never validates `$INPUT_PORT`/existing `.env` `PORT`** (`setup.sh:127-131,137-138`). Any string written (`PORT=abc`) → cryptic `curl`/`listen` failures. → `^[0-9]+$` + 1–65535 loop (mirror `bin/webtun.js:58`).
- **[I-B11] Medium — Electron `findFreePort` TOCTOU + silent occupied-port fallback** (`electron/main.js:51-67,218-225`). Probe-bind-close race; exhaustion resolves to the known-occupied port → guaranteed `EADDRINUSE` dialog. → Retry `startServer` on EADDRINUSE or `listen(0)`-probe; throw when range exhausted.
- **[I-B12] Low — `stop.sh` leaves stale pidfile; tunnel pattern overbroad** (`stop.sh:23-31`). `pkill -f server.js` path never removes `webtun.pid` → stale PID next run. `pkill -f "cloudflared tunnel.*localhost:"` kills *any* localhost tunnel on the box. → `rm -f` on both paths; scope to instance port or track tunnel PID.
- **[I-B13] Low — Dead `typeof PIN !== 'string'` check + silent PIN trim in Electron** (`electron/main.js:15-18,79-84`). `process.env` values always strings; `trim()` mutates intentional leading/trailing spaces. → Drop check; pass PIN verbatim or reject whitespace loudly.

### C.2 Security (supply chain / Electron / secrets)

- **[I-S1] High — cloudflared fetched with no checksum/signature; open redirects** (`lib/cloudflared.js:18,56-60,98-109`; `setup.sh:166-178,188-190`). HTTPS-per-hop but follows *any* `Location:` (no allow-list for `github.com`/`objects.githubusercontent.com`/`*.cloudflare.com`); no SHA256/signature/min-size check; `curl -fsSL` lacks `--proto '=https'`. Compromised redirect/mirror → arbitrary executable `chmod +x`'d and run. → Allow-list redirect hosts; verify SHA256 vs release manifest (min: size + ELF/MZ/Mach-O magic + `--version` smoke test); `curl --proto '=https' --tlsv1.2`.
- **[I-S2] Medium — HTML-error-page check bypassable** (`lib/cloudflared.js:111-121`). Rejects only bodies starting `<!doctype html`/`<html`; JSON/XML/JS/comment-prefixed HTML pass, get `chmod 755`, then `spawn`ed. → Positive validation: magic bytes + size >~5 MB; reject `<!`/`{`/`<` prefixes; assert octet-stream-ish `Content-Type`.
- **[I-S3] Medium — Tar-slip guard misses symlinks/hardlinks; `/tmp` handling differs** (`lib/cloudflared.js:124-141`; `setup.sh:188-190`). Checks `..`/absolute but not `~`, `C:\`, `..\`, `%2e%2e`, nor symlink/hardlink targets escaping `tmpDir` (`tar xzf -C` follows them). `setup.sh` extracts with zero validation into shared `/tmp`; no tar size cap. → Reject `link`/`symlink` entries, post-extract `realpath` containment check; `mkdtemp` in setup.sh; cap download size.
- **[I-S4] High — `findCloudflared()` prefers `cwd/cloudflared` → CWD hijack → RCE** (`lib/cloudflared.js:25-28,39-41`). Candidate #2 is `cwd/cloudflared` ahead of `/usr/local/bin`, `/usr/bin`, `~/.local/bin`; no exec-bit/ownership check (`isFile()` only). Running `webtun --tunnel` (or tunnel UI per `AGENTS.md`) from an attacker dir executes their binary. → System/user paths first, cwd last or never; require `mode & 0o111`, non-world-writable; log chosen binary.
- **[I-S5] High — `.env` with PIN written world-readable by `setup.sh`** (`setup.sh:149-154`; `.gitignore:2`; `AGENTS.md:104`). `> "$ENV_FILE"` honors umask (022 → `0644`); runtime rotation is atomic 0600 but first-time setup isn't. → `umask 077` + `chmod 600`; document `chmod 600 .env`.
- **[I-S6] Medium — `curl … | sudo bash` for Node with output suppressed** (`setup.sh:61,64-67`). Piped nodesource scripts to root bash with `&>/dev/null` — unauditable, failures hidden; no fingerprint pin. → Keep output visible; surface errors (`pipefail` already set).
- **[I-S7] Low — Fixed `/tmp/cloudflared` + `/tmp/cf.tgz` paths** (`setup.sh:176-178,188-190`). Pre-planted symlink redirection before `sudo mv` (contrast `lib/cloudflared.js:103` `mkdtempSync`). → `TMP=$(mktemp -d)` + `trap 'rm -rf "$TMP"' EXIT`.
- **[I-S8] Info — Electron sandbox posture good; 4 flags missing** (`electron/main.js:152-165,167-175`; `preload.js:1-8`). Positive: `nodeIntegration:false, contextIsolation:true, sandbox:true`, thin preload, DevTools dev-gated. Gaps: no explicit `webSecurity:true, allowRunningInsecureContent:false, webviewTag:false, navigateOnDragDrop:false`; View menu keeps reload roles in prod. → Set the four flags; consider stripping reload in packaged builds.
- **[I-S9] 🛈 INTENTIONAL — `execSync(taskkill…)` + `command -v` safe, don't "fix"** (`electron/main.js:242-246`; `lib/cloudflared.js:42-46`). Audited safe; intentional. No change.

### C.3 Unused / dead code / drift

- **[I-D1] Medium — `PREVIEW_TAB_PLAN.md` 100% unimplemented; refs will rot** (`PREVIEW_TAB_PLAN.md:17,25-26,29-33`; `AGENTS.md:50-86`; `README.md:74-123`). All checkboxes `[ ]`; zero preview routes/tabs in documented architecture; hard line pins (`server.js:330`, `index.html:2700/2683/3059/2129`) drift; §5.1 cookie-auth contradicts current `?token=` model. → Status header (`planned — not implemented as of v2.0.5`) or move to an issue; symbol names over line pins.
- **[I-D2] 🛈 INTENTIONAL — `.npmignore` duplicates `files` whitelist (6 dead lines)** (`.npmignore:9,12-14,28`; `package.json:14-20`). Harmless shadowing; packaging minimalism. No action.
- **[I-D3] Low — npm tarball omits `LICENSE` (+`README`); `robots.txt`/`sitemap.xml` never ship** (`package.json:14-20,65-72`). Electron build includes `LICENSE`; npm `files` doesn't (PolyForm requires license distribution). Root `robots.txt`/`sitemap.xml` in neither list → `npx webtun` users 404. → Add `LICENSE` (+`README.md`) to `files`; decide `robots.txt`/`sitemap.xml` home (`public/` vs Pages-only).
- **[I-D4] Info — `postinstall.js:13` "not installed yet" early-return stale** (`postinstall.js:12-13`; `package.json:33`). Postinstall runs after linking; dir essentially always exists. Masks genuine missing-dep states. → Log loudly or throw when absent.
- **[I-D5] 🛈 INTENTIONAL — `pack` script undocumented; no test/lint by design** (`package.json:28`; `AGENTS.md:24`). Verify via `npm start` by design. No action.

### C.4 Performance / reliability

- **[I-R1] Medium — No retry/resume/size-cap on cloudflared download; post-response stall hangs forever** (`lib/cloudflared.js:50-76,107-109`). Single attempt; 60 s timeout only covers connect; no idle watchdog, `Content-Length` cap, or resume. → Idle watchdog (reset on `data`), 2–3 retries with backoff, ~100 MB max-size abort.
- **[I-R2] Medium — `asarUnpack` covers only `node-pty`; resolution order confusing but functional** (`package.json:73-75`; `electron/main.js:20-38`). JS loads from asar while node-pty self-resolves its unpacked binary; comment implies a fallback that rarely engages. → Clarify comment; extend `asarUnpack` with `**/*.node` when adding native deps.
- **[I-R3] Low — `nodemon` dev loop has no config; restarts wipe in-memory PTYs** (`package.json:26`; `.npmignore:6` references nonexistent `nodemon.json`). → Add `nodemon.json` (`ignore: [webtun.log, cloudflared.log, .tunnels.json]`, `ext: js,json`); document session loss in `npm run dev`.
- **[I-R4] Low — `postinstall` rebuild targets Node ABI, not Electron ABI** (`postinstall.js:19-23`; `package.json:26-27`). `npm rebuild node-pty` correct for `npm start`/`npx`; `npm run electron` on mismatched ABI crashes. Fix (`electron-builder install-app-deps`/`electron-rebuild`) never invoked. → Document `npx electron-builder install-app-deps` before `npm run electron`, or add `rebuild:electron` script.
- **[I-R5] Low — Electron healthcheck has no per-request timeout; late retries leak** (`electron/main.js:136-148`). Hung response relies on 30 s outer deadline; settled `setTimeout(check,200)` callbacks still fire once. → `req.setTimeout(2000, () => req.destroy())`; early-return when settled.
- **[I-R6] Low — `install.sh` checks `git` but not `curl`/`node`; full clone, no `--ff-only`** (`install.sh:11-14,23`; `setup.sh:61`). `curl` failure surfaces as cryptic piped-`sudo-bash` error; `git pull` fails opaquely on dirty trees. → Pre-check `curl`; `git pull --ff-only`; consider `--depth 1`.

### C.5 Completeness / version / release gaps

- **[I-V1] Info — No version drift today; checklist has unverified link** (`package.json:3`; `README.md:195`; `bin/webtun.js:48-51`; `AGENTS.md:41`). 2.0.5 == changelog top; `--version` reads `package.json` live. Gap: checklist says bump `package.json` + `package-lock.json`, nothing enforces lock sync. → Release via `npm version <x>` (updates both + tags).
- **[I-V2] Low — CI builds binaries but never tests the npm artifact it publishes** (`.github/workflows/build.yml:69-75,113-183`; `AGENTS.md:40-41`). 5× retries + `fail_on_unmatched_files:true` good; no `npm pack --dry-run` / `require('./server.js')` smoke / `npm audit`. Manual `npm publish` without `--provenance`/dry-run gate. → Add `test-npm` job (`npm ci && npm pack --dry-run && npm audit --omit=dev`); publish with `--provenance`.
- **[I-V3] Low — Windows ARM64 downloads AMD64 binary; other arches error opaquely** (`lib/cloudflared.js:78-87`; `setup.sh:170-175`). Emulation tax undocumented; `ia32/riscv64/ppc64/sunos/freebsd` get bare `unsupported` with no remediation. → Prefer real arm64 asset (or comment why); link manual-install docs in error.
- **[I-V4] 🛈 INTENTIONAL (part) — `manifest.json` uses root-absolute icon/shortcut URLs** (`manifest.json:5-6,17-18,21`). App always at domain root; subpath mounts unsupported. Screenshots/maskable split still actionable.
- **[I-V5] Low — `--help` omits real env vars** (`bin/webtun.js:23-28`; `server.js:173-189`). Lists `PORT/HOST/PIN/SHELL/WORKSPACE_ROOT` but not `ALLOW_FULL_FS`, `TRUST_PROXY`, `WEBTUN_SHELL`, `XDG_CONFIG_HOME`. → Mirror README env table (`README:140-151`) in `--help`.

---

## PART D — Cross-cutting inventories

### D.1 Unused / dead code master list

| # | Location | Dead item | Action |
|---|----------|-----------|--------|
| 1 | `server.js:2996,3038` | `ALLOWED_WS_ORIGINS` empty set | Wire env or delete |
| 2 | `server.js:2112,2968,3076,3248` | Unreachable guards | Delete + unit tests |
| 3 | `server.js:945-960` | `killPid` signal param | Drop or implement |
| 4 | `index.html:576,594-595,239-240,907,701` | `.file-actions`, `#preview-*-input`, `--bg1`/`--amber` | Delete/define |
| 5 | `index.html:5789-5826` | 10 CodeMirror mode mappings, no scripts | Load or map to plaintext |
| 6 | `index.html:4587-4595/4848-4858` | Diverged `fileKind`/`getFileIcon` | Single `EXT_KIND` map |
| 7 | `index.html:5763-5780` | `loadDraft()` never called | Wire or remove |
| 8 | `manifest.json:20-22` | `?newTerm=1` shortcut, no handler | Implement or remove |
| 9 | `.npmignore:9,12-14,28` | 6 lines shadowed by `files` | 🛈 INTENTIONAL — no action |
| 10 | `PREVIEW_TAB_PLAN.md` | Entire doc unimplemented | Header or issue-ify |
| 11 | `postinstall.js:12-13` | Stale early-return | Throw/log |
| 12 | `electron/main.js:15-18` | Dead `typeof PIN` check | Delete |
| 13 | `docs.html:810` | Unguarded `theme-btn-m` listener | `?.` guard |

### D.2 Performance optimization backlog (ranked by payoff)

1. **Stream, don't buffer:** tail (`B-H11`), content search (`B-H12`), zip (`B-M8/B-M9`), uploads (`B-H10`). Cap per-request bytes; count live bytes; async work queues.
2. **Cache hot metadata:** `/api/system` sampler (`B-L6`), `stat` owner lookups (`B-M10`), ports/network (`B-M20`), frontend `systemCache` (`F-P3`). 2–10 s TTLs + background sampler.
3. **Throttle the frontend:** preview live-reload polling (`F-P2`), search-per-keystroke (`F-P4`), multi-timer storm (`F-P3`), upload progress layout (`F-P5`). Debounce + rAF + shared cache.
4. **Shrink first paint:** split ~550 KiB blocking bundle (`F-P1`); lazy-load PDF/EPUB/office/git; `defer` `commands.js`; skip doc preload on Save-Data (`F-P8`).
5. **Cap memory hogs:** xterm scrollback clamp messaging (`F-B6`), search over 50k lines (`F-P4`), PDF DOM virtualization (`F-P6`), WebGL dispose (`F-P7`), `express.json` 50 MB global (`B-L4`), `spawnRead` 2 MB buffers (`B-L7`).
6. **Harden background loops:** tunnel restart backoff (`B-M16`), interval `unref` + TTL sweeps (`B-L5`), cloudflared download watchdog/retries (`I-R1`), Electron healthcheck timeouts (`I-R5`).

### D.3 Incomplete-logic register (excluding 🛈 INTENTIONAL items above)

- Auth: TOCTOU bootstrap (`B-C6`), WS/HTTP loopback mismatch (`B-M6`), `.env export` round-trip (`B-M1`), stale `PIN` export (`B-M2`).
- Files/git: `cmdHistMax` not persisted (`B-M13`), hunk TOCTOU (`B-M15`), git-missing status code (`B-L12`).
- Frontend: draft restore (`F-D4`), `newTerm` shortcut (`F-D5`), search counts (`F-B9`), doc-preview close guard (`F-B10`), tiles fit (`F-B11`), path-blur feedback (`F-A6`), docs canonical (`F-A7`), SW precache additions (`F-A3` remainder), manifest screenshots/`id` (`F-A4` remainder).
- Infra: CLI validation/exit-codes/healthcheck (`I-B2–B6`), setup macOS/systemd/port/PIN-perms (`I-B7–B10`, `I-S5`), Electron port race (`I-B11`), stop.sh pidfile/scope (`I-B12`), cloudflared validation/retries/arch (`I-S1–S3`, `I-R1`, `I-V3`), CI npm-artifact gap (`I-V2`), license/packaging (`I-D3`), `PREVIEW_TAB_PLAN.md` drift (`I-D1`).

---

## Verification notes & limits

- Line refs pinned to the working tree on 2026-09-14 (v2.0.5). `server.js` (4,132) and `index.html` (10,798) shift fast — prefer symbol names when filing issues.
- `rg` confirmed zero `TODO/FIXME/HACK` markers and exactly one stray `console.log` cluster in `index.html:6542` (EPUB debug) plus expected CLI/postinstall logging.
- Dynamic behaviors (race windows, iOS viewport sign, xterm `_core` renames, PID reuse, DNS rebinding) flagged from code reading; confirm with targeted repro/tests before patching.
- Suggested next step: file the remaining (non-INTENTIONAL) Top fixes as tracked issues, add a minimal smoke job (`npm pack --dry-run`, `require('./server.js')`, `npm audit --omit=dev`), and re-audit after the WS re-validation rework.

*End of report — ~120 findings, ~25 marked 🛈 INTENTIONAL (no action), ~95 actionable. No source files were modified to produce this report.*

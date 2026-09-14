# WebTun — App Preview Tab Plan

> **STATUS: IMPLEMENTED — design record only, not a task list.** The preview tab shipped in
> v2.0.x as **New Preview** (overflow menu / toolbar of `public/index.html`). Every `file:line`
> reference below was written before the implementation and has since drifted, so treat them as
> historical. Live behaviour is documented in `/docs` → *App preview tabs*; the proxy internals
> live in `server.js` (`handlePreviewProxy`, `validPreviewPort`).

## 0. Goal / Non-goal
- Goal: `App:PORT` tab renders `localhost:PORT` running on the same host, inside WebTun, over the same `:3000` URL + same PIN auth. Same tab bar as terminal tabs.
- Non-goal: general internet browser, native GUI apps. Loopback apps only.

## 1. Architecture
```
[browser iframe] --GET /api/preview/:port/*?token=--> [WebTun :3000]
[WebTun :3000] --http.request 127.0.0.1:port--> [dev server :port]
```
- Browser never dials `localhost:PORT` directly (unreachable remotely). WebTun reverse-proxies it.
- One tunnel / one origin carries terminal + files + N app previews.

## 2. Backend (`server.js`)
- [ ] `ALL /api/preview/:port/*` behind `checkPin` + `rateLimiter` (`server.js:330`, `server.js:186`).
  - Validate `:port` = int 1024–65535, deny self-port. Dial only `127.0.0.1` (literal, no DNS → no SSRF/rebind).
  - Forward method + path + query + body via `http.request` with keep-alive pool. 10s connect timeout; stream, don't buffer (except HTML rewrite below).
  - Headers: drop hop-by-hop (`connection`, `transfer-encoding`, …). Set `Host: 127.0.0.1:port`. Forward `Range` → return `206`. Passthrough `text/event-stream` without timeout.
  - Rewrite `Location: /x` → `/api/preview/:port/x` (and absolute `http://127.0.0.1:port/x` same). Rewrite `Set-Cookie Path=/` → `Path=/api/preview/:port/` + prefix name per port to avoid collision.
  - HTML only: force `Accept-Encoding: identity` upstream (or gunzip/inflate), inject `<base href="/api/preview/:port/">`, recompute `Content-Length`. Skip injection for non-`text/html`.
  - Strip only `X-Frame-Options` + `frame-ancestors` from upstream; keep rest of upstream CSP. Set own `frame-ancestors 'self'`.
  - Override global `X-Frame-Options: DENY` (`server.js:187-192`) → `SAMEORIGIN` for `/api/preview/*` only.
  - Errors as HTML page (not JSON) so iframe shows `target down — is :port listening?`.
- [ ] WS proxy for HMR: catch-all upgrade under `/api/preview/:port/*` → `ws://127.0.0.1:port/*`, passthrough subprotocols, auth via `?token=` on upgrade (headers impossible from iframe WS).
- [ ] `GET /api/ports` (authed): list listening loopback ports for autocomplete. Cross-platform: Linux `ss -tln`, macOS `lsof`/`netstat`, Windows `netstat -ano` / `Get-NetTCPConnection`. No version banners.

## 3. Frontend (`public/index.html`)
- [ ] Extend tab model to `{type:'term'|'preview', port, path}`. Update `newTab()` (`:2700`), `createTerminalWrapper()` (`:2683`), `activateTab()`, `closeTab()` (`:3059`, branch: no tmux kill for preview), `saveTabState()` (`:2129`, persist `type/port`).
- [ ] `newPreviewTab(port, path='/')`: same `.term-wrapper` shell, toolbar `[port input][path][Go][Reload][Open externally]` + `<iframe src="/api/preview/PORT/path?token=…">`.
  - `sandbox="allow-scripts allow-forms allow-popups"` default (opaque origin, same as editor preview). `allow-same-origin` OFF by default → see §5.2.
  - Reload button busts cache; `Open externally` builds direct `http://localhost:PORT` link (local use only).
- [ ] Launchpad + `+` menu: `New terminal / New preview`. Tiles-mode: cap concurrent iframes / lazy-load offscreen.

## 4. Smart localhost detection → "Open preview" suggestion
Goal: user never types a port manually if we can detect it.
- [ ] Terminal-output scan (client): regex on PTY data stream (debounced, not per-char):
  `/(https?:\/\/)?(localhost|127\.0\.0\.1)(:(\d{2,5}))(\/\S*)?/i` + bare `:(\d{4,5})` near keywords (`listening|running|started|ready|port|local:`).
  On match with port in 1024–65535: show toast `App detected on :5173 [Open preview]` + inline link action. Dedupe per tab+port for 60s. "Don't show again" per session.
- [ ] Clickable links: extend existing xterm `web-links` addon handler — localhost links get context action `Open in preview tab` (in addition to `Open in browser`).
- [ ] Active-port suggest: poll `GET /api/ports` on preview-tab focus + after toast; address-bar autocomplete lists `PORT (process guess, e.g. vite/node/python)`; one click opens.
- [ ] Config hint (no exec): if `package.json` has `dev` script or `vite.config.*` / `.env` defines `PORT=`, prefill suggestion `likely :5173?` in preview toolbar placeholder.
- [ ] Rules: suggestions only, never auto-open (avoids iframe storms + audio autoplay). All suggestions authed; unauthed users see nothing.

## 5. Security gaps found in naive plan → fixes
1. **Subresource auth:** first page has `?token=`, inner `app.js` doesn't → 401. Fix: server sets short-lived `HttpOnly; SameSite=Lax; Path=/api/preview/` cookie on first authed `?token=` hit, accepts cookie thereafter. Token stays out of every sub-URL. Clear on logout/PIN rotation.
2. **Origin isolation (XSS):** `allow-same-origin` + same-origin proxy lets dev JS read `wt-session-token` and call `/api/files`. Fix: default opaque origin (no `allow-same-origin`); document breakage (storage/cookies). Optional strict mode later: per-port subdomain isolation.
3. **Absolute-URL breakage:** `/assets/x`, `fetch(/api/…)`, `ws://127.0.0.1:port/hmr` bypass prefix. Fix: `<base>` covers static; document `base:'./'` for Vite; WS catch-all covers HMR paths.
4. **Upstream strip too broad:** strip `X-Frame-Options` + `frame-ancestors` only, preserve rest of upstream CSP.
5. **Uploads/streams:** exempt `multipart/*` + `text/event-stream` + `Range` from small body caps; stream with backpressure.

## 6. Verify
- `python3 -m http.server 8000` → `App:8000` renders, subpaths work, reload works.
- Vite `5173` → loads, HMR reloads on save, no mixed-content errors.
- Dead port → friendly HTML error, toolbar stays usable.
- Remote tunnel URL: preview requires PIN/session, logout revokes cookie, `?token=` not leaked via `Referer` (set `Referrer-Policy: no-referrer`, already global).
- Multi-app: `:3001` + `:8000` cookies/sessions don't clobber each other.

## 7. Build order
1. HTTP proxy + HTML error page + header/CSP handling (§2 para 1).
2. Preview tab shell + toolbar (§3) with manual port entry.
3. Subresource cookie auth (§5.1) — else nothing beyond index loads.
4. Link detection + toast + autocomplete (§4).
5. WS HMR proxy (§2).
6. `/api/ports` + polish (tiles, mobile, external-open).

# WebTun Frontend Security & Quality Findings

## Findings

1) XSS amplification via broad CSP + pervasive `innerHTML` / inline event handlers
- Files: `public/server.js:33`, `public/index.html` (examples: 2332, 1723, 2209, 2037, 1583)
- Risk: CSP currently allows `unsafe-inline` for styles and loads `dompurify` only for the markdown preview. Reusable `innerHTML` assignments (e.g., reconnect banner, breadcrumb, file-item icon SVG, folder empty state) mean any future DOM sink, third-party CDN compromise, or helper escape miss will bypass CSP protections and allow arbitrary script execution.
- Fix: Remove `unsafe-inline` from `style-src` (idiomatic for this app since most styling is CSS-driven). Replace `innerHTML` with `textContent` or safe DOM APIs, and migrate inline `onclick` handlers to `addEventListener`. Any remaining inline element must use DOMPurify + nonces/hashes.

2) Unsanitized HTML preview renders file content via `iframe.srcdoc`
- File: `public/index.html:3021`
- Risk: `toggleHtmlPreview()` sets `iframe.srcdoc = editor.getValue()` directly. Sandboxing is `allow-same-origin` only (no `allow-scripts`), so immediate script execution is blocked, but CSS-based data exfiltration, phishing UI, and logic bugs remain possible. The same file already sanitizes Markdown with DOMPurify; HTML preview is the inconsistent path.
- Fix: Apply `DOMPurify.sanitize(editor.getValue(), { USE_PROFILES: { html: true } })` before assignment. Consider removing `allow-same-origin` from the sandbox unless same-origin features are required.

3) File listing silently fails on network / auth errors, leaving stale UI
- File: `public/index.html:2076-2209`, especially `2097-2099` (loading only on first render) and `2102-2113` (fetch failure logs and returns with no UI feedback).
- Risk: If the user navigates to a path they cannot read (or network drops mid-navigate), the sidebar keeps showing the previous directory while operations run against the old path. This can cause accidental writes/deletes in the wrong location.
- Fix: Always clear `file-list` when a refresh begins, render a visible error state with retry action, and only fall back to `homeDir` after logging a message / toast.

4) WebSocket auth uses the PIN/token in the connection URL query string
- File: `public/index.html:1668`
- Risk: `wsUrl` embeds `token=${encodeURIComponent(authToken)}`. Query strings are written to DevTools, browser history, proxy logs, and may be sent as the `Referer` header when the page loads subresources. Anyone with read access to those surfaces extracts the session token.
- Fix: Introduce a short-lived ephemeral handshake: the client makes an authenticated POST to create a WS session nonce, the server returns it, and the WS connects without the token in the URL (or passes it only once inside the first binary frame). Reject WS opens missing the pre-issued nonce.

5) Client trusts unvalidated `localStorage` for tab/session state
- Files: `public/index.html:1289-1294`, `1624`, `1667-1668`
- Risk: `loadTabState()` parses arbitrary JSON and hands `sessionId` directly into `newTab()`, which is URL-encoded into the WebSocket URL. While the server sanitizes the value, the frontend still propagates tampered state into a sensitive control plane. Additionally, localStorage is shared across origins on the same host in some configurations, so malicious sub-pages can inject junk that piles up orphan tmux sessions.
- Fix: Add a localStorage integrity check (e.g., HMAC or versioned schema), populate a default sessionId only when missing, and discard entries that exceed reasonable bounds (length, charset) on the client before use.

6) Upload flow has no client-side guardrails, enabling accidental DoS
- File: `public/index.html:2702-2775`
- Risk: `uploadFileList()` iterates over all supplied items and sends them sequentially with a multi-part form, with no per-file client size cap, no total count cap, and no early abort. A user can drop a multi-gigabyte file or hundreds of files, exhausting memory and saturating the upload stream before server-side limits reject it. There is no user-visible progress for the overall queue beyond a simple percentage bar.
- Fix: Enforce a client-side max size (e.g., 200 MB) and count limit, preview total queue size and estimated time, show per-file progress, and let the user cancel the queue.

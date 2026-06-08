# Enhanced Tunnel Features — Implementation Plan

## Overview
Auto-detect port, quick "Tunnel this app" button, and permanent tunnels via serveo.net with security warnings.

---

## A. Backend — `server.js`

### A1. Add server port to GET /api/tunnel
Send `{ serverPort: PORT, tunnels: [...] }` so frontend knows the app port without extra API calls.

### A2. CSP exception for serveo.net
Add `https://*.serveo.net wss://*.serveo.net` to `connect-src` at line 33. (Electron inherits this — no separate CSP.)

### A3. SSH availability check
Before spawning SSH, run `command -v ssh` (Unix) or `where ssh 2>nul || where ssh.exe 2>nul` (Windows). Return error: `"SSH client not found. Install OpenSSH Client (Windows: 'Add optional feature' or use Git Bash)."`

### A4. Serveo tunnel endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tunnel/serveo` | POST | Start serveo tunnel |
| `/api/tunnel/serveo` | DELETE | Stop by id |

**POST `{ subdomain, localUrl }`:**
- Validate `subdomain`: `/^[a-z0-9][a-z0-9-]{2,28}[a-z0-9]$/i` (4-30 chars, alphanumeric + hyphens, no leading/trailing hyphen)
- Validate `localUrl`: parse with `new URL()`, reject non-http/https
- Check SSH availability (A3)
- Spawn: `ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R {subdomain}:80:{localUrl} serveo.net`
- Pipe stderr (serveo prints URL there): parse for `https://{subdomain}.serveo.net`
- 10s timeout — kill process and return `"Timed out waiting for serveo tunnel"`
- Store in `tunnels` Map: `{ type:"serveo", subdomain, localUrl, tunnelUrl, sshProc, pid, createdAt }`
- Persist to `.tunnels.json`, return `{ success, id, url }`

**DELETE `{ id }`:**
- Find entry in Map by id
- Kill process: `SIGTERM` → if still alive after 2s → `SIGKILL`
- Remove from Map, re-persist, return `{ success }`

### A5. Type-aware `.tunnels.json` persistence
Extend saved entries with `type` field (`"cloudflared"` or `"serveo"`):

```json
// cloudflared
{ "id":"abc123", "type":"cloudflared", "localUrl":"http://localhost:3000",
  "tunnelUrl":"https://abc123.trycloudflare.com", "createdAt":1717000000000, "pid":12345 }

// serveo
{ "id":"myapp", "type":"serveo", "subdomain":"myapp", "localUrl":"http://localhost:3000",
  "tunnelUrl":"https://myapp.serveo.net", "createdAt":1717000000000, "pid":12346 }
```

### A6. Load with backward compatibility
```js
for (const t of arr) {
  const type = t.type || 'cloudflared';  // ← old entries default
  if (type === 'cloudflared' && isCloudflaredProcess(t.pid)) {
    tunnels.set(t.id, { ...t, type, proc: null });
  } else if (type === 'serveo' && isValidPID(t.pid)) {
    try { process.kill(t.pid, 0); tunnels.set(t.id, { ...t, sshProc: null }); } catch {}
  }
}
```

### A7. Health check for serveo tunnels (in GET /api/tunnel)
For serveo entries, attempt HEAD request to `t.tunnelUrl` (not just localUrl) to verify the tunnel is actually forwarding. Mark `targetAlive` accordingly.

### A8. Rate limiting
Apply existing `perIp` rate limiter to serveo POST (5 req/10s) and DELETE (10 req/10s), matching existing tunnel auth rate limits.

### A9. Cleanup hook
`cleanup()` iterates all tunnels. For serveo entries, kill `sshProc` or `pid` with SIGTERM → SIGKILL fallback.

---

## B. Frontend — Tunnel Settings UI (`public/index.html`)

### B1. Auto-detect port
- On `openSettings()` and page init via `restoreTunnels()`, get `serverPort` from GET /api/tunnel
- Pre-fill `#tunnel-url` with `http://localhost:{serverPort}`
- Show small badge inline: `🔌 :{serverPort}`

### B2. "Tunnel this app" quick button
Primary-styled button beneath URL input: `🚇 Tunnel this App`. Calls `createTunnel()` with `http://localhost:{serverPort}`. Circumvents typing entirely.

### B3. Permanent Tunnel section
Insert below existing tunnel-list div (inside the Tunnel settings-section):

```
┌─ Permanent Tunnel ─────────────────────────────┐
│ ┌─ warning-box ──────────────────────────────┐ │
│ │ ⚠️ SECURITY WARNING                        │ │
│ │                                            │ │
│ │ Permanent tunnels expose your local server │ │
│ │ to the internet until stopped.             │ │
│ │ • Set a strong PIN in .env — anyone with   │ │
│ │   your permanent URL can reach this server │ │
│ │ • All traffic passes through serveo.net    │ │
│ │ • Do not tunnel sensitive data             │ │
│ • Stop permanent tunnels when not in use     │ │
│ └────────────────────────────────────────────┘ │
│                                                │
│ Subdomain: [ my-app       ] .serveo.net        │
│ Local URL:  [http://localhost:{PORT}]           │
│                                                │
│ [🚇 Start Permanent Tunnel]                    │
│                                                │
│ Active Permanent Tunnels:                      │
│ (list — same copy/open/stop pattern as random) │
└────────────────────────────────────────────────┘
```

**No provider dropdown** — serveo.net is the first and only implementation. Add dropdown later when a second provider is added. This avoids dead UI.

**No API Key field for serveo** — serveo doesn't need one for basic subdomains. Show info text instead: `"Custom domain? SSH key auth: serveo.net/docs"`.

### B4. Security warning box — HTML
```html
<div class="warning-box">
  <strong>⚠️ Security Warning</strong>
  <ul>
    <li>Set a <strong>strong PIN</strong> in <code>.env</code> — anyone with your permanent URL can reach this server</li>
    <li>All traffic passes through <strong>serveo.net</strong>, a third-party service</li>
    <li>Do not tunnel sensitive data (banking, credentials, personal files)</li>
    <li>Stop permanent tunnels when not in use</li>
  </ul>
</div>
```

### B5. Permanent tunnel list rendering
Each row: `[serveo badge] https://myapp.serveo.net [Live/Dead] [📋] [🔗] [⏹]`

Same icon-button pattern as cloudflared tunnels (copy, open, stop). Provider badge colors: cloudflared = accent, serveo = green.

### B6. Existing panel width (`--settings-w: 340px`)
Already sufficient. No change needed.

### B7. Persist form preferences to localStorage
Keys: `tunnel_subdomain`, `tunnel_localUrl`. Restore on settings panel open.

---

## C. Frontend — JavaScript Changes

### C1. New state
```js
let serverPort = 3000;
let permanentTunnels = [];
```

### C2. Modify `restoreTunnels()`
```js
async function restoreTunnels() {
  const r = await api('/api/tunnel');
  serverPort = r.serverPort || 3000;
  const all = r.tunnels || [];
  tunnelList = all.filter(t => t.type !== 'serveo');
  permanentTunnels = all.filter(t => t.type === 'serveo');
  renderTunnels();
  renderPermanentTunnels();
}
```

### C3. New functions

| Function | Lines | Purpose |
|----------|-------|---------|
| `updateTunnelPort()` | ~8 | Sets `#tunnel-url` value + port badge from `serverPort` |
| `tunnelThisApp()` | ~6 | Calls `createTunnel()` with `http://localhost:${serverPort}` |
| `startPermanentTunnel()` | ~30 | Reads form → validates → POST → push → render → toast |
| `stopPermanentTunnel(id)` | ~15 | DELETE → filter → render → toast |
| `renderPermanentTunnels()` | ~40 | Same pattern as `renderTunnels()`, renders serveo list |
| `loadTunnelPrefs()` / `saveTunnelPrefs()` | ~12 | localStorage get/set for subdomain + localUrl |

### C4. Modify `renderTunnels()`
After rendering cloudflared list, if `permanentTunnels.length > 0`, append a `<div class="section-divider">Permanent</div>` + permanent tunnel list.

### C5. Permanent tunnel create flow
```
User types subdomain → clicks "Start Permanent Tunnel"
  → Client validates: subdomain required, 4-30 chars, alphanumeric+dashes
  → POST /api/tunnel/serveo { subdomain, localUrl }
  → Success: permanentTunnels.push(), renderPermanentTunnels(), toast "Tunnel ready"
  → Error: toast error (e.g. "Subdomain taken" / "SSH not available" / "Timed out")
```

---

## D. CSS Additions

```css
/* Warning box */
.warning-box {
  background: color-mix(in srgb, var(--yellow) 15%, transparent);
  border: 1px solid var(--yellow);
  border-radius: var(--radius);
  padding: 10px 12px; font-size: 11px; color: var(--fg);
  margin-bottom: 12px; line-height: 1.5;
}
.warning-box strong { color: var(--yellow); }
.warning-box ul { margin: 4px 0 0 16px; padding: 0; }
.warning-box code { font-size: 10px; background: var(--bg4); padding: 1px 4px; border-radius: 3px; }

/* Port badge */
.tunnel-port-badge {
  font-size: 10px; color: var(--fg2); background: var(--bg4);
  padding: 2px 8px; border-radius: 10px; white-space: nowrap;
}

/* Provider badge */
.provider-badge {
  font-size: 9px; padding: 1px 5px; border-radius: 4px;
  flex-shrink: 0; text-transform: uppercase; font-weight: 600;
}
.provider-badge.cloudflared { background: var(--accent); color: var(--bg); }
.provider-badge.serveo { background: var(--green); color: var(--bg); }

/* Permanent tunnel form */
.perm-tunnel-form { display: flex; flex-direction: column; gap: 8px; }
.perm-tunnel-row { display: flex; align-items: center; gap: 8px; }
.perm-tunnel-row label { font-size: 12px; flex: 0 0 auto; min-width: 70px; }
.perm-tunnel-row input { flex: 1; }
.subdomain-hint { font-size: 11px; color: var(--fg2); }

/* Section divider between random/permanent tunnel lists */
.section-divider {
  font-size: 10px; color: var(--fg2); text-transform: uppercase;
  letter-spacing: 0.5px; padding: 10px 0 4px; border-bottom: 1px solid var(--border);
  margin-top: 6px;
}
```

---

## E. Files Modified

| File | Δ Lines | Changes |
|------|---------|---------|
| `server.js` | ~70 | serveo endpoints, type-aware save/load, SSH check, CSP + 1 line, rate limit + 2 lines, health check, cleanup |
| `public/index.html` (HTML) | ~40 | Permanent tunnel section + warning box + port badge |
| `public/index.html` (CSS) | ~40 | warning-box, badges, perm form, divider |
| `public/index.html` (JS) | ~100 | New functions, modified restoreTunnels/renderTunnels/openSettings |

---

## F. Implementation Order

1. **Backend** — CSP update (`line 33`), add `serverPort` to GET response
2. **Backend** — SSH check + serveo POST/DELETE + type-aware save/load + rate limiting
3. **Backend** — Health check for serveo in GET /api/tunnel + cleanup hook
4. **Frontend CSS** — warning-box, badges, perm form, divider
5. **Frontend HTML** — Permanent tunnel section + warning box + port badge markup
6. **Frontend JS** — `serverPort` state, `updateTunnelPort()`, modify `restoreTunnels()`, modify `openSettings()`
7. **Frontend JS** — `tunnelThisApp()` quick button
8. **Frontend JS** — Permanent tunnel CRUD (`startPermanentTunnel`, `stopPermanentTunnel`, `renderPermanentTunnels`)
9. **Frontend JS** — localStorage prefs, modify `renderTunnels()` for divider
10. **Verify** — `npm start` → test cloudflared still works → test serveo end-to-end

---

## G. Verification Steps

1. `npm start` — app starts, no errors
2. Open settings → port badge shows correct port (e.g. `🔌 :3000`)
3. Click "Tunnel this App" → cloudflared tunnel creates for localhost:3000
4. Enter custom URL, Create → random cloudflared tunnel works
5. Stop tunnel → disappears from list
6. Enter subdomain "webtun-test" → click "Start Permanent Tunnel" → serveo tunnel appears as Live
7. Copy URL → opens in browser → shows WebTun interface
8. Stop permanent tunnel → disappears
9. Refresh page → only active tunnels restore (both types)
10. Stop server → restart → orphan tunnels cleaned up, no stale entries

---

## H. API Key / Token Guide (inline help)

When the user hovers/clicks the info icon near the permanent tunnel section, show:

### serveo.net
No API key needed for basic subdomains (`yourapp.serveo.net`). Just pick a name.

**Custom domain?** Add SSH key auth:
1. `ssh-keygen -t rsa -b 4096`
2. `ssh-keygen -l -f ~/.ssh/id_rsa.pub` → copy fingerprint
3. Add CNAME `yourdomain.com → serveo.net`
4. Add TXT `_serveo-authkey.yourdomain.com = <fingerprint>`
5. Then use `yourdomain.com` as subdomain

Docs: https://serveo.net/docs/

### ngrok (future)
Requires authtoken from https://dashboard.ngrok.com/get-started/your-authtoken
API keys: https://dashboard.ngrok.com/api

### Cloudflare DNS Tunnel (future)
Requires API token with Tunnel:Edit + DNS:Edit permissions.
Create at: https://dash.cloudflare.com/profile/api-tokens/
Find Account/Zone IDs: https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/
Tunnel setup: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/

---

## I. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| serveo.net down | Return "Could not reach serveo.net. Try again later." |
| SSH zombie processes | Track PIDs, kill on cleanup. Periodically re-check `process.kill(pid, 0)`. |
| Subdomain already taken | serveo.net returns error. Surface it: "Subdomain already in use." |
| Windows no SSH | Detect early, return clear error with install instructions |
| Old `.tunnels.json` without `type` | Default to `"cloudflared"` on load |
| Settings panel overflow | Width is already 340px — sufficient. Monitor on mobile. |
| Permanent tunnel URL changes | If serveo changes URL format, update the regex in POST handler |

---

## J. AGENTS.md Update

Add entry after existing tunnel section:

```markdown
- **Permanent tunnels**: serveo.net via SSH. Subdomain `foo` → `https://foo.serveo.net`.
  - POST `/api/tunnel/serveo` (start), DELETE `/api/tunnel/serveo` (stop)
  - SSH must be installed. Windows needs OpenSSH Client.
```

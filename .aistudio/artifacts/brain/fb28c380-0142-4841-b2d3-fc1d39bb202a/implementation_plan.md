# Trusted Safe Browsers & Persistent Device Authentication

Save browser/device profile information and allow marking a browser as "Safe / Remembered" so WebTun authenticates automatically without prompting for the PIN on subsequent visits.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Key Architectural Defaults**:
> - **Trust Duration**: Trusted safe browser tokens will remain valid for 90 days of inactivity (auto-refreshed on each visit), unless explicitly revoked by the user or invalidated by a PIN change.
> - **Server Persistence**: In-memory sessions currently vanish when the server process restarts. Safe browsers will be persisted atomically in `~/.config/webtun/trusted-devices.json` (mode 0600) so restarts do not force re-authentication on trusted devices.
> - **PIN Screen Experience**: A clean "Remember this browser" checkbox will be added directly on the PIN unlock screen (defaulting to checked), giving users 1-click persistent trust upon valid unlock.
> - **Revocation & Control**: The Settings → Security panel will gain a "Trusted Browsers & Devices" manager where users can see all remembered browsers (name, OS, IP, last used), rename/inspect them, and revoke any device individually or all at once.

---

## 1. Overview & Core Concept

WebTun currently manages login tokens in an in-memory `Map()`, which means:
1. Whenever the Node server restarts or nodemon cycles, every browser session is wiped and users must re-type their PIN.
2. Even while the server is up, there is no explicit way to mark a trusted personal laptop or mobile browser as "Safe" to skip the PIN prompt on return.

### What This Feature Delivers
- **Persistent Safe Device Registry**: When unlocking with a valid PIN, users can opt to mark the current browser as safe. WebTun generates a cryptographically secure 64-hex device token paired with a persistent client-side device ID.
- **Auto-Unlock without PIN Prompt**: On opening WebTun or launching the PWA, WebTun checks for a valid trusted device token. If recognized by the server's persistent store, the app automatically authenticates and enters the workspace immediately without displaying the PIN screen.
- **Rich Browser & Device Metadata**: Stores browser name (Chrome, Safari, Firefox, Edge), OS (macOS, Windows, Linux, iOS, Android), client IP, creation date, and last active timestamp.
- **Full Security Control Deck**: From **Settings → Security**, users can inspect all remembered safe browsers, identify "This device", revoke old or stolen devices with one click, or revoke all other devices.

---

## 2. User Experience & Visual Design

### 2.1 PIN Screen Enhancements (`#pin-screen`)
- **"Remember this browser as safe" Checkbox**:
  - Positioned cleanly between the PIN input field and the "Unlock" button.
  - Styled with WebTun's theme tokens (`--font-ui`, `--line2`, `--accent`, `--ink`).
  - Includes a subtle helper label: *"Stay signed in on this device"*.
  - Accessible via keyboard (<kbd>Tab</kbd> + <kbd>Space</kbd>).
- **Auto-Unlock Splash Feedback**:
  - When a returning user opens WebTun with a saved safe token, the app briefly presents a subtle connecting status and unlocks directly to the Launchpad/workspace without shaking or prompting for PIN.

```
┌──────────────────────────────────────────────────┐
│                  SECURE ACCESS                   │
│                    [WebTun]                      │
│              Enter PIN to continue               │
│                                                  │
│                 [ •••••••• ]                     │
│                                                  │
│     [✓] Remember this browser as safe            │
│         Stay signed in on this device            │
│                                                  │
│                 [  Unlock  ]                     │
│                                                  │
│            Protected by PIN • WebTun             │
└──────────────────────────────────────────────────┘
```

### 2.2 Settings → Security Deck Additions
- **Trusted Safe Browsers Section**:
  - Positioned in Settings under **Security → Device Sessions**.
  - Section header: **Trusted Safe Browsers** with badge counter (e.g. `(2)`).
  - Cards listing each safe browser with:
    - Browser & OS icons/label (e.g., `Chrome 128 · macOS`).
    - Status badges: `This browser` (green pill), `Last active 2m ago`.
    - IP address and initial enrollment date (`Trusted on Oct 31, 2026`).
    - Action button: `Revoke` (instant removal) and `Forget all others`.
- **Sign Out Flow**:
  - The existing **Sign Out** button will offer: *"Forget this browser as safe?"* so logging out can cleanly remove the saved safe credential if on a shared machine.

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Dedicated Safe Token vs. Ephemeral Session Token
- **Chosen Approach**: Decouple transient interactive sessions from long-term trusted safe device credentials. A trusted device holds a persistent `safeToken` and `deviceId` in `safeStorage`. When WebTun boots, it exchanges this safe token with `/api/auth/resume` to issue an active session.
- **Why**: Clean separation of concerns. If transient sessions expire or are swept, the browser remains a trusted device. Revoking a safe device immediately revokes both its persistent trust and its active sessions.

### Decision 2: Atomic Server-Side Persistence in `DATA_DIR`
- **Chosen Approach**: Persist safe devices to `path.join(DATA_DIR, '.trusted-devices.json')` with `0600` permissions via atomic temporary write and rename (`fs.renameSync`).
- **Why**: Matches WebTun's established persistence patterns (`.cmdhist.json`, `.tunnels.json`, `license.json`). Immune to data loss from server restarts, system reboots, and nodemon dev cycles.

### Decision 3: PIN Change Invalidation Policy
- **Chosen Approach**: When the server PIN is rotated or disabled/re-enabled, all trusted safe device tokens are automatically invalidated.
- **Why**: Security best practice: rotating the master PIN must guarantee that previously remembered devices cannot bypass the new credential.

---

## 4. Technical Architecture & Data Strategy

### 4.1 System Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                          CLIENT (BROWSER)                              │
│                                                                        │
│   safeStorage:                                                         │
│     - wt-device-id: "d8f3a9..." (stable 64-hex client fingerprint)     │
│     - wt-safe-token: "7c1e4b..." (cryptographic bearer token)          │
│     - wt-session-token: "..." (active session token)                   │
│                                                                        │
│   PIN Screen: [✓] Remember this browser as safe                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    │ POST /api/auth { pin, remember, deviceId }
                                    │ POST /api/auth/resume { safeToken, deviceId }
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                           SERVER (Node.js)                             │
│                                                                        │
│   lib/server/auth.js:                                                  │
│     ├── checkPin / getSession (middleware)                             │
│     ├── POST /api/auth (verifies PIN, registers safe device)           │
│     ├── POST /api/auth/resume (auto-authenticates safe devices)        │
│     ├── GET  /api/auth/safe-devices (lists trusted browsers)           │
│     └── DELETE /api/auth/safe-devices/:id (revokes safe status)        │
│                                                                        │
│   Persistent Storage:                                                  │
│     DATA_DIR/.trusted-devices.json (0600 atomic file)                  │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Safe Device Data Schema (`.trusted-devices.json`)

```json
{
  "devices": {
    "d8f3a9...": {
      "id": "d8f3a9...",
      "tokenHash": "sha256:...",
      "label": "Chrome · macOS",
      "userAgent": "Mozilla/5.0 ...",
      "ip": "192.168.1.42",
      "createdAt": 1730364920000,
      "lastSeen": 1730365820000,
      "expiresAt": 1738140920000
    }
  }
}
```

### 4.3 Endpoint Specifications

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/auth` | `POST` | Rate-limited | Accepts `{ pin, device, remember, deviceId }`. If `remember: true`, mints and persists a safe token. |
| `/api/auth/resume` | `POST` | Rate-limited | Accepts `{ safeToken, deviceId, device }`. Validates token against `.trusted-devices.json`, issues active session, updates `lastSeen`. |
| `/api/auth/safe-devices` | `GET` | `checkPin` | Lists all trusted browsers with metadata (`isCurrent` flag). |
| `/api/auth/safe-devices/:id` | `DELETE` | `checkPin` | Revokes safe status for a specific device and terminates its active sessions. |
| `/api/auth/safe-devices` | `DELETE` | `checkPin` | Revokes all safe devices except the current calling device. |

---

## 5. Verification & Testing Strategy

1. **Unit & Contract Tests** (`tests/safe-devices.test.js`):
   - Verify safe device issuance, token hashing, and expiration.
   - Verify server persistence survives service reconstruction (simulating server restart).
   - Verify resumption succeeds for valid safe devices and fails for revoked/expired devices.
   - Verify PIN rotation purges all trusted safe devices.
2. **CLI & Lint Verification**:
   - `npm run version:check`: Verify version sync.
   - `npm run check`: Verify all files parse, frontend actions agree, and precache is valid.
   - `npm test`: Verify the complete regression suite passes cleanly.

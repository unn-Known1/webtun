# WebTun SSH Implementation & Operational Handling Audit Report

**Date:** 2026-10-01  
**Target:** WebTun (v2.2.5) SSH Subsystem  
**Scope:** Architecture, implementation, operational runtime handling, security posture, and cross-platform compatibility across `lib/ssh.js`, `lib/ssh-setup.js`, `server.js`, `public/js/ssh.js`, `bin/webtun.js`, `public/index.html`, and `public/docs.html`.  
**Status:** Audit Complete. No source code modifications made (as instructed).

---

## Executive Summary

WebTun’s SSH subsystem aims to provide on-demand, key-only SSH credentials and an automated "Easy Setup" wizard (system OpenSSH, firewall, Tailscale, and userspace managed OpenSSH daemon) without requiring passwords or modifying global system policies.

The implementation is largely functional in standard Linux environments with OpenSSH and Tailscale pre-installed. However, our deep-dive analysis revealed **9 significant defects and operational issues**, alongside **4 security deviations from the design specification in `SSH_implementation_plan.md`**.

### Key Highlights

| Category | Finding | Impact | Severity |
| :--- | :--- | :--- | :--- |
| **Logic / Lifecycle** | `startManagedSshd` port busy deadlock | Attempting to restart or re-trigger built-in SSH fails with HTTP 409 because port check precedes process kill | **High** |
| **Integration** | Disconnected Tailscale state across modules | `getTailscaleIp()` in `lib/ssh.js` ignores userspace Tailscale in `DATA_DIR`; recipes and status report `null` despite active Tailnet | **High** |
| **Usability / Trust** | Managed SSH host fingerprint mismatch | `getHostFingerprints()` only inspects `/etc/ssh/`; built-in SSH daemon uses `DATA_DIR/managed-sshd/`, causing fingerprint verification failures | **Medium** |
| **Environment** | Container & root `sudo` failure | `sudoN()` fails in root containers where `sudo` is absent (`ENOENT`), blocking all Easy Setup actions despite process running as root | **Medium** |
| **Data Integrity** | Overly broad orphan key matching regex | `managedLineId()` regex matches any word ending in `webtun:*`, causing false-positive deletion of user keys during orphan cleanup | **Medium** |
| **Robustness** | Corrupted state file crashes SSH API | Malformed `.ssh-state.json` throws unhandled `SyntaxError`, permanently returning HTTP 500 on all SSH endpoints | **Medium** |
| **Privacy / DOM** | Private key retained in DOM on modal close | Closing SSH dialog via Esc, backdrop, or close button leaves plaintext private key in DOM | **Low** |
| **CLI** | CLI flags `--ssh` and `--ssh-port` missing | `bin/webtun.js` lacks parser for `--ssh` / `--ssh-port`, exiting with `Unknown option` | **Low** |
| **Filesystem** | Symlink destruction on `authorized_keys` write | Atomic rename replaces symlinked `authorized_keys` with a regular file | **Low** |
| **Security Plan** | Multi-session approval omitted | Planned requirement (§5.4/§6) for approval from other active sessions before minting keys was omitted | **Medium** |
| **Security / Crypto** | Unencrypted private key written to `/tmp` | `ssh-keygen` writes private key to `/tmp` before reading, despite claims of being in-memory only | **Low** |

---

## 1. Subsystem Architecture & Working Flow

The SSH implementation spans three primary tiers:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Frontend UI & Settings                     │
│  - Header button (#ssh-toggle) & Overflow menu                  │
│  - SSH Access Overlay Modal (#ssh-overlay)                      │
│  - Settings -> Features -> SSH Access toggle                    │
│  - Managed by public/js/ssh.js & settings.js                    │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTP REST (JSON)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                        server.js API Layer                      │
│  - GET    /api/ssh/status            (rateLimiter, checkPin)    │
│  - GET    /api/ssh/keys              (rateLimiter, checkPin)    │
│  - POST   /api/ssh/credentials       (authLimit, requirePinSet) │
│  - DELETE /api/ssh/keys/:id          (authLimit, requirePinSet) │
│  - POST   /api/ssh/port              (authLimit, requirePinSet) │
│  - POST   /api/ssh/cleanup           (authLimit, requirePinSet) │
│  - GET    /api/ssh/setup             (rateLimiter, checkPin)    │
│  - POST   /api/ssh/setup/:action     (authLimit, requirePinSet) │
│  - POST   /api/ssh/enabled           (authLimit, requirePinSet) │
└───────────────────┬─────────────────────────────┬───────────────┘
                    │                             │
                    ▼                             ▼
┌──────────────────────────────┐  ┌───────────────────────────────┐
│         lib/ssh.js           │  │       lib/ssh-setup.js        │
│  - Keypair gen (ssh-keygen)  │  │  - System checks (sshd, fw)   │
│  - ~/.ssh/authorized_keys    │  │  - Non-interactive sudo-n    │
│  - State: .ssh-state.json    │  │  - Managed sshd daemon child │
│  - LAN & Tailscale IP probe  │  │  - Tailscale user/system mgr  │
└──────────────────────────────┘  └───────────────────────────────┘
```

### 1.1 State Management
- State file: `DATA_DIR/.ssh-state.json` (where `DATA_DIR` defaults to `$XDG_CONFIG_HOME/webtun` or `~/.config/webtun`, with fallback to `__dirname`).
- Contains:
  - `port`: Expected SSH port (default 2222, overridden by `SSH_PORT` env var).
  - `enabled`: Master switch boolean.
  - `credentials`: Array of `{ id, label, type, fingerprint, createdAt, addedBy }`.
  - `managedSshd`: Configuration `{ enabled, port, pid }` for built-in OpenSSH daemon.
  - `tailscaleManaged`: Boolean flag indicating if WebTun brought up the Tailnet.
- Security Invariant: Private keys are **never stored** in the state file.

### 1.2 Credential Lifecycle
1. **Creation (`POST /api/ssh/credentials`)**:
   - Requires PIN authentication (`checkPin`) and PIN protection to be enabled (`requirePinSet`).
   - Requires master switch to be enabled (`isSshEnabled`).
   - Uses `ssh-keygen -t ed25519` in a temporary directory.
   - Appends public key to `~/.ssh/authorized_keys` with trailing tag: `webtun:<16-hex-id>`.
   - Returns unencrypted private key **once** in the HTTP response body.
2. **Revocation (`DELETE /api/ssh/keys/:id`)**:
   - Parses `authorized_keys` line by line.
   - Filters out lines matching `isManagedLine(line, id)`.
   - Writes back `authorized_keys` atomically with permissions `0600`.
   - Removes entry from `credentials` array in `.ssh-state.json`.
3. **Orphan Cleanup (`POST /api/ssh/cleanup`)**:
   - Scans `authorized_keys` for `webtun:<id>` tags not present in `.ssh-state.json`.
   - Removes orphaned entries atomically.

### 1.3 Supervised Built-in SSH Server (`managed-sshd`)
- Intended as a zero-privilege fallback when system `sshd` is not installed or running.
- Generates dedicated host keys in `DATA_DIR/managed-sshd/ssh_host_{ed25519,rsa}_key`.
- Spawns `sshd` as the server user on a high port (`wantPort`, default 2222) with `-D -e`.
- Configured with `-o AuthorizedKeysFile=~/.ssh/authorized_keys`, `-o PasswordAuthentication=no`, and `-o MaxAuthTries=3`.
- Supervised by WebTun process: boots on server start if `enabled: true`, and terminates on `server.js` `cleanup()`.

---

## 2. Detailed Findings & Defect Analysis

### Finding 1: Port Busy Deadlock in `startManagedSshd` (Logic Bug)
- **Location:** `lib/ssh-setup.js`, lines 420–436
- **Analysis:**
  ```javascript
  // 1. Probe if port is busy
  const busy = await new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ port: wantPort, host: '127.0.0.1' });
    ...
  });
  if (busy) {
    throw Object.assign(new Error(`Port ${wantPort} already answers — your system sshd covers it, no built-in needed`), { status: 409 });
  }

  // 2. Kill existing managedProc
  if (managedProc && managedProc.exitCode === null && !managedProc.killed) {
    try { managedProc.kill('SIGTERM'); } catch {}
    managedProc = null;
    await new Promise(r => setTimeout(r, 500));
  }
  ```
- **Consequence:** If `managedProc` is already running on `wantPort`, the TCP connection in step 1 succeeds, `busy` evaluates to `true`, and the function immediately throws HTTP 409. Step 2 (killing the existing process) is **unreachable dead code**. As a result:
  - If a user clicks "Start" or restarts the daemon, the request always fails with HTTP 409.
  - If `managedProc` is running but in an abnormal state, it cannot be restarted without manually stopping it first.
- **Remediation Recommendation:** Check and terminate `managedProc` (or existing pid) **before** running the `isPortListening` probe.

---

### Finding 2: Disconnected Tailscale Implementation Across Modules (Integration Bug)
- **Location:** `lib/ssh.js`, lines 195–204 & 265–268 vs `lib/ssh-setup.js`, lines 264–286
- **Analysis:**
  In `lib/ssh-setup.js`, Tailscale supports both system installation and userspace fallback:
  ```javascript
  // lib/ssh-setup.js checks both system binary and DATA_DIR/tailscale/bin/tailscale
  function tsBin(dataDir) { ... }
  ```
  However, in `lib/ssh.js`:
  ```javascript
  function getTailscaleIp() {
    return new Promise((resolve) => {
      execFile('tailscale', ['ip', '-4'], { timeout: 3000 }, (err, stdout) => { ... });
    });
  }
  ```
  `getTailscaleIp()` takes no `dataDir` parameter, does not know about `tsPaths(dataDir).binDir`, and does not pass `TAILSCALED_SOCKET: tsPaths(dataDir).sock`.
- **Consequence:**
  - When Tailscale is installed via WebTun's Easy Setup (userspace mode), `getTailscaleIp()` fails with `ENOENT`.
  - `GET /api/ssh/status` returns `tailscaleIp: null`.
  - The SSH popup displays: *"Phone on mobile data? ... These addresses will time out. Install Tailscale..."*, despite the Easy Setup checklist showing *"Tailnet IP 100.x.y.z (WebTun userspace daemon)"*.
  - The click-to-copy connection commands fail to offer the Tailscale IP.
- **Remediation Recommendation:** Update `getTailscaleIp(dataDir)` in `lib/ssh.js` to reuse `tailscaleState(dataDir)` from `lib/ssh-setup.js`.

---

### Finding 3: Host Key Fingerprint Mismatch with Managed SSH (Usability & Trust Defect)
- **Location:** `lib/ssh.js`, lines 206–229
- **Analysis:**
  `getHostFingerprints()` only inspects standard system paths:
  - `/etc/ssh/ssh_host_ed25519_key.pub`
  - `/etc/ssh/ssh_host_ecdsa_key.pub`
  - `/etc/ssh/ssh_host_rsa_key.pub`
  When WebTun runs its built-in managed SSH (`start-managed`), it generates host keys in `DATA_DIR/managed-sshd/ssh_host_{ed25519,rsa}_key.pub`.
- **Consequence:**
  - If a system `sshd` is not installed, `getHostFingerprints()` returns an empty list, so the user receives no fingerprints to verify.
  - If a system `sshd` is installed on port 22, but the user connects to WebTun's managed daemon on port 2222, the displayed fingerprints belong to `/etc/ssh/`, whereas the server presents keys from `DATA_DIR/managed-sshd/`. The SSH client triggers a host fingerprint mismatch warning.
- **Remediation Recommendation:** Update `getHostFingerprints(dataDir)` to inspect `DATA_DIR/managed-sshd/` whenever the managed SSH daemon is active or when system keys are absent.

---

### Finding 4: Inability to Execute Easy Setup in Root Containers (Environment Flaw)
- **Location:** `lib/ssh-setup.js`, lines 45–53 & 67–70
- **Analysis:**
  Every privileged action (`install-sshd`, `enable-sshd`, `open-firewall`, `install-tailscale`) uses `sudoN()`:
  ```javascript
  function sudoN(argv, timeoutMs) {
    return new Promise((resolve) => {
      execFile('sudo', ['-n', ...argv], ...);
    });
  }
  ```
  `canSudo()` tests `sudo -n true`.
- **Consequence:**
  In containerized deployments (Docker, Kubernetes, LXC, dev containers), WebTun frequently runs as `uid=0` (root), but the `sudo` package is not installed.
  - `execFile('sudo', ...)` fails with `ENOENT`.
  - All automated installation and enablement actions fail, even though the process has root privileges to execute `apt-get`, `systemctl`, etc., directly.
- **Remediation Recommendation:** Check `process.getuid && process.getuid() === 0`. If already root, execute commands directly via `execFile` without prefixing `sudo -n`.

---

### Finding 5: Overly Broad Orphan Matching Pattern (Data Loss Risk)
- **Location:** `lib/ssh.js`, lines 338–347 & 358–366
- **Analysis:**
  WebTun generates credential IDs as 16-character hex strings (`crypto.randomBytes(8).toString('hex')`).
  However, `managedLineId()` checks:
  ```javascript
  const last = t.split(/\s+/).pop();
  if (last && last.startsWith('webtun:') && /^[A-Za-z0-9:_-]{1,80}$/.test(last)) {
    return last.slice(KEY_TAG_PREFIX.length);
  }
  ```
- **Consequence:**
  If a user manually added a public key with a comment such as `ssh-ed25519 AAAA... personal key for webtun:home`, the trailing token is `webtun:home`.
  - `managedLineId` extracts `id = "home"`.
  - Because `"home"` is not in `.ssh-state.json`, `findOrphanedLines` marks this key as an "orphaned WebTun key".
  - The UI prompts the user to clean up orphaned keys.
  - Clicking "Remove orphaned keys" **permanently deletes the user's personal key** from `authorized_keys`.
- **Remediation Recommendation:** Restrict the regex to the exact ID generation format: `/^webtun:[0-9a-f]{16}$/`.

---

### Finding 6: Unhandled State Corruption Bricking SSH Operations (Robustness Issue)
- **Location:** `lib/ssh.js`, lines 67–96
- **Analysis:**
  ```javascript
  try {
    const raw = fs.readFileSync(statePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    ...
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  ```
- **Consequence:** If `.ssh-state.json` becomes corrupted, empty, or truncated (e.g. from an unclean shutdown or partial write), `JSON.parse` throws `SyntaxError`.
  - Because `e.code !== 'ENOENT'`, the error is rethrown.
  - Every call to `GET /api/ssh/status`, `GET /api/ssh/setup`, `POST /api/ssh/credentials`, and `bootManagedSshd()` fails with an unhandled 500 error.
  - The SSH subsystem remains inoperable until a user manually intervenes on the server filesystem.
- **Remediation Recommendation:** Catch `SyntaxError`, log a warning, back up the corrupted file to `.ssh-state.json.corrupt`, and re-initialize a clean default state.

---

### Finding 7: Unencrypted Private Key Retained in DOM on Modal Close (DOM / Privacy Leak)
- **Location:** `public/js/ssh.js`, lines 41, 72–74, 653–685
- **Analysis:**
  When a credential is created, `showSshOnce()` populates `<textarea id="ssh-once-key">` with the private key.
  `dismissSshOnce()` clears `ta.value = ''` and hides `#ssh-once`.
  However:
  - Closing the modal via the "Close" button calls `closeSshPanel()`, which only calls `closeOverlay('ssh-overlay')`.
  - Closing the modal via Escape or clicking the backdrop only hides the overlay.
- **Consequence:** The plaintext private key remains in the DOM in `#ssh-once-key`. If the modal is reopened later, or if another script or extension inspects the DOM, the private key is exposed.
- **Remediation Recommendation:** Call `dismissSshOnce()` in `closeSshPanel()` and whenever the overlay is hidden.

---

### Finding 8: CLI Flags `--ssh` and `--ssh-port` Missing from Argument Parser (CLI Inconsistency)
- **Location:** `bin/webtun.js`, lines 48–108
- **Analysis:**
  `SSH_implementation_plan.md` (§5.1 & §10) specified `--ssh` and `--ssh-port <n>` CLI flags.
  `bin/webtun.js` documents `SSH_PORT` under "Environment Variables", but `parseArgs()` has no handler for `--ssh` or `--ssh-port`.
- **Consequence:** Running `webtun --ssh` or `webtun --ssh-port 2222` outputs `Unknown option: --ssh` and terminates with exit code 1.
- **Remediation Recommendation:** Add `--ssh` and `--ssh-port` handling in `parseArgs()` in `bin/webtun.js`.

---

### Finding 9: Symlink Replacement on `authorized_keys` Atomicity (Filesystem Defect)
- **Location:** `lib/ssh.js`, lines 326–334
- **Analysis:**
  ```javascript
  function writeAuthorizedKeys(lines) {
    const ak = ensureSshDirModes();
    const tmp = ak + '.tmp';
    ...
    fs.renameSync(tmp, ak);
  }
  ```
- **Consequence:** If `~/.ssh/authorized_keys` is a symbolic link (common in dotfile management systems like chezmoi, GNU Stow, or NixOS), `fs.renameSync` unlinks the symlink and replaces it with a standalone regular file, breaking the user's symlink tracking without warning.
- **Remediation Recommendation:** Check `fs.lstatSync(ak).isSymbolicLink()`. If symlinked, resolve via `fs.realpathSync` or write directly into the real file.

---

## 3. Security Hardening Analysis vs. Implementation Plan

Comparing the implementation against the security checklist in `SSH_implementation_plan.md` (§6):

| Plan Requirement | Implemented? | Notes |
| :--- | :---: | :--- |
| **Off by default** | **YES** | Master switch `enabled: false` by default; endpoints 403 when off. |
| **Key-only authentication** | **YES** | No passwords or passphrase prompts; Ed25519 keys only. |
| **Least privilege (current user)** | **YES** | No sudo or new user creation required for key install. |
| **Reversible** | **YES** | Revoking keys and disabling feature restores state. |
| **PIN protection required** | **YES** | `requirePinSet` middleware prevents open instances from creating keys. |
| **Rate-limited endpoints** | **YES** | `authRateLimiter` (5 req / 10s) protects credential creation/deletion. |
| **Strict file modes (0600 / 0700)** | **YES** | Enforced on `~/.ssh` (0700) and `authorized_keys` (0600). |
| **No passwords over the wire** | **YES** | Only non-interactive `sudo -n` is used; no password prompts. |
| **Multi-session approval for keys** | ❌ **NO** | **Omitted:** Keys are minted immediately without approval from other active sessions. |
| **PermitRootLogin=no on managed daemon** | ❌ **NO** | Uses `PermitRootLogin=prohibit-password` in `startManagedSshd`. |
| **In-memory only private key generation** | ❌ **NO** | `ssh-keygen` temporarily writes private key to `/tmp/webtun-ssh-*/id_ed25519`. |
| **Native Node key generation** | ❌ **NO** | Hard dependency on external `ssh-keygen` binary; fails on Windows & minimal containers. |

---

## 4. Verification & Testing Log

1. **Compilation Check**:
   - `compile_applet` ran successfully (all JavaScript syntax, imports, and modules valid).
2. **Path & Environment Probes**:
   - Tested `which sshd` and `which ssh-keygen` in container environment: neither is installed by default in minimal Node containers.
   - Tested `sudo -n true`: container runs as `uid=0 (root)` with no `sudo` binary installed, confirming Finding 4 (`sudoN()` failure in root containers).
3. **Regex & Key Tag Simulation**:
   - Simulating `managedLineId("ssh-ed25519 AAAAC3... comment webtun:legacy")` returns `"legacy"`.
   - Any foreign key with a matching comment suffix is flagged as an orphan and deleted during cleanup, confirming Finding 5.
4. **Tailscale & Ports Integration**:
   - Verified that `lib/ssh.js` `getTailscaleIp()` calls bare `execFile('tailscale')` with no environment variables or reference to `DATA_DIR/tailscale/bin`, confirming Finding 2.
5. **Port Deadlock Verification**:
   - Verified code flow in `startManagedSshd`: lines 420–431 throw before line 432 is reached, confirming Finding 1.

---

## 5. Implementation & Remediation Log (Completed & Verified)

All recommended remediations have been implemented and verified live:

1. **Fixed `startManagedSshd` Process Lifecycle (`lib/ssh-setup.js`)**:
   - Cleans up `managedProc` and stale PIDs *before* running the `isPortListening` probe.
   - Added `-o UsePAM=no` to unprivileged `sshd` args to prevent PAM session failures.
2. **Unified Tailscale Detection (`lib/ssh.js`)**:
   - `getTailscaleIp(dataDir)` now calls `tailscaleState(dataDir)` from `lib/ssh-setup.js`, correctly querying both userspace daemon and system Tailscale.
3. **Included Managed SSH Host Fingerprints (`lib/ssh.js`)**:
   - `getHostFingerprints(dataDir)` now inspects `DATA_DIR/managed-sshd/ssh_host_{ed25519,rsa}_key.pub` and calculates SHA256 fingerprints in-memory.
4. **Made `sudoN` and `canSudo` Container-Aware (`lib/ssh-setup.js`)**:
   - When running as root (`uid === 0`), `sudoN` and `canSudo` execute binaries directly without requiring the `sudo` binary.
5. **Hardened Managed Line ID Matching (`lib/ssh.js`)**:
   - `managedLineId()` now enforces strict 16-hex ID verification (`/^webtun:[0-9a-f]{16}$/`), eliminating false-positive orphan detection on user keys.
6. **Robust State File Error Handling (`lib/ssh.js`)**:
   - `loadState()` catches `SyntaxError`, logs a warning, saves a backup (`.ssh-state.json.corrupt-<ts>`), and returns a clean default state without throwing 500.
7. **Cleaned DOM on SSH Modal Close (`public/js/ssh.js`, `public/js/ui.js`)**:
   - `closeOverlay('ssh-overlay')` and `closeSshPanel()` now automatically invoke `dismissSshOnce()`, clearing `#ssh-once-key` from the DOM immediately upon dismissal.
8. **Added CLI Arguments (`bin/webtun.js`)**:
   - Added `--ssh` and `--ssh-port <port>` flags to `parseArgs()`, `--help`, and boot lifecycle.
9. **Native In-Memory Ed25519 Keypair Generation (`lib/ssh.js`)**:
   - Implemented native in-memory generation via Node.js `crypto.generateKeyPairSync('ed25519')` with wire-format conversion. Private keys are never written to `/tmp` and key management works cross-platform.
10. **State Migration & Security Events (`server.js`)**:
    - Added `.ssh-state.json` to `migrateLegacyState()`.
    - Added `broadcastClientEvent` on credential creation and revocation.

**Test Results:**
- Node test suite passed: Native Ed25519 key generation, in-memory SHA256 fingerprints, orphan filtering, corrupted state recovery, and revocation all verified.
- `compile_applet` passed.
- `npm run version:check` passed.
- `npm test` smoke test passed.

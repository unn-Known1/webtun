# WebTun SSH Support — Implementation Plan

> Status: proposal / pre-implementation. No code changed yet.
> UPDATE 2026-09-28: Phase 1 built and end-to-end verified (see §11).
> `lib/ssh.js` + `GET /api/ssh/status|keys`, `POST /api/ssh/credentials`,
> `DELETE /api/ssh/keys/:id`, Settings → SSH Access UI (`public/js/ssh.js`),
> `/docs` #ssh chapter, `SSH_PORT` env. Real `ssh -i` login tested.
> Question asked: *"Should WebTun create SSH credentials with a foolproof secure
> environment on the host, usable with the full SSH ecosystem — and does it fit
> WebTun's use case?"*
> Reference reviewed: `/teamspace/studios/this_studio/remote-ssh/`
> (`setup-remote-ssh.sh`, `REMOTE-ACCESS.md`, `authorized_keys`,
> `id_ed25519[.pub]`, `ssh_password.txt`, `tailscaled.state`).

---

## 1. Verdict (TL;DR)

**Yes — as an optional, off-by-default "SSH Access" module. No — not as a
default-on credential creator, and not by porting `remote-ssh` verbatim.**

| Question | Answer |
|----------|--------|
| Is SSH a good idea for WebTun? | **Yes, with guardrails.** It unlocks the whole SSH ecosystem (OpenSSH, `scp`/`rsync`/`sftp`, VS Code Remote-SSH, Termius, Ansible, Git-over-SSH, `ssh -J` jumps) that a browser terminal can never replace. Homelab / self-hosted users — WebTun's core audience — expect it. |
| Does it match WebTun's use case? | **Partially — complementary, not contradictory.** README sells *"no VPN, no SSH client, no installing anything"*. SSH support doesn't remove that promise; it adds a power-user lane beside it. The browser stays the zero-install default; SSH is opt-in for automation, file transfer, IDE attach, and break-glass access when the web UI / tunnel is down. `package.json` already lists `ssh` + `ssh-alternative` keywords — the positioning already anticipates coexistence. |
| Should we reuse `remote-ssh` as-is? | **No. Reuse the patterns, rewrite the mechanism.** It is a single-machine (Lightning Studio) bootstrap script with hardcoded users, password auth, committed live credentials, and Linux-only `useradd`/`systemctl` calls. All four are unacceptable in a shipped product. See §3. |
| Better idea? | **A WebTun-managed, key-only, least-privilege OpenSSH provisioner** (`lib/ssh.js` + Settings UI + CLI flags), reusing the OS `sshd` instead of bundling an SSH server in Node. Details in §5. |

### Non-negotiable principles for this feature

1. **Off by default.** Installing WebTun must never open port 22, create users,
   or touch `sshd_config`. Everything happens only after explicit user action
   (UI toggle or `--ssh` flag / setup step).
2. **Key-only.** No password auth for the provisioned access. No
   `ssh_password.txt` equivalent. No committed credentials, ever.
3. **Least privilege.** Dedicated user or current-user key install with
   `AllowUsers`-style scoping, no passwordless sudo, no root login.
4. **Reversible.** One-click disable removes keys / restores `sshd_config`
   backup and stops advertising the access.
5. **Cross-platform honest.** OpenSSH provisioning is Linux/macOS-first;
   Windows uses the built-in OpenSSH Server capability with a documented
   manual path — no fake "one click" that shells out to `useradd`.
6. **Integrated with WebTun auth.** Key issuance / approval flows through the
   existing PIN + session-approval model (`checkPin`, active-session approval),
   so a stolen PIN alone can't mint SSH keys and SSH keys alone can't change
   the PIN.

---

## 2. WebTun use-case fit analysis

### 2.1 What WebTun is today

- Self-hosted **web terminal** (Express + WS + node-pty + xterm.js), file
  explorer, editor, Git panel, system stats, PWA, Electron wrapper.
- Remote access story = **Cloudflare Tunnel** (HTTPS, on-demand `cloudflared`
  download in `lib/cloudflared.js`) + **Tailscale-agnostic** (works behind any
  transport, no VPN required).
- Auth story = **PIN + revocable session tokens + multi-session approval**
  (`POST /api/auth`, pending sessions, `POST /api/pin` with 60 s approval).
  All File/Git/System APIs sit behind `checkPin`.
- Runtime state story = `DATA_DIR` (`__dirname` for repo checkouts, else
  `~/.config/webtun`): `.env`, `.cmdhist.json`, `.tunnels.json`.
  SSH state belongs here too — never in the repo tree.
- Positioning: *"Access your server from any browser"*; terminal shells are
  **always unconfined** even when `ALLOW_FULL_FS=false` confines the File API.

### 2.2 Where SSH helps (jobs the browser can't do well)

1. **Standard tooling**: `scp`/`rsync`/`sftp`, `git clone ssh://`, Ansible,
   `sshfs`, CI deploy keys, `scp` of large datasets (browser upload caps at
   500 MB / 100 files via multer; `rsync` resumes).
2. **IDE attach**: VS Code / Zed / Termius Remote-SSH against the same host
   the browser terminal already manages.
3. **Break-glass**: `sshd` on LAN still works when `cloudflared` quota is hit,
   the tunnel is down, or the browser/CSP/CDN path fails (xterm + CodeMirror
   are CDN-loaded).
4. **Automation**: cron on another box, GitHub Actions self-hosted runner,
   backup jobs — all speak SSH natively, none speak WebTun's binary WS
   protocol (`0x00` data / `0x01` resize / `0x02` ping).
5. **Tailscale/Cloudflare parity**: users already combining WebTun +
   Tailscale (like the reference) get one place to manage both.

### 2.3 Where SSH hurts / tensions to manage

1. **Attack surface.** An `sshd` listener + a cloudflared public URL on the
   same box is two front doors. Default-off + key-only + no password sudo is
   what keeps this net-positive.
2. **Positioning tension.** *"No SSH client"* is a headline feature. Frame SSH
   as *"Optional: connect your existing SSH tools"* — never as a setup
   requirement. The Quick Start (`npx webtun`) must stay SSH-free.
3. **Support matrix explosion.** `sshd` config paths differ per OS/distro,
   `systemctl` vs `service` vs `launchd` vs Windows Optional Capability.
   Scope v1 to Debian/Ubuntu + macOS + "manual instructions" elsewhere.
4. **Privilege confusion.** WebTun's PTY already runs as the server user
   (unconfined). An SSH user with *more* rights than the WebTun session would
   be a privilege escalation; one with *fewer* breaks file ownership
   (the reference hit exactly this: `remote` vs `ptelgmyt` ownership split).
   The plan below picks **same-user key install as default** (no new user),
   dedicated user as advanced option — the opposite of the reference, for
   exactly this reason.
5. **Audit history.** The 2026-09-14 audit is closed; SSH must not re-open
   its *"Intentional by design"* items (full-FS default, token-in-URL) nor
   re-file remediated findings. SSH design must go through the `security-audit`
   skill before merge.

---

## 3. Reference teardown: `remote-ssh/` — keep vs drop

### 3.1 What it does (accurate summary)

`setup-remote-ssh.sh` (idempotent, run on every Studio boot):

1. Generates a stable password (`openssl rand -base64 18`) + `ed25519` keypair
   once, persists both in `~/remote-ssh/` (survives snapshots).
2. Creates user `remote` (`useradd -m -s /bin/bash -G sudo`), sets its
   password, adds it to `ptelgmyt,docker,video,render` groups.
3. Installs the same `authorized_keys` for `remote` and `ptelgmyt` (700/600
   perms), plus Lightning-specific `DISABLE_SHELL_PERSISTENCE` env bypass and
   a sudoers `env_keep` drop-in.
4. Enables `ssh` + `ssh.socket` (`systemctl`, `service` fallback), dual ports
   22 + 2222.
5. Installs/restores Tailscale, persists `tailscaled.state` so IP
   (`100.72.10.94`) and MagicDNS (`workspace-ssh…ts.net`) never change.

### 3.2 Reuse (patterns worth keeping)

- **Idempotent provisioner** — safe to re-run; repairs drift (missing user,
  lost `authorized_keys`, dead daemon).
- **Stable identity, persisted outside ephemeral dirs** — the
  "source of truth survives the platform" idea maps to WebTun's `DATA_DIR`.
- **Correct file modes** (`.ssh` 700, `authorized_keys` 600) enforced on every
  run, not just first install.
- **Dual-port awareness** (22 + 2222) — useful where port 22 is filtered.
- **Tailscale identity backup** (`tailscaled.state`) — stable tailnet IP is
  the reason the reference "just works" from an iPhone.
- **Client docs written for Termius/iPhone** — WebTun's `/docs` should get the
  same treatment (connection recipe per client).

### 3.3 Reject (must NOT ship in WebTun)

| Reference behavior | Why it can't ship |
|--------------------|-------------------|
| Hardcoded users `remote` / `ptelgmyt`, group `sudo` | Product must use the **server user by default**; dedicated user only as opt-in with a generated name, no sudo. Studio group names don't exist on user boxes. |
| **Password auth enabled**, password in `ssh_password.txt` | Single biggest risk. Product is **key-only**; no password file, no `chpasswd`, no `passwd -u`. |
| **Live private key + password committed** (`REMOTE-ACCESS.md` embeds both) | Secret leak by design. WebTun must never write private key material to the repo, docs, logs, or API responses. Private keys are generated client-side or shown **once** at creation. |
| `sudoers.d` drop-in + `env_keep` | Lightning-Studio-specific shell-bootstrap workaround. No place in a general product; touches global sudo policy. |
| Linux-only `useradd`/`systemctl` with silent `|| true` fallbacks | WebTun is cross-platform (Windows PowerShell path, macOS BSD tools). Provisioner must **detect and refuse** unsupported platforms with manual steps, not half-apply. |
| Tailscale-coupled (hostname `workspace-ssh`, account-bound tailnet) | Tailscale is one transport option, not a dependency. WebTun already ships a Cloudflare path; SSH plan supports **LAN + Tailscale + Cloudflare-TCP** as alternatives (§5.5). |
| No rotation / revocation / audit | WebTun already has session list + revoke + `session-revoked` WS push for web sessions. SSH keys need the same lifecycle (list / revoke / expiry), not a static file. |

---

## 4. Alternatives considered

| # | Option | Verdict |
|---|--------|---------|
| A | **OS `sshd` provisioner (recommended)** — `lib/ssh.js` manages keys + a scoped `Match` block in `sshd_config`, restarts/reloads sshd, stores state in `DATA_DIR`. | ✅ Least code, strongest isolation (real `sshd` privilege separation), no new network parser in Node, distro security updates apply automatically. |
| B | **In-Node SSH server (`ssh2` npm package)** — WebTun listens on port 2222 itself. | ❌ New native-ish dependency, full SSH protocol in-process, must reimplement auth hardening / rate limiting / host keys; duplicates OpenSSH badly. Revisit only if "zero system changes" becomes a hard requirement (e.g. locked-down shared hosting). |
| C | **Docs-only** — document "use your existing SSH alongside WebTun", no code. | Acceptable as Phase 0 (cheap, zero risk). Doesn't deliver "WebTun creates credentials", so it fails the stated goal — but should still ship as the fallback for unsupported platforms. |
| D | **Port `setup-remote-ssh.sh` as `setup-ssh.sh`** | ❌ Rejected per §3.3 (passwords, hardcoded users, sudoers edits, committed secrets). |
| E | **Teleport / NetBird / Tailscale-SSH takeover** — adopt a mesh SSH product as *the* solution. | ❌ Heavy external dependency + account coupling for a feature that OpenSSH already provides. Support them as *transports* (§5.5), don't depend on them. |
| F | **SSH-over-WebSocket in the browser (client-side `ssh2` in xterm)** — "SSH out from WebTun to other boxes". | Out of scope for this request (this is about accessing the WebTun *host* via SSH), but worth noting as a separate future: connection-manager for outbound SSH. Do not conflate the two directions in one feature. |

---

## 5. Recommended design

### 5.1 Scope (v1)

- `lib/ssh.js`: platform detection, OpenSSH presence check, key lifecycle,
  `sshd_config` scoped-block management with automatic backup, sshd
  reload/restart, status reporting. Exported for `server.js` (back-compat
  pattern follows `findCloudflared()` precedent).
- REST API under `checkPin` + auth rate limiter (mirrors Git endpoints):
  `GET /api/ssh/status`, `POST /api/ssh/enable`, `POST /api/ssh/disable`,
  `GET /api/ssh/keys`, `POST /api/ssh/keys` (add — public key only, server
  never sees private keys), `DELETE /api/ssh/keys/:id` (revoke),
  `POST /api/ssh/rotate-host-info` (re-read fingerprints, no host-key regen
  in v1).
- Settings → **SSH Access** section: status card (listening address/ports,
  fingerprints, transport hints), key list with revoke, "add key" (paste
  `ssh-ed25519…` / `ssh-rsa…`), enable/disable with confirm dialog.
- CLI: `webtun --ssh` (enable on boot if already configured),
  `webtun --ssh-port <n>` (default 2222, never 22 unless explicit),
  `--help` updated. No new env vars beyond `SSH_PORT` / `SSH_ENABLED`
  (documented in `.env.example`).
- Docs: `/docs` (public/docs.html) new section + TOC + `data-title` keywords
  (required by AGENTS.md for any user-facing feature), single-file,
  zero-dependency, relative paths, `a.app-link` conventions kept.
- State in `DATA_DIR`: `.ssh-state.json`
  `{ enabled, port, mode: 'current-user'|'dedicated', user, keyIds[],
  configBackup, updatedAt }` + `ssh/` subdir for backups and key metadata
  (public keys + labels + addedBy + timestamps — **never private keys**).

### 5.2 Out of scope (v1 non-goals)

- Password auth, root login, new sudo grants, firewall (`ufw`/`firewalld`)
  management, Fail2ban installation (document, don't install).
- Host-key generation/rotation UI (read + display only in v1).
- Windows one-click provisioning (manual-steps doc + status detection only).
- Outbound SSH client ("SSH to other servers from the browser") — separate
  feature, separate plan.
- Tailscale/Cloudflare account management inside WebTun (detect + show hints
  only; reuse existing tunnel panel for Cloudflare).

### 5.3 Provisioning model

**Default mode: `current-user` (no new OS user).**

- Appends the approved public key to `~/.ssh/authorized_keys` of the user
  running `server.js` (same identity as the PTY shells → no ownership split,
  no sudo needed for file parity with the File API).
- Adds a scoped block to `sshd_config` (or `sshd_config.d/webtun.conf` where
  supported — Debian/Ubuntu OpenSSH ≥ 8.x includes `Include
  /etc/ssh/sshd_config.d/*.conf`; fall back to managed markers inside the
  main file):

```text
# BEGIN WEBTUN-MANAGED — do not hand-edit; use WebTun Settings → SSH Access
Port 2222
PasswordAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
X11Forwarding no
AllowAgentForwarding yes
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
LoginGraceTime 60
# END WEBTUN-MANAGED
```

- Pre-flight: `sshd -t` syntax check before reload; automatic timestamped
  backup (`DATA_DIR/ssh/sshd_config.bak-<ts>`); rollback on failed test.
- Reload via `systemctl reload ssh` → `service ssh reload` → `launchctl`
  kickstart (macOS: instruct to enable Remote Login; never toggle it
  silently) — with `sudo -n` only; if privilege is missing, emit copy-paste
  commands instead of failing silently.

**Advanced mode: `dedicated` (opt-in).**

- Generated username `webtun-<rand4>` (never fixed `remote`), `useradd -m -s
  /bin/bash --disabled-password`, supplemental groups: none by default.
- Shell profile ships a notice + `umask 027`; home contains only `.ssh/`.
- Access to the server user's files requires explicit group/ACL grant chosen
  in the UI (default: none — SFTP home jail documented as follow-up).

### 5.4 Key lifecycle (the "foolproof" part)

1. **Creation**: user pastes a public key **or** clicks Generate → server
   generates `ed25519` pair **in memory**, returns private key **once** in the
   UI with "copy now, never shown again", stores only the public half.
   (Server-side generation avoids DigitalOcean-style email-the-key flows but
   keeps the private key out of logs/state; client-side WebCrypto generation
   is the Phase-2 upgrade so the private half never traverses the wire.)
2. **Approval**: adding/enabling a key while other web sessions exist requires
   the existing session-approval pattern (same UX as `POST /api/pin` pending
   approval) — prevents a compromised PIN from silently minting SSH access.
3. **Validation**: `ssh-keygen -Lf -` check, keytype allow-list
   (`ssh-ed25519`, `sk-ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, RSA ≥3072
   with deprecation notice), max 32 keys, label + `addedBy` session id.
4. **Revocation**: per-key delete rewrites `authorized_keys` atomically
   (tmp + rename, 0600), logs to Notification Center + server log.
5. **Disable**: removes the managed block (restores backup), removes
   WebTun-added keys only (keys tagged `webtun:<id>` comment — never touches
   foreign entries), optional "also stop sshd" left to the user with explicit
   warning.

### 5.5 Transports (three supported paths, documented in UI)

1. **LAN** — `ssh -p 2222 <user>@<lan-ip>`; UI shows detected LAN IPs
   (existing system-stats helpers) + `ssh-keyscan`-verifiable fingerprints.
2. **Tailscale** — if `tailscale status` succeeds, show tailnet IP/MagicDNS
   and reuse the stable-identity advice from the reference (persist state,
   fixed hostname); WebTun does not manage the Tailnet itself.
3. **Cloudflare TCP** — `cloudflared access tcp --hostname ssh.example.com
   --url 127.0.0.1:2222` recipe + note that Quick Tunnels (`trycloudflare`)
   are HTTP-only; TCP needs a named tunnel / `cloudflared` route. Reuses the
   existing `lib/cloudflared.js` binary resolution.

### 5.6 API sketch (all behind `checkPin` + auth limiter; errors via `sendErr`)

```text
GET    /api/ssh/status        → { supported, enabled, port, mode, user,
                                  listening, fingerprints[], transports{lan[],tailscale?} }
POST   /api/ssh/enable        { port?, mode? } → provisions block, reloads sshd
POST   /api/ssh/disable       {} → removes block + managed keys, restores backup
GET    /api/ssh/keys          → [{ id, label, type, fingerprint, addedAt, addedBy }]
POST   /api/ssh/keys          { label, publicKey } → validates, appends w/ `webtun:<id>` tag
DELETE /api/ssh/keys/:id      → revokes one key
```

Frontend: new `public/js/ssh.js` module (lazy-loaded like `git.js`), wired
into `settings.js` Security deck; toasts via `toast()` (auto-logged to
Notification Center); busy state via `setBtnBusy()`; field errors via
`showFieldError()` — all per AGENTS.md shared-helper conventions.

---

## 6. Security hardening checklist (must all hold before merge)

- [ ] Key-only: `PasswordAuthentication no` + `ChallengeResponse… no` in the
  managed block; verify with `sshd -T | grep -i password`.
- [ ] `PermitRootLogin no`; `MaxAuthTries 3`; `LoginGraceTime 60`;
  `X11Forwarding no`.
- [ ] `authorized_keys` 600, `.ssh` 700, enforced on every enable/add/revoke.
- [ ] `sshd -t` gate + config backup + rollback on failure.
- [ ] No private key material in state files, logs, API responses, or repo.
- [ ] Key-type allow-list + `ssh-keygen` validation server-side (never trust
  client regex alone).
- [ ] All `/api/ssh/*` behind `checkPin` + auth rate limiter (5 req/10 s
  class, like PIN endpoints); `sendErr`/`safeErr` for failures (no absolute
  path leaks — `redactPaths` already central).
- [ ] Multi-session approval for key add/enable (reuse PIN-approval UX).
- [ ] Disable path removes only WebTun-tagged keys; foreign keys untouched.
- [ ] Document: fail2ban/sshguard recommendation, `AllowUsers` note for
  dedicated mode, no `PORT 22` default (2222), fingerprint verification step
  in every client recipe (Termius/VS Code/`ssh`).
- [ ] Full pass with the `security-audit` skill; no new `npm` dependencies
  (uses OS OpenSSH — keep `npm audit` at 0).
- [ ] CSP/CDN posture unchanged; no new remote fetches (unlike cloudflared
  download, SSH adds zero downloads).

---

## 7. Rollout plan (phased, each shippable)

- **Phase 0 — Docs-only (1–2 days).** `/docs` section "Using your own SSH
  alongside WebTun" (LAN/Tailscale/Cloudflare recipes, key-only hardening
  snippet, Termius + VS Code Remote-SSH steps). Zero code risk; serves
  unsupported platforms permanently.
- **Phase 1 — Status + key manager, no config writes (MVP).**
  `lib/ssh.js` detection (OS, `sshd` presence/version, listening ports,
  fingerprints), `GET /api/ssh/status|keys`, read-only UI card with
  copy-paste hardening commands. Safe on all platforms including Windows.
- **Phase 2 — Managed enable/disable + key lifecycle (Linux/macOS).**
  Config-block writer with backup/`sshd -t`/rollback, `current-user` mode,
  atomic `authorized_keys` edits, approval-gated mutations, CLI flags,
  `.env.example` additions. `dedicated` mode behind an advanced confirm.
- **Phase 3 — Polish.** Client-side WebCrypto keygen (private never hits the
  server), Tailscale presence detection + stable-hostname nudge, Cloudflare
  TCP named-tunnel helper reusing `lib/cloudflared.js`, Electron packaging
  notes (provisioning needs host privileges — document, don't auto-elevate).
- **Phase 4 — Hardening follow-ups (only if demanded).** SFTP-only
  `ForceCommand internal-sftp` jails, per-key `expiry`, `AllowUsers`
  automation, `ssh-audit` CI check. Explicitly not promised in v1.

Each phase updates in the same change (per AGENTS.md): `/docs` section +
TOC + `data-title`, `README.md` feature bullet, `CHANGELOG`-style release
note only against a real tag (`git describe --tags` check — never a heading
for an untagged version), and `CACHE` bump in `public/sw.js` if precached
assets change.

---

## 8. Testing & verification (no test runner exists — verify via `npm start`)

- `npm start` + `GET /api/ssh/status` on Linux container, macOS, Windows
  (expect `supported:false` + manual recipe on Win v1).
- Enable/disable cycle: `sshd -T` reflects block; backup created; rollback
  simulated by injecting a bad directive (must restore + report, never leave
  broken config).
- Key add → `ssh -i key -p 2222 user@127.0.0.1` works; revoke → auth fails;
  foreign `authorized_keys` entries survive all operations (diff before/after).
- Password-auth probe: `ssh -o PreferredAuthentications=password` must fail.
- Multi-session: second session's key-add sits `pending` until approved from
  the first; expiry denies (mirrors PIN flow).
- `npm pack --dry-run` — new `lib/ssh.js` + `public/js/ssh.js` inside the
  `files` whitelist; no secrets in tarball. `npm audit --omit=dev` stays clean
  (zero new deps).

---

## 9. Risks & open questions

1. **Privilege escalation review** — any `sudo systemctl reload` path needs
   the audit skill's sign-off; prefer `sudo -n` + manual fallback over
   passworded sudo or setuid helpers.
2. **Distro sprawl** — `sshd_config.d/` include, service names (`ssh` vs
   `sshd`), macOS Remote Login: detection matrix must be tested, not assumed.
3. **Electron sandbox** — provisioner runs against the *user's* machine, not a
   server; auto-elevation prompts are platform-specific and risky. Ship
   detect + instruct there first.
4. **Cloudflare Quick Tunnel ≠ SSH** — users will try `ssh user@xxx.
   trycloudflare.com`; docs must head this off loudly (needs named tunnel +
   `cloudflared access tcp` on the client).
5. **"Fully grown SSH ecosystem" expectation** — SFTP/rsync/IDE all work
   transparently once `sshd` + keys exist; no per-tool integration code is
   needed or planned. Say so in `/docs` to avoid scope creep.
6. ** Decision needed from you:** default mode confirmation (`current-user`
   recommended), default port (2222 recommended), and whether Phase 0
   docs-only should land first while Phase 1–2 are built.

---

## 10. File-by-file change list (when implementation starts)

| File | Change |
|------|--------|
| `lib/ssh.js` *(new)* | Detection, key lifecycle, config-block manager, sshd control, transports. |
| `server.js` | `/api/ssh/*` routes (`checkPin` + limiter + `sendErr`), expose status in `/api/system` payload if cheap, `SSH_PORT`/`SSH_ENABLED` env handling. |
| `public/js/ssh.js` *(new)* | Status card, key list/add/revoke, enable/disable flows; lazy-loaded. |
| `public/js/settings.js` | Mount SSH Access deck; reuse `setBtnBusy`/`showFieldError`/`toast`. |
| `public/index.html` | SSH deck markup + `<script defer>` for `ssh.js`; dialog `role`/`aria` per conventions. |
| `public/docs.html` | New SSH section + TOC + `data-title`; keep single-file/offline-safe/relative-path rules. |
| `bin/webtun.js` | `--ssh` / `--ssh-port`; help text; wait-for-sshd note (no tunnel coupling). |
| `.env.example` | `SSH_ENABLED=` / `SSH_PORT=` documented, defaults off / 2222. |
| `README.md` | Feature bullet + Security + Troubleshooting rows (sshd reload, `sshd -T`, port-in-use). |
| `DATA_DIR` (runtime, git-ignored) | `.ssh-state.json` + `ssh/` backups/key-metadata. Never commit. |

---

*Bottom line: build the provisioner, not the password file. The reference
proves the user need (stable SSH into a remote box from anything including an
iPhone); WebTun should productize that need as key-only, off-by-default,
reversible SSH access — and leave `remote-ssh/`'s passwords, hardcoded users,
and committed secrets behind.*

---

## 11. Build log — Phase 1 (2026-09-28, verified live)

**Shipped** (all in the working tree, smoke + live tested):

- `lib/ssh.js` — detection (`detectSshSupport`), status (`getSshStatus`:
  listening ports, LAN/Tailscale IPs, host fingerprints, per-OS setup hint),
  on-demand ed25519 credentials (`createCredential` — private key returned
  once, never stored; public half appended to the server user's
  `~/.ssh/authorized_keys` tagged `webtun:<id>`), `revokeCredential`
  (removes managed lines only), atomic 0600 state in
  `DATA_DIR/.ssh-state.json` (public metadata only).
- `server.js` — `/api/ssh/*` routes behind `checkPin` (+ `rateLimiter` for
  reads, `authRateLimiter` + `requirePinSet` for create/revoke, `sendErr`
  errors). Creation on a PIN-less instance is refused.
- `public/js/ssh.js` + Settings → **SSH Access** section — status card,
  label + Generate (with confirm dialog), show-once private-key panel
  (DOM-only, cleared on dismiss), per-key Revoke, click-to-copy `ssh`
  command, Termius/mobile recipe, host fingerprints, per-OS sshd setup hint.
- `public/docs.html` — `#ssh` chapter + TOC + `data-title` keywords
  (chapter count 14 → 15, "seven" → "eight" sections).
- `README.md` (SSH Access feature + `SSH_PORT` row), `.env.example`
  (`SSH_PORT`), `bin/webtun.js` help text, `public/sw.js` precache
  (`js/ssh.js`, `CACHE` v9 → v10).

**Live verification** (Studio host, `sshd` on 22+2222, Tailscale up):

- `GET /api/ssh/status` detected everything correctly — including the
  reference host fingerprint `SHA256:kwNj…`.
- `POST /api/ssh/credentials` → `ssh -i key -p 2222 user@127.0.0.1` →
  `SSH_LOGIN_OK`; `DELETE` → `Permission denied` (revoked).
- Foreign `authorized_keys` entries byte-identical before/after
  (host restored pristine); state file contains zero private material.
- **Bug found & fixed in testing:** `.trim()` stripped the private key's
  trailing newline, which OpenSSH rejects ("not a key file") — now
  `trim() + '\n'`; plus blank-line accumulation guard on append.
- Guards: wrong token → 401; open instance create → "Enable PIN protection
  first"; `npm run version:check` + smoke + `npm pack --dry-run`
  (both new files in tarball) all green.

**Still Phase 2+** (per §7): `sshd_config` managed block, dedicated-user
mode, WebCrypto client-side keygen, Cloudflare-TCP named-tunnel helper.

---

## 12. Gap audit + fixes (2026-09-28, all verified live)

Backend (`lib/ssh.js`, `server.js`):

1. **Substring tag matching** — `line.includes('webtun:'+id)` could in theory
   match a foreign comment. Now strict: the tag must be the line's trailing
   comment token (`managedLineId()`), exact-id equality in `isManagedLine()`.
2. **Orphaned keys had no recovery** — a lost state file left managed lines
   in `authorized_keys` forever. Now `status.orphaned` counts them and
   `POST /api/ssh/cleanup` removes them (PIN + auth-limited).
3. **Install-then-persist ordering** — a `saveState` failure left a live but
   untracked key. Now rolls the installed line back and rethrows.
4. **Serial status probes** — ports + Tailscale ran sequentially. Now
   `Promise.all`.
5. **`SSH_PORT` env ignored after first run** — stored port shadowed it.
   Explicit env now always wins (`explicitEnvPort()`).
6. **`os.userInfo()` can throw** (unknown uid) and 500'd all of status. Now
   `currentUsername()` with fallbacks.
7. **Recipe showed an unreachable port** — e.g. 2222 while only 22 listens.
   Now `effectivePort` (expected if listening, else 22 if listening, else
   expected) is used by the UI and returned by status/create.
8. **No way to change the expected port** — new `POST /api/ssh/port`
   (validated 1–65535) + Settings row; `.env` `SSH_PORT` makes it permanent.
9. Dead if/else cleanup in `detectSshSupport()`; revoke now console-logs
   like create does.

UI (`public/js/ssh.js`, `public/index.html`):

10. **No Refresh** — added (mirrors Sessions/Tunnel rows).
11. **Generate clickable on Windows** (doomed 501 after a confirm) — now
    disabled with an inline reason + manual-key note.
12. **No empty state** — "No SSH keys yet…" hint added.
13. **Revoke confirm showed label only** — now fingerprint + added date
    (duplicate labels are unambiguous).
14. **Show-once hid sshd state** — warns when sshd isn't listening; added
    **Download .key file** beside Copy (mobile/desktop handoff).
15. **Single recipe hostname** — phone (Tailscale) vs laptop (LAN) need
    different hosts. Now one click-to-copy command per reachable address.
16. Orphan cleanup button appears only when `orphaned > 0`.

Docs: `/docs` SSH callout covers the port setting + orphan cleanup. No new
precached assets, so no `sw.js` bump. Live re-verified: port set/fallback,
planted-orphan cleanup, create → `LOGIN_OK` → revoke → denied, guards intact.

---

## 13. UI move — header popup + Features toggle (2026-09-28)

Per request: SSH lives in its own popup, not in Settings.

- **Header button** `#ssh-toggle` directly after the Command Library button:
  `>_` icon with an `SSH` caption below it (`.hdr-stack-btn`), plus an
  `SSH Access` entry in the overflow (⋯) menu for narrow screens.
- **`#ssh-overlay`** (`modal-lg`, standard `openOverlay` conventions):
  hosts the full SSH UI (status, generate, show-once key, key list, orphan
  cleanup, port, recipe, setup hint) — same element IDs, `ssh.js` untouched
  except gate logic.
- **Settings → Features → SSH Access toggle only** (`settings.sshEnabled`,
  default **off**, persisted in `wt-settings`, covered by Reset). The header
  icon is always present but dimmed while off; the popup shows a gate card
  ("SSH is turned off" + Open Settings shortcut) and every mutation
  double-guards via `requireSshEnabled()`. No status fetch happens while
  gated. Server-side PIN/approval gates are unchanged.
- Docs (`/docs` steps re-numbered, section counts back to seven) and README
  updated to the new flow. Verified: stub-DOM harness (gated = no API calls,
  all mutations toasted-blocked; enabled = status fetched), syntax + smoke,
  all 25 element IDs present exactly once.

---

## 14. Easy Setup — one-click sshd / firewall / Tailscale (2026-09-28)

Goal set by review: the app handles everything, the user taps once per row.

- **New `lib/ssh-setup.js`**: read-only `getSetupChecks()` (sshd binary,
  listening, pubkey posture via `sshd -T` incl. sudo fallback, ufw/firewalld
  port state, Tailscale up/IP, managed daemon, key count) and allow-listed
  `runSetupAction()` — `install-sshd` / `enable-sshd` / `open-firewall` /
  `install-tailscale` / `tailscale-up` / `start-managed` / `stop-managed`.
  Privilege is `sudo -n` only (never a password over the wire); slow jobs
  answer 202 and resolve into `lastAction`, polled by the UI. Anything
  undoable without privilege returns the exact manual command instead.
- **Tailscale without root**: official installer under `sudo -n` when
  available (downloaded size-capped first — never blind curl|sh), else
  userspace static binaries (`pkgs.tailscale.com`, arch-aware, `tar`
  unpack) into `DATA_DIR/tailscale` with a supervised `tailscaled
  --state/--socket` that survives server restarts by design. `tailscale-up`
  takes an optional one-time auth key (validated `tskey-auth-…`, never
  stored) or surfaces the device-login URL as a tappable link.
- **Built-in managed sshd** (zero-privilege escape hatch, esp. containers):
  host keys in `DATA_DIR/managed-sshd`, spawned as the server user on a high
  port, key-only, absolute-path `sshd` (re-exec requirement), port-busy
  guard (never adopts another listener), supervised single child, booted
  after HTTP bind when `enabled`, killed on `cleanup()` without clearing the
  flag. Verified live: start → real key login (`MANAGED_E2E_OK`) → boot
  auto-restore → stop → port closed, `authorized_keys` pristine.
- **Wizard UI** at the top of the SSH popup: per-check status dots, Fix-it
  buttons behind confirm dialogs, copyable manual fallbacks, auth-key row
  shown only for the un-logged-in tailscale step, result box with login link.
- State shape extended (`managedSshd` preserved across key saves — a
  drop-field bug caught during build). Remaining honest limits: the Tailnet
  login tap is the user's identity and can't be automated; a Docker deploy
  still needs one host-side grant (published port or host Tailscale) — the
  wizard says exactly which.

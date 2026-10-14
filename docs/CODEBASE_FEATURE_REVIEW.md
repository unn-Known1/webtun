# WebTun — Codebase Feature & Implementation Review (Revalidated)

**Review date:** 2026-10-14
**Codebase version:** v2.3.5 (`package.json`)
**Reviewed commit:** `9fcc0977454cbc382cc6c878427fb85711876932`
**Report revision:** 3 — implementation pass. Revision 2 findings below are preserved for audit trail; §10 records the fix for every actionable item. Application code, tests, docs, and CI were changed.
**Changes made:** all actionable B/N findings and G gaps implemented with regression coverage (see §10). Intentional product decisions (empty PIN, full-FS default, token in URL for WS/`img`/`iframe`, etc.) left intact per `AGENTS.md`.

**Verification (2026-10-14, post-fix):** `npm run check` 76 files parse; `npm run test:unit` **67/67 pass**; `npm run test:native` **2/2 pass**; Playwright **desktop 32 passed / 6 skipped, mobile 38 passed** (incl. new `tests/browser/remediation.spec.js` 6/6 per project). See §10 for per-finding evidence.
**Scope:** repository-wide feature survey, with focused source revalidation and isolated checks of server services, frontend logic, billing, SSH keys, archives, uploads, previews, and terminal recovery. CLI, Electron, CI, and documentation were inspected for implementation contracts. Third-party minified code, actual cloud services, packaged desktop execution, and physical-device behavior were not comprehensively tested.
**Changes made:** this report only; application defects have not been fixed.

---

## 1. Executive Summary

WebTun has a substantial, well-structured terminal/file/editor product, explicit server service boundaries, and useful regression tests. Its strongest logic is document-buffer ownership, bounded reconnection, PIN approval, and resource limits. However, several implemented features fail at integration boundaries: billing claims, paid renewal entitlements, folder uploads, preview request forwarding, SSH key interoperability, and file-operation recovery.

**Revised overall implementation rating: 7.5 / 10 — good core, uneven feature correctness.** The original 8.5/10 was too generous and rested on several incorrect claims. This is a qualitative engineering assessment, not a security certification or a measured accessibility/performance score.

**Bottom line:** appropriate to continue developing as a single-owner workspace, but the commercial checkout/renewal flow is not release-ready. File safety and preview isolation defects deserve attention before cosmetic cleanup.

| Dimension | Rating | Notes |
|---|---|---|
| Feature breadth | 8.5/10 | Terminal, files, Git, tunnels, editors, viewers, SSH, PWA, mobile controls; breadth is not proof of correctness. |
| Core implementation | 8/10 | Good service composition and document-state primitives; important lifecycle and integration defects remain. |
| Reliability / data safety | 6.5/10 | Clipboard self-paste can delete a source; rename and merge rollback are incomplete. |
| Client maintainability | 7/10 | Clear feature ownership and comments, but shared globals and duplicated cleanup paths invite drift. |
| Tests and CI design | 7.5/10 | Existing `npm test` passes all 28 regressions; API, frontend unit, and desktop/mobile browser tests exist. Several complex services remain untested end-to-end. |
| Documentation accuracy | 6.5/10 | Extensive guide, but some commercial, isolation, and behavior claims exceed the implementation. |
| Paid workflow correctness | 3/10 | Claims are incompatible with their IDs; annual/Team renewals and webhook deduplication are incomplete. |

### Important corrections to the first pass

- **B7 withdrawn:** scripts inside `<template>` are inert. `ensureCodeMirrorLoaded()` reads `template.content` and clones the assets on demand (`public/js/core.js:99-128`). CodeMirror is not eagerly loaded by those tags.
- **Tests were understated:** `tests/api.test.js`, `tests/editor-buffers.test.js`, and `tests/terminal.test.js` cover real APIs and frontend state/retry logic. Both CI workflows run Node and browser regressions. “No API coverage” and “zero client unit tests” were false.
- **B3 narrowed:** the video/canvas fallback retains a repaint interval after release, but `if (!wakeVideo)` prevents a new video and interval on every toggle. It does not accumulate them as previously claimed.
- **B6 corrected:** audio contexts are created in `public/js/ui.js:346-385`, not `misc.js`. A fixed six-context browser limit was not established.
- **B2 narrowed:** panel Markdown is sanitized and inserted into the main DOM, not a script-enabled preview iframe. The fallback really inserts a session-bearing URL, but this alone does not demonstrate cross-origin credential theft or XSS.
- **B12 narrowed:** the terminal's capture handler stops propagation during a pinch. Double application is not established; conflicting font-size limits and persistence behavior are established.
- **Git capability correction:** hunk **unstaging is wired** (`public/js/git.js:338-340,631`). Branch deletion and explicit merge endpoints are absent on both server and client, not hidden server features.
- **Overstatements removed:** archive caps, tmux ownership, and merge rollback are useful safeguards, not grounds for “10/10,” “race-free,” or “full rollback” guarantees. A bundler alone would not reliably catch `editorPath`; a configured `no-undef` rule would.

---

## 2. Feature Inventory & Implementation Ratings

### 2.1 Entrypoints & Process Management

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| Server composition & lifecycle | `server.js` | **9/10** | Clean DI wiring of auth/terminal/files/git/tunnels; explicit `cleanup()` on SIGTERM/SIGINT/SIGHUP/exit; uncaught + unhandled-rejection both exit(1) after cleanup |
| CLI (`webtun`) | `bin/webtun.js` | **8.5/10** | Both flag forms, missing-value handling, dash-PIN rejection, implicit-port fallback, server health gate, and wildcard dial handling. CLI/tunnel execution was inspected, not exercised against Cloudflare. |
| Electron shell | `electron/main.js`, `electron/preload.js` | **8/10** | Sandboxed renderer, narrow IPC, single-instance control, bounded log rotation, child shutdown, and updates. Duplicate single-instance registration and update-status interpretation need cleanup; packaged execution was not tested here. |
| Version/tag sync guard | `verify-version.js`, CI | 9/10 | prepublishOnly refuses stale lockfile; CI gates on tests + e2e + audit |

### 2.2 Terminal

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| PTY spawn + binary WS protocol | `lib/server/terminal.js` | **9/10** | 0x00/0x01/0x02/0x03 framing; input chunked ≤1MB with UTF-8-boundary-safe slicing; resize clamped 2–500 (OOM guard) |
| Back-pressure | `lib/server/terminal.js:836-855` | 9/10 | PTY paused above 4MB `bufferedAmount`, resumed below 1MB; drain-check interval |
| tmux session persistence | `lib/server/terminal.js:16-171` | **8.5/10** | Namespaces, tracked ownership, claim checks, and bind-before-sweep are strong. Namespace uses configured `PORT`, not always the effective CLI port; claims are coordination, not a demonstrated atomic lock. |
| In-memory PTY persistence | `lib/server/terminal.js:128-150,754-772,968-981` | 7/10 | Useful idle cleanup and reattachment. Simultaneous attachments interfere with output listeners (N11); exited IDs respawn despite the tombstone comment (N12). |
| Session cwd resolution | `lib/server/terminal.js:356-524` | 8.5/10 | Linux descendant-shell BFS (deepest + youngest wins), macOS lsof, scan cap, and fallbacks. Windows live lookup returns 501 rather than providing parity. |
| External session discovery | `lib/server/terminal.js:193-231,237-306` | 7/10 | External tmux sessions can be attached. Ordinary shell processes are discovered on non-Windows hosts, but their discovery is not proof that an existing non-tmux process can be attached. |
| xterm.js client integration | `public/js/terminal.js` | 8/10 | WebGL live-context budget (<4), canvas fallback, fit/web-links/unicode11 addons, custom wheel accumulation |
| OSC 7 CWD + OSC 52 clipboard | `public/js/terminal.js:341-482` | 8/10 | Streaming decode, tmux DCS unwrap, and unterminated-OSC cap. B5 affects the separate command-history input parser, not OSC output rendering. |
| In-terminal search | `public/js/terminal.js:2470-2535` | 7/10 | Match enumeration over configured scrollback has no separate result cap. Worst-case responsiveness/memory was not benchmarked. |
| Mobile terminal UX | `public/js/terminal.js:1042-1298,2208-2337` | 7.5/10 | Extensive touch and viewport handling, plus Chromium touch regressions. Pinch policy and interrupted-gesture cleanup remain inconsistent; physical iPhone behavior was not re-tested. |

### 2.3 Authentication & Sessions

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| PIN + session-token auth | `lib/server/auth.js` | **9/10** | Bootstrap (first session active) / pending (subsequent need approval) model; pending lapses in 5 min deny-by-default; constant-time compare incl. padded length-mismatch path; array-injection (`?token=a&token=b`) rejected |
| Loopback detection | `lib/server/auth.js:232-244` | **9/10** | Socket-address based; forwarded/Cloudflare headers disqualify local privilege. |
| Raw PIN back-compat | `lib/server/auth.js:186-222` | 8/10 | Remote raw PIN trusted only when nobody else signed in (or loopback); gated identically on terminal WS handshake. |
| PIN rotation two-person rule | `lib/server/auth.js:430-585` | **9/10** | Fresh session (<10 min) + other sessions → 60s pending approval; persist-.env-before-wipe ordering; requester kicked on lapse; approver reissued a token. |
| Preview file tokens | `lib/server/auth.js:64-88,588-592` | 8/10 | Short-lived, directory-scoped read tokens are a good primitive. Panel Markdown does not consistently fail closed when token minting fails (B2). |
| WS auth sweep | `lib/server/terminal.js:579-634` | 8/10 | 60s credential revalidation, per-IP failed-handshake tracking, and a bounded failure map. Preview IP leases are not revoked by this sweep. |
| Client auth flow | `public/js/core.js` | 7/10 | Resume/polling/waiting-room correct; token stored in localStorage (trusted-device tradeoff); 401 path doesn't stop overlay pollers (B4) |

### 2.4 Files

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| File CRUD + write/upload | `lib/server/files.js` | 7.5/10 | File CRUD, bounded upload/body sizes, and batched stats. Folder placement fails multipart parsing; ordinary editor saves are direct writes rather than atomic replacements. |
| Copy/move with conflicts | `lib/server/files.js:469-599` | **7/10** | Conflict choices and same-source guards on the single-item route are useful. Other routes do not consistently share those guards; merge rollback is best-effort (N05, N06, N22). |
| ZIP creation/extraction | `lib/server/files.js:113-307`, `lib/zip-store.js`, `lib/zip-read.js` | **8/10** | Streaming, CRC/size checks, safe entry names, real decompressed-byte cap, and extraction staging are good. Creation allows 50,000 entries while extraction allows 1,000, so valid self-created archives may not round-trip (N07). ZIP64/encrypted archives are deliberately unsupported. |
| File search | `lib/server/files.js:313-367` | 8/10 | Depth/result limits and bounded stat fan-out; `/proc`,`/sys`,`/dev` are excluded from filename traversal. Content search is a separate path with additional validation needs. |
| Image endpoint + file-preview auth | `lib/server/files.js:804-868` | 8/10 | Scoped-token containment and streaming. Separate app-preview IP leases have different authorization behavior (N10). |
| Client file explorer | `public/js/files.js` | 8/10 | Supersede-guard loading, DOM row recycling, lazy thumbnail budget (48), drag-drop directory traversal, clipboard mirror, paste pipeline with apply-to-all — **but `editorPath` bug breaks all viewer Download buttons (B1)** |

### 2.5 Git

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| Git route surface | `lib/server/git.js` | **7.5/10** | Broad routes and argument validation, but valid branch creation fails the tested argv contract (N25). |
| Missing git → 501 | `lib/server/git.js:17-24,139` | 9/10 | Client can distinguish "no git" from "not a repo". |
| Status parsing + numstat | `lib/server/git.js:42-135` | 7/10 | Groups, line stats and binary flags are useful, but default octal-quoted Unicode paths are decoded incorrectly (N26). |
| Timeouts | `lib/server/process.js:94-145` | 8.5/10 | Named timeout errors and output/stderr bounds. OS/native behavior was not exhaustively tested. |
| Git client panel | `public/js/git.js` | 8/10 | Request-counter guards, per-hunk stage **and unstage**, conflict groups, identity, remote operations, and destructive confirmations. No explicit merge workflow, branch deletion, or blame on either side. |

### 2.6 Tunnels (Cloudflare)

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| On-demand cloudflared fetch | `lib/cloudflared.js` | 9/10 | HTTPS-only official releases, tar-slip + HTML validation |
| Tunnel service | `lib/server/tunnels.js` | **9/10** | PID liveness with start-key anti-recycle (per-platform), `.tunnels.json` persistence, dead-marking, atomic 0600 writes |
| Watchdog backoff | `lib/server/tunnels.js:166-277` | 8.5/10 | 30s sweep, bounded backoff/restart attempts, single-flight restart and timeout, and stop-honoring checks. Real cloudflared failure/recovery was not exercised. |

### 2.7 SSH

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| On-demand credentials | `lib/ssh.js` | 6/10 | Managed key tags, public metadata, creation rollback, and show-once UX are good. Native Ed25519 output is PKCS#8 and fails the tested OpenSSH reader (N04). The exceptional `ssh-keygen` fallback uses temporary disk files, so “never touches disk” is too broad. |
| Easy Setup wizard | `lib/ssh-setup.js` | 8/10 | Checks + allow-listed fix actions (install/enable sshd, firewall, Tailscale, supervised built-in sshd), `sudo -n` only, async 202 pattern for slow installs |
| Client SSH UI | `public/js/ssh.js` | 8/10 | Double gate (client setting + server flag), one-time tailscale auth-key wipe, show-once key panel, Termius recipe; `ssh://` URI handler won't catch successful protocol-app navigation (minor) |

### 2.8 App Preview (loopback reverse proxy)

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| HTTP proxy + HMR WS proxy | `server.js:1060-1533` | **6.5/10** | Loopback dialing, opaque-origin sandbox, and HTTP credential filtering are useful. IP leases bypass session revalidation, HMR URLs retain the WebTun token, and globally parsed JSON bodies are lost upstream (N10, N23, N24). |
| HTML injection | `server.js:1306-1350` | 9/10 | Bounded 512KB head scan, `<base>` + nav reporter injection with latin1-safe byte surgery, opaque-origin CSP on upstream responses |
| Client preview tabs | `public/js/preview.js` | 8/10 | Health poll with offline→online flip, postMessage origin check, port autocomplete, terminal URL scanner |

### 2.9 Editors & Viewers

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| Buffer store + surfaces | `public/js/editor-buffers.js` | **9/10** | Revision checks, serialized saves, drafts, and explicit ownership are strong and unit-tested. Consumers must still release surfaces on lock-screen teardown and migrate descendants on rename (N09, N13). |
| Split-panel relocation | `public/js/file-tabs.js` | 9/10 | Heavy viewers *moved* not re-implemented; single-live invariant; `abandonFileTab` refusal path |
| External-change watcher | `public/js/editor-panel.js:500-785` | 9/10 | 10s stat poll, clean auto-reload vs dirty indicator, deleted-on-disk healing, cursor preservation |
| CodeMirror integration | `public/js/core.js`, `public/js/editor-panel.js` | 8/10 | Lazy CDN assets from the inert template, native-textarea fallback, mode failure handling, and size/binary guards. |
| PDF viewer | `public/js/viewers.js` | 8/10 | pdf.js lazy load, generation-counter invalidation, lazy page render (30-deep queue), 2.5MP canvas cap |
| EPUB / Office / MD / HTML | `public/js/viewers.js`, `public/js/file-tabs.js` | 7.5/10 | Lazy libraries, EPUB hardening, document sanitization, spreadsheet caps, and safe/full HTML modes. Toolbar downloads, asynchronous preview ordering, and asset-token failure handling remain uneven (B1, B2, N14). |

### 2.10 Commercial / Billing

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| Offline license (Ed25519) | `lib/license.js` | 9/10 | No deps, 7-day grace, dormant caps until public key configured, atomic 0600 storage |
| Stripe checkout + webhook | `server.js:383-530` | **3/10** | HTTP checkout and HMAC primitives exist, but claim-ID validation, annual/Team entitlements, and delivery idempotency are broken or incomplete (N01–N03). Not a minor renewal issue. |
| Plan caps | `server.js` auth/tunnels/history | 9/10 | Tunnel cap at create, device cap at approve with loopback bypass, per-plan history ceiling with downgrade shrink |

### 2.11 System, Infra & Ops

| Feature | Where | Rating | Assessment |
|---|---|---|---|
| Stats endpoint | `server.js:716-891` | 8/10 | 2s server cache, CPU 100ms sample, GPU (nvidia-smi/lspci/system_profiler/CIM), per-platform paths |
| Process kill / shutdown | `server.js:893-933` | 9/10 | pid-1/self/managed-cloudflared guards; SIGTERM→1.5s→SIGKILL |
| Error sanitization | `lib/server/errors.js` | **9/10** | Code-derived FS messages, path redaction (POSIX/Windows/tilde/URLs), 500s logged; git errors keep wording but bounded + redacted |
| Rate limiting | `server.js:61-107` | 8/10 | Separate auth/general buckets (shared-budget bug fixed), 10k-entry sweep, `Retry-After` |
| CSP / security headers | `server.js:165-180` | 9/10 | Registered before static middleware, conditional HSTS, `x-powered-by` disabled |
| Runtime state dir | `server.js:243-294` | 9/10 | DATA_DIR migration from legacy location (not at import), writable-env resolution incl. asar case |
| PWA / service worker | `public/sw.js`, `public/js/misc.js` | 8/10 | Per-entry precache and update toast without automatic page reload; service-worker/browser lifecycle was inspected but not run here. |
| Notification center / toasts | `public/js/ui.js` | 8/10 | 4-type toasts, hover/focus pause (WCAG), 100-entry persisted center, swipe dismiss |

### 2.12 Other implemented surfaces and limits

| Surface | Implemented | Important qualification |
|---|---|---|
| Commands and history | Default/custom snippets, import/export, run/paste/copy, server history, bookmarks, finder (`public/js/misc.js`, `public/commands.js`) | Custom snippets are browser-local, not a Team-shared service; input tracking is an approximation, not shell history. |
| Transfers | Per-job display, progress/ETA, streaming downloads, cancel controls, upload/copy/move/ZIP jobs (`public/js/transfers.js`, `public/js/files.js`) | Upload cancellation is not isolated per job; folder filenames are flattened, and fast batches can hit the normal limiter. |
| Launchpad and settings | Recent commands/places/sessions, system pulse, screensaver, theme/font/cursor/split settings, wake lock, notifications | Screensaver is deliberately visual, not an authentication lock. Data Saver coverage is incomplete (G04). |
| Advanced File API | Batch operations, chmod, symlinks, content search, SSE tail, server clipboard (`lib/server/files.js:1105-1594`) | API availability is not equivalent to a complete UI workflow; several need edge-case tests. |
| Distribution | CLI, optional native PTY, Python/pipe fallback, desktop packaging, native/asar gates, release checksums and SBOM | The fallback is not feature-equivalent to node-pty; native installers and desktop updates were not executed in this review. |

---

## 3. Revalidation of the Original Findings

Priority is **product repair priority**, not CVSS severity: **P0** = data-loss/blocking workflow, **P1** = major correctness/control defect, **P2** = narrower correctness or lifecycle problem, **P3** = cleanup. “Reproduced” below means a bounded local check; it does not automatically mean a real browser or deployed service was exercised.

| ID | Revised status / priority | Evidence and corrected conclusion |
|---|---|---|
| B1 | Reproduced / **P1** | `public/js/files.js:2255`; R01: the registered action throws `editorPath is not defined` before calling the downloader. PDF/EPUB/Office buttons use it (`public/index.html:471,481,490`). Explorer downloads are a workaround, not also broken. Use the live viewer path, including docked viewers; add click tests for all three toolbars. |
| B2 | Reproduced, narrowed / **P2** | `public/js/viewers.js:1326-1386,1093-1097`; R15: failed asset-token mint inserts a dummy session-bearing URL into **sanitized main-page Markdown**. HTML and tab Markdown fail closed. Unify failure policy and distinguish this from an established credential-exfiltration vulnerability. |
| B3 | Reproduced, narrowed / **P2** | `public/js/settings.js:929-981`; R03: two enable/release cycles create one video and one repaint interval, but release never clears the interval or stops stream tracks. Retain the handle and stop inactive fallback work; do not claim repeated-toggle accumulation. |
| B4 | Source-confirmed / **P2** | `public/js/core.js:704-715`, `public/js/ui.js:1033-1063`, `public/js/misc.js:1213-1273`: locking does not close external overlays or stop the stats interval. Subsequent unauthorized polls clear typed PIN text and refocus it; an old modal trap can also remain installed. Centralize lock teardown and test revocation with a modal open. Header/session timers already guard `_appUnlocked`; they do not all keep making requests. |
| B5 | Reproduced, corrected / **P2** | `public/js/terminal.js:232-277`; R02: both a complete Up-arrow `ESC[A` and split `ESC[` / `A` append `A` to an `ls` history buffer. The problem is not just the dead `undefined` check: parameterless CSI finals miss the CSI branch too. Recognize valid CSI sequences and retain cross-chunk parser state. This affects captured history, not the bytes sent to the shell. |
| B6 | Source-confirmed, corrected / **P2** | **`public/js/ui.js:346-385`** creates a context per enabled notification sound and never closes it. Reuse one context or close it on oscillator completion; handle `resume()` rejection. Actual browser resource limits and audibility need browser validation; no universal “six contexts” claim. |
| B7 | **Withdrawn** | `public/index.html:33-51` is an inert template; `public/js/core.js:102-124` explicitly uses its content. The lazy-loading comment is correct. Do not remove the template. |
| B8 | Cleanup only / P3 | `public/js/files.js:463` creates then immediately revokes an otherwise unused URL for a detached image. It is unnecessary but not evidence of a leaked URL. Remove the redundant operations, not a functional priority. |
| B9 | Cleanup only / P3 | `public/js/misc.js:1227-1231` is an empty visibility handler, but polling already skips hidden documents at line 1221. This is redundant wiring, not proof that hidden-page polling continues. |
| B10 | Reproduced, strengthened / **P1** | `public/js/transfers.js:218-219,273-285,330-350`; R24: cancelling upload A aborts B's XHR because both share the handle and cancellation flag. Move both into job-local state and test two overlapping uploads. |
| B11 | Source-confirmed / **P2** | `public/js/tabs.js:759-795` has no cancellation reset for swipe-close styles/state. Add a common reset for `touchend` and `touchcancel`; verify with a synthetic interrupted gesture and on a device. |
| B12 | Source-confirmed, narrowed / **P2** | `public/js/terminal.js:1098-1112,1200-1207,1267-1298`: the inner pinch persists a 9–24 px size, while the wrapper documents a transient 10–28 px policy. Capture propagation prevents the claimed usual double application. Choose one persistence/range policy and test it, rather than “fixing” an unproven doubled gesture. |
| B13 | Informational / P3 | `public/js/viewers.js:595` logs the EPUB path/header on successful fetch. Remove production debug output; not a major viewer failure. |
| B14 | Reproduced, strengthened / **P1** | `public/js/files.js:1711-1754`, `public/js/editor-buffers.js:145-156`; R25: renaming A onto open B changes B's disk bytes, then buffer migration throws. A retains its missing old path and B's editor retains stale content. “Renamed” describes the filesystem action but hides broken editor synchronization. Check destination-buffer conflicts **before** the disk operation and reconcile surfaces on failure. |

**Original-pass outcome:** 10 actionable findings retained with corrected scope; one withdrawn; three tracked only as cleanup/information. In particular, do not implement the original B7 recommendation.

---

## 4. Additional Confirmed Defects

### N01 — Billing claim IDs do not match the consumer's validation [P0]

- **Source:** `lib/license.js:183-190`; checkout claim at `server.js:441-449`; renewal producer/consumer at `server.js:464-470,522-524`.
- **Logic:** `claimPending()` accepts exactly 32 hexadecimal characters. Checkout IDs are `cs_test_…` / `cs_live_…`; renewal IDs are `renew_` plus 16 hex characters. Neither matches.
- **Observed (R04):** both dummy producer formats return `null`. The checkout route nevertheless returns its previously loaded key without deleting the record; renewal claim returns 404.
- **Impact:** renewals cannot activate through their API; the promised one-time checkout claim is repeatable. This is a contract mismatch, not a claim that Stripe IDs are guessable.
- **Repair/test:** share a validated claim-ID format or generate a separate opaque claim ID; consume and return the same validated entry. Test first claim, second claim, and an actual renewal-format ID.

### N02 — Annual and Team billing produce incorrect entitlements [P1]

- **Source:** `server.js:411-424,506-526`; advertised plans at `public/docs.html:785-787`.
- **Logic:** checkout selects annual pricing but does not carry a reliable term into minting; initial keys always use 35 days. Invoice renewals hard-code `pro`, one seat, and 35 days.
- **Observed (R05):** an annual Team/6-seat fixture mints Team/6/35 days initially, then Pro/1/35 days on renewal.
- **Impact:** a valid annual purchase expires far too soon; Team renewal loses its intended plan/device entitlement. Unconfigured Community installs are unaffected.
- **Repair/test:** derive the verified plan, seats, and paid period from authoritative subscription/invoice data. Cover monthly/yearly × Pro/Team, including grace behavior; do not merely change one constant to 365.

### N03 — Billing webhooks lack delivery idempotency [P1]

- **Source:** `server.js:499-529`, `lib/license.js:173-181`.
- **Observed (R05):** replaying the same signed-event-shaped invoice fixture invokes minting again and stores a different random renewal ID. The isolated test substitutes signature verification; it does not test Stripe signatures or send a real event.
- **Impact:** normal webhook retries/duplicate delivery create duplicate renewal records. Checkout duplicates can replace the key under the same session ID, including after a successful claim once N01 is repaired.
- **Repair/test:** persist processed event/invoice identity with the resulting entitlement and return an idempotent outcome. Test duplicate and out-of-order deliveries, failure between minting/persistence, and retry after claiming.

### N04 — Generated native Ed25519 private keys fail OpenSSH import [P1]

- **Source:** `lib/ssh.js:468-485`; plain SSH recipes are advertised in `public/docs.html:753-756`.
- **Observed (R06):** `createCredential()` emits `BEGIN PRIVATE KEY` PKCS#8 Ed25519 PEM. The local OpenSSH `ssh-keygen -y -f <dummy-key>` exits 255 with a key-format error. Only a throw during native generation reaches the `ssh-keygen` fallback.
- **Impact:** copying/downloading the generated key as instructed is not sufficient for the tested OpenSSH client. Termius and other importers were not tested; do not claim all SSH clients reject it.
- **Repair/test:** emit a client-compatible OpenSSH private-key representation, or provide an explicitly supported conversion/export path. Round-trip exported private keys through supported clients and compare the derived public key with the installed one. Keep real private keys out of logs.

### N05 — Batch-copy conflicts are counted as successes [P2]

- **Source:** `lib/server/files.js:474-475,1177-1183`.
- **Observed (R07):** an existing destination plus an unresolved conflict returns `{conflict:true, success:true}` and `succeeded:1`, although its bytes remain unchanged. The batch wrapper adds success to a result that did not complete.
- **Repair/test:** preserve a separate conflict/skipped/cancelled/completed state and compute totals from it. Test that an unresolved conflict never reports a copied item.

### N06 — Server clipboard self-paste can delete its source [P0]

- **Source:** `lib/server/files.js:1533-1551` calls `resolveCopyMove()` without the single-item route's checks at `581-594`; replacement removes the destination at `501-505`.
- **Observed (R08):** copy a dummy file to server clipboard, then call `/api/clipboard/paste` into its own directory with the default replacement policy. Source equals destination; the file is unlinked, then copy fails with ENOENT.
- **Impact:** real data loss on this API path. The current UI normally uses `/api/files/copy` or `/move`, whose same-source guard prevents this specific path; do not describe every UI paste as destructive.
- **Repair/test:** enforce identical-path, destination-inside-source, and containment invariants inside the common copy/move decision point, not just one wrapper. Test both clipboard copy and cut and assert original bytes survive every refusal.

### N07 — Archives created by WebTun may be impossible to extract in WebTun [P2]

- **Source:** creation caps at `lib/server/files.js:113-114`; extraction at `236-240`; reader default at `lib/zip-read.js:163-164`.
- **Observed (R09):** a tiny folder with 1,001 empty files creates a ZIP with 1,002 entries, including its root. The app's own extractor rejects it with 413 at 1,000 entries.
- **Repair/test:** align supported creation/extraction limits or warn before generating an unsupported archive. Add a boundary round-trip test; do not remove archive limits wholesale.

### N08 — Symlink properties report the resolved target as the selected file [P2]

- **Source:** `lib/server/files.js:1048-1060,1095-1097,1111-1119`; properties UI at `public/js/files.js:1571-1586`.
- **Observed (R10):** `realPath()` runs before `lstat()`, so a selected link reports `isSymlink:false`, the target's path, and target size. The supposed “do not follow symlink” size branch is ineffective for an existing link.
- **Impact:** wrong Type/Path/link metadata; the UI may offer target chmod while claiming links should not be editable that way.
- **Repair/test:** retain the selected lexical path for link metadata and use separately validated target metadata when needed. Test links to files/directories and broken links.

### N09 — Lock-screen teardown leaves editors owned by vanished tabs [P1]

- **Source:** `public/js/ui.js:1045-1057` removes wrappers but does not run `releaseFileTabResources()`; normal close does at `public/js/tabs.js:1400-1403`; ownership check at `public/js/editor-buffers.js:16-17`.
- **Observed (R11):** a file tab disappears from `tabs`, but its buffer remains owned by `tab:1`. Opening that path in a new surface throws “This file already has an editor.”
- **Impact:** sign-out/revocation then re-login can leave a file unreopenable without a full page reload. Pending editor/preview work is not marked closed either.
- **Repair/test:** use a unified, draft-preserving file-tab teardown and mark tabs closed before removing DOM. Test dirty drafts and delayed opens/saves across lock/re-login; do not blindly reuse normal close's explicit-discard behavior.

### N10 — App-preview IP leases outlive the authenticated session [P1]

- **Source:** `server.js:1083-1135,1371-1382,1443-1459`.
- **Observed (R12):** after a dummy active session records an IP/port lease, a tokenless same-IP request with subresource/CORS headers still passes the guard after that session is invalidated. Lease lifetime is one hour; the record contains no session identity.
- **Boundary:** an unapproved/revoked caller sharing the owner-visible IP gains access to that previously previewed port. Header hints are not credentials. Real proxy/NAT deployment reachability was not tested; the local guard behavior was.
- **Scope:** this establishes a **preview-specific** authorization gap, not arbitrary direct terminal/File API access or general SSRF. Explicit preview port defaults remain intentional.
- **Repair/test:** use a revocable, port-scoped capability bound to its issuing session and avoid IP-only grants. Test two dummy principals behind one address, session revocation, PIN rotation, and a previously authorized preview port.

### N11 — Closing an older in-memory terminal attachment breaks the newer one [P1]

- **Source:** `lib/server/terminal.js:754-763,884-893,968-981`.
- **Observed (R13):** two fake-PTY sockets attach to the same session; closing the older one removes all data listeners. The newer socket still writes to the PTY but receives no output.
- **Impact:** reconnect overlap or two devices using the same no-tmux session can produce a silent live terminal. Session persistence does not imply robust concurrent attachment.
- **Repair/test:** dispose listeners belonging to each connection only; either multiplex supported attachments or explicitly reject/detach an old owner. Make cleanup idempotent for error + close events.

### N12 — Process exit is treated as recoverable disconnect [P2]

- **Source:** tombstone comment/store at `lib/server/terminal.js:864-871`, replacement at `754-772`; client exit handling at `public/js/terminal.js:501,611-665`.
- **Observed (R14):** a normally exited fake-PTY session ID starts a fresh PTY when reconnected. Client exit handling paints a badge but does not stop its retry policy.
- **Impact:** an intentional `exit` can lead back to another shell instead of a stable “process ended” state. This is separate from the correctly tested fresh recovery after EBADF.
- **Repair/test:** explicitly distinguish exit, native-descriptor failure, and network loss. If respawn is the intended product behavior, document it; otherwise require Restart for normal exit and preserve EBADF recovery.

### N13 — Renaming a directory does not migrate open descendant editors [P1]

- **Source:** `public/js/files.js:1728-1747`, `public/js/editor-buffers.js:145-156` only update exact paths.
- **Observed (R16):** a filesystem directory rename succeeds, but the buffer for `folder/open.txt` still points at the missing old directory. Descendant tab titles/state/draft keys are not remapped.
- **Repair/test:** enumerate affected descendant surfaces before rename, reject saving/conflicting buffers, and migrate the whole path prefix after success. Cover panel + tabs + drafts + selected directory; keep this separate from B14's occupied-file destination case.

### N14 — Delayed preview renders can overwrite newer previews [P2]

- **Source:** `public/js/file-tabs.js:729-819`; analogous panel awaits at `public/js/viewers.js:1198-1323,1326-1386`.
- **Observed (R17):** start preview A, edit and start preview B, resolve B's token first, then A's token. The older rendering replaces the newer one. There is no generation/revision guard after those awaits.
- **Impact:** displayed HTML/Markdown may be stale even though editor content is correct. The isolated check does not show disk corruption.
- **Repair/test:** capture buffer/path/revision and preview generation; verify them after every awaited library/token operation and before DOM/blob updates, including close/switch events.

### N15 — `.env` can override an explicit preview allow-list [P1]

- **Source:** `server.js:21,27-31,1140-1148`.
- **Observed (R18):** with environment `PREVIEW_PORTS=5173`, loading a fixture `.env` containing `PREVIEW_PORTS=*` replaces that restriction. Other explicit environment values win over the file.
- **Impact:** deployment policy differs from normal environment precedence; a stale file can widen the allow-list without changing the supplied runtime environment.
- **Repair/test:** make precedence uniform, or define/document a separate explicit override mechanism. Test environment vs repo-local vs data-dir settings. Unset/all-ports behavior is not itself a finding.

### N16 — Git-401 sign-out candidate rejected as a current UI defect

R19 confirmed that `gitErrStatus()` maps remote authentication failures to 401 (`lib/server/errors.js:56-60`), while `api()` treats 401 as WebTun sign-out. **However**, current push/pull/fetch use their own raw-fetch handling (`public/js/git.js:434-469`). The current UI path avoids the supposed automatic sign-out. Keep this as an API-status contract consideration if those callers are centralized later; it is **not counted as a confirmed user-facing bug**.

### N17 — The optional PTY fallback does not propagate resizes [P2]

- **Source:** `lib/pty-fallback.js:101-104`; the bridge's only `TIOCSWINSZ` is initialization at `lib/pty-bridge.py:26-29`.
- **Observed (R20):** mocked child execution shows `resize(120,40)` changing only JavaScript fields; nothing is sent to the child. No bridge resize protocol exists in source.
- **Impact:** fallback TUIs continue using initial terminal dimensions. The pipe-only path also does not provide normal PTY semantics; do not advertise parity with node-pty.
- **Repair/test:** add a separate bridge control channel for window-size changes, or label reduced functionality clearly. Validate `stty size`/a bounded TUI in a disposable PTY environment before claiming full support.

### N18 — Download responses advertise ranges but do not implement them [P2]

- **Source:** `lib/server/files.js:891-906`.
- **Observed (R21):** request `Range: bytes=2-4` for a ten-byte fixture; response advertises `Accept-Ranges: bytes` but returns 200 and all ten bytes.
- **Impact:** no resume/partial-transfer implementation despite the header. Normal full downloads still work.
- **Repair/test:** either stop advertising support or implement validated 206/416 behavior and bounded range streams; cover suffix, invalid, and out-of-bounds ranges.

### N19 — Folder upload structure is lost by multipart parsing [P1]

- **Source:** client sends a relative filename at `public/js/transfers.js:241-280`; server parses it at `lib/server/files.js:967-988`, but constructs Multer without `preservePath` at line 994.
- **Observed (R22):** filename `folder/sub/nested.txt` is stored as root-level `nested.txt`. Multer/Busboy defaults discard the prefix before `uploadRelPath()` sees it.
- **Impact:** dragged folders flatten; files from different directories collide/are renamed. Client pre-mkdir may leave empty folders, not restore placement.
- **Repair/test:** use an explicit relative-path field or enable path preservation **with the existing sanitization/real-containment checks retained**. Test duplicate basenames in two subdirectories, Unicode names, traversal attempts, and the depth limit.

### N20 — Fast upload batches exceed their own shared request budget [P2]

- **Source:** general 20-per-10-second limiter at `server.js:69-101`; upload/mkdir guards at `lib/server/files.js:642,950`; one XHR per file at `public/js/transfers.js:275-345`.
- **Observed (R23):** the actual limiter rejects the 21st same-IP request in a window. The upload loop counts non-2xx as failures and proceeds without 429 retry/backoff; pre-mkdir calls can also spend the budget.
- **Condition:** enough small files complete within ten seconds, especially on LAN. This is not a claim that every upload batch fails.
- **Repair/test:** batch legitimate upload work or retry 429 with `Retry-After` while preserving cancellation and job identity. Test with the **real** limiter; the current service fixture substitutes a pass-through limiter.

### N21 — Legacy license migration does not refresh the loaded license cache [P2]

- **Source:** `server.js:319` initializes licensing before `startServer()` calls migration at `1551`; migration includes `license.json` at `268-272`; load/cache behavior at `lib/license.js:55-60,103-117,140-150`.
- **Observed (R26):** initialize with an empty destination, copy in a valid dummy signed key, then query status: still Free. Explicit `loadLicense()` changes it to Pro.
- **Impact:** the first migrated boot can enforce Free limits until restart/manual activation, even though the key was copied successfully.
- **Repair/test:** refresh licensing after migration, before request-serving. Add an actual bootstrap migration fixture, not just an ordinary key-activation test.

### N22 — Directory-merge rollback is not complete [P1]

- **Source:** `lib/server/files.js:529-572`.
- **Observed (R27):** overwrite an existing nested file and introduce a new nested file; inject a later copy failure. Restoration copies backup content over the directory, restoring the old file but leaving the new descendant in place.
- **Additional limit:** backup errors are ignored at `552-557`, so some overwritten entries have no recoverable backup at all. The source comment itself acknowledges this exception.
- **Repair/test:** refuse to mutate an entry without a successful backup and restore the whole affected subtree, including removal of newly introduced descendants. Test backup failure, later-copy failure, and rollback failure. Do not claim full transactional rollback until those invariants hold.

### N23 — HMR WebSocket forwarding retains the WebTun bearer [P1]

- **Source:** `server.js:1472-1475,1490-1501`; HTTP has separate token filtering at `1199-1222`.
- **Observed (R28):** a stubbed valid upgrade for `/api/preview/5173/hmr?token=dummy-session-token&app=fixture` constructs that same token-bearing upstream WebSocket URL.
- **Boundary/impact:** the lower-trust dev app receives the WebTun credential, potentially including it in its request logs. Actual exfiltration, hostile deployment, and external access were not tested. This is distinct from intentionally using query credentials for the **browser-to-WebTun** hop.
- **Repair/test:** reuse credential-aware query filtering for WebSocket targets, preserving tokens genuinely belonging to the upstream app. Assert the dummy WebTun bearer never reaches the upstream request.

### N24 — JSON app-preview requests reach the upstream without their body [P1]

- **Source:** the global JSON parser runs at `server.js:201-207`; preview eventually calls `req.pipe(upReq)` at `1361`.
- **Observed (R29):** the composed app forwards a dummy JSON POST to a disposable loopback upstream; the upstream receives an empty body instead of `{"message":"dummy"}`.
- **Impact:** applications can render in preview while their JSON API/form actions fail. Express consumed the incoming stream before proxying it.
- **Repair/test:** register authenticated proxy routes before application JSON parsing, or correctly reserialize supported parsed bodies and headers. Cover JSON, binary/multipart, form-urlencoded, and streamed requests; do not lose raw webhook signature handling when changing middleware order.

### N25 — Creating a Git branch passes the create argument incorrectly [P1]

- **Source:** `lib/server/git.js:384-390` passes `['switch','-c','--',branch]`.
- **Observed (R30):** with a committed dummy repository and valid `feature-fixture` name, branch creation returns 400: `fatal: invalid reference: feature-fixture`. `-c` consumes the following `--` as its argument; the requested branch is interpreted as a starting reference.
- **Repair/test:** pass the validated branch name directly as the argument to `-c`; use end-of-options only in a position compatible with Git's syntax. Cover creation from a committed repository, duplicates, invalid names, and checkout of the resulting branch.

### N26 — Git status does not decode octal-quoted Unicode filenames [P1]

- **Source:** `lib/server/git.js:42-46,104-134,146`; Git's quoted output is not JSON when it contains octal escapes.
- **Observed (R31):** a real dummy file named `报告.txt` appears as literal `\346\212\245\345\221\212.txt`. Staging that status-supplied path returns 500 because no such literal filename exists.
- **Impact:** Unicode filenames can be displayed incorrectly and cannot be operated on through the panel under Git's default quoting configuration. This is independent of Unicode file-content support.
- **Repair/test:** prefer NUL-delimited porcelain/numstat parsing, with explicit rename handling, rather than JSON decoding Git C-style escapes. Cover Unicode, tabs/newlines, quotes, and rename pairs. Setting `core.quotepath=false` alone does not solve all special filenames.

**Additional-pass outcome:** 25 actionable defects (N01–N26 excluding the rejected N16), supplementing the 10 retained original findings. Totals: **35 actionable findings — P0: 2, P1: 17, P2: 16**. Cleanup notes and the backlog/validation items below are not included in that count.

---

## 5. Additional Feature Gaps and Validation Needs

These are not all bugs and are not counted as confirmed vulnerabilities. Several are product decisions or incomplete workflows; treat them differently from a broken implemented action.

| ID | Gap | Source / practical next step |
|---|---|---|
| G01 | **Team capabilities are advertised beyond what was found in the shipped implementation.** | `public/docs.html:787` lists shared libraries, audit export, and policy UI. `lib/license.js:155-161` adjusts seats/limits; snippets are browser-local (`public/js/misc.js:250-267`). No corresponding Team sharing/audit/policy route/control was found in the reviewed shipped surface. Implement the promises or label them planned; a pricing label alone is not a feature. |
| G02 | **Paid self-service UI is partial.** | `public/js/security.js:578-592` starts only Pro checkout and supplies no annual/seats selection. No renewal-list/claim UI calls were found, despite `server.js:454-470` exposing those routes and comments telling the admin to paste from Settings. Repair N01–N03 first, then add the complete purchase/renewal flow. |
| G03 | **Workspace configuration is not the frontend's initial location.** | Production `/api/home` returns `os.homedir()` (`server.js:540-542`); `unlockApp()` uses it (`public/js/core.js:514-541`). For a different confined `WORKSPACE_ROOT`, the first explorer request can be refused, and the configured root is not returned there. Expose workspace/default-directory metadata. The test helper returns the workspace as `home`, masking this difference (`tests/helpers/workspace-server.js:62`). |
| G04 | **Data Saver does not consistently gate the launchpad's system pulse.** | `public/js/settings.js:107-116` stops header/stats-panel timers, but `public/js/launchpad.js:121-150` calls `fetchSystemStats()` while shown without checking Data Saver or document visibility. Test the actual promised scope and use the shared helper without restarting forbidden polls. |
| G05 | **Preview Back/Forward conflicts with opaque-origin isolation.** | `public/js/preview.js:89,113-114` omits `allow-same-origin` but accesses `iframe.contentWindow.history`, swallowing access errors. Browser validation is still needed in this pass; design a frame-side `postMessage` history command rather than weakening isolation. |
| G06 | **Advanced Git lifecycle is incomplete.** | No explicit merge/abort/continue, branch deletion, blame, or full-history pagination in `lib/server/git.js` / `public/js/git.js`. Per-hunk **unstage is already implemented** and is not a gap. Prioritize only workflows the product intends to support. |
| G07 | **SSE log tail does not fully handle rotation/truncation.** | `lib/server/files.js:1444-1462` compares only sizes; truncation updates `lastSize` without emitting a reset, and same-size replacement is invisible. Decide whether a live viewer must signal/reset on file identity change; add rotation fixtures before advertising robust log following. |
| G08 | **Optional native/OS paths need direct validation.** | Existing browser projects are Chromium desktop + Pixel emulation (`playwright.config.js:13-16`). Core regressions run in the Linux verify job; Windows/Linux desktop boot smoke checks liveness, not interactive terminal/viewer behavior (`.github/workflows/build.yml:314-374`). Add real Windows/macOS native-PTY tests and WebKit/physical-device checks for claimed compatibility. |
| G09 | **Desktop update/status and duplicate wiring need review.** | `electron/main.js:23-33,330-339` requests the single-instance lock/registers handlers twice. At `77-82`, an `updateInfo.version` is described as “update available” without comparing versions. No packaged Electron run was performed here; validate up-to-date, unavailable/portable, downloaded, and failed-feed states before calling these confirmed UX failures. |

### Source-grounded risks still needing separate bounded validation

- **Managed SSH PID ownership:** `lib/ssh-setup.js:438-442,521-530` signals a persisted PID without the tunnel service's process-start identity checks. A stale/recycled PID is a plausible wrong-process cleanup case, but no unrelated process was signalled in this review. Validate with mocked PID identity/kill operations and persist/verifiably match ownership before cleanup.
- **Malformed ZIP stream failure propagation:** `lib/zip-read.js:228-233` handles raw/inflate errors by closing a handle but does not explicitly forward them to the returned validation stream. Test a tiny corrupt deflate entry in a disposable subprocess and assert extraction rejects promptly without hanging or affecting the host. No crash claim is made here.
- **Regex deadline is cooperative, not preemptive:** `lib/server/files.js:1253-1265,1307-1309` checks a deadline around synchronous regex matching; it cannot interrupt one expensive `exec()`. Validate accepted patterns in a tightly bounded worker, not against a running/shared server. The existing nested-quantifier guard is implemented; do not re-file the historical “guard does nothing” finding.

### Documentation contracts to reconcile

1. `public/docs.html:619` says the preview cookie is port-scoped, but `server.js:1232` uses the shared path `/api/preview/`; actual authorization must not be inferred from the comment.
2. `public/docs.html:772` says PIN changes need another trusted session; `lib/server/auth.js:511-538` deliberately allows older/sole/first-setup trusted cases immediately. Correct the wording, not the intentional trust model.
3. The SSH “kill switch” wording at `public/docs.html:750` should explain that installed keys are deliberately retained and system sshd can remain available (`lib/ssh-setup.js:549-554`). Turning off provisioning is not universal key revocation.
4. The `.env` example at `public/docs.html:537` places an inline `#` comment after the PIN, while `server.js:17-21` keeps inline comments in the value. Make copyable examples match the loader.
5. “Atomic 0600 persistence everywhere” is too broad: session labels use a direct write (`lib/server/terminal.js:183-189`), and ordinary editor writes are direct (`lib/server/files.js:796-797`). Atomic state persistence should not be confused with crash-safe document saves.

---

## 6. Logic Verdict — Good, Okay, and Bad

### GOOD — preserve these primitives

- **Editor document ownership and save serialization:** buffers, revision checks, draft flushing, and explicit surface handover are coherent; eleven frontend buffer tests passed (`tests/editor-buffers.test.js`). Integration callers, not the core idea, need repair.
- **PIN approval and persist-before-rotation:** pending devices are denied sensitive actions, timers deny by default, and failed persistence keeps existing sessions valid (`lib/server/auth.js:195-222,277-306,449-481`). Real API regressions cover these paths.
- **Bounded retry policies:** the standalone retry module is injectable/tested and stops on auth/policy rejection. Extend its inputs to distinguish normal shell exit; do not restore unbounded retries.
- **Archive resource limits and staged extraction:** byte/count bounds, CRC/size checks, safe entry names, and temporary extraction protect useful invariants. Align limits and test failure propagation rather than discarding the safety model.
- **Server service composition:** auth, files, Git, terminal, and tunnels have explicit dependencies. The fake-PTY fixtures can exercise real routes without touching real sessions.
- **Terminal back-pressure and tunnel retry backoff:** pausing buffered PTY output and bounding restart attempts are sensible mechanisms. They are not evidence that all proxy buffers/queues are bounded.
- **Distribution safeguards:** source/version checks, browser regressions, native/asar gates, artifact smoke checks, checksums, and SBOM generation are meaningful CI work. Their presence is not proof that current remote CI runs or packages passed.

### OKAY — explicit tradeoffs or useful but incomplete logic

- **Vanilla shared-global frontend:** consistent with this repository's no-bundler architecture and demonstrably testable through VM/module/browser fixtures. Improve explicit contracts and `no-undef` checks; a rewrite/bundler is not required to fix these defects.
- **In-memory auth/state and shared `DATA_DIR`:** suitable for the documented single-owner model; restarting loses sessions, and multiple instances can last-write-win on shared files. These are deployment constraints, not multi-tenant isolation promises.
- **Polling-based watchers/stats:** simple and understandable, but gating, in-flight deduplication, lock-screen cleanup, and rotation behavior need consistency.
- **Limited document formats:** STORE ZIP output, no ZIP64/encryption, capped XLSX rendering, and single-live heavy viewers are defensible resource tradeoffs when documented.
- **Comment-led contracts:** explanations are valuable, but tests should check them. Claims about complete rollback, exit tombstones, sibling-safe SSH cleanup, and credential filtering are not uniformly enforced.

### BAD — demonstrated broken integration logic

- Producers and consumers disagree about claim IDs and entitlement fields.
- Shared copy/move helpers depend on wrappers for destructive-operation invariants, so an alternate route can delete its own source.
- Multipart parsing discards the relative filenames the folder-upload design relies on.
- A global body parser consumes data a later streaming proxy expects to forward.
- Session revocation does not revoke IP-only preview grants; HTTP and HMR credential filtering diverge.
- UI teardown and filesystem rename do not consistently update/release the shared document ownership model.
- Reattachment removes another socket's listeners, and preview completions lack revision/generation guards.
- Git branch argv placement and filename decoding are not covered by the happy-path Git regression.

---

## 7. Revised Area Ratings

Scores reflect the reviewed implementation and evidence, not feature-count averages or guarantees about untested platforms.

| Area | Score / 10 | Main reason |
|---|---|---|
| Terminal / persistence | 8 | Strong protocol and recovery primitives; simultaneous attachment/exit/fallback gaps. |
| PIN/auth service | 8.5 | Approval and rotation behavior tested; separate preview leases weaken whole-product consistency. |
| File operations / archives | 7 | Broad and guarded, but destructive alternate-route and rollback defects. |
| Git | 7.5 | Rich useful panel; branch creation and Unicode paths fail targeted fixtures. |
| Tunnels | 8.5 | Persistence, retry/backoff, discovery and download controls; real tunnel execution not tested. |
| SSH | 6.5 | Thoughtful lifecycle/UX, but tested key export fails a primary advertised client. |
| App preview | 6.5 | Rendering isolation is good; body transport, HMR filtering, and revocation are incomplete. |
| Editors / viewers | 8 | Strong buffer store and watcher; render-order/rename/lock/download integration gaps. |
| Offline license verification | 8.5 | Signed-key checks and grace/caps are coherent; legacy-cache order is wrong. |
| Checkout / renewal billing | 3 | Not end-to-end correct; repair before offering paid self-service. |
| System, settings, notifications | 7.5 | Broad functionality; polling/lock/audio/fallback cleanup gaps. |
| Frontend maintainability | 7 | Feature organization is clear; implicit globals and cross-feature lifecycle duplication remain. |
| Tests / CI design | 7.5 | Existing 28 tests pass, with substantial browser and packaging gates; missing integration boundaries matter. |
| Documentation accuracy | 6.5 | Rich guide, but advertised behavior/features need reconciliation. |

**Overall: 7.5 / 10.** Good core engineering does not make the billing flow, fallback PTY, or advanced file operations uniformly correct.

---

## 8. Verification Evidence and Coverage Limits

### Existing checks executed

`npm test` was run against a filtered disposable source snapshot with existing dependencies mounted read-only. Results:

- Version/manifest/lockfile check: **passed**. The repository tag was separately inspected as `v2.3.5`.
- Source check: **61 files parse**; combined declarations and precache checks passed.
- Node regressions: **28 passed, 0 failed**, including real auth/files/Git APIs, bootstrap, frontend buffers/retry policy, and fake-PTY recovery.
- Server import smoke: **passed**.
- `npm run test:e2e`: **not executed in this re-review**. Browser test source was inspected; no new real-browser, WebKit, native installer, or physical-device success claim is made.

The initial sandbox attempt used `--jitless`, which disables WebAssembly required by Node fetch and caused fixture failures. Re-running with WebAssembly enabled and its large address-space reservation disabled passed all 28 tests. Those initial failures were harness configuration effects, not application regressions.

### Targeted local checks

The following **31 bounded checks completed**. Several evaluated the actual function source with controlled DOM/network mocks; these establish logic behavior, not complete browser integration. No real Stripe payment, Cloudflare download/tunnel, SSH daemon installation, or unrelated process termination was performed.

| Check | Method / observed result | Finding |
|---|---|---|
| R01 | Invoke actual registered viewer action; `ReferenceError` before download. | B1 |
| R02 | Actual history parser with complete/split Up-arrow; `ls` becomes `lsA`. | B5 |
| R03 | Mock video/canvas enable/release twice; one persistent timer, one reused video. | B3 correction |
| R04 | Real pending-license module with checkout/renewal dummy IDs; both rejected. | N01 |
| R05 | Actual webhook function with fake mint/store/signature dependency; wrong annual/Team outputs and duplicate renewal entry. | N02, N03 |
| R06 | Actual key-generation/export path; local OpenSSH reader rejects a dummy key. | N04 |
| R07 | Real batch-copy route; conflict counted successful without changing bytes. | N05 |
| R08 | Real server clipboard/paste routes; a disposable self-paste source is removed. | N06 |
| R09 | Real ZIP create/extract routes with 1,001 tiny files; own archive rejected. | N07 |
| R10 | Real stat/size routes on a disposable symlink; target reported instead of link. | N08 |
| R11 | Actual lock-screen function with controlled DOM plus real buffer store; vanished tab retains ownership. | N09 |
| R12 | Actual preview guard with two dummy principals sharing an IP; tokenless access after session invalidation. | N10 |
| R13 | Real WebSocket service, fake PTY, overlapping attachments; newer output disappears on older close. | N11 |
| R14 | Fake-PTY normal exit then reconnect; a new PTY is spawned under the old ID. | N12 |
| R15 | Actual panel Markdown renderer with failed mint and dummy bearer; main DOM includes fallback URL. | B2 narrowing |
| R16 | Real directory rename plus actual buffer store; descendant path is not migrated. | N13 |
| R17 | Actual tab-preview function, deferred token responses resolved newest-first; older render wins last. | N14 |
| R18 | Actual env loader with safe fixture; file overrides explicit `PREVIEW_PORTS`. | N15 |
| R19 | Git-status helper maps remote auth to 401, **but current remote-operation UI avoids generic `api()`**. | N16 rejected UI claim |
| R20 | Actual fallback implementation with mocked child; resize sends no child control message. | N17 |
| R21 | Real download endpoint with a small Range request; 200/full body despite range header. | N18 |
| R22 | Real multipart upload with nested filename; file stored at root. | N19 |
| R23 | Actual general limiter, 21 controlled requests; last gets 429, cross-checked against upload loop. | N20 |
| R24 | Actual upload function with two fake XHRs; cancelling A aborts B. | B10 |
| R25 | Real rename route and actual client/buffer logic; occupied destination leaves disk/editor paths inconsistent. | B14 |
| R26 | Dummy signed-license migration ordering; cache stays Free until explicit reload. | N21 |
| R27 | Actual merge helper, tiny directories, injected later I/O failure; new descendant survives rollback. | N22 |
| R28 | Actual upgrade dispatcher with fake upstream; constructed HMR URL retains dummy bearer. | N23 |
| R29 | Composed application + disposable loopback upstream; JSON POST arrives empty. | N24 |
| R30 | Real Git routes/repository, valid branch name after commit; creation returns 400 invalid reference. | N25 |
| R31 | Real Git status/stage on `报告.txt`; octal spelling cannot be staged. | N26 |

### Execution safety / reproducibility

- Host scratch base: `/teamspace/studios/this_studio/opencode-studio/.opencode-local/tmp/opencode/`.
- Isolation: Bubblewrap user/process/network namespaces; **no external network**, private loopback only; filtered source and toolchain read-only; no host home, ambient secrets, runtime state, or shared sockets exposed.
- Writable application space: private **64 MiB** scratch tmpfs. Limits: **4 GiB virtual address space per process**, **256 MiB V8 old-space**, **96 processes**, **192 file descriptors**, **16 MiB per output file**, **60-second CPU limit**, **100-second wall-clock limit** per run. These are resource ceilings, not measured usage.
- Environment launched empty with explicit safe values: `PATH=/toolchain/bin:/usr/bin:/bin`, `HOME=/scratch/home`, `TMPDIR=/scratch/tmp`, `XDG_CONFIG_HOME=/scratch/config`, `XDG_CACHE_HOME=/scratch/cache`, `npm_config_cache=/scratch/cache/npm`, `NODE_OPTIONS="--max-old-space-size=256 --disable-wasm-trap-handler"`, `GIT_CONFIG_NOSYSTEM=1`, and dummy Git author/committer `Review Fixture <review@example.invalid>`. A synthetic passwd/group fixture was supplied for the local SSH reader.
- Dummy checkout/invoice IDs, tokens, files, and keys were used. HTTP routes were either evaluated with controlled dependencies or served only inside the private namespace. PTYs in service tests were fake.
- The temporary review harness/snapshot was not added to the repository. The `Rxx` table records the fixture scenario and its regression expectation; any production regression additions should use the same isolation and fake-service patterns.

### What the green suite does not establish

The helper replaces auth/general limiters with pass-through middleware, returns a workspace-specific `/api/home`, and stubs history/license/system endpoints (`tests/helpers/workspace-server.js:30-35,59-70`). It does not compose production billing/preview/SSH routes. Browser configuration blocks service workers (`playwright.config.js:11`). Thus it cannot by itself prove rate-limit compatibility, production startup location, Stripe renewals, proxy body transport, SSH export interoperability, or service-worker lifecycle correctness.

Historical audit findings were not used as an open backlog. Current source and relevant Git history were checked; intentional open-PIN/full-filesystem/query-token/loopback-license decisions are not proposed for removal. This remains a feature/correctness re-review with focused security reasoning, **not an exhaustive new penetration test or a claim that all vulnerabilities were found**.

---

## 9. Recommended Repair Order

1. **P0 — prevent data loss and unblock claims:** N06 common copy/move invariants; N01 claim contracts. Add source-survival and repeat-claim tests first.
2. **P1 — make paid flows honest:** N02/N03 entitlement/idempotency; N04 OpenSSH-compatible key export; G01/G02 commercial promises and missing controls. Validate with dummy/test fixtures before enabling real billing.
3. **P1 — repair preview boundaries/transport:** N10 session-bound preview capabilities; N23 upstream WS filtering; N24 request-body forwarding. Exercise the composed app, not only service stubs.
4. **P1 — repair state/file integrity:** B14, N09, N13, N22; test occupied destinations, directory descendants, lock/re-login, and failed rollback.
5. **P1 — repair common interactions:** B1 toolbar download, B10 upload cancellation, N19 folder upload, N11 reattachment, N15 config precedence, N25/N26 Git creation/filename handling.
6. **P2 — align remaining lifecycle/contracts:** B2–B6, B11/B12; N05/N07/N08/N12/N14/N17/N18/N20/N21. Add boundary fixtures rather than relying on comments.
7. **Coverage — strengthen existing checks, not a mandatory rewrite:** add frontend `no-undef` with declared shared globals; preserve service/unit tests; add composed billing/proxy/limiter and critical browser action tests. Add physical/native coverage only for supported environments.
8. **Last — P3 cleanup and UI polish:** B8/B9/B13, duplicate helpers/wiring, and precise documentation. Use a focused frontend hardening/clarification pass for repaired interactions, followed by a final polish pass; do not redesign the product to solve logic bugs.

**Final verdict:** the architecture is mostly **good**, documented constraints and incomplete secondary workflows are **okay when explicit**, and the demonstrated contract/data-loss/control failures are **bad implementation logic that needs repair**. The core is worth preserving; the defects call for targeted invariants and regression coverage, not an indiscriminate rewrite.

---

## 10. Implementation Pass — All Actionable Findings Addressed (2026-10-14)

Every retained B finding (B1–B6, B8–B14; B7 was withdrawn), every N defect (N01–N15, N17–N26; N16 was rejected as a current UI defect), and every G gap (G01–G09) is fixed below. Intentional decisions from `AGENTS.md` were not changed.

### B fixes (original pass)

| ID | Fix | Test |
|---|---|---|
| B1 | `download-file` resolves docked file-tab path → `panelState.path` → `_pdf/_epub/_officePath` with empty-state toast (`public/js/files.js:2262`). No more `editorPath` ReferenceError. | `remediation.spec.js` toolbar download dispatch (PDF/EPUB/Office) |
| B2 | Panel Markdown fails closed: `mintPreviewFileToken` throw propagates to catch → `textContent` unavailable message; `toPreviewApiUrl` never falls back to session token (`public/js/viewers.js:1073-1097,1334-1399`). | `client-contracts.test.js` panel Markdown fail-closed |
| B3 | Wake-lock fallback retains timer/track/video handles and fully releases them (`cleanupWakeVideo`, generation guard) (`public/js/settings.js:906-994`). | `client-contracts.test.js` wake-lock release |
| B4 | Centralized lock teardown: closes overlays/drawers/dialogs, stops stats/session/git/finder polls, releases wake lock, marks tabs closed, releases file owners draft-preserving, clears PIN without clobbering typed input on late 401 (`public/js/ui.js:1034-1084`, `core.js:api`). | `remediation.spec.js` lock teardown + `client-contracts.test.js` lock ownership |
| B5 | History parser replaced with cross-chunk state machine (`trackInput` in `terminal-connection.js`, wired in `terminal.js:201-202`). Handles CSI/SS3/OSC/DCS split across chunks incl. Unicode. | `terminal.test.js` parser + browser history behavior preserved |
| B6 | Notification audio closes its `AudioContext` on oscillator end, handles `resume()` rejection (`public/js/ui.js:346-386`). | Manual + existing notification tests; no leaked-context assertion in unit (browser resource) |
| B8 | Removed `URL.revokeObjectURL(URL.createObjectURL(b))` no-op. | `npm run check` + image viewer flows |
| B9 | Removed empty `_sysVisibilityHandler`; hidden-page guard lives at poll call sites. | `npm run check` |
| B10 | Upload cancellation is job-local (`cancelled`/`currentXhr`/`waitTimer` per `uploadFileList`); removed global `_currentUploadXhr`/`_uploadCancelled` clobber; captures destination path per job; 429 retries with `Retry-After` (`public/js/transfers.js:224-360`). | `client-contracts.test.js` isolated cancellation + 429 retry; `remediation.spec.js` upload flows |
| B11 | Shared swipe-reset for `touchend`/`touchcancel`/multi-touch; styles/state always restored (`public/js/tabs.js:759-803`). | `remediation.spec.js` synthesized swipe-cancel |
| B12 | Single pinch policy (10–28px, transient, never persists to saved settings); removed duplicate wrapper handler; added `touchcancel` reset (`public/js/terminal.js`). | Browser terminal touch specs (existing, still passing) |
| B13 | Removed `console.log('EPUB fetch OK'…)`. | `npm run check` |
| B14 | Rename preflight via `editorBuffers.beginRename/checkRename` before disk op; server returns 409 on occupied destination; client remaps descendants/drafts/currentPath and reconciles on failure (`public/js/files.js`, `editor-buffers.js`, `lib/server/files.js`). | `file-contracts.test.js` occupied rename + `editor-buffers.test.js` folder transaction |

### N fixes (additional pass)

| ID | Fix | Test |
|---|---|---|
| N01 | Shared `validClaim` (`cs_test/live_*`, `renew_*`, 32-hex) enforced on store; `claimPending(id, apply)` consumes exactly once with claimed tombstone; checkout claim returns 410 after claim (`lib/license.js`, `lib/server/billing.js`). | `billing.test.js` one-time claim + replay |
| N02 | Entitlements derived from verified Stripe subscription/invoice price IDs, quantities, and period ends (monthly/yearly × Pro/Team); checkout carries term/seats/quantity (`lib/server/billing.js`). | `billing.test.js` 4-combination entitlements + checkout params |
| N03 | Idempotency via persisted claim/resource identity: duplicate checkout/invoice events reuse one record; claimed keys never resurrected; renewal activation guarded against downgrade (`lib/server/billing.js`, `lib/license.js`). | `billing.test.js` duplicate invoice + downgrade guard |
| N04 | Native Ed25519 export emits OpenSSH `openssh-key-v1` PEM (PKCS#8 DER converted); documented temp-file fallback scope (`lib/ssh.js`). | `platform-contracts.test.js` + `file-contracts`-adjacent OpenSSH round-trip (`ssh-keygen -y`) |
| N05 | `resolveCopyMove` returns `{success:false, conflict:true}` for unresolved conflicts; batch totals computed from `success` (`lib/server/files.js`). | `file-contracts.test.js` conflict not counted |
| N06 | Destructive invariants moved into shared `resolveCopyMove` (identical-path + inside-source + symlinked-destination containment via ancestor-aware `realPath`); clipboard cut retries only unmoved items (`lib/server/files.js`, `paths.js`). | `file-contracts.test.js` self-paste + descendant/symlink cases |
| N07 | Creation and extraction caps aligned to 50,000 entries (`files.js:56,114`, `zip-read.js:164`); boundary round-trip covered. | `file-contracts.test.js` 1,001-file round-trip |
| N08 | `/api/files/stat` + `/size` default to lexical link metadata (`isSymlink`, `linkTarget`); `?follow=1` used by editor/watcher/size flows that need target bytes (`lib/server/files.js`, `public/js/{editor-panel,file-tabs,files}.js`). | `file-contracts.test.js` link + broken link |
| N09 | Lock teardown uses draft-preserving `releaseFileTabResources`; late 401 never erases typed PIN (`public/js/ui.js`, `core.js`). | `remediation.spec.js` + `client-contracts.test.js` |
| N10 | IP-only leases replaced with revocable port-scoped capabilities (`ptoken` + `/_wt/<cap>` path + HttpOnly cookie) revalidated against issuing session/PIN on every HTTP + WS request; HMR/HTTP strip WebTun bearer, preserve foreign tokens (`lib/server/preview-auth.js`, `server.js`). | `preview.test.js` expiry/revocation/port-scope + scrubbing |
| N11 | Per-connection PTY data/exit subscriptions with idempotent cleanup; older close never strips newer attachment (`lib/server/terminal.js`). | `terminal.test.js` overlapping sockets |
| N12 | Normal exits write non-recoverable tombstones and report `Process exited`; client stops retry policy until explicit Restart; EBADF recovery preserved (`lib/server/terminal.js`, `terminal.js`, `terminal-connection.js`). | `terminal.test.js` tombstone + exit stops retry |
| N13 | `renamePath/beginRename/checkRename` migrate entire descendant prefix + drafts; saving/opening blocked mid-transaction (`public/js/editor-buffers.js`, `files.js`). | `editor-buffers.test.js` folder transaction |
| N14 | Generation + path/buffer/content guards on tab and panel previews after every await (`public/js/file-tabs.js`, `viewers.js`). | `client-contracts.test.js` stale preview |
| N15 | Uniform env precedence: `.env` never overrides explicit environment (removed `PREVIEW_PORTS` exception) (`server.js:21`). | `bootstrap.test.js` explicit `PREVIEW_PORTS=5173` wins over file `*` |
| N17 | PTY fallback resize via dedicated control-pipe (`_control`) + bridge `TIOCSWINSZ` handler + SIGTERM/SIGHUP supervision (`lib/pty-fallback.js`, `pty-bridge.py`). | `test:native` fallback resize (polling, load-tolerant) |
| N18 | Real 206/416 range support with suffix/open-ended/clamped ranges (`downloadRange` in `lib/server/file-operations.js`, wired in `files.js`). | `file-contracts.test.js` range matrix |
| N19 | `preservePath:true` + Latin-1→UTF-8 filename repair + existing sanitization/containment/depth checks (`lib/server/files.js`). | `file-contracts.test.js` nested + Unicode upload |
| N20 | Upload loop honors 429/`Retry-After` (up to 5 attempts, cancellable wait) and no longer spends budget on pre-mkdir (`public/js/transfers.js`). | `client-contracts.test.js` 429 retry |
| N21 | `loadLicense()` after `migrateLegacyState()` before serving (`server.js:1359-1360`). | `billing.test.js` post-migration reload + `bootstrap.test.js` migrated key |
| N22 | `mergeDirs` extracted to `lib/server/file-operations.js`: pre-mutation backups mandatory, full-subtree restore (new descendants removed), rollback failure retains backup and reports recovery path. | `file-contracts.test.js` injected failure |
| N23 | WS upgrade reuses `stripQuery` credential classification; upstream URL never carries WebTun bearer (`server.js`, `preview-auth.js`). | `preview.test.js` HMR scrubbing |
| N24 | Preview routes registered before global JSON parsing (raw stream preserved); verified JSON/form/binary/multipart forwarding incl. `Set-Cookie` port path (`server.js`, `preview.test.js`). | `preview.test.js` composed body forwarding |
| N25 | Branch create uses `switch -c <branch>` (no misplaced `--`) (`lib/server/git.js:379`). | `git-contracts.test.js` create/switch/delete |
| N26 | NUL-delimited `-z` status/numstat parsing with rename-pair handling; no JSON-unquote of octal escapes (`lib/server/git.js`). | `git-contracts.test.js` Unicode/arrow/rename cases |

### G gaps (product completeness)

| ID | Fix |
|---|---|
| G01 | Docs no longer promise unshipped Team sharing/audit/policy UI; Team row lists actual caps + explicit not-shipped note (`public/docs.html:license`). |
| G02 | Full purchase UI: plan/term/seats controls, pop-up-blocked fallback link, renewal list + one-click activate, proper error/busy states (`public/index.html`, `security.js`, `billing-success.html`). |
| G03 | `/api/home` returns `workspace/defaultDirectory/fullFilesystem`; client boots into workspace and validates saved path (`server.js`, `core.js`); helper updated. |
| G04 | Launchpad pulse + header/stats all honor Data Saver + hidden page + locked app (`launchpad.js`, `settings.js`, `misc.js`). Covered by `remediation.spec.js`. |
| G05 | Preview Back/Forward use frame-side `postMessage({wtPreviewHistory})` handler injected with capability-aware fetch/XHR/WS rewrites; no `contentWindow.history` access (`preview.js`, `server.js`). |
| G06 | Server: branch delete, merge, continue/abort, paginated log, bounded blame. Client: workflow controls + confirmations + blame viewer + history pagination (`git.js` server/client, `index.html`, styles). Covered by `git-contracts.test.js` + `remediation.spec.js`. |
| G07 | SSE tail emits `reset` on rotation/truncation/same-size rewrite (dev/ino/birthtime + mtime identity), bounded polls, no overlapping polls (`lib/server/files.js`). Covered by `file-contracts.test.js` SSE test. |
| G08 | `npm run test:native` (node-pty + fallback on Linux/Windows/macOS matrix) + opt-in WebKit mobile project + CI `native`/`webkit` jobs (`scripts/test-native.js`, `tests/native/`, `playwright.config.js`, `pr-check.yml`). Local: native 2/2; WebKit runs in CI (engine not installed here). Physical-device behavior still not claimed. |
| G09 | Removed duplicate single-instance lock block; update status uses `isUpdateAvailable` via `electron/update-status.js` with unit test (`platform-contracts.test.js`). Packaged execution still needs release-machine validation. |

### Risks from §5, now closed or bounded

- Managed SSH PID: never signals persisted PIDs; verifies own child + pid-file match; busy-port fails closed (`lib/ssh-setup.js`).
- ZIP failure propagation: raw/inflate errors destroy the validation stream and release handles (`lib/zip-read.js`); covered by corrupt-deflate test.
- Regex search: accepted patterns run in a terminable worker with timeout (`lib/server/regex-search.js`); pathological pattern stays responsive. Covered by timeout test.
- Docs contracts reconciled: `.env` example uses separate-line comments + absolute `WORKSPACE_ROOT` + precedence note; PIN ceremony wording matches sole/first-setup exceptions; SSH kill-switch notes retained keys; preview docs describe capability + cookie scope; new Reliability section documents atomic-state vs ordinary-save distinction (`public/docs.html`).

### Coverage added

- `tests/file-contracts.test.js`, `tests/billing.test.js`, `tests/preview.test.js`, `tests/git-contracts.test.js`, `tests/client-contracts.test.js`, `tests/platform-contracts.test.js`, `tests/native/pty.test.js`, `tests/browser/remediation.spec.js`, `tests/helpers/client-functions.js`.
- `npm test` (version + source + unit + smoke) is the gate; `test:native` and `test:e2e` run separately. Service-worker lifecycle and live Cloudflare/Stripe/SSH-daemon behavior remain intentionally untested (no external network/credentials in this pass).

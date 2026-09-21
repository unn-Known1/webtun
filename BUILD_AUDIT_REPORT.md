# WebTun — Cross-platform build / packaging audit (v2.2.2)

**Date:** 2026-09-21 · **Scope:** read-only audit — no application code, config,
or workflow was modified. The only change in this working tree is this file.
**Symptom:** the app works via `npm start` but the built Windows `.exe` crashes
on launch.
**Pinned toolchain:** `electron` 44.4.1, `electron-builder` 26.16.1,
`node-pty` 1.1.0, CI Node 24 (which matches Electron 44's bundled Node 24.21 —
that alignment is correct, keep it; pin the exact minor, §5 P1).

### Release assets (authoritative: GitHub API, `v2.2.2`, 6 assets, no checksums/SBOM/attestations published)

| Asset | Size (bytes) | DLs | Scan status in this audit |
|---|---|---|---|
| `WebTun.2.2.2.exe` (portable — no `Setup` infix) | 126,362,909 · sha256 `d247d2ab…95f58f` | 2 | ✅ fully scanned — **broken (§1)** |
| `WebTun.Setup.2.2.2.exe` (NSIS installer) | 126,582,459 · sha256 `b9c852be…5785a0` | 2 | ✅ fully scanned — **broken (§1)** |
| `webtun_2.2.2_amd64.deb` | 100,147,928 · sha256 `e095227f…601c12` | 1 | ✅ fully scanned + headless boot — **broken (§1)** |
| `WebTun-2.2.2.AppImage` | 126,629,935 · sha256 `390f629e…05b4c9` | 0 | ✅ fully scanned — **broken (§1)** |
| `WebTun-2.2.2-arm64.dmg` | 131,351,008 · sha256 `a7049839…7afe00` | 0 | ✅ fully scanned — **broken (§1)** |
| `WebTun-2.2.2-arm64-mac.zip` | 127,378,993 · sha256 `af74a3d0…64d64b` | 1 | ✅ fully scanned — **broken (§1)** |

**All six variants are broken at boot** (same 3 truncated files, §1). Earlier
drafts had only portable+deb scanned; the Setup installer, AppImage, dmg, and
mac zip scans are now complete (2026-09-21 follow-up pass). Broken builds
already reached users (both `.exe` variants and the deb/mac-zip have
downloads) — that sets the urgency in §5 P0.

---

## 1. Root cause (verified): three byte-truncated JS files inside `app.asar`

All six shipped desktop bundles — portable exe, Setup installer, deb,
AppImage, dmg, and mac zip — contain the same three **truncated** files,
byte-identical (md5 `edcdc249…`, `d93502b2…`, `b5f6ace6…` across the four
re-verified variants; same line counts and cut points in all six). The
forked `server.js` dies instantly at boot with a `SyntaxError` in `type-is`
(loaded via `body-parser` ← `express`), exits `1`, and the Electron parent
shows "Failed to start server" and quits — which is exactly "the exe crashes".
`npm start` works because the source tree is intact; only the packaged files
are broken.

| Bundled file | Bundled | Real upstream | Missing | Cut point |
|---|---|---|---|---|
| `node_modules/type-is/index.js` | 252 lines, no trailing newline | 266 lines (`type-is@1.6.18`) | **14 lines** | mid-comment, file ends with `* @` |
| `node_modules/multer/node_modules/media-typer/index.js` | 234 lines | 270 lines (`media-typer@0.3.0`) | **36 lines** | mid-changelog, ends `* Add Goog` |
| `node_modules/multer/node_modules/mime-types/index.js` | 179 lines | 188 lines (`mime-types@2.1.35`) | **9 lines** | mid-statement, ends `exports._extensionConflicts.` |

### Failure chain

1. The packaged app `fork()`s `server.js` (`startServer()`,
   `electron/main.js:73-185`) and polls
   `GET http://127.0.0.1:<PORT>/api/auth/required` for up to 30 s.
2. The child requires `express` → `body-parser` (`lib/read.js:19`) →
   `type-is`, whose `index.js` ends mid-block-comment (`/**` at line 248).
3. V8 throws `SyntaxError: Invalid or unexpected token`; with no handler yet
   registered this hits the `uncaughtException` path (`server.js:5087-5098`),
   which logs, runs `cleanup()`, and `exit(1)` by design.
4. The parent's `exit` handler (`electron/main.js:144-160`) shows the error box
   with the server tail and calls `app.quit()`. Multer's two nested files
   would fail next for the same reason had the boot gotten that far.

### End-to-end reproduction (Linux `.deb`, headless)

1. Extracted the deb (`dpkg-deb -x`), installed Electron's missing system
   libs, booted the shipped binary:
   `xvfb-run -a debx/opt/WebTun/webtun --no-sandbox`
   (`TMPDIR=/tmp`; root needs `--no-sandbox`).
2. The app starts, forks the server, and the fork dies instantly:

```text
[server:err] .../resources/app.asar/node_modules/type-is/index.js:248
/**
SyntaxError: Invalid or unexpected token
    at wrapSafe (node:internal/modules/cjs/loader:1868:18)
    ...
    at Object.<anonymous> (.../app.asar/node_modules/body-parser/lib/read.js:19:17)
Node.js v24.21.0
Server exited with code 1
```

3. `diff` of the registry `type-is@1.6.18` tarball against the bundled file:
   identical up to line 252, then lines 253–266 (the rest of the JSDoc plus the
   full `tryNormalizeType` function) replaced by a dangling `* @`.
4. `node --check` over **every** bundled `.js` file (193 files per bundle —
   identical JS count in all six variants):

```text
deb       checked=193 broken=3   # + headless boot repro above
portable  checked=193 broken=3   # app-64.7z extracted with 7z
setup     checked=193 broken=3   # app-64.7z extracted with 7z
appimage  checked=193 broken=3   # --appimage-extract
maczip    checked=193 broken=3
macdmg    checked=193 broken=3   # 7z reported 1 non-fatal item error; app.asar reads clean
```

The same 3 files in all six bundles; the four re-verified variants carry
byte-identical md5s (`edcdc249…`, `d93502b2…`, `b5f6ace6…`), and the earlier
deb/portable pair matched on line counts, cut points, and tails.

### Why the corruption is in the pack step, not the runners

The `.deb` (`ubuntu-latest`), both `.exe` variants (`windows-latest`), the
AppImage (linux job), and both mac artifacts (`macos-latest`) carry
**identical** truncated files down to the cut byte — three independent
runners, one deterministic result. `npm ci` verifies tarball integrity
against the lockfile, so corrupt downloads would have failed the builds;
per-machine AV/disk flakiness cannot produce identical bytes on three
operating systems. The common factor is `electron-builder@26.16.1`'s
file-copy into `app.asar` — verdict: pack step (see §2 for the tree-divergence
half of the same conclusion). This is a *different* defect from upstream
`#9681` ("node_modules silently missing") — here the files are present but
their contents are cut. Upstream report draft: §7.

**Proven locally (2026-09-21 follow-up):** clean `npm ci` in this repo
(source `type-is/index.js` verified intact at 266 lines, no
`multer/node_modules/` in the tree) → `npm run pack -- --linux` with the
pinned 26.16.1 → staged `app.asar` is **3,032,822 bytes, exactly the shipped
AppImage's asar size**, and carries the same 3 truncated files with the same
md5s (`edcdc249…`, `d93502b2…`, `b5f6ace6…`), 193/3 on the §6.2 gate, plus
the same flattened tree (`type-is@2.1.0` on top). Fourth independent
environment, same result, from a verified-clean input tree. The pack step is
no longer the prime suspect — it is the confirmed cause. **Do not rebuild
the release with 26.16.1**; the builder version must change first (§5 P0).

### Where the user sees it

The dialog already prints the last 15 server lines plus the log path
(`serverOutputTail()`, `serverLogPath()`, `electron/main.js:96-142`). On the
reporter's machine the dialog tail should show the same `type-is`
`SyntaxError`. Full log: `%APPDATA%\WebTun\webtun-server.log`
(`electron/main.js:41-47`; fallback `%TEMP%\webtun-server.log`).
Linux: `~/.config/WebTun/webtun-server.log` ·
macOS: `~/Library/Application Support/WebTun/webtun-server.log`.

---

## 2. Packed tree vs lockfile: verdict — pack step

Two candidate mechanisms were tracked (A: the build jobs' working trees
diverged from the lock before packing; B: the builder's staging re-hoists
production deps when assembling the asar). The follow-up pass settles it in
favor of **B**:

- The flattened nesting (top-level `type-is@2.1.0` metadata,
  `express/node_modules/` = `content-type` only, empty
  `body-parser/node_modules/`, `multer/node_modules/*` that the lockfile
  never lists) is **identical in all six variants from three different
  runners** (verified metadata: `type-is@2.1.0`, `express@5.2.1`,
  `multer@2.4.0` in the Setup-exe tree; same flattened layout everywhere).
  Three independent `npm ci` runs do not converge on the same non-lock
  layout; one shared pack step with deterministic hoisting does.
- Combined with §1 (byte-identical truncated *contents* across the same
  three runners, where `npm ci` integrity checks exclude corrupt downloads),
  both the layout divergence and the byte corruption point at the same
  place: `electron-builder@26.16.1`'s staging.
- Residual precaution (not a competing theory): save a **packed-tree
  manifest as a CI artifact** (recursive `package.json` version list of the
  staged tree) so any future divergence is attributable in one diff — §5 P0.

Evidence details (kept for the rebuild check in §6.4):

- Bundled `node_modules/type-is/package.json` says `"version": "2.1.0"`, but
  the bundled `index.js` (252 lines) is **not** 2.1.0's file (real 2.1.0 is
  240 lines) — it is 1.6.18 content truncated to 252. Metadata from one
  version, content from another.
- The bundle flattens nesting the lockfile pins: `express/node_modules/`
  contains only `content-type`, `body-parser/node_modules/` is empty, while the
  lockfile pins nested `type-is → 2.1.0` under both; top-level
  `node_modules/type-is` should be `1.6.18` per the lock but carries 2.1.0
  metadata. Same pattern for `multer/node_modules/{media-typer@0.3.0,
  mime-types@2.1.35}`, which have **no** `multer/node_modules/*` entries in
  the lockfile at all.
- `git diff v2.2.2 HEAD` is empty, so the release was built from this exact
  source tree — yet the packed `node_modules` layout differs from what
  `npm ci` reproduces from `package-lock.json`.
- Candidate A (working-tree divergence before packing) is **dead**: the
  2026-09-21 local repro packed a verified-clean, verified-lock-conformant
  `npm ci` tree and produced byte-identical corruption. No runner-side
  explanation survives. The packed-tree manifest (§6.4) stays recommended as
  a permanent CI artifact, but no longer as a discriminator.

---

## 3. Ruled out (checked, with evidence)

- **Missing `node_modules`** — refuted. Complete: 650 asar files (610 under
  `node_modules/`) in the deb, 795 (755) in the portable exe; `server.js`,
  `package.json`, `electron/main.js`, `electron/preload.js`,
  `lib/cloudflared.js`, `public/index.html` present; `express` (16 files),
  `ws` (19), `multer` (35), `node-pty` JS (196 deb / 341 win — win includes
  winpty/conpty sources). The `files` whitelist
  (`electron-builder.yml:13-19`) is fine: production `node_modules` are
  auto-included by electron-builder; the failure is in file *contents*.
- **`node-pty` ABI mismatch** — refuted. `node-pty@1.1.0` depends on
  `node-addon-api` (N-API, ABI-stable): shipped `pty.node` exports 47
  `napi_*` symbols, the Linux ELF x86-64 `.so` loads even under a foreign
  system Node, and per-platform artifacts are correct (ELF in the deb;
  PE32+ x86-64 `pty.node` + `conpty.node` + `conpty_console_list.node` +
  `winpty.dll` + `winpty-agent.exe` + `win32-x64` prebuilds in the bundle).
- **Runner flakiness / AV quarantine** — demoted. Identical bytes on two
  independent runners rule out flaky disks or per-machine quarantine (which
  would differ between runs); all native files are present.
- **Timeout, conpty crash, tunnel/PID, cloudflared validation** — not the
  cause; death is instant at `require` time, before any window, terminal, or
  tunnel exists. Kept below as hardening items.

---

## 4. Findings catalog

### 4.1 Process gaps (why §1 reached users)

1. **No packaged-artifact verification in CI.** `build.yml` / `pr-check.yml`
   never pack-and-inspect: no `asar` listing, no `node --check` over bundled
   JS, no tree-vs-lockfile assertion, no headless boot hitting
   `/api/auth/required`. The `require('./server.js')` smoke test exercises the
   source tree under system Node only. The §6 gate would have caught this
   release — and it must cover **every published variant** (portable *and*
   Setup exe, deb *and* AppImage, dmg *and* zip), not just one per platform.
2. **Native rebuild is implicit.** `rebuild:electron` exists
   (`package.json:29`) but no CI job or `dist*` script calls it; the build
   relies on the builder's default `npmRebuild`. N-API saved us this time.
   Make it explicit and fail the job if the unpacked `pty.node` is absent.
3. **Builder 26.16.1 is confirmed guilty — change it before rebuilding**
   (≥ 26.0.15, cf. upstream `electron-userland/electron-builder#9681`,
   2026-04-16 — a *different* symptom, cited only for prior art in this
   range). The 2026-09-21 local repro packed a verified-clean tree and
   reproduced byte-identical corruption, so rebuilding with 26.16.1 will
   re-ship the bug. Next: try latest 26.x and/or pre-26.0.15 locally, gate
   each with §6.2+§6.8; only the version that packs clean becomes the new
   pin. Then file upstream (draft: §7).
4. **No packed-tree manifest.** Without a recursive version manifest of the
   staged `node_modules` saved per build, §2 cannot be discriminated and
   future tree-divergence will again be undebuggable. Save it as a CI
   artifact; assert top-level versions against the lockfile.

### 4.2 Packaging gaps (robustness per platform)

5. **Bundle bloat (tens of MB).** Unpacked `node-pty` ships build
   intermediates (`.tlog`, `.iobj`, `.ipdb`, `.exp`, `.lib`, `obj/` — 168
   files deb / 280 win) plus test files (`terminal.test.js`), sourcemaps, and
   **all-platform prebuilds in every bundle** (`darwin-arm64`, `darwin-x64`,
   `win32-x64`, `win32-arm64` `pty.node` files ship on Linux too). Prune to
   the target platform via `files`/`asarUnpack` filters — smaller downloads,
   smaller AV surface. Open decision: strip Windows `.ipdb`/`.iobj` (size) or
   keep the PDBs (post-mortem debugging of conpty crashes) — decide
   explicitly.
6. **Icons are single PNGs** (`electron-builder.yml:26,31,37` →
   `public/icon-512.png`). Windows wants multi-size `.ico`, macOS `.icns`.
   Ship generated `build/icon.ico` + `build/icon.icns`.
7. **No signing / notarization.** Windows `CSC_LINK`/`CSC_KEY_PASSWORD` exist
   in CI but unsigned-by-default means SmartScreen warnings on the exact
   Setup exe users download; macOS has no `notarize`/`hardenedRuntime`/
   `entitlements`, so the `.dmg` (0 downloads so far — fix before anyone
   tries) hits Gatekeeper on other Macs. Decide per platform and document the
   expected first-launch UX.
8. **Single-arch matrix, unstated.** macOS builds arm64-only (no
   `universal`/`x64`) → Intel Macs unserved; Windows x64-only →
   Windows-on-ARM emulated at best. Declare the intended matrix; if Intel Mac
   stays out of scope, say so in `/docs` and the release notes.
9. **No auto-update — and dead update metadata ships.** No
   `electron-updater` in dependencies, yet the mac bundle contains
   `Contents/Resources/app-update.yml` (builder auto-emits GitHub-provider
   config from `package.json:repository`). Inert without the updater lib:
   either wire `electron-updater` (then the frozen-on-broken-bundle problem
   class goes away) or remove the publish inference so the file stops
   shipping. Until then, installed base freezes on whatever it downloaded —
   including v2.2.2 — so document the manual update story at minimum.
10. **Linux system deps untested on clean machines.** The deb declares
    `Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils,
    libatspi2.0-0, libuuid1, libsecret-1-0` (read from the shipped deb —
    sane), but no clean-VM install+boot test exists; booting the extracted
    tree on a minimal container required many more libs by hand. Gate each
    release on `apt install ./webtun.deb` + boot on clean Ubuntu LTS
    (and decide the AppImage-first vs deb-first story for exotic distros;
    the AppImage bundles more and is currently download-count 0).
11. **NSIS specifics undecided.** `electron-builder.yml:39-41` sets only
    `oneClick: false` + install-dir choice. Explicitly decide: per-user vs
    per-machine, `requestedExecutionLevel`, what the uninstaller kills
    (running forked server? tray? login item?) and removes
    (`%APPDATA%\WebTun`, `%LOCALAPPDATA%\cloudflared`), and whether both
    Setup *and* portable keep shipping (both are published today).
12. **`main` points at the Electron entry** (`package.json:10`):
    plain-Node `require('webtun')` pulls in `electron` and crashes outside
    the runtime. Harmless for the real entries (`node server.js`,
    `bin/webtun.js`); add a comment or `exports` map.
13. **cloudflared: bundle-vs-download tradeoff unde decided.** Today the
    ~35 MB binary downloads on first tunnel use to `%LOCALAPPDATA%` (good:
    no admin, no +35 MB per installer). Cost: offline machines can't tunnel,
    and a freshly-downloaded exe can trip SmartScreen/AV at tunnel-creation
    time — the worst moment. For a "robust package" story, decide per
    platform and document it; if download-on-demand stays, preflight it in
    the packaged smoke test (mock or real).

### 4.3 Packaged-runtime items (for after the app boots again)

14. **`.env` write path can target read-only `app.asar`.**
    `envPathForWrite()` (`server.js:642-648`) prefers `__dirname/.env` when
    it exists *or `__dirname` tests writable* — packaged, `__dirname` is
    `…/resources/app.asar`. If the probe ever reports true there,
    `persistPinToEnv()` (`server.js:660-678`) fails at PIN-rotation time
    while reads correctly use `~/.config/webtun/.env`. Audit all
    `__dirname` writes for packaged mode (enumerate: PIN persist, and confirm
    nothing else writes next to the binary).
15. **`DATA_DIR` comment vs code drift (low).** Comment (`server.js:610-613`)
    says repo checkouts keep state next to the server, but
    `resolveDataDir()` (`server.js:614-622`) returns `~/.config/webtun`
    unconditionally (fallback `__dirname` only if `mkdirSync` throws),
    with migration in `migrateLegacyState()` (`server.js:628-639`) — and
    `AGENTS.md` describes yet another variant. Pick one behavior, document
    it in all three places.
16. **No `crashReporter`, no renderer-side recovery.** A dead backend after
    window creation yields `ERR_CONNECTION_REFUSED` or quit-after-dialog;
    native crashes leave no JS stack in `webtun-server.log`. Needed for any
    serious desktop support story.
17. **Singleton-lock bind failure quits silently** (observed headless on
    Linux, exotic filesystems): `Failed to bind() .../SingletonSocket:
    Function not implemented (38)` → `The platform failed to initialize.
    Exiting.`, `exit=0`, no dialog. Log a clear message on this path
    (portable EXEs on network drives / sandboxed Linux are the realistic
    triggers, not just containers).
18. **Single-instance second launch drops arguments**
    (`electron/main.js:246-256`); **login-item args filter over-broad**
    (`electron/main.js:333-338` strips all `--*` args for autostart).
19. **`findFreePort` probes `127.0.0.1` while the CLI can bind `0.0.0.0`**
    (`bin/webtun.js:183-197` vs `HOST` default `0.0.0.0`, `server.js:179`).
    Electron is consistent (forces `HOST=127.0.0.1`, `electron/main.js:80`);
    the CLI path can misdiagnose a LAN-held port as free.
20. **EADDRINUSE retry leaks the stuck child on Windows:**
    `stopServerProcess()` in the retry loop sends only `SIGTERM`, skipping
    the `taskkill /T /F` fallback used in `before-quit`
    (`electron/main.js:262-266` vs `302-311`).
21. **Cloudflared order vs packaged layout.** First usable hit wins in
    `findCloudflared()` (`lib/cloudflared.js:57-93`): a stale
    `ProgramFiles\cloudflared\cloudflared.exe` shadows everything, and
    `downloadCloudflared()` dests (`lib/cloudflared.js:310-317`) include
    `PKG_ROOT` — read-only inside `app.asar` when packaged (the writable
    `%LOCALAPPDATA%\cloudflared` dest wins first in practice, but by luck).
    Prefer the user-writable dest explicitly when `app.isPackaged`.
22. **Windows hygiene leftovers.** `wmic` fallback in `killPid()`
    (`server.js:1205`) targets a tool removed from current Windows 11 (fails
    safe in `try/catch`, but dead weight — use `Get-CimInstance`); `okBinary`
    on `win32` accepts ELF (`lib/cloudflared.js:249-254`, should be `isMz`
    only).

### 4.4 Verified positives (keep these while hardening)

- `files` whitelist + `asarUnpack: node-pty only` design is correct; the bug
  is in the pack step's output, not the config.
- `preload.js` (`contextIsolation`, `sandbox`, minimal IPC) and main-window
  `webPreferences` (`electron/main.js:188-205`): sound.
- **First-run desktop posture is safe:** the Electron host forces
  `HOST=127.0.0.1` (`electron/main.js:80`) and no `.env`/PIN ships, so a
  fresh install is loopback-only even with empty-PIN (open) semantics.
- Auth/session/token flow, loopback gating, rate limiters: shared
  `server.js`, unaffected by packaging.
- `npm` tarball separation (`package.json:files` + `.npmignore` excluding
  `electron/`, builder config, scripts): correct.
- `verify-version.js` + `npm pack --dry-run` + `npm audit --omit=dev`: keep.
- CI Node 24 ↔ Electron-44 Node 24.21 alignment: keep, and pin the exact
  minor for reproducibility.

---

## 5. Robust-packaging plan (priorities for the rebuild)

**P0 — unbreak the release (before any new build ships):**
0. Change the builder version first (see item 3): no rebuild on 26.16.1.
   (User decisions recorded 2026-09-21: delete all v2.2.2 releases and retag
   after the fix — owner's GitHub action; wire `electron-updater`; plan for
   unsigned UX, no certs.)
1. Supersede v2.2.2 desktop assets (retag fixed build after item 0; both
   `.exe` variants already have downloads). Follow the repo's tag/changelog
   convention (`git describe --tags`, `v` prefix, heading == tag). NOTE on
   retag mechanics: deleting the GitHub release does not delete the tag —
   to retrigger CI the remote tag must be deleted and re-pushed
   (`git push --delete origin vX.Y.Z && git push origin vX.Y.Z`), or bump to
   a fresh version (cleaner: avoids stale CDN/API caches keyed on the tag).
2. Add the §6 gate to CI and make it fail the pipeline: integrity (§6.2) on
   **all six variants**, tree-vs-lock (§6.4), packed-tree manifest artifact
   (§4.1.4), headless boot (§6.5) of at least the portable exe + deb.
3. File the upstream builder issue with these artifacts (exact truncated
   files + builder version + both-runner determinism); keep the pin until a
   fixed builder passes §6.2 locally (`npm run pack` + gate, §6.7).
4. Publish `SHA256SUMS.txt` (and, if signing keys exist, signatures/SBOM or
   GitHub attestations) with the fixed release — there is currently nothing
   for users to verify downloads against.

**P1 — make the pipeline reproducible and honest:**
5. Pin exact Node minor in CI (`setup-node`), run explicit
   `rebuild:electron` after `npm ci` in all three build jobs, assert unpacked
   `pty.node` per platform.
6. Prune the bundle (§4.2 item 5; decide the PDB question) and set a size budget
   alert per artifact (v2.2.2 sizes in the asset table are the baseline to
   beat — the win bundle carries tens of MB of intermediates today).
7. Clean-VM matrix per release: Windows 10 + 11 (install + portable),
   Ubuntu LTS `apt install` + boot, Fedora/AppImage boot, macOS arm64
   install + first launch; record results in the release notes.
8. Decide + document: arch matrix (§4.2 item 8), NSIS options (§4.2 item 11),
   cloudflared story (§4.2 item 13), update mechanism (§4.2 item 9 — wire
   `electron-updater` or remove the dead `app-update.yml`), icon assets
   (§4.2 item 6), and the PDB-keep-or-strip call (§4.2 item 5). Each undecided item is
   a support ticket waiting to happen; the release notes template should
   carry the decisions.

**P2 — harden the runtime for packaged mode:**
9. Writable-path audit: fix the `app.asar` `.env` write preference (§4.3.14),
   reconcile the `DATA_DIR` docs (§4.3.15), wire `crashReporter` (§4.3.16).
10. Small correctness items §4.3.17–§4.3.22 (singleton-lock message,
    single-instance args, login-item filter, `findFreePort`/HOST, retry
    `taskkill`, cloudflared dest order, `wmic`, ELF check).

---

## 6. Appendix — verification commands and completed results

```bash
# 6.1 What is inside the shipped bundle?
asar list "dist/win-unpacked/resources/app.asar" | grep -E "node_modules/(express|ws|multer|node-pty)|^/(server.js|package.json|electron/main.js)" | head
asar list "dist/win-unpacked/resources/app.asar" | grep -c "node_modules/"

# 6.2 THE §1 GATE — syntax-check every bundled JS file (fail the build if >0).
#     Completed 2026-09-21 on all six v2.2.2 variants (193 JS files each):
#       deb / portable / setup / appimage / maczip / macdmg → 3 broken each,
#       the same 3 files (table §1). md5s identical across variants:
#       type-is edcdc249…, media-typer d93502b2…, mime-types b5f6ace6….
fails=0; total=0
for f in $(find tree-deb tree-portable tree-setup tree-appimage tree-maczip tree-macdmg -name "*.js"); do
  total=$((total+1))
  node --check "$f" >/dev/null 2>&1 || { fails=$((fails+1)); echo "BROKEN: $f"; }
done
echo "checked=$total broken=$fails"   # expect: broken=0 on a fixed build

# 6.3 Confirm the truncation fingerprints (intact refs: type-is 266 for 1.6.18 /
#     240 for 2.1.0; media-typer 270 for 0.3.0; mime-types 188 for 2.1.35):
tail -c 60 node_modules/type-is/index.js   # must NOT end mid-comment ("* @", no newline)
wc -l node_modules/type-is/index.js node_modules/multer/node_modules/media-typer/index.js node_modules/multer/node_modules/mime-types/index.js

# 6.4 Confirm packed tree matches the lockfile (catches the §2 franken-package):
python3 -c "
import json
lock = json.load(open('package-lock.json'))['packages']
bund = json.load(open('tree-deb/node_modules/type-is/package.json'))
assert bund['version'] == lock['node_modules/type-is']['version'], (bund['version'], lock['node_modules/type-is']['version'])
print('type-is tree OK:', bund['version'])
"
# Plus: save a recursive package.json version manifest of the staged tree as a
# CI artifact on every build (the §2 discriminator going forward).

# 6.5 Reproduce the crash with output (any OS with the shipped build):
#    xvfb-run -a ./webtun --no-sandbox   (root needs --no-sandbox; set TMPDIR=/tmp)
#    → forked server must NOT print "SyntaxError ... type-is" + "Server exited with code 1"

# 6.6 mac + remaining variants (COMPLETED 2026-09-21 — was pending):
#   Setup exe: 7z x WebTun.Setup.2.2.2.exe → 7z x $PLUGINSDIR/app-64.7z → gate §6.2 ✅
#   AppImage:  ./WebTun-2.2.2.AppImage --appimage-extract → squashfs-root/resources/app.asar → gate §6.2 ✅
#   mac zip:   unzip -o WebTun-2.2.2-arm64-mac.zip → WebTun.app/Contents/Resources/app.asar → gate §6.2 ✅
#   dmg:       7z x WebTun-2.2.2-arm64.dmg (1 non-fatal item error; app.asar reads clean) → gate §6.2 ✅

# 6.7 Stage without distributing (fast iteration):
npm run pack                      # electron-builder --dir

# 6.8 Local clean-room repro (COMPLETED 2026-09-21 — verdict: builder guilty):
#   npm ci                                   # source type-is verified intact (266 lines), no multer/node_modules nesting
#   npm run pack -- --linux                  # pinned electron-builder 26.16.1
#   staged app.asar = 3,032,822 bytes = shipped AppImage's asar size, byte for byte in size
#   asar extract dist/linux-unpacked/resources/app.asar repro-tree && gate §6.2
#   → 193 checked / same 3 broken / same md5s (edcdc249…, d93502b2…, b5f6ace6…)
#   → same flattened tree (type-is@2.1.0 on top). Fourth environment, clean input.
#   Repeat 6.8 with any candidate builder version: only a version whose output
#   passes §6.2 + §6.4 may become the new pin.
```

| Observation | Points to |
|---|---|
| `node --check` flags `type-is` / `media-typer` / `mime-types` | truncating pack step (§1) — rebuild, re-gate, report upstream (§7) |
| Bundled `type-is` version ≠ lockfile top-level version | tree ≠ lockfile (§2) — rebuild from clean `npm ci` + manifest |
| Log ends at fork + `SyntaxError ... type-is` + `Server exited with code 1` | §1 root cause |
| `pty.node` present but `require` under Electron throws ABI error | implicit-rebuild failure (§4.1.2) |
| `pty.node`/`winpty-agent.exe` missing at runtime but present at pack time | AV quarantine |
| Log ends at fork + ~30 s of `ECONNREFUSED` retries | cold-start timeout (former H3, §3 — hardening context only) |
| Window opens, death on first shell spawn + native fault in Event Viewer | conpty/pty native crash |
| `Failed to bind() .../SingletonSocket` + `platform failed to initialize` | singleton-lock path (§4.3.17) |
| PIN rotation in packaged app reports persistence error | asar write path (§4.3.14) |

---

## 7. Appendix — upstream issue draft (electron-builder)

> **Title:** Deterministic truncation of identical JS files in `app.asar` across win/mac/linux builds (26.16.1)
>
> **Body:** Building the same app (`electron` 44.4.1, `electron-builder`
> 26.16.1, `node-pty` 1.1.0, `npm ci` on Node 24) on `windows-latest`,
> `ubuntu-latest`, and `macos-latest` produces six artifacts whose
> `app.asar` files each contain the same three byte-truncated JS files
> (`node_modules/type-is/index.js` cut after line 252 of 266, mid-comment;
> `node_modules/multer/node_modules/media-typer/index.js` cut after line 234
> of 270; `node_modules/multer/node_modules/mime-types/index.js` cut after
> line 179 of 188) — byte-identical md5s across all three runners, so the
> corruption is in the shared pack step, not the runners. `npm ci` verifies
> tarball integrity, excluding corrupt downloads. The packed tree is also
> flattened versus the lockfile (nested `type-is@2.1.0` hoisted to top level
> over 1.6.18 content). Minimal repro (confirmed 2026-09-21): clean `npm ci`
> (source files verified intact) + `npm run pack -- --linux` with pinned
> 26.16.1 reproduces byte-identical truncation in a fourth environment —
> no CI involved. Repro: pack any app depending on
> `express@5`/`multer@2` with 26.16.1 on any two runners and `node --check`
> the three files above. Distinct from #9681 (files present, contents cut).
> Artifacts that demonstrate it: `webtun` v2.2.2 release (6 files, all
> affected).

---

*Report ends. No application code, config, or workflow was modified — the only
change in this working tree is this file (`node_modules/` and `dist/` from
the local repro are gitignored build artifacts, not repo changes).
Verification: all six published `v2.2.2` assets scanned (`node --check` over
193 bundled JS files each; identical 3-file failure with matching md5s),
headless boot of the Linux deb reproducing the `SyntaxError`, clean-room
local repro proving the pack step guilty, registry-tarball diffs,
lockfile-vs-bundle comparison, and GitHub-API asset inventory with sha256.*
...[truncated 3888 chars]
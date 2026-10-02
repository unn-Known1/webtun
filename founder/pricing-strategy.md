<!-- /founder:pricing-strategy · 2026-10-03 · input: go ahead but make sure your reports are compatible with the app features also -->
# Pricing strategy for WebTun

Assumption: product is WebTun 2.2.8, self hosted Express plus node-pty plus Cloudflare tunnel, now free noncommercial under PolyForm.
Assumption: payer is the admin who runs the server. Solo dev for Pro. Team lead for Team.
Assumption: Community keeps current behavior with no new caps, because current users installed under that promise.

## 1. Pricing model analysis

Recommended model: freemium plus flat per server for Pro plus per admin pack for Team, because server costs are flat while team control value grows with admins.

| Model | Fit score | Pros | Cons |
|-------|-----------|------|------|
| Flat subscription | 5 | Predictable, matches RustDesk Pro, one check per server | Does not grow with fleets |
| Freemium | 5 | Homelab loop, free tier is the demo because install is 1 command | Needs clear paywall or no converts |
| Per seat | 4 | Captures team value, matches Tailscale, grows ARPU | Solos reject per seat for one server |
| Usage based | 2 | Fits tunnel GB in theory | Easy to bypass self hosted, audit disputes |
| Credits | 1 | None, because access is always on | Confusing, support load grows |
| One time purchase | 2 | Appeals to homelab buyers | Kills recurring revenue while support continues |

Recommendation: keep Community free, sell Pro flat $12 per server per month, sell Team $19 per admin per month with 3 minimum, because that mirrors RustDesk plus Termius and needs only two license flags.

## 2. Tier design

### Community (free forever)
Monthly: $0. Annual: $0. Scope: noncommercial, 1 server process, current v2.2.8 behavior unchanged.
Hook: full terminal with tmux or in memory persist, file explorer, CodeMirror editor with 2s drafts, git mini panel, tunnels UI, PWA plus Electron, because that is the build people already share.
Upgrade trigger: commercial use, or need for SSH key access, or a third concurrent tunnel, because those are the first paid gates below.
Features:
1. Terminal tabs uncapped, file tabs capped at 10 as today in public/js/file-tabs.js
2. Files API, transfers, zip, search, image and PDF and EPUB viewers
3. Tunnels with persist plus watchdog backoff, 2 concurrent, new small gate on tunnels.size in server.js
4. PIN plus pending approval plus revoke, 3 trusted devices, new small gate on GET /api/auth/sessions count
5. Command history 200 entries in .cmdhist.json, git panel, system stats
6. Community support via GitHub issues

### Pro (solo commercial)
Monthly: $12 per server. Annual: $115 per year, 20 percent off, equals $9.58 per month.
Justifies jump: commercial license plus SSH credentials plus unlimited tunnels, because solo pros pay to reach the same box from laptop and phone without key copy pain.
Gated feature: POST /api/ssh/credentials plus DELETE /api/ssh/keys/:id plus managed sshd setup in lib/ssh-setup.js, because that surface already needs PIN and the Features toggle, so one license check gates it cleanly.
Features:
1. Commercial use, 1 server, 1 admin, 5 trusted devices
2. Unlimited concurrent tunnels, same .tunnels.json store
3. SSH ed25519 per device, Termius plus VS Code plus rsync, per key revoke
4. Session approval list, instant revoke, PIN rotation persist flow
5. History 1,000 entries plus export, app preview UI for PREVIEW_PORTS, today env only
6. Priority email support, 48 hour response
Upgrade trigger: second admin or need for shared library, because credential sharing over chat forces Team.

### Team (business)
Monthly: $19 per admin, 3 minimum. Annual: $182 per admin, 20 percent off, equals $15.17 per month.
Self serve 3 to 10 admins per server. Sales led above 10, because larger fleets ask for contracts and the per server seat count needs review.
Adds: multi admin control plus shared files plus audit export, because teams pay for control, and all three reuse routes that already exist.
Features:
1. Everything in Pro, up to 10 admins per server
2. Shared command library plus shared bookmarks via export and import of commands.js and places, small settings addition
3. Session approve and deny plus PIN change approve and veto, with 0x03 push alerts
4. Audit export: history plus ssh key events plus session list, 1 year retention
5. PREVIEW_PORTS plus ALLOWED_ORIGINS policy UI, priority chat
6. 99.5 percent license service SLA, central Stripe billing
No SSO in Team, because no OIDC code exists and it needs new deps plus CSP review. Offer SSO as custom roadmap only.
Upgrade trigger: compliance audit or more than 100 hosts, because that signals custom plan talks.

## 3. Competitive pricing context

Prices checked 2026-10-02.

1. Termius. Starter $0, Pro $10 per month annual, Team $20 per seat annual, Business $30 per seat annual. SSH sync and shared vaults. Source: https://www.termius.com/pricing
2. Tailscale. Personal $0 to 6 users, Standard $8 per user, Premium $18 per user. Mesh VPN plus SSH. Source: https://tailscale.com/pricing
3. Cloudflare Zero Trust. Free $0 to 50 users, pay as you go $7 per user. Access plus tunnels. Source: https://www.cloudflare.com/plans/sase-zero-trust
4. RustDesk self hosted Pro. Free $0, Individual $11.88 annual, Basic $23.88 annual plus $1.20 per extra user. Key for self hosted server. Source: https://rustdesk.com/pricing/
5. ShellHub Cloud. Community free open source, Cloud free to 3 devices then usage based, Enterprise custom. No public seat list. Source: https://www.shellhub.io/pricing

Position: Pro $12 near RustDesk $11.88 and above Termius Pro $10, because WebTun bundles terminal plus files plus git plus tunnel in one process. Team $19 below Termius Team $20 and near Tailscale Premium $18, because admin value matches but WebTun has no relay cost.

## 4. Unit economics check

Estimate: 1 VPS at $12 serves 2,000 servers, equals $0.01 each. Email plus checks $0.10. Stripe 2.9 percent plus $0.30. Support at $40 per hour: Pro 0.25 hour per year equals $0.83 per month. Team 1 hour per year equals $3.33 per month. All infra and support numbers are estimates.

Cost per month:
Pro: $0.76 infra plus fees plus $0.83 support equals $1.60 estimate.
Team seat: $0.96 plus $3.33 support equals $4.29 estimate.

Gross margin:
Pro $12: (12 minus 1.60) divided by 12 equals 87 percent.
Pro annual $9.58: about 83 percent, because fee drops but support stays.
Team $19: (19 minus 4.29) divided by 19 equals 77 percent.

Break even: fixed $800 per month. Pro contribution $10.40 needs 77 servers. Team contribution $14.71 needs 55 seats. Mix of 50 Pro plus 20 Team equals $814, covers $800, because mix lifts ARPU.

Target blended ARPU: $18 per paying account, because 30 percent Team mix beats single Pro.

## 5. Pricing psychology

Anchoring: Team at $19 per seat is the anchor, shown first, because a $57 three seat total makes $12 Pro look cheap.
Decoy: custom Enterprise card with SSO and MSA as Contact sales, because it pushes small teams to Team annual to avoid a sales call.
Annual framing: show $115 as $9.58 per month billed annually plus save $29, toggle defaults to annual, because annual default lifts yearly take in dev tools.

## 6. Launch pricing vs scale pricing

Launch for first 90 days: Pro $8 per month or $76 per year, Team $14 per seat or $134 per year, locked for first 200 buyers, because early buyers accept rough edges for a deal and give logos and reports.
Why it differs: launch needs conversion data, not max revenue, because elasticity is unknown until 100 paid installs.
Grandfathering: keep launch price 24 months, then scale price with 60 days notice plus annual lock option, because fast hikes destroy trust.
Price increases: Pro to $12 when 100 servers renew at 85 percent plus for 2 months. Team to $19 when NRR passes 110 percent or audit export ships, because those prove value. Announce 30 days ahead, new sales first, then renewals.

## 7. How to implement in the app

Use Stripe Billing plus local Ed25519 license keys, because WebTun runs offline and cannot phone home each request.
Steps: 1) Stripe sells plan, webhook signs JWT with plan, seats, expiry. 2) paste key in Settings plus Security, new lib/license.js checks signature with node:crypto, stores DATA_DIR/license.json 0600 atomic like .tunnels.json. 3) add checkLicense next to checkPin and requirePinSet, gate only POST /api/ssh/credentials, tunnel cap, session cap, history cap, because narrow gates avoid locking local terminal. 4) 7 day grace on expiry, then block SSH and extra tunnels but never block loopback terminal, because lockouts cause data loss anger. 5) update public/docs.html with TOC plus data-title in the same change, because docs rule needs it. No new npm deps, no CSP change, Electron inherits the key through its server fork.

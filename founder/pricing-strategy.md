<!-- /founder:pricing-strategy · 2026-10-03 · input: go ahead but make sure your reports are compatible with the app features also -->
# Pricing strategy for WebTun

Assumption: product is WebTun 2.2.8, self hosted Express plus node-pty plus Cloudflare tunnel, now free noncommercial under PolyForm.
Assumption: payer is the admin who runs the server. Solo dev for Pro. Team lead for Team.
Assumption: Community keeps current behavior for 6 months after paid launch, then caps apply with 60 days notice, because current users installed under that promise.

## 1. Pricing model analysis

Recommended model: freemium plus flat per server Pro plus per admin Team, because server costs are flat while team value grows with admins.

| Model | Fit score | Pros | Cons |
|-------|-----------|------|------|
| Flat subscription | 5 | Predictable, matches RustDesk Pro, one check | Does not grow with fleets |
| Freemium | 5 | Homelab loop, install is 1 command demo | Needs clear paywall or no converts |
| Per seat | 4 | Captures team value, grows ARPU | Solos reject per seat for one box |
| Usage based | 2 | Fits tunnel GB in theory | Easy to bypass, audit disputes |
| Credits | 1 | None, because access is always on | Confusing, support load grows |
| One time purchase | 2 | Appeals to homelab buyers | Kills recurring revenue |

Recommendation: keep Community free, sell Pro flat $12 per server, Team $19 per admin with 3 minimum, because that mirrors RustDesk plus Termius and needs two flags.

## 2. Tier design

### Community (free forever)
Monthly: $0. Annual: $0. Scope: noncommercial, 1 server, current 2.2.8 behavior unchanged.
Hook: full terminal with tmux persist, files, editor with drafts, git panel, tunnels UI, PWA plus Electron, because that is the build people share.
Upgrade trigger: commercial use, SSH keys, or a third tunnel, because those are the first paid gates.
Features:
1. Terminal tabs uncapped, file tabs capped at 10 as today in public/js/file-tabs.js
2. Files API, transfers, zip, search, image and PDF and EPUB viewers
3. Tunnels with persist plus watchdog backoff, 2 concurrent after grace, new small gate on tunnels.size in server.js
4. PIN plus pending approval plus revoke, 3 trusted devices after grace, new small gate on GET /api/auth/sessions count
5. Command history 200 entries in .cmdhist.json, up from current default 50, needs clamp change in server.js plus misc.js, because history is the audit trail Teams pay for
6. Community support via GitHub

### Pro (solo commercial)
Monthly: $12 per server. Annual: $115 per year, 20 percent off, equals $9.58 per month.
Justifies jump: commercial license plus SSH plus unlimited tunnels, because solo pros pay to reach the same box from laptop and phone.
Gated feature: SSH credential routes plus managed sshd setup in lib/ssh-setup.js, because that surface already needs PIN, so one check gates it.
Features:
1. Commercial use, 1 server, 1 admin, 5 devices
2. Unlimited concurrent tunnels, same .tunnels.json store
3. SSH ed25519 per device, Termius plus VS Code plus rsync, per key revoke
4. Session approval list, instant revoke, PIN rotation flow
5. History 1,000 entries plus export, needs same clamp change, plus app preview UI for PREVIEW_PORTS, today env only
6. Priority email support, 48 hour response
Upgrade trigger: second admin or shared library need, because credential sharing over chat forces Team.

### Team (business)
Monthly: $19 per admin, 3 minimum equals $57 per month. Annual: $182 per admin, 20 percent off, equals $15.17 per month, $546 per year for 3.
Self serve 3 to 10 admins per server. Sales led above 10, because larger fleets ask for contracts and the per server seat count needs review.
Adds: multi admin control plus shared files plus audit export, because teams pay for control, and session routes already exist while export plus sharing need small new APIs.
Features:
1. Everything in Pro, up to 10 admins per server, because seat cap maps to active session count.
2. Shared command library plus bookmarks via export and import, needs new small API since both live client side, because file handoff beats chat copy.
3. Session approve and deny plus PIN change approve and veto, with 0x03 push alerts, because that workflow already ships and Teams live in it.
4. Audit CSV export of history plus ssh events plus session list, 1 year retention, needs new route since none exists, because compliance asks for one file.
5. PREVIEW_PORTS plus ALLOWED_ORIGINS policy UI, both env only today, because Teams pay for policy control.
6. License service status page, Stripe portal billing, because offline keys mean status must be public to earn trust.
No SSO in Team, roadmap only, because no OIDC code exists. Offer SSO as custom Enterprise later.
Upgrade trigger: compliance audit or more than 100 hosts, because that signals custom plan talks.

## 3. Competitive pricing context

Prices checked 2026-10-02.

1. Termius. Starter $0, Pro $10 annual, Team $20 per seat annual, Business $30 annual. SSH sync and vaults. Source: https://www.termius.com/pricing
2. Tailscale. Personal $0 to 6 users, Standard $8, Premium $18. Mesh VPN plus SSH. Source: https://tailscale.com/pricing
3. Cloudflare Zero Trust. Free $0 to 50 users, paid $7 per user. Access plus tunnels. Source: https://www.cloudflare.com/plans/sase-zero-trust
4. RustDesk Pro. Free $0, Individual $11.88 annual, Basic $23.88 annual plus $1.20 per user. Key for self hosted server. Source: https://rustdesk.com/pricing/
5. ShellHub Cloud. Community free, Cloud free to 3 devices then usage based, Enterprise custom. Source: https://www.shellhub.io/pricing

Position: Pro $12 near RustDesk $11.88 and above Termius Pro $10, because WebTun bundles terminal plus files plus git plus tunnel in one process. Team $19 below Termius Team $20 and near Tailscale $18, because admin value matches with no relay cost.

## 4. Unit economics check

Estimate: 1 VPS at $12 serves 2,000 servers, equals $0.01 each. Email plus checks $0.10. Stripe 2.9 percent plus $0.30. Support at $40 per hour: Pro 0.25 hour per year equals $0.83 per month. Team 1 hour per year equals $3.33 per month. All numbers are estimates.

Cost per month:
Pro: $0.76 infra plus fees plus $0.83 support equals $1.60 estimate.
Team seat: $0.96 plus $3.33 support equals $4.29 estimate.

Gross margin:
Pro $12: (12 minus 1.60) divided by 12 equals 87 percent.
Pro annual $9.58 effective: about 87 percent, because Stripe fee falls to $0.30 per month while support stays.
Team $19: (19 minus 4.29) divided by 19 equals 77 percent.

Break even: fixed $800 per month for VPS, email, accounting, support. Pro contribution $10.40 needs 77 servers. Team contribution $14.71 needs 57 seats, sold in 3s so 19 Team servers. Mix of 50 Pro plus 20 seats equals $814, covers $800, because mix lifts ARPU.

Target blended ARPU: $14.10 per seat at 70 percent Pro plus 30 percent Team seats, $25.50 per account at same mix with 3 seat Team floor, because seat math guides pricing while account math guides revenue.

## 5. Pricing psychology

Anchoring: Team at $19 per seat is the anchor, shown first, because a $57 three seat total makes $12 Pro look cheap.
Decoy: custom Enterprise card with SSO roadmap plus MSA as Contact sales, because it pushes small teams to Team annual to avoid a sales call.
Annual framing: show $115 as $9.58 per month billed annually plus save $29, toggle defaults to annual, because annual default lifts yearly take.

## 6. Launch pricing vs scale pricing

Launch for first 90 days: Pro $8 per month or $76 per year, 20.8 percent off, Team $14 per seat or $134 per year, 20.2 percent off, locked for first 200 buyers, because early buyers accept rough edges for a deal and give logos and reports.
Why it differs: launch needs conversion data, not max revenue, because elasticity is unknown until 100 paid installs.
Grandfathering: keep launch price 24 months, then scale price with 60 days notice, because fast hikes destroy trust.
Price increases: Pro to $12 when 100 servers renew at 85 percent plus for 2 months. Team to $19 when audit export ships plus Team holds 10 servers, because those prove value. Announce 30 days ahead, new sales first, then renewals.

## 7. How to implement in the app

Use Stripe Billing plus local Ed25519 license keys, because WebTun runs offline and cannot phone home each request.
Steps: 1) Stripe sells plan, webhook signs JWT with plan, seats, expiry. 2) paste key in Settings plus Security, new lib/license.js checks signature with node:crypto, stores DATA_DIR/license.json 0600 atomic like .tunnels.json. 3) add checkLicense next to checkPin and requirePinSet, gate all SSH routes plus credentials plus port plus setup plus enabled, plus tunnel cap, session cap, history cap, because partial gates leave bypasses. 4) 7 day grace on expiry, then block SSH and extra tunnels but never block loopback terminal, because lockouts cause data loss anger. 5) update public/docs.html with TOC plus data-title in the same change, because docs rule needs it. No new npm deps, no CSP change, Electron inherits the key through its server fork.

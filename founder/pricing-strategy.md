<!-- /founder:pricing-strategy · 2026-10-02 · input: how can I implement pricing in my app and how much -->
# Pricing strategy for WebTun

Assumption: product is WebTun 2.2.8, self hosted terminal plus files plus tunnel, now free noncommercial under PolyForm.
Assumption: payer is the admin who runs the server. Solo dev for Pro. Team lead for Team.
Assumption: no pricing exists yet, so all numbers are new proposals because there is no founder price to correct.

## 1. Pricing model analysis

Recommended model: freemium plus flat per instance for Solo plus per admin seat for Team, because WebTun costs are flat per install while team value grows with admins.

| Model | Fit score | Pros | Cons |
|-------|-----------|------|------|
| Flat subscription | 5 | Predictable, matches RustDesk Pro, low billing code | Does not grow with fleets |
| Freemium | 5 | Homelab loop, free tier is the demo because install is 1 command | Needs clear paywall or no converts |
| Per seat | 4 | Captures team value, matches Tailscale, grows ARPU | Solos reject per seat for one server |
| Usage based | 2 | Fits tunnel GB in theory | Easy to bypass self hosted, audit disputes |
| Credits | 1 | None, because access is always on | Confusing, support load grows |
| One time purchase | 2 | Appeals to homelab buyers | Kills recurring revenue while support continues |

Recommendation: keep Community free, sell Pro as flat $12 per server per month, sell Team as $19 per admin per month, because that mirrors how buyers already pay RustDesk and Termius and keeps billing code to two checks.

## 2. Tier design

### Community (free forever)
Monthly: $0. Annual: $0.
Hook: full terminal, files, editor, 1 host, 3 Cloudflare tunnels, PWA, because that is the current product and it drives word of mouth.
Upgrade trigger: commercial use, or need for SSH key access, or more than 3 hosts, because those three events mark professional use.
Features:
1. Noncommercial use only, 1 server instance
2. 4 terminal tabs, tmux persist
3. File explorer plus editor, 10 file tabs
4. 3 tunnels, manual start
5. PIN auth plus 2 trusted devices
6. Community support via GitHub issues

### Pro (solo commercial)
Monthly: $12 per server. Annual: $115 per year, 20 percent off, equals $9.58 per month.
Justifies jump: commercial license plus SSH key access plus unlimited tunnels, because solo pros pay to reach servers from phone and laptop without key copy pain.
Gated feature: header SSH access with ed25519 per device, because it is the highest value solo feature.
Features:
1. Commercial use, 1 server, 1 admin
2. 10 hosts with sync, unlimited tabs and file tabs
3. SSH plus SFTP from Termius and VS Code, per key revoke
4. Session approval, active list, instant revoke
5. App preview allow list plus 30 day log export
6. Priority email support, 48 hour response
Upgrade trigger: second admin or need for shared vault, because credential sharing over chat forces Team.

### Team (business)
Monthly: $19 per admin per month, 3 admin minimum. Annual: $182 per admin per year, 20 percent off, equals $15.17 per month.
Self serve 3 to 10 admins. Sales led above 10, because enterprise asks for contracts past that size.
Adds: shared vault, roles, SSO, central billing, because teams pay for control.
Features:
1. Everything in Pro, unlimited servers per group
2. Shared vault, 100 hosts, group access control
3. OIDC SSO, enforced 2 step for console
4. Shared logs, 1 year retention, per admin trail
5. Transfer quotas plus automation API
6. Policy templates plus deployment tokens
7. 99.5 percent license SLA, priority chat
Upgrade trigger: compliance audit or more than 100 hosts, because that signals custom plan talks.

## 3. Competitive pricing context

Prices checked 2026-10-02.

1. Termius. Starter $0, Pro $10 per month annual, Team $20 per seat per month annual, Business $30 per seat per month annual. Includes SSH sync and shared vaults. Source: https://www.termius.com/pricing
2. Tailscale. Personal $0 up to 6 users, Standard $8 per user per month, Premium $18 per user per month. Includes mesh VPN plus SSH. Source: https://tailscale.com/pricing
3. Cloudflare Zero Trust. Free $0 up to 50 users, pay as you go $7 per user per month. Includes Access plus tunnels. Source: https://www.cloudflare.com/plans/sase-zero-trust
4. RustDesk self hosted Pro. Free $0, Individual $11.88 per month annual, Basic $23.88 per month annual plus $1.20 per extra user. License key for self hosted server. Source: https://rustdesk.com/pricing/
5. ShellHub Cloud. Community free and open source, Cloud free up to 3 devices then usage based pay as you go, Enterprise custom. No public per seat list. Source: https://www.shellhub.io/pricing

Position: Pro $12 sits above Cloudflare $7 and Termius Pro $10 and near RustDesk $11.88, because WebTun replaces SSH client plus tunnel plus file UI in one install. Team $19 sits below Termius Team $20 and near Tailscale Premium $18, because admin value matches but WebTun has no relay cost.

## 4. Unit economics check

Estimate: 1 VPS at $12 per month serves 2,000 paying servers, equals $0.01 each. Email plus checks $0.10. Stripe 2.9 percent plus $0.30. Support at $40 per hour: Pro 0.25 hour per year equals $0.83 per month. Team 1 hour per year equals $3.33 per month. All infra and support numbers are estimates.

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

Anchoring: Team at $19 per seat is the anchor on the pricing page, shown first with the widest card, because a $57 three seat total makes $12 Pro look cheap for solos.
Decoy: Business custom card with SSO, audit, MSA, priced as Contact sales, because it pushes small teams to pick Team annual to avoid a sales call.
Annual framing: show $115 per year as $9.58 per month, billed annually, save $29, plus 2 months free language and a toggle defaulting to annual, because monthly framing tests 20 to 30 percent higher annual take in dev tools.

## 6. Launch pricing vs scale pricing

Launch price for first 90 days: Pro $8 per month or $76 per year, Team $14 per seat or $134 per year, locked for first 200 buyers, because early buyers accept rough edges for a deal and give logos and bug reports.
Why it differs: launch needs conversion data, not max revenue, because elasticity is unknown until 100 paid installs.
Grandfathering: keep launch price 24 months, then scale price with 60 days notice plus annual lock option, because fast hikes destroy trust.
Price increases: Pro to $12 when 100 servers renew at 85 percent plus for 2 months. Team to $19 when NRR passes 110 percent or SSO ships, because those prove value. Announce 30 days ahead, new sales first, then renewals.

## 7. How to implement in the app

Use Stripe Billing plus local license keys, because WebTun runs offline and cannot phone home each request.
Steps: 1) Stripe sells plan, webhook writes signed JWT with plan, seats, expiry. 2) paste key in Settings plus Security, server checks Ed25519 locally, stores in DATA_DIR license.json 0600. 3) gate with COMMERCIAL for Pro and TEAM plus seat count for vault and SSO, because two flags keep server.js checks simple. 4) 7 day grace on expiry, then block SSH and extra hosts but never lock local terminal, because lockouts cause data loss anger.

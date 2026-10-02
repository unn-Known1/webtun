<!-- /founder:go-to-market · 2026-10-03 · input: both, launch paid WebTun Pro and Team for homelab and small teams -->
# Go to market for paid WebTun

Assumption: product is WebTun 2.2.8 plus paid Pro $12 per server and Team $19 per admin with 3 minimum from founder/pricing-strategy.md, free stays noncommercial under PolyForm.
Assumption: audience is homelab owners, solo devs with a VPS, and small MSP teams of 3 to 10 admins.
Assumption: stage is pre launch of paid tiers, launch price Pro $8 per month or $76 per year and Team $14 per seat or $134 per year for 90 days for first 200 buyers, scale is $115 and $182 per year.

## 1. Launch readiness check

Minimum to launch: license MVP from founder/mvp-scope.md, Stripe checkout plus offline verify plus grace plus paste key UI plus SSH gate plus tunnel cap plus device cap, because without the money path there is nothing to buy. Team audit export can lag 2 weeks, because early Teams buy for SSH plus devices first.
Enough users: yes. r/selfhosted about 839k per aggregator Sep 2026, r/homelab about 1.1M estimate, r/HomeServer about 306k estimate, so 100 paid servers is a fraction of a percent even with overlap. Sources: https://gummysearch.com/r/selfhosted and https://prowlo.com/tools/subreddit-stats/selfhosted and https://www.reddit.com/r/selfhosted/ checked 2026-10-03.
Biggest risk: free users see new caps as a takeaway, because tunnels and devices are uncapped today. Fix with grandfathering: current installs keep unlimited tunnels for 6 months plus a banner that explains Pro funds support, because surprise limits spark forks.

## 2. Pre launch (2 to 4 weeks before)

Audience building: join and post help first, do not drop links on day one, because r/selfhosted removes drive by promos under its self promotion rule.

Where they gather:
1. https://www.reddit.com/r/selfhosted/ about 839k, daily setup and release posts.
2. https://www.reddit.com/r/homelab/ about 1.1M, lab builds and remote access threads.
3. https://www.reddit.com/r/HomeServer/ about 306k, small server owners.
4. awesome-selfhosted list at https://github.com/awesome-selfhosted/awesome-selfhosted plus its Discord, lurk first because list PRs need a demo GIF plus license note.
5. Tailscale forum threads on serve mode plus Termius feature request threads, reply only where WebTun plus tailnet fits.

Posts to publish before launch:
1. r/selfhosted: how I reach my homelab terminal plus files over one tunnel without VPN, text post with setup steps, no price mention.
2. r/homelab: photos plus diagram of VPS plus tunnel plus phone SSH, ask for hardening tips.
3. X thread: 5 frames of terminal tabs plus file tabs plus git hunk stage, tag Termius and Tailscale users, not the brands.
4. Blog on repo docs site: SSH from Termius to WebTun in 4 steps, doubles as docs.
5. dev.to: cost math of $12 VPS plus $8 WebTun versus $20 seat tools, with commands inline.

Waitlist: yes, simple email form on GitHub README plus docs hero. Reason to join: lock $8 Pro launch price for 24 months plus vote on audit export shape, because price lock beats early access for this crowd.

Assets:
Landing: hero with npx webtun command, 60 second GIF, Free versus Pro versus Team table with $/mo numbers, FAQ on offline license and grace, because buyers ask will it lock me out first.
Demo: 90 second screen capture, 0 to 20 buy key, 20 to 50 paste plus SSH to Termius, 50 to 90 third tunnel plus session approve. No voiceover music, captions only.
Social proof: [5 quotes from pilot testers on time saved reaching home servers, each with setup photo], because homelab buyers trust photos over logos. Get them by giving free launch Pro for a quote and a bug report with FTC disclosure of the trade.

## 3. Launch day

Core 3 for day one: Hacker News, Reddit, X. LinkedIn plus Product Hunt follow in weeks 1 to 2, because dev infra converts on HN first and Product Hunt needs a full comment shift.

Hacker News: Show HN post, any Tuesday to Thursday morning ET, no launch coordination needed. Title: Show HN: WebTun, self hosted terminal plus files plus tunnels in one tab. Body: try link to demo GIF plus repo, what it replaces, offline license note, PolyForm noncommercial note, no price in title. Never ask friends to upvote, because HN flags it. Stay in comments 6 hours, answer hardening and tunnel questions first, because security threads decide rank.
Reddit: r/selfhosted release post with release flair on Wednesday, format: problem, self hosted proof, limits table, price, GitHub link. Read the sub rules page first and modmail if unsure, because removals hurt more than delays. Skip r/homelab on day one, post there day 3 with lab photos plus flair checked same way.
X: 8 post thread, 1 pain of VPN plus SSH keys, 2 GIF terminal, 3 files plus editor, 4 git hunk, 5 tunnel, 6 SSH to phone, 7 price $8 lock, 8 ask for quote reposts. Tag 3 power users who replied pre launch, not vendors.
LinkedIn week 1: one post Thursday 9am local for MSP angle, format: 3 admin approvals plus audit CSV story, because LinkedIn reaches buyers, not hobbyists. Product Hunt week 2: Tuesday 12:01am PST, self hunt, no paid hunter, maker comment in first hour, ask people to look not to upvote, because paid votes get removed. Source: https://www.producthunt.com/launch checked 2026-10-03.

## 4. Post launch growth (first 90 days)

Channel ranking:
1. Reddit help plus release posts. CAC estimate $0 to $5 in time, 2 hours at $40 per hour across 20 replies. Results in 1 to 2 weeks. First action: answer 5 remote access threads this week with setup steps, link only when asked.
2. Search docs and blog. CAC estimate $0. Results in 30 to 60 days. First action: publish Termius plus Tailscale plus Cloudflare tunnel setup pages, each with copy paste commands.
3. GitHub plus awesome lists. CAC estimate $0. Results in 2 to 4 weeks. First action: PR to awesome-selfhosted with demo GIF plus license note.
4. X build in public. CAC estimate $0. Results in 7 days. First action: weekly changelog video under 60 seconds.
5. MSP partners and VPS hosts. CAC estimate $20 to $60, outreach time plus demo box. Results in 60 to 90 days. First action: reply in 10 existing Hetzner and DigitalOcean community threads offering a setup script, no cold email blast, because spam flags burn the account.

Content that matches search intent:
1. Reach Proxmox terminal from phone safely, share to r/Proxmox plus blog, reuse as GIF on X.
2. Termius to home server without port forward, share to r/selfhosted plus docs, reuse as email onboarding day 3.
3. Cloudflare tunnel versus Tailscale for one box, share to blog plus HN comment, reuse as comparison table on pricing page.
4. Fix tunnel dead after restart with watchdog, share to troubleshooting docs plus Reddit comment, reuse as support macro.
5. Export audit CSV for 3 person team, share to LinkedIn plus MSP email, reuse as Team upsell in app.

Communities and partnerships:
Join: r/selfhosted at https://www.reddit.com/r/selfhosted/, r/homelab at https://www.reddit.com/r/homelab/, r/HomeServer at https://www.reddit.com/r/HomeServer/. All public and active Sep 2026.
Partnerships: 1) Tailscale serve plus WebTun guide for browser terminal inside a tailnet, posted to the Tailscale forum. 2) VPS setup script with Hetzner and DigitalOcean images that preinstall npx webtun, linked from docs.
One tactic specific to this product: license key in tunnel-url.txt starter bundle, because every tunnel user opens that file, so a Pro upsell line there is seen at the exact moment of value.

## 5. Launch metrics

1. Paid servers. Targets: 20 by day 30, 60 by day 60, 100 by day 90. Tool: Stripe plus license.json count. If low, cut Pro friction: add Apple Pay plus test key in docs.
2. Upgrade click to paid rate. Targets: 3 percent by day 30, 5 percent by day 60, 7 percent by day 90. Tool: PostHog upgrade_click plus checkout_paid with Stripe sessions. If low, move price table above fold and add $8 lock timer.
3. Key paste success. Targets: 90 percent by day 30, 93 percent by day 60, 95 percent by day 90. Tool: server log of key_verify_ok versus key_verify_fail. If low, fix key copy format and add paste button.
4. Week 4 active paid. Targets: 70 percent by day 30 cohort, 80 percent by day 60, 85 percent by day 90. Tool: tunnel plus SSH use in last 7 days. If low, email grace plus SSH recipe sequence.
5. Refund and chargeback rate. Targets: under 4 percent by day 30, under 3 percent by day 60, under 2 percent by day 90. Tool: Stripe. If high, fix caps messaging and extend grace to 14 days.

For full setup see founder/metrics-dashboard.

## 6. Budget

Budget $200 per month for months 1 to 3.
Split: $0 Reddit plus X plus HN plus blog, $80 domain plus email plus Plausible, $70 test VPS on Hetzner for demos, $50 prize pool for 5 quote bounties at $10 each. Nothing to ads until 100 paid, because CAC is unknown and free pools are large.
Free work covers all reach. Pay only for proof: demo box, email deliverability, analytics.
One spend under $200 with best return: $70 Hetzner VPS plus $10 bounty each for 5 video quotes, total $120, because homelab buyers convert on real phone plus tunnel videos, and those assets reuse on README, docs, X, and Product Hunt.

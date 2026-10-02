<!-- /founder:go-to-market · 2026-10-03 · input: both, launch paid WebTun Pro and Team for homelab and small teams -->
# Go to market for paid WebTun

Assumption: product is WebTun 2.2.8 plus paid Pro $12 and Team $19 from founder/pricing-strategy.md.
Assumption: audience is homelab owners, solo devs with a VPS, and small MSP teams of 3 to 10 admins.
Assumption: stage is pre launch of paid tiers, launch price Pro $8 and Team $14 for 90 days for first 200 buyers.

## 1. Launch readiness check

Minimum to launch: license MVP from founder/mvp-scope.md plus paste key UI plus SSH gate plus tunnel cap, because without those there is nothing to buy. Team audit export can lag 2 weeks, because early Teams buy for SSH plus devices first.
Enough users: yes. r/selfhosted has about 839k members and r/homelab has about 1.1M members as of Sep 2026, plus r/HomeServer at 306k, so 100 paid servers is 0.005 percent of that pool. Sources: https://gummysearch.com/r/selfhosted and https://prowlo.com/tools/subreddit-stats/selfhosted checked 2026-10-03.
Biggest risk: free users see new caps as a takeaway, because tunnels and devices are uncapped today. Fix with grandfathering: current installs keep unlimited tunnels for 6 months plus a banner that explains Pro funds support, because surprise limits spark forks.

## 2. Pre launch (2 to 4 weeks before)

Audience building: join and post help first, do not drop links on day one, because r/selfhosted removes drive by promos under its self promotion rule.

Where they gather:
1. https://www.reddit.com/r/selfhosted/ about 839k, daily setup and release posts.
2. https://www.reddit.com/r/homelab/ about 1.1M, lab builds and remote access threads.
3. https://www.reddit.com/r/HomeServer/ about 306k, small server owners.
4. awesome-selfhosted GitHub topic and Discord, plus Tailscale and Termius user threads on X.
5. Hacker News, Show HN queue for launch day only.

Posts to publish before launch:
1. r/selfhosted: how I reach my homelab terminal plus files over one tunnel without VPN, text post with setup steps, no price mention.
2. r/homelab: photos plus diagram of VPS plus tunnel plus phone SSH, ask for hardening tips.
3. X thread: 5 frames of terminal tabs plus file tabs plus git hunk stage, tag Termius and Tailscale users, not the brands.
4. Blog on repo docs site: SSH from Termius to WebTun in 4 steps, doubles as docs.
5. Indie Hackers or dev.to: cost math of $12 VPS plus $8 WebTun versus $20 seat tools.

Waitlist: yes, simple email form on GitHub README plus docs hero. Reason to join: lock $8 Pro launch price for 24 months plus vote on audit export shape, because price lock beats early access for this crowd.

Assets:
Landing: hero with npx webtun command, 60 second GIF, Free versus Pro versus Team table with $/mo numbers, FAQ on offline license and grace, because buyers ask will it lock me out first.
Demo: 90 second screen capture, 0 to 20 buy key, 20 to 50 paste plus SSH to Termius, 50 to 90 third tunnel plus session approve. No voiceover music, captions only.
Social proof: 5 quotes from first 10 license testers on time saved reaching home servers, each with setup photo, because homelab buyers trust photos over logos. Get them by giving free launch Pro for a quote and a bug report.

## 3. Launch day

Pick 3: Hacker News, Reddit, X. Add Product Hunt only as week 2, because dev infra does better on HN first and Product Hunt needs a full day of comment duty.

Hacker News: Show HN post on Tuesday 9am ET. Title: Show HN: WebTun, self hosted web terminal plus files plus tunnels, now with $8 Pro license. Body: what it replaces, offline license note, PolyForm noncommercial note. Stay in comments 6 hours, answer hardening and tunnel questions first, because security threads decide HN rank.
Reddit: r/selfhosted release post with Release flair on Wednesday, format: problem, self hosted proof, limits table, price, GitHub link. Follow the 10 to 1 help rule and modmail first if unsure, because removals hurt more than delays. Skip r/homelab on day one, post there day 3 with lab photos.
X: 8 post thread, 1 pain of VPN plus SSH keys, 2 GIF terminal, 3 files plus editor, 4 git hunk, 5 tunnel, 6 SSH to phone, 7 price $8 lock, 8 ask for quote reposts. Tag 3 power users who replied pre launch, not vendors.
LinkedIn: one post Thursday 9am local for MSP angle, format: 3 admin approvals plus audit CSV story, because LinkedIn reaches buyers, not hobbyists. Skip Product Hunt day one. When ready: Tuesday 12:01am PT, self hunt, no paid hunter, ask people to look not to upvote, because paid votes get removed. Source: https://www.producthunt.com/launch checked 2026-10-03.

## 4. Post launch growth (first 90 days)

Channel ranking:
1. Reddit help plus release posts. CAC estimate $0 to $5 in time. Results in 1 to 2 weeks. First action: answer 5 remote access threads this week with setup steps, link only when asked.
2. Search docs and blog. CAC estimate $0. Results in 30 to 60 days. First action: publish Termius plus Tailscale plus Cloudflare tunnel setup pages, each with copy paste commands.
3. GitHub plus awesome lists. CAC estimate $0. Results in 2 to 4 weeks. First action: PR to awesome-selfhosted with demo GIF plus license note.
4. X build in public. CAC estimate $0. Results in 7 days. First action: weekly changelog video under 60 seconds.
5. MSP partners and VPS hosts. CAC estimate $20 to $60 estimate. Results in 60 to 90 days. First action: email 10 Hetzner and DigitalOcean community posters for affiliate test.

Content that matches search intent:
1. Reach Proxmox terminal from phone safely, share to r/Proxmox plus blog, reuse as GIF on X.
2. Termius to home server without port forward, share to r/selfhosted plus docs, reuse as email onboarding day 3.
3. Cloudflare tunnel versus Tailscale for one box, share to blog plus HN comment, reuse as comparison table on pricing page.
4. Fix tunnel dead after restart with watchdog, share to troubleshooting docs plus Reddit comment, reuse as support macro.
5. Export audit CSV for 3 person team, share to LinkedIn plus MSP email, reuse as Team upsell in app.

Communities and partnerships:
Join: r/selfhosted at https://www.reddit.com/r/selfhosted/, r/homelab at https://www.reddit.com/r/homelab/, r/HomeServer at https://www.reddit.com/r/HomeServer/. All public and active Sep 2026.
Partnerships: 1) Tailscale serve plus WebTun guide for users who want browser terminal inside a tailnet. 2) VPS setup script with Hetzner and DigitalOcean one click images that preprint npx webtun.
One tactic specific to this product: license key in tunnel-url.txt starter bundle, because every tunnel user opens that file, so a Pro upsell line there is seen at the exact moment of value.

## 5. Launch metrics

1. Paid servers. Targets: 20 by day 30, 60 by day 60, 100 by day 90. Tool: Stripe plus license.json count. If low, cut Pro friction: add Apple Pay plus test key in docs.
2. Upgrade click to paid rate. Targets: 3 percent, 5 percent, 7 percent. Tool: Plausible on docs plus Stripe sessions. If low, move price table above fold and add $8 lock timer.
3. Key paste success. Targets: 90 percent, 93 percent, 95 percent. Tool: server log of verify ok versus fail. If low, fix key copy format and add paste button.
4. Week 4 renewal intent. Targets: 70 percent active, 80 percent, 85 percent. Tool: tunnel plus SSH use in last 7 days. If low, email grace plus SSH recipe sequence.
5. Refund and chargeback rate. Targets: under 4 percent, under 3 percent, under 2 percent. Tool: Stripe. If high, fix caps messaging and extend grace to 14 days.

For full setup see founder/metrics-dashboard when ready.

## 6. Budget

Budget $200 per month for months 1 to 3.
Split: $0 Reddit plus X plus HN plus blog, $80 domain plus email plus Plausible, $70 test VPS on Hetzner for demos, $50 prize pool for 5 quote bounties at $10 each. Nothing to ads until 100 paid, because CAC is unknown and free pools are large.
Free work covers all reach. Pay only for proof: demo box, email deliverability, analytics.
One spend under $200 with best return: $70 Hetzner VPS plus $10 bounty each for 5 video quotes, total $120, because homelab buyers convert on real phone plus tunnel videos, and those assets reuse on README, docs, X, and Product Hunt.

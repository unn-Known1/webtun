<!-- /founder:metrics-dashboard · 2026-10-03 · input: founder/metrics-dashboard for the 90 day tracking setup -->
# Metrics dashboard for paid WebTun

Assumption: free app is post launch at v2.2.8, paid Pro and Team are pre launch, so focus is activation plus first 100 paid servers.
Assumption: no raise planned in 6 months, so investor section is a short note at the end.

## 1. Stage assessment

| Stage | Focus | Key metrics |
|-------|-------|-------------|
| Pre launch paid | Validation | Waitlist signups, pilot conversion, key paste success |
| Post launch 0 to 100 paid | Engagement plus revenue | Activation rate, paid servers, week 4 active, refund rate |
| Growth 100 to 1000 | Retention and revenue | MRR, churn, NRR, CAC, SSH adoption |

You sit between pre launch and post launch. Track the 5 below weekly, because they decide price, gates, and support load before scale metrics matter.

## 2. The five metrics

1. Paid servers
Definition: count of servers with a valid Pro or Team key in DATA_DIR/license.json at week end.
Current: 0, count from Stripe active subs cross checked with verify ok logs.
Targets: 20 by day 30, 60 by day 60, 100 by day 90.
Why: decides if $8 launch price converts, because installs without pay mean gate or message miss.
If below: add Apple Pay plus Google Pay to checkout and put a test key flow in docs, because card friction kills homelab checkout.

2. Upgrade click to paid rate
Definition: Stripe paid sessions divided by Upgrade clicks from Settings plus Security within 7 days.
Current: no data, instrument click event this week.
Targets: 3 percent by day 30, 5 percent by day 60, 7 percent by day 90.
Why: separates traffic from offer strength, because visits can grow while price blocks.
If below: move Free versus Pro table above the fold and add the $8 lock timer, because urgency plus clarity lifts dev tool checkout.

3. Key paste success
Definition: license verify ok divided by verify attempts from server log per week.
Current: no data, log ok versus fail from lib/license.js from day one.
Targets: 90 percent by day 30, 93 percent by day 60, 95 percent by day 90.
Why: decides if key format plus UI works, because failed paste looks like a broken product.
If below: shorten key, add copy button plus paste button, accept whitespace trim, because email clients wrap long keys.

4. Week 4 active paid
Definition: share of paid servers with a tunnel start or SSH key use in the last 7 days at week 4 after purchase.
Current: no data, compute from tunnels Map plus POST /api/ssh/credentials counts.
Targets: 70 percent by day 30 cohort, 80 percent by day 60, 85 percent by day 90.
Why: predicts renewal, because idle boxes cancel at month 2.
If below: send day 3 SSH recipe plus day 10 third tunnel nudge, because both events mark value found.

5. Refund rate
Definition: refunds divided by paid orders in the trailing 30 days from Stripe.
Current: 0 with no sales.
Targets: under 4 percent by day 30, under 3 percent by day 60, under 2 percent by day 90.
Why: flags cap shock or grace bugs, because surprise limits drive refunds before support tickets.
If above: extend grace to 14 days and rewrite cap toasts to name the exact limit, because clear errors cut anger refunds.

## 3. Metrics to ignore

1. Total installs. Feels like growth because npx counts climb. Misleads because free installs pay no bills. Track paid servers instead.
2. Page views on docs. Feels like demand. Misleads because readers lurk without servers. Track Upgrade clicks instead.
3. X followers. Feels like reach. Misleads because followers rarely paste keys. Track quote reposts with setup photos instead.
4. Total revenue. Feels like the headline. Misleads because one Team pack hides churn. Track MRR plus refund rate instead.
5. Tunnel starts raw count. Feels like usage. Misleads because free tunnels inflate it. Track paid tunnel share instead.

## 4. Tracking setup

| Need | Tool | Cost | Setup time |
|------|------|------|------------|
| Product analytics | PostHog Cloud free, 1M events per month, no card | $0 | 1 hour |
| Revenue tracking | Stripe Billing plus Dashboard | 2.9 percent plus $0.30 per charge | 2 hours with checkout |
| Site stats | Plausible or PostHog web analytics | Plausible from $9 per month, PostHog web free in event quota | 30 min |
| User feedback | GitHub Issues plus Discussions | $0 | 15 min with templates |
| Dashboard | PostHog dashboard plus Stripe Dashboard | $0 extra | 1 hour weekly review |

Pricing sources checked 2026-10-03: PostHog free 1M events at https://posthog.com/pricing, Stripe fees at https://stripe.com/pricing, Plausible plans at https://plausible.io/pricing.

Events to track, 13 total:
1. upgrade_click, fires on Upgrade button, tells top of funnel size.
2. checkout_start, fires on Stripe redirect, tells intent after price view.
3. checkout_paid, fires on webhook success, tells conversion.
4. key_paste_attempt, fires on paste submit, tells friction base.
5. key_verify_ok and key_verify_fail, fire from lib/license.js, tell format versus fraud split.
6. ssh_key_created, fires on POST /api/ssh/credentials, tells Pro value hit.
7. third_tunnel_start, fires when live tunnels exceed 2, tells paywall touch.
8. session_approve, fires on approve route, tells Team workflow use.
9. history_export, fires on export click, tells audit value.
10. grace_enter, fires on expiry plus 7 days, tells at risk cohort.
11. refund_issued, fires from Stripe webhook, tells cap or promise miss.
12. docs_price_view, fires on pricing anchor view, tells message reach.

## 5. Weekly review template

```
Week of: ___
Paid servers: ___ (last week: ___)
Upgrade to paid: ___ percent (target: ___ percent)
Key paste success: ___ percent (target: ___ percent)
Week 4 active paid: ___ percent (target: ___ percent)
Refund rate: ___ percent (target: ___ percent)

What worked: ___
What didn't: ___
One thing to try this week: ___
```

Run Mondays, 15 minutes max, owner plus one support reader, because speed beats depth at this size.

## 6. Investor ready metrics

No raise planned in 6 months, so keep this light. When asked later, show MRR, refund churn, week 4 active, and CAC from the $120 launch pool with $50 bounties plus $70 VPS, all from Stripe plus PostHog exports above, because paid proofs beat pitch claims.

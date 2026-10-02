<!-- /founder:mvp-scope · 2026-10-03 · input: both, scope paid license MVP compatible with WebTun 2.2.8 -->
# Mvp scope for paid WebTun

## 1. Feature triage

Scope is the paid license layer only. The app already ships, so triage covers gates and billing, not the terminal or files again.

| Feature | Category | Reasoning |
|---------|----------|-----------|
| Ed25519 license verify in lib/license.js | Must have | No paid gate works without offline key checks because servers run offline behind tunnels. |
| Stripe checkout plus webhook that signs keys | Must have | Takes money and issues keys without manual email because manual keys do not scale past 20 buyers. |
| Settings plus Security paste key box with status | Must have | Gives the buy to paid path in under 60 seconds because admins live in that panel already. |
| Gate POST /api/ssh/credentials behind Pro | Must have | SSH keys are the top paid reason and the route already needs PIN, so one check gates it. |
| Gate concurrent tunnels to 2 free and unlimited paid | Should have | Creates a visible paywall for power users because most solos hit 3 tunnels first. |
| Gate trusted devices to 3 free and 5 Pro and 10 Team | Should have | Turns existing session list into Team value because extra phones and laptops force upgrades. |
| History cap 200 free and 1000 Pro plus export | Should have | Cheap to build since .cmdhist.json already stores max, and export sells audit value. |
| PREVIEW_PORTS plus ALLOWED_ORIGINS UI editor | Should have | Moves two env only knobs into Settings because Teams pay for policy control. |
| Shared command library plus bookmarks export | Should have | Reuses commands.js and places files, so sharing is a file export before any sync server. |
| Audit export CSV | Should have | Bundles history plus ssh events plus session list because compliance buyers ask for it first. |
| OIDC SSO | Won't have | Needs new deps plus CSP review plus IdP testing, weeks of work before any SSO buyer exists. |
| SCIM and org directory sync | Won't have | Only matters past 50 seats, and no directory buyer is waiting now. |
| Usage metering per GB or per minute | Won't have | Self hosted use is easy to fake and disputes cost more than it earns at this stage. |
| Central multi server seat server | Won't have | Per server keys already cover solo to small team, and a central server adds uptime risk. |
| Native mobile app | Won't have | PWA already installs on iOS and Android, so a native shell adds store pain for zero new value. |
| Realtime shared vault sync | Won't have | File export covers sharing for 10 admins, and live sync needs conflict logic nobody requested. |

## 2. Mvp definition

A user can buy Pro, paste a key, and get commercial SSH plus unlimited tunnels in under 5 minutes.

Features that make it possible, 5 total:
1. Stripe checkout plus webhook key signer
2. Offline license verify plus grace logic
3. Paste key UI in Settings plus Security
4. Pro gate on SSH credential routes
5. Pro gate on tunnel count plus device count

## 3. User flow

```
Step 1: User runs npx webtun on a VPS and opens Settings plus Security, sees Free plus Upgrade button.
Step 2: User clicks Upgrade, pays on Stripe, gets a key by email plus on screen in under 60 seconds.
Step 3: User pastes the key, sees Pro active plus expiry, SSH button lights up in under 30 seconds.
Step 4: User creates an SSH key for Termius and starts a third tunnel, gets paid value in under 2 minutes.
Step 5: User hits annual upsell with save $29 note and stays, or team lead clicks Team seats.
```

## 4. Technical scope

Build vs buy: build lib/license.js plus checkLicense middleware plus gates, because they are 200 lines and touch checkPin patterns. Buy Stripe Billing plus Checkout plus Customer Portal, because tax plus cards plus отмены plus portal are not worth rebuilding. Buy Resend or Postmark for key email, because SMTP self hosting hurts deliverability.

Stack: Node plus Express already in repo, node:crypto Ed25519, no new prod deps because packaging rules favor zero deps. Webhook signer runs as one more Express route on the same VPS or a $0 Railway service, not a new stack.

Build time for one full stack dev:
1. License sign plus verify plus DATA_DIR/license.json 0600: 6 hours, because format plus atomic write plus tests.
2. Stripe checkout plus webhook plus portal link: 6 hours, because webhook secret plus seat count mapping.
3. Settings UI paste plus status plus grace banner: 5 hours, because it mirrors PIN panels.
4. SSH gate plus tunnel cap plus device cap plus history cap: 5 hours, because four small middleware checks plus toasts.
5. Docs update in public/docs.html plus TOC: 2 hours, because rule needs it in the same change.
Total: 24 hours across 3 weeks at 8 hours per week, because solo pace with review.

Hosting: license webhook on Railway Free at $0 with $5 one time trial credit, 512MB RAM and 1GB disk, then Hobby $5 per month minimum when credits run out. Source: https://railway.com/pricing checked 2026-10-03 via comparison review. Do not use Fly.io for this, because new accounts have no free tier and pay from about $1.94 per month for the smallest Machine. Source: https://fly.io/docs checked 2026-10-03 via review. App itself stays on user hardware, so no hosting cost per install.

## 5. What you are not building, and why

1. OIDC SSO. Feels important because Termius Business sells it. It does not matter before 10 Team buyers, because no buyer asked for it. Revisit at 10 Team servers or first lost deal citing SSO.
2. SCIM. Feels important for IT. It does not matter before 50 seats. Revisit at 50 paid seats.
3. Usage metering. Feels fair to charge heavy users. It does not matter while flat $12 converts, because metering adds bypass drama. Revisit at 500 paid servers with tunnel abuse data.
4. Central seat server. Feels needed for fleets. Per server keys cover 1 to 10 admins, because each box checks its own key. Revisit at 20 servers per customer.
5. Native mobile app. Feels expected. PWA plus Termius over SSH already covers phones, because the paid value is access, not an icon. Revisit at 200 PWA installs asking for push.

## 6. Launch criteria

Done checklist:
1. `npm start` passes with no key, Free banner shows, all current features work.
2. Test Stripe card buys Pro, key email arrives, paste turns on Pro in under 60 seconds.
3. Expired key gives 7 day grace, then SSH plus third tunnel block with clear toast, loopback terminal never blocks.
4. Revoked key fails closed on next check with server log line, no crash.
5. Tunnel cap counts only live entries in tunnels Map, recycled PIDs do not count.
6. Device cap counts active sessions from GET /api/auth/sessions, pending logins do not count.
7. Docs page lists Free versus Pro limits with TOC link.

Can be broken or ugly:
1. Team seats are manual quantity on Stripe, no self serve quantity slider yet.
2. Audit export is CSV only, no PDF styling.
3. License UI is one input plus status line, no usage graphs.

One thing to test with first 10 users: time from Upgrade click to third tunnel running on Pro, because that path proves willingness to pay.

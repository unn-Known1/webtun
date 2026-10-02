<!-- /founder:landing-page · 2026-10-03 · input: founder/landing-page for the Free versus Pro table -->
# Landing page for WebTun

Assumption: reader is a homelab owner or solo dev with one VPS or home server who hates VPN setup.
Assumption: prices match founder/pricing-strategy.md: Community $0, Pro $12, Team $19, launch $8 lock for 200 buyers.

## 1. Hero

Headline: Your server terminal and files in any browser
Subheadline: For homelab owners and solo devs who want SSH plus files plus tunnels without a VPN, open ports, or a client install.
Button text: Open my server in a browser
Proof line: [Paid pilot count, target 20 by day 30]

## 2. Problem

Headline: You should not need a VPN to check one log file

1. You are away from home and need one file, but **no safe remote path** exists except opening SSH to the world or starting a full VPN.
2. You pass keys and ports over chat when a friend helps, and **shared access feels unsafe** because revoke means editing authorized_keys by hand.
3. You run four tools for one box, and **terminal plus files plus tunnel live apart** across Termius, SFTP apps, and Cloudflare dashboards.

## 3. Solution

Headline: One install gives you terminal, files, and a share link

Terminal that survives refresh
You keep shells across reloads through tmux or in memory persist, with tabs and tiles for parallel work. Concrete detail: paste works in vim and htop through 60KB chunks, and history strips ANSI noise into .cmdhist.json.

Files plus code without SFTP
You browse, upload, zip, and edit with drafts that offer restore after 2 seconds, plus a git panel for hunk stage and push. Concrete detail: code files open in tabs up to 10, with per tab save and panel handoff.

Remote link in one click
You create a Cloudflare tunnel from Settings and share the URL, with PIN plus device approval guarding entry. Concrete detail: tunnels persist across restarts with backoff to 300s, and preview ports stay gated by PREVIEW_PORTS.

## 4. How it works

1. Run it: type npx webtun on your server, open localhost:3000.
2. Lock it: set a PIN in Settings plus Security, approve your phone as a trusted device.
3. Use it: open terminal tabs, edit files, start a tunnel for remote nights.
4. Upgrade it: paste a Pro key to light up SSH keys and a third tunnel in under a minute.

Total path stays under 5 minutes on a fresh VPS, because no account signup sits in front of first shell.

## 5. Social proof

Stage: early paid pilot on top of a shipped 2.2.8 free base. Use pilot quotes, not logo bar, because paid count is still under 100.

[Quote from a homelab owner: nights away per month before versus after, and what they replaced]
[Quote from a solo dev: time to reach a VPS log from a phone, and what broke before]

Get both by trading launch Pro at $8 for a photo plus a bug report, because photos of phone plus tunnel convert this crowd.

## 6. Pricing preview

Free versus Pro table, full tiers on pricing page:

Community $0: noncommercial, 2 tunnels, 3 devices, history 200, community support.
Pro $12 per server per month, $115 per year: commercial use, unlimited tunnels, 5 devices, SSH ed25519 keys, history 1000, email support.
Team $19 per admin per month, 3 minimum: up to 10 admins, shared library, audit CSV, policy UI, priority chat.

Worth it line: one avoided late drive home pays for a year of Pro, because remote shell plus files beats fuel and time.

## 7. FAQ

Will a license lock me out of my own server?
No. License checks gate SSH keys and extra tunnels only. Loopback terminal stays open, and expiry gives a 7 day grace with a banner, because lockouts on owned hardware are unacceptable.

How does offline licensing work?
You paste a signed key in Settings plus Security. The server checks an Ed25519 signature with node:crypto and stores DATA_DIR/license.json at 0600. No call home per request, because servers sit behind tunnels and NAT.

What about my data and privacy?
Shells, files, and tunnels run on your box. Stripe handles cards, the license holds plan plus seats plus expiry only, and PIN plus session approval plus origin checks guard routes, because your keystrokes should never cross our servers.

What changes for current free users?
Nothing for 6 months. Current installs keep current tunnel behavior, then the 2 tunnel Free cap applies with 60 days notice, because surprise caps spark forks.

Do you offer refunds?
Yes, 30 days, no forms. Email from your Stripe receipt and we revoke the key the same day, because $8 to $12 should feel safe to try.

## 8. Final call to action

Headline: Reach your server tonight without opening a port
Button: Open my server in a browser
Risk reversal: launch Pro at $8 per month for the first 200 buyers, locked 24 months, 30 day refund, because early buyers fund support with zero risk.

## 9. SEO metadata

Title tag: WebTun: self hosted web terminal, files and tunnels (57 chars)
Meta description: WebTun puts your Linux terminal, file manager, git panel, and Cloudflare tunnels in one browser tab. Install with npx, guard with PIN, add SSH keys on Pro. (158 chars)
Keywords: self hosted web terminal, browser SSH client, Cloudflare tunnel UI

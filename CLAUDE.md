# World Cup 2026 Friends Bet Game

A friends-only prediction game for FIFA World Cup 2026, hosted on GitHub
Pages with Firebase Auth + Firestore as the backend. Every registered
friend starts with **1000 points** and bets across the tournament — match
result, exact score, halftime, over/under, both-teams-to-score.

Not for real money. For friends.

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | Static HTML + Tailwind CDN + vanilla JS | No build step. GitHub Pages serves directly. |
| Auth | Firebase Auth — Google sign-in | One-click for any Gmail user. |
| Database | Firestore (free tier) | Real-time listeners → leaderboard auto-updates. |
| Hosting | GitHub Pages (the `public/` folder) | Anzon's preference; firebase config is client-side OK. |
| Live scores | Admin enters manually (MVP) | API auto-pull is Phase 2. |

## Folder layout

```
public/                    ← deploy this folder to GitHub Pages
  index.html               ← landing, login, dashboard, betting, leaderboard
  admin.html               ← admin panel: edit fixtures, set odds, settle bets
  css/style.css            ← Tailwind utilities + custom polish
  js/
    firebase-config.js     ← USER FILLS IN — Firebase project keys
    firebase-config.example.js  ← committed template
    main.js                ← player-facing app logic
    admin.js               ← admin panel logic
    markets.js             ← bet evaluation rules per market type
  data/
    fixtures.json          ← World Cup match list (kickoff times, teams)
firestore.rules            ← security rules (deploy to Firebase)
.gitignore                 ← excludes firebase-config.js
README.md                  ← setup guide
```

## Markets supported (MVP)

| Market | Code | Settles on |
|--------|------|------------|
| Match result (1X2) | `1x2` | Full-time score: home/draw/away |
| Exact score | `score` | Full-time score: exact match |
| Halftime result | `ht1x2` | Halftime score: home/draw/away |
| Over/Under 2.5 | `ou25` | Total goals at full-time |
| Both teams to score | `btts` | Yes/No at full-time |

Phase 2 (post-MVP): Asian Handicap, first goalscorer.

## Currency

Each user starts with **1000 points** on first sign-in. Points are stored
in the user document. Bets deduct stake on confirmation; winnings credit
on settlement.

Stake min = 10, max = 200 per bet (to prevent all-in stupidity).

Negative balance is not allowed.

## Bet cutoff

Bets close at match `kickoff_iso` time. The frontend enforces this; the
admin can manually override if needed.

## Admin

Admins are identified by email (allowlist in Firestore at
`config/admin_emails`). The admin panel can:
- Edit/import fixtures
- Set per-match odds (per market)
- Enter final scores
- Trigger bet settlement for a match
- View all users' balances and bets

## Settlement

When admin enters a final score and clicks "Settle":
1. Read all bets where `match_id == X` AND `status == "open"`.
2. For each bet, evaluate via `markets.js` (`evaluateBet(bet, final_score)`).
3. If won: credit `stake * odds` to user balance, set bet `status = "won"`.
4. If lost: bet `status = "lost"`, no credit.
5. Mark match as `status = "settled"`.

Settlement is idempotent — re-running on a settled match is a no-op.

## Privacy / invite

Set `config/invite_only = true` and add allowed emails to
`config/invited_emails`. First-time sign-in checks the allowlist.

## Hostnames

- Source: GitHub repo `worldcup-bet-2026` (or similar)
- Live: `<username>.github.io/worldcup-bet-2026/`
- Custom domain (optional): point a subdomain at GitHub Pages

## Free tier sanity check

For ~20 friends × 64 matches × ~5 bets each = 6,400 bet documents over
the tournament. Plus 20 user docs, 64 match docs, settlement reads.
Well within Firestore free tier (50K reads/day, 20K writes/day, 1GB).

## Important rules

1. Never commit `firebase-config.js` (gitignored). Use the `.example` file
   as the public template.
2. Set Firestore rules so users can read their own bets but cannot edit
   another user's balance directly. See `firestore.rules`.
3. Admin actions go through admin.html and are guarded by the
   `admin_emails` list. Do NOT trust client-side checks alone — Firestore
   rules must enforce this server-side.
4. Disclaimer in footer: "For friends. No real money."

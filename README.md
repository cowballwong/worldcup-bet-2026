# World Cup 2026 Bet Game — Setup Guide

A friends-only prediction game for FIFA World Cup 2026. Everyone gets
**1000 points** to bet across the tournament. Top of the leaderboard
at the end wins (bragging rights only — no real money).

## Setup steps (~30 min total, one-time)

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com/
2. **Add project** → name it `worldcup-bet-2026` (or whatever)
3. Disable Google Analytics (not needed)
4. Wait for it to finish setting up

### 2. Enable Google Sign-in

1. In the Firebase console: **Authentication** → **Get started**
2. **Sign-in method** tab → **Google** → toggle **Enable**
3. Set the project support email (your own Gmail)
4. Save

### 3. Create Firestore Database

1. **Firestore Database** → **Create database**
2. Start in **production mode**
3. Pick a region close to your friends (e.g. `europe-west2` for UK, `asia-east2` for HK)
4. After creation, go to **Rules** tab and paste the contents of
   `firestore.rules` from this repo. Click **Publish**.

### 4. Get your Firebase config

1. **Project settings** (gear icon, top-left) → **General** tab
2. Scroll to **Your apps** → click the `</>` (Web) icon to register a
   web app
3. Name it `worldcup-bet-web` → **Register app**
4. Copy the `firebaseConfig` object — it looks like:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy…",
     authDomain: "worldcup-bet-2026.firebaseapp.com",
     projectId: "worldcup-bet-2026",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
5. Open `public/js/firebase-config.example.js`, copy it to
   `public/js/firebase-config.js`, and paste your config in.

> ⚠️ Never commit `firebase-config.js`. It's already in `.gitignore`.

### 5. Add yourself as an admin

In the Firestore console:

1. Create a collection called `config`
2. Add a document with ID `admin_emails`
3. Add a field: `emails` of type **array**, with your Gmail address as
   the first element (e.g. `["cowballwong@gmail.com"]`).

This lets you access `admin.html` to set scores and odds.

### 6. (Optional) Lock invites

If you want only specific friends to play:

1. In `config`, add a document with ID `invite`
2. Add field `invite_only` (boolean) = `true`
3. Add field `allowed_emails` (array) with each friend's Gmail.

If `invite_only` is `false` (or the doc is missing), anyone with a
Gmail can join.

### 7. Push to GitHub and enable Pages

```bash
cd public-build-location/worldcup-bet-2026  # see "Build location" below
git init
git add .
git commit -m "Initial scaffold"
git branch -M main
git remote add origin https://github.com/<your-user>/worldcup-bet-2026.git
git push -u origin main
```

Then in the GitHub repo:

1. **Settings** → **Pages**
2. **Source**: deploy from a branch
3. **Branch**: `main` → folder: `/public`
4. Save. After ~1 minute your game is live at
   `https://<your-user>.github.io/worldcup-bet-2026/`

### 8. Add the deployed URL to Firebase's allowed origins

In the Firebase console:

1. **Authentication** → **Settings** → **Authorized domains**
2. Add `<your-user>.github.io`

Without this, sign-in will fail with `auth/unauthorized-domain`.

### 9. Test

1. Open the live URL
2. Sign in with your Gmail
3. You should land on the dashboard with **1000 points** showing
4. Open `/admin.html` — should let you in (because of step 5)
5. Try entering a sample score and settling a fake bet

You're live.

## Build location (per workspace rules)

Per the AI_Development workspace rule, do not run `git` operations on
the G: drive. The recommended pattern:

1. Edit source under `G:\My Drive\AI_Development\04_family\11_worldcup-bet\`
2. `robocopy` it to a local C: location, e.g. `C:\worldcup-bet-2026\`
3. Run git commands and push from C:

There's no `npm install` here — it's pure static HTML/JS using CDN
libraries — so the build location is just for git hygiene.

## Day-to-day: how Anzon uses this

1. **Before tournament**: open `admin.html`. Verify `fixtures.json`
   covers the whole schedule. Set odds for the first batch of matches.
2. **Before each match**: optionally update odds based on news (lineups,
   weather, etc.). Bets auto-close at kickoff.
3. **After each match**: open `admin.html` → find the match → enter
   final score (and halftime score) → click **Settle**. All bets on
   that match are evaluated and balances updated in real time. Friends
   see the leaderboard shift immediately.

## How friends use this

1. Open the URL
2. Sign in with Gmail (one click)
3. Browse upcoming matches → pick one → choose a market → enter stake → confirm
4. Wait for the match to finish
5. After settlement, check the leaderboard
6. Talk trash in your group chat

## Disclaimer

This is a friends game. No real money. No real bookmaker is involved.
Don't post the URL publicly — keep it among your friends.

## Future (Phase 2)

- Auto-pull live scores via `football-data.org` API (free tier) so
  admin doesn't have to enter scores manually
- Telegram bot integration: bet reminders before kickoff, settlement
  notifications after final whistle
- Asian Handicap, First Goalscorer markets
- Knockout-stage achievements (e.g. "called the Cinderella story")
- In-play betting (bet while the match is live, with shifting odds)

None of these are required for the MVP to be fun.

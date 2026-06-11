"""auto_settle.py — auto-fetch World Cup results and settle the friends-bet game.

Runs on a schedule (every ~20 min). For each of OUR Firestore matches that has
kicked off but isn't settled yet, it finds the matching football-data.org fixture;
if that fixture is FINISHED, it writes the final + halftime score, settles every
open bet (same rules as docs/js/markets.js), credits winners, writes the public
results/{matchId} reveal doc, and Telegrams Anzon. Fully hands-off.

    python auto_settle.py            # live: fetch, settle, notify
    python auto_settle.py --dry-run  # show what WOULD settle, write nothing

Secrets (07_secrets/.env + service-account JSON):
  FOOTBALL_DATA_API_KEY, TELEGRAM_BOT_TOKEN, and the Firebase admin JSON at
  07_secrets/worldcup-bet-firebase-admin.json (Firestore admin writes).
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

SECRETS = Path(r"G:/My Drive/AI_Development/07_secrets")
ENV = SECRETS / ".env"
SA_JSON = SECRETS / "worldcup-bet-firebase-admin.json"
CHAT_ID = "7563892302"
WC_URL = "https://api.football-data.org/v4/competitions/WC/matches"
DRY = "--dry-run" in sys.argv


def _env(key: str) -> str | None:
    try:
        for line in ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return None


# ── team-name matching (our fixtures vs football-data) ──────────────────────
ALIASES = {  # football-data name -> our fixtures name (only where they differ)
    "ivory coast": "cote d'ivoire",
    "korea republic": "south korea",
    "turkiye": "turkiye", "turkey": "turkiye",
    "usa": "united states", "united states of america": "united states",
    "bosnia-herzegovina": "bosnia and herzegovina",
    "cabo verde": "cabo verde", "cape verde": "cabo verde",
    "dr congo": "dr congo", "congo dr": "dr congo",
}


def _norm(name: str) -> str:
    s = (name or "").lower().strip()
    s = ALIASES.get(s, s)
    s = s.replace("&", "").replace(" and ", " ")
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def _send_telegram(text: str) -> None:
    tok = _env("TELEGRAM_BOT_TOKEN")
    if not tok or DRY:
        return
    try:
        data = json.dumps({"chat_id": CHAT_ID, "text": text}).encode("utf-8")
        req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage",
                                     data=data, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=20)
    except Exception:
        pass


def _fetch_wc() -> dict:
    """Return {normalized 'home|away': match} for FINISHED WC fixtures."""
    key = _env("FOOTBALL_DATA_API_KEY")
    req = urllib.request.Request(WC_URL, headers={"X-Auth-Token": key or ""})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    out = {}
    for m in data.get("matches", []) or []:
        home = (m.get("homeTeam") or {}).get("name", "")
        away = (m.get("awayTeam") or {}).get("name", "")
        out[f"{_norm(home)}|{_norm(away)}"] = m
    return out


# ── settlement rules — must mirror docs/js/markets.js ───────────────────────
def evaluate(market: str, selection: str, fs: dict, ht: dict | None):
    h, a = fs["home"], fs["away"]
    if market == "1x2":
        if h > a: return "won" if selection == "home" else "lost"
        if h < a: return "won" if selection == "away" else "lost"
        return "won" if selection == "draw" else "lost"
    if market == "score":
        try:
            sh, sa = (int(x) for x in selection.split("-"))
        except ValueError:
            return "lost"
        return "won" if (sh == h and sa == a) else "lost"
    if market == "ht1x2":
        if not ht:
            return None
        hh, ha = ht["home"], ht["away"]
        if hh > ha: return "won" if selection == "home" else "lost"
        if hh < ha: return "won" if selection == "away" else "lost"
        return "won" if selection == "draw" else "lost"
    if market == "ou25":
        total = h + a
        if selection == "over": return "won" if total > 2.5 else "lost"
        if selection == "under": return "won" if total < 2.5 else "lost"
        return "lost"
    if market == "btts":
        both = h > 0 and a > 0
        if selection == "yes": return "won" if both else "lost"
        if selection == "no": return "lost" if both else "won"
        return "lost"
    return "void"


def main():
    if not SA_JSON.exists():
        print("Missing Firebase service-account JSON", file=sys.stderr); sys.exit(1)
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SA_JSON)))
    db = firestore.client()
    now = datetime.now(timezone.utc)

    # Self-gate: only hit the football-data API if at least one of OUR matches
    # has kicked off (last ~4h) and isn't settled yet. Keeps the 5-min cron cheap
    # on idle ticks + respects the free-tier API quota.
    all_matches = [(d.id, d.to_dict()) for d in db.collection("matches").stream()]
    def _pending(m):
        if m.get("status") == "settled":
            return False
        try:
            ko = datetime.fromisoformat((m.get("kickoffISO", "") or "").replace("Z", "+00:00"))
        except ValueError:
            return False
        return ko <= now <= ko + timedelta(hours=6) and m.get("homeTeam") not in (None, "", "TBD")
    pending = [(mid, m) for mid, m in all_matches if _pending(m)]
    if not pending:
        print("no recently-kicked-off unsettled match — skip API call")
        return

    wc = _fetch_wc()
    print(f"football-data: {len(wc)} WC fixtures fetched · {len(pending)} pending our side")
    settled_count = 0
    live_count = 0
    for mid, m in pending:
        home, away = m.get("homeTeam", ""), m.get("awayTeam", "")
        api = wc.get(f"{_norm(home)}|{_norm(away)}")
        if not api:
            continue
        st = api.get("status")
        # LIVE: match in progress → push the running score to the player cards.
        if st in ("IN_PLAY", "PAUSED"):
            sc = api.get("score") or {}
            ft = sc.get("fullTime") or {}
            if ft.get("home") is not None and ft.get("away") is not None:
                live = {"home": int(ft["home"]), "away": int(ft["away"]),
                        "minute": api.get("minute") or ("HT" if st == "PAUSED" else "")}
                if DRY:
                    print(f"WOULD live-update {mid}: {home} {live['home']}-{live['away']} {away} ({live['minute']})")
                else:
                    db.collection("matches").document(mid).update({
                        "status": "live", "liveScore": live, "updatedAt": firestore.SERVER_TIMESTAMP})
                live_count += 1
            continue
        if st != "FINISHED":
            continue
        sc = api.get("score") or {}
        ft = sc.get("fullTime") or {}
        htsc = sc.get("halfTime") or {}
        if ft.get("home") is None or ft.get("away") is None:
            continue
        final_score = {"home": int(ft["home"]), "away": int(ft["away"])}
        half_score = ({"home": int(htsc["home"]), "away": int(htsc["away"])}
                      if htsc.get("home") is not None and htsc.get("away") is not None else None)

        line = f"{home} {final_score['home']}-{final_score['away']} {away}"
        if DRY:
            print(f"WOULD settle: {mid}  {line}  (HT {half_score})")
            settled_count += 1
            continue

        # 1) write score + settled status
        db.collection("matches").document(mid).update({
            "finalScore": final_score,
            "halftimeScore": half_score,
            "status": "settled",
            "liveScore": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })

        # 2) settle open bets + credit winners
        bets = list(db.collection("bets").where("matchId", "==", mid).stream())
        batch = db.batch()
        credits: dict[str, float] = {}
        predictions = []
        winners = 0
        for b in bets:
            bet = b.to_dict()
            if bet.get("status") != "open":
                # still record already-settled for the reveal
                if bet.get("status") in ("won", "lost"):
                    predictions.append(_pred(bet))
                continue
            outcome = evaluate(bet.get("market", ""), bet.get("selection", ""),
                               final_score, half_score)
            if outcome is None:
                continue
            if outcome == "void":
                payout = bet.get("stake", 0)
            else:
                payout = round(bet.get("stake", 0) * bet.get("odds", 0)) if outcome == "won" else 0
            batch.update(b.reference, {"status": outcome, "payout": payout,
                                       "settledAt": firestore.SERVER_TIMESTAMP})
            if payout and payout > 0:
                credits[bet["userId"]] = credits.get(bet["userId"], 0) + payout
            if outcome == "won":
                winners += 1
            if outcome in ("won", "lost"):
                predictions.append(_pred({**bet, "status": outcome, "payout": payout}))
        for uid, cr in credits.items():
            batch.update(db.collection("users").document(uid), {"balance": firestore.Increment(cr)})
        batch.commit()

        # 3) public results reveal doc
        db.collection("results").document(mid).set({
            "matchId": mid, "homeTeam": home, "awayTeam": away,
            "finalScore": final_score, "predictions": predictions,
            "winners": winners, "total": len(predictions),
            "settledAt": firestore.SERVER_TIMESTAMP,
        })

        settled_count += 1
        _send_telegram(f"⚽️ 自動結算:{line}\n{winners}/{len(predictions)} 個估中 · 已派彩 + 出賽果")
        print(f"settled {mid}: {line} ({winners}/{len(predictions)} winners)")

    print(f"auto_settle done — {settled_count} settled, {live_count} live-updated "
          f"{'(dry-run)' if DRY else ''}")


def _pred(bet: dict) -> dict:
    return {
        "userId": bet.get("userId"), "displayName": bet.get("userDisplayName") or bet.get("userEmail") or "Player",
        "market": bet.get("market", ""), "marketLabel": bet.get("marketLabel", ""),
        "selection": bet.get("selection", ""), "selectionLabel": bet.get("selectionLabel", ""),
        "odds": bet.get("odds", 0), "stake": bet.get("stake", 0),
        "status": bet.get("status"), "payout": bet.get("payout", 0), "isAI": bool(bet.get("isAI")),
    }


if __name__ == "__main__":
    main()

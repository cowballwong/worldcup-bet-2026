"""refresh_odds.py — pull real market odds from The Odds API and write them to
Firestore match docs. Server-side port of docs/js/odds-refresh.js (same API key,
same soccer_fifa_world_cup feed, same median-across-bookmakers reduction).

    python refresh_odds.py --dry-run     # show proposed updates, write nothing
    python refresh_odds.py               # write to Firestore
    python refresh_odds.py --only R32    # restrict to knockout R32 docs

The Odds API free tier = 500 req/mo; one run = 1 request. Only lists events
within the bookmakers' current window, so far-future matches may not be priced
yet — re-run closer to kickoff for the rest.
"""
from __future__ import annotations
import io, json, re, sys, statistics, urllib.request
from pathlib import Path

if sys.stdout is None or sys.stderr is None:
    _lf = open(Path(__file__).resolve().parent / "refresh_odds.log", "a", encoding="utf-8")
    sys.stdout = sys.stdout or _lf; sys.stderr = sys.stderr or _lf
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8")
    except Exception: pass

DRY = "--dry-run" in sys.argv
ONLY = None
for i, a in enumerate(sys.argv):
    if a == "--only" and i + 1 < len(sys.argv):
        ONLY = sys.argv[i + 1]

SECRETS = Path(r"G:/My Drive/AI_Development/07_secrets")
SA_JSON = SECRETS / "worldcup-bet-firebase-admin.json"
CONFIG = Path(r"C:/worldcup-bet/docs/js/firebase-config.js")

NAME_SYNONYMS = {  # our name -> Odds API name
    "United States": "USA", "Türkiye": "Turkey", "Czechia": "Czech Republic",
    "South Korea": "Korea Republic", "Cabo Verde": "Cape Verde",
    "Côte d'Ivoire": "Ivory Coast", "DR Congo": "DR Congo",
    "Bosnia and Herzegovina": "Bosnia & Herzegovina",
}

def norm(n: str) -> str:
    if not n: return ""
    n = n.strip().lower().replace(".", "").replace("'", "").replace("’", "")
    n = re.sub(r"\s+", " ", n).replace("and", "&").replace("&", " and ")
    return re.sub(r"\s+", " ", n).strip()

def team_matches(our: str, api: str) -> bool:
    if not our or not api: return False
    a, b = norm(our), norm(api)
    if a == b: return True
    syn = NAME_SYNONYMS.get(our)
    if syn and norm(syn) == b: return True
    if a in b or b in a: return True
    return False

def med(arr):
    a = sorted(x for x in arr if isinstance(x, (int, float)))
    if not a: return None
    return round(statistics.median(a), 2)

def reduce_event(ev: dict) -> dict:
    home, draw, away, over, under = [], [], [], [], []
    for bm in ev.get("bookmakers", []):
        for m in bm.get("markets", []):
            if m["key"] == "h2h":
                for o in m["outcomes"]:
                    if o["name"] == ev["home_team"]: home.append(o["price"])
                    elif o["name"] == ev["away_team"]: away.append(o["price"])
                    elif o["name"] == "Draw": draw.append(o["price"])
            elif m["key"] == "totals":
                for o in m["outcomes"]:
                    if o.get("point") == 2.5 and o["name"] == "Over": over.append(o["price"])
                    if o.get("point") == 2.5 and o["name"] == "Under": under.append(o["price"])
    return {"home": med(home), "draw": med(draw), "away": med(away),
            "over25": med(over), "under25": med(under)}

def find_fixture(ev, fixtures):
    import datetime as dt
    try:
        ka = dt.datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00")).timestamp()
    except Exception:
        return None
    for m in fixtures:
        if not m.get("kickoffISO") or m.get("homeTeam") in (None, "TBD") or m.get("awayTeam") in (None, "TBD"):
            continue
        try:
            km = dt.datetime.fromisoformat(str(m["kickoffISO"]).replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        if abs(km - ka) > 90 * 60: continue
        if team_matches(m["homeTeam"], ev["home_team"]) and team_matches(m["awayTeam"], ev["away_team"]):
            return m
        if team_matches(m["homeTeam"], ev["away_team"]) and team_matches(m["awayTeam"], ev["home_team"]):
            return m
    return None

def main():
    txt = CONFIG.read_text(encoding="utf-8")
    m = re.search(r'ODDS_API_KEY\s*=\s*"([^"]+)"', txt)
    if not m or not m.group(1).strip():
        print("No ODDS_API_KEY in firebase-config.js"); return 2
    key = m.group(1).strip()

    url = ("https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/"
           f"?apiKey={key}&regions=uk,eu&markets=h2h,totals&oddsFormat=decimal")
    req = urllib.request.Request(url, headers={"User-Agent": "lillyrose-odds/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        events = json.loads(r.read().decode("utf-8"))
        remaining = r.headers.get("x-requests-remaining")
        used = r.headers.get("x-requests-used")
    print(f"Odds API: {len(events)} events · requests used {used} · remaining {remaining}")

    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SA_JSON)))
    db = firestore.client()
    fixtures = [d.to_dict() | {"id": d.id} for d in db.collection("matches").stream()]
    if ONLY:
        fixtures = [f for f in fixtures if ONLY.upper() in str(f["id"]).upper()]

    updates, unmatched = [], []
    for ev in events:
        fx = find_fixture(ev, fixtures)
        if not fx:
            unmatched.append(f'{ev["home_team"]} vs {ev["away_team"]} @ {ev["commence_time"]}')
            continue
        no = reduce_event(ev)
        if all(v is None for v in no.values()): continue
        merged = dict(fx.get("odds") or {})
        for k, v in no.items():
            if v is not None: merged[k] = v
        updates.append((fx["id"], f'{fx["homeTeam"]} vs {fx["awayTeam"]}', fx.get("odds") or {}, merged))

    print(f"\nPaired {len(updates)} fixtures; {len(unmatched)} API events unmatched.\n")
    for mid, label, old, new in sorted(updates):
        o = f'{old.get("home","-")}/{old.get("draw","-")}/{old.get("away","-")}'
        n = f'{new.get("home","-")}/{new.get("draw","-")}/{new.get("away","-")}'
        print(f"  {mid:13} {label:34} {o:18} -> {n}")
    if unmatched:
        print("\n  unmatched API events (not in our bracket / no kickoff match):")
        for u in unmatched: print(f"    · {u}")

    if DRY:
        print("\n--dry-run: no writes."); return 0
    batch = db.batch()
    for mid, _l, _o, new in updates:
        batch.update(db.collection("matches").document(mid), {"odds": new})
    if updates:
        batch.commit()
        print(f"\n✅ wrote real odds to {len(updates)} match docs in Firestore.")
    else:
        print("\nnothing to write.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

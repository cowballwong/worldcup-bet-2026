"""enrich_r32.py — add display metadata to the 16 R32 match docs:
  • venueCity      (from ESPN venue address)
  • fifaRankHome/Away (June 2026 FIFA ranking, mapped by team)
  • homeOrigin/awayOrigin (which group + finishing position, computed from our
    settled group results: Pts -> GD -> GF)

New fields only — rebuild_knockout.py's .update() set doesn't include them, so a
3-hourly knockout sync won't drop them. --dry-run prints, writes nothing.
"""
from __future__ import annotations
import sys, json, urllib.request
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
DRY = "--dry-run" in sys.argv

FIFA = {
    "South Africa":60,"Canada":30,"Brazil":6,"Japan":18,"Germany":10,"Paraguay":41,
    "Netherlands":8,"Morocco":7,"Côte d'Ivoire":33,"Norway":31,"France":3,"Sweden":38,
    "Mexico":14,"Ecuador":23,"England":4,"DR Congo":46,"Belgium":9,"Senegal":15,
    "United States":17,"Bosnia and Herzegovina":64,"Spain":2,"Austria":24,"Portugal":5,
    "Croatia":11,"Switzerland":19,"Algeria":28,"Australia":27,"Egypt":29,"Argentina":1,
    "Cabo Verde":67,"Colombia":13,"Ghana":73,
}
KO_DATES = ["20260628","20260629","20260630","20260701","20260702","20260703","20260704"]

def espn_city_map():
    """venue fullName -> 'City, State' from ESPN R32 events."""
    out = {}
    for d in KO_DATES:
        try:
            req = urllib.request.Request(
                f"https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates={d}",
                headers={"User-Agent": "lr/1.0"})
            sb = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
        except Exception as e:
            print(f"  espn {d} failed: {e}"); continue
        for ev in sb.get("events", []):
            if "round-of-32" not in ev.get("season", {}).get("slug", ""):
                continue
            comp = ev["competitions"][0]
            ven = comp.get("venue", {})
            city = (ven.get("address", {}) or {}).get("city")
            if ven.get("fullName") and city:
                out[ven["fullName"]] = city
    return out

def standings(matches):
    """group letter -> ordered list of team names (1st..last)."""
    from collections import defaultdict
    tab = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))  # grp -> team -> [pts,gd,gf]
    for m in matches:
        if m.get("stage") != "group": continue
        fs = m.get("finalScore")
        if not fs or fs.get("home") is None or fs.get("away") is None: continue
        g = m.get("group");  h, a = m.get("homeTeam"), m.get("awayTeam")
        if not g or not h or not a: continue
        hg, ag = int(fs["home"]), int(fs["away"])
        tab[g][h][1] += hg - ag; tab[g][h][2] += hg
        tab[g][a][1] += ag - hg; tab[g][a][2] += ag
        if hg > ag: tab[g][h][0] += 3
        elif ag > hg: tab[g][a][0] += 3
        else: tab[g][h][0] += 1; tab[g][a][0] += 1
    order = {}
    for g, teams in tab.items():
        order[g] = sorted(teams, key=lambda t: (-teams[t][0], -teams[t][1], -teams[t][2], t))
    return order

def origin_for(team, order):
    POS = {1: "組首名", 2: "組次名", 3: "組第三"}
    for g, lst in order.items():
        if team in lst:
            p = lst.index(team) + 1
            return f"{g} {POS.get(p, f'組第{p}')}"
    return None

def main():
    SA = r"G:/My Drive/AI_Development/07_secrets/worldcup-bet-firebase-admin.json"
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(SA))
    db = firestore.client()
    matches = [d.to_dict() | {"_id": d.id} for d in db.collection("matches").stream()]
    order = standings(matches)
    cities = espn_city_map()
    r32 = sorted([m for m in matches if str(m["_id"]).startswith("WC26-R32-")],
                 key=lambda m: int(m["_id"].split("-")[-1]))

    batch = db.batch(); n = 0
    for m in r32:
        upd = {}
        city = cities.get(m.get("venue"))
        if city: upd["venueCity"] = city
        if m.get("homeTeam") in FIFA: upd["fifaRankHome"] = FIFA[m["homeTeam"]]
        if m.get("awayTeam") in FIFA: upd["fifaRankAway"] = FIFA[m["awayTeam"]]
        ho = origin_for(m.get("homeTeam"), order); ao = origin_for(m.get("awayTeam"), order)
        if ho: upd["homeOrigin"] = ho
        if ao: upd["awayOrigin"] = ao
        print(f'{m["_id"]} {str(m.get("homeTeam"))[:16]:16} #{upd.get("fifaRankHome","?")} {upd.get("homeOrigin","?"):8} | '
              f'{str(m.get("awayTeam"))[:18]:18} #{upd.get("fifaRankAway","?")} {upd.get("awayOrigin","?"):8} | {upd.get("venueCity","?")}')
        if not DRY:
            batch.update(db.collection("matches").document(m["_id"]), upd); n += 1
    if DRY:
        print("\n--dry-run: no writes."); return 0
    batch.commit()
    print(f"\n✅ enriched {n} R32 docs (venueCity + FIFA rank + group origin)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

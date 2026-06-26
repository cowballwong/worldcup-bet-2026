"""rebuild_knockout.py — rebuild the knockout fixtures from OFFICIAL data (ESPN).

The hand-built knockout bracket template was wrong (wrong pairings, 11 third-place
slots instead of 8, wrong dates/venues). This pulls the official WC2026 knockout
schedule from ESPN (free, no key) and rewrites our knockout match docs:
real teams where known, correct slot labels otherwise, correct kickoffISO + venue,
and the correct R32→R16→QF→SF→Final progression.

SAFE: only touches knockout matches (stage != group). They have NO bets yet
(teams were TBD), so overwriting team/slot/date/venue is non-destructive. Group
matches (settled, with bets) are NEVER touched. Updates BOTH Firestore and
docs/data/fixtures.json. --dry-run prints the plan, writes nothing.

    python rebuild_knockout.py --dry-run
    python rebuild_knockout.py
"""
from __future__ import annotations
import io, json, re, sys, unicodedata, urllib.request
from pathlib import Path

# pythonw (scheduled task) has no console → sys.stdout/stderr are None; route to a
# log file so the run never dies on the first print().
if sys.stdout is None or sys.stderr is None:
    try:
        _lf = open(Path(__file__).resolve().parent / "rebuild_knockout.log", "a", encoding="utf-8")
        sys.stdout = sys.stdout or _lf; sys.stderr = sys.stderr or _lf
    except Exception:
        sys.stdout = sys.stdout or io.StringIO(); sys.stderr = sys.stderr or io.StringIO()
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass
DRY = "--dry-run" in sys.argv
SECRETS = Path(r"G:/My Drive/AI_Development/07_secrets")
SA_JSON = SECRETS / "worldcup-bet-firebase-admin.json"
FIXTURES = Path(r"C:/worldcup-bet/docs/data/fixtures.json")

KO_DATES = ["20260628","20260629","20260630","20260701","20260702","20260703",
            "20260704","20260705","20260706","20260707","20260709","20260710",
            "20260711","20260712","20260714","20260715","20260718","20260719"]
SLUG2STAGE = {"round-of-32":"r32","round-of-16":"r16","quarterfinals":"qf",
              "semifinals":"sf","third-place":"3rd-place","3rd-place":"3rd-place",
              "3rd-place-match":"3rd-place","final":"final"}
STAGE_IDS = {  # our doc-id pattern per stage (count, formatter)
    "r32": (16, lambda i: f"WC26-R32-{i:02d}"),
    "r16": (8,  lambda i: f"WC26-R16-{i}"),
    "qf":  (4,  lambda i: f"WC26-QF-{i}"),
    "sf":  (2,  lambda i: f"WC26-SF-{i}"),
    "3rd-place": (1, lambda i: "WC26-3RD"),
    "final":     (1, lambda i: "WC26-FINAL"),
}

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    return re.sub(r"[^a-z0-9]", "", s.lower())

ALIASES = {  # ESPN name -> our canonical normalized key (only where they differ)
    "ivorycoast": "cotedivoire", "korearepublic": "southkorea", "korea": "southkorea",
    "iran": "iran", "usa": "unitedstates", "us": "unitedstates",
    "bosniaherzegovina": "bosniaandherzegovina", "turkiye": "turkiye", "turkey": "turkiye",
}

def espn(dates):
    url = f"http://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates={dates}"
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"}), timeout=25))

def parse_slot(label: str):
    """ESPN home/away label -> ('team', name) or ('slot', our-slot-string)."""
    s = (label or "").strip()
    m = re.match(r"Group ([A-L]) Winner$", s)
    if m: return ("slot", f"1{m.group(1)}")
    m = re.match(r"Group ([A-L]) 2nd Place$", s)
    if m: return ("slot", f"2{m.group(1)}")
    m = re.match(r"Third Place Group ([A-L/]+)$", s)
    if m: return ("slot", "3" + m.group(1))
    m = re.match(r"Round of 32 (\d+) Winner$", s)
    if m: return ("slot", f"W R32-{m.group(1)}")
    m = re.match(r"Round of 16 (\d+) Winner$", s)
    if m: return ("slot", f"W R16-{m.group(1)}")
    m = re.match(r"Quarterfinal (\d+) Winner$", s)
    if m: return ("slot", f"W QF-{m.group(1)}")
    m = re.match(r"Semifinal (\d+) Winner$", s)
    if m: return ("slot", f"W SF-{m.group(1)}")
    m = re.match(r"Semifinal (\d+) Loser$", s)
    if m: return ("slot", f"L SF-{m.group(1)}")
    return ("team", s)  # a real team name

def main():
    # team -> (canonical name, flag) from our group matches
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SA_JSON)))
    db = firestore.client()
    teammap = {}
    for d in db.collection("matches").where("stage","==","group").stream():
        m = d.to_dict()
        for side in ("home","away"):
            t = m.get(side+"Team")
            if t and t != "TBD":
                teammap[_norm(t)] = (t, m.get(side+"Flag",""))
    def resolve_team(espn_name):
        k = _norm(espn_name)
        k = ALIASES.get(k, k)
        return teammap.get(k)  # (name, flag) or None

    # pull official knockout events
    events = []
    for d in KO_DATES:
        try:
            j = espn(d)
        except Exception as e:
            print(f"espn {d} err: {e}", file=sys.stderr); continue
        for e in j.get("events", []):
            comp = e["competitions"][0]
            slug = (e.get("season") or {}).get("slug","")
            stage = SLUG2STAGE.get(slug)
            if not stage: continue
            cs = {c.get("homeAway"): c.get("team",{}).get("displayName") for c in comp.get("competitors",[])}
            events.append({"date": e["date"], "stage": stage,
                           "home": cs.get("home"), "away": cs.get("away"),
                           "venue": (comp.get("venue") or {}).get("fullName","")})
    # group by stage, order by date, assign to our doc ids
    plan = []
    for stage, (count, fmt) in STAGE_IDS.items():
        evs = sorted([e for e in events if e["stage"]==stage], key=lambda x:x["date"])
        if len(evs) != count:
            print(f"⚠️ stage {stage}: got {len(evs)} ESPN events, expected {count} — ABORT (no writes)", file=sys.stderr)
            sys.exit(2)
        for i, e in enumerate(evs, 1):
            doc = {"id": fmt(i), "stage": stage, "kickoffISO": e["date"], "venue": e["venue"]}
            for side in ("home","away"):
                kind, val = parse_slot(e[side])
                if kind == "team":
                    rt = resolve_team(val)
                    if rt:
                        doc[side+"Team"], doc[side+"Flag"] = rt; doc[side+"Slot"] = None
                    else:  # unknown team name — keep as slot-ish label, flag blank
                        doc[side+"Team"] = "TBD"; doc[side+"Flag"] = ""; doc[side+"Slot"] = val
                        print(f"  note: unmatched team '{val}' in {doc['id']}", file=sys.stderr)
                else:
                    doc[side+"Team"] = "TBD"; doc[side+"Flag"] = ""; doc[side+"Slot"] = val
            plan.append(doc)

    # show plan (R32 first — the visible fix)
    for st in ("r32","r16","qf","sf","3rd-place","final"):
        for d in [p for p in plan if p["stage"]==st]:
            h = d.get("homeTeam") if d.get("homeTeam")!="TBD" else d.get("homeSlot")
            a = d.get("awayTeam") if d.get("awayTeam")!="TBD" else d.get("awaySlot")
            print(f"{d['id']:13} {d['kickoffISO']} | {str(h)[:30]:30} vs {str(a)[:30]:30} | {d['venue']}")

    if DRY:
        print("\n--dry-run: no writes."); return
    # write Firestore (update only the knockout fields; keep odds/status)
    n = 0
    for d in plan:
        upd = {k: d[k] for k in ("stage","kickoffISO","venue","homeTeam","awayTeam","homeFlag","awayFlag","homeSlot","awaySlot") if k in d}
        db.collection("matches").document(d["id"]).update(upd)
        n += 1
    print(f"\n✅ updated {n} knockout match docs in Firestore")
    # mirror into fixtures.json
    try:
        fx = json.loads(FIXTURES.read_text(encoding="utf-8"))
        byid = {p["id"]: p for p in plan}
        for m in fx["matches"]:
            if m["id"] in byid:
                p = byid[m["id"]]
                for k in ("kickoffISO","venue","homeTeam","awayTeam","homeFlag","awayFlag","homeSlot","awaySlot"):
                    if k in p: m[k] = p[k]
        FIXTURES.write_text(json.dumps(fx, ensure_ascii=False, indent=2), encoding="utf-8")
        print("✅ mirrored into fixtures.json")
    except Exception as e:
        print(f"fixtures.json mirror skipped: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()

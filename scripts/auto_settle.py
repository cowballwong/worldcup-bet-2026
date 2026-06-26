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

import io
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Task Scheduler runs this via pythonw.exe, which has NO console → sys.stdout /
# sys.stderr are None. The FIRST print() would then raise and kill the run
# BEFORE any bet is placed (this silently broke LillyRose's auto-bet — fixed
# 2026-06-13). Route output to a log file so the run never dies on a missing
# console, and so we can debug headless runs.
if sys.stdout is None or sys.stderr is None:
    try:
        _logf = open(Path(__file__).resolve().parent / "auto_settle.log",
                     "a", encoding="utf-8")
        sys.stdout = sys.stdout or _logf
        sys.stderr = sys.stderr or _logf
    except Exception:  # noqa: BLE001
        sys.stdout = sys.stdout or io.StringIO()
        sys.stderr = sys.stderr or io.StringIO()

# Force UTF-8 on the streams so emoji prints (🎬, ✅) never crash the run under a
# Windows cp1252 console (manual runs). The scheduler's utf-8 logfile is already
# fine; StringIO/file fallbacks may lack .reconfigure → guard each call.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

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
    "korea republic": "south korea", "korea south": "south korea",
    "czech republic": "czechia",
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
    # Transliterate accents to ASCII so precomposed vs decomposed forms match
    # (e.g. our DB's "Côte d'Ivoire" precomposed ô vs ESPN's decomposed ô — without
    # this the keys diverge to "ctedivoire" vs "cotedivoire" and the match never
    # settles). NFKD splits "ô"→"o"+combining mark; we then strip the marks.
    s = unicodedata.normalize("NFKD", s)
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


def _yt_id(link: str) -> str | None:
    if not link:
        return None
    m = (re.search(r"[?&]v=([\w-]{11})", link)
         or re.search(r"youtu\.be/([\w-]{11})", link)
         or re.search(r"/shorts/([\w-]{11})", link)
         or re.search(r"/embed/([\w-]{11})", link))
    return m.group(1) if m else None


# Title-side name variants so we can confirm BOTH teams appear in a video title
# (FIFA titles use some names differently from our fixtures, e.g. Korea Republic).
# Keyed by our _norm(team); values are extra spellings to accept.
TEAM_TITLE_ALIASES = {
    "south korea": ["korea republic", "korea"],
    "dr congo": ["congo dr", "congo", "democratic republic of congo"],
    "united states": ["usa", "united states of america"],
    "turkiye": ["turkey"],
    "cote d'ivoire": ["ivory coast", "cote divoire"],
    "cabo verde": ["cape verde"],
    "czechia": ["czech republic"],
    "bosnia and herzegovina": ["bosnia herzegovina", "bosnia"],
}


def _title_norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    return re.sub(r"[^a-z0-9]", "", s)


def _name_variants(team: str) -> set[str]:
    out = {_title_norm(team)}
    key = _norm(team)
    # Keys are written human-readably ("united states"); match them via _norm so
    # spacing/accents never break the lookup (was a real bug — "usa" never loaded).
    for k, alts in TEAM_TITLE_ALIASES.items():
        if _norm(k) == key:
            for alt in alts:
                out.add(_title_norm(alt))
    return {v for v in out if v}


def _both_teams_in_title(title: str, home: str, away: str) -> bool:
    tn = _title_norm(title)
    return (any(v in tn for v in _name_variants(home))
            and any(v in tn for v in _name_variants(away)))


# FIFA's official channel posts far more than match highlights: training, 3D
# animations, "Every Angle", press conferences, arrivals, previews, etc. These
# all carry both team names in the title, so the both-teams check alone lets them
# through (tier 2 especially, which doesn't even require 'highlight'). Reject any
# title carrying a non-highlight marker — a real highlights clip never does.
BAD_HL_TITLE = re.compile(
    r"\b(training|warm[\s-]?up|3\s?d|animation|animated|press\s*conf\w*|presser|"
    r"mic'?d?\s*up|arrival|every\s*angle|behind\s+the\s+scenes|preview|predict\w*|"
    r"reaction|watch[\s-]?along|interview|fan\s*zone|all\s*goals\s*&?\s*saves\s*compilation)\b",
    re.IGNORECASE)


def _is_bad_highlight(title: str) -> bool:
    return bool(BAD_HL_TITLE.search(title or ""))


def _valid_highlight_title(title: str, home: str, away: str) -> bool:
    """A title is a real match-highlights clip only if it (a) literally says
    'highlight' — every genuine FIFA/3rd-party highlights upload does, while
    training/preview/interview/press clips don't — AND (b) names both teams AND
    (c) carries no non-highlight marker (3D, Every Angle, etc.). Single source of
    truth shared by the live picker and the reset cleanup."""
    return ("highlight" in (title or "").lower()
            and _both_teams_in_title(title, home, away)
            and not _is_bad_highlight(title))


def _youtube_highlights(home: str, away: str) -> str | None:
    """Find the OFFICIAL FIFA highlights clip for a finished match via SerpAPI's
    YouTube engine. Returns an 11-char video id, or None. A candidate is only
    accepted if BOTH team names appear in the title — this prevents grabbing a
    same-tournament clip that merely shares one team (e.g. Canada-Bosnia wrongly
    matching the Switzerland-Bosnia video). Better to show no button than the wrong
    match. One SerpAPI search per call — the caller quota-guards how often it runs."""
    key = _env("SERPAPI_API_KEY")
    if not key:
        return None
    q = f"{home} vs {away} Highlights FIFA World Cup 2026"
    url = "https://serpapi.com/search.json?" + urllib.parse.urlencode(
        {"engine": "youtube", "search_query": q, "api_key": key})
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"serpapi youtube failed: {e}", file=sys.stderr)
        return None
    vids = data.get("video_results", []) or []

    def _is_fifa(v):
        # EXACT match — the official channel is named "FIFA". Imposters like
        # "Sports FIFA World" contain the substring and must NOT count as official.
        return ((v.get("channel") or {}).get("name") or "").strip().lower() == "fifa"

    def _ok(v):
        # must literally be a highlights clip of THIS match (not training/3D/press)
        return _valid_highlight_title(v.get("title", ""), home, away)

    # 1) FIFA channel, both teams in title, 'highlight' in title — the canonical clip
    for v in vids[:15]:
        t = v.get("title", "").lower()
        if _is_fifa(v) and "highlight" in t and _ok(v):
            if (vid := _yt_id(v.get("link"))):
                return vid
    # 2) FIFA channel, both teams in title (any FIFA clip of THIS match)
    for v in vids[:15]:
        if _is_fifa(v) and _ok(v):
            if (vid := _yt_id(v.get("link"))):
                return vid
    # 3) any channel, both teams + 'highlight' in title (last resort, still verified)
    for v in vids[:10]:
        if "highlight" in v.get("title", "").lower() and _ok(v):
            if (vid := _yt_id(v.get("link"))):
                return vid
    return None


# Highlights pass tuning — keep SerpAPI usage (250/mo free, shared) frugal.
HL_MAX_ATTEMPTS = 5            # give up after N misses (FIFA never posted / not found)
HL_RETRY_SECS = 3600          # at most one search/hour per match
HL_MIN_AGE_SECS = 90 * 60     # wait ~90 min after kickoff for FIFA to upload
HL_PER_TICK = 2               # cap searches per run


def _highlights_pass(db) -> int:
    """Populate match.highlightsVideoId for settled matches with the post-match
    FIFA YouTube highlights. Idempotent + quota-frugal: skips matches already done /
    too fresh / over the attempt cap, throttles retries to hourly, caps searches per
    tick. Safe to run every cron tick."""
    from firebase_admin import firestore
    now = time.time()
    searches = found = 0
    try:
        docs = list(db.collection("matches").where("status", "==", "settled").stream())
    except Exception as e:  # noqa: BLE001
        print(f"highlights query failed: {e}", file=sys.stderr)
        return 0
    for doc in docs:
        if searches >= HL_PER_TICK:
            break
        m = doc.to_dict()
        if m.get("highlightsVideoId") or not m.get("finalScore"):
            continue
        if (m.get("highlightsAttempts", 0) or 0) >= HL_MAX_ATTEMPTS:
            continue
        try:  # let FIFA post it first
            ko = datetime.fromisoformat((m.get("kickoffISO", "") or "").replace("Z", "+00:00"))
            if (now - ko.timestamp()) < HL_MIN_AGE_SECS:
                continue
        except ValueError:
            pass
        if now - (m.get("highlightsLastTry", 0) or 0) < HL_RETRY_SECS:
            continue
        home, away = m.get("homeTeam", ""), m.get("awayTeam", "")
        if DRY:
            print(f"WOULD search highlights: {home} v {away}")
            searches += 1
            continue
        vid = _youtube_highlights(home, away)
        searches += 1
        if vid:
            doc.reference.update({
                "highlightsVideoId": vid,
                "highlightsUrl": f"https://www.youtube.com/watch?v={vid}",
                "highlightsTs": now,
            })
            found += 1
            print(f"🎬 highlights {home} v {away}: {vid}")
        else:
            doc.reference.update({
                "highlightsAttempts": firestore.Increment(1),
                "highlightsLastTry": now,
            })
    if searches:
        print(f"highlights pass: {searches} search(es), {found} found")
    return found


def _fetch_wc() -> dict:
    """Return {normalized 'home|away': match} for ALL WC fixtures (football-data).
    Used for FINAL settlement — football-data free updates finished matches +
    score (delayed) and has a generous quota; its free tier has NO live data."""
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


# ── API-Football (api-sports.io) — LIVE in-play scores ──────────────────────
# Free plan can't query the 2026 season by date, BUT the `fixtures?live=all`
# endpoint works and returns live WC matches. Quota is only 100 req/DAY, so we
# count calls in a state file and hard-stop near the cap (finals still settle via
# football-data, which is unaffected).
QUOTA_FILE = Path(__file__).resolve().parent.parent / "state" / "apisports_quota.json"
AF_DAILY_CAP = 100  # per KEY; total daily budget = 100 × number of API-Football keys
AF_LIVE_SHORTS = {"1H", "2H", "ET", "BT", "P", "HT", "LIVE", "INT"}


def _af_keys() -> list:
    """All configured API-Football keys, in priority order (primary first).
    Add more by setting APISPORTS_KEY2 / APISPORTS_KEY3 / … in 07_secrets/.env —
    each key carries its own 100/day free quota, so they're rotated to multiply it."""
    out = []
    for name in ("APISPORTS_KEY", "APISPORTS_KEY2", "APISPORTS_KEY3", "APISPORTS_KEY4"):
        k = _env(name)
        if k and k not in out:
            out.append(k)
    return out


def _af_acquire_key() -> str | None:
    """Pick an API-Football key still under its daily cap, record one call against
    it, and return it. Keys are tried in priority order, so we drain the primary
    before spilling onto spares. Returns None only when EVERY key is maxed today.
    Per-key usage is keyed by the key's last 6 chars (we never store the full key)."""
    keys = _af_keys()
    if not keys:
        return None
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    data = {"date": today, "counts": {}}
    try:
        if QUOTA_FILE.exists():
            data = json.loads(QUOTA_FILE.read_text(encoding="utf-8"))
            if data.get("date") != today:
                data = {"date": today, "counts": {}}
    except (OSError, json.JSONDecodeError):
        data = {"date": today, "counts": {}}
    counts = data.get("counts")
    if not isinstance(counts, dict):
        counts = {}
        # migrate legacy {date,count} → charge today's prior usage to the primary key
        if isinstance(data.get("count"), int) and data.get("date") == today:
            counts[keys[0][-6:]] = data["count"]
    for k in keys:
        fp = k[-6:]
        if counts.get(fp, 0) < AF_DAILY_CAP:
            counts[fp] = counts.get(fp, 0) + 1
            try:
                QUOTA_FILE.parent.mkdir(parents=True, exist_ok=True)
                QUOTA_FILE.write_text(json.dumps({"date": today, "counts": counts}),
                                      encoding="utf-8")
            except OSError:
                pass
            return k
    return None


def _fetch_live() -> dict:
    """Return {normalized 'home|away': {home,away,minute}} for live WC matches.
    Empty dict if over the daily quota or on any error (non-fatal)."""
    key = _af_acquire_key()
    if not key:
        return {}
    try:
        req = urllib.request.Request("https://v3.football.api-sports.io/fixtures?live=all",
                                     headers={"x-apisports-key": key})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        out = {}
        for f in data.get("response", []) or []:
            lg = f.get("league") or {}
            if lg.get("id") != 1 and lg.get("name") != "World Cup":
                continue
            t = f.get("teams") or {}
            g = f.get("goals") or {}
            st = (f.get("fixture") or {}).get("status") or {}
            if st.get("short") not in AF_LIVE_SHORTS:
                continue
            home = (t.get("home") or {}).get("name", "")
            away = (t.get("away") or {}).get("name", "")
            minute = "HT" if st.get("short") == "HT" else (st.get("elapsed") or "")
            # Full event timeline (goals + cards) with scorer/bookee name + minute,
            # straight from the live=all events array (free, no extra request).
            events = []
            for e in (f.get("events") or []):
                typ = e.get("type")
                det = (e.get("detail") or "")
                tn = _norm((e.get("team") or {}).get("name", ""))
                side = "home" if tn == _norm(home) else ("away" if tn == _norm(away) else None)
                if side is None:
                    continue
                tm = e.get("time") or {}
                mn = tm.get("elapsed")
                mdisp = (f"{mn}+{tm.get('extra')}'" if tm.get("extra") else f"{mn}'") if mn is not None else ""
                player = (e.get("player") or {}).get("name", "") or ""
                if typ == "Goal":
                    icon = "⚽"
                    if "own" in det.lower():
                        icon = "⚽(OG)"
                    elif "penalty" in det.lower():
                        icon = "⚽(P)"
                elif typ == "Card":
                    icon = "🟥" if ("red" in det.lower() or "second yellow" in det.lower()) else "🟨"
                else:
                    continue  # skip subs / VAR
                events.append({"side": side, "icon": icon, "player": player, "min": mdisp})
            htsc = (f.get("score") or {}).get("halftime") or {}
            out[f"{_norm(home)}|{_norm(away)}"] = {
                "home": int(g.get("home") or 0), "away": int(g.get("away") or 0),
                "minute": minute, "events": events,
                "fixture_id": (f.get("fixture") or {}).get("id"),
                "halftime": ({"home": int(htsc["home"]), "away": int(htsc["away"])}
                             if htsc.get("home") is not None and htsc.get("away") is not None else None)}
        return out
    except Exception:
        return {}


AF_FINISHED = {"FT", "AET", "PEN"}


def _af_fixture(fid) -> dict | None:
    """Query ONE API-Football fixture by id (works on the free plan, unlike the
    season/date queries). Returns the raw fixture dict or None. Quota-guarded."""
    if not fid:
        return None
    key = _af_acquire_key()
    if not key:
        return None
    try:
        req = urllib.request.Request(f"https://v3.football.api-sports.io/fixtures?id={fid}",
                                     headers={"x-apisports-key": key})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        resp = data.get("response") or []
        return resp[0] if resp else None
    except Exception:
        return None


_STAT_KEYS = {  # API-Football stat type → our short code
    "Ball Possession": "poss", "Total Shots": "shots", "Shots on Goal": "sot",
    "Corner Kicks": "corners", "Fouls": "fouls", "Offsides": "offsides",
    "Yellow Cards": "yellow", "Red Cards": "red",
}


def _af_stats(fid, home_name, away_name) -> dict | None:
    """Live match statistics (possession, shots, corners…) for ONE fixture id.
    Returns {'home': {...}, 'away': {...}} or None. Quota-guarded (1 call)."""
    if not fid:
        return None
    key = _af_acquire_key()
    if not key:
        return None
    try:
        req = urllib.request.Request(
            f"https://v3.football.api-sports.io/fixtures/statistics?fixture={fid}",
            headers={"x-apisports-key": key})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        resp = data.get("response") or []
        if not resp:
            return None
        out = {"home": {}, "away": {}}
        hn, an = _norm(home_name), _norm(away_name)
        for entry in resp:
            tn = _norm((entry.get("team") or {}).get("name", ""))
            side = "home" if tn == hn else ("away" if tn == an else None)
            if side is None:
                continue
            for s in (entry.get("statistics") or []):
                code = _STAT_KEYS.get(s.get("type"))
                if code and s.get("value") is not None:
                    out[side][code] = s.get("value")
        return out if (out["home"] or out["away"]) else None
    except Exception:
        return None


# ── ESPN free hidden API (no key, NO quota) — PRIMARY live + finals source ──
# site.api.espn.com serves the WC scoreboard (every match: score, status, goal/
# card timeline) + a per-event summary (full team stats + halftime linescores).
# Free and unmetered, so it replaces API-Football for the high-frequency live
# polling that was burning the 100/day quota. API-Football + football-data stay
# as fallbacks. (Unofficial endpoint — if ESPN ever changes it, the fallbacks
# keep settlement working; only the live panel would degrade.)
ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world"
ESPN_STAT_MAP = {  # ESPN boxscore stat name → our short code
    "possessionPct": "poss", "totalShots": "shots", "shotsOnTarget": "sot",
    "wonCorners": "corners", "foulsCommitted": "fouls", "offsides": "offsides",
    "yellowCards": "yellow", "redCards": "red",
}


def _espn_get(path):
    try:
        req = urllib.request.Request(f"{ESPN_BASE}/{path}",
                                     headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _espn_scoreboard() -> dict:
    """{norm 'home|away': {...}} for every WC match ESPN lists. Each value: home/
    away (int goals), minute (str), live (bool=in-play), completed (bool),
    event_id, hid/aid (team ids), events (goal/card timeline). {} on error."""
    data = _espn_get("scoreboard")
    if not data:
        return {}
    out = {}
    for e in data.get("events", []) or []:
        comp = (e.get("competitions") or [{}])[0]
        st = (e.get("status") or {}).get("type") or {}
        sides = {c.get("homeAway"): c for c in comp.get("competitors", []) or []}
        hc, ac = sides.get("home"), sides.get("away")
        if not hc or not ac:
            continue
        home = (hc.get("team") or {}).get("displayName", "")
        away = (ac.get("team") or {}).get("displayName", "")
        hid = str((hc.get("team") or {}).get("id") or "")
        aid = str((ac.get("team") or {}).get("id") or "")
        events = []
        for d in comp.get("details", []) or []:
            is_goal, is_red, is_yellow = bool(d.get("scoringPlay")), bool(d.get("redCard")), bool(d.get("yellowCard"))
            if not (is_goal or is_red or is_yellow):
                continue
            nm = (d.get("athletesInvolved") or [""])[0]
            events.append({
                "min": (d.get("clock") or {}).get("displayValue", ""),
                "icon": "⚽" if is_goal else ("🟥" if is_red else "🟨"),
                "side": "home" if str((d.get("team") or {}).get("id")) == hid else "away",
                "player": nm if isinstance(nm, str) else "",
            })
        try:
            gh, ga = int(hc.get("score") or 0), int(ac.get("score") or 0)
        except (TypeError, ValueError):
            gh = ga = 0
        out[f"{_norm(home)}|{_norm(away)}"] = {
            "home": gh, "away": ga,
            "minute": st.get("shortDetail") or st.get("detail") or "",
            "live": st.get("state") == "in", "completed": bool(st.get("completed")),
            "event_id": e.get("id"), "hid": hid, "aid": aid, "events": events,
        }
    return out


def _espn_stats(event_id, hid, aid) -> dict | None:
    """Possession/shots/etc for one ESPN event (free). {'home':…,'away':…} or None."""
    if not event_id:
        return None
    data = _espn_get(f"summary?event={event_id}")
    if not data:
        return None
    out = {"home": {}, "away": {}}
    for t in (data.get("boxscore") or {}).get("teams", []) or []:
        tid = str((t.get("team") or {}).get("id") or "")
        side = ("home" if tid == str(hid) else "away" if tid == str(aid)
                else t.get("homeAway") if t.get("homeAway") in ("home", "away") else None)
        if side is None:
            continue
        for s in t.get("statistics", []) or []:
            code = ESPN_STAT_MAP.get(s.get("name"))
            if code and s.get("displayValue") is not None:
                out[side][code] = f"{s['displayValue']}%" if code == "poss" else s["displayValue"]
    return out if (out["home"] or out["away"]) else None


def _espn_halftime(event_id) -> dict | None:
    """Halftime score {home,away} from ESPN summary linescores (1st period), or None."""
    if not event_id:
        return None
    data = _espn_get(f"summary?event={event_id}")
    if not data:
        return None
    comp = ((data.get("header") or {}).get("competitions") or [{}])[0]
    sides = {c.get("homeAway"): c for c in comp.get("competitors", []) or []}
    try:
        return {"home": int(sides["home"]["linescores"][0]["displayValue"]),
                "away": int(sides["away"]["linescores"][0]["displayValue"])}
    except (KeyError, IndexError, TypeError, ValueError):
        return None


# ── settlement rules — must mirror docs/js/markets.js ───────────────────────
def evaluate(market: str, selection: str, fs: dict, ht: dict | None):
    h, a = fs["home"], fs["away"]
    if market == "1x2":
        if h > a: return "won" if selection == "home" else "lost"
        if h < a: return "won" if selection == "away" else "lost"
        return "won" if selection == "draw" else "lost"
    if market == "score":
        if selection == "other":  # any scoreline beyond the 0-3 × 0-3 grid
            return "won" if (h > 3 or a > 3) else "lost"
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


# ── Knockout auto-advance ──────────────────────────────────────
# Resolve knockout slot placeholders to real teams once decidable, and write
# them into the match docs so the bracket, the matches list AND betting all use
# real teams. Mirrors the client logic in docs/js/main.js. Idempotent: only fills
# a slot that's still TBD and now resolvable; steady-state = zero writes.
#   "1A"/"2C"  → group winner / runner-up (once that group is complete)
#   "3A/D/E/F" → a best third-placed team (once all 12 groups complete; assigned
#                to the 8 R32 third-slots by constraint-matching the published
#                candidate groups — a same-group-clash-free valid assignment)
#   "W R32-1" / "L SF-1" → winner / loser of that knockout match (once settled)
_KO_REF_RE = re.compile(r'^([WL])\s+(R32|R16|QF|SF)-(\d+)$', re.IGNORECASE)
_GRP_RE = re.compile(r'^([12])([A-L])$')


def _ko_group_standings(matches):
    groups = {}
    for m in matches:
        if (m.get("stage") or "") != "group" or not m.get("group"):
            continue
        g = groups.setdefault(m["group"], {"matches": [], "teams": {}})
        g["matches"].append(m)
        for side in ("home", "away"):
            t = m.get(side + "Team")
            if t and t != "TBD":
                g["teams"][t] = m.get(side + "Flag", "")
    out = {}
    for letter, g in groups.items():
        rows = {t: {"team": t, "flag": f, "MP": 0, "W": 0, "D": 0, "L": 0,
                    "GF": 0, "GA": 0, "GD": 0, "Pts": 0} for t, f in g["teams"].items()}
        settled = 0
        for m in g["matches"]:
            fs = m.get("finalScore")
            if not fs or m.get("status") != "settled":
                continue
            settled += 1
            h, a = rows.get(m.get("homeTeam")), rows.get(m.get("awayTeam"))
            if not h or not a:
                continue
            hg, ag = fs.get("home"), fs.get("away")
            if hg is None or ag is None:
                continue
            h["MP"] += 1; a["MP"] += 1
            h["GF"] += hg; h["GA"] += ag; a["GF"] += ag; a["GA"] += hg
            if hg > ag:   h["W"] += 1; h["Pts"] += 3; a["L"] += 1
            elif hg < ag: a["W"] += 1; a["Pts"] += 3; h["L"] += 1
            else:         h["D"] += 1; a["D"] += 1; h["Pts"] += 1; a["Pts"] += 1
        for r in rows.values():
            r["GD"] = r["GF"] - r["GA"]
        srt = sorted(rows.values(), key=lambda r: (-r["Pts"], -r["GD"], -r["GF"], r["team"]))
        out[letter] = {"rows": srt, "complete": len(g["matches"]) > 0 and settled == len(g["matches"])}
    return out


def _thirds_assignment(standings, third_slots):
    """Map each '3A/D/E/F'-style slot → a team. Only once all 12 groups complete."""
    letters = list(standings.keys())
    if len(letters) < 12 or not all(standings[l]["complete"] for l in letters):
        return {}
    thirds = []
    for l, g in standings.items():
        if len(g["rows"]) >= 3:
            t = dict(g["rows"][2]); t["group"] = l; thirds.append(t)
    thirds.sort(key=lambda r: (-r["Pts"], -r["GD"], -r["GF"], r["team"]))
    qgroups = {t["group"]: t for t in thirds[:8]}     # the 8 best thirds, by group
    slots = [(s, [c for c in s[1:].split("/") if c in qgroups]) for s in third_slots]
    order = sorted(range(len(slots)), key=lambda i: len(slots[i][1]))  # hardest first
    assign, used = {}, set()

    def bt(k):
        if k == len(order):
            return True
        s, cands = slots[order[k]]
        for c in cands:
            if c in used:
                continue
            used.add(c); assign[s] = c
            if bt(k + 1):
                return True
            used.discard(c); assign.pop(s, None)
        return False

    if not bt(0):
        return {}
    return {s: qgroups[c]["team"] for s, c in assign.items()}


def _advance_knockout(db, all_matches):
    """Fill resolvable knockout slots with real teams. Idempotent. Returns #updated."""
    matches = {mid: m for mid, m in all_matches}
    flag = {}
    for m in matches.values():
        for side in ("home", "away"):
            t = m.get(side + "Team")
            if t and t != "TBD":
                flag[t] = m.get(side + "Flag", "")
    standings = _ko_group_standings(matches.values())
    third_slots = sorted({sl for m in matches.values() if m.get("stage") == "r32"
                          for sl in (m.get("homeSlot"), m.get("awaySlot"))
                          if sl and sl.startswith("3")})
    assignment = _thirds_assignment(standings, third_slots)

    def ref_to_id(rd, n):
        return f"WC26-R32-{int(n):02d}" if rd.upper() == "R32" else f"WC26-{rd.upper()}-{int(n)}"

    def ko_result(ref_id):
        m = matches.get(ref_id)
        if not m or m.get("status") != "settled":
            return (None, None)
        fs = m.get("finalScore") or {}
        h, a = m.get("homeTeam"), m.get("awayTeam")
        hg, ag = fs.get("home"), fs.get("away")
        if not h or not a or h == "TBD" or a == "TBD" or hg is None or ag is None:
            return (None, None)
        if hg > ag: return (h, a)
        if ag > hg: return (a, h)
        pw = fs.get("penWinner") or m.get("penWinner") or m.get("penaltyWinner")
        if pw in ("home", h): return (h, a)
        if pw in ("away", a): return (a, h)
        return (None, None)  # drawn, no penalty winner recorded yet

    def resolve(slot):
        if not slot:
            return None
        slot = slot.strip()
        mm = _GRP_RE.match(slot)
        if mm:
            g = standings.get(mm.group(2))
            if g and g["complete"]:
                idx = int(mm.group(1)) - 1
                if idx < len(g["rows"]):
                    return g["rows"][idx]["team"]
            return None
        if slot.startswith("3"):
            return assignment.get(slot)
        mm = _KO_REF_RE.match(slot)
        if mm:
            w, l = ko_result(ref_to_id(mm.group(2), mm.group(3)))
            return w if mm.group(1).upper() == "W" else l
        return None

    filled = 0
    for mid, m in matches.items():
        if (m.get("stage") or "") == "group":
            continue
        upd = {}
        for side in ("home", "away"):
            if m.get(side + "Team") and m.get(side + "Team") != "TBD":
                continue  # already a real team
            team = resolve(m.get(side + "Slot"))
            if team:
                upd[side + "Team"] = team
                upd[side + "Flag"] = flag.get(team, "")
        if upd:
            if DRY:
                print(f"WOULD advance {mid}: {upd}")
            else:
                from firebase_admin import firestore
                upd["updatedAt"] = firestore.SERVER_TIMESTAMP
                db.collection("matches").document(mid).update(upd)
            filled += 1
    if filled:
        print(f"knockout advance: filled {filled} match(es)")
    return filled


def main():
    if not SA_JSON.exists():
        print("Missing Firebase service-account JSON", file=sys.stderr); sys.exit(1)
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SA_JSON)))
    db = firestore.client()
    now = datetime.now(timezone.utc)

    # LillyRose AI auto-bets upcoming matches (Firestore-only, no external quota).
    try:
        _lillyrose_autobet(db)
    except Exception as e:  # noqa: BLE001
        print(f"lillyrose autobet skipped: {e}", file=sys.stderr)

    # Post-match FIFA highlights (YouTube). Runs BEFORE the pending-match early
    # return below, because a just-finished match is 'settled' = not pending, so it
    # would otherwise never be reached. Self-throttles SerpAPI usage.
    try:
        _highlights_pass(db)
    except Exception as e:  # noqa: BLE001
        print(f"highlights pass skipped: {e}", file=sys.stderr)
    if "--highlights-only" in sys.argv:
        return

    # Self-gate: only hit the football-data API if at least one of OUR matches
    # has kicked off (last ~4h) and isn't settled yet. Keeps the 5-min cron cheap
    # on idle ticks + respects the free-tier API quota.
    all_matches = [(d.id, d.to_dict()) for d in db.collection("matches").stream()]

    # Auto-advance the knockout bracket: fill resolvable slots (group winners/
    # runners-up, best thirds, and W/L of settled knockout matches) with real
    # teams. Runs every tick BEFORE the idle early-return so it still fills when
    # no match is live (e.g. the morning after the group stage ends). Idempotent.
    try:
        _advance_knockout(db, all_matches)
    except Exception as e:  # noqa: BLE001
        print(f"knockout advance skipped: {e}", file=sys.stderr)

    def _pending(m):
        if m.get("status") == "settled":
            return False
        try:
            ko = datetime.fromisoformat((m.get("kickoffISO", "") or "").replace("Z", "+00:00"))
        except ValueError:
            return False
        return ko <= now <= ko + timedelta(hours=12) and m.get("homeTeam") not in (None, "", "TBD")
    pending = [(mid, m) for mid, m in all_matches if _pending(m)]
    if not pending:
        print("no recently-kicked-off unsettled match — skip API call")
        return

    # Reveal everyone's predictions the MOMENT a match has kicked off (betting is
    # locked at kickoff, so it's safe + more fun to see all picks during the live
    # match, not only at settlement). Written once per match — bets can't change
    # post-kickoff. (Settlement later overwrites results/{mid} with win/loss.)
    revealed = 0
    for mid, m in pending:
        if m.get("predictionsRevealed"):
            continue
        try:
            bets = [b.to_dict() for b in db.collection("bets").where("matchId", "==", mid).stream()]
            preds = [_pred(b) for b in bets if b]
            if DRY:
                print(f"WOULD reveal {mid}: {len(preds)} predictions (kickoff)")
            else:
                db.collection("results").document(mid).set({
                    "matchId": mid, "homeTeam": m.get("homeTeam", ""), "awayTeam": m.get("awayTeam", ""),
                    "finalScore": None, "predictions": preds, "winners": None,
                    "total": len(preds), "live": True,
                    "revealedAt": firestore.SERVER_TIMESTAMP,
                })
                db.collection("matches").document(mid).update({"predictionsRevealed": True})
            revealed += 1
        except Exception as e:  # noqa: BLE001
            print(f"reveal {mid} skipped: {e}", file=sys.stderr)
    if revealed:
        print(f"kickoff-revealed predictions for {revealed} match(es)")

    espn = _espn_scoreboard()                # FREE primary (no key/quota): live + finals
    live = espn if espn else _fetch_live()   # API-Football live=all only if ESPN is down
    espn_src = bool(espn)
    # football-data is the FINALS FALLBACK: slow (a finished match stays TIMED for
    # hours) but eventually flips to FINISHED with team names that match ours — it
    # catches any match the fast API-Football by-id path missed (e.g. live=all
    # never matched it, so no fixture id was ever captured). Generous free quota.
    try:
        wc = _fetch_wc()
    except Exception as e:  # noqa: BLE001
        print(f"football-data fetch failed: {e}", file=sys.stderr); wc = {}
    print(f"live source: {'ESPN' if espn_src else 'API-Football'} ({len(live)}) · football-data: {len(wc)} · {len(pending)} pending our side")
    settled_count = 0
    live_count = 0
    for mid, m in pending:
        home, away = m.get("homeTeam", ""), m.get("awayTeam", "")
        key = f"{_norm(home)}|{_norm(away)}"
        lv = live.get(key)
        # LIVE now → push score + event timeline to the card. (AF entries have no
        # 'live' key → treat as in-play; ESPN entries carry live=True/False.)
        if lv and lv.get("live", True):
            new_ls = {"home": lv["home"], "away": lv["away"],
                      "minute": lv["minute"], "events": lv.get("events", [])}
            if DRY:
                print(f"WOULD live-update {mid}: {home} {lv['home']}-{lv['away']} {away} ({lv['minute']})")
            else:
                now_ep = int(datetime.now(timezone.utc).timestamp())
                stats_due = now_ep - int(m.get("liveStatsTs") or 0) >= 540
                # Skip the Firestore WRITE entirely on a no-op tick (score, minute,
                # events all identical + already 'live' + stats not due) — keeps the
                # 5-min cron's write volume low so the free tier is plenty.
                cur = m.get("liveScore") or {}
                changed = (m.get("status") != "live"
                           or cur.get("home") != new_ls["home"] or cur.get("away") != new_ls["away"]
                           or cur.get("minute") != new_ls["minute"]
                           or len(cur.get("events") or []) != len(new_ls["events"]))
                if changed or stats_due:
                    upd = {"status": "live", "liveScore": new_ls,
                           "updatedAt": firestore.SERVER_TIMESTAMP}
                    if lv.get("fixture_id"):
                        upd["apiFixtureId"] = lv["fixture_id"]
                    if lv.get("event_id"):
                        upd["espnEventId"] = lv["event_id"]
                    if stats_due:
                        if espn_src and lv.get("event_id"):
                            stats = _espn_stats(lv["event_id"], lv.get("hid"), lv.get("aid"))
                        elif lv.get("fixture_id"):
                            stats = _af_stats(lv["fixture_id"], home, away)
                        else:
                            stats = None
                        if stats:
                            upd["liveStats"] = stats  # possession/shots/corners… for the panel
                            upd["liveStatsTs"] = now_ep
                    db.collection("matches").document(mid).update(upd)
            live_count += 1
            continue

        # Not live now → may be finished. Sources in order: ESPN (free, completed
        # flag + halftime linescores), then API-Football by-id, then football-data.
        final_score = half_score = api = None
        if lv and lv.get("completed"):
            final_score = {"home": lv["home"], "away": lv["away"]}
            half_score = _espn_halftime(lv.get("event_id"))
            api = None  # group stage has no shootout; knockout pens TODO via ESPN
        fid = m.get("apiFixtureId")
        if final_score is None and fid:
            fx = _af_fixture(fid)
            if fx and (((fx.get("fixture") or {}).get("status") or {}).get("short")) in AF_FINISHED:
                g = fx.get("goals") or {}
                if g.get("home") is not None and g.get("away") is not None:
                    final_score = {"home": int(g["home"]), "away": int(g["away"])}
                    htsc = (fx.get("score") or {}).get("halftime") or {}
                    half_score = ({"home": int(htsc["home"]), "away": int(htsc["away"])}
                                  if htsc.get("home") is not None and htsc.get("away") is not None else None)
                    api = fx  # _pen_winner reads score.penalty
        if final_score is None:  # fallback: football-data FINISHED
            fd = wc.get(key)
            if fd and fd.get("status") == "FINISHED":
                sc = fd.get("score") or {}
                ft = sc.get("fullTime") or {}
                if ft.get("home") is not None and ft.get("away") is not None:
                    final_score = {"home": int(ft["home"]), "away": int(ft["away"])}
                    htsc = sc.get("halfTime") or {}
                    half_score = ({"home": int(htsc["home"]), "away": int(htsc["away"])}
                                  if htsc.get("home") is not None and htsc.get("away") is not None else None)
                    api = fd  # _pen_winner reads score.penalties
        if final_score is None:
            continue  # not finished on either source yet — settle on a later tick

        line = f"{home} {final_score['home']}-{final_score['away']} {away}"
        if DRY:
            print(f"WOULD settle: {mid}  {line}  (HT {half_score})")
            settled_count += 1
            continue

        # Settle ATOMICALLY: match-doc status + every bet update + each user's
        # balance/openStake change all go in ONE batch.commit(). Previously the
        # match doc was flipped to 'settled' in a separate write BEFORE the bets
        # batch — if that batch failed (e.g. a 429 throttle) the match showed
        # 'settled' with no payouts. One batch = all-or-nothing.
        bets = list(db.collection("bets").where("matchId", "==", mid).stream())
        batch = db.batch()
        batch.update(db.collection("matches").document(mid), {
            "finalScore": final_score,
            "halftimeScore": half_score,
            "status": "settled",
            "liveScore": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        credits: dict[str, float] = {}
        released: dict[str, float] = {}   # stake leaving each user's locked openStake
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
            # This bet leaves the 'open' pool → release its stake from the bettor's
            # locked openStake (asset value = balance + openStake bookkeeping).
            released[bet["userId"]] = released.get(bet["userId"], 0) + bet.get("stake", 0)
            if outcome == "won":
                winners += 1
            if outcome in ("won", "lost"):
                predictions.append(_pred({**bet, "status": outcome, "payout": payout}))
        for uid in set(credits) | set(released):
            upd = {}
            cr = credits.get(uid, 0)
            rel = released.get(uid, 0)
            if cr:
                upd["balance"] = firestore.Increment(cr)
            if rel:
                upd["openStake"] = firestore.Increment(-rel)
            if upd:
                batch.update(db.collection("users").document(uid), upd)
        # public results reveal doc — in the SAME batch (all-or-nothing)
        batch.set(db.collection("results").document(mid), {
            "matchId": mid, "homeTeam": home, "awayTeam": away,
            "finalScore": final_score, "predictions": predictions,
            "winners": winners, "total": len(predictions),
            "settledAt": firestore.SERVER_TIMESTAMP,
        })
        batch.commit()

        settled_count += 1
        _send_telegram(f"⚽️ 自動結算:{line}\n{winners}/{len(predictions)} 個估中 · 已派彩 + 出賽果")
        print(f"settled {mid}: {line} ({winners}/{len(predictions)} winners)")

        # Champion auto-settle the moment the FINAL is decided.
        if (m.get("stage") or "").lower() == "final":
            champ = (home if final_score["home"] > final_score["away"]
                     else away if final_score["away"] > final_score["home"]
                     else _pen_winner(api, home, away))
            if champ:
                _settle_champion(db, champ)

    print(f"auto_settle done — {settled_count} settled, {live_count} live-updated "
          f"{'(dry-run)' if DRY else ''}")


def _pen_winner(api: dict, home: str, away: str):
    """Penalty-shootout winner. API-Football carries score.penalty; football-data
    used score.penalties — accept either."""
    sc = (api or {}).get("score") or {}
    pens = sc.get("penalty") or sc.get("penalties") or {}
    if pens.get("home") is not None and pens.get("away") is not None:
        if pens["home"] > pens["away"]:
            return home
        if pens["away"] > pens["home"]:
            return away
    return None


def _settle_champion(db, champion_team: str):
    """Auto-award the predict-the-champion game once the title is decided."""
    from firebase_admin import firestore
    cfg = db.collection("config").document("tournament")
    cur = cfg.get().to_dict() or {}
    if cur.get("championSettled"):
        return
    cfg.set({"champion": champion_team, "championSettled": True, "picksOpen": False,
             "settledAt": firestore.SERVER_TIMESTAMP}, merge=True)
    batch = db.batch()
    winners = 0
    total = 0
    for c in db.collection("champions").stream():
        cd = c.to_dict()
        total += 1
        if cd.get("awarded"):
            continue
        won = cd.get("pick") == champion_team
        payout = (cd.get("potential") or 0) if won else 0
        batch.update(c.reference, {"awarded": True, "won": won, "payout": payout})
        if won and payout > 0:
            batch.update(db.collection("users").document(cd["userId"]),
                         {"balance": firestore.Increment(payout)})
            winners += 1
    batch.commit()
    _send_telegram(f"🏆 冠軍誕生:{champion_team}!估冠軍已自動結算 · {winners}/{total} 人估中,已派彩。")
    print(f"champion settled: {champion_team} ({winners}/{total} correct)")


SCORES = ['0-0', '1-0', '0-1', '1-1', '2-0', '0-2', '2-1', '1-2', '2-2',
          '3-0', '0-3', '3-1', '1-3', '3-2', '2-3', '3-3']
LR_STAKE = 15  # small stake per market

# market labels — must match docs/js/markets.js
_MKT_LABEL = {
    "1x2": "Match result · 1X2", "score": "Exact score · 精確比數",
    "ht1x2": "Halftime result · 半場勝和負", "ou25": "Over/Under 2.5 · 入球大細",
    "btts": "Both teams to score · 兩隊入波",
}


def _ht_odds_from_ft(odds: dict) -> dict:
    """Port of markets.js htOddsFromFT — derive HT 1X2 odds from FT 1X2."""
    ftH = float(odds.get("home") or 2.5); ftA = float(odds.get("away") or 2.8)
    pH, pA = 1 / ftH, 1 / ftA
    ratio = pH / (pH + pA)
    evenness = 1 - abs(ratio - 0.5) * 2
    draw_p = 0.42 + 0.07 * evenness
    lead_p = 1 - draw_p
    h_share = 0.5 + (ratio - 0.5) * 0.7
    margin = 1.10
    to_odds = lambda p: max(1.05, round((1 / (p * margin)) * 100) / 100)
    return {"home": to_odds(lead_p * h_share), "draw": to_odds(draw_p),
            "away": to_odds(lead_p * (1 - h_share))}


def _poisson(k: int, lam: float) -> float:
    fact = [1, 1, 2, 6, 24, 120, 720]
    return math.exp(-lam) * (lam ** k) / (fact[k] if k < len(fact) else 5040)


def _mu_from_over25(p_over: float) -> float:
    pge3 = lambda m: 1 - math.exp(-m) * (1 + m + m * m / 2)
    lo, hi = 0.3, 6.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if pge3(mid) < p_over:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _match_lambdas(o: dict):
    o = o or {}
    mu = 2.7
    try:
        if o.get("over25") and o.get("under25"):
            ro, ru = 1 / o["over25"], 1 / o["under25"]
            mu = _mu_from_over25(ro / (ro + ru))
    except (TypeError, ZeroDivisionError):
        pass
    ph, pa = 0.40, 0.33
    try:
        if o.get("home") and o.get("draw") and o.get("away"):
            rh, rd, ra = 1 / o["home"], 1 / o["draw"], 1 / o["away"]
            s = rh + rd + ra
            ph, pa = rh / s, ra / s
    except (TypeError, ZeroDivisionError):
        pass
    share = min(0.82, max(0.18, 0.5 + 0.6 * (ph - pa)))
    return mu * share, mu * (1 - share)


def _score_odds_poisson(o: dict, h: int, a: int) -> float:
    """Poisson exact-score odds — mirrors markets.js scoreOdds()."""
    lh, la = _match_lambdas(o)
    p = _poisson(h, lh) * _poisson(a, la)
    return max(1.2, min(200, round((1 / (p * 1.12)) * 10) / 10))


def _lr_llm_picks(home: str, away: str, o: dict):
    """gpt-5-mini picks ONE selection + short reason per market. None on failure."""
    key = _env("OPENAI_API_KEY")
    if not key:
        return None
    sys_p = ("You are LillyRose, a sharp, witty football pundit for a friends' World "
             "Cup prediction game. Pick ONE selection for EACH of the 5 markets and give "
             "a very short reason (<= 12 words; English or Cantonese fine). Use ONLY the "
             "allowed selection codes. Respond with JSON only.")
    user_p = json.dumps({
        "match": f"{home} (home) vs {away} (away)",
        "ft_1x2_odds": {"home": o.get("home"), "draw": o.get("draw"), "away": o.get("away")},
        "ou25_odds": {"over": o.get("over25"), "under": o.get("under25")},
        "btts_odds": {"yes": o.get("btts_yes"), "no": o.get("btts_no")},
        "allowed": {"1x2": ["home", "draw", "away"], "ht1x2": ["home", "draw", "away"],
                    "ou25": ["over", "under"], "btts": ["yes", "no"], "score": SCORES},
        "respond_exactly": {"1x2": {"sel": "<code>", "why": "<reason>"},
                            "ht1x2": {"sel": "", "why": ""}, "ou25": {"sel": "", "why": ""},
                            "btts": {"sel": "", "why": ""}, "score": {"sel": "", "why": ""}},
    }, ensure_ascii=False)
    body = json.dumps({"model": "gpt-5-mini",
                       "messages": [{"role": "system", "content": sys_p},
                                    {"role": "user", "content": user_p}],
                       "max_completion_tokens": 1600,
                       "response_format": {"type": "json_object"}}).encode("utf-8")
    try:
        req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
                                     data=body, headers={"Authorization": f"Bearer {key}",
                                                         "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        return json.loads(data["choices"][0]["message"]["content"])
    except Exception as e:  # noqa: BLE001
        print(f"LR LLM picks failed: {e}", file=sys.stderr)
        return None


def _lr_bet_for_market(market: str, pick: dict, m: dict, o: dict):
    """Resolve a LillyRose pick into (selection, label, odds, why) or None."""
    sel = (pick or {}).get("sel")
    why = ((pick or {}).get("why") or "")[:120]
    home, away = m.get("homeTeam"), m.get("awayTeam")
    if market == "1x2":
        if sel not in ("home", "draw", "away"):
            return None
        odds = o.get(sel)
        label = "Draw" if sel == "draw" else f"{home if sel == 'home' else away} win"
    elif market == "ht1x2":
        if sel not in ("home", "draw", "away"):
            return None
        odds = _ht_odds_from_ft(o).get(sel)
        label = "Level at HT" if sel == "draw" else f"{home if sel == 'home' else away} lead HT"
    elif market == "ou25":
        if sel not in ("over", "under"):
            return None
        odds = o.get("over25") if sel == "over" else o.get("under25")
        label = "Over 2.5 goals" if sel == "over" else "Under 2.5 goals"
    elif market == "btts":
        if sel not in ("yes", "no"):
            return None
        odds = o.get("btts_yes") if sel == "yes" else o.get("btts_no")
        label = "Yes — both score" if sel == "yes" else "No — at least one zero"
    elif market == "score":
        ms = re.match(r"^(\d+)-(\d+)$", str(sel))  # accept ANY scoreline (not just the grid)
        if not ms:
            return None
        h, a = int(ms.group(1)), int(ms.group(2))
        odds = _score_odds_poisson(o, h, a)  # same Poisson model as the user-facing UI
        label = f"{home} {h} - {a} {away}"
    else:
        return None
    if not isinstance(odds, (int, float)):
        return None
    return sel, label, round(float(odds), 2), why


def _lillyrose_autobet(db) -> int:
    """LillyRose AI tipster: for each match kicking off in the next 12h, she picks
    ONE selection per market (1X2 / exact score / HT / O/U 2.5 / BTTS) via gpt-5-mini
    and places a small bet on each, with a short reason. Idempotent per (match, market).
    Falls back to the 1X2 favourite if the LLM is unavailable."""
    import random
    from firebase_admin import firestore
    LR = "lillyrose-ai"
    uref = db.collection("users").document(LR)
    usnap = uref.get()
    if not usnap.exists:
        return 0
    bal = usnap.to_dict().get("balance", 0)
    already = {(b.to_dict().get("matchId"), b.to_dict().get("market"))
               for b in db.collection("bets").where("userId", "==", LR).stream()}
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(hours=12)
    placed = 0
    for d in db.collection("matches").stream():
        m = d.to_dict()
        if m.get("status") == "settled":
            continue
        if m.get("homeTeam") in (None, "", "TBD") or m.get("awayTeam") in (None, "", "TBD"):
            continue
        try:
            ko = datetime.fromisoformat((m.get("kickoffISO", "") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        if not (now < ko < horizon):
            continue
        markets = ["1x2", "score", "ht1x2", "ou25", "btts"]
        todo = [mk for mk in markets if (d.id, mk) not in already]
        if not todo:
            continue
        o = m.get("odds") or {}
        picks = _lr_llm_picks(m["homeTeam"], m["awayTeam"], o) or {}
        mbets = []  # picks placed on THIS match, for the Telegram notify
        for mk in todo:
            resolved = _lr_bet_for_market(mk, picks.get(mk), m, o)
            if not resolved and mk == "1x2":
                # fallback: favourite by FT odds
                cands = [("home", o.get("home")), ("draw", o.get("draw")), ("away", o.get("away"))]
                cands = [c for c in cands if isinstance(c[1], (int, float))]
                if cands:
                    cands.sort(key=lambda c: c[1])
                    s = cands[0][0]
                    resolved = _lr_bet_for_market("1x2", {"sel": s, "why": "favourite by odds"}, m, o)
            if not resolved:
                continue
            sel, label, odds, why = resolved
            if DRY:
                print(f"WOULD LR-bet {d.id} [{mk}]: {sel} @ {odds} ({why})")
                continue
            if bal < LR_STAKE:
                break
            db.collection("bets").add({
                "userId": LR, "userEmail": "lillyrose@ai.local", "userDisplayName": "LillyRose 🤖",
                "matchId": d.id, "matchLabel": f"{m['homeTeam']} vs {m['awayTeam']}",
                "market": mk, "marketLabel": _MKT_LABEL[mk],
                "selection": sel, "selectionLabel": label,
                "stake": LR_STAKE, "odds": odds, "status": "open",
                "aiReason": why, "placedAt": firestore.SERVER_TIMESTAMP, "isAI": True,
            })
            uref.update({"balance": firestore.Increment(-LR_STAKE),
                         "openStake": firestore.Increment(LR_STAKE)})
            bal -= LR_STAKE
            already.add((d.id, mk))
            placed += 1
            mbets.append((mk, label, odds, why))
        # Notify Anzon of LillyRose's picks for this match (one message per match).
        if mbets:
            emoji = {"1x2": "🏆", "score": "🎯", "ht1x2": "⏱", "ou25": "⚽", "btts": "🥅"}
            lines = [f"🤖 LillyRose 落咗注 · {m['homeTeam']} vs {m['awayTeam']}"]
            for mk, label, odds, why in mbets:
                lines.append(f"{emoji.get(mk, '•')} {label} @ {odds}" + (f" — {why}" if why else ""))
            lines.append(f"\n每注 {LR_STAKE} 分 · 餘額 {bal}")
            _send_telegram("\n".join(lines))
    if placed:
        print(f"LillyRose auto-bet {placed} market(s)")
    return placed
    return placed


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

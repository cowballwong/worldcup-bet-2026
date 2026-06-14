"""World Cup bet reminder — nudge Anzon to place bets before kickoff.

Anzon keeps forgetting to bet. This finds today's UPCOMING (not-yet-kicked-off,
not settled) matches that he has NOT bet on yet, and Telegrams him a copy of the
list + the game link. Silent if there's nothing to remind (all bet / no matches)
so it never nags.

Run a couple of times a day (e.g. 14:00 + 18:00 UK) via Task Scheduler; the
self-suppression means a run after he's bet everything sends nothing.

    python bet_reminder.py            # send reminder if any un-bet upcoming match
    python bet_reminder.py --dry-run  # print, send nothing

Resilient + pythonw-safe (no console → log to file; never crash the schedule).
"""
from __future__ import annotations

import io
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

# pythonw (Task Scheduler, no console) → stdout/stderr None → first print crashes.
if sys.stdout is None or sys.stderr is None:
    try:
        _lf = open(Path(__file__).resolve().parent / "bet_reminder.log", "a", encoding="utf-8")
        sys.stdout = sys.stdout or _lf
        sys.stderr = sys.stderr or _lf
    except Exception:  # noqa: BLE001
        sys.stdout = sys.stdout or io.StringIO()
        sys.stderr = sys.stderr or io.StringIO()

DRY = "--dry-run" in sys.argv
SECRETS = Path(r"G:/My Drive/AI_Development/07_secrets")
ENV = SECRETS / ".env"
SA_JSON = SECRETS / "worldcup-bet-firebase-admin.json"
CHAT_ID = "7563892302"
GAME_URL = "https://cowballwong.github.io/worldcup-bet-2026/"
ANZON_EMAIL = "cowballwong@gmail.com"
LOOKAHEAD_H = 20  # remind about matches kicking off within the next N hours


def _env(key: str) -> str | None:
    try:
        for line in ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return None


def _send_telegram(text: str) -> bool:
    token = _env("TELEGRAM_BOT_TOKEN")
    if not token:
        print("[ERROR] no TELEGRAM_BOT_TOKEN", file=sys.stderr)
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": CHAT_ID, "text": text}).encode()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=30) as r:
                if r.status == 200:
                    return True
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] send attempt {attempt+1}: {exc}", file=sys.stderr)
            time.sleep(3)
    return False


def main() -> int:
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SA_JSON)))
    db = firestore.client()

    now = datetime.now(timezone.utc)
    horizon = now + timedelta(hours=LOOKAHEAD_H)

    # Upcoming, not-settled matches within the look-ahead window.
    upcoming = []
    for d in db.collection("matches").stream():
        m = d.to_dict() or {}
        if m.get("status") == "settled":
            continue
        ko = m.get("kickoffISO")
        if not ko:
            continue
        try:
            kt = datetime.fromisoformat(ko).astimezone(timezone.utc)
        except ValueError:
            continue
        if now < kt <= horizon:
            upcoming.append((kt, d.id, m))
    upcoming.sort(key=lambda x: x[0])

    if not upcoming:
        print("No upcoming matches in window — nothing to remind.")
        return 0

    # Anzon's uid (by email, fallback displayName contains 'Anzon').
    uid = None
    for u in db.collection("users").stream():
        ud = u.to_dict() or {}
        if (ud.get("email", "").lower() == ANZON_EMAIL
                or "anzon" in (ud.get("displayName", "").lower())):
            uid = u.id
            break
    if not uid:
        print("[WARN] Anzon user doc not found — reminding about all upcoming.", file=sys.stderr)

    # Matches he's already bet on.
    bet_match_ids = set()
    if uid:
        for b in db.collection("bets").where("userId", "==", uid).stream():
            bet_match_ids.add((b.to_dict() or {}).get("matchId"))

    unbet = [(kt, mid, m) for kt, mid, m in upcoming if mid not in bet_match_ids]
    if not unbet:
        print(f"All {len(upcoming)} upcoming match(es) already bet — staying quiet.")
        return 0

    lines = ["⚽ 提你落注！今日仲未落呢啲場(開波前搞掂):", ""]
    for kt, mid, m in unbet:
        bst = kt + timedelta(hours=1)  # UTC -> BST (summer); good enough for display
        when = bst.strftime("%H:%M")
        lines.append(f"• {m.get('homeTeam','?')} vs {m.get('awayTeam','?')} — {when} (UK)")
    lines += ["", f"👉 入去落注:{GAME_URL}"]
    msg = "\n".join(lines)

    print(msg)
    if DRY:
        print("\n[DRY-RUN] not sent.")
        return 0
    print("sent" if _send_telegram(msg) else "send FAILED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""backfill_openstake.py — one-time: set users.openStake = sum of their OPEN bet stakes.

The leaderboard now ranks by ASSET VALUE = balance (cash) + openStake (points locked
in open / un-settled bets). Existing user docs predate the openStake field, so this
backfills it once. Balance already had stakes deducted when bets were placed, so we
ONLY set openStake (never touch balance) — asset = balance + openStake then reflects
each player's true total.

    python backfill_openstake.py            # write openStake on every user
    python backfill_openstake.py --dry-run  # show what WOULD change, write nothing

Idempotent: re-running recomputes from the current open bets, so it's safe to repeat.
"""
from __future__ import annotations

import sys
from pathlib import Path

SECRETS = Path(r"G:/My Drive/AI_Development/07_secrets")
SA_JSON = SECRETS / "worldcup-bet-firebase-admin.json"
DRY = "--dry-run" in sys.argv

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def main() -> int:
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SA_JSON)))
    db = firestore.client()

    # Sum open-bet stakes per user.
    locked: dict[str, float] = {}
    n_open = 0
    for b in db.collection("bets").where("status", "==", "open").stream():
        bet = b.to_dict()
        uid = bet.get("userId")
        if not uid:
            continue
        locked[uid] = locked.get(uid, 0) + (bet.get("stake", 0) or 0)
        n_open += 1

    users = list(db.collection("users").stream())
    print(f"{len(users)} users, {n_open} open bets, {len(locked)} users with locked stake.")

    changed = 0
    for u in users:
        uid = u.id
        cur = (u.to_dict() or {}).get("openStake")
        want = locked.get(uid, 0)
        if cur == want:
            continue
        name = (u.to_dict() or {}).get("displayName", uid)
        print(f"  {'DRY ' if DRY else ''}{name}: openStake {cur} -> {want}")
        changed += 1
        if not DRY:
            db.collection("users").document(uid).update({"openStake": want})

    print(f"{'DRY: would update' if DRY else 'Updated'} {changed} user(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

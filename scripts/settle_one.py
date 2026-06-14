"""One-off RESILIENT settler for a single match, for when Firestore is throttled
(post-quota-exhaustion burst limiting). Splits the settlement into small atomic
per-bet batches (bet doc + its user's balance/openStake committed together) with
429 backoff, then flips the match doc + results reveal last. Idempotent: a bet is
only touched while still 'open', so a re-run after a partial failure safely
continues without double-crediting.

Usage:  python settle_one.py <matchId> <homeGoals> <awayGoals> <htHome> <htAway>
"""
import sys
import time

sys.path.insert(0, ".")
import auto_settle as a  # noqa: E402
import firebase_admin  # noqa: E402
from firebase_admin import credentials, firestore  # noqa: E402
from google.api_core.exceptions import ResourceExhausted  # noqa: E402

mid = sys.argv[1]
fs = {"home": int(sys.argv[2]), "away": int(sys.argv[3])}
hs = {"home": int(sys.argv[4]), "away": int(sys.argv[5])}

if not firebase_admin._apps:
    firebase_admin.initialize_app(credentials.Certificate(str(a.SA_JSON)))
db = firestore.client()


def retry(fn, label):
    """Run any Firestore op with patient 429 backoff. Survives the post-quota
    throttle that lets only a trickle of ops through at a time."""
    for attempt in range(40):
        try:
            return fn()
        except ResourceExhausted:
            wait = min(20, 2 * (attempt + 1))
            print(f"  429 on {label}, retry in {wait}s ({attempt+1}/40)", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"gave up on {label} after 40 tries")


def commit(batch, label):
    retry(batch.commit, label)
    return True


m = retry(lambda: db.collection("matches").document(mid).get().to_dict(), "read match")
home, away = m.get("homeTeam"), m.get("awayTeam")
if m.get("status") == "settled":
    print("already settled — nothing to do")
    sys.exit(0)

bets = retry(lambda: list(db.collection("bets").where("matchId", "==", mid).stream()), "read bets")
print(f"{home} {fs['home']}-{fs['away']} {away} · {len(bets)} bets", flush=True)

settled_now = 0
for b in bets:
    bet = b.to_dict()
    if bet.get("status") != "open":
        continue
    outcome = a.evaluate(bet.get("market", ""), bet.get("selection", ""), fs, hs)
    if outcome is None:
        continue
    payout = (bet.get("stake", 0) if outcome == "void"
              else round(bet.get("stake", 0) * bet.get("odds", 0)) if outcome == "won" else 0)
    batch = db.batch()
    batch.update(b.reference, {"status": outcome, "payout": payout,
                              "settledAt": firestore.SERVER_TIMESTAMP})
    uupd = {"openStake": firestore.Increment(-bet.get("stake", 0))}
    if payout > 0:
        uupd["balance"] = firestore.Increment(payout)
    batch.update(db.collection("users").document(bet["userId"]), uupd)
    if commit(batch, f"bet {b.id}"):
        settled_now += 1
    time.sleep(0.4)

# Rebuild predictions + winners from a fresh read (covers re-runs after partials)
fresh = [d.to_dict() for d in retry(
    lambda: list(db.collection("bets").where("matchId", "==", mid).stream()), "reread bets")]
predictions = [a._pred(x) for x in fresh if x.get("status") in ("won", "lost")]
winners = sum(1 for x in fresh if x.get("status") == "won")

# Flip match doc + write results reveal LAST (so a partial run leaves status=live
# and is safely resumable).
batch = db.batch()
batch.update(db.collection("matches").document(mid), {
    "finalScore": fs, "halftimeScore": hs, "status": "settled",
    "liveScore": None, "updatedAt": firestore.SERVER_TIMESTAMP})
batch.set(db.collection("results").document(mid), {
    "matchId": mid, "homeTeam": home, "awayTeam": away, "finalScore": fs,
    "predictions": predictions, "winners": winners, "total": len(predictions),
    "settledAt": firestore.SERVER_TIMESTAMP})
ok = commit(batch, "match+results")

print(f"DONE: settled {settled_now} bets this run · {winners}/{len(predictions)} winners · match flip {'OK' if ok else 'FAILED'}")

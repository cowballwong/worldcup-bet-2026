// Pure-function bet evaluators. Given a settled match (finalScore +
// halftimeScore) and a single bet, decide whether the bet won.
//
// Each market exports a `selections(match)` describing the betting
// options the player can choose, and an `evaluate(bet, match)` that
// returns 'won' | 'lost' for that bet at settlement time.

export const MARKETS = {

  // ── 1X2 — Match result at full-time ───────────────────────
  '1x2': {
    label: 'Match result · 1X2 全場勝和負',
    selections(match) {
      return [
        { code: 'home', label: `${match.homeFlag} ${match.homeTeam} win`, odds: match.odds.home },
        { code: 'draw', label: 'Draw 和波',                                  odds: match.odds.draw },
        { code: 'away', label: `${match.awayFlag} ${match.awayTeam} win`, odds: match.odds.away },
      ];
    },
    evaluate(bet, match) {
      const fs = match.finalScore;
      if (!fs) return null;
      if (fs.home > fs.away) return bet.selection === 'home' ? 'won' : 'lost';
      if (fs.home < fs.away) return bet.selection === 'away' ? 'won' : 'lost';
      return bet.selection === 'draw' ? 'won' : 'lost';
    }
  },

  // ── Exact score ────────────────────────────────────────────
  // We expose a fixed grid of common scorelines. Exact-score odds
  // are NOT in fixtures.json (would explode); we compute a simple
  // payout multiplier from the implied probability instead.
  'score': {
    label: 'Exact score · 精確比數',
    selections(match) {
      const SCORES = [
        '0-0','1-0','0-1','1-1','2-0','0-2','2-1','1-2','2-2','3-0','0-3','3-1','1-3','3-2','2-3','3-3'
      ];
      return SCORES.map(code => {
        const [h, a] = code.split('-').map(Number);
        const odds = exactScoreOdds(h, a);
        return { code, label: `${match.homeFlag} ${h} - ${a} ${match.awayFlag}`, odds };
      });
    },
    evaluate(bet, match) {
      const fs = match.finalScore;
      if (!fs) return null;
      const [h, a] = bet.selection.split('-').map(Number);
      return (h === fs.home && a === fs.away) ? 'won' : 'lost';
    }
  },

  // ── Halftime 1X2 ───────────────────────────────────────────
  'ht1x2': {
    label: 'Halftime result · 半場勝和負',
    selections(match) {
      // Use a flat 2.6/2.1/3.4 unless admin set per-match HT odds.
      const o = match.odds.ht || { home: 2.50, draw: 2.10, away: 3.40 };
      return [
        { code: 'home', label: `${match.homeFlag} ${match.homeTeam} lead HT`, odds: o.home },
        { code: 'draw', label: 'Level at HT 半場和',                            odds: o.draw },
        { code: 'away', label: `${match.awayFlag} ${match.awayTeam} lead HT`, odds: o.away },
      ];
    },
    evaluate(bet, match) {
      const ht = match.halftimeScore;
      if (!ht) return null;
      if (ht.home > ht.away) return bet.selection === 'home' ? 'won' : 'lost';
      if (ht.home < ht.away) return bet.selection === 'away' ? 'won' : 'lost';
      return bet.selection === 'draw' ? 'won' : 'lost';
    }
  },

  // ── Over/Under 2.5 goals ───────────────────────────────────
  'ou25': {
    label: 'Over/Under 2.5 · 入球大細',
    selections(match) {
      return [
        { code: 'over',  label: 'Over 2.5 (3 球或以上) 大',  odds: match.odds.over25 },
        { code: 'under', label: 'Under 2.5 (2 球或以下) 細', odds: match.odds.under25 },
      ];
    },
    evaluate(bet, match) {
      const fs = match.finalScore;
      if (!fs) return null;
      const total = fs.home + fs.away;
      if (bet.selection === 'over') return total > 2.5 ? 'won' : 'lost';
      if (bet.selection === 'under') return total < 2.5 ? 'won' : 'lost';
      return 'lost';
    }
  },

  // ── Both teams to score ────────────────────────────────────
  'btts': {
    label: 'Both teams to score · 兩隊入波',
    selections(match) {
      return [
        { code: 'yes', label: 'Yes 係 (both score)',   odds: match.odds.btts_yes },
        { code: 'no',  label: 'No 否 (at least one zero)', odds: match.odds.btts_no },
      ];
    },
    evaluate(bet, match) {
      const fs = match.finalScore;
      if (!fs) return null;
      const both = fs.home > 0 && fs.away > 0;
      if (bet.selection === 'yes') return both ? 'won' : 'lost';
      if (bet.selection === 'no')  return both ? 'lost' : 'won';
      return 'lost';
    }
  },
};


// Simple exact-score odds derived from a Poisson-ish heuristic.
// Not real bookmaker odds — good enough for a friends game.
function exactScoreOdds(h, a) {
  // Base: more common scores have lower odds. Penalise large goal counts.
  const total = h + a;
  const balance = Math.abs(h - a);
  const base = 6 + total * 2.5 + balance * 1.2;
  // Common scores get a discount:
  const common = { '1-1': 0.7, '2-1': 0.75, '1-2': 0.75, '1-0': 0.7, '0-1': 0.7, '2-0': 0.8, '0-2': 0.8, '0-0': 0.85, '2-2': 0.95 };
  const k = common[`${h}-${a}`] ?? 1.0;
  return Math.round(base * k * 10) / 10;
}


export function getMarketLabel(code) {
  return MARKETS[code]?.label ?? code;
}

export function getSelectionLabel(marketCode, selectionCode, match) {
  const market = MARKETS[marketCode];
  if (!market) return selectionCode;
  const sel = market.selections(match).find(s => s.code === selectionCode);
  return sel?.label ?? selectionCode;
}

// Settlement helper — given a settled match and all open bets on it,
// returns the array of bet updates to apply.
export function settleBetsForMatch(match, openBets) {
  const updates = [];
  for (const bet of openBets) {
    const market = MARKETS[bet.market];
    if (!market) {
      updates.push({ ...bet, status: 'void', payout: bet.stake });  // refund
      continue;
    }
    const outcome = market.evaluate(bet, match);
    if (outcome === null) {
      // Shouldn't happen if caller checks finalScore exists.
      continue;
    }
    const payout = outcome === 'won' ? Math.round(bet.stake * bet.odds) : 0;
    updates.push({ ...bet, status: outcome, payout, settledAt: new Date().toISOString() });
  }
  return updates;
}

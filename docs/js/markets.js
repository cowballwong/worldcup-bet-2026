// Pure-function bet evaluators. Given a settled match (finalScore +
// halftimeScore) and a single bet, decide whether the bet won.
//
// Each market exports a `selections(match)` describing the betting
// options the player can choose, and an `evaluate(bet, match)` that
// returns 'won' | 'lost' for that bet at settlement time.

import { TEAM_ZH } from "./teams-zh.js";

// Stacked bilingual label: English on top, 繁體 below.
function bi(en, zh) {
  return `<span class="team-bilingual"><span class="team-en">${en}</span><span class="team-zh">${zh}</span></span>`;
}
function teamBi(team, suffixEn, suffixZh, flag) {
  const zh = TEAM_ZH[team] || '';
  return `<span class="team-bilingual"><span class="team-en">${flag || ''} ${team}${suffixEn ? ' ' + suffixEn : ''}</span><span class="team-zh">${zh}${suffixZh || ''}</span></span>`;
}

export const MARKETS = {

  // ── 1X2 — Match result at full-time ───────────────────────
  '1x2': {
    label: 'Match result · 1X2 全場勝和負',
    selections(match) {
      const o = match.odds || {};
      return [
        { code: 'home', label: teamBi(match.homeTeam, 'win', '勝', match.homeFlag), odds: o.home ?? '—' },
        { code: 'draw', label: bi('Draw', '和波'),                                   odds: o.draw ?? '—' },
        { code: 'away', label: teamBi(match.awayTeam, 'win', '勝', match.awayFlag), odds: o.away ?? '—' },
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
      // Poisson model: λ per team derived from THIS match's 1X2 + O/U odds, so
      // odds track how lopsided / high-scoring the match is (real bookmaker method).
      const { lh, la } = matchLambdas(match.odds);
      let gridP = 0;
      const grid = SCORES.map(code => {
        const [h, a] = code.split('-').map(Number);
        const p = poisson(h, lh) * poisson(a, la);
        gridP += p;
        const enRow = `${match.homeFlag} ${h} - ${a} ${match.awayFlag}`;
        const zhHome = TEAM_ZH[match.homeTeam] || match.homeTeam;
        const zhAway = TEAM_ZH[match.awayTeam] || match.awayTeam;
        const zhRow = `${zhHome} ${h} - ${a} ${zhAway}`;
        return { code, label: bi(enRow, zhRow), odds: scoreOddsFromProb(p) };
      });
      // Catch-all for any scoreline beyond the 0-3 × 0-3 grid (e.g. Germany 4-1).
      // Its probability = 1 − Σ(grid), so its odds also track the match (a lopsided
      // high-scoring game → 4+ likely → lower odds; a tight game → higher odds).
      const pOther = Math.max(0.004, 1 - gridP);
      grid.push({ code: 'other', label: bi('🎯 Any other score (a team scores 4+)', '🎯 其他比數 (有一隊入 4 球或以上)'), odds: scoreOddsFromProb(pOther) });
      return grid;
    },
    evaluate(bet, match) {
      const fs = match.finalScore;
      if (!fs) return null;
      if (bet.selection === 'other') return (fs.home > 3 || fs.away > 3) ? 'won' : 'lost';
      const [h, a] = bet.selection.split('-').map(Number);
      return (h === fs.home && a === fs.away) ? 'won' : 'lost';
    }
  },

  // ── Halftime 1X2 ───────────────────────────────────────────
  'ht1x2': {
    label: 'Halftime result · 半場勝和負',
    selections(match) {
      // Per-match HT odds. Admin override wins; otherwise DERIVE from this
      // match's full-time 1X2 odds (so every match differs) — at halftime a
      // level score is much more likely and leads are less established.
      const o = (match.odds || {}).ht || htOddsFromFT(match.odds || {});
      return [
        { code: 'home', label: teamBi(match.homeTeam, 'lead HT', '半場領先', match.homeFlag), odds: o.home },
        { code: 'draw', label: bi('Level at HT', '半場和波'),                                  odds: o.draw },
        { code: 'away', label: teamBi(match.awayTeam, 'lead HT', '半場領先', match.awayFlag), odds: o.away },
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
      const o = match.odds || {};
      return [
        { code: 'over',  label: bi('Over 2.5 goals',  '大 (3 球或以上)'),  odds: o.over25 ?? '—' },
        { code: 'under', label: bi('Under 2.5 goals', '細 (2 球或以下)'), odds: o.under25 ?? '—' },
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
      const o = match.odds || {};
      return [
        { code: 'yes', label: bi('Yes — both score',          '係 — 兩隊都入波'), odds: o.btts_yes ?? '—' },
        { code: 'no',  label: bi('No — at least one zero',    '否 — 至少一隊零蛋'), odds: o.btts_no ?? '—' },
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


// Derive plausible per-match HALFTIME 1X2 odds from the full-time 1X2 odds.
// At HT a level score is far more common and leads aren't yet established, so we
// pull a big chunk of each side's win-probability into the draw. Result varies
// per match (a strong favourite is still likelier to lead at HT than an underdog).
function htOddsFromFT(odds) {
  const ftH = Number(odds.home) || 2.5;
  const ftA = Number(odds.away) || 2.8;
  const pH = 1 / ftH, pA = 1 / ftA;                    // FT win-implied strengths
  const ratio = pH / (pH + pA);                        // home's share of "someone leads"
  // Real-world halftime baseline: a level score is most common. Even matches are
  // a touch MORE likely to be level at HT; lopsided ones slightly less (the
  // favourite leads more often). So vary the draw with how even the match is.
  const evenness = 1 - Math.abs(ratio - 0.5) * 2;      // 1 = even, 0 = lopsided
  const drawProb = 0.42 + 0.07 * evenness;             // ~0.42–0.49
  const leadProb = 1 - drawProb;
  const hShare = 0.5 + (ratio - 0.5) * 0.7;            // compress toward 50/50
  const pHTh = leadProb * hShare;
  const pHTa = leadProb * (1 - hShare);
  const MARGIN = 1.10;                                 // bookish overround
  const toOdds = p => Math.max(1.05, Math.round((1 / (p * MARGIN)) * 100) / 100);
  return { home: toOdds(pHTh), draw: toOdds(drawProb), away: toOdds(pHTa) };
}


// ── Poisson correct-score model ────────────────────────────────
// Real bookmakers price correct-score by Poisson: derive each team's expected
// goals (λ) then P(h-a) = Poisson(h,λh)·Poisson(a,λa). We back λ out of the
// match's OWN 1X2 + Over/Under-2.5 odds so every match is priced individually,
// and "other" = 1 − Σ(grid) is priced consistently with the grid.
function poisson(k, lambda) {
  const fact = [1, 1, 2, 6, 24, 120, 720];
  return Math.exp(-lambda) * Math.pow(lambda, k) / (fact[k] ?? 5040);
}
function devig(...rs) { const s = rs.reduce((x, y) => x + y, 0) || 1; return rs.map(r => r / s); }
function muFromOver25(pOver) {
  // Solve μ so that P(total ≥ 3) = pOver, total ~ Poisson(μ). Bisection.
  const pge3 = m => 1 - Math.exp(-m) * (1 + m + m * m / 2);
  let lo = 0.3, hi = 6;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (pge3(mid) < pOver) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function matchLambdas(o) {
  o = o || {};
  let mu = 2.7;                                   // default total expected goals
  if (o.over25 && o.under25) {
    const [pov] = devig(1 / o.over25, 1 / o.under25);
    mu = muFromOver25(pov);
  }
  let ph = 0.40, pa = 0.33;                        // default home/away tilt
  if (o.home && o.draw && o.away) {
    const [h, , a] = devig(1 / o.home, 1 / o.draw, 1 / o.away);
    ph = h; pa = a;
  }
  let share = 0.5 + 0.6 * (ph - pa);              // home's share of the goals
  share = Math.min(0.82, Math.max(0.18, share));
  return { lh: mu * share, la: mu * (1 - share) };
}
const SCORE_MARGIN = 1.12;                         // house overround on correct-score
function scoreOddsFromProb(p) {
  return Math.max(1.2, Math.min(200, Math.round((1 / (p * SCORE_MARGIN)) * 10) / 10));
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

// Outright "to win the World Cup" decimal odds, used by the Predict-the-champion
// game. Payout for a correct (free) pick = CHAMPION_BASE × locked odds.
//
// These are sensible pre-tournament defaults (≈ June 2026 market). The admin can
// override the whole map via config/champion_odds, or auto-pull from The Odds API
// (market: soccer_fifa_world_cup_winner) later. Odds are LOCKED on the user's
// pick, so later edits never change an existing prediction's payout.
export const CHAMPION_BASE = 100;

export const DEFAULT_CHAMPION_ODDS = {
  "Spain": 5.5,
  "France": 6,
  "Brazil": 6.5,
  "England": 7.5,
  "Argentina": 8.5,
  "Germany": 11,
  "Portugal": 13,
  "Netherlands": 15,
  "Belgium": 21,
  "Norway": 26,
  "Croatia": 34,
  "Uruguay": 34,
  "United States": 41,
  "Colombia": 41,
  "Morocco": 41,
  "Mexico": 51,
  "Switzerland": 67,
  "Japan": 67,
  "Senegal": 81,
  "Ecuador": 81,
  "Côte d'Ivoire": 101,
  "Austria": 101,
  "Sweden": 101,
  "Türkiye": 101,
  "South Korea": 126,
  "Egypt": 151,
  "Australia": 151,
  "Canada": 151,
  "Paraguay": 201,
  "Scotland": 201,
  "DR Congo": 201,
  "Ghana": 251,
  "Czechia": 251,
  "Iran": 251,
  "Qatar": 301,
  "Saudi Arabia": 301,
  "Algeria": 301,
  "Bosnia and Herzegovina": 501,
  "Panama": 501,
  "Tunisia": 501,
  "South Africa": 751,
  "Cabo Verde": 751,
  "Uzbekistan": 751,
  "Iraq": 751,
  "New Zealand": 1001,
  "Jordan": 1001,
  "Curaçao": 1501,
  "Haiti": 1501,
};

// Resolve a team's odds: config override first, else default, else a generic
// long-shot price so an unknown knockout team is still pickable.
export function championOddsFor(team, overrideMap) {
  if (overrideMap && Number.isFinite(overrideMap[team])) return overrideMap[team];
  if (Number.isFinite(DEFAULT_CHAMPION_ODDS[team])) return DEFAULT_CHAMPION_ODDS[team];
  return 251;
}

export function championPayout(team, overrideMap, base) {
  const b = Number.isFinite(base) ? base : CHAMPION_BASE;
  return Math.round(b * championOddsFor(team, overrideMap));
}

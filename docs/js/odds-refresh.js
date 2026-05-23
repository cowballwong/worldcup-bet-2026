// Fetch market odds from The Odds API and propose updates to fixtures.json
// (writes are committed by admin.js via a single batch).
//
// Free tier: 500 requests/month. One refresh = one request — plenty for a
// whole tournament.

// Some team names differ between our fixtures and the API; map either way.
// Left = name as it appears in our `matches/{id}.homeTeam / awayTeam`
// Right = name as it appears in the Odds API events.
const NAME_SYNONYMS = new Map([
  ["United States",     "USA"],
  ["Türkiye",           "Turkey"],
  ["Czechia",           "Czech Republic"],
  ["South Korea",       "Korea Republic"],
  ["Cabo Verde",        "Cape Verde"],
  ["Côte d'Ivoire",     "Ivory Coast"],
  ["DR Congo",          "DR Congo"],
  ["Bosnia and Herzegovina", "Bosnia & Herzegovina"],
]);

function normaliseName(n) {
  if (!n) return "";
  return n.trim().toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .replace(/and/g, "&")
    .replace(/&/g, " and ")
    .trim();
}

function teamMatches(ourName, apiName) {
  if (!ourName || !apiName) return false;
  const a = normaliseName(ourName);
  const b = normaliseName(apiName);
  if (a === b) return true;
  // Try syn map
  const syn = NAME_SYNONYMS.get(ourName);
  if (syn && normaliseName(syn) === b) return true;
  // Reverse direction
  for (const [our, api] of NAME_SYNONYMS) {
    if (normaliseName(api) === b && our === ourName) return true;
  }
  // Contains fallback
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

function median(arr) {
  const a = arr.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : Math.round(((a[n / 2 - 1] + a[n / 2]) / 2) * 100) / 100;
}

// Distil a multi-bookmaker event into a single odds object.
function reduceEvent(event) {
  const home = [], draw = [], away = [];
  const over = [], under = [];
  const yes = [], no_ = [];
  for (const bm of event.bookmakers || []) {
    for (const m of bm.markets || []) {
      if (m.key === "h2h") {
        for (const o of m.outcomes) {
          if (o.name === event.home_team) home.push(o.price);
          else if (o.name === event.away_team) away.push(o.price);
          else if (o.name === "Draw") draw.push(o.price);
        }
      } else if (m.key === "totals") {
        for (const o of m.outcomes) {
          if (o.point === 2.5 && o.name === "Over") over.push(o.price);
          if (o.point === 2.5 && o.name === "Under") under.push(o.price);
        }
      } else if (m.key === "btts") {
        for (const o of m.outcomes) {
          if (o.name === "Yes") yes.push(o.price);
          if (o.name === "No") no_.push(o.price);
        }
      }
    }
  }
  const odds = {
    home: median(home), draw: median(draw), away: median(away),
    over25: median(over), under25: median(under),
    btts_yes: median(yes), btts_no: median(no_),
  };
  return odds;
}

// Find a fixture in matches that matches an Odds API event.
// Match on (home, away) team-name pair AND kickoff time within ±90 minutes.
function findFixture(event, fixtures) {
  const kickoffApi = new Date(event.commence_time).getTime();
  for (const m of fixtures) {
    if (!m.kickoffISO || !m.homeTeam || !m.awayTeam) continue;
    if (m.homeTeam === "TBD" || m.awayTeam === "TBD") continue;
    const kickoffMine = new Date(m.kickoffISO).getTime();
    if (Math.abs(kickoffMine - kickoffApi) > 90 * 60 * 1000) continue;
    if (teamMatches(m.homeTeam, event.home_team) &&
        teamMatches(m.awayTeam, event.away_team)) return m;
    // Some feeds invert home/away — accept either side
    if (teamMatches(m.homeTeam, event.away_team) &&
        teamMatches(m.awayTeam, event.home_team)) {
      // Don't auto-swap; just match the fixture
      return m;
    }
  }
  return null;
}

// Public: returns { updates: [{matchId, oldOdds, newOdds}], unmatchedApi: [...], requestUsage }
export async function fetchAndPair(apiKey, fixtures) {
  if (!apiKey) {
    throw new Error("Missing ODDS_API_KEY. Get one at the-odds-api.com and paste into firebase-config.js.");
  }
  const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/` +
              `?apiKey=${encodeURIComponent(apiKey)}` +
              `&regions=uk,eu` +
              `&markets=h2h,totals` +
              `&oddsFormat=decimal`;
  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Odds API ${r.status}: ${txt.slice(0, 200)}`);
  }
  const events = await r.json();
  const usage = {
    remaining: r.headers.get("x-requests-remaining"),
    used:      r.headers.get("x-requests-used"),
  };

  const updates = [];
  const unmatched = [];
  for (const ev of events) {
    const m = findFixture(ev, fixtures);
    if (!m) { unmatched.push({ home: ev.home_team, away: ev.away_team, commence: ev.commence_time }); continue; }
    const newOdds = reduceEvent(ev);
    // Skip if every market came back null (no bookmaker quoted it)
    if (Object.values(newOdds).every(v => v == null)) continue;
    // Merge: replace fields with non-null values, keep existing for nulls
    const merged = { ...(m.odds || {}) };
    for (const [k, v] of Object.entries(newOdds)) {
      if (v != null) merged[k] = v;
    }
    updates.push({ matchId: m.id, label: `${m.homeTeam} vs ${m.awayTeam}`, oldOdds: m.odds || {}, newOdds: merged });
  }
  return { updates, unmatched, usage, totalEventsFromApi: events.length };
}

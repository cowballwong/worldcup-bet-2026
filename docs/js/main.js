// Player-facing app: auth, dashboard, betting, leaderboard, my bets.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, collection, query, where,
  orderBy, onSnapshot, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, APP_CONFIG } from "./firebase-config.js";
import { MARKETS, getMarketLabel, getSelectionLabel } from "./markets.js";
import { teamLabel, TEAM_ZH } from "./teams-zh.js";

// ── Firebase init ──────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── State ──────────────────────────────────────────────────────
let currentUser = null;
let currentUserDoc = null;
let matchesCache = new Map();   // id → match doc data
let adminEmails = [];
let unsubMatches = null;
let unsubLeaderboard = null;
let unsubMyBets = null;

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Auth flow ──────────────────────────────────────────────────
$('signin-btn')?.addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error(err);
    toast(`Sign-in failed: ${err.message}`);
  }
});

$('signout-btn')?.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    currentUserDoc = null;
    $('signin-view').classList.remove('hidden');
    $('app-view').classList.add('hidden');
    $('user-box').classList.add('hidden');
    return;
  }
  currentUser = user;
  $('signin-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('user-box').classList.remove('hidden');

  // Load admin list
  try {
    const adminSnap = await getDoc(doc(db, 'config', 'admin_emails'));
    adminEmails = adminSnap.exists() ? (adminSnap.data().emails || []) : [];
  } catch (e) { adminEmails = []; }
  if (adminEmails.includes(user.email)) {
    $('admin-link').classList.remove('hidden');
  }

  // Ensure user doc exists, create with starting balance if new
  const userRef = doc(db, 'users', user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) {
    await setDoc(userRef, {
      email: user.email,
      displayName: user.displayName || user.email.split('@')[0],
      photoURL: user.photoURL || '',
      balance: APP_CONFIG.startingBalance,
      joinedAt: serverTimestamp(),
    });
  }
  // Live-listen to own user doc → balance
  onSnapshot(userRef, snap => {
    currentUserDoc = snap.data();
    if (currentUserDoc) {
      $('user-balance').textContent = `${currentUserDoc.balance} pts`;
    }
  });

  // Start the data subscriptions
  subscribeMatches();
  subscribeLeaderboard();
  subscribeMyBets();
});

// ── Tabs ───────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('text-emerald-700', active);
      b.classList.toggle('border-emerald-700', active);
      b.classList.toggle('text-slate-500', !active);
      b.classList.toggle('border-transparent', !active);
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    $(`tab-${tab}`).classList.remove('hidden');
  });
});

// ── Matches: subscribe + render ────────────────────────────────
function subscribeMatches() {
  if (unsubMatches) unsubMatches();
  const q = query(collection(db, 'matches'), orderBy('kickoffISO', 'asc'));
  unsubMatches = onSnapshot(q, snap => {
    matchesCache.clear();
    const matches = [];
    snap.forEach(d => { const m = { id: d.id, ...d.data() }; matchesCache.set(d.id, m); matches.push(m); });
    renderMatches(matches);
  });
}

function renderMatches(matches) {
  // Player view only shows group-stage + scheduled knockout matches with kickoff
  // ahead. Knockout slot labels handled by formatTeam().
  const root = $('match-list');
  if (matches.length === 0) {
    root.innerHTML = '<p class="text-slate-500 text-sm">No matches yet. Admin: import the fixture list via the admin panel.</p>';
    $('match-count').textContent = '0';
    return;
  }
  $('match-count').textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;

  const html = matches.map(m => {
    const ko = new Date(m.kickoffISO);
    const isClosed = m.status === 'settled' || isPastKickoff(m);
    const cls = m.status === 'settled' ? 'match-card is-settled'
              : isClosed ? 'match-card is-closed'
              : 'match-card';
    const score = m.finalScore ? `<span class="font-bold">${m.finalScore.home} - ${m.finalScore.away}</span>` :
                   `<span class="text-slate-400 text-sm">vs</span>`;
    const stageLabel = stageDisplayLabel(m);
    return `
      <div class="${cls}" data-match-id="${m.id}">
        <div class="flex items-center justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 text-xs text-slate-500 mb-1 flex-wrap">
              <span class="status-badge ${m.status}">${m.status}</span>
              <span>${formatKickoff(ko)}</span>
              <span>· ${stageLabel}</span>
            </div>
            <div class="flex items-center gap-2 font-medium flex-wrap">
              <span>${m.homeFlag || ''} ${formatTeam(m.homeTeam, m.homeSlot)}</span>
              ${score}
              <span>${m.awayFlag || ''} ${formatTeam(m.awayTeam, m.awaySlot)}</span>
            </div>
            ${m.venue ? `<div class="text-xs text-slate-400 mt-1">${m.venue}</div>` : ''}
          </div>
          ${isClosed ? '' : `
          <div class="text-right text-xs text-slate-500">
            <div>${(m.odds?.home ?? '-')}</div>
            <div>${(m.odds?.draw ?? '-')}</div>
            <div>${(m.odds?.away ?? '-')}</div>
          </div>`}
        </div>
      </div>
    `;
  }).join('');
  root.innerHTML = html;

  root.querySelectorAll('.match-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.classList.contains('is-closed') || card.classList.contains('is-settled')) return;
      const m = matchesCache.get(card.dataset.matchId);
      if (m && (m.homeTeam === 'TBD' || m.awayTeam === 'TBD')) {
        toast('Teams TBD — bets open once admin sets the matchup.');
        return;
      }
      openBetModal(card.dataset.matchId);
    });
  });
}

// Bilingual team label, with fallback to slot placeholder for knockout TBDs.
function formatTeam(team, slot) {
  if (team && team !== 'TBD') return teamLabel(team);
  if (slot) return `<span class="text-slate-400 italic">${slot}</span>`;
  return '<span class="text-slate-400 italic">TBD 待定</span>';
}

function stageDisplayLabel(m) {
  switch (m.stage) {
    case 'group':     return m.group ? `Group ${m.group}` : 'Group';
    case 'r32':       return 'Round of 32 · 32 強';
    case 'r16':       return 'Round of 16 · 16 強';
    case 'qf':        return 'Quarter-final · 八強';
    case 'sf':        return 'Semi-final · 四強';
    case '3rd-place': return '3rd Place · 季軍戰';
    case 'final':     return '🏆 Final · 決賽';
    default:          return m.stage || '';
  }
}

function formatKickoff(d) {
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function isPastKickoff(m) {
  const cutoff = new Date(m.kickoffISO).getTime() - APP_CONFIG.betCutoffMinutes * 60 * 1000;
  return Date.now() >= cutoff;
}

// ── Bet modal ──────────────────────────────────────────────────
let activeMatch = null;
let activeMarket = '1x2';
let activeSelection = null;
let activeOdds = null;

function openBetModal(matchId) {
  activeMatch = matchesCache.get(matchId);
  if (!activeMatch) return;
  activeMarket = '1x2';
  activeSelection = null;
  activeOdds = null;

  $('bet-modal-title').innerHTML = `${activeMatch.homeFlag} ${teamLabel(activeMatch.homeTeam)} <span class="text-slate-400">vs</span> ${teamLabel(activeMatch.awayTeam)} ${activeMatch.awayFlag}`;
  $('bet-modal-subtitle').textContent = formatKickoff(new Date(activeMatch.kickoffISO)) + (activeMatch.venue ? ` · ${activeMatch.venue}` : '');

  // Populate market dropdown
  const marketSel = $('bet-market');
  marketSel.innerHTML = Object.keys(MARKETS)
    .map(code => `<option value="${code}">${MARKETS[code].label}</option>`).join('');
  marketSel.value = activeMarket;

  renderSelections();
  $('bet-stake').value = 10;
  updateSummary();
  $('bet-error').classList.add('hidden');
  $('bet-modal').classList.remove('hidden');
  $('bet-modal').classList.add('flex');
}

$('bet-modal-close').addEventListener('click', closeBetModal);
$('bet-modal').addEventListener('click', e => { if (e.target === $('bet-modal')) closeBetModal(); });
function closeBetModal() {
  $('bet-modal').classList.add('hidden');
  $('bet-modal').classList.remove('flex');
}

$('bet-market').addEventListener('change', e => {
  activeMarket = e.target.value;
  activeSelection = null;
  activeOdds = null;
  renderSelections();
  updateSummary();
});

function renderSelections() {
  const root = $('bet-selections');
  const market = MARKETS[activeMarket];
  if (!market) { root.innerHTML = ''; return; }
  const sels = market.selections(activeMatch);
  root.innerHTML = sels.map(s => `
    <div class="bet-selection-row" data-code="${s.code}" data-odds="${s.odds}">
      <span>${s.label}</span>
      <span class="odds-pill">${s.odds}</span>
    </div>
  `).join('');
  root.querySelectorAll('.bet-selection-row').forEach(row => {
    row.addEventListener('click', () => {
      root.querySelectorAll('.bet-selection-row').forEach(r => r.classList.remove('is-selected'));
      row.classList.add('is-selected');
      activeSelection = row.dataset.code;
      activeOdds = parseFloat(row.dataset.odds);
      updateSummary();
    });
  });
}

document.querySelectorAll('.stake-chip').forEach(b => {
  b.addEventListener('click', () => {
    $('bet-stake').value = b.dataset.stake;
    updateSummary();
  });
});
$('bet-stake').addEventListener('input', updateSummary);

function updateSummary() {
  const stake = parseInt($('bet-stake').value, 10) || 0;
  const odds = activeOdds || 0;
  $('bet-summary-stake').textContent = `${stake} pts`;
  $('bet-summary-odds').textContent = odds || '—';
  $('bet-summary-win').textContent = odds && stake ? `${Math.round(stake * odds)} pts` : '— pts';
}

$('bet-confirm').addEventListener('click', placeBet);

async function placeBet() {
  $('bet-error').classList.add('hidden');

  if (!activeSelection) return showBetErr('Pick a selection first.');
  const stake = parseInt($('bet-stake').value, 10);
  if (!Number.isFinite(stake)) return showBetErr('Stake must be a number.');
  if (stake < APP_CONFIG.minStake || stake > APP_CONFIG.maxStake) {
    return showBetErr(`Stake must be between ${APP_CONFIG.minStake} and ${APP_CONFIG.maxStake}.`);
  }
  if (isPastKickoff(activeMatch)) return showBetErr('Betting is closed for this match.');
  if (!currentUserDoc || currentUserDoc.balance < stake) {
    return showBetErr(`Not enough balance (you have ${currentUserDoc?.balance ?? 0}).`);
  }

  // Transaction: deduct stake AND write bet atomically.
  try {
    await runTransaction(db, async (tx) => {
      const userRef = doc(db, 'users', currentUser.uid);
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists()) throw new Error('User doc missing.');
      const newBal = uSnap.data().balance - stake;
      if (newBal < 0) throw new Error('Insufficient balance.');
      tx.update(userRef, { balance: newBal });

      const betRef = doc(collection(db, 'bets'));
      tx.set(betRef, {
        userId: currentUser.uid,
        userEmail: currentUser.email,
        userDisplayName: currentUserDoc.displayName,
        matchId: activeMatch.id,
        matchLabel: `${activeMatch.homeTeam} vs ${activeMatch.awayTeam}`,
        market: activeMarket,
        marketLabel: getMarketLabel(activeMarket),
        selection: activeSelection,
        selectionLabel: getSelectionLabel(activeMarket, activeSelection, activeMatch),
        stake,
        odds: activeOdds,
        status: 'open',
        placedAt: serverTimestamp(),
      });
    });
    closeBetModal();
    toast('Bet placed 🎟️');
  } catch (err) {
    console.error(err);
    showBetErr(err.message);
  }
}

function showBetErr(msg) {
  const e = $('bet-error');
  e.textContent = msg;
  e.classList.remove('hidden');
}

// ── Leaderboard ────────────────────────────────────────────────
function subscribeLeaderboard() {
  if (unsubLeaderboard) unsubLeaderboard();
  const q = query(collection(db, 'users'), orderBy('balance', 'desc'));
  unsubLeaderboard = onSnapshot(q, snap => {
    const rows = [];
    snap.forEach(d => rows.push({ uid: d.id, ...d.data() }));
    renderLeaderboard(rows);
  });
}

function renderLeaderboard(rows) {
  const root = $('leaderboard-list');
  if (rows.length === 0) {
    root.innerHTML = '<p class="text-slate-500 text-sm">No players yet.</p>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  root.innerHTML = rows.map((r, i) => {
    const isMe = currentUser && r.uid === currentUser.uid;
    return `
      <div class="leaderboard-row ${isMe ? 'is-me' : ''}">
        <span class="rank-medal">${medals[i] || (i+1)}</span>
        <span class="flex-1 truncate">${r.displayName} ${isMe ? '<span class="text-xs text-emerald-700">(you)</span>' : ''}</span>
        <span class="font-semibold">${r.balance} pts</span>
      </div>
    `;
  }).join('');
}

// ── My Bets ────────────────────────────────────────────────────
function subscribeMyBets() {
  if (unsubMyBets) unsubMyBets();
  // single where(), no orderBy — avoids needing a composite Firestore index.
  // Sort client-side by placedAt below.
  const q = query(collection(db, 'bets'),
    where('userId', '==', currentUser.uid));
  unsubMyBets = onSnapshot(q, snap => {
    const bets = [];
    snap.forEach(d => bets.push({ id: d.id, ...d.data() }));
    bets.sort((a, b) => {
      const ta = a.placedAt?.toMillis?.() ?? 0;
      const tb = b.placedAt?.toMillis?.() ?? 0;
      return tb - ta;
    });
    renderMyBets(bets);
  }, err => {
    console.error('subscribeMyBets error:', err);
    document.getElementById('mybets-list').innerHTML =
      `<p class="text-rose-600 text-sm">Failed to load bets: ${err.message}</p>`;
  });
}

function renderMyBets(bets) {
  const root = $('mybets-list');
  if (bets.length === 0) {
    root.innerHTML = '<p class="text-slate-500 text-sm">No bets yet. Pick a match to place your first.</p>';
    return;
  }
  root.innerHTML = bets.map(b => {
    const statusClass = b.status === 'won' ? 'is-won' : b.status === 'lost' ? 'is-lost' : '';
    const payout = b.status === 'won' ? `+${b.payout ?? Math.round(b.stake * b.odds)}` :
                   b.status === 'lost' ? `-${b.stake}` :
                   `${b.stake}`;
    const payoutCls = b.status === 'won' ? 'text-emerald-700' : b.status === 'lost' ? 'text-rose-600' : 'text-slate-500';
    // Try to render bilingual match label from live match data; fall back to the
    // English label stored at placement time for older bets.
    const m = matchesCache.get(b.matchId);
    const matchLabel = m
      ? `${teamLabel(m.homeTeam)} <span class="text-slate-400">vs</span> ${teamLabel(m.awayTeam)}`
      : b.matchLabel;
    return `
      <div class="bet-history-row ${statusClass}">
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium">${matchLabel}</div>
          <div class="text-xs text-slate-500">${b.marketLabel} → ${b.selectionLabel} @ ${b.odds}</div>
        </div>
        <div class="text-right">
          <div class="font-semibold ${payoutCls}">${payout} pts</div>
          <span class="status-badge ${b.status}">${b.status}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── Bracket tab ────────────────────────────────────────────────
// Re-renders whenever matchesCache changes (called from subscribeMatches).
function renderBracket() {
  const root = $('bracket-list');
  if (!root) return;
  const ms = Array.from(matchesCache.values());
  const stages = [
    { code: 'r32',       label: 'Round of 32 · 32 強' },
    { code: 'r16',       label: 'Round of 16 · 16 強' },
    { code: 'qf',        label: 'Quarter-finals · 八強' },
    { code: 'sf',        label: 'Semi-finals · 四強' },
    { code: '3rd-place', label: '3rd Place · 季軍戰' },
    { code: 'final',     label: '🏆 Final · 決賽' },
  ];
  const html = stages.map(s => {
    const stageMatches = ms.filter(m => m.stage === s.code)
      .sort((a, b) => a.kickoffISO.localeCompare(b.kickoffISO));
    if (stageMatches.length === 0) return '';
    const cards = stageMatches.map(m => {
      const ko = new Date(m.kickoffISO);
      const score = m.finalScore
        ? `<span class="font-bold">${m.finalScore.home} - ${m.finalScore.away}</span>`
        : `<span class="text-slate-400 text-xs">vs</span>`;
      return `
        <div class="bracket-card">
          <div class="text-xs text-slate-500 mb-1">${formatKickoff(ko)} · ${m.venue || ''}</div>
          <div class="flex items-center gap-2 text-sm">
            <span>${m.homeFlag || '🏳️'} ${formatTeam(m.homeTeam, m.homeSlot)}</span>
            ${score}
            <span>${m.awayFlag || '🏳️'} ${formatTeam(m.awayTeam, m.awaySlot)}</span>
          </div>
        </div>
      `;
    }).join('');
    return `
      <div class="bracket-stage">
        <h3 class="font-semibold mt-4 mb-2">${s.label}</h3>
        <div class="grid sm:grid-cols-2 gap-2">${cards}</div>
      </div>
    `;
  }).join('');
  root.innerHTML = html || '<p class="text-slate-500 text-sm">Knockout fixtures not loaded yet. Admin: import via the admin panel.</p>';
}

// ── Standings tab ──────────────────────────────────────────────
// Computes group standings from settled group matches in the cache.
function renderStandings() {
  const root = $('standings-list');
  if (!root) return;
  const ms = Array.from(matchesCache.values()).filter(m => m.stage === 'group');
  if (ms.length === 0) {
    root.innerHTML = '<p class="text-slate-500 text-sm">No group matches loaded.</p>';
    return;
  }

  // Discover groups + their teams
  const groups = {};
  for (const m of ms) {
    if (!m.group) continue;
    groups[m.group] = groups[m.group] || { matches: [], teams: new Map() };
    groups[m.group].matches.push(m);
    if (m.homeTeam && m.homeTeam !== 'TBD') groups[m.group].teams.set(m.homeTeam, { team: m.homeTeam, flag: m.homeFlag });
    if (m.awayTeam && m.awayTeam !== 'TBD') groups[m.group].teams.set(m.awayTeam, { team: m.awayTeam, flag: m.awayFlag });
  }

  const groupLetters = Object.keys(groups).sort();
  const html = groupLetters.map(letter => {
    const { matches, teams } = groups[letter];
    // Init each team's row
    const rows = new Map();
    for (const [name, info] of teams.entries()) {
      rows.set(name, { team: name, flag: info.flag, MP: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 });
    }
    // Tally settled matches
    for (const m of matches) {
      if (!m.finalScore || m.status !== 'settled') continue;
      const h = rows.get(m.homeTeam); const a = rows.get(m.awayTeam);
      if (!h || !a) continue;
      const hg = m.finalScore.home, ag = m.finalScore.away;
      h.MP++; a.MP++;
      h.GF += hg; h.GA += ag; a.GF += ag; a.GA += hg;
      if (hg > ag) { h.W++; h.Pts += 3; a.L++; }
      else if (hg < ag) { a.W++; a.Pts += 3; h.L++; }
      else { h.D++; a.D++; h.Pts++; a.Pts++; }
    }
    for (const r of rows.values()) r.GD = r.GF - r.GA;
    // Sort: Pts desc, GD desc, GF desc, alphabetical
    const sorted = [...rows.values()].sort((x, y) =>
      y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.team.localeCompare(y.team));

    const rowsHtml = sorted.map((r, i) => `
      <tr class="${i < 2 ? 'qualified-row' : ''}">
        <td class="px-2 py-1">${i + 1}</td>
        <td class="px-2 py-1 whitespace-nowrap">${r.flag || ''} ${teamLabel(r.team)}</td>
        <td class="px-2 py-1 text-center">${r.MP}</td>
        <td class="px-2 py-1 text-center">${r.W}</td>
        <td class="px-2 py-1 text-center">${r.D}</td>
        <td class="px-2 py-1 text-center">${r.L}</td>
        <td class="px-2 py-1 text-center">${r.GF}</td>
        <td class="px-2 py-1 text-center">${r.GA}</td>
        <td class="px-2 py-1 text-center">${r.GD > 0 ? '+' + r.GD : r.GD}</td>
        <td class="px-2 py-1 text-center font-semibold">${r.Pts}</td>
      </tr>
    `).join('');
    return `
      <div class="standings-group">
        <h3 class="font-semibold mt-4 mb-2">Group ${letter}</h3>
        <div class="overflow-x-auto">
        <table class="standings-table w-full text-sm">
          <thead class="text-xs text-slate-500">
            <tr>
              <th class="px-2 py-1 text-left">#</th>
              <th class="px-2 py-1 text-left">Team 隊伍</th>
              <th class="px-2 py-1">MP</th>
              <th class="px-2 py-1">W</th>
              <th class="px-2 py-1">D</th>
              <th class="px-2 py-1">L</th>
              <th class="px-2 py-1">GF</th>
              <th class="px-2 py-1">GA</th>
              <th class="px-2 py-1">GD</th>
              <th class="px-2 py-1">Pts</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        </div>
      </div>
    `;
  }).join('');
  root.innerHTML = html;
}

// Hook bracket + standings into the matches subscription so they
// re-render whenever matchesCache changes.
const _origRenderMatches = renderMatches;
renderMatches = function (matches) {
  _origRenderMatches(matches);
  renderBracket();
  renderStandings();
};

// ── Toast ──────────────────────────────────────────────────────
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

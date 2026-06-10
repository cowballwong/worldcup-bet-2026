// Player-facing app: auth, dashboard, betting, leaderboard, my bets.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, query, where,
  orderBy, onSnapshot, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, APP_CONFIG } from "./firebase-config.js";
import { MARKETS, getMarketLabel, getSelectionLabel } from "./markets.js";
import { teamLabel, TEAM_ZH } from "./teams-zh.js";
import { championOddsFor, championPayout, CHAMPION_BASE } from "./champion-odds.js";

// ── Firebase init ──────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── State ──────────────────────────────────────────────────────
let currentUser = null;
let currentUserDoc = null;
let matchesCache = new Map();   // id → match doc data
let myBetsByMatch = new Map();  // matchId → [my bets on that match]
let adminEmails = [];
let unsubMatches = null;
let unsubLeaderboard = null;
let unsubMyBets = null;
let unsubChampionConfig = null;
let unsubMyChampion = null;
let unsubChampionOdds = null;
let championConfig = null;   // { champion, championSettled }
let myChampion = null;       // { pick, pickZh, lockedOdds, potential, ... }
let championOdds = null;     // { base, odds:{team:number} } override from config (else defaults)

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Twemoji parser: replaces unicode emoji (esp. flags) with image tags so
// Windows browsers can render them. No-op if Twemoji didn't load.
function parseEmoji(rootEl) {
  if (window.twemoji && rootEl) {
    try { window.twemoji.parse(rootEl, { folder: 'svg', ext: '.svg' }); } catch (e) {}
  }
}
// Auto-parse every dynamic DOM addition (covers all the render*() functions
// without needing a parseEmoji() call inside each one).
function _installEmojiObserver() {
  if (!window.twemoji) { setTimeout(_installEmojiObserver, 200); return; }
  parseEmoji(document.body);
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) parseEmoji(n);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
_installEmojiObserver();

// ── Theme toggle ───────────────────────────────────────────────
const themeBtn = $('theme-btn');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('wc-theme', t);
  if (themeBtn) themeBtn.textContent = t === 'dark' ? '☀️' : '🌙';
}
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
  themeBtn.textContent = (document.documentElement.dataset.theme === 'dark') ? '☀️' : '🌙';
}

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
  subscribeAIBets();
  subscribeChampionConfig();
  subscribeMyChampion();
  subscribeChampionOdds();
});

// ── LillyRose AI bets subscription ─────────────────────────────
const LILLYROSE_UID = 'lillyrose-ai';
let unsubAIBets = null;

function subscribeAIBets() {
  if (unsubAIBets) unsubAIBets();
  const q = query(collection(db, 'bets'), where('userId', '==', LILLYROSE_UID));
  unsubAIBets = onSnapshot(q, snap => {
    const bets = [];
    snap.forEach(d => bets.push({ id: d.id, ...d.data() }));
    bets.sort((a, b) => {
      const ta = a.placedAt?.toMillis?.() ?? 0;
      const tb = b.placedAt?.toMillis?.() ?? 0;
      return tb - ta;
    });
    renderAIBets(bets);
  }, err => {
    console.error('subscribeAIBets err:', err);
    const el = document.getElementById('ai-bets-list');
    if (el) el.innerHTML = `<p class="text-rose-600 text-sm">Failed: ${err.message}</p>`;
  });
}

function renderAIBets(bets) {
  const root = document.getElementById('ai-bets-list');
  if (!root) return;
  if (bets.length === 0) {
    root.innerHTML = '<p class="text-slate-500 text-sm">LillyRose hasn\'t bet on anything yet. Admin: open the admin panel and press <b>Generate LillyRose picks</b> to seed her bets for upcoming matches.</p>';
    return;
  }
  root.innerHTML = bets.map(b => {
    const statusClass = b.status === 'won' ? 'is-won' : b.status === 'lost' ? 'is-lost' : '';
    const payout = b.status === 'won' ? `+${b.payout ?? Math.round(b.stake * b.odds)}` :
                   b.status === 'lost' ? `-${b.stake}` : `${b.stake}`;
    const payoutCls = b.status === 'won' ? 'text-emerald-700' : b.status === 'lost' ? 'text-rose-600' : 'text-slate-500';
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

// ── Tabs ───────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    try { localStorage.setItem('wc-tab', tab); } catch (e) {}  // remember across refresh
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

// Restore the last-viewed tab after a refresh (was always snapping back to home).
(function restoreTab() {
  let saved;
  try { saved = localStorage.getItem('wc-tab'); } catch (e) {}
  if (!saved) return;
  const btn = document.querySelector(`.tab-btn[data-tab="${saved}"]`);
  if (btn) btn.click();
})();

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

    // Score area: final > live > pre-match "vs"
    let scoreHtml;
    if (m.finalScore) {
      scoreHtml = `<div class="vs"><span>${m.finalScore.home} - ${m.finalScore.away}</span><span class="vs-time">FT</span></div>`;
    } else if (m.status === 'live' && m.liveScore) {
      scoreHtml = `<div class="vs live"><span>${m.liveScore.home} - ${m.liveScore.away}</span><span class="vs-time">● ${m.liveScore.minute || ''}'</span></div>`;
    } else {
      scoreHtml = `<div class="vs text-slate-400"><span>vs</span><span class="vs-time">${ko.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`;
    }

    const stageLabel = stageDisplayLabel(m);
    return `
      <div class="${cls}" data-match-id="${m.id}">
        <div class="flex items-center justify-between gap-2 text-xs text-slate-500 mb-2 flex-wrap">
          <span class="flex items-center gap-2">
            <span class="status-badge ${m.status}">${m.status}</span>
            <span>${formatKickoff(ko)}</span>
            <span>· ${stageLabel}</span>
          </span>
          ${isClosed ? '' : `<span class="text-right">odds: ${m.odds?.home ?? '-'} / ${m.odds?.draw ?? '-'} / ${m.odds?.away ?? '-'}</span>`}
        </div>
        <div class="match-row">
          <div class="team">
            <span class="flag">${m.homeFlag || '🏳️'}</span>
            ${formatTeam(m.homeTeam, m.homeSlot)}
          </div>
          ${scoreHtml}
          <div class="team">
            <span class="flag">${m.awayFlag || '🏳️'}</span>
            ${formatTeam(m.awayTeam, m.awaySlot)}
          </div>
        </div>
        ${(m.venue || m.broadcaster) ? `<div class="text-[11px] text-slate-400 mt-2 text-center">${m.venue || ''}${(m.venue && m.broadcaster) ? ' · ' : ''}${m.broadcaster ? `📺 ${m.broadcaster}` : ''}</div>` : ''}
        ${myBetRemark(m.id)}
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

// "You bet on this" remark for a match card — shows the user's own bets so the
// Matches list makes it obvious which games you've already backed.
function myBetRemark(matchId) {
  const bets = myBetsByMatch.get(matchId);
  if (!bets || bets.length === 0) return '';
  const chips = bets.map(b => {
    const cls = b.status === 'won' ? 'mbr-won' : b.status === 'lost' ? 'mbr-lost' : 'mbr-open';
    const res = b.status === 'won' ? `+${b.payout ?? Math.round(b.stake * b.odds)}`
              : b.status === 'lost' ? `-${b.stake}`
              : `${b.stake} pts`;
    return `<span class="mbr-chip ${cls}">${b.selectionLabel || b.marketLabel} @ ${b.odds} · ${res}</span>`;
  }).join('');
  return `<div class="my-bet-remark">🎟️ 你已落注:${chips}</div>`;
}

// Bilingual team label, with fallback to slot placeholder for knockout TBDs.
function formatTeam(team, slot) {
  if (team && team !== 'TBD') return teamLabel(team);
  if (slot) return `<span class="slot-placeholder">${slot}</span>`;
  return '<span class="team-bilingual"><span class="team-en text-slate-400 italic">TBD</span><span class="team-zh">待定</span></span>';
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
  // Competition (1224) ranking: tied players share the lowest rank, the
  // next non-tied player skips. So 1000 / 1000 / 950 / 900 → 1 / 1 / 3 / 4.
  let rank = 0;
  let prevBalance = null;
  const ranked = rows.map((r, i) => {
    if (r.balance !== prevBalance) rank = i + 1;
    prevBalance = r.balance;
    return { ...r, rank };
  });

  root.innerHTML = ranked.map(r => {
    const isMe = currentUser && r.uid === currentUser.uid;
    const medal = medals[r.rank - 1] || r.rank;
    return `
      <div class="leaderboard-row ${isMe ? 'is-me' : ''}">
        <span class="rank-medal">${medal}</span>
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
    // Index my bets by match so the Matches list can show a "已落注" remark.
    myBetsByMatch = new Map();
    for (const b of bets) {
      if (!b.matchId) continue;
      if (!myBetsByMatch.has(b.matchId)) myBetsByMatch.set(b.matchId, []);
      myBetsByMatch.get(b.matchId).push(b);
    }
    renderMyBets(bets);
    if (matchesCache.size) renderMatches(Array.from(matchesCache.values()));
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
    const m = matchesCache.get(b.matchId);
    const matchLabel = m
      ? `${teamLabel(m.homeTeam)} <span class="text-slate-400">vs</span> ${teamLabel(m.awayTeam)}`
      : b.matchLabel;
    // Edit/Delete only available for open bets on matches that haven't kicked off yet.
    const canModify = b.status === 'open' && m && !isPastKickoff(m);
    const actions = canModify ? `
      <div class="bet-actions">
        <button class="btn-edit"   data-bet-id="${b.id}" data-match-id="${b.matchId}" title="Modify bet">✏️</button>
        <button class="btn-delete" data-bet-id="${b.id}" data-stake="${b.stake}" title="Delete & refund">🗑️</button>
      </div>` : '';
    return `
      <div class="bet-history-row ${statusClass}">
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium">${matchLabel}</div>
          <div class="text-xs text-slate-500">${b.marketLabel} → ${b.selectionLabel} @ ${b.odds}</div>
        </div>
        <div class="text-right flex items-center gap-2">
          <div>
            <div class="font-semibold ${payoutCls}">${payout} pts</div>
            <span class="status-badge ${b.status}">${b.status}</span>
          </div>
          ${actions}
        </div>
      </div>
    `;
  }).join('');

  // Wire Edit/Delete buttons
  root.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const betId = btn.dataset.betId;
      const stake = parseInt(btn.dataset.stake, 10);
      if (!confirm(`Delete this bet and refund ${stake} pts?`)) return;
      try {
        await runTransaction(db, async (tx) => {
          const betRef = doc(db, 'bets', betId);
          const betSnap = await tx.get(betRef);
          if (!betSnap.exists()) throw new Error('Bet missing.');
          const bet = betSnap.data();
          if (bet.status !== 'open') throw new Error('Bet already settled.');
          const m = matchesCache.get(bet.matchId);
          if (m && isPastKickoff(m)) throw new Error('Match already kicked off.');
          const userRef = doc(db, 'users', currentUser.uid);
          const uSnap = await tx.get(userRef);
          if (!uSnap.exists()) throw new Error('User missing.');
          tx.update(userRef, { balance: uSnap.data().balance + bet.stake });
          tx.delete(betRef);
        });
        toast(`Bet refunded · 退回 ${stake} pts`);
      } catch (err) {
        console.error(err);
        toast(`Delete failed: ${err.message}`);
      }
    });
  });

  root.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const betId = btn.dataset.betId;
      const matchId = btn.dataset.matchId;
      // "Modify" = delete & refund the old bet, then open the bet modal for the same match
      // so the user picks fresh market / selection / stake.
      try {
        await runTransaction(db, async (tx) => {
          const betRef = doc(db, 'bets', betId);
          const betSnap = await tx.get(betRef);
          if (!betSnap.exists()) throw new Error('Bet missing.');
          const bet = betSnap.data();
          if (bet.status !== 'open') throw new Error('Bet already settled.');
          const m = matchesCache.get(bet.matchId);
          if (m && isPastKickoff(m)) throw new Error('Match already kicked off.');
          const userRef = doc(db, 'users', currentUser.uid);
          const uSnap = await tx.get(userRef);
          if (!uSnap.exists()) throw new Error('User missing.');
          tx.update(userRef, { balance: uSnap.data().balance + bet.stake });
          tx.delete(betRef);
        });
        // Switch to Matches tab + open the bet modal for re-bet
        document.querySelector('.tab-btn[data-tab="matches"]')?.click();
        setTimeout(() => openBetModal(matchId), 100);
        toast('Stake refunded — place your new bet');
      } catch (err) {
        console.error(err);
        toast(`Edit failed: ${err.message}`);
      }
    });
  });
}

// ── Bracket tab ────────────────────────────────────────────────
// Tree-style: 6 columns (R32 → R16 → QF → SF → 3rd → Final).
// Each column flex-grows; matches inside a column are evenly spaced so the
// later rounds visually line up with the centre of their feeder pair.
function renderBracket() {
  const root = $('bracket-list');
  if (!root) return;
  const ms = Array.from(matchesCache.values());
  const cols = [
    { code: 'r32',       label: 'Round of 32 / 32強', count: 16 },
    { code: 'r16',       label: 'Round of 16 / 16強', count: 8 },
    { code: 'qf',        label: 'Quarter / 八強',     count: 4 },
    { code: 'sf',        label: 'Semi / 四強',         count: 2 },
    { code: '3rd-place', label: '3rd / 季軍',          count: 1 },
    { code: 'final',     label: '🏆 Final / 決賽',     count: 1 },
  ];
  const colsHtml = cols.map(c => {
    const stageMatches = ms.filter(m => m.stage === c.code)
      .sort((a, b) => a.kickoffISO.localeCompare(b.kickoffISO));
    const items = (stageMatches.length ? stageMatches : Array.from({ length: c.count }, () => null))
      .map(m => bracketMatchHtml(m, c.code === 'final'))
      .join('');
    return `
      <div class="bracket-col">
        <div class="bracket-col-title">${c.label}</div>
        ${items}
      </div>
    `;
  }).join('');
  root.innerHTML = `<div class="bracket-grid">${colsHtml}</div>` ||
    '<p class="text-slate-500 text-sm">Knockout fixtures not loaded yet.</p>';
}

function bracketMatchHtml(m, isFinal) {
  if (!m) {
    return `<div class="bracket-match"><div class="bm-date">—</div><div class="bm-team"><span class="bm-name slot-placeholder">TBD</span></div><div class="bm-divider"></div><div class="bm-team"><span class="bm-name slot-placeholder">TBD</span></div></div>`;
  }
  const ko = new Date(m.kickoffISO);
  const dateLabel = ko.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const settledCls = m.status === 'settled' ? 'is-settled' : '';
  const finalCls = isFinal ? 'is-final' : '';
  const hs = m.finalScore ? m.finalScore.home : '';
  const as_ = m.finalScore ? m.finalScore.away : '';
  return `
    <div class="bracket-match ${settledCls} ${finalCls}">
      <div class="bm-date">${dateLabel}</div>
      <div class="bm-team">
        <span class="bm-name">${m.homeFlag || ''} ${shortTeamLabel(m.homeTeam, m.homeSlot)}</span>
        <span class="bm-score">${hs}</span>
      </div>
      <div class="bm-divider"></div>
      <div class="bm-team">
        <span class="bm-name">${m.awayFlag || ''} ${shortTeamLabel(m.awayTeam, m.awaySlot)}</span>
        <span class="bm-score">${as_}</span>
      </div>
    </div>
  `;
}

// Compact team label for bracket cards: English only, with slot fallback.
function shortTeamLabel(team, slot) {
  if (team && team !== 'TBD') return team;
  if (slot) return `<span class="slot-placeholder">${slot}</span>`;
  return '<span class="slot-placeholder">TBD</span>';
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
        <td class="px-1 py-1 text-center">${i + 1}</td>
        <td class="px-2 py-1 whitespace-nowrap">${r.flag || ''} ${teamLabel(r.team)}</td>
        <td class="px-1 py-1 text-center">${r.MP}</td>
        <td class="px-1 py-1 text-center">${r.W}</td>
        <td class="px-1 py-1 text-center">${r.D}</td>
        <td class="px-1 py-1 text-center">${r.L}</td>
        <td class="px-1 py-1 text-center">${r.GF}</td>
        <td class="px-1 py-1 text-center">${r.GA}</td>
        <td class="px-1 py-1 text-center">${r.GD > 0 ? '+' + r.GD : r.GD}</td>
        <td class="px-1 py-1 text-center font-semibold">${r.Pts}</td>
      </tr>
    `).join('');
    return `
      <div class="standings-group">
        <h3 class="font-semibold mt-4 mb-2">Group ${letter}</h3>
        <div class="overflow-x-auto">
        <table class="standings-table text-sm">
          <colgroup>
            <col class="col-rank">
            <col class="col-team">
            <col class="col-stat">
            <col class="col-stat">
            <col class="col-stat">
            <col class="col-stat">
            <col class="col-stat">
            <col class="col-stat">
            <col class="col-gd">
            <col class="col-pts">
          </colgroup>
          <thead class="text-xs text-slate-500">
            <tr>
              <th class="px-2 py-1 text-center">#</th>
              <th class="px-2 py-1 text-left">Team</th>
              <th class="px-1 py-1 text-center">MP</th>
              <th class="px-1 py-1 text-center">W</th>
              <th class="px-1 py-1 text-center">D</th>
              <th class="px-1 py-1 text-center">L</th>
              <th class="px-1 py-1 text-center">GF</th>
              <th class="px-1 py-1 text-center">GA</th>
              <th class="px-1 py-1 text-center">GD</th>
              <th class="px-1 py-1 text-center">Pts</th>
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
  renderChampion();
};

// ── Predict the champion ───────────────────────────────────────
// No stake. One pick per user (champions/{uid}); correct pick = +500 pts,
// credited by the admin settlement path. Cutoff = first match kick-off,
// enforced client-side (same trust model as bet kickoff cutoff).
function subscribeChampionConfig() {
  if (unsubChampionConfig) unsubChampionConfig();
  unsubChampionConfig = onSnapshot(doc(db, 'config', 'tournament'), snap => {
    championConfig = snap.exists() ? snap.data() : null;
    renderChampion();
  }, () => { championConfig = null; renderChampion(); });
}

function subscribeMyChampion() {
  if (unsubMyChampion) unsubMyChampion();
  if (!currentUser) return;
  unsubMyChampion = onSnapshot(doc(db, 'champions', currentUser.uid), snap => {
    myChampion = snap.exists() ? snap.data() : null;
    renderChampion();
  }, () => { myChampion = null; renderChampion(); });
}

function subscribeChampionOdds() {
  if (unsubChampionOdds) unsubChampionOdds();
  unsubChampionOdds = onSnapshot(doc(db, 'config', 'champion_odds'), snap => {
    championOdds = snap.exists() ? snap.data() : null;
    renderChampion();
  }, () => { championOdds = null; renderChampion(); });
}

// Odds override map + base from config (falls back to bundled defaults).
function oddsMap() { return (championOdds && championOdds.odds) || null; }
function oddsBase() { return (championOdds && Number.isFinite(championOdds.base)) ? championOdds.base : CHAMPION_BASE; }

// Earliest kick-off across all loaded matches = the pick deadline.
function championCutoffMs() {
  let earliest = Infinity;
  for (const m of matchesCache.values()) {
    const t = new Date(m.kickoffISO).getTime();
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  return earliest;
}

// Team → flag map, derived from the loaded fixtures.
function teamFlagMap() {
  const map = {};
  for (const m of matchesCache.values()) {
    if (m.homeTeam && m.homeTeam !== 'TBD' && m.homeFlag) map[m.homeTeam] = m.homeFlag;
    if (m.awayTeam && m.awayTeam !== 'TBD' && m.awayFlag) map[m.awayTeam] = m.awayFlag;
  }
  return map;
}

function renderChampion() {
  const grid = $('champion-grid');
  const statusEl = $('champion-status');
  if (!grid || !statusEl) return;

  const flags = teamFlagMap();
  // Team universe: all non-TBD teams in fixtures; fall back to the ZH dictionary.
  let teams = Object.keys(flags);
  if (teams.length < 24) teams = Object.keys(TEAM_ZH).filter(t => t !== 'TBD');
  teams = [...new Set(teams)].sort();

  const settled = championConfig && championConfig.championSettled;
  const champion = championConfig && championConfig.champion;
  const cutoff = championCutoffMs();
  const locked = settled || (Number.isFinite(cutoff) && Date.now() >= cutoff);
  const myPick = myChampion && myChampion.pick;

  // Locked potential from the user's own pick (stored at pick time), with a
  // graceful fallback to a freshly-computed value for older picks.
  const myPotential = (myChampion && Number.isFinite(myChampion.potential))
    ? myChampion.potential
    : (myPick ? championPayout(myPick, oddsMap(), oddsBase()) : 0);

  // ── Status banner ──
  if (settled && champion) {
    const flag = flags[champion] || '🏆';
    if (myPick && myPick === champion) {
      statusEl.innerHTML = `<div class="champ-banner win">🏆 冠軍係 <b>${flag} ${teamPlainSafe(champion)}</b> — 你估中喇!<b>+${myPotential} 分</b> 🎉</div>`;
    } else if (myPick) {
      statusEl.innerHTML = `<div class="champ-banner lose">🏆 冠軍係 <b>${flag} ${teamPlainSafe(champion)}</b>。你揀咗 ${teamPlainSafe(myPick)},今次估唔中 — 下屆再嚟!</div>`;
    } else {
      statusEl.innerHTML = `<div class="champ-banner">🏆 冠軍係 <b>${flag} ${teamPlainSafe(champion)}</b>。你今屆冇估冠軍。</div>`;
    }
  } else if (myPick) {
    const flag = flags[myPick] || '🏳️';
    const odds = championOddsFor(myPick, oddsMap());
    const lockNote = locked ? ' · 已鎖定' : ' · 開賽前可改';
    statusEl.innerHTML = `<div class="champ-banner pick">你嘅冠軍預測:<b>${flag} ${teamPlainSafe(myPick)}</b> @ ${odds} → 估中 <b>+${myPotential} 分</b>${lockNote}</div>`;
  } else if (locked) {
    statusEl.innerHTML = `<div class="champ-banner">預測已截止(賽事已開始),你今屆冇揀冠軍。</div>`;
  } else {
    statusEl.innerHTML = `<div class="champ-banner">仲未揀 — 喺下面揀一隊做你嘅冠軍預測。</div>`;
  }

  // ── Team grid ──
  if (settled) {
    // Show only the champion + my pick context; hide the full picker.
    grid.innerHTML = '';
    grid.classList.add('hidden');
    return;
  }
  grid.classList.remove('hidden');
  // Favourites first (shortest odds), so the risk/reward gradient is obvious.
  const om = oddsMap(), base = oddsBase();
  teams.sort((a, b) => championOddsFor(a, om) - championOddsFor(b, om) || a.localeCompare(b));
  grid.innerHTML = teams.map(t => {
    const flag = flags[t] || '🏳️';
    const zh = TEAM_ZH[t] || '';
    const sel = (t === myPick) ? 'is-picked' : '';
    const dis = locked ? 'is-locked' : '';
    const odds = championOddsFor(t, om);
    const pay = championPayout(t, om, base);
    return `
      <button class="champ-team ${sel} ${dis}" data-team="${escAttr(t)}" ${locked ? 'disabled' : ''}>
        <span class="champ-flag">${flag}</span>
        <span class="champ-name"><span class="champ-en">${escHtml(t)}</span>${zh ? `<span class="champ-zh">${escHtml(zh)}</span>` : ''}</span>
        <span class="champ-odds"><span class="champ-o">@${odds}</span><span class="champ-pay">+${pay}</span></span>
        ${t === myPick ? '<span class="champ-check">✓</span>' : ''}
      </button>`;
  }).join('');

  if (!locked) {
    grid.querySelectorAll('.champ-team').forEach(btn => {
      btn.addEventListener('click', () => pickChampion(btn.dataset.team));
    });
  }
}

async function pickChampion(team) {
  if (!currentUser) return;
  if (championConfig && championConfig.championSettled) return toast('預測已截止。');
  const cutoff = championCutoffMs();
  if (Number.isFinite(cutoff) && Date.now() >= cutoff) return toast('預測已截止(賽事已開始)。');
  if (myChampion && myChampion.pick === team) return; // no-op re-pick
  const lockedOdds = championOddsFor(team, oddsMap());
  const potential = championPayout(team, oddsMap(), oddsBase());
  try {
    await setDoc(doc(db, 'champions', currentUser.uid), {
      userId: currentUser.uid,
      displayName: currentUserDoc?.displayName || (currentUser.email || '').split('@')[0],
      pick: team,
      pickZh: TEAM_ZH[team] || '',
      lockedOdds,
      potential,
      createdAt: serverTimestamp(),
    });
    toast(`已揀 ${teamPlainSafe(team)} @ ${lockedOdds} · 估中 +${potential} 分 👑`);
  } catch (err) {
    console.error(err);
    toast(`揀冠軍失敗: ${err.message}`);
  }
}

function teamPlainSafe(en) {
  const zh = TEAM_ZH[en];
  return zh ? `${en} ${zh}` : en;
}
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

// ── Toast ──────────────────────────────────────────────────────
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

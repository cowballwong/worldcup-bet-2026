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
    return `
      <div class="${cls}" data-match-id="${m.id}">
        <div class="flex items-center justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <span class="status-badge ${m.status}">${m.status}</span>
              <span>${formatKickoff(ko)}</span>
              ${m.group ? `<span>· Group ${m.group}</span>` : ''}
            </div>
            <div class="flex items-center gap-2 font-medium">
              <span>${m.homeFlag || ''} ${m.homeTeam}</span>
              ${score}
              <span>${m.awayFlag || ''} ${m.awayTeam}</span>
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
      openBetModal(card.dataset.matchId);
    });
  });
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

  $('bet-modal-title').textContent = `${activeMatch.homeFlag} ${activeMatch.homeTeam} vs ${activeMatch.awayTeam} ${activeMatch.awayFlag}`;
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
  const q = query(collection(db, 'bets'),
    where('userId', '==', currentUser.uid),
    orderBy('placedAt', 'desc'));
  unsubMyBets = onSnapshot(q, snap => {
    const bets = [];
    snap.forEach(d => bets.push({ id: d.id, ...d.data() }));
    renderMyBets(bets);
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
    return `
      <div class="bet-history-row ${statusClass}">
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium">${b.matchLabel}</div>
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

// ── Toast ──────────────────────────────────────────────────────
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

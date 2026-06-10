// Admin panel: fixture CRUD, settle bets, view users.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where,
  getDocs, orderBy, onSnapshot, writeBatch, serverTimestamp, increment, addDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, ODDS_API_KEY } from "./firebase-config.js";
import { settleBetsForMatch, MARKETS } from "./markets.js";
import { TEAM_ZH } from "./teams-zh.js";
import { fetchAndPair } from "./odds-refresh.js";

const LILLYROSE_UID = 'lillyrose-ai';
const LILLYROSE_NAME = 'LillyRose 🤖';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = id => document.getElementById(id);

// Twemoji auto-parse for emoji rendering on Windows
function _installEmojiObserver() {
  if (!window.twemoji) { setTimeout(_installEmojiObserver, 200); return; }
  try { window.twemoji.parse(document.body, { folder: 'svg', ext: '.svg' }); } catch (e) {}
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          try { window.twemoji.parse(n, { folder: 'svg', ext: '.svg' }); } catch (e) {}
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
_installEmojiObserver();

let currentUser = null;
let unsubAdminMatches = null;

// ── Auth + admin gate ──────────────────────────────────────────
$('signin-btn')?.addEventListener('click', async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { toast(`Sign-in failed: ${e.message}`); }
});
$('signout-btn')?.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUser = null;
    $('signin-gate').classList.remove('hidden');
    $('admin-view').classList.add('hidden');
    $('not-admin').classList.add('hidden');
    return;
  }
  currentUser = user;
  const adminSnap = await getDoc(doc(db, 'config', 'admin_emails'));
  const emails = adminSnap.exists() ? (adminSnap.data().emails || []) : [];
  if (!emails.includes(user.email)) {
    $('signin-gate').classList.add('hidden');
    $('admin-view').classList.add('hidden');
    $('not-admin').classList.remove('hidden');
    return;
  }
  $('signin-gate').classList.add('hidden');
  $('not-admin').classList.add('hidden');
  $('admin-view').classList.remove('hidden');
  subscribeAdminMatches();
  loadUsers();
  initChampionAdmin();
});

// ── Tabs ───────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('text-rose-700', active);
      b.classList.toggle('border-rose-700', active);
      b.classList.toggle('text-slate-500', !active);
      b.classList.toggle('border-transparent', !active);
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    $(`tab-${tab}`).classList.remove('hidden');
  });
});

// ── Match list ─────────────────────────────────────────────────
function subscribeAdminMatches() {
  if (unsubAdminMatches) unsubAdminMatches();
  const q = query(collection(db, 'matches'), orderBy('kickoffISO', 'asc'));
  unsubAdminMatches = onSnapshot(q, snap => {
    const ms = [];
    snap.forEach(d => ms.push({ id: d.id, ...d.data() }));
    renderAdminMatches(ms);
  });
}

function renderAdminMatches(matches) {
  const root = $('admin-match-list');
  if (matches.length === 0) {
    root.innerHTML = '<p class="text-slate-500 text-sm">No matches yet. Click <b>+ Add match</b> or use the Import tab.</p>';
    return;
  }
  root.innerHTML = matches.map(m => {
    const score = m.finalScore ? `${m.finalScore.home}-${m.finalScore.away}` : '—';
    const ko = new Date(m.kickoffISO).toLocaleString();
    return `
      <div class="match-card" data-match-id="${m.id}">
        <div class="flex items-center justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="text-xs text-slate-500 mb-1 flex items-center gap-2">
              <span class="status-badge ${m.status || 'scheduled'}">${m.status || 'scheduled'}</span>
              <code class="text-slate-400">${m.id}</code> · ${ko}
              ${m.group ? `· Group ${m.group}` : ''}
            </div>
            <div class="font-medium">${m.homeFlag || ''} ${m.homeTeam} <span class="text-slate-500">${score}</span> ${m.awayTeam} ${m.awayFlag || ''}</div>
          </div>
          <button class="text-xs bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded">Edit</button>
        </div>
      </div>
    `;
  }).join('');
  root.querySelectorAll('.match-card').forEach(card => {
    card.addEventListener('click', () => openMatchModal(card.dataset.matchId, matches.find(m => m.id === card.dataset.matchId)));
  });
}

// ── Add / edit match modal ─────────────────────────────────────
$('add-match-btn').addEventListener('click', () => openMatchModal(null, null));
$('match-modal-close').addEventListener('click', closeMatchModal);
$('match-modal').addEventListener('click', e => { if (e.target === $('match-modal')) closeMatchModal(); });

function openMatchModal(matchId, m) {
  $('match-modal-title').textContent = matchId ? `Edit ${matchId}` : 'Add match';
  $('m-id').value = matchId || `WC26-${Date.now().toString(36).slice(-5)}`;
  $('m-group').value = m?.group || '';
  $('m-stage').value = m?.stage || 'group';
  $('m-home-team').value = m?.homeTeam || '';
  $('m-home-flag').value = m?.homeFlag || '';
  $('m-away-team').value = m?.awayTeam || '';
  $('m-away-flag').value = m?.awayFlag || '';
  $('m-kickoff').value = m?.kickoffISO || '';
  $('m-venue').value = m?.venue || '';
  $('m-broadcaster').value = m?.broadcaster || '';
  $('m-odds-home').value = m?.odds?.home ?? '';
  $('m-odds-draw').value = m?.odds?.draw ?? '';
  $('m-odds-away').value = m?.odds?.away ?? '';
  $('m-odds-over').value = m?.odds?.over25 ?? '';
  $('m-odds-under').value = m?.odds?.under25 ?? '';
  $('m-odds-btts-yes').value = m?.odds?.btts_yes ?? '';
  $('m-odds-btts-no').value = m?.odds?.btts_no ?? '';
  $('m-status').value = m?.status || 'scheduled';
  $('m-live-home').value = m?.liveScore?.home ?? '';
  $('m-live-away').value = m?.liveScore?.away ?? '';
  $('m-live-minute').value = m?.liveScore?.minute ?? '';
  $('m-ht-home').value = m?.halftimeScore?.home ?? '';
  $('m-ht-away').value = m?.halftimeScore?.away ?? '';
  $('m-ft-home').value = m?.finalScore?.home ?? '';
  $('m-ft-away').value = m?.finalScore?.away ?? '';
  $('match-status').textContent = '';
  $('match-status').className = 'text-sm';
  $('match-modal').classList.remove('hidden');
  $('match-modal').classList.add('flex');
}

function closeMatchModal() {
  $('match-modal').classList.add('hidden');
  $('match-modal').classList.remove('flex');
}

function readMatchForm() {
  const ftH = parseIntOrNull($('m-ft-home').value);
  const ftA = parseIntOrNull($('m-ft-away').value);
  const htH = parseIntOrNull($('m-ht-home').value);
  const htA = parseIntOrNull($('m-ht-away').value);
  return {
    id: $('m-id').value.trim(),
    group: $('m-group').value.trim(),
    stage: $('m-stage').value.trim() || 'group',
    homeTeam: $('m-home-team').value.trim(),
    homeFlag: $('m-home-flag').value.trim(),
    awayTeam: $('m-away-team').value.trim(),
    awayFlag: $('m-away-flag').value.trim(),
    kickoffISO: $('m-kickoff').value.trim(),
    venue: $('m-venue').value.trim(),
    broadcaster: $('m-broadcaster').value.trim(),
    odds: {
      home: parseFloatOrNull($('m-odds-home').value),
      draw: parseFloatOrNull($('m-odds-draw').value),
      away: parseFloatOrNull($('m-odds-away').value),
      over25: parseFloatOrNull($('m-odds-over').value),
      under25: parseFloatOrNull($('m-odds-under').value),
      btts_yes: parseFloatOrNull($('m-odds-btts-yes').value),
      btts_no: parseFloatOrNull($('m-odds-btts-no').value),
    },
    finalScore: (ftH != null && ftA != null) ? { home: ftH, away: ftA } : null,
    halftimeScore: (htH != null && htA != null) ? { home: htH, away: htA } : null,
    status: $('m-status').value || 'scheduled',
    liveScore: (() => {
      const lh = parseIntOrNull($('m-live-home').value);
      const la = parseIntOrNull($('m-live-away').value);
      const lm = parseIntOrNull($('m-live-minute').value);
      if (lh == null || la == null) return null;
      return { home: lh, away: la, minute: lm };
    })(),
  };
}

function parseIntOrNull(v) { v = String(v).trim(); if (v === '') return null; const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function parseFloatOrNull(v) { v = String(v).trim(); if (v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

$('match-save').addEventListener('click', async () => {
  await saveMatch(false);
});

$('match-settle').addEventListener('click', async () => {
  const ok = await saveMatch(true);
  if (ok) await settleMatch(ok);
});

$('match-delete').addEventListener('click', async () => {
  if (!confirm('Delete this match? Existing bets stay but become unsettleable.')) return;
  const id = $('m-id').value.trim();
  await deleteDoc(doc(db, 'matches', id));
  closeMatchModal();
  toast('Match deleted');
});

async function saveMatch(forSettle) {
  const m = readMatchForm();
  if (!m.id || !m.homeTeam || !m.awayTeam || !m.kickoffISO) {
    setStatus('Missing required fields (id, both teams, kickoff)', true);
    return null;
  }
  if (forSettle && (!m.finalScore || !m.halftimeScore)) {
    setStatus('To settle, both halftime and final scores must be entered.', true);
    return null;
  }
  // If a final score is entered we force-settle status (regardless of dropdown);
  // otherwise honour the explicit status from the form.
  const status = m.finalScore ? 'settled' : (m.status || 'scheduled');
  const payload = { ...m, status, updatedAt: serverTimestamp() };
  await setDoc(doc(db, 'matches', m.id), payload, { merge: true });
  setStatus('Saved.', false);
  if (!forSettle) {
    setTimeout(closeMatchModal, 600);
  }
  return { ...payload, id: m.id };
}

async function settleMatch(match) {
  setStatus('Settling bets…', false);
  // Read all bets on this match; filter to open client-side
  // (avoids a composite index for matchId + status).
  const betsSnap = await getDocs(query(collection(db, 'bets'),
    where('matchId', '==', match.id)));
  const openBets = [];
  betsSnap.forEach(d => {
    const data = d.data();
    if (data.status === 'open') openBets.push({ docId: d.id, ...data });
  });

  if (openBets.length === 0) {
    setStatus('Saved. No open bets to settle.', false);
    setTimeout(closeMatchModal, 800);
    return;
  }

  // Evaluate
  const updates = settleBetsForMatch(match, openBets);

  // Atomic batch: write bet status + credit winnings to each user
  const batch = writeBatch(db);
  // Group payouts per user
  const credits = new Map();
  for (const u of updates) {
    const ref = doc(db, 'bets', u.docId);
    batch.update(ref, {
      status: u.status, payout: u.payout || 0,
      settledAt: serverTimestamp(),
    });
    if (u.payout && u.payout > 0) {
      credits.set(u.userId, (credits.get(u.userId) || 0) + u.payout);
    }
  }
  for (const [uid, cr] of credits.entries()) {
    batch.update(doc(db, 'users', uid), { balance: increment(cr) });
  }
  await batch.commit();
  setStatus(`Settled ${updates.length} bets. ${credits.size} winners credited.`, false);
  setTimeout(closeMatchModal, 1200);
}

function setStatus(msg, isErr) {
  $('match-status').textContent = msg;
  $('match-status').className = `text-sm ${isErr ? 'text-rose-600' : 'text-emerald-700'}`;
}

// ── Users tab ──────────────────────────────────────────────────
async function loadUsers() {
  const q = query(collection(db, 'users'), orderBy('balance', 'desc'));
  onSnapshot(q, snap => {
    const rows = [];
    snap.forEach(d => rows.push({ uid: d.id, ...d.data() }));
    const root = $('user-list');
    if (rows.length === 0) {
      root.innerHTML = '<p class="text-slate-500 text-sm">No players yet.</p>';
      return;
    }
    root.innerHTML = rows.map(r => `
      <div class="leaderboard-row">
        <span class="flex-1 truncate">${r.displayName} <span class="text-xs text-slate-400">${r.email}</span></span>
        <span class="font-semibold">${r.balance} pts</span>
      </div>
    `).join('');
  });
}

// ── Bulk import ────────────────────────────────────────────────
$('bulk-import-btn').addEventListener('click', async () => {
  const raw = $('bulk-import-json').value.trim();
  if (!raw) return;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { $('bulk-import-status').textContent = `Invalid JSON: ${e.message}`; $('bulk-import-status').className = 'text-sm text-rose-600'; return; }
  const matches = Array.isArray(parsed) ? parsed
                : Array.isArray(parsed.matches) ? parsed.matches
                : null;
  if (!matches) { $('bulk-import-status').textContent = 'Expected an array or { matches: [...] }.'; $('bulk-import-status').className = 'text-sm text-rose-600'; return; }
  $('bulk-import-status').textContent = `Importing ${matches.length} matches…`;
  const batch = writeBatch(db);
  for (const m of matches) {
    if (!m.id) continue;
    batch.set(doc(db, 'matches', m.id), {
      ...m,
      status: m.status || 'scheduled',
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
  $('bulk-import-status').textContent = `Imported ${matches.length} matches.`;
  $('bulk-import-status').className = 'text-sm text-emerald-700';
});

// Auto-fill the import textarea with the local fixtures.json
fetch('data/fixtures.json').then(r => r.json()).then(j => {
  $('bulk-import-json').value = JSON.stringify(j, null, 2);
}).catch(() => {});

// ── LillyRose AI player ────────────────────────────────────────
$('lr-create')?.addEventListener('click', async () => {
  setLR('Creating LillyRose user…');
  try {
    await setDoc(doc(db, 'users', LILLYROSE_UID), {
      email: 'lillyrose@ai.local',
      displayName: LILLYROSE_NAME,
      photoURL: '',
      balance: 1000,
      isAI: true,
      joinedAt: serverTimestamp(),
    }, { merge: true });
    setLR('LillyRose user created. Balance: 1000 pts.', false);
  } catch (e) {
    console.error(e);
    setLR(`Failed: ${e.message}`, true);
  }
});

$('lr-generate')?.addEventListener('click', async () => {
  const hours = parseInt($('lr-window-hours').value, 10) || 12;
  setLR(`Looking up matches in next ${hours}h…`);
  try {
    const now = Date.now();
    const horizon = now + hours * 3600_000;

    // Load all matches + LillyRose's existing bets
    const [matchesSnap, lrBetsSnap] = await Promise.all([
      getDocs(collection(db, 'matches')),
      getDocs(query(collection(db, 'bets'), where('userId', '==', LILLYROSE_UID))),
    ]);
    const matches = [];
    matchesSnap.forEach(d => matches.push({ id: d.id, ...d.data() }));
    const lrBetMatchIds = new Set();
    lrBetsSnap.forEach(d => lrBetMatchIds.add(d.data().matchId));

    // Eligible: kickoff within window, not yet kicked off, not TBD, no existing LR bet
    const targets = matches.filter(m => {
      const ko = new Date(m.kickoffISO).getTime();
      return ko > now && ko < horizon
          && m.homeTeam && m.homeTeam !== 'TBD'
          && m.awayTeam && m.awayTeam !== 'TBD'
          && !lrBetMatchIds.has(m.id);
    }).sort((a, b) => a.kickoffISO.localeCompare(b.kickoffISO));

    if (targets.length === 0) {
      setLR('No eligible upcoming matches in window. Nothing to do.', false);
      return;
    }

    // Place a bet on the 1X2 favourite for each
    const batch = writeBatch(db);
    const userRef = doc(db, 'users', LILLYROSE_UID);
    const uSnap = await getDoc(userRef);
    if (!uSnap.exists()) {
      setLR('LillyRose user doc not found — click "Create LillyRose user" first.', true);
      return;
    }
    let totalStake = 0;
    const lines = [];
    for (const m of targets) {
      const o = m.odds || {};
      const candidates = [
        { code: 'home', odds: o.home, team: m.homeTeam },
        { code: 'draw', odds: o.draw, team: 'Draw' },
        { code: 'away', odds: o.away, team: m.awayTeam },
      ].filter(c => Number.isFinite(c.odds));
      if (candidates.length === 0) continue;
      // Favourite = lowest odds
      candidates.sort((a, b) => a.odds - b.odds);
      const pick = candidates[0];
      // Stake 25–100, biased lower for risky long-shots
      const stake = 25 + Math.floor(Math.random() * 76);
      totalStake += stake;
      const betRef = doc(collection(db, 'bets'));
      const homeZh = TEAM_ZH[m.homeTeam] || '';
      const awayZh = TEAM_ZH[m.awayTeam] || '';
      batch.set(betRef, {
        userId: LILLYROSE_UID,
        userEmail: 'lillyrose@ai.local',
        userDisplayName: LILLYROSE_NAME,
        matchId: m.id,
        matchLabel: `${m.homeTeam} ${homeZh ? '(' + homeZh + ')' : ''} vs ${m.awayTeam} ${awayZh ? '(' + awayZh + ')' : ''}`,
        market: '1x2',
        marketLabel: 'Match result · 1X2',
        selection: pick.code,
        selectionLabel: pick.code === 'draw' ? 'Draw' : `${pick.team} win`,
        stake,
        odds: pick.odds,
        status: 'open',
        placedAt: serverTimestamp(),
        isAI: true,
      });
      lines.push(`${m.homeTeam} vs ${m.awayTeam} — pick ${pick.code} (${pick.team}) @ ${pick.odds}, stake ${stake}`);
    }
    // Decrement LillyRose's balance by total stake
    batch.update(userRef, { balance: increment(-totalStake) });
    await batch.commit();

    setLR(`✅ Generated ${targets.length} bet${targets.length === 1 ? '' : 's'}, total stake ${totalStake} pts.`, false);
    $('lr-bets-summary').innerHTML = lines.map(l => `<div class="text-slate-600">• ${l}</div>`).join('');
  } catch (e) {
    console.error(e);
    setLR(`Failed: ${e.message}`, true);
  }
});

function setLR(msg, isErr) {
  $('lr-status').textContent = msg;
  $('lr-status').className = `text-sm ${isErr ? 'text-rose-600' : 'text-emerald-700'}`;
}

// ── Predict-the-champion settlement ────────────────────────────
function initChampionAdmin() {
  // Populate the team datalist from the ZH dictionary.
  const dl = $('champ-team-list');
  if (dl && !dl.dataset.filled) {
    dl.innerHTML = Object.keys(TEAM_ZH).filter(t => t !== 'TBD').sort()
      .map(t => `<option value="${t}">${t} ${TEAM_ZH[t] || ''}</option>`).join('');
    dl.dataset.filled = '1';
  }

  // Live breakdown of everyone's picks + current settled state.
  onSnapshot(collection(db, 'champions'), snap => {
    const picks = [];
    snap.forEach(d => picks.push(d.data()));
    const counts = {};
    for (const p of picks) counts[p.pick] = (counts[p.pick] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const root = $('champ-breakdown');
    if (!root) return;
    if (picks.length === 0) { root.innerHTML = '<span class="text-slate-500">No champion picks yet.</span>'; return; }
    root.innerHTML = `<div class="mb-2 text-slate-500">${picks.length} pick${picks.length === 1 ? '' : 's'} total</div>` +
      sorted.map(([t, n]) => `<div class="flex justify-between border-b py-1"><span>${t} ${TEAM_ZH[t] || ''}</span><span class="font-semibold">${n}</span></div>`).join('');
  }, err => {
    const root = $('champ-breakdown');
    if (root) root.innerHTML = `<span class="text-rose-600">Failed: ${err.message}</span>`;
  });

  // Reflect current config champion in the input.
  getDoc(doc(db, 'config', 'tournament')).then(s => {
    if (s.exists() && s.data().champion && $('champ-team-input')) {
      $('champ-team-input').value = s.data().champion;
      if (s.data().championSettled) setChamp(`Currently SETTLED on ${s.data().champion}. Re-running is safe.`, false);
    }
  }).catch(() => {});
}

$('champ-settle')?.addEventListener('click', async () => {
  const champ = ($('champ-team-input').value || '').trim();
  if (!champ) return setChamp('Enter the champion team first.', true);
  if (!TEAM_ZH[champ]) {
    if (!confirm(`"${champ}" isn't in the team dictionary. Settle anyway?`)) return;
  }
  if (!confirm(`Settle champion = "${champ}" and award +500 to everyone who picked it?`)) return;
  setChamp('Settling…', false);
  try {
    // Mark config first so the player UI flips to "settled".
    await setDoc(doc(db, 'config', 'tournament'),
      { champion: champ, championSettled: true, picksOpen: false, settledAt: serverTimestamp() },
      { merge: true });

    const snap = await getDocs(collection(db, 'champions'));
    const batch = writeBatch(db);
    let winners = 0, awardedAlready = 0;
    snap.forEach(d => {
      const c = d.data();
      if (c.awarded) { awardedAlready++; return; }          // idempotent skip
      const won = c.pick === champ;
      batch.update(doc(db, 'champions', d.id), { awarded: true, won });
      if (won) {
        winners++;
        batch.update(doc(db, 'users', c.userId), { balance: increment(500) });
      }
    });
    await batch.commit();
    setChamp(`✅ Settled on ${champ}. ${winners} winner(s) credited +500. ${awardedAlready ? awardedAlready + ' already-awarded skipped.' : ''}`, false);
  } catch (e) {
    console.error(e);
    setChamp(`Failed: ${e.message}`, true);
  }
});

$('champ-reopen')?.addEventListener('click', async () => {
  if (!confirm('Re-open champion picks? This clears the settled flag (does NOT claw back points already awarded).')) return;
  try {
    await setDoc(doc(db, 'config', 'tournament'),
      { championSettled: false, picksOpen: true }, { merge: true });
    setChamp('Picks re-opened. (Awarded points kept.)', false);
  } catch (e) { setChamp(`Failed: ${e.message}`, true); }
});

function setChamp(msg, isErr) {
  const el = $('champ-status');
  if (el) { el.textContent = msg; el.className = `text-sm ${isErr ? 'text-rose-600' : 'text-emerald-700'}`; }
}

// ── Refresh odds (The Odds API) ────────────────────────────────
let pendingOddsUpdates = null;

$('odds-preview')?.addEventListener('click', async () => {
  setOddsStatus('Fetching odds…');
  pendingOddsUpdates = null;
  $('odds-apply').classList.add('hidden');
  try {
    if (!ODDS_API_KEY) {
      setOddsStatus('Missing ODDS_API_KEY. See firebase-config.js.', true);
      return;
    }
    // Pull all matches as the candidate set
    const snap = await getDocs(collection(db, 'matches'));
    const fixtures = [];
    snap.forEach(d => fixtures.push({ id: d.id, ...d.data() }));
    const { updates, unmatched, usage, totalEventsFromApi } =
      await fetchAndPair(ODDS_API_KEY, fixtures);
    pendingOddsUpdates = updates;
    const head = `API returned ${totalEventsFromApi} events · matched ${updates.length} · unmatched ${unmatched.length}`;
    const tail = `(API requests remaining: ${usage.remaining ?? '?'})`;
    setOddsStatus(`${head} ${tail}`, false);
    const root = $('odds-preview-list');
    const lines = updates.slice(0, 200).map(u => {
      const o = u.oldOdds || {};
      const n = u.newOdds;
      const diff = (k) => {
        const a = o[k], b = n[k];
        if (b == null) return '<span class="text-slate-400">—</span>';
        if (a == null) return `<span class="text-emerald-700">${b}</span>`;
        if (Math.abs((a - b) / a) < 0.01) return `<span class="text-slate-400">${b}</span>`;
        return `<span class="${b < a ? 'text-rose-600' : 'text-emerald-700'}">${a} → ${b}</span>`;
      };
      return `<div class="flex justify-between gap-3 border-b py-1">
        <span class="truncate flex-1">${u.label}</span>
        <span>H ${diff('home')} · D ${diff('draw')} · A ${diff('away')} · O2.5 ${diff('over25')} · U2.5 ${diff('under25')}</span>
      </div>`;
    });
    if (unmatched.length) {
      lines.push(`<div class="mt-3 text-slate-500">Unmatched (no fixture found): ${unmatched.map(x => x.home + ' vs ' + x.away).join(' · ')}</div>`);
    }
    root.innerHTML = lines.join('') || '<div class="text-slate-500">No updates available.</div>';
    if (updates.length > 0) $('odds-apply').classList.remove('hidden');
  } catch (e) {
    console.error(e);
    setOddsStatus(`Failed: ${e.message}`, true);
  }
});

$('odds-apply')?.addEventListener('click', async () => {
  if (!pendingOddsUpdates || pendingOddsUpdates.length === 0) return;
  setOddsStatus('Applying…');
  try {
    const batch = writeBatch(db);
    for (const u of pendingOddsUpdates) {
      batch.update(doc(db, 'matches', u.matchId), {
        odds: u.newOdds,
        oddsUpdatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
    setOddsStatus(`Applied to ${pendingOddsUpdates.length} matches.`, false);
    pendingOddsUpdates = null;
    $('odds-apply').classList.add('hidden');
  } catch (e) {
    console.error(e);
    setOddsStatus(`Apply failed: ${e.message}`, true);
  }
});

function setOddsStatus(msg, isErr) {
  $('odds-status').textContent = msg;
  $('odds-status').className = `text-sm self-center ${isErr ? 'text-rose-600' : 'text-emerald-700'}`;
}

// ── Theme toggle ───────────────────────────────────────────────
(() => {
  const t = localStorage.getItem('wc-theme');
  if (t) document.documentElement.dataset.theme = t;
})();

// ── Toast ──────────────────────────────────────────────────────
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

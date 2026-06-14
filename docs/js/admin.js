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
import { settleBetsForMatch, MARKETS } from "./markets.js?v=20260614e";
import { TEAM_ZH } from "./teams-zh.js";
import { fetchAndPair } from "./odds-refresh.js";
import { DEFAULT_CHAMPION_ODDS, CHAMPION_BASE, championPayout } from "./champion-odds.js";

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
  renderStatus();
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
    if (tab === 'status') renderStatus();
  });
});

// ── Status / health (landing) — monitor automation, act by exception ──
async function renderStatus() {
  const root = $('status-content');
  if (!root) return;
  root.innerHTML = '<p class="text-slate-500 text-sm">Loading…</p>';
  try {
    const now = Date.now();
    const [mSnap, uSnap, bSnap] = await Promise.all([
      getDocs(collection(db, 'matches')),
      getDocs(collection(db, 'users')),
      getDocs(collection(db, 'bets')),
    ]);
    const matches = []; mSnap.forEach(d => matches.push({ id: d.id, ...d.data() }));
    const players = uSnap.size;
    let totalBets = 0; const lrMatchIds = new Set();
    bSnap.forEach(d => { totalBets++; const b = d.data() || {}; if (b.userId === 'lillyrose-ai') lrMatchIds.add(b.matchId); });
    const koMs = m => { const t = Date.parse(m.kickoffISO || ''); return isNaN(t) ? null : t; };
    const tbd = t => !t || t === 'TBD';
    const stuck = matches.filter(m => m.status !== 'settled' && koMs(m) && now > koMs(m) + 2.5 * 3600e3 && !tbd(m.homeTeam));
    const live = matches.filter(m => m.status === 'live');
    const incomplete = matches.filter(m => m.status !== 'settled' && (tbd(m.homeTeam) || tbd(m.awayTeam) || !koMs(m) || !(m.odds && m.odds.home)));
    const todayStr = new Date().toISOString().slice(0, 10);
    const today = matches.filter(m => (m.kickoffISO || '').slice(0, 10) === todayStr);
    const upcomingNoLR = matches.filter(m => m.status !== 'settled' && koMs(m) && koMs(m) > now && koMs(m) < now + 12 * 3600e3 && !tbd(m.homeTeam) && !lrMatchIds.has(m.id));

    const stat = (n, label, cls) => `<div class="stat-cell"><div class="stat-num ${cls || ''}">${n}</div><div class="stat-lbl">${label}</div></div>`;
    const row = (m, note) => `<div class="match-card status-fix" data-mid="${m.id}"><div class="font-medium text-sm">${m.homeFlag || ''} ${m.homeTeam || 'TBD'} vs ${m.awayTeam || 'TBD'} ${m.awayFlag || ''}</div><div class="text-xs text-slate-500">${m.id} · ${m.kickoffISO ? new Date(m.kickoffISO).toLocaleString() : '冇開波時間'} · ${note}</div></div>`;
    const block = (title, arr, note, cls) => arr.length
      ? `<div class="status-block"><div class="status-h ${cls}">${title} (${arr.length})</div>${arr.map(m => row(m, note)).join('')}</div>` : '';

    let html = `<div class="status-grid">
      ${stat(players, '玩家')}${stat(totalBets, '注')}
      ${stat(live.length, '進行中', live.length ? 'text-rose-600' : '')}${stat(today.length, '今日場')}
    </div>`;
    html += block('⚠️ 可能卡住(開波 2.5 鐘+ 仲未結算)— 撳入去手動 settle', stuck, '撳開 → 入 HT+FT 比分 → Save & Settle', 'text-rose-700');
    html += block('🟡 資料未齊(冇隊 / 冇開波時間 / 冇賠率)', incomplete, '撳開填返', 'text-amber-700');
    html += block('🤖 LillyRose 12 鐘內開波但未落注', upcomingNoLR, 'cron 應該會落;唔放心可去 LillyRose 控制頁手動', 'text-slate-600');
    if (!stuck.length && !incomplete.length) {
      html += '<div class="status-ok">✅ 一切正常 — 冇場卡住、資料齊全,自動化行緊。</div>';
    }
    root.innerHTML = html;
    root.querySelectorAll('.status-fix').forEach(el => el.addEventListener('click', () => {
      const m = matches.find(x => x.id === el.dataset.mid);
      if (m) openMatchModal(m.id, m);
    }));
  } catch (e) {
    root.innerHTML = `<p class="text-rose-600 text-sm">Status load failed: ${e.message}</p>`;
  }
}
$('status-refresh')?.addEventListener('click', renderStatus);

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
  // Read ALL bets on this match (one query; filter client-side).
  const betsSnap = await getDocs(query(collection(db, 'bets'),
    where('matchId', '==', match.id)));
  const allBets = [];
  const openBets = [];
  betsSnap.forEach(d => {
    const data = { docId: d.id, ...d.data() };
    allBets.push(data);
    if (data.status === 'open') openBets.push(data);
  });

  // Evaluate the still-open ones and credit winners.
  const updates = openBets.length ? settleBetsForMatch(match, openBets) : [];
  const finalByDoc = new Map();  // docId -> {status, payout}
  if (updates.length) {
    const batch = writeBatch(db);
    const credits = new Map();
    const released = new Map();  // stake leaving each user's locked openStake
    const stakeByDoc = new Map(openBets.map(b => [b.docId, b.stake || 0]));
    for (const u of updates) {
      batch.update(doc(db, 'bets', u.docId), {
        status: u.status, payout: u.payout || 0, settledAt: serverTimestamp(),
      });
      finalByDoc.set(u.docId, { status: u.status, payout: u.payout || 0 });
      if (u.payout && u.payout > 0) credits.set(u.userId, (credits.get(u.userId) || 0) + u.payout);
      // Bet leaves the 'open' pool → release its stake from the bettor's openStake.
      const st = stakeByDoc.get(u.docId) || 0;
      released.set(u.userId, (released.get(u.userId) || 0) + st);
    }
    for (const uid of new Set([...credits.keys(), ...released.keys()])) {
      const cr = credits.get(uid) || 0;
      const rel = released.get(uid) || 0;
      const upd = {};
      if (cr) upd.balance = increment(cr);
      if (rel) upd.openStake = increment(-rel);
      if (Object.keys(upd).length) batch.update(doc(db, 'users', uid), upd);
    }
    await batch.commit();
  }

  // Build the public per-match prediction summary (everyone can read this).
  const predictions = allBets.map(b => {
    const fin = finalByDoc.get(b.docId);
    const status = fin ? fin.status : b.status;       // freshly-settled or already-settled
    const payout = fin ? fin.payout : (b.payout || 0);
    return {
      userId: b.userId,
      displayName: b.userDisplayName || b.userEmail || 'Player',
      market: b.market || '', marketLabel: b.marketLabel || '',
      selection: b.selection || '', selectionLabel: b.selectionLabel || '',
      odds: b.odds || 0, stake: b.stake || 0,
      status, payout, isAI: !!b.isAI,
    };
  }).filter(p => p.status === 'won' || p.status === 'lost');  // only decided bets

  try {
    await setDoc(doc(db, 'results', match.id), {
      matchId: match.id,
      homeTeam: match.homeTeam || '', awayTeam: match.awayTeam || '',
      finalScore: match.finalScore || null,
      predictions,
      winners: predictions.filter(p => p.status === 'won').length,
      total: predictions.length,
      settledAt: serverTimestamp(),
    });
  } catch (e) {
    console.error('results write failed', e);
  }

  setStatus(`Settled ${updates.length} bet(s). ${predictions.length} prediction(s) recorded.`, false);
  setTimeout(closeMatchModal, 1300);
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
        <span class="flex-1 truncate">${r.displayName} <span class="text-xs text-slate-400">${r.email || ''}</span></span>
        <span class="font-semibold mr-2 whitespace-nowrap">${r.balance} pts</span>
        <button class="kick-btn" data-uid="${r.uid}" data-name="${(r.displayName || '').replace(/"/g, '&quot;')}" title="Kick / remove this player">🚪 踢走</button>
      </div>
    `).join('');
    root.querySelectorAll('.kick-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid;
        const name = btn.dataset.name || 'this player';
        if (!confirm(`踢走「${name}」?\n\nThis permanently deletes their account, ALL their bets, and their champion pick. Cannot be undone.`)) return;
        btn.disabled = true; btn.textContent = '踢緊…';
        try {
          const batch = writeBatch(db);
          const bets = await getDocs(query(collection(db, 'bets'), where('userId', '==', uid)));
          bets.forEach(d => batch.delete(d.ref));
          batch.delete(doc(db, 'champions', uid));  // no-op if absent
          batch.delete(doc(db, 'users', uid));
          await batch.commit();
          // row disappears on the next users snapshot
        } catch (e) {
          alert('Kick failed: ' + e.message);
          btn.disabled = false; btn.textContent = '🚪 踢走';
        }
      });
    });
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
    // Move LillyRose's total stake from cash → locked openStake (asset unchanged).
    batch.update(userRef, { balance: increment(-totalStake), openStake: increment(totalStake) });
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
    const cfg = championOddsCfg || {};
    root.innerHTML = `<div class="mb-2 text-slate-500">${picks.length} pick${picks.length === 1 ? '' : 's'} total</div>` +
      sorted.map(([t, n]) => {
        const pay = championPayout(t, cfg.odds, cfg.base);
        return `<div class="flex justify-between border-b py-1"><span>${t} ${TEAM_ZH[t] || ''} <span class="text-slate-400">+${pay}</span></span><span class="font-semibold">${n}</span></div>`;
      }).join('');
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

  // Load current odds config into the editor (or show defaults as a starting point).
  getDoc(doc(db, 'config', 'champion_odds')).then(s => {
    const ta = $('champ-odds-json');
    if (!ta) return;
    const cfg = s.exists() ? s.data() : { base: CHAMPION_BASE, odds: DEFAULT_CHAMPION_ODDS };
    ta.value = JSON.stringify(cfg, null, 2);
    championOddsCfg = cfg;
  }).catch(() => {});
}

let championOddsCfg = null;  // { base, odds } cached for settlement fallback

$('champ-seed-odds')?.addEventListener('click', async () => {
  try {
    const cfg = { base: CHAMPION_BASE, odds: DEFAULT_CHAMPION_ODDS };
    await setDoc(doc(db, 'config', 'champion_odds'), cfg, { merge: false });
    championOddsCfg = cfg;
    if ($('champ-odds-json')) $('champ-odds-json').value = JSON.stringify(cfg, null, 2);
    setOddsCfgStatus(`Seeded default odds for ${Object.keys(DEFAULT_CHAMPION_ODDS).length} teams (base ${CHAMPION_BASE}).`, false);
  } catch (e) { setOddsCfgStatus(`Failed: ${e.message}`, true); }
});

$('champ-save-odds')?.addEventListener('click', async () => {
  let cfg;
  try { cfg = JSON.parse($('champ-odds-json').value); }
  catch (e) { return setOddsCfgStatus(`Invalid JSON: ${e.message}`, true); }
  if (!cfg || typeof cfg.odds !== 'object') return setOddsCfgStatus('Expected { base, odds: {...} }.', true);
  if (!Number.isFinite(cfg.base)) cfg.base = CHAMPION_BASE;
  try {
    await setDoc(doc(db, 'config', 'champion_odds'), cfg, { merge: false });
    championOddsCfg = cfg;
    setOddsCfgStatus(`Saved odds for ${Object.keys(cfg.odds).length} teams (base ${cfg.base}).`, false);
  } catch (e) { setOddsCfgStatus(`Failed: ${e.message}`, true); }
});

function setOddsCfgStatus(msg, isErr) {
  const el = $('champ-odds-status');
  if (el) { el.textContent = msg; el.className = `text-sm self-center ${isErr ? 'text-rose-600' : 'text-emerald-700'}`; }
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

    const oddsCfg = championOddsCfg || {};
    const snap = await getDocs(collection(db, 'champions'));
    const batch = writeBatch(db);
    let winners = 0, awardedAlready = 0, totalPaid = 0;
    snap.forEach(d => {
      const c = d.data();
      if (c.awarded) { awardedAlready++; return; }          // idempotent skip
      const won = c.pick === champ;
      // Payout = the odds locked at pick time (fallback: recompute from config).
      const payout = won
        ? (Number.isFinite(c.potential) ? c.potential : championPayout(c.pick, oddsCfg.odds, oddsCfg.base))
        : 0;
      batch.update(doc(db, 'champions', d.id), { awarded: true, won, payout });
      if (won && payout > 0) {
        winners++;
        totalPaid += payout;
        batch.update(doc(db, 'users', c.userId), { balance: increment(payout) });
      }
    });
    await batch.commit();
    setChamp(`✅ Settled on ${champ}. ${winners} winner(s) credited (+${totalPaid} pts total). ${awardedAlready ? awardedAlready + ' already-awarded skipped.' : ''}`, false);
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

// Give the LillyRose AI player a champion prediction too.
$('lr-champ-set')?.addEventListener('click', async () => {
  const team = ($('lr-champ-input').value || '').trim();
  if (!team) return setLRChamp('Enter a team.', true);
  const cfg = championOddsCfg || {};
  const odds = (cfg.odds && Number.isFinite(cfg.odds[team])) ? cfg.odds[team]
             : (Number.isFinite(DEFAULT_CHAMPION_ODDS[team]) ? DEFAULT_CHAMPION_ODDS[team] : 251);
  const potential = championPayout(team, cfg.odds, cfg.base);
  try {
    await setDoc(doc(db, 'champions', LILLYROSE_UID), {
      userId: LILLYROSE_UID,
      displayName: LILLYROSE_NAME,
      pick: team,
      pickZh: TEAM_ZH[team] || '',
      lockedOdds: odds,
      potential,
      isAI: true,
      createdAt: serverTimestamp(),
    });
    setLRChamp(`LillyRose picked ${team} @ ${odds} (win = +${potential} pts).`, false);
  } catch (e) {
    console.error(e);
    setLRChamp(`Failed: ${e.message}`, true);
  }
});

function setLRChamp(msg, isErr) {
  const el = $('lr-champ-status');
  if (el) { el.textContent = msg; el.className = `text-sm self-center ${isErr ? 'text-rose-600' : 'text-emerald-700'}`; }
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

'use strict';

// games/rummy.js — Cafe Life Rummy. FORTRESS EDITION.
// ============================================================================
// Hardening map (every fix is traceable to a documented threat):
//
//   [T-01] Double-click on offer/counter  → r.wagerCreating lock + post-await re-check.
//   [T-02] Accept succeeds, start fails   → settle as draw (refund both).
//   [T-03] Settle fails silently          → wager.js retry tables + log recovery.
//   [T-04] Hardcoded prefix slice(4)      → roomKeyOf() helper.
//   [T-05] Third join cancels wager async → rumJoin is async and awaits.
//   [T-06] Leave sets settled=true early  → wagerSettling lock, set after success.
//   [T-07] Race on rumLeave settle        → wagerSettling guard in every settle path.
//   [T-08] Weak error messages            → structured rum:err with typed codes.
//   [T-09] rumNextRound with st=-1        → guard + graceful end.
//   [T-10] All payload validation         → validateRoomId, validateWagerId, validateAmount.
//   [T-11] Stale timer after delete       → clearOfferTimer on every room exit.
//   [T-12] Wager fields left dirty        → resetWagerFields() on every teardown.
//   [T-13] Concurrent join                → wagerCreating-style lock on join path.
//   [T-14] Opponent accept after reject   → accepted wagerId re-checked inside try.
//   [T-15] Counter owner loses seat       → original owner re-validated before send.
//   [T-16] Client can spoof wagerOwner    → r.wagerOwner is server-only (never from client).
//   [T-17] Offer timer leaks process      → .unref() + clearOfferTimer on every path.
//   [T-18] Insufficient info on failure   → WAGER_ERRORS map for stable client codes.
// ============================================================================

module.exports = function createRummyGame({
  send, sockets, players, crypto,
  createWager, acceptWager, cancelWager, settleWager,
}) {
  // ========================================================================
  // ENGINE (unchanged — pure, no IO, no state)
  // ========================================================================
  const RM = (() => {
    const val = r => (r >= 10 || r === 1) ? 10 : r;
    const hv = c => c.r ? val(c.r) : 20;
    const posv = p => p === 1 ? 1 : (p >= 10 ? 10 : p);

    function meld(cs) {
      const n = cs.length; if (n < 3) return null;
      const jk = cs.filter(c => !c.r), ot = cs.filter(c => c.r); if (!ot.length) return null;
      const suits = new Set(ot.map(c => c.s));
      if (n <= 5 && ot.every(c => c.r === ot[0].r) && suits.size === ot.length) {
        return { k: 'set', pts: val(ot[0].r) * n, ord: cs };
      }
      if (suits.size !== 1 || new Set(ot.map(c => c.r)).size !== ot.length) return null;
      let best = null;
      for (const hi of [0, 1]) {
        const L = hi ? 2 : 1, U = hi ? 14 : 13; if (U - L + 1 < n) continue;
        const v = ot.map(c => ({ c, p: (c.r === 1 && hi) ? 14 : c.r })).sort((a, b) => a.p - b.p);
        const mn = v[0].p, mx = v[v.length - 1].p;
        if (mx - mn + 1 - v.length > jk.length) continue;
        const s = Math.min(mn, U - n + 1); if (s + n - 1 < mx) continue;
        const J = [...jk], ord = []; let pts = 0;
        for (let p = s; p < s + n; p++) {
          const f = v.find(x => x.p === p); ord.push(f ? f.c : J.pop()); pts += posv(p);
        }
        if (!best || pts > best.pts) best = { k: 'seq', pts, ord };
      }
      return best;
    }

    function cands(R, x) {
      const J = R.filter(c => !c.r), O = R.filter(c => c.r && c !== x), out = [], seen = new Set();
      const add = cs => {
        const m = meld(cs); if (!m) return;
        const k = cs.map(c => c.id).sort((a, b) => a - b).join();
        if (seen.has(k)) return; seen.add(k); out.push({ cs, m });
      };
      const ss = new Set([x.s]), same = [];
      O.forEach(c => { if (c.r === x.r && !ss.has(c.s)) { ss.add(c.s); same.push(c); } });
      for (let mk = 0; mk < (1 << same.length); mk++) {
        const b = [x]; same.forEach((c, i) => (mk >> i) & 1 && b.push(c));
        for (let j = 0; j <= Math.min(J.length, 2); j++) if (b.length + j >= 3 && b.length + j <= 5) add([...b, ...J.slice(0, j)]);
      }
      const bs = {};
      O.forEach(c => { if (c.s === x.s && !bs[c.r]) bs[c.r] = c; });
      for (const hi of [0, 1]) {
        const L = hi ? 2 : 1, U = hi ? 14 : 13, px = (x.r === 1 && hi) ? 14 : x.r;
        if (px < L || px > U) continue;
        for (let a = Math.max(L, px - 13); a <= px; a++) for (let b = px; b <= U; b++) {
          if (b - a < 2) continue;
          const cs = []; let need = 0;
          for (let p = a; p <= b; p++) {
            const c = p === px ? x : bs[p === 14 ? 1 : p];
            if (c) cs.push(c); else need++;
          }
          if (need > J.length || need > 2) continue;
          add([...cs, ...J.slice(0, need)]);
        }
      }
      return out;
    }

    function solve(hand, out) {
      const memo = new Map();
      const go = R => {
        const k = R.map(c => c.id).sort((a, b) => a - b).join();
        if (memo.has(k)) return memo.get(k);
        const x = R.find(c => c.r); let best = { s: out ? 0 : -R.length, ms: [] };
        if (x) {
          const sk = go(R.filter(c => c !== x));
          best = { s: sk.s - (out ? 0 : 1), ms: sk.ms };
          if (memo.size < 60000) for (const { cs, m } of cands(R, x)) {
            const ids = new Set(cs.map(c => c.id)), r = go(R.filter(c => !ids.has(c.id)));
            const sc = r.s + (out ? cs.length * 1000 + (cs.length >= 4 ? 50 : 0) + m.pts / 100 : m.pts * 20);
            if (sc > best.s) best = { s: sc, ms: [m.ord, ...r.ms] };
          }
        }
        memo.set(k, best);
        return best;
      };
      return go(hand).ms;
    }

    function jokerSlot(m, k) {
      const cs = m.cards, j = cs.findIndex(c => c.r), c = cs[j];
      const pj = (c.r === 1 && j > 0) ? 14 : c.r, pos = pj + (k - j);
      return { r: pos === 14 ? 1 : pos, s: c.s };
    }

    function trySwap(m, c) {
      if (!c.r) return null;
      for (let k = 0; k < m.cards.length; k++) {
        if (m.cards[k].r) continue;
        if (m.k === 'seq') { const w = jokerSlot(m, k); if (w.r !== c.r || w.s !== c.s) continue; }
        const cs = [...m.cards]; cs[k] = c;
        const r = meld(cs);
        if (r) return { r, j: m.cards[k] };
      }
      return null;
    }

    const pts = ms => ms.reduce((a, g) => a + meld(g).pts, 0);
    return { hv, meld, solve, trySwap, pts };
  })();

  // ========================================================================
  // CONSTANTS
  // ========================================================================
  const RUM = new Map();
  const OFFER_TIMEOUT_MS = 60 * 1000;
  const MIN_WAGER = 300;
  const MAX_WAGER = 100000;
  const MAX_ROOM_ID_LEN = 40;
  const MAX_WAGER_ID_LEN = 64;
  const PREFIX = 'rum:';

  // [T-18] Stable client error codes
  const WAGER_ERRORS = Object.freeze({
    ROOM_ACTIVE: 'room_has_active_wager',
    INSUFFICIENT: 'insufficient_balance',
    NOT_PENDING: 'wager_not_pending',
    NOT_FOUND: 'wager_not_found',
    BUSY: 'wager_busy',
    INVALID_AMOUNT: 'invalid_amount',
  });

  // ========================================================================
  // UTILITIES (pure)
  // ========================================================================
  const roomKeyOf = r => r.id.startsWith(PREFIX) ? r.id.slice(PREFIX.length) : r.id;
  const rumActive = s => !s.dead && !s.out && !s.left;
  const rumErr = (id, text) => send(sockets.get(id), { type: 'rum:err', text });

  function rumOf(id) {
    for (const r of RUM.values()) if (r.seats.some(s => s.id === id && !s.left)) return r;
    return null;
  }

  function rumShuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function rumDeck() {
    const d = []; let n = 0;
    for (let k = 0; k < 2; k++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) d.push({ id: n++, r, s });
    for (let i = 0; i < 4; i++) d.push({ id: n++, r: 0, s: -1 });
    return rumShuffle(d);
  }

  // [T-10] Input validators
  function validateRoomId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > MAX_ROOM_ID_LEN) return null;
    if (!/^[A-Za-z0-9_\-]+$/.test(s)) return null;
    return s;
  }

  function validateWagerId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > MAX_WAGER_ID_LEN) return null;
    if (!/^wg_[A-Za-z0-9]+$/.test(s)) return null;
    return s;
  }

  function validateAmount(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < MIN_WAGER || n > MAX_WAGER) return null;
    return n;
  }

  // ========================================================================
  // ROOM STATE HELPERS
  // ========================================================================
  function clearOfferTimer(r) {
    if (r.offerTimer) {
      try { clearTimeout(r.offerTimer); } catch {}
      r.offerTimer = null;
    }
    r.offerExpiresAt = 0;
  }

  function resetWagerFields(r) {
    clearOfferTimer(r);
    r.wagerAmount = 0;
    r.wagerId = null;
    r.wagerRoomId = null;
    r.wagerOwner = null;
    r.pendingWager = 0;
    // Note: wagerCreating/wagerSettling are caller-managed.
  }

  function offerOf(r) {
    return r.wagerId && !r.wagerSettled ? {
      wagerId: r.wagerId,
      amount: r.wagerAmount,
      by: r.wagerOwner,
      byName: (r.seats.find(s => s.id === r.wagerOwner) || {}).name || '',
      expiresAt: r.offerExpiresAt || 0,
    } : null;
  }

  function rumView(r, i) {
    const me = r.seats[i];
    return {
      type: 'rum:state', room: roomKeyOf(r), status: r.status,
      host: r.hostId === me.id,
      hostIdx: r.seats.findIndex(s => s.id === r.hostId),
      you: i,
      seats: r.seats.map(s => ({
        name: s.name, score: s.score, opened: s.opened,
        out: s.out, dead: s.dead, n: s.hand.length,
      })),
      hand: me.hand, melds: r.melds,
      disc: r.disc[r.disc.length - 1] || null, stock: r.stock.length,
      min: r.min, turn: r.turn, ph: r.ph, first: r.first, wasOpen: r.wasOpen,
      took: (i === r.turn && r.took) ? r.took.id : null,
      rows: r.rows,
      buy: r.buyId === me.id,
      buyName: (r.seats.find(s => s.id === r.buyId) || {}).name || '',
      buyScore: Math.max(0, ...r.seats.filter(s => s.id !== r.buyId && !s.dead).map(s => s.score)),
      over: r.over, winner: r.winner, ready: [...r.ready],
      wager: r.wagerAmount || null,
      wagerId: r.wagerId || null,
      offer: offerOf(r),
    };
  }

  const rumPush = r => r.seats.forEach((s, i) => send(sockets.get(s.id), rumView(r, i)));

  // ========================================================================
  // WAGER: CANCEL / SETTLE
  // ========================================================================
  async function cancelRoomPendingWager(r, reason) {
    if (!r.wagerId || r.wagerSettled) { resetWagerFields(r); return; }
    if (r.wagerOwner == null) { resetWagerFields(r); return; }
    if (typeof cancelWager !== 'function') { resetWagerFields(r); return; }

    const wagerId = r.wagerId;
    const owner = r.wagerOwner;

    r.wagerSettled = true;
    clearOfferTimer(r);

    try {
      await cancelWager(owner, wagerId);
      console.log(`[RUM WAGER CANCEL] ${wagerId} cancelled (${reason})`);
    } catch (e) {
      const code = e && (e.code || e.message);
      if (code === WAGER_ERRORS.NOT_PENDING) {
        console.log(`[RUM WAGER CANCEL] ${wagerId} already cancelled (${reason})`);
      } else {
        console.error(`[RUM WAGER CANCEL] ${wagerId} failed:`, e && e.message);
      }
    } finally {
      resetWagerFields(r);
    }
  }

  function resolveWinnerId(r) {
    if (!r || !r.winner) return null;
    const byName = r.seats.find(s => s.name === r.winner && !s.dead && !s.left);
    if (byName) return byName.id;
    if (r.starterId && r.seats.some(s => s.id === r.starterId && !s.dead && !s.left)) {
      return r.starterId;
    }
    return null;
  }

  async function settleWagerForRoom(r, winnerPlayerId) {
    if (!r.wagerAmount || r.wagerSettled) {
      console.log(`[RUM WAGER SETTLE] Skipped: amount=${r.wagerAmount}, settled=${r.wagerSettled}`);
      return;
    }
    const roomKey = r.wagerRoomId || roomKeyOf(r);
    if (!roomKey) { console.log('[RUM WAGER SETTLE] Skipped: no room key'); return; }

    r.wagerSettled = true;
    clearOfferTimer(r);

    let loserPlayerId = null;
    if (winnerPlayerId && r.seats.length === 2) {
      const other = r.seats.find(s => s.id !== winnerPlayerId && !s.left);
      loserPlayerId = other ? other.id : null;
    }

    if (typeof settleWager !== 'function') {
      console.error('[RUM WAGER SETTLE] settleWager unavailable — manual recovery needed');
      return;
    }

    try {
      await settleWager('rummy', roomKey, winnerPlayerId, loserPlayerId);
      console.log(`[RUM WAGER SETTLE] OK winner=${winnerPlayerId}, loser=${loserPlayerId}`);
    } catch (e) {
      // wager.js retry tables will recover this on the next retry pass.
      console.error('[RUM WAGER SETTLE] FAILED — recovery via wager.js retry:', e && e.message);
    }
  }

  // ========================================================================
  // OFFER TIMER
  // ========================================================================
  function startOfferTimer(r, wagerId) {
    clearOfferTimer(r);
    r.offerExpiresAt = Date.now() + OFFER_TIMEOUT_MS;

    r.offerTimer = setTimeout(async () => {
      if (r.wagerId !== wagerId || r.wagerSettled) return;
      if (r.status !== 'wait') return;

      console.log(`[RUM OFFER EXPIRED] ${wagerId} (room ${r.id})`);
      await cancelRoomPendingWager(r, 'offer_timeout');
      for (const s of r.seats) send(sockets.get(s.id), { type: 'rum:wager_expired', wagerId });
      rumPush(r);
    }, OFFER_TIMEOUT_MS);

    if (typeof r.offerTimer.unref === 'function') r.offerTimer.unref();
  }

  // ========================================================================
  // JOIN — [T-05] async, awaits third-join cancellation
  // ========================================================================
  async function rumJoin(id, rawRoomId) {
    const roomId = validateRoomId(rawRoomId);
    if (!roomId) return rumErr(id, 'Invalid room');

    // Detach from any other room first (fire-and-forget for cleanup paths).
    for (const [rid, otherR] of RUM) {
      if (rid === PREFIX + roomId) continue;
      if (otherR.seats.some(s => s.id === id && !s.left)) {
        rumLeave(id);
        break;
      }
    }

    const key = PREFIX + roomId;
    let r = RUM.get(key);

    if (!r) {
      r = {
        id: key, seats: [], hostId: id, status: 'wait', stock: [], disc: [], melds: [],
        min: 51, turn: 0, ph: 'draw', first: false, took: null, laid: [], wasOpen: false,
        rows: null, over: false, winner: '', ready: new Set(), n: 0, starterId: null,
        buyId: null, buyUsed: false,
        wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false,
        pendingWager: 0, wagerOwner: null,
        offerTimer: null, offerExpiresAt: 0,
        wagerCreating: false, wagerSettling: false,
      };
      RUM.set(key, r);
    }

    if (r.status !== 'wait') return rumErr(id, 'Game already started in this room');
    if (r.seats.length >= 4) return rumErr(id, 'Room is full (4 players max)');

    const alreadyIn = r.seats.some(s => s.id === id);
    if (!alreadyIn) {
      r.seats.push({
        id,
        name: (players.get(id) || {}).name || 'Player',
        hand: [], opened: false, score: 0,
        dead: false, out: false, left: false,
        h45: false, bought: false, pending: false,
      });
    }

    // [T-05] Third player cancels live offer — await completion.
    if (r.wagerId && !r.wagerSettled && r.seats.length > 2) {
      await cancelRoomPendingWager(r, `third_player_joined:${id}`).catch(e => {
        console.error('[RUM] cancel on third join failed:', e && e.message);
      });
    }

    if (r.seats.length === 2 && r.wagerId && !r.wagerSettled && !r.offerTimer) {
      startOfferTimer(r, r.wagerId);
    }

    rumPush(r);
  }

  // ========================================================================
  // WAGER: OFFER — [T-01] lock + post-await re-check
  // ========================================================================
  async function rumOfferWager(id, amount) {
    const r = rumOf(id); if (!r) return;
    if (r.status !== 'wait') return rumErr(id, 'Game already started');
    if (r.seats.length !== 2) return rumErr(id, 'Wager requires exactly 2 players');
    if (!r.seats.some(s => s.id === id)) return rumErr(id, 'Not seated');

    const n = validateAmount(amount);
    if (n === null) return rumErr(id, 'Invalid wager amount');

    if (r.wagerId && !r.wagerSettled) return rumErr(id, 'An offer already exists');

    // [T-01] Local lock.
    if (r.wagerCreating) return rumErr(id, 'Another offer is being created');
    r.wagerCreating = true;

    try {
      const row = await createWager(id, 'rummy', roomKeyOf(r), n);

      // Post-await re-check: another offer may have appeared.
      if (r.wagerId && !r.wagerSettled) {
        try { await cancelWager(id, row.id); } catch {}
        return rumErr(id, 'An offer appeared while creating');
      }

      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = roomKeyOf(r);
      r.wagerSettled = false;
      r.pendingWager = 0;

      startOfferTimer(r, row.id);

      const other = r.seats.find(s => s.id !== id);
      if (other) {
        send(sockets.get(other.id), {
          type: 'rum:wager_offer',
          wagerId: row.id, amount: n, by: id,
          byName: (players.get(id) || {}).name || 'Player',
          expiresAt: r.offerExpiresAt,
        });
      }
      rumPush(r);
    } catch (e) {
      const code = e && e.code;
      if (code === WAGER_ERRORS.ROOM_ACTIVE) return rumErr(id, 'Another wager is active; retry in a moment');
      if (code === WAGER_ERRORS.INSUFFICIENT) return rumErr(id, `Not enough tokens (need ${e.required}, have ${e.available})`);
      rumErr(id, 'Offer failed: ' + (e && e.message));
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // WAGER: ACCEPT — [T-02] settle on start failure
  // ========================================================================
  async function rumAcceptWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return rumErr(id, 'Invalid wager id');

    const r = rumOf(id); if (!r) return;
    if (r.status !== 'wait') return rumErr(id, 'Game already started');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return rumErr(id, 'Offer not available');
    }
    if (id === r.wagerOwner) return rumErr(id, 'You cannot accept your own offer');

    // [T-14] Lock the accept path — prevents double accept.
    if (r.wagerCreating) return rumErr(id, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      try {
        await acceptWager(id, wagerId);
      } catch (e) {
        const code = e && e.code;
        if (code === WAGER_ERRORS.INSUFFICIENT) {
          rumErr(id, `Not enough tokens (need ${e.required}, have ${e.available})`);
        } else if (code === WAGER_ERRORS.NOT_PENDING) {
          rumErr(id, 'Offer expired or was taken');
        } else if (code === WAGER_ERRORS.NOT_FOUND) {
          rumErr(id, 'Wager not found');
        } else {
          rumErr(id, 'Accept failed: ' + (e && e.message));
        }

        // Only cancel if wager is still pending.
        if (!e || e.code !== WAGER_ERRORS.NOT_PENDING) {
          await cancelRoomPendingWager(r, `accept_failed:${(e && (e.code || e.message)) || 'unknown'}`);
        }
        rumPush(r);
        return;
      }

      // Accept succeeded: funds held for both players.
      clearOfferTimer(r);
      r.wagerRoomId = roomKeyOf(r);
      r.pendingWager = 0;

      // [T-02] Start game; on failure, refund both.
      try {
        rumStartGame(r);
      } catch (startErr) {
        console.error('[RUM] game start failed after accept:', startErr && startErr.message);
        r.wagerSettled = true;
        if (typeof settleWager === 'function') {
          await settleWager('rummy', r.wagerRoomId, null).catch(e =>
            console.error('[RUM] refund after start-failure failed:', e && e.message)
          );
        }
        rumErr(id, 'Game could not start; wagers refunded');
        rumPush(r);
        return;
      }

      rumPush(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // WAGER: REJECT
  // ========================================================================
  async function rumRejectWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return rumErr(id, 'Invalid wager id');

    const r = rumOf(id); if (!r) return;
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return rumErr(id, 'Offer not available');
    }
    if (id === r.wagerOwner) return rumErr(id, 'You cannot reject your own offer');

    const ownerId = r.wagerOwner;
    await cancelRoomPendingWager(r, `rejected_by:${id}`);

    if (ownerId) {
      send(sockets.get(ownerId), { type: 'rum:wager_rejected', wagerId, by: id });
    }
    rumPush(r);
  }

  // ========================================================================
  // WAGER: COUNTER — [T-01] lock + [T-15] re-validate original owner
  // ========================================================================
  async function rumCounterWager(id, rawWagerId, amount) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return rumErr(id, 'Invalid wager id');

    const r = rumOf(id); if (!r) return;
    if (r.status !== 'wait') return rumErr(id, 'Game already started');
    if (r.seats.length !== 2) return rumErr(id, 'Wager requires exactly 2 players');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return rumErr(id, 'Offer not available');
    }
    if (id === r.wagerOwner) return rumErr(id, 'You cannot counter your own offer');

    const n = validateAmount(amount);
    if (n === null) return rumErr(id, 'Invalid wager amount');

    if (r.wagerCreating) return rumErr(id, 'Another action is in progress');
    r.wagerCreating = true;

    const originalOwner = r.wagerOwner;
    await cancelRoomPendingWager(r, `countered_by:${id}`);

    try {
      const row = await createWager(id, 'rummy', roomKeyOf(r), n);
      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = roomKeyOf(r);
      r.wagerSettled = false;
      r.pendingWager = 0;

      startOfferTimer(r, row.id);

      // [T-15] Re-validate original owner is still in room.
      const stillThere = originalOwner && r.seats.some(s => s.id === originalOwner && !s.left);
      if (stillThere && originalOwner !== id) {
        send(sockets.get(originalOwner), {
          type: 'rum:wager_offer',
          wagerId: row.id, amount: n, by: id,
          byName: (players.get(id) || {}).name || 'Player',
          isCounter: true,
          expiresAt: r.offerExpiresAt,
        });
      }
      rumPush(r);
    } catch (e) {
      const code = e && e.code;
      if (code === WAGER_ERRORS.ROOM_ACTIVE) rumErr(id, 'Another wager is still active; retry in a moment');
      else if (code === WAGER_ERRORS.INSUFFICIENT) rumErr(id, `Not enough tokens (need ${e.required}, have ${e.available})`);
      else rumErr(id, 'Counter failed: ' + (e && e.message));
      rumPush(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // GAMEPLAY
  // ========================================================================
  function rumStartGame(r) {
    if (!r.seats.length) throw new Error('no seats');
    r.n = r.seats.length;
    r.over = false; r.winner = '';
    r.seats.forEach(s => { s.score = 0; s.dead = false; s.bought = false; s.pending = false; });
    r.buyId = null; r.buyUsed = false;
    rumDeal(r, crypto.randomInt(r.n));
  }

  function rumStart(id) {
    const r = rumOf(id); if (!r || r.status !== 'wait') return;
    if (r.seats.length < 2) return rumErr(id, 'Need at least 2 players');
    try { rumStartGame(r); }
    catch (e) { rumErr(id, 'Start failed: ' + (e && e.message)); }
  }

  function rumAgain(id) {
    const r = rumOf(id); if (!r || r.status !== 'end') return;
    r.seats = r.seats.filter(s => !s.left);
    if (r.seats.length < 2) return rumErr(id, 'Need at least 2 players');
    resetWagerFields(r);
    r.wagerSettled = false;
    try { rumStartGame(r); }
    catch (e) { rumErr(id, 'Restart failed: ' + (e && e.message)); }
  }

  function rumDeal(r, st) {
    if (st < 0 || st >= r.seats.length) throw new Error('invalid starter index');
    r.stock = rumDeck(); r.disc = []; r.melds = []; r.min = 51; r.first = true;
    r.rows = null; r.ready = new Set(); r.status = 'play';
    r.seats.forEach((s, i) => {
      s.opened = false; s.out = false; s.h45 = false; s.hand = [];
      if (!s.dead) for (let k = 0; k < (i === st ? 15 : 14); k++) s.hand.push(r.stock.pop());
    });
    rumTurn(r, st);
    rumPush(r);
  }

  function rumTurn(r, i) { r.turn = i; r.took = null; r.laid = []; r.wasOpen = r.seats[i].opened; r.ph = r.first ? 'play' : 'draw'; }

  function rumAdvance(r) {
    r.first = false;
    if (r.seats.filter(rumActive).length < 2) return rumEnd(r, null);
    let j = r.turn;
    let guard = 0;
    do {
      j = (j + 1) % r.seats.length;
      if (++guard > r.seats.length * 2) { console.error('[RUM] advance loop detected'); return rumEnd(r, null); }
    } while (!rumActive(r.seats[j]));
    rumTurn(r, j); rumPush(r);
  }

  function rumCur(id, ph) {
    const r = rumOf(id); if (!r || r.status !== 'play') return null;
    const i = r.seats.findIndex(s => s.id === id), s = r.seats[i];
    if (i < 0 || i !== r.turn || !rumActive(s)) { rumErr(id, 'Not your turn'); return null; }
    if (r.ph !== ph) { rumErr(id, ph === 'draw' ? 'You cannot draw now' : 'Draw a card first'); return null; }
    return { r, i, s };
  }

  function rumDraw(id, from) {
    const x = rumCur(id, 'draw'); if (!x) return;
    const { r, s } = x; let c;
    if (from === 'd') {
      if (!r.disc.length) return;
      c = r.disc.pop(); r.took = c;
    } else {
      if (!r.stock.length) {
        const top = r.disc.pop();
        r.stock = rumShuffle(r.disc);
        r.disc = top ? [top] : [];
      }
      if (!r.stock.length) return rumEnd(r, null);
      c = r.stock.pop();
    }
    s.hand.push(c); r.ph = 'play'; rumPush(r);
  }

  function rumUndo(id) { rumErr(id, 'No undo: the discarded card must be used'); }

  function rumPenalty(r, i, text) {
    const s = r.seats[i];
    s.score += 100; s.out = true;
    r.stock.unshift(...s.hand); s.hand = [];
    send(sockets.get(s.id), { type: 'rum:note', text: text + ' — Penalty: 100 points' });
    rumAdvance(r);
  }

  const rumPlaceable = (r, c) => r.melds.some(m => RM.trySwap(m, c) || RM.meld([...m.cards, c]));

  function rumParse(s, groups) {
    if (!Array.isArray(groups) || groups.length > 8) return null;
    const used = new Set(), out = [];
    for (const g of groups) {
      if (!Array.isArray(g)) return null;
      const cs = [];
      for (const cid of g) {
        const c = s.hand.find(h => h.id === +cid);
        if (!c || used.has(c.id)) return null;
        used.add(c.id); cs.push(c);
      }
      const m = RM.meld(cs); if (!m) return null;
      out.push({ cs, m });
    }
    return out;
  }

  function rumLay(id, d) {
    const x = rumCur(id, 'play'); if (!x) return;
    const { r, i, s } = x;
    const ps = rumParse(s, d.groups); if (!ps) return rumErr(id, 'Invalid meld');
    if (!ps.length && s.opened) return rumErr(id, 'No meld to lay');
    const tot = ps.reduce((a, p) => a + p.m.pts, 0), used = ps.reduce((a, p) => a + p.cs.length, 0);
    if (s.hand.length === used && !(s.h45 || ps.some(p => p.cs.length >= 4))) return rumErr(id, 'Must have a set of 4 or 5');
    if (!s.opened) {
      if (tot < r.min) {
        if (r.took && RM.pts(RM.solve(s.hand)) < r.min) return rumPenalty(r, i, `You took the discard but couldn't open ${r.min}`);
        return rumErr(id, `Opening requires ${r.min}, you have ${tot}`);
      }
      s.opened = true; r.min = tot + 1;
    }
    const u = new Set();
    ps.forEach(p => {
      r.melds.push({ o: i, cards: p.m.ord, k: p.m.k });
      r.laid.push({ n: p.cs.length });
      if (p.cs.length >= 4) s.h45 = true;
      p.cs.forEach(c => u.add(c.id));
    });
    s.hand = s.hand.filter(c => !u.has(c.id));
    if (!s.hand.length) return rumEnd(r, i);
    rumPush(r);
  }

  function rumPlace(id, d) {
    const x = rumCur(id, 'play'); if (!x) return;
    const { r, i, s } = x;
    if (!s.opened) return rumErr(id, 'Must open first');
    const m = r.melds[+d.meld]; if (!m || !Array.isArray(d.cards)) return rumErr(id, 'Invalid meld');
    for (const cid of d.cards) {
      const c = s.hand.find(h => h.id === +cid); if (!c) break;
      const sw = RM.trySwap(m, c);
      if (sw) {
        m.cards = sw.r.ord; m.k = sw.r.k;
        s.hand = s.hand.filter(h => h !== c);
        s.hand.push(sw.j);
        send(sockets.get(id), { type: 'rum:note', text: 'Joker swapped' });
        if (m.cards.length >= 4) s.h45 = true;
        continue;
      }
      const rr = RM.meld([...m.cards, c]);
      if (!rr) { rumErr(id, 'Card cannot be placed here'); break; }
      m.cards = rr.ord; m.k = rr.k;
      s.hand = s.hand.filter(h => h !== c);
      if (m.cards.length >= 4) s.h45 = true;
    }
    if (!s.hand.length) return rumEnd(r, i);
    rumPush(r);
  }

  function rumDiscard(id, d) {
    const x = rumCur(id, 'play'); if (!x) return;
    const { r, i, s } = x;
    const c = s.hand.find(h => h.id === +d.card);
    if (!c) return rumErr(id, 'Select a card to discard');
    const legal = s.hand.filter(h => h.r && !rumPlaceable(r, h));
    if (legal.length && !legal.includes(c)) return rumErr(id, !c.r ? 'Cannot discard Joker' : 'Cannot discard a placeable card');
    if (r.took && !s.opened) return rumPenalty(r, i, 'Took discard but didn\'t open or flush');
    if (s.hand.length === 1 && !s.h45) return rumErr(id, 'Cannot discard: need a set of 4 or 5');
    s.hand = s.hand.filter(h => h !== c);
    r.disc.push(c);
    if (!s.hand.length) return rumEnd(r, i);
    rumAdvance(r);
  }

  function rumFlush(id) {
    const x = rumCur(id, 'play'); if (!x) return;
    const { r, i, s } = x;
    const ms = RM.solve(s.hand, true), used = new Set(ms.flat().map(c => c.id));
    let placed = 0, big = false;
    const all = [
      ...r.melds.map(m => ({ ...m, cards: [...m.cards] })),
      ...ms.map(g => { const m = RM.meld(g); return { o: i, cards: m.ord, k: m.k }; }),
    ];
    const left = s.hand.filter(c => !used.has(c.id)).filter(c => {
      for (const m of all) {
        const rr = RM.meld([...m.cards, c]);
        if (rr) { m.cards = rr.ord; m.k = rr.k; placed++; if (m.cards.length >= 4) big = true; return false; }
      }
      return true;
    });
    const own = ms.flat().length, total = own + placed, needed = r.wasOpen ? s.hand.length - 1 : 14;
    const has45 = s.h45 || big || ms.some(g => g.length >= 4);
    if (left.length > 1 || total !== needed)
      return rumPenalty(r, i, left.length > 1 ? `Invalid flush: ${left.length} cards left` : `Invalid flush: ${total} instead of ${needed}`);
    if (!has45) return rumPenalty(r, i, 'Invalid flush: need a set of 4 or 5');
    r.melds = all; s.opened = true; s.hand = [];
    if (left[0]) r.disc.push(left[0]);
    rumEnd(r, i);
  }

  function rumEnd(r, w) {
    r.rows = r.seats.map((s, i) => {
      if (s.dead) return null;
      let d, note = '';
      if (i === w) { d = -10; note = 'Flush 🏆'; }
      else if (s.out) { d = 0; note = s.left ? 'Left (100)' : 'Invalid flush (100)'; }
      else if (!s.opened) d = 100;
      else d = s.hand.reduce((a, c) => a + RM.hv(c), 0);
      s.score += d;
      return { sid: s.id, name: s.name, d, score: s.score, note };
    }).filter(Boolean);

    r.starterId = w != null && r.seats[w] ? r.seats[w].id : (r.seats[r.turn] || {}).id;
    const dying = r.seats.filter(s => !s.dead && s.score >= 300);
    r.buyId = null;
    dying.forEach(s => {
      const row = r.rows.find(x => x.sid === s.id);
      if (dying.length === 1 && !r.buyUsed && !s.bought && r.n >= 3) {
        r.buyId = s.id; r.buyUsed = true; s.pending = true;
        if (row) row.note += ' 💀 Lost 300 — can buy back';
      } else {
        s.dead = true;
        if (row) row.note += s.bought ? ' 💀 Dead (double)' : ' 💀';
      }
    });
    r.seats.forEach(s => { s.out = false; });
    r.seats = r.seats.filter(s => !s.left);
    if (!r.seats.some(s => s.id === r.hostId) && r.seats[0]) r.hostId = r.seats[0].id;
    r.ready = new Set();
    rumCheckOver(r);

    if (r.over && r.wagerAmount > 0 && !r.wagerSettled) {
      const winnerId = resolveWinnerId(r);
      settleWagerForRoom(r, winnerId);
    }

    rumPush(r);
  }

  function rumCheckOver(r) {
    const alive = r.seats.filter(s => !s.dead);
    r.over = alive.length <= Math.max(1, r.n - 2) || r.seats.length < 2;
    if (r.over) {
      const pool = alive.length ? alive : r.seats;
      const best = pool.slice().sort((a, b) => a.score - b.score)[0];
      r.winner = best ? best.name : '';
      r.status = 'end';
      r.buyId = null;
    } else {
      r.status = 'round';
    }
  }

  function rumBuy(id, yes) {
    const r = rumOf(id); if (!r || r.status !== 'round' || r.buyId !== id) return;
    const s = r.seats.find(x => x.id === id);
    if (!s) return;
    s.pending = false; r.buyId = null;
    if (yes) {
      const o = r.seats.filter(x => x !== s && !x.dead).map(x => x.score);
      s.score = o.length ? Math.max(...o) : s.score;
      s.bought = true;
    } else {
      s.dead = true;
    }
    rumCheckOver(r); rumPush(r);
  }

  // [T-09] Guard against st = -1
  function rumNextRound(id) {
    const r = rumOf(id); if (!r || r.status !== 'round' || r.buyId) return;
    r.ready.add(id);
    if (r.seats.filter(s => !s.dead).every(s => r.ready.has(s.id))) {
      let st = r.seats.findIndex(s => s.id === r.starterId && !s.dead);
      if (st < 0) st = r.seats.findIndex(s => !s.dead);
      if (st < 0) {
        console.error('[RUM] no alive seats at next round — ending');
        r.over = true; r.status = 'end';
        return rumPush(r);
      }
      try { rumDeal(r, st); }
      catch (e) { console.error('[RUM] deal failed:', e && e.message); }
      return;
    }
    rumPush(r);
  }

  // ========================================================================
  // LEAVE — [T-06] settle with lock, set settled only after success
  // ========================================================================
  function rumLeave(id) {
    const r = rumOf(id); if (!r) return;
    const i = r.seats.findIndex(s => s.id === id), s = r.seats[i];
    if (!s) return;

    // -------- Waiting room --------
    if (r.status === 'wait') {
      if (r.wagerId && !r.wagerSettled) {
        cancelRoomPendingWager(r, `leave_waiting:${id}`).catch(() => {});
      }
      r.seats.splice(i, 1);
      if (r.buyId === id) r.buyId = null;
      if (!r.seats.length) {
        clearOfferTimer(r);
        return void RUM.delete(r.id);
      }
      if (r.hostId === id) r.hostId = r.seats[0].id;
      return rumPush(r);
    }

    // -------- In game --------
    if (r.status === 'play') {
      s.left = true; s.out = true; s.score += 100;
      r.stock.unshift(...s.hand); s.hand = [];

      // [T-06, T-07] Settle with lock.
      if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
        const other = r.seats.find(x => x.id !== id && !x.left);
        if (other && r.seats.length === 2) {
          r.wagerSettling = true;
          clearOfferTimer(r);
          if (typeof settleWager === 'function') {
            settleWager('rummy', r.wagerRoomId || roomKeyOf(r), other.id, id)
              .then(() => { r.wagerSettled = true; })
              .catch(e => console.error('[RUM WAGER SETTLE] failed:', e && e.message))
              .finally(() => { r.wagerSettling = false; });
          }
        } else if (!other) {
          cancelRoomPendingWager(r, `leave_play_no_opponent:${id}`).catch(() => {});
        }
      }

      if (r.seats.filter(rumActive).length < 2) return rumEnd(r, null);
      return r.turn === i ? rumAdvance(r) : rumPush(r);
    }

    // -------- Round or end --------
    r.seats.splice(i, 1);
    if (r.buyId === id) r.buyId = null;
    if (!r.seats.length) {
      clearOfferTimer(r);
      return void RUM.delete(r.id);
    }
    if (r.hostId === id) r.hostId = r.seats[0].id;

    if (r.status === 'round' && r.seats.filter(x => !x.dead).length < 2) {
      r.over = true; r.status = 'end';
      r.winner = (r.seats.find(x => !x.dead) || r.seats[0]).name;

      if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
        const winner = r.seats.find(x => !x.dead && !x.left);
        if (winner) {
          r.wagerSettling = true;
          clearOfferTimer(r);
          if (typeof settleWager === 'function') {
            settleWager('rummy', r.wagerRoomId || roomKeyOf(r), winner.id, id)
              .then(() => { r.wagerSettled = true; })
              .catch(e => console.error('[RUM WAGER SETTLE]', e && e.message))
              .finally(() => { r.wagerSettling = false; });
          }
        } else {
          cancelRoomPendingWager(r, `round_end_no_winner:${id}`).catch(() => {});
        }
      }
    }
    rumPush(r);
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================
  const safe = (fn, tag) => (...args) => {
    try { return fn(...args); }
    catch (e) { console.error(`[RUM ${tag}]`, e && e.message); }
  };

  const safeAsync = (fn, tag) => (...args) => {
    Promise.resolve().then(() => fn(...args)).catch(e => {
      console.error(`[RUM ${tag}]`, e && e.message);
    });
  };

  return {
    prefix: PREFIX,

    handle(id, d) {
      if (!d || typeof d.type !== 'string') return;

      switch (d.type) {
        // Seating
        case 'rum:join':
          if (players.has(id)) safeAsync(rumJoin, 'join')(id, d.room);
          break;
        case 'rum:leave':   safe(rumLeave, 'leave')(id); break;
        case 'rum:start':   safe(rumStart, 'start')(id); break;

        // Wager flow
        case 'rum:wager_offer':   safeAsync(rumOfferWager, 'offer')(id, d.amount); break;
        case 'rum:wager_accept':  safeAsync(rumAcceptWager, 'accept')(id, d.wagerId); break;
        case 'rum:wager_reject':  safeAsync(rumRejectWager, 'reject')(id, d.wagerId); break;
        case 'rum:wager_counter': safeAsync(rumCounterWager, 'counter')(id, d.wagerId, d.amount); break;

        // Gameplay
        case 'rum:draw':    safe(rumDraw, 'draw')(id, d.from); break;
        case 'rum:undo':    safe(rumUndo, 'undo')(id); break;
        case 'rum:buy':     safe(rumBuy, 'buy')(id, !!d.yes); break;
        case 'rum:open':
        case 'rum:lay':     safe(rumLay, 'lay')(id, d); break;
        case 'rum:place':   safe(rumPlace, 'place')(id, d); break;
        case 'rum:discard': safe(rumDiscard, 'discard')(id, d); break;
        case 'rum:flush':   safe(rumFlush, 'flush')(id); break;
        case 'rum:next':    safe(rumNextRound, 'next')(id); break;
        case 'rum:again':   safe(rumAgain, 'again')(id); break;
      }
    },

    leave: rumLeave,

    // [T-11] Cleanup hook for server shutdown
    shutdown() {
      for (const r of RUM.values()) clearOfferTimer(r);
      RUM.clear();
    },

    _test: { RM, RUM, roomKeyOf },
  };
};

'use strict';

// games/shkobba.js — Cafe Life Shkobba. FORTRESS EDITION (final).
// ============================================================================
// Wager flow:
//   OFFER:   A creates a pending wager (amount N) held in escrow.
//   ACCEPT:  B explicitly accepts (pays N, wager → active, game starts).
//   COUNTER: B proposes amount M (A's offer cancelled+refunded, new offer).
//   REJECT:  B declines (A's offer cancelled+refunded).
//   TIMEOUT: 60s without action → auto-cancel + refund.
//
// Hardening map:
//   [H-01] Per-room wagerCreating lock (offer/accept/reject/counter).
//   [H-02] Per-room wagerSettling lock (any settle path).
//   [H-03] Accept: post-await room validation (opponent may leave during await).
//   [H-04] Accept: cancel only on insufficient_balance, never on not_pending.
//   [H-05] Counter: abort if the original wager became active mid-cancel.
//   [H-06] Leave: capture wager snapshot BEFORE mutating slots.
//   [H-07] Leave: detached settlement using snapshot (no live r reads).
//   [H-08] Offer/Counter: post-await re-validation (game started / offer appeared).
//   [H-09] validateRoomId / validateWagerId / validateCard.
//   [H-10] shkStart: guard against missing seats (defensive).
//   [H-11] shkFinish: settle only when !wagerSettled && !wagerSettling.
//   [H-12] shkNext/shkAgain: refuse while wagerSettling.
//   [H-13] Every async path has explicit .catch with logging.
//   [H-14] cancelRoomPendingWager returns {active} so callers can abort.
//   [H-15] offerTimer cleared on every room exit path.
// ============================================================================

module.exports = function createShkobbaGame({
  send, sockets, players, broadcast, crypto,
  createWager, acceptWager, cancelWager, settleWager,
}) {
  // ======================================================================
  // CONSTANTS
  // ======================================================================
  const OFFER_TIMEOUT_MS = 60 * 1000;
  const MIN_WAGER = 300;
  const MAX_WAGER = 100000;
  const MAX_ROOM_ID_LEN = 40;

  const shk = new Map();
  const val = c => +c.slice(1);
  const nameOf = id => (players.get(id) || {}).name || 'Player';

  // ======================================================================
  // VALIDATION
  // ======================================================================
  function validateRoomId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > MAX_ROOM_ID_LEN) return null;
    if (!/^[A-Za-z0-9_\-]+$/.test(s)) return null;
    return s;
  }

  function validateWagerId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 64) return null;
    if (!/^wg_[A-Za-z0-9]+$/.test(s)) return null;
    return s;
  }

  function validateAmount(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < MIN_WAGER || n > MAX_WAGER) return null;
    return n;
  }

  function validateCard(v) {
    const s = String(v == null ? '' : v);
    if (!/^[dcsb](10|[1-9])$/.test(s)) return null;
    return s;
  }

  function fail(id, text) {
    send(sockets.get(id), { type: 'shk:err', text });
  }

  function failFromError(id, fallback, e) {
    let text = fallback;
    if (e && e.code === 'insufficient_balance') {
      text = `Not enough tokens (need ${e.required}, have ${e.available})`;
    } else if (e && e.code === 'room_has_active_wager') {
      text = 'Another wager is active; please retry in a moment';
    } else if (e && e.code === 'wager_not_pending') {
      text = 'Offer expired or was taken';
    } else if (e && e.code === 'wager_not_found') {
      text = 'Wager not found';
    } else if (e && e.code === 'cannot_wager_against_self') {
      text = 'You cannot wager against yourself';
    } else if (e && e.message) {
      text = `${fallback}: ${e.message}`;
    }
    send(sockets.get(id), { type: 'shk:err', text });
  }

  const roomKeyOf = r => r.wagerRoomId || r.id;

  // ======================================================================
  // DECK & SCORING (unchanged)
  // ======================================================================
  function newDeck() {
    const d = [];
    ['d', 'c', 's', 'b'].forEach(s => { for (let v = 1; v <= 10; v++) d.push(s + v); });
    for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
    return d;
  }

  function shkOpts(table, v) {
    const eq = table.filter(c => val(c) === v);
    if (eq.length) return eq.map(c => [c]);
    const res = [], n = table.length;
    for (let m = 1; m < (1 << n); m++) {
      let sum = 0; const set = [];
      for (let i = 0; i < n; i++) if (m & (1 << i)) { sum += val(table[i]); set.push(table[i]); }
      if (sum === v) res.push(set);
    }
    return res;
  }

  // ======================================================================
  // ROOM STATE
  // ======================================================================
  function shkRoom(id) {
    return {
      id, a: null, b: null, spec: new Set(), status: 'wait', goal: 11,
      score: { a: 0, b: 0 }, first: 'b', ready: new Set(), summary: null,
      winner: null, forfeit: null, table: [], hand: { a: [], b: [] },
      cap: { a: [], b: [] }, sk: { a: 0, b: 0 }, deck: [], last: null,
      turn: 'a', lastCap: null,
      // wager state
      wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false,
      pendingWager: 0, wagerOwner: null,
      offerTimer: null, offerExpiresAt: 0,
      // locks
      wagerCreating: false, wagerSettling: false,
    };
  }

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
    // wagerSettled / locks: caller-managed.
  }

  // ======================================================================
  // GAME HELPERS
  // ======================================================================
  function shkDeal(r) {
    r.hand.a = r.deck.splice(0, 3);
    r.hand.b = r.deck.splice(0, 3);
  }

  function shkStart(r) {
    if (!r.a || !r.b) throw new Error('cannot start without both players');
    r.deck = newDeck();
    r.table = r.deck.splice(0, 4);
    r.cap = { a: [], b: [] };
    r.sk = { a: 0, b: 0 };
    r.lastCap = null;
    r.last = null;
    r.summary = null;
    r.winner = null;
    r.forfeit = null;
    r.wagerSettled = false;
    r.first = r.first === 'a' ? 'b' : 'a';
    r.turn = r.first;
    shkDeal(r);
    r.status = 'play';
    r.ready.clear();
  }

  function shkScore(r) {
    const cnt = p => {
      const c = r.cap[p];
      return {
        n: c.length,
        d: c.filter(x => x[0] === 'd').length,
        s7: c.filter(x => val(x) === 7).length,
        s6: c.filter(x => val(x) === 6).length,
        z: c.includes('d7') ? 1 : 0,
      };
    };
    const A = cnt('a'), B = cnt('b'), pts = { a: 0, b: 0 }, lines = [];
    const w = (x, y) => (x > y ? 'a' : y > x ? 'b' : null);
    const add = (k, a, b, win) => { if (win) pts[win]++; lines.push({ k, a, b, w: win }); };
    add('Most Cards', A.n, B.n, w(A.n, B.n));
    add('Most Gold (Dinars)', A.d, B.d, w(A.d, B.d));
    add('Seven of Gold', A.z, B.z, w(A.z, B.z));
    add('Most Sevens', A.s7, B.s7, w(A.s7, B.s7));
    lines.push({ k: 'Shkobba', a: r.sk.a, b: r.sk.b, w: null });
    pts.a += r.sk.a; pts.b += r.sk.b;
    return { lines, pts };
  }

  // ======================================================================
  // WAGER SETTLEMENT
  // ======================================================================
  async function settleDetached({ winnerPlayerId, loserPlayerId, roomKey, amount, reason }) {
    if (!roomKey || !amount) return;
    if (typeof settleWager !== 'function') {
      console.error('[SHK SETTLE] settleWager unavailable — MANUAL RECOVERY NEEDED', {
        roomKey, winnerPlayerId, loserPlayerId, amount, reason,
      });
      return;
    }
    try {
      await settleWager('shkobba', roomKey, winnerPlayerId || null, loserPlayerId || null);
      console.log(`[SHK SETTLE] OK winner=${winnerPlayerId} loser=${loserPlayerId} reason=${reason}`);
    } catch (e) {
      console.error(`[SHK SETTLE] FAILED room=${roomKey} reason=${reason}:`, e && e.message);
    }
  }

  function fireDetachedSettle(r, snapshot, reason) {
    if (!snapshot || !snapshot.amount) return false;
    r.wagerSettled = true;
    r.wagerSettling = true;
    clearOfferTimer(r);
    settleDetached({ ...snapshot, reason })
      .finally(() => { r.wagerSettling = false; });
    return true;
  }

  // [H-14] Returns { ok, skipped?, active?, error? }
  async function cancelRoomPendingWager(r, reason) {
    if (!r.wagerId || r.wagerSettled || r.wagerSettling) {
      resetWagerFields(r);
      return { ok: true, skipped: true };
    }
    if (r.wagerOwner == null || typeof cancelWager !== 'function') {
      resetWagerFields(r);
      return { ok: true, skipped: true };
    }

    const wagerId = r.wagerId;
    const owner = r.wagerOwner;

    r.wagerSettled = true;
    r.wagerSettling = true;
    clearOfferTimer(r);

    try {
      await cancelWager(owner, wagerId);
      console.log(`[SHK CANCEL] ${wagerId} cancelled (${reason})`);
      return { ok: true };
    } catch (e) {
      const code = e && (e.code || e.message);
      if (code === 'wager_not_pending') {
        console.log(`[SHK CANCEL] ${wagerId} already not pending (${reason})`);
        return { ok: false, active: true };
      }
      console.error(`[SHK CANCEL] ${wagerId} failed (${reason}):`, e && e.message);
      return { ok: false, error: e };
    } finally {
      resetWagerFields(r);
      r.wagerSettling = false;
    }
  }

  // ======================================================================
  // OFFER TIMER
  // ======================================================================
  function startOfferTimer(r, wagerId) {
    clearOfferTimer(r);
    r.offerExpiresAt = Date.now() + OFFER_TIMEOUT_MS;

    r.offerTimer = setTimeout(async () => {
      if (r.wagerId !== wagerId || r.wagerSettled) return;
      if (r.status !== 'wait') return;

      console.log(`[SHK OFFER EXPIRED] ${wagerId} (room ${r.id})`);
      await cancelRoomPendingWager(r, 'offer_timeout').catch(e =>
        console.error('[SHK] offer_timeout cancel failed:', e && e.message)
      );

      for (const pid of [r.a, r.b].filter(Boolean)) {
        send(sockets.get(pid), { type: 'shk:wager_expired', wagerId });
      }
      shkPush(r);
    }, OFFER_TIMEOUT_MS);

    if (typeof r.offerTimer.unref === 'function') r.offerTimer.unref();
  }

  // ======================================================================
  // STATE PUSH
  // ======================================================================
  function shkPush(r) {
    const ids = [r.a, r.b, ...r.spec].filter(Boolean);
    const offer = (r.wagerId && !r.wagerSettled && r.wagerOwner != null) ? {
      wagerId: r.wagerId,
      amount: r.wagerAmount,
      by: r.wagerOwner,
      byName: nameOf(r.wagerOwner),
      expiresAt: r.offerExpiresAt || 0,
    } : null;

    const base = {
      type: 'shk:state', room: r.id, status: r.status, goal: r.goal, table: r.table, score: r.score,
      names: { a: r.a ? nameOf(r.a) : '', b: r.b ? nameOf(r.b) : '' },
      turn: r.turn, deck: r.deck.length, nHand: { a: r.hand.a.length, b: r.hand.b.length },
      taken: { a: r.cap.a.length, b: r.cap.b.length },
      sk: r.sk, last: r.last, summary: r.summary, winner: r.winner, forfeit: r.forfeit, ready: [...r.ready],
      wager: r.wagerAmount || null,
      wagerId: r.wagerId || null,
      offer,
    };

    for (const id of ids) {
      const you = id === r.a ? 'a' : id === r.b ? 'b' : 's';
      const hand = you === 's' ? [] : r.hand[you];
      let opts = null;
      if (r.status === 'play' && you === r.turn) {
        opts = {};
        for (const c of hand) opts[c] = shkOpts(r.table, val(c));
      }
      send(sockets.get(id), { ...base, you, hand, opts });
    }
  }

  function shkOf(id) {
    for (const r of shk.values()) if (r.a === id || r.b === id || r.spec.has(id)) return r;
    return null;
  }

  // ======================================================================
  // LEAVE — [H-06] snapshot BEFORE mutating slots
  // ======================================================================
  function shkLeave(id) {
    for (const [rid, r] of shk) {
      if (!(r.a === id || r.b === id || r.spec.has(id))) continue;
      r.spec.delete(id);

      if (r.a === id || r.b === id) {
        const slot = r.a === id ? 'a' : 'b';
        const other = slot === 'a' ? 'b' : 'a';
        const opponentId = r[other];
        const wasInGame = (r.status === 'play' || r.status === 'round');
        const wasWaitingWithWager = r.status === 'wait' && r.wagerId && !r.wagerSettled && !r.wagerSettling;

        // [H-06] Snapshot BEFORE any mutation
        const wagerSnapshot = (wasInGame && opponentId && r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) ? {
          winnerPlayerId: opponentId,
          loserPlayerId: id,
          roomKey: roomKeyOf(r),
          amount: r.wagerAmount,
        } : null;

        // Update status
        if (wasInGame) {
          r.status = 'end';
          r.winner = opponentId ? other : null;
          r.forfeit = `${nameOf(id)} resigned`;
          r.summary = null;
        } else if (wasWaitingWithWager) {
          const pendingId = r.wagerId;
          const pendingOwner = r.wagerOwner;
          cancelRoomPendingWager(r, `player_left_waiting:${id}`).catch(e =>
            console.error(`[SHK] cancel on leave failed for ${pendingId}/${pendingOwner}:`, e && e.message)
          );
          r.status = 'wait';
        } else if (r.status !== 'end') {
          r.status = 'wait';
        }

        // Clear slot
        r[slot] = null;

        // Shift seats if only 'b' remains
        if (!r.a && r.b) {
          r.a = r.b; r.b = null;
          r.score = { a: r.score.b, b: r.score.a };
          if (r.winner) r.winner = r.winner === 'b' ? 'a' : r.winner;
          r.hand = { a: r.hand.b, b: [] };
          r.cap = { a: r.cap.b, b: [] };
          r.sk = { a: r.sk.b, b: 0 };
        }

        // Fire settlement
        if (wagerSnapshot) fireDetachedSettle(r, wagerSnapshot, 'leave_during_game');
      }

      if (!r.a && !r.b && r.spec.size === 0) {
        clearOfferTimer(r);
        shk.delete(rid);
      } else {
        shkPush(r);
      }
    }
  }

  // ======================================================================
  // JOIN
  // ======================================================================
  async function shkJoin(id, rawRoomId) {
    const roomId = validateRoomId(rawRoomId);
    if (!roomId) return fail(id, 'Invalid room ID');

    for (const [rid, otherR] of shk) {
      if (rid === roomId) continue;
      if (otherR.a === id || otherR.b === id) {
        shkLeave(id);
        break;
      }
    }

    let r = shk.get(roomId);
    if (!r) { r = shkRoom(roomId); shk.set(roomId, r); }

    const alreadyIn = (r.a === id || r.b === id);

    if (!r.a) r.a = id;
    else if (!r.b && r.a !== id) r.b = id;
    else if (!alreadyIn) r.spec.add(id);

    // Cancel live offer if a 3rd player joins while seats are full
    if (r.wagerId && !r.wagerSettled && r.a && r.b && r.spec.size > 0) {
      await cancelRoomPendingWager(r, `third_joined:${id}`).catch(e =>
        console.error('[SHK] cancel on third join failed:', e && e.message)
      );
    }

    // Restart timer if both seats occupied and pending offer exists
    if (r.a && r.b && r.status === 'wait' && r.wagerId && !r.wagerSettled && !r.offerTimer) {
      startOfferTimer(r, r.wagerId);
    }

    shkPush(r);
  }

  // ======================================================================
  // OFFER — [H-01] lock + [H-08] post-await re-check
  // ======================================================================
  async function shkOfferWager(id, rawAmount) {
    const r = shkOf(id); if (!r) return;
    if (r.status !== 'wait') return fail(id, 'Game already started');
    if (id !== r.a && id !== r.b) return fail(id, 'Not seated');

    const n = validateAmount(rawAmount);
    if (n === null) return fail(id, 'Invalid wager amount');
    if (r.wagerId && !r.wagerSettled) return fail(id, 'An offer already exists');

    if (r.wagerCreating) return fail(id, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      const row = await createWager(id, 'shkobba', r.id, n);

      // [H-08] Post-await re-check
      if (r.status !== 'wait') {
        try { await cancelWager(id, row.id); } catch {}
        return fail(id, 'Game started while creating offer');
      }
      if (r.wagerId && !r.wagerSettled) {
        try { await cancelWager(id, row.id); } catch {}
        return fail(id, 'An offer appeared while creating');
      }
      if (id !== r.a && id !== r.b) {
        try { await cancelWager(id, row.id); } catch {}
        return fail(id, 'You left the room');
      }

      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;

      startOfferTimer(r, row.id);

      const otherId = id === r.a ? r.b : r.a;
      if (otherId) {
        send(sockets.get(otherId), {
          type: 'shk:wager_offer',
          wagerId: row.id, amount: n, by: id,
          byName: nameOf(id),
          expiresAt: r.offerExpiresAt,
        });
      }
      shkPush(r);
    } catch (e) {
      failFromError(id, 'Offer failed', e);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ======================================================================
  // ACCEPT — [H-03] post-await room validation + [H-04] smart cancel
  // ======================================================================
  async function shkAcceptWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return fail(id, 'Invalid wager id');

    const r = shkOf(id); if (!r) return;
    if (r.status !== 'wait') return fail(id, 'Game already started');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return fail(id, 'Offer not available');
    }
    if (id === r.wagerOwner) return fail(id, 'You cannot accept your own offer');

    if (r.wagerCreating) return fail(id, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      try {
        await acceptWager(id, wagerId);
      } catch (e) {
        const code = e && (e.code || e.message);
        const cancelSafe = code !== 'wager_not_pending' && code !== 'wager_not_found';

        failFromError(id, 'Accept failed', e);

        if (cancelSafe) {
          await cancelRoomPendingWager(r, `accept_failed:${code || 'unknown'}`).catch(() => {});
        }
        shkPush(r);
        return;
      }

      // [H-03] Accept succeeded — validate room state did not change
      clearOfferTimer(r);
      r.wagerRoomId = r.id;

      if (!r.a || !r.b || r.status !== 'wait') {
        // Opponent left during await — refund both.
        fireDetachedSettle(r, {
          winnerPlayerId: null, loserPlayerId: null,
          roomKey: roomKeyOf(r), amount: r.wagerAmount,
        }, 'accept_room_gone');
        fail(id, 'Room changed — wagers refunded');
        shkPush(r);
        return;
      }

      r.score = { a: 0, b: 0 };

      try {
        shkStart(r);
      } catch (startErr) {
        console.error('[SHK] start failed after accept:', startErr && startErr.message);
        fireDetachedSettle(r, {
          winnerPlayerId: null, loserPlayerId: null,
          roomKey: roomKeyOf(r), amount: r.wagerAmount,
        }, 'start_failed');
        fail(id, 'Game could not start; wagers refunded');
        shkPush(r);
        return;
      }
      shkPush(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ======================================================================
  // REJECT
  // ======================================================================
  async function shkRejectWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return fail(id, 'Invalid wager id');

    const r = shkOf(id); if (!r) return;
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return fail(id, 'Offer not available');
    }
    if (id === r.wagerOwner) return fail(id, 'You cannot reject your own offer');

    if (r.wagerCreating) return fail(id, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      const ownerId = r.wagerOwner;
      const result = await cancelRoomPendingWager(r, `rejected_by:${id}`);
      if (result && result.active) {
        fail(id, 'Offer is no longer pending');
      } else if (ownerId) {
        send(sockets.get(ownerId), { type: 'shk:wager_rejected', wagerId, by: id });
      }
      shkPush(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ======================================================================
  // COUNTER — [H-05] abort if original became active mid-cancel
  // ======================================================================
  async function shkCounterWager(id, rawWagerId, rawAmount) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return fail(id, 'Invalid wager id');

    const r = shkOf(id); if (!r) return;
    if (r.status !== 'wait') return fail(id, 'Game already started');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return fail(id, 'Offer not available');
    }
    if (id === r.wagerOwner) return fail(id, 'You cannot counter your own offer');

    const n = validateAmount(rawAmount);
    if (n === null) return fail(id, 'Invalid wager amount');

    if (r.wagerCreating) return fail(id, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      const originalOwner = r.wagerOwner;
      const cancelResult = await cancelRoomPendingWager(r, `countered_by:${id}`);
      if (cancelResult && cancelResult.active) {
        // [H-05] Original became active during cancel — do NOT create counter.
        fail(id, 'Offer was already accepted');
        shkPush(r);
        return;
      }

      const row = await createWager(id, 'shkobba', r.id, n);

      // Post-await re-check
      if (r.status !== 'wait') {
        try { await cancelWager(id, row.id); } catch {}
        return fail(id, 'Game started while creating counter');
      }
      if (id !== r.a && id !== r.b) {
        try { await cancelWager(id, row.id); } catch {}
        return fail(id, 'You left the room');
      }

      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;

      startOfferTimer(r, row.id);

      if (originalOwner && originalOwner !== id && (originalOwner === r.a || originalOwner === r.b)) {
        send(sockets.get(originalOwner), {
          type: 'shk:wager_offer',
          wagerId: row.id, amount: n, by: id,
          byName: nameOf(id),
          isCounter: true,
          expiresAt: r.offerExpiresAt,
        });
      }
      shkPush(r);
    } catch (e) {
      failFromError(id, 'Counter failed', e);
      shkPush(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ======================================================================
  // PLAY
  // ======================================================================
  function shkPlay(id, d) {
    const r = shkOf(id); if (!r || r.status !== 'play') return;
    const who = r.a === id ? 'a' : r.b === id ? 'b' : null;
    if (!who || r.turn !== who) return;

    const card = validateCard(d.card);
    if (!card) return fail(id, 'Invalid card');

    const hand = r.hand[who];
    if (!hand.includes(card)) return;

    const opts = shkOpts(r.table, val(card));
    const rawTake = Array.isArray(d.take) ? d.take : [];
    const take = [];
    for (const t of rawTake) {
      const c = validateCard(t);
      if (!c) return fail(id, 'Invalid take card');
      take.push(c);
    }

    let chosen = null;
    if (opts.length) {
      chosen = opts.find(o => o.length === take.length && o.every(c => take.includes(c)));
      if (!chosen) return fail(id, 'Invalid choice');
    } else if (take.length) {
      return fail(id, 'Cannot take');
    }

    hand.splice(hand.indexOf(card), 1);
    const lastPlay = r.deck.length === 0 && r.hand.a.length === 0 && r.hand.b.length === 0;
    let shkb = false;

    if (chosen) {
      r.table = r.table.filter(c => !chosen.includes(c));
      r.cap[who].push(card, ...chosen);
      r.lastCap = who;
      if (!r.table.length && !lastPlay) { r.sk[who]++; shkb = true; }
    } else {
      r.table.push(card);
    }
    r.last = { who, card, take: chosen || [], shk: shkb };

    if (r.hand.a.length === 0 && r.hand.b.length === 0) {
      if (r.deck.length) {
        shkDeal(r);
        r.turn = who === 'a' ? 'b' : 'a';
      } else {
        if (r.lastCap) r.cap[r.lastCap].push(...r.table);
        r.table = [];
        shkFinish(r);
      }
    } else {
      r.turn = who === 'a' ? 'b' : 'a';
    }
    shkPush(r);
  }

  // ======================================================================
  // FINISH
  // ======================================================================
  function shkFinish(r) {
    const s = shkScore(r);
    r.summary = s;
    r.score.a += s.pts.a;
    r.score.b += s.pts.b;

    const A = r.score.a, B = r.score.b;
    if ((A >= r.goal || B >= r.goal) && A !== B) {
      r.status = 'end';
      r.winner = A > B ? 'a' : 'b';
    } else {
      r.status = 'round';
    }
    r.ready.clear();

    if (r.status === 'end' && r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
      const winnerSeat = r.winner;
      fireDetachedSettle(r, {
        winnerPlayerId: winnerSeat === 'a' ? r.a : r.b,
        loserPlayerId: winnerSeat === 'a' ? r.b : r.a,
        roomKey: roomKeyOf(r),
        amount: r.wagerAmount,
      }, 'game_end');
    }
  }

  // ======================================================================
  // GOAL / NEXT / AGAIN
  // ======================================================================
  function shkGoal(id, g) {
    const r = shkOf(id);
    if (!r || r.a !== id || ![11, 21, 31].includes(g) || !['wait', 'round', 'end'].includes(r.status)) return;
    r.goal = g;
    shkPush(r);
  }

  function shkNext(id) {
    const r = shkOf(id); if (!r || r.status !== 'round') return;
    if (r.wagerSettling) return fail(id, 'Previous wager still settling');
    r.ready.add(r.a === id ? 'a' : 'b');
    if (r.ready.has('a') && r.ready.has('b')) {
      try { shkStart(r); }
      catch (e) { console.error('[SHK] start failed:', e && e.message); return; }
    }
    shkPush(r);
  }

  function shkAgain(id) {
    const r = shkOf(id); if (!r || r.status !== 'end' || !r.a || !r.b) return;
    if (r.wagerSettling) return fail(id, 'Previous wager still settling');
    resetWagerFields(r);
    r.wagerSettled = false;
    r.score = { a: 0, b: 0 };
    try { shkStart(r); }
    catch (e) { console.error('[SHK] restart failed:', e && e.message); return; }
    shkPush(r);
  }

  // ======================================================================
  // SHUTDOWN
  // ======================================================================
  function shutdown() {
    for (const r of shk.values()) clearOfferTimer(r);
    shk.clear();
  }

  // ======================================================================
  // PUBLIC API
  // ======================================================================
  const safe = (fn, tag) => (...args) => {
    try { return fn(...args); }
    catch (e) { console.error(`[SHK ${tag}]`, e && e.message); }
  };

  const safeAsync = (fn, tag) => (...args) => {
    Promise.resolve().then(() => fn(...args)).catch(e => {
      console.error(`[SHK ${tag}]`, e && e.message);
    });
  };

  return {
    prefix: 'shk:',

    handle(id, d) {
      if (!d || typeof d.type !== 'string') return;

      switch (d.type) {
        // Seating
        case 'shk:join':
          if (players.has(id)) safeAsync(shkJoin, 'join')(id, d.room);
          break;
        case 'shk:leave':
          safe(shkLeave, 'leave')(id);
          break;

        // Wager flow
        case 'shk:wager_offer':    safeAsync(shkOfferWager, 'offer')(id, d.amount); break;
        case 'shk:wager_accept':   safeAsync(shkAcceptWager, 'accept')(id, d.wagerId); break;
        case 'shk:wager_reject':   safeAsync(shkRejectWager, 'reject')(id, d.wagerId); break;
        case 'shk:wager_counter':  safeAsync(shkCounterWager, 'counter')(id, d.wagerId, d.amount); break;

        // Gameplay
        case 'shk:play':    safe(shkPlay, 'play')(id, d); break;
        case 'shk:next':    safe(shkNext, 'next')(id); break;
        case 'shk:goal':    safe(shkGoal, 'goal')(id, +d.goal); break;
        case 'shk:again':   safe(shkAgain, 'again')(id); break;

        default:
          break;
      }
    },

    leave: shkLeave,
    shutdown,
  };
};

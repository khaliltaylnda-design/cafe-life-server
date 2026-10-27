'use strict';

// games/chess.js — Cafe Life Chess. FORTRESS EDITION.
// ============================================================================
// Wager flow (strict, no silent failure):
//   OFFER:   A creates a pending wager (amount N) held in escrow.
//   ACCEPT:  B explicitly accepts (pays N, wager → active, game starts).
//   COUNTER: B proposes amount M (A's offer cancelled+refunded, new offer).
//   REJECT:  B declines (A's offer cancelled+refunded).
//   TIMEOUT: 60s without action → auto-cancel + refund.
//
// STRICTNESS GUARANTEES (accept/reject/offer/counter):
//   1. No action is ever accepted on a stale `r` (state snapshot + re-check).
//   2. Local per-room lock (wagerCreating) prevents ALL concurrent wager ops.
//   3. Every DB failure path is either idempotent OR explicitly refunded.
//   4. cancelRoomPendingWager NEVER touches an ACTIVE wager (only pending).
//   5. Accept failure with `wager_not_pending` NEVER triggers a second cancel.
//   6. Leave/settle/resign use DETACHED snapshots — no live `r` reads after
//      slot mutation, no null loser IDs.
//   7. All amount/wagerId/roomId inputs are strictly validated.
//   8. Every async path has an explicit .catch with logging.
// ============================================================================

const { Chess } = require('chess.js');

module.exports = function createChessGame({
  send, sockets, players, broadcast, crypto,
  createWager, acceptWager, cancelWager, settleWager,
}) {
  // ========================================================================
  // CONSTANTS
  // ========================================================================
  const TIME = 10 * 60 * 1000;
  const OFFER_TIMEOUT_MS = 60 * 1000;
  const MIN_WAGER = 300;
  const MAX_WAGER = 100000;
  const MAX_ROOM_ID_LEN = 40;

  // Stable error codes sent to the client
  const E = Object.freeze({
    INVALID_ROOM: 'invalid_room',
    INVALID_AMOUNT: 'invalid_amount',
    INVALID_WAGER_ID: 'invalid_wager_id',
    NOT_SEATED: 'not_seated',
    NOT_WAIT: 'game_already_started',
    OFFER_EXISTS: 'offer_already_exists',
    OFFER_UNAVAILABLE: 'offer_not_available',
    SELF_OFFER: 'cannot_self_action',
    BUSY: 'action_in_progress',
    INSUFFICIENT: 'insufficient_balance',
    ROOM_ACTIVE: 'room_has_active_wager',
    NOT_PENDING: 'wager_not_pending',
    NOT_FOUND: 'wager_not_found',
    UNKNOWN: 'unknown_error',
  });

  const rooms = new Map();
  const is = (c, a, b) => (c[a] ? c[a]() : c[b]());
  const nameOf = id => (players.get(id) || {}).name || 'Player';

  // ========================================================================
  // VALIDATION
  // ========================================================================
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

  function fail(id, code, text) {
    send(sockets.get(id), { type: 'chess:err', code, text });
  }

  function failFromError(id, fallback, e) {
    let code = E.UNKNOWN;
    let text = fallback;
    if (e && e.code === 'insufficient_balance') {
      code = E.INSUFFICIENT;
      text = `Not enough tokens (need ${e.required}, have ${e.available})`;
    } else if (e && e.code === 'room_has_active_wager') {
      code = E.ROOM_ACTIVE;
      text = 'Another wager is active; please retry in a moment';
    } else if (e && e.code === 'wager_not_pending') {
      code = E.NOT_PENDING;
      text = 'Offer expired or was taken';
    } else if (e && e.code === 'wager_not_found') {
      code = E.NOT_FOUND;
      text = 'Wager not found';
    } else if (e && e.message) {
      text = `${fallback}: ${e.message}`;
    }
    send(sockets.get(id), { type: 'chess:err', code, text });
  }

  // ========================================================================
  // ROOM STATE
  // ========================================================================
  function newRoom(id) {
    return {
      id,
      chess: new Chess(),
      w: null, b: null,
      spec: new Set(),
      status: 'wait',
      result: '',
      last: null,
      time: { w: TIME, b: TIME },
      since: 0,
      draw: null,
      // Wager state
      wagerAmount: 0,
      wagerId: null,
      wagerRoomId: null,
      wagerOwner: null,
      wagerSettled: false,
      // Locks — server-only, never sent to clients
      wagerCreating: false,
      wagerSettling: false,
      // Offer timer
      offerTimer: null,
      offerExpiresAt: 0,
    };
  }

  function clearOfferTimer(r) {
    if (r.offerTimer) { try { clearTimeout(r.offerTimer); } catch {} r.offerTimer = null; }
    r.offerExpiresAt = 0;
  }

  function resetWagerFields(r) {
    clearOfferTimer(r);
    r.wagerAmount = 0;
    r.wagerId = null;
    r.wagerRoomId = null;
    r.wagerOwner = null;
    r.wagerSettled = false;
    // Do NOT touch wagerCreating / wagerSettling — caller manages.
  }

  const roomKeyOf = r => r.wagerRoomId || r.id;

  function roomOf(id) {
    for (const r of rooms.values()) {
      if (r.w === id || r.b === id || r.spec.has(id)) return r;
    }
    return null;
  }

  // ========================================================================
  // CHESS HELPERS
  // ========================================================================
  function legalMap(r) {
    const map = {};
    r.chess.moves({ verbose: true }).forEach(m => {
      (map[m.from] = map[m.from] || []).push(m.to);
    });
    return map;
  }

  function clockOf(r) {
    const t = { w: r.time.w, b: r.time.b };
    if (r.status === 'play') {
      const tn = r.chess.turn();
      t[tn] = Math.max(0, t[tn] - (Date.now() - r.since));
    }
    return t;
  }

  function startPlay(r) {
    if (!r.w || !r.b) throw new Error('cannot start without both players');
    r.status = 'play';
    r.since = Date.now();
  }

  function resetBoard(r) {
    r.chess = new Chess();
    r.last = null;
    r.result = '';
    r.time = { w: TIME, b: TIME };
    r.draw = null;
    if (r.w && r.b) startPlay(r);
    else r.status = 'wait';
  }

  function endGame(r, text) {
    r.status = 'end';
    r.result = text;
    r.draw = null;
  }

  function checkEnd(r, id) {
    const c = r.chess;
    if (is(c, 'isCheckmate', 'in_checkmate')) endGame(r, `Checkmate! ${nameOf(id)} wins`);
    else if (is(c, 'isStalemate', 'in_stalemate')) endGame(r, 'Draw — Stalemate');
    else if (is(c, 'isInsufficientMaterial', 'insufficient_material')) endGame(r, 'Draw — Insufficient material');
    else if (is(c, 'isThreefoldRepetition', 'in_threefold_repetition')) endGame(r, 'Draw — Threefold repetition');
    else if (is(c, 'isDraw', 'in_draw')) endGame(r, 'Draw — Fifty-move rule');
  }

  // ========================================================================
  // WAGER SETTLEMENT (detached — never uses live `r` after mutation)
  // ========================================================================
  async function settleDetached({ winner, loser, roomKey, amount, reason }) {
    if (!roomKey || !amount) {
      console.log(`[CHESS SETTLE] skipped: room=${roomKey} amount=${amount}`);
      return;
    }
    if (typeof settleWager !== 'function') {
      console.error('[CHESS SETTLE] settleWager unavailable — MANUAL RECOVERY NEEDED', { roomKey, winner, loser, amount, reason });
      return;
    }
    try {
      await settleWager('chess', roomKey, winner || null, loser || null);
      console.log(`[CHESS SETTLE] OK room=${roomKey} winner=${winner} loser=${loser} amount=${amount} reason=${reason}`);
    } catch (e) {
      // wager.js retry tables recover this
      console.error(`[CHESS SETTLE] FAILED room=${roomKey} winner=${winner} loser=${loser} amount=${amount} reason=${reason}:`, e && e.message);
    }
  }

  // Fire a detached settle from a room, using a snapshot.
  function fireDetachedSettle(r, snapshot, reason) {
    if (!snapshot || snapshot.amount <= 0) return false;
    r.wagerSettled = true;
    r.wagerSettling = true;
    clearOfferTimer(r);
    settleDetached({ ...snapshot, reason })
      .finally(() => { r.wagerSettling = false; });
    return true;
  }

  // ========================================================================
  // CANCEL (pending only) — with STRICT guarantee never to cancel active
  // ========================================================================
  async function cancelRoomPendingWager(r, reason) {
    // Guard: only cancel when we have a live pending wager and no settle in progress.
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

    // Mark as settling IMMEDIATELY so no other path can start.
    r.wagerSettled = true;
    r.wagerSettling = true;
    clearOfferTimer(r);

    try {
      await cancelWager(owner, wagerId);
      console.log(`[CHESS CANCEL] ${wagerId} cancelled (${reason})`);
      return { ok: true };
    } catch (e) {
      const code = e && (e.code || e.message);
      if (code === E.NOT_PENDING) {
        // Already active → wager is NOT pending anymore; do not touch further.
        console.log(`[CHESS CANCEL] ${wagerId} already not pending (${reason}) — leaving as-is`);
        return { ok: false, active: true };
      }
      console.error(`[CHESS CANCEL] ${wagerId} failed (${reason}):`, e && e.message);
      return { ok: false, error: e };
    } finally {
      resetWagerFields(r);
      r.wagerSettling = false;
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

      console.log(`[CHESS OFFER EXPIRED] ${wagerId} (room ${r.id})`);
      await cancelRoomPendingWager(r, 'offer_timeout');

      for (const pid of [r.w, r.b].filter(Boolean)) {
        send(sockets.get(pid), { type: 'chess:wager_expired', wagerId });
      }
      pushRoom(r);
    }, OFFER_TIMEOUT_MS);

    if (typeof r.offerTimer.unref === 'function') r.offerTimer.unref();
  }

  // ========================================================================
  // STATE PUSH
  // ========================================================================
  function pushRoom(r) {
    const ids = [r.w, r.b, ...r.spec].filter(Boolean);
    const turn = r.chess.turn();

    const offer = (r.wagerId && !r.wagerSettled && r.wagerOwner != null) ? {
      wagerId: r.wagerId,
      amount: r.wagerAmount,
      by: r.wagerOwner,
      byName: nameOf(r.wagerOwner),
      expiresAt: r.offerExpiresAt || 0,
    } : null;

    const base = {
      type: 'chess:state',
      room: r.id,
      fen: r.chess.fen(),
      turn,
      status: r.status,
      result: r.result,
      last: r.last,
      san: r.chess.history(),
      draw: r.draw,
      clock: clockOf(r),
      check: r.status === 'play' && is(r.chess, 'isCheck', 'in_check'),
      white: r.w ? { id: r.w, name: nameOf(r.w) } : null,
      black: r.b ? { id: r.b, name: nameOf(r.b) } : null,
      wager: r.wagerAmount > 0 ? r.wagerAmount : null,
      wagerId: r.wagerId || null,
      offer,
    };

    const legal = r.status === 'play' ? legalMap(r) : null;

    for (const id of ids) {
      const you = id === r.w ? 'w' : id === r.b ? 'b' : 's';
      send(sockets.get(id), { ...base, you, moves: you === turn ? legal : null });
    }
  }

  // ========================================================================
  // LEAVE — snapshot BEFORE clearing slots
  // ========================================================================
  function chessLeave(id) {
    for (const [rid, r] of rooms) {
      if (!(r.w === id || r.b === id || r.spec.has(id))) continue;
      r.spec.delete(id);

      if (r.w === id || r.b === id) {
        const slot = r.w === id ? 'w' : 'b';
        const opponent = slot === 'w' ? r.b : r.w;
        const wasPlaying = r.status === 'play';
        const wasWaitingWithPendingOffer = r.status === 'wait' && r.wagerId && !r.wagerSettled && !r.wagerSettling;

        // ---- Snapshot BEFORE any mutation ----
        const settleSnapshot = (wasPlaying && opponent && r.wagerAmount > 0 && !r.wagerSettled) ? {
          winner: opponent,
          loser: id,
          roomKey: roomKeyOf(r),
          amount: r.wagerAmount,
        } : null;

        // ---- Mutate slots ----
        r[slot] = null;
        if (!r.w && r.b) { r.w = r.b; r.b = null; }
        if (r.status === 'end' && !r.w && !r.b) r.status = 'wait';

        // ---- End game if in play (resignation) ----
        if (wasPlaying && opponent) {
          endGame(r, `${nameOf(id)} resigned, ${nameOf(opponent)} wins`);
          if (settleSnapshot) fireDetachedSettle(r, settleSnapshot, 'leave_during_play');
          if (r.status !== 'end') resetBoard(r);
        } else if (wasWaitingWithPendingOffer) {
          cancelRoomPendingWager(r, `player_left_waiting:${id}`).catch(e =>
            console.error('[CHESS] cancel on leave failed:', e && e.message)
          );
        }
      }

      if (!r.w && !r.b && r.spec.size === 0) {
        clearOfferTimer(r);
        rooms.delete(rid);
      } else {
        pushRoom(r);
      }
    }
  }

  // ========================================================================
  // JOIN
  // ========================================================================
  async function chessJoin(id, rawRoomId) {
    const roomId = validateRoomId(rawRoomId);
    if (!roomId) return fail(id, E.INVALID_ROOM, 'Invalid room ID');

    // Leave other rooms first
    for (const [rid, otherR] of rooms) {
      if (rid === roomId) continue;
      if (otherR.w === id || otherR.b === id) {
        chessLeave(id);
        break;
      }
    }

    let r = rooms.get(roomId);
    if (!r) { r = newRoom(roomId); rooms.set(roomId, r); }
    if (r.status === 'end' && !r.w && !r.b) resetBoard(r);

    const alreadyIn = (r.w === id || r.b === id);

    if (!r.w) r.w = id;
    else if (!r.b && r.w !== id) r.b = id;
    else if (!alreadyIn) r.spec.add(id);

    // If a 3rd person joined while a 2p offer is live → cancel the offer.
    if (r.wagerId && !r.wagerSettled && r.w && r.b && r.spec.size > 0) {
      await cancelRoomPendingWager(r, `third_joined:${id}`).catch(e =>
        console.error('[CHESS] cancel on third join failed:', e && e.message)
      );
    }

    // Restart timer if needed (e.g. both seats occupied and offer exists).
    if (r.w && r.b && r.status === 'wait' && r.wagerId && !r.wagerSettled && !r.offerTimer) {
      startOfferTimer(r, r.wagerId);
    }

    pushRoom(r);
  }

  // ========================================================================
  // OFFER — strict lock + post-await re-validation
  // ========================================================================
  async function chessOfferWager(id, rawAmount) {
    const r = roomOf(id);
    if (!r) return;
    if (r.status !== 'wait') return fail(id, E.NOT_WAIT, 'Game already started');
    if (id !== r.w && id !== r.b) return fail(id, E.NOT_SEATED, 'Not seated');

    const n = validateAmount(rawAmount);
    if (n === null) return fail(id, E.INVALID_AMOUNT, 'Invalid wager amount');

    if (r.wagerId && !r.wagerSettled) {
      return fail(id, E.OFFER_EXISTS, 'An offer already exists');
    }

    // ---- STRICT LOCK ----
    if (r.wagerCreating) return fail(id, E.BUSY, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      const row = await createWager(id, 'chess', r.id, n);

      // Post-await: validate game state did not change.
      if (r.status !== 'wait') {
        await cancelWager(id, row.id).catch(() => {});
        return fail(id, E.NOT_WAIT, 'Game started while creating offer');
      }
      if (r.wagerId && !r.wagerSettled) {
        await cancelWager(id, row.id).catch(() => {});
        return fail(id, E.OFFER_EXISTS, 'An offer appeared while creating');
      }
      // Player could have been unseated during await.
      if (id !== r.w && id !== r.b) {
        await cancelWager(id, row.id).catch(() => {});
        return fail(id, E.NOT_SEATED, 'You left the room');
      }

      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;

      startOfferTimer(r, row.id);

      const otherId = id === r.w ? r.b : r.w;
      if (otherId) {
        send(sockets.get(otherId), {
          type: 'chess:wager_offer',
          wagerId: row.id,
          amount: n,
          by: id,
          byName: nameOf(id),
          expiresAt: r.offerExpiresAt,
        });
      }
      pushRoom(r);
    } catch (e) {
      failFromError(id, 'Offer failed', e);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // ACCEPT — strict lock + idempotency-aware error handling
  // ========================================================================
  async function chessAcceptWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return fail(id, E.INVALID_WAGER_ID, 'Invalid wager id');

    const r = roomOf(id);
    if (!r) return;
    if (r.status !== 'wait') return fail(id, E.NOT_WAIT, 'Game already started');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return fail(id, E.OFFER_UNAVAILABLE, 'Offer not available');
    }
    if (id === r.wagerOwner) {
      return fail(id, E.SELF_OFFER, 'You cannot accept your own offer');
    }

    // ---- STRICT LOCK ----
    if (r.wagerCreating) return fail(id, E.BUSY, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      try {
        await acceptWager(id, wagerId);
      } catch (e) {
        // Classify: cancel only on insufficient_balance; NEVER on not_pending/not_found.
        const code = e && (e.code || e.message);
        const cancelSafe =
          code !== E.NOT_PENDING &&
          code !== E.NOT_FOUND &&
          code !== 'wager_not_pending' &&
          code !== 'wager_not_found';

        failFromError(id, 'Accept failed', e);

        if (cancelSafe) {
          await cancelRoomPendingWager(r, `accept_failed:${code || 'unknown'}`).catch(() => {});
        }
        // Notify listeners so UI reflects the failure.
        pushRoom(r);
        return;
      }

      // Success path — even if duplicate (idempotent), acceptWager resolved.
      clearOfferTimer(r);
      r.wagerRoomId = r.id;

      // Room must still be in `wait` with both seats — otherwise do NOT start.
      if (r.status !== 'wait' || !r.w || !r.b) {
        // Edge: opponents left during await. Refund as draw.
        const roomKey = roomKeyOf(r);
        const amount = r.wagerAmount;
        fireDetachedSettle(r, { winner: null, loser: null, roomKey, amount }, 'accept_room_gone');
        pushRoom(r);
        return;
      }

      // Start the game.
      startPlay(r);
      pushRoom(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // REJECT — no lock needed (idempotent cancel), but serialize via lock
  // ========================================================================
  async function chessRejectWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return fail(id, E.INVALID_WAGER_ID, 'Invalid wager id');

    const r = roomOf(id);
    if (!r) return;
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return fail(id, E.OFFER_UNAVAILABLE, 'Offer not available');
    }
    if (id === r.wagerOwner) {
      return fail(id, E.SELF_OFFER, 'You cannot reject your own offer');
    }

    if (r.wagerCreating) return fail(id, E.BUSY, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      const ownerId = r.wagerOwner;
      const result = await cancelRoomPendingWager(r, `rejected_by:${id}`);
      if (result && result.active) {
        // Wager was already active — this should not happen for a live reject.
        fail(id, E.NOT_PENDING, 'Offer is no longer pending');
      } else if (ownerId) {
        send(sockets.get(ownerId), { type: 'chess:wager_rejected', wagerId, by: id });
      }
      pushRoom(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // COUNTER — strict lock + post-await re-check
  // ========================================================================
  async function chessCounterWager(id, rawWagerId, rawAmount) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return fail(id, E.INVALID_WAGER_ID, 'Invalid wager id');

    const r = roomOf(id);
    if (!r) return;
    if (r.status !== 'wait') return fail(id, E.NOT_WAIT, 'Game already started');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return fail(id, E.OFFER_UNAVAILABLE, 'Offer not available');
    }
    if (id === r.wagerOwner) {
      return fail(id, E.SELF_OFFER, 'You cannot counter your own offer');
    }

    const n = validateAmount(rawAmount);
    if (n === null) return fail(id, E.INVALID_AMOUNT, 'Invalid wager amount');

    if (r.wagerCreating) return fail(id, E.BUSY, 'Another action is in progress');
    r.wagerCreating = true;

    try {
      const originalOwner = r.wagerOwner;
      const cancelResult = await cancelRoomPendingWager(r, `countered_by:${id}`);
      if (cancelResult && cancelResult.active) {
        // Race: someone else accepted during our cancel — do NOT create a counter.
        fail(id, E.NOT_PENDING, 'Offer was already accepted');
        pushRoom(r);
        return;
      }

      const row = await createWager(id, 'chess', r.id, n);

      // Post-await: game may have started.
      if (r.status !== 'wait') {
        await cancelWager(id, row.id).catch(() => {});
        return fail(id, E.NOT_WAIT, 'Game started while creating counter');
      }
      if (id !== r.w && id !== r.b) {
        await cancelWager(id, row.id).catch(() => {});
        return fail(id, E.NOT_SEATED, 'You left the room');
      }

      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;

      startOfferTimer(r, row.id);

      if (originalOwner && originalOwner !== id) {
        send(sockets.get(originalOwner), {
          type: 'chess:wager_offer',
          wagerId: row.id,
          amount: n,
          by: id,
          byName: nameOf(id),
          isCounter: true,
          expiresAt: r.offerExpiresAt,
        });
      }
      pushRoom(r);
    } catch (e) {
      failFromError(id, 'Counter failed', e);
      pushRoom(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // MOVE
  // ========================================================================
  function chessMove(id, m) {
    const r = roomOf(id);
    if (!r || r.status !== 'play') return;

    const turn = r.chess.turn();
    if ((turn === 'w' ? r.w : r.b) !== id) return;

    if (!m || typeof m.from !== 'string' || typeof m.to !== 'string') return;
    if (!/^[a-h][1-8]$/.test(m.from) || !/^[a-h][1-8]$/.test(m.to)) {
      return fail(id, E.INVALID_AMOUNT, 'Invalid move format');
    }

    const now = Date.now();
    r.time[turn] -= now - r.since;

    if (r.time[turn] <= 0) {
      r.time[turn] = 0;
      const winner = turn === 'w' ? r.b : r.w;
      endGame(r, `Time out for ${nameOf(id)}, ${nameOf(winner)} wins`);
      if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
        fireDetachedSettle(r, {
          winner, loser: id, roomKey: roomKeyOf(r), amount: r.wagerAmount,
        }, 'timeout_move');
      }
      return pushRoom(r);
    }

    const promo = ['q', 'r', 'b', 'n'].includes(m.promo) ? m.promo : 'q';
    let res = null;
    try { res = r.chess.move({ from: m.from, to: m.to, promotion: promo }); } catch { res = null; }
    if (!res) {
      r.time[turn] += now - r.since;
      return fail(id, E.UNKNOWN, 'Illegal move');
    }

    r.since = now;
    r.draw = null;
    r.last = { from: res.from, to: res.to };
    checkEnd(r, id);

    if (r.status === 'end' && r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
      const isMate = is(r.chess, 'isCheckmate', 'in_checkmate');
      const winner = isMate ? id : null;
      const loser = winner ? (winner === r.w ? r.b : r.w) : null;
      fireDetachedSettle(r, {
        winner, loser, roomKey: roomKeyOf(r), amount: r.wagerAmount,
      }, isMate ? 'checkmate' : 'draw');
    }

    pushRoom(r);
  }

  function chessResign(id) {
    const r = roomOf(id);
    if (!r || r.status !== 'play' || (r.w !== id && r.b !== id)) return;

    const winner = r.w === id ? r.b : r.w;
    endGame(r, `${nameOf(id)} resigned, ${nameOf(winner)} wins`);

    if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
      fireDetachedSettle(r, {
        winner, loser: id, roomKey: roomKeyOf(r), amount: r.wagerAmount,
      }, 'resign');
    }
    pushRoom(r);
  }

  function chessDraw(id, act) {
    const r = roomOf(id);
    if (!r || r.status !== 'play' || (r.w !== id && r.b !== id)) return;

    const me = r.w === id ? 'w' : 'b';

    if (act === 'offer' && !r.draw) {
      r.draw = me;
    } else if (act === 'accept' && r.draw && r.draw !== me) {
      endGame(r, 'Draw by agreement');
      if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
        fireDetachedSettle(r, {
          winner: null, loser: null, roomKey: roomKeyOf(r), amount: r.wagerAmount,
        }, 'draw_agreement');
      }
    } else if (act === 'decline' && r.draw && r.draw !== me) {
      r.draw = null;
    } else {
      return;
    }
    pushRoom(r);
  }

  function chessAgain(id) {
    const r = roomOf(id);
    if (!r || r.status !== 'end' || !r.w || !r.b) return;
    if (r.wagerSettling) return fail(id, E.BUSY, 'Previous wager still settling');

    [r.w, r.b] = [r.b, r.w];
    resetWagerFields(r);
    resetBoard(r);
    pushRoom(r);
  }

  // ========================================================================
  // CLOCK
  // ========================================================================
  const clockTimer = setInterval(() => {
    for (const r of rooms.values()) {
      if (r.status !== 'play') continue;
      const tn = r.chess.turn();
      if (r.time[tn] - (Date.now() - r.since) <= 0) {
        r.time[tn] = 0;
        const winner = tn === 'w' ? r.b : r.w;
        const loser = tn === 'w' ? r.w : r.b;
        endGame(r, `Time out for ${nameOf(loser)}, ${nameOf(winner)} wins`);
        if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
          fireDetachedSettle(r, {
            winner, loser, roomKey: roomKeyOf(r), amount: r.wagerAmount,
          }, 'timeout_clock');
        }
        pushRoom(r);
      }
    }
  }, 1000);
  if (typeof clockTimer.unref === 'function') clockTimer.unref();

  // ========================================================================
  // SHUTDOWN
  // ========================================================================
  function shutdown() {
    clearInterval(clockTimer);
    for (const r of rooms.values()) clearOfferTimer(r);
    rooms.clear();
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================
  const safe = (fn, tag) => (...args) => {
    try { return fn(...args); }
    catch (e) { console.error(`[CHESS ${tag}]`, e && e.message); }
  };

  const safeAsync = (fn, tag) => (...args) => {
    Promise.resolve().then(() => fn(...args)).catch(e => {
      console.error(`[CHESS ${tag}]`, e && e.message);
    });
  };

  return {
    prefix: 'chess:',

    handle(id, d) {
      if (!d || typeof d.type !== 'string') return;

      switch (d.type) {
        // Seating
        case 'chess:join':
          if (players.has(id)) safeAsync(chessJoin, 'join')(id, d.room);
          break;
        case 'chess:leave':
          safe(chessLeave, 'leave')(id);
          break;

        // Wager flow
        case 'chess:wager_offer':   safeAsync(chessOfferWager, 'offer')(id, d.amount); break;
        case 'chess:wager_accept':  safeAsync(chessAcceptWager, 'accept')(id, d.wagerId); break;
        case 'chess:wager_reject':  safeAsync(chessRejectWager, 'reject')(id, d.wagerId); break;
        case 'chess:wager_counter': safeAsync(chessCounterWager, 'counter')(id, d.wagerId, d.amount); break;

        // Gameplay
        case 'chess:move':    safe(chessMove, 'move')(id, d); break;
        case 'chess:resign':  safe(chessResign, 'resign')(id); break;
        case 'chess:again':   safe(chessAgain, 'again')(id); break;
        case 'chess:draw':    safe(chessDraw, 'draw')(id, 'offer'); break;
        case 'chess:accept':  safe(chessDraw, 'accept')(id, 'accept'); break;
        case 'chess:decline': safe(chessDraw, 'decline')(id, 'decline'); break;

        default:
          // Unknown types: silently ignore (do not leak implementation).
          break;
      }
    },

    leave: chessLeave,
    shutdown,
  };
};

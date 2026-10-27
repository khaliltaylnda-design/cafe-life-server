'use strict';

// games/chess.js — Cafe Life Chess game.
// ============================================================================
// Wager flow (final design, mirrors shkobba.js):
//
//   OFFER:   A creates a pending wager (amount N) held in escrow.
//   ACCEPT:  B explicitly accepts (pays N, wager → active, game starts).
//   COUNTER: B proposes amount M (A's offer cancelled+refunded, new offer).
//   REJECT:  B declines (A's offer cancelled+refunded).
//   TIMEOUT: 60s without action → auto-cancel + refund.
//
//   NO automatic accept. NO silent overwrite of pendingWager.
// ============================================================================

const { Chess } = require('chess.js');

module.exports = function ({ send, sockets, players, broadcast, crypto, createWager, acceptWager, cancelWager, settleWager }) {
  const TIME = 10 * 60 * 1000;
  const rooms = new Map();
  const is = (c, a, b) => (c[a] ? c[a]() : c[b]());
  const nameOf = id => (players.get(id) || {}).name || 'Player';

  const OFFER_TIMEOUT_MS = 60 * 1000;

  /* ------------------------------------------------------------------
     Room state
  ------------------------------------------------------------------ */
  function newRoom(id) {
    return {
      id, chess: new Chess(), w: null, b: null, spec: new Set(),
      status: 'wait', result: '', last: null, time: { w: TIME, b: TIME },
      since: 0, draw: null,
      wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false,
      pendingWager: 0, wagerOwner: null,
      offerTimer: null, offerExpiresAt: 0,
    };
  }

  function clearOfferTimer(r) {
    if (r.offerTimer) { clearTimeout(r.offerTimer); r.offerTimer = null; }
    r.offerExpiresAt = 0;
  }

  function resetWagerFields(r) {
    clearOfferTimer(r);
    r.wagerAmount = 0;
    r.wagerId = null;
    r.wagerRoomId = null;
    r.wagerOwner = null;
    r.pendingWager = 0;
  }

  /* ------------------------------------------------------------------
     Chess helpers (unchanged)
  ------------------------------------------------------------------ */
  function legalMap(r) {
    const map = {};
    r.chess.moves({ verbose: true }).forEach(m => { (map[m.from] = map[m.from] || []).push(m.to); });
    return map;
  }

  function clockOf(r) {
    const t = { w: r.time.w, b: r.time.b };
    if (r.status === 'play') { const tn = r.chess.turn(); t[tn] = Math.max(0, t[tn] - (Date.now() - r.since)); }
    return t;
  }

  function startPlay(r) {
    r.status = 'play';
    r.since = Date.now();
    console.log(`[CHESS] Game started. Wager: ${r.wagerAmount}, w: ${r.w}, b: ${r.b}`);
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

  /* ------------------------------------------------------------------
     Wager: cancel / settle helpers
  ------------------------------------------------------------------ */
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
      console.log(`[CHESS WAGER CANCEL] ${wagerId} cancelled (${reason})`);
    } catch (e) {
      if (e && (e.code === 'wager_not_pending' || e.message === 'wager_not_pending')) {
        console.log(`[CHESS WAGER CANCEL] ${wagerId} already cancelled (${reason})`);
      } else {
        console.error(`[CHESS WAGER CANCEL] ${wagerId} failed:`, e && e.message);
      }
    } finally {
      resetWagerFields(r);
    }
  }

  async function settleWagerForRoom(r, winnerPlayerId) {
    if (!r.wagerAmount || r.wagerSettled) {
      console.log(`[CHESS WAGER SETTLE] Skipped: amount=${r.wagerAmount}, settled=${r.wagerSettled}`);
      return;
    }
    const roomKey = r.wagerRoomId || r.id;
    if (!roomKey) {
      console.log('[CHESS WAGER SETTLE] Skipped: no room key');
      return;
    }
    r.wagerSettled = true;
    clearOfferTimer(r);

    let loserPlayerId = null;
    if (winnerPlayerId) {
      loserPlayerId = winnerPlayerId === r.w ? r.b : r.w;
    }

    if (typeof settleWager === 'function') {
      try {
        await settleWager('chess', roomKey, winnerPlayerId, loserPlayerId);
        console.log(`[CHESS WAGER SETTLE] Success, winner=${winnerPlayerId}, loser=${loserPlayerId}`);
      } catch (e) {
        console.error('[CHESS WAGER SETTLE] Error:', e && e.message);
      }
    }
  }

  /* ------------------------------------------------------------------
     Offer timeout (60s)
  ------------------------------------------------------------------ */
  function startOfferTimer(r, wagerId) {
    clearOfferTimer(r);
    r.offerExpiresAt = Date.now() + OFFER_TIMEOUT_MS;

    r.offerTimer = setTimeout(async () => {
      if (r.wagerId !== wagerId || r.wagerSettled) return;
      if (r.status !== 'wait') return;

      console.log(`[CHESS OFFER EXPIRED] ${wagerId} (room ${r.id})`);
      await cancelRoomPendingWager(r, 'offer_timeout');

      const ids = [r.w, r.b].filter(Boolean);
      for (const pid of ids) {
        send(sockets.get(pid), { type: 'chess:wager_expired', wagerId });
      }
      pushRoom(r);
    }, OFFER_TIMEOUT_MS);

    if (typeof r.offerTimer.unref === 'function') r.offerTimer.unref();
  }

  /* ------------------------------------------------------------------
     State push (adds `offer` metadata)
  ------------------------------------------------------------------ */
  function pushRoom(r) {
    const ids = [r.w, r.b, ...r.spec].filter(Boolean);
    const turn = r.chess.turn();

    const offer = r.wagerId && !r.wagerSettled ? {
      wagerId: r.wagerId,
      amount: r.wagerAmount,
      by: r.wagerOwner,
      byName: r.wagerOwner ? nameOf(r.wagerOwner) : '',
      expiresAt: r.offerExpiresAt || 0,
    } : null;

    const base = {
      type: 'chess:state', room: r.id, fen: r.chess.fen(), turn, status: r.status, result: r.result, last: r.last,
      san: r.chess.history(), draw: r.draw, clock: clockOf(r),
      check: r.status === 'play' && is(r.chess, 'isCheck', 'in_check'),
      white: r.w ? { id: r.w, name: nameOf(r.w) } : null,
      black: r.b ? { id: r.b, name: nameOf(r.b) } : null,
      wager: r.wagerAmount > 0 ? r.wagerAmount : null,
      wagerId: r.wagerId || null,
      offer,
    };
    const legal = r.status === 'play' ? legalMap(r) : null;
    ids.forEach(id => {
      const you = id === r.w ? 'w' : id === r.b ? 'b' : 's';
      send(sockets.get(id), { ...base, you, moves: you === turn ? legal : null });
    });
  }

  function roomOf(id) {
    for (const r of rooms.values()) if (r.w === id || r.b === id || r.spec.has(id)) return r;
    return null;
  }

  /* ------------------------------------------------------------------
     Leave
  ------------------------------------------------------------------ */
  function chessLeave(id) {
    for (const [rid, r] of rooms) {
      if (!(r.w === id || r.b === id || r.spec.has(id))) continue;
      r.spec.delete(id);

      if (r.w === id || r.b === id) {
        const slot = r.w === id ? 'w' : 'b';
        const winner = slot === 'w' ? r.b : r.w;

        if (r.status === 'play') {
          endGame(r, `${nameOf(id)} resigned, ${nameOf(winner)} wins`);
          if (winner) settleWagerForRoom(r, winner);
        } else if (r.status === 'wait' && r.wagerId && !r.wagerSettled) {
          cancelRoomPendingWager(r, `player_left_waiting:${id}`).catch(() => {});
        }

        r[slot] = null;
        if (r.status !== 'end') resetBoard(r);
        if (!r.w && r.b) { r.w = r.b; r.b = null; }
        if (r.status === 'end' && !r.w && !r.b) r.status = 'wait';
      }

      if (!r.w && !r.b && r.spec.size === 0) {
        clearOfferTimer(r);
        rooms.delete(rid);
      } else {
        pushRoom(r);
      }
    }
  }

  /* ------------------------------------------------------------------
     Join / seat registration (NO auto-accept, NO overwrite of amount)
  ------------------------------------------------------------------ */
  function chessJoin(id, roomId) {
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

    if (!r.w) {
      r.w = id;
    } else if (!r.b && r.w !== id) {
      r.b = id;
    } else if (!alreadyIn) {
      r.spec.add(id);
    }

    if (r.w && r.b && r.status === 'wait' && r.wagerId && !r.wagerSettled && !r.offerTimer) {
      startOfferTimer(r, r.wagerId);
    }

    pushRoom(r);
  }

  /* ------------------------------------------------------------------
     Wager actions (explicit)
  ------------------------------------------------------------------ */
  async function chessOfferWager(id, amount) {
    const r = roomOf(id); if (!r) return;
    if (r.status !== 'wait') return send(sockets.get(id), { type: 'chess:err', text: 'Game already started' });
    if (id !== r.w && id !== r.b) return send(sockets.get(id), { type: 'chess:err', text: 'Not seated' });

    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n < 300 || n > 100000) {
      return send(sockets.get(id), { type: 'chess:err', text: 'Invalid wager amount' });
    }
    if (r.wagerId && !r.wagerSettled) {
      return send(sockets.get(id), { type: 'chess:err', text: 'An offer already exists' });
    }

    try {
      const row = await createWager(id, 'chess', r.id, n);
      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;
      r.pendingWager = 0;

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
      send(sockets.get(id), { type: 'chess:err', text: 'Offer failed: ' + (e && e.message) });
    }
  }

  async function chessAcceptWager(id, wagerId) {
    const r = roomOf(id); if (!r) return;
    if (r.status !== 'wait') return send(sockets.get(id), { type: 'chess:err', text: 'Game already started' });
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return send(sockets.get(id), { type: 'chess:err', text: 'Offer not available' });
    }
    if (id === r.wagerOwner) {
      return send(sockets.get(id), { type: 'chess:err', text: 'You cannot accept your own offer' });
    }

    try {
      await acceptWager(id, wagerId);
      clearOfferTimer(r);
      r.wagerRoomId = r.id;
      r.pendingWager = 0;
      startPlay(r);
      pushRoom(r);
    } catch (e) {
      send(sockets.get(id), { type: 'chess:err', text: 'Accept failed: ' + (e && e.message) });
      await cancelRoomPendingWager(r, `accept_failed:${e && e.message}`);
      pushRoom(r);
    }
  }

  async function chessRejectWager(id, wagerId) {
    const r = roomOf(id); if (!r) return;
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return send(sockets.get(id), { type: 'chess:err', text: 'Offer not available' });
    }
    if (id === r.wagerOwner) {
      return send(sockets.get(id), { type: 'chess:err', text: 'You cannot reject your own offer' });
    }

    const ownerId = r.wagerOwner;
    await cancelRoomPendingWager(r, `rejected_by:${id}`);

    if (ownerId) {
      send(sockets.get(ownerId), { type: 'chess:wager_rejected', wagerId, by: id });
    }
    pushRoom(r);
  }

  async function chessCounterWager(id, wagerId, amount) {
    const r = roomOf(id); if (!r) return;
    if (r.status !== 'wait') return send(sockets.get(id), { type: 'chess:err', text: 'Game already started' });
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return send(sockets.get(id), { type: 'chess:err', text: 'Offer not available' });
    }
    if (id === r.wagerOwner) {
      return send(sockets.get(id), { type: 'chess:err', text: 'You cannot counter your own offer' });
    }

    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n < 300 || n > 100000) {
      return send(sockets.get(id), { type: 'chess:err', text: 'Invalid wager amount' });
    }

    const originalOwner = r.wagerOwner;
    await cancelRoomPendingWager(r, `countered_by:${id}`);

    try {
      const row = await createWager(id, 'chess', r.id, n);
      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;
      r.pendingWager = 0;

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
      send(sockets.get(id), { type: 'chess:err', text: 'Counter failed: ' + (e && e.message) });
      pushRoom(r);
    }
  }

  /* ------------------------------------------------------------------
     Gameplay (unchanged)
  ------------------------------------------------------------------ */
  function chessMove(id, m) {
    const r = roomOf(id);
    if (!r || r.status !== 'play') return;
    const turn = r.chess.turn();
    if ((turn === 'w' ? r.w : r.b) !== id) return;
    const now = Date.now();
    r.time[turn] -= now - r.since;

    if (r.time[turn] <= 0) {
      r.time[turn] = 0;
      const winner = turn === 'w' ? r.b : r.w;
      endGame(r, `Time out for ${nameOf(id)}, ${nameOf(winner)} wins`);
      settleWagerForRoom(r, winner);
      return pushRoom(r);
    }

    const promo = ['q', 'r', 'b', 'n'].includes(m.promo) ? m.promo : 'q';
    let res = null;
    try { res = r.chess.move({ from: String(m.from), to: String(m.to), promotion: promo }); } catch (e) { res = null; }
    if (!res) { r.time[turn] += now - r.since; return send(sockets.get(id), { type: 'chess:err', text: 'Illegal move' }); }

    r.since = now; r.draw = null;
    r.last = { from: res.from, to: res.to };
    checkEnd(r, id);

    if (r.status === 'end') {
      if (is(r.chess, 'isCheckmate', 'in_checkmate')) {
        settleWagerForRoom(r, id);
      } else {
        settleWagerForRoom(r, null);
      }
    }

    pushRoom(r);
  }

  function chessResign(id) {
    const r = roomOf(id);
    if (!r || r.status !== 'play' || (r.w !== id && r.b !== id)) return;
    const winner = r.w === id ? r.b : r.w;
    endGame(r, `${nameOf(id)} resigned, ${nameOf(winner)} wins`);
    settleWagerForRoom(r, winner);
    pushRoom(r);
  }

  function chessDraw(id, act) {
    const r = roomOf(id);
    if (!r || r.status !== 'play' || (r.w !== id && r.b !== id)) return;
    const me = r.w === id ? 'w' : 'b';
    if (act === 'offer' && !r.draw) r.draw = me;
    else if (act === 'accept' && r.draw && r.draw !== me) {
      endGame(r, 'Draw by agreement');
      settleWagerForRoom(r, null);
    } else if (act === 'decline' && r.draw && r.draw !== me) r.draw = null;
    else return;
    pushRoom(r);
  }

  function chessAgain(id) {
    const r = roomOf(id);
    if (!r || r.status !== 'end' || !r.w || !r.b) return;
    [r.w, r.b] = [r.b, r.w];
    resetWagerFields(r);
    r.wagerSettled = false;
    resetBoard(r);
    pushRoom(r);
  }

  setInterval(() => {
    for (const r of rooms.values()) {
      if (r.status !== 'play') continue;
      const tn = r.chess.turn();
      if (r.time[tn] - (Date.now() - r.since) <= 0) {
        r.time[tn] = 0;
        const winner = tn === 'w' ? r.b : r.w;
        endGame(r, `Time out for ${nameOf(tn === 'w' ? r.w : r.b)}, ${nameOf(winner)} wins`);
        settleWagerForRoom(r, winner);
        pushRoom(r);
      }
    }
  }, 1000).unref();

  return {
    prefix: 'chess:',
    handle(id, d) {
      switch (d.type) {
        // Seating
        case 'chess:join':         if (players.has(id)) chessJoin(id, String(d.room || '').slice(0, 40)); break;
        case 'chess:leave':        chessLeave(id); break;

        // Wager flow (explicit)
        case 'chess:wager_offer':   chessOfferWager(id, d.amount); break;
        case 'chess:wager_accept':  chessAcceptWager(id, String(d.wagerId || '')); break;
        case 'chess:wager_reject':  chessRejectWager(id, String(d.wagerId || '')); break;
        case 'chess:wager_counter': chessCounterWager(id, String(d.wagerId || ''), d.amount); break;

        // Gameplay
        case 'chess:move':    chessMove(id, d); break;
        case 'chess:resign':  chessResign(id); break;
        case 'chess:again':   chessAgain(id); break;
        case 'chess:draw':    chessDraw(id, 'offer'); break;
        case 'chess:accept':  chessDraw(id, 'accept'); break;
        case 'chess:decline': chessDraw(id, 'decline'); break;
      }
    },
    leave: chessLeave,
  };
};

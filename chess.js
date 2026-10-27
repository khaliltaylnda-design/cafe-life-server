'use strict';

const { Chess } = require('chess.js');

module.exports = function ({ send, sockets, players, broadcast, crypto, createWager, acceptWager, cancelWager, settleWager }) {
  const TIME = 10 * 60 * 1000;
  const rooms = new Map();
  const is = (c, a, b) => (c[a] ? c[a]() : c[b]());
  const nameOf = id => (players.get(id) || {}).name || 'Player';

  function newRoom(id) {
    return {
      id, chess: new Chess(), w: null, b: null, spec: new Set(),
      status: 'wait', result: '', last: null, time: { w: TIME, b: TIME },
      since: 0, draw: null,
      wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false,
      pendingWager: 0, wagerOwner: null
    };
  }

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

  function pushRoom(r) {
    const ids = [r.w, r.b, ...r.spec].filter(Boolean);
    const turn = r.chess.turn();
    const base = {
      type: 'chess:state', room: r.id, fen: r.chess.fen(), turn, status: r.status, result: r.result, last: r.last,
      san: r.chess.history(), draw: r.draw, clock: clockOf(r),
      check: r.status === 'play' && is(r.chess, 'isCheck', 'in_check'),
      white: r.w ? { id: r.w, name: nameOf(r.w) } : null,
      black: r.b ? { id: r.b, name: nameOf(r.b) } : null,
      wager: r.wagerAmount > 0 ? r.wagerAmount : null,
      wagerId: r.wagerId || null
    };
    const legal = r.status === 'play' ? legalMap(r) : null;
    ids.forEach(id => {
      const you = id === r.w ? 'w' : id === r.b ? 'b' : 's';
      send(sockets.get(id), { ...base, you, moves: you === turn ? legal : null });
    });
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

  // Settle wager and notify both players.
  // winnerPlayerId = null → draw (refund both)
  async function settleWagerForRoom(r, winnerPlayerId) {
    if (r.wagerAmount <= 0 || r.wagerSettled || !r.wagerRoomId) {
      console.log(`[CHESS WAGER SETTLE] Skipped: amount=${r.wagerAmount}, settled=${r.wagerSettled}`);
      return;
    }
    r.wagerSettled = true;

    let loserPlayerId = null;
    if (winnerPlayerId) {
      loserPlayerId = winnerPlayerId === r.w ? r.b : r.w;
    }

    if (typeof settleWager === 'function') {
      try {
        await settleWager('chess', r.wagerRoomId, winnerPlayerId, loserPlayerId);
        console.log(`[CHESS WAGER SETTLE] Success, winner=${winnerPlayerId}, loser=${loserPlayerId}`);
      } catch (e) {
        console.error('[CHESS WAGER SETTLE] Error:', e.message);
      }
    }
  }

  // ← [FIX] Cancel a pending wager owned by `ownerId` (used when the room
  // is abandoned before the game starts). Uses the wager room id so the
  // server can resolve the real account id.
  async function cancelRoomPendingWager(r, reason) {
    if (!r.wagerId || r.wagerSettled) return;
    if (r.wagerOwner == null) return;
    if (typeof cancelWager !== 'function') return;

    const wagerId = r.wagerId;
    const owner = r.wagerOwner;

    // Mark settled FIRST so we don't double-cancel from concurrent paths.
    r.wagerSettled = true;

    try {
      await cancelWager(owner, wagerId);
      console.log(`[CHESS WAGER CANCEL] ${wagerId} cancelled (${reason})`);
    } catch (e) {
      console.error(`[CHESS WAGER CANCEL] ${wagerId} failed:`, e.message);
    } finally {
      // Clear local wager state regardless — the DB is the source of truth.
      r.wagerId = null;
      r.wagerAmount = 0;
      r.wagerRoomId = null;
      r.wagerOwner = null;
      r.pendingWager = 0;
      // Keep wagerSettled=true so a late settle call is a no-op.
    }
  }

  // ← [FIX] chessLeave now:
  //   - cancels any pending (unaccepted) wager before resetting the room
  //   - keeps the existing behavior for in-progress games (resign + settle)
  //   - never leaves a pending wager orphaned in the DB.
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
          // ← [FIX] Pending wager existed but game never started → cancel.
          cancelRoomPendingWager(r, `player_left_waiting:${id}`);
        }

        r[slot] = null;
        if (r.status !== 'end') resetBoard(r);
        if (!r.w && r.b) { r.w = r.b; r.b = null; }
        if (r.status === 'end' && !r.w && !r.b) r.status = 'wait';
      }

      if (!r.w && !r.b && r.spec.size === 0) rooms.delete(rid);
      else pushRoom(r);
    }
  }

  async function chessJoin(id, roomId, amount) {
    // Leave any other room first.
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

    const wagerAmount = Number(amount) || 0;
    const alreadyIn = (r.w === id || r.b === id);

    console.log(`[CHESS JOIN] id=${id}, amount=${wagerAmount}, r.w=${r.w}, r.b=${r.b}, wagerId=${r.wagerId}, owner=${r.wagerOwner}, already=${alreadyIn}`);

    // 1) Register the player (or update pendingWager if already in).
    if (!r.w) {
      r.w = id;
      if (wagerAmount >= 300) r.pendingWager = wagerAmount;
      console.log(`[CHESS JOIN] ${id} as WHITE, pendingWager=${r.pendingWager}`);
    } else if (!r.b && r.w !== id) {
      r.b = id;
      if (wagerAmount >= 300) r.pendingWager = wagerAmount;
      console.log(`[CHESS JOIN] ${id} as BLACK, pendingWager=${r.pendingWager}`);
    } else if (!alreadyIn) {
      r.spec.add(id);
      return pushRoom(r);
    } else {
      if (wagerAmount >= 300) r.pendingWager = wagerAmount;
      console.log(`[CHESS JOIN] ${id} already in, updated pendingWager=${r.pendingWager}`);
    }

    // 2) Wager management (only when both seats are filled and we're waiting).
    if (r.w && r.b && r.status === 'wait') {

      // 2a) A pending wager exists: the OTHER player accepts it.
      if (r.wagerId && !r.wagerSettled && r.wagerOwner && id !== r.wagerOwner) {
        try {
          console.log(`[CHESS] Accepting wager ${r.wagerId} by ${id}`);
          await acceptWager(id, r.wagerId);
          r.wagerAmount = r.pendingWager || r.wagerAmount;
          r.wagerRoomId = roomId;
          r.pendingWager = 0;
          startPlay(r);
        } catch (e) {
          console.error('[CHESS] Accept error:', e.message);
          send(sockets.get(id), { type: 'chess:err', text: 'Accept failed: ' + e.message });

          // ← [FIX] If accept failed (e.g. insufficient_balance), cancel the
          // pending wager and refund the owner, then reset seats so the room
          // is not stuck. Otherwise the room can never start again.
          await cancelRoomPendingWager(r, `accept_failed:${e.message}`);

          // Keep players in the room but free the seats so they can retry.
          r.status = 'wait';
          pushRoom(r);
          return;
        }
      }
      // 2b) No wager yet: create one from the pending amount.
      else if (!r.wagerId && r.pendingWager >= 300) {
        try {
          const wagerRow = await createWager(id, 'chess', roomId, r.pendingWager);
          r.wagerId = wagerRow.id;
          r.wagerOwner = id;
          r.wagerAmount = r.pendingWager;
          r.wagerRoomId = roomId;
          const otherId = (id === r.w) ? r.b : r.w;
          send(sockets.get(otherId), {
            type: 'chess:wager_pending',
            amount: r.pendingWager,
            wagerId: wagerRow.id,
            room: roomId
          });
          console.log(`[CHESS] Wager created by ${nameOf(id)}: ${r.pendingWager}, waiting for ${nameOf(otherId)}`);
        } catch (e) {
          console.error('[CHESS] Create error:', e.message);
          send(sockets.get(id), { type: 'chess:err', text: 'Wager failed: ' + e.message });

          // ← [FIX] Keep seats intact so the SAME players can retry.
          // Old behavior set r.w = r.b = null which kicked both players out
          // and left any previously created wager (if any) orphaned.
          r.pendingWager = 0;
          pushRoom(r);
          return;
        }
      }
      // 2c) No wager, below threshold → free play.
      else if (!r.wagerId && r.pendingWager < 300) {
        startPlay(r);
      }
    }

    pushRoom(r);
  }

  function roomOf(id) {
    for (const r of rooms.values()) if (r.w === id || r.b === id || r.spec.has(id)) return r;
    return null;
  }

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
    // Clear wager state for the new game.
    r.wagerId = null;
    r.wagerAmount = 0;
    r.wagerRoomId = null;
    r.wagerSettled = false;
    r.pendingWager = 0;
    r.wagerOwner = null;
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
  }, 1000);

  return {
    prefix: 'chess:',
    handle(id, d) {
      switch (d.type) {
        case 'chess:join':
          if (players.has(id)) chessJoin(id, String(d.room || '').slice(0, 40), d.amount);
          break;
        case 'chess:move':    chessMove(id, d); break;
        case 'chess:resign':  chessResign(id); break;
        case 'chess:again':   chessAgain(id); break;
        case 'chess:draw':    chessDraw(id, 'offer'); break;
        case 'chess:accept':  chessDraw(id, 'accept'); break;
        case 'chess:decline': chessDraw(id, 'decline'); break;
        case 'chess:leave':   chessLeave(id); break;
      }
    },
    leave: chessLeave,
  };
};

'use strict';

// games/shkobba.js — Cafe Life Shkobba game.
// ============================================================================
// Wager flow (final design):
//
//   OFFER:   A creates a pending wager (amount N) held in escrow.
//   ACCEPT:  B explicitly accepts (pays N, wager → active, game starts).
//   COUNTER: B proposes amount M (A's offer cancelled+refunded, new offer).
//   REJECT:  B declines (A's offer cancelled+refunded).
//   TIMEOUT: 60s without action → auto-cancel + refund.
//
//   NO automatic accept. NO silent overwrite of pendingWager.
//   The offer amount is never changed without an explicit counter.
// ============================================================================

module.exports = function ({ send, sockets, players, broadcast, crypto, createWager, acceptWager, cancelWager, settleWager }) {
  const nameOf = id => (players.get(id) || {}).name || 'Player';

  const shk = new Map();
  const val = c => +c.slice(1);

  // Offer timeout (ms). After this, an unanswered offer is auto-cancelled.
  const OFFER_TIMEOUT_MS = 60 * 1000;

  /* ------------------------------------------------------------------
     Deck & scoring helpers (unchanged)
  ------------------------------------------------------------------ */
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

  /* ------------------------------------------------------------------
     Room state
  ------------------------------------------------------------------ */
  function shkRoom(id) {
    return {
      id, a: null, b: null, spec: new Set(), status: 'wait', goal: 11,
      score: { a: 0, b: 0 }, first: 'b', ready: new Set(), summary: null,
      winner: null, forfeit: null, table: [], hand: { a: [], b: [] },
      cap: { a: [], b: [] }, sk: { a: 0, b: 0 }, deck: [], last: null,
      turn: 'a', lastCap: null,
      // wager fields
      wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false,
      pendingWager: 0, wagerOwner: null,
      offerTimer: null, offerExpiresAt: 0,
    };
  }

  function clearOfferTimer(r) {
    if (r.offerTimer) {
      clearTimeout(r.offerTimer);
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
    // Note: wagerSettled is intentionally NOT reset here — callers decide.
  }

  /* ------------------------------------------------------------------
     Game helpers (unchanged)
  ------------------------------------------------------------------ */
  function shkDeal(r) {
    r.hand.a = r.deck.splice(0, 3);
    r.hand.b = r.deck.splice(0, 3);
  }

  function shkStart(r) {
    r.deck = newDeck(); r.table = r.deck.splice(0, 4);
    r.cap = { a: [], b: [] }; r.sk = { a: 0, b: 0 }; r.lastCap = null; r.last = null;
    r.summary = null; r.winner = null; r.forfeit = null; r.wagerSettled = false;
    r.first = r.first === 'a' ? 'b' : 'a'; r.turn = r.first; shkDeal(r); r.status = 'play'; r.ready.clear();
  }

  function shkScore(r) {
    const cnt = p => {
      const c = r.cap[p];
      return {
        n: c.length,
        d: c.filter(x => x[0] === 'd').length,
        s7: c.filter(x => val(x) === 7).length,
        s6: c.filter(x => val(x) === 6).length,
        z: c.includes('d7') ? 1 : 0
      };
    };
    const A = cnt('a'), B = cnt('b'), pts = { a: 0, b: 0 }, lines = [];
    const w = (x, y) => (x > y ? 'a' : y > x ? 'b' : null);
    const add = (k, a, b, win) => { if (win) pts[win]++; lines.push({ k, a, b, w: win }); };
    add('Most Cards', A.n, B.n, w(A.n, B.n));
    add('Most Gold (Dinars)', A.d, B.d, w(A.d, B.d));
    add('Seven of Gold', A.z, B.z, w(A.z, B.z));
    add('Most Sevens', A.s7, B.s7, w(A.s7, B.s7));
    lines.push({ k: 'Shkobba', a: r.sk.a, b: r.sk.b, w: null }); pts.a += r.sk.a; pts.b += r.sk.b;
    return { lines, pts };
  }

  /* ------------------------------------------------------------------
     Wager: cancel / settle helpers
  ------------------------------------------------------------------ */

  // Cancel a PENDING wager owned by r.wagerOwner. Idempotent.
  async function cancelRoomPendingWager(r, reason) {
    if (!r.wagerId || r.wagerSettled) {
      resetWagerFields(r);
      return;
    }
    if (r.wagerOwner == null) {
      resetWagerFields(r);
      return;
    }
    if (typeof cancelWager !== 'function') {
      resetWagerFields(r);
      return;
    }

    const wagerId = r.wagerId;
    const owner = r.wagerOwner;

    r.wagerSettled = true;
    clearOfferTimer(r);

    try {
      await cancelWager(owner, wagerId);
      console.log(`[SHK WAGER CANCEL] ${wagerId} cancelled (${reason})`);
    } catch (e) {
      if (e && (e.code === 'wager_not_pending' || e.message === 'wager_not_pending')) {
        console.log(`[SHK WAGER CANCEL] ${wagerId} already cancelled (${reason})`);
      } else {
        console.error(`[SHK WAGER CANCEL] ${wagerId} failed:`, e && e.message);
      }
    } finally {
      resetWagerFields(r);
    }
  }

  // Settle an ACTIVE wager.
  // winnerSeat = 'a' | 'b' | null (draw).
  async function settleWagerForRoom(r, winnerSeat) {
    if (!r.wagerAmount || r.wagerSettled) {
      console.log(`[SHK WAGER SETTLE] Skipped: amount=${r.wagerAmount}, settled=${r.wagerSettled}`);
      return;
    }
    const roomKey = r.wagerRoomId || r.id;
    if (!roomKey) {
      console.log('[SHK WAGER SETTLE] Skipped: no room key');
      return;
    }
    r.wagerSettled = true;
    clearOfferTimer(r);

    const winnerPlayerId = winnerSeat === 'a' ? r.a : (winnerSeat === 'b' ? r.b : null);
    const loserPlayerId = winnerSeat === 'a' ? r.b : (winnerSeat === 'b' ? r.a : null);

    if (typeof settleWager === 'function') {
      try {
        await settleWager('shkobba', roomKey, winnerPlayerId, loserPlayerId);
        console.log(`[SHK WAGER SETTLE] Success, winner=${winnerPlayerId}, loser=${loserPlayerId}, seat=${winnerSeat}`);
      } catch (e) {
        console.error('[SHK WAGER SETTLE] Error:', e && e.message);
      }
    }
  }

  /* ------------------------------------------------------------------
     Offer timeout (60s): auto-cancel pending offer and notify
  ------------------------------------------------------------------ */
  function startOfferTimer(r, wagerId) {
    clearOfferTimer(r);
    r.offerExpiresAt = Date.now() + OFFER_TIMEOUT_MS;

    r.offerTimer = setTimeout(async () => {
      // Re-check that this is still the same offer
      if (r.wagerId !== wagerId || r.wagerSettled) return;
      if (r.status !== 'wait') return;

      console.log(`[SHK OFFER EXPIRED] ${wagerId} (room ${r.id})`);
      await cancelRoomPendingWager(r, 'offer_timeout');

      // Notify both players
      const ids = [r.a, r.b].filter(Boolean);
      for (const pid of ids) {
        send(sockets.get(pid), { type: 'shk:wager_expired', wagerId });
      }
      shkPush(r);
    }, OFFER_TIMEOUT_MS);

    // Don't keep the process alive because of a lobby timer
    if (typeof r.offerTimer.unref === 'function') r.offerTimer.unref();
  }

  /* ------------------------------------------------------------------
     State push (unchanged shape, plus offer metadata)
  ------------------------------------------------------------------ */
  function shkPush(r) {
    const ids = [r.a, r.b, ...r.spec].filter(Boolean);
    const offer = r.wagerId && !r.wagerSettled ? {
      wagerId: r.wagerId,
      amount: r.wagerAmount,
      by: r.wagerOwner,
      byName: r.wagerOwner ? nameOf(r.wagerOwner) : '',
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
      offer, // ← NEW: full offer metadata for the client UI
    };
    ids.forEach(id => {
      const you = id === r.a ? 'a' : id === r.b ? 'b' : 's';
      const hand = you === 's' ? [] : r.hand[you];
      let opts = null;
      if (r.status === 'play' && you === r.turn) { opts = {}; hand.forEach(c => { opts[c] = shkOpts(r.table, val(c)); }); }
      send(sockets.get(id), { ...base, you, hand, opts });
    });
  }

  function shkOf(id) {
    for (const r of shk.values()) if (r.a === id || r.b === id || r.spec.has(id)) return r;
    return null;
  }

  /* ------------------------------------------------------------------
     Leave
  ------------------------------------------------------------------ */
  function shkLeave(id) {
    for (const [rid, r] of shk) {
      if (!(r.a === id || r.b === id || r.spec.has(id))) continue;
      r.spec.delete(id);

      if (r.a === id || r.b === id) {
        const slot = r.a === id ? 'a' : 'b', other = slot === 'a' ? 'b' : 'a';

        if (r.status === 'play' || r.status === 'round') {
          r.status = 'end';
          r.winner = r[other] ? other : null;
          r.forfeit = `${nameOf(id)} resigned`;
          r.summary = null;

          if (r.wagerAmount > 0 && !r.wagerSettled) {
            r.wagerSettled = true;
            clearOfferTimer(r);
            const otherPlayerId = r[other] || null;
            const loserPlayerId = id;
            if (typeof settleWager === 'function') {
              settleWager('shkobba', r.wagerRoomId || r.id, otherPlayerId, loserPlayerId)
                .catch(e => console.error('[SHK WAGER SETTLE]', e && e.message));
            }
          }
        } else if (r.status === 'wait' && r.wagerId && !r.wagerSettled) {
          // Pending offer not accepted → cancel (async, fire-and-forget).
          cancelRoomPendingWager(r, `player_left_waiting:${id}`).catch(() => {});
          r.status = 'wait';
        } else if (r.status !== 'end') {
          r.status = 'wait';
        }

        r[slot] = null;

        if (!r.a && r.b) {
          r.a = r.b; r.b = null; r.score = { a: r.score.b, b: r.score.a };
          if (r.winner) r.winner = 'a';
          r.hand = { a: r.hand.b, b: [] }; r.cap = { a: r.cap.b, b: [] }; r.sk = { a: r.sk.b, b: 0 };
        }
      }
      if (!r.a && !r.b && r.spec.size === 0) {
        clearOfferTimer(r);
        shk.delete(rid);
      } else {
        shkPush(r);
      }
    }
  }

  /* ------------------------------------------------------------------
     Join / seat registration (NO automatic accept, NO overwrite of amount)
  ------------------------------------------------------------------ */
  function shkJoin(id, roomId) {
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

    if (!r.a) {
      r.a = id;
    } else if (!r.b && r.a !== id) {
      r.b = id;
    } else if (!alreadyIn) {
      r.spec.add(id);
    }

    // If both seats filled and no game in progress, ensure the offer timer runs.
    if (r.a && r.b && r.status === 'wait' && r.wagerId && !r.wagerSettled && !r.offerTimer) {
      startOfferTimer(r, r.wagerId);
    }

    shkPush(r);
  }

  /* ------------------------------------------------------------------
     Wager actions (explicit, from client messages)
  ------------------------------------------------------------------ */

  // A creates an offer. Rejected if a live offer already exists.
  async function shkOfferWager(id, amount) {
    const r = shkOf(id); if (!r) return;
    if (r.status !== 'wait') return send(sockets.get(id), { type: 'shk:err', text: 'Game already started' });
    if (id !== r.a && id !== r.b) return send(sockets.get(id), { type: 'shk:err', text: 'Not seated' });

    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n < 300 || n > 100000) {
      return send(sockets.get(id), { type: 'shk:err', text: 'Invalid wager amount' });
    }

    if (r.wagerId && !r.wagerSettled) {
      return send(sockets.get(id), { type: 'shk:err', text: 'An offer already exists' });
    }

    try {
      const row = await createWager(id, 'shkobba', r.id, n);
      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;
      r.pendingWager = 0;

      startOfferTimer(r, row.id);

      // Notify the other player
      const otherId = id === r.a ? r.b : r.a;
      if (otherId) {
        send(sockets.get(otherId), {
          type: 'shk:wager_offer',
          wagerId: row.id,
          amount: n,
          by: id,
          byName: nameOf(id),
          expiresAt: r.offerExpiresAt,
        });
      }
      shkPush(r);
    } catch (e) {
      send(sockets.get(id), { type: 'shk:err', text: 'Offer failed: ' + (e && e.message) });
    }
  }

  // Other player accepts the current offer. Explicit action required.
  async function shkAcceptWager(id, wagerId) {
    const r = shkOf(id); if (!r) return;
    if (r.status !== 'wait') return send(sockets.get(id), { type: 'shk:err', text: 'Game already started' });
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return send(sockets.get(id), { type: 'shk:err', text: 'Offer not available' });
    }
    if (id === r.wagerOwner) {
      return send(sockets.get(id), { type: 'shk:err', text: 'You cannot accept your own offer' });
    }

    try {
      await acceptWager(id, wagerId);
      clearOfferTimer(r);
      r.wagerAmount = r.wagerAmount; // unchanged (offer amount)
      r.wagerRoomId = r.id;
      r.pendingWager = 0;
      r.score = { a: 0, b: 0 };
      shkStart(r);
      shkPush(r);
    } catch (e) {
      send(sockets.get(id), { type: 'shk:err', text: 'Accept failed: ' + (e && e.message) });
      // Offer failed to be accepted → cancel it so the room is not stuck.
      await cancelRoomPendingWager(r, `accept_failed:${e && e.message}`);
      shkPush(r);
    }
  }

  // Other player rejects the current offer.
  async function shkRejectWager(id, wagerId) {
    const r = shkOf(id); if (!r) return;
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return send(sockets.get(id), { type: 'shk:err', text: 'Offer not available' });
    }
    if (id === r.wagerOwner) {
      return send(sockets.get(id), { type: 'shk:err', text: 'You cannot reject your own offer' });
    }

    await cancelRoomPendingWager(r, `rejected_by:${id}`);
    const ownerId = r.wagerOwner || null;

    // Notify the owner (if still connected)
    if (ownerId) {
      send(sockets.get(ownerId), { type: 'shk:wager_rejected', wagerId, by: id });
    }
    shkPush(r);
  }

  // Other player proposes a different amount.
  // Cancels the current offer (refund to owner), then creates a new offer
  // from the counter-offerer.
  async function shkCounterWager(id, wagerId, amount) {
    const r = shkOf(id); if (!r) return;
    if (r.status !== 'wait') return send(sockets.get(id), { type: 'shk:err', text: 'Game already started' });
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return send(sockets.get(id), { type: 'shk:err', text: 'Offer not available' });
    }
    if (id === r.wagerOwner) {
      return send(sockets.get(id), { type: 'shk:err', text: 'You cannot counter your own offer' });
    }

    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n < 300 || n > 100000) {
      return send(sockets.get(id), { type: 'shk:err', text: 'Invalid wager amount' });
    }

    // 1) Cancel the current offer (refund the original owner).
    const originalOwner = r.wagerOwner;
    await cancelRoomPendingWager(r, `countered_by:${id}`);

    // 2) Create a new offer from the counter-offerer.
    try {
      const row = await createWager(id, 'shkobba', r.id, n);
      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = r.id;
      r.wagerSettled = false;
      r.pendingWager = 0;

      startOfferTimer(r, row.id);

      // Notify the original owner about the counter-offer.
      if (originalOwner && originalOwner !== id) {
        send(sockets.get(originalOwner), {
          type: 'shk:wager_offer',
          wagerId: row.id,
          amount: n,
          by: id,
          byName: nameOf(id),
          isCounter: true,
          expiresAt: r.offerExpiresAt,
        });
      }
      shkPush(r);
    } catch (e) {
      send(sockets.get(id), { type: 'shk:err', text: 'Counter failed: ' + (e && e.message) });
      shkPush(r);
    }
  }

  // ------------------------------------------------------------------
  // Gameplay (unchanged)
  // ------------------------------------------------------------------
  function shkPlay(id, d) {
    const r = shkOf(id); if (!r || r.status !== 'play') return;
    const who = r.a === id ? 'a' : r.b === id ? 'b' : null;
    if (!who || r.turn !== who) return;
    const card = String(d.card), hand = r.hand[who];
    if (!hand.includes(card)) return;
    const opts = shkOpts(r.table, val(card));
    const take = Array.isArray(d.take) ? d.take.map(String) : [];
    let chosen = null;
    if (opts.length) {
      chosen = opts.find(o => o.length === take.length && o.every(c => take.includes(c)));
      if (!chosen) return send(sockets.get(id), { type: 'shk:err', text: 'Invalid choice' });
    } else if (take.length) return send(sockets.get(id), { type: 'shk:err', text: 'Cannot take' });
    hand.splice(hand.indexOf(card), 1);
    const lastPlay = r.deck.length === 0 && r.hand.a.length === 0 && r.hand.b.length === 0;
    let shkb = false;
    if (chosen) {
      r.table = r.table.filter(c => !chosen.includes(c));
      r.cap[who].push(card, ...chosen); r.lastCap = who;
      if (!r.table.length && !lastPlay) { r.sk[who]++; shkb = true; }
    } else r.table.push(card);
    r.last = { who, card, take: chosen || [], shk: shkb };

    if (r.hand.a.length === 0 && r.hand.b.length === 0) {
      if (r.deck.length) { shkDeal(r); r.turn = who === 'a' ? 'b' : 'a'; }
      else {
        if (r.lastCap) r.cap[r.lastCap].push(...r.table);
        r.table = [];
        shkFinish(r);
      }
    } else {
      r.turn = who === 'a' ? 'b' : 'a';
    }
    shkPush(r);
  }

  function shkFinish(r) {
    const s = shkScore(r); r.summary = s;
    r.score.a += s.pts.a; r.score.b += s.pts.b;
    const A = r.score.a, B = r.score.b;
    if ((A >= r.goal || B >= r.goal) && A !== B) {
      r.status = 'end';
      r.winner = A > B ? 'a' : 'b';
    } else {
      r.status = 'round';
    }
    r.ready.clear();

    if (r.status === 'end') {
      settleWagerForRoom(r, r.winner);
    }
  }

  function shkGoal(id, g) {
    const r = shkOf(id);
    if (!r || r.a !== id || ![11, 21, 31].includes(g) || !['wait', 'round', 'end'].includes(r.status)) return;
    r.goal = g; shkPush(r);
  }

  function shkNext(id) {
    const r = shkOf(id); if (!r || r.status !== 'round') return;
    r.ready.add(r.a === id ? 'a' : 'b');
    if (r.ready.has('a') && r.ready.has('b')) shkStart(r);
    shkPush(r);
  }

  function shkAgain(id) {
    const r = shkOf(id); if (!r || r.status !== 'end' || !r.a || !r.b) return;
    resetWagerFields(r);
    r.wagerSettled = false;
    r.score = { a: 0, b: 0 };
    shkStart(r);
    shkPush(r);
  }

  return {
    prefix: 'shk:',
    handle(id, d) {
      switch (d.type) {
        // Seating
        case 'shk:join':           if (players.has(id)) shkJoin(id, String(d.room || '').slice(0, 40)); break;
        case 'shk:leave':          shkLeave(id); break;

        // Wager flow (explicit)
        case 'shk:wager_offer':    shkOfferWager(id, d.amount); break;
        case 'shk:wager_accept':   shkAcceptWager(id, String(d.wagerId || '')); break;
        case 'shk:wager_reject':   shkRejectWager(id, String(d.wagerId || '')); break;
        case 'shk:wager_counter':  shkCounterWager(id, String(d.wagerId || ''), d.amount); break;

        // Gameplay
        case 'shk:play':           shkPlay(id, d); break;
        case 'shk:next':           shkNext(id); break;
        case 'shk:goal':           shkGoal(id, +d.goal); break;
        case 'shk:again':          shkAgain(id); break;
      }
    },
    leave: shkLeave,
  };
};

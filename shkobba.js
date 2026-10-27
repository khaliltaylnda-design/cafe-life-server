'use strict';

// games/shkobba.js
module.exports = function ({ send, sockets, players, broadcast, crypto, createWager, acceptWager, cancelWager, settleWager }) {
  const nameOf = id => (players.get(id) || {}).name || 'Player';

  const shk = new Map();
  const val = c => +c.slice(1);

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

  function shkRoom(id) {
    return {
      id, a: null, b: null, spec: new Set(), status: 'wait', goal: 11,
      score: { a: 0, b: 0 }, first: 'b', ready: new Set(), summary: null,
      winner: null, forfeit: null, table: [], hand: { a: [], b: [] },
      cap: { a: [], b: [] }, sk: { a: 0, b: 0 }, deck: [], last: null,
      turn: 'a', lastCap: null,
      wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false,
      pendingWager: 0, wagerOwner: null
    };
  }

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

  // ← [FIX #1] Cancel pending wager. Tolerate 'wager_not_pending' (already handled
  // by cancelPendingByPlayer in server.js on socket close).
  async function cancelRoomPendingWager(r, reason) {
    if (!r.wagerId || r.wagerSettled) return;
    if (r.wagerOwner == null) return;
    if (typeof cancelWager !== 'function') return;

    const wagerId = r.wagerId;
    const owner = r.wagerOwner;

    r.wagerSettled = true;

    try {
      await cancelWager(owner, wagerId);
      console.log(`[SHK WAGER CANCEL] ${wagerId} cancelled (${reason})`);
    } catch (e) {
      // ← [FIX #5] Not an error if it was already cancelled by server-side hook.
      if (e && (e.code === 'wager_not_pending' || e.message === 'wager_not_pending')) {
        console.log(`[SHK WAGER CANCEL] ${wagerId} already cancelled (${reason})`);
      } else {
        console.error(`[SHK WAGER CANCEL] ${wagerId} failed:`, e && e.message);
      }
    } finally {
      r.wagerId = null;
      r.wagerAmount = 0;
      r.wagerRoomId = null;
      r.wagerOwner = null;
      r.pendingWager = 0;
    }
  }

  // ← [FIX #2] Settle must NEVER be confused with cancel:
  //   - winnerSeat 'a'/'b' → settle with that player as winner
  //   - winnerSeat null     → settle as draw (refund both)
  //   - wager not yet active (still pending) → cancel instead
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

  function shkPush(r) {
    const ids = [r.a, r.b, ...r.spec].filter(Boolean);
    const base = {
      type: 'shk:state', room: r.id, status: r.status, goal: r.goal, table: r.table, score: r.score,
      names: { a: r.a ? nameOf(r.a) : '', b: r.b ? nameOf(r.b) : '' },
      turn: r.turn, deck: r.deck.length, nHand: { a: r.hand.a.length, b: r.hand.b.length },
      taken: { a: r.cap.a.length, b: r.cap.b.length },
      sk: r.sk, last: r.last, summary: r.summary, winner: r.winner, forfeit: r.forfeit, ready: [...r.ready],
      wager: r.wagerAmount || null,
      wagerId: r.wagerId || null
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

  // ← [FIX #3] shkLeave handles every terminal case correctly:
  //   - 'wait' with pending wager  → cancel
  //   - 'play'/'round' with opp.   → settle in opp.'s favor
  //   - 'play'/'round' w/o opp.    → settle as draw (refund)
  //   - 'end'                       → nothing
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
            const otherPlayerId = r[other] || null;
            const loserPlayerId = id;
            if (typeof settleWager === 'function') {
              // ← [FIX] If opponent exists → settle in their favor. If not → draw.
              settleWager('shkobba', r.wagerRoomId || r.id, otherPlayerId, loserPlayerId)
                .catch(e => console.error('[SHK WAGER SETTLE]', e && e.message));
            }
          }
        } else if (r.status === 'wait' && r.wagerId && !r.wagerSettled) {
          // ← [FIX] Pending wager existed but game never started → cancel.
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
      if (!r.a && !r.b && r.spec.size === 0) shk.delete(rid); else shkPush(r);
    }
  }

  async function shkJoin(id, roomId, amount) {
    // Leave any other room first.
    for (const [rid, otherR] of shk) {
      if (rid === roomId) continue;
      if (otherR.a === id || otherR.b === id) {
        shkLeave(id);
        break;
      }
    }

    let r = shk.get(roomId);
    if (!r) { r = shkRoom(roomId); shk.set(roomId, r); }

    const wagerAmount = Number(amount) || 0;
    const alreadyIn = (r.a === id || r.b === id);

    console.log(`[SHK JOIN] id=${id}, room=${roomId}, amount=${wagerAmount}, r.a=${r.a}, r.b=${r.b}, wagerId=${r.wagerId}, owner=${r.wagerOwner}, already=${alreadyIn}`);

    // 1) Register the player.
    if (!r.a) {
      r.a = id;
      if (wagerAmount >= 300) r.pendingWager = wagerAmount;
      console.log(`[SHK JOIN] ${id} as A, pendingWager=${r.pendingWager}`);
    } else if (!r.b && r.a !== id) {
      r.b = id;
      if (wagerAmount >= 300) r.pendingWager = wagerAmount;
      console.log(`[SHK JOIN] ${id} as B, pendingWager=${r.pendingWager}`);
    } else if (!alreadyIn) {
      r.spec.add(id);
      return shkPush(r);
    } else {
      if (wagerAmount >= 300) r.pendingWager = wagerAmount;
      console.log(`[SHK JOIN] ${id} already in, updated pendingWager=${r.pendingWager}`);
    }

    // 2) Wager management.
    if (r.a && r.b && r.status === 'wait') {

      // 2a) A pending wager exists: the OTHER player accepts it.
      if (r.wagerId && !r.wagerSettled && r.wagerOwner && id !== r.wagerOwner) {
        try {
          console.log(`[SHK] Accepting wager ${r.wagerId} by ${id}`);
          await acceptWager(id, r.wagerId);
          r.wagerAmount = r.pendingWager || r.wagerAmount;
          r.wagerRoomId = roomId;
          r.pendingWager = 0;
          r.score = { a: 0, b: 0 };
          shkStart(r);
          shkPush(r);
          return;
        } catch (e) {
          console.error('[SHK] Accept error:', e && e.message);
          send(sockets.get(id), { type: 'shk:err', text: 'Accept failed: ' + (e && e.message) });

          // ← [FIX #4] Cancel the pending wager, keep both seats, reset to 'wait'.
          await cancelRoomPendingWager(r, `accept_failed:${e && e.message}`);
          r.status = 'wait';
          shkPush(r);
          return;
        }
      }
      // 2b) No wager yet: create one from the pending amount.
      else if (!r.wagerId && r.pendingWager >= 300) {
        try {
          const wagerRow = await createWager(id, 'shkobba', roomId, r.pendingWager);
          r.wagerId = wagerRow.id;
          r.wagerOwner = id;
          r.wagerAmount = r.pendingWager;
          r.wagerRoomId = roomId;   // ← [FIX #7] set immediately
          const otherId = (id === r.a) ? r.b : r.a;
          send(sockets.get(otherId), {
            type: 'shk:wager_pending',
            amount: r.pendingWager,
            wagerId: wagerRow.id,
            room: roomId
          });
          console.log(`[SHK] Wager created by ${nameOf(id)}: ${r.pendingWager}, waiting for ${nameOf(otherId)}`);
        } catch (e) {
          console.error('[SHK] Create error:', e && e.message);
          send(sockets.get(id), { type: 'shk:err', text: 'Wager failed: ' + (e && e.message) });

          // ← [FIX #6] Do NOT kick players. Just clear the pending amount.
          r.pendingWager = 0;
          shkPush(r);
          return;
        }
      }
      // 2c) Free play.
      else if (!r.wagerId && r.pendingWager < 300) {
        r.score = { a: 0, b: 0 };
        shkStart(r);
      }
    }

    shkPush(r);
  }

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
    // Clear wager for the new match.
    r.wagerId = null;
    r.wagerAmount = 0;
    r.wagerRoomId = null;
    r.wagerSettled = false;
    r.pendingWager = 0;
    r.wagerOwner = null;
    r.score = { a: 0, b: 0 };
    shkStart(r);
    shkPush(r);
  }

  return {
    prefix: 'shk:',
    handle(id, d) {
      switch (d.type) {
        case 'shk:join':  if (players.has(id)) shkJoin(id, String(d.room || '').slice(0, 40), d.amount); break;
        case 'shk:play':  shkPlay(id, d); break;
        case 'shk:next':  shkNext(id); break;
        case 'shk:goal':  shkGoal(id, +d.goal); break;
        case 'shk:again': shkAgain(id); break;
        case 'shk:leave': shkLeave(id); break;
      }
    },
    leave: shkLeave,
  };
};

'use strict';

const { Chess } = require('chess.js');

module.exports = function ({ send, sockets, players, broadcast, crypto, createWager, acceptWager, settleWager }) {
  const TIME = 10 * 60 * 1000;
  const rooms = new Map();
  const is = (c, a, b) => (c[a] ? c[a]() : c[b]());
  const nameOf = id => (players.get(id) || {}).name || 'Player';

  function newRoom(id) {
    return { 
      id, chess: new Chess(), w: null, b: null, spec: new Set(), 
      status: 'wait', result: '', last: null, time: { w: TIME, b: TIME }, 
      since: 0, draw: null,
      wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false
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
    console.log(`[CHESS] Game started. Room: ${r.id}, w: ${r.w}, b: ${r.b}, wager: ${r.wagerAmount}`);
  }
  
  function resetBoard(r) {
    r.chess = new Chess(); 
    r.last = null; 
    r.result = ''; 
    r.time = { w: TIME, b: TIME }; 
    r.draw = null;
    r.wagerSettled = false;
    r.wagerId = null;
    r.wagerAmount = 0;
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

  async function settleWagerForRoom(r, winnerPlayerId) {
    if (r.wagerAmount <= 0 || r.wagerSettled || !r.wagerRoomId) {
      console.log(`[CHESS WAGER SETTLE] Skipped: amount=${r.wagerAmount}, settled=${r.wagerSettled}`);
      return;
    }
    r.wagerSettled = true;
    if (typeof settleWager === 'function') {
      try {
        await settleWager('chess', r.wagerRoomId, winnerPlayerId);
        console.log(`[CHESS WAGER SETTLE] Success for room ${r.wagerRoomId}, winner ${winnerPlayerId}`);
      } catch (e) {
        console.error('[CHESS WAGER SETTLE] Error:', e.message);
      }
    }
  }

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
    // إزالة اللاعب من غرفة أخرى فقط
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
    
    // تسجيل اللاعب
    if (!r.w) {
      r.w = id;
    } else if (!r.b && r.w !== id) {
      r.b = id;
    } else if (r.w === id || r.b === id) {
      // موجود بالفعل
    } else {
      r.spec.add(id);
      return pushRoom(r);
    }
    
    const wagerAmount = Number(amount) || 0;
    
    // إدارة الرهان عند اكتمال اللاعبين
    if (r.w && r.b && r.status === 'wait') {
      
      // إذا كان هناك رهان معلق (اللاعب الأول أنشأه)، اللاعب الثاني يقبله تلقائياً
      if (r.wagerId && !r.wagerSettled && wagerAmount >= 300) {
        if (id === r.b) {
          try {
            await acceptWager(id, r.wagerId);
            r.wagerAmount = wagerAmount;
            r.wagerRoomId = roomId;
            startPlay(r);
          } catch (e) {
            console.error('[CHESS] Accept error:', e.message);
            send(sockets.get(id), { type: 'chess:err', text: 'Accept failed: ' + e.message });
            r.b = null;
            pushRoom(r);
            return;
          }
        }
      }
      // إذا لم يكن هناك رهان، واللاعب الأول يريد إنشاء واحد
      else if (!r.wagerId && wagerAmount >= 300) {
        if (id === r.w) {
          try {
            const wagerRow = await createWager(id, 'chess', roomId, wagerAmount);
            r.wagerId = wagerRow.id;
            
            // إرسال إشعار للاعب الثاني (لكي يعرف ويقبل عند دخوله)
            send(sockets.get(r.b), { 
              type: 'chess:wager_pending', 
              amount: wagerAmount,
              wagerId: wagerRow.id,
              room: roomId
            });
            
            console.log(`[CHESS] Wager created: ${wagerAmount}, waiting for ${nameOf(r.b)}`);
          } catch (e) {
            console.error('[CHESS] Create error:', e.message);
            send(sockets.get(id), { type: 'chess:err', text: 'Create failed: ' + e.message });
            r.w = null;
            pushRoom(r);
            return;
          }
        }
      }
      // لعبة عادية (بدون رهان)
      else if (!r.wagerId && wagerAmount < 300) {
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

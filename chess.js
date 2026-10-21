// games/chess.js — الشطرنج (الخادم هو الحَكَم، المحرك chess.js)
// يتحمّل من server.js. ما تلمس غير هذا الملف كي تطوّر الشطرنج.
const { Chess } = require('chess.js');

module.exports = function ({ send, sockets, players, broadcast }) {
  /* ================= الشطرنج ================= */
  // القواعد كاملة من محرك chess.js: الكش، الكش مات، التبييت، الأخذ بالمرور، الترقية، البات،
  // التكرار الثلاثي، المادة غير الكافية، قاعدة الخمسين نقلة. وهنا نضيف الساعة وعرض التعادل.
  const TIME = 10 * 60 * 1000;   // 10 دقائق لكل لاعب
  const rooms = new Map();
  const is = (c, a, b) => (c[a] ? c[a]() : c[b]());
  const nameOf = id => (players.get(id) || {}).name || 'لاعب';

  function newRoom(id) {
    return { id, chess: new Chess(), w: null, b: null, spec: new Set(), status: 'wait', result: '', last: null, time: { w: TIME, b: TIME }, since: 0, draw: null };
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
      black: r.b ? { id: r.b, name: nameOf(r.b) } : null
    };
    const legal = r.status === 'play' ? legalMap(r) : null;
    ids.forEach(id => {
      const you = id === r.w ? 'w' : id === r.b ? 'b' : 's';
      send(sockets.get(id), { ...base, you, moves: you === turn ? legal : null });
    });
  }
  function startPlay(r) { r.status = 'play'; r.since = Date.now(); }
  function resetBoard(r) {
    r.chess = new Chess(); r.last = null; r.result = ''; r.time = { w: TIME, b: TIME }; r.draw = null;
    if (r.w && r.b) startPlay(r); else r.status = 'wait';
  }
  function endGame(r, text) { r.status = 'end'; r.result = text; r.draw = null; }
  function checkEnd(r, id) {
    const c = r.chess;
    if (is(c, 'isCheckmate', 'in_checkmate')) endGame(r, `كش مات! فاز ${nameOf(id)}`);
    else if (is(c, 'isStalemate', 'in_stalemate')) endGame(r, 'تعادل — بات (لا حركة قانونية)');
    else if (is(c, 'isInsufficientMaterial', 'insufficient_material')) endGame(r, 'تعادل — مادة غير كافية');
    else if (is(c, 'isThreefoldRepetition', 'in_threefold_repetition')) endGame(r, 'تعادل — تكرار ثلاثي');
    else if (is(c, 'isDraw', 'in_draw')) endGame(r, 'تعادل — قاعدة الخمسين نقلة');
  }
  function chessLeave(id) {
    for (const [rid, r] of rooms) {
      if (!(r.w === id || r.b === id || r.spec.has(id))) continue;
      r.spec.delete(id);
      if (r.w === id || r.b === id) {
        const slot = r.w === id ? 'w' : 'b';
        if (r.status === 'play') endGame(r, `انسحب ${nameOf(id)}، فاز ${nameOf(slot === 'w' ? r.b : r.w)}`);
        r[slot] = null;
        if (r.status !== 'end') resetBoard(r);
        if (!r.w && r.b) { r.w = r.b; r.b = null; }
        if (r.status === 'end' && !r.w && !r.b) r.status = 'wait';
      }
      if (!r.w && !r.b && r.spec.size === 0) rooms.delete(rid);
      else pushRoom(r);
    }
  }
  function chessJoin(id, roomId) {
    chessLeave(id);
    let r = rooms.get(roomId);
    if (!r) { r = newRoom(roomId); rooms.set(roomId, r); }
    if (r.status === 'end' && !r.w && !r.b) resetBoard(r);
    if (!r.w) r.w = id;
    else if (!r.b) r.b = id;
    else r.spec.add(id);
    if (r.w && r.b && r.status === 'wait') startPlay(r);
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
      endGame(r, `انتهى وقت ${nameOf(id)}، فاز ${nameOf(turn === 'w' ? r.b : r.w)}`);
      return pushRoom(r);
    }
    const promo = ['q', 'r', 'b', 'n'].includes(m.promo) ? m.promo : 'q';
    let res = null;
    try { res = r.chess.move({ from: String(m.from), to: String(m.to), promotion: promo }); } catch (e) { res = null; }
    if (!res) { r.time[turn] += now - r.since; return send(sockets.get(id), { type: 'chess:err', text: 'حركة غير قانونية' }); }
    r.since = now; r.draw = null;
    r.last = { from: res.from, to: res.to };
    checkEnd(r, id);
    pushRoom(r);
  }
  function chessResign(id) {
    const r = roomOf(id);
    if (!r || r.status !== 'play' || (r.w !== id && r.b !== id)) return;
    endGame(r, `انسحب ${nameOf(id)}، فاز ${nameOf(r.w === id ? r.b : r.w)}`);
    pushRoom(r);
  }
  function chessDraw(id, act) {
    const r = roomOf(id);
    if (!r || r.status !== 'play' || (r.w !== id && r.b !== id)) return;
    const me = r.w === id ? 'w' : 'b';
    if (act === 'offer' && !r.draw) r.draw = me;
    else if (act === 'accept' && r.draw && r.draw !== me) endGame(r, 'تعادل بالاتفاق 🤝');
    else if (act === 'decline' && r.draw && r.draw !== me) r.draw = null;
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
  // انتهاء الوقت (يفحص كل ثانية)
  setInterval(() => {
    for (const r of rooms.values()) {
      if (r.status !== 'play') continue;
      const tn = r.chess.turn();
      if (r.time[tn] - (Date.now() - r.since) <= 0) {
        r.time[tn] = 0;
        endGame(r, `انتهى وقت ${nameOf(tn === 'w' ? r.w : r.b)}، فاز ${nameOf(tn === 'w' ? r.b : r.w)}`);
        pushRoom(r);
      }
    }
  }, 1000);


  return {
    prefix: 'chess:',
    handle(id, d) {
      switch (d.type) {
        case 'chess:join':    if (players.has(id)) chessJoin(id, String(d.room || '').slice(0, 40)); break;
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

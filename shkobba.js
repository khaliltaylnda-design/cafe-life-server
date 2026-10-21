// games/shkobba.js — الشكبة التونسية (لاعبان، الخادم هو الحَكَم)
// يتحمّل من server.js. ما تلمس غير هذا الملف كي تطوّر الشكبة.
module.exports = function ({ send, sockets, players, broadcast, crypto }) {
  const nameOf = id => (players.get(id) || {}).name || 'لاعب';
  /* ================= الشكبة (لاعبان) ================= */
  // ورق 40: دينارى d (ذهب) وكاس c وسيف s وعصا b، القيم 1 إلى 10 (8 و9 و10 هي الولد والفارس والملك).
  // الأخذ: ورقة بنفس القيمة (وإن وُجدت فيجب أخذها)، وإلا مجموع أوراق يساوي قيمتها. إخلاء الطاولة = شكبة (نقطة).
  // نقاط الجولة: الكارطة، الدينارى، السبعة الذهبية، البرمولة، + الشكبات. اللعبة حتى 11 نقطة.
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
    return { id, a: null, b: null, spec: new Set(), status: 'wait', goal: 11, score: { a: 0, b: 0 }, first: 'b', ready: new Set(), summary: null, winner: null, forfeit: null,
      table: [], hand: { a: [], b: [] }, cap: { a: [], b: [] }, sk: { a: 0, b: 0 }, deck: [], last: null, turn: 'a', lastCap: null };
  }
  function shkDeal(r) { r.hand.a = r.deck.splice(0, 3); r.hand.b = r.deck.splice(0, 3); }
  function shkStart(r) {
    r.deck = newDeck(); r.table = r.deck.splice(0, 4);
    r.cap = { a: [], b: [] }; r.sk = { a: 0, b: 0 }; r.lastCap = null; r.last = null; r.summary = null; r.winner = null; r.forfeit = null;
    r.first = r.first === 'a' ? 'b' : 'a'; r.turn = r.first; shkDeal(r); r.status = 'play'; r.ready.clear();
  }
  function shkScore(r) {
    const cnt = p => { const c = r.cap[p]; return { n: c.length, d: c.filter(x => x[0] === 'd').length, s7: c.filter(x => val(x) === 7).length, s6: c.filter(x => val(x) === 6).length, z: c.includes('d7') ? 1 : 0 }; };
    const A = cnt('a'), B = cnt('b'), pts = { a: 0, b: 0 }, lines = [];
    const w = (x, y) => (x > y ? 'a' : y > x ? 'b' : null);
    const add = (k, a, b, win) => { if (win) pts[win]++; lines.push({ k, a, b, w: win }); };
    add('الكارطة (أكثر الأوراق)', A.n, B.n, w(A.n, B.n));
    add('الدينارى (أكثر الذهب)', A.d, B.d, w(A.d, B.d));
    add('السبعة الذهبية', A.z, B.z, w(A.z, B.z));
    add('البرمولة (أكثر السبعات)', A.s7, B.s7, w(A.s7, B.s7));
    lines.push({ k: 'الشكبة', a: r.sk.a, b: r.sk.b, w: null }); pts.a += r.sk.a; pts.b += r.sk.b;
    return { lines, pts };
  }
  function shkFinish(r) {
    const s = shkScore(r); r.summary = s;
    r.score.a += s.pts.a; r.score.b += s.pts.b;
    const A = r.score.a, B = r.score.b;
    if ((A >= r.goal || B >= r.goal) && A !== B) { r.status = 'end'; r.winner = A > B ? 'a' : 'b'; } else r.status = 'round';
    r.ready.clear();
  }
  function shkPush(r) {
    const ids = [r.a, r.b, ...r.spec].filter(Boolean);
    const base = {
      type: 'shk:state', room: r.id, status: r.status, goal: r.goal, table: r.table, score: r.score, names: { a: r.a ? nameOf(r.a) : '', b: r.b ? nameOf(r.b) : '' },
      turn: r.turn, deck: r.deck.length, nHand: { a: r.hand.a.length, b: r.hand.b.length }, taken: { a: r.cap.a.length, b: r.cap.b.length },
      sk: r.sk, last: r.last, summary: r.summary, winner: r.winner, forfeit: r.forfeit, ready: [...r.ready]
    };
    ids.forEach(id => {
      const you = id === r.a ? 'a' : id === r.b ? 'b' : 's';
      const hand = you === 's' ? [] : r.hand[you];
      let opts = null;
      if (r.status === 'play' && you === r.turn) { opts = {}; hand.forEach(c => { opts[c] = shkOpts(r.table, val(c)); }); }
      send(sockets.get(id), { ...base, you, hand, opts });
    });
  }
  function shkOf(id) { for (const r of shk.values()) if (r.a === id || r.b === id || r.spec.has(id)) return r; return null; }
  function shkLeave(id) {
    for (const [rid, r] of shk) {
      if (!(r.a === id || r.b === id || r.spec.has(id))) continue;
      r.spec.delete(id);
      if (r.a === id || r.b === id) {
        const slot = r.a === id ? 'a' : 'b', other = slot === 'a' ? 'b' : 'a';
        if (r.status === 'play' || r.status === 'round') {
          r.status = 'end'; r.winner = r[other] ? other : null; r.forfeit = `انسحب ${nameOf(id)}`; r.summary = null;
        } else if (r.status !== 'end') r.status = 'wait';
        r[slot] = null;
        if (!r.a && r.b) { r.a = r.b; r.b = null; r.score = { a: r.score.b, b: r.score.a }; if (r.winner) r.winner = 'a'; r.hand = { a: r.hand.b, b: [] }; r.cap = { a: r.cap.b, b: [] }; r.sk = { a: r.sk.b, b: 0 }; }
      }
      if (!r.a && !r.b && r.spec.size === 0) shk.delete(rid); else shkPush(r);
    }
  }
  function shkJoin(id, roomId) {
    shkLeave(id);
    let r = shk.get(roomId);
    if (!r) { r = shkRoom(roomId); shk.set(roomId, r); }
    if (!r.a) r.a = id; else if (!r.b) r.b = id; else r.spec.add(id);
    if (r.a && r.b && (r.status === 'wait' || (r.status === 'end' && r.forfeit))) { r.score = { a: 0, b: 0 }; shkStart(r); }
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
      if (!chosen) return send(sockets.get(id), { type: 'shk:err', text: 'اختيار غير صحيح' });
    } else if (take.length) return send(sockets.get(id), { type: 'shk:err', text: 'لا يمكن الأخذ' });
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
      else { if (r.lastCap) r.cap[r.lastCap].push(...r.table); r.table = []; shkFinish(r); }
    } else r.turn = who === 'a' ? 'b' : 'a';
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
    r.score = { a: 0, b: 0 }; shkStart(r); shkPush(r);
  }


  return {
    prefix: 'shk:',
    handle(id, d) {
      switch (d.type) {
        case 'shk:join':  if (players.has(id)) shkJoin(id, 'shk:' + String(d.room || '').slice(0, 40)); break;
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

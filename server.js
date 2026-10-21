// Café Life server — اللاعبون + الصوت + الدردشة + الشطرنج + الشكبة + الرامي (الخادم هو الحَكَم)
// التثبيت:  npm i express cors ws chess.js@1
const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Café Life Server running'));
app.get('/version', (req, res) => res.send('cafe-v3: chess + shkobba + rummy OK'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const players = new Map();   // id -> بيانات اللاعب
const sockets = new Map();   // id -> ws

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
function broadcast(o, excludeId = null) {
  const msg = JSON.stringify(o);
  wss.clients.forEach(c => { if (c.readyState === 1 && c.playerId !== excludeId) c.send(msg); });
}

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

/* ================= الشكبة (لاعبان) ================= */
// ورق 40: دينارى d (ذهب) وكاس c وسيف s وعصا b، القيم 1 إلى 10 (8 و9 و10 هي الولد والفارس والملك).
// الأخذ: ورقة بنفس القيمة (وإن وُجدت فيجب أخذها)، وإلا مجموع أوراق يساوي قيمتها. إخلاء الطاولة = شكبة (نقطة).
// نقاط الجولة: الكارطة، الدينارى، السبعة الذهبية، البرمولة، + الشكبات. اللعبة حتى 11 نقطة.
const crypto = require('crypto');
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

/* ================= الرامي التونسي ================= */
// RUMMY-START
// الخادم هو الحَكَم: 108 ورقة، 15 للّي يبدا و14 للباقي، الحلان التصاعدي (51 ثم +1)،
// البلاص، هزان الجوكر (لازم مانع)، الفرشة (غلطة = 100 وتخرج من الجولة)، السكور الفردي (طرح 300).
const RM = (() => {
  const val = r => (r >= 10 || r === 1) ? 10 : r;
  const hv = c => c.r ? val(c.r) : 20;                       // الجوكر في الكف = 20
  const posv = p => p === 1 ? 1 : (p >= 10 ? 10 : p);
  function meld(cs) {                                          // {k,pts,ord} أو null
    const n = cs.length; if (n < 3) return null;
    const jk = cs.filter(c => !c.r), ot = cs.filter(c => c.r); if (!ot.length) return null;
    const suits = new Set(ot.map(c => c.s));
    if (n <= 4 && ot.every(c => c.r === ot[0].r) && suits.size === ot.length) return { k: 'باكو', pts: val(ot[0].r) * n, ord: cs };
    if (suits.size !== 1 || new Set(ot.map(c => c.r)).size !== ot.length) return null;
    let best = null;
    for (const hi of [0, 1]) {
      const L = hi ? 2 : 1, U = hi ? 14 : 13; if (U - L + 1 < n) continue;
      const v = ot.map(c => ({ c, p: (c.r === 1 && hi) ? 14 : c.r })).sort((a, b) => a.p - b.p);
      const mn = v[0].p, mx = v[v.length - 1].p;
      if (mx - mn + 1 - v.length > jk.length) continue;
      const s = Math.min(mn, U - n + 1); if (s + n - 1 < mx) continue;
      const J = [...jk], ord = []; let pts = 0;
      for (let p = s; p < s + n; p++) { const f = v.find(x => x.p === p); ord.push(f ? f.c : J.pop()); pts += posv(p); }
      if (!best || pts > best.pts) best = { k: 'سيكونس', pts, ord };
    }
    return best;
  }
  function cands(R, x) {
    const J = R.filter(c => !c.r), O = R.filter(c => c.r && c !== x), out = [], seen = new Set();
    const add = cs => { const m = meld(cs); if (!m) return; const k = cs.map(c => c.id).sort((a, b) => a - b).join(); if (seen.has(k)) return; seen.add(k); out.push({ cs, m }); };
    const ss = new Set([x.s]), same = []; O.forEach(c => { if (c.r === x.r && !ss.has(c.s)) { ss.add(c.s); same.push(c); } });
    for (let mk = 0; mk < (1 << same.length); mk++) {
      const b = [x]; same.forEach((c, i) => (mk >> i) & 1 && b.push(c));
      for (let j = 0; j <= Math.min(J.length, 2); j++) if (b.length + j >= 3 && b.length + j <= 4) add([...b, ...J.slice(0, j)]);
    }
    const bs = {}; O.forEach(c => { if (c.s === x.s && !bs[c.r]) bs[c.r] = c; });
    for (const hi of [0, 1]) {
      const L = hi ? 2 : 1, U = hi ? 14 : 13, px = (x.r === 1 && hi) ? 14 : x.r; if (px < L || px > U) continue;
      for (let a = Math.max(L, px - 13); a <= px; a++) for (let b = px; b <= U; b++) {
        if (b - a < 2) continue; const cs = []; let need = 0;
        for (let p = a; p <= b; p++) { const c = p === px ? x : bs[p === 14 ? 1 : p]; if (c) cs.push(c); else need++; }
        if (need > J.length || need > 2) continue; add([...cs, ...J.slice(0, need)]);
      }
    }
    return out;
  }
  function solve(hand, out) {      // out=true: غطّي أكثر عدد ورق (للفرشة) — وإلا أكثر نقاط (للمنع)
    const memo = new Map();
    const go = R => {
      const k = R.map(c => c.id).sort((a, b) => a - b).join(); if (memo.has(k)) return memo.get(k);
      const x = R.find(c => c.r); let best = { s: out ? 0 : -R.length, ms: [] };
      if (x) {
        const sk = go(R.filter(c => c !== x)); best = { s: sk.s - (out ? 0 : 1), ms: sk.ms };
        if (memo.size < 60000) for (const { cs, m } of cands(R, x)) {
          const ids = new Set(cs.map(c => c.id)), r = go(R.filter(c => !ids.has(c.id)));
          const sc = r.s + (out ? cs.length * 1000 + (cs.length >= 4 ? 50 : 0) + m.pts / 100 : m.pts * 20);
          if (sc > best.s) best = { s: sc, ms: [m.ord, ...r.ms] };
        }
      }
      memo.set(k, best); return best;
    };
    return go(hand).ms;
  }
  function jokerSlot(m, k) {
    const cs = m.cards, j = cs.findIndex(c => c.r), c = cs[j], pj = (c.r === 1 && j > 0) ? 14 : c.r, pos = pj + (k - j);
    return { r: pos === 14 ? 1 : pos, s: c.s };
  }
  function trySwap(m, c) {         // هزان الجوكر: الورقة الحقيقية اللي يعوّضها
    if (!c.r) return null;
    for (let k = 0; k < m.cards.length; k++) {
      if (m.cards[k].r) continue;
      if (m.k === 'سيكونس') { const w = jokerSlot(m, k); if (w.r !== c.r || w.s !== c.s) continue; }
      const cs = [...m.cards]; cs[k] = c; const r = meld(cs);
      if (r) return { r, j: m.cards[k] };
    }
    return null;
  }
  return { hv, meld, solve, trySwap };
})();

const RUM = new Map();
const rumShuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function rumDeck() {
  const d = []; let n = 0;
  for (let k = 0; k < 2; k++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) d.push({ id: n++, r, s });
  for (let i = 0; i < 4; i++) d.push({ id: n++, r: 0, s: -1 });
  return rumShuffle(d);
}
const rumActive = s => !s.dead && !s.out && !s.left;
const rumOf = id => { for (const r of RUM.values()) if (r.seats.some(s => s.id === id && !s.left)) return r; return null; };
const rumErr = (id, text) => send(sockets.get(id), { type: 'rum:err', text });
function rumView(r, i) {
  const me = r.seats[i];
  return {
    type: 'rum:state', room: r.id.slice(4), status: r.status, host: r.hostId === me.id, you: i,
    seats: r.seats.map(s => ({ name: s.name, score: s.score, opened: s.opened, out: s.out, dead: s.dead, n: s.hand.length })),
    hand: me.hand, melds: r.melds, disc: r.disc[r.disc.length - 1] || null, stock: r.stock.length,
    min: r.min, turn: r.turn, ph: r.ph, first: r.first, wasOpen: r.wasOpen,
    took: (i === r.turn && r.took) ? r.took.id : null,
    rows: r.rows, over: r.over, winner: r.winner, ready: [...r.ready]
  };
}
const rumPush = r => r.seats.forEach((s, i) => send(sockets.get(s.id), rumView(r, i)));

function rumJoin(id, roomId) {
  rumLeave(id);
  const key = 'rum:' + roomId; let r = RUM.get(key);
  if (!r) { r = { id: key, seats: [], hostId: id, status: 'wait', stock: [], disc: [], melds: [], min: 51, turn: 0, ph: 'draw', first: false, took: null, laid: [], wasOpen: false, rows: null, over: false, winner: '', ready: new Set(), n: 0, starterId: null }; RUM.set(key, r); }
  if (r.status !== 'wait') return rumErr(id, 'اللعبة بدات في هذي الطاولة');
  if (r.seats.length >= 4) return rumErr(id, 'الطاولة مليانة (4 لاعبين)');
  r.seats.push({ id, name: (players.get(id) || {}).name || 'لاعب', hand: [], opened: false, score: 0, dead: false, out: false, left: false });
  rumPush(r);
}
function rumStartGame(r) {
  r.n = r.seats.length; r.over = false; r.winner = '';
  r.seats.forEach(s => { s.score = 0; s.dead = false; });
  rumDeal(r, crypto.randomInt(r.n));
}
function rumStart(id) {
  const r = rumOf(id); if (!r || r.hostId !== id || r.status !== 'wait') return;
  if (r.seats.length < 2) return rumErr(id, 'تحتاج لاعبين على الأقل');
  rumStartGame(r);
}
function rumAgain(id) {
  const r = rumOf(id); if (!r || r.hostId !== id || r.status !== 'end') return;
  r.seats = r.seats.filter(s => !s.left);
  if (r.seats.length < 2) return rumErr(id, 'تحتاج لاعبين على الأقل');
  rumStartGame(r);
}
function rumDeal(r, st) {
  r.stock = rumDeck(); r.disc = []; r.melds = []; r.min = 51; r.first = true; r.rows = null; r.ready = new Set(); r.status = 'play';
  r.seats.forEach((s, i) => { s.opened = false; s.out = false; s.hand = []; if (!s.dead) for (let k = 0; k < (i === st ? 15 : 14); k++) s.hand.push(r.stock.pop()); });
  rumTurn(r, st); rumPush(r);
}
function rumTurn(r, i) { r.turn = i; r.took = null; r.laid = []; r.wasOpen = r.seats[i].opened; r.ph = r.first ? 'play' : 'draw'; }
function rumAdvance(r) {
  r.first = false;
  if (r.seats.filter(rumActive).length < 2) return rumEnd(r, null);
  let j = r.turn; do { j = (j + 1) % r.seats.length; } while (!rumActive(r.seats[j]));
  rumTurn(r, j); rumPush(r);
}
function rumCur(id, ph) {
  const r = rumOf(id); if (!r || r.status !== 'play') return null;
  const i = r.seats.findIndex(s => s.id === id), s = r.seats[i];
  if (i !== r.turn || !rumActive(s)) { rumErr(id, 'مش دورك'); return null; }
  if (r.ph !== ph) { rumErr(id, ph === 'draw' ? 'ما تنجمش تسحب توّا' : 'اسحب ورقة أول'); return null; }
  return { r, i, s };
}
function rumDraw(id, from) {
  const x = rumCur(id, 'draw'); if (!x) return; const { r, s } = x; let c;
  if (from === 'd') { if (!r.disc.length) return; c = r.disc.pop(); r.took = c; }
  else {
    if (!r.stock.length) { const top = r.disc.pop(); r.stock = rumShuffle(r.disc); r.disc = top ? [top] : []; }
    if (!r.stock.length) return rumEnd(r, null);
    c = r.stock.pop();
  }
  s.hand.push(c); r.ph = 'play'; rumPush(r);
}
function rumUndo(id) {
  const x = rumCur(id, 'play'); if (!x) return; const { r, s } = x;
  if (!r.took || s.opened) return;
  s.hand = s.hand.filter(c => c !== r.took); r.disc.push(r.took); r.took = null; r.ph = 'draw'; rumPush(r);
}
function rumParse(s, groups) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 8) return null;
  const used = new Set(), out = [];
  for (const g of groups) {
    if (!Array.isArray(g)) return null; const cs = [];
    for (const cid of g) { const c = s.hand.find(h => h.id === +cid); if (!c || used.has(c.id)) return null; used.add(c.id); cs.push(c); }
    const m = RM.meld(cs); if (!m) return null; out.push({ cs, m });
  }
  return out;
}
function rumLay(id, d) {          // منع (أول مرة، بالحلان) أو تنزيل تشكيلات بعد المنع
  const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
  const ps = rumParse(s, d.groups); if (!ps) return rumErr(id, 'تشكيلة غالطة');
  const tot = ps.reduce((a, p) => a + p.m.pts, 0), used = ps.reduce((a, p) => a + p.cs.length, 0);
  if (!s.opened) {
    if (tot < r.min) return rumErr(id, `الحلان لازم ${r.min} وانت عندك ${tot}`);
    if (s.hand.length - used <= 1 && !ps.some(p => p.cs.length >= 4)) return rumErr(id, 'الفرشة لازم فيها باكو 4 ولا 5 على الأقل');
    s.opened = true; r.min = tot + 1;
  }
  const u = new Set();
  ps.forEach(p => { r.melds.push({ o: i, cards: p.m.ord, k: p.m.k }); r.laid.push({ n: p.cs.length }); p.cs.forEach(c => u.add(c.id)); });
  s.hand = s.hand.filter(c => !u.has(c.id));
  if (!s.hand.length) return rumEnd(r, i);
  rumPush(r);
}
function rumPlace(id, d) {        // بلاص + هزان الجوكر (لازم مانع)
  const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
  if (!s.opened) return rumErr(id, 'لازم تمنع قبل ما تبلّص');
  const m = r.melds[+d.meld]; if (!m || !Array.isArray(d.cards)) return rumErr(id, 'باكو غالط');
  for (const cid of d.cards) {
    const c = s.hand.find(h => h.id === +cid); if (!c) break;
    const sw = RM.trySwap(m, c);
    if (sw) { m.cards = sw.r.ord; m.k = sw.r.k; s.hand = s.hand.filter(h => h !== c); s.hand.push(sw.j); send(sockets.get(id), { type: 'rum:note', text: 'هزيت الجوكر 🃏' }); continue; }
    const rr = RM.meld([...m.cards, c]); if (!rr) { rumErr(id, 'الورقة ما تنجمش تتبلاص هنا'); break; }
    m.cards = rr.ord; m.k = rr.k; s.hand = s.hand.filter(h => h !== c);
  }
  if (!s.hand.length) return rumEnd(r, i);
  rumPush(r);
}
function rumDiscard(id, d) {
  const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
  const c = s.hand.find(h => h.id === +d.card); if (!c) return rumErr(id, 'اختار ورقة باش تطيّشها');
  if (r.took && !s.opened) return rumErr(id, 'هزيت المطيشة: لازم تمنع بيها ولا ترجّعها');
  if (s.hand.length === 1 && !r.wasOpen && !r.laid.some(l => l.n >= 4)) return rumErr(id, 'ما تنجمش تفرش: لازم باكو فيه 4 ولا 5');
  s.hand = s.hand.filter(h => h !== c); r.disc.push(c);
  if (!s.hand.length) return rumEnd(r, i);
  rumAdvance(r);
}
function rumFlush(id) {           // فرشت 🏁 — السيرفر يثبت، وإلا 100 وتخرج من الجولة
  const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
  const ms = RM.solve(s.hand, true), used = new Set(ms.flat().map(c => c.id));
  const all = [...r.melds.map(m => ({ ...m, cards: [...m.cards] })), ...ms.map(g => { const m = RM.meld(g); return { o: i, cards: m.ord, k: m.k }; })];
  const left = s.hand.filter(c => !used.has(c.id)).filter(c => {
    for (const m of all) { const rr = RM.meld([...m.cards, c]); if (rr) { m.cards = rr.ord; m.k = rr.k; return false; } }
    return true;
  });
  if (left.length > 1 || (!r.wasOpen && !ms.some(g => g.length >= 4))) {
    s.score += 100; s.out = true; r.stock.unshift(...s.hand); s.hand = [];
    send(sockets.get(id), { type: 'rum:note', text: (left.length > 1 ? `فرشة غالطة ❌ باقيلك ${left.length} ورقات ما تتبلاصش` : 'فرشة غالطة ❌ لازم باكو فيه 4 ولا 5') + ' — أخذت 100 وتستنى الجولة تكمل' });
    return rumAdvance(r);
  }
  r.melds = all; s.opened = true; s.hand = []; if (left[0]) r.disc.push(left[0]);
  rumEnd(r, i);
}
function rumEnd(r, w) {           // w = فهرس الفارش، أو null (الورق وفى)
  r.rows = r.seats.map((s, i) => {
    if (s.dead) return null;
    let d, note = '';
    if (i === w) { d = -10; note = 'فرش 🏆'; }
    else if (s.out) { d = 0; note = s.left ? 'غادر (أخذ 100)' : 'غلط في الفرشة (أخذ 100)'; }
    else if (!s.opened) d = 100;
    else d = s.hand.reduce((a, c) => a + RM.hv(c), 0);
    s.score += d; return { name: s.name, d, score: s.score, note };
  }).filter(Boolean);
  r.starterId = w != null ? r.seats[w].id : (r.seats[r.turn] || {}).id;
  r.seats.forEach(s => { if (s.score >= 300) s.dead = true; s.out = false; });
  r.seats = r.seats.filter(s => !s.left);
  if (!r.seats.some(s => s.id === r.hostId) && r.seats[0]) r.hostId = r.seats[0].id;
  const alive = r.seats.filter(s => !s.dead);
  r.over = alive.length <= Math.max(1, r.n - 2) || r.seats.length < 2;
  if (r.over) {
    const pool = alive.length ? alive : r.seats, best = pool.slice().sort((a, b) => a.score - b.score)[0];
    r.winner = best ? best.name : ''; r.status = 'end';
  } else r.status = 'round';
  r.ready = new Set(); rumPush(r);
}
function rumNextRound(id) {
  const r = rumOf(id); if (!r || r.status !== 'round') return;
  r.ready.add(id);
  if (r.seats.filter(s => !s.dead).every(s => r.ready.has(s.id))) {
    let st = r.seats.findIndex(s => s.id === r.starterId && !s.dead);
    if (st < 0) st = r.seats.findIndex(s => !s.dead);
    return rumDeal(r, st);
  }
  rumPush(r);
}
function rumLeave(id) {
  const r = rumOf(id); if (!r) return;
  const i = r.seats.findIndex(s => s.id === id), s = r.seats[i];
  if (r.status === 'play') {      // خرج في نص الجولة: 100 وكفو يرجع للكومة
    s.left = true; s.out = true; s.score += 100; r.stock.unshift(...s.hand); s.hand = [];
    if (r.seats.filter(rumActive).length < 2) return rumEnd(r, null);
    return r.turn === i ? rumAdvance(r) : rumPush(r);
  }
  r.seats.splice(i, 1);
  if (!r.seats.length) return void RUM.delete(r.id);
  if (r.hostId === id) r.hostId = r.seats[0].id;
  if (r.status === 'round' && r.seats.filter(x => !x.dead).length < 2) { r.over = true; r.status = 'end'; r.winner = (r.seats.find(x => !x.dead) || r.seats[0]).name; }
  rumPush(r);
}
// RUMMY-END

/* ================= الاتصال ================= */
wss.on('connection', ws => {
  const id = 'p_' + Math.random().toString(36).slice(2, 8);
  ws.playerId = id; ws.alive = true;
  sockets.set(id, ws);
  ws.on('pong', () => (ws.alive = true));

  send(ws, { type: 'init', id });
  players.forEach(p => send(ws, { type: 'player:join', player: p }));

  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    switch (d.type) {
      case 'join': {
        const p = { id, name: String(d.name || 'ضيف').slice(0, 14), color: String(d.color || '#e74c3c').slice(0, 9), x: 0, z: 2, ry: 0, s: 0 };
        players.set(id, p);
        broadcast({ type: 'player:join', player: p }, id);
        break;
      }
      case 'move': {
        const p = players.get(id); if (!p) break;
        p.x = Math.max(-14, Math.min(14, +d.x || 0));
        p.z = Math.max(-6, Math.min(9, +d.z || 0));
        p.ry = +d.ry || 0; p.s = d.s ? 1 : 0;
        broadcast({ type: 'player:move', id, x: p.x, y: 0, z: p.z, ry: p.ry, s: p.s }, id);
        break;
      }
      case 'chat': {
        const p = players.get(id);
        const text = String(d.text || '').trim().slice(0, 80);
        if (p && text) broadcast({ type: 'chat', id, name: p.name, text });
        break;
      }
      case 'signal':
        wss.clients.forEach(c => { if (c.playerId === d.to) send(c, { type: 'signal', from: id, data: d.data }); });
        break;
      case 'shk:join':    if (players.has(id)) shkJoin(id, 'shk:' + String(d.room || '').slice(0, 40)); break;
      case 'shk:play':    shkPlay(id, d); break;
      case 'shk:next':    shkNext(id); break;
      case 'shk:goal':    shkGoal(id, +d.goal); break;
      case 'shk:again':   shkAgain(id); break;
      case 'shk:leave':   shkLeave(id); break;
      case 'chess:join':   if (players.has(id)) chessJoin(id, String(d.room || '').slice(0, 40)); break;
      case 'chess:move':   chessMove(id, d); break;
      case 'chess:resign': chessResign(id); break;
      case 'chess:again':  chessAgain(id); break;
      case 'chess:draw':   chessDraw(id, 'offer'); break;
      case 'chess:accept': chessDraw(id, 'accept'); break;
      case 'chess:decline':chessDraw(id, 'decline'); break;
      case 'chess:leave':  chessLeave(id); break;
      case 'rum:join':    if (players.has(id)) rumJoin(id, String(d.room || '').slice(0, 40)); break;
      case 'rum:start':   rumStart(id); break;
      case 'rum:draw':    rumDraw(id, d.from); break;
      case 'rum:undo':    rumUndo(id); break;
      case 'rum:open':
      case 'rum:lay':     rumLay(id, d); break;
      case 'rum:place':   rumPlace(id, d); break;
      case 'rum:discard': rumDiscard(id, d); break;
      case 'rum:flush':   rumFlush(id); break;
      case 'rum:next':    rumNextRound(id); break;
      case 'rum:again':   rumAgain(id); break;
      case 'rum:leave':   rumLeave(id); break;
    }
  });

  ws.on('close', () => {
    chessLeave(id); shkLeave(id); rumLeave(id);
    sockets.delete(id); players.delete(id);
    broadcast({ type: 'player:leave', id });
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
}, 30000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('listening ' + PORT));

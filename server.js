// Café Life server — اللاعبون + الصوت + الدردشة + الشطرنج + الشكبة + الشكبة التونسية
// التثبيت:  npm i express cors ws chess.js@1
const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Café Life Server running'));
app.get('/version', (req, res) => res.send('chess-v1 OK'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const players = new Map();   // id -> بيانات اللاعب
const sockets = new Map();   // id -> ws

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
function broadcast(o, excludeId = null) {
  const msg = JSON.stringify(o);
  wss.clients.forEach(c => { if (c.readyState === 1 && c.playerId !== excludeId) c.send(msg); });
}
const nameOf = id => (players.get(id) || {}).name || 'لاعب';

/* ================= الشطرنج ================= */
const TIME = 10 * 60 * 1000;
const rooms = new Map();
const is = (c, a, b) => (c[a] ? c[a]() : c[b]());

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

/* ================= الشكبة القديمة (40 كارطة بأخذ ومجموع) ================= */
const SHK_GOAL = 11;
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
  return { id, a: null, b: null, spec: new Set(), status: 'wait', score: { a: 0, b: 0 }, first: 'b', ready: new Set(), summary: null, winner: null, forfeit: null,
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
  add('البرمولة (السبعات ثم الستات)', A.s7 + '/' + A.s6, B.s7 + '/' + B.s6, w(A.s7, B.s7) || w(A.s6, B.s6));
  lines.push({ k: 'الشكبة', a: r.sk.a, b: r.sk.b, w: null }); pts.a += r.sk.a; pts.b += r.sk.b;
  return { lines, pts };
}
function shkFinish(r) {
  const s = shkScore(r); r.summary = s;
  r.score.a += s.pts.a; r.score.b += s.pts.b;
  const A = r.score.a, B = r.score.b;
  if ((A >= SHK_GOAL || B >= SHK_GOAL) && A !== B) { r.status = 'end'; r.winner = A > B ? 'a' : 'b'; } else r.status = 'round';
  r.ready.clear();
}
function shkPush(r) {
  const ids = [r.a, r.b, ...r.spec].filter(Boolean);
  const base = {
    type: 'shk:state', room: r.id, status: r.status, table: r.table, score: r.score, names: { a: r.a ? nameOf(r.a) : '', b: r.b ? nameOf(r.b) : '' },
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

/* ================= الشكبة التونسية (40 كارطة) ================= */
// 1v1 — 40 كارطة (1→7 + J + Q + K) في 4 أنواع
// النقاط: الحية + الديناري + البرميلة + الكارطة + الشكبات
const SKB_GOAL = 11;
const skb = new Map();
const SKB_SUITS = ['d', 'c', 's', 'b']; // ♦ ♥ ♠ ♣
const SKB_VALS = [1, 2, 3, 4, 5, 6, 7, 11, 12, 13]; // 11=J 12=Q 13=K

function skbNewDeck() {
  const d = [];
  SKB_SUITS.forEach(s => SKB_VALS.forEach(v => d.push(s + v)));
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const skbVal = c => +c.slice(1);
const skbSuit = c => c[0];

function skbNewRoom(id) {
  return {
    id, a: null, b: null, spec: new Set(), status: 'wait', score: { a: 0, b: 0 }, goal: SKB_GOAL,
    hand: { a: [], b: [] }, table: [], cap: { a: [], b: [] }, flipped: { a: [], b: [] }, sk: { a: 0, b: 0 },
    deck: [], turn: 'a', last: null, summary: null, winner: null, forfeit: null, ready: new Set(), firstTurn: 'a', lastTaker: null
  };
}
function skbDeal(r) { r.hand.a = r.deck.splice(0, 3); r.hand.b = r.deck.splice(0, 3); }
function skbStartRound(r) {
  r.deck = skbNewDeck(); r.table = r.deck.splice(0, 4);
  r.cap = { a: [], b: [] }; r.flipped = { a: [], b: [] }; r.sk = { a: 0, b: 0 };
  r.last = null; r.summary = null; r.winner = null; r.forfeit = null; r.ready.clear(); r.lastTaker = null;
  skbDeal(r); r.turn = r.firstTurn; r.status = 'play';
}
function skbEatOptions(table, cardValue) {
  const same = table.filter(c => skbVal(c) === cardValue);
  if (same.length) return same.map(c => [c]);
  const res = [], n = table.length;
  for (let m = 1; m < (1 << n); m++) {
    let sum = 0; const set = [];
    for (let i = 0; i < n; i++) if (m & (1 << i)) { sum += skbVal(table[i]); set.push(table[i]); }
    if (sum === cardValue && set.length >= 2) res.push(set);
  }
  return res;
}
function skbOf(id) { for (const r of skb.values()) if (r.a === id || r.b === id || r.spec.has(id)) return r; return null; }
function skbScore(r) {
  const all = p => r.cap[p].concat(r.flipped[p]); // القلب علامة فقط — الكل يتحسب
  const cnt = p => {
    const c = all(p);
    return { n: c.length, d: c.filter(x => skbSuit(x) === 'd').length, s7: c.filter(x => skbVal(x) === 7).length, s6: c.filter(x => skbVal(x) === 6).length, hasD7: c.includes('d7') };
  };
  const A = cnt('a'), B = cnt('b'), pts = { a: 0, b: 0 }, lines = [];
  const win = (x, y) => (x > y ? 'a' : y > x ? 'b' : null);
  const add = (k, a, b, w) => { if (w) pts[w]++; lines.push({ k, a, b, w }); };
  add('الحية (7♦)', A.hasD7 ? '✅' : '❌', B.hasD7 ? '✅' : '❌', A.hasD7 && !B.hasD7 ? 'a' : B.hasD7 && !A.hasD7 ? 'b' : null);
  add('الديناري (♦)', A.d, B.d, (A.d > 5 && B.d <= 5) ? 'a' : (B.d > 5 && A.d <= 5) ? 'b' : null);
  let bramW = win(A.s7, B.s7) || win(A.s6, B.s6);
  add('البرميلة (سبعات/ستات)', A.s7 + '/' + A.s6, B.s7 + '/' + B.s6, bramW);
  add('الكارطة (>20)', A.n, B.n, (A.n > 20 && B.n <= 20) ? 'a' : (B.n > 20 && A.n <= 20) ? 'b' : null);
  lines.push({ k: 'الشكبات', a: r.sk.a, b: r.sk.b, w: null });
  pts.a += r.sk.a; pts.b += r.sk.b;
  return { lines, pts };
}
function skbFinishRound(r) {
  const s = skbScore(r); r.summary = s;
  r.score.a += s.pts.a; r.score.b += s.pts.b;
  const A = r.score.a, B = r.score.b;
  if ((A >= r.goal || B >= r.goal) && A !== B) { r.status = 'end'; r.winner = A > B ? 'a' : 'b'; } else r.status = 'round';
  r.ready.clear();
}
function skbPush(r) {
  const ids = [r.a, r.b, ...r.spec].filter(Boolean);
  const base = {
    type: 'skb:state', room: r.id, status: r.status, table: r.table, score: r.score, goal: r.goal,
    names: { a: r.a ? nameOf(r.a) : '', b: r.b ? nameOf(r.b) : '' }, turn: r.turn, deck: r.deck.length,
    nHand: { a: r.hand.a.length, b: r.hand.b.length },
    taken: { a: r.cap.a.length + r.flipped.a.length, b: r.cap.b.length + r.flipped.b.length },
    sk: r.sk, last: r.last, summary: r.summary, winner: r.winner, forfeit: r.forfeit, ready: [...r.ready]
  };
  ids.forEach(id => {
    const you = id === r.a ? 'a' : id === r.b ? 'b' : 's';
    const hand = you === 's' ? [] : r.hand[you];
    const flipped = you === 's' ? [] : r.flipped[you];
    const cap = you === 's' ? [] : r.cap[you];
    let opts = null;
    if (r.status === 'play' && you === r.turn) { opts = {}; hand.forEach(c => { opts[c] = skbEatOptions(r.table, skbVal(c)); }); }
    send(sockets.get(id), { ...base, you, hand, cap, flipped, opts });
  });
}
function skbJoin(id, roomId) {
  skbLeave(id);
  let r = skb.get(roomId);
  if (!r) { r = skbNewRoom(roomId); skb.set(roomId, r); }
  if (!r.a) r.a = id; else if (!r.b) r.b = id; else r.spec.add(id);
  if (r.a && r.b && r.status === 'wait') { r.score = { a: 0, b: 0 }; r.firstTurn = 'a'; skbStartRound(r); }
  skbPush(r);
}
function skbPlay(id, d) {
  const r = skbOf(id); if (!r || r.status !== 'play') return;
  const who = r.a === id ? 'a' : r.b === id ? 'b' : null;
  if (!who || r.turn !== who) return;
  const card = String(d.card), hand = r.hand[who];
  if (!hand.includes(card)) return;
  const opts = skbEatOptions(r.table, skbVal(card));
  const take = Array.isArray(d.take) ? d.take.map(String) : [];
  let chosen = null;
  if (opts.length) {
    chosen = opts.find(o => o.length === take.length && o.every(c => take.includes(c)));
    if (!chosen) return send(sockets.get(id), { type: 'skb:err', text: 'اختيار الأخذ غير صحيح' });
  } else if (take.length) return send(sockets.get(id), { type: 'skb:err', text: 'لا يمكن الأخذ بهذه الورقة' });

  hand.splice(hand.indexOf(card), 1);
  const lastPlay = r.deck.length === 0 && r.hand.a.length === 0 && r.hand.b.length === 0;
  let shkba = false;
  if (chosen) {
    r.table = r.table.filter(c => !chosen.includes(c));
    r.cap[who].push(card, ...chosen);
    if (!r.table.length && !lastPlay) {
      r.sk[who]++; shkba = true;
      r.flipped[who].push(card); // علامة بصرية فقط — تبقى تتحسب في skbScore
    }
  } else {
    r.table.push(card);
  }
  r.last = { who, card, take: chosen || [], shkba };
  if (chosen) r.lastTaker = who;

  if (r.hand.a.length === 0 && r.hand.b.length === 0) {
    if (r.deck.length) { skbDeal(r); r.turn = who === 'a' ? 'b' : 'a'; }
    else {
      if (r.table.length) { const taker = r.lastTaker || who; r.cap[taker].push(...r.table); r.table = []; }
      skbFinishRound(r);
    }
  } else r.turn = who === 'a' ? 'b' : 'a';
  skbPush(r);
}
function skbNext(id) {
  const r = skbOf(id); if (!r || r.status !== 'round') return;
  r.ready.add(r.a === id ? 'a' : 'b');
  if (r.ready.has('a') && r.ready.has('b')) { r.firstTurn = r.firstTurn === 'a' ? 'b' : 'a'; skbStartRound(r); }
  skbPush(r);
}
function skbAgain(id) {
  const r = skbOf(id); if (!r || r.status !== 'end' || !r.a || !r.b) return;
  r.score = { a: 0, b: 0 }; r.firstTurn = 'a'; skbStartRound(r); skbPush(r);
}
function skbLeave(id) {
  for (const [rid, r] of skb) {
    if (!(r.a === id || r.b === id || r.spec.has(id))) continue;
    r.spec.delete(id);
    if (r.a === id || r.b === id) {
      const slot = r.a === id ? 'a' : 'b', other = slot === 'a' ? 'b' : 'a';
      if (r.status === 'play' || r.status === 'round') { r.status = 'end'; r.winner = r[other] ? other : null; r.forfeit = `انسحب ${nameOf(id)}`; r.summary = null; }
      else if (r.status !== 'end') r.status = 'wait';
      r[slot] = null;
      if (!r.a && r.b) {
        r.a = r.b; r.b = null; r.score = { a: r.score.b, b: r.score.a };
        if (r.winner) r.winner = 'a';
        r.hand = { a: r.hand.b, b: [] }; r.cap = { a: r.cap.b, b: [] };
        r.flipped = { a: r.flipped.b, b: [] }; r.sk = { a: r.sk.b, b: 0 };
      }
    }
    if (!r.a && !r.b && r.spec.size === 0) skb.delete(rid); else skbPush(r);
  }
}

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
      case 'shk:again':   shkAgain(id); break;
      case 'shk:leave':   shkLeave(id); break;
      case 'skb:join':    if (players.has(id)) skbJoin(id, 'skb:' + String(d.room || '').slice(0, 40)); break;
      case 'skb:play':    skbPlay(id, d); break;
      case 'skb:next':    skbNext(id); break;
      case 'skb:again':   skbAgain(id); break;
      case 'skb:leave':   skbLeave(id); break;
      case 'chess:join':   if (players.has(id)) chessJoin(id, String(d.room || '').slice(0, 40)); break;
      case 'chess:move':   chessMove(id, d); break;
      case 'chess:resign': chessResign(id); break;
      case 'chess:again':  chessAgain(id); break;
      case 'chess:draw':   chessDraw(id, 'offer'); break;
      case 'chess:accept': chessDraw(id, 'accept'); break;
      case 'chess:decline':chessDraw(id, 'decline'); break;
      case 'chess:leave':  chessLeave(id); break;
    }
  });

  ws.on('close', () => {
    chessLeave(id); shkLeave(id); skbLeave(id);
    sockets.delete(id); players.delete(id);
    broadcast({ type: 'player:leave', id });
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
}, 30000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('listening ' + PORT));

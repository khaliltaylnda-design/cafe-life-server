// Café Life Server — اللاعبون + الصوت + الدردشة + الشطرنج + الشكبة + الرامي
// التثبيت: npm i express cors ws chess.js@1
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Café Life Server running'));
app.get('/version', (req, res) => res.send('chess-v2 + shk + r7 OK'));
app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  players: players.size,
  chessRooms: rooms.size,
  shkRooms: shk.size,
  r7Rooms: r7.size
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const players = new Map();
const sockets = new Map();

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
      if (!r.w && r.b) { r.w = r.b; r.b = null; resetBoard(r); }
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

/* ================= الشكبة ================= */
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
  const cnt = p => { const c = r.cap[p]; return { n: c.length, d: c.filter(x => x[0] === 'd').length, s7: c.filter(x => val(x) === 7).length, z: c.includes('d7') ? 1 : 0 }; };
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

/* ================= الرامي (Rami) ================= */
const r7 = new Map();

const R7 = {
  SUITS: ['S', 'H', 'D', 'C'],
  RANKS: ['1','2','3','4','5','6','7','8','9','10','J','Q','K'],
  HAND_SIZE: 14,
  BASE_MIN: 51,
  TARGET_SOLO: 300,
  TARGET_TEAM: 600,
  PENALTY_NO_MELD: 100,
  PENALTY_JOKER_IN_HAND: 20,
  FRESH_BONUS_SOLO: -10,
  FRESH_BONUS_TEAM: -20,
  MAX_PLAYERS: 4
};

const RANK_ORDER = ['1','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RANK_INDEX = Object.fromEntries(RANK_ORDER.map((r,i)=>[r,i]));

let r7CardId = 0;
function makeCard(suit, rank) { return { id: 'c' + (++r7CardId), suit, rank, joker: false }; }
function makeJoker() { return { id: 'c' + (++r7CardId), suit: 'J', rank: 'JK', joker: true }; }

function buildR7Deck() {
  const d = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const s of R7.SUITS) for (const r of R7.RANKS) d.push(makeCard(s, r));
  }
  for (let i = 0; i < 4; i++) d.push(makeJoker());
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function baseVal(rank) {
  if (rank === '1') return 10;
  if (['J','Q','K'].includes(rank)) return 10;
  return parseInt(rank) || 0;
}

function isGroup(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const nonJoker = cards.filter(c => !c.joker);
  const jokers = cards.length - nonJoker.length;
  if (nonJoker.length === 0) return false;
  const rank = nonJoker[0].rank;
  if (!nonJoker.every(c => c.rank === rank)) return false;
  const suits = new Set();
  for (const c of nonJoker) {
    if (suits.has(c.suit)) return false;
    suits.add(c.suit);
  }
  if (nonJoker.length + jokers > 4) return false;
  return true;
}

function isSequence(cards) {
  if (cards.length < 3) return false;
  const nonJoker = cards.filter(c => !c.joker);
  const jokers = cards.length - nonJoker.length;
  if (nonJoker.length === 0) return false;
  const suit = nonJoker[0].suit;
  if (!nonJoker.every(c => c.suit === suit)) return false;
  const sorted = [...nonJoker].sort((a,b) => RANK_INDEX[a.rank] - RANK_INDEX[b.rank]);
  const indices = sorted.map(c => RANK_INDEX[c.rank]);
  for (let i = 1; i < indices.length; i++) if (indices[i] === indices[i-1]) return false;
  let gaps = 0;
  for (let i = 1; i < indices.length; i++) gaps += indices[i] - indices[i-1] - 1;
  if (gaps > jokers) return false;
  const minIdx = indices[0] - Math.floor((jokers - gaps) / 2);
  const maxIdx = indices[indices.length-1] + Math.ceil((jokers - gaps) / 2);
  if (maxIdx - minIdx + 1 > 13) return false;
  return true;
}

function isMeld(cards) { return isGroup(cards) || isSequence(cards); }

function scoreInitialMeld(cards) {
  if (isGroup(cards)) {
    const nonJoker = cards.filter(c => !c.joker);
    return baseVal(nonJoker[0].rank) * cards.length;
  }
  if (isSequence(cards)) {
    const nonJoker = cards.filter(c => !c.joker);
    const sorted = [...nonJoker].sort((a,b) => RANK_INDEX[a.rank] - RANK_INDEX[b.rank]);
    const hasAce = sorted.some(c => c.rank === '1');
    const isSmallSeq = hasAce && sorted.every(c => RANK_INDEX[c.rank] <= RANK_INDEX['4']);
    const avgVal = isSmallSeq ? 2 : 10;
    let total = 0;
    for (const c of cards) {
      if (c.joker) total += avgVal;
      else if (c.rank === '1') total += isSmallSeq ? 1 : 10;
      else total += baseVal(c.rank);
    }
    return total;
  }
  return 0;
}

function handPenalty(hand) {
  let total = 0;
  for (const c of hand) {
    if (c.joker) total += R7.PENALTY_JOKER_IN_HAND;
    else total += baseVal(c.rank);
  }
  return total;
}

function r7NewRoom(id, mode) {
  return {
    id, mode: mode === 'team' ? 'team' : 'solo',
    players: [],
    spec: new Set(),
    deck: [],
    discard: [],
    currentMin: R7.BASE_MIN,
    turnSeat: 0,
    dealerSeat: 0,
    status: 'wait',
    round: 0,
    lastAction: null,
    buyWindow: null,
    createdAt: Date.now()
  };
}

function r7Push(room) {
  const ids = [...room.players.map(p => p.id), ...room.spec].filter(Boolean);
  ids.forEach(pid => {
    const p = room.players.find(x => x.id === pid);
    const you = p ? p.seat : 's';
    send(sockets.get(pid), {
      type: 'r7:state',
      room: room.id,
      mode: room.mode,
      status: room.status,
      round: room.round,
      currentMin: room.currentMin,
      turnSeat: room.turnSeat,
      dealerSeat: room.dealerSeat,
      discardCount: room.discard.length,
      lastDiscard: room.discard.length ? room.discard[room.discard.length-1].card : null,
      discardTop: room.discard.slice(-5).map(d => d.card),
      deckCount: room.deck.length,
      you,
      hand: p ? p.hand : [],
      players: room.players.map(x => ({
        id: x.id, name: x.name, seat: x.seat,
        handCount: x.hand.length,
        melded: x.melded,
        alive: x.alive,
        bought: x.bought,
        deaths: x.deaths,
        score: x.score
      })),
      buyWindow: room.buyWindow,
      lastAction: room.lastAction
    });
  });
}

function r7Of(id) {
  for (const room of r7.values()) {
    if (room.players.some(p => p.id === id) || room.spec.has(id)) return room;
  }
  return null;
}

function r7Leave(id) {
  for (const [rid, room] of r7) {
    room.spec.delete(id);
    const idx = room.players.findIndex(p => p.id === id);
    if (idx >= 0) {
      const p = room.players[idx];
      if (room.status === 'play') {
        p.alive = false;
        p.score += R7.PENALTY_NO_MELD;
      }
      room.players.splice(idx, 1);
      room.players.forEach((pl, i) => pl.seat = i);
    }
    if (room.players.length === 0 && room.spec.size === 0) r7.delete(rid);
    else r7Push(room);
  }
}

function r7Join(id, roomId, mode) {
  if (!players.has(id)) return;
  r7Leave(id);
  let room = r7.get(roomId);
  if (!room) {
    room = r7NewRoom(roomId, mode || 'solo');
    r7.set(roomId, room);
  }
  if (room.players.length >= R7.MAX_PLAYERS) {
    room.spec.add(id);
    return r7Push(room);
  }
  if (room.status !== 'wait') {
    room.spec.add(id);
    return r7Push(room);
  }
  const seat = room.players.length;
  const p = {
    id, name: nameOf(id), seat,
    hand: [], melded: [],
    alive: true, bought: false, deaths: 0, score: 0
  };
  room.players.push(p);
  const need = room.mode === 'team' ? 4 : 2;
  if (room.players.length === need) r7StartRound(room);
  r7Push(room);
}

function r7StartRound(room) {
  room.deck = buildR7Deck();
  room.discard = [];
  room.currentMin = R7.BASE_MIN;
  room.status = 'play';
  room.round++;
  room.buyWindow = null;

  room.players.forEach(p => {
    p.hand = room.deck.splice(0, R7.HAND_SIZE);
    p.melded = [];
    p.alive = true;
  });

  const firstDiscard = room.deck.pop();
  if (firstDiscard) room.discard.push({ card: firstDiscard, bySeat: room.dealerSeat });

  room.turnSeat = (room.dealerSeat + 1) % room.players.length;

  room.lastAction = { type: 'roundStart', round: room.round };
  r7Push(room);
}

function r7Draw(id, source) {
  const room = r7Of(id);
  if (!room || room.status !== 'play') return;
  const p = room.players.find(x => x.id === id);
  if (!p || !p.alive || p.seat !== room.turnSeat) return;

  if (source === 'deck') {
    if (!room.deck.length) {
      const top = room.discard.pop();
      room.deck = room.discard.map(d => d.card);
      room.discard = top ? [top] : [];
      for (let i = room.deck.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
      }
    }
    if (!room.deck.length) return r7EndRound(room, null, 'deckEmpty');
    const card = room.deck.pop();
    p.hand.push(card);
    room.lastAction = { type: 'drawDeck', seat: p.seat };
  } else if (source === 'discard') {
    if (!room.discard.length) return;
    const last = room.discard[room.discard.length - 1];
    if (last.bySeat === p.seat) return;
    p.hand.push(last.card);
    room.discard.pop();
    room.lastAction = { type: 'drawDiscard', seat: p.seat };
  }
  r7Push(room);
}

function r7Meld(id, cardIds) {
  const room = r7Of(id);
  if (!room || room.status !== 'play') return;
  const p = room.players.find(x => x.id === id);
  if (!p || !p.alive || p.seat !== room.turnSeat) return;

  const cards = cardIds.map(cid => p.hand.find(c => c.id === cid)).filter(Boolean);
  if (cards.length !== cardIds.length) return;
  if (!isMeld(cards)) return send(sockets.get(id), { type: 'r7:err', text: 'تمنيع غير صحيح' });

  const isFirstMeld = p.melded.length === 0;
  const meldScore = scoreInitialMeld(cards);

  if (isFirstMeld && meldScore < room.currentMin) {
    return send(sockets.get(id), {
      type: 'r7:err',
      text: `النزول الأول يحتاج ${room.currentMin} على الأقل (عندك ${meldScore})`
    });
  }

  cardIds.forEach(cid => {
    const idx = p.hand.findIndex(c => c.id === cid);
    if (idx >= 0) p.hand.splice(idx, 1);
  });
  p.melded.push({
    type: isGroup(cards) ? 'group' : 'seq',
    cards,
    score: meldScore
  });

  const newMin = meldScore + 1;
  if (newMin > room.currentMin) room.currentMin = newMin;

  room.lastAction = { type: 'meld', seat: p.seat, score: meldScore };

  if (p.hand.length === 0) return r7EndRound(room, p.seat, 'fresh');

  r7Push(room);
}

function r7Discard(id, cardId) {
  const room = r7Of(id);
  if (!room || room.status !== 'play') return;
  const p = room.players.find(x => x.id === id);
  if (!p || !p.alive || p.seat !== room.turnSeat) return;

  const idx = p.hand.findIndex(c => c.id === cardId);
  if (idx < 0) return;
  const card = p.hand.splice(idx, 1)[0];
  room.discard.push({ card, bySeat: p.seat });
  room.lastAction = { type: 'discard', seat: p.seat, card };

  if (p.hand.length === 0) return r7EndRound(room, p.seat, 'fresh');

  room.turnSeat = (room.turnSeat + 1) % room.players.length;
  let safety = 0;
  while (!room.players[room.turnSeat].alive && safety < room.players.length) {
    room.turnSeat = (room.turnSeat + 1) % room.players.length;
    safety++;
  }
  r7Push(room);
}

function r7EndRound(room, winnerSeat, reason) {
  room.status = 'roundEnd';
  const players = room.players;
  const deltas = players.map(p => ({ seat: p.seat, delta: 0 }));

  if (reason === 'fresh') {
    if (room.mode === 'solo') {
      const w = deltas.find(d => d.seat === winnerSeat);
      if (w) w.delta = R7.FRESH_BONUS_SOLO;
    } else {
      const winnerTeam = winnerSeat % 2;
      deltas.forEach(d => { if (d.seat % 2 === winnerTeam) d.delta = R7.FRESH_BONUS_TEAM / 2; });
    }
  } else {
    players.forEach(p => {
      if (p.seat === winnerSeat) return;
      let penalty = 0;
      if (p.melded.length === 0) penalty = R7.PENALTY_NO_MELD;
      else penalty = handPenalty(p.hand);
      deltas.find(d => d.seat === p.seat).delta = penalty;
    });
  }

  if (room.mode === 'solo') {
    deltas.forEach(d => { const p = players.find(x => x.seat === d.seat); if (p) p.score += d.delta; });
  } else {
    for (let team = 0; team < 2; team++) {
      const teamDelta = deltas.filter(d => d.seat % 2 === team).reduce((s, d) => s + d.delta, 0);
      players.filter(p => p.seat % 2 === team).forEach(p => p.score += teamDelta);
    }
  }

  players.forEach(p => {
    const target = room.mode === 'solo' ? R7.TARGET_SOLO : R7.TARGET_TEAM;
    if (p.score >= target && p.alive) {
      p.alive = false;
      p.deaths++;
      if (room.mode === 'solo' && !p.bought && !room.buyWindow) {
        room.buyWindow = { seat: p.seat, deadline: Date.now() + 30000 };
      }
    }
  });

  if (room.mode === 'solo') {
    const deadCount = players.filter(p => !p.alive).length;
    if (deadCount >= 2) {
      room.status = 'end';
      const sorted = [...players].sort((a, b) => a.score - b.score);
      room.lastAction = { type: 'gameEnd', ranking: sorted.map(p => ({ seat: p.seat, name: p.name, score: p.score })) };
      r7Push(room);
      return;
    }
  } else {
    const team0Dead = players.filter(p => p.seat % 2 === 0).every(p => !p.alive);
    const team1Dead = players.filter(p => p.seat % 2 === 1).every(p => !p.alive);
    if (team0Dead || team1Dead) {
      room.status = 'end';
      r7Push(room);
      return;
    }
  }

  room.lastAction = { type: 'roundEnd', winnerSeat, reason, deltas };
  r7Push(room);

  if (room.buyWindow) {
    room.status = 'wait';
  } else {
    room.dealerSeat = winnerSeat;
    setTimeout(() => {
      if (room.status === 'wait' || room.status === 'roundEnd') r7StartRound(room);
    }, 5000);
  }
}

function r7Buy(id) {
  const room = r7Of(id);
  if (!room || !room.buyWindow) return;
  const p = room.players.find(x => x.id === id);
  if (!p || p.seat !== room.buyWindow.seat) return;

  const aliveScores = room.players.filter(x => x.alive).map(x => x.score);
  const maxAlive = aliveScores.length ? Math.max(...aliveScores) : 0;
  p.score = Math.max(0, maxAlive);
  p.bought = true;
  p.alive = true;
  p.deaths = 0;

  room.buyWindow = null;
  room.lastAction = { type: 'buy', seat: p.seat, newScore: p.score };
  r7Push(room);

  room.dealerSeat = p.seat;
  setTimeout(() => {
    if (room.status === 'wait' || room.status === 'roundEnd') r7StartRound(room);
  }, 2000);
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
    if (raw.length > 2048) return;
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
      case 'signal': {
        const target = sockets.get(d.to);
        if (target) send(target, { type: 'signal', from: id, data: d.data });
        break;
      }
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
      case 'r7:join':      if (players.has(id)) r7Join(id, 'r7:' + String(d.room || '').slice(0, 40), d.mode); break;
      case 'r7:draw':      r7Draw(id, d.source); break;
      case 'r7:meld':      r7Meld(id, d.cards || []); break;
      case 'r7:discard':   r7Discard(id, d.card); break;
      case 'r7:buy':       r7Buy(id); break;
      case 'r7:leave':     r7Leave(id); break;
    }
  });

  ws.on('close', () => {
    chessLeave(id); shkLeave(id); r7Leave(id);
    sockets.delete(id); players.delete(id);
    broadcast({ type: 'player:leave', id });
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
}, 30000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('listening ' + PORT));

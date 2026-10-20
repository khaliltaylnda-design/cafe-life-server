// Café Life server — اللاعبون + الصوت + الدردشة + الشطرنج (الخادم هو الحَكَم)
// التثبيت:  npm i express cors ws chess.js@1
const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');

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
    chessLeave(id);
    sockets.delete(id); players.delete(id);
    broadcast({ type: 'player:leave', id });
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
}, 30000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('listening ' + PORT));

// Café Life server — اللاعبون + الصوت + الدردشة + الشطرنج
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
const players = new Map();
const sockets = new Map();

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
function broadcast(o, excludeId = null) {
  const msg = JSON.stringify(o);
  wss.clients.forEach(c => { if (c.readyState === 1 && c.playerId !== excludeId) c.send(msg); });
}

/* ===== الشطرنج ===== */
const rooms = new Map();
const is = (c, a, b) => (c[a] ? c[a]() : c[b]());
const nameOf = id => (players.get(id) || {}).name || 'لاعب';

function newRoom(id) {
  return { id, chess: new Chess(), w: null, b: null, spec: new Set(), status: 'wait', result: '', last: null };
}
function legalMap(r) {
  const map = {};
  r.chess.moves({ verbose: true }).forEach(m => { (map[m.from] = map[m.from] || []).push(m.to); });
  return map;
}
function pushRoom(r) {
  const ids = [r.w, r.b, ...r.spec].filter(Boolean);
  const turn = r.chess.turn();
  const base = {
    type: 'chess:state', room: r.id, fen: r.chess.fen(), turn, status: r.status, result: r.result, last: r.last,
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
function resetBoard(r) {
  r.chess = new Chess(); r.last = null; r.result = '';
  r.status = r.w && r.b ? 'play' : 'wait';
}
function chessLeave(id) {
  for (const [rid, r] of rooms) {
    if (!(r.w === id || r.b === id || r.spec.has(id))) continue;
    r.spec.delete(id);
    if (r.w === id || r.b === id) {
      const slot = r.w === id ? 'w' : 'b';
      if (r.status === 'play') {
        r.status = 'end';
        r.result = `انسحب ${nameOf(id)}، فاز ${nameOf(slot === 'w' ? r.b : r.w)}`;
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
function chessJoin(id, roomId) {
  chessLeave(id);
  let r = rooms.get(roomId);
  if (!r) { r = newRoom(roomId); rooms.set(roomId, r); }
  if (r.status === 'end' && !r.w && !r.b) resetBoard(r);
  if (!r.w) r.w = id;
  else if (!r.b) r.b = id;
  else r.spec.add(id);
  if (r.w && r.b && r.status === 'wait') r.status = 'play';
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
  let res = null;
  try { res = r.chess.move({ from: String(m.from), to: String(m.to), promotion: 'q' }); } catch (e) { res = null; }
  if (!res) return send(sockets.get(id), { type: 'chess:err', text: 'حركة غير قانونية' });
  r.last = { from: res.from, to: res.to };
  if (is(r.chess, 'isCheckmate', 'in_checkmate')) {
    r.status = 'end';
    r.result = `كش مات! فاز ${nameOf(id)}`;
  } else if (is(r.chess, 'isDraw', 'in_draw')) {
    r.status = 'end'; r.result = 'تعادل 🤝';
  }
  pushRoom(r);
}
function chessResign(id) {
  const r = roomOf(id);
  if (!r || r.status !== 'play' || (r.w !== id && r.b !== id)) return;
  r.status = 'end';
  r.result = `انسحب ${nameOf(id)}، فاز ${nameOf(r.w === id ? r.b : r.w)}`;
  pushRoom(r);
}
function chessAgain(id) {
  const r = roomOf(id);
  if (!r || r.status !== 'end' || !r.w || !r.b) return;
  [r.w, r.b] = [r.b, r.w];
  resetBoard(r);
  pushRoom(r);
}

/* ===== الاتصال ===== */
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

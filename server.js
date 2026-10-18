// Café Life server — يعتمد نفس الحزم عندك: express, ws, cors
const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Café Life Server running'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const players = new Map();

const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
function broadcast(o, excludeId = null) {
  const msg = JSON.stringify(o);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.playerId !== excludeId) c.send(msg);
  });
}

wss.on('connection', ws => {
  const id = 'p_' + Math.random().toString(36).slice(2, 8);
  ws.playerId = id;
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  send(ws, { type: 'init', id });
  players.forEach(p => send(ws, { type: 'player:join', player: p }));

  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }

    if (d.type === 'join') {
      const p = {
        id,
        name: String(d.name || 'ضيف').slice(0, 14),
        color: String(d.color || '#e74c3c').slice(0, 9),
        x: 0, z: 2, ry: 0, s: 0
      };
      players.set(id, p);
      broadcast({ type: 'player:join', player: p }, id);
    } else if (d.type === 'move') {
      const p = players.get(id);
      if (!p) return;
      p.x = Math.max(-14, Math.min(14, +d.x || 0));
      p.z = Math.max(-6, Math.min(9, +d.z || 0));
      p.ry = +d.ry || 0;
      p.s = d.s ? 1 : 0;
      broadcast({ type: 'player:move', id, x: p.x, y: 0, z: p.z, ry: p.ry, s: p.s }, id);
    } else if (d.type === 'signal') {
      // تمرير إشارات WebRTC بين لاعبين (للصوت)
      wss.clients.forEach(c => {
        if (c.playerId === d.to) send(c, { type: 'signal', from: id, data: d.data });
      });
    } else if (d.type === 'chat') {
      const p = players.get(id);
      const text = String(d.text || '').trim().slice(0, 80);
      if (p && text) broadcast({ type: 'chat', id, name: p.name, text });
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'player:leave', id });
  });
});

// تنظيف الاتصالات الميتة كل 30 ثانية
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('listening ' + PORT));

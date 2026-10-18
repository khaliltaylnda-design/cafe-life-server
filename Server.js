// npm init -y && npm i ws   |   start: node server.js
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
let n = 0;
const P = new Map();
const send = (w, o) => w.readyState === 1 && w.send(JSON.stringify(o));
const all = (o, ex) => wss.clients.forEach(c => c !== ex && send(c, o));

wss.on('connection', ws => {
  const id = ++n;
  send(ws, { type: 'init', id });
  P.forEach(p => send(ws, { type: 'player:join', player: p }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const p = { id, name: String(m.name || 'ضيف').slice(0, 14), color: String(m.color || '#e74c3c').slice(0, 9), x: 0, z: 2, ry: 0 };
      P.set(id, p);
      all({ type: 'player:join', player: p }, ws);
    } else if (m.type === 'move' && P.has(id)) {
      const p = P.get(id);
      p.x = +m.x || 0; p.z = +m.z || 0; p.ry = +m.ry || 0;
      all({ type: 'player:move', id, x: p.x, y: 0, z: p.z, ry: p.ry }, ws);
    } else if (m.type === 'chat' && P.has(id)) {
      all({ type: 'chat', id, name: P.get(id).name, text: String(m.text || '').slice(0, 80) });
    }
  });

  ws.on('close', () => { P.delete(id); all({ type: 'player:leave', id }); });
});

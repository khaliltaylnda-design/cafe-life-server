// ============================================================
// Café Life Server v4.1 — سيرفر موحّد (لاعبون + صوت + دردشة + ألعاب)
// + عزل صوت بالسيرفر (voice.js) — السيرفر هو الحَكَم
// ============================================================

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const { WebSocketServer } = require('ws');

/* ---------- TURN / STUN ---------- */
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST   = process.env.TURN_HOST   || '49.13.227.251';
const TURN_PORT   = process.env.TURN_PORT   || 3478;
const TURN_TTL    = 12 * 3600;

function iceFor(id) {
  if (!TURN_SECRET) return [{ urls: 'stun:stun.l.google.com:19302' }];
  const username   = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${id}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
        `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`
      ],
      username, credential
    }
  ];
}

/* ---------- Express + HTTP ---------- */
const app = express();
app.use(cors());
app.get('/',        (_q, r) => r.send('Café Life Server running'));
app.get('/version', (_q, r) => r.send('cafe-v4.1 | turn ' + (TURN_SECRET ? 'ON' : 'OFF')));
app.get('/healthz', (_q, r) => r.status(200).send('ok'));

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const players = new Map();
const sockets = new Map();

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const broadcast = (o, ex = null) => {
  const msg = JSON.stringify(o);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.playerId !== ex) c.send(msg);
  });
};

/* ---------- تحميل الألعاب + الصوت بأمان ---------- */
const ctx = { send, sockets, players, broadcast, crypto };
const GAMES = [];

const gamesDir = fs.existsSync(path.join(__dirname, 'games'))
  ? path.join(__dirname, 'games')
  : __dirname;

for (const name of ['chess', 'shkobba', 'rummy', 'voice']) {
  const file = path.join(gamesDir, name + '.js');
  if (!fs.existsSync(file)) {
    console.warn(`⚠ Module missing: ${file} (skipped)`);
    continue;
  }
  try {
    GAMES.push(require(file)(ctx));
    console.log(`✔ Module loaded: ${name}`);
  } catch (e) {
    console.warn(`✘ Module failed: ${name} — ${e.message}`);
  }
}

// الحَكَم: مرجع مباشر للصوت (يستعمل في move/signal/join)
const VOICE = GAMES.find(g => g.prefix === 'voice:') || null;
if (!VOICE) console.warn('⚠ Voice module not loaded — الصوت غير معزول!');

/* ---------- WebSocket ---------- */
wss.on('connection', ws => {
  const id = 'p_' + Math.random().toString(36).slice(2, 8);
  ws.playerId = id;
  ws.alive    = true;
  sockets.set(id, ws);
  ws.on('pong', () => { ws.alive = true; });

  send(ws, { type: 'init', id, ice: iceFor(id) });
  players.forEach(p => send(ws, { type: 'player:join', player: p }));

  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d.type !== 'string') return;

    switch (d.type) {
      case 'join': {
        const p = {
          id,
          name:  String(d.name  || 'ضيف').slice(0, 14),
          color: String(d.color || '#e74c3c').slice(0, 9),
          x: 0, z: 2, ry: 0, s: 0
        };
        players.set(id, p);
        broadcast({ type: 'player:join', player: p }, id);
        // زامن الصوت: كي اللاعب قاعد فعلاً بعد إعادة اتصال
        if (VOICE && VOICE.handle) VOICE.handle(id, { type: 'voice:sync' });
        break;
      }
      case 'move': {
        const p = players.get(id); if (!p) break;
        p.x  = Math.max(-14, Math.min(14, +d.x || 0));
        p.z  = Math.max(-6,  Math.min(9,  +d.z || 0));
        p.ry = +d.ry || 0;
        p.s  = d.s ? 1 : 0;
        broadcast({ type: 'player:move', id, x: p.x, y: 0, z: p.z, ry: p.ry, s: p.s }, id);
        // الحَكَم يحسب الطاولة من الموقع
        if (VOICE) VOICE.onMove(id);
        break;
      }
      case 'chat': {
        const p = players.get(id);
        const text = String(d.text || '').trim().slice(0, 80);
        if (p && text) broadcast({ type: 'chat', id, name: p.name, text });
        break;
      }
      case 'signal': {
        // عزل: كان من نفس الطاولة فقط
        if (!VOICE || !VOICE.canSignal(id, d.to)) return;
        const dest = sockets.get(d.to);
        if (dest) send(dest, { type: 'signal', from: id, data: d.data });
        break;
      }
      default: {
        const g = GAMES.find(g => String(d.type).startsWith(g.prefix));
        if (g) g.handle(id, d);
      }
    }
  });

  ws.on('close', () => {
    GAMES.forEach(g => g.leave && g.leave(id));
    sockets.delete(id);
    players.delete(id);
    broadcast({ type: 'player:leave', id });
  });

  ws.on('error', e => console.error('WS error:', e.message));
});

/* ---------- Heartbeat ---------- */
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  });
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

/* ---------- Listen ---------- */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Café Life listening on ${PORT}`);
  console.log(`  TURN: ${TURN_SECRET ? 'ON' : 'OFF'} (${TURN_HOST})`);
  console.log(`  Modules: ${GAMES.length ? GAMES.map(g => g.prefix).join(', ') : '(none)'}`);
});

['SIGTERM', 'SIGINT'].forEach(sig =>
  process.on(sig, () => {
    console.log(`${sig} — shutting down`);
    clearInterval(heartbeat);
    wss.close();
    server.close(() => process.exit(0));
  })
);

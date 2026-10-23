// ============================================================
// Café Life Server v4 — سيرفر موحّد (لاعبون + صوت + دردشة + ألعاب)
// كل لعبة في مجلد games/ : chess.js · shkobba.js · rummy.js
// التثبيت: npm i
// ============================================================

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const { WebSocketServer } = require('ws');

/* ------------------------------------------------------------
 * 1) إعدادات TURN (للصوت) — الأسرار تُقرأ من متغيّرات البيئة
 * ---------------------------------------------------------- */
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST   = process.env.TURN_HOST   || '49.13.227.251';
const TURN_PORT   = process.env.TURN_PORT   || 3478;
const TURN_TTL    = 12 * 3600; // 12 ساعة

function iceFor(id) {
  if (!TURN_SECRET) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  const username   = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${id}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
        `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`
      ],
      username,
      credential
    }
  ];
}

/* ------------------------------------------------------------
 * 2) إعداد Express + HTTP Server
 * ---------------------------------------------------------- */
const app = express();
app.use(cors());

app.get('/', (_req, res) => res.send('Café Life Server running'));
app.get('/version', (_req, res) =>
  res.send('cafe-v4 modular: chess + shkobba + rummy OK | turn ' + (TURN_SECRET ? 'ON' : 'OFF'))
);
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

/* ------------------------------------------------------------
 * 3) الحالة العامة (Players / Sockets)
 * ---------------------------------------------------------- */
const players = new Map(); // id -> بيانات اللاعب
const sockets = new Map(); // id -> ws

/* ------------------------------------------------------------
 * 4) أدوات مساعدة
 * ---------------------------------------------------------- */
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj, excludeId = null) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.playerId !== excludeId) c.send(msg);
  });
}

/* ------------------------------------------------------------
 * 5) تحميل الألعاب — كل لعبة ترجّع { prefix, handle, leave }
 * ---------------------------------------------------------- */
const ctx = { send, sockets, players, broadcast, crypto };

const gamesDir = fs.existsSync(path.join(__dirname, 'games')) ? './games/' : './';
const GAMES = ['chess', 'shkobba', 'rummy'].map(name =>
  require(path.join(gamesDir, name))(ctx)
);

/* ------------------------------------------------------------
 * 6) WebSocket Connection Handler
 * ---------------------------------------------------------- */
wss.on('connection', ws => {
  const id = 'p_' + Math.random().toString(36).slice(2, 8);
  ws.playerId = id;
  ws.alive    = true;
  sockets.set(id, ws);

  ws.on('pong', () => { ws.alive = true; });

  // إرسال رسالة الترحيب + قائمة اللاعبين الحاليين
  send(ws, { type: 'init', id, ice: iceFor(id) });
  players.forEach(p => send(ws, { type: 'player:join', player: p }));

  /* ---------------- استقبال الرسائل ---------------- */
  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d.type !== 'string') return;

    switch (d.type) {
      /* --- انضمام لاعب جديد --- */
      case 'join': {
        const p = {
          id,
          name:  String(d.name  || 'ضيف').slice(0, 14),
          color: String(d.color || '#e74c3c').slice(0, 9),
          x: 0, z: 2, ry: 0, s: 0
        };
        players.set(id, p);
        broadcast({ type: 'player:join', player: p }, id);
        break;
      }

      /* --- حركة اللاعب --- */
      case 'move': {
        const p = players.get(id);
        if (!p) break;
        p.x  = Math.max(-14, Math.min(14, +d.x || 0));
        p.z  = Math.max(-6,  Math.min(9,  +d.z || 0));
        p.ry = +d.ry || 0;
        p.s  = d.s ? 1 : 0;
        broadcast(
          { type: 'player:move', id, x: p.x, y: 0, z: p.z, ry: p.ry, s: p.s },
          id
        );
        break;
      }

      /* --- دردشة --- */
      case 'chat': {
        const p = players.get(id);
        const text = String(d.text || '').trim().slice(0, 80);
        if (p && text) broadcast({ type: 'chat', id, name: p.name, text });
        break;
      }

      /* --- إشارات WebRTC (Signal) --- */
      case 'signal':
        wss.clients.forEach(c => {
          if (c.playerId === d.to) {
            send(c, { type: 'signal', from: id, data: d.data });
          }
        });
        break;

      /* --- أي رسالة أخرى تُوجّه للعبة المطابقة --- */
      default: {
        const game = GAMES.find(g => String(d.type).startsWith(g.prefix));
        if (game) game.handle(id, d);
      }
    }
  });

  /* ---------------- إغلاق الاتصال ---------------- */
  ws.on('close', () => {
    GAMES.forEach(g => g.leave(id));
    sockets.delete(id);
    players.delete(id);
    broadcast({ type: 'player:leave', id });
  });

  ws.on('error', err => console.error('WS error:', err.message));
});

/* ------------------------------------------------------------
 * 7) Heartbeat — كشف الاتصالات الميتة كل 30 ثانية
 * ---------------------------------------------------------- */
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

/* ------------------------------------------------------------
 * 8) تشغيل السيرفر
 * ---------------------------------------------------------- */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Café Life Server listening on port ${PORT}`);
  console.log(`  TURN: ${TURN_SECRET ? 'ON' : 'OFF'} (${TURN_HOST})`);
  console.log(`  Games: ${GAMES.map(g => g.prefix).join(', ')}`);
});

/* ------------------------------------------------------------
 * 9) إغلاق نظيف (SIGTERM / SIGINT — لـ Render/Heroku)
 * ---------------------------------------------------------- */
['SIGTERM', 'SIGINT'].forEach(sig =>
  process.on(sig, () => {
    console.log(`\n${sig} received — shutting down...`);
    clearInterval(heartbeat);
    wss.close();
    server.close(() => process.exit(0));
  })
);

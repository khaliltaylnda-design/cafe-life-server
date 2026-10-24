'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { Pool } = require('pg');
const createAuth = require('./auth');

// =====================================================
// Environment
// =====================================================

const PORT = Number(process.env.PORT || 10000);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '49.13.227.251';
const DATABASE_URL = process.env.DATABASE_URL || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const MAX_WS_PAYLOAD = 64 * 1024;
const AUTH_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 30000;

// =====================================================
// PostgreSQL
// =====================================================

let pool = null;
let authReady = false;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('[DB POOL]', err.message);
  });
} else {
  console.warn('[DB] DATABASE_URL is missing. Database is disabled.');
}

// =====================================================
// Auth module
// =====================================================

const auth = createAuth({
  pool,
  env: process.env,
  log: console,
});

// =====================================================
// Database initialization
// =====================================================

async function initializeDatabase() {
  if (!pool) return false;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT,
        google_sub TEXT UNIQUE,
        display_name VARCHAR(40) NOT NULL DEFAULT 'player',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await auth.ensureSchema();

    await pool.query(`
      SELECT id, display_name, color, coins, is_guest, token_version, status
      FROM users
      LIMIT 0
    `);

    console.log('[DB] Schema ready.');
    authReady = true;
    return true;
  } catch (err) {
    authReady = false;
    console.error('[DB] Initialization failed:', err.message);
    return false;
  }
}

// =====================================================
// TURN / WebRTC
// =====================================================

function iceFor(id) {
  if (!TURN_SECRET) return [];

  const username = Math.floor(Date.now() / 1000) + 12 * 3600 + ':' + id;

  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');

  return [{
    urls: [
      `turn:${TURN_HOST}:3478?transport=udp`,
      `turn:${TURN_HOST}:3478?transport=tcp`,
    ],
    username,
    credential,
  }];
}

// =====================================================
// Express
// =====================================================

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '20kb' }));

app.get('/', (_req, res) => {
  res.status(200).send('Cafe Life Server running');
});

app.get('/version', (_req, res) => {
  res.json({
    service: 'Cafe Life',
    version: '4.0.0',
    websocket: 'authenticated',
    turn: TURN_SECRET ? 'configured' : 'disabled',
    database: pool ? 'configured' : 'disabled',
    auth: authReady ? 'ready' : 'unavailable',
  });
});

app.get('/db-check', async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ ok: false, message: 'Database is not configured' });
  }

  try {
    await pool.query('SELECT 1');
    return res.status(200).json({ ok: true, message: 'Database connection successful' });
  } catch (err) {
    console.error('[DB CHECK]', err.message);
    return res.status(503).json({ ok: false, message: 'Database connection failed' });
  }
});

app.use('/auth', (_req, res, next) => {
  if (!authReady) {
    return res.status(503).json({ ok: false, error: 'auth_not_ready' });
  }
  next();
});

auth.register(app);

// =====================================================
// HTTP + WebSocket server
// =====================================================

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD,
  perMessageDeflate: false,
});

const players = new Map();
const sockets = new Map();

function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('[WS SEND]', err.message);
    return false;
  }
}

function broadcast(data, excludeId = null) {
  const message = JSON.stringify(data);

  for (const [id, ws] of sockets) {
    if (id === excludeId) continue;
    if (!ws.authenticated) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;

    try {
      ws.send(message);
    } catch (err) {
      console.error('[WS BROADCAST]', err.message);
    }
  }
}

// =====================================================
// Game modules (existing interface preserved)
// =====================================================

const DIR = fs.existsSync(path.join(__dirname, 'games'))
  ? path.join(__dirname, 'games')
  : __dirname;

const ctx = {
  send,
  sockets,
  players,
  broadcast,
  crypto,
};

const GAME_NAMES = ['chess', 'shkobba', 'rummy', 'voice'];

const GAMES = GAME_NAMES.map((name) => {
  const file = path.join(DIR, name + '.js');

  if (!fs.existsSync(file)) {
    throw new Error('Required game module missing: ' + file);
  }

  const createGame = require(file);

  if (typeof createGame !== 'function') {
    throw new Error(name + '.js must export a function');
  }

  return createGame(ctx);
});

const VOICE = GAMES.find((game) => game.prefix === 'voice:');

// =====================================================
// WebSocket authentication
// =====================================================

async function authenticateSocket(ticket) {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 512) {
    return null;
  }

  if (typeof auth.consumeWsTicket !== 'function') {
    throw new Error('auth.consumeWsTicket(ticket) is missing from auth.js');
  }

  const account = await auth.consumeWsTicket(ticket);
  if (!account || account.id == null) return null;

  return {
    id: String(account.id),
    name: String(account.name || 'Player').slice(0, 24),
    color: String(account.color || '#e74c3c').slice(0, 9),
  };
}

function readTicket(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('ticket');
  } catch {
    return null;
  }
}

// =====================================================
// WebSocket connections
// =====================================================

wss.on('connection', async (ws, req) => {
  ws.authenticated = false;
  ws.joined = false;
  ws.alive = true;
  ws.playerId = null;
  ws.accountId = null;
  ws.accountName = null;
  ws.accountColor = null;

  const authTimer = setTimeout(() => {
    if (!ws.authenticated && ws.readyState === WebSocket.OPEN) {
      ws.close(1008, 'Authentication timeout');
    }
  }, AUTH_TIMEOUT_MS);

  // --- Authenticate before anything else ---

  const ticket = readTicket(req);

  let account = null;

  try {
    account = await authenticateSocket(ticket);
  } catch (err) {
    console.error('[WS AUTH]', err.message);
  }

  clearTimeout(authTimer);

  if (!account || ws.readyState !== WebSocket.OPEN) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1008, 'Invalid or expired ticket');
    }
    return;
  }

  ws.authenticated = true;
  ws.accountId = account.id;
  ws.accountName = account.name;
  ws.accountColor = account.color;
  ws.playerId = 'p_' + crypto.randomBytes(6).toString('hex');

  sockets.set(ws.playerId, ws);

  send(ws, {
    type: 'init',
    id: ws.playerId,
    accountId: ws.accountId,
    name: ws.accountName,
    color: ws.accountColor,
    ice: iceFor(ws.playerId),
  });

  for (const player of players.values()) {
    send(ws, { type: 'player:join', player });
  }

  // --- Authenticated message handling ---

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      ws.close(1003, 'Text messages only');
      return;
    }

    if (!ws.authenticated) {
      ws.close(1008, 'Authentication required');
      return;
    }

    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!data || typeof data.type !== 'string') return;

    handleMessage(ws, data);
  });

  ws.on('close', () => {
    GAMES.forEach((game) => {
      if (typeof game.leave === 'function') {
        try {
          game.leave(ws.playerId);
        } catch (err) {
          console.error('[GAME LEAVE]', err.message);
        }
      }
    });

    sockets.delete(ws.playerId);
    players.delete(ws.playerId);

    broadcast({ type: 'player:leave', id: ws.playerId });
  });

  ws.on('error', (err) => {
    console.error('[WS ERROR]', err.message);
  });
});

// =====================================================
// Authenticated message dispatch
// =====================================================

function handleMessage(ws, data) {
  const id = ws.playerId;

  switch (data.type) {
    case 'join': {
      if (ws.joined) break;

      const player = {
        id,
        name: ws.accountName,
        color: ws.accountColor,
        x: 0,
        z: 2,
        ry: 0,
        s: 0,
      };

      players.set(id, player);
      ws.joined = true;

      broadcast({ type: 'player:join', player }, id);
      break;
    }

    case 'move': {
      const player = players.get(id);
      if (!player) break;

      const x = Number(data.x);
      const z = Number(data.z);
      const ry = Number(data.ry);

      player.x = Number.isFinite(x) ? Math.max(-14, Math.min(14, x)) : 0;
      player.z = Number.isFinite(z) ? Math.max(-6, Math.min(9, z)) : 0;
      player.ry = Number.isFinite(ry) ? ry : 0;
      player.s = data.s ? 1 : 0;

      broadcast({
        type: 'player:move',
        id,
        x: player.x,
        y: 0,
        z: player.z,
        ry: player.ry,
        s: player.s,
      }, id);

      if (VOICE && typeof VOICE.onMove === 'function') {
        try {
          VOICE.onMove(id);
        } catch (err) {
          console.error('[VOICE MOVE]', err.message);
        }
      }
      break;
    }

    case 'chat': {
      const player = players.get(id);
      if (!player) break;

      const text = String(data.text || '').trim().slice(0, 80);
      if (!text) break;

      broadcast({
        type: 'chat',
        id,
        name: player.name,
        text,
      });
      break;
    }

    case 'signal': {
      if (
        !VOICE ||
        typeof VOICE.canSignal !== 'function' ||
        !VOICE.canSignal(id, data.to)
      ) {
        break;
      }

      const target = sockets.get(data.to);
      if (!target || !target.authenticated || target.readyState !== WebSocket.OPEN) {
        break;
      }

      send(target, {
        type: 'signal',
        from: id,
        data: data.data,
      });
      break;
    }

    default: {
      const game = GAMES.find((item) => String(data.type).startsWith(item.prefix));
      if (game && typeof game.handle === 'function') {
        try {
          game.handle(id, data);
        } catch (err) {
          console.error('[GAME HANDLE]', err.message);
        }
      }
      break;
    }
  }
}

// =====================================================
// Heartbeat
// =====================================================

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    if (ws.alive === false) {
      ws.terminate();
      continue;
    }

    ws.alive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

heartbeat.unref();

// =====================================================
// Startup / shutdown
// =====================================================

async function startServer() {
  if (pool) {
    await initializeDatabase();
  } else {
    authReady = false;
  }

  server.listen(PORT, () => {
    console.log('Cafe Life listening on port ' + PORT);
    console.log('TURN: ' + (TURN_SECRET ? 'configured' : 'disabled'));
    console.log('Database: ' + (pool ? 'configured' : 'disabled'));
    console.log('Auth: ' + (authReady ? 'ready' : 'unavailable'));
  });
}

async function shutdown() {
  console.log('Shutting down Cafe Life...');

  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {}
  }

  wss.close(() => {
    server.close(async () => {
      if (pool) {
        try {
          await pool.end();
        } catch (err) {
          console.error('[DB SHUTDOWN]', err.message);
        }
      }
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

startServer().catch((err) => {
  console.error('[STARTUP FAILED]', err.message);
  process.exit(1);
});

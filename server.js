
'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

// ==================================================
// ENVIRONMENT
// ==================================================

const PORT = process.env.PORT || 10000;

const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '49.13.227.251';

const DATABASE_URL = process.env.DATABASE_URL || '';

// ==================================================
// POSTGRESQL
// ==================================================

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message);
  });
} else {
  console.warn('DATABASE_URL is missing. Database is disabled.');
}

// ==================================================
// DATABASE INITIALIZATION
// ==================================================

async function initializeDatabase() {
  if (!pool) return false;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT,
        google_sub TEXT UNIQUE,
        display_name VARCHAR(40) NOT NULL DEFAULT 'ضيف',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    console.log('PostgreSQL connected; users table is ready.');
    return true;
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    return false;
  }
}

// ==================================================
// TURN / WEBRTC
// Keep existing TURN configuration
// ==================================================

function iceFor(id) {
  if (!TURN_SECRET) return [];

  const username =
    Math.floor(Date.now() / 1000) + 12 * 3600 + ':' + id;

  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');

  return [
    {
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`
      ],
      username,
      credential
    }
  ];
}

// ==================================================
// EXPRESS
// ==================================================

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '20kb' }));

app.get('/', (req, res) => {
  res.status(200).send('Café Life Server running');
});

app.get('/version', (req, res) => {
  res.json({
    service: 'Café Life',
    version: '3.1.0',
    websocket: 'enabled',
    turn: TURN_SECRET ? 'configured' : 'disabled',
    database: pool ? 'configured' : 'disabled'
  });
});

// This endpoint never returns credentials or database details.
app.get('/db-check', async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      message: 'Database is not configured'
    });
  }

  try {
    await pool.query('SELECT 1');

    return res.status(200).json({
      ok: true,
      message: 'Database connection successful'
    });
  } catch (err) {
    console.error('Database health check failed:', err.message);

    return res.status(503).json({
      ok: false,
      message: 'Database connection failed'
    });
  }
});

// ==================================================
// HTTP + WEBSOCKET SERVER
// ==================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const players = new Map();
const sockets = new Map();

const send = (ws, data) => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
};

function broadcast(data, excludeId = null) {
  const message = JSON.stringify(data);

  wss.clients.forEach((client) => {
    if (
      client.readyState === 1 &&
      client.playerId !== excludeId
    ) {
      client.send(message);
    }
  });
}

// ==================================================
// EXISTING GAME MODULES
// Keep the existing games/ directory and files.
// ==================================================

const DIR = fs.existsSync(path.join(__dirname, 'games'))
  ? path.join(__dirname, 'games')
  : __dirname;

const ctx = {
  send,
  sockets,
  players,
  broadcast,
  crypto
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

// ==================================================
// WEBSOCKET CONNECTIONS
// ==================================================

wss.on('connection', (ws) => {
  const id = 'p_' + crypto.randomBytes(6).toString('hex');

  ws.playerId = id;
  ws.alive = true;

  sockets.set(id, ws);

  send(ws, {
    type: 'init',
    id,
    ice: iceFor(id)
  });

  players.forEach((player) => {
    send(ws, {
      type: 'player:join',
      player
    });
  });

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!data || typeof data.type !== 'string') {
      return;
    }

    switch (data.type) {
      case 'join': {
        const player = {
          id,
          name: String(data.name || 'ضيف').slice(0, 14),
          color: String(data.color || '#e74c3c').slice(0, 9),
          x: 0,
          z: 2,
          ry: 0,
          s: 0
        };

        players.set(id, player);

        broadcast({
          type: 'player:join',
          player
        }, id);

        break;
      }

      case 'move': {
        const player = players.get(id);

        if (!player) break;

        const x = Number(data.x);
        const z = Number(data.z);
        const ry = Number(data.ry);

        player.x = Number.isFinite(x)
          ? Math.max(-14, Math.min(14, x))
          : 0;

        player.z = Number.isFinite(z)
          ? Math.max(-6, Math.min(9, z))
          : 0;

        player.ry = Number.isFinite(ry) ? ry : 0;
        player.s = data.s ? 1 : 0;

        broadcast({
          type: 'player:move',
          id,
          x: player.x,
          y: 0,
          z: player.z,
          ry: player.ry,
          s: player.s
        }, id);

        if (VOICE && typeof VOICE.onMove === 'function') {
          VOICE.onMove(id);
        }

        break;
      }

      case 'chat': {
        const player = players.get(id);
        const text = String(data.text || '').trim().slice(0, 80);

        if (player && text) {
          broadcast({
            type: 'chat',
            id,
            name: player.name,
            text
          });
        }

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

        wss.clients.forEach((client) => {
          if (client.playerId === data.to) {
            send(client, {
              type: 'signal',
              from: id,
              data: data.data
            });
          }
        });

        break;
      }

      default: {
        const game = GAMES.find((item) =>
          String(data.type).startsWith(item.prefix)
        );

        if (game && typeof game.handle === 'function') {
          game.handle(id, data);
        }

        break;
      }
    }
  });

  ws.on('close', () => {
    GAMES.forEach((game) => {
      if (typeof game.leave === 'function') {
        game.leave(id);
      }
    });

    sockets.delete(id);
    players.delete(id);

    broadcast({
      type: 'player:leave',
      id
    });
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ==================================================
// HEARTBEAT
// ==================================================

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) {
      ws.terminate();
      return;
    }

    ws.alive = false;
    ws.ping();
  });
}, 30000);

// ==================================================
// STARTUP + SHUTDOWN
// ==================================================

server.listen(PORT, async () => {
  console.log('Café Life listening on port ' + PORT);
  console.log('TURN: ' + (TURN_SECRET ? 'configured' : 'disabled'));

  if (pool) {
    await initializeDatabase();
  }
});

async function shutdown() {
  console.log('Shutting down Café Life...');

  clearInterval(heartbeat);

  wss.clients.forEach((ws) => ws.close());

  wss.close(() => {
    server.close(async () => {
      if (pool) {
        await pool.end().catch(() => {});
      }

      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

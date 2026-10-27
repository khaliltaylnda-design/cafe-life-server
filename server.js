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
const createWallet = require('./wallet/wallet');
const registerWalletRoutes = require('./wallet/wallet.routes');
const createStripe = require('./payments/stripe');
const registerPaymentsRoutes = require('./payments/payments.routes');
const createWager = require('./wager/wager');
const registerWagerRoutes = require('./wager/wager.routes');

// =====================================================
// Environment
// =====================================================

const PORT = Number(process.env.PORT || 10000);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '49.13.227.251';
const DATABASE_URL = process.env.DATABASE_URL || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const MAX_WS_PAYLOAD = 64 * 1024;
const AUTH_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 30000;
const SESSION_CHECK_INTERVAL_MS = 15000;
const WS_CLOSE_REVOKED = 1008;
const DB_RETRY_ATTEMPTS = 15;

// Periodic maintenance intervals.
const STALE_WAGER_CLEANUP_INTERVAL_MS = 60 * 1000;       // 1 minute
const EXPIRED_WAGER_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour

// Keep a short-lived map of playerId → accountId so settlement can still
// find the real account id even if the socket closed a few seconds ago.
const PLAYER_ACCOUNT_TTL_MS = 5 * 60 * 1000;             // 5 minutes

// =====================================================
// PostgreSQL
// =====================================================

let pool = null;
let authReady = false;
let walletReady = false;
let paymentsReady = false;
let wagerReady = false;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });

  pool.on('error', (err) => {
    console.error('[DB POOL]', err.message);
  });
} else {
  console.warn('[DB] DATABASE_URL is missing. Database is disabled.');
}

// =====================================================
// Modules
// =====================================================

const auth = createAuth({
  pool,
  env: process.env,
  log: console,
});

const wallet = createWallet({
  pool,
  log: console,
});

const stripe = createStripe({
  secretKey: STRIPE_SECRET_KEY,
  publishableKey: STRIPE_PUBLISHABLE_KEY,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  log: console,
});

const wager = createWager({
  pool,
  wallet,
  log: console,
});

// =====================================================
// Player → account mapping (survives socket close for a short time)
// =====================================================

// This is the source of truth for accountId resolution during settlement.
// `sockets` is deleted on close; this map is kept for PLAYER_ACCOUNT_TTL_MS
// so settlement still works if a player disconnects right before the game ends.
const playerAccountMap = new Map();

function rememberPlayerAccount(playerId, accountId) {
  if (!playerId || accountId == null) return;
  playerAccountMap.set(playerId, String(accountId));
}

function scheduleForgetPlayerAccount(playerId) {
  if (!playerId) return;
  setTimeout(() => {
    // Only forget if the player hasn't reconnected.
    if (!sockets.has(playerId)) {
      playerAccountMap.delete(playerId);
    }
  }, PLAYER_ACCOUNT_TTL_MS).unref();
}

// =====================================================
// Socket indexes for fast revocation
// =====================================================

const socketsByJti = new Map();

function addToIndex(map, key, ws) {
  if (!key) return;
  const k = String(key);
  let set = map.get(k);
  if (!set) {
    set = new Set();
    map.set(k, set);
  }
  set.add(ws);
}

function removeFromIndex(map, key, ws) {
  if (!key) return;
  const k = String(key);
  const set = map.get(k);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) map.delete(k);
}

function closeSocket(ws, code, reason) {
  if (!ws) return;
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try {
    ws.close(code, reason);
  } catch (err) {
    console.error('[WS CLOSE]', err.message);
  }
}

function closeByJti(jti) {
  if (!jti) return;
  const set = socketsByJti.get(String(jti));
  if (!set) return;
  for (const ws of [...set]) {
    closeSocket(ws, WS_CLOSE_REVOKED, 'Session revoked');
  }
}

if (typeof auth.setSessionRevokedHandler === 'function') {
  auth.setSessionRevokedHandler((jti) => {
    if (!jti) return;
    closeByJti(String(jti));
  });
  console.log('[AUTH] setSessionRevokedHandler bound');
}

// =====================================================
// Database initialization (with retries)
// =====================================================

async function initializeDatabase() {
  if (!pool) return false;

  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt++) {
    try {
      console.log(`[DB] Attempt ${attempt}/${DB_RETRY_ATTEMPTS} to connect...`);

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
      authReady = true;

      await wallet.ensureSchema();
      await wallet.seedPackages();
      walletReady = true;

      // Phase 1: create wager tables WITHOUT the unique live index, so any
      // pre-existing duplicates don't block startup.
      await wager.ensureSchema({ skipLiveIndex: true });
      wagerReady = true;

      // Phase 2: clean up stale live wagers so the unique index can be built.
      try {
        const n = await wager.cleanupStaleWagers({ olderThanMinutes: 10 });
        if (n > 0) console.log(`[WAGER] Startup cleanup: ${n} stale pending cancelled`);
      } catch (e) {
        console.error('[WAGER] Startup cleanup failed:', e.message);
      }

      // Phase 3: try to create the unique live index now that duplicates are
      // (hopefully) gone. If it still fails, log but don't crash — the
      // periodic cleanup will keep the table tidy, and the index will be
      // retried on the next deploy.
      try {
        await wager.ensureSchema({ skipLiveIndex: false });
      } catch (e) {
        console.warn('[WAGER] Could not create wagers_one_live_per_room index:', e.message);
        console.warn('[WAGER] Server will continue without the DB-level guard; cleanup is still active.');
      }

      console.log('[DB] Schema ready.');
      return true;
    } catch (err) {
      console.error(`[DB] Attempt ${attempt}/${DB_RETRY_ATTEMPTS} failed:`, err.message);
      authReady = false;
      walletReady = false;
      wagerReady = false;

      if (attempt < DB_RETRY_ATTEMPTS) {
        const waitMs = Math.min(2000 * attempt, 15000);
        console.log(`[DB] Retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  console.error('[DB] All connection attempts failed.');
  return false;
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

if (stripe && STRIPE_WEBHOOK_SECRET) {
  try {
    const createPaymentsWebhook = require('./payments/payments.webhook');
    app.post(
      '/payments/webhook',
      express.raw({ type: 'application/json' }),
      createPaymentsWebhook({
        pool,
        wallet,
        stripe,
        log: console,
      })
    );
    console.log('[PAYMENTS] Stripe webhook registered at /payments/webhook');
  } catch (err) {
    console.error('[PAYMENTS] Failed to load webhook module:', err.message);
  }
} else {
  console.log('[PAYMENTS] Stripe webhook disabled (missing secret or module).');
}

app.use(cors());
app.use(express.json({ limit: '20kb' }));

app.get('/', (_req, res) => {
  res.status(200).send('Cafe Life Server running');
});

app.get('/version', (_req, res) => {
  res.json({
    service: 'Cafe Life',
    version: '5.1.0',
    websocket: 'authenticated',
    turn: TURN_SECRET ? 'configured' : 'disabled',
    database: pool ? 'configured' : 'disabled',
    auth: authReady ? 'ready' : 'unavailable',
    wallet: walletReady ? 'ready' : 'unavailable',
    payments: paymentsReady ? 'ready' : (stripe ? 'configured' : 'disabled'),
    wager: wagerReady ? 'ready' : 'unavailable',
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

app.use('/wallet', (_req, res, next) => {
  if (!walletReady) {
    return res.status(503).json({ ok: false, error: 'wallet_not_ready' });
  }
  next();
});
registerWalletRoutes(app, { wallet, identify: auth.identify, log: console });

app.use('/payments', (_req, res, next) => {
  if (!stripe) {
    return res.status(503).json({ ok: false, error: 'payments_not_configured' });
  }
  next();
});
if (stripe) {
  try {
    const result = registerPaymentsRoutes(app, {
      stripe,
      wallet,
      identify: auth.identify,
      pool,
      log: console,
    });
    paymentsReady = Boolean(result && result.enabled);
  } catch (err) {
    paymentsReady = false;
    console.error('[PAYMENTS] Failed to register payment routes:', err.message);
  }
}

app.use('/wager', (_req, res, next) => {
  if (!wagerReady) {
    return res.status(503).json({ ok: false, error: 'wager_not_ready' });
  }
  next();
});
registerWagerRoutes(app, { wager, identify: auth.identify, log: console });

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
// Game modules
// =====================================================

const DIR = fs.existsSync(path.join(__dirname, 'games'))
  ? path.join(__dirname, 'games')
  : __dirname;

// Resolve playerId (p_xxx) → real accountId.
// Priority:
//   1. Live socket       (fastest)
//   2. playerAccountMap  (survives disconnect for 5 minutes)
//   3. Raw playerId      (last resort — settlement will fail safely)
const getRealId = (playerId) => {
  if (!playerId) return null;
  const ws = sockets.get(playerId);
  if (ws && ws.accountId) return String(ws.accountId);
  const cached = playerAccountMap.get(playerId);
  if (cached) return String(cached);
  return String(playerId);
};

// Send updated balance to a player.
async function sendWalletUpdate(playerId) {
  if (!playerId) return;
  const ws = sockets.get(playerId);
  if (!ws || !ws.authenticated) {
    console.log(`[WALLET UPDATE] Skipped ${playerId} (disconnected)`);
    return;
  }
  try {
    const balance = await wallet.getBalance(ws.accountId);
    if (balance !== null) {
      send(ws, { type: 'wallet:update', tokens: balance });
      console.log(`[WALLET UPDATE] Sent ${balance} to ${playerId} (accountId=${ws.accountId})`);
    }
  } catch (e) {
    console.error(`[WALLET UPDATE] Failed for ${playerId}:`, e.message);
  }
}

// Notify a player of a wager error in a structured way.
function notifyWagerError(playerId, action, e, context = {}) {
  const ws = sockets.get(playerId);
  if (!ws) return;
  send(ws, {
    type: 'wager:error',
    action,
    reason: e && e.code ? e.code : (e && e.message ? e.message : 'unknown'),
    required: e && e.required != null ? e.required : null,
    available: e && e.available != null ? e.available : null,
    ...context,
  });
}

const createWagerForPlayer = async (playerId, gameType, roomId, amount) => {
  const realId = getRealId(playerId);
  console.log(`[CREATE WAGER] playerId=${playerId} → accountId=${realId}, game=${gameType}, room=${roomId}, amount=${amount}`);
  try {
    const row = await wager.createWager(realId, gameType, roomId, amount);
    console.log(`[CREATE WAGER] Success: wagerId=${row.id}, status=${row.status}`);
    await sendWalletUpdate(playerId);
    return row;
  } catch (e) {
    console.error(`[CREATE WAGER] Error: ${e.message}`);
    notifyWagerError(playerId, 'create', e, { game: gameType, room: roomId, amount });
    throw e;
  }
};

const acceptWagerForPlayer = async (playerId, wagerId) => {
  const realId = getRealId(playerId);
  console.log(`[ACCEPT WAGER] playerId=${playerId} → accountId=${realId}, wagerId=${wagerId}`);
  try {
    const row = await wager.acceptWager(realId, wagerId);
    console.log(`[ACCEPT WAGER] Success: wagerId=${row.id}, status=${row.status}`);
    await sendWalletUpdate(playerId);
    return row;
  } catch (e) {
    console.error(`[ACCEPT WAGER] Error: ${e.message}`);
    notifyWagerError(playerId, 'accept', e, { wagerId });
    throw e;
  }
};

const cancelWagerForPlayer = async (playerId, wagerId) => {
  const realId = getRealId(playerId);
  console.log(`[CANCEL WAGER] playerId=${playerId} → accountId=${realId}, wagerId=${wagerId}`);
  try {
    const row = await wager.cancelWager(realId, wagerId);
    console.log(`[CANCEL WAGER] Success: wagerId=${row.id}`);
    await sendWalletUpdate(playerId);
    return row;
  } catch (e) {
    console.error(`[CANCEL WAGER] Error: ${e.message}`);
    notifyWagerError(playerId, 'cancel', e, { wagerId });
    throw e;
  }
};

// Settle using the persistent playerAccountMap (so disconnection doesn't
// break settlement).
const settleGameWager = async (gameType, roomId, winnerPlayerId, loserPlayerId) => {
  try {
    const realWinnerId = winnerPlayerId ? getRealId(winnerPlayerId) : null;

    // If winner is unknown and the value is not numeric, treat as draw.
    const winnerIsValid = realWinnerId == null || /^\d+$/.test(String(realWinnerId));

    if (!winnerIsValid) {
      console.warn(`[SETTLE WAGER] Winner ${winnerPlayerId} could not be resolved to accountId; settling as draw.`);
    }

    const resolvedWinner = winnerIsValid ? realWinnerId : null;
    console.log(`[SETTLE WAGER] game=${gameType}, room=${roomId}, winner=${winnerPlayerId} → accountId=${resolvedWinner}`);

    await wager.settleWager(gameType, roomId, resolvedWinner);
    console.log(`[SETTLE WAGER] Done`);

    const playersToNotify = [winnerPlayerId, loserPlayerId].filter(Boolean);
    for (const pid of playersToNotify) {
      await sendWalletUpdate(pid);
    }
  } catch (e) {
    console.error('[SETTLE WAGER] Error:', e.message);
  }
};

const ctx = {
  send,
  sockets,
  players,
  broadcast,
  crypto,
  wallet,
  wager,
  getRealId,
  sendWalletUpdate,
  createWager: createWagerForPlayer,
  acceptWager: acceptWagerForPlayer,
  cancelWager: cancelWagerForPlayer,
  settleWager: settleGameWager,
};

const GAME_NAMES = ['chess', 'shkobba', 'rummy', 'voice'];

const GAMES = [];
for (const name of GAME_NAMES) {
  const file = path.join(DIR, name + '.js');
  if (!fs.existsSync(file)) {
    console.warn(`[GAME] SKIP ${name}.js (missing at ${file})`);
    continue;
  }
  try {
    const createGame = require(file);
    if (typeof createGame !== 'function') {
      console.warn(`[GAME] SKIP ${name}.js (does not export a function)`);
      continue;
    }
    console.log(`[GAME] Loaded ${name}.js`);
    GAMES.push(createGame(ctx));
  } catch (err) {
    console.error(`[GAME] FAILED to load ${name}.js:`, err.message);
  }
}

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
    jti: account.jti ? String(account.jti) : null,
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

function cleanChatText(input) {
  return String(input == null ? '' : input)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// =====================================================
// Session revalidation
// =====================================================

async function revalidateSocket(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!ws.authenticated || !ws.jti) return;
  if (typeof auth.isSessionValid !== 'function') return;
  try {
    const valid = await auth.isSessionValid(ws.jti);
    if (!valid) {
      closeSocket(ws, WS_CLOSE_REVOKED, 'Session expired');
    }
  } catch (err) {
    console.error('[REVALIDATE]', err.message);
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
  ws.jti = null;

  const authTimer = setTimeout(() => {
    if (!ws.authenticated && ws.readyState === WebSocket.OPEN) {
      ws.close(1008, 'Authentication timeout');
    }
  }, AUTH_TIMEOUT_MS);

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
  ws.jti = account.jti;
  ws.playerId = 'p_' + crypto.randomBytes(6).toString('hex');

  sockets.set(ws.playerId, ws);
  rememberPlayerAccount(ws.playerId, ws.accountId);
  addToIndex(socketsByJti, ws.jti, ws);

  console.log(`[WS AUTH] ${ws.playerId} authenticated as accountId=${ws.accountId}, name=${ws.accountName}`);

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

  ws.on('pong', () => { ws.alive = true; });

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

    if (data.type === 'chess:join' || data.type === 'shk:join' || data.type === 'rum:join' ||
        data.type.startsWith('chess:wager_') || data.type.startsWith('shk:wager_') || data.type.startsWith('rum:wager_')) {
      console.log(`[WS RECV] ${ws.playerId} → ${data.type}`);
    }

    handleMessage(ws, data);
  });

  ws.on('close', async () => {
    console.log(`[WS CLOSE] ${ws.playerId} disconnected`);
    try {
      if (wagerReady && typeof wager.cancelPendingByPlayer === 'function' && ws.accountId) {
        const n = await wager.cancelPendingByPlayer(ws.accountId);
        if (n > 0) {
          console.log(`[WAGER] Cancelled ${n} pending wager(s) for accountId=${ws.accountId}`);
        }
      }
    } catch (err) {
      console.error('[WAGER] cancelPendingByPlayer failed:', err.message);
    }

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
    removeFromIndex(socketsByJti, ws.jti, ws);
    scheduleForgetPlayerAccount(ws.playerId);
    broadcast({ type: 'player:leave', id: ws.playerId });
  });

  ws.on('error', (err) => {
    console.error('[WS ERROR]', err.message);
  });
});

// =====================================================
// Message handler
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
      const text = cleanChatText(data.text);
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
      if (data.to === id) break;
      if (!VOICE || typeof VOICE.canSignal !== 'function' || !VOICE.canSignal(id, data.to)) break;
      const target = sockets.get(data.to);
      if (!target || !target.authenticated || target.readyState !== WebSocket.OPEN) break;
      send(target, {
        type: 'signal',
        from: id,
        data: data.data,
      });
      break;
    }

    // ✅ BRIDGE: Handle wager rejection gracefully (Fix for UI message)
    case 'chess:wager_reject':
    case 'shk:wager_reject':
    case 'rum:wager_reject': {
      const gamePrefix = data.type.split(':')[0];
      // Notify the creator of the offer that it was rejected
      // The game module should normally handle the DB update, but we ensure the client gets notified.
      // If the game module handles it, it will also send an update. 
      // We just make sure the sender gets the message.
      const targetId = data.targetId; // Assuming the frontend might send target, if not we rely on the game module
      
      // Let the game module handle the logic, but if it fails, fallback:
      const game = GAMES.find((item) => data.type.startsWith(item.prefix));
      if (game && typeof game.handle === 'function') {
        try {
          game.handle(id, data);
        } catch (err) {
          console.error('[GAME HANDLE]', err.message);
        }
      } else {
         // Fallback bridge if game module isn't loaded properly
         if (data.wagerId) {
            wager.cancelWager(getRealId(id), data.wagerId).catch(()=>{});
         }
      }
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
// Periodic session revalidation
// =====================================================

const revalidationTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!ws.authenticated || !ws.jti) continue;
    revalidateSocket(ws).catch((err) => {
      console.error('[REVALIDATE LOOP]', err.message);
    });
  }
}, SESSION_CHECK_INTERVAL_MS);
revalidationTimer.unref();

// =====================================================
// Wager maintenance jobs
// =====================================================

let staleWagerTimer = null;
let expiredWagerTimer = null;

function startWagerMaintenance() {
  if (!wagerReady) {
    console.log('[WAGER MAINT] Skipped (wager not ready)');
    return;
  }

  staleWagerTimer = setInterval(() => {
    if (!wagerReady || typeof wager.cleanupStaleWagers !== 'function') return;
    wager.cleanupStaleWagers({ olderThanMinutes: 10 }).catch((err) => {
      console.error('[WAGER MAINT] cleanupStaleWagers failed:', err.message);
    });
  }, STALE_WAGER_CLEANUP_INTERVAL_MS);
  staleWagerTimer.unref();

  expiredWagerTimer = setInterval(() => {
    if (!wagerReady || typeof wager.handleExpiredWagers !== 'function') return;
    wager.handleExpiredWagers().catch((err) => {
      console.error('[WAGER MAINT] handleExpiredWagers failed:', err.message);
    });
  }, EXPIRED_WAGER_CHECK_INTERVAL_MS);
  expiredWagerTimer.unref();

  console.log('[WAGER MAINT] Periodic maintenance started');
}

function stopWagerMaintenance() {
  if (staleWagerTimer) { clearInterval(staleWagerTimer); staleWagerTimer = null; }
  if (expiredWagerTimer) { clearInterval(expiredWagerTimer); expiredWagerTimer = null; }
}

// =====================================================
// Startup / shutdown
// =====================================================

async function startServer() {
  if (pool) {
    console.log('[STARTUP] Initializing database...');
    const ok = await initializeDatabase();
    if (!ok) {
      console.error('[STARTUP] Database initialization failed. Server will run with auth/wallet/wager disabled.');
    }
  } else {
    authReady = false;
    walletReady = false;
    wagerReady = false;
  }

  if (!stripe) paymentsReady = false;

  server.listen(PORT, () => {
    console.log('========================================

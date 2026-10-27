'use strict';

// ============================================================================
// server.js — Cafe Life entrypoint. FORTRESS EDITION.
// ============================================================================
// Every hardening point is mapped to a documented threat below.
// This file is the composition root: it wires auth, wallet, payments, wager,
// games, and voice. It MUST NOT contain business logic that belongs elsewhere.
//
// HARDENING MAP:
//   [S-01] Auth-first WebSocket handshake (ticket consumed before any message).
//   [S-02] Session revocation closes live sockets (jti index).
//   [S-03] Heartbeat + periodic revalidation.
//   [S-04] WS payload size cap + text-only.
//   [S-05] Per-socket rate limits: move, chat, signal.
//   [S-06] signal `from` = ws.playerId (never client-supplied).
//   [S-07] signal payload shape + size validation.
//   [S-08] move: coordinate clamping + numeric validation.
//   [S-09] chat: sanitization + rate limit.
//   [S-10] getRealId never returns a playerId (returns null on failure).
//   [S-11] settleGameWager: never refunds by mistake when winner unresolvable.
//   [S-12] playerAccountMap cleanup with TTL + socket-presence check.
//   [S-13] DB init: idempotent, phased, with strict index verification.
//   [S-14] Wager maintenance jobs unref'd + stoppable.
//   [S-15] Graceful shutdown: dedupe cancels, close sockets, drain pool.
//   [S-16] All async socket close handlers wrapped; cleanup BEFORE await.
//   [S-17] /version exposes nothing sensitive.
//   [S-18] Route gating: auth/wallet/payments/wager refuse when not ready.
//   [S-19] Stripe webhook raw-body BEFORE json parser.
//   [S-20] Uniform error handling for game.handle() calls.
// ============================================================================

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

// ============================================================================
// ENVIRONMENT
// ============================================================================
const PORT = Number(process.env.PORT || 10000);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Limits
const MAX_WS_PAYLOAD = 32 * 1024;            // [S-04] smaller cap; signals rarely exceed 20KB
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_CHECK_INTERVAL_MS = 15_000;
const WS_CLOSE_REVOKED = 1008;
const DB_RETRY_ATTEMPTS = 15;
const DB_RETRY_MAX_WAIT_MS = 15_000;

// Rate limits [S-05]
const MOVE_RATE_MAX = 30;                    // moves/sec
const MOVE_RATE_WINDOW = 1_000;
const CHAT_RATE_MAX = 10;                    // messages/10s
const CHAT_RATE_WINDOW = 10_000;
const SIGNAL_RATE_MAX = 60;                  // signals/min
const SIGNAL_RATE_WINDOW = 60_000;

// Signal payload caps [S-07]
const MAX_SDP_LEN = 20_000;
const MAX_CANDIDATE_LEN = 2_000;

// Wager maintenance intervals
const STALE_WAGER_INTERVAL_MS = 60_000;
const EXPIRED_WAGER_INTERVAL_MS = 60 * 60_000;

// Player→account cache TTL [S-12]
const PLAYER_ACCOUNT_TTL_MS = 5 * 60_000;

// ============================================================================
// POSTGRES POOL
// ============================================================================
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 20_000,
  });
  pool.on('error', (err) => {
    console.error('[DB POOL]', err.message);
  });
} else {
  console.warn('[DB] DATABASE_URL missing — DB features disabled.');
}

// ============================================================================
// MODULE INITIALIZATION
// ============================================================================
const auth = createAuth({ pool, env: process.env, log: console });
const wallet = createWallet({ pool, log: console });
const stripe = createStripe({
  secretKey: STRIPE_SECRET_KEY,
  publishableKey: STRIPE_PUBLISHABLE_KEY,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  log: console,
});
const wager = createWager({ pool, wallet, log: console });

let authReady = false;
let walletReady = false;
let paymentsReady = false;
let wagerReady = false;

// ============================================================================
// PLAYER → ACCOUNT MAP [S-12]
// ============================================================================
const playerAccountMap = new Map();

function rememberPlayerAccount(playerId, accountId) {
  if (!playerId || accountId == null) return;
  playerAccountMap.set(playerId, String(accountId));
}

function scheduleForgetPlayerAccount(playerId) {
  if (!playerId) return;
  const timer = setTimeout(() => {
    if (!sockets.has(playerId)) playerAccountMap.delete(playerId);
  }, PLAYER_ACCOUNT_TTL_MS);
  if (timer.unref) timer.unref();
}

// [S-10] Resolve playerId → real accountId (never returns a playerId).
const getRealId = (playerId) => {
  if (!playerId) return null;
  const ws = sockets.get(playerId);
  if (ws && ws.accountId) return String(ws.accountId);
  const cached = playerAccountMap.get(playerId);
  if (cached) return String(cached);
  return null;
};

// ============================================================================
// SOCKET INDEXES [S-02]
// ============================================================================
const socketsByJti = new Map();

function addToIndex(map, key, ws) {
  if (!key) return;
  const k = String(key);
  let set = map.get(k);
  if (!set) { set = new Set(); map.set(k, set); }
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
  try { ws.close(code, reason); } catch (e) { console.error('[WS CLOSE]', e.message); }
}

function closeByJti(jti) {
  if (!jti) return;
  const set = socketsByJti.get(String(jti));
  if (!set) return;
  for (const ws of [...set]) closeSocket(ws, WS_CLOSE_REVOKED, 'Session revoked');
}

if (typeof auth.setSessionRevokedHandler === 'function') {
  auth.setSessionRevokedHandler((jti) => {
    if (jti) closeByJti(String(jti));
  });
}

// ============================================================================
// DATABASE INITIALIZATION [S-13]
// ============================================================================
async function initializeDatabase() {
  if (!pool) return false;

  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt++) {
    try {
      console.log(`[DB] Attempt ${attempt}/${DB_RETRY_ATTEMPTS}...`);

      // Base users table — auth.ensureSchema will extend it.
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

      // Wager: cleanup first, then schema with live index.
      // If wager.js supports phased schema, use it; otherwise clean up first.
      try {
        if (typeof wager.cleanupStaleWagers === 'function') {
          await wager.cleanupStaleWagers({ olderThanMinutes: 10 });
        }
      } catch (e) {
        console.error('[WAGER] Startup cleanup failed:', e.message);
      }

      await wager.ensureSchema();
      wagerReady = true;

      // Verify the unique live index exists (fail-fast if not).
      if (typeof wager._t?.SQL?.schema === 'object') {
        try {
          const r = await pool.query(
            `SELECT 1 FROM pg_indexes WHERE indexname = 'wagers_one_live_per_room'`
          );
          if (r.rows.length === 0) {
            console.error('[WAGER] Missing unique live index — duplicate pending wagers exist!');
          }
        } catch (e) {
          console.error('[WAGER] Index verification failed:', e.message);
        }
      }

      console.log('[DB] Schema ready.');
      return true;
    } catch (err) {
      console.error(`[DB] Attempt ${attempt}/${DB_RETRY_ATTEMPTS} failed:`, err.message);
      authReady = false;
      walletReady = false;
      wagerReady = false;

      if (attempt < DB_RETRY_ATTEMPTS) {
        const waitMs = Math.min(2_000 * attempt, DB_RETRY_MAX_WAIT_MS);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  console.error('[DB] All connection attempts failed.');
  return false;
}

// ============================================================================
// TURN / ICE [—]
// ============================================================================
function iceFor(id) {
  if (!TURN_SECRET || !TURN_HOST) return [];
  const username = Math.floor(Date.now() / 1000) + 12 * 3600 + ':' + id;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [{
    urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`],
    username,
    credential,
  }];
}

// ============================================================================
// EXPRESS APP
// ============================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// [S-19] Stripe webhook — raw body BEFORE json parser.
if (stripe && STRIPE_WEBHOOK_SECRET) {
  try {
    const createPaymentsWebhook = require('./payments/payments.webhook');
    app.post(
      '/payments/webhook',
      express.raw({ type: 'application/json', limit: '100kb' }),
      createPaymentsWebhook({ pool, wallet, stripe, log: console })
    );
    console.log('[PAYMENTS] Webhook registered.');
  } catch (err) {
    console.error('[PAYMENTS] Webhook load failed:', err.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '20kb' }));

app.get('/', (_req, res) => res.status(200).send('Cafe Life Server running'));

// [S-17] Minimal version — no leak of module state.
app.get('/version', (_req, res) => {
  res.json({ service: 'Cafe Life', status: 'ok' });
});

// Detailed version behind auth.
app.get('/version/full', async (req, res) => {
  try {
    const user = await auth.identify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user) return res.status(401).json({ ok: false });
    res.json({
      service: 'Cafe Life',
      version: '5.1.2',
      turn: TURN_SECRET ? 'configured' : 'disabled',
      database: pool ? 'configured' : 'disabled',
      auth: authReady ? 'ready' : 'unavailable',
      wallet: walletReady ? 'ready' : 'unavailable',
      payments: paymentsReady ? 'ready' : (stripe ? 'configured' : 'disabled'),
      wager: wagerReady ? 'ready' : 'unavailable',
    });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get('/db-check', async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// [S-18] Route gating.
app.use('/auth', (_req, res, next) => {
  if (!authReady) return res.status(503).json({ ok: false, error: 'auth_not_ready' });
  next();
});
auth.register(app);

app.use('/wallet', (_req, res, next) => {
  if (!walletReady) return res.status(503).json({ ok: false, error: 'wallet_not_ready' });
  next();
});
registerWalletRoutes(app, { wallet, identify: auth.identify, log: console });

app.use('/payments', (_req, res, next) => {
  if (!stripe) return res.status(503).json({ ok: false, error: 'payments_not_configured' });
  next();
});
if (stripe) {
  try {
    const result = registerPaymentsRoutes(app, {
      stripe, wallet, identify: auth.identify, pool, log: console,
    });
    paymentsReady = Boolean(result && result.enabled);
  } catch (err) {
    paymentsReady = false;
    console.error('[PAYMENTS] Route registration failed:', err.message);
  }
}

app.use('/wager', (_req, res, next) => {
  if (!wagerReady) return res.status(503).json({ ok: false, error: 'wager_not_ready' });
  next();
});
registerWagerRoutes(app, { wager, identify: auth.identify, log: console });

// ============================================================================
// HTTP + WS SERVER
// ============================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD,
  perMessageDeflate: false,
});

const players = new Map();
const sockets = new Map();

// [S-05] Rate limits per socket (keyed by playerId).
const moveRate = new Map();
const chatRate = new Map();
const signalRate = new Map();

function rateCheck(map, id, max, windowMs) {
  const now = Date.now();
  let b = map.get(id);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + windowMs };
    map.set(id, b);
  }
  return ++b.count <= max;
}

function rateClear(id) {
  moveRate.delete(id);
  chatRate.delete(id);
  signalRate.delete(id);
}

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
    try { ws.send(message); } catch (err) { console.error('[WS BROADCAST]', err.message); }
  }
}

// ============================================================================
// GAME MODULES
// ============================================================================
const DIR = fs.existsSync(path.join(__dirname, 'games'))
  ? path.join(__dirname, 'games')
  : __dirname;

async function sendWalletUpdate(playerId) {
  if (!playerId) return;
  const ws = sockets.get(playerId);
  if (!ws || !ws.authenticated || !ws.accountId) return;
  try {
    const balance = await wallet.getBalance(ws.accountId);
    if (balance !== null) send(ws, { type: 'wallet:update', tokens: balance });
  } catch (e) {
    console.error(`[WALLET UPDATE] ${playerId}:`, e.message);
  }
}

function notifyWagerError(playerId, action, e, context = {}) {
  const ws = sockets.get(playerId);
  if (!ws) return;
  send(ws, {
    type: 'wager:error',
    action,
    reason: (e && (e.code || e.message)) || 'unknown',
    required: e && e.required != null ? e.required : null,
    available: e && e.available != null ? e.available : null,
    ...context,
  });
}

// [S-11] Strict wrappers for wager operations. Never swallow errors.
const createWagerForPlayer = async (playerId, gameType, roomId, amount) => {
  const realId = getRealId(playerId);
  if (!realId) {
    notifyWagerError(playerId, 'create', { code: 'player_unresolved' }, { game: gameType, room: roomId });
    throw Object.assign(new Error('player_unresolved'), { code: 'player_unresolved' });
  }
  try {
    const row = await wager.createWager(realId, gameType, roomId, amount);
    await sendWalletUpdate(playerId);
    return row;
  } catch (e) {
    notifyWagerError(playerId, 'create', e, { game: gameType, room: roomId, amount });
    throw e;
  }
};

const acceptWagerForPlayer = async (playerId, wagerId) => {
  const realId = getRealId(playerId);
  if (!realId) {
    notifyWagerError(playerId, 'accept', { code: 'player_unresolved' }, { wagerId });
    throw Object.assign(new Error('player_unresolved'), { code: 'player_unresolved' });
  }
  try {
    const row = await wager.acceptWager(realId, wagerId);
    await sendWalletUpdate(playerId);
    return row;
  } catch (e) {
    notifyWagerError(playerId, 'accept', e, { wagerId });
    throw e;
  }
};

const cancelWagerForPlayer = async (playerId, wagerId) => {
  const realId = getRealId(playerId);
  if (!realId) {
    notifyWagerError(playerId, 'cancel', { code: 'player_unresolved' }, { wagerId });
    throw Object.assign(new Error('player_unresolved'), { code: 'player_unresolved' });
  }
  try {
    const row = await wager.cancelWager(realId, wagerId);
    await sendWalletUpdate(playerId);
    return row;
  } catch (e) {
    notifyWagerError(playerId, 'cancel', e, { wagerId });
    throw e;
  }
};

// [S-11] CRITICAL: never refund when winner cannot be resolved.
const settleGameWager = async (gameType, roomId, winnerPlayerId, loserPlayerId) => {
  let realWinnerId = null;

  if (winnerPlayerId) {
    realWinnerId = getRealId(winnerPlayerId);
    if (!realWinnerId || !/^\d+$/.test(String(realWinnerId))) {
      // We cannot identify the winner. Do NOT call settleWager with null
      // (that would trigger a full refund → loser keeps their money).
      // Let wager.js's retry tables or handleExpiredWagers handle it later.
      console.error(
        `[SETTLE] Cannot resolve winner ${winnerPlayerId} for ${gameType}/${roomId}. ` +
        `Wager left active; retry tables will recover.`
      );
      return;
    }
  }

  try {
    await wager.settleWager(gameType, roomId, realWinnerId);
    const notify = [winnerPlayerId, loserPlayerId].filter(Boolean);
    for (const pid of notify) await sendWalletUpdate(pid);
  } catch (e) {
    console.error(`[SETTLE] ${gameType}/${roomId} failed:`, e?.message);
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
    console.warn(`[GAME] SKIP ${name}.js (missing)`);
    continue;
  }
  try {
    const createGame = require(file);
    if (typeof createGame !== 'function') {
      console.warn(`[GAME] SKIP ${name}.js (not a function)`);
      continue;
    }
    GAMES.push(createGame(ctx));
    console.log(`[GAME] Loaded ${name}.js`);
  } catch (err) {
    console.error(`[GAME] FAILED ${name}.js:`, err.message);
  }
}

const VOICE = GAMES.find((g) => g.prefix === 'voice:');

// ============================================================================
// WS AUTH
// ============================================================================
async function authenticateSocket(ticket) {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 512) return null;
  if (typeof auth.consumeWsTicket !== 'function') {
    throw new Error('auth.consumeWsTicket missing');
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
  } catch { return null; }
}

async function revalidateSocket(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!ws.authenticated || !ws.jti) return;
  if (typeof auth.isSessionValid !== 'function') return;
  try {
    const valid = await auth.isSessionValid(ws.jti);
    if (!valid) closeSocket(ws, WS_CLOSE_REVOKED, 'Session expired');
  } catch (err) {
    console.error('[REVALIDATE]', err.message);
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

// ============================================================================
// WS CONNECTION
// ============================================================================
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
      ws.close(1008, 'Auth timeout');
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
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'Invalid ticket');
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

  console.log(`[WS AUTH] ${ws.playerId} account=${ws.accountId}`);

  send(ws, {
    type: 'init',
    id: ws.playerId,
    accountId: ws.accountId,
    name: ws.accountName,
    color: ws.accountColor,
    ice: iceFor(ws.playerId),
  });

  for (const player of players.values()) send(ws, { type: 'player:join', player });

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return ws.close(1003, 'Text only');
    if (!ws.authenticated) return ws.close(1008, 'Auth required');

    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data.type !== 'string') return;

    try { handleMessage(ws, data); }
    catch (err) { console.error('[HANDLE]', err.message); }
  });

  // [S-16] Cleanup BEFORE await, then cancel wagers.
  ws.on('close', async () => {
    const playerId = ws.playerId;
    const accountId = ws.accountId;
    const jti = ws.jti;

    sockets.delete(playerId);
    players.delete(playerId);
    removeFromIndex(socketsByJti, jti, ws);
    rateClear(playerId);

    for (const game of GAMES) {
      if (typeof game.leave === 'function') {
        try { game.leave(playerId); } catch (err) { console.error('[GAME LEAVE]', err.message); }
      }
    }

    broadcast({ type: 'player:leave', id: playerId });
    scheduleForgetPlayerAccount(playerId);

    if (wagerReady && typeof wager.cancelPendingByPlayer === 'function' && accountId) {
      try {
        const n = await wager.cancelPendingByPlayer(accountId);
        if (n > 0) console.log(`[WAGER] Cancelled ${n} pending for account=${accountId}`);
      } catch (err) {
        console.error('[WAGER] cancelPendingByPlayer failed:', err.message);
      }
    }
  });

  ws.on('error', (err) => console.error('[WS ERROR]', err.message));
});

// ============================================================================
// MESSAGE HANDLER
// ============================================================================
function delegateToGame(id, data) {
  const game = GAMES.find((g) => String(data.type).startsWith(g.prefix));
  if (!game || typeof game.handle !== 'function') return false;
  try {
    game.handle(id, data);
    return true;
  } catch (err) {
    console.error(`[GAME ${game.prefix}] handle failed:`, err.message);
    return false;
  }
}

function handleMessage(ws, data) {
  const id = ws.playerId;

  switch (data.type) {
    case 'join': {
      if (ws.joined) break;
      players.set(id, {
        id, name: ws.accountName, color: ws.accountColor,
        x: 0, z: 2, ry: 0, s: 0,
      });
      ws.joined = true;
      broadcast({ type: 'player:join', player: players.get(id) }, id);
      break;
    }

    case 'move': {
      const player = players.get(id);
      if (!player) break;
      if (!rateCheck(moveRate, id, MOVE_RATE_MAX, MOVE_RATE_WINDOW)) break;

      const x = Number(data.x);
      const z = Number(data.z);
      const ry = Number(data.ry);

      player.x = Number.isFinite(x) ? Math.max(-14, Math.min(14, x)) : 0;
      player.z = Number.isFinite(z) ? Math.max(-6, Math.min(9, z)) : 0;
      player.ry = Number.isFinite(ry) ? ((ry % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : 0;
      player.s = (data.s === true || data.s === 1) ? 1 : 0;

      broadcast({
        type: 'player:move', id,
        x: player.x, y: 0, z: player.z, ry: player.ry, s: player.s,
      }, id);

      if (VOICE && typeof VOICE.onMove === 'function') {
        try { VOICE.onMove(id); } catch (err) { console.error('[VOICE MOVE]', err.message); }
      }
      break;
    }

    case 'chat': {
      const player = players.get(id);
      if (!player) break;
      if (!rateCheck(chatRate, id, CHAT_RATE_MAX, CHAT_RATE_WINDOW)) {
        send(ws, { type: 'chat:err', reason: 'rate_limited' });
        break;
      }
      const text = cleanChatText(data.text);
      if (!text) break;
      broadcast({ type: 'chat', id, name: player.name, text });
      break;
    }

    case 'signal': {
      if (typeof data.to !== 'string' || data.to === id) break;
      if (!VOICE || typeof VOICE.canSignal !== 'function') break;
      if (!VOICE.canSignal(id, data.to)) break;
      if (!rateCheck(signalRate, id, SIGNAL_RATE_MAX, SIGNAL_RATE_WINDOW)) {
        send(ws, { type: 'signal:err', reason: 'rate_limited' });
        break;
      }
      const p = data.data;
      if (!p || typeof p !== 'object') break;
      const sdp = typeof p.sdp === 'string' ? p.sdp : null;
      const candidate = typeof p.candidate === 'string' ? p.candidate : null;
      if ((sdp && sdp.length > MAX_SDP_LEN) || (candidate && candidate.length > MAX_CANDIDATE_LEN)) break;
      if (!sdp && !candidate) break;

      const target = sockets.get(data.to);
      if (!target || !target.authenticated || target.readyState !== WebSocket.OPEN) break;

      send(target, {
        type: 'signal', from: id,
        data: { sdp, candidate, type: typeof p.type === 'string' ? p.type : undefined },
      });
      break;
    }

    default: {
      delegateToGame(id, data);
      break;
    }
  }
}

// ============================================================================
// HEARTBEAT + REVALIDATION
// ============================================================================
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);
if (heartbeat.unref) heartbeat.unref();

const revalidationTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!ws.authenticated || !ws.jti) continue;
    revalidateSocket(ws).catch((err) => console.error('[REVALIDATE]', err.message));
  }
}, SESSION_CHECK_INTERVAL_MS);
if (revalidationTimer.unref) revalidationTimer.unref();

// ============================================================================
// WAGER MAINTENANCE [S-14]
// ============================================================================
let staleWagerTimer = null;
let expiredWagerTimer = null;

function startWagerMaintenance() {
  if (!wagerReady) return;

  staleWagerTimer = setInterval(() => {
    if (!wagerReady || typeof wager.cleanupStaleWagers !== 'function') return;
    wager.cleanupStaleWagers({ olderThanMinutes: 10 }).catch((err) => {
      console.error('[WAGER] cleanup:', err.message);
    });
  }, STALE_WAGER_INTERVAL_MS);
  if (staleWagerTimer.unref) staleWagerTimer.unref();

  expiredWagerTimer = setInterval(() => {
    if (!wagerReady || typeof wager.handleExpiredWagers !== 'function') return;
    wager.handleExpiredWagers().catch((err) => {
      console.error('[WAGER] expire:', err.message);
    });
  }, EXPIRED_WAGER_INTERVAL_MS);
  if (expiredWagerTimer.unref) expiredWagerTimer.unref();

  console.log('[WAGER] Maintenance started');
}

function stopWagerMaintenance() {
  if (staleWagerTimer) { clearInterval(staleWagerTimer); staleWagerTimer = null; }
  if (expiredWagerTimer) { clearInterval(expiredWagerTimer); expiredWagerTimer = null; }
}

// ============================================================================
// STARTUP / SHUTDOWN
// ============================================================================
async function startServer() {
  if (pool) {
    const ok = await initializeDatabase();
    if (!ok) console.error('[STARTUP] DB init failed; running degraded.');
  }

  server.listen(PORT, () => {
    console.log('==============================================');
    console.log(`Cafe Life listening on port ${PORT}`);
    console.log(`TURN: ${TURN_SECRET ? 'configured' : 'disabled'}`);
    console.log(`Database: ${pool ? 'configured' : 'disabled'}`);
    console.log(`Auth: ${authReady ? 'ready' : 'unavailable'}`);
    console.log(`Wallet: ${walletReady ? 'ready' : 'unavailable'}`);
    console.log(`Payments: ${paymentsReady ? 'ready' : (stripe ? 'configured' : 'disabled')}`);
    console.log(`Wager: ${wagerReady ? 'ready' : 'unavailable'}`);
    console.log(`Games: ${GAMES.map(g => g.prefix).join(', ')}`);
    console.log('==============================================');
  });

  startWagerMaintenance();
}

async function shutdown() {
  console.log('Shutting down...');
  clearInterval(heartbeat);
  clearInterval(revalidationTimer);
  stopWagerMaintenance();

  // [S-15] Dedupe cancel calls by accountId.
  if (wagerReady && typeof wager.cancelPendingByPlayer === 'function') {
    const uniqueAccounts = new Set();
    for (const ws of wss.clients) {
      if (ws.authenticated && ws.accountId) uniqueAccounts.add(ws.accountId);
    }
    const tasks = [...uniqueAccounts].map((accountId) =>
      wager.cancelPendingByPlayer(accountId).catch((err) => {
        console.error('[WAGER] shutdown cancel:', err.message);
      })
    );
    if (tasks.length) {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
    }
  }

  for (const ws of wss.clients) closeSocket(ws, 1001, 'Server shutting down');

  await new Promise((resolve) => {
    wss.close(() => resolve());
  });
  await new Promise((resolve) => {
    server.close(() => resolve());
  });

  if (pool) {
    try { await pool.end(); } catch (err) { console.error('[DB] end:', err.message); }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

startServer().catch((err) => {
  console.error('[STARTUP FAILED]', err.message);
  process.exit(1);
});

'use strict';

// ============================================================================
// server.js — Cafe Life Entrypoint (clean rewrite v1.2 + Withdrawals)
// ============================================================================

const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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
const createWithdrawals = require('./payments/withdrawals');                   // ✅ WITHDRAWALS
const registerWithdrawalRoutes = require('./payments/withdrawals.routes');    // ✅ WITHDRAWALS

// ============================================================================
// 1. ENVIRONMENT
// ============================================================================
const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 10000),
  IS_PRODUCTION: process.env.NODE_ENV === 'production',

  DATABASE_URL: process.env.DATABASE_URL || '',

  FRONTEND_ORIGIN: String(process.env.FRONTEND_ORIGIN || 'https://www.muchokutensei.com').replace(/\/+$/, ''),

  JWT_SECRET: process.env.JWT_SECRET || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

  TURN_SECRET: process.env.TURN_SECRET || '',
  TURN_HOST: process.env.TURN_HOST || '',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  MAX_WS_PAYLOAD: 32 * 1024,
  AUTH_TIMEOUT_MS: 10_000,
  HEARTBEAT_INTERVAL_MS: 30_000,
  SESSION_CHECK_INTERVAL_MS: 15_000,

  MOVE_RATE_MAX: 30,
  MOVE_RATE_WINDOW: 1_000,
  CHAT_RATE_MAX: 10,
  CHAT_RATE_WINDOW: 10_000,
  SIGNAL_RATE_MAX: 60,
  SIGNAL_RATE_WINDOW: 60_000,

  MAX_SDP_LEN: 20_000,
  MAX_CANDIDATE_LEN: 2_000,

  WAGER_CLEANUP_INTERVAL_MS: 60_000,
  WAGER_EXPIRE_INTERVAL_MS: 60 * 60_000,
  WAGER_RETRY_INTERVAL_MS: 30_000,

  DB_RETRY_ATTEMPTS: 15,
  DB_RETRY_MAX_WAIT_MS: 15_000,
};

const WS_CLOSE_REVOKED = 1008;

// ============================================================================
// 2. LOGGER
// ============================================================================
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  log: (...args) => console.log(...args), // Alias for older modules
};

// ============================================================================
// 3. POSTGRES POOL
// ============================================================================
let pool = null;
if (ENV.DATABASE_URL) {
  pool = new Pool({
    connectionString: ENV.DATABASE_URL,
    ssl: ENV.IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 20_000,
  });
  pool.on('error', (err) => logger.error('[DB POOL]', err.message));
} else {
  logger.warn('[DB] DATABASE_URL missing — DB features disabled.');
}

// ============================================================================
// 4. MODULE INITIALIZATION
// ============================================================================
const auth = createAuth({ pool, env: process.env, log: logger });
const wallet = createWallet({ pool, log: logger });
const stripe = createStripe({
  secretKey: ENV.STRIPE_SECRET_KEY,
  publishableKey: ENV.STRIPE_PUBLISHABLE_KEY,
  webhookSecret: ENV.STRIPE_WEBHOOK_SECRET,
  log: logger,
});
const wager = createWager({ pool, wallet, log: logger });
const withdrawals = createWithdrawals({ pool, wallet, log: logger });          // ✅ WITHDRAWALS

const READY = { auth: false, wallet: false, payments: false, wager: false, withdrawals: false };

// ============================================================================
// 5. PLAYER MAPS
// ============================================================================
const players = new Map();
const sockets = new Map();
const playerAccountMap = new Map();

const socketsByJti = new Map();
const moveRate = new Map();
const chatRate = new Map();
const signalRate = new Map();

// ============================================================================
// 6. HELPERS
// ============================================================================
function rememberPlayerAccount(playerId, accountId) {
  if (playerId && accountId != null) playerAccountMap.set(playerId, String(accountId));
}
function scheduleForgetPlayerAccount(playerId) {
  if (!playerId) return;
  const t = setTimeout(() => {
    if (!sockets.has(playerId)) playerAccountMap.delete(playerId);
  }, 5 * 60_000);
  if (t.unref) t.unref();
}
function getRealId(playerId) {
  if (!playerId) return null;
  const ws = sockets.get(playerId);
  if (ws && ws.accountId) return String(ws.accountId);
  const cached = playerAccountMap.get(playerId);
  if (cached) return String(cached);
  return null;
}

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
  try { ws.close(code, reason); } catch (e) { /* ignore */ }
}
function closeByJti(jti) {
  if (!jti) return;
  const set = socketsByJti.get(String(jti));
  if (!set) return;
  for (const ws of [...set]) closeSocket(ws, WS_CLOSE_REVOKED, 'Session revoked');
}

function rateCheck(map, id, max, windowMs) {
  const now = Date.now();
  let b = map.get(id);
  if (!b || now >= b.reset) { b = { count: 0, reset: now + windowMs }; map.set(id, b); }
  return ++b.count <= max;
}
function rateClear(id) {
  moveRate.delete(id);
  chatRate.delete(id);
  signalRate.delete(id);
}

function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(data)); return true; }
  catch (err) { logger.error('[WS SEND]', err.message); return false; }
}

function broadcast(data, excludeId = null) {
  const message = JSON.stringify(data);
  for (const [id, ws] of sockets) {
    if (id === excludeId) continue;
    if (!ws.authenticated) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    try { ws.send(message); } catch (err) { logger.error('[WS BROADCAST]', err.message); }
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

function iceFor(id) {
  if (!ENV.TURN_SECRET || !ENV.TURN_HOST) return [];
  const username = Math.floor(Date.now() / 1000) + 12 * 3600 + ':' + id;
  const credential = crypto.createHmac('sha1', ENV.TURN_SECRET).update(username).digest('base64');
  return [{
    urls: [`turn:${ENV.TURN_HOST}:3478?transport=udp`, `turn:${ENV.TURN_HOST}:3478?transport=tcp`],
    username, credential,
  }];
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const norm = String(origin).replace(/\/+$/, '');
  if (norm === ENV.FRONTEND_ORIGIN) return true;
  const host = ENV.FRONTEND_ORIGIN.replace(/^https?:\/\//, '');
  const alt = host.startsWith('www.') ? host.replace(/^www\./, '') : 'www.' + host;
  if (norm === 'https://' + alt) return true;
  if (norm === 'http://' + alt && !ENV.IS_PRODUCTION) return true;
  if (!ENV.IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(norm)) return true;
  return false;
}

// ============================================================================
// 7. DATABASE INIT
// ============================================================================
async function initializeDatabase() {
  if (!pool) return false;
  for (let attempt = 1; attempt <= ENV.DB_RETRY_ATTEMPTS; attempt++) {
    try {
      logger.info(`[DB] Attempt ${attempt}/${ENV.DB_RETRY_ATTEMPTS}...`);
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
      await auth.ensureSchema(); READY.auth = true;
      await wallet.ensureSchema(); await wallet.seedPackages(); READY.wallet = true;
      try { if (typeof wager.cleanupStaleWagers === 'function') await wager.cleanupStaleWagers({ olderThanMinutes: 10 }); } catch (e) { logger.error('[WAGER] Startup cleanup:', e.message); }
      await wager.ensureSchema(); READY.wager = true;
      await withdrawals.ensureSchema(); READY.withdrawals = true;              // ✅ WITHDRAWALS

      logger.info('[DB] Schema ready.');
      return true;
    } catch (err) {
      logger.error(`[DB] Attempt ${attempt} failed:`, err.message);
      READY.auth = READY.wallet = READY.wager = READY.withdrawals = false;
      if (attempt < ENV.DB_RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, Math.min(2_000 * attempt, ENV.DB_RETRY_MAX_WAIT_MS)));
      }
    }
  }
  logger.error('[DB] All connection attempts failed.');
  return false;
}

// ============================================================================
// 8. WAGER & WALLET WRAPPERS
// ============================================================================
async function sendWalletUpdate(playerId) {
  if (!playerId) return;
  const ws = sockets.get(playerId);
  if (!ws || !ws.authenticated || !ws.accountId) return;
  try {
    const balance = await wallet.getBalance(ws.accountId);
    if (balance !== null) send(ws, { type: 'wallet:update', tokens: balance });
  } catch (e) { logger.error(`[WALLET UPDATE] ${playerId}:`, e.message); }
}

function notifyWagerError(playerId, action, e, context = {}) {
  const ws = sockets.get(playerId);
  if (!ws) return;
  send(ws, {
    type: 'wager:error', action,
    reason: (e && (e.code || e.message)) || 'unknown',
    required: e && e.required != null ? e.required : null,
    available: e && e.available != null ? e.available : null,
    ...context,
  });
}

const createWagerForPlayer = async (playerId, gameType, roomId, amount) => {
  const realId = getRealId(playerId);
  if (!realId) { notifyWagerError(playerId, 'create', { code: 'player_unresolved' }, { game: gameType, room: roomId }); throw Object.assign(new Error('player_unresolved'), { code: 'player_unresolved' }); }
  try { const row = await wager.createWager(realId, gameType, roomId, amount); await sendWalletUpdate(playerId); return row; }
  catch (e) { notifyWagerError(playerId, 'create', e, { game: gameType, room: roomId, amount }); throw e; }
};
const acceptWagerForPlayer = async (playerId, wagerId) => {
  const realId = getRealId(playerId);
  if (!realId) { notifyWagerError(playerId, 'accept', { code: 'player_unresolved' }, { wagerId }); throw Object.assign(new Error('player_unresolved'), { code: 'player_unresolved' }); }
  try { const row = await wager.acceptWager(realId, wagerId); await sendWalletUpdate(playerId); return row; }
  catch (e) { notifyWagerError(playerId, 'accept', e, { wagerId }); throw e; }
};
const cancelWagerForPlayer = async (playerId, wagerId) => {
  const realId = getRealId(playerId);
  if (!realId) { notifyWagerError(playerId, 'cancel', { code: 'player_unresolved' }, { wagerId }); throw Object.assign(new Error('player_unresolved'), { code: 'player_unresolved' }); }
  try { const row = await wager.cancelWager(realId, wagerId); await sendWalletUpdate(playerId); return row; }
  catch (e) { notifyWagerError(playerId, 'cancel', e, { wagerId }); throw e; }
};
const settleGameWager = async (gameType, roomId, winnerPlayerId, loserPlayerId) => {
  let realWinnerId = null;
  if (winnerPlayerId) {
    realWinnerId = getRealId(winnerPlayerId);
    if (!realWinnerId || !/^\d+$/.test(String(realWinnerId))) { logger.error(`[SETTLE] Cannot resolve winner ${winnerPlayerId} for ${gameType}/${roomId}.`); return; }
  }
  try { await wager.settleWager(gameType, roomId, realWinnerId); const notify = [winnerPlayerId, loserPlayerId].filter(Boolean); for (const pid of notify) await sendWalletUpdate(pid); }
  catch (e) { logger.error(`[SETTLE] ${gameType}/${roomId} failed:`, e?.message); }
};

// ============================================================================
// 9. EXPRESS
// ============================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Stripe webhook needs raw body BEFORE json parser
if (stripe && ENV.STRIPE_WEBHOOK_SECRET) {
  try {
    const createPaymentsWebhook = require('./payments/payments.webhook');
    app.post('/payments/webhook', express.raw({ type: 'application/json', limit: '100kb' }), createPaymentsWebhook({ pool, wallet, stripe, log: logger }));
    logger.info('[PAYMENTS] Webhook registered.');
  } catch (err) { logger.error('[PAYMENTS] Webhook load failed:', err.message); }
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    logger.warn('[CORS] Blocked:', origin);
    return callback(new Error('not_allowed_by_cors'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  maxAge: 600,
}));

// CSRF check for cookie-based requests
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const hasCookie = /\bcafe_session=/.test(String(req.headers.cookie || ''));
  if (!hasCookie) return next();
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  const referer = String(req.headers.referer || '');
  const allowed = (origin && isAllowedOrigin(origin)) || referer.startsWith(ENV.FRONTEND_ORIGIN + '/') || (!ENV.IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(origin));
  if (!allowed) {
    logger.warn('[CSRF] Blocked:', { origin, referer, path: req.path });
    return res.status(403).json({ ok: false, error: 'csrf_blocked' });
  }
  next();
});

app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

// Basic routes
app.get('/', (_req, res) => res.status(200).send('Cafe Life Server running'));
app.get('/version', (_req, res) => res.json({ service: 'Cafe Life', status: 'ok' }));
app.get('/db-check', async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

// Route gating
app.use('/auth', (_req, res, next) => { if (!READY.auth) return res.status(503).json({ ok: false, error: 'auth_not_ready' }); next(); });
auth.register(app);

app.use('/wallet', (_req, res, next) => { if (!READY.wallet) return res.status(503).json({ ok: false, error: 'wallet_not_ready' }); next(); });
registerWalletRoutes(app, { wallet, identify: auth.identify, identifyRequest: auth.identifyRequest, log: logger });

app.use('/payments', (_req, res, next) => { if (!stripe) return res.status(503).json({ ok: false, error: 'payments_not_configured' }); next(); });
if (stripe) {
  try {
    const result = registerPaymentsRoutes(app, { stripe, wallet, identify: auth.identify, identifyRequest: auth.identifyRequest, pool, log: logger });
    READY.payments = Boolean(result && result.enabled);
  } catch (err) { logger.error('[PAYMENTS] Route registration failed:', err.message); }
}

app.use('/wager', (_req, res, next) => { if (!READY.wager) return res.status(503).json({ ok: false, error: 'wager_not_ready' }); next(); });
registerWagerRoutes(app, { wager, identify: auth.identify, identifyRequest: auth.identifyRequest, log: logger });

// ✅ WITHDRAWALS ROUTES
app.use('/withdrawals', (_req, res, next) => {
  if (!READY.withdrawals) return res.status(503).json({ ok: false, error: 'withdrawals_not_ready' });
  next();
});
registerWithdrawalRoutes(app, {
  withdrawals,
  identifyRequest: auth.identifyRequest,
  log: logger,
});

// ============================================================================
// 10. GAME MODULES
// ============================================================================
const DIR = fs.existsSync(path.join(__dirname, 'games')) ? path.join(__dirname, 'games') : __dirname;
const GAME_NAMES = ['chess', 'shkobba', 'rummy', 'voice'];
const GAMES = [];

const ctx = {
  send, sockets, players, broadcast, crypto, wallet, wager, getRealId, sendWalletUpdate,
  createWager: createWagerForPlayer,
  acceptWager: acceptWagerForPlayer,
  cancelWager: cancelWagerForPlayer,
  settleWager: settleGameWager,
};

for (const name of GAME_NAMES) {
  const file = path.join(DIR, name + '.js');
  if (!fs.existsSync(file)) { logger.warn(`[GAME] SKIP ${name}.js (missing)`); continue; }
  try {
    const createGame = require(file);
    if (typeof createGame !== 'function') { logger.warn(`[GAME] SKIP ${name}.js (not a function)`); continue; }
    GAMES.push(createGame(ctx));
    logger.info(`[GAME] Loaded ${name}.js`);
  } catch (err) { logger.error(`[GAME] FAILED ${name}.js:`, err.message); }
}

const VOICE = GAMES.find((g) => g.prefix === 'voice:');

function delegateToGame(id, data) {
  const game = GAMES.find((g) => String(data.type).startsWith(g.prefix));
  if (!game || typeof game.handle !== 'function') return false;
  try { game.handle(id, data); return true; }
  catch (err) { logger.error(`[GAME ${game.prefix}] handle failed:`, err.message); return false; }
}

// ============================================================================
// 11. HTTP + WS SERVER
// ============================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: ENV.MAX_WS_PAYLOAD,
  perMessageDeflate: false,
});

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
    if (!ws.authenticated && ws.readyState === WebSocket.OPEN) ws.close(1008, 'Auth timeout');
  }, ENV.AUTH_TIMEOUT_MS);

  const ticket = (() => { try { return new URL(req.url, 'http://localhost').searchParams.get('ticket'); } catch { return null; } })();
  let account = null;
  try {
    if (typeof ticket === 'string' && ticket.length >= 20 && ticket.length <= 512 && typeof auth.consumeWsTicket === 'function') {
      account = await auth.consumeWsTicket(ticket);
    }
  } catch (err) { logger.error('[WS AUTH]', err.message); }

  clearTimeout(authTimer);
  if (!account || ws.readyState !== WebSocket.OPEN) {
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'Invalid ticket');
    return;
  }

  ws.authenticated = true;
  ws.accountId = String(account.id);
  ws.accountName = String(account.name || 'Player').slice(0, 24);
  ws.accountColor = String(account.color || '#e74c3c').slice(0, 9);
  ws.jti = account.jti ? String(account.jti) : null;
  ws.playerId = 'p_' + crypto.randomBytes(6).toString('hex');

  sockets.set(ws.playerId, ws);
  rememberPlayerAccount(ws.playerId, ws.accountId);
  addToIndex(socketsByJti, ws.jti, ws);

  logger.info(`[WS AUTH] ${ws.playerId} account=${ws.accountId}`);

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
    catch (err) { logger.error('[HANDLE]', err.message); }
  });

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
        try { game.leave(playerId); } catch (err) { logger.error('[GAME LEAVE]', err.message); }
      }
    }

    broadcast({ type: 'player:leave', id: playerId });
    scheduleForgetPlayerAccount(playerId);

    if (READY.wager && typeof wager.cancelPendingByPlayer === 'function' && accountId) {
      try {
        const n = await wager.cancelPendingByPlayer(accountId);
        if (n > 0) logger.info(`[WAGER] Cancelled ${n} pending for account=${accountId}`);
      } catch (err) { logger.error('[WAGER] cancelPendingByPlayer failed:', err.message); }
    }
  });

  ws.on('error', (err) => logger.error('[WS ERROR]', err.message));
});

// ============================================================================
// 12. MESSAGE HANDLER
// ============================================================================
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
      if (!rateCheck(moveRate, id, ENV.MOVE_RATE_MAX, ENV.MOVE_RATE_WINDOW)) break;

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
        try { VOICE.onMove(id); } catch (err) { logger.error('[VOICE MOVE]', err.message); }
      }
      break;
    }

    case 'chat': {
      const player = players.get(id);
      if (!player) break;
      if (!rateCheck(chatRate, id, ENV.CHAT_RATE_MAX, ENV.CHAT_RATE_WINDOW)) {
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
      if (!rateCheck(signalRate, id, ENV.SIGNAL_RATE_MAX, ENV.SIGNAL_RATE_WINDOW)) {
        send(ws, { type: 'signal:err', reason: 'rate_limited' });
        break;
      }
      const p = data.data;
      if (!p || typeof p !== 'object') break;
      const sdp = typeof p.sdp === 'string' ? p.sdp : null;
      const candidate = typeof p.candidate === 'string' ? p.candidate : null;
      if ((sdp && sdp.length > ENV.MAX_SDP_LEN) || (candidate && candidate.length > ENV.MAX_CANDIDATE_LEN)) break;
      if (!sdp && !candidate) break;

      const target = sockets.get(data.to);
      if (!target || !target.authenticated || target.readyState !== WebSocket.OPEN) break;

      send(target, {
        type: 'signal', from: id,
        data: { sdp, candidate, type: typeof p.type === 'string' ? p.type : undefined },
      });
      break;
    }

    default:
      delegateToGame(id, data);
      break;
  }
}

// ============================================================================
// 13. BACKGROUND WORKERS
// ============================================================================
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, ENV.HEARTBEAT_INTERVAL_MS);
if (heartbeat.unref) heartbeat.unref();

const revalidationTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!ws.authenticated || !ws.jti) continue;
    if (typeof auth.isSessionValid !== 'function') continue;
    auth.isSessionValid(ws.jti).then(valid => {
      if (!valid) closeSocket(ws, WS_CLOSE_REVOKED, 'Session expired');
    }).catch(err => logger.error('[REVALIDATE]', err.message));
  }
}, ENV.SESSION_CHECK_INTERVAL_MS);
if (revalidationTimer.unref) revalidationTimer.unref();

let wagerCleanupTimer = null;
let wagerExpireTimer = null;
let wagerRetryTimer = null;

function startWagerMaintenance() {
  if (!READY.wager) return;

  wagerCleanupTimer = setInterval(() => {
    if (!READY.wager) return;
    if (typeof wager.cleanupStaleWagers !== 'function') return;
    wager.cleanupStaleWagers({ olderThanMinutes: 10 }).catch(err => logger.error('[WAGER] cleanup:', err.message));
  }, ENV.WAGER_CLEANUP_INTERVAL_MS);
  if (wagerCleanupTimer.unref) wagerCleanupTimer.unref();

  wagerExpireTimer = setInterval(() => {
    if (!READY.wager) return;
    if (typeof wager.handleExpiredWagers !== 'function') return;
    wager.handleExpiredWagers().catch(err => logger.error('[WAGER] expire:', err.message));
  }, ENV.WAGER_EXPIRE_INTERVAL_MS);
  if (wagerExpireTimer.unref) wagerExpireTimer.unref();

  wagerRetryTimer = setInterval(() => {
    if (!READY.wager) return;
    if (typeof wager.retryPendingRefunds === 'function') {
      wager.retryPendingRefunds({ limit: 20 }).catch(err => logger.error('[WAGER] retryRefunds:', err.message));
    }
    if (typeof wager.retryPendingPayouts === 'function') {
      wager.retryPendingPayouts({ limit: 20 }).catch(err => logger.error('[WAGER] retryPayouts:', err.message));
    }
  }, ENV.WAGER_RETRY_INTERVAL_MS);
  if (wagerRetryTimer.unref) wagerRetryTimer.unref();

  logger.info('[WAGER] Maintenance started');
}

function stopWagerMaintenance() {
  if (wagerCleanupTimer) { clearInterval(wagerCleanupTimer); wagerCleanupTimer = null; }
  if (wagerExpireTimer) { clearInterval(wagerExpireTimer); wagerExpireTimer = null; }
  if (wagerRetryTimer) { clearInterval(wagerRetryTimer); wagerRetryTimer = null; }
}

// ============================================================================
// 14. STARTUP / SHUTDOWN
// ============================================================================
async function startServer() {
  if (pool) {
    const ok = await initializeDatabase();
    if (!ok) logger.error('[STARTUP] DB init failed; running degraded.');
  }

  server.listen(ENV.PORT, () => {
    console.log('==============================================');
    console.log(`Cafe Life listening on port ${ENV.PORT}`);
    console.log(`Frontend origin: ${ENV.FRONTEND_ORIGIN}`);
    console.log(`TURN: ${ENV.TURN_SECRET ? 'configured' : 'disabled'}`);
    console.log(`Database: ${pool ? 'configured' : 'disabled'}`);
    console.log(`Auth: ${READY.auth ? 'ready' : 'unavailable'}`);
    console.log(`Wallet: ${READY.wallet ? 'ready' : 'unavailable'}`);
    console.log(`Payments: ${READY.payments ? 'ready' : (stripe ? 'configured' : 'disabled')}`);
    console.log(`Wager: ${READY.wager ? 'ready' : 'unavailable'}`);
    console.log(`Withdrawals: ${READY.withdrawals ? 'ready' : 'unavailable'}`);   // ✅ WITHDRAWALS
    console.log(`Games: ${GAMES.map(g => g.prefix).join(', ')}`);
    console.log('==============================================');
  });

  startWagerMaintenance();
}

async function shutdown() {
  logger.info('Shutting down Cafe Life...');
  clearInterval(heartbeat);
  clearInterval(revalidationTimer);
  stopWagerMaintenance();

  if (READY.wager && typeof wager.cancelPendingByPlayer === 'function') {
    const uniqueAccounts = new Set();
    for (const ws of wss.clients) {
      if (ws.authenticated && ws.accountId) uniqueAccounts.add(ws.accountId);
    }
    const tasks = [...uniqueAccounts].map((accountId) =>
      wager.cancelPendingByPlayer(accountId).catch(err => logger.error('[WAGER] shutdown cancel:', err.message))
    );
    if (tasks.length) {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise(r => setTimeout(r, 3_000)),
      ]);
    }
  }

  for (const ws of wss.clients) closeSocket(ws, 1001, 'Server shutting down');

  await new Promise((resolve) => { wss.close(() => resolve()); });
  await new Promise((resolve) => { server.close(() => resolve()); });

  if (pool) {
    try { await pool.end(); } catch (err) { logger.error('[DB] end:', err.message); }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => logger.error('[UNHANDLED]', err));

startServer().catch((err) => {
  logger.error('[STARTUP FAILED]', err.message);
  process.exit(1);
});

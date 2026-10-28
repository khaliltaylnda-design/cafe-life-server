'use strict';

// ============================================================================
// server.js — Cafe Life Entrypoint (clean rewrite).
// ============================================================================
// المسؤوليات:
//   1. تحميل الإعدادات من البيئة.
//   2. إنشاء pool + modules (auth, wallet, wager, stripe, games).
//   3. تركيب Express (CORS, CSRF, JSON, routes).
//   4. إنشاء HTTP + WebSocket.
//   5. تشغيل background workers (cleanup, retries).
//   6. إغلاق نظيف عند SIGTERM/SIGINT.
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
// 1. ENVIRONMENT
// ============================================================================
const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 10000),
  IS_PRODUCTION: process.env.NODE_ENV === 'production',

  DATABASE_URL: process.env.DATABASE_URL || '',

  FRONTEND_ORIGIN: String(process.env.FRONTEND_ORIGIN || 'https://www.muchokutensei.com').replace(/\/+$/, ''),
  FRONTEND_URL: String(process.env.FRONTEND_URL || process.env.FRONTEND_ORIGIN || 'https://www.muchokutensei.com').replace(/\/+$/, ''),

  JWT_SECRET: process.env.JWT_SECRET || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

  TURN_SECRET: process.env.TURN_SECRET || '',
  TURN_HOST: process.env.TURN_HOST || '',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  // WebSocket
  MAX_WS_PAYLOAD: 32 * 1024,
  AUTH_TIMEOUT_MS: 10_000,
  HEARTBEAT_INTERVAL_MS: 30_000,
  SESSION_CHECK_INTERVAL_MS: 15_000,

  // Rate limits (per player)
  MOVE_RATE_MAX: 30,
  MOVE_RATE_WINDOW: 1_000,
  CHAT_RATE_MAX: 10,
  CHAT_RATE_WINDOW: 10_000,
  SIGNAL_RATE_MAX: 60,
  SIGNAL_RATE_WINDOW: 60_000,

  // Limits
  MAX_SDP_LEN: 20_000,
  MAX_CANDIDATE_LEN: 2_000,
  MAX_CHAT_LEN: 80,

  // Background workers
  WAGER_CLEANUP_INTERVAL_MS: 60_000,
  WAGER_EXPIRE_INTERVAL_MS: 60 * 60_000,
  WAGER_RETRY_INTERVAL_MS: 30_000,

  // DB
  DB_RETRY_ATTEMPTS: 15,
  DB_RETRY_MAX_WAIT_MS: 15_000,
};

const WS_CLOSE_REVOKED = 1008;

// ============================================================================
// 2. LOGGER
// ============================================================================
// الكائن يحتوي على log/warn/error/debug/info + log كـ alias للتوافق مع
// الوحدات القديمة التي تستخدم log.log(...) و log.warn(...) و log.error(...).
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: (...args) => { if (!ENV.IS_PRODUCTION) console.log('[DEBUG]', ...args); },
  // Aliases for legacy modules
  log: (...args) => console.log(...args),
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
// 4. MODULES
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

const readiness = {
  auth: false,
  wallet: false,
  wager: false,
  payments: Boolean(stripe),
};

// ============================================================================
// 5. EXPRESS APP
// ============================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ----------------------------------------------------------------------------
// 5a. CORS
// ----------------------------------------------------------------------------
function isAllowedOrigin(origin) {
  if (!origin) return true;

  const norm = String(origin).replace(/\/+$/, '');
  if (norm === ENV.FRONTEND_ORIGIN) return true;

  const host = ENV.FRONTEND_ORIGIN.replace(/^https?:\/\//, '');
  const alt = host.startsWith('www.') ? host.replace(/^www\./, '') : 'www.' + host;
  if (norm === 'https://' + alt) return true;

  if (!ENV.IS_PRODUCTION) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(norm)) return true;
  }
  return false;
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    logger.warn('[CORS] Blocked origin:', origin);
    return callback(new Error('not_allowed_by_cors'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  maxAge: 600,
}));

// ----------------------------------------------------------------------------
// 5b. CSRF — فقط للطلبات التي تحمل cookie
// ----------------------------------------------------------------------------
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const cookies = String(req.headers.cookie || '');
  const hasSessionCookie = /\bcafe_session=/.test(cookies);
  if (!hasSessionCookie) return next();

  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  const referer = String(req.headers.referer || '');

  const allowed =
    (origin && isAllowedOrigin(origin)) ||
    referer.startsWith(ENV.FRONTEND_ORIGIN + '/') ||
    (!ENV.IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(referer));

  if (!allowed) {
    logger.warn('[CSRF] Blocked:', { method: req.method, path: req.path, origin, referer });
    return res.status(403).json({ ok: false, error: 'csrf_blocked' });
  }
  next();
}

// ----------------------------------------------------------------------------
// 5c. Webhook BEFORE json parser
// ----------------------------------------------------------------------------
if (stripe && ENV.STRIPE_WEBHOOK_SECRET) {
  try {
    const createPaymentsWebhook = require('./payments/payments.webhook');
    app.post(
      '/payments/webhook',
      express.raw({ type: 'application/json', limit: '100kb' }),
      createPaymentsWebhook({ pool, wallet, stripe, log: logger })
    );
    logger.info('[PAYMENTS] Webhook registered.');
  } catch (err) {
    logger.error('[PAYMENTS] Webhook load failed:', err.message);
  }
}

// ----------------------------------------------------------------------------
// 5d. JSON parser
// ----------------------------------------------------------------------------
app.use(express.json({ limit: '20kb' }));

// ----------------------------------------------------------------------------
// 5e. CSRF
// ----------------------------------------------------------------------------
app.use(csrfGuard);

// ----------------------------------------------------------------------------
// 5f. Health endpoints
// ----------------------------------------------------------------------------
app.get('/', (_req, res) => res.status(200).send('Cafe Life Server running'));

app.get('/health', async (_req, res) => {
  const health = {
    ok: true,
    uptime: process.uptime(),
    ready: { ...readiness },
    db: false,
  };
  if (pool) {
    try { await pool.query('SELECT 1'); health.db = true; }
    catch { health.ok = false; }
  }
  res.status(health.ok ? 200 : 503).json(health);
});

app.get('/version', (_req, res) => {
  res.json({
    service: 'Cafe Life',
    version: process.env.npm_package_version || 'unknown',
    node: process.version,
  });
});

// ============================================================================
// 6. MOUNT ROUTES
// ============================================================================
const guardReady = (key) => (req, res, next) =>
  readiness[key] ? next() : res.status(503).json({ ok: false, error: `${key}_not_ready` });

// 6a. Auth
auth.register(app);

// 6b. Wallet
app.use('/wallet', guardReady('wallet'));
registerWalletRoutes(app, {
  wallet,
  identify: auth.identify,
  identifyRequest: auth.identifyRequest,
  log: logger,
});

// 6c. Payments
if (stripe) {
  app.use('/payments', guardReady('payments'));
  try {
    const result = registerPaymentsRoutes(app, {
      stripe,
      wallet,
      identify: auth.identify,
      identifyRequest: auth.identifyRequest,
      pool,
      log: logger,
      frontendUrl: ENV.FRONTEND_URL,
    });
    readiness.payments = Boolean(result && result.enabled);
  } catch (err) {
    readiness.payments = false;
    logger.error('[PAYMENTS] Route registration failed:', err.message);
  }
}

// 6d. Wager
app.use('/wager', guardReady('wager'));
registerWagerRoutes(app, {
  wager,
  identify: auth.identify,
  identifyRequest: auth.identifyRequest,
  log: logger,
});

// 6e. 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// 6f. Error handler
app.use((err, req, res, _next) => {
  logger.error('[EXPRESS]', { path: req.path, message: err.message });
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'internal_error' });
});

// ============================================================================
// 7. SOCKET REGISTRY
// ============================================================================
const sockets = new Map();
const players = new Map();
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
  try { ws.close(code, reason); } catch (e) { logger.error('[WS CLOSE]', e.message); }
}

function closeByJti(jti) {
  const set = socketsByJti.get(String(jti));
  if (!set) return;
  for (const ws of [...set]) closeSocket(ws, WS_CLOSE_REVOKED, 'Session revoked');
}

if (typeof auth.setSessionRevokedHandler === 'function') {
  auth.setSessionRevokedHandler((jti) => { if (jti) closeByJti(String(jti)); });
}

// ============================================================================
// 8. SEND HELPERS
// ============================================================================
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

// ============================================================================
// 9. TURN / ICE
// ============================================================================
function iceFor(id) {
  if (!ENV.TURN_SECRET || !ENV.TURN_HOST) return [];
  const username = Math.floor(Date.now() / 1000) + 12 * 3600 + ':' + id;
  const credential = crypto
    .createHmac('sha1', ENV.TURN_SECRET)
    .update(username)
    .digest('base64');
  return [{
    urls: [
      `turn:${ENV.TURN_HOST}:3478?transport=udp`,
      `turn:${ENV.TURN_HOST}:3478?transport=tcp`,
    ],
    username,
    credential,
  }];
}

// ============================================================================
// 10. RATE LIMITS
// ============================================================================
const moveRate = new Map();
const chatRate = new Map();
const signalRate = new Map();

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

// ============================================================================
// 11. WALLET HELPERS
// ============================================================================
async function sendWalletUpdate(playerId) {
  if (!playerId) return;
  const ws = sockets.get(playerId);
  if (!ws || !ws.authenticated || !ws.accountId) return;
  try {
    const balance = await wallet.getBalance(ws.accountId);
    if (balance !== null) send(ws, { type: 'wallet:update', tokens: balance });
  } catch (e) {
    logger.error(`[WALLET UPDATE] ${playerId}:`, e.message);
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

function getRealId(playerId) {
  if (!playerId) return null;
  const ws = sockets.get(playerId);
  return ws && ws.accountId ? String(ws.accountId) : null;
}

async function createWagerForPlayer(playerId, gameType, roomId, amount) {
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
}

async function acceptWagerForPlayer(playerId, wagerId) {
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
}

async function cancelWagerForPlayer(playerId, wagerId) {
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
}

async function settleGameWager(gameType, roomId, winnerPlayerId, loserPlayerId) {
  let realWinnerId = null;
  if (winnerPlayerId) {
    realWinnerId = getRealId(winnerPlayerId);
    if (!realWinnerId || !/^\d+$/.test(String(realWinnerId))) {
      logger.error(`[SETTLE] Cannot resolve winner ${winnerPlayerId} for ${gameType}/${roomId}`);
      return;
    }
  }
  try {
    await wager.settleWager(gameType, roomId, realWinnerId);
    const notify = [winnerPlayerId, loserPlayerId].filter(Boolean);
    for (const pid of notify) await sendWalletUpdate(pid);
  } catch (e) {
    logger.error(`[SETTLE] ${gameType}/${roomId} failed:`, e?.message);
  }
}

// ============================================================================
// 12. GAMES LOADER
// ============================================================================
const GAMES_DIR = fs.existsSync(path.join(__dirname, 'games'))
  ? path.join(__dirname, 'games')
  : __dirname;

const GAME_NAMES = ['chess', 'shkobba', 'rummy', 'voice'];
const GAMES = [];

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

for (const name of GAME_NAMES) {
  const file = path.join(GAMES_DIR, name + '.js');
  if (!fs.existsSync(file)) { logger.warn(`[GAME] SKIP ${name}.js (missing)`); continue; }
  try {
    const createGame = require(file);
    if (typeof createGame !== 'function') { logger.warn(`[GAME] SKIP ${name}.js (not a function)`); continue; }
    const instance = createGame(ctx);
    GAMES.push(instance);
    logger.info(`[GAME] Loaded ${name}.js (prefix=${instance.prefix})`);
  } catch (err) {
    logger.error(`[GAME] FAILED ${name}.js:`, err.message);
  }
}

const VOICE = GAMES.find((g) => g.prefix === 'voice:');

// ============================================================================
// 13. WS AUTH
// ============================================================================
function readTicket(req) {
  try { return new URL(req.url, 'http://localhost').searchParams.get('ticket'); }
  catch { return null; }
}

async function authenticateSocket(ticket) {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 512) return null;
  if (typeof auth.consumeWsTicket !== 'function') throw new Error('auth.consumeWsTicket missing');
  const account = await auth.consumeWsTicket(ticket);
  if (!account || account.id == null) return null;
  return {
    id: String(account.id),
    name: String(account.name || 'Player').slice(0, 24),
    color: String(account.color || '#e74c3c').slice(0, 9),
    jti: account.jti ? String(account.jti) : null,
  };
}

async function revalidateSocket(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!ws.authenticated || !ws.jti) return;
  if (typeof auth.isSessionValid !== 'function') return;
  try {
    const valid = await auth.isSessionValid(ws.jti);
    if (!valid) closeSocket(ws, WS_CLOSE_REVOKED, 'Session expired');
  } catch (err) { logger.error('[REVALIDATE]', err.message); }
}

// ============================================================================
// 14. WEBSOCKET SERVER
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

  let account = null;
  try { account = await authenticateSocket(readTicket(req)); }
  catch (err) { logger.error('[WS AUTH]', err.message); }
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
        try { game.leave(playerId); }
        catch (err) { logger.error(`[GAME LEAVE] ${game.prefix}`, err.message); }
      }
    }

    broadcast({ type: 'player:leave', id: playerId });

    if (readiness.wager && typeof wager.cancelPendingByPlayer === 'function' && accountId) {
      try {
        const n = await wager.cancelPendingByPlayer(accountId);
        if (n > 0) logger.info(`[WAGER] Cancelled ${n} pending for account=${accountId}`);
      } catch (err) {
        logger.error('[WAGER] cancelPendingByPlayer failed:', err.message);
      }
    }
  });

  ws.on('error', (err) => logger.error('[WS ERROR]', err.message));
});

// ============================================================================
// 15. MESSAGE HANDLER
// ============================================================================
function delegateToGame(id, data) {
  for (const game of GAMES) {
    if (String(data.type).startsWith(game.prefix)) {
      if (typeof game.handle !== 'function') return false;
      try { game.handle(id, data); return true; }
      catch (err) { logger.error(`[GAME ${game.prefix}] handle failed:`, err.message); return false; }
    }
  }
  return false;
}

function cleanChatText(input) {
  return String(input == null ? '' : input)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ENV.MAX_CHAT_LEN);
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
      if (!rateCheck(moveRate, id, ENV.MOVE_RATE_MAX, ENV.MOVE_RATE_WINDOW)) break;

      const x = Number(data.x);
      const z = Number(data.z);
      const ry = Number(data.ry);

      player.x = Number.isFinite(x) ? Math.max(-14, Math.min(14, x)) : 0;
      player.z = Number.isFinite(z) ? Math.max(-6, Math.min(9, z)) : 0;
      player.ry = Number.isFinite(ry) ? ((ry % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : 0;
      player.s = (data.s === true || data.s === 1) ? 1 : 0;

      broadcast({ type: 'player:move', id, x: player.x, y: 0, z: player.z, ry: player.ry, s: player.s }, id);

      if (VOICE && typeof VOICE.onMove === 'function') {
        try { VOICE.onMove(id); }
        catch (err) { logger.error('[VOICE MOVE]', err.message); }
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
        type: 'signal',
        from: id,
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
// 16. HEARTBEAT + SESSION REVALIDATION
// ============================================================================
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, ENV.HEARTBEAT_INTERVAL_MS);
if (heartbeat.unref) heartbeat.unref();

const revalidationTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!ws.authenticated || !ws.jti) continue;
    revalidateSocket(ws).catch((err) => logger.error('[REVALIDATE]', err.message));
  }
}, ENV.SESSION_CHECK_INTERVAL_MS);
if (revalidationTimer.unref) revalidationTimer.unref();

// ============================================================================
// 17. BACKGROUND WORKERS
// ============================================================================
const timers = [];

function scheduleWorker(name, intervalMs, fn) {
  const timer = setInterval(async () => {
    try { await fn(); }
    catch (err) { logger.error(`[WORKER ${name}]`, err.message); }
  }, intervalMs);
  if (timer.unref) timer.unref();
  timers.push({ name, timer });
  logger.info(`[WORKER] ${name} started (every ${intervalMs}ms)`);
}

function startWorkers() {
  if (typeof wager.cleanupStaleWagers === 'function') {
    scheduleWorker('wager.stale', ENV.WAGER_CLEANUP_INTERVAL_MS, () =>
      wager.cleanupStaleWagers({ olderThanMinutes: 10 })
    );
  }
  if (typeof wager.handleExpiredWagers === 'function') {
    scheduleWorker('wager.expire', ENV.WAGER_EXPIRE_INTERVAL_MS, () =>
      wager.handleExpiredWagers()
    );
  }
  if (typeof wager.retryPendingRefunds === 'function') {
    scheduleWorker('wager.retryRefunds', ENV.WAGER_RETRY_INTERVAL_MS, () =>
      wager.retryPendingRefunds({ limit: 50 })
    );
  }
  if (typeof wager.retryPendingPayouts === 'function') {
    scheduleWorker('wager.retryPayouts', ENV.WAGER_RETRY_INTERVAL_MS, () =>
      wager.retryPendingPayouts({ limit: 50 })
    );
  }
}

function stopWorkers() {
  for (const { name, timer } of timers) {
    clearInterval(timer);
    logger.info(`[WORKER] ${name} stopped`);
  }
  timers.length = 0;
}

// ============================================================================
// 18. DB INITIALIZATION
// ============================================================================
async function initializeDatabase() {
  if (!pool) {
    logger.warn('[DB] No pool — skipping initialization.');
    return false;
  }

  for (let attempt = 1; attempt <= ENV.DB_RETRY_ATTEMPTS; attempt++) {
    try {
      logger.info(`[DB] Init attempt ${attempt}/${ENV.DB_RETRY_ATTEMPTS}`);

      // 1. users table
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

      // 2. Auth schema
      try {
        await auth.ensureSchema();
        if (typeof auth.setReady === 'function') auth.setReady(true);
        readiness.auth = true;
        logger.info('[DB] Auth schema ready.');
      } catch (err) {
        readiness.auth = false;
        logger.error('[DB] Auth schema FAILED:', err.message);
      }

      // 3. Wallet schema
      try {
        await wallet.ensureSchema();
        await wallet.seedPackages();
        readiness.wallet = true;
        logger.info('[DB] Wallet schema ready.');
      } catch (err) {
        readiness.wallet = false;
        logger.error('[DB] Wallet schema FAILED:', err.message);
      }

      // 4. Wager schema
      try {
        await wager.ensureSchema({ skipLiveIndex: true });
        await wager.cleanupStaleWagers({ olderThanMinutes: 10 });
        await wager.ensureSchema();
        readiness.wager = true;
        logger.info('[DB] Wager schema ready.');
      } catch (err) {
        readiness.wager = false;
        logger.error('[DB] Wager schema FAILED:', err.message);
      }

      if (readiness.auth && readiness.wallet) {
        logger.info('[DB] Core schema ready.');
        return true;
      }

      if (attempt < ENV.DB_RETRY_ATTEMPTS) {
        const waitMs = Math.min(2_000 * attempt, ENV.DB_RETRY_MAX_WAIT_MS);
        logger.warn(`[DB] Retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    } catch (err) {
      logger.error(`[DB] Attempt ${attempt} crashed:`, err.message);
      if (attempt < ENV.DB_RETRY_ATTEMPTS) {
        const waitMs = Math.min(2_000 * attempt, ENV.DB_RETRY_MAX_WAIT_MS);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  logger.error('[DB] All attempts exhausted.');
  return false;
}

// ============================================================================
// 19. STARTUP / SHUTDOWN
// ============================================================================
let isShuttingDown = false;

async function start() {
  logger.info('==============================================');
  logger.info(`Cafe Life — ${ENV.NODE_ENV}`);
  logger.info(`Frontend: ${ENV.FRONTEND_ORIGIN}`);
  logger.info(`Database: ${pool ? 'configured' : 'disabled'}`);
  logger.info(`Auth: ${ENV.JWT_SECRET ? 'configured' : 'MISSING JWT_SECRET'}`);
  logger.info(`Google: ${ENV.GOOGLE_CLIENT_ID ? 'configured' : 'missing'}`);
  logger.info(`Stripe: ${stripe ? (stripe.isLive ? 'LIVE' : 'TEST') : 'disabled'}`);
  logger.info(`TURN: ${ENV.TURN_SECRET ? 'configured' : 'disabled'}`);
  logger.info('==============================================');

  if (!ENV.JWT_SECRET || ENV.JWT_SECRET.length < 32) {
    logger.error('FATAL: JWT_SECRET must be ≥32 chars.');
    process.exit(1);
  }

  const dbOk = await initializeDatabase();
  if (!dbOk) {
    logger.error('[STARTUP] DB init failed — running in degraded mode.');
  }

  if (readiness.wager) {
    startWorkers();
  } else {
    logger.warn('[WORKERS] Wager not ready — workers NOT started.');
  }

  await new Promise((resolve) => {
    server.listen(ENV.PORT, () => {
      logger.info(`[HTTP] Listening on port ${ENV.PORT}`);
      resolve();
    });
  });

  logger.info(`[READY] Games loaded: ${GAMES.map(g => g.prefix).join(', ')}`);
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`[SHUTDOWN] Received ${signal}, starting graceful shutdown...`);

  stopWorkers();
  clearInterval(heartbeat);
  clearInterval(revalidationTimer);

  if (readiness.wager && typeof wager.cancelPendingByPlayer === 'function') {
    const accounts = new Set();
    for (const ws of wss.clients) {
      if (ws.authenticated && ws.accountId) accounts.add(ws.accountId);
    }
    const tasks = [...accounts].map((acc) =>
      wager.cancelPendingByPlayer(acc).catch((err) =>
        logger.error('[WAGER] shutdown cancel:', err.message)
      )
    );
    if (tasks.length) {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
  }

  for (const ws of wss.clients) closeSocket(ws, 1001, 'Server shutting down');
  await new Promise((resolve) => wss.close(() => resolve()));

  await new Promise((resolve) => server.close(() => resolve()));

  for (const game of GAMES) {
    if (typeof game.shutdown === 'function') {
      try { game.shutdown(); } catch (err) { logger.error('[GAME SHUTDOWN]', err.message); }
    }
  }

  if (pool) {
    try { await pool.end(); } catch (err) { logger.error('[DB] pool.end:', err.message); }
  }

  logger.info('[SHUTDOWN] Complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('[UNHANDLED]', err));
process.on('uncaughtException', (err) => {
  logger.error('[UNCAUGHT]', err);
  shutdown('uncaughtException');
});

start().catch((err) => {
  logger.error('[STARTUP FAILED]', err);
  process.exit(1);
});

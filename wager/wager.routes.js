'use strict';

// wager/wager.routes.js — HTTP surface for wagers.
// ============================================================================
// Read/write routes for wagers. All mutations delegate to wager.js which
// handles state transitions atomically and idempotently.
//
// Endpoints:
//   POST /wager/create                       body: { game_type, room_id, amount }
//   POST /wager/accept                       body: { wager_id }
//   POST /wager/cancel                       body: { wager_id }
//   GET  /wager/room/:gameType/:roomId       → active wager or null
//   GET  /wager/:wager_id                    → wager by id (for polling/UI)
// ============================================================================

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

module.exports = function registerWagerRoutes(app, options = {}) {
  const { wager, identify, log = console } = options;

  if (!wager) throw new Error('registerWagerRoutes requires a wager instance');
  if (typeof identify !== 'function') {
    throw new Error('registerWagerRoutes requires identify()');
  }

  /* ------------------------------------------------------------
     Auth helpers
  ------------------------------------------------------------ */

  function bearer(req) {
    const header = String(req.headers?.authorization || '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    return match ? match[1] : '';
  }

  async function requireUser(req) {
    const token = bearer(req);
    if (!token) throw err('unauthorized', 401);
    const user = await identify(token);
    if (!user) throw err('unauthorized', 401);
    return user;
  }

  /* ------------------------------------------------------------
     Input validators
  ------------------------------------------------------------ */

  function validateGameType(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 20 || !/^[a-z_]+$/.test(s)) {
      throw err('invalid_game_type', 400);
    }
    return s;
  }

  function validateRoomId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 40) throw err('invalid_room_id', 400);
    return s;
  }

  function validateAmount(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw err('invalid_amount', 400);
    return n;
  }

  function validateWagerId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || !s.startsWith('wg_') || s.length > 40) {
      throw err('invalid_wager_id', 400);
    }
    return s;
  }

  /* ------------------------------------------------------------
     Response wrapper
  ------------------------------------------------------------ */
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      const code = error && error.code ? error.code : 'server_error';

      if (status >= 500) {
        log.error('[WAGER ROUTE]', code, '-', error && error.message);
      }

      const body = { ok: false, error: code };
      if (error && error.required != null) body.required = error.required;
      if (error && error.available != null) body.available = error.available;
      if (error && error.min != null) body.min = error.min;
      if (error && error.max != null) body.max = error.max;

      res.status(status).json(body);
    }
  };

  /* ------------------------------------------------------------
     POST /wager/create
  ------------------------------------------------------------ */
  app.post('/wager/create', wrap(async (req, res) => {
    const user = await requireUser(req);
    const body = req.body || {};

    const gameType = validateGameType(body.game_type);
    const roomId = validateRoomId(body.room_id);
    const amount = validateAmount(body.amount);

    const wagerRow = await wager.createWager(user.id, gameType, roomId, amount);
    res.status(201).json({ ok: true, wager: wagerRow });
  }));

  /* ------------------------------------------------------------
     POST /wager/accept
  ------------------------------------------------------------ */
  app.post('/wager/accept', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId((req.body || {}).wager_id);

    const wagerRow = await wager.acceptWager(user.id, wagerId);
    res.status(200).json({ ok: true, wager: wagerRow });
  }));

  /* ------------------------------------------------------------
     POST /wager/cancel
  ------------------------------------------------------------ */
  app.post('/wager/cancel', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId((req.body || {}).wager_id);

    const wagerRow = await wager.cancelWager(user.id, wagerId);
    res.status(200).json({ ok: true, wager: wagerRow });
  }));

  /* ------------------------------------------------------------
     GET /wager/room/:gameType/:roomId
     Returns the live wager in that room, or null.
     Requires authentication (prevents leaking amounts).
  ------------------------------------------------------------ */
  app.get('/wager/room/:gameType/:roomId', wrap(async (req, res) => {
    await requireUser(req);

    const gameType = validateGameType(req.params.gameType);
    const roomId = validateRoomId(req.params.roomId);

    const activeWager = await wager.getRoomWager(gameType, roomId);
    res.status(200).json({ ok: true, wager: activeWager || null });
  }));

  /* ------------------------------------------------------------
     GET /wager/:wager_id
     Fetch a specific wager (for UI polling / reconciliation).
  ------------------------------------------------------------ */
  app.get('/wager/:wager_id', wrap(async (req, res) => {
    await requireUser(req);
    const wagerId = validateWagerId(req.params.wager_id);

    const wagerRow = await wager.getWager(wagerId);
    if (!wagerRow) throw err('wager_not_found', 404);
    res.status(200).json({ ok: true, wager: wagerRow });
  }));
};

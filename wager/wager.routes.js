'use strict';

// wager/wager.routes.js — HTTP surface for wagers. HARDENED.
// ============================================================================

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

// 🛡️ صرّح بالألعاب المسموحة — لا تعتمد على regex عام.
const ALLOWED_GAME_TYPES = new Set(['chess', 'backgammon', 'domino', 'cards']);

module.exports = function registerWagerRoutes(app, options = {}) {
  const { wager, identify, roomMembership = null, log = console } = options;

  if (!wager) throw new Error('registerWagerRoutes requires a wager instance');
  if (typeof identify !== 'function') {
    throw new Error('registerWagerRoutes requires identify()');
  }

  // ------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------
  function bearer(req) {
    const header = String(req.headers?.authorization || '');
    const match = header.match(/^Bearer\s+([A-Za-z0-9._\-]{8,512})$/i);
    return match ? match[1] : '';
  }

  async function requireUser(req) {
    const token = bearer(req);
    if (!token) throw err('unauthorized', 401);

    let user;
    try {
      user = await identify(token);
    } catch (e) {
      log.error('[WAGER ROUTE] identify error:', e?.message);
      throw err('unauthorized', 401);
    }
    if (!user || user.id == null) throw err('unauthorized', 401);
    return user;
  }

  function isAdmin(user) {
    return user && (user.role === 'admin' || user.is_admin === true);
  }

  // ------------------------------------------------------------
  // Validators
  // ------------------------------------------------------------
  function validateGameType(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!ALLOWED_GAME_TYPES.has(s)) throw err('invalid_game_type', 400);
    return s;
  }

  function validateRoomId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > 40 || !/^[A-Za-z0-9_\-]+$/.test(s)) {
      throw err('invalid_room_id', 400);
    }
    return s;
  }

  function validateAmount(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw err('invalid_amount', 400);

    const min = Number(wager.MIN_WAGER);
    const max = Number(wager.MAX_WAGER);
    if (Number.isFinite(min) && n < min) {
      throw err('invalid_amount', 400, { min, max, got: n });
    }
    if (Number.isFinite(max) && n > max) {
      throw err('invalid_amount', 400, { min, max, got: n });
    }
    return n;
  }

  function validateWagerId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!/^wg_[A-Za-z0-9]{4,32}$/.test(s)) throw err('invalid_wager_id', 400);
    return s;
  }

  // ------------------------------------------------------------
  // Response wrapper (safe: no double-send)
  // ------------------------------------------------------------
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        log.error('[WAGER ROUTE] headersSent, cannot respond:', error?.message);
        return;
      }
      const status = error?.status || 500;
      const code = error?.code || 'server_error';

      if (status >= 500) {
        log.error('[WAGER ROUTE]', code, '-', error?.message);
      }

      const body = { ok: false, error: code };
      if (error?.required != null) body.required = error.required;
      if (error?.available != null) body.available = error.available;
      if (error?.min != null) body.min = error.min;
      if (error?.max != null) body.max = error.max;
      if (error?.got != null) body.got = error.got;

      res.status(status).json(body);
    }
  };

  // ------------------------------------------------------------
  // POST /wager/create
  // ------------------------------------------------------------
  app.post('/wager/create', wrap(async (req, res) => {
    const user = await requireUser(req);
    const body = req.body || {};

    const gameType = validateGameType(body.game_type);
    const roomId = validateRoomId(body.room_id);
    const amount = validateAmount(body.amount);

    const row = await wager.createWager(user.id, gameType, roomId, amount);
    res.status(201).json({ ok: true, wager: row });
  }));

  // ------------------------------------------------------------
  // POST /wager/accept
  // ------------------------------------------------------------
  app.post('/wager/accept', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId((req.body || {}).wager_id);

    const row = await wager.acceptWager(user.id, wagerId);
    res.status(200).json({ ok: true, wager: row });
  }));

  // ------------------------------------------------------------
  // POST /wager/cancel
  // ------------------------------------------------------------
  app.post('/wager/cancel', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId((req.body || {}).wager_id);

    const row = await wager.cancelWager(user.id, wagerId);
    res.status(200).json({ ok: true, wager: row });
  }));

  // ------------------------------------------------------------
  // GET /wager/room/:gameType/:roomId
  // ------------------------------------------------------------
  app.get('/wager/room/:gameType/:roomId', wrap(async (req, res) => {
    const user = await requireUser(req);
    const gameType = validateGameType(req.params.gameType);
    const roomId = validateRoomId(req.params.roomId);

    // 🔒 العضوية (إن مُرِّرت)
    if (typeof roomMembership === 'function' && !isAdmin(user)) {
      const ok = await roomMembership(user.id, gameType, roomId);
      if (!ok) throw err('forbidden', 403);
    }

    const active = await wager.getRoomWager(gameType, roomId);

    // 🛡️ قلّم البيانات للغير مشاركين
    let payload = active;
    if (active && !isAdmin(user)) {
      const isParticipant =
        String(active.player_a_id) === String(user.id) ||
        String(active.player_b_id) === String(user.id);
      if (!isParticipant) {
        payload = {
          id: active.id,
          game_type: active.game_type,
          room_id: active.room_id,
          amount: active.amount,
          status: active.status,
          created_at: active.created_at,
          started_at: active.started_at,
          // لا نكشف player_a_id/player_b_id
        };
      }
    }

    res.status(200).json({ ok: true, wager: payload || null });
  }));

  // ------------------------------------------------------------
  // GET /wager/:wager_id — participant/admin only
  // ------------------------------------------------------------
  app.get('/wager/:wager_id', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId(req.params.wager_id);

    const row = await wager.getWager(wagerId);
    if (!row) throw err('wager_not_found', 404);

    const isParticipant =
      String(row.player_a_id) === String(user.id) ||
      String(row.player_b_id) === String(user.id);

    if (!isParticipant && !isAdmin(user)) {
      // 404 لا 403 — لا نكشف وجود الرهان
      throw err('wager_not_found', 404);
    }

    res.status(200).json({ ok: true, wager: row });
  }));
};

'use strict';

// ============================================================================
// wager/wager.routes.js — HTTP surface for wagers (clean rewrite).
// ============================================================================
// المسؤوليات:
//   1. عرض رهان الغرفة (participant-aware).
//   2. إنشاء/قبول/إلغاء رهان.
//   3. سجل اللاعب.
//   4. إحصاءات (admin/debug).
//
// المصادقة:
//   - يقبل cookie (cafe_session) أو Bearer.
//   - يستخدم identifyRequest أولاً، ثم identify كـ fallback.
// ============================================================================

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

// الألعاب المسموحة — يجب أن تطابق الألعاب المحمّلة في server.js.
const ALLOWED_GAME_TYPES = new Set(['chess', 'shkobba', 'rummy']);

module.exports = function registerWagerRoutes(app, options = {}) {
  const {
    wager,
    identify,
    identifyRequest,
    roomMembership = null,
    log = console,
  } = options;

  if (!wager) throw new Error('registerWagerRoutes requires a wager instance');
  if (typeof identify !== 'function' && typeof identifyRequest !== 'function') {
    throw new Error('registerWagerRoutes requires identify() or identifyRequest()');
  }

  // ==========================================================================
  // AUTH
  // ==========================================================================
  async function requireUser(req) {
    // Prefer identifyRequest (cookie + bearer).
    if (typeof identifyRequest === 'function') {
      try {
        const user = await identifyRequest(req);
        if (user && user.id != null) return user;
        throw err('unauthorized', 401);
      } catch (e) {
        if (e && e.status && e.status >= 500) throw e;
        if (e && e.code !== 'unauthorized') {
          log.error('[WAGER ROUTE] identifyRequest error:', e?.message);
        }
        throw err('unauthorized', 401);
      }
    }

    // Fallback: bearer-only identify.
    const header = String(req.headers?.authorization || '');
    const match = header.match(/^Bearer\s+([A-Za-z0-9._\-]{8,2000})$/i);
    const token = match ? match[1] : '';
    if (!token) throw err('unauthorized', 401);

    try {
      const user = await identify(token);
      if (!user || user.id == null) throw err('unauthorized', 401);
      return user;
    } catch (e) {
      if (e && e.status && e.status >= 500) throw e;
      log.error('[WAGER ROUTE] identify error:', e?.message);
      throw err('unauthorized', 401);
    }
  }

  function isAdmin(user) {
    return Boolean(user && (user.role === 'admin' || user.is_admin === true));
  }

  // ==========================================================================
  // VALIDATORS
  // ==========================================================================
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
    // makeWagerId yields wg_ + 16 hex chars → "wg_" + 16-32 alnum.
    if (!/^wg_[A-Za-z0-9]{4,32}$/.test(s)) throw err('invalid_wager_id', 400);
    return s;
  }

  function validateLimit(v) {
    if (v === undefined) return 20;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw err('bad_limit', 400);
    return n;
  }

  function validateOffset(v) {
    if (v === undefined) return 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) throw err('bad_offset', 400);
    return n;
  }

  // ==========================================================================
  // RESPONSE HELPERS
  // ==========================================================================
  function noStore(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }

  function publicWager(row, viewerId) {
    if (!row) return null;
    const isParticipant =
      String(row.player_a_id) === String(viewerId) ||
      String(row.player_b_id) === String(viewerId);

    if (isParticipant) return row;

    // Public view: no player IDs, no winner ID.
    return {
      id: row.id,
      game_type: row.game_type,
      room_id: row.room_id,
      amount: row.amount,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
    };
  }

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

  // ==========================================================================
  // POST /wager/create
  // ==========================================================================
  app.post('/wager/create', wrap(async (req, res) => {
    const user = await requireUser(req);
    const body = req.body || {};

    const gameType = validateGameType(body.game_type);
    const roomId = validateRoomId(body.room_id);
    const amount = validateAmount(body.amount);

    const row = await wager.createWager(user.id, gameType, roomId, amount);
    noStore(res);
    res.status(201).json({ ok: true, wager: row });
  }));

  // ==========================================================================
  // POST /wager/accept
  // ==========================================================================
  app.post('/wager/accept', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId((req.body || {}).wager_id);

    const row = await wager.acceptWager(user.id, wagerId);
    noStore(res);
    res.status(200).json({ ok: true, wager: row });
  }));

  // ==========================================================================
  // POST /wager/cancel
  // ==========================================================================
  app.post('/wager/cancel', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId((req.body || {}).wager_id);

    const row = await wager.cancelWager(user.id, wagerId);
    noStore(res);
    res.status(200).json({ ok: true, wager: row });
  }));

  // ==========================================================================
  // GET /wager/room/:gameType/:roomId
  // ==========================================================================
  app.get('/wager/room/:gameType/:roomId', wrap(async (req, res) => {
    const user = await requireUser(req);
    const gameType = validateGameType(req.params.gameType);
    const roomId = validateRoomId(req.params.roomId);

    // Optional membership check (if provided by caller).
    if (typeof roomMembership === 'function' && !isAdmin(user)) {
      const ok = await roomMembership(user.id, gameType, roomId);
      if (!ok) throw err('forbidden', 403);
    }

    const active = await wager.getRoomWager(gameType, roomId);
    noStore(res);
    res.status(200).json({
      ok: true,
      wager: active ? publicWager(active, user.id) : null,
    });
  }));

  // ==========================================================================
  // GET /wager/list
  // ==========================================================================
  app.get('/wager/list', wrap(async (req, res) => {
    const user = await requireUser(req);

    const limit = validateLimit(req.query.limit);
    const offset = validateOffset(req.query.offset);

    if (typeof wager.listWagersByPlayer !== 'function') {
      throw err('not_supported', 501);
    }

    const result = await wager.listWagersByPlayer(user.id, { limit, offset });

    noStore(res);
    res.status(200).json({
      ok: true,
      items: result.items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  }));

  // ==========================================================================
  // GET /wager/stats
  // ==========================================================================
  app.get('/wager/stats', wrap(async (req, res) => {
    const user = await requireUser(req);
    if (!isAdmin(user)) throw err('forbidden', 403);

    if (typeof wager.getStats !== 'function') {
      throw err('not_supported', 501);
    }

    const stats = await wager.getStats();
    noStore(res);
    res.status(200).json({ ok: true, stats });
  }));

  // ==========================================================================
  // GET /wager/:wager_id — participant/admin only
  // ==========================================================================
  app.get('/wager/:wager_id', wrap(async (req, res) => {
    const user = await requireUser(req);
    const wagerId = validateWagerId(req.params.wager_id);

    const row = await wager.getWager(wagerId);
    if (!row) throw err('wager_not_found', 404);

    const isParticipant =
      String(row.player_a_id) === String(user.id) ||
      String(row.player_b_id) === String(user.id);

    if (!isParticipant && !isAdmin(user)) {
      // 404 — don't leak existence.
      throw err('wager_not_found', 404);
    }

    noStore(res);
    res.status(200).json({ ok: true, wager: row });
  }));

  log.log('[WAGER ROUTES] Registered (identifyRequest aware, cookie+Bearer).');
};

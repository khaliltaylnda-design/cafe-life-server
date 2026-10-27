'use strict';

// ============================================================================
// wallet/wallet.routes.js — HTTP surface of the wallet. FORTRESS EDITION.
// ============================================================================
// Read-only by design: NO route here can modify users.coins.
//
// Defense layers:
//   L1. Auth           — every route requires a valid bearer token.
//   L2. Rate limit     — per-IP sliding bucket, memory-capped.
//   L3. Input strict   — integers only, BIGINT bounds, no coercion leaks.
//   L4. Consistency    — single DB read for balance + balanceRaw.
//   L5. Meta whitelist — no internal IDs leak to the client.
//   L6. Safe wrap      — no double-send, no leak of stack traces.
//   L7. Pagination     — cursor validated against BIGINT max.
// ============================================================================

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

const MAX_BIGINT = 9223372036854775807n;
const MAX_RATE_BUCKETS = 50_000;

// Whitelist of safe meta fields to expose to the client.
// Anything not listed here is stripped before the response is sent.
const SAFE_META_KEYS = new Set([
  'role',
  'gameType',
  'game_type',
  'roomId',
  'room_id',
  'packageId',
  'package_id',
  'reason',
]);

module.exports = function registerWalletRoutes(app, options = {}) {
  const { wallet, identify, log = console } = options;

  if (!wallet) {
    throw new Error('registerWalletRoutes requires a wallet instance');
  }
  if (typeof identify !== 'function') {
    throw new Error('registerWalletRoutes requires identify()');
  }

  // ========================================================================
  // L1 — AUTH HELPERS
  // ========================================================================

  function bearer(req) {
    const header = String(req.headers?.authorization || '');
    const match = header.match(/^Bearer\s+([A-Za-z0-9._\-]{8,2000})$/i);
    return match ? match[1] : '';
  }

  async function requireUser(req) {
    const token = bearer(req);
    if (!token) throw err('unauthorized', 401);

    let user;
    try {
      user = await identify(token);
    } catch (e) {
      // identify() may throw auth_backend_unavailable (503).
      // Preserve it — a DB outage is not an invalid token.
      if (e && e.status) throw e;
      log.error('[WALLET ROUTE] identify error:', e?.message);
      throw err('unauthorized', 401);
    }
    if (!user || user.id == null) throw err('unauthorized', 401);
    return user;
  }

  // ========================================================================
  // L2 — RATE LIMITING (memory-capped, sliding bucket per IP)
  // ========================================================================

  const buckets = new Map();

  function rateLimit(name, req, max, windowMs) {
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const key = name + ':' + ip;
    const now = Date.now();

    let b = buckets.get(key);
    if (!b || now >= b.reset) {
      // Memory guard: prevent unbounded growth under IP flood.
      if (buckets.size >= MAX_RATE_BUCKETS) {
        const drop = Math.floor(MAX_RATE_BUCKETS * 0.1);
        let i = 0;
        for (const k of buckets.keys()) {
          buckets.delete(k);
          if (++i >= drop) break;
        }
      }
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    if (++b.count > max) throw err('rate_limited', 429);
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (now >= v.reset) buckets.delete(k);
    }
  }, 60_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  // ========================================================================
  // L3 — STRICT INPUT VALIDATION
  // ========================================================================

  function validateLimit(v) {
    if (v === undefined) return 20;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw err('bad_limit', 400);
    return n;
  }

  function validateCursor(v) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v);
    if (!/^\d{1,19}$/.test(s)) throw err('bad_cursor', 400);
    if (BigInt(s) > MAX_BIGINT) throw err('bad_cursor', 400);
    return s;
  }

  // ========================================================================
  // L5 — META FILTER (whitelist only)
  // ========================================================================

  function sanitizeMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const out = {};
    let found = false;
    for (const k of SAFE_META_KEYS) {
      const v = meta[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
        found = true;
      }
    }
    return found ? out : null;
  }

  function sanitizeTransaction(item) {
    return {
      id: item.id,
      delta: item.delta,
      balanceAfter: item.balanceAfter,
      kind: item.kind,
      // refType is safe; refId is not (may contain internal session ids).
      refType: item.refType || null,
      meta: sanitizeMeta(item.meta),
      createdAt: item.createdAt,
    };
  }

  // ========================================================================
  // L6 — ERROR WRAPPER (no double-send, no stack traces)
  // ========================================================================

  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        log.error('[WALLET] headersSent, cannot respond:', error?.message);
        return;
      }

      const status = error && error.status ? error.status : 500;
      const code = error && error.code ? error.code : 'server_error';

      if (status >= 500) {
        log.error('[WALLET]', code, '-', error && error.message);
      }

      const body = { ok: false, error: code };
      if (error && error.required != null) body.required = error.required;
      if (error && error.available != null) body.available = error.available;
      if (error && Array.isArray(error.allowed)) body.allowed = error.allowed;
      if (error && error.max != null) body.max = error.max;
      if (error && error.got != null) body.got = error.got;

      res.status(status).json(body);
    }
  };

  // ========================================================================
  // GET /wallet/packages
  // ========================================================================
  // Auth required — prevents competitor enumeration and scraper abuse.
  app.get('/wallet/packages', wrap(async (req, res) => {
    rateLimit('packages', req, 30, 60_000);
    await requireUser(req);

    const packages = await wallet.listPackages();
    res.status(200).json({ ok: true, packages });
  }));

  // ========================================================================
  // GET /wallet/balance
  // ========================================================================
  // Single read for balance + balanceRaw — no drift between the two.
  app.get('/wallet/balance', wrap(async (req, res) => {
    rateLimit('balance', req, 120, 60_000);
    const user = await requireUser(req);

    // Prefer getBalanceRaw (single query). Fallback for older wallet versions.
    let raw;
    if (typeof wallet.getBalanceRaw === 'function') {
      raw = await wallet.getBalanceRaw(user.id);
    } else {
      const b = await wallet.getBalance(user.id);
      raw = b == null ? null : String(b);
    }

    if (raw === null) throw err('user_not_found', 404);

    const n = Number(raw);
    const balance = Number.isSafeInteger(n) ? n : raw;

    res.status(200).json({
      ok: true,
      balance,
      balanceRaw: String(raw),
      currency: 'USD',
    });
  }));

  // ========================================================================
  // GET /wallet/transactions
  // ========================================================================
  app.get('/wallet/transactions', wrap(async (req, res) => {
    rateLimit('transactions', req, 60, 60_000);
    const user = await requireUser(req);

    const limit = validateLimit(req.query.limit);
    const cursor = validateCursor(req.query.cursor);

    const result = await wallet.listTransactions(user.id, { limit, cursor });

    res.status(200).json({
      ok: true,
      items: result.items.map(sanitizeTransaction),
      next: result.next || null,
    });
  }));
};

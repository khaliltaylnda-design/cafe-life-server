'use strict';

// ============================================================================
// wallet/wallet.routes.js — HTTP surface of the wallet (clean rewrite).
// ============================================================================
// المسؤوليات:
//   1. عرض packages.
//   2. عرض رصيد المستخدم (balance + balanceRaw).
//   3. عرض سجل المعاملات (مع pagination cursor).
//   4. عرض تفاصيل معاملة واحدة.
//
// ما لا يفعله:
//   - تعديل الأرصدة (credit/debit حصراً عبر wallet.js).
//   - عرض ref_id (قد يحتوي session ids).
//   - إرجاع meta كاملة (whitelist فقط).
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

const MAX_BIGINT = 9223372036854775807n;
const MAX_RATE_BUCKETS = 10_000;

// Whitelist of meta keys safe to expose to the client.
const SAFE_META_KEYS = new Set([
  'role',
  'gameType',
  'game_type',
  'roomId',
  'room_id',
  'reason',
  'source',
]);

module.exports = function registerWalletRoutes(app, options = {}) {
  const {
    wallet,
    identify,
    identifyRequest,
    log = console,
  } = options;

  if (!wallet) throw new Error('registerWalletRoutes requires a wallet instance');
  if (typeof identify !== 'function' && typeof identifyRequest !== 'function') {
    throw new Error('registerWalletRoutes requires identify() or identifyRequest()');
  }

  // ========================================================================
  // L1 — AUTH
  // ========================================================================
  async function requireUser(req) {
    // 1) Prefer identifyRequest (handles cookie + bearer).
    if (typeof identifyRequest === 'function') {
      try {
        const user = await identifyRequest(req);
        if (user && user.id != null) return user;
        throw err('unauthorized', 401);
      } catch (e) {
        // Preserve backend errors (503) — don't mask DB outages as 401.
        if (e && e.status && e.status >= 500) throw e;
        if (e && e.code !== 'unauthorized') {
          log.error('[WALLET ROUTE] identifyRequest error:', e?.message);
        }
        throw err('unauthorized', 401);
      }
    }

    // 2) Fallback: bearer-only identify (legacy).
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
      log.error('[WALLET ROUTE] identify error:', e?.message);
      throw err('unauthorized', 401);
    }
  }

  // ========================================================================
  // L2 — RATE LIMITING
  // ========================================================================
  const buckets = new Map();

  function rateLimit(name, req, max, windowMs) {
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const key = name + ':' + ip;
    const now = Date.now();

    let b = buckets.get(key);
    if (!b || now >= b.reset) {
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
  // L3 — INPUT VALIDATION
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

  function validatePackageId(v) {
    if (typeof v !== 'string') throw err('bad_package_id', 400);
    const s = v.trim();
    if (!s || s.length > 64) throw err('bad_package_id', 400);
    if (!/^[A-Za-z0-9_\-]+$/.test(s)) throw err('bad_package_id', 400);
    return s;
  }

  function validateTxId(v) {
    if (typeof v !== 'string') throw err('bad_tx_id', 400);
    const s = v.trim();
    if (!/^\d{1,19}$/.test(s)) throw err('bad_tx_id', 400);
    if (BigInt(s) > MAX_BIGINT) throw err('bad_tx_id', 400);
    return s;
  }

  // ========================================================================
  // L4 — META SANITIZATION
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
      refType: item.refType || null,
      // refId NOT exposed — may contain session ids or internal identifiers.
      meta: sanitizeMeta(item.meta),
      createdAt: item.createdAt,
    };
  }

  // ========================================================================
  // L5 — RESPONSE HEADERS
  // ========================================================================
  function noStore(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }

  // ========================================================================
  // L6 — ERROR WRAPPER
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
  app.get('/wallet/packages', wrap(async (req, res) => {
    rateLimit('packages', req, 30, 60_000);
    await requireUser(req);

    const packages = await wallet.listPackages();
    noStore(res);
    res.status(200).json({ ok: true, packages });
  }));

  // ========================================================================
  // GET /wallet/packages/:id
  // ========================================================================
  app.get('/wallet/packages/:id', wrap(async (req, res) => {
    rateLimit('package-one', req, 60, 60_000);
    await requireUser(req);

    const id = validatePackageId(req.params.id);
    const pkg = await wallet.getPackage(id);
    if (!pkg) throw err('package_not_found', 404);

    noStore(res);
    res.status(200).json({
      ok: true,
      package: {
        id: pkg.id,
        tokens: Number(pkg.tokens),
        bonusTokens: Number(pkg.bonus_tokens || 0),
        priceCents: Number(pkg.price_cents),
        price: (Number(pkg.price_cents) / 100).toFixed(2),
        currency: pkg.currency,
        label: pkg.label,
      },
    });
  }));

  // ========================================================================
  // GET /wallet/balance
  // ========================================================================
  app.get('/wallet/balance', wrap(async (req, res) => {
    rateLimit('balance', req, 120, 60_000);
    const user = await requireUser(req);

    const raw = typeof wallet.getBalanceRaw === 'function'
      ? await wallet.getBalanceRaw(user.id)
      : (async () => {
          const b = await wallet.getBalance(user.id);
          return b == null ? null : String(b);
        })();

    if (raw === null) throw err('user_not_found', 404);

    const n = Number(raw);
    const balance = Number.isSafeInteger(n) ? n : raw;

    noStore(res);
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

    noStore(res);
    res.status(200).json({
      ok: true,
      items: result.items.map(sanitizeTransaction),
      next: result.next || null,
    });
  }));

  // ========================================================================
  // GET /wallet/transactions/:id
  // ========================================================================
  app.get('/wallet/transactions/:id', wrap(async (req, res) => {
    rateLimit('tx-one', req, 60, 60_000);
    const user = await requireUser(req);

    const id = validateTxId(req.params.id);

    // Wallet exposes listTransactions with cursor; fetch by iterating is wrong.
    // Instead, use a direct query if wallet supports it; otherwise, reject.
    if (typeof wallet.getTransaction !== 'function') {
      // Fallback: search first page — cheap but correct for recent txs.
      const result = await wallet.listTransactions(user.id, { limit: 100, cursor: null });
      const item = result.items.find((x) => String(x.id) === id);
      if (!item) throw err('transaction_not_found', 404);
      noStore(res);
      return res.status(200).json({ ok: true, transaction: sanitizeTransaction(item) });
    }

    const tx = await wallet.getTransaction(user.id, id);
    if (!tx) throw err('transaction_not_found', 404);

    noStore(res);
    res.status(200).json({ ok: true, transaction: sanitizeTransaction(tx) });
  }));

  // ========================================================================
  // GET /wallet/health
  // ========================================================================
  app.get('/wallet/health', wrap(async (req, res) => {
    rateLimit('health', req, 10, 60_000);

    let db = false;
    if (typeof wallet.healthCheck === 'function') {
      const h = await wallet.healthCheck();
      db = Boolean(h && h.ok);
    }

    noStore(res);
    res.status(200).json({ ok: true, db, service: 'wallet' });
  }));

  log.log('[WALLET ROUTES] Registered (identifyRequest aware).');
};

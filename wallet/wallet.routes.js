'use strict';

// wallet/wallet.routes.js — HTTP surface of the wallet.
// ============================================================================
// Read-only: no route here can modify users.coins.
//
// Compatible with wallet.js v2 (typed balances, strict kinds, idempotent
// movements). Adds:
//   - structured error responses (required / available on insufficient_balance)
//   - explicit 401 for missing/invalid bearer
//   - stable JSON shape for the client
// ============================================================================

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

module.exports = function registerWalletRoutes(app, options = {}) {
  const { wallet, identify, log = console } = options;

  if (!wallet) {
    throw new Error('registerWalletRoutes requires a wallet instance');
  }
  if (typeof identify !== 'function') {
    throw new Error('registerWalletRoutes requires identify()');
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
     Error wrapper
     ------------------------------------------------------------
     Emits a stable JSON shape:
       { ok: false, error: '<code>', required?, available?, ... }
     Logs only 5xx (4xx are expected client mistakes).
  ------------------------------------------------------------ */
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      const code = error && error.code ? error.code : 'server_error';

      if (status >= 500) {
        log.error('[WALLET]', code, '-', error && error.message);
      }

      const body = { ok: false, error: code };

      // Surface actionable detail for insufficient_balance and similar.
      if (error && error.required != null) body.required = error.required;
      if (error && error.available != null) body.available = error.available;
      if (error && Array.isArray(error.allowed)) body.allowed = error.allowed;

      res.status(status).json(body);
    }
  };

  /* ------------------------------------------------------------
     GET /wallet/packages
  ------------------------------------------------------------ */
  app.get('/wallet/packages', wrap(async (_req, res) => {
    const packages = await wallet.listPackages();
    res.status(200).json({ ok: true, packages });
  }));

  /* ------------------------------------------------------------
     GET /wallet/balance
     ------------------------------------------------------------
     wallet.getBalance() now returns a number (or null).
     getBalanceRaw() returns the exact BIGINT as a string for display.
  ------------------------------------------------------------ */
  app.get('/wallet/balance', wrap(async (req, res) => {
    const user = await requireUser(req);

    const [balance, balanceRaw] = await Promise.all([
      wallet.getBalance(user.id),
      wallet.getBalanceRaw ? wallet.getBalanceRaw(user.id) : Promise.resolve(null),
    ]);

    if (balance === null) throw err('user_not_found', 404);

    res.status(200).json({
      ok: true,
      balance,                            // number, safe for arithmetic
      balanceRaw: balanceRaw,             // string, exact BIGINT (may be null on old wallet)
      currency: 'USD',
    });
  }));

  /* ------------------------------------------------------------
     GET /wallet/transactions
  ------------------------------------------------------------ */
  app.get('/wallet/transactions', wrap(async (req, res) => {
    const user = await requireUser(req);

    const limitRaw = req.query.limit;
    const cursorRaw = req.query.cursor;

    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      throw err('bad_limit', 400);
    }

    const cursor = cursorRaw === undefined ? null : String(cursorRaw);
    if (cursor !== null && !/^\d+$/.test(cursor)) {
      throw err('bad_cursor', 400);
    }

    const result = await wallet.listTransactions(user.id, { limit, cursor });

    res.status(200).json({
      ok: true,
      items: result.items,
      next: result.next,
    });
  }));
};

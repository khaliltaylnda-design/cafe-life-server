'use strict';

// wallet/wallet.routes.js — HTTP surface of the wallet.
// Read-only: no route here can modify users.coins.

const err = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });

module.exports = function registerWalletRoutes(app, options = {}) {
  const { wallet, identify, log = console } = options;

  if (!wallet) {
    throw new Error('registerWalletRoutes requires a wallet instance');
  }

  if (typeof identify !== 'function') {
    throw new Error('registerWalletRoutes requires identify()');
  }

  function bearer(req) {
    const header = String(req.headers?.authorization || '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    return match ? match[1] : '';
  }

  async function requireUser(req) {
    const user = await identify(bearer(req));
    if (!user) throw err('unauthorized', 401);
    return user;
  }

  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error && error.status ? error.status : 500;

      if (status >= 500) {
        log.error('[WALLET]', error && error.message);
      }

      res.status(status).json({
        ok: false,
        error: error && error.code ? error.code : 'server_error'
      });
    }
  };

  app.get('/wallet/packages', wrap(async (_req, res) => {
    const packages = await wallet.listPackages();
    res.status(200).json({ ok: true, packages });
  }));

  app.get('/wallet/balance', wrap(async (req, res) => {
    const user = await requireUser(req);
    const balance = await wallet.getBalance(user.id);

    if (balance === null) throw err('user_not_found', 404);

    res.status(200).json({
      ok: true,
      balance,
      currency: 'USD'
    });
  }));

  app.get('/wallet/transactions', wrap(async (req, res) => {
    const user = await requireUser(req);

    const limitRaw = req.query.limit;
    const cursorRaw = req.query.cursor;

    const limit = limitRaw === undefined
      ? 20
      : Number(limitRaw);

    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      throw err('bad_limit', 400);
    }

    const cursor = cursorRaw === undefined
      ? null
      : String(cursorRaw);

    if (cursor !== null && !/^\d+$/.test(cursor)) {
      throw err('bad_cursor', 400);
    }

    const result = await wallet.listTransactions(user.id, { limit, cursor });

    res.status(200).json({
      ok: true,
      items: result.items,
      next: result.next
    });
  }));
};

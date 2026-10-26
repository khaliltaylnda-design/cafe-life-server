'use strict';

module.exports = function registerWagerRoutes(app, { wager, identify, log }) {
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) log.error('[WAGER]', error.message);
      res.status(status).json({ ok: false, error: error.code || 'server_error' });
    }
  };

  function bearer(req) {
    const header = String(req.headers?.authorization || '');
    const match = header.match(/^Bearer\s+(\S+)$/i);
    return match ? match[1] : '';
  }

  async function requireUser(req) {
    const user = await identify(bearer(req));
    if (!user) throw new Error('unauthorized');
    return user;
  }

  app.post('/wager/create', wrap(async (req, res) => {
    const user = await requireUser(req);
    const { game_type, room_id, amount } = req.body || {};

    const wagerRow = await wager.createWager(
      user.id, 
      String(game_type), 
      String(room_id), 
      Number(amount)
    );
    res.json({ ok: true, wager: wagerRow });
  }));

  app.post('/wager/accept', wrap(async (req, res) => {
    const user = await requireUser(req);
    const { wager_id } = req.body || {};

    const wagerRow = await wager.acceptWager(user.id, String(wager_id));
    res.json({ ok: true, wager: wagerRow });
  }));

  app.post('/wager/cancel', wrap(async (req, res) => {
    const user = await requireUser(req);
    const { wager_id } = req.body || {};

    const wagerRow = await wager.cancelWager(user.id, String(wager_id));
    res.json({ ok: true, wager: wagerRow });
  }));
};

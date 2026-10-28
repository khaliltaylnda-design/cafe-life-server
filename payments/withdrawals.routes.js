'use strict';

// ============================================================================
// payments/withdrawals.routes.js — HTTP endpoints for withdrawals.
// ============================================================================

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

module.exports = function registerWithdrawalRoutes(app, options = {}) {
  const { withdrawals, identifyRequest, log = console } = options;
  if (!withdrawals) throw new Error('registerWithdrawalRoutes requires withdrawals');
  if (typeof identifyRequest !== 'function') throw new Error('requires identifyRequest');

  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) { log.error('[WITHDRAWALS] headersSent'); return; }
      const status = error?.status || 500;
      const code = error?.code || 'server_error';
      if (status >= 500) log.error('[WITHDRAWALS]', code, '-', error?.message);
      const body = { ok: false, error: code };
      if (error?.min != null) body.min = error.min;
      if (error?.max != null) body.max = error.max;
      if (error?.allowed) body.allowed = error.allowed;
      res.status(status).json(body);
    }
  };

  async function requireUser(req) {
    const user = await identifyRequest(req);
    if (!user) throw err('unauthorized', 401);
    return user;
  }

  async function requireAdmin(req) {
    const user = await requireUser(req);
    if (user.role !== 'admin') throw err('forbidden', 403);
    return user;
  }

  // ---------------- Player endpoints ----------------

  app.post('/withdrawals/request', wrap(async (req, res) => {
    const user = await requireUser(req);
    const body = req.body || {};
    const row = await withdrawals.requestWithdrawal(user.id, body.amount, body.method, body.destination);
    res.status(201).json({ ok: true, withdrawal: row });
  }));

  app.get('/withdrawals/my', wrap(async (req, res) => {
    const user = await requireUser(req);
    const rows = await withdrawals.listMyWithdrawals(user.id, Number(req.query.limit) || 20);
    res.status(200).json({ ok: true, withdrawals: rows });
  }));

  // ---------------- Admin endpoints ----------------

  app.get('/withdrawals/admin/pending', wrap(async (req, res) => {
    await requireAdmin(req);
    const status = String(req.query.status || 'pending');
    const rows = await withdrawals.listByStatus(status, Number(req.query.limit) || 50);
    res.status(200).json({ ok: true, withdrawals: rows });
  }));

  app.post('/withdrawals/admin/:id/approve', wrap(async (req, res) => {
    const admin = await requireAdmin(req);
    const row = await withdrawals.approveWithdrawal(admin.id, req.params.id);
    res.status(200).json({ ok: true, withdrawal: row });
  }));

  app.post('/withdrawals/admin/:id/reject', wrap(async (req, res) => {
    const admin = await requireAdmin(req);
    const row = await withdrawals.rejectWithdrawal(admin.id, req.params.id, req.body?.note);
    res.status(200).json({ ok: true, withdrawal: row });
  }));

  app.post('/withdrawals/admin/:id/paid', wrap(async (req, res) => {
    const admin = await requireAdmin(req);
    const row = await withdrawals.markPaid(admin.id, req.params.id, req.body?.note);
    res.status(200).json({ ok: true, withdrawal: row });
  }));
};

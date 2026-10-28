'use strict';

// ============================================================================
// payments/withdrawals.routes.js — HTTP endpoints for withdrawals.
// ============================================================================
// Compatible with:
//   - index.html (Withdraw Pro / 18 universal methods)
//   - admin.html (admin dashboard)
// ============================================================================

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

module.exports = function registerWithdrawalRoutes(app, options = {}) {
  const { withdrawals, identifyRequest, log = console } = options;

  if (!withdrawals) throw new Error('registerWithdrawalRoutes requires withdrawals');
  if (typeof identifyRequest !== 'function') {
    throw new Error('registerWithdrawalRoutes requires identifyRequest');
  }

  // ---- Error wrapper ----
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        log.error('[WITHDRAWALS] headers already sent');
        return;
      }
      const status = error?.status || 500;
      const code = error?.code || 'server_error';

      if (status >= 500) {
        log.error('[WITHDRAWALS]', code, '-', error?.message);
      }

      const body = { ok: false, error: code };
      // Expose helpful context for validation errors
      if (error?.min != null) body.min = error.min;
      if (error?.max != null) body.max = error.max;
      if (error?.allowed) body.allowed = error.allowed;
      if (error?.field) body.field = error.field;
      if (error?.reason) body.reason = error.reason;

      res.status(status).json(body);
    }
  };

  // ---- Auth helpers ----
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

  // ============================================================
  // PLAYER ENDPOINTS
  // ============================================================

  // POST /withdrawals/create — used by index.html
  // Body: { method, amount, details: { ...fields }, note? }
  // Legacy: { method, amount, account } still supported via body.account
  app.post('/withdrawals/create', wrap(async (req, res) => {
    const user = await requireUser(req);
    const body = req.body || {};

    // Support new payload (details) and legacy payload (account)
    const payload = {
      method: body.method,
      amount: body.amount,
      details: body.details && typeof body.details === 'object'
        ? { ...body.details, note: body.details.note ?? body.note }
        : (body.account
            ? { note: body.note }   // legacy: pass account separately below
            : { note: body.note }),
    };

    // Legacy fallback: if only `account` is provided (old client), wrap it
    if (!payload.details || Object.keys(payload.details).length === 0 ||
        (payload.details.note == null && body.account)) {
      payload.account = body.account;
    }

    const row = await withdrawals.requestWithdrawal(user.id, payload);

    // Respond with fields the new client expects
    res.status(201).json({
      ok: true,
      withdrawalId: row.id,
      amount: Number(row.amount),
      fee: Number(row.fee_amount || 0),
      netAmount: Number(row.net_amount || row.amount),
      method: row.method,
      status: row.status,
      createdAt: row.created_at,
    });
  }));

  // Legacy alias — keep old clients working
  app.post('/withdrawals/request', wrap(async (req, res) => {
    const user = await requireUser(req);
    const body = req.body || {};

    // Two shapes supported:
    //   A) { method, amount, details }
    //   B) { method, amount, destination }  ← very old
    let payload;
    if (body.details && typeof body.details === 'object') {
      payload = {
        method: body.method,
        amount: body.amount,
        details: { ...body.details, note: body.details.note ?? body.note },
      };
    } else {
      payload = {
        method: body.method,
        amount: body.amount,
        account: body.destination || body.account,
        details: { note: body.note },
      };
    }

    const row = await withdrawals.requestWithdrawal(user.id, payload);

    res.status(201).json({
      ok: true,
      withdrawalId: row.id,
      amount: Number(row.amount),
      fee: Number(row.fee_amount || 0),
      netAmount: Number(row.net_amount || row.amount),
      method: row.method,
      status: row.status,
      createdAt: row.created_at,
    });
  }));

  // GET /withdrawals/list — used by index.html
  app.get('/withdrawals/list', wrap(async (req, res) => {
    const user = await requireUser(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const items = await withdrawals.listMyWithdrawals(user.id, limit);
    res.status(200).json({ ok: true, items });
  }));

  // Legacy alias
  app.get('/withdrawals/my', wrap(async (req, res) => {
    const user = await requireUser(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const items = await withdrawals.listMyWithdrawals(user.id, limit);
    res.status(200).json({ ok: true, items });
  }));

  // ============================================================
  // ADMIN ENDPOINTS
  // ============================================================

  // GET /withdrawals/admin/pending — list by status
  app.get('/withdrawals/admin/pending', wrap(async (req, res) => {
    await requireAdmin(req);
    const status = String(req.query.status || 'pending').toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await withdrawals.listByStatus(status, limit);
    res.status(200).json({ ok: true, withdrawals: rows });
  }));

  // GET /withdrawals/admin/stats — used by admin.html badge + stats tab
  app.get('/withdrawals/admin/stats', wrap(async (req, res) => {
    await requireAdmin(req);
    const stats = await withdrawals.getStats();
    res.status(200).json({ ok: true, ...stats });
  }));

  // GET /withdrawals/admin/count — lightweight badge endpoint
  app.get('/withdrawals/admin/count', wrap(async (req, res) => {
    await requireAdmin(req);
    const n = await withdrawals.countPending();
    res.status(200).json({ ok: true, pending: n });
  }));

  // POST /withdrawals/admin/:id/approve
  app.post('/withdrawals/admin/:id/approve', wrap(async (req, res) => {
    const admin = await requireAdmin(req);
    const row = await withdrawals.approveWithdrawal(admin.id, req.params.id);
    res.status(200).json({ ok: true, withdrawal: row });
  }));

  // POST /withdrawals/admin/:id/reject  — body: { note? }
  app.post('/withdrawals/admin/:id/reject', wrap(async (req, res) => {
    const admin = await requireAdmin(req);
    const note = String(req.body?.note || '').slice(0, 500);
    const row = await withdrawals.rejectWithdrawal(admin.id, req.params.id, note);
    res.status(200).json({ ok: true, withdrawal: row });
  }));

  // POST /withdrawals/admin/:id/paid  — body: { note? }
  app.post('/withdrawals/admin/:id/paid', wrap(async (req, res) => {
    const admin = await requireAdmin(req);
    const note = String(req.body?.note || '').slice(0, 500);
    const row = await withdrawals.markPaid(admin.id, req.params.id, note);
    res.status(200).json({ ok: true, withdrawal: row });
  }));

  // ============================================================
  // PUBLIC (for client) — read-only method registry
  // ============================================================
  // The client keeps its own copy, but exposing this endpoint lets us
  // auto-sync min/fee changes without redeploying index.html.
  app.get('/withdrawals/methods', wrap(async (_req, res) => {
    const methods = {};
    for (const [key, def] of Object.entries(withdrawals.METHODS)) {
      methods[key] = {
        name: def.name,
        cat: def.cat,
        fee: def.fee,
        min: def.min,
        max: def.max,
        fields: def.fields,
      };
    }
    res.status(200).json({
      ok: true,
      methods,
      globalMin: withdrawals.MIN_WITHDRAWAL,
      globalMax: withdrawals.MAX_WITHDRAWAL,
    });
  }));
};

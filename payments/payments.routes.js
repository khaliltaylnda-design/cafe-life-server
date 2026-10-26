'use strict';

// payments/payments.routes.js — Stripe Checkout HTTP surface.
// Read + create. Never modifies users.coins directly.

const crypto = require('crypto');

const err = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });

module.exports = function registerPaymentsRoutes(app, options = {}) {
  const { stripe, wallet, identify, pool, log = console } = options;

  if (!stripe) {
    log.warn('[PAYMENTS] Stripe not configured; payment routes disabled.');
    return { enabled: false };
  }

  if (!wallet) {
    throw new Error('registerPaymentsRoutes requires wallet');
  }

  if (typeof identify !== 'function') {
    throw new Error('registerPaymentsRoutes requires identify()');
  }

  if (!pool) {
    throw new Error('registerPaymentsRoutes requires pool');
  }

  const FRONTEND_URL = (
    process.env.FRONTEND_URL ||
    'https://cafe-life.onrender.com'
  ).replace(/\/+$/, '');

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
        log.error('[PAYMENTS]', error && error.message);
      }

      res.status(status).json({
        ok: false,
        error: error && error.code ? error.code : 'server_error'
      });
    }
  };

  // --------------------------------------------------
  // POST /payments/checkout
  // --------------------------------------------------

  app.post('/payments/checkout', wrap(async (req, res) => {
    const user = await requireUser(req);

    const packageId = req.body && req.body.package_id;

    if (typeof packageId !== 'string' || !packageId) {
      throw err('bad_package_id', 400);
    }

    const packageRow = await wallet.getPackage(packageId);

    if (!packageRow) throw err('package_not_found', 404);

    const tokens = Number(packageRow.tokens);
    const bonus = Number(packageRow.bonus_tokens || 0);
    const amountCents = Number(packageRow.price_cents);
    const currency = String(packageRow.currency || 'USD');

    const paymentId = 'pay_' + crypto.randomBytes(16).toString('hex');

    await pool.query(
      `INSERT INTO payments
         (id, user_id, package_id, amount_cents, currency, tokens,
          bonus_tokens, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [paymentId, user.id, packageRow.id, amountCents, currency, tokens, bonus]
    );

    let session;

    try {
      session = await stripe.createCheckoutSession({
        user,
        packageRow,
        paymentId,
        successUrl: FRONTEND_URL + '/?payment=success&session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: FRONTEND_URL + '/?payment=cancel'
      });
    } catch (error) {
      await pool.query(
        `UPDATE payments
         SET status = 'failed', failed_at = NOW()
         WHERE id = $1`,
        [paymentId]
      ).catch(() => {});
      throw error;
    }

    await pool.query(
      `UPDATE payments
       SET stripe_session_id = $1
       WHERE id = $2`,
      [session.id, paymentId]
    );

    res.status(200).json({
      ok: true,
      paymentId,
      sessionId: session.id,
      url: session.url,
      expiresAt: session.expiresAt
    });
  }));

  // --------------------------------------------------
  // GET /payments/verify?session_id=...
  // --------------------------------------------------

  app.get('/payments/verify', wrap(async (req, res) => {
    const user = await requireUser(req);

    const sessionId = req.query.session_id;

    if (typeof sessionId !== 'string' || !sessionId) {
      throw err('bad_session_id', 400);
    }

    const paymentResult = await pool.query(
      `SELECT id, status, tokens, bonus_tokens
       FROM payments
       WHERE stripe_session_id = $1 AND user_id = $2`,
      [sessionId, user.id]
    );

    if (!paymentResult.rows.length) {
      throw err('payment_not_found', 404);
    }

    const payment = paymentResult.rows[0];

    if (payment.status === 'paid') {
      return res.status(200).json({
        ok: true,
        status: 'paid',
        tokens: Number(payment.tokens) + Number(payment.bonus_tokens || 0)
      });
    }

    const session = await stripe.retrieveSession(sessionId);

    if (session.payment_status === 'paid') {
      const tokens = Number(payment.tokens) + Number(payment.bonus_tokens || 0);
      const refId = 'stripe:' + sessionId;

      const credit = await wallet.credit(user.id, tokens, {
        kind: 'purchase',
        refType: 'payment',
        refId,
        meta: {
          source: 'verify',
          payment_id: payment.id,
          session_id: sessionId,
          amount_cents: session.amount_total,
          currency: session.currency
        }
      });

      await pool.query(
        `UPDATE payments
         SET status = 'paid',
             paid_at = NOW(),
             stripe_payment_intent = $1
         WHERE id = $2 AND status = 'pending'`,
        [session.payment_intent || null, payment.id]
      ).catch(() => {});

      return res.status(200).json({
        ok: true,
        status: 'paid',
        tokens,
        applied: credit.applied,
        balance: credit.balance
      });
    }

    if (session.status === 'expired') {
      await pool.query(
        `UPDATE payments
         SET status = 'failed', failed_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [payment.id]
      ).catch(() => {});

      return res.status(200).json({
        ok: true,
        status: 'failed',
        reason: 'expired'
      });
    }

    return res.status(200).json({
      ok: true,
      status: 'pending'
    });
  }));

  // --------------------------------------------------
  // GET /payments/history
  // --------------------------------------------------

  app.get('/payments/history', wrap(async (req, res) => {
    const user = await requireUser(req);

    const limitRaw = req.query.limit;
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);

    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      throw err('bad_limit', 400);
    }

    const result = await pool.query(
      `SELECT id, package_id, amount_cents, currency, tokens, bonus_tokens,
              status, created_at, paid_at
       FROM payments
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [user.id, limit]
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      packageId: row.package_id,
      amountCents: Number(row.amount_cents),
      price: (Number(row.amount_cents) / 100).toFixed(2),
      currency: row.currency,
      tokens: Number(row.tokens),
      bonusTokens: Number(row.bonus_tokens || 0),
      status: row.status,
      createdAt: row.created_at,
      paidAt: row.paid_at
    }));

    res.status(200).json({ ok: true, items });
  }));

  log.log('[PAYMENTS] Checkout routes registered.');

  return { enabled: true };
};

'use strict';

// payments/payments.webhook.js — Stripe webhook handler.
// This is the ONLY place where a successful payment credits tokens.
// Every event is claimed once via stripe_events (idempotency).

const err = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });

module.exports = function createPaymentsWebhook({
  pool,
  wallet,
  stripe,
  log = console
} = {}) {
  if (!pool) throw new Error('payments.webhook requires pool');
  if (!wallet) throw new Error('payments.webhook requires wallet');
  if (!stripe) throw new Error('payments.webhook requires stripe');

  async function markPaymentFailed(sessionId) {
    if (!sessionId) return;
    await pool.query(
      `UPDATE payments
       SET status = 'failed', failed_at = NOW()
       WHERE stripe_session_id = $1 AND status = 'pending'`,
      [sessionId]
    ).catch(() => {});
  }

  async function markPaymentRefunded(sessionId) {
    if (!sessionId) return;
    await pool.query(
      `UPDATE payments
       SET status = 'refunded', refunded_at = NOW()
       WHERE stripe_session_id = $1`,
      [sessionId]
    ).catch(() => {});
  }

  async function processCompletedCheckout(event) {
    const session = event.data.object;
    if (!session || !session.id) return { ok: true, skipped: 'no_session' };

    const sessionId = session.id;

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return { ok: true, skipped: 'not_paid' };
    }

    const paymentResult = await pool.query(
      `SELECT id, user_id, tokens, bonus_tokens, status
       FROM payments
       WHERE stripe_session_id = $1`,
      [sessionId]
    );

    if (!paymentResult.rows.length) {
      log.warn('[WEBHOOK] Payment row not found for session ' + sessionId);
      return { ok: true, skipped: 'payment_not_found' };
    }

    const payment = paymentResult.rows[0];

    if (payment.status === 'paid') {
      return { ok: true, skipped: 'already_paid' };
    }

    const tokens = Number(payment.tokens) + Number(payment.bonus_tokens || 0);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      return { ok: true, skipped: 'bad_tokens' };
    }

    const refId = 'stripe:' + sessionId;

    const credit = await wallet.credit(payment.user_id, tokens, {
      kind: 'purchase',
      refType: 'payment',
      refId,
      meta: {
        source: 'webhook',
        event_id: event.id,
        session_id: sessionId,
        payment_intent: session.payment_intent || null,
        amount_total: session.amount_total,
        currency: session.currency
      }
    });

    await pool.query(
      `UPDATE payments
       SET status = 'paid',
           paid_at = NOW(),
           stripe_payment_intent = $1,
           stripe_event_id = $2
       WHERE id = $3 AND status = 'pending'`,
      [session.payment_intent || null, event.id, payment.id]
    ).catch(() => {});

    log.log(
      `[WEBHOOK] Credited ${tokens} tokens to user ${payment.user_id} (session ${sessionId}) ` +
      `applied=${credit.applied}`
    );

    return { ok: true, applied: credit.applied };
  }

  async function processExpiredCheckout(event) {
    const session = event.data.object;
    if (session && session.id) {
      await markPaymentFailed(session.id);
    }
    return { ok: true };
  }

  async function processRefund(event) {
    const charge = event.data.object;
    if (!charge) return { ok: true };

    const paymentIntent = charge.payment_intent;
    if (!paymentIntent) return { ok: true };

    const paymentResult = await pool.query(
      `SELECT stripe_session_id FROM payments
       WHERE stripe_payment_intent = $1`,
      [paymentIntent]
    );

    if (paymentResult.rows.length) {
      await markPaymentRefunded(paymentResult.rows[0].stripe_session_id);
    }

    return { ok: true };
  }

  return async function webhookHandler(req, res) {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({ ok: false, error: 'missing_signature' });
    }

    let event;

    try {
      event = stripe.constructEvent(req.body, signature);
    } catch (error) {
      log.error('[WEBHOOK] Signature verification failed:', error.message);
      return res.status(400).json({ ok: false, error: 'bad_signature' });
    }

    const claimed = await wallet.claimStripeEvent(event.id, event.type);

    if (!claimed) {
      log.log(`[WEBHOOK] Duplicate event ignored: ${event.id}`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    log.log(`[WEBHOOK] Processing ${event.type} (${event.id})`);

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await processCompletedCheckout(event);
          break;
        case 'checkout.session.async_payment_succeeded':
          await processCompletedCheckout(event);
          break;
        case 'checkout.session.expired':
          await processExpiredCheckout(event);
          break;
        case 'charge.refunded':
          await processRefund(event);
          break;
        default:
          log.log(`[WEBHOOK] Unhandled event type: ${event.type}`);
      }
    } catch (error) {
      log.error('[WEBHOOK] Processing failed:', error.message);
      // Stripe will retry.
      return res.status(500).json({ ok: false, error: 'processing_failed' });
    }

    return res.status(200).json({ ok: true });
  };
};

'use strict';

// payments/stripe.js — Stripe integration for Cafe Life.
// Uses test keys in development, live keys in production.
// Never exposes the secret key to the client.

const err = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });

module.exports = function createStripe({
  secretKey,
  publishableKey,
  webhookSecret,
  log = console
} = {}) {
  if (!secretKey) {
    log.warn('[STRIPE] No secret key provided; Stripe is disabled.');
    return null;
  }

  if (!secretKey.startsWith('sk_test_') && !secretKey.startsWith('sk_live_')) {
    throw new Error('STRIPE_SECRET_KEY must start with sk_test_ or sk_live_');
  }

  const isLive = secretKey.startsWith('sk_live_');

  let stripe;

  try {
    stripe = require('stripe')(secretKey);
  } catch (error) {
    throw new Error('Stripe module not installed. Run: npm install stripe');
  }

  log.log(`[STRIPE] Initialized in ${isLive ? 'LIVE' : 'TEST'} mode.`);

  // --------------------------------------------------
  // Create a Checkout Session
  // --------------------------------------------------

  async function createCheckoutSession({
    user,
    packageRow,
    paymentId,
    successUrl,
    cancelUrl
  }) {
    if (!user || !user.id) throw err('bad_user');
    if (!packageRow) throw err('bad_package');
    if (!paymentId) throw err('bad_payment_id');

    const amountCents = Number(packageRow.price_cents);
    const tokens = Number(packageRow.tokens);
    const bonus = Number(packageRow.bonus_tokens || 0);

    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw err('bad_amount');
    }

    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw err('bad_tokens');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: String(packageRow.currency || 'USD').toLowerCase(),
            unit_amount: amountCents,
            product_data: {
              name: String(packageRow.label || `${tokens} Tokens`).slice(0, 250),
              description: bonus > 0
                ? `${tokens} Tokens + ${bonus} bonus`
                : `${tokens} Tokens for Cafe Life`
            }
          },
          quantity: 1
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: user.email || undefined,
      client_reference_id: String(user.id),
      metadata: {
        payment_id: String(paymentId),
        user_id: String(user.id),
        package_id: String(packageRow.id),
        tokens: String(tokens + bonus)
      },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60
    });

    return {
      id: session.id,
      url: session.url,
      expiresAt: session.expires_at
    };
  }

  // --------------------------------------------------
  // Retrieve a Checkout Session
  // --------------------------------------------------

  async function retrieveSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw err('bad_session_id');
    }

    if (!sessionId.startsWith('cs_')) {
      throw err('bad_session_id');
    }

    try {
      return await stripe.checkout.sessions.retrieve(sessionId);
    } catch (error) {
      if (error && error.code === 'resource_missing') {
        throw err('session_not_found', 404);
      }
      throw error;
    }
  }

  // --------------------------------------------------
  // Verify a webhook event
  // --------------------------------------------------

  function constructEvent(rawBody, signature) {
    if (!webhookSecret) {
      throw err('webhook_not_configured', 503);
    }

    if (!rawBody || !signature) {
      throw err('missing_webhook_data', 400);
    }

    try {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (error) {
      throw err('bad_webhook_signature', 400);
    }
  }

  return {
    createCheckoutSession,
    retrieveSession,
    constructEvent,
    isLive,
    publishableKey: publishableKey || null
  };
};

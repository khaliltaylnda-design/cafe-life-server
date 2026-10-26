'use strict';

// wallet/wallet.js — Cafe Life wallet core.
// All balance changes MUST go through credit() or debit().
// No HTTP route is allowed to modify users.coins directly.

const crypto = require('crypto');

/* =========================================================
   PACKAGE DEFINITIONS (seeded once)
========================================================= */

const DEFAULT_PACKAGES = [
  {
    id: 'pkg_500',
    tokens: 500,
    bonus_tokens: 0,
    price_cents: 399,
    currency: 'USD',
    label: '500 Tokens',
    sort_order: 10
  },
  {
    id: 'pkg_1200',
    tokens: 1200,
    bonus_tokens: 0,
    price_cents: 799,
    currency: 'USD',
    label: '1,200 Tokens',
    sort_order: 20
  },
  {
    id: 'pkg_2500',
    tokens: 2500,
    bonus_tokens: 0,
    price_cents: 1499,
    currency: 'USD',
    label: '2,500 Tokens',
    sort_order: 30
  },
  {
    id: 'pkg_6000',
    tokens: 6000,
    bonus_tokens: 0,
    price_cents: 2999,
    currency: 'USD',
    label: '6,000 Tokens',
    sort_order: 40
  }
];

/* =========================================================
   ERRORS
========================================================= */

const err = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });

/* =========================================================
   SQL
========================================================= */

const SQL = {
  schema: [
    `CREATE TABLE IF NOT EXISTS packages (
       id            TEXT PRIMARY KEY,
       tokens        INTEGER NOT NULL CHECK (tokens > 0),
       bonus_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (bonus_tokens >= 0),
       price_cents   INTEGER NOT NULL CHECK (price_cents > 0),
       currency      TEXT NOT NULL DEFAULT 'USD',
       label         TEXT NOT NULL,
       active        BOOLEAN NOT NULL DEFAULT TRUE,
       sort_order    INTEGER NOT NULL DEFAULT 0,
       created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,

    `CREATE INDEX IF NOT EXISTS packages_active_idx
       ON packages (active, sort_order)`,

    `CREATE TABLE IF NOT EXISTS payments (
       id                    TEXT PRIMARY KEY,
       user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       package_id            TEXT NOT NULL REFERENCES packages(id),
       amount_cents          INTEGER NOT NULL,
       currency              TEXT NOT NULL,
       tokens                INTEGER NOT NULL,
       bonus_tokens          INTEGER NOT NULL DEFAULT 0,
       status                TEXT NOT NULL DEFAULT 'pending',
       stripe_session_id     TEXT UNIQUE,
       stripe_payment_intent TEXT,
       stripe_event_id       TEXT UNIQUE,
       created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       paid_at               TIMESTAMPTZ,
       failed_at             TIMESTAMPTZ,
       refunded_at           TIMESTAMPTZ
     )`,

    `CREATE INDEX IF NOT EXISTS payments_user_idx
       ON payments (user_id, created_at DESC)`,

    `CREATE INDEX IF NOT EXISTS payments_status_idx
       ON payments (status)`,

    `CREATE INDEX IF NOT EXISTS payments_session_idx
       ON payments (stripe_session_id)`,

    `CREATE TABLE IF NOT EXISTS wallet_transactions (
       id            BIGSERIAL PRIMARY KEY,
       user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       delta         BIGINT NOT NULL,
       balance_after BIGINT NOT NULL,
       kind          TEXT NOT NULL,
       ref_type      TEXT,
       ref_id        TEXT,
       meta          JSONB,
       created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE (user_id, ref_type, ref_id)
     )`,

    `CREATE INDEX IF NOT EXISTS wallet_tx_user_idx
       ON wallet_transactions (user_id, created_at DESC)`,

    `CREATE INDEX IF NOT EXISTS wallet_tx_kind_idx
       ON wallet_transactions (kind)`,

    `CREATE TABLE IF NOT EXISTS stripe_events (
       event_id    TEXT PRIMARY KEY,
       type        TEXT,
       processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       note        TEXT
     )`
  ],

  countPackages: `SELECT COUNT(*)::int AS n FROM packages`,

  upsertPackage: `INSERT INTO packages
      (id, tokens, bonus_tokens, price_cents, currency, label, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        tokens = EXCLUDED.tokens,
        bonus_tokens = EXCLUDED.bonus_tokens,
        price_cents = EXCLUDED.price_cents,
        currency = EXCLUDED.currency,
        label = EXCLUDED.label,
        sort_order = EXCLUDED.sort_order`,

  listPackages: `SELECT id, tokens, bonus_tokens, price_cents, currency, label, sort_order
                 FROM packages
                 WHERE active = TRUE
                 ORDER BY sort_order ASC, id ASC`,

  getPackage: `SELECT id, tokens, bonus_tokens, price_cents, currency, label
               FROM packages
               WHERE id = $1 AND active = TRUE`,

  getBalance: `SELECT coins FROM users WHERE id = $1`,

  lockUser: `SELECT id, coins FROM users WHERE id = $1 FOR UPDATE`,

  insertTx: `INSERT INTO wallet_transactions
      (user_id, delta, balance_after, kind, ref_type, ref_id, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, ref_type, ref_id) DO NOTHING
      RETURNING id`,

  updateBalance: `UPDATE users
                  SET coins = coins + $1, updated_at = NOW()
                  WHERE id = $2
                  RETURNING coins`,

  updateTxBalance: `UPDATE wallet_transactions
                    SET balance_after = $1
                    WHERE id = $2`,

  listTransactions: `SELECT id, delta, balance_after, kind, ref_type, ref_id, meta, created_at
                     FROM wallet_transactions
                     WHERE user_id = $1
                       AND ($2::BIGINT IS NULL OR id < $2)
                     ORDER BY id DESC
                     LIMIT $3`,

  insertStripeEvent: `INSERT INTO stripe_events (event_id, type)
                      VALUES ($1, $2)
                      ON CONFLICT (event_id) DO NOTHING
                      RETURNING event_id`
};

/* =========================================================
   SERVICE
========================================================= */

module.exports = function createWallet({ pool, log = console } = {}) {
  if (!pool) {
    log.warn('[WALLET] No database pool provided; wallet is unavailable.');
  }

  async function db(sql, params = []) {
    if (!pool) throw err('database_unavailable', 503);
    return pool.query(sql, params);
  }

  async function withTransaction(fn) {
    if (!pool) throw err('database_unavailable', 503);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  /* ---------------- Schema ---------------- */

  async function ensureSchema() {
    if (!pool) return false;

    for (const statement of SQL.schema) {
      await pool.query(statement);
    }

    return true;
  }

  /* ---------------- Packages ---------------- */

  async function seedPackages() {
    if (!pool) return false;

    const count = await db(SQL.countPackages);
    const existing = count.rows[0] ? count.rows[0].n : 0;

    if (existing > 0) return false;

    for (const pkg of DEFAULT_PACKAGES) {
      await db(SQL.upsertPackage, [
        pkg.id,
        pkg.tokens,
        pkg.bonus_tokens,
        pkg.price_cents,
        pkg.currency,
        pkg.label,
        pkg.sort_order
      ]);
    }

    log.log('[WALLET] Seeded ' + DEFAULT_PACKAGES.length + ' packages.');
    return true;
  }

  async function listPackages() {
    const result = await db(SQL.listPackages);

    return result.rows.map((row) => ({
      id: row.id,
      tokens: Number(row.tokens),
      bonusTokens: Number(row.bonus_tokens),
      priceCents: Number(row.price_cents),
      price: (Number(row.price_cents) / 100).toFixed(2),
      currency: row.currency,
      label: row.label
    }));
  }

  async function getPackage(id) {
    if (typeof id !== 'string' || !id) return null;

    const result = await db(SQL.getPackage, [id]);
    return result.rows[0] || null;
  }

  /* ---------------- Balance ---------------- */

  async function getBalance(userId) {
    const id = normalizeUserId(userId);
    const result = await db(SQL.getBalance, [id]);

    if (!result.rows.length) return null;

    return String(result.rows[0].coins == null ? 0 : result.rows[0].coins);
  }

  /* ---------------- Transactions ---------------- */

  async function listTransactions(userId, options = {}) {
    const id = normalizeUserId(userId);
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, Math.floor(limitRaw)))
      : 20;

    const cursorRaw = options.cursor;
    const cursor = cursorRaw == null || cursorRaw === ''
      ? null
      : String(cursorRaw);

    const result = await db(SQL.listTransactions, [id, cursor, limit]);

    const items = result.rows.map((row) => ({
      id: String(row.id),
      delta: String(row.delta),
      balanceAfter: String(row.balance_after),
      kind: row.kind,
      refType: row.ref_type || null,
      refId: row.ref_id || null,
      meta: row.meta || null,
      createdAt: row.created_at
    }));

    const next = items.length === limit ? items[items.length - 1].id : null;

    return { items, next };
  }

  /* ---------------- Credit (internal only) ---------------- */

  // Adds tokens to users.coins atomically and records the movement.
  // Idempotent on (userId, refType, refId).
  async function credit(userId, tokens, opts = {}) {
    const id = normalizeUserId(userId);
    const amount = toSafeInteger(tokens, 'bad_tokens');

    if (amount <= 0) throw err('bad_tokens');

    const kind = sanitizeKind(opts.kind);
    const refType = sanitizeRefType(opts.refType);
    const refId = sanitizeRefId(opts.refId);
    const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null;

    if (!refType || !refId) throw err('bad_reference');

    return withTransaction(async (client) => {
      const locked = await client.query(SQL.lockUser, [id]);

      if (!locked.rows.length) throw err('user_not_found', 404);

      const currentBalance = BigInt(locked.rows[0].coins == null ? 0 : locked.rows[0].coins);
      const projectedBalance = currentBalance + BigInt(amount);

      const inserted = await client.query(SQL.insertTx, [
        id,
        amount,
        projectedBalance.toString(),
        kind,
        refType,
        refId,
        meta
      ]);

      if (!inserted.rows.length) {
        // Duplicate transaction: nothing to do.
        return {
          applied: false,
          balance: currentBalance.toString(),
          transactionId: null
        };
      }

      const updated = await client.query(SQL.updateBalance, [amount, id]);
      const newBalance = BigInt(updated.rows[0].coins);

      await client.query(SQL.updateTxBalance, [
        newBalance.toString(),
        inserted.rows[0].id
      ]);

      return {
        applied: true,
        balance: newBalance.toString(),
        transactionId: String(inserted.rows[0].id)
      };
    });
  }

  /* ---------------- Debit (internal only) ---------------- */

  // Removes tokens from users.coins atomically.
  // Idempotent on (userId, refType, refId).
  // Rejects if the balance would go negative.
  async function debit(userId, tokens, opts = {}) {
    const id = normalizeUserId(userId);
    const amount = toSafeInteger(tokens, 'bad_tokens');

    if (amount <= 0) throw err('bad_tokens');

    const kind = sanitizeKind(opts.kind);
    const refType = sanitizeRefType(opts.refType);
    const refId = sanitizeRefId(opts.refId);
    const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null;

    if (!refType || !refId) throw err('bad_reference');

    return withTransaction(async (client) => {
      const locked = await client.query(SQL.lockUser, [id]);

      if (!locked.rows.length) throw err('user_not_found', 404);

      const currentBalance = BigInt(locked.rows[0].coins == null ? 0 : locked.rows[0].coins);

      if (currentBalance < BigInt(amount)) {
        throw err('insufficient_balance', 409);
      }

      const projectedBalance = currentBalance - BigInt(amount);

      const inserted = await client.query(SQL.insertTx, [
        id,
        -amount,
        projectedBalance.toString(),
        kind,
        refType,
        refId,
        meta
      ]);

      if (!inserted.rows.length) {
        return {
          applied: false,
          balance: currentBalance.toString(),
          transactionId: null
        };
      }

      const updated = await client.query(SQL.updateBalance, [-amount, id]);
      const newBalance = BigInt(updated.rows[0].coins);

      await client.query(SQL.updateTxBalance, [
        newBalance.toString(),
        inserted.rows[0].id
      ]);

      return {
        applied: true,
        balance: newBalance.toString(),
        transactionId: String(inserted.rows[0].id)
      };
    });
  }

  /* ---------------- Stripe event idempotency ---------------- */

  // Returns true if this event is new (should be processed),
  // false if it was already seen.
  async function claimStripeEvent(eventId, type) {
    const id = String(eventId == null ? '' : eventId).slice(0, 200);

    if (!id) throw err('bad_event_id');

    const result = await db(SQL.insertStripeEvent, [id, String(type || '').slice(0, 100)]);

    return result.rows.length > 0;
  }

  /* ---------------- Helpers ---------------- */

  function normalizeUserId(value) {
    const id = String(value == null ? '' : value);
    if (!/^\d+$/.test(id)) throw err('bad_user_id');
    return id;
  }

  function toSafeInteger(value, code) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw err(code || 'bad_number');
    return n;
  }

  function sanitizeKind(value) {
    const allowed = new Set([
      'purchase',
      'refund',
      'game_win',
      'game_loss',
      'transfer_in',
      'transfer_out',
      'withdraw',
      'adjustment'
    ]);
    const kind = String(value == null ? '' : value);
    return allowed.has(kind) ? kind : 'adjustment';
  }

  function sanitizeRefType(value) {
    const v = String(value == null ? '' : value).trim();
    return v ? v.slice(0, 40) : null;
  }

  function sanitizeRefId(value) {
    const v = String(value == null ? '' : value).trim();
    return v ? v.slice(0, 200) : null;
  }

  return {
    ensureSchema,
    seedPackages,
    listPackages,
    getPackage,
    getBalance,
    listTransactions,
    credit,
    debit,
    claimStripeEvent,
    _t: { SQL, DEFAULT_PACKAGES }
  };
};

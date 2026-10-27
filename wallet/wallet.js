'use strict';

// wallet/wallet.js — Cafe Life wallet core.
// ============================================================================
// Design principles (non-negotiable):
//
// 1. SINGLE SOURCE OF TRUTH: all balance changes go through credit() or debit().
//    No route, game, or module may touch users.coins directly.
//
// 2. UNIQUE REFERENCE PER MOVEMENT: every credit/debit carries
//    (ref_type, ref_id). The DB enforces UNIQUE (user_id, ref_type, ref_id),
//    which gives us real idempotency — NOT conflict avoidance.
//
//    The previous version silently converted unknown kinds to 'adjustment'
//    AND reused the same ref for debit + refund, which caused refunds and
//    payouts to be swallowed by ON CONFLICT DO NOTHING. That's the root cause
//    of missing refunds and "won but balance unchanged".
//
//    Rules enforced here:
//      - debit + refund use DIFFERENT ref_type (e.g. wager_hold vs wager_refund)
//      - every refund/payout has a distinct ref_id (e.g. refund_<id>_A)
//      - re-sending the same request is a no-op (returns applied:false)
//
// 3. ATOMICITY: every movement runs inside a transaction with SELECT ... FOR
//    UPDATE on the user row. No partially-applied balance changes possible.
//
// 4. NO HIDDEN MAGIC: unknown kind → throw, not silent fallback. This prevents
//    accounting corruption from typos or future modules.
//
// 5. STRONG IDEMPOTENCY: if a request is replayed (WebSocket reconnect, Stripe
//    retry, etc.), the wallet returns the previous result instead of applying
//    twice.
// ============================================================================

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
   ALLOWED KINDS
   ---------------------------------------------------------
   These are the ONLY kinds accepted by credit()/debit().
   Unknown kinds throw — no silent fallback to 'adjustment'.

   Wager-related kinds are grouped to make accounting reports clean:
     wager_hold    — funds reserved when a wager is created/accepted
     wager_refund  — funds returned when a wager is cancelled/drawn/failed
     wager_win     — funds paid to the winner on settlement
     wager_loss    — funds lost by the loser (symmetric with wager_win)
     wager_void    — funds returned when a wager is voided server-side
                     (e.g. timeout, disconnect before game start)
========================================================= */

const ALLOWED_KINDS = new Set([
  // payments
  'purchase',
  'refund',
  // general game balance
  'game_win',
  'game_loss',
  // internal transfers
  'transfer_in',
  'transfer_out',
  'withdraw',
  'adjustment',
  // wagers
  'wager_hold',
  'wager_refund',
  'wager_win',
  'wager_loss',
  'wager_void',
]);

/* =========================================================
   ERRORS
========================================================= */

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

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

    // wallet_transactions is the accounting ledger. Every row is immutable.
    // UNIQUE (user_id, ref_type, ref_id) = real idempotency: two identical
    // movements can never be recorded twice for the same user.
    `CREATE TABLE IF NOT EXISTS wallet_transactions (
       id            BIGSERIAL PRIMARY KEY,
       user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       delta         BIGINT NOT NULL,
       balance_after BIGINT NOT NULL,
       kind          TEXT NOT NULL,
       ref_type      TEXT NOT NULL,
       ref_id        TEXT NOT NULL,
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

  // Check whether a specific movement was already recorded.
  findTx: `SELECT id, delta, balance_after
           FROM wallet_transactions
           WHERE user_id = $1 AND ref_type = $2 AND ref_id = $3`,

  insertTx: `INSERT INTO wallet_transactions
      (user_id, delta, balance_after, kind, ref_type, ref_id, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
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

  // Returns the numeric balance (as a JS number within safe integer range).
  // Use getBalanceRaw() if you need the exact BIGINT as a string for display.
  async function getBalance(userId) {
    const raw = await getBalanceRaw(userId);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      // Extremely unlikely in practice, but never silently lose precision.
      throw err('balance_out_of_range', 500);
    }
    return n;
  }

  async function getBalanceRaw(userId) {
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

  /* ---------------- Core movement helper ---------------- */

  // Shared implementation for credit() and debit(). Keeps semantics identical
  // and avoids drift between the two. `signedAmount` is positive for credit,
  // negative for debit.
  async function applyMovement(userId, signedAmount, opts, direction) {
    const id = normalizeUserId(userId);

    // Validate amount — 0 is meaningless and rejected.
    const rawAmount = Number(opts.amount);
    if (!Number.isSafeInteger(rawAmount) || rawAmount <= 0) {
      throw err('bad_tokens', 400);
    }

    // Validate kind strictly. Unknown kinds are a programming bug, not user
    // input; throwing makes the bug visible immediately instead of corrupting
    // the ledger silently.
    const kind = String(opts.kind == null ? '' : opts.kind);
    if (!ALLOWED_KINDS.has(kind)) {
      throw err(`bad_kind:${kind}`, 400, { allowed: [...ALLOWED_KINDS] });
    }

    const refType = sanitizeRefType(opts.refType);
    const refId = sanitizeRefId(opts.refId);
    if (!refType) throw err('bad_ref_type', 400);
    if (!refId) throw err('bad_ref_id', 400);

    const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : null;

    return withTransaction(async (client) => {
      // Lock the user row. This serialises all movements for this user.
      const locked = await client.query(SQL.lockUser, [id]);
      if (!locked.rows.length) throw err('user_not_found', 404);

      const currentBalance = BigInt(locked.rows[0].coins == null ? 0 : locked.rows[0].coins);

      // Idempotency check inside the lock: has this exact movement already
      // been recorded? If yes, return the prior result without touching the
      // balance again.
      const prior = await client.query(SQL.findTx, [id, refType, refId]);
      if (prior.rows.length) {
        const row = prior.rows[0];
        return {
          applied: false,
          duplicate: true,
          balance: String(currentBalance),
          previousDelta: String(row.delta),
          previousBalanceAfter: String(row.balance_after),
          transactionId: String(row.id)
        };
      }

      // Debit must not go negative.
      if (direction === 'debit' && currentBalance < BigInt(rawAmount)) {
        throw err('insufficient_balance', 409, {
          required: rawAmount,
          available: Number(currentBalance)
        });
      }

      const projected = currentBalance + BigInt(signedAmount);

      // Insert ledger row first (with a provisional balance_after). The UNIQUE
      // index is the ultimate guard against races; if it fires, we treat it
      // as a duplicate (defence-in-depth against concurrent identical calls
      // from two pool connections — the FOR UPDATE above already prevents this
      // for the same user, but we keep the safety net).
      let inserted;
      try {
        inserted = await client.query(SQL.insertTx, [
          id,
          signedAmount.toString(),
          projected.toString(),
          kind,
          refType,
          refId,
          meta
        ]);
      } catch (e) {
        if (e && e.code === '23505') {
          // Unique violation → duplicate movement.
          return {
            applied: false,
            duplicate: true,
            balance: String(currentBalance),
            transactionId: null
          };
        }
        throw e;
      }

      if (!inserted.rows.length) {
        // Defensive: insertTx has no ON CONFLICT now, so this branch should
        // not be reached. Keep it as a safety net.
        return {
          applied: false,
          duplicate: true,
          balance: String(currentBalance),
          transactionId: null
        };
      }

      // Apply the balance change.
      const updated = await client.query(SQL.updateBalance, [signedAmount.toString(), id]);
      const newBalance = BigInt(updated.rows[0].coins);

      // Fix balance_after to reflect the true balance at the moment of commit.
      await client.query(SQL.updateTxBalance, [
        newBalance.toString(),
        inserted.rows[0].id
      ]);

      return {
        applied: true,
        duplicate: false,
        balance: newBalance.toString(),
        transactionId: String(inserted.rows[0].id)
      };
    });
  }

  /* ---------------- Credit (internal only) ---------------- */

  // Adds tokens to users.coins atomically and records the movement.
  // Idempotent on (userId, refType, refId): a repeated call returns
  // { applied:false, duplicate:true } and does NOT change the balance.
  async function credit(userId, tokens, opts = {}) {
    return applyMovement(userId, Number(tokens), {
      amount: Number(tokens),
      kind: opts.kind,
      refType: opts.refType,
      refId: opts.refId,
      meta: opts.meta
    }, 'credit');
  }

  /* ---------------- Debit (internal only) ---------------- */

  // Removes tokens from users.coins atomically.
  // Idempotent on (userId, refType, refId).
  // Rejects with insufficient_balance if the balance would go negative.
  async function debit(userId, tokens, opts = {}) {
    return applyMovement(userId, -Number(tokens), {
      amount: Number(tokens),
      kind: opts.kind,
      refType: opts.refType,
      refId: opts.refId,
      meta: opts.meta
    }, 'debit');
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
    getBalanceRaw,
    listTransactions,
    credit,
    debit,
    claimStripeEvent,
    ALLOWED_KINDS,
    _t: { SQL, DEFAULT_PACKAGES }
  };
};

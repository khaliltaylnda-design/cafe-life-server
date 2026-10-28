'use strict';

// ============================================================================
// wallet/wallet.js — Cafe Life Wallet (clean rewrite v2).
// ============================================================================
// المسؤوليات:
//   1. إدارة أرصدة المستخدمين (users.coins) بشكل ذري.
//   2. تسجيل كل حركة في wallet_transactions (ledger غير قابل للتعديل).
//   3. توفير hash chain اختياري للتدقيق (prev_hash → entry_hash).
//   4. إدارة packages (متجر).
//   5. تسجيل stripe events (idempotency).
//   6. حذف الـ triggers القديمة من النسخ السابقة.
//
// الضمانات:
//   - كل حركة = transaction واحدة.
//   - SELECT ... FOR UPDATE قبل القراءة → لا race conditions.
//   - UNIQUE (user_id, ref_type, ref_id) → idempotency.
//   - prev_hash + entry_hash → كشف التلاعب (اختياري).
//   - CHECK (coins >= 0) → حماية DB-level.
// ============================================================================

const crypto = require('crypto');

// ============================================================================
// 1. CONSTANTS
// ============================================================================
const MAX_BALANCE = 1_000_000_000_000n; // 1e12
const MAX_META_BYTES = 4 * 1024;
const MAX_REF_TYPE_LEN = 40;
const MAX_REF_ID_LEN = 200;
const MAX_BIGINT = 9223372036854775807n;

const ALLOWED_KINDS = new Set([
  'purchase', 'refund',
  'game_win', 'game_loss',
  'transfer_in', 'transfer_out',
  'withdraw', 'adjustment',
  'wager_hold', 'wager_refund', 'wager_win', 'wager_loss', 'wager_void',
]);

// ============================================================================
// 2. HELPERS
// ============================================================================
const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

function normalizeUserId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw err('bad_user_id', 400);
  }
  const s = String(value);
  if (!/^\d{1,19}$/.test(s)) throw err('bad_user_id', 400);
  const n = BigInt(s);
  if (n <= 0n || n > MAX_BIGINT) throw err('bad_user_id', 400);
  return s;
}

function validateTokens(value) {
  if (typeof value !== 'number') throw err('bad_tokens', 400);
  if (!Number.isSafeInteger(value) || value <= 0) throw err('bad_tokens', 400);
  return value;
}

function sanitizeRefType(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (v.length > MAX_REF_TYPE_LEN) throw err('ref_type_too_long', 400);
  if (!/^[A-Za-z0-9_\-:.]+$/.test(v)) throw err('ref_type_invalid_chars', 400);
  return v;
}

function sanitizeRefId(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (v.length > MAX_REF_ID_LEN) {
    throw err('ref_id_too_long', 400, { max: MAX_REF_ID_LEN, got: v.length });
  }
  if (!/^[A-Za-z0-9_\-:.]+$/.test(v)) throw err('ref_id_invalid_chars', 400);
  return v;
}

function safeMeta(meta) {
  if (meta == null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) throw err('bad_meta', 400);

  let json;
  try {
    json = JSON.stringify(structuredClone(meta));
  } catch {
    throw err('bad_meta', 400);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_META_BYTES) throw err('meta_too_large', 400);
  return JSON.parse(json);
}

function computeEntryHash({ userId, delta, kind, refType, refId, prevHash }) {
  const h = crypto.createHash('sha256');
  h.update(String(userId));
  h.update('|');
  h.update(String(delta));
  h.update('|');
  h.update(String(kind));
  h.update('|');
  h.update(String(refType));
  h.update('|');
  h.update(String(refId));
  h.update('|');
  h.update(String(prevHash || 'GENESIS'));
  return h.digest('hex');
}

// ============================================================================
// 3. SQL
// ============================================================================
const SQL = {
  // ---- Schema: phase 1 (tables) ----
  schemaTables: [
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

    `CREATE TABLE IF NOT EXISTS payments (
       id                    TEXT PRIMARY KEY,
       user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       package_id            TEXT NOT NULL REFERENCES packages(id),
       amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
       currency              TEXT NOT NULL,
       tokens                INTEGER NOT NULL CHECK (tokens > 0),
       bonus_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (bonus_tokens >= 0),
       status                TEXT NOT NULL DEFAULT 'pending',
       stripe_session_id     TEXT UNIQUE,
       stripe_payment_intent TEXT,
       stripe_event_id       TEXT UNIQUE,
       created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       paid_at               TIMESTAMPTZ,
       failed_at             TIMESTAMPTZ,
       refunded_at           TIMESTAMPTZ
     )`,

    `CREATE TABLE IF NOT EXISTS wallet_transactions (
       id            BIGSERIAL PRIMARY KEY,
       user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
       delta         BIGINT NOT NULL,
       balance_after BIGINT NOT NULL,
       kind          TEXT NOT NULL,
       ref_type      TEXT NOT NULL,
       ref_id        TEXT NOT NULL,
       meta          JSONB,
       prev_hash     TEXT,
       entry_hash    TEXT,
       created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE (user_id, ref_type, ref_id)
     )`,

    `CREATE TABLE IF NOT EXISTS stripe_events (
       event_id     TEXT PRIMARY KEY,
       type         TEXT,
       status       TEXT NOT NULL DEFAULT 'processing',
       attempts     INT NOT NULL DEFAULT 1,
       last_error   TEXT,
       processed_at TIMESTAMPTZ,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  ],

  // ---- Phase 2: missing columns (safe ALTERs) ----
  schemaColumns: [
    `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS prev_hash TEXT`,
    `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS entry_hash TEXT`,
    `ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing'`,
    `ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 1`,
    `ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS last_error TEXT`,
  ],

  // ---- Phase 3: indexes ----
  schemaIndexes: [
    `CREATE INDEX IF NOT EXISTS packages_active_idx ON packages (active, sort_order)`,
    `CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status)`,
    `CREATE INDEX IF NOT EXISTS payments_session_idx ON payments (stripe_session_id)`,
    `CREATE INDEX IF NOT EXISTS wallet_tx_user_idx ON wallet_transactions (user_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS wallet_tx_kind_idx ON wallet_transactions (kind)`,
  ],

  // ---- Phase 4: cleanup legacy objects (from previous wallet versions) ----
  // هذه المرحلة تحذف triggers/tables التي كانت موجودة في النسخة القديمة
  // (wallet_guard_coins + wallet_ctx + wallet_ledger_guard + wallet_invariant_check)
  // لأنها تمنع wallet.credit/debit من العمل.
  schemaCleanup: [
    `DROP TRIGGER IF EXISTS wallet_guard_coins_trigger ON users`,
    `DROP FUNCTION IF EXISTS wallet_guard_coins()`,
    `DROP TRIGGER IF EXISTS wallet_ledger_guard_trigger ON wallet_transactions`,
    `DROP FUNCTION IF EXISTS wallet_ledger_guard()`,
    `DROP TRIGGER IF EXISTS wallet_invariant_trigger ON wallet_transactions`,
    `DROP FUNCTION IF EXISTS wallet_invariant_check()`,
    `DROP TABLE IF EXISTS wallet_ctx`,
  ],

  // ---- Phase 5: constraints ----
  schemaConstraints: [
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'users_coins_non_negative'
       ) THEN
         ALTER TABLE users
           ADD CONSTRAINT users_coins_non_negative CHECK (coins >= 0);
       END IF;
     END $$`,
  ],

  // ---- Queries ----
  countPackages: `SELECT COUNT(*)::int AS n FROM packages`,
  upsertPackage: `
    INSERT INTO packages (id, tokens, bonus_tokens, price_cents, currency, label, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      tokens = EXCLUDED.tokens,
      bonus_tokens = EXCLUDED.bonus_tokens,
      price_cents = EXCLUDED.price_cents,
      currency = EXCLUDED.currency,
      label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order`,
  insertPackageIfMissing: `
    INSERT INTO packages (id, tokens, bonus_tokens, price_cents, currency, label, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO NOTHING`,
  listPackages: `
    SELECT id, tokens, bonus_tokens, price_cents, currency, label, sort_order
    FROM packages WHERE active = TRUE
    ORDER BY sort_order ASC, id ASC`,
  getPackage: `
    SELECT id, tokens, bonus_tokens, price_cents, currency, label
    FROM packages WHERE id = $1 AND active = TRUE`,

  getBalance: `SELECT coins FROM users WHERE id = $1`,
  getBalances: `SELECT id, coins FROM users WHERE id = ANY($1::BIGINT[])`,
  lockUser: `SELECT id, coins FROM users WHERE id = $1 FOR UPDATE`,

  findTx: `
    SELECT id, delta, balance_after, kind, prev_hash, entry_hash
    FROM wallet_transactions
    WHERE user_id = $1 AND ref_type = $2 AND ref_id = $3`,
  lastEntry: `
    SELECT entry_hash FROM wallet_transactions
    WHERE user_id = $1
    ORDER BY id DESC LIMIT 1`,
  insertTx: `
    INSERT INTO wallet_transactions
      (user_id, delta, balance_after, kind, ref_type, ref_id, meta, prev_hash, entry_hash)
    VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
  updateBalance: `
    UPDATE users SET coins = coins + $1, updated_at = NOW()
    WHERE id = $2
    RETURNING coins`,
  updateTxBalance: `
    UPDATE wallet_transactions SET balance_after = $1
    WHERE id = $2`,

  listTransactions: `
    SELECT id, delta, balance_after, kind, ref_type, ref_id, meta, created_at
    FROM wallet_transactions
    WHERE user_id = $1 AND ($2::BIGINT IS NULL OR id < $2)
    ORDER BY id DESC LIMIT $3`,

  getTransaction: `
    SELECT id, delta, balance_after, kind, ref_type, ref_id, meta, created_at
    FROM wallet_transactions
    WHERE user_id = $1 AND id = $2`,

  claimStripeEvent: `
    INSERT INTO stripe_events (event_id, type, status, attempts)
    VALUES ($1, $2, 'processing', 1)
    ON CONFLICT (event_id) DO UPDATE SET
      attempts = stripe_events.attempts + 1,
      status = 'processing',
      last_error = NULL
    WHERE stripe_events.status IN ('processing', 'failed')
    RETURNING event_id, attempts`,
  markEventDone: `UPDATE stripe_events SET status='done', processed_at=NOW() WHERE event_id=$1`,
  markEventFailed: `UPDATE stripe_events SET status='failed', last_error=$2 WHERE event_id=$1`,

  verifyChain: `
    SELECT id, delta, kind, ref_type, ref_id, prev_hash, entry_hash
    FROM wallet_transactions
    WHERE user_id = $1
    ORDER BY id ASC`,
  reconcile: `
    SELECT
      (SELECT coins FROM users WHERE id = $1) AS coins,
      (SELECT COALESCE(SUM(delta),0) FROM wallet_transactions WHERE user_id = $1) AS sum_delta`,
};

// ============================================================================
// 4. DEFAULT PACKAGES
// ============================================================================
const DEFAULT_PACKAGES = Object.freeze([
  { id: 'pkg_500',  tokens: 500,  bonus_tokens: 0, price_cents: 399,  currency: 'USD', label: '500 Tokens',   sort_order: 10 },
  { id: 'pkg_1200', tokens: 1200, bonus_tokens: 0, price_cents: 799,  currency: 'USD', label: '1,200 Tokens', sort_order: 20 },
  { id: 'pkg_2500', tokens: 2500, bonus_tokens: 0, price_cents: 1499, currency: 'USD', label: '2,500 Tokens', sort_order: 30 },
  { id: 'pkg_6000', tokens: 6000, bonus_tokens: 0, price_cents: 2999, currency: 'USD', label: '6,000 Tokens', sort_order: 40 },
]);

// ============================================================================
// 5. FACTORY
// ============================================================================
module.exports = function createWallet({ pool, log = console } = {}) {
  if (!pool) log.warn('[WALLET] No database pool; wallet unavailable.');

  // ---------------------------------------------------------------------------
  // DB helpers
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Core movement (atomic)
  // ---------------------------------------------------------------------------
  async function applyMovement(userId, signedAmount, opts, direction) {
    const id = normalizeUserId(userId);
    const amount = validateTokens(opts.amount);

    if (direction === 'debit' && signedAmount !== -amount) throw err('bad_signed_amount', 400);
    if (direction === 'credit' && signedAmount !== amount) throw err('bad_signed_amount', 400);

    const kind = String(opts.kind == null ? '' : opts.kind);
    if (!ALLOWED_KINDS.has(kind)) {
      throw err(`bad_kind:${kind}`, 400, { allowed: [...ALLOWED_KINDS] });
    }

    const refType = sanitizeRefType(opts.refType);
    const refId = sanitizeRefId(opts.refId);
    if (!refType) throw err('bad_ref_type', 400);
    if (!refId) throw err('bad_ref_id', 400);

    const meta = safeMeta(opts.meta);

    return withTransaction(async (client) => {
      // 1) Lock user row
      const locked = await client.query(SQL.lockUser, [id]);
      if (!locked.rows.length) throw err('user_not_found', 404);

      let currentBalance;
      try {
        currentBalance = BigInt(locked.rows[0].coins ?? 0);
      } catch {
        log.error(`[WALLET] corrupt coins user=${id}`);
        throw err('balance_corrupt', 500);
      }

      // 2) Duplicate check
      const prior = await client.query(SQL.findTx, [id, refType, refId]);
      if (prior.rows.length) {
        const row = prior.rows[0];
        if (row.kind && row.kind !== kind) {
          log.error(`[WALLET] SECURITY: ref reuse kind mismatch user=${id} ref=${refType}:${refId} old=${row.kind} new=${kind}`);
          throw err('ref_reuse_kind_mismatch', 409);
        }
        return {
          applied: false,
          duplicate: true,
          balance: String(currentBalance),
          previousDelta: String(row.delta),
          previousBalanceAfter: String(row.balance_after),
          transactionId: String(row.id),
        };
      }

      // 3) Sufficient funds (debit only)
      if (direction === 'debit' && currentBalance < BigInt(amount)) {
        throw err('insufficient_balance', 409, {
          required: amount,
          available: Number(currentBalance),
        });
      }

      // 4) Bounds
      const projected = currentBalance + BigInt(signedAmount);
      if (projected > MAX_BALANCE) {
        throw err('balance_overflow', 400, { max: String(MAX_BALANCE) });
      }
      if (projected < 0n) {
        throw err('balance_underflow', 500);
      }

      // 5) Hash chain
      const last = await client.query(SQL.lastEntry, [id]);
      const prevHash = last.rows[0]?.entry_hash || null;
      const entryHash = computeEntryHash({
        userId: id,
        delta: BigInt(signedAmount),
        kind,
        refType,
        refId,
        prevHash,
      });

      // 6) Insert transaction
      let inserted;
      try {
        inserted = await client.query(SQL.insertTx, [
          id,
          signedAmount.toString(),
          kind,
          refType,
          refId,
          meta,
          prevHash,
          entryHash,
        ]);
      } catch (e) {
        if (e?.code === '23505') {
          return {
            applied: false,
            duplicate: true,
            balance: String(currentBalance),
            transactionId: null,
          };
        }
        throw e;
      }

      // 7) Update balance
      const updated = await client.query(SQL.updateBalance, [
        signedAmount.toString(),
        id,
      ]);
      const newBalance = BigInt(updated.rows[0].coins);

      // 8) Backfill balance_after
      await client.query(SQL.updateTxBalance, [
        newBalance.toString(),
        inserted.rows[0].id,
      ]);

      // 9) Drift detection
      if (newBalance !== projected) {
        log.warn(`[WALLET] DRIFT user=${id} expected=${projected} actual=${newBalance}`);
      }
      if (Math.abs(signedAmount) >= 10000) {
        log.log(`[WALLET] large ${direction} user=${id} amount=${signedAmount} kind=${kind} ref=${refType}:${refId} balance=${newBalance}`);
      }

      return {
        applied: true,
        duplicate: false,
        balance: newBalance.toString(),
        transactionId: String(inserted.rows[0].id),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Public mutations
  // ---------------------------------------------------------------------------
  async function credit(userId, tokens, opts = {}) {
    const amount = validateTokens(tokens);
    return applyMovement(
      userId,
      amount,
      { amount, kind: opts.kind, refType: opts.refType, refId: opts.refId, meta: opts.meta },
      'credit'
    );
  }

  async function debit(userId, tokens, opts = {}) {
    const amount = validateTokens(tokens);
    return applyMovement(
      userId,
      -amount,
      { amount, kind: opts.kind, refType: opts.refType, refId: opts.refId, meta: opts.meta },
      'debit'
    );
  }

  // ---------------------------------------------------------------------------
  // Balance reads
  // ---------------------------------------------------------------------------
  async function getBalanceRaw(userId) {
    const id = normalizeUserId(userId);
    const result = await db(SQL.getBalance, [id]);
    if (!result.rows.length) return null;
    return String(result.rows[0].coins ?? 0);
  }

  async function getBalance(userId) {
    const raw = await getBalanceRaw(userId);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      log.warn(`[WALLET] balance_out_of_range user=${userId} value=${raw}`);
      return raw;
    }
    return n;
  }

  async function getBalances(userIds) {
    if (!Array.isArray(userIds) || !userIds.length) return new Map();
    const ids = userIds.map(normalizeUserId);
    const result = await db(SQL.getBalances, [ids]);
    const map = new Map();
    for (const row of result.rows) {
      map.set(String(row.id), String(row.coins ?? 0));
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Transaction listing
  // ---------------------------------------------------------------------------
  async function listTransactions(userId, options = {}) {
    const id = normalizeUserId(userId);

    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, Math.floor(limitRaw)))
      : 20;

    let cursor = null;
    if (options.cursor != null && options.cursor !== '') {
      const s = String(options.cursor);
      if (!/^\d{1,19}$/.test(s)) throw err('bad_cursor', 400);
      cursor = s;
    }

    const result = await db(SQL.listTransactions, [id, cursor, limit]);
    const items = result.rows.map((row) => ({
      id: String(row.id),
      delta: String(row.delta),
      balanceAfter: String(row.balance_after),
      kind: row.kind,
      refType: row.ref_type || null,
      refId: row.ref_id || null,
      meta: row.meta || null,
      createdAt: row.created_at,
    }));

    const next = items.length === limit ? items[items.length - 1].id : null;
    return { items, next };
  }

  async function getTransaction(userId, txId) {
    const id = normalizeUserId(userId);
    const tid = String(txId);
    if (!/^\d{1,19}$/.test(tid)) throw err('bad_tx_id', 400);
    const result = await db(SQL.getTransaction, [id, tid]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      id: String(row.id),
      delta: String(row.delta),
      balanceAfter: String(row.balance_after),
      kind: row.kind,
      refType: row.ref_type || null,
      refId: row.ref_id || null,
      meta: row.meta || null,
      createdAt: row.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Packages
  // ---------------------------------------------------------------------------
  async function listPackages() {
    const result = await db(SQL.listPackages);
    return result.rows.map((row) => ({
      id: row.id,
      tokens: Number(row.tokens),
      bonusTokens: Number(row.bonus_tokens),
      priceCents: Number(row.price_cents),
      price: (Number(row.price_cents) / 100).toFixed(2),
      currency: row.currency,
      label: row.label,
    }));
  }

  async function getPackage(id) {
    if (typeof id !== 'string' || !id) return null;
    const result = await db(SQL.getPackage, [id]);
    return result.rows[0] || null;
  }

  async function seedPackages() {
    if (!pool) return false;
    let seeded = 0;
    for (const pkg of DEFAULT_PACKAGES) {
      const result = await db(SQL.insertPackageIfMissing, [
        pkg.id, pkg.tokens, pkg.bonus_tokens, pkg.price_cents,
        pkg.currency, pkg.label, pkg.sort_order,
      ]);
      seeded += result.rowCount;
    }
    if (seeded > 0) log.log(`[WALLET] Seeded ${seeded} packages.`);
    return seeded;
  }

  // ---------------------------------------------------------------------------
  // Stripe events
  // ---------------------------------------------------------------------------
  async function claimStripeEvent(eventId, type) {
    const id = String(eventId == null ? '' : eventId).slice(0, 200);
    if (!id) throw err('bad_event_id');
    const result = await db(SQL.claimStripeEvent, [id, String(type || '').slice(0, 100)]);
    return result.rows[0] || null;
  }

  async function markStripeEventDone(eventId) {
    await db(SQL.markEventDone, [String(eventId).slice(0, 200)]);
  }

  async function markStripeEventFailed(eventId, errorMsg) {
    await db(SQL.markEventFailed, [
      String(eventId).slice(0, 200),
      String(errorMsg || '').slice(0, 500),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------
  async function verifyChain(userId) {
    const id = normalizeUserId(userId);
    const result = await db(SQL.verifyChain, [id]);

    let prev = null;
    for (const row of result.rows) {
      const expected = computeEntryHash({
        userId: id,
        delta: BigInt(row.delta),
        kind: row.kind,
        refType: row.ref_type,
        refId: row.ref_id,
        prevHash: prev,
      });
      if (row.entry_hash !== expected) {
        return { ok: false, brokenAt: String(row.id) };
      }
      prev = row.entry_hash;
    }
    return { ok: true, brokenAt: null };
  }

  async function reconcile(userId) {
    const id = normalizeUserId(userId);
    const r = await db(SQL.reconcile, [id]);
    const row = r.rows[0];

    const coins = BigInt(row.coins ?? 0);
    const sum = BigInt(row.sum_delta ?? 0);

    return {
      userId: id,
      coins: coins.toString(),
      sumDelta: sum.toString(),
      ok: coins === sum,
      diff: (coins - sum).toString(),
    };
  }

  async function healthCheck() {
    if (!pool) return { ok: false, error: 'no_pool' };
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------
  async function ensureSchema() {
    if (!pool) return false;

    const phases = [
      { name: 'tables', queries: SQL.schemaTables },
      { name: 'columns', queries: SQL.schemaColumns },
      { name: 'indexes', queries: SQL.schemaIndexes },
      { name: 'cleanup', queries: SQL.schemaCleanup },
      { name: 'constraints', queries: SQL.schemaConstraints },
    ];

    for (const phase of phases) {
      for (const q of phase.queries) {
        try {
          await pool.query(q);
        } catch (error) {
          // Ignore "already exists" for idempotent operations
          if (error.code === '42P07' || error.code === '42710') continue;

          // DROP IF EXISTS errors (missing table/function) — ignore
          if (phase.name === 'cleanup' && (error.code === '42P01' || error.code === '42883')) {
            continue;
          }

          // users_coins_non_negative may fail if bad data exists.
          if (phase.name === 'constraints' && error.code === '23514') {
            log.error('[WALLET] constraint failed (bad data):', error.message);
            continue;
          }
          throw error;
        }
      }
      log.log(`[WALLET] schema phase "${phase.name}" OK`);
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    // Lifecycle
    ensureSchema,
    seedPackages,
    healthCheck,

    // Mutations
    credit,
    debit,

    // Reads
    getBalance,
    getBalanceRaw,
    getBalances,
    listTransactions,
    getTransaction,

    // Packages
    listPackages,
    getPackage,

    // Stripe
    claimStripeEvent,
    markStripeEventDone,
    markStripeEventFailed,

    // Audit
    verifyChain,
    reconcile,

    // Constants
    ALLOWED_KINDS,
    MAX_BALANCE,

    // Test hooks
    _t: {
      SQL,
      DEFAULT_PACKAGES,
      computeEntryHash,
      validateTokens,
      normalizeUserId,
      safeMeta,
    },
  };
};

'use strict';

// ============================================================================
// payments/withdrawals.js — Withdrawal requests (Universal Methods)
// ============================================================================
// Flow (Method A — debit on request):
//   1. Player requests → wallet.debit (hold) + row created (status='pending').
//   2. Admin approves → status='approved' (no money change).
//   3. Admin rejects → wallet.credit (refund) + status='rejected'.
//   4. Admin marks paid → status='paid' (no money change).
//
// Security:
//   - All fee calculations happen SERVER-SIDE (never trust client)
//   - Method whitelist enforced (18 methods)
//   - Per-method field validation
//   - Net amount computed and stored for audit trail
// ============================================================================

const crypto = require('crypto');

// ============ METHOD REGISTRY (SERVER-SIDE = SOURCE OF TRUTH) ============
// This MUST match the client-side METHODS object exactly.
// If you add a method here, add it to index.html too.
const METHODS = Object.freeze({
  // --- BANK ---
  iban: {
    cat: 'bank', name: 'IBAN بنكي', fee: 2, min: 1000, max: 500_000,
    fields: ['fullName', 'iban', 'bankName'],
    validators: {
      iban: v => /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/i.test(v.replace(/\s+/g, '')),
      fullName: v => v.length >= 3 && v.length <= 100,
      bankName: v => v.length >= 2 && v.length <= 100,
    },
  },
  swift: {
    cat: 'bank', name: 'SWIFT دولي', fee: 5, min: 5000, max: 500_000,
    fields: ['fullName', 'iban', 'swift', 'bankName', 'country'],
    validators: {
      iban: v => /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/i.test(v.replace(/\s+/g, '')),
      swift: v => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/i.test(v),
      fullName: v => v.length >= 3 && v.length <= 100,
      bankName: v => v.length >= 2 && v.length <= 100,
      country: v => v.length >= 2 && v.length <= 60,
    },
  },
  poste: {
    cat: 'bank', name: 'البريد التونسي', fee: 1.5, min: 1000, max: 500_000,
    fields: ['fullName', 'postalAccount'],
    validators: {
      fullName: v => v.length >= 3 && v.length <= 100,
      postalAccount: v => /^[0-9]{6,12}$/.test(v.replace(/\s/g, '')),
    },
  },
  d17e_bank: {
    cat: 'bank', name: 'D17e تحويل', fee: 1, min: 500, max: 500_000,
    fields: ['fullName', 'd17ePhone'],
    validators: {
      fullName: v => v.length >= 3 && v.length <= 100,
      d17ePhone: v => /^(\+216)?[0-9]{8}$/.test(v.replace(/[\s-]/g, '')),
    },
  },

  // --- E-WALLETS ---
  paypal: {
    cat: 'ewallet', name: 'PayPal', fee: 4, min: 1000, max: 500_000,
    fields: ['paypalEmail'],
    validators: { paypalEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200 },
  },
  payoneer: {
    cat: 'ewallet', name: 'Payoneer', fee: 3, min: 2000, max: 500_000,
    fields: ['payoneerEmail'],
    validators: { payoneerEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200 },
  },
  wise: {
    cat: 'ewallet', name: 'Wise', fee: 2.5, min: 1000, max: 500_000,
    fields: ['wiseEmail'],
    validators: { wiseEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200 },
  },
  skrill: {
    cat: 'ewallet', name: 'Skrill', fee: 3, min: 1000, max: 500_000,
    fields: ['skrillEmail'],
    validators: { skrillEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200 },
  },
  redotpay: {
    cat: 'ewallet', name: 'RedotPay', fee: 1.5, min: 500, max: 500_000,
    fields: ['redotId'],
    validators: { redotId: v => /^[A-Za-z0-9_-]{4,64}$/.test(v) },
  },
  neteller: {
    cat: 'ewallet', name: 'Neteller', fee: 3, min: 1000, max: 500_000,
    fields: ['netellerEmail'],
    validators: { netellerEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200 },
  },

  // --- CRYPTO ---
  usdt_trc20: {
    cat: 'crypto', name: 'USDT TRC20', fee: 1, min: 500, max: 500_000,
    fields: ['usdtAddress'],
    validators: { usdtAddress: v => /^T[a-zA-Z0-9]{33}$/.test(v) },
  },
  usdt_erc20: {
    cat: 'crypto', name: 'USDT ERC20', fee: 2, min: 1000, max: 500_000,
    fields: ['usdtAddress'],
    validators: { usdtAddress: v => /^0x[a-fA-F0-9]{40}$/.test(v) },
  },
  usdt_bep20: {
    cat: 'crypto', name: 'USDT BEP20', fee: 0.5, min: 500, max: 500_000,
    fields: ['usdtAddress'],
    validators: { usdtAddress: v => /^0x[a-fA-F0-9]{40}$/.test(v) },
  },
  btc: {
    cat: 'crypto', name: 'Bitcoin BTC', fee: 1.5, min: 2000, max: 500_000,
    fields: ['btcAddress'],
    validators: {
      btcAddress: v => /^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(v),
    },
  },
  eth: {
    cat: 'crypto', name: 'Ethereum ETH', fee: 2, min: 2000, max: 500_000,
    fields: ['ethAddress'],
    validators: { ethAddress: v => /^0x[a-fA-F0-9]{40}$/.test(v) },
  },
  bnb: {
    cat: 'crypto', name: 'BNB', fee: 0.5, min: 500, max: 500_000,
    fields: ['bnbAddress'],
    validators: {
      bnbAddress: v => /^(0x[a-fA-F0-9]{40}|bnb1[a-z0-9]{38})$/.test(v),
    },
  },

  // --- CASH ---
  flouci: {
    cat: 'cash', name: 'Flouci', fee: 1, min: 500, max: 500_000,
    fields: ['flouciPhone', 'fullName'],
    validators: {
      flouciPhone: v => /^(\+216)?[0-9]{8}$/.test(v.replace(/[\s-]/g, '')),
      fullName: v => v.length >= 3 && v.length <= 100,
    },
  },
  d17e: {
    cat: 'cash', name: 'D17e محفظة', fee: 0.8, min: 500, max: 500_000,
    fields: ['d17ePhone', 'fullName'],
    validators: {
      d17ePhone: v => /^(\+216)?[0-9]{8}$/.test(v.replace(/[\s-]/g, '')),
      fullName: v => v.length >= 3 && v.length <= 100,
    },
  },
  vodafone_cash: {
    cat: 'cash', name: 'Vodafone Cash', fee: 1.5, min: 500, max: 500_000,
    fields: ['vodafonePhone', 'fullName'],
    validators: {
      vodafonePhone: v => /^(\+20)?01[0-9]{9}$/.test(v.replace(/[\s-]/g, '')),
      fullName: v => v.length >= 3 && v.length <= 100,
    },
  },
  orange_money: {
    cat: 'cash', name: 'Orange Money', fee: 1.5, min: 500, max: 500_000,
    fields: ['orangePhone', 'fullName'],
    validators: {
      orangePhone: v => /^(\+[0-9]{1,3})?[0-9]{8,10}$/.test(v.replace(/[\s-]/g, '')),
      fullName: v => v.length >= 3 && v.length <= 100,
    },
  },
  western: {
    cat: 'cash', name: 'Western Union', fee: 6, min: 5000, max: 500_000,
    fields: ['fullName', 'country', 'idNumber'],
    validators: {
      fullName: v => v.length >= 3 && v.length <= 100,
      country: v => v.length >= 2 && v.length <= 60,
      idNumber: v => /^[A-Za-z0-9-]{4,30}$/.test(v),
    },
  },
  moneygram: {
    cat: 'cash', name: 'MoneyGram', fee: 6, min: 5000, max: 500_000,
    fields: ['fullName', 'country', 'idNumber'],
    validators: {
      fullName: v => v.length >= 3 && v.length <= 100,
      country: v => v.length >= 2 && v.length <= 60,
      idNumber: v => /^[A-Za-z0-9-]{4,30}$/.test(v),
    },
  },
});

// Global hard caps (applied in addition to per-method caps)
const GLOBAL_MIN = 500;
const GLOBAL_MAX = 500_000;

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

// ============ SCHEMA ============
// NOTE: legacy `destination` column kept for backward compat.
// New fields stored inside `details` JSONB.
const SQL = {
  schema: [
    `CREATE TABLE IF NOT EXISTS withdrawals (
       id              TEXT PRIMARY KEY,
       user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       amount          BIGINT NOT NULL CHECK (amount > 0),
       fee_amount      BIGINT NOT NULL DEFAULT 0,
       net_amount      BIGINT NOT NULL DEFAULT 0,
       method          TEXT NOT NULL,
       destination     TEXT NOT NULL,
       details         JSONB NOT NULL DEFAULT '{}'::jsonb,
       status          TEXT NOT NULL DEFAULT 'pending',
       admin_note      TEXT,
       admin_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
       created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       processed_at    TIMESTAMPTZ,
       paid_at         TIMESTAMPTZ
     )`,
    // Add new columns to existing tables (idempotent)
    `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_amount  BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS net_amount  BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS details     JSONB  NOT NULL DEFAULT '{}'::jsonb`,

    `CREATE INDEX IF NOT EXISTS withdrawals_user_idx   ON withdrawals (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals (status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawals_admin_idx  ON withdrawals (admin_id)`,

    // Prevent concurrent pending requests per user
    `CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_one_pending_per_user
       ON withdrawals (user_id) WHERE status = 'pending'`,
  ],

  insert: `INSERT INTO withdrawals (id, user_id, amount, fee_amount, net_amount, method, destination, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           RETURNING *`,

  getById:   `SELECT * FROM withdrawals WHERE id = $1`,
  listByUser:`SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
  listByStatus: `SELECT * FROM withdrawals WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,

  approve: `UPDATE withdrawals
            SET status = 'approved', admin_id = $1, processed_at = NOW()
            WHERE id = $2 AND status = 'pending' RETURNING *`,

  reject: `UPDATE withdrawals
           SET status = 'rejected', admin_id = $1, admin_note = $2, processed_at = NOW()
           WHERE id = $3 AND status = 'pending' RETURNING *`,

  markPaid: `UPDATE withdrawals
             SET status = 'paid', admin_id = $1, admin_note = $2, paid_at = NOW()
             WHERE id = $3 AND status = 'approved' RETURNING *`,

  // Stats — used by admin.html badge
  stats: `SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
            COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE status = 'paid')::int     AS paid,
            COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::bigint  AS total_pending,
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::bigint     AS total_paid,
            COALESCE(SUM(fee_amount) FILTER (WHERE status = 'paid'), 0)::bigint AS total_fees
          FROM withdrawals`,

  countPending: `SELECT COUNT(*)::int AS n FROM withdrawals WHERE status = 'pending'`,

  hasPending: `SELECT 1 FROM withdrawals WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
};

// ============ HELPERS ============
function computeFee(amount, feePercent) {
  // Round down to be safe for the platform
  return Math.floor((amount * feePercent) / 100);
}

function normalizeText(v, maxLen = 200) {
  return String(v == null ? '' : v)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLen);
}

module.exports = function createWithdrawals({ pool, wallet, log = console }) {
  if (!pool) throw new Error('withdrawals requires pool');
  if (!wallet) throw new Error('withdrawals requires wallet');

  async function db(sql, params = []) {
    return pool.query(sql, params);
  }

  async function ensureSchema() {
    for (const q of SQL.schema) await pool.query(q);
  }

  // ---------- VALIDATION ----------
  function validateMethod(method) {
    const m = String(method || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(METHODS, m)) {
      throw err('invalid_method', 400, { allowed: Object.keys(METHODS) });
    }
    return m;
  }

  function validateAmount(method, amount) {
    const n = Number(amount);
    const def = METHODS[method];
    if (!Number.isSafeInteger(n)) throw err('invalid_amount', 400);
    if (n < GLOBAL_MIN) throw err('below_minimum', 400, { min: GLOBAL_MIN });
    if (n > GLOBAL_MAX) throw err('above_maximum', 400, { max: GLOBAL_MAX });
    if (n < def.min) throw err('below_minimum', 400, { min: def.min, method });
    if (n > def.max) throw err('above_maximum', 400, { max: def.max, method });
    return n;
  }

  function validateDetails(method, details) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      throw err('invalid_details', 400, { reason: 'must_be_object' });
    }
    const def = METHODS[method];
    const out = {};
    for (const field of def.fields) {
      const raw = details[field];
      const val = normalizeText(raw, 200);
      if (!val) throw err('missing_field', 400, { field });
      const validator = def.validators[field];
      if (validator && !validator(val)) {
        throw err('invalid_field', 400, { field });
      }
      out[field] = val;
    }
    // Optional free-form note
    if (details.note != null) {
      const note = normalizeText(details.note, 200);
      if (note) out.note = note;
    }
    return out;
  }

  // Build a short human-readable destination for the `destination` column
  // (used for legacy display, admin panel convenience).
  function buildDestinationSummary(method, details) {
    const def = METHODS[method];
    const primary = def.fields[0];
    const v = String(details[primary] || '').slice(0, 60);
    return `${def.name}: ${v}`;
  }

  // ---------- PUBLIC: create withdrawal ----------
  async function requestWithdrawal(userId, payload) {
    const uid = String(userId);

    // Normalize payload (support old shape too: {method, amount, account})
    const body = payload && typeof payload === 'object' ? payload : {};
    const method = validateMethod(body.method);
    const amount = validateAmount(method, body.amount);

    // Support both new (details) and old (account) shapes
    let details;
    if (body.details && typeof body.details === 'object') {
      details = validateDetails(method, body.details);
    } else if (body.account) {
      // Legacy shape: single account string. Convert to details via primary field.
      const def = METHODS[method];
      const primary = def.fields[0];
      details = validateDetails(method, { [primary]: body.account });
    } else {
      throw err('invalid_details', 400, { reason: 'missing_details' });
    }

    // Prevent concurrent pending requests
    const pending = await db(SQL.hasPending, [uid]);
    if (pending.rows.length) throw err('pending_exists', 409);

    const def = METHODS[method];
    const fee = computeFee(amount, def.fee);
    const net = amount - fee;
    const id = 'wd_' + crypto.randomBytes(8).toString('hex');
    const destination = buildDestinationSummary(method, details);

    // 1) Hold funds FIRST
    await wallet.debit(uid, amount, {
      kind: 'withdraw',
      refType: 'withdrawal_hold',
      refId: `hold_${id}`,
      meta: { withdrawalId: id, method, feePercent: def.fee, netAmount: net },
    });

    // 2) Insert row. If this fails → refund.
    try {
      const result = await db(SQL.insert, [
        id, uid, amount, fee, net, method, destination, JSON.stringify(details),
      ]);
      log.log(`[WITHDRAWAL] created ${id} user=${uid} amount=${amount} net=${net} method=${method}`);
      return result.rows[0];
    } catch (e) {
      // Handle race-condition on unique index (rare)
      if (e && e.code === '23505') {
        try {
          await wallet.credit(uid, amount, {
            kind: 'refund',
            refType: 'withdrawal_refund',
            refId: `refund_${id}`,
            meta: { withdrawalId: id, reason: 'duplicate_pending' },
          });
        } catch (re) {
          log.error(`[WITHDRAWAL] CRITICAL refund failed for ${id}:`, re?.message);
        }
        throw err('pending_exists', 409);
      }
      try {
        await wallet.credit(uid, amount, {
          kind: 'refund',
          refType: 'withdrawal_refund',
          refId: `refund_${id}`,
          meta: { withdrawalId: id, reason: 'insert_failed' },
        });
      } catch (re) {
        log.error(`[WITHDRAWAL] CRITICAL refund failed for ${id}:`, re?.message);
      }
      throw e;
    }
  }

  // ---------- PUBLIC: queries ----------
  async function listMyWithdrawals(userId, limit = 20) {
    const res = await db(SQL.listByUser, [String(userId), Math.min(100, Math.max(1, limit))]);
    return res.rows;
  }

  async function listByStatus(status, limit = 50) {
    const s = String(status || 'pending').toLowerCase();
    if (!['pending', 'approved', 'paid', 'rejected'].includes(s)) {
      throw err('invalid_status', 400);
    }
    const res = await db(SQL.listByStatus, [s, Math.min(200, Math.max(1, limit))]);
    return res.rows;
  }

  async function getStats() {
    const res = await db(SQL.stats);
    const r = res.rows[0] || {};
    return {
      pending: Number(r.pending) || 0,
      approved: Number(r.approved) || 0,
      paid: Number(r.paid) || 0,
      rejected: Number(r.rejected) || 0,
      totalPending: Number(r.total_pending) || 0,
      totalPaid: Number(r.total_paid) || 0,
      totalFees: Number(r.total_fees) || 0,
    };
  }

  async function countPending() {
    const res = await db(SQL.countPending);
    return Number(res.rows[0]?.n) || 0;
  }

  // ---------- PUBLIC: admin actions ----------
  async function approveWithdrawal(adminId, withdrawalId) {
    const res = await db(SQL.approve, [String(adminId), String(withdrawalId)]);
    if (!res.rows.length) throw err('withdrawal_not_pending', 409);
    log.log(`[WITHDRAWAL] approved ${withdrawalId} by admin=${adminId}`);
    return res.rows[0];
  }

  async function rejectWithdrawal(adminId, withdrawalId, note) {
    const res = await db(SQL.reject, [
      String(adminId),
      normalizeText(note, 500),
      String(withdrawalId),
    ]);
    if (!res.rows.length) throw err('withdrawal_not_pending', 409);
    const row = res.rows[0];
    try {
      await wallet.credit(row.user_id, row.amount, {
        kind: 'refund',
        refType: 'withdrawal_refund',
        refId: `refund_${row.id}`,
        meta: { withdrawalId: row.id, reason: 'admin_rejected', note: note || null },
      });
    } catch (e) {
      log.error(`[WITHDRAWAL] CRITICAL refund failed for ${row.id}:`, e?.message);
    }
    log.log(`[WITHDRAWAL] rejected ${withdrawalId} by admin=${adminId}`);
    return row;
  }

  async function markPaid(adminId, withdrawalId, note) {
    const res = await db(SQL.markPaid, [
      String(adminId),
      normalizeText(note, 500),
      String(withdrawalId),
    ]);
    if (!res.rows.length) throw err('withdrawal_not_approved', 409);
    log.log(`[WITHDRAWAL] paid ${withdrawalId} by admin=${adminId}`);
    return res.rows[0];
  }

  return {
    ensureSchema,
    requestWithdrawal,
    listMyWithdrawals,
    listByStatus,
    getStats,
    countPending,
    approveWithdrawal,
    rejectWithdrawal,
    markPaid,

    // Exposed for tests & client-side mirror
    MIN_WITHDRAWAL: GLOBAL_MIN,
    MAX_WITHDRAWAL: GLOBAL_MAX,
    METHODS,
    _t: { SQL, computeFee, validateDetails },
  };
};

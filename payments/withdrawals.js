'use strict';

// ============================================================================
// payments/withdrawals.js — Withdrawal requests (manual admin approval).
// ============================================================================
// Flow (Method A — debit on request):
//   1. Player requests → wallet.debit (hold) + row created (status='pending').
//   2. Admin approves → status='approved' (no money change).
//   3. Admin rejects → wallet.credit (refund) + status='rejected'.
//   4. Admin marks paid → status='paid' (no money change).
// ============================================================================

const crypto = require('crypto');

const MIN_WITHDRAWAL = 1000;
const MAX_WITHDRAWAL = 1_000_000;
const ALLOWED_METHODS = new Set(['iban', 'bank_card', 'other']);

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

const SQL = {
  schema: [
    `CREATE TABLE IF NOT EXISTS withdrawals (
       id              TEXT PRIMARY KEY,
       user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       amount          BIGINT NOT NULL CHECK (amount > 0),
       method          TEXT NOT NULL,
       destination     TEXT NOT NULL,
       status          TEXT NOT NULL DEFAULT 'pending',
       admin_note      TEXT,
       admin_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
       created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       processed_at    TIMESTAMPTZ,
       paid_at         TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS withdrawals_user_idx   ON withdrawals (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals (status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawals_admin_idx  ON withdrawals (admin_id)`
  ],

  insert: `INSERT INTO withdrawals (id, user_id, amount, method, destination)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
  getById: `SELECT * FROM withdrawals WHERE id = $1`,
  listByUser: `SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
  listByStatus: `SELECT * FROM withdrawals WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,

  approve: `UPDATE withdrawals
            SET status = 'approved', admin_id = $1, processed_at = NOW()
            WHERE id = $2 AND status = 'pending' RETURNING *`,

  reject: `UPDATE withdrawals
           SET status = 'rejected', admin_id = $1, admin_note = $2, processed_at = NOW()
           WHERE id = $3 AND status = 'pending' RETURNING *`,

  markPaid: `UPDATE withdrawals
             SET status = 'paid', admin_id = $1, admin_note = $2, paid_at = NOW()
             WHERE id = $3 AND status = 'approved' RETURNING *`
};

module.exports = function createWithdrawals({ pool, wallet, log = console }) {
  if (!pool) throw new Error('withdrawals requires pool');
  if (!wallet) throw new Error('withdrawals requires wallet');

  async function db(sql, params = []) {
    return pool.query(sql, params);
  }

  async function ensureSchema() {
    for (const q of SQL.schema) await pool.query(q);
  }

  function validateMethod(method) {
    const m = String(method || '').trim().toLowerCase();
    if (!ALLOWED_METHODS.has(m)) throw err('invalid_method', 400, { allowed: [...ALLOWED_METHODS] });
    return m;
  }

  function validateDestination(method, destination) {
    const d = String(destination || '').trim();
    if (method === 'iban') {
      const clean = d.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) throw err('invalid_iban', 400);
      return clean;
    }
    if (method === 'bank_card') {
      const digits = d.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) throw err('invalid_card', 400);
      return digits;
    }
    if (d.length < 3 || d.length > 200) throw err('invalid_destination', 400);
    return d;
  }

  function validateAmount(amount) {
    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n < MIN_WITHDRAWAL || n > MAX_WITHDRAWAL) {
      throw err('invalid_amount', 400, { min: MIN_WITHDRAWAL, max: MAX_WITHDRAWAL, got: amount });
    }
    return n;
  }

  async function requestWithdrawal(userId, amount, method, destination) {
    const uid = String(userId);
    const amt = validateAmount(amount);
    const m = validateMethod(method);
    const dest = validateDestination(m, destination);
    const id = 'wd_' + crypto.randomBytes(8).toString('hex');

    // 1) Hold funds FIRST (debit). If this fails → nothing is created.
    await wallet.debit(uid, amt, {
      kind: 'withdraw',
      refType: 'withdrawal_hold',
      refId: `hold_${id}`,
      meta: { withdrawalId: id, method: m },
    });

    // 2) Create the withdrawal record. If this fails → refund.
    try {
      const result = await db(SQL.insert, [id, uid, amt, m, dest]);
      log.log(`[WITHDRAWAL] created ${id} user=${uid} amount=${amt} method=${m}`);
      return result.rows[0];
    } catch (e) {
      try {
        await wallet.credit(uid, amt, {
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

  async function listMyWithdrawals(userId, limit = 20) {
    const res = await db(SQL.listByUser, [String(userId), Math.min(100, Math.max(1, limit))]);
    return res.rows;
  }

  async function listByStatus(status, limit = 50) {
    const res = await db(SQL.listByStatus, [String(status), Math.min(200, Math.max(1, limit))]);
    return res.rows;
  }

  async function approveWithdrawal(adminId, withdrawalId) {
    const res = await db(SQL.approve, [String(adminId), String(withdrawalId)]);
    if (!res.rows.length) throw err('withdrawal_not_pending', 409);
    log.log(`[WITHDRAWAL] approved ${withdrawalId} by admin=${adminId}`);
    return res.rows[0];
  }

  async function rejectWithdrawal(adminId, withdrawalId, note) {
    const res = await db(SQL.reject, [String(adminId), String(note || '').slice(0, 500), String(withdrawalId)]);
    if (!res.rows.length) throw err('withdrawal_not_pending', 409);
    const row = res.rows[0];
    // Refund the held funds.
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
    const res = await db(SQL.markPaid, [String(adminId), String(note || '').slice(0, 500), String(withdrawalId)]);
    if (!res.rows.length) throw err('withdrawal_not_approved', 409);
    log.log(`[WITHDRAWAL] paid ${withdrawalId} by admin=${adminId}`);
    return res.rows[0];
  }

  return {
    ensureSchema,
    requestWithdrawal,
    listMyWithdrawals,
    listByStatus,
    approveWithdrawal,
    rejectWithdrawal,
    markPaid,
    MIN_WITHDRAWAL,
    MAX_WITHDRAWAL,
    ALLOWED_METHODS,
    _t: { SQL }
  };
};

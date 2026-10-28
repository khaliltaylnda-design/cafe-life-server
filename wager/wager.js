'use strict';

// ============================================================================
// wager/wager.js — Cafe Life Wager System (clean rewrite).
// ============================================================================
// State machine:
//     pending → active → (won_a | won_b | draw | cancelled)
//
// المسؤوليات:
//   1. إنشاء wager (hold من A).
//   2. قبول wager (hold من B، تفعيل).
//   3. إلغاء wager (refund إلى A).
//   4. تسوية wager (payout للفائز أو refund draw).
//   5. إدارة retries عند فشل refund/payout.
//   6. cleanup للمعلقة القديمة.
//
// الضمانات:
//   - كل transition ذري (single UPDATE ... RETURNING).
//   - كل حركة مالية عبر wallet.credit/debit (لا direct SQL على coins).
//   - كل retry له refId فريد → لا no-op صامت.
//   - idempotent: يمكن إعادة المحاولة بأمان.
// ============================================================================

const crypto = require('crypto');

// ============================================================================
// 1. CONSTANTS
// ============================================================================
const MIN_WAGER = 300;
const MAX_WAGER = 100_000;
const PENDING_STALE_MIN = 10;
const ACTIVE_EXPIRY_HOURS = 24;

const MAX_RETRY_ATTEMPTS = 5;       // بعدها status='dead' (يحتاج تدخل يدوي)
const RETRY_BATCH_SIZE = 50;

const KIND = {
  hold: 'wager_hold',
  win: 'wager_win',
  refund: 'wager_refund',
  void: 'wager_void',
};

// ============================================================================
// 2. HELPERS
// ============================================================================
const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

function isValidAmount(amount) {
  return Number.isSafeInteger(amount) && amount >= MIN_WAGER && amount <= MAX_WAGER;
}

function makeWagerId() {
  return 'wg_' + crypto.randomBytes(8).toString('hex');
}

// ============================================================================
// 3. SQL
// ============================================================================
const SQL = {
  // ---- Schema ----
  schemaTables: [
    `CREATE TABLE IF NOT EXISTS wagers (
       id             TEXT PRIMARY KEY,
       game_type      TEXT NOT NULL,
       room_id        TEXT NOT NULL,
       player_a_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       player_b_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
       amount         BIGINT NOT NULL CHECK (amount > 0),
       status         TEXT NOT NULL DEFAULT 'pending',
       winner_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
       created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       started_at     TIMESTAMPTZ,
       ended_at       TIMESTAMPTZ,
       settlement_id  TEXT,
       CHECK (status IN ('pending','active','won_a','won_b','draw','cancelled'))
     )`,

    `CREATE TABLE IF NOT EXISTS wager_refund_retries (
       wager_id     TEXT NOT NULL,
       role         TEXT NOT NULL,
       user_id      BIGINT NOT NULL,
       amount       BIGINT NOT NULL,
       reason       TEXT NOT NULL,
       attempts     INT NOT NULL DEFAULT 1,
       status       TEXT NOT NULL DEFAULT 'pending',
       last_error   TEXT,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       last_try     TIMESTAMPTZ,
       PRIMARY KEY (wager_id, role),
       CHECK (status IN ('pending','done','dead'))
     )`,

    `CREATE TABLE IF NOT EXISTS wager_payout_retries (
       wager_id     TEXT PRIMARY KEY,
       winner_id    BIGINT NOT NULL,
       amount       BIGINT NOT NULL,
       attempts     INT NOT NULL DEFAULT 1,
       status       TEXT NOT NULL DEFAULT 'pending',
       last_error   TEXT,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       last_try     TIMESTAMPTZ,
       CHECK (status IN ('pending','done','dead'))
     )`,
  ],

  schemaColumns: [
    `ALTER TABLE wagers ADD COLUMN IF NOT EXISTS settlement_id TEXT`,
    `ALTER TABLE wager_refund_retries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE wager_refund_retries ADD COLUMN IF NOT EXISTS last_error TEXT`,
    `ALTER TABLE wager_payout_retries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE wager_payout_retries ADD COLUMN IF NOT EXISTS last_error TEXT`,
  ],

  schemaIndexes: [
    `CREATE INDEX IF NOT EXISTS wagers_room_idx ON wagers (game_type, room_id)`,
    `CREATE INDEX IF NOT EXISTS wagers_status_idx ON wagers (status)`,
    `CREATE INDEX IF NOT EXISTS wagers_players_idx ON wagers (player_a_id, player_b_id)`,
    `CREATE INDEX IF NOT EXISTS wagers_created_idx ON wagers (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS refund_retries_status_idx ON wager_refund_retries (status, created_at)`,
    `CREATE INDEX IF NOT EXISTS payout_retries_status_idx ON wager_payout_retries (status, created_at)`,
  ],

  // Unique live wager per room — created separately (may fail if duplicates exist)
  schemaUniqueIndex: `
    CREATE UNIQUE INDEX IF NOT EXISTS wagers_one_live_per_room
    ON wagers (game_type, room_id)
    WHERE status IN ('pending', 'active')`,

  // ---- Queries ----
  insertWager: `
    INSERT INTO wagers (id, game_type, room_id, player_a_id, amount, status)
    VALUES ($1, $2, $3, $4, $5, 'pending')
    RETURNING *`,

  getWager: `SELECT * FROM wagers WHERE id = $1`,

  getActiveByRoom: `
    SELECT * FROM wagers
    WHERE game_type = $1 AND room_id = $2
      AND status IN ('pending','active')
    ORDER BY created_at DESC LIMIT 1`,

  getActiveByRoomStatus: `
    SELECT * FROM wagers
    WHERE game_type = $1 AND room_id = $2 AND status = 'active'
    ORDER BY started_at DESC LIMIT 1`,

  acceptWager: `
    UPDATE wagers
    SET player_b_id = $1, status = 'active', started_at = NOW()
    WHERE id = $2 AND status = 'pending' AND player_a_id <> $1
    RETURNING *`,

  cancelByOwner: `
    UPDATE wagers
    SET status = 'cancelled', ended_at = NOW()
    WHERE id = $1 AND status = 'pending' AND player_a_id = $2
    RETURNING *`,

  cancelById: `
    UPDATE wagers
    SET status = 'cancelled', ended_at = NOW()
    WHERE id = $1 AND status = 'pending'
    RETURNING *`,

  settleById: `
    UPDATE wagers
    SET status = $1, winner_id = $2, ended_at = NOW(), settlement_id = $4
    WHERE id = $3 AND status = 'active'
    RETURNING *`,

  findStalePending: `
    SELECT * FROM wagers
    WHERE status = 'pending'
      AND created_at < NOW() - ($1::int * INTERVAL '1 minute')`,

  findExpiredActive: `
    SELECT * FROM wagers
    WHERE status = 'active' AND started_at IS NOT NULL
      AND started_at < NOW() - ($1::int * INTERVAL '1 hour')`,

  findPendingByPlayer: `
    SELECT * FROM wagers
    WHERE status = 'pending'
      AND (player_a_id = $1 OR player_b_id = $1)
    ORDER BY created_at ASC
    LIMIT $2`,

  findByPlayer: `
    SELECT * FROM wagers
    WHERE player_a_id = $1 OR player_b_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3`,

  countByPlayer: `
    SELECT COUNT(*)::int AS n FROM wagers
    WHERE player_a_id = $1 OR player_b_id = $1`,

  // ---- Retry tables ----
  insertRefundRetry: `
    INSERT INTO wager_refund_retries
      (wager_id, role, user_id, amount, reason, attempts, status, last_try)
    VALUES ($1, $2, $3, $4, $5, 1, 'pending', NOW())
    ON CONFLICT (wager_id, role) DO UPDATE SET
      attempts = wager_refund_retries.attempts + 1,
      status = 'pending',
      last_error = NULL,
      last_try = NOW()`,
  deleteRefundRetry: `DELETE FROM wager_refund_retries WHERE wager_id=$1 AND role=$2`,
  markRefundRetryDone: `UPDATE wager_refund_retries SET status='done' WHERE wager_id=$1 AND role=$2`,
  markRefundRetryDead: `
    UPDATE wager_refund_retries
    SET status='dead', last_error=$3
    WHERE wager_id=$1 AND role=$2`,
  selectRefundRetries: `
    SELECT * FROM wager_refund_retries
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT $1`,

  insertPayoutRetry: `
    INSERT INTO wager_payout_retries
      (wager_id, winner_id, amount, attempts, status, last_try)
    VALUES ($1, $2, $3, 1, 'pending', NOW())
    ON CONFLICT (wager_id) DO UPDATE SET
      attempts = wager_payout_retries.attempts + 1,
      status = 'pending',
      last_error = NULL,
      last_try = NOW()`,
  deletePayoutRetry: `DELETE FROM wager_payout_retries WHERE wager_id=$1`,
  markPayoutRetryDone: `UPDATE wager_payout_retries SET status='done' WHERE wager_id=$1`,
  markPayoutRetryDead: `
    UPDATE wager_payout_retries
    SET status='dead', last_error=$2
    WHERE wager_id=$1`,
  selectPayoutRetries: `
    SELECT * FROM wager_payout_retries
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT $1`,

  stats: `
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active,
      COUNT(*) FILTER (WHERE status IN ('won_a','won_b','draw'))::int AS settled,
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','active')), 0)::text AS held
    FROM wagers`,
};

// ============================================================================
// 4. FACTORY
// ============================================================================
module.exports = function createWager({ pool, wallet, log = console } = {}) {
  if (!pool) throw new Error('wager requires pool');
  if (!wallet) throw new Error('wager requires wallet');

  // ==========================================================================
  // 4a. Schema
  // ==========================================================================
  async function ensureSchema({ skipLiveIndex = false } = {}) {
    const phases = [
      { name: 'tables', queries: SQL.schemaTables },
      { name: 'columns', queries: SQL.schemaColumns },
      { name: 'indexes', queries: SQL.schemaIndexes },
    ];

    for (const phase of phases) {
      for (const q of phase.queries) {
        try {
          await pool.query(q);
        } catch (e) {
          if (e.code === '42P07' || e.code === '42710') continue;
          throw e;
        }
      }
    }

    if (!skipLiveIndex) {
      try {
        await pool.query(SQL.schemaUniqueIndex);
      } catch (e) {
        if (e.code === '23505') {
          log.error(
            '[WAGER] Unique index creation FAILED — duplicate live wagers exist. ' +
            'Run cleanupStaleWagers() then retry. Continuing without index.'
          );
        } else if (e.code !== '42P07' && e.code !== '42710') {
          throw e;
        }
      }
    }
  }

  // ==========================================================================
  // 4b. Helpers
  // ==========================================================================
  async function readBalance(userId) {
    const balance = await wallet.getBalance(userId);
    if (balance === null) throw err('user_not_found', 404);
    return balance;
  }

  // Build a retry-safe refId: includes attempt count so wallet sees a new
  // refId on each retry → the movement is actually applied.
  function refundRefId(wagerId, role, attempt) {
    const suffix = attempt > 1 ? `_r${attempt}` : '';
    return `refund_${wagerId}${role ? '_' + role : ''}${suffix}`;
  }

  function payoutRefId(wagerId, attempt) {
    const suffix = attempt > 1 ? `_r${attempt}` : '';
    return `win_${wagerId}${suffix}`;
  }

  // ==========================================================================
  // 4c. Refund / Payout (with retry tracking)
  // ==========================================================================
  async function safeRefund(userId, amount, wagerId, reason, role, attempt = 1) {
    if (userId == null) return { ok: false, skipped: true };

    const refId = refundRefId(wagerId, role, attempt);

    try {
      const result = await wallet.credit(userId, amount, {
        kind: KIND.refund,
        refType: 'wager_refund',
        refId,
        meta: {
          wagerId,
          reason,
          role: role || null,
          attempt,
        },
      });

      // Clear retry row on success (or duplicate = already applied).
      if (result.applied || result.duplicate) {
        await pool.query(SQL.deleteRefundRetry, [wagerId, role || '']).catch(() => {});
        if (result.duplicate) {
          log.log(`[WAGER] refund ${wagerId}/${role} already applied (attempt=${attempt})`);
        }
        return { ok: true, applied: result.applied, duplicate: result.duplicate };
      }

      // Should not happen, but defensive
      return { ok: false };
    } catch (e) {
      log.error(`[WAGER] refund FAILED ${wagerId}/${role} (${reason}) attempt=${attempt}:`, e?.message);

      // Persist for retry
      try {
        await pool.query(SQL.insertRefundRetry, [wagerId, role || '', userId, amount, reason]);
      } catch (re) {
        log.error(`[WAGER] could not persist refund retry:`, re?.message);
      }

      return { ok: false, error: e };
    }
  }

  async function safePayout(winnerId, amount, wagerId, gameType, roomId, attempt = 1) {
    const refId = payoutRefId(wagerId, attempt);

    try {
      const result = await wallet.credit(winnerId, amount, {
        kind: KIND.win,
        refType: 'wager_win',
        refId,
        meta: {
          wagerId,
          role: 'winner',
          gameType,
          roomId,
          attempt,
        },
      });

      if (result.applied || result.duplicate) {
        await pool.query(SQL.deletePayoutRetry, [wagerId]).catch(() => {});
        if (result.duplicate) {
          log.log(`[WAGER] payout ${wagerId} already applied (attempt=${attempt})`);
        }
        return { ok: true, applied: result.applied, duplicate: result.duplicate };
      }

      return { ok: false };
    } catch (e) {
      log.error(`[WAGER] payout FAILED ${wagerId} attempt=${attempt}:`, e?.message);

      try {
        await pool.query(SQL.insertPayoutRetry, [wagerId, winnerId, amount]);
      } catch (re) {
        log.error(`[WAGER] could not persist payout retry:`, re?.message);
      }

      return { ok: false, error: e };
    }
  }

  // ==========================================================================
  // 4d. Reads
  // ==========================================================================
  async function getWager(wagerId) {
    if (!wagerId) return null;
    const res = await pool.query(SQL.getWager, [String(wagerId)]);
    return res.rows[0] || null;
  }

  async function getRoomWager(gameType, roomId) {
    const res = await pool.query(SQL.getActiveByRoom, [String(gameType), String(roomId)]);
    return res.rows[0] || null;
  }

  async function listWagersByPlayer(userId, { limit = 20, offset = 0 } = {}) {
    const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const [rows, count] = await Promise.all([
      pool.query(SQL.findByPlayer, [String(userId), n, off]),
      pool.query(SQL.countByPlayer, [String(userId)]),
    ]);
    return {
      items: rows.rows,
      total: count.rows[0]?.n || 0,
      limit: n,
      offset: off,
    };
  }

  async function getStats() {
    const res = await pool.query(SQL.stats);
    return res.rows[0] || null;
  }

  // ==========================================================================
  // 4e. CREATE
  // ==========================================================================
  async function createWager(userId, gameType, roomId, amount) {
    if (!isValidAmount(amount)) {
      throw err('invalid_amount', 400, { min: MIN_WAGER, max: MAX_WAGER, got: amount });
    }

    const balance = await readBalance(userId);
    if (balance < amount) {
      throw err('insufficient_balance', 402, { required: amount, available: balance });
    }

    // Fast path: check active wager existence (unique index is authoritative)
    const existing = await pool.query(SQL.getActiveByRoom, [gameType, roomId]);
    if (existing.rows.length > 0) {
      throw err('room_has_active_wager', 409, {
        existingWagerId: existing.rows[0].id,
        existingStatus: existing.rows[0].status,
      });
    }

    const id = makeWagerId();

    // 1) Hold A's funds
    try {
      await wallet.debit(userId, amount, {
        kind: KIND.hold,
        refType: 'wager_hold',
        refId: `hold_${id}`,
        meta: { wagerId: id, gameType, roomId, role: 'A' },
      });
    } catch (e) {
      if (e?.code === 'insufficient_balance' || e?.message === 'insufficient_balance') {
        throw err('insufficient_balance', 402, {
          required: amount,
          available: e.available != null ? e.available : balance,
        });
      }
      throw e;
    }

    // 2) Insert wager row
    try {
      const result = await pool.query(SQL.insertWager, [id, gameType, roomId, userId, amount]);
      return result.rows[0];
    } catch (e) {
      // Insert failed → refund hold. Retry-safe thanks to unique refId.
      await safeRefund(userId, amount, id, 'insert_failed', 'A').catch(() => {});
      if (e?.code === '23505') throw err('room_has_active_wager', 409);
      throw e;
    }
  }

  // ==========================================================================
  // 4f. ACCEPT
  // ==========================================================================
  async function acceptWager(userId, wagerId) {
    const peek = await pool.query(SQL.getWager, [wagerId]);
    const w = peek.rows[0];
    if (!w) throw err('wager_not_found', 404);

    // Idempotent success: already accepted by this user.
    if (w.status === 'active' && String(w.player_b_id) === String(userId)) {
      return w;
    }
    if (w.status !== 'pending') throw err('wager_not_pending', 409);
    if (String(w.player_a_id) === String(userId)) {
      throw err('cannot_wager_against_self', 400);
    }

    // Debit B (idempotent: if hold already exists, wallet returns duplicate=true)
    try {
      await wallet.debit(userId, w.amount, {
        kind: KIND.hold,
        refType: 'wager_hold',
        refId: `hold_${wagerId}_B`,
        meta: { wagerId, gameType: w.game_type, roomId: w.room_id, role: 'B' },
      });
    } catch (e) {
      if (e?.code === 'insufficient_balance' || e?.message === 'insufficient_balance') {
        throw err('insufficient_balance', 402, {
          required: Number(w.amount),
          available: e.available != null ? e.available : undefined,
        });
      }
      const dup = e?.code === '23505' || /duplicate|unique/i.test(e?.message || '');
      if (!dup) throw e;
      // else: hold already exists for B → continue to transition
    }

    // Atomic transition: pending → active
    let result;
    try {
      result = await pool.query(SQL.acceptWager, [userId, wagerId]);
    } catch (dbErr) {
      await safeRefund(userId, w.amount, wagerId, 'accept_db_failure', 'B');
      throw dbErr;
    }

    if (result.rowCount === 0) {
      // Race: another user accepted first
      const current = await pool.query(SQL.getWager, [wagerId]);
      const curr = current.rows[0];

      if (curr && curr.status === 'active' && String(curr.player_b_id) === String(userId)) {
        // We actually won the race — our debit is valid
        return curr;
      }

      // Lost the race → refund B
      await safeRefund(userId, w.amount, wagerId, 'accept_lost_race', 'B');
      throw err('wager_no_longer_pending', 409);
    }

    return result.rows[0];
  }

  // ==========================================================================
  // 4g. CANCEL
  // ==========================================================================
  async function cancelWager(userId, wagerId) {
    const result = await pool.query(SQL.cancelByOwner, [wagerId, userId]);

    if (result.rowCount === 0) {
      const chk = await pool.query(SQL.getWager, [wagerId]);
      const w = chk.rows[0];
      if (!w) throw err('wager_not_found', 404);
      if (String(w.player_a_id) !== String(userId)) throw err('not_owner', 403);

      // Idempotent: already cancelled by us
      if (w.status === 'cancelled' && String(w.player_a_id) === String(userId)) {
        return { ...w, alreadyCancelled: true };
      }
      throw err('wager_not_pending', 409);
    }

    const cancelled = result.rows[0];
    // Refund A (idempotent — unique refId)
    await safeRefund(cancelled.player_a_id, cancelled.amount, cancelled.id, 'cancelled', 'A');

    return cancelled;
  }

  async function cancelPendingByPlayer(userId, { limit = 50 } = {}) {
    const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    const res = await pool.query(SQL.findPendingByPlayer, [String(userId), cap]);
    let cancelled = 0;

    for (const w of res.rows) {
      try {
        const upd = await pool.query(SQL.cancelById, [w.id]);
        if (upd.rowCount === 0) continue;
        const row = upd.rows[0];
        await safeRefund(row.player_a_id, row.amount, row.id, 'player_disconnected', 'A');
        cancelled++;
      } catch (e) {
        log.error(`[WAGER] cancelPendingByPlayer ${w.id} failed:`, e?.message);
      }
    }
    return cancelled;
  }

  // ==========================================================================
  // 4h. SETTLE
  // ==========================================================================
  async function settleWagerById(wagerId, winnerId) {
    const peek = await pool.query(SQL.getWager, [wagerId]);
    const w = peek.rows[0];
    if (!w) throw err('wager_not_found', 404);

    // Idempotent: already settled
    if (['won_a', 'won_b', 'draw'].includes(w.status)) {
      return { ...w, alreadySettled: true };
    }
    if (w.status !== 'active') {
      throw err('wager_not_active', 409, { status: w.status });
    }

    let targetStatus;
    let finalWinner = null;

    if (!winnerId) {
      targetStatus = 'draw';
    } else {
      if (String(winnerId) !== String(w.player_a_id) &&
          String(winnerId) !== String(w.player_b_id)) {
        throw err('invalid_winner', 400);
      }
      targetStatus = String(winnerId) === String(w.player_a_id) ? 'won_a' : 'won_b';
      finalWinner = winnerId;
    }

    const settlementId = crypto.randomBytes(8).toString('hex');

    const upd = await pool.query(SQL.settleById, [
      targetStatus, finalWinner, wagerId, settlementId,
    ]);

    if (upd.rowCount === 0) {
      // Another process settled concurrently
      const again = await pool.query(SQL.getWager, [wagerId]);
      return { ...(again.rows[0] || w), alreadySettled: true };
    }

    const settled = upd.rows[0];

    if (targetStatus === 'draw') {
      const tasks = [
        safeRefund(settled.player_a_id, settled.amount, settled.id, 'draw', 'A'),
      ];
      if (settled.player_b_id != null) {
        tasks.push(safeRefund(settled.player_b_id, settled.amount, settled.id, 'draw', 'B'));
      }
      await Promise.all(tasks);
    } else {
      const totalPot = Number(settled.amount) * 2;
      await safePayout(finalWinner, totalPot, settled.id, settled.game_type, settled.room_id);
    }

    return settled;
  }

  async function settleWager(gameType, roomId, winnerId) {
    const res = await pool.query(SQL.getActiveByRoomStatus, [gameType, roomId]);
    const w = res.rows[0];
    if (!w) return null;
    return settleWagerById(w.id, winnerId);
  }

  // ==========================================================================
  // 4i. CLEANUP
  // ==========================================================================
  async function cleanupStaleWagers({ olderThanMinutes = PENDING_STALE_MIN } = {}) {
    const mins = Math.max(1, Math.floor(Number(olderThanMinutes) || PENDING_STALE_MIN));
    const res = await pool.query(SQL.findStalePending, [mins]);
    let cleaned = 0;

    for (const w of res.rows) {
      try {
        const upd = await pool.query(SQL.cancelById, [w.id]);
        if (upd.rowCount === 0) continue;
        const row = upd.rows[0];
        await safeRefund(row.player_a_id, row.amount, row.id, 'stale_pending', 'A');
        cleaned++;
      } catch (e) {
        log.error(`[WAGER] cleanupStaleWagers ${w.id} failed:`, e?.message);
      }
    }
    return cleaned;
  }

  async function handleExpiredWagers() {
    try {
      const res = await pool.query(SQL.findExpiredActive, [ACTIVE_EXPIRY_HOURS]);
      let n = 0;
      for (const w of res.rows) {
        try {
          const settled = await settleWagerById(w.id, null);
          if (settled && !settled.alreadySettled) n++;
        } catch (e) {
          log.error(`[WAGER] expire ${w.id} failed:`, e?.message);
        }
      }
      return n;
    } catch (e) {
      log.error('[WAGER] handleExpiredWagers failed:', e?.message);
      return 0;
    }
  }

  // ==========================================================================
  // 4j. RETRY WORKERS
  // ==========================================================================
  async function retryPendingRefunds({ limit = RETRY_BATCH_SIZE } = {}) {
    const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || RETRY_BATCH_SIZE)));
    let ok = 0;

    let rows = [];
    try {
      const res = await pool.query(SQL.selectRefundRetries, [cap]);
      rows = res.rows;
    } catch (e) {
      log.error('[WAGER] selectRefundRetries failed:', e?.message);
      return 0;
    }

    for (const r of rows) {
      const attempt = (Number(r.attempts) || 1);
      if (attempt > MAX_RETRY_ATTEMPTS) {
        await pool.query(SQL.markRefundRetryDead, [
          r.wager_id, r.role, `max_attempts(${MAX_RETRY_ATTEMPTS})`,
        ]).catch(() => {});
        log.error(`[WAGER] refund retry DEAD ${r.wager_id}/${r.role} after ${attempt} attempts`);
        continue;
      }

      // NEW attempt number for refId → forces wallet to apply
      const nextAttempt = attempt;
      const result = await safeRefund(
        r.user_id, Number(r.amount), r.wager_id,
        r.reason + '_retry', r.role, nextAttempt
      );

      if (result.ok) {
        ok++;
      } else if (attempt >= MAX_RETRY_ATTEMPTS) {
        await pool.query(SQL.markRefundRetryDead, [
          r.wager_id, r.role,
          result.error ? String(result.error.message || '').slice(0, 500) : 'unknown',
        ]).catch(() => {});
      }
    }

    return ok;
  }

  async function retryPendingPayouts({ limit = RETRY_BATCH_SIZE } = {}) {
    const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || RETRY_BATCH_SIZE)));
    let ok = 0;

    let rows = [];
    try {
      const res = await pool.query(SQL.selectPayoutRetries, [cap]);
      rows = res.rows;
    } catch (e) {
      log.error('[WAGER] selectPayoutRetries failed:', e?.message);
      return 0;
    }

    for (const r of rows) {
      const attempt = (Number(r.attempts) || 1);
      if (attempt > MAX_RETRY_ATTEMPTS) {
        await pool.query(SQL.markPayoutRetryDead, [
          r.wager_id, `max_attempts(${MAX_RETRY_ATTEMPTS})`,
        ]).catch(() => {});
        log.error(`[WAGER] payout retry DEAD ${r.wager_id} after ${attempt} attempts`);
        continue;
      }

      const nextAttempt = attempt;
      const result = await safePayout(
        r.winner_id, Number(r.amount), r.wager_id,
        null, null, nextAttempt
      );

      if (result.ok) {
        ok++;
      } else if (attempt >= MAX_RETRY_ATTEMPTS) {
        await pool.query(SQL.markPayoutRetryDead, [
          r.wager_id,
          result.error ? String(result.error.message || '').slice(0, 500) : 'unknown',
        ]).catch(() => {});
      }
    }

    return ok;
  }

  // ==========================================================================
  // 4k. PUBLIC API
  // ==========================================================================
  return {
    // Lifecycle
    ensureSchema,

    // Mutations
    createWager,
    acceptWager,
    cancelWager,
    cancelPendingByPlayer,
    settleWager,
    settleWagerById,

    // Reads
    getWager,
    getRoomWager,
    listWagersByPlayer,
    getStats,

    // Maintenance
    cleanupStaleWagers,
    handleExpiredWagers,
    retryPendingRefunds,
    retryPendingPayouts,

    // Constants
    MIN_WAGER,
    MAX_WAGER,

    // Test hooks
    _t: { SQL, KIND, refundRefId, payoutRefId, makeWagerId },
  };
};

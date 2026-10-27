'use strict';

// wager/wager.js — Cafe Life betting system. HARDENED.
// ============================================================================
// Design principles:
//
// 1. STATE MACHINE:
//      pending → active → (won_a | won_b | draw | cancelled)
//
// 2. ONE LIVE WAGER PER ROOM: partial UNIQUE INDEX.
//
// 3. ALL BALANCE CHANGES via wallet.credit/debit with DISTINCT refId:
//        hold:    (wager_hold,   hold_<id>[_B])
//        refund:  (wager_refund, refund_<id>_<role>)
//        payout:  (wager_win,    win_<id>)
//      All idempotent via wallet UNIQUE.
//
// 4. ATOMICITY: single UPDATE ... RETURNING, status pinned in WHERE.
//
// 5. FINANCIAL SAFETY (NEW):
//      - Distinguish (a) UPDATE-not-executed (real failure → refund mandatory)
//        from (b) UPDATE executed but rowCount=0 (race → refund unless we own it).
//      - Every refund/payout failure is recorded in *_retries tables for
//        scheduled recovery. No money is ever silently lost.
// ============================================================================

const crypto = require('crypto');

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

const MIN_WAGER = 300;
const MAX_WAGER = 100000;
const PENDING_STALE_MIN = 10;
const ACTIVE_EXPIRY_HOURS = 24;

const KIND = {
  hold:   'wager_hold',
  win:    'wager_win',
  refund: 'wager_refund',
};

module.exports = function createWager({ pool, wallet, log = console } = {}) {
  if (!pool) throw new Error('wager requires pool');
  if (!wallet) throw new Error('wager requires wallet');

  // =====================================================================
  // SQL
  // =====================================================================
  const SQL = {
    schema: [
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
         ended_at       TIMESTAMPTZ
       )`,
      `CREATE INDEX IF NOT EXISTS wagers_room_idx    ON wagers(game_type, room_id)`,
      `CREATE INDEX IF NOT EXISTS wagers_status_idx  ON wagers(status)`,
      `CREATE INDEX IF NOT EXISTS wagers_players_idx ON wagers(player_a_id, player_b_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS wagers_one_live_per_room
         ON wagers(game_type, room_id)
         WHERE status IN ('pending', 'active')`,

      // Recovery tables (NEW) — ensure no money is ever silently lost.
      `CREATE TABLE IF NOT EXISTS wager_refund_retries (
         wager_id   TEXT NOT NULL,
         role       TEXT NOT NULL,
         user_id    BIGINT NOT NULL,
         amount     BIGINT NOT NULL,
         reason     TEXT NOT NULL,
         attempts   INT NOT NULL DEFAULT 1,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         last_try   TIMESTAMPTZ,
         PRIMARY KEY (wager_id, role)
       )`,
      `CREATE TABLE IF NOT EXISTS wager_payout_retries (
         wager_id   TEXT PRIMARY KEY,
         winner_id  BIGINT NOT NULL,
         amount     BIGINT NOT NULL,
         attempts   INT NOT NULL DEFAULT 1,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         last_try   TIMESTAMPTZ
       )`,
    ],

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
      SET status = $1, winner_id = $2, ended_at = NOW()
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
        AND (player_a_id = $1 OR player_b_id = $1)`,

    findByPlayer: `
      SELECT * FROM wagers
      WHERE player_a_id = $1 OR player_b_id = $1
      ORDER BY created_at DESC LIMIT $2`,

    insertRefundRetry: `
      INSERT INTO wager_refund_retries (wager_id, role, user_id, amount, reason, attempts, last_try)
      VALUES ($1,$2,$3,$4,$5,1,NOW())
      ON CONFLICT (wager_id, role)
      DO UPDATE SET attempts = wager_refund_retries.attempts + 1, last_try = NOW()`,
    deleteRefundRetry: `DELETE FROM wager_refund_retries WHERE wager_id=$1 AND role=$2`,
    selectRefundRetries: `SELECT * FROM wager_refund_retries ORDER BY created_at ASC LIMIT $1`,

    insertPayoutRetry: `
      INSERT INTO wager_payout_retries (wager_id, winner_id, amount, attempts, last_try)
      VALUES ($1,$2,$3,1,NOW())
      ON CONFLICT (wager_id)
      DO UPDATE SET attempts = wager_payout_retries.attempts + 1, last_try = NOW()`,
    deletePayoutRetry: `DELETE FROM wager_payout_retries WHERE wager_id=$1`,
    selectPayoutRetries: `SELECT * FROM wager_payout_retries ORDER BY created_at ASC LIMIT $1`,
  };

  async function ensureSchema() {
    for (const q of SQL.schema) await pool.query(q);
  }

  // =====================================================================
  // Helpers
  // =====================================================================
  async function readBalance(userId) {
    const balance = await wallet.getBalance(userId);
    if (balance === null) throw err('user_not_found', 404);
    return balance;
  }

  // 🔒 Persistent refund: retries tracked in DB, never silently lost.
  async function safeRefund(userId, amount, wagerId, reason, role) {
    if (userId == null) return; // nothing to refund
    try {
      await wallet.credit(userId, amount, {
        kind: KIND.refund,
        refType: 'wager_refund',
        refId: `refund_${wagerId}${role ? '_' + role : ''}`,
        meta: { wagerId, reason, role: role || null },
      });
      // If a previous attempt was queued, clear it.
      await pool.query(SQL.deleteRefundRetry, [wagerId, role || '']).catch(() => {});
      return true;
    } catch (e) {
      log.error(`[WAGER] refund FAILED ${wagerId}/${role} (${reason}):`, e?.message);
      await pool.query(SQL.insertRefundRetry, [
        wagerId, role || '', userId, amount, reason,
      ]).catch(re => log.error(`[WAGER] could not persist refund retry:`, re?.message));
      return false;
    }
  }

  async function safePayout(winnerId, amount, wagerId, gameType, roomId) {
    try {
      await wallet.credit(winnerId, amount, {
        kind: KIND.win,
        refType: 'wager_win',
        refId: `win_${wagerId}`,
        meta: { wagerId, role: 'winner', gameType, roomId },
      });
      await pool.query(SQL.deletePayoutRetry, [wagerId]).catch(() => {});
      return true;
    } catch (e) {
      log.error(`[WAGER] payout FAILED ${wagerId}:`, e?.message);
      await pool.query(SQL.insertPayoutRetry, [wagerId, winnerId, amount])
        .catch(re => log.error(`[WAGER] could not persist payout retry:`, re?.message));
      return false;
    }
  }

  // =====================================================================
  // READ HELPERS
  // =====================================================================
  async function getWager(wagerId) {
    if (!wagerId) return null;
    const res = await pool.query(SQL.getWager, [String(wagerId)]);
    return res.rows[0] || null;
  }

  async function getRoomWager(gameType, roomId) {
    const res = await pool.query(SQL.getActiveByRoom, [String(gameType), String(roomId)]);
    return res.rows[0] || null;
  }

  async function listWagersByPlayer(userId, { limit = 20 } = {}) {
    const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const res = await pool.query(SQL.findByPlayer, [String(userId), n]);
    return res.rows;
  }

  // =====================================================================
  // CREATE
  // =====================================================================
  async function createWager(userId, gameType, roomId, amount) {
    if (!Number.isSafeInteger(amount) || amount < MIN_WAGER || amount > MAX_WAGER) {
      throw err('invalid_amount', 400, { min: MIN_WAGER, max: MAX_WAGER, got: amount });
    }
    const balance = await readBalance(userId);
    if (balance < amount) {
      throw err('insufficient_balance', 402, { required: amount, available: balance });
    }
    const existing = await pool.query(SQL.getActiveByRoom, [gameType, roomId]);
    if (existing.rows.length > 0) {
      throw err('room_has_active_wager', 409, {
        existingWagerId: existing.rows[0].id,
        existingStatus: existing.rows[0].status,
      });
    }

    const id = 'wg_' + crypto.randomBytes(8).toString('hex');

    try {
      await wallet.debit(userId, amount, {
        kind: KIND.hold, refType: 'wager_hold', refId: `hold_${id}`,
        meta: { wagerId: id, gameType, roomId, role: 'A' },
      });
    } catch (e) {
      if (e?.code === 'insufficient_balance' || e?.message === 'insufficient_balance') {
        throw err('insufficient_balance', 402, {
          required: amount, available: e.available != null ? e.available : balance,
        });
      }
      throw e;
    }

    try {
      const result = await pool.query(SQL.insertWager, [id, gameType, roomId, userId, amount]);
      return result.rows[0];
    } catch (e) {
      await safeRefund(userId, amount, id, 'insert_failed', 'A');
      if (e?.code === '23505') throw err('room_has_active_wager', 409);
      throw e;
    }
  }

  // =====================================================================
  // ACCEPT (HARDENED — fixes both double-click AND silent money leak)
  // =====================================================================
  async function acceptWager(userId, wagerId) {
    const peek = await pool.query(SQL.getWager, [wagerId]);
    const w = peek.rows[0];
    if (!w) throw err('wager_not_found', 404);

    // Idempotent success for this user.
    if (w.status === 'active' && String(w.player_b_id) === String(userId)) {
      return w;
    }
    if (w.status !== 'pending') throw err('wager_not_pending', 409);
    if (String(w.player_a_id) === String(userId)) {
      throw err('cannot_wager_against_self', 400);
    }

    // Debit B. If this throws due to unique violation (double-click
    // after a previous successful accept), it means the accept already
    // happened — treat as success, DO NOT refund.
    try {
      await wallet.debit(userId, w.amount, {
        kind: KIND.hold, refType: 'wager_hold', refId: `hold_${wagerId}_B`,
        meta: { wagerId, gameType: w.game_type, roomId: w.room_id, role: 'B' },
      });
    } catch (e) {
      if (e?.code === 'insufficient_balance' || e?.message === 'insufficient_balance') {
        throw err('insufficient_balance', 402, {
          required: Number(w.amount),
          available: e.available != null ? e.available : undefined,
        });
      }
      // Duplicate refId → we already held for this wager. Continue to
      // verify the state below; do not refund.
      const dup = e?.code === '23505' || /duplicate|unique/i.test(e?.message || '');
      if (!dup) throw e;
    }

    // ⚠️ CRITICAL: two distinct failure modes must be handled separately.

    let result;
    try {
      result = await pool.query(SQL.acceptWager, [userId, wagerId]);
    } catch (dbErr) {
      // Mode A: UPDATE did NOT execute → the wager is still pending,
      // funds are held, no state change. We MUST refund.
      await safeRefund(userId, w.amount, wagerId, 'accept_db_failure', 'B');
      throw dbErr;
    }

    // Mode B: UPDATE executed. rowCount=0 means the WHERE failed.
    if (result.rowCount === 0) {
      const current = await pool.query(SQL.getWager, [wagerId]);
      const curr = current.rows[0];

      // B1: Double click / retry — we are already player_b.
      if (curr && curr.status === 'active' && String(curr.player_b_id) === String(userId)) {
        return curr;
      }
      // B2: Lost the race (other player accepted, owner cancelled,
      // wager expired). Funds are held but we are not player_b → refund.
      await safeRefund(userId, w.amount, wagerId, 'accept_lost_race', 'B');
      throw err('wager_no_longer_pending', 409);
    }

    return result.rows[0];
  }

  // =====================================================================
  // CANCEL (owner)
  // =====================================================================
  async function cancelWager(userId, wagerId) {
    const result = await pool.query(SQL.cancelByOwner, [wagerId, userId]);
    if (result.rowCount === 0) {
      const chk = await pool.query(SQL.getWager, [wagerId]);
      const w = chk.rows[0];
      if (!w) throw err('wager_not_found', 404);
      if (String(w.player_a_id) !== String(userId)) throw err('not_owner', 403);
      throw err('wager_not_pending', 409);
    }
    const cancelled = result.rows[0];
    await safeRefund(cancelled.player_a_id, cancelled.amount, cancelled.id, 'cancelled', 'A');
    return cancelled;
  }

  // =====================================================================
  // CANCEL ALL PENDING FOR A PLAYER
  // =====================================================================
  async function cancelPendingByPlayer(userId) {
    const res = await pool.query(SQL.findPendingByPlayer, [String(userId)]);
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

  // =====================================================================
  // SETTLE
  // =====================================================================
  async function settleWagerById(wagerId, winnerId) {
    const peek = await pool.query(SQL.getWager, [wagerId]);
    const w = peek.rows[0];
    if (!w) throw err('wager_not_found', 404);
    if (w.status !== 'active') return null;

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

    const upd = await pool.query(SQL.settleById, [targetStatus, finalWinner, wagerId]);
    if (upd.rowCount === 0) return null;
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

  // =====================================================================
  // CLEANUP
  // =====================================================================
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
          if (settled) n++;
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

  // =====================================================================
  // RETRY WORKERS (NEW) — call these periodically (e.g. every 60s)
  // =====================================================================
  async function retryPendingRefunds({ limit = 50 } = {}) {
    const res = await pool.query(SQL.selectRefundRetries, [limit]);
    let ok = 0;
    for (const r of res.rows) {
      const success = await safeRefund(r.user_id, r.amount, r.wager_id, r.reason + '_retry', r.role);
      if (success) ok++;
    }
    return ok;
  }

  async function retryPendingPayouts({ limit = 50 } = {}) {
    const res = await pool.query(SQL.selectPayoutRetries, [limit]);
    let ok = 0;
    for (const r of res.rows) {
      const success = await safePayout(r.winner_id, r.amount, r.wager_id, null, null);
      if (success) ok++;
    }
    return ok;
  }

  return {
    ensureSchema,
    createWager, acceptWager, cancelWager, cancelPendingByPlayer,
    settleWager, settleWagerById,
    getWager, getRoomWager, listWagersByPlayer,
    cleanupStaleWagers, handleExpiredWagers,
    retryPendingRefunds, retryPendingPayouts,
    MIN_WAGER, MAX_WAGER,
    _t: { SQL, KIND },
  };
};

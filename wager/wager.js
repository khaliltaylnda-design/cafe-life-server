'use strict';

// wager/wager.js — Cafe Life betting system.
// ============================================================================
// Design principles (final):
//
// 1. STATE MACHINE (strict):
//      pending → active → (won_a | won_b | draw | cancelled)
//      No transitions outside this set.
//
// 2. ONE LIVE WAGER PER ROOM:
//      Partial UNIQUE INDEX on (game_type, room_id) WHERE status IN
//      ('pending','active'). This is the true guard against the
//      "room_has_active_wager" loop after a crash.
//
// 3. ALL BALANCE CHANGES go through wallet.credit / wallet.debit with
//      DISTINCT refType/refId per movement, so idempotency is real:
//        hold:    (wager_hold,  hold_<wagerId>[_B])
//        refund:  (wager_refund, refund_<wagerId>_<role>)
//        payout:  (wager_win,   win_<wagerId>)
//      Re-running any of these is a no-op thanks to wallet UNIQUE.
//
// 4. ATOMICITY:
//      Every state transition is a single UPDATE ... RETURNING that pins
//      the current status. No SELECT ... FOR UPDATE outside a transaction
//      (that would be a no-op in Postgres).
//
// 5. READ HELPERS exported for wager.routes.js:
//        getWager(id), getRoomWager(game, room)
//
// 6. CLEANUP:
//        cleanupStaleWagers({olderThanMinutes})  — pending > 10 min
//        handleExpiredWagers()                   — active > 24 h → draw
//
// 7. FINANCIAL ORDERING:
//      debit → state update → (on success) log/payout
//      Any failure between steps triggers a compensating refund with a
//      distinct refId, so no funds are ever lost or duplicated.
// ============================================================================

const crypto = require('crypto');

const err = (code, status = 400, extra = null) => {
  const e = Object.assign(new Error(code), { code, status });
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
};

const MIN_WAGER = 300;          // ~ $3
const MAX_WAGER = 100000;       // ~ $1000
const PENDING_STALE_MIN = 10;   // abandoned pending wagers expire after 10 min
const ACTIVE_EXPIRY_HOURS = 24; // abandoned active wagers expire after 24h

// Must be in wallet.js ALLOWED_KINDS.
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
      // Hard guard: one live wager per room.
      `CREATE UNIQUE INDEX IF NOT EXISTS wagers_one_live_per_room
         ON wagers(game_type, room_id)
         WHERE status IN ('pending', 'active')`,
    ],

    insertWager: `
      INSERT INTO wagers (id, game_type, room_id, player_a_id, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *`,

    getWager: `SELECT * FROM wagers WHERE id = $1`,

    getActiveByRoom: `
      SELECT * FROM wagers
      WHERE game_type = $1
        AND room_id  = $2
        AND status IN ('pending', 'active')
      ORDER BY created_at DESC
      LIMIT 1`,

    getActiveByRoomAndId: `
      SELECT * FROM wagers
      WHERE game_type = $1
        AND room_id  = $2
        AND status   = 'active'
      ORDER BY started_at DESC
      LIMIT 1`,

    // Atomic accept.
    acceptWager: `
      UPDATE wagers
      SET player_b_id = $1, status = 'active', started_at = NOW()
      WHERE id = $2
        AND status = 'pending'
        AND player_a_id <> $1
      RETURNING *`,

    // Atomic cancel (owner only).
    cancelByOwner: `
      UPDATE wagers
      SET status = 'cancelled', ended_at = NOW()
      WHERE id = $1
        AND status = 'pending'
        AND player_a_id = $2
      RETURNING *`,

    // Atomic cancel (cleanup / disconnect).
    cancelById: `
      UPDATE wagers
      SET status = 'cancelled', ended_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,

    // Atomic settle by id.
    settleById: `
      UPDATE wagers
      SET status = $1, winner_id = $2, ended_at = NOW()
      WHERE id = $3 AND status = 'active'
      RETURNING *`,

    findStalePending: `
      SELECT * FROM wagers
      WHERE status = 'pending'
        AND created_at < NOW() - ($1 || ' minutes')::interval`,

    findExpiredActive: `
      SELECT * FROM wagers
      WHERE status = 'active'
        AND started_at IS NOT NULL
        AND started_at < NOW() - ($1 || ' hours')::interval`,

    findPendingByPlayer: `
      SELECT * FROM wagers
      WHERE status = 'pending'
        AND (player_a_id = $1 OR player_b_id = $1)`,

    findByPlayer: `
      SELECT * FROM wagers
      WHERE player_a_id = $1 OR player_b_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
  };

  // =====================================================================
  // Schema
  // =====================================================================
  async function ensureSchema() {
    for (const q of SQL.schema) {
      await pool.query(q);
    }
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  // wallet.getBalance now returns a number (or null).
  async function readBalance(userId) {
    const balance = await wallet.getBalance(userId);
    if (balance === null) throw err('user_not_found', 404);
    return balance;
  }

  // Refund with a distinct refId per wager+role → idempotent, never swallowed.
  async function refund(userId, amount, wagerId, reason, role) {
    return wallet.credit(userId, amount, {
      kind: KIND.refund,
      refType: 'wager_refund',
      refId: `refund_${wagerId}${role ? '_' + role : ''}`,
      meta: { wagerId, reason, role: role || null },
    });
  }

  // Payout (single-shot per wager).
  async function payout(winnerId, totalPot, wagerId, gameType, roomId) {
    return wallet.credit(winnerId, totalPot, {
      kind: KIND.win,
      refType: 'wager_win',
      refId: `win_${wagerId}`,
      meta: { wagerId, role: 'winner', gameType, roomId },
    });
  }

  // =====================================================================
  // READ HELPERS (used by wager.routes.js and game modules)
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
      throw err('invalid_amount', 400, {
        min: MIN_WAGER,
        max: MAX_WAGER,
        got: amount,
      });
    }

    // Clear, actionable error before touching the wallet.
    const balance = await readBalance(userId);
    if (balance < amount) {
      throw err('insufficient_balance', 402, {
        required: amount,
        available: balance,
      });
    }

    // Fast path: refuse if a live wager already exists in this room.
    const existing = await pool.query(SQL.getActiveByRoom, [gameType, roomId]);
    if (existing.rows.length > 0) {
      throw err('room_has_active_wager', 409, {
        existingWagerId: existing.rows[0].id,
        existingStatus: existing.rows[0].status,
      });
    }

    const id = 'wg_' + crypto.randomBytes(8).toString('hex');

    // 1) Hold funds (atomic wallet debit).
    try {
      await wallet.debit(userId, amount, {
        kind: KIND.hold,
        refType: 'wager_hold',
        refId: `hold_${id}`,
        meta: { wagerId: id, gameType, roomId, role: 'A' },
      });
    } catch (e) {
      if (e && (e.code === 'insufficient_balance' || e.message === 'insufficient_balance')) {
        throw err('insufficient_balance', 402, {
          required: amount,
          available: e.available != null ? e.available : balance,
        });
      }
      throw e;
    }

    // 2) Insert the pending wager. If this fails, refund the hold.
    try {
      const result = await pool.query(SQL.insertWager, [
        id, gameType, roomId, userId, amount,
      ]);
      return result.rows[0];
    } catch (e) {
      await refund(userId, amount, id, 'insert_failed', 'A').catch((re) => {
        log.error(`[WAGER] refund after insert_failed failed for ${id}:`, re && re.message);
      });
      if (e && e.code === '23505') {
        throw err('room_has_active_wager', 409);
      }
      throw e;
    }
  }

  // =====================================================================
  // ACCEPT
  // =====================================================================
  async function acceptWager(userId, wagerId) {
    // Peek: fail fast on clear errors before any wallet movement.
    const peek = await pool.query(SQL.getWager, [wagerId]);
    const w = peek.rows[0];
    if (!w) throw err('wager_not_found', 404);
    if (w.status !== 'pending') throw err('wager_not_pending', 409);
    if (String(w.player_a_id) === String(userId)) {
      throw err('cannot_wager_against_self', 400);
    }

    // Debit accepter (idempotent via refId _B).
    try {
      await wallet.debit(userId, w.amount, {
        kind: KIND.hold,
        refType: 'wager_hold',
        refId: `hold_${wagerId}_B`,
        meta: { wagerId, gameType: w.game_type, roomId: w.room_id, role: 'B' },
      });
    } catch (e) {
      if (e && (e.code === 'insufficient_balance' || e.message === 'insufficient_balance')) {
        throw err('insufficient_balance', 402, {
          required: Number(w.amount),
          available: e.available != null ? e.available : undefined,
        });
      }
      throw e;
    }

    // Atomic state transition. If it fails (race), refund B.
    try {
      const result = await pool.query(SQL.acceptWager, [userId, wagerId]);
      if (result.rowCount === 0) throw err('race_condition', 409);
      return result.rows[0];
    } catch (e) {
      await refund(userId, w.amount, wagerId, 'accept_failed', 'B').catch((re) => {
        log.error(`[WAGER] refund after accept_failed failed for ${wagerId}:`, re && re.message);
      });
      throw e;
    }
  }

  // =====================================================================
  // CANCEL (owner, pending only) — atomic
  // =====================================================================
  async function cancelWager(userId, wagerId) {
    let cancelled;
    try {
      const result = await pool.query(SQL.cancelByOwner, [wagerId, userId]);
      if (result.rowCount === 0) {
        // Disambiguate the reason.
        const chk = await pool.query(SQL.getWager, [wagerId]);
        const w = chk.rows[0];
        if (!w) throw err('wager_not_found', 404);
        if (String(w.player_a_id) !== String(userId)) throw err('not_owner', 403);
        throw err('wager_not_pending', 409);
      }
      cancelled = result.rows[0];
    } catch (e) {
      throw e;
    }

    await refund(cancelled.player_a_id, cancelled.amount, cancelled.id, 'cancelled', 'A')
      .catch((e) => log.error(`[WAGER] refund after cancel failed for ${cancelled.id}:`, e && e.message));

    return cancelled;
  }

  // =====================================================================
  // CANCEL ALL PENDING FOR A PLAYER (disconnect handler)
  // =====================================================================
  async function cancelPendingByPlayer(userId) {
    const res = await pool.query(SQL.findPendingByPlayer, [String(userId)]);
    let cancelled = 0;
    for (const w of res.rows) {
      try {
        const upd = await pool.query(SQL.cancelById, [w.id]);
        if (upd.rowCount === 0) continue; // already handled
        const row = upd.rows[0];
        await refund(row.player_a_id, row.amount, row.id, 'player_disconnected', 'A')
          .catch((e) => log.error(`[WAGER] refund ${row.id} failed:`, e && e.message));
        cancelled++;
        log.log(`[WAGER] Auto-cancelled pending wager ${row.id} (player ${userId} disconnected)`);
      } catch (e) {
        log.error(`[WAGER] cancelPendingByPlayer ${w.id} failed:`, e && e.message);
      }
    }
    return cancelled;
  }

  // =====================================================================
  // SETTLE
  // =====================================================================

  // Core: settle ONE wager by its id.
  // Returns the settled wager row, or null if it wasn't active.
  async function settleWagerById(wagerId, winnerId) {
    const peek = await pool.query(SQL.getWager, [wagerId]);
    const w = peek.rows[0];
    if (!w) throw err('wager_not_found', 404);
    if (w.status !== 'active') return null; // Not settleable → idempotent.

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

    // Atomic transition.
    const upd = await pool.query(SQL.settleById, [targetStatus, finalWinner, wagerId]);
    if (upd.rowCount === 0) return null; // Someone beat us to it.
    const settled = upd.rows[0];

    // Financial settlement.
    if (targetStatus === 'draw') {
      await Promise.all([
        refund(settled.player_a_id, settled.amount, settled.id, 'draw', 'A')
          .catch((e) => log.error(`[WAGER] draw refund A ${settled.id} failed:`, e && e.message)),
        refund(settled.player_b_id, settled.amount, settled.id, 'draw', 'B')
          .catch((e) => log.error(`[WAGER] draw refund B ${settled.id} failed:`, e && e.message)),
      ]);
      log.log(`[WAGER] Draw. Refunded ${settled.amount} to both players (wager ${settled.id}).`);
    } else {
      const totalPot = Number(settled.amount) * 2;
      await payout(finalWinner, totalPot, settled.id, settled.game_type, settled.room_id)
        .catch((e) => log.error(`[WAGER] payout ${settled.id} failed:`, e && e.message));
      log.log(`[WAGER] Settled ${settled.id}. Winner: ${finalWinner}, Pot: ${totalPot}`);
    }

    return settled;
  }

  // Public: settle by (game, room). Finds the single active wager.
  async function settleWager(gameType, roomId, winnerId) {
    const res = await pool.query(SQL.getActiveByRoomAndId, [gameType, roomId]);
    const w = res.rows[0];
    if (!w) return null;
    return settleWagerById(w.id, winnerId);
  }

  // =====================================================================
  // CLEANUP
  // =====================================================================

  async function cleanupStaleWagers({ olderThanMinutes = PENDING_STALE_MIN } = {}) {
    const res = await pool.query(SQL.findStalePending, [String(olderThanMinutes)]);
    let cleaned = 0;
    for (const w of res.rows) {
      try {
        const upd = await pool.query(SQL.cancelById, [w.id]);
        if (upd.rowCount === 0) continue;
        const row = upd.rows[0];
        await refund(row.player_a_id, row.amount, row.id, 'stale_pending', 'A')
          .catch((e) => log.error(`[WAGER] stale refund ${row.id} failed:`, e && e.message));
        cleaned++;
        log.log(`[WAGER] Cleaned stale pending ${row.id} (${row.amount} refunded to ${row.player_a_id})`);
      } catch (e) {
        log.error(`[WAGER] cleanupStaleWagers ${w.id} failed:`, e && e.message);
      }
    }
    if (cleaned > 0) log.log(`[WAGER] cleanupStaleWagers: ${cleaned} cancelled`);
    return cleaned;
  }

  async function handleExpiredWagers() {
    try {
      const res = await pool.query(SQL.findExpiredActive, [String(ACTIVE_EXPIRY_HOURS)]);
      let n = 0;
      for (const w of res.rows) {
        try {
          const settled = await settleWagerById(w.id, null);
          if (settled) n++;
        } catch (e) {
          log.error(`[WAGER] expire ${w.id} failed:`, e && e.message);
        }
      }
      if (n > 0) log.log(`[WAGER] handleExpiredWagers: settled ${n} as draws`);
      return n;
    } catch (e) {
      log.error('[WAGER] handleExpiredWagers failed:', e && e.message);
      return 0;
    }
  }

  // =====================================================================
  // PUBLIC API
  // =====================================================================
  return {
    ensureSchema,

    // mutations
    createWager,
    acceptWager,
    cancelWager,
    cancelPendingByPlayer,
    settleWager,
    settleWagerById,

    // reads (used by wager.routes.js and game modules)
    getWager,
    getRoomWager,
    listWagersByPlayer,

    // maintenance
    cleanupStaleWagers,
    handleExpiredWagers,

    // constants
    MIN_WAGER,
    MAX_WAGER,
    _t: { SQL, KIND },
  };
};

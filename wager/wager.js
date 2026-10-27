'use strict';

// wager/wager.js — Cafe Life betting system.
// Handles creating, accepting, cancelling, and settling wagers.
// All balance changes go through wallet.credit / wallet.debit.
//
// Design notes:
// - Wagers are keyed by (game_type, room_id). At most ONE live wager
//   (pending or active) may exist per room — enforced by a partial
//   unique index in the DB.
// - All refunds use a distinct refId (e.g. `refund_<wagerId>`) so the
//   wallet_transactions UNIQUE (user_id, ref_type, ref_id) does NOT
//   silently swallow the refund.
// - Kinds map to wallet.js allowed kinds: game_loss / game_win / refund.
// - Stale pending wagers (>10 min) and expired active wagers (>24h)
//   are cleaned up automatically (startup + periodic job in server.js).

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

// Wallet kinds that wallet.js accepts (do not invent new ones here).
const KIND = {
  hold:   'game_loss',  // money leaves wallet when funds are committed
  win:    'game_win',   // winner receives pot
  refund: 'refund',     // cancelled / draw / failed accept
};

module.exports = function createWager({ pool, wallet, log = console } = {}) {
  if (!pool) throw new Error('wager requires pool');
  if (!wallet) throw new Error('wager requires wallet');

  // ---------------------------------------------------------------------
  // SQL
  // ---------------------------------------------------------------------
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
      `CREATE INDEX IF NOT EXISTS wagers_room_idx   ON wagers(game_type, room_id)`,
      `CREATE INDEX IF NOT EXISTS wagers_status_idx ON wagers(status)`,
      `CREATE INDEX IF NOT EXISTS wagers_players_idx ON wagers(player_a_id, player_b_id)`,
      // ← At most ONE live wager per room. This is the real guard against
      //   the "room_has_active_wager" loop after a crashed session.
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

    getActiveByRoomForUpdate: `
      SELECT * FROM wagers
      WHERE game_type = $1
        AND room_id  = $2
        AND status IN ('pending', 'active')
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,

    // Accept requires the row to still be pending and NOT belong to the accepter.
    acceptWager: `
      UPDATE wagers
      SET player_b_id = $1, status = 'active', started_at = NOW()
      WHERE id = $2
        AND status = 'pending'
        AND player_a_id <> $1
      RETURNING *`,

    cancelWager: `
      UPDATE wagers
      SET status = 'cancelled', ended_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,

    settleWager: `
      UPDATE wagers
      SET status = $1, winner_id = $2, ended_at = NOW()
      WHERE id = $3 AND status = 'active'
      RETURNING *`,

    cancelPendingById: `
      UPDATE wagers
      SET status = 'cancelled', ended_at = NOW()
      WHERE id = $1 AND status = 'pending'
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
  };

  // ---------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------
  async function ensureSchema() {
    for (const q of SQL.schema) {
      await pool.query(q);
    }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  async function readBalance(userId) {
    const raw = await wallet.getBalance(userId);
    if (raw === null) throw err('user_not_found', 404);
    return Number(raw);
  }

  // Refund with a distinct refId so UNIQUE(user_id, ref_type, ref_id)
  // does NOT suppress it. Idempotent per wager+role.
  async function refund(userId, amount, wagerId, reason, role) {
    return wallet.credit(userId, amount, {
      kind: KIND.refund,
      refType: 'wager_refund',
      refId: `refund_${wagerId}${role ? '_' + role : ''}`,
      meta: { wagerId, reason, role: role || null },
    });
  }

  // ---------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------
  async function createWager(userId, gameType, roomId, amount) {
    if (!Number.isSafeInteger(amount) || amount < MIN_WAGER || amount > MAX_WAGER) {
      throw err(`invalid_amount (min ${MIN_WAGER}, max ${MAX_WAGER})`, 400, {
        required: null,
        min: MIN_WAGER,
        max: MAX_WAGER,
      });
    }

    // Early balance check → give the player a clear, actionable error
    // before we touch the wallet.
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
      if (e.code === 'insufficient_balance' || e.message === 'insufficient_balance') {
        throw err('insufficient_balance', 402, { required: amount });
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
      // Unique partial index may fire here under a race. Refund either way.
      await refund(userId, amount, id, 'insert_failed', 'A').catch((re) => {
        log.error(`[WAGER] refund after insert_failed failed for ${id}:`, re.message);
      });
      if (e.code === '23505') {
        throw err('room_has_active_wager', 409);
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // ACCEPT
  // ---------------------------------------------------------------------
  async function acceptWager(userId, wagerId) {
    // 1) Lock the row (FOR UPDATE) inside a short transaction to make sure
    //    no other accepter races us. wallet.debit happens AFTER this lock
    //    is released — see comment below.
    const client = await pool.connect();
    let wager;
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT * FROM wagers WHERE id = $1 FOR UPDATE`,
        [wagerId]
      );
      wager = res.rows[0];
      if (!wager) throw err('wager_not_found', 404);
      if (wager.status !== 'pending') throw err('wager_not_pending', 409);
      if (String(wager.player_a_id) === String(userId)) {
        throw err('cannot_wager_against_self', 400);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
      throw e;
    }
    client.release();

    // 2) Debit player B (atomic).
    try {
      await wallet.debit(userId, wager.amount, {
        kind: KIND.hold,
        refType: 'wager_hold',
        refId: `hold_${wagerId}_B`,
        meta: { wagerId, gameType: wager.game_type, roomId: wager.room_id, role: 'B' },
      });
    } catch (e) {
      if (e.code === 'insufficient_balance' || e.message === 'insufficient_balance') {
        throw err('insufficient_balance', 402, { required: Number(wager.amount) });
      }
      throw e;
    }

    // 3) Atomically mark active. If someone beat us to it, refund B.
    try {
      const result = await pool.query(SQL.acceptWager, [userId, wagerId]);
      if (result.rowCount === 0) throw new Error('race_condition');
      return result.rows[0];
    } catch (e) {
      await refund(userId, wager.amount, wagerId, 'accept_failed', 'B').catch((re) => {
        log.error(`[WAGER] refund after accept_failed failed for ${wagerId}:`, re.message);
      });
      if (e.message === 'race_condition') throw err('race_condition', 409);
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // CANCEL (by owner, pending only)
  // ---------------------------------------------------------------------
  async function cancelWager(userId, wagerId) {
    const res = await pool.query(
      `SELECT * FROM wagers WHERE id = $1 FOR UPDATE`,
      [wagerId]
    );
    const wager = res.rows[0];
    if (!wager) throw err('wager_not_found', 404);
    if (String(wager.player_a_id) !== String(userId)) throw err('not_owner', 403);
    if (wager.status !== 'pending') throw err('wager_not_pending', 409);

    const update = await pool.query(SQL.cancelWager, [wagerId]);
    if (update.rowCount === 0) throw err('cancel_failed', 500);

    // Refund A.
    await refund(wager.player_a_id, wager.amount, wagerId, 'cancelled', 'A').catch((e) => {
      log.error(`[WAGER] refund after cancel failed for ${wagerId}:`, e.message);
    });

    return update.rows[0];
  }

  // ---------------------------------------------------------------------
  // CANCEL ALL PENDING FOR A PLAYER (used by server on socket close)
  // ---------------------------------------------------------------------
  async function cancelPendingByPlayer(userId) {
    const res = await pool.query(SQL.findPendingByPlayer, [userId]);
    let cancelled = 0;
    for (const w of res.rows) {
      try {
        const upd = await pool.query(SQL.cancelPendingById, [w.id]);
        if (upd.rowCount === 0) continue;
        await refund(w.player_a_id, w.amount, w.id, 'player_disconnected', 'A')
          .catch((e) => log.error(`[WAGER] refund ${w.id} failed:`, e.message));
        cancelled++;
        log.log(`[WAGER] Auto-cancelled pending wager ${w.id} (player ${userId} disconnected)`);
      } catch (e) {
        log.error(`[WAGER] cancelPendingByPlayer ${w.id} failed:`, e.message);
      }
    }
    return cancelled;
  }

  // ---------------------------------------------------------------------
  // SETTLE
  // ---------------------------------------------------------------------
  async function settleWager(gameType, roomId, winnerId) {
    // Only ever settle an ACTIVE wager in this room.
    const res = await pool.query(
      `SELECT * FROM wagers
       WHERE game_type = $1 AND room_id = $2 AND status = 'active'
       ORDER BY started_at DESC
       LIMIT 1
       FOR UPDATE`,
      [gameType, roomId]
    );
    const wager = res.rows[0];
    if (!wager) return null;

    // ---- Draw / void: refund both ----
    if (!winnerId) {
      const upd = await pool.query(SQL.settleWager, ['draw', null, wager.id]);
      if (upd.rowCount === 0) return null;

      await Promise.all([
        refund(wager.player_a_id, wager.amount, wager.id, 'draw', 'A')
          .catch((e) => log.error(`[WAGER] draw refund A ${wager.id} failed:`, e.message)),
        refund(wager.player_b_id, wager.amount, wager.id, 'draw', 'B')
          .catch((e) => log.error(`[WAGER] draw refund B ${wager.id} failed:`, e.message)),
      ]);
      log.log(`[WAGER] Draw. Refunded ${wager.amount} to both players (wager ${wager.id}).`);
      return upd.rows[0];
    }

    // ---- Winner must be A or B ----
    if (String(winnerId) !== String(wager.player_a_id) &&
        String(winnerId) !== String(wager.player_b_id)) {
      throw err('invalid_winner', 400);
    }

    const status = String(winnerId) === String(wager.player_a_id) ? 'won_a' : 'won_b';
    const totalPot = Number(wager.amount) * 2;

    const upd = await pool.query(SQL.settleWager, [status, winnerId, wager.id]);
    if (upd.rowCount === 0) return null;

    await wallet.credit(winnerId, totalPot, {
      kind: KIND.win,
      refType: 'wager_win',
      refId: `win_${wager.id}`,
      meta: { wagerId: wager.id, role: 'winner', gameType, roomId },
    }).catch((e) => log.error(`[WAGER] payout ${wager.id} failed:`, e.message));

    log.log(`[WAGER] Settled ${wager.id}. Winner: ${winnerId}, Pot: ${totalPot}`);
    return upd.rows[0];
  }

  // ---------------------------------------------------------------------
  // CLEANUP
  // ---------------------------------------------------------------------

  // Cancel pending wagers older than `olderThanMinutes` and refund the owner.
  // Safe to call at startup and periodically.
  async function cleanupStaleWagers({ olderThanMinutes = PENDING_STALE_MIN } = {}) {
    const res = await pool.query(SQL.findStalePending, [String(olderThanMinutes)]);
    let cleaned = 0;
    for (const w of res.rows) {
      try {
        const upd = await pool.query(SQL.cancelPendingById, [w.id]);
        if (upd.rowCount === 0) continue;
        await refund(w.player_a_id, w.amount, w.id, 'stale_pending', 'A')
          .catch((e) => log.error(`[WAGER] stale refund ${w.id} failed:`, e.message));
        cleaned++;
        log.log(`[WAGER] Cleaned stale pending ${w.id} (${w.amount} refunded to ${w.player_a_id})`);
      } catch (e) {
        log.error(`[WAGER] cleanupStaleWagers ${w.id} failed:`, e.message);
      }
    }
    if (cleaned > 0) log.log(`[WAGER] cleanupStaleWagers: ${cleaned} cancelled`);
    return cleaned;
  }

  // Settle active wagers older than ACTIVE_EXPIRY_HOURS as draws (refund both).
  // Called periodically by server.js.
  async function handleExpiredWagers() {
    try {
      const res = await pool.query(SQL.findExpiredActive, [String(ACTIVE_EXPIRY_HOURS)]);
      let n = 0;
      for (const w of res.rows) {
        try {
          const settled = await settleWager(w.game_type, w.room_id, null);
          if (settled) n++;
        } catch (e) {
          log.error(`[WAGER] expire ${w.id} failed:`, e.message);
        }
      }
      if (n > 0) log.log(`[WAGER] handleExpiredWagers: settled ${n} as draws`);
      return n;
    } catch (e) {
      log.error('[WAGER] handleExpiredWagers failed:', e.message);
      return 0;
    }
  }

  return {
    ensureSchema,
    createWager,
    acceptWager,
    cancelWager,
    cancelPendingByPlayer,
    settleWager,
    cleanupStaleWagers,
    handleExpiredWagers,
    MIN_WAGER,
    MAX_WAGER,
    _t: { SQL, KIND },
  };
};

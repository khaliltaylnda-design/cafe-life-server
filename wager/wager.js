'use strict';

// wager/wager.js — Cafe Life betting system.
// Handles creating, accepting, and settling wagers.
// Uses wallet.credit / wallet.debit for all balance changes.

const crypto = require('crypto');

const err = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });

const MIN_WAGER = 300;       // ~ $3
const MAX_WAGER = 100000;    // ~ $1000
const HOLD_EXPIRY_HOURS = 24; // Abandoned games expire after 24h

module.exports = function createWager({ pool, wallet, log = console } = {}) {
  if (!pool) throw new Error('wager requires pool');
  if (!wallet) throw new Error('wager requires wallet');

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
      `CREATE INDEX IF NOT EXISTS wagers_room_idx ON wagers(game_type, room_id)`,
      `CREATE INDEX IF NOT EXISTS wagers_status_idx ON wagers(status)`,
      `CREATE INDEX IF NOT EXISTS wagers_players_idx ON wagers(player_a_id, player_b_id)`
    ],

    insertWager: `
      INSERT INTO wagers (id, game_type, room_id, player_a_id, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *`,

    getWager: `SELECT * FROM wagers WHERE id = $1`,
    
    getActiveByRoom: `SELECT * FROM wagers WHERE game_type = $1 AND room_id = $2 AND status IN ('pending', 'active')`,

    acceptWager: `
      UPDATE wagers 
      SET player_b_id = $1, status = 'active', started_at = NOW()
      WHERE id = $2 AND status = 'pending' AND player_a_id != $1
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

    findExpired: `
      SELECT * FROM wagers 
      WHERE status = 'active' 
      AND started_at < NOW() - INTERVAL '${HOLD_EXPIRY_HOURS} hours'`
  };

  async function ensureSchema() {
    for (const q of SQL.schema) {
      await pool.query(q);
    }
  }

  async function createWager(userId, gameType, roomId, amount) {
    if (!Number.isSafeInteger(amount) || amount < MIN_WAGER || amount > MAX_WAGER) {
      throw err(`invalid_amount (min ${MIN_WAGER}, max ${MAX_WAGER})`, 400);
    }

    // Check if room already has an active wager
    const existing = await pool.query(SQL.getActiveByRoom, [gameType, roomId]);
    if (existing.rows.length > 0) throw err('room_has_active_wager', 409);

    const id = 'wg_' + crypto.randomBytes(8).toString('hex');

    // 1. Hold funds from Player A
    await wallet.debit(userId, amount, {
      kind: 'wager_hold',
      refType: 'wager',
      refId: id,
      meta: { gameType, roomId, role: 'A' }
    });

    // 2. Create the pending wager
    try {
      const result = await pool.query(SQL.insertWager, [
        id, gameType, roomId, userId, amount
      ]);
      return result.rows[0];
    } catch (e) {
      // Refund if DB insert fails
      await wallet.credit(userId, amount, {
        kind: 'wager_refund',
        refType: 'wager',
        refId: id,
        meta: { reason: 'db_fail' }
      }).catch(() => {});
      throw e;
    }
  }

  async function acceptWager(userId, wagerId) {
    const wagerRes = await pool.query(SQL.getWager, [wagerId]);
    const wager = wagerRes.rows[0];

    if (!wager) throw err('wager_not_found', 404);
    if (wager.status !== 'pending') throw err('wager_not_pending', 409);
    if (wager.player_a_id === userId) throw err('cannot_wager_against_self', 400);

    // 1. Hold funds from Player B
    await wallet.debit(userId, wager.amount, {
      kind: 'wager_hold',
      refType: 'wager',
      refId: wagerId,
      meta: { gameType: wager.game_type, roomId: wager.room_id, role: 'B' }
    });

    // 2. Mark as active
    try {
      const result = await pool.query(SQL.acceptWager, [userId, wagerId]);
      if (result.rowCount === 0) throw new Error('race_condition');
      return result.rows[0];
    } catch (e) {
      // Refund if accept fails
      await wallet.credit(userId, wager.amount, {
        kind: 'wager_refund',
        refType: 'wager',
        refId: wagerId,
        meta: { reason: 'accept_fail' }
      }).catch(() => {});
      throw e;
    }
  }

  async function cancelWager(userId, wagerId) {
    const wagerRes = await pool.query(SQL.getWager, [wagerId]);
    const wager = wagerRes.rows[0];

    if (!wager) throw err('wager_not_found', 404);
    if (wager.player_a_id !== userId) throw err('not_owner', 403);
    if (wager.status !== 'pending') throw err('wager_not_pending', 409);

    const result = await pool.query(SQL.cancelWager, [wagerId]);
    if (result.rowCount === 0) throw err('cancel_failed', 500);

    // Refund Player A
    await wallet.credit(userId, wager.amount, {
      kind: 'wager_refund',
      refType: 'wager',
      refId: wagerId,
      meta: { reason: 'cancelled' }
    });

    return result.rows[0];
  }

  // Settle a wager. WinnerId can be null (for a draw, refunds both players).
  async function settleWager(gameType, roomId, winnerId) {
    const res = await pool.query(SQL.getActiveByRoom, [gameType, roomId]);
    const wager = res.rows.find(w => w.status === 'active');
    
    if (!wager) return null; // No active wager

    // 1. Draw or Void: Refund both players
    if (!winnerId) {
      const update = await pool.query(SQL.settleWager, ['draw', null, wager.id]);
      if (update.rowCount === 0) return null; // Already settled
      
      await Promise.all([
        wallet.credit(wager.player_a_id, wager.amount, {
          kind: 'wager_refund', refType: 'wager', refId: wager.id,
          meta: { reason: 'draw', role: 'A' }
        }),
        wallet.credit(wager.player_b_id, wager.amount, {
          kind: 'wager_refund', refType: 'wager', refId: wager.id,
          meta: { reason: 'draw', role: 'B' }
        })
      ]);
      log.log(`[WAGER] Draw. Refunded ${wager.amount} to both players.`);
      return update.rows[0];
    }

    // 2. Check winner is one of the players
    if (winnerId !== wager.player_a_id && winnerId !== wager.player_b_id) {
      throw err('invalid_winner', 400);
    }

    const status = winnerId === wager.player_a_id ? 'won_a' : 'won_b';
    const totalPot = wager.amount * 2;

    // 3. Mark wager as settled (atomic)
    const update = await pool.query(SQL.settleWager, [status, winnerId, wager.id]);
    if (update.rowCount === 0) return null; // Already settled

    // 4. Payout winner (total pot)
    await wallet.credit(winnerId, totalPot, {
      kind: 'wager_win',
      refType: 'wager',
      refId: wager.id,
      meta: { role: 'winner', gameType, roomId }
    });

    log.log(`[WAGER] Settled ${wager.id}. Winner: ${winnerId}, Amount: ${totalPot}`);
    return update.rows[0];
  }

  // Background job to find and handle abandoned games (24h timeout)
  async function handleExpiredWagers() {
    try {
      const res = await pool.query(SQL.findExpired);
      for (const wager of res.rows) {
        log.log(`[WAGER] Expiring wager ${wager.id} due to 24h timeout`);
        // For now, refund both players as a draw if abandoned.
        await settleWager(wager.game_type, wager.room_id, null).catch(e => {
          log.error(`[WAGER] Failed to expire ${wager.id}:`, e.message);
        });
      }
    } catch (e) {
      log.error('[WAGER] Expire check failed:', e.message);
    }
  }

  return {
    ensureSchema,
    createWager,
    acceptWager,
    cancelWager,
    settleWager,
    handleExpiredWagers,
    MIN_WAGER,
    MAX_WAGER
  };
};

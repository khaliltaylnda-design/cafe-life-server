'use strict';

// games/voice.js — Cafe Life voice rooms (one per table). Server-authoritative.
// ============================================================================
// Server determines the table from the player's seat position (not from client).
// Client receives `voice:peers` with only players in its table.
// server.js forwards WebRTC signals only when `canSignal(from, to)` is true.
//
// SECURITY NOTES (critical):
//   - `from` MUST come from the WebSocket connection id, NEVER from the
//     client message payload. `canSignal()` trusts its `from` argument
//     completely. If a caller passes `msg.from`, any player can impersonate
//     any other player and eavesdrop.
//   - All send() calls are guarded against dead sockets (sendTo).
//   - All state mutation is synchronous (no awaits) → no race between
//     leave/add within a single onMove invocation.
//   - pushRoom snapshots the room set before iterating, so a player leaving
//     mid-iteration doesn't corrupt state.
// ============================================================================

module.exports = function createVoice({ send, sockets, players }) {
  /* ==================================================================
     Cafe layout (must match index.html: TB and CH)
  ================================================================== */
  const TABLES = [[-4, -1], [3, -1], [-4, 4], [3, 4]];
  const OFFS = [[0, 1.7], [0, -1.7], [1.7, 0], [-1.7, 0]];
  const STOOLS = [-5.2, -2.6, 0, 2.6, 5.2];

  const CHAIRS = [];
  TABLES.forEach(t => OFFS.forEach(o => CHAIRS.push({
    key: t.join(','),
    x: t[0] + o[0],
    z: t[1] + o[1],
  })));
  STOOLS.forEach(z => CHAIRS.push({ key: '-15,' + z, x: -13.6, z }));

  const SNAP = 0.8;

  /* ==================================================================
     Extension point (VIP / private tables)
     Return false to deny access.
  ================================================================== */
  const allowTable = (id, key) => true;

  /* ==================================================================
     State
  ================================================================== */
  const cur = new Map();       // id -> { chair, key }
  const owner = new Map();     // chair index -> id
  const rooms = new Map();     // key -> Set(ids)

  /* ==================================================================
     Safe send — never throws, never crashes the caller
  ================================================================== */
  function sendTo(id, payload) {
    if (!id) return false;
    const sock = sockets.get(id);
    if (!sock) return false;
    try {
      send(sock, payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ==================================================================
     Peers lookup
  ================================================================== */
  function peersOf(key, id) {
    const s = rooms.get(key);
    if (!s) return [];
    const out = [];
    for (const x of s) {
      if (x !== id) out.push(x);
    }
    return out;
  }

  function push(id, key) {
    sendTo(id, {
      type: 'voice:peers',
      table: key || null,
      peers: key ? peersOf(key, id) : [],
    });
  }

  function pushRoom(key) {
    const room = rooms.get(key);
    if (!room) return;
    // Snapshot to avoid mutation-during-iteration issues.
    for (const id of [...room]) {
      push(id, key);
    }
  }

  /* ==================================================================
     Leave
  ================================================================== */
  function leave(id, silent) {
    const c = cur.get(id);
    if (!c) {
      if (!silent) push(id, null);
      return;
    }
    cur.delete(id);
    if (owner.get(c.chair) === id) owner.delete(c.chair);

    const room = rooms.get(c.key);
    if (room) {
      room.delete(id);
      if (!room.size) rooms.delete(c.key);
    }

    if (!silent) push(id, null);
    pushRoom(c.key);
  }

  /* ==================================================================
     On move — called by server.js after every movement update
  ================================================================== */
  function onMove(id) {
    try {
      const p = players.get(id);
      if (!p || !p.s) return leave(id);

      // Defense against corrupted coordinates
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
        return leave(id);
      }

      // Find nearest chair within SNAP
      let best = -1, bd = SNAP;
      for (let i = 0; i < CHAIRS.length; i++) {
        const c = CHAIRS[i];
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0) return leave(id);

      const mine = cur.get(id);
      if (mine && mine.chair === best) return; // No change

      // Occupied by someone else?
      const o = owner.get(best);
      if (o && o !== id) {
        leave(id);
        sendTo(id, { type: 'voice:denied', reason: 'الكرسي مشغول' });
        return;
      }

      const key = CHAIRS[best].key;

      // VIP / private table check
      if (!allowTable(id, key)) {
        const hadChair = cur.has(id);
        leave(id);
        if (!hadChair) push(id, null);
        sendTo(id, { type: 'voice:denied', reason: 'الطاولة هذي خاصة' });
        return;
      }

      // Silent leave from previous chair (if any)
      leave(id, true);

      // Join new chair
      owner.set(best, id);
      cur.set(id, { chair: best, key });
      if (!rooms.has(key)) rooms.set(key, new Set());
      rooms.get(key).add(id);

      pushRoom(key);
    } catch (e) {
      // Never let a voice error crash the movement handler.
      console.error('[VOICE] onMove failed:', e && e.message);
    }
  }

  /* ==================================================================
     Signal authorization — CRITICAL
     `from` MUST be ws.playerId from server.js, NEVER from msg.from.
  ================================================================== */
  function canSignal(from, to) {
    if (typeof from !== 'string' || typeof to !== 'string') return false;
    if (from === to) return false;            // No self-signaling
    if (!players.has(to)) return false;       // Target must be a live player
    if (!players.has(from)) return false;     // Source must be a live player
    const a = cur.get(from);
    const b = cur.get(to);
    return !!(a && b && a.key === b.key);
  }

  /* ==================================================================
     Public API
  ================================================================== */
  return {
    prefix: 'voice:',

    handle(id, d) {
      if (d && d.type === 'voice:sync') {
        const c = cur.get(id);
        push(id, c ? c.key : null);
      }
    },

    leave: id => leave(id),

    onMove,

    canSignal,

    // Test/debug hooks — not exposed to clients.
    _debug: () => ({
      cur: [...cur],
      rooms: [...rooms].map(([k, v]) => [k, [...v]]),
    }),

    _reset: () => {
      cur.clear();
      owner.clear();
      rooms.clear();
    },
  };
};

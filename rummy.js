'use strict';

// games/rummy.js
module.exports = function ({ send, sockets, players, crypto, createWager, acceptWager, settleWager }) {
  const RM = (() => {
    const val = r => (r >= 10 || r === 1) ? 10 : r;
    const hv = c => c.r ? val(c.r) : 20;
    const posv = p => p === 1 ? 1 : (p >= 10 ? 10 : p);
    function meld(cs) {
      const n = cs.length; if (n < 3) return null;
      const jk = cs.filter(c => !c.r), ot = cs.filter(c => c.r); if (!ot.length) return null;
      const suits = new Set(ot.map(c => c.s));
      if (n <= 5 && ot.every(c => c.r === ot[0].r) && suits.size === ot.length) return { k: 'set', pts: val(ot[0].r) * n, ord: cs };
      if (suits.size !== 1 || new Set(ot.map(c => c.r)).size !== ot.length) return null;
      let best = null;
      for (const hi of [0, 1]) {
        const L = hi ? 2 : 1, U = hi ? 14 : 13; if (U - L + 1 < n) continue;
        const v = ot.map(c => ({ c, p: (c.r === 1 && hi) ? 14 : c.r })).sort((a, b) => a.p - b.p);
        const mn = v[0].p, mx = v[v.length - 1].p;
        if (mx - mn + 1 - v.length > jk.length) continue;
        const s = Math.min(mn, U - n + 1); if (s + n - 1 < mx) continue;
        const J = [...jk], ord = []; let pts = 0;
        for (let p = s; p < s + n; p++) { const f = v.find(x => x.p === p); ord.push(f ? f.c : J.pop()); pts += posv(p); }
        if (!best || pts > best.pts) best = { k: 'seq', pts, ord };
      }
      return best;
    }
    function cands(R, x) {
      const J = R.filter(c => !c.r), O = R.filter(c => c.r && c !== x), out = [], seen = new Set();
      const add = cs => { const m = meld(cs); if (!m) return; const k = cs.map(c => c.id).sort((a, b) => a - b).join(); if (seen.has(k)) return; seen.add(k); out.push({ cs, m }); };
      const ss = new Set([x.s]), same = []; O.forEach(c => { if (c.r === x.r && !ss.has(c.s)) { ss.add(c.s); same.push(c); } });
      for (let mk = 0; mk < (1 << same.length); mk++) {
        const b = [x]; same.forEach((c, i) => (mk >> i) & 1 && b.push(c));
        for (let j = 0; j <= Math.min(J.length, 2); j++) if (b.length + j >= 3 && b.length + j <= 5) add([...b, ...J.slice(0, j)]);
      }
      const bs = {}; O.forEach(c => { if (c.s === x.s && !bs[c.r]) bs[c.r] = c; });
      for (const hi of [0, 1]) {
        const L = hi ? 2 : 1, U = hi ? 14 : 13, px = (x.r === 1 && hi) ? 14 : x.r; if (px < L || px > U) continue;
        for (let a = Math.max(L, px - 13); a <= px; a++) for (let b = px; b <= U; b++) {
          if (b - a < 2) continue; const cs = []; let need = 0;
          for (let p = a; p <= b; p++) { const c = p === px ? x : bs[p === 14 ? 1 : p]; if (c) cs.push(c); else need++; }
          if (need > J.length || need > 2) continue; add([...cs, ...J.slice(0, need)]);
        }
      }
      return out;
    }
    function solve(hand, out) {
      const memo = new Map();
      const go = R => {
        const k = R.map(c => c.id).sort((a, b) => a - b).join(); if (memo.has(k)) return memo.get(k);
        const x = R.find(c => c.r); let best = { s: out ? 0 : -R.length, ms: [] };
        if (x) {
          const sk = go(R.filter(c => c !== x)); best = { s: sk.s - (out ? 0 : 1), ms: sk.ms };
          if (memo.size < 60000) for (const { cs, m } of cands(R, x)) {
            const ids = new Set(cs.map(c => c.id)), r = go(R.filter(c => !ids.has(c.id)));
            const sc = r.s + (out ? cs.length * 1000 + (cs.length >= 4 ? 50 : 0) + m.pts / 100 : m.pts * 20);
            if (sc > best.s) best = { s: sc, ms: [m.ord, ...r.ms] };
          }
        }
        memo.set(k, best); return best;
      };
      return go(hand).ms;
    }
    function jokerSlot(m, k) {
      const cs = m.cards, j = cs.findIndex(c => c.r), c = cs[j], pj = (c.r === 1 && j > 0) ? 14 : c.r, pos = pj + (k - j);
      return { r: pos === 14 ? 1 : pos, s: c.s };
    }
    function trySwap(m, c) {
      if (!c.r) return null;
      for (let k = 0; k < m.cards.length; k++) {
        if (m.cards[k].r) continue;
        if (m.k === 'seq') { const w = jokerSlot(m, k); if (w.r !== c.r || w.s !== c.s) continue; }
        const cs = [...m.cards]; cs[k] = c; const r = meld(cs);
        if (r) return { r, j: m.cards[k] };
      }
      return null;
    }
    const pts = ms => ms.reduce((a, g) => a + meld(g).pts, 0);
    return { hv, meld, solve, trySwap, pts };
  })();

  const RUM = new Map();
  const rumShuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function rumDeck() {
    const d = []; let n = 0;
    for (let k = 0; k < 2; k++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) d.push({ id: n++, r, s });
    for (let i = 0; i < 4; i++) d.push({ id: n++, r: 0, s: -1 });
    return rumShuffle(d);
  }
  const rumActive = s => !s.dead && !s.out && !s.left;
  const rumOf = id => { for (const r of RUM.values()) if (r.seats.some(s => s.id === id && !s.left)) return r; return null; };
  const rumErr = (id, text) => send(sockets.get(id), { type: 'rum:err', text });

  function rumView(r, i) {
    const me = r.seats[i];
    return {
      type: 'rum:state', room: r.id.slice(4), status: r.status, host: r.hostId === me.id, hostIdx: r.seats.findIndex(s => s.id === r.hostId), you: i,
      seats: r.seats.map(s => ({ name: s.name, score: s.score, opened: s.opened, out: s.out, dead: s.dead, n: s.hand.length })),
      hand: me.hand, melds: r.melds, disc: r.disc[r.disc.length - 1] || null, stock: r.stock.length,
      min: r.min, turn: r.turn, ph: r.ph, first: r.first, wasOpen: r.wasOpen,
      took: (i === r.turn && r.took) ? r.took.id : null,
      rows: r.rows, buy: r.buyId === me.id, buyName: (r.seats.find(s => s.id === r.buyId) || {}).name || '', buyScore: Math.max(0, ...r.seats.filter(s => s.id !== r.buyId && !s.dead).map(s => s.score)), over: r.over, winner: r.winner, ready: [...r.ready],
      wager: r.wagerAmount || null,
      wagerId: r.wagerId || null
    };
  }

  const rumPush = r => r.seats.forEach((s, i) => send(sockets.get(s.id), rumView(r, i)));

  // Settle wager and notify both players
  async function settleWagerForRoom(r, winnerPlayerId) {
    if (!r.wagerAmount || r.wagerSettled) {
      console.log(`[RUMMY WAGER SETTLE] Skipped: amount=${r.wagerAmount}, settled=${r.wagerSettled}`);
      return;
    }
    r.wagerSettled = true;

    // Determine loser (if 2 players)
    let loserPlayerId = null;
    if (winnerPlayerId && r.seats.length === 2) {
      loserPlayerId = r.seats.find(s => s.id !== winnerPlayerId)?.id || null;
    }

    if (typeof settleWager === 'function') {
      try {
        await settleWager('rummy', r.wagerRoomId, winnerPlayerId, loserPlayerId);
        console.log(`[RUMMY WAGER SETTLE] Success, winner=${winnerPlayerId}, loser=${loserPlayerId}`);
      } catch (e) {
        console.error('[RUMMY WAGER SETTLE] Error:', e.message);
      }
    }
  }

  async function rumJoin(id, roomId, amount) {
    // إزالة اللاعب من غرفة أخرى فقط
    for (const [rid, otherR] of RUM) {
      if (rid === 'rum:' + roomId) continue;
      if (otherR.seats.some(s => s.id === id && !s.left)) {
        rumLeave(id);
        break;
      }
    }
    
    const key = 'rum:' + roomId; let r = RUM.get(key);

    if (!r) {
      r = {
        id: key, seats: [], hostId: id, status: 'wait', stock: [], disc: [], melds: [],
        min: 51, turn: 0, ph: 'draw', first: false, took: null, laid: [], wasOpen: false,
        rows: null, over: false, winner: '', ready: new Set(), n: 0, starterId: null,
        buyId: null, buyUsed: false, wagerAmount: 0, wagerId: null, wagerRoomId: null, wagerSettled: false,
        pendingWager: 0, wagerOwner: null
      };
      RUM.set(key, r);
    }

    if (r.status !== 'wait') return rumErr(id, 'Game already started in this room');
    if (r.seats.length >= 4) return rumErr(id, 'Room is full (4 players max)');

    const wagerAmount = Number(amount) || 0;
    const alreadyIn = r.seats.some(s => s.id === id);

    console.log(`[RUM JOIN] id=${id}, room=${roomId}, amount=${wagerAmount}, seats=${r.seats.length}, wagerId=${r.wagerId}, owner=${r.wagerOwner}, already=${alreadyIn}`);

    if (!alreadyIn) {
      r.seats.push({ id, name: (players.get(id) || {}).name || 'Player', hand: [], opened: false, score: 0, dead: false, out: false, left: false, h45: false, bought: false, pending: false });
    }

    if (wagerAmount >= 300) r.pendingWager = wagerAmount;

    // Wager Logic: Only for 2-player games
    if (r.seats.length === 2 && r.status === 'wait') {
      
      // 2a. رهان معلق: اللاعب الآخر (غير المالك) يقبله
      if (r.wagerId && !r.wagerSettled && r.wagerOwner && id !== r.wagerOwner) {
        try {
          console.log(`[RUM] Accepting wager ${r.wagerId} by ${id}`);
          await acceptWager(id, r.wagerId);
          r.wagerAmount = r.pendingWager || r.wagerAmount;
          r.wagerRoomId = roomId;
          r.pendingWager = 0;
          rumStartGame(r);
          rumPush(r);
          return;
        } catch (e) {
          console.error('[RUM] Accept error:', e.message);
          rumErr(id, 'Accept failed: ' + e.message);
          rumPush(r);
          return;
        }
      }
      // 2b. لا يوجد رهان: ننشئه من اللاعب الذي طلب رهاناً
      else if (!r.wagerId && r.pendingWager >= 300) {
        try {
          const wagerRow = await createWager(id, 'rummy', roomId, r.pendingWager);
          r.wagerId = wagerRow.id;
          r.wagerOwner = id;
          const otherSeat = r.seats.find(s => s.id !== id);
          if (otherSeat) {
            send(sockets.get(otherSeat.id), {
              type: 'rum:wager_pending',
              amount: r.pendingWager,
              wagerId: wagerRow.id,
              room: roomId
            });
          }
          console.log(`[RUM] Wager created by ${id}: ${r.pendingWager}`);
        } catch (e) {
          console.error('[RUM] Create error:', e.message);
          rumErr(id, 'Wager failed: ' + e.message);
          r.seats = [];
          rumPush(r);
          return;
        }
      }
      // 2c. لعبة عادية (بدون رهان)
      else if (!r.wagerId && r.pendingWager < 300) {
        rumStartGame(r);
        rumPush(r);
        return;
      }
    }

    if (r.seats.length === 4) return rumStartGame(r);
    rumPush(r);
  }

  function rumStartGame(r) {
    r.n = r.seats.length; r.over = false; r.winner = '';
    r.seats.forEach(s => { s.score = 0; s.dead = false; s.bought = false; s.pending = false; }); r.buyId = null; r.buyUsed = false;
    rumDeal(r, crypto.randomInt(r.n));
  }
  function rumStart(id) {
    const r = rumOf(id); if (!r || r.status !== 'wait') return;
    if (r.seats.length < 2) return rumErr(id, 'Need at least 2 players');
    rumStartGame(r);
  }
  function rumAgain(id) {
    const r = rumOf(id); if (!r || r.status !== 'end') return;
    r.seats = r.seats.filter(s => !s.left);
    if (r.seats.length < 2) return rumErr(id, 'Need at least 2 players');
    // Clear wager for new game
    r.wagerId = null;
    r.wagerAmount = 0;
    r.wagerRoomId = null;
    r.wagerSettled = false;
    r.pendingWager = 0;
    r.wagerOwner = null;
    rumStartGame(r);
  }
  function rumDeal(r, st) {
    r.stock = rumDeck(); r.disc = []; r.melds = []; r.min = 51; r.first = true; r.rows = null; r.ready = new Set(); r.status = 'play';
    r.seats.forEach((s, i) => { s.opened = false; s.out = false; s.h45 = false; s.hand = []; if (!s.dead) for (let k = 0; k < (i === st ? 15 : 14); k++) s.hand.push(r.stock.pop()); });
    rumTurn(r, st); rumPush(r);
  }
  function rumTurn(r, i) { r.turn = i; r.took = null; r.laid = []; r.wasOpen = r.seats[i].opened; r.ph = r.first ? 'play' : 'draw'; }
  function rumAdvance(r) {
    r.first = false;
    if (r.seats.filter(rumActive).length < 2) return rumEnd(r, null);
    let j = r.turn; do { j = (j + 1) % r.seats.length; } while (!rumActive(r.seats[j]));
    rumTurn(r, j); rumPush(r);
  }
  function rumCur(id, ph) {
    const r = rumOf(id); if (!r || r.status !== 'play') return null;
    const i = r.seats.findIndex(s => s.id === id), s = r.seats[i];
    if (i !== r.turn || !rumActive(s)) { rumErr(id, 'Not your turn'); return null; }
    if (r.ph !== ph) { rumErr(id, ph === 'draw' ? 'You cannot draw now' : 'Draw a card first'); return null; }
    return { r, i, s };
  }
  function rumDraw(id, from) {
    const x = rumCur(id, 'draw'); if (!x) return; const { r, s } = x; let c;
    if (from === 'd') { if (!r.disc.length) return; c = r.disc.pop(); r.took = c; }
    else {
      if (!r.stock.length) { const top = r.disc.pop(); r.stock = rumShuffle(r.disc); r.disc = top ? [top] : []; }
      if (!r.stock.length) return rumEnd(r, null);
      c = r.stock.pop();
    }
    s.hand.push(c); r.ph = 'play'; rumPush(r);
  }
  function rumUndo(id) { rumErr(id, 'No undo: the discarded card must be used'); }
  function rumPenalty(r, i, text) {
    const s = r.seats[i];
    s.score += 100; s.out = true; r.stock.unshift(...s.hand); s.hand = [];
    send(sockets.get(s.id), { type: 'rum:note', text: text + ' — Penalty: 100 points' });
    rumAdvance(r);
  }
  const rumPlaceable = (r, c) => r.melds.some(m => RM.trySwap(m, c) || RM.meld([...m.cards, c]));
  function rumParse(s, groups) {
    if (!Array.isArray(groups) || groups.length > 8) return null;
    const used = new Set(), out = [];
    for (const g of groups) {
      if (!Array.isArray(g)) return null; const cs = [];
      for (const cid of g) { const c = s.hand.find(h => h.id === +cid); if (!c || used.has(c.id)) return null; used.add(c.id); cs.push(c); }
      const m = RM.meld(cs); if (!m) return null; out.push({ cs, m });
    }
    return out;
  }
  function rumLay(id, d) {
    const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
    const ps = rumParse(s, d.groups); if (!ps) return rumErr(id, 'Invalid meld');
    if (!ps.length && s.opened) return rumErr(id, 'No meld to lay');
    const tot = ps.reduce((a, p) => a + p.m.pts, 0), used = ps.reduce((a, p) => a + p.cs.length, 0);
    if (s.hand.length === used && !(s.h45 || ps.some(p => p.cs.length >= 4))) return rumErr(id, 'Must have a set of 4 or 5');
    if (!s.opened) {
      if (tot < r.min) {
        if (r.took && RM.pts(RM.solve(s.hand)) < r.min) return rumPenalty(r, i, `You took the discard but couldn't open ${r.min}`);
        return rumErr(id, `Opening requires ${r.min}, you have ${tot}`);
      }
      s.opened = true; r.min = tot + 1;
    }
    const u = new Set();
    ps.forEach(p => { r.melds.push({ o: i, cards: p.m.ord, k: p.m.k }); r.laid.push({ n: p.cs.length }); if (p.cs.length >= 4) s.h45 = true; p.cs.forEach(c => u.add(c.id)); });
    s.hand = s.hand.filter(c => !u.has(c.id));
    if (!s.hand.length) return rumEnd(r, i);
    rumPush(r);
  }
  function rumPlace(id, d) {
    const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
    if (!s.opened) return rumErr(id, 'Must open first');
    const m = r.melds[+d.meld]; if (!m || !Array.isArray(d.cards)) return rumErr(id, 'Invalid meld');
    for (const cid of d.cards) {
      const c = s.hand.find(h => h.id === +cid); if (!c) break;
      const sw = RM.trySwap(m, c);
      if (sw) { m.cards = sw.r.ord; m.k = sw.r.k; s.hand = s.hand.filter(h => h !== c); s.hand.push(sw.j); send(sockets.get(id), { type: 'rum:note', text: 'Joker swapped' }); if (m.cards.length >= 4) s.h45 = true; continue; }
      const rr = RM.meld([...m.cards, c]); if (!rr) { rumErr(id, 'Card cannot be placed here'); break; }
      m.cards = rr.ord; m.k = rr.k; s.hand = s.hand.filter(h => h !== c); if (m.cards.length >= 4) s.h45 = true;
    }
    if (!s.hand.length) return rumEnd(r, i);
    rumPush(r);
  }
  function rumDiscard(id, d) {
    const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
    const c = s.hand.find(h => h.id === +d.card); if (!c) return rumErr(id, 'Select a card to discard');
    const legal = s.hand.filter(h => h.r && !rumPlaceable(r, h));
    if (legal.length && !legal.includes(c)) return rumErr(id, !c.r ? 'Cannot discard Joker' : 'Cannot discard a placeable card');
    if (r.took && !s.opened) return rumPenalty(r, i, 'Took discard but didn\'t open or flush');
    if (s.hand.length === 1 && !s.h45) return rumErr(id, 'Cannot discard: need a set of 4 or 5');
    s.hand = s.hand.filter(h => h !== c); r.disc.push(c);
    if (!s.hand.length) return rumEnd(r, i);
    rumAdvance(r);
  }
  function rumFlush(id) {
    const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
    const ms = RM.solve(s.hand, true), used = new Set(ms.flat().map(c => c.id));
    let placed = 0, big = false;
    const all = [...r.melds.map(m => ({ ...m, cards: [...m.cards] })), ...ms.map(g => { const m = RM.meld(g); return { o: i, cards: m.ord, k: m.k }; })];
    const left = s.hand.filter(c => !used.has(c.id)).filter(c => {
      for (const m of all) { const rr = RM.meld([...m.cards, c]); if (rr) { m.cards = rr.ord; m.k = rr.k; placed++; if (m.cards.length >= 4) big = true; return false; } }
      return true;
    });
    const own = ms.flat().length, total = own + placed, needed = r.wasOpen ? s.hand.length - 1 : 14;
    const has45 = s.h45 || big || ms.some(g => g.length >= 4);
    if (left.length > 1 || total !== needed)
      return rumPenalty(r, i, left.length > 1 ? `Invalid flush: ${left.length} cards left` : `Invalid flush: ${total} instead of ${needed}`);
    if (!has45) return rumPenalty(r, i, 'Invalid flush: need a set of 4 or 5');
    r.melds = all; s.opened = true; s.hand = []; if (left[0]) r.disc.push(left[0]);
    rumEnd(r, i);
  }
  function rumEnd(r, w) {
    r.rows = r.seats.map((s, i) => {
      if (s.dead) return null;
      let d, note = '';
      if (i === w) { d = -10; note = 'Flush 🏆'; }
      else if (s.out) { d = 0; note = s.left ? 'Left (100)' : 'Invalid flush (100)'; }
      else if (!s.opened) d = 100;
      else d = s.hand.reduce((a, c) => a + RM.hv(c), 0);
      s.score += d; return { sid: s.id, name: s.name, d, score: s.score, note };
    }).filter(Boolean);
    r.starterId = w != null ? r.seats[w].id : (r.seats[r.turn] || {}).id;
    const dying = r.seats.filter(s => !s.dead && s.score >= 300);
    r.buyId = null;
    dying.forEach(s => {
      const row = r.rows.find(x => x.sid === s.id);
      if (dying.length === 1 && !r.buyUsed && !s.bought && r.n >= 3) { r.buyId = s.id; r.buyUsed = true; s.pending = true; if (row) row.note += ' 💀 Lost 300 — can buy back'; }
      else { s.dead = true; if (row) row.note += s.bought ? ' 💀 Dead (double)' : ' 💀'; }
    });
    r.seats.forEach(s => { s.out = false; });
    r.seats = r.seats.filter(s => !s.left);
    if (!r.seats.some(s => s.id === r.hostId) && r.seats[0]) r.hostId = r.seats[0].id;
    r.ready = new Set(); rumCheckOver(r);

    // Wager Settlement
    if (r.over && r.wagerAmount > 0 && !r.wagerSettled) {
      const winnerSeat = r.seats.find(s => s.name === r.winner);
      if (winnerSeat) {
        settleWagerForRoom(r, winnerSeat.id);
      } else {
        settleWagerForRoom(r, null);
      }
    }

    rumPush(r);
  }
  function rumCheckOver(r) {
    const alive = r.seats.filter(s => !s.dead);
    r.over = alive.length <= Math.max(1, r.n - 2) || r.seats.length < 2;
    if (r.over) {
      const pool = alive.length ? alive : r.seats, best = pool.slice().sort((a, b) => a.score - b.score)[0];
      r.winner = best ? best.name : ''; r.status = 'end'; r.buyId = null;
    } else r.status = 'round';
  }
  function rumBuy(id, yes) {
    const r = rumOf(id); if (!r || r.status !== 'round' || r.buyId !== id) return;
    const s = r.seats.find(x => x.id === id); s.pending = false; r.buyId = null;
    if (yes) { const o = r.seats.filter(x => x !== s && !x.dead).map(x => x.score); s.score = o.length ? Math.max(...o) : s.score; s.bought = true; }
    else s.dead = true;
    rumCheckOver(r); rumPush(r);
  }
  function rumNextRound(id) {
    const r = rumOf(id); if (!r || r.status !== 'round' || r.buyId) return;
    r.ready.add(id);
    if (r.seats.filter(s => !s.dead).every(s => r.ready.has(s.id))) {
      let st = r.seats.findIndex(s => s.id === r.starterId && !s.dead);
      if (st < 0) st = r.seats.findIndex(s => !s.dead);
      return rumDeal(r, st);
    }
    rumPush(r);
  }
  function rumLeave(id) {
    const r = rumOf(id); if (!r) return;
    const i = r.seats.findIndex(s => s.id === id), s = r.seats[i];
    if (r.status === 'play') {
      s.left = true; s.out = true; s.score += 100; r.stock.unshift(...s.hand); s.hand = [];

      // Wager settlement on leave
      if (r.wagerAmount > 0 && !r.wagerSettled && r.seats.length === 2) {
        r.wagerSettled = true;
        const winner = r.seats.find(x => x.id !== id && !x.left);
        const winnerPlayerId = winner ? winner.id : null;
        if (typeof settleWager === 'function') {
          settleWager('rummy', r.wagerRoomId, winnerPlayerId, id).catch(e => console.error('[RUM WAGER SETTLE]', e.message));
        }
      }

      if (r.seats.filter(rumActive).length < 2) return rumEnd(r, null);
      return r.turn === i ? rumAdvance(r) : rumPush(r);
    }
    r.seats.splice(i, 1); if (r.buyId === id) r.buyId = null;
    if (!r.seats.length) return void RUM.delete(r.id);
    if (r.hostId === id) r.hostId = r.seats[0].id;
    if (r.status === 'round' && r.seats.filter(x => !x.dead).length < 2) { r.over = true; r.status = 'end'; r.winner = (r.seats.find(x => !x.dead) || r.seats[0]).name; }
    rumPush(r);
  }

  return {
    prefix: 'rum:',
    handle(id, d) {
      switch (d.type) {
        case 'rum:join':    if (players.has(id)) rumJoin(id, String(d.room || '').slice(0, 40), d.amount); break;
        case 'rum:start':   rumStart(id); break;
        case 'rum:draw':    rumDraw(id, d.from); break;
        case 'rum:undo':    rumUndo(id); break;
        case 'rum:buy':     rumBuy(id, !!d.yes); break;
        case 'rum:open':
        case 'rum:lay':     rumLay(id, d); break;
        case 'rum:place':   rumPlace(id, d); break;
        case 'rum:discard': rumDiscard(id, d); break;
        case 'rum:flush':   rumFlush(id); break;
        case 'rum:next':    rumNextRound(id); break;
        case 'rum:again':   rumAgain(id); break;
        case 'rum:leave':   rumLeave(id); break;
      }
    },
    leave: rumLeave,
    _test: { RM, RUM },
  };
};

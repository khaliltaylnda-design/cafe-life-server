// games/rummy.js — الرامي التونسي (الخادم هو الحَكَم)
// 108 ورقة، 15 للّي يبدا و14 للباقي، الحلان التصاعدي (51 ثم +1)، البلاص، هزان الجوكر،
// الفرشة (غلطة = 100 وتخرج من الجولة)، السكور الفردي (طرح 300).
// يتحمّل من server.js. ما تلمس غير هذا الملف كي تطوّر الرامي.
// الرهان: بين لاعبين اثنين فقط، نفس نظام الشطرنج والشكبة (عرض / قبول / عرض مضاد / رفض / مهلة 60 ثانية).
module.exports = function ({ send, sockets, players, crypto, createWager, acceptWager, cancelWager, settleWager }) {
  // الخادم هو الحَكَم: 108 ورقة، 15 للّي يبدا و14 للباقي، الحلان التصاعدي (51 ثم +1)،
  // البلاص، هزان الجوكر (لازم مانع)، الفرشة (غلطة = 100 وتخرج من الجولة)، السكور الفردي (طرح 300).
  const RM = (() => {
    const val = r => (r >= 10 || r === 1) ? 10 : r;
    const hv = c => c.r ? val(c.r) : 20;                       // الجوكر في الكف = 20
    const posv = p => p === 1 ? 1 : (p >= 10 ? 10 : p);
    function meld(cs) {                                          // {k,pts,ord} أو null
      const n = cs.length; if (n < 3) return null;
      const jk = cs.filter(c => !c.r), ot = cs.filter(c => c.r); if (!ot.length) return null;
      const suits = new Set(ot.map(c => c.s));
      if (n <= 5 && ot.every(c => c.r === ot[0].r) && suits.size === ot.length) return { k: 'باكو', pts: val(ot[0].r) * n, ord: cs };
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
        if (!best || pts > best.pts) best = { k: 'سيكونس', pts, ord };
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
    function solve(hand, out) {      // out=true: غطّي أكثر عدد ورق (للفرشة) — وإلا أكثر نقاط (للمنع)
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
    function trySwap(m, c) {         // هزان الجوكر: الورقة الحقيقية اللي يعوّضها
      if (!c.r) return null;
      for (let k = 0; k < m.cards.length; k++) {
        if (m.cards[k].r) continue;
        if (m.k === 'سيكونس') { const w = jokerSlot(m, k); if (w.r !== c.r || w.s !== c.s) continue; }
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
      wager: r.wagerAmount || null, wagerId: r.wagerId || null, wagerSettling: !!r.wagerSettling,
      offer: rumPendingOffer(r) ? { wagerId: r.wagerId, amount: r.wagerAmount, by: r.wagerOwner, byName: (players.get(r.wagerOwner) || {}).name || 'لاعب', expiresAt: r.offerExpiresAt || 0 } : null,
      rows: r.rows, buy: r.buyId === me.id, buyName: (r.seats.find(s => s.id === r.buyId) || {}).name || '', buyScore: Math.max(0, ...r.seats.filter(s => s.id !== r.buyId && !s.dead).map(s => s.score)), over: r.over, winner: r.winner, ready: [...r.ready]
    };
  }
  const rumPush = r => r.seats.forEach((s, i) => send(sockets.get(s.id), rumView(r, i)));

  // ======================================================================
  // الرهان (بين لاعبين اثنين فقط) — نفس نظام الشطرنج والشكبة:
  //   عرض ← قبول / عرض مضاد / رفض / انتهاء مهلة 60 ثانية (رجوع الفلوس)
  //   الفائز بالرهان = الفايز باللعبة (أقل سكور)، والخارج في نص اللعبة يخسر.
  // ======================================================================
  const OFFER_TIMEOUT_MS = 60 * 1000, MIN_WAGER = 300, MAX_WAGER = 100000;
  const validWagerId = v => { const x = String(v == null ? '' : v).trim(); return (x && x.length <= 64 && /^wg_[A-Za-z0-9]+$/.test(x)) ? x : null; };
  const validAmount = v => { const n = Number(v); return (Number.isSafeInteger(n) && n >= MIN_WAGER && n <= MAX_WAGER) ? n : null; };
  const wagerKey = r => r.id.slice(4);
  const rumAsync = fn => (...a) => { Promise.resolve().then(() => fn(...a)).catch(e => console.error('[RUM]', e && e.message)); };
  function rumWagerInit(r) {
    Object.assign(r, { wagerAmount: 0, wagerId: null, wagerOwner: null, wagerActive: false, wagerSettled: false, wagerSettling: false, wagerCreating: false, offerTimer: null, offerExpiresAt: 0 });
  }
  const rumPendingOffer = r => !!(r.wagerId && !r.wagerActive && !r.wagerSettled && r.wagerOwner != null);
  function rumClearOfferTimer(r) {
    if (r.offerTimer) { try { clearTimeout(r.offerTimer); } catch (e) {} r.offerTimer = null; }
    r.offerExpiresAt = 0;
  }
  function rumResetWager(r) {
    rumClearOfferTimer(r);
    r.wagerAmount = 0; r.wagerId = null; r.wagerOwner = null; r.wagerActive = false;
  }
  function rumWagerFailFrom(id, fallback, e) {
    let text = fallback;
    if (e && e.code === 'insufficient_balance') text = `رصيدك ما يكفيش (لازم ${e.required}، عندك ${e.available})`;
    else if (e && e.code === 'room_has_active_wager') text = 'فما رهان آخر في الطاولة، عاود بعد شوية';
    else if (e && e.code === 'wager_not_pending') text = 'العرض انتهى ولا خذاه غيرك';
    else if (e && e.code === 'wager_not_found') text = 'الرهان ما لقيناهوش';
    else if (e && e.code === 'cannot_wager_against_self') text = 'ما تنجمش تراهن ضد روحك';
    else if (e && e.message) text = `${fallback}: ${e.message}`;
    rumErr(id, text);
  }
  async function rumSettleDetached({ winnerPlayerId, loserPlayerId, roomKey, amount, reason }) {
    if (!roomKey || !amount) return;
    if (typeof settleWager !== 'function') { console.error('[RUM SETTLE] settleWager unavailable — MANUAL RECOVERY NEEDED', { roomKey, winnerPlayerId, loserPlayerId, amount, reason }); return; }
    try { await settleWager('rummy', roomKey, winnerPlayerId || null, loserPlayerId || null); console.log(`[RUM SETTLE] OK winner=${winnerPlayerId} loser=${loserPlayerId} reason=${reason}`); }
    catch (e) { console.error(`[RUM SETTLE] FAILED room=${roomKey} reason=${reason}:`, e && e.message); }
  }
  function rumFireSettle(r, snap, reason) {
    if (!snap || !snap.amount) return false;
    r.wagerSettled = true; r.wagerSettling = true; rumClearOfferTimer(r);
    rumSettleDetached({ ...snap, reason }).finally(() => { r.wagerSettling = false; });
    return true;
  }
  // نهاية اللعبة: الفايز = أقل سكور (بين اللي ما ماتوش)، تساوي = تعادل (رجوع الفلوس)
  function rumSettleOnEnd(r) {
    if (!r.wagerActive || r.wagerSettled || r.wagerSettling || !(r.wagerAmount > 0)) return;
    const alive = r.seats.filter(s => !s.dead), pool = alive.length ? alive : r.seats;
    const sorted = pool.slice().sort((a, b) => a.score - b.score);
    let win = sorted[0] || null;
    if (win && sorted.length > 1 && sorted[1].score === win.score) win = null;
    const lose = win ? r.seats.find(s => s.id !== win.id) : null;
    rumFireSettle(r, { winnerPlayerId: win ? win.id : null, loserPlayerId: lose ? lose.id : null, roomKey: wagerKey(r), amount: r.wagerAmount }, 'game_end');
  }
  async function rumCancelPending(r, reason) {
    if (!rumPendingOffer(r) || r.wagerSettling) return { ok: true, skipped: true };
    if (typeof cancelWager !== 'function') { rumResetWager(r); return { ok: true, skipped: true }; }
    const wagerId = r.wagerId, owner = r.wagerOwner;
    r.wagerSettled = true; r.wagerSettling = true; rumClearOfferTimer(r);
    try { await cancelWager(owner, wagerId); console.log(`[RUM CANCEL] ${wagerId} (${reason})`); return { ok: true }; }
    catch (e) {
      const code = e && (e.code || e.message);
      if (code === 'wager_not_pending') return { ok: false, active: true };
      console.error(`[RUM CANCEL] ${wagerId} failed (${reason}):`, e && e.message);
      return { ok: false, error: e };
    } finally { rumResetWager(r); r.wagerSettling = false; }
  }
  function rumStartOfferTimer(r, wagerId) {
    rumClearOfferTimer(r);
    r.offerExpiresAt = Date.now() + OFFER_TIMEOUT_MS;
    r.offerTimer = setTimeout(async () => {
      if (r.wagerId !== wagerId || r.wagerSettled || r.wagerActive || r.status !== 'wait') return;
      await rumCancelPending(r, 'offer_timeout').catch(e => console.error('[RUM] offer_timeout cancel failed:', e && e.message));
      r.seats.forEach(s => send(sockets.get(s.id), { type: 'rum:wager_expired', wagerId }));
      rumPush(r);
    }, OFFER_TIMEOUT_MS);
    if (typeof r.offerTimer.unref === 'function') r.offerTimer.unref();
  }
  async function rumOfferWager(id, rawAmount) {
    if (typeof createWager !== 'function') return rumErr(id, 'الرهان غير متوفر');
    const r = rumOf(id); if (!r) return;
    if (r.status !== 'wait') return rumErr(id, 'اللعبة بدات');
    if (r.seats.length !== 2) return rumErr(id, 'الرهان بين لاعبين اثنين فقط');
    const n = validAmount(rawAmount); if (n === null) return rumErr(id, 'مبلغ الرهان غالط (300 - 100000)');
    if (r.wagerId && !r.wagerSettled) return rumErr(id, 'فما عرض موجود');
    if (r.wagerCreating) return rumErr(id, 'عملية أخرى في الطريق');
    r.wagerCreating = true;
    try {
      const row = await createWager(id, 'rummy', wagerKey(r), n);
      if (r.status !== 'wait' || r.seats.length !== 2 || !r.seats.some(s => s.id === id) || (r.wagerId && !r.wagerSettled)) {
        try { await cancelWager(id, row.id); } catch (e) {}
        return rumErr(id, 'تبدّلت الطاولة — رجعنالك فلوسك');
      }
      r.wagerId = row.id; r.wagerOwner = id; r.wagerAmount = n; r.wagerActive = false; r.wagerSettled = false;
      rumStartOfferTimer(r, row.id);
      const other = r.seats.find(s => s.id !== id);
      if (other) send(sockets.get(other.id), { type: 'rum:wager_offer', wagerId: row.id, amount: n, by: id, byName: (players.get(id) || {}).name || 'لاعب', expiresAt: r.offerExpiresAt });
      rumPush(r);
    } catch (e) { rumWagerFailFrom(id, 'فشل العرض', e); }
    finally { r.wagerCreating = false; }
  }
  async function rumAcceptWager(id, rawWagerId) {
    const wagerId = validWagerId(rawWagerId); if (!wagerId) return rumErr(id, 'رقم رهان غالط');
    const r = rumOf(id); if (!r) return;
    if (r.status !== 'wait') return rumErr(id, 'اللعبة بدات');
    if (!rumPendingOffer(r) || r.wagerId !== wagerId) return rumErr(id, 'العرض ما عادش موجود');
    if (id === r.wagerOwner) return rumErr(id, 'ما تنجمش تقبل عرضك');
    if (r.seats.length !== 2) return rumErr(id, 'الرهان بين لاعبين اثنين فقط');
    if (r.wagerCreating) return rumErr(id, 'عملية أخرى في الطريق');
    r.wagerCreating = true;
    const amount = r.wagerAmount, roomKey = wagerKey(r);      // نحفظهم قبل أي await (ممكن الحقول تتصفّر)
    try {
      try { await acceptWager(id, wagerId); }
      catch (e) {
        const code = e && (e.code || e.message);
        rumWagerFailFrom(id, 'فشل القبول', e);
        if (code !== 'wager_not_pending' && code !== 'wager_not_found') await rumCancelPending(r, `accept_failed:${code || 'unknown'}`).catch(() => {});
        rumPush(r); return;
      }
      rumClearOfferTimer(r);
      if (r.seats.length !== 2 || r.status !== 'wait') {       // الخصم خرج وإحنا نقبلو → رجوع الفلوس للجميع
        r.wagerActive = true;
        rumFireSettle(r, { winnerPlayerId: null, loserPlayerId: null, roomKey, amount }, 'accept_room_gone');
        rumErr(id, 'تبدّلت الطاولة — رجعنا الفلوس للجميع'); rumPush(r); return;
      }
      r.wagerId = wagerId; r.wagerAmount = amount; r.wagerActive = true; r.wagerSettled = false;
      try { rumStartGame(r); }
      catch (e) {
        console.error('[RUM] start failed after accept:', e && e.message);
        rumFireSettle(r, { winnerPlayerId: null, loserPlayerId: null, roomKey, amount }, 'start_failed');
        rumErr(id, 'ما نجمناش نبداو اللعبة — رجعنا الفلوس'); rumPush(r);
      }
    } finally { r.wagerCreating = false; }
  }
  async function rumRejectWager(id, rawWagerId) {
    const wagerId = validWagerId(rawWagerId); if (!wagerId) return rumErr(id, 'رقم رهان غالط');
    const r = rumOf(id); if (!r) return;
    if (!rumPendingOffer(r) || r.wagerId !== wagerId) return rumErr(id, 'العرض ما عادش موجود');
    if (id === r.wagerOwner) return rumErr(id, 'ما تنجمش ترفض عرضك');
    if (r.wagerCreating) return rumErr(id, 'عملية أخرى في الطريق');
    r.wagerCreating = true;
    try {
      const ownerId = r.wagerOwner;
      const res = await rumCancelPending(r, `rejected_by:${id}`);
      if (res && res.active) rumErr(id, 'العرض ما عادش معلّق');
      else if (ownerId) send(sockets.get(ownerId), { type: 'rum:wager_rejected', wagerId, by: id });
      rumPush(r);
    } finally { r.wagerCreating = false; }
  }
  async function rumCounterWager(id, rawWagerId, rawAmount) {
    if (typeof createWager !== 'function') return rumErr(id, 'الرهان غير متوفر');
    const wagerId = validWagerId(rawWagerId); if (!wagerId) return rumErr(id, 'رقم رهان غالط');
    const r = rumOf(id); if (!r) return;
    if (r.status !== 'wait') return rumErr(id, 'اللعبة بدات');
    if (!rumPendingOffer(r) || r.wagerId !== wagerId) return rumErr(id, 'العرض ما عادش موجود');
    if (id === r.wagerOwner) return rumErr(id, 'ما تنجمش تعمل عرض مضاد على عرضك');
    if (r.seats.length !== 2) return rumErr(id, 'الرهان بين لاعبين اثنين فقط');
    const n = validAmount(rawAmount); if (n === null) return rumErr(id, 'مبلغ الرهان غالط (300 - 100000)');
    if (r.wagerCreating) return rumErr(id, 'عملية أخرى في الطريق');
    r.wagerCreating = true;
    try {
      const originalOwner = r.wagerOwner;
      const cres = await rumCancelPending(r, `countered_by:${id}`);
      if (cres && cres.active) { rumErr(id, 'العرض تقبّل قبل'); rumPush(r); return; }
      const row = await createWager(id, 'rummy', wagerKey(r), n);
      if (r.status !== 'wait' || r.seats.length !== 2 || !r.seats.some(s => s.id === id)) {
        try { await cancelWager(id, row.id); } catch (e) {}
        return rumErr(id, 'تبدّلت الطاولة — رجعنالك فلوسك');
      }
      r.wagerId = row.id; r.wagerOwner = id; r.wagerAmount = n; r.wagerActive = false; r.wagerSettled = false;
      rumStartOfferTimer(r, row.id);
      if (originalOwner && originalOwner !== id && r.seats.some(s => s.id === originalOwner))
        send(sockets.get(originalOwner), { type: 'rum:wager_offer', wagerId: row.id, amount: n, by: id, byName: (players.get(id) || {}).name || 'لاعب', isCounter: true, expiresAt: r.offerExpiresAt });
      rumPush(r);
    } catch (e) { rumWagerFailFrom(id, 'فشل العرض المضاد', e); rumPush(r); }
    finally { r.wagerCreating = false; }
  }
  // الخروج: قبل البداية يلغي العرض، وفي نص اللعبة الخارج يخسر الرهان
  function rumLeaveW(id) {
    const r = rumOf(id);
    if (r) {
      if (r.wagerActive && !r.wagerSettled && !r.wagerSettling && r.wagerAmount > 0 && (r.status === 'play' || r.status === 'round')) {
        const opp = r.seats.find(s => s.id !== id && !s.left);
        rumFireSettle(r, { winnerPlayerId: opp ? opp.id : null, loserPlayerId: id, roomKey: wagerKey(r), amount: r.wagerAmount }, 'leave_during_game');
      } else if (r.status === 'wait' && rumPendingOffer(r)) {
        rumCancelPending(r, `player_left_waiting:${id}`).catch(e => console.error('[RUM] cancel on leave failed:', e && e.message));
      }
    }
    rumLeave(id);
  }

  function rumJoin(id, roomId) {
    rumLeaveW(id);
    if (!/^[A-Za-z0-9_,.\-]{1,40}$/.test(roomId)) return rumErr(id, 'رقم طاولة غالط');
    const key = 'rum:' + roomId; let r = RUM.get(key);
    if (!r) { r = { id: key, seats: [], hostId: id, status: 'wait', stock: [], disc: [], melds: [], min: 51, turn: 0, ph: 'draw', first: false, took: null, laid: [], wasOpen: false, rows: null, over: false, winner: '', ready: new Set(), n: 0, starterId: null, buyId: null, buyUsed: false }; RUM.set(key, r); rumWagerInit(r); }
    if (r.status !== 'wait') return rumErr(id, 'اللعبة بدات في هذي الطاولة');
    if (rumPendingOffer(r)) return rumErr(id, 'فما عرض رهان معلّق في هذي الطاولة — استنى لين ينتهي');
    if (r.seats.length >= 4) return rumErr(id, 'الطاولة مليانة (4 لاعبين)');
    r.seats.push({ id, name: (players.get(id) || {}).name || 'لاعب', hand: [], opened: false, score: 0, dead: false, out: false, left: false, h45: false, bought: false, pending: false });
    if (r.seats.length === 4) return rumStartGame(r);   // الطاولة كملت: تبدا وحدها
    rumPush(r);
  }
  function rumStartGame(r) {
    r.n = r.seats.length; r.over = false; r.winner = '';
    r.seats.forEach(s => { s.score = 0; s.dead = false; s.bought = false; s.pending = false; }); r.buyId = null; r.buyUsed = false;
    rumDeal(r, crypto.randomInt(r.n));
  }
  function rumStart(id) {
    const r = rumOf(id); if (!r || r.status !== 'wait') return;
    if (r.seats.length < 2) return rumErr(id, 'تحتاج لاعبين على الأقل');
    if (rumPendingOffer(r)) return rumErr(id, 'فما عرض رهان معلّق — اقبله ولا ارفضه ولا استنى ينتهي');
    rumStartGame(r);
  }
  function rumAgain(id) {
    const r = rumOf(id); if (!r || r.status !== 'end') return;
    r.seats = r.seats.filter(s => !s.left);
    if (r.seats.length < 2) return rumErr(id, 'تحتاج لاعبين على الأقل');
    if (r.wagerSettling) return rumErr(id, 'الرهان الفارط توّا يتسوّى — استنى ثواني');
    rumResetWager(r); r.wagerSettled = false;
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
    if (i !== r.turn || !rumActive(s)) { rumErr(id, 'مش دورك'); return null; }
    if (r.ph !== ph) { rumErr(id, ph === 'draw' ? 'ما تنجمش تسحب توّا' : 'اسحب ورقة أول'); return null; }
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
  function rumUndo(id) { rumErr(id, 'ما فماش رجوع: المطيشة اللي هزيتها لازم تجيبك المنع ولا الفرشة'); }
  function rumPenalty(r, i, text) {   // 100 + تخرج من الجولة + كفك يرجع للكومة
    const s = r.seats[i];
    s.score += 100; s.out = true; r.stock.unshift(...s.hand); s.hand = [];
    send(sockets.get(s.id), { type: 'rum:note', text: text + ' — أخذت 100 وتستنى الجولة تكمل' });
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
  function rumLay(id, d) {          // منع (أول مرة، بالحلان) أو تنزيل تشكيلات بعد المنع
    const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
    const ps = rumParse(s, d.groups); if (!ps) return rumErr(id, 'تشكيلة غالطة');
    if (!ps.length && s.opened) return rumErr(id, 'ما فماش تشكيلة تتنزّل');
    const tot = ps.reduce((a, p) => a + p.m.pts, 0), used = ps.reduce((a, p) => a + p.cs.length, 0);
    if (s.hand.length === used && !(s.h45 || ps.some(p => p.cs.length >= 4))) return rumErr(id, 'الفرشة لازم فيها باكو 4 ولا 5 على الأقل');
    if (!s.opened) {
      if (tot < r.min) {
        if (r.took && RM.pts(RM.solve(s.hand)) < r.min) return rumPenalty(r, i, `هزيت المطيشة وما جبتش ${r.min} ❌`);
        return rumErr(id, `الحلان لازم ${r.min} وانت عندك ${tot}`);
      }
      s.opened = true; r.min = tot + 1;
    }
    const u = new Set();
    ps.forEach(p => { r.melds.push({ o: i, cards: p.m.ord, k: p.m.k }); r.laid.push({ n: p.cs.length }); if (p.cs.length >= 4) s.h45 = true; p.cs.forEach(c => u.add(c.id)); });
    s.hand = s.hand.filter(c => !u.has(c.id));
    if (!s.hand.length) return rumEnd(r, i);
    rumPush(r);
  }
  function rumPlace(id, d) {        // بلاص + هزان الجوكر (لازم مانع)
    const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
    if (!s.opened) return rumErr(id, 'لازم تمنع قبل ما تبلّص');
    const m = r.melds[+d.meld]; if (!m || !Array.isArray(d.cards)) return rumErr(id, 'باكو غالط');
    for (const cid of d.cards) {
      const c = s.hand.find(h => h.id === +cid); if (!c) break;
      const sw = RM.trySwap(m, c);
      if (sw) { m.cards = sw.r.ord; m.k = sw.r.k; s.hand = s.hand.filter(h => h !== c); s.hand.push(sw.j); send(sockets.get(id), { type: 'rum:note', text: 'هزيت الجوكر 🃏' }); if (m.cards.length >= 4) s.h45 = true; continue; }
      const rr = RM.meld([...m.cards, c]); if (!rr) { rumErr(id, 'الورقة ما تنجمش تتبلاص هنا'); break; }
      m.cards = rr.ord; m.k = rr.k; s.hand = s.hand.filter(h => h !== c); if (m.cards.length >= 4) s.h45 = true;
    }
    if (!s.hand.length) return rumEnd(r, i);
    rumPush(r);
  }
  function rumDiscard(id, d) {
    const x = rumCur(id, 'play'); if (!x) return; const { r, i, s } = x;
    const c = s.hand.find(h => h.id === +d.card); if (!c) return rumErr(id, 'اختار ورقة باش تطيّشها');
    const legal = s.hand.filter(h => h.r && !rumPlaceable(r, h));       // ما تطيّشش جوكر ولا ورقة تتبلاص
    if (legal.length && !legal.includes(c)) return rumErr(id, !c.r ? 'الجوكر ممنوع يطيش 🃏❌' : 'ورقة بلاص ممنوع تطيشها ❌ لازم تبلاصيها');
    if (r.took && !s.opened) return rumPenalty(r, i, 'هزيت المطيشة وما منعتش ولا فرشت ❌');
    if (s.hand.length === 1 && !s.h45) return rumErr(id, 'ما تنجمش تفرش: لازم باكو فيه 4 ولا 5');
    s.hand = s.hand.filter(h => h !== c); r.disc.push(c);
    if (!s.hand.length) return rumEnd(r, i);
    rumAdvance(r);
  }
  function rumFlush(id) {           // فرشت 🏁 — السيرفر يثبت، وإلا 100 وتخرج من الجولة
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
      return rumPenalty(r, i, left.length > 1 ? `فرشة غالطة ❌ باقيلك ${left.length} ورقات ما تتبلاصش` : `فرشة غالطة ❌ عندك ${total} مش ${needed} (${own} باكو + ${placed} بلاص)`);
    if (!has45) return rumPenalty(r, i, 'فرشة غالطة ❌ لازم باكو فيه 4 ولا 5 على الأقل (حتى بالبلاص)');
    r.melds = all; s.opened = true; s.hand = []; if (left[0]) r.disc.push(left[0]);
    rumEnd(r, i);
  }
  function rumEnd(r, w) {           // w = فهرس الفارش، أو null (الورق وفى)
    r.rows = r.seats.map((s, i) => {
      if (s.dead) return null;
      let d, note = '';
      if (i === w) { d = -10; note = 'فرش 🏆'; }
      else if (s.out) { d = 0; note = s.left ? 'غادر (أخذ 100)' : 'غلط في الفرشة (أخذ 100)'; }
      else if (!s.opened) d = 100;
      else d = s.hand.reduce((a, c) => a + RM.hv(c), 0);
      s.score += d; return { sid: s.id, name: s.name, d, score: s.score, note };
    }).filter(Boolean);
    r.starterId = w != null ? r.seats[w].id : (r.seats[r.turn] || {}).id;
    const dying = r.seats.filter(s => !s.dead && s.score >= 300);
    r.buyId = null;
    dying.forEach(s => {
      const row = r.rows.find(x => x.sid === s.id);
      if (dying.length === 1 && !r.buyUsed && !s.bought && r.n >= 3) { r.buyId = s.id; r.buyUsed = true; s.pending = true; if (row) row.note += ' 💀 فوّت 300 — يقدر يشري'; }
      else { s.dead = true; if (row) row.note += s.bought ? ' 💀 مات بعد الشراء (دوبل)' : ' 💀'; }
    });
    r.seats.forEach(s => { s.out = false; });
    r.seats = r.seats.filter(s => !s.left);
    if (!r.seats.some(s => s.id === r.hostId) && r.seats[0]) r.hostId = r.seats[0].id;
    r.ready = new Set(); rumCheckOver(r); rumPush(r);
  }
  function rumCheckOver(r) {
    const alive = r.seats.filter(s => !s.dead);
    r.over = alive.length <= Math.max(1, r.n - 2) || r.seats.length < 2;
    if (r.over) {
      const pool = alive.length ? alive : r.seats, best = pool.slice().sort((a, b) => a.score - b.score)[0];
      r.winner = best ? best.name : ''; r.status = 'end'; r.buyId = null; rumSettleOnEnd(r);
    } else r.status = 'round';
  }
  function rumBuy(id, yes) {        // الشراء: ترجع بأكثر سكور في الطاولة
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
    if (r.status === 'play') {      // خرج في نص الجولة: 100 وكفو يرجع للكومة
      s.left = true; s.out = true; s.score += 100; r.stock.unshift(...s.hand); s.hand = [];
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
        case 'rum:join':    if (players.has(id)) rumJoin(id, String(d.room || '').slice(0, 40)); break;
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
        case 'rum:leave':   rumLeaveW(id); break;
        case 'rum:wager_offer':   rumAsync(rumOfferWager)(id, d.amount); break;
        case 'rum:wager_accept':  rumAsync(rumAcceptWager)(id, d.wagerId); break;
        case 'rum:wager_reject':  rumAsync(rumRejectWager)(id, d.wagerId); break;
        case 'rum:wager_counter': rumAsync(rumCounterWager)(id, d.wagerId, d.amount); break;
      }
    },
    leave: rumLeaveW,
    shutdown() { for (const r of RUM.values()) rumClearOfferTimer(r); RUM.clear(); },
    _test: { RM, RUM },
  };
};

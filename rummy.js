// games/rummy.js
// Café Life — Rummy Server (FORTRESS EDITION - Clean Rewrite)
// متوافق 100% مع الكلاينت الجديد

'use strict';

module.exports = function createRummyGame({
  send,
  sockets,
  players,
  crypto,
  createWager,
  acceptWager,
  cancelWager,
  settleWager,
}) {

  // ========================================================================
  // 1. محرك اللعبة (Pure Engine) — لا يوجد أي IO هنا
  // ========================================================================
  const RM = (() => {
    // قيمة الورقة العادية
    const cardValue = (r) => (r >= 10 || r === 1) ? 10 : r;

    // قيمة الورقة عند حساب اليد في النهاية
    const handValue = (c) => c.r ? cardValue(c.r) : 20;

    // قيمة الموضع في التسلسل
    const seqValue = (p) => p === 1 ? 1 : (p >= 10 ? 10 : p);

    /**
     * يتحقق إذا كانت مجموعة الأوراق صالحة (مجموعة أو تسلسل)
     * يرجع { k: 'set'|'seq', pts, ord } أو null
     */
    function checkMeld(cards) {
      const n = cards.length;
      if (n < 3) return null;

      const jokers = cards.filter(c => !c.r);
      const normals = cards.filter(c => c.r);
      if (!normals.length) return null;

      // --- مجموعة (Set): نفس الرقم + بدلات مختلفة ---
      const suits = new Set(normals.map(c => c.s));
      if (
        n <= 5 &&
        normals.every(c => c.r === normals[0].r) &&
        suits.size === normals.length
      ) {
        return {
          k: 'set',
          pts: cardValue(normals[0].r) * n,
          ord: cards,
        };
      }

      // --- تسلسل (Sequence) ---
      if (suits.size !== 1 || new Set(normals.map(c => c.r)).size !== normals.length) {
        return null;
      }

      let best = null;

      for (const useHighAce of [false, true]) {
        const low = useHighAce ? 2 : 1;
        const high = useHighAce ? 14 : 13;
        if (high - low + 1 < n) continue;

        const values = normals
          .map(c => ({ c, p: (c.r === 1 && useHighAce) ? 14 : c.r }))
          .sort((a, b) => a.p - b.p);

        const min = values[0].p;
        const max = values[values.length - 1].p;

        if (max - min + 1 - values.length > jokers.length) continue;

        const start = Math.min(min, high - n + 1);
        if (start + n - 1 < max) continue;

        const remainingJokers = [...jokers];
        const ordered = [];
        let points = 0;

        for (let p = start; p < start + n; p++) {
          const found = values.find(x => x.p === p);
          ordered.push(found ? found.c : remainingJokers.pop());
          points += seqValue(p);
        }

        if (!best || points > best.pts) {
          best = { k: 'seq', pts: points, ord: ordered };
        }
      }

      return best;
    }

    /**
     * يبحث عن كل المجموعات الممكنة التي تحتوي على ورقة معينة
     */
    function findCandidates(remaining, target) {
      const jokers = remaining.filter(c => !c.r);
      const others = remaining.filter(c => c.r && c !== target);
      const results = [];
      const seen = new Set();

      const add = (cards) => {
        const m = checkMeld(cards);
        if (!m) return;
        const key = cards.map(c => c.id).sort((a, b) => a - b).join();
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ cs: cards, m });
      };

      // مجموعات (Sets)
      const usedSuits = new Set([target.s]);
      const sameRank = [];
      others.forEach(c => {
        if (c.r === target.r && !usedSuits.has(c.s)) {
          usedSuits.add(c.s);
          sameRank.push(c);
        }
      });

      for (let mask = 0; mask < (1 << sameRank.length); mask++) {
        const group = [target];
        sameRank.forEach((c, i) => {
          if ((mask >> i) & 1) group.push(c);
        });
        for (let j = 0; j <= Math.min(jokers.length, 2); j++) {
          if (group.length + j >= 3 && group.length + j <= 5) {
            add([...group, ...jokers.slice(0, j)]);
          }
        }
      }

      // تسلسلات (Sequences)
      const byRank = {};
      others.forEach(c => {
        if (c.s === target.s && !byRank[c.r]) byRank[c.r] = c;
      });

      for (const useHighAce of [false, true]) {
        const low = useHighAce ? 2 : 1;
        const high = useHighAce ? 14 : 13;
        const targetPos = (target.r === 1 && useHighAce) ? 14 : target.r;
        if (targetPos < low || targetPos > high) continue;

        for (let a = Math.max(low, targetPos - 13); a <= targetPos; a++) {
          for (let b = targetPos; b <= high; b++) {
            if (b - a < 2) continue;

            const sequence = [];
            let needed = 0;

            for (let p = a; p <= b; p++) {
              const card = p === targetPos ? target : byRank[p === 14 ? 1 : p];
              if (card) sequence.push(card);
              else needed++;
            }

            if (needed > jokers.length || needed > 2) continue;
            add([...sequence, ...jokers.slice(0, needed)]);
          }
        }
      }

      return results;
    }

    /**
     * خوارزمية البحث عن أفضل ترتيب للمجموعات
     */
    function solveHand(hand, preferOut = false) {
      const memo = new Map();

      const search = (remaining) => {
        const key = remaining.map(c => c.id).sort((a, b) => a - b).join();
        if (memo.has(key)) return memo.get(key);

        const first = remaining.find(c => c.r);
        let best = {
          s: preferOut ? 0 : -remaining.length,
          ms: [],
        };

        if (first) {
          // خيار: تجاهل الورقة
          const skip = search(remaining.filter(c => c !== first));
          best = {
            s: skip.s - (preferOut ? 0 : 1),
            ms: skip.ms,
          };

          if (memo.size < 60000) {
            for (const { cs, m } of findCandidates(remaining, first)) {
              const used = new Set(cs.map(c => c.id));
              const rest = search(remaining.filter(c => !used.has(c.id)));

              const score = rest.s + (
                preferOut
                  ? cs.length * 1000 + (cs.length >= 4 ? 50 : 0) + m.pts / 100
                  : m.pts * 20
              );

              if (score > best.s) {
                best = { s: score, ms: [m.ord, ...rest.ms] };
              }
            }
          }
        }

        memo.set(key, best);
        return best;
      };

      return search(hand).ms;
    }

    function getJokerSlot(meld, index) {
      const cards = meld.cards;
      const jIdx = cards.findIndex(c => c.r);
      const jCard = cards[jIdx];
      const jPos = (jCard.r === 1 && jIdx > 0) ? 14 : jCard.r;
      const pos = jPos + (index - jIdx);
      return { r: pos === 14 ? 1 : pos, s: jCard.s };
    }

    function trySwapJoker(meld, card) {
      if (!card.r) return null;

      for (let k = 0; k < meld.cards.length; k++) {
        if (meld.cards[k].r) continue;

        if (meld.k === 'seq') {
          const wanted = getJokerSlot(meld, k);
          if (wanted.r !== card.r || wanted.s !== card.s) continue;
        }

        const newCards = [...meld.cards];
        newCards[k] = card;
        const result = checkMeld(newCards);
        if (result) return { r: result, j: meld.cards[k] };
      }
      return null;
    }

    const totalPoints = (melds) =>
      melds.reduce((sum, g) => sum + checkMeld(g).pts, 0);

    return {
      handValue,
      checkMeld,
      solveHand,
      trySwapJoker,
      totalPoints,
    };
  })();

  // ========================================================================
  // 2. الثوابت
  // ========================================================================
  const ROOMS = new Map();
  const OFFER_TIMEOUT_MS = 60 * 1000;
  const MIN_WAGER = 300;
  const MAX_WAGER = 100000;
  const MAX_ROOM_ID_LEN = 40;
  const MAX_WAGER_ID_LEN = 64;
  const PREFIX = 'rum:';

  // أكواد أخطاء الرهان (ثابتة للكلاينت)
  const WAGER_ERRORS = Object.freeze({
    ROOM_ACTIVE: 'room_has_active_wager',
    INSUFFICIENT: 'insufficient_balance',
    NOT_PENDING: 'wager_not_pending',
    NOT_FOUND: 'wager_not_found',
    BUSY: 'wager_busy',
    INVALID_AMOUNT: 'invalid_amount',
  });

  // ========================================================================
  // 3. أدوات مساعدة
  // ========================================================================
  const roomKeyOf = (r) =>
    r.id.startsWith(PREFIX) ? r.id.slice(PREFIX.length) : r.id;

  const isActive = (s) => !s.dead && !s.out && !s.left;

  const sendError = (id, text) =>
    send(sockets.get(id), { type: 'rum:err', text });

  function findRoomByPlayer(id) {
    for (const r of ROOMS.values()) {
      if (r.seats.some(s => s.id === id && !s.left)) return r;
    }
    return null;
  }

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  function createDeck() {
    const deck = [];
    let id = 0;
    // ورقتين من كل نوع
    for (let copy = 0; copy < 2; copy++) {
      for (let s = 0; s < 4; s++) {
        for (let r = 1; r <= 13; r++) {
          deck.push({ id: id++, r, s });
        }
      }
    }
    // 4 جوكر
    for (let i = 0; i < 4; i++) {
      deck.push({ id: id++, r: 0, s: -1 });
    }
    return shuffle(deck);
  }

  // تحقق من المدخلات
  function validateRoomId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > MAX_ROOM_ID_LEN) return null;
    if (!/^[A-Za-z0-9_\-]+$/.test(s)) return null;
    return s;
  }

  function validateWagerId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s.length > MAX_WAGER_ID_LEN) return null;
    if (!/^wg_[A-Za-z0-9]+$/.test(s)) return null;
    return s;
  }

  function validateAmount(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < MIN_WAGER || n > MAX_WAGER) return null;
    return n;
  }

  // ========================================================================
  // 4. إدارة حالة الغرفة
  // ========================================================================
  function clearOfferTimer(r) {
    if (r.offerTimer) {
      try { clearTimeout(r.offerTimer); } catch {}
      r.offerTimer = null;
    }
    r.offerExpiresAt = 0;
  }

  function resetWagerFields(r) {
    clearOfferTimer(r);
    r.wagerAmount = 0;
    r.wagerId = null;
    r.wagerRoomId = null;
    r.wagerOwner = null;
    r.pendingWager = 0;
  }

  function getOffer(r) {
    if (!r.wagerId || r.wagerSettled) return null;
    return {
      wagerId: r.wagerId,
      amount: r.wagerAmount,
      by: r.wagerOwner,
      byName: (r.seats.find(s => s.id === r.wagerOwner) || {}).name || '',
      expiresAt: r.offerExpiresAt || 0,
    };
  }

  /**
   * يبني حالة اللعبة التي تُرسل للكلاينت
   */
  function buildState(r, seatIndex) {
    const me = r.seats[seatIndex];
    return {
      type: 'rum:state',
      room: roomKeyOf(r),
      status: r.status,
      host: r.hostId === me.id,
      hostIdx: r.seats.findIndex(s => s.id === r.hostId),
      you: seatIndex,
      seats: r.seats.map(s => ({
        name: s.name,
        score: s.score,
        opened: s.opened,
        out: s.out,
        dead: s.dead,
        n: s.hand.length,
      })),
      hand: me.hand,
      melds: r.melds,
      disc: r.disc[r.disc.length - 1] || null,
      stock: r.stock.length,
      min: r.min,
      turn: r.turn,
      ph: r.ph,
      first: r.first,
      wasOpen: r.wasOpen,
      took: (seatIndex === r.turn && r.took) ? r.took.id : null,
      rows: r.rows,
      buy: r.buyId === me.id,
      buyName: (r.seats.find(s => s.id === r.buyId) || {}).name || '',
      buyScore: Math.max(0, ...r.seats.filter(s => s.id !== r.buyId && !s.dead).map(s => s.score)),
      over: r.over,
      winner: r.winner,
      ready: [...r.ready],
      wager: r.wagerAmount || null,
      wagerId: r.wagerId || null,
      offer: getOffer(r),
    };
  }

  const pushState = (r) => {
    r.seats.forEach((s, i) => {
      send(sockets.get(s.id), buildState(r, i));
    });
  };

  // ========================================================================
  // 5. إدارة الرهان (Cancel / Settle)
  // ========================================================================
  async function cancelPendingWager(r, reason) {
    if (!r.wagerId || r.wagerSettled) {
      resetWagerFields(r);
      return;
    }
    if (r.wagerOwner == null) {
      resetWagerFields(r);
      return;
    }
    if (typeof cancelWager !== 'function') {
      resetWagerFields(r);
      return;
    }

    const wagerId = r.wagerId;
    const owner = r.wagerOwner;

    r.wagerSettled = true;
    clearOfferTimer(r);

    try {
      await cancelWager(owner, wagerId);
      console.log(`[RUM WAGER] أُلغي \( {wagerId} ( \){reason})`);
    } catch (e) {
      const code = e && (e.code || e.message);
      if (code === WAGER_ERRORS.NOT_PENDING) {
        console.log(`[RUM WAGER] \( {wagerId} كان ملغى مسبقاً ( \){reason})`);
      } else {
        console.error(`[RUM WAGER] فشل إلغاء ${wagerId}:`, e && e.message);
      }
    } finally {
      resetWagerFields(r);
    }
  }

  function resolveWinnerId(r) {
    if (!r || !r.winner) return null;
    const byName = r.seats.find(s => s.name === r.winner && !s.dead && !s.left);
    if (byName) return byName.id;
    if (r.starterId && r.seats.some(s => s.id === r.starterId && !s.dead && !s.left)) {
      return r.starterId;
    }
    return null;
  }

  async function settleRoomWager(r, winnerId) {
    if (!r.wagerAmount || r.wagerSettled) {
      console.log(`[RUM WAGER] تخطي التسوية: amount=\( {r.wagerAmount}, settled= \){r.wagerSettled}`);
      return;
    }

    const roomKey = r.wagerRoomId || roomKeyOf(r);
    if (!roomKey) {
      console.log('[RUM WAGER] تخطي: لا يوجد مفتاح غرفة');
      return;
    }

    r.wagerSettled = true;
    clearOfferTimer(r);

    let loserId = null;
    if (winnerId && r.seats.length === 2) {
      const other = r.seats.find(s => s.id !== winnerId && !s.left);
      loserId = other ? other.id : null;
    }

    if (typeof settleWager !== 'function') {
      console.error('[RUM WAGER] settleWager غير متوفر — يحتاج استرجاع يدوي');
      return;
    }

    try {
      await settleWager('rummy', roomKey, winnerId, loserId);
      console.log(`[RUM WAGER] تمت التسوية — فائز=\( {winnerId}, خاسر= \){loserId}`);
    } catch (e) {
      console.error('[RUM WAGER] فشلت التسوية — سيتم الاسترجاع لاحقاً:', e && e.message);
    }
  }

  // ========================================================================
  // 6. مؤقت عرض الرهان
  // ========================================================================
  function startOfferTimer(r, wagerId) {
    clearOfferTimer(r);
    r.offerExpiresAt = Date.now() + OFFER_TIMEOUT_MS;

    r.offerTimer = setTimeout(async () => {
      if (r.wagerId !== wagerId || r.wagerSettled) return;
      if (r.status !== 'wait') return;

      console.log(`[RUM OFFER] انتهى الوقت ${wagerId} (غرفة ${r.id})`);
      await cancelPendingWager(r, 'offer_timeout');

      for (const s of r.seats) {
        send(sockets.get(s.id), { type: 'rum:wager_expired', wagerId });
      }
      pushState(r);
    }, OFFER_TIMEOUT_MS);

    if (typeof r.offerTimer.unref === 'function') {
      r.offerTimer.unref();
    }
  }

  // ========================================================================
  // 7. الانضمام للغرفة
  // ========================================================================
  async function handleJoin(id, rawRoomId) {
    const roomId = validateRoomId(rawRoomId);
    if (!roomId) return sendError(id, 'رقم الغرفة غير صالح');

    // الخروج من أي غرفة أخرى أولاً
    for (const [rid, other] of ROOMS) {
      if (rid === PREFIX + roomId) continue;
      if (other.seats.some(s => s.id === id && !s.left)) {
        handleLeave(id);
        break;
      }
    }

    const key = PREFIX + roomId;
    let r = ROOMS.get(key);

    if (!r) {
      r = {
        id: key,
        seats: [],
        hostId: id,
        status: 'wait',
        stock: [],
        disc: [],
        melds: [],
        min: 51,
        turn: 0,
        ph: 'draw',
        first: false,
        took: null,
        laid: [],
        wasOpen: false,
        rows: null,
        over: false,
        winner: '',
        ready: new Set(),
        n: 0,
        starterId: null,
        buyId: null,
        buyUsed: false,
        // رهان
        wagerAmount: 0,
        wagerId: null,
        wagerRoomId: null,
        wagerSettled: false,
        pendingWager: 0,
        wagerOwner: null,
        offerTimer: null,
        offerExpiresAt: 0,
        wagerCreating: false,
        wagerSettling: false,
      };
      ROOMS.set(key, r);
    }

    if (r.status !== 'wait') return sendError(id, 'اللعبة بدأت بالفعل في هذه الغرفة');
    if (r.seats.length >= 4) return sendError(id, 'الغرفة ممتلئة (أقصى 4 لاعبين)');

    const alreadyIn = r.seats.some(s => s.id === id);
    if (!alreadyIn) {
      r.seats.push({
        id,
        name: (players.get(id) || {}).name || 'لاعب',
        hand: [],
        opened: false,
        score: 0,
        dead: false,
        out: false,
        left: false,
        h45: false,
        bought: false,
        pending: false,
      });
    }

    // إذا دخل لاعب ثالث → إلغاء الرهان الحالي
    if (r.wagerId && !r.wagerSettled && r.seats.length > 2) {
      await cancelPendingWager(r, `third_player:${id}`).catch(e => {
        console.error('[RUM] فشل إلغاء الرهان عند دخول لاعب ثالث:', e && e.message);
      });
    }

    // إعادة تشغيل المؤقت إذا كان فيه عرض رهان ولاعبين فقط
    if (r.seats.length === 2 && r.wagerId && !r.wagerSettled && !r.offerTimer) {
      startOfferTimer(r, r.wagerId);
    }

    pushState(r);
  }

  // ========================================================================
  // 8. عروض الرهان
  // ========================================================================
  async function handleOfferWager(id, amount) {
    const r = findRoomByPlayer(id);
    if (!r) return;
    if (r.status !== 'wait') return sendError(id, 'اللعبة بدأت بالفعل');
    if (r.seats.length !== 2) return sendError(id, 'الرهان يحتاج لاعبين اثنين فقط');
    if (!r.seats.some(s => s.id === id)) return sendError(id, 'أنت لست جالساً على الطاولة');

    const n = validateAmount(amount);
    if (n === null) return sendError(id, 'مبلغ الرهان غير صالح');

    if (r.wagerId && !r.wagerSettled) return sendError(id, 'يوجد عرض رهان بالفعل');

    if (r.wagerCreating) return sendError(id, 'جارٍ إنشاء عرض آخر');
    r.wagerCreating = true;

    try {
      const row = await createWager(id, 'rummy', roomKeyOf(r), n);

      // إعادة التحقق بعد الانتظار
      if (r.wagerId && !r.wagerSettled) {
        try { await cancelWager(id, row.id); } catch {}
        return sendError(id, 'ظهر عرض آخر أثناء الإنشاء');
      }

      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = roomKeyOf(r);
      r.wagerSettled = false;
      r.pendingWager = 0;

      startOfferTimer(r, row.id);

      const other = r.seats.find(s => s.id !== id);
      if (other) {
        send(sockets.get(other.id), {
          type: 'rum:wager_offer',
          wagerId: row.id,
          amount: n,
          by: id,
          byName: (players.get(id) || {}).name || 'لاعب',
          expiresAt: r.offerExpiresAt,
        });
      }
      pushState(r);
    } catch (e) {
      const code = e && e.code;
      if (code === WAGER_ERRORS.ROOM_ACTIVE) {
        return sendError(id, 'يوجد رهان نشط آخر، حاول بعد قليل');
      }
      if (code === WAGER_ERRORS.INSUFFICIENT) {
        return sendError(id, `رصيدك غير كافٍ (تحتاج ${e.required}، عندك ${e.available})`);
      }
      sendError(id, 'فشل عرض الرهان: ' + (e && e.message));
    } finally {
      r.wagerCreating = false;
    }
  }

  async function handleAcceptWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return sendError(id, 'معرّف الرهان غير صالح');

    const r = findRoomByPlayer(id);
    if (!r) return;
    if (r.status !== 'wait') return sendError(id, 'اللعبة بدأت بالفعل');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return sendError(id, 'العرض غير متاح');
    }
    if (id === r.wagerOwner) return sendError(id, 'لا يمكنك قبول عرضك الخاص');

    if (r.wagerCreating) return sendError(id, 'يوجد إجراء آخر قيد التنفيذ');
    r.wagerCreating = true;

    try {
      try {
        await acceptWager(id, wagerId);
      } catch (e) {
        const code = e && e.code;
        if (code === WAGER_ERRORS.INSUFFICIENT) {
          sendError(id, `رصيدك غير كافٍ (تحتاج ${e.required}، عندك ${e.available})`);
        } else if (code === WAGER_ERRORS.NOT_PENDING) {
          sendError(id, 'انتهى العرض أو تم أخذه');
        } else if (code === WAGER_ERRORS.NOT_FOUND) {
          sendError(id, 'الرهان غير موجود');
        } else {
          sendError(id, 'فشل القبول: ' + (e && e.message));
        }

        if (!e || e.code !== WAGER_ERRORS.NOT_PENDING) {
          await cancelPendingWager(r, `accept_failed:${(e && (e.code || e.message)) || 'unknown'}`);
        }
        pushState(r);
        return;
      }

      // نجح القبول
      clearOfferTimer(r);
      r.wagerRoomId = roomKeyOf(r);
      r.pendingWager = 0;

      try {
        startGame(r);
      } catch (startErr) {
        console.error('[RUM] فشل بدء اللعبة بعد القبول:', startErr && startErr.message);
        r.wagerSettled = true;
        if (typeof settleWager === 'function') {
          await settleWager('rummy', r.wagerRoomId, null).catch(e =>
            console.error('[RUM] فشل استرجاع الرهان بعد فشل البدء:', e && e.message)
          );
        }
        sendError(id, 'تعذر بدء اللعبة، تم استرجاع الرهان');
        pushState(r);
        return;
      }

      pushState(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  async function handleRejectWager(id, rawWagerId) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return sendError(id, 'معرّف الرهان غير صالح');

    const r = findRoomByPlayer(id);
    if (!r) return;
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return sendError(id, 'العرض غير متاح');
    }
    if (id === r.wagerOwner) return sendError(id, 'لا يمكنك رفض عرضك الخاص');

    const ownerId = r.wagerOwner;
    await cancelPendingWager(r, `rejected_by:${id}`);

    if (ownerId) {
      send(sockets.get(ownerId), {
        type: 'rum:wager_rejected',
        wagerId,
        by: id,
      });
    }
    pushState(r);
  }

  async function handleCounterWager(id, rawWagerId, amount) {
    const wagerId = validateWagerId(rawWagerId);
    if (!wagerId) return sendError(id, 'معرّف الرهان غير صالح');

    const r = findRoomByPlayer(id);
    if (!r) return;
    if (r.status !== 'wait') return sendError(id, 'اللعبة بدأت بالفعل');
    if (r.seats.length !== 2) return sendError(id, 'الرهان يحتاج لاعبين اثنين فقط');
    if (!r.wagerId || r.wagerSettled || r.wagerId !== wagerId) {
      return sendError(id, 'العرض غير متاح');
    }
    if (id === r.wagerOwner) return sendError(id, 'لا يمكنك الرد على عرضك الخاص');

    const n = validateAmount(amount);
    if (n === null) return sendError(id, 'مبلغ الرهان غير صالح');

    if (r.wagerCreating) return sendError(id, 'يوجد إجراء آخر قيد التنفيذ');
    r.wagerCreating = true;

    const originalOwner = r.wagerOwner;
    await cancelPendingWager(r, `countered_by:${id}`);

    try {
      const row = await createWager(id, 'rummy', roomKeyOf(r), n);

      r.wagerId = row.id;
      r.wagerOwner = id;
      r.wagerAmount = n;
      r.wagerRoomId = roomKeyOf(r);
      r.wagerSettled = false;
      r.pendingWager = 0;

      startOfferTimer(r, row.id);

      // التأكد أن المالك الأصلي ما زال موجوداً
      const stillThere = originalOwner && r.seats.some(s => s.id === originalOwner && !s.left);
      if (stillThere && originalOwner !== id) {
        send(sockets.get(originalOwner), {
          type: 'rum:wager_offer',
          wagerId: row.id,
          amount: n,
          by: id,
          byName: (players.get(id) || {}).name || 'لاعب',
          isCounter: true,
          expiresAt: r.offerExpiresAt,
        });
      }
      pushState(r);
    } catch (e) {
      const code = e && e.code;
      if (code === WAGER_ERRORS.ROOM_ACTIVE) {
        sendError(id, 'يوجد رهان نشط آخر، حاول بعد قليل');
      } else if (code === WAGER_ERRORS.INSUFFICIENT) {
        sendError(id, `رصيدك غير كافٍ (تحتاج ${e.required}، عندك ${e.available})`);
      } else {
        sendError(id, 'فشل الرد: ' + (e && e.message));
      }
      pushState(r);
    } finally {
      r.wagerCreating = false;
    }
  }

  // ========================================================================
  // 9. منطق اللعب
  // ========================================================================
  function startGame(r) {
    if (!r.seats.length) throw new Error('لا يوجد لاعبين');

    r.n = r.seats.length;
    r.over = false;
    r.winner = '';
    r.seats.forEach(s => {
      s.score = 0;
      s.dead = false;
      s.bought = false;
      s.pending = false;
    });
    r.buyId = null;
    r.buyUsed = false;

    dealCards(r, crypto.randomInt(r.n));
  }

  function handleStart(id) {
    const r = findRoomByPlayer(id);
    if (!r || r.status !== 'wait') return;
    if (r.seats.length < 2) return sendError(id, 'تحتاج لاعبين على الأقل');

    try {
      startGame(r);
    } catch (e) {
      sendError(id, 'فشل البدء: ' + (e && e.message));
    }
  }

  function handleAgain(id) {
    const r = findRoomByPlayer(id);
    if (!r || r.status !== 'end') return;

    r.seats = r.seats.filter(s => !s.left);
    if (r.seats.length < 2) return sendError(id, 'تحتاج لاعبين على الأقل');

    resetWagerFields(r);
    r.wagerSettled = false;

    try {
      startGame(r);
    } catch (e) {
      sendError(id, 'فشل إعادة اللعب: ' + (e && e.message));
    }
  }

  function dealCards(r, starterIndex) {
    if (starterIndex < 0 || starterIndex >= r.seats.length) {
      throw new Error('مؤشر البداية غير صالح');
    }

    r.stock = createDeck();
    r.disc = [];
    r.melds = [];
    r.min = 51;
    r.first = true;
    r.rows = null;
    r.ready = new Set();
    r.status = 'play';

    r.seats.forEach((s, i) => {
      s.opened = false;
      s.out = false;
      s.h45 = false;
      s.hand = [];
      if (!s.dead) {
        const count = i === starterIndex ? 15 : 14;
        for (let k = 0; k < count; k++) {
          s.hand.push(r.stock.pop());
        }
      }
    });

    setTurn(r, starterIndex);
    pushState(r);
  }

  function setTurn(r, index) {
    r.turn = index;
    r.took = null;
    r.laid = [];
    r.wasOpen = r.seats[index].opened;
    r.ph = r.first ? 'play' : 'draw';
  }

  function advanceTurn(r) {
    r.first = false;

    if (r.seats.filter(isActive).length < 2) {
      return endRound(r, null);
    }

    let next = r.turn;
    let guard = 0;
    do {
      next = (next + 1) % r.seats.length;
      if (++guard > r.seats.length * 2) {
        console.error('[RUM] حلقة لا نهائية في التقدم');
        return endRound(r, null);
      }
    } while (!isActive(r.seats[next]));

    setTurn(r, next);
    pushState(r);
  }

  function getCurrentPlayer(id, expectedPhase) {
    const r = findRoomByPlayer(id);
    if (!r || r.status !== 'play') return null;

    const index = r.seats.findIndex(s => s.id === id);
    const seat = r.seats[index];

    if (index < 0 || index !== r.turn || !isActive(seat)) {
      sendError(id, 'ليس دورك');
      return null;
    }
    if (r.ph !== expectedPhase) {
      sendError(id, expectedPhase === 'draw' ? 'لا يمكنك السحب الآن' : 'اسحب ورقة أولاً');
      return null;
    }
    return { r, index, seat };
  }

  // سحب ورقة
  function handleDraw(id, from) {
    const ctx = getCurrentPlayer(id, 'draw');
    if (!ctx) return;

    const { r, seat } = ctx;
    let card;

    if (from === 'd') {
      if (!r.disc.length) return;
      card = r.disc.pop();
      r.took = card;
    } else {
      if (!r.stock.length) {
        const top = r.disc.pop();
        r.stock = shuffle(r.disc);
        r.disc = top ? [top] : [];
      }
      if (!r.stock.length) return endRound(r, null);
      card = r.stock.pop();
    }

    seat.hand.push(card);
    r.ph = 'play';
    pushState(r);
  }

  function handleUndo(id) {
    sendError(id, 'لا يوجد تراجع: الورقة الملقاة يجب استخدامها');
  }

  // عقوبة
  function applyPenalty(r, index, reason) {
    const seat = r.seats[index];
    seat.score += 100;
    seat.out = true;
    r.stock.unshift(...seat.hand);
    seat.hand = [];

    send(sockets.get(seat.id), {
      type: 'rum:note',
      text: reason + ' — عقوبة: 100 نقطة',
    });

    advanceTurn(r);
  }

  // هل يمكن وضع الورقة على أي مجموعة موجودة؟
  const canPlace = (r, card) =>
    r.melds.some(m => RM.trySwapJoker(m, card) || RM.checkMeld([...m.cards, card]));

  // تحليل المجموعات المرسلة من الكلاينت
  function parseGroups(seat, groups) {
    if (!Array.isArray(groups) || groups.length > 8) return null;

    const used = new Set();
    const result = [];

    for (const g of groups) {
      if (!Array.isArray(g)) return null;
      const cards = [];

      for (const cid of g) {
        const card = seat.hand.find(h => h.id === +cid);
        if (!card || used.has(card.id)) return null;
        used.add(card.id);
        cards.push(card);
      }

      const meld = RM.checkMeld(cards);
      if (!meld) return null;
      result.push({ cs: cards, m: meld });
    }

    return result;
  }

  // فتح أو وضع مجموعات
  function handleLay(id, data) {
    const ctx = getCurrentPlayer(id, 'play');
    if (!ctx) return;

    const { r, index, seat } = ctx;
    const parsed = parseGroups(seat, data.groups);
    if (!parsed) return sendError(id, 'مجموعات غير صالحة');

    if (!parsed.length && seat.opened) {
      return sendError(id, 'لا توجد مجموعات للوضع');
    }

    const totalPts = parsed.reduce((sum, p) => sum + p.m.pts, 0);
    const usedCount = parsed.reduce((sum, p) => sum + p.cs.length, 0);

    // لا يمكن إنهاء اليد بدون مجموعة من 4 أو 5
    if (seat.hand.length === usedCount && !(seat.h45 || parsed.some(p => p.cs.length >= 4))) {
      return sendError(id, 'يجب أن تكون لديك مجموعة من 4 أو 5 أوراق');
    }

    // فتح أول مرة
    if (!seat.opened) {
      if (totalPts < r.min) {
        if (r.took && RM.totalPoints(RM.solveHand(seat.hand)) < r.min) {
          return applyPenalty(r, index, `أخذت من المكشوف ولم تستطع الفتح بـ ${r.min}`);
        }
        return sendError(id, `الفتح يحتاج ${r.min}، عندك ${totalPts}`);
      }
      seat.opened = true;
      r.min = totalPts + 1;
    }

    const usedIds = new Set();
    parsed.forEach(p => {
      r.melds.push({ o: index, cards: p.m.ord, k: p.m.k });
      r.laid.push({ n: p.cs.length });
      if (p.cs.length >= 4) seat.h45 = true;
      p.cs.forEach(c => usedIds.add(c.id));
    });

    seat.hand = seat.hand.filter(c => !usedIds.has(c.id));

    if (!seat.hand.length) return endRound(r, index);
    pushState(r);
  }

  // وضع أوراق على مجموعة موجودة
  function handlePlace(id, data) {
    const ctx = getCurrentPlayer(id, 'play');
    if (!ctx) return;

    const { r, index, seat } = ctx;
    if (!seat.opened) return sendError(id, 'يجب أن تفتح أولاً');

    const meld = r.melds[+data.meld];
    if (!meld || !Array.isArray(data.cards)) {
      return sendError(id, 'مجموعة غير صالحة');
    }

    for (const cid of data.cards) {
      const card = seat.hand.find(h => h.id === +cid);
      if (!card) break;

      // محاولة استبدال جوكر
      const swap = RM.trySwapJoker(meld, card);
      if (swap) {
        meld.cards = swap.r.ord;
        meld.k = swap.r.k;
        seat.hand = seat.hand.filter(h => h !== card);
        seat.hand.push(swap.j);
        send(sockets.get(id), { type: 'rum:note', text: 'تم استبدال الجوكر' });
        if (meld.cards.length >= 4) seat.h45 = true;
        continue;
      }

      // إضافة عادية
      const result = RM.checkMeld([...meld.cards, card]);
      if (!result) {
        sendError(id, 'لا يمكن وضع هذه الورقة هنا');
        break;
      }

      meld.cards = result.ord;
      meld.k = result.k;
      seat.hand = seat.hand.filter(h => h !== card);
      if (meld.cards.length >= 4) seat.h45 = true;
    }

    if (!seat.hand.length) return endRound(r, index);
    pushState(r);
  }

  // رمي ورقة
  function handleDiscard(id, data) {
    const ctx = getCurrentPlayer(id, 'play');
    if (!ctx) return;

    const { r, index, seat } = ctx;
    const card = seat.hand.find(h => h.id === +data.card);
    if (!card) return sendError(id, 'اختر ورقة للرمي');

    // لا يمكن رمي ورقة قابلة للوضع إذا كان فيه خيارات أخرى
    const legal = seat.hand.filter(h => h.r && !canPlace(r, h));
    if (legal.length && !legal.includes(card)) {
      return sendError(id, !card.r ? 'لا يمكن رمي الجوكر' : 'لا يمكن رمي ورقة قابلة للوضع');
    }

    // عقوبة إذا أخذ من المكشوف وما فتحش
    if (r.took && !seat.opened) {
      return applyPenalty(r, index, 'أخذت من المكشوف ولم تفتح أو تكتسح');
    }

    // لا يمكن رمي آخر ورقة بدون مجموعة 4 أو 5
    if (seat.hand.length === 1 && !seat.h45) {
      return sendError(id, 'لا يمكن الرمي: تحتاج مجموعة من 4 أو 5');
    }

    seat.hand = seat.hand.filter(h => h !== card);
    r.disc.push(card);

    if (!seat.hand.length) return endRound(r, index);
    advanceTurn(r);
  }

  // كشف (إعلان انتهاء)
  function handleFlush(id) {
    const ctx = getCurrentPlayer(id, 'play');
    if (!ctx) return;

    const { r, index, seat } = ctx;

    const melds = RM.solveHand(seat.hand, true);
    const used = new Set(melds.flat().map(c => c.id));

    let placed = 0;
    let hasBig = false;

    const allMelds = [
      ...r.melds.map(m => ({ ...m, cards: [...m.cards] })),
      ...melds.map(g => {
        const m = RM.checkMeld(g);
        return { o: index, cards: m.ord, k: m.k };
      }),
    ];

    const left = seat.hand.filter(c => !used.has(c.id)).filter(c => {
      for (const m of allMelds) {
        const result = RM.checkMeld([...m.cards, c]);
        if (result) {
          m.cards = result.ord;
          m.k = result.k;
          placed++;
          if (m.cards.length >= 4) hasBig = true;
          return false;
        }
      }
      return true;
    });

    const ownCount = melds.flat().length;
    const total = ownCount + placed;
    const needed = r.wasOpen ? seat.hand.length - 1 : 14;
    const has45 = seat.h45 || hasBig || melds.some(g => g.length >= 4);

    if (left.length > 1 || total !== needed) {
      return applyPenalty(
        r,
        index,
        left.length > 1
          ? `كشف خاطئ: بقيت ${left.length} أوراق`
          : `كشف خاطئ: ${total} بدلاً من ${needed}`
      );
    }

    if (!has45) {
      return applyPenalty(r, index, 'كشف خاطئ: تحتاج مجموعة من 4 أو 5');
    }

    r.melds = allMelds;
    seat.opened = true;
    seat.hand = [];

    if (left[0]) r.disc.push(left[0]);

    endRound(r, index);
  }

  // نهاية الجولة
  function endRound(r, winnerIndex) {
    r.rows = r.seats.map((s, i) => {
      if (s.dead) return null;

      let delta;
      let note = '';

      if (i === winnerIndex) {
        delta = -10;
        note = 'اكتساح 🏆';
      } else if (s.out) {
        delta = 0;
        note = s.left ? 'غادر (100)' : 'كشف خاطئ (100)';
      } else if (!s.opened) {
        delta = 100;
      } else {
        delta = s.hand.reduce((sum, c) => sum + RM.handValue(c), 0);
      }

      s.score += delta;
      return { sid: s.id, name: s.name, d: delta, score: s.score, note };
    }).filter(Boolean);

    r.starterId = winnerIndex != null && r.seats[winnerIndex]
      ? r.seats[winnerIndex].id
      : (r.seats[r.turn] || {}).id;

    // من وصل 300 أو أكثر
    const dying = r.seats.filter(s => !s.dead && s.score >= 300);
    r.buyId = null;

    dying.forEach(s => {
      const row = r.rows.find(x => x.sid === s.id);
      if (dying.length === 1 && !r.buyUsed && !s.bought && r.n >= 3) {
        r.buyId = s.id;
        r.buyUsed = true;
        s.pending = true;
        if (row) row.note += ' 💀 خسر 300 — يمكنه الشراء';
      } else {
        s.dead = true;
        if (row) row.note += s.bought ? ' 💀 ميت (مضاعف)' : ' 💀';
      }
    });

    r.seats.forEach(s => { s.out = false; });
    r.seats = r.seats.filter(s => !s.left);

    if (!r.seats.some(s => s.id === r.hostId) && r.seats[0]) {
      r.hostId = r.seats[0].id;
    }

    r.ready = new Set();
    checkGameOver(r);

    // تسوية الرهان إذا انتهت اللعبة
    if (r.over && r.wagerAmount > 0 && !r.wagerSettled) {
      const winnerId = resolveWinnerId(r);
      settleRoomWager(r, winnerId);
    }

    pushState(r);
  }

  function checkGameOver(r) {
    const alive = r.seats.filter(s => !s.dead);
    r.over = alive.length <= Math.max(1, r.n - 2) || r.seats.length < 2;

    if (r.over) {
      const pool = alive.length ? alive : r.seats;
      const best = pool.slice().sort((a, b) => a.score - b.score)[0];
      r.winner = best ? best.name : '';
      r.status = 'end';
      r.buyId = null;
    } else {
      r.status = 'round';
    }
  }

  // شراء بعد خسارة 300
  function handleBuy(id, yes) {
    const r = findRoomByPlayer(id);
    if (!r || r.status !== 'round' || r.buyId !== id) return;

    const seat = r.seats.find(x => x.id === id);
    if (!seat) return;

    seat.pending = false;
    r.buyId = null;

    if (yes) {
      const others = r.seats.filter(x => x !== seat && !x.dead).map(x => x.score);
      seat.score = others.length ? Math.max(...others) : seat.score;
      seat.bought = true;
    } else {
      seat.dead = true;
    }

    checkGameOver(r);
    pushState(r);
  }

  // الانتقال للجولة التالية
  function handleNextRound(id) {
    const r = findRoomByPlayer(id);
    if (!r || r.status !== 'round' || r.buyId) return;

    r.ready.add(id);

    const alive = r.seats.filter(s => !s.dead);
    if (alive.every(s => r.ready.has(s.id))) {
      let starter = r.seats.findIndex(s => s.id === r.starterId && !s.dead);
      if (starter < 0) starter = r.seats.findIndex(s => !s.dead);

      if (starter < 0) {
        console.error('[RUM] لا يوجد لاعبين أحياء — إنهاء اللعبة');
        r.over = true;
        r.status = 'end';
        return pushState(r);
      }

      try {
        dealCards(r, starter);
      } catch (e) {
        console.error('[RUM] فشل التوزيع:', e && e.message);
      }
      return;
    }

    pushState(r);
  }

  // ========================================================================
  // 10. المغادرة
  // ========================================================================
  function handleLeave(id) {
    const r = findRoomByPlayer(id);
    if (!r) return;

    const index = r.seats.findIndex(s => s.id === id);
    const seat = r.seats[index];
    if (!seat) return;

    // --- في غرفة الانتظار ---
    if (r.status === 'wait') {
      if (r.wagerId && !r.wagerSettled) {
        cancelPendingWager(r, `leave_waiting:${id}`).catch(() => {});
      }

      r.seats.splice(index, 1);
      if (r.buyId === id) r.buyId = null;

      if (!r.seats.length) {
        clearOfferTimer(r);
        return void ROOMS.delete(r.id);
      }

      if (r.hostId === id) r.hostId = r.seats[0].id;
      return pushState(r);
    }

    // --- أثناء اللعب ---
    if (r.status === 'play') {
      seat.left = true;
      seat.out = true;
      seat.score += 100;
      r.stock.unshift(...seat.hand);
      seat.hand = [];

      // تسوية الرهان إذا كان موجوداً
      if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
        const other = r.seats.find(x => x.id !== id && !x.left);

        if (other && r.seats.length === 2) {
          r.wagerSettling = true;
          clearOfferTimer(r);

          if (typeof settleWager === 'function') {
            settleWager('rummy', r.wagerRoomId || roomKeyOf(r), other.id, id)
              .then(() => { r.wagerSettled = true; })
              .catch(e => console.error('[RUM WAGER] فشلت التسوية:', e && e.message))
              .finally(() => { r.wagerSettling = false; });
          }
        } else if (!other) {
          cancelPendingWager(r, `leave_play_no_opponent:${id}`).catch(() => {});
        }
      }

      if (r.seats.filter(isActive).length < 2) {
        return endRound(r, null);
      }

      return r.turn === index ? advanceTurn(r) : pushState(r);
    }

    // --- جولة أو نهاية ---
    r.seats.splice(index, 1);
    if (r.buyId === id) r.buyId = null;

    if (!r.seats.length) {
      clearOfferTimer(r);
      return void ROOMS.delete(r.id);
    }

    if (r.hostId === id) r.hostId = r.seats[0].id;

    if (r.status === 'round' && r.seats.filter(x => !x.dead).length < 2) {
      r.over = true;
      r.status = 'end';
      r.winner = (r.seats.find(x => !x.dead) || r.seats[0]).name;

      if (r.wagerAmount > 0 && !r.wagerSettled && !r.wagerSettling) {
        const winner = r.seats.find(x => !x.dead && !x.left);
        if (winner) {
          r.wagerSettling = true;
          clearOfferTimer(r);

          if (typeof settleWager === 'function') {
            settleWager('rummy', r.wagerRoomId || roomKeyOf(r), winner.id, id)
              .then(() => { r.wagerSettled = true; })
              .catch(e => console.error('[RUM WAGER]', e && e.message))
              .finally(() => { r.wagerSettling = false; });
          }
        } else {
          cancelPendingWager(r, `round_end_no_winner:${id}`).catch(() => {});
        }
      }
    }

    pushState(r);
  }

  // ========================================================================
  // 11. الواجهة العامة
  // ========================================================================
  const safe = (fn, tag) => (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      console.error(`[RUM ${tag}]`, e && e.message);
    }
  };

  const safeAsync = (fn, tag) => (...args) => {
    Promise.resolve()
      .then(() => fn(...args))
      .catch(e => console.error(`[RUM ${tag}]`, e && e.message));
  };

  return {
    prefix: PREFIX,

    handle(id, data) {
      if (!data || typeof data.type !== 'string') return;

      switch (data.type) {
        // الجلوس والبدء
        case 'rum:join':
          if (players.has(id)) safeAsync(handleJoin, 'join')(id, data.room);
          break;
        case 'rum:leave':
          safe(handleLeave, 'leave')(id);
          break;
        case 'rum:start':
          safe(handleStart, 'start')(id);
          break;

        // الرهان
        case 'rum:wager_offer':
          safeAsync(handleOfferWager, 'offer')(id, data.amount);
          break;
        case 'rum:wager_accept':
          safeAsync(handleAcceptWager, 'accept')(id, data.wagerId);
          break;
        case 'rum:wager_reject':
          safeAsync(handleRejectWager, 'reject')(id, data.wagerId);
          break;
        case 'rum:wager_counter':
          safeAsync(handleCounterWager, 'counter')(id, data.wagerId, data.amount);
          break;

        // اللعب
        case 'rum:draw':
          safe(handleDraw, 'draw')(id, data.from);
          break;
        case 'rum:undo':
          safe(handleUndo, 'undo')(id);
          break;
        case 'rum:buy':
          safe(handleBuy, 'buy')(id, !!data.yes);
          break;
        case 'rum:open':
        case 'rum:lay':
          safe(handleLay, 'lay')(id, data);
          break;
        case 'rum:place':
          safe(handlePlace, 'place')(id, data);
          break;
        case 'rum:discard':
          safe(handleDiscard, 'discard')(id, data);
          break;
        case 'rum:flush':
          safe(handleFlush, 'flush')(id);
          break;
        case 'rum:next':
          safe(handleNextRound, 'next')(id);
          break;
        case 'rum:again':
          safe(handleAgain, 'again')(id);
          break;
      }
    },

    leave: handleLeave,

    // تنظيف عند إغلاق السيرفر
    shutdown() {
      for (const r of ROOMS.values()) {
        clearOfferTimer(r);
      }
      ROOMS.clear();
    },

    // للاختبارات فقط
    _test: {
      RM,
      ROOMS,
      roomKeyOf,
    },
  };
};

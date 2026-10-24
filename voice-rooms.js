// voice-rooms.js — صوت الطاولات (الكلاينت)
// السيرفر يقرّر شكون في طاولتك (voice:peers). هذا الملف يفتح الاتصال الصوتي مع هؤلاء برك ويسكّر الباقي.
// يعتمد على دوال index.html العامة: addOther, getPC, call, closePeer, onSig, peers, myId, sitting, ws, log, stand
(function () {
  if (window.VoiceRooms) return;

  let allowed = new Set();   // IDs في نفس طاولتي
  let table   = null;        // مفتاح الطاولة
  let wsSeen  = null;
  let chip    = null;

  /* ---------- 1) منع addOther من فتح صوت مع الجميع ---------- */
  function patch() {
    if (typeof window.addOther !== 'function') return false;
    if (window.addOther._vr) return true;

    const orig = window.addOther;
    const wrapped = function (p) {
      const gPC = window.getPC, gCall = window.call;
      window.getPC  = function () { return null; };
      window.call   = function () {};
      try { orig(p); }
      finally { window.getPC = gPC; window.call = gCall; }
    };
    wrapped._vr = 1;
    window.addOther = wrapped;

    if (typeof window.onSig === 'function' && !window.onSig._vr) {
      const os = window.onSig;
      const w2 = function (from, d) {
        if (!allowed.has(from)) return;   // نتجاهلو أي إشارة من برّا الطاولة
        return os(from, d);
      };
      w2._vr = 1;
      window.onSig = w2;
    }
    return true;
  }

  /* ---------- 2) تطبيق قايمة السيرفر ---------- */
  function apply(t, list) {
    table   = t;
    allowed = new Set(list || []);

    // سكّر كل اتصال برّا الطاولة
    if (typeof peers !== 'undefined') {
      for (const id of Object.keys(peers)) {
        if (!allowed.has(id)) closePeer(id);
      }
    }
    // افتح مع اللي في الطاولة، واضبط الصوت كامل
    for (const id of allowed) {
      if (typeof peers !== 'undefined' && peers[id]) {
        if (peers[id].au) peers[id].au.volume = 1.0;
        continue;
      }
      if (typeof getPC === 'function') getPC(id);
      if (myId && myId < id && typeof call === 'function') call(id);
    }
    ui();
  }

  /* ---------- 3) معالجة رسائل السيرفر ---------- */
  function onMsg(d) {
    if (d.type === 'voice:peers') {
      apply(d.table, d.peers);
    } else if (d.type === 'voice:denied') {
      try { log('', '🔇 ' + (d.reason || 'الكرسي مشغول')); } catch (e) {}
      // رجّع اللاعب واقف إذا كان قاعد
      try {
        if (typeof sitting !== 'undefined' && sitting) {
          if (typeof window.stand === 'function') window.stand();
          else if (typeof ws !== 'undefined' && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'move', x: 0, z: 2, ry: 0, s: 0 }));
          }
        }
      } catch (e) {}
    }
  }

  /* ---------- 4) شريط الحالة ---------- */
  function ui() {
    if (!chip) {
      const hud = document.getElementById('hud');
      if (!hud) return;
      chip = document.createElement('div');
      chip.className = 'chip';
      chip.id = 'vrChip';
      hud.appendChild(chip);
    }
    const seated = (typeof sitting !== 'undefined') && sitting;
    if (!seated) {
      chip.textContent = '🔇 اقعد على طاولة باش تسمع وتتكلم';
    } else if (table && allowed.size > 0) {
      chip.textContent = '🔊 طاولتك: ' + (allowed.size + 1) + ' لاعبين';
    } else if (table) {
      chip.textContent = '🔊 طاولتك: وحدك';
    } else {
      chip.textContent = '🔇 ما فماش صوت هنا';
    }
  }

  /* ---------- 5) ربط WS ---------- */
  function attach() {
    if (!patch()) return;
    if (typeof ws !== 'undefined' && ws && ws !== wsSeen) {
      wsSeen  = ws;
      allowed = new Set();
      table   = null;
      ws.addEventListener('message', e => {
        let d; try { d = JSON.parse(e.data); } catch (x) { return; }
        if (typeof d.type === 'string' && d.type.indexOf('voice:') === 0) onMsg(d);
      });
      ws.addEventListener('close', () => {
        allowed = new Set();
        table   = null;
        ui();
      });
      // اطلب مزامنة فورية بعد الاتصال
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'voice:sync' }));
      } else {
        ws.addEventListener('open', () => {
          try { ws.send(JSON.stringify({ type: 'voice:sync' })); } catch (e) {}
        }, { once: true });
      }
    }
  }

  setInterval(() => {
    try { attach(); ui(); } catch (e) {}
  }, 500);

  window.VoiceRooms = {
    state: () => ({ table, peers: [...allowed] }),
    isAllowed: id => allowed.has(+id)
  };
})();

// voice-rooms.js — صوت الطاولات (الكلاينت)
// السيرفر يقرّر شكون في طاولتك (voice:peers). هذا الملف يفتح الاتصال الصوتي مع هؤلاء برك ويسكّر الباقي.
// الاستعمال: زيد في index.html بعد characters.js ورummy-client.js:
//   <script src="voice-rooms.js?v=1"></script>
// يعتمد على دوال index.html العامة: addOther, getPC, call, closePeer, onSig, peers, myId, sitting, ws, log
(function () {
  if (window.VoiceRooms) return;
  let allowed = new Set(), table = null, wsSeen = null;

  /* 1) ما نفتحوش صوت مع كل لاعب كي يدخل المقهى: نعطّلو getPC/call وقت addOther برك */
  function patch() {
    if (typeof addOther !== 'function') return false;
    if (addOther._vr) return true;
    const orig = addOther;
    const wrapped = function (p) {
      const g = window.getPC, c = window.call;
      window.getPC = function () { return null; }; window.call = function () {};
      try { orig(p); } finally { window.getPC = g; window.call = c; }
    };
    wrapped._vr = 1; window.addOther = wrapped;
    if (typeof onSig === 'function' && !onSig._vr) {
      const os = onSig;
      const w2 = function (from, d) { if (!allowed.has(from)) return; return os(from, d); };   // نتجاهلو أي إشارة من برا الطاولة
      w2._vr = 1; window.onSig = w2;
    }
    return true;
  }

  /* 2) قايمة السيرفر: نفتحو الجداد ونسكّرو اللي خرجو */
  function apply(t, list) {
    table = t; allowed = new Set(list || []);
    for (const id of Object.keys(peers)) if (!allowed.has(id)) closePeer(id);
    for (const id of allowed) {
      if (peers[id]) continue;
      getPC(id);
      if (myId && myId < id) call(id);
    }
    ui();
  }

  function onMsg(d) {
    if (d.type === 'voice:peers') apply(d.table, d.peers);
    else if (d.type === 'voice:denied') { try { log('', '🔇 ' + d.reason); } catch (e) {} }
  }

  /* 3) شريط الحالة في الأعلى */
  let chip = null;
  function ui() {
    if (!chip) {
      const hud = document.getElementById('hud'); if (!hud) return;
      chip = document.createElement('div'); chip.className = 'chip'; chip.id = 'vrChip'; hud.appendChild(chip);
    }
    const seated = typeof sitting !== 'undefined' && sitting;
    chip.textContent = !seated ? '🔇 اقعد على طاولة باش تسمع وتتكلم'
      : (table ? '🔊 طاولتك: ' + (allowed.size + 1) + ' لاعبين' : '🔇 ما فماش صوت هنا');
  }

  function attach() {
    if (!patch()) return;
    if (typeof ws !== 'undefined' && ws && ws !== wsSeen) {
      wsSeen = ws; allowed = new Set(); table = null;
      ws.addEventListener('message', e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } if (typeof d.type === 'string' && d.type.indexOf('voice:') === 0) onMsg(d); });
      ws.addEventListener('close', () => { allowed = new Set(); table = null; ui(); });
    }
  }
  setInterval(() => { try { attach(); ui(); } catch (e) {} }, 500);
  window.VoiceRooms = { state: () => ({ table, peers: [...allowed] }) };
})();

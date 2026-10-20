// chess-game.js — شطرنج أونلاين على الطاولة. يُحمَّل بعد index.html وcharacters.js
(function () {
  const $ = id => document.getElementById(id);
  const G = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const T = (...a) => window.turn(...a), Wk = (...a) => window.walk(...a);
  let S = null, sel = null, inRoom = false, hidden = false, hooked = null;
  const send = o => { if (typeof ws !== 'undefined' && ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  /* ---------- الواجهة ---------- */
  const css = document.createElement('style');
  css.textContent = `
  #cg{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;z-index:10;padding:10px}
  #cgB{display:grid;grid-template-columns:repeat(8,1fr);width:min(94vw,56vh);aspect-ratio:1;border:3px solid #3b2a1e;border-radius:6px;overflow:hidden;direction:ltr}
  .cs{position:relative;display:flex;align-items:center;justify-content:center;font-size:min(9vw,5.2vh);line-height:1}
  .cl{background:#f0d9b5}.cd{background:#b58863}
  .cs.last{box-shadow:inset 0 0 0 100px rgba(255,235,59,.35)}
  .cs.sel{background:#f6f669!important}.cs.chk{background:#e74c3c!important}
  .cs.mv::after{content:'';position:absolute;width:30%;height:30%;border-radius:50%;background:rgba(30,110,30,.6)}
  .cs.cap::after{content:'';position:absolute;inset:4%;border-radius:50%;border:4px solid rgba(30,110,30,.7)}
  .pw{color:#fff;text-shadow:0 0 2px #000,0 0 3px #000,0 0 3px #000}.pb{color:#161616}
  .cn{color:#fff;font:700 16px system-ui;text-align:center;min-height:22px}
  #cgBtns{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
  #cgBtns button{width:auto;padding:9px 14px;font-size:14px}`;
  document.head.appendChild(css);
  const ui = document.createElement('div');
  ui.id = 'cg';
  ui.innerHTML = `<div class="cn" id="cgT"></div><div id="cgB"></div><div class="cn" id="cgM"></div>
  <div id="cgBtns"><button id="cgHide">إخفاء</button><button id="cgRes">انسحاب</button><button id="cgAgain">لعبة جديدة</button><button id="cgOut">خروج</button></div>`;
  document.body.appendChild(ui);

  function render() {
    if (!S) return;
    const flip = S.you === 'b';
    const grid = [];
    S.fen.split(' ')[0].split('/').forEach((row, r) => {
      let c = 0;
      for (const ch of row) { if (/\d/.test(ch)) c += +ch; else { grid[r * 8 + c] = ch; c++; } }
    });
    let kingIdx = -1;
    if (S.check) { const k = S.turn === 'w' ? 'K' : 'k'; grid.forEach((p, i) => { if (p === k) kingIdx = i; }); }
    let html = '';
    for (let i = 0; i < 64; i++) {
      const idx = flip ? 63 - i : i, r = idx >> 3, c = idx & 7, sq = 'abcdefgh'[c] + (8 - r), p = grid[idx];
      const cls = ['cs', (r + c) % 2 ? 'cd' : 'cl'];
      if (sq === sel) cls.push('sel');
      if (S.last && (S.last.from === sq || S.last.to === sq)) cls.push('last');
      if (idx === kingIdx) cls.push('chk');
      if (sel && S.moves && S.moves[sel] && S.moves[sel].includes(sq)) cls.push(p ? 'cap' : 'mv');
      html += `<div class="${cls.join(' ')}" data-sq="${sq}">${p ? `<span class="${p === p.toUpperCase() ? 'pw' : 'pb'}">${G[p.toLowerCase()]}\uFE0E</span>` : ''}</div>`;
    }
    $('cgB').innerHTML = html;
    const nm = (pl, col) => (pl ? pl.name : '—') + (S.status === 'play' && S.turn === col ? ' ●' : '');
    const top = flip ? 'w' : 'b', bot = flip ? 'b' : 'w';
    $('cgT').textContent = (top === 'w' ? '⚪ ' : '⚫ ') + nm(top === 'w' ? S.white : S.black, top);
    let msg = '';
    if (S.status === 'wait') msg = 'بانتظار خصم… ليجلس صديقك على نفس الطاولة ويضغط ♟';
    else if (S.status === 'end') msg = S.result;
    else if (S.you === 's') msg = '👀 أنت مشاهد';
    else msg = S.you === S.turn ? (S.check ? '⚠️ كش! دورك' : '🟢 دورك') : '⏳ دور الخصم';
    $('cgM').textContent = (bot === 'w' ? '⚪ ' : '⚫ ') + nm(bot === 'w' ? S.white : S.black, bot) + '  |  ' + msg;
    $('cgRes').style.display = S.status === 'play' && S.you !== 's' ? '' : 'none';
    $('cgAgain').style.display = S.status === 'end' && S.you !== 's' && S.white && S.black ? '' : 'none';
  }

  $('cgB').onclick = e => {
    const d = e.target.closest('.cs'); if (!d || !S) return;
    const sq = d.dataset.sq;
    if (S.status !== 'play' || S.you !== S.turn) return;
    if (sel && S.moves && S.moves[sel] && S.moves[sel].includes(sq)) { send({ type: 'chess:move', from: sel, to: sq }); sel = null; render(); return; }
    sel = S.moves && S.moves[sq] ? sq : null;
    render();
  };
  $('cgHide').onclick = () => { hidden = true; ui.style.display = 'none'; };
  $('cgRes').onclick = () => send({ type: 'chess:resign' });
  $('cgAgain').onclick = () => send({ type: 'chess:again' });
  function reset() { inRoom = false; S = null; sel = null; hidden = false; ui.style.display = 'none'; }
  $('cgOut').onclick = () => { send({ type: 'chess:leave' }); reset(); };

  // زر اللعب (نعيد استعمال الزر الموجود في الصفحة)
  const pb = $('playBtn');
  if (pb) pb.onclick = () => {
    if (inRoom) { hidden = false; ui.style.display = 'flex'; render(); return; }
    if (typeof seat === 'undefined' || !seat) return;
    inRoom = true; hidden = false; ui.style.display = 'flex';
    $('cgM').textContent = 'جاري الاتصال…';
    send({ type: 'chess:join', room: seat.t.join(',') });
  };

  // استقبال رسائل الخادم (نستبدل المعالج القديم)
  window.handleServerMessage = function (d) {
    if (!d || typeof d.type !== 'string' || d.type.indexOf('chess:') !== 0) return;
    if (d.type === 'chess:state') {
      S = d; inRoom = true;
      if (sel && (!d.moves || !d.moves[sel])) sel = null;
      if (!hidden) ui.style.display = 'flex';
      render();
    } else if (d.type === 'chess:err' && window.log) window.log('', '⚠️ ' + d.text);
  };

  // صيانة: الوقوف = خروج، ونص الزر، وإعادة ربط الاتصال
  setInterval(() => {
    if (pb) pb.textContent = inRoom ? '♟ الرقعة' : '♟ العب شطرنج';
    if (inRoom && typeof sitting !== 'undefined' && !sitting) { send({ type: 'chess:leave' }); reset(); }
    if (typeof ws !== 'undefined' && ws !== hooked) { hooked = ws; if (ws) ws.addEventListener('close', reset); }
  }, 400);

  /* ---------- إصلاح الحلقة الرئيسية ----------
     كانت الحلقة تستدعي نسخة ثابتة من cafeTick فلا تعمل الإضافات (حركة الشخصيات وزر الشطرنج).
     هذه النسخة تستدعي window.cafeTick وwindow.turn وwindow.walk. */
  window.cgo = function (g, x, z, sp, dt) {
    const dx = x - g.position.x, dz = z - g.position.z, d = Math.hypot(dx, dz);
    if (d > .08) {
      const k = Math.min(1, sp * dt / d); g.position.x += dx * k; g.position.z += dz * k;
      TB.forEach(([tx, tz]) => { const ex = g.position.x - tx, ez = g.position.z - tz, e = Math.hypot(ex, ez); if (e < 1.55 && e > 0) { g.position.x = tx + ex / e * 1.55; g.position.z = tz + ez / e * 1.55; } });
      T(g, Math.atan2(dx, dz), dt); Wk(g, true, dt);
    } else Wk(g, false, dt);
    return d;
  };

  window.loop = function () {
    requestAnimationFrame(window.loop); if (paused) return;
    const now = performance.now(), dt = Math.min((now - last) / 1000, .05); last = now;
    let vx = jx + (K.d || K.arrowright ? 1 : 0) - (K.a || K.q || K.arrowleft ? 1 : 0), vz = jy + (K.s || K.arrowdown ? 1 : 0) - (K.w || K.z || K.arrowup ? 1 : 0);
    const L = Math.hypot(vx, vz); if (L > 1) { vx /= L; vz /= L; }
    const cy = Math.cos(camYaw), sy = Math.sin(camYaw), wx = vx * cy + vz * sy, wz = -vx * sy + vz * cy, k = Math.min(1, dt * 10);
    mv.x += (wx * 5 - mv.x) * k; mv.z += (wz * 5 - mv.z) * k;
    if (sitting && L > .3) stand();
    if (sitting) { mv.x = mv.z = 0; me.position.set(seat.x, -.1, seat.z); me.rotation.y = seat.ry; me.userData.lL.rotation.x = me.userData.lR.rotation.x = -1.4; }
    else { me.position.x += mv.x * dt; me.position.z += mv.z * dt; const mL = Math.hypot(mv.x, mv.z); if (mL > .3) T(me, Math.atan2(mv.x, mv.z), dt); Wk(me, mL > .3, dt); }
    const p = me.position; p.x = Math.max(-13, Math.min(13, p.x)); p.z = Math.max(-5.4, Math.min(8, p.z));
    TB.forEach(([x, z]) => { const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz); if (d < 1.5 && d > 0) { p.x = x + dx / d * 1.5; p.z = z + dz / d * 1.5; } });
    if (!sitting) { near = null; let bd = 4; CH.forEach(c => { const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < bd && chairFree(c)) { bd = d; near = c; } }); }
    const sb = $('sit'), stx = sitting ? '🚶 قم' : '🪑 اجلس'; sb.style.display = (sitting || near) ? 'block' : 'none'; if (sb.textContent !== stx) sb.textContent = stx;
    const hasOrder = CUS.some(u => u.me);
    $('voiceBtn').style.display = (sitting && !hasOrder && !inRoom) ? 'flex' : 'none';
    for (const kk in others) {
      const o = others[kk], g = o.g, dx = o.tx - g.position.x, dz = o.tz - g.position.z;
      const au = peers[kk] && peers[kk].au; if (au) au.volume = Math.max(0, Math.min(1, 1 - (Math.hypot(p.x - g.position.x, p.z - g.position.z) - 3) / 12));
      if (o.sit) { g.position.set(o.tx, -.1, o.tz); g.rotation.y = o.ry; g.userData.lL.rotation.x = g.userData.lR.rotation.x = -1.4; continue; }
      if (Math.hypot(dx, dz) > .05) { g.position.x += dx * Math.min(1, dt * 8); g.position.z += dz * Math.min(1, dt * 8); T(g, Math.atan2(dx, dz), dt); Wk(g, true, dt); } else Wk(g, false, dt);
    }
    sendT += dt; if (sendT > .05) {
      sendT = 0; const s = p.x.toFixed(2) + ',' + p.z.toFixed(2) + ',' + sitting + ',' + me.rotation.y.toFixed(1);
      if (s !== ps && ws && ws.readyState === 1) { ps = s; ws.send(JSON.stringify({ type: 'move', x: p.x, z: p.z, ry: me.rotation.y, s: sitting ? 1 : 0 })); }
    }
    NPC.forEach(n => { if (n.bar) { const t = performance.now() / 500, u = n.g.userData; u.aR.rotation.x = -.9 + Math.sin(t) * .3; u.aL.rotation.x = -.9 + Math.sin(t + 2) * .3; } });
    window.cafeTick(dt);
    const D = innerWidth < innerHeight ? 15 : 13;
    cam.position.set(p.x + Math.sin(camYaw) * Math.cos(camPitch) * D, 1.2 + Math.sin(camPitch) * D, p.z + Math.cos(camYaw) * Math.cos(camPitch) * D); cam.lookAt(p.x, 1.2, p.z);
    WALL.forEach(m => m.visible = cam.position.z > -9.2); GL.visible = cam.position.x > -14.8; GR.visible = cam.position.x < 14.8;
    R.render(scene, cam);
  };
})();

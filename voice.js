// games/voice.js — غرف الصوت (كل طاولة غرفة معزولة). السيرفر هو الحَكَم:
//  - يحسب الطاولة من موقع اللاعب وهو قاعد (مش من كلام الكلاينت)
//  - يبعث لكل لاعب قايمة لاعبين طاولتو برك  (voice:peers)
//  - server.js يمرّر رسائل WebRTC (signal) كان بين لاعبين في نفس الطاولة  (canSignal)
// ما تلمس غير هذا الملف كي تطوّر الصوت (VIP، غرف خاصة، إلخ).
module.exports = function ({ send, sockets, players }) {
  // ===== تخطيط المقهى (لازم يطابق index.html: TB وCH) =====
  const TABLES = [[-4, -1], [3, -1], [-4, 4], [3, 4]];
  const OFFS = [[0, 1.7], [0, -1.7], [1.7, 0], [-1.7, 0]];            // 4 كراسي لكل طاولة
  const STOOLS = [-5.2, -2.6, 0, 2.6, 5.2];                            // كراسي البار (كل كرسي غرفة وحدو)
  const CHAIRS = [];
  TABLES.forEach(t => OFFS.forEach(o => CHAIRS.push({ key: t.join(','), x: t[0] + o[0], z: t[1] + o[1] })));
  STOOLS.forEach(z => CHAIRS.push({ key: '-15,' + z, x: -13.6, z }));
  const SNAP = 0.8;                                                     // أقصى بعد بين اللاعب والكرسي باش نعتبروه قاعد عليه

  // نقطة تمديد لمرحلة VIP/الحسابات: ترجّع false باش تمنع لاعب من طاولة معينة
  const allowTable = (id, key) => true;

  const cur = new Map();          // id -> { chair, key }
  const owner = new Map();        // chair index -> id
  const rooms = new Map();        // key -> Set(ids)

  const peersOf = (key, id) => [...(rooms.get(key) || [])].filter(x => x !== id);
  const push = (id, key) => send(sockets.get(id), { type: 'voice:peers', table: key || null, peers: key ? peersOf(key, id) : [] });
  const pushRoom = key => (rooms.get(key) || new Set()).forEach(id => push(id, key));

  function leave(id, silent) {
    const c = cur.get(id); if (!c) return;
    cur.delete(id); if (owner.get(c.chair) === id) owner.delete(c.chair);
    const r = rooms.get(c.key); if (r) { r.delete(id); if (!r.size) rooms.delete(c.key); }
    if (!silent) push(id, null);
    pushRoom(c.key);
  }

  // يتنادى بعد كل حركة: يقرّر هل اللاعب قاعد على كرسي ويدخلو/يخرجو من غرفة الطاولة
  function onMove(id) {
    const p = players.get(id);
    if (!p || !p.s) return leave(id);                                   // واقف = ما عندو صوت
    let best = -1, bd = SNAP;
    CHAIRS.forEach((c, i) => { const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return leave(id);                                     // قاعد لكن مش على كرسي معروف
    const mine = cur.get(id);
    if (mine && mine.chair === best) return;                            // نفس الكرسي: ما تبدّل شي
    const o = owner.get(best);
    if (o && o !== id) { leave(id); send(sockets.get(id), { type: 'voice:denied', reason: 'الكرسي مشغول' }); return; }
    const key = CHAIRS[best].key;
    if (!allowTable(id, key)) { leave(id); send(sockets.get(id), { type: 'voice:denied', reason: 'الطاولة هذي خاصة' }); return; }
    leave(id, true);
    owner.set(best, id); cur.set(id, { chair: best, key });
    if (!rooms.has(key)) rooms.set(key, new Set());
    rooms.get(key).add(id);
    pushRoom(key);
  }

  // يتحقّق من صلاحية رسالة WebRTC: نفس الطاولة برك
  const canSignal = (from, to) => { const a = cur.get(from), b = cur.get(to); return !!(a && b && a.key === b.key); };

  return {
    prefix: 'voice:',
    handle(id, d) { if (d.type === 'voice:sync') push(id, (cur.get(id) || {}).key); },
    leave: id => leave(id),
    onMove, canSignal,
    _debug: () => ({ cur: [...cur], rooms: [...rooms].map(([k, v]) => [k, [...v]]) }),
  };
};

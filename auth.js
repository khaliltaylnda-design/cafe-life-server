'use strict';
// auth.js — حسابات Café Life (قوقل + ضيف). بلا مكتبات زايدة: JWT وتحقق قوقل بـcrypto متاع Node.
// السيرفر هو اللي يقرّر هوية اللاعب (الاسم واللون من القاعدة، مش من الكلاينت).
const crypto = require('crypto');

const SESSION_DAYS = 30;
const COLORS = new Set(['#2e86de', '#e74c3c', '#27ae60', '#9b59b6', '#e67e22', '#16a085']);
const GUEST_COLORS = [...COLORS];

/* ===== تنظيف المدخلات ===== */
function cleanName(v) {
  let s = String(v == null ? '' : v).normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')   // رموز تحكّم + اتجاه النص + HTML
    .replace(/\s+/g, ' ').trim();
  s = [...s].slice(0, 14).join('');
  return [...s].length >= 2 ? s : '';
}
const cleanColor = v => (COLORS.has(String(v)) ? String(v) : '#2e86de');

/* ===== JWT (HS256) ===== */
const b64u = x => Buffer.from(x).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');
function signJwt(payload, secret) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload));
  return h + '.' + p + '.' + crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
}
function verifyJwt(token, secret) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.'); if (parts.length !== 3) return null;
  let header; try { header = JSON.parse(unb64u(parts[0]).toString()); } catch { return null; }
  if (!header || header.alg !== 'HS256') return null;
  const expect = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const got = unb64u(parts[2]);
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
  let payload; try { payload = JSON.parse(unb64u(parts[1]).toString()); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/* ===== تحقق توكن قوقل (RS256) ===== */
const err = (code, status) => Object.assign(new Error(code), { code, status: status || 400 });
function makeJwksCache(fetchImpl) {
  let cache = null, until = 0;
  return async force => {
    if (!force && cache && Date.now() < until) return cache;
    const r = await (fetchImpl || fetch)('https://www.googleapis.com/oauth2/v3/certs');
    if (!r.ok) throw err('jwks_fetch_failed', 502);
    const j = await r.json(), m = (r.headers.get('cache-control') || '').match(/max-age=(\d+)/);
    cache = j; until = Date.now() + Math.max(300, m ? +m[1] : 3600) * 1000;
    return cache;
  };
}
async function verifyGoogleIdToken(idToken, clientId, getJwks) {
  if (!clientId) throw err('google_not_configured', 503);
  const t = String(idToken || ''); const parts = t.split('.');
  if (parts.length !== 3 || t.length > 4096) throw err('bad_token');
  let header, payload;
  try { header = JSON.parse(unb64u(parts[0]).toString()); payload = JSON.parse(unb64u(parts[1]).toString()); } catch { throw err('bad_token'); }
  if (!header || header.alg !== 'RS256' || !header.kid) throw err('bad_token');
  let jwk = ((await getJwks(false)).keys || []).find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) jwk = ((await getJwks(true)).keys || []).find(k => k.kid === header.kid && k.kty === 'RSA');   // مفاتيح قوقل تتبدّل
  if (!jwk) throw err('unknown_key', 401);
  let ok = false;
  try { ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), unb64u(parts[2])); } catch { ok = false; }
  if (!ok) throw err('bad_signature', 401);
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw err('bad_issuer', 401);
  if (payload.aud !== clientId) throw err('bad_audience', 401);
  if (!(payload.exp > now - 30) || !(payload.iat <= now + 300)) throw err('expired', 401);
  if (!payload.sub) throw err('bad_token');
  return payload;
}

/* ===== SQL (بسيط، مع معاملات) ===== */
const COLS = 'id, display_name, color, coins, is_guest, token_version';
const Q = {
  schema: [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS color VARCHAR(9) NOT NULL DEFAULT '#2e86de'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT',
  ],
  bySub: 'SELECT ' + COLS + ' FROM users WHERE google_sub = $1',
  byId: 'SELECT ' + COLS + ' FROM users WHERE id = $1',
  insertGoogle: 'INSERT INTO users (google_sub, email, display_name, color, is_guest, avatar_url, last_login) VALUES ($1, $2, $3, $4, FALSE, $5, NOW()) RETURNING ' + COLS,
  insertGuest: 'INSERT INTO users (display_name, color, is_guest, last_login) VALUES ($1, $2, TRUE, NOW()) RETURNING ' + COLS,
  link: 'UPDATE users SET google_sub = $1, email = $2, is_guest = FALSE, avatar_url = $3, updated_at = NOW() WHERE id = $4 AND is_guest = TRUE RETURNING ' + COLS,
  touch: 'UPDATE users SET last_login = NOW() WHERE id = $1',
  profile: 'UPDATE users SET display_name = $1, color = $2, updated_at = NOW() WHERE id = $3 RETURNING ' + COLS,
  bump: 'UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING ' + COLS,
};

module.exports = function createAuth({ pool, env = process.env, fetchImpl, log = console }) {
  const clientId = env.GOOGLE_CLIENT_ID || '';
  let secret = env.JWT_SECRET || '', ephemeral = false;
  if (secret.length < 32) { secret = crypto.randomBytes(32).toString('hex'); ephemeral = true; log.warn('JWT_SECRET ناقص أو قصير: نستعملو سر مؤقت (الجلسات تتبطل مع كل restart). حطّ JWT_SECRET في Render.'); }
  const getJwks = makeJwksCache(fetchImpl);
  let ready = Promise.resolve(true);
  const userCache = new Map();                                   // id -> { u, t }  (30 ثانية)

  const publicUser = u => ({ id: String(u.id), name: u.display_name, color: u.color, coins: u.coins, guest: !!u.is_guest });
  const issue = u => signJwt({ uid: String(u.id), v: u.token_version, g: !!u.is_guest, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }, secret);

  async function db(sql, params) {
    if (!pool) throw err('database_unavailable', 503);
    await ready;
    return pool.query(sql, params);
  }
  async function loadUser(id, fresh) {
    const c = userCache.get(String(id));
    if (!fresh && c && Date.now() - c.t < 30000) return c.u;
    const r = await db(Q.byId, [id]);
    const u = r.rows[0] || null;
    if (u) userCache.set(String(id), { u, t: Date.now() }); else userCache.delete(String(id));
    return u;
  }
  const remember = u => { userCache.set(String(u.id), { u, t: Date.now() }); return u; };

  // يرجّع المستخدم من توكن الجلسة (أو null)
  async function identify(token) {
    const p = verifyJwt(token, secret); if (!p || !/^\d+$/.test(String(p.uid))) return null;
    let u; try { u = await loadUser(p.uid, false); } catch { return null; }
    return u && u.token_version === p.v ? u : null;
  }

  /* ===== حدود الطلبات ===== */
  const buckets = new Map();
  function limit(name, req, max, windowMs) {
    const k = name + ':' + (req.ip || 'x'), now = Date.now(); let b = buckets.get(k);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    if (++b.n > max) throw err('rate_limited', 429);
    return true;
  }
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

  const bearer = req => { const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || ''); return h.startsWith('Bearer ') ? h.slice(7) : ''; };

  /* ===== المعالجات (req, res) ===== */
  const handlers = {
    async config(req, res) { res.status(200).json({ ok: true, googleClientId: clientId || null, guest: true }); },

    async google(req, res) {
      limit('google', req, 20, 60000);
      const payload = await verifyGoogleIdToken(req.body && req.body.credential, clientId, getJwks);
      const sub = String(payload.sub), email = payload.email_verified === false ? null : (payload.email || null);
      const name = cleanName(payload.name || payload.given_name || '') || 'لاعب' + crypto.randomInt(100, 999);
      let u = (await db(Q.bySub, [sub])).rows[0];
      if (!u) {
        const cur = await identify(bearer(req));                 // كان عندو حساب ضيف: نربطوه بقوقل (يحافظ على تقدمو)
        if (cur && cur.is_guest) u = (await db(Q.link, [sub, email, payload.picture || null, cur.id])).rows[0];
        if (!u) {
          try { u = (await db(Q.insertGoogle, [sub, email, name, GUEST_COLORS[crypto.randomInt(GUEST_COLORS.length)], payload.picture || null])).rows[0]; }
          catch (e) { if (e && e.code === '23505') u = (await db(Q.bySub, [sub])).rows[0]; else throw e; }   // سباق: خلقو في نفس اللحظة
        }
      } else await db(Q.touch, [u.id]);
      if (!u) throw err('account_failed', 500);
      remember(u);
      res.status(200).json({ ok: true, token: issue(u), user: publicUser(u) });
    },

    async guest(req, res) {
      limit('guest', req, 8, 3600000);                           // 8 حسابات ضيف للساعة لكل IP (ضدّ التلغيم)
      const name = 'ضيف' + crypto.randomInt(100, 999);
      const u = remember((await db(Q.insertGuest, [name, GUEST_COLORS[crypto.randomInt(GUEST_COLORS.length)]])).rows[0]);
      res.status(200).json({ ok: true, token: issue(u), user: publicUser(u) });
    },

    async me(req, res) {
      limit('me', req, 120, 60000);
      const u = await identify(bearer(req)); if (!u) throw err('unauthorized', 401);
      res.status(200).json({ ok: true, user: publicUser(u) });
    },

    async profile(req, res) {
      limit('profile', req, 20, 60000);
      const u = await identify(bearer(req)); if (!u) throw err('unauthorized', 401);
      const body = req.body || {};
      const name = body.name === undefined ? u.display_name : cleanName(body.name);
      if (!name) throw err('bad_name', 400);
      const color = body.color === undefined ? u.color : cleanColor(body.color);
      const nu = remember((await db(Q.profile, [name, color, u.id])).rows[0]);
      res.status(200).json({ ok: true, user: publicUser(nu) });
    },

    async logoutAll(req, res) {                                  // يبطّل كل الجلسات القديمة (كل التليفونات)
      limit('logout', req, 10, 60000);
      const u = await identify(bearer(req)); if (!u) throw err('unauthorized', 401);
      const nu = remember((await db(Q.bump, [u.id])).rows[0]);
      res.status(200).json({ ok: true, token: issue(nu) });
    },
  };

  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const status = (e && e.status) || 500;
      if (status >= 500) log.error('auth error:', e && e.message);
      res.status(status).json({ ok: false, error: status >= 500 && !(e && e.code) ? 'server_error' : (e.code || 'error') });
    }
  };

  function register(app) {
    app.get('/auth/config', wrap(handlers.config));
    app.post('/auth/google', wrap(handlers.google));
    app.post('/auth/guest', wrap(handlers.guest));
    app.get('/auth/me', wrap(handlers.me));
    app.post('/auth/profile', wrap(handlers.profile));
    app.post('/auth/logout-all', wrap(handlers.logoutAll));
  }

  async function ensureSchema() {
    if (!pool) return false;
    for (const sql of Q.schema) await pool.query(sql);
    return true;
  }
  const setReady = p => { ready = Promise.resolve(p).catch(() => false); };

  return { register, handlers, identify, publicUser, ensureSchema, setReady, cleanName, cleanColor,
           status: () => ({ google: !!clientId, secret: ephemeral ? 'ephemeral' : 'configured' }),
           _t: { signJwt, verifyJwt, verifyGoogleIdToken, makeJwksCache, Q } };
};

'use strict';

const crypto = require('crypto');

const SESSION_DAYS = 30;
const WS_TICKET_TTL_SECONDS = 60;
const MAX_ACTIVE_TICKETS = 5;
const MAX_RATE_BUCKETS = 100_000;
const MAX_TOKEN_AGE_SECONDS = SESSION_DAYS * 86400 + 300;

const COOKIE_NAME = 'cafe_session';
const COOKIE_MAX_AGE_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

const COLORS = new Set(['#2e86de', '#e74c3c', '#27ae60', '#9b59b6', '#e67e22', '#16a085']);

const err = (code, status = 400) => Object.assign(new Error(code), { code, status });

function cleanName(value) {
  let name = String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
  name = [...name].slice(0, 14).join('');
  return [...name].length >= 2 ? name : '';
}
function cleanColor(value) { const c = String(value == null ? '' : value); return COLORS.has(c) ? c : '#2e86de'; }
function cleanPicture(value) { if (typeof value !== 'string' || value.length > 500) return null; if (!value.startsWith('https://lh3.googleusercontent.com/')) return null; return value; }

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function readSessionCookie(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const value = cookies[COOKIE_NAME];
  if (typeof value !== 'string' || !value || value.length > 2000) return '';
  return value;
}

function setSessionCookie(res, token, opts = {}) {
  if (!res || typeof res.cookie !== 'function') return;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: Boolean(opts.secure), sameSite: 'lax', path: '/', maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookie(res, opts = {}) {
  if (!res || typeof res.clearCookie !== 'function') return;
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: Boolean(opts.secure), sameSite: 'lax', path: '/' });
}

const b64u = value => Buffer.from(value).toString('base64url');
const unb64u = value => Buffer.from(String(value), 'base64url');

function signJwt(payload, secret) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const input = header + '.' + body;
  const signature = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return input + '.' + signature;
}

function verifyJwt(token, secret) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(unb64u(parts[0]).toString());
    payload = JSON.parse(unb64u(parts[1]).toString());
  } catch { return null; }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  const input = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(input).digest();
  let actual;
  try { actual = unb64u(parts[2]); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload.uid !== 'string' || !/^\d+$/.test(payload.uid) || !Number.isSafeInteger(payload.v) || !Number.isFinite(payload.exp) || payload.exp <= now || !Number.isFinite(payload.iat) || payload.iat > now + 300 || now - payload.iat > MAX_TOKEN_AGE_SECONDS || payload.g !== false || typeof payload.jti !== 'string' || !payload.jti || payload.jti.length < 16 || payload.jti.length > 128) return null;
  return payload;
}

function makeJwksCache(fetchImpl) {
  let cache = null; let expiresAt = 0;
  return async function getJwks(force = false) {
    if (!force && cache && Date.now() < expiresAt) return cache;
    const fetcher = fetchImpl || globalThis.fetch;
    if (typeof fetcher !== 'function') throw err('fetch_unavailable', 503);
    let response;
    try { response = await fetcher('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(8000) }); }
    catch { throw err('jwks_fetch_failed', 502); }
    if (!response.ok) throw err('jwks_fetch_failed', 502);
    let result;
    try { result = await response.json(); } catch { throw err('jwks_invalid_response', 502); }
    if (!result || !Array.isArray(result.keys)) throw err('jwks_invalid_response', 502);
    const cc = response.headers.get('cache-control') || '';
    const match = cc.match(/max-age=(\d+)/i);
    const seconds = match ? Number(match[1]) : 3600;
    cache = result; expiresAt = Date.now() + Math.max(300, seconds) * 1000;
    return cache;
  };
}

async function verifyGoogleIdToken(idToken, clientId, getJwks) {
  if (!clientId) throw err('google_not_configured', 503);
  if (typeof idToken !== 'string' || !idToken || idToken.length > 4096) throw err('bad_token', 401);
  const parts = idToken.split('.');
  if (parts.length !== 3) throw err('bad_token', 401);
  let header, payload;
  try { header = JSON.parse(unb64u(parts[0]).toString()); payload = JSON.parse(unb64u(parts[1]).toString()); }
  catch { throw err('bad_token', 401); }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw err('bad_token', 401);
  let jwks = await getJwks(false);
  let jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) { jwks = await getJwks(true); jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA'); }
  if (!jwk) throw err('unknown_key', 401);
  let sigValid = false;
  try { sigValid = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), unb64u(parts[2])); }
  catch { sigValid = false; }
  if (!sigValid) throw err('bad_signature', 401);
  const now = Math.floor(Date.now() / 1000);
  const validIss = payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com';
  const validAud = payload.aud === clientId || (Array.isArray(payload.aud) && payload.aud.includes(clientId));
  if (!validIss) throw err('bad_issuer', 401);
  if (!validAud) throw err('bad_audience', 401);
  if (!Number.isFinite(payload.exp) || payload.exp <= now - 30 || !Number.isFinite(payload.iat) || payload.iat > now + 300 || now - payload.iat > 600 || typeof payload.sub !== 'string' || !payload.sub) throw err('expired_or_invalid_token', 401);
  if (payload.azp !== undefined && payload.azp !== clientId) throw err('bad_authorized_party', 401);
  return payload;
}

const USER_COLUMNS = ['id', 'google_sub', 'display_name', 'color', 'coins', 'is_guest', 'token_version', 'status'].join(', ');

const SQL = {
  schema: [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS color VARCHAR(9) NOT NULL DEFAULT '#2e86de'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS coins BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
    `CREATE TABLE IF NOT EXISTS sessions (jti TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ)`,
    `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,
    `CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at)`,
    `CREATE TABLE IF NOT EXISTS ws_tickets (ticket_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, jti TEXT NOT NULL, token_version INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `ALTER TABLE ws_tickets ADD COLUMN IF NOT EXISTS jti TEXT`,
    `CREATE INDEX IF NOT EXISTS ws_tickets_expiry_idx ON ws_tickets (expires_at)`,
    `CREATE INDEX IF NOT EXISTS ws_tickets_jti_idx ON ws_tickets (jti)`
  ],
  bySub: `SELECT ${USER_COLUMNS} FROM users WHERE google_sub = $1`,
  byId: `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
  insertGoogle: `INSERT INTO users (google_sub, email, display_name, color, is_guest, avatar_url, last_login, status) VALUES ($1, $2, $3, $4, FALSE, $5, NOW(), 'active') RETURNING ${USER_COLUMNS}`,
  updateEmail: `UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2 AND google_sub IS NOT NULL`,
  touch: `UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`,
  profile: `UPDATE users SET display_name = $1, color = $2, updated_at = NOW() WHERE id = $3 RETURNING ${USER_COLUMNS}`,
  bump: `UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING ${USER_COLUMNS}`,
  insertSession: `INSERT INTO sessions (jti, user_id, expires_at) VALUES ($1, $2, $3)`,
  loadSession: `SELECT jti, user_id, expires_at, revoked_at FROM sessions WHERE jti = $1`,
  revokeSession: `UPDATE sessions SET revoked_at = NOW() WHERE jti = $1 AND revoked_at IS NULL`,
  revokeAllSessions: `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL RETURNING jti`,
  deleteStaleSessions: `DELETE FROM sessions WHERE user_id = $1 AND (expires_at < NOW() OR revoked_at IS NOT NULL)`,
  lockUser: `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
  countActiveTickets: `SELECT COUNT(*)::int AS n FROM ws_tickets WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
  deleteStaleTickets: `DELETE FROM ws_tickets WHERE user_id = $1 AND (expires_at < NOW() OR consumed_at IS NOT NULL)`,
  deleteTicketsByJti: `DELETE FROM ws_tickets WHERE jti = $1`,
  deleteTicketsByUser: `DELETE FROM ws_tickets WHERE user_id = $1`,
  insertTicket: `INSERT INTO ws_tickets (ticket_hash, user_id, jti, token_version, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '60 seconds')`,
  consumeTicket: `UPDATE ws_tickets SET consumed_at = NOW() WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING user_id, jti, token_version`
};

module.exports = function createAuth({ pool, env = process.env, fetchImpl, log = console }) {
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const secret = env.JWT_SECRET || '';
  const isProd = env.NODE_ENV === 'production';

  if (secret.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters');
  if (!pool) log.warn('Authentication is unavailable: DATABASE_URL is missing.');

  const getJwks = makeJwksCache(fetchImpl);
  let ready = Promise.resolve(true);
  let onSessionRevoked = null;

  function setSessionRevokedHandler(handler) { onSessionRevoked = typeof handler === 'function' ? handler : null; }
  function notifyRevoked(jti) { if (!onSessionRevoked || !jti) return; try { onSessionRevoked(String(jti)); } catch (error) { log.error('session-revoked handler failed:', error?.message); } }

  const buckets = new Map();
  function limit(name, req, max, windowMs) {
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const key = name + ':' + ip;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      if (buckets.size >= MAX_RATE_BUCKETS) {
        const drop = Math.floor(MAX_RATE_BUCKETS * 0.1);
        let i = 0;
        for (const k of buckets.keys()) { buckets.delete(k); if (++i >= drop) break; }
      }
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) throw err('rate_limited', 429);
  }
  const cleanupTimer = setInterval(() => { const now = Date.now(); for (const [key, bucket] of buckets) { if (now >= bucket.reset) buckets.delete(key); } }, 60000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  function bearer(req) { const h = String(req.headers?.authorization || ''); const m = h.match(/^Bearer\s+([A-Za-z0-9._\-]{8,2000})$/i); return m ? m[1] : ''; }
  function readToken(req) { const c = readSessionCookie(req); if (c) return c; return bearer(req); }
  function publicUser(user) { return { id: String(user.id), name: user.display_name, color: user.color, coins: String(user.coins == null ? 0 : user.coins), guest: false }; }

  async function db(sql, params = []) {
    if (!pool) throw err('database_unavailable', 503);
    const isReady = await ready;
    if (!isReady) throw err('database_unavailable', 503);
    return pool.query(sql, params);
  }

  async function withTransaction(fn) {
    if (!pool) throw err('database_unavailable', 503);
    const isReady = await ready;
    if (!isReady) throw err('database_unavailable', 503);
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async function loadUser(id) { const result = await db(SQL.byId, [id]); return result.rows[0] || null; }
  async function loadSession(jti) { const result = await db(SQL.loadSession, [jti]); return result.rows[0] || null; }
  function isEligibleUser(user) { return Boolean(user && user.is_guest === false && typeof user.google_sub === 'string' && user.google_sub.length > 0 && user.status === 'active'); }

  async function identify(token) {
    const payload = verifyJwt(token, secret);
    if (!payload) return null;
    try {
      const user = await loadUser(payload.uid);
      if (!isEligibleUser(user)) return null;
      if (Number(user.token_version) !== payload.v) return null;
      const session = await loadSession(payload.jti);
      if (!session) return null;
      if (String(session.user_id) !== String(user.id)) return null;
      if (session.revoked_at !== null) return null;
      if (new Date(session.expires_at).getTime() <= Date.now()) return null;
      return user;
    } catch (error) { log.error('identify failed:', error?.message); throw err('auth_backend_unavailable', 503); }
  }

  async function identifyRequest(req) {
    const token = readToken(req);
    if (!token) return null;
    const user = await identify(token);
    if (user && req) req.authToken = token;
    return user;
  }

  async function isSessionValid(jti) {
    if (typeof jti !== 'string' || !jti) return false;
    let session;
    try { session = await loadSession(jti); }
    catch (error) { log.error('isSessionValid failed:', error?.message); return false; }
    if (!session) return false;
    if (session.revoked_at !== null) return false;
    if (new Date(session.expires_at).getTime() <= Date.now()) return false;
    return true;
  }

  async function createSessionFor(user) {
    const now = Math.floor(Date.now() / 1000);
    const jti = crypto.randomBytes(32).toString('base64url');
    const exp = now + SESSION_DAYS * 86400;
    await db(SQL.insertSession, [jti, user.id, new Date(exp * 1000)]);
    const token = signJwt({ uid: String(user.id), v: Number(user.token_version), g: false, jti, iat: now, exp }, secret);
    db(SQL.deleteStaleSessions, [user.id]).catch(() => {});
    return { token, jti };
  }

  async function google(req, res) {
    limit('google', req, 20, 60000);
    const payload = await verifyGoogleIdToken(req.body && req.body.credential, clientId, getJwks);
    const googleSub = String(payload.sub);
    const email = payload.email_verified === false ? null : (payload.email || null);
    const name = cleanName(payload.name || payload.given_name || '') || 'player' + crypto.randomInt(100000, 999999);
    const picture = cleanPicture(payload.picture);
    let user = (await db(SQL.bySub, [googleSub])).rows[0];
    
    if (user) {
      if (user.status !== 'active') throw err('account_disabled', 403);
      if (user.is_guest || !user.google_sub) throw err('google_account_required', 403);
      await db(SQL.touch, [user.id]);
      if (email) { await db(SQL.updateEmail, [email, user.id]).catch(() => {}); user.email = email; }
      user.last_login = new Date();
    } else {
      const color = [...COLORS][crypto.randomInt(COLORS.size)];
      try {
        const inserted = await db(SQL.insertGoogle, [googleSub, email, name, color, picture]);
        user = inserted.rows[0];
      } catch (error) {
        if (error && error.code === '23505') {
          user = (await db(SQL.bySub, [googleSub])).rows[0];
          if (!user) throw err('account_creation_conflict', 409);
          if (user.status !== 'active') throw err('account_disabled', 403);
        } else { throw error; }
      }
    }
    if (!isEligibleUser(user)) throw err('google_account_required', 403);
    const { token } = await createSessionFor(user);
    setSessionCookie(res, token, { secure: isProd });
    res.status(200).json({ ok: true, token, user: publicUser(user), authMode: 'cookie' });
  }

  async function me(req, res) {
    limit('me', req, 120, 60000);
    const user = await identifyRequest(req);
    if (!user) throw err('unauthorized', 401);
    res.status(200).json({ ok: true, user: publicUser(user) });
  }

  async function profile(req, res) {
    limit('profile', req, 20, 60000);
    const user = await identifyRequest(req);
    if (!user) throw err('unauthorized', 401);
    const body = req.body || {};
    const name = body.name === undefined ? user.display_name : cleanName(body.name);
    if (!name) throw err('bad_name', 400);
    const color = body.color === undefined ? cleanColor(user.color) : cleanColor(body.color);
    const result = await db(SQL.profile, [name, color, user.id]);
    const updatedUser = result.rows[0];
    if (!isEligibleUser(updatedUser)) throw err('unauthorized', 401);
    res.status(200).json({ ok: true, user: publicUser(updatedUser) });
  }

  async function logout(req, res) {
    limit('logout', req, 30, 60000);
    const token = readToken(req);
    const payload = token ? verifyJwt(token, secret) : null;
    if (payload) {
      try { await db(SQL.revokeSession, [payload.jti]); await db(SQL.deleteTicketsByJti, [payload.jti]); }
      catch (error) { if (error && error.status && error.status >= 500) throw error; }
      notifyRevoked(payload.jti);
    }
    clearSessionCookie(res, { secure: isProd });
    res.status(200).json({ ok: true });
  }

  async function logoutAll(req, res) {
    limit('logout-all', req, 10, 60000);
    const user = await identifyRequest(req);
    if (!user) throw err('unauthorized', 401);
    const result = await db(SQL.revokeAllSessions, [user.id]);
    const revoked = result.rows.map(row => String(row.jti));
    await db(SQL.bump, [user.id]).catch(() => {});
    await db(SQL.deleteTicketsByUser, [user.id]).catch(() => {});
    for (const jti of revoked) notifyRevoked(jti);
    clearSessionCookie(res, { secure: isProd });
    res.status(200).json({ ok: true });
  }

  async function createWsTicket(req, res) {
    limit('ws-ticket', req, 60, 60000);
    const token = readToken(req);
    const payload = token ? verifyJwt(token, secret) : null;
    if (!payload) throw err('unauthorized', 401);
    const user = await identify(token);
    if (!user) throw err('unauthorized', 401);
    const jti = payload.jti;
    const ticket = crypto.randomBytes(32).toString('base64url');
    const ticketHash = crypto.createHash('sha256').update(ticket).digest('hex');
    let inserted = false;
    await withTransaction(async (client) => {
      await client.query(SQL.lockUser, [user.id]);
      await client.query(SQL.deleteStaleTickets, [user.id]);
      const countResult = await client.query(SQL.countActiveTickets, [user.id]);
      const active = countResult.rows[0] ? countResult.rows[0].n : 0;
      if (active >= MAX_ACTIVE_TICKETS) throw err('too_many_tickets', 429);
      await client.query(SQL.insertTicket, [ticketHash, user.id, jti, Number(user.token_version)]);
      inserted = true;
    });
    if (!inserted) throw err('ticket_creation_failed', 500);
    res.status(200).json({ ok: true, ticket, expiresIn: WS_TICKET_TTL_SECONDS });
  }

  async function consumeWsTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length < 32 || ticket.length > 200) return null;
    const ticketHash = crypto.createHash('sha256').update(ticket).digest('hex');
    const result = await db(SQL.consumeTicket, [ticketHash]);
    if (!result.rows.length) return null;
    const record = result.rows[0];
    if (!record.jti) return null;
    const session = await loadSession(record.jti);
    if (!session) return null;
    if (session.revoked_at !== null) return null;
    if (new Date(session.expires_at).getTime() <= Date.now()) return null;
    if (String(session.user_id) !== String(record.user_id)) return null;
    const user = await loadUser(String(record.user_id));
    if (!isEligibleUser(user)) return null;
    if (Number(user.token_version) !== Number(record.token_version)) return null;
    return { id: String(user.id), name: user.display_name, color: user.color, jti: String(record.jti), user };
  }

  const handlers = {
    async config(req, res) { res.status(200).json({ ok: true, googleClientId: clientId || null, guest: false, authMode: 'cookie' }); },
    google,
    async guest() { throw err('guest_disabled', 403); },
    me, profile, logout, logoutAll, createWsTicket
  };

  const wrap = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (res.headersSent) { log.error('auth headersSent, cannot respond:', error?.message); return; }
      const status = error && error.status ? error.status : 500;
      if (status >= 500) log.error('auth error:', error && error.message);
      res.status(status).json({ ok: false, error: error && error.code ? error.code : 'server_error' });
    }
  };

  function register(app) {
    const jsonRequired = (req, res, next) => {
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
        return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
      }
      next();
    };
    app.get('/auth/config', wrap(handlers.config));
    app.post('/auth/google', jsonRequired, wrap(handlers.google));
    app.post('/auth/guest', jsonRequired, wrap(handlers.guest));
    app.get('/auth/me', wrap(handlers.me));
    app.post('/auth/profile', jsonRequired, wrap(handlers.profile));
    app.post('/auth/logout', jsonRequired, wrap(handlers.logout));
    app.post('/auth/logout-all', jsonRequired, wrap(handlers.logoutAll));
    app.post('/auth/ws-ticket', jsonRequired, wrap(handlers.createWsTicket));
  }

  async function ensureSchema() {
    if (!pool) return false;
    for (const statement of SQL.schema) { await pool.query(statement); }
    return true;
  }

  function setReady(promise) {
    ready = Promise.resolve(promise).then(() => true, (error) => { log.error('auth schema not ready:', error && error.message); return false; });
  }

  return {
    register, handlers, identify, identifyRequest, publicUser, ensureSchema, setReady,
    cleanName, cleanColor, consumeWsTicket, isSessionValid, setSessionRevokedHandler,
    status: () => ({ google: Boolean(clientId), secret: 'configured', mode: 'cookie' }),
    _t: { signJwt, verifyJwt, verifyGoogleIdToken, makeJwksCache, SQL, COOKIE_NAME, setSessionCookie, clearSessionCookie, readSessionCookie }
  };
};

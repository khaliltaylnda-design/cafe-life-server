'use strict';

// auth.js — Cafe Life authentication. HARDENED.
// Google accounts only. The server is authoritative for identity.
// Requires Node.js with global fetch support and PostgreSQL.

const crypto = require('crypto');

const SESSION_DAYS = 30;
const WS_TICKET_TTL_SECONDS = 60;
const MAX_ACTIVE_TICKETS = 5;
const MAX_RATE_BUCKETS = 100_000;
const MAX_TOKEN_AGE_SECONDS = SESSION_DAYS * 86400 + 300;

const COLORS = new Set([
  '#2e86de', '#e74c3c', '#27ae60',
  '#9b59b6', '#e67e22', '#16a085'
]);

const err = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });

/* =========================================================
   INPUT VALIDATION
========================================================= */

function cleanName(value) {
  let name = String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = [...name].slice(0, 14).join('');
  return [...name].length >= 2 ? name : '';
}

function cleanColor(value) {
  const color = String(value == null ? '' : value);
  return COLORS.has(color) ? color : '#2e86de';
}

function cleanPicture(value) {
  if (typeof value !== 'string') return null;
  if (value.length > 500) return null;
  if (!value.startsWith('https://lh3.googleusercontent.com/')) return null;
  return value;
}

/* =========================================================
   JWT — HS256
========================================================= */

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
  } catch {
    return null;
  }

  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  const input = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(input).digest();

  let actual;
  try { actual = unb64u(parts[2]); } catch { return null; }

  if (actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    !payload ||
    typeof payload.uid !== 'string' ||
    !/^\d+$/.test(payload.uid) ||
    !Number.isSafeInteger(payload.v) ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now ||
    !Number.isFinite(payload.iat) ||
    payload.iat > now + 300 ||
    now - payload.iat > MAX_TOKEN_AGE_SECONDS ||
    payload.g !== false ||
    typeof payload.jti !== 'string' ||
    !payload.jti ||
    payload.jti.length < 16 ||
    payload.jti.length > 128
  ) {
    return null;
  }

  return payload;
}

/* =========================================================
   GOOGLE ID TOKEN VERIFICATION
========================================================= */

function makeJwksCache(fetchImpl) {
  let cache = null;
  let expiresAt = 0;

  return async function getJwks(force = false) {
    if (!force && cache && Date.now() < expiresAt) return cache;

    const fetcher = fetchImpl || globalThis.fetch;
    if (typeof fetcher !== 'function') throw err('fetch_unavailable', 503);

    let response;
    try {
      response = await fetcher(
        'https://www.googleapis.com/oauth2/v3/certs',
        { signal: AbortSignal.timeout(8000) }
      );
    } catch {
      throw err('jwks_fetch_failed', 502);
    }

    if (!response.ok) throw err('jwks_fetch_failed', 502);

    let result;
    try { result = await response.json(); } catch { throw err('jwks_invalid_response', 502); }

    if (!result || !Array.isArray(result.keys)) {
      throw err('jwks_invalid_response', 502);
    }

    const cacheControl = response.headers.get('cache-control') || '';
    const match = cacheControl.match(/max-age=(\d+)/i);
    const seconds = match ? Number(match[1]) : 3600;

    cache = result;
    expiresAt = Date.now() + Math.max(300, seconds) * 1000;
    return cache;
  };
}

async function verifyGoogleIdToken(idToken, clientId, getJwks) {
  if (!clientId) throw err('google_not_configured', 503);
  if (typeof idToken !== 'string' || !idToken || idToken.length > 4096) {
    throw err('bad_token', 401);
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) throw err('bad_token', 401);

  let header, payload;
  try {
    header = JSON.parse(unb64u(parts[0]).toString());
    payload = JSON.parse(unb64u(parts[1]).toString());
  } catch {
    throw err('bad_token', 401);
  }

  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw err('bad_token', 401);
  }

  let jwks = await getJwks(false);
  let jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA');

  if (!jwk) {
    jwks = await getJwks(true);
    jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA');
  }

  if (!jwk) throw err('unknown_key', 401);

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      unb64u(parts[2])
    );
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) throw err('bad_signature', 401);

  const now = Math.floor(Date.now() / 1000);

  const validIssuer =
    payload.iss === 'https://accounts.google.com' ||
    payload.iss === 'accounts.google.com';

  const validAudience =
    payload.aud === clientId ||
    (Array.isArray(payload.aud) && payload.aud.includes(clientId));

  if (!validIssuer) throw err('bad_issuer', 401);
  if (!validAudience) throw err('bad_audience', 401);

  if (
    !Number.isFinite(payload.exp) ||
    payload.exp <= now - 30 ||
    !Number.isFinite(payload.iat) ||
    payload.iat > now + 300 ||
    now - payload.iat > 600 ||
    typeof payload.sub !== 'string' ||
    !payload.sub
  ) {
    throw err('expired_or_invalid_token', 401);
  }

  if (payload.azp !== undefined && payload.azp !== clientId) {
    throw err('bad_authorized_party', 401);
  }

  return payload;
}

/* =========================================================
   DATABASE
========================================================= */

const USER_COLUMNS = [
  'id', 'google_sub', 'display_name', 'color', 'coins',
  'is_guest', 'token_version', 'status'
].join(', ');

const SQL = {
  schema: [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS color VARCHAR(9) NOT NULL DEFAULT '#2e86de'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS coins BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
    `CREATE TABLE IF NOT EXISTS sessions (
       jti         TEXT PRIMARY KEY,
       user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       expires_at  TIMESTAMPTZ NOT NULL,
       revoked_at  TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS sessions_user_idx   ON sessions (user_id)`,
    `CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at)`,
    `CREATE TABLE IF NOT EXISTS ws_tickets (
       ticket_hash   TEXT PRIMARY KEY,
       user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       jti           TEXT NOT NULL,
       token_version INTEGER NOT NULL,
       expires_at    TIMESTAMPTZ NOT NULL,
       consumed_at   TIMESTAMPTZ,
       created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE ws_tickets ADD COLUMN IF NOT EXISTS jti TEXT`,
    `CREATE INDEX IF NOT EXISTS ws_tickets_expiry_idx ON ws_tickets (expires_at)`,
    `CREATE INDEX IF NOT EXISTS ws_tickets_jti_idx    ON ws_tickets (jti)`
  ],

  bySub: `SELECT ${USER_COLUMNS} FROM users WHERE google_sub = $1`,
  byId:  `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,

  insertGoogle: `INSERT INTO users
      (google_sub, email, display_name, color, is_guest, avatar_url, last_login, status)
      VALUES ($1, $2, $3, $4, FALSE, $5, NOW(), 'active')
      RETURNING ${USER_COLUMNS}`,

  updateEmail: `UPDATE users SET email = $1, updated_at = NOW()
                WHERE id = $2 AND google_sub IS NOT NULL`,

  touch: `UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`,

  profile: `UPDATE users SET display_name = $1, color = $2, updated_at = NOW()
            WHERE id = $3 RETURNING ${USER_COLUMNS}`,

  bump: `UPDATE users SET token_version = token_version + 1, updated_at = NOW()
         WHERE id = $1 RETURNING ${USER_COLUMNS}`,

  insertSession: `INSERT INTO sessions (jti, user_id, expires_at) VALUES ($1, $2, $3)`,
  loadSession: `SELECT jti, user_id, expires_at, revoked_at FROM sessions WHERE jti = $1`,
  revokeSession: `UPDATE sessions SET revoked_at = NOW()
                  WHERE jti = $1 AND revoked_at IS NULL`,
  revokeAllSessions: `UPDATE sessions SET revoked_at = NOW()
                      WHERE user_id = $1 AND revoked_at IS NULL RETURNING jti`,
  deleteStaleSessions: `DELETE FROM sessions
                        WHERE user_id = $1
                          AND (expires_at < NOW() OR revoked_at IS NOT NULL)`,

  lockUser: `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
  countActiveTickets: `SELECT COUNT(*)::int AS n FROM ws_tickets
                       WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
  deleteStaleTickets: `DELETE FROM ws_tickets
                       WHERE user_id = $1
                         AND (expires_at < NOW() OR consumed_at IS NOT NULL)`,
  deleteTicketsByJti:  `DELETE FROM ws_tickets WHERE jti = $1`,
  deleteTicketsByUser: `DELETE FROM ws_tickets WHERE user_id = $1`,
  insertTicket: `INSERT INTO ws_tickets
      (ticket_hash, user_id, jti, token_version, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '60 seconds')`,
  consumeTicket: `UPDATE ws_tickets SET consumed_at = NOW()
                  WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
                  RETURNING user_id, jti, token_version`,

  // Find most recent active session for a user (for WS ticket creation)
  latestSession: `SELECT jti FROM sessions
                  WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
                  ORDER BY created_at DESC LIMIT 1`
};

/* =========================================================
   AUTH SERVICE
========================================================= */

module.exports = function createAuth({ pool, env = process.env, fetchImpl, log = console }) {
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const secret = env.JWT_SECRET || '';

  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters');
  }
  if (!pool) log.warn('Authentication is unavailable: DATABASE_URL is missing.');

  const getJwks = makeJwksCache(fetchImpl);
  let ready = Promise.resolve(true);

  let onSessionRevoked = null;
  function setSessionRevokedHandler(handler) {
    onSessionRevoked = typeof handler === 'function' ? handler : null;
  }
  function notifyRevoked(jti) {
    if (!onSessionRevoked || !jti) return;
    try { onSessionRevoked(String(jti)); }
    catch (error) { log.error('session-revoked handler failed:', error?.message); }
  }

  /* =====================================================
     RATE LIMITING
  ===================================================== */
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
        for (const k of buckets.keys()) {
          buckets.delete(k);
          if (++i >= drop) break;
        }
      }
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) throw err('rate_limited', 429);
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now >= bucket.reset) buckets.delete(key);
    }
  }, 60000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  function bearer(req) {
    const header = String(req.headers?.authorization || '');
    const match = header.match(/^Bearer\s+([A-Za-z0-9._\-]{8,2000})$/i);
    return match ? match[1] : '';
  }

  function publicUser(user) {
    return {
      id: String(user.id),
      name: user.display_name,
      color: user.color,
      coins: String(user.coins == null ? 0 : user.coins),
      guest: false
    };
  }

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
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadUser(id) {
    const result = await db(SQL.byId, [id]);
    return result.rows[0] || null;
  }
  async function loadSession(jti) {
    const result = await db(SQL.loadSession, [jti]);
    return result.rows[0] || null;
  }

  function isEligibleUser(user) {
    return Boolean(
      user &&
      user.is_guest === false &&
      typeof user.google_sub === 'string' && user.google_sub.length > 0 &&
      user.status === 'active'
    );
  }

  /* =====================================================
     ✅ CORE IDENTITY
     ===================================================== */

  async function identify(token) {
    const payload = verifyJwt(token, secret);
    if (!payload) return null;

    try {
      const user = await loadUser(payload.uid);
      if (!isEligibleUser(user)) return null;
      if (Number(user.token_version) !== payload.v) return null;

      const session = await loadSession(payload.jti);
      if (!session) return null;
      if (session.revoked_at) return null;
      if (new Date(session.expires_at).getTime() <= Date.now()) return null;

      return publicUser(user);
    } catch (error) {
      log.error('[AUTH] identify failed:', error?.message);
      throw err('database_unavailable', 503);
    }
  }

  /* =====================================================
     ✅ SESSION / TOKEN MANAGEMENT
     ===================================================== */

  async function createSession(user) {
    const jti = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);

    await db(SQL.insertSession, [jti, user.id, expiresAt]);

    const token = signJwt({
      uid: String(user.id),
      v: Number(user.token_version),
      g: false,
      jti,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000)
    }, secret);

    return { token, jti, expiresAt };
  }

  async function revokeSession(jti) {
    if (!jti) return;
    await db(SQL.revokeSession, [jti]);
    notifyRevoked(jti);
  }

  async function revokeAllSessionsForUser(userId) {
    const result = await db(SQL.revokeAllSessions, [userId]);
    for (const row of result.rows) notifyRevoked(row.jti);
    await db(SQL.deleteTicketsByUser, [userId]);
    return result.rows.length;
  }

  /* =====================================================
     ✅ WS TICKETS (one-time, short-lived)
     ===================================================== */

  async function createWsTicket(token) {
    const identity = await identify(token);
    if (!identity) throw err('unauthorized', 401);

    return withTransaction(async (client) => {
      // Cleanup stale tickets first
      await client.query(SQL.deleteStaleTickets, [identity.id]);
      const count = await client.query(SQL.countActiveTickets, [identity.id]);
      if (count.rows[0].n >= MAX_ACTIVE_TICKETS) {
        throw err('too_many_tickets', 429);
      }

      // Lock user row to serialize ticket creation
      await client.query(SQL.lockUser, [identity.id]);

      // Load most recent session JTI
      const session = await client.query(SQL.latestSession, [identity.id]);
      if (!session.rows.length) throw err('no_active_session', 401);

      const user = await loadUser(identity.id);
      const ticket = crypto.randomBytes(32).toString('base64url');
      const hash = crypto.createHash('sha256').update(ticket).digest('hex');

      await client.query(SQL.insertTicket, [
        hash,
        identity.id,
        session.rows[0].jti,
        Number(user.token_version)
      ]);

      return ticket;
    });
  }

  async function consumeWsTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 200) {
      return null;
    }

    const hash = crypto.createHash('sha256').update(ticket).digest('hex');

    return withTransaction(async (client) => {
      const result = await client.query(SQL.consumeTicket, [hash]);
      if (!result.rows.length) return null;

      const row = result.rows[0];
      const user = await loadUser(row.user_id);
      if (!isEligibleUser(user)) return null;
      if (Number(user.token_version) !== Number(row.token_version)) return null;

      const session = await loadSession(row.jti);
      if (!session || session.revoked_at) return null;
      if (new Date(session.expires_at).getTime() <= Date.now()) return null;

      return {
        id: String(user.id),
        name: user.display_name,
        color: user.color,
        jti: String(row.jti)
      };
    });
  }

  /* =====================================================
     ✅ SESSION VALIDATION (periodic WS revalidation)
     ===================================================== */

  async function isSessionValid(jti) {
    if (!jti) return false;
    try {
      const session = await loadSession(jti);
      if (!session) return false;
      if (session.revoked_at) return false;
      if (new Date(session.expires_at).getTime() <= Date.now()) return false;
      return true;
    } catch {
      return true; // Don't kick WS on transient DB hiccup
    }
  }

  /* =====================================================
     ✅ HTTP ROUTES
     ===================================================== */

  function register(app) {
    if (!app) throw new Error('register(app) requires express app');

    // GET /auth/config — client fetches Google Client ID
    app.get('/auth/config', (req, res) => {
      if (!clientId) {
        return res.status(503).json({ ok: false, error: 'google_not_configured' });
      }
      res.json({ ok: true, googleClientId: clientId });
    });

    // POST /auth/google — exchange Google ID token for a session JWT
    app.post('/auth/google', async (req, res) => {
      try {
        limit('google', req, 10, 60_000);

        const credential = req.body && req.body.credential;
        if (typeof credential !== 'string') {
          return res.status(400).json({ ok: false, error: 'bad_request' });
        }

        const payload = await verifyGoogleIdToken(credential, clientId, getJwks);
        const sub = String(payload.sub);

        // Find or create the user
        let user = (await db(SQL.bySub, [sub])).rows[0];

        if (!user) {
          const displayName = cleanName(payload.name) || 'Player';
          const color = cleanColor(null);
          const picture = cleanPicture(payload.picture);
          const email = typeof payload.email === 'string' ? payload.email : null;

          const inserted = await db(SQL.insertGoogle, [
            sub, email, displayName, color, picture
          ]);
          user = inserted.rows[0];
        } else {
          if (!isEligibleUser(user)) {
            return res.status(403).json({ ok: false, error: 'account_disabled' });
          }
          const email = typeof payload.email === 'string' ? payload.email : null;
          if (email) await db(SQL.updateEmail, [email, user.id]).catch(() => {});
          await db(SQL.touch, [user.id]).catch(() => {});
        }

        // Create the session
        const { token } = await createSession(user);

        res.json({
          ok: true,
          token,
          user: publicUser(user)
        });
      } catch (error) {
        log.error('[AUTH] google login failed:', error?.message);
        const status = error && error.status ? error.status : 500;
        res.status(status).json({
          ok: false,
          error: error && error.code ? error.code : 'auth_failed'
        });
      }
    });

    // GET /auth/me — return current user
    app.get('/auth/me', async (req, res) => {
      try {
        limit('me', req, 120, 60_000);
        const token = bearer(req);
        const identity = token ? await identify(token) : null;
        if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

        const user = await loadUser(identity.id);
        if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

        res.json({
          ok: true,
          user: {
            ...publicUser(user),
            tokens: String(user.coins ?? 0),
            coins: String(user.coins ?? 0)
          }
        });
      } catch (error) {
        const status = error && error.status ? error.status : 500;
        res.status(status).json({ ok: false, error: error?.code || 'server_error' });
      }
    });

    // POST /auth/logout
    app.post('/auth/logout', async (req, res) => {
      try {
        limit('logout', req, 30, 60_000);
        const token = bearer(req);
        const payload = token ? verifyJwt(token, secret) : null;
        if (payload && payload.jti) {
          await revokeSession(payload.jti);
        }
        res.json({ ok: true });
      } catch (error) {
        const status = error && error.status ? error.status : 500;
        res.status(status).json({ ok: false, error: error?.code || 'server_error' });
      }
    });

    // POST /auth/ws-ticket — issue a one-time ticket for WebSocket
    app.post('/auth/ws-ticket', async (req, res) => {
      try {
        limit('ws_ticket', req, 60, 60_000);
        const token = bearer(req);
        if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });

        const ticket = await createWsTicket(token);
        res.json({ ok: true, ticket });
      } catch (error) {
        const status = error && error.status ? error.status : 500;
        res.status(status).json({ ok: false, error: error?.code || 'server_error' });
      }
    });
  }

  async function ensureSchema() {
    if (!pool) return false;
    try {
      for (const statement of SQL.schema) {
        await pool.query(statement);
      }
      return true;
    } catch (error) {
      log.error('[AUTH] ensureSchema failed:', error?.message);
      return false;
    }
  }

  return {
    register,
    ensureSchema,
    identify,
    publicUser,
    setSessionRevokedHandler,
    consumeWsTicket,
    isSessionValid,
    createWsTicket,
    // expose for tests
    _t: { SQL, verifyJwt, verifyGoogleIdToken }
  };
};

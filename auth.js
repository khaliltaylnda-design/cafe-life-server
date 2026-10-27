'use strict';

// auth.js — Cafe Life authentication. HARDENED + FIRST-PARTY COOKIE.

const crypto = require('crypto');

const SESSION_DAYS = 30;
const WS_TICKET_TTL_SECONDS = 60;
const MAX_ACTIVE_TICKETS = 5;
const MAX_RATE_BUCKETS = 100_000;
const MAX_TOKEN_AGE_SECONDS = SESSION_DAYS * 86400 + 300;

// ✅ Cookie for first-party (api.muchokutensei.com + muchokutensei.com).
// SameSite=Lax works because both are under the same registrable domain.
const COOKIE_NAME = 'cafe_session';
const COOKIE_MAX_AGE_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

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
   COOKIE HELPERS
========================================================= */

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function readSessionCookie(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const value = cookies[COOKIE_NAME];
  if (typeof value !== 'string' || !value || value.length > 2000) return '';
  return value;
}

// ✅ SameSite=Lax works because both frontend and backend share the
//    same registrable domain (muchokutensei.com).
function setSessionCookie(res, token, opts = {}) {
  if (!res || typeof res.cookie !== 'function') return;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: Boolean(opts.secure),
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookie(res, opts = {}) {
  if (!res || typeof res.clearCookie !== 'function') return;
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: Boolean(opts.secure),
    sameSite: 'lax',
    path: '/',
  });
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

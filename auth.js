'use strict';

// ============================================================================
// auth.js — Cafe Life Authentication (clean rewrite v1.1)
// ============================================================================
// المسؤوليات:
//   1. تسجيل الدخول عبر Google ID Token (RS256).
//   2. إصدار JWT + session في DB (cookie httpOnly).
//   3. إصدار tickets لـ WebSocket (single-use، TTL 60s).
//   4. identify(token) / identifyRequest(req) — cookie أو Bearer.
//   5. revoke session → يُغلق WebSocket المرتبط.
//
// ما لا يفعله:
//   - التحقق من رصيد أو صلاحيات الأعمال.
//   - تخزين كلمات مرور (Google فقط).
//   - إدارة guest accounts (معطّلة نهائياً).
// ============================================================================

const crypto = require('crypto');

// ============================================================================
// 1. CONSTANTS
// ============================================================================
const SESSION_DAYS = 30;
const WS_TICKET_TTL_SECONDS = 60;
const MAX_ACTIVE_TICKETS = 3;

const COOKIE_NAME = 'cafe_session';
const COOKIE_MAX_AGE_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

const MAX_RATE_BUCKETS = 100_000;
const MAX_TOKEN_AGE_SECONDS = SESSION_DAYS * 86400 + 300;
const MAX_JWT_LEN = 2000;
const MAX_GOOGLE_TOKEN_LEN = 4096;
const MAX_TICKET_LEN = 200;
const MIN_TICKET_LEN = 32;

const COLORS = new Set([
  '#2e86de', '#e74c3c', '#27ae60',
  '#9b59b6', '#e67e22', '#16a085',
]);

// ============================================================================
// 2. HELPERS
// ============================================================================
const err = (code, status = 400) => Object.assign(new Error(code), { code, status });

const b64u = (value) => Buffer.from(value).toString('base64url');
const unb64u = (value) => Buffer.from(String(value), 'base64url');

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
  const c = String(value == null ? '' : value);
  return COLORS.has(c) ? c : '#2e86de';
}

function cleanPicture(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  if (!value.startsWith('https://lh3.googleusercontent.com/')) return null;
  return value;
}

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
  if (typeof value !== 'string' || !value || value.length > MAX_JWT_LEN) return '';
  return value;
}

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

// ============================================================================
// 3. JWT
// ============================================================================
function signJwt(payload, secret) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const input = header + '.' + body;
  const signature = crypto.createHmac(
... 

'use strict';

// ============================================================================
// server.js — Cafe Life Entrypoint (clean rewrite v1.1)
// ============================================================================
// المسؤوليات:
//   1. تحميل الإعدادات من البيئة.
//   2. إنشاء pool + modules (auth, wallet, wager, stripe, games).
//   3. تركيب Express (CORS, CSRF, JSON, cookie-parser, routes).
//   4. إنشاء HTTP + WebSocket.
//   5. تشغيل background workers (cleanup, retries).
//   6. إغلاق نظيف عند SIGTERM/SIGINT.
// ============================================================================

const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { Pool } = require('pg');

const createAuth = require('./auth');
const createWallet = require('./wallet/wallet');
const registerWalletRoutes = require('./wallet/wallet.routes');
const createStripe = require('./payments/stripe');
const registerPaymentsRoutes = require('./payments/payments.routes');
const createWager = require('./wager/wager');
const registerWagerRoutes = require('./wager/wager.routes');

// ============================================================================
// 1. ENVIRONMENT
// ============================================================================
const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 10000),
  IS_PRODUCTION: process.env.NODE_ENV === 'production',

  DATABASE_URL: process.env.DATABASE_URL || '',

  FRONTEND_ORIGIN: String(process.env.FRONTEND_ORIGIN || 'https://www.muchokutensei.com').replace(/\/+$/, ''),
  FRONTEND_URL: String(process.env.FRONTEND_URL || process.env.FRONTEND_ORIGIN || 'https://www.muchokutensei.com').replace(/\/+$/, ''),

  JWT_SECRET: process.env.JWT_SECRET || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

  TURN_SECRET: process.env.TURN_SECRET || '',
  TURN_HOST: process.env.TURN_HOST || '',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  // WebSocket
  MAX_WS_PAYLOAD: 32 * 1024,
  AUTH_TIMEOUT_MS: 10_000,
  HEARTBEAT_INTERVAL_MS: 30_000,
  SESSION_CHECK_INTERVAL_MS: 15_000,

  // Rate limits (per player)
  MOVE_RATE_MAX: 30,
  MOVE_RATE_WINDOW: 1_000,
  CHAT_RATE_MAX: 10,
  CHAT_RATE_WINDOW: 10_000,
  SIGNAL_RATE_MAX: 60,
  SIGNAL_RATE_WINDOW: 60_000,

  // Limits
  MAX_SDP_LEN: 20_000,
  MAX_CANDIDATE_LEN: 2_000,
  MAX_CHAT_LEN: 80,

  // Background workers
  WAGER_CLEANUP_INTERVAL_MS: 60_000,
  WAGER_EXPIRE_INTERVAL_MS: 60 * 60_000,
  WAGER_RETRY_INTERVAL_MS: 30_000,

  // DB
  DB_RETRY_ATTEMPTS: 15,
  DB_RETRY_MAX_WAIT_MS: 15_000,
};

const WS_CLOSE_REVOKED = 1008;

// ============================================================================
// 2. LOGGER
// ============================================================================
// الكائن يحتوي على log/warn/error/debug/info + log كـ alias للتوافق مع
// الوحدات القديمة التي تستخدم log.log(...) و log.warn(...) و log.error(...).
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: (...args) => { if (!ENV.IS_PRODUCTION) console.log('[DEBUG]', ...args); },
  // Aliases for legacy modules
  log: (...args) => console.log(...args),
};

// ============================================================================
// 3. POSTGRES POOL
// ============================================================================
let pool = null;

if (ENV.DATABASE_URL) {
  pool = new Pool({
    connectionString: ENV.DATABASE_URL,
    ssl: ENV.IS_PRODUCTION ? { rejectUnauth
... 

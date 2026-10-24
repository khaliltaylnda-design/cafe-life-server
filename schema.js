'use strict';
// schema.js — migrations آمنة (idempotent): ما تمسح شي وما تبدّل بيانات موجودة.
// تتنفّذ في transaction واحدة تحت advisory lock باش ما يصيرش تعارض كان فما أكثر من instance.
const LOCK_ID = 727001;

const STATEMENTS = [
  // الجدول الأصلي (موجود عندك): نفس التعريف، ما يتبدّل
  `CREATE TABLE IF NOT EXISTS users (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     email TEXT UNIQUE,
     password_hash TEXT,
     google_sub TEXT UNIQUE,
     display_name VARCHAR(40) NOT NULL DEFAULT 'ضيف',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // هوية اللعبة: معرّف عام ثابت (ما نكشفوش id الداخلي للاعبين الآخرين)
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid()',
  'CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_key ON users (public_id)',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS color VARCHAR(9) NOT NULL DEFAULT '#2e86de'",
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS coins BIGINT NOT NULL DEFAULT 0',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'",
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ',
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_coins_nonneg') THEN
     ALTER TABLE users ADD CONSTRAINT users_coins_nonneg CHECK (coins >= 0); END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_valid') THEN
     ALTER TABLE users ADD CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')); END IF; END $$`,
  // google_sub إجباري: كان فما صفوف قديمة بلا google_sub، ما نفرضوهاش (ما نكسّروش بيانات)
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM users WHERE google_sub IS NULL) THEN
     ALTER TABLE users ALTER COLUMN google_sub SET NOT NULL; END IF; END $$`,

  // الجلسات (refresh tokens مخزّنة كـhash فقط)
  `CREATE TABLE IF NOT EXISTS sessions (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     refresh_hash TEXT NOT NULL UNIQUE,
     prev_hash TEXT,
     rotated_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     revoked_at TIMESTAMPTZ,
     revoke_reason TEXT,
     user_agent TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)',
  'CREATE INDEX IF NOT EXISTS sessions_prev_idx ON sessions (prev_hash) WHERE prev_hash IS NOT NULL',

  // دفتر العملة: كل تغيير في الرصيد = سطر، وidempotency_key فريد لكل لاعب
  `CREATE TABLE IF NOT EXISTS coin_transactions (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users(id),
     amount BIGINT NOT NULL CHECK (amount <> 0),
     reason TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     ref TEXT,
     balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT coin_tx_idem UNIQUE (user_id, idempotency_key)
   )`,
  'CREATE INDEX IF NOT EXISTS coin_tx_user_idx ON coin_transactions (user_id, created_at)',

  // الهدايا (تتعرّف من عندك كـadmin بـSQL، مش من الكلاينت)
  `CREATE TABLE IF NOT EXISTS gifts (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     amount BIGINT NOT NULL CHECK (amount > 0),
     active BOOLEAN NOT NULL DEFAULT TRUE,
     starts_at TIMESTAMPTZ,
     ends_at TIMESTAMPTZ,
     max_claims INTEGER CHECK (max_claims IS NULL OR max_claims > 0),
     claims_count INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS gift_claims (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     gift_id TEXT NOT NULL REFERENCES gifts(id),
     user_id BIGINT NOT NULL REFERENCES users(id),
     tx_id BIGINT REFERENCES coin_transactions(id),
     claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT gift_claims_once UNIQUE (gift_id, user_id)
   )`,
];

async function migrate(pool, log = console) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    for (const sql of STATEMENTS) await c.query(sql);
    await c.query('COMMIT');
    log.log && log.log('Database migrations applied (' + STATEMENTS.length + ' statements).');
    return true;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { c.release(); }
}

module.exports = { migrate, STATEMENTS };

-- Migration 037: Local-auth hardening
-- Description: Removes the shared demo password, forces an operator-set password
-- per account, adds per-account login throttling state, and adds the rotated
-- refresh-token history used to detect refresh-token replay.
--
-- ORDERING (read this before renumbering anything):
--   migrations/017_auth_local.sql seeds eight demo accounts with bcrypt hashes of
--   the SAME shared password and does `ON CONFLICT ... DO UPDATE SET
--   password_hash = EXCLUDED.password_hash, is_active = TRUE`. runMigrations()
--   re-applies every .sql file on every boot in filename order, so 017 re-writes
--   that shared hash and re-activates those accounts at every single boot.
--   This file must therefore run AFTER 017 and neutralise it on every boot.
--   That is the only reason the fix lives here instead of in 017: migrations are
--   forward-only and 001-030 are never edited.
--   This file deliberately does NOT re-activate anything (no is_active writes).
--
-- Idempotent / re-runnable: every statement is IF NOT EXISTS or a narrowly
-- targeted UPDATE, so re-applying it on each boot is a no-op once the demo
-- hashes are gone and real passwords have been set.

-- ---------------------------------------------------------------------------
-- 1. Account state columns (password reset flag + login throttling counters)
-- ---------------------------------------------------------------------------
ALTER TABLE health.user_accounts
    ADD COLUMN IF NOT EXISTS must_reset_password    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS failed_attempt_count   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_failed_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS locked_until           TIMESTAMPTZ;

COMMENT ON COLUMN health.user_accounts.must_reset_password IS
    'TRUE means password_hash is unusable and an operator must set a real password before this account can log in.';
COMMENT ON COLUMN health.user_accounts.failed_attempt_count IS
    'Consecutive failed local-password attempts. Reset to 0 on successful login (see backend/src/modules/auth/routes.ts).';
COMMENT ON COLUMN health.user_accounts.locked_until IS
    'When in the future, /api/auth/login answers 429 with Retry-After for this account. Set once failed_attempt_count reaches LOGIN_MAX_ATTEMPTS.';

CREATE INDEX IF NOT EXISTS idx_user_accounts_locked_until
    ON health.user_accounts (locked_until)
    WHERE locked_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Kill the shared demo password
-- ---------------------------------------------------------------------------
-- All eight personas seeded by 017 share ONE password (different salts, same
-- plaintext), so one leaked credential is every account. A SQL migration cannot
-- compute bcrypt hashes, so it cannot mint eight distinct strong passwords here.
-- Instead every affected account is moved to an unusable sentinel that no input
-- can ever match: it is not a bcrypt string (wrong prefix, wrong length), and
-- the login handler additionally refuses any hash that fails a bcrypt shape
-- check before it even calls bcrypt.compare.
--
-- OPERATOR ACTION REQUIRED — these accounts cannot log in until someone runs a
-- one-off script (not committed; nothing in this repo sets these yet) that, per
-- account, generates an independent high-entropy password, bcrypt-hashes it with
-- cost >= 12, and runs:
--     UPDATE health.user_accounts
--        SET password_hash = $1,            -- fresh bcrypt hash, unique per account
--            must_reset_password = FALSE,
--            failed_attempt_count = 0,
--            locked_until = NULL,
--            updated_at = NOW()
--      WHERE LOWER(username) = LOWER($2);
-- Passwords must be delivered out of band and never committed or logged.
--
-- The WHERE clause matches only the exact hashes 017 writes. That is what makes
-- this safe to re-run: it re-neutralises 017's reseed on every boot, but it can
-- never clobber a real password an operator has set (a fresh bcrypt hash has a
-- different salt and so is not in this list).
UPDATE health.user_accounts
   SET password_hash = 'DISABLED:no-password-set:see-migration-037',
       must_reset_password = TRUE,
       updated_at = NOW()
 WHERE password_hash IN (
        '$2b$10$2320OgAn.7UoMM3BChTEselMxYqMoQ1nElP7k.ywC1wXDgbTKVJda',
        '$2b$10$9MuWx4wcv.27BkCUG6mc1.6alYTSF0FVEKPwl/Z6f4ySnnuuw3SMa',
        '$2b$10$tsQMsDhkslUHlsrtImu/MOn1iMqOjaSB1ren1bKmo633r9WIBm4FO',
        '$2b$10$fPDw37ZijVUu1IMTGhaTYuwzGdrUv6Q3JS1dLER5cg2r76YpFVLoS',
        '$2b$10$bUZ7wi1jg/DJW7PK0romteBRXaaE6E5a0gsoh4Yjp4tka7KrF/Tsi',
        '$2b$10$xhm0TKpApmwcOc6ljNI7ku18VeTPYVozU5PIkW5ZhJ/uYHxOQ1qCq',
        '$2b$10$jOaLnRQbMmVJnPkw1QoKquzMDe0cE2qb3PVSsBfXf3RBhGFXHNmIm',
        '$2b$10$bcc7wh0j4SXeZ0R7M45bOeJFrwXqICccqzPHhYSzczlqiHXb4mY7a'
       );

-- Any account still flagged for reset must not carry a usable hash, whatever
-- else touched it. (No-op unless something re-introduced a hash without
-- clearing the flag.)
UPDATE health.user_accounts
   SET password_hash = 'DISABLED:no-password-set:see-migration-037',
       updated_at = NOW()
 WHERE must_reset_password
   AND password_hash IS NOT NULL
   AND password_hash <> 'DISABLED:no-password-set:see-migration-037'
   AND password_hash ~ '^\$2[aby]\$';

-- ---------------------------------------------------------------------------
-- 3. Rotated refresh-token history (replay detection)
-- ---------------------------------------------------------------------------
-- POST /api/auth/refresh rotates the refresh token on every use. Once rotated,
-- the old token's hash is no longer in health.auth_sessions.refresh_token_hash,
-- so without this table a replayed token would be indistinguishable from a
-- random one. Presenting a hash recorded here means a rotated token was reused
-- (stolen or replayed), and the whole session is revoked.
-- Only SHA-256 hashes are stored — never a raw token, here or anywhere else.
CREATE TABLE IF NOT EXISTS health.auth_refresh_history (
    token_hash TEXT PRIMARY KEY,
    session_id UUID NOT NULL,
    rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_history_session
    ON health.auth_refresh_history (session_id);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_history_rotated
    ON health.auth_refresh_history (rotated_at);

COMMENT ON TABLE health.auth_refresh_history IS
    'SHA-256 hashes of superseded refresh tokens. A hit here on /api/auth/refresh means replay: revoke the session. Prune rows older than REFRESH_TOKEN_TTL_DAYS with a scheduled job.';

-- ---------------------------------------------------------------------------
-- 4. Least-privilege grants (+ one index on migration 038's table)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
        GRANT SELECT, UPDATE ON health.user_accounts TO hrms_app;
        GRANT SELECT, INSERT, DELETE ON health.auth_refresh_history TO hrms_app;
        -- health.auth_sessions is created by migration 038, which sorts after
        -- this file, so on a fresh database it does not exist yet. Grant it only
        -- if present; the next boot picks it up.
        IF to_regclass('health.auth_sessions') IS NOT NULL THEN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE ON health.auth_sessions TO hrms_app';
        END IF;
    END IF;

    -- /api/auth/refresh looks a session up by refresh_token_hash on every call.
    -- Same ordering caveat as above: created on the boot after 038 first runs.
    IF to_regclass('health.auth_sessions') IS NOT NULL THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh_hash '
             || 'ON health.auth_sessions (refresh_token_hash) '
             || 'WHERE refresh_token_hash IS NOT NULL';
    END IF;
END
$$;

-- END OF MIGRATION 037

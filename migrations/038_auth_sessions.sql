-- Migration 038: Authentication sessions (server-side session state)
-- Applied: After 033 (RLS helpers) — depends on health.fn_current_person() and health.fn_has_role(text)
-- Description: Access tokens no longer carry roles or any authorisation state; they
-- carry an identity and a session id (`sid`). This table is the authority on whether
-- a token is still usable, which is what makes logout, revocation and forced
-- re-authentication possible without rotating the signing key.
--
-- IDEMPOTENT: runMigrations() re-applies every file on every boot, so every
-- statement here is guarded (IF NOT EXISTS / DROP ... IF EXISTS / DO blocks).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid() on PostgreSQL < 13

-- ============================================================
-- TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS health.auth_sessions (
    session_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id           UUID NOT NULL,
    refresh_token_hash  TEXT,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    revoked_reason      TEXT,
    last_seen_at        TIMESTAMPTZ,
    ip_address          INET,
    user_agent          TEXT
);

-- Hedge against a partially created table from an interrupted earlier boot.
ALTER TABLE health.auth_sessions
    ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT,
    ADD COLUMN IF NOT EXISTS revoked_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS revoked_reason     TEXT,
    ADD COLUMN IF NOT EXISTS last_seen_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ip_address         INET,
    ADD COLUMN IF NOT EXISTS user_agent         TEXT;

-- ============================================================
-- FOREIGN KEY
-- health.persons.logical_id is a plain UUID PRIMARY KEY (migration 001), not part
-- of a composite bitemporal key, so a real FK is possible here. Deletes are
-- RESTRICTed: a person row is immutable identity and must not be removed while
-- sessions reference it. ADD CONSTRAINT has no IF NOT EXISTS, hence the guard.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'health'
          AND t.relname = 'auth_sessions'
          AND c.conname = 'auth_sessions_person_fk'
    ) THEN
        ALTER TABLE health.auth_sessions
            ADD CONSTRAINT auth_sessions_person_fk
            FOREIGN KEY (person_id) REFERENCES health.persons (logical_id) ON DELETE RESTRICT;
    END IF;
END $$;

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_auth_sessions_person ON health.auth_sessions (person_id);

-- Every authenticated request looks a session up by id and requires it to be live.
CREATE INDEX IF NOT EXISTS idx_auth_sessions_live ON health.auth_sessions (session_id)
    WHERE revoked_at IS NULL;

-- ============================================================
-- ROW LEVEL SECURITY
-- A session row is a credential record: it says which device is logged in as
-- whom, from which address. A person may see only their own; hr_admin,
-- senior_admin and auditor may see all, because revoking someone else's session
-- and investigating access are legitimate administrative acts.
--
-- Guarded on the migration-033 helpers existing: enabling RLS with no policy
-- would deny the session lookup in authenticate() and lock everyone out.
-- ============================================================
DO $$
DECLARE
    v_helpers_present BOOLEAN;
BEGIN
    SELECT
        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'health' AND p.proname = 'fn_current_person')
        AND
        EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'health' AND p.proname = 'fn_has_role')
    INTO v_helpers_present;

    IF NOT v_helpers_present THEN
        RAISE WARNING 'migration 038: health.fn_current_person()/fn_has_role() missing (migration 033 not applied) - row-level security NOT enabled on health.auth_sessions';
        RETURN;
    END IF;

    EXECUTE 'ALTER TABLE health.auth_sessions ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_select ON health.auth_sessions';
    EXECUTE $p$
        CREATE POLICY auth_sessions_select ON health.auth_sessions
            FOR SELECT
            USING (
                person_id = health.fn_current_person()
                OR health.fn_has_role('hr_admin')
                OR health.fn_has_role('senior_admin')
                OR health.fn_has_role('auditor')
            )
    $p$;

    -- Writes: login has to insert the session row before any request context
    -- exists, so fn_current_person() is NULL at that moment. That is the only
    -- reason the NULL case is permitted here; it is a trusted server-side path,
    -- never a browser-reachable one. Reads stay strictly scoped above.
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_insert ON health.auth_sessions';
    EXECUTE $p$
        CREATE POLICY auth_sessions_insert ON health.auth_sessions
            FOR INSERT
            WITH CHECK (
                health.fn_current_person() IS NULL
                OR person_id = health.fn_current_person()
            )
    $p$;

    -- Revocation (logout, refresh rotation, admin kill) and last_seen_at.
    EXECUTE 'DROP POLICY IF EXISTS auth_sessions_update ON health.auth_sessions';
    EXECUTE $p$
        CREATE POLICY auth_sessions_update ON health.auth_sessions
            FOR UPDATE
            USING (
                health.fn_current_person() IS NULL
                OR person_id = health.fn_current_person()
                OR health.fn_has_role('hr_admin')
                OR health.fn_has_role('senior_admin')
            )
            WITH CHECK (
                health.fn_current_person() IS NULL
                OR person_id = health.fn_current_person()
                OR health.fn_has_role('hr_admin')
                OR health.fn_has_role('senior_admin')
            )
    $p$;
END $$;

-- ============================================================
-- GRANTS
-- No DELETE: sessions are revoked, not erased, so the trail survives.
-- ============================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
        GRANT USAGE ON SCHEMA health TO hrms_app;
        GRANT SELECT, INSERT, UPDATE ON health.auth_sessions TO hrms_app;
    ELSE
        RAISE NOTICE 'migration 038: role hrms_app does not exist - skipped grants on health.auth_sessions';
    END IF;
END $$;

-- ============================================================
-- COMMENTS
-- ============================================================
COMMENT ON TABLE health.auth_sessions IS 'Server-side session state. A JWT is valid only while its sid names a live row here (not revoked, not expired).';
COMMENT ON COLUMN health.auth_sessions.refresh_token_hash IS 'Hash of the refresh token - never the token itself.';
COMMENT ON COLUMN health.auth_sessions.revoked_at IS 'Set on logout, refresh rotation or administrative kill. Rows are never deleted.';
COMMENT ON COLUMN health.auth_sessions.last_seen_at IS 'Last request observed on this session - for stale-session review.';

-- ============================================================
-- END OF MIGRATION 038
-- ============================================================

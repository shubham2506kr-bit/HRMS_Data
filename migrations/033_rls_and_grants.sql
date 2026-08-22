-- ============================================================
-- Migration 033: Row-level security and least-privilege grants
-- Author: remediation pass, 2026-08-22
-- ============================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Before this migration the system had no database-level isolation whatsoever:
-- no ROW LEVEL SECURITY, no CREATE POLICY, no current_setting() anywhere. All
-- access control lived in application WHERE clauses, so a single forgotten
-- predicate exposed every employee's payroll, health and audit data. Worse, the
-- application connected as the `postgres` superuser, which meant every GRANT in
-- migrations 001-030 was inert: superusers and table owners bypass RLS
-- entirely, so even adding policies would have changed nothing.
--
-- HOW IT WORKS
-- ------------
-- backend/src/db/pool.ts wraps each request-scoped statement in a transaction
-- and issues, with bound parameters:
--
--     SELECT set_config('app.person_id', $1, true);
--     SELECT set_config('app.roles',     $2, true);
--
-- `app.roles` is comma-wrapped, e.g. ',self,employee,hr_generalist,', so that
-- fn_has_role() can test for an exact element without prefix collisions
-- ('hr' must not match 'hr_generalist' — that exact substring bug existed in
-- lib/auth.ts and escalated hr_restricted to hr_generalist).
--
-- The identity comes from AsyncLocalStorage (backend/src/lib/requestContext.ts),
-- established by authenticate() after the token is verified. Roles are derived
-- from live database state on each request; they are no longer carried in the JWT.
--
-- WHAT THE OPERATOR MUST DO — THE APP WILL NOT WORK UNTIL THIS IS DONE
-- --------------------------------------------------------------------
--   1. Change the hrms_app password set below (search for CHANGE_ME).
--   2. Repoint DATABASE_URL at hrms_app instead of postgres, with sslmode=require.
--      backend/src/config/index.ts refuses to boot in production otherwise.
--   3. Keep a separate superuser connection for migrations and for the scheduler
--      (see the note on background jobs at the foot of this file).
--
-- DELIBERATE OMISSION: FORCE ROW LEVEL SECURITY is NOT used. These tables are
-- owned by postgres, and FORCE would apply policies to the owner too, which
-- would break the migration runner and hand-run administration. ENABLE is
-- sufficient once the application connects as a non-owner, non-superuser role.
-- ============================================================

-- ============================================================
-- SECTION 1 — The application role
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
        -- NOSUPERUSER and NOBYPASSRLS are the whole point of this role.
        CREATE ROLE hrms_app LOGIN
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
            PASSWORD 'CHANGE_ME_before_use';
        RAISE NOTICE 'Created role hrms_app. CHANGE ITS PASSWORD before use.';
    ELSE
        RAISE NOTICE 'Role hrms_app already exists; leaving its password alone.';
    END IF;
END $$;

GRANT USAGE ON SCHEMA health TO hrms_app;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'health_data') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA health_data TO hrms_app';
    END IF;
END $$;

-- Data-modifying rights, but no DDL and no ownership. DELETE is granted only
-- where a business flow genuinely removes rows; the audit trail is handled
-- separately in SECTION 7 and in migration 039.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA health TO hrms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA health TO hrms_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA health TO hrms_app;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'health_data') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA health_data TO hrms_app';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA health_data TO hrms_app';
    END IF;
END $$;

-- Rows the application legitimately deletes (soft-delete is preferred elsewhere).
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'motivation_favorites', 'motivation_skips', 'project_dependencies',
        'project_members', 'notifications'
    ]
    LOOP
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'health' AND tablename = t) THEN
            EXECUTE format('GRANT DELETE ON health.%I TO hrms_app', t);
        END IF;
    END LOOP;
END $$;

-- Future tables created by later migrations inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA health
    GRANT SELECT, INSERT, UPDATE ON TABLES TO hrms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA health
    GRANT USAGE, SELECT ON SEQUENCES TO hrms_app;

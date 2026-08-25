-- Migration 040: repair the row-level-security identity bridge
-- Forward-only. Idempotent and safe to re-run.
--
-- ============================================================
-- WHAT WAS BROKEN
-- ============================================================
-- Every person-scoped RLS policy in this schema authorises through
-- health.fn_current_person() and health.fn_has_role(text). Both were wrong:
--
--   * fn_current_person() read current_setting('hrms.person_id'), but the
--     application sets 'app.person_id' — see backend/src/db/pool.ts, where
--     SETTING_PERSON = 'app.person_id' is applied with set_config() over bound
--     parameters. No migration in this repository has ever referenced
--     'hrms.person_id' apart from that one function body, and nothing anywhere
--     sets it. The function therefore returned NULL on every call, so
--     `person_id = health.fn_current_person()` evaluated to NULL, which is not
--     TRUE, so every policy denied. With DB_RLS_ENABLED=true — the committed
--     configuration — the protected tables returned ZERO rows to every caller,
--     including each person's own rows.
--
--   * fn_has_role(text) was `SELECT FALSE`. Every role-based branch, including
--     health.fn_is_clinical_role(), was therefore permanently closed.
--
-- Neither was a data leak: both failed in the deny direction. The effect was a
-- silently non-functional application whenever the security control was on,
-- which is why enabling RLS looked like "the database is empty".
--
-- migrations/036_consent_retention.sql:465-488 says "033 owns
-- health.fn_current_person() and health.fn_has_role(text)" and defines
-- fail-closed stubs if 033 did not. 033 never defined either function — it
-- mentions fn_has_role only in a comment on line 25 — so the stub branch was
-- the only branch that ever ran. This migration takes ownership of both.
--
-- ============================================================
-- THE CONTRACT, IN ONE PLACE
-- ============================================================
-- These two settings are the whole identity surface between the application and
-- row-level security. If you change a name on either side, change it on both:
--
--   app.person_id   uuid, or ''         backend/src/db/pool.ts  SETTING_PERSON
--   app.roles       ',a,b,c,' or ''     backend/src/db/pool.ts  SETTING_ROLES
--
-- app.roles is comma-WRAPPED, deliberately. Testing for ',hr,' inside
-- ',self,employee,hr,' matches a whole element and cannot match a prefix of a
-- longer role name. A substring test — LIKE '%hr%' — was a real
-- privilege-escalation bug: it made 'hr_generalist' satisfy a test for 'hr'.
-- Do not "simplify" the position() test below into a LIKE or a regex.

-- ============================================================
-- fn_current_person(): the acting person, or NULL
-- ============================================================
-- STABLE, not IMMUTABLE: the value changes between statements as the pool
-- applies a new request's identity. SECURITY INVOKER (the default) is correct —
-- this must not run with the definer's authority.
--
-- Fails closed by construction: an unset, empty or malformed setting yields
-- NULL, and `person_id = NULL` is never TRUE.
CREATE OR REPLACE FUNCTION health.fn_current_person()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_raw TEXT;
BEGIN
    v_raw := NULLIF(current_setting('app.person_id', TRUE), '');
    IF v_raw IS NULL THEN
        RETURN NULL;
    END IF;
    -- A malformed setting must deny, not error: an exception here would abort
    -- the caller's statement instead of filtering their rows.
    BEGIN
        RETURN v_raw::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;
END;
$$;

COMMENT ON FUNCTION health.fn_current_person() IS
    'The person id the current statement is acting as, from app.person_id (set by backend/src/db/pool.ts). NULL when absent or malformed, which makes every person-scoped policy deny. Corrected in migration 040; it previously read hrms.person_id, which nothing sets.';

-- ============================================================
-- fn_has_role(text): exact-element test against app.roles
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_has_role(p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    -- app.roles is comma-wrapped, so ',' || p_role || ',' matches a whole
    -- element only. COALESCE makes an unset setting deny rather than return
    -- NULL. A role name that is itself empty or contains a comma can never
    -- match a well-formed setting.
    SELECT COALESCE(
        position(',' || p_role || ',' IN COALESCE(current_setting('app.roles', TRUE), '')) > 0,
        FALSE
    )
    AND p_role IS NOT NULL
    AND p_role <> ''
    AND position(',' IN p_role) = 0;
$$;

COMMENT ON FUNCTION health.fn_has_role(TEXT) IS
    'TRUE when p_role is an element of app.roles (set by backend/src/db/pool.ts). Exact-element test against the deliberately comma-wrapped setting; a substring test would let hr_generalist satisfy a test for hr. Implemented in migration 040, where it was previously SELECT FALSE.';

-- ============================================================
-- Re-assert EXECUTE so the application role can evaluate its own policies
-- ============================================================
-- A policy calls these as the querying role. Without EXECUTE the query errors
-- instead of filtering. Granted defensively: only to roles that exist.
DO $$
DECLARE
    g TEXT;
BEGIN
    FOREACH g IN ARRAY ARRAY['hrms_app', 'app_service', 'health_service']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_current_person() TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_has_role(TEXT) TO %I', g);
            IF to_regprocedure('health.fn_is_clinical_role()') IS NOT NULL THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_is_clinical_role() TO %I', g);
            END IF;
        END IF;
    END LOOP;
END $$;

-- ============================================================
-- SELF-TEST: assert the bridge actually carries an identity
-- ============================================================
-- This is the check whose absence let the defect ship. It runs inside the
-- migration's transaction and uses set_config(..., is_local => true), so the
-- values do not outlive this migration.
DO $$
DECLARE
    v_probe   CONSTANT UUID := '00000000-0000-4000-8000-00000000fee1';
    v_got     UUID;
    v_has     BOOLEAN;
BEGIN
    PERFORM set_config('app.person_id', v_probe::TEXT, TRUE);
    PERFORM set_config('app.roles', ',self,employee,hr_generalist,', TRUE);

    v_got := health.fn_current_person();
    IF v_got IS DISTINCT FROM v_probe THEN
        RAISE EXCEPTION
            'fn_current_person() returned % but app.person_id was set to %. The identity bridge is still broken; RLS would deny every row.',
            COALESCE(v_got::TEXT, 'NULL'), v_probe;
    END IF;

    -- Exact element present.
    IF NOT health.fn_has_role('employee') THEN
        RAISE EXCEPTION 'fn_has_role(''employee'') was FALSE for roles ,self,employee,hr_generalist,';
    END IF;
    -- Exact element that is a PREFIX of another element must NOT match. This is
    -- the privilege-escalation regression test.
    IF health.fn_has_role('hr') THEN
        RAISE EXCEPTION 'fn_has_role(''hr'') matched inside ''hr_generalist'' — the comma-wrapped exact-element test has regressed into a substring match.';
    END IF;
    -- Absent element.
    IF health.fn_has_role('finance') THEN
        RAISE EXCEPTION 'fn_has_role(''finance'') was TRUE for roles that do not include it';
    END IF;

    -- No identity at all must deny.
    PERFORM set_config('app.person_id', '', TRUE);
    PERFORM set_config('app.roles', '', TRUE);
    IF health.fn_current_person() IS NOT NULL THEN
        RAISE EXCEPTION 'fn_current_person() returned non-NULL with app.person_id unset';
    END IF;
    v_has := health.fn_has_role('employee');
    IF v_has IS NOT FALSE THEN
        RAISE EXCEPTION 'fn_has_role() returned % with app.roles unset; it must be FALSE', v_has;
    END IF;

    -- Malformed identity must deny, not raise.
    PERFORM set_config('app.person_id', 'not-a-uuid', TRUE);
    IF health.fn_current_person() IS NOT NULL THEN
        RAISE EXCEPTION 'fn_current_person() accepted a malformed app.person_id';
    END IF;

    PERFORM set_config('app.person_id', '', TRUE);
    RAISE NOTICE 'Migration 040: identity bridge verified (app.person_id -> fn_current_person, app.roles -> fn_has_role, exact-element).';
END $$;

-- ============================================================
-- END OF MIGRATION 040
-- ============================================================

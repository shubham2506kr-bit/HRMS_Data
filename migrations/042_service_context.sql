-- =============================================================================
-- 042_service_context.sql
--
-- Adds health.fn_is_service_context(): the database half of a marker that lets a
-- row-level-security policy tell the scheduler apart from an unauthenticated
-- caller.
--
-- WHY THIS EXISTS
--
-- Before this migration there were two states at the database level, not three:
--
--   an authenticated request     app.person_id = '<uuid>'
--   everything else              app.person_id unset
--
-- and "everything else" covered both a background job and a request that never
-- presented a token. backend/src/lib/requestContext.ts made that explicit —
-- runAsSystem() stored `undefined`, the same value an unauthenticated request
-- had — and backend/src/db/pool.ts applied no settings for either.
--
-- That conflation is harmless while nothing is protected. It becomes a trap the
-- moment RLS covers the tables the scheduler writes to. Those are, per
-- backend/src/lib/jobs.ts: health.attendance_events, audit_log,
-- audit_log_archive, certifications, leave_requests, notifications, open_items,
-- payroll_runs and persons. A plain "self or privileged" policy on any of them
-- does not make the scheduler fail — it makes the scheduler match zero rows. The
-- job then completes, reports success, updates last_status = 'SUCCESS', and
-- quietly stops doing its work. Attendance anomalies stop being flagged and
-- certification expiries stop being noticed, with a green scheduler page.
--
-- Two obvious fixes were both rejected:
--
--   * Give the scheduler a person id. It would attribute machine writes to a
--     human being. The audit trail is the one artefact in this system that has
--     to be believable, and health.audit_log.person_id would start naming
--     someone who was asleep.
--   * Let it connect as a BYPASSRLS role. That grants unrestricted read of
--     clinical free text and salaries to the least-supervised code path in the
--     process, permanently, to solve a problem that is about nine tables.
--
-- So the scheduler declares itself instead, and each policy decides. The marker
-- is a POSITIVE assertion: app.service_context is 'on' only for runAsSystem, and
-- absent otherwise, so the default for an unauthenticated request stays closed.
-- Nothing is granted here. This migration adds a predicate and no policy uses it
-- yet; 043 does, table by table, where a job genuinely needs it.
--
-- WHAT STOPS A CLIENT FROM SETTING IT
--
-- Nothing in SQL, and that is not the boundary. app.service_context is set by
-- db/pool.ts over a bound set_config() parameter, from a value that is never
-- derived from request input — it is a compile-time constant reached only via
-- the ServiceContext branch. An attacker who could execute arbitrary SQL as
-- hrms_app could set it, but such an attacker could also read the tables
-- directly; RLS is not a defence against SQL execution. What this defends
-- against is the ordinary case: a request handler, running the ordinary query
-- path, being handed rows that belong to the scheduler's remit.
--
-- Depends on: 040 (fn_current_person, fn_has_role).
-- Forward-only. Idempotent. Does not touch 001-030.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -----------------------------------------------------------------------------
-- The predicate.
--
-- STABLE, not IMMUTABLE: it reads a session setting, which can change between
-- statements. Marking it IMMUTABLE would let the planner fold it to a constant
-- and cache that across statements on the same connection — which, on a pooled
-- connection, means one caller's answer serving another caller's query.
--
-- SET search_path = pg_catalog, pg_temp: this function is called from inside RLS
-- policies, i.e. with the privileges of whoever is running the query, and a
-- caller-controlled search_path could otherwise resolve current_setting to a
-- shadowing function in a schema the caller can write to.
--
-- current_setting(..., TRUE) — the missing_ok form. Without it, an unset
-- app.service_context raises undefined_object, and since this is evaluated
-- inside a policy the error surfaces as a failed query rather than a denied row.
-- A predicate used for access control must answer false, not throw.
--
-- Exactly 'on' is accepted, after trimming and lowercasing. Not "any non-empty
-- value", because '' and 'off' and 'false' would then all read as true, and the
-- reset path in db/pool.ts writes '' to clear it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_is_service_context()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT lower(trim(COALESCE(current_setting('app.service_context', TRUE), ''))) = 'on';
$fn$;

COMMENT ON FUNCTION health.fn_is_service_context() IS
'TRUE only for backend background work (runAsSystem in backend/src/lib/requestContext.ts, '
'which makes db/pool.ts set app.service_context = ''on''). FALSE for authenticated requests '
'and FALSE for unauthenticated ones. Grants nothing on its own: a policy must name it. '
'Use it only where a scheduled job must reach rows no person owns; never as a substitute '
'for fn_current_person() or fn_has_role(). Added by migration 042.';

-- -----------------------------------------------------------------------------
-- Convenience predicate for the common shape in 043: "this person, or the
-- system". Defined here so that the two-part condition is written once and every
-- policy that needs it reads identically.
--
-- Note the ordering: the person test comes first, so an authenticated request is
-- answered by identity and the service marker is only consulted when there is no
-- identity at all. A request cannot reach the service branch by presenting a
-- person id, because it does not need to.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_is_self_or_service(p_person_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT (p_person_id IS NOT NULL AND p_person_id = health.fn_current_person())
        OR health.fn_is_service_context();
$fn$;

COMMENT ON FUNCTION health.fn_is_self_or_service(UUID) IS
'TRUE when the argument is the calling person, or when the caller is backend background '
'work. NULL argument is not self. Added by migration 042.';

-- -----------------------------------------------------------------------------
-- Grants. Defensive over role names because the live database was built by hand
-- and its roles are not known from the repository; migration 011 names
-- app_service and health_service, 033 names hrms_app.
--
-- EXECUTE on a STABLE function that reads only a session setting leaks nothing:
-- the setting was put there by the caller's own connection.
-- -----------------------------------------------------------------------------
DO $grants$
DECLARE
    g TEXT;
BEGIN
    FOREACH g IN ARRAY ARRAY['hrms_app', 'app_service', 'health_service']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_is_service_context() TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_is_self_or_service(UUID) TO %I', g);
        END IF;
    END LOOP;
END
$grants$;

COMMIT;

-- =============================================================================
-- SELF-TEST
--
-- Runs after COMMIT so a failure is loud and the definitions above are still in
-- place to inspect. Every branch is exercised, including the two that matter
-- most: unset must be FALSE (an unauthenticated request is not the system), and
-- a cleared value must be FALSE (a pooled connection must not carry the marker
-- into the next borrower).
-- =============================================================================
DO $selftest$
DECLARE
    v_probe UUID := '00000000-0000-4000-8000-0000000042aa';
    v_other UUID := '00000000-0000-4000-8000-0000000042bb';
BEGIN
    -- 1. Unset: not the system.
    PERFORM set_config('app.service_context', '', TRUE);
    PERFORM set_config('app.person_id', '', TRUE);
    IF health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 1 FAILED: empty app.service_context read as service context';
    END IF;

    -- 2. The marker.
    PERFORM set_config('app.service_context', 'on', TRUE);
    IF NOT health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 2 FAILED: app.service_context = on not recognised';
    END IF;

    -- 3. Case and whitespace tolerated, since a human may set it while debugging.
    PERFORM set_config('app.service_context', '  ON  ', TRUE);
    IF NOT health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 3 FAILED: padded/uppercase ON not recognised';
    END IF;

    -- 4. Near-misses are FALSE. 'off' and 'false' especially: a deployment that
    --    sets the variable to a falsy string must not thereby enable it.
    PERFORM set_config('app.service_context', 'off', TRUE);
    IF health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 4a FAILED: off read as service context';
    END IF;
    PERFORM set_config('app.service_context', 'false', TRUE);
    IF health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 4b FAILED: false read as service context';
    END IF;
    PERFORM set_config('app.service_context', 'online', TRUE);
    IF health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 4c FAILED: online matched as a prefix of on';
    END IF;
    PERFORM set_config('app.service_context', '1', TRUE);
    IF health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 4d FAILED: 1 read as service context';
    END IF;

    -- 5. The reset path in db/pool.ts writes ''. It must clear the marker.
    PERFORM set_config('app.service_context', 'on', TRUE);
    PERFORM set_config('app.service_context', '', TRUE);
    IF health.fn_is_service_context() THEN
        RAISE EXCEPTION '042 self-test 5 FAILED: cleared marker still reads as service context';
    END IF;

    -- 6. The service context has no person identity. This is the property that
    --    keeps audit rows unattributed rather than misattributed.
    PERFORM set_config('app.service_context', 'on', TRUE);
    PERFORM set_config('app.person_id', '', TRUE);
    IF health.fn_current_person() IS NOT NULL THEN
        RAISE EXCEPTION '042 self-test 6 FAILED: service context has a person identity';
    END IF;

    -- 7. ...and no roles. A job must not satisfy a role test.
    PERFORM set_config('app.roles', ',,', TRUE);
    IF health.fn_has_role('payroll') OR health.fn_has_role('hr_admin') THEN
        RAISE EXCEPTION '042 self-test 7 FAILED: service context satisfied a role check';
    END IF;

    -- 8. fn_is_self_or_service: system reaches any person's rows.
    IF NOT health.fn_is_self_or_service(v_probe) THEN
        RAISE EXCEPTION '042 self-test 8 FAILED: service context denied by fn_is_self_or_service';
    END IF;

    -- 9. An authenticated person reaches their own rows and not another's, with
    --    the marker off. This is the ordinary request path.
    PERFORM set_config('app.service_context', '', TRUE);
    PERFORM set_config('app.person_id', v_probe::TEXT, TRUE);
    IF NOT health.fn_is_self_or_service(v_probe) THEN
        RAISE EXCEPTION '042 self-test 9a FAILED: person denied their own rows';
    END IF;
    IF health.fn_is_self_or_service(v_other) THEN
        RAISE EXCEPTION '042 self-test 9b FAILED: person reached another person''s rows';
    END IF;

    -- 10. No identity and no marker: nothing. The unauthenticated default.
    PERFORM set_config('app.person_id', '', TRUE);
    IF health.fn_is_self_or_service(v_probe) THEN
        RAISE EXCEPTION '042 self-test 10a FAILED: unauthenticated caller reached a person''s rows';
    END IF;
    IF health.fn_is_self_or_service(NULL) THEN
        RAISE EXCEPTION '042 self-test 10b FAILED: NULL person id treated as a match';
    END IF;

    -- 11. A NULL argument is never self, even for a real person. Guards the
    --     policy shape `fn_is_self_or_service(t.person_id)` on a nullable column.
    PERFORM set_config('app.person_id', v_probe::TEXT, TRUE);
    IF health.fn_is_self_or_service(NULL) THEN
        RAISE EXCEPTION '042 self-test 11 FAILED: NULL matched an authenticated person';
    END IF;

    -- Leave the session clean.
    PERFORM set_config('app.person_id', '', TRUE);
    PERFORM set_config('app.roles', '', TRUE);
    PERFORM set_config('app.service_context', '', TRUE);

    RAISE NOTICE '042 self-test passed: service context is distinguishable, positive, and grants nothing on its own';
END
$selftest$;

-- =============================================================================
-- OPERATOR NOTE
--
-- This migration is inert until a policy references fn_is_service_context().
-- Applying it changes no access. Verify with:
--
--   SELECT p.polname, c.relname
--     FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--    WHERE pg_get_expr(p.polqual, p.polrelid) LIKE '%fn_is_service_context%'
--       OR pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%fn_is_service_context%';
--
-- Zero rows immediately after 042; the tables 043 opens to the scheduler after.
-- That query is also the audit: it is the complete list of places where
-- background work can reach rows a person cannot.
-- =============================================================================

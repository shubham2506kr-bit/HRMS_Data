-- =============================================================================
-- 043_rls_predicates.sql
--
-- The predicate vocabulary that migrations 044-048 build policies from, plus one
-- ACL correction to migration 041.
--
-- This migration creates NO policies and enables RLS on NO table. Applying it
-- changes no access. It exists so that the forty-odd policies that follow are
-- each one line of intent rather than one copy of a five-table join, and so that
-- the definition of "privileged" lives in exactly one place per side of the
-- process boundary instead of being retyped per table.
--
-- WHY THE PREDICATES MIRROR backend/src/lib/access.ts EXACTLY
--
-- There are now two enforcement points for the same question: the route layer
-- (isPrivileged, canRunPayroll, personRelationship) and row-level security. They
-- have to agree. If RLS is stricter, a route authorises an action and then sees
-- zero rows — which surfaces as a 404 on a record the user can see elsewhere, or
-- worse, an UPDATE that reports success having matched nothing. If RLS is looser,
-- it is decoration.
--
-- So each function below is a transcription of a specific TypeScript constant,
-- named in its comment. When one changes, the other must change in the same
-- commit. That coupling is a cost; the alternative is two authorization models
-- that drift silently, which is what the audit found everywhere else.
--
-- Depends on: 040 (fn_current_person, fn_has_role), 041 (health.roles),
--             042 (fn_is_service_context).
-- Forward-only. Idempotent. Does not touch 001-030.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -----------------------------------------------------------------------------
-- fn_is_privileged() — transcription of PRIVILEGED_ROLES in lib/access.ts:40-50.
--
-- "May this role see and edit OTHER people's records?" It is not a general admin
-- test and must never be used to authorise an action on the caller's own record:
-- lib/access.ts:86 (canActOnBehalfOf) returns FALSE when actor = subject
-- regardless of role, because approving your own leave or your own payroll run is
-- a separation-of-duties failure, not an access-control question. Policies here
-- follow the same rule: where separation of duties applies, the policy names
-- fn_is_privileged() AND excludes self explicitly.
--
-- Every test goes through fn_has_role() rather than reading app.roles directly,
-- so the comma-wrapped exact-element match exists in exactly one place. That
-- match is load-bearing: a substring test made 'hr_restricted' satisfy 'hr'.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_is_privileged()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT EXISTS (
        SELECT 1
          FROM unnest(ARRAY[
                   'hr', 'hr_generalist', 'hr_manager', 'hr_admin',
                   'leadership', 'senior_admin', 'auditor', 'finance', 'payroll'
               ]) AS r(role_name)
         WHERE health.fn_has_role(r.role_name)
    );
$fn$;

COMMENT ON FUNCTION health.fn_is_privileged() IS
'TRUE when the caller holds a role that may see other people''s records. Transcribes '
'PRIVILEGED_ROLES in backend/src/lib/access.ts — change both together. Not an admin test '
'and not sufficient for an approval path: see canActOnBehalfOf. Added by migration 043.';

-- -----------------------------------------------------------------------------
-- fn_can_run_payroll() — transcription of PAYROLL_ROLES in lib/access.ts:61.
--
-- Deliberately NARROWER than fn_is_privileged(): hr, hr_generalist, hr_admin and
-- auditor are absent. Reading an employee record and moving money are different
-- capabilities, and an auditor in particular must be able to see a payroll run
-- without being able to approve one.
--
-- Until migration 041 no person could hold any of these five roles, so
-- canRunPayroll() could never return TRUE and every payroll route was
-- permanently closed. This predicate is only meaningful because 041 exists.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_can_run_payroll()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT EXISTS (
        SELECT 1
          FROM unnest(ARRAY['finance', 'payroll', 'hr_manager', 'leadership', 'senior_admin'])
               AS r(role_name)
         WHERE health.fn_has_role(r.role_name)
    );
$fn$;

COMMENT ON FUNCTION health.fn_can_run_payroll() IS
'TRUE when the caller may act on the payroll lifecycle. Transcribes PAYROLL_ROLES in '
'backend/src/lib/access.ts — change both together. Narrower than fn_is_privileged() on '
'purpose: reading a record and moving money are different capabilities. Migration 043.';

-- -----------------------------------------------------------------------------
-- fn_is_authenticated() — a person is present.
--
-- Distinct from "not the service context": background work is authenticated in
-- the sense that the backend put it there, but it has no person, and a policy
-- that means "any logged-in human" must not admit it by accident.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_is_authenticated()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT health.fn_current_person() IS NOT NULL;
$fn$;

COMMENT ON FUNCTION health.fn_is_authenticated() IS
'TRUE when a person identity is set for this statement. FALSE for background work, which '
'has no person. Added by migration 043.';

-- -----------------------------------------------------------------------------
-- fn_is_head_of_person(uuid) — transcription of personRelationship() in
-- lib/access.ts:10-37, the MANAGER branch.
--
-- Path, exactly as the TypeScript walks it:
--   subject's ACTIVE employment → its position → that position's department
--   → any current position in that department whose head_of_department_id is the
--     caller
-- health.departments has no head column; the head lives on positions, which is
-- why the join returns to positions a second time.
--
-- WHY SECURITY DEFINER — THIS IS THE IMPORTANT PART:
-- migration 044 puts RLS on health.employments and 046 puts it on
-- health.positions. A department head reading a report's record needs to read
-- that REPORT's employment row to establish the relationship. As SECURITY
-- INVOKER, that read would itself be filtered by the employments policy, which
-- calls this function, which reads employments — infinite recursion at worst and
-- a silent FALSE at best, meaning no manager could ever see a report.
-- SECURITY DEFINER breaks the cycle: the relationship lookup runs as the owner
-- and is not subject to the policies it is being used to evaluate.
--
-- That is a real privilege boundary, so note what the function can and cannot do:
-- it returns a BOOLEAN about the CALLER's own relationship to one person. It
-- never returns a row, a name, or a department. The only fact it discloses is
-- "you head the department of the person whose id you already had".
--
-- WHY PUBLIC EXECUTE IS LEFT IN PLACE (Postgres default) rather than revoked:
-- with no app.person_id set, fn_current_person() is NULL, the guard short-circuits
-- and the answer is FALSE. So a database user outside the application learns
-- nothing by calling it. Weighed against that: if EXECUTE were restricted to a
-- role list and the live database's application role is not on it — and the live
-- role set is not knowable from this repository — every policy referencing this
-- function would raise instead of denying, taking the whole application down.
-- A predicate whose failure mode is total outage does not get a narrow ACL on a
-- schema nobody has an accurate map of.
--
-- Self is excluded. A department head is a member of their own department, so
-- without the exclusion fn_is_head_of_person(self) is TRUE and "I am my own
-- manager" leaks into any approval path built on this predicate. Self-access is a
-- separate clause everywhere it is wanted.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_is_head_of_person(p_person_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT p_person_id IS NOT NULL
       AND health.fn_current_person() IS NOT NULL
       AND p_person_id <> health.fn_current_person()
       AND EXISTS (
           SELECT 1
             FROM health.employments e
             JOIN health.positions subject_pos
               ON subject_pos.logical_id = e.position_id
              AND subject_pos.system_period @> NOW()
             JOIN health.departments d
               ON d.logical_id = subject_pos.department_id
              AND d.system_period @> NOW()
             JOIN health.positions head_pos
               ON head_pos.department_id = d.logical_id
              AND head_pos.head_of_department_id = health.fn_current_person()
              AND head_pos.system_period @> NOW()
            WHERE e.person_id = p_person_id
              AND e.status = 'ACTIVE'
              AND e.system_period @> NOW()
       );
$fn$;

COMMENT ON FUNCTION health.fn_is_head_of_person(UUID) IS
'TRUE when the caller heads the department of the argument person''s active employment. '
'FALSE for self, for NULL, and when no identity is set. Transcribes the MANAGER branch of '
'personRelationship() in backend/src/lib/access.ts. SECURITY DEFINER to avoid recursion '
'through the employments and positions policies it is used to evaluate. Migration 043.';

-- -----------------------------------------------------------------------------
-- fn_can_read_person(uuid) — the standard read test for a person-owned row.
--
-- self OR privileged role OR department head. This is the shape almost every
-- policy in 044 uses, so it is written once. Note it is a READ test only: writes
-- are narrower everywhere and are spelled out per table, because "may see" and
-- "may change" are not the same permission and collapsing them is how a manager
-- ends up able to edit a report's salary.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_can_read_person(p_person_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT (p_person_id IS NOT NULL AND p_person_id = health.fn_current_person())
        OR (health.fn_is_authenticated() AND health.fn_is_privileged())
        OR health.fn_is_head_of_person(p_person_id);
$fn$;

COMMENT ON FUNCTION health.fn_can_read_person(UUID) IS
'Standard read test for a person-owned row: self, or a privileged role, or the head of '
'that person''s department. READ only — write tests are narrower and are written per '
'table. Added by migration 043.';

-- -----------------------------------------------------------------------------
-- fn_can_read_person_or_service(uuid) — the same, plus background work.
--
-- Separate function rather than a flag, so that `grep fn_can_read_person_or_service`
-- lists every table the scheduler can reach. That list is the audit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION health.fn_can_read_person_or_service(p_person_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
    SELECT health.fn_can_read_person(p_person_id) OR health.fn_is_service_context();
$fn$;

COMMENT ON FUNCTION health.fn_can_read_person_or_service(UUID) IS
'fn_can_read_person(), plus backend background work. Grep for this name to enumerate every '
'table a scheduled job can reach. Added by migration 043.';

-- -----------------------------------------------------------------------------
-- Grants. Same defensive loop as 041 and 042: the live role set is not knowable
-- from this repository, so each name is checked before it is used.
-- -----------------------------------------------------------------------------
DO $grants$
DECLARE
    g TEXT;
    fn TEXT;
BEGIN
    FOREACH g IN ARRAY ARRAY['hrms_app', 'app_service', 'health_service']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) THEN
            FOREACH fn IN ARRAY ARRAY[
                'health.fn_is_privileged()',
                'health.fn_can_run_payroll()',
                'health.fn_is_authenticated()',
                'health.fn_is_head_of_person(UUID)',
                'health.fn_can_read_person(UUID)',
                'health.fn_can_read_person_or_service(UUID)'
            ]
            LOOP
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, g);
            END LOOP;
        END IF;
    END LOOP;
END
$grants$;

-- -----------------------------------------------------------------------------
-- ACL CORRECTION TO MIGRATION 041.
--
-- health.fn_granted_roles(uuid) is SECURITY DEFINER and 041 left it with the
-- default PUBLIC EXECUTE. Unlike fn_is_head_of_person above, it answers a
-- question about SOMEONE ELSE and returns data, not a boolean: pass any person's
-- logical_id and it returns that person's live role grants, bypassing the
-- person_roles policy that was written specifically to stop that. Any database
-- user — a reporting login, an analytics role, a leftover account from the
-- hand-built schema — could enumerate who holds senior_admin.
--
-- The revoke is conditional on an explicit grant already existing for at least
-- one application role. If none does, PUBLIC is the only thing making
-- deriveRoles() work in that database, and removing it would break every login.
-- Failing to tighten an ACL is recoverable; locking the application out of its
-- own role lookup is an outage. When the branch is skipped it says so loudly.
-- -----------------------------------------------------------------------------
DO $tighten$
DECLARE
    v_oid OID;
    v_named_grants INT;
BEGIN
    SELECT to_regprocedure('health.fn_granted_roles(uuid)') INTO v_oid;
    IF v_oid IS NULL THEN
        RAISE NOTICE '043: health.fn_granted_roles(uuid) absent; skipping ACL correction (apply 041 first)';
        RETURN;
    END IF;

    -- aclexplode is set-returning, so it belongs in FROM, not WHERE. PUBLIC is
    -- grantee = 0 and has no pg_roles row, so restricting to named roles excludes
    -- it by construction — which is precisely the distinction being measured.
    SELECT count(*) INTO v_named_grants
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, '{}'::aclitem[])) AS a
     WHERE p.oid = v_oid
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee IN (
               SELECT r.oid FROM pg_roles r
                WHERE r.rolname IN ('hrms_app', 'app_service', 'health_service')
           );

    IF v_named_grants = 0 THEN
        RAISE WARNING '043: fn_granted_roles(uuid) has no explicit application-role grant; '
                      'leaving PUBLIC EXECUTE in place rather than risking a login outage. '
                      'Grant EXECUTE to the real application role, then re-run this migration.';
        RETURN;
    END IF;

    EXECUTE 'REVOKE ALL ON FUNCTION health.fn_granted_roles(uuid) FROM PUBLIC';
    RAISE NOTICE '043: revoked PUBLIC EXECUTE on fn_granted_roles(uuid); % application role grant(s) remain', v_named_grants;
END
$tighten$;

COMMIT;

-- =============================================================================
-- SELF-TEST
--
-- Uses real rows, because the manager branch is a five-way join and a test with
-- synthetic ids would prove only that it returns FALSE. Everything created is
-- removed at the end, inside a block that rolls back on any failure.
-- =============================================================================
DO $selftest$
DECLARE
    v_head    UUID;
    v_report  UUID;
    v_other   UUID;
    v_dept    UUID := gen_random_uuid();
    v_pos_h   UUID := gen_random_uuid();
    v_pos_r   UUID := gen_random_uuid();
    v_emp     UUID := gen_random_uuid();
    v_now     TIMESTAMPTZ := NOW();
BEGIN
    -- --- role predicates: no fixtures needed -------------------------------
    PERFORM set_config('app.person_id', '', TRUE);
    PERFORM set_config('app.roles', '', TRUE);
    PERFORM set_config('app.service_context', '', TRUE);

    IF health.fn_is_privileged() THEN
        RAISE EXCEPTION '043 self-test 1 FAILED: unauthenticated caller is privileged';
    END IF;
    IF health.fn_can_run_payroll() THEN
        RAISE EXCEPTION '043 self-test 2 FAILED: unauthenticated caller may run payroll';
    END IF;
    IF health.fn_is_authenticated() THEN
        RAISE EXCEPTION '043 self-test 3 FAILED: no identity read as authenticated';
    END IF;

    -- An ordinary employee is neither privileged nor a payroll operator.
    PERFORM set_config('app.roles', ',self,employee,', TRUE);
    IF health.fn_is_privileged() OR health.fn_can_run_payroll() THEN
        RAISE EXCEPTION '043 self-test 4 FAILED: plain employee passed a privilege test';
    END IF;

    -- hr_generalist is privileged but must NOT be able to run payroll. This is
    -- the distinction the two predicates exist to keep.
    PERFORM set_config('app.roles', ',self,employee,hr_generalist,', TRUE);
    IF NOT health.fn_is_privileged() THEN
        RAISE EXCEPTION '043 self-test 5a FAILED: hr_generalist not privileged';
    END IF;
    IF health.fn_can_run_payroll() THEN
        RAISE EXCEPTION '043 self-test 5b FAILED: hr_generalist may run payroll';
    END IF;

    -- auditor: reads records, does not move money.
    PERFORM set_config('app.roles', ',self,auditor,', TRUE);
    IF NOT health.fn_is_privileged() OR health.fn_can_run_payroll() THEN
        RAISE EXCEPTION '043 self-test 6 FAILED: auditor privilege split wrong';
    END IF;

    -- payroll: both.
    PERFORM set_config('app.roles', ',self,employee,payroll,', TRUE);
    IF NOT health.fn_is_privileged() OR NOT health.fn_can_run_payroll() THEN
        RAISE EXCEPTION '043 self-test 7 FAILED: payroll role denied';
    END IF;

    -- The prefix hole stays shut through the new predicates too. ',hr_restricted,'
    -- must not satisfy 'hr'; that exact bug granted hr_generalist to the role
    -- that exists to withhold it.
    PERFORM set_config('app.roles', ',self,employee,hr_restricted,', TRUE);
    IF health.fn_is_privileged() THEN
        RAISE EXCEPTION '043 self-test 8 FAILED: hr_restricted satisfied a privileged-role test';
    END IF;
    PERFORM set_config('app.roles', ',self,payroll_viewer,', TRUE);
    IF health.fn_is_privileged() OR health.fn_can_run_payroll() THEN
        RAISE EXCEPTION '043 self-test 9 FAILED: payroll_viewer matched payroll';
    END IF;

    -- Background work holds no roles.
    PERFORM set_config('app.roles', ',,', TRUE);
    PERFORM set_config('app.service_context', 'on', TRUE);
    IF health.fn_is_privileged() OR health.fn_can_run_payroll() OR health.fn_is_authenticated() THEN
        RAISE EXCEPTION '043 self-test 10 FAILED: service context satisfied a person-level test';
    END IF;
    PERFORM set_config('app.service_context', '', TRUE);

    -- --- manager branch: needs real org rows -------------------------------
    -- health.persons is NOT bitemporal despite the logical_id column: it has no
    -- valid_period and no system_period. employments, positions and departments
    -- do. Do not add a system_period predicate here; it does not exist.
    SELECT logical_id INTO v_head
      FROM health.persons ORDER BY logical_id LIMIT 1;
    SELECT logical_id INTO v_report
      FROM health.persons WHERE logical_id <> v_head ORDER BY logical_id LIMIT 1;
    SELECT logical_id INTO v_other
      FROM health.persons WHERE logical_id NOT IN (v_head, v_report)
     ORDER BY logical_id LIMIT 1;

    IF v_head IS NULL OR v_report IS NULL THEN
        RAISE WARNING '043 self-test: fewer than two persons present; manager-branch tests skipped';
        PERFORM set_config('app.roles', '', TRUE);
        RETURN;
    END IF;

    INSERT INTO health.departments (logical_id, valid_period, system_period, name, jurisdiction)
    VALUES (v_dept, tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
                    tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
            '043 self-test dept', 'IN');

    -- The head's position: it is the one carrying head_of_department_id.
    INSERT INTO health.positions (logical_id, valid_period, system_period, name,
                                  department_id, head_of_department_id)
    VALUES (v_pos_h, tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
                     tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
            '043 self-test head position', v_dept, v_head);

    -- The report's position: same department, no head marker.
    INSERT INTO health.positions (logical_id, valid_period, system_period, name,
                                  department_id, head_of_department_id)
    VALUES (v_pos_r, tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
                     tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
            '043 self-test report position', v_dept, NULL);

    INSERT INTO health.employments (logical_id, valid_period, system_period,
                                    person_id, position_id, status, started_at)
    VALUES (v_emp, tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
                   tstzrange(v_now - INTERVAL '1 day', NULL, '[)'),
            v_report, v_pos_r, 'ACTIVE', (v_now - INTERVAL '1 day')::DATE);

    PERFORM set_config('app.roles', ',self,employee,department_head_of,', TRUE);
    PERFORM set_config('app.person_id', v_head::TEXT, TRUE);

    IF NOT health.fn_is_head_of_person(v_report) THEN
        RAISE EXCEPTION '043 self-test 11 FAILED: department head not recognised for a report';
    END IF;
    IF health.fn_is_head_of_person(v_head) THEN
        RAISE EXCEPTION '043 self-test 12 FAILED: head is their own manager (self not excluded)';
    END IF;
    IF health.fn_is_head_of_person(NULL) THEN
        RAISE EXCEPTION '043 self-test 13 FAILED: NULL person id matched the manager branch';
    END IF;
    IF v_other IS NOT NULL AND health.fn_is_head_of_person(v_other) THEN
        RAISE EXCEPTION '043 self-test 14 FAILED: head reached a person outside their department';
    END IF;

    -- The report is not the head's manager. Asymmetry matters: the join must not
    -- be satisfiable in both directions.
    PERFORM set_config('app.person_id', v_report::TEXT, TRUE);
    IF health.fn_is_head_of_person(v_head) THEN
        RAISE EXCEPTION '043 self-test 15 FAILED: manager relationship is symmetric';
    END IF;

    -- A TERMINATED employment must not keep the relationship alive. This is the
    -- branch that decides whether a manager still sees a leaver's records.
    --
    -- NOTE, and it is not a defect in this migration: health.employments.status
    -- allows ACTIVE, INACTIVE, TERMINATED, ON_LEAVE and SUSPENDED, and both
    -- personRelationship() and deriveRoles() test for ACTIVE only. So an employee
    -- who is ON_LEAVE or SUSPENDED is not an "employee" for role-derivation
    -- purposes and is invisible to their own department head. That is the existing
    -- behaviour of backend/src/lib/access.ts, and this predicate transcribes it
    -- faithfully on purpose — diverging here would put RLS and the route layer out
    -- of agreement, which is the failure this migration's header warns about. It
    -- is written up as a finding, not fixed silently.
    UPDATE health.employments SET status = 'TERMINATED' WHERE logical_id = v_emp;
    PERFORM set_config('app.person_id', v_head::TEXT, TRUE);
    IF health.fn_is_head_of_person(v_report) THEN
        RAISE EXCEPTION '043 self-test 16 FAILED: manager relationship survived a TERMINATED employment';
    END IF;

    -- ON_LEAVE behaves the same way, for the reason above. Asserted so that if
    -- anyone later widens access.ts to include it, this test fails and forces the
    -- two sides to be changed together.
    UPDATE health.employments SET status = 'ON_LEAVE' WHERE logical_id = v_emp;
    IF health.fn_is_head_of_person(v_report) THEN
        RAISE EXCEPTION '043 self-test 16b FAILED: ON_LEAVE now visible to the head; access.ts must be changed in the same commit';
    END IF;

    UPDATE health.employments SET status = 'ACTIVE' WHERE logical_id = v_emp;

    -- --- fn_can_read_person composition ------------------------------------
    PERFORM set_config('app.roles', ',self,employee,', TRUE);
    PERFORM set_config('app.person_id', v_report::TEXT, TRUE);
    IF NOT health.fn_can_read_person(v_report) THEN
        RAISE EXCEPTION '043 self-test 17 FAILED: person cannot read their own row';
    END IF;
    IF health.fn_can_read_person(v_head) THEN
        RAISE EXCEPTION '043 self-test 18 FAILED: plain employee can read another person''s row';
    END IF;

    PERFORM set_config('app.person_id', v_head::TEXT, TRUE);
    PERFORM set_config('app.roles', ',self,employee,department_head_of,', TRUE);
    IF NOT health.fn_can_read_person(v_report) THEN
        RAISE EXCEPTION '043 self-test 19 FAILED: head cannot read a report';
    END IF;

    PERFORM set_config('app.roles', ',self,employee,hr_generalist,', TRUE);
    IF NOT health.fn_can_read_person(v_report) THEN
        RAISE EXCEPTION '043 self-test 20 FAILED: privileged role cannot read a person';
    END IF;

    -- Service context: denied by fn_can_read_person, admitted by the _or_service
    -- variant. The pair is the whole point of keeping them separate.
    PERFORM set_config('app.person_id', '', TRUE);
    PERFORM set_config('app.roles', ',,', TRUE);
    PERFORM set_config('app.service_context', 'on', TRUE);
    IF health.fn_can_read_person(v_report) THEN
        RAISE EXCEPTION '043 self-test 21 FAILED: fn_can_read_person admitted the service context';
    END IF;
    IF NOT health.fn_can_read_person_or_service(v_report) THEN
        RAISE EXCEPTION '043 self-test 22 FAILED: fn_can_read_person_or_service denied the service context';
    END IF;

    -- And an unauthenticated caller is admitted by neither.
    PERFORM set_config('app.service_context', '', TRUE);
    IF health.fn_can_read_person(v_report) OR health.fn_can_read_person_or_service(v_report) THEN
        RAISE EXCEPTION '043 self-test 23 FAILED: unauthenticated caller admitted';
    END IF;

    -- --- cleanup ------------------------------------------------------------
    DELETE FROM health.employments WHERE logical_id = v_emp;
    DELETE FROM health.positions   WHERE logical_id IN (v_pos_h, v_pos_r);
    DELETE FROM health.departments WHERE logical_id = v_dept;

    PERFORM set_config('app.person_id', '', TRUE);
    PERFORM set_config('app.roles', '', TRUE);
    PERFORM set_config('app.service_context', '', TRUE);

    RAISE NOTICE '043 self-test passed: 23 checks, including the manager branch against real org rows';
EXCEPTION
    WHEN OTHERS THEN
        -- Never leave fixtures behind. Re-raise so the failure is not swallowed.
        DELETE FROM health.employments WHERE logical_id = v_emp;
        DELETE FROM health.positions   WHERE logical_id IN (v_pos_h, v_pos_r);
        DELETE FROM health.departments WHERE logical_id = v_dept;
        PERFORM set_config('app.person_id', '', TRUE);
        PERFORM set_config('app.roles', '', TRUE);
        PERFORM set_config('app.service_context', '', TRUE);
        RAISE;
END
$selftest$;

-- =============================================================================
-- OPERATOR NOTE
--
-- Applying this migration changes no access: it creates predicates and enables
-- RLS on nothing. Confirm with
--
--   SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='health' AND c.relrowsecurity;
--
-- before and after — the number must be identical.
--
-- The one change with an effect is the REVOKE on fn_granted_roles(uuid). If it
-- emitted a WARNING rather than a NOTICE, it did nothing, and the reason is that
-- the database has no explicit EXECUTE grant on that function for hrms_app,
-- app_service or health_service. Find the real application role, grant it, and
-- re-run:
--
--   GRANT EXECUTE ON FUNCTION health.fn_granted_roles(uuid) TO <the_app_role>;
--
-- =============================================================================

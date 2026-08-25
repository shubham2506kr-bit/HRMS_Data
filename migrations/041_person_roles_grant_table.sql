-- Migration 041: the missing role-grant spine
-- Forward-only. Idempotent and safe to re-run. Strictly ADDITIVE: it creates two
-- tables and one function and changes no existing policy, so it cannot restrict
-- access that works today.
--
-- ============================================================
-- WHY THIS EXISTS
-- ============================================================
-- backend/src/lib/auth.ts deriveRoles() is the only thing in this system that
-- decides what roles a person has. It can emit exactly six names:
--
--     self                 always
--     employee             an ACTIVE employment exists
--     department_head_of   heads at least one department
--     direct_manager_of    is the parent of a reporting line
--     hr_generalist        user_accounts.idp_issuer is 'hr' or 'hr_generalist'
--     hr_restricted        user_accounts.idp_issuer is 'hr_restricted'
--
-- Nothing else is reachable, because there is no role table anywhere in the
-- schema. That was verified against the database, not inferred: no relation
-- matching (role|grant|permission|capabilit|entitle) exists in any non-catalog
-- schema, and health.user_accounts has no roles column. The comment on
-- ISSUER_ROLE_GRANTS in auth.ts says so too, and says what to do about it:
-- "This mapping is a stopgap ... When one exists, read it here and delete this
-- map."
--
-- The consequences were not cosmetic:
--
--   * backend/src/lib/access.ts PRIVILEGED_ROLES lists nine names. Only
--     hr_generalist can ever be held, so isPrivileged() collapsed to a single
--     role and hr_admin, senior_admin, auditor, finance, payroll, hr_manager
--     and leadership were decorative.
--
--   * canRunPayroll() requires finance, payroll, hr_manager, leadership or
--     senior_admin. NONE of those is grantable, so every one of its six call
--     sites in backend/src/modules/payroll/routes.ts was permanently closed:
--     no person could create, approve or pay a payroll run. That is a frozen
--     payroll module, not a hardened one.
--
--   * health.fn_is_clinical_role() requires care_clinician or
--     occupational_health. Neither is grantable, so after migration 040 fixed
--     the identity bridge, every clinical branch of every consent policy was
--     still dead, and health.retention_runs — whose only policy is
--     fn_is_clinical_role() — could not be written to by anyone.
--
--   * The RLS policies written by migrations 033 and 036 test for hr_admin,
--     senior_admin and auditor. All three are unreachable, so those branches
--     could never grant anything.
--
-- This migration must therefore land BEFORE row-level security is extended to
-- the remaining tables (migration 042). Adding a policy that requires a
-- privileged role while no privileged role can be held would not secure the
-- table, it would make the feature unusable — the same class of mistake as the
-- broken identity bridge, arrived at from the other direction.
--
-- ============================================================
-- WHAT THIS DOES NOT DO
-- ============================================================
-- It creates the storage and the read path. It deliberately does NOT:
--
--   * grant anybody anything. The tables ship empty. Nothing changes for any
--     existing user until an operator makes an explicit, recorded grant.
--   * expose a grant API. Handing out hr_admin is a privileged action that needs
--     its own authorisation, audit entry and separation-of-duties check in the
--     application layer. That is app work, not schema work.
--   * make derived roles grantable. See is_grantable below.

-- ============================================================
-- The role catalogue
-- ============================================================
-- A free-text role column would fail silently: granting 'hr_adminn' would store
-- happily and authorise nothing, and the operator would have no way to tell a
-- typo from a policy that does not cover them. Constraining role_name to this
-- catalogue turns that into an immediate foreign-key error.
CREATE TABLE IF NOT EXISTS health.roles (
    role_name    TEXT PRIMARY KEY,
    description  TEXT NOT NULL,
    -- FALSE for roles derived from live data. self, employee,
    -- department_head_of and direct_manager_of are facts about employment and
    -- org structure, computed per request by deriveRoles(). If they were
    -- grantable, a grant of 'employee' would assert an employment that does not
    -- exist and bypass every check that reads health.employments. They are
    -- listed here only so the catalogue documents the whole vocabulary.
    is_grantable BOOLEAN NOT NULL DEFAULT TRUE,
    -- TRUE for roles that let the holder act on other people's records. Used by
    -- reporting and review, and to make "who is privileged" answerable in SQL
    -- rather than only in TypeScript.
    is_privileged BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE health.roles IS
    'Closed vocabulary of role names. Mirrors backend/src/lib/access.ts PRIVILEGED_ROLES and PAYROLL_ROLES plus the clinical roles health.fn_is_clinical_role() tests for. Added in migration 041; before it there was no role table at all and most of these names could never be held by anyone.';

COMMENT ON COLUMN health.roles.is_grantable IS
    'FALSE for roles derived per request from live data (self, employee, department_head_of, direct_manager_of). Granting those would assert facts about employment that the database contradicts.';

-- The vocabulary. Kept in step with backend/src/lib/access.ts by hand; there is
-- no generator. If you add a role in one place, add it in the other.
INSERT INTO health.roles (role_name, description, is_grantable, is_privileged) VALUES
    -- Derived per request. Never grantable.
    ('self',               'Every authenticated person, acting on their own record. Derived.',            FALSE, FALSE),
    ('employee',           'Holds an ACTIVE employment. Derived from health.employments.',                FALSE, FALSE),
    ('department_head_of', 'Heads at least one department. Derived from health.positions.',               FALSE, FALSE),
    ('direct_manager_of',  'Parent of at least one reporting line. Derived from position_reporting_lines.', FALSE, FALSE),
    -- HR. hr_restricted is a deliberate downgrade and must never be privileged.
    ('hr_generalist',      'General HR access to other employees'' records.',                             TRUE,  TRUE),
    ('hr_restricted',      'Deliberately restricted HR role. Mutually exclusive with hr_generalist.',      TRUE,  FALSE),
    ('hr',                 'Legacy HR role name tested by PRIVILEGED_ROLES.',                              TRUE,  TRUE),
    ('hr_manager',         'HR management, including payroll lifecycle rights.',                           TRUE,  TRUE),
    ('hr_admin',           'HR administration. Tested by the audit_log and auth_sessions policies.',       TRUE,  TRUE),
    -- Leadership and oversight.
    ('leadership',         'Organisational leadership.',                                                  TRUE,  TRUE),
    ('senior_admin',       'Senior administration. Tested by the audit_log and auth_sessions policies.',   TRUE,  TRUE),
    ('auditor',            'Read access to the audit trail for investigations.',                           TRUE,  TRUE),
    -- Money. Separate from HR: canRunPayroll() is not isPrivileged().
    ('finance',            'Finance. Payroll lifecycle rights.',                                           TRUE,  TRUE),
    ('payroll',            'Payroll operation. Payroll lifecycle rights.',                                 TRUE,  TRUE),
    -- Clinical. Special-category health data under the DPDP Act; these two are
    -- the only roles health.fn_is_clinical_role() accepts.
    ('care_clinician',     'Clinician with access to special-category health data via the consent gate.',   TRUE,  TRUE),
    ('occupational_health','Occupational health practitioner. Same access class as care_clinician.',        TRUE,  TRUE)
ON CONFLICT (role_name) DO NOTHING;

-- ============================================================
-- The grants
-- ============================================================
CREATE TABLE IF NOT EXISTS health.person_roles (
    grant_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id    UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    role_name    TEXT NOT NULL REFERENCES health.roles(role_name),

    -- Who authorised this, and why. NULL granted_by is reserved for the initial
    -- bootstrap grant made directly in SQL by an operator, because at that point
    -- there is by definition nobody privileged enough to make it. Every grant
    -- issued through the application must name a granter.
    granted_by   UUID REFERENCES health.persons(logical_id),
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason       TEXT,

    -- A role that cannot expire is a role nobody revokes. valid_until NULL means
    -- open-ended, which is allowed but should be the exception.
    valid_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until  TIMESTAMPTZ,

    -- Revocation is recorded, never deleted: the audit question is not "who has
    -- this role" but "who had it in March".
    revoked_at   TIMESTAMPTZ,
    revoked_by   UUID REFERENCES health.persons(logical_id),

    CONSTRAINT person_roles_period_sane
        CHECK (valid_until IS NULL OR valid_until > valid_from),
    -- Separation of duties, enforced by the database rather than trusted to a
    -- route. Nobody grants themselves a role.
    CONSTRAINT person_roles_no_self_grant
        CHECK (granted_by IS DISTINCT FROM person_id),
    CONSTRAINT person_roles_revocation_complete
        CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) OR revoked_by IS NOT NULL)
);

COMMENT ON TABLE health.person_roles IS
    'Explicit, audited role grants. Read by deriveRoles() in backend/src/lib/auth.ts on every request (behind the short cache in authz/middleware.ts), so a revocation takes effect within ROLE_CACHE_TTL_MS. Added in migration 041.';

COMMENT ON CONSTRAINT person_roles_no_self_grant ON health.person_roles IS
    'Separation of duties: a person may not grant themselves a role. granted_by IS NULL is permitted only for the operator-issued bootstrap grant.';

-- One live grant per person per role. Partial, so revoked and expired history
-- accumulates freely while a duplicate live grant is impossible.
CREATE UNIQUE INDEX IF NOT EXISTS person_roles_one_live_grant
    ON health.person_roles (person_id, role_name)
    WHERE revoked_at IS NULL;

-- The lookup deriveRoles() performs on every uncached request.
CREATE INDEX IF NOT EXISTS person_roles_live_by_person
    ON health.person_roles (person_id)
    WHERE revoked_at IS NULL;

-- ============================================================
-- Only grantable roles may be granted
-- ============================================================
-- Expressed as a trigger because a CHECK constraint cannot read another table.
CREATE OR REPLACE FUNCTION health.fn_person_roles_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, health, pg_temp
AS $$
DECLARE
    v_grantable BOOLEAN;
BEGIN
    SELECT r.is_grantable INTO v_grantable
      FROM health.roles r WHERE r.role_name = NEW.role_name;

    IF v_grantable IS NULL THEN
        RAISE EXCEPTION 'role % is not in health.roles', NEW.role_name
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NOT v_grantable THEN
        RAISE EXCEPTION
            'role % is derived from live data and cannot be granted. Granting it would assert an employment or org-structure fact the database contradicts.',
            NEW.role_name
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS person_roles_guard ON health.person_roles;
CREATE TRIGGER person_roles_guard
    BEFORE INSERT OR UPDATE OF role_name ON health.person_roles
    FOR EACH ROW EXECUTE FUNCTION health.fn_person_roles_guard();

-- ============================================================
-- Read path
-- ============================================================
-- SECURITY DEFINER, deliberately. This function is called BY the RLS policies
-- that migration 042 puts on other tables, and it reads health.person_roles.
-- If it ran as the invoker it would be subject to person_roles' own policy,
-- which would either recurse or deny. It returns nothing but role names for one
-- person and takes no free-text input, so definer rights leak nothing.
CREATE OR REPLACE FUNCTION health.fn_granted_roles(p_person_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT COALESCE(ARRAY_AGG(DISTINCT pr.role_name), '{}'::TEXT[])
      FROM health.person_roles pr
     WHERE p_person_id IS NOT NULL
       AND pr.person_id  = p_person_id
       AND pr.revoked_at IS NULL
       AND pr.valid_from <= NOW()
       AND (pr.valid_until IS NULL OR pr.valid_until > NOW());
$$;

COMMENT ON FUNCTION health.fn_granted_roles(UUID) IS
    'Live, unrevoked, in-period role names granted to a person. SECURITY DEFINER so RLS policies on other tables can call it without recursing through health.person_roles'' own policy. Read by deriveRoles() in backend/src/lib/auth.ts.';

-- ============================================================
-- person_roles protects itself
-- ============================================================
-- A person may see the roles they hold. Nobody reaches anyone else's grants
-- without a privileged role, and NO ONE writes grants through the application
-- role until an app path exists to do it safely: there is no INSERT, UPDATE or
-- DELETE policy, so all writes are denied to hrms_app and a grant must be made
-- by the table owner. That is the intended posture for the bootstrap.
ALTER TABLE health.person_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE health.person_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS person_roles_select_self_or_privileged ON health.person_roles;
CREATE POLICY person_roles_select_self_or_privileged
    ON health.person_roles
    FOR SELECT
    USING (
        person_id = health.fn_current_person()
        OR health.fn_has_role('hr_admin')
        OR health.fn_has_role('senior_admin')
        OR health.fn_has_role('auditor')
    );

-- The catalogue is not secret and is needed to render any role UI.
ALTER TABLE health.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE health.roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roles_select_all ON health.roles;
CREATE POLICY roles_select_all ON health.roles FOR SELECT USING (TRUE);

-- ============================================================
-- Grants to the application role
-- ============================================================
-- SELECT only. The application reads roles; it does not yet issue them.
DO $$
DECLARE
    g TEXT;
BEGIN
    FOREACH g IN ARRAY ARRAY['hrms_app', 'app_service', 'health_service']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) THEN
            EXECUTE format('GRANT USAGE ON SCHEMA health TO %I', g);
            EXECUTE format('GRANT SELECT ON health.roles TO %I', g);
            EXECUTE format('GRANT SELECT ON health.person_roles TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_granted_roles(UUID) TO %I', g);
        END IF;
    END LOOP;
END $$;

-- ============================================================
-- SELF-TEST
-- ============================================================
DO $$
DECLARE
    v_subject UUID;
    v_granter UUID;
    v_roles   TEXT[];
    v_ok      BOOLEAN;
BEGIN
    -- Two distinct real persons, or skip: the FKs require them and an empty
    -- persons table is a legitimate state for a fresh database.
    SELECT logical_id INTO v_subject FROM health.persons ORDER BY logical_id LIMIT 1;
    SELECT logical_id INTO v_granter FROM health.persons
     WHERE logical_id IS DISTINCT FROM v_subject ORDER BY logical_id LIMIT 1;

    IF v_subject IS NULL OR v_granter IS NULL THEN
        RAISE NOTICE 'Migration 041: fewer than two persons on file, skipping the grant self-test. Structure created.';
        RETURN;
    END IF;

    -- A derived role must be refused.
    v_ok := FALSE;
    BEGIN
        INSERT INTO health.person_roles (person_id, role_name, granted_by)
        VALUES (v_subject, 'employee', v_granter);
    EXCEPTION WHEN check_violation THEN
        v_ok := TRUE;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'health.person_roles accepted a grant of the derived role ''employee''; the is_grantable guard is not working.';
    END IF;

    -- An unknown role must be refused.
    v_ok := FALSE;
    BEGIN
        INSERT INTO health.person_roles (person_id, role_name, granted_by)
        VALUES (v_subject, 'hr_adminn', v_granter);
    EXCEPTION WHEN foreign_key_violation THEN
        v_ok := TRUE;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'health.person_roles accepted the misspelled role ''hr_adminn''; the catalogue foreign key is not working.';
    END IF;

    -- A self-grant must be refused.
    v_ok := FALSE;
    BEGIN
        INSERT INTO health.person_roles (person_id, role_name, granted_by)
        VALUES (v_subject, 'hr_admin', v_subject);
    EXCEPTION WHEN check_violation THEN
        v_ok := TRUE;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'health.person_roles accepted a self-grant; separation of duties is not enforced.';
    END IF;

    -- A real grant must be readable, and revocation must take it away.
    INSERT INTO health.person_roles (person_id, role_name, granted_by, reason)
    VALUES (v_subject, 'payroll', v_granter, 'migration 041 self-test');

    v_roles := health.fn_granted_roles(v_subject);
    IF NOT ('payroll' = ANY(v_roles)) THEN
        RAISE EXCEPTION 'fn_granted_roles() did not return a live grant. Got: %', v_roles;
    END IF;

    -- An expired grant must not be returned. Both bounds move into the past:
    -- person_roles_period_sane requires valid_until > valid_from, so backdating
    -- only the end of the period is correctly refused.
    UPDATE health.person_roles
       SET valid_from  = NOW() - INTERVAL '2 hours',
           valid_until = NOW() - INTERVAL '1 hour'
     WHERE person_id = v_subject AND role_name = 'payroll' AND revoked_at IS NULL;
    IF 'payroll' = ANY(health.fn_granted_roles(v_subject)) THEN
        RAISE EXCEPTION 'fn_granted_roles() returned an expired grant.';
    END IF;

    -- Clean up: this is a self-test, not a grant.
    DELETE FROM health.person_roles
     WHERE person_id = v_subject AND reason = 'migration 041 self-test';

    IF EXISTS (SELECT 1 FROM health.person_roles) THEN
        RAISE NOTICE 'Migration 041: note — health.person_roles is not empty. That is expected only if grants were made deliberately.';
    END IF;

    RAISE NOTICE 'Migration 041: role-grant spine created and verified (catalogue FK, derived-role guard, self-grant guard, expiry). No roles granted.';
END $$;

-- ============================================================
-- OPERATOR NOTE — the bootstrap grant
-- ============================================================
-- Nobody holds a privileged role yet, so payroll is still frozen and no
-- clinician exists. Issue the first grants as the table owner, naming a real
-- reason. granted_by is NULL only because there is nobody privileged to name:
--
--   INSERT INTO health.person_roles (person_id, role_name, granted_by, reason)
--   VALUES ('<person uuid>', 'senior_admin', NULL, 'initial bootstrap, ticket XYZ-1');
--
-- After that, every further grant must name a granter and go through an
-- application path that authorises and audits it.
--
-- ============================================================
-- END OF MIGRATION 041
-- ============================================================

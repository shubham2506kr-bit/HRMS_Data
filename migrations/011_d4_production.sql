-- Migration 011: D4 Production Preparation (Section 8)
-- Applied: After 010
-- Description: D4 Production Preparation - app_service and health_service as real login roles

-- ============================================================
-- D4: Production Preparation - Login Roles (Section 8)
-- Known limitation (D4): every test runs as superuser
-- Before production: ALTER ROLE app_service LOGIN and health_service LOGIN
-- Then re-run entire test suite under real role as acceptance test
-- ============================================================

-- ============================================================
-- D4.1: Enable app_service LOGIN
-- ============================================================
ALTER ROLE app_service LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';

-- ============================================================
-- D4.2: Enable health_service LOGIN
-- ============================================================
ALTER ROLE health_service LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';

-- ============================================================
-- D4.3: Grant LOGIN to cerbos role (for policy evaluation)
-- ============================================================
ALTER ROLE cerbos LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';

-- ============================================================
-- D4.4: Grant CONNECT on database
-- ============================================================
GRANT CONNECT ON DATABASE edurankai TO app_service, health_service, cerbos;

-- ============================================================
-- D4.5: Grant USAGE on schema
-- ============================================================
GRANT USAGE ON SCHEMA health TO app_service, health_service, cerbos;

-- ============================================================
-- D4.6: Verify roles can connect
-- ============================================================
DO $$
DECLARE
    v_role TEXT;
    v_can_login BOOLEAN;
BEGIN
    FOR v_role IN SELECT unnest(ARRAY['app_service', 'health_service', 'cerbos'])
    LOOP
        SELECT rolcanlogin INTO v_can_login FROM pg_roles WHERE rolname = v_role;
        IF v_can_login THEN
            RAISE NOTICE 'Role % can login: YES', v_role;
        ELSE
            RAISE NOTICE 'Role % can login: NO', v_role;
        END IF;
    END LOOP;
END $$;

-- ============================================================
-- D4.7: Test connection as app_service
-- ============================================================
-- Run this after applying migration:
-- psql -U app_service -d edurankai -c "SELECT current_user;"

-- ============================================================
-- D4.8: Re-run test suite as app_service
-- ============================================================
-- npm test -- --run-as=app_service
-- All tests MUST pass as app_service role

-- ============================================================
-- D4.9: Verify Cerbos decisions align with DB grants
-- ============================================================
-- Documented divergence (accepted):
-- Cerbos may ALLOW action (e.g., person.erase) that DB grants don't permit
-- (app_service has no DELETE privilege). This fails closed and is intentional.

-- ============================================================
-- D4.10: Cross-layer validation checklist
-- ============================================================
-- [ ] app_service can connect and run queries
-- [ ] health_service can connect for health access
-- [ ] Cerbos can connect for policy evaluation
-- [ ] Test suite passes as app_service (not superuser)
-- [ ] Cerbos ALLOW matches DB GRANT for all resource/action combos
-- [ ] Cerbos DENY matches DB DENY for all resource/action combos
-- [ ] Known divergences documented and accepted

-- ============================================================
-- GRANTS for production roles
-- ============================================================
-- app_service: standard CRUD on core tables
GRANT SELECT, INSERT, UPDATE ON health.persons TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.user_accounts TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.departments TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.positions TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.position_reporting_lines TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.employments TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.campus_ambassadors TO app_service;
GRANT SELECT, INSERT ON health.audit_log TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.leave_requests TO app_service;
GRANT SELECT, INSERT ON health.attendance_events TO app_service;
GRANT SELECT ON health.campus_ambassadors TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.leave_requests TO app_service;
GRANT SELECT, INSERT ON health.attendance_events TO app_service;
GRANT SELECT, INSERT ON health.employee_messages TO app_service;
GRANT SELECT ON health.notifications TO app_service;

-- health_service: subject-scoped health access ONLY
REVOKE ALL ON SCHEMA health FROM health_service;
GRANT USAGE ON SCHEMA health TO health_service;
GRANT SELECT ON health.persons TO health_service;

-- cerbos: policy evaluation
GRANT SELECT ON ALL TABLES IN SCHEMA health TO cerbos;

-- ============================================================
-- VERIFICATION: Run after migration
-- ============================================================
-- psql -U app_service -d edurankai -c "SELECT current_user;"
-- psql -U health_service -d edurankai -c "SELECT current_user;"
-- psql -U cerbos -d edurankai -c "SELECT current_user;"

-- ============================================================
-- END OF MIGRATION 011
-- ============================================================
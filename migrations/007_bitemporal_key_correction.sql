-- Migration 007: Bitemporal Key Correction (Section 4)
-- Applied: After 005
-- Description: Corrected bitemporal primary key from (logical_id, system_period) to (logical_id, valid_period, system_period)

-- ============================================================
-- KEY CORRECTION: Migration 007 is the KEY CORRECTION
-- Original key: (logical_id, system_period) - WRONG
-- Corrected key: (logical_id, valid_period, system_period) - CORRECT
-- This migration documents the correction and ensures all tables use correct key
-- ============================================================

-- ============================================================
-- VERIFICATION: All bitemporal tables use correct PK
-- ============================================================
DO $$
DECLARE
    v_table TEXT;
    v_pk_columns TEXT[];
    v_expected TEXT[] := ARRAY['logical_id', 'valid_period', 'system_period'];
    v_issues INT := 0;
BEGIN
    FOR v_table IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'health'
        AND tablename IN ('departments', 'positions', 'position_reporting_lines', 'employments', 'leave_requests')
    LOOP
        SELECT array_agg(a.attname ORDER BY a.attnum)
        INTO v_pk_columns
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = v_table::regclass AND i.indisprimary;

        IF v_pk_columns <> v_expected THEN
            RAISE NOTICE 'Table % has incorrect PK: % (expected: %)', v_table, v_pk_columns, v_expected;
            v_issues := v_issues + 1;
        ELSE
            RAISE NOTICE 'Table % has correct PK: %', v_table, v_pk_columns;
        END IF;
    END LOOP;

    IF v_issues = 0 THEN
        RAISE NOTICE 'All bitemporal tables have correct PK: (logical_id, valid_period, system_period)';
    ELSE
        RAISE EXCEPTION '% tables have incorrect PK - migration 007 is the correction', v_issues;
    END IF;
END $$;

-- ============================================================
-- DOCUMENTATION: The bitemporal key correction
-- ============================================================
COMMENT ON TABLE health.departments IS 'Bitemporal - PK corrected in migration 007 to (logical_id, valid_period, system_period)';
COMMENT ON TABLE health.positions IS 'Bitemporal - PK corrected in migration 007 to (logical_id, valid_period, system_period)';
COMMENT ON TABLE health.position_reporting_lines IS 'Bitemporal - PK corrected in migration 007 to (logical_id, valid_period, system_period)';
COMMENT ON TABLE health.employments IS 'Bitemporal - PK corrected in migration 007 to (logical_id, valid_period, system_period)';
COMMENT ON TABLE health.leave_requests IS 'Bitemporal - PK corrected in migration 007 to (logical_id, valid_period, system_period)';

-- ============================================================
-- DOCUMENTATION: Why the correction matters
-- ============================================================
COMMENT ON SCHEMA health IS 'EduRankAI HRMS core schema - Phase 1 core entities. Bitemporal key corrected in migration 007.';

-- The original key (logical_id, system_period) was WRONG because:
-- 1. It caused silent data destruction on second edit of same record
-- 2. Closing out old version and inserting new with same system_period boundary destroyed history
-- 3. The correction to (logical_id, valid_period, system_period) preserves both valid-time and transaction-time dimensions

-- ============================================================
-- VERIFICATION QUERY
-- ============================================================
-- Run this to verify all tables have correct PK:
-- SELECT tablename, array_agg(attname ORDER BY attnum) as pk_columns
-- FROM pg_index i
-- JOIN pg_class c ON c.oid = i.indrelid
-- JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'health' AND i.indisprimary
-- GROUP BY tablename
-- ORDER BY tablename;

-- ============================================================
-- END OF MIGRATION 007
-- ============================================================
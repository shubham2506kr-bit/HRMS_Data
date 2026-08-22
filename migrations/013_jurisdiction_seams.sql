-- Migration 013: Global Hiring Seams (Section 7)
-- Applied: After 012
-- Description: Jurisdiction seams for future global hiring - INTENTIONALLY NOT IMPLEMENTED

-- JURISDICTION SEAMS - Section 7
-- Three seams marked for future Phase 2 - INTENTIONALLY NOT IMPLEMENTED
-- Do NOT implement these - they are seams for future phase

-- SEAM 1: Row-scoping logic placeholder
-- This is a SEAM for future Phase 2 - NOT implemented
-- When global hiring is implemented, row-level security policies
-- will be added here to scope data by jurisdiction

-- SEAM 2: Jurisdiction-conditioned policy rule slot
-- This is a SEAM for future Phase 2 - NOT implemented
-- Cerbos policy rule slot for jurisdiction-conditioned rules

-- SEAM 3: Residency-based connection routing placeholder
-- This is a SEAM for future Phase 2 - NOT implemented
-- Connection routing based on data residency requirements

-- JURISDICTION ENUM - PERMANENTLY FROZEN TO ['IN']
-- Permanent test guard: fails build if enum contains anything else
-- Do NOT add countries to this enum

-- The jurisdiction enum is defined in core schema (migration 001)
-- as TEXT with CHECK constraint = 'IN'
-- DO NOT MODIFY - permanently frozen to ['IN']

-- TEST GUARD: Prevent adding jurisdictions
-- NOTE: persons has no jurisdiction column; departments/employments enforce 'IN'
-- via column DEFAULT + CHECK below. Guard is inert until Phase 2 adds the column.
CREATE OR REPLACE FUNCTION health.fn_guard_jurisdiction_enum()
RETURNS trigger AS $$
BEGIN
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE health.departments DROP CONSTRAINT IF EXISTS departments_jurisdiction_check;
ALTER TABLE health.departments ADD CONSTRAINT departments_jurisdiction_check CHECK (jurisdiction = 'IN');
ALTER TABLE health.employments DROP CONSTRAINT IF EXISTS employments_jurisdiction_check;
ALTER TABLE health.employments ADD CONSTRAINT employments_jurisdiction_check CHECK (jurisdiction = 'IN');

CREATE TRIGGER tr_guard_jurisdiction_persons
BEFORE INSERT OR UPDATE ON health.persons
FOR EACH ROW EXECUTE PROCEDURE health.fn_guard_jurisdiction_enum();

CREATE TRIGGER tr_guard_jurisdiction_employments
BEFORE INSERT OR UPDATE ON health.employments
FOR EACH ROW EXECUTE PROCEDURE health.fn_guard_jurisdiction_enum();

CREATE TRIGGER tr_guard_jurisdiction_departments
BEFORE INSERT OR UPDATE ON health.departments
FOR EACH ROW EXECUTE PROCEDURE health.fn_guard_jurisdiction_enum();

-- TEST GUARD: Permanent test that fails if enum contains non-IN
-- persons has no jurisdiction column; check is enforced by CHECK constraints
-- on departments and employments (added above).
CREATE OR REPLACE FUNCTION health.test_jurisdiction_enum_frozen()
RETURNS VOID
AS $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count FROM health.departments WHERE jurisdiction != 'IN';
    IF v_count > 0 THEN RAISE EXCEPTION 'Jurisdiction enum test failed: found % non-IN jurisdictions in departments', v_count; END IF;
    SELECT COUNT(*) INTO v_count FROM health.employments WHERE jurisdiction != 'IN';
    IF v_count > 0 THEN RAISE EXCEPTION 'Jurisdiction enum test failed: found % non-IN jurisdictions in employments', v_count; END IF;
    RAISE NOTICE 'Jurisdiction enum test passed: all records are IN';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- END OF MIGRATION 013
-- ============================================================
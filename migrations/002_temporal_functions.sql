-- Migration 002: Temporal Functions (Core)
-- Applied: After 001
-- Description: Core bitemporal temporal functions for versioned updates

-- ============================================================
-- fn_employment_correct: Update employment via temporal versioning
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_employment_correct(
    p_logical_id UUID,
    p_position_id UUID,
    p_status TEXT,
    p_valid_from TIMESTAMPTZ,
    p_valid_to TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_current_record RECORD;
    v_old_system_end TIMESTAMPTZ;
BEGIN
    -- Only HR roles can close out and re-insert
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can correct employment records';
    END IF;

    -- Find current version
    SELECT * INTO v_current_record
    FROM health.employments
    WHERE logical_id = p_logical_id
      AND NOW() <@ system_period
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Employment % not found or not current', p_logical_id;
    END IF;

    -- Close out old version
    UPDATE health.employments
    SET system_period = TSTZRANGE(
        LOWER(system_period),
        p_system_from,
        '[)'
    )
    WHERE logical_id = p_logical_id
      AND valid_period @> LOWER(v_current_record.valid_period)
      AND NOW() <@ system_period;

    -- Insert new version
    INSERT INTO health.employments (
        logical_id,
        valid_period,
        system_period,
        person_id,
        position_id,
        status,
        jurisdiction,
        employment_type,
        parental_consent_secured,
        started_at,
        ended_at,
        termination_reason,
        created_at,
        updated_at
    )
    SELECT
        p_logical_id,
        TSTZRANGE(p_valid_from, p_valid_to, '[]'),
        TSTZRANGE(p_system_from, NULL, '[)'),
        person_id,
        p_position_id,
        p_status,
        jurisdiction,
        employment_type,
        parental_consent_secured,
        started_at,
        ended_at,
        termination_reason,
        NOW(),
        NOW()
    FROM health.employments
    WHERE logical_id = p_logical_id
      AND NOW() <@ system_period
    LIMIT 1;

    RETURN;
END;
$$;

-- ============================================================
-- fn_department_new_version: Bitemporal department versioning
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_department_new_version(
    p_logical_id UUID,
    p_name TEXT,
    p_jurisdiction TEXT,
    p_parent_department_id UUID,
    p_description TEXT,
    p_valid_from TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_system_end TIMESTAMPTZ;
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can version departments';
    END IF;

    UPDATE health.departments
    SET system_period = TSTZRANGE(LOWER(system_period), p_system_from, '[)')
    WHERE logical_id = p_logical_id
      AND NOW() <@ system_period;

    INSERT INTO health.departments (
        logical_id, valid_period, system_period, name, jurisdiction,
        parent_department_id, description, created_at, updated_at
    )
    SELECT
        p_logical_id,
        TSTZRANGE(p_system_from, NULL, '[]'),
        TSTZRANGE(p_system_from, NULL, '[]'),
        p_name, p_jurisdiction, p_parent_department_id, p_description,
        NOW(), NOW()
    FROM health.departments
    WHERE logical_id = p_logical_id AND NOW() <@ system_period
    LIMIT 1;

    RETURN;
END;
$$;

-- ============================================================
-- fn_position_new_version: Bitemporal position versioning
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_position_new_version(
    p_logical_id UUID,
    p_name TEXT,
    p_department_id UUID,
    p_head_of_department_id UUID,
    p_grade_level INTEGER,
    p_employment_type TEXT,
    p_description TEXT,
    p_valid_from TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can version positions';
    END IF;

    UPDATE health.positions
    SET system_period = TSTZRANGE(LOWER(system_period), p_system_from, '[])')
    WHERE logical_id = p_logical_id
      AND NOW() <@ system_period;

    INSERT INTO health.positions (
        logical_id, valid_period, system_period, name, department_id,
        head_of_department_id, grade_level, employment_type, description,
        created_at, updated_at
    )
    SELECT
        p_logical_id,
        TSTZRANGE(p_system_from, NULL, '[]'),
        TSTZRANGE(p_system_from, NULL, '[]'),
        p_name, p_department_id, p_head_of_department_id, p_grade_level,
        p_employment_type, p_description, NOW(), NOW()
    FROM health.positions
    WHERE logical_id = p_logical_id AND NOW() <@ system_period
    LIMIT 1;

    RETURN;
END;
$$;

-- ============================================================
-- fn_reporting_line_new_version: Bitemporal reporting line versioning
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_reporting_line_new_version(
    p_logical_id UUID,
    p_child_position_id UUID,
    p_parent_position_id UUID,
    p_is_primary BOOLEAN,
    p_reporting_type TEXT,
    p_valid_from TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can version reporting lines';
    END IF;

    UPDATE health.position_reporting_lines
    SET system_period = TSTZRANGE(LOWER(system_period), p_system_from, '[])')
    WHERE logical_id = p_logical_id
      AND NOW() <@ system_period;

    INSERT INTO health.position_reporting_lines (
        logical_id, valid_period, system_period,
        child_position_id, parent_position_id, is_primary, reporting_type,
        created_at, updated_at
    )
    SELECT
        p_logical_id,
        TSTZRANGE(p_system_from, NULL, '[]'),
        TSTZRANGE(p_system_from, NULL, '[]'),
        p_child_position_id, p_parent_position_id, p_is_primary, p_reporting_type,
        NOW(), NOW()
    FROM health.position_reporting_lines
    WHERE logical_id = p_logical_id AND NOW() <@ system_period
    LIMIT 1;

    RETURN;
END;
$$;

-- ============================================================
-- fn_reporting_chain_as_of: Shared chain resolution (Section 4, 5)
-- Used by BOTH application and test suite - never hand-roll this
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_reporting_chain_as_of(
    p_person_id UUID,
    p_as_of_date DATE
)
RETURNS TABLE (
    ancestor_person_id UUID,
    descendant_person_id UUID,
    relationship_depth INTEGER,
    relationship_path TEXT
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
WITH RECURSIVE chain AS (
    -- Base: direct employment
    SELECT
        e.person_id::UUID AS ancestor_person_id,
        e.person_id::UUID AS descendant_person_id,
        0 AS relationship_depth,
        e.person_id::TEXT AS relationship_path
    FROM health.employments e
    WHERE e.logical_id = p_person_id
      AND e.valid_period @> (p_as_of_date)::TIMESTAMPTZ
      AND e.status = 'ACTIVE'

    UNION ALL

    -- Recursive: find managers
    SELECT
        e.person_id::UUID AS ancestor_person_id,
        c.descendant_person_id,
        c.relationship_depth + 1,
        e.person_id::TEXT || ' > ' || c.relationship_path
    FROM health.employments e
    JOIN health.position_reporting_lines prl ON prl.child_position_id = e.position_id
    JOIN chain c ON c.ancestor_person_id = e.person_id
    WHERE e.valid_period @> (p_as_of_date)::TIMESTAMPTZ
      AND e.status = 'ACTIVE'
      AND prl.valid_period @> (p_as_of_date)::TIMESTAMPTZ
      AND c.relationship_depth < 10
)
SELECT DISTINCT ancestor_person_id, descendant_person_id, relationship_depth, relationship_path
FROM chain
WHERE ancestor_person_id != descendant_person_id
ORDER BY relationship_depth ASC, ancestor_person_id;
$$;

-- ============================================================
-- fn_is_minor: Derived at read time (Section 3, 6)
-- NEVER stored - computed from DOB
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_is_minor(p_person_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT CASE
        WHEN EXTRACT(YEAR FROM AGE(persons.date_of_birth)) >= 18 THEN FALSE
        ELSE TRUE
    END
    FROM health.persons
    WHERE logical_id = p_person_id;
$$;

-- ============================================================
-- fn_check_parental_consent: Trigger for minors (Section 3)
-- Enforced by database trigger - NOT application code
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_check_parental_consent()
RETURNS trigger AS $$
BEGIN
    IF health.fn_is_minor(NEW.person_id) THEN
        IF NEW.parental_consent_secured IS FALSE OR NEW.parental_consent_secured IS NULL THEN
            RAISE EXCEPTION 'Parental consent required for minor employee %', NEW.person_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'employments' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'health')) THEN
        DROP TRIGGER IF EXISTS tr_check_parental_consent ON health.employments;
        CREATE TRIGGER tr_check_parental_consent
        AFTER INSERT OR UPDATE ON health.employments
        FOR EACH ROW EXECUTE PROCEDURE health.fn_check_parental_consent();
    END IF;
END $$;

-- ============================================================
-- fn_reporting_cycle_check: Prevent cycles in reporting DAG (Section 4)
-- Trigger prevents cycles - partial exclusion constraint + trigger
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_reporting_cycle_check()
RETURNS trigger AS $$
DECLARE
    v_cycle BOOLEAN;
BEGIN
    -- Check if adding this edge creates a cycle
    WITH RECURSIVE cycle_check AS (
        SELECT NEW.parent_position_id AS pos_id, 1 AS depth
        UNION ALL
        SELECT prl.parent_position_id, c.depth + 1
        FROM health.position_reporting_lines prl
        JOIN cycle_check c ON c.pos_id = prl.child_position_id
        WHERE c.depth < 20
    )
    SELECT EXISTS(SELECT 1 FROM cycle_check WHERE pos_id = NEW.child_position_id)
    INTO v_cycle;

    IF v_cycle THEN
        RAISE EXCEPTION 'Adding this reporting line would create a cycle';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'position_reporting_lines' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'health')) THEN
        DROP TRIGGER IF EXISTS tr_reporting_cycle_check ON health.position_reporting_lines;
        CREATE TRIGGER tr_reporting_cycle_check
        AFTER INSERT OR UPDATE ON health.position_reporting_lines
        FOR EACH ROW EXECUTE PROCEDURE health.fn_reporting_cycle_check();
    END IF;
END $$;

-- ============================================================
-- fn_reporting_one_primary: Enforce one primary parent (Section 4)
-- Partial exclusion constraint already handles this at DB level
-- This is documentation of the constraint behavior
-- ============================================================
COMMENT ON CONSTRAINT reporting_line_one_primary ON health.position_reporting_lines IS
'Exactly one primary parent per child per valid period - enforced by partial exclusion constraint';

-- ============================================================
-- fn_leave_request_new_version: Leave request temporal versioning
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_leave_request_new_version(
    p_logical_id UUID,
    p_leave_type TEXT,
    p_status TEXT,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_parental_consent_secured BOOLEAN,
    p_effective_time TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin', 'self') THEN
        RAISE EXCEPTION 'Unauthorized to modify leave request';
    END IF;

    UPDATE health.leave_requests
    SET system_period = TSTZRANGE(LOWER(system_period), NOW(), '[])')
    WHERE logical_id = p_logical_id
      AND NOW() <@ system_period;

    INSERT INTO health.leave_requests (
        logical_id, valid_period, system_period, person_id, leave_type,
        status, start_date, end_date, days_requested, reason,
        parental_consent_secured, created_at, updated_at
    )
    SELECT
        p_logical_id,
        TSTZRANGE(NOW(), NULL, '[]'),
        TSTZRANGE(NOW(), NULL, '[]'),
        person_id,
        p_leave_type,
        p_status,
        p_start_date,
        p_end_date,
        (p_end_date - p_start_date)::INT,
        p_reason,
        p_parental_consent_secured,
        NOW(), NOW()
    FROM health.leave_requests
    WHERE logical_id = p_logical_id AND NOW() <@ system_period
    LIMIT 1;

    RETURN;
END;
$$;

-- ============================================================
-- fn_audit_log_action: Automatic audit logging
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_action(
    p_action TEXT,
    p_target_type TEXT,
    p_target_id UUID,
    p_person_id UUID,
    p_details JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
    INSERT INTO health.audit_log (action, target_type, target_id, person_id, details)
    VALUES (p_action, p_target_type, p_target_id, p_person_id, p_details);
$$;

-- ============================================================
-- fn_audit_log_insert: Trigger for automatic audit logging
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_insert()
RETURNS trigger AS $$
BEGIN
    PERFORM health.fn_audit_log_action(
        TG_OP || '_insert',
        TG_TABLE_NAME,
        NEW.logical_id,
        COALESCE(NEW.person_id, NEW.sender_id, NEW.recipient_id, NEW.person_id),
        to_jsonb(NEW)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- END OF MIGRATION 002 (Core temporal functions only)
-- Triggers for tables created in later migrations are in their respective migrations
-- ============================================================
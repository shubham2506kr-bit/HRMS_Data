-- Migration 009: Department Head Role (Section 8)
-- Applied: After 008
-- Description: department_head_of role enablement with head_of_department_id

-- ============================================================
-- department_head_of role enablement
-- Adds head_of_department_id column to positions table
-- Enables department_head_of Cerbos role
-- ============================================================

-- Column already added in migration 001 (head_of_department_id)
-- This migration activates the role and adds supporting functions

-- ============================================================
-- fn_department_head_new_version: Version department head assignment
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_department_head_new_version(
    p_position_id UUID,
    p_head_person_id UUID,
    p_effective_time TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can assign department heads';
    END IF;

    UPDATE health.positions
    SET head_of_department_id = p_head_person_id,
        updated_at = NOW()
    WHERE logical_id = p_position_id
      AND NOW() <@ system_period;

    RETURN;
END;
$$;

-- ============================================================
-- fn_department_head_of: Check if person is department head
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_department_head_of(
    p_person_id UUID,
    p_department_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT EXISTS (
        SELECT 1 FROM health.positions p
        WHERE p.head_of_department_id = p_person_id
          AND (p_department_id IS NULL OR p.department_id = p_department_id)
          AND NOW() <@ p.system_period
    );
$$;

-- ============================================================
-- fn_department_head_of_department: Get department headed by person
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_department_head_of_department(
    p_person_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT p.department_id
    FROM health.positions p
    WHERE p.head_of_department_id = p_person_id
      AND NOW() <@ p.system_period
    LIMIT 1;
$$;

-- ============================================================
-- Cerbos Policy Integration: department_head_of role
-- ============================================================
-- The Cerbos policy will use fn_department_head_of for authorization
-- Resource: department
-- Action: department_head_of
-- Condition: request.principal.id == department.head_of_department_id

-- ============================================================
-- END OF MIGRATION 009
-- ============================================================
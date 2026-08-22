-- Migration 010: Role Combination Semantics (Section 8)
-- Applied: After 009
-- Description: Role-combination semantics - "union of permissions" model

-- fn_effective_permissions: Calculate effective permissions for person
CREATE OR REPLACE FUNCTION health.fn_effective_permissions(
    p_person_id UUID,
    p_resource_kind TEXT,
    p_action TEXT,
    p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    allowed BOOLEAN,
    roles TEXT[],
    reasons TEXT[],
    evidence JSONB
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT false AS allowed,
           ARRAY[]::TEXT[] AS roles,
           ARRAY[]::TEXT[] AS reasons,
           jsonb_build_object('roles_evaluated', ARRAY[]::TEXT[]) AS evidence;
$$;

-- fn_role_combination_test: Test role combination scenarios
CREATE OR REPLACE FUNCTION health.fn_role_combination_test()
RETURNS TABLE (
    scenario TEXT,
    person_id UUID,
    roles TEXT[],
    resource TEXT,
    action TEXT,
    result BOOLEAN
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT 'Employee + Manager'::TEXT,
           p1.logical_id,
           ARRAY['employee', 'direct_manager_of']::TEXT[],
           'leave_request'::TEXT, 'read'::TEXT,
           false
    FROM health.persons p1
    JOIN health.employments e ON e.person_id = p1.logical_id AND e.status = 'ACTIVE'
    JOIN health.position_reporting_lines prl ON prl.child_position_id = e.position_id
    WHERE e.status = 'ACTIVE' AND NOW() <@ e.system_period

    UNION ALL

    SELECT 'HR + Manager'::TEXT,
           p2.logical_id,
           ARRAY['hr_generalist', 'direct_manager_of']::TEXT[],
           'department'::TEXT, 'write'::TEXT,
           false
    FROM health.persons p2
    WHERE EXISTS (SELECT 1 FROM health.user_accounts ua WHERE ua.person_id = p2.logical_id AND ua.is_active)

    UNION ALL

    SELECT 'Department Head + HR Restricted'::TEXT,
           p3.logical_id,
           ARRAY['department_head_of', 'hr_restricted']::TEXT[],
           'employment'::TEXT, 'read'::TEXT,
           false
    FROM health.persons p3
    JOIN health.positions p ON p.head_of_department_id = p3.logical_id
    WHERE NOW() <@ p.system_period
    LIMIT 3;
$$;

-- fn_role_combination_audit: Audit role combinations
CREATE OR REPLACE FUNCTION health.fn_role_combination_audit()
RETURNS TABLE (
    person_id UUID,
    legal_name TEXT,
    roles TEXT[],
    conflicting_roles BOOLEAN,
    notes TEXT
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT
        p.logical_id AS person_id,
        p.legal_name,
        (
            SELECT ARRAY_AGG(DISTINCT v.role) FROM (
                VALUES
                    ('employee', EXISTS (SELECT 1 FROM health.employments e WHERE e.person_id = p.logical_id AND e.status = 'ACTIVE' AND NOW() <@ e.system_period)),
                    ('department_head_of', EXISTS (SELECT 1 FROM health.positions p WHERE p.head_of_department_id = p.logical_id AND NOW() <@ p.system_period)),
                    ('direct_manager_of', EXISTS (SELECT 1 FROM health.employments e JOIN health.position_reporting_lines prl ON prl.child_position_id = e.position_id WHERE e.person_id = p.logical_id AND e.status = 'ACTIVE' AND NOW() <@ e.system_period)),
                    ('manager_chain_of', EXISTS (SELECT 1 FROM health.fn_reporting_chain_as_of(p.logical_id, (health.now_immutable())::DATE))),
                    ('platform_admin', EXISTS (SELECT 1 FROM health.user_accounts ua WHERE ua.person_id = p.logical_id AND ua.is_active)),
                    ('hr_generalist', EXISTS (SELECT 1 FROM health.user_accounts ua WHERE ua.person_id = p.logical_id AND ua.is_active AND ua.idp_issuer LIKE '%hr%')),
                    ('hr_restricted', EXISTS (SELECT 1 FROM health.user_accounts ua WHERE ua.person_id = p.logical_id AND ua.is_active AND ua.idp_issuer LIKE '%hr_restricted%')),
                    ('self', TRUE)
            ) AS v(role, has_role)
            WHERE has_role
        ) AS roles,
        CASE
            WHEN EXISTS (SELECT 1 FROM health.employments e WHERE e.person_id = p.logical_id AND e.status = 'ACTIVE' AND NOW() <@ e.system_period)
                 AND EXISTS (SELECT 1 FROM health.positions p WHERE p.head_of_department_id = p.logical_id AND NOW() <@ p.system_period)
            THEN TRUE ELSE FALSE END AS conflicting_roles,
        CASE
            WHEN EXISTS (SELECT 1 FROM health.employments e WHERE e.person_id = p.logical_id AND e.status = 'ACTIVE' AND NOW() <@ e.system_period)
                 AND EXISTS (SELECT 1 FROM health.positions p WHERE p.head_of_department_id = p.logical_id AND NOW() <@ p.system_period)
            THEN 'Multiple roles - union of permissions applies'
            ELSE 'Single role'
        END AS notes
    FROM health.persons p;
$$;

-- ============================================================
-- END OF MIGRATION 010
-- ============================================================
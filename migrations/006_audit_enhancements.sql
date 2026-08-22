-- Migration 006: Audit Log Enhancements (Section 5, 9)
-- Applied: After 005
-- Description: Enhanced audit logging with temporal queries

-- ============================================================
-- AUDIT_LOG - Enhanced with temporal queries (Section 5, 9)
-- ============================================================
-- Already created in 001, adding temporal query support

-- ============================================================
-- fn_audit_log_query: Temporal audit queries
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_query(
    p_person_id UUID,
    p_start_date TIMESTAMPTZ DEFAULT NULL,
    p_end_date TIMESTAMPTZ DEFAULT NULL,
    p_action TEXT DEFAULT NULL,
    p_target_type TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    log_id UUID,
    action TEXT,
    target_type TEXT,
    target_id UUID,
    person_id UUID,
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT
        al.log_id,
        al.action,
        al.target_type,
        al.target_id,
        al.person_id,
        al.details,
        al.ip_address,
        al.user_agent,
        al.created_at
    FROM health.audit_log al
    WHERE al.person_id = p_person_id
      AND (p_start_date IS NULL OR al.created_at >= p_start_date)
      AND (p_end_date IS NULL OR al.created_at <= p_end_date)
      AND (p_action IS NULL OR al.action = p_action)
      AND (p_target_type IS NULL OR al.target_type = p_target_type)
    ORDER BY al.created_at DESC
    LIMIT p_limit OFFSET p_offset;
$$;

-- ============================================================
-- fn_audit_log_timeline: Temporal timeline for entity
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_timeline(
    p_target_type TEXT,
    p_target_id UUID,
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    log_id UUID,
    action TEXT,
    actor_person_id UUID,
    actor_name TEXT,
    details JSONB,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT
        al.log_id,
        al.action,
        al.person_id AS actor_person_id,
        p.preferred_name AS actor_name,
        al.details,
        al.created_at
    FROM health.audit_log al
    LEFT JOIN health.persons p ON p.logical_id = al.person_id
    WHERE al.target_type = p_target_type
      AND al.target_id = p_target_id
    ORDER BY al.created_at DESC
    LIMIT p_limit;
$$;

-- ============================================================
-- fn_audit_log_entity_history: Entity history with bitemporal context
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_entity_history(
    p_target_type TEXT,
    p_target_id UUID
)
RETURNS TABLE (
    event_type TEXT,
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    system_from TIMESTAMPTZ,
    system_to TIMESTAMPTZ,
    actor_name TEXT,
    changes JSONB
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT
        al.action AS event_type,
        al.created_at AS valid_from,
        NULL::TIMESTAMPTZ AS valid_to,
        al.created_at AS system_from,
        NULL::TIMESTAMPTZ AS system_to,
        p.preferred_name AS actor_name,
        al.details AS changes
    FROM health.audit_log al
    LEFT JOIN health.persons p ON p.logical_id = al.person_id
    WHERE al.target_type = p_target_type
      AND al.target_id = p_target_id
    ORDER BY al.created_at ASC;
$$;

-- ============================================================
-- fn_audit_log_time_machine: Time machine for entity
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_time_machine(
    p_target_type TEXT,
    p_target_id UUID,
    p_as_of TIMESTAMPTZ
)
RETURNS TABLE (
    action TEXT,
    actor_name TEXT,
    details JSONB,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT
        al.action,
        p.preferred_name AS actor_name,
        al.details,
        al.created_at
    FROM health.audit_log al
    LEFT JOIN health.persons p ON p.logical_id = al.person_id
    WHERE al.target_type = p_target_type
      AND al.target_id = p_target_id
      AND al.created_at <= p_as_of
    ORDER BY al.created_at DESC;
$$;

-- ============================================================
-- AUDIT_LOG_VIEW: Convenience view for common queries
-- ============================================================
CREATE OR REPLACE VIEW health.audit_log_view AS
SELECT
    al.log_id,
    al.action,
    al.target_type,
    al.target_id,
    al.person_id,
    p.legal_name AS person_legal_name,
    p.preferred_name AS person_preferred_name,
    al.details,
    al.ip_address,
    al.user_agent,
    al.created_at
FROM health.audit_log al
LEFT JOIN health.persons p ON p.logical_id = al.person_id;

-- ============================================================
-- GRANTS - Must come AFTER all functions are created
-- ============================================================
DO $$
BEGIN
    -- Grant permissions on all audit functions
    GRANT SELECT ON health.fn_audit_log_query TO app_service, cerbos;
    GRANT SELECT ON health.fn_audit_log_timeline TO app_service, cerbos;
    GRANT SELECT ON health.fn_audit_log_entity_history TO app_service, cerbos;
    GRANT SELECT ON health.fn_audit_log_time_machine TO app_service, cerbos;
    GRANT SELECT ON health.audit_log_view TO app_service, cerbos;
EXCEPTION WHEN OTHERS THEN
    -- Silently continue if roles don't exist yet
    NULL;
END $$;

-- ============================================================
-- END OF MIGRATION 006
-- ============================================================
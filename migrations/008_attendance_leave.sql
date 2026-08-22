-- Migration 008: Attendance & Leave Management (Section 11)
-- Applied: After 007
-- Description: Additional functions for Attendance & Leave Management

-- ============================================================
-- fn_leave_balance: Calculate leave balance for person
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_leave_balance(
    p_person_id UUID,
    p_leave_type TEXT DEFAULT 'ANNUAL',
    p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    leave_type TEXT,
    total_entitled INTEGER,
    total_used INTEGER,
    balance INTEGER,
    pending_approval INTEGER
)
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT
        lr.leave_type,
        0 AS total_entitled, -- Would come from entitlements table
        COALESCE(SUM(CASE WHEN lr.status = 'APPROVED' THEN lr.days_requested ELSE 0 END), 0) AS total_used,
        0 AS balance, -- total_entitled - total_used - pending
        COALESCE(SUM(CASE WHEN lr.status = 'PENDING' THEN lr.days_requested ELSE 0 END), 0) AS pending_approval
    FROM health.leave_requests lr
    WHERE lr.person_id = p_person_id
      AND lr.leave_type = p_leave_type
      AND lr.valid_period @> (p_as_of_date)::TIMESTAMPTZ
      AND lr.system_period @> NOW()
    GROUP BY lr.leave_type;
$$;

-- ============================================================
-- END OF MIGRATION 008
-- ============================================================
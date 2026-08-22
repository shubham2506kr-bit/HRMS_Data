-- Migration 032: Leave integrity — entitlements, holidays, working-day counting,
--                 real balance function, and a livable overlap constraint.
--
-- Forward-only and fully re-runnable: runMigrations() replays every file on boot,
-- so every statement here is IF NOT EXISTS / CREATE OR REPLACE / guarded DO block.
--
-- Runs BEFORE 033, so health.fn_current_person() and health.fn_has_role() do NOT
-- exist yet and are deliberately not referenced anywhere in this file.
--
-- WORKING-DAY CONVENTION (load-bearing — payroll consumes days_requested):
--   days_requested = count of Mon–Fri calendar days in [start_date, end_date]
--   minus any non-optional holiday in health.holiday_calendar for the jurisdiction.
--   It is a WORKING-day count, never a wall-clock duration, and it is computed
--   from DATE values only so it cannot drift with DST or the server timezone.

-- ============================================================
-- 0. Prerequisites (no-ops when already present)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================
-- 1. LEAVE YEAR BOUNDS — Indian financial year (1 Apr – 31 Mar)
--    Immutable so they can be used inside generated/indexed expressions.
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_leave_year_start(p_as_of DATE)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT make_date(
        EXTRACT(YEAR FROM p_as_of)::INT
            - CASE WHEN EXTRACT(MONTH FROM p_as_of)::INT < 4 THEN 1 ELSE 0 END,
        4, 1);
$$;

CREATE OR REPLACE FUNCTION health.fn_leave_year_end(p_as_of DATE)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT (health.fn_leave_year_start(p_as_of) + INTERVAL '1 year' - INTERVAL '1 day')::DATE;
$$;

COMMENT ON FUNCTION health.fn_leave_year_start(DATE) IS
    'Start of the leave (financial) year containing the given date: 1 April.';

-- ============================================================
-- 2. HOLIDAY CALENDAR
--    No holiday table existed anywhere in 001–030, so create a minimal one.
--    Dates only (no timestamps) — a holiday is a calendar fact, not an instant.
-- ============================================================
CREATE TABLE IF NOT EXISTS health.holiday_calendar (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    holiday_date DATE NOT NULL,
    name TEXT NOT NULL,
    jurisdiction TEXT NOT NULL DEFAULT 'IN',
    is_optional BOOLEAN NOT NULL DEFAULT FALSE, -- restricted/optional holidays do not reduce working days
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_holiday_calendar_date_jurisdiction
    ON health.holiday_calendar (holiday_date, jurisdiction, name);

CREATE INDEX IF NOT EXISTS idx_holiday_calendar_lookup
    ON health.holiday_calendar (jurisdiction, holiday_date)
    WHERE is_optional = FALSE;

COMMENT ON TABLE health.holiday_calendar IS
    'Gazetted non-working days per jurisdiction. Seeded with the three Indian '
    'national holidays only; HR must load the full regional calendar.';

-- Seed the three Indian national holidays for a rolling window of years.
-- Generated rather than hardcoded so re-running in a later year still covers it.
INSERT INTO health.holiday_calendar (holiday_date, name, jurisdiction, is_optional)
SELECT h.d, h.nm, 'IN', FALSE
FROM (
    SELECT make_date(y, 1, 26) AS d, 'Republic Day' AS nm
    FROM generate_series(EXTRACT(YEAR FROM CURRENT_DATE)::INT - 1,
                         EXTRACT(YEAR FROM CURRENT_DATE)::INT + 4) AS y
    UNION ALL
    SELECT make_date(y, 8, 15), 'Independence Day'
    FROM generate_series(EXTRACT(YEAR FROM CURRENT_DATE)::INT - 1,
                         EXTRACT(YEAR FROM CURRENT_DATE)::INT + 4) AS y
    UNION ALL
    SELECT make_date(y, 10, 2), 'Gandhi Jayanti'
    FROM generate_series(EXTRACT(YEAR FROM CURRENT_DATE)::INT - 1,
                         EXTRACT(YEAR FROM CURRENT_DATE)::INT + 4) AS y
) h
WHERE NOT EXISTS (
    SELECT 1 FROM health.holiday_calendar c
    WHERE c.holiday_date = h.d AND c.jurisdiction = 'IN' AND c.name = h.nm
);

-- ============================================================
-- 3. WORKING-DAY COUNTER
--    STABLE (reads holiday_calendar). Pure DATE arithmetic: timezone-independent.
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_working_days(
    p_start DATE,
    p_end DATE,
    p_jurisdiction TEXT DEFAULT 'IN'
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = health
AS $$
    SELECT CASE
        WHEN p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN 0
        ELSE (
            SELECT COUNT(*)::INT
            FROM generate_series(p_start::TIMESTAMP, p_end::TIMESTAMP, INTERVAL '1 day') AS g(d)
            WHERE EXTRACT(ISODOW FROM g.d) < 6  -- 6 = Saturday, 7 = Sunday
              AND NOT EXISTS (
                  SELECT 1 FROM health.holiday_calendar h
                  WHERE h.holiday_date = g.d::DATE
                    AND h.jurisdiction = p_jurisdiction
                    AND h.is_optional = FALSE
              )
        )
    END;
$$;

COMMENT ON FUNCTION health.fn_working_days(DATE, DATE, TEXT) IS
    'Mon-Fri days in [p_start, p_end] excluding non-optional holidays. This is the '
    'single definition of days_requested consumed by leave and payroll.';

-- ============================================================
-- 4. LEAVE ENTITLEMENTS
--    Person-scoped OR role-scoped, per leave type, per leave-year window.
--    A person-scoped row for the window overrides the role baseline entirely.
-- ============================================================
CREATE TABLE IF NOT EXISTS health.leave_entitlements (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID,        -- exactly one of person_id / role_name is set
    role_name TEXT,
    leave_type TEXT NOT NULL
        CHECK (leave_type IN ('ANNUAL', 'SICK', 'CASUAL', 'PARENTAL', 'BEREAVEMENT',
                              'MATERNITY', 'PATERNITY', 'UNPAID')),
    year_basis TEXT NOT NULL DEFAULT 'FINANCIAL'
        CHECK (year_basis IN ('FINANCIAL', 'CALENDAR')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    opening_balance_days NUMERIC(6, 2) NOT NULL DEFAULT 0,
    accrued_days NUMERIC(6, 2) NOT NULL DEFAULT 0,
    carried_forward_days NUMERIC(6, 2) NOT NULL DEFAULT 0,
    max_carry_forward_days NUMERIC(6, 2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_leave_entitlements_scope
        CHECK ((person_id IS NOT NULL) <> (role_name IS NOT NULL)),
    CONSTRAINT chk_leave_entitlements_period
        CHECK (period_end >= period_start),
    CONSTRAINT chk_leave_entitlements_non_negative
        CHECK (opening_balance_days >= 0 AND accrued_days >= 0
               AND carried_forward_days >= 0 AND max_carry_forward_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_entitlements_person
    ON health.leave_entitlements (person_id, leave_type, period_start, period_end)
    WHERE person_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_entitlements_role
    ON health.leave_entitlements (role_name, leave_type, period_start, period_end)
    WHERE role_name IS NOT NULL;

COMMENT ON TABLE health.leave_entitlements IS
    'Leave entitlement in WORKING days. Values below are a placeholder baseline for '
    'role_name = ''employee''; HR must review them and add person-scoped overrides.';

-- Baseline role entitlement for the current and next four leave years.
-- Without at least one row every request would be rejected for zero balance, so
-- a conservative, documented default is seeded rather than failing closed on everyone.
INSERT INTO health.leave_entitlements (
    role_name, leave_type, year_basis, period_start, period_end,
    opening_balance_days, max_carry_forward_days, notes
)
SELECT 'employee', t.leave_type, 'FINANCIAL',
       health.fn_leave_year_start((CURRENT_DATE + (n.i || ' years')::INTERVAL)::DATE),
       health.fn_leave_year_end((CURRENT_DATE + (n.i || ' years')::INTERVAL)::DATE),
       t.days, t.carry_cap, 'Placeholder baseline seeded by migration 032'
FROM (VALUES
    ('ANNUAL',      18::NUMERIC, 30::NUMERIC),
    ('SICK',        12,          0),
    ('CASUAL',      12,          0),
    ('PARENTAL',    15,          0),
    ('PATERNITY',   15,          0),
    ('BEREAVEMENT',  5,          0),
    ('MATERNITY',  182,          0),   -- Maternity Benefit Act: 26 weeks
    ('UNPAID',     365,          0)    -- effectively uncapped; keeps LOP possible
) t(leave_type, days, carry_cap)
CROSS JOIN generate_series(0, 4) AS n(i)
WHERE NOT EXISTS (
    SELECT 1 FROM health.leave_entitlements e
    WHERE e.role_name = 'employee'
      AND e.leave_type = t.leave_type
      AND e.period_start = health.fn_leave_year_start((CURRENT_DATE + (n.i || ' years')::INTERVAL)::DATE)
      AND e.period_end = health.fn_leave_year_end((CURRENT_DATE + (n.i || ' years')::INTERVAL)::DATE)
);

-- ============================================================
-- 5. REAL BALANCE FUNCTION
--    Replaces the 008 stub that returned a hardcoded 0 and was never called.
--    Signature and output columns are kept byte-identical to 008 so
--    CREATE OR REPLACE succeeds and no existing caller changes shape.
--
--    Convention: a request is charged in full to the leave year containing
--    p_as_of_date if it overlaps that year at all. PENDING requests are charged
--    against the balance so overlapping submissions cannot oversubscribe it.
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
    WITH person_rows AS (
        SELECT e.*
        FROM health.leave_entitlements e
        WHERE e.person_id = p_person_id
          AND e.leave_type = p_leave_type
          AND p_as_of_date BETWEEN e.period_start AND e.period_end
    ),
    role_rows AS (
        -- Baseline applies only when the person has no explicit entitlement.
        -- Role membership beyond the org-wide 'employee' baseline cannot be
        -- resolved here: no person-to-role table exists in the schema yet.
        SELECT e.*
        FROM health.leave_entitlements e
        WHERE e.person_id IS NULL
          AND e.role_name = 'employee'
          AND e.leave_type = p_leave_type
          AND p_as_of_date BETWEEN e.period_start AND e.period_end
          AND NOT EXISTS (SELECT 1 FROM person_rows)
    ),
    effective AS (
        SELECT * FROM person_rows
        UNION ALL
        SELECT * FROM role_rows
    ),
    win AS (
        SELECT
            COALESCE(MIN(period_start), health.fn_leave_year_start(p_as_of_date)) AS year_start,
            COALESCE(MAX(period_end), health.fn_leave_year_end(p_as_of_date)) AS year_end,
            COALESCE(SUM(opening_balance_days + accrued_days
                         + LEAST(carried_forward_days, max_carry_forward_days)), 0)::INT AS entitled
        FROM effective
    ),
    consumed AS (
        SELECT
            COALESCE(SUM(CASE WHEN lr.status = 'APPROVED' THEN lr.days_requested END), 0)::INT AS used,
            COALESCE(SUM(CASE WHEN lr.status = 'PENDING' THEN lr.days_requested END), 0)::INT AS pending
        FROM health.leave_requests lr
        CROSS JOIN win w
        WHERE lr.person_id = p_person_id
          AND lr.leave_type = p_leave_type
          AND lr.status IN ('APPROVED', 'PENDING')
          AND lr.system_period @> NOW()
          AND lr.start_date <= w.year_end
          AND lr.end_date >= w.year_start
    )
    SELECT
        p_leave_type AS leave_type,
        w.entitled AS total_entitled,
        c.used AS total_used,
        (w.entitled - c.used - c.pending) AS balance,
        c.pending AS pending_approval
    FROM win w CROSS JOIN consumed c;
$$;

COMMENT ON FUNCTION health.fn_leave_balance(UUID, TEXT, DATE) IS
    'Working-day leave balance = entitlement - APPROVED - PENDING for the leave '
    'year containing p_as_of_date. Always returns exactly one row.';

-- ============================================================
-- 6. DAYS_REQUESTED CHECK
--    003 asserted days_requested = calendar span, which is incompatible with a
--    working-day count. Replace it with a bound: at most the calendar span.
--    (The unnamed 003 constraint is located by definition, not by guessed name.)
-- ============================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    IF to_regclass('health.leave_requests') IS NULL THEN
        RETURN;
    END IF;

    FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = 'health.leave_requests'::REGCLASS
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%days_requested%'
          AND c.conname <> 'chk_leave_requests_days_bounds'
    LOOP
        EXECUTE format('ALTER TABLE health.leave_requests DROP CONSTRAINT %I', r.conname);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_leave_requests_days_bounds'
          AND conrelid = 'health.leave_requests'::REGCLASS
    ) THEN
        -- >= 0 rather than >= 1 so pre-existing rows can never fail validation;
        -- the API rejects zero-working-day requests before they are written.
        ALTER TABLE health.leave_requests
            ADD CONSTRAINT chk_leave_requests_days_bounds
            CHECK (days_requested >= 0 AND days_requested <= (end_date - start_date) + 1);
    END IF;
END $$;

-- ============================================================
-- 7. OVERLAP CONSTRAINT — the "rejected dates blocked forever" defect
--
--    003 lines 34-39 added leave_requests_valid_period_excl:
--        EXCLUDE USING GIST (person_id WITH =, valid_period WITH &&)
--    with no status predicate and no system_period predicate. Consequences:
--      * a REJECTED or CANCELLED request permanently blocked those dates;
--      * bitemporal versioning was structurally impossible (a new system_period
--        version of the same logical row collides with its own predecessor);
--      * because valid_period is built with inclusive '[]' bounds, back-to-back
--        leaves (ending Fri / starting Sat) also collided.
--
--    Replacement: a PARTIAL exclusion over live, non-terminal rows only, keyed on
--    a discrete daterange (normalised to '[)' so adjacency is allowed).
--    upper_inf(system_period) is genuinely IMMUTABLE, so the system_period
--    condition IS expressible in the predicate — no residual gap there.
--    The new constraint is strictly weaker than the old one, so it cannot fail
--    validation against existing data.
-- ============================================================
DO $$
BEGIN
    IF to_regclass('health.leave_requests') IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'leave_requests_valid_period_excl'
          AND conrelid = 'health.leave_requests'::REGCLASS
    ) THEN
        ALTER TABLE health.leave_requests
            DROP CONSTRAINT leave_requests_valid_period_excl;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'leave_requests_live_period_excl'
          AND conrelid = 'health.leave_requests'::REGCLASS
    ) THEN
        ALTER TABLE health.leave_requests
            ADD CONSTRAINT leave_requests_live_period_excl
            EXCLUDE USING GIST (
                person_id WITH =,
                (daterange(start_date, end_date, '[]')) WITH &&
            )
            WHERE (status IN ('PENDING', 'APPROVED') AND upper_inf(system_period));

        COMMENT ON CONSTRAINT leave_requests_live_period_excl ON health.leave_requests IS 'One live leave claim per person per day: applies only to current-system-period rows in PENDING/APPROVED, so REJECTED and CANCELLED dates are reusable and system-period versioning of the same logical row is possible.';
    END IF;

    -- Supporting index for the balance/overlap lookups the API now performs.
    CREATE INDEX IF NOT EXISTS idx_leave_requests_person_type_dates
        ON health.leave_requests (person_id, leave_type, start_date, end_date)
        WHERE status IN ('PENDING', 'APPROVED');
END $$;

-- ============================================================
-- 8. GRANTS — guarded on the role existing (031 may create hrms_app)
-- ============================================================
DO $$
DECLARE
    g TEXT;
BEGIN
    FOREACH g IN ARRAY ARRAY['hrms_app', 'app_service'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) THEN
            EXECUTE format('GRANT USAGE ON SCHEMA health TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.leave_requests TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.leave_entitlements TO %I', g);
            EXECUTE format('GRANT SELECT ON health.holiday_calendar TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_leave_balance(UUID, TEXT, DATE) TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_working_days(DATE, DATE, TEXT) TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_leave_year_start(DATE) TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_leave_year_end(DATE) TO %I', g);
        END IF;
    END LOOP;
END $$;

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- SELECT * FROM health.fn_leave_balance('<person-uuid>'::UUID, 'ANNUAL', CURRENT_DATE);
-- SELECT health.fn_working_days(DATE '2026-08-13', DATE '2026-08-17');
--   -- expect 3: Thu 13, Fri 14, Mon 17 (Sat 15 / Sun 16 excluded as weekend)
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'health.leave_requests'::REGCLASS ORDER BY conname;

-- ============================================================
-- END OF MIGRATION 032
-- ============================================================

-- Migration 005: Campus Ambassadors (Section 3)
-- Applied: After 004
-- Description: Campus ambassadors with parental consent for minors

-- ============================================================
-- CAMPUS_AMBASSADORS - Separate from employees (Section 3)
-- No employments row created - separate relationship type
-- If under 18, parental_consent_secured = true enforced by trigger
-- ============================================================
CREATE TABLE IF NOT EXISTS health.campus_ambassadors (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    department_id UUID REFERENCES health.departments(logical_id),
    role TEXT NOT NULL DEFAULT 'CAMPUS_AMBASSADOR',
    start_date DATE NOT NULL,
    end_date DATE,
    parental_consent_secured BOOLEAN NOT NULL DEFAULT FALSE,
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_ambassadors_person ON health.campus_ambassadors (person_id);
CREATE INDEX IF NOT EXISTS idx_ambassadors_dept ON health.campus_ambassadors (department_id);
CREATE INDEX IF NOT EXISTS idx_ambassadors_dates ON health.campus_ambassadors (start_date, end_date);

-- ============================================================
-- Trigger: Parental consent for minor ambassadors
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_check_ambassador_minor_consent()
RETURNS trigger AS $$
BEGIN
    IF health.fn_is_minor(NEW.person_id) THEN
        IF NEW.parental_consent_secured IS FALSE OR NEW.parental_consent_secured IS NULL THEN
            RAISE EXCEPTION 'Parental consent required for minor campus ambassador %', NEW.person_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'campus_ambassadors' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'health')) THEN
        DROP TRIGGER IF EXISTS tr_check_ambassador_minor_consent ON health.campus_ambassadors;
        CREATE TRIGGER tr_check_ambassador_minor_consent
        AFTER INSERT OR UPDATE ON health.campus_ambassadors
        FOR EACH ROW EXECUTE PROCEDURE health.fn_check_ambassador_minor_consent();
    END IF;
END $$;

-- ============================================================
-- IMMUTABLE function for index predicate
-- ============================================================
CREATE OR REPLACE FUNCTION health.now_immutable_date()
RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $$ SELECT (health.now_immutable())::DATE; $$;

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_ambassadors_person ON health.campus_ambassadors (person_id);
CREATE INDEX IF NOT EXISTS idx_ambassadors_dept ON health.campus_ambassadors (department_id);
CREATE INDEX IF NOT EXISTS idx_ambassadors_dates ON health.campus_ambassadors (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_ambassadors_active ON health.campus_ambassadors (person_id, start_date, end_date)
    WHERE end_date IS NULL OR end_date >= health.now_immutable_date();

-- ============================================================
-- END OF MIGRATION 005
-- ============================================================
-- Migration 001: Core Schema - Foundation
-- Applied: Initial
-- Description: Core schema with persons, user_accounts, employments, departments, positions

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Create health schema
CREATE SCHEMA IF NOT EXISTS health;

-- ============================================================
-- IMMUTABLE FUNCTIONS FOR PARTIAL INDEXES
-- ============================================================
CREATE OR REPLACE FUNCTION health.now_immutable()
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
AS $$ SELECT NOW(); $$;

-- ============================================================
-- PERSONS - Immutable human record (Section 3)
-- ============================================================
CREATE TABLE health.persons (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    legal_name TEXT NOT NULL,
    preferred_name TEXT,
    date_of_birth DATE NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    national_id_hash TEXT,
    national_id_encrypted BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_persons_dob ON health.persons (date_of_birth);
CREATE INDEX idx_persons_preferred_name ON health.persons (preferred_name);

-- ============================================================
-- USER_ACCOUNTS - Login mapping only
-- ============================================================
CREATE TABLE health.user_accounts (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL, -- REFERENCES health.persons(logical_id) ON DELETE CASCADE (enforced at app level)
    idp_subject_id TEXT NOT NULL,
    idp_issuer TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (idp_subject_id, idp_issuer)
);

CREATE INDEX idx_user_accounts_person ON health.user_accounts (person_id);

-- ============================================================
-- DEPARTMENTS - Bitemporal
-- ============================================================
CREATE TABLE health.departments (
    logical_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    valid_period TSTZRANGE NOT NULL,
    system_period TSTZRANGE NOT NULL,
    name TEXT NOT NULL,
    jurisdiction TEXT NOT NULL DEFAULT 'IN',
    parent_department_id UUID,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (logical_id, valid_period, system_period)
);

ALTER TABLE health.departments
    ADD CONSTRAINT departments_valid_period_excl
    EXCLUDE USING GIST (
        logical_id WITH =,
        valid_period WITH &&
    );

CREATE INDEX idx_departments_current ON health.departments (logical_id)
    WHERE health.now_immutable() <@ system_period;

-- ============================================================
-- POSITIONS - Bitemporal with head_of_department_id
-- NOTE: FK to departments removed - enforced at application level due to bitemporal PK
-- ============================================================
CREATE TABLE health.positions (
    logical_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    valid_period TSTZRANGE NOT NULL,
    system_period TSTZRANGE NOT NULL,
    name TEXT NOT NULL,
    department_id UUID NOT NULL, -- References departments.logical_id (enforced at app level)
    head_of_department_id UUID,
    grade_level INTEGER,
    employment_type TEXT CHECK (employment_type IN ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN')),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (logical_id, valid_period, system_period)
);

ALTER TABLE health.positions
    ADD CONSTRAINT positions_valid_period_excl
    EXCLUDE USING GIST (
        logical_id WITH =,
        valid_period WITH &&
    );

CREATE INDEX idx_positions_dept ON health.positions (department_id)
    WHERE health.now_immutable() <@ system_period;

CREATE INDEX idx_positions_head ON health.positions (head_of_department_id)
    WHERE head_of_department_id IS NOT NULL AND health.now_immutable() <@ system_period;

-- ============================================================
-- POSITION_REPORTING_LINES - Bitemporal DAG
-- NOTE: FK to positions removed - enforced at application level due to bitemporal PK
-- ============================================================
CREATE TABLE health.position_reporting_lines (
    logical_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    valid_period TSTZRANGE NOT NULL,
    system_period TSTZRANGE NOT NULL,
    child_position_id UUID NOT NULL,
    parent_position_id UUID NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    reporting_type TEXT CHECK (reporting_type IN ('SOLID', 'DOTTED', 'MENTOR')) DEFAULT 'SOLID',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (logical_id, valid_period, system_period),
    CHECK (child_position_id != parent_position_id)
);

ALTER TABLE health.position_reporting_lines
    ADD CONSTRAINT reporting_line_one_primary
    EXCLUDE USING GIST (
        child_position_id WITH =,
        valid_period WITH &&
    ) WHERE (is_primary);

CREATE INDEX idx_reporting_child ON health.position_reporting_lines (child_position_id)
    WHERE health.now_immutable() <@ system_period;

CREATE INDEX idx_reporting_parent ON health.position_reporting_lines (parent_position_id)
    WHERE health.now_immutable() <@ system_period;

-- ============================================================
-- EMPLOYMENTS - Bitemporal
-- NOTE: FK to positions and persons removed - enforced at application level
-- ============================================================
CREATE TABLE health.employments (
    logical_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    valid_period TSTZRANGE NOT NULL,
    system_period TSTZRANGE NOT NULL,
    person_id UUID NOT NULL,
    position_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'TERMINATED', 'ON_LEAVE', 'SUSPENDED')),
    jurisdiction TEXT NOT NULL DEFAULT 'IN',
    employment_type TEXT CHECK (employment_type IN ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'APPRENTICE')),
    parental_consent_secured BOOLEAN NOT NULL DEFAULT FALSE,
    started_at DATE,
    ended_at DATE,
    termination_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (logical_id, valid_period, system_period)
);

ALTER TABLE health.employments
    ADD CONSTRAINT employments_valid_period_excl
    EXCLUDE USING GIST (
        person_id WITH =,
        valid_period WITH &&
    );

CREATE INDEX idx_employments_current ON health.employments (person_id)
    WHERE health.now_immutable() <@ system_period AND status = 'ACTIVE';

CREATE INDEX idx_employments_position ON health.employments (position_id)
    WHERE health.now_immutable() <@ system_period;

-- ============================================================
-- CAMPUS_AMBASSADORS - Separate from employees
-- ============================================================
CREATE TABLE health.campus_ambassadors (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL, -- REFERENCES health.persons(logical_id) ON DELETE CASCADE (enforced at app level)
    department_id UUID, -- REFERENCES health.departments(logical_id) - enforced at app level
    role TEXT NOT NULL DEFAULT 'CAMPUS_AMBASSADOR',
    start_date DATE NOT NULL,
    end_date DATE,
    parental_consent_secured BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX idx_ambassadors_person ON health.campus_ambassadors (person_id);
CREATE INDEX idx_ambassadors_dept ON health.campus_ambassadors (department_id);

-- ============================================================
-- AUDIT_LOG - Immutable audit trail
-- ============================================================
CREATE TABLE health.audit_log (
    log_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID,
    person_id UUID NOT NULL, -- REFERENCES health.persons(logical_id)
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_person ON health.audit_log (person_id, created_at DESC);
CREATE INDEX idx_audit_log_target ON health.audit_log (target_type, target_id);
CREATE INDEX idx_audit_log_action ON health.audit_log (action);
CREATE INDEX idx_audit_log_created ON health.audit_log (created_at DESC);

-- ============================================================
-- USER_ACCOUNTS - Login mapping only
-- ============================================================
CREATE TABLE health.user_accounts (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL, -- REFERENCES health.persons(logical_id) ON DELETE CASCADE
    idp_subject_id TEXT NOT NULL,
    idp_issuer TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (idp_subject_id, idp_issuer)
);

CREATE INDEX idx_user_accounts_person ON health.user_accounts (person_id);

-- ============================================================
-- ROLES & GRANTS
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_service') THEN
        CREATE ROLE app_service NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'health_service') THEN
        CREATE ROLE health_service NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerbos') THEN
        CREATE ROLE cerbos NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA health TO app_service, health_service, cerbos;

-- app_service: standard CRUD on core tables
GRANT SELECT, INSERT, UPDATE ON health.persons TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.user_accounts TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.departments TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.positions TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.position_reporting_lines TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.employments TO app_service;
GRANT SELECT, INSERT, UPDATE ON health.campus_ambassadors TO app_service;
GRANT SELECT, INSERT ON health.audit_log TO app_service;

-- health_service: subject-scoped health access ONLY
REVOKE ALL ON SCHEMA health FROM health_service;
GRANT USAGE ON SCHEMA health TO health_service;
GRANT SELECT ON health.persons TO health_service;

-- cerbos: policy evaluation
GRANT SELECT ON ALL TABLES IN SCHEMA health TO cerbos;

-- ============================================================
-- COMMENTS
-- ============================================================
COMMENT ON SCHEMA health IS 'EduRankAI HRMS core schema - Phase 1 core entities';
COMMENT ON TABLE health.persons IS 'Immutable human identity - survives employment';
COMMENT ON TABLE health.user_accounts IS 'OIDC login mapping only - no passwords';
COMMENT ON TABLE health.employments IS 'Bitemporal person-position relationship';
COMMENT ON TABLE health.campus_ambassadors IS 'Non-employee campus ambassadors - no employments row';
COMMENT ON TABLE health.audit_log IS 'Immutable audit trail - all actions logged';

COMMENT ON COLUMN health.persons.national_id_hash IS 'SHA-256 hash of national ID';
COMMENT ON COLUMN health.persons.national_id_encrypted IS 'AES-256-GCM encrypted national ID';
COMMENT ON TABLE health.campus_ambassadors IS 'Campus ambassadors are NOT employees - no employments row created';
COMMENT ON COLUMN health.employments.parental_consent_secured IS 'Required for minors - enforced by trigger';
COMMENT ON COLUMN health.employments.jurisdiction IS 'Currently only IN - frozen by test guard';
COMMENT ON TABLE health.positions IS 'Bitemporal position with optional department head reference';
COMMENT ON COLUMN health.positions.head_of_department_id IS 'References person who heads this department';
COMMENT ON TABLE health.position_reporting_lines IS 'DAG of reporting lines - one primary parent enforced';

-- ============================================================
-- END OF MIGRATION 001
-- ============================================================
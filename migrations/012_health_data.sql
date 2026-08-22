-- Migration 012: Health Data Schema (Section 6)
-- Applied: After 011
-- Description: Health data schema - SEPARATE from persons, firewall only (no encryption yet)

-- Create health_data schema
CREATE SCHEMA IF NOT EXISTS health_data;

-- HEALTH_RECORDS - Subject-scoped health data
CREATE TABLE health_data.health_records (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE RESTRICT,
    record_type TEXT NOT NULL CHECK (record_type IN ('MEDICAL', 'DENTAL', 'VISION', 'MENTAL_HEALTH', 'OCCUPATIONAL', 'VACCINATION', 'ALLERGY', 'MEDICATION', 'LAB_RESULT', 'IMAGING', 'OTHER')),
    title TEXT NOT NULL,
    description TEXT,
    record_date DATE NOT NULL,
    provider_name TEXT,
    provider_type TEXT,
    facility_name TEXT,
    attachments JSONB,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_health_records_person ON health_data.health_records (person_id);
CREATE INDEX idx_health_records_type ON health_data.health_records (record_type);
CREATE INDEX idx_health_records_date ON health_data.health_records (record_date DESC);

-- HEALTH_CONSENT - Subject consent for health data access
CREATE TABLE health_data.health_consent (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    consent_type TEXT NOT NULL CHECK (consent_type IN ('ACCESS', 'SHARE', 'RESEARCH', 'EMERGENCY')),
    granted_to UUID REFERENCES health.persons(logical_id),
    scope TEXT[],
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES health.persons(logical_id),
    metadata JSONB,
    UNIQUE (person_id, consent_type, granted_to)
);

CREATE INDEX idx_health_consent_person ON health_data.health_consent (person_id);

-- HEALTH_ACCESS_LOG - Access audit for health data
CREATE TABLE health_data.health_access_log (
    log_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    record_id UUID NOT NULL REFERENCES health_data.health_records(logical_id),
    accessor_id UUID NOT NULL REFERENCES health.persons(logical_id),
    action TEXT NOT NULL CHECK (action IN ('READ', 'CREATE', 'UPDATE', 'DELETE', 'EXPORT')),
    ip_address INET,
    user_agent TEXT,
    purpose TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_health_access_log_record ON health_data.health_access_log (record_id);
CREATE INDEX idx_health_access_log_accessor ON health_data.health_access_log (accessor_id, created_at DESC);

-- GRANTS: health_data schema - ZERO grants to app_service
CREATE ROLE health_data_service NOLOGIN;

GRANT USAGE ON SCHEMA health_data TO health_data_service, cerbos;

GRANT SELECT ON health_data.health_records TO health_data_service;
GRANT SELECT ON health_data.health_consent TO health_data_service;
GRANT SELECT ON health_data.health_access_log TO health_data_service;

GRANT SELECT ON health_data.health_records TO cerbos;
GRANT SELECT ON health_data.health_consent TO cerbos;
GRANT SELECT ON health_data.health_access_log TO cerbos;

-- app_service: NO GRANTS on health_data schema

COMMENT ON SCHEMA health_data IS 'Health data schema - NOT ENCRYPTED. Firewall only via role isolation. Encryption needs cryptographer.';
COMMENT ON TABLE health_data.health_records IS 'Health records - NOT ENCRYPTED. Protected by role isolation only. See Section 6 of master doc.';
COMMENT ON TABLE health_data.health_consent IS 'Consent records for health data access';
COMMENT ON TABLE health_data.health_access_log IS 'Immutable access log for health data';

-- END OF MIGRATION 012
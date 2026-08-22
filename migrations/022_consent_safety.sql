-- Migration 022: Women's Care consent (Phase N) + Field Safety check-ins (Phase Q)
-- Consent is explicit, self-managed, revocable, and audited. NO health data is
-- collected or stored for the women's care domain in this deployment — consent
-- only unlocks access to WHO public resources, never to personal data.
-- Safety check-ins record location ONLY when the employee explicitly sends one;
-- the record is owner-only and append-style.

CREATE TABLE health.consent_preferences (
    person_id UUID PRIMARY KEY REFERENCES health.persons(logical_id),
    domain TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE TABLE health.consent_events (
    event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    domain TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('GRANT', 'REVOKE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE health.safety_checkins (
    checkin_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    latitude DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
    location TEXT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_safety_checkins_person ON health.safety_checkins (person_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE ON health.consent_preferences, health.consent_events,
      health.safety_checkins TO app_service;

-- END OF MIGRATION 022
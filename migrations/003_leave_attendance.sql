-- Migration 003: Leave Requests & Attendance Events (Section 11)
-- Applied: After 002
-- Description: Bitemporal leave requests with bitemporal key; append-only attendance events

-- ============================================================
-- LEAVE_REQUESTS - Bitemporal (Section 11)
-- Key shape: (logical_id, valid_period, system_period) per migration 007
-- Approval status changes over time - history matters for disputes/audits
-- ============================================================
CREATE TABLE health.leave_requests (
    logical_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    valid_period TSTZRANGE NOT NULL,
    system_period TSTZRANGE NOT NULL,
    person_id UUID NOT NULL, -- REFERENCES health.persons(logical_id) ON DELETE RESTRICT (enforced at app level)
    leave_type TEXT NOT NULL CHECK (leave_type IN ('ANNUAL', 'SICK', 'CASUAL', 'PARENTAL', 'BEREAVEMENT', 'MATERNITY', 'PATERNITY', 'UNPAID')),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN')),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_requested INTEGER NOT NULL,
    reason TEXT,
    parental_consent_secured BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by UUID, -- REFERENCES health.persons(logical_id)
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (logical_id, valid_period, system_period),
    CHECK (end_date >= start_date),
    CHECK (days_requested = (end_date - start_date)::INT + 1),
    CONSTRAINT chk_leave_requests_valid_period CHECK (LOWER(valid_period) = start_date AND UPPER(valid_period) = end_date + 1)
);

-- Exclusion constraint: prevent overlapping valid periods for same person
ALTER TABLE health.leave_requests
    ADD CONSTRAINT leave_requests_valid_period_excl
    EXCLUDE USING GIST (
        person_id WITH =,
        valid_period WITH &&
    );

-- Bitemporal index for current leave requests using immutable function
CREATE INDEX idx_leave_requests_current ON health.leave_requests (person_id)
    WHERE health.now_immutable() <@ system_period;

-- Index for leave requests by date range
CREATE INDEX idx_leave_requests_dates ON health.leave_requests (start_date, end_date)
    WHERE health.now_immutable() <@ system_period;

-- Index for pending approvals
CREATE INDEX idx_leave_requests_pending ON health.leave_requests (person_id, status)
    WHERE status = 'PENDING' AND health.now_immutable() <@ system_period;

-- ============================================================
-- ATTENDANCE_EVENTS - Append-only, non-temporal (Section 11)
-- Each clock-in/clock-out is a fact that happened once
-- No valid_period/system_period - pure append-only facts
-- Using lat/lon instead of geography (no PostGIS)
-- ============================================================
CREATE TABLE health.attendance_events (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL, -- REFERENCES health.persons(logical_id) ON DELETE RESTRICT (enforced at app level)
    event_type TEXT NOT NULL CHECK (event_type IN ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END', 'OVERTIME_START', 'OVERTIME_END')),
    occurred_at TIMESTAMPTZ NOT NULL,
    location TEXT,
    device_id TEXT,
    captured_image_path TEXT, -- required for CLOCK_IN per §10
    fingerprint_hash TEXT,
    latitude DOUBLE PRECISION,  -- latitude for geolocation
    longitude DOUBLE PRECISION, -- longitude for geolocation
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for person's attendance chronologically
CREATE INDEX idx_attendance_events_person_time ON health.attendance_events (person_id, occurred_at DESC);

-- Index for date range queries
CREATE INDEX idx_attendance_events_date ON health.attendance_events (occurred_at DESC);

-- Index for device-based queries
CREATE INDEX idx_attendance_events_device ON health.attendance_events (device_id)
    WHERE device_id IS NOT NULL;

-- Index for location-based queries using lat/lon
CREATE INDEX idx_attendance_events_location ON health.attendance_events (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- ============================================================
-- IMMUTABLE wrapper for DATE(occurred_at)
-- ============================================================
CREATE OR REPLACE FUNCTION health.date_of_occurred_at(p_ts TIMESTAMPTZ)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
AS $$ SELECT DATE(p_ts); $$;

-- ============================================================
-- Trigger: Enforce append-only on attendance_events
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_attendance_events_append_only()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'attendance_events is append-only: DELETE is not permitted';
    ELSIF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'attendance_events is append-only: UPDATE is not permitted';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_attendance_events_append_only
BEFORE INSERT OR UPDATE OR DELETE ON health.attendance_events
FOR EACH ROW EXECUTE FUNCTION health.fn_attendance_events_append_only();

-- ============================================================
-- Trigger: Require captured_image_path for CLOCK_IN (Section 10)
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_require_captured_image()
RETURNS trigger AS $$
BEGIN
    IF NEW.event_type = 'CLOCK_IN' AND NEW.captured_image_path IS NULL THEN
        RAISE EXCEPTION 'captured_image_path is required for CLOCK_IN events';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_require_captured_image
BEFORE INSERT ON health.attendance_events
FOR EACH ROW EXECUTE FUNCTION health.fn_require_captured_image();

-- ============================================================
-- Indexes for attendance queries
-- ============================================================
CREATE INDEX idx_attendance_events_person_chronological ON health.attendance_events (person_id, occurred_at);
CREATE INDEX idx_attendance_events_type_time ON health.attendance_events (event_type, occurred_at DESC);
CREATE INDEX idx_attendance_events_daily ON health.attendance_events (person_id, health.date_of_occurred_at(occurred_at));

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- Check leave requests
-- SELECT status, count(*) FROM health.leave_requests GROUP BY status;

-- Check attendance events
-- SELECT event_type, count(*) FROM health.attendance_events GROUP BY event_type;

-- Verify append-only constraint
-- INSERT INTO health.attendance_events (person_id, event_type, occurred_at, captured_image_path)
-- VALUES (gen_random_uuid(), 'CLOCK_IN', NOW(), '/test.jpg');
-- UPDATE health.attendance_events SET location = 'New' WHERE logical_id = ...; -- Should fail
-- DELETE FROM health.attendance_events WHERE logical_id = ...; -- Should fail

-- ============================================================
-- END OF MIGRATION 003
-- ============================================================
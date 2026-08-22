-- Migration 016: HumanOS Core — Event Fabric + Scheduler
-- Description: Domain event persistence + operational scheduler jobs.
-- No runtime DDL; all schema changes are versioned here.

-- ============================================================
-- EVENTS — domain event fabric (persist → consume → retry → audit)
-- ============================================================
CREATE TABLE health.events (
    event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type TEXT NOT NULL,
    event_version INT NOT NULL DEFAULT 1,
    source TEXT NOT NULL,
    actor_person_id UUID REFERENCES health.persons(logical_id),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    correlation_id UUID,
    causation_id UUID,
    idempotency_key UUID NOT NULL DEFAULT uuid_generate_v4(),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    processing_state TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (processing_state IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD_LETTER')),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_events_idempotency ON health.events (event_type, idempotency_key);
CREATE INDEX idx_events_type_state ON health.events (event_type, processing_state);
CREATE INDEX idx_events_actor ON health.events (actor_person_id, occurred_at DESC);
CREATE INDEX idx_events_occurred ON health.events (occurred_at DESC);

-- ============================================================
-- SCHEDULER_JOBS — operational scheduler registry
-- ============================================================
CREATE TABLE health.scheduler_jobs (
    job_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_name TEXT NOT NULL UNIQUE,
    schedule_cron TEXT NOT NULL DEFAULT '0 * * * *',
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    last_status TEXT CHECK (last_status IN ('NEVER_RUN', 'RUNNING', 'SUCCESSFUL', 'FAILED', 'DEGRADED', 'BLOCKED')),
    last_result JSONB,
    last_error TEXT,
    runs_count INT NOT NULL DEFAULT 0,
    success_count INT NOT NULL DEFAULT 0,
    failure_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed job registry (idempotent)
INSERT INTO health.scheduler_jobs (job_name, schedule_cron, description, last_status)
VALUES
    ('leave_upcoming_reminder', '0 6 * * *', 'Notify employees of approved leave starting within 48 hours', 'NEVER_RUN'),
    ('reconcile_leave_attendance', '30 2 * * *', 'Detect attendance events during approved leave and raise open items', 'NEVER_RUN')
ON CONFLICT (job_name) DO NOTHING;

-- ============================================================
-- OBSERVABILITY VIEW — event/job health in one place
-- ============================================================
CREATE OR REPLACE VIEW health.observability_state AS
SELECT
    (SELECT count(*) FROM health.events) AS events_total,
    (SELECT count(*) FROM health.events WHERE processing_state = 'PENDING') AS events_pending,
    (SELECT count(*) FROM health.events WHERE processing_state = 'FAILED') AS events_failed,
    (SELECT count(*) FROM health.events WHERE processing_state = 'DEAD_LETTER') AS events_dead_letter,
    (SELECT count(*) FROM health.audit_log) AS audit_total,
    (SELECT count(*) FROM health.audit_log WHERE created_at::date = CURRENT_DATE) AS audit_today,
    (SELECT count(*) FROM health.scheduler_jobs WHERE last_status = 'NEVER_RUN' OR last_status IS NULL) AS jobs_never_run,
    (SELECT count(*) FROM health.scheduler_jobs WHERE last_status = 'FAILED') AS jobs_failed,
    (SELECT count(*) FROM health.scheduler_jobs WHERE last_status = 'RUNNING') AS jobs_running,
    (SELECT count(*) FROM health.open_items WHERE status NOT IN ('RESOLVED', 'CLOSED')) AS open_items_open;

GRANT SELECT ON health.observability_state TO app_service, cerbos;

COMMENT ON TABLE health.events IS 'Domain event fabric. Every event persists before processing; retries and dead-letter are tracked per event.';
COMMENT ON TABLE health.scheduler_jobs IS 'Operational scheduler registry. NEVER_RUN is distinct from overdue.';

-- END OF MIGRATION 016
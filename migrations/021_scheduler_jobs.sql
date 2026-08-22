-- Migration 021: register scheduler job definitions (Phase S/Y)
-- The scheduler loop executes every enabled job; these rows carry schedule
-- metadata and run history.

INSERT INTO health.scheduler_jobs (job_name, schedule_cron, description, enabled)
VALUES
    ('leave_upcoming_reminder', '0 6 * * *', 'Notify employees of approved leave starting within 48 hours', TRUE),
    ('reconcile_leave_attendance', '30 2 * * *', 'Detect attendance events during approved leave and raise open items', TRUE),
    ('cert_expiry_reminder', '0 7 * * *', 'Notify employees of certifications expiring within 30 days', TRUE),
    ('monthly_payroll_run', '0 3 1 * *', 'Create and compute the previous month payroll run (approval and payment stay manual)', TRUE)
ON CONFLICT (job_name) DO UPDATE
    SET schedule_cron = EXCLUDED.schedule_cron,
        description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        updated_at = NOW();

-- END OF MIGRATION 021
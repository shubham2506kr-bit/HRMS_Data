import { config } from '../config/index.js';
import { query } from '../db/pool.js';
import { writeAudit } from './audit.js';
import { emitEvent } from './events.js';
import { runAsSystem } from './requestContext.js';
import { runJob, type JobDefinition } from './scheduler.js';

/**
 * Jobs act on people without a request context, so nothing else attributes what
 * they did. Each mutation below records an audit row against the person whose
 * record was touched, with the acting job named in `details.actor`.
 *
 * NOTE: health.audit_log.person_id is NOT NULL and there is no system-actor
 * person, so a job that mutates no single person's record (monthly_payroll_run)
 * cannot write an audit row at all. That gap is reported, not papered over.
 */
const SCHEDULER_ACTOR = 'scheduler';

/** Format a DATE column (returned as a Date at local midnight) as YYYY-MM-DD in the DB's local zone. */
function formatDbDate(value: Date): string {
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Notify employees of approved leave starting within 48 hours.
 * Deduplicated per leave request; emits LeaveApproaching events.
 */
const leaveUpcomingReminder: JobDefinition = {
  name: 'leave_upcoming_reminder',
  description: 'Notify employees of approved leave starting within 48 hours',
  run: async () => {
    const result = await query(
      `SELECT lr.logical_id, lr.person_id, lr.leave_type, lr.start_date, lr.end_date, lr.days_requested,
              p.preferred_name
       FROM health.leave_requests lr
       JOIN health.persons p ON p.logical_id = lr.person_id
       WHERE lr.status = 'APPROVED'
         AND lr.start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '2 days'
         AND NOT EXISTS (
           SELECT 1 FROM health.notifications n
           WHERE n.recipient_id = lr.person_id
             AND n.metadata->>'kind' = 'leave_reminder'
             AND n.metadata->>'leave_request_id' = lr.logical_id::text
         )`
    );

    let notified = 0;
    for (const row of result.rows) {
      await query(
        `INSERT INTO health.notifications (recipient_id, type, title, message, action_url, priority, metadata)
         VALUES ($1, 'INFO',
                 'Leave starts ' || to_char($2::date, 'Day') || ' ' || to_char($2::date, 'DD Mon'),
                 $3, '/leave', 'NORMAL',
                 jsonb_build_object('leave_request_id', $4::text, 'kind', 'leave_reminder'))`,
        [
          row.person_id,
          row.start_date,
          `${row.leave_type} approved: ${row.days_requested} day(s) from ${formatDbDate(row.start_date)} to ${formatDbDate(row.end_date)}.`,
          row.logical_id,
        ]
      );
      await emitEvent({
        type: 'LeaveApproaching',
        source: 'scheduler:leave_upcoming_reminder',
        actorPersonId: row.person_id,
        payload: { leave_request_id: row.logical_id, start_date: formatDbDate(row.start_date) },
      });
      await writeAudit({
        personId: row.person_id,
        action: 'LEAVE_REMINDER_NOTIFIED',
        targetType: 'leave_request',
        targetId: row.logical_id,
        details: { actor: `${SCHEDULER_ACTOR}:leave_upcoming_reminder`, leave_type: row.leave_type },
      });
      notified++;
    }

    return { status: 'SUCCESSFUL', result: { notified } };
  },
};

/**
 * Raise open items when attendance events occur on days covered by
 * approved leave for the same person (integrity reconciliation).
 */
const reconcileLeaveAttendance: JobDefinition = {
  name: 'reconcile_leave_attendance',
  description: 'Detect attendance events during approved leave and raise open items',
  run: async () => {
    const result = await query(
      `SELECT DISTINCT lr.person_id, lr.logical_id AS leave_id, ae.event_type,
              date_trunc('day', ae.occurred_at)::date AS event_date
       FROM health.leave_requests lr
       JOIN health.attendance_events ae ON ae.person_id = lr.person_id
       WHERE lr.status = 'APPROVED'
         AND date_trunc('day', ae.occurred_at)::date BETWEEN lr.start_date AND lr.end_date
         AND NOT EXISTS (
           SELECT 1 FROM health.open_items oi
           WHERE oi.item_id = 'leave-attendance-' || lr.person_id || '-' || date_trunc('day', ae.occurred_at)::date
         )`
    );

    let raised = 0;
    for (const row of result.rows) {
      const itemId = `leave-attendance-${row.person_id}-${formatDbDate(row.event_date)}`;
      await query(
        `INSERT INTO health.open_items (item_id, title, description, status, priority, owner, blocker)
         VALUES ($1, 'Attendance during approved leave', $2, 'IN_PROGRESS', 'MEDIUM', $3,
                 'Reconciliation: attendance recorded while leave approved')
         ON CONFLICT (item_id) DO NOTHING`,
        [
          itemId,
          `${row.event_type} recorded on ${formatDbDate(row.event_date)} while leave was approved. Verify intent before payroll impact.`,
          row.person_id,
        ]
      );
      await emitEvent({
        type: 'ReconciliationExceptionRaised',
        source: 'scheduler:reconcile_leave_attendance',
        actorPersonId: row.person_id,
        payload: { item_id: itemId, leave_request_id: row.leave_id },
      });
      await writeAudit({
        personId: row.person_id,
        action: 'RECONCILIATION_EXCEPTION_RAISED',
        targetType: 'open_item',
        targetId: row.leave_id,
        details: { actor: `${SCHEDULER_ACTOR}:reconcile_leave_attendance`, item_id: itemId },
      });
      raised++;
    }

    return { status: 'SUCCESSFUL', result: { anomalies_raised: raised } };
  },
};

/**
 * Remind people that a certification they hold expires within 30 days.
 * Deduplicated per certification; emits CertificationExpiring events.
 */
const certExpiryReminder: JobDefinition = {
  name: 'cert_expiry_reminder',
  description: 'Notify employees of certifications expiring within 30 days',
  run: async () => {
    const result = await query(
      `SELECT c.cert_id, c.person_id, c.name, c.expires_on
       FROM health.certifications c
       WHERE c.expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
         AND c.system_period @> NOW()
         AND NOT EXISTS (
           SELECT 1 FROM health.notifications n
           WHERE n.recipient_id = c.person_id
             AND n.metadata->>'kind' = 'cert_expiry'
             AND n.metadata->>'cert_id' = c.cert_id::text
         )`
    );

    let notified = 0;
    for (const row of result.rows) {
      await query(
        `INSERT INTO health.notifications (recipient_id, type, title, message, action_url, priority, metadata)
         VALUES ($1, 'WARNING',
                 'Certification expiring',
                 $2, '/growth', 'NORMAL',
                 jsonb_build_object('cert_id', $3::text, 'kind', 'cert_expiry'))`,
        [row.person_id, `${row.name} expires on ${formatDbDate(row.expires_on)}. Plan a renewal before the date.`, row.cert_id]
      );
      await emitEvent({
        type: 'CertificationExpiring',
        source: 'scheduler:cert_expiry_reminder',
        actorPersonId: row.person_id,
        payload: { cert_id: row.cert_id, name: row.name, expires_on: formatDbDate(row.expires_on) },
      });
      await writeAudit({
        personId: row.person_id,
        action: 'CERT_EXPIRY_NOTIFIED',
        targetType: 'certification',
        targetId: row.cert_id,
        details: { actor: `${SCHEDULER_ACTOR}:cert_expiry_reminder`, expires_on: formatDbDate(row.expires_on) },
      });
      notified++;
    }

    return { status: 'SUCCESSFUL', result: { notified } };
  },
};

/**
 * Monthly payroll run: compute the previous month's run automatically.
 * Creation + computation only — approval and payment remain human steps,
 * because moving money must never happen without a person signing off.
 * Self-guarding: the run is only created when the period has no run yet.
 */
const monthlyPayrollRun: JobDefinition = {
  name: 'monthly_payroll_run',
  description: 'Create and compute the previous month payroll run (approval and payment stay manual)',
  run: async () => {
    const result = await query(
      `WITH period AS (
         SELECT date_trunc('month', CURRENT_DATE - INTERVAL '1 month')::date AS p_start,
                (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date AS p_end
       ),
       created AS (
         INSERT INTO health.payroll_runs (period_start, period_end, status)
         SELECT p_start, p_end, 'DRAFT' FROM period
         ON CONFLICT (period_start, period_end) DO NOTHING
         RETURNING run_id, period_start, period_end
       )
       SELECT run_id, period_start, period_end FROM created`
    );

    if (result.rows.length === 0) {
      return { status: 'SUCCESSFUL', result: { period_exists: true, computed: false } };
    }

    const row = result.rows[0];
    if (!row) {
      return { status: 'SUCCESSFUL', result: { period_exists: true, computed: false } };
    }
    const computed = await query<{ count: number | null }>('SELECT health.fn_payroll_compute($1) AS count', [row.run_id]);
    const entries = computed.rows[0]?.count ?? 0;
    await query(
      `UPDATE health.payroll_runs SET status = 'COMPUTED', updated_at = NOW() WHERE run_id = $1`,
      [row.run_id]
    );
    await emitEvent({
      type: 'PayrollCalculated',
      source: 'scheduler:monthly_payroll_run',
      payload: {
        run_id: row.run_id,
        period_start: formatDbDate(row.period_start),
        period_end: formatDbDate(row.period_end),
        entries,
      },
    });
    // No audit row: health.audit_log.person_id is NOT NULL and this run belongs to
    // no single person. The PayrollCalculated event is the only record. Approval and
    // payment remain human steps and MUST write audit rows in the payroll module.
    return { status: 'SUCCESSFUL', result: { period_exists: false, computed: entries } };
  },
};

/**
 * Retention for the audit trail: copy rows older than AUDIT_LOG_RETENTION_DAYS
 * into health.audit_log_archive. Archive only — deleting audit rows breaks the
 * hash chain, so the purge half of retention is an operator tool
 * (health.fn_audit_retention_purge) that is deliberately not granted to the
 * application role. See migrations/039_audit_chain.sql.
 */
const auditRetentionArchive: JobDefinition = {
  name: 'audit_retention_archive',
  description: 'Archive audit rows older than AUDIT_LOG_RETENTION_DAYS (archive only, never deletes)',
  run: async () => {
    const res = await query<{ rows_archived: string | number | null }>(
      'SELECT rows_archived FROM health.fn_audit_retention_archive($1)',
      [config.AUDIT_LOG_RETENTION_DAYS]
    );
    return {
      status: 'SUCCESSFUL',
      result: {
        rows_archived: Number(res.rows[0]?.rows_archived ?? 0),
        retention_days: config.AUDIT_LOG_RETENTION_DAYS,
      },
    };
  },
};

export const jobs: JobDefinition[] = [
  leaveUpcomingReminder,
  reconcileLeaveAttendance,
  certExpiryReminder,
  monthlyPayrollRun,
  auditRetentionArchive,
];

/**
 * Run every registered job that is enabled and due (used by the scheduler loop,
 * which ticks far more often than any job's schedule). Jobs run one at a time and
 * `runJob` records its own failures, so one failing job cannot stop the others.
 *
 * The whole pass runs under `runAsSystem`: there is deliberately no acting person
 * behind a scheduled job, and every query it makes is unscoped by design.
 */
export async function runAllJobs(): Promise<void> {
  return runAsSystem(async () => {
    for (const job of jobs) {
      await runJob(job);
    }
  });
}
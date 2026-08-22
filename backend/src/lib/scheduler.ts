import { query } from '../db/pool.js';
import { runAsSystem } from './requestContext.js';

export interface JobDefinition {
  name: string;
  description: string;
  run: () => Promise<{ status: 'SUCCESSFUL' | 'DEGRADED'; result?: Record<string, unknown> }>;
}

export interface RunJobOptions {
  /** Run even if the cron schedule says the job is not due (manual trigger). `enabled` is still honoured. */
  force?: boolean;
}

// ============================================================
// cron evaluation
//
// The scheduler loop ticks every minute. Without this, every job ran on every
// tick — the registered schedule_cron was decoration only, so a job documented
// as "0 6 * * *" executed 1440 times a day and the monthly payroll job was
// re-entered every minute, relying entirely on ON CONFLICT to stay harmless.
//
// A job is due when its most recent scheduled occurrence is later than its
// last_run_at. That gives catch-up semantics: a process that was down at 06:00
// runs the job once when it comes back, instead of skipping the day or running
// it continuously.
//
// Cron fields are evaluated in the *server's* local timezone, as unix cron does.
// See the report: the process should be started with TZ set to config.ORG_TIMEZONE.
// ============================================================

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const token = part.trim();
    if (token === '') return null;
    const [rangePart, stepPart] = token.split('/');
    if (rangePart === undefined) return null;
    let step = 1;
    if (stepPart !== undefined) {
      step = Number.parseInt(stepPart, 10);
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2) return null;
      from = Number.parseInt(bounds[0] ?? '', 10);
      to = Number.parseInt(bounds[1] ?? '', 10);
    } else {
      from = Number.parseInt(rangePart, 10);
      to = from;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

/** Parse a 5-field cron expression. Returns null when the expression is not understood. */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  const minute = parseField(minuteF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const month = parseField(monthF, 1, 12);
  const dowRaw = parseField(dowF, 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  // Cron allows both 0 and 7 for Sunday.
  const dow = new Set<number>();
  for (const d of dowRaw) dow.add(d === 7 ? 0 : d);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: domF.trim() !== '*',
    dowRestricted: dowF.trim() !== '*',
  };
}

function matchesDay(spec: CronSpec, day: Date): boolean {
  if (!spec.month.has(day.getMonth() + 1)) return false;
  const domHit = spec.dom.has(day.getDate());
  const dowHit = spec.dow.has(day.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/** The latest scheduled occurrence at or before `from`, searching back at most 400 days. */
export function previousOccurrence(spec: CronSpec, from: Date): Date | null {
  const anchor = new Date(from.getTime());
  anchor.setSeconds(0, 0);
  for (let dayOffset = 0; dayOffset <= 400; dayOffset++) {
    const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - dayOffset);
    if (!matchesDay(spec, day)) continue;
    const startHour = dayOffset === 0 ? anchor.getHours() : 23;
    for (let h = startHour; h >= 0; h--) {
      if (!spec.hour.has(h)) continue;
      const startMinute = dayOffset === 0 && h === anchor.getHours() ? anchor.getMinutes() : 59;
      for (let m = startMinute; m >= 0; m--) {
        if (!spec.minute.has(m)) continue;
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
      }
    }
  }
  return null;
}

/** Fallback minimum spacing when schedule_cron cannot be parsed: never faster than hourly. */
const UNPARSEABLE_CRON_MIN_INTERVAL_MS = 60 * 60 * 1000;

const warnedCron = new Set<string>();

function isDue(jobName: string, cron: string, lastRunAt: Date | null, now: Date): boolean {
  if (lastRunAt === null) return true;
  const spec = parseCron(cron);
  if (!spec) {
    if (!warnedCron.has(jobName)) {
      warnedCron.add(jobName);
      console.error(
        '[SCHEDULER]',
        JSON.stringify({
          job: jobName,
          problem: 'unparseable schedule_cron',
          schedule_cron: cron,
          fallback: 'hourly',
        })
      );
    }
    return now.getTime() - lastRunAt.getTime() >= UNPARSEABLE_CRON_MIN_INTERVAL_MS;
  }
  const occurrence = previousOccurrence(spec, now);
  if (occurrence === null) return false;
  return lastRunAt.getTime() < occurrence.getTime();
}

// ============================================================
// job execution
// ============================================================

interface SchedulerJobRow {
  job_name: string;
  schedule_cron: string;
  enabled: boolean;
  last_run_at: Date | null;
  last_status: string | null;
}

/** In-process guard: a tick must never re-enter a job that is still running here. */
const inFlight = new Set<string>();

async function readJobRow(job: JobDefinition): Promise<SchedulerJobRow | null> {
  const existing = await query<SchedulerJobRow>(
    `SELECT job_name, schedule_cron, enabled, last_run_at, last_status
       FROM health.scheduler_jobs WHERE job_name = $1`,
    [job.name]
  );
  const row = existing.rows[0];
  if (row) return row;

  // Self-heal rather than wedge: an unregistered job is an operational gap, not
  // a reason to stop auditing or running it. Register it and report loudly.
  console.error(
    '[SCHEDULER]',
    JSON.stringify({ job: job.name, problem: 'job not registered in health.scheduler_jobs', action: 'registering' })
  );
  await query(
    `INSERT INTO health.scheduler_jobs (job_name, schedule_cron, description, enabled, last_status)
     VALUES ($1, '0 * * * *', $2, TRUE, 'NEVER_RUN')
     ON CONFLICT (job_name) DO NOTHING`,
    [job.name, job.description]
  );
  const reread = await query<SchedulerJobRow>(
    `SELECT job_name, schedule_cron, enabled, last_run_at, last_status
       FROM health.scheduler_jobs WHERE job_name = $1`,
    [job.name]
  );
  return reread.rows[0] ?? null;
}

/**
 * Run a job if it is enabled and due, recording the outcome.
 *
 * Claiming is a compare-and-set on last_run_at, so two processes ticking at the
 * same second cannot both run the same job. NEVER_RUN is preserved until a job
 * first executes; it is not "overdue".
 *
 * Every query here runs inside `runAsSystem`: background work has no request
 * context, so the row-level-security settings the pool sets per request are
 * absent by design. The scheduler's database role must therefore be permitted
 * to see these tables (BYPASSRLS or explicit policies) — see the report.
 */
export async function runJob(job: JobDefinition, options?: RunJobOptions): Promise<void> {
  if (inFlight.has(job.name)) {
    console.warn('[SCHEDULER]', JSON.stringify({ job: job.name, skipped: 'still running in this process' }));
    return;
  }

  return runAsSystem(async () => {
    let claimed = false;
    try {
      const row = await readJobRow(job);
      if (!row) {
        console.error('[SCHEDULER]', JSON.stringify({ job: job.name, problem: 'could not register or read job row' }));
        return;
      }
      if (!row.enabled) return;

      const now = new Date();
      const lastRunAt = row.last_run_at === null ? null : new Date(row.last_run_at);
      if (options?.force !== true && !isDue(job.name, row.schedule_cron, lastRunAt, now)) return;

      const claim = await query<{ job_id: string }>(
        `UPDATE health.scheduler_jobs
            SET last_status = 'RUNNING', last_run_at = NOW(), updated_at = NOW()
          WHERE job_name = $1
            AND enabled
            AND last_run_at IS NOT DISTINCT FROM $2::timestamptz
          RETURNING job_id`,
        [job.name, row.last_run_at]
      );
      if (claim.rows.length === 0) {
        // Another process (or another tick) claimed it first.
        return;
      }
      claimed = true;
      inFlight.add(job.name);

      const outcome = await job.run();

      await query(
        `UPDATE health.scheduler_jobs
         SET last_status = $2, last_result = $3, last_error = NULL,
             runs_count = runs_count + 1,
             success_count = success_count + CASE WHEN $2 = 'SUCCESSFUL' THEN 1 ELSE 0 END,
             updated_at = NOW()
         WHERE job_name = $1`,
        [job.name, outcome.status, JSON.stringify(outcome.result ?? {})]
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[JOB-FAILURE]', JSON.stringify({ job: job.name, error: message }));
      if (claimed) {
        await query(
          `UPDATE health.scheduler_jobs
           SET last_status = 'FAILED', last_error = $2,
               runs_count = runs_count + 1, failure_count = failure_count + 1, updated_at = NOW()
           WHERE job_name = $1`,
          [job.name, message.slice(0, 2000)]
        ).catch((e: unknown) =>
          console.error('[JOB-FAILURE] status write failed:', e instanceof Error ? e.message : String(e))
        );
      }
    } finally {
      inFlight.delete(job.name);
    }
  });
}

/**
 * Mark all jobs not yet run as BLOCKED when the scheduler cannot start.
 */
export async function markJobsBlocked(reason: string): Promise<void> {
  return runAsSystem(async () => {
    await query(
      `UPDATE health.scheduler_jobs
       SET last_status = 'BLOCKED', last_error = $1, updated_at = NOW()
       WHERE last_status IS NULL OR last_status = 'NEVER_RUN'`,
      [reason.slice(0, 2000)]
    ).catch((e: unknown) =>
      console.error('[JOB-FAILURE] blocked marker failed:', e instanceof Error ? e.message : String(e))
    );
  });
}

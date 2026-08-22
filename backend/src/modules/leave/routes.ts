import { FastifyInstance, FastifyReply } from 'fastify';
import { query, getClient } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { personRelationship, isPrivileged, canActOnBehalfOf } from '../../lib/access.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { config } from '../../config/index.js';
import { z } from 'zod';

/**
 * Leave module.
 *
 * Working-day convention (load-bearing — payroll's loss-of-pay reads
 * days_requested): days_requested is the number of Mon–Fri calendar days in
 * [start_date, end_date] minus non-optional holidays in
 * health.holiday_calendar. It is computed by health.fn_working_days() from DATE
 * values only, so it cannot drift with DST, the server timezone or the
 * submitter's clock. It is never a wall-clock duration.
 *
 * Balance: health.fn_leave_balance() (migration 032) returns entitlement minus
 * APPROVED minus PENDING working days for the leave year containing the
 * request's start date. Counting PENDING means ten overlapping submissions
 * cannot oversubscribe an entitlement, and REJECTED/CANCELLED rows release
 * both the balance and the dates automatically.
 */

const LEAVE_TYPES = [
  'ANNUAL', 'SICK', 'CASUAL', 'PARENTAL', 'BEREAVEMENT', 'MATERNITY', 'PATERNITY', 'UNPAID',
] as const;

/** Leave types whose name alone discloses health or family circumstances. */
const SENSITIVE_TYPES: readonly string[] = [
  'SICK', 'MATERNITY', 'PATERNITY', 'PARENTAL', 'BEREAVEMENT', 'UNPAID',
];

/** Holiday calendar jurisdiction. Single-jurisdiction org for now. */
const HOLIDAY_JURISDICTION = 'IN';

/** A single request may not span more than a year of calendar days. */
const MAX_CALENDAR_SPAN_DAYS = 366;
/** Backdating window: timesheet corrections, not history rewrites. */
const MAX_BACKDATE_DAYS = 365;
/** Forward window: one leave year plus a planning margin. */
const MAX_FORWARD_DAYS = 550;
const MAX_FREE_TEXT = 2000;

// ---------------------------------------------------------------------------
// Row shapes. Declared as type aliases (not interfaces) so they satisfy pg's
// QueryResultRow index-signature constraint.
// ---------------------------------------------------------------------------

type LeaveRecord = {
  logical_id: string;
  person_id: string;
  leave_type: string;
  status: string;
  start_date: string;
  end_date: string;
  days_requested: number;
  reason: string | null;
  rejection_reason: string | null;
  parental_consent_secured: boolean;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type LeaveRecordWithName = {
  logical_id: string;
  person_id: string;
  person_name: string | null;
  leave_type: string;
  status: string;
  start_date: string;
  end_date: string;
  days_requested: number;
  reason: string | null;
  rejection_reason: string | null;
  parental_consent_secured: boolean;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type LeaveRosterRow = {
  logical_id: string;
  person_id: string;
  person_name: string | null;
  leave_type: string;
  status: string;
  start_date: string;
  end_date: string;
  days_requested: number;
  created_at: string;
};

type BalanceRow = {
  leave_type: string;
  total_entitled: number;
  total_used: number;
  balance: number;
  pending_approval: number;
};

type RequestContextRow = {
  today: string;
  working_days: number;
  calendar_days: number;
  start_offset_days: number;
  is_minor: boolean;
  person_exists: boolean;
};

// ---------------------------------------------------------------------------
// Explicit column allowlists. Nothing in this file uses `SELECT lr.*` or spreads
// a database row: every field that leaves the process is named here on purpose.
// DATEs are cast to text so the wire format is an unambiguous 'YYYY-MM-DD'
// instead of an instant that shifts a day either side of midnight.
// ---------------------------------------------------------------------------

/** Full record. For the subject themselves and for their approval chain. */
const RECORD_COLUMNS = `
      lr.logical_id,
      lr.person_id,
      lr.leave_type,
      lr.status,
      lr.start_date::text AS start_date,
      lr.end_date::text AS end_date,
      lr.days_requested,
      lr.reason,
      lr.rejection_reason,
      lr.parental_consent_secured,
      lr.approved_by,
      lr.approved_at,
      lr.created_at,
      lr.updated_at`;

/**
 * Roster projection for the team/planning view. Deliberately does not select
 * reason, rejection_reason, approved_by or parental_consent_secured:
 *  - reason and rejection_reason are free text that routinely carries medical
 *    and personal detail;
 *  - parental_consent_secured discloses that the subject is a minor.
 * Absent from the query means it cannot leak, whatever the response builder does.
 */
const ROSTER_COLUMNS = `
      lr.logical_id,
      lr.person_id,
      p.preferred_name AS person_name,
      lr.leave_type,
      lr.status,
      lr.start_date::text AS start_date,
      lr.end_date::text AS end_date,
      lr.days_requested,
      lr.created_at`;

// ---------------------------------------------------------------------------
// Validation schemas. Every body, query and param in this module is parsed with
// safeParse: the global error handler maps only Fastify's own `error.validation`
// to 400, so an unhandled ZodError would surface as a 500.
// ---------------------------------------------------------------------------

const idParamsSchema = z.object({
  id: z.string().uuid('id must be a UUID'),
});

const listQuerySchema = z.object({
  scope: z.enum(['mine', 'team']).default('mine'),
});

const createBodySchema = z
  .object({
    leave_type: z.enum(LEAVE_TYPES),
    start_date: z.string().date(),
    end_date: z.string().date(),
    reason: z.string().trim().max(MAX_FREE_TEXT).optional(),
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: 'end_date must be on or after start_date',
    path: ['end_date'],
  });

const rejectBodySchema = z.object({
  rejection_reason: z.string().trim().min(1, 'A rejection reason is required').max(MAX_FREE_TEXT),
});

const cancelBodySchema = z.object({
  reason: z.string().trim().max(MAX_FREE_TEXT).optional(),
});

const balanceQuerySchema = z.object({
  as_of: z.string().date().optional(),
});

function invalid(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Request failed validation',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

/** Narrow a thrown value to a PostgreSQL SQLSTATE without reaching for `any`. */
function sqlState(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** PostgreSQL exclusion_violation: another live request already covers these dates. */
const EXCLUSION_VIOLATION = '23P01';

export async function leaveRoutes(app: FastifyInstance) {
  /**
   * Audit is fail-closed for state changes: if the audit write fails we undo the
   * transition rather than leave an unrecorded approval standing. The revert is
   * itself guarded so it cannot clobber a concurrent change.
   */
  async function revertToPending(logicalId: string, fromStatus: string): Promise<boolean> {
    try {
      const result = await query(
        `UPDATE health.leave_requests
            SET status = 'PENDING',
                approved_by = NULL,
                approved_at = NULL,
                rejection_reason = NULL,
                updated_at = NOW()
          WHERE logical_id = $1
            AND status = $2
            AND system_period @> NOW()`,
        [logicalId, fromStatus]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      console.error('[LEAVE] compensating revert failed', logicalId, fromStatus, error);
      return false;
    }
  }

  async function auditOrRevert(
    reply: FastifyReply,
    logicalId: string,
    fromStatus: string,
    entry: Parameters<typeof writeAudit>[0]
  ): Promise<FastifyReply | null> {
    const recorded = await writeAudit(entry);
    if (recorded) return null;

    const reverted = await revertToPending(logicalId, fromStatus);
    return reply.code(503).send({
      error: 'Audit Unavailable',
      message: reverted
        ? 'The action was reverted because it could not be recorded in the audit log. Try again.'
        : 'The action could not be recorded in the audit log and could not be reverted. Escalate to an administrator.',
    });
  }

  // -------------------------------------------------------------------------
  // List leave requests: scope=mine (own records) or scope=team (roster).
  // -------------------------------------------------------------------------
  app.get('/api/leave-requests', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedQuery = listQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) return invalid(reply, parsedQuery.error);

      const actorPersonId = request.user!.personId;
      const privileged = isPrivileged(request.user!.roles);

      if (parsedQuery.data.scope === 'team') {
        const teamSql = privileged
          ? `SELECT ${ROSTER_COLUMNS}
               FROM health.leave_requests lr
               JOIN health.persons p ON p.logical_id = lr.person_id
              WHERE lr.system_period @> NOW()
              ORDER BY lr.created_at DESC`
          : `SELECT ${ROSTER_COLUMNS}
               FROM health.leave_requests lr
               JOIN health.persons p ON p.logical_id = lr.person_id
               JOIN health.employments e ON e.person_id = lr.person_id
                    AND e.status = 'ACTIVE' AND e.system_period @> NOW()
               JOIN health.positions pos ON pos.logical_id = e.position_id
                    AND pos.system_period @> NOW()
              WHERE pos.department_id IN (
                      SELECT department_id FROM health.positions
                       WHERE head_of_department_id = $1 AND system_period @> NOW()
                    )
                AND lr.system_period @> NOW()
              ORDER BY lr.created_at DESC`;

        const result = await query<LeaveRosterRow>(teamSql, privileged ? [] : [actorPersonId]);

        // Explicit projection, field by field. No row spread: a spread would
        // reintroduce every column the roster query is careful not to expose.
        return result.rows.map((row) => ({
          logical_id: row.logical_id,
          person_id: row.person_id,
          person_name: row.person_name,
          leave_type: SENSITIVE_TYPES.includes(row.leave_type) ? 'AWAY' : row.leave_type,
          status: row.status,
          start_date: row.start_date,
          end_date: row.end_date,
          days_requested: row.days_requested,
          created_at: row.created_at,
          // Pinned null so the response shape stays stable for existing clients
          // while guaranteeing no free text crosses the boundary.
          reason: null,
          rejection_reason: null,
        }));
      }

      const result = await query<LeaveRecordWithName>(
        `SELECT ${RECORD_COLUMNS}, p.preferred_name AS person_name
           FROM health.leave_requests lr
           JOIN health.persons p ON p.logical_id = lr.person_id
          WHERE lr.person_id = $1 AND lr.system_period @> NOW()
          ORDER BY lr.created_at DESC`,
        [actorPersonId]
      );

      return result.rows;
    },
  });

  // -------------------------------------------------------------------------
  // Own leave balances, one row per leave type.
  // -------------------------------------------------------------------------
  app.get('/api/leave-balances', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedQuery = balanceQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) return invalid(reply, parsedQuery.error);

      const asOf = parsedQuery.data.as_of ?? null;

      const result = await query<BalanceRow>(
        `SELECT b.leave_type, b.total_entitled, b.total_used, b.balance, b.pending_approval
           FROM unnest($2::text[]) AS t(leave_type)
           CROSS JOIN LATERAL health.fn_leave_balance(
             $1, t.leave_type, COALESCE($3::date, (NOW() AT TIME ZONE $4)::date)
           ) b
          ORDER BY t.leave_type`,
        [request.user!.personId, [...LEAVE_TYPES], asOf, config.ORG_TIMEZONE]
      );

      return { as_of: asOf, unit: 'working_days', balances: result.rows };
    },
  });

  // -------------------------------------------------------------------------
  // Single leave request — owner, their approval chain, or a privileged role.
  // -------------------------------------------------------------------------
  app.get('/api/leave-requests/:id', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) return invalid(reply, parsedParams.error);

      const result = await query<LeaveRecordWithName>(
        `SELECT ${RECORD_COLUMNS}, p.preferred_name AS person_name
           FROM health.leave_requests lr
           JOIN health.persons p ON p.logical_id = lr.person_id
          WHERE lr.logical_id = $1 AND lr.system_period @> NOW()`,
        [parsedParams.data.id]
      );

      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ error: 'Leave request not found' });
      }

      const relationship = await personRelationship(request.user!.personId, row.person_id);
      if (relationship === 'NONE' && !isPrivileged(request.user!.roles)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'You may only view your own leave requests',
        });
      }

      await writeAudit({
        personId: request.user!.personId,
        action: 'READ',
        targetType: 'leave_request',
        targetId: row.logical_id,
        details: { subject_person_id: row.person_id, relationship },
        request,
      });

      return row;
    },
  });

  // -------------------------------------------------------------------------
  // Create a leave request.
  // -------------------------------------------------------------------------
  app.post('/api/leave-requests', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedBody = createBodySchema.safeParse(request.body);
      if (!parsedBody.success) return invalid(reply, parsedBody.error);

      const data = parsedBody.data;
      const actorPersonId = request.user!.personId;

      type Outcome =
        | { kind: 'created'; row: LeaveRecord; isMinor: boolean; balanceBefore: number }
        | { kind: 'error'; code: number; body: Record<string, unknown> };

      let outcome: Outcome = {
        kind: 'error',
        code: 500,
        body: { error: 'Internal Server Error', message: 'Leave request was not evaluated' },
      };
      const client = await getClient();
      let committed = false;
      try {
        await client.query('BEGIN');

        // Serialise this person's concurrent submissions for this leave type so
        // two requests cannot each pass the balance check and then both commit.
        await client.query(
          `SELECT pg_advisory_xact_lock(('x' || substr(md5($1), 1, 15))::bit(60)::BIGINT)`,
          [`leave:${actorPersonId}:${data.leave_type}`]
        );

        // One round trip for: today in the org timezone, the working-day count,
        // the calendar span, how far the request is from today, and minority.
        //
        // Minority (DPDP s.9(3)): computed with real date arithmetic —
        // date_of_birth + 18 years compared against today in the org timezone —
        // not a subtraction of year numbers, which mislabels anyone whose
        // birthday has not yet occurred this year. A NULL or missing
        // date_of_birth is unknown, and unknown is treated as a minor.
        const contextResult = await client.query(
          `SELECT
             (NOW() AT TIME ZONE $1)::date::text AS today,
             health.fn_working_days($2::date, $3::date, $4) AS working_days,
             (($3::date - $2::date) + 1) AS calendar_days,
             ($2::date - (NOW() AT TIME ZONE $1)::date) AS start_offset_days,
             COALESCE(
               p.date_of_birth IS NULL
                 OR (p.date_of_birth + INTERVAL '18 years')::date > (NOW() AT TIME ZONE $1)::date,
               TRUE
             ) AS is_minor,
             (p.logical_id IS NOT NULL) AS person_exists
           FROM (SELECT 1 AS anchor) anchor
           LEFT JOIN health.persons p ON p.logical_id = $5`,
          [config.ORG_TIMEZONE, data.start_date, data.end_date, HOLIDAY_JURISDICTION, actorPersonId]
        );

        const ctx = contextResult.rows[0] as RequestContextRow | undefined;
        if (!ctx) {
          outcome = {
            kind: 'error',
            code: 500,
            body: { error: 'Internal Server Error', message: 'Could not evaluate the leave request' },
          };
        } else if (!ctx.person_exists) {
          outcome = {
            kind: 'error',
            code: 403,
            body: {
              error: 'Forbidden',
              message: 'No employee record is linked to this account',
            },
          };
        } else if (ctx.calendar_days > MAX_CALENDAR_SPAN_DAYS) {
          outcome = {
            kind: 'error',
            code: 400,
            body: {
              error: 'Validation Error',
              message: `A single leave request may not span more than ${MAX_CALENDAR_SPAN_DAYS} calendar days`,
            },
          };
        } else if (ctx.start_offset_days < -MAX_BACKDATE_DAYS) {
          outcome = {
            kind: 'error',
            code: 400,
            body: {
              error: 'Validation Error',
              message: `Leave cannot be backdated more than ${MAX_BACKDATE_DAYS} days`,
            },
          };
        } else if (ctx.start_offset_days > MAX_FORWARD_DAYS) {
          outcome = {
            kind: 'error',
            code: 400,
            body: {
              error: 'Validation Error',
              message: `Leave cannot start more than ${MAX_FORWARD_DAYS} days in the future`,
            },
          };
        } else if (ctx.working_days <= 0) {
          outcome = {
            kind: 'error',
            code: 400,
            body: {
              error: 'Validation Error',
              message: 'The selected dates contain no working days (weekends and holidays are not deducted from leave)',
            },
          };
        } else {
          // Balance is evaluated for the leave year containing start_date, so a
          // request that begins in the next leave year draws on that year.
          const balanceResult = await client.query(
            `SELECT leave_type, total_entitled, total_used, balance, pending_approval
               FROM health.fn_leave_balance($1, $2, $3::date)`,
            [actorPersonId, data.leave_type, data.start_date]
          );
          const balance = balanceResult.rows[0] as BalanceRow | undefined;
          const available = balance?.balance ?? 0;
          const entitled = balance?.total_entitled ?? 0;

          if (ctx.working_days > available) {
            outcome = {
              kind: 'error',
              code: 409,
              body: {
                error: 'Insufficient Leave Balance',
                message:
                  entitled === 0
                    ? `No ${data.leave_type} entitlement is configured for you for this leave year. Contact HR.`
                    : `This request needs ${ctx.working_days} working day(s) of ${data.leave_type} but only ${available} day(s) are available (entitlement ${entitled}, taken ${balance?.total_used ?? 0}, awaiting approval ${balance?.pending_approval ?? 0}).`,
                requested_days: ctx.working_days,
                available_days: available,
                total_entitled: entitled,
                total_used: balance?.total_used ?? 0,
                pending_approval: balance?.pending_approval ?? 0,
                unit: 'working_days',
              },
            };
          } else {
            // parental_consent_secured is FALSE whenever the subject is (or may
            // be) a minor: there is no verified guardian-consent record to rely
            // on, so the flag stays false and the response tells the caller that
            // guardian consent must be obtained out of band.
            const parentalConsentSecured = !ctx.is_minor;

            const inserted = await client.query(
              `INSERT INTO health.leave_requests (
                 person_id, leave_type, status, start_date, end_date, days_requested,
                 reason, parental_consent_secured, valid_period, system_period
               ) VALUES (
                 $1, $2, 'PENDING', $3::date, $4::date, $5, $6, $7,
                 tstzrange($3::date::TIMESTAMPTZ, ($4::date + 1)::TIMESTAMPTZ, '[]'),
                 tstzrange(NOW(), NULL, '[]')
               )
               RETURNING logical_id, person_id, leave_type, status,
                         start_date::text AS start_date, end_date::text AS end_date,
                         days_requested, reason, rejection_reason,
                         parental_consent_secured, approved_by, approved_at,
                         created_at, updated_at`,
              [
                actorPersonId,
                data.leave_type,
                data.start_date,
                data.end_date,
                ctx.working_days,
                data.reason ?? null,
                parentalConsentSecured,
              ]
            );

            const row = inserted.rows[0] as LeaveRecord | undefined;
            if (!row) {
              outcome = {
                kind: 'error',
                code: 500,
                body: { error: 'Internal Server Error', message: 'Leave request was not created' },
              };
            } else {
              await client.query('COMMIT');
              committed = true;
              outcome = { kind: 'created', row, isMinor: ctx.is_minor, balanceBefore: available };
            }
          }
        }
      } catch (error) {
        if (sqlState(error) === EXCLUSION_VIOLATION) {
          outcome = {
            kind: 'error',
            code: 409,
            body: {
              error: 'Conflict',
              message: 'You already have a pending or approved leave request covering one or more of these dates',
            },
          };
        } else {
          throw error;
        }
      } finally {
        if (!committed) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            console.error('[LEAVE] rollback failed', rollbackError);
          }
        }
        client.release();
      }

      if (outcome.kind === 'error') {
        return reply.code(outcome.code).send(outcome.body);
      }

      const row = outcome.row;
      await writeAudit({
        personId: actorPersonId,
        action: 'CREATE',
        targetType: 'leave_request',
        targetId: row.logical_id,
        details: {
          leave_type: row.leave_type,
          start_date: row.start_date,
          end_date: row.end_date,
          days_requested: row.days_requested,
          balance_before: outcome.balanceBefore,
          requires_guardian_consent: outcome.isMinor,
        },
        request,
      });
      await emitEvent({
        type: 'LeaveRequested',
        source: 'leave:create',
        actorPersonId,
        payload: {
          leave_request_id: row.logical_id,
          leave_type: row.leave_type,
          start_date: row.start_date,
          end_date: row.end_date,
          days_requested: row.days_requested,
          requires_guardian_consent: outcome.isMinor,
        },
      });

      // Explicit projection here too: no row spread anywhere in this module.
      return reply.code(201).send({
        logical_id: row.logical_id,
        person_id: row.person_id,
        leave_type: row.leave_type,
        status: row.status,
        start_date: row.start_date,
        end_date: row.end_date,
        days_requested: row.days_requested,
        reason: row.reason,
        rejection_reason: row.rejection_reason,
        parental_consent_secured: row.parental_consent_secured,
        approved_by: row.approved_by,
        approved_at: row.approved_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        requires_guardian_consent: outcome.isMinor,
        unit: 'working_days',
      });
    },
  });

  // -------------------------------------------------------------------------
  // Cancel (withdraw) a leave request — owner only.
  // -------------------------------------------------------------------------
  app.post('/api/leave-requests/:id/cancel', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) return invalid(reply, parsedParams.error);

      const parsedBody = cancelBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) return invalid(reply, parsedBody.error);

      const { id } = parsedParams.data;
      const actorPersonId = request.user!.personId;

      const existing = await query<LeaveRecord>(
        `SELECT ${RECORD_COLUMNS}
           FROM health.leave_requests lr
          WHERE lr.logical_id = $1 AND lr.system_period @> NOW()`,
        [id]
      );

      const row = existing.rows[0];
      if (!row) {
        return reply.code(404).send({ error: 'Leave request not found' });
      }

      // Withdrawal is a personal act: only the subject may withdraw, never a
      // manager or an HR role. Managers reject; subjects cancel.
      if (row.person_id !== actorPersonId) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only the employee who submitted a leave request may cancel it',
        });
      }

      // Atomic guarded transition: PENDING at any time, APPROVED only before the
      // leave has started (today in the org timezone). Cancelling releases both
      // the balance and the dates, because fn_leave_balance and the live-period
      // exclusion constraint only consider PENDING and APPROVED rows.
      const update = await query<LeaveRecord>(
        `UPDATE health.leave_requests lr
            SET status = 'CANCELLED', updated_at = NOW()
          WHERE lr.logical_id = $1
            AND lr.person_id = $2
            AND lr.system_period @> NOW()
            AND (
                  lr.status = 'PENDING'
              OR (lr.status = 'APPROVED' AND lr.start_date > (NOW() AT TIME ZONE $3)::date)
            )
        RETURNING lr.logical_id, lr.person_id, lr.leave_type, lr.status,
                  lr.start_date::text AS start_date, lr.end_date::text AS end_date,
                  lr.days_requested, lr.reason, lr.rejection_reason,
                  lr.parental_consent_secured, lr.approved_by, lr.approved_at,
                  lr.created_at, lr.updated_at`,
        [id, actorPersonId, config.ORG_TIMEZONE]
      );

      const cancelled = update.rows[0];
      if (!cancelled) {
        return reply.code(409).send({
          error: 'Conflict',
          message:
            row.status === 'APPROVED'
              ? 'Approved leave can only be cancelled before it starts'
              : `A leave request that is ${row.status} cannot be cancelled`,
          status: row.status,
        });
      }

      const audited = await auditOrRevert(reply, id, 'CANCELLED', {
        personId: actorPersonId,
        action: 'CANCEL',
        targetType: 'leave_request',
        targetId: id,
        details: {
          subject_person_id: cancelled.person_id,
          leave_type: cancelled.leave_type,
          previous_status: row.status,
          days_released: cancelled.days_requested,
          reason: parsedBody.data.reason ?? null,
        },
        request,
      });
      if (audited) return audited;

      await emitEvent({
        type: 'LeaveCancelled',
        source: 'leave:cancel',
        actorPersonId,
        payload: {
          leave_request_id: id,
          subject_person_id: cancelled.person_id,
          leave_type: cancelled.leave_type,
          previous_status: row.status,
          days_released: cancelled.days_requested,
        },
      });

      return cancelled;
    },
  });

  // -------------------------------------------------------------------------
  // Approve — the subject's manager or a privileged role, never the subject.
  // -------------------------------------------------------------------------
  app.put('/api/leave-requests/:id/approve', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) return invalid(reply, parsedParams.error);

      const { id } = parsedParams.data;
      const actorPersonId = request.user!.personId;

      const result = await query<LeaveRecord>(
        `SELECT ${RECORD_COLUMNS}
           FROM health.leave_requests lr
          WHERE lr.logical_id = $1 AND lr.system_period @> NOW()`,
        [id]
      );

      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ error: 'Leave request not found' });
      }

      // Self-approval is impossible regardless of role. canActOnBehalfOf()
      // encodes that rule centrally (it returns false when actor === subject);
      // the identity test is repeated here so this route stays safe even if that
      // helper is ever relaxed.
      if (
        actorPersonId === row.person_id ||
        !canActOnBehalfOf(actorPersonId, row.person_id, request.user!.roles)
      ) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'You may not approve your own leave request',
        });
      }

      const relationship = await personRelationship(actorPersonId, row.person_id);
      if (relationship !== 'MANAGER' && !isPrivileged(request.user!.roles)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: "Only the employee's manager or an authorized HR/leadership role may approve leave",
        });
      }

      // Guarded atomic transition. The balance was already reserved when the
      // request was created (PENDING counts against it), so approval does not
      // re-check it.
      const update = await query<LeaveRecord>(
        `UPDATE health.leave_requests lr
            SET status = 'APPROVED', approved_by = $2, approved_at = NOW(), updated_at = NOW()
          WHERE lr.logical_id = $1
            AND lr.status = 'PENDING'
            AND lr.system_period @> NOW()
        RETURNING lr.logical_id, lr.person_id, lr.leave_type, lr.status,
                  lr.start_date::text AS start_date, lr.end_date::text AS end_date,
                  lr.days_requested, lr.reason, lr.rejection_reason,
                  lr.parental_consent_secured, lr.approved_by, lr.approved_at,
                  lr.created_at, lr.updated_at`,
        [id, actorPersonId]
      );

      const approved = update.rows[0];
      if (!approved) {
        return reply.code(409).send({
          error: 'Conflict',
          message: `Leave request is already ${row.status}`,
          status: row.status,
        });
      }

      const audited = await auditOrRevert(reply, id, 'APPROVED', {
        personId: actorPersonId,
        action: 'APPROVE',
        targetType: 'leave_request',
        targetId: id,
        details: {
          subject_person_id: approved.person_id,
          leave_type: approved.leave_type,
          days_requested: approved.days_requested,
          relationship,
        },
        request,
      });
      if (audited) return audited;

      await emitEvent({
        type: 'LeaveApproved',
        source: 'leave:approve',
        actorPersonId,
        payload: {
          leave_request_id: id,
          subject_person_id: approved.person_id,
          leave_type: approved.leave_type,
          days_requested: approved.days_requested,
        },
      });

      return approved;
    },
  });

  // -------------------------------------------------------------------------
  // Reject — the subject's manager or a privileged role, never the subject.
  // -------------------------------------------------------------------------
  app.put('/api/leave-requests/:id/reject', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) return invalid(reply, parsedParams.error);

      const parsedBody = rejectBodySchema.safeParse(request.body);
      if (!parsedBody.success) return invalid(reply, parsedBody.error);

      const { id } = parsedParams.data;
      const actorPersonId = request.user!.personId;

      const result = await query<LeaveRecord>(
        `SELECT ${RECORD_COLUMNS}
           FROM health.leave_requests lr
          WHERE lr.logical_id = $1 AND lr.system_period @> NOW()`,
        [id]
      );

      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ error: 'Leave request not found' });
      }

      if (
        actorPersonId === row.person_id ||
        !canActOnBehalfOf(actorPersonId, row.person_id, request.user!.roles)
      ) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'You may not decide your own leave request',
        });
      }

      const relationship = await personRelationship(actorPersonId, row.person_id);
      if (relationship !== 'MANAGER' && !isPrivileged(request.user!.roles)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: "Only the employee's manager or an authorized HR/leadership role may reject leave",
        });
      }

      const update = await query<LeaveRecord>(
        `UPDATE health.leave_requests lr
            SET status = 'REJECTED', rejection_reason = $2, updated_at = NOW()
          WHERE lr.logical_id = $1
            AND lr.status = 'PENDING'
            AND lr.system_period @> NOW()
        RETURNING lr.logical_id, lr.person_id, lr.leave_type, lr.status,
                  lr.start_date::text AS start_date, lr.end_date::text AS end_date,
                  lr.days_requested, lr.reason, lr.rejection_reason,
                  lr.parental_consent_secured, lr.approved_by, lr.approved_at,
                  lr.created_at, lr.updated_at`,
        [id, parsedBody.data.rejection_reason]
      );

      const rejected = update.rows[0];
      if (!rejected) {
        return reply.code(409).send({
          error: 'Conflict',
          message: `Leave request is already ${row.status}`,
          status: row.status,
        });
      }

      // Rejection releases the dates and the reserved balance: the live-period
      // exclusion constraint and fn_leave_balance both ignore REJECTED rows.
      const audited = await auditOrRevert(reply, id, 'REJECTED', {
        personId: actorPersonId,
        action: 'REJECT',
        targetType: 'leave_request',
        targetId: id,
        details: {
          subject_person_id: rejected.person_id,
          leave_type: rejected.leave_type,
          days_released: rejected.days_requested,
          relationship,
        },
        request,
      });
      if (audited) return audited;

      await emitEvent({
        type: 'LeaveRejected',
        source: 'leave:reject',
        actorPersonId,
        payload: {
          leave_request_id: id,
          subject_person_id: rejected.person_id,
          leave_type: rejected.leave_type,
          days_released: rejected.days_requested,
        },
      });

      return rejected;
    },
  });
}

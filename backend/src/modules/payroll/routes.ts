import { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { query, getClient } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { canRunPayroll, canActOnBehalfOf } from '../../lib/access.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { z } from 'zod';

/**
 * MONEY RULE FOR THIS MODULE
 * Currency never becomes a JavaScript number on a write path. node-postgres
 * returns NUMERIC as a decimal string; we keep it a string, pass it as
 * `$n::numeric` and let PostgreSQL do every addition, subtraction and
 * comparison. The only float arithmetic left is `displayDelta` below, which is
 * read-only presentation and is rounded at the edge with toFixed(2).
 */
function displayDelta(current: string, previous: string): string {
  return (Number(current) - Number(previous)).toFixed(2);
}

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Invalid request',
    details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** `:id` route params are UUIDs. A malformed id is a 400, not a driver 500. */
const idParamSchema = z.object({ id: z.string().uuid() });

/** Statuses from which paying (or retrying payment of) a run is legal. */
const PAYABLE_STATUSES = ['APPROVED', 'PARTIALLY_PAID', 'FAILED'];

const MAX_RUNS_PAGE = 100;

type RunDiagnosis = {
  status: string;
  created_by: string | null;
  approved_by: string | null;
  is_payee: boolean;
};

/**
 * A guarded transition enforces status + segregation of duties + self-payroll in
 * one WHERE clause, so a 0-row result has several possible causes. This
 * read-only follow-up says exactly which one, without ever re-deciding the
 * write (no TOCTOU: the write already happened, or did not).
 */
async function explainRunRejection(
  reply: FastifyReply,
  opts: { runId: string; actor: string; roles: string[]; action: 'approve' | 'pay'; allowed: string[] }
): Promise<FastifyReply> {
  const verb = opts.action === 'approve' ? 'approved' : 'paid';
  const diag = await query<RunDiagnosis>(
    `SELECT pr.status, pr.created_by, pr.approved_by,
            EXISTS (
              SELECT 1 FROM health.payroll_entries pe
              WHERE pe.run_id = pr.run_id AND pe.person_id = $2
            ) AS is_payee
     FROM health.payroll_runs pr
     WHERE pr.run_id = $1`,
    [opts.runId, opts.actor]
  );
  const row = diag.rows[0];
  if (!row) {
    return reply.code(404).send({ error: 'Not Found', message: 'Payroll run not found' });
  }
  if (row.created_by && !canActOnBehalfOf(opts.actor, row.created_by, opts.roles)) {
    return reply.code(409).send({
      error: 'Conflict',
      message: `Segregation of duties: you created this payroll run, so it must be ${verb} by a different person`,
    });
  }
  if (opts.action === 'pay' && row.approved_by && !canActOnBehalfOf(opts.actor, row.approved_by, opts.roles)) {
    return reply.code(409).send({
      error: 'Conflict',
      message: 'Segregation of duties: you approved this payroll run, so it must be disbursed by a different person',
    });
  }
  if (row.is_payee) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: `You have a payroll entry in this run, so you may not ${opts.action} it: that would be approving or paying your own salary. A different ${opts.action === 'approve' ? 'approver' : 'payer'} is required`,
    });
  }
  return reply.code(409).send({
    error: 'Conflict',
    message: `Run is ${row.status}; it must be ${opts.allowed.join(' or ')} to ${opts.action}`,
  });
}

export async function payrollRoutes(app: FastifyInstance) {
  // --- Payroll lifecycle ---

  // Create a run and compute entries from real employment + leave records
  app.post('/api/payroll/runs', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!canRunPayroll(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Payroll requires a finance/payroll role' });
      }
      const schema = z.object({
        period_start: z.string().date(),
        period_end: z.string().date(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, parsed.error);
      }
      const data = parsed.data;
      if (data.period_end < data.period_start) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'period_end must not precede period_start',
        });
      }

      // Create + compute + COMPUTED atomically. A compute failure must not
      // leave a DRAFT run squatting on UNIQUE (period_start, period_end),
      // which would make that period impossible to ever run again.
      let runRow: Record<string, unknown> | null = null;
      let runId = '';
      let entries: number | null = null;
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const run = await client.query(
          `INSERT INTO health.payroll_runs (period_start, period_end, status, created_by)
           VALUES ($1, $2, 'DRAFT', $3)
           RETURNING *`,
          [data.period_start, data.period_end, request.user!.personId]
        );
        runId = String(run.rows[0].run_id);
        const computed = await client.query('SELECT health.fn_payroll_compute($1) AS count', [runId]);
        entries = Number(computed.rows[0].count);
        const updated = await client.query(
          `UPDATE health.payroll_runs SET status = 'COMPUTED', updated_at = NOW()
           WHERE run_id = $1 AND status = 'DRAFT'
           RETURNING *`,
          [runId]
        );
        runRow = updated.rows[0] ?? run.rows[0];
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if ((error as { code?: string }).code === '23505') {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'A payroll run already exists for this period',
          });
        }
        request.log.error({ err: error }, '[PAYROLL] run creation failed');
        return reply.code(500).send({ error: 'Payroll computation failed' });
      } finally {
        client.release();
      }
      if (!runRow || entries === null) {
        return reply.code(500).send({ error: 'Payroll computation failed' });
      }

      await emitEvent({
        type: 'PayrollCalculated',
        source: 'payroll:run',
        actorPersonId: request.user!.personId,
        payload: { run_id: runId, period_start: data.period_start, period_end: data.period_end, entries },
      });
      // Audit LAST: writeAudit throws (503) when AUDIT_FAIL_CLOSED, and a throw
      // must never strand an already-committed financial mutation mid-handler.
      await writeAudit({
        personId: request.user!.personId,
        action: 'PAYROLL_COMPUTE',
        targetType: 'payroll_run',
        targetId: runId,
        details: { period_start: data.period_start, period_end: data.period_end, entries },
        request,
      });
      return reply.code(201).send({ ...runRow, entries });
    }
  });

  // Approve a run.
  // SEGREGATION OF DUTIES: the approver must not be the person who created the
  // run, and must not be a payee inside the run they are approving.
  app.post('/api/payroll/runs/:id/approve', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!canRunPayroll(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Payroll requires a finance/payroll role' });
      }
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return badRequest(reply, params.error);
      }
      const { id } = params.data;
      const actor = request.user!.personId;

      // One guarded transition. Status, maker-checker and self-payroll are all
      // enforced inside the WHERE clause, so nothing can change between the
      // check and the write; diagnosing a 0-row result is read-only.
      const result = await query(
        `UPDATE health.payroll_runs
         SET status = 'APPROVED', approved_by = $2, approved_at = NOW(), updated_at = NOW()
         WHERE run_id = $1 AND status = 'COMPUTED'
           AND created_by IS DISTINCT FROM $2
           AND NOT EXISTS (
             SELECT 1 FROM health.payroll_entries pe
             WHERE pe.run_id = $1 AND pe.person_id = $2
           )
         RETURNING *`,
        [id, actor]
      );
      if (result.rows.length === 0) {
        return explainRunRejection(reply, {
          runId: id,
          actor,
          roles: request.user!.roles,
          action: 'approve',
          allowed: ['COMPUTED'],
        });
      }
      await writeAudit({
        personId: actor,
        action: 'PAYROLL_APPROVE',
        targetType: 'payroll_run',
        targetId: id,
        request,
      });
      return result.rows[0];
    }
  });

  // Pay a run: every entry becomes a SUCCESSFUL wallet credit + payslip.
  // The run only reaches PAID when every entry has a SUCCESSFUL transaction.
  // Payment is idempotent and RETRYABLE: re-invoking pay on a PARTIALLY_PAID or
  // FAILED run settles only the entries with no SUCCESSFUL wallet transaction,
  // so a partial failure can no longer permanently strand a period that
  // UNIQUE (period_start, period_end) forbids re-running.
  // SEGREGATION OF DUTIES: the payer may not be the creator or the approver,
  // and may not be a payee of the run.
  app.post('/api/payroll/runs/:id/pay', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!canRunPayroll(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Payroll requires a finance/payroll role' });
      }
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return badRequest(reply, params.error);
      }
      const { id } = params.data;
      const actor = request.user!.personId;

      // Guarded claim in the same style as approve: the status, maker-checker
      // and self-payroll predicates and the write are a single statement, so no
      // read-then-write window exists.
      const claim = await query(
        `UPDATE health.payroll_runs
         SET updated_at = NOW()
         WHERE run_id = $1 AND status = ANY($3::text[])
           AND created_by IS DISTINCT FROM $2
           AND approved_by IS DISTINCT FROM $2
           AND NOT EXISTS (
             SELECT 1 FROM health.payroll_entries pe
             WHERE pe.run_id = $1 AND pe.person_id = $2
           )
         RETURNING run_id`,
        [id, actor, PAYABLE_STATUSES]
      );
      if (claim.rows.length === 0) {
        return explainRunRejection(reply, {
          runId: id,
          actor,
          roles: request.user!.roles,
          action: 'pay',
          allowed: PAYABLE_STATUSES,
        });
      }

      const totals = await query<{ total: string }>(
        `SELECT count(*)::text AS total FROM health.payroll_entries WHERE run_id = $1`,
        [id]
      );
      const totalEntries = Number(totals.rows[0]?.total ?? '0');

      // Unsettled entries only. Whether an entry is payable at all is decided in
      // SQL (net_amount > 0) so that no monetary value is compared in JS.
      const entries = await query<{ entry_id: string; person_id: string; payable: boolean }>(
        `SELECT pe.entry_id, pe.person_id, (pe.net_amount > 0) AS payable
         FROM health.payroll_entries pe
         WHERE pe.run_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM health.wallet_transactions wt
             WHERE wt.reference_type = 'payroll_entry'
               AND wt.reference_id = pe.entry_id
               AND wt.status = 'SUCCESSFUL'
           )
         ORDER BY pe.entry_id`,
        [id]
      );

      let paid = 0;
      let failed = 0;
      for (const entry of entries.rows) {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          const wallet = await client.query(
            `SELECT wallet_id FROM health.wallet_accounts WHERE person_id = $1`,
            [entry.person_id]
          );
          if (wallet.rows.length === 0) {
            throw new Error('no wallet for person ' + entry.person_id);
          }
          if (entry.payable) {
            // PostgreSQL reads the amount straight out of the entry and returns
            // it as a NUMERIC string. It never becomes a JavaScript number.
            const txn = await client.query(
              `INSERT INTO health.wallet_transactions (wallet_id, txn_type, amount, reference_type, reference_id, idempotency_key, status, processed_at)
               SELECT $1::uuid, 'CREDIT', pe.net_amount, 'payroll_entry', pe.entry_id, $3::uuid, 'SUCCESSFUL', NOW()
               FROM health.payroll_entries pe
               WHERE pe.entry_id = $2::uuid
               ON CONFLICT (reference_type, reference_id) DO NOTHING
               RETURNING txn_id, amount`,
              [wallet.rows[0].wallet_id, entry.entry_id, randomUUID()]
            );
            if (txn.rows.length > 0) {
              // Balance moves only when the INSERT actually created the ledger
              // row. That is the idempotency guarantee; PostgreSQL performs the
              // addition on the NUMERIC value.
              await client.query(
                `UPDATE health.wallet_accounts SET balance = balance + $2::numeric, updated_at = NOW()
                 WHERE wallet_id = $1`,
                [wallet.rows[0].wallet_id, txn.rows[0].amount]
              );
            } else {
              // DO NOTHING fired, so a ledger row exists for this entry but is
              // not SUCCESSFUL (a SUCCESSFUL one would have been filtered out
              // above). Never count that as paid: surface it instead, so the
              // money is visibly unsettled rather than silently skipped.
              throw new Error('a non-successful wallet transaction already blocks entry ' + entry.entry_id);
            }
          }
          await client.query(
            `INSERT INTO health.payslips (entry_id, person_id)
             SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM health.payslips WHERE entry_id = $1)`,
            [entry.entry_id, entry.person_id]
          );
          await client.query('COMMIT');
          paid++;
        } catch (error) {
          // ROLLBACK already removed any transaction row this attempt inserted.
          // The old code then ran a separate non-transactional UPDATE to mark
          // the reference FAILED, which could stamp a row that was never
          // inserted here (or an already SUCCESSFUL one) and thereby block every
          // future retry. That query is deliberately gone.
          await client.query('ROLLBACK').catch(() => undefined);
          failed++;
          request.log.error({ err: error, entry_id: entry.entry_id }, '[PAYROLL] entry payment failed');
        } finally {
          client.release();
        }
      }

      // `paid` counts only what THIS invocation settled; anything settled by an
      // earlier attempt was excluded from the loop, so it is counted here.
      const previouslySettled = totalEntries - entries.rows.length;
      const finalStatus =
        failed === 0 ? 'PAID' : paid + previouslySettled === 0 ? 'FAILED' : 'PARTIALLY_PAID';

      // Guarded transition rather than read-then-write: a concurrent invocation
      // that already drove the run to PAID must not be dragged back.
      // NOTE: there is no paid_by column on health.payroll_runs, so the payer is
      // recorded in the audit trail only. A migration adding paid_by (and a
      // paid_by <> approved_by constraint) is required to persist it.
      const transition = await query<{ status: string }>(
        `UPDATE health.payroll_runs
         SET status = $2,
             paid_at = CASE WHEN $2 = 'PAID' THEN NOW() ELSE paid_at END,
             updated_at = NOW()
         WHERE run_id = $1 AND status = ANY($3::text[])
         RETURNING status`,
        [id, finalStatus, PAYABLE_STATUSES]
      );
      let status = transition.rows[0]?.status;
      if (!status) {
        const current = await query<{ status: string }>(
          `SELECT status FROM health.payroll_runs WHERE run_id = $1`,
          [id]
        );
        status = current.rows[0]?.status ?? finalStatus;
      }

      await emitEvent({
        type: status === 'PAID' || paid > 0 ? 'PayslipGenerated' : 'PayrollFailed',
        source: 'payroll:pay',
        actorPersonId: actor,
        payload: { run_id: id, paid, failed, status },
      });
      // Audit LAST so an AuditWriteError (503) cannot abandon committed payments.
      await writeAudit({
        personId: actor,
        action: 'PAYROLL_PAY',
        targetType: 'payroll_run',
        targetId: id,
        details: {
          entries_total: totalEntries,
          attempted: entries.rows.length,
          settled_now: paid,
          previously_settled: previouslySettled,
          failed,
          final_status: status,
          paid_by: actor,
        },
        request,
      });
      return {
        status,
        entries_total: totalEntries,
        attempted: entries.rows.length,
        paid,
        previously_settled: previouslySettled,
        failed,
        retryable: status !== 'PAID',
      };
    }
  });

  // Runs summary (payroll roles), paginated
  app.get('/api/payroll/runs', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!canRunPayroll(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const listQuery = z.object({
        limit: z.coerce.number().int().min(1).max(MAX_RUNS_PAGE).default(50),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      });
      const parsed = listQuery.safeParse(request.query);
      if (!parsed.success) {
        return badRequest(reply, parsed.error);
      }
      // net_total stays a NUMERIC string from pg; it is never parsed to a float.
      const result = await query(
        `SELECT pr.*, count(pe.entry_id) AS entries,
                COALESCE(sum(pe.net_amount), 0) AS net_total
         FROM health.payroll_runs pr
         LEFT JOIN health.payroll_entries pe ON pe.run_id = pr.run_id
         GROUP BY pr.run_id
         ORDER BY pr.period_start DESC, pr.run_id DESC
         LIMIT $1 OFFSET $2`,
        [parsed.data.limit, parsed.data.offset]
      );
      return { runs: result.rows, limit: parsed.data.limit, offset: parsed.data.offset };
    }
  });

  // --- Employee-facing ---

  // My payslips (owner only)
  app.get('/api/payroll/my-payslips', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const result = await query(
        `SELECT ps.payslip_id, ps.issued_at, pr.period_start, pr.period_end, pr.status AS run_status,
                pe.salary_amount, pe.unpaid_leave_days, pe.gross_amount, pe.tax_amount, pe.net_amount,
                pe.breakdown
         FROM health.payslips ps
         JOIN health.payroll_entries pe ON pe.entry_id = ps.entry_id
         JOIN health.payroll_runs pr ON pr.run_id = pe.run_id
         WHERE ps.person_id = $1
         ORDER BY pr.period_start DESC`,
        [request.user!.personId]
      );
      return result.rows;
    }
  });

  // Payslip detail + "why did my pay change" vs previous run.
  // Readable by the OWNER or by a payroll/finance role only. The previous
  // `isPrivileged` gate was far too wide: it let auditor, hr, hr_generalist and
  // hr_admin read any employee's salary.
  app.get('/api/payroll/payslips/:id', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return badRequest(reply, params.error);
      }
      const { id } = params.data;
      const result = await query(
        `SELECT ps.payslip_id, ps.issued_at, pr.period_start, pr.period_end, pr.status AS run_status,
                pe.entry_id, pe.person_id, pe.salary_amount, pe.unpaid_leave_days,
                pe.unpaid_leave_deduction, pe.gross_amount, pe.tax_amount, pe.net_amount, pe.breakdown
         FROM health.payslips ps
         JOIN health.payroll_entries pe ON pe.entry_id = ps.entry_id
         JOIN health.payroll_runs pr ON pr.run_id = pe.run_id
         WHERE ps.payslip_id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Payslip not found' });
      }
      const row = result.rows[0];
      if (row.person_id !== request.user!.personId && !canRunPayroll(request.user!.roles)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'A payslip may be read only by its owner or by a finance/payroll role',
        });
      }

      // Previous run for comparison
      const prev = await query(
        `SELECT pe.net_amount, pr.period_start, pr.period_end, pe.unpaid_leave_days
         FROM health.payroll_entries pe
         JOIN health.payroll_runs pr ON pr.run_id = pe.run_id
         WHERE pe.person_id = $1 AND pr.period_start < $2
         ORDER BY pr.period_start DESC LIMIT 1`,
        [row.person_id, row.period_start]
      );

      await writeAudit({
        personId: request.user!.personId,
        action: 'READ',
        targetType: 'payslip',
        targetId: id,
        details: { subject_person_id: row.person_id },
        request,
      });

      const previous = prev.rows[0] ?? null;
      return {
        ...row,
        previous,
        change: previous
          ? {
              // Display only, rounded at the edge and returned as a decimal
              // string so it matches the NUMERIC strings above.
              net_delta: displayDelta(String(row.net_amount), String(previous.net_amount)),
              unpaid_leave_days: row.unpaid_leave_days - previous.unpaid_leave_days,
              reasons: row.unpaid_leave_days > previous.unpaid_leave_days
                ? [`${row.unpaid_leave_days - previous.unpaid_leave_days} more unpaid leave day(s) this period`]
                : [],
            }
          : null,
      };
    }
  });

  // --- Wallet ---

  // My wallet (owner only)
  app.get('/api/wallet', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const wallet = await query(
        `SELECT wallet_id, balance, created_at FROM health.wallet_accounts WHERE person_id = $1`,
        [request.user!.personId]
      );
      const txns = await query(
        `SELECT txn_id, txn_type, amount, reference_type, reference_id, status, created_at
         FROM health.wallet_transactions
         WHERE wallet_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [wallet.rows[0]?.wallet_id]
      );
      return { wallet: wallet.rows[0] ?? null, transactions: txns.rows };
    }
  });

  // Transfer between employees: atomic DEBIT/CREDIT, idempotent, audited
  app.post('/api/wallet/transfer', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z.object({
        recipient_username: z.string().min(1).max(120),
        // A decimal string is preferred (lossless); a JSON number is still
        // accepted for compatibility. Either form is normalised ONCE here at the
        // edge into a fixed 2dp string, and every operation after this point is
        // NUMERIC arithmetic performed by PostgreSQL.
        amount: z.union([
          z.string().regex(/^\d{1,7}(\.\d{1,2})?$/, 'amount must be a decimal with at most 2 places'),
          z.number().positive().max(1000000),
        ]),
        idempotency_key: z.string().uuid(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(reply, parsed.error);
      }
      const data = parsed.data;
      const amount: string = typeof data.amount === 'number' ? data.amount.toFixed(2) : data.amount;
      // Bounds check only — not monetary arithmetic.
      const amountBound = Number(amount);
      if (!Number.isFinite(amountBound) || amountBound <= 0 || amountBound > 1000000) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: 'amount must be greater than 0 and at most 1000000',
        });
      }

      const client = await getClient();
      try {
        await client.query('BEGIN');
        const sender = await client.query(
          `SELECT wallet_id, balance, (balance >= $2::numeric) AS sufficient
           FROM health.wallet_accounts WHERE person_id = $1 FOR UPDATE`,
          [request.user!.personId, amount]
        );
        if (sender.rows.length === 0) {
          throw new Error('no sender wallet');
        }
        // The comparison happens inside the lock and inside PostgreSQL, on
        // NUMERIC values — never on a parsed float.
        if (!sender.rows[0].sufficient) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Conflict', message: 'Insufficient balance' });
        }
        const recipient = await client.query(
          `SELECT ua.person_id, wa.wallet_id
           FROM health.user_accounts ua
           JOIN health.wallet_accounts wa ON wa.person_id = ua.person_id
           WHERE LOWER(ua.username) = LOWER($1) AND ua.is_active`,
          [data.recipient_username]
        );
        if (recipient.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Recipient not found' });
        }
        if (recipient.rows[0].person_id === request.user!.personId) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Cannot transfer to yourself' });
        }

        const dup = await client.query(
          `SELECT txn_id FROM health.wallet_transactions
           WHERE reference_type = 'transfer_debit' AND idempotency_key = $1`,
          [data.idempotency_key]
        );
        if (dup.rows.length > 0) {
          await client.query('COMMIT');
          return reply.code(200).send({ duplicate: true, txn_id: dup.rows[0].txn_id });
        }

        await client.query(
          `INSERT INTO health.wallet_transactions (wallet_id, txn_type, amount, reference_type, reference_id, idempotency_key, status, processed_at)
           VALUES ($1, 'DEBIT', $2::numeric, 'transfer_debit', $3, $4, 'SUCCESSFUL', NOW())`,
          [sender.rows[0].wallet_id, amount, data.idempotency_key, data.idempotency_key]
        );
        await client.query(
          `UPDATE health.wallet_accounts SET balance = balance - $2::numeric, updated_at = NOW() WHERE wallet_id = $1`,
          [sender.rows[0].wallet_id, amount]
        );
        await client.query(
          `INSERT INTO health.wallet_transactions (wallet_id, txn_type, amount, reference_type, reference_id, idempotency_key, status, processed_at)
           VALUES ($1, 'CREDIT', $2::numeric, 'transfer_credit', $3, $4, 'SUCCESSFUL', NOW())`,
          [recipient.rows[0].wallet_id, amount, randomUUID(), data.idempotency_key]
        );
        await client.query(
          `UPDATE health.wallet_accounts SET balance = balance + $2::numeric, updated_at = NOW() WHERE wallet_id = $1`,
          [recipient.rows[0].wallet_id, amount]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('[WALLET] transfer failed:', error);
        return reply.code(500).send({ error: 'Transfer failed' });
      } finally {
        client.release();
      }

      await emitEvent({
        type: 'WalletTransactionCreated',
        source: 'wallet:transfer',
        actorPersonId: request.user!.personId,
        payload: { amount, recipient_username: data.recipient_username },
      });
      // Audit LAST: an AuditWriteError (503) must not be able to strand an
      // already-committed transfer part-way through the handler.
      await writeAudit({
        personId: request.user!.personId,
        action: 'WALLET_TRANSFER',
        targetType: 'wallet',
        targetId: request.user!.personId,
        details: { recipient_username: data.recipient_username, amount, idempotency_key: data.idempotency_key },
        request,
      });
      return { success: true, amount, recipient_username: data.recipient_username };
    }
  });
}
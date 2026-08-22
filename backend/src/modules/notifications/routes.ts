import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { z } from 'zod';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_OFFSET = 10_000;

// Explicit column allowlist. `metadata` (free-form JSONB written by system
// workflows) is deliberately NOT returned: it is unvalidated at write time and
// has no guarantee of being free of personal detail. Titles, messages and the
// action URL carry everything the client renders.
const NOTIFICATION_COLUMNS = `logical_id, recipient_id, type, title, message, action_url,
        read_status, read_at, priority, expires_at, created_at`;

function validationFailed(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Request validation failed',
    fields: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
  });
}

const listQuerySchema = z.object({
  unread_only: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

export async function notificationRoutes(app: FastifyInstance) {
  // List notifications for the current user (own mailbox only).
  // recipient_id = caller is the only filter that selects rows; no query
  // parameter can widen it.
  app.get('/api/notifications', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const limit = parsed.data.limit ?? DEFAULT_PAGE_SIZE;
      const offset = parsed.data.offset ?? 0;

      let sql = `SELECT ${NOTIFICATION_COLUMNS} FROM health.notifications WHERE recipient_id = $1`;
      const params: unknown[] = [request.user!.personId];
      if (parsed.data.unread_only === 'true') {
        sql += ` AND read_status = FALSE`;
      }
      sql += ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
      params.push(limit, offset);
      const result = await query(sql, params);
      return result.rows;
    }
  });

  // Unread count
  app.get('/api/notifications/unread-count', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const result = await query(
        `SELECT COUNT(*) AS count FROM health.notifications
         WHERE recipient_id = $1 AND read_status = FALSE`,
        [request.user!.personId]
      );
      return { count: parseInt(result.rows[0].count) };
    }
  });

  // Mark all read — bulk update, ownership-scoped to the caller's mailbox.
  app.put('/api/notifications/read-all', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const result = await query(
        `UPDATE health.notifications
         SET read_status = TRUE, read_at = NOW()
         WHERE recipient_id = $1 AND read_status = FALSE
         RETURNING logical_id`,
        [request.user!.personId]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'NOTIFICATION_READ_ALL',
        targetType: 'notification',
        targetId: request.user!.personId,
        details: { updated: result.rowCount },
        request,
      });
      if (!audited) {
        return reply.code(503).send({
          error: 'Audit Unavailable',
          message: 'The action could not be recorded in the audit trail; please retry.',
        });
      }
      return { updated: result.rowCount };
    }
  });

  // Mark notification read — the UPDATE itself carries the ownership predicate.
  app.put('/api/notifications/:id/read', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = idParamSchema.safeParse(request.params);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { id } = parsed.data;
      const result = await query(
        `UPDATE health.notifications
         SET read_status = TRUE, read_at = NOW()
         WHERE logical_id = $1 AND recipient_id = $2
         RETURNING ${NOTIFICATION_COLUMNS}`,
        [id, request.user!.personId]
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Notification not found' });
      }
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'NOTIFICATION_READ',
        targetType: 'notification',
        targetId: id,
        request,
      });
      if (!audited) {
        return reply.code(503).send({
          error: 'Audit Unavailable',
          message: 'The action could not be recorded in the audit trail; please retry.',
        });
      }
      return result.rows[0];
    }
  });

  // Subscription is implicit: notifications are created by system workflows.
  // This endpoint exists so clients can confirm a channel without an event.
  app.get('/api/notifications/channels', {
    preHandler: [authenticate()],
    handler: async (_request, _reply) => {
      return { channels: ['in_app'], push_enabled: false, email_enabled: false };
    }
  });
}

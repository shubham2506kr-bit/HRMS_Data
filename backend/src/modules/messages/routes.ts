import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { z } from 'zod';

// Hard limits. Every list endpoint is paginated; nothing is unbounded.
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_OFFSET = 10_000;
const MAX_SUBJECT = 255;
const MAX_CONTENT = 20_000;

// Explicit column allowlist. Never `SELECT *` / `RETURNING *` and never spread a
// database row into a response: that is how an unmasked column leaks.
const MESSAGE_COLUMNS = `m.logical_id, m.sender_id, m.recipient_id, m.subject, m.content,
        m.read_status, m.read_at, m.priority, m.thread_id, m.parent_message_id,
        m.created_at, m.updated_at`;
const MESSAGE_RETURNING = `logical_id, sender_id, recipient_id, subject, content,
        read_status, read_at, priority, thread_id, parent_message_id, created_at, updated_at`;

/**
 * 400 on validation failure. Field paths and issue codes only — the rejected
 * value is never echoed back, and a malformed :id can no longer reach the
 * database and surface a driver error to the client.
 */
function validationFailed(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Request validation failed',
    fields: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
  });
}

const boolFlag = z.enum(['true', 'false']).optional();

const listQuerySchema = z.object({
  unread_only: boolFlag,
  sent: boolFlag,
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const sendSchema = z.object({
  recipient_id: z.string().uuid(),
  subject: z.string().min(1).max(MAX_SUBJECT),
  content: z.string().min(1).max(MAX_CONTENT),
});

export async function messageRoutes(app: FastifyInstance) {
  // Get messages for current user.
  // Scoping: the caller is either the recipient (inbox) or the sender (sent
  // box); there is no parameter that can widen this to anyone else's mailbox.
  app.get('/api/messages', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { unread_only, sent } = parsed.data;
      const limit = parsed.data.limit ?? DEFAULT_PAGE_SIZE;
      const offset = parsed.data.offset ?? 0;

      const sentMode = sent === 'true';

      let sql = `
        SELECT ${MESSAGE_COLUMNS},
          sender.preferred_name as sender_name,
          recipient.preferred_name as recipient_name
        FROM health.employee_messages m
        JOIN health.persons sender ON sender.logical_id = m.sender_id
        JOIN health.persons recipient ON recipient.logical_id = m.recipient_id
        WHERE ${sentMode ? 'm.sender_id' : 'm.recipient_id'} = $1
      `;

      const params: unknown[] = [request.user!.personId];

      if (!sentMode && unread_only === 'true') {
        sql += ` AND m.read_status = FALSE`;
      }

      sql += ` ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`;
      params.push(limit, offset);

      const result = await query(sql, params);
      return result.rows;
    }
  });

  // Send message
  app.post('/api/messages', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = sendSchema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;

      // Resolve the recipient before inserting: a non-existent person would
      // otherwise raise a foreign-key error and be returned as a 500.
      const recipient = await query(
        `SELECT logical_id FROM health.persons WHERE logical_id = $1`,
        [data.recipient_id]
      );
      if (recipient.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Recipient not found' });
      }

      const result = await query(
        `INSERT INTO health.employee_messages (
          sender_id, recipient_id, subject, content
        ) VALUES ($1, $2, $3, $4)
        RETURNING ${MESSAGE_RETURNING}`,
        [request.user!.personId, data.recipient_id, data.subject, data.content]
      );

      const row = result.rows[0];
      // Audit details carry identifiers only — never the subject line or body.
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'SEND',
        targetType: 'message',
        targetId: row.logical_id,
        details: { recipient_id: data.recipient_id },
        request,
      });
      if (!audited) {
        return reply.code(503).send({
          error: 'Audit Unavailable',
          message: 'The action could not be recorded in the audit trail; please retry.',
        });
      }
      await emitEvent({
        type: 'MessageSent',
        source: 'messages:send',
        actorPersonId: request.user!.personId,
        payload: { message_id: row.logical_id, recipient_id: data.recipient_id },
      });

      return reply.code(201).send(row);
    }
  });

  // Mark message as read.
  // The UPDATE carries the ownership predicate itself (recipient_id = caller),
  // so it is not possible to mark someone else's message as read.
  app.put('/api/messages/:id/read', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = idParamSchema.safeParse(request.params);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { id } = parsed.data;

      const result = await query(
        `UPDATE health.employee_messages
         SET read_status = TRUE, read_at = NOW()
         WHERE logical_id = $1 AND recipient_id = $2
         RETURNING ${MESSAGE_RETURNING}`,
        [id, request.user!.personId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Message not found' });
      }

      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'MESSAGE_READ',
        targetType: 'message',
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

  // Get unread count
  app.get('/api/messages/unread-count', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const result = await query(
        `SELECT COUNT(*) as count FROM health.employee_messages
         WHERE recipient_id = $1 AND read_status = FALSE`,
        [request.user!.personId]
      );

      return { count: parseInt(result.rows[0].count) };
    }
  });
}

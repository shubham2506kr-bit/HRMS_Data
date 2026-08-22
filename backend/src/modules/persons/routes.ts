import type { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { personRelationship, isPrivileged } from '../../lib/access.js';
import { z } from 'zod';

/**
 * Roles with a genuine need to see identity PII (legal name, date of birth)
 * about other people. Deliberately narrower than PRIVILEGED_ROLES, which also
 * contains `auditor`, `finance`, `leadership` and `senior_admin` — those can
 * see the structural directory but not identity details.
 *
 * national_id_hash / national_id_encrypted are never selected by any handler
 * in this module, and every column is listed explicitly (never SELECT * or an
 * object spread) so a future column cannot silently join a response.
 */
const IDENTITY_PII_ROLES: readonly string[] = ['hr_admin', 'hr_manager', 'payroll'];

function canSeeIdentityPII(roles: string[]): boolean {
  return roles.some((r) => IDENTITY_PII_ROLES.includes(r));
}

/** Hard ceiling on any page size this module will serve. */
const MAX_PAGE_SIZE = 500;

const directoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  // Matches preferred names only: searching legal names would turn the
  // directory into an oracle for names the caller may not read.
  q: z.string().trim().min(1).max(80).optional(),
});

const personParams = z.object({ id: z.string().uuid() });

/** Rejects C0/C1 control characters without embedding them in source. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]');

const AUDIT_FAILURE = {
  error: 'Internal Server Error',
  message: 'Change could not be recorded in the audit trail and was not confirmed',
};

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Invalid request',
    details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export async function personRoutes(app: FastifyInstance) {
  // Directory: minimal structural projection for every authenticated caller.
  // legal_name is returned only to the subject themselves or to an identity
  // PII role; for everyone else the key is present but null. date_of_birth,
  // timezone and national identifiers are not selected at all.
  app.get('/api/persons', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const q = directoryQuerySchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const { page, page_size } = q.data;
      const result = await query(
        `SELECT p.logical_id,
                CASE WHEN $1::boolean OR p.logical_id = $2::uuid
                     THEN p.legal_name ELSE NULL END AS legal_name,
                p.preferred_name,
                d.name AS department_name,
                pos.name AS position_name,
                COALESCE((
                  SELECT jsonb_agg(s.name ORDER BY s.name)
                  FROM health.person_skills ps
                  JOIN health.skills s ON s.skill_id = ps.skill_id
                  WHERE ps.person_id = p.logical_id
                ), '[]'::jsonb) AS skills,
                COALESCE((
                  SELECT jsonb_agg(pr.name ORDER BY pr.name)
                  FROM health.project_members pm
                  JOIN health.projects pr ON pr.logical_id = pm.project_id
                  WHERE pm.person_id = p.logical_id
                ), '[]'::jsonb) AS projects
         FROM health.persons p
         LEFT JOIN health.employments e ON e.person_id = p.logical_id AND e.system_period @> NOW()
         LEFT JOIN health.positions pos ON pos.logical_id = e.position_id AND pos.system_period @> NOW()
         LEFT JOIN health.departments d ON d.logical_id = pos.department_id AND d.system_period @> NOW()
         WHERE p.logical_id <> '00000000-0000-0000-0000-000000000000'
           AND ($3::text IS NULL
                OR position(lower($3::text) in lower(COALESCE(p.preferred_name, ''))) > 0)
         ORDER BY p.preferred_name, p.logical_id
         LIMIT $4 OFFSET $5`,
        [
          canSeeIdentityPII(request.user!.roles),
          request.user!.personId,
          q.data.q ?? null,
          page_size,
          (page - 1) * page_size,
        ]
      );
      return result.rows;
    }
  });

  // Get current user's person record — the subject always sees their own PII.
  app.get('/api/persons/me', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const result = await query(
        `SELECT logical_id, legal_name, preferred_name, date_of_birth, timezone, created_at
         FROM health.persons WHERE logical_id = $1`,
        [request.user!.personId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Person not found' });
      }

      return result.rows[0];
    }
  });

  // Get person by ID — owner, their department head, or a privileged role.
  // Identity PII (legal_name, date_of_birth) is additionally restricted to the
  // subject and IDENTITY_PII_ROLES; a department head or auditor receives the
  // same keys with those two values nulled.
  app.get('/api/persons/:id', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const p = personParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const { id } = p.data;
      const relationship = await personRelationship(request.user!.personId, id);
      if (relationship === 'NONE' && !isPrivileged(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You may only view your own person record' });
      }
      const showPII = relationship === 'OWNER' || canSeeIdentityPII(request.user!.roles);
      const result = await query(
        `SELECT logical_id,
                CASE WHEN $2::boolean THEN legal_name ELSE NULL END AS legal_name,
                preferred_name,
                CASE WHEN $2::boolean THEN date_of_birth ELSE NULL END AS date_of_birth,
                timezone, created_at
         FROM health.persons WHERE logical_id = $1`,
        [id, showPII]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Person not found' });
      }

      return result.rows[0];
    }
  });

  // Update person (self only).
  app.patch('/api/persons/me', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z.object({
        preferred_name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine((v) => !CONTROL_CHARS.test(v), 'preferred_name contains control characters')
          .optional(),
        timezone: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .refine((tz) => {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: tz });
              return true;
            } catch {
              return false;
            }
          }, 'timezone is not a recognised IANA time zone')
          .optional(),
      });

      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const data = parsed.data;

      const updates: string[] = [];
      const changed: string[] = [];
      const values: string[] = [request.user!.personId];
      let paramIndex = 2;

      if (data.preferred_name !== undefined) {
        updates.push(`preferred_name = $${paramIndex++}`);
        values.push(data.preferred_name);
        changed.push('preferred_name');
      }
      if (data.timezone !== undefined) {
        updates.push(`timezone = $${paramIndex++}`);
        values.push(data.timezone);
        changed.push('timezone');
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'No fields to update' });
      }

      updates.push(`updated_at = NOW()`);

      // Scoped to the caller's own logical_id: there is no route or parameter
      // by which another person's row can be reached from this handler.
      const result = await query(
        `UPDATE health.persons SET ${updates.join(', ')} WHERE logical_id = $1
         RETURNING logical_id, legal_name, preferred_name, date_of_birth, timezone, updated_at`,
        values
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Person not found' });
      }

      // Field names only: the audit trail records that PII changed without
      // copying the PII values into audit_log.details.
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'UPDATE',
        targetType: 'person',
        targetId: request.user!.personId,
        details: { fields: changed },
        request,
      });
      if (!audited) return reply.code(500).send(AUDIT_FAILURE);

      return result.rows[0];
    }
  });
}

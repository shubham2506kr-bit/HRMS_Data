import type { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { isPrivileged } from '../../lib/access.js';
import { z } from 'zod';

/**
 * Roles with a genuine need to read identity PII (legal name) about other
 * people. Narrower than PRIVILEGED_ROLES on purpose: `auditor`, `finance`,
 * `leadership` and `senior_admin` can read the structural roster but not
 * employees' legal names.
 */
const IDENTITY_PII_ROLES: readonly string[] = ['hr_admin', 'hr_manager', 'payroll'];

function canSeeIdentityPII(roles: string[]): boolean {
  return roles.some((r) => IDENTITY_PII_ROLES.includes(r));
}

/** Hard ceiling on any page size this module will serve. */
const MAX_PAGE_SIZE = 500;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
});

const departmentParams = z.object({ id: z.string().uuid() });

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Invalid request',
    details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

// Columns are listed explicitly rather than `d.*` / `p.*`: a spread or star
// would silently re-expose any column a later migration adds, and it also
// leaked the internal bitemporal valid_period / system_period ranges.
const DEPARTMENT_COLUMNS = `d.logical_id, d.name, d.jurisdiction, d.parent_department_id,
           d.description, d.created_at, d.updated_at`;

const DEPARTMENT_HEAD_NAME = `(SELECT per.preferred_name
            FROM health.positions p
            JOIN health.persons per ON per.logical_id = p.head_of_department_id
            WHERE p.department_id = d.logical_id AND p.head_of_department_id IS NOT NULL
              AND p.system_period @> NOW()
            LIMIT 1) AS head_name`;

export async function departmentRoutes(app: FastifyInstance) {
  // Get all departments — org structure, non-sensitive, available to any
  // authenticated caller. head_name is a preferred name, never a legal name.
  app.get('/api/departments', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const q = paginationSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const result = await query(
        `SELECT ${DEPARTMENT_COLUMNS},
           ${DEPARTMENT_HEAD_NAME}
         FROM health.departments d
         WHERE d.system_period @> NOW()
         ORDER BY d.name, d.logical_id
         LIMIT $1 OFFSET $2`,
        [q.data.page_size, (q.data.page - 1) * q.data.page_size]
      );

      return result.rows;
    }
  });

  // Get department by ID
  app.get('/api/departments/:id', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const p = departmentParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const result = await query(
        `SELECT ${DEPARTMENT_COLUMNS},
           ${DEPARTMENT_HEAD_NAME}
         FROM health.departments d
         WHERE d.logical_id = $1 AND d.system_period @> NOW()`,
        [p.data.id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Department not found' });
      }

      return result.rows[0];
    }
  });

  // Get department positions — org structure only.
  app.get('/api/departments/:id/positions', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const p = departmentParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const q = paginationSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const result = await query(
        `SELECT p.logical_id, p.name, p.department_id, p.head_of_department_id,
                p.grade_level, p.employment_type, p.description,
                p.created_at, p.updated_at,
                per.preferred_name AS head_name
         FROM health.positions p
         LEFT JOIN health.persons per ON per.logical_id = p.head_of_department_id
         WHERE p.department_id = $1 AND p.system_period @> NOW()
         ORDER BY p.grade_level DESC, p.logical_id
         LIMIT $2 OFFSET $3`,
        [p.data.id, q.data.page_size, (q.data.page - 1) * q.data.page_size]
      );

      return result.rows;
    }
  });

  // Get department employees — the department head or a privileged role only.
  // The scope checked (positions.department_id = :id) is the same scope the
  // roster query filters on (d.logical_id = :id), so a caller cannot be
  // authorized for one department and served another.
  //
  // legal_name is now returned only to an identity PII role or to the caller
  // about themselves; timezone is no longer selected at all.
  app.get('/api/departments/:id/employees', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const p = departmentParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const q = paginationSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const { id } = p.data;
      const isHead = await query(
        `SELECT 1
         FROM health.positions p
         WHERE p.department_id = $1 AND p.head_of_department_id = $2 AND p.system_period @> NOW()
         LIMIT 1`,
        [id, request.user!.personId]
      );
      if (isHead.rows.length === 0 && !isPrivileged(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only the department head or a privileged role may view department employees' });
      }
      const result = await query(
        `SELECT p.logical_id,
                CASE WHEN $2::boolean OR p.logical_id = $3::uuid
                     THEN p.legal_name ELSE NULL END AS legal_name,
                p.preferred_name,
                pos.name as position_name, pos.grade_level, d.name as department_name
         FROM health.persons p
         JOIN health.employments e ON e.person_id = p.logical_id
         JOIN health.positions pos ON pos.logical_id = e.position_id
         JOIN health.departments d ON d.logical_id = pos.department_id
         WHERE d.logical_id = $1
           AND e.status = 'ACTIVE' AND e.system_period @> NOW()
           AND pos.system_period @> NOW()
           AND d.system_period @> NOW()
         ORDER BY pos.grade_level DESC, p.preferred_name, p.logical_id
         LIMIT $4 OFFSET $5`,
        [
          id,
          canSeeIdentityPII(request.user!.roles),
          request.user!.personId,
          q.data.page_size,
          (q.data.page - 1) * q.data.page_size,
        ]
      );

      return result.rows;
    }
  });
}

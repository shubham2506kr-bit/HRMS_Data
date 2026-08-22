import type { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { z } from 'zod';

/**
 * These endpoints are deliberately org-wide: an org chart is only useful if it
 * covers the whole organisation. They are therefore restricted to non-sensitive
 * structural fields — identifiers, names of things, reporting lines.
 *
 * No handler here selects legal_name, date_of_birth, timezone, national
 * identifiers, salary or anything health-related. Where a person has no
 * preferred name the display name falls back to an initial rather than
 * disclosing the legal name.
 */
const DISPLAY_NAME = `COALESCE(p.preferred_name, left(p.legal_name, 1) || '.')`;

/** Placeholder/system person that must never appear in org output. */
const SYSTEM_PERSON_ID = '00000000-0000-0000-0000-000000000000';

/** Hard ceilings: these payloads were previously unbounded. */
const MAX_NODES = 5000;

const limitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_NODES).default(MAX_NODES),
});

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Invalid request',
    details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export async function organizationRoutes(app: FastifyInstance) {
  // Organization tree: departments → positions → people (2D explorer data)
  app.get('/api/organization/tree', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const q = limitSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const result = await query(
        `WITH depts AS (
           SELECT logical_id AS id, name, NULL::uuid AS parent_id, 'department' AS kind
           FROM health.departments
           WHERE system_period @> NOW()
         ),
         positions AS (
           SELECT logical_id AS id, name, department_id AS parent_id, 'position' AS kind
           FROM health.positions
           WHERE system_period @> NOW()
         ),
         people AS (
           SELECT p.logical_id AS id, ${DISPLAY_NAME} AS name,
                  e.position_id AS parent_id, 'person' AS kind
           FROM health.persons p
           LEFT JOIN health.employments e ON e.person_id = p.logical_id AND e.system_period @> NOW()
           WHERE p.logical_id <> $1::uuid
         )
         SELECT id, name, parent_id, kind
         FROM (SELECT * FROM depts UNION ALL SELECT * FROM positions UNION ALL SELECT * FROM people) t
         WHERE id IS NOT NULL
         ORDER BY kind, name, id
         LIMIT $2`,
        [SYSTEM_PERSON_ID, q.data.limit]
      );
      return result.rows;
    }
  });

  // Organization overview: node counts only — no per-person data.
  app.get('/api/organization/overview', {
    preHandler: [authenticate()],
    handler: async (_request, _reply) => {
      const result = await query(
        `SELECT
           (SELECT count(*) FROM health.persons) AS people,
           (SELECT count(*) FROM health.departments WHERE system_period @> NOW()) AS departments,
           (SELECT count(*) FROM health.positions WHERE system_period @> NOW()) AS positions,
           (SELECT count(*) FROM health.employments WHERE system_period @> NOW()) AS employments`
      );
      return result.rows[0];
    }
  });

  // Organization explorer: hierarchy payload for the 2D explorer —
  // departments with heads, positions with reporting lines, people with
  // position, grade, skills and project links. Structural fields only.
  app.get('/api/organization/explorer', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const q = limitSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const limit = q.data.limit;
      const departments = await query(
        `SELECT DISTINCT ON (d.logical_id)
                d.logical_id AS id, d.name, d.parent_department_id,
                p.logical_id AS head_person_id,
                ${DISPLAY_NAME} AS head_name,
                pos.logical_id AS head_position_id
         FROM health.departments d
         LEFT JOIN health.positions pos
           ON pos.department_id = d.logical_id AND pos.head_of_department_id IS NOT NULL
              AND pos.system_period @> NOW()
         LEFT JOIN health.persons p ON p.logical_id = pos.head_of_department_id
         WHERE d.system_period @> NOW()
         ORDER BY d.logical_id
         LIMIT $1`,
        [limit]
      );
      const positions = await query(
        `SELECT pos.logical_id AS id, pos.name AS title, pos.department_id,
                pos.head_of_department_id, prl.parent_position_id
         FROM health.positions pos
         LEFT JOIN health.position_reporting_lines prl
           ON prl.child_position_id = pos.logical_id AND prl.is_primary
         WHERE pos.system_period @> NOW()
         ORDER BY pos.logical_id
         LIMIT $1`,
        [limit]
      );
      const people = await query(
        `SELECT p.logical_id AS id, ${DISPLAY_NAME} AS name,
                e.position_id, pos.department_id, pos.grade_level AS grade,
                COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS skills,
                COALESCE(array_agg(DISTINCT pr.name) FILTER (WHERE pr.name IS NOT NULL), '{}') AS projects
         FROM health.persons p
         LEFT JOIN health.employments e ON e.person_id = p.logical_id AND e.system_period @> NOW()
         LEFT JOIN health.positions pos ON pos.logical_id = e.position_id AND pos.system_period @> NOW()
         LEFT JOIN health.person_skills ps ON ps.person_id = p.logical_id
         LEFT JOIN health.skills s ON s.skill_id = ps.skill_id
         LEFT JOIN health.project_members pm ON pm.person_id = p.logical_id
         LEFT JOIN health.projects pr ON pr.logical_id = pm.project_id
         WHERE p.logical_id <> $1::uuid
         GROUP BY p.logical_id, p.preferred_name, p.legal_name,
                  e.position_id, pos.department_id, pos.grade_level
         ORDER BY p.logical_id
         LIMIT $2`,
        [SYSTEM_PERSON_ID, limit]
      );
      return {
        departments: departments.rows,
        positions: positions.rows,
        people: people.rows,
      };
    }
  });
}

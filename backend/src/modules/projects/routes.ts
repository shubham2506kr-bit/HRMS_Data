import type { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { z } from 'zod';

/**
 * Roles that may mutate project structure.
 *
 * Deliberately does NOT use isPrivileged(): PRIVILEGED_ROLES contains
 * `auditor`, `finance` and `payroll`, none of which have a business need to
 * change project structure. `auditor` in particular must be read-only.
 */
const PROJECT_WRITE_ROLES: readonly string[] = [
  'direct_manager_of',
  'manager',
  'team_lead',
  'hr',
  'hr_generalist',
  'hr_admin',
  'hr_manager',
  'leadership',
  'senior_admin',
];

/**
 * Subset of the write roles that is org-scoped: these may manage projects in
 * any department and may create or manage department-less ("org-level")
 * projects. A department head is NOT org-scoped — it is confined to the
 * departments it actually heads. This closes the bypass where omitting
 * department_id produced a project that every manager-like account could edit.
 */
const PROJECT_ORG_WRITE_ROLES: readonly string[] = [
  'hr_admin',
  'hr_manager',
  'leadership',
  'senior_admin',
];

function canWriteProjects(roles: string[]): boolean {
  return roles.some((r) => PROJECT_WRITE_ROLES.includes(r));
}

function isOrgScoped(roles: string[]): boolean {
  return roles.some((r) => PROJECT_ORG_WRITE_ROLES.includes(r));
}

/** Hard ceiling on any page size this module will serve. */
const MAX_PAGE_SIZE = 500;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
});

const projectParams = z.object({ id: z.string().uuid() });

/** project_milestones.milestone_id is a SERIAL, not a UUID. */
const milestoneParams = z.object({
  id: z.string().uuid(),
  milestoneId: z.coerce.number().int().positive().max(2147483647),
});

const AUDIT_FAILURE = {
  error: 'Internal Server Error',
  message: 'Change could not be recorded in the audit trail and was not confirmed',
};

/**
 * Optional ISO calendar date. The frontend sends '' for an untouched date
 * field; previously that empty string reached a DATE column and produced a 500
 * that echoed a database error. Empty/null is normalised to absent, and
 * anything else must be a real YYYY-MM-DD date or the request is a 400.
 */
const optionalDate = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string().date().optional()
);

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Invalid request',
    details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** True when the actor holds an active position that heads `departmentId`. */
async function headsDepartment(personId: string, departmentId: string): Promise<boolean> {
  // NOTE: the head relationship lives on health.positions. The previous
  // implementation queried health.persons.department_id /
  // head_of_department_id, columns that do not exist on that table.
  const heads = await query(
    `SELECT 1 FROM health.positions
     WHERE department_id = $1 AND head_of_department_id = $2 AND system_period @> NOW()
     LIMIT 1`,
    [departmentId, personId]
  );
  return heads.rows.length > 0;
}

/**
 * Write-scope decision for a single project. Returns NOT_FOUND before any
 * authorization detail is disclosed for a project that does not exist.
 */
async function projectWriteScope(
  personId: string,
  roles: string[],
  projectId: string
): Promise<'OK' | 'NOT_FOUND' | 'FORBIDDEN'> {
  const pr = await query(
    `SELECT logical_id, department_id FROM health.projects WHERE logical_id = $1`,
    [projectId]
  );
  if (pr.rows.length === 0) return 'NOT_FOUND';
  if (isOrgScoped(roles)) return 'OK';
  const departmentId = pr.rows[0].department_id as string | null;
  // Department-less projects are org-level structure: department heads have no
  // claim on them.
  if (!departmentId) return 'FORBIDDEN';
  return (await headsDepartment(personId, departmentId)) ? 'OK' : 'FORBIDDEN';
}

export async function projectRoutes(app: FastifyInstance) {
  // List projects with staffing summary. Structural fields only; `lead_name`
  // is a preferred name, never a legal name.
  app.get('/api/projects', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const q = paginationSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const result = await query(
        `SELECT pr.logical_id, pr.name, pr.description, pr.status, pr.start_date, pr.end_date,
                d.name AS department_name,
                (SELECT count(*) FROM health.project_members pm WHERE pm.project_id = pr.logical_id) AS people_count,
                (SELECT p.preferred_name
                 FROM health.project_members pm
                 JOIN health.persons p ON p.logical_id = pm.person_id
                 WHERE pm.project_id = pr.logical_id AND pm.role = 'Lead'
                 LIMIT 1) AS lead_name
         FROM health.projects pr
         LEFT JOIN health.departments d ON d.logical_id = pr.department_id AND d.system_period @> NOW()
         ORDER BY pr.created_at, pr.logical_id
         LIMIT $1 OFFSET $2`,
        [q.data.page_size, (q.data.page - 1) * q.data.page_size]
      );
      return result.rows;
    }
  });

  // Project members. Legal names are not exposed here: the `name` column falls
  // back to an initial rather than the legal name when no preferred name is set.
  app.get('/api/projects/:id/members', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const p = projectParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const q = paginationSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const result = await query(
        `SELECT pm.role, p.logical_id,
                COALESCE(p.preferred_name, left(p.legal_name, 1) || '.') AS name,
                pos.name AS position_name, d.name AS department_name
         FROM health.project_members pm
         JOIN health.persons p ON p.logical_id = pm.person_id
         LEFT JOIN health.employments e ON e.person_id = p.logical_id AND e.system_period @> NOW()
         LEFT JOIN health.positions pos ON pos.logical_id = e.position_id AND pos.system_period @> NOW()
         LEFT JOIN health.departments d ON d.logical_id = pos.department_id AND d.system_period @> NOW()
         WHERE pm.project_id = $1
         ORDER BY pm.role DESC, p.preferred_name, p.logical_id
         LIMIT $2 OFFSET $3`,
        [p.data.id, q.data.page_size, (q.data.page - 1) * q.data.page_size]
      );
      return result.rows;
    }
  });

  // Project milestones with progress. `progress` is aggregated over the whole
  // project, not just the returned page, so pagination cannot skew it.
  app.get('/api/projects/:id/milestones', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const p = projectParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const q = paginationSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const result = await query(
        `SELECT milestone_id, title, due_date, status, created_at
         FROM health.project_milestones
         WHERE project_id = $1
         ORDER BY due_date NULLS LAST, milestone_id
         LIMIT $2 OFFSET $3`,
        [p.data.id, q.data.page_size, (q.data.page - 1) * q.data.page_size]
      );
      const totals = await query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'DONE')::int AS done
         FROM health.project_milestones
         WHERE project_id = $1`,
        [p.data.id]
      );
      const total = (totals.rows[0]?.total as number | undefined) ?? 0;
      const done = (totals.rows[0]?.done as number | undefined) ?? 0;
      return {
        milestones: result.rows,
        progress: total > 0 ? { done, total } : null,
      };
    }
  });

  // Add milestone — narrow write roles, scoped to the project's department.
  app.post('/api/projects/:id/milestones', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!canWriteProjects(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only manager, HR or leadership roles may add milestones' });
      }
      const p = projectParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const schema = z.object({
        title: z.string().trim().min(2).max(200),
        due_date: optionalDate,
        status: z.enum(['PLANNED', 'IN_PROGRESS', 'DONE']).default('PLANNED'),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const data = parsed.data;

      const scope = await projectWriteScope(request.user!.personId, request.user!.roles, p.data.id);
      if (scope === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'Project not found' });
      }
      if (scope === 'FORBIDDEN') {
        return reply.code(403).send({ error: 'Forbidden', message: 'You may only manage projects in departments you head' });
      }
      const result = await query(
        `INSERT INTO health.project_milestones (project_id, title, due_date, status)
         VALUES ($1, $2, $3, $4)
         RETURNING milestone_id, title, due_date, status`,
        [p.data.id, data.title, data.due_date ?? null, data.status]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'PROJECT_MILESTONE_CREATE',
        targetType: 'project_milestone',
        targetId: String(result.rows[0].milestone_id),
        details: { project_id: p.data.id, title: data.title },
        request,
      });
      if (!audited) return reply.code(500).send(AUDIT_FAILURE);
      return reply.code(201).send(result.rows[0]);
    }
  });

  // Update milestone status.
  app.put('/api/projects/:id/milestones/:milestoneId', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!canWriteProjects(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only manager, HR or leadership roles may update milestones' });
      }
      const p = milestoneParams.safeParse(request.params);
      if (!p.success) return badRequest(reply, p.error);
      const schema = z.object({ status: z.enum(['PLANNED', 'IN_PROGRESS', 'DONE']) });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);

      const scope = await projectWriteScope(request.user!.personId, request.user!.roles, p.data.id);
      if (scope === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'Project not found' });
      }
      if (scope === 'FORBIDDEN') {
        return reply.code(403).send({ error: 'Forbidden', message: 'You may only manage projects in departments you head' });
      }
      // IDOR fix: the scope check above authorizes :id, so the write must be
      // keyed on :id as well as the milestone. Keying on milestone_id alone let
      // a department head edit a milestone in any project by passing a project
      // it did control as :id.
      const result = await query(
        `UPDATE health.project_milestones SET status = $1
         WHERE milestone_id = $2 AND project_id = $3
         RETURNING milestone_id, title, due_date, status`,
        [parsed.data.status, p.data.milestoneId, p.data.id]
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Milestone not found' });
      }
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'PROJECT_MILESTONE_UPDATE',
        targetType: 'project_milestone',
        targetId: String(p.data.milestoneId),
        details: { project_id: p.data.id, status: parsed.data.status },
        request,
      });
      if (!audited) return reply.code(500).send(AUDIT_FAILURE);
      return result.rows[0];
    }
  });

  // Project dependencies (which projects block which) — structural only.
  app.get('/api/projects/dependencies', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const q = paginationSchema.safeParse(request.query);
      if (!q.success) return badRequest(reply, q.error);
      const result = await query(
        `SELECT pd.project_id, pr.name AS project_name,
                pd.depends_on_project_id, dp.name AS depends_on_name
         FROM health.project_dependencies pd
         JOIN health.projects pr ON pr.logical_id = pd.project_id
         JOIN health.projects dp ON dp.logical_id = pd.depends_on_project_id
         ORDER BY pr.name, pd.project_id, pd.depends_on_project_id
         LIMIT $1 OFFSET $2`,
        [q.data.page_size, (q.data.page - 1) * q.data.page_size]
      );
      return result.rows;
    }
  });

  // Create project — narrow write roles (organization-edge mutation).
  app.post('/api/projects', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      if (!canWriteProjects(request.user!.roles)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only manager, HR or leadership roles may create projects',
        });
      }

      const schema = z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().max(500).optional(),
        status: z.enum(['PLANNED', 'ONGOING', 'FINISHED']).default('ONGOING'),
        start_date: optionalDate,
        end_date: optionalDate,
        department_id: z.string().uuid().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const data = parsed.data;
      if (data.start_date && data.end_date && data.end_date < data.start_date) {
        return reply.code(400).send({ error: 'Validation Error', message: 'end_date must not precede start_date' });
      }

      const orgScoped = isOrgScoped(request.user!.roles);
      if (data.department_id) {
        if (!orgScoped && !(await headsDepartment(request.user!.personId, data.department_id))) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'You may only attach projects to departments you head',
          });
        }
      } else if (!orgScoped) {
        // Bypass fix: omitting department_id used to create an unscoped project
        // that any manager-like account could then manage.
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only HR or leadership roles may create org-level projects; supply department_id',
        });
      }
      const result = await query(
        `INSERT INTO health.projects (name, description, status, start_date, end_date, department_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING logical_id, name, status`,
        [data.name, data.description ?? null, data.status, data.start_date ?? null, data.end_date ?? null, data.department_id ?? null]
      );
      const row = result.rows[0];
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'CREATE',
        targetType: 'project',
        targetId: row.logical_id,
        details: { name: row.name, status: row.status, department_id: data.department_id ?? null },
        request,
      });
      if (!audited) return reply.code(500).send(AUDIT_FAILURE);
      await emitEvent({
        type: 'ProjectCreated',
        source: 'projects:create',
        actorPersonId: request.user!.personId,
        payload: { project_id: row.logical_id, name: row.name, status: row.status },
      });
      return reply.code(201).send(row);
    }
  });
}

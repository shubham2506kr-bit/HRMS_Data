import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { isPrivileged } from '../../lib/access.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { z } from 'zod';

const GOAL_STATUS = ['TODO', 'IN_PROGRESS', 'DONE'] as const;

// Hard page-size caps. Nothing in this module returns an unbounded list.
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100;
const MAX_OFFSET = 10_000;
const MAX_SKILLS = 500;
const MAX_GAPS = 100;
const MAX_PATHS = 25;
const MAX_OPPORTUNITIES = 100;
const MAX_MILESTONES = 100;

function validationFailed(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Request validation failed',
    fields: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
  });
}

function auditUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: 'Audit Unavailable',
    message: 'The action could not be recorded in the audit trail; please retry.',
  });
}

/** person_id must be a UUID: an unvalidated value reached Postgres and turned a
 *  bad request into a 500 carrying a driver error message. */
const subjectQuerySchema = z.object({
  person_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

export async function growthRoutes(app: FastifyInstance) {
  // --- Goals (owned by the person who created them) ---

  app.get('/api/goals', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = subjectQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const subject = parsed.data.person_id ?? request.user!.personId;
      // The guard and the SQL key on the SAME identifier (`subject`).
      if (subject !== request.user!.personId && !isPrivileged(request.user!.roles)) {
        return { goals: [] };
      }
      const result = await query(
        `SELECT goal_id, person_id, title, description, due_date, status, created_at
         FROM health.goals WHERE person_id = $1 AND system_period @> NOW()
         ORDER BY status = 'DONE', due_date NULLS LAST, created_at DESC
         LIMIT $2 OFFSET $3`,
        [subject, parsed.data.limit ?? DEFAULT_PAGE_SIZE, parsed.data.offset ?? 0]
      );
      return { goals: result.rows };
    }
  });

  app.post('/api/goals', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2000).optional(),
        due_date: z.string().date().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;
      const result = await query(
        `INSERT INTO health.goals (person_id, title, description, due_date, status, created_by)
         VALUES ($1, $2, $3, $4, 'TODO', $1)
         RETURNING goal_id, person_id, title, description, due_date, status, created_at`,
        [request.user!.personId, data.title, data.description ?? null, data.due_date ?? null]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'GOAL_CREATE',
        targetType: 'goal',
        targetId: result.rows[0].goal_id,
        request,
      });
      if (!audited) return auditUnavailable(reply);
      await emitEvent({
        type: 'GoalCreated',
        source: 'growth:goal',
        actorPersonId: request.user!.personId,
        payload: { goal_id: result.rows[0].goal_id, title: data.title },
      });
      return reply.code(201).send(result.rows[0]);
    }
  });

  app.patch('/api/goals/:id', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) return validationFailed(reply, parsedParams.error);
      const { id } = parsedParams.data;
      const schema = z.object({
        status: z.enum(GOAL_STATUS).optional(),
        title: z.string().min(3).max(200).optional(),
        description: z.string().max(2000).optional(),
        due_date: z.string().date().nullable().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;
      const owned = await query(
        `SELECT goal_id FROM health.goals
         WHERE goal_id = $1 AND person_id = $2 AND system_period @> NOW()`,
        [id, request.user!.personId]
      );
      if (owned.rows.length === 0) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You may only update your own goals' });
      }
      // The UPDATE repeats the ownership predicate: the pre-check alone left a
      // window in which the row could be keyed by id only.
      const result = await query(
        `UPDATE health.goals SET
           status = COALESCE($3, status),
           title = COALESCE($4, title),
           description = COALESCE($5, description),
           due_date = COALESCE($6, due_date),
           updated_at = NOW()
         WHERE goal_id = $1 AND person_id = $2 AND system_period @> NOW()
         RETURNING goal_id, person_id, title, description, due_date, status, created_at`,
        [id, request.user!.personId, data.status ?? null, data.title ?? null, data.description ?? null, data.due_date ?? null]
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Goal not found' });
      }
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'GOAL_UPDATE',
        targetType: 'goal',
        targetId: id,
        details: { status: data.status ?? null },
        request,
      });
      if (!audited) return auditUnavailable(reply);
      return result.rows[0];
    }
  });

  // --- Certifications (self or privileged) ---

  app.get('/api/certifications', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = subjectQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const subject = parsed.data.person_id ?? request.user!.personId;
      if (subject !== request.user!.personId && !isPrivileged(request.user!.roles)) {
        return { certifications: [] };
      }
      const result = await query(
        `SELECT cert_id, person_id, name, issuer, issued_on, expires_on, credential_id, created_at
         FROM health.certifications WHERE person_id = $1 AND system_period @> NOW()
         ORDER BY expires_on NULLS LAST
         LIMIT $2 OFFSET $3`,
        [subject, parsed.data.limit ?? DEFAULT_PAGE_SIZE, parsed.data.offset ?? 0]
      );
      return { certifications: result.rows };
    }
  });

  app.post('/api/certifications', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z.object({
        name: z.string().min(2).max(200),
        issuer: z.string().min(2).max(200),
        issued_on: z.string().date(),
        expires_on: z.string().date().nullable().optional(),
        credential_id: z.string().max(200).optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;
      const result = await query(
        `INSERT INTO health.certifications (person_id, name, issuer, issued_on, expires_on, credential_id, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $1)
         RETURNING cert_id, person_id, name, issuer, issued_on, expires_on, credential_id, created_at`,
        [request.user!.personId, data.name, data.issuer, data.issued_on, data.expires_on ?? null, data.credential_id ?? null]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'CERTIFICATION_ADD',
        targetType: 'certification',
        targetId: result.rows[0].cert_id,
        request,
      });
      if (!audited) return auditUnavailable(reply);
      await emitEvent({
        type: 'CertificationAdded',
        source: 'growth:certification',
        actorPersonId: request.user!.personId,
        payload: { cert_id: result.rows[0].cert_id, name: data.name },
      });
      return reply.code(201).send(result.rows[0]);
    }
  });

  // --- Skills (self or privileged; graph edges included for the spatial view) ---

  app.get('/api/skills', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = subjectQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const subject = parsed.data.person_id ?? request.user!.personId;
      if (subject !== request.user!.personId && !isPrivileged(request.user!.roles)) {
        return { skills: [], relations: [] };
      }
      const skills = await query(
        `SELECT s.skill_id, s.name, s.cluster, ps.level
         FROM health.skills s
         LEFT JOIN health.person_skills ps ON ps.skill_id = s.skill_id AND ps.person_id = $1
         ORDER BY s.cluster, s.name
         LIMIT $2`,
        [subject, MAX_SKILLS]
      );
      const relations = await query(
        `SELECT sr.from_skill_id, sr.to_skill_id FROM health.skill_relations sr LIMIT $1`,
        [MAX_SKILLS * 4]
      );
      return { skills: skills.rows, relations: relations.rows };
    }
  });

  app.post('/api/skills/me', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z.object({ skill_id: z.string().uuid(), level: z.number().int().min(1).max(5) });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;
      // person_id is always the caller: there is no path to write another
      // person's skill level from this route.
      const result = await query(
        `INSERT INTO health.person_skills (person_id, skill_id, level, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (person_id, skill_id) DO UPDATE SET level = EXCLUDED.level, updated_at = NOW()
         RETURNING person_id, skill_id, level`,
        [request.user!.personId, data.skill_id, data.level]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'SKILL_SET_LEVEL',
        targetType: 'person_skill',
        targetId: data.skill_id,
        details: { level: data.level },
        request,
      });
      if (!audited) return auditUnavailable(reply);
      return result.rows[0];
    }
  });

  // --- My Growth: the assembled career dashboard (all real data) ---

  app.get('/api/growth/me', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const personId = request.user!.personId;

      const me = await query(
        `SELECT p.logical_id AS person_id, COALESCE(p.preferred_name, p.legal_name) AS name,
                pos.name AS role, pos.grade_level AS grade, d.name AS department,
                e.started_at, d.logical_id AS department_id, pos.logical_id AS position_id
         FROM health.persons p
         LEFT JOIN health.employments e ON e.person_id = p.logical_id AND e.system_period @> NOW()
         LEFT JOIN health.positions pos ON pos.logical_id = e.position_id
         LEFT JOIN health.departments d ON d.logical_id = pos.department_id
         WHERE p.logical_id = $1`,
        [personId]
      );
      const profile = me.rows[0];
      if (!profile) return { error: 'no employment profile' };

      const mySkills = await query(
        `SELECT s.skill_id, s.name, s.cluster, ps.level
         FROM health.person_skills ps JOIN health.skills s ON s.skill_id = ps.skill_id
         WHERE ps.person_id = $1 ORDER BY ps.level DESC, s.name
         LIMIT $2`,
        [personId, MAX_SKILLS]
      );
      const skills = mySkills.rows;
      const mySkillIds = new Set(skills.map((s) => s.skill_id));

      // What I need: related skills (via skill_relations) I don't have yet.
      const gaps = await query(
        `SELECT DISTINCT s.skill_id, s.name, s.cluster, r.relation, source.name AS source_name
         FROM health.skill_relations r
         JOIN health.skills s ON s.skill_id = r.to_skill_id
         JOIN health.skills source ON source.skill_id = r.from_skill_id
         WHERE r.from_skill_id = ANY($1::uuid[]) AND NOT r.to_skill_id = ANY($1::uuid[])
         ORDER BY s.cluster, s.name
         LIMIT $2`,
        [Array.from(mySkillIds), MAX_GAPS]
      );

      // Career paths: one step up from where I am — the seat directly above
      // me (reporting parent), the department head seat, and higher grades
      // within my department. All real positions.
      const paths = await query(
        `WITH my_parent AS (
           SELECT prl.parent_position_id AS seat_id
           FROM health.position_reporting_lines prl
           WHERE prl.child_position_id = $1 AND prl.is_primary
         )
         SELECT DISTINCT ON (pos.logical_id)
                pos.logical_id AS position_id, pos.name AS role, pos.grade_level AS grade,
                d.name AS department, pos.head_of_department_id,
                (my_parent.seat_id = pos.logical_id) AS is_parent_seat,
                holder.logical_id AS holder_id, COALESCE(holder.preferred_name, holder.legal_name) AS holder_name
         FROM health.positions pos
         LEFT JOIN health.departments d ON d.logical_id = pos.department_id
         LEFT JOIN health.employments e ON e.position_id = pos.logical_id AND e.system_period @> NOW()
         LEFT JOIN health.persons holder ON holder.logical_id = e.person_id
         CROSS JOIN my_parent
         WHERE pos.system_period @> NOW()
           AND pos.logical_id <> $1
           AND (
             my_parent.seat_id = pos.logical_id
             OR (pos.department_id = $2 AND pos.grade_level > $3)
           )
         ORDER BY pos.logical_id, pos.grade_level DESC
         LIMIT $4`,
        [profile.position_id, profile.department_id, profile.grade, MAX_PATHS]
      );

      // For each path, compute the holder's skills so we can explain gaps.
      // NOTE: this discloses the skill list of the named colleague who holds a
      // seat above the caller. That is the career-path feature working as
      // designed; it is bounded to seats in the caller's own reporting line or
      // department, and no other attribute of the holder is exposed.
      const pathRows = paths.rows;
      const pathSkills = await query(
        `SELECT e.person_id, s.name AS skill
         FROM health.employments e
         JOIN health.person_skills ps ON ps.person_id = e.person_id
         JOIN health.skills s ON s.skill_id = ps.skill_id
         WHERE e.system_period @> NOW() AND e.person_id = ANY($1::uuid[])
         ORDER BY s.name
         LIMIT $2`,
        [pathRows.map((p) => p.holder_id).filter(Boolean), MAX_PATHS * 50]
      );
      const skillsByPerson = new Map<string, string[]>();
      for (const r of pathSkills.rows) {
        const arr = skillsByPerson.get(r.person_id) ?? [];
        arr.push(r.skill);
        skillsByPerson.set(r.person_id, arr);
      }

      const pathsOut = pathRows.map((p) => {
        const holderSkills = p.holder_id ? (skillsByPerson.get(p.holder_id) ?? []) : [];
        const already = skills.filter((s) => holderSkills.includes(s.name)).map((s) => s.name);
        const need = p.holder_id
          ? holderSkills.filter((s) => !skills.some((k) => k.name === s))
          : gaps.rows.map((g: { name: string }) => g.name);
        return {
          position_id: p.position_id,
          role: p.role,
          grade: p.grade,
          department: p.department,
          kind: p.is_parent_seat ? 'leadership' : 'promotion',
          vacant: !p.holder_id,
          holder_name: p.holder_name,
          already_demonstrated: already,
          development_areas: need.slice(0, 6),
        };
      });

      // Internal opportunities: vacant positions and headships (real, open).
      const opportunities = await query(
        `SELECT pos.logical_id AS position_id, pos.name AS role, pos.grade_level AS grade,
                d.name AS department, pos.head_of_department_id
         FROM health.positions pos
         LEFT JOIN health.departments d ON d.logical_id = pos.department_id
         WHERE pos.system_period @> NOW()
           AND NOT EXISTS (
             SELECT 1 FROM health.employments e
             WHERE e.position_id = pos.logical_id AND e.system_period @> NOW()
           )
         ORDER BY d.name, pos.grade_level
         LIMIT $1`,
        [MAX_OPPORTUNITIES]
      );

      const goals = await query(
        `SELECT goal_id, title, status, due_date, created_at
         FROM health.goals WHERE person_id = $1 AND system_period @> NOW()
         ORDER BY status = 'DONE', due_date NULLS LAST
         LIMIT $2`,
        [personId, DEFAULT_PAGE_SIZE]
      );
      const certifications = await query(
        `SELECT cert_id, name, issuer, issued_on, expires_on
         FROM health.certifications WHERE person_id = $1 ORDER BY issued_on
         LIMIT $2`,
        [personId, DEFAULT_PAGE_SIZE]
      );

      // Milestones: verified events only — joined, certifications, goals.
      type Milestone = { date: string; kind: string; title: string };
      const milestones: Milestone[] = [
        ...(profile.started_at
          ? [{ date: new Date(profile.started_at).toISOString().slice(0, 10), kind: 'joined', title: `Joined ${profile.department ?? 'the company'} as ${profile.role ?? 'a team member'}` }]
          : []),
        ...certifications.rows.map((c: { issued_on: string; name: string }) => ({ date: new Date(c.issued_on).toISOString().slice(0, 10), kind: 'certification', title: `Earned ${c.name}` })),
        ...goals.rows
          .filter((g: { status: string }) => g.status === 'DONE')
          .map((g: { created_at: string; title: string }) => ({ date: new Date(g.created_at).toISOString().slice(0, 10), kind: 'milestone', title: `Completed goal: ${g.title}` })),
      ]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, MAX_MILESTONES);

      return {
        profile: {
          name: profile.name,
          role: profile.role,
          grade: profile.grade,
          department: profile.department,
          joined: profile.started_at,
          direction: topCluster(skills),
        },
        skills,
        gaps: gaps.rows,
        paths: pathsOut,
        opportunities: opportunities.rows,
        goals: goals.rows,
        certifications: certifications.rows,
        milestones,
      };
    }
  });
}

function topCluster(skills: { cluster: string; level: number }[]): string | null {
  if (skills.length === 0) return null;
  const byCluster = new Map<string, { sum: number; count: number }>();
  for (const s of skills) {
    const cur = byCluster.get(s.cluster) ?? { sum: 0, count: 0 };
    cur.sum += s.level;
    cur.count += 1;
    byCluster.set(s.cluster, cur);
  }
  let best: { cluster: string; avg: number } | null = null;
  for (const [cluster, v] of byCluster) {
    const avg = v.sum / v.count;
    if (!best || avg > best.avg) best = { cluster, avg };
  }
  return best?.cluster ?? null;
}
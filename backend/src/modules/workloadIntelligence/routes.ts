import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { isPrivileged } from '../../lib/access.js';
import { writeAudit } from '../../lib/audit.js';
import { config } from '../../config/index.js';
import { WINDOW_DAYS, computeWorkloadSignals } from './signals.js';
import { teamHealthIndex } from './teamHealth.js';
import { z } from 'zod';

// Workload intelligence is its own organizational plane: policy states for
// individuals, explainable aggregates for teams, and a composite team health
// index built ONLY from real attendance/leave numbers. It never touches the
// wellbeing advisor, and aggregated views are masked below MIN_GROUP.
const MIN_GROUP = 5;

// Hard read caps. A department query used to pull every attendance row for
// every member with no ceiling at all.
const MAX_MEMBERS = 500;
const MAX_EVENT_ROWS = 100_000;
const MAX_LISTED_PEOPLE = 100;

// Day boundaries and the late-night window are evaluated in the organization
// timezone, not the server's.
const SIGNAL_OPTS = { timeZone: config.ORG_TIMEZONE } as const;

/**
 * Roles that may see per-person workload states for people they do not line
 * manage. Deliberately NARROWER than isPrivileged(): finance, payroll and
 * auditor are privileged over employment records but have no business reading
 * an inference about how late a named colleague has been working. Both checks
 * must pass, so a single mis-derived role cannot open this surface.
 */
const WELLBEING_VIEWER_ROLES = ['hr', 'hr_generalist', 'hr_manager', 'hr_admin', 'leadership', 'senior_admin'];

function mayViewWellbeingAcrossOrg(roles: string[]): boolean {
  return isPrivileged(roles) && roles.some((r) => WELLBEING_VIEWER_ROLES.includes(r));
}

/**
 * Verified line-management, read from the position graph at request time on the
 * SAME department_id that the member query keys on. Nothing here trusts a
 * `direct_manager_of` style claim carried on the token.
 */
async function headsDepartment(personId: string, departmentId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1
     FROM health.positions p
     WHERE p.department_id = $1 AND p.head_of_department_id = $2 AND p.system_period @> NOW()
     LIMIT 1`,
    [departmentId, personId]
  );
  return result.rows.length > 0;
}

const departmentQuerySchema = z.object({
  department_id: z.string().uuid(),
});

function invalidDepartment(reply: FastifyReply) {
  return reply.code(400).send({ error: 'department_id must be a UUID' });
}

function auditUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: 'Audit Unavailable',
    message: 'This view could not be recorded in the audit trail, so it was not served.',
  });
}

/** Parse and validate `?department_id=` without leaking a driver error. */
function readDepartmentId(rawQuery: unknown): { ok: true; id: string } | { ok: false; missing: boolean } {
  const raw = (rawQuery ?? {}) as Record<string, unknown>;
  if (raw['department_id'] === undefined || raw['department_id'] === '') {
    return { ok: false, missing: true };
  }
  const parsed = departmentQuerySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, missing: false };
  return { ok: true, id: parsed.data.department_id };
}

/** The declared basis of every state in this module, returned with the numbers. */
const SIGNAL_BASIS = computeWorkloadSignals([], SIGNAL_OPTS).basis;

export async function workloadIntelligenceRoutes(app: FastifyInstance) {
  // My workload signals (private to the person).
  // Policy states: NORMAL / WATCH / ELEVATED / HIGH / CRITICAL (see POLICY_RULES).
  // When the state reaches ELEVATED or higher, a discreet escalation trail is
  // opened for the person — visible only to their manager/team lead, never in
  // public surfaces. When the state returns below ELEVATED, the trail clears.
  // The response tells the person that this trail exists: a signal that becomes
  // visible to someone else must not be invisible to its subject.
  app.get('/api/workload/me', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const events = await query(
        `SELECT person_id, event_type, occurred_at FROM health.attendance_events
         WHERE person_id = $1 AND occurred_at >= NOW() - ($2 || ' days')::interval
         ORDER BY occurred_at
         LIMIT $3`,
        [request.user!.personId, WINDOW_DAYS, MAX_EVENT_ROWS]
      );
      const result = computeWorkloadSignals(events.rows, SIGNAL_OPTS);

      let escalationOpen = false;
      if (result.state === 'ELEVATED' || result.state === 'HIGH' || result.state === 'CRITICAL') {
        escalationOpen = true;
        const opened = await query(
          `INSERT INTO health.workload_escalations (person_id, state, last_recorded_at)
           SELECT $1, $2, NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM health.workload_escalations
             WHERE person_id = $1 AND cleared_at IS NULL
           )
           RETURNING escalation_id`,
          [request.user!.personId, result.state]
        );
        await query(
          `UPDATE health.workload_escalations SET state = $2, last_recorded_at = NOW()
           WHERE person_id = $1 AND cleared_at IS NULL`,
          [request.user!.personId, result.state]
        );
        // Audit the transition only — not every read — so the log records when a
        // manager-visible trail came into existence.
        if (opened.rows.length > 0) {
          const audited = await writeAudit({
            personId: request.user!.personId,
            action: 'WORKLOAD_ESCALATION_OPEN',
            targetType: 'workload_escalation',
            targetId: request.user!.personId,
            details: { state: result.state },
            request,
          });
          if (!audited) return auditUnavailable(reply);
        }
      } else {
        const cleared = await query(
          `UPDATE health.workload_escalations SET cleared_at = NOW()
           WHERE person_id = $1 AND cleared_at IS NULL
           RETURNING escalation_id`,
          [request.user!.personId]
        );
        if (cleared.rows.length > 0) {
          const audited = await writeAudit({
            personId: request.user!.personId,
            action: 'WORKLOAD_ESCALATION_CLEAR',
            targetType: 'workload_escalation',
            targetId: request.user!.personId,
            request,
          });
          if (!audited) return auditUnavailable(reply);
        }
      }

      return {
        ...result,
        escalation: {
          open: escalationOpen,
          visible_to: escalationOpen
            ? 'your department head, and HR or leadership'
            : 'no one — no trail is open',
          clears_when: 'your policy state returns below ELEVATED',
        },
      };
    }
  });

  // Discreet team workload view — department head / TL or an HR/leadership role.
  // States are shown per person; only ELEVATED+ people appear with a minimal
  // reason code, and never in shared/public surfaces.
  app.get('/api/workload/team', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const dept = readDepartmentId(request.query);
      if (!dept.ok) {
        return dept.missing
          ? reply.code(400).send({ error: 'department_id is required' })
          : invalidDepartment(reply);
      }
      const departmentId = dept.id;

      const isHead = await headsDepartment(request.user!.personId, departmentId);
      if (!isHead && !mayViewWellbeingAcrossOrg(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only the department head or a TL may view team workload' });
      }

      // Every subsequent query keys on the same departmentId that was authorised.
      const members = await query(
        `SELECT e.person_id, p.name AS position, d.name AS department
         FROM health.employments e
         JOIN health.positions p ON p.logical_id = e.position_id AND p.system_period @> NOW()
         JOIN health.departments d ON d.logical_id = p.department_id
         WHERE p.department_id = $1 AND e.status = 'ACTIVE' AND e.system_period @> NOW()
         ORDER BY e.person_id
         LIMIT $2`,
        [departmentId, MAX_MEMBERS]
      );
      const memberIds = members.rows.map((m) => m.person_id);

      const events = await query(
        `SELECT person_id, event_type, occurred_at FROM health.attendance_events
         WHERE person_id = ANY($1::uuid[]) AND occurred_at >= NOW() - ($2 || ' days')::interval
         LIMIT $3`,
        [memberIds, WINDOW_DAYS, MAX_EVENT_ROWS]
      );

      const openEsc = await query(
        `SELECT person_id, state, first_recorded_at, last_recorded_at FROM health.workload_escalations
         WHERE person_id = ANY($1::uuid[]) AND cleared_at IS NULL
         LIMIT $2`,
        [memberIds, MAX_MEMBERS]
      );
      const escByPerson = new Map(openEsc.rows.map((e) => [e.person_id, e]));

      const perPerson = members.rows.map((m) => {
        const w = computeWorkloadSignals(events.rows.filter((e) => e.person_id === m.person_id), SIGNAL_OPTS);
        const esc = escByPerson.get(m.person_id);
        return {
          person_id: m.person_id,
          position: m.position,
          department: m.department,
          state: w.state,
          score: w.score,
          escalation: esc ? { state: esc.state, first_recorded_at: esc.first_recorded_at, last_recorded_at: esc.last_recorded_at } : null,
        };
      });

      const distribution = (['NORMAL', 'WATCH', 'ELEVATED', 'HIGH', 'CRITICAL'] as const).map((s) => ({
        state: s,
        count: perPerson.filter((p) => p.state === s).length,
      }));
      const escalated = perPerson.filter((p) => p.escalation);

      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'WORKLOAD_TEAM_VIEW',
        targetType: 'team_workload',
        targetId: departmentId,
        details: {
          member_count: perPerson.length,
          escalated_count: escalated.length,
          access_path: isHead ? 'department_head' : 'privileged_role',
        },
        request,
      });
      if (!audited) return auditUnavailable(reply);

      return {
        member_count: perPerson.length,
        distribution,
        escalated_count: escalated.length,
        escalated: escalated.slice(0, MAX_LISTED_PEOPLE),
        escalated_truncated: escalated.length > MAX_LISTED_PEOPLE,
        members_truncated: members.rows.length === MAX_MEMBERS,
        basis: SIGNAL_BASIS,
        note: 'This is a per-person view for the line manager of this department, so MIN_GROUP masking does not apply to it. Each state is a threshold on clock-event timestamps, not a judgement about the person.',
      };
    }
  });

  // Team health intelligence (department head or an HR/leadership role) — the
  // explainable composite. Aggregates are only shown when the group has at
  // least MIN_GROUP members.
  app.get('/api/team-health', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const dept = readDepartmentId(request.query);
      if (!dept.ok) {
        return dept.missing
          ? reply.code(400).send({ error: 'department_id is required' })
          : invalidDepartment(reply);
      }
      const departmentId = dept.id;

      const isHead = await headsDepartment(request.user!.personId, departmentId);
      if (!isHead && !mayViewWellbeingAcrossOrg(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only the department head may view team health' });
      }

      const members = await query(
        `SELECT e.person_id FROM health.employments e
         JOIN health.positions pos ON pos.logical_id = e.position_id
         WHERE pos.department_id = $1 AND e.status = 'ACTIVE' AND e.system_period @> NOW()
         ORDER BY e.person_id
         LIMIT $2`,
        [departmentId, MAX_MEMBERS]
      );

      if (members.rows.length < MIN_GROUP) {
        const audited = await writeAudit({
          personId: request.user!.personId,
          action: 'TEAM_HEALTH_VIEW',
          targetType: 'team_health',
          targetId: departmentId,
          details: {
            masked: true,
            member_count: members.rows.length,
            min_group: MIN_GROUP,
            access_path: isHead ? 'department_head' : 'privileged_role',
          },
          request,
        });
        if (!audited) return auditUnavailable(reply);
        return {
          masked: true,
          member_count: members.rows.length,
          min_group: MIN_GROUP,
          message: `Aggregates are hidden until a group has at least ${MIN_GROUP} members, to protect individuals.`,
        };
      }

      const memberIds = members.rows.map((m) => m.person_id);
      const events = await query(
        `SELECT person_id, event_type, occurred_at FROM health.attendance_events
         WHERE person_id = ANY($1::uuid[]) AND occurred_at >= NOW() - ($2 || ' days')::interval
         LIMIT $3`,
        [memberIds, WINDOW_DAYS, MAX_EVENT_ROWS]
      );

      // Leave is read as a COUNT OF PEOPLE only: no leave type, no reason, no
      // medical detail is selected, so nothing here can disclose why someone
      // was away.
      const leave = await query(
        `SELECT DISTINCT person_id FROM health.leave_requests
         WHERE person_id = ANY($1::uuid[])
           AND status = 'APPROVED'
           AND system_period @> NOW()
           AND start_date::date <= CURRENT_DATE
           AND end_date::date >= CURRENT_DATE - ($2 || ' days')::interval
         LIMIT $3`,
        [memberIds, WINDOW_DAYS, MAX_MEMBERS]
      );
      const leavePersonSet = new Set(leave.rows.map((r) => r.person_id));

      const byPerson = new Map<string, ReturnType<typeof computeWorkloadSignals>>();
      for (const m of members.rows) {
        byPerson.set(m.person_id, computeWorkloadSignals(events.rows.filter((e) => e.person_id === m.person_id), SIGNAL_OPTS));
      }
      const states = ['CRITICAL', 'HIGH', 'ELEVATED', 'WATCH', 'NORMAL'] as const;
      const distribution = states.map((s) => ({
        state: s,
        count: [...byPerson.values()].filter((v) => v.state === s).length,
      }));
      const flagged = [...byPerson.entries()].filter(([, v]) => v.state === 'ELEVATED' || v.state === 'HIGH' || v.state === 'CRITICAL');

      const values = [...byPerson.values()];
      const dimensions = {
        workload_balance: {
          healthy: values.filter((v) => v.state === 'NORMAL' || v.state === 'WATCH').length,
          watch: values.filter((v) => v.state === 'WATCH').length,
          elevated_or_higher: values.filter((v) => v.state !== 'NORMAL' && v.state !== 'WATCH').length,
          healthy_pct: values.length ? Math.round((values.filter((v) => v.state === 'NORMAL' || v.state === 'WATCH').length / values.length) * 100) : null,
        },
        rest: {
          with_short_rest: values.filter((v) => v.minGap != null && v.minGap < 7).length,
          with_late_night: values.filter((v) => v.lateNight > 0).length,
          healthy_pct: values.length ? Math.round(((values.length - values.filter((v) => v.minGap != null && v.minGap < 7).length - values.filter((v) => v.lateNight > 0).length) / values.length) * 100) : null,
        },
        attendance: {
          active_members: values.filter((v) => v.workDays > 0).length,
          coverage_pct: members.rows.length ? Math.round((values.filter((v) => v.workDays > 0).length / members.rows.length) * 100) : null,
        },
      };

      const index = teamHealthIndex({
        memberCount: members.rows.length,
        states: values.map((v) => v.state),
        lateNightCounts: values.map((v) => v.lateNight),
        minGaps: values.map((v) => v.minGap),
        workDays: values.map((v) => v.workDays),
        approvedLeaveMemberCount: leavePersonSet.size,
      });

      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'TEAM_HEALTH_VIEW',
        targetType: 'team_health',
        targetId: departmentId,
        details: {
          masked: false,
          member_count: members.rows.length,
          flagged_count: flagged.length,
          access_path: isHead ? 'department_head' : 'privileged_role',
        },
        request,
      });
      if (!audited) return auditUnavailable(reply);

      return {
        masked: false,
        member_count: members.rows.length,
        distribution,
        dimensions,
        index,
        flagged_count: flagged.length,
        flags: flagged.slice(0, MAX_LISTED_PEOPLE).map(([personId, v]) => ({
          person_id: personId,
          state: v.state,
          signals: v.signals.filter((s) => s.severity !== 'LOW').map((s) => s.code),
        })),
        flags_truncated: flagged.length > MAX_LISTED_PEOPLE,
        members_truncated: members.rows.length === MAX_MEMBERS,
        basis: SIGNAL_BASIS,
        note: 'Per-person flags are scheduling indicators derived from clock events for members of this department only. They are not health information and carry no leave reason.',
      };
    }
  });

  // Leadership environment scorecard — department head or an HR/leadership role.
  // Aggregates the leader's department (and sub-departments) from REAL inputs.
  // Groups under MIN_GROUP are suppressed, never invented.
  app.get('/api/leadership/scorecard', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const dept = readDepartmentId(request.query);
      if (!dept.ok) {
        return dept.missing
          ? reply.code(400).send({ error: 'department_id is required' })
          : invalidDepartment(reply);
      }
      const departmentId = dept.id;

      const isHead = await headsDepartment(request.user!.personId, departmentId);
      if (!isHead && !mayViewWellbeingAcrossOrg(request.user!.roles)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only the department head may view the leadership scorecard' });
      }

      // Scope descends from the authorised department only.
      const scope = await query(
        `WITH RECURSIVE dept_tree AS (
           SELECT d.logical_id FROM health.departments d WHERE d.logical_id = $1
           UNION ALL
           SELECT d.logical_id
           FROM health.departments d
           JOIN dept_tree t ON d.parent_department_id = t.logical_id
         )
         SELECT t.logical_id FROM dept_tree t LIMIT $2`,
        [departmentId, MAX_MEMBERS]
      );
      const scopeIds = scope.rows.map((r) => r.logical_id);

      const members = await query(
        `SELECT e.person_id, pos.department_id
         FROM health.employments e
         JOIN health.positions pos ON pos.logical_id = e.position_id
         WHERE pos.department_id = ANY($1::uuid[]) AND e.status = 'ACTIVE' AND e.system_period @> NOW()
         ORDER BY e.person_id
         LIMIT $2`,
        [scopeIds, MAX_MEMBERS]
      );

      const groups = await query(
        `SELECT d.logical_id, d.name, COUNT(e.person_id) AS member_count
         FROM health.departments d
         LEFT JOIN health.positions pos ON pos.department_id = d.logical_id
         LEFT JOIN health.employments e ON e.position_id = pos.logical_id AND e.status = 'ACTIVE' AND e.system_period @> NOW()
         WHERE d.logical_id = ANY($1::uuid[])
         GROUP BY d.logical_id, d.name
         LIMIT $2`,
        [scopeIds, MAX_MEMBERS]
      );
      const masked_groups = groups.rows
        .filter((g) => Number(g.member_count) > 0 && Number(g.member_count) < MIN_GROUP)
        .map((g) => ({ name: g.name, member_count: Number(g.member_count) }));

      if (members.rows.length < MIN_GROUP) {
        const audited = await writeAudit({
          personId: request.user!.personId,
          action: 'LEADERSHIP_SCORECARD_VIEW',
          targetType: 'scorecard',
          targetId: departmentId,
          details: {
            masked: true,
            member_count: members.rows.length,
            access_path: isHead ? 'department_head' : 'privileged_role',
          },
          request,
        });
        if (!audited) return auditUnavailable(reply);
        return {
          masked: true,
          member_count: members.rows.length,
          min_group: MIN_GROUP,
          masked_groups,
          message: `Aggregates are hidden until the group has at least ${MIN_GROUP} members, to protect individuals.`,
        };
      }

      const memberIds = members.rows.map((m) => m.person_id);
      const events = await query(
        `SELECT person_id, event_type, occurred_at FROM health.attendance_events
         WHERE person_id = ANY($1::uuid[]) AND occurred_at >= NOW() - ($2 || ' days')::interval
         LIMIT $3`,
        [memberIds, WINDOW_DAYS, MAX_EVENT_ROWS]
      );

      // Again: member count only, no leave type or reason.
      const leave = await query(
        `SELECT DISTINCT person_id FROM health.leave_requests
         WHERE person_id = ANY($1::uuid[])
           AND status = 'APPROVED'
           AND system_period @> NOW()
           AND start_date::date <= CURRENT_DATE
           AND end_date::date >= CURRENT_DATE - ($2 || ' days')::interval
         LIMIT $3`,
        [memberIds, WINDOW_DAYS, MAX_MEMBERS]
      );
      const leavePersonSet = new Set(leave.rows.map((r) => r.person_id));

      const byPerson = new Map<string, ReturnType<typeof computeWorkloadSignals>>();
      for (const m of members.rows) {
        byPerson.set(m.person_id, computeWorkloadSignals(events.rows.filter((e) => e.person_id === m.person_id), SIGNAL_OPTS));
      }
      const values = [...byPerson.values()];

      const dimensions = {
        workload_balance: {
          healthy: values.filter((v) => v.state === 'NORMAL' || v.state === 'WATCH').length,
          watch: values.filter((v) => v.state === 'WATCH').length,
          elevated_or_higher: values.filter((v) => v.state !== 'NORMAL' && v.state !== 'WATCH').length,
          healthy_pct: values.length ? Math.round((values.filter((v) => v.state === 'NORMAL' || v.state === 'WATCH').length / values.length) * 100) : null,
        },
        rest: {
          with_short_rest: values.filter((v) => v.minGap != null && v.minGap < 7).length,
          with_late_night: values.filter((v) => v.lateNight > 0).length,
          healthy_pct: values.length ? Math.round(((values.length - values.filter((v) => v.minGap != null && v.minGap < 7).length - values.filter((v) => v.lateNight > 0).length) / values.length) * 100) : null,
        },
        attendance: {
          active_members: values.filter((v) => v.workDays > 0).length,
          coverage_pct: members.rows.length ? Math.round((values.filter((v) => v.workDays > 0).length / members.rows.length) * 100) : null,
        },
      };

      const myWorkload = byPerson.get(request.user!.personId);

      const index = teamHealthIndex({
        memberCount: members.rows.length,
        states: values.map((v) => v.state),
        lateNightCounts: values.map((v) => v.lateNight),
        minGaps: values.map((v) => v.minGap),
        workDays: values.map((v) => v.workDays),
        approvedLeaveMemberCount: leavePersonSet.size,
      });

      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'LEADERSHIP_SCORECARD_VIEW',
        targetType: 'scorecard',
        targetId: departmentId,
        details: {
          masked: false,
          member_count: members.rows.length,
          group_count: scopeIds.length,
          access_path: isHead ? 'department_head' : 'privileged_role',
        },
        request,
      });
      if (!audited) return auditUnavailable(reply);

      return {
        masked: false,
        scope_member_count: members.rows.length,
        groups_in_scope: scopeIds.length,
        masked_groups,
        dimensions,
        index,
        leader: myWorkload
          ? { state: myWorkload.state, score: myWorkload.score, signals: myWorkload.signals.map((s) => s.code) }
          : null,
        members_truncated: members.rows.length === MAX_MEMBERS,
        basis: SIGNAL_BASIS,
        note: 'Every value here is computed from attendance and leave records. No grades or invented scores.',
      };
    }
  });
}

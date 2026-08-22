import { query } from '../db/pool.js';

/**
 * Access relationship between the actor and a subject person.
 * - OWNER: the actor is the subject
 * - MANAGER: the actor heads the department where the subject's active
 *   employment position sits (position → department → head)
 * - NONE: no direct relationship
 */
export async function personRelationship(
  actorPersonId: string,
  subjectPersonId: string
): Promise<'OWNER' | 'MANAGER' | 'NONE'> {
  if (actorPersonId === subjectPersonId) return 'OWNER';

  const result = await query(
    `SELECT d.logical_id AS department_id
     FROM health.employments e
     JOIN health.positions pos ON pos.logical_id = e.position_id AND pos.system_period @> NOW()
     JOIN health.departments d ON d.logical_id = pos.department_id AND d.system_period @> NOW()
     WHERE e.person_id = $1 AND e.status = 'ACTIVE' AND e.system_period @> NOW()
     LIMIT 1`,
    [subjectPersonId]
  );

  if (result.rows.length === 0) return 'NONE';

  const headResult = await query(
    `SELECT 1
     FROM health.positions p
     WHERE p.department_id = $1 AND p.head_of_department_id = $2 AND p.system_period @> NOW()
     LIMIT 1`,
    [result.rows[0].department_id, actorPersonId]
  );

  return headResult.rows.length > 0 ? 'MANAGER' : 'NONE';
}

/** Roles that may act on other employees' records (HR / leadership / auditors). */
export const PRIVILEGED_ROLES = [
  'hr',
  'hr_generalist',
  'hr_manager',
  'hr_admin',
  'leadership',
  'senior_admin',
  'auditor',
  'finance',
  'payroll',
];

export function isPrivileged(roles: string[]): boolean {
  return roles.some((r) => PRIVILEGED_ROLES.includes(r));
}

/**
 * Payroll lifecycle capability (create/approve/pay runs, list runs).
 * Deliberately excludes platform_admin: that role is derived for every
 * account holder and must never grant money-movement rights.
 */
export const PAYROLL_ROLES = ['finance', 'payroll', 'hr_manager', 'leadership', 'senior_admin'];

export function canRunPayroll(roles: string[]): boolean {
  return roles.some((r) => PAYROLL_ROLES.includes(r));
}

/**
 * May this actor act on this subject's record?
 *
 * USE THIS, NOT `isPrivileged()` ALONE, ON EVERY APPROVAL OR AUTHORISATION PATH
 * (leave approval/rejection, payroll run approval and payment, timesheet
 * approval, expense sign-off, anything that moves money or grants time off).
 *
 * `isPrivileged()` answers a different question: "does this role let the actor
 * see and edit *other people's* records?" Approval paths were treating that as
 * sufficient, so an HR, finance or payroll user was privileged with respect to
 * themselves and could approve their own leave and their own payroll run. That
 * is not an access-control decision, it is separation of duties: the two must be
 * different people, whatever the role.
 *
 * Returns false when actor and subject are the same person, regardless of role,
 * and otherwise requires a privileged role. A self-service action on one's own
 * record (submitting leave, viewing a payslip) is NOT an "act on behalf of"
 * decision — use personRelationship() === 'OWNER' for those.
 */
export function canActOnBehalfOf(
  actorPersonId: string,
  subjectPersonId: string,
  roles: string[]
): boolean {
  if (!actorPersonId || !subjectPersonId) return false;
  if (actorPersonId === subjectPersonId) return false;
  return isPrivileged(roles);
}
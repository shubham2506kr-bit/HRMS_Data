import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { query } from '../db/pool.js';
import { config } from '../config/index.js';

const secretKey = new TextEncoder().encode(config.JWT_SECRET);

/**
 * Exact idp_issuer → role grants.
 *
 * This replaces `issuer.includes('hr')`, which was a privilege-escalation bug:
 * 'hr_restricted'.includes('hr') is true, so the deliberately restricted role
 * also received hr_generalist (a PRIVILEGED_ROLE), and any issuer hostname that
 * happened to contain the letters "hr" ("hrms-idp", "thread.example") granted HR.
 *
 * Matching is exact and case-insensitive on the trimmed issuer. Unknown issuers
 * grant nothing. This mapping is a stopgap: an identity-provider name is not an
 * authorisation grant, and there is still no role/grant table in the schema
 * (there is no roles column on health.user_accounts and no health.person_roles).
 * When one exists, read it here and delete this map.
 */
const ISSUER_ROLE_GRANTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['hr', ['hr_generalist']],
  ['hr_generalist', ['hr_generalist']],
  ['hr_restricted', ['hr_restricted']],
]);

/** hr_restricted is a deliberate downgrade: it must never coexist with hr_generalist. */
const MUTUALLY_EXCLUSIVE: ReadonlyArray<readonly [string, string]> = [['hr_restricted', 'hr_generalist']];

type DerivedRoleRow = {
  is_employee: boolean;
  is_head: boolean;
  is_manager: boolean;
  idp_issuers: string[] | null;
};

/**
 * Derive a person's roles from live data — the capability spine.
 *
 * Roles are never carried in the access token: they are read from the database
 * on every request (behind a short cache in authz/middleware.ts) so that a
 * revoked or downgraded privilege takes effect immediately.
 */
export async function deriveRoles(personId: string): Promise<string[]> {
  const result = await query<DerivedRoleRow>(
    `SELECT
       EXISTS (SELECT 1 FROM health.employments e
               WHERE e.person_id = $1 AND e.status = 'ACTIVE' AND e.system_period @> NOW()) AS is_employee,
       EXISTS (SELECT 1 FROM health.positions p
               WHERE p.head_of_department_id = $1 AND p.system_period @> NOW()) AS is_head,
       -- A manager is the PARENT of a reporting line. Joining on child_position_id
       -- matched everyone who *has* a manager, which made almost every employee one.
       EXISTS (SELECT 1 FROM health.employments e
               JOIN health.position_reporting_lines prl
                 ON prl.parent_position_id = e.position_id AND prl.system_period @> NOW()
               WHERE e.person_id = $1 AND e.status = 'ACTIVE' AND e.system_period @> NOW()) AS is_manager,
       (SELECT COALESCE(ARRAY_AGG(DISTINCT ua.idp_issuer), '{}'::TEXT[])
          FROM health.user_accounts ua
         WHERE ua.person_id = $1 AND ua.is_active) AS idp_issuers`,
    [personId]
  );

  const r = result.rows[0];
  const roles = new Set<string>(['self']);
  if (r?.is_employee) roles.add('employee');
  if (r?.is_head) roles.add('department_head_of');
  if (r?.is_manager) roles.add('direct_manager_of');

  for (const issuer of r?.idp_issuers ?? []) {
    const granted = ISSUER_ROLE_GRANTS.get(issuer.trim().toLowerCase());
    if (!granted) continue;
    for (const role of granted) roles.add(role);
  }

  for (const [winner, loser] of MUTUALLY_EXCLUSIVE) {
    if (roles.has(winner)) roles.delete(loser);
  }

  return [...roles];
}

/**
 * Mint an access token. The payload carries identity only — subject (person) and
 * `sid` (session). It deliberately carries no roles and no permissions: anything
 * in here is attacker-controlled once the signing key leaks and is stale the
 * moment a privilege changes.
 *
 * `sid` must reference a live row in health.auth_sessions (migration 038);
 * authenticate() rejects the token otherwise, which is what makes logout,
 * session revocation and forced re-authentication possible.
 */
export async function signJwt(personId: string, sessionId: string): Promise<string> {
  return await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(personId)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(config.JWT_TTL)
    .sign(secretKey);
}

export interface VerifiedToken {
  personId: string;
  sessionId: string;
}

/**
 * Verify signature, issuer, audience and expiry, and return identity only.
 *
 * A token without a `sid` claim is rejected: that is the shape of the old
 * roles-in-the-token format, and honouring it would leave every previously
 * issued privileged token valid until it expired.
 */
export async function verifyJwt(token: string): Promise<VerifiedToken | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    const sid = payload['sid'];
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    if (typeof sid !== 'string' || sid.length === 0) return null;
    return { personId: payload.sub, sessionId: sid };
  } catch {
    return null;
  }
}

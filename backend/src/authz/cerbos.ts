/* ==========================================================================
 * THIS IS NOT A POLICY ENGINE. THERE IS NO CERBOS IN THIS SYSTEM.
 * ==========================================================================
 *
 * Read this before you believe anything a document says about Cerbos.
 *
 * WHAT IS ACTUALLY ENFORCED
 *   Authorization in this deployment is enforced entirely by:
 *     - backend/src/authz/middleware.ts   (authenticate(), per-request role derivation)
 *     - backend/src/lib/auth.ts           (deriveRoles(): self, employee,
 *                                          department_head_of, direct_manager_of,
 *                                          hr_generalist, hr_restricted)
 *     - backend/src/lib/access.ts         (personRelationship(), isPrivileged(),
 *                                          canActOnBehalfOf(), canRunPayroll())
 *     - explicit checks inside each route handler
 *     - PostgreSQL row-level security (migrations/033_rls_and_grants.sql)
 *   If you want to change who can do what, change those. Nothing here runs.
 *
 * WHAT IS NOT ENFORCED
 *   There is no Cerbos process, no gRPC client, and no policy evaluation of any
 *   kind. The `@cerbos/grpc` (and `@cerbos/http`) package is NOT a dependency of
 *   backend/package.json, so no decision can be requested even in principle.
 *   The four YAML files under E:\HRMS_Data\policies\ are unparsed design
 *   artefacts in an invalid grammar; they are loaded by nothing. CERBOS_HOST,
 *   CERBOS_PORT, CERBOS_POLICY_DIR and CERBOS_POLL_INTERVAL are dead config:
 *   nothing reads them.
 *
 * WHY THIS MODULE STILL EXISTS
 *   Only so that the fiction has one obvious place to die, and so that any code
 *   that reaches for a policy decision gets a DENY instead of a plausible
 *   answer. Every decision-shaped export below returns a type whose only
 *   inhabitant is denial (`allowed: false`, `effect: 'EFFECT_DENY'`). That is a
 *   compile-time guarantee, not a convention: TypeScript will not let a caller
 *   observe an "allowed" result from an engine that is not running.
 *
 * IF YOU ARE HERE TO MAKE CERBOS REAL
 *   1. Add @cerbos/grpc to backend/package.json.
 *   2. Rewrite the four files in E:\HRMS_Data\policies\ as valid
 *      `resourcePolicy` / `derivedRoles` documents (they are not valid today —
 *      see the header in each file).
 *   3. Replace the bodies below with a real client, keeping the fail-CLOSED
 *      contract: transport error, timeout, unknown resource or unknown action
 *      must all yield DENY, never ALLOW.
 *   4. Only then remove the warnings in this file — and not before deleting the
 *      claim in docs/HUMANOS_STATUS.md that the policy layer is VERIFIED.
 * ========================================================================== */

import { config } from '../config/index.js';

/** The only effect this module can ever produce. */
export type CerbosDeniedEffect = 'EFFECT_DENY';

/**
 * Operational truth about the policy engine. Deliberately has no 'healthy'
 * member: this module cannot become healthy, because there is nothing to
 * contact. A monitoring system must never be told otherwise.
 */
export type CerbosStatus = 'not_configured' | 'misconfigured';

export interface CerbosHealth {
  /** Always false. Kept as a literal type so no caller can branch to success. */
  readonly healthy: false;
  readonly status: CerbosStatus;
  readonly detail: string;
}

/** A decision, in the only shape this module can return. */
export interface CerbosDecision {
  /** Always false. */
  readonly allowed: false;
  readonly effect: CerbosDeniedEffect;
  /** Why the answer is DENY. Safe to log; contains no principal data. */
  readonly reason: string;
}

export interface CerbosPrincipal {
  id: string;
  roles: string[];
  attr?: Record<string, unknown>;
}

export interface CerbosResource {
  kind: string;
  id: string;
  attr?: Record<string, unknown>;
}

const NOT_RUNNING =
  'No policy engine is running. @cerbos/grpc is not a dependency and the files in ' +
  'policies/ are not valid Cerbos documents. Authorization is enforced by ' +
  'lib/access.ts, authz/middleware.ts, route handlers and PostgreSQL RLS.';

const MISCONFIGURED =
  'CERBOS_ENABLED=true but this build contains no Cerbos client. Nothing will be ' +
  'evaluated and every call to this module denies. Set CERBOS_ENABLED=false, or ' +
  'implement a real client (see the header of backend/src/authz/cerbos.ts).';

/**
 * Shout on boot if someone has enabled a flag expecting enforcement they are
 * not getting. A silent all-deny would be mistaken for "the policy engine
 * working"; an all-deny with no callers is invisible. Neither is acceptable
 * without a log line.
 */
if (config.CERBOS_ENABLED) {
  console.error(`[CERBOS] MISCONFIGURED: ${MISCONFIGURED}`);
}

/** True only if a real client has been implemented. It has not been. */
export function isCerbosAvailable(): false {
  return false;
}

export function cerbosStatus(): CerbosStatus {
  return config.CERBOS_ENABLED ? 'misconfigured' : 'not_configured';
}

/**
 * Honest readiness probe.
 *
 * REPLACES the previous `checkCerbosHealth()` in backend/src/index.ts, which
 * was `try { return true } catch { return false }` — it reported a policy
 * engine as 'healthy' without ever opening a socket. Monitoring believed a
 * control existed, which is precisely the condition that stops anyone looking.
 *
 * Never reports 'healthy'. Reports 'not_configured' when CERBOS_ENABLED is
 * false (the expected state) and 'misconfigured' when the flag is on.
 */
export async function checkCerbosHealth(): Promise<CerbosHealth> {
  return {
    healthy: false,
    status: cerbosStatus(),
    detail: config.CERBOS_ENABLED ? MISCONFIGURED : NOT_RUNNING,
  };
}

/**
 * Fail-closed decision path. ALWAYS DENY.
 *
 * The return type makes the guarantee structural: `allowed` is the literal
 * `false`, so `if (await checkResource(...).allowed)` is statically dead code.
 * There is no argument combination, env var or policy file that changes this.
 */
export async function checkResource(
  principal: CerbosPrincipal,
  resource: CerbosResource,
  actions: string[]
): Promise<CerbosDecision> {
  void principal;
  void resource;
  void actions;
  return { allowed: false, effect: 'EFFECT_DENY', reason: NOT_RUNNING };
}

/**
 * Single-action convenience form. ALWAYS false.
 *
 * Do not "temporarily" flip this to true. If you need a permit, write it in the
 * route handler or in lib/access.ts where a reviewer can see it.
 */
export async function isAllowed(
  principal: CerbosPrincipal,
  resource: CerbosResource,
  action: string
): Promise<false> {
  void principal;
  void resource;
  void action;
  return false;
}

/**
 * Use this at a call site that genuinely requires a policy-engine decision and
 * must not proceed without one. It throws rather than returning a denial, so
 * the absence of the engine cannot be swallowed by a catch-all that falls
 * through to allow.
 */
export async function requireCerbosDecision(
  principal: CerbosPrincipal,
  resource: CerbosResource,
  action: string
): Promise<never> {
  void principal;
  throw new Error(
    `[CERBOS] Refusing to authorize ${action} on ${resource.kind}: ${
      config.CERBOS_ENABLED ? MISCONFIGURED : NOT_RUNNING
    }`
  );
}

/**
 * Retained only because backend/src/index.ts calls `cerbos.close()` during
 * graceful shutdown. There is no connection to close.
 */
export const cerbos = {
  close: async (): Promise<void> => {},
};

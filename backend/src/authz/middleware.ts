import { FastifyRequest, FastifyReply } from 'fastify';
import { deriveRoles, verifyJwt } from '../lib/auth.js';
import { query } from '../db/pool.js';
import { config } from '../config/index.js';
import { enterRequestContext } from '../lib/requestContext.js';

export interface AuthenticatedUser {
  id: string;
  roles: string[];
  attributes?: Record<string, any> | undefined;
  personId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    authorization?: {
      resource: string;
      action: string;
      resourceId: string;
      resourceAttr?: Record<string, any>;
    };
  }
}

interface CachedRoles {
  roles: string[];
  expiresAt: number;
}

/**
 * Short-lived cache of database-derived roles, keyed by person.
 *
 * Roles are authorisation state, so the cache TTL is the window during which a
 * revoked privilege is still honoured — keep config.ROLE_CACHE_TTL_MS small
 * (seconds, not hours) and call invalidateRoleCache() whenever a grant changes.
 * This is per-process: with multiple workers, each has its own copy, so the TTL
 * is the only guaranteed bound.
 */
const roleCache = new Map<string, CachedRoles>();

/** Crude bound so a large tenant cannot grow the map without limit. */
const ROLE_CACHE_MAX_ENTRIES = 5000;

/**
 * Drop cached roles for one person, or for everyone when called with no
 * argument. Call this from any path that changes what someone may do:
 * employment start/termination, department-head assignment, reporting-line
 * changes, account deactivation, role/issuer changes.
 */
export function invalidateRoleCache(personId?: string): void {
  if (personId === undefined) {
    roleCache.clear();
    return;
  }
  roleCache.delete(personId);
}

async function rolesForPerson(personId: string): Promise<string[]> {
  const now = Date.now();
  const hit = roleCache.get(personId);
  if (hit && hit.expiresAt > now) return [...hit.roles];

  const roles = await deriveRoles(personId);
  if (roleCache.size >= ROLE_CACHE_MAX_ENTRIES) roleCache.clear();
  roleCache.set(personId, { roles, expiresAt: now + config.ROLE_CACHE_TTL_MS });
  return [...roles];
}

type LiveSessionRow = { session_id: string };

/**
 * Authenticate a request.
 *
 * Three things must hold, in order:
 *   1. the token verifies (signature, issuer, audience, expiry) and names a session;
 *   2. that session row is live in health.auth_sessions — present, not revoked,
 *      not expired — so logout and revocation take effect immediately;
 *   3. roles are derived from live database state. They are never read from the
 *      token, because a token is a bearer credential, not a permission record.
 */
export function authenticate() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Extract token from Authorization header
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing or invalid authorization header' });
      }

      const token = authHeader.substring(7);

      // Verify the JWT: signature, issuer, audience, expiry. Identity only.
      const verified = await verifyJwt(token);
      if (!verified) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      // Establish identity before any further query: the row-level security
      // policies read app.person_id (see lib/requestContext.ts and migration
      // 033), and the session lookup below is itself subject to them. Roles are
      // deliberately empty here — nothing is authorised until they are derived.
      enterRequestContext({
        personId: verified.personId,
        roles: [],
        sessionId: verified.sessionId,
        requestId: request.id,
      });

      // The session must still be live. A signed-but-revoked token is not a
      // valid credential.
      const session = await query<LiveSessionRow>(
        `SELECT s.session_id
           FROM health.auth_sessions s
          WHERE s.session_id = $1
            AND s.person_id = $2
            AND s.revoked_at IS NULL
            AND s.expires_at > NOW()
          LIMIT 1`,
        [verified.sessionId, verified.personId]
      );
      if (session.rows.length === 0) {
        return reply.code(401).send({ error: 'Session is no longer valid' });
      }

      const roles = await rolesForPerson(verified.personId);

      request.user = {
        id: 'user-' + verified.personId,
        roles,
        personId: verified.personId,
      };

      enterRequestContext({
        personId: verified.personId,
        roles,
        sessionId: verified.sessionId,
        requestId: request.id,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Authentication error');
      return reply.code(401).send({ error: 'Authentication failed' });
    }
  };
}

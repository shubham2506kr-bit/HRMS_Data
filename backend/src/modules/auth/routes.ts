import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../../db/pool.js';
import { deriveRoles, signJwt, verifyJwt } from '../../lib/auth.js';
import { config } from '../../config/index.js';
import { authenticate, invalidateRoleCache } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { z } from 'zod';

/**
 * Local-password authentication and session lifecycle.
 *
 * Invariants enforced here:
 *  - Every response on a failure path is generic. Nothing distinguishes
 *    "no such username" from "wrong password" from "hash unusable", and the
 *    work done is the same in all three cases (a bcrypt comparison against a
 *    dummy hash) so response time does not leak account existence either.
 *  - Passwords, refresh tokens and access tokens are never logged and never
 *    written to the audit trail. Only session ids and outcomes are.
 *  - Access tokens carry no roles (roles are re-derived per request) and are
 *    bound to a row in health.auth_sessions, so they can be revoked.
 */

const GENERIC_LOGIN_FAILURE = 'Invalid username or password';
const GENERIC_SERVER_FAILURE = 'Authentication service unavailable';
/** The unusable hash migration 037 writes over the old shared demo password. */
export const DISABLED_PASSWORD_SENTINEL = 'DISABLED:no-password-set:see-migration-037';

/** Used as the audit subject when no real person can be attributed to an attempt. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** bcrypt 2a/2b/2y, cost, 22-char salt + 31-char digest. Anything else is unusable. */
const BCRYPT_HASH_SHAPE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * Personas the demo endpoint will never mint, even when it is fully enabled.
 * The explicit list is the agreed set; the extra `hr*` / `*admin*` guards make
 * the check fail closed if role derivation later grows a new privileged name.
 */
const PRIVILEGED_DEMO_ROLES = new Set([
  'hr',
  'hr_generalist',
  'hr_manager',
  'hr_admin',
  'leadership',
  'senior_admin',
  'auditor',
  'finance',
  'payroll',
]);

function privilegedRolesIn(roles: readonly string[]): string[] {
  return roles.filter((role) => {
    const r = role.toLowerCase();
    return PRIVILEGED_DEMO_ROLES.has(r) || /^hr(_|$)/.test(r) || r.includes('admin');
  });
}

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Constant-time secret comparison. Both sides are hashed first so that
 * timingSafeEqual always gets equal-length buffers — it throws otherwise, and
 * the throw itself would leak the expected length.
 */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqual(
    createHash('sha256').update(provided, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest()
  );
}

/**
 * A throwaway bcrypt hash, computed once, used to spend the same CPU on a
 * missing/disabled account as on a real one. Built lazily so process start-up
 * does not block on a key-derivation function.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(randomBytes(24).toString('hex'), 10);
  }
  return dummyHashPromise;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

function clientMeta(request: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const ua = request.headers['user-agent'];
  return {
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
    userAgent: typeof ua === 'string' && ua.length > 0 ? ua.slice(0, 512) : null,
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

type AccountRow = {
  account_id: string;
  person_id: string;
  password_hash: string | null;
  is_active: boolean;
  must_reset_password: boolean;
  failed_attempt_count: number;
  locked_until: Date | null;
  preferred_name: string | null;
  legal_name: string | null;
};

const ACCOUNT_BY_USERNAME_SQL = `
  SELECT ua.logical_id            AS account_id,
         ua.person_id             AS person_id,
         ua.password_hash,
         ua.is_active,
         ua.must_reset_password,
         ua.failed_attempt_count,
         ua.locked_until,
         p.preferred_name,
         p.legal_name
    FROM health.user_accounts ua
    JOIN health.persons p ON p.logical_id = ua.person_id
   WHERE LOWER(ua.username) = LOWER($1)`;

type SessionBundle = { token: string; refreshToken: string; sessionId: string };

/**
 * Create a session row and mint the pair of credentials bound to it.
 * The refresh token is returned to the caller exactly once and only its
 * SHA-256 hash is persisted, so a database read cannot yield a usable token.
 */
async function issueSession(personId: string, request: FastifyRequest): Promise<SessionBundle> {
  const refreshToken = randomBytes(48).toString('base64url');
  const { ip, userAgent } = clientMeta(request);

  const inserted = await query<{ session_id: string }>(
    `INSERT INTO health.auth_sessions
       (person_id, refresh_token_hash, expires_at, last_seen_at, ip_address, user_agent)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'), NOW(), NULLIF($4::text, '')::inet, $5)
     RETURNING session_id`,
    [personId, sha256Hex(refreshToken), config.REFRESH_TOKEN_TTL_DAYS, ip, userAgent]
  );

  const sessionId = inserted.rows[0]?.session_id;
  if (!sessionId) {
    throw new Error('auth_sessions insert returned no session_id');
  }

  return { token: await signJwt(personId, sessionId), refreshToken, sessionId };
}

async function revokeSession(sessionId: string, reason: string): Promise<string | null> {
  const revoked = await query<{ person_id: string }>(
    `UPDATE health.auth_sessions
        SET revoked_at = COALESCE(revoked_at, NOW()),
            revoked_reason = COALESCE(revoked_reason, $2),
            refresh_token_hash = NULL
      WHERE session_id = $1
      RETURNING person_id`,
    [sessionId, reason]
  );
  return revoked.rows[0]?.person_id ?? null;
}

export async function authRoutes(app: FastifyInstance) {
  const loginSchema = z.object({
    username: z.string().min(1).max(120),
    password: z.string().min(1).max(256),
  });

  // Real login: username + password against user_accounts (local fallback to the IdP).
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }
    const { username, password } = parsed.data;

    try {
      const result = await query<AccountRow>(ACCOUNT_BY_USERNAME_SQL, [username]);
      const account = result.rows[0];
      const now = Date.now();

      // Lockout. Enumeration note: a 429 only ever comes back for an account
      // that exists, which is the accepted cost of telling a locked-out user
      // to come back later instead of lying to them.
      if (account?.locked_until && account.locked_until.getTime() > now) {
        const retryAfter = Math.max(1, Math.ceil((account.locked_until.getTime() - now) / 1000));
        await writeAudit({
          personId: account.person_id,
          action: 'LOGIN_BLOCKED_LOCKOUT',
          targetType: 'user_account',
          targetId: account.person_id,
          details: { method: 'local-password', retryAfterSeconds: retryAfter },
          request,
        });
        return reply
          .code(429)
          .header('Retry-After', String(retryAfter))
          .send({ error: 'Too many failed attempts. Try again later.' });
      }

      // Lock has expired: clear it so the account starts from a clean counter.
      if (account?.locked_until && account.locked_until.getTime() <= now) {
        await query(
          `UPDATE health.user_accounts
              SET failed_attempt_count = 0, locked_until = NULL, updated_at = NOW()
            WHERE logical_id = $1`,
          [account.account_id]
        );
      }

      // A hash that is not bcrypt-shaped (the migration-037 sentinel, an empty
      // column, anything else) can never authenticate anyone.
      const storedHash =
        account && typeof account.password_hash === 'string' && BCRYPT_HASH_SHAPE.test(account.password_hash)
          ? account.password_hash
          : null;
      const usable = Boolean(account) && account?.is_active === true && storedHash !== null;

      // Always spend a bcrypt comparison, even when there is nothing to compare.
      let passwordOk = false;
      try {
        passwordOk = await bcrypt.compare(password, storedHash ?? (await dummyPasswordHash()));
      } catch {
        passwordOk = false;
      }

      if (!usable || !passwordOk || !account) {
        if (account) {
          const attempt = await query<{ failed_attempt_count: number; locked_until: Date | null }>(
            `UPDATE health.user_accounts
                SET failed_attempt_count = failed_attempt_count + 1,
                    last_failed_attempt_at = NOW(),
                    locked_until = CASE
                      WHEN failed_attempt_count + 1 >= $2::int
                      THEN NOW() + ($3::int * INTERVAL '1 minute')
                      ELSE locked_until
                    END,
                    updated_at = NOW()
              WHERE logical_id = $1
              RETURNING failed_attempt_count, locked_until`,
            [account.account_id, config.LOGIN_MAX_ATTEMPTS, config.LOGIN_LOCKOUT_MINUTES]
          );
          const state = attempt.rows[0];
          await writeAudit({
            personId: account.person_id,
            action: 'LOGIN_FAILED',
            targetType: 'user_account',
            targetId: account.person_id,
            details: {
              method: 'local-password',
              failedAttemptCount: state?.failed_attempt_count ?? null,
              locked: Boolean(state?.locked_until),
              passwordUnusable: storedHash === null,
            },
            request,
          });
        } else {
          await writeAudit({
            personId: NIL_UUID,
            action: 'LOGIN_FAILED',
            targetType: 'user_account',
            details: { method: 'local-password', reason: 'unknown-username' },
            request,
          });
        }
        return reply.code(401).send({ error: GENERIC_LOGIN_FAILURE });
      }

      await query(
        `UPDATE health.user_accounts
            SET failed_attempt_count = 0, locked_until = NULL, updated_at = NOW()
          WHERE logical_id = $1`,
        [account.account_id]
      );

      const roles = await deriveRoles(account.person_id);
      const session = await issueSession(account.person_id, request);

      await writeAudit({
        personId: account.person_id,
        action: 'LOGIN',
        targetType: 'user_account',
        targetId: account.person_id,
        details: { method: 'local-password', sessionId: session.sessionId },
        request,
      });

      return {
        token: session.token,
        refreshToken: session.refreshToken,
        accessTokenTtl: config.JWT_TTL,
        mustResetPassword: account.must_reset_password === true,
        user: {
          id: account.person_id,
          personId: account.person_id,
          preferredName: account.preferred_name,
          legalName: account.legal_name,
          roles,
        },
      };
    } catch (error) {
      // Never include the request body in a log line: it holds a password.
      request.log.error({ err: error }, 'login handler failed');
      return reply.code(500).send({ error: GENERIC_SERVER_FAILURE });
    }
  });

  const demoSchema = z.object({ username: z.string().min(1).max(120) });

  /**
   * Persona switching for sandbox demos. This is passwordless by design, so it
   * is fenced in four independent ways: it does not exist unless DEMO_MODE and
   * DEMO_SEED_SECRET are both set and the process is not production; it needs a
   * matching x-demo-secret header; it refuses any persona whose derived roles
   * are privileged; and every call — allowed or refused — is audited.
   * There is no default username: omitting it is a 400, never a login as john.
   */
  app.post('/api/auth/demo', async (request, reply) => {
    const demoSecret = config.DEMO_SEED_SECRET;
    if (config.DEMO_MODE !== true || !demoSecret || config.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'Not found' });
    }

    if (!secretMatches(firstHeader(request.headers['x-demo-secret']), demoSecret)) {
      await writeAudit({
        personId: NIL_UUID,
        action: 'DEMO_LOGIN_DENIED',
        targetType: 'user_account',
        details: { method: 'sandbox-demo', reason: 'bad-or-missing-demo-secret' },
        request,
      });
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = demoSchema.safeParse(request.body);
    if (!parsed.success) {
      await writeAudit({
        personId: NIL_UUID,
        action: 'DEMO_LOGIN_DENIED',
        targetType: 'user_account',
        details: { method: 'sandbox-demo', reason: 'invalid-body' },
        request,
      });
      return reply.code(400).send({ error: 'Invalid request body' });
    }
    const { username } = parsed.data;

    try {
      const result = await query<AccountRow>(ACCOUNT_BY_USERNAME_SQL, [username]);
      const account = result.rows[0];
      if (!account || account.is_active !== true) {
        await writeAudit({
          personId: NIL_UUID,
          action: 'DEMO_LOGIN_DENIED',
          targetType: 'user_account',
          details: { method: 'sandbox-demo', reason: 'no-such-active-account' },
          request,
        });
        return reply.code(404).send({ error: 'Sandbox account not found' });
      }

      const roles = await deriveRoles(account.person_id);
      const privileged = privilegedRolesIn(roles);
      if (privileged.length > 0) {
        await writeAudit({
          personId: account.person_id,
          action: 'DEMO_LOGIN_REFUSED_PRIVILEGED',
          targetType: 'user_account',
          targetId: account.person_id,
          details: { method: 'sandbox-demo', refusedRoles: privileged },
          request,
        });
        return reply.code(403).send({ error: 'This persona is not available for demo sign-in' });
      }

      const session = await issueSession(account.person_id, request);

      await writeAudit({
        personId: account.person_id,
        action: 'LOGIN',
        targetType: 'user_account',
        targetId: account.person_id,
        details: { method: 'sandbox-demo', sessionId: session.sessionId, roles },
        request,
      });

      return {
        token: session.token,
        refreshToken: session.refreshToken,
        accessTokenTtl: config.JWT_TTL,
        mustResetPassword: account.must_reset_password === true,
        user: {
          id: account.person_id,
          personId: account.person_id,
          preferredName: account.preferred_name,
          legalName: account.legal_name,
          roles,
        },
      };
    } catch (error) {
      request.log.error({ err: error }, 'demo sign-in handler failed');
      return reply.code(500).send({ error: GENERIC_SERVER_FAILURE });
    }
  });

  const refreshSchema = z.object({ refreshToken: z.string().min(20).max(512) });

  /**
   * Exchange an opaque refresh token for a fresh access token, rotating the
   * refresh token every time. Replay of an already-rotated token revokes the
   * entire session: the old hash is only ever found in auth_refresh_history,
   * which means someone other than the legitimate holder still has it.
   */
  app.post('/api/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }

    const presentedHash = sha256Hex(parsed.data.refreshToken);
    const nextToken = randomBytes(48).toString('base64url');
    const { ip, userAgent } = clientMeta(request);

    try {
      // One conditional UPDATE does the rotation: the row lock makes concurrent
      // use of the same token resolve to exactly one winner.
      const rotated = await query<{ session_id: string; person_id: string }>(
        `UPDATE health.auth_sessions
            SET refresh_token_hash = $2,
                last_seen_at = NOW(),
                ip_address = COALESCE(NULLIF($3::text, '')::inet, ip_address),
                user_agent = COALESCE($4::text, user_agent)
          WHERE refresh_token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > NOW()
          RETURNING session_id, person_id`,
        [presentedHash, sha256Hex(nextToken), ip, userAgent]
      );

      const session = rotated.rows[0];
      if (!session) {
        // Not a live session. If we have seen this hash before, it is a replay
        // of a rotated token — kill the session it belonged to.
        const seen = await query<{ session_id: string }>(
          'SELECT session_id FROM health.auth_refresh_history WHERE token_hash = $1',
          [presentedHash]
        );
        const replayedSessionId = seen.rows[0]?.session_id;
        if (replayedSessionId) {
          const personId = await revokeSession(replayedSessionId, 'refresh_token_reuse');
          if (personId) {
            invalidateRoleCache(personId);
            await writeAudit({
              personId,
              action: 'SESSION_REVOKED_TOKEN_REUSE',
              targetType: 'auth_session',
              targetId: replayedSessionId,
              details: { reason: 'refresh_token_reuse' },
              request,
            });
          }
        }
        return reply.code(401).send({ error: 'Invalid or expired refresh token' });
      }

      await query(
        `INSERT INTO health.auth_refresh_history (token_hash, session_id)
         VALUES ($1, $2)
         ON CONFLICT (token_hash) DO NOTHING`,
        [presentedHash, session.session_id]
      );

      const roles = await deriveRoles(session.person_id);
      const token = await signJwt(session.person_id, session.session_id);
      const person = await query<{ preferred_name: string | null; legal_name: string | null }>(
        'SELECT preferred_name, legal_name FROM health.persons WHERE logical_id = $1',
        [session.person_id]
      );

      await writeAudit({
        personId: session.person_id,
        action: 'TOKEN_REFRESH',
        targetType: 'auth_session',
        targetId: session.session_id,
        details: { rotated: true },
        request,
      });

      return {
        token,
        refreshToken: nextToken,
        accessTokenTtl: config.JWT_TTL,
        user: {
          id: session.person_id,
          personId: session.person_id,
          preferredName: person.rows[0]?.preferred_name ?? null,
          legalName: person.rows[0]?.legal_name ?? null,
          roles,
        },
      };
    } catch (error) {
      request.log.error({ err: error }, 'refresh handler failed');
      return reply.code(500).send({ error: GENERIC_SERVER_FAILURE });
    }
  });

  /** Revoke the current session. Idempotent: a second call is still a 200. */
  app.post('/api/auth/logout', {
    preHandler: [authenticate()],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const personId = request.user?.personId;
      if (!personId) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      try {
        // Read the session id straight from the presented token rather than
        // relying on the shape the middleware chose to expose.
        const token = bearerToken(request);
        const verified = token ? await verifyJwt(token) : null;

        if (verified?.sessionId && verified.personId === personId) {
          await revokeSession(verified.sessionId, 'logout');
        }
        invalidateRoleCache(personId);

        await writeAudit({
          personId,
          action: 'LOGOUT',
          targetType: 'auth_session',
          targetId: verified?.sessionId ?? null,
          details: { sessionRevoked: Boolean(verified?.sessionId) },
          request,
        });

        return { ok: true };
      } catch (error) {
        request.log.error({ err: error }, 'logout handler failed');
        return reply.code(500).send({ error: GENERIC_SERVER_FAILURE });
      }
    },
  });

  // Current user profile (requires auth). Roles come from the middleware, which
  // derives them from live database state — the token no longer carries them.
  app.get('/api/auth/me', {
    preHandler: [authenticate()],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }
      try {
        const person = await query<{ preferred_name: string | null; legal_name: string | null }>(
          'SELECT preferred_name, legal_name FROM health.persons WHERE logical_id = $1',
          [user.personId]
        );
        return {
          id: user.personId,
          personId: user.personId,
          preferredName: person.rows[0]?.preferred_name ?? null,
          legalName: person.rows[0]?.legal_name ?? null,
          roles: user.roles,
        };
      } catch (error) {
        request.log.error({ err: error }, 'profile handler failed');
        return reply.code(500).send({ error: GENERIC_SERVER_FAILURE });
      }
    },
  });
}

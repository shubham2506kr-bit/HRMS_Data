import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped identity, propagated without threading a parameter through
 * all 82 route handlers.
 *
 * Two consumers depend on this:
 *
 *  1. db/pool.ts — sets `app.person_id` and `app.roles` as transaction-local
 *     settings before each request-scoped query, which is what the row-level
 *     security policies in migrations/033_rls_and_grants.sql read. This is the
 *     mechanism that makes RLS possible without rewriting every call site.
 *  2. lib/audit.ts — attributes an audit row to the acting person even when the
 *     caller did not pass the request object.
 *
 * `authenticate()` establishes the context with `enterWith` after the token is
 * verified, so everything downstream in that request's async chain sees it.
 * Background jobs and the migration runner deliberately run with no context;
 * they must connect as a role that is allowed to bypass RLS, or set their own.
 */
export interface RequestContext {
  /** health.persons.logical_id of the authenticated caller. */
  personId: string;
  /** Roles derived from live database state for this request. Never read from the token. */
  roles: string[];
  /** Session identifier, so a single session can be revoked without rotating the signing key. */
  sessionId?: string | undefined;
  /** Correlates database queries, audit rows and log lines for one request. */
  requestId?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Establish the context for the remainder of the current async execution. */
export function enterRequestContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

/** Run `fn` with an explicit context. Preferred for jobs and tests. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current context, or undefined when running outside a request (jobs, migrations, tests). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Explicitly run without identity — for genuinely system-level work such as the
 * scheduler or migrations. Named so that an unscoped query is a deliberate,
 * greppable decision rather than an accident.
 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run(undefined as unknown as RequestContext, fn);
}

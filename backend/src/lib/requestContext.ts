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
 * Background jobs run under `runAsSystem`, which establishes a ServiceContext:
 * no person identity, but a positive marker that says so (see below).
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

/**
 * Background work: the scheduler, retention passes, payroll computation sweeps.
 *
 * WHY THIS TYPE EXISTS AT ALL:
 * `runAsSystem` used to store `undefined`, which made a system job byte-for-byte
 * indistinguishable from an unauthenticated request — both were simply "no
 * context", and db/pool.ts applied no settings for either. That is fine while
 * nothing is protected, and unworkable the moment row-level security covers the
 * tables the scheduler writes to (health.attendance_events, certifications,
 * leave_requests, notifications, payroll_runs, persons). A self-or-privileged
 * policy on any of those would silently reduce every scheduled job to zero rows:
 * no error, no log line, just a job that reports success having done nothing.
 *
 * The alternatives were worse. Giving the scheduler a real person id would
 * attribute its writes to a human who did not make them and would poison the
 * audit trail. Letting it connect as a BYPASSRLS role would hand unrestricted
 * read of clinical data to the least-supervised code path in the process.
 *
 * So the scheduler declares itself instead: `app.service_context` is set to 'on'
 * for exactly this context and left unset for everything else, and policies
 * admit it explicitly, per table, where that is the intended behaviour
 * (health.fn_is_service_context(), migration 042). It is a positive assertion,
 * which means the default for an unauthenticated request stays closed.
 *
 * It carries no person identity, deliberately: `personId: null` is what stops
 * `getRequestContext()` from ever handing a job an acting person, so audit rows
 * written by the scheduler remain unattributed rather than misattributed.
 */
export interface ServiceContext {
  /** Always null. A system job has no acting person and must not borrow one. */
  personId: null;
  /** Always empty. Roles are a property of a person; there is no person here. */
  roles: readonly never[];
  /** Discriminant. Present and true only for background work. */
  service: true;
  /** Which job is running, for log correlation. Never sent to the database. */
  jobName?: string | undefined;
}

/** Either kind of ambient context. Only db/pool.ts needs to tell them apart. */
export type ExecutionContext = RequestContext | ServiceContext;

/** Narrowing predicate for the discriminated union above. */
export function isServiceContext(ctx: ExecutionContext | undefined): ctx is ServiceContext {
  return ctx !== undefined && (ctx as ServiceContext).service === true;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

/** Establish the context for the remainder of the current async execution. */
export function enterRequestContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

/** Run `fn` with an explicit context. Preferred for jobs and tests. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The acting person's context, or undefined when there is no acting person
 * (background jobs, migrations, tests).
 *
 * A ServiceContext is deliberately reported as `undefined` here. Callers —
 * lib/audit.ts and lib/events.ts — read `ctx.personId` to attribute a row, and a
 * background job has nobody to attribute it to. Returning the marker would push
 * that decision into every call site; returning undefined keeps their existing
 * "unattributed" path, which is the correct one. db/pool.ts, which genuinely
 * needs to tell the two apart, uses getExecutionContext().
 */
export function getRequestContext(): RequestContext | undefined {
  const ctx = storage.getStore();
  if (ctx === undefined || isServiceContext(ctx)) return undefined;
  return ctx;
}

/** The raw ambient context, service marker included. For db/pool.ts. */
export function getExecutionContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/**
 * Explicitly run as the system — for genuinely system-level work such as the
 * scheduler or migrations. Named so that an unscoped query is a deliberate,
 * greppable decision rather than an accident.
 *
 * This establishes a positive marker rather than an absence (see ServiceContext).
 * It does NOT grant anything by itself: each policy decides whether to admit the
 * service context, and the default is still closed.
 */
export function runAsSystem<T>(fn: () => T, jobName?: string): T {
  return storage.run({ personId: null, roles: [], service: true, jobName }, fn);
}

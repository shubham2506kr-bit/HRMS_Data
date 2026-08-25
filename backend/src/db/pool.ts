import { Pool, PoolConfig, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/index.js';
import { getExecutionContext, isServiceContext } from '../lib/requestContext.js';

/**
 * Identity-aware database access layer.
 *
 * Every request-scoped statement runs with three PostgreSQL settings applied:
 *   app.person_id       the caller's health.persons.logical_id, '' if none
 *   app.roles           the caller's roles, comma-delimited AND comma-wrapped
 *   app.service_context 'on' for background work only, '' for everything else
 *
 * The row-level security policies in migrations/033_rls_and_grants.sql read the
 * first two through health.fn_current_person() and health.fn_has_role(); the
 * third is read by health.fn_is_service_context() (migration 042). Nothing here
 * interpolates an identity into SQL text: all three are applied with set_config()
 * over bound parameters, so a role name or person id can never terminate a
 * literal.
 *
 * THE THREE STATES, AND WHY THE THIRD ONE HAD TO BECOME VISIBLE:
 *
 *  1. An authenticated request — person id set, roles set, service unset.
 *  2. Background work under runAsSystem — person id empty, service 'on'.
 *  3. Anything else (startup probes, migrations, tests) — no settings applied,
 *     so app.person_id reads NULL and every policy that requires a person
 *     denies. That is the correct default and it stays.
 *
 * States 2 and 3 used to be the same state. Both were "no context", both took
 * the plain pool path, both set nothing. So a scheduled job and an
 * unauthenticated caller were indistinguishable to a policy, and the only way to
 * let the scheduler write was to let everyone write. State 2 now announces
 * itself, which is what allows a policy to admit the scheduler by name without
 * widening anything for state 3.
 *
 * The settings are always applied as a set of three, never individually: a
 * partial apply would let one caller's app.service_context survive on a pooled
 * connection into the next caller's statement.
 */

const poolConfig: PoolConfig = {
  connectionString: config.DATABASE_URL,
  min: config.DATABASE_POOL_MIN,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  maxUses: 7500,
};

export const pool = new Pool(poolConfig);

const SETTING_PERSON = 'app.person_id';
const SETTING_ROLES = 'app.roles';
const SETTING_SERVICE = 'app.service_context';

/** Transaction-local: discarded automatically by COMMIT or ROLLBACK. */
const APPLY_LOCAL =
  'SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)';
/** Session-local: survives a caller's own BEGIN/COMMIT. Must be reset on release. */
const APPLY_SESSION =
  'SELECT set_config($1, $2, false), set_config($3, $4, false), set_config($5, $6, false)';

/** All three settings, in the order APPLY_LOCAL / APPLY_SESSION bind them. */
type IdentityParams = [string, string, string, string, string, string];

/** Every setting blanked. Used to scrub a session-scoped client before release. */
const CLEARED: IdentityParams = [SETTING_PERSON, '', SETTING_ROLES, '', SETTING_SERVICE, ''];

/**
 * `,self,employee,hr_generalist,` — the wrapping commas are load-bearing. A
 * policy tests LIKE '%,payroll,%', which cannot then collide with a role named
 * `payroll_viewer` or match a bare prefix.
 */
function encodeRoles(roles: readonly string[] | undefined): string {
  const clean = (roles ?? [])
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && !r.includes(','));
  return `,${clean.join(',')},`;
}

/**
 * Settings for the live caller, or null when there is nothing to declare and the
 * plain pool path should be taken.
 *
 * Returns non-null in two cases: an authenticated request, and background work.
 * The service branch sends an empty person id on purpose — a job has no acting
 * person, and fn_current_person() must keep returning NULL for it. What changes
 * is that app.service_context says the emptiness is intentional.
 */
function identityParams(): IdentityParams | null {
  if (!config.DB_RLS_ENABLED) return null;
  const ctx = getExecutionContext();
  if (ctx === undefined) return null;

  if (isServiceContext(ctx)) {
    return [SETTING_PERSON, '', SETTING_ROLES, encodeRoles([]), SETTING_SERVICE, 'on'];
  }

  if (typeof ctx.personId !== 'string' || ctx.personId.length === 0) return null;
  return [SETTING_PERSON, ctx.personId, SETTING_ROLES, encodeRoles(ctx.roles), SETTING_SERVICE, ''];
}

/**
 * Signature unchanged — 82 route handlers call this.
 *
 * With a request context: checks out a client and runs the statement inside its
 * own transaction, after applying transaction-local settings. COMMIT on success,
 * ROLLBACK on failure, release always. Transaction-local means the settings
 * cannot outlive the statement, so a pooled connection never carries one
 * caller's identity into the next caller's query.
 *
 * Without a request context: the original plain pool.query path, byte for byte.
 *
 * Logging is deliberately limited to { duration, rows }. Parameters are never
 * logged: they routinely hold person ids, salaries and clinical free text.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const identity = identityParams();

  if (identity === null) {
    const start = Date.now();
    const res = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    console.debug('Executed query', { duration, rows: res.rowCount });
    return res;
  }

  const client = await pool.connect();
  const start = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(APPLY_LOCAL, identity);
    const res = await client.query<T>(text, params);
    await client.query('COMMIT');
    const duration = Date.now() - start;
    console.debug('Executed query', { duration, rows: res.rowCount });
    return res;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Signature unchanged. Returns a checked-out client with the caller's identity
 * already applied.
 *
 * WHY SESSION-LOCAL AND NOT TRANSACTION-LOCAL HERE:
 * callers in modules/payroll/routes.ts (payroll run creation, payment
 * disbursement, wallet transfer) do `await getClient()` and then issue their own
 * BEGIN / COMMIT / ROLLBACK. A transaction-local set_config applied at checkout
 * would belong to the implicit single-statement transaction of the set_config
 * call itself and be discarded before the caller's BEGIN ever ran — the caller's
 * transaction would then see app.person_id NULL and RLS would hide its own rows.
 * So the settings are applied with is_local = false, at session scope, which
 * survives an arbitrary number of caller-managed transactions, including a
 * ROLLBACK (RESET/SET LOCAL semantics do not apply to a plain session setting).
 *
 * That makes the connection stateful, so the wrapped release() clears all three
 * settings before the client returns to the pool, and checkout re-applies them
 * unconditionally — empty strings when there is no context. Both halves matter:
 * without the reset a background job could inherit a request's identity, or a
 * request could inherit a job's app.service_context; without the unconditional
 * re-apply a stale value could survive a failed reset.
 * If the reset itself fails the client is destroyed rather than returned, since
 * its identity is then unknown.
 */
export async function getClient(): Promise<PoolClient> {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const release = client.release.bind(client);

  if (config.DB_RLS_ENABLED) {
    const identity = identityParams();
    try {
      await (originalQuery as any)(APPLY_SESSION, identity ?? CLEARED);
    } catch (error) {
      release(true as any);
      throw error;
    }
  }

  client.release = ((err?: Error | boolean) => {
    client.query = originalQuery;
    if (err) {
      return release(err as any);
    }
    if (!config.DB_RLS_ENABLED) {
      return release();
    }
    // Reset first, release second. The client is not back in the pool until
    // release() runs, so there is no window in which another borrower could see
    // this caller's identity. Callers do not await release(), by design.
    void (async () => {
      try {
        await (originalQuery as any)(APPLY_SESSION, CLEARED);
        release();
      } catch {
        release(true as any);
      }
    })();
    return undefined;
  }) as typeof client.release;

  client.query = (async (text: string, params?: any[]) => {
    const start = Date.now();
    const res = await (originalQuery as any)(text, params);
    const duration = Date.now() - start;
    console.debug('Client query', { duration, rows: res.rowCount });
    return res;
  }) as any;

  return client;
}

export async function closePool() {
  await pool.end();
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrations that the live database already had applied by hand before this
 * runner ever worked. Files numbered at or below this are recorded, never
 * executed, when the runner first meets an already-populated database.
 */
const HAND_APPLIED_THROUGH = 30;

function migrationNumber(filename: string): number {
  const match = /^(\d+)/.exec(filename);
  return match ? Number.parseInt(match[1]!, 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * BUG FIX. The old code read `import.meta.dirname + '/../migrations'`, i.e.
 * backend/src/migrations from source or backend/dist/migrations once compiled.
 * Neither directory has ever existed — the migrations live at the repository
 * root, three levels above backend/src/db (db -> src -> backend -> repo root).
 * Because tsconfig sets rootDir ./src and outDir ./dist, dist/db/pool.js sits at
 * exactly the same depth, so one relative path serves both. The remaining
 * candidates are a cheap hedge against a layout change; the first directory that
 * actually holds .sql files wins.
 */
async function resolveMigrationsDir(): Promise<string> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const here = import.meta.dirname;

  const candidates = [
    path.resolve(here, '../../../migrations'),
    path.resolve(here, '../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), '../migrations'),
  ];

  for (const dir of candidates) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.some((f) => f.endsWith('.sql'))) return dir;
    } catch {
      // Not this one.
    }
  }
  throw new Error(
    `runMigrations: no migrations directory found. Looked in: ${candidates.join(', ')}`
  );
}

/**
 * Applies pending migrations, once each, recorded in a ledger.
 *
 * Runs with no request context on purpose, straight off the pool, so nothing here
 * is filtered by row-level security.
 *
 * BASELINE, THE CRITICAL PART: the live database was built by hand because this
 * function's path was wrong and it therefore never ran. 001-030 are already
 * applied there, and 001_core_schema.sql cannot be replayed anyway — it contains
 * `CREATE TABLE health.user_accounts` twice (lines 42 and 221), unguarded, so its
 * second statement fails by construction.
 *
 * So on the first run, if and only if the database already looks built
 * (health.persons exists) and the ledger is empty, every file numbered <= 030 is
 * RECORDED as applied without being executed. A genuinely empty database
 * (no health.persons) is not baselined and gets everything executed from 001 —
 * which will surface the duplicate CREATE TABLE in 001 as a loud, transactional
 * failure rather than a silent half-migration. That is the honest outcome: fixing
 * 001 is not this function's job, and pretending a fresh database is migratable
 * would be worse.
 */
export async function runMigrations() {
  const fs = await import('fs/promises');
  const path = await import('path');
  const crypto = await import('crypto');

  const dir = await resolveMigrationsDir();
  const entries = await fs.readdir(dir);
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS health');
    await client.query(`
      CREATE TABLE IF NOT EXISTS health.schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum   text
      )
    `);

    const ledger = await client.query<{ filename: string; checksum: string | null }>(
      'SELECT filename, checksum FROM health.schema_migrations'
    );
    const applied = new Map(ledger.rows.map((r) => [r.filename, r.checksum]));

    const built = await client.query<{ present: boolean }>(
      "SELECT to_regclass('health.persons') IS NOT NULL AS present"
    );
    const needsBaseline = applied.size === 0 && built.rows[0]?.present === true;

    for (const file of sqlFiles) {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      // Normalised so a checkout that flips CRLF to LF is not read as a change.
      const content = raw.replace(/\r\n/g, '\n');
      const checksum = crypto.createHash('sha256').update(content).digest('hex');
      const num = migrationNumber(file);

      if (needsBaseline && num <= HAND_APPLIED_THROUGH && !applied.has(file)) {
        await client.query(
          `INSERT INTO health.schema_migrations (filename, checksum) VALUES ($1, $2)
           ON CONFLICT (filename) DO NOTHING`,
          [file, checksum]
        );
        applied.set(file, checksum);
        console.log(`Baselined migration as already applied (not executed): ${file}`);
        continue;
      }

      if (applied.has(file)) {
        const recorded = applied.get(file);
        if (recorded === checksum) continue;
        if (num <= HAND_APPLIED_THROUGH) {
          console.warn(
            `Migration ${file} changed since it was recorded. NOT re-executing: ` +
              'files 001-030 are hand-applied history and replaying them is unsafe.'
          );
          continue;
        }
        // 031 and up are written to be idempotent and re-runnable, so an edited
        // file is re-applied and its checksum refreshed.
        console.warn(`Migration ${file} changed since last apply — re-applying.`);
      }

      try {
        await client.query('BEGIN');
        await client.query(content);
        await client.query(
          `INSERT INTO health.schema_migrations (filename, checksum) VALUES ($1, $2)
           ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [file, checksum]
        );
        await client.query('COMMIT');
        applied.set(file, checksum);
        console.log(`Applied migration: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        // One file, one transaction: this file left no partial changes behind.
        throw new Error(
          `Migration ${file} failed and was rolled back: ${(error as Error).message}`
        );
      }
    }
  } finally {
    client.release();
  }
}

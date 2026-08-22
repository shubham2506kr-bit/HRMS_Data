import 'dotenv/config';
import { z } from 'zod';

/**
 * Parse a boolean from an environment variable.
 *
 * NOTE: z.coerce.boolean() is NOT safe for env vars — it applies JavaScript
 * truthiness, so the string "false" coerces to `true`. Every feature flag in
 * this file previously used it, meaning FEATURE_AI_ENABLED=false enabled the
 * feature. This parser is explicit about which strings mean what.
 */
const envBool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(20),

  /**
   * Enforce PostgreSQL row-level security by setting app.person_id / app.roles
   * as transaction-local settings on every request-scoped query. Requires the
   * connection role to be a non-superuser (see migrations/033_rls_and_grants.sql)
   * because superusers and table owners bypass RLS entirely.
   */
  DB_RLS_ENABLED: envBool(true),

  CERBOS_HOST: z.string().default('localhost'),
  CERBOS_PORT: z.coerce.number().default(3592),
  CERBOS_POLICY_DIR: z.string().default('./policies'),
  CERBOS_POLL_INTERVAL: z.string().default('60s'),
  /** When false, no Cerbos connection is attempted and no route may claim a Cerbos decision. */
  CERBOS_ENABLED: envBool(false),

  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('edurankai-hrms'),
  JWT_AUDIENCE: z.string().default('edurankai-hrms-api'),
  /** Access token lifetime. Short, because roles are re-derived per request. */
  JWT_TTL: z.string().default('30m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(14),
  /** How long a derived role set may be reused before it is re-read from the database. */
  ROLE_CACHE_TTL_MS: z.coerce.number().default(15000),

  OIDC_PROVIDER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),

  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  /** Failed password attempts before an account is temporarily locked. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().default(8),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().default(15),

  /**
   * Passwordless persona switching for sandbox demos. Hard opt-in: the endpoint
   * returns 404 unless this is true AND DEMO_SEED_SECRET is set, it is refused
   * outright in production, and it will never mint a privileged persona.
   */
  DEMO_MODE: envBool(false),
  DEMO_SEED_SECRET: z.string().min(16).optional(),

  HEALTH_DATA_ENCRYPTION_KEY: z.string().optional(),
  HEALTH_SERVICE_JWT_SECRET: z.string().optional(),

  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().default(2555),
  /**
   * When true, a failed audit write aborts the operation that triggered it.
   * The audit trail is a control, not a log: if it cannot be written, the
   * action it was meant to record must not be considered to have happened.
   */
  AUDIT_FAIL_CLOSED: envBool(true),

  /**
   * Single authoritative timezone for civil-day boundaries (attendance days,
   * leave dates, payroll periods). Per-person overrides come from
   * health.persons.timezone; this is the org-level fallback. Never use the
   * server's local timezone for these — it is not a business fact.
   */
  ORG_TIMEZONE: z.string().default('Asia/Kolkata'),

  /** Statutory payroll jurisdiction and defaults. See migrations/031_payroll_statutory.sql. */
  PAYROLL_JURISDICTION: z.string().default('IN'),
  PAYROLL_TAX_REGIME: z.enum(['NEW', 'OLD']).default('NEW'),

  FEATURE_3D_ENABLED: envBool(false),
  FEATURE_AI_ENABLED: envBool(false),
  FEATURE_WORKFORCE_SIMULATION: envBool(false),
});

const parsed = envSchema.parse(process.env);

/**
 * Refuse to boot a production process that is configured like a demo.
 *
 * Every item here was a real finding: a guessable signing secret committed in
 * .env, a superuser database URL with no password and no TLS, and a
 * passwordless login endpoint gated only by NODE_ENV.
 */
function assertProductionSafety(c: typeof parsed): void {
  if (c.NODE_ENV !== 'production') return;
  const problems: string[] = [];

  const weakSecret = [/demo/i, /development/i, /changeme/i, /example/i, /secret-key/i, /^test/i];
  if (weakSecret.some((p) => p.test(c.JWT_SECRET))) {
    problems.push('JWT_SECRET looks like a development placeholder. Generate one with: openssl rand -base64 48');
  }
  if (new Set(c.JWT_SECRET).size < 16) {
    problems.push('JWT_SECRET has too little entropy (fewer than 16 distinct characters).');
  }
  if (c.JWT_SECRET.length < 48) {
    problems.push('JWT_SECRET must be at least 48 characters in production.');
  }

  let dbUrl: URL | null = null;
  try {
    dbUrl = new URL(c.DATABASE_URL);
  } catch {
    problems.push('DATABASE_URL is not parseable.');
  }
  if (dbUrl) {
    if (!dbUrl.password) problems.push('DATABASE_URL has no password.');
    if (['postgres', 'superuser', 'root'].includes(decodeURIComponent(dbUrl.username))) {
      problems.push(
        `DATABASE_URL connects as "${dbUrl.username}". Superusers and table owners bypass row-level ` +
          'security, which disables every policy in migrations/033_rls_and_grants.sql. Use the hrms_app role.'
      );
    }
    const sslmode = dbUrl.searchParams.get('sslmode');
    if (!sslmode || ['disable', 'allow', 'prefer'].includes(sslmode)) {
      problems.push('DATABASE_URL must set sslmode=require (or stricter) in production.');
    }
  }

  if (c.DEMO_MODE) problems.push('DEMO_MODE must be false in production — it permits passwordless login.');
  if (!c.DB_RLS_ENABLED) problems.push('DB_RLS_ENABLED must not be disabled in production.');
  if (!c.AUDIT_FAIL_CLOSED) problems.push('AUDIT_FAIL_CLOSED must not be disabled in production.');
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(c.CORS_ORIGIN)) {
    problems.push(`CORS_ORIGIN is a loopback address (${c.CORS_ORIGIN}).`);
  }
  if (c.LOG_LEVEL === 'trace' || c.LOG_LEVEL === 'debug') {
    problems.push(`LOG_LEVEL=${c.LOG_LEVEL} risks writing request bodies containing personal data to disk.`);
  }

  if (problems.length > 0) {
    throw new Error(
      'Refusing to start in production with an unsafe configuration:\n' +
        problems.map((p) => `  - ${p}`).join('\n')
    );
  }
}

assertProductionSafety(parsed);

if (parsed.DEMO_MODE && !parsed.DEMO_SEED_SECRET) {
  throw new Error('DEMO_MODE=true requires DEMO_SEED_SECRET (min 16 chars) to be set.');
}

export const config = parsed;

export type Config = z.infer<typeof envSchema>;

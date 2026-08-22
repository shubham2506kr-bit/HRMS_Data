#!/usr/bin/env node
/**
 * PRODUCTION GATE — the thing that is allowed to say "no".
 *
 * The previous version of this file was theatre. It compared HTTP status codes
 * only, never looked at a response body, never inspected the process it was
 * certifying, and — decisively — never called process.exit with a non-zero
 * code. A CI job wired to it could not fail. It also asserted that logging in
 * with the shared demo password `demo1234` returned 200 IN PRODUCTION, i.e. it
 * certified the presence of a known credential as a pass.
 *
 * This version:
 *   - asserts on response BODIES, not just statuses;
 *   - exits 1 on any failure and prints which checks failed;
 *   - exits 2 when checks could not run (incomplete is not success);
 *   - exits 0 only when every check passed;
 *   - inverts the credential check: a successful `demo1234` login is a FAILURE.
 *
 * Nothing here silently passes. A check that cannot be executed is recorded as
 * INCOMPLETE and keeps the gate from returning 0.
 *
 * GROUPS
 *   config    static — parses the effective environment as if NODE_ENV=production
 *   source    static — asserts the remediated invariants are present in the tree
 *   build     spawns dist/config/index.js with poisoned env; needs `npm run build`
 *   database  needs DATABASE_URL and the `pg`/`bcryptjs` deps (run from backend/)
 *   live      needs a running instance at GATE_API
 *
 * USAGE
 *   node scripts/prod_gate.mjs
 *
 * ENVIRONMENT
 *   GATE_API                  base URL of the running instance (default :3001)
 *   GATE_ENV_FILE             env file to audit (default backend/.env)
 *   GATE_USERNAME/_PASSWORD   a real, non-privileged account for the live group
 *   GATE_OTHER_PERSON_ID      a person id the GATE_USERNAME actor must not read
 *   GATE_OTHER_PAYSLIP_ID     a payslip id belonging to someone else
 *   GATE_OTHER_MILESTONE_ID   a milestone id in a project the actor cannot touch
 *   GATE_THROTTLE_USERNAME    account used for the lockout probe (it WILL be
 *                             locked for LOGIN_LOCKOUT_MINUTES); default: none
 *   GATE_ALLOW_MUTATING=1     enables the payroll segregation-of-duties probe,
 *                             which creates a payroll run. Off by default.
 *   GATE_PAYROLL_USERNAME/_PASSWORD  credentials allowed to create payroll runs
 *
 * EXIT CODES
 *   0  every check passed
 *   1  at least one check failed
 *   2  no failures, but at least one check could not be executed
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const REPO = path.resolve(BACKEND, '..');

const API = (process.env.GATE_API ?? 'http://localhost:3001').replace(/\/+$/, '');
const ENV_FILE = process.env.GATE_ENV_FILE ?? path.join(BACKEND, '.env');
const ALLOW_MUTATING = /^(1|true|yes)$/i.test(process.env.GATE_ALLOW_MUTATING ?? '');

const GROUP = {
  CONFIG: 'config',
  SOURCE: 'source',
  BUILD: 'build (requires npm run build)',
  DB: 'database (requires DATABASE_URL)',
  LIVE: 'live (requires running instance)',
};

/** Thrown by a check that could not be executed. Never counted as a pass. */
class Incomplete extends Error {}
const incomplete = (reason) => {
  throw new Incomplete(reason);
};

const results = [];

async function check(group, id, name, fn) {
  let detail = '';
  let state = 'PASS';
  try {
    detail = (await fn()) ?? '';
  } catch (error) {
    state = error instanceof Incomplete ? 'INCOMPLETE' : 'FAIL';
    detail = error?.message ? String(error.message) : String(error);
  }
  results.push({ group, id, name, state, detail: String(detail).slice(0, 400) });
  const mark = state === 'PASS' ? 'PASS' : state === 'FAIL' ? 'FAIL' : 'INCOMPLETE';
  console.log(`${mark.padEnd(10)} ${id.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`);
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function mustEqual(actual, expected, what) {
  must(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function mustBeOneOf(actual, allowed, what) {
  must(allowed.includes(actual), `${what}: expected one of ${allowed.join('/')}, got ${JSON.stringify(actual)}`);
}

function mustMatch(haystack, pattern, what) {
  must(pattern.test(haystack), `${what}: no match for ${pattern}`);
}

function mustNotMatch(haystack, pattern, what) {
  must(!pattern.test(haystack), `${what}: unexpected match for ${pattern}`);
}

/** Field names that must never appear in a response body the actor is not entitled to. */
const SENSITIVE_FIELDS = [
  'legal_name',
  'date_of_birth',
  'national_id',
  'bank_account',
  'password_hash',
  'net_pay',
  'gross_pay',
  'salary',
  'base_salary',
];

/**
 * The core body assertion the old gate lacked. A 403 whose body still contains
 * the record is not a pass, and neither is a 200 that leaks a field the caller
 * is not entitled to.
 */
function mustNotLeak(body, what, fields = SENSITIVE_FIELDS) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  const found = fields.filter((f) => new RegExp(`"${f}"\\s*:`).test(text));
  must(found.length === 0, `${what}: body contains ${found.join(', ')}`);
}

// ---------------------------------------------------------------------------
// environment file
// ---------------------------------------------------------------------------

/** Parse a dotenv-style file into a plain object. Comments and blanks ignored. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip an inline comment only when the value is unquoted
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '');
    value = value.replace(/^(["'])(.*)\1$/, '$2');
    out[key] = value;
  }
  return out;
}

let ENV = null;
async function env() {
  if (ENV) return ENV;
  if (!existsSync(ENV_FILE)) {
    incomplete(`env file not found: ${ENV_FILE} (set GATE_ENV_FILE)`);
  }
  ENV = parseEnv(await readFile(ENV_FILE, 'utf8'));
  return ENV;
}

/** Truthy-flag parse that matches config/index.ts — "false" means false. */
const flag = (value, fallback) =>
  value === undefined || value === '' ? fallback : ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());

// ---------------------------------------------------------------------------
// source tree
// ---------------------------------------------------------------------------

async function source(relative) {
  const full = path.join(REPO, relative);
  if (!existsSync(full)) incomplete(`file not found: ${relative}`);
  return await readFile(full, 'utf8');
}

/** Concatenate every migration file so cross-file assertions do not care which one. */
let MIGRATIONS = null;
async function migrations() {
  if (MIGRATIONS) return MIGRATIONS;
  const dir = path.join(REPO, 'migrations');
  if (!existsSync(dir)) incomplete('migrations/ directory not found');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const parts = [];
  for (const file of files) parts.push(`-- FILE ${file}\n${await readFile(path.join(dir, file), 'utf8')}`);
  MIGRATIONS = { files, text: parts.join('\n') };
  return MIGRATIONS;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function req(pathname, options = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {}),
  };
  let res;
  try {
    res = await fetch(API + pathname, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    });
  } catch (error) {
    incomplete(`${API} unreachable (${error?.cause?.code ?? error?.message ?? 'network error'})`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Decode a JWT payload without verifying it — we are inspecting claims, not trusting them. */
function jwtPayload(token) {
  const parts = String(token ?? '').split('.');
  must(parts.length === 3, 'token is not a three-part JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

/** Re-encode a JWT payload with extra claims, keeping the original signature. */
function tamperToken(token, extraClaims) {
  const [header, payload, signature] = String(token).split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...decoded, ...extraClaims }), 'utf8').toString('base64url');
  return `${header}.${forged}.${signature}`;
}

const DEMO_USERNAMES = ['john', 'jane', 'robert', 'emily', 'michael', 'sarah', 'david', 'lisa'];
const SHARED_DEMO_PASSWORD = 'demo1234';

/** Log in and return the bundle, or throw with the server's own message. */
async function login(username, password) {
  const res = await req('/api/auth/login', { method: 'POST', body: { username, password } });
  must(
    res.status === 200,
    `login as ${username} returned ${res.status} ${JSON.stringify(res.json ?? res.text).slice(0, 160)}`
  );
  must(typeof res.json?.token === 'string' && res.json.token.length > 20, 'login body has no usable token');
  return res.json;
}

let ACTOR = null;
/** The non-privileged actor every ownership probe runs as. */
async function actor() {
  if (ACTOR) return ACTOR;
  const username = process.env.GATE_USERNAME;
  const password = process.env.GATE_PASSWORD;
  if (!username || !password) {
    incomplete('set GATE_USERNAME and GATE_PASSWORD to a real non-privileged account');
  }
  ACTOR = await login(username, password);
  return ACTOR;
}

// ===========================================================================
// GROUP: config — the process must not be configured like a demo
// ===========================================================================

const WEAK_SECRET_PATTERNS = [/demo/i, /development/i, /changeme/i, /change-me/i, /example/i, /secret-key/i, /^test/i, /placeholder/i, /GENERATE/i];

async function configChecks() {
  const g = GROUP.CONFIG;

  await check(g, 'C1', 'JWT_SECRET is set', async () => {
    const e = await env();
    must(typeof e.JWT_SECRET === 'string' && e.JWT_SECRET.length > 0, 'JWT_SECRET is missing');
    return `${e.JWT_SECRET.length} chars`;
  });

  await check(g, 'C2', 'JWT_SECRET is not a development placeholder', async () => {
    const e = await env();
    const hit = WEAK_SECRET_PATTERNS.find((p) => p.test(e.JWT_SECRET ?? ''));
    must(!hit, `JWT_SECRET matches ${hit} — generate one with: openssl rand -base64 48`);
  });

  await check(g, 'C3', 'JWT_SECRET is at least 48 characters', async () => {
    const e = await env();
    must((e.JWT_SECRET ?? '').length >= 48, `JWT_SECRET is ${(e.JWT_SECRET ?? '').length} chars`);
  });

  await check(g, 'C4', 'JWT_SECRET has at least 16 distinct characters', async () => {
    const e = await env();
    const distinct = new Set(e.JWT_SECRET ?? '').size;
    must(distinct >= 16, `only ${distinct} distinct characters`);
  });

  await check(g, 'C5', 'DATABASE_URL is parseable', async () => {
    const e = await env();
    new URL(e.DATABASE_URL ?? '');
  });

  await check(g, 'C6', 'DATABASE_URL carries a password', async () => {
    const e = await env();
    const url = new URL(e.DATABASE_URL ?? '');
    must(url.password.length > 0, 'DATABASE_URL has no password');
  });

  await check(g, 'C7', 'DATABASE_URL is not a superuser', async () => {
    const e = await env();
    const url = new URL(e.DATABASE_URL ?? '');
    const user = decodeURIComponent(url.username);
    must(
      !['postgres', 'superuser', 'root', 'admin'].includes(user.toLowerCase()),
      `connects as "${user}" — superusers and table owners bypass RLS, voiding migration 033`
    );
    return `user=${user}`;
  });

  await check(g, 'C8', 'DATABASE_URL requires TLS', async () => {
    const e = await env();
    const sslmode = new URL(e.DATABASE_URL ?? '').searchParams.get('sslmode');
    must(sslmode !== null, 'no sslmode set — expected require, verify-ca or verify-full');
    mustBeOneOf(sslmode, ['require', 'verify-ca', 'verify-full'], 'sslmode');
  });

  await check(g, 'C9', 'DEMO_MODE is off', async () => {
    const e = await env();
    must(flag(e.DEMO_MODE, false) === false, 'DEMO_MODE=true permits passwordless login');
  });

  await check(g, 'C10', 'DEMO_SEED_SECRET is coherent with DEMO_MODE', async () => {
    const e = await env();
    if (!flag(e.DEMO_MODE, false)) return 'DEMO_MODE off';
    must((e.DEMO_SEED_SECRET ?? '').length >= 16, 'DEMO_MODE=true requires DEMO_SEED_SECRET of >=16 chars');
    must(!WEAK_SECRET_PATTERNS.some((p) => p.test(e.DEMO_SEED_SECRET)), 'DEMO_SEED_SECRET is a placeholder');
  });

  await check(g, 'C11', 'DB_RLS_ENABLED is on', async () => {
    const e = await env();
    must(flag(e.DB_RLS_ENABLED, true) === true, 'DB_RLS_ENABLED must not be disabled');
  });

  await check(g, 'C12', 'AUDIT_FAIL_CLOSED is on', async () => {
    const e = await env();
    must(flag(e.AUDIT_FAIL_CLOSED, true) === true, 'AUDIT_FAIL_CLOSED must not be disabled');
  });

  await check(g, 'C13', 'CORS_ORIGIN is a real origin', async () => {
    const e = await env();
    const origin = e.CORS_ORIGIN ?? '';
    must(origin !== '*', 'CORS_ORIGIN is a wildcard');
    mustNotMatch(origin, /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i, 'CORS_ORIGIN is a loopback address');
    mustMatch(origin, /^https:\/\//i, 'CORS_ORIGIN must be https in production');
  });

  await check(g, 'C14', 'LOG_LEVEL does not record request bodies', async () => {
    const e = await env();
    must(!['debug', 'trace'].includes((e.LOG_LEVEL ?? 'info').toLowerCase()), `LOG_LEVEL=${e.LOG_LEVEL}`);
  });

  await check(g, 'C15', 'a root .gitignore excludes every .env variant', async () => {
    const file = path.join(REPO, '.gitignore');
    must(existsSync(file), 'no .gitignore at the repository root');
    const text = await readFile(file, 'utf8');
    for (const pattern of ['.env', '.env.*', 'node_modules', '*.log', 'dist']) {
      must(
        text.split(/\r?\n/).some((line) => line.trim() === pattern),
        `.gitignore has no "${pattern}" rule`
      );
    }
    must(
      text.split(/\r?\n/).some((line) => line.trim() === '!.env.example'),
      '.gitignore must re-include !.env.example so the template stays in the tree'
    );
  });

  await check(g, 'C16', 'no committed .log files outside node_modules', async () => {
    const found = [];
    async function walk(dir, depth) {
      if (depth > 4) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.name.endsWith('.log')) found.push(path.relative(REPO, full));
      }
    }
    await walk(REPO, 0);
    must(found.length === 0, `${found.length} .log files in the tree: ${found.slice(0, 6).join(', ')}${found.length > 6 ? ' …' : ''}`);
  });

  await check(g, 'C17', '.env.example documents every variable the app reads', async () => {
    const schema = await source('backend/src/config/index.ts');
    const example = await source('backend/.env.example');
    const declared = new Set();
    for (const match of schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s/gm)) declared.add(match[1]);
    must(declared.size > 20, `only parsed ${declared.size} keys out of config/index.ts — parser needs updating`);
    const documented = new Set();
    for (const match of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) documented.add(match[1]);
    const missing = [...declared].filter((key) => !documented.has(key)).sort();
    must(missing.length === 0, `.env.example is missing: ${missing.join(', ')}`);
    return `${declared.size} variables documented`;
  });
}

// ===========================================================================
// GROUP: source — each defect remediated on 2026-08-22, as something that
// must be TRUE. These run without a server, a build or a database.
// ===========================================================================

async function sourceChecks() {
  const g = GROUP.SOURCE;

  await check(g, 'S1', 'access tokens carry no roles claim', async () => {
    const auth = await source('backend/src/lib/auth.ts');
    const signBody = auth.slice(auth.indexOf('export async function signJwt'));
    const signCall = signBody.slice(0, signBody.indexOf('.sign('));
    mustNotMatch(signCall, /\broles\b/, 'signJwt still puts roles in the token payload');
    mustNotMatch(signCall, /\bpermissions\b/, 'signJwt still puts permissions in the token payload');
  });

  await check(g, 'S2', 'token verification does not read roles out of the token', async () => {
    const auth = await source('backend/src/lib/auth.ts');
    const verify = auth.slice(auth.indexOf('export async function verifyJwt'));
    mustNotMatch(verify, /payload\.roles/, 'verifyJwt reads payload.roles');
  });

  await check(g, 'S3', 'roles are re-derived from the database on every request', async () => {
    const middleware = await source('backend/src/authz/middleware.ts');
    mustMatch(middleware, /deriveRoles\s*\(/, 'middleware never calls deriveRoles');
    mustMatch(middleware, /ROLE_CACHE_TTL_MS/, 'middleware does not bound the role cache with ROLE_CACHE_TTL_MS');
    mustMatch(middleware, /invalidateRoleCache/, 'no way to invalidate a cached role set');
  });

  await check(g, 'S4', '/api/auth/demo is 404 unless DEMO_MODE is explicitly enabled', async () => {
    const routes = await source('backend/src/modules/auth/routes.ts');
    const demo = routes.slice(routes.indexOf("app.post('/api/auth/demo'"));
    must(demo.length > 0, 'no /api/auth/demo handler found');
    const guard = demo.slice(0, demo.indexOf('}'));
    mustMatch(guard, /config\.DEMO_MODE\s*!==\s*true/, 'demo route is not gated on DEMO_MODE');
    mustMatch(guard, /DEMO_SEED_SECRET|demoSecret/, 'demo route is not gated on DEMO_SEED_SECRET');
    mustMatch(guard, /NODE_ENV\s*===\s*'production'/, 'demo route is not refused in production');
    mustMatch(guard, /code\(404\)/, 'demo route does not answer 404 when disabled');
  });

  await check(g, 'S5', 'the demo endpoint refuses privileged personas', async () => {
    const routes = await source('backend/src/modules/auth/routes.ts');
    mustMatch(routes, /PRIVILEGED_DEMO_ROLES/, 'no privileged-persona refusal list');
    mustMatch(routes, /x-demo-secret/, 'demo endpoint does not require the x-demo-secret header');
    mustMatch(routes, /DEMO_LOGIN_REFUSED_PRIVILEGED/, 'privileged refusals are not audited');
  });

  await check(g, 'S6', 'repeated failed logins are throttled', async () => {
    const routes = await source('backend/src/modules/auth/routes.ts');
    mustMatch(routes, /LOGIN_MAX_ATTEMPTS/, 'no attempt ceiling');
    mustMatch(routes, /LOGIN_LOCKOUT_MINUTES/, 'no lockout window');
    mustMatch(routes, /code\(429\)/, 'lockout does not answer 429');
    mustMatch(routes, /Retry-After/i, 'lockout sends no Retry-After header');
    mustMatch(routes, /failed_attempt_count\s*\+\s*1/, 'the failed-attempt counter is never incremented');
  });

  await check(g, 'S7', 'the service worker never touches an API response', async () => {
    const sw = await source('frontend/public/sw.js');
    const apiGuards = sw.match(/pathname\.startsWith\('\/api\/'\)/g) ?? [];
    must(apiGuards.length >= 2, 'expected /api/ to be excluded on both the read and the write path');
    mustNotMatch(sw, /cache-first[^\n]*\/api\//i, 'a cache-first path still mentions /api/');
    mustMatch(sw, /caches\.delete/, 'the worker cannot purge a cache');
  });

  await check(g, 'S8', 'logout purges every cache the origin owns', async () => {
    const sw = await source('frontend/public/sw.js');
    mustMatch(sw, /purge|clearAllCaches|caches\.keys\(\)/, 'no cache purge routine');
    const main = await source('frontend/src/main.tsx');
    mustMatch(main, /serviceWorker/, 'main.tsx no longer registers or unregisters the worker');
  });

  await check(g, 'S9', 'the audit writer is fail-closed', async () => {
    const audit = await source('backend/src/lib/audit.ts');
    mustMatch(audit, /class AuditWriteError/, 'no AuditWriteError type');
    mustMatch(audit, /throw new AuditWriteError/, 'AuditWriteError is never thrown');
    mustMatch(audit, /AUDIT_FAIL_CLOSED/, 'the writer does not consult AUDIT_FAIL_CLOSED');
  });

  await check(g, 'S10', 'the audit trail rejects UPDATE and DELETE at the database', async () => {
    const { text } = await migrations();
    mustMatch(text, /audit_log/i, 'no audit_log table in migrations');
    mustMatch(text, /BEFORE\s+UPDATE\s+OR\s+DELETE|BEFORE\s+UPDATE[\s\S]{0,80}audit_log/i, 'no UPDATE/DELETE trigger on audit_log');
    mustMatch(text, /RAISE\s+EXCEPTION/i, 'the trigger never raises');
  });

  await check(g, 'S11', 'audit rows are hash-chained', async () => {
    const { text } = await migrations();
    mustMatch(text, /prev_hash|previous_hash/i, 'no previous-hash column');
    mustMatch(text, /row_hash|entry_hash/i, 'no row-hash column');
    mustMatch(text, /sha256/i, 'no SHA-256 digest in the chain');
  });

  await check(g, 'S12', 'the migration runner reads a directory that exists', async () => {
    const pool = await source('backend/src/db/pool.ts');
    const literals = [...pool.matchAll(/['"`]([^'"`]*migrations[^'"`]*)['"`]/g)].map((m) => m[1]);
    must(literals.length > 0, 'pool.ts references no migrations path at all');
    const from = path.join(BACKEND, 'src', 'db');
    const broken = literals.filter((literal) => !existsSync(path.resolve(from, literal.replace(/^\//, ''))));
    must(
      broken.length === 0,
      `pool.ts reads migrations from ${broken.join(', ')} — resolved from src/db that path does not exist, so no migration file has ever been executed by the application`
    );
    return literals.join(', ');
  });

  await check(g, 'S13', 'row-level security is defined and needs a non-superuser role', async () => {
    const { text, files } = await migrations();
    must(files.some((f) => /^033_/.test(f)), 'migration 033 (RLS and grants) is absent');
    mustMatch(text, /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i, 'no table enables row-level security');
    mustMatch(text, /FORCE\s+ROW\s+LEVEL\s+SECURITY/i, 'RLS is not forced, so the table owner still bypasses it');
    mustMatch(text, /CREATE\s+POLICY/i, 'no RLS policy is created');
    mustMatch(text, /hrms_app/i, 'no hrms_app application role');
  });

  await check(g, 'S14', 'a payroll run cannot be approved by the person who created it', async () => {
    const payroll = await source('backend/src/modules/payroll/routes.ts');
    mustMatch(payroll, /created_by\s+IS\s+DISTINCT\s+FROM/i, 'the approve UPDATE does not exclude the creator');
    mustMatch(payroll, /approved_by/, 'no approver is recorded');
    const { text } = await migrations();
    mustMatch(text, /created_by/i, 'payroll_runs has no created_by column to segregate on');
  });

  await check(g, 'S15', 'the Cerbos module is explicitly deny-only', async () => {
    const cerbos = await source('backend/src/authz/cerbos.ts');
    mustMatch(cerbos, /EFFECT_DENY/, 'no deny effect');
    mustNotMatch(cerbos, /allowed:\s*true/, 'a decision path can still return allowed: true');
    mustNotMatch(cerbos, /healthy:\s*true/, 'the health probe still hardcodes success');
  });

  await check(g, 'S16', 'every policy file is labelled NOT ENFORCED', async () => {
    const dir = path.join(REPO, 'policies');
    if (!existsSync(dir)) incomplete('policies/ directory not found');
    const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f));
    must(files.length > 0, 'policies/ holds no YAML files');
    const unlabelled = [];
    for (const file of files) {
      const text = await readFile(path.join(dir, file), 'utf8');
      if (!/NOT ENFORCED/.test(text)) unlabelled.push(file);
    }
    must(unlabelled.length === 0, `no NOT ENFORCED banner in: ${unlabelled.join(', ')}`);
    return `${files.length} files labelled`;
  });

  await check(g, 'S17', 'payroll has statutory deductions and pro-rating', async () => {
    const { text, files } = await migrations();
    must(files.some((f) => /^031_/.test(f)), 'migration 031 (statutory payroll) is absent');
    for (const token of ['epf', 'esi', 'professional_tax', 'tds']) {
      mustMatch(text, new RegExp(token, 'i'), `no ${token.toUpperCase()} component`);
    }
    mustNotMatch(text, /\/\s*30(\.0)?\b[^\n]*day/i, 'a hardcoded 30-day divisor is still present');
  });
}

// ===========================================================================
// GROUP: build — the app must REFUSE TO BOOT on an unsafe production config.
// Spawns the compiled config module with a poisoned environment. Needs
// `npm run build` first; without it these are INCOMPLETE, never PASS.
// ===========================================================================

const SAFE_PROD_ENV = {
  NODE_ENV: 'production',
  JWT_SECRET: 'A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz-aBcDeFgHiJkLmNoPqRsTuVwXy',
  DATABASE_URL: 'postgresql://hrms_app:s3cret@db.internal:5432/edurankai?sslmode=require',
  CORS_ORIGIN: 'https://hrms.internal',
  LOG_LEVEL: 'info',
  DEMO_MODE: 'false',
  DB_RLS_ENABLED: 'true',
  AUDIT_FAIL_CLOSED: 'true',
};

function configEntryPoint() {
  for (const candidate of ['dist/config/index.js', 'dist/src/config/index.js']) {
    const full = path.join(BACKEND, candidate);
    if (existsSync(full)) return full;
  }
  incomplete('no compiled config module under backend/dist — run `npm run build` first');
}

/** Import the compiled config with the given environment. Returns exit status + output. */
function bootWith(overrides) {
  const entry = configEntryPoint();
  const script =
    `import(${JSON.stringify(new URL(`file://${entry.replace(/\\/g, '/')}`).href)})` +
    `.then(() => process.exit(0), (error) => { console.error(String(error && error.message)); process.exit(3); });`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO, // no .env here, so only the variables below are in play
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...SAFE_PROD_ENV, ...overrides },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function buildChecks() {
  const g = GROUP.BUILD;

  await check(g, 'B1', 'production boot is refused with a weak JWT_SECRET', async () => {
    const { status, output } = bootWith({ JWT_SECRET: 'edurankai-hrms-demo-development-secret-key-2026' });
    must(status !== 0, 'the process started with a guessable signing secret');
    mustMatch(output, /JWT_SECRET/i, `refused, but not because of JWT_SECRET: ${output.slice(0, 160)}`);
  });

  await check(g, 'B2', 'production boot is refused with a superuser DATABASE_URL', async () => {
    const { status, output } = bootWith({ DATABASE_URL: 'postgres://postgres@localhost:5432/edurankai' });
    must(status !== 0, 'the process started as the postgres superuser, which bypasses every RLS policy');
    mustMatch(output, /DATABASE_URL|superuser|row-level/i, `refused for the wrong reason: ${output.slice(0, 160)}`);
  });

  await check(g, 'B3', 'production boot is refused with DEMO_MODE=true', async () => {
    const { status, output } = bootWith({ DEMO_MODE: 'true', DEMO_SEED_SECRET: 'x'.repeat(24) });
    must(status !== 0, 'the process started with passwordless demo login enabled');
    mustMatch(output, /DEMO_MODE/i, `refused for the wrong reason: ${output.slice(0, 160)}`);
  });

  await check(g, 'B4', 'a safe production config still boots', async () => {
    const { status, output } = bootWith({});
    must(status === 0, `a valid production configuration was rejected: ${output.slice(0, 200)}`);
  });
}

// ===========================================================================
// GROUP: database — controls that live in PostgreSQL, not in a route.
// Run from backend/ so `pg` and `bcryptjs` resolve.
// ===========================================================================

let CLIENT = null;
async function db() {
  if (CLIENT) return CLIENT;
  const e = await env();
  const connectionString = process.env.DATABASE_URL ?? e.DATABASE_URL;
  if (!connectionString) incomplete('no DATABASE_URL to connect with');
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    incomplete('the pg package is not resolvable — run this script from backend/');
  }
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
  } catch (error) {
    incomplete(`could not connect to the database (${error?.message ?? 'unknown error'})`);
  }
  CLIENT = client;
  return CLIENT;
}

/** Does this statement raise? Runs inside a rolled-back transaction. */
async function raisesInTransaction(sql) {
  const client = await db();
  await client.query('BEGIN');
  try {
    await client.query(sql);
    return null; // no error: the guard is missing
  } catch (error) {
    return error.message;
  } finally {
    await client.query('ROLLBACK');
  }
}

const PERSON_SCOPED = /(persons|payslip|payroll_entr|leave_request|attendance|wallet|audit_log|messages|notifications|goals|advisor_queries|safety_checkins|consent)/i;

async function databaseChecks() {
  const g = GROUP.DB;

  await check(g, 'D1', 'the application connects as a non-superuser', async () => {
    const client = await db();
    const r = await client.query(
      `SELECT current_user AS who,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
              current_setting('is_superuser') AS session_super`
    );
    const row = r.rows[0];
    must(row.is_super !== true, `${row.who} is a superuser — RLS is silently bypassed`);
    mustEqual(row.session_super, 'off', 'session superuser state');
    return `current_user=${row.who}`;
  });

  await check(g, 'D2', 'row-level security is on for every person-scoped table', async () => {
    const client = await db();
    const r = await client.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'health' AND c.relkind = 'r'`
    );
    must(r.rows.length > 0, 'no tables found in the health schema');
    const scoped = r.rows.filter((row) => PERSON_SCOPED.test(row.relname));
    must(scoped.length > 0, 'no person-scoped tables matched — the schema is not what this gate expects');
    const naked = scoped.filter((row) => row.relrowsecurity !== true).map((row) => row.relname);
    must(naked.length === 0, `RLS disabled on: ${naked.join(', ')}`);
    return `${scoped.length} tables protected`;
  });

  await check(g, 'D3', 'UPDATE on the audit trail is rejected', async () => {
    const client = await db();
    const count = await client.query('SELECT count(*)::int AS n FROM health.audit_log');
    if (count.rows[0].n === 0) incomplete('health.audit_log is empty — nothing to attempt an UPDATE against');
    const message = await raisesInTransaction(
      'UPDATE health.audit_log SET action = action WHERE ctid = (SELECT ctid FROM health.audit_log LIMIT 1)'
    );
    must(message !== null, 'an UPDATE against health.audit_log succeeded');
    return message.slice(0, 120);
  });

  await check(g, 'D4', 'DELETE on the audit trail is rejected', async () => {
    const client = await db();
    const count = await client.query('SELECT count(*)::int AS n FROM health.audit_log');
    if (count.rows[0].n === 0) incomplete('health.audit_log is empty — nothing to attempt a DELETE against');
    const message = await raisesInTransaction(
      'DELETE FROM health.audit_log WHERE ctid = (SELECT ctid FROM health.audit_log LIMIT 1)'
    );
    must(message !== null, 'a DELETE against health.audit_log succeeded');
    return message.slice(0, 120);
  });

  await check(g, 'D5', 'no account authenticates with the shared demo password', async () => {
    const client = await db();
    let bcrypt;
    try {
      bcrypt = (await import('bcryptjs')).default;
    } catch {
      incomplete('bcryptjs is not resolvable — run this script from backend/');
    }
    const r = await client.query('SELECT username, password_hash FROM health.user_accounts');
    if (r.rows.length === 0) incomplete('health.user_accounts is empty or hidden by RLS');
    const usable = r.rows.filter((row) => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(row.password_hash ?? ''));
    const cracked = [];
    for (const row of usable) {
      if (await bcrypt.compare(SHARED_DEMO_PASSWORD, row.password_hash)) cracked.push(row.username);
    }
    must(cracked.length === 0, `${cracked.length} accounts still use "${SHARED_DEMO_PASSWORD}": ${cracked.join(', ')}`);
    return `${r.rows.length} accounts, ${usable.length} with a usable hash`;
  });

  await check(g, 'D6', 'the audit hash chain is present and unique per row', async () => {
    const client = await db();
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'health' AND table_name = 'audit_log'`
    );
    const names = cols.rows.map((row) => row.column_name);
    must(names.length > 0, 'health.audit_log does not exist');
    const prev = names.find((n) => /prev.*hash|previous.*hash/i.test(n));
    const own = names.find((n) => /^(row|entry|record)_hash$/i.test(n)) ?? names.find((n) => /hash/i.test(n) && n !== prev);
    must(Boolean(prev), 'no previous-hash column on health.audit_log');
    must(Boolean(own), 'no row-hash column on health.audit_log');
    const r = await client.query(
      `SELECT count(*)::int AS total,
              count(DISTINCT ${own})::int AS distinct_hashes,
              count(*) FILTER (WHERE ${own} IS NULL)::int AS unhashed
         FROM health.audit_log`
    );
    const row = r.rows[0];
    if (row.total === 0) incomplete('health.audit_log is empty — no chain to verify');
    mustEqual(row.unhashed, 0, 'rows with no hash');
    mustEqual(row.distinct_hashes, row.total, 'distinct row hashes vs row count');
    return `${row.total} rows chained on ${prev}/${own}`;
  });
}

// ===========================================================================
// GROUP: live — requires a running instance at GATE_API. Every assertion here
// looks at the response BODY as well as the status code.
// ===========================================================================

async function liveChecks() {
  const g = GROUP.LIVE;

  await check(g, 'L1', 'the instance is up and reports a healthy database', async () => {
    const res = await req('/health');
    mustEqual(res.status, 200, '/health status');
    must(res.json !== null, '/health returned no JSON body');
    const text = JSON.stringify(res.json);
    mustMatch(text, /"(db|database)"/i, '/health body says nothing about the database');
    mustNotMatch(text, /unhealthy|"down"|"error"/i, `/health body reports a problem: ${text.slice(0, 160)}`);
    return text.slice(0, 120);
  });

  await check(g, 'L2', `the shared demo password "${SHARED_DEMO_PASSWORD}" is refused everywhere`, async () => {
    const accepted = [];
    for (const username of DEMO_USERNAMES) {
      const res = await req('/api/auth/login', {
        method: 'POST',
        body: { username, password: SHARED_DEMO_PASSWORD },
      });
      // INVERTED on purpose: the old gate asserted 200 here and called it a pass.
      if (res.status === 200 || typeof res.json?.token === 'string') accepted.push(`${username}(${res.status})`);
    }
    must(accepted.length === 0, `a shared demo credential still logs in: ${accepted.join(', ')}`);
    return `${DEMO_USERNAMES.length} seeded accounts refused`;
  });

  await check(g, 'L3', '/api/auth/demo does not exist', async () => {
    const plain = await req('/api/auth/demo', { method: 'POST', body: { username: 'john' } });
    mustEqual(plain.status, 404, 'POST /api/auth/demo status');
    mustNotMatch(plain.text, /"token"/, 'the demo endpoint returned a token');
    const withSecret = await req('/api/auth/demo', {
      method: 'POST',
      body: { username: 'john' },
      headers: { 'x-demo-secret': 'guess-the-seed-secret' },
    });
    mustEqual(withSecret.status, 404, 'POST /api/auth/demo with a guessed secret');
    const empty = await req('/api/auth/demo', { method: 'POST', body: {} });
    mustEqual(empty.status, 404, 'POST /api/auth/demo with no username');
  });

  await check(g, 'L4', 'the API documentation surface is not exposed', async () => {
    for (const route of ['/docs', '/docs/static/index.html', '/docs/json', '/documentation']) {
      const res = await req(route);
      must([404, 401].includes(res.status), `${route} returned ${res.status}`);
    }
  });

  await check(g, 'L5', 'real password login works and returns a complete session', async () => {
    const bundle = await actor();
    must(typeof bundle.token === 'string', 'no access token in the login body');
    must(typeof bundle.refreshToken === 'string' && bundle.refreshToken.length >= 20, 'no refresh token in the login body');
    must(Array.isArray(bundle.user?.roles), 'the login body carries no derived roles');
    mustNotLeak(bundle, 'login body', ['password_hash', 'national_id', 'bank_account']);
    return `roles=${bundle.user.roles.join(',')}`;
  });

  await check(g, 'L6', 'the issued access token carries no authority', async () => {
    const bundle = await actor();
    const payload = jwtPayload(bundle.token);
    const claims = Object.keys(payload);
    for (const forbidden of ['roles', 'role', 'permissions', 'scopes', 'is_admin', 'privileged']) {
      must(!claims.includes(forbidden), `the token carries a "${forbidden}" claim — roles must be re-derived per request`);
    }
    must(typeof payload.sub === 'string', 'the token has no subject');
    must(typeof payload.exp === 'number', 'the token has no expiry');
    return `claims=${claims.join(',')}`;
  });

  await check(g, 'L7', 'a token whose roles were tampered with is rejected', async () => {
    const bundle = await actor();
    const forged = tamperToken(bundle.token, { roles: ['hr_manager', 'finance', 'leadership'], sub: jwtPayload(bundle.token).sub });
    const res = await req('/api/auth/me', { token: forged });
    mustEqual(res.status, 401, 'GET /api/auth/me with a tampered payload');
    mustNotMatch(res.text, /hr_manager|finance|leadership/, 'the response echoed the injected roles');

    // A structurally valid token for another subject must not be honoured either.
    const swapped = tamperToken(bundle.token, { sub: '00000000-0000-0000-0000-000000000001' });
    const res2 = await req('/api/auth/me', { token: swapped });
    mustEqual(res2.status, 401, 'GET /api/auth/me with a swapped subject');
  });

  await check(g, 'L8', 'unauthenticated data requests are refused and return no data', async () => {
    for (const route of ['/api/persons', '/api/payroll/runs', '/api/system/observability', '/api/audit/query']) {
      const res = await req(route);
      mustBeOneOf(res.status, [401, 403, 404], `${route} unauthenticated`);
      mustNotLeak(res.text, `${route} unauthenticated body`);
    }
  });

  await check(g, 'L9', 'the staff directory exposes no legal names or dates of birth', async () => {
    const bundle = await actor();
    const res = await req('/api/persons', { token: bundle.token });
    mustEqual(res.status, 200, 'GET /api/persons as an employee');
    mustNotLeak(res.text, 'directory body', ['legal_name', 'date_of_birth', 'national_id', 'email', 'phone', 'timezone']);
    return `${Array.isArray(res.json) ? res.json.length : '?'} rows, no identity fields`;
  });

  await check(g, 'L10', "another employee's person record is not readable", async () => {
    const other = process.env.GATE_OTHER_PERSON_ID;
    if (!other) incomplete('set GATE_OTHER_PERSON_ID to a person the GATE_USERNAME actor must not read');
    const bundle = await actor();
    const res = await req(`/api/persons/${other}`, { token: bundle.token });
    mustBeOneOf(res.status, [403, 404], 'GET /api/persons/:id for a colleague');
    mustNotLeak(res.text, 'colleague record body');
  });

  await check(g, 'L11', "another employee's payslip is not readable", async () => {
    const other = process.env.GATE_OTHER_PAYSLIP_ID;
    if (!other) incomplete('set GATE_OTHER_PAYSLIP_ID to a payslip belonging to another employee');
    const bundle = await actor();
    const res = await req(`/api/payroll/payslips/${other}`, { token: bundle.token });
    mustBeOneOf(res.status, [403, 404], 'GET /api/payroll/payslips/:id for a colleague');
    mustNotLeak(res.text, 'colleague payslip body');
  });

  await check(g, 'L12', 'a plain employee cannot reach the payroll lifecycle', async () => {
    const bundle = await actor();
    const list = await req('/api/payroll/runs', { token: bundle.token });
    mustEqual(list.status, 403, 'GET /api/payroll/runs as an employee');
    mustNotLeak(list.text, 'payroll runs body');
    const create = await req('/api/payroll/runs', {
      token: bundle.token,
      method: 'POST',
      body: { period_start: '2020-01-01', period_end: '2020-01-31' },
    });
    mustEqual(create.status, 403, 'POST /api/payroll/runs as an employee');
  });

  await check(g, 'L13', "another project's milestone cannot be modified", async () => {
    const milestone = process.env.GATE_OTHER_MILESTONE_ID;
    if (!milestone) incomplete('set GATE_OTHER_MILESTONE_ID to a milestone in a project the actor does not own');
    const bundle = await actor();
    const res = await req(`/api/projects/milestones/${milestone}`, {
      token: bundle.token,
      method: 'PUT',
      body: { status: 'COMPLETED' },
    });
    mustBeOneOf(res.status, [403, 404], 'PUT a foreign milestone');
  });

  await check(g, 'L14', 'operational telemetry is privileged-only', async () => {
    const bundle = await actor();
    const res = await req('/api/system/observability', { token: bundle.token });
    mustEqual(res.status, 403, 'GET /api/system/observability as an employee');
    mustNotMatch(res.text, /scheduler|heartbeat|event_count/i, 'the body leaked telemetry anyway');
  });

  await check(g, 'L15', 'a payroll run cannot be approved by the person who created it', async () => {
    if (!ALLOW_MUTATING) {
      incomplete('mutating probe disabled — set GATE_ALLOW_MUTATING=1 (it creates a payroll run you must then void)');
    }
    const username = process.env.GATE_PAYROLL_USERNAME;
    const password = process.env.GATE_PAYROLL_PASSWORD;
    if (!username || !password) incomplete('set GATE_PAYROLL_USERNAME and GATE_PAYROLL_PASSWORD');
    const payrollActor = await login(username, password);
    const created = await req('/api/payroll/runs', {
      token: payrollActor.token,
      method: 'POST',
      body: { period_start: '1990-01-01', period_end: '1990-01-31' },
    });
    mustBeOneOf(created.status, [200, 201], 'the payroll actor could not create a run to test with');
    const runId = created.json?.run_id ?? created.json?.id ?? created.json?.logical_id;
    must(Boolean(runId), `no run id in the create response: ${created.text.slice(0, 160)}`);
    const approve = await req(`/api/payroll/runs/${runId}/approve`, { token: payrollActor.token, method: 'POST', body: {} });
    must(approve.status !== 200, 'the creator of a payroll run approved it themselves');
    mustBeOneOf(approve.status, [403, 409], 'self-approval status');
    mustMatch(approve.text, /creat|segregat|another|different/i, `refused, but the reason is unclear: ${approve.text.slice(0, 160)}`);
    return `run ${runId} left behind — void it manually`;
  });

  await check(g, 'L16', 'repeated failed logins are throttled with 429', async () => {
    const username = process.env.GATE_THROTTLE_USERNAME;
    if (!username) {
      incomplete('set GATE_THROTTLE_USERNAME — the probe locks that account for LOGIN_LOCKOUT_MINUTES');
    }
    let sawThrottle = null;
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      const res = await req('/api/auth/login', {
        method: 'POST',
        body: { username, password: `wrong-password-${attempt}` },
      });
      if (res.status === 429) {
        sawThrottle = { attempt, retryAfter: res.headers.get('retry-after') };
        break;
      }
      mustEqual(res.status, 401, `attempt ${attempt} status`);
    }
    must(sawThrottle !== null, '15 consecutive failed logins were all answered 401 — nothing throttles');
    must(sawThrottle.retryAfter !== null, 'the 429 carried no Retry-After header');
    return `429 after ${sawThrottle.attempt} attempts, Retry-After=${sawThrottle.retryAfter}s`;
  });
}

// ===========================================================================
// runner
// ===========================================================================

async function main() {
  console.log('PRODUCTION GATE');
  console.log(`  target      ${API}`);
  console.log(`  env file    ${ENV_FILE}`);
  console.log(`  repository  ${REPO}`);
  console.log('');

  for (const [title, run] of [
    ['config', configChecks],
    ['source', sourceChecks],
    ['build', buildChecks],
    ['database', databaseChecks],
    ['live', liveChecks],
  ]) {
    console.log(`--- ${title} ---`);
    await run();
    console.log('');
  }

  if (CLIENT) {
    await CLIENT.end().catch(() => undefined);
  }

  const failed = results.filter((r) => r.state === 'FAIL');
  const incompleteChecks = results.filter((r) => r.state === 'INCOMPLETE');
  const passed = results.filter((r) => r.state === 'PASS');

  console.log('='.repeat(72));
  for (const group of Object.values(GROUP)) {
    const rows = results.filter((r) => r.group === group);
    if (rows.length === 0) continue;
    const p = rows.filter((r) => r.state === 'PASS').length;
    const f = rows.filter((r) => r.state === 'FAIL').length;
    const i = rows.filter((r) => r.state === 'INCOMPLETE').length;
    console.log(`  ${group.padEnd(38)} ${p}/${rows.length} pass · ${f} fail · ${i} incomplete`);
  }
  console.log('='.repeat(72));
  console.log(`  TOTAL ${passed.length}/${results.length} pass · ${failed.length} fail · ${incompleteChecks.length} incomplete`);

  if (failed.length > 0) {
    console.log('\nFAILED CHECKS — these are the reasons this build must not ship:');
    for (const r of failed) console.log(`  ${r.id} [${r.group}] ${r.name}\n      ${r.detail}`);
  }
  if (incompleteChecks.length > 0) {
    console.log('\nCOULD NOT BE EXECUTED — an unrun check is not a passing check:');
    for (const r of incompleteChecks) console.log(`  ${r.id} [${r.group}] ${r.name}\n      ${r.detail}`);
  }

  console.log('');
  if (failed.length > 0) {
    console.log('VERDICT: FAIL — do not deploy. (exit 1)');
    process.exit(1);
  }
  if (incompleteChecks.length > 0) {
    console.log('VERDICT: INCOMPLETE — the gate could not prove the system is safe. (exit 2)');
    process.exit(2);
  }
  console.log(`VERDICT: PASS — all ${results.length} checks passed. (exit 0)`);
  process.exit(0);
}

main().catch(async (error) => {
  // A crash in the harness must never look like a pass.
  console.error('\nGATE HARNESS CRASHED:', error?.stack ?? error);
  if (CLIENT) await CLIENT.end().catch(() => undefined);
  process.exit(1);
});

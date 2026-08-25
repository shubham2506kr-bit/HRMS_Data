import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { config } from '../config/index.js';
import { query } from '../db/pool.js';
import { getRequestContext } from './requestContext.js';

export interface AuditEntry {
  personId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  request?: FastifyRequest;
}

/**
 * Thrown when a required audit row could not be persisted and
 * `config.AUDIT_FAIL_CLOSED` is true.
 *
 * The audit trail is a control, not a log. If the row cannot be written the
 * action it was meant to record must not be treated as having happened, so
 * this propagates out of `writeAudit` and aborts the calling handler. The
 * global error handler should map it to 503 (`statusCode`) and must never
 * expose `details` to the client.
 */
export class AuditWriteError extends Error {
  readonly code = 'AUDIT_WRITE_FAILED';
  readonly statusCode = 503;
  readonly action: string;
  readonly targetType: string;
  readonly attempts: number;
  /** True when the row reached the local append-only fallback sink. */
  readonly persistedToFallback: boolean;
  readonly lastError: unknown;

  constructor(args: {
    action: string;
    targetType: string;
    attempts: number;
    persistedToFallback: boolean;
    lastError: unknown;
  }) {
    super(
      `Audit write failed for ${args.action} on ${args.targetType} after ${args.attempts} attempt(s); ` +
        'the operation was aborted because AUDIT_FAIL_CLOSED is enabled.'
    );
    this.action = args.action;
    this.targetType = args.targetType;
    this.attempts = args.attempts;
    this.persistedToFallback = args.persistedToFallback;
    this.lastError = args.lastError;
    this.name = 'AuditWriteError';
  }
}

// ============================================================
// details sanitising
// ============================================================

/** Keys whose value is an identifier — the point of an audit trail, always kept. */
const KEEP_ID_KEY = /(^|_)(id|ids|uuid|logical_id)$/i;

/** Never store these, whatever the value type: government identifiers, financial instruments. */
const HARD_DENY_KEY =
  /(national_?id|aadhaa?r|passport|ssn|\bpan\b|pan_?(no|num|number|card)|bank|iban|ifsc|swift|upi|cvv|card_?(no|num|number)|account_?(no|num|number))/i;

/** Compensation figures: legitimate to reference, never to copy into audit details. */
const MONEY_KEY = /(salary|wage|ctc|compensation|base_?pay|net_?pay|gross_?pay|take_?home|payslip_?amount)/i;

/** Credentials, clinical content and free text. */
const SENSITIVE_KEY = new RegExp(
  [
    'pass(word|phrase)?',
    'pwd',
    'token',
    'secret',
    'api_?key',
    'authorization',
    'auth_?header',
    'credential',
    'cookie',
    'bearer',
    'otp',
    '\\bpin\\b',
    'mfa',
    'private_?key',
    'reason',
    'note',
    'comment',
    'remark',
    'justification',
    'explanation',
    'free_?text',
    'body',
    'content',
    'answer',
    'question',
    'prompt',
    'diagnos',
    'symptom',
    'medicat',
    'prescription',
    'treatment',
    'allerg',
    'therap',
    'mental_?health',
    'clinical',
    'disability',
    'grievance',
    'complaint',
    'address',
    'phone',
    'mobile',
    'email',
    'date_of_birth',
    'latitude',
    'longitude',
    'coordinates',
  ].join('|'),
  'i'
);

const MAX_DEPTH = 4;
const MAX_KEYS_PER_OBJECT = 40;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_CHARS = 200;
const MAX_DETAILS_BYTES = 4096;
const MAX_REDACTION_NOTES = 25;

function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  switch (typeof value) {
    case 'string':
      return `string(${value.length})`;
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'object':
      return `object(${Object.keys(value as Record<string, unknown>).length} keys)`;
    default:
      return typeof value;
  }
}

function looksLikeIdentifier(value: string): boolean {
  return value.length <= 64 && !/\s/.test(value);
}

type Redactions = Map<string, string>;

function noteRedaction(redactions: Redactions, path: string, value: unknown): void {
  if (redactions.size >= MAX_REDACTION_NOTES) return;
  redactions.set(path, shapeOf(value));
}

const REDACTED = '[redacted]';

function sanitiseValue(value: unknown, key: string, path: string, depth: number, redactions: Redactions): unknown {
  if (value === null || value === undefined) return null;

  if (HARD_DENY_KEY.test(key)) {
    noteRedaction(redactions, path, value);
    return REDACTED;
  }

  // Booleans and (non-money) numbers cannot carry credentials or free text.
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (MONEY_KEY.test(key)) {
      noteRedaction(redactions, path, value);
      return REDACTED;
    }
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    if (MONEY_KEY.test(key)) {
      noteRedaction(redactions, path, value);
      return REDACTED;
    }
    return String(value);
  }

  if (typeof value === 'string') {
    if (KEEP_ID_KEY.test(key) && looksLikeIdentifier(value) && !SENSITIVE_KEY.test(key)) return value;
    if (SENSITIVE_KEY.test(key) || MONEY_KEY.test(key)) {
      noteRedaction(redactions, path, value);
      return REDACTED;
    }
    if (value.length > MAX_STRING_CHARS) {
      // Long strings under innocuous keys are where clinical narrative hides.
      noteRedaction(redactions, path, value);
      return REDACTED;
    }
    return value;
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      noteRedaction(redactions, path, value);
      return REDACTED;
    }
    const out = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, i) => sanitiseValue(item, key, `${path}[${i}]`, depth + 1, redactions));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return out;
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) {
      noteRedaction(redactions, path, value);
      return REDACTED;
    }
    return sanitiseObject(value as Record<string, unknown>, path, depth + 1, redactions);
  }

  // functions, symbols
  noteRedaction(redactions, path, value);
  return REDACTED;
}

function sanitiseObject(
  input: Record<string, unknown>,
  path: string,
  depth: number,
  redactions: Redactions
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_KEYS_PER_OBJECT) {
      out['_keys_omitted'] = Object.keys(input).length - count;
      break;
    }
    count++;
    out[key] = sanitiseValue(value, key, path ? `${path}.${key}` : key, depth, redactions);
  }
  return out;
}

/**
 * Strip credentials, clinical free text and compensation figures from audit
 * details, cap the serialised size, and record the *shape* of everything that
 * was removed so the redaction itself is auditable. Identifiers are preserved.
 */
export function sanitiseAuditDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!details) return null;
  const redactions: Redactions = new Map();
  const sanitised = sanitiseObject(details, '', 0, redactions);
  if (redactions.size > 0) {
    sanitised['_redacted'] = Object.fromEntries(redactions);
  }

  let serialised = safeStringify(sanitised);
  if (serialised !== null && Buffer.byteLength(serialised, 'utf8') <= MAX_DETAILS_BYTES) return sanitised;

  // Still too large: drop the largest values until it fits, recording what went.
  const trimmed: Record<string, unknown> = { _truncated: true };
  const dropped: string[] = [];
  const entries = Object.entries(sanitised).sort(
    (a, b) => (safeStringify(a[1]) ?? '').length - (safeStringify(b[1]) ?? '').length
  );
  for (const [key, value] of entries) {
    const candidate = { ...trimmed, [key]: value };
    serialised = safeStringify(candidate);
    if (serialised !== null && Buffer.byteLength(serialised, 'utf8') <= MAX_DETAILS_BYTES) {
      trimmed[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) trimmed['_dropped_keys'] = dropped;
  return trimmed;
}

function safeStringify(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch {
    return null;
  }
}

// ============================================================
// transient-failure classification and retry
// ============================================================

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 40;

/**
 * SQLSTATE classes worth retrying: connection failures (08), serialisation and
 * deadlock (40001/40P01), lock unavailable (55P03), insufficient resources such
 * as a full disk (53*), and operator-intervention states (57P0*).
 * A constraint violation (23*) or a revoked grant (42501) will never succeed on
 * retry, so those fail immediately.
 */
function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  if (code.startsWith('08') || code.startsWith('53') || code.startsWith('57P0')) return true;
  if (code === '40001' || code === '40P01' || code === '55P03' || code === '55006') return true;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'ENOTFOUND';
}

function sqlState(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================
// last-resort append-only fallback sink
// ============================================================

const FALLBACK_DIR = process.env['AUDIT_FALLBACK_DIR'] ?? join(process.cwd(), 'logs');
const FALLBACK_FILE = join(FALLBACK_DIR, 'audit-fallback.ndjson');
let fallbackDirReady = false;

/**
 * Append the (already sanitised) audit record to a local NDJSON file so the
 * record is not lost when the database rejects it. This is a forensic
 * breadcrumb only: it never makes a failed write look successful, and the
 * operation is still aborted when AUDIT_FAIL_CLOSED is true.
 */
async function appendToFallbackSink(record: Record<string, unknown>): Promise<boolean> {
  try {
    if (!fallbackDirReady) {
      await mkdir(FALLBACK_DIR, { recursive: true });
      fallbackDirReady = true;
    }
    await appendFile(FALLBACK_FILE, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (error) {
    console.error('[AUDIT-FALLBACK-FAILURE] could not write local audit fallback sink:', errorMessage(error));
    return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveActor(entry: AuditEntry): { personId: string | null; source: 'caller' | 'context' | 'none' } {
  const passed = typeof entry.personId === 'string' ? entry.personId.trim() : '';
  if (UUID_RE.test(passed)) return { personId: passed, source: 'caller' };
  const ctx = getRequestContext();
  const fromContext = typeof ctx?.personId === 'string' ? ctx.personId.trim() : '';
  if (UUID_RE.test(fromContext)) return { personId: fromContext, source: 'context' };
  return { personId: null, source: 'none' };
}

/**
 * Fail-closed audit writer.
 *
 * Returns `true` when the row is committed. When the write cannot be made:
 *  - transient failures are retried a bounded number of times;
 *  - the sanitised record is appended to a local append-only sink;
 *  - a structured [AUDIT-FAILURE] line is logged;
 *  - and then, if `config.AUDIT_FAIL_CLOSED` is true (the default and the only
 *    permitted production setting), an `AuditWriteError` is THROWN so the
 *    calling handler aborts instead of proceeding unlogged. Only when
 *    fail-closed is explicitly disabled does it return `false`, which existing
 *    `if (!ok)` callers still handle.
 *
 * The acting person, the client IP and the request id fall back to
 * `getRequestContext()` when the caller did not pass them, so a row is never
 * orphaned. `details` is sanitised (see `sanitiseAuditDetails`).
 */
export async function writeAudit(entry: AuditEntry): Promise<boolean> {
  const ctx = getRequestContext();
  const actor = resolveActor(entry);
  const requestId = ctx?.requestId ?? (entry.request?.id as string | undefined) ?? null;
  const ip = entry.request?.ip ?? null;
  const userAgent = (entry.request?.headers?.['user-agent'] as string | undefined) ?? null;
  const targetId = typeof entry.targetId === 'string' && UUID_RE.test(entry.targetId.trim())
    ? entry.targetId.trim()
    : null;

  const details = sanitiseAuditDetails(entry.details) ?? {};
  if (requestId !== null) details['_request_id'] = requestId;
  if (actor.source === 'context') details['_actor_from'] = 'request_context';
  if (typeof entry.targetId === 'string' && targetId === null) details['_target_ref'] = entry.targetId.slice(0, 128);

  const failureRecord: Record<string, unknown> = {
    at: new Date().toISOString(),
    action: entry.action,
    target_type: entry.targetType,
    target_id: targetId,
    person_id: actor.personId,
    request_id: requestId,
    ip,
    details,
  };

  if (actor.personId === null) {
    // audit_log.person_id is NOT NULL: without an actor there is no valid row.
    console.error(
      '[AUDIT-FAILURE]',
      JSON.stringify({ ...failureRecord, reason: 'no_actor_person_id', fail_closed: config.AUDIT_FAIL_CLOSED })
    );
    const persisted = await appendToFallbackSink({ ...failureRecord, reason: 'no_actor_person_id' });
    if (config.AUDIT_FAIL_CLOSED) {
      throw new AuditWriteError({
        action: entry.action,
        targetType: entry.targetType,
        attempts: 0,
        persistedToFallback: persisted,
        lastError: new Error('no acting personId supplied and no request context available'),
      });
    }
    return false;
  }

  const params = [
    entry.action,
    entry.targetType,
    targetId,
    actor.personId,
    JSON.stringify(details),
    ip,
    userAgent === null ? null : userAgent.slice(0, 512),
  ];

  let lastError: unknown = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      await query(
        `INSERT INTO health.audit_log (action, target_type, target_id, person_id, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        params
      );
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS && isTransient(error)) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      break;
    }
  }

  const persisted = await appendToFallbackSink({
    ...failureRecord,
    reason: 'insert_failed',
    sqlstate: sqlState(lastError),
    error: errorMessage(lastError),
  });

  console.error(
    '[AUDIT-FAILURE]',
    JSON.stringify({
      action: entry.action,
      target_type: entry.targetType,
      target_id: targetId,
      person_id: actor.personId,
      request_id: requestId,
      attempts,
      sqlstate: sqlState(lastError),
      error: errorMessage(lastError),
      fallback_persisted: persisted,
      fail_closed: config.AUDIT_FAIL_CLOSED,
    })
  );

  if (config.AUDIT_FAIL_CLOSED) {
    throw new AuditWriteError({
      action: entry.action,
      targetType: entry.targetType,
      attempts,
      persistedToFallback: persisted,
      lastError,
    });
  }
  return false;
}

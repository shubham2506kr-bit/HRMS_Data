import { createHash, randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { sanitiseAuditDetails } from './audit.js';
import { getRequestContext } from './requestContext.js';

export interface EventInput {
  type: string;
  source: string;
  actorPersonId?: string | null;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** health.events stores these as UUID columns; anything else is a guaranteed 22P02. */
function asUuidOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Deterministically map an arbitrary idempotency string onto a UUID so callers
 * can pass natural keys (`leave:<id>:approved`) and still get real deduplication
 * from the (event_type, idempotency_key) unique index.
 */
function idempotencyUuid(key: string): string {
  const hex = createHash('sha256').update(key, 'utf8').digest('hex');
  const v = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return v;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 40;

function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  if (code.startsWith('08') || code.startsWith('53') || code.startsWith('57P0')) return true;
  if (code === '40001' || code === '40P01' || code === '55P03') return true;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
}

function sqlState(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Emit a domain event. Events persist before anything else consumes them;
 * duplicates are prevented by (event_type, idempotency_key).
 *
 * The payload passes through the same sanitiser as audit details, because event
 * rows are long-lived and readable by anyone with events access: credentials,
 * clinical free text and compensation figures must not be copied into them.
 * Identifiers survive.
 *
 * Returns the event id that now exists for this (type, idempotency_key) —
 * including when the insert was deduplicated — or `null` when the event could
 * not be persisted. Callers that treat events as a control (not telemetry)
 * must check for `null`; failures are logged as [EVENT-FAILURE], never silent.
 */
export async function emitEvent(input: EventInput): Promise<string | null> {
  const eventId = randomUUID();
  const ctx = getRequestContext();
  const actorPersonId = asUuidOrNull(input.actorPersonId) ?? asUuidOrNull(ctx?.personId) ?? null;
  const rawKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  const idempotencyKey = rawKey === '' ? randomUUID() : asUuidOrNull(rawKey) ?? idempotencyUuid(rawKey);
  const correlationId = asUuidOrNull(input.correlationId) ?? asUuidOrNull(ctx?.requestId) ?? null;
  const payload = sanitiseAuditDetails(input.payload) ?? {};

  const params = [
    eventId,
    input.type,
    input.source,
    actorPersonId,
    correlationId,
    asUuidOrNull(input.causationId),
    idempotencyKey,
    JSON.stringify(payload),
  ];

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const inserted = await query<{ event_id: string }>(
        `INSERT INTO health.events (
           event_id, event_type, source, actor_person_id, correlation_id, causation_id,
           idempotency_key, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_type, idempotency_key) DO NOTHING
         RETURNING event_id`,
        params
      );
      const row = inserted.rows[0];
      if (row) return row.event_id;

      // Deduplicated: return the id of the event that already represents this fact,
      // rather than an id that was never persisted.
      const existing = await query<{ event_id: string }>(
        `SELECT event_id FROM health.events WHERE event_type = $1 AND idempotency_key = $2`,
        [input.type, idempotencyKey]
      );
      return existing.rows[0]?.event_id ?? null;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS && isTransient(error)) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      break;
    }
  }

  console.error(
    '[EVENT-FAILURE]',
    JSON.stringify({
      event_type: input.type,
      source: input.source,
      actor_person_id: actorPersonId,
      correlation_id: correlationId,
      sqlstate: sqlState(lastError),
      error: lastError instanceof Error ? lastError.message : String(lastError),
    })
  );
  return null;
}

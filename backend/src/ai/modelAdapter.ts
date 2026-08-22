/* ==========================================================================
 * THERE IS NO LANGUAGE MODEL IN THIS SYSTEM. THIS FILE IS A TYPE CONTRACT.
 * ==========================================================================
 *
 * Established by inspection of the whole backend on 2026-08-22:
 *   - No provider SDK is installed. backend/package.json contains no openai,
 *     no @anthropic-ai/sdk, no @google/generative-ai, no langchain, no undici.
 *   - There is no outbound HTTP call anywhere in backend/src: no `fetch(`, no
 *     axios, no node:http/https client, no WebSocket, no child_process.
 *   - Nothing imports this module. `ModelAdapter` has zero implementations.
 *   - The "AI" features (modules/care, modules/concierge, workload
 *     intelligence) are deterministic keyword and rule matching over local
 *     data. No prompt is ever constructed and no text ever leaves the process.
 *
 * THEREFORE, AND THIS IS THE POINT: THERE ARE NO AI SECURITY CONTROLS HERE.
 *   No prompt-injection defence exists — there is no prompt.
 *   No output filtering, jailbreak detection, grounding check or refusal
 *   classifier exists — there is no model output.
 *   No model governance, evaluation, red-teaming or provider DPA applies —
 *   there is no provider.
 *   Any document claiming those controls (e.g. PHASE2_AI_SECURITY_MATRIX.md)
 *   is describing the interface below, not a running control. Do not cite it
 *   as assurance. An empty attack surface is a fine state to be in; a
 *   documented-but-absent control is not, because it stops anyone looking.
 *
 * WHAT THIS FILE IS FOR
 *   A forward contract so that if a model is ever bound, the authorization
 *   boundary does not move: adapters receive pre-filtered, already-authorized
 *   context and return data. Adapters never decide access. Authorization stays
 *   in authz/middleware.ts, lib/access.ts, the route handlers and PostgreSQL
 *   row-level security.
 *
 * WHY THE GATE BELOW EXISTS
 *   This system holds special-category health data (health.health_records,
 *   consent and access logs). If an adapter is ever dropped in, the failure
 *   mode to prevent is silent egress: an env var appears, an adapter is
 *   registered, and employee health text starts leaving the building with no
 *   consent record and no DPIA. bindModelAdapter() therefore refuses unless
 *   FEATURE_AI_ENABLED is explicitly true, and invokeModel() refuses to carry
 *   HEALTH-sensitivity content without a recorded consent decision. Both fail
 *   closed. No adapter is registered today, so invokeModel() always throws.
 * ========================================================================== */

import { config } from '../config/index.js';

export type SensitivityLevel = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'HEALTH';

/**
 * Context that has ALREADY passed authorization. Constructing one of these is
 * not an authorization decision — the caller must have made that decision
 * first, via lib/access.ts and its own route checks.
 */
export interface AuthorizedContext {
  personId: string;
  tenantId: string;
  /** Capability tokens the actor actually holds. An empty array grants nothing. */
  capabilities: string[];
  purpose: 'care' | 'wellbeing' | 'concierge' | 'analytics';
  allowedTopics: string[];
  dataLimit: number;
  /**
   * The single highest sensitivity this context is cleared to carry. Must be
   * set explicitly by the caller; there is no default and no inference from
   * `purpose`. See the note on assertContextAllowed().
   */
  maxSensitivity: SensitivityLevel;
  /**
   * Proof that the data subject has an active, unwithdrawn consent record
   * covering this purpose (health.health_consents). REQUIRED — and required to
   * be `true` — before any HEALTH-level content may be passed to an adapter.
   * A boolean is the weakest acceptable form of this: when a model is actually
   * bound, replace it with the consent row id so the decision is auditable.
   */
  healthConsentGranted: boolean;
}

export interface ModelRequest {
  context: AuthorizedContext;
  input: string;
  /** Declared sensitivity of `input`. The caller must classify; nothing guesses. */
  inputSensitivity: SensitivityLevel;
  maxTokens: number;
  temperature: number;
}

export interface ModelResponse {
  text: string;
  sources: string[];
  requiresEscalation: boolean;
  refusal: boolean;
}

export interface ModelAdapter {
  readonly provider: string;
  readonly version: string;
  /**
   * Implementations MUST honour `signal` (abort on timeout) and MUST NOT
   * retry a request that carried HEALTH-level content.
   */
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  SENSITIVE: 2,
  HEALTH: 3,
};

/** Capability required before HEALTH-level content may enter an adapter. */
export const HEALTH_EGRESS_CAPABILITY = 'health:model_egress';

/** Hard ceiling on any future outbound model call, in milliseconds. */
export const MODEL_CALL_TIMEOUT_MS = 10_000;

/**
 * May this context carry content at `level`?
 *
 * THE PREVIOUS IMPLEMENTATION OF THIS FUNCTION WAS A FICTION AND IS RECORDED
 * HERE SO IT IS NOT REINTRODUCED. It was:
 *
 *   return SENSITIVITY_ORDER[level] <=
 *     SENSITIVITY_ORDER[context.purpose === 'care' ? 'HEALTH' : 'SENSITIVE'];
 *
 * It derived clearance from a caller-supplied string: passing
 * `purpose: 'care'` cleared HEALTH data unconditionally, with no capability
 * check, no consent check and no subject scoping. For every other purpose,
 * including 'analytics', it cleared SENSITIVE. Despite the name it never
 * asserted anything — it returned a boolean, so an ignored return value read
 * as a pass. It looked like the gate the AI security documentation describes.
 *
 * This version is fail-closed: unknown level, empty capabilities, or HEALTH
 * without both the egress capability and a recorded consent all return false.
 */
export function assertContextAllowed(
  context: AuthorizedContext,
  level: SensitivityLevel
): boolean {
  // Looked up defensively: a JavaScript caller can pass a string outside the
  // union, and an unrecognised sensitivity must deny rather than compare as NaN.
  const table = SENSITIVITY_ORDER as Record<string, number | undefined>;
  const requested = table[level];
  const cleared = table[context.maxSensitivity];
  if (requested === undefined || cleared === undefined) return false;
  if (context.capabilities.length === 0) return false;
  if (requested > cleared) return false;
  if (level === 'HEALTH') {
    if (!context.healthConsentGranted) return false;
    if (!context.capabilities.includes(HEALTH_EGRESS_CAPABILITY)) return false;
  }
  return true;
}

/** Throwing form, for call sites that must not proceed on a false. */
export function requireContextAllowed(
  context: AuthorizedContext,
  level: SensitivityLevel
): void {
  if (!assertContextAllowed(context, level)) {
    throw new Error(
      `[AI] Refusing to process ${level} content for purpose "${context.purpose}": ` +
        'context is not cleared (capability, consent or sensitivity ceiling).'
    );
  }
}

/**
 * The adapter registry. Empty, and it starts empty on every boot: there is no
 * env var, config key or file that can populate it. Binding is a deliberate
 * code change plus an explicit feature flag, so no deployment can begin making
 * outbound calls by accident.
 */
let boundAdapter: ModelAdapter | null = null;

export function bindModelAdapter(adapter: ModelAdapter): void {
  if (!config.FEATURE_AI_ENABLED) {
    throw new Error(
      `[AI] Refusing to bind model adapter "${adapter.provider}": FEATURE_AI_ENABLED is false. ` +
        'Binding an adapter creates an egress path for employee data, including ' +
        'special-category health data. It must be an explicit, reviewed decision.'
    );
  }
  boundAdapter = adapter;
}

/** Null today, and null on every code path in this repository. */
export function getBoundModelAdapter(): ModelAdapter | null {
  return boundAdapter;
}

/**
 * The only sanctioned way to reach an adapter. Fails closed, in this order:
 *   1. no adapter bound            -> throw  (this is the state today)
 *   2. FEATURE_AI_ENABLED is false -> throw
 *   3. context not cleared for the declared input sensitivity -> throw
 *   4. HEALTH input without consent + egress capability       -> throw
 * and bounds whatever survives with a hard abort timeout.
 *
 * Nothing calls this. It exists so that the first person who wants a model call
 * has to pass these gates rather than invent their own.
 */
export async function invokeModel(request: ModelRequest): Promise<ModelResponse> {
  if (!config.FEATURE_AI_ENABLED) {
    throw new Error('[AI] FEATURE_AI_ENABLED is false: no model may be invoked.');
  }
  const adapter = boundAdapter;
  if (adapter === null) {
    throw new Error(
      '[AI] No model adapter is bound. This codebase contains no LLM integration ' +
        'and no outbound model call; the care, concierge and workload features are ' +
        'deterministic rule engines. See the header of this file.'
    );
  }
  requireContextAllowed(request.context, request.inputSensitivity);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_CALL_TIMEOUT_MS);
  try {
    return await adapter.invoke(request, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Care / employee health module.
//
// This module handles SPECIAL-CATEGORY personal data: health and wellbeing
// information about identifiable employees. Four rules govern everything below.
//
//  1. CONSENT AT THE POINT OF USE. Every read and every write of health data
//     re-checks health.fn_has_valid_consent() for the specific purpose. Consent
//     captured at signup is not consent now: it can have expired or been
//     withdrawn a second ago, and withdrawal takes effect immediately because
//     nothing is cached.
//  2. PURPOSE LIMITATION. Holding a privileged HR role does NOT grant sight of
//     clinical free text. Reads are the subject plus an explicitly named
//     clinical/wellbeing role (CLINICAL_ROLES). Managers get aggregate counts.
//  3. EXPLICIT COLUMN ALLOWLISTS. Never SELECT *, never `{ ...row }`. A spread
//     silently re-exposes any column added later — that exact pattern leaked a
//     free-text field in the leave module.
//  4. AUDIT WITHOUT CONTENT. Every access writes who read whose record for what
//     purpose. The free text itself never enters an audit row, and writeAudit is
//     called last so an audit failure cannot half-complete a handler.
//
// PLAINTEXT AT REST: clinical free text in health.advisor_queries and the note /
// location fields of health.safety_checkins are stored UNENCRYPTED.
// config.HEALTH_DATA_ENCRYPTION_KEY is deliberately not used here — see the
// header of migrations/036_consent_retention.sql for why half-encryption was
// rejected and what a real implementation requires. Do not assume this data is
// protected by cryptography; it is protected by RLS, consent, allowlists,
// retention and audit.

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query, getClient } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { config } from '../../config/index.js';
import { z } from 'zod';
import { buildAdvisorResponse, matchTopics as matchTopicsFn, DISCLAIMER } from './intents.js';
import { CareSession, buildTurn } from './agent.js';
import { syncTraditionalLibrary, TRADITIONAL_LIBRARY, TraditionalKnowledgeItem } from './traditional.js';

export const matchTopics = matchTopicsFn;

// --- Purposes -------------------------------------------------------------
// Mirrors health.processing_purposes. A purpose string is never taken from the
// request body for a gate decision; it is chosen by the handler.
export const PURPOSE = {
  ADVISORY: 'CARE_ADVISORY',
  ADVISORY_HISTORY: 'CARE_ADVISORY_HISTORY',
  SAFETY_CHECKIN: 'SAFETY_CHECKIN',
  CLINICAL_REVIEW: 'CLINICAL_REVIEW',
  WOMENS_CARE: 'WOMENS_CARE_RESOURCES',
} as const;

export type PurposeCode = (typeof PURPOSE)[keyof typeof PURPOSE];

const CONSENTABLE_PURPOSES = [
  PURPOSE.ADVISORY,
  PURPOSE.ADVISORY_HISTORY,
  PURPOSE.SAFETY_CHECKIN,
  PURPOSE.WOMENS_CARE,
] as const;

/**
 * Legacy request vocabulary. The UI posts { domain: 'women_care' }, but the
 * consent gate reads health.health_consents by purpose_code, so a free-text
 * domain has to be resolved to a purpose before anything is written. Anything
 * not in this table is refused: that is what stops CLINICAL_REVIEW — absent
 * from CONSENTABLE_PURPOSES on purpose, because it authorises someone ELSE to
 * read your health record — from being self-granted through a string field.
 */
const CONSENT_DOMAINS: ReadonlyArray<{ domain: string; purpose: PurposeCode; aliases?: string[] }> = [
  { domain: 'women_care', purpose: PURPOSE.WOMENS_CARE, aliases: ['womens_care', 'women'] },
  { domain: 'advisory', purpose: PURPOSE.ADVISORY, aliases: ['care_advisory'] },
  { domain: 'advisory_history', purpose: PURPOSE.ADVISORY_HISTORY },
  { domain: 'safety_checkin', purpose: PURPOSE.SAFETY_CHECKIN, aliases: ['safety'] },
];

/** Resolve a caller-supplied domain (or purpose code) to a consentable purpose. */
function resolveConsentPurpose(raw: string): PurposeCode | null {
  const needle = raw.trim().toLowerCase();
  const direct = CONSENTABLE_PURPOSES.find((p) => p.toLowerCase() === needle);
  if (direct) return direct;
  const entry = CONSENT_DOMAINS.find(
    (d) => d.domain === needle || (d.aliases ?? []).includes(needle)
  );
  return entry ? entry.purpose : null;
}

/** Answer in the vocabulary the UI speaks. */
function domainOfPurpose(purpose: string): string {
  return CONSENT_DOMAINS.find((d) => d.purpose === purpose)?.domain ?? purpose;
}

/**
 * Roles that may see another person's clinical free text. This is NOT
 * PRIVILEGED_ROLES / isPrivileged(): hr_generalist, leadership, finance and
 * auditor are privileged for employment records and must stay blind to health
 * content. Purpose limitation means the list is short and named.
 */
export const CLINICAL_ROLES = ['care_clinician', 'occupational_health'] as const;

export function isClinicalRole(roles: readonly string[]): boolean {
  return roles.some((r) => (CLINICAL_ROLES as readonly string[]).includes(r));
}

// Smallest group that may be reported in an aggregate view; below this a count
// re-identifies an individual. No aggregate endpoint exists yet; this is the
// threshold any future one must apply, so it is exported rather than inlined.
export const MIN_AGGREGATE_GROUP = 5;


// Sessionful care-agent conversations, keyed per person. Sessions are
// in-memory and intentionally short-lived: they exist to carry clarification
// context during one conversation, nothing more.
const sessions = new Map<string, CareSession>();

// MEM-1 hardening (Phase 2): sessions are short-lived by design; enforce a
// TTL and a hard cap so memory cannot grow unbounded and stale conversation
// context cannot survive across sessions.
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_MAX = 200;

function pruneSessions(now: number) {
  for (const [pid, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) sessions.delete(pid);
  }
  if (sessions.size > SESSION_MAX) {
    const oldest = [...sessions.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, sessions.size - SESSION_MAX);
    for (const [pid] of oldest) sessions.delete(pid);
  }
}

/**
 * Fetch (or create) the caller's OWN conversation session.
 *
 * The map is keyed by person id, but the key is not the only thing that has to
 * match. A session carries the person's preferred name and their clarification
 * context, so if a stored session's personId ever disagrees with the
 * authenticated caller the session is discarded instead of reused. Session
 * reuse is the only route by which one person's context could reach another
 * person's reply; this closes it by construction rather than by convention.
 */
function getOwnSession(personId: string, now: number): CareSession {
  const existing = sessions.get(personId);
  if (existing && existing.personId === personId) {
    existing.lastUsed = now;
    return existing;
  }
  if (existing) sessions.delete(personId);
  const fresh = new CareSession(personId);
  fresh.lastUsed = now;
  sessions.set(personId, fresh);
  return fresh;
}

// --- Consent gate ---------------------------------------------------------

type ConsentRow = {
  person_exists: boolean | null;
  is_minor: boolean | null;
  has_parental_consent: boolean | null;
  has_consent: boolean | null;
};

type ConsentGate =
  | { allowed: true; isMinor: boolean }
  | { allowed: false; code: string; message: string };

/**
 * The gate. Called before EVERY read and EVERY write of health data.
 *
 * Nothing here is cached or memoised: the whole point is that a withdrawal
 * recorded a second ago is honoured on the next request. Minority is evaluated
 * by health.fn_person_is_minor(), which does real date arithmetic in the org
 * timezone and treats an unknown date of birth as a minor.
 */
async function evaluateConsent(personId: string, purpose: PurposeCode): Promise<ConsentGate> {
  const result = await query(
    `SELECT (p.logical_id IS NOT NULL)                       AS person_exists,
            health.fn_person_is_minor($1, $3)                AS is_minor,
            health.fn_has_parental_consent($1)               AS has_parental_consent,
            health.fn_has_valid_consent($1, $2, $3)          AS has_consent
     FROM (SELECT 1 AS anchor) anchor
     LEFT JOIN health.persons p ON p.logical_id = $1`,
    [personId, purpose, config.ORG_TIMEZONE]
  );
  const row = result.rows[0] as ConsentRow | undefined;

  // No row at all is a broken query, not a permission: fail closed.
  if (!row || row.person_exists !== true) {
    return {
      allowed: false,
      code: 'NO_EMPLOYEE_RECORD',
      message: 'No employee record is linked to this account, so health data cannot be processed.',
    };
  }

  // Unknown date of birth resolves to `true` here — protected, not adult.
  const isMinor = row.is_minor !== false;
  if (isMinor && row.has_parental_consent !== true) {
    return {
      allowed: false,
      code: 'PARENTAL_CONSENT_REQUIRED',
      message:
        'This account belongs to (or may belong to) someone under 18, or their date of birth is not on record. ' +
        'Under section 9 of the DPDP Act, verifiable parental or guardian consent must be recorded before ' +
        'any health data is processed. Contact HR to complete verification.',
    };
  }

  if (row.has_consent !== true) {
    return {
      allowed: false,
      code: 'CONSENT_REQUIRED',
      message:
        `No current consent covers the purpose "${purpose}". Consent may never have been given, ` +
        'may have expired, or may have been withdrawn. Grant it at POST /api/care/consent to continue.',
    };
  }

  return { allowed: true, isMinor };
}

function denyConsent(reply: FastifyReply, gate: { code: string; message: string }, purpose: PurposeCode) {
  return reply.code(403).send({
    error: 'Forbidden',
    code: gate.code,
    purpose,
    message: gate.message,
  });
}

// --- Audit ----------------------------------------------------------------

/**
 * Record that someone touched health data: WHO read WHOSE record for WHAT
 * purpose, and how many records. No question, no reply, no note, no location,
 * no diagnosis — the content is exactly what must not be duplicated into a
 * second table with a different retention rule and a wider audience.
 *
 * Always the LAST await in a handler: writeAudit throws AuditWriteError (503)
 * when AUDIT_FAIL_CLOSED is set, and an access that cannot be logged must not
 * be reported as successful.
 */
async function auditHealthAccess(args: {
  request: FastifyRequest;
  actorPersonId: string;
  subjectPersonId: string;
  action: string;
  purpose: PurposeCode | 'DATA_SUBJECT_REQUEST';
  targetType: string;
  targetId: string | null;
  recordCount: number;
}): Promise<void> {
  await writeAudit({
    personId: args.actorPersonId,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    details: {
      subject_person_id: args.subjectPersonId,
      purpose: args.purpose,
      record_count: args.recordCount,
      self_access: args.actorPersonId === args.subjectPersonId,
    },
    request: args.request,
  });
}

// --- Shared validation ----------------------------------------------------

/** Every list endpoint is capped; an uncapped list of health rows is an export. */
const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

/** request.user is set by authenticate(); narrow it once, explicitly. */
function actorOf(request: FastifyRequest): { personId: string; roles: string[] } {
  const user = request.user;
  return {
    personId: typeof user?.personId === 'string' ? user.personId : '',
    roles: Array.isArray(user?.roles) ? user.roles : [],
  };
}


/**
 * Storage limitation, applied to the caller's own rows on every write.
 *
 * This ERASES THE PAYLOAD rather than deleting the row: an audit entry may
 * reference the record, and destroying the row would break the audit trail
 * while destroying the content is exactly what retention requires. The window
 * comes from health.retention_policies, so changing it is a data change.
 *
 * Scoped to one person on purpose. The previous version ran an unscoped
 * cross-person DELETE on every request, which is both a latency problem and
 * something row-level security will refuse; the estate-wide sweep is
 * health.fn_apply_retention(), run by the scheduler.
 */
async function pruneAdvisorQueries(personId: string) {
  await query(
    `UPDATE health.advisor_queries
     SET question = '', reply = '', matched_topic_ids = '{}'
     WHERE person_id = $1
       AND (question <> '' OR reply <> '')
       AND query_id NOT IN (
         SELECT query_id FROM health.advisor_queries
         WHERE person_id = $1 ORDER BY created_at DESC LIMIT 100)`,
    [personId]
  );
  await query(
    `UPDATE health.advisor_queries q
     SET question = '', reply = '', matched_topic_ids = '{}'
     WHERE q.person_id = $1
       AND (q.question <> '' OR q.reply <> '')
       AND q.created_at < NOW() - make_interval(days => (
             SELECT rp.retention_days FROM health.retention_policies rp
             WHERE rp.purpose_code = $2
               AND rp.target_table = 'health.advisor_queries'
               AND rp.enabled))`,
    [personId, PURPOSE.ADVISORY_HISTORY]
  );
}

async function loadTopics() {
  const result = await query(
    `SELECT topic_id, code, title, summary, keywords, source_url, source_name,
            applicability, escalation_notes, citation, publication_date
     FROM health.who_topics WHERE approved = TRUE`
  );
  return result.rows;
}

// The traditional-knowledge registry is a governed code-level library; the
// DB copy exists for auditability and is kept in sync on every load.
async function loadTraditional() {
  await syncTraditionalLibrary({ query });
  const result = await query(
    `SELECT knowledge_id, title, category, tradition, source, source_type, source_url,
            original_text_reference, translation, interpretation, intended_use,
            evidence_level, safety_level, contraindications, interaction_warnings,
            population_restrictions, pregnancy_restrictions, review_date, reviewer, status, keywords
     FROM health.traditional_knowledge WHERE status = 'APPROVED'`
  );
  // Explicit field-by-field mapping, not `{ ...row }`. A spread would silently
  // surface any column a later migration adds to this table.
  const rows: TraditionalKnowledgeItem[] = result.rows.map((r) => ({
    knowledge_id: String(r.knowledge_id),
    title: String(r.title),
    category: r.category as TraditionalKnowledgeItem['category'],
    tradition: String(r.tradition),
    source: String(r.source),
    source_type: String(r.source_type),
    source_url: r.source_url ?? null,
    original_text_reference: r.original_text_reference ?? null,
    translation: r.translation ?? null,
    interpretation: String(r.interpretation),
    intended_use: r.intended_use ?? '',
    evidence_level: r.evidence_level as TraditionalKnowledgeItem['evidence_level'],
    safety_level: String(r.safety_level),
    contraindications: r.contraindications ?? null,
    interaction_warnings: r.interaction_warnings ?? null,
    population_restrictions: r.population_restrictions ?? null,
    pregnancy_restrictions: r.pregnancy_restrictions ?? null,
    review_date: String(r.review_date),
    reviewer: String(r.reviewer),
    status: r.status as TraditionalKnowledgeItem['status'],
    keywords: Array.isArray(r.keywords) ? r.keywords.map((k: unknown) => String(k)) : [],
  }));
  return rows.length > 0 ? rows : TRADITIONAL_LIBRARY;
}

export async function careRoutes(app: FastifyInstance) {
  // Public WHO reference content — not personal data, so no consent gate. Still
  // validated and capped like every other list endpoint in this module.
  app.get('/api/care/topics', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const page = paginationSchema.safeParse(request.query ?? {});
      if (!page.success) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid pagination parameters' });
      }
      const result = await query(
        `SELECT topic_id, code, title, source_url, source_name, last_reviewed
         FROM health.who_topics ORDER BY title LIMIT $1 OFFSET $2`,
        [page.data.limit, page.data.offset]
      );
      return reply.send({ topics: result.rows, limit: page.data.limit, offset: page.data.offset });
    }
  });

  // Conversation endpoint.
  //
  // NOT a language model. agent.ts is a deterministic pattern/state matcher over
  // two governed registries (approved WHO topics and the curated traditional
  // library). There is no model call and no outbound network request anywhere in
  // this path, so nothing here can improvise clinical content.
  app.post('/api/care/agent', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z
        .object({ message: z.string().min(1).max(500), clear: z.boolean().optional() })
        .strict();
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'A message of 1 to 500 characters is required',
        });
      }
      const data = parsed.data;
      const actor = actorOf(request);

      const now = Date.now();
      pruneSessions(now);
      const session = getOwnSession(actor.personId, now);
      if (data.clear) {
        session.reset();
        return reply.send({ cleared: true, phase: 'INITIAL', state: 'GREETING', risk: 'LOW', reply: 'Conversation cleared. How can I help you feel better today?', chips: [], tools: [], structure: null, intent: null, showProfessional: false, supportReason: null, turn: 0, mode: 'INFORMATION', knowledge: null, routine: null, knowledgeDomains: [], decision: { speechAct: 'STATEMENT', state: 'GREETING', intent: null, urgency: 'LOW', confidence: 0.5, requestedHelp: false, responseMode: 'DO_NOTHING', knowledgeSources: [], recommendedActions: [], escalation: 'NONE', conversationState: 'INITIAL' } });
      }

      // GATE 1 — the advisory purpose. The message is health free text from the
      // moment it arrives, so consent is verified before it is even looked at.
      // A withdrawal recorded one second ago is honoured here, because nothing
      // about consent is cached and the session is dropped on refusal.
      const gate = await evaluateConsent(actor.personId, PURPOSE.ADVISORY);
      if (!gate.allowed) {
        session.reset();
        sessions.delete(actor.personId);
        return denyConsent(reply, gate, PURPOSE.ADVISORY);
      }

      if (!session.personName) {
        const person = await query(
          `SELECT preferred_name FROM health.persons WHERE logical_id = $1`,
          [actor.personId]
        );
        session.personName = (person.rows[0]?.preferred_name as string | null | undefined) ?? null;
      }

      const topics = await loadTopics();
      const traditional = await loadTraditional();
      const answer = buildTurn(data.message, session, topics, traditional);

      const matchedIds: string[] = [];
      if (answer.structure && answer.intent) {
        const codeMap: Record<string, string> = {
          sleep: 'sleep',
          energy: 'physical-activity',
          physical_activity: 'physical-activity',
          mental_health_at_work: 'mental-health-at-work',
          depression: 'depression',
          alcohol: 'alcohol',
          diet: 'healthy-diet',
          ncd: 'ncds',
        };
        const hit = topics.find((t: { code: string }) => t.code === codeMap[answer.intent ?? '']);
        if (hit) matchedIds.push(hit.topic_id);
      }
      // GATE 2 — retention is a DIFFERENT purpose from answering. Without it the
      // question is answered and then forgotten rather than filed. Data
      // minimisation, not a technicality.
      const historyGate = await evaluateConsent(actor.personId, PURPOSE.ADVISORY_HISTORY);
      let stored = false;
      if (historyGate.allowed) {
        await query(
          `INSERT INTO health.advisor_queries (person_id, question, matched_topic_ids, reply)
           VALUES ($1, $2, $3, $4)`,
          [actor.personId, data.message, matchedIds, answer.reply]
        );
        await pruneAdvisorQueries(actor.personId);
        stored = true;
      }

      // Audit LAST, and content-free: who, whose record, what purpose, how many
      // rows. No question, no reply, and no intent code — an intent label such as
      // 'depression' is itself a clinical inference about a named employee.
      await auditHealthAccess({
        request,
        actorPersonId: actor.personId,
        subjectPersonId: actor.personId,
        action: 'CARE_AGENT_TURN',
        purpose: PURPOSE.ADVISORY,
        targetType: 'advisor_query',
        targetId: null,
        recordCount: stored ? 1 : 0,
      });

      // Response built field by field — no spread of `answer`, so a field added
      // to AgentTurnResult later cannot reach the client unreviewed.
      return reply.send({
        phase: answer.phase,
        mode: answer.mode,
        state: answer.state,
        risk: answer.risk,
        reply: answer.reply,
        chips: answer.chips,
        tools: answer.tools,
        structure: answer.structure,
        intent: answer.intent,
        showProfessional: answer.showProfessional,
        supportReason: answer.supportReason,
        knowledge: answer.knowledge ?? null,
        routine: answer.routine ?? null,
        knowledgeDomains: answer.knowledgeDomains ?? [],
        decision: answer.decision ?? null,
        turn: session.turn,
        stored,
        // `decision.confidence` is a deterministic keyword-match strength, not a
        // clinical probability, and none of this is advice or a diagnosis.
        disclaimer: DISCLAIMER,
      });
    }
  });

  // Single-shot advisor. Same deterministic matcher, same two gates.
  app.post('/api/care/advisor', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z.object({ question: z.string().min(2).max(500) }).strict();
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'A question of 2 to 500 characters is required',
        });
      }
      const data = parsed.data;
      const actor = actorOf(request);

      const gate = await evaluateConsent(actor.personId, PURPOSE.ADVISORY);
      if (!gate.allowed) return denyConsent(reply, gate, PURPOSE.ADVISORY);

      const topics = await query(
        `SELECT topic_id, code, title, summary, keywords, source_url, source_name,
                applicability, escalation_notes, citation, publication_date
         FROM health.who_topics WHERE approved = TRUE`
      );
      const answer = buildAdvisorResponse(data.question, topics.rows);

      const matchedIds: string[] = [];
      if (answer.structure) {
        const hit = topics.rows.find((t) => t.code === answer.matched[0]?.code);
        if (hit) matchedIds.push(hit.topic_id);
      }
      if (answer.matched.length > 0 && matchedIds.length === 0) {
        for (const m of answer.matched) {
          const hit = topics.rows.find((t) => t.code === m.code);
          if (hit) matchedIds.push(hit.topic_id);
        }
      }

      const historyGate = await evaluateConsent(actor.personId, PURPOSE.ADVISORY_HISTORY);
      let stored = false;
      if (historyGate.allowed) {
        await query(
          `INSERT INTO health.advisor_queries (person_id, question, matched_topic_ids, reply)
           VALUES ($1, $2, $3, $4)`,
          [actor.personId, data.question, matchedIds, answer.reply]
        );
        await pruneAdvisorQueries(actor.personId);
        stored = true;
      }

      await auditHealthAccess({
        request,
        actorPersonId: actor.personId,
        subjectPersonId: actor.personId,
        action: 'CARE_ADVISOR_QUERY',
        purpose: PURPOSE.ADVISORY,
        targetType: 'advisor_query',
        targetId: null,
        recordCount: stored ? 1 : 0,
      });

      return reply.send({
        reply: answer.reply,
        matched: answer.matched,
        disclaimer: answer.disclaimer,
        intent: answer.intent,
        structure: answer.structure,
        suggestion: answer.suggestion,
        showProfessional: answer.showProfessional,
        stored,
      });
    }
  });

  app.get('/api/care/advisor/history', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const result = await query(
        `SELECT query_id, question, created_at FROM health.advisor_queries
         WHERE person_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [request.user!.personId]
      );
      return { queries: result.rows };
    }
  });

  // --- Consent (Phase N: women's care domain) ---
  // Consent is self-managed and revocable.
  //
  // AUTHORITATIVE TABLE: health.health_consents, keyed by purpose_code. That is
  // what health.fn_has_valid_consent() — and therefore evaluateConsent() above,
  // and therefore every gated route in this file — actually reads. An earlier
  // version of these two handlers read and wrote health.consent_preferences
  // instead, which the gate never consults, so a grant could not open the gate
  // and the 403 pointed the employee back at the endpoint that had just failed
  // them. consent_preferences is left alone: it is not the record of consent.

  app.get('/api/care/consent', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const result = await query<{
        purpose_code: string;
        granted_at: string;
        expires_at: string;
        revoked_at: string | null;
      }>(
        `SELECT purpose_code, granted_at, expires_at, withdrawn_at AS revoked_at
           FROM health.health_consents
          WHERE person_id = $1
            AND withdrawn_at IS NULL
            AND expires_at > NOW()
          ORDER BY granted_at DESC`,
        [actorOf(request).personId]
      );
      return {
        consent: result.rows.map((r) => ({
          domain: domainOfPurpose(r.purpose_code),
          purpose: r.purpose_code,
          granted_at: r.granted_at,
          expires_at: r.expires_at,
          revoked_at: r.revoked_at,
        })),
      };
    }
  });

  app.post('/api/care/consent', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z
        .object({
          purpose: z.string().min(2).max(60).optional(),
          domain: z.string().min(2).max(60).optional(),
          grant: z.boolean(),
        })
        .strict()
        .refine((v) => typeof v.purpose === 'string' || typeof v.domain === 'string', {
          message: 'Send either purpose or domain.',
        });
      const data = schema.parse(request.body);

      // The allowlist is enforced here, not merely documented. A purpose the
      // employee may not grant themselves never reaches the INSERT.
      const purpose = resolveConsentPurpose((data.purpose ?? data.domain)!);
      if (purpose === null) {
        return reply.code(400).send({
          error: 'UNKNOWN_CONSENT_PURPOSE',
          message: `"${data.purpose ?? data.domain}" is not a purpose you can consent to.`,
          consentable: CONSENTABLE_PURPOSES.map((p) => ({ purpose: p, domain: domainOfPurpose(p) })),
        });
      }
      const domain = domainOfPurpose(purpose);
      const actor = actorOf(request);

      // DPDP s.9(3): a minor cannot give this consent themselves. Writing a
      // SELF row for a minor would be worse than refusing — the gate correctly
      // ignores it, so the employee would see consent "granted" and still be
      // denied. Refuse plainly and name the mechanism that does apply.
      if (data.grant) {
        const minor = await query<{ is_minor: boolean }>(
          'SELECT health.fn_person_is_minor($1, $2) AS is_minor',
          [actor.personId, config.ORG_TIMEZONE]
        );
        if (minor.rows[0]?.is_minor === true) {
          return reply.code(403).send({
            error: 'PARENTAL_CONSENT_REQUIRED',
            message:
              'This consent cannot be given by the employee because they are a minor. ' +
              'A verified parent or guardian must record it (DPDP Act s.9(3)).',
            purpose,
            domain,
          });
        }
      }

      const client = await getClient();
      try {
        await client.query('BEGIN');

        // Withdraw whatever is live for this purpose, then append. The ledger is
        // append-only by intent: superseded rows stay, so the history of who
        // consented to what and when survives a re-grant.
        await client.query(
          `UPDATE health.health_consents SET withdrawn_at = NOW()
            WHERE person_id = $1 AND purpose_code = $2 AND withdrawn_at IS NULL`,
          [actor.personId, purpose]
        );

        if (data.grant) {
          const inserted = await client.query(
            `INSERT INTO health.health_consents
               (person_id, purpose_code, consent_basis, granted_by_person_id, granted_at, expires_at)
             SELECT $1, pp.purpose_code, 'SELF', $1, NOW(),
                    NOW() + make_interval(days => pp.default_validity_days)
               FROM health.processing_purposes pp
              WHERE pp.purpose_code = $2
             RETURNING consent_id, expires_at`,
            [actor.personId, purpose]
          );
          if (inserted.rowCount === 0) {
            // The purpose passed the allowlist but is absent from the registry,
            // so no validity period can be derived. Do not invent one.
            await client.query('ROLLBACK');
            return reply.code(500).send({
              error: 'PURPOSE_NOT_REGISTERED',
              message: `Purpose "${purpose}" is not present in health.processing_purposes.`,
            });
          }
        }

        await client.query(
          `INSERT INTO health.consent_events (person_id, domain, action)
           VALUES ($1, $2, $3)`,
          [actor.personId, domain, data.grant ? 'GRANT' : 'REVOKE']
        );

        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The connection is already unusable; the outer throw is what matters.
        }
        throw error;
      } finally {
        client.release();
      }

      await writeAudit({
        personId: actor.personId,
        action: data.grant ? 'CONSENT_GRANT' : 'CONSENT_REVOKE',
        targetType: 'consent',
        targetId: actor.personId,
        details: { purpose, domain },
        request,
      });
      await emitEvent({
        type: data.grant ? 'ConsentGranted' : 'ConsentRevoked',
        source: 'care:consent',
        actorPersonId: actor.personId,
        payload: { purpose, domain },
      });
      return { granted: data.grant, domain, purpose };
    }
  });

  // --- Field safety check-ins (Phase Q) ---
  // Location is only ever recorded when the employee explicitly sends a
  // check-in. The record is owner-only.

  app.post('/api/safety/check-in', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const schema = z.object({
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        location: z.string().max(300).optional(),
        note: z.string().max(500).optional(),
      });
      const data = schema.parse(request.body);
      if ((data.latitude == null) !== (data.longitude == null)) {
        return reply.code(400).send({ error: 'latitude and longitude must be provided together' });
      }
      const result = await query(
        `INSERT INTO health.safety_checkins (person_id, latitude, longitude, location, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING checkin_id, occurred_at, latitude, longitude, location, note`,
        [request.user!.personId, data.latitude ?? null, data.longitude ?? null, data.location ?? null, data.note ?? null]
      );
      await writeAudit({
        personId: request.user!.personId,
        action: 'SAFETY_CHECKIN',
        targetType: 'safety_checkin',
        targetId: result.rows[0].checkin_id,
        details: { has_location: data.latitude != null },
        request,
      });
      await emitEvent({
        type: 'SafetyCheckinRecorded',
        source: 'safety:checkin',
        actorPersonId: request.user!.personId,
        payload: { checkin_id: result.rows[0].checkin_id, has_location: data.latitude != null },
      });
      return reply.code(201).send(result.rows[0]);
    }
  });

  app.get('/api/safety/my-checkins', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const result = await query(
        `SELECT checkin_id, occurred_at, latitude, longitude, location, note
         FROM health.safety_checkins WHERE person_id = $1
         ORDER BY occurred_at DESC LIMIT 25`,
        [request.user!.personId]
      );
      return { checkins: result.rows };
    }
  });
}
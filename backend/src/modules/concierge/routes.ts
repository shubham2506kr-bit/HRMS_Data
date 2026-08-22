import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { z } from 'zod';

type Intent =
  | 'leave' | 'pay' | 'attendance' | 'people' | 'projects' | 'organization'
  | 'care' | 'growth' | 'messages' | 'audit' | 'help';

interface IntentDef {
  intent: Intent;
  page: string;
  keywords: string[];
  reply: (q: string) => string;
}

const INTENTS: IntentDef[] = [
  {
    intent: 'leave', page: 'leave',
    keywords: ['leave', 'vacation', 'holiday', 'day off', 'time off', 'absent', 'absence'],
    reply: () => 'Leave lives here: request time away, see your balance, and review team requests.',
  },
  {
    intent: 'pay', page: 'pay',
    keywords: ['pay', 'salary', 'payslip', 'wallet', 'money', 'transfer', 'wage', 'net', 'gross'],
    reply: () => 'Your pay page shows the wallet, payslips, and why the amount changed between runs.',
  },
  {
    intent: 'attendance', page: 'attendance',
    keywords: ['clock', 'attendance', 'time', 'punch', 'late', 'overtime', 'check in', 'check out', 'worklog'],
    reply: () => 'Attendance is where you clock in and out and review your worklog.',
  },
  {
    intent: 'people', page: 'people',
    keywords: ['person', 'people', 'colleague', 'who is', 'find', 'employee', 'directory', 'teammate'],
    reply: () => 'The people directory helps you find colleagues — names, roles and where they sit.',
  },
  {
    intent: 'projects', page: 'projects',
    keywords: ['project', 'initiative', 'milestone', 'team of', 'working on'],
    reply: () => 'Projects shows initiatives, their teams and what is happening.',
  },
  {
    intent: 'organization', page: 'organization',
    keywords: ['org', 'organization', 'structure', 'department', 'hierarchy', 'team', 'reporting'],
    reply: () => 'The organization universe maps departments, roles and people as a navigable space.',
  },
  {
    intent: 'care', page: 'care',
    keywords: ['health', 'care', 'wellbeing', 'sleep', 'stress', 'doctor', 'advisor'],
    reply: () => 'Care is private: the WHO-backed health advisor lives there.',
  },
  {
    intent: 'growth', page: 'growth',
    keywords: ['goal', 'growth', 'skill', 'certification', 'learn', 'career', 'training'],
    reply: () => 'Growth holds your goals, certifications and skills map.',
  },
  {
    intent: 'messages', page: 'messages',
    keywords: ['message', 'chat', 'inbox', 'mail', 'announcement', 'communication'],
    reply: () => 'Messages is your work inbox.',
  },
  {
    intent: 'audit', page: 'audit',
    keywords: ['audit', 'log', 'history', 'trail', 'tracked', 'recorded'],
    reply: () => 'Audit shows the actions recorded against your records — who did what, when.',
  },
];

/**
 * The router is navigational only: every intent resolves to a page name and a
 * canned sentence. No intent dispatches a data lookup, so free text cannot
 * steer the concierge into reading leave, pay, attendance or health records.
 * The single exception is the directory name lookup below, which is bounded by
 * NAME_LOOKUP_MIN_TOKEN and returns only what /api/persons already returns.
 */
export function matchIntent(message: string): IntentDef | null {
  const q = message.toLowerCase();
  let best: IntentDef | null = null;
  let bestHits = 0;
  for (const def of INTENTS) {
    const hits = def.keywords.reduce((acc, kw) => acc + (q.includes(kw) ? 1 : 0), 0);
    if (hits > bestHits) {
      best = def;
      bestHits = hits;
    }
  }
  return bestHits > 0 ? best : null;
}

const STOPWORDS = new Set(['find', 'search', 'who', 'is', 'are', 'look', 'lookup', 'tell', 'me', 'about', 'the', 'a', 'an', 'for', 'and', 'or', 'of', 'i', 'need', 'to']);

/**
 * A one- or two-letter fragment matched with LIKE '%x%' plus "shortest name
 * first" ordering turned this endpoint into a directory-enumeration oracle: a
 * caller could walk the organization a letter at a time. Require a real
 * fragment before any lookup runs.
 */
export const NAME_LOOKUP_MIN_TOKEN = 3;

/** Extracted for testing: the fragment the directory lookup would search for,
 *  or null when the message contains nothing worth looking up. */
export function nameLookupTerm(message: string): string | null {
  const tokens = message
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= NAME_LOOKUP_MIN_TOKEN && !STOPWORDS.has(w))
    .slice(0, 2);
  if (tokens.length === 0) return null;
  const term = tokens.join('%');
  return term.length >= NAME_LOOKUP_MIN_TOKEN ? term : null;
}

const conciergeSchema = z.object({
  message: z.string().trim().min(2).max(500),
});

function validationFailed(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Request validation failed',
    fields: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
  });
}

export async function conciergeRoutes(app: FastifyInstance) {
  app.post('/api/concierge', {
    preHandler: [authenticate()],
    // Tighter than the global budget: this is the only free-text surface that
    // touches the person table.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const parsed = conciergeSchema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;

      const matched = matchIntent(data.message);

      // A person lookup is a special case: search the directory for names.
      // Deliberately mirrors /api/persons: preferred_name only (legal_name is
      // PII that the directory masks for unprivileged callers), and only people
      // with a live employment record.
      let personMatch: { name: string } | null = null;
      if (!matched || matched.intent === 'people') {
        const term = nameLookupTerm(data.message);
        if (term) {
          const result = await query(
            `SELECT p.preferred_name AS name
             FROM health.persons p
             JOIN health.employments e ON e.person_id = p.logical_id
              AND e.status = 'ACTIVE' AND e.system_period @> NOW()
             WHERE p.preferred_name IS NOT NULL
               AND LOWER(p.preferred_name) LIKE $1
             ORDER BY LENGTH(p.preferred_name), p.preferred_name
             LIMIT 1`,
            ['%' + term + '%']
          );
          if (result.rows.length > 0) personMatch = { name: result.rows[0].name };
        }
      }

      const intent: Intent = matched?.intent ?? 'help';
      const replyText = personMatch
        ? `${personMatch.name} is in the directory — open People to see their profile.`
        : matched
          ? matched.reply(data.message)
          : 'I did not understand that. I can point you to leave, pay, attendance, people, projects, organization, care, growth, messages or audit.';

      // Audit records the routing decision and whether a directory match was
      // returned — never the message text the person typed.
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'CONCIERGE_QUERY',
        targetType: 'concierge',
        targetId: request.user!.personId,
        details: { intent, directory_match: personMatch !== null },
        request,
      });
      if (!audited) {
        return reply.code(503).send({
          error: 'Audit Unavailable',
          message: 'The action could not be recorded in the audit trail; please retry.',
        });
      }

      return reply.send({
        intent,
        reply: replyText,
        action: personMatch
          ? { page: 'people', query: personMatch.name }
          : { page: matched?.page ?? 'dashboard', query: null },
      });
    }
  });
}

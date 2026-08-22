import { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { authenticate } from '../../authz/middleware.js';
import { writeAudit } from '../../lib/audit.js';
import { z } from 'zod';

const FREQUENCIES = ['off', 'occasional', 'daily', 'milestone'] as const;

// Hard caps: nothing here is an unbounded read, and a dismissal cannot be
// pushed years into the future (which would silently disable the feature).
const MAX_MOMENTS = 50;
const MAX_FAVORITES = 100;
const MAX_DISMISS_DAYS = 90;

function validationFailed(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Validation Error',
    message: 'Request validation failed',
    fields: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
  });
}

function auditUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: 'Audit Unavailable',
    message: 'The action could not be recorded in the audit trail; please retry.',
  });
}

/** quote_id is a SERIAL, so it must be a positive integer — not just "a number". */
const quoteIdParamSchema = z.object({
  quoteId: z.coerce.number().int().positive().max(2_147_483_647),
});

/** A dismissal must be in the future and inside the cap. */
const futureInstant = z
  .string()
  .datetime()
  .refine((v) => {
    const t = new Date(v).getTime();
    const now = Date.now();
    return t > now && t <= now + MAX_DISMISS_DAYS * 86_400_000;
  }, { message: `must be a future instant within ${MAX_DISMISS_DAYS} days` });

const settingsSchema = z.object({
  frequency: z.enum(FREQUENCIES),
  dismissUntil: futureInstant.optional(),
});

const dismissSchema = z.object({ until: futureInstant });

interface MomentRow {
  kind: string;
  title: string;
  occurred_at: string;
}

async function buildMoments(personId: string): Promise<MomentRow[]> {
  const rows = await query(
    `SELECT 'joined' AS kind, 'Joined the organization' AS title, e.started_at AS occurred_at
       FROM health.employments e WHERE e.person_id = $1
     UNION ALL
     SELECT 'anniversary', 'Work anniversary', e.started_at + (DATE_PART('year', NOW()) - DATE_PART('year', e.started_at)) * INTERVAL '1 year'
       FROM health.employments e WHERE e.person_id = $1 AND (e.started_at + (DATE_PART('year', NOW()) - DATE_PART('year', e.started_at)) * INTERVAL '1 year')::date = CURRENT_DATE
     UNION ALL
     SELECT 'certification', 'Certification: ' || name, issued_on
       FROM health.certifications WHERE person_id = $1
     UNION ALL
     SELECT 'goal', 'Goal completed: ' || title, updated_at
       FROM health.goals WHERE person_id = $1 AND status = 'DONE'
     ORDER BY occurred_at DESC
     LIMIT $2`,
    [personId, MAX_MOMENTS]
  );
  return rows.rows as MomentRow[];
}

async function pickQuote(personId: string, role: string | null) {
  const settings = await query(
    `SELECT frequency, dismissed_until FROM health.motivation_settings WHERE person_id = $1`,
    [personId]
  );
  const s = settings.rows[0] ?? { frequency: 'daily', dismissed_until: null };

  // Role tokens are derived from the position title and passed as a bound
  // text[] parameter — never interpolated into the statement.
  const roleTokens = (role ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean).slice(0, 4);

  const eligible = await query(
    `SELECT q.quote_id, q.text, q.source, q.original, q.category,
            COUNT(v.view_id) AS times_seen
       FROM health.motivation_quotes q
       LEFT JOIN health.motivation_views v ON v.quote_id = q.quote_id AND v.person_id = $1
      WHERE q.active
        AND (
          CARDINALITY($2::text[]) = 0
          OR q.audience_tags = '{}'
          OR q.audience_tags && $2::text[]
        )
      GROUP BY q.quote_id
      ORDER BY times_seen ASC, RANDOM()
      LIMIT 1`,
    [personId, roleTokens]
  );
  return { settings: s, quote: eligible.rows[0] ?? null };
}

/** dismissed_until arrives from pg as a Date; comparing it to an ISO string
 *  always yielded false, so a dismissal never actually suppressed anything. */
function isDismissed(dismissedUntil: unknown): boolean {
  if (dismissedUntil == null) return false;
  const t = new Date(dismissedUntil as string | number | Date).getTime();
  return Number.isFinite(t) && t > Date.now();
}

export async function motivationRoutes(app: FastifyInstance) {
  app.get('/api/motivation/settings', {
    preHandler: [authenticate()],
    handler: async (request) => {
      const r = await query(
        `SELECT frequency, dismissed_until FROM health.motivation_settings WHERE person_id = $1`,
        [request.user!.personId]
      );
      return { settings: r.rows[0] ?? { frequency: 'daily', dismissed_until: null } };
    }
  });

  app.post('/api/motivation/settings', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;
      await query(
        `INSERT INTO health.motivation_settings (person_id, frequency, dismissed_until)
         VALUES ($1, $2, $3)
         ON CONFLICT (person_id) DO UPDATE
           SET frequency = EXCLUDED.frequency,
               dismissed_until = EXCLUDED.dismissed_until`,
        [request.user!.personId, data.frequency, data.dismissUntil ?? null]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'MOTIVATION_SETTINGS',
        targetType: 'motivation',
        targetId: request.user!.personId,
        details: { frequency: data.frequency },
        request,
      });
      if (!audited) return auditUnavailable(reply);
      return { frequency: data.frequency, dismissed_until: data.dismissUntil ?? null };
    }
  });

  app.post('/api/motivation/dismiss', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = dismissSchema.safeParse(request.body);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const data = parsed.data;
      // COALESCE: for a person with no settings row the sub-select returned
      // NULL and violated the NOT NULL constraint on frequency (a 500).
      await query(
        `INSERT INTO health.motivation_settings (person_id, frequency, dismissed_until)
         VALUES ($1, COALESCE((SELECT frequency FROM health.motivation_settings WHERE person_id = $1), 'daily'), $2)
         ON CONFLICT (person_id) DO UPDATE SET dismissed_until = EXCLUDED.dismissed_until`,
        [request.user!.personId, data.until]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'MOTIVATION_DISMISS',
        targetType: 'motivation',
        targetId: request.user!.personId,
        details: { dismissed_until: data.until },
        request,
      });
      if (!audited) return auditUnavailable(reply);
      return { dismissed_until: data.until };
    }
  });

  app.get('/api/motivation/quote', {
    preHandler: [authenticate()],
    handler: async (request, _reply) => {
      const person = await query(
        `SELECT p.preferred_name, pos.name AS role
           FROM health.persons p
           LEFT JOIN health.employments e ON e.person_id = p.logical_id AND e.status = 'ACTIVE'
           LEFT JOIN health.positions pos ON pos.logical_id = e.position_id
          WHERE p.logical_id = $1`,
        [request.user!.personId]
      );
      const p = person.rows[0] ?? null;
      const { settings, quote } = await pickQuote(request.user!.personId, p?.role ?? null);
      if (settings.frequency === 'off' || isDismissed(settings.dismissed_until)) {
        return { quote: null, frequency: settings.frequency, moments: [] };
      }

      let moments: MomentRow[] = [];
      if (settings.frequency === 'milestone') {
        moments = await buildMoments(request.user!.personId);
        if (moments.length === 0) {
          return { quote: null, frequency: settings.frequency, moments: [] };
        }
      }

      if (settings.frequency === 'occasional') {
        const seenToday = await query(
          `SELECT 1 FROM health.motivation_views v
            JOIN health.motivation_quotes q ON q.quote_id = v.quote_id AND q.category IN ('wellness', 'leaders', 'builders')
           WHERE v.person_id = $1 AND v.seen_at::date = CURRENT_DATE LIMIT 1`,
          [request.user!.personId]
        );
        if (seenToday.rows.length > 0) {
          return { quote: null, frequency: settings.frequency, moments: [] };
        }
      }

      if (!quote) {
        return { quote: null, frequency: settings.frequency, moments };
      }

      // View tracking on the caller's own row. Deliberately NOT audited: an
      // audit row per wellness-quote view would build a log of when a named
      // person reads wellbeing content, which is exactly the inference this
      // module is supposed to avoid.
      await query(
        `INSERT INTO health.motivation_views (person_id, quote_id) VALUES ($1, $2)`,
        [request.user!.personId, quote.quote_id]
      );

      return {
        quote: {
          quote_id: quote.quote_id,
          text: quote.text,
          source: quote.source,
          original: quote.original,
          category: quote.category,
        },
        frequency: settings.frequency,
        moments,
      };
    }
  });

  app.get('/api/motivation/moments', {
    preHandler: [authenticate()],
    handler: async (request) => {
      const moments = await buildMoments(request.user!.personId);
      return { moments };
    }
  });

  app.get('/api/motivation/favorites', {
    preHandler: [authenticate()],
    handler: async (request) => {
      const r = await query(
        `SELECT q.quote_id, q.text, q.source, q.original, q.category
           FROM health.motivation_favorites f
           JOIN health.motivation_quotes q ON q.quote_id = f.quote_id
          WHERE f.person_id = $1
          ORDER BY f.created_at DESC
          LIMIT $2`,
        [request.user!.personId, MAX_FAVORITES]
      );
      return { favorites: r.rows };
    }
  });

  app.post('/api/motivation/favorites/:quoteId', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = quoteIdParamSchema.safeParse(request.params);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { quoteId } = parsed.data;
      const exists = await query(
        `SELECT 1 FROM health.motivation_quotes WHERE quote_id = $1 AND active`,
        [quoteId]
      );
      if (exists.rows.length === 0) return reply.code(404).send({ message: 'Quote not found' });
      await query(
        `INSERT INTO health.motivation_favorites (person_id, quote_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [request.user!.personId, quoteId]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'MOTIVATION_FAVORITE_ADD',
        targetType: 'quote',
        targetId: String(quoteId),
        request,
      });
      if (!audited) return auditUnavailable(reply);
      return { saved: true, quote_id: quoteId };
    }
  });

  app.delete('/api/motivation/favorites/:quoteId', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = quoteIdParamSchema.safeParse(request.params);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { quoteId } = parsed.data;
      // Ownership predicate is part of the DELETE, not a prior check.
      await query(
        `DELETE FROM health.motivation_favorites WHERE person_id = $1 AND quote_id = $2`,
        [request.user!.personId, quoteId]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'MOTIVATION_FAVORITE_REMOVE',
        targetType: 'quote',
        targetId: String(quoteId),
        request,
      });
      if (!audited) return auditUnavailable(reply);
      return { saved: false, quote_id: quoteId };
    }
  });

  app.post('/api/motivation/quotes/:quoteId/share', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = quoteIdParamSchema.safeParse(request.params);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { quoteId } = parsed.data;
      const quote = await query(
        `SELECT quote_id, text, source, original FROM health.motivation_quotes WHERE quote_id = $1 AND active`,
        [quoteId]
      );
      if (quote.rows.length === 0) return reply.code(404).send({ message: 'Quote not found' });
      const q = quote.rows[0];

      const manager = await query(
        `SELECT p.head_of_department_id AS person_id
           FROM health.employments e
           JOIN health.positions p ON p.logical_id = e.position_id
          WHERE e.person_id = $1 AND e.status = 'ACTIVE'
            AND p.head_of_department_id IS NOT NULL AND p.head_of_department_id <> $1
          UNION
         SELECT head.head_of_department_id AS person_id
           FROM health.employments e
           JOIN health.positions p ON p.logical_id = e.position_id
           JOIN health.positions head ON head.department_id = p.department_id
              AND head.head_of_department_id IS NOT NULL AND head.head_of_department_id <> $1
          WHERE e.person_id = $1 AND e.status = 'ACTIVE'
          LIMIT 1`,
        [request.user!.personId]
      );
      const managerId = manager.rows[0]?.person_id ?? null;

      const quoteLine = `${q.text} — ${q.source === 'EduRankAI' ? 'EduRankAI' : q.source}`;
      if (managerId) {
        await query(
          `INSERT INTO health.employee_messages (sender_id, recipient_id, subject, content)
           VALUES ($1, $2, $3, $4)`,
          [request.user!.personId, managerId, 'A moment I wanted to share', quoteLine]
        );
        const audited = await writeAudit({
          personId: request.user!.personId,
          action: 'MOTIVATION_SHARE',
          targetType: 'quote',
          targetId: String(q.quote_id),
          details: { shared_with: managerId },
          request,
        });
        if (!audited) return auditUnavailable(reply);
        return { shared: true, recipient_id: managerId };
      }
      return { shared: false, message: 'No manager relationship found to share with.' };
    }
  });

  app.post('/api/motivation/quotes/:quoteId/skip', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = quoteIdParamSchema.safeParse(request.params);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { quoteId } = parsed.data;
      await query(
        `INSERT INTO health.motivation_skips (person_id, quote_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [request.user!.personId, quoteId]
      );
      const until = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
      await query(
        `INSERT INTO health.motivation_settings (person_id, frequency, dismissed_until)
         VALUES ($1, COALESCE((SELECT frequency FROM health.motivation_settings WHERE person_id = $1), 'daily'), $2)
         ON CONFLICT (person_id) DO UPDATE SET dismissed_until = EXCLUDED.dismissed_until`,
        [request.user!.personId, until]
      );
      const audited = await writeAudit({
        personId: request.user!.personId,
        action: 'MOTIVATION_SKIP',
        targetType: 'quote',
        targetId: String(quoteId),
        request,
      });
      if (!audited) return auditUnavailable(reply);
      return { skipped: true };
    }
  });

  app.post('/api/motivation/quotes/:quoteId/why', {
    preHandler: [authenticate()],
    handler: async (request, reply) => {
      const parsed = quoteIdParamSchema.safeParse(request.params);
      if (!parsed.success) return validationFailed(reply, parsed.error);
      const { quoteId } = parsed.data;
      const r = await query(
        `SELECT q.category, q.audience_tags, q.original, COUNT(v.view_id)::int AS times_seen
           FROM health.motivation_quotes q
           LEFT JOIN health.motivation_views v ON v.quote_id = q.quote_id AND v.person_id = $1
          WHERE q.quote_id = $2
          GROUP BY q.quote_id`,
        [request.user!.personId, quoteId]
      );
      if (r.rows.length === 0) return reply.code(404).send({ message: 'Quote not found' });
      const row = r.rows[0];
      // Honest basis: the match is on words in the caller's position title, not
      // on any judgement about the person.
      return {
        category: row.category,
        audience_tags: row.audience_tags,
        times_seen: row.times_seen,
        explanation: `This thought was chosen from the ${row.category} category. ${
          (row.audience_tags ?? []).length > 0
            ? `Its audience tags (${row.audience_tags.join(', ')}) were matched against words in your position title, `
            : ''
        }and quotes you have not seen recently are preferred, so it rotates rather than repeating. Nothing here is based on your health, performance or leave records.`,
      };
    }
  });
}

-- Migration 024: Motivation engine — quotes, per-person settings, views.
-- Quotes: original EduRankAI content is preferred; fallback entries are
-- public-domain (classical authors, proverbs) and attributed.

CREATE TABLE IF NOT EXISTS health.motivation_quotes (
  quote_id       SERIAL PRIMARY KEY,
  text           TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'EduRankAI',          -- EduRankAI | author name
  original       BOOLEAN NOT NULL DEFAULT TRUE,              -- TRUE = original EduRankAI content
  category       TEXT NOT NULL,                              -- builders | carers | thinkers | leaders | wellness
  audience_tags  TEXT[] NOT NULL DEFAULT '{}',               -- e.g. {'engineer','designer'}
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health.motivation_settings (
  person_id        UUID PRIMARY KEY REFERENCES health.persons(logical_id) ON DELETE CASCADE,
  frequency        TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('off', 'occasional', 'daily', 'milestone')),
  dismissed_until  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS health.motivation_views (
  view_id    SERIAL PRIMARY KEY,
  person_id  UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
  quote_id   INT NOT NULL REFERENCES health.motivation_quotes(quote_id) ON DELETE CASCADE,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_motivation_views_person ON health.motivation_views(person_id, seen_at DESC);

INSERT INTO health.motivation_quotes (text, source, original, category, audience_tags) VALUES
  ('A small, well-chosen task finished today outpaces a perfect plan finished never.', 'EduRankAI', TRUE, 'builders', '{engineer,developer,designer,product}'),
  ('Your edge is not the hours you put in — it is the clarity you keep in them.', 'EduRankAI', TRUE, 'builders', '{engineer,developer,operations}'),
  ('Ship the honest version. Feedback beats speculation every time.', 'EduRankAI', TRUE, 'builders', '{engineer,designer,product,marketing}'),
  ('Care is not a pause from the work; it is what keeps the work worth doing.', 'EduRankAI', TRUE, 'carers', '{people,hr,support,health}'),
  ('People you genuinely help become people who genuinely help.', 'EduRankAI', TRUE, 'carers', '{people,hr,support}'),
  ('Clarity is kindness. A clear yes, a clear no, a clear date.', 'EduRankAI', TRUE, 'thinkers', '{strategy,finance,legal,data,analyst}'),
  ('The best questions are the ones that shrink the fog around a decision.', 'EduRankAI', TRUE, 'thinkers', '{data,analyst,strategy,finance}'),
  ('A leader moves the team forward and leaves the ladder behind them for others.', 'EduRankAI', TRUE, 'leaders', '{leader,manager,head,executive}'),
  ('Trust is built in the small, repeated, visible moments.', 'EduRankAI', TRUE, 'leaders', '{leader,manager,head}'),
  ('Rest is part of the plan, not a sign the plan failed.', 'EduRankAI', TRUE, 'wellness', '{}'),
  ('You have power over your mind — not outside events. Realize this, and you will find strength.', 'Marcus Aurelius', FALSE, 'thinkers', '{}'),
  ('It is not that we have a short time to live, but that we waste much of it.', 'Seneca', FALSE, 'thinkers', '{}'),
  ('Fall seven times, stand up eight.', 'Japanese proverb', FALSE, 'builders', '{}');

-- END OF MIGRATION 024
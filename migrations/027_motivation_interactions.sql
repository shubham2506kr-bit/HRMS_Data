-- Migration 027: Motivation quote interactions — favorites and shares.
-- Quote interactions the employee controls: save, share internally (sends a
-- message to the employee's manager), and per-quote feedback (not-for-me).

CREATE TABLE IF NOT EXISTS health.motivation_favorites (
  person_id    UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
  quote_id     INT NOT NULL REFERENCES health.motivation_quotes(quote_id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person_id, quote_id)
);

CREATE TABLE IF NOT EXISTS health.motivation_skips (
  person_id    UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
  quote_id     INT NOT NULL REFERENCES health.motivation_quotes(quote_id) ON DELETE CASCADE,
  reason       TEXT NOT NULL DEFAULT 'not-for-me',
  skipped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person_id, quote_id)
);

-- END OF MIGRATION 027

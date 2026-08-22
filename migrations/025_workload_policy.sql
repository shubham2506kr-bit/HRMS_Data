-- Migration 025: Workload Intelligence policy states + discreet manager/TL
-- escalation trail. The individual is never called out publicly; the escalation
-- row is what the team lead/manager sees (privately), and it is audited.

CREATE TABLE IF NOT EXISTS health.workload_escalations (
  escalation_id     SERIAL PRIMARY KEY,
  person_id         UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
  state             TEXT NOT NULL CHECK (state IN ('ELEVATED', 'HIGH', 'CRITICAL')),
  first_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_workload_escalations_open ON health.workload_escalations(person_id) WHERE cleared_at IS NULL;

-- END OF MIGRATION 025
-- Migration 026: Project milestones + dependencies — structured project
-- workspace data.

CREATE TABLE IF NOT EXISTS health.project_milestones (
  milestone_id SERIAL PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES health.projects(logical_id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  due_date     DATE,
  status       TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'DONE')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON health.project_milestones(project_id);

CREATE TABLE IF NOT EXISTS health.project_dependencies (
  project_id           UUID NOT NULL REFERENCES health.projects(logical_id) ON DELETE CASCADE,
  depends_on_project_id UUID NOT NULL REFERENCES health.projects(logical_id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, depends_on_project_id),
  CHECK (project_id <> depends_on_project_id)
);

-- Seed milestones for the demo projects so the workspace is non-empty and honest.
INSERT INTO health.project_milestones (project_id, title, due_date, status)
SELECT pr.logical_id, m.title, m.due_date::date, m.status
FROM (VALUES
  ('Admissions AI Pilot', 'Scope review', '2026-09-15', 'DONE'),
  ('Admissions AI Pilot', 'Model validation', '2026-10-31', 'IN_PROGRESS'),
  ('Admissions AI Pilot', 'Pilot go-live', '2026-12-15', 'PLANNED'),
  ('Campus App Revamp', 'Design handoff', '2026-09-01', 'DONE'),
  ('Campus App Revamp', 'Beta build', '2026-11-20', 'PLANNED')
) AS m(project, title, due_date, status)
JOIN health.projects pr ON pr.name = m.project
WHERE NOT EXISTS (
  SELECT 1 FROM health.project_milestones x WHERE x.project_id = pr.logical_id
);

-- END OF MIGRATION 026
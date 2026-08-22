-- ============================================================
-- 015: PROJECTS WORKSPACE
-- A light project capability for the HumanOS workspace.
-- Statuses and membership model real staffing relationships.
-- ============================================================

CREATE TABLE IF NOT EXISTS health.projects (
    logical_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'ONGOING'
                      CHECK (status IN ('PLANNED', 'ONGOING', 'FINISHED')),
    start_date        DATE,
    end_date          DATE,
    department_id     UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health.project_members (
    project_id    UUID NOT NULL REFERENCES health.projects (logical_id) ON DELETE CASCADE,
    person_id     UUID NOT NULL REFERENCES health.persons (logical_id) ON DELETE CASCADE,
    role          TEXT,
    PRIMARY KEY (project_id, person_id)
);

INSERT INTO health.projects (name, description, status, start_date, end_date, department_id)
SELECT v.name, v.description, v.status, v.start_date::date, v.end_date::date, d.logical_id
FROM (VALUES
    ('Campus App Revamp', 'Rebuild the student-facing mobile application on the new design system.', 'ONGOING', '2026-04-01', '2026-11-30', 'Engineering'),
    ('Admissions AI Pilot', 'Pilot an AI-assisted admissions document triage workflow.', 'ONGOING', '2026-06-15', '2026-12-31', 'Engineering'),
    ('Q3 Marketing Campaign', 'Multi-channel campaign for the autumn intake season.', 'PLANNED', '2026-09-01', '2026-10-31', 'Marketing'),
    ('Finance Systems Migration', 'Move ledger and reimbursement flows to the new platform.', 'ONGOING', '2026-05-01', '2027-02-28', 'Finance'),
    ('Placement Drive 2026', 'Coordinate campus placements with industry partners.', 'PLANNED', '2026-08-01', '2027-03-31', 'Sales')
) AS v(name, description, status, start_date, end_date, dept_name)
JOIN health.departments d ON d.name = v.dept_name
ON CONFLICT DO NOTHING;

INSERT INTO health.project_members (project_id, person_id, role)
SELECT pr.logical_id, p.logical_id, m.role
FROM (VALUES
    ('Campus App Revamp', 'John', 'Lead'),
    ('Campus App Revamp', 'Emily', 'Developer'),
    ('Campus App Revamp', 'Michael', 'QA'),
    ('Admissions AI Pilot', 'John', 'Technical lead'),
    ('Admissions AI Pilot', 'Sarah', 'Data'),
    ('Q3 Marketing Campaign', 'Jane', 'Lead'),
    ('Q3 Marketing Campaign', 'Lisa', 'Design'),
    ('Finance Systems Migration', 'Michael', 'Lead'),
    ('Finance Systems Migration', 'David', 'Analyst'),
    ('Placement Drive 2026', 'Robert', 'Lead'),
    ('Placement Drive 2026', 'Sarah', 'Coordinator')
) AS m(project_name, person_preferred, role)
JOIN health.projects pr ON pr.name = m.project_name
JOIN health.persons p ON p.preferred_name = m.person_preferred
ON CONFLICT DO NOTHING;

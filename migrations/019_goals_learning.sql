-- Migration 019: Goals + Learning (Phase K)
-- Goals are owned by the person who created them. Certifications expire and
-- feed the proactive reminder job. Skills feed the career/spatial views.

CREATE TABLE health.goals (
    goal_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
    description TEXT,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
    created_by UUID NOT NULL REFERENCES health.persons(logical_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_period TSTZRANGE NOT NULL DEFAULT TSTZRANGE(NOW(), NULL)
);

CREATE INDEX idx_goals_person ON health.goals (person_id);

CREATE TABLE health.certifications (
    cert_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    issued_on DATE NOT NULL,
    expires_on DATE,
    credential_id TEXT,
    added_by UUID NOT NULL REFERENCES health.persons(logical_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_period TSTZRANGE NOT NULL DEFAULT TSTZRANGE(NOW(), NULL)
);

CREATE INDEX idx_certs_person ON health.certifications (person_id);

CREATE TABLE health.skills (
    skill_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    cluster TEXT NOT NULL DEFAULT 'general' CHECK (cluster IN ('engineering', 'design', 'operations', 'leadership', 'general')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE health.skill_relations (
    from_skill_id UUID NOT NULL REFERENCES health.skills(skill_id) ON DELETE CASCADE,
    to_skill_id UUID NOT NULL REFERENCES health.skills(skill_id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'related',
    PRIMARY KEY (from_skill_id, to_skill_id),
    CHECK (from_skill_id <> to_skill_id)
);

CREATE TABLE health.person_skills (
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    skill_id UUID NOT NULL REFERENCES health.skills(skill_id) ON DELETE CASCADE,
    level INT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (person_id, skill_id)
);

-- Seed skills (real-world clusters)
INSERT INTO health.skills (name, cluster) VALUES
    ('TypeScript', 'engineering'),
    ('PostgreSQL', 'engineering'),
    ('Node.js', 'engineering'),
    ('React', 'engineering'),
    ('System Design', 'engineering'),
    ('Product Design', 'design'),
    ('UI Prototyping', 'design'),
    ('Research', 'design'),
    ('People Leadership', 'leadership'),
    ('Data Analysis', 'operations'),
    ('Operations', 'operations'),
    ('Communication', 'general'),
    ('Project Management', 'general'),
    ('User Research', 'general')
ON CONFLICT (name) DO NOTHING;

INSERT INTO health.skill_relations (from_skill_id, to_skill_id)
SELECT a.skill_id, b.skill_id FROM health.skills a, health.skills b
WHERE a.name = 'TypeScript' AND b.name IN ('React', 'Node.js')
UNION ALL
SELECT a.skill_id, b.skill_id FROM health.skills a, health.skills b
WHERE a.name = 'React' AND b.name IN ('UI Prototyping', 'Product Design')
UNION ALL
SELECT a.skill_id, b.skill_id FROM health.skills a, health.skills b
WHERE a.name = 'PostgreSQL' AND b.name IN ('Data Analysis', 'Node.js')
UNION ALL
SELECT a.skill_id, b.skill_id FROM health.skills a, health.skills b
WHERE a.name = 'Product Design' AND b.name IN ('Research', 'UI Prototyping')
UNION ALL
SELECT a.skill_id, b.skill_id FROM health.skills a, health.skills b
WHERE a.name = 'People Leadership' AND b.name IN ('Communication', 'Project Management')
UNION ALL
SELECT a.skill_id, b.skill_id FROM health.skills a, health.skills b
WHERE a.name = 'Data Analysis' AND b.name IN ('Operations', 'System Design')
ON CONFLICT DO NOTHING;

-- Seed per-person skills for demo accounts
INSERT INTO health.person_skills (person_id, skill_id, level)
SELECT ua.person_id, s.skill_id, CASE ua.username WHEN 'john' THEN 5 WHEN 'jane' THEN 4 WHEN 'robert' THEN 3 WHEN 'emily' THEN 4 WHEN 'michael' THEN 3 WHEN 'sarah' THEN 3 WHEN 'david' THEN 2 WHEN 'lisa' THEN 3 ELSE 1 END
FROM health.user_accounts ua
JOIN health.skills s ON (ua.username = 'john' AND s.name IN ('TypeScript', 'Node.js', 'PostgreSQL', 'React', 'System Design'))
   OR (ua.username = 'jane' AND s.name IN ('TypeScript', 'React', 'PostgreSQL', 'System Design'))
   OR (ua.username = 'robert' AND s.name IN ('TypeScript', 'React'))
   OR (ua.username = 'emily' AND s.name IN ('Product Design', 'UI Prototyping', 'Research', 'User Research'))
   OR (ua.username = 'michael' AND s.name IN ('Data Analysis', 'Operations'))
   OR (ua.username = 'sarah' AND s.name IN ('People Leadership', 'Communication', 'Project Management'))
   OR (ua.username = 'david' AND s.name IN ('Operations', 'Data Analysis'))
   OR (ua.username = 'lisa' AND s.name IN ('Communication', 'Project Management', 'People Leadership'))
ON CONFLICT (person_id, skill_id) DO UPDATE SET level = EXCLUDED.level;

-- Certifications: lisa's First Aid expires soon (drives the proactive job);
-- jane's AWS cert is current; john has a valid one.
INSERT INTO health.certifications (person_id, name, issuer, issued_on, expires_on, credential_id, added_by)
SELECT ua.person_id, c.name, c.issuer, c.issued_on, c.expires_on, c.credential_id, ua.person_id
FROM (VALUES
    ('00000000-0000-0000-0000-000000000002'::uuid, 'AWS Solutions Architect', 'Amazon Web Services', DATE '2025-03-15', DATE '2028-03-15', 'AWS-SA-8821'),
    ('00000000-0000-0000-0000-000000000008'::uuid, 'First Aid at Work', 'Red Cross', DATE '2024-09-01', DATE '2026-09-12', 'FAW-2024-441'),
    ('00000000-0000-0000-0000-000000000001'::uuid, 'TypeScript Professional', 'TypeScript Org', DATE '2025-06-01', DATE '2027-06-01', 'TSP-101')
) AS c(person_id, name, issuer, issued_on, expires_on, credential_id)
JOIN health.user_accounts ua ON ua.person_id = c.person_id;

GRANT SELECT, INSERT, UPDATE ON health.goals, health.certifications, health.skills,
      health.skill_relations, health.person_skills TO app_service;

-- END OF MIGRATION 019
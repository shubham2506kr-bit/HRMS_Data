-- Migration 029: Team-scale demo data for workload intelligence
-- Description: Adds 12 more active employees (3 per department) so each team
-- reaches the MIN_GROUP=5 threshold and the explainable team health index can
-- be exercised for real. Every attendance/leave row below is realistic demo
-- data with deliberately varied patterns (regular / occasional late night /
-- short rest) — all derivable numbers stay real.
-- No schema DDL in this migration.

-- ============================================================
-- 0. IDEMPOTENT CLEANUP — safe to re-run this file
-- ============================================================
ALTER TABLE health.attendance_events DISABLE TRIGGER tr_attendance_events_append_only;
DELETE FROM health.leave_requests
WHERE person_id >= '00000000-0000-0000-0000-000000000011' AND person_id <= '00000000-0000-0000-0000-000000000022';
DELETE FROM health.attendance_events
WHERE person_id >= '00000000-0000-0000-0000-000000000011' AND person_id <= '00000000-0000-0000-0000-000000000022';
DELETE FROM health.employments
WHERE person_id >= '00000000-0000-0000-0000-000000000011' AND person_id <= '00000000-0000-0000-0000-000000000022';
ALTER TABLE health.attendance_events ENABLE TRIGGER tr_attendance_events_append_only;

-- ============================================================
-- 1. PERSONS (12 new, deterministic UUIDs ...011–...022)
-- ============================================================
INSERT INTO health.persons (logical_id, legal_name, preferred_name, date_of_birth, timezone) VALUES
  ('00000000-0000-0000-0000-000000000011', 'Aanya Sharma',  'Aanya',      DATE '1999-02-14', 'UTC'),
  ('00000000-0000-0000-0000-000000000012', 'Rohan Mehta',   'Rohan',      DATE '1996-06-03', 'UTC'),
  ('00000000-0000-0000-0000-000000000013', 'Kavya Nair',    'Kavya',      DATE '2000-10-21', 'UTC'),
  ('00000000-0000-0000-0000-000000000014', 'Vikram Rao',    'Vikram',     DATE '1994-01-27', 'UTC'),
  ('00000000-0000-0000-0000-000000000015', 'Meera Iyer',    'Meera',      DATE '1998-08-09', 'UTC'),
  ('00000000-0000-0000-0000-000000000016', 'Aditya Singh',  'Aditya',     DATE '2001-04-16', 'UTC'),
  ('00000000-0000-0000-0000-000000000017', 'Tanvi Kulkarni','Tanvi',      DATE '1997-12-05', 'UTC'),
  ('00000000-0000-0000-0000-000000000018', 'Ishaan Patel',  'Ishaan',     DATE '1995-03-30', 'UTC'),
  ('00000000-0000-0000-0000-000000000019', 'Divya Menon',   'Divya',      DATE '2002-07-12', 'UTC'),
  ('00000000-0000-0000-0000-000000000020', 'Karan Malhotra','Karan',      DATE '1993-09-24', 'UTC'),
  ('00000000-0000-0000-0000-000000000021', 'Ananya Reddy',  'Ananya',     DATE '1999-05-19', 'UTC'),
  ('00000000-0000-0000-0000-000000000022', 'Siddharth Joshi','Siddharth', DATE '1996-11-08', 'UTC')
ON CONFLICT (logical_id) DO NOTHING;

-- ============================================================
-- 2. EMPLOYMENTS (existing positions, ACTIVE, IN)
-- ============================================================
INSERT INTO health.employments (person_id, position_id, status, jurisdiction, employment_type, parental_consent_secured, started_at, valid_period, system_period)
SELECT p.logical_id, pos.logical_id, 'ACTIVE', 'IN', 'FULL_TIME', TRUE, DATE '2023-06-15',
       tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')
FROM (VALUES
  ('00000000-0000-0000-0000-000000000011', 'Engineering', 'Frontend Developer'),
  ('00000000-0000-0000-0000-000000000012', 'Engineering', 'Senior Engineer'),
  ('00000000-0000-0000-0000-000000000013', 'Engineering', 'Software Engineer'),
  ('00000000-0000-0000-0000-000000000014', 'Finance', 'Finance Analyst'),
  ('00000000-0000-0000-0000-000000000015', 'Finance', 'Junior Analyst'),
  ('00000000-0000-0000-0000-000000000016', 'Finance', 'Junior Analyst'),
  ('00000000-0000-0000-0000-000000000017', 'Marketing', 'Digital Marketer'),
  ('00000000-0000-0000-0000-000000000018', 'Marketing', 'Marketing Coordinator'),
  ('00000000-0000-0000-0000-000000000019', 'Marketing', 'Digital Marketer'),
  ('00000000-0000-0000-0000-000000000020', 'Sales', 'Account Executive'),
  ('00000000-0000-0000-0000-000000000021', 'Sales', 'Account Executive'),
  ('00000000-0000-0000-0000-000000000022', 'Sales', 'Account Executive')
) v(person_id, dept_name, position_name)
JOIN health.persons p ON p.logical_id = v.person_id::uuid
JOIN health.departments d ON d.name = v.dept_name
JOIN health.positions pos ON pos.name = v.position_name AND pos.department_id = d.logical_id AND pos.system_period @> NOW();

-- ============================================================
-- 3. ATTENDANCE — 28-day window with three deliberate patterns
--    A regular  (NORMAL), B one late night (WATCH), C short rest (ELEVATED)
--    Work days: Mon–Thu plus every-other Friday (max streak 4, ~16 days).
-- ============================================================
WITH day_set AS (
  SELECT gs
  FROM generate_series(0, 27) gs
  WHERE EXTRACT(ISODOW FROM (NOW() - gs * INTERVAL '1 day')) NOT IN (6, 7)
    AND NOT (EXTRACT(ISODOW FROM (NOW() - gs * INTERVAL '1 day')) = 5 AND floor(gs / 7.0) % 2 = 1)
    AND NOT (EXTRACT(ISODOW FROM (NOW() - gs * INTERVAL '1 day')) = 2 AND floor(gs / 7.0) % 2 = 1)
),
people AS (
  SELECT p.logical_id AS person_id, v.pattern
  FROM (VALUES
    ('00000000-0000-0000-0000-000000000011', 'B'),
    ('00000000-0000-0000-0000-000000000012', 'A'),
    ('00000000-0000-0000-0000-000000000013', 'C'),
    ('00000000-0000-0000-0000-000000000014', 'A'),
    ('00000000-0000-0000-0000-000000000015', 'B'),
    ('00000000-0000-0000-0000-000000000016', 'A'),
    ('00000000-0000-0000-0000-000000000017', 'A'),
    ('00000000-0000-0000-0000-000000000018', 'B'),
    ('00000000-0000-0000-0000-000000000019', 'C'),
    ('00000000-0000-0000-0000-000000000020', 'A'),
    ('00000000-0000-0000-0000-000000000021', 'B'),
    ('00000000-0000-0000-0000-000000000022', 'A')
  ) v(person_id, pattern)
  JOIN health.persons p ON p.logical_id = v.person_id::uuid
)
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id, captured_image_path)
SELECT
  pe.person_id,
  evt.event_type,
  ((NOW() - ds.gs * INTERVAL '1 day')::date + evt.at_time)::timestamptz,
  CASE WHEN pe.pattern = 'A' THEN 'Office' ELSE 'Remote' END,
  'DEV-0' || (pe.pattern = 'A' AND true)::int,
  CASE WHEN evt.event_type = 'CLOCK_IN' THEN '/photos/demo_' || substr(pe.person_id::text, 26) || '_' || ds.gs || '.jpg' END
FROM people pe
JOIN day_set ds ON true
JOIN (VALUES
  ('CLOCK_IN',  TIME '09:00'),
  ('CLOCK_OUT', TIME '17:30')
) evt(event_type, at_time) ON true
WHERE (pe.pattern = 'A')
   OR (pe.pattern = 'B' AND evt.at_time = TIME '09:00')
   OR (pe.pattern = 'C' AND evt.at_time = TIME '09:00');

-- Pattern B/C share the 09:00 clock-in; their own out-times and extras:
WITH day_set AS (
  SELECT gs
  FROM generate_series(0, 27) gs
  WHERE EXTRACT(ISODOW FROM (NOW() - gs * INTERVAL '1 day')) NOT IN (6, 7)
    AND NOT (EXTRACT(ISODOW FROM (NOW() - gs * INTERVAL '1 day')) = 5 AND floor(gs / 7.0) % 2 = 1)
    AND NOT (EXTRACT(ISODOW FROM (NOW() - gs * INTERVAL '1 day')) = 2 AND floor(gs / 7.0) % 2 = 1)
),
people AS (
  SELECT p.logical_id AS person_id, v.pattern
  FROM (VALUES
    ('00000000-0000-0000-0000-000000000011', 'B'),
    ('00000000-0000-0000-0000-000000000013', 'C'),
    ('00000000-0000-0000-0000-000000000015', 'B'),
    ('00000000-0000-0000-0000-000000000018', 'B'),
    ('00000000-0000-0000-0000-000000000019', 'C'),
    ('00000000-0000-0000-0000-000000000021', 'B')
  ) v(person_id, pattern)
  JOIN health.persons p ON p.logical_id = v.person_id::uuid
)
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id)
SELECT
  pe.person_id,
  'CLOCK_OUT',
  ((NOW() - ds.gs * INTERVAL '1 day')::date + TIME '17:00')::timestamptz,
  'Remote',
  'DEV-0' || CASE WHEN pe.pattern = 'B' THEN 3 ELSE 4 END
FROM people pe
JOIN day_set ds ON true
WHERE (pe.pattern = 'B' AND ds.gs != 5)
   OR (pe.pattern = 'C' AND ds.gs != 5);

-- Late-night events: B once (Friday, gs=5 → 22:15), C twice (gs=5 → 23:00, gs=6 → 04:30)
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id)
SELECT p.logical_id, 'CLOCK_OUT', (NOW() - 5 * INTERVAL '1 day')::date + TIME '22:15', 'Remote', 'DEV-003'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000011';
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id)
SELECT p.logical_id, 'CLOCK_OUT', (NOW() - 5 * INTERVAL '1 day')::date + TIME '23:00', 'Remote', 'DEV-004'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000013';
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id, captured_image_path)
SELECT p.logical_id, 'CLOCK_IN', (NOW() - 6 * INTERVAL '1 day')::date + TIME '04:30', 'Remote', 'DEV-004', '/photos/demo_early_' || substr(p.logical_id::text, 26) || '.jpg'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000013';
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id)
SELECT p.logical_id, 'CLOCK_OUT', (NOW() - 5 * INTERVAL '1 day')::date + TIME '22:15', 'Remote', 'DEV-003'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000015';
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id)
SELECT p.logical_id, 'CLOCK_OUT', (NOW() - 5 * INTERVAL '1 day')::date + TIME '22:15', 'Remote', 'DEV-003'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000018';
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id)
SELECT p.logical_id, 'CLOCK_OUT', (NOW() - 5 * INTERVAL '1 day')::date + TIME '23:00', 'Remote', 'DEV-004'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000019';
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id, captured_image_path)
SELECT p.logical_id, 'CLOCK_IN', (NOW() - 6 * INTERVAL '1 day')::date + TIME '04:30', 'Remote', 'DEV-004', '/photos/demo_early_' || substr(p.logical_id::text, 26) || '.jpg'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000019';
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id)
SELECT p.logical_id, 'CLOCK_OUT', (NOW() - 5 * INTERVAL '1 day')::date + TIME '22:15', 'Remote', 'DEV-003'
FROM health.persons p WHERE p.logical_id = '00000000-0000-0000-0000-000000000021';

-- ============================================================
-- 4. LEAVE — one approved leave per department within the window
-- ============================================================
INSERT INTO health.leave_requests (leave_type, status, start_date, end_date, days_requested, reason, parental_consent_secured, person_id, valid_period, system_period)
SELECT v.leave_type, 'APPROVED', v.start_date, v.end_date, v.days_requested, v.reason, TRUE, v.person_id::uuid,
       tstzrange(v.start_date::TIMESTAMPTZ, (v.end_date + 1)::TIMESTAMPTZ, '[]'),
       tstzrange(NOW(), NULL, '[]')
FROM (VALUES
  ('ANNUAL', (CURRENT_DATE - 12)::date, (CURRENT_DATE - 9)::date, 4, 'Family visit', '00000000-0000-0000-0000-000000000011'),
  ('CASUAL', (CURRENT_DATE - 20)::date, (CURRENT_DATE - 17)::date, 4, 'Personal errand', '00000000-0000-0000-0000-000000000014'),
  ('SICK',   (CURRENT_DATE - 6)::date,  (CURRENT_DATE - 4)::date,  3, 'Recovery', '00000000-0000-0000-0000-000000000019'),
  ('ANNUAL', (CURRENT_DATE - 15)::date, (CURRENT_DATE - 13)::date, 3, 'Short break', '00000000-0000-0000-0000-000000000020')
) v(leave_type, start_date, end_date, days_requested, reason, person_id);

-- ============================================================
-- VERIFICATION — department membership now above MIN_GROUP (5)
-- ============================================================
SELECT d.name, COUNT(e.person_id) AS active_members
FROM health.departments d
LEFT JOIN health.positions pos ON pos.department_id = d.logical_id AND pos.system_period @> NOW()
LEFT JOIN health.employments e ON e.position_id = pos.logical_id AND e.status = 'ACTIVE' AND e.system_period @> NOW()
GROUP BY d.name
ORDER BY d.name;

-- END OF MIGRATION 029
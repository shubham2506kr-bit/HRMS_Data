-- ============================================================
-- EduRankAI HRMS - Complete Dummy Data Set
-- Run: psql -U postgres -d edurankai -f E:\HRMS_Data\hrms-dummy-data.sql
-- ============================================================

-- ============================================================
-- 1. PERSONS - Core Identity (8 people, deterministic UUIDs)
-- ============================================================
INSERT INTO health.persons (logical_id, legal_name, preferred_name, date_of_birth, timezone) VALUES
  ('00000000-0000-0000-0000-000000000001', 'John Smith', 'John', DATE '1990-05-15', 'UTC'),
  ('00000000-0000-0000-0000-000000000002', 'Jane Doe', 'Jane', DATE '1985-08-20', 'UTC'),
  ('00000000-0000-0000-0000-000000000003', 'Robert Johnson', 'Robert', DATE '2006-03-10', 'UTC'),
  ('00000000-0000-0000-0000-000000000004', 'Emily Davis', 'Emily', DATE '2008-07-22', 'UTC'),
  ('00000000-0000-0000-0000-000000000005', 'Michael Brown', 'Michael', DATE '1992-11-30', 'UTC'),
  ('00000000-0000-0000-0000-000000000006', 'Sarah Wilson', 'Sarah', DATE '1995-04-12', 'UTC'),
  ('00000000-0000-0000-0000-000000000007', 'David Moore', 'David', DATE '1998-01-08', 'UTC'),
  ('00000000-0000-0000-0000-000000000008', 'Lisa Anderson', 'Lisa', DATE '2001-09-25', 'UTC');

-- ============================================================
-- 2. USER_ACCOUNTS - Login mapping for demo
-- ============================================================
INSERT INTO health.user_accounts (person_id, idp_subject_id, idp_issuer, is_active) VALUES
  ('00000000-0000-0000-0000-000000000001', 'emp-1', 'demo-idp', TRUE),
  ('00000000-0000-0000-0000-000000000002', 'emp-2', 'demo-idp', TRUE),
  ('00000000-0000-0000-0000-000000000003', 'emp-3', 'demo-idp', TRUE),
  ('00000000-0000-0000-0000-000000000004', 'emp-4', 'demo-idp', TRUE);

-- ============================================================
-- 3. DEPARTMENTS - Department Structure (4 departments)
-- ============================================================
INSERT INTO health.departments (name, jurisdiction, valid_period, system_period) VALUES
  ('Engineering', 'IN', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')),
  ('Marketing', 'IN', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')),
  ('Sales', 'IN', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')),
  ('Finance', 'IN', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]'));

-- ============================================================
-- 4. POSITIONS (with head_of_department_id links to persons)
-- ============================================================
INSERT INTO health.positions (name, department_id, head_of_department_id, grade_level, employment_type, valid_period, system_period)
SELECT v.name, d.logical_id, p.logical_id, v.grade_level, 'FULL_TIME', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')
FROM (VALUES
  ('Software Engineer', 'Engineering', 'John', 4),
  ('Senior Engineer', 'Engineering', 'John', 5),
  ('Frontend Developer', 'Engineering', 'John', 3),
  ('Marketing Coordinator', 'Marketing', 'Jane', 4),
  ('Digital Marketer', 'Marketing', 'Jane', 3),
  ('Sales Lead', 'Sales', 'Robert', 4),
  ('Account Executive', 'Sales', 'Robert', 3),
  ('Finance Analyst', 'Finance', 'Michael', 4),
  ('Junior Analyst', 'Finance', 'Michael', 2)
) v(name, dept_name, head_name, grade_level)
JOIN (SELECT logical_id, name FROM health.departments) d ON d.name = v.dept_name
JOIN (SELECT logical_id, preferred_name FROM health.persons) p ON p.preferred_name = v.head_name;

-- ============================================================
-- 5. REPORTING LINES (bitemporal DAG)
-- ============================================================
INSERT INTO health.position_reporting_lines (child_position_id, parent_position_id, is_primary, reporting_type, valid_period, system_period)
SELECT child.logical_id, parent.logical_id, TRUE, 'SOLID', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')
FROM health.positions child
JOIN health.positions parent ON parent.name = 'Senior Engineer' AND parent.department_id = child.department_id
WHERE child.name IN ('Software Engineer', 'Frontend Developer');

-- ============================================================
-- 6. EMPLOYMENTS (status ACTIVE, jurisdiction IN)
-- ============================================================
INSERT INTO health.employments (person_id, position_id, status, jurisdiction, employment_type, parental_consent_secured, started_at, valid_period, system_period)
SELECT p.logical_id, pos.logical_id, 'ACTIVE', 'IN', 'FULL_TIME', TRUE, DATE '2022-01-10', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')
FROM (SELECT logical_id, preferred_name FROM health.persons) p
JOIN health.positions pos ON pos.name = CASE p.preferred_name
    WHEN 'John' THEN 'Software Engineer'
    WHEN 'Jane' THEN 'Marketing Coordinator'
    WHEN 'Robert' THEN 'Sales Lead'
    WHEN 'Emily' THEN 'Digital Marketer'
    WHEN 'Michael' THEN 'Finance Analyst'
    WHEN 'Sarah' THEN 'Junior Analyst'
    WHEN 'David' THEN 'Account Executive'
    WHEN 'Lisa' THEN 'Frontend Developer'
END;

-- ============================================================
-- 7. CAMPUS AMBASSADORS (parental consent for minors)
-- ============================================================
INSERT INTO health.campus_ambassadors (person_id, department_id, role, start_date, end_date, parental_consent_secured) VALUES
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Robert'),
   (SELECT logical_id FROM health.departments WHERE name = 'Engineering'),
   'CAMPUS_AMBASSADOR', DATE '2024-01-15', DATE '2024-12-31', FALSE),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Emily'),
   (SELECT logical_id FROM health.departments WHERE name = 'Marketing'),
   'CAMPUS_AMBASSADOR', DATE '2024-09-01', DATE '2025-05-31', TRUE),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Emily'),
   (SELECT logical_id FROM health.departments WHERE name = 'Sales'),
   'CAMPUS_AMBASSADOR', DATE '2024-02-15', DATE '2024-11-30', TRUE),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Michael'),
   (SELECT logical_id FROM health.departments WHERE name = 'Engineering'),
   'CAMPUS_AMBASSADOR', DATE '2023-10-01', DATE '2024-06-30', FALSE),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Sarah'),
   (SELECT logical_id FROM health.departments WHERE name = 'Sales'),
   'CAMPUS_AMBASSADOR', DATE '2024-03-01', DATE '2025-01-31', TRUE),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'David'),
   (SELECT logical_id FROM health.departments WHERE name = 'Marketing'),
   'CAMPUS_AMBASSADOR', DATE '2024-06-01', NULL, TRUE),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Lisa'),
   (SELECT logical_id FROM health.departments WHERE name = 'Engineering'),
   'CAMPUS_AMBASSADOR', DATE '2024-01-01', NULL, TRUE);

-- ============================================================
-- 8. LEAVE REQUESTS (bitemporal - valid_period matches CHECK)
-- ============================================================
INSERT INTO health.leave_requests (leave_type, status, start_date, end_date, days_requested, reason, parental_consent_secured, person_id, valid_period, system_period)
SELECT v.leave_type, v.status, v.start_date, v.end_date, v.days_requested, v.reason,
       v.parental_consent_secured, p.logical_id,
       tstzrange(v.start_date::TIMESTAMPTZ, (v.end_date + 1)::TIMESTAMPTZ, '[]'),
       tstzrange(NOW(), NULL, '[]')
FROM (VALUES
  ('ANNUAL', 'APPROVED', DATE '2024-12-20', DATE '2024-12-25', 6, 'Christmas vacation', TRUE, 'John'),
  ('SICK', 'PENDING', DATE '2024-12-15', DATE '2024-12-17', 3, 'Flu', TRUE, 'Jane'),
  ('CASUAL', 'APPROVED', DATE '2024-11-01', DATE '2024-11-03', 3, 'Family event', FALSE, 'Robert'),
  ('PARENTAL', 'APPROVED', DATE '2024-10-01', DATE '2024-10-15', 15, 'New child', TRUE, 'Emily'),
  ('ANNUAL', 'PENDING', DATE '2025-01-05', DATE '2025-01-09', 5, 'Vacation planning', TRUE, 'Michael'),
  ('SICK', 'APPROVED', DATE '2024-11-20', DATE '2024-11-22', 3, 'Bronchitis', TRUE, 'Sarah'),
  ('CASUAL', 'REJECTED', DATE '2024-10-10', DATE '2024-10-12', 3, 'Not approved in time', TRUE, 'David'),
  ('ANNUAL', 'PENDING', DATE '2025-03-10', DATE '2025-03-14', 5, 'Spring break', TRUE, 'Lisa')
) v(leave_type, status, start_date, end_date, days_requested, reason, parental_consent_secured, person_name)
JOIN (SELECT logical_id, preferred_name FROM health.persons) p ON p.preferred_name = v.person_name;

-- ============================================================
-- 9. ATTENDANCE EVENTS (append-only, uppercase event types)
-- ============================================================
INSERT INTO health.attendance_events (person_id, event_type, occurred_at, location, device_id, captured_image_path) VALUES
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '9:00:00', 'Office', 'DEV-001', '/photos/john_smith_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:00:00', 'Office', 'DEV-001', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'CLOCK_IN', NOW() - INTERVAL '2 day' + INTERVAL '8:30:00', 'Office', 'DEV-001', '/photos/john_yesterday.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'CLOCK_OUT', NOW() - INTERVAL '2 day' + INTERVAL '17:30:00', 'Office', 'DEV-001', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '8:45:00', 'Office', 'DEV-002', '/photos/jane_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:15:00', 'Office', 'DEV-002', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Robert'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '8:55:00', 'Office', 'DEV-001', '/photos/robert_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Robert'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:00:00', 'Office', 'DEV-001', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Emily'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '9:00:00', 'Office', 'DEV-002', '/photos/emily_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Emily'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:00:00', 'Office', 'DEV-002', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Michael'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '8:30:00', 'Remote', 'DEV-001', '/photos/michael_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Michael'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:00:00', 'Remote', 'DEV-001', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Sarah'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '8:50:00', 'Office', 'DEV-002', '/photos/sarah_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Sarah'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:00:00', 'Office', 'DEV-002', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'David'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '9:00:00', 'Office', 'DEV-001', '/photos/david_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'David'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:00:00', 'Office', 'DEV-001', NULL),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Lisa'), 'CLOCK_IN', NOW() - INTERVAL '1 day' + INTERVAL '8:30:00', 'Office', 'DEV-002', '/photos/lisa_today.jpg'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Lisa'), 'CLOCK_OUT', NOW() - INTERVAL '1 day' + INTERVAL '17:30:00', 'Office', 'DEV-002', NULL);

-- ============================================================
-- 10. EMPLOYEE MESSAGES
-- ============================================================
INSERT INTO health.employee_messages (sender_id, recipient_id, subject, content, read_status, created_at) VALUES
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane'), 'Team Meeting', 'Hi Jane, the team standup is at 10 AM tomorrow in conference room A.', FALSE, NOW()),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'Re: Team Meeting', 'Thanks John, I will make sure to be there at 9:50 AM.', TRUE, NOW() - INTERVAL '1 hour'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Robert'), 'Project Update', 'Hi Robert, please review the latest design specs before the sprint planning.', FALSE, NOW() - INTERVAL '1 day'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Robert'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'Re: Project Update', 'Thanks John, I have reviewed the specs and have some feedback for the next sprint.', FALSE, NOW() - INTERVAL '2 days'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Michael'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'Weekly Check-in', 'Hi John, just checking in on your progress with the new feature.', FALSE, NOW() - INTERVAL '2 days'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Michael'), 'Re: Weekly Check-in', 'Thanks Michael, progress is on track. Looking forward to the demo next week.', TRUE, NOW() - INTERVAL '1 day'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Sarah'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'Budget Review', 'Hi John, please find the Q3 budget summary attached. Let me know if you have questions.', FALSE, NOW() - INTERVAL '3 days'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Sarah'), 'Re: Budget Review', 'Thanks Sarah, the numbers look good. I will review them in the meeting tomorrow.', TRUE, NOW() - INTERVAL '2 days'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'David'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), 'Status Update', 'Hi John, the server migration is complete. Please update the network topology diagram.', FALSE, NOW() - INTERVAL '3 days'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'David'), 'Re: Status Update', 'Got it David, I will update the diagram this week.', TRUE, NOW() - INTERVAL '2 days'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'David'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Lisa'), 'Cross-departmental', 'Hi Lisa, do you have a moment to discuss the Q4 marketing alignment?', TRUE, NOW() - INTERVAL '1 day'),
  ((SELECT logical_id FROM health.persons WHERE preferred_name = 'Lisa'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'David'), 'Re: Cross-departmental', 'Hi David, yes I do. Please send over the details and we will schedule a call.', FALSE, NOW() - INTERVAL '12 hours');

-- ============================================================
-- 11. AUDIT LOG
-- ============================================================
INSERT INTO health.audit_log (action, target_type, target_id, person_id, details) VALUES
  ('employment_insert', 'employment', (SELECT logical_id FROM health.employments WHERE person_id = (SELECT logical_id FROM health.persons WHERE preferred_name = 'John') ORDER BY created_at DESC LIMIT 1), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), NULL),
  ('leave_request_insert', 'leave_request', (SELECT logical_id FROM health.leave_requests WHERE person_id = (SELECT logical_id FROM health.persons WHERE preferred_name = 'John') ORDER BY created_at DESC LIMIT 1), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), NULL),
  ('attendance_event_insert', 'attendance_event', (SELECT logical_id FROM health.attendance_events WHERE person_id = (SELECT logical_id FROM health.persons WHERE preferred_name = 'John') ORDER BY created_at DESC LIMIT 1), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), NULL),
  ('department_insert', 'department', (SELECT logical_id FROM health.departments WHERE name = 'Engineering'), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), NULL),
  ('employment_update', 'employment', (SELECT logical_id FROM health.employments WHERE person_id = (SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane') ORDER BY created_at DESC LIMIT 1), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane'), NULL),
  ('leave_request_update', 'leave_request', (SELECT logical_id FROM health.leave_requests WHERE person_id = (SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane') ORDER BY created_at DESC LIMIT 1), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Jane'), NULL),
  ('campus_ambassador_insert', 'campus_ambassador', (SELECT logical_id FROM health.campus_ambassadors WHERE person_id = (SELECT logical_id FROM health.persons WHERE preferred_name = 'Emily') ORDER BY created_at DESC LIMIT 1), (SELECT logical_id FROM health.persons WHERE preferred_name = 'Emily'), NULL),
  ('employee_message_insert', 'employee_message', (SELECT logical_id FROM health.employee_messages WHERE recipient_id = (SELECT logical_id FROM health.persons WHERE preferred_name = 'John') ORDER BY created_at DESC LIMIT 1), (SELECT logical_id FROM health.persons WHERE preferred_name = 'John'), NULL);

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
SELECT 'persons' as table_name, count(*) as row_count FROM health.persons
UNION ALL
SELECT 'user_accounts', count(*) FROM health.user_accounts
UNION ALL
SELECT 'departments', count(*) FROM health.departments
UNION ALL
SELECT 'positions', count(*) FROM health.positions
UNION ALL
SELECT 'employments', count(*) FROM health.employments
UNION ALL
SELECT 'leave_requests', count(*) FROM health.leave_requests
UNION ALL
SELECT 'attendance_events', count(*) FROM health.attendance_events
UNION ALL
SELECT 'campus_ambassadors', count(*) FROM health.campus_ambassadors
UNION ALL
SELECT 'employee_messages', count(*) FROM health.employee_messages
UNION ALL
SELECT 'audit_log', count(*) FROM health.audit_log;

-- ============================================================
-- END OF DUMMY DATA SET
-- ============================================================
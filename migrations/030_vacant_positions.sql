-- Migration 030: Vacant positions for open-role demonstration
-- Description: Adds one vacant position per department (no employment holder)
-- so the organization explorer's "open positions" and Growth's internal
-- opportunities are real, demonstrable data. No schema DDL.

INSERT INTO health.positions (name, department_id, head_of_department_id, grade_level, employment_type, valid_period, system_period)
SELECT v.name, d.logical_id, p.logical_id, v.grade_level, 'FULL_TIME', tstzrange(NOW(), NULL, '[]'), tstzrange(NOW(), NULL, '[]')
FROM (VALUES
  ('Platform Engineer', 'Engineering', 'John', 4),
  ('Brand Designer', 'Marketing', 'Jane', 3),
  ('Inside Sales Specialist', 'Sales', 'Robert', 3),
  ('Treasury Analyst', 'Finance', 'Michael', 3)
) v(name, dept_name, head_name, grade_level)
JOIN (SELECT logical_id, name FROM health.departments) d ON d.name = v.dept_name
JOIN (SELECT logical_id, preferred_name FROM health.persons) p ON p.preferred_name = v.head_name
WHERE NOT EXISTS (
  SELECT 1 FROM health.positions pos
  WHERE pos.name = v.name AND pos.department_id = d.logical_id AND pos.system_period @> NOW()
);

SELECT d.name, COUNT(pos.logical_id) FILTER (WHERE pos.valid_period @> NOW()) AS total_roles
FROM health.departments d
LEFT JOIN health.positions pos ON pos.department_id = d.logical_id
WHERE pos.system_period @> NOW()
GROUP BY d.name ORDER BY d.name;

-- END OF MIGRATION 030
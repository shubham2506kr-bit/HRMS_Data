-- ============================================================
-- EduRankAI HRMS — Master Setup Script
-- Run: psql -U postgres -f E:\HRMS_Data\run_all.sql
-- ============================================================
-- This script:
-- 1. Drops and recreates the database
-- 2. Runs all 14 migrations in order
-- 3. Loads dummy data
-- 4. Runs verification queries
-- ============================================================

-- ============================================================
-- 1. DROP AND RECREATE DATABASE
-- ============================================================
\c postgres
DROP DATABASE IF EXISTS edurankai;
CREATE DATABASE edurankai;
\c edurankai

-- ============================================================
-- 2. RUN ALL MIGRATIONS IN ORDER
-- ============================================================

-- Migration 001: Core Schema
\i E:\HRMS_Data\migrations\001_core_schema.sql

-- Migration 002: Temporal Functions
\i E:\HRMS_Data\migrations\002_temporal_functions.sql

-- Migration 003: Leave & Attendance
\i E:\HRMS_Data\migrations\003_leave_attendance.sql

-- Migration 004: Messages & Notifications
\i E:\HRMS_Data\migrations\004_messages_notifications.sql

-- Migration 005: Campus Ambassadors
\i E:\HRMS_Data\migrations\005_campus_ambassadors.sql

-- Migration 006: Audit Enhancements
\i E:\HRMS_Data\migrations\006_audit_enhancements.sql

-- Migration 007: Bitemporal Key Correction (Verification)
\i E:\HRMS_Data\migrations\007_bitemporal_key_correction.sql

-- Migration 008: Leave Balance Function
\i E:\HRMS_Data\migrations\008_attendance_leave.sql

-- Migration 009: Department Head Role
\i E:\HRMS_Data\migrations\009_department_head.sql

-- Migration 010: Role Combination Semantics
\i E:\HRMS_Data\migrations\010_role_combination.sql

-- Migration 011: D4 Production Preparation
\i E:\HRMS_Data\migrations\011_d4_production.sql

-- Migration 012: Health Data Schema
\i E:\HRMS_Data\migrations\012_health_data.sql

-- Migration 013: Jurisdiction Seams (Seams only)
\i E:\HRMS_Data\migrations\013_jurisdiction_seams.sql

-- Migration 014: Open Items Tracking
\i E:\HRMS_Data\migrations\014_open_items.sql

-- ============================================================
-- 3. LOAD DUMMY DATA
-- ============================================================
\i E:\HRMS_Data\hrms-dummy-data.sql

-- ============================================================
-- 4. VERIFICATION QUERIES
-- ============================================================
SELECT '=== VERIFICATION RESULTS ===' as status;

SELECT 'persons' as table_name, count(*) as row_count FROM health.persons
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

-- Verify key constraints
SELECT 'persons with under-18 minors' as check_name, count(*) as count FROM health.persons WHERE EXTRACT(YEAR FROM AGE(date_of_birth)) < 18;
SELECT 'employments with parental consent' as check_name, count(*) as count FROM health.employments WHERE parental_consent_secured = TRUE;
SELECT 'campus ambassadors with consent' as check_name, count(*) as count FROM health.campus_ambassadors WHERE parental_consent_secured = TRUE;

-- Verify bitemporal key correction
SELECT tablename, array_agg(attname ORDER BY attnum) as pk_columns
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'health' AND i.indisprimary
  AND tablename IN ('departments', 'positions', 'position_reporting_lines', 'employments', 'leave_requests')
GROUP BY tablename
ORDER BY tablename;

\echo '=== SETUP COMPLETE ==='
\echo 'All migrations applied successfully!'
\echo 'Dummy data loaded successfully!'
\echo 'System ready for testing.'
\echo ''
\echo 'Next steps:'
\echo '1. Start backend: cd E:\HRMS_Data\backend && npm install && npm run dev'
\echo '2. Start frontend: cd E:\HRMS_Data\frontend && npm install && npm run dev'
\echo '3. Open http://localhost:5173'
\echo '4. Login with Employee ID: 1, Role: employee'
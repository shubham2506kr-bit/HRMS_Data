-- Migration 014: Open Items Documentation (Section 8)
-- Applied: After 013
-- Description: Documentation of open items from Section 8

-- ============================================================
-- OPEN ITEMS DOCUMENTATION (Section 8)
-- These items remain open and are documented here for tracking
-- ============================================================

-- OPEN ITEM 1: Health Data Encryption
-- Status: UNIMPLEMENTED - BLOCKED
-- Blocks: Health data encryption
-- Needs: Cryptographer specialist (two-tier wrapping design)
-- Details: Health data is currently NOT ENCRYPTED - firewall only
-- Reference: docs/CRYPTO_REVIEW_BRIEF.md

-- OPEN ITEM 2: audit_log.read - Subject Access Rights
-- Status: PROVISIONAL DENY - NEEDS LEGAL COUNSEL
-- Description: Can a subject see their own audit trail?
-- GDPR/DPDP subject-access-rights question vs. tipping off active investigations
-- Status: Provisional deny in force; flagged for counsel

-- OPEN ITEM 3: Role-Combination Semantics
-- Status: DOCUMENTED - NOT REVIEWED
-- Description: Currently "union of permissions" (if person holds two roles,
-- they get the union of what each allows) - documented and tested,
-- but not yet reviewed as deliberate security posture

-- OPEN ITEM 4: department_head_of Role
-- Status: DEFINED, TESTED-AS-INERT, CANNOT ACTIVATE
-- Description: Defined in migration 009, tested-as-inert,
-- but cannot activate - needs modeling decision
-- Needs: Modeling decision (column on departments? Position flag?)

-- OPEN ITEM 5: D4 (app_service as real login role)
-- Status: CRITICAL PATH - MUST COMPLETE BEFORE PRODUCTION
-- Description: Nothing has ever run under real application credentials
-- Only superuser in tests - defense-in-depth not proven end-to-end
-- Must: ALTER ROLE app_service LOGIN and re-run test suite as app_service
-- Must close before production - DO NOT SKIP

-- ============================================================
-- TRACKING TABLE: Open items status
-- ============================================================
CREATE TABLE IF NOT EXISTS health.open_items (
    logical_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('BLOCKED', 'PENDING_LEGAL', 'DOCUMENTED', 'IN_PROGRESS', 'COMPLETED', 'DEFERRED')),
    priority TEXT CHECK (priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')) DEFAULT 'HIGH',
    blocker TEXT,
    owner TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT
);

-- Insert open items
INSERT INTO health.open_items (item_id, title, description, status, priority, blocker) VALUES
('HEALTH_ENCRYPTION', 'Health Data Encryption', 'Health data NOT ENCRYPTED - firewall only. Two-tier wrapping design needed. Health WRITE path BLOCKED.', 'BLOCKED', 'CRITICAL', 'Needs cryptographer specialist'),
('AUDIT_LOG_READ', 'audit_log.read - Subject Access Rights', 'Can subject see own audit trail? GDPR/DPDP subject-access-rights vs. tipping off active investigations. Needs legal counsel.', 'PENDING_LEGAL', 'HIGH', 'Needs GDPR/DPDP legal counsel'),
('ROLE_COMBINATION', 'Role-Combination Semantics', 'Currently "union of permissions" (if person holds two roles, they get union of what each allows) - documented and tested, but not yet reviewed as deliberate security posture.', 'DOCUMENTED', 'MEDIUM', 'Needs security posture review'),
('DEPARTMENT_HEAD', 'department_head_of Role Activation', 'Defined in migration 009, tested-as-inert, cannot activate. Needs modeling decision (column on departments? Position flag?).', 'DOCUMENTED', 'HIGH', 'Needs modeling decision (column vs position flag)'),
('D4_LOGIN_ROLE', 'D4 - app_service as Real Login Role', 'Nothing has ever run under real application credentials. Only superuser in tests. Must ALTER ROLE app_service LOGIN and re-run test suite as app_service before production.', 'IN_PROGRESS', 'CRITICAL', 'Must complete before production');

-- ============================================================
-- END OF MIGRATION 014
-- ============================================================
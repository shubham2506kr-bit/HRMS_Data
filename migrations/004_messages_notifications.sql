-- Migration 004: Employee Messages (Section 11)
-- Applied: After 003
-- Description: Employee messaging system

-- ============================================================
-- EMPLOYEE_MESSAGES - Internal communication (Section 11)
-- ============================================================
CREATE TABLE health.employee_messages (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE RESTRICT,
    recipient_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE RESTRICT,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    read_status BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    priority TEXT CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')) DEFAULT 'NORMAL',
    thread_id UUID, -- for threading
    parent_message_id UUID REFERENCES health.employee_messages(logical_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_recipient ON health.employee_messages (recipient_id, read_status, created_at DESC);
CREATE INDEX idx_messages_sender ON health.employee_messages (sender_id, created_at DESC);
CREATE INDEX idx_messages_thread ON health.employee_messages (thread_id, created_at);

-- ============================================================
-- MESSAGE_THREADS - For conversation grouping
-- ============================================================
CREATE TABLE health.message_threads (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject TEXT NOT NULL,
    participant_ids UUID[] NOT NULL,
    created_by UUID NOT NULL REFERENCES health.persons(logical_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threads_participant ON health.message_threads USING GIN (participant_ids);

-- ============================================================
-- NOTIFICATIONS - System notifications
-- ============================================================
CREATE TABLE health.notifications (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipient_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('INFO', 'WARNING', 'SUCCESS', 'ERROR', 'ACTION_REQUIRED')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    action_url TEXT,
    read_status BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    priority TEXT CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')) DEFAULT 'NORMAL',
    expires_at TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_recipient ON health.notifications (recipient_id, read_status, created_at DESC);
CREATE INDEX idx_notifications_expires ON health.notifications (expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================
-- END OF MIGRATION 004
-- ============================================================
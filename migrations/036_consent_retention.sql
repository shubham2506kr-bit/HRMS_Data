-- Migration 036: Health-data consent, minors, retention and data-subject rights
--
-- Runs AFTER 033 (which creates health.fn_current_person(), health.fn_has_role()
-- and enables row-level security across the health schema).
--
-- WHAT THIS MIGRATION ESTABLISHES
--  1. A purpose catalogue: health data may only be processed for a named,
--     declared purpose.
--  2. Purpose-specific consent with an expiry and an immediate withdrawal
--     timestamp, checked AT THE POINT OF USE (see health.fn_has_valid_consent).
--  3. Verifiable parental consent for minors (DPDP Act 2023 s.9(3)). Minority is
--     computed with real date arithmetic in the org timezone; an unknown date of
--     birth is treated as a MINOR, never as an adult.
--  4. Purpose-specific retention periods plus a re-runnable erasure function
--     that strips the payload and LEAVES THE AUDIT TRAIL INTACT.
--  5. A data-subject-request register with a statutory deadline and a recorded
--     resolution, and second-party approval for erasure.
--
-- ENCRYPTION AT REST: NOT IMPLEMENTED. Read this plainly — clinical free text in
-- health.advisor_queries (question, reply) and health.safety_checkins (note,
-- location, latitude, longitude) is stored in PLAINTEXT. config's optional
-- HEALTH_DATA_ENCRYPTION_KEY is NOT used by this schema and pgcrypto is not
-- enabled here. Doing it properly requires a key-management seam that does not
-- exist yet: a session-scoped key GUC set by the connection pool, a key-version
-- column per encrypted column, and a rotation job that re-wraps existing rows.
-- Encrypting only new rows, or passing the key as a literal in every statement
-- (where it would land in pg_stat_statements and the server log), would look
-- protective without being protective. Until that seam lands, the controls that
-- actually apply are: row-level security, purpose-bound consent, an explicit
-- column allowlist in the API layer, retention limits, and audit.
--
-- Idempotent and re-runnable: IF NOT EXISTS, CREATE OR REPLACE, guarded DO blocks.

-- ============================================================
-- 1. PROCESSING PURPOSES — health data has no "general" purpose
-- ============================================================

CREATE TABLE IF NOT EXISTS health.processing_purposes (
    purpose_code TEXT PRIMARY KEY,
    data_class TEXT NOT NULL,
    description TEXT NOT NULL,
    -- Consent is only valid for this long before it must be re-taken.
    default_validity_days INTEGER NOT NULL DEFAULT 365
        CHECK (default_validity_days > 0 AND default_validity_days <= 3650),
    -- TRUE where the purpose processes special-category health data and so
    -- requires verified parental consent when the subject is a minor.
    requires_parental_consent_for_minors BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO health.processing_purposes
    (purpose_code, data_class, description, default_validity_days)
VALUES
    ('CARE_ADVISORY', 'HEALTH_FREE_TEXT',
     'Answering the employee''s own wellbeing question from the approved WHO and traditional-knowledge registries.', 365),
    ('CARE_ADVISORY_HISTORY', 'HEALTH_FREE_TEXT',
     'Retaining the employee''s own question and the reply so they can re-read their history.', 180),
    ('SAFETY_CHECKIN', 'LOCATION',
     'Recording an employee-initiated field safety check-in, including location when the employee sends it.', 365),
    ('CLINICAL_REVIEW', 'HEALTH_FREE_TEXT',
     'Review of an employee''s health record by a named clinical or occupational-health role.', 180),
    ('WOMENS_CARE_RESOURCES', 'HEALTH_TOPIC_INTEREST',
     'Unlocking WHO public women''s-health resources for the employee.', 365)
ON CONFLICT (purpose_code) DO NOTHING;

COMMENT ON TABLE health.processing_purposes IS
    'Declared purposes for processing health data. A purpose that is not listed here cannot be consented to.';

-- ============================================================
-- 2. PURPOSE-SPECIFIC CONSENT
-- ============================================================
-- One row per consent grant. Withdrawal is a timestamp, not a delete, so the
-- history is provable; withdrawal takes effect the instant it is written
-- because every read/write re-evaluates health.fn_has_valid_consent().

CREATE TABLE IF NOT EXISTS health.health_consents (
    consent_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    purpose_code TEXT NOT NULL REFERENCES health.processing_purposes(purpose_code),
    -- SELF: the data subject consented. PARENTAL: a verified parent/guardian
    -- consented on behalf of a minor (DPDP s.9(1)).
    consent_basis TEXT NOT NULL DEFAULT 'SELF'
        CHECK (consent_basis IN ('SELF', 'PARENTAL')),
    granted_by_person_id UUID REFERENCES health.persons(logical_id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    withdrawn_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > granted_at),
    CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

-- At most one live consent per person per purpose.
CREATE UNIQUE INDEX IF NOT EXISTS uq_health_consents_live
    ON health.health_consents (person_id, purpose_code)
    WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_health_consents_person
    ON health.health_consents (person_id, purpose_code, withdrawn_at);

CREATE TABLE IF NOT EXISTS health.consent_decisions (
    decision_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    purpose_code TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('GRANT', 'WITHDRAW', 'EXPIRE')),
    actor_person_id UUID,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_decisions_person
    ON health.consent_decisions (person_id, decided_at DESC);

-- Verifiable parental consent (DPDP s.9(1)). Only the verification METHOD and a
-- reference to the evidence are stored — never the evidence itself, and never
-- free text about the child.
CREATE TABLE IF NOT EXISTS health.parental_consent_verifications (
    verification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    minor_person_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    guardian_name TEXT NOT NULL,
    guardian_relationship TEXT NOT NULL
        CHECK (guardian_relationship IN ('PARENT', 'LEGAL_GUARDIAN')),
    verification_method TEXT NOT NULL
        CHECK (verification_method IN ('IN_PERSON_HR', 'SIGNED_DOCUMENT', 'DIGILOCKER', 'REGISTERED_POST')),
    evidence_reference TEXT NOT NULL,
    verified_by_person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    -- The verifier must not be the child.
    CHECK (verified_by_person_id <> minor_person_id)
);

CREATE INDEX IF NOT EXISTS idx_parental_verifications_minor
    ON health.parental_consent_verifications (minor_person_id, revoked_at);

COMMENT ON TABLE health.health_consents IS
    'Purpose-specific health-data consent. Checked at the point of use, not the point of collection.';
COMMENT ON TABLE health.parental_consent_verifications IS
    'Verified parental/guardian consent for a minor (DPDP Act 2023 s.9). Stores the verification method and an evidence reference only.';

-- ============================================================
-- 3. MINORITY AND CONSENT VALIDITY FUNCTIONS
-- ============================================================

-- Minority, computed correctly: date_of_birth + 18 years compared against
-- today in the ORG TIMEZONE. NOT a subtraction of year numbers, which
-- mislabels everyone whose birthday has not yet occurred this year.
-- A missing person row or a NULL date_of_birth is UNKNOWN, and unknown is
-- treated as a MINOR (protected), never as an adult.
CREATE OR REPLACE FUNCTION health.fn_person_is_minor(
    p_person_id UUID,
    p_timezone TEXT DEFAULT 'Asia/Kolkata'
) RETURNS BOOLEAN AS $$
    SELECT COALESCE(
        (SELECT p.date_of_birth IS NULL
                OR (p.date_of_birth + INTERVAL '18 years')::date
                     > (NOW() AT TIME ZONE p_timezone)::date
         FROM health.persons p
         WHERE p.logical_id = p_person_id
         LIMIT 1),
        TRUE
    );
$$ LANGUAGE sql STABLE;

-- Is there verified, unrevoked, unexpired parental consent for this minor?
CREATE OR REPLACE FUNCTION health.fn_has_parental_consent(p_person_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1
        FROM health.parental_consent_verifications v
        WHERE v.minor_person_id = p_person_id
          AND v.revoked_at IS NULL
          AND v.valid_until > NOW()
    );
$$ LANGUAGE sql STABLE;

-- THE GATE. True only when an unexpired, unwithdrawn consent exists for this
-- exact purpose for this exact person AND, where the subject is (or may be) a
-- minor, verified parental consent also exists.
CREATE OR REPLACE FUNCTION health.fn_has_valid_consent(
    p_person_id UUID,
    p_purpose_code TEXT,
    p_timezone TEXT DEFAULT 'Asia/Kolkata'
) RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1
        FROM health.health_consents c
        JOIN health.processing_purposes pp ON pp.purpose_code = c.purpose_code
        WHERE c.person_id = p_person_id
          AND c.purpose_code = p_purpose_code
          AND c.withdrawn_at IS NULL
          AND c.expires_at > NOW()
          AND (
              NOT pp.requires_parental_consent_for_minors
              OR NOT health.fn_person_is_minor(p_person_id, p_timezone)
              OR health.fn_has_parental_consent(p_person_id)
          )
    );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION health.fn_person_is_minor(UUID, TEXT) IS
    'DPDP s.9(3) minority test. Real date arithmetic in the org timezone; unknown date of birth is treated as a minor.';
COMMENT ON FUNCTION health.fn_has_valid_consent(UUID, TEXT, TEXT) IS
    'Point-of-use consent gate: unexpired, unwithdrawn, purpose-matched, plus verified parental consent for minors.';

-- ============================================================
-- 4. RETENTION POLICY — a period per data class, per purpose
-- ============================================================

CREATE TABLE IF NOT EXISTS health.retention_policies (
    policy_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    data_class TEXT NOT NULL,
    purpose_code TEXT NOT NULL REFERENCES health.processing_purposes(purpose_code),
    target_table TEXT NOT NULL,
    retention_days INTEGER NOT NULL CHECK (retention_days > 0 AND retention_days <= 3650),
    -- ERASE_PAYLOAD keeps the row shell and the audit trail but destroys the
    -- special-category content. ARCHIVE moves the payload to the archive table.
    disposition TEXT NOT NULL DEFAULT 'ERASE_PAYLOAD'
        CHECK (disposition IN ('ERASE_PAYLOAD', 'ARCHIVE')),
    legal_basis TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (purpose_code, target_table)
);

INSERT INTO health.retention_policies
    (data_class, purpose_code, target_table, retention_days, disposition, legal_basis)
VALUES
    ('HEALTH_FREE_TEXT', 'CARE_ADVISORY_HISTORY', 'health.advisor_queries', 180, 'ERASE_PAYLOAD',
     'DPDP s.8(7): erase personal data once the purpose is no longer being served.'),
    ('LOCATION', 'SAFETY_CHECKIN', 'health.safety_checkins', 365, 'ERASE_PAYLOAD',
     'DPDP s.8(7); location is retained only as long as the safety purpose lasts.')
ON CONFLICT (purpose_code, target_table) DO NOTHING;

CREATE TABLE IF NOT EXISTS health.retention_runs (
    run_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    target_table TEXT NOT NULL,
    rows_affected INTEGER NOT NULL DEFAULT 0,
    triggered_by TEXT NOT NULL DEFAULT 'scheduler'
);

-- Archive of erased payloads is deliberately NOT created: an archive of
-- special-category free text is another copy of the same risk. The policy
-- disposition ARCHIVE exists for data classes that later need it, and
-- fn_apply_retention refuses to act on it until an archive target is defined.

COMMENT ON TABLE health.retention_policies IS
    'Purpose-specific retention period per data class. ERASE_PAYLOAD destroys content and keeps the row shell so audit references stay resolvable.';

-- ============================================================
-- 5. APPLY RETENTION — erase expired payloads, keep the audit trail
-- ============================================================
-- Deliberately NOT dynamic SQL over policy.target_table: each table's payload
-- columns are named explicitly so no future column is silently left behind or
-- silently destroyed. Adding a table here is a conscious act.
--
-- Audit rows in health.audit_log are never touched. The row shell (id, person,
-- timestamps) survives so an audit entry that references a record still
-- resolves; only the special-category content is destroyed.

CREATE OR REPLACE FUNCTION health.fn_apply_retention(p_dry_run BOOLEAN DEFAULT FALSE)
RETURNS TABLE (target_table TEXT, rows_affected INTEGER) AS $$
DECLARE
    v_days INTEGER;
    v_count INTEGER;
BEGIN
    -- health.advisor_queries: destroy the question and the reply free text.
    SELECT rp.retention_days INTO v_days
    FROM health.retention_policies rp
    WHERE rp.target_table = 'health.advisor_queries'
      AND rp.enabled
      AND rp.disposition = 'ERASE_PAYLOAD';

    IF v_days IS NOT NULL THEN
        IF p_dry_run THEN
            SELECT COUNT(*)::INTEGER INTO v_count
            FROM health.advisor_queries q
            WHERE q.created_at < NOW() - make_interval(days => v_days)
              AND (q.question <> '' OR q.reply <> '');
        ELSE
            WITH expired AS (
                UPDATE health.advisor_queries q
                SET question = '', reply = '', matched_topic_ids = '{}'
                WHERE q.created_at < NOW() - make_interval(days => v_days)
                  AND (q.question <> '' OR q.reply <> '')
                RETURNING 1
            )
            SELECT COUNT(*)::INTEGER INTO v_count FROM expired;
        END IF;
        INSERT INTO health.retention_runs (finished_at, dry_run, target_table, rows_affected)
        VALUES (NOW(), p_dry_run, 'health.advisor_queries', COALESCE(v_count, 0));
        RETURN QUERY SELECT 'health.advisor_queries'::TEXT, COALESCE(v_count, 0);
    END IF;

    -- health.safety_checkins: destroy location and note, keep the fact of a
    -- check-in (a safety control) and its timestamp.
    SELECT rp.retention_days INTO v_days
    FROM health.retention_policies rp
    WHERE rp.target_table = 'health.safety_checkins'
      AND rp.enabled
      AND rp.disposition = 'ERASE_PAYLOAD';

    IF v_days IS NOT NULL THEN
        IF p_dry_run THEN
            SELECT COUNT(*)::INTEGER INTO v_count
            FROM health.safety_checkins c
            WHERE c.occurred_at < NOW() - make_interval(days => v_days)
              AND (c.latitude IS NOT NULL OR c.longitude IS NOT NULL
                   OR c.location IS NOT NULL OR c.note IS NOT NULL);
        ELSE
            WITH expired AS (
                UPDATE health.safety_checkins c
                SET latitude = NULL, longitude = NULL, location = NULL, note = NULL
                WHERE c.occurred_at < NOW() - make_interval(days => v_days)
                  AND (c.latitude IS NOT NULL OR c.longitude IS NOT NULL
                       OR c.location IS NOT NULL OR c.note IS NOT NULL)
                RETURNING 1
            )
            SELECT COUNT(*)::INTEGER INTO v_count FROM expired;
        END IF;
        INSERT INTO health.retention_runs (finished_at, dry_run, target_table, rows_affected)
        VALUES (NOW(), p_dry_run, 'health.safety_checkins', COALESCE(v_count, 0));
        RETURN QUERY SELECT 'health.safety_checkins'::TEXT, COALESCE(v_count, 0);
    END IF;

    -- Expired consents are marked so the decision log shows why access stopped.
    IF NOT p_dry_run THEN
        INSERT INTO health.consent_decisions (person_id, purpose_code, action)
        SELECT c.person_id, c.purpose_code, 'EXPIRE'
        FROM health.health_consents c
        WHERE c.withdrawn_at IS NULL
          AND c.expires_at <= NOW()
          AND NOT EXISTS (
              SELECT 1 FROM health.consent_decisions d
              WHERE d.person_id = c.person_id
                AND d.purpose_code = c.purpose_code
                AND d.action = 'EXPIRE'
                AND d.decided_at >= c.expires_at
          );
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION health.fn_apply_retention(BOOLEAN) IS
    'Erases expired special-category payloads column by column. Never touches health.audit_log. Re-runnable; pass TRUE to count without changing anything.';

-- ============================================================
-- 6. DATA-SUBJECT REQUESTS (DPDP ss.11-13)
-- ============================================================
-- The statutory deadline is stored as a real column so it can be indexed and
-- reported on. 30 days is the working commitment used here; DPDP leaves the
-- period to the Rules, so widening it is a data change, not a code change.

CREATE TABLE IF NOT EXISTS health.data_subject_requests (
    request_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id) ON DELETE CASCADE,
    request_type TEXT NOT NULL
        CHECK (request_type IN ('ACCESS', 'CORRECTION', 'ERASURE', 'PORTABILITY')),
    -- No free-text description column: a rights request does not need the
    -- subject to restate their health information in order to be honoured.
    scope TEXT NOT NULL DEFAULT 'CARE_MODULE',
    status TEXT NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN ('RECEIVED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'COMPLETED', 'REFUSED', 'WITHDRAWN')),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    statutory_deadline TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    -- Erasure needs a second party: the subject cannot approve their own.
    approved_by_person_id UUID REFERENCES health.persons(logical_id),
    approved_at TIMESTAMPTZ,
    resolution TEXT
        CHECK (resolution IS NULL OR resolution IN
            ('EXPORTED', 'CORRECTED', 'PAYLOAD_ERASED', 'REFUSED_LEGAL_HOLD', 'REFUSED_NOT_SUBJECT', 'WITHDRAWN')),
    resolved_at TIMESTAMPTZ,
    rows_affected INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (approved_by_person_id IS NULL OR approved_by_person_id <> person_id),
    CHECK ((approved_by_person_id IS NULL) = (approved_at IS NULL)),
    CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_dsr_person
    ON health.data_subject_requests (person_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_dsr_open_deadline
    ON health.data_subject_requests (statutory_deadline)
    WHERE status IN ('RECEIVED', 'IN_PROGRESS', 'AWAITING_APPROVAL');

-- Erase one person's health payload on an approved erasure request. Row shells
-- and health.audit_log survive; consent is withdrawn so nothing is re-collected
-- silently. Returns the number of payloads destroyed.
CREATE OR REPLACE FUNCTION health.fn_erase_person_health_payload(
    p_person_id UUID,
    p_request_id UUID
) RETURNS INTEGER AS $$
DECLARE
    v_total INTEGER := 0;
    v_count INTEGER := 0;
    v_ok BOOLEAN;
BEGIN
    SELECT (r.status = 'AWAITING_APPROVAL'
            AND r.request_type = 'ERASURE'
            AND r.approved_by_person_id IS NOT NULL
            AND r.approved_by_person_id <> r.person_id
            AND r.person_id = p_person_id)
    INTO v_ok
    FROM health.data_subject_requests r
    WHERE r.request_id = p_request_id;

    IF COALESCE(v_ok, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION 'Erasure request % is not an approved erasure for person %', p_request_id, p_person_id
            USING ERRCODE = 'check_violation';
    END IF;

    WITH e AS (
        UPDATE health.advisor_queries
        SET question = '', reply = '', matched_topic_ids = '{}'
        WHERE person_id = p_person_id AND (question <> '' OR reply <> '')
        RETURNING 1
    ) SELECT COUNT(*)::INTEGER INTO v_count FROM e;
    v_total := v_total + COALESCE(v_count, 0);

    WITH e AS (
        UPDATE health.safety_checkins
        SET latitude = NULL, longitude = NULL, location = NULL, note = NULL
        WHERE person_id = p_person_id
          AND (latitude IS NOT NULL OR longitude IS NOT NULL
               OR location IS NOT NULL OR note IS NOT NULL)
        RETURNING 1
    ) SELECT COUNT(*)::INTEGER INTO v_count FROM e;
    v_total := v_total + COALESCE(v_count, 0);

    WITH e AS (
        UPDATE health.health_consents
        SET withdrawn_at = NOW()
        WHERE person_id = p_person_id AND withdrawn_at IS NULL
        RETURNING purpose_code
    )
    INSERT INTO health.consent_decisions (person_id, purpose_code, action, actor_person_id)
    SELECT p_person_id, e.purpose_code, 'WITHDRAW', p_person_id FROM e;

    UPDATE health.data_subject_requests
    SET status = 'COMPLETED',
        resolution = 'PAYLOAD_ERASED',
        resolved_at = NOW(),
        rows_affected = v_total
    WHERE request_id = p_request_id;

    RETURN v_total;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE health.data_subject_requests IS
    'Register of access/correction/erasure/portability requests with a statutory deadline. Erasure requires a second-party approver.';

-- ============================================================
-- 7. ROW-LEVEL SECURITY — subject plus a named clinical role
-- ============================================================
-- 033 enables RLS across the schema; this section states the rule for every
-- table that holds health data, including the ones added above.
-- The rule is deliberately NOT "any privileged role": general HR holding
-- hr_generalist or leadership does not satisfy it. Only the data subject and an
-- explicitly named clinical/occupational-health role match.

-- 033 owns health.fn_current_person() and health.fn_has_role(text). If this
-- migration is ever applied without it, define FAIL-CLOSED stubs rather than
-- error out: fn_current_person() returning NULL and fn_has_role() returning
-- FALSE make every policy below deny, which is the safe direction.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'health' AND p.proname = 'fn_current_person'
    ) THEN
        EXECUTE $fn$CREATE FUNCTION health.fn_current_person() RETURNS UUID AS
                    $body$ SELECT NULLIF(current_setting('hrms.person_id', TRUE), '')::UUID $body$
                    LANGUAGE sql STABLE$fn$;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'health' AND p.proname = 'fn_has_role'
    ) THEN
        EXECUTE $fn$CREATE FUNCTION health.fn_has_role(p_role TEXT) RETURNS BOOLEAN AS
                    $body$ SELECT FALSE $body$
                    LANGUAGE sql STABLE$fn$;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION health.fn_is_clinical_role()
RETURNS BOOLEAN AS $$
    SELECT COALESCE(health.fn_has_role('care_clinician'), FALSE)
        OR COALESCE(health.fn_has_role('occupational_health'), FALSE);
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
    t TEXT;
    v_tables TEXT[] := ARRAY[
        'advisor_queries',
        'safety_checkins',
        'health_consents',
        'consent_decisions',
        'parental_consent_verifications',
        'data_subject_requests'
    ];
    v_subject_col TEXT;
BEGIN
    FOREACH t IN ARRAY v_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'health' AND tablename = t
        ) THEN
            CONTINUE;
        END IF;

        v_subject_col := CASE t
            WHEN 'parental_consent_verifications' THEN 'minor_person_id'
            ELSE 'person_id'
        END;

        EXECUTE format('ALTER TABLE health.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE health.%I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON health.%I', t || '_subject_or_clinical', t);
        EXECUTE format(
            'CREATE POLICY %I ON health.%I FOR ALL '
            || 'USING (%I = health.fn_current_person() OR health.fn_is_clinical_role()) '
            || 'WITH CHECK (%I = health.fn_current_person() OR health.fn_is_clinical_role())',
            t || '_subject_or_clinical', t, v_subject_col, v_subject_col
        );
    END LOOP;
END $$;

-- Legacy consent tables from 022 keep the same rule so nothing reads around it.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['consent_preferences', 'consent_events'] LOOP
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'health' AND tablename = t) THEN
            EXECUTE format('ALTER TABLE health.%I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('DROP POLICY IF EXISTS %I ON health.%I', t || '_subject_or_clinical', t);
            EXECUTE format(
                'CREATE POLICY %I ON health.%I FOR ALL '
                || 'USING (person_id = health.fn_current_person() OR health.fn_is_clinical_role()) '
                || 'WITH CHECK (person_id = health.fn_current_person() OR health.fn_is_clinical_role())',
                t || '_subject_or_clinical', t
            );
        END IF;
    END LOOP;
END $$;

-- Retention machinery is operational metadata, not health data: readable by the
-- clinical role only, and never carrying a payload.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'health' AND tablename = 'retention_runs') THEN
        ALTER TABLE health.retention_runs ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS retention_runs_clinical ON health.retention_runs;
        CREATE POLICY retention_runs_clinical ON health.retention_runs
            FOR ALL USING (health.fn_is_clinical_role()) WITH CHECK (health.fn_is_clinical_role());
    END IF;
END $$;

-- ============================================================
-- 8. GRANTS — guarded on the role existing
-- ============================================================

DO $$
DECLARE
    g TEXT;
BEGIN
    FOREACH g IN ARRAY ARRAY['hrms_app', 'app_service'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) THEN
            EXECUTE format('GRANT USAGE ON SCHEMA health TO %I', g);
            EXECUTE format('GRANT SELECT ON health.processing_purposes TO %I', g);
            EXECUTE format('GRANT SELECT ON health.retention_policies TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.health_consents TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT ON health.consent_decisions TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.parental_consent_verifications TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.data_subject_requests TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT ON health.retention_runs TO %I', g);
            -- Payload erasure needs UPDATE on the payload-bearing tables.
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.advisor_queries TO %I', g);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.safety_checkins TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_person_is_minor(UUID, TEXT) TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_has_parental_consent(UUID) TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_has_valid_consent(UUID, TEXT, TEXT) TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_is_clinical_role() TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_apply_retention(BOOLEAN) TO %I', g);
            EXECUTE format('GRANT EXECUTE ON FUNCTION health.fn_erase_person_health_payload(UUID, UUID) TO %I', g);
            -- No DELETE anywhere: disposal is an UPDATE that keeps the shell so
            -- the audit trail stays resolvable.
        END IF;
    END LOOP;
END $$;

-- ============================================================
-- 9. STANDING DOCUMENTATION
-- ============================================================

COMMENT ON COLUMN health.advisor_queries.question IS
    'Employee-authored health free text. SPECIAL CATEGORY. STORED IN PLAINTEXT — not encrypted at rest. Purpose CARE_ADVISORY_HISTORY; erased by health.fn_apply_retention().';
COMMENT ON COLUMN health.advisor_queries.reply IS
    'Generated reply text, may restate the employee''s wellbeing state. SPECIAL CATEGORY. STORED IN PLAINTEXT — not encrypted at rest.';
COMMENT ON COLUMN health.safety_checkins.note IS
    'Employee-authored free text. STORED IN PLAINTEXT — not encrypted at rest. Purpose SAFETY_CHECKIN.';

-- KEY ROTATION: there is nothing to rotate, because nothing is encrypted. When
-- encryption is implemented, it needs (a) pgcrypto, (b) a key id column beside
-- every ciphertext column, (c) the key supplied per session by the pool rather
-- than inline in statements, and (d) a rotation job that re-encrypts under the
-- new key id. Anything less is decoration.

-- END OF MIGRATION 036

-- Migration 039: Tamper-evident, append-only audit trail
-- Applied: after 033 (row-level security helpers) — forward-only, never edit 001-030.
--
-- Description:
--   health.audit_log was an ordinary table: any role with UPDATE or DELETE could
--   rewrite or erase history, and nothing about a row proved it had not been
--   changed. This migration makes the trail genuinely append-only and verifiable:
--
--     1. chain columns (chain_seq, prev_hash, row_hash) + a SHA-256 hash chain
--        computed by a BEFORE INSERT trigger, so any edit or deletion anywhere in
--        the range breaks verification;
--     2. a BEFORE UPDATE OR DELETE trigger that rejects both, with exactly two
--        narrow exceptions (filling the chain on pre-existing rows, and a sealed
--        retention purge of rows that have already been archived);
--     3. health.fn_verify_audit_chain(from, to) returning the first broken row;
--     4. row-level security: a person may read audit rows about themselves;
--        hr_admin / senior_admin / auditor may read broadly; nobody may UPDATE
--        or DELETE;
--     5. retention that ARCHIVES by default and only ever purges rows that are
--        provably archived, recording a chain seal for the purged range.
--
--   Every statement is idempotent: runMigrations() re-applies this file on every
--   boot.
--
-- WARNING: the hash chain serialises audit inserts (one advisory lock per
--   transaction that appends). Write audit rows at the END of a handler and never
--   hold the audit lock across slow work.

-- ============================================================
-- 1. CHAIN COLUMNS AND SEQUENCE (idempotent)
-- ============================================================
ALTER TABLE health.audit_log ADD COLUMN IF NOT EXISTS chain_seq BIGINT;
ALTER TABLE health.audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE health.audit_log ADD COLUMN IF NOT EXISTS row_hash TEXT;

CREATE SEQUENCE IF NOT EXISTS health.audit_log_chain_seq AS BIGINT START 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_chain_seq ON health.audit_log (chain_seq);
CREATE INDEX IF NOT EXISTS idx_audit_log_unchained ON health.audit_log (created_at) WHERE row_hash IS NULL;

COMMENT ON COLUMN health.audit_log.chain_seq IS 'Monotonic append order. Gaps are legal (aborted transactions); reordering is not.';
COMMENT ON COLUMN health.audit_log.prev_hash IS 'row_hash of the preceding audit row; 64 zeroes for the genesis row.';
COMMENT ON COLUMN health.audit_log.row_hash IS 'SHA-256 over this row''s canonical content plus prev_hash.';

-- ============================================================
-- 2. ARCHIVE AND SEAL TABLES (retention destination; referenced by the
--    immutability trigger, so they must exist before it)
-- ============================================================
CREATE TABLE IF NOT EXISTS health.audit_log_archive (
    log_id UUID PRIMARY KEY,
    chain_seq BIGINT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID,
    person_id UUID NOT NULL,
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    prev_hash TEXT,
    row_hash TEXT,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_created ON health.audit_log_archive (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_archive_person ON health.audit_log_archive (person_id, created_at DESC);

CREATE TABLE IF NOT EXISTS health.audit_log_chain_seal (
    seal_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sealed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retention_days INTEGER NOT NULL,
    cutoff TIMESTAMPTZ NOT NULL,
    purged_from TIMESTAMPTZ,
    purged_to TIMESTAMPTZ,
    first_chain_seq BIGINT,
    last_chain_seq BIGINT,
    last_row_hash TEXT,
    rows_purged BIGINT NOT NULL DEFAULT 0,
    note TEXT
);

COMMENT ON TABLE health.audit_log_archive IS 'Archived audit rows. Retention copies here first; a purge may only remove rows that are provably archived.';
COMMENT ON TABLE health.audit_log_chain_seal IS 'One row per retention purge: the chain range removed and the last hash before removal, so the surviving chain stays anchored.';

-- ============================================================
-- 3. CANONICAL CONTENT AND ROW HASH
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_canonical(
    p_chain_seq BIGINT,
    p_log_id UUID,
    p_action TEXT,
    p_target_type TEXT,
    p_target_id UUID,
    p_person_id UUID,
    p_details JSONB,
    p_ip INET,
    p_user_agent TEXT,
    p_created_at TIMESTAMPTZ,
    p_prev_hash TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    -- Unit separator between fields so content cannot be shuffled between them.
    -- jsonb::text is canonical (sorted keys, normalised numbers), and the
    -- timestamp is rendered in UTC to microsecond precision.
    SELECT concat_ws(
        chr(31),
        COALESCE(p_chain_seq::TEXT, ''),
        COALESCE(p_log_id::TEXT, ''),
        COALESCE(p_action, ''),
        COALESCE(p_target_type, ''),
        COALESCE(p_target_id::TEXT, ''),
        COALESCE(p_person_id::TEXT, ''),
        COALESCE(p_details::TEXT, ''),
        COALESCE(host(p_ip), ''),
        COALESCE(p_user_agent, ''),
        COALESCE(to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), ''),
        COALESCE(p_prev_hash, '')
    );
$$;

CREATE OR REPLACE FUNCTION health.fn_audit_row_hash(
    p_chain_seq BIGINT,
    p_log_id UUID,
    p_action TEXT,
    p_target_type TEXT,
    p_target_id UUID,
    p_person_id UUID,
    p_details JSONB,
    p_ip INET,
    p_user_agent TEXT,
    p_created_at TIMESTAMPTZ,
    p_prev_hash TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT encode(
        sha256(convert_to(health.fn_audit_canonical(
            p_chain_seq, p_log_id, p_action, p_target_type, p_target_id, p_person_id,
            p_details, p_ip, p_user_agent, p_created_at, p_prev_hash
        ), 'UTF8')),
        'hex'
    );
$$;

-- ============================================================
-- 4. BACKFILL EXISTING ROWS (safe to re-run: only touches row_hash IS NULL)
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_chain_backfill()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    r         RECORD;
    v_prev    TEXT;
    v_seq     BIGINT;
    v_hash    TEXT;
    v_count   BIGINT := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('health.audit_log.chain')::BIGINT);

    SELECT a.row_hash INTO v_prev
      FROM health.audit_log a
     WHERE a.row_hash IS NOT NULL
     ORDER BY a.chain_seq DESC
     LIMIT 1;

    FOR r IN
        SELECT a.* FROM health.audit_log a WHERE a.row_hash IS NULL ORDER BY a.created_at, a.log_id
    LOOP
        v_seq := nextval('health.audit_log_chain_seq');
        v_prev := COALESCE(v_prev, repeat('0', 64));
        v_hash := health.fn_audit_row_hash(
            v_seq, r.log_id, r.action, r.target_type, r.target_id, r.person_id,
            r.details, r.ip_address, r.user_agent, r.created_at, v_prev
        );
        UPDATE health.audit_log
           SET chain_seq = v_seq, prev_hash = v_prev, row_hash = v_hash
         WHERE log_id = r.log_id;
        v_prev := v_hash;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

SELECT health.fn_audit_chain_backfill();

-- ============================================================
-- 5. HASH CHAIN ON INSERT
--
-- SECURITY DEFINER is required: the trigger must read the newest existing row to
-- find its predecessor, and under row-level security a request-scoped role would
-- only see its own rows, which would silently fork the chain.
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_chain_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_prev TEXT;
BEGIN
    -- Serialise appends: two concurrent inserts must not claim the same predecessor.
    PERFORM pg_advisory_xact_lock(hashtext('health.audit_log.chain')::BIGINT);

    IF NEW.log_id IS NULL THEN
        NEW.log_id := uuid_generate_v4();
    END IF;
    IF NEW.created_at IS NULL THEN
        NEW.created_at := NOW();
    END IF;

    NEW.chain_seq := nextval('health.audit_log_chain_seq');

    SELECT a.row_hash INTO v_prev
      FROM health.audit_log a
     WHERE a.row_hash IS NOT NULL
     ORDER BY a.chain_seq DESC
     LIMIT 1;

    NEW.prev_hash := COALESCE(v_prev, repeat('0', 64));
    NEW.row_hash := health.fn_audit_row_hash(
        NEW.chain_seq, NEW.log_id, NEW.action, NEW.target_type, NEW.target_id, NEW.person_id,
        NEW.details, NEW.ip_address, NEW.user_agent, NEW.created_at, NEW.prev_hash
    );
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'tr_audit_log_chain'
           AND tgrelid = 'health.audit_log'::regclass
    ) THEN
        CREATE TRIGGER tr_audit_log_chain
        BEFORE INSERT ON health.audit_log
        FOR EACH ROW EXECUTE FUNCTION health.fn_audit_log_chain_before_insert();
    END IF;
END $$;

-- ============================================================
-- 6. APPEND-ONLY ENFORCEMENT
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- The only permitted deletion is a sealed retention purge of a row that
        -- has already been archived byte-for-byte (same row_hash).
        IF COALESCE(current_setting('audit.purge_seal_id', TRUE), '') <> ''
           AND EXISTS (
               SELECT 1 FROM health.audit_log_archive x
                WHERE x.log_id = OLD.log_id
                  AND x.row_hash IS NOT DISTINCT FROM OLD.row_hash
           )
        THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'health.audit_log is append-only: DELETE rejected (log_id=%)', OLD.log_id
            USING ERRCODE = '42501';
    END IF;

    -- The only permitted update is filling the hash chain on a row written
    -- before the chain existed. Content must be identical.
    IF OLD.row_hash IS NULL
       AND NEW.row_hash IS NOT NULL
       AND NEW.log_id = OLD.log_id
       AND NEW.action = OLD.action
       AND NEW.target_type = OLD.target_type
       AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
       AND NEW.person_id = OLD.person_id
       AND NEW.details IS NOT DISTINCT FROM OLD.details
       AND NEW.ip_address IS NOT DISTINCT FROM OLD.ip_address
       AND NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent
       AND NEW.created_at = OLD.created_at
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'health.audit_log is append-only: UPDATE rejected (log_id=%)', OLD.log_id
        USING ERRCODE = '42501';
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'tr_audit_log_append_only'
           AND tgrelid = 'health.audit_log'::regclass
    ) THEN
        CREATE TRIGGER tr_audit_log_append_only
        BEFORE UPDATE OR DELETE ON health.audit_log
        FOR EACH ROW EXECUTE FUNCTION health.fn_audit_log_append_only();
    END IF;
END $$;

-- Block TRUNCATE as well: it bypasses row triggers entirely.
CREATE OR REPLACE FUNCTION health.fn_audit_log_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'health.audit_log is append-only: TRUNCATE rejected'
        USING ERRCODE = '42501';
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'tr_audit_log_no_truncate'
           AND tgrelid = 'health.audit_log'::regclass
    ) THEN
        CREATE TRIGGER tr_audit_log_no_truncate
        BEFORE TRUNCATE ON health.audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION health.fn_audit_log_no_truncate();
    END IF;
END $$;

-- ============================================================
-- 7. VERIFICATION — returns the first broken row, or one OK row
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_verify_audit_chain(
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
    is_valid BOOLEAN,
    broken_log_id UUID,
    broken_chain_seq BIGINT,
    broken_created_at TIMESTAMPTZ,
    reason TEXT,
    rows_checked BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    r          RECORD;
    v_prev     TEXT := NULL;
    v_hash     TEXT;
    v_checked  BIGINT := 0;
BEGIN
    FOR r IN
        SELECT a.* FROM health.audit_log a
         WHERE (p_from IS NULL OR a.created_at >= p_from)
           AND (p_to IS NULL OR a.created_at <= p_to)
         ORDER BY a.chain_seq NULLS FIRST
    LOOP
        v_checked := v_checked + 1;

        IF r.row_hash IS NULL OR r.chain_seq IS NULL THEN
            RETURN QUERY SELECT FALSE, r.log_id, r.chain_seq, r.created_at,
                'UNCHAINED_ROW: chain columns missing; run health.fn_audit_chain_backfill()'::TEXT, v_checked;
            RETURN;
        END IF;

        v_hash := health.fn_audit_row_hash(
            r.chain_seq, r.log_id, r.action, r.target_type, r.target_id, r.person_id,
            r.details, r.ip_address, r.user_agent, r.created_at, r.prev_hash
        );

        IF v_hash IS DISTINCT FROM r.row_hash THEN
            RETURN QUERY SELECT FALSE, r.log_id, r.chain_seq, r.created_at,
                'CONTENT_MODIFIED: stored row_hash does not match row content'::TEXT, v_checked;
            RETURN;
        END IF;

        IF v_prev IS NOT NULL AND r.prev_hash IS DISTINCT FROM v_prev THEN
            RETURN QUERY SELECT FALSE, r.log_id, r.chain_seq, r.created_at,
                'CHAIN_BROKEN: predecessor deleted or reordered (check health.audit_log_chain_seal for a sealed purge)'::TEXT,
                v_checked;
            RETURN;
        END IF;

        v_prev := r.row_hash;
    END LOOP;

    RETURN QUERY SELECT TRUE, NULL::UUID, NULL::BIGINT, NULL::TIMESTAMPTZ, 'OK'::TEXT, v_checked;
END;
$$;

COMMENT ON FUNCTION health.fn_verify_audit_chain(TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Recomputes the audit hash chain over [p_from, p_to] and returns the first broken row, or is_valid = true.';

-- ============================================================
-- 8. RETENTION — archive by default, purge only what is provably archived
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_audit_retention_archive(
    p_retention_days INTEGER DEFAULT 2555,
    p_batch_limit INTEGER DEFAULT 50000
)
RETURNS TABLE (rows_archived BIGINT, cutoff_at TIMESTAMPTZ, days_kept INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_days    INTEGER := GREATEST(COALESCE(p_retention_days, 2555), 1);
    v_cutoff  TIMESTAMPTZ;
    v_rows    BIGINT := 0;
BEGIN
    v_cutoff := NOW() - make_interval(days => v_days);

    WITH candidates AS (
        SELECT a.* FROM health.audit_log a
         WHERE a.created_at < v_cutoff
         ORDER BY a.chain_seq
         LIMIT GREATEST(COALESCE(p_batch_limit, 50000), 1)
    ),
    moved AS (
        INSERT INTO health.audit_log_archive (
            log_id, chain_seq, action, target_type, target_id, person_id, details,
            ip_address, user_agent, created_at, prev_hash, row_hash
        )
        SELECT c.log_id, c.chain_seq, c.action, c.target_type, c.target_id, c.person_id, c.details,
               c.ip_address, c.user_agent, c.created_at, c.prev_hash, c.row_hash
          FROM candidates c
        ON CONFLICT (log_id) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO v_rows FROM moved;

    RETURN QUERY SELECT v_rows, v_cutoff, v_days;
END;
$$;

COMMENT ON FUNCTION health.fn_audit_retention_archive(INTEGER, INTEGER) IS
    'Copies audit rows older than AUDIT_LOG_RETENTION_DAYS into health.audit_log_archive. Never deletes anything.';

CREATE OR REPLACE FUNCTION health.fn_audit_retention_purge(
    p_retention_days INTEGER DEFAULT 2555,
    p_batch_limit INTEGER DEFAULT 50000
)
RETURNS TABLE (rows_purged BIGINT, cutoff_at TIMESTAMPTZ, seal UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_days     INTEGER := GREATEST(COALESCE(p_retention_days, 2555), 1);
    v_cutoff   TIMESTAMPTZ;
    v_seal     UUID;
    v_rows     BIGINT := 0;
    v_first    BIGINT;
    v_last     BIGINT;
    v_from     TIMESTAMPTZ;
    v_to       TIMESTAMPTZ;
    v_lasthash TEXT;
BEGIN
    v_cutoff := NOW() - make_interval(days => v_days);

    -- Archive first: nothing is ever destroyed without a copy.
    PERFORM health.fn_audit_retention_archive(v_days, p_batch_limit);

    SELECT min(a.chain_seq), max(a.chain_seq), min(a.created_at), max(a.created_at)
      INTO v_first, v_last, v_from, v_to
      FROM health.audit_log a
     WHERE a.created_at < v_cutoff
       AND EXISTS (
           SELECT 1 FROM health.audit_log_archive x
            WHERE x.log_id = a.log_id AND x.row_hash IS NOT DISTINCT FROM a.row_hash
       );

    IF v_last IS NULL THEN
        RETURN QUERY SELECT 0::BIGINT, v_cutoff, NULL::UUID;
        RETURN;
    END IF;

    SELECT a.row_hash INTO v_lasthash FROM health.audit_log a WHERE a.chain_seq = v_last;

    INSERT INTO health.audit_log_chain_seal (
        retention_days, cutoff, purged_from, purged_to, first_chain_seq, last_chain_seq, last_row_hash, note
    ) VALUES (
        v_days, v_cutoff, v_from, v_to, v_first, v_last, v_lasthash,
        'Retention purge: rows archived in health.audit_log_archive before removal.'
    )
    RETURNING seal_id INTO v_seal;

    -- Authorise the append-only trigger for this transaction only.
    PERFORM set_config('audit.purge_seal_id', v_seal::TEXT, TRUE);

    WITH gone AS (
        DELETE FROM health.audit_log a
         WHERE a.created_at < v_cutoff
           AND EXISTS (
               SELECT 1 FROM health.audit_log_archive x
                WHERE x.log_id = a.log_id AND x.row_hash IS NOT DISTINCT FROM a.row_hash
           )
        RETURNING 1
    )
    SELECT count(*) INTO v_rows FROM gone;

    PERFORM set_config('audit.purge_seal_id', '', TRUE);

    UPDATE health.audit_log_chain_seal s SET rows_purged = v_rows WHERE s.seal_id = v_seal;

    RETURN QUERY SELECT v_rows, v_cutoff, v_seal;
END;
$$;

COMMENT ON FUNCTION health.fn_audit_retention_purge(INTEGER, INTEGER) IS
    'Operator-only. Archives, seals the chain range, then deletes only rows whose archived copy matches. Not granted to the application role.';

-- ============================================================
-- 9. SCHEDULER REGISTRATION for the archive-only pass
-- ============================================================
INSERT INTO health.scheduler_jobs (job_name, schedule_cron, description, enabled, last_status)
VALUES ('audit_retention_archive', '15 4 * * *',
        'Archive audit rows older than AUDIT_LOG_RETENTION_DAYS (archive only, never deletes)',
        TRUE, 'NEVER_RUN')
ON CONFLICT (job_name) DO NOTHING;

-- ============================================================
-- 10. ROW-LEVEL SECURITY
--
-- Enabled only when the 033 helpers exist, because enabling RLS without policies
-- would deny every non-owner role and take the audit writer (now fail-closed)
-- down with it.
-- ============================================================
DO $$
DECLARE
    v_has_helpers BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'health' AND p.proname = 'fn_current_person'
    ) AND EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'health' AND p.proname = 'fn_has_role'
    ) INTO v_has_helpers;

    IF NOT v_has_helpers THEN
        RAISE WARNING 'migration 039: health.fn_current_person()/fn_has_role() not found — audit_log RLS NOT enabled. Re-run migrations after 033.';
        RETURN;
    END IF;

    -- Policies are created BEFORE row-level security is switched on. A policy is
    -- inert until then, so a failure here can never leave the table with RLS
    -- enabled and no policy — which would deny every non-owner role and, with a
    -- fail-closed audit writer, take the whole application down.
    --
    -- Read: rows about me, or a broad-read role. There is deliberately no UPDATE
    -- or DELETE policy, so no non-owner role can change or remove an audit row.
    EXECUTE 'DROP POLICY IF EXISTS audit_log_select_self_or_privileged ON health.audit_log';
    EXECUTE $p$
        CREATE POLICY audit_log_select_self_or_privileged ON health.audit_log
        FOR SELECT
        USING (
            person_id = health.fn_current_person()::uuid
            OR target_id = health.fn_current_person()::uuid
            OR health.fn_has_role('hr_admin')
            OR health.fn_has_role('senior_admin')
            OR health.fn_has_role('auditor')
        )
    $p$;

    -- Append: any context may add a row. The writer sets person_id from the
    -- request context, and an audit row must never be refused because of who it
    -- is about — an unwritable audit row now aborts the operation it records.
    EXECUTE 'DROP POLICY IF EXISTS audit_log_insert_append_only ON health.audit_log';
    EXECUTE 'CREATE POLICY audit_log_insert_append_only ON health.audit_log FOR INSERT WITH CHECK (true)';

    EXECUTE 'DROP POLICY IF EXISTS audit_archive_select_self_or_privileged ON health.audit_log_archive';
    EXECUTE $p$
        CREATE POLICY audit_archive_select_self_or_privileged ON health.audit_log_archive
        FOR SELECT
        USING (
            person_id = health.fn_current_person()::uuid
            OR target_id = health.fn_current_person()::uuid
            OR health.fn_has_role('hr_admin')
            OR health.fn_has_role('senior_admin')
            OR health.fn_has_role('auditor')
        )
    $p$;

    EXECUTE 'ALTER TABLE health.audit_log ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE health.audit_log_archive ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN OTHERS THEN
    -- Rolls back this block only: policies and the ENABLE are undone together.
    RAISE WARNING 'migration 039: audit_log RLS not applied (%). Table left without RLS rather than unreadable.', SQLERRM;
END $$;

-- ============================================================
-- 11. GRANTS — INSERT and SELECT only; never UPDATE or DELETE
-- ============================================================
DO $$
BEGIN
    -- The retention purge and the backfill are operator tools, not app surface.
    REVOKE ALL ON FUNCTION health.fn_audit_retention_purge(INTEGER, INTEGER) FROM PUBLIC;
    REVOKE ALL ON FUNCTION health.fn_audit_chain_backfill() FROM PUBLIC;
    REVOKE ALL ON FUNCTION health.fn_verify_audit_chain(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION health.fn_audit_retention_archive(INTEGER, INTEGER) FROM PUBLIC;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
        GRANT USAGE ON SCHEMA health TO hrms_app;
        GRANT SELECT, INSERT ON health.audit_log TO hrms_app;
        REVOKE UPDATE, DELETE, TRUNCATE ON health.audit_log FROM hrms_app;
        GRANT SELECT ON health.audit_log_archive TO hrms_app;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON health.audit_log_archive FROM hrms_app;
        GRANT SELECT ON health.audit_log_chain_seal TO hrms_app;
        GRANT USAGE, SELECT ON SEQUENCE health.audit_log_chain_seq TO hrms_app;
        GRANT EXECUTE ON FUNCTION health.fn_verify_audit_chain(TIMESTAMPTZ, TIMESTAMPTZ) TO hrms_app;
        GRANT EXECUTE ON FUNCTION health.fn_audit_retention_archive(INTEGER, INTEGER) TO hrms_app;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_service') THEN
        GRANT SELECT, INSERT ON health.audit_log TO app_service;
        REVOKE UPDATE, DELETE, TRUNCATE ON health.audit_log FROM app_service;
        GRANT SELECT ON health.audit_log_archive TO app_service;
        GRANT SELECT ON health.audit_log_chain_seal TO app_service;
        GRANT USAGE, SELECT ON SEQUENCE health.audit_log_chain_seq TO app_service;
        GRANT EXECUTE ON FUNCTION health.fn_verify_audit_chain(TIMESTAMPTZ, TIMESTAMPTZ) TO app_service;
        GRANT EXECUTE ON FUNCTION health.fn_audit_retention_archive(INTEGER, INTEGER) TO app_service;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerbos') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON health.audit_log FROM cerbos;
    END IF;
EXCEPTION WHEN undefined_function OR undefined_object THEN
    RAISE WARNING 'migration 039: some audit grants were skipped (%).', SQLERRM;
END $$;

-- Migration 002 left health.fn_audit_log_action() SECURITY DEFINER and executable
-- by PUBLIC: any role with schema access could forge an audit row attributed to
-- any person. Nothing in the application calls it. Isolated in its own block so a
-- signature change cannot skip the grants above.
DO $$
BEGIN
    REVOKE ALL ON FUNCTION health.fn_audit_log_action(TEXT, TEXT, UUID, UUID, JSONB) FROM PUBLIC;
EXCEPTION WHEN undefined_function OR undefined_object THEN
    RAISE WARNING 'migration 039: health.fn_audit_log_action() not revoked (%).', SQLERRM;
END $$;

COMMENT ON TABLE health.audit_log IS
    'Append-only, hash-chained audit trail. UPDATE/DELETE/TRUNCATE are rejected by trigger; verify with health.fn_verify_audit_chain().';

-- ============================================================
-- END OF MIGRATION 039
-- ============================================================

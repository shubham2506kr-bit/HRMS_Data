-- Migration 034: Schema integrity repairs
--
-- WHAT THIS FILE ASSUMES
--   * The live database was built BY HAND. migrations 001-030 were never
--     executed by the application (the runner pointed at a directory that did
--     not exist), so the catalog may not match what those files say. Every
--     statement below is therefore guarded on the ACTUAL catalog state
--     (pg_constraint / pg_class / pg_index / pg_proc / pg_attribute) and never
--     assumes an object exists or does not exist.
--   * Runs AFTER 033_rls_and_grants.sql. health.fn_current_person() and
--     health.fn_has_role(text) exist by now but are deliberately NOT referenced:
--     nothing here needs a caller identity.
--   * Runs AFTER 017 (user_accounts.username/password_hash), AFTER 018
--     (employments.salary_monthly) and AFTER 032 (leave_requests overlap
--     constraint, health.fn_working_days).
--   * Forward-only. Nothing in 001-030 is edited. No object is dropped that
--     could hold data; only indexes and over-strict constraints are replaced.
--   * Fully idempotent and re-runnable: IF NOT EXISTS / CREATE OR REPLACE /
--     catalog-guarded DO blocks throughout. Re-running is a no-op.
--
-- WHAT THIS FILE CHANGES
--   1. health.user_accounts — reconciles the ONE authoritative shape. 001
--      declares this table twice (lines 42 and 221); the second CREATE TABLE
--      would abort the file. The two bodies list the same seven columns, so the
--      authoritative shape is that set plus 017's username/password_hash plus
--      037's four throttling columns. Columns are added with ADD COLUMN IF NOT
--      EXISTS, NOT NULL is only applied when no NULL rows exist, and NOTHING is
--      dropped. The four columns owned by migration 037 (failed_attempt_count,
--      last_failed_attempt_at, locked_until, must_reset_password) are
--      deliberately NOT touched here.
--   2. health.now_immutable() — stops being indexed. It is marked IMMUTABLE but
--      returns NOW(), so every partial index built on
--      "health.now_immutable() <@ system_period" was built against a frozen
--      instant. Postgres constant-folds the predicate at index build time, so
--      those indexes silently stop matching the rows they claim to cover and
--      "current" bitemporal reads quietly lose data. Every index in schema
--      health whose definition mentions now_immutable is located in the catalog
--      and dropped, then replaced with an equivalent index whose predicate is
--      genuinely immutable (or no predicate at all), plus a GiST index on
--      system_period so "system_period @> NOW()" is still index-assisted. The
--      two functions are then re-marked STABLE and commented as deprecated —
--      they are never dropped, because 005 defines now_immutable_date() on top
--      of now_immutable().
--   3. health temporal functions — the malformed '[])' range-bound literal in
--      002 (lines 165, 211 and 401: fn_position_new_version,
--      fn_reporting_line_new_version, fn_leave_request_new_version) is a syntax
--      error inside TSTZRANGE() and made those three functions raise at
--      runtime. All five versioning functions are recreated with half-open
--      '[)' bounds, byte-identical names / argument lists / return types.
--   4. Integrity constraints — non-negative money and counters, real
--      enumerated status values, and date ordering, added NOT VALID first and
--      VALIDATEd only when a guard query proves no existing row violates them,
--      so a populated table can never fail this migration.
--   5. GiST EXCLUDE constraints on the bitemporal core — departments,
--      positions, position_reporting_lines and employments all carry an
--      exclusion constraint over (key, valid_period) with no system_period
--      predicate, which makes bitemporal versioning structurally impossible: a
--      new system-period version of a logical row collides with its own
--      predecessor. Each is rewritten IN PLACE, keeping its existing name, with
--      "AND upper_inf(system_period)" added to the predicate. upper_inf() is
--      genuinely immutable, and the result is strictly weaker than the original,
--      so it cannot fail against existing rows.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   * No amount checks on health.payroll_entries (migration 031 owns those).
--   * No exclusion-constraint work on health.leave_requests (032 owns it, and
--     it is already correct: leave_requests_live_period_excl carries both a
--     status predicate and upper_inf(system_period)).
--   * No change to health.persons: it is NOT bitemporal (logical_id is a plain
--     primary key, there is no valid_period/system_period and no exclusion
--     constraint), so there is nothing of this class to repair there.
--   * No column is ever dropped, and no DELETE or destructive UPDATE is issued.

-- ============================================================
-- 0. PREREQUISITES (no-ops when already present)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS health;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================
-- 1. USER_ACCOUNTS — reconcile the duplicate 001 definition
--
-- 001_core_schema.sql declares health.user_accounts at line 42 AND again at
-- line 221. The second CREATE TABLE has no IF NOT EXISTS, so it aborts the
-- whole file — one of the reasons 001 was never executable. Both bodies list
-- the same seven columns, so there is no column-level disagreement to
-- arbitrate; the authoritative shape is that set, extended by 017
-- (username, password_hash) and 037 (the four throttling columns).
--
-- Columns the running code actually reads/writes, verified by grep:
--   backend/src/lib/auth.ts:58-60          person_id, idp_issuer, is_active
--   backend/src/modules/auth/routes.ts:120 logical_id, person_id,
--        password_hash, is_active, must_reset_password, failed_attempt_count,
--        locked_until, username (matched case-insensitively), updated_at,
--        last_failed_attempt_at
--   backend/src/modules/payroll/routes.ts:327  person_id
--
-- POSSIBLY VESTIGIAL — NOT DROPPED, reported instead: idp_subject_id is only
-- ever written by 017's seed ('local:<name>') and is read by nothing in the
-- backend; it survives only as half of the (idp_subject_id, idp_issuer) unique
-- key. created_at is likewise never read. Both are kept: dropping a NOT NULL
-- column that participates in a unique key is not a forward-only-safe move.
-- ============================================================

-- Create the table only if it is genuinely absent (hand-built database).
CREATE TABLE IF NOT EXISTS health.user_accounts (
    logical_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL,
    idp_subject_id TEXT NOT NULL,
    idp_issuer TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bring an existing (possibly hand-built) table up to the authoritative shape.
-- The four migration-037 columns are intentionally absent from this list.
ALTER TABLE health.user_accounts
    ADD COLUMN IF NOT EXISTS person_id      UUID,
    ADD COLUMN IF NOT EXISTS idp_subject_id TEXT,
    ADD COLUMN IF NOT EXISTS idp_issuer     TEXT,
    ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS username       TEXT,
    ADD COLUMN IF NOT EXISTS password_hash  TEXT,
    ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- NOT NULL only where a null is meaningless AND no existing row is null.
-- The guard means a populated table can never fail this migration; if a null
-- is present the statement is skipped and a NOTICE names the column.
DO $$
DECLARE
    c TEXT;
    v_nulls BIGINT;
BEGIN
    IF to_regclass('health.user_accounts') IS NULL THEN
        RETURN;
    END IF;

    FOREACH c IN ARRAY ARRAY['person_id', 'idp_subject_id', 'idp_issuer', 'is_active'] LOOP
        -- Only act when the column exists and is currently nullable.
        IF EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = 'health.user_accounts'::REGCLASS
              AND attname = c AND attnum > 0 AND NOT attisdropped AND NOT attnotnull
        ) THEN
            EXECUTE format('SELECT count(*) FROM health.user_accounts WHERE %I IS NULL', c)
                INTO v_nulls;
            IF v_nulls = 0 THEN
                EXECUTE format('ALTER TABLE health.user_accounts ALTER COLUMN %I SET NOT NULL', c);
            ELSE
                RAISE NOTICE 'user_accounts.%: % null row(s) present, SET NOT NULL skipped', c, v_nulls;
            END IF;
        END IF;
    END LOOP;
END $$;

-- Unique key on (idp_subject_id, idp_issuer). Located by COLUMN SET, not by
-- name, because a hand-built database will not have 001's generated name.
DO $$
DECLARE
    v_a1 SMALLINT;
    v_a2 SMALLINT;
    v_dups BIGINT;
BEGIN
    IF to_regclass('health.user_accounts') IS NULL THEN
        RETURN;
    END IF;

    SELECT attnum INTO v_a1 FROM pg_attribute
     WHERE attrelid = 'health.user_accounts'::REGCLASS AND attname = 'idp_subject_id'
       AND attnum > 0 AND NOT attisdropped;
    SELECT attnum INTO v_a2 FROM pg_attribute
     WHERE attrelid = 'health.user_accounts'::REGCLASS AND attname = 'idp_issuer'
       AND attnum > 0 AND NOT attisdropped;
    IF v_a1 IS NULL OR v_a2 IS NULL THEN
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'health.user_accounts'::REGCLASS
          AND contype IN ('u', 'p')
          AND conkey @> ARRAY[v_a1, v_a2] AND conkey <@ ARRAY[v_a1, v_a2]
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_index
        WHERE indrelid = 'health.user_accounts'::REGCLASS AND indisunique
          AND string_to_array(indkey::TEXT, ' ')::SMALLINT[] @> ARRAY[v_a1, v_a2]
          AND string_to_array(indkey::TEXT, ' ')::SMALLINT[] <@ ARRAY[v_a1, v_a2]
    ) THEN
        SELECT count(*) INTO v_dups FROM (
            SELECT 1 FROM health.user_accounts
             GROUP BY idp_subject_id, idp_issuer HAVING count(*) > 1
        ) d;
        IF v_dups = 0 THEN
            ALTER TABLE health.user_accounts
                ADD CONSTRAINT uq_user_accounts_idp UNIQUE (idp_subject_id, idp_issuer);
        ELSE
            RAISE NOTICE 'user_accounts: % duplicate (idp_subject_id, idp_issuer) group(s); unique key skipped', v_dups;
        END IF;
    END IF;
END $$;

-- Lookup index + the two unique indexes 017 relies on (its INSERT uses
-- ON CONFLICT (person_id), which needs uq_user_accounts_person to exist).
-- Both are guarded on the absence of duplicates so they cannot abort the run.
CREATE INDEX IF NOT EXISTS idx_user_accounts_person ON health.user_accounts (person_id);

DO $$
DECLARE
    v_dups BIGINT;
BEGIN
    IF to_regclass('health.user_accounts') IS NULL THEN
        RETURN;
    END IF;

    SELECT count(*) INTO v_dups FROM (
        SELECT 1 FROM health.user_accounts GROUP BY person_id HAVING count(*) > 1
    ) d;
    IF v_dups = 0 THEN
        CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_person
            ON health.user_accounts (person_id);
    ELSE
        RAISE NOTICE 'user_accounts: % person_id duplicate group(s); uq_user_accounts_person skipped (017 ON CONFLICT (person_id) will fail until resolved)', v_dups;
    END IF;

    -- CASE-INSENSITIVE username uniqueness. backend/src/modules/auth/routes.ts
    -- resolves an account with LOWER(ua.username) = LOWER($1), but 017 only
    -- creates a case-SENSITIVE unique index, so 'John' and 'john' can coexist
    -- and the login lookup then picks an arbitrary one of them.
    SELECT count(*) INTO v_dups FROM (
        SELECT 1 FROM health.user_accounts
         WHERE username IS NOT NULL
         GROUP BY LOWER(username) HAVING count(*) > 1
    ) d;
    IF v_dups = 0 THEN
        CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_username_lower
            ON health.user_accounts (LOWER(username)) WHERE username IS NOT NULL;
    ELSE
        RAISE NOTICE 'user_accounts: % case-insensitive username collision(s); uq_user_accounts_username_lower skipped', v_dups;
    END IF;
END $$;

-- A username that is present but blank can never be logged into and only
-- collides with other blanks; reject it going forward. NOT VALID first, then
-- VALIDATE only if no existing row violates it.
DO $$
DECLARE
    v_bad BIGINT;
BEGIN
    IF to_regclass('health.user_accounts') IS NULL THEN
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_user_accounts_username_nonblank'
          AND conrelid = 'health.user_accounts'::REGCLASS
    ) THEN
        ALTER TABLE health.user_accounts
            ADD CONSTRAINT chk_user_accounts_username_nonblank
            CHECK (username IS NULL OR length(btrim(username)) > 0) NOT VALID;
    END IF;

    SELECT count(*) INTO v_bad FROM health.user_accounts
     WHERE username IS NOT NULL AND length(btrim(username)) = 0;

    IF v_bad = 0 THEN
        ALTER TABLE health.user_accounts
            VALIDATE CONSTRAINT chk_user_accounts_username_nonblank;
    ELSE
        RAISE NOTICE 'user_accounts: % blank username(s); constraint left NOT VALID', v_bad;
    END IF;
END $$;

-- ============================================================
-- 2. now_immutable() — STOP INDEXING A TIME-DEPENDENT EXPRESSION
--
-- 001_core_schema.sql:15-19 defines:
--     CREATE OR REPLACE FUNCTION health.now_immutable() RETURNS TIMESTAMPTZ
--     LANGUAGE sql IMMUTABLE AS $$ SELECT NOW(); $$;
-- and 005_campus_ambassadors.sql:57-61 layers now_immutable_date() on top.
--
-- The IMMUTABLE label is a lie: the value changes every transaction. Because
-- Postgres is entitled to constant-fold an IMMUTABLE call, every partial index
-- with predicate "health.now_immutable() <@ system_period" is built against
-- whatever instant the build happened at. Rows inserted later satisfy the real
-- predicate but are absent from the index, and any plan that uses the index
-- returns a silently short answer. In a bitemporal schema that means "current"
-- reads quietly miss data — the worst possible failure mode here, because it is
-- invisible.
--
-- Eleven index definitions across 001, 003 and 005 depend on it:
--   001: idx_departments_current, idx_positions_dept, idx_positions_head,
--        idx_reporting_child, idx_reporting_parent, idx_employments_current,
--        idx_employments_position
--   003: idx_leave_requests_current, idx_leave_requests_dates,
--        idx_leave_requests_pending
--   005: idx_ambassadors_active (via now_immutable_date())
--
-- CHOICE: plain / immutably-predicated indexes, NOT an is_current boolean.
-- An is_current column would need a trigger on every bitemporal core table
-- plus a backfill of a hand-built database, and a trigger that is wrong writes
-- WRONG data that then looks authoritative — strictly more dangerous than the
-- planning bug it replaces. The replacement indexes below carry no
-- time-dependent predicate at all, so correctness rests entirely on the query
-- predicates, which already spell the filter out explicitly and never relied on
-- the index predicate (verified: backend/src/lib/auth.ts:49-57 and
-- backend/src/modules/payroll/routes.ts all say "system_period @> NOW()", as do
-- migrations 018 and 032). A GiST index on system_period is added so that
-- containment test stays index-assisted.
--
-- Indexes are located in the catalog by DEFINITION, not by name, so a
-- hand-built database with differently-named indexes is still repaired.
-- Constraint-backed and unique indexes are never touched.
-- ============================================================
DO $$
DECLARE
    r RECORD;
    v_dropped INT := 0;
BEGIN
    FOR r IN
        SELECT n.nspname AS sch, ci.relname AS idx, pg_get_indexdef(i.indexrelid) AS def
        FROM pg_index i
        JOIN pg_class ci ON ci.oid = i.indexrelid
        JOIN pg_class ct ON ct.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = ct.relnamespace
        WHERE n.nspname = 'health'
          AND pg_get_indexdef(i.indexrelid) LIKE '%now_immutable%'
          AND NOT i.indisunique
          AND NOT i.indisprimary
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
    LOOP
        RAISE NOTICE 'dropping time-dependent index %.%: %', r.sch, r.idx, r.def;
        EXECUTE format('DROP INDEX IF EXISTS %I.%I', r.sch, r.idx);
        v_dropped := v_dropped + 1;
    END LOOP;

    RAISE NOTICE 'now_immutable repair: % index(es) dropped', v_dropped;

    -- Anything left that still references it is constraint-backed and cannot be
    -- dropped from here. Warn loudly rather than raise: this file runs at
    -- application boot, so an unconditional EXCEPTION would brick every boot.
    IF EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class ct ON ct.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = ct.relnamespace
        WHERE n.nspname = 'health'
          AND pg_get_indexdef(i.indexrelid) LIKE '%now_immutable%'
    ) THEN
        RAISE WARNING 'health still has a unique/constraint-backed index depending on now_immutable(); it remains WRONG and must be resolved by hand';
    END IF;
END $$;

-- Replacements. No predicate contains a time-dependent expression. New names
-- are used so the change is auditable and so a re-run of 001/003/005 (which
-- would recreate the broken ones) is repaired again by the block above without
-- colliding with these.
DO $$
BEGIN
    IF to_regclass('health.departments') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_departments_logical
            ON health.departments (logical_id);
        CREATE INDEX IF NOT EXISTS idx_departments_system_period
            ON health.departments USING GIST (system_period);
    END IF;

    IF to_regclass('health.positions') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_positions_department
            ON health.positions (department_id);
        CREATE INDEX IF NOT EXISTS idx_positions_head_person
            ON health.positions (head_of_department_id)
            WHERE head_of_department_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_positions_system_period
            ON health.positions USING GIST (system_period);
    END IF;

    IF to_regclass('health.position_reporting_lines') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_reporting_child_position
            ON health.position_reporting_lines (child_position_id);
        CREATE INDEX IF NOT EXISTS idx_reporting_parent_position
            ON health.position_reporting_lines (parent_position_id);
        CREATE INDEX IF NOT EXISTS idx_reporting_system_period
            ON health.position_reporting_lines USING GIST (system_period);
    END IF;

    IF to_regclass('health.employments') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_employments_person_status
            ON health.employments (person_id, status);
        CREATE INDEX IF NOT EXISTS idx_employments_position_all
            ON health.employments (position_id);
        CREATE INDEX IF NOT EXISTS idx_employments_system_period
            ON health.employments USING GIST (system_period);
    END IF;

    IF to_regclass('health.leave_requests') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_leave_requests_person_all
            ON health.leave_requests (person_id);
        CREATE INDEX IF NOT EXISTS idx_leave_requests_date_span
            ON health.leave_requests (start_date, end_date);
        -- status = 'PENDING' is a constant, so this predicate IS immutable.
        CREATE INDEX IF NOT EXISTS idx_leave_requests_pending_person
            ON health.leave_requests (person_id, status)
            WHERE status = 'PENDING';
        CREATE INDEX IF NOT EXISTS idx_leave_requests_system_period
            ON health.leave_requests USING GIST (system_period);
    END IF;

    IF to_regclass('health.campus_ambassadors') IS NOT NULL THEN
        CREATE INDEX IF NOT EXISTS idx_ambassadors_person_dates
            ON health.campus_ambassadors (person_id, start_date, end_date);
    END IF;
END $$;

-- Both functions survive (005 builds now_immutable_date() on now_immutable(),
-- and forward-only means nothing is deleted) but they are re-marked STABLE so
-- they can never be constant-folded into another index or a CHECK. This runs
-- AFTER the drops above: no index may depend on them at this point.
DO $$
BEGIN
    IF to_regprocedure('health.now_immutable()') IS NOT NULL THEN
        ALTER FUNCTION health.now_immutable() STABLE;
        COMMENT ON FUNCTION health.now_immutable() IS
            'DEPRECATED. Returns NOW(); it was mislabelled IMMUTABLE in 001 and must never appear in an index predicate, a CHECK, or a generated column. Use NOW() directly, or upper_inf(system_period) to mean "current system version".';
    END IF;

    IF to_regprocedure('health.now_immutable_date()') IS NOT NULL THEN
        ALTER FUNCTION health.now_immutable_date() STABLE;
        COMMENT ON FUNCTION health.now_immutable_date() IS
            'DEPRECATED. Time-dependent despite the name (005 marked it IMMUTABLE); never index or CHECK on it. Use CURRENT_DATE.';
    END IF;
END $$;

-- ============================================================
-- 3. TEMPORAL FUNCTIONS — invalid range-bound literals
--
-- 002_temporal_functions.sql contains the malformed bound literal '[])' at
-- lines 165 (fn_position_new_version), 211 (fn_reporting_line_new_version) and
-- 401 (fn_leave_request_new_version). '[])' is not a legal range bound spec, so
-- TSTZRANGE() raises "invalid range bound flags" and all three functions fail
-- at runtime the moment they are called.
--
-- Two further bound bugs are corrected in the same pass, because they are the
-- same defect (wrong bounds) and this schema is documented half-open:
--   * fn_employment_correct built valid_period with INCLUSIVE '[]' bounds
--     (002:71). With an inclusive upper bound, two back-to-back versions share
--     their boundary instant and collide with the (person_id, valid_period)
--     exclusion constraint — exactly the adjacency bug 032 called out for leave.
--   * fn_department_new_version / fn_position_new_version ignored p_valid_from
--     entirely and used p_system_from as the valid-time lower bound (002:128,
--     176). p_valid_from is now honoured, falling back to p_system_from when
--     NULL so existing behaviour is preserved.
--
-- All bounds below are half-open '[)': valid_period and system_period both.
--
-- Also fixed: every one of these functions closed out the live version FIRST and
-- then did "INSERT ... SELECT ... WHERE NOW() <@ system_period" against the same
-- table. After the close-out that predicate matches nothing, so the INSERT
-- inserted ZERO rows and the update silently vanished. The live row is now
-- captured into a record BEFORE the close-out, and a missing logical_id raises
-- instead of succeeding as a no-op. Nothing in the codebase calls these five
-- functions yet (grepped: they appear only in 002), so no caller depends on the
-- old silent-no-op behaviour.
--
-- Names, argument lists and return types are byte-identical to 002.
-- "The live version" is upper_inf(system_period): open-ended system_period is
-- how every writer in this schema marks the current row.
-- ============================================================

-- fn_employment_correct copies salary_monthly, which 018 adds. 018 sorts inside
-- the 001-030 range that the migration ledger records as already applied, so on
-- a hand-built database the column may be absent. Guarantee it (same definition
-- as 018_payroll_wallet.sql:8) before the function body references it.
ALTER TABLE IF EXISTS health.employments
    ADD COLUMN IF NOT EXISTS salary_monthly NUMERIC(12,2);

CREATE OR REPLACE FUNCTION health.fn_employment_correct(
    p_logical_id UUID,
    p_position_id UUID,
    p_status TEXT,
    p_valid_from TIMESTAMPTZ,
    p_valid_to TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_cur health.employments;
    v_from TIMESTAMPTZ := COALESCE(p_system_from, NOW());
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can correct employment records';
    END IF;

    SELECT * INTO v_cur
      FROM health.employments
     WHERE logical_id = p_logical_id
       AND upper_inf(system_period)
     ORDER BY lower(valid_period) DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Employment % not found or not current', p_logical_id;
    END IF;

    UPDATE health.employments
       SET system_period = TSTZRANGE(lower(system_period), v_from, '[)'),
           updated_at = NOW()
     WHERE logical_id  = v_cur.logical_id
       AND valid_period  = v_cur.valid_period
       AND system_period = v_cur.system_period;

    INSERT INTO health.employments (
        logical_id, valid_period, system_period, person_id, position_id, status,
        jurisdiction, employment_type, parental_consent_secured, started_at,
        ended_at, termination_reason, salary_monthly, created_at, updated_at
    ) VALUES (
        p_logical_id,
        TSTZRANGE(COALESCE(p_valid_from, lower(v_cur.valid_period)), p_valid_to, '[)'),
        TSTZRANGE(v_from, NULL, '[)'),
        v_cur.person_id,
        COALESCE(p_position_id, v_cur.position_id),
        COALESCE(p_status, v_cur.status),
        v_cur.jurisdiction,
        v_cur.employment_type,
        v_cur.parental_consent_secured,
        v_cur.started_at,
        v_cur.ended_at,
        v_cur.termination_reason,
        v_cur.salary_monthly,
        v_cur.created_at,
        NOW()
    );

    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION health.fn_department_new_version(
    p_logical_id UUID,
    p_name TEXT,
    p_jurisdiction TEXT,
    p_parent_department_id UUID,
    p_description TEXT,
    p_valid_from TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_cur health.departments;
    v_from TIMESTAMPTZ := COALESCE(p_system_from, NOW());
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can version departments';
    END IF;

    SELECT * INTO v_cur
      FROM health.departments
     WHERE logical_id = p_logical_id
       AND upper_inf(system_period)
     ORDER BY lower(valid_period) DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department % not found or not current', p_logical_id;
    END IF;

    UPDATE health.departments
       SET system_period = TSTZRANGE(lower(system_period), v_from, '[)'),
           updated_at = NOW()
     WHERE logical_id  = v_cur.logical_id
       AND valid_period  = v_cur.valid_period
       AND system_period = v_cur.system_period;

    INSERT INTO health.departments (
        logical_id, valid_period, system_period, name, jurisdiction,
        parent_department_id, description, created_at, updated_at
    ) VALUES (
        p_logical_id,
        TSTZRANGE(COALESCE(p_valid_from, v_from), NULL, '[)'),
        TSTZRANGE(v_from, NULL, '[)'),
        COALESCE(p_name, v_cur.name),
        COALESCE(p_jurisdiction, v_cur.jurisdiction),
        p_parent_department_id,
        p_description,
        v_cur.created_at,
        NOW()
    );

    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION health.fn_position_new_version(
    p_logical_id UUID,
    p_name TEXT,
    p_department_id UUID,
    p_head_of_department_id UUID,
    p_grade_level INTEGER,
    p_employment_type TEXT,
    p_description TEXT,
    p_valid_from TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_cur health.positions;
    v_from TIMESTAMPTZ := COALESCE(p_system_from, NOW());
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can version positions';
    END IF;

    SELECT * INTO v_cur
      FROM health.positions
     WHERE logical_id = p_logical_id
       AND upper_inf(system_period)
     ORDER BY lower(valid_period) DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position % not found or not current', p_logical_id;
    END IF;

    -- 002:165 had TSTZRANGE(..., '[])') here: an invalid bound spec.
    UPDATE health.positions
       SET system_period = TSTZRANGE(lower(system_period), v_from, '[)'),
           updated_at = NOW()
     WHERE logical_id  = v_cur.logical_id
       AND valid_period  = v_cur.valid_period
       AND system_period = v_cur.system_period;

    INSERT INTO health.positions (
        logical_id, valid_period, system_period, name, department_id,
        head_of_department_id, grade_level, employment_type, description,
        created_at, updated_at
    ) VALUES (
        p_logical_id,
        TSTZRANGE(COALESCE(p_valid_from, v_from), NULL, '[)'),
        TSTZRANGE(v_from, NULL, '[)'),
        COALESCE(p_name, v_cur.name),
        COALESCE(p_department_id, v_cur.department_id),
        p_head_of_department_id,
        p_grade_level,
        COALESCE(p_employment_type, v_cur.employment_type),
        p_description,
        v_cur.created_at,
        NOW()
    );

    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION health.fn_reporting_line_new_version(
    p_logical_id UUID,
    p_child_position_id UUID,
    p_parent_position_id UUID,
    p_is_primary BOOLEAN,
    p_reporting_type TEXT,
    p_valid_from TIMESTAMPTZ,
    p_system_from TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_cur health.position_reporting_lines;
    v_from TIMESTAMPTZ := COALESCE(p_system_from, NOW());
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin') THEN
        RAISE EXCEPTION 'Only hr_generalist or platform_admin can version reporting lines';
    END IF;

    SELECT * INTO v_cur
      FROM health.position_reporting_lines
     WHERE logical_id = p_logical_id
       AND upper_inf(system_period)
     ORDER BY lower(valid_period) DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reporting line % not found or not current', p_logical_id;
    END IF;

    -- 002:211 had TSTZRANGE(..., '[])') here: an invalid bound spec.
    UPDATE health.position_reporting_lines
       SET system_period = TSTZRANGE(lower(system_period), v_from, '[)'),
           updated_at = NOW()
     WHERE logical_id  = v_cur.logical_id
       AND valid_period  = v_cur.valid_period
       AND system_period = v_cur.system_period;

    INSERT INTO health.position_reporting_lines (
        logical_id, valid_period, system_period,
        child_position_id, parent_position_id, is_primary, reporting_type,
        created_at, updated_at
    ) VALUES (
        p_logical_id,
        TSTZRANGE(COALESCE(p_valid_from, v_from), NULL, '[)'),
        TSTZRANGE(v_from, NULL, '[)'),
        COALESCE(p_child_position_id, v_cur.child_position_id),
        COALESCE(p_parent_position_id, v_cur.parent_position_id),
        COALESCE(p_is_primary, v_cur.is_primary),
        COALESCE(p_reporting_type, v_cur.reporting_type),
        v_cur.created_at,
        NOW()
    );

    RETURN;
END;
$$;

-- fn_leave_request_new_version had THREE defects, not just the bound literal:
--   * 002:401 TSTZRANGE(..., '[])') — invalid bound spec.
--   * 002:412 wrote valid_period = TSTZRANGE(NOW(), NULL, '[]'), which can never
--     satisfy 003's own chk_leave_requests_valid_period (LOWER = start_date AND
--     UPPER = end_date + 1). valid_period is now derived from the dates.
--   * days_requested was a raw calendar span (and off by one). 032 made
--     days_requested a WORKING-day count that payroll consumes, so the single
--     definition health.fn_working_days() is used here (032 runs before 034).
--   * approved_by / approved_at / rejection_reason were silently dropped from
--     each new version; they are carried forward now.
CREATE OR REPLACE FUNCTION health.fn_leave_request_new_version(
    p_logical_id UUID,
    p_leave_type TEXT,
    p_status TEXT,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_parental_consent_secured BOOLEAN,
    p_effective_time TIMESTAMPTZ,
    p_caller_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = health, pg_catalog
AS $$
DECLARE
    v_cur health.leave_requests;
    v_from TIMESTAMPTZ := COALESCE(p_effective_time, NOW());
    v_start DATE;
    v_end DATE;
BEGIN
    IF p_caller_role NOT IN ('hr_generalist', 'platform_admin', 'self') THEN
        RAISE EXCEPTION 'Unauthorized to modify leave request';
    END IF;

    SELECT * INTO v_cur
      FROM health.leave_requests
     WHERE logical_id = p_logical_id
       AND upper_inf(system_period)
     ORDER BY lower(valid_period) DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Leave request % not found or not current', p_logical_id;
    END IF;

    v_start := COALESCE(p_start_date, v_cur.start_date);
    v_end   := COALESCE(p_end_date, v_cur.end_date);

    IF v_end < v_start THEN
        RAISE EXCEPTION 'Leave request %: end_date % precedes start_date %', p_logical_id, v_end, v_start;
    END IF;

    UPDATE health.leave_requests
       SET system_period = TSTZRANGE(lower(system_period), v_from, '[)'),
           updated_at = NOW()
     WHERE logical_id  = v_cur.logical_id
       AND valid_period  = v_cur.valid_period
       AND system_period = v_cur.system_period;

    INSERT INTO health.leave_requests (
        logical_id, valid_period, system_period, person_id, leave_type,
        status, start_date, end_date, days_requested, reason,
        parental_consent_secured, approved_by, approved_at, rejection_reason,
        created_at, updated_at
    ) VALUES (
        p_logical_id,
        TSTZRANGE(v_start::TIMESTAMPTZ, (v_end + 1)::TIMESTAMPTZ, '[)'),
        TSTZRANGE(v_from, NULL, '[)'),
        v_cur.person_id,
        COALESCE(p_leave_type, v_cur.leave_type),
        COALESCE(p_status, v_cur.status),
        v_start,
        v_end,
        health.fn_working_days(v_start, v_end),
        COALESCE(p_reason, v_cur.reason),
        COALESCE(p_parental_consent_secured, v_cur.parental_consent_secured),
        v_cur.approved_by,
        v_cur.approved_at,
        v_cur.rejection_reason,
        v_cur.created_at,
        NOW()
    );

    RETURN;
END;
$$;

-- ============================================================
-- 4. MISSING INTEGRITY CONSTRAINTS
--
-- Every CHECK is added NOT VALID first, then VALIDATEd only when a guard query
-- proves that no existing row violates it. A populated table therefore cannot
-- fail this migration: the worst case is a NOTICE and a constraint that is
-- enforced for new writes but left unvalidated for old rows.
--
-- Values were read before constraining:
--   * employments.salary_monthly is seeded by 018:10-17 with 45000/65000/90000/
--     125000 — all positive, and NULL is legitimate (no salary on record).
--   * positions.grade_level is compared as >= 3 / >= 5 / >= 7 by 018, so it is a
--     small positive integer; NULL is legitimate.
--   * traditional_knowledge.status is declared with no CHECK at 028:41; the real
--     enumeration is the union type at backend/src/modules/care/traditional.ts:64
--     ('APPROVED' | 'DRAFT' | 'REVIEW' | 'SUSPENDED' | 'RETIRED'), and every
--     seeded row is 'APPROVED' (traditional.ts:93).
--   * projects seed rows (015:29-33) all have end_date after start_date.
--   * events.attempts and scheduler_jobs.*_count are counters seeded at 0.
--
-- NOT DONE HERE ON PURPOSE: no amount checks on payroll_entries (031 owns
-- them), nothing on leave_requests (032 owns it), nothing on attendance_events.
-- ============================================================
DO $$
DECLARE
    r RECORD;
    v_bad BIGINT;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('employments', 'chk_employments_salary_non_negative',
             'salary_monthly IS NULL OR salary_monthly >= 0',
             'salary_monthly'),
            ('employments', 'chk_employments_date_order',
             'started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at',
             'started_at,ended_at'),
            ('positions', 'chk_positions_grade_level_non_negative',
             'grade_level IS NULL OR grade_level >= 0',
             'grade_level'),
            ('projects', 'chk_projects_date_order',
             'start_date IS NULL OR end_date IS NULL OR end_date >= start_date',
             'start_date,end_date'),
            ('traditional_knowledge', 'chk_traditional_knowledge_status',
             'status IN (''APPROVED'', ''DRAFT'', ''REVIEW'', ''SUSPENDED'', ''RETIRED'')',
             'status'),
            ('events', 'chk_events_attempts_non_negative',
             'attempts >= 0',
             'attempts'),
            ('scheduler_jobs', 'chk_scheduler_jobs_counts_non_negative',
             'runs_count >= 0 AND success_count >= 0 AND failure_count >= 0',
             'runs_count,success_count,failure_count')
        ) AS t(tbl, cname, expr, cols)
    LOOP
        CONTINUE WHEN to_regclass('health.' || r.tbl) IS NULL;

        -- A hand-built database may be missing a column the expression names.
        -- Skip rather than abort the whole migration.
        CONTINUE WHEN EXISTS (
            SELECT 1
            FROM unnest(string_to_array(r.cols, ',')) AS want(colname)
            WHERE NOT EXISTS (
                SELECT 1 FROM pg_attribute
                WHERE attrelid = ('health.' || r.tbl)::REGCLASS
                  AND attname = want.colname AND attnum > 0 AND NOT attisdropped
            )
        );

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = r.cname
              AND conrelid = ('health.' || r.tbl)::REGCLASS
        ) THEN
            EXECUTE format('ALTER TABLE health.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID',
                           r.tbl, r.cname, r.expr);
            RAISE NOTICE 'added NOT VALID constraint %.%', r.tbl, r.cname;
        END IF;

        EXECUTE format('SELECT count(*) FROM health.%I WHERE NOT (%s)', r.tbl, r.expr)
            INTO v_bad;

        IF v_bad = 0 THEN
            EXECUTE format('ALTER TABLE health.%I VALIDATE CONSTRAINT %I', r.tbl, r.cname);
        ELSE
            RAISE NOTICE '%.%: % existing row(s) violate it; left NOT VALID (enforced for new writes only)',
                         r.tbl, r.cname, v_bad;
        END IF;
    END LOOP;
END $$;

-- NOT NULL where a null is meaningless. An employment with no start date is not
-- a fact about anything, and nothing in the backend inserts into
-- health.employments (grepped), so tightening this cannot break a write path.
-- Guarded: skipped entirely if any existing row is null.
DO $$
DECLARE
    v_nulls BIGINT;
BEGIN
    IF to_regclass('health.employments') IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'health.employments'::REGCLASS
          AND attname = 'started_at' AND attnum > 0 AND NOT attisdropped
          AND NOT attnotnull
    ) THEN
        SELECT count(*) INTO v_nulls FROM health.employments WHERE started_at IS NULL;
        IF v_nulls = 0 THEN
            ALTER TABLE health.employments ALTER COLUMN started_at SET NOT NULL;
        ELSE
            RAISE NOTICE 'employments.started_at: % null row(s); SET NOT NULL skipped', v_nulls;
        END IF;
    END IF;
END $$;

-- ============================================================
-- 5. GIST EXCLUDE CONSTRAINTS ON THE BITEMPORAL CORE
--
-- 001 adds, with no system_period predicate:
--   departments_valid_period_excl      (logical_id WITH =, valid_period WITH &&)
--   positions_valid_period_excl        (logical_id WITH =, valid_period WITH &&)
--   employments_valid_period_excl      (person_id  WITH =, valid_period WITH &&)
--   reporting_line_one_primary         (child_position_id WITH =,
--                                       valid_period WITH &&) WHERE (is_primary)
--
-- The table claims PK (logical_id, valid_period, system_period), i.e. many
-- system-time versions of the same valid-time slice. But an exclusion
-- constraint that ignores system_period forbids exactly that: closing out a
-- version and inserting its successor puts two rows with the same key and
-- overlapping valid_period in the table at once, so the insert is rejected.
-- Bitemporal versioning is structurally impossible. Same class of bug as the
-- leave_requests one fixed in 032.
--
-- REPAIR: each constraint is rebuilt IN PLACE UNDER ITS EXISTING NAME with
-- "AND upper_inf(system_period)" added to its predicate, so it now applies only
-- to the live system-time version. upper_inf() is genuinely immutable, so it is
-- legal in an exclusion predicate. The new constraint is strictly weaker than
-- the old one and therefore cannot fail against existing rows.
--
-- Names are preserved deliberately: 002:374 does
-- "COMMENT ON CONSTRAINT reporting_line_one_primary ON
-- health.position_reporting_lines", which would error if that name disappeared.
--
-- Constraints are found by DEFINITION, not by name, and the predicate is
-- rewritten from pg_get_constraintdef, so a hand-built database with different
-- names or an extra column in the key is still repaired correctly. Re-running is
-- a no-op: a definition that already mentions upper_inf is not selected.
--
-- WHAT IS DELIBERATELY LEFT ALONE (see report):
--   * health.persons — not bitemporal, no exclusion constraint, nothing to fix.
--   * The business meaning of the key columns is NOT touched. In particular
--     employments_valid_period_excl still forbids two overlapping employments
--     for one person regardless of status, so a TERMINATED employment can still
--     block a re-hire over the same valid period. Narrowing that would need a
--     status predicate, and choosing which statuses count is a business
--     decision, not a schema repair.
-- ============================================================
DO $$
DECLARE
    r RECORD;
    v_new TEXT;
    v_fixed INT := 0;
BEGIN
    FOR r IN
        SELECT c.conname,
               n.nspname || '.' || t.relname AS tbl,
               pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'health'
          AND c.contype = 'x'
          AND t.relname IN ('departments', 'positions',
                            'position_reporting_lines', 'employments')
          AND pg_get_constraintdef(c.oid) LIKE '%valid_period WITH &&%'
          AND pg_get_constraintdef(c.oid) NOT LIKE '%upper_inf%'
    LOOP
        IF r.def ~ 'WHERE \(.*\)$' THEN
            v_new := regexp_replace(r.def, 'WHERE \((.*)\)$',
                                    'WHERE ((\1) AND upper_inf(system_period))');
        ELSE
            v_new := r.def || ' WHERE (upper_inf(system_period))';
        END IF;

        RAISE NOTICE 'rebuilding % on %: % -> %', r.conname, r.tbl, r.def, v_new;
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, v_new);
        v_fixed := v_fixed + 1;
    END LOOP;

    RAISE NOTICE 'bitemporal exclusion repair: % constraint(s) rebuilt', v_fixed;
END $$;

-- ============================================================
-- 6. GRANTS — guarded on the application role existing (031/033 create it)
--
-- Table privileges only. EXECUTE on the five versioning functions rebuilt in
-- section 3 is deliberately NOT granted: they are SECURITY DEFINER and their
-- only authorisation check is the caller-supplied p_caller_role string, so
-- granting them to the application role would hand it a way to assert
-- 'platform_admin' and bypass every RLS policy 033 installs. Nothing calls them
-- today. See the report — that signature needs redesigning before it is exposed.
-- ============================================================
DO $$
DECLARE
    t TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
        RAISE NOTICE 'role hrms_app absent; grants skipped (re-run after it exists)';
        RETURN;
    END IF;

    EXECUTE 'GRANT USAGE ON SCHEMA health TO hrms_app';

    FOREACH t IN ARRAY ARRAY['persons', 'user_accounts', 'departments', 'positions',
                             'position_reporting_lines', 'employments',
                             'campus_ambassadors', 'leave_requests'] LOOP
        IF to_regclass('health.' || t) IS NOT NULL THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON health.%I TO hrms_app', t);
        END IF;
    END LOOP;
END $$;

-- ============================================================
-- VERIFICATION QUERIES (run by hand; not executed by this migration)
-- ============================================================
-- No index may reference now_immutable any more — expect zero rows:
--   SELECT indexrelid::regclass FROM pg_index i
--     JOIN pg_class t ON t.oid = i.indrelid
--     JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname = 'health'
--      AND pg_get_indexdef(i.indexrelid) LIKE '%now_immutable%';
--
-- Both helpers must be 's' (stable), not 'i' (immutable):
--   SELECT proname, provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'health' AND proname LIKE 'now_immutable%';
--
-- Every bitemporal exclusion constraint must carry upper_inf(system_period):
--   SELECT conrelid::regclass, conname, pg_get_constraintdef(oid)
--     FROM pg_constraint WHERE contype = 'x'
--      AND connamespace = 'health'::regnamespace ORDER BY 1, 2;
--
-- No CHECK added here should be left unvalidated — expect zero rows:
--   SELECT conrelid::regclass, conname FROM pg_constraint
--    WHERE contype = 'c' AND NOT convalidated
--      AND connamespace = 'health'::regnamespace;
--
-- ============================================================
-- END OF MIGRATION 034
-- ============================================================

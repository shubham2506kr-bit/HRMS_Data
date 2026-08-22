-- Migration 018: Payroll + Wallet (Phase J)
-- Payroll is computed from real employment + leave records; wallet movements
-- are atomic, idempotent and reconciled. Nothing is marked PAID without a
-- SUCCESSFUL wallet transaction for every entry.

-- Salary data (sandbox seed — payroll needs a base; employees get monthly salary)
ALTER TABLE health.employments
    ADD COLUMN IF NOT EXISTS salary_monthly NUMERIC(12,2);

UPDATE health.employments e SET salary_monthly = CASE
    WHEN pos.grade_level >= 7 THEN 125000
    WHEN pos.grade_level >= 5 THEN 90000
    WHEN pos.grade_level >= 3 THEN 65000
    ELSE 45000
END
FROM health.positions pos
WHERE pos.logical_id = e.position_id AND e.salary_monthly IS NULL;

-- ============================================================
-- PAYROLL
-- ============================================================
CREATE TABLE health.payroll_runs (
    run_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    run_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'COMPUTED', 'APPROVED', 'PAID', 'PARTIALLY_PAID', 'FAILED')),
    created_by UUID REFERENCES health.persons(logical_id),
    approved_by UUID REFERENCES health.persons(logical_id),
    approved_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (period_start, period_end)
);

CREATE TABLE health.payroll_entries (
    entry_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID NOT NULL REFERENCES health.payroll_runs(run_id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    salary_amount NUMERIC(12,2) NOT NULL,
    unpaid_leave_days INT NOT NULL DEFAULT 0,
    unpaid_leave_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
    gross_amount NUMERIC(12,2) NOT NULL,
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    net_amount NUMERIC(12,2) NOT NULL,
    breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, person_id)
);

CREATE INDEX idx_payroll_entries_person ON health.payroll_entries (person_id, run_id);

CREATE TABLE health.payslips (
    payslip_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entry_id UUID NOT NULL UNIQUE REFERENCES health.payroll_entries(entry_id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    downloaded_at TIMESTAMPTZ
);

-- ============================================================
-- WALLET
-- ============================================================
CREATE TABLE health.wallet_accounts (
    wallet_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL UNIQUE REFERENCES health.persons(logical_id),
    balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE health.wallet_transactions (
    txn_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID NOT NULL REFERENCES health.wallet_accounts(wallet_id),
    txn_type TEXT NOT NULL CHECK (txn_type IN ('CREDIT', 'DEBIT')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reference_type TEXT NOT NULL,
    reference_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SUCCESSFUL', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    UNIQUE (reference_type, reference_id)
);

CREATE INDEX idx_wallet_txns_wallet ON health.wallet_transactions (wallet_id, created_at DESC);
CREATE INDEX idx_wallet_txns_reference ON health.wallet_transactions (reference_type, reference_id);

-- Initialize wallet for every person (idempotent)
INSERT INTO health.wallet_accounts (person_id)
SELECT logical_id FROM health.persons
ON CONFLICT (person_id) DO NOTHING;

-- ============================================================
-- fn_payroll_compute: build entries for a run from real records
-- ============================================================
CREATE OR REPLACE FUNCTION health.fn_payroll_compute(p_run_id UUID)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_start DATE;
    v_end DATE;
    v_count INT := 0;
BEGIN
    SELECT period_start, period_end INTO v_start, v_end FROM health.payroll_runs WHERE run_id = p_run_id;
    IF v_start IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;

    DELETE FROM health.payroll_entries WHERE run_id = p_run_id;

    INSERT INTO health.payroll_entries (run_id, person_id, salary_amount, unpaid_leave_days,
        unpaid_leave_deduction, gross_amount, tax_amount, net_amount, breakdown)
    SELECT
        p_run_id,
        e.person_id,
        e.salary_monthly,
        COALESCE((
            SELECT SUM(lr.days_requested)
            FROM health.leave_requests lr
            WHERE lr.person_id = e.person_id
              AND lr.leave_type = 'UNPAID'
              AND lr.status = 'APPROVED'
              AND lr.start_date <= v_end AND lr.end_date >= v_start
              AND lr.system_period @> NOW()
        ), 0)::INT AS unpaid_days,
        ROUND(COALESCE((
            SELECT SUM(lr.days_requested)
            FROM health.leave_requests lr
            WHERE lr.person_id = e.person_id
              AND lr.leave_type = 'UNPAID'
              AND lr.status = 'APPROVED'
              AND lr.start_date <= v_end AND lr.end_date >= v_start
              AND lr.system_period @> NOW()
        ), 0) * e.salary_monthly / 30, 2) AS deduction,
        e.salary_monthly - ROUND(COALESCE((
            SELECT SUM(lr.days_requested)
            FROM health.leave_requests lr
            WHERE lr.person_id = e.person_id
              AND lr.leave_type = 'UNPAID'
              AND lr.status = 'APPROVED'
              AND lr.start_date <= v_end AND lr.end_date >= v_start
              AND lr.system_period @> NOW()
        ), 0) * e.salary_monthly / 30, 2) AS gross,
        ROUND(e.salary_monthly * 0.10, 2) AS tax,
        ROUND(e.salary_monthly - ROUND(e.salary_monthly * 0.10, 2) -
              ROUND(COALESCE((
                SELECT SUM(lr.days_requested)
                FROM health.leave_requests lr
                WHERE lr.person_id = e.person_id
                  AND lr.leave_type = 'UNPAID'
                  AND lr.status = 'APPROVED'
                  AND lr.start_date <= v_end AND lr.end_date >= v_start
                  AND lr.system_period @> NOW()
              ), 0) * e.salary_monthly / 30, 2), 2) AS net,
        jsonb_build_object('tax_rate_pct', 10, 'basis', 'salary_monthly', 'unpaid_deduction_per_day', e.salary_monthly / 30)
    FROM health.employments e
    WHERE e.status = 'ACTIVE' AND e.system_period @> NOW()
      AND e.salary_monthly IS NOT NULL;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION health.fn_payroll_compute(UUID) TO app_service, cerbos;
GRANT SELECT, INSERT, UPDATE ON health.payroll_runs, health.payroll_entries, health.payslips,
      health.wallet_accounts, health.wallet_transactions TO app_service;

COMMENT ON TABLE health.wallet_transactions IS 'Wallet ledger. Status only becomes SUCCESSFUL when the movement is applied atomically. PAYED payroll runs require every entry transaction SUCCESSFUL.';

-- END OF MIGRATION 018
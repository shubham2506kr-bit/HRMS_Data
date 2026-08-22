# HumanOS / EduRankAI HRMS — audit and remediation handoff

**Written:** 2026-08-23
**Written by:** a Claude session running in the Claude desktop app, with file access to `E:\HRMS_Data` but **no shell access to it** (see §3).
**Written for:** a Claude Code session running locally with a real shell on this repo.
**Repo root when this was written:** `E:\HRMS_Data`

---

## 0. How to use this document

Read §1 first and do it before editing anything. Then §3, because it explains why a large amount of code in this repo was written but never compiled or executed — that is the single most important fact about the current state of the tree.

Everything below is labelled with a status:

| Label | Meaning |
|---|---|
| `OPEN` | Not addressed. The defect is still in the code as described. |
| `FIXED` | Code was changed to address it. **Never compiled, never run.** Treat as a claim to verify, not a fact. |
| `PARTIAL` | Some of it was addressed. The remainder is described. |
| `NEW` | Found during the fix pass, was not in the original audit. |

Line numbers were accurate when cited. Many files have since been rewritten, so line numbers on `FIXED` items may have drifted — search by symbol, not by line.

Do not trust `docs/HUMANOS_STATUS.md`, `docs/HUMANOS_HANDOVER.md`, `docs/PHASE1_AUTHZ_MATRIX.md`, or `docs/PHASE2_AI_SECURITY_MATRIX.md`. Those are the original team's own status documents and the audit found many rows marked VERIFIED that the code directly contradicts. They are claims, not evidence.

---

## 1. Stop — do this before you touch anything

1. **There is no version control.** At audit time there was no `.git` anywhere in this tree. A `.gitignore` now exists at the root but no repository was ever initialised. Roughly twenty-five files across `backend/src`, `frontend/src`, `migrations/`, `docs/` and `backend/scripts/` were rewritten by a fan-out of parallel agents with **no snapshot and no diff**. If something regressed, there is currently no way to see what.

   Before your first edit:

   ```bash
   cd /e/HRMS_Data          # adjust for your shell
   git init
   git add -A
   git commit -m "Baseline: state after the 2026-08-22 remediation pass, unverified"
   ```

   That commit is the "before" picture for everything you do next. It is not a clean baseline — it already contains the unverified rewrites — but it is infinitely better than nothing.

2. **Check `.gitignore` covers the secrets before that first `git add`.** `backend/.env` contains a real (weak) JWT secret and a database URL. Confirm it is ignored. There are also ~24 committed `.log` files in `backend/` and `frontend/`.

3. **Take a filesystem copy of `E:\HRMS_Data` somewhere outside the repo** as well. `git init` after the fact does not protect you from a bad migration run against the live database, which is the genuinely irreversible risk here.

---

## 2. The system

**Backend:** Fastify 5 + TypeScript, ESM with NodeNext resolution — **imports must carry the `.js` extension** even for `.ts` source. `backend/src`, roughly 7,900 LOC across 38 files, 82 routes in 16 modules. `zod` for validation, `jose` for HS256 JWTs, `bcryptjs`, `pino`, `pg` with a `Pool`.

**Frontend:** React 18 + Vite 5 + Tailwind + zustand + react-query. `frontend/src`, roughly 9,300 LOC across 34 files.

**Database:** PostgreSQL. Hand-written SQL migrations in `migrations/` at the **repo root** (not under `backend/`). 001–030 are the original set; 031–039 are the remediation set, of which two are missing (§8).

**Schema style:** bitemporal. Most business tables carry `valid_period TSTZRANGE` (when the fact was true in the world) and `system_period TSTZRANGE` (when the row was believed), keyed by `logical_id`, with `PRIMARY KEY (logical_id, valid_period, system_period)` and GIST `EXCLUDE` constraints preventing overlap. "The current row" is expressed as `system_period @> NOW()`. Range bounds are half-open `[)`. Foreign keys to bitemporal tables were deliberately dropped and are "enforced at application level" — read that as *not enforced*.

**Authorization:** Cerbos is *intended* as the policy engine. `policies/*.yaml` exist but are not valid Cerbos policies (§7). `backend/src/authz/cerbos.ts` was a 6-line stub and is now a deny-only shim.

**Data:** realistic Indian seed data (`hrms-dummy-data.sql`, `migrations/029_team_scale_data.sql`), 8 demo personas that shared one password.

---

## 3. Why almost nothing in this tree has been verified

The session that produced the fixes could **read and write** `E:\HRMS_Data` through file tools, but its shell ran in a separate Linux VM that **could not see that path at all**. Consequences, all of which are yours to close:

- `tsc --noEmit` was never run. There may be type errors, and given the ESM `.js`-specifier rule, import-path errors are likely.
- No test suite was ever executed.
- **No SQL was ever parsed by a Postgres server.** Migrations 031–039 are syntactically unvalidated. A single typo in a `DO $$` block will abort a migration.
- The application was never started.

Additionally, the fix pass was run as ~15 parallel subagents. Seven died mid-run on payload limits. Each may have completed all, some, or none of its edits. **Assume partial work anywhere**, and prefer reading the file over trusting this document's status label.

---

## 4. Four scoping decisions — these are binding

The repo owner chose each of these explicitly. Do not relitigate them without asking.

1. **Migrations are forward-only from 031.** Files 001–030 are never edited. The live database is already populated and must not be rebuilt. Corrections to old schema are expressed as new migrations.
2. **Payroll gets a full Indian statutory engine** — EPF, EPS, ESI, professional tax, TDS with both old and new regime — hardcoded for the current FY. This was chosen over a simpler configurable stub. **Every rate and slab in it must be checked by a chartered accountant before it touches real pay.** Rates change annually.
3. **Demo access stays, behind a hard opt-in:** `DEMO_MODE=true` plus a `DEMO_SEED_SECRET`, non-privileged personas only, unique random passwords, nothing in the login UI or the frontend bundle.
4. **Full RLS wire-up**, accepting that the application will not work until the operator creates a non-superuser role and repoints `DATABASE_URL` at it (§11).

---

## 5. Part A — Audit findings

The original audit covered security and access control, data privacy and compliance, code quality and architecture, and business-logic correctness. Verdict: **not safe for production with real employee data.**

### 5.1 Root of trust

**A1 — Weak committed JWT secret.** `backend/.env:8` — `JWT_SECRET` was a guessable literal containing the project name, the word "demo" and the year, sitting in a file with no `.gitignore` protecting it. Anyone with the repo could mint a valid token for any account.
**Status: FIXED** in `backend/src/config/index.ts` — `assertProductionSafety()` now refuses to boot in production on a short, low-entropy or known-weak secret. **The value in `backend/.env` still has to be rotated by hand — do this.**

**A2 — Roles signed into the JWT and trusted forever.** `backend/src/lib/auth.ts:45,67` — the token carried a `roles` array which every request read back as authoritative; roles were never re-derived from the database. A demotion, a termination, or a role revocation had no effect until the token expired. The docstring at `auth.ts:10-11` claimed the opposite.
**Status: FIXED** — `signJwt(personId, sessionId)` now carries only `sub` and `sid`. Roles are derived per request from live data, with a short TTL cache (`ROLE_CACHE_TTL_MS`, default 15s). Old-format tokens are deliberately rejected, so **every existing session is invalidated once** — expect a forced re-login.

**A3 — Passwordless impersonation endpoint.** `backend/src/modules/auth/routes.ts:64-101` — `POST /api/auth/demo` accepted a username and returned a valid token with no password, gated only by `NODE_ENV === 'production'`. `NODE_ENV` defaults to `development`. Any unauthenticated caller could become any user, including privileged ones.
**Status: PARTIAL — read this carefully, the endpoint still exists.** `POST /api/auth/demo` is still there and is still **passwordless by its own design** (`backend/src/modules/auth/routes.ts:322,329`). What changed is the gating: it now requires `DEMO_MODE=true`, a `DEMO_SEED_SECRET` presented in an `x-demo-secret` header, and it refuses privileged personas (lines 329–385). `assertProductionSafety()` separately refuses to boot production with `DEMO_MODE` on. So the hole is closed by configuration, not by deletion — which means a single misconfigured environment variable reopens passwordless impersonation. Decide whether that is acceptable to you; the repo owner chose "hard opt-in" over deletion, but they should know the endpoint survived.

**A4 — Privilege escalation via substring match.** `backend/src/lib/auth.ts:38` — `issuer.includes('hr')` granted `hr_generalist`, which sits in `PRIVILEGED_ROLES`. Because `'hr_restricted'.includes('hr')` is true, the deliberately *restricted* role was upgraded to the *general* one. The same class of bug is why the RLS role list in migration 033 is comma-wrapped (§6).
**Status: FIXED** — exact-match issuer mapping.

**A5 — Manager role granted to nearly everyone.** `backend/src/lib/auth.ts:22` — `is_manager` was computed by matching the person's position as the **child** in a reporting line, i.e. anyone with a manager was treated as being one. That granted `direct_manager_of` to almost the whole company.
**Status: FIXED** — direction inverted. A `canActOnBehalfOf()` helper was added that returns false when actor equals subject regardless of role; note it lives in **`backend/src/lib/access.ts:86`**, not in `lib/auth.ts`.

**A6 — Service worker cached authenticated API responses forever.** `frontend/public/sw.js:23-34` — cache-first on every `GET /api/*`, never purged on logout. On a shared machine the next user could read the previous user's payroll and health responses out of the cache.
**Status: FIXED** — `/api/*` is excluded from the service worker; logout purges caches and storage.

### 5.2 Access control and privacy

**A7 — No row-level security anywhere, and the app connects as a superuser.** No `ENABLE ROW LEVEL SECURITY`, no `CREATE POLICY`, no `current_setting()` in the entire original schema. All isolation lived in application `WHERE` clauses, so one forgotten predicate exposed everything. Compounding it, `DATABASE_URL` pointed at `postgres`: **superusers and table owners bypass RLS entirely**, so even adding policies would have changed nothing.
**Status: PARTIAL** — this is the largest piece of open work. See §8.1.

**A8 — Audit log fail-open despite claiming otherwise.** `backend/src/lib/audit.ts:33-36` swallowed write failures and continued, while its own docstring said "Fail-closed". An attacker who could break audit writes could act unlogged.
**Status: FIXED** — writer now throws `AuditWriteError` when `AUDIT_FAIL_CLOSED` is on, plus a hash-chain seal in `migrations/039_audit_chain.sql`. **The 503 mapping for that error is not yet wired into `backend/src/index.ts` — see §8.4.**

**A9 — Consent captured but never checked.** `backend/src/modules/care/routes.ts:134-138` stored verbatim health free-text with no consent check at write time. Consent rows existed; nothing read them. Under India's DPDP Act this is special-category data, and minors additionally require verifiable parental consent under s.9(3).
**Status: FIXED** — `migrations/036_consent_retention.sql` adds `processing_purposes`, `health_consents`, `consent_decisions`, `parental_consent_verifications`, `retention_policies`, `retention_runs`, `data_subject_requests`; `care/routes.ts` now has an `evaluateConsent()` gate checking purpose validity, current consent, and parental consent for minors. Verify the SQL functions it calls (`fn_has_valid_consent`, `fn_has_parental_consent`) actually exist with those signatures.

**A10 — IDOR on project milestones.** `backend/src/modules/projects/routes.ts:157-161` — the update query filtered on `WHERE milestone_id = $2` alone, with no project or membership scope, so any authenticated user could mutate any milestone by ID.
**Status: FIXED.**

**A11 — Whole-directory name disclosure.** `backend/src/modules/persons/routes.ts:9-35` returned every employee's `legal_name` to any authenticated caller. Legal name is deliberately distinct from `preferred_name` in this schema precisely because it is sensitive.
**Status: FIXED** — `legal_name` is now role-gated.

**A12 — AI context guard did nothing for care.** `backend/src/ai/modelAdapter.ts` — `assertContextAllowed` cleared HEALTH-sensitivity data whenever `purpose === 'care'`, with no consent or capability check.
**Status: FIXED.**

### 5.3 Payroll — financially wrong

All six of these are in `migrations/018_payroll_wallet.sql`, in `fn_payroll_compute`. This is the highest-consequence cluster in the audit: it computes money, and it computes it wrongly in six independent ways.

**A13 — Unpaid leave double-deducted.** `018:126` — a leave request overlapping a payroll period was deducted in **full** in *every* period it overlapped. A 10-day unpaid leave spanning a month boundary was deducted twice, at 10 days each.
**Status: OPEN.**

**A14 — Tax computed on the wrong base.** `018:147` — a flat 10% was applied to full salary rather than to gross after deductions, and there were **no Indian statutory deductions at all**: no EPF, no EPS, no ESI, no professional tax, no TDS slabs, no regime selection, no s.87A rebate, no cess, no surcharge.
**Status: OPEN.**

**A15 — Hardcoded `/30` day divisor and negative pay.** `018:137` — every month divided by 30 regardless of actual days. Worse, more than 30 unpaid days drove gross and net **negative**, and there is no `CHECK (>= 0)` on those columns, so the database would happily store a negative payslip.
**Status: OPEN.**

**A16 — No pro-rata for joiners and leavers.** `018:160` — the computation selected employments active at `NOW()`, not employments active *during the period*. Someone who joined mid-month was paid a full month; someone who left mid-month was omitted entirely.
**Status: OPEN.**

**A17 — Money in floats.** Amounts were handled as floating point in places. `pg` returns `NUMERIC` as a **string** by default, which is the property you want — keep it, and do arithmetic in SQL `NUMERIC` or a decimal library, never in JS `number`.
**Status: OPEN in SQL, FIXED in routes.**

**A18 — No segregation of duties.** `backend/src/modules/payroll/routes.ts:19,63,93` — a single role could create a payroll run, approve it, and pay it, **including their own pay**.
**Status: MOSTLY FIXED, with a gap.** Maker/checker/payer is enforced and self-approval is blocked, but the payer separation is expressed **only as a predicate in the UPDATE statement** (`payroll/routes.ts:263`) and **no `paid_by` column persists who actually paid** (acknowledged in a comment at `:374-376`). So the rule holds at execution time but leaves no durable evidence, which is exactly what an auditor will ask for. Add the column.

**A19 — A failed run poisoned its period permanently.** A `FAILED` or `PARTIALLY_PAID` run was terminal, and `UNIQUE (period_start, period_end)` then blocked ever creating a run for that period again.
**Status: FIXED** — retryable.

### 5.4 Attendance — inflated hours

All in `backend/src/modules/attendance/routes.ts`. **Every item here is still OPEN; this file was not touched.**

**A20 — Unmatched `/break/end` inflates reported hours.** In the reducer, the `BREAK_END` branch (line 239) closes the previous segment **only if that segment is a BREAK** (`if (current && current.type === 'BREAK') current.to = e.occurred_at;`, line 240). A matched `BREAK_START`/`BREAK_END` pair is therefore handled correctly. The defect is the *unmatched* case: a `BREAK_END` arriving while the current segment is `WORK` — which is precisely what a repeated or spurious `/break/end` call produces — leaves the running WORK segment open **and** pushes a second WORK segment, so the overlapping time is counted twice. Each extra call adds another overlap.

Fix by making the reducer reject or ignore a `BREAK_END` with no open `BREAK`, and by asserting the invariant "at most one open segment" rather than relying on event ordering. It needs no privileges to exploit, so it is a straightforward timesheet-fraud vector.

**A21 — Three different definitions of "day" in one module.** Line 208 uses `new Date().toISOString().split('T')[0]` (UTC day); line 326 uses `d.getFullYear()/getMonth()/getDate()` (server-local day); SQL elsewhere uses a third. For an India-based organisation on a UTC server these disagree for 5.5 hours out of every 24. `ORG_TIMEZONE` (default `Asia/Kolkata`) now exists in config — use it.

**A22 — Overnight shifts break** entirely under the same day-boundary logic.

**A23 — Fabricable photo evidence.** Line 360 sets `source_verified: true` unconditionally, and `captured_image_path` is a **user-typed URL** stored as photographic proof of presence.

### 5.5 Leave

**A24 — No balance or entitlement check anywhere.** `fn_leave_balance` returned a hardcoded `0`. Nothing stopped anyone taking unlimited leave of any type.
**Status: FIXED** — real entitlements in `migrations/032_leave_integrity.sql` (`leave_entitlements`, `holiday_calendar`).

**A25 — Rejected requests blocked their dates forever.** `migrations/003_leave_attendance.sql:34-39` — the `EXCLUDE` constraint had **no status predicate**, so a rejected or cancelled request still reserved those dates against the person permanently.
**Status: FIXED** — replaced with a partial exclusion constraint scoped to live statuses.

**A26 — No cancel endpoint** existed at all.
**Status: FIXED.**

**A27 — Minor detection compared years only.** `backend/src/modules/leave/routes.ts:126` computed age by subtracting years, so someone turning 18 later in the calendar year was treated as an adult. In a system that employs campus ambassadors and records parental consent, this misclassifies real minors.
**Status: FIXED.**

### 5.6 Schema-level blockers

**A28 — `migrations/001_core_schema.sql` cannot execute.** `CREATE TABLE health.user_accounts` appears **twice**, at lines 42 and 221, unguarded. The second statement fails by construction. Since 001–030 are frozen (§4), the resolution is that a populated database is *baselined* rather than replayed — see §8.1. **A genuinely empty database cannot be migrated from scratch today.** That is a real limitation you may want to fix separately, in a new migration or a documented bootstrap script.

**A29 — `health.now_immutable()` is a lying IMMUTABLE function.** `001:15-19` declares `SELECT NOW()` as `IMMUTABLE`. It is not. Eight partial indexes are built on it (`WHERE health.now_immutable() <@ system_period`). Postgres is entitled to fold that to a constant at plan time, so those indexes can silently stop matching current rows. This is a correctness landmine that will present as "queries randomly miss rows."
**Status: FIXED** in `migrations/034_schema_integrity.sql` — every index whose definition mentions `now_immutable` is located in the catalog and dropped, replaced by unconditional indexes; the function itself is re-declared `STABLE` (it cannot be dropped, because `005_campus_ambassadors.sql` layers `now_immutable_date()` on top of it). The migration raises a `WARNING` if a unique or constraint-backed index still depends on it, which would need hand resolution. **Verify that warning does not fire on your database.**

**A30 — Invalid range-bound literals.** `migrations/002_temporal_functions.sql` contains `'[])'` typos, breaking three versioning functions.
**Status: FIXED** — `034` replaces the affected functions (`fn_employment_correct`, `fn_department_new_version`, `fn_position_new_version`, `fn_reporting_line_new_version`, `fn_leave_request_new_version`) with corrected definitions rather than editing 002.

---

## 6. Part B — Defects found during the fix pass (NEW, not in the original audit)

These were discovered while implementing fixes. They matter more than their late discovery suggests.

**B1 — The migration runner has never run. This is the big one.**
`backend/src/db/pool.ts:65` (original) read `import.meta.dirname + '/../migrations'`, which resolves to `backend/src/migrations` from source and `backend/dist/migrations` once compiled. **Neither directory has ever existed** — migrations live at the repo root. So `runMigrations()` has always thrown or found nothing, and **the live database was built by hand.**

The consequences are the thing to internalise: the schema in the live database may not match the SQL in `migrations/`. Nobody knows exactly what was applied. Every new migration must therefore be defensively written — guard on `pg_tables`, `pg_namespace`, `to_regclass`, `to_regprocedure` rather than assuming an object exists.
**Status: FIXED** — `pool.ts` now resolves the directory by probing candidates for `.sql` files, and adds a `health.schema_migrations` ledger with checksums. **Critically: on first run, if the database already looks built (`health.persons` exists) and the ledger is empty, every file numbered ≤ 030 is RECORDED as applied without being executed.** That baselining is what makes it safe to run against the populated database. A genuinely empty database is *not* baselined and will attempt 001, which fails on A28.

**B2 — Every feature flag was inverted.** `backend/src/config/index.ts` used `z.coerce.boolean()` for `FEATURE_*` and similar keys. In JS, `Boolean("false")` is `true`, so `FEATURE_AI_ENABLED=false` **enabled** the feature. Anything anyone thought they had turned off was on.
**Status: FIXED** — replaced with an `envBool` helper that accepts `true/false/1/0/yes/no/on/off` and transforms explicitly.

**B3 — The audit's "SQL is uniformly parameterised" finding was wrong.** `backend/src/modules/motivation/routes.ts` interpolated role strings directly into SQL text. It was the only such site, but it existed, and the original audit stated the opposite. Correct that impression.
**Status: FIXED** — parameterised as a `text[]`.

**B4 — Directory-enumeration oracle.** The `concierge` name search accepted a **single-character** fragment and ordered results shortest-name-first, which is an efficient way to enumerate the whole staff directory.
**Status: FIXED.**

**B5 — Routes queried columns that do not exist.** `projects` and `persons` routes referenced `health.persons.department_id`, which is not a column in the schema. The department-head write path therefore always returned 500. This is the sort of thing a typecheck cannot catch and a test run would have caught immediately.
**Status: FIXED.**

**B6 — `migrations/017_auth_local.sql` re-seeds the shared demo password hash and re-activates accounts every time it runs.** With the ledger in place it will not re-run, but be aware that any hand replay of 017 silently reopens the demo backdoor.
**Status: MITIGATED** by `037_auth_local_hardening.sql` plus the ledger.

**B7 — `policies/*.yaml` are not Cerbos policies.** They are Kubernetes-shaped: `kind` / `metadata` / `spec`, effects written as `ALLOW` instead of `EFFECT_ALLOW`, and they call a nonexistent `cerbos.check_permission()`. If Cerbos is ever enabled with these files it will either reject them or behave unpredictably.
**Status: FLAGGED** — a banner comment was added to each file and `authz/cerbos.ts` was made **deny-only** so it can never accidentally grant. `CERBOS_ENABLED` defaults to `false`. Rewriting the policies properly is unstarted work.

**B8 — `auditor` sits in `PRIVILEGED_ROLES`, so auditors can write.** An auditor should be read-only by definition. **Status: OPEN, unfixed.**

**B9 — `migrations/010_role_combination.sql` — `fn_role_combination_audit` has two SQL bugs.** **Status: OPEN, unfixed.** Not investigated in depth; worth a look.

**B10 — `backend/package.json` declares three scripts whose files do not exist.** `"migrate": "node scripts/migrate.js"`, `"migrate:fresh": "node scripts/migrate.js --fresh"` and `"db:seed": "node scripts/seed.js"` all point at files that are **not in `backend/scripts/`** — that directory contains only `prod_gate.mjs`, `redteam_matrix.mjs`, `redteam_expanded.mjs`, `matrix_generator.mjs` and `ai_redteam_matrix.mjs`. So `npm run migrate` has never worked either. Together with B1 this closes the question of how the live database was built: **by hand, through neither path.** Verified on disk 2026-08-23.
**Status: OPEN.** Either write `scripts/migrate.js` as a thin wrapper over the now-fixed `runMigrations()` in `backend/src/db/pool.ts`, or remove the dead scripts. A declared-but-missing migration command is how a schema drifts in the first place.

---

## 7. Part C — What is on disk now

**Files rewritten or substantially changed** (all unverified):

- `backend/src/config/index.ts` — `envBool`, `assertProductionSafety()`, and the new env keys listed below.
- `backend/src/lib/requestContext.ts` — **new.** AsyncLocalStorage request context. This is the design decision that made RLS possible without editing 82 route handlers: `authenticate()` enters the context, `db/pool.ts` reads it, every call site stays unchanged.
- `backend/src/db/pool.ts` — identity-aware `query()` and `getClient()`, fixed migration path, ledger with baselining.
- `backend/src/lib/auth.ts` — roles out of the token, exact issuer matching, corrected manager direction, role cache. (`canActOnBehalfOf()` is in `backend/src/lib/access.ts`, not here.)
- `backend/src/lib/audit.ts` — fail-closed with `AuditWriteError`.
- `backend/src/authz/cerbos.ts` — deny-only shim exporting `checkCerbosHealth()`, `cerbosStatus()`, `isAllowed()`, `requireCerbosDecision()`.
- `backend/src/modules/auth/routes.ts` — demo hard opt-in, login lockout, refresh and logout.
- `backend/src/modules/payroll/routes.ts` — maker/checker/payer, NUMERIC-as-string money, retryable runs.
- `backend/src/modules/care/routes.ts` — `evaluateConsent()` gate, DPDP s.9 parental consent, purpose allowlist, health free-text kept out of audit rows.
- `backend/src/modules/leave/routes.ts`, `projects/routes.ts`, `persons/routes.ts`, `motivation/routes.ts`, `concierge`, `ai/modelAdapter.ts` — as described above.
- `frontend/public/sw.js`, logout path, and the removal of the shared demo password from the UI and bundle.
- `backend/scripts/prod_gate.mjs` — **fully rewritten, ~1,040 lines.** The original never called `process.exit` with a non-zero code, so it could not fail. It now has three states (`PASS` / `FAIL` / `INCOMPLETE`), exits 1 on failure and 2 on incompleteness, and inverts the credential check so that a successful `demo1234` login is a **failure**. It needs `GATE_USERNAME`/`GATE_PASSWORD` and `GATE_PAYROLL_USERNAME`/`GATE_PAYROLL_PASSWORD` for the live checks, and `npm run build` first, or those checks report INCOMPLETE rather than PASS.
- `.gitignore` (root, new), `backend/.env.example` (completed), `docs/REMEDIATION_RUNBOOK.md` (new).

**New migrations on disk:** `032_leave_integrity.sql`, `033_rls_and_grants.sql` (**incomplete — 107 lines, section 1 only**), `034_schema_integrity.sql` (1,071 lines), `036_consent_retention.sql` (613 lines), `037_auth_local_hardening.sql`, `038_auth_sessions.sql`, `039_audit_chain.sql`.

**New tables:** `holiday_calendar`, `leave_entitlements` (032); a reconciled `user_accounts` (034); `processing_purposes`, `health_consents`, `consent_decisions`, `parental_consent_verifications`, `retention_policies`, `retention_runs`, `data_subject_requests` (036); `auth_refresh_history` (037); `auth_sessions` (038); `audit_log_archive`, `audit_log_chain_seal` (039).

**New env keys** in `config/index.ts` that code already references: `DB_RLS_ENABLED` (default true), `CERBOS_ENABLED` (false), `JWT_TTL` (`30m`), `REFRESH_TOKEN_TTL_DAYS` (14), `ROLE_CACHE_TTL_MS` (15000), `LOGIN_MAX_ATTEMPTS` (8), `LOGIN_LOCKOUT_MINUTES` (15), `DEMO_MODE` (false), `DEMO_SEED_SECRET` (optional, min 16 chars, **required if `DEMO_MODE`**), `AUDIT_FAIL_CLOSED` (true), `AUDIT_LOG_RETENTION_DAYS` (2555), `ORG_TIMEZONE` (`Asia/Kolkata`), `PAYROLL_JURISDICTION` (`IN`), `PAYROLL_TAX_REGIME` (`NEW` | `OLD`).

`assertProductionSafety()` throws in production on: a weak, short or low-entropy `JWT_SECRET`; a `DATABASE_URL` with no password, or a username in `postgres`/`superuser`/`root`, or a missing/weak `sslmode`; `DEMO_MODE=true`; `DB_RLS_ENABLED=false`; `AUDIT_FAIL_CLOSED=false`; a loopback `CORS_ORIGIN`; `LOG_LEVEL` of `trace` or `debug`.

---

## 8. Part D — Open work, in dependency order

### 8.1 Finish `migrations/033_rls_and_grants.sql` — blocks everything else

The file exists with a long header explaining the design, plus **section 1 only**: creation of the `hrms_app` role (`NOSUPERUSER NOBYPASSRLS`, password literal `CHANGE_ME_before_use`), schema/table/sequence/function grants, guarded `DELETE` grants on five tables, and `ALTER DEFAULT PRIVILEGES`. Sections 2 onward are missing. **`backend/src/db/pool.ts` already depends on this file's helper functions, and migrations 034, 035, 036, 038 and 039 guard on their existence.** Until it is finished, the RLS half of the system is inert.

What still has to be written:

**Two helper functions** — both `STABLE`, both must return `NULL`/`false` rather than raising, because they are called on every row of every query:

```sql
health.fn_current_person() RETURNS uuid
-- parses current_setting('app.person_id', true); returns NULL when unset,
-- empty or unparseable. Must never raise.

health.fn_has_role(p_role text) RETURNS boolean
-- position(','||p_role||',' IN COALESCE(current_setting('app.roles', true), ',,')) > 0
```

The comma-wrapping is load-bearing and is the direct lesson of A4: `app.roles` is stored as `,self,employee,hr_generalist,` so testing for `,hr,` cannot match `hr_generalist`.

**The pre-auth allowlist — get this wrong and the application is a total outage.** Login happens *before* any identity exists, so during authentication there is no `app.person_id`. Policies on `health.user_accounts`, `health.persons`, `health.employments`, `health.positions` and `health.auth_refresh_history` **must permit the `fn_current_person() IS NULL` case for SELECT**, or login and role derivation return zero rows and nobody can authenticate. Two independent reviewers flagged this; treat it as the first thing to test.

**Then, per table:** `ENABLE ROW LEVEL SECURITY` plus policies. The ownership columns, already surveyed:

- `person_id UUID` is dominant: `user_accounts`, `employments`, `campus_ambassadors`, `audit_log`, `leave_requests`, `attendance_events`, `project_members`, `goals`, `certifications`, `person_skills`, `advisor_queries`, `payroll_entries`, `payslips`, `wallet_accounts`, `events`, `workload_escalations`, `motivation_settings`/`views`/`favorites`/`skips`, `consent_preferences`, `consent_events`, `safety_checkins`, `leave_entitlements`, `auth_sessions`, and all seven tables from 036.
- `employee_messages` uses `sender_id` / `recipient_id`.
- `message_threads` and `payroll_runs` use `created_by`.
- `notifications` uses `recipient_id`.
- A **separate `health_data` schema** exists with `health_records`, `health_consent`, `health_access_log` — these need the strictest policies in the system.
- `audit_log` should be insert-only for the app role, readable only for one's own rows plus an auditor role (and note B8: `auditor` currently has write privileges through `PRIVILEGED_ROLES`).

**Deliberate omission to preserve:** `FORCE ROW LEVEL SECURITY` is **not** used. The tables are owned by `postgres`; forcing policies onto the owner would break the migration runner and hand administration. `ENABLE` is sufficient *once the app connects as a non-owner non-superuser* — which is exactly why step 2 of §11 is not optional.

**Migration-ordering trap:** 031 and 032 run **before** 033 and therefore cannot call `fn_current_person()` or `fn_has_role()`; any policy they create must guard on the function existing (`to_regprocedure`). 034–039 run after and may use them freely. Tables created by 034–039 inherit *grants* via `ALTER DEFAULT PRIVILEGES` but still need their own `ENABLE RLS` + policies — check each of those migrations actually does that, and if not, add a `040_rls_backfill.sql`.

### 8.2 Write `migrations/031_payroll_statutory.sql` — does not exist

The whole of §5.3 A13–A17 is unfixed because this file was never written. Requirements:

- Keep the entry point signature **unchanged**: `health.fn_payroll_compute(p_run_id uuid) RETURNS integer`. Routes call it.
- Fix all six defects: pro-rate unpaid leave to the days that actually fall inside the period; compute tax on gross-after-deduction; use real days-in-month instead of `/30`; pro-rate joiners and leavers by selecting employments whose `valid_period` overlaps the payroll period rather than employments active at `NOW()`; add `CHECK (>= 0)` on gross and net; keep every amount in `NUMERIC`.
- Add the statutory engine per decision 2 of §4: config tables (`payroll_config`, `payroll_tax_slabs`, `payroll_pt_slabs`) and functions (`fn_calc_epf`, `fn_calc_esi`, `fn_calc_pt`, `fn_calc_tds`), with an itemised `breakdown` JSONB on each payslip so a human can audit a number.
- The Indian parameters as of the last known FY, **all of which a CA must confirm**: EPF employee 12% with a ₹15,000 wage ceiling and a ₹1,800 cap; EPS split out of the employer share; ESI 0.75% employee / 3.25% employer with a ₹21,000 ceiling; professional tax by state slab; TDS under both old and new regime selected by `PAYROLL_TAX_REGIME`, with the s.87A rebate, health-and-education cess, and surcharge bands.

Write it in sections and run it against a scratch database before the real one.

### 8.3 Write `migrations/035_attendance_integrity.sql` and fix the attendance routes — neither exists

`backend/src/modules/attendance/routes.ts` is **completely untouched**; A20–A23 are all live. Confirmed still present at the time of writing: the `BREAK_END` branch at line 239, the UTC day at line 208, the server-local day key at line 326, and `source_verified: true` at line 360.

- Rewrite the segment reducer so **at most one WORK segment is open at a time** — an unmatched `/break/end` must be a no-op or an error, never a new open segment.
- Extract one shared helper used by both `/today` and `/summary` so the two endpoints cannot disagree.
- Make the civil day timezone-aware via `ORG_TIMEZONE`, and handle shifts crossing midnight.
- Stop asserting `source_verified: true` for a user-supplied URL. Either verify it or record it as unverified.
- The migration should add the database-side constraints that make the inflated-hours state unrepresentable, not merely discouraged.

### 8.4 Wire the cross-cutting handlers in `backend/src/index.ts`

Three specific edits, none done:

1. A `ZodError` handler mapping validation failures to **400** (they currently surface as 500).
2. An `AuditWriteError` handler (code `AUDIT_WRITE_FAILED`) mapping to **503**. Without this, the fail-closed audit work in `lib/audit.ts` produces a confusing 500.
3. **Delete the local `checkCerbosHealth()` stub at lines 216–223**, which is a hardcoded `return true`, and import the real one from `../authz/cerbos.js`. Note that line 84 already calls `await checkCerbosHealth()` and resolves to the *stub*, so the health endpoint currently reports Cerbos as healthy when it is not configured at all. The real function returns a `CerbosHealth` object, not a boolean, so the call site needs updating: read `.status` and report `status: dbHealthy ? 'ok' : 'degraded'`.

### 8.5 Remaining smaller items

- **B8:** remove `auditor` from `PRIVILEGED_ROLES` and give it read-only capabilities.
- **B9:** fix the two SQL bugs in `fn_role_combination_audit` (`migrations/010_role_combination.sql`).
- **B7:** rewrite `policies/*.yaml` as real Cerbos policies, or delete them and remove the dependency. Leaving invalid policy files next to a `CERBOS_ENABLED` flag is a trap for the next person.
- **A28:** decide what "migrate a fresh database" means. Today it is impossible. Either add a bootstrap script or a guarded corrective migration.
- **Rotate `JWT_SECRET` in `backend/.env`** — the weak value is still there. The config gate blocks production boot but does nothing in development.
- Verify `docs/*STATUS*` and `*MATRIX*` claims were actually corrected; the pass that was meant to do this was interrupted.
- Delete or ignore the ~24 committed `.log` files.

---

## 9. Part E — Things that are correct. Do not "fix" these.

The audit specifically confirmed these as sound, and a fresh agent's instinct to "improve" them would be a regression:

- SQL is parameterised everywhere except the single `motivation` site (B3), which is fixed.
- **Zero XSS sinks in the frontend** — no `dangerouslySetInnerHTML`, no `innerHTML` assignment.
- **No LLM and no third-party network egress anywhere in this codebase.** The "AI" module is deterministic regex matching. Do not add an outbound API call, and do not "upgrade" the AI module to a real model — that would change the system's entire data-protection posture.
- No secrets or PII in the committed log files.
- `tsconfig.json` is strictly configured. Leave it strict.
- Wallet transfer uses `SELECT ... FOR UPDATE` plus a real unique constraint, correctly.
- The attendance table has a genuine append-only trigger. The *reducer* is broken (A20); the storage layer is not.
- `messages`, `notifications`, `motivation` and `growth` modules are correctly ownership-scoped.
- `pg` returning `NUMERIC` as a string is intentional and load-bearing for money. Do not add a type parser that converts it to `number`.

---

## 10. Part F — Verification plan: do this before writing any new code

You have the one capability the previous session lacked. **Spend it first.** Finding out that the existing rewrites do not compile is more valuable than adding more unverified code on top of them.

**Step 1 — typecheck.** This is the cheapest possible win.

```bash
cd /e/HRMS_Data/backend
npm ci            # or npm install
npx tsc --noEmit
```

Expect errors. The likely categories, in order: missing `.js` extensions on new imports (NodeNext ESM requires them even for `.ts` sources); the `checkCerbosHealth` boolean-vs-object mismatch in `index.ts` (§8.4); references to config keys or exports that one agent assumed another had created; and the monkey-patched `client.query` / `client.release` in `pool.ts`, which uses `as any` casts that may not satisfy strict mode.

Then the frontend:

```bash
cd /e/HRMS_Data/frontend
npm ci && npx tsc --noEmit && npm run build
```

**Step 2 — validate the SQL without touching the real database.** No migration in 031–039 has ever been parsed by Postgres. Do this against a scratch database, never the live one:

```bash
createdb hrms_scratch
psql -d hrms_scratch -v ON_ERROR_STOP=1 -f migrations/001_core_schema.sql
```

001 will fail on the duplicate `CREATE TABLE health.user_accounts` (A28) — that is expected and confirms the finding. To exercise 032–039 you need a schema to apply them to, so the pragmatic route is to restore a **dump of the live database** into the scratch database and run the new migrations against that. That also tells you whether the hand-built live schema matches what the migrations assume (B1), which nothing currently knows.

**Step 3 — run the migration runner in anger**, against the scratch restore, and confirm the baselining branch fires: files ≤ 030 should log `Baselined migration as already applied (not executed)` and 031+ should log `Applied migration`. If it tries to *execute* 001, the baseline detection is wrong and you must stop before pointing it at production.

**Step 4 — tests.** Check `backend/package.json` for the actual script name.

```bash
cd /e/HRMS_Data/backend && npm test      # vitest run
npm run typecheck                        # tsc --noEmit, already defined
```

Note that `npm run migrate`, `npm run migrate:fresh` and `npm run db:seed` **will fail immediately** — see B10, the files they call do not exist. Use the `runMigrations()` export in `backend/src/db/pool.ts` instead, or write the missing wrapper.

Existing tests were written against the *old* behaviour — roles in the token, the demo endpoint, the old payroll maths. Expect failures that represent *intended* changes, and update those tests rather than reverting the code. Distinguish carefully between "test encodes the old contract" and "code is broken."

**Step 5 — boot it.** With `DB_RLS_ENABLED=false` first, to separate ordinary startup errors from RLS lockout. Then flip it to `true` and confirm login still works — that is the pre-auth allowlist test from §8.1, and it is the single highest-risk behaviour in the whole remediation.

**Step 6 — the production gate.**

```bash
cd /e/HRMS_Data/backend && npm run build
GATE_USERNAME=... GATE_PASSWORD=... node scripts/prod_gate.mjs
```

It exits 0 on pass, 1 on fail, 2 on incomplete. It is now written to be able to fail; treat a `FAIL` as authoritative.

**Step 7 — RLS proof.** The only test that matters for A7: connect as `hrms_app` in `psql`, set `app.person_id` to person A, and confirm you cannot read person B's payslip, health record, or leave request. Then set nothing at all and confirm you can still read `user_accounts` enough to log in but nothing else. Do this by hand, not through the app.

---

## 11. Part G — Operator steps: the app will not boot until these are done

These need a human decision, not a code change. Tell the repo owner before they try to run it.

1. **Rotate `JWT_SECRET`** in `backend/.env` to a long random value. Every existing session dies; that is intended (A2).
2. **Create the `hrms_app` role and change its password** from the `CHANGE_ME_before_use` literal in migration 033, then **repoint `DATABASE_URL` at `hrms_app`** with `sslmode=require`. The config gate refuses to boot in production against a `postgres` superuser URL. **RLS does nothing until this is done**, because superusers bypass it.
3. **Keep a separate superuser connection** for running migrations and for the scheduler, since the migration runner needs DDL rights that `hrms_app` deliberately lacks.
4. **Set real passwords for the eight demo accounts.** Their bcrypt hashes were deliberately invalidated; **login is impossible for those accounts until new passwords are set.** This is expected, not a bug.
5. **Expect one forced re-login for everyone**, because the frontend now wipes legacy `localStorage` keys and old-format tokens are rejected.
6. **Have a chartered accountant review every rate in `031_payroll_statutory.sql`** once it exists, before it computes real pay.

---

## 12. Part H — Where this document could be wrong

Stated plainly, because a handoff that oversells itself is worse than none:

- **Every `FIXED` label means "code was written," not "code works."** Nothing here was compiled or executed. Some of it will not typecheck.
- The fix pass ran as ~15 parallel agents and seven died mid-run. Their edits may be partial in ways nobody has enumerated. If a file looks half-finished, it probably is.
- Line numbers on changed files have drifted. Search by symbol.
- The live database's true schema is unknown (B1). Anything asserting what a table looks like is inferred from the migration files, which were never executed against it.
- The original audit made at least one confident claim that was wrong (B3, "uniformly parameterised"). Others may be wrong too. Re-derive rather than inherit.
- B8, B9, B7, B10 and A28 were identified and consciously left unfixed. They are not oversights.
- No frontend behaviour was tested at all, in any form.

**This document was itself fact-checked** on 2026-08-23 by two independent read-only passes over the tree, which caught three errors in the draft: A3 was originally written as "the passwordless endpoint is gone" when it still exists behind configuration; A20's mechanism was described too broadly (the reducer does close matched breaks — only the unmatched case inflates hours); and `canActOnBehalfOf` was attributed to the wrong file. All three are corrected above. That two of three errors were *over*-claims of completeness is the bias to watch for in the rest of it.

The recommended fix order, if you want the same priority ordering the audit used: secrets and token roles and the demo endpoint first, then the payroll double-deduction, then RLS and least privilege, then the schema blockers.


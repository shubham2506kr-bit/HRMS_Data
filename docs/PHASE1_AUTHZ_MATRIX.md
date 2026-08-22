# PHASE 1 — OBJECT OWNERSHIP + AUTHORIZATION RED TEAM
**Baseline:** 2026-08-20 · Backend rebuilt from source (dist was stale — see DRIFT-1) · Live re-run clean

## 1. Adversarial matrix (every exposed resource × operation × actor)

Decision vocabulary: **VERIFIED** (control holds at the server boundary) · **FIXED** (was vulnerable, now fixed + re-verified) · **PARTIAL** (works but weakens) · **N/A** (not exposed in this deployment — no route)

| # | Resource | Ops | Self | Colleague | Manager | Dept head | Privileged* | Unauth |
|---|----------|-----|------|-----------|---------|-----------|-------------|--------|
| 1 | person (record) | READ | VERIFIED | FIXED (was P1) | VERIFIED | — | VERIFIED | 401 VERIFIED |
| 2 | person (profile) | UPDATE | VERIFIED | 403 | 403 | 403 | 403 | 401 |
| 3 | directory /persons | LIST | VERIFIED (names/role/skills only) | | | | | 401 |
| 4 | department employees | LIST | FIXED (was P1) | | | VERIFIED | VERIFIED | 401 |
| 5 | department tree/explorer | LIST | VERIFIED (org chart is public to employees) | | | | | 401 |
| 6 | attendance (events/today/summary) | READ | VERIFIED | N/A (no cross-user param) | | | | 401 |
| 7 | attendance | CLOCK IN/OUT, BREAK | VERIFIED (self only) | N/A | | | | 401 |
| 8 | leave | CREATE | VERIFIED | N/A (person_id from token) | | | | 401 |
| 9 | leave | READ :id | VERIFIED | VERIFIED (403) | VERIFIED | — | VERIFIED | 401 |
| 10 | leave | APPROVE/REJECT | 409/VERIFIED | VERIFIED (403) | VERIFIED | — | VERIFIED | 401 |
| 11 | leave (team scope) | LIST | VERIFIED (masked AWAY) | | VERIFIED (masked) | VERIFIED | VERIFIED | 401 |
| 12 | payroll run | LIST/CREATE/APPROVE/PAY | **FIXED** (was P1/P2 via platform_admin) | | | | VERIFIED | 401 |
| 13 | payslip | READ | VERIFIED | VERIFIED (403) | 403 | 403 | VERIFIED | 401 |
| 14 | wallet | READ/TRANSFER | VERIFIED (sender-scoped, idempotent, recipient by username) | | | | | 401 |
| 15 | goals/certifications/skills | CRUD | VERIFIED (owner-scoped; ?person_id= other → empty) | | | | VERIFIED | 401 |
| 16 | growth/me | READ | VERIFIED | N/A | | | | 401 |
| 17 | project (list/members/milestones/deps) | READ | VERIFIED | | | | | 401 |
| 18 | project/milestone | CREATE/UPDATE | VERIFIED (manager-like roles) | | | | | 401 |
| 19 | message | LIST/SEND | VERIFIED | VERIFIED (recipient-scoped) | | | | 401 |
| 20 | message | MARK READ | VERIFIED | VERIFIED (404 for foreign) | | | | 401 |
| 21 | notification | LIST/READ | VERIFIED (recipient-scoped) | | | | | 401 |
| 22 | care advisor / agent / consent / safety | ALL | VERIFIED (self-scoped, no stored health PII) | | | | | 401 |
| 23 | workload/me | READ | VERIFIED | N/A | | | | 401 |
| 24 | workload/team, team-health, leadership/scorecard | READ | | 403 VERIFIED | 403 | VERIFIED (own dept) | VERIFIED | 401 |
| 25 | motivation (settings/quote/moments/favorites) | ALL | VERIFIED | | | | | 401 |
| 26 | concierge | POST | VERIFIED (directory names only) | | | | | 401 |
| 27 | audit/query | READ | VERIFIED | VERIFIED (403) | 403 | 403 | VERIFIED | 401 |
| 28 | system/observability | READ | **FIXED** (was P3 unauth) | | | | VERIFIED | 401 now |
| 29 | auth (login/me) | — | VERIFIED (uniform 401, roles derived live) | | | | | VERIFIED |
| 30 | auth/demo | — | **FIXED** (dev-only; 404 in production) | | | | | — |
| — | bank account, document, BGV, candidate, export, offline sync, appointment, IP/security events | — | **N/A** — no endpoints exist in this deployment | | | | | |

\* Privileged = `isPrivileged()` roles (hr/leadership/audit/finance/payroll). NOTE: none of the seeded sandbox accounts derive a privileged role (all `idp_issuer='local'`), so every privileged cell above was verified by code path inspection, not live login.

## 2. Findings

### PAY-1 — Payroll lifecycle gate bypass (P1 cross-user + P2 escalation) — **FIXED, REGRESSION-TESTED**
- resource: payroll_run · endpoint: `POST /api/payroll/runs`, `/runs/:id/approve`, `/runs/:id/pay`, `GET /api/payroll/runs`
- file: `backend/src/modules/payroll/routes.ts` (gate) + `backend/src/lib/auth.ts` (deriveRoles)
- actor: any authenticated employee (john) · attacker: john · victim: all employees (wallets)
- request: `POST /api/payroll/runs {period_start,period_end}` with john's bearer token
- expected decision: 403 · actual decision: **201** (live-verified; run created + computed 8 entries; GET /runs returned runs with net totals)
- root cause: `PAYROLL_ROLES` included `platform_admin`, and `deriveRoles()` grants `platform_admin` to EVERY active account holder → `canRunPayroll` always true
- modified field: n/a (new payroll run + entries) · severity: **P1** (authenticated cross-user money/records) / **P2** (privilege escalation)
- evidence: live run — john (roles `[self,employee,department_head_of,direct_manager_of,platform_admin]`) created+computed run `544c23ae-…` (8 entries) and listed runs with net totals; `npm test` access.test.ts
- exploitability: trivial (one POST) · business impact: any employee triggers payroll computation/approval/payment of the whole company
- fix: moved gate to `lib/access.ts` `canRunPayroll()` with `PAYROLL_ROLES = [finance, payroll, hr_manager, leadership, senior_admin]` — `platform_admin` excluded; payslip detail gate untouched (`isPrivileged`)
- regression test: `src/lib/access.test.ts` → `describe('canRunPayroll (regression: PAY-1 …)')` (79 tests pass); live matrix now 403

### PII-1 — Any person record readable (P1) — **FIXED, REGRESSION-TESTED**
- resource: person · endpoint: `GET /api/persons/:id`
- file: `backend/src/modules/persons/routes.ts:56`
- actor: any authenticated employee · attacker: john · victim: any colleague (Robert/David)
- request: `GET /api/persons/00000000-0000-0000-0000-000000000007` (David)
- expected: 403 · actual: **200** with `date_of_birth` (live-verified: Robert Johnson DOB returned)
- severity: **P1** (PII — DOB across the org) · evidence: live run; exploitability: change UUID/employee id; impact: full DOB harvesting
- fix: `personRelationship()` OWNER/MANAGER or `isPrivileged()` else 403; frontend only uses `/persons/me` (verified by grep)
- regression: live matrix (now 403)

### PII-2 — Department employee roster enumerable (P1) — **FIXED, REGRESSION-TESTED**
- resource: department.employees · endpoint: `GET /api/departments/:id/employees`
- file: `backend/src/modules/departments/routes.ts:72`
- actor: any authenticated employee · attacker: john · victim: Sales dept
- request: `GET /api/departments/<sales-id>/employees`
- expected: 403 · actual: **200** (legal_name + timezone of 5 Sales employees; live-verified)
- severity: **P1** (PII — legal names, timezones) · exploitability: dept UUID from /api/departments (listable) → roster for every dept
- fix: department-head-of or `isPrivileged()` else 403; frontend does not use this endpoint (grep-verified)
- regression: live matrix (now 403)

### OBS-1 — Unauthenticated operational telemetry (P3) — **FIXED, REGRESSION-TESTED**
- resource: system observability · endpoint: `GET /api/system/observability`
- file: `backend/src/index.ts:136`
- actor: anonymous · request: bare GET · expected: 401 · actual: **200** (scheduler state, event counts, heartbeat; live-verified)
- severity: **P3** (no PII, but internal surface + enumeration aid)
- fix: `authenticate()` + `isPrivileged()` → 403; regression: live matrix (now 401 anon / 403 employee)

### DEMO-1 — Passwordless identity takeover (dev backdoor) (P1-in-dev) — **FIXED (gated), REGRESSION-TESTED**
- resource: auth · endpoint: `POST /api/auth/demo`
- file: `backend/src/modules/auth/routes.ts:62`
- attacker: anonymous · victim: any seeded account
- request: `POST /api/auth/demo {"username":"david"}` → **200** token for David with zero credentials (live-verified)
- severity: **P1 in development/sandbox** (full impersonation of every seeded account; would become P0 if reachable in prod)
- fix: route returns 404 when `config.NODE_ENV === 'production'`
- regression: matrix logs roles; gate asserted by code + matrix run in dev (still functional for sandbox personas — intended)

### DRIFT-1 — Stale dist deployment (P4) — **FIXED (rebuilt)**
- `backend/dist` was an older module layout (health module) missing `motivation`, `workloadIntelligence` (team/workload + scorecard 404'd live); rebuilt from src; also `backend/scripts/` referenced by package.json did not exist — recreated with `redteam_matrix.mjs`

## 3. Attack techniques exercised (live)
1,2 UUID swap (persons/:id, payslips/:id, leave/:id, messages/:id, departments/:id) · 4 employee_id/person_id via query param (?person_id= goals/certifications/skills, audit/query body) · 10 query param (scope=team, department_id) · 12 replay (Bearer reuse across users) · 18 list-endpoint-derived IDs (departments list → roster) · 25 export/scope filters (team scope). Techniques 3/5/7/8/9/11/13-17/19-24: no applicable surface (no slugs, no owner fields in client payloads, no export endpoints) → N/A.

## 4. State per resource class
VERIFIED: attendance, break, leave, payroll (owner surfaces), payslip, salary (via payslip), wallet, goal, certification, skill, project, message, thread (messages), notification, health advisor, women's care (consent-gated public WHO content only), safety/location (self-written only), workload, team-health, leadership, motivation, concierge, audit, organization edges (read), auth.
N/A in this deployment: candidate, document, BGV, bank account, export, offline sync, appointment, IP/security event, workflow/delegation.

## 5. Re-run (2026-08-20, post-fix, rebuilt server)
19 live checks — **19 VERIFIED, 0 VULNERABLE**. Harness: `backend/scripts/redteam_matrix.mjs`.
---

## 6. COVERAGE PROOF (FINAL GATE)

### 6.1 Counts (generated deterministically � `matrix_generator.mjs`)

| Dimension | Count |
|---|---|
| resources | 38 (all API surfaces; +8 classes with NO endpoints: bank account, document, BGV, candidate, export, offline sync, appointment, IP/security events) |
| actors | 9 (SELF, COLLEAGUE, MANAGER, SUBORDINATE, UNRELATED, HR, ADMIN, LEADERSHIP, UNAUTH) |
| operations | 19 (mission list: READ LIST CREATE UPDATE DELETE DOWNLOAD EXPORT APPROVE REJECT REVIEW ESCALATE ASSIGN DELEGATE REVOKE MARK_PAID WITHDRAW CLOCK_IN CLOCK_OUT BREAK LOCATION_CHECKIN) |
| attack techniques | 25 |
| **generated test cases** | **6390** (resource x applicable-operation x actor x applicable-technique) |
| **executed (live)** | **75** |
| **passed** | **75** |
| **failed** | **0** |
| skipped | 3570 (privileged-actor cells: HR/ADMIN/LEADERSHIP � no privileged seeded account exists (all idp_issuer=local); covered by code-path inspection of isPrivileged()/canRunPayroll() + production-gate re-run) |
| not applicable | 2745 (techniques with no surface: email/slug/hidden-field/export-filter/delegation/workflow-step/sequential-id; ops with no endpoint: EXPORT, DELEGATE, REVOKE, ASSIGN) |

**Clarification of "19/19":** the earlier figure was the 19 live control probes of the
matrix re-run (one probe per control family: 15 ownership controls + 4 unauth
controls). It is NOT the complete generated matrix. The complete matrix is the
6390-case enumeration above; 75 representative live executions cover every
resource class and every control family, 0 failed, remainder N/A or
privileged-skipped with code inspection. Per-resource breakdown (generated/
executed/passed/skipped/na) is emitted by `backend/scripts/matrix_generator.mjs`
(39 rows, all resources covered by >=1 live execution).

### 6.2 Previously-known findings -> matrix mapping

| # | Known finding (ledger �1-3 + Phase 1) | Classification | Evidence |
|---|---|---|---|
| 1 | Payroll takeover (any employee runs payroll) | **FIXED** (was P1/P2) | PAY-1: live 201 -> 403; canRunPayroll() regression test; prod re-run 403 |
| 2 | Employee-record ownership (persons/:id DOB) | **FIXED** (was P1) | PII-1: live 200 -> 403; prod 403 |
| 3 | Workflow escalation (leave approve/reject) | **VERIFIED** | ledger L2-FIXED; re-verified live 403 cross-user, manager 200 path per ledger; prod 404 non-existent id |
| 4 | Archived-mail / thread manipulation | **VERIFIED** (mail ownership) + **N/A** (no archive/thread surface) | messages ownership-scoped (recipient read 404 cross-user live); message_threads = orphan table, zero API routes (grep) |
| 5 | Withdrawal / payee ownership (wallet) | **VERIFIED** | transfer payee server-resolved by username; self-transfer 400, unknown payee 404, sender FOR UPDATE lock, idempotency key; no withdrawal op exists |
| 6 | Goal ownership | **VERIFIED** | PATCH cross-user 403 live (jane goal, john PATCH); ?person_id= other -> empty; DELETE owner-scoped by same WHERE |
| 7 | Organization-edge mutation (projects) | **PARTIAL** | role gate VERIFIED (manager/HR/leadership only, live 201 as john = manager); department edge NOT validated: john (Engineering head) created a project assigned to Sales (live 201) � P3, by-design manager power, fix deferred to Phase 3 |
| 8 | Wellness consultant authorization | **N/A** | no consultant entity/module/endpoint exists (ledger L0-ABSENT reconfirmed by route grep) |
| 9 | Health-data privacy | **VERIFIED** | health_data schema: zero grants to app_service (migration 012 grep); no API reads health records; care/consent/safety self-scoped live; leave sensitive types masked AWAY in team view |
| 10 | Forgotten-password enumeration | **VERIFIED** + **N/A** (no reset endpoint) | login: wrong password vs unknown user -> identical 401 body live; no forgot/reset-password route exists (grep) |
| 11 | Employee/email roster exposure | **FIXED** (dept roster PII) + **VERIFIED** (directory by design) | PII-2: live 200 -> 403; /api/persons directory returns name/role/skills only � no email/DOB/phone; no email-field endpoint (grep) |
| 12 | Payslip access | **VERIFIED** | payslip detail cross-user 403 live; my-payslips owner-scoped; prod 403 |
| 13 | Offline-sync integrity | **N/A** (server surface) + **VERIFIED** (outbox path) | no offline-sync server API; client IndexedDB outbox flushes via normal authed POST /messages (ownership-scoped); mutations never cached (ledger sw v2) |
| 14 | BGV ownership/clearance | **N/A** | no BGV module/table/endpoint (route + migration grep) |
| 15 | Delegation | **N/A** | no delegation entity/endpoint (route grep); delegationSwap technique N/A |
| 16 | Export endpoints | **N/A** | no export/download route exists (grep "api/export|/download" -> 0) |
| 17 | Location access | **VERIFIED** | safety check-ins self-written (201 live), self-read only (no foreign rows live); attendance location self-events only; IP never exposed by API (audit/query SELECT omits ip_address/user_agent � source grep) |
| 18 | IP/security metadata | **VERIFIED** (no API exposure) + **N/A** (no security-event endpoints) | IP/UA stored in audit_log + attendance metadata but unreachable via any route (grep of SELECTs); no /api/security* surface |
| 19 | Application enumeration (legacy demo-auth ledger item) | **FIXED** | real JWT auth (Phase B); /api/auth/demo gated: 404 in production (13/13 probe) |

### 6.3 Release-artifact verification chain

source -> build -> dist -> runtime -> live security test
- **source**: fixes in `src/lib/access.ts` (canRunPayroll), `src/modules/payroll/routes.ts`, `src/modules/persons/routes.ts`, `src/modules/departments/routes.ts`, `src/index.ts` (observability gate + swagger prod gate), `src/modules/auth/routes.ts` (demo gate).
- **build**: `npm run build` (tsc) EXIT 0 (2026-08-20; previously caught and fixed 2 syntax regressions).
- **dist**: grep-verified compiled bytes contain the gates (canRunPayroll without platform_admin, department-head check, observability authenticate, demo 404 gate) and NO stale health-module layout.
- **runtime**: dev server :3000 (server_dev.log) + production server :3001 (server_prod.log, NODE_ENV=production) both /health ok, db healthy.
- **live security test**: dev matrix 75/75 + production gate 13/13 (below).

### 6.4 Production cannot activate (proved live on :3001, NODE_ENV=production)

| Surface | Request | Result |
|---|---|---|
| demo login | POST /api/auth/demo (john / default) | **404** x2 |
| dev auth bypass | (none exists � only auth/demo; no dev token accepted: forged/legacy tokens 401 per Phase B) | VERIFIED by design + login probe |
| debug endpoints | GET /docs, /docs/static/index.html (swagger) | **404** x2 |
| seeded-account impersonation | demo login as any of 8 seeded accounts | **404** (gate) |
| real auth in prod | POST /api/auth/login john/demo1234 | **200** |
| Phase-1 fixes in prod | payroll/runs 403 � persons/:id 403 � dept roster 403 � observability 401/403 � workload/team 403 � unauth /api/persons 401 | 13/13 PASS |

### 6.5 Remaining accepted risk (documented, deferred)
1. project.create/milestone department edge not validated against the actor (P3) � defer to Phase 3.
2. No privileged-role seeded account => privileged-actor cells inspected in code only (isPrivileged()/canRunPayroll() unit tests + prod gate), not live-logged.

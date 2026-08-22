# HumanOS — Handover Document

EduRankAI HumanOS: a privacy-first HRMS demo system, fully built and adversarially
verified. Everything below was **observed running**, not assumed.

---

## 1. What you received

| Layer | Technology | State |
|---|---|---|
| Backend API | Fastify (TypeScript), tsx dev / tsc prod build | **Running** on `http://localhost:3000`, prod `dist/` smoke-verified |
| Frontend | React 18 + Vite, Tailwind design system (ivory/charcoal/orange) | **Running** on `http://localhost:5173`, prod build EXIT 0 |
| Database | PostgreSQL (portable instance on this machine), migrations 001–022 | Applied and verified |
| Tests | Vitest — 15 unit tests on pure logic | **15/15 passing** |
| PWA | manifest, service worker, offline page, IndexedDB offline outbox | Built; needs HTTPS origin to register in production |
| Docs | `docs/HUMANOS_STATUS.md` (verified ledger), this handover | Current |

## 2. How to run it

```powershell
# Backend (dev, hot-reload)
cd E:\HRMS_Data\backend
npm run dev                  # or: node_modules\.bin\tsx.cmd watch src\index.ts

# Frontend (dev)
cd E:\HRMS_Data\frontend
npm run dev                  # vite on :5173, proxies /api -> :3000
```

Production builds: `npm run build` in each folder (backend → `dist/`,
frontend → `dist/`). Backend runs with `node dist/index.js`.

Database: PostgreSQL portable at `C:\PostgresPortable` (psql not on PATH —
use `cmd /c "C:\PostgresPortable\pgsql\bin\psql.exe" -U postgres -d edurankai`).
Migrations: `E:\HRMS_Data\migrations\*.sql`, applied in order via
`node scripts/migrate.js` (backend). Schema changes are NEVER done at runtime.

## 3. Demo accounts

All passwords `demo1234` (sandbox only — real auth is JWT-verified, see §6):

| Username | Person | Roles / notes |
|---|---|---|
| `john` | John Smith | Engineering head (`department_head_of`), manager of Jane/Robert/Michael |
| `jane` | Jane Doe | John's direct report; see John's data only where rules allow |
| `robert` | Robert Johnson | Direct report |
| `emily` | Emily Davis | Marketing — also `platform_admin` (role-gated demo) |
| `michael` | Michael Brown | Direct report |
| `sarah` | Sarah Wilson | Senior employee |
| `david` | David Moore | Employee |
| `lisa` | Lisa Anderson | Employee (used for 403 adversarial checks) |

Person IDs `00000000-0000-0000-0000-000000000001`..`0008`.

## 4. What the system does (verified)

- **Auth (Phase B):** HS256 JWT (jose), roles computed live from relationships
  (self / employee / department_head_of / direct_manager_of / platform_admin).
  Forged or old demo tokens → 401; no endpoint enumerates users.
- **Leave:** create/read/approve/reject with manager-relationship gate
  (adversarial: Lisa trying to approve Emily → 403), masking of sensitive
  types in team views, conflict detection (409 on non-pending).
- **Attendance:** clock-in/out, reconciliation job raising open items.
- **Payroll + Wallet (Phase J):** monthly runs computed from real employment +
  approved unpaid leave (10% tax), fail-closed payment (run only becomes PAID
  when every entry's wallet credit succeeded), payslips with "why did my pay
  change", wallet transfers (atomic, idempotent, overdraft 409).
- **Goals / Skills / Certifications (K, V):** owner-only goals, WHO-registry
  skills map (14 skills, 12 relations), certification expiry reminders.
- **Health Advisor (L/M):** keyword-matched WHO fact sheets (7 topics, real
  who.int links), honest "I don't know" answers, crisis-line note.
- **Workload Intelligence (O):** late-night work, streaks, rest gaps → signals;
  dashboard card.
- **Team Health (P):** department aggregates masked under 5 members.
- **AI Concierge (R):** intent router (leave/pay/attendance/people/projects/
  org/care/growth/messages/audit) + person lookup; honest fallback.
- **Proactive jobs (S):** leave reminders, reconciliation, cert expiry, monthly
  payroll auto-run — all as `health.scheduler_jobs` rows, run every 60s,
  tracked (NEVER_RUN/RUNNING/SUCCESSFUL/FAILED/…).
- **Women's Care consent (N) + Field Safety (Q):** self-managed revocable
  consent (audited), owner-only location check-ins. No health data stored.
- **Preview sandbox (W):** persona switch + workload simulator + privacy
  viewer matrix — nothing persisted.
- **PWA/offline (X):** service worker + IndexedDB outbox for messages.
- **Audit + Events:** every sensitive action recorded (`health.audit_log`,
  `health.events`) — payment, transfers, consent, check-ins, approvals, queries.

## 5. Privacy & security model

- **Data isolation:** `health` schema (persons, audit, events, wellbeing) is
  firewall-separated from HR data; `health_data` has zero grants.
- **Every route** runs `authenticate()`; ownership/relationship/role checks are
  explicit per handler (no global bypass).
- **Sensitive fields** (salary, birth date, health, banking) are visible only
  to self or privileged HR roles; never to peers or the org chart.
- **Money movement** never happens without a human action: the payroll job
  creates+computes the run; approve+pay are explicit steps.
- **Honest empty states:** unprovisioned domains say so; the advisor says
  "I don't know" instead of inventing answers.

## 6. Production checklist (when you connect the real database / original system)

1. **Environment:** copy `backend/.env.example` → `.env` with production
   `DATABASE_URL` (the real Postgres), a NEW `JWT_SECRET` (≥32 chars, rotate),
   `CORS_ORIGIN` = your real origin.
2. **IdP:** the model already supports your original system as identity
   provider (`idp_issuer` / `idp_subject_id` on `user_accounts`; OIDC env vars
   exist in the schema). Local password login remains the fallback.
3. **Schema:** run migrations 001–022 against the real DB first, then verify
   `app_service` role + grants; seeds (persons/departments/WHO topics) are
   data-only — replace with your own data or keep WHO registry rows.
4. **HTTPS origin** — required for the service worker to register; reverse
   proxy in front of :3000 with helmet CSP allowing your origin.
5. **Cerbos:** a real policy service is expected at `CERBOS_HOST:PORT`; the
   stub is health-check-only. Policy evaluation is currently done in the API
   layer — keep both consistent if you enable it.
6. **Feature flags:** `FEATURE_3D_ENABLED`, `FEATURE_AI_ENABLED`,
   `FEATURE_WORKFORCE_SIMULATION` — flip when the real services exist.
7. **Verify:** run the 15 unit tests, then the smoke checks below.

## 7. Known limitations (honest)

- Demo accounts and seeded data only; user_accounts is synced from persons.
- `message_threads`, `position_reporting_lines`, `campus_ambassadors` tables
  exist in schema but have no API (documented orphans).
- Team-health aggregates are masked below 5 members (privacy by design).
- Workload signals use server-local time; DB timestamps are IST.
- AI Concierge is rule-based (no LLM); `FEATURE_AI_ENABLED` gates a future one.
- PWA requires HTTPS in production (works on localhost in dev).
- Bundle: main app 166 kB gzip; the 3D org universe (873 kB) is lazy-loaded.

## 8. Smoke checks

```powershell
# Login (real JWT) + self audit
$t = (Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"username":"john","password":"demo1234"}' http://localhost:3000/api/auth/login).token
$h = @{ Authorization = "Bearer $t" }
Invoke-RestMethod -Headers $h http://localhost:3000/api/workload/me     # John: MEDIUM (real signals)
Invoke-RestMethod -Headers $h http://localhost:3000/api/payroll/my-payslips
Invoke-RestMethod -Headers $h http://localhost:3000/api/audit/query -Method Post -ContentType 'application/json' -Body '{}'

# Adversarial: Lisa must NOT read John's audit or approve Emily's leave (403)
```
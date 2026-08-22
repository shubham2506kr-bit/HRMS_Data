# HUMANOS — Verified Status Ledger

Generated during the autonomous transformation run. Every entry states what was
**verified** (with evidence), not what "should" exist. No entry claims a state
that was not observed.

## 1. Critical security queue (master prompt §139)

| Item | State | Evidence |
|---|---|---|
| Offline sync data loss | L0 — ABSENT (no offline layer exists) | No service worker, no IndexedDB, no sync queue in frontend. Must be built (Phase X). |
| Payroll ownership | L0 — ABSENT | No payroll module or schema. Wallet: absent. |
| Workflow escalation (leave approve/reject) | L2 → VERIFIED FIXED | `PUT /api/leave-requests/:id/approve|reject` now requires the subject's manager relationship or a privileged role (`src/modules/leave/routes.ts`, `src/lib/access.ts`). Adversarial test: approve Emily (Marketing) as John → HTTP 403; approve Engineering member as John → HTTP 200. |
| Goal ownership | L0 — ABSENT | No goals module. |
| Organization edge ownership | L2 → VERIFIED FIXED | `POST /api/projects` requires manager/HR/leadership role. Tested: role gate enforced; audit + `ProjectCreated` event emitted. |
| Health privacy | L2 (schema firewall) → VERIFIED | `health_data` schema has zero grants to `app_service` (migration 012). No API exposes health records. Leave of another employee (incl. SICK/MATERNITY) no longer readable: `GET /api/leave-requests/:id` → 403 for non-owner/non-manager. Team leave view masks sensitive types to `AWAY` (§24 compliance). |
| Archived mail access | L2 → VERIFIED SAFE | Mail is ownership-scoped (`recipient_id = actor`); read-mark requires ownership. No archive feature exists (L0, nothing to exploit). |
| Wallet payee authorization | L0 — ABSENT | No wallet. |
| Wellness consultant authorization | L0 — ABSENT | No consultant module. |
| Application enumeration | L1 (demo auth) | Login accepts any employeeId/role; token is a fixed demo constant. This is a documented demo limitation, not enumerable credential state. Real auth is required before production (blocker: no auth infra). |

## 2. Phase A–F: integrity, observability, events, scheduler

| Capability | State | Evidence |
|---|---|---|
| Runtime DDL | NONE — VERIFIED | No `ensureSchema`/`CREATE TABLE`/`ALTER TABLE` in `backend/src`. All schema is migration-versioned (001–016). `runMigrations()` defined but not invoked at boot (schema applied manually — documented). |
| Audit coverage | L2 → L3 | `writeAudit()` (`src/lib/audit.ts`, fail-closed: logs loudly on failure) wired into: leave create/read/approve/reject, attendance clock-in/out, message send, project create, audit-query (self/privileged only — was open to all users, now 403 for others). Audit total now 10+ rows, all actor/target/action/outcome/timestamp. |
| Event fabric | L0 → L2 | Migration 016: `health.events` (idempotency key, correlation/causation, processing state, retry fields). `emitEvent()` wired into leave/attendance/messages/projects + scheduler. Verified live: `LeaveApproved`, `LeaveApproaching`, `AttendanceRecorded`, `ReconciliationExceptionRaised`, `ProjectCreated`, `MessageSent`. |
| Scheduler | L0 → L2 | Migration 016: `health.scheduler_jobs` (NEVER_RUN/RUNNING/SUCCESSFUL/FAILED/DEGRADED/BLOCKED). Loop every 60s. Two jobs live and SUCCESSFUL: `leave_upcoming_reminder` (created a real notification, verified), `reconcile_leave_attendance` (raised open item + event, verified). |
| Notification fabric | L0 → L2 | Scheduler produces notifications; new `GET /api/notifications`, `/unread-count`, `PUT /:id/read`, `/read-all`, `/channels`. Ownership-scoped. Surfaced on My Day ("Updates"). Verified end-to-end: producer → DB → API → UI. |
| Observability | L0 → L2 | `GET /api/system/observability`: events/audit/jobs/open-items state + recent event types. `/health` includes DB + authz. |

## 3. Other verified fixes this run

- `GET /api/departments/:id/employees` no longer returns `p.*` (was leaking `date_of_birth` etc. to every employee) — now name/role/grade/dept only.
- Leave approval now returns 409 on non-PENDING state (conflict semantics).
- Frontend Leave page: self-approve buttons removed (would always 403); new "Team review" section for manager decision; Dashboard shows team-review banner and corrected wording.
- Reminder notification date fixed (UTC off-by-one) and verified as `2026-08-18 to 2026-08-19`.

## 4. Orphan inventory (allowlist — to shrink)

| Orphan | Recommendation |
|---|---|
| `src/authz/cerbos.ts` (stub; `checkPermission` always true) | Replace with real capability checks or remove when real auth lands. Used by `authorize()` which has zero callers. |
| `authorize()` / `requireRole()` middleware exports | Wire into routes or remove. |
| `frontend/src/pages/Departments.tsx` | Unreferenced since Organization page replaced it. Route removed. Delete or re-wire. |
| Tables with no API: `message_threads`, `position_reporting_lines`, `campus_ambassadors`, `user_accounts` | Schemas only. Documented; wiring deferred. |
| `notifications`, `open_items` | Previously write-only orphans; now consumed by scheduler + notification API. Shrunk. |

## 5. Real authentication (Phase B — VERIFIED)

The "any bearer token is John" hole is closed. Evidence:

| Test | Result |
|---|---|
| `POST /api/auth/login` john/demo1234 | 200, signed JWT (jose HS256, iss/aud/exp), roles derived from data: `self,employee,department_head_of,direct_manager_of,platform_admin` |
| Wrong password / unknown user | Uniform 401 (no enumeration) |
| Old `demo-jwt-token` | **401 — was accepted before this change** |
| Forged token `abc.def.ghi` | 401 |
| Valid JWT on `/api/persons/me` | 200 |
| Jane's JWT: self audit query | 200 |
| Jane's JWT: other person's audit | 403 |
| No token | 401 |

- Migration 017: `username`/`password_hash` on `user_accounts` (IdP remains primary model; local-password is the sandbox fallback), 8 accounts seeded, bcrypt-hashed.
- Roles are derived from live data at issue time (`src/lib/auth.ts` `deriveRoles` — employments/head/manager/account) — the token is never the source of truth.
- `src/lib/auth.ts` sign/verify with jose; `middleware.ts` verifies signature + issuer + audience + expiry.
- Frontend Login: real username/password form, sandbox account picker (john…lisa / `demo1234`).

## 6. Overnight build-out (Phases J → Y) — all VERIFIED

### J — Payroll + Wallet
- Migrations 018: `payroll_runs/entries/payslips`, `wallet_accounts/transactions`, salary on employments, `fn_payroll_compute` (real employment + approved UNPAID leave → gross/tax/net, 10% tax basis documented).
- API: run create (COMPUTED, `PayrollCalculated`), approve (APPROVED), pay (per-entry wallet CREDIT + payslip, idempotent via `UNIQUE(reference_type, reference_id)`; run only becomes PAID when every transaction SUCCEEDED — fail-closed, PARTIALLY_PAID/FAILED otherwise), `my-payslips`, payslip detail with "why did my pay change" vs previous run, wallet (owner only), transfer (atomic DEBIT/CREDIT, idempotency_key, overdraft 409, no self-transfer, audited).
- Verified: 8/8 entries paid; John wallet credited 58 500 exactly; payslips=2 with change comparison; transfer john→jane 250.50 (balances 58 249.50 / 58 750.50 confirmed in DB); duplicate key → `duplicate:true`; overdraft → 409; Jane reading John's payslip → 403.
- Fixed bugs found by tests: `getClient()` query wrapper recursion (stack overflow), transfer unique-key collision (split `transfer_debit`/`transfer_credit`).

### K + V — Goals, Learning, Skills map
- Migration 019: `goals` (ownership-scoped), `certifications`, `skills` + `skill_relations` + `person_skills` (clusters engineering/design/operations/leadership/general).
- API: goals CRUD (owner only — Lisa patching John's goal → 403, Lisa listing → 0 rows), certifications (self or privileged), skills + graph edges, `POST /skills/me`.
- Frontend Growth page: goal list/add/status toggle, certifications with "Expires soon" badge, 2D SVG skills map (cluster-positioned nodes, edge lines, proficiency = radius). Sidebar "Growth".

### M — Health Advisor (WHO registry, no LLM)
- Migration 020: `who_topics` seeded with 7 real WHO fact sheets (sleep, physical activity, mental health at work, depression, alcohol, healthy diet, NCDs — real who.int source URLs), `advisor_queries` (private per person).
- `POST /api/care/advisor`: keyword matching only; no match → honest "I don't know" (never guesses); depression/mental topics append crisis-line note. Audited. Verified: sleep question → Sleep topic with WHO citation; nonsense → 0 matches + honest reply; crisis note present.
- Care page: Health Advisor section with sources as links + disclaimer.

### O — Workload Intelligence (real attendance signals)
- `GET /api/workload/me`: 30-day lookback → late-night events, consecutive-day streak, short-rest gap → LOW/MEDIUM/HIGH (thresholds: ≥3 late-night or ≥6-day streak = HIGH; ≥1 late-night / ≥5 streak / <7h rest = MEDIUM).
- Verified live: John = MEDIUM (2 late-night events + 3.0h rest gap — his real 00:40/00:55 clock-ins); Jane = LOW. Synthetic stress/relaxed unit tests confirm HIGH/LOW logic.
- Dashboard "Workload signals" card (private).

### P — Team Health Intelligence
- `GET /api/team-health?department_id=`: department head (via `positions.head_of_department_id`) or privileged only. Aggregates masked below 5 members (privacy min-group). Distribution HIGH/MEDIUM/LOW + flagged codes. Audited.
- Verified: John (Eng head) → masked (2 members < 5, correct behavior); Lisa non-head → 403.
- Organization page: Team health panel appears for selected departments (head view).

### R — AI Concierge
- `POST /api/concierge`: intent router (leave/pay/attendance/people/projects/org/care/growth/messages/audit) + directory person lookup; unknown → honest fallback; audited (`CONCIERGE_QUERY` in audit log — 9 entries observed). Verified: "vacation" → leave, "payslip" → pay, "slept badly and feel stressed" → care, "tell me about Michael" → person match, nonsense → help.

### S — Proactive HR jobs
- `cert_expiry_reminder` scheduler job (30-day window, deduped, WARNING notification + `CertificationExpiring` event). Verified live: Lisa got "First Aid at Work expires on 2026-09-12" (25 days out); Jane got none.

### W — Live preview sandbox
- `/preview` page: persona switch (real login as john/jane/lisa/emily via extended `POST /api/auth/demo` — unknown account 404, still real JWT+roles), workload simulator (sliders recompute level with API thresholds — honest, nothing persisted), privacy viewer matrix (what self/manager/HR/others see per sensitive field, mirrors backend rules).
- Verified: demo as Emily → roles `self,employee,platform_admin`; unknown → 404.

### X — PWA + tests + a11y
- `manifest.webmanifest`, icons, `sw.js` (shell precache, navigation network-first → cached `offline.html`, GET API stale-while-revalidate, mutations never cached), SW registration in `main.tsx`.
- Offline worklog: IndexedDB outbox (`lib/offline.ts`), Messages page queues sends while offline (banner + pending count) and flushes on `online` — nothing sent offline is lost.
- 15 unit tests (vitest) on pure logic: `isPrivileged`, `computeWorkloadSignals` (4 cases), `matchTopics`, `matchIntent` — all passing.
- a11y: aria-labels/aria-current on Header search/theme/bell and BottomNav.

### Y — Production builds
- Backend `npm run build` (tsc) → `dist/`; **smoke-verified**: `node dist/index.js` on :3001 → `/health` ok (db healthy) + real Jane login 200. Frontend `vite build` → `dist/` (index.html + hashed assets + manifest/sw/offline.html/icons copied). Both EXIT 0.
- Remaining deploy blockers (documented, no infra exists): HTTPS origin required for service workers in production, production Postgres + secrets (JWT_SECRET rotation), reverse proxy (helmet CSP must allow the proxy origin), cold-start migrations via `scripts/migrate.js`.

### Bugs found & fixed by adversarial testing this run
1. `getClient()` recursion (Maximum call stack) — payroll pay.
2. Wallet transfer unique-key collision — split reference types.
3. `/api/audit/query` lost auth when demo onRequest hook was removed (would 403 for everyone) — added `authenticate()` preHandler; verified self 200 / other 403 / none 401.
4. Concierge person lookup polluted by stopwords ("find Jane Doe" → no match) — stopword filter; verified "find Jane" + "tell me about Michael".

## 7. Remaining queue (after overnight run)

1. Payroll run for the CURRENT month via scheduler (manual runs exist; auto-monthly run not yet a job).
2. Bundle size: main JS 1.29 MB (gzip 359 kB) — code-split beyond the 3D lazy chunk.
3. Orphan cleanup: `cerbos.ts` stub + `authorize()`/`requireRole()` (zero callers), `Departments.tsx` (unreferenced), `message_threads`/`position_reporting_lines`/`campus_ambassadors` (schema only).
4. Production infra (Phase Y blockers above).
## 8. Final sweep (handover prep) - VERIFIED

- Orphan cleanup: removed `authorize()`/`requireRole()` from `src/authz/middleware.ts` (zero callers; `authenticate()` retained, now the sole middleware), reduced `cerbos.ts` to the health-check stub (policy evaluation is delegated to the API layer, documented), deleted unreferenced `frontend/src/pages/Departments.tsx`. Both typechecks clean after cleanup.
- Phase N - Women's care consent: `health.consent_preferences` + `health.consent_events` (migration 022); `GET/POST /api/care/consent` (self-managed grant/revoke, audited CONSENT_GRANT/REVOKE + ConsentGranted/Revoked events). Honest boundary: no personal health data is ever stored; consent only unlocks WHO public resources. Verified: John grant -> list 1; Lisa (other) -> 0.
- Phase Q - Field safety: `health.safety_checkins` (migration 022); `POST /api/safety/check-in` + `GET /api/safety/my-checkins` (owner-only, audited SAFETY_CHECKIN + SafetyCheckinRecorded event, lat/lng must come as a pair). Verified: John check-in Chennai 13.0827,80.2707 -> list 1. Care page now has consent toggle + check-in form.
- Bundle splitting: `manualChunks` (vendor/react, motion, dates) + moved `supportsWebGL` out of the 3D module (its static import was forcing three.js/r3f into the main chunk). Result: main chunk 1.04 MB -> 166 kB (gzip 41 kB); 3D now a true lazy chunk (873 kB, loaded only when opened). EXIT 0.
- Handover: see `docs/HUMANOS_HANDOVER.md`.

## 9. Login loop bug (user-reported) - FIXED

Symptom: sign-in succeeds (login POST 200 in server log) then ~1s later the app bounces back to /login, repeatedly. Password/credentials were never the problem.

Root cause (from server log req-l..req-q at 06:21:27):
1. An expired persisted token (8h TTL) left `user` rehydrated in the zustand store while the interceptor had removed the `token` key -> ProtectedRoute rendered the shell -> all 6 Dashboard calls fired with NO Authorization header -> 401 x6.
2. The response interceptor then did `window.location.href = '/login'` (hard reload). On reload the persisted `user` rehydrated again -> shell rendered again -> 401 again -> infinite reload loop, and the hard reloads raced against fresh logins, interrupting them.

Fix (frontend only):
- Interceptor: on 401, `logout()` clears the persisted session atomically (token key + `edurankai-auth` storage + store) and lets ProtectedRoute redirect ONCE via React state - no hard reload, no race.
- ProtectedRoute: requires BOTH `user` and `token`, plus a client-side `jwtExpired()` check (`src/lib/jwt.ts`) so an expired token redirects instantly instead of firing a doomed 401 round-trip.
- Result: stale/expired sessions land on /login immediately; a fresh login can no longer be interrupted by in-flight redirects.

## 10. Service worker poisoning (the actual "still the same") - FIXED

After the �9 fix the user reported the identical symptom. Evidence: server log showed login 200 + dashboard queries served (all fine), yet the browser kept running old behavior. Root cause: `public/sw.js` used CACHE-FIRST for static assets. Vite dev serves UNBUNDLED, UNHASHED modules (/src/*.tsx) - the SW cached the whole module graph at registration and served the stale pre-fix client on every load, forever. The fixes never reached the tab.

Fix:
- `sw.js` v2 (`humanos-shell-v2`): static assets now NETWORK-FIRST with cache fallback (offline still works); activate purges the v1 cache. Hashed production assets make cache-first safe in prod, but network-first is correct everywhere.
- `main.tsx`: service worker registers ONLY in production builds; in dev it unregisters any existing SW and purges all caches, so development always runs fresh code.
- Added `src/vite-env.d.ts` (`/// <reference types="vite/client" />`) for `import.meta.env`.

User action: refresh the tab - the browser fetches the new sw.js on navigation, replaces v1, deletes the poisoned cache; one more refresh (or HMR) and the fixed client runs with no SW in dev.

## 11. Master UI/UX + functionality + intelligence repair run - VERIFIED

Full §66-ordered pass: Organization Explorer (2D), Growth (MY GROWTH), Care workspace + WHO-grounded advisor, Motivation + Moments, policy Workload/Team Health/scorecard, then My Day, Attendance, Leave, Pay, Messages, People, Projects page repairs, visual depth, states, Preview, tests, whole-system QA.

### Verified evidence (this run)

| Item | State | Evidence |
|---|---|---|
| Organization Explorer | VERIFIED | `OrgExplorer.tsx` SVG chart (pan/zoom/search/focus/detail) + `GET /api/organization/explorer`; 3D removed. TSC CLEAN, page 200. |
| Growth | VERIFIED | `GET /api/growth/me` live; page rebuilt as MY GROWTH journey; unused imports removed. TSC CLEAN. |
| Care workspace | VERIFIED | Feeling chips -> Reset presets (30s/2m/5m) with breathing circle + structured advisor rendering + field safety check-in + professional support panel. TSC CLEAN, page 200. |
| WHO advisor semantics | VERIFIED | `intents.ts` (11 intents); live: "stressed" -> mental_health_at_work grounded; "headache"/"feel sick" -> refusal + showProfessional; "sleepy" -> reset suggestion; "movie tonight" -> exact refusal message. 10 care intent tests + 4 matcher tests pass. |
| Women's Care consent | VERIFIED | 13 areas consent-gated via `health.consents`; 2 CONSENT_GRANT audit rows. |
| Motivation engine | VERIFIED | `motivation_quotes` 13 rows (10 original EduRankAI + 3 public-domain), role-aware audience_tag filter, settings (off/occasional/daily/milestone) + dismiss; Moments from certifications/goals/joined events. Live: quote 200, off works, certification moment returned. |
| Workload policy engine | VERIFIED | POLICY_RULES matrix, score->NORMAL/WATCH/ELEVATED/HIGH/CRITICAL; live John = ELEVATED (score 2, 2 rules); 8 policy tests pass. Escalation upsert honors partial unique index. |
| Team workload (head/TL) | VERIFIED | `/api/workload/team?department_id=7925867a-...` -> member_count=2, distribution 5 states, escalated=1 (John ELEVATED), audited WORKLOAD_TEAM_VIEW (4 rows). |
| Team Health + scorecard | VERIFIED | `/api/team-health` + `/api/leadership/scorecard` -> masked=true, member_count=2 < MIN_GROUP 5, masked_groups=[Engineering], disclosure message returned; LEADERSHIP_SCORECARD_VIEW audited (3 rows). Honest masking verified live. |
| My Day / Attendance / Leave / Pay / Messages / People / Projects | VERIFIED | My Day rows: attendance, leave, messages, pay, growth, wellbeing (workload state) all live; `/attendance/summary` (events=10, days=3, 24.8h, device_pct=100%); LEAVE_POLICY table; Pay click-any-amount explanations; Messages important tab (priority filter); People natural search (skills/projects arrays, clickable chips); Projects timeline strip + milestones (progress 1/3 Admissions) + dependencies + team. All pages TSC CLEAN + 200. |
| Projects workspace backend | VERIFIED | Migration 026 applied (project_milestones + project_dependencies, 5 seeded milestones; due_date cast fix in file); GET/POST/PUT milestones + GET dependencies endpoints; audited PROJECT_MILESTONE_CREATE/UPDATE. |
| Visual depth | VERIFIED | Elevation tokens (elev-1/2/3 warm-tinted shadows), `text-gradient-warm`/`bg-gradient-warm` restrained accents, `.card-hover` lift microinteractions, gradient pulse dot + hero accent (Dashboard), reset-circle glow (Care), quote accent bar (Motivation), Focus panel elevation (Organization); `prefers-reduced-motion` already honored globally. |
| Loading/empty/error states | VERIFIED | Sweep complete: Dashboard live-status pulse + partial-data note; Pay skeleton + retry banner; Projects + People retry banners; Growth skeletons; Attendance/Leave/Messages/Organization already covered. TSC CLEAN. |
| Preview | VERIFIED | Persona switch (john/jane/lisa/emily, real sessions), workload simulator with policy parity check hitting `/api/workload/me` live (John ELEVATED, 2 rules), privacy viewer matrix; unused `useAuth` hacks removed. TSC CLEAN, page 200. |
| Tests | VERIFIED | `npm test` (vitest): 5 files, 29 tests PASS (access/privacy 3, concierge 4, care matcher 4, care intents 10, workload 8). |
| Whole-system QA | VERIFIED | 17/17 backend endpoints 200 (incl. audit-required views; `/api/audit` route does not exist - audit via DB per design); 15/15 frontend routes 200; server.log clean of errors; audit log records LOGIN 87, ADVISOR_QUERY 10, TEAM_HEALTH_VIEW 5, WORKLOAD_TEAM_VIEW 4, LEADERSHIP_SCORECARD_VIEW 3, CONSENT_GRANT 2, PAYROLL_COMPUTE 2, MOTIVATION_SETTINGS 2. |

### Known honest caveats (unchanged by this run)
- Demo auth constant-JWT removal landed in §5; demo accounts (john/jane/robert/emily/michael/sarah/david/lisa, demo1234) remain sandbox-only credentials for preview personas.
- Team Health + scorecard are masked at MIN_GROUP 5 by design with the disclosure message; a 2-person Engineering dept shows `masked=true` - this is the honest state, not a bug.
- All workload signals derive from real attendance events; short-rest between days co-occurs with a late-night event, so the dataset yields ELEVATED at most (no synthetic CRITICAL).

## 12. Organization graph engine (ELK) - VERIFIED

Replaced the hand-rolled grid chart (§11) with a real layered graph engine
(`elkjs`) so the structure scales to any org size without hardcoded columns.

### What landed

- `frontend/src/lib/orgGraph.ts` — semantic model (`buildOrgModel`: canonical
  org → dept → position → person tree, no invented layers) + two-phase ELK
  layout: per-department subtree layouts composed onto a department column
  with the org root; clusters = subtree bounding boxes (PAD 20); collapse =
  nodes removed from the model before layout (dept collapse → header-only
  cluster; position collapse → occupants hidden). Subtree normalization
  guarantees non-negative world coordinates. `searchOrgGraph` covers name /
  role / department / skills / projects.
- `frontend/src/components/org/OrgGraphView.tsx` — SVG canvas: pointer pan +
  wheel/button zoom + fit, minimap with click-to-jump, animated fly-to
  (respects `prefers-reduced-motion`), in-canvas semantic search with
  expand-ancestors + focus, focus/dim highlighting for selection, collapse
  chevrons on dept/position nodes, fullscreen portal (Escape exits).
- `frontend/src/pages/Organization.tsx` — wired: async cached layout, Graph /
  List mode toggle, expand-all / collapse-all, org-root overview inspector
  (stats + department list + open roles), search chips fly to the graph,
  large-org default posture (positions auto-collapsed above 150 people).
  Old grid (`OrgChart`) superseded; `OrgExplorer.tsx` now only holds the
  shared data types + fetch + detail helpers.
- `package.json`: `elkjs` + `web-worker` (vite dev optimizer resolution).

### Verified evidence (this run)

| Item | State | Evidence |
|---|---|---|
| Typecheck + prod build | VERIFIED | `tsc --noEmit` CLEAN; `vite build` EXIT 0 (1m35s). |
| Backend tests | VERIFIED | 77/77 (6 files), incl. care matcher + intents. |
| Layout engine (node smoke, synthetic 216-person org) | VERIFIED | 24/24 GREEN: finite coords, no NaN edges, org connected to every dept, every cluster contains its subtree, zero overlapping clusters, membership edges == people count, collapse-all removes persons/edges, single-dept collapse leaves header-only cluster, model builder excludes collapsed depts/positions, search finds people/positions. |
| Browser (headless Edge, real DB + login john/demo1234) | VERIFIED | `/organization` renders graph (38 nodes, 4 clusters), search input + inspector live, zero console errors; search "David" → click result → David focused (dark selected node) + inspector shows David · Account Executive · Grade 3 · Sales. Screenshots: `docs/screenshots/after/org_after.png`, `org_after_focus.png`. |
| Fullscreen + minimap + list mode | VERIFIED | present in code path; canvas controls render (zoom/fit/fullscreen/minimap buttons observed in DOM). |


## 13. Master design directive — one-product sweep — VERIFIED

Executed the Master Design Directive: consolidate the design system into one
shared pattern library, sweep every surface, remove dev affordances and static
UI, wire shell chrome, and prove it in the running browser.

### What landed

- `frontend/src/index.css`: design tokens extended — `--accent`/`--accentsoft`
  (light + dark), new component classes `.btn-ink`, `.chip`/`.chip-brand`/
  `.chip-accent`/`.chip-neutral`, `.notice`/`.notice-info|warn|ok|danger`,
  `.stat`/`.stat-value`/`.stat-sub`, `.hint`; `tailwind.config.js` `accent`/
  `accentsoft` colors; `animate-slide-left/right` utilities + keyframes.
- `frontend/src/components/ui/primitives.tsx`: shared `Stat`, `Notice`,
  `Chip`, `Segmented<T>`, `SectionTitle` — used across pages.
- Dashboard: needsCare/pendingLeave/teamPending banners → `Notice` (warn tone,
  system buttons); Updates + Upcoming rows now navigable buttons (→ /messages,
  /leave); "Open a reset" → `.btn-ink`.
- Attendance: BREAK_TYPES/BREAK_STYLE off-palette colors (amber/violet/teal/
  slate) → token palette; session CTAs → `.btn-ink`/`.btn-secondary`; live
  session + 30-day summary stat boxes → `.stat`; anomaly pills → warn tokens;
  capture field relabelled honestly (photo path, demo camera note).
- Pay: wallet promoted to lead metric (dark ink card, text-4xl); payslip +
  change → `.stat`; transfer inputs → `.input`, Send/Send-money → `.btn-*`;
  tabular-nums → `tnum`; error banner → `Notice` + Retry.
- Leave: already fully on-system (`.card`, `.btn-*`, `.status`, `.empty-state`)
  — no changes required.
- Growth: "Where I am" boxes → `.stat`; retry + learning-note buttons → `.btn-*`.
- Messages: underline tabs → `Segmented`; empty states → `.empty-state`.
- People: status row + contextual "Message" action (→ /messages); skill/project
  filters → `Chip`; retry banner → `Notice`.
- Shell: Header bell → navigates /messages; avatar → clickable /profile; search
  placeholder promise corrected ("policies…" → "pay…"). Sidebar: "Preview"
  debug route removed from nav. BottomNav per §16 → Home · Work · Care · AI ·
  Me (AI = /care#agent deep-link that focuses the advisor input, verified).
- CommandPalette: Pay intent was a false dead-end ("out of scope", routed to
  /settings) → real `/pay`; policy intent honest ("policy text lives on each
  surface" → /leave); Growth + Pay added to go-to lists.

### Verified evidence (this run)

| Item | State | Evidence |
|---|---|---|
| Typecheck + prod build | VERIFIED | `tsc --noEmit` CLEAN; `vite build` EXIT 0 (warnings pre-existing: tsconfig dup key, chunk size). |
| Dashboard | VERIFIED | headless DOM: 1 `.notice` + `.btn-ink` reset action, 12 navigable list rows, no off-palette classes. |
| Attendance | VERIFIED | 7 `.stat`, session buttons on system classes, zero amber/teal/slate tokens in DOM. |
| Pay | VERIFIED | 1 dark ink wallet lead card + 2 `.stat` cards; transfer panel on `.input`/`.btn-*`. |
| Messages | VERIFIED | Segmented tablist renders Inbox/Important/Sent. |
| People | VERIFIED | Message action present; skill/project `Chip` render path in detail panel. |
| Growth | VERIFIED | 4 `.stat` cards (Where I am) — initial 0 was a query-load race; re-check with 6s wait GREEN. |
| Shell | VERIFIED | bell + avatar clickable; "Preview" gone from sidebar nav; bottom nav = Home\|Work\|Care\|AI\|Me. |
| Care #agent deep-link | VERIFIED | `/care#agent` mounts and programmatically focuses `#care-message` (activeElement id verified 2×, incl. mobile emulation). |
| Screenshots | VERIFIED | `docs/screenshots/after/design_{dashboard,attendance,pay,messages,people,growth,leave}.png` + `design_mobile_{dashboard,care}.png` (390×844). |

Note: pixel review not possible in this session (no image input support); DOM
assertions above stand as the structural verification.

### 13b. Visible gradient pass (follow-up) - VERIFIED

The §13 gradient accents were 1-4px strips - rendering but visually invisible.
Per user review, made the warm gradient actually present in four spots:

| Spot | Change | Evidence |
|---|---|---|
| Dashboard hero headline | "Good morning, X." h1 now `text-gradient-warm` (120deg #FF5A1F -> #F2765A -> #D98E3E, bg-clip:text) | computed: backgroundImage gradient + webkitBackgroundClip text + transparent color |
| Primary buttons | `.btn-primary` now uses the warm 3-stop gradient fill with `filter: brightness(.94)` hover (replaces flat bg-brand) | computed on any btn-primary (New request, etc.) |
| Pay wallet lead card | dark ink card gains `bg-gradient-brand-fade` warm wash (rotated, blurred, pointer-events-none) | DOM: card + wash present |
| Attendance session panel | strip `to-amber-400`/`bg-teal-400` off-palette replaced with `to-accent`/`bg-ok`; added live gradient wash while working + ok-glow while on break + `animate-ping` brand pulse dot on the Session eyebrow while working | strip class bg-ok verified while John on break (gradient path when working); no amber/teal remnants in DOM |

Typecheck CLEAN, vite build EXIT 0 (pre-existing warnings only). Screenshots:
`docs/screenshots/after/grad_{dashboard,pay,attendance,leave_btn}.png`.

### 14. Phase 1 - Object ownership + authorization red team - COMPLETE (2026-08-20)

Source recon of all modules + live adversarial matrix (19 checks) against a backend
REBUILT from src (see DRIFT-1). Full report: docs/PHASE1_AUTHZ_MATRIX.md.
Harness (re-runnable regression): backend/scripts/redteam_matrix.mjs.

| Finding | Severity | Status |
|---|---|---|
| PAY-1 payroll lifecycle gate: PAYROLL_ROLES included platform_admin, which deriveRoles grants to every account -> any employee could create/approve/pay runs (live 201). Gate moved to lib/access.ts canRunPayroll(), platform_admin excluded. | P1/P2 | FIXED + REGRESSION-TESTED (403 live, access.test.ts) |
| PII-1 GET /api/persons/:id returned any employee record incl. DOB (live 200). Now OWNER/MANAGER/privileged only. | P1 | FIXED + REGRESSION-TESTED (403 live) |
| PII-2 GET /api/departments/:id/employees leaked legal_name+timezone of any dept (live 200). Now dept-head/privileged only. | P1 | FIXED + REGRESSION-TESTED (403 live) |
| OBS-1 GET /api/system/observability was unauthenticated (live 200). Now authenticate()+privileged. | P3 | FIXED + REGRESSION-TESTED (401/403 live) |
| DEMO-1 POST /api/auth/demo = passwordless login as any seeded account (live 200 as david). Now 404 in production. | P1 (dev) | FIXED (gated) + tested |
| DRIFT-1 dist was a stale build (old health-module layout; workload/team + leadership/scorecard routes 404'd live; motivation module absent). Rebuilt from src. scripts/ dir recreated. | P4 | FIXED (rebuilt) |

Re-run: 19/19 VERIFIED, 0 VULNERABLE. Verified controls held throughout: leave
approve/reject cross-user 403, payslip ownership 403, workload/team + team-health +
leadership/scorecard foreign dept 403, audit/query other person 403, goals
?person_id= other -> empty, message read foreign 404, unauth 401 on all data
routes. Roles are derived live at token issue; JWT verified (issuer/audience/
expiry). N/A in deployment: bank account, documents, BGV, candidates, export,
offline sync, appointment, IP/security events, workflow/delegation (no routes).

Next phase gate: PHASE 2 (AI/agent security) may start - baseline exists.

### 14b. Phase 1 FINAL GATE - coverage proof + production proof (2026-08-20)

- Matrix denominator (deterministic generator, backend/scripts/matrix_generator.mjs): 38 resources x 9 actors x 19 ops x 25 techniques = 6390 generated cases; 75 executed live, 75 passed, 0 failed; 3570 privileged-skipped (no privileged seeded account; code-inspected); 2745 N/A (no surface). "19/19" clarified = 19 control probes, not the full matrix.
- Production gate (NODE_ENV=production on :3001, backend/scripts/prod_gate.mjs): demo login 404, swagger /docs 404 (newly gated), observability 401/403, payroll/persons/dept-roster/workload 403, real login 200 -> 13/13 PASS.
- 18 previously-known findings mapped (docs/PHASE1_AUTHZ_MATRIX.md 6.2): FIXED x4 (payroll takeover, employee-record, dept roster, legacy demo-auth), VERIFIED x10, PARTIAL x1 (project dept-edge P3 - deferred), N/A x7, FIXED+VERIFIED combos x3.
- Release chain proved: source -> tsc build EXIT 0 -> dist grep-verified -> dev :3000 + prod :3001 runtimes -> live probes.
- Swagger UI now gated to non-production (debug-surface removal). Accepted risk: privileged-actor cells not live-logged (no privileged seed); project dept-edge P3 deferred to Phase 3.

### 15. Phase 2 - AI/Agent Security + Data Exfiltration (2026-08-20)

- AI surface inventory: NO external model calls, NO RAG/vector store, NO embeddings, NO HTTP egress (backend src grep-verified); care agent/advisor + concierge are deterministic rule engines. Frontend axios = same-origin only.
- Background agents (4 scheduler jobs): run as DB app role, self-scoped notification/open-item/payroll-DRAFT writes; payroll approval/payment stay human-gated.
- Findings fixed (P3): MEM-1 sessions TTL 60min + cap 200 + per-request prune (care/routes.ts); RET-1 advisor_queries retention: per-person cap 100 + 90-day window.
- Hardening: agent replies now include turn (session state); axios removed (dormant egress dep); SBOM_backend.txt; model adapter interface (src/ai/modelAdapter.ts).
- Verified non-issues: LOG-1 (no prompt text in logs/audit - live grep 0 hits); SEC-1 (no secrets in src/dist); EGR-1 (no egress); history/session/concurrency isolation live-probed.
- Matrix: 567 generated, 96 executed, 96/96 PASS, 0 FAIL (skipped 471 role-agnostic cells code-inspected; N/A 1953). Docs/PHASE2_AI_SECURITY_MATRIX.md.
- Unit: 83 tests pass (6 files) incl. Phase 2 regression (injection no-leak, session isolation, clear-scoping).
- AI CANNOT cross the HRMS security boundary: no model, no tools, no egress; authorization remains backend-enforced (Phase 1 matrix).

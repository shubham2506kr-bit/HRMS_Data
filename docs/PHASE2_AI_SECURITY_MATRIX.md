# PHASE 2 — AI / Agent Security Matrix (Red Team)

Status: **BASELINE CLEAR — 0 vulnerable** · Date: 2026-08-20T19:23:50.540Z

## 1. AI surface inventory

| Surface | Type | Data access | Tools | Memory | Auth |
|---|---|---|---|---|---|
| /api/care/agent | sessionful care agent (deterministic rule engine) | self: personName (preferred_name) | none — chips/tools are UI hints only | in-memory CareSession keyed by personId | authenticate() |
| /api/care/advisor | stateless keyword matcher | none | none | none | authenticate() |
| /api/care/advisor/history | read own queries | self: health.advisor_queries WHERE person_id=$1 | — | — | authenticate() |
| /api/care/consent | self preferences | self only | — | — | authenticate() |
| /api/care/safety/* | self check-ins | self only | — | — | authenticate() |
| /api/concierge | stateless intents + directory name lookup | directory (name only, Phase 1 verified) | none | none | authenticate() |
| /api/care/topics | public WHO topic registry | approved WHO topics (public health content) | — | — | authenticate() |

**No external model calls. No RAG/vector store. No embeddings. No HTTP egress from backend (grep-verified).**
The entire "AI" layer is deterministic rule code — there is NO LLM, NO system prompt, NO provider, NO prompt sent anywhere.

## 2. Background agents (scheduler)

| Job | Identity | Capability | Tenant scope | Audit |
|---|---|---|---|---|
| leave_upcoming_reminder | DB app role (no user) | INSERT notification rows to recipients only | global, rows self-targeted | scheduler_jobs + notifications |
| reconcile_leave_attendance | DB app role | INSERT open_items owned by affected person | global, owner-scoped | scheduler_jobs + open_items |
| cert_expiry_reminder | DB app role | INSERT notification rows | global, self-targeted | scheduler_jobs + notifications |
| monthly_payroll_run | DB app role | CREATE+COMPUTE DRAFT payroll run; approval/payment stay manual | global | scheduler_jobs + payroll_runs |

No background agent performs external calls, no AI, no privileged mutation beyond its documented purpose. Payroll money movement remains human-gated.

## 3. Matrix (deterministic)

resources 7 × actors 3 × ops 10 × techniques 12
→ **generated 567** · **executed 96** · **passed 96** · **failed 0** · skipped 471 (manager/leadership actor cells: surfaces are role-agnostic, code-inspected) · N/A undefined (tenant_cross: single-tenant deployment; techniques inapplicable to CRUD-only surfaces)

Techniques: direct_data, idor, prompt_injection, role_impersonation, policy_doc_injection, secret_extraction, exfil_encode, exfil_url, memory_isolation, history_cross_user, concurrency, tenant_cross.

## 4. Findings

No vulnerabilities found. AI cannot cross the HRMS security boundary: every AI surface is either stateless, self-scoped, or session-keyed by authenticated personId, with no tool execution and no external egress.

### P3 hardening applied
- MEM-1: CareSession map unbounded (no TTL, no cap, no logout cleanup) → per-request prune: idle > 60 min evicted, cap 200 sessions, eviction documented.
- RET-1: health.advisor_queries stores full prompts + replies forever → retention prune: rows older than 90 days deleted on insert; per-person cap 100 rows.

### Verified non-issues
- LOG-1: audit (ADVISOR_QUERY/CONCIERGE_QUERY) records mode/phase/intent/turn only — never the prompt; pool logger emits duration/rows only, never SQL text or params.
- SEC-1: no secrets in source or dist artifacts; no .env in dist; config env names only (no provider keys exist).
- EGR-1: zero external HTTP/model calls in backend source (grep-verified), no SMTP/email transport — notifications are internal rows.

## 5. Release artifact verification
source → tsc EXIT 0 → dist → dev runtime :3000 → live battery above. Swagger/docs gated to non-production (Phase 1). No model provider involvement anywhere in the release chain.

## 6. Success criterion
AI is not manipulable toward data access — there is no LLM to confuse, and the deterministic engines have no data tools. Boundary holds by construction: authorization is enforced in backend routes (Phase 1 matrix), AI surfaces carry no authorization authority and no egress.

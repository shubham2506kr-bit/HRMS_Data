# CLAUDE.md — HumanOS / EduRankAI HRMS

**Read `HANDOFF_TO_CLAUDE_CODE.md` in this directory before doing anything else.** It contains the full audit, what has been changed, what is still broken, and what to verify first. This file is only the short version.

For the daily/weekly clock-out reflections feature, the spec is `docs/REFLECTIONS_SPEC.md`. It is specified but **not built**, and it is blocked behind two things in the handoff: the attendance fix (§8.3) and finishing RLS migration 033 (§8.1). Do not start it before those, and read §3 of the spec before changing any of its decisions — they were made deliberately by the owner.

## The three facts that will bite you

1. **A large amount of this codebase was rewritten and never compiled or executed.** No `tsc`, no tests, no SQL ever parsed by Postgres. Verify before you build on it.
2. **The migration runner never worked**, so the live database was built by hand and its real schema is unknown. Write defensive SQL: guard on `pg_tables`, `pg_namespace`, `to_regclass`, `to_regprocedure`. Never assume an object exists.
3. **Migrations are forward-only from 031.** Never edit `migrations/001`–`030`. The live database is populated and must not be rebuilt. Corrections to old schema go in a new migration.

## Layout

- `backend/` — Fastify 5 + TypeScript, ESM with NodeNext. **Imports must carry the `.js` extension** even for `.ts` sources.
- `frontend/` — React 18 + Vite 5 + Tailwind + zustand + react-query.
- `migrations/` — SQL, at the **repo root**, not under `backend/`.
- `policies/` — YAML intended for Cerbos, but not currently valid Cerbos policy. Do not enable Cerbos.
- `docs/` — the original team's status documents. **Treat as claims, not facts**; the audit found many "VERIFIED" rows the code contradicts.

## Commands

```bash
cd backend && npm run typecheck   # tsc --noEmit
cd backend && npm test            # vitest run
cd backend && npm run build       # tsc
cd backend && node scripts/prod_gate.mjs   # exit 0 pass / 1 fail / 2 incomplete
```

`npm run migrate`, `npm run migrate:fresh` and `npm run db:seed` are **dead** — they point at `scripts/migrate.js` and `scripts/seed.js`, which do not exist.

## Conventions to preserve

- Money stays in `NUMERIC`. `pg` returns it as a **string** on purpose; do not add a type parser that converts it to `number`, and never do currency arithmetic in JS `number`.
- Bitemporal tables key on `logical_id` with `valid_period` / `system_period` `TSTZRANGE`, half-open `[)` bounds. "Current" is `system_period @> NOW()`.
- Request identity comes from `backend/src/lib/requestContext.ts` (AsyncLocalStorage), never from the JWT. **Roles are derived from live database state per request** — do not put roles back in the token.
- `backend/src/db/pool.ts` applies `app.person_id` and `app.roles` per statement via `set_config` with bound parameters. Do not interpolate identity into SQL text.
- `app.roles` is comma-**wrapped** (`,self,employee,hr_generalist,`) so an exact-element test cannot match a prefix. This is deliberate; a substring match was a real privilege-escalation bug.
- Query logging records `{ duration, rows }` only. **Never log query parameters** — they hold person ids, salaries and clinical free text.
- Audit writes are fail-closed. Do not add a `catch` that swallows them.
- Timezone-sensitive logic uses `ORG_TIMEZONE` (default `Asia/Kolkata`), never the server's local time and never bare UTC-date slicing. `date-fns-tz` is already a dependency.

## Hard limits

- **No LLM calls, no third-party network egress.** This codebase has none, by design. The "AI" module is deterministic regex. Adding an outbound call changes the entire data-protection posture of a system holding health data.
- Health data is special-category under India's DPDP Act. Every read or write of it goes through the consent gate in `backend/src/modules/care/routes.ts`. Minors additionally require verifiable parental consent (s.9(3)).
- `tsconfig.json` is strict. Keep it strict; do not silence errors with `any` where a real type exists.
- Payroll rates are statutory and change annually. Any change to tax, EPF, ESI or professional tax logic needs a chartered accountant's review before it computes real pay.

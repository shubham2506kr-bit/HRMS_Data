# Clock-out reflections — feature specification

**Status:** specified, not built. No code exists for this yet.
**Written:** 2026-08-23
**Prerequisite:** read `HANDOFF_TO_CLAUDE_CODE.md` first. This feature hangs off clock-out, and the attendance module is the most broken part of the system.

---

## 1. Product intent

At clock-out, ask the employee a short set of reflection questions. Daily on every clock-out, weekly once per week. The owner's stated purpose for the mood question, in their words: *"I wanted to know every employee mood specifically in my admin panel so that I can call out things personally."* The feature exists so a human notices a person having a bad week and reaches out. Design decisions should serve that, not analytics for its own sake.

## 2. The questions

**Daily** (asked at each day's final clock-out):

| # | Question | Required | Reader |
|---|---|---|---|
| D1 | Daily project feedback | yes | manager, admin |
| D2 | What made you happy or sad today | yes | manager, admin |
| D3 | One learning you wanted to share | no | manager, admin |
| D4 | One mistake you made today | no | manager, admin |

**Weekly** (asked once per week):

| # | Question | Required | Reader |
|---|---|---|---|
| W1 | Weekly progress report | yes | manager, admin |
| W2 | One learning from this week | yes | manager, admin |
| W3 | One attempt or risk you want to take next week | yes | manager, admin |
| W4 | Anything about your manager — *"literally anything, and it will be confidential"* | no | **admin only. Never the manager.** |

Question wording will change over time. Store the catalogue in a table, version it, and tie each answer to the prompt version it was written under — otherwise a reworded question silently changes the meaning of historical answers.

## 3. Decisions already made — do not relitigate

1. **Confidential manager feedback (W4) is readable by administrators** — an EA/CEO-level role — **and by HR only in a limited way.** Implemented as: an `exec_confidential` role reads all notes; `hr_generalist` can read an individual note only after an exec explicitly shares it (a `shared_with_hr_at` / `shared_by` column on the row). Anyone in the subject's reporting line, at any depth, must be excluded by the RLS policy itself, not by an application `WHERE` clause.
2. **Non-blocking.** Clock-out is written and committed first, always. The reflection is a separate record prompted afterwards. Completion is tracked so gaps are visible. Rationale: if the form is required, a form bug becomes an attendance bug, and attendance feeds payroll.
3. **The direct manager can read all daily answers**, including D4 (mistakes) and D2 (mood). This is a deliberate choice by the owner. **It carries a hard UI requirement:** every field must state who will read it, at the point of writing. The failure mode is not managers reading — it is employees believing a field is private when it is not.
4. **Mood is stored per person, identified, and surfaced in an admin panel.** Not anonymised, not aggregate-only.

## 4. Obligations that attach to decision 4

These are requirements, not suggestions, and they are what make the feature defensible:

- **Notice at collection.** The reflection form states who reads each answer and how long it is kept. One sentence per field.
- **Purpose limitation.** Mood and mistake data were collected for wellbeing and coaching. They must not feed performance reviews, appraisal scores, payroll, or termination decisions. Enforce it by not joining these tables into any appraisal or payroll query, and say so in a comment on the table.
- **Retention.** A finite window on free text — the existing `retention_policies` / `retention_runs` machinery from `migrations/036_consent_retention.sql` already does this. Register the reflection tables with it. Indefinite retention of per-day emotional state on identified employees is the thing to avoid.
- **Audit every read.** Admin and manager reads of D2, D4 and W4 write an audit row. `lib/audit.ts` is fail-closed; use it. **Never put the answer text into the audit row** — record who read whose record, when, and which prompt, exactly as `care/routes.ts` already does for health data.
- **A defined path for genuine distress.** A mood field will eventually surface someone in real trouble. Decide now who is notified, how fast, and what they do. Suggested shape, which fits the existing architecture: low valence for N consecutive days raises a flag in the admin panel for a named human to review. No automated interpretation of the free text — this codebase has no LLM calls by design and the "AI" module is deterministic regex. A human reads it or nobody does.

## 5. Data model — `migrations/040_reflections.sql`

Write it defensively (guard on `pg_tables`, `to_regclass`) like every migration from 031 up, and remember 001–030 are frozen.

**`health.reflection_prompts`** — the question catalogue. `logical_id`, `prompt_code` (`D1`…`W4`), `cadence` (`DAILY` | `WEEKLY`), `question_text`, `is_required`, `visibility_class`, `sort_order`, and either bitemporal periods or a plain `version` integer. Versioned so answers stay interpretable after a rewording.

**`health.reflection_submissions`** — one row per person per period per cadence. `logical_id`, `person_id`, `cadence`, `period_start` and `period_end` as civil dates, `submitted_at`, `attendance_event_id` (nullable, links to the clock-out that prompted it), `is_complete`, `skipped_at`, `skipped_reason`. Unique on `(person_id, cadence, period_start)`.

**Civil date, not UTC date.** Derive `period_start` in `ORG_TIMEZONE` (`Asia/Kolkata`), using `date-fns-tz`, which is already a dependency. Finding A21 in the audit is that the attendance module currently has three mutually inconsistent definitions of "day". Do not add a fourth.

**`health.reflection_answers`** — `submission_id`, `prompt_id`, `answer_text`, `mood_valence` (small signed integer, only populated for D2), `visibility_class`. The integer is what the admin panel charts; the text is what a human reads. Deriving a chart from free text would need inference this codebase deliberately does not have.

**`health.reflection_confidential_notes`** — W4 lives here, in **its own table**, not as a row in `reflection_answers`. Reasons: a different reader set, a different retention window, a different policy, and physical separation so that a mistake in the general reflections policy cannot leak it. Columns: `logical_id`, `person_id`, `note_text`, `about_employment_id` (which manager relationship it concerns, resolved at write time so a later reorg does not rewrite history), `created_at`, `shared_with_hr_at`, `shared_by`, `resolved_at`, `resolution_note`.

## 6. Visibility matrix — implement in RLS, not in route handlers

| Data | self | direct manager | dept head | `hr_generalist` | `exec_confidential` | `auditor` |
|---|---|---|---|---|---|---|
| D1, D3, W1, W2, W3 | read/write own | read | read | read | read | metadata only |
| D2 mood, D4 mistake | read/write own | read | read | read | read | metadata only |
| W4 confidential note | read/write own | **never** | **never** | only if shared | read | metadata only |
| `mood_valence` series | own | own reports | own dept | all | all | no |

`exec_confidential` is a **new role** and does not exist yet. Add it to the role derivation in `backend/src/lib/auth.ts`, which now derives roles from live database state per request — not from the JWT. Do not put it back in the token.

The W4 "never" rows are the whole feature. Express them as a policy predicate that excludes the reporting line transitively, and test them directly in `psql` as the `hrms_app` role before trusting the UI. Migration `033_rls_and_grants.sql` must be finished first (§8.1 of the handoff), because until the app stops connecting as a superuser, **no policy on this table does anything at all.**

## 7. Backend

New module `backend/src/modules/reflections/`. Remember: ESM with NodeNext, so imports carry the `.js` extension.

- `GET /api/reflections/pending` — what this person still owes, derived from submissions versus expected periods.
- `POST /api/reflections/daily` and `POST /api/reflections/weekly` — upsert a submission plus its answers, in one transaction.
- `POST /api/reflections/skip` — records an explicit skip with a reason.
- `GET /api/reflections/me` — own history.
- `GET /api/reflections/team` — manager view, scoped by RLS rather than by a hand-written `WHERE`.
- `GET /api/admin/mood` — the panel: valence series per person, plus the attention flags.
- `GET /api/admin/confidential` and `POST /api/admin/confidential/:id/share` — `exec_confidential` only, every read audited.

**Write ordering, which is the one thing not to get wrong:** the clock-out attendance event commits in its own transaction and returns success. The reflection is a second, independent request. Never wrap them together, or a validation failure on the reflection rolls back somebody's clock-out.

**Weekly cadence trigger.** "The last clock-out of the week" is not knowable at the time of clock-out. Practical rule: prompt the weekly set on any clock-out on or after the configured week-end day, and if it is still unsubmitted, prompt again on the first clock-in of the following week. Put the week-end day in config rather than hardcoding Friday.

## 8. Frontend

Two surfaces. First, the reflection sheet after clock-out: it appears once the clock-out has already succeeded, shows the daily set plus the weekly set when due, marks required fields, and — non-negotiably — labels each field with who reads it. W4 needs visibly different treatment from the rest, because it is the one field with a different audience, and a generic form row will not carry that.

Second, the admin mood panel: per-person valence over time, attention flags, and drill-through to the text. This is the screen the owner asked for; it is worth real design effort.

A UI/UX skill and a design MCP server were mentioned for this stage. Neither was visible to the session that wrote this spec. To make them available to Claude Code, register the MCP server in a `.mcp.json` at the repo root (or via `claude mcp add`) so the session picks it up on start, and confirm the skill is saved to the account rather than only present on disk.

## 9. Open questions

- Does the weekly reflection also fire for someone who did not clock in that week, e.g. on leave? Probably not, and "expected periods" needs to exclude approved leave and holidays — `holiday_calendar` and `leave_entitlements` from `032_leave_integrity.sql` already exist for this.
- Do campus ambassadors, who are deliberately not employees in this schema and have no `employments` row, get reflections? They also may be minors, which pulls in DPDP s.9(3) parental consent.
- What happens to a confidential note when its subject manager leaves, or when the note's author leaves?
- Should an employee be able to retract an answer after submitting, and does the manager's already-read copy disappear?

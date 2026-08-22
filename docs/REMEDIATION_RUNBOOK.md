# REMEDIATION RUNBOOK — order of operations

**Written 2026-08-22, after the audit and remediation of the same date.**

Everything in this repository was changed by static edit. **No typecheck, no test
run, no migration and no database were available in that environment**, so every
fix below is APPLIED BUT UNVERIFIED BY EXECUTION. This runbook is the sequence
that turns "applied" into "verified", and the steps are ordered because several
of them break the application until the next one is done.

Read the whole thing before starting. Steps 3 and 5 make the app unusable in the
middle of the sequence; that is expected, not a fault.

---

## 0. Before you touch anything

- [ ] **Put this tree under version control.** There is no `.git` directory: 24
      `.log` files, a `.env` and a full `node_modules` are sitting in the working
      copy with no history. A root `.gitignore` now exists — commit that first,
      then the source, so the ignore rules are in effect before the first commit.
- [ ] **Delete the committed logs.** 19 `*.log` files under `backend/` and 5
      under `frontend/`. They are build noise; they are also the only place a
      request trace from a real session could have survived.
- [ ] **Treat the old secrets as public.** `backend/.env` previously held
      `JWT_SECRET=edurankai-hrms-demo-development-secret-key-2026` and a
      passwordless superuser `DATABASE_URL`. Anyone who has ever had a copy of
      this tree can mint a token for any employee.
- [ ] **Decide whether this database holds real people.** If it does, stop and
      treat the remainder as a production change with a maintenance window.

## 1. Back up the database

Nothing below is reversible without this.

```bash
pg_dump --format=custom --file=edurankai_pre_remediation.dump \
        --dbname="postgresql://postgres@localhost:5432/edurankai"
# verify the dump is restorable before continuing
pg_restore --list edurankai_pre_remediation.dump | head
```

Keep the dump outside the repository (`*.dump` is git-ignored, but do not rely
on that).

## 2. Rotate JWT_SECRET

```bash
openssl rand -base64 48
```

Put the result in `backend/.env` as `JWT_SECRET`. The committed placeholder
(`CHANGEME-…`) is deliberately a value the production safety check rejects, so a
forgotten rotation fails at boot instead of shipping quietly.

Consequences, all intended:

- every outstanding access token becomes invalid — all users are logged out;
- every stored refresh token is unaffected (they are opaque and hashed), so
  clients will silently re-authenticate on their next refresh call; revoke them
  too (`UPDATE health.auth_sessions SET revoked_at = NOW(), refresh_token_hash =
  NULL WHERE revoked_at IS NULL`) if you believe the tree was ever shared.

Do this **before** step 3: if the database work goes wrong you want the old key
already dead.

## 3. Create the `hrms_app` role and switch DATABASE_URL

The application connected as the `postgres` superuser. **Superusers and table
owners bypass row-level security**, so migration 033's policies and every earlier
`GRANT` were decorative. Until this step is done, RLS cannot work.

```sql
-- as a superuser, once
CREATE ROLE hrms_app LOGIN PASSWORD 'a-long-random-password';
-- migrations/033_rls_and_grants.sql grants exactly what the app needs;
-- do not add BYPASSRLS, SUPERUSER or ownership of the health schema.
```

Then update `backend/.env`:

```
DATABASE_URL=postgresql://hrms_app:<that password>@<host>:5432/edurankai?sslmode=require
```

- `sslmode=require` or stricter is mandatory in production; a local instance with
  no TLS listener needs `prefer` in development only.
- **The app will not start or will fail every query between this step and step 4**
  — the role exists but the grants and policies land with migration 033.
- Do not reintroduce the superuser URL "just to get it running". That single line
  is what made every other data-protection control in this system inert.

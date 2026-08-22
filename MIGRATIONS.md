# Database migrations — how schema works in this repo

**Canonical source of truth: `supabase/migrations/`** (Supabase CLI). This replaced the
ad-hoc `sql/NNN_*.sql` convention on 2026-08-02.

## Replay safety — the deploy workflow will refuse destructive DML

`.github/workflows/supabase-migrations.yml` applies any newly added migration that
production's ledger does not already record as applied, by running `supabase db query
--linked --file`. That is correct for a forward-only schema change and **wrong for a
migration that captures state already live** — a file written to record what was applied
by hand, whose data statements were only ever meant to run once, against the *old* shape
of the data.

So before applying anything, the workflow runs:

```
node scripts/check-migration-replay-safety.mjs <migration.sql>
```

A migration whose **top-level** statements can modify or destroy existing rows
(`UPDATE`, `DELETE`, `TRUNCATE`, `DROP TABLE`, `DROP COLUMN`) is **refused**, and the job
stops before touching the database. DML inside a function or `DO` body is not counted —
that is a definition, not an execution.

Two markers change the verdict:

```sql
-- hl:replay-safe: <why a second run cannot damage existing rows>
-- hl:replay-unsafe: <why this must never be auto-applied>
```

`hl:replay-safe` opts a file back in and requires a real reason. `hl:replay-unsafe` pins
a file as never-auto-appliable regardless of what the scanner detects, and wins if both
are present.

**If the objects are already live, do not add a marker to get the file through.** Record
it on the ledger instead:

```bash
npx supabase migration repair --status applied <version>
```

Why this exists: PR #198's `20260810220215_permission_roles_v2.sql` remaps an old 11-role
taxonomy onto the new 9-role one with unguarded `UPDATE`s whose `CASE` only knows the old
names. Production is already on the new names, so a replay maps six of the nine roles to
`null` and silently strips those employees' permissions. Merging that PR with the deploy
secrets configured would have done it, and the only thing in the way was a paragraph in a
PR description that went unread for four days. Existing migrations are unaffected: they
are already recorded as applied, so the workflow skips them and never reaches this gate.

## Current production reconciliation (verified 2026-08-17)

The database is healthy, but the deployment ledger is not fully reconciled yet:

- Production has the recorded membership RLS, banking re-auth, banking ACL, and
  portal-auth cleanup migrations through
  `20260816022716_prune_consumed_expired_auth_links`.
- All 11 `ai_workroom*` / `workroom*` tables exist with RLS enabled and an
  owner-scoped policy. Their original schema files were applied out of band and
  are not all represented in the production migration history.
- The six canonical versions proposed by PR #198 (`20260810213634`,
  `20260810220215`, `20260811004818`, `20260811021531`, `20260811233352`, and
  `20260812015226`) describe schema already present in production but are not
  recorded as applied. Repair the production ledger before merging those files;
  one contains a one-way data remap and must not be replayed against live data.
- `.github/workflows/supabase-migrations.yml` is the automatic deployment path,
  but GitHub still needs `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`.
  Until those repository secrets exist, every schema-changing PR must be applied
  and verified explicitly; a green Vercel deployment does not deploy its schema.

The older freeze notes below are retained as history. This section supersedes
their counts and pending-item lists.

## 2026-08-17 remediation additions

Two forward migrations were added and applied through the owner-approved
production workflow on 2026-08-17:

- `20260817221814_ar_balance_discount_aware.sql` keeps headline AR on the
  client-level Jobber balance while making invoice counts, excluded buckets,
  `invoice_balances`, and `ar_aging` subtract both deposits and discounts.
- `20260817221820_documents_storage_rls.sql` versions the private `docs` bucket
  and the authenticated upload, metadata-authorized read, and owner-cleanup
  policies required by the Documents browser flow.

Post-apply verification confirmed the AR definitions/formulas, private bucket,
policies, and a one-object/one-document live sample with zero orphan objects.
The immutable `20260817221820` history records that its initial cleanup
SECURITY DEFINER helper was exposed through `public`.
`20260817222303_documents_storage_private_cleanup_helper.sql` was subsequently
applied and verified on 2026-08-17: it moves the helper to non-exposed
`private`, recreates the policy, and drops the public helper. Verification found
the public helper absent, the private helper pinned to an empty `search_path`,
`anon` unable to execute it, the required authenticated/service-role grants in
place, and no advisor finding for this helper.

The same pass also reconciled four migrations introduced by concurrent main
work and verified their live effects:

- `20260817235251_project_numbering_security_repair.sql` repairs the partially
  applied project-number migration: `project_counters` and its allocator are
  service-only, and `jobs_enriched` appends `project_seq`/`division_code`
  without changing its established 19-column order. The recurring production
  `/api/jobs` 500s stopped immediately after this repair.
- Production recorded the request/index repair as version `20260818000109`.
  Its replay-safe implementation remains intentionally ordered after its
  dependencies as
  `20260818150000_repair_lead_pipeline_request_uniqueness_and_clock_index.sql`;
  the earlier local file is a receipt-only marker. It gives PostgREST an
  inferable ordinary `UNIQUE (request_id)` target and removes only the duplicate
  `hl_clock_open_idx`.
- `20260818000148_crew_clock_atomic_writes.sql` adds service-role-only,
  security-invoker RPCs so closing prior crew/field sessions and opening their
  replacements is one transaction. Live ACL checks show no anon/authenticated
  execution, and a rolled-back failure probe preserved the prior open row.
- `20260818001232_crew_clock_concurrency_and_visit_scope.sql` serializes clock
  starts, adds one-open-row partial uniqueness for both crew and field time,
  and scopes whole-team clock-out to the requested visit. Live checks found no
  pre-existing duplicates, verified service-role-only execution, and used a
  rolled-back two-visit probe to prove that stopping one visit leaves the other
  visit's open clock untouched.
- HiveConnect recorded `20260818002333 hiveconnect_auth_password_lifecycle_expand`.
  It adds stable invite/Auth recovery identifiers and four service-role-only
  lifecycle helpers without changing the three legacy RPCs used by the current
  production build. ACL verification found PUBLIC, anon, and authenticated
  unable to execute every helper. The separate cleanup migration remains
  intentionally unapplied until the matching application deployment is live
  and smoke-tested.

Leaked-password protection is enabled and advisor-verified on all three
Supabase projects used here: HiveLogic, HiveConnect, and HiveDoc.

Legacy `sql/052_marketing_maintenance_reminders_type.sql` does **not** need a
new run: its canonical byte-equivalent migration is
`20260815205210_marketing_maintenance_reminders_type.sql`, and the final
12-value `campaigns_type_check` was recorded as live-verified on 2026-08-15.
Do not replay the narrower `047`–`051` intermediate constraints.

## The baseline

`supabase/migrations/20260802140000_remote_baseline.sql` is a **verified** full snapshot of
production's `public` schema, pulled read-only via `supabase db dump`.

Verified 2026-08-02: a clean Postgres built from this file reproduces production's `public`
schema exactly — 150 tables / 1594 columns / 133 FK / 452 indexes / 15 functions, and the
column/index/function structural hashes are identical to live production. (Shipped in PR #30.)

## Legacy `sql/*.sql` — deprecated, do NOT add to it

The numbered `sql/002_*.sql … sql/054_*.sql` files are **historical reference only**. They are
kept because a test and several code comments / error messages still point at them — do not
delete them — but **do not add new schema changes there.** All new schema work goes through
`supabase/migrations/`.

## Freeze status (as of 2026-08-02)

Production is at **81 recorded migrations** (latest `20260802135607_voicemail_soft_delete`), and
the baseline above captures exactly that state. **Hold new schema changes** until the migration
history reconciliation lands (see "Pending" below) so the baseline stays authoritative.

## Adding a migration going forward

```bash
npx supabase migration new <short_name>       # creates supabase/migrations/<ts>_<short_name>.sql
# write your DDL in that file
```

- **Interim (until reconciliation lands):** apply to production the same way as before (the
  Supabase MCP `apply_migration` / dashboard SQL editor), AND commit the matching
  `supabase/migrations/` file so the repo stays the source of truth.
- **Target (after reconciliation):** `npx supabase db push` applies pending local migrations to
  production directly.

## Local verify (needs Docker Desktop / WSL2)

```bash
npx supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
npx supabase db reset      # rebuilds a clean local db from supabase/migrations/
npx supabase stop --no-backup
```

## Migration history reconciliation — DONE (2026-08-02)

`supabase db push` / `db pull` now work. The 81 legacy `schema_migrations` rows were archived
(`supabase/_history_archive/schema_migrations_2026-08-02.sql`, full statements) and then squashed
on production: the 81 legacy versions were marked reverted and `20260802140000` marked applied.
Production history is now `[20260802140000 remote_baseline, 20260802145229
call_intelligence_transcript_sid]`, matching the local files. Only the ledger was changed —
schema and data were untouched.

> Still: **never** run `supabase migration repair --status reverted …` blindly on a `db pull`
> mismatch. It deletes rows from production's history ledger; only do it as a deliberate, archived
> squash like the one above.

Note: `20260802145229_call_intelligence_transcript_sid` was applied to production by a concurrent
session mid-reconcile (a freeze violation) and folded in here as a forward delta.

## 2026-08-18 — App Status Hub

`20260818180000_app_status_hub.sql` was applied and verified on production.
It adds the server-only `app_status_findings` and `app_status_events` tables.
Both have RLS enabled; only `service_role` has table privileges. The Dev To-Do
API is the authenticated, admin/owner-gated reader and triage writer.

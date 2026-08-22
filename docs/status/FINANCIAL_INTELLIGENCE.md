# Financial Intelligence status

**Evidence date:** 2026-08-17
**Owner:** No Financial Intelligence owner is recorded in the repository.

## Repository state

- QuickBooks reads run through `api/qbo/index.js`; Track 1 imports the same
  server-side financial functions instead of making unauthenticated sibling
  HTTP calls. Signed-in financial roles are enforced, while exact
  `CRON_SECRET` GET requests cover scheduled financial/status reads. Anonymous
  callers and write methods remain denied.
- The production baseline's `snapshot_aggregates()` correctly sources headline
  AR from `client_ar_outstanding`, not a sum of invoices. This prevents client-
  level Jobber netting from being lost.
- `supabase/migrations/20260817221814_ar_balance_discount_aware.sql` aligns the
  invoice-level counts, excluded buckets, `invoice_balances`, and `ar_aging`
  with the application formula: total minus payments, deposit, and discount.
  It was applied in production on 2026-08-17; the replacement definitions and
  formulas were verified after application.
- Core and extended Jobber syncs now deduplicate same-`jobber_id` rows before a
  PostgREST upsert, preventing PostgreSQL SQLSTATE 21000 from rejecting an
  entire jobs/invoices batch. Production deployment/re-run is still required.
- The partially applied project-numbering migration caused live `/api/jobs`
  reads to request two fields missing from `jobs_enriched` and exposed its
  counter table/allocator to client roles. Forward repair `20260817235251`
  appended the fields without reordering the view contract, enabled RLS, and
  restricted both counter and allocator to service role. The recurring 500s
  stopped after the live repair.
- Request-to-lead upserts now have an inferable ordinary nullable UNIQUE target
  (`20260818000109` live receipt; `20260818150000` replay migration). Estimate
  conversion validates lifecycle before insert, scopes number recovery to the
  actor's company, explicitly stores `company_id`, and safely resumes a prior
  committed job whose estimate update failed.

## Verification and open gaps

- Focused auth/role, AR, invoice-balance, durable-invoice, and sync-deduplication
  tests pass locally.
- Project-numbering privilege/view probes and estimate tenant/recovery tests
  pass. Production `/api/jobs` returned 200/304 after repair while anonymous
  access remained 401; the estimate application changes still require the new
  build to deploy.
- Current production state was rechecked without mutating an external account.
  The live QBO token row had updated at `2026-08-17T22:06:27Z`, the
  `job_costing` cache at `22:04:34Z`, and the current Vercel deployment showed
  QBO reads succeeding rather than the reported 401 pattern. The minute
  Track 1 cron reached its function with HTTP 200; a separate repeated 401
  group was traced to an unsigned browser poller and is addressed by the
  session-gated poller change in this branch.
- The most recent observed core and extended Jobber sync log rows were
  successful (`22:21:23Z` and `22:15:02Z`, respectively). Those rows show the
  existing deployment was operating at that moment; they do not certify the
  new duplicate-row handling until this branch deploys and encounters or
  replays the affected batches.
- A post-apply account-level comparison against Jobber's Client Balance Summary
  was not performed; that external reconciliation remains open.
- Runtime recovery from the 2026-08-12 invoice and 2026-08-17 jobs sync failures
  cannot be claimed until the patched build deploys and those resources finish
  a successful production sync.

**Current label:** The observed 401 pattern is attributed to the browser poller,
not QBO or the signed cron; the project-numbering outage/security gap is fixed
live. Poller, duplicate-upsert, and estimate-integrity application changes still
need deployment receipts, and account-level AR reconciliation remains open.

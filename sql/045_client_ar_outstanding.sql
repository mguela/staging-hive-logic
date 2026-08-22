-- 045: client_ar_outstanding view — the Jobber-accurate open-AR source.
--
-- WHY THIS EXISTS (root cause, verified 2026-08-01):
--   The AR/cash tile must equal Jobber's Client Balance Summary -> Outstanding
--   ($291,191.02 on 2026-08-01). We were about to source that number by summing
--   invoice_balances.computed_balance (per-invoice: total - payments - deposit).
--   That OVERSTATED open AR by ~$21.2k ($312,406.94 vs $291,191.02). The cause is
--   NOT a sync bug:
--     * api/jobber/sync.js already requests amounts.depositAmount / paymentsTotal
--       and maps them to invoices.deposit / invoices.payments correctly. It works
--       for 2,703 invoices carrying payments and 382 carrying deposits, and the
--       full sync re-fetches every invoice ~hourly (sync_log confirms).
--     * The gap is an AGGREGATION-LEVEL mismatch. Jobber computes Outstanding per
--       CLIENT; a per-invoice sum cannot see money recorded at the client/job
--       level and never applied to an individual invoice's amounts. Confirmed
--       instance: invoice #504265 (DeSalva change order) is returned by Jobber
--       with amounts.depositAmount = 0 and amounts.paymentsTotal = 0 even though
--       ~$26,797.50 was collected -- Jobber nets that into the CLIENT balance
--       ($67,214.41), which we already sync accurately into clients.balance.
--       Two other open clients (Goldstein, ACI) even hold NEGATIVE (credit)
--       balances that a per-invoice view structurally cannot represent.
--
--   sum(greatest(clients.balance, 0)) reproduces Jobber's Outstanding to within
--   $30 (sync-timing drift) using data we already sync. So AR is sourced HERE, at
--   the client level. invoice_balances (sql/044) is deliberately left untouched --
--   its per-invoice computed_balance is still correct and useful for line-item
--   drill-down and per-invoice status; it is simply the wrong granularity for the
--   company AR total.
--
--   Outstanding = greatest(balance, 0): a client in credit contributes 0, never a
--   negative that would silently net down another client's real debt. This mirrors
--   Jobber's "Outstanding (All)" column.
--
-- SECURITY (mirrors sql/039_jobs_enriched_view.sql -- do not simplify away):
--   * security_invoker = true  -> the view runs with the CALLER's rights, so the
--     clients table's RLS still applies (no definer-view PII bypass).
--   * explicit REVOKE from anon/authenticated -> the app reads it via the service
--     role only, the same trust model as the clients table itself.

create or replace view public.client_ar_outstanding
with (security_invoker = true) as
select
  c.jobber_id as client_id,
  coalesce(
    nullif(c.name, ''),
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
    nullif(c.company_name, '')
  ) as client_name,
  c.balance            as jobber_balance,
  greatest(c.balance, 0) as outstanding,
  c.jobber_web_uri,
  c.synced_at
from public.clients c
where c.balance > 0;

revoke all on public.client_ar_outstanding from anon, authenticated;

-- Company open-AR total (matches Jobber Client Balance Summary -> Outstanding):
--   select round(sum(outstanding), 2) as open_ar from public.client_ar_outstanding;

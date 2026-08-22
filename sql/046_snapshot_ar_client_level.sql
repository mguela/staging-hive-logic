-- 046: snapshot_aggregates() — source the AR "outstanding" dollar figure from
-- client-level balances instead of a per-invoice sum. See sql/045 + PR #22.
--
-- WHY (root cause, verified 2026-08-01):
--   The "Owed To You" tile reads snapshot.ar.outstanding (api/snapshot.js ->
--   this function). It was computed as sum(total - payments) over open invoices,
--   which OVERSTATED AR (it does not even subtract deposits, and — more
--   fundamentally — a per-invoice sum cannot see money Jobber records at the
--   client/job level and never applies to an individual invoice's amounts, e.g.
--   invoice #504265 / DeSalva change order: ~$26,797.50 collected but returned by
--   Jobber as depositAmount=0/paymentsTotal=0, netted only into the client
--   balance). Jobber's Client Balance Summary -> Outstanding is a CLIENT-level
--   figure ($291,191.02 on 2026-08-01).
--
--   Fix: outstanding now = sum(greatest(clients.balance,0)) via the
--   public.client_ar_outstanding view (sql/045), which reproduces Jobber's
--   Outstanding to within ~$30 (sync-timing drift) from data we already sync.
--
--   openInvoices / overdueCount / excluded remain PER-INVOICE on purpose — they
--   answer operational questions ("how many invoices are open / overdue") that
--   are legitimately invoice-level. Only the headline receivable dollar total is
--   moved to the client level. This means the tile can show "$291,161 across 44
--   open invoices" where naively summing those 44 invoices would not equal the
--   total; that gap IS the client-level netting and is the correct behavior.
--
--   Response shape is unchanged (ar.outstanding is still a number), so no API or
--   frontend change is required.
--
-- Security: unchanged from sql/040 — invoker rights, EXECUTE revoked from
-- anon/authenticated/public.

create or replace function public.snapshot_aggregates()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
with inv as (
  select lower(trim(coalesce(invoice_status,''))) as st,
         (coalesce(total,0) - coalesce(payments,0)) as bal,
         due_date
  from public.invoices
)
select jsonb_build_object(
  'counts', jsonb_build_object(
    'clients',       (select count(*) from public.clients),
    'activeClients', (select count(*) from public.clients where is_archived is distinct from true),
    'leads',         (select count(*) from public.clients where is_lead is true),
    'jobs',          (select count(*) from public.jobs),
    'invoices',      (select count(*) from public.invoices)
  ),
  'jobsByStatus', (
    select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
    from (
      select coalesce(nullif(job_status, ''), 'unknown') as k, count(*) as n
      from public.jobs group by 1
    ) g
  ),
  'ar', jsonb_build_object(
    'openInvoices', (select count(*) from inv where st in ('awaiting_payment','past_due') and bal > 0.01),
    -- Client-level receivable (matches Jobber Client Balance Summary -> Outstanding).
    'outstanding',  (select coalesce(round(sum(outstanding), 2), 0) from public.client_ar_outstanding),
    'overdueCount', (select count(*) from inv where st in ('awaiting_payment','past_due') and bal > 0.01 and due_date is not null and due_date < now()),
    'excluded', jsonb_build_object(
      'draftUnsent',       (select jsonb_build_object('count', count(*), 'amount', coalesce(round(sum(bal),2),0)) from inv where st = 'draft'    and bal > 0.01),
      'writtenOffBadDebt', (select jsonb_build_object('count', count(*), 'amount', coalesce(round(sum(bal),2),0)) from inv where st = 'bad_debt' and bal > 0.01),
      'markedPaid',        (select jsonb_build_object('count', count(*), 'amount', coalesce(round(sum(bal),2),0)) from inv where st = 'paid'     and bal > 0.01)
    )
  )
);
$fn$;

revoke execute on function public.snapshot_aggregates() from public, anon, authenticated;

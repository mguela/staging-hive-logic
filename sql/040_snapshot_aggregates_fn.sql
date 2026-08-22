-- 040: snapshot_aggregates() — Gate 1 continuation. See api/snapshot.js.
-- Computes /api/snapshot's counts + AR aggregates in one DB round-trip
-- (was ~15 paginated PostgREST requests downloading ~14k rows per call).
-- Semantics transcribed 1:1 from the old getSnapshotData() Node reductions.
-- APPLIED LIVE to Supabase 2026-07-30 via MCP migration 'snapshot_aggregates_fn'.
-- Security: invoker rights + EXECUTE revoked from anon/authenticated/public.

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
    'outstanding',  (select coalesce(round(sum(bal), 2), 0) from inv where st in ('awaiting_payment','past_due') and bal > 0.01),
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

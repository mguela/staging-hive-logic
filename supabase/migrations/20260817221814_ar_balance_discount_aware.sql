-- Keep all invoice-derived balance surfaces on the same money formula used
-- by api/invoices.js, api/clientportal.js, and Financial Intelligence:
--
--   total - payments - deposit - discount
--
-- The client-level AR headline remains sourced from client_ar_outstanding;
-- this migration only corrects the invoice counts/excluded buckets beside it
-- and the server-only invoice_balances/ar_aging views. The response shape and
-- view column shape are unchanged.

create or replace view public.invoice_balances
with (security_invoker = on) as
select
  jobber_id,
  invoice_number,
  client_id,
  job_id,
  invoice_status,
  total,
  payments,
  coalesce(deposit, 0) as deposit,
  round(
    total
      - payments
      - coalesce(deposit, 0)
      - coalesce(discount, 0),
    2
  ) as computed_balance,
  case
    when invoice_status = 'paid'
      and abs(
        total
          - payments
          - coalesce(deposit, 0)
          - coalesce(discount, 0)
      ) >= 0.01
      then 'residual_on_paid'
    else 'computed'
  end as balance_source,
  issued_date,
  due_date
from public.invoices;

revoke all on public.invoice_balances from anon, authenticated;
grant select on public.invoice_balances to service_role;

create or replace function public.snapshot_aggregates()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
with inv as (
  select
    lower(trim(coalesce(invoice_status, ''))) as st,
    (
      coalesce(total, 0)
        - coalesce(payments, 0)
        - coalesce(deposit, 0)
        - coalesce(discount, 0)
    ) as bal,
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
      from public.jobs
      group by 1
    ) g
  ),
  'ar', jsonb_build_object(
    'openInvoices', (
      select count(*)
      from inv
      where st in ('awaiting_payment', 'past_due') and bal > 0.01
    ),
    -- Do not regress this to an invoice sum. Jobber nets some money only at
    -- client level, so the headline must remain client_ar_outstanding.
    'outstanding', (
      select coalesce(round(sum(outstanding), 2), 0)
      from public.client_ar_outstanding
    ),
    'overdueCount', (
      select count(*)
      from inv
      where st in ('awaiting_payment', 'past_due')
        and bal > 0.01
        and due_date is not null
        and due_date < now()
    ),
    'excluded', jsonb_build_object(
      'draftUnsent', (
        select jsonb_build_object(
          'count', count(*),
          'amount', coalesce(round(sum(bal), 2), 0)
        )
        from inv
        where st = 'draft' and bal > 0.01
      ),
      'writtenOffBadDebt', (
        select jsonb_build_object(
          'count', count(*),
          'amount', coalesce(round(sum(bal), 2), 0)
        )
        from inv
        where st = 'bad_debt' and bal > 0.01
      ),
      'markedPaid', (
        select jsonb_build_object(
          'count', count(*),
          'amount', coalesce(round(sum(bal), 2), 0)
        )
        from inv
        where st = 'paid' and bal > 0.01
      )
    )
  )
);
$fn$;

revoke execute on function public.snapshot_aggregates() from public, anon, authenticated;
grant execute on function public.snapshot_aggregates() to service_role;

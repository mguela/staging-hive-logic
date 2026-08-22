-- sql/080_employee_pay_gusto_link.sql
--
-- Payroll productionization: store the Gusto employee + job UUIDs on the
-- employee_pay row so a HiveLogic person maps durably to their Gusto record.
-- The timesheet push and payroll sync both key off this instead of guessing.
--
-- Additive only (two nullable text columns + an index). Safe to apply live.

begin;

alter table public.employee_pay add column if not exists gusto_employee_uuid text;
alter table public.employee_pay add column if not exists gusto_job_uuid text;

-- Fast lookup by Gusto employee (e.g. when a timesheet or payroll row references it).
create index if not exists employee_pay_gusto_idx
  on public.employee_pay (gusto_employee_uuid)
  where gusto_employee_uuid is not null;

commit;

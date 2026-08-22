-- Dev To-Do ownership and deadlines. Kept server-only through the existing
-- service_role API boundary; no browser roles receive table privileges.
alter table public.app_status_findings
  add column if not exists assigned_to text,
  add column if not exists due_date date;

create index if not exists app_status_findings_due_open_idx
  on public.app_status_findings (due_date)
  where status in ('open', 'in_progress') and due_date is not null;

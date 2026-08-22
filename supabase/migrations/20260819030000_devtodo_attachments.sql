-- Let a Dev To-Do report carry screenshots/pictures, so whoever picks up the
-- finding has a clear image of what's wrong instead of just a text summary.
--
-- Image bytes live in the private `devtodo-attachments` Storage bucket at
-- storage_path; this table is just the pointer + metadata (mirrors the
-- monitor_screenshots / monitor-screenshots split in sql/050_monitor_tables.sql).
-- Service-role only: RLS is enabled with NO policies. Every read/write goes
-- through api/track1.js using the Supabase service key -- the browser never
-- touches this table or the bucket directly, and never sees anything but a
-- short-lived signed URL.

create table if not exists public.app_status_finding_attachments (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.app_status_findings(id) on delete cascade,
  storage_path text not null,
  content_type text not null check (content_type in ('image/png', 'image/jpeg')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists app_status_finding_attachments_finding_idx
  on public.app_status_finding_attachments (finding_id, created_at asc);

alter table public.app_status_finding_attachments enable row level security;
revoke all on table public.app_status_finding_attachments from public, anon, authenticated;
grant select, insert, update, delete on table public.app_status_finding_attachments to service_role;

insert into storage.buckets (id, name, public)
values ('devtodo-attachments', 'devtodo-attachments', false)
on conflict (id) do update
set public = false;

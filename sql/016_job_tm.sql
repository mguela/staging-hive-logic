-- T&M / Service Lane (Chris's ask, 2026-07-21): unified job intake, no separate
-- T&M screen. A checkbox on the existing New Job form marks a job as T&M; a
-- rate-type dropdown lets dispatch pick a predetermined hourly rate.
-- job_workflow already carries per-job overlay state, so T&M flags live here
-- too, keeping the Jobber-synced `jobs` table untouched.
alter table job_workflow
  add column if not exists is_tm boolean not null default false,
  add column if not exists tm_service_type text,
  add column if not exists tm_rate_hourly numeric;

comment on column job_workflow.is_tm is
  'True if this job was created/flagged as Time & Materials (vs fixed-bid). Set at intake via the New Job form checkbox.';
comment on column job_workflow.tm_service_type is
  'Key into tm_rate_types.key -- which predetermined rate this T&M job uses.';
comment on column job_workflow.tm_rate_hourly is
  'Snapshot of tm_rate_types.rate_hourly at the time this job was created, so later rate-table edits do not silently change already-booked jobs.';

-- Real, Chris-confirmed rate table. Starts with exactly ONE row: the $225/hr
-- general T&M rate Chris gave directly (2026-07-21 Cowork conversation). No
-- other service-type rates are invented -- more rows get added only when
-- Chris supplies the real numbers.
create table if not exists tm_rate_types (
  key text primary key,
  label text not null,
  rate_hourly numeric not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table tm_rate_types is
  'Predetermined T&M hourly rates by type of service, per Chris (2026-07-21). Edit/add rows here to expand the New Job T&M dropdown -- never hardcode rates in app code.';

insert into tm_rate_types (key, label, rate_hourly)
values ('general', 'General T&M (any work/repair)', 225)
on conflict (key) do nothing;

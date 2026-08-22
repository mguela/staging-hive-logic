-- supabase/migrations/20260816140000_fleet_slice6_job_presence.sql
--
-- HiveLogic Fleet — Slice 6: fleet_job_presence.
-- Detected "truck X was at job Y from arrived_at to departed_at" intervals,
-- produced by the geofence/presence detector (api/fleet/detect-presence.js).
-- Evidence only — nothing here decides billing.
--
-- Decisions (docs/fleet/HIVELOGIC-FLEET-SLICE0-RECON.md):
--   * job_uuid uuid REFERENCES public.jobs(uuid_id) — house style, NOT text job_external_id.
--   * Tenant: company_id uuid NOT NULL default GH; service-role-only RLS lockdown.
--   * Actor (manual corrections): corrected_by_profile_id uuid -> profiles(id).
--   * Idempotency: the detector re-derives intervals each run, so a still-open
--     visit keeps the same arrived_at while departed_at grows. UNIQUE
--     (company_id, vehicle_id, job_uuid, arrived_at) lets the detector UPSERT
--     the growing interval instead of inserting duplicates.
--
-- Additive; no existing table altered. Rollback: drop table fleet_job_presence.

create table if not exists public.fleet_job_presence (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'
                             references public.companies(id),
  job_uuid                 uuid references public.jobs(uuid_id),
  vehicle_id               uuid references public.fleet_vehicles(id),
  arrived_at               timestamptz not null,
  departed_at              timestamptz,
  arrival_confidence       smallint,
  departure_confidence     smallint,
  arrival_source           text not null default 'geofence_engine'
                             check (arrival_source in ('geofence_engine','manual')),
  departure_source         text check (departure_source in ('geofence_engine','manual')),
  arrival_position_id      uuid references public.fleet_positions(id),
  departure_position_id    uuid references public.fleet_positions(id),
  sample_count             int,
  status                   text not null default 'present'
                             check (status in ('present','complete','corrected')),
  corrected_by_profile_id  uuid references public.profiles(id),   -- authenticated actor
  correction_reason        text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint uq_fleet_job_presence unique (company_id, vehicle_id, job_uuid, arrived_at)
);

comment on table public.fleet_job_presence is
  'Detected truck-at-jobsite intervals (geofence engine). Evidence only; never decides billing. Feeds Reina TIME_MISMATCH after human verification.';

create index if not exists ix_fleet_job_presence_job     on public.fleet_job_presence (job_uuid, arrived_at desc);
create index if not exists ix_fleet_job_presence_vehicle on public.fleet_job_presence (vehicle_id, arrived_at desc);
create index if not exists ix_fleet_job_presence_open    on public.fleet_job_presence (company_id, status) where status = 'present';

-- Service-role-only lockdown (the established app-wide pattern).
alter table public.fleet_job_presence enable row level security;
revoke all on public.fleet_job_presence from anon, authenticated;
drop policy if exists "service role full access fleet_job_presence" on public.fleet_job_presence;
create policy "service role full access fleet_job_presence" on public.fleet_job_presence for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ROLLBACK: drop table if exists public.fleet_job_presence cascade;

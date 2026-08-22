-- supabase/migrations/20260814192951_fleet_slice1_schema.sql
--
-- HiveLogic Fleet — Slice 1: tenant-safe schema (core).
-- Tables: fleet_vehicles, fleet_telematics_devices, fleet_device_vehicle_assignments,
--         fleet_positions, fleet_vehicle_latest, fleet_events.
-- No UI, no ingest, no business logic. Migrations only.
--
-- Governing decisions (see docs/fleet/HIVELOGIC-FLEET-SLICE0-RECON.md):
--
--   TENANT MODEL — single-tenant, service-role-only (NOT per-company RLS). Every table:
--     company_id uuid NOT NULL REFERENCES public.companies(id) DEFAULT Greenwich Handyman's id
--     ('82cf7354-e460-4863-9f01-d67b3ad05d4a' — the same literal jobs/invoices already default to),
--     then: enable RLS, revoke anon/authenticated, single service_role "for all" policy.
--     We deliberately create NO company_id-predicated policy — nothing else in the app has one
--     and the deployment is single-tenant. Multi-tenant isolation is a future, app-wide change.
--
--   JOB REFERENCES — job_uuid uuid REFERENCES public.jobs(uuid_id), matching the ~20 existing
--     FK constraints in production. NOT the spec's original "job_external_id text". The inbound
--     Jobber id is resolved to jobs.uuid_id via public.external_refs at ingest time (later slice).
--     jobs.uuid_id is nullable but carries a UNIQUE constraint, so it is a valid FK target.
--
--   PERSON REFERENCES — two distinct identities, never an ambiguous "employee_id":
--     *_profile_id     uuid REFERENCES public.profiles(id)     -> authenticated actor
--                                                                 (dispatcher/admin actions, audit)
--     *_user_jobber_id text REFERENCES public.users(jobber_id) -> Jobber-sourced crew identity
--
--   VEHICLE MIRROR LINKAGE — fleet_vehicles is HiveLogic-native (uuid PK). The existing
--     public.vehicles table stays the Jobber/FleetSharp mirror and is NEVER written to by Fleet.
--     Primary link is BY VIN: fleet_vehicles.vin == public.vehicles.vin (FleetSharp already
--     matches on VIN). public.vehicles.vin has no unique constraint, so this is a documented JOIN
--     convention, not an FK. Where VIN is absent/unreliable, fall back to an external_refs-style
--     mapping row (system='fleet_vehicle_mirror', entity_id=fleet_vehicles.id,
--     external_id=vehicles.jobber_id) rather than guessing. No mirror-pointer column is added,
--     precisely to avoid encoding a guess.
--
--   FORWARD REFERENCES not yet created (added in their own slices) are intentionally left as bare
--     uuid columns with NO foreign key: active_trip_id / trip_id (fleet_trips = Slice 5),
--     asset_id (fleet_assets = Slice 8). Documented inline.
--
-- Idempotent: create table / index / constraint guards throughout; policies use drop-if-exists.
-- Rollback: see the companion "ROLLBACK" comment block at the foot of this file.

-- ============================================================================================
-- 1. fleet_vehicles — HiveLogic-native vehicle record (the roster's source of truth)
-- ============================================================================================
create table if not exists public.fleet_vehicles (
  id                              uuid primary key default gen_random_uuid(),
  company_id                      uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'
                                    references public.companies(id),
  -- Stable, human-traceable key back to the spec §5 roster. Makes the seed idempotent and
  -- lets ops/back-office reference a vehicle before VINs are captured. Nullable for any
  -- vehicle added later through the (future) admin UI rather than the roster seed.
  roster_slug                     text,
  division_org_unit_id            uuid references public.org_units(id),
  year                            int,
  make                            text,
  model                           text,
  trim                            text,
  vehicle_class                   text check (vehicle_class in ('car','van','pickup','heavy')),
  -- Linkage key to the Jobber/FleetSharp mirror public.vehicles (join on vin). Nullable at seed
  -- time (roster has no VINs yet); unique per company when present.
  vin                             text,
  plate                           text,
  plate_state                     text,
  home_base_type                  text not null default 'shop' check (home_base_type in ('shop','home')),
  -- Authenticated app-account (public.profiles.id) whose home is the base (home_base_type='home').
  -- Home base resolves to a protected home address with restricted visibility, so it lives on the
  -- authenticated app-account side, not the Jobber crew mirror (public.users). Nullable; the admin
  -- UI (Slice 5A) enforces "home base requires an employee" — not enforced at seed because roster
  -- names are not yet resolved to a profile.
  home_base_profile_id            uuid references public.profiles(id),
  status                          text not null default 'active' check (status in ('active','retired')),
  -- 'untracked' is a valid transient operational state (no device fitted yet), not a fault.
  tracker_state                   text not null default 'untracked'
                                    check (tracker_state in ('tracked','untracked','offline','retired')),
  -- Schema keeps work_hours/disabled for future commercial tenants; every GH vehicle ships 'always'.
  tracking_policy                 text not null default 'always'
                                    check (tracking_policy in ('always','work_hours','disabled')),
  -- Supports Sandro's two-vehicle case: Silverado primary, Ram 5500 dump secondary.
  is_primary_for_assigned_driver  boolean not null default true,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  retired_at                      timestamptz,
  constraint uq_fleet_vehicles_roster unique (company_id, roster_slug)
);

comment on table public.fleet_vehicles is
  'HiveLogic-native fleet vehicle. Linked to the Jobber/FleetSharp mirror public.vehicles by VIN (fallback: external_refs). Fleet never writes to public.vehicles.';
comment on column public.fleet_vehicles.vin is
  'Primary linkage key to public.vehicles.vin (documented join, not an FK). Fallback linkage: external_refs mapping row.';
comment on column public.fleet_vehicles.home_base_profile_id is
  'Authenticated app-account (public.profiles.id, uuid). Home base = a protected home address with restricted visibility, so it lives on the app-account side, not the Jobber crew mirror (public.users). Nullable.';

create index if not exists ix_fleet_vehicles_company_status on public.fleet_vehicles (company_id, status);
create index if not exists ix_fleet_vehicles_division      on public.fleet_vehicles (division_org_unit_id);
create unique index if not exists ux_fleet_vehicles_company_vin
  on public.fleet_vehicles (company_id, vin) where vin is not null;

-- ============================================================================================
-- 2. fleet_telematics_devices — physical trackers (G150 etc.). Empty in Slice 1 (no hardware yet).
-- ============================================================================================
create table if not exists public.fleet_telematics_devices (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'
                        references public.companies(id),
  provider            text not null default 'digital_matter',
  product             text,                          -- e.g. 'g150_global'
  hardware_revision   text,                          -- e.g. '108.2' (Rev 2)
  provider_device_id  text not null,                 -- device serial/identifier from the protocol
  imei                text,
  sim_iccid           text,
  firmware_version    text,
  device_status       text not null default 'provisioning'
                        check (device_status in ('provisioning','online','offline','retired')),
  last_seen_at        timestamptz,
  last_ip             inet,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_fleet_devices_provider_device unique (provider, provider_device_id)
);

create index if not exists ix_fleet_devices_company_status on public.fleet_telematics_devices (company_id, device_status);

-- ============================================================================================
-- 3. fleet_device_vehicle_assignments — timestamped device<->vehicle history (never overwritten)
-- ============================================================================================
create table if not exists public.fleet_device_vehicle_assignments (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'
                            references public.companies(id),
  device_id               uuid not null references public.fleet_telematics_devices(id),
  vehicle_id              uuid not null references public.fleet_vehicles(id),
  effective_from          timestamptz not null default now(),
  effective_to            timestamptz,
  assigned_by_profile_id  uuid references public.profiles(id),   -- authenticated actor
  reason                  text,
  created_at              timestamptz not null default now()
);

create index if not exists ix_fleet_dva_vehicle on public.fleet_device_vehicle_assignments (vehicle_id, effective_from desc);
create index if not exists ix_fleet_dva_device  on public.fleet_device_vehicle_assignments (device_id,  effective_from desc);

-- ============================================================================================
-- 4. fleet_positions — append-only normalized position records (empty until ingest, Slice 2/3)
-- ============================================================================================
create table if not exists public.fleet_positions (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'
                        references public.companies(id),
  device_id           uuid references public.fleet_telematics_devices(id),
  vehicle_id          uuid references public.fleet_vehicles(id),   -- resolved at event time
  device_event_index  bigint,                                       -- provider event/index, for idempotency
  device_time         timestamptz not null,
  received_at         timestamptz not null default now(),
  latitude            double precision,
  longitude           double precision,
  accuracy_m          real,
  speed               real,
  heading             real,
  altitude_m          real,
  ignition            boolean,
  inputs              jsonb,
  outputs             jsonb,
  odometer_m          bigint,
  run_hours_ms        bigint,
  event_code          int,
  valid_fix           boolean not null default true,
  raw_record_hash     text,                                         -- dedup/debug; no secrets
  ingest_sequence     bigint
);

-- §17 indexes.
create index if not exists ix_fleet_positions_device_time  on public.fleet_positions (device_id,  device_time desc);
create index if not exists ix_fleet_positions_vehicle_time on public.fleet_positions (vehicle_id, device_time desc);
-- Idempotency: a provider event index is unique per device when supplied; hash covers the rest.
create unique index if not exists ux_fleet_positions_device_eventindex
  on public.fleet_positions (device_id, device_event_index) where device_event_index is not null;
create index if not exists ix_fleet_positions_device_hash on public.fleet_positions (device_id, raw_record_hash);

-- ============================================================================================
-- 5. fleet_vehicle_latest — one compact row per vehicle for map/UI (Slice 4 consumer)
-- ============================================================================================
create table if not exists public.fleet_vehicle_latest (
  company_id        uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'
                      references public.companies(id),
  vehicle_id        uuid primary key references public.fleet_vehicles(id),
  position_id       uuid references public.fleet_positions(id),
  last_device_time  timestamptz,
  last_received_at  timestamptz,
  lat               double precision,
  lng               double precision,
  speed             real,
  heading           real,
  ignition          boolean,
  movement_state    text not null default 'unknown' check (movement_state in ('parked','idle','moving','unknown')),
  stale             boolean not null default true,
  active_trip_id    uuid,   -- FK to fleet_trips added in Slice 5 (table does not exist yet)
  active_job_uuid   uuid references public.jobs(uuid_id),
  updated_at        timestamptz not null default now()
);

create index if not exists ix_fleet_vehicle_latest_company_stale on public.fleet_vehicle_latest (company_id, stale);

-- ============================================================================================
-- 6. fleet_events — typed events with idempotency + dead-letter handling
-- ============================================================================================
create table if not exists public.fleet_events (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'
                        references public.companies(id),
  event_type          text not null,
  event_key           text not null,                 -- idempotency key, unique per company
  vehicle_id          uuid references public.fleet_vehicles(id),
  device_id           uuid references public.fleet_telematics_devices(id),
  trip_id             uuid,                            -- FK to fleet_trips added in Slice 5
  job_uuid            uuid references public.jobs(uuid_id),
  asset_id            uuid,                            -- FK to fleet_assets added in Slice 8
  actor_profile_id    uuid references public.profiles(id),  -- authenticated actor (source='manual')
  occurred_at         timestamptz not null,
  received_at         timestamptz not null default now(),
  confidence          smallint,
  source              text not null
                        check (source in ('ingest','geofence','custody','manual','maintenance','trip','health')),
  payload             jsonb,
  processing_status   text not null default 'new' check (processing_status in ('new','processed','dead_letter')),
  attempt_count       int not null default 0,
  last_error          text,
  constraint uq_fleet_events_company_key unique (company_id, event_key)
);

create index if not exists ix_fleet_events_company_type_time on public.fleet_events (company_id, event_type, occurred_at desc);
create index if not exists ix_fleet_events_unprocessed
  on public.fleet_events (processing_status) where processing_status <> 'processed';

-- ============================================================================================
-- 7. RLS — service-role-only lockdown on every Fleet table (the established app-wide pattern)
-- ============================================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'fleet_vehicles','fleet_telematics_devices','fleet_device_vehicle_assignments',
    'fleet_positions','fleet_vehicle_latest','fleet_events'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('revoke all on public.%I from anon, authenticated;', t);
    execute format('drop policy if exists %I on public.%I;', 'service role full access '||t, t);
    execute format(
      'create policy %I on public.%I for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');',
      'service role full access '||t, t
    );
  end loop;
end $$;

-- ============================================================================================
-- ROLLBACK (manual, if ever needed — Slice 1 is additive and safe to drop wholesale):
--   drop table if exists public.fleet_events                      cascade;
--   drop table if exists public.fleet_vehicle_latest              cascade;
--   drop table if exists public.fleet_positions                   cascade;
--   drop table if exists public.fleet_device_vehicle_assignments  cascade;
--   drop table if exists public.fleet_telematics_devices          cascade;
--   drop table if exists public.fleet_vehicles                    cascade;
-- No existing table is altered by this migration, so rollback touches only fleet_* objects.
-- ============================================================================================

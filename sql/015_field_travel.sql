-- 015_field_travel.sql
--
-- Field App "Start Travel" -> client-facing live tracking link.
-- ADDITIVE ONLY. Safe to run more than once. Run once in the Supabase SQL
-- editor, same as 002-014.
--
-- One row per travel run. The client-facing view (public/track/) reads it
-- through a capability token and only ever gets a COARSE truck position --
-- api/fieldops.js rounds coordinates to ~2 decimal places (:about a
-- half-mile) before serving them, per Chris's spec: "a very broad location
-- pictured on the map". Exact positions stay in this table for the office
-- only.
--
-- ETA is computed (distance / average speed + buffer), never invented --
-- and always labeled approximate in both the SMS and the tracking page.

create table if not exists travel_sessions (
  id uuid primary key default gen_random_uuid(),
  tech_id uuid not null,               -- profiles.id of the tech
  tech_name text,
  job_ref text,                        -- jobs.jobber_id (optional)
  visit_ref text,                      -- visits.jobber_id (optional)
  client_ref text,                     -- clients.jobber_id
  token text not null unique,          -- capability token for the client link
  dest_lat numeric not null,
  dest_lng numeric not null,
  dest_label text,                     -- street, city (client-facing)
  start_lat numeric,
  start_lng numeric,
  last_lat numeric,
  last_lng numeric,
  eta_minutes integer,                 -- ETA at start
  distance_miles numeric,
  status text not null default 'en_route',  -- en_route | arrived | canceled
  started_at timestamptz not null default now(),
  last_ping_at timestamptz,
  arrived_at timestamptz
);
create index if not exists travel_sessions_token_idx on travel_sessions (token);
create index if not exists travel_sessions_tech_idx on travel_sessions (tech_id, status);

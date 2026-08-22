-- 003_locations.sql
-- ADDITIVE ONLY. Supports the real service-area map: raw client addresses
-- (synced from Jobber) plus their geocoded lat/lng, and a single-row table
-- for the office HQ location. Does not alter any existing table.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Safe to run more than once (IF NOT EXISTS guards).

create table if not exists client_locations (
  jobber_id text primary key,
  street text,
  city text,
  province text,
  postal_code text,
  country text,
  lat numeric,
  lng numeric,
  geocode_match boolean,
  synced_at timestamptz,
  geocoded_at timestamptz
);
create index if not exists client_locations_geocode_idx on client_locations (lat, lng);

create table if not exists office_location (
  id text primary key,
  address text,
  lat numeric,
  lng numeric,
  geocoded_at timestamptz
);

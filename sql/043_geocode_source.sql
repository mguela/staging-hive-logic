-- sql/043_geocode_source.sql
-- Additive: record which geocoder produced each client_locations pin
-- (2026-07-31). Written by the ?resource=geocode maintenance run in
-- api/jobber/sync-extended.js: 'nominatim' for a rooftop-grade OpenStreetMap
-- hit, 'census' for the street-interpolated fallback. 'manual' is reserved for
-- pins a human placed/corrected (typically alongside geocode_locked = true).
-- Nullable, no backfill -- existing rows stay NULL until re-geocoded.

alter table client_locations
  add column if not exists geocode_source text;

-- Guard the vocabulary without blocking NULLs on legacy rows.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'client_locations_geocode_source_chk'
  ) then
    alter table client_locations
      add constraint client_locations_geocode_source_chk
      check (geocode_source is null or geocode_source in ('nominatim', 'census', 'manual'));
  end if;
end $$;

-- sql/089_division_service_areas.sql
--
-- Service area per division: where each brand actually works.
--
-- ⚠️ NOT APPLIED TO ANY DATABASE BY CLAUDE. Chris reviews and applies this.
--    Until it is applied, the Company Setup service-area editor is read-only
--    with a "migration pending" note, and every map keeps its current
--    hardcoded centre. Nothing errors.
--
-- WHY PER DIVISION, NOT PER COMPANY
-- A single circle centred on one HQ cannot describe this company. There are 8
-- divisions in production, and the plan has GH Co. running a Boca Raton
-- territory with its own hours and timezone -- 1,200 miles from Greenwich. One
-- radius would be wrong for everyone the day Florida opens, and retrofitting a
-- per-division model later means rewriting every consumer. So it is per
-- division from the start, with the primary division acting as the company
-- default for surfaces that have no division context.
--
-- WHY THESE COLUMNS AND NOT A company_settings SECTION
-- Divisions are real rows in org_units with their own edit path
-- (api/company.js?resource=division_update). A JSONB blob keyed by division id
-- in company_settings would put a division's data somewhere other than the
-- division, and would go stale the moment one is deleted. company_settings is
-- for settings with no home; this one has a home.
--
-- ON THE CENTRE
-- service_center_label is what a human typed ("Greenwich, CT"). The lat/lng are
-- what the geocoder resolved it to. They are stored separately on purpose: if
-- geocoding fails the label is still saved and shown, the coordinates stay
-- null, and the UI says the area is not usable yet -- rather than silently
-- keeping a stale pin that no longer matches the label.
--
-- NUMBERING: repo sql/ tops out at 087_automation_runners.sql (applied to prod
-- 2026-08-18 as 20260818005946). 088 was written for the outbox sender in a PR
-- that was closed unmerged -- see REPORT.md -- so nothing numbered 088 or 089
-- exists in sql/, supabase/migrations, or the production ledger. 089 is used
-- rather than reusing 088 because 088's number appeared in a published branch,
-- and a number that has ever been claimed in public is not worth recycling.
-- (043 remains permanently off-limits; not a factor here.)
--
-- Rollback:
--   alter table public.org_units
--     drop column service_center_label, drop column service_center_lat,
--     drop column service_center_lng, drop column service_radius_miles,
--     drop column service_area_updated_at;

begin;

alter table public.org_units add column if not exists service_center_label   text;
alter table public.org_units add column if not exists service_center_lat     numeric;
alter table public.org_units add column if not exists service_center_lng     numeric;
alter table public.org_units add column if not exists service_radius_miles   numeric;
alter table public.org_units add column if not exists service_area_updated_at timestamptz;

comment on column public.org_units.service_center_label is
  'What a human typed as the centre of this division''s service area, e.g. "Greenwich, CT". The source of truth for what was meant; the lat/lng are only a geocode of it.';
comment on column public.org_units.service_center_lat is
  'Geocoded latitude of service_center_label. Null means the label has not been resolved yet, and the area cannot drive a map or a geofence.';
comment on column public.org_units.service_radius_miles is
  'How far this division travels from its centre. Drives the default map view, out-of-area flagging and ad geo-targeting.';

-- Guard rails. These are the values a typo produces, and every one of them
-- would put a map somewhere absurd rather than fail loudly.
alter table public.org_units drop constraint if exists org_units_service_lat_range;
alter table public.org_units add constraint org_units_service_lat_range
  check (service_center_lat is null or (service_center_lat >= -90 and service_center_lat <= 90));

alter table public.org_units drop constraint if exists org_units_service_lng_range;
alter table public.org_units add constraint org_units_service_lng_range
  check (service_center_lng is null or (service_center_lng >= -180 and service_center_lng <= 180));

-- 0 is not "no radius" -- it is a circle you can never work in. Absent is
-- expressed by null. The 500-mile ceiling is a typo guard (a stray extra digit
-- on 50), not a business rule; raise it if a division ever genuinely needs it.
alter table public.org_units drop constraint if exists org_units_service_radius_sane;
alter table public.org_units add constraint org_units_service_radius_sane
  check (service_radius_miles is null or (service_radius_miles > 0 and service_radius_miles <= 500));

-- A half-set centre is worse than none: it would place a pin on the equator.
alter table public.org_units drop constraint if exists org_units_service_center_complete;
alter table public.org_units add constraint org_units_service_center_complete
  check ((service_center_lat is null) = (service_center_lng is null));

commit;

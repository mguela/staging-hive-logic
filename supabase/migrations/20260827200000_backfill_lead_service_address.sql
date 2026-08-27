-- jomell, 2026-08-27: "the address that i set when i entered a new lead"
-- never showed up in the estimate builder, invoices, or Active Jobs -- the
-- New Lead form's address field (lead_pipeline.service_address) was never
-- the same table those all read (client_locations). Fixed going forward in
-- api/track1.js's lead POST handler; this backfills every lead already
-- sitting with an address that never made it across, so a client entered
-- before today's fix isn't stuck.
--
-- Insert-only, one row per client, and only where client_locations has
-- nothing yet -- a client with a real structured address already on file
-- (from Jobber sync or the client card) keeps it exactly as-is. When a
-- client has more than one lead_pipeline row, the most recently updated
-- one with a real address wins. lat/lng left null for the existing
-- geocoder to fill, same as every other HiveLogic-entered address.
--
-- hl:replay-safe: idempotent by construction (NOT EXISTS guard) -- a second
-- run finds zero clients still missing a row and inserts nothing.

begin;

insert into public.client_locations (jobber_id, street)
select distinct on (lp.client_id) lp.client_id, trim(lp.service_address)
from public.lead_pipeline lp
where lp.service_address is not null
  and trim(lp.service_address) <> ''
  and not exists (
    select 1 from public.client_locations cl where cl.jobber_id = lp.client_id
  )
order by lp.client_id, lp.updated_at desc nulls last;

commit;

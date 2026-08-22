-- Where an appointment came from.
--
-- Additive: two nullable columns. The pipeline the schedule plan describes --
-- lead -> site visit -> estimate -> job -> field visits -- needs each stage to
-- say what created it, or the calendar shows a site visit with no way back to
-- the lead that asked for it.
--
-- Text rather than uuid/fk on purpose: leads and estimates are identified by
-- Jobber ids in this codebase (see jobs.jobber_id), which are opaque strings,
-- and a foreign key to a synced table would make an appointment undeletable
-- from Jobber's side.
alter table public.hl_appointments
  add column if not exists source_lead_id text,
  add column if not exists source_estimate_id text;

create index if not exists hl_appointments_source_lead_idx
  on public.hl_appointments (source_lead_id) where source_lead_id is not null;

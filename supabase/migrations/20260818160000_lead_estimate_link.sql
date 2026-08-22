-- Link a lead to the estimate raised from it (Phase 0, item 5) — 2026-08-17
--
-- The lead board already tracks stages 'estimate_booked' and 'estimate_sent',
-- and 20 of the 58 live leads sit in estimate_booked today. But nothing
-- connected a lead to an actual estimate: someone moved the card by hand, and
-- the estimate — if one was ever raised — had no idea which lead it came from.
--
-- That was the last unlinked hop in the chain. With this, a project is
-- traceable end to end: lead → E-10001 → J-10001 → CO-10001-1 → INV-10001-1.
--
-- estimate_id holds the estimate's own logical id (estimates.data->>'id'), the
-- same value every /api/bookkeeping/estimates/* route addresses an estimate by.
-- Deliberately not a foreign key: estimates live in a jsonb document store
-- whose logical id is inside the document, so there is no column for Postgres
-- to reference. The link is enforced by the route that sets it, which reads the
-- estimate back before writing the lead.
--
-- The reverse link (which lead an estimate came from) needs no migration —
-- estimates are jsonb, so sourceLeadId rides inside the document.

alter table public.lead_pipeline add column if not exists estimate_id text;

comment on column public.lead_pipeline.estimate_id is
  'The estimate raised from this lead (estimates.data->>''id''). Null until one is created. The estimate carries sourceLeadId pointing back.';

-- "Which lead produced this estimate" is the lookup that keeps the two in step
-- when an estimate is sent, approved or converted.
create index if not exists idx_lead_pipeline_estimate_id
  on public.lead_pipeline (estimate_id)
  where estimate_id is not null;

-- Leads become opportunities, not people.
--
-- A "lead" in HiveLogic has meant a person: lead_pipeline.client_id carried a
-- UNIQUE constraint, so a client could have exactly one lead at a time. Chris's
-- definition is a potential JOB -- a ten-year customer asking for a bathroom is
-- as much a lead as a stranger off the website, and you can lose either one.
--
-- The production data backs that up: 282 clients have sent more than one
-- request, one has sent 12, and the average gap between a client's first and
-- last request is 344 days. Those are separate jobs quoted separately, not
-- revisions of one. Barrie Levitt alone has water damage (2023), windows
-- (2023), a bathroom (2024) and railing/painting (2025). Under the old shape
-- only one of those could sit on the board at a time.
--
-- Safe to run now precisely because nobody has adopted the table yet: 4 rows,
-- none with a lead_source, estimated_value or referral recorded, no views,
-- triggers or RLS policies depending on it. The same change against a few
-- hundred live leads would be a far more delicate migration.
--
-- Ships together with the API/frontend rewire in the same PR. The upserts in
-- api/track1.js key on ON CONFLICT (client_id) and stop working the moment the
-- UNIQUE constraint is dropped, so schema and code cannot land separately.

-- 1. What the opportunity is ------------------------------------------------

-- A job name. Without it, three live opportunities for one client render as
-- three identical cards reading "Barrie Levitt". Seeded from the originating
-- request's own title ("Look at bathroom work"), so it is the customer's own
-- wording rather than something invented.
alter table public.lead_pipeline
  add column if not exists title text;

-- Where the opportunity came from, when it came from a Jobber request.
-- Nullable on purpose: an opportunity typed in by hand (someone stops you at
-- the hardware store) has no request behind it, and that stays supported.
--
-- ON DELETE SET NULL, not CASCADE: if a request is removed upstream in Jobber,
-- the opportunity and everything logged against it -- stage history, value,
-- lost reason -- is HiveLogic's own work and must survive. Only the back-link
-- goes blank.
alter table public.lead_pipeline
  add column if not exists request_id text
  references public.requests(jobber_id) on delete set null;

-- 2. Multi-tenant readiness -------------------------------------------------

-- clients, jobs and invoices already carry company_id; lead_pipeline did not.
-- Adding it while the table holds 4 rows is free. Adding it once the table is
-- the live sales pipeline for a paying customer is not. Nullable and unenforced
-- for now -- this deployment is single-tenant and the tenancy spine lands with
-- the wider conversion (MULTI-TENANT-CONVERSION-PLAN.md); this is just the
-- column being in place when it does.
alter table public.lead_pipeline
  add column if not exists company_id uuid;

-- 3. Drop the one-lead-per-client rule --------------------------------------

-- The actual model change. Everything above is additive and harmless on its
-- own; this is the line that requires the code rewire to ship with it.
alter table public.lead_pipeline
  drop constraint if exists lead_pipeline_client_id_key;

-- client_id keeps its foreign key and NOT NULL -- every opportunity still
-- belongs to exactly one client. It simply is no longer unique across rows.
-- The UNIQUE constraint was also providing the lookup index for
-- "leads for this client", which is the board's hot path, so replace it with a
-- plain index rather than losing it.
create index if not exists lead_pipeline_client_id_idx
  on public.lead_pipeline (client_id);

-- One opportunity per request. Two rows pointing at the same Jobber request
-- would be a duplicate card on the board, and the backfill in a later step
-- re-runs, so this needs to be enforced rather than assumed. Partial, because
-- hand-entered opportunities all have request_id NULL and must not collide.
create unique index if not exists lead_pipeline_request_id_key
  on public.lead_pipeline (request_id)
  where request_id is not null;

create index if not exists lead_pipeline_company_id_idx
  on public.lead_pipeline (company_id)
  where company_id is not null;

-- 4. Backfill titles for the rows that already exist ------------------------

-- The 4 existing rows predate the title column. Give them the client's name so
-- no card renders blank; anything created from here on gets a real job title.
update public.lead_pipeline lp
set title = c.name
from public.clients c
where lp.client_id = c.jobber_id
  and lp.title is null
  and c.name is not null;

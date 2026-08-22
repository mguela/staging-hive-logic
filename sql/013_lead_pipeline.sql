-- sql/013_lead_pipeline.sql
-- Real pipeline/CRM metadata for the Sales > Leads page.
--
-- Context: Jobber only syncs Clients/Jobs/Invoices/Requests/Quotes/Visits --
-- it has no concept of "lead stage", dollar value, lead source, response-time
-- SLA timestamps, or lost reasons. The Leads page mockup shows all of that,
-- but until now none of it existed anywhere real (confirmed live: the
-- previous loadLeadsLive() explicitly said "NOT wired -- no lead-stage/SLA
-- data" and never called any API).
--
-- Decision (Chris, 2026-07-21): rather than keep this page an honest-but-thin
-- read of `clients.is_lead`, build a real pipeline subsystem the team enters
-- data into directly -- closer to a real lightweight CRM than a Jobber sync.
--
-- One row per lead, 1:1 with a `clients` row (real Jobber-synced client OR a
-- HiveLogic-only client created via resource=create_client with is_lead:true).
-- Deliberately kept as its OWN table rather than new columns on `clients` --
-- the Jobber sync upserts `clients` wholesale from Jobber's own data on every
-- run, so anything not present in Jobber's sync payload doesn't belong on
-- that table (would just be silently dropped/ignored on the next sync).
create table if not exists lead_pipeline (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique references clients(jobber_id) on delete cascade,
  stage text not null default 'new'
    check (stage in ('new','contacted','estimate_booked','estimate_sent','won','lost')),
  estimated_value numeric,
  lead_source text,       -- referral | repeat_client | website | google | yard_sign | angi | thumbtack | yelp | facebook | other
  division text,          -- e.g. "GH Design|Build", "Greenwich Handyman" -- free text, matches the divisions already used elsewhere in the app
  need text,               -- "in their words" -- what they asked for
  phone text,
  service_address text,
  urgency text,            -- emergency | this_week | soon_flexible | future
  lost_reason text,        -- price | timing | went_with_competitor | ghosted | out_of_scope
  notes text,
  first_contacted_at timestamptz,  -- set the first time stage leaves 'new'
  last_contacted_at timestamptz,   -- set on every update
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_pipeline_stage_idx on lead_pipeline(stage);
create index if not exists lead_pipeline_updated_at_idx on lead_pipeline(updated_at);

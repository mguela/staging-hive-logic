-- The operational event feed: "AI should never let you miss an opportunity for
-- efficiency and also follow ups" (Chris, 2026-08-22).
--
-- WHAT THIS IS. One table that every detector writes into and one surface reads
-- from. A detector notices something worth a person's attention -- a job
-- finished and never got invoiced, a crew is still on site an hour past the
-- window, a client with a "no work" note has an appointment tomorrow -- and
-- records it here with the follow-up actions attached.
--
-- WHY ONE TABLE AND NOT ONE PER DOMAIN. The value is in the single feed. Fleet,
-- money, jobs and sales alerts living in four places is four places to check,
-- which is the problem this exists to remove. Detectors stay separate; storage
-- does not.
--
-- DEDUPE IS THE WHOLE DESIGN. Every detector runs on a schedule and will find
-- the same finished-but-uninvoiced job every hour until somebody invoices it.
-- Without a stable key that becomes a notification every hour forever, which
-- trains the reader to ignore the feed -- the one failure that makes the whole
-- feature worthless. `dedupe_key` is UNIQUE and detectors must build it to be
-- stable for "this fact, about this thing, at this stage" and must NOT include
-- a timestamp. Same rule api/_lib/automations.js already proved.
--
-- NOTHING HERE SENDS ANYTHING. These are observations and proposals. Acting on
-- one is a separate, explicit press, and anything customer-facing still goes
-- through the automations outbox behind its master switch.

create table if not exists public.ops_events (
  id            uuid primary key default gen_random_uuid(),

  -- Stable identity of the observation. See the dedupe note above.
  dedupe_key    text not null unique,

  -- What kind of thing this is, e.g. 'job.finished_not_invoiced'. Dotted
  -- domain.fact so a whole domain can be muted or routed as a group.
  kind          text not null,
  domain        text not null,

  -- How loudly to say it.
  --   'interrupt' -- money at risk or a person waiting. Allowed to notify.
  --   'digest'    -- worth knowing, not worth stopping for. Batched.
  --   'log'       -- recorded for context only; never surfaced on its own.
  severity      text not null default 'digest'
                check (severity in ('interrupt', 'digest', 'log')),

  -- Plain language, written by the detector. `title` is the sentence Chris
  -- reads; `detail` is the supporting line.
  title         text not null,
  detail        text,

  -- What this is about, so the feed can link straight to it. All nullable:
  -- a low-cash alert is about no single record.
  client_id     text,
  client_name   text,
  job_id        text,
  job_title     text,
  visit_id      text,
  vehicle_name  text,
  entity_url    text,

  -- The follow-ups offered, e.g.
  --   [{"action":"create_invoice","label":"Create the invoice now"}]
  -- Proposals only. Nothing here fires without a press.
  actions       jsonb not null default '[]'::jsonb,

  -- Anything the detector wants to show or explain itself with.
  facts         jsonb not null default '{}'::jsonb,

  -- open      -- needs a decision
  -- acted     -- somebody pressed one of the actions
  -- dismissed -- somebody said "not this one"
  -- resolved  -- the underlying condition went away on its own
  status        text not null default 'open'
                check (status in ('open', 'acted', 'dismissed', 'resolved')),

  -- Who gets it. Null means everyone who can see the feed.
  audience_role text,

  created_at    timestamptz not null default now(),
  acted_at      timestamptz,
  acted_by      uuid,
  acted_action  text,
  resolved_at   timestamptz,

  -- Set when a detector re-finds a still-true fact, so "this has been true for
  -- three days" is answerable without a second table.
  last_seen_at  timestamptz not null default now()
);

-- The feed reads open events newest first, and detectors re-check by key.
create index if not exists ops_events_open_idx on public.ops_events (created_at desc) where status = 'open';
create index if not exists ops_events_kind_idx on public.ops_events (kind);
create index if not exists ops_events_client_idx on public.ops_events (client_id) where client_id is not null;
create index if not exists ops_events_job_idx on public.ops_events (job_id) where job_id is not null;

comment on column public.ops_events.dedupe_key is
  'Stable for "this fact about this thing at this stage". Never contains a timestamp -- a key that changes each run turns the feed into noise.';

-- Silence, and only ever from something somebody pressed.
--
-- The rule borrowed from api/_lib/reina-notify.js, which got this right for
-- mail: nothing infers silence. Being wrongly noisy costs a click; being
-- wrongly quiet costs a job. Those are not symmetric, so a rule only exists
-- because a person made it, and it is visible and reversible.
create table if not exists public.ops_event_mutes (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  -- Null scope mutes the kind everywhere; set one to mute it for a single
  -- client, job or vehicle only.
  client_id   text,
  job_id      text,
  vehicle_name text,
  muted_by    uuid,
  reason      text,
  created_at  timestamptz not null default now()
);

create unique index if not exists ops_event_mutes_scope_idx
  on public.ops_event_mutes (kind, coalesce(client_id, ''), coalesce(job_id, ''), coalesce(vehicle_name, ''));

-- Detector bookkeeping: when each one last ran and what it found. Without this
-- a detector that silently stops producing looks identical to one with nothing
-- to report, which is how a broken alert goes unnoticed for a month.
create table if not exists public.ops_detector_runs (
  id            uuid primary key default gen_random_uuid(),
  detector      text not null,
  ran_at        timestamptz not null default now(),
  found         integer not null default 0,
  created       integer not null default 0,
  resolved      integer not null default 0,
  duration_ms   integer,
  error         text
);

create index if not exists ops_detector_runs_recent_idx on public.ops_detector_runs (detector, ran_at desc);

-- Client flags: "No work — prior bad experience" and its relatives.
--
-- Chris asked for an alert when a client he has decided not to work for turns
-- up on the calendar. There was no way to record that decision anywhere in the
-- app, so the flag has to exist before the alert can. `clients` is owned by the
-- Jobber sync and gets overwritten, so this is a separate table keyed to the
-- client rather than a column on it.
--
-- Free-text `reason` on purpose: "prior bad experience" is the useful part, and
-- a dropdown of pre-decided reasons would lose it.
create table if not exists public.client_flags (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  flag        text not null check (flag in ('no_work', 'do_not_contact', 'vip', 'payment_risk')),
  reason      text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  cleared_at  timestamptz,
  cleared_by  uuid
);

-- One live flag of each kind per client; clearing sets cleared_at rather than
-- deleting, so "we un-flagged them in June" stays answerable.
create unique index if not exists client_flags_live_idx
  on public.client_flags (client_id, flag) where cleared_at is null;
create index if not exists client_flags_client_idx on public.client_flags (client_id) where cleared_at is null;

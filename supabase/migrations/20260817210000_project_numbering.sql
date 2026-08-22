-- Project numbering (Phase 0, item 1) — 2026-08-17
--
-- Chris's rule: ONE number follows a project for its whole life, and each
-- document wears its own prefix:
--
--     E-10001         the estimate
--     J-10001         the job it converts into
--     CO-10001-1      change orders against that job
--     INV-10001-1     invoices against that job
--     J-10001-EL      GH Electric's internal work order on that job
--
-- So the counter here allocates a PROJECT sequence, not a "job number" — the
-- estimate and the job deliberately share one. This mirrors est_counters /
-- co_counters / po_counters exactly (same insert-on-conflict-returning shape,
-- same text company_id) so all four counters behave identically under
-- concurrency: two people creating estimates at the same instant can never be
-- handed the same number.
--
-- Why start at 10000: Jobber's own job numbers currently run 1–2999 and keep
-- climbing, and during the parallel-running period both systems are in use at
-- once. Starting at 10000 makes every HiveLogic project number five digits and
-- every Jobber one four or fewer, so "job 2999" and "J-10001" can never be
-- confused — in writing OR out loud. Nothing enforces this at the database
-- level; it is bought purely by where the counter starts.

create table if not exists public.project_counters (
  company_id    text    not null primary key,
  next_sequence integer not null default 10000,
  updated_at    timestamptz not null default now()
);

alter table public.project_counters owner to postgres;

comment on table public.project_counters is
  'One row per company. next_sequence holds the LAST allocated project number (same convention as est_counters). Allocate via allocate_project_number(), never by reading and writing this table directly.';

-- Allocates and returns the next project sequence for a company, atomically.
--
-- The insert-on-conflict-do-update-returning form is what makes this safe: the
-- row is locked by the upsert itself, so concurrent callers serialise and each
-- gets a distinct number. Reading `next_sequence` and then writing it back
-- would not be safe, and is why this is a function rather than app-side logic.
--
-- First call for a company inserts 10000 and returns it; each later call
-- increments and returns the new value.
create or replace function public.allocate_project_number(p_company_id text)
returns table (sequence_no integer)
language plpgsql
as $$
declare
  v_seq integer;
begin
  if p_company_id is null or p_company_id = '' then
    raise exception 'A company id is required to allocate a project number.';
  end if;

  insert into public.project_counters (company_id, next_sequence)
    values (p_company_id, 10000)
  on conflict (company_id)
    do update set next_sequence = public.project_counters.next_sequence + 1,
                  updated_at = now()
  returning public.project_counters.next_sequence into v_seq;

  if v_seq is null then
    v_seq := 10000;
  end if;

  sequence_no := v_seq;
  return next;
end;
$$;

alter function public.allocate_project_number(text) owner to postgres;

-- ---------------------------------------------------------------------------
-- Jobs: carry the project number, the division, and the estimate it came from.
-- ---------------------------------------------------------------------------
--
-- project_seq is the 10001 in J-10001. It is deliberately NOT the existing
-- job_number column: job_number holds Jobber's own numbering (1–2999) for the
-- 2,775 synced jobs, and mixing the two would make "which system numbered
-- this?" unanswerable. A job has one or the other, never both.
--
-- division_code references org_units.code ('GH-DB', 'GH-EL', …). Until now the
-- division was glued onto the end of the job's TITLE as text —
-- "Kitchen remodel [GH Design|Build]" — which cannot be grouped, filtered or
-- costed against. This makes it a real field.
--
-- Deliberately NOT added here: inter-division work orders (J-10001-EL). The
-- numbering convention is reserved so nothing has to be renumbered later, but
-- the work-order layer itself is a separate build.

alter table public.jobs add column if not exists project_seq integer;
alter table public.jobs add column if not exists division_code text;
alter table public.jobs add column if not exists source_estimate_id uuid;

comment on column public.jobs.project_seq is
  'HiveLogic project number (the 10001 in J-10001), shared with the estimate it came from. Null for jobs synced from Jobber — those use job_number instead.';
comment on column public.jobs.division_code is
  'org_units.code of the division that owns this job, e.g. GH-DB. Replaces the old habit of appending the division name to the title.';
comment on column public.jobs.source_estimate_id is
  'The estimate this job was converted from, if any. Makes the estimate->job link navigable in both directions.';

-- A project sequence must identify exactly one job per company. This is the
-- constraint that makes converting the same estimate twice fail loudly at the
-- database rather than quietly producing a duplicate job.
create unique index if not exists uq_jobs_project_seq
  on public.jobs (company_id, project_seq)
  where project_seq is not null;

create index if not exists idx_jobs_division_code
  on public.jobs (division_code)
  where division_code is not null;

create index if not exists idx_jobs_source_estimate
  on public.jobs (source_estimate_id)
  where source_estimate_id is not null;

-- jobs_enriched lists its columns explicitly rather than selecting j.*, so a new
-- column on jobs is invisible to every read that goes through the view — which
-- is all of them, including /api/jobs. Recreated here with project_seq and
-- division_code added and nothing else changed.
create or replace view public.jobs_enriched with (security_invoker='true') as
 select j.jobber_id,
    j.client_id,
    j.job_number,
    j.project_seq,
    j.division_code,
    j.title,
    j.job_status,
    j.job_type,
    j.total,
    j.start_at,
    j.end_at,
    j.completed_at,
    j.jobber_web_uri,
    j.jobber_created_at,
    j.jobber_updated_at,
    j.synced_at,
    coalesce(nullif(c.name, ''::text), nullif(trim(both from concat_ws(' '::text, c.first_name, c.last_name)), ''::text), nullif(c.company_name, ''::text)) as client_name,
    cl.lat as gps_lat,
    cl.lng as gps_lng,
    cl.city as loc_city,
    cl.province as loc_province
   from ((public.jobs j
     left join public.clients c on ((c.jobber_id = j.client_id)))
     left join public.client_locations cl on (((cl.jobber_id = j.client_id) and (cl.lat is not null))));

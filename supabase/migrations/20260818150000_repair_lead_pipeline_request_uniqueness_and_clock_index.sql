-- Repair two index definitions introduced by the August 18 lead and crew work.
--
-- PostgREST emits ON CONFLICT (request_id) for `on_conflict=request_id`.
-- PostgreSQL cannot infer the prior partial unique index without its predicate,
-- so overlapping syncs could fail instead of ignoring the duplicate request.
-- An ordinary UNIQUE constraint still permits multiple NULL request_id values
-- (PostgreSQL treats NULLs as distinct by default) while giving PostgREST an
-- inferable conflict target.
--
-- The crew migration also duplicated the existing open-clock partial index.
-- Keep the original hl_clock_emp_open_idx and remove only the duplicate.

begin;

do $migration$
begin
  -- Make an accidental replay harmless. Once the constraint exists, its
  -- backing index has this same name and must not be dropped independently.
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.lead_pipeline'::regclass
      and conname = 'lead_pipeline_request_id_key'
      and contype = 'u'
  ) then
    drop index if exists public.lead_pipeline_request_id_key;

    alter table public.lead_pipeline
      add constraint lead_pipeline_request_id_key unique (request_id);
  end if;
end
$migration$;

drop index if exists public.hl_clock_open_idx;

commit;

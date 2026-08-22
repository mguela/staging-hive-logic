-- Live migration version 20260818001232. Serialize double taps, enforce one open row per person, and scope a field
-- "stop job" action to the visit being stopped. This is a forward correction
-- to the already-applied 20260818000148 atomic RPC migration.

begin;

do $preflight$
begin
  if exists (
    select 1 from public.hl_clock where clock_out is null
    group by employee_jid having count(*) > 1
  ) then
    raise exception 'Cannot enforce one open hl_clock row: duplicate open employees exist.';
  end if;
  if exists (
    select 1 from public.job_time_entries where ended_at is null
    group by tech_id having count(*) > 1
  ) then
    raise exception 'Cannot enforce one open job_time_entries row: duplicate open techs exist.';
  end if;
end
$preflight$;

-- Preserve the established index name while strengthening it to the payroll
-- invariant. The second index covers the field activity table's same rule.
drop index if exists public.hl_clock_emp_open_idx;
create unique index hl_clock_emp_open_idx
  on public.hl_clock (employee_jid)
  where clock_out is null;

create unique index if not exists job_time_entries_one_open_per_tech_idx
  on public.job_time_entries (tech_id)
  where ended_at is null;

create or replace function public.hl_clock_crew_in(p_rows jsonb)
returns setof public.hl_clock
language plpgsql
set search_path = ''
as $$
declare
  v_clock_at timestamptz;
  v_employee text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'At least one crew clock row is required.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as item
    where nullif(btrim(item->>'employee_jid'), '') is null
  ) then
    raise exception 'Every crew clock row requires employee_jid.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as item
    group by item->>'employee_jid' having count(*) > 1
  ) then
    raise exception 'A crew member may appear only once in a group clock action.';
  end if;

  -- Every caller locks the same identities in the same order. Concurrent taps
  -- therefore serialize; the later committed action replaces the earlier one.
  for v_employee in
    select distinct item->>'employee_jid'
    from jsonb_array_elements(p_rows) as item
    order by 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('hl-clock:' || v_employee, 0)
    );
  end loop;

  select coalesce(min(row_data.clock_in), clock_timestamp()) into v_clock_at
  from jsonb_to_recordset(p_rows) as row_data(clock_in timestamptz);

  update public.hl_clock as existing
     set clock_out = v_clock_at
   where existing.clock_out is null
     and existing.employee_jid in (
       select item->>'employee_jid' from jsonb_array_elements(p_rows) as item
     );

  return query
  insert into public.hl_clock (
    employee_jid, target_kind, target_id, label, clock_in, created_by,
    source, chained_to, lat, lng, proximity_m, proximity_flag
  )
  select row_data.employee_jid,
    coalesce(nullif(row_data.target_kind, ''), 'jobber_visit'),
    row_data.target_id, row_data.label, coalesce(row_data.clock_in, v_clock_at),
    row_data.created_by,
    case when row_data.source = 'field' then 'field' else 'board' end,
    row_data.chained_to, row_data.lat, row_data.lng, row_data.proximity_m,
    coalesce(row_data.proximity_flag, false)
  from jsonb_to_recordset(p_rows) as row_data(
    employee_jid text, target_kind text, target_id text, label text,
    clock_in timestamptz, created_by text, source text, chained_to text,
    lat numeric, lng numeric, proximity_m numeric, proximity_flag boolean
  )
  returning *;
end;
$$;

create or replace function public.hl_field_time_start(
  p_entry jsonb,
  p_crew_rows jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_tech_id uuid;
  v_entry public.job_time_entries%rowtype;
  v_clock jsonb := '[]'::jsonb;
begin
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'A field time entry is required.';
  end if;
  if p_crew_rows is null or jsonb_typeof(p_crew_rows) <> 'array' then
    raise exception 'Crew rows must be a JSON array.';
  end if;
  begin
    v_tech_id := (p_entry->>'tech_id')::uuid;
  exception when others then
    raise exception 'A valid tech_id is required.';
  end;
  if p_entry->>'kind' not in ('travel', 'supplies', 'onsite', 'lunch', 'break') then
    raise exception 'Unknown time kind.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hl-job-time:' || v_tech_id::text, 0)
  );

  update public.job_time_entries set ended_at = v_now
   where tech_id = v_tech_id and ended_at is null;
  insert into public.job_time_entries (
    tech_id, tech_name, job_ref, visit_ref, client_ref, kind,
    whole_team, started_at, note
  ) values (
    v_tech_id, nullif(p_entry->>'tech_name', ''),
    nullif(p_entry->>'job_ref', ''), nullif(p_entry->>'visit_ref', ''),
    nullif(p_entry->>'client_ref', ''), p_entry->>'kind',
    coalesce((p_entry->>'whole_team')::boolean, false), v_now,
    nullif(p_entry->>'note', '')
  ) returning * into v_entry;
  if jsonb_array_length(p_crew_rows) > 0 then
    select coalesce(jsonb_agg(to_jsonb(clock_row)), '[]'::jsonb) into v_clock
    from public.hl_clock_crew_in(p_crew_rows) as clock_row;
  end if;
  return jsonb_build_object('entry', to_jsonb(v_entry), 'clock', v_clock);
end;
$$;

revoke all on function public.hl_field_time_stop(uuid, jsonb)
  from public, anon, authenticated, service_role;
drop function public.hl_field_time_stop(uuid, jsonb);

create function public.hl_field_time_stop(
  p_tech_id uuid,
  p_crew_jids jsonb default '[]'::jsonb,
  p_target_id text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_closed integer := 0;
  v_crew_changed integer := 0;
  v_employee text;
begin
  if p_tech_id is null then raise exception 'A valid tech_id is required.'; end if;
  if p_crew_jids is null or jsonb_typeof(p_crew_jids) <> 'array' then
    raise exception 'Crew ids must be a JSON array.';
  end if;
  if jsonb_array_length(p_crew_jids) > 0 and nullif(btrim(p_target_id), '') is null then
    raise exception 'A target visit is required for whole-crew clock-out.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hl-job-time:' || p_tech_id::text, 0)
  );
  for v_employee in
    select distinct jsonb_array_elements_text(p_crew_jids) order by 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('hl-clock:' || v_employee, 0)
    );
  end loop;

  update public.job_time_entries set ended_at = v_now
   where tech_id = p_tech_id and ended_at is null;
  get diagnostics v_closed = row_count;
  if jsonb_array_length(p_crew_jids) > 0 then
    update public.hl_clock as clock_row set clock_out = v_now
     where clock_row.clock_out is null
       and clock_row.target_kind = 'jobber_visit'
       and clock_row.target_id = p_target_id
       and clock_row.employee_jid in (
         select distinct jsonb_array_elements_text(p_crew_jids)
       );
    get diagnostics v_crew_changed = row_count;
  end if;
  return jsonb_build_object('closed', v_closed, 'crew_changed', v_crew_changed);
end;
$$;

revoke all on function public.hl_clock_crew_in(jsonb) from public, anon, authenticated;
revoke all on function public.hl_field_time_start(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.hl_field_time_stop(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.hl_clock_crew_in(jsonb) to service_role;
grant execute on function public.hl_field_time_start(jsonb, jsonb) to service_role;
grant execute on function public.hl_field_time_stop(uuid, jsonb, text) to service_role;

comment on index public.hl_clock_emp_open_idx is
  'Payroll invariant: one open hl_clock session per employee.';
comment on index public.job_time_entries_one_open_per_tech_idx is
  'Field activity invariant: one open job_time_entries row per profile.';
comment on function public.hl_field_time_stop(uuid, jsonb, text) is
  'Service-only atomic field stop; crew rows are closed only for the named visit.';

commit;

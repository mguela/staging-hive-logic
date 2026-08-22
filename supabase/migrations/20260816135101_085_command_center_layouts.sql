-- 085_command_center_layouts.sql
-- Command Center: per-user saved widget layouts ("Custom Layout 1", ...).
--
-- NOT APPLIED. Ships in the PR for Chris's sign-off; apply after review.
--
-- Numbering: highest in the repo's sql/ tree is 084_company_plan_fields.sql;
-- production (`list_migrations` on sqhusuuhlmcmkeowdrga, 2026-08-16) tops out
-- at 20260816122034 boardroom_variable_audit_persistence, whose highest
-- NUMBERED entry is 080_employee_pay_gusto_link. Nothing numbered 085 exists
-- in either place, so 085 is free. (043 is permanently off-limits per the
-- migration ledger; not a factor at 085.)
--
-- Until this is applied, the Command Center degrades to localStorage-only
-- layout persistence (its behavior before this change) -- the client treats a
-- failing/absent cc_layouts endpoint as "no saved layouts", it does not error.
--
-- Templates are NOT rows. They live in code as JS constants
-- (CC_LAYOUT_TEMPLATES in public/index.html) and are read-only presets;
-- only a user's own customs are stored here.

create table if not exists public.command_center_layouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  -- { widgets: [{ id, x, y, w, h, hidden }], background: <null|string>, brand_image: <null|string> }
  layout jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.command_center_layouts is
  'Per-user saved Command Center widget layouts. Type "custom" only -- the default templates are code constants, never rows.';

create index if not exists command_center_layouts_user_idx
  on public.command_center_layouts (user_id);

-- One active layout per user. Partial unique index rather than a trigger: the
-- API already clears the previous active row in the same request, this is the
-- backstop if two tabs race.
create unique index if not exists command_center_layouts_one_active_per_user
  on public.command_center_layouts (user_id)
  where is_active;

-- Guard the invariant that the Command Center's "Today's Decisions" widget
-- (gs-id cc-brief) can be moved and resized but NEVER removed from a layout.
-- The API validates this too; this is the layer that survives a crafted
-- payload sent straight at PostgREST.
create or replace function public.command_center_layout_has_decisions(l jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(l -> 'widgets', '[]'::jsonb)) as w
    where w ->> 'id' = 'cc-brief'
      and coalesce((w ->> 'hidden')::boolean, false) = false
  );
$$;

revoke all on function public.command_center_layout_has_decisions(jsonb) from anon;

alter table public.command_center_layouts
  drop constraint if exists command_center_layouts_decisions_required;
alter table public.command_center_layouts
  add constraint command_center_layouts_decisions_required
  check (public.command_center_layout_has_decisions(layout));

-- updated_at maintenance
create or replace function public.command_center_layouts_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.command_center_layouts_touch() from anon;

drop trigger if exists command_center_layouts_touch on public.command_center_layouts;
create trigger command_center_layouts_touch
  before update on public.command_center_layouts
  for each row execute function public.command_center_layouts_touch();

-- RLS: a user reads and writes only their own rows. The app reaches this table
-- through api/track1.js with the service key (which bypasses RLS and scopes by
-- user_id itself, the repo's established pattern) -- these policies are what
-- protects the table from a direct PostgREST call with a user's own anon-key
-- session.
alter table public.command_center_layouts enable row level security;

drop policy if exists command_center_layouts_select_own on public.command_center_layouts;
create policy command_center_layouts_select_own
  on public.command_center_layouts for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists command_center_layouts_insert_own on public.command_center_layouts;
create policy command_center_layouts_insert_own
  on public.command_center_layouts for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists command_center_layouts_update_own on public.command_center_layouts;
create policy command_center_layouts_update_own
  on public.command_center_layouts for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists command_center_layouts_delete_own on public.command_center_layouts;
create policy command_center_layouts_delete_own
  on public.command_center_layouts for delete
  to authenticated
  using (user_id = auth.uid());

revoke all on public.command_center_layouts from anon;
grant select, insert, update, delete on public.command_center_layouts to authenticated;

-- No views are added by this migration, so there is nothing here needing
-- security_invoker=on; the repo standard is noted so a later view on this
-- table doesn't miss it.

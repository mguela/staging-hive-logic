-- sql/066_permission_roles_v2.sql
--
-- Stage 2 of the permission-system redesign (jomell + Chris's plan): replaces
-- the old, mostly-decorative 11-value employee_roles.permission_roles
-- taxonomy with the 9 real job-function roles that now actually gate data:
--   owner, project_manager, dispatch, office_ar, purchasing, admin_remote,
--   field_lead, field_tech, sales
--
-- Old -> new mapping for any real data already assigned:
--   owner, partner, office_manager, systems_pm  -> owner
--     (all four were already treated as identical "full access" everywhere
--     in code -- collapsing them to owner PRESERVES access rather than
--     guessing which of the new, more specific roles someone should drop
--     into. Chris/jomell should review these people afterward via the
--     roster UI and move them to a more specific role if one fits better.)
--   project_manager -> project_manager (unchanged)
--   dispatch         -> dispatch (unchanged)
--   accounting       -> office_ar
--   design_sales     -> sales
--   marketing        -> unassigned (no equivalent in the new 9 -- was never
--                       enforced by any real permission check either, see
--                       sql/MIGRATION_LEDGER.md discussion in this session)
--   field_crew       -> field_tech
--   subcontractor    -> unassigned (no equivalent in the new 9; also never
--                       enforced by any real check before this)
--
-- "Unassigned" here means removed from the array, not defaulted to anything
-- permissive -- the matching index.html change in this same deploy makes
-- an unassigned person see NOTHING beyond Command Center/Schedule/HiveConnect
-- (fail CLOSED) instead of the old fail-OPEN "show everything" default.

update public.employee_roles
set permission_roles = (
  select array_agg(distinct mapped) filter (where mapped is not null)
  from unnest(permission_roles) as old_role
  cross join lateral (
    select case old_role
      when 'owner' then 'owner'
      when 'partner' then 'owner'
      when 'office_manager' then 'owner'
      when 'systems_pm' then 'owner'
      when 'project_manager' then 'project_manager'
      when 'dispatch' then 'dispatch'
      when 'accounting' then 'office_ar'
      when 'design_sales' then 'sales'
      when 'field_crew' then 'field_tech'
      else null
    end as mapped
  ) m
)
where permission_roles is not null and array_length(permission_roles, 1) > 0;

-- Keep the legacy single-value column (permission_role) in sync the same way
-- the app's own write path already does (first entry of permission_roles).
update public.employee_roles
set permission_role = permission_roles[1]
where permission_roles is not null and array_length(permission_roles, 1) > 0;

update public.employee_roles
set permission_role = null
where permission_roles is null or array_length(permission_roles, 1) = 0;

alter table public.employee_roles drop constraint if exists employee_roles_permission_role_check;
alter table public.employee_roles add constraint employee_roles_permission_role_check
  check (permission_role = any (array[
    'owner', 'project_manager', 'dispatch', 'office_ar', 'purchasing',
    'admin_remote', 'field_lead', 'field_tech', 'sales'
  ]));

alter table public.employee_roles drop constraint if exists employee_roles_permission_roles_check;
alter table public.employee_roles add constraint employee_roles_permission_roles_check
  check (permission_roles <@ array[
    'owner', 'project_manager', 'dispatch', 'office_ar', 'purchasing',
    'admin_remote', 'field_lead', 'field_tech', 'sales'
  ]);

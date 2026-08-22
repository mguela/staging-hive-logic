-- Stage 2 of the permission-system redesign: replaces the old 11-value
-- employee_roles taxonomy with the 9 real job-function roles that gate data:
-- owner, project_manager, dispatch, office_ar, purchasing, admin_remote,
-- field_lead, field_tech, sales.
--
-- hl:replay-unsafe: one-way remap whose CASE only knows the OLD names. Applying
-- it twice maps the new names it produced to null and strips those employees'
-- permissions. It must be applied deliberately, once, by a human -- never by the
-- deploy workflow. The replay-safety gate refuses it for exactly this reason.
--
-- THIS HAS NOT BEEN APPLIED TO PRODUCTION. An earlier version of this header
-- claimed the opposite -- that the file merely recorded state already live and
-- changed nothing. That was wrong, and PR #198 was built on it. Verified on
-- 2026-08-21 (project sqhusuuhlmcmkeowdrga):
--
--   * employee_roles still carries the OLD 11-value check constraints
--   * every role value in every live row is an OLD name -- 11x field_crew,
--     4x design_sales, 2x each accounting/dispatch/marketing/owner/
--     subcontractor, 1x each office_manager/partner/project_manager/systems_pm
--   * zero rows hold any NEW name
--
-- The consequence is a live split brain, because api/track1.js already
-- validates writes against the NEW nine:
--
--   * 6 of the 9 roles the app offers (office_ar, purchasing, admin_remote,
--     field_lead, field_tech, sales) violate the DB constraint, so they cannot
--     be assigned at all -- only owner/project_manager/dispatch overlap
--   * gates that ask for 'office_ar' (financial data in track1.js, the sub and
--     client portals) match nobody, because those staff still hold 'accounting'
--
-- api/track1.js:1804 already documents hitting the other half of this, working
-- around live rows holding 'field_crew' and 'subcontractor'.
--
-- Applying this migration is what closes that gap. Doing so is not free:
-- marketing (2 rows) and subcontractor (2 rows) map to null by design and lose
-- their granular roles. The sub/contractor distinction survives elsewhere --
-- employee_roles.lens='sub' and invites.actor_type -- and no gate reads
-- 'subcontractor' as a permission role, so that half is inert. The marketing
-- drop is a real decision and needs a human to make it.
--
-- Old -> new: owner/partner/office_manager/systems_pm -> owner; accounting ->
-- office_ar; design_sales -> sales; field_crew -> field_tech; project_manager
-- and dispatch map to themselves; marketing/subcontractor -> unassigned.

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

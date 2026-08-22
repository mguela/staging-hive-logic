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
-- APPLIED TO PRODUCTION 2026-08-21, by hand, on Chris's explicit go-ahead --
-- and only after THREE bugs were corrected, each of which aborted it outright.
-- The corrections are inline below, marked "FIX". Ledger: 20260810220215.
--
-- Until that day this file had never run anywhere. It could not: every one of
-- those three bugs fires on the first statement against real rows. An earlier
-- header claimed the file merely recorded state already live and changed
-- nothing; that was wrong, and PR #198 was built on it. State before applying,
-- verified on 2026-08-21 (project sqhusuuhlmcmkeowdrga):
--
--   * employee_roles still carried the OLD 11-value check constraints
--   * every role value in every live row was an OLD name -- 11x field_crew,
--     4x design_sales, 2x each accounting/dispatch/marketing/owner/
--     subcontractor, 1x each office_manager/partner/project_manager/systems_pm
--   * zero rows held any NEW name
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

-- FIX 1 of 3: the constraint swap has to come FIRST. The original left it to
-- the end, so the old 11-value check rejected 'field_tech' and the migration
-- aborted on its very first UPDATE:
--   23514 ... violates check constraint "employee_roles_permission_roles_check"
alter table public.employee_roles drop constraint if exists employee_roles_permission_role_check;
alter table public.employee_roles drop constraint if exists employee_roles_permission_roles_check;

update public.employee_roles
set permission_roles = coalesce((
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
-- FIX 2 of 3: marketing and subcontractor map to nothing, and permission_roles
-- is NOT NULL. array_agg(...) filter(...) yields NULL when every element maps to
-- null, so the original failed on exactly those rows:
--   23502 null value in column "permission_roles" violates not-null constraint
-- "No roles" has to be an empty array.
), array[]::text[])
where permission_roles is not null and array_length(permission_roles, 1) > 0;

-- FIX 3 of 3: array_length('{}', 1) is NULL, not 0. The original's tests below
-- therefore never matched a row this migration had just emptied -- it would
-- have left them holding a stale 'marketing' scalar, which then fails the new
-- scalar check added at the bottom. Both tests are now null-safe.
update public.employee_roles
set permission_role = permission_roles[1]
where coalesce(array_length(permission_roles, 1), 0) > 0;

update public.employee_roles
set permission_role = null
where permission_roles is null or coalesce(array_length(permission_roles, 1), 0) = 0;

alter table public.employee_roles add constraint employee_roles_permission_role_check
  check (permission_role = any (array[
    'owner', 'project_manager', 'dispatch', 'office_ar', 'purchasing',
    'admin_remote', 'field_lead', 'field_tech', 'sales'
  ]));

alter table public.employee_roles add constraint employee_roles_permission_roles_check
  check (permission_roles <@ array[
    'owner', 'project_manager', 'dispatch', 'office_ar', 'purchasing',
    'admin_remote', 'field_lead', 'field_tech', 'sales'
  ]);

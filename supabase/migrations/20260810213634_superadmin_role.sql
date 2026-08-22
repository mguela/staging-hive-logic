-- Reconciled into the canonical migration history from sql/065_superadmin_role.sql
-- (applied to production 2026-08-10, never mirrored into supabase/migrations/).
-- Captures existing production state; does not change the database. Verified
-- against the 2026-08-02 remote baseline (which has profiles_role_check as
-- admin/crew only) and live api/ code that gates on the 'superadmin' role.
--
-- Adds "superadmin" as a third value on profiles.role (previously admin/crew
-- only) -- the account-tier system jomell + Chris designed:
--   superadmin: add/remove a team member, change anyone's role, reset anyone's
--     password. admin: reset a crew-level password only. crew: own password only.
-- 'admin' keeps every permission it already had; every api/ check on
-- role === 'admin' was widened to also accept 'superadmin'.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('superadmin', 'admin', 'crew'));

-- The two initial superadmins (harmless no-op on a fresh rebuild with no rows).
update public.profiles set role = 'superadmin' where email in ('jomell@ghgrp.net', 'chris@ghgrp.net');

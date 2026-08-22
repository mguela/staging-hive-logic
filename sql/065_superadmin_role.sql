-- sql/065_superadmin_role.sql
--
-- Adds "superadmin" as a third value on profiles.role (previously admin/crew
-- only) -- the new account-tier system jomell + Chris designed:
--   superadmin: add/remove a team member, change anyone's role, reset
--     anyone's password (never "view" a password -- Supabase Auth hashes
--     them irreversibly, nobody can ever see an existing one, only set a
--     new one)
--   admin: can reset a password for a crew-level account only -- never for
--     another admin or a superadmin
--   crew: can only change their own password (via Supabase Auth directly,
--     no new column needed for that)
--
-- 'admin' keeps every permission it already had -- every place in api/ that
-- checked `role === 'admin'` was widened to also accept 'superadmin', so
-- promoting jomell/Chris here doesn't remove anything they could already do.
--
-- Run this, then promote the two initial superadmins:
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('superadmin', 'admin', 'crew'));

update public.profiles set role = 'superadmin' where email in ('jomell@ghgrp.net', 'chris@ghgrp.net');

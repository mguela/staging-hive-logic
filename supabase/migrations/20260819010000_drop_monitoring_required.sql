-- supabase/migrations/20260819010000_drop_monitoring_required.sql
--
-- Drops profiles.monitoring_required, which has been dead since
-- 20260818190000_monitoring_one_permission.sql.
--
-- WHY IT WAS KEPT FOR A DAY. A deploy is not instantaneous. For a few minutes
-- the previous build is still serving, and dropping a column out from under a
-- running server turns a cleanup into an outage. So that migration stopped the
-- code reading it and left the column in place; this one removes it, now that
-- every deployed build is past that point.
--
-- WHY IT WENT. It let an admin say "monitored, but declining is fine", and that
-- combination -- clocked in, monitored, declined -- is a state nothing
-- downstream could cope with. Declining records no activity samples; no samples
-- means the server cannot compute a machine-wide idle reading; and the browser
-- then falls back to watching input in a single tab, which cannot see someone
-- working in Outlook. Chris's own account sat in that configuration and was
-- clocked out three times while he was working:
--
--   2026-08-18 10:58:23 -> 11:44:28   46 min   0 activity samples   idle_timeout
--   2026-08-17 18:30:52 -> 19:23:58
--   2026-08-17 10:32:45 -> 13:28:26
--
-- 46 minutes is the 30-minute warning plus the 15-minute grace, to the minute.
--
-- Monitoring is one permission now: monitoring_enabled on = recorded while
-- clocked in AND approval is a condition of being on the clock; off = not
-- monitored, and the idle timeout does not apply. The exempt case is "not
-- monitored", not "monitored but may refuse". Owners are handled separately
-- again, by the 'owner' permission role, which takes them off the timeclock
-- entirely.
--
-- WHAT IS BEING DISCARDED, stated rather than waved past: 12 profile rows, of
-- which exactly ONE held a value other than the default -- chris@ghgrp.net,
-- false, the exemption that caused the clock-outs above. No policy, view,
-- index, constraint or trigger referenced the column; checked before running
-- rather than assumed.
--
-- Rollback: re-add the column with `alter table public.profiles add column
-- monitoring_required boolean not null default true`. The per-row values are
-- NOT recoverable, and the only one that differed is recorded above. Nothing
-- reads it either way, so a rollback restores the shape and not a behaviour.

begin;

alter table public.profiles
  drop column if exists monitoring_required;

commit;

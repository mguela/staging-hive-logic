-- supabase/migrations/20260817220000_monitor_agents_agent_version.sql
--
-- monitor_agents.agent_version stops being a fossil and starts being a fact.
--
-- THE COLUMN ALREADY EXISTED (sql/050_monitor_tables.sql), and the agent
-- already sent its version -- ONCE, at pairing, in handleMonitorPair. Nothing
-- ever wrote it again. So the value was not "which build is this machine
-- running"; it was "which build was installed the day this device was first
-- paired", and it aged into a lie without anything marking the transition.
--
-- Found by querying production while building the very feature meant to add
-- this: Chris's agent read agent_version = '1.0.0' with a heartbeat 34 seconds
-- old, on a device paired 2026-07-25 that has auto-updated repeatedly since.
-- Reading that column would have said "Fractal is on 1.0.0" and been wrong by
-- several releases. A number that looks like a live report and is not is worse
-- than an empty column, which is the same failure as a build marker that can
-- silently go stale (api/_lib/page-build.js) and a monitor agent whose 'active'
-- status meant only "was paired once".
--
-- The heartbeat now carries app.getVersion() and writes it whenever it differs
-- from what is stored -- on the PATCH that already updates last_seen_at, so it
-- costs nothing. Every running agent corrects its own row within 60 seconds of
-- the deploy, so no data fix is needed here and none is done: overwriting the
-- stale values by hand would just be guessing at what they should say.
--
-- After this, "who is still on an old agent" is a query rather than a hope:
--
--   select p.email, a.device_name, a.agent_version, a.last_seen_at
--     from monitor_agents a
--     join profiles p on p.id = a.employee_id
--    where a.status = 'active'
--      and a.agent_version is distinct from '1.2.4'
--    order by a.last_seen_at desc;
--
-- which matters because the agent updates from a hand-made release on its own
-- schedule: a server-side rule can be live while the agent-side half of the
-- same change has reached nobody. That is exactly what the 2026-08-17 consent
-- change did.
--
-- NULL still means "has not reported" -- an agent old enough that it never sent
-- one even at pairing. That is unknown, not stale, and health-cron names the
-- two separately.
--
-- Rollback: nothing to undo -- this only restates what the column means.

begin;

alter table public.monitor_agents
  add column if not exists agent_version text;

comment on column public.monitor_agents.agent_version is
  'Version the desktop agent reported on its LAST HEARTBEAT (app.getVersion(), mirroring hivelogic-monitor-agent/package.json). Until 2026-08-17 this was written only once at pairing and then aged into a lie -- Chris''s row read 1.0.0 for a device several releases newer. NULL = never reported, which is unknown rather than stale.';

commit;

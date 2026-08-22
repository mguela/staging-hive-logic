-- supabase/migrations/20260817200000_profiles_monitoring_required.sql
--
-- Make agreeing to monitoring a condition of being on the clock, per person.
--
-- Chris, 2026-08-17: "only when an employee is clocked in should it monitor. if
-- an employee is clocked in they must approve monitoring or it can't clock in.
-- this also needs to be set in permissions as you setup the user."
--
-- Until now the desktop agent's consent dialog offered "Not this time", and
-- declining stopped the screenshots and nothing else -- activity samples kept
-- recording, because handleMonitorHeartbeat wrote them before it looked at
-- consent. Chris's own 2026-08-17 06:33 session was declined and still logged
-- 176 samples across three hours. Declining now genuinely stops all recording,
-- and for anyone this column marks as required it also ends the clock-in.
--
-- DEFAULT TRUE, INCLUDING FOR EVERY EXISTING ACCOUNT. That is the rule Chris
-- stated, so it is the rule that ships, rather than a quieter default that
-- would leave the policy true only for people added later. It takes effect on
-- the next clock-in, and it is per-user: anyone who should be able to work
-- unmonitored is exempted by setting this to false (Monitor Settings, the
-- Required column). Note it applies to the Owner too -- declining the prompt
-- will clock Chris out like anyone else until he exempts himself.
--
-- Composes with the existing monitoring_enabled off-switch, which still wins:
--
--   monitoring_enabled = false                        -> never monitored, never
--                                                        prompted, clock-in
--                                                        unaffected
--   enabled = true,  monitoring_required = true       -> prompted; declining
--                                                        clocks them out
--   enabled = true,  monitoring_required = false      -> prompted; declining is
--                                                        honoured and they stay
--                                                        clocked in, unmonitored
--
-- Rollback:
--   alter table public.profiles drop column monitoring_required;

begin;

alter table public.profiles
  add column if not exists monitoring_required boolean not null default true;

comment on column public.profiles.monitoring_required is
  'When true (default), declining the monitor consent prompt ends the clock-in (close_reason monitoring_declined). When false, declining is honoured and the person stays clocked in with nothing recorded. Ignored entirely when monitoring_enabled is false.';

commit;

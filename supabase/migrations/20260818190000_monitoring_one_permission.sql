-- supabase/migrations/20260818190000_monitoring_one_permission.sql
--
-- Two monitoring permissions collapse into one, because the state the second
-- one made reachable is a state nothing downstream can cope with.
--
-- WHAT HAPPENED. monitoring_required let an admin say "monitored, but declining
-- is fine". Chris's own account sat in exactly that configuration, and on
-- 2026-08-18 three of his sessions closed with close_reason 'idle_timeout'
-- while he was working:
--
--   10:58:42 -> 11:44:28   46 min   0 activity samples   idle_timeout
--
-- 46 minutes is the 30-minute warning plus the 15-minute grace, to the minute.
-- The chain: declined consent means no activity samples are written; no samples
-- means the server cannot compute deskIdleSeconds; no deskIdleSeconds means the
-- browser falls back to watching input in one tab; and someone working in
-- Outlook and a terminal looks perfectly idle to a tab. That is the ORIGINAL
-- bug (PR #312) coming back through a door the consent feature opened.
--
-- THE RULE NOW, from Chris on 2026-08-18: "monitoring should only work when
-- clocked in, you can't clock in without approving monitoring ... every other
-- user is monitored by default but the owner can change permissions and
-- unselect monitoring if they choose to."
--
-- So: monitoring_enabled is the only permission. On means recorded while
-- clocked in AND agreeing is a condition of being on the clock. Off means not
-- monitored at all -- no prompt, no recording, and no idle timeout, because
-- with nothing watching the machine there is no honest basis for one.
--
-- THE COLUMN IS NOT DROPPED HERE, deliberately. A deploy is not instantaneous:
-- for a few minutes the previous build is still reading this column, and
-- dropping it out from under a running server turns a cleanup into an outage.
-- It stops being read as of this release; dropping it is a later migration,
-- once nothing in production refers to it.
--
-- Rollback: nothing to undo. No data is changed and no column is removed.

begin;

comment on column public.profiles.monitoring_required is
  'DEPRECATED 2026-08-18, no longer read by any code. Monitoring is one permission now: monitoring_enabled on = recorded while clocked in AND approval required to stay clocked in; off = not monitored, and the idle timeout does not apply. The old "monitored but may decline" state produced sessions with consent denied, therefore zero activity samples, therefore no machine-wide idle witness, therefore false idle_timeout clock-outs (Chris, three sessions on 2026-08-18). Safe to drop once no deployed build reads it.';

commit;

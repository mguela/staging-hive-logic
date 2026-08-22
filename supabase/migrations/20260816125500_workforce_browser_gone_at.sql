-- sql/085_workforce_browser_gone_at.sql
--
-- Grace window for the browser-close auto-clockout (Chris, 2026-08-16).
--
-- Background. The "close the browser and it clocks you out" safety net has
-- been dead since 2026-08-01: it posts via navigator.sendBeacon, which cannot
-- set an Authorization header, and middleware.js only reads that header -- so
-- every beacon 401'd at the edge. Evidence in production: close_reason
-- 'browser_closed' stops dead at 2026-08-01 16:34, while 'idle_timeout' (the
-- same endpoint, reached by an ordinary authenticated fetch) still fires
-- today.
--
-- Why a column instead of just unblocking it. `pagehide` fires on a REFRESH
-- as well as a close, and the browser cannot tell you which one it is. Simply
-- unblocking the endpoint would start clocking people out every time they hit
-- refresh -- worse than the bug. So the beacon now only marks the moment the
-- page went away; a sweep clocks the session out afterwards, backdated to that
-- moment, and only if nothing has come back in the meantime. A refresh
-- reappears within seconds and clears the mark, so it never costs anyone time;
-- a genuine close still produces an accurate clock-out time rather than one
-- rounded up to whenever a sweep noticed.
--
-- Additive and reversible: one nullable column. Rollback is
--   alter table public.workforce_time_sessions drop column browser_gone_at;
-- Existing rows are unaffected (null = "the browser is not known to be gone").

begin;

alter table public.workforce_time_sessions
  add column if not exists browser_gone_at timestamptz;

comment on column public.workforce_time_sessions.browser_gone_at is
  'When the browser last reported the page going away (pagehide beacon) for a still-active session. Cleared as soon as the person is seen again. The workforce_sweep_gone cron clocks the session out backdated to this value once the grace window passes. Null = not known to be gone.';

-- The sweep looks up exactly this: active sessions with a mark set. Tiny
-- partial index so it stays cheap no matter how large the table gets.
create index if not exists workforce_time_sessions_browser_gone_idx
  on public.workforce_time_sessions (browser_gone_at)
  where browser_gone_at is not null and status = 'active';

commit;

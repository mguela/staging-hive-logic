-- supabase/migrations/20260827120000_monitor_agents_last_disconnected_at.sql
-- Real-time-ish Online/Offline status (2026-08-27, "can we update that
-- like realtime?"). Before this, "Online" could only ever go stale by
-- timeout -- a clean Quit from the tray menu had no way to tell the
-- server, so it looked identical to the agent just being busy, for up to
-- MONITOR_AGENT_ALIVE_MINUTES (api/track1.js). This is the explicit
-- "I'm going offline" signal that instant path needs.
--
-- Deliberately NOT touching last_seen_at: that column stays the honest
-- record of the last real heartbeat, so "Last Seen" never lies about when
-- that was. isAgentAlive() (api/track1.js) reads both -- alive requires a
-- recent last_seen_at AND (no disconnect marker, or a heartbeat since the
-- disconnect, which happens automatically the moment it reconnects).
alter table monitor_agents
  add column if not exists last_disconnected_at timestamptz null;

comment on column monitor_agents.last_disconnected_at is
  'Set by resource=monitor_going_offline (the tray Quit handler) the moment the agent quits cleanly. NULL means no clean-quit signal is on record. Never advances last_seen_at -- a heartbeat after this timestamp means the agent is back, and isAgentAlive() treats it as alive again automatically.';

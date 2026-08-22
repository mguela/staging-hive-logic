-- supabase/migrations/20260816145500_monitor_agents_active_requires_token_hash.sql
--
-- Make the 2026-08 monitoring outage IMPOSSIBLE rather than merely detectable.
--
-- What happened: an agent row could be status='active' with agent_token_hash
-- NULL. requireMonitorAgent() (api/_lib/monitor.js) looks agents up by
--
--     monitor_agents?agent_token_hash=eq.<sha256>&status=eq.active&limit=1
--
-- so such a row can never match anything. The agent is permanently
-- unauthenticatable, and -- this is the part that cost two weeks -- it fails
-- exactly like a wrong token: a 401, no log line, a tray that says "Heartbeat
-- error". Chris's agent sat in that state from 2026-08-01 to 2026-08-16,
-- sending a correct token every 60 seconds, while three separate auth gates
-- were opened in front of it. None of them could have helped.
--
-- The row got that way because token hashing was introduced without migrating
-- the rows that already existed (they kept the plaintext in agent_token, with
-- the hash column left NULL). Backfilled in
-- 20260816143000_monitor_agents_backfill_token_hash.sql.
--
-- This constraint means the half-shipped version of that change would have
-- failed LOUDLY at write time instead of silently disabling an agent. Two
-- invariants, both true of every row today (verified before adding: 1 active
-- row with a hash and no plaintext; 2 pending rows with neither, which is
-- correct -- a pending agent has not paired yet and has no token):
--
--   1. an ACTIVE agent must have a hash, or it can never authenticate;
--   2. no ACTIVE agent may still carry a plaintext token -- handleMonitorPair
--      already writes agent_token: null, and this stops a regression putting
--      credentials back in the clear.
--
-- Deliberately scoped to status='active'. Pending rows are mid-enrollment and
-- legitimately have neither value; revoked rows are history and must stay
-- readable as-is.
--
-- Rollback: alter table public.monitor_agents drop constraint monitor_agents_active_requires_token_hash;

begin;

alter table public.monitor_agents
  add constraint monitor_agents_active_requires_token_hash
  check (
    status <> 'active'
    or (agent_token_hash is not null and agent_token is null)
  );

comment on constraint monitor_agents_active_requires_token_hash on public.monitor_agents is
  'An active agent must be authenticatable (hash present) and must not hold a plaintext token. Without this, a row can be active but permanently unable to authenticate -- the 2026-08 monitoring outage, which was indistinguishable from a wrong token and went unnoticed for two weeks.';

commit;

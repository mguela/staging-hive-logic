-- supabase/migrations/20260816143000_monitor_agents_backfill_token_hash.sql
--
-- ALREADY APPLIED TO PRODUCTION on 2026-08-16 ~14:30 UTC, to unblock a live
-- outage. Recorded here so the ledger reflects reality and any other
-- environment gets the same repair. Idempotent: the WHERE clause matches
-- nothing on a second run.
--
-- THE BUG. Monitor agents paired before token hashing shipped still hold their
-- credential in the legacy plaintext column `agent_token`, with
-- `agent_token_hash` NULL. requireMonitorAgent() (api/_lib/monitor.js) looks
-- agents up by agent_token_hash ONLY:
--
--     monitor_agents?agent_token_hash=eq.<sha256>&status=eq.active&limit=1
--
-- A NULL hash can never match, so those agents could never authenticate again
-- no matter what else was fixed. Chris's agent (device "Fractal", paired
-- 2026-07-25) was in exactly this state: it had been sending a valid token
-- every 60 seconds and getting refused, its tray reading "Heartbeat error",
-- while three separate auth gates were opened in front of it that day. None of
-- them could have helped -- the lookup was against an empty column.
--
-- Verified BEFORE writing, not after: the sha256 of the stored plaintext
-- equalled the exact hash the live agent was presenting in the edge logs
-- (9cfa0888...). Same token, same machine, right credential, wrong column.
--
-- The backfill also completes the security intent of the hashing change -- the
-- plaintext copy is removed, which is what handleMonitorPair already does for
-- every new pairing.
--
-- Confirmed after applying: the agent authenticated on its very next
-- heartbeat, last_seen_at moved off 2026-08-02 for the first time in two
-- weeks, a monitor session opened, and activity samples began recording.

begin;

update public.monitor_agents
   set agent_token_hash = encode(digest(agent_token, 'sha256'), 'hex'),
       agent_token = null
 where agent_token is not null
   and agent_token_hash is null;

commit;

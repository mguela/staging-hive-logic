-- sql/051_monitor_agent_token_hash.sql
-- Store agent bearer credentials as SHA-256 HASHES, never plaintext.
--
-- Before this change, monitor_agents.agent_token held the raw long-lived
-- bearer token the desktop agent sends on every request, so anyone with read
-- access to the row (a leaked service-key query, a DB backup, a support
-- export) could impersonate the agent. api/track1.js now hashes the presented
-- token (SHA-256, hex) and looks it up against agent_token_hash; the plaintext
-- is never persisted (the legacy agent_token column is left in place but is no
-- longer written -- new pairings set it to NULL).
--
-- BACKWARD-COMPAT / IMPACT: existing rows have agent_token_hash = NULL, so
-- their credentials no longer authenticate. Every currently-paired device must
-- RE-ENROLL once (generate a fresh pairing code in HiveLogic and re-pair);
-- pairing writes agent_token_hash and clears agent_token. This is intentional
-- credential invalidation, not data loss -- no monitor history is affected.
-- After confirming all devices have re-enrolled, the legacy plaintext column
-- may be dropped in a later migration:  alter table monitor_agents drop column agent_token;

alter table monitor_agents
  add column if not exists agent_token_hash text;

-- Fast auth lookup: hashed token among active agents only.
create index if not exists monitor_agents_token_hash_idx
  on monitor_agents (agent_token_hash)
  where status = 'active';

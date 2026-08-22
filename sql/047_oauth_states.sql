-- sql/045_oauth_states.sql
-- Single-use, short-lived OAuth `state` tokens (2026-08-01, Item 5).
-- api/_lib/oauth-state.js issues one row per connect (storing the SHA-256 hash
-- of the state, never the raw value) and consumes it exactly once at the
-- callback via a conditional PATCH on used_at IS NULL. Closes the OAuth CSRF /
-- authorization-code-injection hole where Jobber/QBO used a static state and
-- their callbacks validated nothing.
--
-- Service-role only (RLS enabled, no policies) — same pattern as
-- webhook_events / the other infra tables.

create table if not exists oauth_states (
  id bigint generated always as identity primary key,
  provider text not null,                 -- 'jobber' | 'qbo' | 'msmail'
  state_hash text not null,               -- sha256(raw state), never the raw value
  user_id uuid,                           -- initiating signed-in user, when known
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz                     -- set once, on consume; single-use guard
);

-- Unique per (provider, state_hash): issued states carry a random hash, and
-- msmail's single-use claim relies on a duplicate insert conflicting (409).
create unique index if not exists oauth_states_provider_hash_uidx
  on oauth_states (provider, state_hash);

alter table oauth_states enable row level security;

-- Housekeeping: drop consumed/expired rows. search_path pinned (Item 7).
create or replace function prune_oauth_states()
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from public.oauth_states
   where used_at is not null
      or expires_at < now() - interval '1 day';
$$;

revoke all on function prune_oauth_states() from public;

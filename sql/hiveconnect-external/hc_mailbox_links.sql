-- Run this in the SUPABASE SQL EDITOR FOR THE HIVECONNECT PROJECT
-- (ref mzyngawgpxzpsxphswmc, url https://mzyngawgpxzpsxphswmc.supabase.co)
-- NOT the main HiveLogic project (sqhusuuhlmcmkeowdrga). HiveConnect's
-- Microsoft-mailbox sign-in runs against its own Supabase project, so this
-- table has to live there for auth.uid() to resolve to the right person.
--
-- Fixes: Allan (or anyone else on a shared browser) could see and use
-- Chris's already-connected Microsoft mailbox in HiveConnect, because
-- Microsoft's sign-in library caches connected accounts per-browser, not
-- per-HiveLogic-person. This table records which HiveConnect user actually
-- owns each connected mailbox; app.js filters everything through it.

create table if not exists hc_mailbox_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  ms_home_account_id text not null,
  ms_username text,
  created_at timestamptz not null default now(),
  unique (owner_id, ms_home_account_id)
);

alter table hc_mailbox_links enable row level security;

-- Each person can only ever see, add, or remove their own mailbox links.
create policy "own mailbox links only"
  on hc_mailbox_links
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

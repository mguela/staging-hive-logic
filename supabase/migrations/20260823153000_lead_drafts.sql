-- A half-finished New Lead form, kept until he comes back to it.
--
-- Chris, 2026-08-23: "i inavertently clicked away from the screen and lost my
-- work, that can't happen... it needs a home to save the incomplete form too.
-- and it needs to be easily found when you want to return to it."
--
-- Keyed by owner_id, one row per draft, deletable by the person who wrote it --
-- the reina_notify_rules pattern the standing rule points at. A draft he
-- deliberately saved is a fact about HIM, so it follows him to the laptop and
-- the tablet; localStorage would strand it on the machine he happened to be
-- standing at, which is the failure this rule exists to prevent. (The unsent
-- keystrokes BEFORE he presses save are the sanctioned local exception, and
-- they stay local.)
--
-- payload is the form as typed, not a validated lead: half a phone number and
-- no name at all still has to survive, because that is the state he is in when
-- the phone rings again.
create table if not exists lead_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  label text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_drafts_owner_idx on lead_drafts (owner_id, updated_at desc);

alter table lead_drafts enable row level security;

-- His drafts are his. Nobody else's business, including other staff.
drop policy if exists lead_drafts_own_select on lead_drafts;
create policy lead_drafts_own_select on lead_drafts for select using (auth.uid() = owner_id);
drop policy if exists lead_drafts_own_insert on lead_drafts;
create policy lead_drafts_own_insert on lead_drafts for insert with check (auth.uid() = owner_id);
drop policy if exists lead_drafts_own_update on lead_drafts;
create policy lead_drafts_own_update on lead_drafts for update using (auth.uid() = owner_id);
drop policy if exists lead_drafts_own_delete on lead_drafts;
create policy lead_drafts_own_delete on lead_drafts for delete using (auth.uid() = owner_id);

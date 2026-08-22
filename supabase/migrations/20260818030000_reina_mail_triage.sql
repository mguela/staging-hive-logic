-- 20260818030000_reina_mail_triage.sql
--
-- Reina inbox triage (Chris, 2026-08-17: "what about Reina reading my emails
-- and determining what's needing a response and what needs scheduling and what
-- needs action, flagging junk and learning to get better at managing my inbox
-- each day?").
--
-- Two tables, and the split between them is the whole design:
--
--   reina_mail_triage       one row per message per person -- the VERDICT.
--                           Written once and never re-derived, so a message
--                           costs exactly one classification for its lifetime
--                           and a re-open of the page is free.
--
--   reina_mail_triage_rules what Chris has CORRECTED, promoted to a standing
--                           rule for that sender or domain. This is the
--                           "learning" half, and it is deliberately boring:
--                           a correction becomes a lookup, not a fine-tune.
--                           A sender he has re-labelled once is never sent to
--                           the model again -- the rule answers first, which
--                           makes the same mistake impossible to repeat AND
--                           costs nothing.
--
-- NOTHING HERE MOVES MAIL. These tables hold labels and the record of what a
-- human chose to do about them. Reading a mailbox is reversible; archiving the
-- wrong message is not, so the act of filing stays a tap, never an inference.
--
-- Both tables are owner-scoped against auth.users. The API reads them with the
-- service key (bypassing RLS), so the policies below only guard a direct
-- anon/browser read -- the same posture as hc_ms_tokens.

create table if not exists reina_mail_triage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,

  -- Graph's internetMessageId: stable across folders and moves, which is what
  -- makes "classify each message exactly once" hold even after a message is
  -- filed. graph_id is the per-mailbox handle needed to ACT on it, and is not
  -- stable enough to key on.
  message_id text not null,
  graph_id text,
  home_account_id text,

  subject text,
  from_address text,
  from_name text,
  received_at timestamptz,
  web_link text,

  label text not null check (label in ('needs_reply','needs_scheduling','needs_action','junk','fyi')),
  confidence numeric,
  reason text,
  model text,
  -- 'rule' means a standing correction answered it and no model call was made.
  source text not null default 'model' check (source in ('model','rule')),

  -- What Chris changed it to, if he changed it. The original `label` is kept
  -- deliberately: a correction is only useful as evidence if you can still see
  -- what it corrected.
  corrected_label text check (corrected_label is null or corrected_label in ('needs_reply','needs_scheduling','needs_action','junk','fyi')),
  corrected_at timestamptz,

  acted_action text,
  acted_at timestamptz,

  created_at timestamptz not null default now(),
  unique (owner_id, message_id)
);

create index if not exists reina_mail_triage_owner_received_idx
  on reina_mail_triage (owner_id, received_at desc);

-- Feeding recent corrections back to the model as examples needs them cheaply.
create index if not exists reina_mail_triage_owner_corrected_idx
  on reina_mail_triage (owner_id, corrected_at desc)
  where corrected_at is not null;

create table if not exists reina_mail_triage_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- 'sender' is one address; 'domain' covers everyone at a company. A sender
  -- rule always wins over a domain rule -- one person at a vendor can matter
  -- while the vendor's marketing does not.
  match_kind text not null check (match_kind in ('sender','domain')),
  match_value text not null,
  label text not null check (label in ('needs_reply','needs_scheduling','needs_action','junk','fyi')),
  -- How often this rule has answered. Makes a bad rule visible instead of
  -- silently mislabelling mail forever.
  hits integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, match_kind, match_value)
);

create index if not exists reina_mail_triage_rules_owner_idx
  on reina_mail_triage_rules (owner_id, match_kind, match_value);

alter table reina_mail_triage enable row level security;
alter table reina_mail_triage_rules enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'reina_mail_triage' and policyname = 'reina_mail_triage_own_rows') then
    create policy reina_mail_triage_own_rows on reina_mail_triage
      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'reina_mail_triage_rules' and policyname = 'reina_mail_triage_rules_own_rows') then
    create policy reina_mail_triage_rules_own_rows on reina_mail_triage_rules
      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
  end if;
end $$;

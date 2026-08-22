-- Reina desktop notifications: reach Chris when HiveLogic is CLOSED.
--
-- Chris, 2026-08-19: "lets add the notifications while hivelogic is closed",
-- and on how: "it cant be a windows notification? only on the computer should
-- the nitifcations happen."
--
-- Until now the popup only existed while a HiveLogic tab was open and polling.
-- Close the tab and Reina went quiet, however urgent the mail. These three
-- pieces are what it takes to reach him without a tab:
--
--   reina_push_subscriptions  the browsers he said yes on. A Web Push endpoint
--                             plus its two keys. One row per browser, because
--                             the office desktop and the laptop are different
--                             consents and either can be revoked alone.
--
--   reina_notify_rules        WHETHER a sender is worth interrupting him for.
--
--                             This is deliberately NOT the same table as
--                             reina_mail_triage_rules, and the difference is
--                             the whole point. That table learns WHAT a
--                             message is. This one learns WHETHER IT IS WORTH
--                             HIS EVENING. A password-reset notice is
--                             correctly labelled needs_action and still is not
--                             worth a ping at 9pm; the vendor who owes him a
--                             quote is worth one at 7am. Folding those two
--                             judgements into one row would force a wrong
--                             label every time he wanted quiet.
--
--                             Chris, 2026-08-19: "Reina needs to have an
--                             option to mark it with some indicator that would
--                             allow her to learn over time whats worth sending
--                             and what can wait." So: same boring shape as the
--                             label rules -- a correction becomes a lookup,
--                             never a fine-tune -- and it is reversible,
--                             inspectable, and countable.
--
--   reina_mail_triage.notified_at   what has already been sent, so a message
--                                   interrupts him exactly once, ever.
--
-- NOTHING HERE MOVES MAIL, and nothing here decides on its own to go quiet
-- forever: a notify rule is written only from something he pressed.

create table if not exists reina_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- The push service URL for this browser. Unique on its own: the same
  -- endpoint arriving twice is the same browser re-subscribing, not a second
  -- device, and inserting it twice would ping him twice for one email.
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  -- Free text from the browser, only so a stale row is identifiable when he
  -- wants to know which machine is still subscribed.
  user_agent text,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  -- A push service answering 404/410 means this subscription is dead for good.
  -- Recorded rather than deleted on the spot, so a bad deploy that mass-fails
  -- is visible instead of silently emptying the table.
  failed_at timestamptz,
  failure_reason text
);

create index if not exists reina_push_subscriptions_owner_idx
  on reina_push_subscriptions (owner_id) where failed_at is null;

create table if not exists reina_notify_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- Same convention as the label rules: 'sender' is one address, 'domain' is
  -- everyone at a company, and a sender rule always wins over a domain rule --
  -- one person at a vendor can be worth waking him for while the vendor's
  -- billing robot is not.
  match_kind text not null check (match_kind in ('sender','domain')),
  match_value text not null,
  -- false = never interrupt him for this sender again (it still shows up in
  -- HiveLogic and on the Team To-Do -- quiet is not the same as hidden).
  -- true  = always worth it, even outside his hours.
  notify boolean not null,
  -- How the rule came to exist, so a rule he set by hand is never quietly
  -- overwritten by one inferred from behaviour.
  source text not null default 'button' check (source in ('button','opened','manual')),
  hits integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, match_kind, match_value)
);

create index if not exists reina_notify_rules_owner_idx
  on reina_notify_rules (owner_id, match_kind, match_value);

alter table reina_mail_triage
  add column if not exists notified_at timestamptz;

-- The sweep's hot query: "what has Reina judged, that he has not dealt with,
-- that has never been sent." Partial, because notified rows are the majority
-- within a day and none of them are ever candidates again.
create index if not exists reina_mail_triage_unnotified_idx
  on reina_mail_triage (owner_id, received_at desc)
  where notified_at is null and acted_at is null;

alter table reina_push_subscriptions enable row level security;
alter table reina_notify_rules enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'reina_push_subscriptions' and policyname = 'reina_push_subscriptions_own_rows') then
    create policy reina_push_subscriptions_own_rows on reina_push_subscriptions
      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'reina_notify_rules' and policyname = 'reina_notify_rules_own_rows') then
    create policy reina_notify_rules_own_rows on reina_notify_rules
      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
  end if;
end $$;

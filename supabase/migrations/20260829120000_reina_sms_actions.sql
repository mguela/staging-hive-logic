-- Extend Reina's action-approval system (20260823230000) to a second action
-- kind: send_sms. The approval lifecycle itself (issue/consume/reject/outcome,
-- once-only, owner-scoped, expiring) is already generic -- this only widens
-- the kind the table will accept, exactly as that migration's own comment
-- anticipated: "Widening Reina's reach should require a migration someone has
-- to read."
alter table public.reina_action_approvals
  drop constraint reina_action_kind_check;

alter table public.reina_action_approvals
  add constraint reina_action_kind_check check (
    action_kind in ('send_email', 'send_sms')
  );

-- Comms Hub: an SMS that went out through Reina's approval flow (drafted,
-- then a person tapped Send) is worth labeling as such in the thread --
-- distinct from an ordinary quick-send. Null means "sent the ordinary way",
-- which is every row that exists before this migration and every row a human
-- types from scratch.
alter table public.voice_messages
  add column if not exists origin text;

alter table public.voice_messages
  add constraint voice_messages_origin_check check (
    origin is null or origin in ('reina_approved')
  );

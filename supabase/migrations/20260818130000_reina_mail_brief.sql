-- Reina's read of a single email, stored on the triage row.
--
-- Chris, 2026-08-18: "I dont want the all mail and reina buttons. I want a
-- standard inbox and when you click the email on the list, it populates the big
-- preview screen. in the preview it shows a reina summary of the email and a
-- suggested action or response. below would be the actual email."
--
-- The batch classifier only ever sees a 400-character preview -- enough to sort
-- mail, not enough to summarize it. Opening a message reads the whole body, so
-- that read produces the summary, the action, the label and the draft in ONE
-- model call, and it is stored here.
--
-- Same rule as every other verdict in this table: written once, never
-- re-derived. Reopening an email he has already opened costs nothing.
--
-- Adds only. Every column is nullable, nothing existing is altered or dropped,
-- and a row written before this migration stays valid.
alter table public.reina_mail_triage
  add column if not exists summary_text text,
  add column if not exists action_text  text,
  add column if not exists brief_at     timestamptz;

comment on column public.reina_mail_triage.summary_text is
  'Reina''s plain-language summary of the whole email, written when it was first opened.';
comment on column public.reina_mail_triage.action_text is
  'What he actually has to do about it, from the full body rather than the preview.';
comment on column public.reina_mail_triage.brief_at is
  'When the full-body read happened. Null means only the preview-level verdict exists.';

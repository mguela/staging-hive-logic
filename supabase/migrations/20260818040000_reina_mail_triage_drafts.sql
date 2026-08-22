-- 20260818040000_reina_mail_triage_drafts.sql
--
-- Chris, 2026-08-17: "the replies should be written already by reina for review".
--
-- Drafting was on-demand: tap ✍️, wait for a model call, get a composer. That
-- is a fine interaction and the wrong DEFAULT -- the point of the list is to be
-- readable in one pass, and "I would have to tap each one to see what she'd
-- say" is not one pass.
--
-- So a draft is written once, when the message is first triaged, and kept here.
-- Same rule as the verdict itself: written once, never re-derived, so opening
-- the list a second time costs nothing and a draft he has started editing is
-- never overwritten underneath him.
--
-- draft_error holds the reason when drafting FAILED, so a message with no draft
-- can say why instead of looking like one Reina had nothing to say about.

alter table reina_mail_triage add column if not exists draft_text text;
alter table reina_mail_triage add column if not exists draft_at timestamptz;
alter table reina_mail_triage add column if not exists draft_error text;

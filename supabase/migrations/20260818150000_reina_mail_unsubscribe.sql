-- Where a message says you can unsubscribe, kept with the rest of its brief.
--
-- Chris, 2026-08-18: "for spam... can you have a way to auto-unsubscribe or
-- just push to junk only?"
--
-- Read out of the message's own List-Unsubscribe headers when it is first
-- opened. Stored for the same reason the summary is: the second open makes no
-- Graph call at all, and without this the junk buttons would be the one thing
-- on the panel that still needed a round trip.
--
-- Shape: {"oneClick": url|null, "web": url|null, "mailto": address|null}.
-- `oneClick` is non-null ONLY when the sender sent List-Unsubscribe-Post, which
-- is their promise that a single POST removes you. Null there means "they did
-- not commit to that" -- and for actual spam, clicking anything confirms the
-- address is live, so the answer is Junk rather than a link.
--
-- Adds only. Nullable, nothing altered or dropped.
alter table public.reina_mail_triage
  add column if not exists unsubscribe jsonb;

comment on column public.reina_mail_triage.unsubscribe is
  'List-Unsubscribe targets read from the message headers. oneClick is set only when the sender promised RFC 8058 one-click.';

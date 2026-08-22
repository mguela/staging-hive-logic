-- Retry bookkeeping for the client-messaging outbox processor.
--
-- Additive only: one nullable-with-default column on an existing table. No
-- drops, no renames, no rewrite of existing rows -- every row already in
-- hl_outbox simply reads attempts = 0, which is true of them.
--
-- Why it is needed: the processor (api/_lib/outbox-processor.js) retries a
-- failed send on the next tick rather than losing the message, but has to stop
-- eventually or a permanently bad address is retried forever. Without a
-- persisted counter "how many times have we tried this" cannot survive between
-- cron ticks, and the choice collapses to retry-always or retry-never.
alter table public.hl_outbox
  add column if not exists attempts integer not null default 0;

-- 'sending' is a transient claim state used to stop two overlapping cron ticks
-- from delivering the same row twice. Indexed with the same partial-index shape
-- as the existing due-row index so a crashed run's claimed rows are cheap to
-- find and requeue.
create index if not exists hl_outbox_sending_idx
  on public.hl_outbox (scheduled_for) where status = 'sending';

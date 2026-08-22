-- Correct the stale-claim sweep for the outbox processor.
--
-- The first cut measured "has this claim gone stale?" against scheduled_for --
-- the time the message was DUE. That is wrong in a way that sends a customer
-- the same email twice: every claimed row is by definition already past its
-- due time, so a row from a backlog (due three days ago) looks stale the
-- instant it is claimed, and a concurrent tick will yank it back to 'queued'
-- while the first tick is still inside the Resend call. A third tick then
-- sends it again.
--
-- Staleness has to be measured from when the claim was TAKEN, which nothing
-- recorded. This adds that column.
alter table public.hl_outbox
  add column if not exists claimed_at timestamptz;

-- Index the column the sweep actually filters on.
create index if not exists hl_outbox_claimed_idx
  on public.hl_outbox (claimed_at) where status = 'sending';

-- The previous index supported the incorrect query and nothing else. Dropping
-- an index removes no data and no rows -- it only stops Postgres maintaining a
-- structure that is now unused on every write to this table.
drop index if exists public.hl_outbox_sending_idx;

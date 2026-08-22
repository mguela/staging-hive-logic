-- Fill the board: open requests become opportunities.
--
-- Step 3 of the leads rebuild, after 20260818120000 made an opportunity a job
-- rather than a person. Two problems this fixes at once:
--
--   1. The board showed every client Jobber ever flagged is_lead, with no date
--      limit -- 346 cards, of which 80 were over a year old and only 31 had been
--      touched in the last 30 days. Because only 4 had lead_pipeline rows, the
--      other 342 rendered as "New" forever. A graveyard, not a pipeline.
--   2. The 30 requests that are genuinely open -- including 9 overdue -- were
--      not on the board at all. They lived in a separate tab.
--
-- Idempotent: re-running inserts nothing new. The open-request pass is guarded
-- by the partial unique index on request_id, and the lead-client pass skips any
-- client that already has an opportunity.

-- 1. The 30 genuinely open requests ----------------------------------------

-- Stage mapping is deliberately conservative -- it reflects only what Jobber
-- actually tells us and never invents progress:
--
--   new, unscheduled                  -> new            (nobody has acted yet)
--   upcoming, today, overdue,
--   assessment_completed              -> estimate_booked (a visit is/was on the
--                                                        calendar; whether an
--                                                        estimate went out is
--                                                        not something Jobber
--                                                        records, so the team
--                                                        moves it on by hand)
--
-- converted/archived requests are excluded entirely: they are finished work or
-- abandoned enquiries, and importing 1,457 of them would rebuild the graveyard
-- this migration exists to clear.
insert into public.lead_pipeline (client_id, request_id, title, stage, created_at, updated_at)
select
  r.client_id,
  r.jobber_id,
  nullif(btrim(coalesce(r.title, '')), ''),
  case
    when r.request_status in ('new', 'unscheduled') then 'new'
    else 'estimate_booked'
  end,
  coalesce(r.jobber_created_at, now()),
  now()
from public.requests r
where r.request_status not in ('converted', 'archived')
  and r.client_id is not null
  -- the client must still exist; client_id is a foreign key
  and exists (select 1 from public.clients c where c.jobber_id = r.client_id)
on conflict (request_id) where request_id is not null do nothing;

-- A request with no title of its own ("Request for Audrey Blauner" is common,
-- but some are genuinely blank) would render an untitled card. Fall back to the
-- client's name so every card reads as something.
update public.lead_pipeline lp
set title = c.name
from public.clients c
where lp.client_id = c.jobber_id
  and lp.title is null
  and c.name is not null;

-- 2. The 31 lead clients worth carrying over --------------------------------

-- Chris's decision 2: bring across only the leads touched in the last 30 days.
-- The other ~315 stay in the client list untouched -- nothing is deleted, they
-- simply stop occupying the board. Anyone who needs one back can find it under
-- Clients and it can be re-added as an opportunity.
insert into public.lead_pipeline (client_id, title, stage, created_at, updated_at)
select c.jobber_id, c.name, 'new', coalesce(c.jobber_updated_at, now()), now()
from public.clients c
where c.is_lead
  and not c.is_archived
  and c.jobber_updated_at > now() - interval '30 days'
  and not exists (
    select 1 from public.lead_pipeline lp where lp.client_id = c.jobber_id
  );

-- 3. Close the ones Jobber already finished ---------------------------------

-- Decision 3: a request Jobber marked "converted" became real work, so its
-- opportunity is won. This only catches rows created before this migration --
-- from here on api/jobber/sync-extended.js does it on every requests sync.
-- Only ever moves an opportunity that is still open, so a hand-set "lost" is
-- never overwritten.
update public.lead_pipeline lp
set stage = 'won', updated_at = now()
from public.requests r
where lp.request_id = r.jobber_id
  and r.request_status = 'converted'
  and lp.stage not in ('won', 'lost');

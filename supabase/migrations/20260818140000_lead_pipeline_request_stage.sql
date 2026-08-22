-- Requests become column one of the board.
--
-- Step 4 of the leads rebuild. After the step 3 backfill, an untouched request
-- landed in "New" alongside leads that came from somewhere else entirely -- a
-- Jobber-flagged lead client, or someone typed in by hand. Those are different
-- things: a request is an enquiry nobody has acted on yet, and it is the thing
-- most likely to go stale unnoticed (9 of the 30 open ones are already overdue).
--
-- Giving it its own stage makes the board read left-to-right as the work
-- actually flows: something arrives, you pick it up, you book the assessment,
-- you send the estimate, you win or lose it.

-- 1. Allow the new stage --------------------------------------------------

alter table public.lead_pipeline
  drop constraint if exists lead_pipeline_stage_check;

alter table public.lead_pipeline
  add constraint lead_pipeline_stage_check
  check (stage = any (array[
    'request',          -- came in from Jobber, nobody has acted on it yet
    'new',              -- a lead that did not come from a request
    'contacted',
    'estimate_booked',
    'estimate_sent',
    'won',
    'lost'
  ]));

-- 2. Move the untouched requests into it -----------------------------------

-- Only the ones Jobber still considers unworked. A request that is upcoming,
-- today, overdue or assessment_completed already has a visit on the calendar,
-- so step 3 put it in estimate_booked and that is where it belongs -- being
-- overdue means a booked assessment was missed, not that nobody has looked.
--
-- Restricted to stage='new' so a card someone has already dragged onwards is
-- never yanked back to the inbox.
update public.lead_pipeline lp
set stage = 'request'
from public.requests r
where lp.request_id = r.jobber_id
  and r.request_status in ('new', 'unscheduled')
  and lp.stage = 'new';

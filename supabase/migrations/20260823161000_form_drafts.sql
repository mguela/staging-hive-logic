-- Every unfinished form, not just the lead one.
--
-- Chris, 2026-08-23, after the New Lead rescue shipped: "we need this for all
-- forms throughout HiveLogic."
--
-- lead_drafts becomes form_drafts with a `kind`. A rename rather than a second
-- table: two tables holding the same shape would mean two of every query, two
-- policies to keep in step, and two places for the next person to forget one.
-- The table is renamed in place so the rows (and the RLS already on it) come
-- with it -- there were none in production at the time, but a rename is right
-- whether or not anyone had started typing.
alter table if exists lead_drafts rename to form_drafts;

-- Existing rows are all lead drafts by definition: that is the only form the
-- old table could hold. Defaulted rather than nullable so a row can never be a
-- draft of nothing in particular.
alter table form_drafts add column if not exists kind text not null default 'lead';

drop index if exists lead_drafts_owner_idx;
create index if not exists form_drafts_owner_idx on form_drafts (owner_id, kind, updated_at desc);

-- The policies moved with the table; rename them so the next person reading
-- \d form_drafts is not told about a table that no longer exists.
alter policy lead_drafts_own_select on form_drafts rename to form_drafts_own_select;
alter policy lead_drafts_own_insert on form_drafts rename to form_drafts_own_insert;
alter policy lead_drafts_own_update on form_drafts rename to form_drafts_own_update;
alter policy lead_drafts_own_delete on form_drafts rename to form_drafts_own_delete;

comment on column form_drafts.kind is
  'Which form this is a draft of: lead, job, client, estimate, ... The Leads page shows kind=lead, Jobs shows kind=job, and so on.';

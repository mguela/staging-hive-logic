-- HiveDoc: who is allowed to see a file.
--
-- The 2026-08-21 audit found that neither document system had the
-- internal / client-visible / subcontractor-visible model the brief described.
-- What existed was `documents.sensitive` -- one boolean that hides contracts and
-- payroll from crew. That is a STAFF-SIDE distinction and it stays exactly as it
-- is; this migration adds the OUTSIDE-THE-COMPANY axis, which is a different
-- question and was missing entirely.
--
-- WHY TWO BOOLEANS AND NOT ONE LEVEL. "Internal / client / subcontractor" reads
-- like three rungs of a ladder, but it is not one: a permit can be visible to
-- the homeowner AND to the plumbing sub, while a client contract is visible to
-- the homeowner and must never be visible to a sub. Those audiences overlap
-- without nesting, so a single ordered column cannot express them and would
-- quietly force a wrong answer for one of the two cases. Two independent flags
-- can express all four states, including "both".
--
--   client_visible = false, sub_visible = false  -> Internal (the default)
--   client_visible = true,  sub_visible = false  -> the client can see it
--   client_visible = false, sub_visible = true   -> assigned subs can see it
--   client_visible = true,  sub_visible = true   -> both
--
-- DEFAULT IS CLOSED. Both default to false, so every existing row and every new
-- upload is internal until somebody deliberately shares it. The alternative --
-- inferring that, say, invoices are probably client-visible -- would silently
-- expose files nobody chose to expose, which is the one failure mode that
-- cannot be walked back once a portal has served the file.
--
-- NOT NULL so there is no third "unknown" state to have to interpret at read
-- time. An unknown visibility is indistinguishable from a permissive one in
-- practice, because whoever writes the query has to guess.
--
-- `media` IS DELIBERATELY NOT ALTERED. Photos are treated as internal by the
-- read model, full stop. Photo sharing with clients already has its own
-- mechanism (`client_photo_shares`, 0 rows), and adding a second, parallel way
-- to make a photo client-visible would mean two places to check before
-- answering "can this person see this photo" -- which is how files leak.

alter table public.documents
  add column if not exists client_visible boolean not null default false,
  add column if not exists sub_visible    boolean not null default false;

comment on column public.documents.client_visible is
  'The client on this record may see this file through the client portal. Default false: internal until deliberately shared.';
comment on column public.documents.sub_visible is
  'Subcontractors assigned to this job may see this file through the sub portal. Default false. Independent of client_visible -- a file can be visible to both, either, or neither.';

-- Partial indexes: the shared rows are the rare case and the only case a portal
-- ever queries for, so indexing just those keeps them small and the lookup exact.
create index if not exists documents_client_visible_idx
  on public.documents (client_id) where client_visible;
create index if not exists documents_sub_visible_idx
  on public.documents (job_id) where sub_visible;

-- A file with no client cannot be client-visible: there is nobody for "the
-- client" to resolve to, so such a row would be visible to whichever client's
-- portal happened to ask. Enforced rather than left to the application, because
-- this is the constraint whose violation is a data leak.
alter table public.documents
  drop constraint if exists documents_client_visible_needs_client;
alter table public.documents
  add constraint documents_client_visible_needs_client
  check (client_visible = false or client_id is not null)
  not valid;

-- Same argument for subs: sub visibility is scoped by job assignment, so a row
-- with no job has no assignment to scope it and would be visible to every sub.
alter table public.documents
  drop constraint if exists documents_sub_visible_needs_job;
alter table public.documents
  add constraint documents_sub_visible_needs_job
  check (sub_visible = false or job_id is not null)
  not valid;

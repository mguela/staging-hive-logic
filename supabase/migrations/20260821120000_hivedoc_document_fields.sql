-- HiveDoc: the metadata fields that make plain-English file search work.
--
-- NOT YET APPLIED TO PRODUCTION. Chris's guardrail on this work is "no
-- production migration without explicit sign-off", so this file is written and
-- reviewed first. api/hivedoc.js does not depend on any column below -- it
-- matches these concepts in code against the columns that exist today, so
-- search works before this lands and gets faster and more precise after.
--
-- WHY THESE FIVE COLUMNS. Chris's spec lists the fields a file needs for
-- "latest invoice from Joe the plumber on the John Smith job" to be answerable.
-- Checked against the live `documents` table on 2026-08-21, these five are the
-- ones missing:
--
--   category       -- doc_type exists and holds the same idea in lowercase, but
--                     the spec's vocabulary adds Receipt, and doc_type has no
--                     constraint, so anything can be written into it today.
--   source         -- which part of the app a file came from. Nothing records
--                     this now, so "the photo the tech took" and "the photo the
--                     office uploaded" are indistinguishable after the fact.
--   vendor_name    -- "Joe the Plumber". Free text on purpose: subs are not a
--                     closed list, and a sub invoice can arrive before the sub
--                     is ever set up in the system.
--   document_date  -- when the document is DATED, not when it was uploaded. A
--                     permit issued in June and scanned in August sorts wrong
--                     under uploaded_at, and "latest" is the whole question.
--   title          -- an editable human name. filename is not one: a phone
--                     produces IMG_4821.HEIC and CompanyCam produces
--                     companycam-8f3a.jpg.
--
-- ALL ADDITIVE. Every column is nullable with no default and no backfill, so
-- existing rows are untouched and nothing that reads this table today can break.
-- The production table holds exactly one row (a test upload), so the rewrite
-- cost is nil regardless.
--
-- NOT IN SCOPE HERE. `media` is deliberately not altered. It holds 40,939 rows
-- and reaches its client through jobs.jobber_id = media.job_id for 100% of them
-- (verified 2026-08-21), so it needs no column to become searchable by client.
-- Adding a denormalised client_id there would create the second source of truth
-- this whole exercise exists to remove.

alter table public.documents
  add column if not exists category      text,
  add column if not exists source        text,
  add column if not exists vendor_name   text,
  add column if not exists document_date timestamptz,
  add column if not exists title         text;

-- The spec's category vocabulary, enforced. NOT VALID so the check applies to
-- new and updated rows without demanding a rewrite of existing ones -- there is
-- nothing to validate today, but this migration should stay safe to run against
-- a table that has since filled up.
alter table public.documents
  drop constraint if exists documents_category_check;
alter table public.documents
  add constraint documents_category_check
  check (category is null or category in
    ('Contract', 'Permit', 'Photo', 'Invoice', 'Receipt', 'Estimate', 'Payroll', 'Other'))
  not valid;

-- Seed `category` from the doc_type already on the row, so the new column is not
-- born empty. Mapping only the values doc_type is documented to hold; anything
-- else is left null rather than guessed into a category it may not belong in.
update public.documents
   set category = initcap(doc_type)
 where category is null
   and doc_type in ('contract', 'permit', 'photo', 'invoice', 'receipt', 'estimate', 'payroll', 'other');

-- Everything already in the table arrived through the Documents tab's upload
-- button, so that is the only honest value for its source.
update public.documents
   set source = 'Manual upload'
 where source is null;

-- Absent a real document date, the upload time is the best evidence we have of
-- when the document existed. Recorded explicitly rather than left null so
-- "newest first" has something to sort on for every row.
update public.documents
   set document_date = uploaded_at
 where document_date is null;

-- The indexes the search endpoint will use once it can push these filters down
-- to the database instead of matching them in code.
create index if not exists documents_category_idx      on public.documents (category);
create index if not exists documents_source_idx        on public.documents (source);
create index if not exists documents_document_date_idx on public.documents (document_date desc);
-- Vendor is matched by partial name ("joe" -> "Joe the Plumber"), which a btree
-- cannot serve. trigram is the right index for that, and pg_trgm ships with
-- Supabase. Guarded so this migration still applies if the extension is absent.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_trgm') then
    create extension if not exists pg_trgm;
    create index if not exists documents_vendor_name_trgm_idx
      on public.documents using gin (vendor_name gin_trgm_ops);
  end if;
end $$;

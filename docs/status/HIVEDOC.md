# HiveDoc status

**Evidence date:** 2026-08-17 (storage sections: 2026-08-22 / 2026-08-23)
**Owner:** No HiveDoc owner is recorded in the repository.

## Repository state

- The real metadata model exists in the production baseline: `documents`,
  `folders`, and `folder_access` have row-level policies; document metadata has
  folder/type/date indexes and a filename/client/job full-text index.
- `api/documents.js` is an authenticated AI-classification endpoint. This pass
  added strict filename/MIME/base64 validation and a 3 MiB decoded sample cap so
  a signed-in caller cannot send an unbounded model payload.
- Leaked-password protection is enabled and security-advisor verified for the
  HiveDoc Auth project.
- The browser classification call now obtains the verified session, attaches
  its bearer token, and uses the same 3 MiB cutoff as the API.
- The Documents view performs real Storage + metadata operations. It uploads to
  the private `docs` bucket, inserts `documents` metadata, signs stored files,
  and removes an orphaned object if metadata insertion fails.
- `supabase/migrations/20260817221820_documents_storage_rls.sql` now versions the
  private bucket and the browser flow's upload/read/cleanup policies. It was
  applied and structurally verified in production on 2026-08-17: the bucket is
  private, the policies are present, and the live sample had one object linked
  to one document with zero orphan objects.
- The initial production migration placed its SECURITY DEFINER cleanup helper
  in the API-exposed `public` schema, which triggered an advisor finding.
  `20260817222303_documents_storage_private_cleanup_helper.sql` moves the helper
  to non-exposed `private`, recreates the owner-cleanup policy, and removes the
  public helper. That repair was applied and verified on 2026-08-17: the public
  helper is absent, the private helper has a pinned empty `search_path`, `anon`
  cannot execute it, required authenticated/service-role access remains, and
  the cleanup policy calls it. The advisor no longer flags this helper.

## Three writers that had never worked (2026-08-22)

- **The bug.** Three features uploaded to Supabase Storage buckets that have
  never existed on the production project: `sub-documents` and `sub-invoices`
  (`api/subportal.js`), and `onboarding-licenses` (`api/invites.js`). Production
  has exactly six buckets — `media`, `monitor-screenshots`, `voice-greetings`,
  `docs`, `devtodo-attachments`, `marketing-attachments` — re-confirmed
  2026-08-22. Each site carried a comment saying a human would create the bucket
  by hand; nobody ever did, so every one of those uploads failed from the day it
  was written.
- **Two different failure modes, both confirmed against a Storage stub rather
  than inferred.** `api/subportal.js` threw: the sub got a 502 carrying
  Supabase's raw error, and no metadata row was written at all, because the
  insert only ran after the upload returned — which is why `sub_documents` held
  0 rows. `api/invites.js` caught: it wrote an `onboarding_steps` row
  permanently at `status: 'pending'` with `path: null`, returned 502, and showed
  the hire a note naming the missing bucket. Honest, but the licence step was
  stuck forever either way.
- **The fix (#521).** All three now write to the existing private `docs` bucket
  through one module, `api/_lib/hivedoc-files.js` — `subs/documents/`,
  `subs/invoices/` and `onboarding/licenses/`. No new bucket and no migration:
  `docs` and its RLS were applied and verified on 2026-08-17, and creating the
  missing buckets would have required a production migration.
- **The invariant that module exists to hold: no bytes in `docs` without a
  `public.documents` row.** The bucket's read policy grants an object only when
  a documents row points at the same `storage_path`, so an undescribed object is
  unreadable by every authenticated user, invisible to search, and unreachable
  by the owner-cleanup policy (service-key writes have a null `owner_id`). That
  is not a file with missing metadata; it is data nobody can find, read or
  erase. `storeFiledDocument()` does both writes or neither.
- **A licence photo is written `sensitive: true`.** It is a government ID, and
  `sensitive` is the staff-side gate that `public.documents` RLS and
  `canSee()` both honour.
- **Two live bugs fixed in the same pass.** `/api/hivedoc` returned 502
  `viewer is not defined` on every authenticated `search`/`tree`/`facets`/`ask`
  call — `resolveStaffViewer()` was dead code that nothing called. And
  `?resource=file` signed any row for any authenticated caller with no
  visibility check, so a row id was enough to open a `sensitive` contract that
  the list had correctly hidden. It now runs the same `canSee()` the list uses
  and refuses with 404 rather than 403, so a refusal does not confirm the file
  exists.

## Sub documents and invoices are in the read model (2026-08-23)

- `sub_documents` and `sub_invoices` join `documents` and `media` in
  `/api/hivedoc` (#531). A sub invoice carries the sub's company name as
  `vendor_name` and reaches a client through
  `jobs.jobber_id = sub_invoices.job_ref`, the same join `media` uses.
- This is what makes **"latest invoice from Joe the plumber on the John Smith
  job"** — an acceptance case in the spec — answerable. Before it, a sub's
  invoice was in neither table the engine read.
- `sub_documents` has no client and no job, so both stay null and the row files
  under Unassigned. A W9 belongs to a vendor, not to a job.
- **Both stores are staff-only.** `canSee()` allowlists `documents` as the only
  store that may leave the company, so neither portal can reach them; a sub sees
  their own paperwork through the sub portal's session-scoped actions, which are
  keyed to `sub_id`.
- The query planner skips a store that cannot match the filters, so a search for
  permits reads neither sub table.

### The two halves disagreed about who may open a sub document (fixed 2026-08-23)

Landing #521 and #531 within hours of each other shipped a real access gap that
neither PR could see on its own. Confirmed by running the endpoint, not by
reading:

- The **write** path (`api/subportal.js`, `SUB_DOC_SENSITIVE = true`) stamps
  every sub document `sensitive: true` on its `public.documents` row, because
  `doc_type` is free text the portal has never validated — you cannot tell a W9
  from a COI by looking.
- The **read** path (`subDocumentIsSensitive()`) exempted a named-harmless list
  (`coi`, `insurance`, `licence`) on the reasoning that a crew lead has cause to
  check a certificate of insurance on site.

So for one COI, with the same bytes at the same `storage_path`, a crew member
got **404 through `?system=documents` and 200 through `?system=sub_documents`**.
Two representations of one file, disagreeing about who may open it, and the
permissive one won by being asked for. `subDocumentIsSensitive()` now returns
true unconditionally, matching the write path — the stricter side, and the one
with the better argument. A test reads both write-path constants out of
`api/subportal.js` and asserts the projection agrees, so the two cannot drift
apart again silently.

### Resolved: every sub file was listed twice (2026-08-23)

A sub upload writes **both** a `public.documents` row (via
`storeFiledDocument()`, which is what makes the object readable at all) **and**
a `sub_documents` / `sub_invoices` row whose `file_url` is the same
`storage_path`. HiveDoc reads all four stores, so an admin searching saw one COI
as two results.

**The sub row is the one that stops being listed** — Chris's call. It is not the
one discarded, and the distinction is load-bearing: `insertDocumentRow()` writes
baseline columns only, so the `documents` row for a sub upload has no vendor, no
client, no job and no amount. Suppressing the sub row outright leaves a bare
`invoice.pdf` and makes *"latest invoice from Joe the plumber on the John Smith
job"* match nothing — the acceptance case the sub stores were added for. Checked
before implementing, not after.

So `mergeDuplicateFileRows()` keeps the documents row and carries the sub row's
domain facts onto it. Which half wins a field is decided by which half is
authoritative for it: identity, storage path and the sharing flags stay with the
`documents` row; vendor, client, job, amount, status, expiry and a readable
title come from the sub row; `sensitive` is OR-ed, so closed wins. A sub row
with no `documents` twin is untouched — every row written before 2026-08-22 is
in that state, because the upload that would have created a twin always failed.

Mutation-tested: replacing the merge with plain suppression fails 9 of the 16
tests in `test/hivedoc-duplicate-files.test.mjs`, including the named regression
guard.

### Two PRs found this independently

#521 and #522 diagnosed the same bug and reached the same fix on the same day.
#521 merged first and its module is the one implementation; #522's parallel
`docs-bucket.js` was dropped rather than merged, and #531 salvaged the part of
it that was a feature rather than a duplicate. Worth recording, because two
sessions spending a day each on one bug is the cost of the collision, not a
detail — and it is the second time a stale view of what is already merged has
produced duplicate work in this repo.

## Verification and open gaps

- Focused classifier and Storage/schema contract tests pass locally.
- No single live upload → AI classify → Storage object → metadata → signed
  download → search run was performed. The production checks above establish
  storage/metadata integrity, not the full signed-in browser workflow.
- The Documents list now loads bounded 50-row server pages. Search is truthfully
  labeled page-local and filters only the loaded page; the database GIN search
  index is not yet used for global server-side search.

**Current label:** Backend, metadata, Storage policies, and the private cleanup
helper repair are live and structurally verified; the three previously-broken
writers now route into `docs` through one module and are covered by tests
driving the real handlers. The complete signed-in browser workflow remains
unverified — no end-to-end run of upload -> `docs` object -> metadata row ->
HiveDoc search -> signed open has been performed for any of the four writers.

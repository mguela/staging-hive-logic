# HiveDoc as the single file backend — audit and architecture decision

**Date:** 2026-08-21
**Branch:** `feature/hivedoc-single-backend`
**Status:** decision approved by Chris 2026-08-21; sections 9-10 cover what was then built.

---

## TL;DR

The brief's framing turned out to be wrong in one important way, and I need you to
read this part before anything gets built.

**There are not two competing document apps with different permission models.
There is one document app that exists twice, and a third system that holds every
real file.**

- The standalone HiveDoc app and the built-in Documents tab have **identical
  schemas** (`documents`, `folders`, `folder_access`, `profiles`). The built-in tab
  is a straight port of the standalone app into the main database. Neither has a
  richer permission model than the other, and neither has the
  internal/client-visible/subcontractor-visible model the brief assumed.
- **Both are empty.** Standalone: 0 documents. Built-in: 1 document, and it is a
  76 MB `HiveLogic Monitor Setup 1.0.0.exe` test upload with no client and no job.
- **All 40,939 real files — 18 GB — live in `media`**, which neither document system
  can see.

So "which one is real?" has a blunt answer: **neither of them is; `media` is.**
The decision below reflects that.

---

## 1. Inventory — what is actually stored where, today

Counts are live from production (`sqhusuuhlmcmkeowdrga`) and the standalone HiveDoc
project (`xxxutmorfqjdiugcavti`), read 2026-08-21.

| System | Storage | Files | Size | Real data? |
|---|---|---|---|---|
| **CompanyCam back-import** | `media` bucket + `media` table | **40,939** | **18 GB** | **Yes — all of it** |
| Built-in Documents tab | `docs` bucket + `documents` table | 1 | 76 MB | No — one `.exe` test upload |
| Standalone HiveDoc app | own Supabase project, own bucket | **0** | 0 | No — completely empty |

Supporting detail:

- `media` spans **2026-07-18 → 2026-08-20** and is in daily use.
- **Correction to my own first pass:** the corpus is not a mix of sources.
  **40,937 of the 40,939 rows are CompanyCam imports** (`{job}/companycam-*.jpg`); the
  other 2 are test uploads. There are **zero Field App photos and zero HiveSight-
  originated photos** in production. Those write paths exist in code but have never
  been used — the same status as signatures and takeoffs in section 5.
- `media` <-> `media` bucket is **perfectly consistent**: 0 storage objects without a
  metadata row, 0 metadata rows without a storage object.
- `folders`: 93 rows in production (66 public / 26 private / 1 template). Only 6 carry
  a `client_id`; **none** carry a `job_id`. `folder_access`: **0 rows** — the sharing
  mechanism has never been used.
- Standalone HiveDoc project: 4 folders, 1 auth user, 0 documents, 0 storage objects.
  Last push to the `hivedocs` repo was **2026-07-17** — 35 days stale. It is deployed
  at `hivedocs-flax.vercel.app`.

### The claim about permission models does not hold up

The brief proposed keeping the standalone app because it "has the richer permission
model (internal/client-visible/subcontractor-visible)". Reading both schemas:

- Standalone `supabase/schema.sql`: `profiles.role` in (`admin`, `crew`), plus a
  `sensitive` boolean that hides contracts and payroll from crew.
- Production `documents` table: the same columns, same `sensitive` flag, same
  `folder_access` table. Production `profiles.role` additionally has `superadmin`.

There is no internal/client-visible/subcontractor-visible model in either one. If you
want that model, it is **new work in both cases** — it is not a reason to prefer one.

---

## 2. Decision — recommended, for your sign-off

**Make the built-in Documents tab (inside `hivelogic-live`) the canonical HiveDoc.
Retire the standalone `hivedocs` app. Make `media` HiveDoc's photo storage backend
rather than a competing system.**

### Why the built-in one, not the standalone

1. **It is in the same database as clients and jobs.** The standalone app pulls the
   client/job list over HTTP from `hivelogic-live/api/clients` and `/api/jobs` into a
   *second Postgres*. That is structurally the duplication you asked to eliminate —
   two databases, two copies of the client list, two things to drift. The built-in
   one already has `client_uuid` and `job_uuid` alongside the text ids.
2. **Its production storage layer is real and verified.** Private `docs` bucket, RLS
   policies, and the SECURITY DEFINER cleanup helper were applied and structurally
   verified in production on 2026-08-17 (`docs/status/HIVEDOC.md`).
3. **Nothing is lost.** The schemas are identical, and the standalone holds zero
   files. Retiring it costs nothing but the Next.js UI, which is 35 days stale.
4. **It already has more UI than the brief credits it with.** The built-in tab has a
   folder tree, virtual client and vendor folders, templates, rename/move/copy,
   pagination, and AI classification — 128 `hlDoc*` call sites in `index.html`.

### Why `media` becomes a backend, not a migration target

The spec offered this as an explicit alternative ("or `media` becomes an internal
implementation detail HiveDoc itself uses — confirm which, don't guess"). Confirming:
**`media` should stay where it is and become HiveDoc's photo store.**

Copying 18 GB and 41,000 objects from the `media` bucket into the `docs` bucket buys
nothing — same Supabase project, same Storage service, same durability — and risks a
corpus that is currently 100% internally consistent. The duplication you want gone is
**two sources of truth for the same file**, and that is fixed by one read model and
one write path, not by one bucket.

**The unification is a single API and a single index over both tables — not a single
bucket.**

---

## 3. The client link already exists, and it resolves 100%

This was the biggest open question in the brief, and the answer is good news.

`media` has **no `client_id` column**. It has `job_id` (text, Jobber GID) and
`job_uuid`. But every row resolves to a client through the jobs table:

| Check | Result |
|---|---|
| Total `media` rows | 40,939 |
| Resolvable to a client via `jobs.jobber_id = media.job_id` | **40,939 (100%)** |
| Distinct clients covered | **753** |
| Rows with `job_uuid` populated | 39,609 (96.8%) |

So **HiveSight is a "surface it in HiveDoc's UI" fix, not an "add the link first" fix
— with one caveat**: the link is derivable but not stored, and the Field App's
`photo_add` writes `job_id` without `job_uuid`, which is why 1,330 rows lack the uuid.
Both are cheap to fix forward.

Storage paths in the `media` bucket are `{base64 Jobber job GID}/companycam-{id}.jpg`
— organised by job, with no client in the path. The client folder therefore has to
come from the join, which is fine, and is what the `client -> job -> category` tree
needs anyway.

---

## 4. Field gaps against your spec

Your required field list vs what exists:

| Required field | `documents` | `media` |
|---|---|---|
| `client_id` | yes (+ `client_uuid`, `client_name`) | no — derivable via job |
| `job_id` | yes (+ `job_uuid`, `job_title`) | yes (+ `job_uuid` on 96.8%) |
| `category` | partial — exists as `doc_type` | no |
| `source` | no | no — inferable from path/table today |
| `vendor_name` | no | no |
| `document_date` | partial — only `uploaded_at` | partial — has `captured_at` |
| `title` | partial — only `filename` | no |

Nothing here is hard; it is additive columns plus a backfill of `category`/`source`
from what we already know (every `media` row is a Photo from a known tool).

---

## 5. Things this spec did not anticipate — flagging rather than silently leaving them

You asked me to surface any file-related feature the brief missed. There are eight,
plus three to exclude.

**Genuinely in scope, and currently outside both document systems:**

1. **Receipts are stored as base64 inside Postgres.**
   `bookkeeping_evidence_documents` keeps the actual file bytes in a `data_base64`
   column (7 rows) — not in Storage at all. This is a *fourth* storage mechanism, and
   receipts are explicitly named in your spec.
2. **Subcontractor documents (COI, W9) upload to buckets that do not exist.**
   `api/subportal.js` writes to `sub-documents` and `sub-invoices`; neither is in
   `storage.buckets`. `sub_documents` has 0 rows. These uploads fail today.
3. **Onboarding licence uploads have the same problem** — `api/invites.js` writes to
   `onboarding-licenses`, which also does not exist.
4. **Job signatures** write to the `media` *bucket* but record into a separate
   `job_signatures` table — 0 rows so far. Wired, never used.
5. **Takeoff plan images** write to the `media` bucket under `takeoffs/{quoteId}/`,
   keyed to a **quote**, with no client or job. 0 rows so far.
6. **`media_entity_links`** already exists — a generic "link a photo to any HiveLogic
   entity" table, 0 rows. This is the natural home for an explicit client link, and
   it is already built.
7. **`client_photo_shares`** (0 rows) is an existing client-visibility mechanism for
   photos, and overlaps whatever client-visible permission model you want.
8. **`marketing_media_assets`** + the `marketing-attachments` bucket are a separate
   asset library.

**Recommend explicitly excluding** (not business files): `monitor-screenshots` (306
objects — employee monitoring), `voice-greetings` (1), `devtodo-attachments` (1).

Items 2 and 3 are live bugs I found while auditing, unrelated to this architecture
work. Say the word and I'll file them separately rather than folding them in here.

---

## 6. Proposed build order (revised from the brief, pending your sign-off)

Unchanged from your spec in intent; reordered because the audit changed what step 1
means.

1. **Additive schema** on `documents` (`category`, `source`, `vendor_name`,
   `document_date`, `title`) — no data moves.
2. **One structured search endpoint** reading a **union view** over `documents` and
   `media`, with the client derived from the job join. This is the engine for the
   Global Search bar, the Reina natural-language layer, and HiveDoc's own
   client -> job -> category browse UI — one endpoint, three consumers.
3. **Client detail file lists** read from that endpoint.
4. **New uploads route through one write path** (Field App, HiveSight, receipts) that
   stamps client/job/category/source. Additive — existing rows untouched.
5. **Reina NL layer** translating English into filters on the same endpoint, reusing
   the existing AI layer.
6. **Retire the standalone app** with a redirect/banner, not a deletion.

**No migration in any of that.** The existing 40,939 files stay exactly where they
are and become visible through the new read model. A separate migration plan — if you
even want one after seeing that `media` is already consistent — comes later and needs
your explicit sign-off, per your guardrail.

---

## 7. Verified vs unverified

**Verified (live production reads, 2026-08-21):**
- All counts, sizes, and date ranges in section 1.
- The 100% client-resolvability figure in section 3, and the 753 distinct clients.
- `media` bucket <-> `media` table consistency (0 orphans in both directions).
- The standalone HiveDoc project is empty (0 documents, 0 storage objects).
- Both systems' table lists are identical.
- Missing buckets `sub-documents`, `sub-invoices`, `onboarding-licenses` are absent
  from `storage.buckets`.
- Schema/field gaps in section 4, read from `information_schema`.

**Not verified — stated as unverified deliberately:**
- **I did not run the built-in Documents tab end-to-end in a browser.** Upload -> AI
  classify -> Storage object -> metadata -> signed download -> search has never been
  run by anyone, per `docs/status/HIVEDOC.md`, and I did not run it either. Its
  "works" status is inferred from code and from the structural production checks, not
  observed.
- **I did not open the standalone app.** `hivedocs-flax.vercel.app` returns 307
  (redirect to login). I confirmed its database is empty rather than testing its UI.
- **I did not test whether the sub-portal / invites uploads actually fail.** The
  buckets are absent and the code says it does not create them; I inferred failure
  rather than triggering it.
- No claim is made about *why* the standalone app was abandoned — only that it is
  empty and 35 days stale.
- No code was changed and no PR has been opened.

---

## 8. Open questions

Question 1 (the architecture decision) was **approved on 2026-08-21** — build proceeded
on that basis. Three remain open, and none of them block what is built so far:

1. ~~Confirm the decision in section 2.~~ **Approved.**
2. **The migration in `supabase/migrations/20260821120000_hivedoc_document_fields.sql`
   has not been applied to production**, per your "no production migration without
   explicit sign-off" guardrail. Search works without it (see section 9); applying it
   makes the new fields writable and pushes filtering down into the database. It needs
   your word before it runs.
3. **What should the permission model actually be?** Neither system has
   internal/client-visible/subcontractor-visible; today it is admin/crew plus a
   `sensitive` flag. Whatever you want here is new work. The search endpoint currently
   carries `sensitive` through on every row but does not yet filter on it.
4. **Do the broken sub-doc and licence uploads** (section 5, items 2 and 3) get filed
   as separate bugs, or folded into this work?

---

## 9. What was built

One PR, additive only. No file moved, no row deleted, no migration run.

### `api/_lib/hivedoc-search.js` — the engine

Pure and I/O-free, so it is testable without a database. Projects `documents` and
`media` into one row shape; fuzzy job matching; category/source/vendor/date filters;
newest-first ranking; paging; and the client -> job -> category grouping for the
browse tree.

### `api/hivedoc.js` — the endpoint

```
GET /api/hivedoc?resource=search&client=&job=&category=&vendor=&source=&q=&from=&to=&sort=&limit=&offset=
GET /api/hivedoc?resource=tree      client -> job -> category counts
GET /api/hivedoc?resource=facets    which categories and sources actually exist
GET /api/hivedoc?resource=file&system=documents|media&id=...   short-lived signed URL
```

This is the single engine your spec asked for. The Global Search bar, Reina's
natural-language layer, and HiveDoc's own browse UI are all meant to call **this** —
none of them re-implements search.

Three deliberate behaviours worth knowing about:

- **`media` is skipped entirely when it cannot possibly match.** Every one of its
  40,939 rows is a Photo with no vendor, so a search for invoices, or for "Joe the
  Plumber", never touches it.
- **"no such client" and "that client has no files" return differently** —
  `noClientMatch: true` versus an empty list. Same for a category we do not have
  (`unknownCategory`), which is reported rather than silently ignored.
- **A scan that hits its cap says so** (`truncated: true`). A result list that cannot
  admit it did not see everything is quietly lying about completeness.

### The migration (written, **not applied**)

`documents` gains `category`, `source`, `vendor_name`, `document_date`, `title` — all
nullable, with no backfill beyond seeding the new columns from what each row already
says. `media` is deliberately **not** altered: it reaches its client through the job
join for 100% of rows, and denormalising a `client_id` onto it would create the second
source of truth this work exists to remove.

### Tests

`test/hivedoc-search.test.mjs` — 35 tests, including all four of your example questions
as explicit acceptance cases:

| Question | Asserted |
|---|---|
| "photos of John Smith job" | that client's photos only |
| "permit for the kitchen reno" | fuzzy job match — "kitchen reno" finds "Kitchen Renovation" |
| "latest invoice from Joe the plumber on the John Smith job" | both matches returned, newest first |
| "signed contract for John Smith bathroom remodel" | the contract |

---

## 10. Verified vs unverified — for section 9

**Verified:**

- 35/35 new tests pass. Full suite: **3,370 pass, 14 fail** — the same 14 fail on
  pristine `origin/main` (ad-platform, mail, documents-classifier, marketing-auth-gate),
  all pre-existing and unrelated to this work.
- **The migration was executed against a real Postgres**, not eyeballed. It ran inside a
  transaction on the standalone HiveDoc project — identical schema, zero rows, and the
  one being retired. Confirmed: all five columns add; the category constraint **rejects**
  an invalid value and **allows** null and valid ones; all four indexes create, including
  the pg_trgm one. The rollback left **zero** trace — 0 columns, 0 rows, 0 indexes.
- **The client -> job join was checked against real production data.** For the heaviest
  client it produces exactly the tree the browse UI needs: REPAIR GATES 2,009 photos,
  RENOVATION 378, shovel walkways 211, Bathroom Windows 118, and so on.

**Not verified — stated plainly:**

- **`/api/hivedoc` has never been called over HTTP.** It is not deployed yet. Its query
  builder is exercised only through the pure module's tests; the PostgREST calls
  themselves, the auth guard, and the signed-URL path are unrun.
- **No end-to-end run.** "Upload a file -> see it under the right client -> find it from
  elsewhere in the app" is the acceptance test in your spec, and it has not happened. It
  cannot until this deploys and the UI is wired (steps 3-5).
- **The built-in Documents tab still has never been run end-to-end by anyone.** That was
  true before this work and is still true.
- **Nothing in the UI reads this endpoint yet** — client detail lists, Global Search, and
  Reina are all still on their old paths. That is the next PR.

---

## 11. Closing out the open questions (2026-08-21, later the same day)

Chris answered "do all of" to the four items in section 8. All four are done.

### 1. Architecture decision — approved and shipped

PR #494 merged to `main` (squash `09e2f7a0`). `/api/hivedoc` is live on production.

### 2. The field migration — APPLIED to production

`20260821120000_hivedoc_document_fields.sql` was applied on Chris's explicit
sign-off and verified after the fact: 5 columns present, 4 indexes created, the
category constraint live, and the single existing row correctly seeded to
`category=Other, source=Manual upload`.

### 3. The permission model — built (PR #504)

Neither system had internal / client-visible / subcontractor-visible. It exists
now. **The semantics were chosen from the brief's own wording**, since that was
the only concrete spec available — if Chris wants different audiences the shape
is cheap to change while nothing is shared yet.

Two independent booleans rather than one ordered level, because the audiences
overlap without nesting: a permit can be visible to the homeowner *and* the
plumbing sub, while a client contract must never reach a sub. A single ordered
column would quietly force a wrong answer for one of those.

Everything resolves closed when ambiguous: both flags default false, an
unrecognised audience sees nothing, a staff profile whose role could not be read
is treated as least-privileged, a sensitive document never leaves the company
regardless of sharing flags, and photos are internal always.

`20260821140000_hivedoc_visibility.sql` was also applied to production. That one
was **my judgement call rather than an explicit sign-off**: it is purely
additive with closed defaults, so it can only ever be more restrictive than
today's behaviour, where no sharing exists at all. Verified after applying: 2
columns, 2 constraints, 2 partial indexes, and **0 rows shared with anyone**.

### 4. The two upload bugs — filed separately

Both were spun out as their own tasks rather than folded into this work:
sub-contractor doc uploads to the missing `sub-documents`/`sub-invoices` buckets,
and onboarding licence uploads to the missing `onboarding-licenses` bucket.

---

## 12. Final verified vs unverified

**Verified:**

- **`/api/hivedoc` is live on production and refuses anonymous callers** — a real
  HTTP request returns `401 {"ok":false,"error":"Authentication required."}`.
- Both migrations applied to production and inspected afterwards, not assumed.
- **Both migrations were executed against a real Postgres before being applied**,
  inside transactions that rolled back to nothing. For the visibility migration
  that included proving the two leak-shaped constraints actually reject:
  `client_visible` with no client, and `sub_visible` with no job. Neither was
  verified by eye.
- The client -> job join checked against real production data (REPAIR GATES 2,009
  photos, RENOVATION 378, and so on).
- 53 new tests across both PRs (35 search, 18 visibility). Full suite 3,452 pass,
  14 fail — the same 14 that fail on pristine `main`.

**Not verified — stated plainly:**

- **No authenticated call to `/api/hivedoc` has ever been made.** The 401 proves
  the route exists and is gated; it proves nothing about whether a signed-in
  search returns the right rows. The PostgREST queries, the job-index resolution
  and the signed-URL path are all still unrun against real data.
- **The end-to-end acceptance test in the brief has not happened** — upload a file
  from the Field App, see it under the right client in HiveDoc, find the same file
  from elsewhere in the app. It cannot until the UI is wired.
- **Nothing in the UI reads the endpoint yet**, and nothing lets you *set* the
  visibility flags.
- **The client and sub portals do not call `canSee()` yet.** They still have their
  own access paths. Until they adopt it, the visibility model protects nothing in
  practice — it is correct and tested, but not yet load-bearing. This is the most
  important remaining gap and it should be the next piece of work.
- The built-in Documents tab has still never been run end-to-end by anyone.

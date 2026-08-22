# Dev To-Do — show who resolved each item

**Branch:** `feature/devtodo-resolved-by` (rebased onto `origin/main` @ `150b0561`)
**Date:** 2026-08-18
**Worktree:** `C:\Users\Chris\Desktop\_wt_devtodo_resolvedby` (isolated — the shared mainwork tree was not touched)
**Git identity:** `c_kendall@icloud.com` / `csk5369` · pushed over SSH · PR only, nothing merged

> Replaces the previous per-task REPORT.md (real job form + line items, merged 2026-08-18).

> **Rebased three times on 2026-08-18** as `main` moved underneath this branch —
> past #461-#463, then past **#421 (Dev To-Do: assignments, due dates, resolved
> toggle, high alerts)** which lands in the same feature, then past #465. Only
> the #421 rebase involved real overlap (see *Overlap with #421*); the other two
> conflicted **solely on the generated page-build id** — see *The page-build id
> guarantees a conflict* at the end. Every number here is from a re-run on the
> final base, not carried over.

---

## ⚠️ One thing needs your decision — read this before merging

**The migration is not applied.** I wrote the `.sql` and left it for you to run —
see *SQL for you to run* at the bottom. Everything else is merge-ready.

**Separately: all 112 currently-resolved findings on production will read
"Unknown" unless you also run an optional backfill.** The brief said to show
"Unknown" for items resolved before this change, and that is what I built. But
while checking production I found something the brief could not have known, and
it changes what the honest answer is for those 112 rows. Details and the exact
one-line SQL are in *The 112 existing rows* below. Your call, not mine.

---

## What changed

| Area | File | What |
|---|---|---|
| Schema | `supabase/migrations/20260819020000_app_status_findings_resolved_by.sql` (new) | Adds `resolved_by uuid` to `app_status_findings` |
| Write | [api/_lib/status-hub.js:159](api/_lib/status-hub.js:159) | Closing a finding stamps the signed-in user; reopening clears it |
| Read | [api/_lib/status-hub.js:134](api/_lib/status-hub.js:134) | Resolves those ids to display names in one batched `profiles` lookup |
| UI | [public/index.html:6016](public/index.html:6016) | Renders `Resolved by Jomell — Aug 18` under each closed item |
| Tests | `test/app-status-hub.test.mjs` | +8 tests |

There was **no existing `resolved_by` column** — I checked the repo schema and
queried production directly. Confirmed absent in both.

### Why not just use `updated_by`, which already exists?

`updated_by` is the *last person to touch the status*, whatever they changed it
to. Reopen a resolved finding and `updated_by` becomes the reopener — so as a
permanent record of "who fixed this" it is wrong the moment anything is
reopened. `resolved_by` is written **only** on a move into `resolved`/`ignored`
and nulled on a move back out, exactly mirroring the `resolved_at` column that
already sits next to it. Both columns now always describe the *current* closure.

### Migration number

The brief asked me to verify against both. I did:

- **Repo `sql/` folder** — highest is `089_division_service_areas.sql`, but that
  convention was **retired on 2026-08-02**. `MIGRATIONS.md` names
  `supabase/migrations/` as the source of truth, and every schema change since
  has gone there. I followed the live convention, not the dead one.
- **Repo `supabase/migrations/`** — highest is `20260818210000_job_line_items`.
- **Live production ledger** (`list_migrations` against `sqhusuuhlmcmkeowdrga`) —
  highest is `20260819010252_drop_monitoring_required`, i.e. **production is
  ahead of the repo**. Numbering off the repo alone would have produced an
  out-of-order file.

So: **`20260819020000`**, above both. That mattered — checking only the repo
would have been wrong here.

---

## The 112 existing rows

Production has **112 resolved findings**, and **all 112 have `updated_by` set.**

The brief assumed older items simply have no recorded resolver, so "Unknown" is
the truthful answer. For a *currently resolved* row that assumption is more
pessimistic than the data warrants, and here is why: `updated_by` is written by
exactly one function, `setFindingStatus`, and only ever on a status change. If a
row's status is `resolved` right now, then the most recent status change set it
to `resolved` — and stamped `updated_by` in the same write. So for these 112,
`updated_by` **is** the resolver. It is not a guess and it is not a fake name.

That is not true in general — it breaks as soon as a row is reopened — which is
why the going-forward code uses a dedicated column rather than reading
`updated_by`. But as a one-time backfill of rows that are resolved *today*, it
is accurate.

**I did not backfill**, because the brief explicitly asked for "Unknown" rather
than an invented attribution, and because a top-level `UPDATE` is refused by
`scripts/check-migration-replay-safety.mjs` and would need a `hl:replay-safe`
marker to get through. Shipping as-is means 112 items read "Unknown" from day
one. Running the optional SQL below names all 112. **Your call** — both are
defensible, and I did not want to make it silently.

---

## Overlap with #421

While this was being verified, **#421 (Dev To-Do: assignments, due dates,
resolved toggle, high alerts)** merged into `main`. It touches the same three
files. Worth stating plainly, since it changes what some of this rests on:

- **No duplicated work.** #421 does **not** add a resolver — I checked its full
  diff for `resolved_by`. The two changes are complementary.
- **`listFindings` and `setFindingStatus` are untouched by #421**, so the
  backend half of this rebased with no logical conflict at all. The only real
  conflicts were the generated page-build id and this report.
- **One behavioural change I had to adapt to:** #421 replaced the Resolved
  *tab* with a `devTodoShowResolved` toggle — closed findings are now revealed
  inline as dimmed rows in the same list rather than living in a second tab.
  The resolver line keys off the finding's own `status`, not any list-level
  view state, so it was already correct under the new model; I updated the
  comment and test name that still said "Resolved tab", and added an assertion
  that the resolver line never reads `devTodoShowResolved`.
- **Re-verified, not assumed:** the render check below was re-run against the
  merged `devTodoFindingsHtml`, with the toggle both on and off.

**One thing for you to glance at, unrelated to this PR:** #421's migration is
numbered `20260818190000_devtodo_assignment_and_due_date.sql`, and the repo
already has a `20260818190000_monitoring_one_permission.sql`. Two files sharing
a version is the kind of thing that bites later on a fresh install. I have not
touched it — flagging only.

---

## Verified

Each claim below is something I ran, not something I expect.

**Migration, against a real throwaway PostgreSQL 18 cluster** (own `initdb`, not
production). Applied the base `app_status_hub` migration, then mine:

- Applies cleanly. Running it a **second time** is a no-op (`NOTICE: column
  "resolved_by" ... already exists, skipping`) — safe to re-run.
- Column lands as `resolved_by | uuid | nullable`.
- FK `app_status_findings_resolved_by_fkey` has `confdeltype = 'n'` (SET NULL) —
  matching the existing `updated_by` FK.
- Behaviour proven, not assumed: inserted a closed finding, deleted the user
  row, and the column went to `NULL` rather than blocking the delete.
- Grants unchanged — `service_role` only; `anon`/`authenticated` still have none.
- `node scripts/check-migration-replay-safety.mjs <file>` → exit 0.

**UI**, by extracting the shipped `devTodoFindingsHtml`/`devTodoResolverHtml`
from `public/index.html` and running them on sample findings:

```
Named resolver      => Resolved by Jomell — Aug 18
Legacy, pre-change  => Resolved by Unknown — Aug 10
XSS attempt         => Ignored by &lt;img src=x onerror=alert(1)&gt; — Aug 17
Closed, no date     => Resolved by Chris
```

— so: the name renders, a missing resolver reads **Unknown** (not blank, not
invented), `ignored` says "Ignored by", a resolver name is HTML-escaped like
every other server string on the card, and a missing date drops the dash rather
than printing "Invalid Date". Open items get no resolver line, and no open item
leaks into the Resolved tab.

**Tests:** `npm test` → **3154 tests, 3138 pass, 14 fail**.
Baseline on clean `origin/main` @ `d20a930d` (checked out, same command) →
**3146 tests, 3130 pass, 14 fail**. **Same 14 failures, same 10 files, before
and after** — all
pre-existing on `main` and unrelated (ad-campaign/marketing/mail/documents
contract tests that need credentials or npm deps this machine doesn't have).
My 8 new tests are the entire delta and all pass. **Zero regressions.**

`node scripts/stamp-page-build.mjs --check` → clean (`98bdb726f2c603fd`).

**CI on the PR: all five checks green** — *Full regression (required for DONE)*,
*Schedule board UI (real browser)*, *Mergeable with the base branch*, and both
Vercel checks. That also settles the 14 local failures above: CI's full
regression passes, so they are this machine missing credentials and npm deps,
not real breakage.

## Not verified

- **Not run in the live app.** I did not sign in to production and click an item
  to Resolved. The write path is covered by tests driving the real
  `setFindingStatus` against a stubbed PostgREST, and the render path by running
  the real page function — but nobody has seen this in a browser yet.
- **The migration has not been applied anywhere but my throwaway cluster.**
- **No screenshot.** The rendering evidence above is text output from the page's
  own function, not a picture of the running app.

---

## SQL for you to run

**1. Required — the migration.** Supabase → SQL Editor → New query → paste → Run.
File is `supabase/migrations/20260819020000_app_status_findings_resolved_by.sql`.

```sql
alter table public.app_status_findings
  add column if not exists resolved_by uuid references auth.users(id) on delete set null;

comment on column public.app_status_findings.resolved_by is
  'Signed-in user who moved this finding into resolved/ignored. Null for findings closed before 2026-08-18 or reopened since.';
```

Safe to run more than once. If it runs before the code deploys, nothing breaks —
the column is simply unused until then.

**2. Optional — name the 112 existing resolved items.** Run this *after* step 1,
only if you want them attributed instead of reading "Unknown". Not a migration
file on purpose, so nothing applies it automatically.

```sql
update public.app_status_findings
   set resolved_by = updated_by
 where status in ('resolved', 'ignored')
   and resolved_by is null
   and updated_by is not null;
```

## Deploy-order note

The code can go live before you run step 1. If it does, a status change would
normally fail on the unknown column — so `setFindingStatus` detects that one
specific PostgREST error (`PGRST204` / `42703` naming `resolved_by`) and retries
once without the field. In that window the finding still closes correctly and
only the attribution is lost. A genuine failure is **not** swallowed: it still
throws, and there is a test holding that line
([api/_lib/status-hub.js:185](api/_lib/status-hub.js:185)).

---

## The page-build id guarantees a conflict (worth a look, separately)

Two of the three rebases here had **no code conflict at all** — the only
colliding line was the generated build id, in both `public/index.html` and
`api/_lib/page-build.js`:

```
var HL_PAGE_BUILD = '<16 hex chars>';
export const PAGE_BUILD = '<16 hex chars>';
```

Because the id is a hash of `index.html` **plus 60 assets**, *every* PR that
touches any of them rewrites that same line — so any two such PRs conflict by
construction, no matter how unrelated their actual changes are. #460 ("stop the
page build id costing a merge every time it changes") reduced the churn but did
not remove this: two open PRs still cannot both carry a stamp.

It is mechanical to resolve (take `main`'s side, re-run
`scripts/stamp-page-build.mjs`) but it forces a rebase-and-full-reverify cycle on
whichever PR merges second, and on a busy day that can be a losing race. Not
touched here — flagging as a papercut worth its own fix, e.g. stamping in CI on
merge rather than in the committed file.

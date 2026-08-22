# Command Center Bundle — Phase 2 (2026-08-04)

Branch: `feature/command-center-bundle-phase2` (off `origin/main` @ `22b61f4`)
Builds on Phase 1 (shipped 2026-08-02), which bundled the first 5 Command
Center resources into one `cc_bundle` round trip.

## What shipped

Grew the existing `cc_bundle` endpoint from **5 → 7** Command Center resources,
folding two more standalone track1 requests into the single shared fetch that
already fires on Command Center load. Same additive pattern as Phase 1 — the
bundle calls the exact same handler functions the standalone `resource=*`
requests use, via `ccCaptureJson`'s fake `res`, so every handler's internal
logic is completely untouched. Nothing in rendering or error handling changed.

### Newly bundled resources

| Resource | Handler (untouched) | Command Center caller rewired |
|---|---|---|
| `leads` | `handleLeads(req, res)` | `loadLeadsLive` |
| `crew_schedule` | `handleCrewSchedule(res)` | `loadTechLocationsLive` (CC map fleet layer) |

`handleLeads` takes `(req, res)`, so — exactly like `handleJobWorkflowList` in
Phase 1 — the bundle threads the real `req` through: `handleLeads(req, r)`. Its
GET branch reads only auth + method off `req` (no query params), and the bundle
request is always GET, so it fits cleanly. `handleCrewSchedule` takes `(res)`
only.

## Deliberately NOT bundled — `watching_unscheduled` + `watching_margin_fade`

This is the load-bearing decision of Phase 2, so it is documented first.

An earlier draft of this slice bundled these two as well (5 → 9). That was
**backed out** before shipping because it re-introduces a known, already-fixed
regression:

- `handleWatchingUnscheduled` is a **fast** Jobber-via-Supabase read (a single
  Supabase query for unscheduled jobs).
- `handleWatchingMarginFade` cross-references **QBO job costing**. Its own source
  comment records the *"Perf fix (2026-07-31)"* — the QBO scan behind it *"used
  to run LIVE on every cold serverless start — 10-15s of QuickBooks
  pagination."*

The entire mechanism of the bundle is that `ccBundleFetch('<key>')` resolves
only once the single server-side `Promise.all` resolves — i.e. after its
**slowest** member. Folding both watching resources into the bundle would mean
the fast unscheduled count (rendered by `loadWatchingLive` and
`loadJobsAttention`) can no longer paint until the slow QBO margin-fade call
finishes. That is exactly why the two were split into **independent** fetches on
**2026-07-31** in the first place. Bundling them would silently undo that fix.

So they stay standalone by design:

- `loadWatchingLive` keeps its own `fetch(...resource=watching_unscheduled)` and
  `fetch(...resource=watching_margin_fade)`. Only its `watching_bridge_status`
  fetch rides the bundle (that was already true in Phase 1).
- `loadJobsAttention`'s `attnFetch(resource)` keeps its own standalone track1
  fetch, so its two signals render independently.

The endpoint and frontend test suites both assert these two resources are **not**
in the bundle, so the regression cannot silently creep back in later.

### Backend — `api/track1.js` `handleCcBundle`

Added two more `ccCaptureJson(...)` entries (`leads`, `crew_schedule`) to the
same `Promise.all` set and two more keys to the response envelope. All 7
handlers still run concurrently; a single handler throwing is still captured
per-resource as an honest `{ ok:false, error }` and never breaks its 6 siblings.

### Frontend — `public/index.html`

Two call sites rewired from standalone `fetch()` / `hlApiGet()` to
`ccBundleFetch('<key>')`:

- `loadLeadsLive` — replaced `hlApiGet('leads')`.
- `loadTechLocationsLive` — the Command Center map's fleet layer only. The Job
  Schedule / crew-board pages keep their own standalone `crew_schedule` fetch.

`ccBundleFetch` shares one in-flight `cc_bundle` request across every caller in
the same 2-second window, so these collapse onto the one HTTP round trip
Command Center was already making. `loadTechLocationsLive` fires slightly later
from inside `loadMapLive`'s `.then`; within the window it reuses the same
bundle, otherwise it triggers at most one fresh bundle — never more calls than
the standalone fetch it replaced.

## Call-count impact

Standalone Command Center-load API calls removed by Phase 2:

| Resource | Callers on CC load | Calls removed |
|---|---|---|
| `leads` | 1 | 1 |
| `crew_schedule` | 1 | 1 |
| **Total** | | **2** |

Those 2 round trips are now served for free inside the one `cc_bundle` request
that Command Center was already making. Combined with Phase 1's −4 (5 calls → 1),
Command Center initial load is a net −6 round trips vs. pre-bundle. The two
watching resources are intentionally left as 2 independent calls to preserve
their independent, non-blocked rendering (see above).

## Scope boundary — other resources deliberately NOT bundled

Per the Phase 2 brief's "if it doesn't cleanly fit, leave it out and note why":

- **`/api/jobs`** (Jobs Board, job health ticker, `loadJobsLive`) — a separate
  endpoint with per-caller pagination/status params (`?limit=500`,
  `?status=active&limit=1000`), not a track1 resource. Left standalone (this
  matches the Phase 1 decision already asserted in the frontend test).
- **Financials widget** (`loadFinancials`, `loadFinancialLive`, `loadOwed`,
  `loadOpenItems`, `loadApOverdue`) — sourced from `/api/qbo` and `/api/snapshot`,
  separate endpoints, not track1. Cannot join the track1 bundle.
- **Clients widget** (`loadClientsLive`) — `/api/clients`, a separate endpoint
  returning ~8k rows, loaded once and cached client-side. Wrong shape for a
  per-load bundle.
- **`quotes` / `visits`** (`loadIncoming`, `loadScheduleLive`) — track1
  resources but carry per-caller `limit` params, so they don't share one
  canonical response the way the bundled resources do.

## Tests (real invocation only — no mocked results)

Extended both existing `vm.createContext` suites (no new test files needed):

- `test/marketing-cc-bundle-endpoint.test.mjs` — now exercises all 7 real
  handlers: correct signatures (`req`+`res` for `job_workflow_list` **and**
  `leads`, `res`-only for the other 5), all 7 keys merged, 7-way concurrency,
  and a Phase-2 resource (`crew_schedule`) throwing without taking `leads` down
  with it. Adds an explicit regression guard that `watching_unscheduled` and
  `watching_margin_fade` are **not** invoked in the bundle and have no envelope
  key.
- `test/marketing-cc-bundle-frontend.test.mjs` — asserts `loadWatchingLive`
  routes only `watching_bridge_status` through the bundle and keeps the two
  watching resources as independent standalone fetches; asserts
  `loadJobsAttention`'s `attnFetch` stays standalone; and adds regression guards
  for `loadLeadsLive`, `loadTechLocationsLive`, plus a guard that a non-CC
  `crew_schedule` fetch remains standalone (proves the rewire was scoped).

### Results

- `npm test` — **1221 passed, 0 failed, 2 skipped** (1223 total).
- `npm run test:smoke` — 19 passed, 2 failed. Both failures
  (`GET /api/chat` wrong-method → 401 not 405; `/api/jobber/sync-extended`
  missing counts) run **anonymously against deployed production**
  (`hivelogic-live.vercel.app`), are pre-existing, and are unrelated to this
  change — they touch neither `cc_bundle`, track1 dispatch, nor the Command
  Center, and the deployed code under test does not include this branch.

## Files

- `api/track1.js` — `handleCcBundle` extended (wrap-only, handlers untouched).
- `public/index.html` — 2 call sites rewired to `ccBundleFetch`.
- `test/marketing-cc-bundle-endpoint.test.mjs`
- `test/marketing-cc-bundle-frontend.test.mjs`

Branch pushed. **Not** merged to `main` — that's Chris's call.

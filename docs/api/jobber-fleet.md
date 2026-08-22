# Jobber & Fleet API Reference

Jobber is Greenwich Handyman's field-service CRM — the source of truth for
clients, jobs, invoices, quotes, requests, visits, and schedule — synced into
HiveLogic's own Supabase tables via a mix of scheduled pulls, webhooks, and a
one-time OAuth connection. FleetSharp is a separate GPS-tracking vendor that
feeds real-time vehicle positions into HiveLogic independently of Jobber's own
(also real, also live) vehicle-tracking feature. This doc covers the Jobber
OAuth/sync surface and the Fleet vehicle-tracking surface built on top of it.

## Jobber OAuth & Sync

### `GET /api/jobber/connect`
**Auth:** `requireApiAuth` — must be a signed-in employee (valid Supabase
session) or a valid `CRON_SECRET` bearer. Unauthenticated callers get a 401
telling them to sign in first.
**Purpose:** Starts the Jobber OAuth authorization flow (or, with
`?status=1`, reports the current connection's health) — this is the only
route that *begins* the OAuth handshake; `callback.js` only receives it.

**Request body / query params:**
- `status` (string, optional) — pass `status=1` to get a JSON connection-health
  check instead of starting the OAuth flow.

**Response:**
- `?status=1`:
```json
{ "ok": true, "connected": true, "updatedAt": "2026-08-20T10:00:00.000Z", "expiresAt": "2026-08-20T11:00:00.000Z" }
```
- Default (no `?status=1`): a redirect (302) to Jobber's authorize URL. If the
  request's `Accept` header includes `application/json`, returns the URL
  instead of redirecting, so a same-origin `fetch` caller can navigate the top
  window itself:
```json
{ "ok": true, "url": "https://api.getjobber.com/api/oauth/authorize?..." }
```
- Missing `JOBBER_CLIENT_ID`: `500`, plain HTML error text (not JSON).

Notes: Issues a random, single-use, 10-minute OAuth `state` token bound to the
calling user (via `issueOAuthState`), replacing an old static
`state:'hivelogic-live'` value that made the callback CSRF-able. Was added
2026-07-16 after the original stored Jobber refresh token started failing on
every refresh attempt in production — visiting this route re-authorizes with
Jobber and `callback.js` stores the new token pair, the same way the original
one-time setup worked.

---

### `GET /api/jobber/callback`
**Auth:** None in the session sense — this is the public OAuth redirect
target Jobber itself calls, on the guard's public allowlist
(`/api/jobber/callback`). It authenticates the *request* by validating the
one-time `state` token (via `consumeOAuthState`, provider `jobber`) rather
than a signed-in session; an invalid, missing, expired, or reused state is
rejected before the authorization `code` is ever used.
**Purpose:** Receives Jobber's OAuth redirect, exchanges the authorization
code for an access/refresh token pair, and stores them (encrypted) in
Supabase.

**Request body / query params:**
- `code` (string, required unless `error` is present) — the one-time
  authorization code from Jobber.
- `error` (string, optional) — present if the user declined/Jobber errored;
  short-circuits straight to an error redirect.
- `state` (string, required) — the single-use OAuth state issued by
  `connect.js`; consumed (invalidated) on this call.

**Response:** Always a redirect (302), never JSON:
- Success: redirect to `/?connected=jobber`
- Errors: redirect to `/?jobber_error=<reason>`, where `<reason>` is one of
  the literal Jobber `error` value, `invalid_state_<reason>`,
  `token_exchange_failed`, `storage_failed`, or `unexpected`.
- Missing `code` with no `error`: `400` plain text, `"Missing authorization
  code from Jobber."`

Notes: Exchanges the code at `https://api.getjobber.com/api/oauth/token`
using `JOBBER_CLIENT_ID`/`JOBBER_CLIENT_SECRET`/`JOBBER_REDIRECT_URI`. Falls
back to a 3600s (60 min) token lifetime if Jobber's response omits
`expires_in`. Tokens are encrypted with `encryptSecret` before being
upserted into the `integrations` table (`key: 'jobber'`) — access/refresh
tokens are never exposed to the browser.

---

### `POST /api/jobber/sync`
**Auth:** `checkCronSecret` — `Authorization: Bearer <CRON_SECRET>` only (no
`?key=` fallback), timing-safe compare, fails closed if `CRON_SECRET` is
unset. Runs on Vercel Cron (see `vercel.json`); manual/on-demand runs must
supply the same bearer. Not method-restricted in code (Vercel Cron issues
GET; the handler itself doesn't branch on `req.method`).
**Purpose:** Pulls clients, jobs, and invoices from Jobber's GraphQL API and
upserts them into the matching Supabase tables — the hourly full-sync
reconciliation pass (the near-real-time path is `webhook.js`).

**Request body / query params:**
- `resource` (string, optional) — one of `clients`, `jobs`, `invoices`. Omit
  to sync all three in one request.

**Response:**
```json
{ "ok": true, "synced": ["clients", "jobs", "invoices"], "counts": { "clients": 25, "jobs": 25, "invoices": 25 }, "duplicatesDropped": { "clients": 0, "jobs": 0, "invoices": 0 }, "truncated": [], "ms": 4213 }
```
On failure: `{ "ok": false, "error": "..." }` (500).

Notes: Each resource paginates independently (`PAGE_SIZE=25`) and stops
~40s before Vercel's 300s function limit (`TIME_BUDGET_MS=260000`) rather
than at a fixed record count; an unfinished pagination cursor is persisted
per-resource in `sync_cursors` so the next run resumes instead of
re-fetching page one forever (logged as `sync_log` status `"partial"`; a full
pass logs `"success"` and resets the cursor). Clients also sync `phones` into
`clients.phone_e164` (normalized to E.164) for HiveLogic Phone's caller
recognition. Invoice amount fields are `amounts.total/subtotal/depositAmount/
discountAmount/paymentsTotal` — confirmed against Jobber's actual
`InvoiceAmounts` type via a live schema error, not the field names the docs
might suggest. Every upserted row also gets an `external_refs` mapping
(`system: 'jobber'`) kept in sync as new records land, best-effort (a failure
there never fails the sync itself).

---

### `POST /api/jobber/sync-extended`
**Auth (top-level):** `checkCronSecret` bearer by default (`Authorization:
Bearer <CRON_SECRET>`), same fail-closed rule as `sync.js`. The `geocode`
resource additionally accepts a signed-in staff/admin session
(`requireStaff`) as an alternative to the cron secret, since it's a
non-destructive maintenance action. **The `fleetsharp_push` resource is
checked before any of this and uses a completely different auth model — see
its own subsection below.**
**Purpose:** Extends the Jobber sync with additional resource types beyond
clients/jobs/invoices, plus two maintenance actions (`geocode` and the
inbound FleetSharp GPS webhook) that live in this file to stay under
Vercel's Hobby-plan function-count cap.

Routing is entirely via `?resource=`. Each named resource below is
independently try/caught — one bad/unverified GraphQL field only fails that
resource, not the whole request — and is documented as its own subsection.

**Request body / query params (shared):**
- `resource` (string, optional) — one of `quotes`, `requests`, `visits`,
  `expenses`, `timesheets`, `users`, `vehicles`, `locations`, `geocode`,
  `fleetsharp_push`. Omitting it syncs every resource above except `geocode`
  and `fleetsharp_push` (those are explicit-only maintenance/webhook
  actions).

**Response (Jobber-resource sync, e.g. no `resource` or `resource=quotes`):**
```json
{ "ok": true, "synced": ["quotes", "requests", "visits", "expenses", "timesheets", "users", "vehicles", "locations"], "counts": { "quotes": 12 }, "truncated": [], "errors": { "expenses": "Field 'reimbursableToUser' doesn't exist on type 'Expense'" }, "ms": 5001 }
```
`ok` is `true` unless every requested resource errored; a response with some
resources failing still returns HTTP `207`. Also writes a `sync_log` row
(`source: 'sync_extended'`, status `success`/`partial`/`error`) — this file
had no durable trace at all until 2026-08-07, unlike `sync.js`.

#### Resource: `quotes`
Syncs Jobber quotes into the `quotes` table (`quote_number`, `title`,
`quote_status`, `total`, `client_id`, `client_name`, `jobber_web_uri`,
timestamps). Field shape was live-verified against the real account; only
`jobberWebUri` (added 2026-08-10) is unverified.

#### Resource: `requests`
Syncs Jobber requests into the `requests` table (`title`, `request_status`,
`client_id`, `jobber_web_uri`, timestamps) — good-faith field names, not yet
live-verified. Also drives the sales pipeline: after each requests sync,
`createOpportunitiesForNewRequests()` opens a `lead_pipeline` card for any
new, still-open request (stage `request` or `estimate_booked` depending on
`request_status`), and `closeOpportunitiesForConvertedRequests()` moves any
open pipeline card whose linked request has since turned `converted` to
stage `won`. Both are one-way from Jobber and never touch a card a human
already marked `won`/`lost`; both are best-effort no-ops if the
`lead_pipeline.request_id` column (migration `20260818120000`) isn't applied
yet.

#### Resource: `visits`
Syncs Jobber visits into the `visits` table: `title`, `start_at`, `end_at`,
`completed_at`, `is_all_day`, `client_id`, `job_id`, `visit_status`,
`assigned_users` (JSON array of `{id, name}`, real crew), `arrival_window_start`/
`arrival_window_end`. Field shape was corrected 2026-07-16 after a live
schema error (`isAllDay` doesn't exist — Jobber suggested `allDay`; `Visit`
has no `jobberWebUri` or `updatedAt`), so both those columns are always
written as `null`. `assignedUsers`/`arrivalWindow` were added and confirmed
live 2026-07-18.

#### Resource: `expenses`
Syncs Jobber expenses into the `expenses` table (`title`, `total`,
`expense_date`, `reimbursable_to_user`, `jobber_created_at`). Good-faith,
corrected twice against live schema errors: `reimbursableToUser` doesn't
exist (real field is `reimbursableTo`), and `reimbursableTo` is a `User`
object, not a scalar, so it's stored as a boolean flag
(`reimbursable_to_user: !!e.reimbursableTo`) matching the Supabase column's
boolean type. `job_id` is always `null` — `Expense` has no confirmed job
relation.

#### Resource: `timesheets`
Syncs Jobber `timeSheetEntries` into `time_sheet_entries` (`start_at`,
`end_at`, `final_duration`, `user_id`, `job_id`, timestamps). Good-faith
field names, not yet live-verified.

#### Resource: `users`
Syncs Jobber users into the `users` table (`name`, `email`,
`available_for_scheduling`, `status`, `assigned_vehicle_id`,
`assigned_vehicle_name`, `jobber_created_at`). `availableForScheduling`/
`status` confirmed live 2026-07-18 against 61 real crew members.

#### Resource: `vehicles`
Syncs Jobber's own built-in fleet GPS (`Vehicle.liveState.currentPosition`)
into the `vehicles` table: `name`, `make`, `model`, `year`,
`license_plate`, `vin`, `icon_color`, `status`, `speed`, `latitude`,
`longitude`, `gps_updated_at`. Confirmed live 2026-07-18 against all 10 real
fleet vehicles (real Greenwich, CT coordinates). This does not require
FleetSharp — Jobber already has GPS built in — but as of 2026-08-11 Jobber's
own upstream connection to FleetSharp can go stale, which is what the
`fleetsharp_push` resource below exists to work around. Vehicle-to-technician
linkage is confirmed *not* configured in this Jobber account (checked all 61
users), so `vehicles` is a standalone "where are our trucks" feed, not yet
joinable to a specific crew member via this sync.

#### Resource: `locations`
Syncs Jobber client billing addresses into `client_locations` (`street`,
`city`, `province`, `postal_code`, `country`) — feeds the service-area map.
`billingAddress { street city province }` was confirmed live;
`postalCode`/`country` are the same field family but not independently
re-verified. Coordinates (`lat`/`lng`) are filled in separately by the
`geocode` resource, not by this one.

#### Resource: `geocode`
**Auth:** `checkCronSecret` bearer **or** a signed-in staff/admin session
(`requireStaff`) — the only resource on this endpoint that accepts a normal
user session as an alternative to the cron secret, added so someone could
run it on demand without touching the shared `CRON_SECRET`.
**Purpose:** Not a Jobber resource — a maintenance action that reads
already-synced `client_locations` rows with a `street` but no `lat`/`lng`
and geocodes them, two-tier: Nominatim/OpenStreetMap first (rooftop-grade
only — a street-centerline or town-centroid hit is rejected and falls
through), then the US Census geocoder (street-interpolated) as a fallback.
Rate-limited to Nominatim's 1 req/sec policy. Skips rows with
`geocode_locked = true` (a human fixed the pin).

**Response:**
```json
{ "ok": true, "action": "geocode", "attempted": 500, "processed": 500, "geocoded": 480, "viaNominatim": 350, "viaCensus": 130, "noMatch": 15, "skippedLocked": 3, "writeErrors": 0, "firstWriteError": null, "remaining": false, "ms": 210344 }
```

Notes: Also geocodes the office HQ address once (`office_location` id `hq`)
via Census, if not already set. As of 2026-08-19, a write failure (failed
`PATCH`) is counted separately from a genuine geocode miss (`writeErrors`/
`firstWriteError`) — previously a failing write looked identical to success,
which is why `client_locations.geocoded_at` silently sat frozen for 17 days
while the job kept reporting normal-looking progress.

#### Resource: `fleetsharp_push`
**Auth: genuinely different from every other endpoint in this document.**
This is FleetSharp's own inbound GPS "Push API" — FleetSharp POSTs to this
URL on its own schedule whenever a device reports, so it can never carry a
signed-in Supabase session or `CRON_SECRET`. It is authenticated purely by a
bearer token this system generated and handed to FleetSharp, checked via
`checkBearerSecret(authHeader, process.env.FLEETSHARP_PUSH_SECRET)`. Both a
literal `Authentication` header and a normal `Authorization` header are
accepted (FleetSharp's own PDF spec names the header `Authentication`, which
is nonstandard). This check happens *before* the cron-secret gate above
(`resource=fleetsharp_push` is handled and returned immediately at the top
of the handler) and is separately allowlisted at the edge guard
(`api/_lib/guard.js`, `PUBLIC_RESOURCE_PATHS`) since it can carry neither a
user session nor the cron secret.
**Purpose:** Public webhook, authenticated via `FLEETSHARP_PUSH_SECRET`.
Receives live GPS pushes from FleetSharp and writes them into
FleetSharp-specific shadow columns on `vehicles` (matched by VIN) — this is
the fix for Jobber's own `Vehicle.liveState.currentPosition` going stale
when Jobber's upstream FleetSharp connection failed. `track1.js`'s
`handleCrewSchedule` picks whichever of the Jobber-sourced or
FleetSharp-sourced columns has the newer timestamp per vehicle, making
FleetSharp "primary, Jobber fallback" in practice.

**Request body / query params:**
- `resource=fleetsharp_push` (required, query param, selects this mode)
- Body: a single push object or an array of them. Each item:
  - `pushType` (string, required to be `"POSITION"` — other types like
    `FENCE_EVENT`/`STOP`/`USAGE_HOURS`/`TRIP`/`ALERT`/device-update are
    accepted/acknowledged but otherwise ignored)
  - `vin` (string, required) — matched against `vehicles.vin`; no match is
    silently acknowledged and dropped (this is an enrichment layer, not the
    source of truth for which vehicles exist)
  - `latitude` / `longitude` / `speed` (number, optional)
  - `currentState` (string, optional)
  - `date` or `formattedDate` (string, optional) — push timestamp; falls
    back to server receive time if both are absent

**Response:**
```json
{ "ok": true, "received": 3, "updated": 2, "skipped": 1 }
```
Method other than POST: `405 { "ok": false, "error": "FleetSharp push endpoint accepts POST only." }`. Bad/missing bearer: `401 { "ok": false, "error": "Invalid or missing FleetSharp push token." }`.

Notes: Always responds `201` on a processed (even partially skipped) batch,
per FleetSharp's spec, so it isn't retried. Uses
`Prefer: return=representation` on the PATCH specifically so a VIN with zero
matching rows can be distinguished from a real update (an earlier
`return=minimal` version couldn't tell the difference and silently
overcounted "updated").

---

### `POST /api/jobber/webhook`
**Auth:** Two independent per-mode gates on one path, dispatched by query
param before any auth check runs:
- Incoming webhook (no `drain`/`cleanup` query param): HMAC-SHA256 signature
  over the raw request body, keyed with `JOBBER_CLIENT_SECRET` (the same
  secret OAuth token refresh uses), header `X-Jobber-Hmac-SHA256`, compared
  with `crypto.timingSafeEqual`. Public — on the guard's public allowlist
  (`/api/jobber/webhook`) since Jobber itself calls it.
- `?drain=1`: `checkCronSecret` — `Authorization: Bearer <CRON_SECRET>` only.
- `?cleanup=1`: `CRON_SECRET` via either `Authorization: Bearer
  <CRON_SECRET>` or `?key=<CRON_SECRET>`.

**Purpose:** Near-real-time Jobber sync. Jobber pushes an event the instant a
client/job/invoice changes; this endpoint does the minimum synchronously
(verify signature, insert the raw event, ACK) so it stays under Jobber's
1-second response requirement, then a separate cron-driven drain does the
actual fetch-and-upsert work.

**Request body / query params:**
- Incoming webhook mode: raw JSON body, Jobber's `webHookEvent` envelope —
  `data.webHookEvent.topic` (string, e.g. `CLIENT_UPDATE`), `.itemId`
  (string), `.accountId` (string, optional), `.occurredAt` (string,
  optional). Body parsing is disabled (`config.api.bodyParser = false`) so
  the HMAC can be computed over the exact bytes Jobber sent.
- `drain` (query param, optional) — any truthy value runs the drain job
  instead of accepting a webhook.
- `cleanup` (query param, optional) — any truthy value runs retention
  cleanup instead.
- `key` (query param, optional) — alternate `CRON_SECRET` for `cleanup` only.

**Response:**
- Incoming webhook, success: `{ "ok": true }` (200)
- Incoming webhook, bad signature: `{ "ok": false, "error": "Invalid webhook signature" }` (401)
- Incoming webhook, unparseable/missing topic or itemId: `{ "ok": false, "error": "Unrecognized webhook payload" }` (400)
- Incoming webhook, failed to queue: `{ "ok": false, "error": "Failed to queue event" }` (500 — deliberately 500 so Jobber retries; at-least-once delivery plus idempotent upserts make retries safe)
- Not POST (and not `drain`/`cleanup`): `{ "ok": false, "error": "POST only" }` (405)
- `?drain=1`:
```json
{ "ok": true, "processed": 12, "deduped": 3, "errors": 0, "remaining_batch_full": false }
```
- `?cleanup=1`:
```json
{ "ok": true, "cutoff": "2026-07-22T00:00:00.000Z", "retention_days": 30 }
```

Notes: `drain` processes up to 40 pending `webhook_events` rows per run
(1-minute cron cadence keeps the backlog tiny), deduping bursts of repeat
events for the same record within a batch (only the newest fetch matters). A
`_DESTROY` topic deletes the row from Supabase by `jobber_id`; any other
topic fetches the full record from Jobber's GraphQL API by id and upserts it
using row-mapping functions that intentionally mirror `sync.js`'s
`mapClient`/`mapJob`/`mapInvoice` (there's a standing TODO to hoist these
into a shared `_lib/jobber-maps.js` so the two copies can't drift). If the
live record comes back missing (deleted between the event and the fetch),
it's treated the same as a `_DESTROY`. `cleanup` deletes `webhook_events`
rows with `status='done'` older than 30 days; `status='error'` rows are left
alone since those need a human look.

## Fleet / Vehicle Tracking

### `GET /api/fleet/detect-presence`
**Auth:** `requireApiAuth` — a valid `CRON_SECRET` bearer (Vercel Cron) or a
signed-in user session. Additionally gated by the `FLEET_ENABLED` environment
flag: if `process.env.FLEET_ENABLED !== 'true'`, the endpoint responds `200`
with `enabled: false` and does no work at all, rather than 404/401.
**Purpose:** Turns recorded truck GPS positions (`fleet_positions`) into
"truck was at job Y from `arrived_at` to `departed_at`" evidence intervals
(`fleet_job_presence`), by matching each vehicle's positions against job
sites with a visit scheduled around that time. Evidence only — no billing
and no alerts are triggered from this; Reina's `TIME_MISMATCH` feature
consumes it later, after human verification.

**Request body / query params:** None — the run parameters
(`POSITION_LOOKBACK_HOURS = 24`, `JOB_WINDOW_BUFFER_MS` = 3 hours,
`RADIUS_M = 150`) are fixed constants in the file, not request inputs.

**Response:**
```json
{ "ok": true, "enabled": true, "candidateJobs": 4, "checked": 6, "upserted": 3 }
```
Disabled: `{ "ok": true, "enabled": false, "note": "Fleet is disabled. Set FLEET_ENABLED=true to detect presence." }`
No scheduled visits/geocoded jobs in window: `{ "ok": true, "enabled": true, "candidateJobs": 0, "checked": 0, "upserted": 0, "note": "..." }`
Error: `{ "ok": false, "error": "..." }` (500)

Notes: Uses a ~150m (`RADIUS_M`) geofence radius as the "was this truck at
this job site" test. Candidate job sites are found by keying off
**`visits.start_at`/`visits.end_at`, not the parent job's own `start_at`/
`end_at`** — the code comments this explicitly as a fix: a job's own span
covers the whole multi-week project, so filtering on the job's own dates
silently excluded every multi-day job's visit scheduled for today (confirmed
in production against a "HALL BATH RENOVATION" job whose own `start_at` was
over a week stale while a real, geocoded visit was scheduled today).
`visits.job_id` matches `jobs.jobber_id`, the same join `track1.js`'s
`crew_schedule` uses. Re-derives all intervals from scratch every run; to
avoid creating duplicate rows for one continuous visit across runs (an issue
confirmed in production as ~9 near-duplicate rows for one visit), it tracks
the currently-open interval per `(vehicle_id, job_uuid)` (`status='present'`)
and `PATCH`es its `departed_at`/`status` forward rather than re-inserting.

---

### `GET /api/fleet/record-positions`
**Auth:** `requireApiAuth` — a valid `CRON_SECRET` bearer (Vercel Cron) or a
signed-in user session. Also gated by `FLEET_ENABLED`, same disabled-response
shape as `detect-presence.js`.
**Purpose:** Snapshots the live GPS already landing in `public.vehicles`
(written by the FleetSharp push webhook and/or the Jobber `vehicles` sync)
into the Fleet module's own history tables: an append-only
`fleet_positions` log and a compact `fleet_vehicle_latest` current-state row
per truck, for the Fleet map/UI. Runs on a Vercel cron every few minutes.

**Request body / query params:** None.

**Response:**
```json
{ "ok": true, "enabled": true, "checked": 10, "recorded": 4, "skipped": 6 }
```
Disabled: `{ "ok": true, "enabled": false, "note": "Fleet is disabled. Set FLEET_ENABLED=true to record positions." }`
No VIN-linked fleet vehicles yet: `{ "ok": true, "enabled": true, "checked": 0, "recorded": 0, "skipped": 0, "note": "No VIN-linked vehicles yet." }`
`fleet_vehicles` read failure: `{ "ok": false, "error": "Could not read fleet_vehicles.", "status": 502 }`
Unexpected error: `{ "ok": false, "error": "..." }` (500)

Notes: Reads `public.vehicles` but **never writes to it** — a locked design
decision that Fleet never touches the Jobber/FleetSharp mirror table, only
its own `fleet_*` tables. Idempotent: a position is appended only when
strictly newer than the last recorded `device_time` for that vehicle
(`shouldRecord`), so repeated cron ticks against an unmoved truck are
no-ops. `pickFreshestFix` picks whichever of the Jobber-sourced or
FleetSharp-sourced columns on `vehicles` is newer per vehicle — the same
"FleetSharp primary, Jobber fallback" resolution used elsewhere.

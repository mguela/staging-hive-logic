# Scheduling & Misc. Integrations

This document covers the HiveLogic-native scheduling surface
(`api/schedule/*.js`), two third-party OAuth integrations (Gusto payroll and
QuickBooks Online), and the self-test/crawler reporting surface plus one
adjacent (but distinct) autonomous QA runner and the separately-scoped
Visual Intelligence job-photo module. Where an endpoint routes multiple
operations through a `?resource=` (or `?action=`) query param, each distinct
operation is documented as its own subsection.

## Scheduling

### `GET /api/schedule/confirm`
**Auth:** Public. Authenticated by a 256-bit CSPRNG token in the `token`
query param, stored server-side only as a SHA-256 hash (`hashToken`). Rate
limited per-token and per-IP (10 requests / 15 minutes each, fail-closed,
via `checkRateLimit`). Listed on the edge guard's public allowlist
(`api/_lib/guard.js`) specifically because the recipient is a customer with
no HiveLogic account.
**Purpose:** Read-only preview page for a customer's appointment
confirm/decline link; renders an HTML page and never mutates anything (GET
must stay side-effect-free because mail clients/link scanners prefetch
URLs).

**Request body / query params:**
- `token` (string, required) — 64 lowercase-hex characters; anything else is
  rejected before a database lookup.

**Response:**
An HTML page (`text/html`), not JSON. States rendered: "Link not valid"
(malformed/unknown/expired token — same wording for both, so the endpoint
can't be used to enumerate valid tokens), "Please wait" (rate limited),
"Already confirmed"/"Already declined", or "Confirm your appointment" with
Confirm / Can't make it buttons that POST back to the same URL.

Notes: Unknown and expired tokens produce identical text on purpose
(`refuseReason` in `api/_lib/appointment-confirm.js`).

---

### `POST /api/schedule/confirm`
**Auth:** Same as GET — public, token-authenticated, same rate limiting.
**Purpose:** Records the customer's confirm/decline decision. This token
authorizes exactly one write: setting `confirm_state` (and `confirmed_at`)
on exactly one `hl_appointments` row. It cannot move, cancel, read, or list
anything else.

**Request body / query params:**
- `token` (string, required) — same 64-hex-char token as GET.
- `decision` (string, required) — `"confirmed"` or `"declined"`.

**Response (JSON, when not a form POST):**
```json
{ "ok": true, "confirm_state": "confirmed" }
```
If the decision matches the state already on file (idempotent re-click):
```json
{ "ok": true, "confirm_state": "confirmed", "unchanged": true }
```
If the request came from an HTML `<form>` submit (`content-type` contains
`form`), an HTML thank-you/decline page is returned instead of JSON.

Notes: Changing a mind (confirmed → declined) is explicitly allowed — there
is no other channel for a customer to do that. A DB write failure returns
`{ "ok": false, "error": "Could not record that. Please contact the office." }`
with HTTP 500.

---

### `GET /api/schedule/hl`
**Auth:** Requires a Supabase session — the handler reads the
`Authorization: Bearer <jwt>` header directly and verifies it against
`${SUPABASE_URL}/auth/v1/user` (its own `getRequester()`, not the shared
`requireApiAuth`/`requireUser` helpers). No specific role is required for
GET; any signed-in user can read the board.
**Purpose:** Loads all HiveLogic-native scheduling data for a date range —
the calendar board's main data pull.

**Request body / query params:**
- `start` (string, optional) — `YYYY-MM-DD`; defaults effectively to the
  epoch if omitted.
- `end` (string, optional) — `YYYY-MM-DD`; defaults effectively to
  `2999-01-01` if omitted.

**Response:**
```json
{
  "ok": true,
  "appointments": [ /* hl_appointments rows, canceled=false, in range */ ],
  "clock": [ /* hl_clock rows still clocked in (clock_out is null) */ ],
  "overrides": [ /* hl_crew_overrides rows */ ],
  "outbox": [ /* hl_outbox rows with status=queued, up to 200 */ ],
  "messaging": { "enabled": false },
  "subs": [ /* {id, name} rows for the board's Subs layer */ ],
  "rechainRequests": [ /* hl_rechain_requests rows with status=open */ ],
  "viewerJid": null
}
```
Notes: `viewerJid` is the caller's own Jobber user id (if resolvable via
their `profiles.email` → `users.jobber_id`), used by the frontend to show
"unchain me" only for the signed-in tech's own chain.

---

### `POST /api/schedule/hl` — `action=create_appointment`
**Auth:** Same Supabase-session check as GET, plus a role check
(`canWrite`): the caller's `profiles.role` must be `admin`/`superadmin`, OR
their `employee_roles.permission_roles` (looked up by
`users.jobber_id` matched on the profile's email) must include one of
`owner`, `partner`, `office_manager`, `systems_pm`, `dispatch`,
`project_manager`.
**Purpose:** Creates a new HiveLogic-native appointment row (this endpoint
never writes to Jobber — see the file header: HiveLogic-native appointments,
clock in/out, and crew overrides live only in HiveLogic's own
`hl_appointments`/`hl_clock`/`hl_crew_overrides` tables).

**Request body / query params:**
- `action` (string, required) — `"create_appointment"`.
- `appointment` (object, required) — with:
  - `start_at` (string/ISO datetime, required)
  - `end_at` (string/ISO datetime, required)
  - `kind` (string, optional, default `"field"`)
  - `title`, `client` (string, optional)
  - `crew_jids` (array, optional)
  - `lead_jid` (string, optional)
  - `division` (string, optional)
  - `job_no` (string, optional) — ignored if `job_ref` resolves a real job
  - `job_ref` (string, optional) — a `jobs.jobber_id`; when given, the job
    record supplies its own `title`/`division`/job number rather than the
    caller retyping them; a nonexistent `job_ref` returns 404
  - `lat`, `lng` (number, optional)
  - `source_lead_id`, `source_estimate_id` (optional) — traceability back to
    the lead/estimate that produced the visit
  - `details` (object, optional)

**Response:**
```json
{ "ok": true, "appointment": { "id": "...", "kind": "field", "...": "..." } }
```
Notes: On success, `queueMessages()` is called (fire-and-forget) which
queues a confirmation email + reminder rows into `hl_outbox` for
client-facing kinds (`field`, `service`, `sitevisit`, `lead`) — nothing is
actually sent here; a separate outbox processor cron sends only when
`hl_message_settings.enabled` is true. The confirm-link token is minted here
too (raw value only ever appears in the email body; only its SHA-256 hash is
persisted on the appointment row).

---

### `POST /api/schedule/hl` — `action=cancel_appointment`
**Auth:** Same role check as create_appointment.
**Purpose:** Soft-cancels an appointment (`canceled=true`) and skips any
still-queued outbox messages for it.

**Request body / query params:**
- `action` (string, required) — `"cancel_appointment"`.
- `id` (string, required) — the `hl_appointments.id`.

**Response:**
```json
{ "ok": true, "changed": 1 }
```

---

### `POST /api/schedule/hl` — `action=move_appointment`
**Auth:** Same role check.
**Purpose:** Reschedules and/or reassigns a HiveLogic-native appointment
(distinct from `api/schedule/move-visit.js`, which moves a **Jobber** visit —
this one only ever touches `hl_appointments`).

**Request body / query params:**
- `action` (string, required) — `"move_appointment"`.
- `id` (string, required).
- `start_at`, `end_at` (string/ISO datetime, optional).
- `crew_jids` (array, optional).
- `lead_jid` (optional).

**Response:**
```json
{ "ok": true, "appointment": { "id": "...", "start_at": "...", "...": "..." } }
```
Notes: If `start_at`/`end_at` actually changed, queued reminder rows (steps
`d3`/`d1`/`d0`/`h1`) for that appointment are deleted and re-queued against
the new time (`resyncReminders`) — a still-queued `confirm` row is
deliberately left alone so its link (and token) keeps working. Reassigning
crew alone does not trigger a resync.

---

### `POST /api/schedule/hl` — `action=clock_in`
**Auth:** Same role check.
**Purpose:** Clocks in one or more crew members on a job/visit in one call
(one `hl_clock` row per person — payroll pays people, not crews).

**Request body / query params:**
- `action` (string, required) — `"clock_in"`.
- `employees` (array of Jobber user ids, required) — or `employee_jid`
  (single string) as a fallback.
- `lead_jid`, `source`, `target_kind`, `target_id`, `label` (optional).

**Response:** shape from `clockCrewIn()` (`api/_lib/crew-clock.js`):
```json
{
  "ok": true,
  "clock": [ /* written hl_clock rows */ ],
  "lead": "12345",
  "flagged": [ /* jids clocked in far from the lead's GPS position */ ],
  "unverified": [ /* jids that could not be GPS-verified at all */ ]
}
```

---

### `POST /api/schedule/hl` — `action=clock_out`
**Auth:** Same role check.
**Purpose:** Clocks out one or more crew members.

**Request body / query params:**
- `action` (string, required) — `"clock_out"`.
- `employees` (array, required) — or `employee_jid` fallback.

**Response:**
```json
{ "ok": true, "changed": 2 }
```
or, when nobody matched an open clock-in:
```json
{ "ok": false, "changed": 0, "note": "nobody was clocked in" }
```

---

### `POST /api/schedule/hl` — `action=chain` / `action=unchain`
**Auth:** Same role check.
**Purpose:** Adds (`chain`) or removes (`unchain`) an employee from a
Jobber visit's crew, stored as a HiveLogic override row
(`hl_crew_overrides`) layered on top of Jobber's own assignment — this never
writes back to Jobber itself.

**Request body / query params:**
- `action` (string, required) — `"chain"` or `"unchain"`.
- `visit_jid` (string, required) — the Jobber visit id.
- `employee_jid` (string, required).

**Response:**
```json
{ "ok": true, "override": { "visit_jid": "...", "add_jids": [], "remove_jids": [], "...": "..." } }
```

---

### `POST /api/schedule/hl` — `action=self_unchain`
**Auth:** Special case — allowed for ANY signed-in user (bypasses
`canWrite`) as long as they are unchaining themselves
(`isSelf`: their own resolved `jobberId` must match `employee_jid`), or for
anyone who does pass `canWrite`.
**Purpose:** Lets a crew member peel themselves off one job (never off their
whole crew) and files a rechain request for dispatch to resolve. Also closes
their open clock-in on that specific target.

**Request body / query params:**
- `action` (string, required) — `"self_unchain"`.
- `visit_jid` (string, required).
- `employee_jid` (string, optional) — defaults to the caller's own resolved
  Jobber id if omitted.
- `reason` (string, optional, truncated to 500 chars).

**Response:**
```json
{ "ok": true, "request": { "id": "...", "target_id": "...", "employee_jid": "...", "status": "open", "...": "..." } }
```

---

### `POST /api/schedule/hl` — `action=set_visit_lead`
**Auth:** Same role check as create_appointment.
**Purpose:** Dispatch designates (or clears, with `employee_jid: null`) who
leads a given job/visit.

**Request body / query params:**
- `action` (string, required) — `"set_visit_lead"`.
- `visit_jid` (string, required).
- `employee_jid` (string or null, optional) — `null` clears the election.

**Response:**
```json
{ "ok": true, "override": { "visit_jid": "...", "lead_jid": "...", "...": "..." } }
```

---

### `POST /api/schedule/hl` — `action=resolve_rechain`
**Auth:** Same role check.
**Purpose:** Dispatch answers an open `self_unchain` request: `rechain`
(puts the tech back on the job's crew override) or `dismiss` (closes the
request, leaves them off).

**Request body / query params:**
- `action` (string, required) — `"resolve_rechain"`.
- `id` (string, required) — the `hl_rechain_requests.id`.
- `resolution` (string, optional) — `"rechain"` to put them back; anything
  else (including omitted) is treated as `"dismiss"`.

**Response:**
```json
{ "ok": true, "resolution": "rechain" }
```

---

### `POST /api/schedule/hl` — `action=set_messaging`
**Auth:** Same role check.
**Purpose:** Updates the single `hl_message_settings` row that controls
whether/what client-facing scheduling messages actually send (master
enable switch, confirm-on-create toggle, reminder steps, channels,
cancellation policy text).

**Request body / query params (all optional, only provided fields are
patched):**
- `enabled` (boolean)
- `confirm_on_create` (boolean)
- `reminders` (array)
- `channels` (object)
- `cancellation_policy` (string)

**Response:**
```json
{ "ok": true, "settings": { "id": true, "enabled": false, "...": "..." } }
```

---

### `POST /api/schedule/move-visit`
**Auth:** Requires a Supabase session (`getRequestingProfile`, verified via
`/auth/v1/user`, same pattern as `hl.js`) AND a dispatch role: `role`
`admin`/`superadmin`, or `permissionRoles` containing `owner`,
`project_manager`, or `dispatch` (`DISPATCH_ALLOWED_ROLES`).
**Purpose:** The guarded drag-to-reschedule / reassign write-back for
Dispatch — and unlike the `hl.js` actions above, **this one does write to
Jobber**: it calls Jobber's real GraphQL mutations
`visitEditSchedule` and/or `visitEditAssignedUsers` against the live visit,
then re-fetches the visit to verify the write actually took before
reporting success.

**Request body / query params:**
- `visitId` (string, required) — Jobber `EncodedId` of the visit.
- `action` (string, required) — `"reschedule"`, `"reassign"`, or `"both"`.
- `dateYmd` (string, required if rescheduling) — `YYYY-MM-DD`.
- `newStartHour`, `newEndHour` (number, required if rescheduling) — decimal
  hours (e.g. `13.5` = 1:30pm); `newEndHour` must exceed `newStartHour`.
- `toTechJobberId` (string, required if reassigning).
- `fromTechJobberId` (string, optional) — the tech being swapped out; the
  rest of the visit's existing assignees are preserved untouched.
- `overrideFreeze` (boolean, optional) — explicitly overrides the freeze
  window guardrail below.
- `reason` (string, optional).

**Response (success):**
```json
{
  "ok": true,
  "receipt": {
    "visitId": "...",
    "action": "both",
    "before": { "startAt": "...", "endAt": "...", "assignedUserIds": [], "assignedUserNames": [] },
    "after": { "...": "..." },
    "freezeOverridden": false,
    "notified": { "channel": null, "note": "No SMS/push channel connected yet for staff notifications -- let the affected tech(s) and client know directly.", "affected": [] },
    "verifiedOk": true,
    "undoDeadline": "2026-08-21T...Z",
    "logId": 42
  }
}
```
**Response (freeze-window block, HTTP 409):**
```json
{
  "ok": false,
  "code": "FREEZE_WINDOW",
  "error": "This visit starts in 12 minutes -- inside the freeze-next-60-minutes guardrail. Confirm again to override.",
  "minutesUntilStart": 12
}
```
**Response (Jobber rejected/could not verify the change, HTTP 422):**
```json
{
  "ok": false,
  "error": "...",
  "userErrors": [ { "step": "reschedule", "message": "...", "path": [] } ],
  "receipt": { "visitId": "...", "action": "...", "before": {}, "after": null, "freezeOverridden": false, "logId": 42 }
}
```

Notes: "Freeze next 60 minutes" (configurable via `workforce_settings.
dispatch_freeze_window_enabled`/`dispatch_freeze_window_minutes`, default ON
/ 60 min) refuses to move a visit whose **live, re-verified-from-Jobber**
start time falls inside that window, unless `overrideFreeze:true` is passed
— which is itself logged. Every attempt (success or failure) is logged to
the `schedule_writeback_log` table with before/after snapshots. There is
currently no SMS/push channel wired up for staff notifications — the
`notified` field says so honestly rather than pretending a message went
out. Never claims success without Jobber's own returned state confirming
the change (`verifiedOk`).

---

### `GET /api/schedule/outbox?resource=process`
**Auth:** `checkCronSecret`-style bearer check, but implemented inline
(direct string comparison `Bearer ${process.env.CRON_SECRET}` against the
`Authorization` header) rather than via the shared timing-safe
`checkCronSecret()` helper in `api/_lib/guard.js`. Intended caller is Vercel
Cron (see `vercel.json` / the guard's cron allowlist for
`/api/schedule/outbox` resource `process`, GET-pinned).
**Purpose:** The cron entry point that actually sends the queued
confirmation/reminder messages in `hl_outbox` — thin shell around
`api/_lib/outbox-processor.js`'s `processOutbox()`, which does all the
scheduling/claiming logic; this file only wires up the real Supabase,
email (`sendEmail`), and SMS (Twilio, via `twilioRequest`) clients to it.

**Request body / query params:**
- `resource` (string, required) — must be exactly `"process"`.

**Response:** whatever `processOutbox()` returns, passed straight through
as JSON (its shape is defined in `api/_lib/outbox-processor.js`, not this
file). On an unrecoverable read failure it returns HTTP 500 with
`{ "ok": false, "error": "..." }` rather than a misleadingly-empty
`{ sent: 0, due: 0 }`, specifically so a Supabase outage cannot look like a
healthy idle tick.

Notes: SMS sends go out from whichever number is flagged
`voice_numbers.role='main' AND active=true` — the same number the voice
webhook already texts voicemail alerts from. Rows a dead run left claimed
are swept to `status='unknown'` (not silently requeued or silently
dropped) because it's genuinely unknown whether the provider already
accepted the message before the run died.

## Gusto (Payroll)

`api/gusto/index.js` routes on the `resource` query param (plus the
presence/absence of `code`/`state` for the OAuth legs), exactly mirroring
`api/qbo/index.js`'s structure. Tokens are stored in the shared
`integrations` table under `key='gusto'` (encrypted via
`encryptSecret`/`decryptSecret`), alongside — but never touching — the
`key='jobber'` and `key='qbo'` rows. As of this writing the Gusto app
credentials (`GUSTO_CLIENT_ID`/`GUSTO_CLIENT_SECRET`) do not exist yet in
this deployment; every code path degrades to an honest "not configured"
response rather than throwing.

### `GET /api/gusto` (no query params)
**Auth:** Public (listed in the edge guard's `PUBLIC_API_PREFIXES`).
**Purpose:** Starts the Gusto OAuth flow — redirects to Gusto's
`/oauth/authorize` screen.

**Request body / query params:** none.

**Response:** HTTP 302 redirect to Gusto's OAuth screen, or (if
`GUSTO_CLIENT_ID`/`GUSTO_CLIENT_SECRET` are unset) an HTML page: "Gusto is
not configured".

---

### `GET /api/gusto?code=...&state=...`
**Auth:** Public — this is Gusto's own callback. Protected instead by
`consumeOAuthState()` (single-use, expiring state token issued at connect
time) rather than any session check.
**Purpose:** Exchanges the OAuth `code` for access/refresh tokens, discovers
and persists the Gusto company UUID, and stores everything in
`integrations` (`key='gusto'`).

**Request body / query params:**
- `code` (string, required).
- `state` (string, required) — validated via `consumeOAuthState`; invalid
  or expired state is rejected before any token exchange.
- `error` (string, optional) — if Gusto sends this instead (user declined),
  an HTML "Gusto authorization cancelled" page is shown.

**Response:** HTML page — "Gusto connected" on success, "Could not connect
Gusto" (400) on bad/expired state, or "Gusto connection error" (500) on any
other failure.

---

### `GET /api/gusto?resource=status`
**Auth:** Public — never throws, safe to call without credentials.
**Purpose:** Cheap health/connection probe for the frontend.

**Request body / query params:**
- `resource=status` (required).

**Response:**
```json
{ "ok": true, "connected": false, "configured": false, "environment": "production" }
```

---

### `GET /api/gusto?resource=roster`
**Auth:** `requireApiAuth` (signed-in Supabase user or CRON_SECRET bearer).
**Purpose:** Lists HiveLogic hires alongside their linked Gusto
employee/job UUIDs, for the payroll admin screen.

**Request body / query params:**
- `resource=roster` (required).

**Response:**
```json
{
  "ok": true,
  "roster": [ /* employee_pay rows: id, display_name, pay_type, pay_class, base_rate, is_field, source, gusto_employee_uuid, gusto_job_uuid */ ],
  "environment": "production",
  "connected": false,
  "configured": false
}
```

---

### `?resource=sync`
**Auth:** `requireApiAuth`. (The handler does not itself restrict HTTP
method for this resource — it only branches on `req.query.resource`.)
**Purpose:** Pulls payroll data from Gusto via `runPayrollSync()`
(`api/_lib/gusto-payroll-sync.js`, out of scope for this file) and either
previews (dry run) or commits it into HiveLogic's own tables.

**Request body / query params:**
- `resource=sync` (required).
- `commit` (boolean, in body, optional) — `true` requests a real commit.
  Ignored (forced to dry-run) whenever `GUSTO_ENVIRONMENT=demo`, so a demo
  connection can never write its fake employees into HiveLogic's real
  `employee_pay` table.

**Response:** the plan object returned by `runPayrollSync()`, with
`note_demo` appended when running against the demo environment. HTTP 502
if the plan reports `ok: false`.

---

### `?resource=payroll_dry_run`
**Auth:** `requireApiAuth`.
**Purpose:** Same payroll-sync preview as `sync`, but with rich diagnostics
returned when the Gusto company id cannot be resolved (token presence,
raw `/v1/me` and `/v1/companies` responses, and a post-refresh retry) — used
to pinpoint 401s during setup.

**Request body / query params:**
- `resource=payroll_dry_run` (required).

**Response (company id resolved):** the `runPayrollSync({ dryRun: true })`
plan object.
**Response (company id NOT resolved):**
```json
{
  "ok": false,
  "error": "Could not resolve the Gusto company id yet — diagnostics below.",
  "api_version": "2026-06-15",
  "token_present": true,
  "me_status": 200, "me": { "...": "..." },
  "companies_status": 200, "companies": { "...": "..." },
  "me_after_refresh_status": 200, "me_after_refresh": { "...": "..." },
  "refresh_error": null
}
```
Notes: token lengths/prefixes are deliberately never included, only
presence — those are credential material.

---

### `?resource=timesheet_test`
**Auth:** `requireApiAuth`, plus a hard environment guard.
**Purpose:** Demo-only write-path smoke test — finds the first W2 hourly
employee in the connected **demo** company, pushes one fabricated 8-hour
"Regular" time-sheet entry to Gusto's Time Sheets API, then reads the
sheets back to confirm the write landed. Refuses to run at all unless
`GUSTO_ENVIRONMENT=demo`.

**Request body / query params:**
- `resource=timesheet_test` (required).

**Response (success):**
```json
{
  "ok": true,
  "pushed_for": { "name": "Jane Doe", "employee_uuid": "...", "job_uuid": "..." },
  "sent": { "entity_uuid": "...", "shift_started_at": "...", "shift_ended_at": "...", "entries": [ { "hours_worked": 8, "pay_classification": "Regular" } ] },
  "gusto_status": 200,
  "gusto_response": { "...": "..." },
  "time_sheets_now": 5
}
```
**Response (refused outside demo, HTTP 400):**
```json
{ "ok": false, "error": "Refused: timesheet_test only runs against a Gusto DEMO company (GUSTO_ENVIRONMENT=demo)." }
```

## QuickBooks OAuth

`api/qbo/index.js` is the QuickBooks Online **OAuth connection + live read**
surface — distinct from `api/cost-model.js`, which reads already-synced,
QBO-derived cost data out of HiveLogic's own tables rather than calling
QuickBooks live. Tokens live in `integrations` (`key='qbo'`), encrypted, and
refresh automatically ~2 minutes before expiry.

### `GET /api/qbo` (no query params)
**Auth:** Public per the edge guard, but best-effort attempts `requireUser`
to attach the initiating user's id to the OAuth `state` (falls back to
anonymous `state` if no session).
**Purpose:** Starts the QuickBooks OAuth flow — redirects to Intuit's
`/connect/oauth2` screen.

**Request body / query params:** none.

**Response:** HTTP 302 redirect, or HTTP 500 HTML
(`QBO_CLIENT_ID / QBO_CLIENT_SECRET are not set for this deployment.`) if
unconfigured.

---

### `GET /api/qbo?code=...&realmId=...&state=...`
**Auth:** Public — Intuit's own callback. Protected by
`consumeOAuthState()` (single-use, expiring, CSRF-resistant since
2026-08-01 — previously a static, unauthenticated state string).
**Purpose:** Exchanges the code for tokens, stores them (with the QuickBooks
company `realmId`) in `integrations` (`key='qbo'`).

**Request body / query params:**
- `code` (string, required).
- `realmId` (string, required).
- `state` (string, required).
- `error` (string, optional) — if present, returns an escaped HTML message
  instead of exchanging anything.

**Response:** HTML — `<h2>QuickBooks is connected.</h2>` on success,
`<h2>QuickBooks connection could not be verified.</h2>` (400) on bad state,
or `<h2>QuickBooks connection was not approved.</h2>` (400) if Intuit sent
`error`.

---

### `GET /api/qbo?resource=status`
**Auth:** Requires either a signed-in Supabase user (`requireUser`) OR a
`CRON_SECRET` bearer on a GET request (`checkCronSecret`) — despite
`/api/qbo` being on the edge guard's public-path allowlist, this specific
resource self-gates inside the handler.
**Purpose:** Connection/config probe.

**Request body / query params:**
- `resource=status` (required).

**Response:**
```json
{ "configured": true, "connected": true, "environment": "production" }
```

---

### `GET /api/qbo?resource=financials&kind=...`
**Auth:** Same as `status` — signed-in user, or CRON_SECRET bearer on GET.
**Purpose:** Live read from QuickBooks, refreshing the stored access token
first if it's near expiry. `kind` selects which QuickBooks report/query
runs; results are cached in-memory per `kind`+`opts` for 50 seconds
(`getFinancials`), and some kinds are additionally durably cached in
Supabase's `qbo_report_cache` table via `getFinancialsDurable` (used by
other files, not this handler directly).

**Request body / query params:**
- `resource=financials` (required).
- `kind` (string, optional, default `"summary"`) — one of:
  - `summary` (default) — company snapshot: cash, AR/AP, YTD P&L pick.
  - `accounts` — active chart-of-accounts with balances.
  - `vendors` — full active vendor directory (paginated).
  - `classes` — QBO Class list (division/service-line tracking check).
  - `job_costing_check` — diagnostic: are Purchase/Bill lines tagged with a
    Customer:Job ref at all.
  - `job_costing_summary` — real per-job actual costs, parsed from
    `Job # NNNN`-named sub-customers on Purchase/Bill lines (paginated over
    all rows, not a sample).
  - `bills_by_job` / `invoices_by_job` — real per-job vendor bills /
    invoices for the trailing N days (`days` query param, default 45,
    max 365).
  - `bills_due_range` / `invoices_due_range` — bills/invoices due within an
    explicit `start_date`/`end_date` window.
  - `open_invoices` / `open_bills` — up to 100 open items, oldest-due first.
  - `profit_and_loss` — YTD P&L, flattened to `{label, amount}` rows.
  - `profit_and_loss_monthly` — P&L over an explicit range, with
    `summarize_by` (`Month`/`Week`/`Quarter`/`Year`) and
    `accounting_method` (`Cash`/`Accrual`, default `Accrual`).
  - `balance_sheet`, `ar_aging`, `ap_aging`.
- `start_date`, `end_date` (string `YYYY-MM-DD`, optional) — used by the
  date-ranged kinds above.
- `summarize_by`, `accounting_method` (optional) — only read by
  `profit_and_loss_monthly`.
- `days` (number, optional) — only read by `bills_by_job`/`invoices_by_job`.

**Response (example, `kind=summary`):**
```json
{
  "source": "QuickBooks (production)",
  "company": "Greenwich Handyman Co.",
  "cash_in_bank": 123456.78,
  "bank_accounts": [ { "name": "Operating", "balance": 100000 } ],
  "unearned_deposits_estimate": 5000,
  "deposit_accounts_matched": ["Customer Deposits"],
  "true_cash_estimate": 118456.78,
  "accounts_receivable": 42000,
  "accounts_payable": 15000,
  "pnl_ytd": { "total_income": 500000, "total_expenses": 400000, "gross_profit": 200000, "net_income": 100000 },
  "period": "2026-01-01 -> 2026-08-21",
  "note": "true_cash_estimate subtracts deposit-named liability accounts -- confirm which account holds unearned deposits."
}
```
On any read failure: `{ "error": "..." }` (HTTP 502) — QBO API faults are
translated to plain-English messages (`friendlyQboError`) while the real
HTTP status and raw QBO error body are preserved as `qboStatus`/`qboRaw`.

Notes: `job_costing_summary`/`bills_by_job`/`invoices_by_job` all key off
the literal text pattern `Job # NNNN` in a QuickBooks sub-customer/customer
name — a real, already-verified naming convention on this company's QBO
data, not a guess; lines that don't match are counted separately as
`unmatchedAmount`/`unmatchedLines`, never silently dropped.

## Self-Test / Visual Intel Reporting

**Correction to the assumed framing:** only `api/selftest-report.js` is
part of the self-test/crawler system (there's a separate browser-based
deep-crawler, `public/tools/selftest.js`, that POSTs its findings here).
`api/visual-intel.js` turned out to be an unrelated feature — HiveLogic's
"Visual Intelligence" job photo/video documentation module (media metadata,
tags, annotations, timeline, comments, entity links, AI photo analysis). It
is grouped in this file only because the task scoping asked for it here;
its endpoints are documented accurately as what they actually are.
`api/test-workflow.js` is also unrelated to the crawler — it's a separate,
secret-gated **autonomous server-side QA runner** that exercises the app's
own write APIs as a real (but disposable) test user. All three are
documented below under this shared heading.

### `POST /api/selftest-report.js`
**Auth:** `requireApiAuth` (signed-in Supabase user or CRON_SECRET bearer).
**Purpose:** Receives one screen's worth of results from the deep-crawler
running in a real browser and upserts them, keyed by `runId`, into
`selftest_reports` — because the crawler saves after every screen, a
mid-crawl crash still leaves the latest partial report readable.

**Request body / query params:**
- `runId` (string, optional) — defaults to `"run-" + Date.now()` if
  omitted; used as the upsert conflict key so repeated saves for the same
  run overwrite the same row rather than creating new ones.
- `tally`, `shield` (any, optional) — passed through as-is.
- `results` (array, optional) — the array of per-check verdicts.
- `url`, `generatedAt`, `partial`, `viewsDone` (optional) — folded into a
  `meta` object alongside a computed `checks` count.

**Response:**
```json
{ "ok": true, "id": 123, "runId": "run-...", "checks": 42, "findings": 3 }
```
On save failure: `{ "ok": false, "error": "save failed: ..." }` (HTTP 500).
On a findings-processing failure (the report itself did save):
`{ "ok": false, "error": "report saved but status hub update failed: ..." }`
(HTTP 500).

Notes: Every POST also feeds `row.results` through
`findingsFromSelftest()`/`observeFindings()`
(`api/_lib/status-hub.js`) — i.e. crawler failures are turned into tracked
engineering findings in the app's internal status hub, not just stored as
raw report data.

---

### `GET /api/selftest-report.js?key=...`
**Auth:** A single hardcoded shared-secret query param
(`READ_KEY = 'a7f3c9e21b8d4f60a5e7c3b9d1f8a2e4c6b0'`) compared with `!==`
(not timing-safe, and not sourced from an env var) — distinct from every
other auth mechanism documented in this file.
**Purpose:** Lets Reina (or anyone with the key) read back the single most
recent self-test report.

**Request body / query params:**
- `key` (string, required) — must equal the hardcoded `READ_KEY` above.
- `problems` (string, optional) — `"1"` filters `latest.results` down to
  only the "interesting" verdicts: `THREW`, `FAILED_FETCH`, `FAKE_SUCCESS`,
  `NO_OUTCOME`, `SLOW_BLOCKING`, `UNREADABLE_ACTIVE`.

**Response:**
```json
{ "ok": true, "latest": { "run_id": "...", "tally": {}, "shield": {}, "results": [ /* ... */ ], "meta": { "...": "..." }, "created_at": "..." } }
```
If no report exists yet: `{ "ok": true, "latest": null }`.

---

## Visual Intelligence (`api/visual-intel.js`)

Not a self-test/crawler endpoint — see the correction note above. This is a
single dispatcher keyed on `?resource=` (and HTTP method) for job
photo/video documentation. All resources require a signed-in Supabase user
(`requireUser`); there is no separate per-resource auth. The actual
photo/video bytes never pass through this function — the browser uploads
directly to Supabase Storage (bucket `media`); this endpoint only manages
metadata rows and runs AI analysis via `@anthropic-ai/sdk`.

### `GET /api/visual-intel?resource=media&jobId=X`
**Auth:** `requireUser`.
**Purpose:** Lists a job's photos/videos with their analysis, tags, and
entity links embedded.

**Request body / query params:**
- `jobId` (string, required).
- `limit` (number, optional, default 200, max 2000).

**Response:**
```json
{ "ok": true, "source": "HiveLogic Visual Intelligence", "jobId": "...", "returned": 12, "media": [ /* media rows incl. media_analysis, media_tags(tags), media_entity_links */ ] }
```

---

### `GET /api/visual-intel?resource=mediaById&id=X`
**Auth:** `requireUser`.
**Purpose:** Single media item by id, for the media detail page.

**Request body / query params:** `id` (string, required).

**Response:** `{ "ok": true, "source": "HiveLogic Visual Intelligence", "media": { "...": "..." } }`, or 404
`{ "ok": false, "error": "Media not found" }`.

---

### `GET /api/visual-intel?resource=recentMedia&limit=N`
**Auth:** `requireUser`.
**Purpose:** Most recent media across every job (the "Recent photos"
strip), enriched with `jobNumber`/`jobTitle`/`clientName` looked up from
`jobs`/`clients`.

**Request body / query params:** `limit` (number, optional, default 20,
max 200).

**Response:** `{ "ok": true, "source": "HiveLogic Visual Intelligence", "media": [ /* enriched rows */ ] }`.

---

### `GET /api/visual-intel?resource=mediaSummary`
**Auth:** `requireUser`.
**Purpose:** Per-job `{mediaCount, lastActivityAt}` aggregate for the Jobs
list cards. Paginates through up to `scanLimit` rows (default 20000, max
50000) in pages of 1000 to work around PostgREST's 1000-row cap.

**Request body / query params:** `scanLimit` (number, optional).

**Response:** `{ "ok": true, "source": "HiveLogic Visual Intelligence", "scanned": 1819, "summary": [ { "jobId": "...", "mediaCount": 7, "lastActivityAt": "..." } ] }`.

---

### `POST /api/visual-intel?resource=media`
**Auth:** `requireUser`.
**Purpose:** Creates a media metadata row after a direct-to-Storage upload
completes; auto-appends a `timeline_events` row for the job.

**Request body / query params:**
- `jobId`, `mediaType`, `storagePath`, `capturedAt` (required).
- `mimeType`, `sizeBytes`, `thumbnailPath`, `gpsLat`, `gpsLng`,
  `offlineClientId`, `uploadedBy` (optional).

**Response:** `{ "ok": true, "source": "HiveLogic Visual Intelligence", "media": { "...": "..." } }`, or, on a retried
upload matched by `offlineClientId`:
`{ "ok": true, "source": "HiveLogic Visual Intelligence", "media": { "...": "..." }, "deduped": true }`.

---

### `PATCH /api/visual-intel?resource=media&id=X`
**Auth:** `requireUser`.
**Purpose:** Updates a media item's rotation — the only field editable
after upload.

**Request body / query params:** `id` (query, required); `rotation` (body,
required) — must be `0`, `90`, `180`, or `270`.

**Response:** `{ "ok": true, "source": "HiveLogic Visual Intelligence", "media": { "...": "..." } }`.

---

### `DELETE /api/visual-intel?resource=media&id=X`
**Auth:** `requireUser`.
**Purpose:** Deletes a media row (Postgres `ON DELETE CASCADE` cleans up
its analysis/tags/annotations/comments/links), then best-effort deletes the
underlying Storage object(s) — a Storage cleanup failure never blocks the
metadata delete.

**Request body / query params:** `id` (required).

**Response:** `{ "ok": true, "source": "HiveLogic Visual Intelligence" }`, or 404 if not found.

---

### `GET /api/visual-intel?resource=tags&jobId=X` / `POST ?resource=tags` / `DELETE ?resource=tags&mediaId=X&tagId=Y`
**Auth:** `requireUser`.
**Purpose:** List a job's tags; create/attach a tag to a photo
(case-insensitive reuse of an existing same-named job tag); unlink one tag
from one photo (the tag itself survives if other photos still use it).

**Request body / query params:**
- GET: `jobId` (required).
- POST: `jobId`, `mediaId`, `name` (required); `source` (optional, `"AI"`
  or defaults to `"MANUAL"`).
- DELETE: `mediaId`, `tagId` (both required).

**Response:** `{ ok, source, tags: [...] }` (GET) / `{ ok, source, tag: {...} }` (POST) / `{ ok, source }` (DELETE).

---

### `GET /api/visual-intel?resource=annotations&mediaId=X` / `POST ?resource=annotations` / `DELETE ?resource=annotations&id=X`
**Auth:** `requireUser`.
**Purpose:** List a media item's current (non-superseded) annotations;
create a new annotation (annotations are never mutated in place, only
superseded); soft/hard-delete one by id.

**Request body / query params:**
- GET: `mediaId` (required).
- POST: `mediaId`, `annotationType`, `data` (required); `frameTimeMs`,
  `createdBy` (optional).
- DELETE: `id` (required).

**Response:** `{ ok, source, annotations: [...] }` / `{ ok, source, annotation: {...} }` / `{ ok, source }`.

---

### `GET /api/visual-intel?resource=timeline&jobId=X` / `POST ?resource=timeline`
**Auth:** `requireUser`.
**Purpose:** List a job's timeline events; add a manual one (uploads
auto-append their own `AUTO`-sourced event elsewhere in this file).

**Request body / query params:**
- GET: `jobId` (required).
- POST: `jobId`, `label` (required).

**Response:** `{ ok, source, timeline: [...] }` / `{ ok, source, event: {...} }`.

---

### `GET /api/visual-intel?resource=comments&mediaId=X` / `POST ?resource=comments`
**Auth:** `requireUser`.
**Purpose:** List/add notes on a media item.

**Request body / query params:**
- GET: `mediaId` (required).
- POST: `mediaId`, `body` (required); `createdBy` (optional).

**Response:** `{ ok, source, comments: [...] }` / `{ ok, source, comment: {...} }`.

---

### `GET /api/visual-intel?resource=entityLinks&mediaId=X` / `POST ?resource=entityLinks` / `DELETE ?resource=entityLinks&id=X`
**Auth:** `requireUser`.
**Purpose:** Polymorphic "attach this photo to any HiveLogic entity" links
(job, estimate, invoice, permit, etc.) — no validation that the target
entity actually exists in another table, since several of those modules
don't have synced tables yet; the association is recorded honestly for
whenever they do.

**Request body / query params:**
- GET: `mediaId` (required).
- POST: `mediaId`, `entityType`, `entityId` (all required).
- DELETE: `id` (required).

**Response:** `{ ok, source, links: [...] }` / `{ ok, source, link: {...} }` / `{ ok, source }`.

---

### `POST /api/visual-intel?resource=analyze`
**Auth:** `requireUser`.
**Purpose:** Runs Claude vision analysis on one media item's base64 image
data and stores the result (upserted, `merge-duplicates` on `media_id`).
Falls back to an honest "AI analysis unavailable" result (all fields null,
`confidence: 0`) if `ANTHROPIC_API_KEY` is unset, the required fields are
missing, or the Claude call throws — never invents/guesses a value.

**Request body / query params:**
- `mediaId` (required).
- `mimeType`, `dataBase64` (required for a real analysis to run;
  `mimeType` must be one of `image/jpeg`, `image/png`, `image/gif`,
  `image/webp`).

**Response:**
```json
{
  "ok": true,
  "source": "HiveLogic Visual Intelligence",
  "analysis": {
    "media_id": "...",
    "description": "200A Square D QO panel, double-tapped breaker",
    "room": "garage",
    "trade": "electrical",
    "materials": [],
    "damage": null,
    "safety_issue": "double-tapped breaker",
    "confidence": 0.82,
    "model": "claude-sonnet-4-5",
    "analyzed_at": "..."
  }
}
```

## Autonomous QA Runner (`api/test-workflow.js`)

Not related to the crawler either — see the correction note above. This is
a secret-gated, server-side test runner Chris asked for so an agent could
"run everything exhaustively until you make it fail," without needing a
browser login.

### `mode=run` (default) — `GET|POST /api/test-workflow`
**Auth:** `Authorization: Bearer <TEST_WORKFLOW_SECRET>` — env-var-only,
timing-safe compared (`crypto.timingSafeEqual`), fails closed (HTTP 500)
if the env var itself is unset. (Prior to a 2026-08-01 fix this secret was
accepted via `?key=` query string, which is why the header-only requirement
is called out explicitly in the file's own comments.)
**Purpose:** Authenticates as one fixed test user
(`reina-test@ghgrp.net`) by minting a real Supabase session through the
GoTrue admin `generate_link` (magiclink) → `verify` flow — no password, no
account creation — then calls the app's own API endpoints as that user to
exercise the real core pipeline: create lead → create job → set job
workflow → add a material line → create a draft invoice. Every row it
creates is tagged `ZZTESTRUN` and is deleted by exact id in a `finally`
block, so nothing durable is left behind even if a step fails partway.
Separately, it fires four **bookkeeping reachability probes**
(estimate/change-order/purchase-order/expense create) with a deliberately
incomplete payload — these are expected to 422 and never actually create a
financial record; they only prove the endpoint is enabled, auth works, and
the body is parsed. It explicitly never touches Jobber, Twilio, Resend, or
Authorize.net (logged as `SKIPPED_EXTERNAL`).

**Request body / query params:** none besides the auth header (this
default mode ignores `req.query.mode`, i.e. omitting `mode` or passing
anything other than `co`/`cleanup` runs the full pipeline).

**Response:**
```json
{
  "ok": true,
  "testUser": "reina-test@ghgrp.net",
  "tally": { "PASS": 5, "FAIL": 0, "SKIPPED": 0, "REACHABLE": 3, "SKIPPED_EXTERNAL": 3 },
  "steps": [ { "name": "Authenticate as test user", "verdict": "PASS", "note": "..." }, "..." ],
  "cleanup": { "rowsDeleted": 6, "detail": [ { "table": "clients", "filter": "...", "ok": true, "deleted": 1 } ] },
  "note": "Core pipeline creates real rows then self-deletes them by id. Bookkeeping steps are non-creating reachability probes. Externals gated. Run ?mode=cleanup for a sentinel safety sweep."
}
```
If the test-user session can't be minted at all: HTTP 200
`{ "ok": false, "blocked": "generate_link_failed" | "verify_failed", "detail": "..." }`
(deliberately 200, not 5xx — this is a diagnostic result, not a server
error).

---

### `mode=co` — `GET|POST /api/test-workflow?mode=co`
**Auth:** Same bearer secret.
**Purpose:** A separate, more targeted probe: runs a full Change Order
lifecycle against the real engine — create → list → send → approve →
record-payment — using a tagged fake job id, then deletes the one durable
`change_orders` row it created (matched by `data->>jobId`).

**Request body / query params:** `mode=co`.

**Response:**
```json
{
  "ok": true,
  "mode": "co-lifecycle",
  "steps": [
    { "step": "create", "ok": true, "id": "...", "note": "..." },
    { "step": "list", "ok": true, "note": "sees 4 total; ours present" },
    { "step": "send", "ok": true, "note": "..." },
    { "step": "approve", "ok": true, "note": "..." },
    { "step": "record-payment", "ok": true, "note": "..." },
    { "step": "cleanup (durable row)", "ok": true, "note": "deleted 1" }
  ]
}
```

---

### `mode=cleanup` — `GET|POST /api/test-workflow?mode=cleanup`
**Auth:** Same bearer secret.
**Purpose:** A sentinel safety-net sweep, independent of any single run,
that deletes anything still tagged `ZZTESTRUN` across
`product_snapshots`/`job_workflow`/`jobs`/`lead_pipeline`/`invoices`/
`clients` — the backstop for a run that died before its own `finally`
cleanup could execute.

**Request body / query params:** `mode=cleanup`.

**Response:**
```json
{ "ok": true, "mode": "cleanup", "result": [ { "table": "jobs", "filter": "title=like.*ZZTESTRUN*", "ok": true, "deleted": 0 }, "..." ] }
```

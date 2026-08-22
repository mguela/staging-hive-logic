# Core Resource APIs

These are HiveLogic's core, single-purpose business-object endpoints — one
file per resource (clients, jobs, invoices, company, registries, cost model,
team, settings, snapshot, documents, takeoffs). This is distinct from the
large consolidated `api/track1.js` hub, which is documented separately.
Several of these files route more than one operation through a single Vercel
function via a `?resource=` (or `?action=`) query parameter rather than one
endpoint per operation; those are broken out into their own subsections below.

---

## Clients (api/clients.js)

Read-only pull of Jobber-synced clients from Supabase.

### `GET /api/clients`
**Auth:** signed-in user (Bearer Supabase session token, verified against
Supabase's `/auth/v1/user`; no role or company check — any authenticated user
can read).
**Purpose:** List synced Jobber clients, paginated.

**Request body / query params:**
- `limit` (number, optional) — page size; must be a finite positive number or
  falls back to 50; hard-capped at 10000.
- `offset` (number, optional) — row offset; defaults to 0; negative values clamp to 0.
- `order` (string, optional) — `"name"` sorts `name.asc.nullslast`; anything
  else (including omitted) sorts `jobber_updated_at.desc`.

**Response:**
```json
{
  "ok": true,
  "source": "Jobber via Supabase",
  "totalCount": 8656,
  "returned": 50,
  "clients": [
    {
      "id": "jobber_id",
      "name": "string",
      "companyName": "string|null",
      "email": "string|null",
      "balance": 0,
      "isLead": false,
      "isArchived": false,
      "jobberUrl": "string|null",
      "updatedAt": "iso timestamp"
    }
  ]
}
```

Notes: internally loops in ≤1000-row pages against PostgREST to satisfy a
`limit` above PostgREST's own per-request row cap. `getClientsData()` /
`getClientsByIds()` are also exported so `api/chat.js` can call them
in-process instead of an HTTP round-trip.

---

### `POST /api/clients`
**Auth:** signed-in user (same as GET).
**Purpose:** Fetch a specific set of clients by Jobber id, instead of paging the whole table.

**Request body / query params:**
- `ids` (array of strings, required) — Jobber client ids to fetch. Deduplicated,
  capped at 5000, and internally chunked into batches of 250 for the Supabase
  `in.()` filter.

**Response:**
```json
{
  "ok": true,
  "source": "Jobber via Supabase",
  "totalCount": 3,
  "returned": 3,
  "clients": [ { "id": "...", "name": "...", "companyName": "...", "email": "...", "balance": 0, "isLead": false, "isArchived": false, "jobberUrl": "...", "updatedAt": "..." } ]
}
```

Notes: if `req.body.ids` is not a present array, the handler falls through to
the GET (list) behavior instead.

---

## Jobs (api/jobs.js)

Read-only pull of Jobber-synced jobs from Supabase, enriched server-side (via
the `jobs_enriched` view) with client name and geocoded location so the
handler needs exactly one PostgREST round-trip per call.

### `GET /api/jobs?id=<jobber_id>`
**Auth:** signed-in user (same locally-defined Bearer-token check as clients.js).
**Purpose:** Fetch one job by its Jobber id, for the job-detail view.

**Request body / query params:**
- `id` (string, required to trigger this path) — the job's `jobber_id`.

**Response:**
```json
{
  "ok": true,
  "source": "Jobber via Supabase",
  "job": {
    "id": "jobber_id", "title": "string", "clientId": "string",
    "jobNumber": "string|null", "projectSeq": 10001, "projectRef": "J-10001|null",
    "divisionCode": "string|null", "status": "string", "type": "string",
    "total": 0, "startAt": "iso|null", "endAt": "iso|null", "completedAt": "iso|null",
    "jobberUrl": "string|null", "gpsLat": 0, "gpsLng": 0
  }
}
```

Notes: returns 404 `{ ok: false, error: 'Job not found' }` if no row matches.

---

### `GET /api/jobs`
**Auth:** signed-in user.
**Purpose:** List synced jobs, optionally filtered by status.

**Request body / query params:**
- `limit` (number, optional, default 50, capped at 10000)
- `offset` (number, optional, default 0)
- `status` (string, optional) — `"active"` means not archived
  (`job_status != 'archived'`, includes `requires_invoicing`); any other value
  is matched exactly against `job_status`; omitted = unfiltered.

**Response:**
```json
{
  "ok": true,
  "source": "Jobber via Supabase",
  "totalCount": 2700,
  "returned": 50,
  "jobs": [
    {
      "id": "jobber_id", "title": "string", "clientId": "string", "clientName": "string|null",
      "jobNumber": "string|null", "projectSeq": 10001, "projectRef": "J-10001|null",
      "divisionCode": "string|null", "status": "string", "type": "string", "total": 0,
      "startAt": "iso|null", "endAt": "iso|null", "completedAt": "iso|null",
      "createdAt": "iso", "jobberUrl": "string|null", "gpsLat": 0, "gpsLng": 0,
      "city": "string|null", "province": "string|null"
    }
  ]
}
```

Notes: a job has either `jobNumber` (Jobber-synced) or `projectSeq`/`projectRef`
(HiveLogic-created), never both.

---

## Invoices (api/invoices.js)

Read-only pull of Jobber-synced invoices from Supabase.

### `GET /api/invoices`
**Auth:** signed-in user (shared `_lib/auth.js` `requireUser`) **or** Vercel
Cron (Bearer `CRON_SECRET`, checked first via `checkCronSecret`) — lets
unattended read-only checks (daily AR / job-costing) call this without a
Supabase session.
**Purpose:** List synced Jobber invoices with a computed outstanding balance.

**Request body / query params:**
- `limit` (number, optional, default 50, capped at 10000).

**Response:**
```json
{
  "ok": true,
  "source": "Jobber via Supabase",
  "totalCount": 2800,
  "returned": 50,
  "invoices": [
    {
      "id": "jobber_id", "clientId": "string", "invoiceNumber": "string",
      "status": "string", "subject": "string", "total": 0, "payments": 0,
      "deposit": 0, "discount": 0, "balance": 0, "dueDate": "iso|null",
      "issuedDate": "iso|null", "jobberUrl": "string|null"
    }
  ]
}
```

Notes: `balance = max(0, round((total - payments - deposit - discount) * 100) / 100)`
— deposit- and discount-aware, not just `total - payments`. Paginates
internally in 1000-row chunks against PostgREST's cap.

---

## Company (api/company.js)

Company profile, divisions, and integration-connection status. Routes on
`?resource=`. All resources require `requireApiAuth` (signed-in user or Cron
secret) and resolve the tenant from the signed-in user via `companyForUser`.

### `POST /api/company?resource=provision`
**Auth:** signed-in user (must have a real `auth.user.id`).
**Purpose:** Self-serve: a signed-in user with no company creates one and becomes its owner. Idempotent.

**Request body / query params:**
- `name` (string, required) — legal company name.
- `dba`, `primary_trade`, `region`, `timezone` (strings, optional; `timezone` defaults to `America/New_York`).

**Response (201, new company):**
```json
{ "ok": true, "company": { "id": "...", "name": "...", "slug": "...", "plan": "trial", "status": "active", "plan_status": "trialing", "trial_ends_at": "iso" } }
```
Response (200, already has a company): `{ "ok": true, "company": {...}, "already": true }`

Notes: creates `companies` (14-day trial), an owner `company_members` row, and
(ignoring duplicates) a `profiles` row for the user.

---

### `GET /api/company?resource=export`
**Auth:** signed-in user; **owner/admin only** (403 for other roles); 404 if the account has no company.
**Purpose:** Read-only export of the company's own tenant data ("your data is yours" — never deletes anything).

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true, "exported_at": "iso", "company": {...}, "entitlements": {...},
  "data": {
    "divisions": [...], "roster": [...], "cost_lines": [...],
    "cost_assumptions": [...], "company_rates": [...],
    "insurance_policies": [...], "registry_overhead": [...]
  }
}
```

Notes: each table read is best-effort — an unreadable table becomes
`{ "error": "read failed (<status>)" }` rather than failing the whole export.

---

### `GET /api/company?resource=get`
**Auth:** signed-in user; 404 if no company for the account.
**Purpose:** The company profile + divisions + integration status + headcount, for the Company Setup page.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true, "company": {...},
  "divisions": [{ "id": "...", "name": "...", "code": "...", "status": "operational|planned", "trade_slug": "...", "revenue_share_pct": 0, "is_primary": false, "sort_order": 0, "service_center_label": "...", "service_center_lat": 0, "service_center_lng": 0, "service_radius_miles": 0, "service_area_updated_at": "iso" }],
  "integrations": { "jobber": true, "qbo": false, "gusto": false },
  "headcount": { "total": 0, "w2": 0, "contractors": 0, "field": 0 },
  "entitlements": {...},
  "service_area": { "ready": true, "configured": 0, "camera": {...} }
}
```

Notes: if the service-area columns (sql/089) aren't migrated yet, falls back
to a legacy `org_units` select and reports `service_area.ready: false` /
`camera: null` instead of erroring.

---

### `POST /api/company?resource=update` (also `PUT`)
**Auth:** signed-in user; 404 if no company.
**Purpose:** Edit the company profile fields.

**Request body / query params (all optional except constraint on name if provided):**
- `name` (string) — cannot be blank if provided.
- `dba`, `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `phone`, `email`, `website`, `ein`, `license_number`, `timezone`, `primary_trade`, `region`, `industry` (strings) — sending `""` or `null` clears the field to `null`.

**Response:**
```json
{ "ok": true, "company": { "id": "...", "name": "...", "...": "..." } }
```

Notes: `email` is validated against a basic regex (400 if invalid); `state` is
uppercased and truncated to 24 characters. 400 if nothing to update.

---

### `POST /api/company?resource=division_update`
**Auth:** signed-in user; 404 if no company.
**Purpose:** Edit one division's profile and/or service area.

**Request body / query params:**
- `id` (required) — the division's `org_units` id.
- `name`, `code`, `trade_slug`, `revenue_share_pct` (optional).
- `status` (optional) — must be `"operational"` or `"planned"`.
- `service_radius_miles` (optional) — number of miles, `0 < r <= 500`, or `null`/`""` to clear.
- `service_center_label` (optional) — a free-text address; clearing it (empty string) also clears its lat/lng.

**Response:**
```json
{ "ok": true, "division": { "id": "...", "name": "...", "service_center_lat": 0, "service_center_lng": 0, "service_area_updated_at": "iso" } }
```

Notes: setting `service_center_label` triggers a geocode call only when the
label text actually changed; a failed geocode still saves the label with
`service_center_lat`/`lng` set to `null` rather than failing the request or
keeping stale coordinates. The write is scoped to `company_id=eq.<caller's company>` so one tenant cannot edit another's division; 404 if the division isn't found under that scope.

---

## Registries (api/registries.js)

Overhead registries (insurance, licenses, loans, leases, vehicles,
subscriptions) plus two read-only rollups and a Reina cost-proposal review
queue. All resources require `requireApiAuth`, then resolve the company via
`resolveCompany` (a missing company throws and is caught by the outer
try/catch, returning a 500 with `error: "No company for this account."`,
**not** a 404).

### `GET /api/registries?resource=overhead`
**Auth:** signed-in user or Cron.
**Purpose:** Annualized overhead total from the `registry_overhead` view, grouped by section.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "sections": [{ "section": "insurance", "annual_total": 12000, "items": [...] }], "annual_total": 45000 }
```

---

### `GET /api/registries?resource=calendar`
**Auth:** signed-in user or Cron.
**Purpose:** Compliance calendar (soonest first) from `compliance_calendar`.

**Request body / query params:**
- `within_days` (number, optional) — filters to `days_out <= within_days`.

**Response:** `{ "ok": true, "items": [...compliance_calendar rows] }`

---

### `GET /api/registries?resource=proposals`
**Auth:** signed-in user or Cron.
**Purpose:** List Reina's pending (or other-status) cost-line proposals.

**Request body / query params:**
- `status` (string, optional, default `"pending"`).

**Response:** `{ "ok": true, "proposals": [...reina_cost_proposals rows] }`

### `POST /api/registries?resource=proposals`
**Auth:** signed-in user or Cron.
**Purpose:** Bulk approve or reject Reina cost proposals.

**Request body / query params:**
- `action` (string, required) — `"approve"` or `"reject"`.
- `ids` (array, required) OR `id` (single value) — proposal ids to act on.

**Response:**
```json
{ "ok": true, "applied": 1, "rejected": 0, "rates": {...company_rates} }
```

Notes: **approving APPLIES** the proposed value to its target row (via
`proposalTargetPatch`) and marks the proposal `approved`; **rejecting writes
nothing to the target** — it only marks the proposal `rejected` so it is never
re-proposed. Proposals already reviewed or not found are silently skipped
(not counted in either total).

---

### `GET|POST|PATCH|DELETE /api/registries?resource=<insurance|licenses|loans|leases|vehicles|subscriptions>`
**Auth:** signed-in user or Cron.
**Purpose:** CRUD + soft-delete over one overhead registry. Each registry
maps to its own table (`insurance_policies`, `licenses_credentials`,
`loans_obligations`, `leases`, `vehicle_costs`, `subscriptions`) with its own
whitelist of writable columns and its own terminal "archived" status value
(`cancelled`, `suspended`, `paid_off`, `terminated`, `out_of_service`,
`canceled`, respectively).

**Request body / query params:**
- GET — none.
- POST — any of that registry's whitelisted fields (see `REGISTRIES` config in
  the file); required fields vary: `insurance` requires `policy_type`,
  `licenses` requires `credential_type`, `subscriptions` requires `name`;
  `loans`/`leases`/`vehicles` have no required fields.
- PATCH — `id` (required, body or query) + any whitelisted fields to change.
- DELETE — `id` (required, body or query).

**Response (GET/POST/PATCH):** `{ "ok": true, "items"|"item": ..., "rates": {...} }`
**Response (DELETE):** `{ "ok": true, "archived": true, "item": {...}, "rates": {...} }`

Notes: **every mutation returns the recalculated `company_rates` row**
(augmented with `overhead_from_registry`) so the UI never computes anything
itself. `subscriptions` is the one registry that is **NOT company-scoped**
(the `subscriptions` table has no `company_id` column) — its rows are shared
across all companies rather than filtered per tenant. New POST rows default
`source` to `"manual"` when the registry supports that column.

---

## Cost Model (api/cost-model.js)

The ledger behind loaded labor cost, overhead recovery, and break-even math.
Routes on `?resource=`. All resources require `requireApiAuth`, then resolve
the company via `resolveCompany` (missing company → thrown error → 500, same
pattern as registries.js).

### `GET|PUT /api/cost-model?resource=assumptions`
**Auth:** signed-in user or Cron.
**Purpose:** Read or update the company's cost-model assumptions (headcounts, revenue, hours).

**Request body / query params (PUT, all optional numbers):**
`annual_revenue`, `field_headcount`, `office_headcount`, `owner_headcount`,
`paid_hours_per_year`, `pto_days`, `nonbillable_pct`, `vehicle_count`,
`fleet_miles_per_year`, `workdays_per_year`, `target_net_pct`.

**Response:**
```json
{ "ok": true, "assumptions": {...}, "rates": {...} }
```

Notes: the assumptions row is auto-created from defaults
(`paid_hours_per_year: 2080, pto_days: 15, nonbillable_pct: 18,
workdays_per_year: 250, target_net_pct: 10`) the first time it's read.

---

### `GET|POST|PATCH|DELETE /api/cost-model?resource=lines`
**Auth:** signed-in user or Cron.
**Purpose:** CRUD over individual cost-model line items (labor, overhead, reserves, profit target), each with a frequency code that determines how it's annualized.

**Request body / query params:**
- GET — none.
- POST — `section`, `name`, `frequency`, `cost_type` (all required); `note`,
  `amount` (defaults to 0), `source`, `confidence`, `sort_order` (optional).
- PATCH — `id` (required) + any of the POST fields to change.
- DELETE — `id` (required, body or query) — soft delete (`archived: true`).

**Response (GET):**
```json
{ "ok": true, "sections": { "<section>": [{ "...line fields": "...", "annualized": 0 }] }, "count": 12, "rates": {...} }
```
**Response (POST/PATCH):** `{ "ok": true, "line": {...}, "rates": {...} }`
**Response (DELETE):** `{ "ok": true, "archived": true, "line": {...}, "rates": {...} }`

Notes: editing a line whose `source` is `"benchmark"` automatically flips it
to `"confirmed"` unless the caller explicitly sets `source` in the same
request — "a human editing a benchmark line confirms it."

---

### `GET /api/cost-model?resource=rates`
**Auth:** signed-in user or Cron.
**Purpose:** Read the computed rate roll-up (loaded labor rate, overhead per billable hour, break-even revenue/rate, etc.) without touching assumptions or lines.

**Response:**
```json
{
  "ok": true,
  "rates": {
    "billable_hours": 0, "field_wages": 0, "field_burden": 0,
    "loaded_labor_rate": 0, "direct_total": 0, "overhead_total": 0,
    "reserve_total": 0, "profit_target": 0, "gross_margin_pct": 0,
    "net_pct": 0, "breakeven_revenue": 0, "overhead_per_billable_hour": 0,
    "breakeven_hourly_rate": 0, "min_markup_pct": 0,
    "overhead_per_workday": 0, "fleet_cost_per_mile": 0,
    "_source": "view|computed"
  }
}
```

Notes: prefers the SQL view `public.company_rates` (source of truth,
`_source: "view"`); falls back to the JS mirror `computeRates()` if the view
isn't present yet (pre-migration, `_source: "computed"`).

---

### `POST /api/cost-model?resource=seed_from_benchmark`
**Auth:** signed-in user or Cron.
**Purpose:** Copy industry-benchmark cost lines into the company's own `cost_lines`.

**Request body / query params:**
- `trade` (string, optional, default `"design_build"`)
- `size_band` (string, optional, default `"2m_5m"`)
- `region` (string, optional, default `"northeast"`)
- `force` (boolean, optional, default `false`) — required to re-seed a company that already has cost lines.

**Response:** `{ "ok": true, "seeded": 12, "rates": {...} }`, or 409
`{ "ok": false, "error": "Company already has cost lines. Pass force=true to re-seed.", "existing": 12 }`
if lines already exist and `force` wasn't passed, or `{ "ok": true, "seeded": 0, "note": "No benchmarks matched.", "rates": {...} }` if no benchmark rows matched the trade/size/region.

---

### `POST /api/cost-model?resource=import_qbo`
**Auth:** signed-in user or Cron.
**Purpose:** Import a QuickBooks Online chart-of-accounts into cost lines.

**Request body / query params:**
- `commit` (boolean, optional) — **defaults to a dry run.** The import only
  commits writes when `commit === true` is passed explicitly; any other value
  (including omitted) runs `runQboImport({ dryRun: true })`.

**Response:** whatever `runQboImport()` returns, as `result` — status 200 if
`result.ok`, otherwise 502.

Notes: **dry-run by default is the important behavior here** — a caller must
opt in to `commit: true` to actually write imported lines.

---

## Team (api/team.js)

Edit and archive a hire (`employee_pay` row). All resources require
`requireApiAuth` (signed-in user or Cron).

### `POST|PATCH /api/team?resource=hire_update`
**Auth:** signed-in user or Cron.
**Purpose:** Edit a hire's profile/pay, and push a pay change through to Gusto if linked.

**Request body / query params:**
- `id` (required) — the `employee_pay` row id.
- `display_name`, `title`, `is_field` (optional).
- `pay_type` (optional) — must be `"hourly"` or `"salary"`.
- `pay_class` (optional) — must be `"w2"`, `"1099"`, or `"owner"`.
- `base_rate` (optional, number).
- `push_gusto` (boolean, optional, default effectively `true`) — pass `false` to skip the Gusto push even if pay changed.

**Response:**
```json
{ "ok": true, "item": {...updated employee_pay row}, "gusto_push": null }
```

Notes: `gusto_push` is `null` unless `pay_type` or `base_rate` actually
changed **and** the hire has a linked `gusto_job_uuid`; in that case it's
either the result of `updateGustoCompensation()` or
`{ "ok": false, "error": "Gusto not connected — HiveLogic updated, Gusto not." }`
if Gusto isn't connected. **This endpoint does not scope its read/update by
`company_id`** — `getHire(id)` and the PATCH both filter only on the row `id`,
unlike `registries.js`/`cost-model.js`, which always add
`company_id=eq.<tenant>` to every query.

---

### `POST /api/team?resource=hire_archive`
**Auth:** signed-in user or Cron.
**Purpose:** Archive a hire without touching Gusto.

**Request body / query params:**
- `id` (required).

**Response:**
```json
{
  "ok": true, "archived": true,
  "gusto_termination_needed": true,
  "gusto_employee_uuid": "string|null",
  "note": "Archived in HiveLogic. Terminate them in Gusto to stop payroll — this never auto-terminates."
}
```

Notes: non-destructive — only sets `employee_pay.effective_to` to today's
date; **never calls Gusto to terminate**, only flags that a linked Gusto
employee needs manual termination there.

---

## Settings (api/settings.js)

Company Setup sections with no other backing table: business hours, payment
terms, the numbering law, and automation toggles (one JSONB row per
company/section). Deliberately does not serve company profile, rates,
divisions, roles, or overhead — those live in `company.js`/`cost-model.js`/`registries.js`.

### `GET /api/settings` / `GET /api/settings?section=<hours|payment_terms|numbering|automations>`
**Auth:** signed-in user with a resolved company (`requireApiAuth` + `companyForUser`); 404 if the account has no company.
**Purpose:** Read one or all Company Setup sections, merged over built-in defaults.

**Request body / query params:**
- `section` (string, optional) — one of `hours`, `payment_terms`, `numbering`, `automations`; 400 if an unknown value is passed.

**Response:**
```json
{
  "ok": true, "table_missing": false, "saved_sections": ["hours"],
  "sections": { "hours": {...}, "payment_terms": {...}, "numbering": {...}, "automations": {...} },
  "meta": { "hours": { "saved": true, "updated_at": "iso", "updated_by": "uuid" } },
  "can_edit": true
}
```

Notes: **pre-migration behavior** — until `sql/086_company_settings.sql` is
applied, this returns `200` with `table_missing: true`, `saved_sections: []`,
and `sections` filled entirely from `SECTION_DEFAULTS`, plus an explanatory
`note`, instead of erroring. `can_edit` reflects whether the caller's role is
`owner` or `admin`.

---

### `POST /api/settings` (also `PUT`)
**Auth:** signed-in user; **admin/owner only** (403 otherwise — same rule RLS enforces at the database).
**Purpose:** Upsert one Company Setup section.

**Request body / query params:**
- `section` (string, required) — one of `hours`, `payment_terms`, `numbering`, `automations`.
- `value` (object, required) — validated per-section:
  - `payment_terms.schedule` entries must each have a `label` and a `pct` in `0–100`, and the set must total exactly 100% (rounded to 2dp); `ach_preferred_over_cents` must be a non-negative integer.
  - `hours.days` keys must be `0`–`6`; non-closed days need `HH:MM` open/close with close after open.
  - `numbering` patterns must be non-blank, ≤40 characters, and contain `{n}` or `{seq}`.

**Response:**
```json
{ "ok": true, "section": "hours", "value": {...}, "updated_at": "iso" }
```

Notes: **pre-migration writes return 503** —
`{ "ok": false, "table_missing": true, "error": "Company settings storage is not set up yet — sql/086_company_settings.sql has not been applied. Nothing was saved." }`
— never a silent failure or a fake success. A partial `value` is merged over
`SECTION_DEFAULTS` before storing, so keys the caller didn't send are never dropped.

---

## Snapshot (api/snapshot.js)

### `GET /api/snapshot`
**Auth:** signed-in user (`_lib/auth.js` `requireUser`) **or** Vercel Cron (Bearer `CRON_SECRET`, checked first).
**Purpose:** Aggregate counts and AR outstanding across all synced Jobber records (clients, jobs, invoices), for dashboards and the daily AR/Business Pulse checks.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "source": "Jobber via Supabase", "snapshot": {...rpc/snapshot_aggregates() result} }
```

Notes: computed in one Postgres RPC call (`public.snapshot_aggregates()`)
rather than paginating clients/jobs/invoices client-side in Node (previously
~15 PostgREST round-trips per call). Only `awaiting_payment`/`past_due`
invoices count as collectable AR, with an `excluded` breakdown carried in the
RPC's own result for transparency. `getSnapshotData()` is also exported for
`api/chat.js` to call in-process.

---

## Documents (api/documents.js)

### `POST /api/documents`
**Auth:** signed-in user (`_lib/auth.js` `requireUser`); no company scoping.
**Purpose:** AI-classify an uploaded document's type from its filename and (optionally) a page/image sample, for the Documents feature's upload flow.

**Request body / query params:**
- `filename` (string, required, ≤255 characters).
- `mimeType` (string, optional, ≤100 characters).
- `dataBase64` (string, optional) — a base64 sample of the file; rejected with
  413 if it decodes to more than `MAX_CLASSIFIER_SAMPLE_BYTES` (3 MB), or 400
  if it isn't valid base64.

**Response:**
```json
{ "ok": true, "suggestion": { "docType": "invoice", "confidence": 0.82, "reasoning": "one short sentence" } }
```
`docType` is one of `contract`, `permit`, `invoice`, `estimate`, `photo`, `payroll`, `other`.

Notes: calls Claude (`ANTHROPIC_API_KEY`-gated, model from `CLASSIFIER_MODEL`
env var or default `claude-sonnet-4-5`) with the PDF/image sample when
provided; falls back to a lower-confidence filename-keyword heuristic
(`fallbackClassify`) if Claude is unavailable, errors, or no sample was sent.
**Never touches the database** — the browser writes the confirmed choice to
Supabase itself (RLS-gated) after the user confirms the suggestion.

---

## Takeoffs (api/takeoffs.js)

HiveGrid Live Workbench takeoff persistence: measurement data (conditions,
marks, per-sheet metadata) plus the underlying plan-sheet pixels, tied to a
Jobber quote.

### `GET /api/takeoffs?action=sign&path=<storagePath>`
**Auth:** signed-in user (`_lib/auth.js` `requireUser`).
**Purpose:** Get a short-lived signed URL for a previously uploaded takeoff sheet image.

**Request body / query params:**
- `path` (string, required) — the storage path returned by the `upload_image` action.

**Response:** `{ "ok": true, "url": "https://.../object/sign/media/...", "expiresIn": 3600 }`

Notes: returns 502 `{ ok: false, error: 'Could not sign that image path.' }` if the file can't be signed (e.g. missing).

---

### `GET /api/takeoffs?id=<id>` / `GET /api/takeoffs?quote_id=<quoteId>`
**Auth:** signed-in user.
**Purpose:** Fetch one takeoff by id, or all takeoffs for a quote.

**Request body / query params:**
- `id` (string) — fetch a single takeoff.
- `quote_id` (string) — required if `id` is absent; lists all takeoffs for that quote, newest-updated first.

**Response (by id):**
```json
{ "ok": true, "takeoff": { "id": "...", "quoteId": "...", "jobId": "...", "title": "...", "conditions": [], "marks": [], "sheets": [], "status": "draft", "createdBy": "...", "createdAt": "iso", "updatedAt": "iso" } }
```
**Response (by quote_id):** `{ "ok": true, "takeoffs": [ {...same shape...} ] }`

Notes: 404 if `id` given but not found; 400 if neither `id` nor `quote_id` is given.

---

### `POST /api/takeoffs` (upload image)
**Auth:** signed-in user.
**Purpose:** Upload the raw pixels for one takeoff sheet (separate from the measurement JSON) into the private "media" Storage bucket.

**Request body / query params:**
- `action` = `"upload_image"` (required to select this path).
- `quote_id` (required), `sheet_index` (required), `data_url` (required) — a base64 data URL (e.g. from `canvas.toDataURL()`).

**Response:** `{ "ok": true, "storagePath": "media/takeoffs/<quote_id>/sheet-<n>-<ts>.png" }`

---

### `POST /api/takeoffs` (create / update)
**Auth:** signed-in user.
**Purpose:** Create a new takeoff, or update an existing one when `id` is supplied.

**Request body / query params:**
- `id` (optional) — presence updates that row instead of creating one.
- `quote_id` (required to create if `id` is absent).
- `job_id`, `title`, `status` (optional, default `"draft"`), `created_by` (optional).
- `conditions`, `marks`, `sheets` (arrays, optional; default to `[]` if not arrays).

**Response:**
```json
{ "ok": true, "takeoff": { "id": "...", "quoteId": "...", "jobId": "...", "title": "...", "conditions": [], "marks": [], "sheets": [], "status": "draft", "createdBy": "...", "createdAt": "iso", "updatedAt": "iso" } }
```

Notes: returns 404 if an `id` was given for update but no matching row exists;
400 if neither `id` nor `quote_id` is present when creating.

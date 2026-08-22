# track1.js API Reference — Part 1 (A–M)

`api/track1.js` consolidates dozens of otherwise-unrelated resources behind one Vercel serverless function, dispatched by a `resource=` query param, checked via `if (resource === 'name') return handleName(req, res);` inside one big `export default async function handler(req, res)`. It exists because Vercel's plan-level serverless-function-count cap forced consolidation of what would otherwise be many single-purpose route files.

There are 100 unique resources dispatched through this file's `resource === '...'` chain. This doc covers the first alphabetical half (50 resources, `app_status_attachment_upload` through `materials_nickname_save`); the sibling `track1-part2.md` covers the rest (`materials_overview` through `workforce_team_status`).

**Global auth gate:** unless a resource is explicitly exempted (`reina_lab_read`, `workforce_sweep_gone`, `workforce_auto_clockout`, the Monitor-agent resources, and `check_new_leads`), every request first passes through `gate = await requireApiAuth(req)` — a valid signed-in Supabase session, or a `CRON_SECRET` bearer token for Vercel Cron. `401 { "ok": false, "error": "Not signed in -- log into HiveLogic first." }` otherwise. A further six resources (`cash`, `leaks`, `overhead`, `forecast`, `watching_margin_fade`, `jobs_margin_list` — split across both docs) are in `FINANCIAL_RESOURCES` and require `admin`/`superadmin`, or a dispatch-permission-role of `owner`/`office_ar`, unless the request came in via the cron-secret path.

**Quick index:** app_status_attachment_upload · app_status_create · app_status_findings · app_status_update · capacity_backlog_by_month · capacity_crew_hours · cash · cc_bundle · cc_layouts · check_new_leads · client_location · create_client · create_invoice · create_invoice_from_job · create_job · crew_schedule · dailybrief · dispatch_alerts · dispatch_settings · employee_roster · forecast · hiveconnect_backfill · inventory_adjust · inventory_adjustments · inventory_items · inventory_purchase_orders · inventory_stock · job_line_items · job_readiness_override · job_readiness_set · job_workflow_list · job_workflow_set · jobs_margin_list · leads · leaks · mail · mailcallback · mailconnect · mailstatus · manager_gh_updates · manager_materials_pnl · maplocations · mark_invoice_paid · materials_adapters · materials_cart_add · materials_cart_attach · materials_cart_get · materials_cart_remove · materials_get · materials_nickname_save

## Dev To-Do / App Status Tracker

Admin-only (`canManageDevTodo`: `admin`/`superadmin`, or a dispatch permission role of `owner`).

### `POST /api/track1?resource=app_status_attachment_upload`
**Auth:** Admin/superadmin/owner.
**Purpose:** Attaches a screenshot to a Dev To-Do finding.

**Request body / query params:**
- `finding_id` (string, required, UUID)
- `imageBase64` (string, required) — validated by magic bytes (PNG/JPEG), not by client-declared content type.

**Response:**
```json
{ "ok": true, "resource": "app_status_attachment_upload", "attachment": { "id": "...", "finding_id": "...", "storage_path": "...", "content_type": "...", "created_by": "...", "created_at": "..." } }
```

Notes: capped at `MAX_ATTACHMENTS_PER_FINDING = 4` per finding. Uploads to the Supabase Storage bucket `devtodo-attachments`.

### `POST /api/track1?resource=app_status_create`
**Auth:** Admin/superadmin/owner.
**Purpose:** Manually reports a blocker/finding.

**Request body / query params:**
- `source` (string, required) — one of `manual_blocker`, `mock_ui`, `owner_decision`, `external_blocker`.
- `title` (string, required, ≥4 chars)
- `detail` (string, optional, default: "Reported without additional detail.")
- `severity` (string, optional, default `medium`) — `critical`/`high`/`medium`/`low`.
- `assigned_to`, `due_date` (`YYYY-MM-DD`) — optional.

**Response:**
```json
{ "ok": true, "resource": "app_status_create", "finding": {}, "notification": { "attempted": true, "delivered": true } }
```

Notes: findings are fingerprinted by `source|title` — a repeat report refreshes the same row instead of duplicating it. A newly-created `critical`/`high` finding also best-effort posts to a HiveConnect bot channel; a notification failure is reported in `notification.error` without failing the create.

### `GET /api/track1?resource=app_status_findings`
**Auth:** Admin/superadmin/owner.
**Purpose:** Lists Dev To-Do findings.

**Response:**
```json
{ "ok": true, "resource": "app_status_findings", "findings": [] }
```

Notes: capped at 200 rows, ordered by `last_seen_at desc`; each finding includes a short-lived (5 min) signed URL for any attachment.

### `POST /api/track1?resource=app_status_update`
**Auth:** Admin/superadmin/owner.
**Purpose:** Triages a finding — changes its status or adds a note.

**Request body / query params:**
- `id` (string, required, UUID)
- `status` (string, optional) — `open`/`in_progress`/`resolved`/`ignored`.
- `note` (string, optional, ≤2000 chars)

**Response:**
```json
{ "ok": true, "resource": "app_status_update", "finding": {} }
```

Notes: closing (`resolved`/`ignored`) stamps `resolved_at`/`resolved_by`; reopening clears both.

## Capacity Planning

### `GET /api/track1?resource=capacity_backlog_by_month`
**Auth:** Signed-in user.
**Purpose:** Buckets real signed-job totals by scheduled start month.

**Request body / query params:**
- `months` (number, optional, 1–12, default 4)

**Response:**
```json
{ "ok": true, "resource": "capacity_backlog_by_month", "months": [ { "key": "...", "label": "...", "total": 0, "jobCount": 0 } ], "unscheduledSkipped": 0 }
```

Notes: jobs with no `start_at` are excluded from every month and counted separately in `unscheduledSkipped`, rather than defaulting into the current month.

### `GET /api/track1?resource=capacity_crew_hours`
**Auth:** Signed-in user.
**Purpose:** Real scheduled hours from the visit calendar, grouped by technician.

**Request body / query params:**
- `days` (number, optional, 1–180, default 30)

**Response:**
```json
{ "ok": true, "resource": "capacity_crew_hours", "days": 30, "rangeStart": "...", "rangeEnd": "...", "crew": [ { "name": "...", "hours": 0 } ] }
```

Notes: sorted busiest-first. Deliberately does not compute a "% of capacity" figure, since no expected-hours-per-week setting exists anywhere in HiveLogic yet.

## Financial Intelligence

`cash`, `leaks`, `jobs_margin_list` are all in `FINANCIAL_RESOURCES` — admin/superadmin, or a dispatch permission role of `owner`/`office_ar`.

### `GET /api/track1?resource=cash`
**Auth:** Admin/superadmin, or owner/office_ar.
**Purpose:** True available cash: bank balance, near-term bills, tax liabilities.

**Response:**
```json
{ "ok": true, "source": "QuickBooks (bank + bills) -- live", "asOf": "...", "bankBalance": 0, "bankAccounts": [], "billsDue14": 0, "billsDue14Count": 0, "taxLiabilities": 0, "taxAccounts": [], "trueAvailable": 0, "weeks": [ { "weekStart": "...", "total": 0, "billCount": 0, "topVendors": [] } ], "notConnected": { "payroll": "...", "depositsHeld": "...", "debtService": "..." } }
```

Notes: QuickBooks not connected → `200 { "ok": false, "error": "QuickBooks is not connected yet. Visit /api/qbo to authorize." }`. Explicitly reports `notConnected` reasons instead of fabricating numbers for data it doesn't have.

### `GET /api/track1?resource=forecast`
**Auth:** Admin/superadmin, or owner/office_ar (it's in `FINANCIAL_RESOURCES`, but is documented here in Part 1 for topical grouping since it's alphabetically part of this half's range).
**Purpose:** An 8-week cash-flow ladder plus scheduled/approved-but-unscheduled job backlog.

**Response:**
```json
{ "ok": true, "source": "...", "asOf": "...", "horizonDays": 56, "weeks": [ { "weekStart": "...", "cashIn": 0, "cashOut": 0, "net": 0 } ], "backlog": { "scheduledNotYetInvoiced": {}, "approvedNotYetScheduled": {}, "backlogTotal": 0, "confidenceScore": 0, "confidenceNote": "..." }, "notAvailable": { "unquotedPipeline": "...", "revisedInvoiceAmounts": "..." } }
```

Notes: pulls from QuickBooks bills/invoices and Jobber-synced quotes/jobs. Backlog is bucketed into six 28-day windows.

### `GET /api/track1?resource=leaks` (`handleFiLeaks`)
**Auth:** Admin/superadmin, or owner/office_ar.
**Purpose:** Finds real money leaks: completed-but-not-invoiced jobs, past-due invoices, bad debt.

**Response:**
```json
{ "ok": true, "source": "Jobber via Supabase -- live", "asOf": "...", "completedNotInvoiced": { "count": 0, "nonZeroCount": 0, "sumOfPricedJobs": 0, "sumRemainingToBill": 0, "sample": [] }, "pastDueInvoices": { "count": 0, "sum": 0, "aging": { "d0_30": 0, "d31_60": 0, "d61_90": 0, "d90plus": 0 }, "sample": [] }, "badDebtInvoices": { "count": 0, "sum": 0 }, "notConnected": {} }
```

Notes: purely a read/aggregation — no writes.

### `GET /api/track1?resource=overhead` (`handleFiOverhead`)
**Auth:** Admin/superadmin, or owner/office_ar (in `FINANCIAL_RESOURCES`).
**Purpose:** Owner-draw vs. total-overhead ratio, plus a stubbed hook for "can we hire" / "can we expand" checks once cost thresholds are configured.

**Response:**
```json
{ "ok": true, "source": "QuickBooks -- live", "period": "...", "ownerDrawAccounts": [ { "name": "...", "balance": 0 } ], "ownerDraw": 0, "totalOverheadYTD": 0, "ownerCostPct": 0, "notAvailable": { "dynamicAllocation": "...", "canWeHire": "...", "canWeExpand": "..." } }
```

Notes: `ownerDraw` sums the absolute balance of every Equity account whose name matches `/draw|owner/i`. `totalOverheadYTD` comes from the P&L's `Total Expenses` row. `notAvailable.dynamicAllocation` explains that a real per-job overhead split isn't possible yet — QuickBooks Class tracking is empty and synced Jobber expenses have no `job_id`. `canWeHire`/`canWeExpand` are dormant until someone gives Reina a fully-loaded hire cost or a safe-cash-reserve threshold to compute against.

### `GET /api/track1?resource=jobs_margin_list`
**Auth:** Admin/superadmin, or owner/office_ar. Also reachable via the CRON_SECRET path (allowlisted at the edge for GET).
**Purpose:** Lists active jobs' real contract-vs-actual-cost margin, joining Jobber contract data with QuickBooks Customer:Job cost data.

**Response:**
```json
{ "ok": true, "source": "...", "asOf": "...", "costDataAsOf": "...", "activeJobsScanned": 0, "activeJobsWithCostData": 0, "jobs": [ { "jobNumber": "...", "title": "...", "contractTotal": 0, "hasCostData": true, "actualCostSoFar": 0, "marginPct": 0, "percentOfContractSpent": 0, "url": "...", "jobberId": "..." } ], "coverageNote": "..." }
```

Notes: cached in-memory with a 50-second TTL, stale-while-revalidate — responds first, then triggers a background QuickBooks re-scan after the response is sent if the cached cost data is stale.

### `GET /api/track1?resource=manager_materials_pnl`
**Auth:** Signed-in user.
**Purpose:** Materials spend report, sourced from a Google Sheet, not Supabase.

**Response:**
```json
{ "ok": true, "resource": "manager_materials_pnl", "source": "Materials Purchased Mastersheet (Google Sheet)", "headers": [], "rows": [], "totalRows": 0, "totalSpend": 0, "jobsCovered": 0, "fetchedAt": "..." }
```

Notes: an external Google Sheets read, not Supabase. Rows are truncated to the most recent `SHEET_ROW_CAP` if the sheet is larger, but `totalRows`/`totalSpend`/`jobsCovered` are computed off the full, untruncated data.

## Command Center Bundle & Layout

### `GET /api/track1?resource=cc_bundle`
**Auth:** Signed-in user.
**Purpose:** Fans out to 7 other resource handlers concurrently and merges their output into one payload, to cut down Command Center's per-load API call count.

**Response:**
```json
{ "ok": true, "resource": "cc_bundle", "maplocations": {}, "job_workflow_list": {}, "watching_bridge_status": {}, "dispatch_alerts": {}, "today_schedule": {}, "leads": {}, "crew_schedule": {} }
```

Notes: deliberately does NOT bundle `watching_unscheduled`/`watching_margin_fade`, since the latter is a slow (10-15s) QuickBooks job-costing scan that would block the fast calls.

### `GET/POST/PATCH/DELETE /api/track1?resource=cc_layouts`
**Auth:** Signed-in user (own layouts only, scoped by `user_id`).
**Purpose:** CRUD for a user's saved Command Center widget layouts.

**Request body / query params:**
- POST: `name` (required), `layout` (required — `{ widgets: [{id,x,y,w,h}] }`), `is_active` (optional).
- PATCH: `id` (required), plus any of `name`/`layout`/`is_active`.
- DELETE: `id` (required).

**Response:**
```json
{ "ok": true, "resource": "cc_layouts", "layouts": [] }
```

Notes: server-side validation guarantees the "Today's Decisions" widget (`id: 'cc-brief'`) can never be removed from any layout, no matter what a crafted payload contains. Enforces one active layout per user by clearing other active rows before activating a new one.

### `GET /api/track1?resource=maplocations`
**Auth:** Signed-in user.
**Purpose:** Geocoded job map data for the Service Area Map.

**Response:**
```json
{ "ok": true, "source": "Jobber via Supabase (real client addresses, US Census geocoding)", "office": { "address": "...", "lat": 0, "lng": 0 }, "geocodedClients": 0, "jobsWithLocation": 0, "activeJobsTotal": 0, "points": [ { "jobId": "...", "jobNumber": "...", "title": "...", "lat": 0, "lng": 0, "techs": [] } ], "clusters": [ { "city": "...", "province": "...", "jobCount": 0, "jobTotal": 0, "lat": 0, "lng": 0, "distanceMi": 0 } ] }
```

Notes: distance is haversine (straight-line), not drive-time.

### `GET /api/track1?resource=dailybrief`
**Auth:** Signed-in user — deliberately not in `FINANCIAL_RESOURCES`, so every role can see the Business Pulse tile.
**Purpose:** Reina's daily brief — cash runway, past-due invoices, stalled jobs, today's visit count, open quotes, weather, and a synthesized headline/decisions list.

**Response:**
```json
{ "ok": true, "source": "Reina Daily Brief -- QuickBooks + Jobber via Supabase, live", "asOf": "...", "headline": "...", "decisions": [], "weather": {}, "cash": {}, "cashRunway": {}, "pastDueInvoices": {}, "completedNotInvoiced": {}, "todaysVisits": 0, "openQuotes": {}, "stalledJobs": {}, "notConnected": {} }
```

Notes: 6 independent data-gathering blocks run concurrently, each degrading to a `notConnected` note on its own failure rather than failing the whole brief. Cached (~10 min cycle per the code comments).

### `GET /api/track1?resource=dispatch_alerts`
**Auth:** Signed-in user.
**Purpose:** Real, computed-from-data dispatch alerts — no LLM/heuristic guessing.

**Response:**
```json
{ "ok": true, "resource": "dispatch_alerts", "date": "...", "alertCount": 0, "alerts": [ { "type": "running_behind" }, { "type": "gap" }, { "type": "overlap" }, { "type": "unassigned" } ], "note": "..." }
```

Notes: flags running-behind visits (past scheduled end, no `completed_at`), idle gaps ≥45 min between visits, double-booked overlaps, and unassigned visits.

### `GET/POST /api/track1?resource=dispatch_settings`
**Auth:** Signed-in user for reads; admin/superadmin, or owner/project_manager/dispatch permission role, for the POST write path.
**Purpose:** The dispatch freeze-window setting.

**Request body / query params:**
- POST: `enabled` (boolean, optional), `minutes` (number, optional, 0–240)

**Response:**
```json
{ "ok": true, "enabled": true, "minutes": 60 }
```

Notes: `403` on the write path for a caller without the required role. Stored as a shared single-row setting, not per-user.

### `GET /api/track1?resource=crew_schedule`
**Auth:** Signed-in user.
**Purpose:** Today's crew assignments, unassigned visits, and live vehicle positions.

**Response:**
```json
{ "ok": true, "resource": "crew_schedule", "date": "...", "crews": [], "unassignedVisits": [], "vehicles": [ { "name": "...", "status": "...", "speed": 0, "lat": 0, "lng": 0, "updatedAt": "...", "source": "...", "stale": false, "arrivedAt": null, "departedAt": null, "presenceJobNumber": null } ], "vehicleAssignments": [], "coverageNote": "..." }
```

Notes: vehicle positions prefer FleetSharp over Jobber's own (frozen) GPS feed; `arrivedAt`/`departedAt`/`presenceJobNumber` come from the geofence engine (`fleet_job_presence`), joined by VIN.

## Leads, Clients & Manual Record Creation

Every resource in this group requires only a signed-in user (`getRequestingProfile`) — no role restriction — and every created record is explicitly HiveLogic-only, never pushed to Jobber.

### `GET /api/track1?resource=check_new_leads`
**Auth:** Vercel Cron only — a hand-rolled exact-match check against `process.env.CRON_SECRET` (not the shared `checkCronSecret()`/`requireApiAuth()` helper), and the one resource explicitly exempted from the global auth gate.
**Purpose:** Scans for new leads in the last 3 days and SMS-alerts on genuinely new ones.

**Response:**
```json
{ "ok": true, "resource": "check_new_leads", "checked": 0, "newlyAlerted": 0 }
```

Notes: idempotent via an atomic ignore-duplicates insert into `lead_alerts_sent`. SMS is best-effort (via Twilio) and capped at the first 5 newly-alerted leads per run.

### `GET /api/track1?resource=client_location`
**Auth:** Signed-in user.
**Purpose:** Single-client address lookup (deliberately not a bulk client list).

**Request body / query params:**
- `clientId` (string, required)

**Response:**
```json
{ "ok": true, "resource": "client_location", "found": true, "address": "...", "street": "...", "city": "...", "province": "...", "postalCode": "..." }
```

### `POST /api/track1?resource=create_client`
**Auth:** Signed-in user.
**Purpose:** Creates a new HiveLogic-only client (not synced to Jobber).

**Request body / query params:**
- At least one of `firstName`/`lastName`, or `companyName` (required)
- `email` (optional)

**Response:**
```json
{ "ok": true, "resource": "create_client", "client": {}, "note": "Saved in HiveLogic. Not pushed to Jobber yet -- Jobber write-back is a later phase." }
```

### `POST /api/track1?resource=create_invoice`
**Auth:** Signed-in user.
**Purpose:** Creates a draft, HiveLogic-only invoice with a flat dollar amount.

**Request body / query params:**
- `amount` (number, required, > 0)
- `dueDate`, `clientId` (optional)

**Response:**
```json
{ "ok": true, "resource": "create_invoice", "invoice": {}, "note": "Saved as a DRAFT in HiveLogic. Not sent to the client and not in Jobber/QuickBooks yet." }
```

### `POST /api/track1?resource=create_invoice_from_job`
**Auth:** Signed-in user.
**Purpose:** Creates a draft invoice from a job's real line items (or its lump-sum total if it has no itemized lines).

**Request body / query params:**
- `jobRef` (string, required)
- `allowDuplicate` (boolean, optional) — bypasses the duplicate-invoice guard.
- `dueDate` (optional)

**Response:**
```json
{ "ok": true, "resource": "create_invoice_from_job", "invoice": {}, "lineCount": 0, "amount": 0, "note": "..." }
```

Notes: `409` with `needsConfirm: true` if the job already has invoices and `allowDuplicate` wasn't set — an explicit double-billing guard.

### `POST /api/track1?resource=create_job`
**Auth:** Signed-in user.
**Purpose:** Creates a new HiveLogic-only job, with optional T&M rate assignment.

**Request body / query params:**
- `title` (string, required)
- `schedule` (`'unscheduled'` or else `active`), `isTm` (boolean), `tmServiceType` (required if `isTm`), `clientId`, `total`, `division`, `notes`, `lineItems` (array)

**Response:**
```json
{ "ok": true, "resource": "create_job", "job": {}, "jobRef": "...", "isTm": false, "warnings": [], "note": "..." }
```

Notes: a T&M hourly rate is always looked up server-side from `tm_rate_types` — never trusted from the client. `409` (`PROJECT_NUMBER_TAKEN`) is possible from the underlying job-numbering allocator.

### `GET/POST/PATCH /api/track1?resource=leads`
**Auth:** Signed-in user.
**Purpose:** The HiveLogic lead pipeline — list, create, and update-stage.

**Request body / query params:**
- POST: at least one of first/last name or company name; optional `estimatedValue`, `leadSource`, `division`, etc.
- PATCH: `clientId` (required), `stage` (must be a valid `LEAD_STAGES` value), `lostReason` (required if `stage: 'lost'`)

**Response:**
```json
{ "ok": true, "source": "HiveLogic lead pipeline", "totalCount": 0, "leads": [] }
```

Notes: POST is a plain insert (not upsert) — deliberately allows multiple opportunities per client. Auto-stamps `first_contacted_at` the first time a lead leaves the "new" stage.

### `POST /api/track1?resource=mark_invoice_paid`
**Auth:** Signed-in user.
**Purpose:** Marks a HiveLogic-created (`HL-INV-` prefixed) invoice paid — status only.

**Request body / query params:**
- `id` (string, required)

**Response:**
```json
{ "ok": true, "resource": "mark_invoice_paid", "invoice": {}, "note": "Status only. No payment was processed and nothing was sent to the client." }
```

Notes: a real Jobber-synced invoice is explicitly rejected — this can only mark a manually-created invoice paid, pointing users to Jobber/QuickBooks otherwise.

## Jobs: Line Items, Readiness & Workflow

`job_line_items`, `job_readiness_set`, and `job_readiness_override` all require only a signed-in user — no role/permission check, and none are in `FINANCIAL_RESOURCES`.

### `GET/POST /api/track1?resource=job_line_items`
**Auth:** Signed-in user.
**Purpose:** Reads or fully replaces a job's line items.

**Request body / query params:**
- GET: `jobRef` (required)
- POST: `jobRef` (required), `lines` (array of `{description, quantity, unitPrice}`)

**Response:**
```json
{ "ok": true, "resource": "job_line_items", "jobRef": "...", "lines": [], "total": 0 }
```

Notes: POST is a full delete-then-insert replace, not a merge, and is not wrapped in a DB transaction.

### `POST /api/track1?resource=job_readiness_override`
**Auth:** Signed-in user (no extra role check inside the handler).
**Purpose:** Logs an override of a failing job-readiness gate, always with a reason.

**Request body / query params:**
- `jobRef` (required)
- `clear: true`, OR `by` + `reason` (both required to set an override)

**Response:**
```json
{ "ok": true, "resource": "job_readiness_override", "workflow": {} }
```

Notes: always logged with who and why — the code comment states this is meant to be the only way to bypass a failing readiness gate for scheduling.

### `POST /api/track1?resource=job_readiness_set`
**Auth:** Signed-in user (no extra role check inside the handler).
**Purpose:** Marks one item of the job-readiness checklist done or not-done.

**Request body / query params:**
- `jobRef` (required), `itemKey` (required, e.g. `client.start_date`), `done` (boolean, required), `by` (optional)

**Response:**
```json
{ "ok": true, "resource": "job_readiness_set", "workflow": {} }
```

Notes: toggling an already-done item back to done doesn't reset its original completion timestamp; unchecking clears it. The deposit-received checklist item is the one exception — the frontend reads it directly from `deposit_paid_at` rather than this endpoint.

### `GET /api/track1?resource=job_workflow_list`
**Auth:** Signed-in user.
**Purpose:** Paginated full read of the `job_workflow` table.

**Response:**
```json
{ "ok": true, "resource": "job_workflow_list", "rows": [] }
```

### `POST /api/track1?resource=job_workflow_set`
**Auth:** Signed-in user.
**Purpose:** Partially updates a job's workflow fields (deposit, setup, materials status, hold status).

**Request body / query params:**
- `jobRef` (required); optional `depositRequired`, `depositAmount`, `depositPaid`, `setupComplete`, `materialsStatus`, `materialsEta`, `onHold`, `onHoldReason`, `notes`, `updatedBy`

**Response:**
```json
{ "ok": true, "resource": "job_workflow_set", "workflow": {} }
```

Notes: a boolean field (e.g. `depositPaid`) only stamps its timestamp the first time it flips true — repeat toggles preserve the original timestamp. Any omitted field keeps its existing stored value rather than being cleared.

## Employee Roster

### `GET/POST /api/track1?resource=employee_roster`
**Auth:** Signed-in user for GET; admin/superadmin only for POST.
**Purpose:** Reads or updates a person's scheduling "lens" (crew/office/sub/hidden/unassigned), division, and permission roles.

**Request body / query params:**
- POST: `jobberId` (required), `lens` (required, one of `crew`/`office`/`sub`/`hidden`/`unassigned`), `division`, `crewLabel`, `color`, `permissionRoles` (array) / legacy `permissionRole`, `isLead` (optional — carried forward from the prior value if omitted)

**Response:**
```json
{ "ok": true, "resource": "employee_roster", "isAdmin": true, "roster": [], "counts": {}, "coverageNote": "..." }
```

Notes: `403` on POST for a non-admin. POST deliberately merges rather than replaces `permissionRoles`/`isLead` when the payload omits those fields, to support a partial edit (e.g. just toggling crew-lead) without wiping legacy role values.

## Inventory

All 5 inventory resources independently re-check `getRequestingProfile` + `canManageInventory` (admin/superadmin) on top of the global gate.

### `POST /api/track1?resource=inventory_adjust`
**Auth:** Admin/superadmin.
**Purpose:** Adjusts a stock item's quantity at a location (warehouse or a specific truck).

**Request body / query params:**
- `stockItemId` (required), `locationKey` (required — `warehouse` or `truck:<vehicleId>`), `delta` (required, non-zero number), `reason` (optional)

**Response:**
```json
{ "ok": true, "stockItemId": "...", "locationKey": "...", "quantity": 0 }
```

Notes: `400` if the adjustment would take the item below zero. Writes an audit row to `stock_adjustments` in addition to updating `stock_on_hand`.

### `GET /api/track1?resource=inventory_adjustments`
**Auth:** Admin/superadmin.
**Purpose:** Lists the inventory adjustment/usage history.

**Response:**
```json
{ "ok": true, "resource": "inventory_adjustments", "adjustments": [] }
```

Notes: capped at 200 rows, no further pagination.

### `GET/POST /api/track1?resource=inventory_items`
**Auth:** Admin/superadmin.
**Purpose:** Lists or creates stock items.

**Request body / query params:**
- POST: `name` (required), `reorderThreshold` (optional, non-negative), `sku`, `category`, `unitOfMeasure` (optional)

**Response:**
```json
{ "ok": true, "resource": "inventory_items", "items": [] }
```

### `GET /api/track1?resource=inventory_purchase_orders`
**Auth:** Admin/superadmin.
**Purpose:** Lists inventory purchase orders for the resolved tenant.

**Response:**
```json
{ "ok": true, "resource": "inventory_purchase_orders", "purchaseOrders": [], "awaitingApprovalCount": 0 }
```

Notes: capped at 50 rows.

### `GET /api/track1?resource=inventory_stock`
**Auth:** Admin/superadmin.
**Purpose:** Composite stock-on-hand view across all items and trucks.

**Response:**
```json
{ "ok": true, "resource": "inventory_stock", "items": [], "trucks": [], "summary": { "skuCount": 0, "totalUnits": 0, "lowStockCount": 0 } }
```

## HiveConnect

### `POST /api/track1?resource=hiveconnect_backfill`
**Auth:** Admin/superadmin.
**Purpose:** Provisions a HiveConnect account for every HiveLogic profile that doesn't have one yet.

**Response:**
```json
{ "ok": true, "results": { "total": 0, "alreadyMapped": 0, "provisioned": 0, "failed": [] } }
```

Notes: idempotent — safe to re-run. Catches per-profile provisioning errors individually rather than aborting the whole run.

## Materials Cart & Vendor Catalog

### `GET /api/track1?resource=materials_adapters`
**Auth:** Signed-in user.
**Purpose:** Lists configured vendor adapters (Home Depot, etc.) and their live/stub status.

**Response:**
```json
{ "ok": true, "resource": "materials_adapters", "adapters": [] }
```

### `POST /api/track1?resource=materials_cart_add`
**Auth:** Signed-in user.
**Purpose:** Adds a material line to a job/estimate's material cart (or a draft cart).

**Request body / query params:**
- `target_id`/`job_id` OR `draft_cart_id` (exactly one required), `target_type` (`JOB_MATERIAL_LIST`|`ESTIMATE_LINE_ITEM`), `product` (object, at least `vendor_title`), `quantity` (defaults to 1)

**Response:**
```json
{ "ok": true, "resource": "materials_cart_add", "snapshot": {} }
```

Notes: there is no dedicated cart table — a "cart" is just `product_snapshots` rows scoped by `attached_to_type`/`attached_to_id` or `draft_cart_id`.

### `POST /api/track1?resource=materials_cart_attach`
**Auth:** Signed-in user.
**Purpose:** Moves every line in a draft cart onto a real job/estimate target.

**Request body / query params:**
- `draft_cart_id` (required), `target_type` (required), `target_id` (required)

**Response:**
```json
{ "ok": true, "resource": "materials_cart_attach", "attachedCount": 0, "items": [] }
```

### `GET /api/track1?resource=materials_cart_get`
**Auth:** Signed-in user.
**Purpose:** Reads a material cart (draft or attached to a real target).

**Request body / query params:**
- `draft_cart_id`, OR `target_type` + `target_id`/`job_id`

**Response:**
```json
{ "ok": true, "resource": "materials_cart_get", "draftCartId": "...", "items": [], "total": 0 }
```

### `POST/DELETE /api/track1?resource=materials_cart_remove`
**Auth:** Signed-in user.
**Purpose:** Removes one line from a material cart.

**Request body / query params:**
- `id` (required, the snapshot row id)

**Response:**
```json
{ "ok": true, "resource": "materials_cart_remove", "id": "..." }
```

Notes: a real (hard) delete — the material list is treated as a live working draft, not yet an immutable record.

### `GET /api/track1?resource=materials_get`
**Auth:** Signed-in user.
**Purpose:** Looks up a single product from a vendor's live catalog.

**Request body / query params:**
- `sku` (required), `vendor` (optional, default `homedepot`), plus `store_id`/`zip` passed through to the vendor adapter.

**Response:** shape is vendor-adapter-specific (spread directly from the adapter's own result).

Notes: a live external vendor API call, not a Supabase read.

### `POST /api/track1?resource=materials_nickname_save`
**Auth:** Signed-in user.
**Purpose:** Saves a friendly nickname for a vendor product.

**Request body / query params:**
- `vendor_key`, `vendor_sku`, `nickname`, `vendor_title` (all required); `brand`, `unit_price`, `image_url`, `product_url` (optional)

**Response:**
```json
{ "ok": true, "resource": "materials_nickname_save", "nickname": {} }
```

Notes: deliberately no dedupe/uniqueness enforcement — the same product can get multiple nicknames, by design.

## Legacy Microsoft Mail (track1.js)

Distinct from HiveConnect's own mail integration (`api/mail.js`/`api/msmail.js`, documented separately) — this is an older, admin-only Microsoft 365 mailbox connection embedded directly in `track1.js`.

### `GET/POST /api/track1?resource=mail`
**Auth:** Admin/superadmin.
**Purpose:** Reads the connected inbox or sends mail via Microsoft Graph.

**Request body / query params:**
- GET: `limit` (optional, capped at 100, default 25)
- POST: `to`, `subject`, `body` (all required)

**Response:**
```json
{ "ok": true, "source": "Microsoft Graph -- real inbox", "messages": [] }
```

Notes: `{ "ok": false, "notConnected": true }` if Microsoft 365 isn't connected.

### `GET /api/track1?resource=mailcallback`
**Auth:** Self-authenticating via the OAuth `state` param, not a session — though note the global gate still runs first on this resource, and this path is not on the edge middleware's public allowlist, which can 401 the incoming Microsoft redirect before it ever reaches this handler.
**Purpose:** Microsoft OAuth callback — exchanges the code for tokens.

**Response:** an HTTP redirect (`/?mail_connected=1` or `/?mail_error=...`), never JSON.

### `GET /api/track1?resource=mailconnect`
**Auth:** Same edge-middleware caveat as `mailcallback`.
**Purpose:** Starts the Microsoft OAuth flow for connecting the mailbox.

**Response:** an HTTP redirect to Microsoft's OAuth consent screen, or an HTML error if `MS_CLIENT_ID`/`MS_TENANT_ID` isn't configured.

### `GET /api/track1?resource=mailstatus`
**Auth:** Same edge-middleware caveat as above.
**Purpose:** Reports whether the mailbox is connected.

**Response:**
```json
{ "ok": true, "connected": true, "connectedAt": "..." }
```

Notes: never returns a non-200/`ok:false` — a failure to read stored tokens is silently mapped to `connected: false`.

## Manager Reports

### `GET /api/track1?resource=manager_gh_updates`
**Auth:** Signed-in user.
**Purpose:** GH Project Updates report, sourced from a Google Sheet.

**Response:**
```json
{ "ok": true, "resource": "manager_gh_updates", "source": "GH Project Updates (Google Sheet)", "headers": [], "rows": [], "totalRows": 0, "statusCounts": {}, "fetchedAt": "..." }
```

Notes: an external Google Sheets call, not Supabase. Rows are truncated to the most recent `SHEET_ROW_CAP` if larger, but `totalRows` reports the untruncated count.

# Bookkeeping API: Estimates & Change Orders

An **estimate** is the priced proposal a client is shown before any work
begins: line items (labor, material, subcontractor, equipment, discount, tax,
overhead), a percentage-based payment schedule with exactly one row flagged
as the deposit, and a lifecycle of `draft -> sent -> approved -> converted`
(with `rejected` and `cancelled` side branches). A client's deposit must be
fully recorded as paid before an estimate can be approved, and an approved
estimate converts into a real HiveLogic job, carrying over its project number
(e.g. `E-10001` becomes `J-10001`) and handing the job the *remaining*
(non-deposit) rows of the payment schedule.

A **change order** modifies a job that already exists — it is always chained
to a `jobId`. It comes in two kinds: a **change order estimate** (additional
work being proposed, which needs a client approval step before payment) or a
**change order invoice** (work already completed, which skips approval and
is auto-approved the moment it's sent — permanently flagged `autoApproved`
so it is never mistaken for a real client approval). Its lifecycle is
`draft -> sent -> approved -> paid -> converted` (with `rejected` and
`cancelled` side branches). Once paid, a change order converts into its own
"Change Order Job," permanently chained to the original job — its dollars
roll up into that job's profitability as an additional activity, while still
being drillable on their own.

All endpoints below live under `api/bookkeeping/estimates/` and
`api/bookkeeping/change-orders/` and share the same request pattern: the
caller sends a Supabase Auth Bearer token; the server verifies it against
Supabase, loads the matching `profiles` row, and derives the acting user's
role and company from that — never from request headers or body. Every
route also short-circuits to `{ "ok": true, "enabled": false }` (list
endpoints return an empty array too) when the `BOOKKEEPING_ENABLED`
environment flag is not `'true'`.

---

## Estimates

### `POST /api/bookkeeping/estimates/create`
**Auth:** Signed-in user (any role).
**Purpose:** Creates a new estimate in draft status, with its line items and payment schedule, and durably allocates its estimate number.

**Request body / query params:**
- `clientId` (string, required) — the client this estimate is for.
- `lines` (array, required) — at least one line item: `{ type, description, qty, unit, unitCost, pmode, markupPct, manualUnitPrice, owner }`. `type` must be one of `labor`, `material`, `subcontractor`, `equipment`, `discount`, `tax`, `overhead`.
- `paymentSchedule` (array, required) — percentage-based rows summing to 100, with exactly one row flagged `isDeposit: true`. Each row: `{ label, pct, isDeposit, dueOn }`.
- `clientName` (string, optional)
- `title` (string, optional)
- `companyCode` (string, optional) — prefix used only if a durable estimate number can't be derived from the project-sequence allocator.
- `cardRateBps` (number, optional) — cash-discount program rate in basis points for this specific estimate; defaults to the `CARD_RATE_BPS` environment value, or the engine default of 400 bps (4.00%). Pass `0` to disable card pricing for this estimate.
- `sourceLeadId` (string, optional) — if present, links this estimate back to the originating lead (best-effort; a failed link does not fail the request).

**Response:**
```json
{
  "ok": true,
  "estimate": { "id": "...", "estimateNumber": "E-10001", "lifecycleStatus": "draft", "lines": [], "paymentSchedule": [], "totals": { "cost": 0, "price": 0, "margin": 0, "marginPct": 0, "cardPrice": 0 }, "depositRequired": 0, "depositSatisfied": false },
  "storeBackend": "memory",
  "leadLinked": true,
  "leadLinkError": undefined,
  "note": "Created in draft. Send it to the client to start the deposit clock — approval is blocked until the deposit row is fully paid."
}
```

Notes: Estimate numbers now come from the shared project-sequence counter (not a dedicated estimate counter) — an estimate is the first document of a project, so `E-10001` becomes `J-10001` on conversion and `CO-10001-1` for its change orders. A missing `clientId` returns 422. Creating an estimate does not move a linked lead's pipeline stage — only `send.js` does that.

---

### `POST /api/bookkeeping/estimates/send`
**Auth:** Signed-in user (any role).
**Purpose:** Moves an estimate from `draft` to `sent`, starting the client-approval/deposit clock.

**Request body / query params:**
- `id` (string, required) — the estimate id.

**Response:**
```json
{
  "ok": true,
  "estimate": { "...": "...", "lifecycleStatus": "sent", "sentAt": "2026-08-21T00:00:00.000Z" },
  "leadAdvanced": true,
  "leadStage": "estimate_sent"
}
```

Notes: Only callable from `draft` status (enforced by the engine, not duplicated here) — otherwise a 422 with a state-machine error message. If the estimate has a `sourceLeadId`, its linked lead card is advanced to the `estimate_sent` stage as a side effect (best-effort — failure to advance the lead does not fail the send).

---

### `POST /api/bookkeeping/estimates/record-deposit-payment`
**Auth:** Signed-in user (any role).
**Purpose:** Records that a payment was received against the estimate's deposit payment-schedule row; does not move money or touch QBO/a bank feed.

**Request body / query params:**
- `id` (string, required) — the estimate id.
- `amount` (number, required) — dollar amount actually received.
- `method` (string, optional) — payment method (e.g. `check`, `card`, `ach`); affects cash-discount crediting.
- `reference` (string, optional) — free-text reference/check number.

**Response:**
```json
{
  "ok": true,
  "estimate": { "...": "...", "depositPayments": [ { "id": "...", "amount": 500, "method": "check", "creditedAmount": 520.83, "cashDiscountApplied": 20.83, "reference": null, "recordedBy": "actor-id", "at": "..." } ], "depositSatisfied": true },
  "note": "Deposit fully paid — this estimate can now be approved."
}
```

Notes: Only callable while the estimate is in `sent` status. Partial payments are allowed — the deposit is only considered satisfied once payments (credited at the cash-discount ratio for non-card methods) sum to the full required deposit amount; only then does `approve.js` become callable. Overpaying beyond the deposit amount by more than a cent is rejected with a 422. The response `note` reports the remaining dollar amount still required when the deposit isn't yet satisfied.

---

### `POST /api/bookkeeping/estimates/approve`
**Auth:** Admin/superadmin only (mapped internally to the `controller` role).
**Purpose:** Records the client's approval of a sent estimate, moving it to `approved`.

**Request body / query params:**
- `id` (string, required) — the estimate id.

**Response:**
```json
{ "ok": true, "estimate": { "...": "...", "lifecycleStatus": "approved", "approvedAt": "...", "approvedBy": "actor-id" } }
```

Notes: Blocked by the engine until the deposit row has been fully paid — this route does not duplicate that check itself, it just surfaces whatever the engine returns (a 422 with a descriptive error if the deposit isn't satisfied). Only callable from `sent` status. Non-controller callers get a 403.

---

### `POST /api/bookkeeping/estimates/reject`
**Auth:** Signed-in user (any role).
**Purpose:** Records that a sent estimate was rejected by the client.

**Request body / query params:**
- `id` (string, required) — the estimate id.
- `reason` (string, optional) — free-text rejection reason.

**Response:**
```json
{ "ok": true, "estimate": { "...": "...", "lifecycleStatus": "rejected", "rejectedAt": "...", "rejectedBy": "actor-id", "rejectionReason": "..." } }
```

Notes: Only callable from `sent` status.

---

### `POST /api/bookkeeping/estimates/convert`
**Auth:** Signed-in user (any role).
**Purpose:** Converts an approved estimate into a real HiveLogic job, carrying forward the project number and the remaining (non-deposit) payment schedule.

**Request body / query params:**
- `id` (string, required) — the estimate id.

**Response:**
```json
{
  "ok": true,
  "estimate": { "...": "...", "lifecycleStatus": "converted", "convertedJobId": "J-10001", "convertedJobRef": "..." },
  "job": { "jobber_id": "...", "project_seq": 10001, "title": "...", "client_id": "...", "total": 0, "job_status": "...", "source_estimate_id": "..." },
  "jobRef": "J-10001",
  "note": "Converted to job J-10001. Remaining payment schedule: Progress ($1000.00), Final ($500.00)."
}
```

Notes: Only callable from `approved` status; a 409 is returned if the estimate is already `converted`, or if a job already exists at the same project sequence with no link back to this estimate. Converting twice never produces two jobs — guarded by (in order) an existing-job lookup, the engine's `approved`-only state check, and finally a database unique constraint (`uq_jobs_project_seq`) as the last-resort race guard; a job-insert-succeeded-but-estimate-update-failed state is automatically recovered on retry rather than duplicated. As of 2026-08-17 this genuinely creates a job record (previously it only returned a placeholder string and created nothing) — nothing is written to Jobber; the job is HiveLogic-native only.

---

### `POST /api/bookkeeping/estimates/cancel`
**Auth:** Signed-in user (any role).
**Purpose:** Cancels a non-terminal estimate (`draft`, `sent`, `approved`, or `rejected`), always with a reason, never a silent delete.

**Request body / query params:**
- `id` (string, required) — the estimate id.
- `reason` (string, optional) — free-text cancellation reason.

**Response:**
```json
{ "ok": true, "estimate": { "...": "...", "lifecycleStatus": "cancelled", "cancelledAt": "...", "cancelReason": "..." } }
```

Notes: Cannot cancel an already `converted` or `cancelled` estimate (422 from the engine's state machine).

---

### `GET /api/bookkeeping/estimates/list`
**Auth:** Signed-in user (any role).
**Purpose:** Lists all estimates for the caller's company, optionally filtered by client, with computed display fields attached.

**Request body / query params:**
- `clientId` (string, optional, query param) — filters to one client's estimates.

**Response:**
```json
{
  "ok": true,
  "enabled": true,
  "estimates": [ { "id": "...", "estimateNumber": "E-10001", "lifecycleStatus": "sent", "displayStatus": "awaiting_deposit", "totals": { "...": "..." }, "depositRequired": 500, "depositSatisfied": false } ]
}
```

Notes: `displayStatus` overlays `awaiting_deposit` on top of `sent` when the deposit hasn't been paid yet — the underlying `lifecycleStatus` is preserved unchanged. This is the intended real-data source for the Estimate Builder's list view, replacing an older localStorage-draft-only flow.

---

## Change Orders

### `POST /api/bookkeeping/change-orders/create`
**Auth:** Signed-in user (any role).
**Purpose:** Creates a new change order (kind `estimate` or `invoice`) chained to an existing job, with line items, and durably allocates its CO number.

**Request body / query params:**
- `jobId` (string, required) — the existing job this change order modifies.
- `kind` (string, required) — `estimate` (needs client approval) or `invoice` (work already done, auto-approves on send).
- `description` (string, required) — description of the additional work.
- `lines` (array, required) — at least one line item, same shape/types as estimate lines.
- `reasonCategory` (string, optional) — one of `client_request`, `unforeseen_condition`, `code_requirement`, `design_change`, `scope_clarification`, `other` (defaults to `other`).
- `jobLabel` (string, optional)
- `scheduleImpactDays` (number, optional)
- `approvalRequiredFrom` (string, optional) — defaults to `'client'` for `estimate`-kind COs; forced to `null` for `invoice`-kind.
- `targetApprovalBy` (string, optional) — date string used to compute an `overdue` display flag.
- `companyCode` (string, optional) — CO number prefix, default `CO`.
- `cardRateBps` (number, optional) — same cash-discount semantics as on estimates.

**Response:**
```json
{
  "ok": true,
  "changeOrder": { "id": "...", "coNumber": "CO-10001-01", "kind": "estimate", "lifecycleStatus": "draft", "autoApproved": false, "lines": [], "totals": { "...": "..." } },
  "qboWritesEnabled": false,
  "storeBackend": "memory",
  "note": "Created as a Change Order Estimate, in draft. Send it to move it to \"sent\" and start the client-approval clock."
}
```

Notes: A missing `jobId` returns 422 — a change order can never exist without a parent job. `qboWritesEnabled` is always `false`: QuickBooks Online writes are never made from this route. `invoice`-kind COs get a different `note` explaining they are auto-approved and permanently flagged as such.

---

### `POST /api/bookkeeping/change-orders/send`
**Auth:** Signed-in user (any role).
**Purpose:** Moves a draft change order to `sent` (kind `estimate`) or straight to auto-`approved` (kind `invoice`).

**Request body / query params:**
- `id` (string, required) — the change order id.

**Response:**
```json
{ "ok": true, "changeOrder": { "...": "...", "lifecycleStatus": "sent" }, "qboWritesEnabled": false }
```

Notes: Only callable from `draft`. For `invoice`-kind COs, `lifecycleStatus` becomes `approved` (not `sent`) and `approvedAt`/`approvedBy` are stamped immediately — `autoApproved` remains permanently `true` on the record so it's never confused with a real client approval.

---

### `POST /api/bookkeeping/change-orders/approve`
**Auth:** Admin/superadmin only (mapped to `controller`).
**Purpose:** Records a client's approval of a sent (estimate-kind) change order.

**Request body / query params:**
- `id` (string, required) — the change order id.

**Response:**
```json
{ "ok": true, "changeOrder": { "...": "...", "lifecycleStatus": "approved", "approvedAt": "...", "approvedBy": "actor-id" } }
```

Notes: Only callable from `sent` status. This is documented as an internal recording of a client's approval by staff, not a public client-facing approval link (a future feature would need its own trust path). Non-controller callers get 403.

---

### `POST /api/bookkeeping/change-orders/reject`
**Auth:** Admin/superadmin only (mapped to `controller`).
**Purpose:** Records a client's rejection of a sent (estimate-kind) change order.

**Request body / query params:**
- `id` (string, required) — the change order id.
- `reason` (string, optional) — free-text rejection reason.

**Response:**
```json
{ "ok": true, "changeOrder": { "...": "...", "lifecycleStatus": "rejected", "rejectedAt": "...", "rejectedBy": "actor-id", "rejectionReason": "..." } }
```

Notes: Only callable from `sent` status. Non-controller callers get 403.

---

### `POST /api/bookkeeping/change-orders/record-payment`
**Auth:** Signed-in user (any role).
**Purpose:** Records a deposit or progress payment against an approved change order; never moves money itself and never touches QBO or a bank feed.

**Request body / query params:**
- `id` (string, required) — the change order id.
- `amount` (number, required) — dollar amount actually received for this payment.
- `method` (string, optional) — payment method; affects cash-discount crediting.
- `reference` (string, optional) — free-text reference.

**Response:**
```json
{
  "ok": true,
  "changeOrder": { "...": "...", "lifecycleStatus": "paid", "paidTotal": 1200, "paidCreditedTotal": 1200, "payments": [ { "id": "...", "amount": 1200, "method": "check", "creditedAmount": 1200, "cashDiscountApplied": 0 } ] },
  "note": "Payment recorded only. No bank feed or QBO write occurred."
}
```

Notes: Callable from `approved` or already-`paid` status (supports multiple partial payments). Overpaying the CO's posted (card) total by more than a cent is rejected with a 422. Cash/check/ACH payments are credited at a cash-discount ratio relative to card payments.

---

### `POST /api/bookkeeping/change-orders/convert`
**Auth:** Signed-in user (any role).
**Purpose:** Converts a fully-paid change order into its own "Change Order Job," permanently chained to the original job.

**Request body / query params:**
- `id` (string, required) — the change order id.

**Response:**
```json
{
  "ok": true,
  "changeOrder": { "...": "...", "lifecycleStatus": "converted", "convertedJobId": "10001-01", "jobId": "10001" },
  "note": "Converted to Change Order Job 10001-01, chained to parent job 10001."
}
```

Notes: Only callable from `paid` status. This is "the convert to Change Order Job" step: the dollars keep rolling into the parent job's profitability report as an additional activity while remaining separately drillable via `job-report.js`.

---

### `POST /api/bookkeeping/change-orders/cancel`
**Auth:** Admin/superadmin only (mapped to `controller`).
**Purpose:** Cancels a non-terminal change order (`draft`, `sent`, `approved`, or `rejected`), always with a reason, never a silent delete.

**Request body / query params:**
- `id` (string, required) — the change order id.
- `reason` (string, optional) — free-text cancellation reason.

**Response:**
```json
{ "ok": true, "changeOrder": { "...": "...", "lifecycleStatus": "cancelled", "cancelledAt": "...", "cancelReason": "..." } }
```

Notes: Cannot cancel an already `paid`, `converted`, or `cancelled` change order (422 from the engine's state machine). Non-controller callers get 403.

---

### `GET /api/bookkeeping/change-orders/list`
**Auth:** Signed-in user (any role).
**Purpose:** Lists all change orders for the caller's company, optionally filtered by job, with computed display fields attached.

**Request body / query params:**
- `jobId` (string, optional, query param) — filters to one job's change orders.

**Response:**
```json
{
  "ok": true,
  "enabled": true,
  "changeOrders": [ { "id": "...", "coNumber": "CO-10001-01", "kind": "estimate", "lifecycleStatus": "sent", "displayStatus": "overdue", "totals": { "...": "..." } } ]
}
```

Notes: `displayStatus` overlays `overdue` on top of `sent` when `targetApprovalBy` has passed — the underlying `lifecycleStatus` is unchanged. This is the real-data source for the Change Orders page's table and its Estimate/Invoice toggle, replacing a previously static three-row mockup.

---

### `GET /api/bookkeeping/change-orders/job-report`
**Auth:** Signed-in user (any role).
**Purpose:** Builds a profitability report for a single job's change orders — both a rolled-up "additional activity" view and a per-change-order drill-down.

**Request body / query params:**
- `jobId` (string, required, query param) — the job to report on.

**Response:**
```json
{
  "ok": true,
  "enabled": true,
  "jobId": "10001",
  "profitability": {
    "jobId": "10001",
    "changeOrderCount": 3,
    "committed": { "count": 2, "additionalCost": 800, "additionalRevenue": 1200, "additionalMargin": 400 },
    "pipeline": { "count": 1, "potentialRevenue": 500 },
    "changeOrders": [ { "coNumber": "CO-10001-01", "kind": "estimate", "lifecycleStatus": "paid", "displayStatus": "paid", "totals": { "...": "..." } } ]
  },
  "changeOrders": [ { "coNumber": "CO-10001-01", "jobId": "10001", "kind": "estimate", "lifecycleStatus": "paid", "description": "...", "totals": { "...": "..." }, "paidTotal": 1200, "balanceDue": 0, "lines": [], "payments": [], "history": [], "convertedJobId": null } ]
}
```

Notes: Only `paid` and `converted` change orders count toward the "committed" profitability numbers; `sent`/`approved`/`draft` (not yet paid) show up as "pipeline" instead, and `rejected`/`cancelled` COs are excluded from both. A missing `jobId` query param returns 422. This endpoint is explicitly built to answer a stated requirement that a change order "becomes an additional activity on the reporting side when calculating profitability but also can be drilled down into for a closer reporting of just the change order itself."

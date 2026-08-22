# Bookkeeping API: Catch-All

This is the set of bookkeeping endpoints not covered by the sibling `docs/api/bookkeeping-ledger-purchase-orders.md` and `docs/api/bookkeeping-estimates-change-orders.md` docs — backup/export, the materials/expense catalog, contractor 1099 tracking, sales tax, document review and receipt scanning, the evidence vault, expense entry, approval controls, and reference data.

Every route in this file starts with `guardBookkeepingRequest(req, res)` — security headers and per-IP rate limiting only, **not** authentication. Real auth is a separate step per route: most use `getTrustedActor()` (from either `ledger/_actor.js` or `purchase-orders/_actor.js` — both verify a Supabase Bearer token, then map `profiles.role` onto a route-specific role vocabulary), except `reference-data.js` (uses `requireApiAuth` from `../_lib/guard.js`) and `vendors.js` (no actor check at all — a stubbed route with nothing real to protect yet).

## Backup

### `POST /api/bookkeeping/backup`
**Auth:** Signed-in user (any role).
**Purpose:** Produces a full backup export of the bookkeeping system.

**Request body / query params:** none.

**Response:** Not JSON on success — a binary zip (`Content-Type: application/zip`, `Content-Disposition: attachment`, with `X-Backup-Sha256` and `X-Backup-File-Count` headers). Disabled: `{ "ok": true, "enabled": false }`. Error: `{ "ok": false, "error": "..." }` (400), or 500 on a self-checksum mismatch.

Notes: gathers the ledger system, expenses, catalog, purchase orders, and evidence — re-fetching full bytes per document and skipping any that fail rather than faking them — then recomputes the SHA-256 of the exact buffer sent, verifying it before responding.

## Catalog

### `GET /api/bookkeeping/catalog`
**Auth:** Signed-in user.
**Purpose:** Searches the materials/expense catalog.

**Request body / query params:**
- `q` (string, optional) — search text.
- `type` (string, optional).

**Response:**
```json
{ "ok": true, "enabled": true, "items": [], "storeBackend": "..." }
```

### `POST /api/bookkeeping/catalog`
**Auth:** Signed-in user (any role).
**Purpose:** Creates or updates a catalog item.

**Request body / query params:**
- `type` (string, required) — `material` or `expense`.
- `name` (string, required)
- `nickname`, `sku` (string, optional)
- `aliases` (array, optional)
- `id` (string, optional) — updates the existing item when present.
- Other fields (vendor, unit price, etc.) pass through unvalidated.

**Response:**
```json
{ "ok": true, "item": {}, "created": true, "storeBackend": "...", "note": "..." }
```

Notes: returns `409` with code `CATALOG_NICKNAME_CONFLICT` if the nickname collides with another item.

## AI Assist (Reina Accuracy / Suggest / Confidence Lab)

### `/api/bookkeeping/confidence-lab` (any method — no method check in the route)
**Auth:** Signed-in user.
**Purpose:** Runs the ported double-entry engine's self-test against a fictional practice company. Never touches real company data.

**Response:**
```json
{ "ok": true, "...": "spread of runConfidenceLab()'s result" }
```

### `/api/bookkeeping/reina-accuracy` (any method — no method check in the route)
**Auth:** Signed-in user.
**Purpose:** Runs Reina's curriculum benchmark and reports real persisted learning-memory health, plus a permissioned real-document benchmark stub.

**Response:**
```json
{ "ok": true, "benchmark": {}, "learning": { "autoFillEnabled": false }, "realBenchmark": { "note": "no real document authorized yet" } }
```

### `POST /api/bookkeeping/reina-suggest`
**Auth:** Signed-in user.
**Purpose:** Suggests coding (account/tax) for an expense line based on vendor and description — never writes anything.

**Request body / query params:**
- `vendor` (string, required)
- `lines` (array, optional) — each `{ lineId?, sku?, description?, paymentAccountId?, taxState? }`, OR a flat `sku`/`description`/`paymentAccountId`/`taxState` for a single line.

**Response:**
```json
{ "ok": true, "enabled": true, "autoFillEnabled": false, "suggestions": [], "learning": {} }
```

Notes: an empty `vendor` short-circuits to `{ "ok": true, "suggestions": [], "note": "..." }` without calling the engine. Auto-fill strength is capped at "review" unless `HIVELOGIC_REINA_LEARNING_AUTOFILL_ENABLED === 'true'`.

## Contractors (1099 / W-9)

### `GET /api/bookkeeping/contractors`
**Auth:** Signed-in user.
**Purpose:** Lists contractor 1099/W-9 tracking profiles and the current-year reporting threshold status.

**Request body / query params:**
- `year` (number, optional, default: current UTC year)
- `threshold` (number, optional, default: 600)

**Response:**
```json
{ "ok": true, "enabled": true, "profiles": [], "report": {}, "storeBackend": "..." }
```

### `POST /api/bookkeeping/contractors`
**Auth:** Controller role only (HiveLogic admin/superadmin).
**Purpose:** Updates a contractor's 1099/W-9 tracking profile.

**Request body / query params:**
- `vendorName` (string, required)
- `track1099`, `w9OnFile`, `taxIdLast4`, `notes` (optional, partial update)

**Response:**
```json
{ "ok": true, "profile": {}, "created": true, "storeBackend": "...", "note": "..." }
```

Notes: `403` if the caller isn't a controller.

## Sales Tax

### `GET /api/bookkeeping/sales-tax`
**Auth:** Signed-in user.
**Purpose:** Lists sales-tax collection/remittance entries and the current liability.

**Request body / query params:**
- `throughDate` (string, `YYYY-MM-DD`, optional, default: today)

**Response:**
```json
{ "ok": true, "enabled": true, "entries": [], "liability": 0, "storeBackend": "..." }
```

### `POST /api/bookkeeping/sales-tax`
**Auth:** Controller role only.
**Purpose:** Records a sales-tax collection, a remittance, or voids an entry.

**Request body / query params (one of three shapes):**
- Collect: `kind: 'collected'`, `taxState`, `date`, `taxableAmount`, `exemptAmount`, `taxCollected`, `jobRef?`, `note?`
- Remit: `kind: 'remitted'`, `taxState`, `date`, `amount`, `note?`
- Void: `void: '<entryId>'`

**Response:**
```json
{ "ok": true, "entry": {}, "storeBackend": "...", "note": "..." }
```

Notes: `403` if the caller isn't a controller. Voiding responds with `note: "Sales-tax entry voided."`.

## Document Review & Receipt Scan

### `GET /api/bookkeeping/document-reviews`
**Auth:** Signed-in user.
**Purpose:** Lists evidence documents awaiting manual review.

**Response:**
```json
{ "ok": true, "reviews": [ { "kind": "evidence" } ] }
```

Notes: excludes documents already in `extracted`/`processed` status.

### `POST /api/bookkeeping/document-reviews`
**Auth:** Signed-in user.
**Purpose:** Resolves a document review.

**Request body / query params:**
- `id` (string, required)
- `resolution` (string, optional, default: `reviewed_no_ledger_entry`)
- `note` (string, optional)

**Response:**
```json
{ "ok": true, "review": {} }
```

Notes: also appends a `document.reviewed` event to the ledger's hash-chained audit trail.

### `POST /api/bookkeeping/receipt-scan`
**Auth:** Signed-in user.
**Purpose:** AI-scans an already-uploaded receipt or PDF and extracts coding-relevant fields.

**Request body / query params:**
- `evidenceId` (string, required)

**Response:**
```json
{ "ok": true, "enabled": true, "scannable": true, "configured": true, "cached": false, "evidenceId": "...", "scan": {} }
```

Notes: a real AI call — `scanReceiptWithReina()` (an Anthropic vision request) against the uploaded file. A non-image/PDF mime type short-circuits to `{ "ok": true, "scannable": false, "note": "..." }`. Results are cached — a repeat call replays the stored `extracted` result rather than re-billing Anthropic. Low-confidence scans are stored as `needs_review` (and still surface in the document-reviews queue above) rather than `extracted`.

## Evidence Vault

### `GET /api/bookkeeping/evidence`
**Auth:** Signed-in user.
**Purpose:** Lists evidence document metadata.

**Response:**
```json
{ "ok": true, "documents": [], "storeBackend": "..." }
```

### `GET /api/bookkeeping/evidence?id=...`
**Auth:** Signed-in user.
**Purpose:** Downloads one evidence document's raw bytes.

**Response:** Binary file bytes, with `Content-Type`/`Content-Disposition` headers. `404 { "ok": false, "error": "..." }` if not found.

### `POST /api/bookkeeping/evidence`
**Auth:** Signed-in user.
**Purpose:** Uploads a new evidence document.

**Request body / query params:**
- `filename`, `mimeType`, `dataBase64` (all required by the underlying store; not individually validated in the route itself)

**Response:**
```json
{ "ok": true, "evidence": { "id": "...", "filename": "...", "mimeType": "...", "sizeBytes": 0, "sha256": "..." }, "storeBackend": "..." }
```

## Expenses

### `POST /api/bookkeeping/expenses`
**Auth:** Signed-in user.
**Purpose:** Records an expense, optionally submitting it (vs. saving as a draft).

**Request body / query params (key fields):**
- `allocations` (array, required) — each with `subtotal`, `qboAccountId`, `description`/`memo`.
- `salesTaxTotal` (number, optional)
- `vendor`, `transactionKind` (`paid`|`bill`), `paymentAccountId`, `transactionDate`, `memo` (optional)
- `evidenceId` (optional) — drives `receiptAttached`.
- `qboVendorId`, `poId` (optional)
- `status` (`submitted` or anything else → saved as `draft`)

**Response:**
```json
{ "ok": true, "status": "submitted", "expenseId": "...", "storeBackend": "...", "validation": {}, "qboPreview": {}, "qboWritesEnabled": false, "qboApproval": {}, "journalEntry": {}, "linkedPurchaseOrder": null, "note": "..." }
```

Notes: `422` with `{ "ok": false, "error": "...", "errors": [], "note": "..." }` on validation failure. On a real (non-draft) submission, also best-effort: creates a pending-approval GL journal entry, opens a QBO-sync approval request (never writes to QuickBooks directly — see `controls/qbo-sync` below), and links/marks-billed a named purchase order — each of these three steps is caught and reported independently in `note` rather than failing the whole save.

## Controls

### `POST /api/bookkeeping/controls/decide-approval`
**Auth:** Signed-in user. The same actor who raised the approval cannot decide it themselves (enforced by identity, not role).
**Purpose:** Approves or rejects a pending approval request.

**Request body / query params:**
- `approvalId` (string, required)
- `decision` (string, required) — `approve` or `reject`.
- `comment` (string, optional)

**Response:**
```json
{ "ok": true, "approval": {}, "outbox": {}, "note": "...", "learningNote": "..." }
```

Notes: `422` on error. Approving a `purchase`/`bill` entity also best-effort enqueues a QBO outbox item and records a Reina approved-learning memory entry (idempotent, keyed by `approvalId`+`lineId`) — neither of those failing undoes the approval decision itself.

### `GET /api/bookkeeping/controls/status`
**Auth:** Signed-in user.
**Purpose:** Reports the overall controls/approvals dashboard state.

**Response:**
```json
{ "ok": true, "enabled": true, "qboWriteEnabled": false, "pendingApprovals": [], "qboOutbox": [], "qboOutboxSummary": { "queued": 0, "inFlight": 0, "retry": 0, "blocked": 0, "complete": 0 }, "controlAudit": { "valid": true, "records": [] } }
```

### `POST /api/bookkeeping/controls/qbo-sync`
**Auth:** Bookkeeper or controller role only.
**Purpose:** Syncs one queued outbox item to real QuickBooks Online.

**Request body / query params:**
- `outboxId` (string, required)

**Response:**
```json
{ "ok": true, "enabled": true, "qboWriteEnabled": true, "synced": true, "outbox": {}, "qboResult": {} }
```

Notes: **this is the only route in the entire app that can actually write to real QuickBooks**, and only when `HIVELOGIC_QBO_WRITE_ENABLED === 'true'`. When that flag isn't set, it no-ops: `{ "ok": true, "enabled": true, "qboWriteEnabled": false, "synced": false, "note": "..." }`. `409` if misconfigured or the item is blocked; `404` if the outbox item doesn't exist.

## Reference Data & Vendors

### `GET /api/bookkeeping/vendors`
**Auth:** None beyond the base rate-limit guard — no `getTrustedActor()` call in this route at all.
**Purpose:** Stubbed vendor list — not yet wired to a live QBO read.

**Response:**
```json
{ "ok": true, "enabled": true, "vendors": [], "note": "..." }
```

Notes: always returns an empty list today.

### `GET /api/bookkeeping/reference-data?resource=all`
**Auth:** Signed-in employee (`requireApiAuth` from `../_lib/guard.js` — a different auth pattern than the `getTrustedActor()` convention used by every other route in this file).
**Purpose:** Aggregates real QuickBooks vendors/chart-of-accounts and active Jobber jobs into one reference payload for expense-entry dropdowns.

**Request body / query params:**
- `resource` (string, optional) — only `all` is accepted; anything else returns `400`.

**Response:**
```json
{ "ok": true, "enabled": true, "source": "...", "vendors": [], "vendorsError": null, "expenseAccounts": [], "bankAccounts": [], "accountsError": null, "jobs": [] }
```

Notes: pulls real QBO vendors/chart-of-accounts (via `api/qbo/index.js`) and active Jobber jobs (via `api/jobs.js`) concurrently via `Promise.allSettled` — a failure in either section degrades to its own `...Error` field rather than failing the whole request.

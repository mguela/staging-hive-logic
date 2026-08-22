# Bookkeeping: Ledger & Purchase Orders

This domain covers HiveLogic's internal double-entry bookkeeping system. **The
ledger** is a ported general-ledger engine (`server/bookkeeping/src/ledger.js`
plus `banking.js`, `close.js`, `reporting.js`, `exports.js`) that tracks a
chart of accounts, journal entries (create → approve → post, with an
append-only hash-chained audit trail), bank/card feed imports and
reconciliation, financial reports (trial balance, P&L, balance sheet, aging),
and period-close readiness/export packages. It is a real, separate
bookkeeping system layered on top of HiveLogic's operational data — it is
**not** QuickBooks, and no route in this domain ever writes to QuickBooks
Online; "QBO preview" outputs are local-only representations of what a QBO
payload would look like. **Purchase orders (POs)** are a separate but related
engine (`server/bookkeeping/src/purchase-orders.js`) that tracks
job-costed/overhead purchases through a draft → approved/ordered →
received → billed → closed lifecycle, detects exceptions (price/quantity
variance, duplicate bills, missing receipts), matches vendor receipts to PO
lines (idempotently, with split-across-PO support), and feeds only
*approved, exception-free* actual costs into job costing. Both engines store
one durable object per company (a single versioned JSON blob in Supabase, or
an in-memory store for local/test use) and enforce all business rules
(role checks, state-machine transitions, tenant scoping) inside the engine
functions themselves — the route files are thin wrappers that authenticate
the caller and pass validated input through.

Every route in this domain shares the same request pipeline: `guardBookkeepingRequest()`
(sets security headers and enforces a per-IP/per-actor rate limit — 300
req/min for GET, 60 req/min for writes — returning `429` if exceeded) runs
first; then a `BOOKKEEPING_ENABLED=true` feature-flag check (if unset/false,
the route returns `200 { ok: true, enabled: false }` without doing anything);
then `getTrustedActor(req)`, which verifies the caller's real Supabase Auth
Bearer token against Supabase's `/auth/v1/user` endpoint (never trusts
client-supplied identity headers), looks up their `profiles` row, and resolves
their company. **Role mapping differs by engine**: for the ledger,
HiveLogic's `admin` role maps to the ledger's `controller` role (can approve,
post, reverse, reconcile, lock periods, create adjustments) and everything
else (including `crew`) maps to `submitter` (can create/view entries only) —
note `superadmin` is not specially handled here, only literal `admin`. For
purchase orders, both `admin` and `superadmin` map to the PO engine's
`controller` role, and `crew` maps to `field` (can create/request POs,
cannot approve/reject/bill/close/void). All routes require a signed-in user;
none of these 25 endpoints are public, webhook, or cron-triggered.

## Ledger

### `POST /api/bookkeeping/ledger/approve`
**Auth:** Signed-in user (mapped to ledger role `controller` or `submitter`; only `controller` can actually approve).
**Purpose:** Approves a journal entry that is sitting in `pending_approval`, moving it one step closer to posting.

**Request body / query params:**
- `entryId` (string, required) — the journal entry to approve.

**Response:**
```json
{ "ok": true, "entry": { "id": "...", "status": "approved", "approvedBy": "...", "approvedAt": "..." } }
```

Notes: separation of duties is enforced — the entry's own creator can never approve it (`error: "Separation of duties prevents approving your own entry."`). Only entries in `pending_approval` status can be approved. Errors return `422`.

---

### `GET /api/bookkeeping/ledger/audit-verify`
**Auth:** Signed-in user (any role).
**Purpose:** Verifies the general ledger's two hash chains (the ledger's own journal-entry audit trail and the separate controls/approvals event chain) against an independent, database-enforced append-only witness table, catching a wholesale rewrite of the mutable ledger blob that a self-consistency check alone could miss.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "valid": true,
  "ledger": { "valid": true, "checkedRecords": 42, "mismatches": [] },
  "controls": { "valid": true, "checkedRecords": 10, "mismatches": [] }
}
```

Notes: read-only. A mismatch entry looks like `{ "seq": 3, "reason": "hash/id mismatch between ledger_systems.data and the independent log", "current": {...}, "log": {...} }`. This is the "real" tamper check — `purchase-orders/audit-verify` deliberately only checks internal self-consistency, not against an independent witness table.

---

### `POST /api/bookkeeping/ledger/bank-classify`
**Auth:** Signed-in user (any authenticated actor can call this; the underlying `createEntry` call requires `entry:create` permission, which both `submitter` and `controller` have).
**Purpose:** Categorizes an unmatched bank/card transaction that never went through Expense Entry (bank fees, direct debits, interest, transfers) by creating a pending-approval journal entry for it.

**Request body / query params:**
- `bankTransactionId` (string, required)
- `offsetAccountId` (string, required) — the account on the other side of the entry.
- `classificationType` (string, optional) — one of `income|expense|transfer|loan|equity|other`; inferred from the offset account's type if omitted.
- `description` (string, optional)
- `memo` (string, optional)

**Response:**
```json
{
  "ok": true,
  "transaction": { "id": "...", "status": "classified_pending", "classification": { "classificationType": "expense", "offsetAccountId": "...", "journalEntryId": "..." } },
  "note": "A pending-approval journal entry was created for this transaction. It stays \"classified pending\"..."
}
```

Notes: only transactions currently `unmatched` can be classified. The transaction stays `classified_pending` (still counted as an open item for close readiness) until a different admin approves and posts the journal entry via `approve` + `post` — `post.js` is what flips it the rest of the way to `classified`.

---

### `POST /api/bookkeeping/ledger/bank-import`
**Auth:** Signed-in user.
**Purpose:** Imports a bank/card statement CSV (downloaded by the user from their bank portal) into the ledger's bank-feed store. This is a file upload, never a live bank API connection.

**Request body / query params:**
- `accountId` (string, required) — must be an existing asset/liability account on this company.
- `filename` (string, optional)
- `csvText` (string, required) — the raw CSV file contents.

**Response:**
```json
{
  "ok": true,
  "imported": 12,
  "duplicates": 2,
  "replay": false,
  "parseWarnings": [],
  "note": "12 transaction(s) imported, 2 duplicate(s) skipped."
}
```

Notes: `importKey` is a sha256 of `companyId:accountId:csvText`, computed server-side (never client-supplied), so re-uploading the exact same file for the exact same account is a safe no-op (`replay: true`) rather than a duplicate. Rows that fail to parse are skipped and reported in `parseWarnings`, not fatal to the whole import. Returns `422` if the account doesn't exist, the file can't be parsed, or contains no usable transactions.

---

### `GET /api/bookkeeping/ledger/bank-match`
**Auth:** Signed-in user.
**Purpose:** Returns ranked candidate expenses (already entered through Expense Entry) that a given imported bank/card transaction might match, scored by amount/vendor-text/date proximity.

**Request body / query params:**
- `bankTransactionId` (string, required, query param).

**Response:**
```json
{
  "ok": true,
  "transaction": { "id": "...", "amount": -84.50, "status": "unmatched" },
  "candidates": [
    { "expenseId": "...", "score": 0.95, "reasons": ["exact amount", "vendor text"], "expense": { "id": "...", "vendor": "...", "total": 84.5, "transactionDate": "2026-08-01" } }
  ]
}
```

Notes: only expenses with no `bankTransactionId` are considered candidates; only candidates scoring ≥ 0.55 are returned.

---

### `POST /api/bookkeeping/ledger/bank-match`
**Auth:** Signed-in user.
**Purpose:** Confirms a match between an imported bank transaction and an already-entered expense.

**Request body / query params:**
- `bankTransactionId` (string, required)
- `expenseId` (string, required)

**Response:**
```json
{ "ok": true, "transaction": { "id": "...", "status": "matched", "match": { "expenseId": "...", "confirmedBy": "...", "amount": 84.5 } }, "note": "The expense record was updated with this match." }
```

Notes: writes to two separate stores — the ledger's bank transaction (via `updateSystem`) and the expense record's own `bankTransactionId` field (via `updateExpense`, best-effort). If the expense-side write fails, the response's `note` explains the resulting inconsistency rather than hiding it (the bank-transaction side is still recorded as matched). Fails with `422` if the bank amount doesn't exactly equal the expense total, or if either side is already matched to something else.

---

### `GET /api/bookkeeping/ledger/bank-reconcile`
**Auth:** Signed-in user.
**Purpose:** Re-verifies a previously completed month-end bank/card reconciliation's stored snapshot against the independent audit trail.

**Request body / query params:**
- `reconciliationId` (string, required, query param)

**Response:**
```json
{ "ok": true, "valid": true, "reconciliationId": "...", "expectedHash": "...", "auditHash": "...", "currentHash": "...", "status": "intact" }
```

Notes: `status` is `"broken"` when `valid` is `false`.

---

### `POST /api/bookkeeping/ledger/bank-reconcile`
**Auth:** Signed-in user.
**Purpose:** Completes a month-end reconciliation for one bank/card account, confirming that every imported transaction for the period is resolved and that the statement's ending balance matches the real, computed book balance.

**Request body / query params:**
- `accountId` (string, required)
- `startDate` (string, required, `YYYY-MM-DD`)
- `endDate` (string, required, `YYYY-MM-DD`)
- `statementBeginningBalance` (number, required)
- `statementEndingBalance` (number, required)

**Response:**
```json
{ "ok": true, "reconciliation": { "id": "...", "accountId": "...", "status": "complete", "snapshotHash": "...", "reconciledBy": "..." } }
```

Notes: the book ending balance is **never** accepted from the client — it is computed server-side from the real trial balance through `endDate` (the same computation `close.js` uses). Fails with `422` if any transaction in the account/date range is not `matched`/`classified`/`excluded`, or if the statement and computed book balances don't match exactly.

---

### `GET /api/bookkeeping/ledger/bank`
**Auth:** Signed-in user.
**Purpose:** Read-only dashboard view of a company's imported bank feed: eligible accounts, imported transactions, and completed reconciliations. This is the only bank-feed route with no mutation — see `bank-import`/`bank-classify`/`bank-match`/`bank-reconcile` for the actions that change state.

**Request body / query params:**
- `accountId` (string, optional, query) — filter transactions to one account.
- `status` (string, optional, query) — filter to one of `unmatched|matched|classified_pending|classified`.

**Response:**
```json
{
  "ok": true,
  "accounts": [ { "id": "1000", "name": "Operating Bank", "type": "asset" } ],
  "transactions": [ { "id": "...", "accountId": "1000", "postedDate": "2026-08-01", "amount": -84.5, "status": "unmatched" } ],
  "reconciliations": [ { "id": "...", "accountId": "1000", "endDate": "2026-07-31", "status": "complete" } ]
}
```

Notes: `accounts` is filtered to only `asset`/`liability` type accounts (the ones that can receive a bank import). Transactions are sorted newest-first by `postedDate`.

---

### `POST /api/bookkeeping/ledger/close-package`
**Auth:** Signed-in user.
**Purpose:** Builds and downloads the full accountant close package for a period (chart of accounts, journal entries, trial balance, balance sheet, P&L, cash-flow workpaper, AP aging, bank registers, reconciliations, sales-tax liability, contractor 1099 summary, exceptions, audit log, evidence index, a `.xlsx` review workbook, a PDF reconciliation summary, and a `manifest.json` with a SHA-256 per file) as a zip.

**Request body / query params:**
- `throughDate` (string, optional, `YYYY-MM-DD`) — defaults to today.

**Response:** Not JSON on success — a binary ZIP file stream with headers `Content-Type: application/zip`, `Content-Disposition: attachment; filename="hivelogic-close-package-<companyId>-<throughDate>.zip"`, and `X-Package-Sha256: <sha256 of the zip>`.

On failure (period not ready to close), JSON instead:
```json
{ "ok": false, "error": "Period cannot close: ...", "readiness": { "ready": false, "score": 82, "checks": [...], "blockers": [...] } }
```

Notes: stateless — rebuilds the package fresh every call rather than storing/versioning prepared packages. Gated on the same full 18-point close-readiness checklist as `GET /close`.

---

### `GET /api/bookkeeping/ledger/close`
**Auth:** Signed-in user.
**Purpose:** Returns the 18-point period-close readiness checklist (trial balance balanced, balance sheet balanced, audit chain intact, posted entries unchanged, every expense owned/evidenced/approved, all journals posted, duplicates resolved, all bank/card activity resolved and reconciled, sales tax assigned, contractor paperwork complete, no critical automation exceptions, source links intact, document intake reviewed, etc.) for the given date.

**Request body / query params:**
- `throughDate` (string, optional, query, `YYYY-MM-DD`) — defaults to today.

**Response:**
```json
{
  "ok": true,
  "companyId": "greenwich-handyman",
  "throughDate": "2026-08-21",
  "basis": "accrual",
  "ready": false,
  "score": 83,
  "checks": [ { "id": "trial_balance", "label": "Trial balance balances", "passed": true, "detail": "Debits equal credits.", "blocking": true } ],
  "blockers": [ { "id": "reconciliations", "label": "Every bank and card account is reconciled", "passed": false, "detail": "1 account(s) lack a completed reconciliation through 2026-08-21.", "blocking": true } ],
  "summary": { "expenses": 40, "postedEntries": 55, "unresolved": 3, "trialBalance": {...}, "balanceSheet": {...}, "accountsPayable": {...}, "salesTax": {...}, "contractors": {...} },
  "note": "..."
}
```

Notes: `bank_matching`, `reconciliations`, `reconciliation_integrity`, and `statements` checks read as trivially passing whenever there is no imported bank-feed data (this app has no live bank-feed *connection*, only CSV import). This route does not build/export anything — see `close-package.js` and `export-package.js` for that.

---

### `GET /api/bookkeeping/ledger/entries`
**Auth:** Signed-in user.
**Purpose:** Lists every journal entry (any status) and the chart of accounts for the caller's company.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "entries": [ { "id": "...", "status": "posted", "date": "2026-08-01", "lines": [...] } ], "accounts": [ { "id": "1000", "name": "Operating Bank", "type": "asset" } ] }
```

---

### `POST /api/bookkeeping/ledger/entries`
**Auth:** Signed-in user (creating a `kind: "adjustment"` entry additionally requires the `controller`-mapped role — i.e. HiveLogic `admin`).
**Purpose:** Creates a new journal entry in `pending_approval` status — the first step of the create → approve → post lifecycle.

**Request body / query params:**
- `date` (string, required, `YYYY-MM-DD`) — posting date.
- `description` (string, required)
- `lines` (array, required, ≥2 entries) — each `{ accountId, debit, credit, memo?, dimensions? }`; every line must be either a debit or a credit (not both/neither), all non-negative, and total debits must equal total credits.
- `basis` (string, optional) — `cash` or `accrual`; defaults to the company's basis.
- `cashDate` / `cashLines` (optional) — a parallel cash-basis recognition date/line set.
- `memo` (string, optional)
- `kind` (string, optional) — `standard` (default) or `adjustment` (controller-only).
- `source` / `sourceId` (string, optional) — defaults to `source: "manual"`.

**Response:**
```json
{ "ok": true, "entry": { "id": "...", "status": "pending_approval", "createdBy": "..." }, "qboWritesEnabled": false, "note": "Created as pending approval. No QBO write occurred." }
```

Notes: fails `422` if the posting period is locked, the date is on/before the company's closing date, or debits/credits don't balance.

---

### `POST /api/bookkeeping/ledger/export-package`
**Auth:** Signed-in user.
**Purpose:** Builds an audience-scoped export package (accountant / lender / insurer / buyer) — a lighter-weight, differently-gated alternative to the full close package. Each audience gets a different subset of files (e.g. a lender/insurer export omits the raw audit log and contractor identities). Gated only on the books being internally consistent (valid audit chain, unmodified posted entries, balanced trial balance/balance sheet) — not the full close checklist.

**Request body / query params:**
- `audience` (string, required) — one of `accountant|lender|insurer|buyer`.
- `throughDate` (string, optional, `YYYY-MM-DD`) — defaults to today.
- `basis` (string, optional) — `cash` or `accrual`.
- `fiscalYearStartDate` (string, optional) — derived from the company's `fiscalYearStartMonth` if omitted.
- `format` (string, optional, body or query) — pass `"manifest"` to get a JSON preview instead of a zip download.

**Response (manifest mode):**
```json
{ "ok": true, "manifest": { "format": "...", "companyId": "...", "audience": "accountant" }, "files": [ { "name": "trial-balance.csv", "sha256": "...", "bytes": 2048, "audience": "accountant", "containsSensitive": false } ], "verification": { "valid": true }, "note": "Sales-tax and contractor sections reflect $0 / no contractors because this app has no sales or contractor-payment data source yet -- not fabricated, genuinely empty." }
```

**Response (zip mode):** binary ZIP with headers `Content-Type: application/zip`, `Content-Disposition: attachment; filename="hivelogic-<audience>-export-<companyId>-<throughDate>.zip"`, `X-Export-Verified: true|false`.

Notes: `expenses` (for AP aging) are only included for `accountant`/`buyer` audiences. Sales/tax-payment/contractor-payment arrays are always passed as empty (this app has no data source for them), which produces an honest "$0 / no contractors" result rather than a fabricated one.

---

### `POST /api/bookkeeping/ledger/post`
**Auth:** Signed-in user mapped to ledger role `controller` (posting requires `entry:post` permission, which `submitter` does not have).
**Purpose:** Posts an approved journal entry, making it permanent and included in all reports.

**Request body / query params:**
- `entryId` (string, required)
- `idempotencyKey` (string, optional) — defaults to `post:<entryId>`.

**Response:**
```json
{ "ok": true, "entry": { "id": "...", "status": "posted", "postedBy": "...", "contentSeal": "..." }, "bankTransactionClosed": false }
```

Notes: requires an idempotency key (client-supplied or the auto-generated default) so a retried request can never post the same entry twice — replaying the same key returns the already-posted entry rather than erroring. Only entries in `approved` status can be posted. If the entry originated from a bank-transaction classification (`bank-classify.js`), posting also flips that bank transaction's status from `classified_pending` to `classified` (`bankTransactionClosed: true`) — this is the one place that transition happens, since the underlying engine functions don't know about each other.

---

### `GET /api/bookkeeping/ledger/reports`
**Auth:** Signed-in user.
**Purpose:** Read-only financial reports computed over the posted general ledger (plus, for three report types, real Jobber invoices / saved Expense Entry records).

**Request body / query params:**
- `report` (string, required, query) — one of `trial-balance|income-statement|balance-sheet|general-ledger|retained-earnings|ar-aging|ap-aging|expense-summary`.
- `throughDate` (string, optional) — default `9999-12-31`.
- `startDate` / `endDate` (string, optional) — defaults `0000-01-01` / `9999-12-31`.
- `basis` (string, optional) — `cash` or `accrual`, default `accrual`.
- `fiscalYearStartDate` (string, **required** only for `retained-earnings`).
- `groupBy` (string, optional) — `vendor` (default) or `ownerType`, only used by `expense-summary`.

**Response:** shape depends on `report`:
- `trial-balance` → `{ ok, report, companyId, basis, throughDate, rows: [{accountId, name, type, debit, credit, balance}], totalDebits, totalCredits, balanced }`
- `income-statement` → `{ ok, report, companyId, basis, startDate, endDate, revenue, expenses, netIncome, lines: [...] }`
- `balance-sheet` → `{ ok, report, companyId, basis, throughDate, assets, liabilities, equityPosted, retainedEarningsAndCurrentIncome, equity, balanced, difference }`
- `general-ledger` → `{ ok, report, companyId, basis, startDate, throughDate, rows: [{date, entryId, accountName, debit, credit, memo}], totalDebits, totalCredits, balanced }`
- `retained-earnings` → `{ ok, report, companyId, basis, fiscalYearStartDate, throughDate, postedEquity, priorRetainedEarnings, currentIncome, totalEquity }`
- `ar-aging` → `{ ok, report, throughDate, invoices: [...], count, undatedExcluded, totalOutstanding, buckets }`
- `ap-aging` → `{ ok, report, throughDate, bills: [...], count, totalOutstanding, buckets }`
- `expense-summary` → `{ ok, report, startDate, endDate, groupBy, rows: [{key, total, lineCount}], grandTotal, transactionCount }`

Notes: `ar-aging`/`ap-aging`/`expense-summary` deliberately read from real Jobber invoices / saved Expense Entry records rather than the internal ledger's chart of accounts, because that chart doesn't yet mirror this company's real QuickBooks accounts (see `reseed-accounts` below). No report type mutates anything. Returns `400` for an unrecognized `report` value.

---

### `POST /api/bookkeeping/ledger/reseed-accounts`
**Auth:** Admin only — checks `actor.hivelogicRole === 'admin'` specifically (this is a narrower check than most other controller-gated actions in this domain, which also accept `superadmin`; a `superadmin`-only profile is rejected here with `403`).
**Purpose:** Rebuilds a company's General Ledger chart of accounts from its real, live QuickBooks accounts, replacing the generic 22-account placeholder chart the ledger is provisioned with by default (so real submitted expenses' journal entries can actually match a real QBO account and the Financial Reports tab reconciles to QuickBooks).

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "companyId": "greenwich-handyman", "accountCount": 47, "note": "The General Ledger chart of accounts now matches your live QuickBooks accounts exactly. Submitted expenses will post to the General Ledger correctly going forward." }
```

Notes: refuses (`422`) if the company already has any posted or pending journal entry, since reseeding would break those entries' account references — this makes it safe to expose as a one-click admin action with no separate confirmation dialog.

## Purchase Orders

### `POST /api/bookkeeping/purchase-orders/create`
**Auth:** Signed-in user (any role can request a PO; `field`-mapped `crew` users can create but not approve their own).
**Purpose:** Creates a purchase order — either a planned PO awaiting approval, or an after-the-fact record of a purchase that already happened without one.

**Request body / query params:**
- `jobId` (string) or `overheadCategory` (string) — one of the two required.
- `vendorName` (string) or `qboVendorId` (string) — one of the two required.
- `lines` (array, required, ≥1) — each `{ type: "material"|"labor"|"rental"|"delivery"|"discount"|"tax", estimatedQty, estimatedUnitPrice, description?, taxable?, qboItemId?, qboAccountId? }`; `estimatedQty` must be > 0 unless `type` is `discount`/`tax`.
- `orderType` (string, optional) — `planned` (default) or `after_the_fact`.
- `afterTheFactReason` (string, required if `orderType` is `after_the_fact`).
- `companyCode` (string, optional) — prefix used in the generated PO number, default `PO`.

**Response:**
```json
{ "ok": true, "purchaseOrder": { "id": "...", "poNumber": "PO-GEN-0007", "lifecycleStatus": "draft", "notPreapproved": false, "lines": [...], "history": [...] }, "qboWritesEnabled": false, "storeBackend": "durable", "note": "Created as a planned purchase order awaiting approval. No QBO write occurred." }
```

Notes: `companyId` and `requestedBy` are never accepted from the request body — they are always the authenticated actor's own company/id, closing an earlier bug where a client could supply its own `requestedBy`. `notPreapproved` is set once at creation from `orderType` and can never be changed afterward, even if the PO is later approved. The PO number is allocated by an atomic Postgres sequence (`allocate_po_number`) before the engine runs, never derived by counting existing rows.

---

### `GET /api/bookkeeping/purchase-orders/list`
**Auth:** Signed-in user. (Note: this route does not check `req.method` at all — any HTTP method receives the same read-only response.)
**Purpose:** Lists every purchase order for the caller's own company.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "enabled": true, "purchaseOrders": [ { "id": "...", "poNumber": "...", "lifecycleStatus": "ordered", "status": "exception" } ], "storeBackend": "durable" }
```

Notes: `status` on each PO is a computed overlay — it equals `"exception"` whenever the PO has any unresolved exception, regardless of its underlying `lifecycleStatus`.

---

### `POST /api/bookkeeping/purchase-orders/approve`
**Auth:** Signed-in user mapped to PO role `controller`, `approver`, or `bookkeeper` (in HiveLogic, effectively `admin`/`superadmin` only, via the `controller` mapping).
**Purpose:** Approves a draft purchase order, moving it to `ordered` and stamping its immutable `orderedAt` timestamp (the timestamp every later receipt-timing check compares against).

**Request body / query params:**
- `poId` (string, required) — not explicitly validated in the route; an invalid/missing id surfaces as a 422 "Purchase order not found" from the store layer.

**Response:**
```json
{ "ok": true, "purchaseOrder": { "id": "...", "lifecycleStatus": "ordered", "approverId": "...", "approvedAt": "...", "orderedAt": "..." } }
```

Notes: the PO's own requester can never approve their own PO. Only a PO in `draft` status can be approved.

---

### `GET /api/bookkeeping/purchase-orders/audit-verify`
**Auth:** Signed-in user.
**Purpose:** Checks one purchase order's own append-only history array for internal hash-chain self-consistency.

**Request body / query params:**
- `poId` (string, required, query)

**Response:**
```json
{ "ok": true, "valid": true, "brokenAt": null, "records": 6 }
```

Notes: honest scope limit — this checks that the PO's stored history hasn't been internally tampered with, but does **not** cross-check against an independent, append-only witness table the way `ledger/audit-verify` does. A wholesale rewrite of the stored PO blob could in theory still produce a self-consistent chain, so the UI is expected to label this "history chain self-consistent," not "tamper-proof."

---

### `POST /api/bookkeeping/purchase-orders/bill`
**Auth:** Signed-in user mapped to PO role `controller`/`approver`/`bookkeeper`.
**Purpose:** Marks a purchase order as billed once a vendor bill exists for it, moving it to `billed` status.

**Request body / query params:**
- `poId` (string, required)
- `billId` (string, required)

**Response:**
```json
{ "ok": true, "purchaseOrder": { "id": "...", "lifecycleStatus": "billed", "billIds": ["..."] } }
```

Notes: only a PO in `ordered`, `partially_received`, or `fully_received` status can be billed. Billing re-runs exception detection (e.g. can surface `missing_receipt` if billed with no receipts ever matched).

---

### `POST /api/bookkeeping/purchase-orders/cancel`
**Auth:** Signed-in user who is either the PO's original requester, or mapped to PO role `controller`/`approver`/`bookkeeper`.
**Purpose:** Cancels a purchase order that has no real financial activity against it yet (nothing received, nothing billed).

**Request body / query params:**
- `poId` (string, required)
- `reason` (string, required)

**Response:**
```json
{ "ok": true, "purchaseOrder": { "id": "...", "lifecycleStatus": "cancelled", "cancelled": true, "cancelReason": "..." } }
```

Notes: refuses with `422` if the PO already has received or billed activity — that case must go through `void.js` instead, which preserves the original cost and records an explicit reversal rather than letting it disappear from job costing.

---

### `POST /api/bookkeeping/purchase-orders/close`
**Auth:** Signed-in user mapped to PO role `controller`/`approver`/`bookkeeper` for a plain close; `force: true` additionally requires the PO role `controller` specifically (i.e., `admin`/`superadmin`) plus a written `reason`.
**Purpose:** Closes a purchase order, which is what actually releases its actual costs into job costing. A PO with unresolved exceptions cannot be closed unless a controller explicitly force-closes it with a reason.

**Request body / query params:**
- `poId` (string, required)
- `force` (boolean, optional, default `false`)
- `reason` (string, required only when `force` is `true`)

**Response:**
```json
{ "ok": true, "purchaseOrder": { "id": "...", "lifecycleStatus": "closed", "closedForced": false, "closeOverrideReason": null } }
```

Notes: closing (forced or not) clears the PO's `exceptions` array — the override itself is treated as the resolution — but the pre-close exception list is permanently preserved in `po.history` (`unresolvedExceptionsAtClose`) when forced, never silently dropped. A `draft`, already-`closed`, or `cancelled` PO cannot be closed.

---

### `POST /api/bookkeeping/purchase-orders/void`
**Auth:** Signed-in user mapped to PO role `controller` only.
**Purpose:** The controller-only, audit-preserving reversal path for a purchase order that already has received/billed activity — used instead of `cancel` once real costs are posted. Never edits the original received/billed data; it only flags the PO as voided.

**Request body / query params:**
- `poId` (string, required)
- `reason` (string, required)

**Response:**
```json
{ "ok": true, "purchaseOrder": { "id": "...", "voided": true, "voidedAt": "...", "voidedBy": "...", "voidReason": "..." } }
```

Notes: refuses if the PO has no received/billed activity yet (use `cancel` instead) or is already cancelled/voided. The job-cost feed (`job-cost-report.js`) reads the `voided` flag to emit an equal-and-opposite reversal line alongside the still-fully-visible original — the original cost never simply vanishes.

---

### `POST /api/bookkeeping/purchase-orders/reject`
**Auth:** Signed-in user mapped to PO role `controller`/`approver`/`bookkeeper`.
**Purpose:** Rejects a draft purchase order outright (distinct from cancelling — rejection is an approval-stage decision).

**Request body / query params:**
- `poId` (string, required)
- `reason` (string, required)

**Response:**
```json
{ "ok": true, "purchaseOrder": { "id": "...", "lifecycleStatus": "cancelled", "cancelReason": "Rejected: ..." } }
```

Notes: only a `draft` PO can be rejected; the result lifecycle status is `cancelled` with the reason prefixed `"Rejected: "` to distinguish it in history from a plain cancellation.

---

### `POST /api/bookkeeping/purchase-orders/match`
**Auth:** Signed-in user (role is passed through to the engine, but no specific role beyond authentication is required to submit a match).
**Purpose:** Matches one vendor receipt/bill to one or more purchase-order lines — potentially across several different POs in a single request — validating that any split allocations total exactly 100% and reconcile to the receipt's own recorded amount, then committing every affected PO atomically in one database transaction.

**Request body / query params:**
- `receipt` (object, required) — `{ id (required), companyId (required, must equal the actor's own company), evidenceId (required — a real, previously-uploaded document id; the server looks it up and derives evidenceHash/evidenceDocumentId from it, never trusting a client-supplied hash), vendorTransactionDate (optional, drives timing verification), invoiceNumber?, qboVendorId?, vendorName?, currency?, amount?, lines? }`.
- `matches` (array, required, ≥1) — each `{ poId (required), lineId (required), receiptLineId (required), quantity, unitPrice?, splitPortion? (0 < x ≤ 1, default 1) }`.

**Response:**
```json
{ "ok": true, "purchaseOrders": [ { "id": "...", "lifecycleStatus": "partially_received", "lines": [...], "exceptions": ["planning_unverified"] } ] }
```

Notes: idempotent — each match carries a deterministic key (`companyId::evidenceDocumentId::receiptLineId::lineId::allocationId`), so replaying the same match (a retried request, a double-click) is a safe no-op rather than double-counting received quantity. Blocks with `code: "RETROACTIVE_PLANNING_BLOCKED"` if a planned PO's line is matched to a purchase that provably happened before the PO was approved/ordered; flags (rather than blocks) an `planning_unverified` exception when timing can't be verified (no vendor transaction date, or an ambiguous same-day match). Returns `code: "CROSS_COMPANY_BLOCKED"` (`403`) if the receipt's `companyId` doesn't match the actor's. A duplicate-bill fingerprint is recorded in the same atomic transaction as the PO updates when the receipt carries an `invoiceNumber` or `qboVendorId`.

---

### `GET /api/bookkeeping/purchase-orders/job-cost-report`
**Auth:** Signed-in user. (Note: like `list.js`, this route does not check `req.method`.)
**Purpose:** The owner/controller/accounting-facing report of actual job costs released from purchase orders, split visibly into preapproved vs. after-the-fact totals per job — never blended into one number.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "enabled": true,
  "jobs": [ { "jobId": "job-123", "overheadCategory": null, "preapprovedTotal": 1200.5, "afterTheFactTotal": 80, "total": 1280.5, "lines": [ { "poNumber": "PO-job-123-01", "type": "material", "amount": 300, "notPreapproved": false, "vendor": "Home Depot", "timing": "preapproved", "transactionDate": "2026-08-10" } ] } ],
  "companyTotals": { "preapprovedTotal": 1200.5, "afterTheFactTotal": 80, "total": 1280.5 },
  "notReady": [ { "poNumber": "PO-GEN-0009", "jobId": null, "reason": "This purchase order has not been approved." } ],
  "note": "Only approved, exception-free (or controller-force-closed) actual costs appear here. After-the-fact purchases are always included in the total but are never counted as preapproved, in this report or any export."
}
```

Notes: only costs the engine considers ready to release appear here — draft POs, unapproved POs, and POs with unresolved exceptions are excluded and instead listed under `notReady`. A voided PO's original line and its equal-and-opposite reversal line both appear (net zero), never silently removed.

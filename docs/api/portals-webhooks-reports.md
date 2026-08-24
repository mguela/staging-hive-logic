# Portals, Webhooks, Health & Reports

This groups external-facing customer/subcontractor portals, third-party webhooks (payments, email delivery), internal health/status-monitoring intake, a photo-import integration, and financial reports.

## Client & Subcontractor Portals

Every session-scoped action on both portals filters by the `client_ref`/`sub_id` taken from the **resolved session row** — never from the request body — so a client can only ever see their own jobs/invoices/approvals/messages/photos (and only photos with a live, non-revoked `client_photo_shares` row; no share row means the photo doesn't exist as far as this API is concerned). A subcontractor can only see their own RFQs/RFIs/schedule/invoices/documents/banking. Neither portal exposes another client's/sub's data, staff-only tables, or the underlying Storage bucket directly — only short-lived signed URLs. `subportal.js` additionally gates banking **writes** behind a second, out-of-band reauth token emailed only to the on-file address (never returned to the browser) — a stolen session token alone cannot change payout banking info. Both portals' public recovery endpoints (`login_link`) give an identical, non-enumerating response whether or not the account exists, and are rate-limited, failing closed if the rate-limit store is unavailable.

Each action below uses one of three auth mechanisms: a **staff** Supabase session (+ role gate where noted), a **client/sub session** bearer token (issued at `redeem`/`login_link`), or **public/self-service** (no session needed — token- or code-scoped instead).

### `api/clientportal.js` (`?action=`)

- `invite` — staff — invites a client to the portal.
- `redeem` — public (invite-token-scoped) — redeems an invite, opening a client session.
- `login_link` — public, non-enumerating, rate-limited — sends a magic sign-in link.
- `me` — client session — the signed-in client's own profile.
- `notifications` / `notifications_read` — client session — the client's notification feed.
- `jobs` / `job` — client session — the client's own jobs, list and single.
- `photos` — client session — photos shared to the client (only rows with a live `client_photo_shares` entry).
- `photo_share` / `photo_revoke` — staff — grants/revokes a client's access to a specific photo.
- `photos_review` — staff — the staff-side photo-sharing review queue.
- `approvals` — client session — the client's pending approvals.
- `approval_create` — staff — creates a new approval request for a client.
- `approval_sign` / `approval_reject` — client session — the client approves or rejects.
- `invoices` — client session — the client's own invoices (see field shape below).
- `payment_request` — client session — requests to pay an invoice.
- `messages` / `message_send` — client session — the client's message thread with staff.

Notes: `invoices`' `mapInvoice()` returns real field names taken verbatim from the response: `id, jobNumber, status, subject, total, payments, deposit, discount, balance, dueDate, issuedDate, jobberUrl`.

### `api/subportal.js` (`?action=`)

**Staff-facing surface** (staff Supabase session):
`invite`, `subs_list`, `sub_detail`, `docs_expiring`, `rfq_create`, `rfq_review`, `rfi_answer`, `schedule_item_create`, `invoice_status_update`, `staff_messages`, `staff_message_send`.

**Subcontractor-facing surface** (sub session bearer token, unless marked public):
`redeem` (public, invite-token-scoped), `login_link` (public, non-enumerating), `reauth_start` (sub session — starts the out-of-band banking-write reauth), `me`, `profile`, `notif_prefs`, `notifications` / `notifications_read`, `documents`, `banking` (write path requires the reauth token from `reauth_start`), `account`, `jobs`, `rfqs`, `rfq_bid`, `rfis`, `rfi_ask`, `schedule`, `schedule_respond`, `calendar.ics`, `invoices`, `invoice_submit`, `invoice_followup`, `messages`, `message_send`.

Notes: the `banking` write path's validation response shape is `{ ok, banking: { id, sub_id, accepts_ach, updated_at } }`.

File uploads (`documents`, `invoice_submit`) take a base64 `data:` URL, capped at
5 MB, restricted to PDF and photo types. They go into the private `docs` bucket
under `subs/documents/{sub_id}/` and `subs/invoices/{sub_id}/` and get a
`public.documents` row; `file_url` on `sub_documents` / `sub_invoices` holds the
bare storage path, which is the join back to that row. Compliance documents are
marked `sensitive` (a W9 carries a taxpayer ID); invoices are not.

Until 2026-08-22 these wrote to buckets named `sub-documents` and `sub-invoices`
that have never existed on the production project, so every sub upload failed
with a 502 that quoted the raw storage error back to the subcontractor.

## Payment & Email Webhooks

### `POST /api/authnet-webhook`
**Auth:** Public — verified via `verifyAuthnetSignature()` against the raw request body, checked against the `x-anet-signature` header.
**Purpose:** Receives Authorize.Net payment-status events.

**Response:**
```json
{ "ok": true }
```

Notes: a real, present security control — this endpoint never trusts the webhook payload alone. It makes a second, server-to-server `getTransactionDetailsRequest` call to Authorize.Net and only marks an invoice paid when that independent check confirms `settledSuccessfully`.

### `POST /api/resend-webhook`
**Auth:** Public — verified via Resend's Svix HMAC signature scheme (`svix-id`/`svix-timestamp`/`svix-signature` headers, 5-minute replay window, timing-safe comparison).
**Purpose:** Receives email delivery/bounce/complaint events from Resend.

**Response:**
```json
{ "ok": true }
```

Notes: fails closed (`503`) if `RESEND_WEBHOOK_SECRET` isn't configured, rather than accepting unverified events.

## Health & Status Monitoring

### `POST /api/status-hub-ingest` / `POST /api/status-hub-log-drain`
**Auth:** A static, timing-safe shared-secret bearer compare (`STATUS_HUB_INGEST_SECRET` / `STATUS_HUB_LOG_DRAIN_SECRET` respectively) — not a per-request signature scheme like the two webhooks above. Fails closed (`503`) if the relevant secret is unset.
**Purpose:** Write-only, failure-only machine intake feeding `app_status_findings` — the same store the self-test crawler and `health-cron.js` also feed into. These two endpoints have **no read path at all**. `status-hub-log-drain` documents both a `?src=vercel` and a `?src=supabase` variant.

**Response:**
```json
{ "ok": true }
```

Notes: this shared-secret mechanism is materially weaker than the two payment/email webhooks above (no per-request signing) — an accepted tradeoff since it's an internal-only intake surface with nothing to read back.

### `GET /api/health`
**Auth:** None — intentionally public.
**Purpose:** A trivial liveness probe (used by the Reina chat widget). No data exposure.

**Response:**
```json
{ "ok": true }
```

### `GET /api/health-cron`
**Auth:** `checkCronSecret` against the `Authorization` header only.
**Purpose:** Runs the scheduled health-check sweep.

**Response:**
```json
{ "ok": true, "checks": [ { "name": "...", "status": "...", "detail": "..." } ] }
```

Notes: the file's own header comment says "Manual test: `GET /api/health-cron?key=<CRON_SECRET>&dryrun=1`", but the handler never actually reads `req.query.key` — only the `Authorization` header is checked. A `?key=` query param alone will not authenticate (fails closed, so this isn't a security hole, but the comment is misleading and worth fixing).

### `GET /api/health-test`
**Auth:** N/A.
**Purpose:** Retired. Always returns `410` — kept only pending deletion, not a live health check.

### `GET /api/integrations-health`
**Auth:** Signed-in staff.
**Purpose:** Reports the connection health of every third-party integration.

**Response:**
```json
{ "ok": true, "generatedAt": "iso", "readOnly": true, "integrations": [ { "id": "...", "label": "...", "state": "...", "configured": true, "connected": true, "healthVerified": true, "refreshMode": "...", "detail": "...", "updatedAt": "iso", "expiresAt": "iso", "reconnectUrl": "..." } ] }
```

Notes: deliberately excludes `access_token`/`refresh_token` from every integration's payload — this is an inventory/health surface only, never a secret-reading one.

## Photo Import (CompanyCam)

### `GET /api/import-companycam`
**Auth:** Vercel Cron (`CRON_SECRET`) — **with a documented "rollout grace"**: if `CRON_SECRET` is unset in the environment, the endpoint allows unauthenticated requests through (with a console warning) rather than blocking.
**Purpose:** Batch-imports job photos from CompanyCam.

**Request body / query params:**
- `reset` (`1`, optional) — modifier for a full re-import.
- `remap` (`1`, optional) — rewrites existing photo→job attachments.

**Response:**
```json
{ "ok": true, "imported": 0 }
```

Notes: until `CRON_SECRET` is actually set, this endpoint — which can rewrite photo→job attachments via `?remap=1` — has no enforced auth. Worth confirming that variable is set in every environment this runs in.

## Financial Reports

### `GET /api/reports/summary`
**Auth:** Signed-in staff.
**Purpose:** A summarized financial report.

**Response:**
```json
{ "ok": true, "summary": {} }
```

### `GET /api/reports/anomalies`
**Auth:** Signed-in staff.
**Purpose:** Flags financial anomalies for review.

**Response:**
```json
{ "ok": true, "anomalies": [] }
```

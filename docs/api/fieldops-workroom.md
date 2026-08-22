# Field Ops & Workroom APIs

"Field ops" is the tech-facing mobile surface (`public/field/`) plus the client-facing live-tracking page (`public/track/`), both backed by `api/fieldops.js` — clock in/out, travel ETAs, photos, signatures, T&M invoicing. "Workroom" (`api/workroom.js`) is a different thing entirely: a task ledger + cryptographic completion-gate that lets external coding agents (Codex, ChatGPT, Claude, Claude Code, Grok, Reina) claim, work on, and get a receipted "verified done" status on tasks owned by a HiveLogic user. It is not a chat/collaboration UI, and it makes no LLM calls itself. `api/onboarding.js` and `api/invites.js` round out this file — the company setup wizard and the employee/subcontractor invite-and-provisioning flow.

All staff-gated `fieldops` actions use a file-local `getStaffProfile()` (Supabase bearer token → `/auth/v1/user` → `profiles` row) — described below as "signed-in user" (any role) unless a specific action requires one of `FIELD_DISPATCH_ROLES` (admin/superadmin/owner/dispatch/office_manager).

## `api/fieldops.js`

### `GET /api/fieldops?action=travel_view&t=TOKEN`
**Auth:** Public — authenticated by a capability token (`t`), not a session.
**Purpose:** The client-facing "your tech is on the way" tracking page.

**Request body / query params:**
- `t` (string, required) — the travel session's capability token.

**Response:**
```json
{ "ok": true, "eta": {"minutes": 12}, "position": {"lat": 41.03, "lng": -73.62} }
```

Notes: coordinates are coarsened to 2 decimal places (~0.4–0.7 mi) before this response leaves the server — the tech's exact position never reaches the client. The ETA formula: haversine straight-line miles × 1.3 (road-winding factor) ÷ 28 mph (assumed average local speed) × 60, + 4 min buffer, floored at 5 min minimum — labeled "approximate" everywhere it's surfaced, on purpose.

### `GET /api/fieldops?action=tm_pay_init&t=TOKEN`
**Auth:** Public — capability token, also present on `guard.js`'s `PUBLIC_RESOURCE_PATHS` allowlist at the edge.
**Purpose:** Initializes a client-facing time & materials payment page for a given invoice token.

**Request body / query params:**
- `t` (string, required) — the T&M invoice's capability token.

**Response:**
```json
{ "ok": true, "invoice": { "id": "...", "amount": 0, "status": "unpaid" } }
```

### `GET /api/fieldops?action=day`
**Auth:** Signed-in tech.
**Purpose:** Returns the signed-in tech's schedule/status for the current day.

**Response:**
```json
{ "ok": true, "visits": [], "clockedIn": false }
```

### `POST /api/fieldops?action=travel_start`
**Auth:** Signed-in tech.
**Purpose:** Starts a live-tracked trip to a job, generating the client-facing tracking link and the first ETA.

**Request body / query params:**
- `jobRef` / visit identifier (required)
- current lat/lng (required)

**Response:**
```json
{ "ok": true, "token": "...", "trackingUrl": "https://.../track?t=...", "etaMinutes": 12, "smsHref": "sms:?body=..." }
```

Notes: no SMS provider is wired to auto-send anything — the response hands back a prefilled `smsHref`/`smsBody` for the tech's own phone to send, not an automatic send.

### `POST /api/fieldops?action=travel_ping`
**Auth:** Signed-in tech.
**Purpose:** Updates the tech's live position mid-trip, recomputing the ETA.

**Response:**
```json
{ "ok": true, "etaMinutes": 8 }
```

### `POST /api/fieldops?action=travel_end`
**Auth:** Signed-in tech.
**Purpose:** Ends the live-tracked trip (arrival).

**Response:**
```json
{ "ok": true }
```

### `POST /api/fieldops?action=time_start`
**Auth:** Signed-in tech; whole-team clock-ins additionally require a `FIELD_DISPATCH_ROLES` role (admin/superadmin/owner/dispatch/office_manager) via the crew-chaining logic in `api/_lib/crew-clock.js`.
**Purpose:** Clocks in a tech (or a whole crew) against a job, tagged by kind.

**Request body / query params:**
- `kind` (string, required) — one of `travel`, `supplies`, `onsite`, `lunch`, `break`.
- `wholeTeam` (boolean, optional) — clocks in the whole assigned crew at once (dispatch-role gated).

**Response:**
```json
{ "ok": true, "entry": { "id": "...", "kind": "onsite", "startedAt": "iso" } }
```

Notes: backed by the `hl_field_time_start` RPC.

### `POST /api/fieldops?action=time_stop`
**Auth:** Signed-in tech.
**Purpose:** Clocks out the current open time entry.

**Response:**
```json
{ "ok": true, "entry": { "id": "...", "endedAt": "iso" } }
```

Notes: backed by the `hl_field_time_stop` RPC.

### `POST /api/fieldops?action=request_create`
**Auth:** Signed-in tech.
**Purpose:** Files a field request back to the office (more time, materials, extra work, a message, a job status update, or a free-text note).

**Request body / query params:**
- `kind` (string, required) — one of `more_time`, `materials`, `extra_work`, `office_msg`, `client_msg`, `job_status`, `note`.

**Response:**
```json
{ "ok": true, "request": { "id": "...", "kind": "materials", "status": "open" } }
```

Notes: `kind: 'client_msg'` also inserts a row into `client_messages`, so the client sees it too.

### `POST /api/fieldops?action=photo_add`
**Auth:** Signed-in tech.
**Purpose:** Uploads a job photo, with an optional AI equipment read.

**Request body / query params:**
- photo bytes (required, uploaded to the Supabase Storage `media` bucket).

**Response:**
```json
{ "ok": true, "photo": { "id": "...", "url": "..." }, "equipmentRead": null }
```

Notes: if `ANTHROPIC_API_KEY` is configured, this makes a real Claude vision call (`@anthropic-ai/sdk`, model from `ANTHROPIC_MODEL` env, default `claude-sonnet-4-5`) with an explicit "read the tag exactly, say not visible rather than guess" instruction. The result is stored in `media_analysis` and returned to the tech for confirmation — see `equipment_save` below.

### `POST /api/fieldops?action=signature_save`
**Auth:** Signed-in tech.
**Purpose:** Saves a client's signature (e.g. job completion sign-off).

**Response:**
```json
{ "ok": true, "signature": { "id": "...", "url": "..." } }
```

Notes: writes to `job_signatures`, uploads the PNG to Storage.

### `POST /api/fieldops?action=equipment_save`
**Auth:** Signed-in tech.
**Purpose:** Lets the tech confirm or override the AI equipment read from `photo_add`.

**Response:**
```json
{ "ok": true }
```

Notes: upserts into `media_analysis` — the tech's confirmed value always wins over the AI's guess.

### `POST /api/fieldops?action=job_report`
**Auth:** Signed-in tech.
**Purpose:** Files an end-of-job report.

**Request body / query params:**
- `reportType` (string, required) — `service` or `renovation`.

**Response:**
```json
{ "ok": true, "report": { "id": "..." } }
```

Notes: writes to `field_job_reports`.

### `GET /api/fieldops?action=tm_invoice_prefill&jobRef=`
**Auth:** Signed-in tech.
**Purpose:** Read-only preview of billable hours for a T&M invoice before creating it.

**Response:**
```json
{ "ok": true, "billableHours": 0, "lines": [] }
```

Notes: computed via `api/_lib/tm-billable.js`'s `summarizeBillable()` — no write.

### `POST /api/fieldops?action=tm_invoice_create`
**Auth:** Signed-in tech.
**Purpose:** Creates a time & materials invoice from a job's clocked hours and materials.

**Response:**
```json
{ "ok": true, "invoice": { "id": "...", "amount": 0 }, "smsHref": "sms:?body=..." }
```

Notes: computes labor + materials + a cash-discount adjustment via the `CARD_RATE_BPS` env var (falls back honestly to no-fee pricing if the underlying migration hasn't run yet), queues an email via the outbox, and returns an `smsHref` fallback (no auto-send, same as `travel_start`).

### `POST /api/fieldops?action=tm_invoice_mark_paid_offline`
**Auth:** Signed-in tech.
**Purpose:** Marks a T&M invoice paid by cash, check, or ACH.

**Response:**
```json
{ "ok": true, "invoice": { "id": "...", "status": "paid" } }
```

Notes: card payments are excluded on purpose — a card payment can only be marked paid by the real Authorize.Net webhook, never by this manual action.

### `GET /api/fieldops?action=tm_invoice_status&id=`
**Auth:** Signed-in tech.
**Purpose:** Checks the payment status of a T&M invoice.

**Response:**
```json
{ "ok": true, "status": "unpaid" }
```

## `api/workroom.js`

Auth model, stated once since it's identical across every operation below: a signed-in HiveLogic user, **or** the workroom agent bridge (a shared secret in the `x-hivelogic-workroom-secret` header, matched against `HIVELOGIC_WORKROOM_AGENT_SECRET`, acting on behalf of a fixed configured owner, `HIVELOGIC_WORKROOM_OWNER_ID`). `add_evidence` and `post_review` are bridge/agent-only — not reachable by a plain signed-in user at all.

### `GET /api/workroom`
**Auth:** Signed-in user or the workroom bridge.
**Purpose:** Lists tasks owned by the resolved owner.

**Response:**
```json
{ "ok": true, "tasks": [] }
```

### `GET /api/workroom?taskId=`
**Auth:** Signed-in user or the workroom bridge.
**Purpose:** Returns one task's full packet — the task, its event log, and its evidence.

**Response:**
```json
{ "ok": true, "task": {}, "events": [], "evidence": [] }
```

### `POST /api/workroom` (`action: 'create_task'`)
**Auth:** Signed-in user or the workroom bridge.
**Purpose:** Creates a new task on the ledger.

**Response:**
```json
{ "ok": true, "task": { "id": "..." } }
```

### `POST /api/workroom` (`action: 'update_task'`)
**Auth:** Signed-in user or the workroom bridge.
**Purpose:** Updates a task's status.

**Response:**
```json
{ "ok": true, "task": { "id": "...", "status": "in_progress" } }
```

Notes: a transition to `status: 'done'` runs `evaluateTaskCompletion()` (the completion gate) before it's allowed. The gate requires evidence of each type — `diff`, `test`, `crawler`, `preview`, `review`, `deployment` — each with `verdict: 'pass'`, a `summary`, and a `reference`; the `diff` reference must contain a real git SHA, `preview`/`deployment` references must be HTTPS URLs, and `review` must come from a different actor than the assigned agent. Failing any of that returns `409` with `"Work is NOT DONE"` rather than letting the status flip.

### `POST /api/workroom` (`action: 'add_evidence'`)
**Auth:** Workroom agent bridge only — a plain signed-in user gets `403`.
**Purpose:** Attaches one piece of completion evidence (diff/test/crawler/preview/review/deployment) to a task.

**Response:**
```json
{ "ok": true, "evidence": { "id": "..." } }
```

### `POST /api/workroom` (`action: 'post_review'`)
**Auth:** Workroom agent bridge only.
**Purpose:** Posts a review event on a task; an `eventType: 'completed'` review also runs the completion gate.

**Response:**
```json
{ "ok": true, "event": { "id": "..." } }
```

## `api/onboarding.js`

Every resource here requires `requireApiAuth` (signed-in user, or Vercel Cron with `CRON_SECRET` per `guard.js` — in practice this is a user-driven setup wizard, not a cron job) plus tenant resolution via `resolveCompany`.

### `GET /api/onboarding?resource=trades`
**Auth:** Signed-in user.
**Purpose:** Returns the global trade catalog (not company-scoped).

**Response:**
```json
{ "ok": true, "trades": [] }
```

### `GET /api/onboarding?resource=session`
**Auth:** Signed-in user.
**Purpose:** Gets or creates the caller's onboarding session and its steps.

**Response:**
```json
{ "ok": true, "session": { "id": "..." }, "steps": [] }
```

### `POST /api/onboarding?resource=step`
**Auth:** Signed-in user.
**Purpose:** Upserts one onboarding step and recomputes the overall confidence score.

**Request body / query params:**
- `stepKey` (string, required) — one of `trade`, `company`, `connect_books`, `crew`, `rate`, `import`, `live`.

**Response:**
```json
{ "ok": true, "step": { "key": "trade", "completedAt": "iso" }, "confidenceScore": 0.8 }
```

Notes: the confidence score is a real, source-weighted average over `cost_lines.source` (`confirmed`/`manual` = 1.0, `imported` = 0.8, `benchmark` = 0.3), falling back to a plain fraction of completed steps when no cost lines exist yet — never an invented number. This endpoint does not itself create Gusto or company employee records; that happens in `invites.js`'s `finish()`/`provision_test()` below.

## `api/invites.js`

`/api/invites` is fully public at the edge guard level (it's on `guard.js`'s `PUBLIC_API_PREFIXES`) and self-gates per resource inside the handler.

### `POST /api/invites?resource=create`
**Auth:** Signed-in admin (`requireApiAuth`).
**Purpose:** Invites an employee or subcontractor.

**Response:**
```json
{ "ok": true, "redeemLink": "https://.../invite?token=..." }
```

Notes: mints a 32-byte CSPRNG token, stores only its SHA-256 hash, emails the redeem link via Resend if configured, and returns the link to the authenticated admin — the raw token is never logged.

### `GET/POST /api/invites?resource=redeem&token=`
**Auth:** Public — one-time-token authenticated.
**Purpose:** Redeems an invite, opening an onboarding session for the invited employee/subcontractor.

**Response:**
```json
{ "ok": true, "sessionId": "..." }
```

### `POST /api/invites?resource=send_code`
**Auth:** Public — session-scoped.
**Purpose:** Sends a 6-digit SMS verification code via Twilio (if configured).

**Response:**
```json
{ "ok": true }
```

Notes: 10-minute TTL; the code itself is never returned in the response.

### `POST /api/invites?resource=verify_code`
**Auth:** Public — session-scoped.
**Purpose:** Verifies the SMS code sent above.

**Response:**
```json
{ "ok": true, "verified": true }
```

### `POST /api/invites?resource=upload_license`
**Auth:** Public — session-scoped.
**Purpose:** Uploads a license/ID document during onboarding.

**Response:**
```json
{ "ok": true, "uploaded": true }
```

Notes: uploads to a private `onboarding-licenses` bucket, capped at 5MB, with no OCR — every upload is flagged for manual office review.

### `POST /api/invites?resource=finish`
**Auth:** Public — session-scoped.
**Purpose:** Completes onboarding, creating the real Gusto employee record.

**Response:**
```json
{ "ok": true, "employee": { "gustoEmployeeUuid": "..." } }
```

Notes: this is the one place in this file that makes a real external write — `provisionEmployee()` (`api/_lib/gusto-provision.js`) POSTs to Gusto's `/v1/companies/{id}/employees` with `self_onboarding: true`, so Gusto (not HiveLogic) collects SSN/bank details directly. Also creates a job and sets compensation, is idempotent, and inserts a durable `employee_pay` row keyed to the Gusto employee UUID.

### `POST /api/invites?resource=provision_test`
**Auth:** Signed-in admin (`requireApiAuth`).
**Purpose:** Runs the same `provisionEmployee()` call as `finish()`, for a synthetic test hire.

**Response:**
```json
{ "ok": true, "employee": { "gustoEmployeeUuid": "..." } }
```

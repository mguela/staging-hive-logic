# track1.js API Reference — Part 2 (M–W)

This covers the second alphabetical half of `api/track1.js`'s 100 dispatched resources (`materials_overview` through `workforce_team_status`). See `docs/api/track1-part1.md` for the file's backstory, the first alphabetical half (`app_status_attachment_upload` through `materials_nickname_save`), and the global auth-gate rules that apply throughout this file.

**Quick recap of the global gate:** unless a resource is explicitly exempted, every request first passes `requireApiAuth(req)` — a signed-in Supabase session bearer token, or a `CRON_SECRET` bearer for Vercel Cron — `401` otherwise. This half's exemptions: `reina_lab_read` (self-authenticates via a dedicated `REINA_LAB_READ_TOKEN`, timing-safe compared), the Monitor-agent resources (self-authenticate via a hashed device bearer token through `api/_lib/monitor.js`, not a Supabase session), `workforce_auto_clockout` (a `navigator.sendBeacon` browser-close beacon that can't set an `Authorization` header, so it falls back to a token in the request body), and `workforce_sweep_gone` (cron-only, its own internal `CRON_SECRET` check). `watching_margin_fade` is one of the six `FINANCIAL_RESOURCES`, requiring admin/superadmin or a dispatch permission role of owner/office_ar.

**Note on scope:** six more resources (`quotes`, `requests`, `visits`, `expenses`, `timesheets`, `users`) are dispatched through a separate `RESOURCE_CONFIG` table-lookup path later in the same file, rather than a `resource === '...'` literal — they aren't covered by this doc or its sibling, since neither matches that lookup pattern.

**Quick index:** materials_overview · materials_search · monitor_consent · monitor_heartbeat · monitor_my_status · monitor_pair · monitor_pairing_code · monitor_prune · monitor_review · monitor_screenshot_upload · monitor_settings · monitor_status · monitor_user_toggle · my_jobs_today · my_role · notifications · pto_allowance_set · pto_balances · pto_coverage · pto_decide · pto_requests · reina_lab_read · reina_todo_get · reina_todo_set · schedule_range · subcontractors · team · team_todo_detections · tech_live_status · tm_live · tm_overview · tm_rate_types_list · today_schedule · watching_all · watching_bridge_status · watching_margin_fade · watching_unscheduled · weather · workforce_auto_clockout · workforce_break · workforce_clock · workforce_set_status · workforce_settings · workforce_status · workforce_summary · workforce_sweep_gone · workforce_team · workforce_team_status

## Materials Catalog

### `GET /api/track1?resource=materials_overview`
**Auth:** Global gate only — `requireApiAuth(req)` (a signed-in Supabase session bearer token, or `CRON_SECRET`). `401 { "ok": false, "error": "Not signed in -- log into HiveLogic first." }` if neither is present. `handleMaterialsOverview(res)` itself performs no further auth or method check (it doesn't even receive `req`).

**Purpose:** Summarizes jobs whose materials are currently ordered or on-site, for the Command Center's materials lens.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "materials_overview",
  "counts": { "ordered": 0, "onSite": 0 },
  "ordered": [
    { "jobRef": "...", "jobNo": "...", "title": "...", "status": "...", "materialsStatus": "ordered", "materialsEta": "...", "updatedAt": "..." }
  ],
  "onSite": [ "...same shape, materialsStatus: on_site..." ],
  "notAvailable": {
    "vendorReliability": "Vendor on-time % is not tracked yet -- no real vendor-delivery data source is connected.",
    "purchaseOrders": "Full PO tracking (numbers, line items, ship dates) lives in a separate purchase-orders engine that is built but not yet merged into this app."
  }
}
```

Notes: reads `job_workflow` rows where `materials_status != 'not_ordered'`, joins to `jobs` by `jobber_id`. `jobNo` prefers the job's `project_seq` (via `jobRef()`) over the raw `job_number`, matching the key the schedule board's materials lens actually reads. `notAvailable` is a deliberate honesty flag, not filler — those two features are not wired up yet.

### `GET /api/track1?resource=materials_search`
**Auth:** Global gate only — same `requireApiAuth` as above. No per-handler auth check.

**Purpose:** Searches one vendor catalog (or all connected vendors at once) for a product, merging in any personally-saved nicknames that match.

**Request body / query params:**
- `q` or `query` (string, required) — search text; `400` if missing.
- `mode` (string, optional, default `keyword`)
- `vendor` (string, optional, default `homedepot`) — a known adapter key, or `all` to fan out to every adapter whose `connectorType === 'api'`.
- `store_id`, `zip` (string, optional) — passed through to the vendor adapter.

**Response (single vendor):**
```json
{
  "ok": true,
  "resource": "materials_search",
  "vendor": "homedepot",
  "connectorType": "api",
  "results": [ "...vendor results, nickname matches prepended..." ],
  "nicknameMatchCount": 0
}
```

**Response (`vendor=all`):**
```json
{
  "ok": true,
  "resource": "materials_search",
  "vendor": "all",
  "connectorType": "aggregate",
  "connected": true,
  "searchMode": "keyword",
  "query": "...",
  "perVendor": [ { "vendor": "...", "label": "...", "connected": true, "error": null, "count": 0 } ],
  "results": [ "...nickname matches + combined vendor results..." ],
  "nicknameMatchCount": 0
}
```

Notes: on an unknown `vendor` key, `400 { "ok": false, "error": "Unknown vendor '...'. Available: ..." }`. If the live vendor search throws but saved nicknames matched, the handler still returns `200` with `results` limited to the nickname matches plus a `liveSearchError` field — a vendor outage does not hide the user's own saved data. Only fails with `502` when the vendor errors AND no nickname matches exist.

## Monitor Agents

Monitor resources fall into two authentication classes, stated precisely per resource below:
- **Supabase-session resources** (`monitor_pairing_code`, `monitor_my_status`, `monitor_review`, `monitor_prune`) — go through the file's global `requireApiAuth` gate first, then most also call `getRequestingProfile(req)` internally, which independently re-verifies the bearer token against Supabase's own `/auth/v1/user` endpoint.
- **Monitor Agent resources** (`monitor_pair`, `monitor_heartbeat`, `monitor_consent`, `monitor_screenshot_upload`) — listed in `MONITOR_AGENT_RESOURCES` and exempted from the global gate on `POST`. They self-authenticate via `getRequestingAgent(req)` → `requireMonitorAgent(req)` (`api/_lib/monitor.js`), which SHA-256 hashes the presented `Authorization: Bearer <token>` and looks up a `monitor_agents` row with a matching `agent_token_hash` and `status='active'`. This is the HiveLogic Monitor desktop agent's own long-lived token, never a Supabase JWT.

### `POST /api/track1?resource=monitor_pairing_code`
**Auth:** Signed-in HiveLogic employee. Passes the global `requireApiAuth` gate, then the handler calls `getRequestingProfile(req)` itself and returns `401 { "ok": false, "error": "Not signed in." }` if that fails — effectively requires a real Supabase user session (the cron-secret path alone would not satisfy this second check). `405` on any method other than `POST`.

**Purpose:** Generates a short-lived 6-digit code the employee types into the desktop agent to pair it to their account.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "pairingCode": "123456", "expiresAt": "2026-08-22T..." }
```

Notes: deletes any of the employee's existing `pending` `monitor_agents` rows before issuing a new code (only one pending pairing at a time). Code is generated with `crypto.randomInt` (CSPRNG), zero-padded, 15-minute expiry.

### `POST /api/track1?resource=monitor_pair`
**Auth:** NOT a Supabase session. This is the enrollment exchange itself — no agent token exists yet by definition — so it is hardened directly: max 15 pairing attempts per IP per 10 minutes (`monitor_pair_attempts`), and the matching `pending` `monitor_agents` row is deleted after 5 wrong-code guesses. Exempted from the global gate via `MONITOR_AGENT_RESOURCES` (POST only). `405` on any non-POST method.

**Purpose:** Exchanges a valid pairing code + account email for a permanent agent bearer token, completing device enrollment.

**Request body / query params:**
- `pairingCode` (string, required)
- `email` (string, required) — matched case-insensitively against `profiles.email`.
- `platform` (string, required) — must be `"windows"` or `"mac"`, else `400`.
- `deviceName` (string, optional)
- `agentVersion` (string, optional)

**Response:**
```json
{ "ok": true, "agentToken": "<64-char hex token>" }
```

Notes: privacy/security-sensitive — `agentToken` is returned in plaintext exactly once at pairing time; only its SHA-256 hash (`agent_token_hash`) is ever persisted, and any legacy plaintext `agent_token` column is cleared on pairing. Failure paths: `429` (IP rate limit), `400` (missing fields, bad platform, no/expired/wrong code), `404` (no account for that email), `500` (write failure).

### `POST /api/track1?resource=monitor_heartbeat`
**Auth:** Monitor Agent bearer token via `getRequestingAgent(req)` (`requireMonitorAgent`). `401 { "ok": false, "error": "Unknown or revoked agent token." }` if the token doesn't hash-match an active agent. `405` on non-POST.

**Purpose:** The agent's ~60-second keepalive; also opens/closes `monitor_sessions` in step with the employee's clock-in state and tells the agent whether it's currently allowed to capture activity/screenshots.

**Request body / query params:**
- `agentVersion` (string, optional) — only stored if well-formed and different from the agent's last-known version.
- `activityLevel` (number, optional, clamped 0-100)
- `idleSeconds` (number, optional)
- `activeApp` (string, optional, truncated to 200 chars)
- `displayCount` (number, optional)

**Response (not clocked in):**
```json
{ "ok": true, "clockedIn": false, "shouldCapture": false, "heartbeatWriteError": null, "agentVersionSeen": "1.2.5" }
```

**Response (clocked in):**
```json
{
  "ok": true,
  "clockedIn": true,
  "shouldCapture": true,
  "consent": "allowed",
  "monitorSessionId": "...",
  "monitoringEnabled": true,
  "monitoringRequired": true,
  "screenshotIntervalMinutes": 5,
  "blurScreenshots": false,
  "heartbeatWriteError": null,
  "agentVersionSeen": "1.2.5"
}
```

Notes — privacy-sensitive: an `activity_samples` row (`activityLevel`, `idleSeconds`, `activeApp`, `displayCount`) is written ONLY when consent is already `'allowed'` AND the employee's `monitoring_enabled` flag is true (`decision.recordActivity`, checked before any write) — `'pending'` consent records nothing. If the employee has declined consent and their account requires monitoring, this same call force-ends their clock-in (`endClockInForDeclinedMonitoring`, sets `close_reason`) and returns `{ "ok": true, "clockedIn": false, "shouldCapture": false, "consent": "denied", "clockedOutForDecline": true, ... }`. `heartbeatWriteError` surfaces a failed bookkeeping write (e.g. a rejected `agent_version` PATCH) without failing the heartbeat itself.

### `POST /api/track1?resource=monitor_consent`
**Auth:** Monitor Agent bearer token, same `getRequestingAgent`/`requireMonitorAgent` mechanism as heartbeat. Additionally, the target `monitorSessionId` must belong to THIS agent's `agent_id` and still be open (`ended_at is null`) — `403 { "ok": false, "error": "That monitor session is not open for this agent." }` otherwise, so one paired device can never answer consent for another. `405` on non-POST.

**Purpose:** Records the employee's explicit allow/deny answer to the per-clock-in "you are being monitored" prompt shown by the desktop agent.

**Request body / query params:**
- `monitorSessionId` (string, required, UUID)
- `allow` (boolean, required) — truthy = allowed, falsy = denied.

**Response:**
```json
{ "ok": true, "consent": "allowed", "clockedOut": false, "monitoringRequired": false }
```

Notes — privacy-sensitive: this is the explicit-consent gate that heartbeat's activity recording depends on. If `allow` is false and the employee's account has monitoring marked required (`profiles.monitoring_enabled` policy), the clock-in is immediately force-ended via `endClockInForDeclinedMonitoring` and the response includes `"clockedOut": true`.

### `POST /api/track1?resource=monitor_screenshot_upload`
**Auth:** Monitor Agent bearer token via `getRequestingAgent`/`requireMonitorAgent`. Also requires the given `monitorSessionId` to belong to this `agent_id` and be open — `403 { "ok": false, "error": "That monitor session is not open for this agent -- the employee may have clocked out." }` otherwise. `405` on non-POST.

**Purpose:** Uploads one desktop screenshot captured during an active, consented monitoring session.

**Request body / query params:**
- `monitorSessionId` (string, required)
- `imageBase64` (string, required) — base64-encoded image; decoded contents are sniffed by magic bytes and must be PNG or JPEG (client-declared content-type is ignored); max 6MB decoded (`MAX_SCREENSHOT_BYTES`), else `400`/`413`.
- `displayIndex` (number, optional, default `0`)
- `width`, `height` (number, optional)

**Response:**
```json
{ "ok": true }
```

Notes — high privacy sensitivity: this is a real screenshot of the employee's desktop. It is uploaded to the Supabase Storage bucket `monitor-screenshots` at `<employee_id>/<monitorSessionId>/<timestamp>_d<displayIndex>.<ext>`, then recorded as a row in `monitor_screenshots`. No server-side blur/redaction is applied here — `monitor_blur_screenshots` is a client-agent-side setting read from `workforce_settings` via heartbeat, not enforced on upload.

### `GET /api/track1?resource=monitor_review`
**Auth:** Signed-in employee (global gate + internal `getRequestingProfile`), AND role must be `admin` or `superadmin` — `403 { "ok": false, "error": "Only an admin/manager can view Monitor data." }` otherwise. No explicit `req.method` check in the handler (reads only `req.query`).

**Purpose:** Admin view of Monitor data — either the full paired-agent roster, or one employee's recent sessions/screenshots/activity.

**Request body / query params:**
- `employeeId` (string, optional, UUID) — omit for the roster view; provide for the per-employee detail view.

**Response (no `employeeId`):**
```json
{
  "ok": true,
  "resource": "monitor_review",
  "roster": [
    { "employeeId": "...", "name": "...", "deviceName": "...", "platform": "windows", "status": "active", "pairedAt": "...", "lastSeenAt": "..." }
  ]
}
```

**Response (with `employeeId`):**
```json
{
  "ok": true,
  "resource": "monitor_review",
  "sessions": [ "...up to 20 monitor_sessions rows, newest first..." ],
  "screenshots": [
    { "id": "...", "capturedAt": "...", "displayIndex": 0, "monitorSessionId": "...", "url": "https://.../storage/v1/object/sign/..." }
  ],
  "activitySamples": [ "...up to 200 monitor_activity_samples rows..." ]
}
```

Notes — high privacy sensitivity: this is the actual admin screenshot viewer. `screenshots[].url` is a **signed URL that expires in 300 seconds (5 minutes)**, generated per-request via Supabase Storage's `/sign` endpoint — never a permanent public link. Screenshots capped at 60, sessions at 20, activity samples at 200.

### `GET /api/track1?resource=monitor_my_status`
**Auth:** Any signed-in employee (global gate + internal `getRequestingProfile`) — self-status only, no role restriction. No explicit `req.method` check.

**Purpose:** "Am I being recorded right now?" — drives the recording-indicator button in the app UI, and reports desk-idle time and page-build staleness.

**Request body / query params:**
- `build` (string, optional, query) — the caller's current page-build identifier, used only for staleness comparison/bookkeeping.

**Response:**
```json
{ "ok": true, "clockedIn": true, "recording": true, "deskIdleSeconds": 42, "pageBuild": "...", "pageStale": false }
```

Notes — privacy-sensitive by design in the honest direction: `recording` is `true` only when there is an open `monitor_sessions` row AND its `consent === 'allowed'` AND the employee's `monitoring_enabled` flag is true — it cannot say "recording" while consent is merely pending. `deskIdleSeconds` is derived from the Monitor agent's own activity samples (desktop-level idle, not the browser tab's idle timer) and is `null` whenever it cannot be determined, rather than guessed.

### `GET /api/track1?resource=monitor_prune`
**Auth:** NOT a user session and NOT the Monitor Agent token — `CRON_SECRET` only, checked via `Authorization: Bearer <CRON_SECRET>` header or `?key=<CRON_SECRET>` query param; `401 { "ok": false, "error": "This endpoint is for Vercel Cron only. Manual test: ?resource=monitor_prune&key=<CRON_SECRET>" }` otherwise. (The resource also passes through the file's global `requireApiAuth` gate first, which independently accepts a signed-in user or the cron secret — but `handleMonitorPrune`'s own check only accepts the cron secret, so a merely-signed-in user is still rejected.) No `req.method` check in the handler itself, though it is intended to be called as `GET` by Vercel Cron.

**Purpose:** Daily retention sweep — deletes Monitor screenshots (Storage blob + row), activity samples, pairing-attempt logs, and ended sessions older than the retention window.

**Request body / query params:**
- `key` (string, optional, query) — alternative to the `Authorization` header for manual testing.

**Response:**
```json
{
  "ok": true,
  "resource": "monitor_prune",
  "retentionDays": 90,
  "cutoff": "...",
  "screenshotsDeleted": 0,
  "activitySamplesDeleted": 0,
  "pairAttemptsDeleted": 0,
  "sessionsDeleted": 0,
  "storageErrors": 0
}
```

Notes — privacy-relevant: this is the mechanism that actually deletes stored screenshot images (not just database rows) once they age past `MONITOR_RETENTION_DAYS` (default 90). Idempotent/safe to re-run: a screenshot row is only deleted after its Storage blob delete succeeds; `storageErrors` counts blobs left for a later retry.

### `GET /api/track1?resource=monitor_status`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. No role check — any signed-in employee can check their own pairing status. No explicit `req.method` check (any method reaches the logic; the frontend only ever calls it with GET).

**Purpose:** Tells the signed-in employee whether their own HiveLogic Monitor desktop agent is paired, and whether it looks alive right now.

**Request body / query params:** none (scoped to the caller via `requester.id`).

**Response (paired):**
```json
{
  "ok": true,
  "paired": true,
  "alive": true,
  "staleMinutes": 2,
  "agent": {
    "deviceName": "...",
    "platform": "windows",
    "pairedAt": "2026-08-01T00:00:00.000Z",
    "lastSeenAt": "2026-08-22T12:00:00.000Z"
  }
}
```
**Response (not paired):**
```json
{ "ok": true, "paired": false, "alive": false, "staleMinutes": null, "agent": null }
```

Notes: reads the most recent `monitor_agents` row with `status='active'` for the caller. `paired: true` only means a pairing was completed and never revoked — it does **not** mean the desktop app is currently running. `alive` is the real liveness signal, computed from `last_seen_at`: the agent heartbeats every 60s while running, so `alive = staleMinutes <= MONITOR_AGENT_ALIVE_MINUTES` (15 minutes) — generous enough to survive a sleeping laptop, but a stale `last_seen_at` beyond that means the agent is not running. A comment in the code explicitly flags an earlier bug where the frontend read `paired` alone and claimed monitoring was active for two weeks after the agent had gone dark.

### `GET|POST /api/track1?resource=monitor_settings`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in, **then** requires `requester.role === 'admin' || requester.role === 'superadmin'`, else 403 `{ ok: false, error: 'Only an admin/manager can manage Monitor settings.' }`. No explicit method restriction — POST runs the update branch, any other method (including GET) just returns the current settings + roster.

**Purpose:** Admin view/edit of company-wide Monitor settings (screenshot interval, blur) plus the full per-device/per-employee Monitor roster.

**Request body / query params (POST only, both optional):**
- `screenshotIntervalMinutes` (number, optional) — must be between 1 and 120 inclusive, else `400`.
- `blurScreenshots` (boolean, optional) — coerced with `!!`.

If neither field is present, the POST branch is a no-op and falls through to the same read below.

**Response:**
```json
{
  "ok": true,
  "screenshotIntervalMinutes": 5,
  "blurScreenshots": false,
  "expectedAgentVersion": "1.2.6",
  "roster": [
    {
      "employeeId": "...",
      "name": "...",
      "deviceName": "...",
      "platform": "windows",
      "status": "active",
      "lastSeenAt": "2026-08-22T12:00:00.000Z",
      "agentVersion": "1.2.6",
      "agentVersionState": "current",
      "monitoringEnabled": true
    }
  ]
}
```

Notes: settings live in the single-row `workforce_settings` table (created if missing on first POST, else PATCHed by `id`). `roster` is every `monitor_agents` row joined to `profiles` for name/email and `monitoring_enabled`; `monitoringEnabled` defaults to `true` when there is no matching profile or the flag isn't explicitly `false`. `agentVersionState` and `expectedAgentVersion` let the UI flag agents running an out-of-date build without hardcoding the expected version client-side.

### `POST /api/track1?resource=monitor_user_toggle`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in, then requires `requester.role === 'admin' || requester.role === 'superadmin'`, else 403 `{ ok: false, error: 'Only an admin/manager can change this.' }`. `req.method !== 'POST'` → 405.

**Purpose:** Admin on/off switch for whether one specific employee is monitored while clocked in.

**Request body / query params:**
- `employeeId` (string, required) — `400` if missing.
- `monitoringEnabled` (boolean, required) — `400 { error: 'Nothing to change -- send monitoringEnabled.' }` if `undefined`.

**Response:**
```json
{ "ok": true, "monitoringEnabled": true }
```

Notes: PATCHes `profiles.monitoring_enabled` for that employee. Comment in the code notes a second flag (`monitoring_required`) used to exist and was removed after it produced false idle clock-outs on 2026-08-18 — only one permission bit remains. Takes effect on the agent's next heartbeat (~60s), and re-enabling fires a fresh consent prompt on that employee's next clock-in.

## Personal / My

### `GET /api/track1?resource=my_role`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. `req.method !== 'GET'` → 405. No further role restriction — any signed-in user can read their own role/permissions.

**Purpose:** Tells the signed-in user their own access level and Crew-Roster permission role(s), for client-side nav/permission gating.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "my_role",
  "accessLevel": "admin",
  "permissionRole": "owner",
  "permissionRoles": ["owner", "dispatch"],
  "lens": "...",
  "crewLabel": "..."
}
```

Notes: `accessLevel` comes straight from `profiles.role`. The rest is looked up by matching `profiles.email` → `users.jobber_id` → `employee_roles` (by `jobber_id`), so a user whose email doesn't match a Jobber-synced `users` row gets `permissionRole: null, permissionRoles: [], lens: null, crewLabel: null` with no error.

### `GET /api/track1?resource=my_jobs_today`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. No role check, no explicit `req.method` check (frontend only calls GET).

**Purpose:** Shows the signed-in employee the visits scheduled today that are assigned to them, matched by name.

**Request body / query params:** none (today's range computed server-side via `todayRangeET()`).

**Response:**
```json
{
  "ok": true,
  "resource": "my_jobs_today",
  "date": "2026-08-22",
  "employeeName": "Jane Smith",
  "matchedBy": "name",
  "jobs": [
    {
      "title": "...",
      "clientName": "...",
      "jobNumber": "...",
      "jobStatus": "...",
      "jobberUrl": "...",
      "startAt": "...",
      "endAt": "...",
      "arrivalWindowStart": "...",
      "arrivalWindowEnd": "...",
      "status": "..."
    }
  ],
  "note": "Matched to your visits by comparing your HiveLogic name to the Jobber-assigned-tech name -- if a job you are on is missing, make sure your full name in HiveLogic matches Jobber exactly."
}
```

Notes: matching is purely by lower-cased, trimmed exact-string comparison of `requester.full_name` against each visit's `assigned_users[].name` (JSON array, parsed defensively) — no fuzzy matching, no jobber_id linkage. If the caller has no `full_name` set on their profile, `jobs` comes back empty with a different `note` explaining why. This is a same-day-only view (`todayRangeET()`); no date param is accepted (contrast with the separate `schedule_range` resource, which takes a date range).

## Notifications

### `GET /api/track1?resource=notifications`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. No explicit `req.method` check. Email notifications specifically are further gated inside the handler to `requester.role === 'admin' || requester.role === 'superadmin'`; every other section of the response is available to any signed-in employee.

**Purpose:** Aggregates the small notification bell's feed: unread email (admins only), unread HiveConnect messages, recent client/job/invoice updates, and new lead opportunities, all from the last 24 hours where applicable.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "notifications",
  "groups": [
    {
      "kind": "email",
      "priority": 1,
      "label": "Unread email",
      "count": 3,
      "items": [ { "title": "...", "detail": "...", "at": "..." } ]
    }
  ],
  "notConnected": [
    { "kind": "calls", "reason": "No phone system connected yet -- missed calls will land here once one is." }
  ]
}
```

Notes: five independent best-effort sections, each wrapped in its own try/catch so one source failing (e.g. Microsoft Graph token expired, HiveConnect bridge not configured) doesn't break the rest — a failure is pushed into `notConnected` with a `reason` string instead of throwing. Sections: `email` (Microsoft Graph inbox, admin-only), `messages` (HiveConnect, via the caller's `getMapping(requester.id)` link to a `hiveconnect_user_id`), `client_updates` (Supabase `clients`/`jobs`/`invoices` updated in the last 24h), `new_leads` (new `requests` rows and clients newly flagged `is_lead=true` in the last 24h), and a permanently-not-connected `vendor` placeholder. `groups` is sorted by `priority` ascending.

## Production Tracker

### `GET /api/track1?resource=production_tracker` (`handleProductionTracker`)
**Auth:** Signed-in, `requester.role` must be `admin` or `superadmin` — 403 `{ error: 'Only an admin/manager can view the production tracker.' }` otherwise. `req.method !== 'GET'` → 405.

**Purpose:** A same-day snapshot: how many invoices went out today, and how many purchase orders each employee created today.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "resource": "production_tracker", "date": "2026-08-22", "invoicesSentToday": 0, "poByEmployee": [ { "employeeId": "...", "employeeName": "...", "poNumbers": [], "count": 0 } ] }
```

Notes: `invoicesSentToday` counts `invoices` rows with `issued_date` equal to today. `poByEmployee` groups today's `purchase_orders` rows by `data.requestedBy` (an actor id embedded in the PO's JSON `data` column, not a foreign key), resolves names via a `profiles?id=in.(...)` lookup, and sorts descending by PO count; an actor id with no matching profile row shows as `"Unknown"` rather than being dropped.

## PTO / Time Off

### `POST /api/track1?resource=pto_decide`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in, then `isPtoApprover(requester)` — true if `role` is `admin`/`superadmin`, **or** `'owner'` is among the roles returned by `getDispatchPermissionRoles(requester)` — else 403 `{ error: 'Only an owner can approve or decline PTO requests.' }`. `req.method !== 'POST'` → 405.

**Purpose:** Approves or declines a pending PTO request.

**Request body / query params:**
- `id` (string, required) — the `pto_requests.id` to decide; `400` if missing.
- `decision` (string, required) — must be exactly `"approved"` or `"declined"`; anything else is treated as missing → `400`.
- `decisionNote` (string, optional) — trimmed; empty string becomes `null`.

**Response:**
```json
{
  "ok": true,
  "request": {
    "id": "...",
    "employeeJobberId": "...",
    "employeeName": "...",
    "startDate": "2026-08-25",
    "endDate": "2026-08-27",
    "requestType": "vacation",
    "status": "approved",
    "note": null,
    "requestedAt": "...",
    "decidedByEmail": "owner@hivelogic...",
    "decidedAt": "...",
    "decisionNote": null,
    "days": 3
  }
}
```

Notes: the update is conditioned on `status=eq.pending` in the same PATCH, so deciding a request that was already decided (by anyone, including a race) returns `409 { error: 'That request was already decided (or does not exist).' }` instead of silently overwriting a prior decision. `days` is an inclusive calendar-day count with no weekend/holiday calendar.

### `GET /api/track1?resource=pto_balances`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. No further role gate to call the endpoint at all, but the `scope=all` company-wide view additionally requires `isPtoApprover(requester)` (same admin/superadmin/dispatch-owner-role check as `pto_decide`) — without it, `scope=all` is silently ignored and the caller instead gets their own single-employee balance. `req.method !== 'GET'` → 405.

**Purpose:** Computes each employee's (or, for approvers, every employee's) PTO allowance, accrued-to-date, used, pending, and remaining days for a given year.

**Request body / query params:**
- `year` (query, number, optional, default current year).
- `scope` (query, string, optional) — `"all"` requests the full-roster view; requires approver status, otherwise ignored.

**Response (own balance):**
```json
{
  "ok": true,
  "resource": "pto_balances",
  "year": 2026,
  "allowanceDays": 10,
  "accruedDays": 6.67,
  "usedDays": 2,
  "remainingDays": 8
}
```
**Response (`scope=all`, approver only):**
```json
{
  "ok": true,
  "resource": "pto_balances",
  "year": 2026,
  "balances": [
    {
      "employeeJobberId": "...",
      "employeeName": "...",
      "allowanceDays": 10,
      "accruedDays": 6.67,
      "usedDays": 2,
      "remainingDays": 8,
      "pendingDays": 0,
      "burnoutFlag": false,
      "upcomingApproved": { "startDate": "2026-09-01", "endDate": "2026-09-05" }
    }
  ]
}
```

Notes: `accruedDays` is informational only (`allowanceDays/12 × months elapsed` for the current year, 0 for a future year, full allowance for a past year) — it does **not** cap what can be requested or approved. `burnoutFlag` is an explicit heuristic (more than half the year elapsed and ≥66% of allowance still remaining), not tied to any written policy. If the caller has no matching `users` row by email, the single-balance response comes back as all zeros with a `note` explaining why, rather than an error. The `scope=all` roster is seeded from every active (`status != 'DEACTIVATED'`) user, not just those with an existing allowance or request, so a brand-new employee still appears.

### `POST /api/track1?resource=pto_allowance_set`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in, then `isPtoApprover(requester)`, else 403 `{ error: 'Only an owner can set PTO allowances.' }`. `req.method !== 'POST'` → 405.

**Purpose:** Sets (or updates) one employee's PTO allowance for a given year.

**Request body / query params:**
- `employeeJobberId` (string, required) — `400` if missing.
- `year` (number, optional, default current year).
- `allowanceDays` (number, required) — must be finite and `>= 0`, else `400 { error: 'allowanceDays must be a non-negative number.' }`.

**Response:**
```json
{
  "ok": true,
  "allowance": {
    "employee_jobber_id": "...",
    "year": 2026,
    "allowance_days": 10,
    "updated_at": "...",
    "updated_by_email": "..."
  }
}
```

Notes: upsert via Supabase `POST .../pto_allowances?on_conflict=employee_jobber_id,year` with `Prefer: resolution=merge-duplicates`, so calling it again for the same employee+year overwrites rather than duplicating. The response's `allowance` object is the raw Supabase row (snake_case), unlike most other handlers in this batch which map to camelCase.

### `GET /api/track1?resource=pto_coverage`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in, then `isPtoApprover(requester)`, else 403 `{ error: 'Only an owner can view the coverage map.' }`. `req.method !== 'GET'` → 405.

**Purpose:** A 14-day (today through +13) staffing grid across every active employee, showing who is working, on approved PTO, or has a pending PTO request on each day.

**Request body / query params:** none (window is always today + 13 days, fixed server-side).

**Response:**
```json
{
  "ok": true,
  "resource": "pto_coverage",
  "days": ["2026-08-22", "2026-08-23", "..."],
  "employees": [
    {
      "employeeJobberId": "...",
      "employeeName": "...",
      "days": ["working", "working", "pto", "pending", "..."]
    }
  ]
}
```

Notes: per-day status is `pto` (approved request overlapping that day) taking precedence over `pending` (a pending request overlapping that day), else `working`. Deliberately does not flag "thin coverage" days — the code comment notes that would need a real minimum-staffing rule that doesn't exist yet. Employee list is every active (`status != 'DEACTIVATED'`) user, same source as `pto_balances`'s `scope=all`.

### `GET|POST /api/track1?resource=pto_requests`
**Auth:** Global gate (`requireApiAuth`: signed-in user or `CRON_SECRET`) + handler independently calls `getRequestingProfile(req)`, 401 `{ ok: false, error: 'Not signed in -- log into HiveLogic first.' }` if not signed in (so a cron-secret-only caller is still refused here). `GET ?scope=all` additionally requires `isPtoApprover(requester)` — true for `role === 'admin' | 'superadmin'`, or for anyone whose Crew-Roster permission roles include `'owner'` — else 403 `{ ok: false, error: 'Only an owner can view every PTO request.' }`.

**Purpose:** List the signed-in employee's own PTO requests (or, for an approver, every request company-wide), and submit a new PTO request.

**Request body / query params:**
- `scope` (string, optional, GET only) — `'all'` to view every employee's requests (approver only); omitted/other returns only the caller's own.
- `startDate` (string `YYYY-MM-DD`, required, POST) — validated by regex.
- `endDate` (string `YYYY-MM-DD`, required, POST) — must not be before `startDate`.
- `requestType` (string, optional, POST) — one of `vacation`/`personal`/`sick`, defaults to `vacation` if invalid/omitted.
- `note` (string, optional, POST).

**Response (GET):**
```json
{
  "ok": true,
  "resource": "pto_requests",
  "requests": [
    {
      "id": "...", "employeeJobberId": "...", "employeeName": "...",
      "startDate": "2026-09-01", "endDate": "2026-09-03", "requestType": "vacation",
      "status": "pending", "note": null, "requestedAt": "...",
      "decidedByEmail": null, "decidedAt": null, "decisionNote": null, "days": 3
    }
  ],
  "canApprove": false
}
```
**Response (POST):**
```json
{ "ok": true, "request": { "id": "...", "employeeJobberId": "...", "...": "same shape as above" } }
```

Notes: the caller is matched to a Jobber employee record by email (`resolveEmployeeJobberId`); if no match exists, GET returns an empty list with a `note` explaining the mismatch rather than erroring, and POST 400s outright. `days` is an inclusive calendar-day count with no weekend/holiday calendar. Side effect: POST inserts a new row into `pto_requests` with `status` defaulting to whatever the table default is (requests start pending; approval/decline happens through the separate `pto_decide` resource, not covered in this batch).

## Reina Lab Bridge

### `GET /api/track1?resource=reina_lab_read`
**Auth:** **Exempt from the global `requireApiAuth` gate** — confirmed at the exemption block (line 7477): `if (resource === 'reina_lab_read' && req.method === 'GET') { /* Self-authenticates with REINA_LAB_READ_TOKEN inside its handler. */ }`. The handler itself (`reinaLabTokenMatches`, line 3132) requires an `Authorization: Bearer <token>` header that exactly matches `process.env.REINA_LAB_READ_TOKEN`, compared with `crypto.timingSafeEqual` after a length check — a mismatched or missing token/env var returns 401 `{ ok: false, error: 'Connector authentication required.' }`. This token is unrelated to `CRON_SECRET` or Supabase sessions. Also present on the edge-middleware `PUBLIC_RESOURCE_PATHS` allowlist (`guard.js`) pinned to this exact resource+`GET`, so the request even reaches this handler in the first place.

**Purpose:** Read-only, field-allowlisted server-to-server data bridge that gives the isolated Reina Lab environment visibility into HiveLogic business data without exposing credentials or write access.

**Request body / query params** (only consulted when `REINA_LAB_FULL_READ_ENABLED === 'true'`; otherwise ignored):
- `job_number` (string, optional) — must match `^[a-z0-9-]{2,40}$`, else 400.
- `lookup_kind` (string, optional) — one of `client`/`invoice`/`estimate`/`job`/`vehicle`, else 400.
- `lookup_term` (string, optional, 2-120 chars, restricted charset) — else 400.

**Response (default mode, `REINA_LAB_FULL_READ_ENABLED` unset/false):**
```json
{
  "ok": true,
  "source": "HiveLogic read-only bridge",
  "asOf": "2026-08-22T12:00:00.000Z",
  "vehicles": [{ "name": "...", "status": "moving", "speed": 42, "latitude": 41.2, "longitude": -73.6, "gpsUpdatedAt": "...", "gpsStale": false, "gpsSource": "fleetsharp" }],
  "jobs": [{ "jobNumber": "...", "title": "...", "status": "today", "startAt": "...", "endAt": "...", "updatedAt": "..." }],
  "todayDecisions": { "available": true, "headline": "...", "asOf": "...", "source": "HiveLogic Daily Brief", "decisions": [{ "type": "REVIEW", "text": "...", "source": "...", "confidence": null }] }
}
```
**Response (full mode)** adds `access`, `jobLookup`, `exactLookup`, and a `business` object:
```json
{
  "ok": true,
  "access": { "mode": "full_business_read", "readOnly": true, "businessAreas": ["executive", "clients", "jobs", "..."], "excluded": ["credentials", "tokens", "bank accounts", "payment card data", "payroll", "tax identifiers", "private contact details", "mail message bodies", "raw notes", "write operations"] },
  "vehicles": [ "..." ], "jobs": [ "..." ],
  "jobLookup": { "available": true, "jobNumber": "...", "record": { "...": "..." } },
  "exactLookup": { "available": true, "kind": "client", "term": "...", "records": [ "..." ] },
  "todayDecisions": { "...": "..." },
  "business": { "clients": { "...": "..." }, "executive": { "...": "..." }, "receivables": { "...": "..." }, "estimates": { "...": "..." }, "workflow": { "...": "..." }, "schedule": { "...": "..." }, "leads": { "...": "..." }, "requests": { "...": "..." }, "expenses": { "...": "..." }, "vendors": { "...": "..." }, "subscriptions": { "...": "..." }, "subcontractors": { "...": "..." }, "purchaseOrders": { "...": "..." }, "internalEstimates": { "...": "..." }, "syncHealth": { "...": "..." }, "mail": { "...": "..." } }
}
```

Notes: sets `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` on every response. The narrow default mode is preserved unless `REINA_LAB_FULL_READ_ENABLED=true` is set independently — a configured token alone never silently expands access. In full mode, vehicle-lookup results never return raw GPS coordinates to the caller; a lat/lng is only ever translated server-side into a derived label (`"the shop"` or a matched client address) when within `TECH_LIVE_ARRIVED_RADIUS_MI` (0.3 mi). The dispatcher wraps this call in `try/catch` and returns a generic `{ ok: false, error: 'Read bridge unavailable.' }` (500) on any thrown error, deliberately hiding internal error detail from this externally-reachable resource. `mail` exposes only Reina's own triage summaries (subject, sender domain, label, confidence, summary/suggested-action text) — never message bodies or full sender addresses.

### `GET /api/track1?resource=reina_todo_get`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in, **then** `canManageDevTodo(requester)` — true for `role === 'admin' | 'superadmin'`, or a Crew-Roster permission role of `'owner'` — else 403 `{ ok: false, error: 'The Dev To-Do list is admin-only.' }`. No explicit `req.method` check (dispatched for any method).

**Purpose:** Read the single current-snapshot "Dev To-Do" engineering backlog, shown in the admin-only Dev To-Do view.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "resource": "reina_todo_get", "todo": { "id": "current", "sections": [ "..." ], "flags": [ "..." ], "content_md": "...", "source": "...", "generated_at": "..." } }
```

Notes: sets `Cache-Control: no-store`. Reads the single row `reina_todo?id=eq.current` — this is history-less, always the latest snapshot. As of 2026-08-16 the Command Center "Team To-Do" card no longer reads this resource at all (it now uses `team_todo_detections`); this remains the backing read for the internal, admin-gated Dev To-Do list only.

### `POST /api/track1?resource=reina_todo_set`
**Auth:** Global gate (`requireApiAuth`) only — **no additional role check inside the handler**, unlike its `reina_todo_get` read counterpart. Any signed-in employee (or a `CRON_SECRET`-bearing caller, since `requireApiAuth` accepts either) can write. `req.method !== 'POST'` → 405 `{ ok: false, error: 'POST only' }`.

**Purpose:** Overwrite the single "current" Dev To-Do snapshot (normally called by the hourly Reina automation task).

**Request body / query params:**
- `sections` (array of `{ title, items: [{ text, priority }] }`, required) — 400 if not an array.
- `flags` (array, optional) — defaults to `[]` if not an array.
- `content_md` (string, optional) — defaults to `null`.
- `source` (string, optional) — defaults to `'unknown'`.

**Response:**
```json
{ "ok": true, "resource": "reina_todo_set", "todo": { "id": "current", "sections": [ "..." ], "flags": [ "..." ], "content_md": "...", "source": "...", "generated_at": "2026-08-22T12:00:00.000Z" } }
```

Notes: upserts (`on_conflict=id`, `resolution=merge-duplicates`) always into `id='current'` — a single live row, not an append-only history table. `generated_at` is stamped server-side on every write. Per an inline code comment, this resource was previously exempted from the auth gate entirely, which let a stale third-party hourly task overwrite verified remediation status; it is now behind the standard signed-in-or-cron gate like every other mutable Track 1 resource, though (unlike the read side) it is not restricted to admin/owner roles specifically.

## Scheduling

### (no explicit method restriction) `/api/track1?resource=schedule_range`
**Auth:** Global gate (`requireApiAuth`: signed-in user or `CRON_SECRET`) only — the handler itself performs **no** internal auth check and never calls `getRequestingProfile`.

**Purpose:** Return every scheduled visit within a date range (with client, job, geocoding, and assigned-tech detail) for the schedule board and map views.

**Request body / query params:**
- `start` (string `YYYY-MM-DD`, optional) — defaults to today in America/New_York.
- `end` (string `YYYY-MM-DD`, optional) — defaults to `start`.

**Response:**
```json
{
  "ok": true,
  "resource": "schedule_range",
  "start": "2026-08-22",
  "end": "2026-08-22",
  "visits": [
    {
      "visitId": "...", "title": "...", "clientName": "...", "jobNumber": "...", "jobberId": "...",
      "jobStatus": "today", "jobberUrl": "https://...", "startAt": "...", "endAt": "...",
      "arrivalWindowStart": "...", "arrivalWindowEnd": "...", "status": "...",
      "lat": 41.2, "lng": -73.6, "city": "...",
      "assignedTechs": [{ "name": "...", "jobberId": "..." }]
    }
  ],
  "count": 1
}
```

Notes: joins `visits` to `clients`/`jobs`/`jobs_enriched` (for `lat`/`lng`/`city`, ~98% geocoded) via batched `jobber_id` lookups. Date range is interpreted in America/New_York and converted to UTC ISO bounds before querying.

### `handleTmLive(res)` — `/api/track1?resource=tm_live`
**Auth:** Global gate (`requireApiAuth`) only. The handler's signature is `handleTmLive(res)` — it is **not passed `req` at all**, so it structurally cannot check the caller's method, headers, or body; it relies entirely on the outer gate.

**Purpose:** Live meter of which Time & Material jobs currently have a technician clocked on-site, for the T&M/Service Lane page.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "tm_live",
  "active": [
    { "techName": "...", "jobRef": "...", "jobTitle": "...", "clientName": "...", "startedAt": "...", "rateHourly": 95, "serviceType": "..." }
  ]
}
```
(returns `"active": []` immediately if there are no open on-site clocks, or none of them belong to a T&M-flagged job.)

Notes: sources from `job_time_entries` where `kind='onsite'` and `ended_at is null`, then filters down to only jobs `job_workflow` flags `is_tm=true` with `tm_rate_hourly > 0` — plain "onsite" entries exist for non-T&M jobs too, so this join is what keeps the meter honest instead of showing every tech currently on any job. Job title / client name lookups are best-effort (`try/catch`, silently omitted on failure) and never fail the whole response.


### `GET /api/track1?resource=tm_overview`
**Auth:** Global gate only (`requireApiAuth`). `handleTmOverview(res)` (api/track1.js:6941, dispatched at line 7742) takes no `req` and performs no further auth or method check — any HTTP method reaches it.

**Purpose:** Lists every job flagged T&M (`job_workflow.is_tm=true`) plus every T&M invoice generated so far, with paid/pending totals, for the Schedule page's T&M lens.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "tm_overview",
  "tmJobCount": 0,
  "tmJobs": [ { "jobRef": "...", "title": "...", "status": "...", "rateHourly": 225 } ],
  "invoices": [ { "id": "...", "invoice_number": "...", "job_ref": "...", "job_title": "...", "client_name": "...", "hours": 0, "rate_hourly": 0, "labor_amount": 0, "materials_amount": 0, "total_amount": 0, "status": "...", "created_at": "...", "paid_at": "..." } ],
  "totals": { "totalInvoiced": 0, "totalPaid": 0, "totalPending": 0 }
}
```

Notes: `invoices` is capped at the 50 most recent (`limit=50`, `order=created_at.desc`) — `totals` are computed only over that page, not the full table. `tmJobs` is not paginated (all `job_workflow` rows with `is_tm=true`). Two sequential Supabase reads (`job_workflow` filtered, then `jobs` by the resulting `jobber_id` list) plus a third for `tm_invoices`; any of the three failing returns `502`.

### `GET /api/track1?resource=tm_rate_types_list`
**Auth:** Global gate only (`requireApiAuth`). `handleTmRateTypesList(req, res)` (api/track1.js:4147, dispatched at line 7799) performs no further auth or method check.

**Purpose:** Returns the predetermined hourly rate types (e.g. "General T&M") that populate the New Job form's T&M rate dropdown.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "tm_rate_types_list",
  "rateTypes": [ { "key": "general", "label": "General T&M", "rate_hourly": 225 } ]
}
```

Notes: only rows with `active=true` are returned, ordered by `label`. `502` with the raw Supabase error text if the query fails.

### `GET /api/track1?resource=today_schedule`
**Auth:** Global gate only (`requireApiAuth`). `handleTodaySchedule(res)` (api/track1.js:2765, dispatched at line 7736) takes no `req` and performs no further auth or method check.

**Purpose:** Real "Today's Schedule" for the Command Center, built from Jobber visits already synced into Supabase for the business's current calendar day in America/New_York.

**Request body / query params:** none accepted — despite a `rangeParamsET(req)` helper existing elsewhere in the file that reads `start`/`end` query params, `handleTodaySchedule` calls `todayRangeET()` instead and always shows "today" in America/New_York; any `start`/`end` query params sent to this resource are silently ignored.

**Response:**
```json
{
  "ok": true,
  "resource": "today_schedule",
  "date": "2026-08-22",
  "totalVisits": 0,
  "completed": 0,
  "inProgress": 0,
  "upcoming": 0,
  "overdue": 0,
  "nextScheduledAt": null,
  "coverageNote": "...",
  "visits": [ { "title": "...", "clientName": "...", "jobNumber": "...", "jobStatus": "...", "jobberUrl": "...", "startAt": "...", "endAt": "...", "isAllDay": false, "status": "upcoming" } ]
}
```

Notes: `status` per visit is derived client-side-style in the handler from `completed_at`/`start_at`/`end_at` vs. now (`completed`, `in_progress`, `overdue`, else `upcoming`). Visits are not grouped by crew — `assignedUsers` is not queried by the current Jobber sync for this resource (see `resource=crew_schedule` for the crew-grouped view instead, per the handler's own `coverageNote`). If there are zero visits today, it does one extra query for the next upcoming visit (`nextScheduledAt`).

## Team / Workforce

### `GET|POST /api/track1?resource=subcontractors`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. GET is open to any signed-in employee. POST additionally requires `role === 'admin' | 'superadmin'`, else 403 `{ ok: false, error: 'Only an admin can manage subcontractors.' }`.

**Purpose:** Read and maintain the company's subcontractor/vendor directory (Vendors & Subs page).

**Request body / query params (POST):**
- `id` (string, optional) — presence switches to update-existing; when present, any of `name`, `trade`, `contactName`, `phone`, `email`, `notes`, `status` (`'active'|'inactive'`, else 400) may be patched.
- `name` (string, required when creating, i.e. no `id`) — 400 if empty.
- `trade`, `contactName`, `phone`, `email`, `notes` (strings, optional, create-only).

**Response (GET):**
```json
{
  "ok": true,
  "resource": "subcontractors",
  "isAdmin": false,
  "subs": [
    { "id": "...", "name": "...", "trade": "...", "contactName": "...", "phone": "...", "email": "...", "notes": "...", "status": "active", "jobberId": null, "track1099": false, "w9OnFile": false }
  ]
}
```
**Response (POST):**
```json
{ "ok": true, "sub": { "id": "...", "name": "...", "...": "raw subcontractors row" } }
```

Notes: `jobberId` is only populated when a sub has been matched to visits on the schedule board — a subcontractor otherwise needs no Jobber identity at all. Separate table from `employee_roles` (which tracks people who are also Jobber team members).

### `GET|POST /api/track1?resource=team`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. GET is open to any signed-in employee. POST is action-based: `action='invite'|'delete'|'change_role'` each require `role === 'superadmin'` (403 otherwise, worded per action); `action='reset_password'` allows a `superadmin` to reset anyone, or an `admin` to reset only a `crew`-role target (403 otherwise).

**Purpose:** List company team/profile accounts, and (superadmin) invite new employees, remove accounts, change roles, or reset passwords.

**Request body / query params (POST):**
- `action` (string, optional) — defaults to `'invite'` if omitted.
- invite: `email` (string, required), `full_name` (string, required), `role` (`'admin'` or defaults to `'crew'` — `'superadmin'` is never assignable at invite time), `monitoringEnabled` (boolean, optional, default `true`).
- delete: `userId` (string, required) — 400 if you target yourself.
- change_role: `userId` (string, required), `role` (one of `superadmin`/`admin`/`crew`, required) — 400 if you target yourself.
- reset_password: `userId` (string, required).

**Response (GET):**
```json
{ "ok": true, "source": "Supabase Auth", "team": [{ "id": "...", "email": "...", "full_name": "...", "role": "crew" }] }
```
**Response (POST invite):**
```json
{
  "ok": true,
  "created": { "id": "...", "email": "...", "full_name": "...", "role": "crew" },
  "tempPassword": "Ab3xQz...",
  "hiveconnectProvisioned": true,
  "emailSent": true,
  "note": "A welcome email with this temporary password was just sent to ...."
}
```
**Response (POST delete):** `{ "ok": true, "deleted": "<userId>" }`
**Response (POST change_role):** `{ "ok": true, "updated": { "...": "profiles row" } }`
**Response (POST reset_password):** `{ "ok": true, "userId": "...", "tempPassword": "...", "note": "..." }`

Notes: **side effects** — invite creates a real Supabase Auth user (via the service key) plus a `profiles` row, then best-effort (never blocking, never failing the invite) provisions a HiveConnect account and sends a welcome email via Resend if configured; the temp password is always also returned in the response as a backup even when the email send succeeds. Delete removes the Supabase Auth user via the service key, then best-effort deletes the orphaned `profiles` row. Reset-password issues a new temp password directly via the Supabase Auth admin API. Both the `superadmin` account-tier redesign and the "can't touch your own account" guards (delete/change_role) are enforced server-side, not just hidden in the UI.

### (no explicit method restriction) `/api/track1?resource=team_todo_detections`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. No further role gate at the top level, but the "vendor payments due" detection internally hides its data unless `role === 'admin'|'superadmin'` or the caller's Crew-Roster permission roles include `'owner'`/`'office_ar'` (otherwise that one row reports `state: 'unavailable'` with a reason, not a 403 — the endpoint itself always returns 200).

**Purpose:** Computed "what needs attention today" rows for the Command Center's Team To-Do card: emails awaiting reply, estimates to finalize, and vendor payments due.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "team_todo_detections",
  "asOf": "2026-08-22T12:00:00.000Z",
  "detections": [
    { "category": "execution", "state": "ok", "key": "emails_awaiting_reply", "icon": "✉️", "label": "Emails awaiting reply", "view": "hiveconnect_email", "count": 3, "amount": null, "detail": "unread 4+ business hours · across 2 mailboxes", "reason": null },
    { "category": "execution", "state": "ok", "key": "estimates_to_finalize", "icon": "📝", "label": "Estimates to finalize", "view": "estimates", "count": 5, "amount": 42000, "detail": "still in draft", "reason": null },
    { "category": "execution", "state": "unavailable", "key": "vendor_payments_due", "icon": "💸", "label": "Vendor payments due", "view": "financial", "count": null, "amount": null, "detail": null, "reason": "Your role does not have access to financial data." }
  ]
}
```

Notes: each of the three detections runs independently (`Promise.all`, each wrapped in its own `try/catch`), so one failing source (e.g. a disconnected mailbox) never breaks the others — a failure surfaces as `state: 'unavailable'` with a human-readable `reason` instead of a 500. "Emails awaiting reply" reads the caller's **own** connected Microsoft mailboxes (`hc_ms_tokens`), counting unread mail older than a business-hours threshold, and prefers Reina's own triaged priority-email counts over the raw unread clock when triage data exists.

### (no explicit method restriction) `/api/track1?resource=tech_live_status`
**Auth:** Global gate (`requireApiAuth`) + handler calls `getRequestingProfile(req)`, 401 if not signed in. No role restriction beyond being signed in.

**Purpose:** Live per-technician dispatch status (en route / on site / at the shop / idle / no vehicle) for the Dispatch tab's tech-status column headers, derived from vehicle GPS plus today's visit schedule.

**Request body / query params:** none (always "today" in America/New_York).

**Response:**
```json
{
  "ok": true,
  "resource": "tech_live_status",
  "date": "2026-08-22",
  "asOf": "2026-08-22T16:00:00.000Z",
  "techs": [
    {
      "jobberId": "...", "techName": "...", "vehicleTracked": true, "vehicleName": "2019 Ford F-250",
      "state": "en_route", "label": "En route to Smith Residence", "color": "#3E7BDD",
      "speedMph": 32, "gpsUpdatedAt": "...", "gpsStale": false,
      "distanceToClientMiles": 1.4, "distanceToOfficeMiles": 6.2
    }
  ],
  "coverageNote": "7 of 12 techs with a Jobber vehicle assignment have live GPS this run. ..."
}
```

Notes: deliberately built on vehicle GPS + haversine distance to the current/next visit's client address (or the office) rather than the Field App's "on my way"/"arrived" check-in buttons — an inline comment records that those buttons are wired up but almost entirely unused in production (2-3 rows total, all internal testing). A tech with no vehicle assigned in Jobber gets `state: 'no_vehicle'`, `vehicleTracked: false`, and no live label — the frontend falls back to schedule-based text instead of fabricating a status. GPS older than 20 minutes (`TECH_LIVE_GPS_STALE_MIN`) is reported `gpsStale: true` rather than treated as current.

### `POST /api/track1?resource=workforce_auto_clockout`
**Auth:** Explicitly **exempted** from the global `requireApiAuth` gate (api/track1.js:7484-7497, only when `req.method === 'POST'`) — but NOT unauthenticated. `handleWorkforceAutoClockout(req, res)` (api/track1.js:4779, dispatched at line 7655) itself calls `getRequestingProfile(req)` (api/track1.js:1096), which reads the bearer token from the `Authorization` header as usual, but falls back to `req.body.access_token` if no header is present — because this endpoint is fired by `navigator.sendBeacon()` from a `pagehide` handler, and `sendBeacon` cannot set an `Authorization` header. Either way, the presented token is verified against Supabase's `/auth/v1/user`; an invalid/missing token on both paths returns `401 { "ok": false, "error": "Not signed in." }`. Any other HTTP method gets `405 { "ok": false, "error": "Method not allowed." }`.

**Purpose:** Browser-close / idle-timeout safety net that clocks an employee out (or marks their session as "browser gone" pending a grace window) when they leave without clocking out manually.

**Request body / query params:**
- `access_token` (string, required only as a fallback when no `Authorization` header is sent) — the caller's Supabase session token.
- `reason` (string, optional) — `'browser_closed'` (default, including when omitted/invalid) or `'idle_timeout'`.

**Response (default/browser-closed path — marks only):**
```json
{ "ok": true, "marked": true, "note": "Browser gone -- clock-out pending the grace window." }
```

**Response (`reason: "idle_timeout"` — closes immediately):**
```json
{ "ok": true, "closed": true, "closeReason": "browser_closed" }
```

Other responses: `{ "ok": true, "note": "Workforce tables not ready." }` or `{ "ok": true, "note": "No active session -- nothing to do." }` if there's nothing to close.

Notes: Any `reason` other than the literal string `'idle_timeout'` (including no reason at all, from stale cached pre-fix JavaScript) is treated as the safe default and only **marks** `browser_gone_at` on the session rather than closing it — `workforce_sweep_gone` (a separate cron-only resource) decides later whether to actually close it, since a page refresh looks identical to a real close and would otherwise clock someone out on every reload. Only `'idle_timeout'` closes the session immediately. Unlike manual clock-out, this path deliberately skips the "submit your End-of-Day report first" requirement. On an immediate close it also best-effort closes any open `monitor_sessions` row tied to the same clock-in. The final success response hardcodes `"closeReason": "browser_closed"` in its JSON even when the actual close was triggered by `reason: "idle_timeout"` — the real `close_reason` value written to the database row is correct (`browser_closed` or `idle_timeout`), only the JSON response field is stuck on the literal string.

### `POST /api/track1?resource=workforce_break`
**Auth:** Passes through the normal global gate (`requireApiAuth`) — not exempted. `handleWorkforceBreak(req, res)` (api/track1.js:4733, dispatched at line 7652) additionally calls `getRequestingProfile(req)` itself and 401s again if it can't resolve a profile (`{ "ok": false, "error": "Not signed in -- log into HiveLogic first." }`), and rejects non-POST with `405 { "ok": false, "error": "Method not allowed." }`.

**Purpose:** Starts or ends a break on the caller's currently active clock-in session.

**Request body / query params:**
- `action` (string, required) — `"start"` or `"end"`; anything else returns `400 { "ok": false, "error": "action must be \"start\" or \"end\"." }`.

**Response (start):**
```json
{ "ok": true, "session": { "id": "...", "employee_id": "...", "on_break": true, "break_started_at": "...", "...": "..." } }
```
If already on break: `{ "ok": true, "session": { "...": "..." }, "note": "Already on break." }`.

**Response (end):**
```json
{ "ok": true, "session": { "id": "...", "on_break": false, "break_started_at": null, "total_break_seconds": 1800, "...": "..." } }
```

Notes: Requires an active (`status=eq.active`) `workforce_time_sessions` row for the caller — `400 { "ok": false, "error": "You need to clock in before taking a break." }` if none. `total_break_seconds` accumulates across multiple start/end cycles rather than resetting. Ending a break the caller never started returns `400 { "ok": false, "error": "Not currently on break." }`. If the `workforce_time_sessions` table lookup itself fails (table not provisioned), returns `200 { "ok": false, "error": "Workforce tables are not set up yet in Supabase." }`.

### `POST /api/track1?resource=workforce_clock`
**Auth:** Global gate: `requireApiAuth` (signed-in Supabase user OR `CRON_SECRET`) at the top of `handler()`. Handler itself additionally requires `getRequestingProfile(req)` to resolve a profile from a Supabase user bearer token (verified against `${SUPABASE_URL}/auth/v1/user`) — a bare cron secret is not enough to pass this handler, so in practice this requires a signed-in HiveLogic employee.
**Purpose:** Clock an employee in or out of their workforce time-tracking session.

**Request body / query params:**
- `action` (string, required) — `"in"` or `"out"`.

**Response:**
```json
{ "ok": true, "session": { "id": "...", "employee_id": "...", "clock_in": "2026-08-22T...", "status": "active" } }
```
Other shapes returned by this handler:
- Method not POST: `405 { "ok": false, "error": "Method not allowed." }`
- Not signed in: `401 { "ok": false, "error": "Not signed in -- log into HiveLogic first." }`
- `action: "in"`, caller is an owner: `200 { "ok": false, "isOwner": true, "error": "Owners are not on the timeclock, so there is nothing to clock in to. Nothing is monitored or recorded for an owner account." }`
- `action: "in"`, already clocked in: `200 { "ok": true, "session": {...}, "note": "Already clocked in." }`
- `action: "in"` or `"out"`, workforce tables missing: `200 { "ok": false, "error": "Workforce tables are not set up yet in Supabase." }`
- `action: "out"`, no active session: `400 { "ok": false, "error": "No active session to clock out of." }`
- `action: "out"`, currently on break: `200 { "ok": false, "error": "End your break before clocking out." }`
- `action: "out"`, non-owner with no End-of-Day report submitted today: `200 { "ok": false, "error": "Please submit your End-of-Day report before clocking out.", "needsEodReport": true }`
- Neither `"in"` nor `"out"`: `400 { "ok": false, "error": "action must be \"in\" or \"out\"." }`

Notes: Owners (per `isOwner()`, sourced from the `owner` permission role) cannot clock in at all, and are exempted from the End-of-Day report requirement on clock-out (legacy sessions predating the rule can still hit that branch). Non-owners must have submitted today's `workforce_daily_summaries` row (see `workforce_summary`) before they're allowed to clock out. Side effect: inserts/updates a row in `workforce_time_sessions`.

---

### `POST /api/track1?resource=workforce_set_status`
**Auth:** Global `requireApiAuth` gate, plus handler-level `getRequestingProfile(req)` (signed-in Supabase user).
**Purpose:** Set an availability status (e.g. "In a Meeting", "Lunch Break") on the caller's currently active clock-in session.

**Request body / query params:**
- `status` (string, required) — one of `available`, `meeting`, `unavailable`, `bathroom`, `lunch`, `help`.
- `emoji` (string, optional) — status emoji to display; defaults to `''` if omitted.

**Response:**
```json
{ "ok": true, "session": { "id": "...", "status_flag": "meeting", "status_emoji": "...", "status_updated_at": "2026-08-22T..." } }
```

Notes: `405` if not POST. `401` if not signed in. `400 { "ok": false, "error": "Unknown status." }` if `status` isn't one of the six recognized values. `200 { "ok": false, "error": "Workforce tables are not set up yet in Supabase." }` if the underlying query fails. `400 { "ok": false, "error": "Clock in first to set a status." }` if the caller has no active session. Side effect: PATCHes `workforce_time_sessions` (`status_flag`, `status_emoji`, `status_updated_at`).

---

### `GET /api/track1?resource=workforce_settings`
**Auth:** Global `requireApiAuth` gate, plus handler-level `getRequestingProfile(req)` (signed-in Supabase user). No role restriction — any signed-in employee can read.
**Purpose:** Return company-wide workforce timer settings (End-of-Day prompt time, idle/auto-clockout thresholds) that drive client-side timers.

**Request body / query params:** None. (The handler doesn't branch on `req.method`, so it returns the same read regardless of HTTP method used.)

**Response:**
```json
{
  "ok": true,
  "workdayEndHour": 15,
  "workdayEndMinute": 30,
  "idleWarningMinutes": 30,
  "idleAutoClockoutGraceMinutes": 15
}
```

Notes: Values come from the first row of `workforce_settings` (falls back to the hardcoded defaults shown above — 15/30, 30, 15 — if the table is empty or the query fails). `401 { "ok": false, "error": "Not signed in." }` if not signed in. This is a read-only endpoint despite accepting any method; it never writes.

---

### `GET /api/track1?resource=workforce_status`
**Auth:** Global `requireApiAuth` gate, plus handler-level `getRequestingProfile(req)` (signed-in Supabase user).
**Purpose:** Return the caller's current clock-in session, today's daily summary, and an explanation if their last session was auto-closed unexpectedly.

**Request body / query params:** None.

**Response:**
```json
{
  "ok": true,
  "tablesReady": true,
  "activeSession": { "id": "...", "employee_id": "...", "clock_in": "...", "status": "active", "browser_gone_at": null },
  "todaySummary": { "id": "...", "employee_id": "...", "summary_date": "2026-08-22", "tasks_completed": "..." },
  "lastClosed": { "id": "...", "clockOut": "2026-08-22T...", "closeReason": "browser_closed", "notice": "..." },
  "isOwner": false
}
```

Notes: `401 { "ok": false, "error": "Not signed in -- log into HiveLogic first." }` if not signed in. `activeSession` and `todaySummary` are `null` when none exists. `lastClosed` is only populated when there is no active session AND the most recent completed session (within `CLOSE_NOTICE_WINDOW_MINUTES`) closed for a reason in `CLOSE_REASONS_WORTH_EXPLAINING` (e.g. `browser_closed`, declined-monitoring clock-out) — otherwise `null`, so a stale/old auto-close is never re-announced. Side effect: if the active session carries a stale `browser_gone_at` mark (set by the browser-close beacon), this call clears it (best-effort PATCH) — reaching this endpoint is treated as proof the person is still present, cancelling a pending `workforce_sweep_gone` auto-clockout. `isOwner` is computed server-side via `isOwner()`, not inferred by the client.

---

### `GET /api/track1?resource=workforce_summary`
**Auth (GET):** Global `requireApiAuth` gate, plus handler-level `getRequestingProfile(req)` (signed-in Supabase user).
**Auth (POST):** Same as GET.
**Purpose:** Read or submit the caller's End-of-Day report for today.

**Request body / query params (POST only):**
- `tasks_completed` (string, optional)
- `plans_tomorrow` (string, optional)
- `blockers` (string, optional)
- `support_needed` (string, optional)
- `hours_worked` (string, optional)

All POST fields default to `''` if omitted; `employee_id`, `summary_date` (today, America/New_York), and `submitted_at` are set server-side.

**Response (GET):**
```json
{ "ok": true, "summary": { "id": "...", "employee_id": "...", "summary_date": "2026-08-22", "tasks_completed": "..." }, "tablesReady": true }
```

**Response (POST):**
```json
{ "ok": true, "summary": { "id": "...", "employee_id": "...", "summary_date": "2026-08-22", "submitted_at": "2026-08-22T..." } }
```

Notes: `401 { "ok": false, "error": "Not signed in -- log into HiveLogic first." }` if not signed in; `405 { "ok": false, "error": "Method not allowed." }` for any method other than GET/POST. GET returns `{ "ok": true, "summary": null, "tablesReady": false }` if the query fails (table missing). POST upserts via `on_conflict=employee_id,summary_date` with `Prefer: resolution=merge-duplicates` — re-submitting the same day overwrites the prior report rather than creating a duplicate. POST failure: `500 { "ok": false, "error": "Could not save summary -- has Chris run the workforce tables SQL yet? Detail: ..." }`.

---

### `GET /api/track1?resource=workforce_sweep_gone`
**Auth:** EXEMPTED from the global `requireApiAuth` gate (see the exemption block in `handler()`, ~line 7479). Instead does its own check inline: `checkCronSecret(authHeader)`, a constant-time (`timingSafeStrEqual`) comparison of the bearer token against `process.env.CRON_SECRET` (from `api/_lib/guard.js`). Cron-only; not reachable by a signed-in user.
**Purpose:** Vercel Cron job (runs every minute) that closes out workforce sessions whose browser tab went away and never came back, backdating the clock-out to the moment the browser was detected gone.

**Request body / query params:** None (only the `Authorization: Bearer <CRON_SECRET>` header is read).

**Response:**
```json
{ "ok": true, "graceMinutes": 5, "considered": 2, "closed": [ { "sessionId": "...", "clockOut": "2026-08-22T..." } ] }
```

Notes: `401 { "ok": false, "error": "Cron secret required." }` if the secret doesn't match. Only touches `workforce_time_sessions` rows that are still `status=active` AND carry a `browser_gone_at` older than `BROWSER_GONE_GRACE_MINUTES` (5 minutes) — idempotent, safe to re-run every minute. For each stale session it sets `clock_out` to the recorded `browser_gone_at` (not "now"), `status: 'completed'`, `close_reason: 'browser_closed'`, and clears `browser_gone_at`; if the session was on a break it also folds the elapsed break time into `total_break_seconds`. Designed to run every minute rather than every 5 specifically to keep the real "browser closed but not detected" window close to the stated 5-minute grace (see in-code incident note from 2026-08-16).

---

### `GET /api/track1?resource=workforce_team`
**Auth:** Global `requireApiAuth` gate, plus handler-level `getRequestingProfile(req)`, plus a role check: only `role === 'admin'` or `role === 'superadmin'` may proceed.
**Purpose:** Admin/manager dashboard listing every employee's clock-in state, status, break time, and End-of-Day report status for today.

**Request body / query params:** None.

**Response:**
```json
{
  "ok": true,
  "tablesReady": true,
  "team": [
    {
      "id": "...", "email": "...", "full_name": "...", "role": "field_tech",
      "clockedInNow": true, "onBreak": false, "clockInTime": "2026-08-22T...",
      "status": "available", "statusLabel": "Available", "statusEmoji": "✅",
      "statusUpdatedAt": "2026-08-22T...", "totalBreakSecondsToday": 900,
      "lastClockOut": null, "sessionsToday": 1,
      "summarySubmitted": false, "summary": null
    }
  ]
}
```

Notes: `401` if not signed in; `403 { "ok": false, "error": "Only an admin/manager can view the team workforce dashboard." }` if signed in but not admin/superadmin. Returns `{ "ok": true, "team": [], "tablesReady": false, "note": "Workforce tables are not set up yet in Supabase -- run the setup SQL, then this will populate automatically." }` if the sessions/summaries queries fail. Built from every row in `profiles`, cross-referenced against today's `workforce_time_sessions` and `workforce_daily_summaries` — a profile with no session today still appears with `clockedInNow: false`.

---

### `GET /api/track1?resource=workforce_team_status`
**Auth:** Global `requireApiAuth` gate, plus handler-level `getRequestingProfile(req)` (signed-in Supabase user). No role restriction.
**Purpose:** Self-service "who's around and what's their status" card — lists every employee currently clocked in and their availability status.

**Request body / query params:** None.

**Response:**
```json
{
  "ok": true,
  "tablesReady": true,
  "team": [
    { "id": "...", "full_name": "Jane Doe", "status": "available", "statusLabel": "Available", "emoji": "✅", "statusUpdatedAt": "2026-08-22T...", "onBreak": false }
  ]
}
```

Notes: `401` if not signed in. Returns `{ "ok": true, "team": [], "tablesReady": false }` if the sessions query fails, or `{ "ok": true, "team": [], "tablesReady": true }` if it succeeds but nobody is currently clocked in. `full_name` falls back to the profile's `email`, then `'Unknown'`, if no name is on file. Unlike `workforce_team`, this only includes employees with an active session right now (not the full roster), and carries no admin/role gate.
## Watching / Dispatch Insights

### `GET /api/track1?resource=watching_all`
**Auth:** Global gate only (`requireApiAuth`). `handleWatchingAll(req, res)` (api/track1.js:3793, dispatched at line 7781) performs no further auth or method check.

**Purpose:** Aggregated "Watching" feed for the Command Center — a small number of real, live-data items (upcoming inspections, crew load) plus an honest list of watch categories that have no data source connected yet.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "watching_all",
  "items": [ { "kind": "inspection", "icon": "🔍", "title": "...", "detail": "...", "pip": "g" } ],
  "notConnected": [ { "kind": "vendor_insurance", "title": "Vendor insurance & certs", "reason": "..." } ]
}
```

Notes: `items` includes at most 3 upcoming visits whose title matches `/inspect/i` in the next 7 days, plus one always-present "crew load" summary item. `notConnected` always includes 5 fixed placeholder categories (vendor insurance/certs, permits, change orders, equipment, loan payments) that have no real data source wired up — plus a `schedule` entry if the Jobber visit lookup itself throws.

### `GET /api/track1?resource=watching_bridge_status`
**Auth:** Global gate only (`requireApiAuth`). `handleWatchingBridgeStatus(res)` (api/track1.js:2470, dispatched at line 7724) takes no `req` and performs no further auth or method check.

**Purpose:** Reports whether the office PC bridge / HiveLogic Monitor agent is online, for the Command Center's PC-health watcher.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "asOf": "2026-08-22T00:00:00.000Z",
  "lastPing": "2026-08-22T00:00:00.000Z",
  "ageSeconds": 45,
  "online": true,
  "gaps24h": 0,
  "pings24h": 1234,
  "note": "PC-online signal: freshest of bridge_heartbeats and the Monitor agent heartbeat (60s cadence). online = under 2 minutes old."
}
```

Notes: `lastPing`/`online` take the freshest of two signals — the legacy `bridge_heartbeats` table (retired but still read) and the HiveLogic Monitor desktop agent's `last_seen_at` (`monitor_agents` where `status='active'`); whichever is newer wins. `online` = age under 120 seconds. `gaps24h` counts heartbeat gaps over 2 minutes within the trailing 24h window, from `bridge_heartbeats` only.

### `GET /api/track1?resource=watching_margin_fade`
**Auth:** Global gate (`requireApiAuth`), **plus** the `FINANCIAL_RESOURCES` role gate (api/track1.js:7550-7563): `watching_margin_fade` is one of the 6 entries in that array (`cash`, `leaks`, `overhead`, `forecast`, `watching_margin_fade`, `jobs_margin_list`). Unless the request authenticated via the cron-secret path (`gate.via === 'cron'`), the caller's profile (via `getRequestingProfile`) must have `role` of `admin` or `superadmin`, OR hold a dispatch permission role (`getDispatchPermissionRoles`) of `owner` or `office_ar` — otherwise `403 { "ok": false, "error": "Your role does not have access to financial data. Ask an owner or office manager if you need this." }`. `handleWatchingMarginFade(res)` (api/track1.js:2622, dispatched at line 7730) itself does no additional auth/method check.

**Purpose:** Flags active jobs whose QuickBooks Customer:Job actual costs are eating 70%+ of the Jobber contract total, for the Command Center's "Jobs Needing Attention" tile.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "source": "Jobber (contract total, live) + QuickBooks Customer:Job (actual cost, cached 4 min ago)",
  "asOf": "2026-08-22T00:00:00.000Z",
  "costDataAsOf": "2026-08-21T23:56:00.000Z",
  "fadeThresholdPct": 70,
  "activeJobsScanned": 0,
  "activeJobsWithCostData": 0,
  "flagged": [ { "jobNumber": "...", "title": "...", "contractTotal": 0, "actualCostSoFar": 0, "marginUsedPct": 0, "lineCount": 0, "url": "..." } ],
  "coverageNote": "..."
}
```
On QuickBooks-not-connected or a costing-fetch error: `{ "ok": false, "error": "..." }` (still HTTP 200).

Notes: Memoized in-process for 50 seconds (`marginFadeCachePromise`/`marginFadeCacheT`) — concurrent/rapid calls within that window share one computation. The underlying QuickBooks job-costing scan is itself cached in Supabase (`getFinancialsDurable('job_costing_summary')`, sql/042); when that cache is stale, this handler still responds immediately with the cached numbers and then triggers a background re-scan *after* the response has already been sent (stale-while-revalidate; relies on `maxDuration: 120` for the serverless function to stay alive). `flagged` only includes jobs QuickBooks actually has Customer:Job-coded cost lines for — a job not listed is not confirmed healthy, just uncoded (see `coverageNote`).

### `GET /api/track1?resource=watching_unscheduled`
**Auth:** Global gate only (`requireApiAuth`) — not in `FINANCIAL_RESOURCES`. `handleWatchingUnscheduled(res)` (api/track1.js:2501, dispatched at line 7727) takes no `req` and performs no further auth or method check.

**Purpose:** Lists open jobs with no start date — work waiting to be booked — for the Command Center's "unscheduled work" watcher.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "source": "Jobber via Supabase -- live",
  "asOf": "2026-08-22T00:00:00.000Z",
  "count": 0,
  "jobs": [ { "jobNumber": "...", "title": "...", "clientName": "...", "total": 0, "waitingDays": 0, "status": "unscheduled", "url": "..." } ],
  "byStatus": { "unscheduled": 7 },
  "note": "..."
}
```

Notes: Deliberately broader than Jobber's own `unscheduled` status — matches any open (`job_status != archived`), undated (`start_at is null`), uncompleted job, since that status alone missed real unbooked work (`action_required` and native `active` jobs with no date). `byStatus` is a breakdown of the mixed statuses returned, so callers can see it isn't only Jobber's `unscheduled` bucket. No crew-assignment data (not synced from Jobber).

## Weather

### `GET /api/track1?resource=weather`
**Auth:** Global gate only (`requireApiAuth`) — not in `FINANCIAL_RESOURCES`. `handleWeather(req, res)` (api/track1.js:3787, dispatched at line 7778) performs no further auth or method check.

**Purpose:** Returns current conditions, hourly, and 7-day forecast for the Bedford, NY HQ, for the Command Center's weather tile.

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "resource": "weather",
  "location": "Bedford, NY 10506 (HQ)",
  "now": { "tempF": 72, "label": "Partly cloudy", "emoji": "⛅" },
  "current": { "tempF": 72, "apparentF": 74, "code": 2, "emoji": "⛅", "label": "Partly cloudy", "humidity": 55, "uv": 4, "windMph": 6, "precipPct": 10, "hiF": 80, "loF": 65, "updated": "..." },
  "today": { "date": "...", "dow": "Sat", "hiF": 80, "loF": 65, "precipPct": 10, "windMph": 8, "label": "...", "emoji": "...", "risk": 0 },
  "days": [ "...7 of these, today first..." ],
  "daily": [ "...same array as days..." ],
  "hourly": { "2026-08-22": [ { "time": "...", "hour": "3 PM", "hour24": 15, "tempF": 78, "apparentF": 80, "code": 2, "emoji": "...", "label": "...", "precipPct": 10, "windMph": 8, "gustMph": 14, "humidity": 50, "uv": 5 } ] },
  "risk": null,
  "summaryText": "72F partly cloudy -- no weather risk next 7 days",
  "source": "Open-Meteo, live"
}
```

Notes: External call to `api.open-meteo.com` (no API key). Response is cached in-process for 30 minutes (`wxCacheData`/`wxCacheT`) — all callers within that window get the same cached forecast, not a fresh live fetch. `risk` is the first upcoming day (if any) with ≥50% precip chance or a weather-code "risk" of 2+ (rain/snow/storms); `null` if none in the next 7 days. Coordinates are hardcoded to Bedford, NY.


# Automation Agents API

`api/agents/control.js`, `device.js`, and `enrollment.js` implement a Windows automation-agent task-runner: enrollment-code pairing, a heartbeat/poll/event lifecycle, an admin approval gate, and pause/resume/emergency_stop/revoke kill-switches. It's constrained to two read-only task types (`repository_status`, `repository_test`) — `validateTask()` rejects any task payload containing `command`, `shell`, or `script` keys, so there is no path to arbitrary command execution here.

**This is unrelated to HiveLogic Monitor** (employee time/screenshot/consent tracking), which lives in `api/_lib/monitor.js` and the `monitor_*` resources in `api/track1.js`, documented separately.

## Auth mechanisms

- **`requireStaff(req)`** — a Supabase session (`Authorization: Bearer <supabase JWT>`, resolved via `${SUPABASE_URL}/auth/v1/user`), with `profiles.role` required to be `admin` or `superadmin`. `401` if no/invalid session, `403` if signed in but the wrong role.
- **`requireAgent(req)`** — a device credential, a custom scheme (`Authorization: Agent <agentId>.<secret>`, not `Bearer`). The secret is SHA-256-hashed and matched against `automation_agent_credentials.secret_hash` (must be unrevoked and unexpired); the agent row must also exist, match the configured `TENANT_ID`, and be unrevoked. Every call updates `last_used_at`.
- **Enrollment's `action=consume`** — no auth function at all. Gated purely by possession of a valid, unused, unexpired one-time enrollment code (10-minute TTL, SHA-256-hashed at rest, single-use via a race-safe `used_at is.null` PATCH). Any machine holding the code can call this.

## Device Enrollment & Pairing (`api/agents/enrollment.js`)

### `POST /api/agents/enrollment?action=create`
**Auth:** Staff session (admin/superadmin).
**Purpose:** An admin generates a one-time pairing code for a new agent machine.

**Request body / query params:** none.

**Response (201):**
```json
{ "ok": true, "enrollmentCode": "<plaintext, shown once>", "expiresAt": "<ISO8601>" }
```

Notes: the code is a 24-byte base64url random value; only its SHA-256 hash (`automation_enrollment_codes.code_hash`) is ever stored. 10-minute expiry.

### `POST /api/agents/enrollment?action=consume`
**Auth:** None — possession of a valid, unused, unexpired `enrollmentCode` is the only gate.
**Purpose:** A new device redeems the pairing code to register itself and receive credentials.

**Request body / query params:**
- `enrollmentCode` (string, required)
- `hostname` (string, required, ≤200 chars)
- `displayName` (string, optional, defaults to hostname, ≤200 chars)
- `agentVersion` (string, optional)
- `capabilities` (array, optional)
- `approvedScopes` (array, optional, max 50) — each `{ type: 'folder'|'repository', path: string, permissions: ['read'|'test'] }`

**Response (201):**
```json
{ "ok": true, "agent": { "...": "inserted automation_agents row" }, "credential": "<agentId>.<secret>" }
```

Notes: single-use code, claimed atomically. `409` if the hostname is already registered ("Re-enrollment and credential sharing are not allowed"). Only the credential's hash is ever persisted, so the plaintext `credential` in this response is the only time it's recoverable — `rotate_credential` (below) is currently a disabled stub, so a lost credential means re-enrolling under a new/changed hostname.

## Agent Control Panel (`api/agents/control.js` — staff/admin session only)

### `GET /api/agents/control`
**Auth:** Staff session (admin/superadmin).
**Purpose:** Lists all agents and the 100 most recent tasks for the tenant.

**Response:**
```json
{ "ok": true, "agents": [], "tasks": [] }
```

### `POST /api/agents/control` (`action: "create_task"`)
**Auth:** Staff session.
**Purpose:** Queues a new task for a device.

**Request body / query params:**
- `agentId` (string, required)
- `taskType` (string, required) — `repository_status` or `repository_test`.
- `payload` (object, required) — `payload.path` (string, required, ≤500 chars); rejected if it contains `command`/`shell`/`script` keys.

**Response (201):**
```json
{ "ok": true, "task": { "...": "automation_tasks row" } }
```

Notes: `400` on an invalid task type or payload, `404` if the device doesn't exist, `409` if the device is paused/emergency-stopped/revoked. Risk tier and approval requirement are derived server-side from `taskType` — `repository_test` requires approval (status `pending_approval`), `repository_status` goes straight to `queued`.

### `POST /api/agents/control` (`action: "approve_task"` or `"reject_task"`)
**Auth:** Staff session.
**Purpose:** An admin approves or rejects a task awaiting approval.

**Request body / query params:**
- `taskId` (string, required)
- `reason` (string, optional)

**Response:**
```json
{ "ok": true }
```

Notes: writes an `automation_task_approvals` row (`decided_by` = the approving staff member's id) before flipping the task from `pending_approval` to `queued` (approved) or `blocked` (rejected).

### `POST /api/agents/control` (`action: "pause"` | `"resume"` | `"emergency_stop"` | `"revoke"`)
**Auth:** Staff session.
**Purpose:** Kill-switch controls over a single device.

**Request body / query params:**
- `agentId` (string, required)
- `reason` (string, optional) — stored as the audit message.

**Response:**
```json
{ "ok": true }
```

Notes: `emergency_stop` also flips that agent's `queued`/`claimed`/`running` tasks to `cancel_requested`. `revoke` also revokes (sets `revoked_at` on) all of that agent's active `automation_agent_credentials` rows, permanently cutting off its access.

### `POST /api/agents/control` (`action: "rotate_credential"`)
**Auth:** Staff session.
**Purpose:** Intended to reissue a device's credential — currently disabled.

**Response:**
```json
{ "ok": false, "error": "Credential rotation is disabled until the installed-agent rotation handshake is implemented." }
```
(HTTP 409)

Notes: a stub, not implemented yet.

### `POST /api/agents/control` (`action: "cancel_task"`)
**Auth:** Staff session.
**Purpose:** Requests cancellation of a running/queued task.

**Request body / query params:**
- `taskId` (string, required)

**Response:**
```json
{ "ok": true }
```

Notes: returns `{ ok: true }` unconditionally (no existence check on the task); only affects tasks currently `queued`/`claimed`/`running`, setting them to `cancel_requested`.

## Agent Heartbeat & Task Polling (`api/agents/device.js` — device credential only)

The action is read from `req.query.action || body.action`. All three of these require the `Authorization: Agent <agentId>.<secret>` device credential (`requireAgent`) — `401 { "ok": false, "error": "Invalid or revoked device credential." }` otherwise.

### `POST /api/agents/device?action=heartbeat`
**Auth:** Device credential.
**Purpose:** The device reports liveness and, if mid-task, keeps its task lease alive.

**Request body / query params:**
- `currentTaskId` (string, optional)
- `agentVersion` (string, optional)
- `capabilities` (optional)

**Response:**
```json
{ "ok": true, "status": "...", "emergencyStop": false, "paused": false, "cancelRequested": false }
```

Notes: if `currentTaskId` is running/claimed and not cancel-requested, extends `lease_expires_at` by 5 minutes; also updates the agent's `agent_version`/`capabilities`/`last_heartbeat_at`.

### `GET /api/agents/device?action=poll`
**Auth:** Device credential.
**Purpose:** The device asks whether it has a task to run next.

**Response:**
```json
{ "ok": true, "task": null }
```

Notes: when paused/emergency-stopped: `{ "ok": true, "task": null, "paused": true, "emergencyStop": true }`. Otherwise atomically claims the oldest `queued` task for that agent (`queued` → `claimed`, 5-minute lease), so two pollers can't double-claim the same task.

### `POST /api/agents/device?action=event`
**Auth:** Device credential.
**Purpose:** The device reports task lifecycle progress or results.

**Request body / query params:**
- `taskId` (string, required)
- `event` (string, required) — one of `started`, `progress`, `succeeded`, `failed`, `cancelled`, `blocked`.
- `summary` (string, optional, truncated to 1000 chars)
- `message` (string, optional)
- `data` (object, optional) — stored on the audit row.

**Response:**
```json
{ "ok": true }
```

Notes: `404 { "ok": false, "error": "Task not found for this device." }` if the task doesn't belong to the calling agent; `400 { "ok": false, "error": "Invalid event." }` for an unrecognized `event` value. `cleanLog()` redacts substrings matching `token|secret|password|authorization` key=value patterns before storing `summary`/`message` (defense against a device accidentally echoing a secret into its logs), and caps stored length at 12000 chars (1000 for `summary`).

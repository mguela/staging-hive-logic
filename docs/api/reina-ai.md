# Reina AI — API Reference

Reina is HiveLogic's AI "office manager" persona. She shows up as a voice assistant (speech
in and out), a mail-triage inbox that reads and labels the owner's email without ever moving
it, a multi-provider "Boardroom" debate feature (the AI Council: ChatGPT, Claude, and Grok
arguing a brief to consensus under a human-approved budget), a desktop push-notification
system that can reach the owner even with no HiveLogic tab open, and an "AI Workroom" bridge
that lets external coding agents (Codex, Claude Code, etc.) hold a shared conversation and
loop the Boardroom into it. Nearly everything below is explicit about what it does *not* do
on its own — most write paths are gated behind human approval, a machine-enforced completion
gate, or a separate, deliberate button press.

## Boardroom / AI Council

### `GET /api/reina-council?status=1`
**Auth:** `requireStaff` (signed-in user via `requireUser`, restricted to `admin`/`superadmin` role). Endpoint returns 404 entirely (not 401/403) when `REINA_COUNCIL_ENABLED` is not `'true'`.
**Purpose:** Report whether the Council is enabled, whether all three provider integrations are configured, and the current budget/operational limits.

**Request body / query params:**
- `status` (string, required) — must equal `"1"` to select this branch

**Response:**
```json
{ "ok": true, "enabled": true, "ready": true, "providers": [{ "name": "claude", "configured": true }], "limits": { "maxRounds": 3, "maxTokensPerResponse": 4000, "maxCostCents": 500, "maxConcurrentRuns": 1, "dailyCostCents": 2000 } }
```

Notes: `ready` is only `true` when all three providers (`claude`, `chatgpt`, `grok`) are configured; a run cannot start (`action=start`) unless this is `true`.

---

### `GET /api/reina-council?workspace=1`
**Auth:** `requireStaff`
**Purpose:** Fetch the caller's Boardroom projects and their 50 most recent runs, for the workspace view.

**Request body / query params:**
- `workspace` (string, required) — must equal `"1"`

**Response:**
```json
{ "ok": true, "projects": [ { "id": "...", "name": "..." } ], "recent": [ { "id": "...", "state": "..." } ] }
```

---

### `GET /api/reina-council?history=1`
**Auth:** `requireStaff`
**Purpose:** Paginate the caller's past Council runs.

**Request body / query params:**
- `history` (string, required) — must equal `"1"`
- `limit` (integer, optional, 1–50, default 25)
- `offset` (integer, optional, 0–100000, default 0)

**Response:**
```json
{ "ok": true, "history": [ { "id": "...", "state": "..." } ], "hasMore": false, "nextOffset": 25 }
```

---

### `GET /api/reina-council?runId=<uuid>`
**Auth:** `requireStaff`
**Purpose:** Fetch one specific Council run belonging to the caller. This is the default GET branch when `status`/`workspace`/`history` are absent.

**Request body / query params:**
- `runId` (string, required) — the run's id

**Response:**
```json
{ "ok": true, "run": { "id": "...", "state": "...", "report": {}, "messages": [] } }
```

Notes: 400 if `runId` is missing; 404 `{ "ok": false, "error": "Council run not found." }` if it doesn't belong to the caller.

---

### `POST /api/reina-council` — `action: "create_project"`
**Auth:** `requireStaff`
**Purpose:** Create a Boardroom project (a grouping bucket for runs).

**Request body / query params:**
- `action` (string, required) — `"create_project"`
- `name` (string, required, 1–120 chars)
- `repository` (string, optional, ≤500 chars)

**Response:**
```json
{ "ok": true, "project": { "id": "...", "name": "...", "repository": null } }
```

---

### `POST /api/reina-council` — `action: "update_run_metadata"`
**Auth:** `requireStaff`
**Purpose:** Pin/unpin a run and/or move it into a project.

**Request body / query params:**
- `action` (string, required) — `"update_run_metadata"`
- `runId` (string, required, UUID)
- `pinned` (boolean, optional)
- `projectId` (string|null, optional, UUID)

**Response:**
```json
{ "ok": true, "run": { "id": "...", "pinned": true, "project_id": "..." } }
```

Notes: 404 if `projectId` doesn't belong to the caller.

---

### `POST /api/reina-council` — `action: "start"`
**Auth:** `requireStaff`
**Purpose:** Kick off a Boardroom debate: ChatGPT (OpenAI), Claude (Anthropic), and Grok (xAI) each argue a brief across bounded rounds toward consensus/conflicts, under an idempotency key and a cost/round budget.

**Request body / query params:**
- `action` (string, required) — `"start"`
- `brief` (string, required) — the question/task posed to the Council
- `evidence` (array, optional) — caller-supplied source material; merged with live company-intelligence and Boardroom-history snapshots server-side
- `attachments` (array, optional) — `{id, name, kind, mimeType}`; images/PDFs count against a token reserve
- `budget` (object, optional) — `{maxRounds, maxTokensPerResponse, maxCostCents}`, clamped to server ceilings (`REINA_COUNCIL_MAX_ROUNDS` etc., defaults 3 / 4000 / 500¢)
- `executionRequest` (object, optional) — a proposed HiveBridge task the run may ask a human to later approve
- `idempotencyKey` (string, required) — `/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/`
- `projectId` (string|null, optional, UUID)

**Response:**
```json
{ "ok": true, "runId": "...", "state": "...", "report": { "consensus": [], "conflicts": [], "unresolved": [], "completionGate": {} }, "usage": {}, "replies": [ { "participant": "claude", "round": 1 } ], "degradedProviders": [], "staleDebatePositions": [], "executionRequest": null, "project": null, "projectCreated": false, "projectRequestAmbiguous": false }
```

Notes: Requires all 3 providers configured (409 otherwise). Runs an admission-control check (per-owner concurrency cap, per-owner daily cost cap in cents) before spending anything; replays an identical prior request by idempotency key instead of re-running it. If the brief explicitly asks to pull in a specific external AI platform's history (ChatGPT/Claude/Claude Code/Codex/Grok) that has not actually been imported, the run is refused before any provider call with `code: "HISTORY_SOURCES_NOT_IMPORTED"` rather than answering from company data as a substitute. A brief that explicitly asks to create a "(master) project" auto-creates/attaches one (`projectRequestAmbiguous` flags an unresolved "master project" mention that didn't match any recognized creation phrasing, so the UI can surface it instead of silently ignoring or silently guessing). `staleDebatePositions` surfaces any provider whose position was silently carried forward from an earlier round rather than freshly re-argued.

---

### `POST /api/reina-council` — `action: "approve_execution"`
**Auth:** `requireStaff`
**Purpose:** Approve a Council run's proposed `executionRequest` and queue it as a HiveBridge task — this endpoint queues only; it never executes the task itself.

**Request body / query params:**
- `action` (string, required) — `"approve_execution"`
- `runId` (string, required)
- `reason` (string, optional, ≤500 chars)

**Response:**
```json
{ "ok": true, "state": "queued_for_hivebridge", "taskId": "...", "executed": false }
```

Notes: 409 if the run isn't in `awaiting_human_approval` state, has no pending execution request, or the stored request fails HiveBridge's task allow-list validation.

## Voice & Pilot Chat

### `POST /api/reina-neural-speech`
**Auth:** `requireUser` (any signed-in user). Also gated by env flags: in production requires `REINA_PILOT_ENABLED`, `REINA_PILOT_PRODUCTION_ENABLED`, and `REINA_VOICE_NEURAL_ENABLED` all `'true'`; in preview/test requires `REINA_VOICE_NEURAL_ENABLED` or `REINA_PREVIEW_ENABLED`.
**Purpose:** Turn text into speech using Reina's neural voice.

**Request body / query params:**
- `text` (string, required, ≤6000 chars) — rejected outright if it contains control/invisible Unicode characters or HTML/`javascript:` patterns
- `voice` (string, optional, default `"marin"`) — one of `marin`, `coral`, `nova`, `shimmer`, `sage`

**Response:** raw `audio/mpeg` bytes on success (`Content-Type: audio/mpeg`), or on failure:
```json
{ "ok": false, "code": "neural_voice_unavailable" }
```

Notes: Calls OpenAI's `/v1/audio/speech` with model `REINA_TTS_MODEL` (default `gpt-4o-mini-tts`) and a fixed system-style instruction to sound like "a highly capable, warm American executive assistant... never robotic, theatrical, breathy, sing-song, or like an announcer." Comment in the code: the requested speech text, the Authorization header, and the API key are "never logged, persisted, or included in audit output."

---

### `GET /api/reina-pilot`
**Auth:** `resolveActingContext` + `decideAuthorization` for the `PILOT_ACCESS` operation — a policy-based "ActingContext" authorization layer (distinct from the plain `requireUser`/`requireStaff` checks elsewhere), driven by the caller's bearer token. The bootstrap response's display name is only ever resolved for a `profiles` row with role `admin` or `superadmin`. Gated by `REINA_PILOT_ENABLED`, `REINA_ACTING_CONTEXT_ENABLED`, `REINA_DURABLE_CONVERSATIONS_ENABLED` (all `true`), plus `REINA_PILOT_PRODUCTION_ENABLED` in production; `REINA_PREVIEW_ENABLED` alone can unlock it in preview.
**Purpose:** Bootstrap a Pilot chat session: identify the caller, hand back a session id, and surface an "attention" summary plus one pending confirmable navigation suggestion.

**Request body / query params:** none (GET)

**Response:**
```json
{ "ok": true, "sessionId": "rp.<hash>", "generatedAt": "2026-08-21T00:00:00.000Z", "executed": false, "user": { "displayName": "Chris" }, "attention": { "total": 3, "asOf": "...", "reviewAvailable": true, "categories": [ { "key": "jobs", "label": "Synthetic jobs needing attention", "count": 3, "available": true, "asOf": "...", "evidence": ["1001","1002","1003"] }, { "key": "mail", "label": "Important email", "count": null, "available": false, "asOf": null, "evidence": [] } ], "unavailableSources": [ "Important email is unavailable because an owner-scoped mailbox read operation is not enabled." ] }, "review": { "intentId": "rui.<hex>", "available": true, "expiresAt": "..." }, "uiIntent": { "version": "reina.ui-intent.v1", "executed": false, "requiresConfirmation": true, "kind": "navigate", "destination": "standup" } }
```

Notes: The `attention.jobs` category is filled entirely from a hardcoded preview fixture (`ATTENTION_JOB_NUMBERS` / `PREVIEW_NOW`) — synthetic job numbers, not a live query — while `mail`/`finance`/`weather` are always reported unavailable with a named reason each. The issued `uiIntent`/`review` is a canned "navigate to standup" suggestion that expires after 5 minutes and must be separately confirmed via the `confirm_review` action below; it is never auto-executed.

---

### `POST /api/reina-pilot` — `{action: "confirm_review", intentId}`
**Auth:** same as GET above.
**Purpose:** Confirm a previously issued review/navigation intent from the bootstrap call.

**Request body / query params:**
- `action` (string, required) — `"confirm_review"`
- `intentId` (string, required) — must start with `rui.`

**Response:**
```json
{ "ok": true, "confirmed": true, "intentId": "rui.<hex>", "executed": false, "nothingExecuted": true, "businessActionAllowed": false, "automationTaskAllowed": false, "toolExecutionAllowed": false }
```

Notes: Fails with 409 (duplicate), 410 (expired), 408 (timeout), or 403 (`authorization_expired`, owner/policy mismatch) rather than silently no-opping.

---

### `POST /api/reina-pilot` — conversational turn
**Auth:** same as GET above.
**Purpose:** Submit one spoken or typed utterance and get Reina's answer, stored durably and replay-safe by idempotency key.

**Request body / query params:**
- `utterance` (string, required, ≤4000 chars) — control/invisible characters rejected
- `conversationId` (string, required) — must match the session id derived from the caller's own bearer token
- `turnId` (string, required) — identifier pattern
- `idempotencyKey` (string, required) — must equal a canonical `rt.<sha256>` hash derived from `conversationId`+`turnId`
- `transport` (string, required) — `"typed"` or `"voice"`

**Response:**
```json
{ "ok": true, "enabled": true, "stored": true, "conversationId": "...", "turnId": "...", "idempotencyKey": "rt....", "replayed": false, "executed": false, "nothingExecuted": true, "businessActionAllowed": false, "automationTaskAllowed": false, "toolExecutionAllowed": false, "synthetic": false, "dataAccess": "authorized_read", "reviewAvailable": false, "envelope": { "answer": "...", "evidence": [] }, "plainText": "...", "navigation": null }
```

Notes: This endpoint's central design rule shows up in every response — success or failure — via the shared `unavailable()` helper, which unconditionally sets `executed: false, nothingExecuted: true, businessActionAllowed: false, automationTaskAllowed: false, toolExecutionAllowed: false`. An utterance that reads as asking Reina to actually *do* something (`isActionSeekingText`) is refused outright with a fixed action-refusal envelope rather than answered. If `OPENAI_API_KEY` is configured, answers come from an OpenAI-backed "intelligence pilot composer"; otherwise a canned synthetic composer answers instead.

## Search

### `GET /api/reina-search?q=<query>`
**Auth:** `requireUser`, plus an explicit additional check that the caller's `profiles` row has role `admin` or `superadmin` (`exactAdminProfile`) — so this is admin-only even though it starts from the generic user-auth helper. Gated by `REINA_GLOBAL_SEARCH_ENABLED='true'` (plus `REINA_GLOBAL_SEARCH_PRODUCTION_ENABLED` in production).
**Purpose:** One global search box across clients, jobs, estimates, invoices, and client requests.

**Request body / query params:**
- `q` (string, optional) — normalized (NFKC, control chars stripped) and truncated to 120 chars; must be ≥2 chars to actually search (shorter returns an empty result set, no query executed)

**Response:**
```json
{ "ok": true, "query": "smith", "results": [ { "kind": "JOB", "id": "12345", "title": "#12345 · Roof repair", "subtitle": "Jane Smith · Stamford · CT", "status": "active", "updatedAt": "...", "navigation": { "view": "jobs", "recordType": "job", "recordId": "12345" } } ], "unavailable": [] }
```

Notes: Searches `clients`, `jobs_enriched`, `quotes`, `invoices`, `requests` via Supabase PostgREST `ilike`, 5 results per table, 20 total; `unavailable` lists which of those five tables errored out (search still returns partial results unless every source failed, in which case it's a 503).

## Mail Triage & Sweep

Code comment on this feature: **"THIS ROUTE MOVES NO MAIL. It reads, it labels, it records what a human chose."** Reading a mailbox is reversible; archiving is not, so replying, scheduling, archiving, and "handled" are all separate, deliberately human-triggered actions rather than something a confidence score decides on its own.

### `POST /api/reina/mail-triage?action=list`
**Auth:** `requireApiAuth`, and specifically requires a signed-in user (`auth.user.id`) — a bare cron secret is rejected here ("a cron has no mailbox of its own").
**Purpose:** Pull each of the caller's connected Microsoft mailboxes since the last watermark (or start of business day), label every new message (standing per-sender rule → Claude → stored once), and pre-write reply drafts for anything labeled `needs_reply`.

**Request body / query params:** none required.

**Response:**
```json
{ "ok": true, "rows": [ { "message_id": "...", "label": "needs_reply", "corrected_label": null } ], "mailboxesRead": 1, "mailboxesTotal": 1, "classified": 4, "byRule": 2, "drafted": 3, "draftsFailed": 0, "unlabelled": 0, "scannedSince": "...", "truncated": false, "classifyError": null, "storeError": null }
```

Notes: Provider is Anthropic (`mailTriageModel()`, default `claude-opus-5`). Verdicts and drafts are each written exactly once and never re-derived on a later look. Deduplicates a message that arrived as a copy in two of the owner's mailboxes to one row.

---

### `POST /api/reina/mail-triage?action=classify`
**Auth:** same as `list`.
**Purpose:** Judge a batch of envelopes the browser already fetched itself — used for the Gmail/IMAP mailbox, which the server cannot reach directly.

**Request body / query params:**
- `account` (string, required) — the IMAP mailbox address
- `messages` (array, required, ≤100 items) — envelope objects `{messageId, subject, fromAddress, fromName, receivedAt, preview, isRead, ...}`

**Response:**
```json
{ "ok": true, "rows": [], "classified": 0, "byRule": 0, "unlabelled": 0, "classifyError": null, "storeError": null }
```

Notes: Gmail-over-IMAP messages carry no body preview from this adapter, so they're judged on sender+subject alone; the code notes this is "a weaker read than the Microsoft mailboxes get."

---

### `POST /api/reina/mail-triage?action=correct`
**Auth:** same as `list`.
**Purpose:** Re-label a message and turn that correction into a standing rule for that sender.

**Request body / query params:**
- `messageId` (string, required)
- `label` (string, required) — one of `needs_reply`, `needs_scheduling`, `needs_action`, `junk`, `fyi`

**Response:**
```json
{ "ok": true, "messageId": "...", "label": "junk", "ruleSaved": true, "learnedFrom": "spam@example.com" }
```

---

### `POST /api/reina/mail-triage?action=act`
**Auth:** same as `list`.
**Purpose:** Record that a message has been dealt with (removes it from the triage list and the pending/Team-To-Do count). This endpoint only records the fact — the actual reply/schedule/archive happens in the mail app itself.

**Request body / query params:**
- `messageId` (string, required)
- `action` (string, required) — one of `replied`, `scheduled`, `tasked`, `archived`, `dismissed`

**Response:**
```json
{ "ok": true, "messageId": "...", "action": "archived" }
```

---

### `POST /api/reina/mail-triage?action=draft`
**Auth:** same as `list`.
**Purpose:** Write (or rewrite) a reply draft for one message.

**Request body / query params:**
- `messageId` (string, required)
- `instruction` (string, optional) — how to change a prior draft
- `previous` (string, optional) — the prior draft being rewritten
- `bodyText` (string, required only for an IMAP/Gmail mailbox, since the server can't fetch its body itself)

**Response:**
```json
{ "ok": true, "messageId": "...", "graphId": "...", "draft": "Hi Jane, ...", "hasBlanks": false }
```

Notes: Provider is Anthropic (`mailTriageModel()`, default `claude-opus-5`). System prompt instructs it to write short, plain, non-corporate replies and to leave an explicit `[CONFIRM DATE]`-style blank rather than invent a fact: "A draft with an honest gap in it is useful; a draft with a made-up fact in it is a liability."

---

### `POST /api/reina/mail-triage?action=brief`
**Auth:** same as `list`.
**Purpose:** Full-message read on demand (when the user opens one email): summarize it, re-label it against the full body (not just the preview), and draft a reply if warranted. Cached after the first read.

**Request body / query params:**
- `messageId` (string, required)
- `refresh` (boolean, optional) — force a re-read of an already-briefed message
- `subject`, `fromAddress`, `fromName`, `receivedAt`, `webLink`, `graphId`, `homeAccountId` (strings, optional) — fallback identity fields for a message the batch scan never covered
- `bodyText`, `headers` (optional) — required for an IMAP/Gmail message, supplied by the browser

**Response:**
```json
{ "ok": true, "messageId": "...", "summary": "...", "action": "...", "label": "needs_reply", "modelLabel": "needs_reply", "correctedLabel": null, "draft": "...", "unsubscribe": null, "hasBlanks": false, "briefAt": "...", "cached": true }
```

---

### `POST /api/reina/mail-triage?action=pending`
**Auth:** same as `list`.
**Purpose:** Read-only list of everything still waiting on the owner, for the cross-screen notification popup. Costs a database query only — no model call.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "items": [ { "id": "...", "source": "email", "from": "Jane Smith", "subject": "...", "receivedAt": "...", "label": "needs_reply", "summary": null, "action": "...", "draft": null, "brief": false, "webLink": "...", "unsubscribe": null } ] }
```

Notes: Only the three "somebody is waiting" labels (`needs_reply`, `needs_scheduling`, `needs_action`) ever appear here — junk and fyi never interrupt.

---

### `POST /api/reina/mail-triage?action=reply`
**Auth:** same as `list`.
**Purpose:** Actually send a reply through Microsoft Graph — the one mail-triage action that performs a real, irreversible mailbox write.

**Request body / query params:**
- `messageId` (string, required)
- `text` (string, required) — sent verbatim, exactly what's in the popup's editable draft box

**Response:**
```json
{ "ok": true, "messageId": "...", "sentTo": "jane@example.com" }
```

Notes: IMAP/Gmail messages are rejected with 409 ("that mailbox can only be replied to from the email app") since the server can't reach them. Marks the message `acted_action: 'replied'` only *after* Graph confirms the send.

---

### `POST /api/reina/mail-triage?action=draft_save`
**Auth:** same as `list`.
**Purpose:** Persist the user's own edit of a draft (so it survives a refresh).

**Request body / query params:**
- `messageId` (string, required)
- `draft` (string, optional, ≤20000 chars) — empty/whitespace clears the stored draft rather than being treated as a no-op

**Response:**
```json
{ "ok": true, "messageId": "...", "draft": "..." }
```

---

### `POST /api/reina/mail-triage?action=unsubscribe`
**Auth:** same as `list`.
**Purpose:** Fire an RFC 8058 one-click unsubscribe POST against the sender's own advertised unsubscribe URL.

**Request body / query params:**
- `messageId` (string, required)

**Response:**
```json
{ "ok": true, "messageId": "...", "unsubscribedFrom": "newsletter@example.com" }
```

Notes: The target URL always comes from the stored row (extracted from that message's own `List-Unsubscribe` headers) — never from the request body — "which is what keeps this from being a way to make our server fetch anything anyone likes." 409 if the sender never advertised one-click unsubscribe. Explicitly manual, on purpose: "an unattended unsubscriber would be firing requests at strangers' servers on his behalf, and for real spam that is exactly the wrong move — it confirms the address is live."

---

### `GET|POST /api/reina/mail-sweep`
**Auth:** `requireApiAuth` (accepts either the cron secret or a signed-in user; a POST from a signed-in user scopes the sweep to that one owner, useful for testing on demand — an unauthenticated cron run sweeps every owner with a live push subscription).
**Purpose:** The unattended half of mail triage: read mailboxes on a schedule and push a desktop (Web Push) notification for fresh, actionable mail, even with no HiveLogic tab open.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "enabled": true, "swept": 1, "sent": 2, "results": [ { "ownerId": "...", "sent": 2, "quiet": false, "considered": 5, "worth": 2, "overflow": 0, "heldForQuietHours": 0, "backlogSkipped": 3, "scanError": null } ] }
```

Notes: Returns `{ok:true, enabled:false, swept:0, note: "..."}` instead of an error when `REINA_VAPID_PUBLIC_KEY`/`REINA_VAPID_PRIVATE_KEY` aren't configured. Provider is Anthropic (via the same mail-triage classification path). Only mail newer than `FRESH_MS` (4 hours) can trigger a toast — older actionable mail stays on the in-app Team To-Do list instead, explicitly to avoid "seven hours of pinging" through a backlog. Caps at `MAX_TOASTS_PER_SWEEP` (3) toasts per owner per sweep, respects configurable quiet hours (default 21:00–07:00 `America/New_York`) and per-sender/domain mute rules, and only stamps a message as notified after a push provider actually accepts it. Code comments: "It never sends for junk or fyi... It never decides on its own that he does not care. Silence only ever comes from a rule he pressed." Cannot reach the Gmail/IMAP mailbox from an unattended sweep (those credentials require a browser session) — a stated, reported limitation rather than a silent gap.

## Change Request Observation (Reina M1a)

### `POST /api/reina/observe-change-request`
**Auth:** `requireApiAuth` (cron secret or signed-in user). Returns `{ok:true, enabled:false, note:...}` (not an error) unless `REINA_M1A_ENABLED='true'`.
**Purpose:** Read a client's change-request message, summarize it strictly against real job/client/quote/change-order context, and file it as one pending approval row for a human to review — never act on it.

**Request body / query params:**
- `job_id` (string, required)
- `request_text` (string, required when `request_source` is `pasted_client_message`, ≤20000 chars)
- `request_source` (string, optional) — `"pasted_client_message"` (default) or `"m365_graph"` (pulls the client's latest message from a connected mailbox instead, behind `REINA_M365_PULL_ENABLED`)

**Response (new recommendation):**
```json
{ "ok": true, "idempotent": false, "idempotency_key": "reina-m1a-observe-12345", "approval": { "id": "...", "status": "pending", "title": "Change request: add soffit lighting", "confidence": 65 }, "context": { "client_ar": 0, "quote_headers": [] } }
```

**Response (not actually a change request):**
```json
{ "ok": true, "skipped": true, "reason": "not_a_change_request", "idempotency_key": "...", "title": "..." }
```

Notes: Provider is Anthropic (`REINA_OBSERVE_MODEL`, default `claude-sonnet-4-5`). Code comment: **"HARD LIMITS (M1a is observe-only): The single INSERT into marketing_approvals is the ONLY write this endpoint performs. It creates no change order, sends no email, makes no Jobber write, and mutates no invoice or job."** The prompt to Claude states: **"NEVER invent or estimate a price. Only report an amount if the CLIENT explicitly stated one in their request."** — a client-unstated price is always stored as `null`, never guessed. Idempotent per job (or per source email, when scanned) — a repeat call returns the existing pending row and skips the model call entirely.

## Change Request Auto-Scan

### `GET|POST /api/reina/scan-change-requests?days=<1-30>`
**Auth:** `requireApiAuth` (cron secret or signed-in user). Returns `{ok:true, enabled:false, note:...}` unless `REINA_M1A_SCAN_ENABLED='true'`.
**Purpose:** Scheduled sweep of a Microsoft 365 mailbox that resolves each inbound message to a known client's single open job and runs the observe pipeline above on it, notifying the owner when new recommendations are created.

**Request body / query params:**
- `days` (integer, optional, 1–30, default 3) — how far back to read

**Response:**
```json
{ "ok": true, "scanned": 12, "created": 2, "createdItems": [ { "id": "...", "title": "...", "job": "...", "client": "..." } ], "skipped": { "not_a_known_client": 8, "no_open_job": 1, "already_seen": 1 }, "notified": true }
```

Notes: Provider is Anthropic (delegates to `reinaObserveChangeRequest`). Code comments: **"OBSERVE-ONLY, and GOVERNED BY DESIGN: Every write is a pending marketing_approvals row a human must approve... This scanner executes NOTHING: no change order, no email, no Jobber write, no money."** Checks a company-level `emergency_stopped_at` kill switch before reading or writing anything (`{"ok": true, "aborted": "kill_switch", "scanned": 0, "created": 0}`). A sender matching more than one client, or a client with more than one open job, is skipped rather than guessed at. Reads either a shared mailbox via an app-only token (`REINA_SCAN_MAILBOX`, enables a true unattended cron) or the caller's own delegated mailbox (needs an operator session).

## Push Notifications

### `POST /api/reina/push?action=key`
**Auth:** none — the VAPID public key is meant to be public.
**Purpose:** Hand the browser the public key it needs to create a Web Push subscription.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "key": "BApp9...", "configured": true }
```

---

### `POST /api/reina/push?action=subscribe`
**Auth:** `requireApiAuth`, requires a signed-in user (`auth.user.id`).
**Purpose:** Register this browser to receive desktop push notifications.

**Request body / query params:**
- `subscription` (object, required) — `{endpoint (https URL, required), keys: {p256dh, auth}}`
- `userAgent` (string, optional, ≤300 chars)

**Response:**
```json
{ "ok": true, "subscribed": true }
```

Notes: Upserts on `endpoint`, so a re-subscribe from the same browser (which Chrome does on its own when a key rotates) doesn't create a second, duplicate-pinging device.

---

### `POST /api/reina/push?action=unsubscribe`
**Auth:** same as `subscribe`.
**Purpose:** Forget this browser.

**Request body / query params:**
- `endpoint` (string, required, https URL)

**Response:**
```json
{ "ok": true, "subscribed": false }
```

---

### `POST /api/reina/push?action=mute`
**Auth:** same as `subscribe`.
**Purpose:** "Not this sender" — the learning signal pressed directly on a toast, creating (or updating) a standing notify rule that `mail-sweep` respects.

**Request body / query params:**
- `fromAddress` (string, required)
- `scope` (string, optional) — `"sender"` or `"domain"`

**Response:**
```json
{ "ok": true, "muted": "spam@example.com", "scope": "sender" }
```

---

### `POST /api/reina/push?action=unmute`
**Auth:** same as `subscribe`.
**Purpose:** Undo a mute rule.

**Request body / query params:**
- `value` (string, required)
- `scope` (string, optional) — `"sender"` (default) or `"domain"`

**Response:**
```json
{ "ok": true, "unmuted": "spam@example.com" }
```

---

### `POST /api/reina/push?action=rules`
**Auth:** same as `subscribe`.
**Purpose:** List everything the notify system has learned and every device subscribed, so it's inspectable and reversible rather than a model quietly drifting.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "configured": true, "rules": [ { "scope": "sender", "value": "spam@example.com", "notify": false, "source": "user", "hits": 3, "updatedAt": "..." } ], "devices": [ { "id": "a1b2c3d4e5f6", "userAgent": "...", "createdAt": "...", "lastSentAt": "..." } ] }
```

Notes: A device's `id` is only the last 12 characters of its push endpoint — never the full endpoint, since that's a live capability to push to the owner's machine.

---

### `POST /api/reina/push?action=test`
**Auth:** same as `subscribe`.
**Purpose:** Send one real desktop notification on demand, to prove the whole pipeline works without waiting for an actual email.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "sent": 1, "failed": 0 }
```

## AI Workroom Bridge

The AI Workroom lets external AI coding agents (Codex, ChatGPT, Claude, Claude Code, Grok) and the human owner share one running conversation thread, optionally looping in the Boardroom (AI Council) to answer a question inside that thread.

**Auth (applies to every operation below):** either a bridge secret — request header `x-hivelogic-workroom-secret` matching env `HIVELOGIC_WORKROOM_AGENT_SECRET`, with env `HIVELOGIC_WORKROOM_OWNER_ID` also configured (this is how an external agent with no user session authenticates) — **or** a normal signed-in user (`requireUser`). There is no cron-secret path on this route.

### `GET /api/ai-workroom?cost=1`
**Purpose:** Fetch active budget policies and the 250 most recent model-usage records.

**Request body / query params:**
- `cost` (string, required) — `"1"`

**Response:**
```json
{ "policies": [ { "id": "...", "name": "...", "daily_limit_cents": 500 } ], "usage": [ { "actor": "codex", "estimated_cost_cents": 12 } ] }
```

---

### `GET /api/ai-workroom?learning=1`
**Purpose:** Fetch up to 100 recorded "lessons" learned across Workroom sessions.

**Request body / query params:**
- `learning` (string, required) — `"1"`

**Response:**
```json
{ "lessons": [ { "id": "...", "title": "...", "value_assessment": "valuable", "confidence": 90 } ] }
```

---

### `GET /api/ai-workroom?dashboard=1` (or `?threads=1`)
**Purpose:** List the caller's Workroom threads, projects, and connected agent sources.

**Request body / query params:**
- `dashboard` or `threads` (string, required) — `"1"`

**Response:**
```json
{ "threads": [ { "id": "...", "title": "...", "status": "active" } ], "projects": [ { "id": "...", "name": "..." } ], "sources": [ { "source": "codex", "status": "connected", "last_synced_at": "..." } ] }
```

---

### `GET /api/ai-workroom?threadId=<id>`
**Purpose:** Fetch one thread and its full message history.

**Request body / query params:**
- `threadId` (string, required)

**Response:**
```json
{ "thread": { "id": "...", "title": "..." }, "messages": [ { "id": "...", "author_type": "user", "body": "..." } ] }
```

Notes: 404 `{"error": "Workroom conversation not found"}` if the thread doesn't belong to the caller.

---

### `POST /api/ai-workroom` — `action: "create_thread"`
**Purpose:** Start a new Workroom conversation.

**Request body / query params:**
- `action` (string, required) — `"create_thread"`
- `title` (string, optional, default `"New workroom conversation"`)
- `projectId` (string, optional)

**Response:**
```json
{ "thread": { "id": "...", "title": "...", "status": "active" } }
```

---

### `POST /api/ai-workroom` — `action: "create_project"`
**Purpose:** Create a Workroom project grouping.

**Request body / query params:**
- `action` (string, required) — `"create_project"`
- `name` (string, required, ≤120 chars)
- `repository` (string, optional, ≤500 chars)

**Response:**
```json
{ "project": { "id": "...", "name": "..." } }
```

---

### `POST /api/ai-workroom` — `action: "create_budget_policy"`
**Purpose:** Set a per-project or account-wide spending cap for agent work.

**Request body / query params:**
- `action` (string, required) — `"create_budget_policy"`
- `name` (string, required)
- `dailyLimitCents`, `taskLimitCents`, `escalationLimitCents` (integers, required, ≥0)
- `defaultModelTier` (string, optional, default `"economy"`) — one of `economy`, `standard`, `expert`
- `projectId` (string, optional)
- `requireHumanOverLimit` (boolean, optional)

**Response:**
```json
{ "policy": { "id": "...", "name": "...", "daily_limit_cents": 500 } }
```

---

### `POST /api/ai-workroom` — `action: "import_history"`
**Auth:** bridge secret only — returns 403 for a signed-in user.
**Purpose:** Bulk-import a past AI conversation (e.g. from ChatGPT, Claude, or Codex history) into a Workroom thread, deduplicated per source message.

**Request body / query params:**
- `action` (string, required) — `"import_history"`
- `source` (string, required) — one of `codex`, `chatgpt`, `claude`, `claude_code`, `grok`, `reina`, `github`, `manager_self_test`
- `title` (string, required, ≤140 chars)
- `conversationId` (string, required, ≤500 chars)
- `messages` (array, required, ≤500 items) — `{externalId|id, author_type, author_name, body, kind, task_state, created_at, metadata}`
- `cursor` (string, optional)

**Response:**
```json
{ "thread": { "id": "...", "title": "..." }, "received": 40, "imported": 38, "duplicate": 2, "cursor": null }
```

---

### `POST /api/ai-workroom` — `action: "record_lesson"`
**Auth:** bridge secret only.
**Purpose:** Have an agent record a durable "lesson learned" about the product.

**Request body / query params:**
- `action` (string, required) — `"record_lesson"`
- `title` (string, required, ≤180 chars)
- `lesson` (string, required, ≤5000 chars)
- `confidence` (integer, required, 0–100)
- `productArea`, `intendedPurpose`, `observedBehavior`, `appliesTo` (strings, optional)
- `valueAssessment` (string, optional, default `"unknown"`) — one of `valuable`, `needs_improvement`, `not_useful`, `unknown`
- `evidenceCount` (integer, optional)

**Response:**
```json
{ "lesson": { "id": "...", "title": "...", "status": "active" } }
```

Notes: A lesson with `confidence >= 85` is stored as `status: 'active'`; anything lower is stored as `'hypothesis'`.

---

### `POST /api/ai-workroom` — `action: "record_model_usage"`
**Auth:** bridge secret only. Requires an existing `threadId` belonging to the caller (404 otherwise).
**Purpose:** Log a model call's actual token usage and cost for the cost dashboard.

**Request body / query params:**
- `action` (string, required) — `"record_model_usage"`
- `threadId` (string, required)
- `actor` (string, required) — one of `codex`, `chatgpt`, `claude`, `claude_code`, `system`
- `modelTier` (string, required) — `economy`/`standard`/`expert`
- `estimatedCostCents` (integer, required, ≥0)
- `provider`, `model`, `purpose`, `inputTokens`, `outputTokens`, `outcome`, `policyId` (optional)

**Response:**
```json
{ "usage": { "id": "...", "actor": "codex", "estimated_cost_cents": 4 } }
```

---

### `POST /api/ai-workroom` — `action: "pin_thread"`
**Purpose:** Pin/unpin a thread. Requires an existing `threadId`.

**Request body / query params:**
- `action` (string, required) — `"pin_thread"`
- `threadId` (string, required)
- `pinned` (boolean, optional)

**Response:**
```json
{ "ok": true }
```

---

### `POST /api/ai-workroom` — `action: "send_message"`
**Purpose:** Post a human message into a Workroom thread. This is the one action that triggers the AI Council internally: the message is dispatched to the Boardroom (`createCouncilHandler` with `minimumParticipants: 1`, looser than the Boardroom's own direct 3-of-3 requirement) and every provider's reply, plus Reina's own decision summary, is appended back into the thread.

**Request body / query params:**
- `action` (string, required) — `"send_message"`
- `threadId` (string, required)
- `body` (string, required, ≤8000 chars)
- `kind` (string, optional) — one of `message`, `task`, `status`, `decision`, `evidence`

**Response (Council succeeded):**
```json
{ "messages": [ { "author_type": "user", "body": "..." }, { "author_type": "claude", "body": "..." }, { "author_type": "reina", "kind": "decision", "body": "Council discussion finished. Work status: NOT DONE until the machine-enforced completion gate passes." } ], "council": { "runId": "...", "usage": {} } }
```

**Response (Council failed to complete):**
```json
{ "messages": [ { "author_type": "user", "body": "..." }, { "author_type": "system", "kind": "status", "task_state": "blocked", "body": "Your message was saved, but the AI Council could not answer: ..." } ], "council": { "ok": false } }
```

Notes: Reina's decision reply is always prefixed **"Council discussion finished. Work status: NOT DONE until the machine-enforced completion gate passes."** — the completion-gate labeling is unconditional, regardless of how the debate itself went. The identity used to call the Council is the identity already resolved by this outer handler (the bridge secret maps to an admin identity; a signed-in caller uses their own role) rather than re-derived from headers — the code notes this fixed a bug where the bridge path (no bearer token at all) always silently failed with "AI Council could not answer."

---

### `POST /api/ai-workroom` — `action: "agent_update"`
**Auth:** bridge secret only. Requires an existing `threadId`.
**Purpose:** Let an external agent post its own status/message into the thread.

**Request body / query params:**
- `action` (string, required) — `"agent_update"`
- `threadId` (string, required)
- `author` (string, required) — one of `codex`, `chatgpt`, `claude`, `claude_code`, `grok`, `reina`, `system`
- `body` (string, required, ≤8000 chars)
- `kind` (string, optional)
- `taskState` (string, optional) — one of `queued`, `claimed`, `working`, `blocked`, `done`, `cancelled`
- `metadata` (object, optional)

**Response:**
```json
{ "message": { "id": "...", "author_type": "codex", "author_name": "Codex", "body": "..." } }
```

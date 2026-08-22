# Communication APIs

This covers HiveLogic's communication integrations: mailbox access (`mail.js` + `msmail.js`, serving HiveConnect's in-app mail feature), Twilio phone (`voice.js` + `voice-webhook.js`), the bridge to HiveConnect's separate Supabase project (`hiveconnect-bridge.js`), transactional invite email (`hiveconnect-invite-email.js`), and Reina chat (`chat.js`).

**Note on "email":** this doc covers two unrelated systems that both happen to be about email. `mail.js`/`msmail.js` are the actual mailbox integration (IMAP/SMTP/Graph, reading and sending real mail from a connected account). `hiveconnect-invite-email.js` sends a single transactional email (an invite) via Resend — it has nothing to do with the mailbox integration. Don't conflate the two.

**Note on "Chat":** `api/chat.js` is "Reina," a Claude-powered AI business-data Q&A assistant — read-only, answering questions from Supabase-synced Jobber data. It is not a person-to-person messaging system.

## Email

`msmail.js` is the real Microsoft 365 integration (Graph OAuth, confidential-client code flow). `mail.js` is not Microsoft — it's a generic IMAP/SMTP bridge (Gmail via Google OAuth + XOAUTH2, iCloud/Yahoo/AOL/custom via app password), built as msmail's sibling so non-Microsoft mailboxes plug into the same Graph-shaped frontend. Both require `TOKEN_ENC_KEY` to encrypt stored credentials, and both **fail closed** — refusing to save a connected account — if that key is absent, rather than storing credentials unencrypted.

### `api/mail.js`
Dual-realm `requireUser(req)` (local to the file) verifies the caller's Bearer JWT against either HiveConnect's or HiveLogic's own Supabase `/auth/v1/user`.

- `GET /api/mail?resource=health` — public (no auth) — connection health check.
- `GET /api/mail?resource=goog_callback` — public (OAuth redirect; state is HMAC-signed + nonced instead of a session).
- `POST /api/mail?resource=goog_start` — signed-in user — begins the Google OAuth flow.
- `POST /api/mail?resource=add_account` — signed-in user — connects an IMAP/SMTP account via app password.
- `GET /api/mail?resource=accounts` — signed-in user — lists connected accounts.
- `POST /api/mail?resource=remove_account` — signed-in user — disconnects an account.
- `POST /api/mail?resource=graph` — signed-in user — a Graph-shaped proxy over the connected mailbox: send mail, list mail folders, list a folder's messages, get a single message, get attachments, and PATCH a message's `isRead`/flag state, and move a message between folders.

### `api/msmail.js`
Same dual-realm `requireUser` pattern (separately implemented in this file).

- `GET /api/msmail?resource=health` — public.
- `POST /api/msmail?resource=start` — signed-in user — begins the Microsoft OAuth flow.
- `GET /api/msmail?resource=go` — public (302 redirect into Microsoft's consent screen).
- `GET /api/msmail?resource=callback` — public (OAuth redirect; state HMAC-signed with a single-use claim via `_lib/oauth-state.js`).
- `GET /api/msmail?resource=diag` — signed-in user — connection diagnostics.
- `GET /api/msmail?resource=accounts` — signed-in user — lists connected Microsoft accounts.
- `POST /api/msmail?resource=token` — signed-in user — returns a fresh access token for the connected account.
- `POST /api/msmail?resource=disconnect` — signed-in user — disconnects the account.

### `POST /api/hiveconnect-invite-email`
**Auth:** signed-in HiveConnect admin (`getHiveConnectAdmin(req)`: Bearer JWT verified against HiveConnect's own `/auth/v1/user`, then requires `profiles.role` in `['owner','admin']` and `active === true`).
**Purpose:** Sends a HiveConnect invite email — via Resend (`api/_lib/email.js`), not the M365/IMAP mailbox integration above.

## Voice/Phone

Confirmed Twilio-backed. `voice.js` is the authenticated, member-facing control API (requires `requireUser(req)` for every resource except `GET ?resource=status`, which is deliberately public; admin-gated mutations additionally require `requireVoiceAdmin()` — `profiles.role` or `employee_roles.permission_roles` containing one of `owner`/`partner`/`office_manager`/`systems_pm`). `voice-webhook.js` carries **no user auth at all** — every resource is gated by `verifyTwilioSignature()` (HMAC-SHA1 against `TWILIO_AUTH_TOKEN`, per Twilio's documented algorithm) in the central dispatcher, except two explicitly-exempted, state-mutation-free polling loops (`hold-music`, `queue-wait`) — this is a real, present security control, not a gap.

*A full per-operation request/response breakdown of these two files (~57 resources between them) is a larger pass than this doc currently covers — each is listed below by name, auth, and its evident purpose; exact request/response field shapes should be confirmed against source before building an integration against any specific one.*

### `api/voice.js` (`requireUser` unless noted; ~29 resources)
`status` (public), `extensions`, `numbers`, `schedules`, `greetings`, `greeting_upload`, `blocklist`, `blocklist_remove`, `contact_create`, `contact_link`, `sms`, `calls`, `voicemails`, `voicemail_read`, `voicemail_delete`, `directory`, `token`, `hold`, `transfer`, `call_flow`, `queues`, `queue_status`, `agent_status`, `queue_answer`, `callbacks`, `callback_update`, `call_intelligence`, `call_intelligence_reprocess`, `voice_settings`, `recording_audio` — team extensions/number management, voicemail, SMS, call queues, call-flow/IVR configuration, and AI call-intelligence review.

### `api/voice-webhook.js` (Twilio signature required, except `hold-music`/`queue-wait`; ~28 resources)
`inbound`, `gather`, `recording-status`, `call-transcription`, `intelligence-callback`, `queue-enqueue`, `queue-wait`, `queue-overflow`, `queue-dequeue`, `queue-dequeue-done`, `queue-callback`, `callback-recording`, `callback-transcription`, `flow-node`, `conference-join`, `hold-music`, `agent-leg-status`, `conference-events`, `voicemail-start`, `voicemail-recording`, `transcription`, `status`, `outbound`, `dial-action`, `greeting-pin`, `greeting-pin-check`, `greeting-menu`, `greeting-record-save`, `voicemail-checkin` — most return TwiML (XML) to steer the live call; the fire-and-forget status callbacks just respond `200` with an empty body.

## HiveConnect Bridge

`api/hiveconnect-bridge.js` bridges HiveLogic's own Supabase project to HiveConnect's **separate** Supabase project. It's POST-only for every action, dispatched via `?action=`, with the auth mechanism varying by action:

### `POST /api/hiveconnect-bridge` (`action: "session"`)
**Auth:** signed-in HiveLogic user (`requireUser` from `_lib/auth.js`).
**Purpose:** Mints a HiveConnect session for an already-logged-in HiveLogic user (SSO) — finds or creates a HiveConnect Supabase Auth user by email, upserts a `hiveconnect_account_map` row keyed on the immutable HiveLogic user id, then mints a session via a magic-link `generate_link`/`verify` flow. Never shares a password between the two systems.

### `POST /api/hiveconnect-bridge` (`action: "redeem_invite"`)
**Auth:** none from the caller — the invite token itself is the credential, validated via a HiveConnect RPC.
**Purpose:** Redeems a HiveConnect invite.

### `POST /api/hiveconnect-bridge` (`action: "admin_create_user"` | `"admin_reset_password"`)
**Auth:** `getHiveConnectAdmin(req)` — HiveConnect-side Bearer JWT plus an owner/admin profile-role check.
**Purpose:** HiveConnect-side password-account lifecycle: an admin creates a user or resets a password.

### `POST /api/hiveconnect-bridge` (`action: "bot_provision"` | `"bot_post"` | `"list_channels"`)
**Auth:** a shared secret (`REINA_BOT_SECRET`) compared against `body.secret`.
**Purpose:** Provisions a "Reina bot" identity (a bot auth user + profile + channel membership) and lets it post into HiveConnect channels as that user — used by `voice-webhook.js` for voicemail alerts. Also used to list channels.

Notes: the secret comparison is a plain `===`, not a timing-safe compare — worth flagging, though the surface is internal-only.

### `POST /api/hiveconnect-bridge` (`action: "tasks_list"` | `"task_complete"` | `"task_create"`)
**Auth:** signed-in HiveLogic user (`requireUser`).
**Purpose:** A thin proxy over HiveConnect's Tasks table, used by the HiveLogic Command Center's "Team To-Do" card.

## Chat

### `POST /api/chat`
**Auth:** `verifyRequestUser` from `_lib/auth.js` (Bearer JWT against HiveLogic's Supabase) — with distinct error codes for "this deployment can't verify anyone" (`503 auth_unconfigured`) vs. "you're really signed out" (`401 not_signed_in`), a deliberate UX distinction rather than one generic 401.
**Purpose:** Reina, a Claude-powered AI assistant with tool use (`get_weather`, `get_datetime`, `get_business_data`, `get_financials`) — explicitly read-only against Supabase-synced Jobber data, not a messaging system.

# VoIP Phase 1 — Call Queues (2026-08-02)

Task: `reina-voip-queues-park-intercom-ai-2026-08-02-01`
Branch: `feature/voip-queues-park-intercom-ai` (off `main` @ ff50f19)

## What shipped

A real call-queue system built on Twilio's native `<Enqueue>` / `<Leave>` /
`<Dial><Queue>` (no TaskRouter), all carrier logic confined to
`api/_lib/voice.js` per the architecture rule.

**Decisions locked with Chris:**
- **One general queue** to start (`General`, seeded, `is_default_inbound=true`).
- **Overflow = callback capture** (30s hold → caller leaves name/number/reason
  → transcribed → Claude structures it into a callback request). *Full
  conversational "Reina answers the call" is a separate future phase (the
  deferred AI Attendant), not this.*
- **Recording ON by default** — belongs to Phase 4, not built yet.
- **Phase-by-phase**: this is Phase 1; Chris live-tests before Phase 2.

### Schema — `sql/054_voice_queues.sql` (applied to `hivelogic-live`)
- `voice_queues` (name, ring_order, timeout_seconds, overflow_destination
  extension|voicemail|callback, overflow_extension_id, hold_music_url,
  `is_default_inbound`, provider_queue_sid, active). Partial unique index →
  at most one default-inbound queue.
- `voice_queue_members` (queue_id, extension_id, priority).
- `voice_agent_status` (extension_id unique, status
  available|on_call|on_break|dnd|offline|wrapping_up, status_note).
- `voice_callbacks` (from_number, caller_name, reason, recording_*, transcript,
  ai_summary jsonb, status unassigned|assigned|completed|dismissed, source).
- Seeds one `General` queue. Adds `voice_calls`, `voice_agent_status`,
  `voice_callbacks` to the `supabase_realtime` publication.
- Additive + idempotent (safe to re-run). **Reversible switch:** deactivating
  the General queue reverts the main line to the exact pre-queue behaviour
  (dial-by-extension → voicemail), no code change.

### API — `api/voice.js` (`?resource=`, existing RBAC gate)
- `queues` GET / POST / **PATCH** (admin) — CRUD + membership replace.
- `queue_status` GET — live `{ waiting, longestWaitSeconds, agentsAvailable }`
  per queue, read straight from Twilio (source of truth, never DB counts).
- `agent_status` GET (all + `mineExtensionId`/`mineStatus`) / POST (own; admin
  may set others).
- `queue_answer` POST — rings the requesting agent and bridges to the front
  caller via `<Dial><Queue>`.
- `callbacks` GET / `callback_update` POST (claim / complete / dismiss).

### Webhooks — `api/voice-webhook.js`
- Inbound: when a default-inbound queue is active, a caller who doesn't dial an
  extension drops into it (`queue-enqueue`); otherwise unchanged.
- `queue-wait` (hold-music loop; `<Leave>` once `timeout_seconds` exceeded),
  `queue-overflow` (Enqueue action → callback / voicemail / extension per
  config), `queue-dequeue` + `queue-dequeue-done` (agent bridge),
  `queue-callback` + `callback-recording` + `callback-transcription`
  (overflow capture, mirrors the voicemail transcription→Claude pattern).

### UI — `public/hiveconnect/`
- Replaced the "Queue Overview — Coming Soon" card with a **live Queue
  Overview** (per-queue waiting count, longest-wait timer, agents available,
  **[Answer Next]**).
- Replaced the numbers-as-queues card with a **Callbacks** card (AI-structured
  name/number/reason, **[Call back]** / **[Dismiss]**).
- **Agents** card now shows real presence from `voice_agent_status`.
- **Agent-status toggle in the toolbar** (Available / On break / DND / Offline)
  — replaces the removed "Open Dialer" button (Chris asked it be dropped).
- Live updates: 10s poll + Supabase Realtime subscription (poll is the
  fallback if Realtime/RLS doesn't deliver).

## Verified (in this environment)
- Migration applies cleanly to `hivelogic-live`; all 4 tables + seed + Realtime
  publication confirmed by query.
- Every row shape the code writes was exercised against the live schema
  (agent_status upsert dedupes, queue-status join counts, callback `ai_summary`
  jsonb round-trips) and cleaned up.
- All three API/webhook files and the panel JS pass `node --check`.
- New TwiML verbs (`<Enqueue>`/`<Leave>`/`<Dial><Queue>`) produce well-formed,
  correctly-escaped XML (unit-tested).

## NOT yet verified — needs Chris's live test (Twilio can't be exercised here)
- Real inbound call enters the General queue and hears hold music.
- Overflow at 30s → callback capture → transcript + AI-structured callback row.
- **[Answer Next]** rings the agent's softphone and bridges to the caller.
- Agent-status changes move the "agents available" count live.
- Supabase Realtime actually delivers to the browser (RLS on the voice tables
  is unconfirmed for the anon/authenticated role; the 10s poll covers it
  regardless).

### To test live
1. Deploy the branch (or merge) so the new webhook resources are reachable.
2. Ensure the General queue has at least one member (add ext 103 etc. — a
   members-management UI in VoIP Settings is a fast-follow; for now membership
   can be seeded in SQL or via `POST ?resource=queues` with `members:[...]`).
3. Set your toolbar status to **Available**, call the main line, wait without
   dialing an extension → you should hold; hit **Answer Next** to connect.
4. Let a call sit past 30s → confirm the callback prompt + a row in the
   Callbacks card.

## Known follow-ups (not blockers)
- No queue-membership admin UI yet (VoIP Settings) — membership is API/SQL for
  now. Worth adding before Phase 2 so Chris can staff queues without SQL.
- `on_call` presence is inferred from live calls, not auto-written on
  answer/hangup — accurate for display, but the stored status isn't
  auto-toggled. Fine for Phase 1.

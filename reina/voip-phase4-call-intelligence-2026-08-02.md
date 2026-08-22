# VoIP Phase 4 — Call Recording + AI Call Intelligence (2026-08-02)

Task: `reina-voip-queues-park-intercom-ai-2026-08-02-01`
Branch: `feature/voip-queues-park-intercom-ai`

## What shipped (increment 1)

### Call Recording (real, verifiable on its own)
- `sql/055_voice_call_recording.sql` — `voice_settings` singleton (record_calls
  default **ON**, recording_channels dual, ai_call_summaries default ON,
  optional spoken consent line). Applied to `hivelogic-live`.
- Dual-channel recording added to the three established call paths (inbound →
  extension, dispatch-active, outbound) via a `recordingDialAttrs()` helper on
  the `<Dial>` verbs; `record_calls=false` cleanly removes it.
- `resource=recording-status` webhook stores `recording_sid`/`recording_url` on
  the call and marks the transcript pending.
- **Recordings are playable in Call History** via the new ✨ panel (below) — this
  half is fully functional the moment a call records.

### AI Call Intelligence pipeline
- `api/_lib/call-intelligence.js` (shared by the webhook + admin reprocess):
  `runCallIntelligence(call)` → Claude summarizes the transcript into
  `{summary, intent, sentiment, commitments[], price_scope[], follow_up_needed}`
  and creates **draft actions** (never auto-executed):
  - follow-up needed → a `voice_callbacks` row (`source='ai_call_intelligence'`,
    status unassigned) — fully approvable end-to-end.
  - scope/price → a `change_order` draft (marked *suggested*; creation via the
    change-order engine is increment 2).
  - commitments → a `task` draft (*suggested*; HiveConnect task creation is
    increment 2).
  - draft refs stored on `voice_calls.ai_summary.draft_actions[]`.
- `resource=call-transcription` webhook — accepts a finished transcript (Twilio
  transcription-callback field names, or a Voice Intelligence payload mapped to
  the same shape) → stores it → runs the summary.
- API: `call_intelligence` GET (summary + transcript + drafts),
  `call_intelligence_reprocess` POST (admin), `voice_settings` GET/POST (admin).
- UI: **✨ button on Call History rows** → inline panel with recording playback,
  the AI summary, intent/sentiment/follow-up chips, commitments, and draft
  actions with **[Approve]/[Dismiss]** (Approve on a follow-up claims it + dials
  back).

### Also in this commit (drive-by fixes Chris flagged live)
- **Voicemail delete** — `sql/056_voicemail_soft_delete.sql` adds
  `voice_voicemails.deleted_at`; `voicemail_delete` endpoint (own-VM/admin gate,
  soft delete = recoverable); Delete button on each voicemail card.

## Verified (in this environment)
- Migrations 055 + 056 apply cleanly to `hivelogic-live`.
- `voice_settings` singleton upsert (what the settings toggle uses) maintains one
  row; `voice_callbacks` accepts `source='ai_call_intelligence'` + `ai_summary`
  jsonb (verified in Phase 1).
- All five touched files pass `node --check`.

## NOT verified — needs live test / a decision
- **⚠️ THE TRANSCRIPTION SOURCE IS UNRESOLVED (open decision).** The task assumed
  "same as voicemail," but voicemail uses `<Record transcribe>`, which does NOT
  apply to two-party call recordings. Transcribing recorded calls needs **Twilio
  Voice Intelligence** (paid add-on + a Service SID) or an external STT. Until a
  source is chosen, calls **record and are playable**, but `transcript_status`
  stays `pending` and no AI summary is produced. The pipeline is complete and
  fires the moment a transcript lands (via `call-transcription` or admin
  reprocess) — only the auto-transcribe step is ungated.
- Live: a real recorded call → recording appears + is playable in Call History.
- Live: with a transcript present, `call_intelligence_reprocess` → summary +
  a follow-up callback draft, approvable end-to-end.

### ⚠️ Behavior change on deploy
`record_calls` defaults **ON**, so **every call is recorded starting at deploy**
(Chris's chosen default; login/greeting consent notice already exists). There is
no Settings UI toggle yet — the API (`POST ?resource=voice_settings
{record_calls:false}`) is the off switch. A Settings toggle is the top
follow-up.

## Follow-ups
1. **Pick the transcription source** (Voice Intelligence vs. external STT) — the
   one thing gating auto call summaries.
2. Settings UI: recording on/off + AI-summaries on/off toggles.
3. Increment 2: actually create change-order / HiveConnect-task drafts (not just
   "suggested"); record queue-answered + conference calls too.

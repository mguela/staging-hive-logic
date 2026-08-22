# VoIP Phase 4 — Voice Intelligence transcript source (2026-08-02)

Resolves the open "transcription source" decision from
`voip-phase4-call-intelligence-2026-08-02.md`. Recorded calls are now
transcribed by **Twilio Voice Intelligence**, which then feeds the existing
AI summary + draft-actions pipeline.

## Flow
1. Call records → `recording-status` webhook stores the recording.
2. If Voice Intelligence is configured, it creates a Transcript for that
   recording and stores the Transcript SID on the call
   (`voice_calls.intelligence_transcript_sid`, sql/057).
3. When Twilio finishes, the Service calls `resource=intelligence-callback`
   → we match the call by transcript SID, pull the sentences, store the
   transcript, and run `runCallIntelligence` (summary + draft follow-ups).
4. The ✨ Call History panel shows the summary + drafts.

All Twilio Intelligence REST lives in `api/_lib/voice.js`
(`createCallTranscript`, `getTranscriptStatus`, `fetchTranscriptText`).
If `TWILIO_INTELLIGENCE_SERVICE_SID` is unset, nothing changes — calls still
record and play; transcript stays `pending`.

## Setup Chris must do (one-time)
1. **Twilio Console → Voice Intelligence → Services → Create a Service.**
   Copy its SID (`GA...`).
2. **Vercel → env vars →** add `TWILIO_INTELLIGENCE_SERVICE_SID = GA...`
   (Production). Redeploy.
3. **On that Service**, set the **webhook / status callback URL** to
   `https://hivelogic-live.vercel.app/api/voice-webhook?resource=intelligence-callback`
   (POST). This is what tells us a transcript is ready.
4. (Optional) Enable Voice Intelligence **Language Operators** on the Service if
   you want Twilio-side PII redaction; our summary works with the raw
   transcript regardless.

## Unverified — needs a live recorded call after setup
- The Voice Intelligence webhook signature: we verify it with the standard
  `X-Twilio-Signature` check. If transcripts never arrive after setup, check the
  Vercel logs for a 403 on `intelligence-callback` (signature) — if so, the
  Intelligence webhook signs differently and we exempt/adjust it.
- Channel→speaker mapping (Agent vs Caller) assumes channel 1 = agent on
  dual-channel recordings; confirm on a real transcript and flip if reversed.
- Voice Intelligence is a **paid** Twilio add-on — check per-minute pricing.

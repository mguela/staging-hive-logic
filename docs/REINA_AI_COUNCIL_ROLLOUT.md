# Reina AI Council rollout runbook

The local implementation is complete, but the feature remains off. Activation
requires infrastructure authority and live provider credentials; those actions
are intentionally outside the code-only changes.

## Phase 3: protected preview

1. Confirm a current database backup and the normal Supabase migration rollback
   procedure.
2. Apply `supabase/migrations/20260804210000_reina_ai_council_phase1.sql` through
   the established migration workflow. Verify all five Council RPCs are granted
   only to `service_role` and all five tables have RLS enabled with no client
   grants. Existing installations must also apply
   `supabase/migrations/20260805221000_reina_boardroom_actual_cost_ledger.sql`;
   it backfills completed admissions and reconciles future runs to actual spend.
3. Configure the three provider keys, explicit model IDs, and current input and
   output prices. Never place provider keys in browser-visible configuration.
4. Configure the round, response-token, per-run cost, concurrent-run, and daily
   cost ceilings documented in `.env.example`.
5. Deploy to the protected preview environment with
   `REINA_COUNCIL_ENABLED=true`. Keep production false.
6. As an authenticated admin, open `#/council` and verify readiness. A disabled
   environment must return 404.
7. Ask a harmless ordinary question without evidence. Verify exactly three
   round-zero messages, one prominent Council answer, aggregate token/cost
   usage, the consensus/conflict map, and the complete ordered audit timeline.
8. Repeat with one harmless JPEG/PNG, one small PDF, and one text file. Verify
   all three providers receive read-only context, unsupported binaries are
   rejected, temporary xAI PDF files are cleaned up, and durable records contain
   attachment names/types but no file bytes or extracted text.
9. Retry with the same idempotency key. Verify the existing run is returned and
   provider usage does not increase. Verify a changed body with that key fails.
10. Request `repository_status` for a registered preview agent. Verify the run
   stops at `awaiting_human_approval`; approve it in the UI and verify one typed
   task is queued. Confirm no command, script, arguments, or model content enters
   the task payload.
11. Exercise concurrency and daily cost limits and confirm rejected work opens
    no provider request.

## Phase 4: production rollout

1. Review preview audits, provider bills, latency, errors, and security findings.
2. Confirm emergency-stop behavior and that setting
   `REINA_COUNCIL_ENABLED=false` immediately prevents new Council requests.
3. Apply the reviewed migration and secrets through the normal production change
   process. Start with one concurrent run, one or two rounds, and a conservative
   daily budget.
4. Enable the approved admin cohort, monitor every initial run, and expand only
   after explicit signoff.

## Rollback

Set `REINA_COUNCIL_ENABLED=false` first. This prevents new admissions without
erasing audit records or altering already queued HiveBridge tasks. Pause or
emergency-stop affected agents through existing HiveBridge controls if a queued
task must not be claimed. Preserve Council records for forensic review. Any
schema removal should be a separate reviewed migration, never an ad hoc command.

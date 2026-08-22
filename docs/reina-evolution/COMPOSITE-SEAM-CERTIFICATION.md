# Reina V8 Composite-Seam Certification Gate

Label: **EXECUTABLE COMPOSITE-SEAM GATE - NOT AUTOMATIC PRODUCTION CERTIFICATION**

## Purpose

Run the 40 V7 composite-seam adversarial cases as an **oracle-isolated** executable gate against a real composite candidate (Codex), without modifying V5/V6/V7 behavior.

## Files (incremental V8 only)

| Path | Role |
| --- | --- |
| `test/fixtures/reina-acceptance/reina-composite-seam-acceptance-fixtures.json` | V7 cases preserved byte-for-byte (SHA-256 `1b5129a8...8758`) |
| `test/_support/reina-acceptance/composite-seam-candidate-adapter.mjs` | Oracle-isolated adapter + known-good bridge fake |
| `test/reina-composite-seam-candidate-certification.test.mjs` | Bridge, mutation, dormancy tests |
| `docs/reina-evolution/COMPOSITE-SEAM-CERTIFICATION.md` | This document |

## Oracle isolation

Candidate hooks receive **only**:

```json
{ "preconditions": {}, "stimulus": {} }
```

Never: case ID, seam name, expectedStructuralResult, forbiddenResults, mutation, decisionRequired, fixture metadata.

Runner maps seam -> hook; the hook never sees the seam name.

## Required hooks

1. `actingContextToDurableCore`
2. `durableCoreToConversationEngine`
3. `classifierToEvidenceEnvelope`
4. `jobsSnapshotToConversationKnowledge`
5. `typedPanelToVoiceConversation`

Missing hooks throw `COMPOSITE_SEAM_CALLBACK_MISSING`.
No reference-adapter fallback for production certification.

## Structural checks

- Authorization order / wrong-boundary rejection
- Owner scope (forged, cloned, stale, wrong-owner ActingContext)
- Persistence before model and before saved success
- Deterministic replay / idempotency conflict
- Server-owned history only (client history rejected)
- Evidence / freshness / conflicts / uncertainty / refusal / executed fields
- `executed: false` for pilot
- Safe `textContent` panel output (no trusted HTML / scripts)
- Synthetic/unverified Jobs knowledge labeling; no production claim
- Shared typed/Voice conversation identity
- Duplicate / stale speech suppression
- Speech policy requires **primitive** `true`
- Storage / auth / audit / model / panel / Voice failures never become `savedSuccess`

## Do not invent

- ActingContext maximum age value
- Stale-day threshold
- Confidence threshold
- Schedule certainty
- Source-of-truth policy

Cases with `decisionRequired` only mark that a Chris policy key is needed; the gate does not hardcode the value.

## Known-good vs production

| Mode | Meaning |
| --- | --- |
| Known-good injected fake | Proves bridge contract only |
| Dormant | Default; production cert skipped |
| Armed | `REINA_COMPOSITE_SEAM_CANDIDATE_MODULE` points at Codex export |

```bash
# Bridge + mutations (not production cert)
node --test test/reina-composite-seam-candidate-certification.test.mjs

# Production-candidate certification (Codex composite only)
REINA_COMPOSITE_SEAM_CANDIDATE_MODULE=./codex-composite-seam-hooks.mjs \
  node --test test/reina-composite-seam-candidate-certification.test.mjs
```

Codex must export:

```js
export function createCompositeSeamCandidateHooks() {
  return {
    actingContextToDurableCore,
    durableCoreToConversationEngine,
    classifierToEvidenceEnvelope,
    jobsSnapshotToConversationKnowledge,
    typedPanelToVoiceConversation,
  };
}
```

## Unresolved Chris decisions

- `auth.acting_context_max_age`
- `data.stale_threshold_days`
- `voice.confidence_threshold`
- `ops.schedule_certainty`
- `data.source_of_truth`

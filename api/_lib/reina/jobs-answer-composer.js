// api/_lib/reina/jobs-answer-composer.js
//
// PRODUCTION backend composition seam for Reina's read-only, synthetic Jobs
// answers. This is the single place that executes the exact grounded chain:
//
//   server authorization + enablement
//     -> createJobsReadAdapter().snapshot()   (denial happens BEFORE the loader)
//     -> jobsSnapshotToKnowledge()            (only bounded adapter output enters)
//     -> converse()                           (deterministic interpretation)
//     -> buildEnvelope()                      (canonical reina.answer.v1)
//     -> one canonical written/speech-safe result
//
// It is transport-neutral: typed and spoken callers receive the SAME canonical
// envelope and the SAME safe rendered text from ONE execution.
//
// HARD POSTURE (every point is enforced below, not merely intended):
//   * Authorization and the feature flag are SERVER-OWNED — taken only from the
//     `server` argument, never from the client `request`. The client supplies
//     ONLY plain `utterance` text (+ an optional transport label and inert prior
//     state). No client value can select the loader, source, authorization
//     result, evidence, company, role, capability, tools, or execution status.
//   * Denial occurs before the Jobs loader (guaranteed by the adapter; proven by
//     tests that spy the loader).
//   * It performs and enables NO execution: no action, Automation submission,
//     tool call, communication, schedule change, payment, or mutation. Every
//     envelope carries executed:false and the explicit "nothing was executed"
//     statement.
//   * It does NOT route grounded Jobs answers through PR #80's ungrounded model
//     wrapper — this file does not import api/_lib/reina-conversation.js.
//   * It invents no stale-day / confidence / schedule-certainty / source-of-truth
//     policy — every business string is copied from the pipeline verbatim.
//   * It FAILS CLOSED on any stage failure (disabled, invalid request, auth
//     denied, loader unavailable, malformed snapshot, bridge rejection,
//     classifier miss, envelope build failure, timeout, malformed dependency,
//     accessor/Proxy) — returning a well-formed REFUSAL envelope with a
//     sanitized reason. It never returns a stack trace or echoes caller input.

import { createJobsReadAdapter } from './jobs-read-adapter.js';
import { jobsSnapshotToKnowledge } from './jobs-knowledge-bridge.js';
import { converse } from '../reina-conversation-core.js';
import {
  buildEnvelope, renderPlainText, DATA_CLASS,
} from './evidence-envelope.js';

// Client text is bounded before it ever reaches the pipeline.
const MAX_UTTERANCE = 4000;
// A hard wall-clock ceiling for the whole server-owned pipeline. A dependency
// that hangs is treated as unavailable rather than blocking the request.
const PIPELINE_TIMEOUT_MS = 2000;

// Sanitized, enumerated composer outcomes. These are the ONLY reasons a caller
// ever sees — never an internal message, reason string, or stack.
export const COMPOSER_REASON = Object.freeze({
  DISABLED: 'feature_disabled',
  INVALID_REQUEST: 'invalid_request',
  AUTH_DENIED: 'authorization_denied',
  JOBS_UNAVAILABLE: 'jobs_unavailable',
  ACTION_NOT_PERMITTED: 'action_not_permitted',
  INTERNAL: 'internal_error',
});

const TRANSPORTS = Object.freeze(['typed', 'spoken']);

// Map the adapter's public failure reason -> a sanitized composer reason.
function mapAdapterReason(reason) {
  if (reason === 'adapter_disabled') return COMPOSER_REASON.DISABLED;
  if (reason === 'authorization_denied') return COMPOSER_REASON.AUTH_DENIED;
  if (reason === 'invalid_request') return COMPOSER_REASON.INVALID_REQUEST;
  // no_loader / loader_unavailable / loader_malformed / anything else
  return COMPOSER_REASON.JOBS_UNAVAILABLE;
}

// ---------------------------------------------------------------------------
// Safe own-data reads (defend against accessors / prototype tricks on inputs).
// ---------------------------------------------------------------------------
function ownData(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  let d;
  try { d = Object.getOwnPropertyDescriptor(obj, key); } catch { return undefined; }
  if (!d || typeof d.get === 'function' || typeof d.set === 'function') return undefined;
  return d.value;
}

function safeString(v) {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Envelope construction helpers. Every string is copied from the pipeline; the
// composer invents no fact, threshold, freshness, or policy.
// ---------------------------------------------------------------------------

// A refusal / fail-closed canonical envelope. No evidence, freshness unknown.
function refusalEnvelope(reason, answerText) {
  const built = buildEnvelope({
    answer: answerText,
    refused: true,
    refusalReason: reason,
  });
  // buildEnvelope is fail-closed itself; if the (constant, safe) inputs somehow
  // fail validation we fall back to a minimal hard-coded safe refusal.
  if (built.ok) return built.envelope;
  return null;
}

// A grounded answer envelope built ONLY from bridge/converse output.
function groundedEnvelope(knowledge, response) {
  const now = safeString(ownData(knowledge, 'now'));
  const input = {
    answer: response.directAnswer,
    evidence: [{
      source: 'synthetic-jobs-snapshot',
      sourceType: 'synthetic',
      dataClass: DATA_CLASS.SYNTHETIC,      // synthetic, never authorized_read
      ...(now ? { asOf: now } : {}),
      detail: response.evidence,            // carries the record references verbatim
    }],
    freshness: now
      ? { known: true, asOf: now, note: response.freshness }
      : { known: false, note: response.freshness },
    missingInformation: [response.missingOrConflicting],
    conflictingInformation: [],             // single synthetic snapshot; none invented
    uncertainty: [response.factVsInference],
    refused: false,
  };
  const built = buildEnvelope(input);
  return built.ok ? built.envelope : null;
}

// An honest non-answer (clarify / unknown) — not a refusal, but grounded in no
// facts. Keeps every transparency dimension explicit.
function honestEnvelope(response) {
  const built = buildEnvelope({
    answer: response.directAnswer,
    missingInformation: [response.missingOrConflicting],
    uncertainty: [response.factVsInference],
    refused: false,
  });
  return built.ok ? built.envelope : null;
}

// Last-resort static safe refusal if even buildEnvelope refuses our constants.
// Deep-frozen; carries the same invariants the real envelope guarantees.
function hardFallbackEnvelope(reason) {
  return Object.freeze({
    version: 'reina.answer.v1',
    answer: 'I cannot answer that safely right now.',
    evidence: Object.freeze([]),
    freshness: Object.freeze({ known: false, asOf: null, note: 'Freshness is unknown.' }),
    missingInformation: Object.freeze([]),
    conflictingInformation: Object.freeze([]),
    uncertainty: Object.freeze([]),
    refused: true,
    refusalReason: reason,
    executed: false,
    executionStatement:
      'Nothing was executed. This is a read-only answer; no action was taken and no data was changed.',
  });
}

// Assemble the final, transport-agnostic result. `text` is identical for typed
// and spoken transports — both are the plain-text, speech-safe rendering of the
// SAME canonical envelope.
function result(transport, kind, envelope, reason) {
  const safeEnvelope = envelope || hardFallbackEnvelope(reason || COMPOSER_REASON.INTERNAL);
  let text;
  try { text = renderPlainText(safeEnvelope); } catch { text = safeEnvelope.answer || ''; }
  return Object.freeze({
    ok: !safeEnvelope.refused,
    transport,
    kind,
    envelope: safeEnvelope,
    text,
    ...(reason ? { reason } : {}),
  });
}

// Run an async step under the pipeline timeout; a hang resolves to a rejection
// the caller treats as "unavailable" (never a hung request, never knowledge).
function withTimeout(promise) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ __timedOut: true }), PIPELINE_TIMEOUT_MS);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); done({ value: v }); },
      () => { clearTimeout(timer); done({ __failed: true }); },
    );
  });
}

// ---------------------------------------------------------------------------
// Public composer.
// ---------------------------------------------------------------------------
/**
 * Execute the read-only synthetic Jobs answer chain and return one canonical
 * result usable by BOTH typed and spoken transports.
 *
 * @param {object} request  CLIENT input. Only these fields are read:
 *   - utterance {string}   the user's plain text (required, bounded)
 *   - transport {'typed'|'spoken'}  optional label; does NOT change content
 *   - state {object}       optional inert prior conversation state (no authority)
 *   Any other field on `request` (authorization, company, role, loader, source,
 *   evidence, tools, executed, …) is IGNORED — the client cannot select them.
 *
 * @param {object} server  SERVER-OWNED dependencies (never from the client):
 *   - enabled {boolean}    server feature flag (required true to proceed)
 *   - authorize {function} server authorization decision provider
 *   - loader {function}    server synthetic Jobs loader
 *   - limit {number}       optional server-chosen row limit
 *   - maxRows / allowedFields  optional adapter bounds
 *
 * @returns {Promise<{ ok, transport, kind, envelope, text, reason? }>}
 *   Always resolves with a well-formed canonical envelope + safe text. On any
 *   failure it FAILS CLOSED to a refusal envelope with a sanitized reason.
 */
export async function composeReinaJobsAnswer(request, server) {
  // Choose transport up-front (pure label; identical content either way).
  const reqTransport = safeString(ownData(request, 'transport'));
  const transport = TRANSPORTS.includes(reqTransport) ? reqTransport : 'typed';

  try {
    // ---- 1) Client input: ONLY the utterance (bounded). ------------------
    const rawUtterance = ownData(request, 'utterance');
    if (typeof rawUtterance !== 'string' || rawUtterance.trim() === '') {
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.INVALID_REQUEST, 'I need a question to answer.'), COMPOSER_REASON.INVALID_REQUEST);
    }
    if (rawUtterance.length > MAX_UTTERANCE) {
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.INVALID_REQUEST, 'That request is too long to process.'), COMPOSER_REASON.INVALID_REQUEST);
    }
    const utterance = rawUtterance;
    const priorState = ownData(request, 'state'); // inert context only

    // ---- 2) Server-owned enablement. -------------------------------------
    if (ownData(server, 'enabled') !== true) {
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.DISABLED, 'Reina Jobs answers are not enabled.'), COMPOSER_REASON.DISABLED);
    }
    const authorize = ownData(server, 'authorize');
    const loader = ownData(server, 'loader');
    if (typeof authorize !== 'function' || typeof loader !== 'function') {
      // Missing server dependency -> fail closed, never fabricate.
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.JOBS_UNAVAILABLE, 'Jobs data is unavailable right now.'), COMPOSER_REASON.JOBS_UNAVAILABLE);
    }

    // ---- 3) Adapter construction is SERVER-OWNED here. authorize + loader +
    //         enabled come from `server`; the client contributes nothing. The
    //         adapter enforces denial-before-loader internally.
    const adapter = createJobsReadAdapter({
      enabled: true,
      authorize,
      loader,
      ...(Number.isSafeInteger(ownData(server, 'maxRows')) ? { maxRows: ownData(server, 'maxRows') } : {}),
      ...(Array.isArray(ownData(server, 'allowedFields')) ? { allowedFields: ownData(server, 'allowedFields') } : {}),
    });

    // Server-chosen limit only (never a client value).
    const serverLimit = ownData(server, 'limit');
    const snapshotInput = Number.isSafeInteger(serverLimit) && serverLimit > 0 ? { limit: serverLimit } : {};

    // ---- 4) Snapshot (bounded by the adapter). Under a hard timeout. ------
    const snapOutcome = await withTimeout(adapter.snapshot(snapshotInput));
    if (snapOutcome.__timedOut || snapOutcome.__failed) {
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.JOBS_UNAVAILABLE, 'Jobs data is unavailable right now.'), COMPOSER_REASON.JOBS_UNAVAILABLE);
    }
    const snapshot = snapOutcome.value;
    if (!snapshot || ownData(snapshot, 'ok') !== true) {
      const reason = mapAdapterReason(safeString(ownData(snapshot, 'reason')));
      const msg = reason === COMPOSER_REASON.AUTH_DENIED
        ? 'You are not authorized to view this Jobs data.'
        : reason === COMPOSER_REASON.DISABLED
          ? 'Reina Jobs answers are not enabled.'
          : 'Jobs data is unavailable right now.';
      return result(transport, 'refusal', refusalEnvelope(reason, msg), reason);
    }

    // ---- 5) Only the bounded snapshot enters the bridge. -----------------
    const bridged = jobsSnapshotToKnowledge(snapshot);
    if (!bridged || bridged.ok !== true) {
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.JOBS_UNAVAILABLE, 'Jobs data could not be prepared for an answer.'), COMPOSER_REASON.JOBS_UNAVAILABLE);
    }
    const knowledge = bridged.knowledge;

    // ---- 6) Deterministic interpretation. No model, no tools, no execution.
    const conversed = converse({ utterance, knowledge, state: priorState });
    const response = conversed && conversed.response;
    if (!response || typeof response !== 'object' || typeof response.directAnswer !== 'string' || response.executed !== false) {
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.INTERNAL, 'I could not produce a safe answer.'), COMPOSER_REASON.INTERNAL);
    }

    // ---- 7) Map interpretation -> canonical envelope. --------------------
    const kind = response.kind;
    let envelope;
    let outKind;
    let outReason;
    if (kind === 'answer' || kind === 'followup') {
      envelope = groundedEnvelope(knowledge, response);
      outKind = 'answer';
    } else if (kind === 'refusal' || kind === 'fail_closed') {
      envelope = refusalEnvelope(COMPOSER_REASON.ACTION_NOT_PERMITTED, response.directAnswer);
      outKind = 'refusal';
      outReason = COMPOSER_REASON.ACTION_NOT_PERMITTED;
    } else {
      // clarify / unknown -> honest non-answer (not a refusal).
      envelope = honestEnvelope(response);
      outKind = 'honest';
    }
    if (!envelope) {
      return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.INTERNAL, 'I could not produce a safe answer.'), COMPOSER_REASON.INTERNAL);
    }

    // ---- 8) One canonical result for both transports. --------------------
    return result(transport, outKind, envelope, outReason);
  } catch {
    // Catastrophic failure: never leak a stack or echo input.
    return result(transport, 'refusal', refusalEnvelope(COMPOSER_REASON.INTERNAL, 'I could not process that request.'), COMPOSER_REASON.INTERNAL);
  }
}

// Exposed for focused unit testing of the pure mapping (no live pipeline).
export const _internals = Object.freeze({ groundedEnvelope, refusalEnvelope, honestEnvelope, mapAdapterReason, ownData });

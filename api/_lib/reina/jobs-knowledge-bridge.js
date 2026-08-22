// api/_lib/reina/jobs-knowledge-bridge.js
//
// The smallest safe bridge between the hardened, DISABLED Jobs read adapter
// (PR #64, api/_lib/reina/jobs-read-adapter.js) and Reina's pure conversation
// core (PR #67, api/_lib/reina-conversation-core.js).
//
// It does exactly one thing: take a snapshot that the adapter ALREADY produced
// and validated, re-validate that it is the exact successful shape, and project
// its inert facts into the bounded, data-only `knowledge` object that
// `converse()` consumes. It never runs the adapter, never loads data, never
// decides authorization, and never activates anything.
//
// Trust model:
//   - The incoming snapshot is DATA, never authority. Even a perfectly-formed
//     snapshot grants no company, role, capability, tool, or execution power;
//     the bridge strips every identity/authority signal and never re-emits one.
//   - The snapshot is treated as hostile until proven to be the exact PR #64
//     success shape. Anything else fails closed with a sanitized reason.
//   - The output is deeply frozen, bounded, data-only, explicitly synthetic and
//     unverified, and marked executed:false. It cannot instruct the core to do
//     anything — it only supplies facts the core may quote verbatim.
//
// Non-invention rules (enforced by construction — the bridge only ECHOES facts):
//   - No stale-day threshold is applied; freshness is the snapshot's own as-of
//     time, verbatim, with staleness explicitly "not judged here".
//   - No confidence percentage, no schedule-certainty claim, no source-of-truth
//     policy is produced. Booleans on the records (onHold / missingInfo) are the
//     records' own flags, echoed as-is, not thresholds the bridge invented.
//
// This file imports only `node:util` (for robust Proxy/Promise detection). It
// imports no route, database, Supabase client, model, UI, Automation, or
// environment state, and it reads no `process.env`.

import { types as nodeTypes } from 'node:util';

// ---------------------------------------------------------------------------
// Shape contract — the EXACT successful PR #64 snapshot (default allowedFields).
// ---------------------------------------------------------------------------
const SNAPSHOT_FIELDS = Object.freeze(['ok', 'disabled', 'denied', 'kind', 'count', 'jobs', 'provenance', 'bounded']);
const JOB_FIELDS = Object.freeze(['jobNumber', 'status', 'stage', 'scheduleStart', 'scheduleEnd', 'onHold', 'missingInfo', 'source', 'asOf', 'state']);
const PROVENANCE_FIELDS = Object.freeze(['source', 'asOf', 'state', 'recordRefs']);
const BOUNDED_FIELDS = Object.freeze(['maxRows', 'requested', 'applied']);

const SNAPSHOT_KIND = 'jobs_snapshot';
const SYNTHETIC_SOURCE = 'synthetic';
const UNVERIFIED_STATE = 'unverified';
const VALID_STATUS = 'open';
const VALID_STAGE = 'prep';

// Bounds — mirror the adapter's own hard ceiling so a snapshot that somehow
// exceeds it is rejected rather than projected.
const HARD_MAX_JOBS = 200;
const MAX_STRING = 4096;         // any snapshot string longer than this is hostile
const MAX_FIELD = 4000;          // core's per-field ceiling; keep every emitted field under it
const MAX_LISTED_REFS = 20;      // record refs listed inline in evidence text
const MAX_LISTED_JOBS = 30;      // job numbers listed inline in prose
const MAX_ATTENTION_REFS = 50;   // bound on the attentionJobRefs list we emit

const JOB_NUMBER_RE = /^DEMO-[0-9]{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RECORD_REF_RE = /^synthetic-job:v1:[0-9a-f]{64}$/;
// Any hint of markup, script, handlers, dangerous URIs, or control characters
// (control-char class written with \u escapes so the source stays plain ASCII).
const UNSAFE_RE = /[<>]|javascript:|vbscript:|data:text\/html|on\w+\s*=|[\u0000-\u001f\u007f]/i;

export const BRIDGE_REASON = Object.freeze({
  NOT_SUCCESSFUL: 'not_successful_snapshot',
  MALFORMED: 'malformed_snapshot',
  MALFORMED_PROVENANCE: 'malformed_provenance',
  MISSING_MARKINGS: 'missing_markings',
  BOUNDS_EXCEEDED: 'bounds_exceeded',
  UNSAFE_CONTENT: 'unsafe_content',
});

// ---------------------------------------------------------------------------
// Hostile-object hardening. Every read is an OWN DATA property read; accessors,
// inherited properties, Proxies, Promises, functions, and exotic prototypes are
// rejected, never evaluated.
// ---------------------------------------------------------------------------
function isProxy(value) {
  try {
    return nodeTypes.isProxy(value);
  } catch {
    return true; // if even the check throws, treat as hostile
  }
}

function isForbiddenValue(value) {
  if (value === null) return false;
  const t = typeof value;
  if (t === 'function') return true;
  if (t === 'object') {
    if (isProxy(value)) return true;
    if (nodeTypes.isPromise(value)) return true;
  }
  return false;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Capture the exact own-data properties of `value`; the own string keys must
// equal `expectedKeys` exactly (no missing, no extra, no symbol keys). Accessor
// props, non-enumerable props, functions/Proxies/Promises as values, and
// inherited props all cause rejection. Returns a frozen null-proto copy or null.
function captureExact(value, expectedKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out = Object.create(null);
    for (let i = 0; i < expectedKeys.length; i += 1) {
      const key = expectedKeys[i];
      const d = descriptors[key];
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return null;
      if (isForbiddenValue(d.value)) return null;
      out[key] = d.value;
    }
    // Reject any own key that is not in the expected set (incl. symbols).
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (typeof k !== 'string' || !expectedKeys.includes(k)) return null;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

// Capture a dense, real Array of at most `maximum` items. The only own keys may
// be the contiguous indices 0..len-1 and `length`; anything else (extra own
// props, holes, accessors, method overrides, wrong prototype, Proxy) rejects.
function captureDenseArray(value, maximum) {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) return null;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1) return null; // exactly indices + 'length'
    const out = new Array(length);
    for (let i = 0; i < length; i += 1) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return null;
      if (isForbiddenValue(d.value)) return null;
      out[i] = d.value;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function canonicalDate(value) {
  if (typeof value !== 'string' || value.length !== 10 || !DATE_RE.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Snapshot validation — accept ONLY the exact successful PR #64 shape.
// ---------------------------------------------------------------------------
function reject(reason) {
  return Object.freeze({ ok: false, reason });
}

// Returns { ok:true, jobs:[{jobNumber,onHold,missingInfo,scheduleStart,scheduleEnd}],
//           refs:[...], asOf } after full validation, or a reject() result.
function validateSnapshot(snapshot) {
  const env = captureExact(snapshot, SNAPSHOT_FIELDS);
  if (!env) return reject(BRIDGE_REASON.MALFORMED);

  // Must be an explicit SUCCESS envelope — never a denied/failed/disabled one.
  if (env.ok !== true || env.disabled !== false || env.denied !== false || env.kind !== SNAPSHOT_KIND) {
    return reject(BRIDGE_REASON.NOT_SUCCESSFUL);
  }
  if (!Number.isSafeInteger(env.count) || env.count < 0 || env.count > HARD_MAX_JOBS) {
    return reject(BRIDGE_REASON.BOUNDS_EXCEEDED);
  }

  // bounded — validate the exact shape even though we do not re-emit it.
  const bounded = captureExact(env.bounded, BOUNDED_FIELDS);
  if (!bounded
    || !Number.isSafeInteger(bounded.maxRows) || bounded.maxRows <= 0 || bounded.maxRows > HARD_MAX_JOBS
    || !(bounded.requested === null || (Number.isSafeInteger(bounded.requested) && bounded.requested > 0))
    || !Number.isSafeInteger(bounded.applied) || bounded.applied < 0 || bounded.applied > HARD_MAX_JOBS) {
    return reject(BRIDGE_REASON.MALFORMED);
  }

  // provenance — freshness + synthetic/unverified markings + record refs.
  const prov = captureExact(env.provenance, PROVENANCE_FIELDS);
  if (!prov) return reject(BRIDGE_REASON.MALFORMED_PROVENANCE);
  if (prov.source !== SYNTHETIC_SOURCE || prov.state !== UNVERIFIED_STATE) {
    return reject(BRIDGE_REASON.MISSING_MARKINGS);
  }
  if (typeof prov.asOf !== 'string' || prov.asOf.length < 20 || prov.asOf.length > 24 || !TIMESTAMP_RE.test(prov.asOf)) {
    return reject(BRIDGE_REASON.MISSING_MARKINGS);
  }

  const jobsRaw = captureDenseArray(env.jobs, HARD_MAX_JOBS);
  const refsRaw = captureDenseArray(prov.recordRefs, HARD_MAX_JOBS);
  if (!jobsRaw || !refsRaw) return reject(BRIDGE_REASON.MALFORMED);
  if (jobsRaw.length !== env.count || refsRaw.length !== jobsRaw.length) return reject(BRIDGE_REASON.MALFORMED);

  const jobs = new Array(jobsRaw.length);
  const refs = new Array(refsRaw.length);
  const seenRefs = new Set();
  const seenJobs = new Set();
  for (let i = 0; i < jobsRaw.length; i += 1) {
    const row = captureExact(jobsRaw[i], JOB_FIELDS);
    if (!row) return reject(BRIDGE_REASON.MALFORMED);

    // Per-record synthetic/unverified markings + freshness consistency.
    if (row.source !== SYNTHETIC_SOURCE || row.state !== UNVERIFIED_STATE) return reject(BRIDGE_REASON.MISSING_MARKINGS);
    if (row.asOf !== prov.asOf) return reject(BRIDGE_REASON.MALFORMED_PROVENANCE);

    // Constrained fact values — no free-form text can exist in a valid row.
    if (typeof row.jobNumber !== 'string' || row.jobNumber.length > 17 || !JOB_NUMBER_RE.test(row.jobNumber)) return reject(BRIDGE_REASON.MALFORMED);
    if (UNSAFE_RE.test(row.jobNumber)) return reject(BRIDGE_REASON.UNSAFE_CONTENT); // defense in depth
    if (row.status !== VALID_STATUS || row.stage !== VALID_STAGE) return reject(BRIDGE_REASON.MALFORMED);
    if (!canonicalDate(row.scheduleStart) || !canonicalDate(row.scheduleEnd) || row.scheduleEnd < row.scheduleStart) return reject(BRIDGE_REASON.MALFORMED);
    if (typeof row.onHold !== 'boolean' || typeof row.missingInfo !== 'boolean') return reject(BRIDGE_REASON.MALFORMED);

    const ref = refsRaw[i];
    if (typeof ref !== 'string' || ref.length > MAX_STRING || !RECORD_REF_RE.test(ref)) return reject(BRIDGE_REASON.MALFORMED_PROVENANCE);
    if (seenRefs.has(ref) || seenJobs.has(row.jobNumber)) return reject(BRIDGE_REASON.MALFORMED_PROVENANCE);
    seenRefs.add(ref);
    seenJobs.add(row.jobNumber);

    jobs[i] = { jobNumber: row.jobNumber, onHold: row.onHold, missingInfo: row.missingInfo, scheduleStart: row.scheduleStart, scheduleEnd: row.scheduleEnd };
    refs[i] = ref;
  }

  return { ok: true, jobs, refs, asOf: prov.asOf };
}

// ---------------------------------------------------------------------------
// Fact -> knowledge projection. Every emitted string is built from constants +
// already-validated tokens; nothing here invents a business fact or threshold.
// ---------------------------------------------------------------------------
const SYNTHETIC_NOTE = 'These are synthetic, unverified facts; a person confirms anything real outside this preview.';
const DID_NOT_DO = 'Did not run the Jobs loader, make any authorization decision, call a model/route/database/tool, change records, or execute anything.';
const FACT_ONLY = 'Fact: quoted verbatim from a synthetic, unverified Jobs snapshot. Inference: none — no thresholds, confidence, schedule certainty, or source-of-truth policy are asserted.';

function listOrNone(items, max) {
  if (!items.length) return 'none';
  if (items.length <= max) return items.join(', ');
  return items.slice(0, max).join(', ') + `, (+${items.length - max} more)`;
}

function makeRecord(promptId, promptText, answer, extra) {
  const rec = {
    promptId,
    prompt: promptText,
    answer,
    factOrInference: FACT_ONLY,
    evidence: extra.evidence,
    freshness: extra.freshness,
    missingOrConflicting: extra.missingOrConflicting,
    safeRecommendation: SYNTHETIC_NOTE,
    whatReinaDidNotDo: DID_NOT_DO,
  };
  // Guard the core's per-field ceiling; a valid bounded snapshot cannot breach
  // it, but truncating defensively keeps the output provably compatible.
  for (const k of ['answer', 'evidence', 'freshness', 'missingOrConflicting']) {
    if (typeof rec[k] === 'string' && rec[k].length > MAX_FIELD) rec[k] = rec[k].slice(0, MAX_FIELD);
  }
  return rec;
}

function project(validated) {
  const { jobs, refs, asOf } = validated;
  const total = jobs.length;
  const onHold = jobs.filter((j) => j.onHold === true).map((j) => j.jobNumber);
  const missing = jobs.filter((j) => j.missingInfo === true).map((j) => j.jobNumber);
  const attention = [];
  for (const j of jobs) {
    if ((j.onHold === true || j.missingInfo === true) && attention.indexOf(j.jobNumber) === -1) attention.push(j.jobNumber);
  }

  const freshness = `Synthetic snapshot, marked as of ${asOf} (source ${SYNTHETIC_SOURCE}, state ${UNVERIFIED_STATE}). Staleness is not judged here; no stale-day threshold is applied.`;
  const evidence = total
    ? `Synthetic, unverified record references (${refs.length}): ${listOrNone(refs, MAX_LISTED_REFS)}.`
    : 'No records in this synthetic snapshot; no record references to cite.';
  const conflictsNote = 'This is a single synthetic snapshot representing one source; no source conflict is represented, and none is inferred.';

  const prompts = [
    makeRecord(1, 'What needs attention?',
      total
        ? `This synthetic snapshot has ${total} job(s). Flagged (on hold or missing info): ${listOrNone(attention, MAX_LISTED_JOBS)}. On hold: ${onHold.length}; missing info: ${missing.length}.`
        : 'This synthetic snapshot contains no jobs.',
      { evidence, freshness, missingOrConflicting: `Flagged missing info: ${listOrNone(missing, MAX_LISTED_JOBS)}. ${conflictsNote}` }),

    makeRecord(2, 'What is blocking these jobs?',
      onHold.length
        ? `Marked on hold in this synthetic snapshot: ${listOrNone(onHold, MAX_LISTED_JOBS)}. "On hold" is the record's own flag; no blocking reason is asserted.`
        : 'No jobs are marked on hold in this synthetic snapshot.',
      { evidence, freshness, missingOrConflicting: conflictsNote }),

    makeRecord(3, 'Is any data stale?',
      `This synthetic snapshot is marked as of ${asOf}. Whether that is "stale" is not judged here — no stale-day threshold is applied.`,
      { evidence, freshness, missingOrConflicting: conflictsNote }),

    makeRecord(4, 'Do the sources disagree?',
      conflictsNote,
      { evidence, freshness, missingOrConflicting: conflictsNote }),

    makeRecord(5, 'What information is missing?',
      missing.length
        ? `Flagged as missing information in this synthetic snapshot: ${listOrNone(missing, MAX_LISTED_JOBS)}.`
        : 'No jobs are flagged as missing information in this synthetic snapshot.',
      { evidence, freshness, missingOrConflicting: `${missing.length} job(s) flagged missing info. ${conflictsNote}` }),

    makeRecord(7, 'Show the evidence.',
      total
        ? `Evidence is the synthetic, unverified record reference for each of the ${total} job(s).`
        : 'There is no evidence to show; the synthetic snapshot contains no jobs.',
      { evidence, freshness, missingOrConflicting: conflictsNote }),
  ];

  const attentionJobRefs = attention.slice(0, MAX_ATTENTION_REFS);

  // The bounded, data-only knowledge object. It carries facts only; it names no
  // company, role, capability, tool, principal, or scope, and it cannot instruct
  // the core to act. Extra marker fields are inert (converse ignores them).
  return {
    kind: 'reina_jobs_knowledge',
    source: SYNTHETIC_SOURCE,
    state: UNVERIFIED_STATE,
    synthetic: true,
    verified: false,
    executed: false,
    now: asOf,
    prompts,
    attentionJobRefs,
    notice: 'Synthetic, unverified Jobs knowledge for a read-only conversation preview. Grants no authority. Nothing was executed.',
  };
}

// ---------------------------------------------------------------------------
// Deep freeze — the whole output graph is immutable before it leaves.
// ---------------------------------------------------------------------------
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) deepFreeze(value[i]);
    return Object.freeze(value);
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) deepFreeze(value[keys[i]]);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// Public API — a single pure, transport-neutral projection.
// ---------------------------------------------------------------------------
/**
 * Convert a successfully-validated PR #64 Jobs snapshot into the bounded,
 * data-only `knowledge` object PR #67's `converse()` consumes.
 *
 * Pure and transport-neutral: it inspects `snapshot` as inert data, never runs
 * the adapter/loader, never decides authorization, and never mutates its input.
 *
 * @param {object} snapshot  the object returned by the adapter's snapshot()
 * @returns {{ ok:true, knowledge:object } | { ok:false, reason:string }}
 *          On success, `knowledge` is deeply frozen, bounded, data-only,
 *          explicitly synthetic/unverified, and `executed:false`. On any
 *          problem it FAILS CLOSED with a sanitized `reason` (see BRIDGE_REASON)
 *          and no `knowledge`.
 */
export function jobsSnapshotToKnowledge(snapshot) {
  const validated = validateSnapshot(snapshot);
  if (!validated.ok) return validated; // already a frozen reject()
  const knowledge = deepFreeze(project(validated));
  return Object.freeze({ ok: true, knowledge });
}

// Exposed for unit testing of the validators in isolation.
export const _internals = Object.freeze({ validateSnapshot, captureExact, captureDenseArray, isForbiddenValue, canonicalDate });

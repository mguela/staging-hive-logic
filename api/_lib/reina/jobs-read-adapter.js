import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

// Disabled, synthetic-only Jobs snapshot boundary. Nothing in this module
// discovers company membership, opens a route, or reaches live data.
const OPERATION = 'reina.jobs.snapshot.disabled';
const CAPABILITY = 'reina:jobs:read';
const AUTHORIZATION_TIMEOUT_MS = 1000;
const LOADER_TIMEOUT_MS = 1000;

const SAFE_FIELDS = Object.freeze([
  'jobNumber',
  'status',
  'stage',
  'scheduleStart',
  'scheduleEnd',
  'onHold',
  'missingInfo',
  'source',
  'asOf',
  'state',
]);
const ROW_FIELDS = Object.freeze([
  'jobNumber',
  'status',
  'stage',
  'scheduleStart',
  'scheduleEnd',
  'onHold',
  'missingInfo',
]);
const CONFIG_FIELDS = Object.freeze(['enabled', 'loader', 'authorize', 'maxRows', 'allowedFields']);
const AUTHORIZATION_FIELDS = Object.freeze([
  'allowed',
  'operation',
  'capability',
  'companyScoped',
  'companyAuthorityVerified',
  'principalId',
  'companyId',
  'scopeRef',
]);
const ENVELOPE_FIELDS = Object.freeze(['ok', 'partial', 'denied', 'error', 'jobs', 'provenance']);
const PROVENANCE_FIELDS = Object.freeze(['source', 'asOf', 'state', 'companyId', 'scopeRef', 'recordRefs']);

const DEFAULT_MAX_ROWS = 25;
const HARD_MAX_ROWS = 200;
const MAX_ALLOWED_FIELD_INPUTS = 64;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SCOPE_LENGTH = 256;
const SYNTHETIC_SOURCE = 'synthetic';
const SYNTHETIC_STATE = 'unverified';
const RECORD_REF_PREFIX = 'synthetic-job:v1:';
const VALID_STATUS = 'open';
const VALID_STAGE = 'prep';

const PUBLIC_REASON = Object.freeze({
  disabled: 'adapter_disabled',
  invalidRequest: 'invalid_request',
  authorizationDenied: 'authorization_denied',
  noLoader: 'no_loader',
  unavailable: 'loader_unavailable',
  malformed: 'loader_malformed',
});

const AUTHORIZATION_REQUEST = Object.freeze({
  operation: OPERATION,
  capability: CAPABILITY,
  companyScoped: true,
  consequential: false,
  tool: false,
});

const TIMEOUT = Symbol('authorization_timeout');
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const JOB_NUMBER_RE = /^DEMO-[0-9]{1,12}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SYSTEM_NOW = Date.now.bind(Date);
const NATIVE_PROMISE = Promise;
const NATIVE_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const ARRAY_METHOD_KEYS = Object.freeze([
  'slice',
  'map',
  'forEach',
  'filter',
  'reduce',
  'values',
  'entries',
  'keys',
  Symbol.iterator,
]);

function isProxy(value) {
  try {
    return nodeTypes.isProxy(value);
  } catch {
    return true;
  }
}

function hasExpectedKey(expected, key) {
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] === key) return true;
  }
  return false;
}

function approvedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Capture exact own data properties once. Accessor values are never evaluated.
function captureExactRecord(value, expectedKeys) {
  try {
    if (!approvedRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) return null;
    for (let i = 0; i < keys.length; i += 1) {
      if (typeof keys[i] !== 'string' || !hasExpectedKey(expectedKeys, keys[i])) return null;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const captured = Object.create(null);
    for (let i = 0; i < expectedKeys.length; i += 1) {
      const key = expectedKeys[i];
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureConfig(config) {
  if (config === undefined || config === null) return Object.freeze(Object.create(null));
  try {
    if (!approvedRecord(config)) return null;
    const keys = Reflect.ownKeys(config);
    const descriptors = Object.getOwnPropertyDescriptors(config);
    const captured = Object.create(null);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key !== 'string' || !hasExpectedKey(CONFIG_FIELDS, key)) return null;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

// Loader/config arrays are captured without invoking their methods or iterator.
function captureDenseArray(value, maximumLength) {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) return null;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) return null;

    // Do not enumerate loader-owned keys: an array can carry millions of extra
    // properties even when its length is small. Inspect only the bounded dense
    // indexes and the methods this boundary must never delegate to.
    const captured = new Array(length);
    for (let i = 0; i < length; i += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      captured[i] = descriptor.value;
    }
    for (let i = 0; i < ARRAY_METHOD_KEYS.length; i += 1) {
      if (Object.getOwnPropertyDescriptor(value, ARRAY_METHOD_KEYS[i])) return null;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function boundedIdentifier(value, maximumLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && IDENTIFIER_RE.test(value);
}

function canonicalDate(value) {
  if (typeof value !== 'string' || value.length !== 10) return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function canonicalTimestamp(value, observedAt) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 24 || !TIMESTAMP_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = new Date(milliseconds).toISOString();
  return milliseconds <= observedAt
    && (value === normalized || (normalized.endsWith('.000Z') && value === normalized.replace('.000Z', 'Z')));
}

function expectedRecordRef(authorization, jobNumber) {
  return `${RECORD_REF_PREFIX}${createHash('sha256')
    .update(OPERATION)
    .update('\0')
    .update(authorization.companyId)
    .update('\0')
    .update(authorization.scopeRef)
    .update('\0')
    .update(jobNumber)
    .digest('hex')}`;
}

function validRowValues(row) {
  return typeof row.jobNumber === 'string'
    && row.jobNumber.length >= 6
    && row.jobNumber.length <= 17
    && JOB_NUMBER_RE.test(row.jobNumber)
    && row.status === VALID_STATUS
    && row.stage === VALID_STAGE
    && canonicalDate(row.scheduleStart)
    && canonicalDate(row.scheduleEnd)
    && row.scheduleEnd >= row.scheduleStart
    && typeof row.onHold === 'boolean'
    && typeof row.missingInfo === 'boolean';
}

function normalizeAuthorization(value) {
  const decision = captureExactRecord(value, AUTHORIZATION_FIELDS);
  if (!decision) return null;
  if (decision.allowed !== true
    || decision.operation !== OPERATION
    || decision.capability !== CAPABILITY
    || decision.companyScoped !== true
    || decision.companyAuthorityVerified !== true
    || !boundedIdentifier(decision.principalId, MAX_IDENTIFIER_LENGTH)
    || !boundedIdentifier(decision.companyId, MAX_IDENTIFIER_LENGTH)
    || !boundedIdentifier(decision.scopeRef, MAX_SCOPE_LENGTH)) return null;
  return decision;
}

function sameAuthorization(first, second) {
  return second !== null
    && first.allowed === second.allowed
    && first.operation === second.operation
    && first.capability === second.capability
    && first.companyScoped === second.companyScoped
    && first.companyAuthorityVerified === second.companyAuthorityVerified
    && first.principalId === second.principalId
    && first.companyId === second.companyId
    && first.scopeRef === second.scopeRef;
}

function normalizeInput(input, maxRows) {
  if (input === undefined) return Object.freeze({ requested: null, applied: maxRows });
  try {
    if (!approvedRecord(input)) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length === 0) return Object.freeze({ requested: null, applied: maxRows });
    if (keys.length !== 1 || keys[0] !== 'limit') return null;
    const descriptor = Object.getOwnPropertyDescriptor(input, 'limit');
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    const limit = descriptor.value;
    if (!Number.isSafeInteger(limit) || limit <= 0) return null;
    return Object.freeze({ requested: limit, applied: Math.min(limit, maxRows) });
  } catch {
    return null;
  }
}

function normalizeAllowedFields(configured) {
  if (configured === undefined) return SAFE_FIELDS;
  const values = captureDenseArray(configured, MAX_ALLOWED_FIELD_INPUTS);
  if (!values) return null;
  const allowed = [];
  for (let i = 0; i < SAFE_FIELDS.length; i += 1) {
    const safeField = SAFE_FIELDS[i];
    for (let j = 0; j < values.length; j += 1) {
      if (values[j] === safeField) {
        allowed[allowed.length] = safeField;
        break;
      }
    }
  }
  return allowed.length > 0 ? Object.freeze(allowed) : null;
}

function makeFailure(reason, { disabled = false, denied = false } = {}) {
  return Object.freeze({ ok: false, disabled, denied, reason, jobs: Object.freeze([]) });
}

function makeLoaderRequest(authorization, limit) {
  const request = Object.create(null);
  request.operation = OPERATION;
  request.capability = CAPABILITY;
  request.companyScoped = true;
  request.limit = limit;
  request.principalId = authorization.principalId;
  request.companyId = authorization.companyId;
  request.scopeRef = authorization.scopeRef;
  return Object.freeze(request);
}

// Call a dependency without assimilating synchronous hostile thenables. Native
// promises are supported; synchronous records are inspected before any await.
async function invokeDependency(dependency, argument, timeoutMilliseconds) {
  let immediate;
  try {
    immediate = dependency(argument);
  } catch {
    return Object.freeze({ ok: false, value: null });
  }
  // Preserve a synchronous Proxy as inert nested data so the strict normalizer
  // can reject it without Promise thenable assimilation evaluating traps.
  if (isProxy(immediate)) return Object.freeze({ ok: true, value: immediate });
  if (!nodeTypes.isPromise(immediate)) return Object.freeze({ ok: true, value: immediate });

  let timer;
  try {
    if (Object.getPrototypeOf(immediate) !== NATIVE_PROMISE_PROTOTYPE
      || Object.getOwnPropertyDescriptor(immediate, 'then')
      || Object.getOwnPropertyDescriptor(immediate, 'constructor')) {
      return Object.freeze({ ok: false, value: null });
    }

    // Attach through the captured intrinsic. Promise.race/await would otherwise
    // read a hostile own `.then` accessor from a dependency-owned Promise.
    const outcome = await new NATIVE_PROMISE((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      timer = setTimeout(() => finish(TIMEOUT), timeoutMilliseconds);
      try {
        Reflect.apply(NATIVE_PROMISE_THEN, immediate, [
          (value) => finish(Object.freeze({ ok: true, value })),
          () => finish(Object.freeze({ ok: false, value: null })),
        ]);
      } catch {
        finish(Object.freeze({ ok: false, value: null }));
      }
    });
    return outcome === TIMEOUT ? Object.freeze({ ok: false, value: null }) : outcome;
  } catch {
    return Object.freeze({ ok: false, value: null });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeEnvelope(raw, authorization, applied, allowedFields) {
  const envelope = captureExactRecord(raw, ENVELOPE_FIELDS);
  if (!envelope
    || envelope.ok !== true
    || envelope.partial !== false
    || envelope.denied !== false
    || envelope.error !== null) return null;

  const rows = captureDenseArray(envelope.jobs, applied);
  const provenance = captureExactRecord(envelope.provenance, PROVENANCE_FIELDS);
  const observedAt = SYSTEM_NOW();
  if (!rows || !provenance
    || !Number.isSafeInteger(observedAt)
    || provenance.source !== SYNTHETIC_SOURCE
    || provenance.state !== SYNTHETIC_STATE
    || !canonicalTimestamp(provenance.asOf, observedAt)
    || provenance.companyId !== authorization.companyId
    || provenance.scopeRef !== authorization.scopeRef) return null;

  const recordRefs = captureDenseArray(provenance.recordRefs, applied);
  if (!recordRefs || recordRefs.length !== rows.length) return null;

  const capturedRows = new Array(rows.length);
  const seenRefs = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const row = captureExactRecord(rows[i], ROW_FIELDS);
    if (!row || !validRowValues(row)) return null;
    const recordRef = recordRefs[i];
    if (recordRef !== expectedRecordRef(authorization, row.jobNumber) || seenRefs.has(recordRef)) return null;
    seenRefs.add(recordRef);
    capturedRows[i] = row;
  }

  const outputLength = Math.min(capturedRows.length, applied);
  const jobs = new Array(outputLength);
  const outputRefs = new Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const row = capturedRows[i];
    const output = Object.create(null);
    for (let j = 0; j < allowedFields.length; j += 1) {
      const field = allowedFields[j];
      if (field === 'source') output.source = provenance.source;
      else if (field === 'asOf') output.asOf = provenance.asOf;
      else if (field === 'state') output.state = provenance.state;
      else output[field] = row[field];
    }
    jobs[i] = Object.freeze(output);
    outputRefs[i] = recordRefs[i];
  }

  const safeProvenance = Object.freeze({
    source: provenance.source,
    asOf: provenance.asOf,
    state: provenance.state,
    recordRefs: Object.freeze(outputRefs),
  });
  return Object.freeze({ jobs: Object.freeze(jobs), provenance: safeProvenance });
}

export function createJobsReadAdapter(config) {
  const capturedConfig = captureConfig(config);
  const enabled = Boolean(capturedConfig && capturedConfig.enabled === true);
  const loaderValue = capturedConfig?.loader;
  const authorizeValue = capturedConfig?.authorize;
  const loader = typeof loaderValue === 'function' && !isProxy(loaderValue) ? loaderValue : null;
  const authorize = typeof authorizeValue === 'function' && !isProxy(authorizeValue) ? authorizeValue : null;
  const configuredMaxRows = capturedConfig?.maxRows;
  const hasConfiguredMaxRows = Boolean(capturedConfig && Object.hasOwn(capturedConfig, 'maxRows'));
  const validConfiguredMaxRows = !hasConfiguredMaxRows
    || (Number.isSafeInteger(configuredMaxRows) && configuredMaxRows > 0);
  const maxRows = hasConfiguredMaxRows && validConfiguredMaxRows
    ? Math.min(configuredMaxRows, HARD_MAX_ROWS)
    : DEFAULT_MAX_ROWS;
  const allowedFields = normalizeAllowedFields(capturedConfig?.allowedFields);

  async function authorizeOnce() {
    if (!authorize) return null;
    const invoked = await invokeDependency(authorize, AUTHORIZATION_REQUEST, AUTHORIZATION_TIMEOUT_MS);
    return invoked.ok ? normalizeAuthorization(invoked.value) : null;
  }

  async function snapshot(input) {
    if (!enabled) return makeFailure(PUBLIC_REASON.disabled, { disabled: true });
    if (!validConfiguredMaxRows || !allowedFields) return makeFailure(PUBLIC_REASON.unavailable);

    const normalizedInput = normalizeInput(input, maxRows);
    if (!normalizedInput) return makeFailure(PUBLIC_REASON.invalidRequest);

    const firstAuthorization = await authorizeOnce();
    if (!firstAuthorization) return makeFailure(PUBLIC_REASON.authorizationDenied, { denied: true });
    if (!loader) return makeFailure(PUBLIC_REASON.noLoader);

    let normalized;
    const invoked = await invokeDependency(
      loader,
      makeLoaderRequest(firstAuthorization, normalizedInput.applied),
      LOADER_TIMEOUT_MS,
    );
    if (!invoked.ok) return makeFailure(PUBLIC_REASON.unavailable);
    try { normalized = normalizeEnvelope(invoked.value, firstAuthorization, normalizedInput.applied, allowedFields); }
    catch { return makeFailure(PUBLIC_REASON.unavailable); }
    if (!normalized) return makeFailure(PUBLIC_REASON.malformed);

    // Revalidate the exact same server scope immediately before disclosure.
    const secondAuthorization = await authorizeOnce();
    if (!sameAuthorization(firstAuthorization, secondAuthorization)) {
      return makeFailure(PUBLIC_REASON.authorizationDenied, { denied: true });
    }

    return Object.freeze({
      ok: true,
      disabled: false,
      denied: false,
      kind: 'jobs_snapshot',
      count: normalized.jobs.length,
      jobs: normalized.jobs,
      provenance: normalized.provenance,
      bounded: Object.freeze({
        maxRows,
        requested: normalizedInput.requested,
        applied: normalizedInput.applied,
      }),
    });
  }

  return Object.freeze({
    snapshot,
    isEnabled: () => enabled,
    allowedFields: () => {
      if (!allowedFields) return [];
      const copy = new Array(allowedFields.length);
      for (let i = 0; i < allowedFields.length; i += 1) copy[i] = allowedFields[i];
      return copy;
    },
  });
}

import { types as utilTypes } from 'node:util';

// HOW LONG A TURN IS ALLOWED TO TAKE.
//
// These were 12s total and 5s for the composer, and they were already too
// tight before anyone noticed: measured turns on 2026-08-21 completed in
// 2.8, 3.2, 3.3 and 4.2 seconds against a 5s composer budget, with almost no
// business context loaded. Switching REINA_LAB_FULL_READ_ENABLED on added
// about twenty database reads and a much larger prompt, the composer went
// past 5s, and the deadline fired: state failed_retryable, stage 'model',
// MODEL_GENERATION_FAILED, and a panel that said Reina was unavailable.
//
// EVERY VALUE HERE IS OVERRIDABLE FROM THE ENVIRONMENT, deliberately. A
// timing change that can only be undone by shipping a revert is a bad trade
// when the thing it protects is whether Reina answers at all. Set
// REINA_PILOT_TOTAL_MS / REINA_PILOT_COMPOSER_MS / REINA_PILOT_CONTEXT_MS in
// the Vercel dashboard and redeploy to go back to any earlier shape without
// touching the code. Out-of-range or unparseable values fall back to the
// default rather than failing, because a typo in a dashboard field must not
// be able to take the route down.
//
// The pre-2026-08-21 behaviour, for the record: TOTAL 12000, COMPOSER 5000.
export function boundedDeadlineMs(value, fallback, minimum, maximum) {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.floor(parsed);
  return whole >= minimum && whole <= maximum ? whole : fallback;
}

const DEADLINE_ENV = typeof process !== 'undefined' && process.env ? process.env : {};

export function resolveServerDeadline(env = DEADLINE_ENV) {
  const source = env && typeof env === 'object' ? env : {};
  const totalMs = boundedDeadlineMs(source.REINA_PILOT_TOTAL_MS, 15_000, 3_000, 60_000);
  const composerMs = boundedDeadlineMs(source.REINA_PILOT_COMPOSER_MS, 9_000, 500, totalMs);
  return Object.freeze({
    totalMs,
    stageMs: boundedDeadlineMs(source.REINA_PILOT_STAGE_MS, 4_000, 250, totalMs),
    composerMs,
    // What the business read alone may take before the turn gives up on it
    // and answers without it. Read by the composer, not by this module.
    contextMs: boundedDeadlineMs(source.REINA_PILOT_CONTEXT_MS, 2_500, 250, composerMs),
    minimumMs: 5,
    maximumTotalMs: totalMs,
  });
}

export const SERVER_DEADLINE = resolveServerDeadline();

export const DURABLE_STORE_METHODS = Object.freeze([
  'loadConversation',
  'createConversation',
  'claimTurn',
  'appendUserMessageOnce',
  'loadHistory',
  'appendAssistantAndCompleteTurn',
  'markTurnFailed',
]);

export const REVIEW_INTENT_STORE_METHODS = Object.freeze([
  'issueReviewIntent',
  'consumeReviewIntent',
]);

const TIMEOUT_CODE = 'REINA_PILOT_SERVER_TIMEOUT';
const DEADLINES = new WeakSet();
const DEADLINE_ERRORS = new WeakSet();
const NATIVE_PROMISE = Promise;
const NATIVE_PROMISE_PROTOTYPE = Promise.prototype;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const NATIVE_PROMISE_REJECT = Promise.reject;
const NATIVE_ABORT_CONTROLLER = AbortController;
const SYSTEM_NOW = Date.now.bind(Date);
const SYSTEM_SET_TIMEOUT = setTimeout;
const SYSTEM_CLEAR_TIMEOUT = clearTimeout;
const IS_PROMISE = utilTypes.isPromise.bind(utilTypes);
const IS_PROXY = utilTypes.isProxy.bind(utilTypes);
const HAS_OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const DEADLINE_OPTION_KEYS = Object.freeze([
  'timeoutMs',
  'stageMs',
  'now',
  'setTimeoutImpl',
  'clearTimeoutImpl',
]);

function isProxy(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try { return IS_PROXY(value); } catch { return true; }
}

function isPromise(value) {
  try { return IS_PROMISE(value); } catch { return false; }
}

function exactDataOptions(value, allowedKeys) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowed = new Set(allowedKeys);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !HAS_OWN(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

export class ReinaPilotDeadlineError extends Error {
  constructor() {
    super(TIMEOUT_CODE);
    Object.defineProperties(this, {
      name: { configurable: false, enumerable: false, writable: false, value: 'ReinaPilotDeadlineError' },
      code: { configurable: false, enumerable: true, writable: false, value: TIMEOUT_CODE },
    });
    DEADLINE_ERRORS.add(this);
    Object.freeze(this);
  }
}

export function isReinaPilotDeadlineError(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && DEADLINE_ERRORS.has(value);
}

function deadlineError() {
  return new ReinaPilotDeadlineError();
}

function configuredInteger(snapshot, key, fallback, maximum) {
  if (!HAS_OWN(snapshot, key)) return fallback;
  const value = snapshot[key];
  if (!Number.isSafeInteger(value) || value < SERVER_DEADLINE.minimumMs) throw deadlineError();
  return Math.min(value, maximum);
}

function configuredFunction(snapshot, key, fallback) {
  if (!HAS_OWN(snapshot, key)) return fallback;
  const value = snapshot[key];
  if (typeof value !== 'function' || isProxy(value)) throw deadlineError();
  return value;
}

function callableDataMethod(value, name) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || isProxy(value)) return null;
  let cursor = value;
  while (cursor && cursor !== Object.prototype) {
    if (isProxy(cursor)) return null;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(cursor, name); } catch { return null; }
    if (descriptor) {
      if (!HAS_OWN(descriptor, 'value')
        || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) return null;
      const method = descriptor.value;
      return (...args) => Reflect.apply(method, value, args);
    }
    try { cursor = Object.getPrototypeOf(cursor); } catch { return null; }
  }
  return null;
}

function hasThenDescriptor(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  let cursor = value;
  while (cursor) {
    if (isProxy(cursor)) return true;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(cursor, 'then'); } catch { return true; }
    if (descriptor) return true;
    try { cursor = Object.getPrototypeOf(cursor); } catch { return true; }
  }
  return false;
}

function isApprovedNativePromise(value) {
  if (isProxy(value)) return false;
  let prototype;
  let ownThen;
  let ownConstructor;
  try {
    if (!isPromise(value)) return false;
    prototype = Object.getPrototypeOf(value);
    ownThen = Object.getOwnPropertyDescriptor(value, 'then');
    ownConstructor = Object.getOwnPropertyDescriptor(value, 'constructor');
  } catch {
    return false;
  }
  return prototype === NATIVE_PROMISE_PROTOTYPE && !ownThen && !ownConstructor;
}

function safeAbort(controller) {
  if (!controller || controller.signal.aborted) return;
  try { controller.abort(deadlineError()); } catch {
    try { controller.abort(); } catch {}
  }
}

export function createPilotServerDeadline(options) {
  const optionSnapshot = exactDataOptions(options === undefined ? {} : options, DEADLINE_OPTION_KEYS);
  if (!optionSnapshot) throw deadlineError();

  const timeoutMs = configuredInteger(
    optionSnapshot,
    'timeoutMs',
    SERVER_DEADLINE.totalMs,
    SERVER_DEADLINE.maximumTotalMs,
  );
  const stageMs = configuredInteger(optionSnapshot, 'stageMs', SERVER_DEADLINE.stageMs, timeoutMs);
  const nowImpl = configuredFunction(optionSnapshot, 'now', SYSTEM_NOW);
  const setTimer = configuredFunction(optionSnapshot, 'setTimeoutImpl', SYSTEM_SET_TIMEOUT);
  const clearTimer = configuredFunction(optionSnapshot, 'clearTimeoutImpl', SYSTEM_CLEAR_TIMEOUT);

  let startedAt;
  try { startedAt = Reflect.apply(nowImpl, undefined, []); } catch { throw deadlineError(); }
  if (!Number.isFinite(startedAt)) throw deadlineError();
  let lastNow = startedAt;
  const deadlineAt = startedAt + timeoutMs;
  if (!Number.isFinite(deadlineAt)) throw deadlineError();

  const root = new NATIVE_ABORT_CONTROLLER();
  const children = new Set();
  let closed = false;
  let expired = false;
  let rootTimer;

  function safeClear(timer) {
    try { Reflect.apply(clearTimer, undefined, [timer]); } catch {}
  }

  function abortAll() {
    safeAbort(root);
    for (const child of Array.from(children)) safeAbort(child);
  }

  try {
    rootTimer = Reflect.apply(setTimer, undefined, [() => {
      if (closed || expired) return;
      expired = true;
      abortAll();
    }, timeoutMs]);
  } catch {
    safeAbort(root);
    throw deadlineError();
  }

  function monotonicNow() {
    let current;
    try { current = Reflect.apply(nowImpl, undefined, []); } catch { return null; }
    if (!Number.isFinite(current)) return null;
    lastNow = Math.max(lastNow, current);
    return lastNow;
  }

  function remainingMs() {
    if (closed || expired || root.signal.aborted) return 0;
    const current = monotonicNow();
    if (current === null) return 0;
    return Math.max(0, Math.floor(deadlineAt - current));
  }

  function run(work, requestedStageMs) {
    if (typeof work !== 'function' || isProxy(work)) {
      return Reflect.apply(NATIVE_PROMISE_REJECT, NATIVE_PROMISE, [deadlineError()]);
    }
    const stageStartedAt = closed || expired || root.signal.aborted ? null : monotonicNow();
    const remaining = stageStartedAt === null
      ? 0
      : Math.max(0, Math.floor(deadlineAt - stageStartedAt));
    if (remaining < SERVER_DEADLINE.minimumMs) {
      expired = true;
      abortAll();
      return Reflect.apply(NATIVE_PROMISE_REJECT, NATIVE_PROMISE, [deadlineError()]);
    }

    let boundedStage = stageMs;
    if (requestedStageMs !== undefined) {
      if (!Number.isSafeInteger(requestedStageMs) || requestedStageMs < SERVER_DEADLINE.minimumMs) {
        return Reflect.apply(NATIVE_PROMISE_REJECT, NATIVE_PROMISE, [deadlineError()]);
      }
      boundedStage = Math.min(requestedStageMs, SERVER_DEADLINE.maximumTotalMs);
    }
    boundedStage = Math.min(boundedStage, remaining);
    const stageDeadlineAt = Math.min(deadlineAt, stageStartedAt + boundedStage);
    const stageDelayMs = Math.max(0, stageDeadlineAt - stageStartedAt);

    const child = new NATIVE_ABORT_CONTROLLER();
    children.add(child);
    let settled = false;
    let stageTimer;
    let rootAbortListener;

    return new NATIVE_PROMISE((resolve, reject) => {
      const clean = () => {
        if (stageTimer !== undefined) safeClear(stageTimer);
        if (rootAbortListener) {
          try { root.signal.removeEventListener('abort', rootAbortListener); } catch {}
        }
        children.delete(child);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clean();
        fn(value);
      };
      const failFixed = () => finish(reject, deadlineError());
      const timeOut = () => {
        safeAbort(child);
        failFixed();
      };
      const finishValue = (value) => {
        if (isProxy(value) || hasThenDescriptor(value)) {
          failFixed();
          return;
        }
        finish(resolve, value);
      };

      rootAbortListener = timeOut;
      try {
        root.signal.addEventListener('abort', rootAbortListener, { once: true });
        stageTimer = Reflect.apply(setTimer, undefined, [timeOut, stageDelayMs]);
      } catch {
        safeAbort(child);
        failFixed();
        return;
      }

      let operation;
      try {
        operation = Reflect.apply(work, undefined, [child.signal, stageDeadlineAt]);
      } catch {
        failFixed();
        return;
      }

      if (isApprovedNativePromise(operation)) {
        try {
          Reflect.apply(NATIVE_PROMISE_THEN, operation, [finishValue, failFixed]);
        } catch {
          failFixed();
        }
        return;
      }
      if (isProxy(operation) || isPromise(operation) || hasThenDescriptor(operation)) {
        failFixed();
        return;
      }
      finishValue(operation);
    });
  }

  function abort() {
    if (closed || expired) return;
    expired = true;
    safeClear(rootTimer);
    abortAll();
  }

  function close() {
    if (closed) return;
    closed = true;
    safeClear(rootTimer);
    abortAll();
    children.clear();
  }

  const deadline = Object.freeze({
    signal: root.signal,
    deadlineAt,
    remainingMs,
    run,
    abort,
    close,
    get closed() { return closed; },
    get expired() { return expired; },
  });
  DEADLINES.add(deadline);
  return deadline;
}

function createBoundedStore(store, deadline, options, requiredMethods) {
  if (!DEADLINES.has(deadline)) return null;
  const optionSnapshot = exactDataOptions(options === undefined ? {} : options, ['stageMs']);
  if (!optionSnapshot) return null;
  let configuredStage;
  if (HAS_OWN(optionSnapshot, 'stageMs')) {
    try {
      configuredStage = configuredInteger(
        optionSnapshot,
        'stageMs',
        SERVER_DEADLINE.stageMs,
        SERVER_DEADLINE.maximumTotalMs,
      );
    } catch {
      return null;
    }
  }

  const run = callableDataMethod(deadline, 'run');
  if (!run) return null;
  const attemptDeadlineAt = deadline.deadlineAt;
  if (!Number.isFinite(attemptDeadlineAt)) return null;
  const methods = Object.create(null);
  for (const name of requiredMethods) {
    const method = callableDataMethod(store, name);
    if (!method) return null;
    methods[name] = input => run(
      (signal, deadlineAt) => method(input, Object.freeze({
        signal,
        deadlineAt,
        attemptDeadlineAt,
      })),
      configuredStage,
    );
  }
  return Object.freeze(methods);
}

export function createBoundedConversationStore(store, deadline, options) {
  return createBoundedStore(store, deadline, options, DURABLE_STORE_METHODS);
}

export function createBoundedReviewIntentStore(store, deadline, options) {
  return createBoundedStore(store, deadline, options, REVIEW_INTENT_STORE_METHODS);
}

export function captureDataMethod(value, name) {
  return callableDataMethod(value, name);
}

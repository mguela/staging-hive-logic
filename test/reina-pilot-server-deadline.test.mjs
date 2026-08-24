import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DURABLE_STORE_METHODS,
  REVIEW_INTENT_STORE_METHODS,
  ReinaPilotDeadlineError,
  SERVER_DEADLINE,
  captureDataMethod,
  createBoundedConversationStore,
  createBoundedReviewIntentStore,
  createPilotServerDeadline,
  isReinaPilotDeadlineError,
  resolveServerDeadline,
  boundedDeadlineMs,
} from '../api/_lib/reina/pilot-server-deadline.js';

function assertFixedDeadlineError(error) {
  assert.equal(error instanceof ReinaPilotDeadlineError, true);
  assert.equal(isReinaPilotDeadlineError(error), true);
  assert.equal(error.name, 'ReinaPilotDeadlineError');
  assert.equal(error.code, 'REINA_PILOT_SERVER_TIMEOUT');
  assert.equal(error.message, 'REINA_PILOT_SERVER_TIMEOUT');
  assert.equal(Object.isFrozen(error), true);
  assert.equal(JSON.stringify(error).includes('SYNTHETIC'), false);
  return true;
}

function never() {
  return new Promise(() => {});
}

test('default root deadline is exactly bounded at forty seconds and closes idempotently', () => {
  const before = Date.now();
  const deadline = createPilotServerDeadline();
  const after = Date.now();
  // Was 12s with a 5s composer. Measured turns completed in 2.8-4.2s against
  // that composer budget with almost no context loaded, so it was already at
  // its limit before the full business read existed; with the read switched
  // on it went over and the turn failed outright.
  assert.equal(SERVER_DEADLINE.totalMs, 40_000);
  assert.equal(SERVER_DEADLINE.composerMs, 30_000);
  assert.equal(SERVER_DEADLINE.contextMs, 2_500);
  assert.equal(deadline.deadlineAt >= before + 40_000, true);
  assert.equal(deadline.deadlineAt <= after + 40_000, true);
  assert.equal(deadline.remainingMs() <= 40_000, true);
  assert.equal(deadline.signal.aborted, false);
  assert.equal(deadline.closed, false);
  deadline.close();
  deadline.close();
  assert.equal(deadline.closed, true);
  assert.equal(deadline.remainingMs(), 0);
  assert.equal(deadline.signal.aborted, true);
});

test('never-settling stages reject with one fixed error and abort their child signal', async () => {
  const deadline = createPilotServerDeadline({ timeoutMs: 200, stageMs: 20 });
  let childSignal;
  let rejectionCount = 0;
  const pending = deadline.run((signal) => {
    childSignal = signal;
    return never();
  }).catch((error) => {
    rejectionCount += 1;
    throw error;
  });

  await assert.rejects(pending, assertFixedDeadlineError);
  assert.equal(rejectionCount, 1);
  assert.equal(childSignal instanceof AbortSignal, true);
  assert.equal(childSignal.aborted, true);
  assert.equal(deadline.signal.aborted, false, 'a stage timeout does not consume the whole request budget');
  deadline.close();
});

test('late resolution and rejection are ignored after the stage has failed closed', async () => {
  const deadline = createPilotServerDeadline({ timeoutMs: 250, stageMs: 20 });
  let resolveLate;
  let rejectLate;
  let fulfilled = 0;
  let rejected = 0;
  const lateResolution = new Promise((resolve) => { resolveLate = resolve; });
  const lateRejection = new Promise((_resolve, reject) => { rejectLate = reject; });

  const first = deadline.run(() => lateResolution).then(
    () => { fulfilled += 1; },
    (error) => { rejected += 1; assertFixedDeadlineError(error); },
  );
  const second = deadline.run(() => lateRejection).then(
    () => { fulfilled += 1; },
    (error) => { rejected += 1; assertFixedDeadlineError(error); },
  );
  await Promise.all([first, second]);
  assert.equal(fulfilled, 0);
  assert.equal(rejected, 2);

  resolveLate('SYNTHETIC_LATE_SUCCESS');
  rejectLate(new Error('SYNTHETIC_LATE_REJECTION'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fulfilled, 0);
  assert.equal(rejected, 2);
  deadline.close();
});

test('root abort propagates to every active child without consuming raw errors', async () => {
  const deadline = createPilotServerDeadline({ timeoutMs: 500, stageMs: 400 });
  const childSignals = [];
  const pending = [0, 1].map(() => deadline.run((signal) => {
    childSignals.push(signal);
    return never();
  }));

  deadline.abort();
  const outcomes = await Promise.allSettled(pending);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.expired, true);
  assert.equal(childSignals.length, 2);
  assert.equal(childSignals.every(signal => signal.aborted), true);
  assert.equal(outcomes.every(outcome => outcome.status === 'rejected'
    && assertFixedDeadlineError(outcome.reason)), true);
  await assert.rejects(deadline.run(() => 'too late'), assertFixedDeadlineError);
  deadline.close();
});

test('close clears the root and stage timers and deterministically settles active work', async () => {
  const timers = new Map();
  const cleared = [];
  let nextTimer = 1;
  const deadline = createPilotServerDeadline({
    timeoutMs: 100,
    stageMs: 50,
    now: () => 1_000,
    setTimeoutImpl(callback, delay) {
      const handle = nextTimer++;
      timers.set(handle, { callback, delay });
      return handle;
    },
    clearTimeoutImpl(handle) {
      cleared.push(handle);
      timers.delete(handle);
    },
  });
  let childSignal;
  const pending = deadline.run((signal) => {
    childSignal = signal;
    return never();
  });
  assert.equal(timers.size, 2);
  deadline.close();
  await assert.rejects(pending, assertFixedDeadlineError);
  assert.equal(deadline.closed, true);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(childSignal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(new Set(cleared).size, 2);
});

test('bounded store captures and calls all seven descriptor-safe methods with deadline metadata', async () => {
  const deadline = createPilotServerDeadline({
    timeoutMs: 500,
    stageMs: 100,
    now: () => 1_000,
  });
  const calls = [];
  const store = Object.create(null);
  for (const name of DURABLE_STORE_METHODS) {
    Object.defineProperty(store, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      async value(input, metadata) {
        calls.push({ name, input, metadata, receiver: this });
        return Object.freeze({ name, ok: true });
      },
    });
  }
  const bounded = createBoundedConversationStore(store, deadline);
  assert.ok(bounded);
  assert.equal(Object.isFrozen(bounded), true);
  assert.deepEqual(Object.keys(bounded), DURABLE_STORE_METHODS);

  for (const name of DURABLE_STORE_METHODS) {
    const input = Object.freeze({ marker: name });
    assert.deepEqual(await bounded[name](input), { name, ok: true });
  }
  assert.equal(calls.length, DURABLE_STORE_METHODS.length);
  for (const call of calls) {
    assert.equal(call.receiver, store);
    assert.equal(call.input.marker, call.name);
    assert.equal(call.metadata.signal instanceof AbortSignal, true);
    assert.equal(call.metadata.signal.aborted, false);
    assert.equal(call.metadata.deadlineAt, 1_100);
    assert.equal(call.metadata.attemptDeadlineAt, 1_500);
    assert.notEqual(call.metadata.deadlineAt, deadline.deadlineAt);
    assert.equal(call.metadata.attemptDeadlineAt, deadline.deadlineAt);
    assert.equal(Object.isFrozen(call.metadata), true);
  }
  deadline.close();
});

test('review intent store has a separate exact two-method bounded surface', async () => {
  assert.deepEqual(REVIEW_INTENT_STORE_METHODS, ['issueReviewIntent', 'consumeReviewIntent']);
  assert.equal(Object.isFrozen(REVIEW_INTENT_STORE_METHODS), true);
  assert.equal(DURABLE_STORE_METHODS.includes('issueReviewIntent'), false);
  assert.equal(DURABLE_STORE_METHODS.includes('consumeReviewIntent'), false);

  const deadline = createPilotServerDeadline({
    timeoutMs: 500,
    stageMs: 100,
    now: () => 2_000,
  });
  const calls = [];
  const reviewStore = Object.freeze({
    async issueReviewIntent(input, metadata) {
      calls.push({ name: 'issueReviewIntent', input, metadata, receiver: this });
      return Object.freeze({ status: 'issued' });
    },
    async consumeReviewIntent(input, metadata) {
      calls.push({ name: 'consumeReviewIntent', input, metadata, receiver: this });
      return Object.freeze({ status: 'consumed' });
    },
  });
  const bounded = createBoundedReviewIntentStore(reviewStore, deadline);
  assert.ok(bounded);
  assert.equal(Object.isFrozen(bounded), true);
  assert.deepEqual(Object.keys(bounded), REVIEW_INTENT_STORE_METHODS);
  for (const name of REVIEW_INTENT_STORE_METHODS) {
    assert.deepEqual(await bounded[name](Object.freeze({ marker: name })), {
      status: name === 'issueReviewIntent' ? 'issued' : 'consumed',
    });
  }
  for (const call of calls) {
    assert.equal(call.receiver, reviewStore);
    assert.equal(call.input.marker, call.name);
    assert.equal(call.metadata.signal instanceof AbortSignal, true);
    assert.equal(call.metadata.signal.aborted, false);
    assert.equal(call.metadata.deadlineAt, 2_100);
    assert.equal(call.metadata.attemptDeadlineAt, 2_500);
    assert.equal(Object.isFrozen(call.metadata), true);
  }
  assert.equal(createBoundedConversationStore(reviewStore, deadline), null);
  deadline.close();
});

test('review issue and consume independently time out with the fixed server error', async () => {
  const deadline = createPilotServerDeadline({ timeoutMs: 500, stageMs: 15 });
  const signals = [];
  const reviewStore = Object.freeze({
    issueReviewIntent(_input, metadata) {
      signals.push(metadata.signal);
      return never();
    },
    consumeReviewIntent(_input, metadata) {
      signals.push(metadata.signal);
      return never();
    },
  });
  const bounded = createBoundedReviewIntentStore(reviewStore, deadline);
  assert.ok(bounded);
  await assert.rejects(bounded.issueReviewIntent(Object.freeze({})), assertFixedDeadlineError);
  await assert.rejects(bounded.consumeReviewIntent(Object.freeze({})), assertFixedDeadlineError);
  assert.equal(signals.length, 2);
  assert.equal(signals.every(signal => signal.aborted), true);
  deadline.close();
});

test('bounded store separates the exact 4 second RPC fence from the full attempt lease', async () => {
  const timers = [];
  const receivedDeadlines = [];
  const deadline = createPilotServerDeadline({
    now: () => 10_000,
    setTimeoutImpl(callback, delay) {
      const timer = Object.freeze({ callback, delay });
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl() {},
  });
  const store = Object.create(null);
  for (const name of DURABLE_STORE_METHODS) {
    store[name] = async function (_input, metadata) {
      receivedDeadlines.push(Object.freeze({
        deadlineAt: metadata.deadlineAt,
        attemptDeadlineAt: metadata.attemptDeadlineAt,
      }));
      return Object.freeze({ ok: true });
    };
  }

  const bounded = createBoundedConversationStore(store, deadline);
  assert.ok(bounded);
  await bounded.claimTurn(Object.freeze({ marker: 'stage-fence' }));

  assert.equal(deadline.deadlineAt, 50_000);
  assert.deepEqual(receivedDeadlines, [{ deadlineAt: 14_000, attemptDeadlineAt: 50_000 }]);
  assert.notEqual(receivedDeadlines[0].deadlineAt, deadline.deadlineAt);
  assert.equal(receivedDeadlines[0].attemptDeadlineAt, deadline.deadlineAt);
  assert.equal(timers[0].delay, 40_000, 'root timer retains the total request budget');
  assert.equal(timers[1].delay, 4_000, 'stage timer matches the store deadline metadata');
  assert.equal(timers[1].delay, receivedDeadlines[0].deadlineAt - 10_000);
  deadline.close();
});

test('every bounded store method times out independently and ignores late completion', async () => {
  const deadline = createPilotServerDeadline({ timeoutMs: 500, stageMs: 15 });
  const resolvers = new Map();
  const signals = new Map();
  const store = Object.create(null);
  for (const name of DURABLE_STORE_METHODS) {
    store[name] = function (_input, metadata) {
      signals.set(name, metadata.signal);
      return new Promise(resolve => resolvers.set(name, resolve));
    };
  }
  const bounded = createBoundedConversationStore(store, deadline);
  assert.ok(bounded);

  for (const name of DURABLE_STORE_METHODS) {
    await assert.rejects(bounded[name](Object.freeze({ name })), assertFixedDeadlineError);
    assert.equal(signals.get(name).aborted, true, name);
  }
  for (const name of DURABLE_STORE_METHODS) resolvers.get(name)({ late: name });
  await new Promise(resolve => setImmediate(resolve));
  deadline.close();
});

test('store Proxies, accessors, and proxied methods are rejected without invoking traps', () => {
  const deadline = createPilotServerDeadline({ timeoutMs: 100, stageMs: 20 });
  let trapReads = 0;
  const liveProxy = new Proxy({}, {
    get() {
      trapReads += 1;
      throw new Error('SYNTHETIC_STORE_PROXY');
    },
  });
  assert.equal(createBoundedConversationStore(liveProxy, deadline), null);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(createBoundedConversationStore(revoked.proxy, deadline), null);

  const accessorStore = Object.create(null);
  for (const name of DURABLE_STORE_METHODS) accessorStore[name] = async () => ({ ok: true });
  Object.defineProperty(accessorStore, 'claimTurn', {
    configurable: true,
    enumerable: true,
    get() {
      trapReads += 1;
      throw new Error('SYNTHETIC_STORE_ACCESSOR');
    },
  });
  assert.equal(createBoundedConversationStore(accessorStore, deadline), null);

  const proxiedMethodStore = Object.create(null);
  for (const name of DURABLE_STORE_METHODS) proxiedMethodStore[name] = async () => ({ ok: true });
  proxiedMethodStore.loadHistory = new Proxy(function () {}, {
    apply() {
      trapReads += 1;
      throw new Error('SYNTHETIC_METHOD_PROXY');
    },
  });
  assert.equal(createBoundedConversationStore(proxiedMethodStore, deadline), null);
  assert.equal(trapReads, 0);
  deadline.close();
});

test('hostile options and forged errors fail closed without accessor or Proxy evaluation', () => {
  let reads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'timeoutMs', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('SYNTHETIC_OPTIONS_ACCESSOR');
    },
  });
  assert.throws(() => createPilotServerDeadline(accessorOptions), assertFixedDeadlineError);

  const optionProxy = new Proxy({}, {
    get() {
      reads += 1;
      throw new Error('SYNTHETIC_OPTIONS_PROXY');
    },
  });
  assert.throws(() => createPilotServerDeadline(optionProxy), assertFixedDeadlineError);
  assert.throws(
    () => createPilotServerDeadline({ now: () => { throw new Error('SYNTHETIC_NOW'); } }),
    assertFixedDeadlineError,
  );
  assert.equal(reads, 0);

  const forged = {};
  Object.defineProperty(forged, 'code', {
    get() {
      reads += 1;
      throw new Error('SYNTHETIC_FORGED_ERROR');
    },
  });
  assert.equal(isReinaPilotDeadlineError(forged), false);
  assert.equal(isReinaPilotDeadlineError(new Proxy({}, { get() { reads += 1; } })), false);
  assert.equal(reads, 0);
});

test('hostile work, thenables, and raw dependency failures become only fixed errors', async () => {
  const deadline = createPilotServerDeadline({ timeoutMs: 250, stageMs: 30 });
  let reads = 0;
  const thenable = {};
  Object.defineProperty(thenable, 'then', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('SYNTHETIC_THENABLE_ACCESSOR');
    },
  });
  const proxiedWork = new Proxy(function () {}, {
    apply() {
      reads += 1;
      throw new Error('SYNTHETIC_WORK_PROXY');
    },
  });

  await assert.rejects(deadline.run(proxiedWork), assertFixedDeadlineError);
  await assert.rejects(deadline.run(() => thenable), assertFixedDeadlineError);
  await assert.rejects(
    deadline.run(() => { throw new Error('SYNTHETIC_SYNC_FAILURE'); }),
    assertFixedDeadlineError,
  );
  await assert.rejects(
    deadline.run(async () => { throw new Error('SYNTHETIC_ASYNC_FAILURE'); }),
    assertFixedDeadlineError,
  );
  assert.equal(reads, 0);
  deadline.close();
});

test('captureDataMethod never evaluates accessors and preserves the receiver', () => {
  let accessorReads = 0;
  const receiver = {
    marker: 'receiver',
    method(value) { return `${this.marker}:${value}`; },
  };
  const method = captureDataMethod(receiver, 'method');
  assert.equal(method('ok'), 'receiver:ok');

  const hostile = {};
  Object.defineProperty(hostile, 'method', {
    get() {
      accessorReads += 1;
      throw new Error('SYNTHETIC_CAPTURE_ACCESSOR');
    },
  });
  assert.equal(captureDataMethod(hostile, 'method'), null);
  assert.equal(accessorReads, 0);
});

// ---- going back must not require shipping code -------------------------------
// The 2026-08-21 incident: turning on the full business read pushed the
// composer past its 5s budget and every turn came back "Reina's synthetic
// read-only preview is unavailable right now". Raising the budget is the fix,
// but a timing change that can only be undone by a revert PR is a bad trade
// when what it governs is whether Reina answers at all. Every value is
// settable from the environment, so any earlier shape is a dashboard edit.

test('the whole budget can be dialled back to what it was, from the environment', () => {
  const previous = resolveServerDeadline({
    REINA_PILOT_TOTAL_MS: '12000',
    REINA_PILOT_COMPOSER_MS: '5000',
  });
  assert.equal(previous.totalMs, 12_000);
  assert.equal(previous.composerMs, 5_000);
  assert.equal(previous.maximumTotalMs, 12_000, 'the clamp follows the total, or nothing is really reverted');
});

test('a typo in a dashboard field falls back to the default instead of taking the route down', () => {
  for (const bad of ['', 'true', 'soon', '-1', '0', '999999999', null, undefined, {}, []]) {
    const resolved = resolveServerDeadline({ REINA_PILOT_TOTAL_MS: bad });
    assert.equal(resolved.totalMs, 40_000, `REINA_PILOT_TOTAL_MS=${JSON.stringify(bad)}`);
  }
  assert.equal(boundedDeadlineMs('7500', 1, 1_000, 10_000), 7_500);
  assert.equal(boundedDeadlineMs('7500.9', 1, 1_000, 10_000), 7_500, 'truncated, not rounded up past a bound');
});

test('a stage can never be given longer than the request it belongs to', () => {
  const resolved = resolveServerDeadline({
    REINA_PILOT_TOTAL_MS: '6000',
    REINA_PILOT_COMPOSER_MS: '30000',
    REINA_PILOT_CONTEXT_MS: '30000',
  });
  assert.equal(resolved.totalMs, 6_000);
  assert.equal(resolved.composerMs, 30_000, 'out of range for this total, so the default stands');
  assert.ok(resolved.contextMs <= resolved.composerMs);
});

// test/reina-ui-intent-router.test.mjs
//
// Adversarial tests for the governed, read-only UI intent router. Everything is
// injected -- host navigation handlers, the allowlist, the clock -- so the tests
// need no DOM. They prove the router only acts on a canonical server-issued
// `reina.ui-intent.v1`, only after explicit confirmation bound to the exact
// pending intent, and that it navigates at most once, fails closed on every
// adversarial input, and can never mutate business data.

import test from 'node:test';
import assert from 'node:assert/strict';
import R from '../public/reina-ui-intent-router.js';

const { createUiIntentRouter, INTENT_VERSION, KINDS } = R;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const NOW = 1_000_000;
const SOON = NOW + 60_000; // 1 minute ahead (future + bounded)

function makeRouter(o = {}) {
  const nav = [];
  const events = [];
  // Handlers return the EXPLICIT documented success signal ({ ok: true }); a
  // bare resolve is no longer treated as navigation success.
  const handlers = o.handlers || {
    navigate: (d, p) => { nav.push({ kind: 'navigate', d, p }); return { ok: true }; },
    open_detail: (d, p) => { nav.push({ kind: 'open_detail', d, p }); return { ok: true }; },
    apply_filter: (d, p) => { nav.push({ kind: 'apply_filter', d, p }); return { ok: true }; },
    focus_reina: (d, p) => { nav.push({ kind: 'focus_reina', d, p }); return { ok: true }; },
  };
  const allowlist = o.allowlist || {
    navigate: { destinations: ['clients', 'invoices', 'attention'], params: { tab: ['overview', 'detail'] } },
    open_detail: { destinations: ['client', 'invoice'], params: { id: 'token' } },
    apply_filter: { destinations: ['clients', 'invoices'], params: { status: ['open', 'paid'], q: 'text' } },
    focus_reina: { destinations: ['reina'], params: {} },
  };
  const router = createUiIntentRouter({
    conversationId: o.conversationId || 'conv-1',
    now: o.now || (() => NOW),
    handlers,
    allowlist,
    allow: o.allow,
    onConfirmRequest: (x) => events.push({ t: 'confirm', x }),
    onExecuted: (x) => events.push({ t: 'executed', x }),
    onError: (x) => events.push({ t: 'error', x }),
    onDenied: (x) => events.push({ t: 'denied', x }),
    onCancelled: (x) => events.push({ t: 'cancelled', x }),
  });
  return { router, nav, events };
}

function intent(over = {}) {
  return {
    version: INTENT_VERSION,
    conversationId: 'conv-1',
    turnId: 't-1',
    intentId: 'i-1',
    kind: 'navigate',
    destination: 'clients',
    parameters: { tab: 'overview' },
    requiresConfirmation: true,
    expiresAt: SOON,
    executed: false,
    ...over,
  };
}
const resp = (i) => ({ uiIntent: i });
const ctx = (turnId = 't-1') => ({ turnId });

// ===========================================================================
// Happy path: propose -> explicit confirmation -> one navigation
// ===========================================================================

test('propose -> explicit confirm -> exactly one navigation', async () => {
  const h = makeRouter();
  const p = h.router.propose(resp(intent()), ctx());
  assert.equal(p.accepted, true);
  assert.equal(h.nav.length, 0); // proposing NEVER navigates
  assert.ok(h.events.some((e) => e.t === 'confirm' && e.x.intentId === 'i-1'));

  const r = await h.router.confirm('i-1');
  assert.equal(r.executed, true);
  assert.equal(h.nav.length, 1);
  assert.deepEqual(h.nav[0], { kind: 'navigate', d: 'clients', p: { tab: 'overview' } });
});

test('model prose (no canonical intent) is never executable', async () => {
  const h = makeRouter();
  assert.equal(h.router.propose({ prose: 'please navigate to clients' }, ctx()).accepted, false);
  assert.equal(h.router.propose('navigate to clients', ctx()).accepted, false);
  assert.equal(h.router.propose(resp({ text: 'go to clients' }), ctx()).accepted, false);
  assert.equal(h.nav.length, 0);
});

// ===========================================================================
// Verbal + button use the SAME confirm(intentId) path
// ===========================================================================

test('verbal "yes" and button confirmation enter the same confirm path', async () => {
  // Button
  const a = makeRouter();
  a.router.propose(resp(intent()), ctx());
  await a.router.confirm('i-1', 'button');
  assert.equal(a.nav.length, 1);
  assert.equal(a.events.find((e) => e.t === 'executed').x.source, 'button');

  // Verbal (confirmPending resolves to the exact pending intentId)
  const b = makeRouter();
  b.router.propose(resp(intent()), ctx());
  await b.router.confirmPending('verbal');
  assert.equal(b.nav.length, 1);
  assert.equal(b.events.find((e) => e.t === 'executed').x.source, 'verbal');
});

// ===========================================================================
// Duplicate confirmation -> at most once
// ===========================================================================

test('duplicate confirmation navigates at most once (button then verbal)', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent()), ctx());
  const r1 = await h.router.confirm('i-1');
  const r2 = await h.router.confirm('i-1'); // duplicate
  const r3 = await h.router.confirmPending(); // duplicate via verbal path
  assert.equal(r1.executed, true);
  assert.equal(r2.executed, false);
  assert.equal(r3.executed, false);
  assert.equal(h.nav.length, 1);
});

test('synchronous double confirm (same tick) still navigates once', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent()), ctx());
  const p1 = h.router.confirm('i-1');
  const p2 = h.router.confirm('i-1');
  await Promise.all([p1, p2]);
  assert.equal(h.nav.length, 1);
});

// ===========================================================================
// Cancellation
// ===========================================================================

test('cancellation performs nothing and blocks later confirm', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent()), ctx());
  const c = h.router.cancel('i-1');
  assert.equal(c.cancelled, true);
  const r = await h.router.confirm('i-1');
  assert.equal(r.executed, false);
  assert.equal(h.nav.length, 0);
});

// ===========================================================================
// Stale / expired / replaced
// ===========================================================================

test('expired intent (at propose) is rejected', () => {
  const h = makeRouter();
  const p = h.router.propose(resp(intent({ expiresAt: NOW - 1 })), ctx());
  assert.equal(p.accepted, false);
  assert.equal(p.reason, 'invalid_expiry');
});

test('un-bounded (far-future) expiry is rejected', () => {
  const h = makeRouter();
  const p = h.router.propose(resp(intent({ expiresAt: NOW + 24 * 3600 * 1000 })), ctx());
  assert.equal(p.accepted, false);
  assert.equal(p.reason, 'invalid_expiry');
});

test('intent that expires between propose and confirm does nothing', async () => {
  let t = NOW;
  const h = makeRouter({ now: () => t });
  h.router.propose(resp(intent({ expiresAt: NOW + 5000 })), ctx());
  t = NOW + 6000; // time passes -> expired
  const r = await h.router.confirm('i-1');
  assert.equal(r.executed, false);
  assert.equal(r.reason, 'expired');
  assert.equal(h.nav.length, 0);
});

test('a replaced intent is stale: confirming the old id does nothing', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent({ intentId: 'old' })), ctx());
  h.router.propose(resp(intent({ intentId: 'new' })), ctx()); // replaces pending
  const rOld = await h.router.confirm('old');
  assert.equal(rOld.executed, false);
  const rNew = await h.router.confirm('new');
  assert.equal(rNew.executed, true);
  assert.equal(h.nav.length, 1);
});

test('stale-turn intent (turnId mismatch) is rejected', () => {
  const h = makeRouter();
  const p = h.router.propose(resp(intent({ turnId: 't-OLD' })), ctx('t-1'));
  assert.equal(p.accepted, false);
  assert.equal(p.reason, 'turn_mismatch');
});

// ===========================================================================
// Mismatched IDs / structural guards
// ===========================================================================

test('mismatched conversationId / turnId / intentId all fail closed', async () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ conversationId: 'other' })), ctx()).reason, 'conversation_mismatch');
  assert.equal(h.router.propose(resp(intent()), ctx('t-OTHER')).reason, 'turn_mismatch');
  // response-level id disagreement is also caught
  assert.equal(h.router.propose({ uiIntent: intent(), conversationId: 'other' }, ctx()).reason, 'conversation_mismatch');
  // confirm with the wrong intentId
  h.router.propose(resp(intent()), ctx());
  const r = await h.router.confirm('WRONG');
  assert.equal(r.executed, false);
  assert.equal(r.reason, 'intent_mismatch');
  assert.equal(h.nav.length, 0);
});

test('structural executed:true is rejected', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ executed: true })), ctx()).reason, 'false_execution_claim');
  assert.equal(h.router.propose(resp(intent({ executed: undefined })), ctx()).reason, 'false_execution_claim');
});

test('forged requiresConfirmation:false cannot skip confirmation', () => {
  const h = makeRouter();
  const p = h.router.propose(resp(intent({ requiresConfirmation: false })), ctx());
  assert.equal(p.accepted, false);
  assert.equal(p.reason, 'confirmation_not_required');
});

test('unrecognized version is rejected', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ version: 'reina.ui-intent.v2' })), ctx()).reason, 'unrecognized_version');
});

test('non-primitive / unbounded intentId is rejected', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ intentId: { id: 1 } })), ctx()).reason, 'invalid_intent_id');
  assert.equal(h.router.propose(resp(intent({ intentId: '' })), ctx()).reason, 'invalid_intent_id');
  assert.equal(h.router.propose(resp(intent({ intentId: 'x'.repeat(500) })), ctx()).reason, 'invalid_intent_id');
});

// ===========================================================================
// Destination + parameter allowlists
// ===========================================================================

test('destination must be allowlisted for its kind', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ destination: 'secret_admin' })), ctx()).reason, 'destination_not_allowlisted');
});

test('unknown parameter keys are rejected', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ parameters: { evil: 'x' } })), ctx()).reason, 'unknown_parameter');
});

test('parameter values must match the allowlisted spec', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ parameters: { tab: 'nope' } })), ctx()).reason, 'bad_parameter_value');
  // open_detail id must be a safe token
  assert.equal(
    h.router.propose(resp(intent({ kind: 'open_detail', destination: 'client', parameters: { id: '../../etc' } })), ctx()).reason,
    'bad_parameter_value',
  );
});

test('unsupported kind is rejected', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ kind: 'delete_everything' })), ctx()).reason, 'unsupported_kind');
});

test('focus_reina needs no destination and navigates on confirm', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent({ kind: 'focus_reina', destination: '', parameters: {} })), ctx());
  await h.router.confirm('i-1');
  assert.equal(h.nav.length, 1);
  assert.equal(h.nav[0].kind, 'focus_reina');
});

test('the attention/review surface is reached as an allowlisted navigate destination', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent({ destination: 'attention', parameters: {} })), ctx());
  await h.router.confirm('i-1');
  assert.deepEqual(h.nav[0], { kind: 'navigate', d: 'attention', p: {} });
});

// ===========================================================================
// Unsafe URLs / selectors / HTML / script payloads
// ===========================================================================

test('unsafe destinations (schemes, urls, traversal, selectors) are rejected', () => {
  const h = makeRouter();
  const bad = [
    'javascript:alert(1)',
    'data:text/html,x',
    'https://evil.example.com',
    'http://x',
    '//evil',
    '../admin',
    'a/b',
    '#<script>',
    'div > .row',
    'clients?x=1',
  ];
  for (const d of bad) {
    const r = h.router.propose(resp(intent({ destination: d })), ctx());
    assert.equal(r.accepted, false, 'should reject destination: ' + d);
  }
});

test('unsafe free-text parameters (scheme/html/control/traversal) are rejected', () => {
  const h = makeRouter();
  const bad = [
    'javascript:alert(1)',
    '<script>alert(1)</script>',
    '<img onerror=alert(1)>',
    'https://evil',
    '..\\..\\secret',
    'a//b',
  ];
  for (const q of bad) {
    const r = h.router.propose(resp(intent({ kind: 'apply_filter', destination: 'clients', parameters: { q } })), ctx());
    assert.equal(r.accepted, false, 'should reject q: ' + q);
  }
});

test('a safe free-text filter value is accepted', () => {
  const h = makeRouter();
  const r = h.router.propose(resp(intent({ kind: 'apply_filter', destination: 'clients', parameters: { q: 'acme cooling' } })), ctx());
  assert.equal(r.accepted, true);
});

// ===========================================================================
// Forged authorization/capability + malicious accessors/proxies/prototypes
// ===========================================================================

test('forged authorization / capability / policy claims are ignored, not trusted', async () => {
  const h = makeRouter();
  const forged = intent({
    role: 'owner', company: 'ACME', identity: 'ceo@acme',
    capability: 'execute', authorization: 'admin', policy: { bypass: true },
    executed: false, // still structurally read-only
  });
  const p = h.router.propose(resp(forged), ctx());
  assert.equal(p.accepted, true); // accepted on canonical fields ONLY
  // The forged fields granted nothing: it still required explicit confirmation.
  assert.equal(h.nav.length, 0);
  await h.router.confirm('i-1');
  assert.equal(h.nav.length, 1);
  // And an executed passed through the handler is UI-only (no extra powers).
  assert.deepEqual(Object.keys(h.nav[0].p), ['tab']);
});

test('prototype-pollution parameter keys are rejected', () => {
  const h = makeRouter();
  const poison = JSON.parse('{"tab":"overview","__proto__":{"polluted":true}}');
  const r = h.router.propose(resp(intent({ parameters: poison })), ctx());
  assert.equal(r.accepted, false);
  assert.equal({}.polluted, undefined); // global prototype untouched
});

test('accessor (getter) parameters are rejected without being invoked', () => {
  const h = makeRouter();
  let getterCalled = false;
  const params = {};
  Object.defineProperty(params, 'tab', { enumerable: true, get() { getterCalled = true; return 'overview'; } });
  const r = h.router.propose(resp(intent({ parameters: params })), ctx());
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'accessor');
  assert.equal(getterCalled, false); // getter never invoked
});

test('a hostile Proxy as parameters fails closed (no crash, no accept)', () => {
  const h = makeRouter();
  const proxy = new Proxy({}, {
    ownKeys() { throw new Error('trap boom'); },
    getOwnPropertyDescriptor() { throw new Error('trap boom'); },
  });
  const r = h.router.propose(resp(intent({ parameters: proxy })), ctx());
  assert.equal(r.accepted, false);
  assert.equal(h.nav.length, 0);
});

test('non-primitive (nested object) parameter values are rejected', () => {
  const h = makeRouter();
  const r = h.router.propose(resp(intent({ parameters: { tab: { nested: 1 } } })), ctx());
  assert.equal(r.accepted, false);
});

// ===========================================================================
// Navigation exception handled honestly
// ===========================================================================

test('a navigation exception is reported honestly, never as completed', async () => {
  const h = makeRouter({
    handlers: { navigate: () => { throw new Error('view failed to load'); } },
  });
  h.router.propose(resp(intent()), ctx());
  const r = await h.router.confirm('i-1');
  assert.equal(r.executed, false);
  assert.equal(r.reason, 'navigation_failed');
  assert.ok(h.events.some((e) => e.t === 'error' && e.x.reason === 'navigation_failed'));
  assert.ok(!h.events.some((e) => e.t === 'executed')); // never reported completed
});

test('a rejected async navigation also fails closed (no unhandled rejection)', async () => {
  const seen = [];
  process.on('unhandledRejection', (e) => seen.push(e));
  const h = makeRouter({
    handlers: { navigate: () => Promise.reject(new Error('async nav fail')) },
  });
  h.router.propose(resp(intent()), ctx());
  const r = await h.router.confirm('i-1');
  await new Promise((res) => setTimeout(res, 10));
  process.removeAllListeners('unhandledRejection');
  assert.equal(r.executed, false);
  assert.deepEqual(seen, []);
});

// ===========================================================================
// Host allowlist gate
// ===========================================================================

test('host allowlist predicate must return primitive true (else denied)', () => {
  for (const val of [false, 1, 'yes', {}, undefined]) {
    const h = makeRouter({ allow: () => val });
    const r = h.router.propose(resp(intent()), ctx());
    assert.equal(r.accepted, false, 'val=' + JSON.stringify(val));
    assert.equal(r.reason, 'denied_by_host');
  }
  const ok = makeRouter({ allow: () => true });
  assert.equal(ok.router.propose(resp(intent()), ctx()).accepted, true);
});

test('a throwing host allowlist fails closed', () => {
  const h = makeRouter({ allow: () => { throw new Error('allow boom'); } });
  const r = h.router.propose(resp(intent()), ctx());
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'allowlist_error');
});

// ===========================================================================
// No side effects at import/construction; business mutation unavailable
// ===========================================================================

test('constructing the router has no side effects (no handler calls, no DOM)', () => {
  const nav = [];
  const router = createUiIntentRouter({
    conversationId: 'c',
    handlers: { navigate: () => nav.push('!'), open_detail: () => nav.push('!'), apply_filter: () => nav.push('!'), focus_reina: () => nav.push('!') },
    allowlist: { navigate: { destinations: ['x'] } },
  });
  assert.equal(nav.length, 0);
  assert.equal(router.getConversationId(), 'c');
  assert.equal(router.getPending(), null);
  // No global DOM was needed to construct (this test runs with no document).
  assert.equal(typeof globalThis.document, 'undefined');
});

test('the router exposes ONLY governed read-only UI seams -- no business mutation', () => {
  const h = makeRouter();
  const surface = Object.keys(h.router).sort();
  // Exactly the governed lifecycle + inert inspectors. No submit/schedule/email/
  // pay/upload/automation/eval seam of any kind.
  assert.deepEqual(surface, [
    'cancel', 'confirm', 'confirmPending', 'dispose',
    'getConversationId', 'getPending', 'isDisposed', 'propose', 'revoke',
  ]);
  const forbidden = ['submit', 'send', 'delete', 'pay', 'upload', 'download', 'schedule', 'automation', 'eval', 'exec', 'mutate', 'write'];
  for (const f of forbidden) assert.equal(f in h.router, false, 'must not expose: ' + f);
});

test('supported kinds are exactly the four governed read-only classes', () => {
  assert.deepEqual(KINDS.slice().sort(), ['apply_filter', 'focus_reina', 'navigate', 'open_detail']);
});

// ===========================================================================
// PR #84 correlation compatibility
// ===========================================================================

test('correlation matches PR #84: conversationId + turnId gate acceptance', () => {
  // Same correlation model as the typed panel: an intent is accepted only when
  // BOTH ids match the in-flight turn context supplied by the host.
  const h = makeRouter({ conversationId: 'conv-XYZ' });
  const good = intent({ conversationId: 'conv-XYZ', turnId: 'turn-42' });
  assert.equal(h.router.propose(resp(good), ctx('turn-42')).accepted, true);
  assert.equal(h.router.propose(resp(good), ctx('turn-43')).accepted, false);
});

test('dispose blocks further propose/confirm', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent()), ctx());
  h.router.dispose();
  assert.equal(h.router.isDisposed(), true);
  assert.equal(h.router.propose(resp(intent()), ctx()).accepted, false);
  const r = await h.router.confirm('i-1');
  assert.equal(r.executed, false);
  assert.equal(h.nav.length, 0);
});

// ===========================================================================
// HARDENING: hostile response/intent values — no getter is ever invoked
// ===========================================================================

function defineGetter(obj, key, get) {
  delete obj[key];
  Object.defineProperty(obj, key, { enumerable: true, configurable: true, get });
  return obj;
}

test('accessor (getter) fields on response/intent are rejected without invoking them', async () => {
  const cases = [
    () => { const r = {}; Object.defineProperty(r, 'uiIntent', { enumerable: true, get() { throw new Error('uiIntent getter ran'); } }); return r; },
    () => resp(defineGetter(intent(), 'version', () => INTENT_VERSION)),
    () => resp(defineGetter(intent(), 'executed', () => false)),
    () => resp(defineGetter(intent(), 'requiresConfirmation', () => true)),
    () => resp(defineGetter(intent(), 'conversationId', () => 'conv-1')),
    () => resp(defineGetter(intent(), 'turnId', () => 't-1')),
    () => resp(defineGetter(intent(), 'intentId', () => 'i-1')),
    () => resp(defineGetter(intent(), 'kind', () => 'navigate')),
    () => resp(defineGetter(intent(), 'destination', () => 'clients')),
    () => resp(defineGetter(intent(), 'expiresAt', () => SOON)),
  ];
  for (const build of cases) {
    const h = makeRouter();
    const r = h.router.propose(build(), ctx()); // must not throw, must not accept via getter
    assert.equal(r.accepted, false);
    assert.equal(h.nav.length, 0);
  }
});

test('inherited (prototype-chain) intent fields are ignored, not trusted', () => {
  const h = makeRouter();
  const proto = intent(); // a fully-valid intent placed on the PROTOTYPE
  const child = Object.create(proto); // owns nothing
  const r = h.router.propose(resp(child), ctx());
  assert.equal(r.accepted, false); // inherited version/kind/etc. are not own -> rejected
  assert.equal(r.reason, 'unrecognized_version');
});

test('a hostile response Proxy (throwing traps) fails closed', () => {
  const h = makeRouter();
  const proxy = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('resp trap boom'); },
    get() { throw new Error('resp get boom'); },
    ownKeys() { throw new Error('resp ownKeys boom'); },
  });
  const r = h.router.propose(proxy, ctx());
  assert.equal(r.accepted, false);
  assert.equal(h.nav.length, 0);
});

test('a Promise-valued intent field is rejected (not awaited)', () => {
  const h = makeRouter();
  assert.equal(h.router.propose(resp(intent({ destination: Promise.resolve('clients') })), ctx()).accepted, false);
  assert.equal(h.router.propose(resp(intent({ expiresAt: Promise.resolve(SOON) })), ctx()).accepted, false);
  assert.equal(h.router.propose(resp(intent({ intentId: Promise.resolve('i-1') })), ctx()).accepted, false);
});

test('a hostile clock (throws / non-finite / promise / string) fails closed at propose and confirm', async () => {
  for (const now of [() => { throw new Error('clock boom'); }, () => NaN, () => Promise.resolve(NOW), () => 'soon']) {
    const h = makeRouter({ now });
    const r = h.router.propose(resp(intent()), ctx());
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'clock_unavailable');
  }
  // Clock that works at propose but breaks at confirm -> nothing executed.
  let t = NOW;
  const h2 = makeRouter({ now: () => { if (t === 'boom') throw new Error('x'); return t; } });
  h2.router.propose(resp(intent()), ctx());
  t = 'boom';
  const cr = await h2.router.confirm('i-1');
  assert.equal(cr.executed, false);
  assert.equal(cr.reason, 'clock_unavailable');
  assert.equal(h2.nav.length, 0);
});

// ===========================================================================
// HARDENING: explicit navigation success (no false success)
// ===========================================================================

test('a handler that resolves without an explicit success signal is NOT reported executed (2)', async () => {
  const bad = [undefined, null, false, 0, '', 'ok', { ok: false }, { okay: true }, {}, [], NaN];
  for (const ret of bad) {
    const nav = [];
    const h = makeRouter({ handlers: { navigate: () => { nav.push(1); return ret; } } });
    h.router.propose(resp(intent()), ctx());
    const r = await h.router.confirm('i-1');
    assert.equal(r.executed, false, 'ret=' + JSON.stringify(ret));
    assert.equal(r.reason, 'navigation_failed'); // unified: resolved-non-success and thrown/rejected both -> navigation_failed
    assert.equal(nav.length, 1); // handler ran, but success was not claimed
  }
});

test('explicit success signals (true and {ok:true}) ARE reported executed', async () => {
  for (const ret of [true, { ok: true }, Promise.resolve(true), Promise.resolve({ ok: true })]) {
    const h = makeRouter({ handlers: { navigate: () => ret } });
    h.router.propose(resp(intent()), ctx());
    const r = await h.router.confirm('i-1');
    assert.equal(r.executed, true, 'ret=' + String(ret));
  }
});

test('a handler success result carried by a getter is NOT trusted (getter not invoked)', async () => {
  const result = {};
  Object.defineProperty(result, 'ok', { enumerable: true, get() { throw new Error('ok getter ran'); } });
  const h = makeRouter({ handlers: { navigate: () => result } });
  h.router.propose(resp(intent()), ctx());
  const r = await h.router.confirm('i-1');
  assert.equal(r.executed, false); // accessor ok -> not an explicit success
  assert.equal(r.reason, 'navigation_failed'); // unified: resolved-non-success and thrown/rejected both -> navigation_failed
});

test('a rejected/throwing handler is navigation_failed, never completed', async () => {
  const rej = makeRouter({ handlers: { navigate: () => Promise.reject(new Error('x')) } });
  rej.router.propose(resp(intent()), ctx());
  assert.equal((await rej.router.confirm('i-1')).reason, 'navigation_failed');
  const thr = makeRouter({ handlers: { navigate: () => { throw new Error('x'); } } });
  thr.router.propose(resp(intent()), ctx());
  assert.equal((await thr.router.confirm('i-1')).reason, 'navigation_failed');
});

// ===========================================================================
// PR #87 -> PR #88 ATTENTION-REVIEW SEAM
// ===========================================================================

function serverReviewResponse(over = {}) {
  return {
    conversationId: 'conv-1', turnId: 'rev-1',
    uiIntent: {
      version: INTENT_VERSION, conversationId: 'conv-1', turnId: 'rev-1',
      intentId: 'review-1', kind: 'navigate', destination: 'attention', parameters: {},
      requiresConfirmation: true, expiresAt: SOON, executed: false, ...over,
    },
  };
}
function reviewRouter() {
  const nav = [];
  const events = [];
  const router = createUiIntentRouter({
    conversationId: 'conv-1', now: () => NOW,
    handlers: { navigate: (d, p) => { nav.push({ d, p }); return { ok: true }; } },
    allowlist: { navigate: { destinations: ['attention'], params: {} } },
    onConfirmRequest: (x) => events.push({ t: 'confirm', x }),
    onExecuted: (x) => events.push({ t: 'executed', x }),
  });
  return { router, nav, events };
}

test('SEAM: server review intent, suppressed second prompt, one confirm -> one navigation', async () => {
  const h = reviewRouter();
  const p = h.router.propose(serverReviewResponse(), { turnId: 'rev-1', suppressConfirmRequest: true });
  assert.equal(p.accepted, true);
  assert.equal(h.events.filter((e) => e.t === 'confirm').length, 0); // no second prompt
  const pend = h.router.getPending();
  assert.equal(pend.intentId, 'review-1');
  const r = await h.router.confirm(pend.intentId, 'voice'); // PR #87 verbal "yes"
  assert.equal(r.executed, true);
  assert.equal(h.nav.length, 1);
  assert.deepEqual(h.nav[0], { d: 'attention', p: {} });
});

test('SEAM: verbal and button "yes" are one path; the second is a no-op (at most once)', async () => {
  const h = reviewRouter();
  h.router.propose(serverReviewResponse(), { turnId: 'rev-1', suppressConfirmRequest: true });
  const id = h.router.getPending().intentId;
  const first = await h.router.confirm(id, 'button');
  const second = await h.router.confirm(id, 'voice');
  const third = await h.router.confirmPending('voice');
  assert.equal(first.executed, true);
  assert.equal(second.executed, false);
  assert.equal(third.executed, false);
  assert.equal(h.nav.length, 1);
});

test('SEAM: a client-FORGED review (no server intent) performs nothing', async () => {
  const h = reviewRouter();
  const p = h.router.propose({ conversationId: 'conv-1', turnId: 'rev-1', clientReview: { destination: 'admin' } }, { turnId: 'rev-1', suppressConfirmRequest: true });
  assert.equal(p.accepted, false);
  assert.equal(h.router.getPending(), null);
  const r = await h.router.confirm('review-1');
  assert.equal(r.executed, false);
  assert.equal(h.nav.length, 0);
});

test('SEAM: a client cannot expand navigation authority — forged destination/categories are inert', async () => {
  const h = reviewRouter();
  h.router.propose(serverReviewResponse(), { turnId: 'rev-1', suppressConfirmRequest: true });
  // confirm takes ONLY an intentId; a client cannot pass a destination/categories.
  const r = await h.router.confirm('review-1', { destination: 'admin', categories: ['payments', 'settings'] });
  assert.equal(r.executed, true);
  assert.deepEqual(h.nav[0], { d: 'attention', p: {} }); // still the server destination
});

test('SEAM: a forged review intent to a non-allowlisted destination is rejected', () => {
  const h = reviewRouter();
  const p = h.router.propose(serverReviewResponse({ destination: 'admin_billing' }), { turnId: 'rev-1', suppressConfirmRequest: true });
  assert.equal(p.accepted, false);
  assert.equal(p.reason, 'destination_not_allowlisted');
});

test('SEAM: stale/replaced/mismatched/expired/missing review intents perform nothing', async () => {
  const a = reviewRouter();
  a.router.propose(serverReviewResponse({ intentId: 'old' }), { turnId: 'rev-1', suppressConfirmRequest: true });
  a.router.propose(serverReviewResponse({ intentId: 'new' }), { turnId: 'rev-1', suppressConfirmRequest: true });
  assert.equal((await a.router.confirm('old')).executed, false);
  assert.equal((await a.router.confirm('new')).executed, true);
  assert.equal(a.nav.length, 1);

  const b = reviewRouter();
  assert.equal(b.router.propose(serverReviewResponse(), { turnId: 'DIFFERENT', suppressConfirmRequest: true }).reason, 'turn_mismatch');

  const c = reviewRouter();
  assert.equal(c.router.propose(serverReviewResponse({ expiresAt: NOW - 1 }), { turnId: 'rev-1', suppressConfirmRequest: true }).reason, 'invalid_expiry');

  const d = reviewRouter();
  assert.equal((await d.router.confirm('review-1')).executed, false);
  assert.equal(d.nav.length, 0);
});

test('SEAM: the server review intent still requires structural executed:false', () => {
  const h = reviewRouter();
  assert.equal(h.router.propose(serverReviewResponse({ executed: true }), { turnId: 'rev-1', suppressConfirmRequest: true }).reason, 'false_execution_claim');
});

// ===========================================================================
// HARDENING v2: revoke seam, re-run host auth, bounded timeout, propose revokes
// ===========================================================================

test('every new propose() revokes the prior pending — even a no-intent/malformed/hostile new response', async () => {
  // no-intent new response
  const a = makeRouter();
  a.router.propose(resp(intent({ intentId: 'first' })), ctx());
  assert.equal(a.router.propose({}, ctx('t-2')).accepted, false);
  assert.deepEqual(await a.router.confirm('first'), { executed: false, reason: 'nothing_pending' });
  assert.equal(a.nav.length, 0);

  // malformed new response
  const b = makeRouter();
  b.router.propose(resp(intent({ intentId: 'first' })), ctx());
  b.router.propose(42, ctx('t-2'));
  assert.equal((await b.router.confirm('first')).executed, false);

  // hostile-proxy new response
  const c = makeRouter();
  c.router.propose(resp(intent({ intentId: 'first' })), ctx());
  c.router.propose(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('x'); } }), ctx('t-2'));
  assert.equal((await c.router.confirm('first')).executed, false);
  assert.equal(c.nav.length, 0);
});

test('confirm of an id that was NEVER pending returns bare {executed:false} (no reason)', async () => {
  const h = makeRouter();
  // Propose rejected (accessor) -> nothing was ever pending under this id.
  const bad = resp(intent());
  Object.defineProperty(bad.uiIntent, 'kind', { enumerable: true, get() { return 'navigate'; } });
  h.router.propose(bad, ctx());
  assert.deepEqual(await h.router.confirm('i-1'), { executed: false });
});

test('bounded navigation timeout: a never-settling handler resolves navigation_timeout and cannot complete later', async () => {
  let lateResolve;
  const nav = [];
  const h = makeRouter({ handlers: { navigate: () => new Promise((res) => { lateResolve = () => { nav.push('late'); res({ ok: true }); }; }) } });
  h.router.propose(resp(intent()), ctx());
  const r = await h.router.confirm('i-1');
  assert.deepEqual(r, { executed: false, reason: 'navigation_timeout' });
  // The handler settling AFTER the timeout must not complete or navigate.
  lateResolve();
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(h.events.some((e) => e.t === 'executed'), false);
  assert.equal(nav.includes('late'), true); // handler body ran, but its late success is dropped
});

test('an injected navigationTimeoutMs is honored', async () => {
  const h = makeRouter({ handlers: { navigate: () => new Promise(() => {}) }, });
  // default is small; explicitly setting it still fails closed to navigation_timeout
  const custom = createUiIntentRouter({
    conversationId: 'conv-1', now: () => NOW, navigationTimeoutMs: 5,
    handlers: { navigate: () => new Promise(() => {}) },
    allowlist: { navigate: { destinations: ['clients'], params: { tab: ['overview'] } } },
  });
  custom.propose(resp(intent()), ctx());
  assert.deepEqual(await custom.confirm('i-1'), { executed: false, reason: 'navigation_timeout' });
});

test('re-run host authorization on the frozen snapshot immediately before navigating (3)', async () => {
  // allow() returns true at propose, false at confirm-time re-check -> no navigation.
  let phase = 'propose';
  const nav = [];
  const h = makeRouter({
    allow: () => phase === 'propose',
    handlers: { navigate: (d) => { nav.push(d); return { ok: true }; } },
  });
  assert.equal(h.router.propose(resp(intent()), ctx()).accepted, true);
  phase = 'confirm';
  const r = await h.router.confirm('i-1');
  assert.equal(r.executed, false);
  assert.equal(r.reason, 'authorization_revoked');
  assert.equal(nav.length, 0); // never navigated
});

test('re-run host authorization: a throwing re-check denies without navigating', async () => {
  let phase = 'propose';
  const nav = [];
  const h = makeRouter({
    allow: () => { if (phase === 'confirm') throw new Error('revoked'); return true; },
    handlers: { navigate: (d) => { nav.push(d); return { ok: true }; } },
  });
  h.router.propose(resp(intent()), ctx());
  phase = 'confirm';
  assert.equal((await h.router.confirm('i-1')).reason, 'authorization_revoked');
  assert.equal(nav.length, 0);
});

test('re-run host authorization sees the FROZEN snapshot, not a re-read response', async () => {
  let seen = null;
  const h = makeRouter({
    allow: (snap) => { seen = snap; return true; },
    handlers: { navigate: () => ({ ok: true }) },
  });
  h.router.propose(resp(intent({ destination: 'clients', parameters: { tab: 'overview' } })), ctx());
  seen = null; // clear the propose-time call
  await h.router.confirm('i-1');
  assert.deepEqual(seen, { kind: 'navigate', destination: 'clients', parameters: { tab: 'overview' }, intentId: 'i-1' });
});

test('revoke() seam: idempotent; a subsequent confirm reports the revoke reason; nothing navigates (4)', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent()), ctx());
  const v1 = h.router.revoke('authorization_expired');
  const v2 = h.router.revoke('something_else'); // idempotent -> keeps first reason
  assert.deepEqual(v1, { revoked: true, reason: 'authorization_expired' });
  assert.deepEqual(v2, { revoked: true, reason: 'authorization_expired' });
  assert.deepEqual(await h.router.confirm('i-1'), { executed: false, reason: 'authorization_expired' });
  assert.equal(h.nav.length, 0);
});

test('revoke() covers logout / session-replacement / turn-replacement reasons', async () => {
  for (const reason of ['logout', 'session_replaced', 'turn_replaced', 'authorization_expired']) {
    const h = makeRouter();
    h.router.propose(resp(intent()), ctx());
    h.router.revoke(reason);
    assert.deepEqual(await h.router.confirm('i-1'), { executed: false, reason });
    assert.equal(h.nav.length, 0);
  }
});

test('revoke() with no/blank reason falls back to a fixed "revoked"', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent()), ctx());
  assert.deepEqual(h.router.revoke(), { revoked: true, reason: 'revoked' });
  assert.deepEqual(await h.router.confirm('i-1'), { executed: false, reason: 'revoked' });
});

test('a fresh propose() after revoke clears the sticky revoke reason', async () => {
  const h = makeRouter();
  h.router.propose(resp(intent({ intentId: 'a' })), ctx());
  h.router.revoke('logout');
  // A brand-new valid proposal starts clean and can be confirmed.
  assert.equal(h.router.propose(resp(intent({ intentId: 'b' })), ctx()).accepted, true);
  assert.equal((await h.router.confirm('b')).executed, true);
  assert.equal(h.nav.length, 1);
});

test('the source label is AUDIT metadata only — it never gates confirmation (7)', async () => {
  // Arbitrary/forged source strings do not grant or deny; only intentId + state do.
  for (const source of ['button', 'voice', 'totally-made-up', '', 42, null]) {
    const h = makeRouter();
    h.router.propose(resp(intent()), ctx());
    const r = await h.router.confirm('i-1', source);
    assert.equal(r.executed, true, 'source=' + String(source));
  }
});

test('propose success return is exactly { accepted:true } (host reads getPending for the id)', () => {
  const h = makeRouter();
  assert.deepEqual(h.router.propose(resp(intent()), ctx()), { accepted: true });
  assert.equal(h.router.getPending().intentId, 'i-1'); // id comes from getPending, not the return
});

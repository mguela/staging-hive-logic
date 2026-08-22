// test/reina-login-brief-controller.test.mjs
// Focused tests for the authenticated login greeting + attention-summary
// controller, with the CORRECTED confirmation contract: the controller creates
// no navigation authority; it holds only the server-issued pending intentId and,
// on a single button/verbal "yes", calls a narrow host confirmIntent(intentId)
// seam with the EXACT id. A router-shaped injected DOUBLE proves the seam (it
// does NOT duplicate PR #88's validation). Covers: personalized greeting; server-
// only name/counts; unavailable disclosure; honest no-source wording; one
// confirmation of the exact pending id via one seam (button + verbal); no second
// prompt; categories display-only; and fail-closed on missing/malformed/expired/
// replaced/stale intent, session mismatch/expiry, duplicate confirm, throwing/
// rejecting/promise-shaped/malformed deps, navigation failure, and hostile
// bootstrap (accessors/inherited/proxy/HTML/control). Pure — no DOM/network.
//
//   node --test test/reina-login-brief-controller.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import RLB from '../public/reina-login-brief-controller.js';
import RTP from '../public/reina-typed-panel-controller.js'; // PR #84 compatibility

const { createLoginBrief, EXECUTION_STATEMENT, PREVIEW_NOTICE, TRUSTED_VOICE_SOURCE } = RLB;
const PENDING = 'srv-intent-7f3a';

// A trusted final-transcript voice event as the host would stamp it.
function voiceEvent(brief, over = {}) {
  return Object.assign({ source: TRUSTED_VOICE_SOURCE, final: true, generation: brief.getGeneration(), eventId: 'vevt-1', text: 'yes' }, over);
}

function goodBootstrap(over = {}) {
  return Object.assign({
    ok: true,
    user: { displayName: 'Chris' },
    attention: {
      total: 5,
      categories: [
        { key: 'jobs', label: 'Jobs', count: 3, available: true, asOf: '2026-08-02T14:00:00Z', evidence: ['DEMO-231', 'DEMO-240'] },
        { key: 'invoices', label: 'Invoices', count: 2, available: true, asOf: '2026-08-02T14:00:00Z', evidence: ['INV-9'] },
      ],
      unavailableSources: [],
      asOf: '2026-08-02T14:00:00Z',
    },
    review: { intentId: PENDING, available: true, expiresAt: '2026-08-02T15:00:00Z' },
    executed: false,
  }, over);
}
// Router-shaped DOUBLE: confirms ONLY a known pending id; unknown/expired -> fail.
// (This mimics the governed router's confirm-by-id surface; it does not re-implement
//  PR #88's validation.)
function routerDouble(over = {}) {
  const calls = [];
  const known = over.known || PENDING;
  const confirmIntent = over.confirmIntent || ((intentId) => { calls.push(intentId); return intentId === known ? { ok: true, navigatedTo: 'attention-review' } : { ok: false, reason: 'unknown_intent' }; });
  return { calls, confirmIntent };
}
function harness(over = {}) {
  const views = []; const boots = [];
  const rd = over.router || routerDouble(over);
  const bootImpl = over.bootImpl || ((session) => { boots.push(session); return Promise.resolve(over.boot || goodBootstrap()); });
  const brief = createLoginBrief({
    fetchBootstrap: (s) => bootImpl(s),
    confirmIntent: rd.confirmIntent,
    onView: (vm) => views.push(vm),
    timeOfDay: over.timeOfDay || (() => 'morning'),
  });
  return { brief, views, boots, calls: rd.calls, last: () => views[views.length - 1] };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── construction ─────────────────────────────────────────────────────────────
test('requires injected fetchBootstrap and a narrow confirmIntent seam', () => {
  assert.throws(() => createLoginBrief({ confirmIntent: () => {} }), /fetchBootstrap/);
  assert.throws(() => createLoginBrief({ fetchBootstrap: () => {} }), /confirmIntent/);
});

// ── greeting (server-only name), totals, disclosure, honest wording ──────────
test('greets by the SERVER name with a time-appropriate greeting and the ONE review question', async () => {
  const h = harness(); h.brief.onAuthenticated({ sessionId: 's1' }); await tick();
  assert.equal(h.brief.getState(), 'greeted');
  assert.equal(h.last().greeting, 'Good morning, Chris.');
  assert.match(h.last().attentionSummary, /5 items needing your attention/);
  assert.equal(h.last().question, 'Would you like to review them?');
  assert.equal(h.last().executionNotice, EXECUTION_STATEMENT);
  assert.equal(h.last().previewNotice, PREVIEW_NOTICE);
});
test('time-unavailable clock yields a generic greeting; totals + breakdown shown', async () => {
  const h = harness({ timeOfDay: () => null }); h.brief.onAuthenticated('s1'); await tick();
  assert.equal(h.last().greeting, 'Hello, Chris.');
  assert.equal(h.last().total, 5);
  assert.deepEqual(h.last().categories.map((c) => [c.label, c.count]), [['Jobs', 3], ['Invoices', 2]]);
});
test('unauthenticated session is denied; never greets', async () => {
  const h = harness();
  assert.equal(h.brief.onAuthenticated({}).accepted, false);
  assert.equal(h.brief.onAuthenticated('').reason, 'invalid_session');
  assert.equal(h.brief.getState(), 'idle');
});
test('an unavailable source is disclosed and excluded from the total (never zero)', async () => {
  const boot = goodBootstrap({ attention: { total: 3, categories: [
    { key: 'jobs', label: 'Jobs', count: 3, available: true, asOf: '2026-08-02T14:00:00Z', evidence: ['DEMO-231'] },
    { key: 'invoices', label: 'Invoices', count: 0, available: false },
  ], unavailableSources: [], asOf: '2026-08-02T14:00:00Z' } });
  const h = harness({ boot }); h.brief.onAuthenticated('s1'); await tick();
  assert.equal(h.last().total, 3);
  assert.ok(h.last().unavailableDisclosures.some((d) => /Invoices source is unavailable/.test(d)));
});
test('with no available attention it uses the exact honest wording', async () => {
  const boot = goodBootstrap({ attention: { total: 0, categories: [{ key: 'jobs', label: 'Jobs', count: 0, available: false }], unavailableSources: [], asOf: '2026-08-02T14:00:00Z' }, review: { intentId: PENDING, available: false } });
  const h = harness({ boot }); h.brief.onAuthenticated('s1'); await tick();
  assert.equal(h.last().attentionSummary, 'No attention items were found in the connected sources.');
});

// ── ONE confirmation of the EXACT server pending id via ONE seam ─────────────
test('button "yes" confirms exactly the server-issued pending intentId (only) via the host seam', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick();
  const r = await h.brief.confirmReview('button');
  assert.equal(r.accepted, true);
  assert.equal(r.intentId, PENDING);
  assert.equal(h.brief.getState(), 'review_requested');
  assert.deepEqual(h.calls, [PENDING], 'seam called once with ONLY the exact server id');
  // no second confirmation prompt after the decision
  assert.equal(h.last().question, '');
});
test('a TRUSTED voice final-transcript "yes" uses the SAME seam and the SAME exact pending id', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick();
  h.brief.onVoiceEnabled();
  const r = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { text: 'yes, please' }));
  assert.equal(r.accepted, true);
  assert.deepEqual(h.calls, [PENDING]);
});
test('the controller emits no client-built navigation intent — the seam only ever receives the opaque id', async () => {
  let received;
  const h = harness({ router: { calls: [], confirmIntent: (arg) => { received = arg; return { ok: true }; } } });
  h.brief.onAuthenticated('s1'); await tick();
  await h.brief.confirmReview('button');
  assert.equal(typeof received, 'string', 'seam receives a bare id string, not an intent object');
  assert.equal(received, PENDING);
});
test('categories cannot influence the confirmation (display-only)', async () => {
  // hostile-looking category keys/labels must never reach the seam
  const boot = goodBootstrap({ attention: { total: 1, categories: [{ key: 'jobs', label: 'Jobs', count: 1, available: true, asOf: '2026-08-02T14:00:00Z', evidence: ['x'] }], unavailableSources: [], asOf: '2026-08-02T14:00:00Z' } });
  const h = harness({ boot }); h.brief.onAuthenticated('s1'); await tick();
  await h.brief.confirmReview('button');
  assert.deepEqual(h.calls, [PENDING], 'still only the server id; categories carry no authority');
});

// ── decline / unrelated / duplicate do nothing ───────────────────────────────
test('decline, unrelated verbal, and duplicate button/verbal confirm perform nothing extra', async () => {
  const dec = harness(); dec.brief.onAuthenticated('s1'); await tick();
  dec.brief.decline('button');
  assert.equal(dec.brief.getState(), 'declined'); assert.equal(dec.calls.length, 0);

  const un = harness(); un.brief.onAuthenticated('s1'); await tick();
  assert.equal((await un.brief.respond('what is the weather?', 'voice')).reason, 'unrelated');
  assert.equal(un.calls.length, 0); assert.equal(un.brief.getState(), 'greeted');

  const dup = harness(); dup.brief.onAuthenticated('s1'); await tick();
  await dup.brief.confirmReview('button');
  const second = await dup.brief.confirmReview('voice');
  assert.equal(second.accepted, false);
  assert.equal(dup.calls.length, 1, 'exactly one confirmation of the pending id');
});

// ── fail-closed: missing/malformed/expired/replaced/stale intent ─────────────
test('a missing pending intentId fails the confirmation closed (no seam call, no success)', async () => {
  const boot = goodBootstrap({ review: undefined });
  const h = harness({ boot }); h.brief.onAuthenticated('s1'); await tick();
  const r = await h.brief.confirmReview('button');
  assert.equal(r.accepted, false); assert.equal(r.reason, 'no_pending_intent');
  assert.equal(h.brief.getState(), 'review_failed');
  assert.equal(h.calls.length, 0);
});
test('a malformed review (bad/HTML/oversized intentId, or non-object) rejects the whole bootstrap', async () => {
  for (const review of [{ intentId: '' }, { intentId: '<script>x</script>' }, { intentId: 'a'.repeat(201) }, { intentId: 123 }, 'not-an-object', { available: true }]) {
    const h = harness({ boot: goodBootstrap({ review }) });
    h.brief.onAuthenticated('s1'); await tick();
    assert.equal(h.brief.getState(), 'unavailable', `${JSON.stringify(review)} must reject`);
  }
});
test('an expired/replaced/unknown pending intent fails closed at the router seam (navigation failure)', async () => {
  const h = harness({ boot: goodBootstrap({ review: { intentId: 'stale-id', available: true } }) }); // router double only knows PENDING
  h.brief.onAuthenticated('s1'); await tick();
  const r = await h.brief.confirmReview('button');
  assert.equal(r.accepted, false);
  assert.equal(h.brief.getState(), 'review_failed');
  assert.deepEqual(h.calls, ['stale-id'], 'attempted the exact id; router rejected it');
});
test('auth expiry mid-confirm makes the pending intent stale; success is never claimed', async () => {
  let release;
  const router = { calls: [], confirmIntent: (id) => { router.calls.push(id); return new Promise((res) => { release = () => res({ ok: true }); }); } };
  const h = harness({ router }); h.brief.onAuthenticated('s1'); await tick();
  const pending = h.brief.confirmReview('button');
  h.brief.onAuthExpired();               // session superseded while confirm is in flight
  release();
  const r = await pending;
  assert.equal(r.accepted, false); assert.equal(r.reason, 'stale_intent');
  assert.equal(h.brief.getState(), 'expired');
});

// ── fail-closed: hostile injected confirmIntent dependencies ─────────────────
test('throwing / rejecting / promise-shaped / malformed confirmIntent all fail closed', async () => {
  const thrower = harness({ router: { calls: [], confirmIntent: () => { throw new Error('boom'); } } });
  thrower.brief.onAuthenticated('s1'); await tick();
  assert.equal((await thrower.brief.confirmReview('button')).reason, 'confirm_threw');
  assert.equal(thrower.brief.getState(), 'review_failed');

  const rejecter = harness({ router: { calls: [], confirmIntent: () => Promise.reject(new Error('nope')) } });
  rejecter.brief.onAuthenticated('s1'); await tick();
  assert.equal((await rejecter.brief.confirmReview('button')).reason, 'confirm_rejected');

  const malformed = harness({ router: { calls: [], confirmIntent: () => 42 } });
  malformed.brief.onAuthenticated('s1'); await tick();
  assert.equal((await malformed.brief.confirmReview('button')).reason, 'malformed_confirm_result');

  const navFail = harness({ router: { calls: [], confirmIntent: () => ({ ok: false, reason: 'navigation_failed' }) } });
  navFail.brief.onAuthenticated('s1'); await tick();
  const r = await navFail.brief.confirmReview('button');
  assert.equal(r.accepted, false); assert.equal(r.reason, 'navigation_failed');
  assert.equal(navFail.brief.getState(), 'review_failed');
});
test('a promise-shaped confirmIntent that resolves ok is accepted once', async () => {
  const h = harness({ router: { calls: [], confirmIntent: (id) => { h && null; return Promise.resolve({ ok: true }); } } });
  h.brief.onAuthenticated('s1'); await tick();
  assert.equal((await h.brief.confirmReview('button')).accepted, true);
});

// ── duplicate-greeting suppression + fresh session + auth-expiry clearing ────
test('duplicate greeting for the same session suppressed; a new session greets fresh', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick();
  const n = h.views.length;
  assert.equal(h.brief.onAuthenticated('s1').reason, 'already_greeted');
  assert.equal(h.views.length, n);
  h.brief.onAuthenticated('s2'); await tick();
  assert.equal(h.brief.getState(), 'greeted');
});
test('auth expiry clears greeting + pending review and ignores a late bootstrap', async () => {
  let resolveBoot;
  const h = harness({ bootImpl: () => new Promise((res) => { resolveBoot = res; }) });
  h.brief.onAuthenticated('s1');
  h.brief.onAuthExpired();
  assert.equal(h.brief.getState(), 'expired');
  assert.equal(h.brief.getPendingIntentId(), null);
  resolveBoot(goodBootstrap()); await tick();
  assert.equal(h.brief.getState(), 'expired');
});

// ── Voice: written before enable; optional speech-safe only after enable ─────
test('written greeting before Voice; speech-safe exposed ONLY after explicit Voice enable, same text', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick();
  assert.equal(h.last().speechSafe, null);
  assert.equal(h.brief.getSpeechSafe(), null);
  h.brief.onVoiceEnabled();
  const spoken = h.brief.getSpeechSafe();
  assert.ok(spoken && spoken.includes('Good morning, Chris.'));
  assert.equal(h.last().speechSafe, spoken);
});

// ── hostile bootstrap fail-closed (unchanged guarantees) ─────────────────────
test('malformed/inconsistent totals, bad counts, dup keys, invalid timestamps reject', async () => {
  const bad = [
    { attention: { total: -1, categories: [], unavailableSources: [], asOf: '2026-08-02T14:00:00Z' } },
    { attention: { total: 1.5, categories: [{ key: 'a', label: 'A', count: 2, available: true, asOf: '2026-08-02T14:00:00Z' }], unavailableSources: [] } },
    { attention: { total: 99, categories: [{ key: 'a', label: 'A', count: 3, available: true, asOf: '2026-08-02T14:00:00Z' }], unavailableSources: [] } },
    { attention: { total: 4, categories: [{ key: 'a', label: 'A', count: 2, available: true, asOf: '2026-08-02T14:00:00Z' }, { key: 'a', label: 'B', count: 2, available: true, asOf: '2026-08-02T14:00:00Z' }], unavailableSources: [] } },
    { attention: { total: 2, categories: [{ key: 'a', label: 'A', count: 2, available: true, asOf: 'not-a-date' }], unavailableSources: [] } },
  ];
  for (const over of bad) { const h = harness({ boot: goodBootstrap(over) }); h.brief.onAuthenticated('s1'); await tick(); assert.equal(h.brief.getState(), 'unavailable', JSON.stringify(over)); }
});
test('HTML/script/control, forged execution, accessor/inherited/proxy bootstraps reject', async () => {
  const html = harness({ boot: goodBootstrap({ user: { displayName: '<img src=x onerror=alert(1)>' } }) }); html.brief.onAuthenticated('s1'); await tick();
  assert.equal(html.brief.getState(), 'unavailable');
  const forged = harness({ boot: goodBootstrap({ executed: true }) }); forged.brief.onAuthenticated('s1'); await tick();
  assert.equal(forged.brief.getState(), 'unavailable');
  const acc = goodBootstrap(); Object.defineProperty(acc.user, 'displayName', { get() { throw new Error('nope'); }, enumerable: true, configurable: true });
  const h1 = harness({ boot: acc }); h1.brief.onAuthenticated('s1'); await tick(); assert.equal(h1.brief.getState(), 'unavailable');
  const inh = goodBootstrap(); inh.user = Object.create({ displayName: 'Ghost' });
  const h2 = harness({ boot: inh }); h2.brief.onAuthenticated('s1'); await tick(); assert.equal(h2.brief.getState(), 'unavailable');
  const px = new Proxy({}, { get() { throw new Error('trap'); }, getOwnPropertyDescriptor() { return undefined; } });
  const h3 = harness({ boot: px }); h3.brief.onAuthenticated('s1'); await tick(); assert.equal(h3.brief.getState(), 'unavailable');
  const mm = harness({ boot: goodBootstrap({ sessionId: 'OTHER' }) }); mm.brief.onAuthenticated('s1'); await tick(); assert.equal(mm.brief.getState(), 'unavailable');
});

// ── no mic/speech/navigation/network/business globals ────────────────────────
test('controller source references no mic/speech/navigation/network/business globals', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'reina-login-brief-controller.js'), 'utf8');
  for (const banned of ['SpeechRecognition', 'getUserMedia', 'mediaDevices', 'speechSynthesis', 'location.href', 'location.assign', 'window.open', 'document.', 'fetch(', 'XMLHttpRequest', 'innerHTML', 'localStorage', 'sessionStorage', '/api/', 'twilio']) {
    assert.ok(!src.includes(banned), `must not reference "${banned}"`);
  }
});

// ═══ FIX 1 — voice confirmation only via a trusted unique final transcript ═══
test('a PLAIN respond("yes","voice") performs nothing (no trusted transcript event)', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick(); h.brief.onVoiceEnabled();
  const r = await h.brief.respond('yes', 'voice');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'voice_requires_trusted_event');
  assert.equal(h.calls.length, 0, 'seam never called from a plain verbal string');
  assert.equal(h.brief.getState(), 'greeted');
});
test('voice confirmation is denied when Voice is disabled', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick(); // Voice NOT enabled
  const r = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief));
  assert.equal(r.accepted, false); assert.equal(r.reason, 'voice_disabled');
  assert.equal(h.calls.length, 0);
});
test('untrusted source, non-final, and stale generation transcripts perform nothing', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick(); h.brief.onVoiceEnabled();
  assert.equal((await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { source: 'attacker' }))).reason, 'untrusted_source');
  assert.equal((await h.brief.submitVoiceConfirmation('yes')).reason, 'untrusted_event');
  assert.equal((await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { final: false }))).reason, 'not_final');
  assert.equal((await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { generation: h.brief.getGeneration() - 1 }))).reason, 'stale_generation');
  assert.equal((await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { eventId: {} }))).reason, 'invalid_event_id');
  assert.equal(h.calls.length, 0, 'no confirmation from any untrusted/mismatched transcript');
});
test('a duplicate final-transcript eventId is consumed once (dedup while still greeted)', async () => {
  // unrelated text keeps state 'greeted' so the consumed-token guard is the one
  // that fires on the replayed eventId.
  const h = harness(); h.brief.onAuthenticated('s1'); await tick(); h.brief.onVoiceEnabled();
  const first = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { eventId: 'dup-1', text: 'hmm maybe' }));
  assert.equal(first.reason, 'unrelated'); assert.equal(h.brief.getState(), 'greeted');
  const replay = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { eventId: 'dup-1', text: 'yes' }));
  assert.equal(replay.accepted, false); assert.equal(replay.reason, 'duplicate_transcript');
  assert.equal(h.calls.length, 0, 'a replayed eventId never confirms');
});
test('a repeated "yes" transcript confirms at most once', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick(); h.brief.onVoiceEnabled();
  const first = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { eventId: 'y1', text: 'yes' }));
  assert.equal(first.accepted, true);
  const again = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { eventId: 'y2', text: 'yes' }));
  assert.equal(again.accepted, false, 'a second yes does nothing');
  assert.equal(h.calls.length, 1, 'exactly one confirmation');
});
test('a trusted final-transcript "no" declines; consumed tokens reset on session replacement', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick(); h.brief.onVoiceEnabled();
  const dec = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { text: 'no thanks', eventId: 'n1' }));
  assert.equal(dec.accepted, true); assert.equal(h.brief.getState(), 'declined');
  // new session: Voice must be re-enabled and prior transcript tokens are cleared
  h.brief.onAuthenticated('s2'); await tick();
  assert.equal(h.brief.getSpeechSafe(), null, 'Voice reset to disabled on the new session');
  h.brief.onVoiceEnabled();
  const reused = await h.brief.submitVoiceConfirmation(voiceEvent(h.brief, { eventId: 'n1' })); // same id, new session
  assert.equal(reused.accepted, true, 'prior-session token does not block the new session');
});

// ═══ FIX 2 — descriptor/proxy-trap containment + single bounded sessionId ════
test('a throwing getOwnPropertyDescriptor trap is contained (no raw exception escapes)', async () => {
  // bootstrap whose descriptor trap throws on every property
  const evil = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('SECRET-TRAP-MARKER'); }, get() { throw new Error('SECRET-TRAP-MARKER'); } });
  const h = harness({ boot: evil });
  // must not throw; must fail closed
  await assert.doesNotReject(async () => { h.brief.onAuthenticated('s1'); await tick(); });
  assert.equal(h.brief.getState(), 'unavailable');
  // no secret marker leaked into any emitted view
  assert.ok(!JSON.stringify(h.views).includes('SECRET-TRAP-MARKER'));
});
test('a hostile session object with a throwing descriptor trap yields invalid_session, not a throw', () => {
  const evilSession = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('SECRET-SESSION-MARKER'); } });
  const h = harness();
  let r;
  assert.doesNotThrow(() => { r = h.brief.onAuthenticated(evilSession); });
  assert.equal(r.accepted, false); assert.equal(r.reason, 'invalid_session');
});
test('sessionId is read once into a bounded primitive snapshot; a mutating getter cannot change it later', async () => {
  // a session whose sessionId is a data prop is read once; even if the object is
  // mutated afterward, the controller keeps its primitive snapshot.
  const session = { sessionId: 's-snap' };
  const h = harness(); h.brief.onAuthenticated(session); await tick();
  assert.equal(h.brief.getSessionId(), 's-snap');
  session.sessionId = 's-CHANGED';
  assert.equal(h.brief.getSessionId(), 's-snap', 'snapshot is not reread from the hostile object');
  // oversized / hostile session ids are rejected
  assert.equal(h.brief.onAuthenticated({ sessionId: 'x'.repeat(201) }).reason, 'invalid_session');
  assert.equal(h.brief.onAuthenticated({ sessionId: '<script>x</script>' }).reason, 'invalid_session');
});
test('auth expiry resets Voice-enabled + consumed tokens', async () => {
  const h = harness(); h.brief.onAuthenticated('s1'); await tick(); h.brief.onVoiceEnabled();
  assert.ok(h.brief.getSpeechSafe() !== null);
  h.brief.onAuthExpired();
  assert.equal(h.brief.getSpeechSafe(), null, 'Voice disabled after expiry');
});

// ── PR #84 compatibility ─────────────────────────────────────────────────────
test('shares the exact preview + execution notices with the PR #84 typed panel', () => {
  assert.equal(EXECUTION_STATEMENT, RTP.EXECUTION_STATEMENT);
  assert.equal(PREVIEW_NOTICE, RTP.PREVIEW_NOTICE);
});

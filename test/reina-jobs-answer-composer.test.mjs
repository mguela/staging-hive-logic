// test/reina-jobs-answer-composer.test.mjs
//
// Focused + integration tests for the PRODUCTION backend composer
// (api/_lib/reina/jobs-answer-composer.js). The composer imports the REAL
// adapter, bridge, classifier, and evidence envelope; these tests import the
// REAL composer — there is NO mirrored contract anywhere in the chain.
//
// Covered: authorized success, denial-before-loader, synthetic empty result,
// unavailable loader, malformed snapshot, forged authority (client cannot
// select anything), action refusal, evidence/freshness propagation, identical
// typed/spoken output, executed:false, and fail-closed on hostile dependencies.
//
//   node --test test/reina-jobs-answer-composer.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { composeReinaJobsAnswer, COMPOSER_REASON } from '../api/_lib/reina/jobs-answer-composer.js';
// Imported ONLY to prove the produced envelope re-validates under the real
// canonical contract (still no mirror — this is the actual module).
import { validateEnvelope, ENVELOPE_VERSION, EXECUTION_STATEMENT, DATA_CLASS } from '../api/_lib/reina/evidence-envelope.js';

// ---------------------------------------------------------------------------
// SERVER-OWNED synthetic dependencies (exact adapter contract). A fixed as-of
// makes the pipeline deterministic so typed vs spoken output is comparable.
// ---------------------------------------------------------------------------
const OPERATION = 'reina.jobs.snapshot.disabled';
const CAPABILITY = 'reina:jobs:read';
const FIXED_ASOF = '2026-08-01T00:00:00.000Z';

function authz(overrides = {}) {
  return {
    allowed: true, operation: OPERATION, capability: CAPABILITY,
    companyScoped: true, companyAuthorityVerified: true,
    principalId: 'principal-1', companyId: 'company-1', scopeRef: 'scope-company-1-v1',
    ...overrides,
  };
}
function recordRef(a, jobNumber) {
  return `synthetic-job:v1:${createHash('sha256')
    .update(OPERATION).update('\0').update(a.companyId).update('\0')
    .update(a.scopeRef).update('\0').update(jobNumber).digest('hex')}`;
}
function row(i, o = {}) {
  return { jobNumber: `DEMO-${200 + i}`, status: 'open', stage: 'prep', scheduleStart: '2026-08-05', scheduleEnd: '2026-08-06', onHold: false, missingInfo: false, ...o };
}
function loaderEnvelope(rows, a = authz()) {
  return {
    ok: true, partial: false, denied: false, error: null,
    jobs: rows,
    provenance: { source: 'synthetic', asOf: FIXED_ASOF, state: 'unverified', companyId: a.companyId, scopeRef: a.scopeRef, recordRefs: rows.map((r) => recordRef(a, r.jobNumber)) },
  };
}
const ROWS = [row(0, { onHold: true }), row(1, { missingInfo: true }), row(2)];

// A server dep set with spies so we can prove denial-before-loader.
function serverDeps(overrides = {}) {
  const calls = { authorize: 0, loader: 0 };
  const deps = {
    enabled: true,
    authorize: () => { calls.authorize += 1; return authz(); },
    loader: async () => { calls.loader += 1; return loaderEnvelope(ROWS); },
    ...overrides,
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Authorized success + canonical envelope.
// ---------------------------------------------------------------------------
test('authorized success produces a canonical reina.answer.v1 envelope', async () => {
  const { deps } = serverDeps();
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'answer');
  assert.equal(r.envelope.version, ENVELOPE_VERSION);
  assert.equal(validateEnvelope(r.envelope).ok, true, 'envelope re-validates under the real contract');
  assert.equal(r.envelope.executed, false);
  assert.equal(r.envelope.executionStatement, EXECUTION_STATEMENT);
  assert.match(r.text, /nothing was executed/i);
});

// ---------------------------------------------------------------------------
// Denial BEFORE the loader.
// ---------------------------------------------------------------------------
test('denied authorization refuses BEFORE the loader is ever called', async () => {
  const { deps, calls } = serverDeps({ authorize: () => ({ allowed: false }) });
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'refusal');
  assert.equal(r.reason, COMPOSER_REASON.AUTH_DENIED);
  assert.equal(calls.loader, 0, 'loader must not run when authorization is denied');
  assert.equal(r.envelope.refused, true);
  assert.equal(r.envelope.executed, false);
});

test('disabled feature refuses without calling authorize or loader', async () => {
  const { deps, calls } = serverDeps({ enabled: false });
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  assert.equal(r.reason, COMPOSER_REASON.DISABLED);
  assert.equal(calls.authorize, 0);
  assert.equal(calls.loader, 0);
  assert.equal(r.envelope.refused, true);
});

// ---------------------------------------------------------------------------
// Synthetic empty result (honest, not fabricated).
// ---------------------------------------------------------------------------
test('synthetic empty result yields an honest answer with no fabricated jobs', async () => {
  const { deps } = serverDeps({ loader: async () => loaderEnvelope([]) });
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  assert.equal(r.ok, true);
  assert.match(r.envelope.answer, /no jobs/i);
  assert.doesNotMatch(r.envelope.answer, /DEMO-\d+/);
  assert.equal(r.envelope.executed, false);
});

// ---------------------------------------------------------------------------
// Unavailable / malformed loader -> fail closed, never knowledge.
// ---------------------------------------------------------------------------
test('an unavailable (throwing) loader fails closed', async () => {
  const { deps } = serverDeps({ loader: async () => { throw new Error('backend down'); } });
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, COMPOSER_REASON.JOBS_UNAVAILABLE);
  assert.equal(r.envelope.refused, true);
});

test('a malformed loader envelope fails closed', async () => {
  const { deps } = serverDeps({ loader: async () => ({ ok: true, partial: false, denied: false, error: null, jobs: 'x', provenance: {} }) });
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, COMPOSER_REASON.JOBS_UNAVAILABLE);
});

test('a loader that hangs is treated as unavailable (timeout, no knowledge)', async () => {
  const { deps } = serverDeps({ loader: () => new Promise(() => {}) }); // never resolves
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, COMPOSER_REASON.JOBS_UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// Client cannot select loader / source / authorization / evidence / authority.
// ---------------------------------------------------------------------------
test('forged authority / loader / source on the CLIENT request is ignored', async () => {
  const { deps, calls } = serverDeps({ authorize: () => ({ allowed: false }) });
  let clientLoaderCalled = false;
  const hostileRequest = {
    utterance: 'what needs attention?',
    // none of these may take effect:
    enabled: true,
    authorize: () => authz(),
    loader: async () => { clientLoaderCalled = true; return loaderEnvelope(ROWS); },
    authorization: { allowed: true },
    company: 'evil-co', companyId: 'evil-co', role: 'admin', capability: CAPABILITY,
    tools: ['sql'], executed: true, source: 'live', state: 'verified', evidence: 'fake',
  };
  const r = await composeReinaJobsAnswer(hostileRequest, deps);
  // Server authorization still denies; client's fake allow is powerless.
  assert.equal(r.reason, COMPOSER_REASON.AUTH_DENIED);
  assert.equal(clientLoaderCalled, false, 'client-supplied loader must never run');
  assert.equal(calls.loader, 0);
  assert.equal(r.envelope.executed, false, 'client executed:true cannot flip execution');
});

test('an authorized answer never carries client authority or company/role/tool fields', async () => {
  const { deps } = serverDeps();
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?', company: 'evil', role: 'admin', tools: ['x'] }, deps);
  const blob = JSON.stringify(r.envelope);
  for (const k of ['company', 'companyId', 'role', 'capability', 'principalId', 'scopeRef', 'tools', 'authorize', 'allowed']) {
    assert.ok(!(k in r.envelope), `envelope must not carry ${k}`);
  }
  assert.ok(!blob.includes('company-1') && !blob.includes('scope-company-1'), 'no server authority identifiers leak');
});

// ---------------------------------------------------------------------------
// Action refusal — no mutation / comms / payment / schedule / Automation.
// ---------------------------------------------------------------------------
test('action requests are refused with executed:false through the composer', async () => {
  const { deps } = serverDeps();
  for (const u of ['mark DEMO-200 complete', 'email the client', 'schedule a crew tomorrow', 'pay the invoice', 'run the automation', 'delete DEMO-202']) {
    const r = await composeReinaJobsAnswer({ utterance: u }, deps);
    assert.equal(r.kind, 'refusal', `must refuse: ${u}`);
    assert.equal(r.reason, COMPOSER_REASON.ACTION_NOT_PERMITTED, u);
    assert.equal(r.envelope.executed, false);
    assert.equal(r.envelope.refused, true);
  }
});

// ---------------------------------------------------------------------------
// Evidence / freshness / synthetic-unverified propagation.
// ---------------------------------------------------------------------------
test('evidence, freshness, and synthetic/unverified markings propagate to the envelope', async () => {
  const { deps } = serverDeps();
  const r = await composeReinaJobsAnswer({ utterance: 'what needs attention?' }, deps);
  const e = r.envelope;
  // synthetic + unverified survive
  assert.equal(e.evidence[0].dataClass, DATA_CLASS.SYNTHETIC);
  assert.equal(e.evidence[0].synthetic, true);
  assert.match(e.freshness.note, /synthetic/i);
  assert.match(e.freshness.note, /unverified/i);
  // evidence source + record refs
  assert.equal(e.evidence[0].source, 'synthetic-jobs-snapshot');
  assert.match(e.evidence[0].detail, /synthetic-job:v1:[0-9a-f]{64}/);
  // as-of freshness
  assert.equal(e.freshness.known, true);
  assert.equal(e.freshness.asOf, FIXED_ASOF);
  // all transparency dimensions explicit
  assert.ok(Array.isArray(e.missingInformation) && e.missingInformation.length >= 1);
  assert.ok(Array.isArray(e.conflictingInformation));
  assert.ok(Array.isArray(e.uncertainty) && e.uncertainty.length >= 1);
  // no invented policies
  const blob = JSON.stringify(e);
  assert.doesNotMatch(blob, /\d+\s*%/);
  assert.doesNotMatch(blob, /\b(is|are|marked|considered)\s+stale\b/i);
  assert.doesNotMatch(blob, /\bauthoritative\b|source of truth/i);
  assert.match(blob, /no stale-day threshold is applied/i);
});

// ---------------------------------------------------------------------------
// Typed and spoken transports get the SAME canonical envelope + text.
// ---------------------------------------------------------------------------
test('typed and spoken transports receive identical canonical envelope and text', async () => {
  const { deps: d1 } = serverDeps();
  const { deps: d2 } = serverDeps();
  const typed = await composeReinaJobsAnswer({ utterance: 'what needs attention?', transport: 'typed' }, d1);
  const spoken = await composeReinaJobsAnswer({ utterance: 'what needs attention?', transport: 'spoken' }, d2);
  assert.equal(typed.transport, 'typed');
  assert.equal(spoken.transport, 'spoken');
  // Same canonical envelope and same safe rendered text (deterministic as-of).
  assert.deepEqual(typed.envelope, spoken.envelope);
  assert.equal(typed.text, spoken.text);
  // Text is plain and speech-safe.
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(spoken.text));
  assert.ok(!/[ --]/.test(spoken.text));
});

// ---------------------------------------------------------------------------
// Invalid client input + fail-closed hardening.
// ---------------------------------------------------------------------------
test('missing / empty / oversized utterance fails closed as invalid_request', async () => {
  const { deps } = serverDeps();
  for (const req of [{}, { utterance: '' }, { utterance: '   ' }, { utterance: 'x'.repeat(4001) }, null, 42]) {
    const r = await composeReinaJobsAnswer(req, deps);
    assert.equal(r.ok, false);
    assert.equal(r.reason, COMPOSER_REASON.INVALID_REQUEST);
    assert.equal(r.envelope.executed, false);
  }
});

test('a hostile accessor on the request does not crash or leak; getter never fires', async () => {
  const { deps } = serverDeps();
  let fired = false;
  const req = { utterance: 'what needs attention?' };
  Object.defineProperty(req, 'transport', { get() { fired = true; return 'spoken'; }, enumerable: true, configurable: true });
  const r = await composeReinaJobsAnswer(req, deps);
  assert.equal(fired, false, 'accessor must not be evaluated');
  assert.equal(r.transport, 'typed'); // ignored accessor -> default
  assert.equal(r.envelope.executed, false);
});

test('failure results never leak a stack trace or echo caller input', async () => {
  const { deps } = serverDeps({ authorize: () => { throw new Error('SECRET_INTERNAL_boom at line 42'); } });
  const secret = 'client-secret-marker-xyz';
  const r = await composeReinaJobsAnswer({ utterance: `what needs attention? ${secret}` }, deps);
  assert.equal(r.ok, false);
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('SECRET_INTERNAL'), 'no internal error text leaks');
  assert.ok(!blob.includes(secret), 'no caller input is echoed');
  assert.ok(!('stack' in r) && !('stack' in r.envelope));
  assert.ok(Object.values(COMPOSER_REASON).includes(r.reason), 'reason is a sanitized enum');
});

test('the composer does NOT import PR #80 ungrounded model wrapper', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../api/_lib/reina/jobs-answer-composer.js', import.meta.url), 'utf8');
  // Must not IMPORT the PR #80 wrapper nor CALL runReinaTurn (a comment mention
  // of the filename is allowed; an import/usage is not).
  assert.ok(!/from\s+['"][^'"]*reina-conversation\.js['"]/.test(src), 'must not import the model wrapper');
  assert.ok(!/runReinaTurn\s*\(/.test(src), 'must not call the model wrapper');
});

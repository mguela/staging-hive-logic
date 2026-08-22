/**
 * V8 executable composite-seam certification gate.
 * Oracle-isolated: candidate receives { preconditions, stimulus } only.
 * Production certification dormant unless REINA_COMPOSITE_SEAM_CANDIDATE_MODULE is set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  COMPOSITE_SEAM_HOOKS,
  SEAM_TO_HOOK,
  ORACLE_FORBIDDEN_KEYS,
  createCompositeSeamCandidateAdapter,
  createKnownGoodCompositeSeamHooks,
  matchCompositeSeam,
  mutateObservedForCase,
  toCandidateInput,
  assertNoOracleFields,
  assertCompositeSeamHooks,
  isCompositeSeamCertificationArmed,
  loadArmedCompositeSeamHooks,
  describeCodexCompositeSeamInjection,
  collectOracleLeaks,
} from './_support/reina-acceptance/composite-seam-candidate-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  'fixtures/reina-acceptance/reina-composite-seam-acceptance-fixtures.json',
);
const V7_EXPECTED_SHA = '1b5129a8a629eb99acc4a0adf447d754d7471dd26019be2712528616e3c98758';

function canonicalFixtureSha(raw) {
  const hash = createHash('sha256');
  let start = 0;
  for (let i = 0; i < raw.length - 1; i += 1) {
    if (raw[i] === 0x0d && raw[i + 1] === 0x0a) {
      hash.update(raw.subarray(start, i));
      start = i + 1;
    }
  }
  hash.update(raw.subarray(start));
  return hash.digest('hex');
}

function assertVerifiedFixtureBytes(raw) {
  const sha = canonicalFixtureSha(raw);
  assert.equal(sha, V7_EXPECTED_SHA, 'fixtures must remain byte-identical to verified V7');
}

function simulateCrlfCheckout(raw) {
  let bareLineFeeds = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0x0a && (i === 0 || raw[i - 1] !== 0x0d)) bareLineFeeds += 1;
  }
  const expanded = Buffer.allocUnsafe(raw.length + bareLineFeeds);
  let write = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0x0a && (i === 0 || raw[i - 1] !== 0x0d)) expanded[write++] = 0x0d;
    expanded[write++] = raw[i];
  }
  return expanded;
}

function loadFixtures() {
  const raw = fs.readFileSync(FIXTURE_PATH);
  assertVerifiedFixtureBytes(raw);
  const doc = JSON.parse(raw.toString('ascii'));
  assert.equal(doc.totalCases, 40);
  assert.equal(doc.cases.length, 40);
  return doc;
}

test('fixtures are byte-identical to verified V7 (40 cases)', () => {
  const doc = loadFixtures();
  const counts = {};
  for (const c of doc.cases) {
    counts[c.seam] = (counts[c.seam] || 0) + 1;
    for (const k of ['id', 'seam', 'preconditions', 'stimulus', 'expectedStructuralResult', 'forbiddenResults', 'mutation', 'decisionRequired']) {
      assert.ok(Object.prototype.hasOwnProperty.call(c, k), `${c.id} missing ${k}`);
    }
  }
  assert.equal(Object.values(counts).every((n) => n === 8), true);
});

test('fixture integrity canonicalizes CRLF only and rejects substantive changes', () => {
  const raw = fs.readFileSync(FIXTURE_PATH);
  const crlf = simulateCrlfCheckout(raw);
  assert.equal(canonicalFixtureSha(crlf), V7_EXPECTED_SHA);

  const changed = Buffer.from(crlf);
  const marker = Buffer.from('"totalCases": 40', 'ascii');
  const markerOffset = changed.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  changed[markerOffset + marker.length - 1] = 0x31;
  assert.throws(
    () => assertVerifiedFixtureBytes(changed),
    /fixtures must remain byte-identical to verified V7/,
  );
});

test('candidate input never includes oracle fields', () => {
  const doc = loadFixtures();
  for (const c of doc.cases) {
    const input = toCandidateInput(c);
    assert.deepEqual(Object.keys(input).sort(), ['preconditions', 'stimulus']);
    assert.equal(collectOracleLeaks(input).length, 0);
    assert.doesNotThrow(() => assertNoOracleFields(input));
    // Ensure oracle fields from case were not copied
    for (const bad of ORACLE_FORBIDDEN_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(input, bad), false);
    }
  }
});

test('missing composite seam hooks fail immediately (no reference fallback)', () => {
  assert.throws(() => createCompositeSeamCandidateAdapter({}), /COMPOSITE_SEAM_CALLBACK_MISSING/);
  const partial = Object.fromEntries(
    COMPOSITE_SEAM_HOOKS.slice(0, 4).map((n) => [n, async () => ({})]),
  );
  assert.throws(() => assertCompositeSeamHooks(partial), /COMPOSITE_SEAM_CALLBACK_MISSING/);
});

test('hooks requesting oracle are rejected', async () => {
  const hooks = createKnownGoodCompositeSeamHooks();
  hooks.actingContextToDurableCore.requestsOracle = true;
  assert.throws(() => createCompositeSeamCandidateAdapter(hooks), /ORACLE_LEAK/);
});

test('40/40 known-good bridge cases (NOT production certification)', async () => {
  const doc = loadFixtures();
  const hooks = createKnownGoodCompositeSeamHooks();
  const adapter = createCompositeSeamCandidateAdapter(hooks);
  assert.equal(adapter.kind, 'composite-seam-candidate');

  const results = [];
  for (const c of doc.cases) {
    const observed = await adapter.runCase(c);
    const match = matchCompositeSeam(c.expectedStructuralResult, c.forbiddenResults, observed);
    results.push({ id: c.id, ok: match.ok, failures: match.failures, seam: c.seam });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({
    knownGoodBridge: failed.length === 0 ? 'PASS' : 'FAIL',
    total: 40,
    passed: results.filter((r) => r.ok).length,
    failed: failed.slice(0, 15),
    note: 'Known-good injected fake — NOT production certification',
  }));
  assert.equal(failed.length, 0, failed.map((f) => `${f.id}:${f.failures.join('|')}`).join(' || '));

  // zero oracle leaks in all stimuli delivered
  for (const s of adapter.stimuli) {
    assert.equal(collectOracleLeaks(s).length, 0);
    assert.deepEqual(Object.keys(s).sort(), ['preconditions', 'stimulus']);
  }
  assert.equal(adapter.stimuli.length, 40);
});

test('40/40 mutations caught (one broken behavior per V7 case)', async () => {
  const doc = loadFixtures();
  const hooks = createKnownGoodCompositeSeamHooks();
  const adapter = createCompositeSeamCandidateAdapter(hooks);

  const results = [];
  for (const c of doc.cases) {
    const good = await adapter.runCase(c);
    const goodMatch = matchCompositeSeam(c.expectedStructuralResult, c.forbiddenResults, good);
    assert.equal(goodMatch.ok, true, `precondition good fail ${c.id}: ${goodMatch.failures.join('|')}`);

    const broken = mutateObservedForCase(good, c.mutation);
    const badMatch = matchCompositeSeam(c.expectedStructuralResult, c.forbiddenResults, broken);
    results.push({
      id: c.id,
      mutation: c.mutation,
      caught: !badMatch.ok,
      failures: badMatch.failures,
    });
  }

  const missed = results.filter((r) => !r.caught);
  console.log(JSON.stringify({
    mutations: {
      total: 40,
      caught: results.filter((r) => r.caught).length,
      missed: missed.map((m) => m.id),
    },
  }));
  assert.equal(missed.length, 0, `mutations not caught: ${missed.map((m) => m.id).join(',')}`);
});

test('zero oracle leaks if candidate payload is poisoned', async () => {
  const hooks = createKnownGoodCompositeSeamHooks();
  const adapter = createCompositeSeamCandidateAdapter(hooks);
  const poisonedInputs = [
    {
      preconditions: { synthetic: true, expectedStructuralResult: { authOk: true } },
      stimulus: { message: 'x' },
    },
    { preconditions: { synthetic: true }, stimulus: { message: 'x', mutation: 'nope' } },
    { preconditions: { synthetic: true }, stimulus: { message: 'x', seam: 'hidden-seam' } },
    { preconditions: { synthetic: true, seamName: 'hidden-seam' }, stimulus: { message: 'x' } },
  ];
  for (const poisoned of poisonedInputs) {
    await assert.rejects(
      () => adapter.runCase({
        id: 'POISON',
        seam: 'acting_context_to_durable_core',
        ...poisoned,
        expectedStructuralResult: {},
        forbiddenResults: [],
        mutation: 'x',
        decisionRequired: null,
      }),
      /ORACLE_LEAK/,
    );
  }
});

test('storage/auth/audit failures never become saved success under matcher', () => {
  const cases = [
    { failClosed: true, savedSuccess: true, executed: false },
    { savedSuccess: true, executed: true },
    { auditFailed: true, savedSuccess: true },
  ];
  for (const obs of cases) {
    const m = matchCompositeSeam({ savedSuccess: false, executed: false }, ['saved_success', 'executed_true'], obs);
    assert.equal(m.ok, false);
  }
});

test('production composite-seam certification remains DORMANT without module', async (t) => {
  assert.equal(isCompositeSeamCertificationArmed({}), false);
  assert.equal(isCompositeSeamCertificationArmed({ REINA_COMPOSITE_SEAM_CANDIDATE_MODULE: '' }), false);
  assert.equal(isCompositeSeamCertificationArmed({ REINA_COMPOSITE_SEAM_CANDIDATE_MODULE: '   ' }), false);
  assert.equal(isCompositeSeamCertificationArmed({ REINA_COMPOSITE_SEAM_CERT_MODULE: 'file:///legacy.mjs' }), false);
  const hooks = await loadArmedCompositeSeamHooks({});
  assert.equal(hooks, null);
  assert.equal(await loadArmedCompositeSeamHooks({ REINA_COMPOSITE_SEAM_CANDIDATE_MODULE: '   ' }), null);
  assert.equal(await loadArmedCompositeSeamHooks({ REINA_COMPOSITE_SEAM_CERT_MODULE: 'file:///legacy.mjs' }), null);
  console.log(JSON.stringify({
    productionCompositeSeamCertification: 'DORMANT',
    injection: describeCodexCompositeSeamInjection(),
    neverUsesReferenceAdapter: true,
  }));
  if (!isCompositeSeamCertificationArmed(process.env)) {
    t.diagnostic('Dormant until REINA_COMPOSITE_SEAM_CANDIDATE_MODULE is set');
  }
});

test('armed loader requires the exact named candidate factory export', async () => {
  const asDataModule = (source) => `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  const defaultOnly = asDataModule('export default function createCompositeSeamCandidateHooks() { return {}; }');
  const aliasOnly = asDataModule('export function createCandidateHooks() { return {}; }');
  await assert.rejects(
    () => loadArmedCompositeSeamHooks({ REINA_COMPOSITE_SEAM_CANDIDATE_MODULE: defaultOnly }),
    /export createCompositeSeamCandidateHooks/,
  );
  await assert.rejects(
    () => loadArmedCompositeSeamHooks({ REINA_COMPOSITE_SEAM_CANDIDATE_MODULE: aliasOnly }),
    /export createCompositeSeamCandidateHooks/,
  );

  const exact = asDataModule(`
    export function createCompositeSeamCandidateHooks() {
      const hook = async () => ({});
      return {
        actingContextToDurableCore: hook,
        durableCoreToConversationEngine: hook,
        classifierToEvidenceEnvelope: hook,
        jobsSnapshotToConversationKnowledge: hook,
        typedPanelToVoiceConversation: hook,
      };
    }
  `);
  const hooks = await loadArmedCompositeSeamHooks({
    REINA_COMPOSITE_SEAM_CANDIDATE_MODULE: `  ${exact}  `,
  });
  assert.doesNotThrow(() => assertCompositeSeamHooks(hooks));
});

test('production composite-seam certification (ARMED only)', async (t) => {
  if (!isCompositeSeamCertificationArmed(process.env)) {
    t.skip('DORMANT — supply REINA_COMPOSITE_SEAM_CANDIDATE_MODULE; never certifies via reference/known-good alone');
    return;
  }
  const hooks = await loadArmedCompositeSeamHooks(process.env);
  assertCompositeSeamHooks(hooks);
  const adapter = createCompositeSeamCandidateAdapter(hooks);
  assert.notEqual(adapter.kind, 'reference');
  const doc = loadFixtures();
  const failed = [];
  for (const c of doc.cases) {
    const observed = await adapter.runCase(c);
    const match = matchCompositeSeam(c.expectedStructuralResult, c.forbiddenResults, observed);
    if (!match.ok) failed.push({ id: c.id, failures: match.failures });
  }
  console.log(JSON.stringify({
    productionCompositeSeamCertification: failed.length === 0 ? 'PASS' : 'FAIL',
    failed,
  }));
  assert.equal(failed.length, 0);
});

test('seam hook routing covers all five seams', () => {
  const seams = Object.keys(SEAM_TO_HOOK);
  assert.equal(seams.length, 5);
  for (const h of Object.values(SEAM_TO_HOOK)) {
    assert.ok(COMPOSITE_SEAM_HOOKS.includes(h));
  }
});

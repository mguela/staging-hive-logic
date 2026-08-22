/**
 * V12.1 Real purple-panel browser certification gate (strict evidence).
 * Known-good bridge is NOT production certification.
 * Production dormant without REINA_BROWSER_CANDIDATE_MODULE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  BROWSER_HOOKS,
  CORE_BROWSER_MUTATIONS,
  NOTHING_EXECUTED,
  createBrowserCandidateAdapter,
  createKnownGoodBrowserHooks,
  matchBrowserFinal,
  criticalBrowserMatch,
  evaluateBrowserReleaseBlockers,
  mutateBrowserObserved,
  toStimulus,
  assertNoOracleFields,
  collectOracleLeaks,
  assertBrowserHooks,
  isBrowserCertificationArmed,
  loadArmedBrowserHooks,
  runArmedBrowserCertification,
  createInadequateEmptyBrowserHooks,
  createIncompleteBrowserHooks,
  describeBrowserInjection,
  canonicalHash,
  hasOwnExact,
} from './_support/reina-acceptance/purple-panel-browser-candidate-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  'fixtures/reina-acceptance/reina-purple-panel-browser-acceptance-fixtures.json',
);
const EXPECTED_CANONICAL_FIXTURE_SHA = 'b492e6c9a8612bb0bb257659fdb8820456e615e1f5f82eb8f81641a1b50b22e6';

function loadDoc() {
  const raw = fs.readFileSync(FIXTURE_PATH);
  const doc = JSON.parse(raw.toString('utf8'));
  return { raw, doc, sha: createHash('sha256').update(raw).digest('hex') };
}

test('fixture integrity preserved: 24 scenarios / 118 steps', () => {
  const { raw, doc, sha } = loadDoc();
  assert.equal(doc.totalCases, 24);
  assert.equal(doc.cases.length, 24);
  const steps = doc.cases.reduce((n, c) => n + c.scenario.steps.length, 0);
  assert.equal(steps, 118);
  const lf = raw.toString('utf8').replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(canonicalHash(lf), canonicalHash(crlf));
  assert.equal(canonicalHash(raw), EXPECTED_CANONICAL_FIXTURE_SHA);
  console.log(JSON.stringify({ scenarioCount: 24, totalSteps: 118, fixtureSha: sha }));
});

test('oracle isolation preserved', () => {
  const { doc } = loadDoc();
  for (const c of doc.cases) {
    for (let i = 0; i < c.scenario.steps.length; i++) {
      const s = toStimulus(c, i);
      assert.equal(collectOracleLeaks(s).length, 0);
      assert.doesNotThrow(() => assertNoOracleFields(s));
    }
  }
});

test('known-good bridge: direct matchBrowserFinal 24/24 (NOT production certification)', async () => {
  const { doc } = loadDoc();
  const failed = [];
  for (const c of doc.cases) {
    const adapter = createBrowserCandidateAdapter(createKnownGoodBrowserHooks());
    const { final } = await adapter.runCase(c);
    const soft = matchBrowserFinal(c.expect, final);
    const crit = criticalBrowserMatch(c.expect, final);
    const block = evaluateBrowserReleaseBlockers(final);
    if (!soft.ok || !crit.ok || !block.ok) {
      failed.push({ id: c.id, soft: soft.failures, crit: crit.failures, block: block.failures });
    }
  }
  console.log(JSON.stringify({
    knownGoodDirectMatch: failed.length === 0 ? 'PASS' : 'FAIL',
    total: 24,
    passed: 24 - failed.length,
    note: 'Known-good hard-pass is NOT production certification',
    failedSample: failed.slice(0, 5),
  }));
  assert.equal(failed.length, 0);
});

test('mutation matrix preserved: 54/54 applications, 25/25 core', async () => {
  const { doc } = loadDoc();
  const sampleAdapter = createBrowserCandidateAdapter(createKnownGoodBrowserHooks());
  const sample = (await sampleAdapter.runCase(doc.cases.find((c) => c.id === 'BR-TV-001'))).final;

  let coreHits = 0;
  for (const core of CORE_BROWSER_MUTATIONS) {
    if (JSON.stringify(mutateBrowserObserved(sample, core)) !== JSON.stringify(sample)) coreHits++;
  }
  assert.equal(CORE_BROWSER_MUTATIONS.length, 25);
  assert.equal(coreHits, 25);

  const applications = [];
  for (const c of doc.cases) {
    const adapter = createBrowserCandidateAdapter(createKnownGoodBrowserHooks());
    const { final } = await adapter.runCase(c);
    for (const m of c.journeyMutations) {
      const broken = mutateBrowserObserved(final, m);
      const altered = JSON.stringify(broken) !== JSON.stringify(final);
      const soft = matchBrowserFinal(c.expect, broken);
      const caught = altered && !soft.ok;
      applications.push({ id: c.id, mutation: m, caught });
    }
  }
  const missed = applications.filter((a) => !a.caught);
  console.log(JSON.stringify({
    mutationMatrix: {
      uniqueMutationTypes: new Set(applications.map((a) => a.mutation)).size,
      mutationApplications: applications.length,
      applicationsCaught: applications.filter((a) => a.caught).length,
      coreTypes: 25,
      coreHits,
    },
  }));
  assert.equal(applications.length, 54);
  assert.equal(missed.length, 0, missed.slice(0, 8).map((m) => `${m.id}:${m.mutation}`).join(','));
});

test('V12.1 inadequate empty candidate MUST fail armed certification', async () => {
  const { doc } = loadDoc();
  const adapter = createBrowserCandidateAdapter(createInadequateEmptyBrowserHooks());
  const report = await runArmedBrowserCertification(adapter, doc.cases);
  console.log(JSON.stringify({
    inadequateCandidate: {
      productionCertification: report.productionCertification,
      failedCount: report.failed.length,
      first: report.failed[0],
      checksRequired: report.checksRequired,
    },
  }));
  assert.equal(report.productionCertification, 'FAIL');
  assert.equal(report.failed.length, 24);
  assert.ok(report.failed[0].failures.some((f) => f.includes('panelMounted') || f.includes('structural')));
  // Direct matchBrowserFinal also rejects (agreement)
  let softFails = 0;
  for (const c of doc.cases) {
    const { final } = await adapter.runCase(c);
    if (!matchBrowserFinal(c.expect, final).ok) softFails++;
  }
  assert.ok(softFails >= 12, `softFails ${softFails}`);
  // Armed failed count must equal direct soft-fail agreement on combined three checks — all 24 fail
  assert.equal(report.perCase.every((r) => r.ok === false), true);
});

test('V12.1 incomplete candidates fail for missing evidence', async () => {
  const { doc } = loadDoc();
  const kindCase = {
    missing_panelMounted: 'BR-PANEL-001',
    missing_authenticated_greeting: 'BR-LOGIN-001',
    missing_typed_voice_continuity: 'BR-TV-001',
    missing_mic_gesture: 'BR-TV-002',
    missing_confirmation_evidence: 'BR-ATT-001',
    missing_teardown_evidence: 'BR-LIFE-003',
    missing_network_boundary: 'BR-NET-001',
    missing_structural_execution_audit: 'BR-NEX-001',
  };
  const reports = {};
  for (const [kind, caseId] of Object.entries(kindCase)) {
    const c = doc.cases.find((x) => x.id === caseId);
    const report = await runArmedBrowserCertification(
      createBrowserCandidateAdapter(createIncompleteBrowserHooks(kind)),
      [c],
    );
    assert.equal(report.productionCertification, 'FAIL', kind);
    assert.ok(report.failed[0].failures.some((f) => f.includes('missing')), kind);
    reports[kind] = report.failed[0].failures.filter((f) => f.includes('missing')).slice(0, 6);
  }
  console.log(JSON.stringify({ incompleteCandidateRejections: reports }));
});

test('armed results agree with direct full-fixture three-check path', async () => {
  const { doc } = loadDoc();
  // Inadequate
  const inadequate = createBrowserCandidateAdapter(createInadequateEmptyBrowserHooks());
  const armed = await runArmedBrowserCertification(inadequate, doc.cases);
  for (const row of armed.perCase) {
    const c = doc.cases.find((x) => x.id === row.id);
    const { final } = await inadequate.runCase(c);
    const soft = matchBrowserFinal(c.expect, final);
    const crit = criticalBrowserMatch(c.expect, final);
    const block = evaluateBrowserReleaseBlockers(final);
    const directOk = soft.ok && crit.ok && block.ok;
    assert.equal(row.ok, directOk, row.id);
    assert.equal(row.softOk, soft.ok, `soft ${row.id}`);
  }
});

test('missing structural audit fails; absence is not proof of safety', () => {
  const o = { usesRnaElements: true, additiveToCurrentMain: true, preservesCcBundlePromise: true, stalePr51IndexReplacement: false };
  const block = evaluateBrowserReleaseBlockers(o);
  assert.equal(block.ok, false);
  assert.ok(block.failures.includes('missing_structural_audit'));
  const soft = matchBrowserFinal({
    final: { panelMounted: true },
    nothingExecutedStructural: NOTHING_EXECUTED,
    panelConstraints: {},
  }, o);
  assert.equal(soft.ok, false);
  assert.ok(soft.failures.some((f) => f.includes('structural')));
});

test('hasOwnExact rejects missing, wrong type, and inherited values', () => {
  const proto = { inherited: true };
  const obj = Object.create(proto);
  obj.own = true;
  assert.equal(hasOwnExact(obj, 'own', true), true);
  assert.equal(hasOwnExact(obj, 'inherited', true), false);
  assert.equal(hasOwnExact(obj, 'missing', true), false);
  assert.equal(hasOwnExact({ n: '1' }, 'n', 1), false);
});

test('production browser certification DORMANT without module', async (t) => {
  assert.equal(isBrowserCertificationArmed({}), false);
  assert.equal(await loadArmedBrowserHooks({}), null);
  console.log(JSON.stringify({
    productionBrowserCertification: 'DORMANT',
    injection: describeBrowserInjection(),
    referenceSuccessIsNotProductionCertification: true,
  }));
  if (!isBrowserCertificationArmed(process.env)) {
    t.diagnostic('Dormant until REINA_BROWSER_CANDIDATE_MODULE is set');
  }
});

test('production browser certification (ARMED only)', async (t) => {
  if (!isBrowserCertificationArmed(process.env)) {
    t.skip('DORMANT — supply REINA_BROWSER_CANDIDATE_MODULE; never certifies via known-good alone');
    return;
  }
  const hooks = await loadArmedBrowserHooks(process.env);
  assertBrowserHooks(hooks);
  const adapter = createBrowserCandidateAdapter(hooks);
  const { doc } = loadDoc();
  const report = await runArmedBrowserCertification(adapter, doc.cases);
  console.log(JSON.stringify(report));
  assert.equal(report.productionCertification, 'PASS');
});

test('reference stubs cannot certify production', async () => {
  const { doc } = loadDoc();
  const adapter = createBrowserCandidateAdapter(createKnownGoodBrowserHooks());
  await assert.rejects(
    () => runArmedBrowserCertification(adapter, doc.cases.slice(0, 1)),
    /PRODUCTION_CERT_FORBIDDEN/,
  );
});

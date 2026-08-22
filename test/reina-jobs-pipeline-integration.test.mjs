// test/reina-jobs-pipeline-integration.test.mjs
//
// REAL integration test for the synthetic Jobs pipeline: it imports the actual
// PR #74 adapter (`createJobsReadAdapter`) and the actual PR #76 bridge
// (`jobsSnapshotToKnowledge`) — no mirrored contract — and drives a full
// adapter -> bridge path with synthetic, injected dependencies only.
//
// It proves the two modules compose safely for tonight's read-only Speaking
// Reina preview: a disabled/denied adapter never touches the loader; a
// malformed/failed loader never yields knowledge; one authorized synthetic
// snapshot becomes bounded, frozen, synthetic/unverified, executed:false
// conversational knowledge; and hostile snapshots fail closed at the bridge.
//
// Library-only and unwired: no route, /api/chat, model, DB, tool, Automation,
// authorization runtime, Voice, or real Jobs data is involved. Every dependency
// here is a local synthetic stub.
//
//   node --test test/reina-jobs-pipeline-integration.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// The ACTUAL pipeline modules under test.
import { createJobsReadAdapter } from '../api/_lib/reina/jobs-read-adapter.js';
import { jobsSnapshotToKnowledge, BRIDGE_REASON } from '../api/_lib/reina/jobs-knowledge-bridge.js';

// ---------------------------------------------------------------------------
// Synthetic dependencies shaped exactly as the adapter's contract expects.
// ---------------------------------------------------------------------------
const OPERATION = 'reina.jobs.snapshot.disabled';
const CAPABILITY = 'reina:jobs:read';

function validAuthorization(overrides = {}) {
  return {
    allowed: true,
    operation: OPERATION,
    capability: CAPABILITY,
    companyScoped: true,
    companyAuthorityVerified: true,
    principalId: 'principal-1',
    companyId: 'company-1',
    scopeRef: 'scope-company-1-v1',
    ...overrides,
  };
}

function expectedRecordRef(authorization, jobNumber) {
  return `synthetic-job:v1:${createHash('sha256')
    .update(OPERATION).update('\0')
    .update(authorization.companyId).update('\0')
    .update(authorization.scopeRef).update('\0')
    .update(jobNumber).digest('hex')}`;
}

function validRow(index = 0, overrides = {}) {
  return {
    jobNumber: `DEMO-${200 + index}`,
    status: 'open',
    stage: 'prep',
    scheduleStart: '2026-08-05',
    scheduleEnd: '2026-08-06',
    onHold: false,
    missingInfo: false,
    ...overrides,
  };
}

// A loader envelope in the exact shape the adapter's normalizeEnvelope accepts.
// asOf must be <= the adapter's observed "now"; a just-computed ISO time works.
function validEnvelope(rows, authorization = validAuthorization()) {
  const asOf = new Date().toISOString();
  const jobs = [];
  const recordRefs = [];
  for (let i = 0; i < rows.length; i += 1) {
    jobs[i] = rows[i];
    recordRefs[i] = expectedRecordRef(authorization, rows[i].jobNumber);
  }
  return {
    ok: true,
    partial: false,
    denied: false,
    error: null,
    jobs,
    provenance: {
      source: 'synthetic',
      asOf,
      state: 'unverified',
      companyId: authorization.companyId,
      scopeRef: authorization.scopeRef,
      recordRefs,
    },
  };
}

const DEFAULT_ROWS = [
  validRow(0, { onHold: true }),           // DEMO-200 on hold
  validRow(1, { missingInfo: true }),      // DEMO-201 missing info
  validRow(2),                             // DEMO-202 clean
];

// Run the whole pipeline: authorized synthetic adapter -> bridge.
async function runPipeline(rows = DEFAULT_ROWS) {
  const adapter = createJobsReadAdapter({
    enabled: true,
    authorize: () => validAuthorization(),
    loader: async () => validEnvelope(rows),
  });
  const snapshot = await adapter.snapshot({});
  const bridged = jobsSnapshotToKnowledge(snapshot);
  return { snapshot, bridged };
}

// ---------------------------------------------------------------------------
// Loader is never called when the adapter refuses upstream.
// ---------------------------------------------------------------------------
test('disabled adapter never calls the loader and never yields knowledge', async () => {
  let loaderCalls = 0;
  let authorizeCalls = 0;
  const adapter = createJobsReadAdapter({
    // enabled omitted -> disabled by default
    authorize: () => { authorizeCalls += 1; return validAuthorization(); },
    loader: async () => { loaderCalls += 1; return validEnvelope(DEFAULT_ROWS); },
  });
  const snapshot = await adapter.snapshot({});
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.disabled, true);
  assert.equal(loaderCalls, 0, 'loader must not run when disabled');
  assert.equal(authorizeCalls, 0, 'authorizer must not run when disabled');
  const bridged = jobsSnapshotToKnowledge(snapshot);
  assert.equal(bridged.ok, false, 'a disabled snapshot must never become knowledge');
  assert.ok(!('knowledge' in bridged));
});

test('denied authorization never calls the loader and never yields knowledge', async () => {
  let loaderCalls = 0;
  const adapter = createJobsReadAdapter({
    enabled: true,
    authorize: () => ({ allowed: false }), // denied
    loader: async () => { loaderCalls += 1; return validEnvelope(DEFAULT_ROWS); },
  });
  const snapshot = await adapter.snapshot({});
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.denied, true);
  assert.equal(loaderCalls, 0, 'loader must not run when authorization is denied');
  assert.equal(jobsSnapshotToKnowledge(snapshot).ok, false);
});

// ---------------------------------------------------------------------------
// Malformed / failed loader -> unavailable, never knowledge.
// ---------------------------------------------------------------------------
test('a failing (throwing) loader returns unavailable and never yields knowledge', async () => {
  const adapter = createJobsReadAdapter({
    enabled: true,
    authorize: () => validAuthorization(),
    loader: async () => { throw new Error('backend down'); },
  });
  const snapshot = await adapter.snapshot({});
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.reason, 'loader_unavailable');
  assert.equal(jobsSnapshotToKnowledge(snapshot).ok, false);
});

test('a malformed loader envelope returns malformed and never yields knowledge', async () => {
  const adapter = createJobsReadAdapter({
    enabled: true,
    authorize: () => validAuthorization(),
    loader: async () => ({ ok: true, partial: false, denied: false, error: null, jobs: 'not-an-array', provenance: {} }),
  });
  const snapshot = await adapter.snapshot({});
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.reason, 'loader_malformed');
  const bridged = jobsSnapshotToKnowledge(snapshot);
  assert.equal(bridged.ok, false, 'a malformed snapshot must never become knowledge');
});

// ---------------------------------------------------------------------------
// Happy path: one authorized synthetic snapshot -> bounded, frozen knowledge.
// ---------------------------------------------------------------------------
test('an authorized synthetic snapshot converts into bounded, frozen conversational knowledge', async () => {
  const { snapshot, bridged } = await runPipeline();
  // The adapter really produced a success snapshot.
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.kind, 'jobs_snapshot');
  assert.equal(snapshot.count, 3);
  // The bridge really accepted it.
  assert.equal(bridged.ok, true);
  const k = bridged.knowledge;
  assert.ok(Array.isArray(k.prompts) && k.prompts.length > 0);
  assert.ok(Array.isArray(k.attentionJobRefs));
  assert.ok(k.attentionJobRefs.length <= 50, 'attentionJobRefs stays bounded');
  // Deeply frozen.
  assert.ok(Object.isFrozen(k) && Object.isFrozen(k.prompts) && Object.isFrozen(k.prompts[0]) && Object.isFrozen(k.attentionJobRefs));
  assert.throws(() => { k.executed = true; }, TypeError);
  assert.throws(() => { k.prompts.push({}); }, TypeError);
  // Facts flowed through: the on-hold + missing-info jobs are the attention set.
  assert.deepEqual([...k.attentionJobRefs].sort(), ['DEMO-200', 'DEMO-201']);
});

test('source stays "synthetic" and state stays "unverified" through the whole path', async () => {
  const { snapshot, bridged } = await runPipeline();
  assert.equal(snapshot.provenance.source, 'synthetic');
  assert.equal(snapshot.provenance.state, 'unverified');
  const k = bridged.knowledge;
  assert.equal(k.source, 'synthetic');
  assert.equal(k.state, 'unverified');
  assert.equal(k.synthetic, true);
  assert.equal(k.verified, false);
  // Every prompt's freshness echoes the synthetic/unverified markings.
  assert.ok(k.prompts.every((p) => /synthetic/i.test(p.freshness) && /unverified/i.test(p.freshness)));
});

test('executed:false survives the complete adapter -> bridge path', async () => {
  const { snapshot, bridged } = await runPipeline();
  assert.equal('executed' in snapshot, false, 'adapter snapshot asserts no execution');
  assert.equal(bridged.knowledge.executed, false);
  const blob = JSON.stringify(bridged.knowledge);
  assert.ok(!/"executed"\s*:\s*true/.test(blob), 'nothing in the knowledge claims execution');
});

test('no stale-day, confidence, schedule-certainty, or source-of-truth policy is invented', async () => {
  const { bridged } = await runPipeline();
  const blob = JSON.stringify(bridged.knowledge);
  assert.doesNotMatch(blob, /\d+\s*%/);                                  // no confidence percentages
  assert.doesNotMatch(blob, /\b(is|are|marked|considered|data is)\s+stale\b/i); // never asserts staleness
  assert.doesNotMatch(blob, /will (?:start|finish|complete|happen)/i);   // no schedule certainty
  assert.doesNotMatch(blob, /\bauthoritative\b|source of truth/i);       // no source-of-truth policy
  assert.match(blob, /no stale-day threshold is applied/i);              // explicitly disclaims a threshold
});

// ---------------------------------------------------------------------------
// Hostile snapshots fail closed at the bridge (never become knowledge).
// A clean round-trip of a real snapshot is accepted; every tampered variant is
// rejected — proving no authority/tool/execution claim or unsafe field can slip
// through the seam.
// ---------------------------------------------------------------------------
test('a clean JSON round-trip of a real snapshot is still accepted', async () => {
  const { snapshot } = await runPipeline();
  const clone = JSON.parse(JSON.stringify(snapshot));
  assert.equal(jobsSnapshotToKnowledge(clone).ok, true);
});

test('authority / tool / execution claims injected into a snapshot fail closed', async () => {
  const { snapshot } = await runPipeline();
  const inject = [
    { companyId: 'company-1' },     // authority identifier
    { principalId: 'p' },           // authority identifier
    { scopeRef: 's' },              // authority scope
    { capability: 'reina:jobs:read' },
    { role: 'admin' },
    { tools: ['sql'] },
    { authorize: {} },
    { executed: true },             // execution claim
    { allowed: true },
  ];
  for (const patch of inject) {
    const clone = { ...JSON.parse(JSON.stringify(snapshot)), ...patch };
    const r = jobsSnapshotToKnowledge(clone);
    assert.equal(r.ok, false, `injected ${Object.keys(patch)[0]} must fail closed`);
    assert.ok(!('knowledge' in r));
  }
});

test('unsafe field content and malformed snapshots fail closed', async () => {
  const { snapshot } = await runPipeline();
  // Unsafe HTML in a job field.
  const unsafe = JSON.parse(JSON.stringify(snapshot));
  unsafe.jobs[0].jobNumber = '<script>alert(1)</script>';
  const ru = jobsSnapshotToKnowledge(unsafe);
  assert.equal(ru.ok, false);
  // A dropped provenance marking.
  const noState = JSON.parse(JSON.stringify(snapshot));
  delete noState.provenance.state;
  assert.equal(jobsSnapshotToKnowledge(noState).ok, false);
  // Plainly malformed inputs.
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    assert.equal(jobsSnapshotToKnowledge(bad).ok, false);
  }
});

test('a real adapter FAILURE envelope handed to the bridge fails closed', async () => {
  const adapter = createJobsReadAdapter({ enabled: true, authorize: () => ({ allowed: false }), loader: async () => validEnvelope(DEFAULT_ROWS) });
  const failure = await adapter.snapshot({});
  assert.equal(failure.ok, false);
  const r = jobsSnapshotToKnowledge(failure);
  assert.equal(r.ok, false);
  // The adapter's failure envelope has a different key-set than a success
  // snapshot, so the bridge rejects it as malformed (or not-successful) — either
  // way it fails closed and yields no knowledge.
  assert.ok([BRIDGE_REASON.MALFORMED, BRIDGE_REASON.NOT_SUCCESSFUL].includes(r.reason), `fail-closed reason, got ${r.reason}`);
  assert.ok(!('knowledge' in r));
});

// ---------------------------------------------------------------------------
// The adapter does not mutate under the bridge, and the pipeline is repeatable.
// ---------------------------------------------------------------------------
test('the bridge does not mutate the adapter snapshot; pipeline is deterministic', async () => {
  const { snapshot } = await runPipeline();
  const before = JSON.stringify(snapshot);
  jobsSnapshotToKnowledge(snapshot);
  assert.equal(JSON.stringify(snapshot), before, 'snapshot unchanged by bridging');
});

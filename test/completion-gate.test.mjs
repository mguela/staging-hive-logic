import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPLETION_GATE_VERSION,
  REQUIRED_COMPLETION_EVIDENCE,
  evaluateTaskCompletion,
  unverifiedCompletionGate,
} from '../api/_lib/completion-gate.js';

const verifiedAt = '2026-08-16T12:45:00.000Z';
const task = {
  id: '11111111-1111-4111-8111-111111111111',
  task_key: 'WR-123456789',
  assigned_agent: 'codex',
  specification: 'The feature must satisfy every listed acceptance criterion and preserve all existing behavior.',
};

function evidence(overrides = {}) {
  const rows = [
    ['diff', 'claude', 'Exact reviewed source revision.', 'https://github.com/csk5369/hivelogic-live/commit/abcdef1234567890'],
    ['test', 'codex', 'Complete automated regression passed with zero failures.', 'artifact://tests/full-suite.json'],
    ['crawler', 'reina', 'Manager crawler completed with zero unresolved findings.', 'artifact://crawler/report.json'],
    ['preview', 'chatgpt', 'Browser end-to-end acceptance passed in preview.', 'https://preview.hivelogic.example/verification/123'],
    ['review', 'claude', 'Independent review found no unresolved defects.', 'https://github.com/csk5369/hivelogic-live/pull/999'],
    ['deployment', 'reina', 'Production deployment and reload verification passed.', 'https://hivelogic-live.vercel.app/verification/123'],
  ].map(([evidence_type, actor, summary, reference], index) => ({
    evidence_type, actor, summary, reference, verdict: 'pass', evidence_sequence: index + 1,
    created_at: `2026-08-16T12:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  return rows.map((row) => row.evidence_type === overrides.type ? { ...row, ...overrides.patch } : row);
}

test('an unverified Boardroom result is authoritatively NOT DONE', () => {
  const gate = unverifiedCompletionGate();
  assert.equal(gate.version, COMPLETION_GATE_VERSION);
  assert.equal(gate.status, 'unverified');
  assert.equal(gate.authoritativeLabel, 'NOT DONE');
  assert.equal(gate.receipt, null);
  assert.equal(Object.isFrozen(gate), true);
});

test('every mandatory evidence category is fail-closed', () => {
  for (const missing of REQUIRED_COMPLETION_EVIDENCE) {
    const checked = evaluateTaskCompletion({ task, evidence: evidence().filter((row) => row.evidence_type !== missing), verifiedAt });
    assert.equal(checked.ok, false, missing);
    assert.equal(checked.gate.authoritativeLabel, 'NOT DONE');
    assert.match(checked.gate.failures.join('\n'), new RegExp(`Missing required ${missing} evidence`));
  }
});

test('missing acceptance criteria, failed checks, missing references, and stale risk verdicts block completion', () => {
  const badSpec = evaluateTaskCompletion({ task: { ...task, specification: 'fix it' }, evidence: evidence(), verifiedAt });
  assert.equal(badSpec.ok, false);
  assert.match(badSpec.gate.failures.join('\n'), /acceptance criteria/);

  for (const verdict of ['fail', 'risk', 'info']) {
    const checked = evaluateTaskCompletion({ task, evidence: evidence({ type: 'test', patch: { verdict } }), verifiedAt });
    assert.equal(checked.ok, false, verdict);
    assert.match(checked.gate.failures.join('\n'), new RegExp(`Latest test evidence is ${verdict}`));
  }
  const noReference = evaluateTaskCompletion({ task, evidence: evidence({ type: 'crawler', patch: { reference: '' } }), verifiedAt });
  assert.equal(noReference.ok, false);
  assert.match(noReference.gate.failures.join('\n'), /crawler evidence has no durable reference/);
});

test('the exact revision, HTTPS preview, production URL, and independent reviewer are mandatory', () => {
  const badRevision = evaluateTaskCompletion({ task, evidence: evidence({ type: 'diff', patch: { reference: 'branch main' } }), verifiedAt });
  assert.equal(badRevision.ok, false);
  assert.match(badRevision.gate.failures.join('\n'), /exact Git revision/);

  for (const type of ['preview', 'deployment']) {
    const checked = evaluateTaskCompletion({ task, evidence: evidence({ type, patch: { reference: 'http://localhost/test' } }), verifiedAt });
    assert.equal(checked.ok, false, type);
    assert.match(checked.gate.failures.join('\n'), /HTTPS deployment URL|production evidence/i);
  }

  const selfReview = evaluateTaskCompletion({ task, evidence: evidence({ type: 'review', patch: { actor: 'codex' } }), verifiedAt });
  assert.equal(selfReview.ok, false);
  assert.match(selfReview.gate.failures.join('\n'), /different actor/);
});

test('only a complete evidence package mints a tamper-evident receipt for the exact revision and deployment', () => {
  const checked = evaluateTaskCompletion({ task, evidence: evidence(), verifiedAt });
  assert.equal(checked.ok, true);
  assert.equal(checked.gate.status, 'verified_complete');
  assert.equal(checked.gate.authoritativeLabel, 'VERIFIED DONE');
  assert.equal(checked.gate.receipt.version, COMPLETION_GATE_VERSION);
  assert.equal(checked.gate.receipt.sourceRevision, 'abcdef1234567890');
  assert.equal(checked.gate.receipt.checks.length, REQUIRED_COMPLETION_EVIDENCE.length);
  assert.match(checked.gate.receipt.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.isFrozen(checked.gate.receipt), true);
});

test('a source, acceptance-criteria, deployment, or evidence change produces a different receipt', () => {
  const original = evaluateTaskCompletion({ task, evidence: evidence(), verifiedAt }).gate.receipt.fingerprint;
  const changedSpec = evaluateTaskCompletion({ task: { ...task, specification: `${task.specification} Additional criterion.` }, evidence: evidence(), verifiedAt }).gate.receipt.fingerprint;
  const changedRevision = evaluateTaskCompletion({ task, evidence: evidence({ type: 'diff', patch: { reference: 'https://github.com/csk5369/hivelogic-live/commit/1234567abcdef' } }), verifiedAt }).gate.receipt.fingerprint;
  const changedDeployment = evaluateTaskCompletion({ task, evidence: evidence({ type: 'deployment', patch: { reference: 'https://hivelogic-live.vercel.app/verification/456' } }), verifiedAt }).gate.receipt.fingerprint;
  assert.notEqual(changedSpec, original);
  assert.notEqual(changedRevision, original);
  assert.notEqual(changedDeployment, original);
});

test('evidence sequence deterministically makes a later failure authoritative even with an identical timestamp', () => {
  const rows = evidence();
  const originalTest = rows.find((row) => row.evidence_type === 'test');
  rows.push({
    ...originalTest,
    verdict: 'fail',
    summary: 'A later regression invalidated the previous passing result.',
    reference: 'artifact://tests/later-failure.json',
    evidence_sequence: 99,
    created_at: originalTest.created_at,
  });
  const checked = evaluateTaskCompletion({ task, evidence: rows, verifiedAt });
  assert.equal(checked.ok, false);
  assert.match(checked.gate.failures.join('\n'), /Latest test evidence is fail/);
});

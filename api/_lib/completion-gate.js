import { createHash } from 'node:crypto';

export const COMPLETION_GATE_VERSION = 'hivelogic.completion-gate.v1';
export const REQUIRED_COMPLETION_EVIDENCE = Object.freeze([
  'diff',
  'test',
  'crawler',
  'preview',
  'review',
  'deployment',
]);

const SHA = /^[0-9a-f]{7,40}$/i;
const URL = /^https:\/\/[^\s]+$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function immutable(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const deepFreeze = (item) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    Object.values(item).forEach(deepFreeze);
    return Object.freeze(item);
  };
  return deepFreeze(copy);
}

export function unverifiedCompletionGate(reason = 'No valid completion receipt exists for this exact work revision and production deployment.') {
  return immutable({
    version: COMPLETION_GATE_VERSION,
    status: 'unverified',
    authoritativeLabel: 'NOT DONE',
    reason,
    receipt: null,
  });
}

export function evaluateTaskCompletion({ task, evidence, verifiedAt = new Date().toISOString() } = {}) {
  const failures = [];
  const specification = typeof task?.specification === 'string' ? task.specification.trim() : '';
  if (specification.length < 40) failures.push('The intended behavior and acceptance criteria are missing or incomplete.');
  if (!Array.isArray(evidence)) failures.push('The verification evidence ledger is unavailable.');

  const ordered = Array.isArray(evidence)
    ? evidence.slice().sort((a, b) => {
      const aSequence = Number(a?.evidence_sequence);
      const bSequence = Number(b?.evidence_sequence);
      if (Number.isFinite(aSequence) && Number.isFinite(bSequence) && aSequence !== bSequence) return aSequence - bSequence;
      return new Date(a?.created_at || 0) - new Date(b?.created_at || 0);
    })
    : [];
  const latest = new Map();
  ordered.forEach((entry) => latest.set(entry?.evidence_type, entry));

  for (const type of REQUIRED_COMPLETION_EVIDENCE) {
    const entry = latest.get(type);
    if (!entry) {
      failures.push(`Missing required ${type} evidence.`);
      continue;
    }
    if (entry.verdict !== 'pass') failures.push(`Latest ${type} evidence is ${entry.verdict || 'not passed'}.`);
    if (typeof entry.summary !== 'string' || entry.summary.trim().length < 10) failures.push(`${type} evidence has no meaningful result summary.`);
    if (typeof entry.reference !== 'string' || entry.reference.trim().length === 0) failures.push(`${type} evidence has no durable reference.`);
  }

  const diff = latest.get('diff');
  const revisionMatch = typeof diff?.reference === 'string' ? diff.reference.match(/[0-9a-f]{7,40}/i) : null;
  if (!revisionMatch || !SHA.test(revisionMatch[0])) failures.push('Diff evidence does not identify the exact Git revision.');
  const preview = latest.get('preview');
  if (preview && !URL.test(String(preview.reference || ''))) failures.push('Preview evidence is not an HTTPS deployment URL.');
  const deployment = latest.get('deployment');
  if (deployment && !URL.test(String(deployment.reference || ''))) failures.push('Production evidence is not an HTTPS deployment URL.');
  const review = latest.get('review');
  if (review && task?.assigned_agent && review.actor === task.assigned_agent) failures.push('Independent review must be performed by a different actor.');

  if (failures.length) {
    return immutable({
      ok: false,
      gate: {
        version: COMPLETION_GATE_VERSION,
        status: 'verification_failed',
        authoritativeLabel: 'NOT DONE',
        failures,
        receipt: null,
      },
    });
  }

  const checks = REQUIRED_COMPLETION_EVIDENCE.map((type) => {
    const entry = latest.get(type);
    return {
      type,
      actor: entry.actor,
      summary: entry.summary.trim(),
      reference: entry.reference.trim(),
      verifiedAt: entry.created_at,
    };
  });
  const receiptBody = {
    version: COMPLETION_GATE_VERSION,
    taskId: task.id,
    taskKey: task.task_key,
    specificationHash: createHash('sha256').update(specification).digest('hex'),
    sourceRevision: revisionMatch[0].toLowerCase(),
    deploymentUrl: deployment.reference.trim(),
    verifiedAt,
    checks,
  };
  const fingerprint = createHash('sha256').update(canonicalJson(receiptBody)).digest('hex');
  const receipt = immutable({ ...receiptBody, fingerprint });
  return immutable({
    ok: true,
    gate: {
      version: COMPLETION_GATE_VERSION,
      status: 'verified_complete',
      authoritativeLabel: 'VERIFIED DONE',
      failures: [],
      receipt,
    },
  });
}

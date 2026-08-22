import { createHash, randomUUID } from 'node:crypto';

const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');

export function createControlStore() { return { approvals: [], qboOutbox: [], events: [] }; }

function event(store, action, actor, entityType, entityId, detail = {}) {
  const record = { id: randomUUID(), at: new Date().toISOString(), action, actorId: actor.id, actorRole: actor.role, entityType, entityId, detail: structuredClone(detail), previousHash: store.events.at(-1)?.hash || null };
  record.hash = digest({ ...record, hash: undefined }); store.events.push(record); return record;
}

export function verifyControlAudit(store) {
  let previousHash = null;
  for (const record of store.events) {
    if (record.previousHash !== previousHash || record.hash !== digest({ ...record, hash: undefined })) return { valid: false, brokenAt: record.id };
    previousHash = record.hash;
  }
  return { valid: true, records: store.events.length, head: previousHash };
}

export function requestApproval(store, { companyId, entityType, entityId, payload, requiredRoles = ['approver'], approvalsRequired = 1 }, actor) {
  if (!companyId || !entityType || !entityId) throw new Error('Approval target is required.');
  const existing = store.approvals.find(item => item.companyId === companyId && item.entityType === entityType && item.entityId === entityId && item.status === 'pending');
  if (existing) return existing;
  const request = { id: randomUUID(), companyId, entityType, entityId, payloadHash: digest(payload), requestedBy: actor.id, requestedAt: new Date().toISOString(), requiredRoles, approvalsRequired, decisions: [], status: 'pending' };
  store.approvals.push(request); event(store, 'approval.requested', actor, entityType, entityId, { requestId: request.id, payloadHash: request.payloadHash }); return request;
}

export function decideApproval(store, requestId, decision, comment, actor) {
  const request = store.approvals.find(item => item.id === requestId); if (!request) throw new Error('Approval request not found.');
  if (request.status !== 'pending') throw new Error('Approval request is already closed.');
  if (request.requestedBy === actor.id) throw new Error('Separation of duties prevents approving your own request.');
  if (!request.requiredRoles.includes(actor.role) && actor.role !== 'controller') throw new Error('Actor does not have the required approval role.');
  if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject.');
  if (request.decisions.some(item => item.actorId === actor.id)) throw new Error('Actor already decided this request.');
  request.decisions.push({ actorId: actor.id, actorRole: actor.role, decision, comment: comment || '', at: new Date().toISOString() });
  if (decision === 'reject') request.status = 'rejected';
  else {
    const approvals = request.decisions.filter(item => item.decision === 'approve');
    const requiresEveryListedRole = request.approvalsRequired >= request.requiredRoles.length;
    if (approvals.length >= request.approvalsRequired && (!requiresEveryListedRole || request.requiredRoles.every(role => approvals.some(item => item.actorRole === role)))) request.status = 'approved';
  }
  event(store, `approval.${decision}d`, actor, request.entityType, request.entityId, { requestId, comment, status: request.status }); return request;
}

export function verifyApprovedPayload(request, payload) {
  return { valid: request.status === 'approved' && request.payloadHash === digest(payload), approved: request.status === 'approved', unchanged: request.payloadHash === digest(payload) };
}

export function enqueueQboSync(store, { companyId, entityType, entityId, operation = 'create', payload, approvalRequestId }, actor = { id: 'qbo-outbox-system', role: 'system' }) {
  if (!companyId || !entityType || !entityId || !payload) throw new Error('QBO sync target and payload are required.');
  const approval = store.approvals.find(item => item.id === approvalRequestId);
  if (!approval || !verifyApprovedPayload(approval, payload).valid) throw new Error('QBO payload must be approved and unchanged.');
  const idempotencyKey = `${companyId}:${entityType}:${entityId}:${operation}`;
  const existing = store.qboOutbox.find(item => item.idempotencyKey === idempotencyKey); if (existing) return existing;
  const item = { id: randomUUID(), idempotencyKey, companyId, entityType, entityId, operation, payload, payloadHash: digest(payload), approvalRequestId, status: 'queued', attempts: [], createdAt: new Date().toISOString() };
  store.qboOutbox.push(item); event(store, 'qbo.sync_queued', actor, entityType, entityId, { outboxId: item.id, idempotencyKey, payloadHash: item.payloadHash }); return item;
}

export function beginQboSync(store, outboxId, actor) {
  if (!['bookkeeper', 'controller'].includes(actor.role)) throw new Error('Only a bookkeeper or controller can initiate QBO sync.');
  const item = store.qboOutbox.find(entry => entry.id === outboxId); if (!item) throw new Error('QBO outbox item not found.');
  if (item.status === 'complete') return item;
  if (digest(item.payload) !== item.payloadHash) throw new Error('QBO payload changed after approval.');
  item.status = 'in_flight'; item.attempts.push({ id: randomUUID(), startedAt: new Date().toISOString(), startedBy: actor.id, status: 'in_flight' }); event(store, 'qbo.sync_started', actor, item.entityType, item.entityId, { outboxId: item.id, attempt: item.attempts.length }); return item;
}

export function finishQboSync(store, outboxId, result, actor) {
  const item = store.qboOutbox.find(entry => entry.id === outboxId); if (!item) throw new Error('QBO outbox item not found.');
  if (item.status === 'complete') return item;
  if (item.status !== 'in_flight') throw new Error('QBO sync is not in flight.');
  const attempt = item.attempts.at(-1);
  if (result.ok) { if (!result.qboId) throw new Error('Successful QBO sync requires the QBO record id.'); attempt.status = 'complete'; attempt.finishedAt = new Date().toISOString(); attempt.qboId = String(result.qboId); item.status = 'complete'; item.qboId = String(result.qboId); item.completedAt = attempt.finishedAt; }
  else { attempt.status = 'failed'; attempt.finishedAt = new Date().toISOString(); attempt.error = result.error || 'Unknown QBO error'; item.status = result.retryable === false ? 'blocked' : 'retry'; }
  event(store, result.ok ? 'qbo.sync_completed' : 'qbo.sync_failed', actor, item.entityType, item.entityId, { outboxId: item.id, status: item.status, qboId: item.qboId, error: attempt.error }); return item;
}

export function retryQboSync(store, outboxId, actor) {
  const item = store.qboOutbox.find(entry => entry.id === outboxId); if (!item) throw new Error('QBO outbox item not found.');
  if (item.status !== 'retry') throw new Error('Only retryable failures can be retried.');
  item.status = 'queued'; event(store, 'qbo.sync_retried', actor, item.entityType, item.entityId, { outboxId: item.id, attempt: item.attempts.length + 1 }); return beginQboSync(store, outboxId, actor);
}

export function recoverInterruptedQboSync(store, outboxId, actor) {
  const item = store.qboOutbox.find(entry => entry.id === outboxId); if (!item) throw new Error('QBO outbox item not found.');
  if (item.status !== 'in_flight') return item; const attempt = item.attempts.at(-1); if (attempt?.status === 'in_flight') { attempt.status = 'interrupted'; attempt.finishedAt = new Date().toISOString(); attempt.error = 'The worker stopped before the QBO response was durably recorded.'; }
  item.status = 'retry'; event(store, 'qbo.sync_recovered', actor, item.entityType, item.entityId, { outboxId: item.id, attempt: item.attempts.length, idempotencyKey: item.idempotencyKey }); return item;
}

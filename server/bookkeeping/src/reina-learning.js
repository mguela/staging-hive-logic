import { createHash, randomUUID } from 'node:crypto';

const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const normalize = value => String(value || '').normalize('NFKD').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const normalizeSku = value => normalize(value).replaceAll(' ', '');
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const money = value => Math.round((Number(value) || 0) * 100) / 100;

export const REINA_CONFIDENCE_POLICY = Object.freeze({
  showAsFilled: .68,
  autoFill: .92,
  minimumRepeatApprovals: 3,
  maximumConflictRate: .1
});

function outputKey(output = {}) { return [output.ownerType, output.ownerId, output.qboAccountId].map(normalize).join('|'); }
function words(value) { return new Set(normalize(value).split(' ').filter(word => word.length > 2)); }
function overlap(left, right) { const a = words(left), b = words(right); if (!a.size || !b.size) return 0; const intersection = [...a].filter(word => b.has(word)).length; return intersection / new Set([...a, ...b]).size; }

export function createLearningState() { return { version: 2, events: [], migratedRules: [], createdAt: new Date().toISOString() }; }

export function ensureLearningState(value) {
  if (value?.version === 2 && Array.isArray(value.events)) return { ...value, events: value.events.map(event => structuredClone(event)), migratedRules: Array.isArray(value.migratedRules) ? structuredClone(value.migratedRules) : [] };
  if (!Array.isArray(value)) return createLearningState();
  return {
    ...createLearningState(),
    migratedRules: value.filter(rule => rule?.vendor && rule?.suggestion?.ownerType && rule?.suggestion?.qboAccountId).map(rule => ({ id: rule.id || randomUUID(), companyId: rule.companyId || 'legacy', vendor: rule.vendor, context: { vendor: rule.vendor }, output: structuredClone(rule.suggestion), approvals: Math.max(1, Number(rule.uses) || 1), migratedAt: rule.updatedAt || new Date().toISOString() }))
  };
}

function learningHash(previousHash, event) { return digest({ previousHash: previousHash || null, event: { ...event, hash: undefined, previousHash: undefined } }); }

export function verifyLearningChain(value) {
  const state = ensureLearningState(value); let previousHash = null;
  for (const event of state.events) {
    if (event.previousHash !== previousHash || event.hash !== learningHash(previousHash, event)) return { valid: false, brokenAt: event.id, records: state.events.length };
    previousHash = event.hash;
  }
  return { valid: true, records: state.events.length, head: previousHash };
}

export function recordApprovedLearning(value, input, actor = { id: 'bookkeeper', role: 'bookkeeper' }) {
  if (!['approver', 'bookkeeper', 'controller'].includes(actor.role)) throw new Error('Only an authorized reviewer can approve Reina learning.');
  if (!input.companyId || !String(input.vendor || '').trim()) throw new Error('Company and vendor are required for Reina learning.');
  if (!input.suggestion?.ownerType || !input.suggestion?.qboAccountId) throw new Error('Approved owner type and bookkeeping account are required.');
  const state = ensureLearningState(value); const learningKey = input.approvalId ? `${input.companyId}:${input.approvalId}:${input.lineId || 'document'}` : null;
  const existing = learningKey ? state.events.find(event => event.learningKey === learningKey) : null;
  if (existing) return { state, event: existing, replayed: true };
  const previousHash = state.events.at(-1)?.hash || null;
  const event = {
    id: randomUUID(), companyId: String(input.companyId), documentId: input.documentId || null, lineId: input.lineId || null,
    context: { vendor: String(input.vendor).trim(), sku: String(input.sku || '').trim(), description: String(input.description || '').trim(), paymentAccountId: input.paymentAccountId || null, taxState: String(input.taxState || '').toUpperCase() || null },
    output: { ownerType: input.suggestion.ownerType, ownerId: input.suggestion.ownerId || '', qboAccountId: String(input.suggestion.qboAccountId) },
    approvedBy: actor.id, approvedRole: actor.role, approvedAt: new Date().toISOString(), approvalId: input.approvalId || null, learningKey, supersedesEventId: input.supersedesEventId || null, previousHash
  };
  event.hash = learningHash(previousHash, event); state.events.push(event); state.updatedAt = event.approvedAt;
  return { state, event };
}

export function recordApprovedExpenseLearning(value, { companyId, approval, expense }, actor) {
  if (approval?.status !== 'approved') throw new Error('Reina can only learn after the expense approval is complete.');
  if (!expense || approval.entityId !== expense.id) throw new Error('Approved expense context is required for Reina learning.');
  let state = ensureLearningState(value); const events = [];
  for (const [index, line] of (expense.allocations || []).entries()) {
    if (line.ownerType === 'unknown') continue;
    const learned = recordApprovedLearning(state, { companyId, approvalId: approval.id, documentId: expense.evidenceDocumentIds?.[0] || null, lineId: String(index), vendor: expense.vendor, sku: line.sku, description: line.description || line.memo, paymentAccountId: expense.paymentAccountId, taxState: line.salesTaxState || expense.salesTaxState, suggestion: { ownerType: line.ownerType, ownerId: line.ownerId, qboAccountId: line.qboAccountId } }, actor);
    state = learned.state; events.push({ event: learned.event, replayed: !!learned.replayed });
  }
  return { state, events };
}

function activeEvents(state) {
  const superseded = new Set(state.events.map(event => event.supersedesEventId).filter(Boolean));
  return state.events.filter(event => !superseded.has(event.id));
}

function contextScore(query, context) {
  if (normalize(query.vendor) !== normalize(context.vendor)) return 0;
  let score = .35;
  const querySku = normalizeSku(query.sku), learnedSku = normalizeSku(context.sku);
  if (querySku && learnedSku) score += querySku === learnedSku ? .42 : -.18;
  else if (querySku || learnedSku) score -= .04;
  score += overlap(query.description, context.description) * .18;
  if (query.paymentAccountId && context.paymentAccountId) score += query.paymentAccountId === context.paymentAccountId ? .03 : -.02;
  if (query.taxState && context.taxState) score += String(query.taxState).toUpperCase() === String(context.taxState).toUpperCase() ? .02 : 0;
  return Math.max(0, Math.min(1, score));
}

export function suggestFromApprovedLearning(value, input, policy = REINA_CONFIDENCE_POLICY) {
  const state = ensureLearningState(value); const candidates = [];
  for (const event of activeEvents(state).filter(item => item.companyId === input.companyId)) {
    const similarity = contextScore(input, event.context); if (similarity >= .3) candidates.push({ output: event.output, similarity, approvals: 1, eventId: event.id });
  }
  for (const rule of state.migratedRules.filter(item => ['legacy', input.companyId].includes(item.companyId))) {
    const similarity = contextScore(input, rule.context); if (similarity >= .3) candidates.push({ output: rule.output, similarity: Math.min(.78, similarity), approvals: rule.approvals, eventId: rule.id, legacy: true });
  }
  if (!candidates.length) return { decision: 'unknown', confidence: .25, support: 0, conflicts: 0, reason: 'No approved company history matches this item.' };
  const groups = new Map();
  for (const candidate of candidates) {
    const key = outputKey(candidate.output); const group = groups.get(key) || { output: candidate.output, support: 0, weighted: 0, eventIds: [] };
    group.support += candidate.approvals; group.weighted += candidate.similarity * candidate.approvals; group.eventIds.push(candidate.eventId); groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((a, b) => b.weighted - a.weighted || b.support - a.support); const best = ranked[0]; const totalSupport = ranked.reduce((sum, group) => sum + group.support, 0); const conflicts = totalSupport - best.support; const agreement = best.support / totalSupport; const contextConfidence = best.weighted / best.support; const confidence = clamp(.38 + Math.min(.26, best.support * .07) + contextConfidence * .28 + agreement * .12 - (1 - agreement) * .3);
  const conflictRate = conflicts / totalSupport;
  const decision = best.support >= policy.minimumRepeatApprovals && conflictRate <= policy.maximumConflictRate && confidence >= policy.autoFill ? 'auto_fill' : confidence >= policy.showAsFilled ? 'review' : 'unknown';
  return { ...best.output, decision, confidence, support: best.support, conflicts, agreement: money(agreement), matchedEventIds: best.eventIds, reason: conflicts ? `Matched ${best.support} approved choice(s), but found ${conflicts} conflicting choice(s). Human confirmation is required.` : `Matched ${best.support} approved company choice(s) for this vendor and item context.` };
}

export function confidenceDecision(confidence, { valuePresent = true, reconciled = true, conflict = false } = {}, policy = REINA_CONFIDENCE_POLICY) {
  const score = clamp(confidence);
  if (!valuePresent || score < policy.showAsFilled) return { decision: 'unknown', confidence: score, requiresReview: true };
  if (conflict || !reconciled || score < policy.autoFill) return { decision: 'review', confidence: score, requiresReview: true };
  return { decision: 'auto_fill', confidence: score, requiresReview: false };
}

export function annotateScanConfidence(scan = {}, policy = REINA_CONFIDENCE_POLICY) {
  const overall = clamp(scan.confidence || .45); const explicit = scan.fieldConfidence || {};
  const numeric = field => Number.isFinite(Number(scan[field]));
  const subtotalExpected = money(Number(scan.subtotal || 0) - Number(scan.discount || 0) + Number(scan.shipping || 0) + Number(scan.salesTaxTotal || 0));
  const totalReconciles = !numeric('subtotal') || !numeric('total') || Math.abs(subtotalExpected - money(scan.total)) < .01;
  const lineSubtotal = money((scan.lineItems || []).reduce((sum, line) => sum + Number(line.subtotal || 0), 0));
  const linesReconcile = !(scan.lineItems || []).length || !numeric('subtotal') || Math.abs(lineSubtotal - money(scan.subtotal)) < .02;
  const fields = ['documentType', 'vendor', 'transactionDate', 'dueDate', 'statementStartDate', 'statementEndDate', 'beginningBalance', 'endingBalance', 'receiptNumber', 'subtotal', 'salesTaxTotal', 'salesTaxState', 'total', 'paymentMethod', 'cardLast4'];
  const decisions = {};
  for (const field of fields) {
    const value = scan[field]; let confidence = clamp(explicit[field] ?? overall);
    if (['subtotal', 'salesTaxTotal', 'total'].includes(field) && totalReconciles) confidence = clamp(confidence + .04);
    const reconciled = !['subtotal', 'salesTaxTotal', 'total'].includes(field) || totalReconciles;
    decisions[field] = confidenceDecision(confidence, { valuePresent: value !== null && value !== undefined && value !== '', reconciled }, policy);
  }
  const lineItems = (scan.lineItems || []).map((line, index) => ({ index, description: confidenceDecision(line.descriptionConfidence ?? line.confidence ?? overall, { valuePresent: !!line.description }), sku: confidenceDecision(line.skuConfidence ?? line.confidence ?? overall, { valuePresent: !!line.sku }), subtotal: confidenceDecision(line.subtotalConfidence ?? line.confidence ?? overall, { valuePresent: Number.isFinite(Number(line.subtotal)), reconciled: linesReconcile }), productImage: confidenceDecision(line.productImageRegion?.confidence ?? 0, { valuePresent: !!line.productImageRegion }) }));
  const requiredFields = new Set(['documentType']);
  if (['receipt', 'vendor_bill'].includes(scan.documentType)) for (const field of ['vendor', 'transactionDate', 'subtotal', 'total']) requiredFields.add(field);
  if (scan.documentType === 'vendor_bill') requiredFields.add('dueDate');
  if (Number(scan.salesTaxTotal || 0) > 0) requiredFields.add('salesTaxState');
  if (['bank_statement', 'credit_card_statement'].includes(scan.documentType)) for (const field of ['statementStartDate', 'statementEndDate', 'beginningBalance', 'endingBalance']) requiredFields.add(field);
  const reviewFields = [...requiredFields].filter(field => decisions[field]?.requiresReview);
  return { ...scan, confidencePolicy: { version: 1, thresholds: policy }, fieldDecisions: decisions, lineItemDecisions: lineItems, arithmetic: { totalReconciles, lineSubtotalsReconcile: linesReconcile, expectedTotal: subtotalExpected, lineSubtotal }, reviewSummary: { requiresReview: reviewFields.length > 0 || !totalReconciles || !linesReconcile, fields: reviewFields, arithmeticWarnings: [...(!totalReconciles ? ['Receipt subtotal, adjustments, tax, and total do not reconcile.'] : []), ...(!linesReconcile ? ['Line items do not add back to the receipt subtotal.'] : [])] } };
}

export function learningHealth(value) {
  const state = ensureLearningState(value); const active = activeEvents(state); const chain = verifyLearningChain(state); const contexts = new Map();
  for (const event of active) { const key = [event.companyId, normalize(event.context.vendor), normalizeSku(event.context.sku), normalize(event.context.description)].join('|'); const outputs = contexts.get(key) || new Set(); outputs.add(outputKey(event.output)); contexts.set(key, outputs); }
  const conflictingContexts = [...contexts.values()].filter(outputs => outputs.size > 1).length;
  return { version: state.version, approvedCorrections: state.events.length, activeMemories: active.length, migratedRules: state.migratedRules.length, conflictingContexts, audit: chain, safeToLearn: chain.valid };
}

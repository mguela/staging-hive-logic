import { createHash, randomUUID } from 'node:crypto';
import { annotateScanConfidence, createLearningState, learningHealth, recordApprovedLearning, suggestFromApprovedLearning } from './reina-learning.js';

const normalize = value => String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cents = value => Math.round((Number(value) || 0) * 100);
const importantMoneyFields = new Set(['subtotal', 'discount', 'shipping', 'salesTaxTotal', 'total', 'beginningBalance', 'endingBalance']);
const criticalFields = new Set(['vendor', 'transactionDate', 'total', 'salesTaxTotal', 'salesTaxState', 'statementEndDate', 'endingBalance']);
const benchmarkFields = new Set(['documentType', 'vendor', 'transactionDate', 'dueDate', 'statementStartDate', 'statementEndDate', 'receiptNumber', 'paymentMethod', 'cardLast4', 'accountLast4', 'subtotal', 'discount', 'shipping', 'salesTaxTotal', 'salesTaxState', 'total', 'beginningBalance', 'endingBalance', 'currency']);
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');

const curriculum = [
  {
    id: 'receipt-materials-two-lines', label: 'Materials receipt with exact penny tax', expectedReview: false,
    truth: { documentType: 'receipt', vendor: 'Home Depot', transactionDate: '2026-07-19', subtotal: 82.90, salesTaxTotal: 5.39, salesTaxState: 'FL', total: 88.29 },
    actual: { documentType: 'receipt', vendor: 'Home Depot', transactionDate: '2026-07-19', subtotal: 82.90, salesTaxTotal: 5.39, salesTaxState: 'FL', total: 88.29, confidence: .98, lineItems: [{ description: 'VEVOR inline duct fan', sku: 'WK32522449', subtotal: 82.90, confidence: .96 }] }
  },
  {
    id: 'receipt-split-jobs', label: 'Supplier receipt split across two jobs', expectedReview: false,
    truth: { documentType: 'receipt', vendor: 'ABC Supply', transactionDate: '2026-07-08', subtotal: 240, salesTaxTotal: 15.24, salesTaxState: 'CT', total: 255.24 },
    actual: { documentType: 'receipt', vendor: 'ABC Supply', transactionDate: '2026-07-08', subtotal: 240, salesTaxTotal: 15.24, salesTaxState: 'CT', total: 255.24, confidence: .97, lineItems: [{ description: 'Copper pipe', sku: 'CP-10', subtotal: 160, confidence: .96 }, { description: 'Fittings', sku: 'FT-22', subtotal: 80, confidence: .95 }] }
  },
  {
    id: 'subcontractor-bill', label: 'Unpaid subcontractor bill', expectedReview: false,
    truth: { documentType: 'vendor_bill', vendor: 'Bright Wire LLC', transactionDate: '2026-07-16', dueDate: '2026-08-15', subtotal: 1400, salesTaxTotal: 0, total: 1400 },
    actual: { documentType: 'vendor_bill', vendor: 'Bright Wire LLC', transactionDate: '2026-07-16', dueDate: '2026-08-15', subtotal: 1400, salesTaxTotal: 0, total: 1400, confidence: .97, lineItems: [{ description: 'Electrical rough-in labor', subtotal: 1400, confidence: .97 }] }
  },
  {
    id: 'fuel-receipt', label: 'Truck fuel receipt', expectedReview: false,
    truth: { documentType: 'receipt', vendor: 'Shell', transactionDate: '2026-07-11', subtotal: 118.42, salesTaxTotal: 0, total: 118.42, cardLast4: '4421' },
    actual: { documentType: 'receipt', vendor: 'Shell', transactionDate: '2026-07-11', subtotal: 118.42, salesTaxTotal: 0, total: 118.42, cardLast4: '4421', paymentMethod: 'Visa', confidence: .96, lineItems: [{ description: 'Diesel fuel', quantity: 33.45, unitPrice: 3.54, subtotal: 118.42, confidence: .94 }] }
  },
  {
    id: 'tool-rental', label: 'Equipment rental receipt', expectedReview: false,
    truth: { documentType: 'receipt', vendor: 'Sunbelt Rentals', transactionDate: '2026-07-09', subtotal: 750, salesTaxTotal: 45, salesTaxState: 'FL', total: 795 },
    actual: { documentType: 'receipt', vendor: 'Sunbelt Rentals', transactionDate: '2026-07-09', subtotal: 750, salesTaxTotal: 45, salesTaxState: 'FL', total: 795, confidence: .96, lineItems: [{ description: 'Towable lift rental', subtotal: 750, confidence: .95 }] }
  },
  {
    id: 'credit-card-statement', label: 'Credit-card statement with transactions', expectedReview: false,
    truth: { documentType: 'credit_card_statement', statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', beginningBalance: 0, endingBalance: 1072.71, cardLast4: '1008' },
    actual: { documentType: 'credit_card_statement', statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', beginningBalance: 0, endingBalance: 1072.71, cardLast4: '1008', confidence: .96, transactions: [{ postedDate: '2026-07-06', description: 'HOME DEPOT', amount: -88.29, externalId: 'a1', confidence: .97 }, { postedDate: '2026-07-10', description: 'SUNBELT RENTALS', amount: -795, externalId: 'a2', confidence: .96 }] }
  },
  {
    id: 'bank-statement', label: 'Operating-bank statement', expectedReview: false,
    truth: { documentType: 'bank_statement', statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', beginningBalance: 25000, endingBalance: 41721, accountLast4: '4421' },
    actual: { documentType: 'bank_statement', statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', beginningBalance: 25000, endingBalance: 41721, accountLast4: '4421', confidence: .97, transactions: [{ postedDate: '2026-07-03', description: 'CUSTOMER DEPOSIT', amount: 21400, externalId: 'b1', confidence: .98 }] }
  },
  {
    id: 'faded-receipt', label: 'Faded receipt with an unreadable total', expectedReview: true,
    truth: { documentType: 'receipt', vendor: 'Local Hardware', transactionDate: '2026-07-22', subtotal: 46.20, salesTaxTotal: 2.77, salesTaxState: 'FL', total: 48.97 },
    actual: { documentType: 'receipt', vendor: 'Local Hardw?re', transactionDate: '2026-07-22', subtotal: 46.20, salesTaxTotal: 2.77, salesTaxState: 'FL', total: null, confidence: .74, fieldConfidence: { vendor: .58, transactionDate: .9, subtotal: .88, salesTaxTotal: .86, salesTaxState: .83, total: .2 }, warnings: ['Total is unreadable.'], lineItems: [{ description: 'Fasteners', subtotal: 46.20, confidence: .72 }] }
  },
  {
    id: 'bad-arithmetic', label: 'Receipt whose printed arithmetic does not reconcile', expectedReview: true,
    truth: { documentType: 'receipt', vendor: 'Tool Warehouse', transactionDate: '2026-07-23', subtotal: 100, salesTaxTotal: 6, salesTaxState: 'FL', total: 106 },
    actual: { documentType: 'receipt', vendor: 'Tool Warehouse', transactionDate: '2026-07-23', subtotal: 100, salesTaxTotal: 6, salesTaxState: 'FL', total: 109, confidence: .98, warnings: ['Printed total conflicts with visible subtotal and tax.'], lineItems: [{ description: 'Circular saw', subtotal: 100, confidence: .97 }] }
  },
  {
    id: 'loan-statement', label: 'Truck loan statement', expectedReview: true,
    truth: { documentType: 'loan_statement', vendor: 'Commercial Auto Finance', statementEndDate: '2026-07-31', endingBalance: 28400 },
    actual: { documentType: 'loan_statement', vendor: 'Commercial Auto Finance', statementEndDate: '2026-07-31', endingBalance: 28400, confidence: .88, warnings: ['Principal and interest allocation requires review.'] }
  }
];

function same(field, expected, actual) {
  if (importantMoneyFields.has(field)) return cents(expected) === cents(actual);
  return normalize(expected) === normalize(actual);
}

function evaluateCase(item) {
  const annotated = annotateScanConfidence(item.actual); const fieldRows = [];
  for (const [field, expected] of Object.entries(item.truth)) {
    const actual = item.actual[field]; const matches = same(field, expected, actual); const decision = annotated.fieldDecisions[field]?.decision || 'not_scored';
    fieldRows.push({ field, expected, actual: actual ?? null, matches, decision, critical: criticalFields.has(field), dangerous: criticalFields.has(field) && !matches && decision === 'auto_fill' });
  }
  const expectedReview = item.expectedReview; const actualReview = annotated.reviewSummary.requiresReview || (item.actual.warnings || []).length > 0;
  return { id: item.id, label: item.label, expectedReview, actualReview, routedCorrectly: expectedReview === actualReview, fields: fieldRows, matchedFields: fieldRows.filter(row => row.matches).length, totalFields: fieldRows.length, dangerousErrors: fieldRows.filter(row => row.dangerous).length, arithmetic: annotated.arithmetic, warnings: item.actual.warnings || [] };
}

function learningCurriculum() {
  let state = createLearningState(); const actor = { id: 'curriculum-bookkeeper', role: 'bookkeeper' };
  const learn = input => { state = recordApprovedLearning(state, { companyId: 'practice-company', vendor: 'Home Depot', paymentAccountId: 'card-1', taxState: 'FL', ...input }, actor).state; };
  for (let index = 0; index < 3; index += 1) learn({ sku: 'ROMEX-122', description: '12/2 Romex wire', suggestion: { ownerType: 'job', ownerId: 'JOB-44', qboAccountId: '64' } });
  learn({ sku: 'DRILL-20V', description: '20V cordless drill', suggestion: { ownerType: 'tools', ownerId: 'Shop tools', qboAccountId: '72' } });
  const cases = [
    { label: 'Repeated Romex purchase', expected: 'auto_fill', query: { companyId: 'practice-company', vendor: 'Home Depot', sku: 'ROMEX-122', description: 'Romex 12/2 wire', paymentAccountId: 'card-1', taxState: 'FL' } },
    { label: 'First known drill purchase', expected: 'review', query: { companyId: 'practice-company', vendor: 'Home Depot', sku: 'DRILL-20V', description: 'Cordless drill', paymentAccountId: 'card-1', taxState: 'FL' } },
    { label: 'Home Depot without an item', expected: 'review', query: { companyId: 'practice-company', vendor: 'Home Depot' } },
    { label: 'Different company with no history', expected: 'unknown', query: { companyId: 'other-company', vendor: 'Home Depot', sku: 'ROMEX-122', description: 'Romex wire' } }
  ].map(item => { const suggestion = suggestFromApprovedLearning(state, item.query); return { ...item, actual: suggestion.decision, passed: suggestion.decision === item.expected, suggestion }; });
  return { health: learningHealth(state), cases, passed: cases.filter(item => item.passed).length, total: cases.length };
}

export function runReinaBenchmark() {
  const cases = curriculum.map(evaluateCase); const matchedFields = cases.reduce((sum, item) => sum + item.matchedFields, 0); const totalFields = cases.reduce((sum, item) => sum + item.totalFields, 0); const dangerousErrors = cases.reduce((sum, item) => sum + item.dangerousErrors, 0); const routed = cases.filter(item => item.routedCorrectly).length; const learning = learningCurriculum();
  const extractionAccuracy = Math.round(matchedFields / totalFields * 1000) / 10; const reviewRoutingAccuracy = Math.round(routed / cases.length * 1000) / 10; const learningAccuracy = Math.round(learning.passed / learning.total * 1000) / 10;
  return {
    benchmarkVersion: 1, generatedAt: new Date().toISOString(), curriculum: { documents: cases.length, fields: totalFields, documentTypes: [...new Set(curriculum.map(item => item.truth.documentType))].sort() },
    summary: { extractionAccuracy, reviewRoutingAccuracy, learningAccuracy, dangerousAutoFillErrors: dangerousErrors, safe: dangerousErrors === 0 && reviewRoutingAccuracy === 100 && learningAccuracy === 100 },
    cases, learning
  };
}

export function evaluateReinaExtraction(expected, actual, { expectedReview = false, id = 'external', label = 'Uploaded benchmark document' } = {}) {
  return evaluateCase({ id, label, expectedReview, truth: expected, actual });
}

export function createBenchmarkRegistry() { return { version: 1, cases: [], createdAt: new Date().toISOString() }; }
export function ensureBenchmarkRegistry(value) { return value?.version === 1 && Array.isArray(value.cases) ? structuredClone(value) : createBenchmarkRegistry(); }
function registryHash(previousHash, record) { return digest({ previousHash: previousHash || null, record: { ...record, hash: undefined, previousHash: undefined } }); }

export function verifyBenchmarkRegistry(value) {
  const registry = ensureBenchmarkRegistry(value); let previousHash = null;
  for (const record of registry.cases) { if (record.previousHash !== previousHash || record.hash !== registryHash(previousHash, record)) return { valid: false, brokenAt: record.id, records: registry.cases.length }; previousHash = record.hash; }
  return { valid: true, records: registry.cases.length, head: previousHash };
}

export function recordPermissionedBenchmarkCase(value, input, actor = { id: 'controller', role: 'controller' }) {
  if (actor.role !== 'controller') throw new Error('Only a controller can add a real document to the Reina benchmark.');
  if (input.authorizationConfirmed !== true) throw new Error('Explicit authorization is required before a real document can enter the benchmark.');
  if (!input.companyId || !input.evidenceDocumentId || !input.evidenceSha256 || !input.actual) throw new Error('Company-scoped evidence and its extracted result are required.');
  const expected = Object.fromEntries(Object.entries(input.expected || {}).filter(([field, value]) => benchmarkFields.has(field) && value !== undefined));
  if (!expected.documentType) throw new Error('The controller-approved document type is required.');
  const registry = ensureBenchmarkRegistry(value); if (input.supersedesCaseId && !registry.cases.some(item => item.id === input.supersedesCaseId && item.companyId === input.companyId)) throw new Error('The benchmark case being corrected was not found.');
  const previousHash = registry.cases.at(-1)?.hash || null; const record = { id: randomUUID(), companyId: input.companyId, evidenceDocumentId: input.evidenceDocumentId, evidenceSha256: input.evidenceSha256, label: String(input.label || 'Permissioned validation document').slice(0, 160), expected, expectedReview: !!input.expectedReview, actualSnapshot: structuredClone(input.actual), authorization: { confirmed: true, confirmedBy: actor.id, confirmedAt: new Date().toISOString(), purpose: 'Reina bookkeeping accuracy validation' }, supersedesCaseId: input.supersedesCaseId || null, previousHash };
  record.hash = registryHash(previousHash, record); registry.cases.push(record); registry.updatedAt = record.authorization.confirmedAt; return { registry, record };
}

export function evaluatePermissionedBenchmark(value, companyId) {
  const registry = ensureBenchmarkRegistry(value); const superseded = new Set(registry.cases.map(item => item.supersedesCaseId).filter(Boolean)); const active = registry.cases.filter(item => item.companyId === companyId && !superseded.has(item.id)); const cases = active.map(item => evaluateReinaExtraction(item.expected, item.actualSnapshot, { expectedReview: item.expectedReview, id: item.id, label: item.label })); const matchedFields = cases.reduce((sum, item) => sum + item.matchedFields, 0); const totalFields = cases.reduce((sum, item) => sum + item.totalFields, 0); const dangerousErrors = cases.reduce((sum, item) => sum + item.dangerousErrors, 0); const routed = cases.filter(item => item.routedCorrectly).length;
  const coverage = Object.fromEntries(['receipt', 'vendor_bill', 'bank_statement', 'credit_card_statement', 'loan_statement'].map(type => [type, active.filter(item => item.expected.documentType === type).length])); const productionRepresentative = cases.length >= 100 && coverage.receipt >= 40 && coverage.vendor_bill >= 20 && coverage.bank_statement >= 15 && coverage.credit_card_statement >= 15 && coverage.loan_statement >= 10;
  return { cases: cases.length, fields: totalFields, coverage, extractionAccuracy: totalFields ? Math.round(matchedFields / totalFields * 1000) / 10 : null, reviewRoutingAccuracy: cases.length ? Math.round(routed / cases.length * 1000) / 10 : null, dangerousAutoFillErrors: dangerousErrors, productionRepresentative, registryAudit: verifyBenchmarkRegistry(registry), results: cases };
}

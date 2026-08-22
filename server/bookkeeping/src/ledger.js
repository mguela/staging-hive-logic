import { createHash, randomUUID } from 'node:crypto';

const cents = value => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : Number.NaN;
};
const amount = value => {
  const valueInCents = cents(value);
  return Number.isFinite(valueInCents) ? valueInCents / 100 : Number.NaN;
};
const clone = value => structuredClone(value);
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
export const ROLES = {
  submitter: ['entry:create', 'entry:view'],
  approver: ['entry:view', 'entry:approve'],
  bookkeeper: ['entry:create', 'entry:view', 'entry:approve', 'entry:post', 'entry:reverse', 'reconcile'],
  controller: ['entry:create', 'entry:view', 'entry:approve', 'entry:post', 'entry:reverse', 'reconcile', 'period:lock', 'period:unlock', 'adjustment:create'],
  auditor: ['entry:view', 'audit:view', 'export']
};

export function createLedger() {
  return { version: 1, companies: {}, audit: [] };
}

function requirePermission(role, permission) {
  if (!(ROLES[role] || []).includes(permission)) throw new Error(`${role || 'Unknown role'} cannot ${permission}.`);
}

function auditHash(previousHash, event) {
  return createHash('sha256').update(`${previousHash || 'GENESIS'}|${canonical(event)}`).digest('hex');
}

function appendAudit(ledger, event) {
  const record = { id: randomUUID(), at: new Date().toISOString(), ...structuredClone(event) };
  record.previousHash = ledger.audit.at(-1)?.hash || null;
  record.hash = auditHash(record.previousHash, { ...record, hash: undefined, previousHash: undefined });
  ledger.audit.push(record);
  return record;
}

export function recordAuditEvent(ledger, event) { return appendAudit(ledger, event); }

function postedEntryContent(entry) {
  return { id: entry.id, companyId: entry.companyId, date: entry.date, cashDate: entry.cashDate, description: entry.description, memo: entry.memo, basis: entry.basis, kind: entry.kind, source: entry.source, sourceId: entry.sourceId, lines: entry.lines, cashLines: entry.cashLines };
}

function postedEntrySeal(entry) { return createHash('sha256').update(canonical(postedEntryContent(entry))).digest('hex'); }

export function addCompany(ledger, { id = randomUUID(), name, basis = 'accrual', fiscalYearStartMonth = 1, accounts = [] }, actor = { id: 'system', role: 'controller' }) {
  if (!name?.trim()) throw new Error('Company name is required.');
  if (!['cash', 'accrual'].includes(basis)) throw new Error('Accounting basis must be cash or accrual.');
  if (ledger.companies[id]) throw new Error('Company already exists.');
  const accountMap = {};
  for (const account of accounts) {
    if (!account.id || !account.name || !ACCOUNT_TYPES.includes(account.type)) throw new Error('Every account needs an id, name, and valid type.');
    accountMap[account.id] = { active: true, normalBalance: ['asset', 'expense'].includes(account.type) ? 'debit' : 'credit', ...account };
  }
  ledger.companies[id] = { id, name: name.trim(), basis, fiscalYearStartMonth, closingDate: null, accounts: accountMap, periods: {}, entries: [], reconciliations: [], syncKeys: {} };
  appendAudit(ledger, { companyId: id, actorId: actor.id, action: 'company.created', entityType: 'company', entityId: id, after: { name, basis, fiscalYearStartMonth } });
  return ledger.companies[id];
}

function companyOf(ledger, companyId) {
  const company = ledger.companies[companyId];
  if (!company) throw new Error('Company not found.');
  return company;
}

function periodKey(date) { return String(date).slice(0, 7); }

export function validateJournalEntry(ledger, input) {
  const errors = [];
  const company = ledger.companies[input.companyId];
  if (!company) errors.push('Company is required.');
  if (!validDate(input.date)) errors.push('A valid posting date is required.');
  if (input.cashDate && !validDate(input.cashDate)) errors.push('A valid cash recognition date is required.');
  if (input.basis && !['cash', 'accrual'].includes(input.basis)) errors.push('Basis must be cash or accrual.');
  if (!input.description?.trim()) errors.push('Description is required.');
  const validateLines = (lines, label) => {
    if (!Array.isArray(lines) || lines.length < 2) { errors.push(`At least two ${label}journal lines are required.`); return { debits: 0, credits: 0 }; }
    let debits = 0, credits = 0;
    for (const [index, line] of lines.entries()) {
      if (!company?.accounts[line.accountId]) errors.push(`${label}line ${index + 1} has an invalid account.`);
      const debit = cents(line.debit), credit = cents(line.credit);
      if (!Number.isFinite(debit) || !Number.isFinite(credit)) {
        errors.push(`${label}line ${index + 1} contains an invalid amount.`);
        continue;
      }
      if (debit < 0 || credit < 0) {
        errors.push(`${label}line ${index + 1} cannot contain a negative debit or credit.`);
        continue;
      }
      if ((debit > 0) === (credit > 0)) errors.push(`${label}line ${index + 1} must contain either a debit or a credit.`);
      debits += debit; credits += credit;
    }
    if (debits !== credits) errors.push(`${label}debits and credits must balance. Difference: ${amount(debits - credits).toFixed(2)}.`);
    if (debits <= 0) errors.push(`${label}journal entry total must be greater than zero.`);
    return { debits, credits };
  };
  const { debits, credits } = validateLines(input.lines, '');
  if (input.cashLines != null) validateLines(input.cashLines, 'Cash-basis ');
  if (input.cashLines && !input.cashDate) errors.push('Cash-basis journal lines require a cash recognition date.');
  if (company?.periods[periodKey(input.date)]?.locked) errors.push(`Posting period ${periodKey(input.date)} is locked.`);
  if (company?.closingDate && input.date <= company.closingDate) errors.push(`Posting date ${input.date} is on or before the closing date ${company.closingDate}.`);
  return { valid: errors.length === 0, errors, debits: amount(debits), credits: amount(credits) };
}

export function createEntry(ledger, input, actor) {
  requirePermission(actor.role, input.kind === 'adjustment' ? 'adjustment:create' : 'entry:create');
  const validation = validateJournalEntry(ledger, input);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  const company = companyOf(ledger, input.companyId);
  const normalizeLines = lines => lines?.map((line, index) => ({ id: String(index + 1), accountId: line.accountId, debit: amount(line.debit), credit: amount(line.credit), memo: line.memo || '', dimensions: line.dimensions || {} }));
  const basis = input.basis || company.basis;
  const entry = { id: randomUUID(), companyId: input.companyId, date: input.date, cashDate: input.cashDate || (basis === 'cash' ? input.date : null), description: input.description.trim(), memo: input.memo || '', basis, kind: input.kind || 'standard', source: input.source || 'manual', sourceId: input.sourceId || null, status: 'pending_approval', createdBy: actor.id, createdAt: new Date().toISOString(), lines: normalizeLines(input.lines), cashLines: normalizeLines(input.cashLines) };
  company.entries.push(entry);
  appendAudit(ledger, { companyId: company.id, actorId: actor.id, action: 'entry.created', entityType: 'journal_entry', entityId: entry.id, after: entry });
  return entry;
}

export function approveEntry(ledger, companyId, entryId, actor) {
  requirePermission(actor.role, 'entry:approve');
  const entry = companyOf(ledger, companyId).entries.find(item => item.id === entryId);
  if (!entry) throw new Error('Journal entry not found.');
  if (entry.createdBy === actor.id) throw new Error('Separation of duties prevents approving your own entry.');
  if (entry.status !== 'pending_approval') throw new Error('Only pending entries can be approved.');
  entry.status = 'approved'; entry.approvedBy = actor.id; entry.approvedAt = new Date().toISOString();
  appendAudit(ledger, { companyId, actorId: actor.id, action: 'entry.approved', entityType: 'journal_entry', entityId: entry.id, after: { status: entry.status, approvedBy: actor.id } });
  return entry;
}

export function postEntry(ledger, companyId, entryId, actor, idempotencyKey) {
  requirePermission(actor.role, 'entry:post');
  if (!idempotencyKey) throw new Error('An idempotency key is required.');
  const company = companyOf(ledger, companyId);
  if (company.syncKeys[idempotencyKey]) return company.entries.find(entry => entry.id === company.syncKeys[idempotencyKey]);
  const entry = company.entries.find(item => item.id === entryId);
  if (!entry) throw new Error('Journal entry not found.');
  if (entry.status !== 'approved') throw new Error('Only approved entries can be posted.');
  const validation = validateJournalEntry(ledger, entry);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  entry.status = 'posted'; entry.postedBy = actor.id; entry.postedAt = new Date().toISOString(); entry.idempotencyKey = idempotencyKey; entry.contentSeal = postedEntrySeal(entry);
  company.syncKeys[idempotencyKey] = entry.id;
  appendAudit(ledger, { companyId, actorId: actor.id, action: 'entry.posted', entityType: 'journal_entry', entityId: entry.id, after: { status: entry.status, idempotencyKey, contentSeal: entry.contentSeal } });
  return entry;
}

export function reverseEntry(ledger, companyId, entryId, date, reason, actor) {
  requirePermission(actor.role, 'entry:reverse');
  const company = companyOf(ledger, companyId);
  const original = company.entries.find(item => item.id === entryId);
  if (!original || original.status !== 'posted') throw new Error('Only posted entries can be reversed.');
  if (original.reversedByEntryId) return company.entries.find(entry => entry.id === original.reversedByEntryId);
  const reverseLines = lines => lines?.map(line => ({ accountId: line.accountId, debit: line.credit, credit: line.debit, memo: `Reverses ${original.id}`, dimensions: line.dimensions }));
  const reversal = createEntry(ledger, { companyId, date, cashDate: original.cashLines ? date : null, description: `Reversal: ${original.description}`, memo: reason, basis: original.basis, kind: 'reversal', source: 'reversal', sourceId: original.id, lines: reverseLines(original.lines), cashLines: reverseLines(original.cashLines) }, actor);
  reversal.status = 'approved'; reversal.approvedBy = actor.id; reversal.approvedAt = new Date().toISOString();
  postEntry(ledger, companyId, reversal.id, actor, `reversal:${original.id}`);
  original.reversedByEntryId = reversal.id;
  appendAudit(ledger, { companyId, actorId: actor.id, action: 'entry.reversed', entityType: 'journal_entry', entityId: original.id, after: { reversedByEntryId: reversal.id, reason } });
  return reversal;
}

export function correctEntry(ledger, companyId, entryId, replacement, reason, actor) {
  if (!reason?.trim()) throw new Error('Correction reason is required.');
  const original = companyOf(ledger, companyId).entries.find(item => item.id === entryId);
  if (!original || original.status !== 'posted') throw new Error('Only posted entries can be corrected.');
  const reversal = reverseEntry(ledger, companyId, entryId, replacement.date, reason, actor);
  const corrected = createEntry(ledger, { ...replacement, companyId, kind: 'adjustment', source: 'correction', sourceId: original.id, memo: [replacement.memo, `Correction of ${original.id}: ${reason}`].filter(Boolean).join(' | ') }, actor);
  corrected.status = 'approved'; corrected.approvedBy = actor.id; corrected.approvedAt = new Date().toISOString(); postEntry(ledger, companyId, corrected.id, actor, `correction:${original.id}`);
  original.correctedByEntryId = corrected.id; corrected.reversalEntryId = reversal.id;
  appendAudit(ledger, { companyId, actorId: actor.id, action: 'entry.corrected', entityType: 'journal_entry', entityId: original.id, after: { reversalEntryId: reversal.id, correctedByEntryId: corrected.id, reason } });
  return { original, reversal, corrected };
}

export function setPeriodLock(ledger, companyId, month, locked, actor) {
  requirePermission(actor.role, locked ? 'period:lock' : 'period:unlock');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Period must be YYYY-MM.');
  const company = companyOf(ledger, companyId);
  company.periods[month] = { locked, changedAt: new Date().toISOString(), changedBy: actor.id };
  appendAudit(ledger, { companyId, actorId: actor.id, action: locked ? 'period.locked' : 'period.unlocked', entityType: 'period', entityId: month, after: company.periods[month] });
  return company.periods[month];
}

export function setClosingDate(ledger, companyId, throughDate, actor) {
  requirePermission(actor.role, 'period:lock');
  if (!validDate(throughDate)) throw new Error('Closing date must be a real calendar date in YYYY-MM-DD format.');
  const company = companyOf(ledger, companyId); if (company.closingDate && throughDate < company.closingDate) throw new Error('Closing date cannot move backward. Use a controlled reopening workflow.');
  if (company.closingDate === throughDate) return company.closingDate;
  const previous = company.closingDate || null; company.closingDate = throughDate;
  appendAudit(ledger, { companyId, actorId: actor.id, action: 'closing_date.set', entityType: 'company', entityId: companyId, before: { closingDate: previous }, after: { closingDate: throughDate } }); return company.closingDate;
}

export function trialBalance(ledger, companyId, throughDate = '9999-12-31') {
  const company = companyOf(ledger, companyId); const balances = {};
  for (const account of Object.values(company.accounts)) balances[account.id] = { accountId: account.id, name: account.name, type: account.type, debit: 0, credit: 0, balance: 0 };
  for (const entry of company.entries.filter(item => item.status === 'posted' && item.date <= throughDate)) for (const line of entry.lines) { balances[line.accountId].debit = amount(balances[line.accountId].debit + line.debit); balances[line.accountId].credit = amount(balances[line.accountId].credit + line.credit); }
  for (const row of Object.values(balances)) row.balance = amount(row.debit - row.credit);
  const rows = Object.values(balances); const totalDebits = amount(rows.reduce((sum, row) => sum + row.debit, 0)); const totalCredits = amount(rows.reduce((sum, row) => sum + row.credit, 0));
  return { companyId, throughDate, rows, totalDebits, totalCredits, balanced: cents(totalDebits) === cents(totalCredits) };
}

export function balanceSheet(ledger, companyId, throughDate = '9999-12-31') {
  const trial = trialBalance(ledger, companyId, throughDate);
  const byType = type => amount(trial.rows.filter(row => row.type === type).reduce((sum, row) => sum + row.balance, 0));
  const assets = byType('asset'); const liabilities = -byType('liability'); const equityPosted = -byType('equity'); const currentEarnings = amount(-byType('income') - byType('expense')); const equity = amount(equityPosted + currentEarnings);
  return { companyId, throughDate, assets, liabilities, equityPosted, retainedEarningsAndCurrentIncome: currentEarnings, equity, balanced: cents(assets) === cents(liabilities + equity), difference: amount(assets - liabilities - equity) };
}

export function verifyAuditChain(ledger) {
  let previousHash = null;
  for (const record of ledger.audit) {
    if (record.previousHash !== previousHash) return { valid: false, brokenAt: record.id };
    const expected = auditHash(previousHash, { ...record, hash: undefined, previousHash: undefined });
    if (record.hash !== expected) return { valid: false, brokenAt: record.id };
    previousHash = record.hash;
  }
  return { valid: true, records: ledger.audit.length, head: previousHash };
}

export function verifyPostedEntries(ledger, companyId) {
  const company = companyOf(ledger, companyId); const failures = [];
  for (const entry of company.entries.filter(item => item.status === 'posted')) {
    const expected = postedEntrySeal(entry); const auditSeal = [...ledger.audit].reverse().find(record => record.action === 'entry.posted' && record.entityId === entry.id)?.after?.contentSeal;
    if (!entry.contentSeal || entry.contentSeal !== expected || auditSeal !== entry.contentSeal) failures.push({ entryId: entry.id, reason: !entry.contentSeal ? 'missing seal' : entry.contentSeal !== expected ? 'content changed' : 'audit seal mismatch' });
  }
  return { valid: failures.length === 0, checked: company.entries.filter(item => item.status === 'posted').length, failures };
}

export function snapshot(ledger) { return clone(ledger); }

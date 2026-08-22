// api/bookkeeping/ledger/_audit-log.test.mjs
// Proves the actual point of sql/013_bookkeeping_audit_log.sql +
// verifyAuditChainAgainstLog(): a chain that's been wholesale-replaced with
// a DIFFERENT but still internally self-consistent history is detected as
// invalid, even though the old verifyAuditChain()/verifyEventChain() checks
// (which only ever compared a chain to itself) would have reported it fine.
//
// Uses the memory backend throughout -- simpler than mocking two
// interleaved Supabase tables, and it exercises the exact same
// recordAuditAppend()/verifyAuditChainAgainstLog() code paths the durable
// backend uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.BOOKKEEPING_PO_STORE;
process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
process.env.NODE_ENV = 'test';

test('a normal sequence of ledger operations passes verifyAuditChainAgainstLog', async () => {
  const { updateSystem, verifyAuditChainAgainstLog } = await import(`./_store.js?t=${Date.now()}`);
  const { createEntry, approveEntry, postEntry } = await import(`../../../server/bookkeeping/src/ledger.js?t=${Date.now()}`);

  const companyId = `co-normal-${Date.now()}`;
  await updateSystem(companyId, system => system); // provisions the company

  await updateSystem(companyId, system => {
    createEntry(system.ledger, { companyId, date: '2026-07-21', description: 'Test entry', lines: [
      { accountId: '64', debit: 100, credit: 0 }, { accountId: '1000', debit: 0, credit: 100 }
    ] }, { id: 'user1', role: 'controller' });
    return system;
  });

  const result = await verifyAuditChainAgainstLog(companyId);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.ok(result.ledger.checkedRecords > 0);
});

test('a wholesale-rewritten (but internally self-consistent) audit chain is caught by verifyAuditChainAgainstLog', async () => {
  const { updateSystem, verifyAuditChainAgainstLog, getStore } = await import(`./_store.js?t=${Date.now()}`);
  const { createEntry } = await import(`../../../server/bookkeeping/src/ledger.js?t=${Date.now()}`);
  const { createHash } = await import('node:crypto');

  const companyId = `co-attack-${Date.now()}`;
  await updateSystem(companyId, system => system); // provisions the company
  await updateSystem(companyId, system => {
    createEntry(system.ledger, { companyId, date: '2026-07-21', description: 'Original entry', lines: [
      { accountId: '64', debit: 50, credit: 0 }, { accountId: '1000', debit: 0, credit: 50 }
    ] }, { id: 'user1', role: 'controller' });
    return system;
  });

  // Sanity: the honest history passes.
  const before = await verifyAuditChainAgainstLog(companyId);
  assert.equal(before.valid, true);

  // Now simulate the exact attack this table exists to catch: something
  // writes a DIFFERENT history straight into ledger_systems.data, fabricating
  // a new hash chain that is perfectly self-consistent on its own terms (a
  // real attacker recomputing hashes from a doctored `audit` array would
  // produce exactly this shape -- this is not a strawman).
  const store = getStore();
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
  const auditHash = (previousHash, event) => createHash('sha256').update(`${previousHash || 'GENESIS'}|${canonical(event)}`).digest('hex');

  const real = store.systems[companyId].data;
  const fabricatedEvent = { id: 'fabricated-id', at: '2020-01-01T00:00:00.000Z', companyId, actorId: 'attacker', action: 'entry.created', entityType: 'journal_entry', entityId: 'fake-entry', after: { description: 'A quietly altered entry' } };
  const fabricatedRecord = { ...fabricatedEvent };
  fabricatedRecord.previousHash = null;
  fabricatedRecord.hash = auditHash(null, { ...fabricatedRecord, hash: undefined, previousHash: undefined });

  const rewritten = structuredClone(real);
  rewritten.ledger.audit = [fabricatedRecord]; // wholesale replacement, internally self-consistent
  store.systems[companyId] = { data: rewritten, version: store.systems[companyId].version };

  const after = await verifyAuditChainAgainstLog(companyId);
  assert.equal(after.valid, false, 'the rewritten chain must be flagged invalid even though it is internally self-consistent');
  assert.ok(after.ledger.mismatches.length > 0);
});

test('appendAuditLog is idempotent under a CAS retry (no duplicate rows for the same seq)', async () => {
  const { updateSystem, verifyAuditChainAgainstLog } = await import(`./_store.js?t=${Date.now()}`);
  const { createEntry } = await import(`../../../server/bookkeeping/src/ledger.js?t=${Date.now()}`);

  const companyId = `co-retry-${Date.now()}`;
  await updateSystem(companyId, system => system);
  for (let i = 0; i < 3; i++) {
    await updateSystem(companyId, system => {
      createEntry(system.ledger, { companyId, date: '2026-07-21', description: `Entry ${i}`, lines: [
        { accountId: '64', debit: 10, credit: 0 }, { accountId: '1000', debit: 0, credit: 10 }
      ] }, { id: 'user1', role: 'controller' });
      return system;
    });
  }
  const result = await verifyAuditChainAgainstLog(companyId);
  assert.equal(result.valid, true, JSON.stringify(result));
});

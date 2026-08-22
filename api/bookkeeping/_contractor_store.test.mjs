// api/bookkeeping/_contractor_store.test.mjs
// Exercises the memory backend of the new (task 7) contractor 1099/W-9
// tracking store: creation, partial updates by normalized vendor key,
// vendor-name normalization (so "Ace  Electric" and "ace electric" are the
// same tracked contractor), tax-id truncation, and per-company isolation.
//
// Run: BOOKKEEPING_ALLOW_MEMORY_STORE=true NODE_ENV=test node --test api/bookkeeping/_contractor_store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';

test('saveContractorProfile creates a new profile with real defaults', async () => {
  const { saveContractorProfile } = await import(`./_contractor_store.js?t=${Date.now()}`);
  const { profile, created } = await saveContractorProfile('co-ct-1', { vendorName: 'Ace Electric LLC', track1099: true, w9OnFile: true, taxIdLast4: '1234' });
  assert.equal(created, true);
  assert.equal(profile.vendorName, 'Ace Electric LLC');
  assert.equal(profile.track1099, true);
  assert.equal(profile.w9OnFile, true);
  assert.equal(profile.taxIdLast4, '1234');
  assert.ok(profile.id);
  assert.ok(profile.vendorKey);
});

test('saveContractorProfile updates the SAME profile for a differently-cased/spaced vendor name (normalization)', async () => {
  const { saveContractorProfile, listContractorProfiles } = await import(`./_contractor_store.js?t=${Date.now()}`);
  await saveContractorProfile('co-ct-2', { vendorName: 'Ace  Electric LLC', track1099: true });
  const { created } = await saveContractorProfile('co-ct-2', { vendorName: 'ace electric llc', w9OnFile: true });
  assert.equal(created, false, 'a normalized-equal vendor name must update the same tracked profile, not create a second one');
  const profiles = await listContractorProfiles('co-ct-2');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].track1099, true, 'a partial update must not clear a field the request omitted');
  assert.equal(profiles[0].w9OnFile, true);
});

test('a long tax id is truncated to its real last 4 digits, never stored in full', async () => {
  const { saveContractorProfile } = await import(`./_contractor_store.js?t=${Date.now()}`);
  const { profile } = await saveContractorProfile('co-ct-3', { vendorName: 'Suarino Roofing', taxIdLast4: '12-3456789' });
  assert.equal(profile.taxIdLast4, '6789');
});

test('vendorName is required', async () => {
  const { saveContractorProfile } = await import(`./_contractor_store.js?t=${Date.now()}`);
  await assert.rejects(() => saveContractorProfile('co-ct-4', { track1099: true }));
});

test('a company\'s tracked contractors are never visible through another company\'s id (tenant isolation)', async () => {
  const { saveContractorProfile, listContractorProfiles } = await import(`./_contractor_store.js?t=${Date.now()}`);
  await saveContractorProfile('co-ct-5a', { vendorName: 'Rings End', track1099: true });
  const otherCompany = await listContractorProfiles('co-ct-5b');
  assert.equal(otherCompany.length, 0);
});

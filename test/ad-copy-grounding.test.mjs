import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realDivisionJobFacts, realServiceTerritoryFacts, KNOWN_DIVISIONS } from '../api/_lib/ad-copy-grounding.js';

// Same dependency-injection pattern as ad-budget-governor.test.mjs -- real
// code runs end to end, only supabaseRequest (the I/O boundary) is faked.

function fakeSupabase(responses) {
  let call = 0;
  return async (path) => {
    const entry = responses[call];
    call += 1;
    if (!entry) throw new Error('fakeSupabase: no response queued for call ' + call + ' (path: ' + path + ')');
    if (entry.notFound) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'relation "x" does not exist' };
    }
    return {
      ok: entry.ok !== false,
      json: async () => entry.rows,
      text: async () => JSON.stringify(entry.rows),
    };
  };
}

test('KNOWN_DIVISIONS: the real 6-division vocabulary the job-title classifier can produce', () => {
  assert.deepEqual(KNOWN_DIVISIONS, ['HVAC', 'Electric', 'Plumbing', 'Design|Build', 'Outdoor Spaces', 'Handyman']);
});

test('realDivisionJobFacts: counts only jobs whose title real-classifies into the requested division', async () => {
  const supa = fakeSupabase([{ rows: [
    { title: 'Furnace replacement', total: 8000, completed_at: new Date().toISOString() },
    { title: 'Water heater repair', total: 500, completed_at: new Date().toISOString() },
    { title: 'Mini split install', total: 6000, completed_at: '2020-01-01T00:00:00.000Z' },
  ] }]);
  const facts = await realDivisionJobFacts('HVAC', supa);
  assert.equal(facts.completedJobCount, 2);
  assert.equal(facts.completedJobCountLast180Days, 1);
  assert.equal(facts.avgJobValueCents, 700000);
});

test('realDivisionJobFacts: honestly zero/null when a division has no matching completed jobs, never guessed', async () => {
  const supa = fakeSupabase([{ rows: [{ title: 'Water heater repair', total: 500, completed_at: new Date().toISOString() }] }]);
  const facts = await realDivisionJobFacts('HVAC', supa);
  assert.equal(facts.completedJobCount, 0);
  assert.equal(facts.avgJobValueCents, null);
});

test('realDivisionJobFacts: an unsynced jobs table degrades honestly to zeros instead of throwing', async () => {
  const supa = fakeSupabase([{ notFound: true }]);
  const facts = await realDivisionJobFacts('HVAC', supa);
  assert.deepEqual(facts, { completedJobCount: 0, completedJobCountLast180Days: 0, avgJobValueCents: null });
});

test('realServiceTerritoryFacts: honestly reports no office set when office_location has no row yet', async () => {
  const supa = fakeSupabase([{ rows: [] }, { rows: [] }]);
  const facts = await realServiceTerritoryFacts(supa);
  assert.deepEqual(facts, { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false });
});

test('realServiceTerritoryFacts: computes a real average distance from real geocoded client locations', async () => {
  const supa = fakeSupabase([
    { rows: [{ lat: 40.0, lng: -75.0 }] },
    { rows: [{ lat: 40.0, lng: -75.0 }, { lat: 40.1, lng: -75.0 }] },
  ]);
  const facts = await realServiceTerritoryFacts(supa);
  assert.equal(facts.officeSet, true);
  assert.equal(facts.geocodedCustomerCount, 2);
  assert.ok(facts.maxDistanceMiles > 0);
  assert.ok(facts.avgDistanceMiles > 0 && facts.avgDistanceMiles <= facts.maxDistanceMiles);
});

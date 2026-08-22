import test from 'node:test';
import assert from 'node:assert/strict';
import { claimEnrollmentCode, isEnrollmentCodeUsable } from '../api/agents/enrollment.js';

test('single-use enrollment claim requires an atomic returned row', async () => {
  const claimed = await claimEnrollmentCode(
    { id: '44444444-4444-4444-4444-444444444444' },
    async (path, options) => {
      assert.match(path, /used_at=is\.null/);
      assert.equal(options.method, 'PATCH');
      assert.equal(options.headers.Prefer, 'return=representation');
      return { ok: true, json: async () => [] };
    }
  );
  assert.equal(claimed, null);
});

test('single-use enrollment claim succeeds only for the winning consumer', async () => {
  const row = { id: '44444444-4444-4444-4444-444444444444', used_at: new Date().toISOString() };
  const claimed = await claimEnrollmentCode(row, async () => ({
    ok: true,
    json: async () => [row],
  }));
  assert.equal(claimed.id, row.id);
});

test('enrollment expiry is validated after the hashed unused code is loaded', () => {
  const now = new Date('2026-07-29T22:30:00.000Z');
  assert.equal(isEnrollmentCodeUsable({
    used_at: null,
    expires_at: '2026-07-29T22:40:00.000Z',
  }, now), true);
  assert.equal(isEnrollmentCodeUsable({
    used_at: null,
    expires_at: '2026-07-29T22:20:00.000Z',
  }, now), false);
  assert.equal(isEnrollmentCodeUsable({
    used_at: '2026-07-29T22:25:00.000Z',
    expires_at: '2026-07-29T22:40:00.000Z',
  }, now), false);
});

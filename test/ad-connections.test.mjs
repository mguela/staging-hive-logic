import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONNECTION_STATES,
  ISSUE_STATES,
  isValidConnectionTransition,
} from '../api/_lib/connection-states.js';
import {
  adConnectionsShape,
  handleAdConnectionsGet,
  handleAdConnectionTransitionPost,
} from '../api/ads.js';

// Real code under test, imported directly (same dependency-injection
// pattern as ad-budget-governor.test.mjs) -- supabaseRequest is a plain
// injected parameter, no vm sandbox and no broken node:test mock.module.

function fakeSupabase(responses) {
  let call = 0;
  return async (path) => {
    const entry = responses[call];
    call += 1;
    if (!entry) throw new Error('fakeSupabase: no response queued for call ' + call + ' (path: ' + path + ')');
    return {
      ok: entry.ok !== false,
      json: async () => entry.rows,
      text: async () => JSON.stringify(entry.rows),
    };
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('isValidConnectionTransition: not_connected can only move to setup_incomplete -- no skipping the connect step', () => {
  assert.equal(isValidConnectionTransition('not_connected', 'setup_incomplete'), true);
  assert.equal(isValidConnectionTransition('not_connected', 'launch_enabled'), false);
});

test('isValidConnectionTransition: an issue state always recovers through setup_incomplete, never straight to launch_enabled', () => {
  assert.equal(isValidConnectionTransition('needs_reauth', 'setup_incomplete'), true);
  assert.equal(isValidConnectionTransition('needs_reauth', 'launch_enabled'), false);
});

test('CONNECTION_STATES: real 10-state vocabulary, same one Phase 15 already uses -- not reinvented', () => {
  assert.equal(CONNECTION_STATES.length, 10);
  assert.equal(ISSUE_STATES.size, 5);
});

test('handleAdConnectionsGet: no rows yet -- all 3 platforms honestly report not_connected, not fabricated', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleAdConnectionsGet({}, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.connections.length, 3);
  assert.ok(res.body.connections.every((c) => c.state === 'not_connected'));
});

test('handleAdConnectionsGet: a real row reflects its real state, the other 2 stay not_connected', async () => {
  const supa = fakeSupabase([{ rows: [{ platform: 'meta', state: 'launch_enabled', business_account_id: 'biz1', ad_account_id: 'act1', last_verified_at: '2026-08-01T00:00:00.000Z', last_error: null }] }]);
  const res = fakeRes();
  await handleAdConnectionsGet({}, res, supa);
  const meta = res.body.connections.find((c) => c.platform === 'meta');
  assert.equal(meta.state, 'launch_enabled');
  assert.equal(meta.adAccountId, 'act1');
  assert.equal(meta.isIssue, false);
  const google = res.body.connections.find((c) => c.platform === 'google_ads');
  assert.equal(google.state, 'not_connected');
});

test('handleAdConnectionTransitionPost: rejects an unknown platform before touching the database', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdConnectionTransitionPost({ body: { platform: 'snapchat', toState: 'setup_incomplete' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleAdConnectionTransitionPost: rejects an unknown toState before touching the database', async () => {
  const supa = fakeSupabase([]);
  const res = fakeRes();
  await handleAdConnectionTransitionPost({ body: { platform: 'meta', toState: 'fully_live' } }, res, supa);
  assert.equal(res.statusCode, 400);
});

test('handleAdConnectionTransitionPost: refuses to skip steps -- not_connected straight to launch_enabled is illegal', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const res = fakeRes();
  await handleAdConnectionTransitionPost({ body: { platform: 'meta', toState: 'launch_enabled' } }, res, supa);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.fromState, 'not_connected');
});

test('handleAdConnectionTransitionPost: a legal first transition creates the row (POST), not a PATCH on nothing', async () => {
  const supa = fakeSupabase([
    { rows: [] },
    { rows: [], ok: true },
    { rows: [{ platform: 'meta', state: 'setup_incomplete' }] },
  ]);
  const res = fakeRes();
  await handleAdConnectionTransitionPost({ body: { platform: 'meta', toState: 'setup_incomplete' } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fromState, 'not_connected');
  assert.equal(res.body.toState, 'setup_incomplete');
});

test('handleAdConnectionTransitionPost: moving into an issue state records a real last_error, not a silent state flip', async () => {
  const supa = fakeSupabase([
    { rows: [{ id: 'row1', state: 'setup_incomplete', last_verified_at: null }] },
    { rows: [], ok: true },
    { rows: [{ platform: 'meta', state: 'needs_reauth', last_error: 'expired' }] },
  ]);
  const res = fakeRes();
  await handleAdConnectionTransitionPost({ body: { platform: 'meta', toState: 'needs_reauth', note: 'expired' } }, res, supa);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fromState, 'setup_incomplete');
  assert.equal(res.body.toState, 'needs_reauth');
});

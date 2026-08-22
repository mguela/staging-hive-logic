// test/bookkeeping-actor-superadmin-role.test.mjs
// 2026-08-14 (jomell): "superadmin, and admin can record a change order
// rejection" -- turned out neither jomell nor Chris actually could anymore.
// Root cause: api/bookkeeping/purchase-orders/_actor.js's mapRole() only
// mapped profiles.role 'admin' to the engine's 'controller' tier; anything
// else (including 'superadmin') fell through to 'field' (request-only).
// sql/065_superadmin_role.sql promoted jomell + Chris from 'admin' to
// 'superadmin' with the explicit stated intent that every place checking
// role === 'admin' would be widened to also accept 'superadmin' -- this
// file was the one place that widening never reached, silently downgrading
// both of them to request-only across the ENTIRE Accounting Controls module
// (purchase orders, change orders, estimates, ledger -- ~40 endpoints all
// import this same actor resolver).
//
// This exercises the real change-orders/reject.js handler end-to-end (not
// a stand-in for the role check) with only the auth-lookup network calls
// and the change-order store mocked.
// Run with: node --experimental-test-module-mocks --test test/bookkeeping-actor-superadmin-role.test.mjs

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ENABLED = 'true';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let profileRole = 'superadmin';

const originalFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/auth/v1/user')) {
    return { ok: true, json: async () => ({ id: 'actor-1', email: 'jomell@ghgrp.net' }) };
  }
  return { ok: false, json: async () => ({}) };
};

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      if (String(path).startsWith('profiles')) {
        return { ok: true, json: async () => ([{ id: 'actor-1', email: 'jomell@ghgrp.net', full_name: 'Jomell Alba', role: profileRole }]) };
      }
      return { ok: true, json: async () => ([]) };
    },
  },
});

let sentChangeOrder;
mock.module('../api/bookkeeping/change-orders/_store.js', {
  namedExports: {
    getChangeOrder: async () => sentChangeOrder,
    updateChangeOrder: async (companyId, id, mutate) => { sentChangeOrder = mutate(sentChangeOrder); return sentChangeOrder; },
  },
});

const { default: handler } = await import('../api/bookkeeping/change-orders/reject.js');

function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function req(body) {
  return { method: 'POST', headers: { authorization: 'Bearer usertoken' }, body };
}
function freshSentCO() {
  return { id: 'co-1', companyId: 'greenwich-handyman', lifecycleStatus: 'sent', history: [] };
}

test('a superadmin (jomell/Chris, post sql/065 promotion) can record a rejection', async () => {
  profileRole = 'superadmin';
  sentChangeOrder = freshSentCO();
  const r = res();
  await handler(req({ id: 'co-1', reason: 'Client declined the upcharge.' }), r);
  assert.equal(r.statusCode, 200, 'expected the rejection to succeed: ' + JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
});

test('an admin can still record a rejection (unchanged by the fix)', async () => {
  profileRole = 'admin';
  sentChangeOrder = freshSentCO();
  const r = res();
  await handler(req({ id: 'co-1', reason: 'Scope no longer needed.' }), r);
  assert.equal(r.statusCode, 200, 'expected the rejection to succeed: ' + JSON.stringify(r.body));
});

test('a crew account is still correctly blocked (the fix did not over-widen)', async () => {
  profileRole = 'crew';
  sentChangeOrder = freshSentCO();
  const r = res();
  await handler(req({ id: 'co-1', reason: 'n/a' }), r);
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /controller\/admin/);
});

test.after(() => { global.fetch = originalFetch; });

// test/lead-address-backfill.test.mjs
// jomell, 2026-08-27: an address entered on the New Lead form only ever
// landed on lead_pipeline.service_address -- a completely different table
// from client_locations, which every other address-reading surface
// (invoice PDF, estimate builder, Estimates list, Active Jobs) actually
// reads. So an address typed in here never showed up anywhere else.
//
// This exercises the real POST /api/track1?resource=leads handler's new
// best-effort client_locations backfill: insert-only, and only when the
// client has no location row yet, so a real structured address already on
// file (Jobber sync, or the client card) is never overwritten.
//
// Run with: node --experimental-test-module-mocks --test test/lead-address-backfill.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let calls = [];
let existingLocationRows = [];
let locationWritesFail = false;

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (p, opts = {}) => {
      const method = opts.method || 'GET';
      const path_ = String(p);
      calls.push({ method, path: path_, body: opts.body ? JSON.parse(opts.body) : null });
      if (path_.startsWith('lead_pipeline') && method === 'POST') {
        return { ok: true, json: async () => [{ id: 'pipe-1', client_id: JSON.parse(opts.body).client_id }] };
      }
      if (path_.startsWith('client_locations')) {
        if (locationWritesFail) throw new Error('supabase is down');
        if (method === 'GET') return { ok: true, json: async () => existingLocationRows };
        return { ok: true, json: async () => [JSON.parse(opts.body)] };
      }
      return { ok: true, json: async () => [], text: async () => '' };
    },
    jobberGraphQL: async () => ({}),
  },
});

global.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) {
    return { ok: true, json: async () => ({ id: 'user-1', email: 'chris@ghgrp.net' }) };
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  calls = [];
  existingLocationRows = [];
  locationWritesFail = false;
}

test('a new lead with an address, for a client with no location on file, backfills client_locations', async () => {
  reset();
  const r = res();
  await trackMod.default({
    method: 'POST', query: { resource: 'leads' }, headers: { authorization: 'Bearer t' },
    body: { clientId: 'C1', firstName: 'Jomell', serviceAddress: '123 Beaver Dam Road, Town of Bedford, New York, 10507' },
  }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const insert = calls.find((c) => c.path.startsWith('client_locations') && c.method === 'POST');
  assert.ok(insert, 'must insert a client_locations row');
  assert.equal(insert.body.jobber_id, 'C1');
  assert.equal(insert.body.street, '123 Beaver Dam Road, Town of Bedford, New York, 10507');
});

test('a client that already has a location on file is never overwritten', async () => {
  reset();
  existingLocationRows = [{ jobber_id: 'C1' }];
  const r = res();
  await trackMod.default({
    method: 'POST', query: { resource: 'leads' }, headers: { authorization: 'Bearer t' },
    body: { clientId: 'C1', firstName: 'Jomell', serviceAddress: '456 Other St' },
  }, r);
  assert.equal(r.statusCode, 200);
  const insert = calls.find((c) => c.path.startsWith('client_locations') && c.method === 'POST');
  assert.equal(insert, undefined, 'must not insert -- a real address is already on file');
});

test('no address on the lead means no client_locations write at all', async () => {
  reset();
  const r = res();
  await trackMod.default({
    method: 'POST', query: { resource: 'leads' }, headers: { authorization: 'Bearer t' },
    body: { clientId: 'C1', firstName: 'Jomell' },
  }, r);
  assert.equal(r.statusCode, 200);
  const locationCalls = calls.filter((c) => c.path.startsWith('client_locations'));
  assert.equal(locationCalls.length, 0);
});

test('a failed client_locations write does not fail the lead save itself', async () => {
  reset();
  locationWritesFail = true;
  const r = res();
  await trackMod.default({
    method: 'POST', query: { resource: 'leads' }, headers: { authorization: 'Bearer t' },
    body: { clientId: 'C1', firstName: 'Jomell', serviceAddress: '123 Beaver Dam Road' },
  }, r);
  assert.equal(r.statusCode, 200, 'the lead itself must still save');
  assert.equal(r.body.ok, true);
});

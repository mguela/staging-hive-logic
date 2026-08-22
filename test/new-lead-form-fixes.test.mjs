// test/new-lead-form-fixes.test.mjs
// New Lead form (2026-08-18) — three things Chris hit trying to log a real lead.
//
// 1. The lead "didn't show up on the pipeline". It had saved fine, twice. The
//    card's headline is the lead's TITLE falling back to the client's name, and
//    this form never sent a title -- so both leads rendered as "Alan Johnson"
//    and were indistinguishable from each other and from any existing card for
//    him. That defeats the whole point of the opportunity model, which exists
//    so one customer can hold several tellable-apart leads.
//
// 2. Picking an existing client didn't fill the address, and the form claimed
//    none was available. 6,407 of 8,689 clients have a street address sitting
//    in client_locations -- it just wasn't exposed anywhere the form could
//    reach it.
//
// 3. Phone stays unfilled, and that part of the warning was right: the column
//    exists but the Jobber sync populates it for 0 of 8,689 clients. Tested so
//    nobody later "fixes" it into a field that is always blank.
//
// Run with: node --experimental-test-module-mocks --test test/new-lead-form-fixes.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let locationRows = [];

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (p) => {
      if (String(p).startsWith('client_locations')) return { ok: true, json: async () => locationRows };
      if (String(p).startsWith('profiles')) return { ok: true, json: async () => [{ id: 'u1', email: 'chris@ghgrp.net', role: 'admin' }] };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});
mock.module('../api/_lib/guard.js', {
  namedExports: { requireApiAuth: async () => ({ ok: true, via: 'session' }), checkCronSecret: () => false },
});

globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'u1' }) });

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function lookup(clientId) {
  const r = res();
  await trackMod.default(
    { method: 'GET', query: { resource: 'client_location', clientId }, headers: { authorization: 'Bearer t' } },
    r,
  );
  return r;
}

// ------------------------------------------------- the address lookup

test('an existing client\'s address comes back ready to drop in the field', async () => {
  locationRows = [{ street: '238 Weaver Street', city: 'Greenwich', province: 'CT', postal_code: '06831' }];
  const r = await lookup('Z2lkOi8vSm9iYmVy');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.found, true);
  assert.equal(r.body.address, '238 Weaver Street, Greenwich, CT 06831');
});

test('a client with no address says so plainly rather than half-filling', async () => {
  // 2,282 of 8,689 clients have no street. A partial "Greenwich, CT" in a
  // service-address field is worse than an empty one.
  locationRows = [{ street: null, city: 'Greenwich', province: 'CT', postal_code: '06831' }];
  const r = await lookup('Z2lkOi8vSm9iYmVy');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.found, false);
  assert.equal(r.body.address, null);
});

test('no location row at all is not an error', async () => {
  locationRows = [];
  const r = await lookup('Z2lkOi8vSm9iYmVy');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.found, false);
});

test('a partial address is assembled from whatever parts exist', async () => {
  locationRows = [{ street: '12 Elm St', city: null, province: null, postal_code: null }];
  const r = await lookup('x');
  assert.equal(r.body.address, '12 Elm St', 'no stray commas from missing parts');
});

test('the lookup needs a client', async () => {
  const r = res();
  await trackMod.default({ method: 'GET', query: { resource: 'client_location' }, headers: { authorization: 'Bearer t' } }, r);
  assert.equal(r.statusCode, 400);
});

// ------------------------------------------------- the form's own wiring

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const saveLead = source.slice(source.indexOf('function saveLead()'), source.indexOf('function saveLead()') + 2200);

test('saveLead sends a title, so the card is identifiable', () => {
  // Without this every hand-entered lead is headlined with the customer's name
  // and two leads for one customer look identical.
  assert.match(saveLead, /title:/, 'saveLead must send a title');
  assert.match(saveLead, /var title = need\.trim\(\)/, 'the title comes from what they asked for');
});

test('the client-pick note no longer claims the address is unavailable', () => {
  const pick = source.slice(source.indexOf('function nlClientPick'), source.indexOf('function nlUnlinkClient'));
  assert.doesNotMatch(pick, /phone and address aren&#8217;t synced/,
    'that claim was wrong for address on 6,407 of 8,689 clients');
  assert.match(pick, /client_location&clientId=/, 'it must look the address up');
  assert.match(pick, /!addrEl\.value\.trim\(\)/, 'never overwrite what the user already typed');
  // The phone half was accurate and must survive.
  assert.match(pick, /[Pp]hone isn&#8217;t part of the Jobber sync/);
});

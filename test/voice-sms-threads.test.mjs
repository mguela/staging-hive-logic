// test/voice-sms-threads.test.mjs
// jomell, 2026-08-29: the Comms Hub's Client Threads list needs one real
// conversation per human, not per message row -- these are the two new
// GET resources (api/voice.js: sms_threads, sms_thread) that make that
// real. Pins needsReply as a computed fact (last message came from the
// client), not a stored flag, and pins client-name resolution using the
// same two-step lookup (clients.phone_e164, then voice_known_numbers)
// handleCallsGet already uses for calls.
//
// Run with: node --experimental-test-module-mocks --test test/voice-sms-threads.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let messagesRows = [];
let clientsRows = [];
let knownRows = [];

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      const p = String(path);
      if (p.startsWith('voice_messages?')) return { ok: true, json: async () => messagesRows };
      if (p.startsWith('clients?')) return { ok: true, json: async () => clientsRows };
      if (p.startsWith('voice_known_numbers')) return { ok: true, json: async () => knownRows };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

globalThis.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
  return { ok: true, json: async () => ({}) };
};

const handler = (await import('../api/voice.js')).default;

function res() {
  const out = { statusCode: null, body: null };
  return { out, status(c) { out.statusCode = c; return this; }, json(b) { out.body = b; return this; } };
}

async function call(resource, query = {}) {
  const req = { method: 'GET', query: { resource, ...query }, headers: { authorization: 'Bearer t' } };
  const r = res();
  await handler(req, r);
  return r.out;
}

function reset() {
  messagesRows = [];
  clientsRows = [];
  knownRows = [];
}

// ---------------------------------------------------------------------------

test('sms_threads groups messages into one row per real conversation', async () => {
  reset();
  messagesRows = [
    { direction: 'inbound', from_number: '+12035551234', to_number: '+12035550000', body: 'Any concerns?', status: 'received', created_at: '2026-08-29T09:15:00Z' },
    { direction: 'outbound', from_number: '+12035550000', to_number: '+12035551234', body: 'Phase 2 started today.', status: 'delivered', created_at: '2026-08-29T08:30:00Z' },
    { direction: 'outbound', from_number: '+12035550000', to_number: '+12035555678', body: 'Handled, no reply needed.', status: 'sent', created_at: '2026-08-28T16:40:00Z' },
  ];

  const r = await call('sms_threads');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.threads.length, 2, 'three messages across two numbers must become two threads');

  const [first, second] = r.body.threads;
  assert.equal(first.number, '+12035551234', 'most recent activity sorts first');
  assert.equal(first.messageCount, 2);
  assert.equal(first.lastMessage.body, 'Any concerns?');
  assert.equal(first.needsReply, true, 'the last message in this thread came from the client');

  assert.equal(second.number, '+12035555678');
  assert.equal(second.needsReply, false, 'the last message in this thread went out from the office');
});

test('sms_threads resolves a client name from clients.phone_e164', async () => {
  reset();
  messagesRows = [{ direction: 'inbound', from_number: '+12035551234', to_number: '+12035550000', body: 'hi', status: 'received', created_at: '2026-08-29T09:15:00Z' }];
  clientsRows = [{ jobber_id: 'J1', name: 'John Peterson', phone_e164: '+12035551234' }];

  const r = await call('sms_threads');
  assert.equal(r.body.threads[0].clientId, 'J1');
  assert.equal(r.body.threads[0].clientName, 'John Peterson');
});

test('sms_threads falls back to voice_known_numbers when no client matches', async () => {
  reset();
  messagesRows = [{ direction: 'outbound', from_number: '+12035550000', to_number: '+12035555678', body: 'ok', status: 'sent', created_at: '2026-08-28T16:40:00Z' }];
  clientsRows = [];
  knownRows = [{ e164: '+12035555678', display_name: 'Dan (personal cell)', jobber_client_id: null }];

  const r = await call('sms_threads');
  assert.equal(r.body.threads[0].clientId, null);
  assert.equal(r.body.threads[0].clientName, 'Dan (personal cell)');
});

test('sms_threads with no messages at all is an empty list, not an error', async () => {
  reset();
  const r = await call('sms_threads');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.threads, []);
});

test('sms_thread requires a number', async () => {
  reset();
  const r = await call('sms_thread');
  assert.equal(r.statusCode, 400);
});

test('sms_thread returns the full history, oldest first, with real client identity', async () => {
  reset();
  messagesRows = [
    { id: 'm2', direction: 'outbound', from_number: '+12035550000', to_number: '+12035551234', body: 'Phase 2 started today.', status: 'delivered', origin: null, created_at: '2026-08-29T08:30:00Z' },
    { id: 'm1', direction: 'inbound', from_number: '+12035551234', to_number: '+12035550000', body: 'Any concerns?', status: 'received', origin: null, created_at: '2026-08-29T09:15:00Z' },
    { id: 'm3', direction: 'outbound', from_number: '+12035550000', to_number: '+12035551234', body: 'None so far!', status: 'sent', origin: 'reina_approved', created_at: '2026-08-29T09:20:00Z' },
  ];
  clientsRows = [{ jobber_id: 'J1', name: 'John Peterson', phone_e164: '+12035551234' }];

  const r = await call('sms_thread', { number: '2035551234' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.clientName, 'John Peterson');
  assert.equal(r.body.messages.length, 3);
  assert.equal(r.body.messages[r.body.messages.length - 1].origin, 'reina_approved');
});

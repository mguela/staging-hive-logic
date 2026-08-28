// test/voice-webhook-sms-inbound.test.mjs
// jomell, 2026-08-29: the Comms Hub's Client Threads need real inbound texts
// -- until now api/voice.js's handleSms could only send, and its own comment
// said so ("No inbound SMS handling yet"). This is that missing webhook.
//
// Only api/_lib/jobber.js is mocked -- everything else voice-webhook.js
// imports (_lib/voice.js's TwiML/xmlResponse/verifyTwilioSignature,
// _lib/call-intelligence.js, _lib/company-hours.js) is pure or
// env-var-gated and safe to run for real; mocking it would just be
// reimplementing it in the test.
//
// Run with: node --experimental-test-module-mocks --test test/voice-webhook-sms-inbound.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';

let clientRows = [];
let blockedRows = [];
const inserted = { voice_messages: [], voice_call_events: [] };

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts = {}) => {
      const p = String(path);
      if (opts.method === 'POST' && p.startsWith('voice_messages')) {
        const row = JSON.parse(opts.body);
        inserted.voice_messages.push(row);
        return { ok: true, json: async () => [row] };
      }
      if (opts.method === 'POST' && p.startsWith('voice_call_events')) {
        const row = JSON.parse(opts.body);
        inserted.voice_call_events.push(row);
        return { ok: true, json: async () => [row] };
      }
      if (p.startsWith('voice_blocked_numbers')) return { ok: true, json: async () => blockedRows };
      if (p.startsWith('clients?')) return { ok: true, json: async () => clientRows };
      if (p.startsWith('jobs?')) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

const handler = (await import('../api/voice-webhook.js')).default;

const URL_STR = 'https://hivelogic.test/api/voice-webhook?resource=sms-inbound';

function signatureFor(url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function res() {
  const out = { statusCode: null, headers: {}, sent: null };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.statusCode = c; return this; },
    send(body) { out.sent = body; return this; },
    json(body) { out.sent = body; return this; },
  };
}

function inboundReq(body) {
  return {
    method: 'POST',
    url: '/api/voice-webhook?resource=sms-inbound',
    query: { resource: 'sms-inbound' },
    headers: { host: 'hivelogic.test', 'x-twilio-signature': signatureFor(URL_STR, body) },
    body,
  };
}

function reset() {
  clientRows = [];
  blockedRows = [];
  inserted.voice_messages = [];
  inserted.voice_call_events = [];
}

// ---------------------------------------------------------------------------

test('an unsigned request is refused, same as every other Twilio webhook here', async () => {
  reset();
  const body = { From: '+12035551234', To: '+12035550000', Body: 'Hi', MessageSid: 'SM1' };
  const r = res();
  await handler({ method: 'POST', url: '/api/voice-webhook?resource=sms-inbound', query: { resource: 'sms-inbound' }, headers: { host: 'hivelogic.test' }, body }, r);
  assert.equal(r.out.statusCode, 403);
  assert.equal(inserted.voice_messages.length, 0);
});

test('a real inbound text is logged, matched to its client, and gets an empty TwiML reply', async () => {
  reset();
  clientRows = [{ jobber_id: 'J1' }];
  const body = { From: '+12035551234', To: '+12035550000', Body: 'Any concerns so far?', MessageSid: 'SM1' };
  const r = res();
  await handler(inboundReq(body), r);

  assert.equal(r.out.statusCode, 200);
  assert.match(r.out.headers['Content-Type'], /text\/xml/);
  assert.equal(r.out.sent, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  assert.equal(inserted.voice_messages.length, 1);
  const row = inserted.voice_messages[0];
  assert.equal(row.direction, 'inbound');
  assert.equal(row.from_number, '+12035551234');
  assert.equal(row.to_number, '+12035550000');
  assert.equal(row.body, 'Any concerns so far?');
  assert.equal(row.provider_sid, 'SM1');
  assert.equal(row.client_id, 'J1');
});

test('a text from a number with no matching client is still logged, honestly unattributed', async () => {
  reset();
  clientRows = [];
  const body = { From: '+12035559999', To: '+12035550000', Body: 'Do you do gutters?', MessageSid: 'SM2' };
  const r = res();
  await handler(inboundReq(body), r);

  assert.equal(inserted.voice_messages.length, 1);
  assert.equal(inserted.voice_messages[0].client_id, null);
});

test('a blocked number is never logged as a message', async () => {
  // logEvent no-ops without a call id (the same is true for a blocked voice
  // call in handleInbound above) -- the property this test actually pins is
  // that a blocked sender's text never reaches voice_messages.
  reset();
  blockedRows = [{ id: 'b1' }];
  const body = { From: '+12035550001', To: '+12035550000', Body: 'spam', MessageSid: 'SM3' };
  const r = res();
  await handler(inboundReq(body), r);

  assert.equal(r.out.statusCode, 200);
  assert.equal(inserted.voice_messages.length, 0);
});

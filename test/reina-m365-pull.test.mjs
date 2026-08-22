// Reina M1a v0.2 — M365 Graph pull. Unit-tests the pull module (query build,
// HTML->text, message selection, error mapping) with injected token+fetch, and
// the observe core's m365_graph seam (pull is wired vs the 409 when it isn't).
// The live Graph/token call can't run here (needs a connected mailbox + MS
// secrets); every network hop is mocked.

import test from 'node:test';
import assert from 'node:assert';
import { htmlToText, buildMessagesUrl, pullClientMessageFromGraph, getAppGraphToken, buildMailboxInboxUrl, listSharedInboxMessages } from '../api/reina/_m365-pull.js';
import { reinaObserveChangeRequest } from '../api/reina/observe-change-request.js';

const JOB_ID = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDYxMzkzMTY=';
const CLIENT_ID = 'Z2lkOi8vSm9iYmVyL0NsaWVudC8xMTg3Mzg5MTY=';

// --- pull module ----------------------------------------------------------
test('htmlToText strips markup, keeps line structure, unescapes entities', () => {
  const html = '<div>Hi team,</div><p>Can you add&nbsp;<b>2 lights</b> &amp; patch the ceiling?</p><script>x()</script><br>Thanks';
  const t = htmlToText(html);
  assert.match(t, /Hi team,/);
  assert.match(t, /2 lights & patch the ceiling\?/);
  assert.doesNotMatch(t, /<|>|x\(\)/);
  assert.match(t, /\nThanks$/);
});

test('buildMessagesUrl filters by sender, escapes quotes, orders newest first', () => {
  const url = buildMessagesUrl("o'brien@x.com");
  assert.match(url, /graph\.microsoft\.com\/v1\.0\/me\/messages/);
  assert.match(decodeURIComponent(url), /from\/emailAddress\/address eq 'o''brien@x\.com'/);
  assert.match(url, /orderby=receivedDateTime%20desc/);
  assert.match(url, /\$top=1/);
});

test('pull returns the newest message text + meta on success', async () => {
  const res = await pullClientMessageFromGraph(
    { clientEmail: 'atd@amxcooling.com', authHeader: 'Bearer u', host: 'app' },
    {
      getToken: async () => 'graph-token',
      fetchImpl: async (url, opts) => {
        assert.strictEqual(opts.headers.Authorization, 'Bearer graph-token');
        return { ok: true, json: async () => ({ value: [{ subject: 'Change to 2478', receivedDateTime: '2026-08-02T10:00:00Z', body: { contentType: 'html', content: '<p>Please add two lights</p>' } }] }) };
      },
    },
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.requestText, 'Please add two lights');
  assert.strictEqual(res.meta.subject, 'Change to 2478');
  assert.strictEqual(res.meta.from, 'atd@amxcooling.com');
});

test('pull maps the expected empty cases without throwing', async () => {
  const noEmail = await pullClientMessageFromGraph({ clientEmail: '' }, { getToken: async () => 't', fetchImpl: async () => ({}) });
  assert.strictEqual(noEmail.ok, false);

  const noMailbox = await pullClientMessageFromGraph({ clientEmail: 'a@b.c' }, { getToken: async () => null, fetchImpl: async () => ({}) });
  assert.strictEqual(noMailbox.ok, false);
  assert.strictEqual(noMailbox.status, 404);

  const noMsg = await pullClientMessageFromGraph({ clientEmail: 'a@b.c' }, { getToken: async () => 't', fetchImpl: async () => ({ ok: true, json: async () => ({ value: [] }) }) });
  assert.strictEqual(noMsg.ok, false);
  assert.strictEqual(noMsg.status, 404);
});

test('pull surfaces a 401 token failure as a reconnect message', async () => {
  const res = await pullClientMessageFromGraph(
    { clientEmail: 'a@b.c' },
    { getToken: async () => { const e = new Error('reauth'); e.status = 401; throw e; }, fetchImpl: async () => ({}) },
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /reconnect/i);
});

// --- app-level shared-inbox path (unattended) -----------------------------
test('getAppGraphToken uses the client-credentials grant and returns the token', async () => {
  let sentBody = null;
  const token = await getAppGraphToken({
    tenant: 'contoso.onmicrosoft.com', clientId: 'app-id', clientSecret: 'sekret',
    fetchImpl: async (url, opts) => { sentBody = opts.body; assert.match(url, /contoso\.onmicrosoft\.com\/oauth2\/v2\.0\/token/); return { ok: true, json: async () => ({ access_token: 'APP_TOKEN' }) }; },
  });
  assert.strictEqual(token, 'APP_TOKEN');
  assert.match(sentBody, /grant_type=client_credentials/);
  assert.match(sentBody, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
});

test('getAppGraphToken fails clearly without tenant/secret', async () => {
  await assert.rejects(() => getAppGraphToken({ fetchImpl: async () => ({}) }), /MS_TENANT.*MS_CLIENT_SECRET|required/);
});

test('buildMailboxInboxUrl targets /users/{mailbox}/messages', () => {
  const url = buildMailboxInboxUrl('info@ghgrp.net', '2026-08-01T00:00:00.000Z', { top: 25 });
  assert.match(url, /\/users\/info%40ghgrp\.net\/messages/);
  assert.match(decodeURIComponent(url), /receivedDateTime ge 2026-08-01T00:00:00\.000Z/);
  assert.match(url, /orderby=receivedDateTime%20desc/);
});

test('listSharedInboxMessages reads the shared mailbox with an app token', async () => {
  const out = await listSharedInboxMessages(
    { mailbox: 'info@ghgrp.net', sinceIso: '2026-08-01T00:00:00.000Z', top: 25 },
    {
      token: 'APP_TOKEN',
      fetchImpl: async (url, opts) => {
        assert.strictEqual(opts.headers.Authorization, 'Bearer APP_TOKEN');
        assert.match(url, /\/users\/info%40ghgrp\.net\/messages/);
        return { ok: true, json: async () => ({ value: [{ from: { emailAddress: { address: 'Client@Acme.com' } }, subject: 'Add scope', internetMessageId: '<x>', body: { contentType: 'text', content: 'please add two outlets' } }] }) };
      },
    },
  );
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.messages.length, 1);
  assert.strictEqual(out.messages[0].from, 'client@acme.com'); // lowercased
  assert.strictEqual(out.messages[0].text, 'please add two outlets');
});

test('listSharedInboxMessages refuses without a mailbox and surfaces token errors', async () => {
  const noMbx = await listSharedInboxMessages({ mailbox: '', sinceIso: 'x' }, { token: 't', fetchImpl: async () => ({}) });
  assert.strictEqual(noMbx.ok, false);
  assert.strictEqual(noMbx.status, 400);

  const tokErr = await listSharedInboxMessages({ mailbox: 'info@ghgrp.net', sinceIso: 'x' }, { getToken: undefined, tenant: undefined, fetchImpl: async () => ({}) });
  assert.strictEqual(tokErr.ok, false); // no tenant/secret -> app token throws -> mapped
});

// --- observe core seam ----------------------------------------------------
function res(ok, json) { return { ok, json: async () => json, text: async () => 'x' }; }
function makeSupabase(writes) {
  return async (path, options = {}) => {
    if (options.method && options.method !== 'GET') { writes.push({ path, options }); return res(true, [{ id: 'new', ...JSON.parse(options.body) }]); }
    if (path.startsWith('marketing_approvals?')) return res(true, []);
    if (path.startsWith('jobs?')) return res(true, [{ jobber_id: JOB_ID, title: 'CO 2478', client_id: CLIENT_ID }]);
    if (path.startsWith('clients?')) return res(true, [{ jobber_id: CLIENT_ID, name: 'Tony', email: 'atd@amxcooling.com', balance: 100 }]);
    if (path.startsWith('invoice_balances?')) return res(true, [{ computed_balance: 100 }]);
    if (path.startsWith('quotes?')) return res(true, []);
    if (path.startsWith('change_orders?')) return res(true, []);
    throw new Error('unexpected ' + path);
  };
}
const anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ title: 'T', summary: 'S', scope_delta: 'd', client_stated_amount_cents: null, confidence: 70, risks: [], gaps: [], cited_excerpt: 'add two lights' }) }] }) } };

test('m365_graph with no request_text pulls the message, then writes one row stamped with the source', async () => {
  const writes = [];
  let pulledFor = null;
  const out = await reinaObserveChangeRequest(
    { jobId: JOB_ID, requestText: '', requestSource: 'm365_graph' },
    {
      supabaseRequest: makeSupabase(writes), anthropic,
      pullClientMessage: async ({ clientEmail }) => { pulledFor = clientEmail; return { ok: true, requestText: 'Please add two lights', meta: { subject: 'CO', from: clientEmail } }; },
    },
  );
  assert.strictEqual(out.status, 201);
  assert.strictEqual(pulledFor, 'atd@amxcooling.com', 'pulls using the resolved client email');
  const row = JSON.parse(writes[0].options.body);
  assert.strictEqual(row.estimate.request_source, 'm365_graph');
  assert.strictEqual(row.estimate.m365.subject, 'CO');
});

test('m365_graph returns 409 when the pull is not wired/enabled', async () => {
  const writes = [];
  const out = await reinaObserveChangeRequest(
    { jobId: JOB_ID, requestText: '', requestSource: 'm365_graph' },
    { supabaseRequest: makeSupabase(writes), anthropic, pullClientMessage: null },
  );
  assert.strictEqual(out.status, 409);
  assert.strictEqual(writes.length, 0);
});

test('an unknown request_source is rejected', async () => {
  const out = await reinaObserveChangeRequest(
    { jobId: JOB_ID, requestText: 'x', requestSource: 'carrier_pigeon' },
    { supabaseRequest: makeSupabase([]), anthropic },
  );
  assert.strictEqual(out.status, 400);
});

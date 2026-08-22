// test/automation-runners.test.mjs
// The runners behind the Company Setup automation toggles.
//
// The tests that matter most here are the ones about NOT sending. Every one of
// these runners can reach a real customer, so the gates, the fail-closed
// defaults and the idempotency key get more attention than the happy path:
// a bug that queues nothing is an inconvenience, a bug that texts 200 clients
// twice is not recoverable.
// Run: node --experimental-test-module-mocks --test test/automation-runners.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const lib = await import('../api/_lib/automations.js');
const { automationConfig, masterSendEnabled, queueAutomationMessages, runAutomation, AUTOMATION_KEYS } = lib;

// --------------------------------------------------------------------------
// harness
// --------------------------------------------------------------------------
function res(status = 200, body = []) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function missingTable() {
  const b = { code: 'PGRST205', message: "Could not find the table 'public.automation_runs' in the schema cache" };
  return { ok: false, status: 404, json: async () => b, text: async () => JSON.stringify(b) };
}

/** deps whose supabaseRequest is driven by a route table; records every write. */
function deps(routes = {}, { companyId = 'gh-1' } = {}) {
  const writes = [];
  return {
    writes,
    resolveCompany: async () => (companyId ? { company_id: companyId, role: 'service' } : null),
    supabaseRequest: async (path, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST') writes.push({ path, body: JSON.parse(opts.body) });
      for (const [prefix, handler] of Object.entries(routes)) {
        if (path.startsWith(prefix)) {
          return typeof handler === 'function' ? handler(path, opts) : handler;
        }
      }
      return res(200, []);
    },
  };
}

const settingsRow = (automations) => res(200, [{ value: automations }]);

// --------------------------------------------------------------------------
// automationConfig — fail closed, always
// --------------------------------------------------------------------------
test('a switched-on automation reads back as enabled, with its settings', async () => {
  const d = deps({ company_settings: settingsRow({ invoice_overdue_nudge: { enabled: true, first_nudge_days: 5 } }) });
  const cfg = await automationConfig('gh-1', 'invoice_overdue_nudge', d);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.first_nudge_days, 5);
});

test('every not-configured path fails CLOSED', async () => {
  const cases = [
    ['no company', deps({}, { companyId: null }), null],
    ['section absent', deps({ company_settings: res(200, []) }), 'gh-1'],
    ['key absent', deps({ company_settings: settingsRow({ other: { enabled: true } }) }), 'gh-1'],
    ['settings unreadable', deps({ company_settings: missingTable() }), 'gh-1'],
    ['read throws', { supabaseRequest: async () => { throw new Error('boom'); } }, 'gh-1'],
  ];
  for (const [label, d, cid] of cases) {
    const cfg = await automationConfig(cid, 'invoice_overdue_nudge', d);
    assert.equal(cfg.enabled, false, `${label} must be disabled`);
  }
});

test('enabled must be exactly true — a truthy string does not count', async () => {
  const d = deps({ company_settings: settingsRow({ invoice_overdue_nudge: { enabled: 'yes' } }) });
  const cfg = await automationConfig('gh-1', 'invoice_overdue_nudge', d);
  assert.equal(cfg.enabled, false);
});

// --------------------------------------------------------------------------
// master switch — the thing standing between a preview and a real send
// --------------------------------------------------------------------------
test('master switch reads true only when it is really true', async () => {
  assert.equal(await masterSendEnabled(deps({ hl_message_settings: res(200, [{ enabled: true }]) })), true);
  assert.equal(await masterSendEnabled(deps({ hl_message_settings: res(200, [{ enabled: false }]) })), false);
  assert.equal(await masterSendEnabled(deps({ hl_message_settings: res(200, []) })), false, 'no row = closed');
  assert.equal(await masterSendEnabled(deps({ hl_message_settings: missingTable() })), false, 'missing table = closed');
  assert.equal(await masterSendEnabled({ supabaseRequest: async () => { throw new Error('x'); } }), false, 'error = closed');
});

// --------------------------------------------------------------------------
// queueing — status, dedupe, and one bad row not sinking the batch
// --------------------------------------------------------------------------
test('with the master switch OFF rows are queued as preview, not sendable', async () => {
  const d = deps({ hl_outbox: res(201, {}) });
  const out = await queueAutomationMessages(
    [{ step: 'x', dedupe_key: 'k1' }], { automation: 'invoice_overdue_nudge', companyId: 'gh-1', sendEnabled: false }, d,
  );
  assert.equal(out.queued, 1);
  assert.equal(d.writes[0].body.status, 'preview', 'master switch off MUST NOT produce a sendable row');
  assert.equal(d.writes[0].body.automation, 'invoice_overdue_nudge');
  assert.equal(d.writes[0].body.company_id, 'gh-1');
});

test('with the master switch ON rows become sendable', async () => {
  const d = deps({ hl_outbox: res(201, {}) });
  await queueAutomationMessages([{ step: 'x', dedupe_key: 'k1' }], { automation: 'a', companyId: 'gh-1', sendEnabled: true }, d);
  assert.equal(d.writes[0].body.status, 'queued');
});

test('a duplicate dedupe_key is counted, not fatal — this is what stops nightly pestering', async () => {
  const dup = { ok: false, status: 409, text: async () => '{"code":"23505","message":"duplicate key"}' };
  const d = deps({ hl_outbox: dup });
  const out = await queueAutomationMessages(
    [{ dedupe_key: 'k1' }, { dedupe_key: 'k2' }], { automation: 'a', companyId: 'gh-1', sendEnabled: false }, d,
  );
  assert.equal(out.queued, 0);
  assert.equal(out.duplicates, 2);
});

test('rows insert one at a time, so one duplicate cannot block the new ones', async () => {
  let n = 0;
  const d = deps({
    hl_outbox: () => {
      n += 1;
      return n === 1
        ? { ok: false, status: 409, text: async () => 'duplicate key' }
        : res(201, {});
    },
  });
  const out = await queueAutomationMessages(
    [{ dedupe_key: 'known' }, { dedupe_key: 'new-1' }, { dedupe_key: 'new-2' }],
    { automation: 'a', companyId: 'gh-1', sendEnabled: false }, d,
  );
  assert.equal(out.duplicates, 1);
  assert.equal(out.queued, 2, 'a known duplicate must not stop the genuinely new rows');
});

test('a missing outbox table stops the batch and reports it', async () => {
  const d = deps({ hl_outbox: missingTable() });
  const out = await queueAutomationMessages([{ dedupe_key: 'k' }], { automation: 'a', companyId: 'gh-1', sendEnabled: false }, d);
  assert.equal(out.tableMissing, true);
  assert.equal(out.queued, 0);
});

// --------------------------------------------------------------------------
// runAutomation — the gate wrapper
// --------------------------------------------------------------------------
test('a switched-off automation never calls its compute function', async () => {
  const d = deps({ company_settings: settingsRow({ k: { enabled: false } }) });
  let called = false;
  const out = await runAutomation('k', async () => { called = true; return { considered: 5, rows: [{}] }; }, d);
  assert.equal(called, false, 'compute must not run for a disabled automation');
  assert.equal(out.queued, 0);
  assert.equal(out.ran, false);
  assert.match(out.message, /switched off/i);
  assert.ok(d.writes.some((w) => w.path.startsWith('automation_runs') && w.body.outcome === 'skipped_disabled'),
    'a skipped tick must still be recorded, or "why did nothing happen?" is unanswerable');
});

test('a compute error is contained and recorded, never thrown at the cron', async () => {
  const d = deps({ company_settings: settingsRow({ k: { enabled: true } }) });
  const out = await runAutomation('k', async () => { throw new Error('bad query'); }, d);
  assert.equal(out.ok, false);
  assert.match(out.error, /bad query/);
  assert.ok(d.writes.some((w) => w.path.startsWith('automation_runs') && w.body.outcome === 'error'));
});

test('no candidates records a tick and says so', async () => {
  const d = deps({ company_settings: settingsRow({ k: { enabled: true } }) });
  const out = await runAutomation('k', async () => ({ considered: 12, rows: [] }), d);
  assert.equal(out.queued, 0);
  assert.equal(out.considered, 12);
  assert.ok(d.writes.some((w) => w.body.outcome === 'skipped_no_candidates'));
});

test('a successful preview run says plainly that nothing reaches a customer', async () => {
  const d = deps({
    company_settings: settingsRow({ k: { enabled: true } }),
    hl_message_settings: res(200, [{ enabled: false }]),
    hl_outbox: res(201, {}),
  });
  const out = await runAutomation('k', async () => ({ considered: 1, rows: [{ dedupe_key: 'a' }] }), d);
  assert.equal(out.queued, 1);
  assert.equal(out.send_enabled, false);
  assert.match(out.message, /PREVIEW ONLY/);
  assert.match(out.message, /nothing will reach a customer/i);
});

test('deposit_releases_pos is not in AUTOMATION_KEYS — it has no runner', () => {
  assert.ok(!AUTOMATION_KEYS.includes('deposit_releases_pos'));
  assert.deepEqual([...AUTOMATION_KEYS].sort(),
    ['dormant_client_reengage', 'invoice_overdue_nudge', 'missed_call_textback']);
});

// --------------------------------------------------------------------------
// the candidate builders
// --------------------------------------------------------------------------
const api = await import('../api/automations.js');
const { computeMissedCallTextbacks, computeInvoiceOverdueNudges } = api;

function withFetch(routes, fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes('/rest/v1/' + frag)) return res(200, body);
    }
    return res(200, []);
  };
  return fn().finally(() => { global.fetch = original; });
}

test('missed-call: one text per missed call, keyed on the call id', async () => {
  await withFetch({
    voice_calls: [{ id: 'call-1', from_number: '+12035551212', client_id: 'c1', ended_at: '2026-08-17T12:00:00Z' }],
    voice_blocked_numbers: [],
    clients: [{ jobber_id: 'c1', name: 'Sarah Jones', email: 's@x.com' }],
  }, async () => {
    const out = await computeMissedCallTextbacks({ within_seconds: 15 });
    assert.equal(out.rows.length, 1);
    const r = out.rows[0];
    assert.equal(r.channel, 'sms');
    assert.equal(r.recipient_contact, '+12035551212');
    assert.equal(r.dedupe_key, 'missed_call_textback:call-1');
    assert.match(r.body, /Sarah/, 'should greet by first name when we know it');
    // within_seconds becomes a real delay on scheduled_for, not a fiction.
    assert.equal(new Date(r.scheduled_for).toISOString(), '2026-08-17T12:00:15.000Z');
  });
});

test('missed-call: a blocked number is never texted', async () => {
  await withFetch({
    voice_calls: [{ id: 'c1', from_number: '+15550001111', ended_at: '2026-08-17T12:00:00Z' }],
    voice_blocked_numbers: [{ number: '+15550001111' }],
    clients: [],
  }, async () => {
    const out = await computeMissedCallTextbacks({ within_seconds: 0 });
    assert.equal(out.rows.length, 0, 'a blocked number must never receive an automated text');
    assert.equal(out.considered, 1);
  });
});

test('missed-call: an unknown caller still gets a text, just unnamed', async () => {
  await withFetch({
    voice_calls: [{ id: 'c1', from_number: '+15551234567', ended_at: '2026-08-17T12:00:00Z' }],
    voice_blocked_numbers: [], clients: [],
  }, async () => {
    const out = await computeMissedCallTextbacks({});
    assert.equal(out.rows.length, 1);
    assert.match(out.rows[0].body, /^Hi — /);
  });
});

test('overdue: a client nudge before the threshold, an internal escalation after', async () => {
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  await withFetch({
    invoices: [
      { jobber_id: 'i1', invoice_number: '1001', client_id: 'c1', due_date: daysAgo(4), balance: 500, invoice_status: 'issued' },
      { jobber_id: 'i2', invoice_number: '1002', client_id: 'c1', due_date: daysAgo(15), balance: 900, invoice_status: 'issued' },
    ],
    clients: [{ jobber_id: 'c1', name: 'Sarah Jones', email: 's@x.com' }],
  }, async () => {
    const out = await computeInvoiceOverdueNudges({ first_nudge_days: 3, escalate_days: 10 });
    const byStep = Object.fromEntries(out.rows.map((r) => [r.step, r]));

    const nudge = byStep.invoice_overdue_nudge;
    assert.ok(nudge, 'the 4-day-old invoice should produce a client nudge');
    assert.equal(nudge.recipient_contact, 's@x.com');
    assert.equal(nudge.dedupe_key, 'invoice_overdue_nudge:i1');
    assert.match(nudge.body, /\$500\.00/);

    const esc = byStep.invoice_overdue_escalation;
    assert.ok(esc, 'the 15-day-old invoice should escalate');
    assert.equal(esc.recipient_name, 'Office');
    assert.notEqual(esc.recipient_contact, 's@x.com', 'an escalation must never go to the client');
    assert.equal(esc.dedupe_key, 'invoice_overdue_escalation:i2');
  });
});

test('overdue: paid and void invoices are left alone', async () => {
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  await withFetch({
    invoices: [
      { jobber_id: 'i1', client_id: 'c1', due_date: daysAgo(9), balance: 100, invoice_status: 'paid' },
      { jobber_id: 'i2', client_id: 'c1', due_date: daysAgo(9), balance: 100, invoice_status: 'Voided' },
    ],
    clients: [{ jobber_id: 'c1', name: 'X', email: 'x@x.com' }],
  }, async () => {
    const out = await computeInvoiceOverdueNudges({ first_nudge_days: 3, escalate_days: 10 });
    assert.equal(out.rows.length, 0);
  });
});

test('overdue: a client with no email produces no nudge rather than a broken one', async () => {
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  await withFetch({
    invoices: [{ jobber_id: 'i1', client_id: 'c1', due_date: daysAgo(5), balance: 100, invoice_status: 'issued' }],
    clients: [{ jobber_id: 'c1', name: 'No Email' }],
  }, async () => {
    const out = await computeInvoiceOverdueNudges({ first_nudge_days: 3, escalate_days: 10 });
    assert.equal(out.rows.length, 0);
  });
});

// Reina M1a — auto-scan. Unit-tests the scan core with injected deps: sender
// -> client/job routing, the change-request gate, per-message dedup, the
// notify-on-new-recommendations step, and the kill-switch abort. No network.

import test from 'node:test';
import assert from 'node:assert';
import { scanForChangeRequests, resolveClientJob, killSwitchActive } from '../api/reina/scan-change-requests.js';
import { buildInboxUrl } from '../api/reina/_m365-pull.js';

function created(id, title) { return { status: 201, body: { ok: true, approval: { id, title } } }; }
const SKIP_NOISE = { status: 200, body: { ok: true, skipped: true, reason: 'not_a_change_request' } };
const IDEMPOTENT = { status: 200, body: { ok: true, idempotent: true } };

test('buildInboxUrl filters by received date, newest first', () => {
  const url = buildInboxUrl('2026-08-01T00:00:00.000Z', { top: 25 });
  assert.match(decodeURIComponent(url), /receivedDateTime ge 2026-08-01T00:00:00\.000Z/);
  assert.match(url, /orderby=receivedDateTime%20desc/);
  assert.match(url, /\$top=25/);
});

test('routes known-client single-open-job email to observe, and notifies on new recommendations', async () => {
  const observed = [];
  let notifiedText = null;
  const out = await scanForChangeRequests({
    killSwitch: async () => false,
    listMessages: async () => ({ ok: true, messages: [
      { from: 'client@acme.com', text: 'Can you add two more outlets to the kitchen?', internetMessageId: '<m1>' },
      { from: 'noise@vendor.com', text: 'Invoice attached', internetMessageId: '<m2>' },
    ] }),
    resolveClientJob: async (email) => email === 'client@acme.com'
      ? { jobId: 'JOB1', jobTitle: 'Kitchen reno', clientId: 'C1', clientName: 'Acme' }
      : { skip: 'not_a_known_client' },
    observe: async (args) => { observed.push(args); return created('a1', 'Add two outlets'); },
    notify: async (t) => { notifiedText = t; },
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.scanned, 2);
  assert.strictEqual(out.created, 1);
  assert.strictEqual(out.skipped.not_a_known_client, 1);
  assert.strictEqual(observed.length, 1, 'only the known-client message is observed');
  assert.strictEqual(observed[0].jobId, 'JOB1');
  assert.strictEqual(observed[0].requestSource, 'm365_graph');
  assert.strictEqual(observed[0].messageId, '<m1>');
  assert.strictEqual(out.notified, true);
  assert.match(notifiedText, /1 new client change request/);
  assert.match(notifiedText, /Acme/);
});

test('does NOT notify when nothing new was created (all noise / already seen)', async () => {
  let notified = false;
  const out = await scanForChangeRequests({
    killSwitch: async () => false,
    listMessages: async () => ({ ok: true, messages: [
      { from: 'client@acme.com', text: 'thanks, see you monday', internetMessageId: '<m3>' },
      { from: 'client@acme.com', text: 'already processed', internetMessageId: '<m4>' },
    ] }),
    resolveClientJob: async () => ({ jobId: 'JOB1', jobTitle: 'Kitchen', clientId: 'C1', clientName: 'Acme' }),
    observe: async (a) => (a.messageId === '<m3>' ? SKIP_NOISE : IDEMPOTENT),
    notify: async () => { notified = true; },
  });
  assert.strictEqual(out.created, 0);
  assert.strictEqual(out.skipped.not_a_change_request, 1);
  assert.strictEqual(out.skipped.already_seen, 1);
  assert.strictEqual(out.notified, false);
  assert.strictEqual(notified, false);
});

test('ambiguous or unknown senders are skipped, never observed (no wrong-job writes)', async () => {
  const observed = [];
  const out = await scanForChangeRequests({
    killSwitch: async () => false,
    listMessages: async () => ({ ok: true, messages: [
      { from: 'multi@acme.com', text: 'change something', internetMessageId: '<m5>' },
      { from: 'nojob@acme.com', text: 'change something', internetMessageId: '<m6>' },
    ] }),
    resolveClientJob: async (email) => email === 'multi@acme.com' ? { skip: 'ambiguous_job' } : { skip: 'no_open_job' },
    observe: async (a) => { observed.push(a); return created('x', 'x'); },
    notify: async () => {},
  });
  assert.strictEqual(observed.length, 0);
  assert.strictEqual(out.created, 0);
  assert.strictEqual(out.skipped.ambiguous_job, 1);
  assert.strictEqual(out.skipped.no_open_job, 1);
});

test('kill switch aborts before listing or writing anything', async () => {
  let listed = false;
  const out = await scanForChangeRequests({
    killSwitch: async () => true,
    listMessages: async () => { listed = true; return { ok: true, messages: [] }; },
    observe: async () => created('n', 'n'),
    notify: async () => {},
  });
  assert.strictEqual(out.aborted, 'kill_switch');
  assert.strictEqual(out.created, 0);
  assert.strictEqual(listed, false, 'must not read the mailbox when emergency-stopped');
});

test('resolveClientJob: unknown email and single-open-job resolution', async () => {
  const sb = (rows) => async (path) => ({ ok: true, json: async () => rows(path), text: async () => '' });

  const unknown = await resolveClientJob('nobody@x.com', { supabaseRequest: sb((p) => p.startsWith('clients?') ? [] : []) });
  assert.strictEqual(unknown.skip, 'not_a_known_client');

  const single = await resolveClientJob('c@acme.com', { supabaseRequest: sb((p) =>
    p.startsWith('clients?') ? [{ jobber_id: 'C1', name: 'Acme' }] : [{ jobber_id: 'JOB1', title: 'Kitchen' }]) });
  assert.strictEqual(single.jobId, 'JOB1');
  assert.strictEqual(single.clientName, 'Acme');

  const many = await resolveClientJob('c@acme.com', { supabaseRequest: sb((p) =>
    p.startsWith('clients?') ? [{ jobber_id: 'C1', name: 'Acme' }] : [{ jobber_id: 'J1', title: 'A' }, { jobber_id: 'J2', title: 'B' }]) });
  assert.strictEqual(many.skip, 'ambiguous_job');
});

test('killSwitchActive is a safe no-op when the companies table is unreadable', async () => {
  const active = await killSwitchActive({ supabaseRequest: async () => ({ ok: false, json: async () => [], text: async () => 'relation does not exist' }) });
  assert.strictEqual(active, false);
  const stopped = await killSwitchActive({ supabaseRequest: async () => ({ ok: true, json: async () => [{ id: 'co1' }] }) });
  assert.strictEqual(stopped, true);
});

// The unattended sweep: read the mailbox and reach him with no tab open.
//
// Chris, 2026-08-19: "lets add the notifications while hivelogic is closed."
//
// Every failure mode of this thing is a SILENCE, which is the hardest kind to
// notice. Nobody files a bug saying "I did not get an email I did not know
// about." So the tests here are mostly about the ways it could go quiet and
// look fine doing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sweepOwner, MAX_TOASTS_PER_SWEEP, FRESH_MS } from '../api/reina/mail-sweep.js';
import { isGone, sendPush } from '../api/_lib/reina-push-send.js';

const OWNER = '11111111-1111-4111-8111-111111111111';

function row(over) {
  return Object.assign({
    message_id: '<m1@mail>', graph_id: 'G1', home_account_id: 'ms-1',
    subject: 'Re: Ocean Drive quote', from_name: 'Ken', from_address: 'ken@frattaroli.com',
    received_at: '2026-08-19T12:00:00Z', label: 'needs_reply', corrected_label: null,
    reason: 'Ken is chasing the quote', summary_text: null, action_text: null,
    notified_at: null, acted_at: null,
  }, over || {});
}

/** A Supabase stub that records every write, so "did it stamp that" is a fact
 *  rather than an inference. */
function makeDeps(opts) {
  const o = opts || {};
  const writes = [];
  const pushed = [];
  return {
    writes, pushed,
    deps: {
      now: () => o.now || new Date('2026-08-19T15:00:00Z'),   // 11am Eastern
      anthropic: null,
      scanImpl: o.scanImpl,
      webPush: {
        setVapidDetails() {},
        sendNotification: o.sendNotification || (async (sub, body) => { pushed.push({ sub, body: JSON.parse(body) }); }),
      },
      supabaseRequest: async (path, options) => {
        const method = (options && options.method) || 'GET';
        if (method !== 'GET') { writes.push({ path, method, body: options && options.body }); return { ok: true, json: async () => [] }; }
        if (path.startsWith('reina_notify_rules')) return { ok: true, json: async () => (o.rules || []) };
        if (path.startsWith('reina_push_subscriptions')) return { ok: true, json: async () => (o.subs === undefined ? [{ owner_id: OWNER, endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }] : o.subs) };
        if (path.startsWith('reina_mail_triage')) return { ok: true, json: async () => (o.rows || []) };
        return { ok: true, json: async () => [] };
      },
    },
  };
}

// scanMailboxes is the real mailbox read; these tests are about what happens
// AFTER it, so it is stubbed at the module boundary via deps.
const origEnv = { ...process.env };
test.before?.(() => {});
process.env.REINA_VAPID_PUBLIC_KEY = 'test-public';
process.env.REINA_VAPID_PRIVATE_KEY = 'test-private';

// ---- the whole point: it works with nobody signed in -----------------------

test('the sweep reads the mailbox itself, rather than waiting for a browser to', () => {
  // If it only ever notified about mail some tab already pulled, it would do
  // nothing on the night he never opened HiveLogic -- which is the night it
  // exists for.
  const src = readFileSync(new URL('../api/reina/mail-sweep.js', import.meta.url), 'utf-8');
  assert.match(src, /import \{ scanMailboxes \}/);
  assert.match(src, /await scanMailboxes\(ownerId, deps\)/);
});

test('a mailbox that needs reconnecting does not swallow the mail already judged', async () => {
  // The Microsoft token read is what fails when a mailbox needs reconnecting.
  // That must not also cost him the mail Reina already judged and that is still
  // sitting there waiting -- and the failure has to be named, because "the
  // sweep ran and sent nothing" is indistinguishable from "all quiet".
  const { deps, pushed } = makeDeps({ rows: [row()] });
  const base = deps.supabaseRequest;
  deps.supabaseRequest = async (path, options) => {
    if (path.startsWith('hc_ms_tokens')) return { ok: false, text: async () => 'token refresh failed' };
    return base(path, options);
  };
  const out = await sweepOwner(OWNER, deps);
  assert.equal(out.sent, 1, 'what is already judged still reaches him');
  assert.match(String(out.scanError), /token refresh failed/, 'and the failure is named');
  assert.equal(pushed.length, 1);
});

// ---- the ways it could go quiet --------------------------------------------

test('junk never becomes a Windows toast', async () => {
  const { deps, pushed } = makeDeps({ rows: [row({ label: 'junk' })] });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(out.sent, 0);
  assert.equal(pushed.length, 0);
});

test('a sender he silenced stays silenced', async () => {
  const { deps, pushed } = makeDeps({
    rows: [row({ from_address: 'noreply@portal.com' })],
    rules: [{ match_kind: 'sender', match_value: 'noreply@portal.com', notify: false }],
  });
  assert.equal((await sweepOwner(OWNER, deps)).sent, 0);
  assert.equal(pushed.length, 0);
});

test('rules failing to load must not turn into silence', async () => {
  // A 502 on the rules read means we do not know what he silenced. Guessing
  // "silence everything" would make a database blip look like the feature
  // dying quietly; guessing "notify" costs him a click.
  const { deps, pushed } = makeDeps({ rows: [row()] });
  const base = deps.supabaseRequest;
  deps.supabaseRequest = async (path, options) => {
    if (path.startsWith('reina_notify_rules') && !(options && options.method)) return { ok: false, json: async () => [] };
    return base(path, options);
  };
  assert.equal((await sweepOwner(OWNER, deps)).sent, 1);
  assert.equal(pushed.length, 1);
});

test('nobody subscribed means no work and no crash', async () => {
  const { deps } = makeDeps({ rows: [row()], subs: [] });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(out.sent, 0);
  assert.match(String(out.note), /no live subscription/);
});

// ---- sent once, ever -------------------------------------------------------

test('notified_at is stamped only AFTER a push service accepted it', async () => {
  // Stamping first would mean one bad minute at Google costs him that email
  // permanently -- the sweep would never look at it again.
  const { deps, writes } = makeDeps({
    rows: [row()],
    sendNotification: async () => { const e = new Error('boom'); e.statusCode = 500; throw e; },
  });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(out.sent, 0);
  assert.ok(!writes.some((w) => String(w.body || '').includes('notified_at')),
    'a failed send must leave it unnotified so the next sweep retries');
});

test('a successful send stamps it, so the next sweep skips it', async () => {
  const { deps, writes } = makeDeps({ rows: [row()] });
  await sweepOwner(OWNER, deps);
  const stamp = writes.find((w) => String(w.body || '').includes('notified_at'));
  assert.ok(stamp, 'it must be recorded as sent');
  assert.equal(stamp.method, 'PATCH');
  assert.match(stamp.path, /message_id=eq/, 'and only that message');
});

test('something he already handled at his desk never pings his laptop', async () => {
  const { deps, pushed } = makeDeps({ rows: [row({ acted_at: '2026-08-19T14:00:00Z' })] });
  assert.equal((await sweepOwner(OWNER, deps)).sent, 0);
  assert.equal(pushed.length, 0);
});

// ---- the backlog lesson, applied to toasts ---------------------------------

test('a backlog is capped, because eleven Windows toasts is the old bug louder', async () => {
  // "im getting a bunch of email notifications" was the in-app popup firing
  // the whole queue. The same mistake through the OS is worse, not better.
  const rows = Array.from({ length: 11 }, (_, i) => row({ message_id: '<m' + i + '@mail>' }));
  const { deps, pushed } = makeDeps({ rows });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(MAX_TOASTS_PER_SWEEP, 3);
  assert.equal(out.sent, 3);
  assert.equal(pushed.length, 3);
  assert.equal(out.overflow, 8);
});

test('the "+N more" rides on the last toast only', async () => {
  // Putting the same count on all three is three lies of one number.
  const rows = Array.from({ length: 5 }, (_, i) => row({ message_id: '<m' + i + '@mail>' }));
  const { deps, pushed } = makeDeps({ rows });
  await sweepOwner(OWNER, deps);
  const withMore = pushed.filter((p) => /more waiting/.test(p.body.body));
  assert.equal(withMore.length, 1);
  assert.match(withMore[0].body.body, /\+2 more waiting/);
});


// ---- the backlog, which is the mistake this could most easily repeat --------

test('a three-day-old email never becomes a Windows toast', async () => {
  // The morning this was built: 129 open actionable rows, 5 of them from the
  // last four hours. Without a freshness window the first sweep would have
  // worked through all 129 at three toasts every ten minutes -- seven hours of
  // pinging, which is the complaint that started all of this, rebuilt on top
  // of the operating system.
  const { deps, pushed } = makeDeps({
    rows: [row({ received_at: '2026-08-16T12:00:00Z' })],   // three days before "now"
  });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(FRESH_MS, 4 * 60 * 60 * 1000);
  assert.equal(out.sent, 0);
  assert.equal(out.backlogSkipped, 1);
  assert.equal(pushed.length, 0);
});

test('backlog is skipped, not marked sent -- it still reaches him in the app', async () => {
  const { deps, writes } = makeDeps({ rows: [row({ received_at: '2026-08-16T12:00:00Z' })] });
  await sweepOwner(OWNER, deps);
  assert.ok(!writes.some((w) => String(w.body || '').includes('notified_at')),
    'stamping it would also hide it from a later sweep for no reason');
});

test('mail that just landed still gets through', async () => {
  const { deps, pushed } = makeDeps({ rows: [row({ received_at: '2026-08-19T14:30:00Z' })] });
  assert.equal((await sweepOwner(OWNER, deps)).sent, 1);
  assert.equal(pushed.length, 1);
});

test('a row with no received_at is not silently dropped', async () => {
  // Missing data must not be read as "old". The safe reading of "we do not
  // know when this arrived" is to let him see it.
  const { deps } = makeDeps({ rows: [row({ received_at: null })] });
  assert.equal((await sweepOwner(OWNER, deps)).sent, 1);
});

// ---- quiet hours -----------------------------------------------------------

test('quiet hours hold it, they do not drop it', async () => {
  const { deps, writes, pushed } = makeDeps({
    rows: [row()],
    now: new Date('2026-08-19T05:00:00Z'),   // 1am Eastern
  });
  const out = await sweepOwner(OWNER, deps, { timeZone: 'America/New_York', quietFrom: 21, quietTo: 7 });
  assert.equal(out.sent, 0);
  assert.equal(out.quiet, true);
  assert.equal(out.heldForQuietHours, 1);
  assert.equal(pushed.length, 0);
  assert.ok(!writes.some((w) => String(w.body || '').includes('notified_at')),
    'unnotified, so the 7am sweep sends it');
});

// ---- a dead browser --------------------------------------------------------

test('only a 404/410 retires a subscription', async () => {
  // 429 and 500 are the push service having a bad minute. Retiring on those
  // would silently unsubscribe him from his own alerts.
  assert.equal(isGone(410), true);
  assert.equal(isGone(404), true);
  assert.equal(isGone(429), false);
  assert.equal(isGone(500), false);
  assert.equal(isGone(undefined), false);
});

test('a dead browser is marked, not deleted', async () => {
  // A bad deploy that mass-fails should be visible in the table afterwards,
  // not have quietly emptied it.
  const writes = [];
  const res = await sendPush(
    [{ endpoint: 'https://push.example/dead', p256dh: 'p', auth: 'a' }],
    { title: 't', body: 'b' },
    {
      now: () => new Date('2026-08-19T15:00:00Z'),
      webPush: { setVapidDetails() {}, sendNotification: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; } },
      supabaseRequest: async (path, options) => { writes.push({ path, body: options && options.body }); return { ok: true, json: async () => [] }; },
    }
  );
  assert.equal(res.retired, 1);
  const mark = writes.find((w) => String(w.body || '').includes('failed_at'));
  assert.ok(mark, 'recorded');
  assert.ok(!writes.some((w) => /DELETE/.test(String(w.method || ''))), 'never deleted');
});

test('one dead browser must not stop the others', async () => {
  let n = 0;
  const res = await sendPush(
    [
      { endpoint: 'https://push.example/dead', p256dh: 'p', auth: 'a' },
      { endpoint: 'https://push.example/live', p256dh: 'p', auth: 'a' },
    ],
    { title: 't' },
    {
      now: () => new Date(),
      webPush: {
        setVapidDetails() {},
        sendNotification: async (sub) => { n++; if (/dead/.test(sub.endpoint)) { const e = new Error('gone'); e.statusCode = 410; throw e; } },
      },
      supabaseRequest: async () => ({ ok: true, json: async () => [] }),
    }
  );
  assert.equal(n, 2, 'both were attempted');
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
});

test('missing VAPID keys is reported, never reported as a clean empty sweep', async () => {
  const saved = process.env.REINA_VAPID_PRIVATE_KEY;
  delete process.env.REINA_VAPID_PRIVATE_KEY;
  try {
    const res = await sendPush([{ endpoint: 'https://p/1', p256dh: 'p', auth: 'a' }], {}, {});
    assert.equal(res.sent, 0);
    assert.match(String(res.reason), /VAPID/);
  } finally { process.env.REINA_VAPID_PRIVATE_KEY = saved; }
});

// ---- what the service worker does ------------------------------------------

const sw = readFileSync(new URL('../public/reina-push-sw.js', import.meta.url), 'utf-8');

test('the worker never intercepts fetch', () => {
  // The other three service workers in this repo cache their app shells. Doing
  // that here would let a worker nobody remembers registering serve a stale
  // HiveLogic, which is a far worse bug than a missed toast.
  assert.ok(!/addEventListener\(\s*'fetch'/.test(sw));
});

test('the toast waits for him instead of evaporating', () => {
  assert.match(sw, /requireInteraction: true/);
});

test('"Not this sender" is on the toast itself', () => {
  assert.match(sw, /event\.action === 'mute'/);
  assert.match(sw, /action=mute/);
  assert.match(sw, /credentials: 'include'/, 'there is no page to read a token from');
});

test('a failed mute says so, instead of letting him think it worked', () => {
  const block = sw.slice(sw.indexOf("event.action === 'mute'"));
  assert.match(block.slice(0, 1400), /Could not silence that from here/);
});

test('clicking it focuses the tab he already has open', () => {
  // He may have a half-built estimate in it. Opening a second window is how
  // that gets lost.
  assert.match(sw, /clients\.matchAll/);
  assert.match(sw, /return c\.focus\(\)/);
  assert.match(sw, /reina-open-mail/, 'and tells the page which email it was');
});

Object.assign(process.env, origEnv);

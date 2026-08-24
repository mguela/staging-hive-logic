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
  // Eleven DIFFERENT emails. Varying only the message id would now be eleven
  // copies of one email, which collapses to a single toast by design.
  const rows = Array.from({ length: 11 }, (_, i) => row({ message_id: '<m' + i + '@mail>', subject: 'Quote ' + i }));
  const { deps, pushed } = makeDeps({ rows });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(MAX_TOASTS_PER_SWEEP, 3);
  assert.equal(out.sent, 3);
  assert.equal(pushed.length, 3);
  assert.equal(out.overflow, 8);
});

test('the "+N more" rides on the last toast only', async () => {
  // Putting the same count on all three is three lies of one number.
  const rows = Array.from({ length: 5 }, (_, i) => row({ message_id: '<m' + i + '@mail>', subject: 'Quote ' + i }));
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

test('the toast behaves like a toast', () => {
  // It used to set requireInteraction: true, so every notification sat on his
  // screen until pressed. Chris, 2026-08-23, looking at a stack of them: "they
  // dont ever go away?" Chrome allows only two action buttons, and Open and
  // the mute already use both, so there was no room to add a Dismiss -- and a
  // toast that fades into the Action Center IS the dismiss button.
  assert.doesNotMatch(sw, /requireInteraction:\s*true/);
});

test('the mute is on the toast itself', () => {
  // This test used to assert `action=mute` and `credentials: 'include'` --
  // the exact mechanism that could never work. It passed every run while the
  // feature was refused at the edge on every single press. Pinning HOW
  // something is done says nothing about whether it does it.
  assert.match(sw, /event\.action === 'mute'/);
  assert.match(sw, /data\.fromAddress/, 'the sender is what gets silenced');
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

// Chris, 2026-08-21, with the VAPID keys correctly set in Vercel, the page
// still said "Desktop notifications are not set up on the server yet."
//
// GET /api/reina/push?action=key came back
//   {"ok":false,"error":"Authentication required."}
// from the EDGE MIDDLEWARE, which gates /api/* wholesale and never ran the
// handler. The first cut answered `key` above requireApiAuth on the theory
// that a public key needs no session -- true of the key, irrelevant to the
// middleware sitting in front of it. And because that refusal is JSON with no
// `configured` field, the page read it as "not configured" and sent him to
// Vercel to hunt for keys that were already there.

const pushApi = readFileSync(new URL('../api/reina/push.js', import.meta.url), 'utf-8');
const pushClient = readFileSync(new URL('../public/reina-push.js', import.meta.url), 'utf-8');

test('the key is served behind the session, not in front of it', () => {
  const authAt = pushApi.indexOf('await requireApiAuth');
  const keyAt = pushApi.indexOf("if (action === 'key')");
  assert.ok(authAt > 0 && keyAt > authAt,
    'answering before the auth check is pointless -- the middleware refuses it first');
});

test('the page sends its session when asking for the key', () => {
  const fn = pushClient.slice(pushClient.indexOf('function getKey()'));
  assert.match(fn.slice(0, 900), /hlRequireSession/);
  assert.match(fn.slice(0, 900), /Authorization.*Bearer/);
  assert.match(fn.slice(0, 900), /cache: 'no-store'/,
    'and uncached, or adding the keys in Vercel would not take effect until a hard refresh');
});

test('"could not ask" is never reported as "not set up"', () => {
  // These send him to two completely different places. Conflating them cost an
  // evening once already.
  const block = pushClient.slice(pushClient.indexOf('return getKey()'));
  const authBranch = block.indexOf('d.ok === false');
  const unknown = block.indexOf("state: 'unknown'");
  const unconfigured = block.indexOf("state: 'unconfigured'");
  assert.ok(authBranch > -1, 'the refusal is detected at all');
  assert.ok(unknown > authBranch && unknown < unconfigured,
    'and it returns its own answer BEFORE the not-configured branch can claim it');
  assert.match(block.slice(unknown - 120, unknown + 200), /Could not check with HiveLogic/);
});

test('no new public API route was opened to make this work', () => {
  // The only caller is a signed-in page, so a hole in the guard would buy
  // nothing and cost surface area.
  const guard = readFileSync(new URL('../api/_lib/guard.js', import.meta.url), 'utf-8');
  const publicList = guard.slice(guard.indexOf('const PUBLIC_RESOURCE_PATHS'), guard.indexOf('export function isPublicApiPath'));
  assert.ok(!/reina\/push/.test(publicList));
});

test('a state that came with a reason shows the reason, never a bare "Off"', () => {
  // Falling through to "Off. Reina only tells you about mail while HiveLogic
  // is open." is how the 401 got read as "the keys are missing" -- the panel
  // said the one thing that was not true and hid the one thing that was.
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
  const paint = index.slice(index.indexOf('window.hlNotifySettings'));
  assert.match(paint.slice(0, 9000), /\} else if \(s\.detail\) \{/);
  assert.ok(!/s\.state === 'blocked' \|\| s\.state === 'unsupported'/.test(paint),
    'an allowlist of known-bad states cannot cover the one nobody predicted');
});

// ---- the morning two identical toasts arrived ------------------------------
//
// 2026-08-23, 12:01:39.626: two Windows toasts, same words, same second.
// Gusto sends the payroll reminder to more than one of Chris's mailboxes, so
// the same email was two rows with two Graph ids -- both real, both correctly
// judged worth telling him about. The push tag is built from message_id, so
// neither Chrome nor the tag could collapse them.

test('one email in two mailboxes raises one toast', async () => {
  const rows = [
    row({ message_id: 'AAQkAGRmODBhMDc2', from_address: 'automated@gusto.com', subject: 'Time to run payroll for GH Electrical Solutions LLC' }),
    row({ message_id: 'AAQkAGQxY2U1ZTUw', from_address: 'automated@gusto.com', subject: 'Time to run payroll for GH Electrical Solutions LLC' }),
  ];
  const { deps, pushed } = makeDeps({ rows });
  const out = await sweepOwner(OWNER, deps);

  assert.equal(pushed.length, 1, 'one interruption for one email');
  assert.equal(out.sent, 1);
  assert.equal(out.emails, 1, 'one distinct email');
  assert.equal(out.collapsed, 1, 'and one copy suppressed, reported rather than silent');
});

test('the suppressed copy is stamped, or it comes back on the next sweep', async () => {
  // Leaving it unstamped would hand the next sweep the same email to raise
  // again -- the duplicate arriving ten minutes late instead of alongside,
  // which is worse than arriving twice at once.
  const rows = [
    row({ message_id: 'AAQkAGRmODBhMDc2', from_address: 'automated@gusto.com', subject: 'Time to run payroll' }),
    row({ message_id: 'AAQkAGQxY2U1ZTUw', from_address: 'automated@gusto.com', subject: 'Time to run payroll' }),
  ];
  const { deps, writes } = makeDeps({ rows });
  await sweepOwner(OWNER, deps);

  const stamped = writes.filter((w) => w.method === 'PATCH' && /notified_at/.test(w.body || ''));
  assert.equal(stamped.length, 2, 'both copies are marked as dealt with');
  for (const id of ['AAQkAGRmODBhMDc2', 'AAQkAGQxY2U1ZTUw']) {
    assert.ok(stamped.some((w) => w.path.includes(encodeURIComponent(id))), `${id} was stamped`);
  }
});

test('nothing is stamped when the push never left', async () => {
  // The existing rule, which the duplicate stamping must not quietly break:
  // one bad minute at Google must not cost him the email forever.
  const rows = [
    row({ message_id: 'a', from_address: 'automated@gusto.com', subject: 'Payroll' }),
    row({ message_id: 'b', from_address: 'automated@gusto.com', subject: 'Payroll' }),
  ];
  const { deps, writes } = makeDeps({
    rows,
    sendNotification: async () => { const e = new Error('service unavailable'); e.statusCode = 500; throw e; },
  });
  const out = await sweepOwner(OWNER, deps);

  assert.equal(out.sent, 0);
  assert.equal(writes.filter((w) => /notified_at/.test(w.body || '')).length, 0,
    'a failed send leaves every copy available to try again');
});

test('the per-sweep cap counts emails, not copies of one email', async () => {
  // Four distinct emails, each landing in two mailboxes. The cap is three, so
  // he should get three toasts and be told one more is waiting -- not three
  // toasts covering one and a half emails.
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push(row({ message_id: 'graph-' + i, from_address: 'sam@vendor.com', subject: 'Job ' + i }));
    rows.push(row({ message_id: 'rfc-' + i, from_address: 'sam@vendor.com', subject: 'Job ' + i }));
  }
  const { deps, pushed } = makeDeps({ rows });
  const out = await sweepOwner(OWNER, deps);

  assert.equal(out.emails, 4);
  assert.equal(pushed.length, 3);
  assert.equal(out.overflow, 1, '+1 more waiting, counted in emails');
  assert.match(pushed[2].body.body, /\+1 more waiting/);
});

// ---- in-app only, without starving the in-app ------------------------------
//
// "just notifications on the bottom of hivelogic not windows." The scan has to
// keep running for that to be possible at all: the in-app nudge reads
// reina_mail_triage, and the only thing that fills it with new mail is
// scanMailboxes inside this sweep. Suppressing the push here rather than
// deleting his subscription is the whole point -- ownersToSweep picks owners
// FROM the subscription table, so no subscription means no sweep at all.

const DESKTOP_OFF = [{ match_kind: 'channel', match_value: 'desktop', notify: false }];

test('desktop off sends no toast', async () => {
  const { deps, pushed } = makeDeps({ rows: [row({})], rules: DESKTOP_OFF });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(pushed.length, 0);
  assert.equal(out.sent, 0);
  assert.equal(out.desktopOff, true, 'reported, not silently zero');
});

test('the mailbox is read before the channel is consulted', () => {
  // If the desktop check short-circuited above scanMailboxes, turning toasts
  // off would stop the mailbox read -- and the in-app nudge he asked to KEEP
  // reads reina_mail_triage, which only this sweep fills with new mail. He
  // would have switched off the thing he wanted.
  const src = readFileSync(new URL('../api/reina/mail-sweep.js', import.meta.url), 'utf-8');
  const scanAt = src.indexOf('await scanMailboxes(');
  const checkAt = src.indexOf('if (!desktopPushEnabled(rules))');
  assert.ok(scanAt > 0 && checkAt > 0);
  assert.ok(scanAt < checkAt, 'the scan must not be behind the desktop preference');
});

test('desktop off leaves the mail unstamped', async () => {
  // Nothing was sent, so nothing is marked sent. Turning toasts back on must
  // not find every email already burned.
  const { deps, writes } = makeDeps({ rows: [row({})], rules: DESKTOP_OFF });
  await sweepOwner(OWNER, deps);
  assert.equal(writes.filter((w) => /notified_at/.test(w.body || '')).length, 0);
});

test('desktop on is the default, and a muted sender does not turn the channel off', async () => {
  const { deps, pushed } = makeDeps({
    rows: [row({})],
    rules: [{ match_kind: 'sender', match_value: 'someone-else@nowhere.com', notify: false }],
  });
  const out = await sweepOwner(OWNER, deps);
  assert.equal(out.desktopOff, undefined);
  assert.equal(pushed.length, 1);
});

// ---- the mute that never worked and said it had -----------------------------
//
// reina_notify_rules was empty. Not because Chris never pressed the button --
// because pressing it could not possibly have worked, and told him it had.
//
// The worker posted with credentials:'include' and no Authorization header,
// having no page to read a token from. requireApiAuth reads only the
// Authorization header, nothing in this app sets an auth cookie, and
// /api/reina/push is deliberately off the edge guard's public allowlist. Every
// mute was 401'd before the handler ran.
//
// And fetch() RESOLVES on a 401 -- it rejects only on network failure -- so the
// .then() ran and drew "Silenced <sender>" over a request that had just been
// refused. The .catch() meant to say otherwise never fired.

// Comments in this file quote the code they replaced, so asserting on the raw
// text finds the explanation and calls it the bug.
const swCode = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the worker no longer posts the mute itself', () => {
  assert.ok(!/\bfetch\s*\(/.test(swCode),
    'the worker makes no calls at all now -- it has nothing to authenticate with');
  assert.ok(!/credentials/.test(swCode),
    'there was never an auth cookie to include; it only looked like authentication');
});

test('the press is handed to a signed-in page instead', () => {
  assert.match(sw, /postMessage\(\{ type: 'reina-mute'/);
  const client = readFileSync(new URL('../public/reina-push.js', import.meta.url), 'utf-8');
  assert.match(client, /msg\.type === 'reina-mute'/);
  assert.match(client, /api\('mute', \{ fromAddress: fromAddress, scope: scope \|\| 'sender' \}\)/,
    'the page holds the token, so the page makes the call');
});

test('a press with every tab shut is kept, not dropped', () => {
  // This is the case the notification exists for. Losing it here would be the
  // original bug with better manners.
  assert.match(sw, /function queueMute\(/);
  assert.match(sw, /indexedDB\.open\(MUTE_DB/, 'a worker has no localStorage, and Chrome stops it between pushes');
  assert.match(sw, /keyPath: 'fromAddress'/, 'two toasts from one sender is one pending mute');
});

test('the queue is drained on load, and only cleared once the server took it', () => {
  const client = readFileSync(new URL('../public/reina-push.js', import.meta.url), 'utf-8');
  assert.match(client, /drainQueuedMutes\(\);/);
  assert.match(client, /if \(!done\) return;/,
    'a failed drain must be retried next load, not swallowed');
});

test('the toast promises only what happened', () => {
  // Three different outcomes, three different sentences. The old code had one
  // sentence for all of them, and it was the optimistic one.
  assert.match(sw, /'Silencing ' \+ data\.fromAddress/, 'a tab is open: it is being applied now');
  assert.match(sw, /will be silenced next time you open HiveLogic/, 'no tab: it is pending');
  assert.match(sw, /Could not silence that from here/, 'the queue itself failed');
  assert.ok(!/body: 'Silenced ' \+ data\.fromAddress/.test(sw),
    'the flat past-tense claim is what made this a lie');
});

test('the panel names the button that exists', () => {
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
  assert.ok(index.includes('Press “Mute sender” on a notification'));
  assert.ok(!index.includes('Press “Not this sender” on a notification'),
    'the button was renamed in #537 and this copy was missed');
});

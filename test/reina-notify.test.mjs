// Chris, 2026-08-19: "lets add the notifications while hivelogic is closed" —
// on the computer, as a Windows notification — and "Reina needs to have an
// option to mark it with some indicator that would allow her to learn over
// time whats worth sending and what can wait, also the junk/spam filter is
// important."
//
// These tests are about the DECISION, not the plumbing. Getting a push message
// delivered is a solved problem with a library behind it. Deciding whether an
// email is worth taking him off a roof is the part that is his alone, and the
// part that quietly rots if nothing pins it down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NOTIFY_LABELS, DEFAULT_NOTIFY, domainOf, matchNotifyRule, shouldNotify,
  isQuietHour, notificationFor, muteRuleFor, mailIdentity, collapseDuplicates,
  desktopPushEnabled, desktopChannelRule,
} from '../api/_lib/reina-notify.js';

const row = (over) => Object.assign({
  message_id: '<m1@mail>',
  from_name: 'Ken Frattaroli',
  from_address: 'ken@frattaroli.com',
  subject: 'Re: Ocean Drive quote',
  label: 'needs_reply',
  corrected_label: null,
  summary_text: null,
  action_text: null,
  notified_at: null,
  acted_at: null,
}, over || {});

// ---- the junk half he called important -------------------------------------

test('junk can never reach him, and no sender rule can let it', () => {
  const rules = [{ match_kind: 'sender', match_value: 'spam@blast.com', notify: true }];
  const v = shouldNotify(row({ label: 'junk', from_address: 'spam@blast.com' }), rules);
  assert.equal(v.notify, false);
  assert.equal(v.reason, 'junk');
});

test('a receipt is not worth a notification either', () => {
  assert.equal(shouldNotify(row({ label: 'fyi' }), []).notify, false);
});

test('only the three labels that mean he has to do something can notify', () => {
  assert.deepEqual(NOTIFY_LABELS, ['needs_reply', 'needs_scheduling', 'needs_action']);
  for (const label of NOTIFY_LABELS) {
    assert.equal(shouldNotify(row({ label }), []).notify, true, label + ' must be able to notify');
  }
});

test('a correction is what counts, not what the model first guessed', () => {
  // He re-labelled it junk. The original label must not resurrect it.
  const v = shouldNotify(row({ label: 'needs_action', corrected_label: 'junk' }), []);
  assert.equal(v.notify, false);
});

// ---- the learning half -----------------------------------------------------

test('a sender he silenced stays silenced, and it says who', () => {
  const rules = [{ match_kind: 'sender', match_value: 'noreply@portal.com', notify: false }];
  const v = shouldNotify(row({ from_address: 'noreply@portal.com' }), rules);
  assert.equal(v.notify, false);
  assert.match(v.reason, /silenced noreply@portal\.com/);
});

test('silencing a company silences the company', () => {
  const rules = [{ match_kind: 'domain', match_value: 'portal.com', notify: false }];
  assert.equal(shouldNotify(row({ from_address: 'billing@portal.com' }), rules).notify, false);
});

test('one person at a silenced company can still be worth it', () => {
  // The narrower statement is the more specific thing he said, so it wins.
  const rules = [
    { match_kind: 'domain', match_value: 'portal.com', notify: false },
    { match_kind: 'sender', match_value: 'dave@portal.com', notify: true },
  ];
  assert.equal(shouldNotify(row({ from_address: 'dave@portal.com' }), rules).notify, true);
  assert.equal(shouldNotify(row({ from_address: 'robot@portal.com' }), rules).notify, false);
});

test('a sender he has never ruled on DOES reach him', () => {
  // Silent-by-default would mean the first email from a new customer never
  // arrives, which is the exact failure this feature exists to prevent. Being
  // noisy costs him a click; being quiet costs him a job.
  assert.equal(DEFAULT_NOTIFY, true);
  const v = shouldNotify(row({ from_address: 'brand-new@somewhere.com' }), []);
  assert.equal(v.notify, true);
  assert.equal(v.reason, 'new sender');
});

test('the button writes a rule for exactly what he pressed', () => {
  const r = muteRuleFor('owner-1', 'Ken@Frattaroli.com ', 'sender');
  assert.equal(r.match_kind, 'sender');
  assert.equal(r.match_value, 'ken@frattaroli.com', 'normalized, so case cannot make a duplicate rule');
  assert.equal(r.notify, false);
  assert.equal(r.source, 'button', 'a rule he pressed must outrank anything inferred');
  assert.equal(muteRuleFor('owner-1', 'ken@frattaroli.com', 'domain').match_value, 'frattaroli.com');
  assert.equal(muteRuleFor('owner-1', '', 'sender'), null, 'no address, no rule');
});

test('nothing infers silence on its own', () => {
  // The whole module: every notify:false rule carries a source, and 'button' is
  // the only one this file can produce. Reina deciding by herself that he
  // probably does not care is the one failure mode that loses him a job.
  const src = readFileSync(new URL('../api/_lib/reina-notify.js', import.meta.url), 'utf-8');
  assert.ok(!/notify:\s*false[\s\S]{0,200}source:\s*'opened'/.test(src));
  assert.match(src, /source: 'button'/);
});

// ---- sent once, ever -------------------------------------------------------

test('a message interrupts him exactly once', () => {
  assert.equal(shouldNotify(row({ notified_at: '2026-08-19T01:00:00Z' }), []).notify, false);
});

test('something he already dealt with never pings him', () => {
  // He replied from the popup at his desk; the sweep must not then text his
  // laptop about it.
  assert.equal(shouldNotify(row({ acted_at: '2026-08-19T01:00:00Z' }), []).notify, false);
});

// ---- quiet hours -----------------------------------------------------------

test('quiet hours are read in HIS timezone, not the server\'s', () => {
  // A Vercel function runs in UTC. 10pm in Connecticut is 2am UTC, so reading
  // the raw UTC hour would go quiet in the middle of his afternoon.
  const sixAmEastern = new Date('2026-08-19T10:00:00Z');   // 06:00 EDT, 10:00 UTC
  assert.equal(isQuietHour(sixAmEastern, 'America/New_York', 21, 7), true, 'still asleep');
  assert.equal(isQuietHour(sixAmEastern, 'UTC', 21, 7), false,
    'same instant, different zone -- reading the server clock would ping him at 6am');
});

test('the quiet window wraps midnight', () => {
  const zone = 'America/New_York';
  assert.equal(isQuietHour(new Date('2026-08-19T05:00:00Z'), zone, 21, 7), true, '1am is quiet');
  assert.equal(isQuietHour(new Date('2026-08-19T13:00:00Z'), zone, 21, 7), false, '9am is not');
  assert.equal(isQuietHour(new Date('2026-08-19T23:00:00Z'), zone, 21, 7), false, '7pm is not');
});

test('an unknown timezone must not silence him', () => {
  assert.equal(isQuietHour(new Date(), 'Not/AZone', 21, 7), false);
});

test('a sender he marked always-worth-it beats quiet hours', () => {
  const rules = [{ match_kind: 'sender', match_value: 'ken@frattaroli.com', notify: true }];
  const v = shouldNotify(row(), rules, { quiet: true });
  assert.equal(v.notify, true, 'that is what marking a sender always-notify is FOR');
});

test('quiet is a delay, not a drop', () => {
  // notified_at stays null, so the first sweep after the window sends it.
  const v = shouldNotify(row(), [], { quiet: true });
  assert.equal(v.notify, false);
  assert.equal(v.reason, 'quiet hours');
});

// ---- what the toast says ---------------------------------------------------

test('the notification leads with what he has to do', () => {
  const n = notificationFor(row({
    action_text: 'Send Ken the Ocean Drive price, or the date he will have it',
    summary_text: 'Ken is chasing the quote a second time.',
  }), 0);
  assert.equal(n.title, 'Ken Frattaroli — needs a reply');
  assert.match(n.body, /^Send Ken the Ocean Drive price/,
    'the action is the sentence that tells him whether to put the drill down');
});

test('an unread one still says something useful', () => {
  const n = notificationFor(row({ action_text: null, summary_text: null }), 0);
  assert.match(n.body, /Ocean Drive quote/, 'the subject is the fallback');
});

test('a Windows toast truncates, so the body is capped', () => {
  const n = notificationFor(row({ action_text: 'x'.repeat(600) }), 0);
  assert.ok(n.body.length <= 260, 'got ' + n.body.length);
});

test('the queue is visible without opening anything', () => {
  assert.match(notificationFor(row(), 3).body, /\+3 more waiting/);
});

test('one notification per message, so a second sweep cannot stack toasts', () => {
  assert.equal(notificationFor(row(), 0).tag, 'reina-mail-<m1@mail>');
});

test('the toast itself carries the way to teach her', () => {
  const n = notificationFor(row(), 0);
  assert.deepEqual(n.actions.map((a) => a.action), ['open', 'mute']);
  assert.equal(n.actions[1].title, 'Mute sender',
    'asking him to open the app to say it was not worth opening is the joke that writes itself');
});

test('the toast knows which message it is, so opening it lands on that email', () => {
  const n = notificationFor(row({ graph_id: 'G-KEN', home_account_id: 'ms-1' }), 0);
  assert.equal(n.data.messageId, '<m1@mail>');
  assert.equal(n.data.graphId, 'G-KEN');
  assert.equal(n.data.homeAccountId, 'ms-1');
  assert.equal(n.data.fromAddress, 'ken@frattaroli.com', 'and who to silence if he presses that');
});

// ---- small helpers ---------------------------------------------------------

test('domainOf survives the addresses real mail actually carries', () => {
  assert.equal(domainOf('a@b.com'), 'b.com');
  assert.equal(domainOf('weird@sub.b.co.uk'), 'sub.b.co.uk');
  assert.equal(domainOf('a+tag@B.COM'), 'b.com');
  assert.equal(domainOf('no-at-sign'), '');
  assert.equal(domainOf(null), '');
});

test('a malformed rule row cannot crash the sweep', () => {
  const rules = [{}, { match_kind: 'sender' }, { match_value: null }, null];
  assert.equal(matchNotifyRule(rules, 'ken@frattaroli.com'), null);
  assert.equal(shouldNotify(row(), rules).notify, true);
});


// ---- one email, one interruption ------------------------------------------
//
// Chris, 2026-08-23, holding two identical Windows toasts: "they dont ever go
// away?" Two of them, because Gusto sends the payroll reminder to more than
// one of his mailboxes. Both rows were real, both were judged correctly, and
// they carried different Graph ids -- so the push tag, which is built from
// message_id, could not collapse them and neither could Chrome.
//
// Identity has to be what a person would use: who sent it, and what the
// subject says.

test('the same email in two mailboxes is one email', () => {
  const groups = collapseDuplicates([
    { message_id: 'AAQkAGRmODBhMDc2', from_address: 'automated@gusto.com', subject: 'Time to run payroll for GH Electrical Solutions LLC' },
    { message_id: 'AAQkAGQxY2U1ZTUw', from_address: 'automated@gusto.com', subject: 'Time to run payroll for GH Electrical Solutions LLC' },
  ]);
  assert.equal(groups.length, 1, 'one interruption, not two');
  assert.equal(groups[0].row.message_id, 'AAQkAGRmODBhMDc2', 'the first copy is the one that speaks');
  assert.deepEqual(groups[0].duplicates.map((r) => r.message_id), ['AAQkAGQxY2U1ZTUw'],
    'the other copy is kept, because it still has to be stamped as notified');
});

test('the same message stored under a Graph id and an RFC822 id is still one', () => {
  // The second ingest path files it again under its internet Message-ID.
  const groups = collapseDuplicates([
    { message_id: 'AAQkAGRmODBhMDc2', from_address: 'automated@gusto.com', subject: 'Time to run payroll' },
    { message_id: '<6a8ade155643e_c5126dc0178951@worker.mail>', from_address: 'automated@gusto.com', subject: 'Time to run payroll' },
  ]);
  assert.equal(groups.length, 1);
});

test('a reply is the same conversation, not a fresh interruption', () => {
  assert.equal(
    mailIdentity({ from_address: 'sam@vendor.com', subject: 'Re: the quote' }),
    mailIdentity({ from_address: 'Sam@Vendor.com', subject: 'the quote' }),
    'prefix and case are noise');
  assert.equal(
    mailIdentity({ from_address: 'sam@vendor.com', subject: 'FWD:  the   quote ' }),
    mailIdentity({ from_address: 'sam@vendor.com', subject: 'the quote' }));
});

test('two different people writing the same subject stay two emails', () => {
  const groups = collapseDuplicates([
    { message_id: '1', from_address: 'sam@vendor.com', subject: 'invoice' },
    { message_id: '2', from_address: 'pat@other.com', subject: 'invoice' },
  ]);
  assert.equal(groups.length, 2, 'the sender is half the identity');
});

test('one person sending two different things stays two emails', () => {
  const groups = collapseDuplicates([
    { message_id: '1', from_address: 'sam@vendor.com', subject: 'invoice' },
    { message_id: '2', from_address: 'sam@vendor.com', subject: 'schedule' },
  ]);
  assert.equal(groups.length, 2);
});

test('rows with no sender and no subject never collapse into each other', () => {
  // Collapsing "unknown" into one bucket would silence unrelated mail, which
  // is the one failure this feature must not have.
  const groups = collapseDuplicates([
    { message_id: 'a', from_address: '', subject: '' },
    { message_id: 'b', from_address: '', subject: '' },
  ]);
  assert.equal(groups.length, 2);
});

test('identity is deterministic', () => {
  // It has to be: an identity that changes between two calls would collapse
  // nothing, and would do it invisibly.
  const row = { message_id: '', from_address: '', subject: '' };
  assert.equal(mailIdentity(row), mailIdentity(row));
});

test('collapse tolerates being handed nothing', () => {
  assert.deepEqual(collapseDuplicates(null), []);
  assert.deepEqual(collapseDuplicates([]), []);
});

// ---- the buttons ----------------------------------------------------------

test('the mute button says what it does', () => {
  // "Not this sender" was the old label, and Chris asked what it did. A button
  // whose effect has to be explained is a button nobody presses.
  const payload = notificationFor({ message_id: 'x', from_address: 'a@b.com', subject: 's', label: 'needs_action' }, 0);
  const mute = payload.actions.find((a) => a.action === 'mute');
  assert.equal(mute.title, 'Mute sender');
  assert.equal(payload.actions.length, 2, 'Chrome on Windows renders at most two');
});

// ---- which channel, not whether to listen at all ---------------------------
//
// Chris, 2026-08-23: "just notifications on the bottom of hivelogic not
// windows." The in-app nudge and the Windows toast are separate channels, and
// the obvious way to get one without the other is a trap:
//
// "Turn off" DELETED the push subscription, and mail-sweep picks the owners it
// scans from that very table. No row, no sweep; no sweep, no mailbox read; no
// mailbox read, and the in-app nudge quietly stops finding new mail. He would
// have switched off the thing he wanted to keep in order to switch off the
// thing he wanted rid of.

test('desktop toasts are on until he says otherwise', () => {
  assert.equal(desktopPushEnabled([]), true);
  assert.equal(desktopPushEnabled(null), true);
  assert.equal(desktopPushEnabled([{ match_kind: 'sender', match_value: 'a@b.com', notify: false }]), true,
    'silencing a sender is not silencing the channel');
});

test('an explicit no turns them off, and only an explicit no', () => {
  assert.equal(desktopPushEnabled([{ match_kind: 'channel', match_value: 'desktop', notify: false }]), false);
  assert.equal(desktopPushEnabled([{ match_kind: 'channel', match_value: 'desktop', notify: true }]), true);
  assert.equal(desktopPushEnabled([{ match_kind: 'channel', match_value: 'DESKTOP', notify: false }]), false,
    'case is not a way to lose a preference');
});

test('the channel row cannot be mistaken for a sender rule', () => {
  // matchNotifyRule only ever reads 'sender' and 'domain'. If a channel row
  // could match a sender, turning off desktop toasts would silence somebody.
  const rules = [{ match_kind: 'channel', match_value: 'desktop', notify: false }];
  assert.equal(matchNotifyRule(rules, 'desktop'), null);
  assert.equal(matchNotifyRule(rules, 'anyone@anywhere.com'), null);
});

test('the stored row says what it is and where it came from', () => {
  const row = desktopChannelRule('owner-1', false);
  assert.equal(row.owner_id, 'owner-1');
  assert.equal(row.match_kind, 'channel');
  assert.equal(row.match_value, 'desktop');
  assert.equal(row.notify, false);
  assert.equal(row.source, 'button', 'he pressed it; nothing here is inferred');
  assert.equal(desktopChannelRule('owner-1', true).notify, true);
});

// test/hiveconnect-email-triage.test.mjs
//
// Reina lives in the reading pane now.
//
// Chris, 2026-08-18: "I dont want the all mail and reina buttons. I want a
// standard inbox and when you click the email on the list, it populates the big
// preview screen. in the preview it shows a reina summary of the email and a
// suggested action or response. below would be the actual email."
//
// That is the third shape this has taken, each less of a destination than the
// last: a page in the HiveLogic sidebar, then a pill inside the mail app, now
// nothing you have to go to at all. These tests hold the two things that would
// silently regress:
//
//   1. THE SECOND LIST STAYS GONE. Every previous shape left something behind --
//      a hidden Focused filter that stranded the Inbox on half of Microsoft's
//      mail, a sidebar route, a pill. Removing the visible control while leaving
//      the mode behind is the failure mode with a track record here.
//   2. NOTHING IS SILENTLY ABSENT. A panel that renders empty on failure is
//      indistinguishable from an email Reina had nothing to say about, and the
//      email body must never wait on a model call.
//
// These are source-shape tests rather than behavioural ones, because app.js is a
// 300KB module-scoped script with no seam to import. That is a real limit and
// worth naming: they hold structure, not rendering, which needs a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf-8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
const css = readFileSync(new URL('../public/hiveconnect/styles-scoped.css', import.meta.url), 'utf-8');
const hcIndex = readFileSync(new URL('../public/hiveconnect/index.html', import.meta.url), 'utf-8');
const triage = readFileSync(new URL('../api/reina/mail-triage.js', import.meta.url), 'utf-8');
const triageLib = readFileSync(new URL('../api/_lib/mail-triage.js', import.meta.url), 'utf-8');

// The Reina block, with comments stripped — these tests must never read the
// prose explaining why something was removed as evidence that it is still here.
function readingPane() {
  const i = app.indexOf('function renderReadingPane(');
  const j = app.indexOf('\nfunction ', app.indexOf('read.appendChild(frame)'));
  return app.slice(i, j);
}

const reina = app.slice(app.indexOf('/* ===== Reina, in the preview pane ='), app.indexOf('function evFmtDate('));
const code = reina.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---- one inbox, one mode ----------------------------------------------------

test('the All mail / Reina pills are gone, and so is the mode behind them', () => {
  assert.ok(!/'⚡ Reina'/.test(app), 'the pill must not render');
  assert.ok(!/\['all', 'All mail'\]/.test(app));
  // The control going while the state stays is exactly how the Focused filter
  // survived its own removal and stranded the Inbox on half the mail.
  assert.ok(!/\bevFocus\b/.test(app), 'and the mode variable with it');
  assert.ok(!/renderFocusPills/.test(app), 'and the thing that drew it');
});

test("Microsoft's Focused/Other filter is still gone too", () => {
  assert.ok(!/inferenceClassification eq/.test(app),
    'leaving this filter would strand the Inbox on Focused forever, with no control left to change it');
});

test('selecting the Inbox is one code path, not a branch on which mode you are in', () => {
  const sel = app.slice(app.indexOf('async function selectFolder('), app.indexOf('/* The Inbox is the Inbox.'));
  assert.ok(!/evLoadTriage|evFocus/.test(sel), 'the inbox is the inbox');
  assert.match(sel, /mailFolders\/\$\{id\}\/messages/);
});

test('the HiveLogic sidebar page is still gone -- two ways in is how "which is real?" starts', () => {
  assert.ok(!index.includes('nav-mailtri'), 'the sidebar nav item must stay removed');
  assert.ok(!index.includes('view-mailtri'), 'and its view');
  assert.ok(!index.includes('mailTriLoad'), 'and its script');
});

test('the CSS for the list that no longer exists went with it', () => {
  for (const dead of ['ev-triage-acts', 'ev-triage-pick', 'ev-triage-draft', 'ev-focus-pill']) {
    assert.ok(!css.includes(dead), dead + ' styles a row that cannot be rendered any more');
  }
});

// ---- the brief, in the preview pane -----------------------------------------

test('opening a message renders Reina above the email, not instead of it', () => {
  const pane = readingPane();
  const headAt = pane.indexOf('read.appendChild(head)');
  const briefAt = pane.indexOf('evReinaBrief(m, brief)');
  const frameAt = pane.indexOf('read.appendChild(frame)');
  assert.ok(headAt !== -1 && briefAt !== -1 && frameAt !== -1, 'sanity: all three are in the pane');
  assert.ok(headAt < briefAt && briefAt < frameAt,
    'summary and action above, the actual email below — that was the whole request');
});

test('the email body never waits on a model call', () => {
  const pane = readingPane();
  // Not awaited: the panel fills itself in when the read comes back.
  assert.ok(!/await evReinaBrief/.test(pane), 'the message must render immediately');
  assert.match(pane, /const brief = document\.createElement\('div'\); brief\.className = 'ev-reina-brief'/);
});

test('the panel says what it is doing, and says when it could not', () => {
  const block = code.slice(code.indexOf('async function evReinaBrief('));
  assert.match(block.slice(0, 2200), /Reina is reading it…/, 'a blank panel reads as "nothing to say"');
  assert.match(block.slice(0, 2200), /couldn\\'t read this one/, 'and a failure is never silent');
});

test('a brief that lands after he clicked away is dropped, not painted over the wrong email', () => {
  const block = code.slice(code.indexOf('async function evReinaBrief('));
  assert.match(block.slice(0, 2200), /if \(evOpenId !== m\.id\) return/,
    'the summary of the previous email under the current one is worse than no summary');
});

test('a brief is fetched once per message, then reused', () => {
  assert.match(code, /const evBriefCache = new Map\(\)/);
  const block = code.slice(code.indexOf('async function evReinaBrief('));
  assert.match(block.slice(0, 1200), /evBriefCache\.get\(messageId\)/, 'checked before the round trip');
  assert.match(block.slice(0, 2200), /evBriefCache\.set\(messageId, d\)/);
});

test('the panel shows the summary, the action, and the suggested reply', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /ev-rb-summary/);
  assert.match(block, /ev-rb-action/);
  assert.match(block, /ev-rb-draft-body/);
  assert.match(block, /'Suggested reply'/, 'labelled as a suggestion, so it never reads as something sent');
});

test('a draft with an unfilled blank says so where he is reading', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /Fill in the blanks before sending/);
  assert.match(block, /if \(d\.hasBlanks\)/, 'a toast that vanishes is not good enough for this one');
});

// ---- the actions ------------------------------------------------------------

test('every mailbox write in the Reina block is a MOVE, and there are only two', () => {
  // Moving the wrong message is recoverable from the folder it moved to.
  // Deleting one is not, which is why nothing here deletes.
  // Only evGraph reaches a mailbox — the block's other POSTs go to our own API
  // (the triage route and the task bridge), which cannot touch mail at all.
  const mailboxWrites = [...code.matchAll(/evGraph\([\s\S]{0,220}?method: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(mailboxWrites, ['POST', 'POST'],
    `expected two mailbox writes (Archive and Junk), found ${JSON.stringify(mailboxWrites)}`);
  const dests = [...code.matchAll(/destinationId: '(\w+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(dests, ['archive', 'junkemail'], 'both are moves to a folder he can open');
  for (const verb of ['evDelete(', "method: 'DELETE'", 'sendMail', 'deleteditems']) {
    assert.ok(!code.includes(verb), `${verb} does not belong anywhere in triage`);
  }
});

test('replying opens the mail app\'s OWN composer -- it never sends', () => {
  const block = code.slice(code.indexOf('async function evTriageDraft('));
  assert.match(block.slice(0, 800), /openEmailCompose\('reply', src\)/);
  assert.ok(!/sendMail|evSend\(/.test(block.slice(0, 800)), 'the send button stays his');
});

test('the draft is written into the composer the way the composer reads it', () => {
  // #ev-c-body is a contenteditable DIV: openEmailCompose fills it with
  // innerHTML and evSend reads innerHTML back. Assigning .value on a div
  // creates a property nothing reads — the draft lands nowhere. Seen live.
  assert.match(hcIndex, /id="ev-c-body"[^>]*contenteditable/, 'sanity: it is a div, not a textarea');
  assert.ok(!/bodyEl\.value\s*=/.test(code), 'a draft assigned to .value is a draft thrown away');
  assert.match(code, /bodyEl\.innerHTML = evDraftToHtml\(text\) \+ bodyEl\.innerHTML/,
    'and it goes ABOVE the signature and the quoted original, where a reply is written');
});

test('scheduling opens the calendar composer prefilled -- it books nothing', () => {
  const block = code.slice(code.indexOf('function evTriageSchedule('));
  assert.match(block.slice(0, 600), /openCalNew\(/);
  assert.ok(!/createEvent|\/me\/events/.test(block.slice(0, 600)), 'only he knows whether Thursday is free');
});

test('a task is created through the bridge, owned by him', () => {
  const block = code.slice(code.indexOf('async function evTriageTask('));
  assert.match(block.slice(0, 1400), /hiveconnect-bridge\?action=task_create/);
});

test('a message is marked handled only AFTER the thing actually worked', () => {
  const block = code.slice(code.indexOf('async function evTriageActed('));
  const body = block.slice(0, 700);
  assert.ok(body.indexOf("evTriageApi('act'") < body.indexOf('if (note)'),
    'marking it done first and failing second is how a to-do list starts lying');
});

test('the actions offered match what Reina said it wants', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /act\(EV_RB_ICON\.reply, 'Use this reply'/);
  assert.match(block, /if \(d\.label === 'needs_scheduling'\) act\(EV_RB_ICON\.calendar/);
  // Archive goes through Graph, which an IMAP mailbox does not have.
  assert.match(block, /\} else if \(!evTriageIsImap\(r\)\) \{\s*\n\s*act\(EV_RB_ICON\.archive/,
    'a button that silently cannot work is worse than no button');
});

test('the buttons speak the toolbar\'s language, not emoji', () => {
  // This panel sits an inch under a row of stroked line icons. Chris,
  // 2026-08-18: "the text and buttons are shitty looking."
  const block = code.slice(code.indexOf('function evRenderBrief('), code.indexOf('const EV_RB_SVG'));
  assert.ok(!/act\('[^']*[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(block),
    'no emoji in the button row');
  assert.match(code, /const EV_RB_SVG = \(d\) =>[^\n]*stroke-width="1.7"/,
    'same stroke and box as the reading-pane toolbar above it');
  assert.match(block, /'primary'/, 'and one button is the obvious one to press');
});

// ---- spam ------------------------------------------------------------------
// Chris, 2026-08-18: "for spam... can you have a way to auto-unsubscribe or just
// push to junk only?"

test('junk goes to Junk, not to Archive', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /if \(d\.label === 'junk'\)/);
  assert.match(block, /act\(EV_RB_ICON\.junk, 'Move to Junk'/);
  const junkFn = code.slice(code.indexOf('async function evTriageJunk('));
  assert.match(junkFn.slice(0, 900), /destinationId: 'junkemail'/,
    'Archive hides it and teaches nothing; Junk trains the provider filter');
});

test('junk is not offered a to-do', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /if \(d\.label !== 'junk'\) act\(EV_RB_ICON\.task/,
    '"add this cold pitch to my tasks" is not a thing he wants offered');
});

test('one-click unsubscribe is offered only where the sender promised it', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /if \(d\.unsubscribe && d\.unsubscribe\.oneClick\)/);
  // Everything else opens THEIR page, because on real spam a click is a signal
  // that the address is live and read.
  assert.match(block, /else if \(d\.unsubscribe && \(d\.unsubscribe\.web \|\| d\.unsubscribe\.mailto\)\)/);
  const fn = code.slice(code.indexOf('async function evUnsubscribe('));
  assert.match(fn.slice(0, 1400), /window\.open\(u\.web/, 'the non-promised case is his click, on their page');
});

test('unsubscribing also gets the message out of the inbox', () => {
  const fn = code.slice(code.indexOf('async function evUnsubscribe('));
  assert.match(fn.slice(0, 1400), /await evTriageJunk\(r, null\)/,
    'leaving the list does not remove the one already sitting there');
});

test('a correction to junk drops the reply that was written for it', () => {
  const block = code.slice(code.indexOf('sel.onchange = async () => {'));
  assert.match(block.slice(0, 900), /if \(picked === 'junk' \|\| picked === 'fyi'\) d\.draft = null/,
    'a suggested reply to a cold pitch is one tap from answering it');
});

// Chris, 2026-08-18: "move to junk didn't work / unsubscribe didnt work."
// They did work. The Graph move went out and the mail moved — and nothing on
// screen changed, because these actions only refreshed the folder counts. The
// row stayed in the list, the message stayed open, and the panel still offered
// to file it again. That is indistinguishable from a dead button.

test('filing a message makes it leave the screen, not just the mailbox', () => {
  assert.match(code, /function evTriageFiled\(r, note\)/);
  const fn = code.slice(code.indexOf('function evTriageFiled('));
  assert.match(fn.slice(0, 900), /evMessages = evMessages\.filter\(\(x\) => x\.id !== r\.graph_id\)/, 'out of the list');
  assert.match(fn.slice(0, 900), /if \(evOpenId === r\.graph_id\)/, 'out of the reading pane');
  assert.match(fn.slice(0, 900), /renderMessageList\(\)/);
  assert.match(fn.slice(0, 900), /evBriefCache\.delete\(r\.message_id\)/,
    'and forgotten, so a re-open cannot resurrect a panel for mail that is gone');
});

test('both filing actions use it', () => {
  for (const fn of ['evTriageJunk', 'evTriageArchive']) {
    const block = code.slice(code.indexOf('async function ' + fn + '('));
    assert.match(block.slice(0, 1000), /evTriageFiled\(r, '/, fn + ' must clear the screen');
  }
});

test('a failed file says why, instead of a shrug', () => {
  // "Couldn't archive that." was the whole message. The difference between
  // "try again" and "tell Claude" is in the reason.
  const block = code.slice(code.indexOf('async function evTriageArchive('));
  assert.match(block.slice(0, 1100), /Couldn\\'t archive that — ' \+ e\.message/);
});

test('Handled changes the panel, because the email deliberately does not move', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /if \(d\.handled\)/);
  assert.match(block, /ev-rb-handled/);
  assert.match(block, /d\.handled = true; evRenderBrief\(host, m, d, acct\)/,
    'the one action that leaves the mail in place needs the panel to be what changes');
});

// Chris, 2026-08-18: "Comms notifications should popup on every screen in
// hivelogic and allow you to click it and pull up a quick action window so you
// can remain on your current task."
const notify = index.slice(index.indexOf('var POLL_MS'),
                           index.indexOf('// --- Browser-close auto-clockout'));

test('the popup lives in HiveLogic itself, so it is on every screen', () => {
  assert.ok(notify, 'sanity: the notification block exists');
  assert.match(notify, /position:fixed/, 'it floats over whatever he is doing');
  assert.match(notify, /api\('pending'\)/, 'and it reads what triage already wrote');
});

test('it never interrupts for junk or a receipt', () => {
  // Enforced server-side too; this is the half he would actually see. What makes
  // it true is the label table: a nudge is only ever built from one of these,
  // and junk and fyi are not among them.
  const labels = notify.slice(notify.indexOf('var LABELS = {'), notify.indexOf('function repliable('));
  assert.match(labels, /needs_reply: \{ name: 'Reply'/);
  assert.match(labels, /needs_scheduling:/);
  assert.match(labels, /needs_action:/);
  assert.ok(!/junk/.test(labels) && !/fyi/.test(labels),
    'a popup that fires for a receipt is one he learns to dismiss without reading');
});

test('one item interrupts him exactly once, and the rest queue visibly', () => {
  assert.match(notify, /if \(seen\[it\.id\]\) return;/, 'seen ids are not re-shown');
  assert.match(notify, /\+' \+ moreCount \+ ' more'/, 'the queue is visible on the nudge');
  assert.match(notify, /more waiting/, 'and named in the panel');
});

/* Chris, 2026-08-19, on the first real day of it:
   "im getting a bunch of email notifications" */

test('a backlog is a to-do list, not a notification', () => {
  // There were 66 open actionable rows the morning he said this. The old code
  // queued every one of them and auto-advanced on silence, so three days of mail
  // came at him as a half-hour conveyor belt. A nudge is for what just ARRIVED.
  assert.match(notify, /var FRESH_MS = /, 'there is a line between news and backlog');
  assert.match(notify, /if \(firstPoll && age > FRESH_MS\) return;/,
    'on the first poll of a session, old mail is marked seen without making a sound');
  assert.match(notify, /firstPoll = false;/, 'and only the first poll works that way');
});

test('silencing one thing does not summon the next', () => {
  const nudge = notify.slice(notify.indexOf('function showNudge('), notify.indexOf('function openPanel('));
  const shh = nudge.slice(nudge.indexOf('shh.onclick'));
  assert.ok(!/next\(\)/.test(shh.slice(0, 200)),
    'waving one away is not asking for the whole backlog');
  // Auto-hide is the same decision made for him: out of the way, not on to the next.
  assert.match(notify, /hideTimer = setTimeout\(closeNudge, AUTO_HIDE_MS\)/);
  // Working THROUGH them is different — that is him choosing to keep going.
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /function done\(\) \{\s*closePanel\(\);\s*next\(\);/);
});

test('the same blast to two mailboxes is one notification', () => {
  assert.match(notify, /function dedupeKey\(it\)/);
  assert.match(notify, /if \(byKey\[k\]\) return;/);
});

/* "the summary is confusing and not very informative" — 40 of those 66 rows had
   no summary at all. The batch pass labels everything; it only WRITES a summary
   once something opens the message. So the panel was showing a bare sender and
   subject and calling it a brief. */

test('an unread one gets read when the panel opens, and says so while it waits', () => {
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /if \(!item\.summary\)/, 'only when there is nothing to show');
  assert.match(panel, /Reina is reading it…/, 'and it says what it is doing');
  assert.match(panel, /api\('brief', \{/);
  assert.match(panel, /if \(!document\.body\.contains\(p\)\) return;/,
    'if he moved on before it came back, it must not paint over whatever is there now');
});

/* Chris, 2026-08-19, looking at the panel: "is way too much to read." */

test('the panel leads with what to do, not with a paragraph', () => {
  const panel = notify.slice(notify.indexOf('function openPanel('));
  // Order in the DOM is the order he reads it in.
  const act = panel.indexOf("p.appendChild(actBox)");
  const sum = panel.indexOf("p.appendChild(sumBox)");
  assert.ok(act > 0 && sum > act, 'the action comes before the background, not after it');
  // The action carries the weight; the summary is support.
  assert.match(notify, /#rn-panel \.rn-act\{[^}]*font:700 15px/, 'the action is the biggest thing');
  assert.match(notify, /#rn-panel \.rn-body\{[^}]*font:400 12\.5px/, 'the summary is smaller');
  assert.match(notify, /#rn-panel \.rn-body\{[^}]*color:#7a8699/, 'and quieter');
  // Two lines, and the rest only if he asks for it.
  assert.match(notify, /#rn-panel \.rn-body\{[^}]*-webkit-line-clamp:2/);
  assert.match(panel, /moreBtn\.style\.display = \(item\.summary && sumBox\.scrollHeight > sumBox\.clientHeight/,
    'and the "why" toggle only appears when something is actually clamped off');
});

test('Reina is told to write one sentence, not a paragraph', () => {
  const brief = triageLib.slice(triageLib.indexOf('SUMMARY.'), triageLib.indexOf('ACTION.'));
  assert.match(brief, /ONE sentence/);
  assert.match(brief, /reads[\s\S]{0,40}standing up/, 'the reason, so it does not get softened back later');
  // The things that must survive the shortening.
  assert.match(brief, /\$4,329\.80/, 'exact numbers still matter more than brevity');
});

test('a mailbox Reina cannot reach from here says so, instead of spinning', () => {
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /if \(isImap\) \{[\s\S]{0,200}can only be opened there/,
    'an IMAP body can only be fetched by the browser inside HiveConnect');
});

/* "limited options, send recommended response only no option to edit it" — it
   WAS editable. The focus ring was on the wrapper, which is not the focusable
   element, so clicking in changed nothing on screen and it read as dead text. */

test('the reply box looks like a box he can type in', () => {
  assert.match(notify, /#rn-panel \.rn-edit\{[^}]*cursor:text/, 'a text cursor');
  assert.match(notify, /#rn-panel \.rn-edit:focus\{/, 'a focus ring on the EDITABLE element');
  assert.ok(!/\.rn-draft:focus/.test(notify),
    'not on the wrapper, which can never take focus and so never showed anything');
  assert.match(notify, /rn-edit:empty:before\{content:attr\(data-ph\)/, 'and a placeholder when it is empty');
});

test('he can have Reina write it a different way', () => {
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /addPill\('Shorter'/);
  assert.match(panel, /addPill\('Warmer'/);
  assert.match(panel, /addPill\('Firmer'/);
  assert.match(panel, /addPill\('Say what to change…', null\)/, 'and an open-ended one');
  assert.match(panel, /previous: \(draftBox\.innerText \|\| ''\)/,
    '"shorter" has to mean shorter than the one he is looking at, edits included');
});

test('a needs-reply with no draft still gets a box to type in', () => {
  // Before, no draft meant no reply box and no Send button at all — on mail
  // whose whole point was that someone is waiting on an answer.
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /draftLbl\.textContent = item\.draft \? "Reina's reply · edit it before sending" : 'Your reply'/);
  assert.match(panel, /data-ph', 'Type your reply…'/);
});

/* "when I clicked to open in email, it took me to the inbox, not the actual
   email i tried to open" */

test('open in email opens the message, not just the tab', () => {
  assert.match(notify, /function openInEmail\(item\)/);
  assert.match(notify, /window\.hlOpenEmailMessage\(item\.graphId, item\.homeAccountId\)/,
    'hlRoloHC opens the TAB; opening the MESSAGE is a second thing');
  assert.match(notify, /setInterval\(/, 'HiveConnect mounts async, so wait for the hook');
  assert.match(notify, /\+\+tries > 75/, 'but not forever — give up on the inbox');
});

test('HiveConnect exposes that hook, and switches mailbox before using it', () => {
  const hook = app.slice(app.indexOf('window.hlOpenEmailMessage ='));
  assert.ok(hook, 'index.html cannot reach into an ES module without one');
  assert.match(hook.slice(0, 600), /evAccounts\.find\(x => x\.homeAccountId === homeAccountId\)/);
  assert.match(hook.slice(0, 600), /evActive = a;[\s\S]{0,80}else return false/,
    'every mailbox call reads evActive for its token — the wrong one fetches an id it has never heard of');
  assert.match(hook.slice(0, 600), /await openEmailMessage\(graphId\)/);
});

test('pending carries what the panel needs to act without a second round trip', () => {
  assert.match(triage, /draft_text,web_link,unsubscribe/, 'including whether unsubscribe is even possible');
  assert.match(triage, /unsubscribe: row\.unsubscribe \|\| null,/);
});

test('the popup never files mail', () => {
  // It can reply and it can make a task — both things he asked to do without
  // leaving the page. What it must not do is MOVE anything. Filing belongs on a
  // message he is looking at, in the mail app, where he can see where it went.
  assert.match(notify, /action: 'dismissed'/, 'Handled clears it off the Team To-Do');
  for (const verb of ['/move', 'destinationId']) {
    assert.ok(!notify.includes(verb), verb + ' does not belong in a popup');
  }
});

/* Chris, 2026-08-18: "I'm deep into a 100K kitchen reno, and an email comes
   through about a payment... A pop-up should notify me discreetly enough that it
   doesn't swallow up the whole screen... Now here is the critical part.... I
   don't want to leave the estimate screen! I need to be able click the
   notification to silence it or if I need to act now, it opens a new popup with
   quick actions."

   The first version was one card that dumped the summary, the action, the whole
   draft and three buttons on screen the moment mail landed. That is not a
   notification, it is an interruption with a form attached. */

test('the nudge is small, and says who / what / how urgent — nothing else', () => {
  const nudge = notify.slice(notify.indexOf('function showNudge('), notify.indexOf('function openPanel('));
  assert.match(nudge, /rn-who/, 'who it is from');
  assert.match(nudge, /rn-what/, 'what it is about');
  assert.match(nudge, /rn-tag/, 'and how urgent');
  // The heavy content belongs to stage 2 only.
  for (const heavy of ['rn-draft', 'contentEditable', 'Send reply', 'Add to tasks']) {
    assert.ok(!nudge.includes(heavy), heavy + ' does not belong in a notification');
  }
  assert.match(notify, /#rn-nudge\{[^}]*width:308px/, 'and it stays small');
});

test('one click silences it, one click opens the actions', () => {
  const nudge = notify.slice(notify.indexOf('function showNudge('), notify.indexOf('function openPanel('));
  assert.match(nudge, /mid\.onclick = function \(\) \{ clearHide\(\); openPanel\(item, moreCount\); \}/);
  assert.match(nudge, /shh\.onclick/, 'and a dedicated silence control');
  // Silenced is not handled — it stays on the Team To-Do, it just stops talking.
  const shh = nudge.slice(nudge.indexOf('shh.onclick'));
  assert.ok(!/api\('act'/.test(shh.slice(0, 300)), 'silencing must not mark it dealt with');
});

test('nothing in either stage navigates away from what he was doing', () => {
  // The estimate underneath has to be sitting there untouched.
  assert.ok(!/location\.hash\s*=/.test(notify), 'no navigation');
  assert.ok(!/location\.href\s*=/.test(notify));
  assert.ok(!/window\.location\.reload/.test(notify));
  // The one exception is a link he clicks on purpose, and it is labelled.
  assert.match(notify, /'Open in email'/);
  assert.match(notify, /window\.hlRoloHC\('email'\)/, 'and it opens the EMAIL tab, not HiveConnect\'s default');
});

test('the action panel closes back to the page, three different ways', () => {
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /if \(e\.target === back\)/, 'clicking away');
  assert.match(panel, /x\.onclick = function \(\) \{ closePanel\(\)/, 'the close button');
  assert.match(panel, /e\.key === 'Escape'/, 'and escape, because his hands are on the keyboard');
});

test('he can act entirely inside the panel', () => {
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /contentEditable = 'true'/, "Reina's reply is editable");
  assert.match(panel, /draftBox\.innerText/, 'and what he edited is what gets sent');
  assert.match(panel, /'Send reply'/);
  assert.match(panel, /'Add to tasks'/);
  assert.match(panel, /function repliable\(|canReply = repliable\(item\)/,
    'what gets a Send button is decided in one place');
  const repl = notify.slice(notify.indexOf('function repliable('));
  assert.match(repl.slice(0, 260), /indexOf\('imap:'\) !== 0/,
    'an IMAP mailbox cannot be sent from here, so it is not offered a button that fails');
});

test('a new email never interrupts one he is already dealing with', () => {
  assert.match(notify, /if \(!current && !document\.getElementById\('rn-panel-back'\)\) next\(\)/);
});

test('the nudge leaves on its own', () => {
  assert.match(notify, /AUTO_HIDE_MS/);
  assert.match(notify, /addEventListener\('mouseenter', clearHide\)/, 'unless he is reading it');
});

test('unsubscribing is a deliberate click, never something the nudge can do', () => {
  // Chris, 2026-08-19: "needs to have more options." Unsubscribe is one of them,
  // and it is the one that reaches OUT — a POST to a stranger's server on his
  // behalf. So it is fenced three ways: only in stage 2, which he opened on
  // purpose with the sender and subject in front of him; only when that sender
  // actually advertised one-click, because a button that silently does nothing
  // is worse than no button; and never on the nudge, which auto-hides.
  const nudge = notify.slice(notify.indexOf('function showNudge('), notify.indexOf('function openPanel('));
  assert.ok(!nudge.includes('unsubscribe'), 'a toast that auto-hides must not reach out to anyone');
  const panel = notify.slice(notify.indexOf('function openPanel('));
  assert.match(panel, /if \(item\.unsubscribe && item\.unsubscribe\.oneClick\)/,
    'offered only when the sender advertised one-click');
  assert.match(panel, /api\('unsubscribe', \{ messageId: item\.id \}\)/);
});

// Chris, 2026-08-18: "I also want reina to silence junk and only show real
// emails that need attention."

test('junk is hidden from the inbox, not deleted and not moved', () => {
  assert.match(app, /let evHideJunk = true/);
  assert.match(app, /function evVisibleMessages\(\)/);
  const fn = app.slice(app.indexOf('function evNoteJunk('));
  assert.match(fn.slice(0, 600), /evJunkIds\.add\(r\.graph_id\)/);
  assert.ok(!/evNoteJunk[\s\S]{0,600}(destinationId|DELETE)/.test(fn), 'hiding is not filing');
});

test('the hidden ones are counted and one click away', () => {
  // Silently swallowing mail is how a filter stops being trusted the first
  // time it is wrong — and Reina is wrong sometimes.
  assert.match(app, /hidden as junk/);
  assert.match(app, /evHideJunk = false; renderMessageList\(\)/);
  assert.match(app, /hide it again/);
});

test('only mail she has actually judged is hidden', () => {
  const fn = app.slice(app.indexOf('function evVisibleMessages('));
  assert.match(fn.slice(0, 400), /evJunkIds\.has\(m\.id\)/,
    '"not yet read by Reina" is not the same as "junk"');
});

test('correcting a label un-hides it immediately', () => {
  const block = code.slice(code.indexOf('sel.onchange = async () => {'));
  assert.match(block.slice(0, 1200), /evNoteJunk\(\[\{ graph_id: r\.graph_id, corrected_label: picked \}\]\)/);
});

// ---- reading ahead ----------------------------------------------------------
// Chris, 2026-08-18: "it was slow to populate."

test('the top of the list is read before he clicks it', () => {
  const sel = app.slice(app.indexOf('async function selectFolder('), app.indexOf('/* The Inbox is the Inbox.'));
  assert.match(sel, /renderMessageList\(\);\s*\n\s*evPrefetchBriefs\(\)/,
    'after the list is painted, never before');
  const fn = code.slice(code.indexOf('async function evPrefetchBriefs('));
  assert.match(fn.slice(0, 2400), /EV_BRIEF_PREFETCH/, 'bounded — reading fifty he will never open is spending for nothing');
  assert.match(fn.slice(0, 2400), /if \(mine !== evPrefetchToken\) return/,
    'and it stops when the list changes underneath it');
  assert.match(fn.slice(0, 2400), /evBriefCache\.has\(key\)/, 'never re-reads one it already has');
});

test('a prefetch that lands on the message he is staring at paints it', () => {
  const fn = code.slice(code.indexOf('async function evPrefetchBriefs('));
  assert.match(fn.slice(0, 3000), /if \(evOpenId === m\.id\)/);
  assert.match(fn.slice(0, 3000), /querySelector\('\.ev-rb-load'\)/,
    'rather than leaving him on the loading line with the answer in hand');
});

test('every action runs against the message\'s OWN mailbox', () => {
  // Reply, archive and the reading pane all key off evActive. With three
  // mailboxes connected, taking whichever happened to be selected sends from
  // the wrong address and moves mail in the wrong inbox.
  assert.match(code, /function evTriageAccountFor\(r\)/);
  const draft = code.slice(code.indexOf('async function evTriageDraft('));
  assert.match(draft.slice(0, 800), /if \(acct\) evActive = acct/);
  const arch = code.slice(code.indexOf('async function evTriageArchive('));
  assert.match(arch.slice(0, 800), /account: acct \|\| undefined/);
});

test('a cached list row is never trusted for a body -- it has none', () => {
  // Graph's list $select omits the body and an IMAP envelope list has no
  // preview at all. A cache hit here handed the drafter an empty string.
  const block = code.slice(code.indexOf('async function evTriageFullMessage('));
  assert.match(block.slice(0, 900), /cached && cached\.body && cached\.body\.content \? cached : null/);
  assert.match(block.slice(0, 900), /\$select=[^']*body/);
});

test('a correction repaints the panel, so the chip and the buttons follow the label', () => {
  const block = code.slice(code.indexOf('sel.onchange = async () => {'));
  const ok = block.slice(0, block.indexOf('} catch (e) {'));
  assert.match(ok, /evTriageApi\('correct'/);
  assert.match(ok, /evRenderBrief\(host, m, d, acct\)/,
    'a saved correction that changes nothing on screen is indistinguishable from a failed one');
  const bad = block.slice(block.indexOf('} catch (e) {'), block.indexOf('} catch (e) {') + 400);
  assert.match(bad, /sel\.value = prev/, 'and a failed save must never look like a successful one');
});

test('the brief is keyed on the same id the background scan stores verdicts under', () => {
  // reina_mail_triage is unique on internetMessageId. Open a message without
  // asking Graph for it and the brief writes a SECOND row under the conversation
  // id -- a duplicate the scan will never find, carrying none of his corrections.
  const open = app.slice(app.indexOf('async function openEmailMessage('), app.indexOf('function evAddrs('));
  assert.match(open, /\$select=id,internetMessageId,/, 'the reading-pane fetch must ask for it');
  const block = code.slice(code.indexOf('async function evReinaBrief('));
  assert.match(block.slice(0, 1600), /m\.internetMessageId \|\| m\.conversationId \|\| m\.id/);
  // For an IMAP message the adapter returns the RFC822 Message-ID as
  // conversationId, which is exactly what evTriageScanImap sends. Same key.
  assert.match(block.slice(0, 1600), /isImap \? \(m\.conversationId \|\| m\.id\)/);
});

// Chris, 2026-08-18: "the suggested response needs a way to edit it or change
// it to create a different anwser."

test('the suggested reply is editable in place', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /body\.contentEditable = 'true'/,
    'a draft you can only accept or discard is worse than a blank composer');
  assert.match(block, /click to edit/, 'and it says so');
  assert.match(block, /evTriageApi\('draft_save'/, 'his edit is written back, not lost on a folder change');
});

test('Use this reply sends what HE left in the box, not what Reina wrote', () => {
  const block = code.slice(code.indexOf('function evRenderBrief('));
  assert.match(block, /evTriageDraft\(Object\.assign\(\{\}, r, \{ draft_text: d\.draft \}\), b\)/,
    'the edit is the point — sending the original past it would be worse than no edit box');
});

test('Rewrite carries the draft it is replacing', () => {
  const fn = code.slice(code.indexOf('async function evRewriteDraft('));
  assert.match(fn.slice(0, 1600), /previous: was/,
    '"shorter" has to mean shorter than the one he is looking at');
  assert.match(fn.slice(0, 1600), /instruction/);
  assert.match(code, /const EV_REWRITE_WAYS/);
  assert.match(code, /Say what to change…/, 'and a free-text way in for anything the list does not cover');
});

test('a failed rewrite puts his draft back', () => {
  const fn = code.slice(code.indexOf('async function evRewriteDraft('));
  const bad = fn.slice(fn.indexOf('} catch (e) {'), fn.indexOf('} catch (e) {') + 400);
  assert.match(bad, /d\.draft = was/, 'leaving him staring at a spinner that ate the draft is not an option');
  assert.match(bad, /evRenderBrief\(host, m, d, acct\)/);
});

// ---- the background pass ----------------------------------------------------

test('the labelling pass survived the list being removed', () => {
  // It is what puts "Emails Reina flagged" on his Team To-Do. With the pill
  // gone, nothing else would ever label a message he has not opened himself.
  assert.match(code, /async function evTriageBackgroundScan\(\)/);
  assert.match(code, /evTriageApi\('list'\)/, 'the Microsoft mailboxes');
  assert.match(code, /evTriageApi\('classify'/, 'and the Gmail one, whose body only the browser can reach');
  const open = app.slice(app.indexOf('function openEmailTab()'), app.indexOf('async function emailSignIn('));
  assert.match(open, /evTriageBackgroundScan\(\)/, 'kicked off when the mail app opens');
});

test('the background pass paints nothing and is not on a timer', () => {
  const block = code.slice(code.indexOf('async function evTriageBackgroundScan('));
  const scan = block.slice(0, 900);
  assert.ok(!/innerHTML|appendChild/.test(scan), 'it is invisible by design');
  // Chris asked what a 30-minute poll would cost and never said to build one.
  assert.ok(!/setInterval/.test(code), 'no unattended spend he did not ask for');
  assert.match(scan, /EV_TRIAGE_SCAN_MIN_GAP_MS/, 'and it does not re-scan on every tab switch');
});

// Chris, 2026-08-18: "why is it not auto reading emails upon login to
// HiveLogic? it doesn't start until i open an email."
test('logging into HiveLogic starts the read, not just opening the mail app', () => {
  const scan = index.slice(index.indexOf('async function reinaLoginScan()'),
                           index.indexOf('// --- Browser-close auto-clockout'));
  assert.ok(scan, 'sanity: the login scan exists in the HiveLogic page');
  assert.match(scan, /action=list/, 'the Microsoft mailboxes');
  assert.match(scan, /action=classify/, 'and the Gmail one');
  // It cannot call into hiveconnect/app.js: that loads as an ES module when
  // HiveConnect mounts, so its functions are not global — and on the Command
  // Center it has not loaded at all.
  assert.ok(!/evTriageBackgroundScan/.test(scan), 'so it speaks to the API directly');
  assert.match(scan, /teamTodoLoad\(\)/, 'and refreshes the count already on screen');
});

test('the login scan never delays the first paint', () => {
  const scan = index.slice(index.indexOf('(function () {\n  var RAN = false;'),
                           index.indexOf('// --- Browser-close auto-clockout'));
  assert.match(scan, /addEventListener\('load'/, 'after the page is up');
  assert.match(scan, /setTimeout\(reinaLoginScan, 2500\)/, 'and behind it, not in front of it');
  assert.match(scan, /if \(RAN\) return; RAN = true/, 'and exactly once per load');
});

test('the login scan reads and labels — it opens, sends and moves nothing', () => {
  const scan = index.slice(index.indexOf('async function reinaLoginScan()'),
                           index.indexOf('// --- Browser-close auto-clockout'));
  for (const verb of ['/move', 'action=send', "action='brief'", 'action=brief', 'action=unsubscribe', 'action=act']) {
    assert.ok(!scan.includes(verb), verb + ' has no business running unattended at login');
  }
});

test('one failing mailbox does not take the others down', () => {
  const block = code.slice(code.indexOf('async function evTriageScanImap('));
  assert.match(block.slice(0, 1400), /catch \(e\) \{/);
  assert.match(block.slice(0, 1400), /for \(const a of imapAccounts\)/);
});

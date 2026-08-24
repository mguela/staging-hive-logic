// test/hivevideo-incoming-ring.test.mjs
//
// Chris, 2026-08-23: "why did it ask me the select a person to call and then
// make me again try to invite someone once the HiveVideo window opened?"
//
// I answered that HiveVideo never rings the person you pick. That was wrong,
// and worth recording as wrong: the ring has been there since the embed --
// updateIncomingCalls() watches huddle presence, showIncomingCall() draws a
// card with Join and Dismiss, ringTone() plays, and it gives up after 35s.
//
// What was missing is any way for that ring to LEAVE THE PAGE. The card is
// appended to document.body and the tone is WebAudio, so a person with
// HiveConnect in a background tab saw nothing and heard nothing -- an
// unfocused tab draws a card nobody is looking at, and Chrome will not start
// audio in one without a prior gesture. He waited, nothing happened, and the
// invite panel was the only way left to reach them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HC = fs.readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');

test('the ring the user picks really does reach presence', () => {
  // The part I wrongly said did not exist. Pinned so nobody removes it while
  // "adding ringing".
  assert.match(HC, /function updateIncomingCalls\(\)/);
  assert.match(HC, /function showIncomingCall\(cid, caller, c\)/);
  assert.match(HC, /join\.textContent = 'Join'/);
});

test('an incoming call now leaves the page', () => {
  assert.match(HC, /ringNotify\(cid, who, where\)/);
  assert.match(HC, /new Notification\(who \+ ' — HiveVideo'/);
});

test('it is not raised over a tab he is already looking at', () => {
  // The card is right there; a second alert for the same call is noise.
  const fn = HC.slice(HC.indexOf('function ringNotify('));
  assert.match(fn.slice(0, 700), /if \(document\.hasFocus\(\)\) return;/);
  assert.match(fn.slice(0, 700), /Notification\.permission !== 'granted'/);
  assert.match(fn.slice(0, 700), /if \(!notifsEnabled\) return;/,
    'the setting that follows the user still governs it');
});

test('a call holds the screen, unlike a message', () => {
  const fn = HC.slice(HC.indexOf('function ringNotify('));
  assert.match(fn.slice(0, 1200), /requireInteraction: true/);
});

test('and it cannot outlive the call it announces', () => {
  // requireInteraction means something has to close it. A notification for a
  // call that already ended is worse than none.
  const clear = HC.slice(HC.indexOf('function clearRing(cid)'));
  assert.match(clear.slice(0, 500), /ringNotifs\.get\(cid\)/);
  assert.match(clear.slice(0, 500), /n\.close\(\)/);
  assert.match(clear.slice(0, 500), /ringNotifs\.delete\(cid\)/);
});

test('clicking it answers the call rather than just focusing the tab', () => {
  const fn = HC.slice(HC.indexOf('function ringNotify('));
  assert.match(fn.slice(0, 1400), /window\.focus\(\)/);
  assert.match(fn.slice(0, 1400), /joinHuddle\(cid\)/);
  assert.match(fn.slice(0, 1400), /await openChannel\(cid\)/);
});

test('a notification failure never breaks the call itself', () => {
  const fn = HC.slice(HC.indexOf('function ringNotify('));
  assert.match(fn.slice(0, 1600), /catch \(e\) \{ \/\* a notification must never break the call itself \*\/ \}/);
});

test('the remaining limit is written down, not left to be rediscovered', () => {
  // This reaches a BACKGROUND tab, not a closed one. Ringing someone who does
  // not have HiveConnect open needs a server-side Web Push.
  assert.match(HC, /THE REMAINING LIMIT/);
  assert.match(HC, /background tab, not a closed one/i);
});

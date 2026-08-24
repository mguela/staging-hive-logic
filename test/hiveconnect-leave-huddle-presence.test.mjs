// test/hiveconnect-leave-huddle-presence.test.mjs
//
// Chris, 2026-08-23, on a live call: "i CAN SEE THE LIVE CALL TO RAISIN NUTS
// AND SHOW MY VIDEO, BUT WHEN i CLICK LEAVE THE POPUP GOES AWAY BUT THE CALL
// IS STILL ACTIVE AND IF i HIT JOIN IT PULLS IT BACK UP" -- with the channel
// header stuck on "Join (1)". That 1 was HIM. His own presence outlived the
// call he had left, so the app kept offering him a way back into it.
//
// Leaving used to be a single unchecked push:
//
//     try { if (huddleChannel && huddleChannel.untrack) huddleChannel.untrack(); } catch (e) {}
//
// which cannot report a failure, in two independent ways. Both are visible in
// @supabase/realtime-js and both are exercised below against real stand-ins:
//
//   1. untrack() is send({type:'presence'}), which RESOLVES to 'error' or
//      'timed out' when the socket is down -- it does not reject. Nothing
//      awaited the result, so a refusal was indistinguishable from success.
//   2. When the channel is not joined, channelAdapter.push() THROWS, rejecting
//      the returned promise. A synchronous try/catch around an un-awaited call
//      never sees that.
//
// Either way the dock hid, activeHuddle went null, and the server went right on
// announcing him in the huddle. The fix does not assume the push lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  return source.slice(start, i);
}

// Pull the three presence helpers into a sandbox with a real Map for
// huddleState, so these are behaviour tests and not source greps.
function sandbox({ untrack, activeHuddle = null, state = new Map() }) {
  const ctx = vm.createContext({
    me: { id: 'chris' },
    huddleState: state,
    activeHuddle,
    huddleChannel: untrack === null ? null : { untrack },
    untrackTries: 0,
  });
  const code = [
    extractFunction(src, 'async function clearMyHuddlePresence()'),
    extractFunction(src, 'function dropMeFromHuddleState()'),
    extractFunction(src, 'function reconcileMyHuddlePresence(map)'),
  ].join('\n');
  vm.runInContext(code, ctx);
  return ctx;
}

const inACall = () => new Map([['ch-1', [{ user_id: 'chris', display_name: 'Chris' }]]]);

test("a 'timed out' untrack is reported as failure, not swallowed", async () => {
  // Failure mode 1: send() resolves, it does not reject.
  const ctx = sandbox({ untrack: async () => 'timed out' });
  assert.equal(await vm.runInContext('clearMyHuddlePresence()', ctx), false);
});

test("an 'error' untrack is reported as failure", async () => {
  const ctx = sandbox({ untrack: async () => 'error' });
  assert.equal(await vm.runInContext('clearMyHuddlePresence()', ctx), false);
});

test('an untrack that throws is caught and reported, never left unhandled', async () => {
  // Failure mode 2: channelAdapter.push() throws "before joining", which
  // rejects. The old synchronous try/catch could not catch this.
  const ctx = sandbox({
    untrack: async () => { throw new Error("tried to push 'presence' to 'huddles' before joining"); },
  });
  assert.equal(await vm.runInContext('clearMyHuddlePresence()', ctx), false);
});

test("only 'ok' counts as the server having let go", async () => {
  const ctx = sandbox({ untrack: async () => 'ok' });
  assert.equal(await vm.runInContext('clearMyHuddlePresence()', ctx), true);
});

test('leaving drops me from the local state immediately, without waiting on the server', () => {
  const ctx = sandbox({ untrack: async () => 'timed out', state: inACall() });
  vm.runInContext('dropMeFromHuddleState()', ctx);
  assert.equal(ctx.huddleState.size, 0, 'the header must not still read "Join (1)"');
});

test('dropping me leaves everyone else in the call', () => {
  const state = new Map([['ch-1', [
    { user_id: 'chris' }, { user_id: 'scott' },
  ]]]);
  const ctx = sandbox({ untrack: async () => 'ok', state });
  vm.runInContext('dropMeFromHuddleState()', ctx);
  assert.deepEqual(ctx.huddleState.get('ch-1'), [{ user_id: 'scott' }]);
});

test('a later sync that still shows me in a call I left untracks again', () => {
  let calls = 0;
  const ctx = sandbox({ untrack: async () => { calls++; return 'ok'; } });
  vm.runInContext('reconcileMyHuddlePresence(map)', Object.assign(ctx, { map: inACall() }));
  assert.equal(calls, 1, 'a ghost presence must be chased, not rendered');
});

test('a sync while I am genuinely in the call does not untrack me out of it', () => {
  let calls = 0;
  const ctx = sandbox({ untrack: async () => { calls++; return 'ok'; }, activeHuddle: 'ch-1' });
  vm.runInContext('reconcileMyHuddlePresence(map)', Object.assign(ctx, { map: inACall() }));
  assert.equal(calls, 0);
});

test('the reconciler gives up rather than spinning on a server that will not let go', () => {
  let calls = 0;
  const ctx = sandbox({ untrack: async () => { calls++; return 'error'; } });
  ctx.map = inACall();
  for (let i = 0; i < 20; i++) vm.runInContext('reconcileMyHuddlePresence(map)', ctx);
  assert.equal(calls, 5, 'bounded retries — a sync loop must never become a push loop');
});

test('the reconciler never edits huddleState, so a second tab really in the call survives', () => {
  // Presence is per-socket under a shared key. Untracking here cannot take that
  // other tab down, but hiding it locally would have.
  const state = inACall();
  const ctx = sandbox({ untrack: async () => 'ok', state });
  ctx.map = state;
  vm.runInContext('reconcileMyHuddlePresence(map)', ctx);
  assert.equal(ctx.huddleState.get('ch-1').length, 1);
});

test('leaveHuddle wires all of it together', () => {
  const fn = extractFunction(src, 'function leaveHuddle(silent)');
  assert.match(fn, /dropMeFromHuddleState\(\);/, 'the UI is corrected locally');
  assert.match(fn, /clearMyHuddlePresence\(\)\.then\(ok => \{ if \(!ok\) clearMyHuddlePresence\(\); \}\)/,
    'and the untrack is checked, then retried once on the spot');
  const drop = fn.indexOf('dropMeFromHuddleState();');
  const render = fn.indexOf('if (!silent) renderHuddleUI();');
  assert.ok(drop > -1 && render > drop, 'local state must be corrected before the re-render');
});

test('the presence sync reconciles on every sync, not just on leave', () => {
  const fn = extractFunction(src, 'function subscribeHuddles()');
  assert.match(fn, /huddleState = map;\s*\n\s*reconcileMyHuddlePresence\(map\);/);
});

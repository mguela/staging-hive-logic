// test/hivevideo-ringback-and-popout.test.mjs
//
// Two things Chris asked for while watching the call window, 2026-08-23:
//
//   "theres no sound when calling a person either, its strange not hearing
//    someting to indicate it ringing. we need a unique hivelogic ring."
//
//   "its still locked into the view of HiveLogic, it needs to be a window on
//    its own that can be pull out of the view of hive logic"
//
// The second one is worth recording honestly: it already could. togglePopout()
// (Document PiP) has been there. It was surfaced ONLY as an unlabelled icon in
// the second row of the in-call control bar, which is not where anyone looks
// for a window control, so functionally it did not exist. The fix is placement,
// not capability -- which is why the tests below are about where the control is
// and what it says, not about PiP itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/hiveconnect/index.html', import.meta.url), 'utf8');
const sfx = readFileSync(new URL('../public/sfx.js', import.meta.url), 'utf8');

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

// ---- the ring ----

function ringSandbox({ target = { display_name: 'Allan Amit' }, hlSfx = {} } = {}) {
  const calls = [];
  const ctx = vm.createContext({
    window: { hlSfx },
    hlSfx: Object.assign({
      startLoop: (n, ms) => calls.push(['startLoop', n, ms]),
      stopLoop: () => calls.push(['stopLoop']),
      play: (n) => calls.push(['play', n]),
    }, hlSfx),
    hvRingbackOn: false,
    hudCallTarget: () => target,
  });
  ctx.window.hlSfx = ctx.hlSfx;
  vm.runInContext([
    extractFunction(app, 'function startHvRingback()'),
    extractFunction(app, 'function stopHvRingback()'),
  ].join('\n'), ctx);
  return { ctx, calls };
}

const HVRING = sfx.slice(sfx.indexOf('hvring: function'), sfx.indexOf('// Call connected'));

test('the HiveVideo ring is its own sound, not the telco dual tone', () => {
  assert.match(sfx, /hvring: function \(\)/, 'HiveVideo needs its own voice');
  // 440+480 is the US ringback in `ringback` above it, correct for the VoIP
  // phone and wrong for calling a colleague.
  assert.doesNotMatch(HVRING, /f0: 440/);
  assert.doesNotMatch(HVRING, /f0: 480/);
  assert.match(HVRING, /f0: 349\.23/, 'F4');
  assert.match(HVRING, /f0: 523\.25/, 'answered a fifth up at C5');
});

test('the ring is struck, not oscillated -- which is what made the first one an arcade cabinet', () => {
  // Chris: "that ring is bullshit and sounds like a broken arcade game from
  // the 80's". It was three tone() calls: one sine each, 6ms attack, straight
  // exponential decay. That is how an arcade cabinet made sound.
  assert.doesNotMatch(HVRING, /\btone\(/, 'a bare sine is the thing that sounded wrong');
  assert.match(HVRING, /\bbell\(/);
});

test('the bell partials decay at different rates, which is what "struck" means', () => {
  // All partials fading together reads as an oscillator no matter the timbre;
  // bright ones have to die first.
  const rows = [...sfx.matchAll(/\[(\d\.\d+), ([\d.]+), ([\d.]+)\],/g)]
    .map(m => ({ ratio: +m[1], level: +m[2], ring: +m[3] }));
  assert.ok(rows.length >= 5, 'a bell needs partials, not one tone');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].ratio > rows[i - 1].ratio, 'partials ascend');
    assert.ok(rows[i].level < rows[i - 1].level, 'and get quieter');
    assert.ok(rows[i].ring < rows[i - 1].ring, 'and die sooner — this is the whole point');
  }
  assert.notEqual(rows[1].ratio, 2, 'a real bell is not exactly harmonic');
});

test('the attack is felt, not clicked', () => {
  const fn = sfx.slice(sfx.indexOf('function bell(opts)'), sfx.indexOf('// ---- the sound set'));
  assert.match(fn, /linearRampToValueAtTime\(peak, t0 \+ 0\.018\)/, 'a mallet has a face');
});

test('the ring is placed in a room rather than being bone dry', () => {
  const fn = sfx.slice(sfx.indexOf('function bell(opts)'), sfx.indexOf('// ---- the sound set'));
  assert.match(fn, /reverbBus\(\)/);
  assert.match(sfx, /createConvolver\(\)/);
});

test('the room is built once and never breaks the sound if it fails', () => {
  const fn = sfx.slice(sfx.indexOf('function reverbBus()'), sfx.indexOf('/* ---- a struck bell'));
  assert.match(fn, /if \(verb \|\| !ctx\) return verb;/);
  assert.match(fn, /catch \(e\) \{ verb = null; \}/);
});

test('the ring is quiet enough to sit next to while you wait', () => {
  const vols = [...HVRING.matchAll(/vol: ([\d.]+)/g)].map(m => Number(m[1]));
  assert.ok(vols.length >= 3, 'both strikes plus the body are voiced');
  assert.ok(Math.max(...vols) <= 0.15, `loudest strike was ${Math.max(...vols)}`);
});

test('calling someone starts the ring, on a cadence not a drone', () => {
  const { ctx, calls } = ringSandbox();
  vm.runInContext('startHvRingback()', ctx);
  assert.deepEqual(calls, [['startLoop', 'hvring', 3400]]);
});

test('starting twice does not stack two rings', () => {
  const { ctx, calls } = ringSandbox();
  vm.runInContext('startHvRingback(); startHvRingback(); startHvRingback()', ctx);
  assert.equal(calls.filter(c => c[0] === 'startLoop').length, 1);
});

test('the ring stops, and only if it was mine to stop', () => {
  const { ctx, calls } = ringSandbox();
  // Never rang -> must not stop a loop somebody else started (an incoming ring
  // for a different call shares hlSfx's single loop slot).
  vm.runInContext('stopHvRingback()', ctx);
  assert.equal(calls.length, 0);
  vm.runInContext('startHvRingback(); stopHvRingback()', ctx);
  assert.deepEqual(calls.map(c => c[0]), ['startLoop', 'stopLoop']);
});

test('a browser with no sound kit does not break the call', () => {
  const ctx = vm.createContext({ window: {}, hvRingbackOn: false, hudCallTarget: () => ({}) });
  vm.runInContext([
    extractFunction(app, 'function startHvRingback()'),
    extractFunction(app, 'function stopHvRingback()'),
  ].join('\n'), ctx);
  vm.runInContext('startHvRingback(); stopHvRingback()', ctx);   // must not throw
  assert.equal(ctx.hvRingbackOn, false);
});

test('an open channel room rings nobody, because nobody specific is being called', () => {
  const fn = extractFunction(app, 'function startRingClock()');
  assert.match(fn, /if \(hudCallTarget\(\)\) startHvRingback\(\);/);
});

test('answering stops the ring and marks the connection', () => {
  const connected = app.slice(app.indexOf('.on(RE.ParticipantConnected'), app.indexOf('.on(RE.ParticipantDisconnected'));
  assert.match(connected, /stopRingClock\(\)/);
  assert.match(connected, /hlSfx\.play\('connect'\)/);
  assert.match(connected, /wasRinging/, 'the blip belongs to a call that was ringing, not to every arrival');
});

test('the ring never outlives the call it belongs to', () => {
  assert.match(extractFunction(app, 'function stopRingClock()'), /stopHvRingback\(\)/);
  assert.match(extractFunction(app, 'function leaveHuddle(silent)'), /stopHvRingback\(\)/);
});

test('standalone HiveConnect loads the sound kit too', () => {
  assert.match(html, /<script src="\/sfx\.js"><\/script>/);
});

// ---- the pop-out ----

test('the pop-out is in the title bar, with the other window controls', () => {
  const bar = html.slice(html.indexOf('<div class="hd-controls">'), html.indexOf('</div>', html.indexOf('id="hd-leave"')));
  const at = (id) => bar.indexOf(id);
  assert.ok(at('hd-popout-top') > -1, 'a window control belongs where window controls live');
  assert.ok(at('hd-popout-top') < at('hd-min'), 'and reads before minimize / expand');
});

test('it says what it does, in words, not just an icon', () => {
  assert.match(html, /id="hd-popout-top"[^>]*title="Open in its own window[^"]*"/);
  assert.match(html, /aria-label="Open in its own window"/);
});

test('the label flips once it is popped out', () => {
  const fn = extractFunction(app, 'function updatePopoutBtn(on)');
  assert.match(fn, /Put the call back in HiveLogic/);
  assert.match(fn, /hd-popout-top/);
  assert.match(fn, /hd-popout'/, 'the old control-bar button stays in sync too');
});

test('a browser that cannot pop out is not offered a dead button', () => {
  assert.match(html, /id="hd-popout-top"[^>]*class="hd-ctl hidden"|class="hd-ctl hidden"[^>]*id="hd-popout-top"/);
  const wiring = app.slice(app.indexOf("const top = $('hd-popout-top')"), app.indexOf("$('hd-min').addEventListener"));
  assert.match(wiring, /'documentPictureInPicture' in window/);
  assert.match(wiring, /top\.classList\.remove\('hidden'\)/);
});

test('the title-bar control drives the same pop-out as before, not a second one', () => {
  const wiring = app.slice(app.indexOf("const top = $('hd-popout-top')"), app.indexOf("$('hd-min').addEventListener"));
  assert.match(wiring, /togglePopout\(\)/);
});

// ---- the look ----

test('nothing in the call window animates like a game HUD', () => {
  // The first pass gave the callee expanding halos; that stage is gone
  // entirely now (they are a tile in the grid), and what animates is a slow
  // breath on the tile border.
  const css = readFileSync(new URL('../public/hiveconnect/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /hdcPulse/, 'the expanding halos were the video-game tell');
  assert.doesNotMatch(css, /\.hd-calling/, 'and so is the hero panel that carried them');
  assert.match(css, /@keyframes hdPend \{/);
});

test('the header glyphs are real icons now, not typed characters', () => {
  const bar = html.slice(html.indexOf('<div class="hd-controls">'), html.indexOf('id="hd-leave"'));
  for (const ch of ['＋', '⤢']) assert.ok(!bar.includes(ch), `${ch} is a character, not an icon`);
  assert.ok((bar.match(/<svg /g) || []).length >= 4, 'invite, pop-out, minimize, expand');
});

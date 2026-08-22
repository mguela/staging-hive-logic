// test/rolo-hiveconnect-tab.test.mjs
//
// Chris, 2026-08-17: "When I hit the email shortcut tab on the right of
// HiveLogic, it brought me to messages again."
//
// The right-rail shortcuts (Phone / Email / SMS / Video) all go through
// window.hlRoloHC(tab), which opens HiveConnect and then has to WIN a race it
// does not control: HiveConnect's own boot() ends with `setNavTab('messages')`
// (public/hiveconnect/app.js:286), and that lands whenever the boot happens to
// finish -- after a bridged-session round trip, a markup fetch and eight script
// loads. On a warm mount that is instant; on a cold open it is routinely
// several seconds.
//
// THE BUG: hlRoloHC re-asserted the requested tab on a 150ms interval with two
// stop conditions -- `ticks>40` (6s) and `setTimeout(finish,4000)`. The 4s
// timer always won, so the correcting stopped a full boot-length early. A boot
// that landed at 5s set Messages with nothing left to put it back. It worked
// whenever HiveConnect was already mounted, which is exactly why it read as
// intermittent rather than broken.
//
// These tests run the SHIPPED function out of public/index.html in a vm
// sandbox (same technique as team-todo-frontend.test.mjs) against a rail that
// boots late, and pin the three behaviours that matter: the requested tab
// survives a late boot, a deliberate user click still wins, and the panel is
// never left faded out.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  const braceStart = src.indexOf('{', src.indexOf(')', declStart));
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

const HL_ROLO_HC = extractFunction(source, 'window.hlRoloHC=function(tab)');
// The function carries a long comment explaining the bug by name, so the
// shape assertions below have to read the CODE, not the story about it.
const HL_ROLO_HC_CODE = HL_ROLO_HC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\/[^\n'"]*$/gm, '');

// ---------------------------------------------------------------------------
// A rail just faithful enough to reproduce the race.
//
// The only DOM behaviours hlRoloHC depends on: querySelector for a rail button
// by data-tab, classList.contains('active'), .click(), a MutationObserver on
// #hiveconnect-root, and a capturing pointerdown listener. MutationObserver
// records are delivered as microtasks in a real browser -- batched, and after
// the current task -- so the shim delivers them synchronously but re-entrantly
// batched, which gives the same ordering without making the test async.
// ---------------------------------------------------------------------------
const TABS = ['messages', 'email', 'channels', 'huddles', 'tasks', 'voip'];

function makeWorld() {
  const world = {
    railRendered: false,     // HiveConnect markup injected?
    listenersWired: false,   // app.js evaluated, rail buttons bound?
    openHiveConnectCalls: 0,
    timers: [],
    now: 0,
  };

  let observers = [];
  let delivering = false, pending = false;
  function notify() {
    if (delivering) { pending = true; return; }
    delivering = true;
    try {
      do { pending = false; observers.slice().forEach((o) => { try { o.cb([{}], o.self); } catch (e) { /* observer threw */ } }); }
      while (pending);
    } finally { delivering = false; }
  }

  // HiveConnect's own setNavTab, reduced to the part that matters here.
  world.setNavTab = function (tab) {
    world.active = tab;
    notify();
  };
  world.active = 'messages';   // the shipped markup ships Messages pre-selected

  const buttons = new Map();
  for (const tab of TABS) {
    const b = {
      dataset: { tab },
      getAttribute: (n) => (n === 'data-tab' ? tab : null),
      closest: (sel) => (sel.indexOf('.rail-btn') !== -1 ? b : null),
      classList: { contains: (c) => c === 'active' && world.active === tab },
      click() { if (world.listenersWired) world.setNavTab(tab); },
    };
    buttons.set(tab, b);
  }
  world.button = (tab) => buttons.get(tab);

  const root = { id: 'hiveconnect-root', style: {} };
  world.root = root;

  const docListeners = [];
  const document = {
    getElementById: (id) => (id === 'hiveconnect-root' ? root : null),
    querySelector(sel) {
      if (!world.railRendered) return null;
      const m = /data-tab="([a-z]+)"/.exec(sel);
      return (m && buttons.get(m[1])) || null;
    },
    addEventListener(type, fn, capture) { docListeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) {
      const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) docListeners.splice(i, 1);
    },
    body: {},
  };
  world.document = document;

  // A real user pressing a rail button: pointerdown first, then the click.
  world.userClicks = function (tab) {
    const btn = buttons.get(tab);
    docListeners.filter((l) => l.type === 'pointerdown').forEach((l) => l.fn({ target: btn }));
    btn.click();
  };

  // Manual clock, so "the boot landed at 8 seconds" is a fact, not a sleep.
  world.setTimeout = (fn, ms) => { const t = { fn, at: world.now + (ms || 0), every: 0 }; world.timers.push(t); return t; };
  world.setInterval = (fn, ms) => { const t = { fn, at: world.now + (ms || 0), every: ms || 1 }; world.timers.push(t); return t; };
  world.clearTimer = (t) => { const i = world.timers.indexOf(t); if (i >= 0) world.timers.splice(i, 1); };
  world.advance = function (ms) {
    const until = world.now + ms;
    for (let guard = 0; guard < 100000; guard++) {
      const due = world.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      world.now = due.at;
      if (due.every) due.at = world.now + due.every;
      else world.clearTimer(due);
      due.fn();
    }
    world.now = until;
  };

  function MutationObserver(cb) {
    this.cb = cb;
    const self = this;
    this.self = self;
    this.observe = function () { observers.push(self); };
    this.disconnect = function () { observers = observers.filter((o) => o !== self); };
  }
  world.MutationObserver = MutationObserver;
  world.observerCount = () => observers.length;

  const ctx = vm.createContext({
    document,
    MutationObserver,
    setTimeout: world.setTimeout,
    setInterval: world.setInterval,
    clearTimeout: world.clearTimer,
    clearInterval: world.clearTimer,
    openHiveConnect() { world.openHiveConnectCalls++; },
    window: {},
    console,
  });
  vm.runInContext(HL_ROLO_HC, ctx);
  world.hlRoloHC = ctx.window.hlRoloHC;

  // HiveConnect finishing its boot: markup already in, scripts evaluated
  // (rail buttons bound), and then boot()'s last line lands on Messages.
  world.bootCompletes = function () {
    world.railRendered = true;
    world.listenersWired = true;
    world.setNavTab('messages');
  };

  return world;
}

test('sanity: the harness reproduces HiveConnect landing on Messages', () => {
  const w = makeWorld();
  w.bootCompletes();
  assert.equal(w.active, 'messages');
});

test('a cold open that boots after 8 seconds still lands on the requested tab', () => {
  // The exact shape of Chris's bug: the shortcut is pressed against an unmounted
  // HiveConnect, and boot() -- with its bridged session, markup fetch and eight
  // script loads -- does not finish for another 8 seconds.
  const w = makeWorld();
  w.hlRoloHC('email');
  assert.equal(w.openHiveConnectCalls, 1, 'the panel must be opened');

  w.advance(8000);          // nothing rendered yet; the old code had already quit at 4s
  w.bootCompletes();        // rail appears, app.js binds, boot ends on Messages
  w.advance(500);

  assert.equal(w.active, 'email', 'the requested tab must be re-asserted after a late boot');
});

test('the old 4s cutoff is gone -- correcting outlasts a slow boot', () => {
  assert.ok(!/setTimeout\(finish,\s*4000\)/.test(HL_ROLO_HC_CODE),
    'the 4s stop timer is the bug: it quit before a cold boot could finish');
  assert.ok(!/ticks/.test(HL_ROLO_HC_CODE),
    'tick-counting is a stopwatch race; the tab is re-asserted on rail mutations instead');
  assert.match(HL_ROLO_HC_CODE, /MutationObserver/,
    'the rail must be watched, so however late the app flips the tab we put it back');
});

test('a boot that steals the tab repeatedly is corrected every time', () => {
  // Some boots touch setNavTab more than once (a huddle subscription resolving,
  // a channel opening). Each steal has to be undone, not just the first.
  const w = makeWorld();
  w.hlRoloHC('voip');
  w.railRendered = true; w.listenersWired = true;
  w.advance(300);
  assert.equal(w.active, 'voip');

  for (const steal of ['messages', 'messages', 'channels']) {
    w.setNavTab(steal);
    w.advance(200);
    assert.equal(w.active, 'voip', `a later setNavTab('${steal}') must not stick`);
  }
});

test('a warm mount switches immediately and reveals the panel at once', () => {
  const w = makeWorld();
  w.railRendered = true; w.listenersWired = true;   // HiveConnect already open
  w.hlRoloHC('email');
  assert.equal(w.active, 'email', 'an already-mounted rail switches on the spot');
  assert.equal(w.root.style.opacity, '1', 'no reason to hold the panel hidden once the tab is right');
});

test('a deliberate click on another tab wins -- the shortcut never fights the user', () => {
  const w = makeWorld();
  w.hlRoloHC('email');
  w.railRendered = true; w.listenersWired = true;
  w.advance(300);
  assert.equal(w.active, 'email');

  w.userClicks('messages');       // Chris changes his mind
  w.advance(2000);
  assert.equal(w.active, 'messages', 'once the user picks a tab, re-asserting must stop');
});

test('clicking the requested tab again is not mistaken for a takeover', () => {
  const w = makeWorld();
  w.hlRoloHC('email');
  w.railRendered = true; w.listenersWired = true;
  w.advance(300);

  w.userClicks('email');          // same tab -- not a change of mind
  w.setNavTab('messages');        // a late boot step still has to be corrected
  w.advance(300);
  assert.equal(w.active, 'email');
});

test('the panel is never left faded out, even if HiveConnect never renders', () => {
  const w = makeWorld();
  w.hlRoloHC('email');
  assert.equal(w.root.style.opacity, '0', 'hidden during the switch, to cover the flicker');
  w.advance(25000);               // rail never appears at all
  assert.equal(w.root.style.opacity, '1', 'the safety stop must always restore the panel');
});

test('everything is torn down when it stops -- no interval or observer left running', () => {
  const w = makeWorld();
  w.hlRoloHC('email');
  w.railRendered = true; w.listenersWired = true;
  w.advance(300);
  assert.ok(w.observerCount() >= 1, 'sanity: it is watching while it corrects');

  w.advance(25000);
  assert.equal(w.observerCount(), 0, 'the MutationObserver must be disconnected');
  assert.equal(w.timers.length, 0, 'the re-assert interval must be cleared');
});

test('every right-rail shortcut goes through hlRoloHC, so they all get this fix', () => {
  for (const tab of ['voip', 'email', 'messages', 'huddles']) {
    assert.ok(source.includes(`hlRoloHC('${tab}')`), `the ${tab} shortcut must route through hlRoloHC`);
  }
});

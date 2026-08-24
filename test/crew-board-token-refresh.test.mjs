// Chris, 2026-08-23, looking at his console: "how do We get past these?"
//
//   GET https://hivelogic-live.vercel.app/api/track1?resource=crew_schedule 401
//   app.js:965
//
// repeating every 60 seconds and never recovering. The cause was not the
// endpoint. The crew board is an IFRAME: it does not inherit index.html's
// hlAuthenticatedFetch shim, so it cannot heal a 401 the way the parent page
// does, and the parent handed it a token exactly once -- on iframe load. A
// Supabase access token expires after an hour, so any HiveLogic session left
// open longer than that left the board polling GPS with a dead token for as
// long as the tab stayed on the Schedule view.
//
// These tests are about the recovery path, because that is the part that
// silently rots: everything here still "works" with a dead token in the sense
// that no exception is thrown and the poll keeps running. It just never
// succeeds again.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'app.js'), 'utf-8');
const DATA_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'data.js'), 'utf-8');
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

// Same extraction approach as the other schedule-board tests: pull the REAL
// functions out and run them, rather than asserting on the shape of the text.
function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('not found: ' + declSnippet);
  const braceStart = declStart + declSnippet.length - 1;
  let depth = 1, i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

// ---- the board asking the parent (data.js) ---------------------------------

function boardSandbox() {
  const posted = [];
  const timers = [];
  const win = {};
  const parent = { postMessage: (msg, origin) => posted.push({ msg, origin }) };
  win.parent = parent;
  const ctx = {
    window: win, Promise, Error, Array, Object, JSON, console,
    location: { origin: 'https://hivelogic-live.vercel.app' },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  ctx.window.parent = parent;
  vm.createContext(ctx);
  vm.runInContext(
    extractFunction(DATA_SRC, 'function deliverToken(t){') + '\n' +
    'var _tokenWaiters = [], _tokenPending = null;\n' +
    extractFunction(DATA_SRC, 'window.hlFreshToken = function(){'),
    ctx
  );
  // deliverToken/_tokenWaiters are hoisted per-declaration above; re-run in the
  // real order so the closure state is the one the function actually uses.
  return { ctx, posted, timers, win,
    // what data.js's message listener does when a token lands
    arrive: (t) => { ctx.window.HL_BOARD_TOKEN = t; vm.runInContext('deliverToken(' + JSON.stringify(t) + ')', ctx); },
    fire: () => timers.forEach((t) => t.fn()) };
}

test('the board asks the parent for a token instead of only waiting to be handed one', async () => {
  const b = boardSandbox();
  const p = b.ctx.window.hlFreshToken();
  assert.equal(b.posted.length, 1, 'it must actually ask');
  assert.equal(b.posted[0].msg.type, 'hl-crewboard-need-token');
  assert.equal(b.posted[0].origin, 'https://hivelogic-live.vercel.app',
    'targeted at our own origin, never "*" -- this asks for a bearer token');
  b.arrive('fresh-token');
  assert.equal(await p, 'fresh-token');
});

test('ten callers in one poll produce one ask, not ten', async () => {
  const b = boardSandbox();
  const ps = Array.from({ length: 10 }, () => b.ctx.window.hlFreshToken());
  assert.equal(b.posted.length, 1);
  b.arrive('t1');
  assert.deepEqual(await Promise.all(ps), Array(10).fill('t1'));
});

test('a second ask later is a real second ask', async () => {
  const b = boardSandbox();
  const first = b.ctx.window.hlFreshToken();
  b.arrive('t1');
  await first;
  b.ctx.window.hlFreshToken();
  assert.equal(b.posted.length, 2, 'the in-flight dedupe must clear once answered');
});

test('a parent that never answers fails the request rather than hanging the poll', async () => {
  // If this promise never settled, the 60-second GPS loop would stop dead on
  // the first unanswered ask -- worse than the 401 flood it replaced.
  const b = boardSandbox();
  const p = b.ctx.window.hlFreshToken();
  assert.ok(b.timers.some((t) => t.ms > 0 && t.ms <= 10000), 'there must be a timeout');
  b.fire();
  assert.equal(await p, '', 'resolves empty, so the caller reports unavailable');
});

// ---- the poll itself (app.js) ----------------------------------------------

function gpsSandbox(responses, freshToken) {
  const fetches = [];
  const win = { HL_BOARD_TOKEN: null };
  const ctx = {
    window: win, Promise, Error, console, Object, Array, JSON,
    LIVEGPS: { byTech: {}, at: 0, error: null },
    applied: [],
    fetch: (url, opts) => {
      fetches.push({ url, auth: (opts && opts.headers && opts.headers.Authorization) || null });
      const r = responses.shift();
      if (!r) throw new Error('unexpected extra fetch: ' + url);
      return Promise.resolve({ status: r.status, json: () => Promise.resolve(r.body) });
    },
    applyLiveGps: (d) => { ctx.applied.push(d); },
    updateTrucks: () => {}, renderMapLegend: () => {}, renderSummary: () => {},
  };
  if (freshToken) win.hlFreshToken = freshToken(win);
  vm.createContext(ctx);
  vm.runInContext(
    extractFunction(APP_SRC, 'function freshBoardToken(){') + '\n' +
    extractFunction(APP_SRC, 'function fetchLiveGps(retried){') + '\n' +
    extractFunction(APP_SRC, 'function loadLiveGps(){'),
    ctx
  );
  return { ctx, fetches, win };
}

test('a dead token is refreshed and the poll recovers on the same tick', async () => {
  const s = gpsSandbox(
    [{ status: 401, body: { ok: false, error: 'Authentication required.' } },
     { status: 200, body: { ok: true, vehicles: [] } }],
    (win) => () => { win.HL_BOARD_TOKEN = 'new'; return Promise.resolve('new'); }
  );
  s.win.HL_BOARD_TOKEN = 'expired';
  await s.ctx.loadLiveGps();
  assert.equal(s.fetches.length, 2);
  assert.equal(s.fetches[0].auth, 'Bearer expired');
  assert.equal(s.fetches[1].auth, 'Bearer new', 'the retry must use the NEW token');
  assert.equal(s.ctx.LIVEGPS.error, null, 'and it must actually succeed');
  assert.equal(s.ctx.applied.length, 1);
});

test('a signed-out session settles at two requests, not a flood', async () => {
  // This is the bug. One poll must cost at most one retry -- otherwise the
  // "fix" is a faster version of the same console full of 401s.
  const s = gpsSandbox(
    [{ status: 401, body: { ok: false } }, { status: 401, body: { ok: false } }],
    (win) => () => { win.HL_BOARD_TOKEN = 'other'; return Promise.resolve('other'); }
  );
  s.win.HL_BOARD_TOKEN = 'expired';
  await s.ctx.loadLiveGps();
  assert.equal(s.fetches.length, 2, 'exactly one retry');
  assert.match(String(s.ctx.LIVEGPS.error), /not signed in/,
    'and it says so -- a stale position shown as current is worse than none');
});

test('a parent handing out fresh tokens that the server still rejects stops anyway', async () => {
  // The retry bound has to hold on its own. If the only thing stopping the loop
  // is "the parent gave me the same string back", then a parent that mints a
  // genuinely new token each time -- while the server rejects all of them,
  // which is exactly what a revoked session or a broken endpoint looks like --
  // recreates the flood with extra steps.
  let n = 0;
  const s = gpsSandbox(
    [{ status: 401, body: { ok: false } }, { status: 401, body: { ok: false } },
     { status: 401, body: { ok: false } }, { status: 401, body: { ok: false } }],
    (win) => () => { win.HL_BOARD_TOKEN = 'tok-' + (++n); return Promise.resolve('tok-' + n); }
  );
  s.win.HL_BOARD_TOKEN = 'tok-0';
  await s.ctx.loadLiveGps();
  assert.equal(s.fetches.length, 2, 'one retry, then stop -- however new the token looks');
  assert.match(String(s.ctx.LIVEGPS.error), /not signed in/);
});

test('the same token back means do not bother asking the network again', async () => {
  const s = gpsSandbox(
    [{ status: 401, body: { ok: false } }],
    () => () => Promise.resolve('expired')   // parent has nothing better
  );
  s.win.HL_BOARD_TOKEN = 'expired';
  await s.ctx.loadLiveGps();
  assert.equal(s.fetches.length, 1, 'retrying the identical token is the same 401 at twice the rate');
  assert.match(String(s.ctx.LIVEGPS.error), /not signed in/);
});

test('with no token at all it asks first and never fires a bare request', async () => {
  // A request with no Authorization header is a guaranteed 401. Sending it
  // anyway is how the board taught itself nothing, sixty times an hour.
  const s = gpsSandbox(
    [{ status: 200, body: { ok: true, vehicles: [] } }],
    (win) => () => { win.HL_BOARD_TOKEN = 'arrived'; return Promise.resolve('arrived'); }
  );
  await s.ctx.loadLiveGps();
  assert.equal(s.fetches.length, 1);
  assert.equal(s.fetches[0].auth, 'Bearer arrived');
  assert.equal(s.ctx.LIVEGPS.error, null);
});

test('tokenless and no parent to ask reports unavailable without any request', async () => {
  const s = gpsSandbox([], () => () => Promise.resolve(''));
  await s.ctx.loadLiveGps();
  assert.equal(s.fetches.length, 0);
  assert.match(String(s.ctx.LIVEGPS.error), /not signed in/);
});

test('a healthy token is one request, same as before', async () => {
  const s = gpsSandbox([{ status: 200, body: { ok: true, vehicles: [] } }], null);
  s.win.HL_BOARD_TOKEN = 'good';
  await s.ctx.loadLiveGps();
  assert.equal(s.fetches.length, 1);
  assert.equal(s.ctx.applied.length, 1);
});

test('a server error is still surfaced, not swallowed as success', async () => {
  const s = gpsSandbox([{ status: 200, body: { ok: false, error: 'fleet provider down' } }], null);
  s.win.HL_BOARD_TOKEN = 'good';
  await s.ctx.loadLiveGps();
  assert.match(String(s.ctx.LIVEGPS.error), /fleet provider down/);
});

// ---- the parent's half (index.html) -----------------------------------------

test('the parent answers the ask, and only from its own origin', () => {
  const block = INDEX_SRC.slice(INDEX_SRC.indexOf('hl-crewboard-need-token') - 400,
                                INDEX_SRC.indexOf('hl-crewboard-need-token') + 200);
  assert.match(block, /ev\.origin !== location\.origin/,
    'a token handed to any origin that asks is a token given away');
  assert.match(block, /sendToken\(\)/);
});

test('the parent pushes each refreshed token down without being asked', () => {
  // The ask-on-401 path is the backstop. This is what means the board is
  // normally never holding a dead token in the first place.
  assert.match(INDEX_SRC, /onAuthStateChange\(function\(ev\)\{[^}]*TOKEN_REFRESHED[^}]*sendToken\(\)/);
});

test('sendToken reads the session fresh rather than replaying what we hold', () => {
  // getSession() refreshes an expired token itself. Sending window.__hlAccessToken
  // would forward the same dead string the board already has.
  const i = INDEX_SRC.indexOf('function sendToken(){');
  const fn = INDEX_SRC.slice(i, INDEX_SRC.indexOf('\n  }', i));
  assert.match(fn, /sb\.auth\.getSession\(\)/);
  assert.match(fn, /location\.origin\)/, 'posted to our origin, not "*"');
});

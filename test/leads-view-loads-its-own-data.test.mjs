// Chris, 2026-08-23: "Sales>Leads> pipeline is not loading" and "New Lead form
// > existing clients does not load when you start to type in the client name
// text box."
//
// Both were the same root cause, and it is worth stating plainly because the
// shape recurs in this codebase: the data was loaded exactly once, by a boot
// path that refused to run, and nothing on the screen that needed it could ask.
//
//   - ccGatedInitialWidgetLoad() owns the only boot-time loadLeadsLive() and
//     loadClientsLive() calls, and its first line is `if(!ccViewIsActive())
//     return;` -- true only for #/cc.
//   - ccPollTick()'s 30s refresh returns early unless __HL_CUR_VIEW === 'cc'.
//   - showView() had per-view load hooks for ajx, gpux, mpmx, mon, devtodo,
//     council, vi, expx and reports -- and none for leads.
//
// So opening HiveLogic straight on #/leads (a refresh, a bookmark, a deep
// link) loaded neither. Driven in Chromium before the fix: landing on #/leads
// made ZERO API calls and sat on "Loading your real pipeline..."; going via
// #/cc first rendered all 66 leads.
//
// The second failure has its own sting. The search boxes DID try to kick the
// load -- `if (typeof loadClientsLive === 'function') loadClientsLive();` --
// but loadClientsLive is declared in a much later <script> block, so on a cold
// landing that guard is simply false and falls through with no request and no
// error. A guard that silently does nothing is worse than no guard.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  const braceStart = start + decl.length - 1;
  let depth = 1, i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

// ---- the gate that caused it ----------------------------------------------

test('the Leads boot load is NOT behind the Command Center hash gate', () => {
  // This is the regression that matters. If someone folds the leads load back
  // into ccGatedInitialWidgetLoad, #/leads goes dark again and nothing errors.
  const gated = extractFunction(SRC, 'function hlGatedLeadsLoad(force){');
  assert.ok(!/ccViewIsActive/.test(gated),
    'the leads load must not consult the #/cc gate -- that gate is the bug');
  assert.match(gated, /hlLeadsViewIsActive/);
});

test('landing on #/leads is what arms it, and nothing else is', () => {
  const ctx = { location: { hash: '' } };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SRC, 'function hlLeadsViewIsActive(){'), ctx);
  const active = (h) => { ctx.location.hash = h; return ctx.hlLeadsViewIsActive(); };
  assert.equal(active('#/leads'), true);
  assert.equal(active('#/leads?x=1'), true, 'a query string is still the leads view');
  assert.equal(active('#/cc'), false);
  assert.equal(active('#/leadsomething'), false, 'prefix match would arm the wrong view');
  assert.equal(active(''), false);
});

// ---- the boot load itself ---------------------------------------------------

function leadsSandbox(over) {
  const calls = [];
  const ctx = Object.assign({
    Promise, console, Date,
    location: { hash: '#/leads' },
    loadLeadsLive: () => calls.push('leads'),
    loadClientsLive: () => calls.push('clients'),
    window: {},
    calls,
  }, over || {});
  ctx.window.hlRequireSession = (onSession, onMissing) => {
    const s = ctx.__session;
    return s ? onSession(s) : (onMissing ? onMissing() : undefined);
  };
  ctx.__session = { access_token: 'tok' };
  vm.createContext(ctx);
  vm.runInContext(
    extractFunction(SRC, 'function hlLeadsViewIsActive(){') + '\n' +
    extractFunction(SRC, 'function hlGatedLeadsLoad(force){'), ctx);
  return ctx;
}

test('opening straight on #/leads loads the pipeline AND the client book', async () => {
  // Both, because the New Lead form on that view reads the client book, and
  // the whole reason it hung is that nothing on this path fetched it.
  const ctx = leadsSandbox();
  ctx.hlGatedLeadsLoad();
  await Promise.resolve();
  assert.deepEqual(ctx.calls, ['leads', 'clients']);
});

test('it does nothing on any other view', async () => {
  const ctx = leadsSandbox({ location: { hash: '#/cc' } });
  ctx.hlGatedLeadsLoad();
  await Promise.resolve();
  assert.deepEqual(ctx.calls, [], 'Command Center has its own loader; this must not double it');
});

test('a signed-out page fetches nothing rather than manufacturing a 401', async () => {
  // The session-race fix of 2026-08-15 exists because authenticated loaders
  // firing before auth produced a recurring batch of production 401s.
  const ctx = leadsSandbox();
  ctx.__session = null;
  ctx.hlGatedLeadsLoad();
  await Promise.resolve();
  assert.deepEqual(ctx.calls, []);
});

test('the session landing later re-fires it, so a cold login is not a dead view', () => {
  assert.match(SRC, /addEventListener\('hl:signed-in', function\(\)\{ hlGatedLeadsLoad\(\); \}\)/);
});

test('it is armed at DOMContentLoaded, not at parse time', () => {
  // Parse-time was the original session-race bug across the whole Command
  // Center; the leads path must not reintroduce it.
  assert.match(SRC, /readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', function\(\)\{ hlGatedLeadsLoad\(\); \}\)/);
});

test('showView has a leads hook at all, which is what it was missing', () => {
  const fn = extractFunction(SRC, 'function showView(v){');
  assert.match(fn, /v==='leads'/, 'no hook here is the original bug');
  assert.match(fn, /hlGatedLeadsLoad/);
  // Navigating back and forth must not re-pull the 7-resource bundle each click.
  assert.match(fn, /hlLeadsLoadAt/);
});

// ---- clicking Leads in the sidebar, which is most of how the page is used --

test('showView forces the load, because the hash has not caught up yet', () => {
  // The first cut of this fix let hlGatedLeadsLoad check location.hash. showView
  // calls this hook near its top and only reaches hlCommitRoute(v) -- which
  // writes the hash -- on its last line, so on a sidebar click the hash still
  // reads the view being LEFT. It worked on a refresh and did nothing at all on
  // a click. Verified in Chromium: #/docs then showView('leads') made zero API
  // calls until this argument existed.
  const fn = extractFunction(SRC, 'function showView(v){');
  assert.match(fn, /hlGatedLeadsLoad\(true\)/,
    'showView already knows the view is leads -- it is the one switching to it');
  const hookAt = fn.indexOf("v==='leads'");
  const routeAt = fn.indexOf('hlCommitRoute(v)');
  assert.ok(hookAt > -1 && routeAt > -1);
  assert.ok(hookAt < routeAt,
    'if the hook ever moves below hlCommitRoute the force flag stops being needed -- ' +
    'this assertion is here so that move is a deliberate one');
});

test('forced means forced, and unforced still respects the view', async () => {
  const forced = leadsSandbox({ location: { hash: '#/docs' } });
  forced.hlGatedLeadsLoad(true);
  await Promise.resolve();
  assert.deepEqual(forced.calls, ['leads', 'clients'], 'a sidebar click must load');

  const unforced = leadsSandbox({ location: { hash: '#/docs' } });
  unforced.hlGatedLeadsLoad();
  await Promise.resolve();
  assert.deepEqual(unforced.calls, [], 'boot on another view must not');
});

test('the signed-in listener does not smuggle an Event in as `force`', async () => {
  // addEventListener passes the Event as argument 0. An Event is truthy, so a
  // bare `hlGatedLeadsLoad` reference as the handler would force a leads load
  // on every sign-in no matter which view the user is on.
  assert.ok(!/addEventListener\('hl:signed-in',\s*hlGatedLeadsLoad\s*\)/.test(SRC),
    'wrap it, do not pass the function reference directly');
  assert.match(SRC, /addEventListener\('hl:signed-in', function\(\)\{ hlGatedLeadsLoad\(\); \}\)/);
  assert.ok(!/addEventListener\('DOMContentLoaded', hlGatedLeadsLoad\)/.test(SRC),
    'same for DOMContentLoaded');
});

// ---- "no such client" is an offer, not a dead end -------------------------

test('a name that matches nothing offers to make it a new client', () => {
  // Chris, 2026-08-23: "will it recognize that the client doesnt exist and move
  // to New Client?" It used to just say "No client matches X." and leave him to
  // spot the "+ New client" link in the corner and retype the name.
  const fn = extractFunction(SRC, 'function nlClientSearch(q) {');
  assert.match(fn, /nl-addnew/);
  assert.match(fn, /as a new client/);
  assert.match(fn, /nlNewClientFrom\(raw\)/, 'and it must carry the typed name over');
  assert.ok(!/style="cursor:default;color:var\(--mut\)">No client matches/.test(fn),
    'the old dead-end row must be gone');
});

test('the name is offered as typed, not lowercased for matching', () => {
  const fn = extractFunction(SRC, 'function nlClientSearch(q) {');
  const rawAt = fn.indexOf('var raw =');
  const lowerAt = fn.indexOf("q = (q || '').toLowerCase()");
  assert.ok(rawAt > -1 && rawAt < lowerAt,
    'raw must be captured before q is lowercased, or the client is created as "ken frattaroli"');
});

test('the add-new row is wired as a listener, so an apostrophe cannot break it', () => {
  // O'Brien Renovations. Interpolating arbitrary user text into an inline
  // onclick attribute is how that button stops working.
  const fn = extractFunction(SRC, 'function nlClientSearch(q) {');
  assert.match(fn, /addNew\.onclick = function/);
  assert.ok(!/onclick="nlNewClientFrom/.test(fn));
});

test('the typed name is split the same way picking a real client splits it', () => {
  const ctx = { document: { getElementById: (id) => (ctx.els[id] || null) }, String, console };
  ctx.els = {};
  ctx.nlNewClient = () => { ctx.switched = true; };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SRC, 'function nlNewClientFrom(name) {'), ctx);
  const run = (name, pre) => {
    ctx.els = {
      'nl-first': { value: (pre && pre.first) || '', focus() { ctx.focused = true; } },
      'nl-last': { value: (pre && pre.last) || '' },
    };
    ctx.focused = false;
    ctx.nlNewClientFrom(name);
    return { first: ctx.els['nl-first'].value, last: ctx.els['nl-last'].value };
  };
  assert.deepEqual(run('Ken Frattaroli'), { first: 'Ken', last: 'Frattaroli' });
  assert.deepEqual(run('Zzzznomatch'), { first: 'Zzzznomatch', last: '' },
    'one word is a first name, not a surname');
  assert.deepEqual(run('Mary Jane Van Der Berg'), { first: 'Mary Jane Van Der', last: 'Berg' },
    'same last-space rule nlClientPick uses coming the other way');
  assert.deepEqual(run("O'Brien Renovations"), { first: "O'Brien", last: 'Renovations' });
  assert.deepEqual(run('   '), { first: '', last: '' }, 'whitespace is not a name');
  assert.deepEqual(run('Ken Frattaroli', { first: 'Alreadytyped', last: 'Here' }),
    { first: 'Alreadytyped', last: 'Here' }, 'never overwrite what he already typed');
  assert.equal(ctx.switched, true, 'and it actually switches to the new-client form');
});

// ---- the client-book retry --------------------------------------------------

function retrySandbox(opts) {
  const o = opts || {};
  const timers = [];
  const searched = [];
  let resolveBook;
  const book = new Promise((r) => { resolveBook = r; });
  const box = { style: { display: o.boxDisplay || 'block' }, innerHTML: '' };
  const input = { value: o.inputValue || 'Smithers' };
  const ctx = {
    console, Promise, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document: { getElementById: (id) => (id.indexOf('results') > -1 ? (o.noBox ? null : box) : (o.noInput ? null : input)) },
    window: {},
    REAL_LOADED: true, REAL_ERR: '',
    hlEsc: (x) => String(x),
    searched, timers, box, input,
    releaseBook: () => { resolveBook(); return book; },
  };
  ctx.__kicks = 0;
  if (!o.loaderMissing) {
    ctx.window.loadClientsLive = () => { ctx.__kicks++; return book; };
  }
  ctx.searchFn = (v) => searched.push(v);
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SRC, 'function hlClientBookRetry(inputId, boxId, searchFn, _tries){'), ctx);
  return ctx;
}

test('the dropdown comes back on its own, with no further keypress', async () => {
  // The whole complaint. It used to sit on "Loading clients..." until the user
  // happened to type another character -- and if they had finished typing the
  // name, forever.
  const ctx = retrySandbox();
  ctx.hlClientBookRetry('nl-search', 'nl-client-results', ctx.searchFn);
  assert.deepEqual(ctx.searched, [], 'nothing yet -- the book is still coming');
  await ctx.releaseBook();
  await Promise.resolve();
  assert.deepEqual(ctx.searched, ['Smithers']);
});

test('it re-reads the box, because they kept typing while it downloaded', async () => {
  const ctx = retrySandbox({ inputValue: 'Sm' });
  ctx.hlClientBookRetry('nl-search', 'nl-client-results', ctx.searchFn);
  ctx.input.value = 'Smithers Kitchen';   // four more letters during the wait
  await ctx.releaseBook();
  await Promise.resolve();
  assert.deepEqual(ctx.searched, ['Smithers Kitchen'],
    'replaying the stale query would show results for a name they moved past');
});

test('a dropdown the user already closed is left alone', async () => {
  const ctx = retrySandbox({ boxDisplay: 'none' });
  ctx.hlClientBookRetry('nl-search', 'nl-client-results', ctx.searchFn);
  await ctx.releaseBook();
  await Promise.resolve();
  assert.deepEqual(ctx.searched, [], 'reopening a list over a form they left is worse than nothing');
});

test('a client book that FAILS to load says so, instead of spinning forever', async () => {
  // Without this, the retry finds REAL_LOADED still false, renders "Loading
  // clients..." again and kicks another attempt: a spinner that never resolves
  // and never admits it is an error -- indistinguishable from the very bug this
  // helper exists to fix. Chris's standing rule: never hide a dead source.
  const ctx = retrySandbox();
  ctx.REAL_LOADED = false;
  ctx.REAL_ERR = 'HTTP 500 -- upstream boom';
  ctx.hlEsc = (x) => String(x);
  ctx.hlClientBookRetry('nl-search', 'nl-client-results', ctx.searchFn);
  await ctx.releaseBook();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(ctx.searched, [], 'must not re-run the search into another "Loading..."');
  assert.match(ctx.box.innerHTML, /Could not load clients/);
  assert.match(ctx.box.innerHTML, /upstream boom/, 'and it names the actual reason');
  assert.match(ctx.box.innerHTML, /try again/, 'with a way back');
});

test('a successful load is not mistaken for a failed one', async () => {
  const ctx = retrySandbox();
  ctx.REAL_LOADED = true;
  ctx.hlEsc = (x) => String(x);
  ctx.hlClientBookRetry('nl-search', 'nl-client-results', ctx.searchFn);
  await ctx.releaseBook();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(ctx.searched, ['Smithers']);
});

test('a loader that does not exist YET is waited for, not given up on', async () => {
  // loadClientsLive is declared in a later <script> block. The old
  // `typeof loadClientsLive === 'function'` guard was false on a cold landing
  // and fell straight through -- no request, no error, box stuck forever.
  const ctx = retrySandbox({ loaderMissing: true });
  ctx.hlClientBookRetry('nl-search', 'nl-client-results', ctx.searchFn);
  assert.equal(ctx.timers.length, 1, 'it must schedule another look');
  assert.ok(ctx.timers[0].ms > 0 && ctx.timers[0].ms <= 1000);
  // The block finishes loading; the next look finds it.
  ctx.window.loadClientsLive = () => { ctx.__kicks++; return ctx.releaseBook(); };
  ctx.timers[0].fn();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ctx.__kicks, 1, 'and it actually kicks the load once it is there');
});

test('waiting for the loader gives up eventually instead of spinning forever', () => {
  const ctx = retrySandbox({ loaderMissing: true });
  let n = 0;
  ctx.hlClientBookRetry('nl-search', 'nl-client-results', ctx.searchFn);
  while (ctx.timers.length > n && n < 500) { n++; ctx.timers[n - 1].fn(); }
  assert.ok(ctx.timers.length < 200, 'bounded, got ' + ctx.timers.length);
  assert.ok(ctx.timers.length > 5, 'but patient enough to cover a slow boot');
});

// ---- one flight for the client book ----------------------------------------

test('every search box shares ONE download of the client book', () => {
  // REAL_LOADED only flips on success, so four keystrokes used to start four
  // separate fetches of ~8,700 rows, racing each other and making the very
  // load the dropdown was waiting on slower.
  const fn = extractFunction(SRC, 'function loadClientsLive(){');
  assert.match(fn, /if\(_clientBookFlight\) return _clientBookFlight/,
    'an in-flight load must be shared, not restarted');
  assert.match(fn, /_clientBookFlight = _clientBookFlight\.then\(function\(\)\{ _clientBookFlight = null; \}\)/,
    'and cleared afterwards either way, so a failed load stays retryable');
});

test('loadClientsLive hands back something a caller can wait on', () => {
  const fn = extractFunction(SRC, 'function loadClientsLive(){');
  // The already-loaded early return has to be thenable too, or the retry
  // helper silently does nothing for every caller after the first.
  const earlyReturn = fn.slice(fn.indexOf('if(REAL_LOADED)'), fn.indexOf('if(REAL_LOADED)') + 120);
  assert.match(earlyReturn, /return Promise\.resolve\(\)/,
    'the already-loaded path must be thenable too, or the retry helper does nothing for every caller after the first');
});

test('all three client search boxes use the retry, not the old dead guard', () => {
  const wired = [...SRC.matchAll(/hlClientBookRetry\('([^']+)',\s*'([^']+)'/g)].map((m) => m[2]);
  for (const box of ['nl-client-results', 'ef-client-results', 'rlm-referredby-results']) {
    assert.ok(wired.includes(box), box + ' must be wired to the retry; wired: ' + wired.join(', '));
  }
  assert.ok(!/if\s*\(typeof loadClientsLive\s*===\s*'function'\)\s*loadClientsLive\(\);\s*return;/.test(SRC),
    'the old fall-through guard must be gone -- it silently did nothing');
});

test('the ids handed to the retry are ids that actually exist in the page', () => {
  // A typo here fails exactly like the bug being fixed: silently, with the box
  // stuck on "Loading clients...". I got two of them wrong on the first pass.
  const ids = [...SRC.matchAll(/hlClientBookRetry\('([^']+)',\s*'([^']+)'/g)];
  assert.ok(ids.length >= 3, 'expected all three search boxes, got ' + ids.length);
  for (const [, inputId, boxId] of ids) {
    assert.ok(SRC.includes('id="' + inputId + '"'), 'no element with id ' + inputId);
    assert.ok(SRC.includes('id="' + boxId + '"'), 'no element with id ' + boxId);
  }
});

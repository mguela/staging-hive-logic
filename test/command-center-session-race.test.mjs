import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression coverage for the Command Center cold-login session race
// (fix/command-center-session-race, 2026-08-15).
//
// Command Center's widget loaders (loadMapLive / loadWatchingLive /
// loadDispatchAlertsLive / loadTodaySchedule / loadOpenItems, plus the Team
// To-Do panel) used to fire at top-level script-parse time, BEFORE Supabase had
// restored the session from storage. On a cold login their /api fetches raced
// the window.fetch auth shim's token-wait and came back 401 "Authentication
// required", so every one of those widgets rendered blank / "not connected"
// until a manual Ctrl+R. This is the same class of bug already fixed for the
// Schedule board (loadEmployeeRoster, ab7469b), the Reina brief and the Pulse
// gauges. The fix defers each widget's FIRST load past parse -- the big batch is
// gated through DOMContentLoaded + hlRequireSession, and the Team To-Do IIFE is
// deferred to DOMContentLoaded to match its sibling Reina brief.
//
// These are structural checks against the REAL public/index.html source: no
// mocks of the page, just extract the fix's own blocks (anchored on their dated
// comments) and prove behavior in a VM sandbox, plus anti-regression guards on
// the pre-fix bare-call signatures.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'public', 'index.html');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

// The Command Center layout engine and the Pulse widget moved out of the page on
// 2026-08-17 (docs/COMMAND-CENTER-EXTRACTION-SCOPE.md). The session-race
// properties this file guards are properties of the APP, not of one file, so
// anything that counts or searches across "everything the Command Center runs"
// has to look at all three -- otherwise extraction would silently shrink the
// thing being measured and the test would pass by having less to check.
const CC_MODULES = ['app-command-center.js', 'app-command-center-pulse.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf-8'));
const allCcSource = [source, ...CC_MODULES].join('\n');

// The widget loaders that were blank on cold login -- one per in-scope Command
// Center widget the initial batch is responsible for.
const IN_SCOPE_BATCH_LOADERS = [
  'loadMapLive',        // Service Area Map
  'loadWatchingLive',   // Watching panel
  'loadDispatchAlertsLive',
  'loadTodaySchedule',
  'loadOpenItems',      // Notifications / Open Hub
  'teamTodoLoad',       // Team To-Do
];

// Every loader the gated batch is expected to fan out to (so the sandbox can
// stub them and we can prove none are dropped by the gating wrapper).
const ALL_BATCH_LOADERS = [
  'loadOwed', 'loadIncoming', 'loadFinancials', 'loadJobHealthTicker', 'loadLeadsLive',
  'loadJobsLive', 'loadClientsLive', 'loadWatchingLive', 'loadApOverdue', 'loadJobsAttention',
  'loadTodaySchedule', 'loadJobsBoardLive', 'loadDispatchAlertsLive', 'crewSwapInit',
  'loadEstimatesLive', 'loadScheduleLive', 'loadFinancialLive', 'loadOpenItems',
  'loadMapLive', 'loadRealClock', 'teamTodoLoad',
];

// ---- Extract the gated-initial-load block the fix introduced -----------------
// Anchored on the dated fix comment so we grab this exact occurrence and not one
// of the several other "readyState === 'loading' ... DOMContentLoaded" idioms
// reused elsewhere on the page.
function extractGatedBatchBlock(src) {
  const commentMarker = 'Session-race fix (2026-08-15, fix/command-center-session-race): every Command Center';
  const commentAt = src.indexOf(commentMarker);
  if (commentAt === -1) throw new Error('CC batch session-race fix comment not found');
  const start = src.indexOf('function ccInitialWidgetLoad(){', commentAt);
  if (start === -1) throw new Error('ccInitialWidgetLoad() definition not found after its comment');
  // Include the fresh-login re-run listener that follows the DOMContentLoaded gate.
  const endMarker = "window.addEventListener('hl:signed-in', function(){ ccGatedInitialWidgetLoad(false); });";
  const endAt = src.indexOf(endMarker, start);
  if (endAt === -1) throw new Error("CC batch 'hl:signed-in' re-run listener not found");
  return src.slice(start, endAt + endMarker.length);
}

const BATCH_BLOCK = extractGatedBatchBlock(source);

// Run the extracted block in a sandbox. `sessionMode` controls what our stub
// hlRequireSession does: 'present' -> onSession, 'missing' -> onMissing,
// 'absent' -> window.hlRequireSession itself is undefined.
function runBatchBlock(readyState, sessionMode, hash = '') {
  const state = { loads: {}, requireSessionCalls: 0, dclHandler: null, signedInHandler: null, retryHandler: null };
  ALL_BATCH_LOADERS.forEach((name) => { state.loads[name] = 0; });

  const sandbox = {
    location: { hash },
    document: {
      readyState,
      addEventListener: function (ev, fn) { if (ev === 'DOMContentLoaded') state.dclHandler = fn; },
    },
    window: {
      __hlAccessToken: null,
      addEventListener: function (ev, fn) { if (ev === 'hl:signed-in') state.signedInHandler = fn; },
    },
    setTimeout: function(fn){ state.retryHandler = fn; return 1; },
    clearTimeout: function(){ state.retryHandler = null; },
  };
  ALL_BATCH_LOADERS.forEach((name) => {
    sandbox[name] = function () { state.loads[name]++; };
  });
  state.sessionMode = sessionMode; // mutable: a test can flip 'missing' -> 'present' at login
  if (sessionMode !== 'absent') {
    sandbox.window.hlRequireSession = function (onSession, onMissing) {
      state.requireSessionCalls++;
      if (state.sessionMode === 'present') return onSession({ access_token: 'tok' });
      return onMissing && onMissing();
    };
  }

  vm.createContext(sandbox);
  vm.runInContext(BATCH_BLOCK, sandbox, { filename: SRC_PATH });
  return { state, sandbox };
}

test('an explicit non-Command-Center deep link does not preload the whole dashboard behind it', () => {
  const { state } = runBatchBlock('loading', 'present', '#/docs');
  state.dclHandler();
  assert.strictEqual(state.requireSessionCalls, 0);
  assert.deepStrictEqual(ALL_BATCH_LOADERS.filter((n) => state.loads[n] > 0), []);
});

test('while the document is still parsing, NONE of the Command Center widget loaders fire synchronously (that is the cold-login race)', () => {
  const { state } = runBatchBlock('loading', 'present');
  const fired = ALL_BATCH_LOADERS.filter((n) => state.loads[n] > 0);
  assert.deepStrictEqual(fired, [], 'no loader may run during parse -- they must wait for DOMContentLoaded + session');
  assert.strictEqual(state.requireSessionCalls, 0, 'hlRequireSession must not be consulted until after parse');
  assert.strictEqual(typeof state.dclHandler, 'function', 'a DOMContentLoaded listener must be registered to run the first load after parse');
});

test('on DOMContentLoaded with a restored session, the initial load routes through hlRequireSession and every in-scope widget loads exactly once', () => {
  const { state } = runBatchBlock('loading', 'present');
  state.dclHandler(); // browser fires DOMContentLoaded (auth shim + session now ready)
  assert.strictEqual(state.requireSessionCalls, 1, 'the initial batch must be gated through hlRequireSession, not fired bare');
  IN_SCOPE_BATCH_LOADERS.forEach((n) => {
    assert.strictEqual(state.loads[n], 1, `${n} (in-scope Command Center widget) must load exactly once on first load`);
  });
  // No loader double-fires from the gating wrapper.
  ALL_BATCH_LOADERS.forEach((n) => {
    assert.ok(state.loads[n] <= 1, `${n} must not be invoked more than once by the gate`);
  });
});

test('genuinely logged-out cold load does not invoke authenticated widget loaders or generate a 401 batch', () => {
  const { state } = runBatchBlock('loading', 'missing');
  state.dclHandler();
  assert.strictEqual(state.requireSessionCalls, 1);
  IN_SCOPE_BATCH_LOADERS.forEach((n) => {
    assert.strictEqual(state.loads[n], 0, `${n} must wait for an authenticated session`);
  });
});

test('if the document is already past parsing, the gated load still runs (readyState !== "loading")', () => {
  const { state } = runBatchBlock('complete', 'present');
  assert.strictEqual(state.requireSessionCalls, 1, 'already-interactive load path must still go through hlRequireSession');
  IN_SCOPE_BATCH_LOADERS.forEach((n) => {
    assert.strictEqual(state.loads[n], 1, `${n} must load once when readyState is already complete`);
  });
});

test('auth-helper unavailable path fails closed and retries without issuing unauthenticated requests', () => {
  const { state, sandbox } = runBatchBlock('loading', 'absent');
  state.dclHandler();
  IN_SCOPE_BATCH_LOADERS.forEach((n) => {
    assert.strictEqual(state.loads[n], 0, `${n} must not bypass the missing session gate`);
  });
  assert.strictEqual(typeof state.retryHandler, 'function', 'a bounded auth-readiness retry must be scheduled');
  state.sessionMode = 'present';
  sandbox.window.hlRequireSession = function(onSession){
    state.requireSessionCalls++;
    return onSession({ access_token: 'tok' });
  };
  state.retryHandler();
  IN_SCOPE_BATCH_LOADERS.forEach((n) => {
    assert.strictEqual(state.loads[n], 1, `${n} must start after the auth helper becomes ready`);
  });
});

test('the CC batch registers an hl:signed-in listener (the fresh-login re-run hook)', () => {
  const { state } = runBatchBlock('loading', 'missing');
  assert.strictEqual(typeof state.signedInHandler, 'function', 'a window "hl:signed-in" listener must be registered so the batch re-runs when the user logs in without a page reload');
});

test('cold fresh-login sequence: loaders stay silent while logged out, then run with a token when hl:signed-in fires', () => {
  // 1. Page opens on the login screen: DOMContentLoaded fires while logged OUT.
  const { state, sandbox } = runBatchBlock('loading', 'missing');
  state.dclHandler();
  // onMissing does not call any authenticated loader, so no Track 1 / Visual
  // Intelligence 401 batch is manufactured behind the login screen.
  IN_SCOPE_BATCH_LOADERS.forEach((n) => {
    assert.strictEqual(state.loads[n], 0, `${n} stays stopped on the logged-out DOMContentLoaded pass`);
  });
  // 2. User signs in (client-side, no reload). Session now present; the app fires hl:signed-in.
  state.sessionMode = 'present';
  assert.strictEqual(typeof state.signedInHandler, 'function', 'the sign-in re-run listener must exist');
  state.signedInHandler();
  // Each in-scope widget now runs once through the present-session branch.
  IN_SCOPE_BATCH_LOADERS.forEach((n) => {
    assert.strictEqual(state.loads[n], 1, `${n} must start exactly once on hl:signed-in`);
  });
  assert.strictEqual(sandbox.window.__hlAccessToken, 'tok', 'the authenticated gate must publish the current token before polling starts');
  assert.ok(state.requireSessionCalls >= 2, 'both the DOMContentLoaded pass and the hl:signed-in pass route through hlRequireSession');
});

test('anti-regression: the pre-fix bare top-level widget batch (loadOwed(); loadIncoming(); ... at column 0) must not come back', () => {
  // The pre-fix bug signature was these loaders as unindented, top-level
  // statements executing at script-parse time. After the fix they live inside
  // ccInitialWidgetLoad(){...} (indented) and are only reached via the gate.
  assert.ok(
    !/\nloadOwed\(\); loadIncoming\(\);/.test(source),
    'a column-0 (top-level) loadOwed(); loadIncoming(); ... batch is the cold-login race and must not return'
  );
  assert.ok(
    !/\nloadEstimatesLive\(\); loadScheduleLive\(\); loadFinancialLive\(\); loadOpenItems\(\); loadMapLive\(\); loadRealClock\(\);/.test(source),
    'the second bare top-level loader line (…loadMapLive(); loadRealClock();) must not return'
  );
});

// ---- Team To-Do widget -------------------------------------------------------
// Rewired 2026-08-16 (operational Team To-Do): the card no longer reads
// reina_todo on an hourly local interval. It loads HiveConnect tasks +
// computed detections through hlRequireSession, and its periodic refresh runs
// through the shared ccRunIfStale guard with the other CC widgets. The
// cold-login race this file exists to prevent is unchanged in kind, so the
// same property is asserted against the new loader.
test('Team To-Do: loading is gated behind hlRequireSession and owned by the shared CC lifecycle', () => {
  // Pre-fix signature: a bare `load();` immediately before `setInterval(load, 3600000)`.
  assert.ok(
    !/\n\s*load\(\);\s*\n\s*setInterval\(load, 3600000\)/.test(source),
    'a bare synchronous load(); right before the hourly interval is the Team To-Do cold-login race and must not come back'
  );
  const todoAnchor = source.indexOf('function teamTodoLoad()');
  assert.ok(todoAnchor !== -1, 'Team To-Do loader (teamTodoLoad) must exist');
  const window0 = source.slice(todoAnchor, todoAnchor + 9000);
  assert.ok(
    /hlRequireSession\(async function\(sess\)\{/.test(window0),
    'teamTodoLoad must fetch inside hlRequireSession so it never races the session restore'
  );
  // 2026-08-16: the gate is now wrapped in teamTodoWithTimeout, so a session
  // gate that never settles reports an error instead of leaving the card
  // silently stuck -- the failure that made a completion click look like a no-op.
  assert.ok(
    /teamTodoWithTimeout\(hlRequireSession\(/.test(window0),
    'the session gate must be bounded by a timeout, not awaited forever'
  );
  assert.doesNotMatch(window0, /DOMContentLoaded', teamTodoLoad|hl:signed-in', teamTodoLoad/,
    'Team To-Do must not independently load on boot/sign-in while another view is active');
  assert.match(BATCH_BLOCK, /teamTodoLoad\(\)/,
    'the session/view-gated CC batch must own Team To-Do initial and fresh-login loads');
  assert.ok(
    !/setInterval\(teamTodoLoad/.test(source),
    'Team To-Do must not keep a private refresh interval -- it refreshes through ccRunIfStale'
  );
  assert.ok(
    /ccRunIfStale\('teamTodo', teamTodoLoad, 30000\)/.test(source),
    "Team To-Do's periodic refresh must run through the shared ccRunIfStale guard"
  );
});

test('Dev To-Do exception queue is session-gated too', () => {
  const devAnchor = source.indexOf('function devTodoLoad()');
  assert.ok(devAnchor !== -1, 'devTodoLoad must exist -- the exception queue needs a home');
  const win = source.slice(devAnchor, devAnchor + 1200);
  assert.ok(/hlRequireSession\(/.test(win), 'devTodoLoad must fetch inside hlRequireSession');
  assert.ok(/resource=app_status_findings/.test(win), 'devTodoLoad must read the issue/blocker findings');
  assert.ok(!/resource=reina_todo_get/.test(win), 'Dev To-Do must not resurrect the stale snapshot');
});

// ---- The sign-in broadcast: the actual cold-login fix -------------------------
// Login is a client-side transition (no page reload), so DOMContentLoaded already
// ran while logged out. The fix broadcasts 'hl:signed-in' from the login success
// handler (token already in localStorage by then) and every CC widget re-loads.
test('the login success handler dispatches hl:signed-in after the session is confirmed', () => {
  const lg = source.indexOf('async function lgSubmit()');
  assert.ok(lg !== -1, 'lgSubmit (the password login handler) must exist');
  const okBranch = source.indexOf('if(!result.error&&result.data.session){', lg);
  assert.ok(okBranch !== -1, 'lgSubmit success branch (session confirmed) must exist');
  const win = source.slice(okBranch, okBranch + 1400);
  assert.ok(
    /window\.dispatchEvent\(new Event\('hl:signed-in'\)\)/.test(win),
    "lgSubmit must broadcast 'hl:signed-in' on successful login so the CC widgets re-load without a page reload"
  );
});

test('every in-scope Command Center widget has a sign-in reload path', () => {
  // Counted across the page AND the extracted Command Center modules: two of
  // these listeners now live in app-command-center*.js, and counting only
  // index.html would let the extraction "fix" this test by shrinking it.
  const listeners = allCcSource.match(/window\.addEventListener\('hl:signed-in'/g) || [];
  // Daily Brief, Pulse, Team To-Do, and the auxiliary cards are deliberately
  // centralized through the CC batch now, eliminating their duplicate
  // listeners. The batch plus the independently owned groups still supply at
  // least four listeners.
  assert.ok(listeners.length >= 4, `expected >=4 hl:signed-in listeners after consolidation, found ${listeners.length}`);
  assert.match(source, /if\(typeof window\.hlDailyBriefReload==='function'\) window\.hlDailyBriefReload\(\)/);
  assert.match(source, /if\(typeof window\.pgReload==='function'\) window\.pgReload\(\)/);
});

test('the poll-less weather/watching/notifications IIFE is owned by the session/view-gated CC batch', () => {
  const notif = source.indexOf("hlApiGet('notifications')");
  assert.ok(notif !== -1, 'the CC notifications loader must exist');
  // Body opens with run() wrapping the three hlApiGet calls (weather/watching_all/notifications).
  assert.ok(
    /function run\(\)\{\s*\n\s*hlApiGet\('weather'\)/.test(source),
    'the weather/watching/notifications body must be wrapped in run() so it can re-run'
  );
  // It must not make a signed-out or off-view request; the shared CC batch is
  // its only boot path.
  const tail = source.slice(notif, notif + 2000);
  assert.ok(
    /window\.hlCcAuxReload = run;/.test(tail),
    'the notifications IIFE must export its loader to the shared CC lifecycle'
  );
  assert.ok(!/\n\s*run\(\);/.test(tail), 'the notifications IIFE must not run while the login overlay is active');
  assert.match(BATCH_BLOCK, /if\(typeof window\.hlCcAuxReload==='function'\) window\.hlCcAuxReload\(\)/,
    'the session/view-gated CC batch must invoke the auxiliary loader');
});

// ---- The gate function itself must exist and be global -----------------------
test('hlRequireSession (the session gate the fix relies on) is defined and exposed on window', () => {
  assert.ok(/async function hlRequireSession\(onSession, onMissing\)/.test(source), 'hlRequireSession must be defined');
  assert.ok(/window\.hlRequireSession = hlRequireSession/.test(source), 'hlRequireSession must be exposed on window for the gate to reach it');
});

// ---- Already-gated in-scope widgets: prove they remain gated ------------------
test('Reina brief / Today\'s Decisions is owned by the gated shared CC lifecycle', () => {
  assert.match(source, /window\.hlDailyBriefReload = load/,
    'the brief must export its loader instead of starting during parse');
  assert.match(source, /if\(typeof window\.hlDailyBriefReload==='function'\) window\.hlDailyBriefReload\(\)/,
    'the session-gated initial batch must invoke the brief');
  assert.match(source, /ccRunIfStale\('dailyBrief', window\.hlDailyBriefReload, 30000\)/,
    'the one shared CC timer must own brief refresh');
  assert.doesNotMatch(source, /setInterval\(load,\s*60000\)/,
    'the brief must not recreate an independent immortal timer');
});

test('Pulse gauges boot stays gated behind DOMContentLoaded (already-fixed, still in scope)', () => {
  // Now in its own module. The gate matters MORE there, not less: an external
  // script can finish loading at a different moment than an inline block would
  // have run, so the readyState check is what keeps boot off raw parse time.
  const [, pulse] = CC_MODULES;
  assert.ok(
    /if\(document\.readyState==='loading'\) document\.addEventListener\('DOMContentLoaded', boot\); else boot\(\);/.test(pulse),
    'Pulse gauges must boot on DOMContentLoaded, not at raw parse time'
  );
  assert.match(source, /<script src="\/app-command-center-pulse\.js"><\/script>/,
    'and the page must load that module, or the gate above guards nothing');
});

test('Notifications first load stays deferred behind DOMContentLoaded (already-fixed, still in scope)', () => {
  assert.ok(
    /if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', function\(\)\{ setTimeout\(hlLoadRealNotifs, 800\); \}\);/.test(source),
    'Notifications must defer its first hlLoadRealNotifs past parse'
  );
});

// ---- Polling / interval refresh must be untouched by this fix -----------------
test('polling/interval refresh (ccRunIfStale + its cadences) is preserved -- the fix only touched the initial load', () => {
  assert.ok(/function ccRunIfStale\(name, fn, minMs\)/.test(source), 'ccRunIfStale duplicate-refresh guard must remain');
  // Representative interval cadences from the CC refresh block must still be present.
  assert.ok(/ccRunIfStale\('map', loadMapLive, 30000\)/.test(source), 'map refresh interval must remain');
  assert.ok(/ccRunIfStale\('watching', loadWatchingLive, 30000\)/.test(source), 'watching refresh interval must remain');
  assert.ok(/ccRunIfStale\('dispatchAlerts', loadDispatchAlertsLive, 30000\)/.test(source), 'dispatchAlerts refresh interval must remain');
  assert.ok(/ccRunIfStale\('todaySchedule', loadTodaySchedule, 30000\)/.test(source), 'todaySchedule refresh interval must remain');
});

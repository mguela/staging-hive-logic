// test/hiveconnect-script-order.test.mjs
//
// HiveConnect has no module system: every file under public/hiveconnect/ is a
// classic script sharing one global lexical scope, loaded in a fixed order with
// app.js LAST. That arrangement has exactly two failure modes, and this repo has
// now hit both.
//
//   1. A file loaded before app.js reaches for something app.js declares, at
//      script-evaluation time. `const $ = id => ...` lives in app.js, so a
//      top-level `$(...)` in tasks.js threw "$ is not defined" on every page
//      load -- confirmed in Chromium against the real page. The throw aborted
//      the rest of that file's top-level statements, which silently cost the
//      Tasks tab three controls: Enter-to-create, Refresh, and More details.
//      Nothing looked broken. The tab opened, the sidebar rendered, the buttons
//      were there. They just did nothing.
//
//   2. The embedded mount keeps its OWN copy of the script list (it strips the
//      tags out of the fetched markup and loads them itself). That list has
//      drifted from the standalone page twice already -- both times a feature
//      simply did not exist in the embedded app, with a ReferenceError as the
//      only clue. public/hiveconnect-mount.js carries two long comments about
//      it. A test is cheaper than a third comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../public/hiveconnect/', import.meta.url);
const standalone = readFileSync(new URL('index.html', dir), 'utf-8');
const mount = readFileSync(new URL('../public/hiveconnect-mount.js', import.meta.url), 'utf-8');

const scriptsInOrder = [...standalone.matchAll(/src="([a-z-]+\.js)/g)].map((m) => m[1]);

test('app.js loads LAST -- everything else may depend on it, never the reverse', () => {
  assert.ok(scriptsInOrder.length > 3, 'sanity: found the script list');
  assert.equal(scriptsInOrder[scriptsInOrder.length - 1], 'app.js');
});

test('the embedded mount loads exactly the same scripts as the standalone page', () => {
  const mounted = [...mount.matchAll(/loadScript\('\/hiveconnect\/([a-z-]+\.js)/g)].map((m) => m[1]);
  assert.deepEqual([...mounted].sort(), [...scriptsInOrder].sort(),
    'a script missing here does not fail loudly -- the feature simply does not exist in the embedded app');
});

// Strip comments and string literals, then walk the file tracking brace depth.
// Anything at depth 0 runs the moment the file is evaluated -- before app.js.
function topLevelCode(src) {
  let out = '';
  let depth = 0, i = 0;
  const s = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(') { if (c === '{') depth++; }
    if (c === '}') { depth--; continue; }
    if (depth === 0) out += c;
  }
  return out;
}

test('no script loaded before app.js touches app.js bindings at load time', () => {
  // `$` is the one that actually bit, but the same trap exists for every
  // binding app.js owns and everything else borrows.
  const APP_OWNED = ['$', 'sb', 'me', 'profiles', 'channels', 'esc', 'railToast'];
  const before = scriptsInOrder.slice(0, -1);
  for (const file of before) {
    const src = readFileSync(new URL(file, dir), 'utf-8');
    const top = topLevelCode(src);
    for (const name of APP_OWNED) {
      const used = new RegExp(`(^|[^.\\w$])\\${name === '$' ? '\\$' : name}\\s*[(.[]`).test(top);
      assert.ok(!used,
        `${file} uses app.js's \`${name}\` at top level, which runs BEFORE app.js exists. ` +
        'Move it into a function called after boot -- see bindTasksControls() in tasks.js.');
    }
  }
});

// ---- the specific fix -------------------------------------------------------

test("the Tasks tab's controls are bound when the tab opens, not at load", () => {
  const tasks = readFileSync(new URL('tasks.js', dir), 'utf-8');
  assert.match(tasks, /function bindTasksControls\(\)/);
  assert.match(tasks, /async function openTasksTabNative\(\) \{\s*\n\s*bindTasksControls\(\);/,
    'binding must happen on open, which is after app.js by construction');
});

test('binding twice does not stack duplicate listeners', () => {
  const tasks = readFileSync(new URL('tasks.js', dir), 'utf-8');
  assert.match(tasks, /if \(tasksControlsBound\) return;/,
    'the tab can be opened many times; each open must not add another handler');
  assert.match(tasks, /tasksControlsBound = true;/);
});

// ---- a THIRD failure mode: not timing, the module boundary itself --------
//
// Self-test 2026-08-18: "Uncaught ReferenceError: me is not defined
// @tasks.js:219", clicking "More Details" -- the exact control the fix above
// already re-bound. Binding the click handler after app.js loads is not
// enough: hiveconnect-mount.js MUST load app.js as an ES module (to avoid
// colliding with HiveLogic's own global `var sb`), and a module's top-level
// `let`/`const` bindings are NEVER visible to sibling classic scripts,
// regardless of load order or timing. `me` is declared `let me = null` in
// app.js -- openTaskDetail() in tasks.js references bare `me` at click time,
// long after app.js has finished loading, and it still throws in the
// mounted context specifically. The "no top-level access" test above cannot
// see this: openTaskDetail's body only runs on click, never at parse time.
test('me is reachable from tasks.js even when app.js loads as a module (mounted context), not just after load-time', () => {
  const app = readFileSync(new URL('app.js', dir), 'utf-8');
  // The fix: every assignment to `me` also writes window.me, so a bare `me`
  // reference in a classic script sibling resolves via the global object
  // regardless of whether app.js itself was loaded as a module. Checked as
  // three specific, known sites rather than generically parsed -- a generic
  // `me = ...` scan over the whole file also matches this comment's own
  // prose, which is exactly the kind of false match a real regex parse of
  // JS should not be doing in a test.
  assert.match(app, /let me = null;[^\n]*\r?\n\s*window\.me = null;/, 'the initial value must be mirrored too, not just later reassignments');
  assert.match(app, /me = profiles\.get\(myId\);\r?\n\s*window\.me = me;/);
  assert.match(app, /profiles\.set\(data\.id, data\); me = data; window\.me = me;/);
});

// ---- a fourth instance of the same module-boundary bug --------------------
//
// Self-test, recurring since 2026-08-19: "Uncaught ReferenceError:
// TASK_STATUSES is not defined @tasks.js:230". Same root cause as `me`
// above, just missed for these three -- openTaskDetail() (also body-only, so
// the top-level scan above cannot see it) references bare TASK_STATUSES,
// TASK_STATUS_LABEL, and TASK_WAITING_REASONS, all declared `const` in
// app.js and invisible to tasks.js once app.js loads as a module in the
// mounted context.
test('TASK_STATUSES, TASK_STATUS_LABEL, and TASK_WAITING_REASONS are reachable from tasks.js in the mounted context too', () => {
  const app = readFileSync(new URL('app.js', dir), 'utf-8');
  const start = app.indexOf('const TASK_STATUSES = ');
  assert.ok(start > -1, 'sanity: the task-status constants still live in app.js');
  const block = app.slice(start, app.indexOf('/* ====', start + 1));
  for (const name of ['TASK_STATUSES', 'TASK_STATUS_LABEL', 'TASK_WAITING_REASONS']) {
    assert.match(block, new RegExp(`const ${name} = `), `sanity: ${name} still declared here`);
    assert.match(block, new RegExp(`window\\.${name} = ${name};`),
      `${name} must be mirrored onto window, the same fix already applied to \`me\``);
  }
});

// ---- a fifth instance, found chasing the fourth to its actual end --------
//
// Self-test 2026-08-22: after the TASK_STATUSES fix landed, a fresh run hit
// the NEXT unmirrored binding in the same function: "Uncaught
// ReferenceError: $ is not defined @tasks.js:255". `$`, `profiles`,
// `channels`, and `railToast` are all in the same APP_OWNED family as `me`
// and TASK_STATUSES, and none of them collide with anything HiveLogic's own
// index.html declares globally, so all four get the same one-line mirror.
// `sb` and `esc` are deliberately EXCLUDED: HiveLogic's own index.html
// declares its own global `sb` (the documented reason app.js loads as a
// module here at all) and its own global `esc` (a different HTML-escaping
// function) -- mirroring either would silently overwrite HiveLogic's own
// version for the rest of the page's life once HiveConnect mounts, trading
// a broken HiveConnect feature for corrupted HiveLogic behavior elsewhere.
test('$, profiles, channels, and railToast are reachable from tasks.js in the mounted context too', () => {
  const app = readFileSync(new URL('app.js', dir), 'utf-8');
  assert.match(app, /const \$ = id => document\.getElementById\(id\);\r?\n(?:[^\n]*\r?\n)*?\s*window\.\$ = \$;/);
  assert.match(app, /let profiles = new Map\(\);[^\n]*\r?\n\s*window\.profiles = profiles;/);
  assert.match(app, /let channels = new Map\(\);[^\n]*\r?\n\s*window\.channels = channels;/);
  assert.match(app, /clearTimeout\(railToastT\); railToastT = setTimeout\(\(\) => t\.classList\.remove\('show'\), 2600\);\r?\n\}\r?\n\s*window\.railToast = railToast;/);
});

test('sb and esc are deliberately NOT mirrored onto window -- both collide with a real HiveLogic global', () => {
  const app = readFileSync(new URL('app.js', dir), 'utf-8');
  assert.doesNotMatch(app, /window\.sb = sb/, 'sb collides with HiveLogic\'s own global `var sb` -- the reason app.js loads as a module at all');
  assert.doesNotMatch(app, /window\.esc = esc/, 'esc collides with HiveLogic\'s own global `esc` HTML-escaping function');
  // Confirm the collisions this guard exists for are actually real, not a
  // stale assumption -- if either global disappears from HiveLogic's own
  // page, this test should start failing loudly so the exclusion above gets
  // revisited rather than silently going stale.
  const page = readFileSync(new URL('../../public/index.html', dir), 'utf-8');
  assert.match(page, /function esc\(s\)\{/, 'sanity: HiveLogic\'s own top-level esc() must still exist for this exclusion to make sense');
});

test('all three controls are actually bound, not just the one that threw first', () => {
  const tasks = readFileSync(new URL('tasks.js', dir), 'utf-8');
  // bindTasksControls sits after openTasksTabNative in the file, so the slice
  // runs to the end rather than between the two.
  const block = tasks.slice(tasks.indexOf('function bindTasksControls()'));
  for (const id of ['tsk-new-title', 'tsk-refresh', 'tsk-more-details']) {
    assert.ok(block.includes(id), `${id} lost its listener to the throw and must get it back`);
  }
  assert.match(block, /quickCreateTask\(\)/);
  assert.match(block, /addEventListener\('click', loadTasksNative\)/);
});

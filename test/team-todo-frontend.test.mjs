// test/team-todo-frontend.test.mjs
// Team To-Do rewire (2026-08-16) -- the Command Center card itself.
//
// The rendering rules are extracted straight out of public/index.html and run
// in a vm sandbox (same technique as marketing-cc-duplicate-refresh-guard and
// schedule-board-map-state), so what is tested is the shipped code, not a
// copy of it.
//
// What it holds:
//   * two sections, "Tasks" (checkboxes) and "Needs attention" (tappable rows)
//   * "Nothing queued right now." when both are empty
//   * an unavailable detection still renders, muted, with the real reason
//   * the separation rule: anything not category:'execution' never renders here
//   * "＋ Task" routes to the existing HiveConnect Tasks UI -- no rebuilt form
//   * reina_todo is not read by this card any more

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
function extractLine(src, snippet) {
  const start = src.indexOf(snippet);
  if (start === -1) throw new Error('line not found: ' + snippet);
  return src.slice(start, src.indexOf('\n', start));
}

const PURE = [
  extractFunction(source, 'function teamTodoPriorityPip(priority)'),
  extractFunction(source, 'function teamTodoEsc(s)'),
  extractFunction(source, 'function teamTodoSafeId(id)'),
  extractFunction(source, 'function teamTodoDueChip(due, nowMs)'),
  extractFunction(source, 'function teamTodoDedupe(rows, decisions)'),
  extractFunction(source, 'function teamTodoSectionLabel(text)'),
  extractFunction(source, 'function teamTodoTaskRowHtml(t, nowMs)'),
  extractFunction(source, 'function teamTodoDetectionRowHtml(r)'),
  extractFunction(source, 'function teamTodoBuildHtml(state, nowMs)'),
].join('\n\n');

// teamTodoEsc uses document.createElement -- a 12-line stand-in is enough and
// keeps this test dependency-free (no jsdom in this repo).
const DOM_SHIM = `
  var document = {
    createElement: function(){ return {
      set textContent(v){ this._t = String(v == null ? '' : v); },
      get textContent(){ return this._t || ''; },
      get innerHTML(){ return (this._t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    }; }
  };
  var window = { HL_TODAY_DECISIONS: null };
`;

function sandbox() {
  // setTimeout/clearTimeout/console are host globals the sandbox does not get
  // for free; teamTodoWithTimeout and teamTodoLog need them.
  const ctx = vm.createContext({ setTimeout, clearTimeout, console, Promise });
  vm.runInContext(DOM_SHIM + '\n' + PURE, ctx);
  return ctx;
}

const NOW = Date.parse('2026-08-16T12:00:00Z');
const TASK = { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'Pay Ferguson invoice', ownerInitials: 'JR', dueDate: '2026-08-18', priority: 'high', tag: '231-003' };
const DETECTION = { key: 'vendor_payments_due', category: 'execution', icon: '💸', label: 'Vendor payments due', view: 'financial', state: 'ok', count: 3, amount: 4210.5, detail: '1 past due · rest due within 7 days' };

test('both sections render: Tasks with a checkbox, Needs attention with a tappable row', () => {
  const ctx = sandbox();
  const html = ctx.teamTodoBuildHtml({ tasks: [TASK], detections: [DETECTION] }, NOW);
  assert.match(html, />Tasks</);
  assert.match(html, />Needs attention</);
  assert.match(html, /type="checkbox"/, 'a task must be completable from the card');
  assert.match(html, /teamTodoComplete\('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',this\)/);
  assert.match(html, /Pay Ferguson invoice/);
  assert.match(html, /JR/, 'owner initials');
  assert.match(html, /teamTodoOpen\('financial'\)/, 'a detection row must deep-link');
  assert.match(html, /Vendor payments due/);
});

test('empty everything says "Nothing queued right now."', () => {
  const ctx = sandbox();
  const html = ctx.teamTodoBuildHtml({ tasks: [], detections: [] }, NOW);
  assert.match(html, /Nothing queued right now\./);
  assert.ok(!/Needs attention/.test(html), 'no empty section headers');
});

test('an unavailable detection still renders -- muted, with the real reason, and no number', () => {
  const ctx = sandbox();
  const offline = { key: 'vendor_payments_due', category: 'execution', icon: '💸', label: 'Financial feed offline', state: 'unavailable', reason: 'Vendor payments unavailable (QuickBooks returned 401).', count: null, view: 'financial' };
  const html = ctx.teamTodoBuildHtml({ tasks: [], detections: [offline] }, NOW);
  assert.match(html, /Financial feed offline/);
  assert.match(html, /QuickBooks returned 401/, 'the real reason must reach the user');
  assert.match(html, /opacity:\.5;cursor:default/, 'an unavailable row is muted the same way the Notifications card mutes its own');
  assert.ok(!/teamTodoOpen/.test(html), 'an unavailable row is not tappable');
});

test('the separation rule: a non-execution (approval) row never renders in Team To-Do', () => {
  const ctx = sandbox();
  const approval = { key: 'invoices_past_due', category: 'approval', state: 'ok', label: 'Chase or write off?', view: 'invx', count: 4 };
  const kept = ctx.teamTodoDedupe([approval, DETECTION], []);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].key, 'vendor_payments_due');
  const html = ctx.teamTodoBuildHtml({ tasks: [], detections: [approval] }, NOW);
  assert.match(html, /Nothing queued right now\./, 'an approval-only payload leaves the card empty, not duplicated from Decisions');
});

test('exact de-dupe: a detection whose entity is already in Today\'s Decisions is dropped', () => {
  const ctx = sandbox();
  const withEntity = { ...DETECTION, entityType: 'bill', entityId: '42' };
  assert.equal(ctx.teamTodoDedupe([withEntity], [{ entityType: 'bill', entityId: '42' }]).length, 0);
  assert.equal(ctx.teamTodoDedupe([withEntity], [{ entityType: 'bill', entityId: '43' }]).length, 1);
  assert.equal(ctx.teamTodoDedupe([withEntity], [{ text: 'a decision with no entity fields' }]).length, 1,
    "today's dailybrief payload exposes no entity ids -- the category rule is what does the work then");
});

test('an overdue due-date is flagged, a future one is not', () => {
  const ctx = sandbox();
  assert.equal(ctx.teamTodoDueChip('2026-08-18', NOW).overdue, false);
  assert.equal(ctx.teamTodoDueChip('2026-08-10', NOW).overdue, true);
  assert.equal(ctx.teamTodoDueChip(null, NOW), null);
  assert.match(ctx.teamTodoTaskRowHtml({ ...TASK, dueDate: '2026-08-10' }, NOW), /overdue/);
});

test('a task id is sanitised before it reaches the onclick attribute', () => {
  const ctx = sandbox();
  const html = ctx.teamTodoTaskRowHtml({ id: "x'); alert(1); ('", title: 'nope' }, NOW);
  assert.ok(!/alert\(1\)/.test(html), 'nothing but uuid characters may survive into the handler');
});

test('a task title cannot inject markup', () => {
  const ctx = sandbox();
  const html = ctx.teamTodoTaskRowHtml({ id: TASK.id, title: '<img src=x onerror=alert(1)>' }, NOW);
  assert.ok(!/<img/.test(html));
  assert.match(html, /&lt;img/);
});

test('an error on one source is shown in that section, and does not blank the other', () => {
  const ctx = sandbox();
  const html = ctx.teamTodoBuildHtml({ tasks: [], tasksError: 'HiveConnect tasks are unreachable right now.', detections: [DETECTION] }, NOW);
  assert.match(html, /HiveConnect tasks are unreachable right now\./);
  assert.match(html, /Vendor payments due/);
});

// ---- wiring in the shipped file --------------------------------------------
test('the card reads HiveConnect tasks and the detections resource -- and no longer reads reina_todo', () => {
  const cardStart = source.indexOf('id="team-todo-panel"');
  assert.ok(cardStart !== -1, 'the Team To-Do card must exist');
  const block = source.slice(cardStart, source.indexOf('</script>', cardStart));
  assert.match(block, /\/api\/hiveconnect-bridge\?action=tasks_list/);
  assert.match(block, /\/api\/track1\?resource=team_todo_detections/);
  assert.match(block, /\/api\/hiveconnect-bridge\?action=task_complete/);
  assert.ok(!/resource=reina_todo_get/.test(block), 'the Command Center card must not read the Reina engineering list any more');
});

test('"＋ Task" routes to the existing HiveConnect Tasks UI instead of rebuilding the form', () => {
  const fn = extractFunction(source, 'function teamTodoNewTask()');
  assert.match(fn, /hlRoloHC\('tasks'\)/, 'must open HiveConnect\'s own Tasks tab');
  assert.match(fn, /tsk-new-title/, 'and land in its quick-create input');
  assert.ok(!/<input/.test(fn), 'no task form is rebuilt on the HiveLogic side');
  assert.match(source, /onclick="teamTodoNewTask\(\)"/, 'the card must expose the ＋ Task button');
});

test('the email detection deep-links into the HiveConnect email tab', () => {
  const fn = extractFunction(source, 'function teamTodoOpen(view)');
  assert.match(fn, /hiveconnect_email/);
  assert.match(fn, /hlRoloHC\('email'\)/);
});

test('completing a task is the only write the card makes', () => {
  const cardStart = source.indexOf('id="team-todo-panel"');
  const block = source.slice(cardStart, source.indexOf('</script>', cardStart));
  const posts = block.match(/method: 'POST'/g) || [];
  assert.equal(posts.length, 2, 'exactly two POSTs: the tasks_list read and the single completion write');
  assert.ok(!/action=task_create|action=task_delete|jobber/i.test(block), 'no create/delete path, and nothing that writes to Jobber');
});

test('Today\'s Decisions publishes its items for the de-dupe pass', () => {
  assert.match(source, /window\.HL_TODAY_DECISIONS = items;/);
});

// ---- visual consistency with the cards beside it -----------------------------
// Chris, 2026-08-17: "all 3 boxes should have the same styling." Watching,
// Team To-Do and Notifications are the same card type in the same column, and
// this one had invented its own row chrome -- own font weights, own colours, a
// heavy right-hand number column, no status pip. These lock it to the shared
// vocabulary the other two use, so the next edit cannot quietly drift again.

test('rows use the shared .w/.pip vocabulary rather than inventing their own', () => {
  const ctx = sandbox();
  const taskRow = ctx.teamTodoTaskRowHtml(TASK, NOW);
  const detectionRow = ctx.teamTodoDetectionRowHtml(DETECTION);

  for (const [name, row] of [['task', taskRow], ['detection', detectionRow]]) {
    assert.match(row, /^<div class="w"/, `${name} row must be a .w row like Watching's`);
    assert.match(row, /<div><b>/, `${name} row must use the shared <div><b>title</b><span>detail</span></div> shape`);
    assert.match(row, /<span class="pip [rag]"/, `${name} row must carry a shared .pip status dot`);
  }
  assert.match(detectionRow, /<span class="wic">/, 'a detection row uses the same .wic icon slot as Watching');
});

test('no bespoke type scale: the shared CSS sets weight, size and colour', () => {
  const ctx = sandbox();
  const rows = ctx.teamTodoTaskRowHtml(TASK, NOW) + ctx.teamTodoDetectionRowHtml(DETECTION);
  assert.ok(!/font-size:/.test(rows), 'font sizing belongs to .w b / .w span, not to inline styles');
  assert.ok(!/font-weight:/.test(rows), 'font weight belongs to the shared rules');
  // accent-color is the checkbox's own control tint, copied from the
  // Notifications rows -- it is not row text colour, so it is exempt.
  assert.ok(!/(^|[^-])color:#/.test(rows.replace(/accent-color:#[0-9a-fA-F]{3,8}/g, '')),
    'row text colour belongs to the shared rules');
  assert.ok(!/flex:1/.test(rows), '.w already lays its columns out');
});

test('a detection value reads in the title, not as a heavy separate column', () => {
  const ctx = sandbox();
  const row = ctx.teamTodoDetectionRowHtml(DETECTION);
  assert.match(row, /<b>Vendor payments due · \$4,211<\/b>/,
    'the number sits in the shared title type, which is what stopped it shouting over the neighbouring cards');
});

test('priority maps onto the shared pip colours', () => {
  const ctx = sandbox();
  assert.equal(ctx.teamTodoPriorityPip('urgent'), 'r');
  assert.equal(ctx.teamTodoPriorityPip('high'), 'r');
  assert.equal(ctx.teamTodoPriorityPip('normal'), 'a');
  assert.equal(ctx.teamTodoPriorityPip('low'), 'g');
  assert.equal(ctx.teamTodoPriorityPip(undefined), 'a');
});

test('the checkbox is styled exactly as the Notifications card styles its own', () => {
  const notifCheckbox = /margin:3px 8px 0 0;flex-shrink:0;accent-color:#4F6F82;cursor:pointer/;
  assert.match(source.slice(source.indexOf("hlApiGet('notifications')")), notifCheckbox,
    'sanity: this is the style being matched');
  const ctx = sandbox();
  assert.match(ctx.teamTodoTaskRowHtml(TASK, NOW), notifCheckbox);
});

// ---- failure visibility ------------------------------------------------------
// Added 2026-08-16 after a completion click produced NOTHING: no write, no
// error, no console line, no trace anywhere. A card that fails silently is
// indistinguishable from a card with nothing to say. These lock the three
// mechanisms that make that impossible.

test('the freshness stamp never claims a refresh that did not happen', () => {
  const ctx = sandbox();
  vm.runInContext(extractFunction(source, 'function teamTodoStampText(state)'), ctx);
  assert.equal(ctx.teamTodoStampText({ tasks: [], detections: [] }), 'updated just now');
  assert.equal(ctx.teamTodoStampText({ tasksError: 'boom', detectionsError: 'boom' }), 'could not refresh',
    'a load where BOTH sources failed must not read "updated just now"');
  assert.equal(ctx.teamTodoStampText({ tasksError: 'boom' }), 'updated just now · partial');
  assert.equal(ctx.teamTodoStampText({ signedOut: true }), '');
});

test('teamTodoWithTimeout rejects when the wrapped promise never settles', async () => {
  const ctx = sandbox();
  vm.runInContext(extractFunction(source, 'function teamTodoWithTimeout(p, ms, label)'), ctx);
  const never = new Promise(() => {});
  await assert.rejects(
    () => ctx.teamTodoWithTimeout(never, 10, 'task_complete'),
    /task_complete timed out after 10ms/,
    'a hung sb.auth.getSession() must surface as an error, not a permanently disabled checkbox'
  );
});

test('teamTodoWithTimeout passes through a value and an error unchanged', async () => {
  const ctx = sandbox();
  vm.runInContext(extractFunction(source, 'function teamTodoWithTimeout(p, ms, label)'), ctx);
  assert.equal(await ctx.teamTodoWithTimeout(Promise.resolve('ok'), 1000, 'x'), 'ok');
  await assert.rejects(() => ctx.teamTodoWithTimeout(Promise.reject(new Error('real cause')), 1000, 'x'), /real cause/);
});

test('teamTodoComplete has no silent exit: every path logs, notes, and restores the checkbox', () => {
  const fn = extractFunction(source, 'function teamTodoComplete(id, el)');
  // The pre-fix silent return: `if (typeof hlRequireSession !== 'function') return;`
  assert.ok(
    !/if \(typeof hlRequireSession !== 'function'\) return;/.test(fn),
    'a bare silent return when the session gate is missing must not come back'
  );
  assert.match(fn, /fail\('Not signed in yet/, 'a missing session gate must be reported, not swallowed');
  assert.match(fn, /teamTodoWithTimeout\(/, 'the write must be bounded so a hung promise cannot strand the row');
  assert.match(fn, /\.catch\(function\(e\)\{ fail\(/, 'a rejected session gate must land in fail(), not in an unhandled rejection');
  assert.match(fn, /teamTodoLog\('complete-response'/, 'the HTTP status must always reach the console');
  assert.match(fn, /el\.checked = false; el\.disabled = false;/, 'a failed write must never leave the checkbox ticked or disabled');
  assert.match(fn, /historyWritten === false/, 'a status write whose history row failed is a partial outcome the user must see');
});

test('teamTodoLoad reports a failure instead of leaving the card as-is', () => {
  const fn = extractFunction(source, 'function teamTodoLoad()');
  assert.ok(!/if \(typeof hlRequireSession !== 'function'\) return;\n/.test(fn), 'no silent return');
  assert.match(fn, /teamTodoWithTimeout\(/);
  assert.match(fn, /teamTodoLog\('load-failed', e\)/);
  assert.match(fn, /teamTodoNote\('Could not refresh — '/);
  assert.match(fn, /HTTP ' \+ r\.status/, 'a failing read must surface its real status code, not a generic string');
});

test('the inline note is a real element in the card, independent of the 2.4s toast', () => {
  assert.match(source, /<div id="todo-note" role="status" aria-live="polite"/,
    'errors must have somewhere persistent to land — chirpToast no-ops when undefined and vanishes in 2.4s');
  const noteFn = extractFunction(source, 'function teamTodoNote(msg, kind)');
  assert.match(noteFn, /getElementById\('todo-note'\)/);
  assert.match(noteFn, /style\.display = 'block'/);
});

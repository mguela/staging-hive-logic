// Phase 10 -- Calendar tab wiring (Marketing Command Center frontend).
// The Calendar tab used to render an honest "coming in a future update" stub
// (ST-02). It now renders data.schedule.events -- the same payload
// handleCommandCenterGet's computeScheduleData() call folds into the single
// command_center fetch the Command Center already does at page load (no new
// network call from the Calendar tab itself).

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const htmlPath = 'public/marketing-command-center/index.html';
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractCalendarSource() {
  const start = html.indexOf('// ---------- Calendar (Phase 10');
  assert.ok(start > -1, 'expected the Phase 10 Calendar section header to exist');
  // Relaxed: a sibling attribution branch renamed this header to include
  // '+ attribution' once merged -- match any suffix before the closing paren.
  const resultsMatch = html.slice(start).match(/\/\/ ---------- Results \(real campaign performance.*?\) ----------/);
  assert.ok(resultsMatch, 'expected the Results section header to follow the Calendar section');
  const end = start + resultsMatch.index;
  return html.slice(start, end);
}

function loadCalendarFns() {
  const sandbox = {
    icon(name) { return '<icon:' + name + '>'; },
    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractCalendarSource(), sandbox);
  return sandbox;
}

// ---------- Structural / wiring checks ----------

check('renderCalendar is called with data at the screenFor dispatch (not the old no-arg stub)', () => {
  const idx = html.indexOf("if (route === 'calendar') return renderCalendar(data);");
  assert.ok(idx > -1, 'expected screenFor to dispatch calendar with data');
});

check('the old "coming in a future update" stub text is gone', () => {
  assert.doesNotMatch(html, /coming in a future update/);
});

check('renderCalendar source references data.schedule (not a hardcoded stub)', () => {
  const fn = extractCalendarSource();
  assert.match(fn, /data\s*&&\s*data\.schedule/);
  assert.match(fn, /schedule\.events/);
  assert.match(fn, /schedule\.notYetTracked/);
});

// ---------- Behavior ----------

check('renderCalendar renders a list row per real event, with name/date/channel/status', () => {
  const { renderCalendar } = loadCalendarFns();
  const data = {
    schedule: {
      windowStart: '2026-08-01T00:00:00Z',
      windowEnd: '2026-11-01T00:00:00Z',
      events: [
        { id: 'c1', name: 'Spring Promo', channel: 'email', status: 'draft', scheduledAt: '2026-08-05T00:00:00Z' },
        { id: 'c2', name: 'Referral Push', channel: 'sms', status: 'scheduled', scheduledAt: '2026-09-01T00:00:00Z' },
      ],
      notYetTracked: ['organic_posts', 'videos'],
    },
  };
  const out = renderCalendar(data);
  assert.match(out, /cc-list-row/);
  assert.match(out, /Spring Promo/);
  assert.match(out, /Referral Push/);
  assert.match(out, /cc-tag">draft/);
  assert.match(out, /cc-tag">scheduled/);
  assert.match(out, /Not yet tracked on this calendar: organic posts, videos\./);
});

check('renderCalendar shows an honest empty state (not a fabricated calendar) when there are no scheduled sends', () => {
  const { renderCalendar } = loadCalendarFns();
  const data = { schedule: { windowStart: null, windowEnd: null, events: [], notYetTracked: [] } };
  const out = renderCalendar(data);
  assert.match(out, /No campaign sends are scheduled in this window/);
  assert.doesNotMatch(out, /cc-list-row/);
});

check('renderCalendar tolerates a missing schedule payload without throwing', () => {
  const { renderCalendar } = loadCalendarFns();
  const out = renderCalendar({});
  assert.match(out, /No campaign sends are scheduled in this window/);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);

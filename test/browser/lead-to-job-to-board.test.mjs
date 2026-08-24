// Chris, 2026-08-23: "I filled the new client>Lead form and hit schedule a job
// and it dissappeared. It should bring you to the schedule to book the job on
// the calendar and pick a tech."
//
// Three separate faults sat on that one press, and all three were silent:
//
//  1. nlSaveLeadCore read the new lead's id from r.leadId, which the leads API
//     has never sent -- it returns r.pipeline.id. So the id was always null and
//     nlGoJob bailed AFTER closing the form. That is the disappearance.
//
//  2. njobLinkSourceLead is declared inside an IIFE-wrapped <script> block and
//     njobSave lives in a different one, so calling it threw. Every job save
//     died right after the job was created: the job existed, but the form never
//     closed, no toast appeared, no list refreshed, and the lead never
//     advanced. Shipped, and nothing said a word.
//
//  3. NJOB_SOURCE_LEAD was TWO variables with one name -- a private one inside
//     that wrapped block, and an implicit global the other two blocks were
//     assigning. rlmStartJob set the private one; the New Lead form set the
//     global one; njobLinkSourceLead read the private one. So a job started
//     from the lead form could never link back to its lead.
//
// Only a browser can see any of this. Reading the source, all three look right.

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { findPlaywright, findChromium, unavailableReason, SUPABASE_STUB } from './driver.mjs';

const reason = unavailableReason();
const OPTS = reason ? { skip: reason } : {};
const pw = reason ? null : findPlaywright();
const chromiumPath = reason ? null : findChromium();

let server; let page; let browser;
let pageErrors = [];

before(async () => {
  if (reason) return;
  server = await startServer();
  browser = await pw.chromium.launch({ executablePath: chromiumPath, args: ['--no-sandbox', '--disable-gpu'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());
  await page.route((u) => u.hostname.includes('jsdelivr.net') && u.pathname.includes('supabase'),
    (r) => r.fulfill({ body: SUPABASE_STUB, contentType: 'application/javascript' }));
  await page.route('**/api/track1**', (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get('resource') === 'create_job') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, jobRef: 'J-10001', job: { jobber_id: 'JOB1' }, warnings: [] }) });
    }
    // The REAL leads response shape -- no leadId, the id lives on pipeline.
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, resource: 'leads', clientId: 'C1',
        pipeline: { id: 'L1', client_id: 'C1' }, rows: [], clients: [] }) });
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  await page.goto(`${server.url}/index.html#win`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('typeof window.nlGo === "function"', null, { timeout: 30000 });
  await page.waitForTimeout(900);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

// Watch what the parent actually posts into the board iframe.
async function saveJobFromLead() {
  pageErrors = [];
  return page.evaluate(async () => {
    const seen = [];
    const f = document.getElementById('crewboard-frame');
    if (f) {
      Object.defineProperty(f, 'contentWindow', {
        get() { return { postMessage(m) { seen.push(m && m.type); } }; },
        configurable: true,
      });
    }
    window.NJOB_SOURCE_LEAD = { leadId: 'L1', clientId: 'C1' };
    document.getElementById('njob-title').value = 'Roof leak';
    njobSave();
    await new Promise((r) => setTimeout(r, 1400));
    return {
      messages: [...new Set(seen)],
      scheduleShown: getComputedStyle(document.getElementById('view-schedule')).display,
      hash: location.hash,
      sourceLeadCleared: window.NJOB_SOURCE_LEAD,
    };
  });
}

test('the lead-to-job handoff is reachable across script blocks', OPTS, async () => {
  // Both of these live in an IIFE-wrapped block that njobSave cannot see into.
  // Unexported, the save throws the moment a job is created.
  const reach = await page.evaluate(() => ({
    link: typeof window.njobLinkSourceLead,
    hasVar: 'NJOB_SOURCE_LEAD' in window,
    rail: typeof window.hlShowUnscheduledRail,
  }));
  assert.strictEqual(reach.link, 'function', 'njobLinkSourceLead must be on window');
  assert.strictEqual(reach.hasVar, true, 'and the handoff variable must be the window one');
  assert.strictEqual(reach.rail, 'function');
});

test('there is only ONE NJOB_SOURCE_LEAD, not one per script block', OPTS, async () => {
  // The bug: a private var inside the wrapped block plus an implicit global.
  // Writing from outside and reading from inside gave two different answers,
  // so the lead never advanced and nothing reported it.
  const same = await page.evaluate(() => {
    window.NJOB_SOURCE_LEAD = { leadId: 'PROBE', clientId: 'C' };
    // rlmStartJob lives INSIDE the wrapped block; if it writes a private copy,
    // the window value stops matching after it runs.
    return window.NJOB_SOURCE_LEAD && window.NJOB_SOURCE_LEAD.leadId;
  });
  assert.strictEqual(same, 'PROBE');
  const src = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    return { privateVar: /var NJOB_SOURCE_LEAD\s*=/.test(html) };
  });
  assert.strictEqual(src.privateVar, false, 'no block-local declaration may come back');
});

test('saving a job created from a lead does not throw', OPTS, async () => {
  const out = await saveJobFromLead();
  assert.deepEqual(pageErrors, [],
    'the save used to die on njobLinkSourceLead being out of scope: ' + pageErrors.join(' | '));
  assert.ok(out);
});

test('it lands on the schedule instead of just closing', OPTS, async () => {
  const out = await saveJobFromLead();
  assert.strictEqual(out.scheduleShown, 'block', 'the Schedule view should be open');
  assert.match(out.hash, /schedule/);
});

test('and asks the board for the unscheduled rail', OPTS, async () => {
  // Landing on the board is only half of it -- the new job is unscheduled, and
  // the rail is where it can be dragged onto a crew. That is "pick a tech".
  const out = await saveJobFromLead();
  assert.ok(out.messages.includes('hl-crewboard-show-unscheduled'),
    'expected the rail request, got: ' + out.messages.join(', '));
});

test('the request is retried, because the board mounts lazily', OPTS, async () => {
  // Switching to the Schedule tab may be the first time the iframe has ever
  // loaded, and a board that has not booted has no toggleUnassigned to call.
  // Dropping it there is how this becomes "I pressed it and nothing happened"
  // a second time.
  const posts = await page.evaluate(async () => {
    let n = 0;
    const f = document.getElementById('crewboard-frame');
    Object.defineProperty(f, 'contentWindow', {
      get() { return { postMessage(m) { if (m && m.type === 'hl-crewboard-show-unscheduled') n++; } }; },
      configurable: true,
    });
    window.hlShowUnscheduledRail();
    await new Promise((r) => setTimeout(r, 1200));
    return n;
  });
  assert.ok(posts > 1, 'expected more than one attempt, got ' + posts);
});

test('the retry gives up rather than running forever', OPTS, async () => {
  const src = await page.evaluate(() => String(window.hlShowUnscheduledRail));
  assert.match(src, /tries\+\+ > 20/, 'a board that never boots must not leave a timer for the session');
  assert.match(src, /removeEventListener/);
});

test('the handoff is cleared after one job', OPTS, async () => {
  // One job per conversion. A sticky value would attach the next job he makes
  // to a lead he finished with an hour ago.
  const out = await saveJobFromLead();
  assert.strictEqual(out.sourceLeadCleared, null);
});

test('a job with a time already picked is NOT yanked to the board', OPTS, async () => {
  // He has already said where it goes. Overriding that would be undoing his
  // answer, and the booking path books it for him.
  pageErrors = [];
  const out = await page.evaluate(async () => {
    showView('cc');
    await new Promise((r) => setTimeout(r, 300));
    window.NJOB_SOURCE_LEAD = { leadId: 'L1', clientId: 'C1' };
    document.getElementById('njob-title').value = 'Roof leak';
    const d = document.getElementById('njob-date'); if (d) d.value = '2026-09-15';
    const s = document.getElementById('njob-start'); if (s) s.value = '9';
    const e = document.getElementById('njob-end'); if (e) e.value = '12';
    njobSave();
    await new Promise((r) => setTimeout(r, 1200));
    return { scheduleShown: getComputedStyle(document.getElementById('view-schedule')).display };
  });
  assert.strictEqual(out.scheduleShown, 'none', 'a booked job stays where he was');
  assert.deepEqual(pageErrors, []);
});

// The five destination buttons, pressed for real.
//
// Every silent failure on this form was found this way and by no other means.
// The old "Next step" tiles read perfectly in the source -- a clean radio
// group writing a `nextStep` string -- and did nothing at all, because nothing
// on the server has ever read that string. Static assertions cannot tell the
// difference between a button that works and a button that is wired to a
// function that goes nowhere. Pressing it can.
//
// What this checks that the unit tests cannot:
//   - the buttons are reachable and pressing one opens the right question
//   - a required answer really blocks, in the DOM, not just in the source
//   - the request that leaves the browser carries what it is supposed to

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { findPlaywright, findChromium, unavailableReason, SUPABASE_STUB } from './driver.mjs';

const reason = unavailableReason();
const OPTS = reason ? { skip: reason } : {};
const pw = reason ? null : findPlaywright();
const chromiumPath = reason ? null : findChromium();

let server; let page; let browser;
let leadPosts = []; let appts = [];

before(async () => {
  if (reason) return;
  server = await startServer();
  browser = await pw.chromium.launch({
    executablePath: chromiumPath, args: ['--no-sandbox', '--disable-gpu'],
  });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.route((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());

  // The auth client, stubbed. Without it the page throws on
  // supabase.createClient at load and never finishes booting.
  await page.route((u) => u.hostname.includes('jsdelivr.net') && u.pathname.includes('supabase'),
    (r) => r.fulfill({ body: SUPABASE_STUB, contentType: 'application/javascript' }));

  // Answer the leads write locally so a press completes end to end and the body
  // it sent can be read back. Without this the fetch fails and every path stops
  // at the first await, which would let a broken destination look fine.
  //
  // Collected on the NODE side, deliberately. Calling page.evaluate from inside
  // a route handler deadlocks -- the page is blocked awaiting the very request
  // the handler has not fulfilled yet -- so the evaluate throws, the route never
  // answers, and the fetch rejects. The app then reports a failed save, which is
  // correct behaviour and looks exactly like a broken button.
  await page.route('**/api/track1**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      try { leadPosts.push(JSON.parse(req.postData() || '{}')); } catch (e) { leadPosts.push(null); }
      return route.fulfill({ status: 200, contentType: 'application/json',
        // THE REAL RESPONSE SHAPE. api/track1.js's leads POST returns
        // { ok, resource, clientId, pipeline, note } -- no `leadId`, no `lead`.
        // The first version of this mock invented `leadId`, so the tests passed
        // on a path that could never work in production: leadId was always null
        // there, and Schedule-a-job and Create-an-estimate silently did nothing
        // after closing the form. Mock what the server sends, or the test is
        // testing the mock.
        body: JSON.stringify({ ok: true, resource: 'leads', clientId: 'client-test-1',
          pipeline: { id: 'lead-test-1', client_id: 'client-test-1', stage: 'new' },
          note: 'Saved in HiveLogic.' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, rows: [] }) });
  });
  await page.route('**/api/schedule/**', async (route) => {
    try { appts.push(JSON.parse(route.request().postData() || '{}')); } catch (e) { appts.push(null); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  // #win is the app's own way to drop the login overlay (index.html checks the
  // hash for it), so the harness gets in the way the app itself allows rather
  // than reaching in and deleting the element. Without it the overlay sits on
  // top and every click below is intercepted by it.
  await page.goto(`${server.url}/index.html#win`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('typeof window.nlGo === "function"', null, { timeout: 30000 });
  // The app arms its own full-screen prompts on timers -- "Clock in?" appears
  // a minute or so in, at z-index 10050, and swallows every click on the page.
  // They have nothing to do with leads, and they re-arm, so clearing them once
  // is not enough. Strip any body-level overlay that is not ours, as it lands.
  await page.evaluate(() => {
    const mine = (el) => el.id === 'nlv' || el.id === 'nl-ask-back';
    const strip = () => [...document.body.children].forEach((el) => {
      if (mine(el)) return;
      const st = getComputedStyle(el);
      if (st.position === 'fixed' && Number(st.zIndex) >= 10000 && st.display !== 'none') el.remove();
    });
    new MutationObserver(strip).observe(document.body, { childList: true });
    strip();
  });
  await page.waitForTimeout(800);
  const covered = await page.evaluate(() => {
    const lg = document.getElementById('login');
    return !!lg && getComputedStyle(lg).display !== 'none';
  });
  assert.ok(!covered, 'the login overlay is still covering the page -- every click below would hit it');
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

// Open the form and fill in every field nlValidateRequired now demands --
// a name, a phone (satisfying the phone-or-email pair), a service address,
// and what they need. 2026-08-26: this form used to save on a name alone;
// leaving the other three blank here would block every destination test
// below on unrelated validation, not on what each test actually presses.
async function openLeadForm(name = 'Test Caller') {
  leadPosts = []; appts = [];
  await page.evaluate((n) => {
    const back = document.getElementById('nl-ask-back'); if (back) back.remove();
    // A previous press leaves the success toast up, and it sits over the
    // buttons long enough for the next click to land on it instead.
    const t = document.getElementById('toast'); if (t) t.classList.remove('show');
    // The New Job form opens over the top on the job path -- close it and put
    // its drawer back, or the next test's click lands on it instead.
    document.querySelectorAll('.fm.open').forEach((m) => m.classList.remove('open'));
    const dw = document.querySelector('.dw'); if (dw) dw.style.display = '';
    document.querySelectorAll('.nlv.open').forEach((m) => {
      if (m.id !== 'nlv') m.classList.remove('open');
    });
    document.getElementById('nlv').classList.add('open');
    const parts = n.split(' ');
    document.getElementById('nl-first').value = parts[0] || '';
    document.getElementById('nl-last').value = parts[1] || '';
    document.getElementById('nl-phone').value = '(914) 555-0100';
    document.getElementById('nl-addr').value = '14 Maple Ave';
    document.getElementById('nl-need').value = 'Back door will not latch';
    const ap = document.getElementById('nl-approx'); if (ap) ap.value = '850';
  }, name);
  // The overlay animates in. Clicking mid-transition is "element is not stable".
  await page.waitForTimeout(400);
}

// The requests are answered in Node, so wait on the Node-side array rather
// than on anything in the page.
async function waitFor(cond, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (cond()) return;
    await page.waitForTimeout(50);
  }
  throw new Error('timed out waiting for the request to arrive');
}

// A save is not finished when the request body arrives -- the route handler
// records it before the page's own fetch resolves, so the form's close is still
// pending. Returning at that point lets the close fire during the NEXT test and
// shut the form out from under it, which reads as "the button is not visible".
async function waitSaved(cond) {
  await waitFor(cond);
  await page.waitForFunction(
    () => !document.getElementById('nlv').classList.contains('open'), null, { timeout: 5000 });
}

const sheetVisible = () => page.evaluate(() => !!document.getElementById('nl-ask-back'));

test('the five destination buttons are on the form and pressable', OPTS, async () => {
  const found = await page.evaluate(() => {
    const box = document.getElementById('nl-nextsteps');
    if (!box) return null;
    return [...box.querySelectorAll('.step-o')].map((e) => e.getAttribute('data-step'));
  });
  assert.deepEqual(found, ['site_visit', 'job', 'estimate', 'callback', 'not_a_fit']);
});

test('none of them is pre-ticked -- pressing one is the choice', OPTS, async () => {
  const sel = await page.evaluate(() => document.querySelectorAll('#nl-nextsteps .step-o.sel').length);
  assert.strictEqual(sel, 0);
});

test('the removed fields really are gone from the rendered form', OPTS, async () => {
  const labels = await page.evaluate(() => {
    const tm = document.getElementById('nl-tm-fields');
    return [...tm.querySelectorAll('label')].map((l) => l.textContent.trim());
  });
  for (const dead of ['TRADE', 'CAME IN ON (BRAND LINE)', 'PREFERRED WINDOW + BACKUP', 'ACCESS', 'NOT-TO-EXCEED (PRE-APPROVED)', 'URGENCY']) {
    assert.ok(!labels.includes(dead), dead + ' should not render any more');
  }
  assert.ok(labels.includes('APPROXIMATE COST'), 'and the replacement should');
});

test('pressing "Schedule a site visit" asks when, before saving anything', OPTS, async () => {
  await openLeadForm();
  await page.click('#nl-nextsteps [data-step="site_visit"]');
  assert.ok(await sheetVisible(), 'the question should be up');
  // Nothing may be saved yet: backing out here has to leave the form untouched.
  assert.deepEqual(leadPosts, []);
  await page.click('#nl-ask-back button[data-act="cancel"]');
  assert.ok(!(await sheetVisible()));
  assert.deepEqual(leadPosts, [],
    'cancelling must not have written a lead');
});

test('the site visit will not go without a date, and says why', OPTS, async () => {
  await openLeadForm();
  await page.click('#nl-nextsteps [data-step="site_visit"]');
  await page.click('#nl-ask-back button[data-act="ok"]');
  assert.ok(await sheetVisible(), 'it must stay open rather than book nothing quietly');
  const err = await page.evaluate(() => {
    const e = document.getElementById('nl-ask-err');
    return e && e.style.display !== 'none' ? e.textContent : null;
  });
  assert.match(err || '', /DATE is needed/);
  assert.deepEqual(leadPosts, []);
  await page.click('#nl-ask-back button[data-act="cancel"]');
});

test('with a date it saves the lead and books the visit against it', OPTS, async () => {
  await openLeadForm('Dana Fielder');
  await page.click('#nl-nextsteps [data-step="site_visit"]');
  await page.fill('#nl-ask-date', '2026-09-15');
  await page.selectOption('#nl-ask-hour', '14');
  await page.click('#nl-ask-back button[data-act="ok"]');
  await waitSaved(() => appts.length > 0);

  const [lead] = leadPosts;
  assert.strictEqual(lead.firstName, 'Dana');
  assert.strictEqual(lead.estimatedValue, 850, 'approximate cost rides along as the estimated value');

  const [appt] = appts;
  assert.strictEqual(appt.action, 'create_appointment');
  assert.strictEqual(appt.appointment.kind, 'sitevisit');
  assert.strictEqual(appt.appointment.source_lead_id, 'lead-test-1', 'the visit points back at the lead');
  // 2:00 PM ET on a September date is 18:00 UTC.
  assert.strictEqual(appt.appointment.start_at, '2026-09-15T18:00:00.000Z');
  // And the form closes -- leaving it open behind the toast is how the same
  // lead gets entered twice.
  assert.ok(!(await page.evaluate(() => document.getElementById('nlv').classList.contains('open'))));
});

test('a call back needs a reason, then lands as a lead follow-up', OPTS, async () => {
  await openLeadForm('Marcus Hale');
  await page.click('#nl-nextsteps [data-step="callback"]');
  await page.fill('#nl-ask-date', '2026-09-16');
  await page.click('#nl-ask-back button[data-act="ok"]');
  assert.ok(await sheetVisible(), 'no reason means no reminder');
  assert.match(await page.evaluate(() => document.getElementById('nl-ask-err').textContent),
    /WHAT IS THE CALL ABOUT/);

  await page.fill('#nl-ask-why', 'Confirm the price on the deck');
  await page.click('#nl-ask-back button[data-act="ok"]');
  await waitSaved(() => appts.length > 0);

  const [appt] = appts;
  assert.strictEqual(appt.appointment.kind, 'lead');
  // Readable on the calendar itself, without opening anything.
  assert.match(appt.appointment.title, /Call back Marcus Hale — Confirm the price on the deck/);
  assert.strictEqual(appt.appointment.details.reason, 'Confirm the price on the deck');
  assert.strictEqual(appt.appointment.source_lead_id, 'lead-test-1');
});

test('"Not a good fit" closes the lead out with a reason the board also uses', OPTS, async () => {
  await openLeadForm('Wendy Ortiz');
  await page.click('#nl-nextsteps [data-step="not_a_fit"]');
  await page.click('#nl-ask-back button[data-act="ok"]');
  assert.ok(await sheetVisible(), 'a blank reason is not a reason');

  await page.selectOption('#nl-ask-reason', 'went_with_competitor');
  await page.click('#nl-ask-back button[data-act="ok"]');
  await waitSaved(() => leadPosts.length > 0);

  const [lead] = leadPosts;
  assert.strictEqual(lead.stage, 'lost', 'it must not land in the pipeline looking live');
  assert.strictEqual(lead.lostReason, 'went_with_competitor');
  assert.strictEqual(lead.firstName, 'Wendy');
});

test('"Something else" with nothing typed is refused rather than recorded blank', OPTS, async () => {
  await openLeadForm('Sam Reed');
  await page.click('#nl-nextsteps [data-step="not_a_fit"]');
  await page.selectOption('#nl-ask-reason', 'other');
  await page.click('#nl-ask-back button[data-act="ok"]');
  await page.waitForTimeout(150);
  assert.deepEqual(leadPosts, [],
    'a loss with no reason at all is worse than the fixed list');
  assert.ok(await sheetVisible(), 'and it reopens the question instead of dropping it');
  await page.fill('#nl-ask-note', 'Out of our service area');
  await page.click('#nl-ask-back button[data-act="ok"]');
  await waitSaved(() => leadPosts.length > 0);
  const [lead] = leadPosts;
  assert.strictEqual(lead.lostReason, 'other');
  assert.strictEqual(lead.notes, 'Out of our service area');
});

test('"Schedule a job" saves the lead and opens the job form tied to it', OPTS, async () => {
  await openLeadForm('Priya Nair');
  await page.click('#nl-nextsteps [data-step="job"]');
  await waitSaved(() => leadPosts.length > 0);
  await page.waitForTimeout(200);

  const [lead] = leadPosts;
  assert.strictEqual(lead.firstName, 'Priya');
  // NJOB_SOURCE_LEAD is what marks the lead won and records which job it became
  // when the job is saved. Without it the job is an orphan and the card sits in
  // the pipeline forever.
  const src = await page.evaluate(() => window.NJOB_SOURCE_LEAD || null);
  assert.ok(src && src.leadId === 'lead-test-1', 'the job must carry the lead back with it');

  // VISIBLE, not merely filled. The first version of this test asserted the
  // field value and nothing else -- so it passed while the form was
  // display:none, which from Chris's side of the screen is the lead form
  // vanishing when he presses a button. A prefilled invisible form is not a
  // feature.
  const shown = await page.evaluate(() => {
    const fm = document.getElementById('fm-job');
    if (!fm) return null;
    const r = fm.getBoundingClientRect();
    return { open: fm.classList.contains('open'), display: getComputedStyle(fm).display, w: Math.round(r.width), h: Math.round(r.height) };
  });
  assert.ok(shown, 'the job form should exist');
  assert.notStrictEqual(shown.display, 'none', 'the job form must actually be on screen');
  assert.ok(shown.w > 100 && shown.h > 100, 'and have real size, got ' + shown.w + 'x' + shown.h);

  const title = await page.evaluate(() => (document.getElementById('njob-title') || {}).value);
  assert.strictEqual(title, 'Back door will not latch', 'prefilled, not retyped');
});

test('"Create an estimate" saves the lead first and does not throw', OPTS, async () => {
  // estFormFromLead is the same entry the pipeline card uses. What matters here
  // is that the press reaches it with a real lead id rather than dying on the
  // way -- which is exactly how rlmStartEstimate sat broken on production.
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openLeadForm('Ken Iwata');
  await page.click('#nl-nextsteps [data-step="estimate"]');
  await waitSaved(() => leadPosts.length > 0);
  await page.waitForTimeout(300);
  const [lead] = leadPosts;
  assert.strictEqual(lead.firstName, 'Ken');
  assert.deepEqual(errors, [], 'pressing it must not throw');
});

test('a lead with no name is refused before any of this starts', OPTS, async () => {
  leadPosts = [];
  await page.evaluate(() => {
    const back = document.getElementById('nl-ask-back'); if (back) back.remove();
    document.getElementById('nlv').classList.add('open');
    document.getElementById('nl-first').value = '';
    document.getElementById('nl-last').value = '';
  });
  await page.click('#nl-nextsteps [data-step="job"]');
  await page.waitForTimeout(250);
  assert.deepEqual(leadPosts, []);
});

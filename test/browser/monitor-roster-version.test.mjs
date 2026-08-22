// The agent-version badge on the Monitor roster, read off a real render.
//
// WHY IN A BROWSER. The source-level tests in agent-version-reporting can only
// assert that index.html CONTAINS the badge code. That is exactly the kind of
// evidence this whole area keeps being burned by: the API had been sending
// agentVersion and agentVersionState for a full release while the roster row
// rendered "platform · last seen" and dropped both, and nothing anywhere went
// red. A string match on the file would not have caught that either, because
// the fields were present in the response and simply never used.
//
// So this drives the shipped page, serves the roster over real HTTP from the
// harness, calls the app's own refresh, and reads the badges out of the laid-out
// DOM. The three states are asserted separately, because the distinction that
// matters most is the one between "stale" and "unknown" -- an agent from before
// version reporting existed tells us nothing, and calling that stale is the
// unfounded claim api/_lib/agent-version.js was written to prevent.

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { findPlaywright, findChromium, unavailableReason } from './driver.mjs';
import { EXPECTED_AGENT_VERSION } from '../../api/_lib/agent-version.js';

const reason = unavailableReason();
if (reason && process.env.HL_UI_TESTS_REQUIRED === '1') {
  throw new Error(
    `HL_UI_TESTS_REQUIRED=1 but the browser tests cannot run: ${reason}. `
    + 'Refusing to report a pass for tests that did not execute.');
}
const skip = reason || false;
const chromium = skip ? null : findPlaywright().chromium;

let server, browser, page, rows;

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

  // Everything off-box is aborted rather than left to hang: in a sealed sandbox
  // an un-routed request stalls, and a stalled supabase-js bundle takes the
  // whole script block -- including mgrMonRefresh -- with it.
  await page.route((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());
  await page.route((u) => u.hostname !== '127.0.0.1' && u.pathname.includes('supabase'),
    (r) => r.fulfill({ body: 'window.supabase={createClient:function(){return {};}};', contentType: 'application/javascript' }));

  await page.goto(`${server.url}/index.html#win`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('typeof window.mgrMonRefresh === "function"', null, { timeout: 30000 });

  // hlRequireSession gates the fetch on a signed-in session. Rather than stub
  // the whole of supabase-js, hand the page the one thing that function needs;
  // the roster then loads through the app's real fetch path against the real
  // harness endpoint.
  await page.evaluate(() => {
    window.hlRequireSession = function (fn) { return fn({ access_token: 'harness-token' }); };
  });

  await page.evaluate(() => window.mgrMonRefresh());
  await page.waitForFunction(
    () => document.querySelectorAll('#mon-roster > div > div').length === 4,
    null, { timeout: 15000 });

  rows = await page.evaluate(() => Array.from(document.querySelectorAll('#mon-roster > div > div')).map((r) => ({
    text: r.textContent,
    // The badge is the one child with a pill background. Read the COMPUTED
    // colour, not the inline attribute -- an inline style that never took
    // effect would still match a string assertion.
    badges: Array.from(r.children)
      .map((c) => ({ text: c.textContent, bg: getComputedStyle(c).backgroundColor, title: c.title }))
      .filter((c) => c.bg !== 'rgba(0, 0, 0, 0)' && c.text),
  })));
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test('the roster renders one row per paired machine', { skip }, () => {
  assert.equal(rows.length, 4, 'every fixture agent must appear');
});

test('a current agent shows its version, in green', { skip }, () => {
  const badge = rows[0].badges.find((b) => b.text.includes('v'));
  assert.ok(badge, 'the current agent must carry a version badge');
  assert.equal(badge.text, 'v' + EXPECTED_AGENT_VERSION);
  assert.ok(!/update pending/.test(badge.text), 'a current agent must not be told to update');
  // The green the app uses for "good" elsewhere. Asserting the computed value
  // means a badge that rendered with no styling at all fails here.
  assert.equal(badge.bg, 'rgb(230, 242, 236)');
});

test('an agent behind the release says so, and names its own version', { skip }, () => {
  const badge = rows[1].badges.find((b) => b.text.includes('v'));
  assert.ok(badge, 'the stale agent must carry a version badge');
  assert.match(badge.text, /^v1\.0\.0 · update pending$/,
    'it has to say WHICH version it is on -- "out of date" alone sends you to the database');
  assert.equal(badge.bg, 'rgb(253, 240, 227)');
  // The tooltip must name the target, and take it from the server response
  // rather than a literal, or the badge and the release can drift apart.
  assert.ok(badge.title.includes('v' + EXPECTED_AGENT_VERSION),
    `the tooltip must name the current build; got: ${badge.title}`);
});

test('an agent that has never reported is unknown, never stale', { skip }, () => {
  const badge = rows[2].badges.find((b) => /version/.test(b.text));
  assert.ok(badge, 'the silent agent must still carry a badge -- silence is what we stopped treating as fine');
  assert.equal(badge.text, 'version unknown');
  assert.ok(!/update pending/.test(badge.text),
    'calling an unreported version stale is the unfounded claim this mechanism exists to prevent');
  assert.equal(badge.bg, 'rgb(233, 239, 244)');
});

test('the badge does not displace the platform and last-seen line', { skip }, () => {
  // The row already carried this information and it is what someone scans for.
  // A badge that pushed it out would be a regression dressed as a feature.
  assert.match(rows[0].text, /win32/);
  assert.match(rows[0].text, /last seen/);
  assert.match(rows[3].text, /last seen never/);
});

test('a machine that has never checked in gets no version badge at all', { skip }, () => {
  // "version unknown" on a never-paired row implies an agent whose build we
  // could not determine. There is no agent. The row already says "last seen
  // never", which is the whole truth -- and three grey badges in a column read
  // as three agents in the same unknown state rather than one.
  const badges = rows[3].badges.filter((b) => /version|^v\d/.test(b.text));
  assert.equal(badges.length, 0, `expected no version badge; got ${JSON.stringify(badges)}`);
  assert.match(rows[3].text, /last seen never/, 'and the row must still say so in words');
});

test('a live agent reporting no version IS badged unknown', { skip }, () => {
  // The distinction the test above depends on: silence FROM a running agent is
  // exactly what we stopped treating as fine, and must stay visible.
  const badge = rows[2].badges.find((b) => /version/.test(b.text));
  assert.ok(badge, 'a heartbeating agent that reports no version must still be badged');
  assert.equal(badge.text, 'version unknown');
});

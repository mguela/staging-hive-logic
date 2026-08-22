// Phase 7 -- the budget slider now recalculates a live per-channel
// allocation preview as it moves: owned channels (email, sms, google
// business profile, website/seo) are protected first, paid channels
// split the rest by current share, and a paid channel drops to zero if
// its share falls below its own minimum viable spend. Paused channels
// and paid channels that are not connected are excluded. No capacity
// cap or confidence score -- no real data source for either exists.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const htmlPath = 'public/marketing-command-center/index.html';
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractInlineScript() {
  // The page has more than one bare `<script>` tag -- the first is a tiny
  // embedded-mode check near the top of the body. The real application
  // code (including ccChannelAllocationPreview) lives in the next one.
  // Skip past the first so we grab the actual script block.
  const first = html.indexOf('<script>');
  assert.ok(first > -1);
  const start = html.indexOf('<script>', first + 1) + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

function fullRenderBudgetBody() {
  const start = html.indexOf('function renderBudget(data){');
  const end = html.indexOf('function renderAssumptions', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

// Load the real ccChannelAllocationPreview out of the real inline script,
// in a sandbox, so the test exercises the actual shipped function.
function loadRealPreviewFn() {
  const src = extractInlineScript();
  const start = src.indexOf('function ccChannelAllocationPreview');
  assert.ok(start > -1, 'expected ccChannelAllocationPreview to exist');
  const ownedStart = src.lastIndexOf('var OWNED_CHANNEL_KEYS', start);
  assert.ok(ownedStart > -1 && ownedStart < start);
  const end = src.indexOf('\nfunction renderBudget(data){', start);
  assert.ok(end > start);
  const fnSrc = src.slice(ownedStart, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox.ccChannelAllocationPreview;
}

function ch(key, label, monthlyCents, opts) {
  opts = opts || {};
  return {
    key, label, monthlyCents,
    minViableSpendCents: opts.minViableSpendCents != null ? opts.minViableSpendCents : null,
    dailyMaxCents: null, testingAllowanceCents: 0,
    paused: !!opts.paused,
    approvalThresholdCents: null,
  };
}

function conn(key, ready) { return { key, ready }; }

check('the real inline script is still syntactically valid JavaScript', () => {
  new vm.Script(extractInlineScript());
});

check('renderBudget reads connections off data.connections.items', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /var connectionItems = \(data\.connections \&\& data\.connections\.items\) \|\| \[\];/);
});

check('renderBudget wires the slider input event to a live channel preview, no new API call', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /function renderChannelPreview\(\)/);
  const sliderListenerStart = fn.indexOf("slider.addEventListener('input', function(){");
  assert.ok(sliderListenerStart > -1);
  const sliderListenerEnd = fn.indexOf('renderChannelPreview();', sliderListenerStart);
  assert.ok(sliderListenerEnd > sliderListenerStart);
  const sliderListenerBody = fn.slice(sliderListenerStart, sliderListenerEnd);
  assert.match(sliderListenerBody, /out\.textContent = money\(slider\.value\);/);
  const rcpStart = fn.indexOf('function renderChannelPreview(){');
  const rcpEnd = fn.indexOf('renderChannelPreview();', rcpStart);
  assert.ok(rcpStart > -1 && rcpEnd > rcpStart);
  const rcpBody = fn.slice(rcpStart, rcpEnd);
  assert.doesNotMatch(rcpBody, /api\(/);
});

check('the preview container only renders when there are real channels', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /\(channels\.length \? '\<div class="cc-card" id="cc-channel-preview"/);
});

const preview = loadRealPreviewFn();

check('owned channels keep their current spend unchanged when total shrinks but stays above owned total', () => {
  const channels = [
    ch('email', 'Email', 5000),
    ch('sms', 'SMS / Text', 3000),
    ch('google_ads', 'Google Ads', 40000),
    ch('meta_ads', 'Meta', 20000),
  ];
  const conns = [conn('google_ads', true), conn('meta_ads', true)];
  const result = preview(50000, channels, conns);
  const email = result.rows.find((r) => r.key === 'email');
  const sms = result.rows.find((r) => r.key === 'sms');
  assert.strictEqual(email.previewCents, 5000);
  assert.strictEqual(sms.previewCents, 3000);
  assert.strictEqual(email.changed, false);
});

check('paid channels split the remaining budget by their current real share', () => {
  const channels = [
    ch('email', 'Email', 5000),
    ch('google_ads', 'Google Ads', 30000),
    ch('meta_ads', 'Meta', 10000),
  ];
  const conns = [conn('google_ads', true), conn('meta_ads', true)];
  const result = preview(85000, channels, conns);
  const ga = result.rows.find((r) => r.key === 'google_ads');
  const meta = result.rows.find((r) => r.key === 'meta_ads');
  // remaining after owned (5000) = 80000, split 3:1 same as current 30000:10000
  assert.strictEqual(ga.previewCents, 60000);
  assert.strictEqual(meta.previewCents, 20000);
});

check('a paused channel is excluded and shown at zero with the real reason', () => {
  const channels = [
    ch('email', 'Email', 5000),
    ch('google_ads', 'Google Ads', 30000, { paused: true }),
  ];
  const conns = [conn('google_ads', true)];
  const result = preview(20000, channels, conns);
  const ga = result.rows.find((r) => r.key === 'google_ads');
  assert.strictEqual(ga.previewCents, 0);
  assert.strictEqual(ga.excludedReason, 'paused');
});

check('a paid channel that is not connected is excluded and shown at zero with the real reason', () => {
  const channels = [
    ch('email', 'Email', 5000),
    ch('google_ads', 'Google Ads', 30000),
  ];
  const conns = [conn('google_ads', false)];
  const result = preview(20000, channels, conns);
  const ga = result.rows.find((r) => r.key === 'google_ads');
  assert.strictEqual(ga.previewCents, 0);
  assert.strictEqual(ga.excludedReason, 'not connected');
});

check('a channel with no connection record at all (direct mail, other) is always eligible', () => {
  const channels = [
    ch('email', 'Email', 5000),
    ch('direct_mail', 'Direct Mail', 10000),
  ];
  const result = preview(20000, channels, []);
  const dm = result.rows.find((r) => r.key === 'direct_mail');
  assert.strictEqual(dm.excludedReason, null);
  assert.strictEqual(dm.previewCents, 15000);
});

check('a paid channel drops to zero and its share is redistributed when it would fall below its real minimum viable spend', () => {
  const channels = [
    ch('email', 'Email', 0),
    ch('google_ads', 'Google Ads', 9000, { minViableSpendCents: 5000 }),
    ch('meta_ads', 'Meta', 1000),
  ];
  const conns = [conn('google_ads', true), conn('meta_ads', true)];
  // total 3000: google_ads' 90% share would be 2700, below its real 5000 min -- drops to 0,
  // meta_ads gets the full 3000 instead.
  const result = preview(3000, channels, conns);
  const ga = result.rows.find((r) => r.key === 'google_ads');
  const meta = result.rows.find((r) => r.key === 'meta_ads');
  assert.strictEqual(ga.previewCents, 0);
  assert.strictEqual(ga.changed, true);
  assert.strictEqual(ga.excludedReason, 'below minimum viable spend');
  assert.strictEqual(meta.previewCents, 3000);
  assert.match(result.note, /Google Ads/);
  assert.match(result.note, /minimum viable spend/);
});

check('when the new total is below what owned channels alone need, owned channels scale down together and paid channels pause', () => {
  const channels = [
    ch('email', 'Email', 6000),
    ch('sms', 'SMS / Text', 4000),
    ch('google_ads', 'Google Ads', 20000),
  ];
  const conns = [conn('google_ads', true)];
  const result = preview(5000, channels, conns);
  const email = result.rows.find((r) => r.key === 'email');
  const sms = result.rows.find((r) => r.key === 'sms');
  const ga = result.rows.find((r) => r.key === 'google_ads');
  // owned total 10000, new total 5000 -> scale 0.5
  assert.strictEqual(email.previewCents, 3000);
  assert.strictEqual(sms.previewCents, 2000);
  assert.strictEqual(ga.previewCents, 0);
  assert.match(result.note, /owned channels/);
});

check('when no paid channels are eligible, extra budget is honestly reported as unallocated, not fabricated', () => {
  const channels = [
    ch('email', 'Email', 5000),
    ch('google_ads', 'Google Ads', 10000, { paused: true }),
  ];
  const result = preview(50000, channels, [conn('google_ads', true)]);
  const ga = result.rows.find((r) => r.key === 'google_ads');
  assert.strictEqual(ga.previewCents, 0);
  assert.match(result.note, /nowhere to go/);
});

check('an unrecognized total (NaN) returns null instead of a fabricated preview', () => {
  const channels = [ch('email', 'Email', 5000)];
  assert.strictEqual(preview(NaN, channels, []), null);
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

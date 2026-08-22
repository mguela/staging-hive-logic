// Phase 7 -- the budget slider now recalculates and shows a real lead-range
// preview live as it moves, instead of a static "see your Plan screen"
// message. The preview math is a client-side mirror of api/marketing.js's
// own computeForecast() "ready"-path formula (same band multipliers, same
// calculation), fed only the real assumptions the server already returned
// in data.plan.forecast.inputs -- no round-trip API call per slider tick,
// and nothing is saved until Save Budget is clicked (unchanged).

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const htmlPath = 'public/marketing-command-center/index.html';
const apiPath = 'api/marketing.js';

const html = fs.readFileSync(htmlPath, 'utf8');
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractInlineScript() {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > -1 && end > start, 'could not locate the real inline <script> block');
  return html.slice(start, end);
}

function fullRenderBudgetBody() {
  const start = html.indexOf('function renderBudget(data){');
  const end = html.indexOf('function renderAssumptions', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('the real inline <script> is still syntactically valid JavaScript', () => {
  new vm.Script(extractInlineScript());
});

check('the client-side CC_FORECAST_BANDS multipliers exactly match api/marketing.js\'s real FORECAST_BANDS -- never allowed to drift from the real server formula', () => {
  const serverMatch = api.match(/const FORECAST_BANDS = \{ conservative: ([\d.]+), expected: ([\d.]+), upside: ([\d.]+) \};/);
  assert.ok(serverMatch, 'expected to find the real server-side FORECAST_BANDS constant');
  const clientMatch = html.match(/var CC_FORECAST_BANDS = \{ conservative: ([\d.]+), expected: ([\d.]+), upside: ([\d.]+) \};/);
  assert.ok(clientMatch, 'expected to find the client-side CC_FORECAST_BANDS constant');
  assert.strictEqual(clientMatch[1], serverMatch[1], 'conservative multiplier must match the real server value');
  assert.strictEqual(clientMatch[2], serverMatch[2], 'expected multiplier must match the real server value');
  assert.strictEqual(clientMatch[3], serverMatch[3], 'upside multiplier must match the real server value');
});

check('ccLiveForecastText returns null (never a fabricated estimate) when any real required assumption is missing', () => {
  const fn = html.slice(html.indexOf('function ccLiveForecastText'), html.indexOf('function renderBudget'));
  assert.match(fn, /if \(!inputs \|\| inputs\.grossMarginPct == null \|\| inputs\.qualifiedLeadRatePer100 == null \|\| inputs\.closeRatePct == null \|\| !inputs\.avgJobValueCents\) return null;/);
});

check('ccLiveForecastText picks the real headline band from the real riskPosture, same mapping as the server\'s headlineBand logic', () => {
  const fn = html.slice(html.indexOf('function ccLiveForecastText'), html.indexOf('function renderBudget'));
  assert.match(fn, /inputs\.riskPosture === 'conservative'\) \? 'conservative' : \(inputs\.riskPosture === 'aggressive' \? 'upside' : 'expected'\)/);
});

check('ccLiveForecastText caps soldJobs at the real maxNewJobsPerMonth when one is set, matching the server\'s own capacity cap', () => {
  const fn = html.slice(html.indexOf('function ccLiveForecastText'), html.indexOf('function renderBudget'));
  assert.match(fn, /if \(inputs\.maxNewJobsPerMonth != null\) soldJobs = Math\.min\(soldJobs, inputs\.maxNewJobsPerMonth\);/);
});

check('renderBudget captures the real forecast object (data.plan.forecast) into f, honestly defaulting to blocked_assumptions when absent', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /var f = data\.plan\.forecast \|\| \{status:'blocked_assumptions'\};/);
});

check('the slider input listener recalculates the live preview text using the real f.inputs and the real live slider value -- not a cached/stale value', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /var liveText = ccLiveForecastText\(f\.inputs, Number\(slider\.value\)\);/);
  assert.match(fn, /if \(liveText\) est\.textContent = liveText;/);
});

check('the live preview is only attempted when the real forecast status is ready -- a blocked forecast never gets a fabricated live number', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /if \(est && f\.status === 'ready'\) \{/);
});

check('the initial (pre-interaction) estimate render uses the same real ccLiveForecastText function with the real starting budget value, falling back to the pre-existing honest static message if it returns null', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /\(f\.status === 'ready' \? \(ccLiveForecastText\(f\.inputs, val\) \|\| 'See your Plan screen for the lead range this budget could hit\.'\) : 'Set your assumptions on the Plan screen to see a lead range for this budget\.'\)/);
});

check('the estimate element now has a stable id (cc-budget-est) so the live listener can find and update it', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /class="cc-slider-est" id="cc-budget-est"/);
});

check('Save Budget still only fires on click, still gates persistence behind the button, and the live preview never calls the save API itself', () => {
  const fn = fullRenderBudgetBody();
  const saveIdx = fn.indexOf("getElementById('cc-budget-save')");
  assert.ok(saveIdx > -1, 'expected the Save Budget click handler to still be wired');
  const inputListenerBody = fn.slice(fn.indexOf("addEventListener('input'"), saveIdx);
  assert.ok(!inputListenerBody.includes("api('command_center_budget'"), 'the slider input listener must never itself call the save API -- only the Save Budget click handler may');
});

check('the pre-existing min/max slider bounds and the honest "sets the ceiling for paid channels" callout are unchanged', () => {
  const fn = fullRenderBudgetBody();
  assert.match(fn, /min="\' \+ min \+ \'" max="\' \+ max \+ \'"/);
  assert.match(fn, /This sets the ceiling for paid channels once they\\'re connected and launch-ready\./);
});

check('renderBudget is still defined exactly once -- structural check, no duplication', () => {
  assert.strictEqual((html.match(/function renderBudget\(data\)\{/g) || []).length, 1);
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

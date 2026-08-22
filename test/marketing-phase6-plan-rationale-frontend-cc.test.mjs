// Phase 6 -- wires the real, deterministic plan-selection "why" rationale
// (api/marketing.js's computePlanRationale, shipped in the prior slice) into
// the command-center's Planning Assumptions screen as a "Why this plan"
// card. Renders only real rationale.text values the backend actually
// returned -- an empty rationale array (every rule silent) must render
// nothing, never a fabricated placeholder card.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const htmlPath = 'public/marketing-command-center/index.html';
const apiPath = 'api/marketing.js';

const html = fs.readFileSync(htmlPath, 'utf8');
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function boundFn(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = text.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return text.slice(startIdx, endIdx);
}

// NOTE: this file has two <script> tags -- the real inline app script, and a
// trailing `<script src="/voice-input.js" defer></script>` external tag
// added by an unrelated concurrent session. A naive greedy
// /<script>([\s\S]*)<\/script>/ match (the pattern this project's earlier
// frontend tests used) backtracks to the LAST </script> in the document and
// therefore swallows the external tag's text into the "inline script" --
// producing a false syntax-error negative that has nothing to do with this
// slice's real edits. Bounding to the FIRST </script> after the FIRST
// <script> gets the real inline app script only.
function extractInlineScript() {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > -1 && end > start, 'could not locate the real inline <script> block');
  return html.slice(start, end);
}

check('the real inline <script> (bounded to its own real close tag, not a later unrelated external script tag) is still syntactically valid JavaScript', () => {
  const script = extractInlineScript();
  new vm.Script(script);
});

check('api/marketing.js really does return a rationale array for the frontend to read (cross-file check)', () => {
  assert.ok(api.includes('rationale: computePlanRationale(reference)'), 'backend must actually expose rationale for this frontend addition to be honest');
});

function fullRenderAssumptionsBody() {
  const start = html.indexOf('function renderAssumptions(data){');
  const end = html.indexOf('// ---------- Calendar', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('renderAssumptions reads the real r.rationale array off the command_center_assumptions response, defaulting to an empty array when absent (never fabricated)', () => {
  const fn = fullRenderAssumptionsBody();
  assert.match(fn, /var rationale = \(r && r\.rationale\) \|\| \[\];/);
});

check('the "Why this plan" card only renders when rationale actually has real items -- an empty array renders nothing, never a placeholder card', () => {
  const fn = fullRenderAssumptionsBody();
  assert.match(fn, /\(rationale\.length \? \(/);
  assert.match(fn, /\) : ''\) \+/);
});

check('each rationale row escapes the real item.text via esc() (never raw-injected) and labels it by its real priority (blocker/opportunity/info), never inventing a priority', () => {
  const fn = fullRenderAssumptionsBody();
  assert.match(fn, /rationale\.map\(function\(item\)\{/);
  assert.match(fn, /item\.priority === 'blocker' \? 'Blocker' : \(item\.priority === 'opportunity' \? 'Opportunity' : 'Note'\)/);
  assert.match(fn, /esc\(item\.text\)/);
});

check('the pre-existing "Real reference data" card (avg job value / historical jobs per month) is unchanged and still renders before the rationale card', () => {
  const fn = fullRenderAssumptionsBody();
  assert.match(fn, /Real reference data/);
  const refIdx = fn.indexOf('Real reference data');
  const rationaleIdx = fn.indexOf('Why this plan');
  assert.ok(refIdx > -1 && rationaleIdx > refIdx, 'rationale card must come after the real reference data card, not before or replacing it');
});

check('the pre-existing assumption input fields (gross margin, lead rate, close rate, max jobs, avg job override, risk posture) are unchanged and still render after the rationale card', () => {
  const fn = fullRenderAssumptionsBody();
  const rationaleIdx = fn.indexOf('Why this plan');
  const fieldsIdx = fn.indexOf("field('cc-a-margin'");
  assert.ok(rationaleIdx > -1 && fieldsIdx > rationaleIdx, 'assumption fields must still render after the rationale card, unchanged in position relative to each other');
  ['cc-a-margin', 'cc-a-leadrate', 'cc-a-close', 'cc-a-maxjobs', 'cc-a-avgjob', 'cc-a-risk'].forEach((id) => {
    assert.ok(fn.includes(id), `expected the pre-existing field ${id} to still be present`);
  });
});

check('the Save Assumptions button and its real POST-then-reload flow are unchanged', () => {
  const fn = fullRenderAssumptionsBody();
  assert.match(fn, /api\('command_center_assumptions', \{method:'POST', body: JSON\.stringify\(body\)\}\)/);
  assert.match(fn, /id="cc-assump-save"/);
});

check('renderAssumptions is still defined exactly once -- structural check, no duplication', () => {
  assert.strictEqual((html.match(/function renderAssumptions\(data\)\{/g) || []).length, 1);
});

check('screenFor() still dispatches the assumptions route to renderAssumptions, unchanged', () => {
  assert.match(html, /if \(route === 'assumptions'\) return renderAssumptions\(data\);/);
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

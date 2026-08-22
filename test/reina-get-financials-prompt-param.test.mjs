// Bug fix (2026-08-07): the master prompt's get_financials guidance told
// Reina to call the tool as `report:'summary'`/`'ar_aging'`/etc, but the
// tool's real input_schema (api/chat.js) only ever defined a `kind`
// property -- chat.js reads `input.kind || 'summary'` and never looks at
// `input.report` at all. A model that followed the prompt's own wording
// literally would send {report: 'ar_aging'} with no `kind`, so
// input.kind was always undefined and every drill-down silently fell back
// to the summary payload -- ar_aging, ap_aging, open_invoices, and
// profit_and_loss all looked identical. Fixed by aligning the prompt's
// wording to the schema's real argument name.

import fs from 'node:fs';
import assert from 'node:assert';

const promptPath = 'api/_lib/brain/00-master-prompt.md';
const chatPath = 'api/chat.js';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const promptBody = fs.readFileSync(promptPath, 'utf8');
const chatBody = fs.readFileSync(chatPath, 'utf8');

check('master prompt tells Reina to call get_financials with kind, not report', () => {
  assert.match(promptBody, /kind:'summary'/);
  assert.doesNotMatch(promptBody, /report:'summary'/);
  assert.doesNotMatch(promptBody, /report:'ar_aging'/);
});

check('master prompt explicitly warns against the old wrong argument name', () => {
  assert.match(promptBody, /never `report`/);
});

check('get_financials input_schema only defines kind (the name the prompt now uses)', () => {
  const schemaStart = chatBody.indexOf("name: 'get_financials'");
  assert.ok(schemaStart > -1, 'get_financials tool definition not found');
  const schemaEnd = chatBody.indexOf('];', schemaStart);
  const schema = chatBody.slice(schemaStart, schemaEnd);
  assert.match(schema, /kind:\s*\{/);
  assert.doesNotMatch(schema, /report:\s*\{/);
});

check('the handler reads input.kind -- confirming report would have been silently ignored', () => {
  assert.match(chatBody, /qboGetFinancials\(input\.kind \|\| 'summary'\)/);
  assert.doesNotMatch(chatBody, /input\.report/);
});

let failed = 0;
for (const { name, fn } of checks) {
  try { fn(); console.log('ok -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n   ', e.message); }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed) process.exit(1);

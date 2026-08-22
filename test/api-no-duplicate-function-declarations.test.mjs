import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Phase 19 (test coverage across the whole suite): a real bug was found and
// fixed in api/marketing.js's Phase 6 consolidation work (documented in
// reina/marketing-suite-master-build-plan-2026-07-29.md) -- a hand-merge
// left behind a duplicate nested function declaration:
//   async function handleAssumptionsGet(req, res) {
//     async function handleAssumptionsGet(req, res) { ...real body... }
//   }
// The OUTER function (the one actually routed to) had a body consisting of
// nothing but defining an inner shadow function of the same name and
// implicitly returning undefined -- the real res.status(200).json(...) call
// lived inside the never-invoked inner function. It went undetected because
// every existing test for that handler was a structural/regex assertion on
// source text, never an actual invocation -- this is exactly the "flagged
// here rather than actioned now" test-coverage gap the build plan's own
// notes called out for a "broader sweep across other consolidated/hand-
// merged handlers." This file is that sweep: a cheap, repo-wide static check
// that a function name is never declared twice within the same file --
// which would have caught the real bug above on day one, and remains a
// standing regression guard against it recurring in any api/*.js file
// (this codebase's own convention never intentionally reuses a function
// name, flat or nested).

const FUNCTION_DECL_RE = /(?:async\s+)?function\s+(\w+)\s*\(/g;

function findDuplicateFunctionNames(source) {
  const counts = new Map();
  let m;
  FUNCTION_DECL_RE.lastIndex = 0;
  while ((m = FUNCTION_DECL_RE.exec(source))) {
    const name = m[1];
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------- Unit test of the detector itself, pinning the real bug shape ----------

check('detector: a clean file with unique function names reports zero duplicates', () => {
  const src = 'function a() {}\nasync function b() {}\nfunction c() { function innerHelper() {} }\n';
  assert.deepEqual(findDuplicateFunctionNames(src), []);
});

check('detector: the real historical bug shape (nested same-name shadow function) is caught', () => {
  const src = [
    'async function handleAssumptionsGet(req, res) {',
    '  async function handleAssumptionsGet(req, res) {',
    '    res.status(200).json({ ok: true });',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(findDuplicateFunctionNames(src), ['handleAssumptionsGet']);
});

check('detector: two separate flat top-level declarations of the same name are also caught', () => {
  const src = 'function handleThing(req, res) {}\nfunction handleThing(req, res) {}\n';
  assert.deepEqual(findDuplicateFunctionNames(src), ['handleThing']);
});

// ---------- Real repo-wide sweep ----------

const API_DIR = 'api';
const apiFiles = fs.readdirSync(API_DIR).filter((f) => f.endsWith('.js')).sort();

check('sanity: the api/ directory actually has real .js files to scan (glob is not silently empty)', () => {
  assert.ok(apiFiles.length >= 10, `expected a real number of api/*.js files, found ${apiFiles.length}`);
});

for (const fname of apiFiles) {
  check(`no duplicate function declarations in api/${fname}`, () => {
    const src = fs.readFileSync(path.join(API_DIR, fname), 'utf8');
    const dups = findDuplicateFunctionNames(src);
    assert.deepEqual(dups, [], `api/${fname} declares these function name(s) more than once: ${dups.join(', ')}`);
  });
}

// ---------- Runner ----------

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

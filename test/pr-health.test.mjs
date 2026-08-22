// Tests for scripts/pr-health.mjs -- the guard that looks for PRs nothing is
// testing, as opposed to PRs that are failing.
//
// The bug it exists for is an ABSENCE, which makes it unusually easy to write a
// guard that cannot fail: if the check is "does this PR look wrong", a PR with
// no runs looks exactly like a PR whose runs have not registered yet. So the
// interesting tests here are the ones that pin down when it must STAY QUIET --
// 'unknown' mergeability, a freshly pushed PR, a genuinely failing check. A
// guard that fires on those gets muted within a week and then the real thing
// goes unnoticed again, which is precisely what happened without it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPr, missingRequiredChecks, selectFlagged, renderComment, renderResolvedComment,
  REQUIRED_CHECKS, COMMENT_MARKER, DEFAULT_OPTIONS,
} from '../scripts/pr-health.mjs';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const NOW = Date.parse('2026-08-19T00:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

const bothChecks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
// The exact shape that fooled everyone: one green check, and it is a deployment.
const onlyVercel = [{ name: 'Vercel Preview Comments', status: 'completed', conclusion: 'success' }];

test('the real #198 shape -- conflicted, four days old, only a preview check -- is flagged', () => {
  const v = classifyPr({ mergeableState: 'dirty', checkRuns: onlyVercel, updatedAt: hoursAgo(96) }, NOW);
  assert.equal(v.status, 'conflicted');
  assert.match(v.reason, /no merge ref/);
  assert.deepEqual(v.missing, REQUIRED_CHECKS, 'both required checks are absent on that commit');
});

test('a healthy PR with both required checks is silent', () => {
  const v = classifyPr({ mergeableState: 'clean', checkRuns: [...bothChecks, ...onlyVercel], updatedAt: hoursAgo(48) }, NOW);
  assert.equal(v.status, 'ok');
  assert.deepEqual(v.missing, []);
});

// --- the quiet cases: firing on any of these makes the guard worthless -------

test("mergeable_state 'unknown' is not treated as a conflict", () => {
  // GitHub computes mergeability lazily; the first read after a push says
  // 'unknown' whether or not the PR conflicts. Guessing here would fire on
  // essentially every active PR.
  const v = classifyPr({ mergeableState: 'unknown', checkRuns: bothChecks, updatedAt: hoursAgo(48) }, NOW);
  assert.equal(v.status, 'ok');
  assert.match(v.reason, /not yet computed/);
});

test('a PR pushed minutes ago is not flagged for having no runs yet', () => {
  const v = classifyPr({ mergeableState: 'clean', checkRuns: [], updatedAt: hoursAgo(0.1) }, NOW);
  assert.equal(v.status, 'ok');
  assert.match(v.reason, /grace window/);
});

test('a conflict is given a grace window before it is reported', () => {
  const fresh = classifyPr({ mergeableState: 'dirty', checkRuns: onlyVercel, updatedAt: hoursAgo(1) }, NOW);
  assert.equal(fresh.status, 'ok', 'someone may be mid-rebase');
  const stale = classifyPr({ mergeableState: 'dirty', checkRuns: onlyVercel, updatedAt: hoursAgo(7) }, NOW);
  assert.equal(stale.status, 'conflicted');
});

test('a FAILING required check is not this guard\'s business', () => {
  // A red X is visible and someone can act on it. This guard is only for the
  // state that looks like nothing is wrong.
  const failing = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'failure' }));
  const v = classifyPr({ mergeableState: 'clean', checkRuns: failing, updatedAt: hoursAgo(48) }, NOW);
  assert.equal(v.status, 'ok');
});

test('a check that is still running counts as present, not missing', () => {
  const running = REQUIRED_CHECKS.map((name) => ({ name, status: 'in_progress', conclusion: null }));
  const v = classifyPr({ mergeableState: 'clean', checkRuns: running, updatedAt: hoursAgo(48) }, NOW);
  assert.equal(v.status, 'ok');
});

test('a missing updated_at is reported as indeterminate rather than guessed', () => {
  const v = classifyPr({ mergeableState: 'dirty', checkRuns: [], updatedAt: undefined }, NOW);
  assert.equal(v.status, 'indeterminate');
});

// --- partial coverage -------------------------------------------------------

test('one required check present and one absent is still untested', () => {
  const half = [{ name: REQUIRED_CHECKS[0], status: 'completed', conclusion: 'success' }];
  const v = classifyPr({ mergeableState: 'clean', checkRuns: half, updatedAt: hoursAgo(48) }, NOW);
  assert.equal(v.status, 'untested');
  assert.deepEqual(v.missing, [REQUIRED_CHECKS[1]]);
});

test('an unconflicted PR with no runs at all is untested -- conflict is a cause, not the harm', () => {
  // A run cancelled by concurrency and never retried leaves exactly this.
  const v = classifyPr({ mergeableState: 'clean', checkRuns: onlyVercel, updatedAt: hoursAgo(48) }, NOW);
  assert.equal(v.status, 'untested');
});

test('missingRequiredChecks tolerates junk in the runs array', () => {
  assert.deepEqual(missingRequiredChecks(null), REQUIRED_CHECKS);
  assert.deepEqual(missingRequiredChecks([null, {}, { name: 42 }]), REQUIRED_CHECKS);
});

test('selectFlagged returns only the PRs worth reporting', () => {
  const flagged = selectFlagged([
    { number: 1, mergeableState: 'clean', checkRuns: bothChecks, updatedAt: hoursAgo(48) },
    { number: 2, mergeableState: 'dirty', checkRuns: onlyVercel, updatedAt: hoursAgo(96) },
    { number: 3, mergeableState: 'clean', checkRuns: [], updatedAt: hoursAgo(0.1) },
  ], NOW);
  assert.deepEqual(flagged.map((f) => f.pr.number), [2]);
});

// --- the comment ------------------------------------------------------------

test('the comment carries the marker that lets a later run update it in place', () => {
  const v = classifyPr({ mergeableState: 'dirty', checkRuns: onlyVercel, updatedAt: hoursAgo(96) }, NOW);
  const body = renderComment({ number: 198 }, v);
  // startsWith(COMMENT_MARKER) alone is vacuous -- an empty marker satisfies it
  // for every string, and an empty marker means the workflow's
  // `body.includes(COMMENT_MARKER)` lookup matches the FIRST comment on the PR
  // and edits somebody else's words. So pin the marker's shape too.
  assert.match(COMMENT_MARKER, /^<!--\s*\S.*-->$/, 'the marker must be a non-empty HTML comment');
  assert.ok(COMMENT_MARKER.length > 10, 'a short marker risks colliding with unrelated comment text');
  assert.ok(body.startsWith(COMMENT_MARKER), 'without the marker every run appends a new comment');
  assert.ok(renderResolvedComment().includes(COMMENT_MARKER));
  assert.match(body, /not a\s+test result/, 'it must say the green check is not a test result');
  for (const name of REQUIRED_CHECKS) assert.ok(body.includes(name), `${name} must be named`);
});

test('a conflicted PR whose checks DID run is not told they never started', () => {
  // Taken from the real #482, the first PR this guard ever commented on. Both
  // required checks were green on the head commit -- they ran when the PR was
  // opened, and main moved underneath it hours later. The comment nevertheless
  // said "The test jobs never start" and "Any green check you see here ... is
  // not a test result". Both were false about that PR.
  //
  // This is the failure class the guard itself was built to catch, turned on
  // the guard: an output asserting more than it measured. A monitor that is
  // wrong in a way the reader can personally verify gets muted, and then the
  // times it is right go unread too.
  const v = classifyPr({ mergeableState: 'dirty', checkRuns: bothChecks, updatedAt: hoursAgo(24) }, NOW);
  assert.equal(v.status, 'conflicted');
  assert.deepEqual(v.missing, [], 'both required checks ran -- that is the premise of this case');

  const body = renderComment({ number: 482 }, v);
  assert.doesNotMatch(body, /never start/,
    'the checks demonstrably did start; only NEW ones are blocked');
  assert.doesNotMatch(body, /is not a\s+test result/,
    'the green check on this PR is a genuine test result, just against an older base');
  assert.match(body, /No further check can run/,
    'it must still say what IS true: the conflict blocks any further run');
  assert.match(body, /older\* base|older base/,
    'and why the existing green is weaker than it looks');
});

test('a conflicted PR with no runs at all still gets the blunt warning', () => {
  // The other half of the branch. Deleting the `missing.length` test in
  // renderComment must not silently collapse both cases into the softer copy --
  // for a PR that genuinely never ran anything, "the test jobs never start" is
  // the accurate and more urgent sentence.
  const v = classifyPr({ mergeableState: 'dirty', checkRuns: onlyVercel, updatedAt: hoursAgo(96) }, NOW);
  const body = renderComment({ number: 198 }, v);
  assert.match(body, /The test jobs never start/);
  assert.match(body, /is not a\s+test result/);
  for (const name of REQUIRED_CHECKS) {
    assert.ok(body.includes(name), `${name} must be listed as having no run`);
  }
});

test('the resolved comment does not still read as a warning', () => {
  const resolved = renderResolvedComment();
  assert.match(resolved, /Resolved/);
  assert.doesNotMatch(resolved, /⚠/, 'a stale warning must not outlive the problem it described');
});

// --- wiring -----------------------------------------------------------------

test('the workflow imports this module and has permission to comment', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/pr-health-guard.yml'), 'utf8');
  assert.match(wf, /scripts\/pr-health\.mjs/, 'the workflow must use this module, not its own copy of the rules');
  assert.match(wf, /pull-requests:\s*write/, 'it cannot post without this permission');
  assert.match(wf, /schedule:/, 'a guard nobody runs is not a guard');
  // It reads mergeable_state, which the LIST endpoint does not return -- only a
  // per-PR get does. Getting this wrong makes every PR look 'undefined'.
  assert.match(wf, /pulls\.get\(/, 'mergeable_state requires a single-PR read');
  assert.match(wf, /checks\.listForRef/, 'it must read the runs on the head commit');
});

// The first scheduled run of this workflow failed in 11 seconds:
//
//   403 Resource not accessible by integration
//   GET /repos/.../commits/<sha>/check-runs
//
// The permissions block granted contents:read and pull-requests:write, but
// checks.listForRef needs checks:read -- the one call the entire verdict rests
// on. So the guard written to catch "shipped, and never actually worked" was
// itself shipped and never actually worked.
//
// The lesson is not "add checks:read". It is that a workflow's permissions
// block and the API calls in its script are two lists that must agree, and
// nothing was checking that they did. This test is that check: every call the
// script makes is tied to the scope it requires, so a missing grant fails here
// rather than silently at 09:00 on a Tuesday.
test('every API the guard calls has the permission scope it requires', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/pr-health-guard.yml'), 'utf8');
  // Comment lines stripped, or this test reads the paragraph EXPLAINING why
  // checks:read is needed and calls that a grant. It did exactly that on the
  // first attempt: deleting the real `checks: read` line left the prose behind
  // and the assertion still passed. Only the YAML that GitHub parses counts.
  const perms = wf.slice(wf.indexOf('permissions:'), wf.indexOf('concurrency:'))
    .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

  const REQUIRES = [
    // [what the script calls, the scope GitHub demands, why]
    ['checks.listForRef', /checks:\s*read|checks:\s*write/,
      'reading check runs on a commit'],
    ['pulls.list', /pull-requests:\s*(read|write)/, 'listing open PRs'],
    ['pulls.get', /pull-requests:\s*(read|write)/, 'reading mergeable_state'],
    ['issues.createComment', /pull-requests:\s*write/, 'posting the sticky comment'],
    ['issues.updateComment', /pull-requests:\s*write/, 'editing it in place'],
  ];

  for (const [call, scope, why] of REQUIRES) {
    const method = call.split('.')[1];
    assert.ok(wf.includes(call) || wf.includes(method),
      `the workflow no longer calls ${call} -- update this table rather than deleting the row`);
    assert.match(perms, scope,
      `${call} (${why}) needs a scope the permissions block does not grant. `
      + 'A missing scope is a 403 at run time, not a syntax error, so nothing else catches it.');
  }
});

test('the guard asks for no more access than it uses', () => {
  // The other half of the same contract. This workflow reads PRs and writes one
  // comment; it must never quietly acquire the ability to push code or move
  // deployments just because a scope was added while debugging a 403.
  const wf = fs.readFileSync(path.join(root, '.github/workflows/pr-health-guard.yml'), 'utf8');
  const perms = wf.slice(wf.indexOf('permissions:'), wf.indexOf('concurrency:'))
    .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(perms, /contents:\s*write/, 'the guard must never be able to push');
  assert.doesNotMatch(perms, /actions:\s*write/, 'it must never be able to trigger or cancel workflows');
  assert.doesNotMatch(perms, /^\s*permissions:\s*write-all/m, 'never write-all');
});

test('the required check names match the workflow that actually produces them', () => {
  const gate = fs.readFileSync(path.join(root, '.github/workflows/hardened-completion-gate.yml'), 'utf8');
  // Exact job names, not `includes`. A check run is matched by its exact name,
  // and `includes` passes for any PREFIX -- "Full regression" is a substring of
  // "Full regression (required for DONE)", so a truncated constant would look
  // correct here while matching no real check run and reporting every PR as
  // untested forever.
  const jobNames = [...gate.matchAll(/^\s*name:\s*(.+?)\s*$/gm)].map((m) => m[1]);
  assert.ok(jobNames.length > 2, `expected job names in the gate workflow, found ${jobNames.length}`);
  for (const name of REQUIRED_CHECKS) {
    assert.ok(jobNames.includes(name),
      `"${name}" is not an exact job name in hardened-completion-gate.yml `
      + `(it has: ${jobNames.join(' | ')}) -- a name that matches no check run `
      + 'would report every PR as untested forever');
  }
});

test('the grace windows are long enough to be believable', () => {
  assert.ok(DEFAULT_OPTIONS.graceMinutes >= 30, 'runs can take a while to register');
  assert.ok(DEFAULT_OPTIONS.conflictGraceHours >= 1, 'do not fire while someone is mid-rebase');
});

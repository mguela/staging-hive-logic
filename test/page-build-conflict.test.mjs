// test/page-build-conflict.test.mjs
//
// The page build id is a DERIVED value kept in SOURCE, on one line, in two
// files. Any two branches that touch public/index.html both re-stamp it, so
// they both rewrite that line, so they conflict -- every time, by construction.
//
// That happened five times in one evening on 2026-08-18, and each one cost far
// more than the conflict itself: GitHub dispatches NO checks for a pull request
// it cannot merge, so the PR shows an empty check list, which is
// indistinguishable from "the gate has not started". Twice the wait was for a
// run that was never coming.
//
// Two things close it. The stamper resolves the id conflict itself, because
// BOTH sides are wrong the moment the branches combine -- the correct id is the
// hash of the merged files, which neither side has seen. And a Mergeable check
// turns the silence into a red check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync('scripts/stamp-page-build.mjs', 'utf8');
const workflow = fs.readFileSync('.github/workflows/mergeable.yml', 'utf8');

test('the stamper resolves a conflict that is only the build id', () => {
  assert.match(script, /function resolveBuildIdConflicts\(/);
  assert.match(script, /both sides were stale/,
    'the message should say why picking a side by hand was never the answer');
});

test('it refuses any conflict that is not the build id', () => {
  // Quietly picking a side in a 27,000-line HTML file would be the silent wrong
  // answer this whole marker exists to prevent.
  assert.match(script, /function isJustABuildId\(/);
  assert.match(script, /conflict\(s\) that are not the build id -- resolve those by hand first/);
  // Both sides must qualify -- checking only one would let real content through
  // whenever it happened to land on the other side of the marker.
  assert.match(script, /if \(isJustABuildId\(ours\) && isJustABuildId\(theirs\)\)/);
});

test('page-build.js is imported AFTER the conflict is cleared, not before', () => {
  // It is one of the two files that can carry a conflict, and a static import
  // of a file containing '<<<<<<<' is a SyntaxError thrown before any of this
  // runs -- so the tool that exists to fix the conflict died on it. Found by
  // testing that case, not by reasoning about it.
  const dynamicImport = script.indexOf("await import('../api/_lib/page-build.js')");
  const resolve = script.indexOf('resolveBuildIdConflicts(html, HTML)');
  assert.ok(dynamicImport > -1, 'it must be a dynamic import');
  assert.ok(resolve > -1 && resolve < dynamicImport,
    'the conflict must be cleared before the file is loaded');
  assert.doesNotMatch(script, /^import \{[^}]*\} from '\.\.\/api\/_lib\/page-build\.js';/m,
    'a static import would crash on the exact input this feature exists to handle');
});

test('--check reports an unresolved id conflict rather than silently passing', () => {
  assert.match(script, /unresolved merge conflict on the id/);
});

// --- The check that makes a conflicted PR visible --------------------------

test('the mergeable check runs on the base, because a conflicted PR cannot run the other kind', () => {
  assert.match(workflow, /pull_request_target:/,
    'a pull_request workflow is exactly what a conflicted PR cannot run');
  assert.doesNotMatch(workflow, /^\s*on:\s*\n\s*pull_request:/m);
});

test('it never checks out or runs the pull request code', () => {
  // pull_request_target carries repository write scope and secrets. The rule is
  // that it must not execute the PR's code; this job asks the API one question.
  const uses = workflow.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.deepEqual(uses, [], `no action steps allowed, found:\n${uses.join('\n')}`);
  assert.doesNotMatch(workflow, /npm (ci|install|test)/);
});

test('it fails on a conflict and says what an empty check list means', () => {
  assert.match(workflow, /exit 1/);
  assert.match(workflow, /An empty check list here means BLOCKED, not pending/,
    'the misreading that cost the time has to be named, or it gets made again');
  assert.match(workflow, /node scripts\/stamp-page-build\.mjs/,
    'and the remedy belongs in the message, not in someone\'s memory');
});

test('it waits for GitHub to compute mergeability instead of reading null once', () => {
  // mergeable is computed asynchronously and is null until it is ready. A
  // single immediate read would report unknown for most PRs, and a check that
  // cries wolf gets ignored on the day it is right.
  assert.match(workflow, /mergeable not computed yet/);
  assert.match(workflow, /\[ "\$mergeable" != "null" \] && break/);
  assert.match(workflow, /Failing on it would cry wolf/);
});

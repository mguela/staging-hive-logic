// test/ci-completion-gate.test.mjs
//
// The completion gate is the only thing that tells us whether a commit is good.
// Two properties of its concurrency config are easy to change by accident and
// silently expensive, so they are asserted here rather than remembered.
//
// On 2026-08-17 three consecutive merges to main -- 3f54f0e, 4eeacb3c, 492f788 --
// each had their workflow run CANCELLED by the merge that landed a minute later,
// because the concurrency group was keyed only on github.ref and every push to
// main shares that ref. Nothing unsafe happened: the next run covers the merged
// tree. But no one of those commits was ever verified by a run of its own, so
// "did main go green for my commit" had no answer -- which is the one question
// this workflow exists to answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKFLOW = '.github/workflows/hardened-completion-gate.yml';
const src = fs.readFileSync(WORKFLOW, 'utf8');
const group = src.match(/^\s*group:\s*(.+)$/m)?.[1] ?? '';

test('a push to main cannot have its run cancelled by the next merge', () => {
  assert.ok(group, 'the workflow must declare a concurrency group');
  assert.match(
    group, /github\.event_name == 'push'[\s\S]*github\.sha/,
    'the concurrency group must include github.sha for push events, or consecutive ' +
    'merges to main share a group and cancel each other'
  );
});

test('pull request runs still supersede each other', () => {
  // The flip side: without cancellation, every intermediate push to a PR branch
  // would run a full browser suite nobody is waiting for.
  assert.match(src, /cancel-in-progress:\s*true/,
    'a new push to a PR branch should still cancel the previous run');
  assert.match(group, /github\.ref/,
    'PR runs are grouped by ref, which is what makes the newest head win');
});

test('the fallback keeps non-push events grouped by ref alone', () => {
  // pull_request and merge_group must NOT be keyed by sha -- that would make
  // every push to a PR branch its own group and cancel nothing.
  assert.match(group, /\|\|\s*'head'/,
    "non-push events must fall back to a constant, not to the commit sha");
});

test('the gate still runs on the events it is meant to gate', () => {
  for (const trigger of ['pull_request:', 'push:', 'merge_group:']) {
    assert.ok(src.includes(trigger), `the gate must still trigger on ${trigger}`);
  }
  assert.match(src, /branches:\s*\[main\]/, 'push runs are scoped to main');
});

// --- The browser job must not be able to die before it tests anything --------
//
// On 2026-08-18 the "Install browser system deps" step -- an apt-get against
// Ubuntu mirrors -- hung three times, each time for the job's whole 15-minute
// budget, so `npm run test:ui` was SKIPPED and the run reported nothing. It had
// drifted first: ~2 min, then ~6.5, then the timeout. #412 bounded it; #405
// removed it, because on ubuntu-latest it installed nothing this suite needs.

test('the cache-hit path does not shell out to apt', () => {
  // The removed step. A revert would reintroduce a 15-minute hang that produces
  // no test signal at all.
  //
  // Checked against executable lines only -- the comment above the removed step
  // names the command it removed, and that mention must not fail this.
  const runLines = src.split('\n').filter((l) => !/^\s*#/.test(l) && /run:/.test(l));
  assert.ok(runLines.length >= 4, `sanity: expected the job's run steps, found ${runLines.length}`);
  assert.ok(!runLines.some((l) => l.includes('install-deps')),
    'the browser job must not run `playwright-core install-deps` -- see #405');
});

test('the cache-miss path may still install deps, because that is the rare one', () => {
  // Deliberately NOT removed: a fresh Playwright version with no cached browser
  // is the one case where the system libraries genuinely may be missing. It runs
  // only on a playwright-core bump.
  const miss = src.slice(src.indexOf('- name: Install Chromium'));
  assert.match(miss.slice(0, miss.indexOf('npm run test:ui')), /cache-hit\s*!=\s*'true'/,
    'the install step must still be gated on a cache MISS');
});

test('a browser that cannot start still fails loudly', () => {
  // With the apt step gone this flag is the entire safety net. Without it a
  // broken environment would skip the suite and report green -- the exact
  // failure the browser suite exists to prevent.
  assert.match(src, /HL_UI_TESTS_REQUIRED: '1'/,
    'the UI suite must treat a missing browser as a hard failure, not a skip');
});

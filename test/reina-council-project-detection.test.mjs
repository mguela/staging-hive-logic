// test/reina-council-project-detection.test.mjs
//
// Found during the 2026-08-18 Boardroom production incident review: PR #339's
// requestedProjectFromBrief() only matched a creation verb appearing BEFORE
// the word "project" ("create a project"). Passive or desire-based phrasing
// -- "I'd like a master project created for this", "I want a master project
// for this" -- matched nothing. The request still returned ok:true with
// project:null, and the UI did nothing with that: a genuine "reports success
// without executing the requested action" bug, reproducible from reading the
// code alone, with no test anywhere exercising these phrasings (the PR's own
// tests only cover the single "make 1 master project here" wording).
//
// These tests exercise the real detector directly against every phrasing
// named in the incident review, plus the false-positive risks widening the
// pattern could introduce (ordinary contractor talk like "the Riverside
// project" must never auto-create anything).

import assert from 'node:assert/strict';
import test from 'node:test';

import { requestedProjectFromBrief, mentionsProjectAmbiguously } from '../api/reina-council.js';

// ---------- explicit creation: must return a project name ----------

const EXPLICIT_CASES = [
  ['the original PR #339 phrasing (must keep working)', 'Collect all history from Grok, ChatGPT and Claude regarding HiveLogic App and make 1 master project here.'],
  ['plain active', 'Create a project for this.'],
  ['active with "master"', 'Set up a master project for this discussion.'],
  ['active, alternate verb: build', 'Build a project around this decision.'],
  ['active, alternate verb: spin up', 'Can you spin up a project for this?'],
  ['active, alternate verb: open', 'Open a master project for this.'],
  ['passive voice', 'I would like a master project created for this discussion.'],
  ['passive voice, different verb', 'A project should be started for this.'],
  ['desire, indefinite article', 'I want a master project for this.'],
  ['desire, "need"', 'I need a project for this decision.'],
  ['desire, "please"', 'Please, a master project for this would help.'],
];

for (const [label, brief] of EXPLICIT_CASES) {
  test(`explicit request detected: ${label}`, () => {
    const result = requestedProjectFromBrief(brief);
    assert.ok(result, `expected a project request from: "${brief}"`);
    assert.ok(result.name, 'a name must be produced');
  });
}

// ---------- must NOT auto-create (ambiguous or referring to an existing one) ----------

const NOT_EXPLICIT_CASES = [
  ['ordinary business use of "project" -- ordinary discussion', 'Should the HiveLogic project use this plan?'],
  ['definite article refers to an existing project', 'Add the notes to the master project.'],
  ['negated', 'Do not create a project for this.'],
  ['negated, alternate phrasing', 'Please answer this without setting up a project.'],
  ['no project language at all', 'Should tests run before we deploy?'],
];

for (const [label, brief] of NOT_EXPLICIT_CASES) {
  test(`does NOT auto-create: ${label}`, () => {
    assert.equal(requestedProjectFromBrief(brief), null, `must not detect a creation request in: "${brief}"`);
  });
}

// ---------- ambiguous-mention signal: narrow to "master project" specifically ----------

test('an unrecognized "master project" phrasing is flagged ambiguous, not silently ignored', () => {
  assert.equal(mentionsProjectAmbiguously('Add this to a master project.'), true);
});

test('a phrasing that DOES trigger explicit creation is never also flagged ambiguous', () => {
  assert.equal(mentionsProjectAmbiguously('Create a master project for this.'), false);
});

test('ordinary "project" talk with no "master" is never flagged ambiguous -- this is a contractor app', () => {
  // "the Riverside project", "this project's timeline", etc. are completely
  // ordinary sentences in this app and must never produce a "did you want a
  // Boardroom project?" nudge just because the word "project" appeared.
  assert.equal(mentionsProjectAmbiguously('How is the Riverside project going?'), false);
  assert.equal(mentionsProjectAmbiguously('Should the HiveLogic project use this plan?'), false);
  assert.equal(mentionsProjectAmbiguously('This project\'s timeline slipped two weeks.'), false);
});

test('no project language at all is never flagged ambiguous', () => {
  assert.equal(mentionsProjectAmbiguously('Should tests run before we deploy?'), false);
});

test('a negated master-project mention is never flagged ambiguous', () => {
  assert.equal(mentionsProjectAmbiguously('Do not create a master project for this, just answer.'), false);
});

// ---------- real-world autocorrect: curly/smart apostrophes ----------

test('a curly (smart-quote) apostrophe is recognized the same as a straight one', () => {
  // iOS/macOS/Word autocorrect straight apostrophes to curly ones by default
  // -- a detector meant to catch real typed phrasing has to tolerate both, or
  // it silently fails for a large share of real users on exactly the
  // "I’d like..." wording this fix targets.
  const curly = requestedProjectFromBrief('I’d like a master project for this discussion.');
  assert.ok(curly, 'a curly-apostrophe "I’d like a ... project" must still be detected as explicit');
  assert.equal(mentionsProjectAmbiguously('Don’t create a master project for this.'), false,
    'a curly-apostrophe negation must still suppress the ambiguous-mention flag');
});

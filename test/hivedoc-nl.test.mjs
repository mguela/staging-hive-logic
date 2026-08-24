// Tests for the natural-language layer over HiveDoc file search.
//
// The four questions in Chris's spec are the acceptance bar, so each one is a
// test by name. They run against BOTH parsers:
//
//   * the Claude path, with a stubbed Anthropic client, so we test the contract
//     (forced tool call in, validated filters out) without a network call;
//   * the deterministic fallback, unstubbed, because that is what actually runs
//     whenever ANTHROPIC_API_KEY is missing or the model call fails -- and a
//     fallback nobody tests is a fallback that does not work.
//
// The point of the whole module is that it produces FILTERS, not results. So
// these assert on filters only; whether those filters find the right rows is
// hivedoc-search.test.mjs's job.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFileQuestion, fallbackParse, hivedocNlModel, _internals } from '../api/_lib/hivedoc-nl.js';

// A stand-in for the Anthropic client that returns whatever filters the test
// wants, and records what it was asked. Mirrors the real SDK's response shape:
// content is a block list and the tool call arrives as a `tool_use` block.
function stubAnthropic(input, capture = {}) {
  return {
    messages: {
      create: async (params) => {
        Object.assign(capture, { params });
        return { content: [{ type: 'tool_use', name: 'file_search_filters', input }] };
      },
    },
  };
}

function failingAnthropic(message = 'model unavailable') {
  return { messages: { create: async () => { throw new Error(message); } } };
}

// ---------------------------------------------------------------------------
// The request we send to the model
// ---------------------------------------------------------------------------

test('the model is forced to answer as a tool call, not as prose', async () => {
  const capture = {};
  await parseFileQuestion('photos of the John Smith job', {
    anthropic: stubAnthropic({ client: 'John Smith', job: null, category: 'Photo', vendor: null, q: null, sort: 'newest' }, capture),
  });

  const { params } = capture;
  assert.equal(params.tool_choice.type, 'tool');
  assert.equal(params.tool_choice.name, 'file_search_filters');
  assert.equal(params.tools.length, 1, 'exactly one tool, so there is nothing else to choose');
  assert.equal(params.tools[0].strict, true, 'strict, so the returned object validates exactly');
  assert.equal(params.tools[0].input_schema.additionalProperties, false);
});

test('the default model is a current one, and is overridable by env', () => {
  assert.equal(hivedocNlModel(), 'claude-opus-5');
  process.env.HIVEDOC_NL_MODEL = 'claude-haiku-4-5';
  try {
    assert.equal(hivedocNlModel(), 'claude-haiku-4-5');
  } finally {
    delete process.env.HIVEDOC_NL_MODEL;
  }
});

test('every category the schema offers is one the search engine accepts', () => {
  const schemaCategories = _internals.parseTool().input_schema.properties.category.enum.filter(Boolean);
  // If these ever drift, the model can return a category that filters to zero
  // rows and looks like "no files" instead of a bug.
  assert.deepEqual(
    schemaCategories,
    ['Contract', 'Permit', 'Photo', 'Invoice', 'Receipt', 'Estimate', 'Payroll', 'Other'],
  );
});

test('a long question is truncated before it is sent, not rejected', async () => {
  const capture = {};
  await parseFileQuestion('x'.repeat(5000), {
    anthropic: stubAnthropic({ client: null, job: null, category: null, vendor: null, q: null, sort: 'newest' }, capture),
  });
  assert.equal(capture.params.messages[0].content.length, 500);
});

// ---------------------------------------------------------------------------
// The four questions from the spec — Claude path
// ---------------------------------------------------------------------------

test('"photos of John Smith job" -> client + Photo', async () => {
  const { filters, parsedBy } = await parseFileQuestion('photos of John Smith job', {
    anthropic: stubAnthropic({ client: 'John Smith', job: null, category: 'Photo', vendor: null, q: null, sort: 'newest' }),
  });
  assert.equal(parsedBy, 'claude');
  assert.equal(filters.client, 'John Smith');
  assert.equal(filters.category, 'Photo');
  assert.equal(filters.vendor, '');
});

test('"permit for the kitchen reno" -> job + Permit, and no invented client', async () => {
  const { filters } = await parseFileQuestion('permit for the kitchen reno', {
    anthropic: stubAnthropic({ client: null, job: 'kitchen reno', category: 'Permit', vendor: null, q: null, sort: 'newest' }),
  });
  assert.equal(filters.job, 'kitchen reno');
  assert.equal(filters.category, 'Permit');
  assert.equal(filters.client, '', 'no client was named, so none should be guessed');
});

test('"latest invoice from Joe the plumber on the John Smith job" -> vendor and client are not confused', async () => {
  const { filters } = await parseFileQuestion('latest invoice from Joe the plumber on the John Smith job', {
    anthropic: stubAnthropic({ client: 'John Smith', job: 'John Smith', category: 'Invoice', vendor: 'Joe the plumber', q: null, sort: 'newest' }),
  });
  assert.equal(filters.vendor, 'Joe the plumber');
  assert.equal(filters.client, 'John Smith');
  assert.equal(filters.category, 'Invoice');
  assert.equal(filters.sort, 'newest', '"latest" means newest first');
});

test('"signed contract for John Smith bathroom remodel" -> client + job + Contract', async () => {
  const { filters } = await parseFileQuestion('signed contract for John Smith bathroom remodel', {
    anthropic: stubAnthropic({ client: 'John Smith', job: 'bathroom remodel', category: 'Contract', vendor: null, q: null, sort: 'newest' }),
  });
  assert.equal(filters.client, 'John Smith');
  assert.equal(filters.job, 'bathroom remodel');
  assert.equal(filters.category, 'Contract');
});

// ---------------------------------------------------------------------------
// Cleaning what the model returns
// ---------------------------------------------------------------------------

test('a literal "null" or "none" string is treated as absent, not searched for', async () => {
  const { filters } = await parseFileQuestion('any files', {
    anthropic: stubAnthropic({ client: 'null', job: 'none', category: 'N/A', vendor: 'unknown', q: '', sort: 'newest' }),
  });
  assert.deepEqual(
    { client: filters.client, job: filters.job, category: filters.category, vendor: filters.vendor },
    { client: '', job: '', category: '', vendor: '' },
  );
});

test('a category outside the known set is dropped rather than passed through', async () => {
  const { filters } = await parseFileQuestion('blueprints for the job', {
    anthropic: stubAnthropic({ client: null, job: null, category: 'Blueprint', vendor: null, q: null, sort: 'newest' }),
  });
  assert.equal(filters.category, '', 'an unknown category must not become a filter that matches nothing');
});

test('lowercase and plural categories from the model still normalise', async () => {
  const { filters } = await parseFileQuestion('receipts', {
    anthropic: stubAnthropic({ client: null, job: null, category: 'receipts', vendor: null, q: null, sort: 'newest' }),
  });
  assert.equal(filters.category, 'Receipt');
});

test('an unrecognised sort value falls back to newest rather than breaking the sort', async () => {
  const { filters } = await parseFileQuestion('invoices', {
    anthropic: stubAnthropic({ client: null, job: null, category: 'Invoice', vendor: null, q: null, sort: 'sideways' }),
  });
  assert.equal(filters.sort, 'newest');
});

// ---------------------------------------------------------------------------
// Degrading instead of dying
// ---------------------------------------------------------------------------

test('a model failure degrades to the fallback reader instead of erroring the search', async () => {
  const { filters, parsedBy } = await parseFileQuestion('photos of the Kitchen Reno job', {
    anthropic: failingAnthropic(),
  });
  assert.equal(parsedBy, 'fallback', 'and it says so, because a fallback parse is worse');
  assert.equal(filters.category, 'Photo');
});

test('an empty tool call is a failure, not an empty filter set', async () => {
  const { parsedBy } = await parseFileQuestion('photos', {
    anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: 'sure!' }] }) } },
  });
  assert.equal(parsedBy, 'fallback', 'prose instead of a tool call must not be read as "no filters"');
});

// ---------------------------------------------------------------------------
// The fallback reader on its own
// ---------------------------------------------------------------------------

test('fallback: category words map to categories', () => {
  assert.equal(fallbackParse('show me the pictures').category, 'Photo');
  assert.equal(fallbackParse('pull the bill').category, 'Invoice');
  assert.equal(fallbackParse('the signed agreement').category, 'Contract');
  assert.equal(fallbackParse('permits please').category, 'Permit');
});

test('fallback: "latest" is newest, "oldest" flips the sort', () => {
  assert.equal(fallbackParse('latest invoice').sort, 'newest');
  assert.equal(fallbackParse('the oldest photo').sort, 'oldest');
  assert.equal(fallbackParse('first estimate we sent').sort, 'oldest');
});

test('fallback: a vendor clause does not leak into the client field', () => {
  const f = fallbackParse('latest invoice from Joe the plumber on the John Smith job');
  assert.equal(f.category, 'Invoice');
  assert.match(f.vendor, /Joe/, 'the vendor is the "from" clause');
  assert.doesNotMatch(f.client || '', /plumber/, 'the vendor must never become the client');
});

test('fallback: "photos of John Smith job" finds the client', () => {
  const f = fallbackParse('photos of John Smith job');
  assert.equal(f.category, 'Photo');
  assert.equal(f.client, 'John Smith');
});

test('fallback: an empty question yields empty filters rather than throwing', () => {
  assert.deepEqual(fallbackParse(''), { client: '', job: '', category: '', vendor: '', q: '', sort: 'newest' });
  assert.deepEqual(fallbackParse(null), { client: '', job: '', category: '', vendor: '', q: '', sort: 'newest' });
});

test('fallback: a question with no category at all leaves category empty', () => {
  // "everything for John Smith" is a real question, and it must not be
  // narrowed to one category by accident.
  assert.equal(fallbackParse('everything we have for John Smith').category, '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listPortalFiles, subJobIds } from '../api/_lib/hivedoc-portal-files.js';

// The client and sub portals' route to HiveDoc files.
//
// This is the first path by which a HiveDoc document can leave the company --
// before it, neither portal could see `documents` at all. So these tests are
// written from the leak direction: nearly every assertion is about what does
// NOT come back.
//
// The helper is driven with a stub `sb` that records the query it was given and
// returns rows verbatim, which lets us check two separate things: that the query
// is correctly scoped, AND that canSee() still refuses a bad row even when the
// query hands one over. The second is the point -- the SQL is an optimisation,
// canSee() is the rule.

const docRow = (over = {}) => ({
  id: 'd1', filename: 'permit.pdf', storage_path: 'x/permit.pdf', doc_type: 'permit',
  client_id: 'C1', client_name: 'John Smith', job_id: 'JOB1', job_title: 'Bathroom Remodel',
  uploaded_at: '2026-07-14T09:00:00Z', document_date: '2026-07-14T09:00:00Z',
  client_visible: false, sub_visible: false, sensitive: false, ...over,
});

/** `rows` is what the database "returns", regardless of what was asked for. */
function stub(rows, { signFails = false } = {}) {
  const queries = [];
  return {
    queries,
    sb: async (q) => { queries.push(q); return rows; },
    sign: async (bucket, path) => (signFails ? null : `https://signed.example/${bucket}/${path}`),
  };
}

const clientViewer = (clientId) => ({ audience: 'client', clientId });
const subViewer = (...jobIds) => ({ audience: 'subcontractor', jobIds });

// ---------- scoping of the query itself ----------

test('the client query is scoped to that client and to shared rows only', async () => {
  const s = stub([]);
  await listPortalFiles({ viewer: clientViewer('C1'), sb: s.sb, sign: s.sign });
  const q = s.queries[0];
  assert.match(q, /client_id=eq\.C1/, 'scoped to this client');
  assert.match(q, /client_visible=is\.true/, 'and to rows somebody deliberately shared');
});

test('the sub query is scoped to their assigned jobs and to shared rows only', async () => {
  const s = stub([]);
  await listPortalFiles({ viewer: subViewer('JOB1', 'JOB2'), sb: s.sb, sign: s.sign });
  const q = s.queries[0];
  assert.match(q, /job_id=in\./);
  assert.match(q, /JOB1/);
  assert.match(q, /JOB2/);
  assert.match(q, /sub_visible=is\.true/);
});

test('a client with no id queries nothing at all rather than everything', async () => {
  // The leak this guards: an unscoped query here hands one client the whole
  // company's shared files.
  const s = stub([docRow({ client_visible: true })]);
  const out = await listPortalFiles({ viewer: clientViewer(null), sb: s.sb, sign: s.sign });
  assert.deepEqual(out, []);
  assert.equal(s.queries.length, 0, 'the database is never even asked');
});

test('a sub with no assignments queries nothing at all', async () => {
  const s = stub([docRow({ sub_visible: true })]);
  const out = await listPortalFiles({ viewer: subViewer(), sb: s.sb, sign: s.sign });
  assert.deepEqual(out, []);
  assert.equal(s.queries.length, 0);
});

// ---------- canSee() is the authority, not the query ----------

test('a row the query should not have returned is still refused', async () => {
  // The whole point of the second check. If the SQL is ever loosened, or a
  // default changes, or a row arrives some way nobody anticipated, this holds.
  const s = stub([docRow({ client_visible: false })]);
  const out = await listPortalFiles({ viewer: clientViewer('C1'), sb: s.sb, sign: s.sign });
  assert.deepEqual(out, [], 'an unshared row is refused even when handed over');
});

test('another client\'s row is refused even if the query returns it', async () => {
  const s = stub([docRow({ client_visible: true, client_id: 'C2', client_name: 'Someone Else' })]);
  const out = await listPortalFiles({ viewer: clientViewer('C1'), sb: s.sb, sign: s.sign });
  assert.deepEqual(out, [], 'cross-client leakage is blocked at the row check too');
});

test('a job the sub is not on is refused even if the query returns it', async () => {
  const s = stub([docRow({ sub_visible: true, job_id: 'JOB9' })]);
  const out = await listPortalFiles({ viewer: subViewer('JOB1'), sb: s.sb, sign: s.sign });
  assert.deepEqual(out, []);
});

test('a sensitive document never reaches a portal, however it is flagged', async () => {
  const s = stub([docRow({ client_visible: true, sensitive: true })]);
  const out = await listPortalFiles({ viewer: clientViewer('C1'), sb: s.sb, sign: s.sign });
  assert.deepEqual(out, [], 'sensitive beats a sharing flag');
});

test('a client-shared file does not reach a sub, and vice versa', async () => {
  const clientOnly = stub([docRow({ client_visible: true })]);
  assert.deepEqual(await listPortalFiles({ viewer: subViewer('JOB1'), sb: clientOnly.sb, sign: clientOnly.sign }), []);

  const subOnly = stub([docRow({ sub_visible: true })]);
  assert.deepEqual(await listPortalFiles({ viewer: clientViewer('C1'), sb: subOnly.sb, sign: subOnly.sign }), []);
});

test('staff and unrecognised audiences get nothing from this path', async () => {
  // This helper is the OUTSIDE route. Staff read files through /api/hivedoc.
  for (const viewer of [{ audience: 'staff', role: 'admin' }, { audience: 'nonsense' }, {}, null]) {
    const s = stub([docRow({ client_visible: true })]);
    assert.deepEqual(await listPortalFiles({ viewer, sb: s.sb, sign: s.sign }), []);
    assert.equal(s.queries.length, 0);
  }
});

// ---------- what a permitted file looks like ----------

test('a properly shared file comes back, with a signed url', async () => {
  const s = stub([docRow({ client_visible: true })]);
  const out = await listPortalFiles({ viewer: clientViewer('C1'), sb: s.sb, sign: s.sign });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://signed.example/docs/x/permit.pdf', 'signed from the docs bucket');
  assert.equal(out[0].category, 'Permit');
  assert.equal(out[0].job_title, 'Bathroom Remodel', 'enough context to tell two files apart');
});

test('the storage path and the sharing flags never leave the company', async () => {
  const s = stub([docRow({ client_visible: true })]);
  const [file] = await listPortalFiles({ viewer: clientViewer('C1'), sb: s.sb, sign: s.sign });
  for (const leaky of ['storage_path', 'storage_bucket', 'client_visible', 'sub_visible', 'sensitive', 'source_system']) {
    assert.ok(!(leaky in file), `${leaky} must not be sent to a portal`);
  }
});

test('a file whose bytes cannot be signed is dropped, not served as a dead link', async () => {
  const s = stub([docRow({ client_visible: true })], { signFails: true });
  assert.deepEqual(await listPortalFiles({ viewer: clientViewer('C1'), sb: s.sb, sign: s.sign }), []);
});

// ---------- the sub's job scope ----------

test('a sub\'s job scope is the union of their RFQs and schedule items, deduped', async () => {
  const calls = [];
  const sb = async (q) => {
    calls.push(q);
    if (q.startsWith('sub_rfqs')) return [{ job_ref: 'JOB1' }, { job_ref: 'JOB2' }, { job_ref: null }];
    return [{ job_ref: 'JOB2' }, { job_ref: 'JOB3' }];
  };
  const ids = await subJobIds({ id: 'S1' }, sb);
  assert.deepEqual(ids.sort(), ['JOB1', 'JOB2', 'JOB3']);
  assert.ok(calls.every((q) => q.includes('sub_id=eq.S1')), 'both lookups are scoped to this sub');
});

test('a sub with no id has no job scope, rather than an unscoped one', async () => {
  let called = false;
  const sb = async () => { called = true; return [{ job_ref: 'JOB1' }]; };
  assert.deepEqual(await subJobIds(null, sb), []);
  assert.deepEqual(await subJobIds({}, sb), []);
  assert.equal(called, false, 'no query is issued without a sub id');
});

// ---------- the portals actually use it ----------

test('neither portal queries the documents table directly', async () => {
  // One decision function is only one if nobody routes around it.
  for (const file of ['../api/clientportal.js', '../api/subportal.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(src.includes('listPortalFiles'), `${file} must go through the shared helper`);
    assert.doesNotMatch(
      src, /sb\(`documents\?/,
      `${file} must not query the documents table on its own`
    );
  }
});

test('both portals derive identity from the session, never from a query parameter', async () => {
  const client = readFileSync(new URL('../api/clientportal.js', import.meta.url), 'utf8');
  assert.match(client, /audience: 'client', clientId: clientRef/, 'the client id is the session\'s, not the caller\'s');

  const sub = readFileSync(new URL('../api/subportal.js', import.meta.url), 'utf8');
  assert.match(sub, /const jobIds = await subJobIds\(sub, sb\)/, 'the job list is derived, not accepted');
  assert.doesNotMatch(sub, /jobIds: *(req\.query|body)/, 'a caller-supplied job list would be everyone\'s files');
});

// ---------- hardening of the in.() list ----------

test('a job ref that could break out of the in.() list is dropped, not escaped', async () => {
  // These come from our own tables rather than from the sub, so this is defence
  // in depth -- but a stray comma or paren interpolated into a PostgREST in()
  // list ends the list early and silently widens the query, which is the exact
  // shape of a leak. Allowlisted to what a Jobber GID can actually contain.
  const s = stub([]);
  await listPortalFiles({ viewer: subViewer('JOB1', 'JOB2,JOB9', 'x")--', 'JOB3'), sb: s.sb, sign: s.sign });
  const q = s.queries[0];
  assert.match(q, /JOB1/);
  assert.match(q, /JOB3/);
  assert.doesNotMatch(q, /JOB9/, 'the comma-bearing ref is dropped entirely');
  assert.doesNotMatch(q, /--/, 'and so is the quote-bearing one');
});

test('a sub whose every job ref is malformed queries nothing rather than everything', async () => {
  const s = stub([docRow({ sub_visible: true })]);
  const out = await listPortalFiles({ viewer: subViewer('a,b', ')'), sb: s.sb, sign: s.sign });
  assert.deepEqual(out, []);
  assert.equal(s.queries.length, 0, 'an empty allowlist must not become an unscoped query');
});

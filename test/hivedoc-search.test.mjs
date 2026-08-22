import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, normalizeCategory, mediaSource, defaultTitle,
  normalizeDocumentRow, normalizeMediaRow,
  tokenize, fuzzyMatch, matchScore,
  parseFilters, mediaCouldMatch, documentsCouldMatch,
  rowMatches, sortRows, applySearch, groupIntoTree,
} from '../api/_lib/hivedoc-search.js';

// The engine behind Global Search, Reina's file questions, and HiveDoc's browse
// tree. It reads two stores that disagree about almost everything -- `documents`
// knows its client, `media` (40,939 rows) only knows its job -- and has to make
// them answer one question.
//
// The four questions in Chris's spec are the acceptance cases at the bottom:
//   "photos of John Smith job"
//   "permit for the kitchen reno"
//   "latest invoice from Joe the plumber on the John Smith job"
//   "signed contract for John Smith bathroom remodel"

// ---------- category ----------

test('doc_type values map onto the spec categories', () => {
  assert.equal(normalizeCategory('contract'), 'Contract');
  assert.equal(normalizeCategory('permit'), 'Permit');
  assert.equal(normalizeCategory('INVOICE'), 'Invoice');
  assert.equal(normalizeCategory('Receipts'), 'Receipt', 'a plural from a UI dropdown still resolves');
});

test('an unrecognised category is null, not silently Other', () => {
  // The distinction matters: a search for a category we do not have must be able
  // to say so, rather than quietly returning everything filed as Other.
  assert.equal(normalizeCategory('blueprints'), null);
  assert.equal(normalizeCategory(''), null);
  assert.equal(normalizeCategory(null), null);
});

test('every mapped category is one the spec named', () => {
  for (const c of ['Contract', 'Permit', 'Photo', 'Invoice', 'Receipt', 'Other']) {
    assert.ok(CATEGORIES.includes(c), `${c} must be a known category`);
  }
});

// ---------- media source ----------

test('a media row reports which tool actually produced it', () => {
  // These are the real write paths in this repo. Production is ~100% CompanyCam.
  assert.equal(mediaSource('Z2lkOi8vSm9iYmVy/companycam-8f3a.jpg'), 'CompanyCam');
  assert.equal(mediaSource('Z2lkOi8vSm9iYmVy/field-1755780000.jpg'), 'Field App');
  assert.equal(mediaSource('Z2lkOi8vSm9iYmVy/signature-1755780000.png'), 'Signature');
  assert.equal(mediaSource('takeoffs/quote-1/sheet-0-123.png'), 'Takeoff');
});

test('an unrecognised media path falls back to HiveSight, the tool that owns bare uploads', () => {
  assert.equal(mediaSource('Z2lkOi8vSm9iYmVy/whatever.jpg'), 'HiveSight');
  assert.equal(mediaSource(''), 'HiveSight');
});

// ---------- titles ----------

test('a title reads like something a person typed, not a storage key', () => {
  assert.equal(
    defaultTitle({ jobTitle: 'Kitchen Reno', category: 'Permit', date: '2026-07-14T10:00:00Z' }),
    'Kitchen Reno — Permit — 2026-07-14'
  );
});

test('with nothing to build from, the filename is used rather than a bare dash', () => {
  assert.equal(defaultTitle({ filename: 'companycam-8f3a.jpg' }), 'companycam-8f3a.jpg');
  assert.equal(defaultTitle({}), 'Untitled');
});

// ---------- row projection ----------

const jobIndex = {
  JOB1: { client_id: 'C1', client_name: 'John Smith', job_title: 'Bathroom Remodel' },
  JOB2: { client_id: 'C1', client_name: 'John Smith', job_title: 'Kitchen Renovation' },
  JOB3: { client_id: 'C2', client_name: 'Acme Property', job_title: 'Roof Repair' },
};

const mediaRow = (over = {}) => normalizeMediaRow({
  id: 'm1', job_id: 'JOB1', storage_path: 'JOB1/companycam-1.jpg',
  mime_type: 'image/jpeg', size_bytes: 2048,
  captured_at: '2026-07-20T12:00:00Z', created_at: '2026-07-21T12:00:00Z', ...over,
}, jobIndex);

const docRow = (over = {}) => normalizeDocumentRow({
  id: 'd1', filename: 'permit-kitchen.pdf', storage_path: 'x/permit.pdf',
  doc_type: 'permit', client_id: 'C1', client_name: 'John Smith',
  job_id: 'JOB2', job_title: 'Kitchen Renovation',
  uploaded_at: '2026-07-14T09:00:00Z', mime_type: 'application/pdf', size_bytes: 100, ...over,
});

test('a media row gets its client from the job index -- the join that makes media searchable', () => {
  const r = mediaRow();
  assert.equal(r.client_id, 'C1');
  assert.equal(r.client_name, 'John Smith');
  assert.equal(r.job_title, 'Bathroom Remodel');
  assert.equal(r.category, 'Photo');
  assert.equal(r.source, 'CompanyCam');
  assert.equal(r.source_system, 'media', 'a result must say which store it came from');
});

test('a media row whose job is unknown still returns, with an honest null client', () => {
  // Better a photo with no client than a photo silently dropped from results.
  const r = normalizeMediaRow({ id: 'm9', job_id: 'GHOST', storage_path: 'GHOST/companycam-1.jpg' }, jobIndex);
  assert.equal(r.client_id, null);
  assert.equal(r.client_name, null);
  assert.equal(r.id, 'm9');
});

test('both stores project into the same shape, so one list can mix them', () => {
  const keys = (o) => Object.keys(o).sort().join(',');
  assert.equal(keys(mediaRow()), keys(docRow()), 'documents and media rows must be interchangeable');
});

test('every row carries a link to open it, never a raw bucket path', () => {
  assert.match(mediaRow().open_url, /resource=file&system=media&id=m1/);
  assert.match(docRow().open_url, /resource=file&system=documents&id=d1/);
});

test('media is never marked sensitive, and a sensitive document keeps its flag', () => {
  assert.equal(mediaRow().sensitive, false);
  assert.equal(docRow({ sensitive: true }).sensitive, true);
});

// ---------- fuzzy matching ----------

test('"kitchen reno" finds "Kitchen Renovation" -- the case exact matching fails', () => {
  assert.ok(fuzzyMatch('Kitchen Renovation', 'kitchen reno'));
  assert.ok(fuzzyMatch('Kitchen Reno Phase 2', 'kitchen reno'));
});

test('fuzzy matching does not match things that merely look similar', () => {
  assert.equal(fuzzyMatch('Chicken Coop', 'kitchen reno'), false);
  assert.equal(fuzzyMatch('Bathroom Remodel', 'kitchen'), false);
});

test('word order does not matter, so "smith john" still finds "John Smith"', () => {
  assert.ok(fuzzyMatch('John Smith', 'smith john'));
  assert.ok(fuzzyMatch('Smith, John', 'john smith'), 'a "Last, First" client name still matches');
});

test('an empty needle matches everything, an empty haystack matches nothing', () => {
  assert.ok(fuzzyMatch('anything', ''));
  assert.equal(fuzzyMatch('', 'something'), false);
});

test('tokenizing ignores punctuation, which is where client names hide', () => {
  assert.deepEqual(tokenize('Smith, John — Unit #3'), ['smith', 'john', 'unit', '3']);
});

test('the better job match scores higher, so the right job wins when two could match', () => {
  // "Kitchen Reno" should beat a longer title that merely contains the words.
  const tight = matchScore('Kitchen Reno', 'kitchen reno');
  const loose = matchScore('Kitchen Reno Phase 2 Punch List Items', 'kitchen reno');
  assert.ok(tight > loose, `expected the tighter title to win (${tight} vs ${loose})`);
});

// ---------- filters ----------

test('filters parse with sane defaults', () => {
  const f = parseFilters({});
  assert.equal(f.limit, 50);
  assert.equal(f.offset, 0);
  assert.equal(f.sort, 'newest', 'newest-first is the default, per "latest invoice"');
});

test('an absurd limit is capped rather than honoured', () => {
  assert.equal(parseFilters({ limit: '99999' }).limit, 200);
  assert.equal(parseFilters({ limit: '-5' }).limit, 50);
  assert.equal(parseFilters({ limit: 'abc' }).limit, 50);
});

test('a category we do not have is reported, not swallowed', () => {
  const f = parseFilters({ category: 'blueprints' });
  assert.equal(f.category, null);
  assert.equal(f.unknownCategory, 'blueprints');
  assert.equal(documentsCouldMatch(f), false, 'and nothing is searched for it');
});

test('media is skipped entirely for searches it cannot possibly answer', () => {
  // 40,939 rows not scanned, because every one of them is a Photo with no vendor.
  assert.equal(mediaCouldMatch(parseFilters({ category: 'invoice' })), false);
  assert.equal(mediaCouldMatch(parseFilters({ vendor: 'Joe the Plumber' })), false);
  assert.equal(mediaCouldMatch(parseFilters({ category: 'photo' })), true);
  assert.equal(mediaCouldMatch(parseFilters({})), true);
});

// ---------- date windows ----------

const dated = (d) => mediaRow({ id: 'm-' + d, captured_at: d });

test('a date window includes the whole of its end day', () => {
  const f = parseFilters({ from: '2026-07-20', to: '2026-07-20' });
  assert.ok(rowMatches(dated('2026-07-20T23:30:00Z'), f), 'late on the end day is still inside the window');
  assert.equal(rowMatches(dated('2026-07-21T00:30:00Z'), f), false);
});

test('a row with no date is excluded only when a date filter was actually asked for', () => {
  const undatedRow = normalizeMediaRow({ id: 'm0', job_id: 'JOB1', storage_path: 'JOB1/companycam-1.jpg' }, jobIndex);
  assert.ok(rowMatches(undatedRow, parseFilters({})));
  assert.equal(rowMatches(undatedRow, parseFilters({ from: '2026-01-01' })), false);
});

// ---------- sorting and paging ----------

test('newest first by default; oldest first on request', () => {
  const rows = [dated('2026-07-01T00:00:00Z'), dated('2026-08-01T00:00:00Z'), dated('2026-06-01T00:00:00Z')];
  const newest = sortRows(rows, parseFilters({}));
  assert.equal(newest[0].document_date, '2026-08-01T00:00:00Z');
  const oldest = sortRows(rows, parseFilters({ sort: 'oldest' }));
  assert.equal(oldest[0].document_date, '2026-06-01T00:00:00Z');
});

test('total counts every match, not just the page returned', () => {
  const rows = Array.from({ length: 30 }, (_, i) => dated(`2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  const out = applySearch(rows, parseFilters({ limit: '10' }));
  assert.equal(out.total, 30, 'a paged result that misreports the total is worse than no total');
  assert.equal(out.results.length, 10);
});

test('paging does not repeat or skip a row', () => {
  const rows = Array.from({ length: 25 }, (_, i) => dated(`2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  const p1 = applySearch(rows, parseFilters({ limit: '10', offset: '0' })).results.map((r) => r.id);
  const p2 = applySearch(rows, parseFilters({ limit: '10', offset: '10' })).results.map((r) => r.id);
  const p3 = applySearch(rows, parseFilters({ limit: '10', offset: '20' })).results.map((r) => r.id);
  const all = [...p1, ...p2, ...p3];
  assert.equal(new Set(all).size, 25, 'every row appears exactly once across the pages');
});

// ---------- the browse tree ----------

test('the tree groups client -> job -> category from the same rows search returns', () => {
  const tree = groupIntoTree([
    mediaRow({ id: 'a', job_id: 'JOB1' }),
    mediaRow({ id: 'b', job_id: 'JOB1' }),
    docRow(),
    mediaRow({ id: 'c', job_id: 'JOB3' }),
  ]);
  const smith = tree.find((c) => c.client_name === 'John Smith');
  assert.equal(smith.count, 3);
  const bathroom = smith.jobs.find((j) => j.job_title === 'Bathroom Remodel');
  assert.deepEqual(bathroom.categories, [{ category: 'Photo', count: 2 }]);
  const kitchen = smith.jobs.find((j) => j.job_title === 'Kitchen Renovation');
  assert.deepEqual(kitchen.categories, [{ category: 'Permit', count: 1 }]);
});

test('files with no client are grouped as Unassigned rather than dropped', () => {
  const tree = groupIntoTree([normalizeMediaRow({ id: 'm9', job_id: 'GHOST', storage_path: 'x/companycam-1.jpg' }, {})]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].client_name, 'Unassigned');
});

// ---------- Chris's four questions ----------

const corpus = [
  mediaRow({ id: 'p1', job_id: 'JOB1', captured_at: '2026-07-20T12:00:00Z' }),
  mediaRow({ id: 'p2', job_id: 'JOB2', captured_at: '2026-07-22T12:00:00Z' }),
  mediaRow({ id: 'p3', job_id: 'JOB3', captured_at: '2026-07-25T12:00:00Z' }),
  docRow({ id: 'permit1', doc_type: 'permit', job_id: 'JOB2', job_title: 'Kitchen Renovation' }),
  docRow({
    id: 'inv-old', doc_type: 'invoice', filename: 'joe-the-plumber-invoice-june.pdf',
    job_id: 'JOB1', job_title: 'Bathroom Remodel', uploaded_at: '2026-06-01T00:00:00Z',
  }),
  docRow({
    id: 'inv-new', doc_type: 'invoice', filename: 'joe-the-plumber-invoice-july.pdf',
    job_id: 'JOB1', job_title: 'Bathroom Remodel', uploaded_at: '2026-07-30T00:00:00Z',
  }),
  docRow({
    id: 'contract1', doc_type: 'contract', filename: 'signed-contract.pdf',
    job_id: 'JOB1', job_title: 'Bathroom Remodel',
  }),
];

test('"photos of John Smith job" -> that client\'s photos, and nobody else\'s', () => {
  const out = applySearch(corpus, parseFilters({ client: 'John Smith', category: 'photo' }));
  assert.deepEqual(out.results.map((r) => r.id).sort(), ['p1', 'p2']);
  assert.ok(out.results.every((r) => r.client_name === 'John Smith'));
});

test('"permit for the kitchen reno" -> the permit, matched on a partial job name', () => {
  const out = applySearch(corpus, parseFilters({ job: 'kitchen reno', category: 'permit' }));
  assert.equal(out.total, 1);
  assert.equal(out.results[0].id, 'permit1');
  assert.equal(out.results[0].job_title, 'Kitchen Renovation', 'fuzzy job matching did the work');
});

test('"latest invoice from Joe the plumber on the John Smith job" -> newest first, both offered', () => {
  const out = applySearch(corpus, parseFilters({
    client: 'John Smith', job: 'bathroom', vendor: 'Joe the Plumber', category: 'invoice',
  }));
  assert.equal(out.total, 2, 'two matches: show both, newest first, rather than guessing');
  assert.equal(out.results[0].id, 'inv-new', 'the latest one leads');
});

test('"signed contract for John Smith bathroom remodel" -> the contract', () => {
  const out = applySearch(corpus, parseFilters({
    client: 'John Smith', job: 'bathroom remodel', category: 'contract',
  }));
  assert.equal(out.total, 1);
  assert.equal(out.results[0].id, 'contract1');
});

test('a result always carries the context needed to tell two files apart', () => {
  // The spec: "never just a bare list of filenames with no context."
  const [r] = applySearch(corpus, parseFilters({ category: 'contract' })).results;
  for (const field of ['title', 'category', 'client_name', 'job_title', 'document_date', 'open_url']) {
    assert.ok(r[field], `a result must carry ${field}`);
  }
});

test('a search for a client with no files is empty rather than falling back to everything', () => {
  const out = applySearch(corpus, parseFilters({ client: 'Nobody At All' }));
  assert.equal(out.total, 0);
});

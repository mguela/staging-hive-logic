import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'api', 'track1.js');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

// Same brace-matching extractor the marketing-cc-bundle-endpoint suite uses:
// pull the real, unmodified handleFiDailyBrief source and run it in a sandbox
// where every external dependency is a controllable stub. No mocked results --
// the real function body runs; we only control the I/O it reaches for.
function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  const closeParenBrace = src.indexOf(') {', declStart);
  const braceStart = closeParenBrace + 2;
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

const HANDLE_SRC = extractFunction(source, 'async function handleFiDailyBrief(res) {');

test('regression guard: the real handler still gathers its blocks via a single Promise.all (not sequentially)', () => {
  // The whole point of the perf fix: the six independent blocks are launched
  // together. Guard that the concurrent-gather shape is present in real source.
  assert.ok(/await Promise\.all\(\[\s*\(async \(\) => \{/.test(HANDLE_SRC),
    'handleFiDailyBrief must launch its data-gathering blocks concurrently inside Promise.all');
});

function makeRes() {
  const calls = [];
  return {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(body) { calls.push({ status: this._status, body }); return this; },
    _calls: calls,
  };
}

// Build a sandbox with stubbed dependencies. `opts.gate` (a promise) lets a
// test hold every first-touch I/O call open to observe concurrency; `opts.fail`
// names a block whose I/O should throw, to prove per-block isolation survived
// the refactor.
function makeSandbox(opts = {}) {
  const started = new Set();
  const gate = opts.gate || Promise.resolve();
  const mark = (block) => { started.add(block); };

  async function fiFetchAllRows(table, query) {
    // Attribute each first-touch scan to the block that issued it.
    if (table === 'jobs' && /requires_invoicing/.test(query)) mark('leaks');
    else if (table === 'invoices') mark('leaks');
    else if (table === 'jobs' && /job_status=in\.\(active/.test(query)) mark('stalls');
    else if (table === 'visits') mark('schedule');
    else if (table === 'quotes') mark('quotes');
    // 'media' is the stalls block's SECOND (post-gate) call -- not a start.
    if (table !== 'media') await gate;
    if (opts.fail === 'leaks' && table === 'jobs' && /requires_invoicing/.test(query)) throw new Error('supabase jobs scan failed');
    return [];
  }
  async function qboConnected() { mark('cash'); await gate; return true; }
  async function getFinancials(kind) {
    // Ungated -- runs only after qboConnected resolves (post-gate). Benign
    // no-data responses so cash stays minimal and no runway is computed.
    if (kind === 'accounts') return { accounts: [] };
    if (kind === 'bills_due_range') return { bills: [] };
    if (kind === 'profit_and_loss') return { rows: [], period: 'YTD' };
    return {};
  }
  async function getWeatherBedford() { mark('weather'); await gate; if (opts.fail === 'weather') throw new Error('weather api down'); return {}; }

  const sandbox = {
    fiBriefCacheRead: async () => (opts.cached || null),
    fiBriefCacheWrite: async () => {},
    qboConnected,
    getFinancials,
    fiFetchAllRows,
    getWeatherBedford,
    wxSummarize: () => null,
    fiTodayISO: () => '2026-08-04',
    fiAddDaysISO: (n) => '2026-08-' + String(4 + (n || 0)).padStart(2, '0'),
    fiRound2: (n) => Math.round(n * 100) / 100,
    fiNum: (n) => Number(n) || 0,
    fiDaysAgo: () => 0,
    Promise, Set, Math, Date, Number, console,
    __started: started,
  };
  vm.createContext(sandbox);
  vm.runInContext(HANDLE_SRC + '\nthis.handleFiDailyBrief = handleFiDailyBrief;', sandbox, { filename: SRC_PATH });
  return sandbox;
}

test('all six independent data-gathering blocks start concurrently -- none waits for another (the actual fix)', async () => {
  let releaseAll;
  const gate = new Promise((r) => { releaseAll = r; });
  const sandbox = makeSandbox({ gate });
  const res = makeRes();
  const p = sandbox.handleFiDailyBrief(res);

  // Let every block reach its first awaited I/O call, then look before releasing.
  await new Promise((r) => setTimeout(r, 25));
  assert.deepStrictEqual(
    [...sandbox.__started].sort(),
    ['cash', 'leaks', 'quotes', 'schedule', 'stalls', 'weather'],
    'all six blocks must be in-flight before any I/O resolves -- if they ran sequentially only "cash" would have started'
  );

  releaseAll();
  await p;
  assert.strictEqual(res._calls.length, 1);
  assert.strictEqual(res._calls[0].status, 200);
  assert.strictEqual(res._calls[0].body.ok, true);
});

test('the concurrent brief still assembles the same payload shape (ok + decisions + all source keys)', async () => {
  const sandbox = makeSandbox();
  const res = makeRes();
  await sandbox.handleFiDailyBrief(res);
  const body = res._calls[0].body;
  assert.strictEqual(body.ok, true);
  assert.ok(Array.isArray(body.decisions), 'decisions must be an array');
  for (const k of ['cash', 'cashRunway', 'pastDueInvoices', 'completedNotInvoiced', 'todaysVisits', 'openQuotes', 'stalledJobs', 'notConnected', 'headline', 'asOf']) {
    assert.ok(k in body, 'payload must still carry key: ' + k);
  }
});

test('one block failing degrades to its notConnected note without taking the other five down', async () => {
  const sandbox = makeSandbox({ fail: 'leaks' });
  const res = makeRes();
  await sandbox.handleFiDailyBrief(res);
  const body = res._calls[0].body;
  assert.strictEqual(body.ok, true, 'the brief must still return ok even when one source failed');
  assert.match(body.notConnected.jobberLeaks, /supabase jobs scan failed/, 'the failed block must record its honest notConnected note');
  assert.strictEqual(body.completedNotInvoiced, null, 'the failed block leaves its data null, never faked');
  // Other blocks completed normally. (Assert on primitives -- the payload
  // objects are created inside the vm realm, so deepStrictEqual would trip on
  // the cross-realm Object.prototype mismatch, not on the values.)
  assert.ok(body.todaysVisits && body.todaysVisits.count === 0, 'the schedule block must be unaffected by the leaks failure');
  assert.ok(body.openQuotes && typeof body.openQuotes.count === 'number', 'the quotes block must be unaffected');
});

test('a warm cache still short-circuits before any data gathering (cache path preserved)', async () => {
  const cached = { payload: { ok: true, headline: 'cached', decisions: [] }, ageSeconds: 42 };
  const sandbox = makeSandbox({ cached });
  const res = makeRes();
  await sandbox.handleFiDailyBrief(res);
  const body = res._calls[0].body;
  assert.strictEqual(body.headline, 'cached');
  assert.strictEqual(body.cached, true);
  assert.strictEqual(body.cacheAgeSeconds, 42);
  assert.strictEqual(sandbox.__started.size, 0, 'a cache hit must gather nothing -- no block should have started');
});

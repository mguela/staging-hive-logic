import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Search from '../public/reina-global-search.js';

const validItem = {
  kind: 'CLIENT', id: 'c1', title: 'Maria Allwin', subtitle: 'Client', status: 'active', amount: null,
  updatedAt: '2026-08-07T12:00:00Z', navigation: { view: 'clients', recordType: 'client', recordId: 'c1' },
};

test('strict envelope validation accepts only allowlisted typed navigation', () => {
  assert.ok(Search.validateEnvelope(200, { ok: true, query: 'Maria', results: [validItem], unavailable: [] }));
  assert.equal(Search.validateEnvelope(200, { ok: true, query: 'Maria', results: [{ ...validItem, navigation: { ...validItem.navigation, view: 'settings' } }], unavailable: [] }), null);
  assert.equal(Search.validateEnvelope(200, { ok: true, query: 'Maria', results: [{ ...validItem, title: '<img onerror=alert(1)>' }], unavailable: [] })?.results[0].title, '<img onerror=alert(1)>');
  assert.equal(Search.validateEnvelope(500, { ok: true, query: 'Maria', results: [validItem], unavailable: [] }), null);
});

test('controller performs a no-store search and fails closed on malformed data', async () => {
  const states = [];
  const calls = [];
  const controller = Search.create({
    debounceMs: 0,
    onState: (state) => states.push(state),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ ok: true, query: 'Maria', results: [{}], unavailable: [] }) };
    },
  });
  const final = await controller.search('Maria');
  assert.equal(final.phase, 'error');
  assert.equal(final.results.length, 0);
  assert.equal(calls[0].url, '/api/reina-search?q=Maria');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(states[0].phase, 'loading');
});

test('explicit disabled response preserves page navigation without exposing fake records', async () => {
  const states = [];
  const controller = Search.create({
    debounceMs: 0,
    onState: (state) => states.push(state),
    fetchImpl: async () => ({
      status: 503,
      json: async () => ({ ok: false, code: 'REINA_SEARCH_DISABLED', error: 'Reina search is not enabled.' }),
    }),
  });
  const final = await controller.search('Maria');
  assert.equal(final.phase, 'disabled');
  assert.deepEqual(final.results, []);
  assert.equal(Search.isDisabledEnvelope(503, { ok: false, code: 'REINA_SEARCH_DISABLED' }), true);
  assert.equal(Search.isDisabledEnvelope(503, { ok: false, code: 'OTHER' }), false);
});

test('stale responses cannot overwrite the latest search', async () => {
  const resolvers = [];
  const states = [];
  const controller = Search.create({
    debounceMs: 0,
    onState: (state) => states.push(state),
    fetchImpl: (url) => new Promise((resolve) => resolvers.push({ url, resolve })),
  });
  const first = controller.search('Maria');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = controller.search('Kitchen');
  await new Promise((resolve) => setTimeout(resolve, 5));
  resolvers[1].resolve({ status: 200, json: async () => ({ ok: true, query: 'Kitchen', results: [], unavailable: [] }) });
  await second;
  resolvers[0].resolve({ status: 200, json: async () => ({ ok: true, query: 'Maria', results: [validItem], unavailable: [] }) });
  await first;
  assert.equal(states.at(-1).query, 'Kitchen');
});

test('HiveLogic page replaces static demo search and reuses the purple Reina host', async () => {
  const source = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const controller = await readFile(new URL('../public/reina-global-search.js', import.meta.url), 'utf8');
  assert.match(source, /src="\/reina-global-search\.js"/);
  assert.match(controller, /fetchImpl\('\/api\/reina-search/);
  assert.match(source, /window\.hlReinaPilot=installed/);
  assert.match(source, /host\.submitTyped\(q\)/);
  assert.match(source, /hlOpenClientWhenReady\(nav\.recordId,0\)/);
  assert.match(source, /openRealJob\(nav\.recordId\)/);
  assert.match(source, /state\.phase==='disabled'/);
  assert.match(source, /HL_SEARCH_RESULTS=HL_SEARCH_PAGES\.slice\(\)/);
  assert.doesNotMatch(source, /var IDX=\[/);
  assert.doesNotMatch(source, /NO MATCHES — IN THE REAL BUILD/);
});

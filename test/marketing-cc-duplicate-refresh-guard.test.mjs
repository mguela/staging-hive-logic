import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'public', 'index.html');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

function extractConstLine(src, declSnippet) {
  const start = src.indexOf(declSnippet);
  if (start === -1) throw new Error('const line not found: ' + declSnippet);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  const closeParenBrace = src.indexOf(') {', declStart);
  if (closeParenBrace === -1) throw new Error('opening brace not found for: ' + declSnippet);
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

const CC_LAST_RUN_AT_SRC = extractConstLine(source, 'var ccLastRunAt = {};');
const CC_RUN_IF_STALE_SRC = extractFunction(source, 'function ccRunIfStale(name, fn, minMs) {');

const blockSrc = [CC_LAST_RUN_AT_SRC, CC_RUN_IF_STALE_SRC].join('\n\n');

test('Command Center visibility resume uses the one authenticated shared tick, never bare widget loads', () => {
  // Anchor after ccPollTick because the file has unrelated visibility handlers.
  const pollIdx = source.indexOf('function ccPollTick(){');
  const vizIdx = source.indexOf("document.addEventListener('visibilitychange', function(){", pollIdx);
  assert.ok(vizIdx !== -1, 'Command Center visibilitychange handler must still exist');
  const vizEnd = source.indexOf('});', vizIdx) + 3;
  const vizBlock = source.slice(vizIdx, vizEnd);
  assert.ok(vizBlock.includes('ccPollTick()'), 'visibility resume must call the shared poll tick');
  assert.ok(vizBlock.includes('ccPollStart()'), 'visibility resume must restart the shared poll lifecycle');
  assert.ok(!/loadMapLive\(\);/.test(vizBlock), 'visibilitychange handler must not call loadMapLive() directly anymore');
});

function makeSandbox(startNow) {
  let currentNow = startNow;
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(currentNow);
      else super(...args);
    }
  }
  FakeDate.now = () => currentNow;
  const sandbox = { Date: FakeDate, console };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: 'public/index.html' });
  return {
    sandbox,
    advance(ms) { currentNow += ms; },
  };
}

test('real ccRunIfStale runs the function and returns true on the very first call for a given key', () => {
  const { sandbox } = makeSandbox(1000000);
  let calls = 0;
  const ran = sandbox.ccRunIfStale('map', () => { calls++; }, 30000);
  assert.strictEqual(ran, true);
  assert.strictEqual(calls, 1);
});

test('real ccRunIfStale skips a second call for the same key within minMs -- this is the actual duplicate-firing fix', () => {
  const { sandbox, advance } = makeSandbox(1000000);
  let calls = 0;
  sandbox.ccRunIfStale('map', () => { calls++; }, 30000);
  advance(10000); // 10s later -- e.g. an interval tick or a tab-visibility event firing soon after
  const ranAgain = sandbox.ccRunIfStale('map', () => { calls++; }, 30000);
  assert.strictEqual(ranAgain, false, 'a call within the 30s stale window must be skipped');
  assert.strictEqual(calls, 1, 'the wrapped function must not have been invoked a second time');
});

test('real ccRunIfStale runs again once minMs has actually elapsed', () => {
  const { sandbox, advance } = makeSandbox(1000000);
  let calls = 0;
  sandbox.ccRunIfStale('map', () => { calls++; }, 30000);
  advance(30000); // exactly minMs later
  const ranAgain = sandbox.ccRunIfStale('map', () => { calls++; }, 30000);
  assert.strictEqual(ranAgain, true, 'a call at/after the stale window must actually run');
  assert.strictEqual(calls, 2);
});

test('real ccRunIfStale tracks each widget key independently -- one widget refreshing does not block another', () => {
  const { sandbox } = makeSandbox(1000000);
  let mapCalls = 0, financialsCalls = 0;
  sandbox.ccRunIfStale('map', () => { mapCalls++; }, 30000);
  const financialsRan = sandbox.ccRunIfStale('financials', () => { financialsCalls++; }, 30000);
  assert.strictEqual(financialsRan, true, 'a different widget key must run even if map was just guarded');
  assert.strictEqual(financialsCalls, 1);
});

test('real scenario this bug describes: an interval tick immediately followed by a tab-visibility refresh no longer double-fetches the same widget', () => {
  const { sandbox, advance } = makeSandbox(1000000);
  let mapFetchCount = 0;
  const loadMapLive = () => { mapFetchCount++; };
  // simulate the periodic setInterval tick firing first
  sandbox.ccRunIfStale('map', loadMapLive, 30000);
  // 2 seconds later, the user alt-tabs back and visibilitychange fires
  advance(2000);
  sandbox.ccRunIfStale('map', loadMapLive, 30000);
  assert.strictEqual(mapFetchCount, 1, 'the map widget must only have been fetched once, not twice, within the stale window');
  // but a real gap (tab left for 5+ minutes) must still trigger a real refresh
  advance(300000);
  sandbox.ccRunIfStale('map', loadMapLive, 30000);
  assert.strictEqual(mapFetchCount, 2, 'a genuinely stale widget must still refresh on the next visibility event');
});

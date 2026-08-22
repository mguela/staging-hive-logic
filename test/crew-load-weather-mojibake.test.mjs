import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'public', 'index.html');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

function extractStatement(src, startSnippet, endSnippet) {
  const start = src.indexOf(startSnippet);
  if (start === -1) throw new Error('start snippet not found: ' + startSnippet);
  const endIdx = src.indexOf(endSnippet, start);
  if (endIdx === -1) throw new Error('end snippet not found: ' + endSnippet);
  return src.slice(start, endIdx + endSnippet.length);
}

const weatherStmt = extractStatement(source, "hlApiGet('weather')", '}).catch(function(){});');

test('real weather-widget source contains no corrupted box-drawing mojibake (U+252C)', () => {
  assert.ok(!weatherStmt.includes('┬'), 'found corrupted box-drawing char U+252C in weather widget snippet');
});

function runWeatherWidget(weatherResponse) {
  const elements = new Map();
  function makeEl(id) {
    const el = { id, textContent: '' };
    elements.set(id, el);
    return el;
  }
  ['cc-wx-emoji', 'cc-wx-text', 'cc-wx-impact'].forEach(makeEl);
  const sandbox = {
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
    hlApiGet: () => ({
      then(cb) {
        cb(weatherResponse);
        return { catch() {} };
      },
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(weatherStmt, sandbox, { filename: 'public/index.html' });
  return elements;
}

test('real weather widget renders degree and middle-dot characters correctly for full data', () => {
  const els = runWeatherWidget({
    ok: true,
    now: { emoji: '☀️', tempF: 72, label: 'Sunny' },
    today: { hiF: 80, loF: 60 },
    risk: { label: 'Rain', dow: 'Fri', precipPct: 40 },
  });
  assert.strictEqual(els.get('cc-wx-emoji').textContent, '☀️');
  assert.strictEqual(els.get('cc-wx-text').textContent, '72°F Sunny · hi 80° / lo 60°');
  assert.strictEqual(els.get('cc-wx-impact').textContent, '- Rain Fri (40% precip) · live forecast');
  for (const el of els.values()) {
    assert.ok(!el.textContent.includes('┬'), 'rendered textContent contains corrupted box-drawing char');
  }
});

test('real weather widget honest no-risk fallback text uses correct middle dot', () => {
  const els = runWeatherWidget({
    ok: true,
    now: { emoji: '⛅', tempF: 65, label: 'Cloudy' },
    today: { hiF: 70, loF: 55 },
    risk: null,
  });
  assert.strictEqual(els.get('cc-wx-impact').textContent, '- no weather risk next 7 days · live forecast');
});

test('real weather widget handles missing now/today gracefully (real guard clauses, no throw)', () => {
  const els = runWeatherWidget({ ok: true, now: null, today: null, risk: null });
  assert.strictEqual(els.get('cc-wx-text').textContent, '');
  assert.strictEqual(els.get('cc-wx-impact').textContent, '- no weather risk next 7 days · live forecast');
});

test('real weather widget does nothing when API response is not ok (real early-return guard)', () => {
  const els = runWeatherWidget({ ok: false });
  assert.strictEqual(els.get('cc-wx-text').textContent, '');
  assert.strictEqual(els.get('cc-wx-emoji').textContent, '');
  assert.strictEqual(els.get('cc-wx-impact').textContent, '');
});

test('real weather widget does nothing when hlApiGet resolves undefined (real guard, no throw)', () => {
  const els = runWeatherWidget(undefined);
  assert.strictEqual(els.get('cc-wx-text').textContent, '');
});

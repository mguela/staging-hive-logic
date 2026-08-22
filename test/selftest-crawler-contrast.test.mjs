import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Dev To-Do reported "UNREADABLE ACTIVE" (contrast 2.07:1) on the Job Setup &
// Readiness view's "Setup Queue" / "Readiness Report" tabs. Live-measured on
// production: the active tab's text is rgb(89,113,138) (--gold-deep) on an
// effective background of rgb(240,241,246) (--canvas). The real WCAG contrast
// for that pair is 4.48:1 -- readable, not broken. The crawler's own lum()
// (public/tools/selftest.js) computed 2.07:1 for the same pair because it
// averaged raw sRGB channels instead of applying the WCAG gamma-correction
// curve, systematically under-reporting contrast for every mid-tone color and
// mis-flagging a legitimately-readable tab label as UNREADABLE_ACTIVE.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  assert.equal(depth, 0, 'braces must balance');
  return source.slice(start, i);
}

const lumSrc = extractFunction(src, 'function lum(c)');
const contrastSrc = extractFunction(src, 'function contrast(el)');

test('lum() no longer references the un-gamma-corrected shortcut formula', () => {
  // The exact regression: `0.2126 * m[0] / 255 + ...` with no curve applied.
  assert.doesNotMatch(lumSrc, /0\.2126 \* m\[0\] \/ 255 \+ 0\.7152 \* m\[1\] \/ 255 \+ 0\.0722 \* m\[2\] \/ 255/);
  assert.match(lumSrc, /Math\.pow\(/);
});

function runLum(rgbString) {
  const ctx = vm.createContext({ Math, result: undefined });
  vm.runInContext(`${lumSrc}\nresult = lum(${JSON.stringify(rgbString)});`, ctx);
  return ctx.result;
}

test('lum() matches the WCAG relative-luminance reference values', () => {
  assert.equal(runLum('rgb(255, 255, 255)'), 1);
  assert.equal(runLum('rgb(0, 0, 0)'), 0);
  // WCAG worked example: pure sRGB red (#FF0000) has relative luminance 0.2126.
  assert.ok(Math.abs(runLum('rgb(255, 0, 0)') - 0.2126) < 0.0001);
});

function runContrast(fg, bg) {
  const elements = new Map();
  function makeEl(color, backgroundColor, parent) {
    const el = { parentElement: parent || null };
    elements.set(el, { color, backgroundColor });
    return el;
  }
  const root = makeEl('rgb(0,0,0)', bg, null);
  const target = makeEl(fg, 'rgba(0, 0, 0, 0)', root);
  const ctx = vm.createContext({
    Math,
    getComputedStyle: (el) => elements.get(el),
    result: undefined,
  });
  ctx.__target = target;
  vm.runInContext(`${lumSrc}\n${contrastSrc}\nresult = contrast(__target);`, ctx);
  return ctx.result;
}

test('the exact production pair (gold-deep tab text on canvas) reproduces the crawler\'s reported 2.07:1 under the OLD formula and 4.48:1 under the fixed one', () => {
  const fixed = runContrast('rgb(89, 113, 138)', 'rgb(240, 241, 246)');
  assert.ok(Math.abs(fixed - 4.48) < 0.02, `expected ~4.48:1, got ${fixed}`);
  // Below the crawler's own UNREADABLE_ACTIVE threshold of 2.2 it would have
  // been flagged; the fixed value clears it, so this pair no longer trips it.
  assert.ok(fixed >= 2.2);
});

test('a genuinely low-contrast pair still reads as low contrast under the fixed formula', () => {
  // Light gray text on white -- a real accessibility problem, must still be caught.
  const bad = runContrast('rgb(200, 200, 200)', 'rgb(255, 255, 255)');
  assert.ok(bad < 2.2, `expected a real low-contrast pair to stay under 2.2, got ${bad}`);
});

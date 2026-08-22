import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../scripts/scope-css.mjs';

const source = readFileSync('public/hiveconnect/styles.css', 'utf8');
const committed = readFileSync('public/hiveconnect/styles-scoped.css', 'utf8');

// styles-scoped.css is what the HiveLogic host actually loads for the embedded
// HiveConnect app; styles.css is what the standalone /hiveconnect/ page loads.
// The scoped file has carried an "AUTO-GENERATED ... by scope-css.mjs" header
// since it was introduced, but that script was never committed, so for months
// the two were hand-synced -- and drifted: the embed picked up a huddle
// control-bar fix the source never got, the source kept CSS for a control that
// no longer exists, and three hand-scoped rules were left matching the whole
// document. This test is the thing that was missing.
test('styles-scoped.css is exactly what scope-css.mjs generates from styles.css', () => {
  assert.equal(committed, generate(source),
    'run: node scripts/scope-css.mjs');
});

test('every selector in the embedded stylesheet is confined to HiveConnect', () => {
  // The app is embedded in the host page's light DOM -- no iframe, no shadow
  // root -- so an unscoped selector here styles HiveLogic itself. Three of
  // these shipped (2026-07-26 and 2026-07-31) from hand-scoping a selector
  // list and only prefixing the first selector in it.
  const withoutComments = committed.replace(/\/\*[\s\S]*?\*\//g, '');
  const escapes = [];
  let depth = 0;
  let buffer = '';
  let atRule = '';
  for (const char of withoutComments) {
    if (char === '{') {
      const prelude = buffer.trim();
      buffer = '';
      depth += 1;
      if (prelude.startsWith('@')) { atRule = prelude; continue; }
      // Keyframe stops are not selectors.
      if (atRule.startsWith('@keyframes') && depth > 1) continue;
      for (const selector of splitList(prelude)) {
        const one = selector.trim();
        if (!one) continue;
        if (!one.includes('#hiveconnect-root') && !one.includes('.hc-embed')) escapes.push(one);
      }
      continue;
    }
    if (char === '}') { depth -= 1; if (depth === 0) atRule = ''; buffer = ''; continue; }
    buffer += char;
  }
  assert.deepEqual(escapes, [], 'these selectors match outside #hiveconnect-root');
});

test('root-level sizing never reaches .hc-embed, only #hiveconnect-root', () => {
  // .hc-embed is also stamped onto small overlays appended to document.body --
  // toasts, dropdown menus, modals, incoming-call cards (HC_BODY_ROOTS in
  // hiveconnect-mount.js). Scoping `html, body { height: 100% }` onto it
  // force-stretched every one of them to fill the viewport. styles.css carries
  // a warning comment at that rule; this is the executable version of it.
  const rules = generate('html, body { height: 100%; }\nbody { overflow: hidden; }')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!rules.includes('.hc-embed'),
    'html/body rules must scope to #hiveconnect-root alone');
  assert.ok(rules.includes('#hiveconnect-root'));
});

test('the host theme attribute stays outside the scope', () => {
  // data-theme lives on the host's documentElement, which is by definition not
  // inside #hiveconnect-root. Scoping the whole selector would never match.
  const generated = generate('html[data-theme="dark"] .msg { color: red; }');
  assert.ok(generated.startsWith('/*'));
  assert.ok(generated.includes('html[data-theme="dark"] :is(#hiveconnect-root, .hc-embed) .msg'));
});

test('keyframe stops are left alone', () => {
  const generated = generate('@keyframes fade { from { opacity: 0; } to { opacity: 1; } }');
  assert.ok(generated.includes('from { opacity: 0; }'), 'from/to are not selectors');
  assert.ok(!generated.includes('hiveconnect-root) from'));
});

test('rules inside @media are scoped like any other', () => {
  const generated = generate('@media (max-width: 900px) { .thread-panel { position: fixed; } }');
  assert.ok(generated.includes(':is(#hiveconnect-root, .hc-embed) .thread-panel'));
});

test('the same stylesheet generates the same document on a CRLF checkout', () => {
  // core.autocrlf gives Windows working copies CRLF css and Linux CI LF css.
  // transform() passes source bytes through, so a CRLF source stayed CRLF --
  // but HEADER and the `,\n` selector-list joiner were synthesized with LF.
  // The result was a MIXED-ending string that could never equal the uniformly
  // CRLF file on disk, so the equality test above failed on every Windows
  // checkout while passing in CI. Nothing was ever wrong with the CSS -- the
  // comparison was ending-fragile, which made a green artifact look like drift.
  const lf = 'html, body { height: 100%; }\n.msg, .msg-body { color: red; }\n';
  const crlf = lf.replace(/\n/g, '\r\n');

  const fromLf = generate(lf);
  const fromCrlf = generate(crlf);

  assert.ok(!fromLf.includes('\r'), 'an LF source must produce LF output — this is what CI compares');
  assert.ok(!/(?<!\r)\n/.test(fromCrlf), 'a CRLF source must produce uniformly CRLF output, not a mix');
  assert.equal(fromCrlf.replace(/\r\n/g, '\n'), fromLf, 'the two must be the same document');
});

function splitList(prelude) {
  const parts = [];
  let depth = 0;
  let buffer = '';
  for (const char of prelude) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(buffer); buffer = ''; continue; }
    buffer += char;
  }
  parts.push(buffer);
  return parts;
}

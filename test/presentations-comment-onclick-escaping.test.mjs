import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Dev To-Do / self-test reported "💬" as NO_OUTCOME in prx (Presentations).
// Live-confirmed via the Claude Browser tools: clicking it does nothing at
// all -- no toast, no DOM change -- because its onclick attribute contains a
// JS syntax error. The apostrophes in "'does this stain?'" were escaped as
// \\' (a literal backslash followed by an unescaped quote, which closes the
// string early) instead of \' (a properly escaped quote). `new Function()`
// on the extracted attribute value throws "missing ) after argument list"
// with the bug and parses cleanly once fixed.
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the "Ask anything" comment button\'s onclick no longer over-escapes its apostrophes', () => {
  assert.doesNotMatch(page, /Ask anything.{0,20}\\\\'does this stain/,
    'a literal backslash followed by an unescaped quote ends the string early -- a real JS syntax error');
});

test('the fixed onclick attribute actually parses as valid JavaScript', () => {
  const marker = 'onclick=&quot;hlToast(';
  const start = page.lastIndexOf(marker, page.indexOf('does this stain'));
  const end = page.indexOf('&quot;>', start);
  const raw = page.slice(start + marker.length - 'hlToast('.length, end);
  const decoded = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.doesNotThrow(() => new Function(decoded), 'the onclick attribute must be syntactically valid JavaScript');
  // A single backslash correctly escapes each apostrophe within the
  // single-quoted JS string -- not the double backslash that broke it.
  assert.match(decoded, /\\'does this stain\?\\'/, 'the escaped apostrophes must still be present around the quoted question');
});
